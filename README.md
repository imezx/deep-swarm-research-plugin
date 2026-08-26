# Deep Research v2

Autonomous deep research for LM Studio. One tool call: verified multi-source
research report with AI synthesis, contradiction detection, and a run
diagnostics section that always tells you *why* coverage is what it is.

## What changed from v1 (why this is a rewrite)

| v1 problem | v2 fix |
|---|---|
| Scraped SERPs as the primary corpus (fragile, ToS-risky) | **Structured free APIs first** — Wikipedia, OpenAlex, arXiv return exact text + metadata. DDG/Brave scrapes demoted to labeled general-scope fallbacks |
| Local models fed dozens of full pages | **Learnings pipeline** — one batched LLM call per round distills sources into dense factual learnings; synthesis runs on those, not raw text |
| Per-worker budgets inflated silently under fan-out | **Shared frontier with one global budget** — workers pull ranked candidates; inflation is impossible by construction |
| Indexed collections vanished on restart | **Disk-backed snapshots** (`~/.deep-swarm-research/collections/`) written atomically, reloaded on boot |
| IDF/doc-frequency corrupted on collection removal | Symmetric distinct-term counting inside a real **BM25 index**, covered by regression tests |
| TLS validation bypassed on failure | Never. TLS errors are typed failures; fetches fall back to the Internet Archive instead |
| No SSRF protection | Every redirect hop checked against private ranges / cloud-metadata endpoints |
| Substring relevance matching ("care" matched "career") | Tokenized word-boundary relevance scoring |
| Silent `catch {}` everywhere | **Run Ledger**: per-engine query/hit/failure/breaker stats rendered into every report |
| Content-limit config default defeated depth scaling | "Auto" option honors depth-scaled limits |

## Architecture

```
src/
  core/        types · errors · ledger · util · simhash · model(LLM) · dimensions
  net/         fetcher(SSRF-safe) · extractor(Readability) · pdf(pdf-parse v2)
  engines/     wikipedia · openalex · arxiv · ddg · brave + circuit-breaker registry
  ranking/     authority(domain DB+freshness) · relevance(word-boundary) · candidate
  local/       bm25 index · disk-backed document store
  pipeline/    planner(zod-validated AI decomposition) · frontier · learnings · orchestrator
  synthesis/   AI narrative + contradiction detection (zod-validated)
  report/      markdown builder incl. Run Diagnostics section
```

### Research loop

1. **Plan** — AI decomposes the topic into specialized worker specs
   (role, queries, scope: academic/reference/general), template fallback when off.
2. **Seed** — each spec's queries fan across its scope's engines; hits are ranked
   (authority + freshness + engine-trust) onto one shared frontier.
3. **Crawl** — N concurrent crawlers pull candidates → fetch → extract →
   relevance gate → SimHash dedup → accept against global budget.
4. **Distill** — accepted sources condensed into learnings + follow-up questions.
5. **Review & repeat** — gap analysis over 12 research dimensions plus AI
   follow-ups seed the next round; stops on budget, stagnation, full coverage,
   or the model itself declaring direction satisfied.
6. **Synthesize** — narrative report with inline citations, contradictions,
   coverage table, and the diagnostics section.

## Tools

- **Deep Research** — the main tool (topic, optional focusAreas / depthOverride / contentLimitOverride)
- **Local Docs Add / List / Remove / Search** — persistent BM25-indexed local collections

## Depth presets

| | Shallow | Standard | Deep | Deeper | Exhaustive |
|---|---|---|---|---|---|
| Rounds | 1 | 3 | 5 | 10 | 15 |
| Global page budget | 24 | 36 | 48 | 80 | 96 |
| Crawlers | 2 | 3 | 3 | 4 | 4 |
| Content/page | 5K–16K chars (Auto scales by preset) |

## Configuration

Research Depth · Content Per Page (numeric; **0 = Auto** scales 5K–16K with depth) ·
Link Following · AI Planning & Synthesis · Safe Search · Local Document Sources ·
**SearXNG Base URL** — point at your own instance
(e.g. `http://localhost:8888`) to replace DDG/Brave scrapes entirely.
Requires `formats: [html, json]` in the instance's `settings.yml`.
This addresses the rate-limit pain: your own SearXNG is fast, private,
and never gets blocked.

## Verification

```bash
npm test          # 17 unit tests: BM25 symmetry, simhash, SSRF guard,
                  # chunker bounds, frontier ordering/dedup
npm run build
```

Live-smoke-tested end to end: arXiv/OpenAlex/Wikipedia retrieval, archive
fallbacks, breaker open on Brave 429, extractive fallback without a loaded
model, honest diagnostics for soft-blocked DDG.

## Notes

- Scraped engines violate those sites' ToS by design — acknowledged tradeoff,
  isolated behind the `engines/ddg.ts` / `engines/brave.ts` boundary, health-
  tracked so breakage is visible rather than silent.
- API engines require no keys; nothing here needs any external account.

MIT License
