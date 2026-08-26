/**
 * @file core/errors.ts
 * Typed error taxonomy — callers branch on kind, never on message parsing.
 */

export type FetchFailureKind =
  | "dns"
  | "timeout"
  | "bot-blocked"
  | "private-address"
  | "bad-status"
  | "tls"
  | "aborted"
  | "network";

export class FetchError extends Error {
  readonly kind: FetchFailureKind;
  readonly url: string;
  readonly status?: number;

  constructor(kind: FetchFailureKind, url: string, detail: string, status?: number) {
    super(`${kind}: ${detail} (${url})`);
    this.name = "FetchError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

/** A search engine responded with an explicit rate limit (HTTP 429). */
export class RateLimitedError extends Error {
  readonly engine: string;
  readonly retryAfterSeconds: number;

  constructor(engine: string, retryAfterSeconds: number) {
    super(`${engine} rate limited — waiting ~${retryAfterSeconds}s before next attempt`);
    this.name = "RateLimitedError";
    this.engine = engine;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Standard header set — honest UA identifies as a research tool reader. */
export function readerHeaders(accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"): Record<string, string> {
  return {
    "User-Agent": "DeepResearchPlugin/2.0 (+local research tool; respects robots intent)",
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
  };
}

/**
 * Headers for engines that require browser-like requests to respond at all
 * (search frontends). Kept in ONE place so the practice is visible & auditable,
 * rather than scattered spoofing.
 */
export function searchScrapeHeaders(refererUrl: string): Record<string, string> {
  const host = (() => {
    try { return new URL(refererUrl).hostname; } catch { return ""; }
  })();
  return {
    ...readerHeaders(),
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    Referer: host ? `https://${host}/` : "",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
  };
}
