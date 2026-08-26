/**
 * @file engines/arxiv.ts
 * arXiv Atom API engine for preprints. Verified live against export.arxiv.org.
 */
import type { SearchEngine } from "./types";
import { readerHeaders } from "../core/errors";
import type { SearchHit } from "../core/types";

function textOf(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
interface ArxivEntryFields {
  id: string;
  title: string;
  summary: string;
  published: string | null;
  pdfLink: string;
}

/** Extracts entry fields from one <entry> XML block. */
export function parseArxivEntry(block: string): ArxivEntryFields | null {
  const idRaw = textOf(block, "id");
  if (!idRaw.includes("/abs/")) return null;
  const title = textOf(block, "title");
  if (!title) return null;

  const pdfMatch = /href="(https?:\/\/[^"]+\/pdf\/[^"]+)"/.exec(block);
  const dateMatch = textOf(block, "published");

  return {
    id: idRaw.trim(),
    title,
    summary: textOf(block, "summary"),
    published: dateMatch ? dateMatch.slice(0, 10) : null,
    pdfLink: pdfMatch ? pdfMatch[1] : idRaw.replace("/abs/", "/pdf/"),
  };
}

export function parseArxivFeed(xml: string): ArxivEntryFields[] {
  const entries: ArxivEntryFields[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const parsed = parseArxivEntry(m[1]);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export const arxivEngine: SearchEngine = {
  id: "arxiv",
  scopes: ["academic"],

  async search(query, limit, signal): Promise<SearchHit[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("max_results", String(Math.min(limit, 20)));

    const res = await fetch(url.href, {
      signal,
      headers: readerHeaders("application/atom+xml, application/xml;q=0.9, */*;q=0.8"),
    });
    if (!res.ok) throw new Error(`arxiv HTTP ${res.status}`);

    return parseArxivFeed(await res.text()).slice(0, limit).map((e) => ({
      engine: "arxiv" as const,
      // Abstract page loads reliably; PDF fetch happens only if the worker follows it.
      url: e.pdfLink.replace(/\/pdf\//, "/abs/").replace(/\.pdf$/, ""),
      title: e.title,
      snippet: e.summary.slice(0, 300),
      published: e.published,
      text: `${e.title}. ${e.summary}`,
    }));
  },
};
