/**
 * @file swarm/worker.ts
 * A single swarm worker with:
 * - Multi-engine search (DDG + Brave + Scholar + SearXNG + Mojeek)
 * - Query mutation: auto-rephrase when results are sparse
 * - Recursive link crawling (configurable depth 1-3)
 * - Cross-worker discovery sharing via SharedCrawlState
 * - All limits read from SwarmTask (depth-profile overrides)
 */

import {
  searchDDG,
  searchDDGPaginated,
  DdgRateLimiter,
  sharedDdgLimiter,
} from "../net/ddg";
import { multiEngineSearch, SearchEngine } from "../net/search-engines";
import { fetchPage } from "../net/http";
import {
  extractPage,
  contentFingerprint,
  computeRelevance,
} from "../net/extractor";
import { isPdfUrl, isPdfContentType, extractPdf } from "../net/pdf-extractor";
import {
  scoreCandidate,
  rankCandidates,
  scoreOutlinks,
} from "../scoring/authority";
import {
  SwarmTask,
  WorkerResult,
  CrawledSource,
  ScoredCandidate,
  SourceTier,
  StatusFn,
  WarnFn,
} from "../types";
import {
  BATCH_INTER_FETCH_DELAY_MS,
  MIN_USEFUL_WORD_COUNT,
} from "../constants";
import { sleep } from "../net/http";

export interface SharedCrawlState {
  readonly visitedUrls: ReadonlySet<string>;
  readonly contentHashes: ReadonlySet<string>;
  readonly domainCounts: ReadonlyMap<string, number>;
  addVisited(url: string): void;
  addHash(hash: string): void;
  incrementDomain(url: string): void;
  domainCount(url: string): number;
  pushDiscovery(url: string, title: string, fromWorker: string): void;
  drainDiscoveries(
    limit: number,
  ): ReadonlyArray<{ url: string; title: string }>;
}

const MUTATION_STRATEGIES: ReadonlyArray<(q: string) => string> = [
  (q) => `"${q}"`,
  (q) => `${q} explained`,
  (q) => `${q} research 2024-2026+`,
  (q) => q.split(" ").slice(0, 4).join(" "),
  (q) => `${q} guide overview`,
  (q) => q.replace(/\b(how|what|why|when)\b/gi, "").trim(),
];

function mutateQuery(query: string, attempt: number): string | null {
  if (attempt >= MUTATION_STRATEGIES.length) return null;
  const mutated = MUTATION_STRATEGIES[attempt](query);
  return mutated && mutated !== query && mutated.length > 3 ? mutated : null;
}

export async function runWorker(
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  topicKws: ReadonlyArray<string> = [],
  limiter: DdgRateLimiter = sharedDdgLimiter,
): Promise<WorkerResult> {
  const sources: CrawledSource[] = [];
  const errors: string[] = [];
  const queriesExecuted: string[] = [];

  const roleTag = `[${task.label}]`;
  status(
    `${roleTag} Starting — ${task.queries.length} queries, budget: ${task.pageBudget} pages` +
      (task.extraEngines.length > 0
        ? `, engines: DDG+${task.extraEngines.join("+")}`
        : ""),
  );

  const allHits: Array<{
    url: string;
    title: string;
    snippet: string;
    query: string;
  }> = [];

  for (const query of task.queries) {
    if (signal.aborted) break;

    let ddgHits: ReadonlyArray<import("../types").SearchHit> = [];

    try {
      if (task.searchPages > 1) {
        ddgHits = await searchDDGPaginated(
          query,
          task.searchResultsPerQuery,
          task.searchPages,
          task.safeSearch,
          signal,
          limiter,
        );
      } else {
        ddgHits = await searchDDG(
          query,
          task.searchResultsPerQuery,
          task.safeSearch,
          signal,
          limiter,
        );
      }
      for (const h of ddgHits) allHits.push({ ...h, query });
      queriesExecuted.push(query);
      status(
        `${roleTag} DDG: "${query}" → ${ddgHits.length} results${task.searchPages > 1 ? ` (${task.searchPages}pg)` : ""}`,
      );
    } catch (err: unknown) {
      if (isAbortError(err)) break;
      warn(`${roleTag} DDG failed: "${query}" — ${errorMessage(err)}`);
      errors.push(`ddg:"${query}": ${errorMessage(err)}`);
    }

    if (ddgHits.length < task.queryMutationThreshold && !signal.aborted) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const mutated = mutateQuery(query, attempt);
        if (!mutated) break;
        try {
          const mutHits = await searchDDG(
            mutated,
            task.searchResultsPerQuery,
            task.safeSearch,
            signal,
            limiter,
          );
          if (mutHits.length > ddgHits.length) {
            for (const h of mutHits) allHits.push({ ...h, query: mutated });
            queriesExecuted.push(mutated);
            status(
              `${roleTag} Mutated: "${mutated}" → ${mutHits.length} results`,
            );
            break;
          }
        } catch {
          break;
        }
      }
    }

    if (task.extraEngines.length > 0 && !signal.aborted) {
      try {
        const extraHits = await multiEngineSearch(
          query,
          Math.min(task.searchResultsPerQuery, 8),
          task.extraEngines as ReadonlyArray<SearchEngine>,
          signal,
          () => limiter,
        );
        for (const h of extraHits) allHits.push({ ...h, query });
        if (extraHits.length > 0) {
          status(
            `${roleTag} +${task.extraEngines.join("+")} → ${extraHits.length} extra results`,
          );
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  if (signal.aborted || allHits.length === 0) {
    return {
      taskId: task.id,
      role: task.role,
      label: task.label,
      sources,
      queries: queriesExecuted,
      errors,
    };
  }

  const deduped = deduplicateByUrl(allHits);
  const scored = deduped.map((h) => scoreCandidate(h, h.query));
  const filtered = task.preferredTiers
    ? scored.filter((c) => task.preferredTiers!.includes(c.tier))
    : scored;

  const poolSize = task.pageBudget * task.candidatePoolMultiplier;
  const candidates = rankCandidates(
    filtered.length > 0 ? filtered : scored,
    poolSize,
  );

  status(
    `${roleTag} ${candidates.length} candidates ranked (from ${allHits.length} hits across ${task.extraEngines.length + 1} engine(s))`,
  );

  await fetchBatch(
    candidates,
    task,
    state,
    signal,
    status,
    warn,
    sources,
    errors,
    roleTag,
    topicKws,
  );

  if (
    task.followLinks &&
    sources.length > 0 &&
    sources.length < task.pageBudget
  ) {
    for (let depth = 1; depth <= task.linkCrawlDepth; depth++) {
      if (sources.length >= task.pageBudget || signal.aborted) break;

      const budget = Math.min(
        task.pageBudget - sources.length,
        task.maxLinksToFollow,
      );
      if (budget <= 0) break;

      const sourcesForLinks =
        depth === 1 ? sources : sources.slice(-budget * 2);
      const newCount = await followLinks(
        sourcesForLinks,
        task,
        state,
        signal,
        status,
        warn,
        sources,
        errors,
        roleTag,
        budget,
        topicKws,
        depth,
      );

      if (newCount === 0) break; // no new sources at this depth, stop going deeper
    }
  }

  for (const src of sources) {
    for (const link of src.outlinks.slice(0, 5)) {
      state.pushDiscovery(link.href, link.text, task.label);
    }
  }

  if (sources.length < task.pageBudget && !signal.aborted) {
    const discoveries = state.drainDiscoveries(
      Math.min(5, task.pageBudget - sources.length),
    );
    if (discoveries.length > 0) {
      status(
        `${roleTag} Picking up ${discoveries.length} cross-worker discoveries…`,
      );
      const discCandidates = discoveries.map((d) =>
        scoreCandidate(
          { url: d.url, title: d.title, snippet: "" },
          task.queries[0] ?? "",
        ),
      );
      await fetchBatch(
        discCandidates,
        { ...task, pageBudget: sources.length + discoveries.length },
        state,
        signal,
        status,
        warn,
        sources,
        errors,
        roleTag,
        topicKws,
      );
    }
  }

  status(`${roleTag} Done — ${sources.length} sources collected`);
  return {
    taskId: task.id,
    role: task.role,
    label: task.label,
    sources,
    queries: queriesExecuted,
    errors,
  };
}

async function fetchBatch(
  candidates: ReadonlyArray<ScoredCandidate>,
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  results: CrawledSource[],
  errors: string[],
  tag: string,
  topicKws: ReadonlyArray<string>,
): Promise<void> {
  let idx = 0;
  const concurrency = task.workerConcurrency;
  const domainCap = task.maxPagesPerDomain;
  const minRelevance = task.minRelevanceScore;

  while (
    results.length < task.pageBudget &&
    idx < candidates.length &&
    !signal.aborted
  ) {
    const batch = candidates
      .slice(idx, idx + concurrency)
      .filter(
        (c) =>
          !state.visitedUrls.has(c.url) && state.domainCount(c.url) < domainCap,
      );
    idx += concurrency;

    if (batch.length === 0) continue;

    for (const c of batch) state.addVisited(c.url);

    const settled = await Promise.allSettled(
      batch.map((c) =>
        fetchAndExtract(c.url, c.query, c.snippet, task, topicKws, signal),
      ),
    );

    for (let i = 0; i < settled.length; i++) {
      const candidate = batch[i];
      const result = settled[i];

      if (signal.aborted) return;

      if (result.status === "rejected") {
        if (!isAbortError(result.reason)) {
          warn(
            `${tag} Failed: ${truncUrl(candidate.url)} — ${errorMessage(result.reason)}`,
          );
          errors.push(`fetch:${candidate.url}: ${errorMessage(result.reason)}`);
        }
        continue;
      }

      const page = result.value;
      if (page.wordCount < MIN_USEFUL_WORD_COUNT) continue;

      if (page.relevanceScore < minRelevance) {
        status(
          `${tag} Skipped (off-topic, rel=${page.relevanceScore.toFixed(2)}): ${truncUrl(candidate.url)}`,
        );
        continue;
      }

      const fp = contentFingerprint(page.text);
      if (state.contentHashes.has(fp)) {
        status(`${tag} Skipped duplicate: ${truncUrl(candidate.url)}`);
        continue;
      }

      state.addHash(fp);
      state.incrementDomain(candidate.url);
      results.push(page);
      status(
        `${tag} [${results.length}/${task.pageBudget}] (rel=${page.relevanceScore.toFixed(2)}) ${page.title.slice(0, 60)}`,
      );

      if (results.length >= task.pageBudget) return;
    }

    if (idx < candidates.length && results.length < task.pageBudget) {
      await sleep(BATCH_INTER_FETCH_DELAY_MS);
    }
  }
}

async function followLinks(
  existingSources: ReadonlyArray<CrawledSource>,
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  results: CrawledSource[],
  errors: string[],
  tag: string,
  budget: number,
  topicKws: ReadonlyArray<string>,
  depth: number,
): Promise<number> {
  const allLinks = existingSources.flatMap((s) => s.outlinks);
  const linkKws = task.queries
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 12);

  const scored = scoreOutlinks(
    allLinks,
    linkKws,
    state.visitedUrls,
    task.maxLinksToEvaluate,
  );

  const toFollow = scored.slice(0, task.maxLinksToFollow);
  if (toFollow.length === 0) return 0;

  status(`${tag} Following ${toFollow.length} link(s) (depth ${depth})…`);

  const before = results.length;
  const linkCandidates = toFollow.map((l) =>
    scoreCandidate(
      { url: l.href, title: "", snippet: "" },
      task.queries[0] ?? "",
    ),
  );

  await fetchBatch(
    linkCandidates,
    { ...task, pageBudget: results.length + budget },
    state,
    signal,
    status,
    warn,
    results,
    errors,
    tag,
    topicKws,
  );

  return results.length - before;
}

async function fetchAndExtract(
  url: string,
  query: string,
  snippet: string,
  task: SwarmTask,
  topicKws: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<CrawledSource> {
  const fetchResult = await fetchPage(url, signal);
  const { finalUrl } = fetchResult;

  const isPdf =
    (fetchResult.rawBuffer && isPdfContentType(fetchResult.contentType)) ||
    (!fetchResult.rawBuffer && isPdfUrl(url));

  let page;
  if (isPdf && fetchResult.rawBuffer) {
    page = await extractPdf(
      fetchResult.rawBuffer,
      url,
      finalUrl,
      task.contentLimit,
      false,
    );
  } else if (isPdf && fetchResult.html && fetchResult.html.startsWith("%PDF")) {
    const buf = Buffer.from(fetchResult.html, "binary");
    page = await extractPdf(buf, url, finalUrl, task.contentLimit, false);
  } else {
    page = extractPage(
      fetchResult.html,
      url,
      finalUrl,
      task.contentLimit,
      task.maxOutlinksPerPage,
    );
  }

  const { domainScore, freshnessScore, tier } = scoreCandidate(
    { url, title: page.title, snippet: page.description },
    query,
  );

  const relevanceScore = computeRelevance(
    page.text,
    page.title,
    snippet,
    topicKws,
  );

  return {
    url: page.url,
    finalUrl: page.finalUrl,
    title: page.title,
    description: page.description,
    published: page.published,
    text: page.text,
    wordCount: page.wordCount,
    outlinks: page.outlinks,
    sourceQuery: query,
    workerRole: task.role,
    workerLabel: task.label,
    domainScore,
    freshnessScore,
    tier: tier as SourceTier,
    relevanceScore,
  };
}

function deduplicateByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown");
}

function truncUrl(url: string, max = 70): string {
  return url.length > max ? url.slice(0, max) + "…" : url;
}
