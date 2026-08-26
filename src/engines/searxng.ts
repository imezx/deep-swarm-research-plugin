/**
 * SearXNG engine. Uses the JSON API:
 * GET {base}/search?q=...&format=json
 *
 * The instance must have `formats: [html, json]` in settings.yml.
 * The endpoint comes from plugin config, so it may point at localhost —
 * the SSRF guard does not apply here.
 */
import type { SearchEngine } from "./types";
import type { SearchHit } from "../core/types";
import { readerHeaders } from "../core/errors";

let baseUrl: string | null = null;

/** Called once at tool registration from plugin config. Empty/null disables. */
export function setSearxngEndpoint(url: string | null | undefined): void {
  const trimmed = url?.trim() ?? "";
  baseUrl = trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : null;
}

export function getSearxngEndpoint(): string | null {
  return baseUrl;
}

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export function parseSearxngResponse(data: SearxngResponse, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const result of data.results ?? []) {
    if (hits.length >= limit) break;
    const url = result.url ?? "";
    if (!url.startsWith("http") || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      engine: "searxng",
      url,
      title: result.title ?? url,
      snippet: result.content ?? "",
      published: normalizePublished(result.publishedDate),
    });
  }
  return hits;
}

function normalizePublished(raw: string | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export const searxngEngine: SearchEngine = {
  id: "searxng",
  scopes: ["general"],

  async search(query, limit, signal): Promise<SearchHit[]> {
    if (baseUrl === null) return [];

    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    // Language-agnostic; the instance's own settings apply.

    const res = await fetch(url.href, {
      signal,
      headers: readerHeaders("application/json"),
    });
    if (!res.ok) {
      throw new Error(
        `searxng HTTP ${res.status}${res.status === 403 ? " (enable format=json in settings.yml)" : ""}`,
      );
    }

    return parseSearxngResponse((await res.json()) as SearxngResponse, limit);
  },
};
