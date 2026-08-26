/**
 * @file core/util.ts
 * The ONE place for cross-cutting helpers. No duplicates elsewhere.
 */

export const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "is", "are", "was", "were", "in", "on", "of", "and", "or",
  "for", "to", "how", "what", "why", "when", "does", "do", "with", "from",
  "that", "this", "these", "those", "their", "its", "it", "as", "at", "by",
  "be", "been", "can", "could", "will", "would", "should", "about", "into",
  "than", "then", "there", "here", "which", "who", "whom", "whose", "not",
]);

const WORD_RE = /[a-z0-9][a-z0-9'+.-]*/g;

/** Extracts meaningful lowercase keywords from free text (word-boundary safe). */
export function extractKeywords(text: string, max = 10): string[] {
  const matches = text.toLowerCase().match(WORD_RE) ?? [];
  return [...new Set(matches)].filter(
    (w) => w.length > 2 && !STOP_WORDS.has(w),
  ).slice(0, max);
}

/** Word tokens for relevance/BM25: lowercased, punctuation-stripped. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Word-boundary containment check (v1 used raw substring — matched inside words). */
export function containsPhrase(haystackLower: string, phraseLower: string): boolean {
  if (phraseLower.length === 0) return false;
  let idx = haystackLower.indexOf(phraseLower);
  while (idx !== -1) {
    const before = idx === 0 || /[^a-z0-9]/.test(haystackLower[idx - 1]);
    const after = idx + phraseLower.length >= haystackLower.length ||
      /[^a-z0-9]/.test(haystackLower[idx + phraseLower.length]);
    if (before && after) return true;
    idx = haystackLower.indexOf(phraseLower, idx + 1);
  }
  return false;
}

/**
 * Normalizes a URL for dedup: strips protocol differences, tracking params,
 * trailing slash and fragment.
 */
const TRACKING_PARAMS = /^(utm_|ref_src|fbclid|gclid|mc_cid|mc_eid)/;

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const drop: string[] = [];
    for (const key of u.searchParams.keys()) {
      if (TRACKING_PARAMS.test(key)) drop.push(key);
    }
    for (const key of drop) u.searchParams.delete(key);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.hostname}${path}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
}
