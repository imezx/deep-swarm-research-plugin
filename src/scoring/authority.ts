/**
 * @file scoring/authority.ts
 * Source quality scoring: domain authority, URL structural quality,
 * and content freshness estimation.
 */

import {
  SCORE_WEIGHT_DOMAIN,
  SCORE_WEIGHT_FRESHNESS,
  SCORE_WEIGHT_URL_QUALITY,
  MIN_CANDIDATE_SCORE,
  MIN_URL_QUALITY,
  LINK_KEYWORD_BONUS,
} from "../constants";
import { ScoredCandidate, SearchHit, SourceTier, Outlink } from "../types";

type DomainEntry = readonly [score: number, tier: SourceTier];

// TODO: add more
const DOMAIN_DB: Readonly<Record<string, DomainEntry>> = {
  "arxiv.org": [95, "academic"],
  "pubmed.ncbi.nlm.nih.gov": [98, "academic"],
  "ncbi.nlm.nih.gov": [97, "academic"],
  "nature.com": [98, "academic"],
  "science.org": [98, "academic"],
  "sciencedirect.com": [93, "academic"],
  "ieee.org": [93, "academic"],
  "acm.org": [92, "academic"],
  "springer.com": [90, "academic"],
  "wiley.com": [90, "academic"],
  "researchgate.net": [84, "academic"],
  "semanticscholar.org": [86, "academic"],
  "jstor.org": [88, "academic"],
  "plos.org": [88, "academic"],
  "cell.com": [96, "academic"],
  "thelancet.com": [96, "academic"],
  "nejm.org": [97, "academic"],
  "bmj.com": [94, "academic"],

  "who.int": [93, "government"],
  "cdc.gov": [93, "government"],
  "nih.gov": [95, "government"],
  "nasa.gov": [92, "government"],
  "un.org": [88, "government"],
  "europa.eu": [87, "government"],
  "worldbank.org": [88, "government"],
  "imf.org": [87, "government"],
  "fda.gov": [93, "government"],
  "nist.gov": [90, "government"],
  "epa.gov": [88, "government"],

  "wikipedia.org": [80, "reference"],
  "britannica.com": [85, "reference"],
  "merriam-webster.com": [83, "reference"],
  "investopedia.com": [74, "reference"],
  "healthline.com": [72, "reference"],
  "mayoclinic.org": [90, "reference"],
  "webmd.com": [71, "reference"],
  "khanacademy.org": [80, "reference"],
  "howstuffworks.com": [62, "reference"],

  "reuters.com": [90, "news"],
  "apnews.com": [90, "news"],
  "bbc.com": [84, "news"],
  "bbc.co.uk": [84, "news"],
  "theguardian.com": [80, "news"],
  "nytimes.com": [82, "news"],
  "washingtonpost.com": [81, "news"],
  "economist.com": [85, "news"],
  "ft.com": [85, "news"],
  "bloomberg.com": [80, "news"],
  "wsj.com": [80, "news"],
  "npr.org": [82, "news"],
  "pbs.org": [80, "news"],
  "wired.com": [74, "news"],
  "arstechnica.com": [74, "news"],
  "technologyreview.com": [82, "news"],
  "scientificamerican.com": [86, "news"],
  "newscientist.com": [82, "news"],
  "theatlantic.com": [78, "news"],
  "vox.com": [70, "news"],
  "techcrunch.com": [65, "news"],
  "theverge.com": [68, "news"],
  "time.com": [72, "news"],

  "developer.mozilla.org": [90, "professional"],
  "docs.python.org": [90, "professional"],
  "docs.microsoft.com": [84, "professional"],
  "learn.microsoft.com": [84, "professional"],
  "developers.google.com": [86, "professional"],
  "cloud.google.com": [82, "professional"],
  "aws.amazon.com": [80, "professional"],
  "github.com": [72, "professional"],
  "stackoverflow.com": [68, "professional"],
  "docs.github.com": [84, "professional"],

  "medium.com": [48, "general"],
  "substack.com": [46, "general"],
  "forbes.com": [62, "general"],
  "businessinsider.com": [58, "general"],
  "huffpost.com": [52, "general"],

  "reddit.com": [35, "low"],
  "quora.com": [30, "low"],
  "pinterest.com": [8, "low"],
  "twitter.com": [20, "low"],
  "x.com": [20, "low"],
  "facebook.com": [10, "low"],
  "instagram.com": [8, "low"],
  "youtube.com": [30, "low"],
  "tiktok.com": [5, "low"],
};

const TLD_SCORES: Readonly<Record<string, readonly [number, SourceTier]>> = {
  ".edu": [88, "academic"],
  ".gov": [88, "government"],
  ".ac": [82, "academic"],
  ".int": [82, "government"],
  ".mil": [75, "government"],
  ".org": [58, "general"],
  ".com": [50, "general"],
  ".net": [45, "general"],
  ".io": [50, "professional"],
  ".co": [45, "general"],
};

const URL_PENALTIES: ReadonlyArray<readonly [RegExp, number]> = [
  [/\/tag\//i, 35],
  [/\/category\//i, 25],
  [/\/search[/?]/i, 45],
  [/\/page\/\d+/i, 20],
  [/\/author\//i, 25],
  [/[?&](s|q|query)=/i, 30],
  [/#/, 8],
  [/\.(jpg|png|gif|pdf|zip|mp4)$/i, 55],
  [/\/feed\//i, 30],
  [/\/archive\//i, 15],
];

const URL_BONUSES: ReadonlyArray<readonly [RegExp, number]> = [
  [/\/\d{4}\/\d{2}\//, 12],
  [/\/research\//i, 12],
  [/\/study\//i, 12],
  [/\/paper\//i, 14],
  [/\/report\//i, 10],
  [/\/article\//i, 6],
  [/\/analysis\//i, 10],
  [/\/findings\//i, 12],
  [/\/news\//i, 6],
  [/\/blog\/\d{4}/i, 8],
];

export function scoreCandidate(hit: SearchHit, query: string): ScoredCandidate {
  const hostname = safeHostname(hit.url);
  const [domainScore, tier] = lookupDomain(hostname);
  const urlQuality = computeUrlQuality(hit.url);
  const freshnessScore = estimateFreshness(hit.url, hit.title, hit.snippet);

  const totalScore = Math.round(
    domainScore * SCORE_WEIGHT_DOMAIN +
      urlQuality * SCORE_WEIGHT_URL_QUALITY +
      freshnessScore * SCORE_WEIGHT_FRESHNESS,
  );

  return {
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
    query,
    domainScore,
    freshnessScore,
    urlQuality,
    totalScore,
    tier,
  };
}

export function rankCandidates(
  candidates: ReadonlyArray<ScoredCandidate>,
  limit: number,
): ReadonlyArray<ScoredCandidate> {
  return candidates
    .filter(
      (c) =>
        c.totalScore > MIN_CANDIDATE_SCORE && c.urlQuality > MIN_URL_QUALITY,
    )
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, limit);
}

export function scoreOutlinks(
  links: ReadonlyArray<Outlink>,
  topicKeywords: ReadonlyArray<string>,
  visitedUrls: ReadonlySet<string>,
  maxLinks: number,
): ReadonlyArray<{ readonly href: string; readonly score: number }> {
  const lowerKeywords = topicKeywords.map((k) => k.toLowerCase());

  return links
    .filter((l) => l.href.startsWith("http") && !visitedUrls.has(l.href))
    .map((l) => {
      const { domainScore, urlQuality } = scoreCandidate(
        { url: l.href, title: l.text, snippet: "" },
        "",
      );
      const textLower = l.text.toLowerCase();
      const kwHits = lowerKeywords.filter((kw) =>
        textLower.includes(kw),
      ).length;
      const score =
        domainScore * 0.4 + urlQuality * 0.2 + kwHits * LINK_KEYWORD_BONUS;
      return { href: l.href, score };
    })
    .filter((l) => l.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLinks);
}

function lookupDomain(hostname: string): DomainEntry {
  if (DOMAIN_DB[hostname]) return DOMAIN_DB[hostname];
  for (const [domain, entry] of Object.entries(DOMAIN_DB)) {
    if (hostname.endsWith("." + domain)) return entry;
  }
  for (const [tld, entry] of Object.entries(TLD_SCORES)) {
    if (hostname.endsWith(tld)) return entry;
  }
  return [48, "general"];
}

function computeUrlQuality(url: string): number {
  let score = 70;
  for (const [re, penalty] of URL_PENALTIES) if (re.test(url)) score -= penalty;
  for (const [re, bonus] of URL_BONUSES) if (re.test(url)) score += bonus;
  return Math.max(0, Math.min(100, score));
}

const CURRENT_YEAR = new Date().getFullYear();

function estimateFreshness(
  url: string,
  title: string,
  snippet: string,
): number {
  const m = /\/(20\d{2})\//.exec(url);
  if (m) {
    const year = parseInt(m[1], 10);
    if (year === CURRENT_YEAR) return 100;
    if (year === CURRENT_YEAR - 1) return 85;
    if (year === CURRENT_YEAR - 2) return 70;
    if (year === CURRENT_YEAR - 3) return 55;
    return Math.max(10, 55 - (CURRENT_YEAR - year - 3) * 8);
  }

  const combined = `${title} ${snippet}`.toLowerCase();
  if (combined.includes(String(CURRENT_YEAR))) return 85;
  if (combined.includes(String(CURRENT_YEAR - 1))) return 70;
  if (/latest|new\s|recent|just\s|breaking/i.test(combined)) return 65;

  return 50;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
