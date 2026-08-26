/**
 * @file pipeline/frontier.ts
 * Shared ranked URL frontier. Crawler workers pull candidates from one pool;
 * the run's global page budget is tracked against it.
 */
import type { SearchHit } from "../core/types";
import { rankCandidate } from "../ranking/candidate";
import { canonicalUrl } from "../core/util";
import { simhash, isNearDuplicate } from "../core/simhash";

export interface FrontierCandidate {
  readonly canonical: string;
  readonly hit: SearchHit;
  readonly priority: number;
}

export class Frontier {
  private readonly candidates = new Map<string, FrontierCandidate>();
  private readonly visited = new Set<string>();
  private readonly queuedHashes = new Map<string, bigint>();

  constructor(private readonly maxCandidates = 500) {}

  /** True if this URL was already accepted into the corpus this run. */
  isVisited(url: string): boolean {
    return this.visited.has(canonicalUrl(url));
  }

  markVisited(url: string): void {
    this.visited.add(canonicalUrl(url));
    this.candidates.delete(canonicalUrl(url));
  }

  get visitedCount(): number {
    return this.visited.size;
  }

  /**
   * Adds hits as candidates. Skips already-visited URLs; caps queue size;
   * simhash-near-duplicate titles/snippets of queued candidates are dropped.
   */
  addHits(hits: ReadonlyArray<SearchHit>): number {
    let added = 0;
    for (const hit of hits) {
      const key = canonicalUrl(hit.url);
      if (!key || this.visited.has(key) || this.candidates.has(key)) continue;

      const referenceHash = simhash(`${hit.title} ${hit.snippet}`.toLowerCase().split(/\s+/));
      let duplicate = false;
      for (const existing of this.queuedHashes.values()) {
        if (isNearDuplicate(referenceHash, existing)) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
      if (this.candidates.size >= this.maxCandidates) break;

      const ranked = rankCandidate(hit);
      const candidate: FrontierCandidate = {
        canonical: key,
        hit,
        priority: ranked.priority,
      };
      this.queuedHashes.set(key, referenceHash);
      this.candidates.set(key, candidate);
      added++;
    }
    return added;
  }

  /** Pops the highest-priority candidate (O(n) scan; fine at ≤500). */
  takeBest(): FrontierCandidate | null {
    let bestKey: string | null = null;
    let bestPriority = -Infinity;
    for (const [key, candidate] of this.candidates) {
      if (candidate.priority > bestPriority) {
        bestPriority = candidate.priority;
        bestKey = key;
      }
    }
    if (bestKey === null) return null;
    const best = this.candidates.get(bestKey)!;
    this.candidates.delete(bestKey);
    return best;
  }

  get size(): number {
    return this.candidates.size;
  }
}

