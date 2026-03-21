/**
 * @file swarm/worker.ts
 * A single swarm worker: searches, scores, fetches, optionally follows links.
 * Pages are scored for topic relevance after extraction.
 */

import { searchDDG, DdgRateLimiter, sharedDdgLimiter } from "../net/ddg";
import { fetchPage } from "../net/http";
import {
  extractPage,
  contentFingerprint,
  computeRelevance,
} from "../net/extractor";
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
  WORKER_CONCURRENCY,
  MAX_PAGES_PER_DOMAIN,
  MIN_USEFUL_WORD_COUNT,
  BATCH_INTER_FETCH_DELAY_MS,
  MAX_LINKS_TO_EVALUATE,
  MAX_LINKS_TO_FOLLOW,
  MIN_RELEVANCE_SCORE,
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
    `${roleTag} Starting — ${task.queries.length} queries, budget: ${task.pageBudget} pages`,
  );

  const allHits: Array<{
    url: string;
    title: string;
    snippet: string;
    query: string;
  }> = [];

  for (const query of task.queries) {
    if (signal.aborted) break;

    try {
      const hits = await searchDDG(query, 8, task.safeSearch, signal, limiter);
      for (const h of hits) allHits.push({ ...h, query });
      queriesExecuted.push(query);
      status(`${roleTag} Searched: "${query}" ${hits.length} results`);
    } catch (err: unknown) {
      if (isAbortError(err)) break;
      const msg = errorMessage(err);
      warn(`${roleTag} Search failed: "${query}" — ${msg}`);
      errors.push(`search:"${query}": ${msg}`);
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

  const candidates = rankCandidates(
    filtered.length > 0 ? filtered : scored,
    task.pageBudget * 3,
  );

  status(
    `${roleTag} ${candidates.length} candidates ranked (from ${allHits.length} hits)`,
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
    const budget = task.pageBudget - sources.length;
    await followLinks(
      sources,
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
    );
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

  while (
    results.length < task.pageBudget &&
    idx < candidates.length &&
    !signal.aborted
  ) {
    const batch = candidates
      .slice(idx, idx + WORKER_CONCURRENCY)
      .filter(
        (c) =>
          !state.visitedUrls.has(c.url) &&
          state.domainCount(c.url) < MAX_PAGES_PER_DOMAIN,
      );
    idx += WORKER_CONCURRENCY;

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

      if (page.relevanceScore < MIN_RELEVANCE_SCORE) {
        status(
          `${tag} Skipped (off-topic, relevance=${page.relevanceScore.toFixed(2)}): ${truncUrl(candidate.url)}`,
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
): Promise<void> {
  const allLinks = existingSources.flatMap((s) => s.outlinks);
  const linkKws = task.queries
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);

  const scored = scoreOutlinks(
    allLinks,
    linkKws,
    state.visitedUrls,
    MAX_LINKS_TO_EVALUATE,
  );

  const toFollow = scored.slice(0, MAX_LINKS_TO_FOLLOW);
  if (toFollow.length === 0) return;

  status(`${tag} Following ${toFollow.length} link(s)…`);

  const linkCandidates = toFollow.map((l) =>
    scoreCandidate(
      { url: l.href, title: "", snippet: "" },
      task.queries[0] ?? "",
    ),
  );

  await fetchBatch(
    linkCandidates,
    { ...task, pageBudget: budget },
    state,
    signal,
    status,
    warn,
    results,
    errors,
    tag,
    topicKws,
  );
}

async function fetchAndExtract(
  url: string,
  query: string,
  snippet: string,
  task: SwarmTask,
  topicKws: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<CrawledSource> {
  const { html, finalUrl } = await fetchPage(url, signal);
  const page = extractPage(html, url, finalUrl, task.contentLimit);
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
