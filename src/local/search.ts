/**
 * @file local/search.ts
 * Bridges the local document store into the swarm search pipeline.
 *
 * Converts local document chunks into SearchHit and CrawledSource objects
 * that flow through the same scoring, deduplication, and reporting paths
 * as web-sourced content. This lets swarm workers query local collections
 * alongside web engines without any changes to the orchestrator or report
 * builder.
 */

import {
  SearchHit,
  CrawledSource,
  WorkerRole,
  SourceTier,
} from "../types";
import { getGlobalStore, LocalSearchHit } from "./store";

const LOCAL_TIER: SourceTier = "reference";
const LOCAL_DOMAIN_SCORE = 85;
const LOCAL_FRESHNESS_SCORE = 70;

function localHitToSearchHit(hit: LocalSearchHit): SearchHit {
  const snippet = hit.text.slice(0, 250).replace(/\n+/g, " ").trim();
  return {
    url: `local://${hit.collectionName}/${hit.fileName}#chunk${hit.chunkIndex}`,
    title: `${hit.fileName} (${hit.collectionName})`,
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
  const text = hit.text.slice(0, contentLimit);
  return {
    url: `local://${hit.collectionName}/${hit.fileName}#chunk${hit.chunkIndex}`,
    finalUrl: `local://${hit.collectionName}/${hit.fileName}#chunk${hit.chunkIndex}`,
    title: `${hit.fileName} (${hit.collectionName})`,
    description: text.slice(0, 250).replace(/\n+/g, " ").trim(),
    published: null,
    text,
    wordCount: hit.wordCount,
    outlinks: [],
    sourceQuery: query,
    workerRole: role,
    workerLabel: label,
    domainScore: LOCAL_DOMAIN_SCORE,
    freshnessScore: LOCAL_FRESHNESS_SCORE,
    tier: LOCAL_TIER,
    relevanceScore: Math.min(1, hit.score * 2),
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

  const perQuery = Math.max(3, Math.ceil(maxTotal / queries.length));
  const seen = new Set<string>();
  const sources: CrawledSource[] = [];

  for (const query of queries) {
    if (sources.length >= maxTotal) break;

    const targetIds = roleCollectionMap?.get(role) ?? collectionIds;
    const hits = store.search(query, perQuery, targetIds);

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
