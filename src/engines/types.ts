/**
 * @file engines/types.ts
 * SearchEngine contract.
 */
import type { SearchHit, SearchScope, EngineId } from "../core/types";

export interface SearchEngine {
  readonly id: EngineId;
  readonly scopes: ReadonlyArray<SearchScope>;
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]>;
}
