/**
 * @file local/search.ts
 * Bridges the local document store into the swarm search pipeline.
 *
 * Converts local document chunks into SearchHit and CrawledSource objects
 * that flow through the same scoring, deduplication, and reporting paths
 * as web-sourced content.
 *
 * Now supports:
 * - Progressive source retrieval (proprietary → internal → reference → general)
 * - Role-based auto-routing via library tags
 * - Context-enriched chunks (includes surrounding chunk text)
 * - Library priority boosting in relevance scores
 */

import { SearchHit, CrawledSource, WorkerRole, SourceTier } from "../types";
import { getGlobalStore, LocalSearchHit, LibraryPriority } from "./store";

/** Map library priority to source tier. */
const PRIORITY_TIER_MAP: Record<LibraryPriority, SourceTier> = {
  proprietary: "reference",
  internal: "reference",
  reference: "reference",
  general: "general",
};

/** Map library priority to domain score. */
const PRIORITY_DOMAIN_SCORES: Record<LibraryPriority, number> = {
  proprietary: 95,
  internal: 90,
  reference: 85,
  general: 75,
};

const LOCAL_FRESHNESS_SCORE = 70;

function localHitToSearchHit(hit: LocalSearchHit): SearchHit {
  const snippet = hit.text.slice(0, 250).replace(/\n+/g, " ").trim();
  return {
    url: `local://${hit.libraryName}/${hit.fileRelPath || hit.fileName}#chunk${hit.chunkIndex}`,
    title: `${hit.fileName} (${hit.libraryName})`,
    snippet,
  };
}

function localHitToCrawledSource(
  hit: LocalSearchHit,
  query: string,
  role: WorkerRole,
  label: string,
  contentLimit: number,
): CrawledSource {
  let text = "";
  if (hit.contextBefore) {
    text += hit.contextBefore + "\n\n---\n\n";
  }
  text += hit.text;
  if (hit.contextAfter) {
    text += "\n\n---\n\n" + hit.contextAfter;
  }
  text = text.slice(0, contentLimit);

  const priority = hit.libraryPriority;
  const tier = PRIORITY_TIER_MAP[priority];
  const domainScore = PRIORITY_DOMAIN_SCORES[priority];

  const baseRelevance = Math.min(1, hit.score * 1.5);
  const priorityBoost =
    priority === "proprietary"
      ? 0.15
      : priority === "internal"
        ? 0.1
        : priority === "reference"
          ? 0.05
          : 0;
  const relevanceScore = Math.min(1, baseRelevance + priorityBoost);

  return {
    url: `local://${hit.libraryName}/${hit.fileRelPath || hit.fileName}#chunk${hit.chunkIndex}`,
    finalUrl: `local://${hit.libraryName}/${hit.fileRelPath || hit.fileName}#chunk${hit.chunkIndex}`,
    title: hit.heading
      ? `${hit.fileName} — ${hit.heading} (${hit.libraryName})`
      : `${hit.fileName} (${hit.libraryName})`,
    description: text.slice(0, 250).replace(/\n+/g, " ").trim(),
    published: null,
    text,
    wordCount: hit.wordCount,
    outlinks: [],
    sourceQuery: query,
    workerRole: role,
    workerLabel: label,
    domainScore,
    freshnessScore: LOCAL_FRESHNESS_SCORE,
    tier,
    relevanceScore,
    origin: "local" as const,
  };
}

export function searchLocalCollections(
  query: string,
  maxResults: number,
  collectionIds?: ReadonlyArray<string>,
): ReadonlyArray<SearchHit> {
  const store = getGlobalStore();
  if (!store.hasCollections()) return [];

  const hits = store.search(query, maxResults, collectionIds);
  return hits.map(localHitToSearchHit);
}

export function searchLocalForRole(
  query: string,
  role: WorkerRole,
  maxResults: number = 8,
  roleCollectionMap?: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<SearchHit> {
  const store = getGlobalStore();
  if (!store.hasCollections()) return [];

  const hits = store.searchByRole(query, role, maxResults, roleCollectionMap);
  return hits.map(localHitToSearchHit);
}

/**
 * Progressive harvest: searches local libraries in priority order
 * (proprietary first, then internal, reference, general).
 * This is the "progressive source approach" — proprietary knowledge
 * is preferred, web fills remaining gaps.
 */
export function harvestLocalSources(
  queries: ReadonlyArray<string>,
  role: WorkerRole,
  label: string,
  maxTotal: number,
  contentLimit: number,
  collectionIds?: ReadonlyArray<string>,
  roleCollectionMap?: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<CrawledSource> {
  const store = getGlobalStore();
  if (!store.hasCollections()) return [];

  const seen = new Set<string>();
  const sources: CrawledSource[] = [];

  const useProgressive = !collectionIds && !roleCollectionMap?.get(role);

  for (const query of queries) {
    if (sources.length >= maxTotal) break;

    const remaining = maxTotal - sources.length;
    let hits: ReadonlyArray<LocalSearchHit>;

    if (useProgressive) {
      hits = store.searchProgressive(query, remaining);
    } else {
      const targetIds = roleCollectionMap?.get(role) ?? collectionIds;
      hits = store.search(query, remaining, targetIds);
    }

    for (const hit of hits) {
      if (sources.length >= maxTotal) break;

      const dedupeKey = `${hit.filePath}:${hit.chunkIndex}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      sources.push(
        localHitToCrawledSource(hit, query, role, label, contentLimit),
      );
    }
  }

  return sources;
}

export function isLocalUrl(url: string): boolean {
  return url.startsWith("local://");
}
