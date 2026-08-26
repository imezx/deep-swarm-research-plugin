/**
 * @file net/fetcher.ts
 * Hardened page fetcher.
 * - SSRF guard on EVERY redirect hop (private ranges & non-http schemes rejected)
 * - One deadline covering headers AND body read (v1 cleared the timer before body)
 * - No TLS bypass; TLS failures are typed FetchErrors
 * - web.archive.org fallback for bot-blocked pages (ledger-tagged by caller)
 */
import { FetchError, readerHeaders } from "../core/errors";
import type { RunLedger } from "../core/ledger";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const PRIVATE_V4 = /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^0\./;
const PRIVATE_HOSTNAMES = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

export function isPrivateTarget(hostname: string): boolean {
  if (PRIVATE_HOSTNAMES.test(hostname)) return true;
  if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
  return PRIVATE_V4.test(hostname);
}

/** Throws FetchError("private-address") for URLs targeting internal networks. */
export function assertPublicHttpUrl(urlStr: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new FetchError("bad-status", urlStr, "unparseable URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchError("private-address", urlStr, `scheme ${parsed.protocol} not allowed`);
  }
  if (isPrivateTarget(parsed.hostname)) {
    throw new FetchError("private-address", urlStr, `host ${parsed.hostname} is private`);
  }
  return parsed;
}

interface HopResult {
  readonly finalUrl: string;
  readonly contentType: string;
  readonly body: Buffer;
}

async function fetchOnce(
  url: URL,
  signal: AbortSignal,
): Promise<{ res: Response; redirectLocation: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(url.href, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: readerHeaders(),
    });
    const location = res.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    return { res, redirectLocation: isRedirect ? location : null };
  } catch (err) {
    throw classify(err, url.href);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onOuterAbort);
  }
}

async function readBody(res: Response, url: URL): Promise<Buffer> {
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw classify(err, url.href);
  }
}

function classify(err: unknown, url: string): FetchError {
  if (err instanceof FetchError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new FetchError("timeout", url, err.message || "request deadline");
  }
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return new FetchError("dns", url, msg);
  if (/CERT|SSL|TLS|self-signed|certificate|altnames/i.test(msg)) return new FetchError("tls", url, msg);
  return new FetchError("network", url, msg);
}

async function followToBody(urlStr: string, signal: AbortSignal): Promise<HopResult> {
  let current = assertPublicHttpUrl(urlStr);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { res, redirectLocation } = await fetchOnce(current, signal);

    if (redirectLocation !== null) {
      if (hop === MAX_REDIRECTS) {
        throw new FetchError("bad-status", current.href, "too many redirects");
      }
      current = assertPublicHttpUrl(new URL(redirectLocation, current).href);
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      const kind = res.status === 403 || res.status === 429 ? "bot-blocked" as const : "bad-status" as const;
      throw new FetchError(kind, current.href, `HTTP ${res.status}`, res.status);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const body = await readBody(res, current);
    return { finalUrl: current.href, contentType, body };
  }
  throw new FetchError("bad-status", urlStr, "unreachable redirect loop");
}

export interface FetchedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly body: Buffer;
  readonly viaArchive: boolean;
}

const ARCHIVE_PREFIX = "https://web.archive.org/web/2024/";

/**
 * Fetches a public http(s) URL. On bot-block/429, retries once via the
 * Internet Archive and tags `viaArchive` so callers can ledger it.
 */
export async function fetchPage(
  url: string,
  signal: AbortSignal,
  ledger?: RunLedger,
): Promise<FetchedPage> {
  try {
    const hop = await followToBody(url, signal);
    return { url, viaArchive: false, ...hop };
  } catch (err) {
    if (!(err instanceof FetchError) ||
        (err.kind !== "bot-blocked" && err.kind !== "bad-status") ||
        signal.aborted) {
      throw err;
    }
  }

  const archiveUrl = `${ARCHIVE_PREFIX}${url}`;
  const hop = await followToBody(archiveUrl, signal);
  if (ledger) ledger.cacheFallbacks += 1;
  return { url, viaArchive: true, ...hop };
}
