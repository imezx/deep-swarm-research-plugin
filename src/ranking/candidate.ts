/**
 * @file ranking/candidate.ts
 * Combines authority + freshness into a single candidate priority used by
 * the frontier. Higher = fetch first.
 */
import type { SearchHit } from "../core/types";
import { assessCandidate } from "./authority";

export interface RankedCandidate {
  readonly hit: SearchHit;
  readonly authorityScore: number;
  readonly tier: import("../core/types").SourceTier;
  readonly freshnessScore: number;
  readonly priority: number;
}

const AUTHORITY_WEIGHT = 0.55;
const FRESHNESS_WEIGHT = 0.25;
/** Engine trust bump: APIs are exact, scrapes are noisier. */
const ENGINE_TRUST: Readonly<Record<string, number>> = {
  wikipedia: 8,
  openalex: 7,
  arxiv: 7,
  ddg: 0,
  brave: 0,
};

export function rankCandidate(hit: SearchHit): RankedCandidate {
  const { authorityScore, tier, freshnessScore } = assessCandidate(
    hit.url,
    hit.published,
    `${hit.title} ${hit.snippet}`,
  );
  const priority =
    Math.round(
      authorityScore * AUTHORITY_WEIGHT +
      freshnessScore * FRESHNESS_WEIGHT +
      (ENGINE_TRUST[hit.engine] ?? 0),
    );
  return { hit, authorityScore, tier, freshnessScore, priority };
}
