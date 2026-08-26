/**
 * @file depth-profiles.ts
 * The five depth presets. Every tuning knob lives here — nothing scattered.
 */
import type { DepthProfile, DepthPreset } from "./core/types";

export const DEPTH_PROFILES: Readonly<Record<DepthPreset, DepthProfile>> = {
  shallow: {
    depthRounds: 1,
    pagesPerCrawlerRound: 8,
    contentPerPage: 5_000,
    maxQueriesPerSpec: 3,
    queriesPerGapDimension: 2,
    crawlerCount: 2,
    searchResultsPerQuery: 6,
    minRelevanceScore: 0.14,
    synthesisMaxSources: 15,
    synthesisSourceChars: 700,
    synthesisMaxTokens: 2_500,
  },
  standard: {
    depthRounds: 3,
    pagesPerCrawlerRound: 12,
    contentPerPage: 6_000,
    maxQueriesPerSpec: 4,
    queriesPerGapDimension: 2,
    crawlerCount: 3,
    searchResultsPerQuery: 8,
    minRelevanceScore: 0.12,
    synthesisMaxSources: 25,
    synthesisSourceChars: 650,
    synthesisMaxTokens: 3_500,
  },
  deep: {
    depthRounds: 5,
    pagesPerCrawlerRound: 16,
    contentPerPage: 8_000,
    maxQueriesPerSpec: 5,
    queriesPerGapDimension: 3,
    crawlerCount: 3,
    searchResultsPerQuery: 10,
    minRelevanceScore: 0.10,
    synthesisMaxSources: 35,
    synthesisSourceChars: 600,
    synthesisMaxTokens: 4_500,
  },
  deeper: {
    depthRounds: 10,
    pagesPerCrawlerRound: 20,
    contentPerPage: 12_000,
    maxQueriesPerSpec: 6,
    queriesPerGapDimension: 3,
    crawlerCount: 4,
    searchResultsPerQuery: 12,
    minRelevanceScore: 0.08,
    synthesisMaxSources: 50,
    synthesisSourceChars: 550,
    synthesisMaxTokens: 5_500,
  },
  exhaustive: {
    depthRounds: 15,
    pagesPerCrawlerRound: 24,
    contentPerPage: 16_000,
    maxQueriesPerSpec: 7,
    queriesPerGapDimension: 4,
    crawlerCount: 4,
    searchResultsPerQuery: 15,
    minRelevanceScore: 0.06,
    synthesisMaxSources: 60,
    synthesisSourceChars: 500,
    synthesisMaxTokens: 6_500,
  },
};

export function getDepthProfile(preset: DepthPreset): DepthProfile {
  return DEPTH_PROFILES[preset];
}
