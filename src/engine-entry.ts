/**
 * @file engine-entry.ts
 * Top-level research session runner: orchestrator + report builder + ledger.
 *
 * Wall-clock deadline: an internal AbortController fires at timeoutMs; it
 * composes with the external tool-cancel signal so EVERY layer (engines,
 * fetcher, LLM streams, crawler loops) sees one abort. On deadline the run
 * stops immediately and partial results compile WITHOUT AI steps (fast exit).
 */
import type {
  ResearchConfig, ResearchResult, StatusFn, WarnFn,
} from "./core/types";
import { getDepthProfile } from "./depth-profiles";
import { runSwarm } from "./pipeline/orchestrator";
import { buildReport } from "./report/builder";

export async function runDeepResearch(
  cfg: ResearchConfig,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<ResearchResult> {
  const profile = getDepthProfile(cfg.depthPreset);

  // Compose external cancel + internal deadline into one signal.
  const internal = new AbortController();
  const onExternalAbort = () => internal.abort();
  signal.addEventListener("abort", onExternalAbort, { once: true });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (cfg.timeoutMs !== null && cfg.timeoutMs > 0) {
    timer = setTimeout(() => {
      status(`\nTime limit (${cfg.timeoutMs! >= 60_000 ? `${Math.round(cfg.timeoutMs! / 60_000)} min` : `${Math.round(cfg.timeoutMs! / 1000)} s`}) reached — stopping and compiling what we have…`);
      internal.abort();
    }, cfg.timeoutMs);
  }

  try {
    const { sources, queriesUsed, ledger, learnings, usedAI } =
      await runSwarm(cfg, profile, status, warn, internal.signal);

    if (timer !== null) clearTimeout(timer);

    const report = await buildReport(
      cfg.topic,
      sources,
      queriesUsed,
      ledger,
      usedAI,
      timedOut ? false : cfg.enableAIPlanning, // skip AI on deadline → fast return
      profile,
      status,
      learnings,
      internal.signal,
      timedOut
        ? "> **Partial results** — the configured time limit was reached before completion."
        : undefined,
    );

    return {
      report,
      queriesUsed,
      totalSources: sources.length,
      roundsRun: profile.depthRounds,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", onExternalAbort);
    // Ensure crawlers blocked in-flight unblock even on unexpected paths.
    if (!internal.signal.aborted) internal.abort();
  }
}
