/**
 * @file local/bm25.ts
 * Okapi BM25 (k1=1.2, b=0.75) over a chunk index.
 * Used by BOTH the local document store and generic corpus ranking.
 */
export interface Bm25Doc {
  readonly id: string;
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly length: number; // token count
}

export class Bm25Index {
  private readonly docs = new Map<string, Bm25Doc>();
  /** term → number of DISTINCT docs containing it */
  private readonly docFrequency = new Map<string, number>();
  private totalLength = 0;

  private k1 = 1.2;
  private b = 0.75;

  get size(): number {
    return this.docs.size;
  }

  add(doc: Bm25Doc): void {
    if (this.docs.has(doc.id)) this.remove(doc.id);
    this.docs.set(doc.id, doc);
    this.totalLength += doc.length;
    // Doc frequency counts distinct terms — keep this in step with remove().
    for (const term of doc.termFrequencies.keys()) {
      this.docFrequency.set(term, (this.docFrequency.get(term) ?? 0) + 1);
    }
  }

  remove(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.delete(id);
    this.totalLength -= doc.length;
    for (const term of doc.termFrequencies.keys()) {
      const current = this.docFrequency.get(term) ?? 0;
      if (current <= 1) this.docFrequency.delete(term);
      else this.docFrequency.set(term, current - 1);
    }
    return true;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  /** Average doc length over the CURRENT population (never divided by zero). */
  private avgLength(): number {
    if (this.docs.size === 0) return 1;
    return Math.max(1, this.totalLength / this.docs.size);
  }

  private idf(term: string): number {
    const n = this.docs.size;
    const df = this.docFrequency.get(term) ?? 0;
    // Standard BM25+ idf floor to avoid negative scores on ubiquitous terms.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Scores every indexed doc against the query tokens.
   * Returns [id, score] pairs sorted descending, at most `limit`.
   */
  search(queryTokens: ReadonlyArray<string>, limit: number): Array<{ id: string; score: number }> {
    if (queryTokens.length === 0 || this.docs.size === 0) return [];

    const queryFreq = new Map<string, number>();
    for (const t of queryTokens) queryFreq.set(t, (queryFreq.get(t) ?? 0) + 1);

    const avgLen = this.avgLength();
    const scored: Array<{ id: string; score: number }> = [];

    for (const doc of this.docs.values()) {
      let score = 0;
      for (const [term, qf] of queryFreq) {
        const tf = doc.termFrequencies.get(term);
        if (!tf) continue;
        const norm = tf * (this.k1 + 1) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / avgLen)));
        score += qf * this.idf(term) * norm;
      }
      if (score > 0) scored.push({ id: doc.id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Snapshot of doc-frequency for persistence diagnostics/tests. */
  docFrequencyOf(term: string): number {
    return this.docFrequency.get(term) ?? 0;
  }
}
