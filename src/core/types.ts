/**
 * @file core/types.ts
 * All shared contracts. Single source of truth — no duplicate type shapes.
 */

export type SourceOrigin = "web" | "local";
export type SearchScope = "reference" | "academic" | "general";
export type EngineId = "wikipedia" | "openalex" | "arxiv" | "searxng" | "ddg" | "brave";

export interface SearchHit {
  readonly engine: EngineId;
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly published: string | null;
  /** Pre-fetched full text (API engines return text directly). */
  readonly text?: string;
}

export type SourceTier =
  | "academic"
  | "government"
  | "reference"
  | "news"
  | "professional"
  | "general"
  | "low";


export interface Outlink {
  readonly text: string;
  readonly href: string;
}

/** A fully extracted web page ready for inclusion in the corpus. */
export interface CrawledSource {
  readonly index: number;
  readonly url: string;
  readonly finalUrl?: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
  readonly authorityScore: number;
  readonly origin: SourceOrigin;
  readonly engine: EngineId | "local";
  /** Which query/angle surfaced this source. */
  readonly discoveredBy: string;
}

/* ---------------- planner contracts ---------------- */

export interface WorkerSpec {
  readonly role: string;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly scope: SearchScope;
}

export interface ResearchPlan {
  readonly specs: ReadonlyArray<WorkerSpec>;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly usedAI: boolean;
}

/* ---------------- config / result ---------------- */

export interface DepthProfile {
  readonly depthRounds: number;
  readonly pagesPerCrawlerRound: number;
  readonly maxQueriesPerSpec: number;
  readonly queriesPerGapDimension: number;
  readonly crawlerCount: number;
  readonly searchResultsPerQuery: number;
  readonly minRelevanceScore: number;
  readonly synthesisMaxSources: number;
  readonly synthesisSourceChars: number;
  readonly synthesisMaxTokens: number;
  readonly contentPerPage: number; // chars per page, scaled
}

export type DepthPreset =
  | "shallow" | "standard" | "deep" | "deeper" | "exhaustive";

export interface ResearchConfig {
  readonly topic: string;
  readonly focusAreas: ReadonlyArray<string>;
  readonly depthPreset: DepthPreset;
  /** Chars per page; null ⇒ use profile's scaled default ("Auto"). */
  readonly contentLimitPerPage: number | null;
  readonly enableLinkFollowing: boolean;
  readonly enableAIPlanning: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";
  readonly enableLocalSources: boolean;
  /** Wall-clock limit for the whole run; null/0 ⇒ unlimited. */
  readonly timeoutMs: number | null;
}

export interface ContradictionEntry {
  readonly claim: string;
  readonly sourceA: { index: number; title: string; stance: string };
  readonly sourceB: { index: number; title: string; stance: string };
  readonly severity: "minor" | "moderate" | "major";
}

export interface CompiledReport {
  readonly markdown: string;
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly coveredDims: ReadonlyArray<string>;
  readonly gapDims: ReadonlyArray<string>;
  readonly aiSynthesis?: string;
  readonly contradictions: ReadonlyArray<ContradictionEntry>;
}

export interface ResearchResult {
  readonly report: CompiledReport;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly totalSources: number;
  readonly roundsRun: number;
}

export type StatusFn = (message: string) => void;
export type WarnFn = (message: string) => void;

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}
