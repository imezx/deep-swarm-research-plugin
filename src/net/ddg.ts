/**
 * @file net/ddg.ts
 * DuckDuckGo search scraper with:
 * - Multi-lane rate limiters for true parallel searching
 * - Pagination support (fetch page 2, 3, etc.) for larger result pools
 * - Falls back to lite → html → legacy parsing chain
 */

import { DDG_RATE_LIMIT_MS } from "../constants";
import { SearchHit } from "../types";
import { buildDDGHeaders, sleep } from "./http";

export class DdgRateLimiter {
  private readonly minDelayMs: number;
  private lastRequestAt: number = 0;
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(minDelayMs: number = DDG_RATE_LIMIT_MS) {
    this.minDelayMs = minDelayMs;
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      const wait = Math.max(0, this.minDelayMs - (now - this.lastRequestAt));
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      const resolve = this.queue.shift();
      resolve?.();
    }
    this.processing = false;
  }
}

/** Default shared limiter (single lane). */
export const sharedDdgLimiter = new DdgRateLimiter();

/**
 * Creates a pool of N independent rate limiters.
 * Workers round-robin across lanes, so up to N DDG requests
 * can run truly in parallel instead of being serialized.
 */
export class DdgLimiterPool {
  private readonly limiters: DdgRateLimiter[];
  private nextIdx = 0;

  constructor(laneCount: number, msPerLane: number) {
    this.limiters = [];
    for (let i = 0; i < laneCount; i++) {
      this.limiters.push(new DdgRateLimiter(msPerLane));
    }
  }

  /** Get the next limiter in the round-robin. */
  next(): DdgRateLimiter {
    const limiter = this.limiters[this.nextIdx % this.limiters.length];
    this.nextIdx++;
    return limiter;
  }

  get laneCount(): number {
    return this.limiters.length;
  }
}

/**
 * Searches DuckDuckGo via its lite HTML endpoint and returns structured results.
 * Now supports pagination: set `page` to 2, 3, etc. for subsequent result pages.
 */
export async function searchDDG(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  limiter: DdgRateLimiter = sharedDdgLimiter,
  page: number = 1,
): Promise<ReadonlyArray<SearchHit>> {
  await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const offset = (page - 1) * maxResults;
  const hits = await tryLiteEndpoint(
    query,
    maxResults,
    safeSearch,
    signal,
    offset,
  );
  if (hits.length > 0) return hits;

  if (page <= 1) {
    return tryHtmlEndpoint(query, maxResults, safeSearch, signal);
  }

  return [];
}

/**
 * Fetch multiple pages of results for a single query.
 * Returns a combined, deduplicated result set.
 */
export async function searchDDGPaginated(
  query: string,
  maxResultsPerPage: number,
  pages: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  limiter: DdgRateLimiter = sharedDdgLimiter,
): Promise<ReadonlyArray<SearchHit>> {
  const allHits: SearchHit[] = [];
  const seen = new Set<string>();

  for (let p = 1; p <= pages; p++) {
    if (signal.aborted) break;

    const hits = await searchDDG(
      query,
      maxResultsPerPage,
      safeSearch,
      signal,
      limiter,
      p,
    );
    for (const h of hits) {
      if (!seen.has(h.url)) {
        seen.add(h.url);
        allHits.push(h);
      }
    }

    if (hits.length < maxResultsPerPage * 0.5) break;
  }

  return allHits;
}

async function tryLiteEndpoint(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  offset: number = 0,
): Promise<ReadonlyArray<SearchHit>> {
  try {
    const url = new URL("https://lite.duckduckgo.com/lite/");
    url.searchParams.set("q", query);
    if (safeSearch === "strict") url.searchParams.set("p", "-1");
    if (safeSearch === "off") url.searchParams.set("p", "1");

    let body = `q=${encodeURIComponent(query)}`;
    if (offset > 0) {
      body += `&s=${offset}&dc=${Math.floor(offset / maxResults) + 1}`;
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      signal,
      headers: {
        ...buildDDGHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) return [];
    const html = await res.text();
    return parseLiteResults(html, maxResults);
  } catch {
    return [];
  }
}

async function tryHtmlEndpoint(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  if (safeSearch === "strict") url.searchParams.set("p", "-1");
  if (safeSearch === "off") url.searchParams.set("p", "1");

  const res = await fetch(url.toString(), {
    method: "GET",
    signal,
    headers: buildDDGHeaders(),
  });

  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  return parseHtmlResults(html, maxResults);
}

function parseLiteResults(
  html: string,
  maxResults: number,
): ReadonlyArray<SearchHit> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const linkRe =
    /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(html)) !== null) {
    const rawUrl = decodeURIComponent(m[1]).trim();
    const title = stripTags(m[2]).trim();
    if (rawUrl.startsWith("http") && !DDG_INTERNAL.test(rawUrl)) {
      links.push({ url: rawUrl, title });
    }
  }

  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).replace(/\s+/g, " ").trim());
  }

  for (let i = 0; i < links.length && hits.length < maxResults; i++) {
    const { url, title } = links[i];
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({
      url,
      title,
      snippet: snippets[i] ?? title,
    });
  }

  return hits;
}

function parseHtmlResults(
  html: string,
  maxResults: number,
): ReadonlyArray<SearchHit> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const resultBlockRe =
    /<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bresult\b|$)/gi;
  const linkRe = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe =
    /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span|td|div)>/i;

  let blockMatch: RegExpExecArray | null;

  while (
    hits.length < maxResults &&
    (blockMatch = resultBlockRe.exec(html)) !== null
  ) {
    const block = blockMatch[1];

    const linkMatch = linkRe.exec(block);
    if (!linkMatch) continue;

    let rawUrl = linkMatch[1];
    const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);
    else rawUrl = decodeURIComponent(rawUrl);

    if (!rawUrl.startsWith("http")) continue;
    if (DDG_INTERNAL.test(rawUrl)) continue;
    if (seen.has(rawUrl)) continue;

    seen.add(rawUrl);

    const title = stripTags(linkMatch[2]).replace(/\s+/g, " ").trim();

    const snippetMatch = snippetRe.exec(block);
    const snippet = snippetMatch
      ? stripTags(snippetMatch[1]).replace(/\s+/g, " ").trim()
      : title;

    hits.push({ url: rawUrl, title, snippet });
  }

  if (hits.length === 0) {
    return parseLegacy(html, maxResults);
  }

  return hits;
}

function parseLegacy(
  html: string,
  maxResults: number,
): ReadonlyArray<SearchHit> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /\shref="[^"]*(https?[^?&"]+)[^>]*>([^<]*)/gm;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;

  while (hits.length < maxResults && (m = re.exec(html)) !== null) {
    const rawUrl = decodeURIComponent(m[1]);
    const title = m[2].replace(/\s+/g, " ").trim();
    if (DDG_INTERNAL.test(rawUrl)) continue;
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);
    hits.push({ url: rawUrl, title, snippet: title });
  }

  return hits;
}

const DDG_INTERNAL = /duckduckgo\.com|bing\.com/;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}
