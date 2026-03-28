/**
 * @file net/http.ts
 * Low-level HTTP utilities: fetch with retry logic, per-request timeout,
 * and a TLS-error fallback using Node's http/https modules directly.
 */

import * as https from "node:https";
import * as http from "node:http";
import { setServers } from "node:dns";
import {
  DNS_RESOLVERS,
  FETCH_MAX_RETRIES,
  FETCH_RETRY_DELAY_MS,
  FETCH_TIMEOUT_MS,
  CACHE_FALLBACK_TIMEOUT_MS,
} from "../constants";

setServers(DNS_RESOLVERS);

const UA_POOL: ReadonlyArray<string> = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
];

function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

export function buildBrowserHeaders(url: string): Record<string, string> {
  const host = safeHostname(url);
  const ua = randomUA();
  return {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: host
      ? `https://www.google.com/search?q=${encodeURIComponent(host)}`
      : "https://www.google.com/",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Sec-CH-UA":
      '"Chromium";v="134", "Google Chrome";v="134", "Not:A-Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Cache-Control": "max-age=0",
    Priority: "u=0, i",
  };
}

export function buildDDGHeaders(): Record<string, string> {
  return { "User-Agent": randomUA() };
}

export function fetchInsecure(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  redirectsLeft: number = 5,
): Promise<string> {
  return fetchInsecureRaw(url, headers, signal, redirectsLeft).then((r) =>
    r.data.toString("utf-8"),
  );
}

export interface InsecureRawResult {
  readonly data: Buffer;
  readonly contentType: string;
}

export function fetchInsecureRaw(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  redirectsLeft: number = 5,
): Promise<InsecureRawResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { ...headers, "Accept-Encoding": "identity" },
        rejectUnauthorized: false,
      },
      (res) => {
        const sc = res.statusCode ?? 0;

        if ([301, 302, 307, 308].includes(sc)) {
          const location = res.headers["location"];
          if (!location)
            return reject(new Error(`Redirect with no Location from ${url}`));
          if (redirectsLeft <= 0)
            return reject(new Error(`Too many redirects from ${url}`));
          res.resume();
          fetchInsecureRaw(
            new URL(location, url).href,
            headers,
            signal,
            redirectsLeft - 1,
          ).then(resolve, reject);
          return;
        }

        if (sc < 200 || sc >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${sc} from ${url}`));
        }

        const contentType = (res.headers["content-type"] as string) || "";
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ data: Buffer.concat(chunks), contentType }),
        );
        res.on("error", reject);
      },
    );

    signal.addEventListener(
      "abort",
      () => {
        req.destroy();
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface FetchResult {
  readonly html: string;
  readonly finalUrl: string;
  /** The Content-Type header from the response, if available. */
  readonly contentType?: string;
  /** Raw response body as a Buffer (present for binary content like PDFs). */
  readonly rawBuffer?: Buffer;
}

export async function fetchPage(
  url: string,
  signal: AbortSignal,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<FetchResult> {
  try {
    return await fetchDirect(url, signal, timeoutMs);
  } catch (err: unknown) {
    const message = errorMessage(err);
    if (!/bot blocked/i.test(message)) throw err;
  }

  return fetchFromCache(url, signal);
}

async function fetchDirect(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<FetchResult> {
  const headers = buildBrowserHeaders(url);
  let lastError: unknown;

  for (let attempt = 1; attempt <= FETCH_MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const timer = new AbortController();
    const timerId = setTimeout(() => timer.abort(), timeoutMs);

    const combined: AbortSignal =
      typeof (AbortSignal as { any?: (sigs: AbortSignal[]) => AbortSignal })
        .any === "function"
        ? (AbortSignal as { any: (sigs: AbortSignal[]) => AbortSignal }).any([
          signal,
          timer.signal,
        ])
        : timer.signal;

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: combined,
        headers,
        redirect: "follow",
      });
      clearTimeout(timerId);
      if (!res.ok) {
        const code = res.status;
        if (code === 403 || code === 429 || code === 451) {
          throw new Error(`HTTP ${code} ${res.statusText} (bot blocked)`);
        }
        throw new Error(`HTTP ${code} ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") || "";
      const finalUrl = res.url || url;

      if (isBinaryContentType(contentType)) {
        const arrayBuf = await res.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuf);
        return {
          html: "",
          finalUrl,
          contentType,
          rawBuffer,
        };
      }

      return { html: await res.text(), finalUrl, contentType };
    } catch (err: unknown) {
      clearTimeout(timerId);
      const message = errorMessage(err);

      if (/bot blocked/i.test(message)) throw err;

      const isTls = /altnames|certificate|CERT_|SSL|TLS|self[._-]signed/i.test(
        message,
      );

      if (isTls) {
        try {
          const raw = await fetchInsecureRaw(url, headers, signal);
          if (isBinaryContentType(raw.contentType)) {
            return {
              html: "",
              finalUrl: url,
              contentType: raw.contentType,
              rawBuffer: raw.data,
            };
          }
          return {
            html: raw.data.toString("utf-8"),
            finalUrl: url,
            contentType: raw.contentType,
          };
        } catch (tlsErr) {
          lastError = tlsErr;
          break;
        }
      }

      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      lastError = err;
      if (attempt < FETCH_MAX_RETRIES) await sleep(FETCH_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Failed to fetch ${url}: ${errorMessage(lastError)}`);
}

/**
 * Checks if a Content-Type indicates binary content that should not
 * be decoded as UTF-8 text.
 */
function isBinaryContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return (
    lower.includes("application/pdf") ||
    lower.includes("application/x-pdf") ||
    lower.includes("application/octet-stream")
  );
}

async function fetchFromCache(
  originalUrl: string,
  signal: AbortSignal,
): Promise<FetchResult> {
  const encoded = encodeURIComponent(originalUrl);
  const headers = buildBrowserHeaders(originalUrl);
  const timeout = CACHE_FALLBACK_TIMEOUT_MS;

  const cacheUrls = [
    `https://webcache.googleusercontent.com/search?q=cache:${encoded}&strip=1`,
    `https://web.archive.org/web/2024/${originalUrl}`,
  ];

  for (const cacheUrl of cacheUrls) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const timer = new AbortController();
    const timerId = setTimeout(() => timer.abort(), timeout);

    try {
      const combined: AbortSignal =
        typeof (AbortSignal as { any?: (sigs: AbortSignal[]) => AbortSignal })
          .any === "function"
          ? (AbortSignal as { any: (sigs: AbortSignal[]) => AbortSignal }).any([
            signal,
            timer.signal,
          ])
          : timer.signal;

      const res = await fetch(cacheUrl, {
        method: "GET",
        signal: combined,
        headers,
        redirect: "follow",
      });
      clearTimeout(timerId);

      if (res.ok) {
        const html = await res.text();
        if (html.length > 500) {
          return { html, finalUrl: originalUrl };
        }
      }
    } catch {
      clearTimeout(timerId);
    }
  }

  throw new Error(
    `Failed to fetch ${originalUrl}: bot blocked, cache unavailable`,
  );
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "unknown error");
}
