/**
 * @file constants.ts
 * All named constants used across the plugin.
 */
export type DepthPreset =
  | "shallow"
  | "standard"
  | "deep"
  | "deeper"
  | "exhaustive";

export interface DepthProfile {
  readonly depthRounds: number;
  readonly pageBudgetPerWorker: number;
  readonly pageBudgetPerGapWorker: number;
  readonly defaultContentLimit: number;
  readonly searchResultsPerQuery: number;
  readonly maxQueriesPerWorker: number;
  readonly maxPagesPerDomain: number;
  readonly maxLinksToEvaluate: number;
  readonly maxLinksToFollow: number;
  readonly maxOutlinksPerPage: number;
  readonly candidatePoolMultiplier: number;
  readonly workerConcurrency: number;
  readonly maxDecompositionWorkers: number;
  readonly maxGapFillQueries: number;
  readonly ddgRateLimitMs: number;
  readonly minRelevanceScore: number;
  readonly synthesisMaxSources: number;
  readonly synthesisSourceChars: number;
  readonly synthesisMaxTokens: number;
  readonly contradictionMaxSources: number;
  readonly stagnationThreshold: number;
  readonly searchPages: number;
  readonly searchLanes: number;
  readonly workerFanOut: number;
  readonly extraEngines: ReadonlyArray<string>;
  readonly linkCrawlDepth: number;
  readonly queryMutationThreshold: number;
}

export const DEPTH_PROFILES: Readonly<Record<DepthPreset, DepthProfile>> = {
  shallow: {
    depthRounds: 1,
    pageBudgetPerWorker: 5,
    pageBudgetPerGapWorker: 4,
    defaultContentLimit: 5_000,
    searchResultsPerQuery: 8,
    maxQueriesPerWorker: 4,
    maxPagesPerDomain: 3,
    maxLinksToEvaluate: 30,
    maxLinksToFollow: 3,
    maxOutlinksPerPage: 30,
    candidatePoolMultiplier: 3,
    workerConcurrency: 3,
    maxDecompositionWorkers: 6,
    maxGapFillQueries: 5,
    ddgRateLimitMs: 2_200,
    minRelevanceScore: 0.15,
    synthesisMaxSources: 20,
    synthesisSourceChars: 600,
    synthesisMaxTokens: 3_000,
    contradictionMaxSources: 15,
    stagnationThreshold: 1,
    searchPages: 1,
    searchLanes: 2,
    workerFanOut: 1,
    extraEngines: [],
    linkCrawlDepth: 1,
    queryMutationThreshold: 2,
  },
  standard: {
    depthRounds: 3,
    pageBudgetPerWorker: 8,
    pageBudgetPerGapWorker: 6,
    defaultContentLimit: 6_000,
    searchResultsPerQuery: 10,
    maxQueriesPerWorker: 5,
    maxPagesPerDomain: 4,
    maxLinksToEvaluate: 50,
    maxLinksToFollow: 6,
    maxOutlinksPerPage: 40,
    candidatePoolMultiplier: 3,
    workerConcurrency: 3,
    maxDecompositionWorkers: 8,
    maxGapFillQueries: 6,
    ddgRateLimitMs: 2_000,
    minRelevanceScore: 0.13,
    synthesisMaxSources: 30,
    synthesisSourceChars: 600,
    synthesisMaxTokens: 4_000,
    contradictionMaxSources: 20,
    stagnationThreshold: 1,
    searchPages: 1,
    searchLanes: 2,
    workerFanOut: 1,
    extraEngines: ["brave"],
    linkCrawlDepth: 1,
    queryMutationThreshold: 2,
  },
  deep: {
    depthRounds: 5,
    pageBudgetPerWorker: 12,
    pageBudgetPerGapWorker: 10,
    defaultContentLimit: 8_000,
    searchResultsPerQuery: 15,
    maxQueriesPerWorker: 7,
    maxPagesPerDomain: 5,
    maxLinksToEvaluate: 60,
    maxLinksToFollow: 10,
    maxOutlinksPerPage: 60,
    candidatePoolMultiplier: 4,
    workerConcurrency: 4,
    maxDecompositionWorkers: 10,
    maxGapFillQueries: 8,
    ddgRateLimitMs: 1_800,
    minRelevanceScore: 0.1,
    synthesisMaxSources: 50,
    synthesisSourceChars: 500,
    synthesisMaxTokens: 5_000,
    contradictionMaxSources: 30,
    stagnationThreshold: 2,
    searchPages: 2,
    searchLanes: 3,
    workerFanOut: 2,
    extraEngines: ["brave", "searxng"],
    linkCrawlDepth: 2,
    queryMutationThreshold: 3,
  },
  deeper: {
    depthRounds: 10,
    pageBudgetPerWorker: 18,
    pageBudgetPerGapWorker: 14,
    defaultContentLimit: 12_000,
    searchResultsPerQuery: 18,
    maxQueriesPerWorker: 10,
    maxPagesPerDomain: 6,
    maxLinksToEvaluate: 80,
    maxLinksToFollow: 14,
    maxOutlinksPerPage: 80,
    candidatePoolMultiplier: 5,
    workerConcurrency: 5,
    maxDecompositionWorkers: 12,
    maxGapFillQueries: 10,
    ddgRateLimitMs: 1_500,
    minRelevanceScore: 0.08,
    synthesisMaxSources: 70,
    synthesisSourceChars: 450,
    synthesisMaxTokens: 6_500,
    contradictionMaxSources: 40,
    stagnationThreshold: 2,
    searchPages: 2,
    searchLanes: 4,
    workerFanOut: 2,
    extraEngines: ["brave", "scholar", "searxng"],
    linkCrawlDepth: 2,
    queryMutationThreshold: 3,
  },
  exhaustive: {
    depthRounds: 15,
    pageBudgetPerWorker: 25,
    pageBudgetPerGapWorker: 18,
    defaultContentLimit: 16_000,
    searchResultsPerQuery: 20,
    maxQueriesPerWorker: 12,
    maxPagesPerDomain: 8,
    maxLinksToEvaluate: 120,
    maxLinksToFollow: 18,
    maxOutlinksPerPage: 100,
    candidatePoolMultiplier: 6,
    workerConcurrency: 6,
    maxDecompositionWorkers: 14,
    maxGapFillQueries: 14,
    ddgRateLimitMs: 1_200,
    minRelevanceScore: 0.06,
    synthesisMaxSources: 100,
    synthesisSourceChars: 400,
    synthesisMaxTokens: 8_000,
    contradictionMaxSources: 60,
    stagnationThreshold: 3,
    searchPages: 3,
    searchLanes: 5,
    workerFanOut: 3,
    extraEngines: ["brave", "scholar", "searxng", "mojeek"],
    linkCrawlDepth: 3,
    queryMutationThreshold: 4,
  },
};

export function getDepthProfile(preset: DepthPreset): DepthProfile {
  return DEPTH_PROFILES[preset];
}

/** Milliseconds between DuckDuckGo requests (shared across all swarm workers). */
export const DDG_RATE_LIMIT_MS = 2_000;

/** Per-request fetch timeout in milliseconds. */
export const FETCH_TIMEOUT_MS = 15_000;

/** Image fetch timeout. */
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/** Max retry attempts for a single HTTP fetch. */
export const FETCH_MAX_RETRIES = 3;

/** Delay between fetch retries. */
export const FETCH_RETRY_DELAY_MS = 700;

/** Delay between page fetches within a worker batch (politeness). */
export const BATCH_INTER_FETCH_DELAY_MS = 300;

/** Timeout for cache/archive fallback attempts on bot-blocked pages. */
export const CACHE_FALLBACK_TIMEOUT_MS = 10_000;

/** Max concurrent page fetches per worker (default — overridden by depth profile). */
export const WORKER_CONCURRENCY = 3;

/** Max pages a single domain may contribute (default — overridden by depth profile). */
export const MAX_PAGES_PER_DOMAIN = 3;

/** Minimum word count for a page to be considered useful. */
export const MIN_USEFUL_WORD_COUNT = 50;

/** Max in-page links evaluated for link-following per worker per round. */
export const MAX_LINKS_TO_EVALUATE = 40;

/** Max links actually followed per worker (best-scored subset). */
export const MAX_LINKS_TO_FOLLOW = 4;

/** Minimum relevance score (0–1) for a fetched page to be kept. */
export const MIN_RELEVANCE_SCORE = 0.15;

/**
 * How many of the topic's keywords must appear in the page text (as fraction)
 * for the page to receive a base relevance score.
 */
export const RELEVANCE_KEYWORD_FRACTION = 0.25;

/** Bonus per title keyword match (added to relevance score). */
export const RELEVANCE_TITLE_BONUS = 0.15;

/** Bonus for snippet keyword match. */
export const RELEVANCE_SNIPPET_BONUS = 0.08;

/** Words sampled from the BEGINNING of the text for fingerprinting. */
export const FINGERPRINT_HEAD_WORDS = 30;

/** Words sampled from the MIDDLE of the text. */
export const FINGERPRINT_MID_WORDS = 20;

/** Words sampled from the END of the text. */
export const FINGERPRINT_TAIL_WORDS = 20;

/** Weight applied to domain authority score when computing total score. */
export const SCORE_WEIGHT_DOMAIN = 0.55;

/** Weight applied to URL quality score. */
export const SCORE_WEIGHT_URL_QUALITY = 0.25;

/** Weight applied to content freshness score. */
export const SCORE_WEIGHT_FRESHNESS = 0.2;

/** Minimum total score for a candidate to be fetched. */
export const MIN_CANDIDATE_SCORE = 12;

/** Minimum URL quality score for a candidate to be kept. */
export const MIN_URL_QUALITY = 8;

/** Score bonus per keyword match in link text (for link scoring). */
export const LINK_KEYWORD_BONUS = 20;

/** Max characters extracted per key sentence in report sections. */
export const MAX_SENTENCE_CHARS = 600;

/** Ideal sentence length for information density scoring. */
export const IDEAL_SENTENCE_LENGTH = 150;

/** Min source overlap fraction to consider a phrase "consensus". */
export const CONSENSUS_OVERLAP_FRACTION = 0.4;

/** Max consensus phrases to show in report. */
export const MAX_CONSENSUS_PHRASES = 10;

/** Max key sentences extracted per source per dimension. */
export const KEY_SENTENCES_PER_SOURCE = 3;

/** Max sources shown per dimension section in the report. */
export const MAX_SOURCES_PER_DIMENSION = 5;

/** Max characters of source text shown in the collapsible report preview. */
export const REPORT_SOURCE_PREVIEW_CHARS = 700;

/** Delay between batches in the Multi-Read tool (politeness). */
export const MULTI_READ_BATCH_DELAY_MS = 500;

/**
 * Minimum number of keyword hits required across all texts for a
 * dimension to count as "covered". Prevents single-mention false positives.
 */
export const DIMENSION_COVERAGE_MIN_HITS = 3;

/**
 * Minimum total characters of text containing dimension keywords
 * for the dimension to be considered meaningfully covered.
 */
export const DIMENSION_COVERAGE_MIN_CHARS = 200;

/** Max tokens for the AI synthesis of the final report. */
export const AI_SYNTHESIS_MAX_TOKENS = 3_000;

/** Temperature for AI synthesis (slightly creative for narrative). */
export const AI_SYNTHESIS_TEMPERATURE = 0.35;

/** Timeout for AI synthesis call. */
export const AI_SYNTHESIS_TIMEOUT_MS = 30_000;

/** Max chars of source text fed to the synthesis prompt (per source). */
export const SYNTHESIS_SOURCE_CHARS = 600;

/** Max total sources fed to synthesis (to avoid exceeding context). */
export const SYNTHESIS_MAX_SOURCES = 20;

/** Max tokens for AI contradiction detection call. */
export const AI_CONTRADICTION_MAX_TOKENS = 1_500;

/** Temperature for contradiction detection (factual). */
export const AI_CONTRADICTION_TEMPERATURE = 0.15;

/** Timeout for contradiction detection. */
export const AI_CONTRADICTION_TIMEOUT_MS = 15_000;

/** Max source summaries fed to contradiction prompt. */
export const CONTRADICTION_MAX_SOURCES = 15;

/** Chars per source for contradiction context. */
export const CONTRADICTION_SOURCE_CHARS = 400;

/** Timeout for AI model calls (query planning). */
export const AI_PLANNING_TIMEOUT_MS = 10_000;

/** Max tokens for AI planning response. */
export const AI_PLANNING_MAX_TOKENS = 500;

/** Temperature for AI planning calls. */
export const AI_PLANNING_TEMPERATURE = 0.4;

/** Min queries AI must return for the result to be accepted. */
export const AI_MIN_ACCEPTABLE_QUERIES = 4;

/** Min character length for a parsed AI query line to be accepted. */
export const QUERY_LINE_MIN_LEN = 5;

/** Max character length for a parsed AI query line to be accepted. */
export const QUERY_LINE_MAX_LEN = 160;

/** Max tokens for the AI task decomposition prompt. */
export const AI_DECOMPOSITION_MAX_TOKENS = 1_200;

/** Temperature for task decomposition. */
export const AI_DECOMPOSITION_TEMPERATURE = 0.3;

/** Timeout for task decomposition. */
export const AI_DECOMPOSITION_TIMEOUT_MS = 15_000;

/** Min workers the decomposer must output for the plan to be accepted. */
export const DECOMPOSITION_MIN_WORKERS = 3;

/** Max workers the decomposer can output. */
export const DECOMPOSITION_MAX_WORKERS = 8;

/** Max tokens for the inter-round findings summary. */
export const AI_FINDINGS_SUMMARY_MAX_TOKENS = 600;

/** Temperature for findings summary. */
export const AI_FINDINGS_SUMMARY_TEMPERATURE = 0.2;

/** Chars per source fed to the findings summariser. */
export const FINDINGS_SUMMARY_SOURCE_CHARS = 300;

/** Chars used for description fallback when no meta description is found. */
export const DESCRIPTION_FALLBACK_CHARS = 250;

/** Minimum text length from Readability for the result to be accepted. */
export const MIN_READABILITY_TEXT_LEN = 100;

/** Minimum character length of an outlink's anchor text to keep it. */
export const OUTLINK_TEXT_MIN_LEN = 3;

/** Maximum character length of an outlink's anchor text to keep it. */
export const OUTLINK_TEXT_MAX_LEN = 120;

export const DNS_RESOLVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"];

export const CONTENT_LIMIT_MIN = 1_000;
export const CONTENT_LIMIT_MAX = 20_000;
export const CONTENT_LIMIT_EXTENDED = 20_000;
export const CONTENT_LIMIT_DEFAULT = 4_000;
export const MAX_SOURCES_MIN = 5;
export const MAX_SOURCES_MAX = 200;
export const MAX_SOURCES_DEFAULT = 25;
export const SEARCH_RESULTS_MIN = 1;
export const SEARCH_RESULTS_MAX = 20;
export const SEARCH_RESULTS_DEFAULT = 10;
