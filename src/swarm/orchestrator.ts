/**
 * @file swarm/orchestrator.ts
 * The swarm orchestrator: decomposes a research topic into parallel
 * workers, runs them simultaneously, and aggregates results.
 */

import { runWorker, SharedCrawlState } from "./worker";
import {
  buildQueryPlan,
  buildAdaptiveGapFill,
  summariseFindings,
} from "../planning/planner";
import { detectCoveredDimensions } from "../planning/dimensions";
import {
  ResearchConfig,
  SwarmTask,
  WorkerResult,
  CrawledSource,
  WorkerRole,
  DynamicWorkerSpec,
  AgentMessage,
  StatusFn,
  WarnFn,
} from "../types";

class MutableCrawlState implements SharedCrawlState {
  private readonly _visitedUrls = new Set<string>();
  private readonly _contentHashes = new Set<string>();
  private readonly _domainCounts = new Map<string, number>();

  get visitedUrls(): ReadonlySet<string> {
    return this._visitedUrls;
  }
  get contentHashes(): ReadonlySet<string> {
    return this._contentHashes;
  }
  get domainCounts(): ReadonlyMap<string, number> {
    return this._domainCounts;
  }

  addVisited(url: string): void {
    this._visitedUrls.add(url);
  }
  addHash(hash: string): void {
    this._contentHashes.add(hash);
  }

  incrementDomain(url: string): void {
    const host = safeHostname(url);
    if (host)
      this._domainCounts.set(host, (this._domainCounts.get(host) ?? 0) + 1);
  }

  domainCount(url: string): number {
    return this._domainCounts.get(safeHostname(url)) ?? 0;
  }
}

function buildDynamicTask(
  spec: DynamicWorkerSpec,
  totalBudget: number,
  cfg: ResearchConfig,
): SwarmTask {
  const pageBudget = Math.max(2, Math.round(totalBudget * spec.budgetWeight));
  return {
    id: `${spec.role}-${spec.label.slice(0, 20)}-${Date.now()}`,
    role: spec.role,
    label: spec.label,
    queries: spec.queries,
    pageBudget,
    contentLimit: cfg.contentLimitPerPage,
    followLinks: cfg.enableLinkFollowing && spec.followLinks,
    safeSearch: cfg.safeSearch,
    preferredTiers: spec.preferredTiers,
  };
}

/**
 * Build a task from a static worker role (fallback path).
 */
function buildStaticTask(
  role: WorkerRole,
  queries: ReadonlyArray<string>,
  totalBudget: number,
  cfg: ResearchConfig,
): SwarmTask {
  const budgetWeights: Readonly<Record<WorkerRole, number>> = {
    breadth: 0.25,
    depth: 0.25,
    recency: 0.18,
    academic: 0.2,
    critical: 0.12,
  };

  const roleLabels: Readonly<Record<WorkerRole, string>> = {
    breadth: "Breadth",
    depth: "Depth",
    recency: "Recency",
    academic: "Academic",
    critical: "Critical",
  };

  const pageBudget = Math.max(2, Math.round(totalBudget * budgetWeights[role]));

  const preferredTiers: Readonly<
    Record<WorkerRole, ReadonlyArray<import("../types").SourceTier> | undefined>
  > = {
    breadth: undefined,
    depth: undefined,
    recency: undefined,
    academic: ["academic", "government", "reference"],
    critical: undefined,
  };

  return {
    id: `${role}-${Date.now()}`,
    role,
    label: roleLabels[role],
    queries,
    pageBudget,
    contentLimit: cfg.contentLimitPerPage,
    followLinks:
      cfg.enableLinkFollowing && (role === "depth" || role === "academic"),
    safeSearch: cfg.safeSearch,
    preferredTiers: preferredTiers[role],
  };
}

export interface OrchestratorResult {
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly workerErrors: ReadonlyArray<string>;
  readonly usedAI: boolean;
  readonly topicKeywords: ReadonlyArray<string>;
}

export async function runSwarm(
  cfg: ResearchConfig,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  const state = new MutableCrawlState();
  const allSources: CrawledSource[] = [];
  const allQueries: string[] = [];
  const allErrors: string[] = [];
  let usedAI = false;

  status(`\n Launching swarm for: "${cfg.topic}"`);

  const plan = await buildQueryPlan(
    cfg.topic,
    cfg.focusAreas,
    cfg.enableAIPlanning,
    status,
  );
  usedAI = plan.usedAI;

  let round1Tasks: ReadonlyArray<SwarmTask>;

  if (plan.dynamicSpecs && plan.dynamicSpecs.length >= 3) {
    status(
      `\n ${plan.dynamicSpecs.length} AI-decomposed workers launching in parallel…`,
    );
    round1Tasks = plan.dynamicSpecs.map((spec) =>
      buildDynamicTask(spec, cfg.maxSourcesTotal, cfg),
    );
  } else {
    const roles: ReadonlyArray<WorkerRole> = [
      "breadth",
      "depth",
      "recency",
      "academic",
      "critical",
    ];
    status(`\n All ${roles.length} workers launching in parallel…`);
    round1Tasks = roles.map((role) =>
      buildStaticTask(role, plan.queriesByRole[role], cfg.maxSourcesTotal, cfg),
    );
  }

  const round1Results = await Promise.all(
    round1Tasks.map((task) =>
      runWorker(task, state, signal, status, warn, plan.topicKeywords).catch(
        (err) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            warn(
              `Worker ${task.label} crashed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return {
            taskId: task.id,
            role: task.role,
            label: task.label,
            sources: [] as CrawledSource[],
            queries: [] as string[],
            errors: [String(err)],
          } satisfies WorkerResult;
        },
      ),
    ),
  );

  aggregateResults(round1Results, allSources, allQueries, allErrors);

  status(
    `\n Round 1 complete — ${allSources.length}/${cfg.maxSourcesTotal} sources from ${round1Tasks.length} parallel workers`,
  );

  let priorMessages: ReadonlyArray<AgentMessage> = [];
  if (cfg.depthRounds > 1 && cfg.enableAIPlanning) {
    status(`\n Summarising Round 1 findings for gap-fill workers…`);
    priorMessages = await summariseFindings(
      allSources,
      cfg.topic,
      cfg.enableAIPlanning,
      status,
    );
  }

  for (let round = 2; round <= cfg.depthRounds; round++) {
    if (signal.aborted) break;
    if (allSources.length >= cfg.maxSourcesTotal) break;

    status(`\n Analysing coverage gaps for round ${round}…`);
    const coveredIds = detectCoveredDimensions(allSources.map((s) => s.text));

    const gapPlans = await buildAdaptiveGapFill(
      cfg.topic,
      coveredIds,
      priorMessages,
      cfg.enableAIPlanning,
      status,
    );

    if (gapPlans.length === 0) {
      status("Research coverage is comprehensive, stopping early");
      break;
    }

    const roundName = round === 2 ? "Follow-up" : "Deep-dive";
    status(
      `\n ${roundName} round — ${gapPlans.length} targeted gap-fill worker(s)…`,
    );

    const remainingBudget = cfg.maxSourcesTotal - allSources.length;
    const budgetPerWorker = Math.max(
      2,
      Math.floor(remainingBudget / gapPlans.length),
    );

    const gapResults = await Promise.all(
      gapPlans.map((plan) => {
        const task: SwarmTask = {
          id: `gap-${plan.role}-${Date.now()}`,
          role: plan.role,
          label: plan.label,
          queries: plan.queries,
          pageBudget: budgetPerWorker,
          contentLimit: cfg.contentLimitPerPage,
          followLinks: cfg.enableLinkFollowing && plan.followLinks,
          safeSearch: cfg.safeSearch,
          preferredTiers: plan.preferredTiers,
        };

        return runWorker(task, state, signal, status, warn, plan.queries).catch(
          (err) =>
            ({
              taskId: task.id,
              role: task.role,
              label: task.label,
              sources: [] as CrawledSource[],
              queries: [] as string[],
              errors: [String(err)],
            }) satisfies WorkerResult,
        );
      }),
    );

    aggregateResults(gapResults, allSources, allQueries, allErrors);

    status(`Round ${round} done — ${allSources.length} total sources`);
  }

  return {
    sources: allSources,
    queriesUsed: [...new Set(allQueries)],
    workerErrors: allErrors,
    usedAI,
    topicKeywords: plan.topicKeywords,
  };
}

function aggregateResults(
  results: ReadonlyArray<WorkerResult>,
  sources: CrawledSource[],
  queries: string[],
  errors: string[],
): void {
  for (const result of results) {
    sources.push(...result.sources);
    queries.push(...result.queries);
    errors.push(...result.errors);
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
