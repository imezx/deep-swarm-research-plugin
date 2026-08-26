/**
 * @file ranking/authority.ts
 * Domain authority + source-tier classification + freshness.
 * Curated DB for high-signal domains; TLD fallback otherwise.
 */
import type { SourceTier } from "../core/types";
import { hostnameOf } from "../core/util";

type DomainEntry = readonly [score: number, tier: SourceTier];

const DOMAIN_DB: Readonly<Record<string, DomainEntry>> = {
  // reference
  "wikipedia.org": [95, "reference"],
  "britannica.com": [85, "reference"],
  "stanford encyclopedia": [88, "reference"], // matched via plato.stanford.edu below
  "plato.stanford.edu": [88, "reference"],
  // academic
  "arxiv.org": [90, "academic"],
  "nature.com": [92, "academic"],
  "science.org": [93, "academic"],
  "cell.com": [91, "academic"],
  "thelancet.com": [92, "academic"],
  "nejm.org": [94, "academic"],
  "bmj.com": [90, "academic"],
  "jamanetwork.com": [90, "academic"],
  "plos.org": [85, "academic"],
  "springer.com": [84, "academic"],
  "sciencedirect.com": [86, "academic"],
  "wiley.com": [83, "academic"],
  "ieee.org": [87, "academic"],
  "acm.org": [86, "academic"],
  "apa.org": [84, "academic"],
  "scholar.google.com": [80, "academic"],
  "semanticscholar.org": [80, "academic"],
  "openalex.org": [78, "academic"],
  "pubmed.ncbi.nlm.nih.gov": [89, "academic"],
  "ncbi.nlm.nih.gov": [89, "academic"],
  // government / IGO
  "who.int": [92, "government"],
  "fda.gov": [91, "government"],
  "cdc.gov": [92, "government"],
  "nih.gov": [92, "government"],
  "esa.int": [85, "government"],
  "nasa.gov": [92, "government"],
  "noaa.gov": [88, "government"],
  "europa.eu": [87, "government"],
  "un.org": [86, "government"],
  "worldbank.org": [87, "government"],
  "oecd.org": [87, "government"],
  "imf.org": [86, "government"],
  "gov.uk": [88, "government"],
  "justice.gov": [86, "government"],
  "ecb.europa.eu": [86, "government"],
  "federalreserve.gov": [88, "government"],
  // news
  "reuters.com": [88, "news"],
  "apnews.com": [88, "news"],
  "bbc.com": [86, "news"],
  "bbc.co.uk": [86, "news"],
  "ft.com": [85, "news"],
  "wsj.com": [85, "news"],
  "nytimes.com": [84, "news"],
  "economist.com": [85, "news"],
  "theguardian.com": [82, "news"],
  "bloomberg.com": [84, "news"],
  "npr.org": [82, "news"],
  "aljazeera.com": [79, "news"],
  // professional / primary
  "github.com": [72, "professional"],
  "microsoft.com": [80, "professional"],
  "developer.mozilla.org": [84, "professional"],
  "python.org": [83, "professional"],
  "kernel.org": [82, "professional"],
  "w3.org": [84, "professional"],
  "ietf.org": [83, "professional"],
  "stackoverflow.com": [70, "professional"],
};

const TLD_SCORES: Readonly<Record<string, DomainEntry>> = {
  ".edu": [74, "academic"],
  ".ac.uk": [78, "academic"],
  ".gov": [80, "government"],
  ".mil": [78, "government"],
  ".int": [76, "government"],
  ".org": [62, "professional"],
  ".news": [58, "news"],
};

const LOW_QUALITY_PATTERNS: ReadonlyArray<RegExp> = [
  /pinterest\./, /quora\.com$/, /answers\.com$/, /ask\.com$/,
  /\bessay\b/, /\bhomedelight\b/, /content-farm/, /^\d/,
];

const CURRENT_YEAR = new Date().getFullYear();

export interface CandidateAssessment {
  readonly authorityScore: number;
  readonly tier: SourceTier;
  readonly freshnessScore: number;
}

function lookupDomain(hostname: string): DomainEntry {
  const exact = DOMAIN_DB[hostname];
  if (exact) return exact;
  for (const [domain, entry] of Object.entries(DOMAIN_DB)) {
    if (hostname.endsWith(`.${domain}`)) return entry;
  }
  for (const [tld, entry] of Object.entries(TLD_SCORES)) {
    if (hostname.endsWith(tld)) return entry;
  }
  return [50, "general"];
}

/** Freshness 0–100 from ISO published date (preferred) or year in text. */
export function freshnessScore(published: string | null, hintText?: string): number {
  if (published) {
    const year = parseInt(published.slice(0, 4), 10);
    if (!Number.isNaN(year) && year >= 1990 && year <= CURRENT_YEAR + 1) {
      const age = CURRENT_YEAR - year;
      if (age <= 0) return 100;
      if (age === 1) return 88;
      if (age === 2) return 75;
      return Math.max(15, 70 - age * 6);
    }
  }
  if (hintText && hintText.includes(String(CURRENT_YEAR))) return 82;
  return 55; // unknown — neutral
}

/**
 * Assesses a candidate URL (+ optional known metadata).
 * Low-quality patterns cap the score regardless of TLD luck.
 */
export function assessCandidate(
  url: string,
  published: string | null = null,
  hintYearText?: string,
): CandidateAssessment {
  const hostname = hostnameOf(url);
  let [authorityScore, tier] = lookupDomain(hostname);

  if (LOW_QUALITY_PATTERNS.some((re) => re.test(hostname) || re.test(url.toLowerCase()))) {
    authorityScore = Math.min(authorityScore, 25);
    tier = "low";
  }

  return {
    authorityScore,
    tier,
    freshnessScore: freshnessScore(published, hintYearText),
  };
}
