/**
 * @file net/pdf.ts
 * Single PDF extraction path shared by all callers (v1 had four copies).
 * Uses pdf-parse v2's high-level getText()/getInfo() API (verified against
 * node_modules/pdf-parse@2.4.5 type definitions).
 */
import { PDFParse } from "pdf-parse";
import type { ExtractedPage } from "./extractor";
import type { Outlink } from "../core/types";

const PDF_URL_SUFFIX = /\.pdf(\?|#|$)/i;
const PDF_HOST_PATHS: ReadonlyArray<RegExp> = [
  /arxiv\.org\/(?:abs|pdf)\//,
];

export function isPdfUrl(url: string): boolean {
  if (PDF_URL_SUFFIX.test(url)) return true;
  try {
    const u = new URL(url);
    return PDF_HOST_PATHS.some((re) => re.test(u.pathname));
  } catch {
    return false;
  }
}

export function isPdfContentType(contentType: string | null | undefined): boolean {
  return !!contentType && /application\/(x-)?pdf/i.test(contentType);
}

const MAX_PDF_PAGES = 30;

/**
 * Extracts plain text + metadata from a PDF buffer.
 */
export async function extractPdfPage(
  buffer: Buffer,
  sourceUrl: string,
  finalUrl: string,
  contentLimit: number,
): Promise<ExtractedPage> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText({ first: MAX_PDF_PAGES }),
      parser.getInfo().catch(() => null),
    ]);

    const title =
      (typeof infoResult?.info?.Title === "string" && infoResult.info.Title.trim()) ||
      inferTitle(textResult.pages[0]?.text ?? "");
    const created = infoResult?.getDateNode().CreationDate;
    const published =
      created && !Number.isNaN(created.getTime())
        ? created.toISOString().slice(0, 10)
        : null;

    const pages: string[] = [];
    let totalChars = 0;
    for (const page of textResult.pages) {
      const cleaned = cleanPdfText(page.text);
      if (cleaned.length > 40) {
        pages.push(cleaned);
        totalChars += cleaned.length;
      }
      if (totalChars > contentLimit) break;
    }

    const text = pages.join("\n\n").slice(0, contentLimit);

    return {
      url: sourceUrl,
      finalUrl,
      title: title || "Untitled PDF",
      description:
        text.slice(0, 250).replace(/\n+/g, " ").trim() ||
        `PDF document (${textResult.total} page(s))`,
      published,
      text,
      wordCount: (text.match(/\S+/g) ?? []).length,
      outlinks: collectPdfUrls(text).slice(0, 15),
    };
  } finally {
    await parser.destroy().catch(() => { /* cleanup is best-effort */ });
  }
}

/** Heuristic first-line title when Info dictionary lacks one. */
function inferTitle(firstPageText: string): string {
  const line = firstPageText.split("\n").map((l) => l.trim()).find((l) => l.length > 10);
  return (line ?? "").slice(0, 120);
}

function cleanPdfText(raw: string): string {
  return raw
    .replace(/-\n(?=[a-z])/g, "")     // de-hyphenate wrapped words
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const URL_IN_TEXT = /https?:\/\/[^\s)>"\]]+/g;

function collectPdfUrls(text: string): Outlink[] {
  const matches = [...new Set(text.match(URL_IN_TEXT) ?? [])];
  return matches.map((href) => ({
    href: href.replace(/[.,;]+$/, ""),
    text: href.slice(0, 80),
  }));
}
