/**
 * @file net/extractor.ts
 * Extracts clean structured content from raw HTML.
 * Uses Mozilla Readability as the primary extractor,
 * with a tag-stripping fallback for pages it cannot parse.
 *
 * Aggressive boilerplate removal runs BEFORE Readability (nav, footer,
 * sidebar, cookie banners, ads, social widgets, comments). Outlink limit
 * is configurable and scales with the depth profile. Whitespace
 * normalization preserves paragraph structure.
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { ExtractedPage, Outlink } from "../types";
import {
  DESCRIPTION_FALLBACK_CHARS,
  MIN_READABILITY_TEXT_LEN,
  OUTLINK_TEXT_MIN_LEN,
  OUTLINK_TEXT_MAX_LEN,
  FINGERPRINT_HEAD_WORDS,
  FINGERPRINT_MID_WORDS,
  FINGERPRINT_TAIL_WORDS,
  RELEVANCE_KEYWORD_FRACTION,
  RELEVANCE_TITLE_BONUS,
  RELEVANCE_SNIPPET_BONUS,
} from "../constants";

const virtualConsole = new VirtualConsole();
virtualConsole.on("error", () => { });

/** CSS/style tags to strip before DOM parsing */
const STRIP_BEFORE_PARSE_RE =
  /<style[\s\S]*?<\/style>|<link[^>]+rel=["']stylesheet["'][^>]*>/gi;

/**
 * Selectors for elements that are almost always boilerplate/noise.
 * Removing these before Readability dramatically improves extraction quality.
 */
const BOILERPLATE_SELECTORS: ReadonlyArray<string> = [
  "nav",
  "header",
  "footer",
  ".nav",
  ".navbar",
  ".navigation",
  ".header",
  ".footer",
  ".sidebar",
  ".side-bar",
  ".widget",
  ".cookie-banner",
  ".cookie-consent",
  ".cookie-notice",
  ".gdpr",
  ".consent",
  ".popup",
  ".modal",
  ".overlay",
  ".ad",
  ".ads",
  ".advertisement",
  ".advert",
  ".banner-ad",
  ".social-share",
  ".social-links",
  ".share-buttons",
  ".sharing",
  ".related-posts",
  ".related-articles",
  ".recommended",
  ".comments",
  ".comment-section",
  "#comments",
  ".newsletter",
  ".subscribe",
  ".subscription",
  ".signup",
  ".sign-up",
  ".breadcrumb",
  ".breadcrumbs",
  ".pagination",
  ".pager",
  ".menu",
  ".toc",
  ".table-of-contents",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[aria-label="cookie"]',
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="gdpr"]',
  '[class*="popup"]',
  '[class*="modal"]',
  '[class*="overlay"]',
  '[class*="sidebar"]',
  '[class*="footer"]',
  '[class*="header"]',
  '[class*="nav-"]',
  '[class*="ad-"]',
  '[class*="promo"]',
  "aside",
  "figcaption",
  "noscript",
  "iframe",
];

/**
 * Strip boilerplate elements from the DOM before Readability processes it.
 * This is THE key improvement for content quality — Readability often
 * includes nav/footer text when these elements are present.
 */
function stripBoilerplate(doc: Document): void {
  for (const selector of BOILERPLATE_SELECTORS) {
    try {
      const elements = doc.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        el.remove();
      }
    } catch { }
  }

  try {
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const style = (el as HTMLElement).getAttribute("style") ?? "";
      if (
        /display\s*:\s*none/i.test(style) ||
        /visibility\s*:\s*hidden/i.test(style)
      ) {
        el.remove();
      }
    }
  } catch { }
}

const DEFAULT_MAX_OUTLINKS = 40;

export function extractPage(
  html: string,
  sourceUrl: string,
  finalUrl: string,
  contentLimit: number,
  maxOutlinks: number = DEFAULT_MAX_OUTLINKS,
): ExtractedPage {
  const cleanedHtml = html.replace(STRIP_BEFORE_PARSE_RE, "");
  const dom = new JSDOM(cleanedHtml, { url: finalUrl, virtualConsole });
  const doc = dom.window.document;

  stripBoilerplate(doc);

  const title = extractTitle(doc);
  const description = extractDescription(doc);
  const published = extractPublishedDate(doc, finalUrl);
  const outlinks = extractOutlinks(doc, finalUrl, maxOutlinks);
  const text = extractText(doc, html, contentLimit);
  const wordCount = countWords(text);

  return {
    url: sourceUrl,
    finalUrl,
    title,
    description: description || text.slice(0, DESCRIPTION_FALLBACK_CHARS),
    published,
    text,
    wordCount,
    outlinks,
  };
}

function extractTitle(doc: Document): string {
  return (
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.title?.trim() ||
    doc
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content")
      ?.trim() ||
    ""
  );
}

function extractDescription(doc: Document): string {
  return (
    doc
      .querySelector('meta[name="description"]')
      ?.getAttribute("content")
      ?.trim() ||
    doc
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content")
      ?.trim() ||
    ""
  );
}

const DATE_META_SELECTORS: ReadonlyArray<string> = [
  'meta[property="article:published_time"]',
  'meta[name="date"]',
  'meta[name="pubdate"]',
  'meta[name="DC.date"]',
  'meta[itemprop="datePublished"]',
  'time[itemprop="datePublished"]',
  "time[datetime]",
];

const URL_DATE_RE = /\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\//;

function extractPublishedDate(doc: Document, url: string): string | null {
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    try {
      const data = JSON.parse(script.textContent ?? "{}") as Record<
        string,
        unknown
      >;
      const raw =
        data["datePublished"] ?? data["dateModified"] ?? data["uploadDate"];
      if (typeof raw === "string") return toIsoDate(raw);
    } catch {
      /* skip malformed JSON-LD */
    }
  }

  for (const selector of DATE_META_SELECTORS) {
    const el = doc.querySelector(selector);
    const val = el?.getAttribute("content") ?? el?.getAttribute("datetime");
    if (val) {
      const parsed = toIsoDate(val);
      if (parsed) return parsed;
    }
  }

  const m = URL_DATE_RE.exec(url);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return null;
}

function toIsoDate(raw: string): string | null {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function extractText(doc: Document, rawHtml: string, limit: number): string {
  try {
    const cloned = doc.cloneNode(true) as Document;
    const article = new Readability(cloned, {
      serializer: (node: Node) => node.textContent ?? "",
    }).parse();

    if (article?.textContent) {
      const cleaned = article.textContent
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (cleaned.length > MIN_READABILITY_TEXT_LEN)
        return cleaned.slice(0, limit);
    }
  } catch {
    /* fall through */
  }

  const stripped = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped.slice(0, limit);
}

function extractOutlinks(
  doc: Document,
  baseUrl: string,
  maxOutlinks: number = DEFAULT_MAX_OUTLINKS,
): ReadonlyArray<Outlink> {
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    baseHost = "";
  }

  const seen: Set<string> = new Set();
  const links: Outlink[] = [];

  for (const el of Array.from(
    doc.querySelectorAll<HTMLAnchorElement>("a[href]"),
  )) {
    if (links.length >= maxOutlinks) break;

    const href = el.href;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();

    if (!href.startsWith("http")) continue;
    if (seen.has(href)) continue;
    if (
      text.length < OUTLINK_TEXT_MIN_LEN ||
      text.length > OUTLINK_TEXT_MAX_LEN
    )
      continue;

    try {
      if (new URL(href).hostname === baseHost) continue;
    } catch {
      continue;
    }

    seen.add(href);
    links.push({ text, href });
  }

  return links;
}

/**
 * Samples words from the beginning, middle, and end of the text
 * to avoid false positives from shared boilerplate intros.
 */
export function contentFingerprint(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  if (
    words.length <=
    FINGERPRINT_HEAD_WORDS + FINGERPRINT_MID_WORDS + FINGERPRINT_TAIL_WORDS
  ) {
    return words.join(" ");
  }

  const head = words.slice(0, FINGERPRINT_HEAD_WORDS);
  const midStart = Math.floor((words.length - FINGERPRINT_MID_WORDS) / 2);
  const mid = words.slice(midStart, midStart + FINGERPRINT_MID_WORDS);
  const tail = words.slice(-FINGERPRINT_TAIL_WORDS);

  return [...head, ...mid, ...tail].join(" ");
}

/**
 * Computes a 0–1 relevance score measuring how on-topic a page is.
 */
export function computeRelevance(
  text: string,
  title: string,
  snippet: string,
  topicKws: ReadonlyArray<string>,
): number {
  if (topicKws.length === 0) return 0.5;

  const lowerText = text.toLowerCase();
  const lowerTitle = title.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();
  const lowerKws = topicKws.map((k) => k.toLowerCase());

  const textHits = lowerKws.filter((kw) => lowerText.includes(kw)).length;
  let score = textHits / lowerKws.length;

  const titleHits = lowerKws.filter((kw) => lowerTitle.includes(kw)).length;
  score += (titleHits / lowerKws.length) * RELEVANCE_TITLE_BONUS;

  const snippetHits = lowerKws.filter((kw) => lowerSnippet.includes(kw)).length;
  score += (snippetHits / lowerKws.length) * RELEVANCE_SNIPPET_BONUS;

  const densityText = lowerText.slice(0, 8000);
  let totalOccurrences = 0;
  for (const kw of lowerKws) {
    let idx = 0;
    while ((idx = densityText.indexOf(kw, idx)) !== -1) {
      totalOccurrences++;
      idx += kw.length;
    }
  }
  const densityWordCount = densityText.split(/\s+/).length;
  const density = Math.min(
    1,
    (totalOccurrences / Math.max(1, densityWordCount)) * 10,
  );
  score += density * 0.1;

  return Math.min(1, Math.max(0, score));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
