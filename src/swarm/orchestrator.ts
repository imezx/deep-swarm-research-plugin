/**
 * @file swarm/orchestrator.ts
 * The swarm orchestrator with:
 * - Worker fan-out: each role spawns N sub-workers in parallel
 * - Multi-lane DDG rate limiters: true parallel search across lanes
 * - 10 specialized worker roles (up from 5)
 * - Adaptive collection with stagnation + coverage termination
 */

import { runWorker, SharedCrawlState } from "./worker";
import {
  buildQueryPlan,
  buildAdaptiveGapFill,
  summariseFindings,
} from "../planning/planner";
import { detectCoveredDimensions, DIMENSIONS } from "../planning/dimensions";
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
import { DepthProfile } from "../constants";
import { DdgRateLimiter, DdgLimiterPool, resetThrottle } from "../net/ddg";

class MutableCrawlState implements SharedCrawlState {
  private readonly _visitedUrls = new Set<string>();
  private readonly _contentHashes = new Set<string>();
  private readonly _domainCounts = new Map<string, number>();
  private readonly _discoveries: Array<{
    url: string;
    title: string;
    fromWorker: string;
  }> = [];

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

  pushDiscovery(url: string, title: string, fromWorker: string): void {
    if (!this._visitedUrls.has(url)) {
      this._discoveries.push({ url, title, fromWorker });
    }
  }

  drainDiscoveries(
    limit: number,
  ): ReadonlyArray<{ url: string; title: string }> {
    const results: Array<{ url: string; title: string }> = [];
    while (results.length < limit && this._discoveries.length > 0) {
      const item = this._discoveries.shift()!;
      if (!this._visitedUrls.has(item.url)) {
        results.push({ url: item.url, title: item.title });
      }
    }
    return results;
  }
}

/** Core roles always used. */
const CORE_ROLES: ReadonlyArray<WorkerRole> = [
  "breadth",
  "depth",
  "recency",
  "academic",
  "critical",
];

/** Extended roles added for deep/deeper/exhaustive presets. */
const EXTENDED_ROLES: ReadonlyArray<WorkerRole> = [
  "statistical",
  "regulatory",
  "technical",
  "primary",
  "comparative",
];

const ROLE_LABELS: Readonly<Record<WorkerRole, string>> = {
  breadth: "Breadth",
  depth: "Depth",
  recency: "Recency",
  academic: "Academic",
  critical: "Critical",
  statistical: "Statistical/Data",
  regulatory: "Regulatory/Policy",
  technical: "Technical Deep-Dive",
  primary: "Primary Sources",
  comparative: "Comparative Analysis",
};

function rolesForProfile(profile: DepthProfile): ReadonlyArray<WorkerRole> {
  if (profile.depthRounds >= 10) return [...CORE_ROLES, ...EXTENDED_ROLES];
  if (profile.depthRounds >= 5)
    return [...CORE_ROLES, "technical", "comparative", "statistical"];
  return [...CORE_ROLES];
}

function buildTaskBase(
  profile: DepthProfile,
  cfg: ResearchConfig,
): Pick<
  SwarmTask,
  | "contentLimit"
  | "safeSearch"
  | "searchResultsPerQuery"
  | "maxPagesPerDomain"
  | "maxLinksToEvaluate"
  | "maxLinksToFollow"
  | "candidatePoolMultiplier"
  | "workerConcurrency"
  | "minRelevanceScore"
  | "maxOutlinksPerPage"
  | "searchPages"
  | "extraEngines"
  | "linkCrawlDepth"
  | "queryMutationThreshold"
> {
  return {
    contentLimit: cfg.contentLimitPerPage,
    safeSearch: cfg.safeSearch,
    searchResultsPerQuery: profile.searchResultsPerQuery,
    maxPagesPerDomain: profile.maxPagesPerDomain,
    maxLinksToEvaluate: profile.maxLinksToEvaluate,
    maxLinksToFollow: profile.maxLinksToFollow,
    candidatePoolMultiplier: profile.candidatePoolMultiplier,
    workerConcurrency: profile.workerConcurrency,
    minRelevanceScore: profile.minRelevanceScore,
    maxOutlinksPerPage: profile.maxOutlinksPerPage,
    searchPages: profile.searchPages,
    extraEngines: profile.extraEngines,
    linkCrawlDepth: profile.linkCrawlDepth,
    queryMutationThreshold: profile.queryMutationThreshold,
  };
}

function buildDynamicTask(
  spec: DynamicWorkerSpec,
  profile: DepthProfile,
  cfg: ResearchConfig,
  subIdx: number = 0,
): SwarmTask {
  const proportional = Math.round(
    profile.pageBudgetPerWorker * spec.budgetWeight * 2,
  );
  const minBudget = Math.ceil(profile.pageBudgetPerWorker / 2);
  return {
    ...buildTaskBase(profile, cfg),
    id: `${spec.role}-${spec.label.slice(0, 20)}-s${subIdx}-${Date.now()}`,
    role: spec.role,
    label: subIdx > 0 ? `${spec.label} #${subIdx + 1}` : spec.label,
    queries: spec.queries,
    pageBudget: Math.max(proportional, minBudget),
    followLinks: cfg.enableLinkFollowing && spec.followLinks,
    preferredTiers: spec.preferredTiers,
  };
}

function buildStaticTask(
  role: WorkerRole,
  queries: ReadonlyArray<string>,
  profile: DepthProfile,
  cfg: ResearchConfig,
  subIdx: number = 0,
): SwarmTask {
  const followRoles: ReadonlyArray<WorkerRole> = [
    "depth",
    "academic",
    "technical",
    "primary",
  ];
  const academicTiers = ["academic", "government", "reference"] as const;
  return {
    ...buildTaskBase(profile, cfg),
    id: `${role}-s${subIdx}-${Date.now()}`,
    role,
    label:
      subIdx > 0 ? `${ROLE_LABELS[role]} #${subIdx + 1}` : ROLE_LABELS[role],
    queries,
    pageBudget: profile.pageBudgetPerWorker,
    followLinks: cfg.enableLinkFollowing && followRoles.includes(role),
    preferredTiers:
      role === "academic" || role === "regulatory" ? academicTiers : undefined,
  };
}

function fanOutQueries(
  queries: ReadonlyArray<string>,
  fanOut: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (fanOut <= 1 || queries.length <= 2) return [queries];

  const groups: string[][] = [];
  for (let i = 0; i < fanOut; i++) groups.push([]);

  for (let i = 0; i < queries.length; i++) {
    groups[i % fanOut].push(queries[i]);
  }

  return groups.filter((g) => g.length > 0);
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
  profile: DepthProfile,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  const state = new MutableCrawlState();
  const allSources: CrawledSource[] = [];
  const allQueries: string[] = [];
  const allErrors: string[] = [];
  let usedAI = false;

  resetThrottle();

  const pool = new DdgLimiterPool(profile.searchLanes, profile.ddgRateLimitMs);

  status(
    `\n Launching swarm for: "${cfg.topic}" [${cfg.depthPreset} — ` +
      `${profile.depthRounds} rounds, ${profile.pageBudgetPerWorker} pages/worker, ` +
      `${profile.searchLanes} search lanes, fan-out ×${profile.workerFanOut}]`,
  );

  const plan = await buildQueryPlan(
    cfg.topic,
    cfg.focusAreas,
    cfg.enableAIPlanning,
    status,
    profile,
  );
  usedAI = plan.usedAI;

  let round1Tasks: SwarmTask[] = [];

  if (plan.dynamicSpecs && plan.dynamicSpecs.length >= 3) {
    for (const spec of plan.dynamicSpecs) {
      if (profile.workerFanOut > 1 && spec.queries.length > 2) {
        const queryGroups = fanOutQueries(spec.queries, profile.workerFanOut);
        for (let si = 0; si < queryGroups.length; si++) {
          const subSpec = { ...spec, queries: queryGroups[si] };
          round1Tasks.push(buildDynamicTask(subSpec, profile, cfg, si));
        }
      } else {
        round1Tasks.push(buildDynamicTask(spec, profile, cfg));
      }
    }
    status(
      `\n ${round1Tasks.length} AI-decomposed workers (with fan-out) launching in parallel…`,
    );
  } else {
    const roles = rolesForProfile(profile);
    for (const role of roles) {
      const roleQueries = plan.queriesByRole[role] ?? [];
      if (roleQueries.length === 0) continue;

      if (profile.workerFanOut > 1 && roleQueries.length > 2) {
        const queryGroups = fanOutQueries(roleQueries, profile.workerFanOut);
        for (let si = 0; si < queryGroups.length; si++) {
          round1Tasks.push(
            buildStaticTask(role, queryGroups[si], profile, cfg, si),
          );
        }
      } else {
        round1Tasks.push(buildStaticTask(role, roleQueries, profile, cfg));
      }
    }
    status(
      `\n ${round1Tasks.length} workers (${rolesForProfile(profile).length} roles × fan-out) launching in parallel…`,
    );
  }

  const round1Results = await Promise.all(
    round1Tasks.map((task, idx) => {
      const limiter = pool.next();
      return runWorker(
        task,
        state,
        signal,
        status,
        warn,
        plan.topicKeywords,
        limiter,
      ).catch((err) => {
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
      });
    }),
  );

  aggregateResults(round1Results, allSources, allQueries, allErrors);

  status(
    `\n Round 1 complete — ${allSources.length} sources from ${round1Tasks.length} parallel workers`,
  );

  let priorMessages: ReadonlyArray<AgentMessage> = [];
  if (profile.depthRounds > 1 && cfg.enableAIPlanning) {
    status(`\n Summarising Round 1 findings for gap-fill workers…`);
    priorMessages = await summariseFindings(
      allSources,
      cfg.topic,
      cfg.enableAIPlanning,
      status,
    );
  }

  let consecutiveStagnant = 0;

  for (let round = 2; round <= profile.depthRounds; round++) {
    if (signal.aborted) break;

    const coveredIds = detectCoveredDimensions(allSources.map((s) => s.text));
    if (coveredIds.length >= DIMENSIONS.length) {
      status(
        `\n All ${DIMENSIONS.length} research dimensions covered — stopping early at round ${round}`,
      );
      break;
    }

    status(
      `\n Analysing coverage gaps for round ${round} (${coveredIds.length}/${DIMENSIONS.length} dimensions covered)…`,
    );

    const gapPlans = await buildAdaptiveGapFill(
      cfg.topic,
      coveredIds,
      priorMessages,
      cfg.enableAIPlanning,
      status,
      profile,
    );

    if (gapPlans.length === 0) {
      status("Research coverage is comprehensive, stopping early");
      break;
    }

    const roundName =
      round <= 2 ? "Follow-up" : round <= 5 ? "Deep-dive" : "Exhaustive";
    status(
      `\n ${roundName} round ${round} — ${gapPlans.length} targeted gap-fill worker(s), ` +
        `${profile.pageBudgetPerGapWorker} pages each…`,
    );

    const sourcesBefore = allSources.length;

    const gapTasks: SwarmTask[] = [];
    for (const gapPlan of gapPlans) {
      gapTasks.push({
        ...buildTaskBase(profile, cfg),
        id: `gap-${gapPlan.role}-r${round}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: gapPlan.role,
        label: gapPlan.label,
        queries: gapPlan.queries,
        pageBudget: profile.pageBudgetPerGapWorker,
        followLinks: cfg.enableLinkFollowing && gapPlan.followLinks,
        preferredTiers: gapPlan.preferredTiers,
      });
    }

    const gapResults = await Promise.all(
      gapTasks.map((task) => {
        const limiter = pool.next();
        return runWorker(
          task,
          state,
          signal,
          status,
          warn,
          task.queries,
          limiter,
        ).catch(
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

    const newSources = allSources.length - sourcesBefore;
    status(
      `Round ${round} done — ${newSources} new sources this round, ${allSources.length} total`,
    );

    if (newSources === 0) {
      consecutiveStagnant++;
      if (consecutiveStagnant >= profile.stagnationThreshold) {
        status(
          `\n ${consecutiveStagnant} consecutive round(s) with no new sources — stopping (stagnation)`,
        );
        break;
      }
    } else {
      consecutiveStagnant = 0;
    }

    if (newSources > 0 && round < profile.depthRounds && cfg.enableAIPlanning) {
      priorMessages = await summariseFindings(
        allSources,
        cfg.topic,
        cfg.enableAIPlanning,
        status,
      );
    }
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
