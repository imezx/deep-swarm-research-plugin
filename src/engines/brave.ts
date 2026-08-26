/**
 * @file engines/brave.ts
 * Brave Search HTML scrape — supplementary general-scope engine.
 */
import { searchScrapeHeaders } from "../core/errors";
import type { SearchEngine } from "./types";
import type { SearchHit } from "../core/types";
import { sleep } from "../core/util";

const MIN_DELAY_MS = 2_000;
let lastRequestAt = 0;

async function acquireSlot(signal: AbortSignal): Promise<void> {
  const wait = Math.max(0, MIN_DELAY_MS - (Date.now() - lastRequestAt));
  if (wait > 0 && !signal.aborted) await sleep(wait);
  lastRequestAt = Date.now();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface RawBlock { url: string; title: string; snippet: string; }

export function parseBraveResults(html: string, maxResults: number): RawBlock[] {
  const blocks: RawBlock[] = [];
  const seen = new Set<string>();

  const snippetBlockRe =
    /<div[^>]+class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*snippet|<footer)/gi;
  const linkRe = /href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const descRe = /<div[^>]+class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

  let blockMatch: RegExpExecArray | null;
  while (
    blocks.length < maxResults &&
    (blockMatch = snippetBlockRe.exec(html)) !== null
  ) {
    const block = blockMatch[1];
    const lm = linkRe.exec(block);
    if (!lm) continue;

    const url = lm[1].trim();
    if (!url.startsWith("http") || seen.has(url)) continue;
    if (/brave\.com|search\.brave/i.test(url)) continue;
    seen.add(url);

    const descMatch = descRe.exec(block);
    blocks.push({
      url,
      title: stripTags(lm[2]),
      snippet: descMatch ? stripTags(descMatch[1]) : "",
    });
  }

  if (blocks.length === 0) {
    // Fallback: generic result-heading anchors.
    const fallbackRe =
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*heading[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while (
      blocks.length < maxResults &&
      (m = fallbackRe.exec(html)) !== null
    ) {
      const url = m[1].trim();
      if (seen.has(url) || /brave\.com/i.test(url)) continue;
      seen.add(url);
      blocks.push({ url, title: stripTags(m[2]), snippet: "" });
    }
  }

  return blocks;
}

export const braveEngine: SearchEngine = {
  id: "brave",
  scopes: ["general"],

  async search(query, limit, signal): Promise<SearchHit[]> {
    await acquireSlot(signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
    const res = await fetch(url, {
      signal,
      headers: searchScrapeHeaders("https://search.brave.com/"),
    });
    if (!res.ok) throw new Error(`brave HTTP ${res.status}`);

    return parseBraveResults(await res.text(), limit).map((b) => ({
      engine: "brave" as const,
      url: b.url,
      title: b.title,
      snippet: b.snippet,
      published: null,
    }));
  },
};
