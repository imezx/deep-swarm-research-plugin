/**
 * @file engines/ddg.ts
 * DuckDuckGo lite scrape — the general-scope FALLBACK tier.
 * Adaptive throttle retained from v1 (it was sound); parser hardened.
 */
import { searchScrapeHeaders } from "../core/errors";
import type { SearchEngine } from "./types";
import type { SearchHit } from "../core/types";
import { sleep } from "../core/util";

const MAX_QUERY_LENGTH = 80;

function trimQuery(query: string): string {
  if (query.length <= MAX_QUERY_LENGTH) return query;
  const cut = query.slice(0, MAX_QUERY_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
}

class AdaptiveThrottle {
  private consecutiveErrors = 0;
  private cooldownUntil = 0;

  reportSuccess(): void {
    this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
  }

  reportError(): number {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= 5) {
      const cooldown = Math.min(30_000, this.consecutiveErrors * 3_000);
      this.cooldownUntil = Date.now() + cooldown;
      return cooldown;
    }
    return Math.min(15_000, 1000 * 2 ** (this.consecutiveErrors - 1));
  }

  currentPenalty(): number {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) return remaining;
    if (this.consecutiveErrors >= 2) return Math.min(8_000, this.consecutiveErrors * 800);
    return 0;
  }
}

const throttle = new AdaptiveThrottle();
let lastRequestAt = 0;
const BASE_DELAY_MS = 1_800;

/** Resets per research run — prevents cross-run penalty carryover. */
export function resetDdgThrottle(): void {
  // Private-field reset via controlled surface:
  throttle.reportSuccess();
  while (throttle.currentPenalty() > 0) {
    throttle.reportSuccess();
    if (throttle.currentPenalty() === 0) break;
  }
  lastRequestAt = 0;
}

async function acquireSlot(signal: AbortSignal): Promise<void> {
  const wait = Math.max(0, BASE_DELAY_MS - (Date.now() - lastRequestAt));
  if (wait > 0 && !signal.aborted) await sleep(wait);
  lastRequestAt = Date.now();
}

const DDG_INTERNAL = /duckduckgo\.com|bing\.com/;

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseLiteResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const linkRe =
    /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    let rawUrl = decodeURIComponent(m[1]).trim();
    // lite endpoint wraps URLs in /l/?uddg= redirects
    const uddg = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddg) rawUrl = decodeURIComponent(uddg[1]);
    const title = stripTags(m[2]);
    if (rawUrl.startsWith("http") && !DDG_INTERNAL.test(rawUrl)) {
      links.push({ url: rawUrl, title });
    }
  }
  while ((m = snippetRe.exec(html)) !== null) snippets.push(stripTags(m[1]));

  for (let i = 0; i < links.length && hits.length < maxResults; i++) {
    const { url, title } = links[i];
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({
      engine: "ddg",
      url,
      title,
      snippet: snippets[i] ?? title,
      published: null,
    });
  }
  return hits;
}

async function postLite(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    signal,
    headers: {
      ...searchScrapeHeaders("https://lite.duckduckgo.com/"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `q=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`ddg-lite HTTP ${res.status}`);
  return parseLiteResults(await res.text(), maxResults);
}

export const ddgEngine: SearchEngine = {
  id: "ddg",
  scopes: ["general"],

  async search(query, limit, signal): Promise<SearchHit[]> {
    await acquireSlot(signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    try {
      const hits = await postLite(trimQuery(query), limit, signal);
      if (hits.length > 0) throttle.reportSuccess();
      else throttle.reportError(); // empty usually means soft-block
      return hits;
    } catch (err) {
      if (signal.aborted) throw err;
      const penalty = throttle.reportError();
      if (penalty > 5000 && !signal.aborted) await sleep(Math.min(penalty, 5_000));
      throw err;
    }
  },
};
