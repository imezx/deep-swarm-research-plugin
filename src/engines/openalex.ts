/**
 * @file engines/openalex.ts
 * OpenAlex scholarly works engine — free, no key, full metadata.
 * Verified live: /works?search=... returns abstract_inverted_index.
 */
import type { SearchEngine } from "./types";
import { readerHeaders } from "../core/errors";
import type { SearchHit } from "../core/types";

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  publication_date?: string | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
  } | null;
}

/** Reassembles an abstract from OpenAlex's inverted-index format. */
export function reconstructAbstract(
  inverted: Record<string, number[]>,
): string {
  const pairs: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions) pairs.push([pos, word]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(([, word]) => word).join(" ");
}

function workUrl(work: OpenAlexWork): string {
  return (
    work.primary_location?.landing_page_url ||
    work.doi ||
    work.id ||
    ""
  );
}

export const openAlexEngine: SearchEngine = {
  id: "openalex",
  scopes: ["academic"],

  async search(query, limit, signal): Promise<SearchHit[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", String(Math.min(limit, 25)));
    url.searchParams.set("select", "id,doi,title,publication_date,abstract_inverted_index,primary_location");
    url.searchParams.set("mailto", "deep-research-plugin@localhost"); // polite pool

    const res = await fetch(url.href, {
      signal,
      headers: readerHeaders("application/json"),
    });
    if (!res.ok) throw new Error(`openalex HTTP ${res.status}`);

    const data = (await res.json()) as { results?: OpenAlexWork[] };
    const results = data.results ?? [];

    return results
      .filter((w) => w.title && workUrl(w))
      .slice(0, limit)
      .map((w) => {
        const abstract = w.abstract_inverted_index
          ? reconstructAbstract(w.abstract_inverted_index)
          : "";
        return {
          engine: "openalex" as const,
          url: workUrl(w),
          title: w.title!,
          snippet: abstract.slice(0, 300),
          published: w.publication_date ?? null,
          text: [w.title ?? "", abstract].filter(Boolean).join(". "),
        };
      });
  },
};
