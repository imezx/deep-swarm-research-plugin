/**
 * @file pipeline/orchestrator.ts
 * Frontier-based multi-round research run.
 * Round model: seed frontier (round 1 specs) → concurrent crawlers drain it →
 * coverage analysis → gap queries onto SAME frontier → repeat.
 */
import type {
  ResearchConfig, ResearchResult, StatusFn, WarnFn, CrawledSource, DepthProfile,
} from "../core/types";
import { isAbortError } from "../core/types";
import { RunLedger } from "../core/ledger";
import { Frontier } from "./frontier";
import { buildResearchPlan, gapPlansFromDimensions } from "./planner";
import { enginesForScope } from "../engines";
import { guardedSearch } from "../engines/registry";
import { distillRound, type DistilledRound } from "./learnings";
import { fetchPage } from "../net/fetcher";
import { extractPageFromHtml } from "../net/extractor";
import { isPdfUrl, isPdfContentType, extractPdfPage } from "../net/pdf";
import { computeRelevance } from "../ranking/relevance";
import { assessCandidate } from "../ranking/authority";
import { detectCoveredDimensions, detectGapDimensions } from "../core/dimensions";
import { simhash, isNearDuplicate } from "../core/simhash";
import { getDocumentStore } from "../local/store";
import { synthesiseReport, detectContradictions } from "../synthesis/ai";

const MIN_USEFUL_WORDS = 60;
const CRAWLER_POLL_MS = 300;
export interface OrchestratorResult {
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly ledger: RunLedger;
  readonly learnings: ReadonlyArray<string>;
  readonly usedAI: boolean;
}

function crawlDelay(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, CRAWLER_POLL_MS);
  return promise;
}

export async function runSwarm(
  cfg: ResearchConfig,
  profile: DepthProfile,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  const ledger = new RunLedger(status, warn);
  const frontier = new Frontier();
  const accepted: CrawledSource[] = [];
  const acceptedHashes: bigint[] = [];
  let budgetUsed = 0;
  const queriesUsed: string[] = [];

  const allLearnings: string[] = [];
  let lastDistilled: DistilledRound = { learnings: [], followUps: [], usedModel: false };
  let sourcesAtRoundStart = 0;

  const totalBudget = profile.pagesPerCrawlerRound * Math.max(3, profile.crawlerCount);
  const contentLimit = effectiveContentLimit(cfg, profile);

  status(`\nPlanning: "${cfg.topic}" [${cfg.depthPreset}]`);
  const plan = await buildResearchPlan(
    cfg.topic, cfg.focusAreas, cfg.enableAIPlanning, profile, status,
  );

  if (cfg.enableLocalSources) {
    for (const spec of plan.specs) {
      harvestLocalSourcesForSpec(spec.queries, spec.role, cfg.topic, contentLimit, accepted, ledger);
    }
    budgetUsed += accepted.length;
    if (accepted.length > 0) status(`Local corpus seeded ${accepted.length} chunk(s)`);
  }

  status(`${plan.specs.length} worker specs — global budget ${totalBudget} pages`);

  const searchQueries = async (queries: ReadonlyArray<string>, scope: Parameters<typeof enginesForScope>[0]): Promise<void> => {
    for (const query of queries) {
      if (signal.aborted) return;
      queriesUsed.push(query);
      for (const engine of enginesForScope(scope)) {
        if (signal.aborted) return;
        let hits;
        try {
          hits = await guardedSearch(engine, query, profile.searchResultsPerQuery, signal, ledger);
        } catch (err) {
          // Deadline/cancel mid-search: wind down instead of crashing.
          if (isAbortError(err) || signal.aborted) return;
          continue;
        }
        frontier.addHits(hits);
      }
    }
  };

  // Round-1 seeding from every spec.
  for (const spec of plan.specs) {
    if (signal.aborted) break;
    await searchQueries(spec.queries.slice(0, profile.maxQueriesPerSpec), spec.scope);
    if (!signal.aborted) status(`Seeded via ${spec.label} — frontier at ${frontier.size}`);
  }

  // Rounds of crawling + gap-fill.
  for (let round = 1; round <= profile.depthRounds && !signal.aborted; round++) {
    status(`\nRound ${round} — ${frontier.size} candidates queued, budget ${budgetUsed}/${totalBudget}`);
  sourcesAtRoundStart = accepted.length;

    // Concurrent crawlers pulling one shared frontier.
    await Promise.all(Array.from({ length: profile.crawlerCount }, async () => {
      while (!signal.aborted && budgetUsed < totalBudget && frontier.size > 0) {
        const candidate = frontier.takeBest();
        if (candidate === null) return;

        try {
          const source = await crawlOne(candidate.hit.url, contentLimit, candidate.hit.engine, signal, ledger);
          if (source === null) {
            frontier.markVisited(candidate.hit.url);
            continue;
          }

          const relevance = computeRelevance(
            { title: source.title, snippet: source.description, body: source.text },
            plan.topicKeywords,
          );
          if (relevance < profile.minRelevanceScore) {
            frontier.markVisited(candidate.hit.url);
            ledger.filteredOffTopic += 1;
            continue;
          }

          const hash = simhash(source.text.toLowerCase().split(/\s+/).slice(0, 400));
          if (acceptedHashes.some((h) => isNearDuplicate(h, hash))) {
            frontier.markVisited(candidate.hit.url);
            ledger.filteredDuplicate += 1;
            continue;
          }

          const assessment = assessCandidate(candidate.hit.url, source.published);
          frontier.markVisited(candidate.hit.url);
          acceptedHashes.push(hash);
          budgetUsed += 1;
          ledger.fetched += 1;
          accepted.push({
            ...source,
            index: accepted.length + 1,
            relevanceScore: relevance,
            tier: assessment.tier,
            authorityScore: assessment.authorityScore,
            discoveredBy: `${candidate.hit.title} — via ${candidate.hit.engine}`,
          });
          status(`[${accepted.length}] (${relevance.toFixed(2)}) ${source.title.slice(0, 60)}`);

          // Link following: seed promising outlinks onto the SAME frontier.
          if (cfg.enableLinkFollowing && source.outlinks.length > 0 && budgetUsed < totalBudget) {
            const seeded = frontier.addHits(source.outlinks.slice(0, 5).map((link) => ({
              engine: candidate.hit.engine,
              url: link.href,
              title: link.text || link.href,
              snippet: `linked from: ${source.title.slice(0, 80)}`,
              published: null,
            })));
            if (seeded > 0) ledger.note(`+${seeded} link-follow candidate(s) from "${source.title.slice(0, 40)}"`);
          }
        } catch (err) {
          frontier.markVisited(candidate.hit.url);
          if (isAbortError(err)) return;
          ledger.addError("crawler", err);
        }
        await crawlDelay();
      }
    }));

    // Distill this round's new sources into learnings (ONE batched LLM call).
    if (accepted.length > sourcesAtRoundStart) {
      lastDistilled = await distillRound(
        cfg.topic,
        accepted.slice(sourcesAtRoundStart),
        allLearnings,
        status,
      );
      for (const learning of lastDistilled.learnings) {
        if (!allLearnings.includes(learning)) allLearnings.push(learning);
      }
      status(`Learnings: ${allLearnings.length}${lastDistilled.usedModel ? "" : " (extractive fallback)"}`);

      // Stop early when the model reports no open questions and most
      // dimensions are already covered.
      const coveredNow = detectCoveredDimensions(accepted.map((s) => s.text));
      if (lastDistilled.usedModel && lastDistilled.followUps.length === 0 && coveredNow.length >= 6) {
        status("AI review: research direction satisfied — stopping early");
        break;
      }
    }

    if (budgetUsed >= totalBudget) {
      status("Budget exhausted — moving to synthesis");
      break;
    }


    const coveredIds = detectCoveredDimensions(accepted.map((s) => s.text));
    status(`Coverage after round ${round}: ${coveredIds.length}/12 dimensions`);

    const gaps = detectGapDimensions(coveredIds);
    if (gaps.length === 0) {
      status("All dimensions covered — early stop");
      break;
    }

    // Seed next round with targeted gap queries through API engines only.
    const before = frontier.size + accepted.length;
    const gapSpecs = gapPlansFromDimensions(gaps.slice(0, 4), cfg.topic, profile);
    const followUpQueries = lastDistilled.followUps
      .filter((q) => !queriesUsed.includes(q))
      .slice(0, profile.queriesPerGapDimension * 2);
    if (followUpQueries.length > 0) {
      gapSpecs.push({ role: "depth", label: "AI follow-up", queries: followUpQueries, scope: "general" });
    }
    for (const spec of gapSpecs) {
      if (signal.aborted) break;
      const fresh = spec.queries.filter((q) => !queriesUsed.includes(q));
      await searchQueries(fresh, spec.scope);
    }
    if (frontier.size === 0 && accepted.length + frontier.size === before) {
      status("Stagnation — no new candidates found for remaining gaps");
      break;
    }
  }

  return { sources: accepted, queriesUsed: [...new Set(queriesUsed)], ledger, learnings: allLearnings, usedAI: plan.usedAI };
}
/* ---------------- helpers ---------------- */

async function crawlOne(
  url: string,
  contentLimit: number,
  engineTag: import("../core/types").EngineId,
  signal: AbortSignal,
  ledger: RunLedger,
): Promise<(Omit<CrawledSource, "index" | "relevanceScore" | "tier" | "authorityScore" | "discoveredBy"> & { outlinks: ReadonlyArray<{ text: string; href: string }> }) | null> {
  const page = await fetchPage(url, signal, ledger);
  if (page.viaArchive) ledger.cacheFallbacks += 1;

  const binaryPdf =
    isPdfContentType(page.contentType) && page.body.subarray(0, 5).toString("latin1") === "%PDF";
  const suffixPdf = !isPdfContentType(page.contentType) && page.body.subarray(0, 5).toString("latin1") === "%PDF";

  let extracted;
  if (binaryPdf || suffixPdf || (isPdfUrl(url) && page.body.subarray(0, 5).toString("latin1") === "%PDF")) {
    extracted = await extractPdfPage(page.body, url, page.finalUrl, contentLimit);
    ledger.pdfExtracts += 1;
  } else {
    extracted = extractPageFromHtml(page.body.toString("utf-8"), url, page.finalUrl, contentLimit);
  }

  if (extracted.wordCount < MIN_USEFUL_WORDS) {
    ledger.filteredTooShort += 1;
    return null;
  }

  return {
    url: extracted.url,
    finalUrl: extracted.finalUrl,
    title: extracted.title || extracted.description.slice(0, 80) || "Untitled",
    description: extracted.description,
    published: extracted.published,
    text: extracted.text,
    wordCount: extracted.wordCount,
    origin: "web",
    engine: engineTag,
    /** Extracted external links — consumed by link-following when enabled. */
    outlinks: extracted.outlinks,
  };
}

function harvestLocalSourcesForSpec(
  queries: ReadonlyArray<string>,
  _role: string,
  _topic: string,
  contentLimit: number,
  sink: CrawledSource[],
  ledger: RunLedger,
): void {
  const store = getDocumentStore();
  if (!store.hasCollections()) return;

  const hits = store.search(queries.join(" "), 4);
  for (const hit of hits) {
    sink.push({
      index: sink.length + 1,
      url: `local://${hit.collectionName}/${hit.fileName}`,
      finalUrl: `local://${hit.collectionName}/${hit.fileName}`,
      title: `${hit.fileName} (${hit.collectionName})`,
      description: hit.text.slice(0, 250),
      published: null,
      text: hit.text.slice(0, contentLimit),
      wordCount: hit.wordCount,
      origin: "local",
      engine: "local",
      discoveredBy: "local collection",
      relevanceScore: 0.6,
      tier: "reference",
      authorityScore: 85,
    });
    ledger.localHits += 1;
  }
}

function effectiveContentLimit(cfg: ResearchConfig, profile: DepthProfile): number {
  return cfg.contentLimitPerPage ?? profile.contentPerPage;
}
