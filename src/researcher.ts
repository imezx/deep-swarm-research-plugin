/**
 * @file researcher.ts
 * Top-level entry point for the deep research engine.
 * Connects the swarm orchestrator to the report builder.
 */

import { runSwarm } from "./swarm/orchestrator";
import { buildReport } from "./report/builder";
import { ResearchConfig, ResearchResult, StatusFn, WarnFn } from "./types";

/**
 * Runs a complete deep research session using the swarm architecture.
 */
export async function runDeepResearch(
  cfg: ResearchConfig,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<ResearchResult> {
  const swarmResult = await runSwarm(cfg, status, warn, signal);

  if (signal.aborted && swarmResult.sources.length === 0) {
    return {
      report: {
        markdown: "Research was cancelled before any sources were collected.",
        sources: [],
        topicKeywords: [],
        coveredDims: [],
        gapDims: [],
        contradictions: [],
      },
      queriesUsed: swarmResult.queriesUsed,
      totalSources: 0,
      totalRounds: 0,
    };
  }

  status("\n Building research report…");

  const report = await buildReport(
    cfg.topic,
    swarmResult.sources,
    swarmResult.queriesUsed,
    swarmResult.topicKeywords,
    cfg.depthRounds,
    swarmResult.usedAI,
    cfg.enableAIPlanning,
    status,
  );

  status(
    `Report ready — ${swarmResult.sources.length} sources, ${swarmResult.queriesUsed.length} queries`,
  );

  return {
    report,
    queriesUsed: swarmResult.queriesUsed,
    totalSources: swarmResult.sources.length,
    totalRounds: cfg.depthRounds,
  };
}
