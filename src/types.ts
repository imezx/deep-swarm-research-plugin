/**
 * @file types.ts
 * Shared TypeScript types for the entire plugin.
 */

/** A raw search result before scoring. */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** A fully extracted web page. */
export interface ExtractedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
}

export interface Outlink {
  readonly text: string;
  readonly href: string;
}

export type SourceTier =
  | "academic"
  | "government"
  | "reference"
  | "news"
  | "professional"
  | "general"
  | "low";

export interface ScoredCandidate {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly query: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly urlQuality: number;
  readonly totalScore: number;
  readonly tier: SourceTier;
}

export type WorkerRole =
  | "breadth"
  | "depth"
  | "recency"
  | "academic"
  | "critical"
  | "statistical"
  | "regulatory"
  | "technical"
  | "primary"
  | "comparative";

/**
 * The orchestrator generates custom worker specs tailored to each topic.
 */
export interface DynamicWorkerSpec {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly budgetWeight: number;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
}

/** A single unit of parallel work assigned to one swarm worker. */
export interface SwarmTask {
  readonly id: string;
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly pageBudget: number;
  readonly contentLimit: number;
  readonly followLinks: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
  readonly searchResultsPerQuery: number;
  readonly maxPagesPerDomain: number;
  readonly maxLinksToEvaluate: number;
  readonly maxLinksToFollow: number;
  readonly candidatePoolMultiplier: number;
  readonly workerConcurrency: number;
  readonly minRelevanceScore: number;
  readonly maxOutlinksPerPage: number;
  readonly searchPages: number;
  readonly extraEngines: ReadonlyArray<string>;
  readonly linkCrawlDepth: number;
  readonly queryMutationThreshold: number;
}

/** Result produced by a single swarm worker. */
export interface WorkerResult {
  readonly taskId: string;
  readonly role: WorkerRole;
  readonly label: string;
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queries: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

/** A crawled and extracted page, enriched with research metadata. */
export interface CrawledSource {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
  readonly sourceQuery: string;
  readonly workerRole: WorkerRole;
  readonly workerLabel: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
}

export interface AgentMessage {
  readonly fromWorker: string;
  readonly keyFindings: ReadonlyArray<string>;
  readonly suggestedFollowUps: ReadonlyArray<string>;
}

export interface ContradictionEntry {
  readonly claim: string;
  readonly sourceA: {
    readonly index: number;
    readonly title: string;
    readonly stance: string;
  };
  readonly sourceB: {
    readonly index: number;
    readonly title: string;
    readonly stance: string;
  };
  readonly severity: "minor" | "moderate" | "major";
}

export interface ResearchDimension {
  readonly id: string;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly queries: (topic: string) => ReadonlyArray<string>;
}

export interface QueryPlan {
  readonly queriesByRole: Readonly<Record<WorkerRole, ReadonlyArray<string>>>;
  readonly usedAI: boolean;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly dynamicSpecs?: ReadonlyArray<DynamicWorkerSpec>;
}

/** Adaptive gap-fill plan with targeted worker role per gap. */
export interface AdaptiveGapPlan {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
}

export interface ReportSource {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly sourceQuery: string;
  readonly workerRole: WorkerRole;
  readonly workerLabel: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
}

export interface CompiledReport {
  readonly markdown: string;
  readonly sources: ReadonlyArray<ReportSource>;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly coveredDims: ReadonlyArray<string>;
  readonly gapDims: ReadonlyArray<string>;
  readonly aiSynthesis?: string;
  readonly contradictions: ReadonlyArray<ContradictionEntry>;
}

export interface ResearchConfig {
  readonly topic: string;
  readonly focusAreas: ReadonlyArray<string>;
  readonly depthPreset: import("./constants").DepthPreset;
  readonly contentLimitPerPage: number;
  readonly enableLinkFollowing: boolean;
  readonly enableAIPlanning: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";
}

export interface ResearchResult {
  readonly report: CompiledReport;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly totalSources: number;
  readonly totalRounds: number;
}

export type StatusFn = (message: string) => void;
export type WarnFn = (message: string) => void;
