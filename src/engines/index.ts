/**
 * @file engines/index.ts
 * Engine selection by scope. Order: APIs first; user's SearXNG instance (if
 * configured) leads general scope; raw scrapers last.
 */
import type { EngineId, SearchScope } from "../core/types";
import type { SearchEngine } from "./types";
import { wikipediaEngine } from "./wikipedia";
import { openAlexEngine } from "./openalex";
import { arxivEngine } from "./arxiv";
import { ddgEngine } from "./ddg";
import { braveEngine } from "./brave";
import { searxngEngine, getSearxngEndpoint } from "./searxng";

const ENGINES: ReadonlyArray<SearchEngine> = [
  wikipediaEngine,
  openAlexEngine,
  arxivEngine,
  searxngEngine,
  ddgEngine,
  braveEngine,
];

function isApiEngine(id: EngineId): boolean {
  return id === "wikipedia" || id === "openalex" || id === "arxiv";
}

/** Engines that serve a scope, in preference order. */
export function enginesForScope(scope: SearchScope): ReadonlyArray<SearchEngine> {
  const apiScoped = ENGINES.filter(
    (e) => e.scopes.includes(scope) && isApiEngine(e.id),
  );
  if (scope !== "general") return apiScoped;

  const searxng = getSearxngEndpoint() !== null ? [searxngEngine] : [];
  return [...apiScoped, ...searxng, ddgEngine, braveEngine];
}

export {
  wikipediaEngine,
  openAlexEngine,
  arxivEngine,
  searxngEngine,
  ddgEngine,
  braveEngine,
};
export type { SearchEngine } from "./types";
