# DeepResearch v2 — Design Contract

Full redesign of the swarm research plugin. Fixes every defect identified in the
v1 review: IDF corruption, budget inflation, false persistence promise, silent TLS
bypass, substring relevance, duplication drift, invisible engine failures.

## Principles

1. **Verified provenance over volume.** Structured key-free APIs first
   (Wikipedia Action API, OpenAlex, arXiv Atom). Scraping is fallback only,
   health-tracked, honestly labeled.
2. **Deterministic core, AI at the edges.** Retrieval/ranking/pipeline logic is
   pure, testable TypeScript. LLM touches only: query planning, synthesis,
   contradiction detection — each independently skippable with graceful fallback.
3. **Honest failure.** No bare `catch {}`. Every degraded path writes to a
   RunLedger that is rendered into the report (`Run Diagnostics` section) so an
   empty result is diagnosable, not mysterious.
4. **One copy of everything.** Single util module, single stopword list, single
   hostname helper, single LLM wrapper, single PDF-branch helper.
5. **No unsafe shortcuts.** No `rejectUnauthorized:false`, no DNS override, no
   private-IP fetching (SSRF guard on every hop), body-read deadlines enforced.

## Architecture

```
src/
  index.ts            plugin entry
  config.ts           config schematics ("auto" content limit honored)
  toolsProvider.ts    8 tools; thin registration only
  core/
    types.ts          ALL shared contracts (readonly)
    errors.ts         FetchError{kind} taxonomy incl. bot-blocked / private-address
    ledger.ts         RunLedger: per-engine stats, filter counters, warnings
    util.ts           hostname/sleep/truncate/STOPWORDS/tokenize/wordRe
    model.ts          THE LLM wrapper (timeout, signal, optional zod schema)
    simhash.ts        64-bit SimHash + Hamming dedup
  net/
    fetcher.ts        redirect-hop-checked fetch, deadline covers BODY read
    extractor.ts      Readability pipeline, published-date extraction, outlinks
    pdf.ts            single extractPdfPage() used by all callers
  engines/
    types.ts          SearchEngine interface {id, scopes, search()}
    registry.ts       circuit breaker + health per engine, scoped selection
    wikipedia.ts      action=query generator=search prop=extracts (plain text)
    openalex.ts       works?search=... abstract_inverted_index → text
    arxiv.ts          export.arxiv.org/api/query Atom → entries
    ddg.ts            lite endpoint POST + adaptive throttle (scrape tier)
    brave.ts          html scrape (scrape tier)
    hitFromScrape.ts? (inline in each scraper; no cross-imports)
  ranking/
    authority.ts      domain DB → [score, tier]; freshness from published date
    ranker.ts         scoreCandidate: authority+freshness+urlquality → total
  local/
    bm25.ts           Okapi BM25 over chunk index (k1=1.2 b=0.75)
    store.ts          DocumentStore: atomic JSON snapshots in ~/.deep-swarm-research/
                      reload-on-boot; doc-freq inc/dec SYMMETRIC (+1 / −1)
  pipeline/
    planner.ts        AI decomposition (zod StrictJSON) → role queries → templates
    frontier.ts       ranked URL frontier w/ global budget ledger
    worker.ts         pulls from frontier: engine search→rank→fetch→filter→push
    orchestrator.ts   rounds: seed frontier → drain N crawlers → gap analysis
  synthesis/
    ai.ts             synthesiseReport + detectContradictions (zod-validated)
  report/
    builder.ts        header/analysis/contradictions/coverage/sources/diagnostics
```

## Key mechanics

### Frontier model (replaces per-worker budgets)
- Orchestrator owns `totalBudget` pages. Frontier holds `Candidate(url, query,
  scope, score)` sorted by score; duplicate-suppressed by url + simhash-at-add.
- `CRAWLER_COUNT` concurrent workers loop: pull best eligible candidate → fetch →
  extract → relevance gate (tokenized word-boundary match vs topic keywords) →
  accept → decrement global budget. Round ends when frontier drains or budget
  hits zero or abort fires.
- Gap rounds compute uncovered dimensions, planner emits targeted queries,
  engines produce candidates pushed onto the SAME frontier. No multiplication
  anywhere, by construction.

### Engine registry & honesty
```ts
interface SearchEngine {
  id: "wikipedia"|"openalex"|"arxiv"|"ddg"|"brave";
  scopes: ReadonlyArray<"reference"|"academic"|"general">;
  search(q: string, limit: number, signal: AbortSignal): Promise<SearchHit[]>;
}
```
Registry wraps each engine with: consecutive-failure breaker (opens at 3,
half-open probe after cooldown), success/failure/hit counters fed to RunLedger.
Planners request candidates BY SCOPE; general-scope requests may use scrapers if
APIs return nothing. Report prints a table: engine | queries | hits | fails |
breaker status. Zero-hits runs always say WHY.

### Local store correctness
- Chunks persist as `{id, fileName, text}` snapshots (terms recomputed on load —
  deterministic, keeps file small).
- Every doc-frequency mutation paired (+1 on add per DISTINCT term, −1 on remove
  per DISTINCT term). Unit-tested for symmetry after add/remove/re-add cycles.
- Snapshot write: temp file + rename in `~/.deep-swarm-research/collections/<uuid>.json`.
- Boot: lazy-load directory once per process.

### Fetch safety
- Manual redirect loop (max 5): EVERY hop's host checked against private ranges
  (127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7, 169.254/16, 0.0.0.0) and
  non-http(s) schemes → `FetchError("private-address")` / refused.
- `AbortController` timeout WRAPS the entire operation including `res.text()` /
  `arrayBuffer()` (v1 cleared the timer before body read).
- TLS failures surface as normal errors — no insecure retry. Cache fallback
  (web.archive.org only; Google cache is dead) still allowed but ledger-tagged.

### Relevance & dedup
- Tokenized (word-boundary, lowercased, stopword-filtered) topic keywords;
  relevance = weighted coverage of title/body/snippet matches + density bonus.
- SimHash over token stream; Hamming distance ≤ 12 ⇒ duplicate (v1's sampled
  head/mid/tail join broke on reflowed boilerplate).

### Config fixes
- `contentPerPage`: select field with **Auto** default → profiles' scaled limits
  actually apply. Explicit values override. README claim becomes true.
- Same config keys as v1 (user settings survive upgrade).

### Verification
`tsc && node --test dist/test/*.test.js` covering:
1. BM25/doc-freq symmetry (add/remove/re-add round trip)
2. Chunker boundary behavior (no mid-word cut, overlap)
3. SimHash near-duplicate detection + distinct-passage separation
4. Planner line-parser + zod spec validation (malformed AI output rejected)
5. SSRF guard rejects localhost/private/unix URLs on first hop
6. DDG lite HTML fixture parse
7. Frontier ordering, budget accounting, fan-free distribution

LLM behavior intentionally NOT unit-tested (network model); guarded behind
zod + null fallback + ledger notes.
