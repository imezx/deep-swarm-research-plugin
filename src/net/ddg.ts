/**
 * @file net/ddg.ts
 * DuckDuckGo search scraper with:
 * - Adaptive throttle: shared error counter across all lanes — when DDG
 *   starts failing, ALL lanes back off exponentially and add jitter
 * - Global cooldown: after N consecutive failures, pause everything
 * - Per-lane rate limiting with staggered offsets
 * - Pagination support
 * - Query length enforcement (DDG chokes on 100+ char queries)
 */

import { DDG_RATE_LIMIT_MS } from "../constants";
import { SearchHit } from "../types";
import { buildDDGHeaders, sleep } from "./http";

/** Max query length sent to DDG — longer queries get trimmed. */
const MAX_QUERY_LENGTH = 80;

/** Trim a query to fit DDG's sweet spot without cutting mid-word. */
function trimQuery(query: string): string {
  if (query.length <= MAX_QUERY_LENGTH) return query;
  const cut = query.slice(0, MAX_QUERY_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
}

class AdaptiveThrottle {
  private consecutiveErrors = 0;
  private cooldownUntil = 0;

  /** Call after a successful DDG response. */
  reportSuccess(): void {
    this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
  }

  /** Call after a failed DDG request. Returns extra delay (ms) to add. */
  reportError(): number {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= 5) {
      const cooldownMs = Math.min(30_000, this.consecutiveErrors * 3_000);
      this.cooldownUntil = Date.now() + cooldownMs;
      return cooldownMs;
    }
    return Math.min(15_000, 1000 * Math.pow(2, this.consecutiveErrors - 1));
  }

  /** Extra delay all lanes should wait right now (0 if no pressure). */
  currentPenalty(): number {
    const cooldownRemaining = this.cooldownUntil - Date.now();
    if (cooldownRemaining > 0) return cooldownRemaining;

    if (this.consecutiveErrors >= 2) {
      return Math.min(8_000, this.consecutiveErrors * 800);
    }

    return 0;
  }

  get errorCount(): number {
    return this.consecutiveErrors;
  }
}

/** Singleton — shared across all lanes and workers in a run. */
const globalThrottle = new AdaptiveThrottle();

export class DdgRateLimiter {
  private readonly baseDelayMs: number;
  private lastRequestAt: number = 0;
  private queue: Array<() => void> = [];
  private processing = false;
  private readonly jitterMs: number;

  constructor(baseDelayMs: number = DDG_RATE_LIMIT_MS) {
    this.baseDelayMs = baseDelayMs;
    this.jitterMs = Math.floor(Math.random() * 600);
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
      const penalty = globalThrottle.currentPenalty();
      const effectiveDelay = this.baseDelayMs + this.jitterMs + penalty;

      const now = Date.now();
      const wait = Math.max(0, effectiveDelay - (now - this.lastRequestAt));
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
 * Pool of N independent rate limiters with staggered start offsets.
 * Each lane has its own jitter, and all lanes respect the global
 * adaptive throttle.
 */
export class DdgLimiterPool {
  private readonly limiters: DdgRateLimiter[];
  private nextIdx = 0;

  constructor(laneCount: number, msPerLane: number) {
    this.limiters = [];
    for (let i = 0; i < laneCount; i++) {
      const stagger = Math.floor(msPerLane * 0.2 * i);
      this.limiters.push(new DdgRateLimiter(msPerLane + stagger));
    }
  }

  next(): DdgRateLimiter {
    const limiter = this.limiters[this.nextIdx % this.limiters.length];
    this.nextIdx++;
    return limiter;
  }

  get laneCount(): number {
    return this.limiters.length;
  }
}

/** Reset adaptive throttle — call at the start of a new research session. */
export function resetThrottle(): void {
  (globalThrottle as any).consecutiveErrors = 0;
  (globalThrottle as any).cooldownUntil = 0;
}

export async function searchDDG(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  limiter: DdgRateLimiter = sharedDdgLimiter,
  page: number = 1,
): Promise<ReadonlyArray<SearchHit>> {
  const trimmed = trimQuery(query);
  await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const offset = (page - 1) * maxResults;

  try {
    const hits = await tryLiteEndpoint(
      trimmed,
      maxResults,
      safeSearch,
      signal,
      offset,
    );
    if (hits.length > 0) {
      globalThrottle.reportSuccess();
      return hits;
    }
  } catch { }

  if (page <= 1) {
    try {
      const hits = await tryHtmlEndpoint(
        trimmed,
        maxResults,
        safeSearch,
        signal,
      );
      if (hits.length > 0) {
        globalThrottle.reportSuccess();
        return hits;
      }
    } catch { }
  }

  const penalty = globalThrottle.reportError();
  if (penalty > 0 && !signal.aborted) {
    await sleep(Math.min(penalty, 5_000));
  }

  return [];
}

/**
 * Fetch multiple pages of results for a single query.
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
    if (p > 1 && globalThrottle.errorCount >= 3) break;

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

  if (!res.ok) throw new Error(`DDG lite HTTP ${res.status}`);
  const html = await res.text();
  return parseLiteResults(html, maxResults);
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

  if (!res.ok) throw new Error(`DDG html HTTP ${res.status}`);
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
    hits.push({ url, title, snippet: snippets[i] ?? title });
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
