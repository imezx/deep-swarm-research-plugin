/**
 * @file net/extractor.ts
 * HTML → clean text via boilerplate strip + Readability, plus metadata
 * extraction (title, description, published date, external outlinks).
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { Outlink } from "../core/types";
import { hostnameOf } from "../core/util";

const virtualConsole = new VirtualConsole();
virtualConsole.on("error", () => { /* jsdom parse noise */ });
virtualConsole.on("jsdomError", () => { /* css/js errors are irrelevant to us */ });

const STRIP_BEFORE_PARSE =
  /<style[\s\S]*?<\/style>|<link[^>]+rel=["']stylesheet["'][^>]*>|<script[^>]+src=[^>]*><\/script>/gi;

const BOILERPLATE_SELECTORS: ReadonlyArray<string> = [
  "nav", "footer", "aside", "#sidebar", ".sidebar", ".nav", ".menu",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]",
  ".advertisement", ".ad", ".adsbygoogle", ".social-share", ".share-buttons",
  ".related-posts", ".comments", "#comments", ".newsletter", ".subscribe",
  ".cookie-banner", ".cookie-consent", ".paywall", "#masthead",
];

export interface ExtractedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
}

function extractTitle(doc: Document): string {
  return (
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.title?.trim() ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    ""
  );
}

function extractDescription(doc: Document): string {
  return (
    doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ||
    ""
  );
}

const DATE_SELECTORS: ReadonlyArray<string> = [
  'meta[property="article:published_time"]',
  'meta[name="date"]',
  'meta[name="pubdate"]',
  'meta[itemprop="datePublished"]',
  "time[datetime]",
];

const URL_DATE = /\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\//;

function toIsoDate(raw: string): string | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extractPublishedDate(doc: Document, url: string): string | null {
  for (const script of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    try {
      const data = JSON.parse(script.textContent ?? "{}");
      const raw = data.datePublished ?? data.dateModified ?? data.uploadDate;
      if (typeof raw === "string") {
        const iso = toIsoDate(raw);
        if (iso) return iso;
      }
    } catch { /* malformed JSON-LD — skip */ }
  }
  for (const selector of DATE_SELECTORS) {
    const el = doc.querySelector(selector);
    const val = el?.getAttribute("content") ?? el?.getAttribute("datetime");
    if (val) {
      const iso = toIsoDate(val);
      if (iso) return iso;
    }
  }
  const m = URL_DATE.exec(url);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const MIN_WORD_LEN_TEXT = 4;

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
      if (cleaned.split(/\s+/).length >= MIN_WORD_LEN_TEXT * 20) {
        return cleaned.slice(0, limit);
      }
    }
  } catch { /* fall through to regex stripping */ }

  const stripped = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, limit);
}

function extractOutlinks(doc: Document, baseUrl: string, max: number): ReadonlyArray<Outlink> {
  const baseHost = hostnameOf(baseUrl);
  const seen = new Set<string>();
  const links: Outlink[] = [];

  for (const el of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (links.length >= max) break;
    const href = el.href.replace(/^www\./, "");
    if (!href.startsWith("http")) continue;
    if (seen.has(href)) continue;
    if (hostnameOf(href) === baseHost || baseHost === "") continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 4 || text.length > 120) continue;
    seen.add(href);
    links.push({ text, href });
  }
  return links;
}

/** Main entry: raw body bytes + content type → structured page. */
export function extractPageFromHtml(
  html: string,
  sourceUrl: string,
  finalUrl: string,
  contentLimit: number,
  maxOutlinks = 40,
): ExtractedPage {
  const cleaned = html.replace(STRIP_BEFORE_PARSE, "");
  const dom = new JSDOM(cleaned, { url: finalUrl, virtualConsole });
  const doc = dom.window.document;

  for (const selector of BOILERPLATE_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) el.remove();
  }

  const title = extractTitle(doc);
  const description = extractDescription(doc);
  const published = extractPublishedDate(doc, finalUrl);
  const outlinks = extractOutlinks(doc, finalUrl, maxOutlinks);
  const text = extractText(doc, html, contentLimit);

  return {
    url: sourceUrl,
    finalUrl,
    title,
    description,
    published,
    text,
    wordCount: (text.match(/\S+/g) ?? []).length,
    outlinks,
  };
}
