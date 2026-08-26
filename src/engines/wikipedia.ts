/**
 * @file engines/wikipedia.ts
 * Wikipedia Action API engine — structured reference content, zero scraping.
 * Verified live: action=query&generator=search&prop=extracts&explaintext=1
 */
import type { SearchEngine, } from "./types";
import { readerHeaders } from "../core/errors";
import type { SearchHit } from "../core/types";

interface WikiApiPage {
  pageid?: number;
  title?: string;
  extract?: string;
  index?: number;
  missing?: boolean;
}

interface WikiApiResponse {
  query?: { pages?: Record<string, WikiApiPage> };
  error?: { info?: string };
}

export const wikipediaEngine: SearchEngine = {
  id: "wikipedia",
  scopes: ["reference"],

  async search(query, limit, signal): Promise<SearchHit[]> {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("generator", "search");
    url.searchParams.set("gsrsearch", query);
    url.searchParams.set("gsrlimit", String(Math.min(limit, 10)));
    url.searchParams.set("prop", "extracts");
    url.searchParams.set("exintro", "1");
    url.searchParams.set("explaintext", "1");
    url.searchParams.set("origin", "*");

    const res = await fetch(url.href, {
      signal,
      headers: { ...readerHeaders("application/json"), "Api-User-Agent": "DeepResearchPlugin/2.0" },
    });
    if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);

    const data = (await res.json()) as WikiApiResponse;
    if (data.error) throw new Error(`wikipedia API: ${data.error.info ?? "unknown"}`);

    const pages = Object.values(data.query?.pages ?? {})
      .filter((p) => !p.missing && p.extract && p.title)
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .slice(0, limit);

    return pages.map((p) => ({
      engine: "wikipedia" as const,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title!.replace(/ /g, "_"))}`,
      title: p.title!,
      snippet: (p.extract ?? "").slice(0, 300).replace(/\n+/g, " ").trim(),
      published: null,
      text: p.extract,
    }));
  },
};
