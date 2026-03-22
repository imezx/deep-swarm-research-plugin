/**
 * @file net/pdf-extractor.ts
 * Handles PDF detection, text extraction, and embedded image extraction.
 *
 * When a URL serves a PDF (detected via Content-Type header or URL pattern),
 * this module extracts clean text + embedded images from the PDF instead of
 * passing raw binary bytes through the HTML extractor (which produces garbled output).
 */

import { PDFParse } from "pdf-parse";
import { ExtractedPage, Outlink } from "../types";
import { DESCRIPTION_FALLBACK_CHARS } from "../constants";

/** Patterns that strongly indicate a URL points to a PDF. */
const PDF_URL_RE = /\.pdf(\?.*)?$/i;

/** Additional known PDF-serving URL patterns (academic preprint servers, etc.). */
const PDF_HOST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /arxiv\.org\/pdf\//i,
  /arxiv\.org\/ftp\//i,
  /biorxiv\.org\/content\/.*\.full\.pdf/i,
  /medrxiv\.org\/content\/.*\.full\.pdf/i,
  /papers\.ssrn\.com\/sol3\/Delivery\.cfm/i,
  /dl\.acm\.org\/doi\/pdf\//i,
  /ieeexplore\.ieee\.org\/stampPDF/i,
  /link\.springer\.com\/content\/pdf\//i,
  /pdfs\.semanticscholar\.org\//i,
  /openreview\.net\/pdf/i,
  /proceedings\.neurips\.cc\/paper_files\/.*\.pdf/i,
  /aclanthology\.org\/.*\.pdf/i,
  /pnas\.org\/doi\/pdf\//i,
  /science\.org\/doi\/pdf\//i,
  /nature\.com\/articles\/.*\.pdf/i,
  /researchgate\.net\/.*\/download/i,
];

/**
 * Checks whether a URL is likely to serve a PDF, based on the URL alone.
 */
export function isPdfUrl(url: string): boolean {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_HOST_PATH_PATTERNS.some((re) => re.test(url));
}

/**
 * Checks whether a Content-Type header value indicates PDF content.
 */
export function isPdfContentType(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.includes("application/pdf") || lower.includes("application/x-pdf")
  );
}

export interface PdfImage {
  /** 1-based page number where the image was found. */
  readonly page: number;
  /** Image format (e.g., "png"). */
  readonly format: string;
  /** Base64-encoded image data (data URL). */
  readonly base64: string;
  /** Approximate byte size of the raw image. */
  readonly byteSize: number;
}

/**
 * Extracts text and images from a PDF buffer using pdf-parse v2.
 */
export async function extractPdf(
  buffer: Buffer,
  sourceUrl: string,
  finalUrl: string,
  contentLimit: number,
  extractImages: boolean = true,
  maxImages: number = 20,
): Promise<ExtractedPage & { images: ReadonlyArray<PdfImage> }> {
  const data = new Uint8Array(buffer);
  const parser = new PDFParse({ data } as any);

  let rawText = "";
  let title = "";
  let author = "";
  let pageCount = 0;
  let creationDate: string | null = null;

  try {
    // Extract metadata
    const info = await parser.getInfo();
    pageCount = info.total || 0;

    if (info.info) {
      title = sanitizeMetaString(info.info.Title) || "";
      author = sanitizeMetaString(info.info.Author) || "";
      creationDate = extractDateFromPdfInfo(info.info);
    }

    // Extract text
    const textResult = await parser.getText({
      lineEnforce: true,
      lineThreshold: 5,
    });
    rawText = textResult.text || "";
  } catch (err) {
    throw new Error(
      `PDF parsing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const cleanedText = cleanPdfText(rawText);
  const truncatedText = cleanedText.slice(0, contentLimit);

  if (!title) {
    title = inferTitleFromText(cleanedText);
  }

  const images: PdfImage[] = [];
  if (extractImages) {
    try {
      const imageResult = await parser.getImage({
        imageThreshold: 50,
        imageDataUrl: true,
        imageBuffer: false,
      } as any);

      if (imageResult?.pages) {
        for (const page of imageResult.pages) {
          if (images.length >= maxImages) break;
          if (!(page as any).images) continue;
          for (const img of (page as any).images) {
            if (images.length >= maxImages) break;
            if (!img.dataUrl) continue;

            const match = (img.dataUrl as string).match(
              /^data:image\/(\w+);base64,(.+)$/,
            );
            if (!match) continue;

            images.push({
              page: (page as any).pageNumber || 1,
              format: match[1],
              base64: match[2],
              byteSize: Math.round((match[2].length * 3) / 4),
            });
          }
        }
      }
    } catch {}
  }

  await parser.destroy();

  const wordCount = countWords(truncatedText);
  const description = buildDescription(title, author, pageCount, cleanedText);

  return {
    url: sourceUrl,
    finalUrl,
    title,
    description,
    published: creationDate,
    text: truncatedText,
    wordCount,
    outlinks: extractUrlsFromText(cleanedText, finalUrl),
    images,
  };
}

/**
 * Cleans up typical PDF text extraction artifacts.
 */
function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\s*\d+\s*\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function inferTitleFromText(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 5);
  if (lines.length === 0) return "";
  const candidate = lines[0].trim();
  return candidate.length <= 200 ? candidate : candidate.slice(0, 200);
}

function sanitizeMetaString(val: unknown): string {
  if (typeof val !== "string") return "";
  return val.replace(/\0/g, "").trim();
}

function extractDateFromPdfInfo(info: Record<string, unknown>): string | null {
  for (const key of ["CreationDate", "ModDate", "created", "modified"]) {
    const raw = info[key];
    if (typeof raw !== "string" || !raw) continue;

    const pdfDateMatch = raw.match(/D:(\d{4})(\d{2})(\d{2})/);
    if (pdfDateMatch) {
      return `${pdfDateMatch[1]}-${pdfDateMatch[2]}-${pdfDateMatch[3]}`;
    }

    try {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    } catch {
      continue;
    }
  }
  return null;
}

function buildDescription(
  title: string,
  author: string,
  pageCount: number,
  text: string,
): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  if (author) parts.push(`by ${author}`);
  if (pageCount > 0) parts.push(`(${pageCount} pages)`);

  const metaLine = parts.length > 0 ? parts.join(" ") + ". " : "";
  const textPreview = text.slice(
    0,
    DESCRIPTION_FALLBACK_CHARS - metaLine.length,
  );
  return (metaLine + textPreview).slice(0, DESCRIPTION_FALLBACK_CHARS);
}

function extractUrlsFromText(
  text: string,
  baseUrl: string,
): ReadonlyArray<Outlink> {
  const urlRe = /https?:\/\/[^\s)<>"']+/gi;
  const matches = text.match(urlRe) || [];
  const seen = new Set<string>();
  const links: Outlink[] = [];

  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    baseHost = "";
  }

  for (const rawUrl of matches) {
    if (links.length >= 20) break;
    const cleanUrl = rawUrl.replace(/[.,;:!?)]+$/, "");
    if (seen.has(cleanUrl)) continue;
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.hostname === baseHost) continue;
      seen.add(cleanUrl);
      links.push({
        text: parsed.hostname + parsed.pathname.slice(0, 60),
        href: cleanUrl,
      });
    } catch {
      continue;
    }
  }
  return links;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
