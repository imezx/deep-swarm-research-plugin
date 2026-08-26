# Deep Research

A research plugin for LM Studio. Give it a topic, it searches the web (and your
own documents if you want), reads the pages, and writes a cited report. Runs
entirely on your machine — no API keys, no accounts.

## Upgrading from the previous version

If you used v1 before, here is what's different and why it matters.

**Where results come from.** The old version got almost everything from
scraping search result pages and hoping the HTML didn't change. This version
asks Wikipedia, OpenAlex, and arXiv through their official APIs instead — real
structured text, no parsing that breaks when a site redesigns. DuckDuckGo and
Brave still work as general-web fallbacks, but they're scraping, so the plugin
watches their health and stops hammering them when they start returning
errors. If you run your own SearXNG instance you can point the plugin at it in
settings; your instance never rate-limits you.

**Your local documents persist now.** In v1, indexing a folder only lasted
until LM Studio restarted — collections lived in memory. They're saved to disk
now (`~/.deep-swarm-research/collections/`) and reload automatically, so
index once and keep using them.

**Local search actually got fixed.** Removing a collection corrupted the
relevance scoring for everything left behind, because document frequencies
were decremented wrong. That whole layer was rewritten around a proper BM25
index with tests covering add/remove cycles.

**Reports are built differently.** Instead of dumping full page text at the
model, each round of sources gets condensed into short factual learnings first,
and those feed the final write-up. Better output from smaller models, and much
smaller prompts.

**The budget can't silently explode anymore.** v1 gave every worker its own
page budget, and some code paths quietly multiplied what was actually fetched.
Now there's one shared budget for the whole run and all crawlers pull from the
same queue.

**Failures are visible.** The old plugin swallowed errors, so an empty report
was a mystery. Every report now ends with a diagnostics section showing which
engines were queried, how many hits and failures each had, and what got
filtered along the way. When coverage is thin, you'll know exactly why.

**Safety fixes.** The old fetcher skipped TLS certificate validation when a
connection failed. It doesn't do that anymore — failed pages fall back to the
Internet Archive instead. Requests are also checked against private/internal
addresses on every redirect hop, and page downloads have a proper deadline.

**Time limit.** New setting: pick a wall-clock limit per research run. When it
hits, everything stops and you get whatever was collected so far immediately,
marked as partial.

**Smaller stuff:** relevance matching happens on whole words now (searching
"care" no longer matches "career"), duplicate pages get filtered by content
similarity rather than URL alone, "Content Per Page" defaults to Auto so depth
presets scale it like the docs always claimed, and AI query planning is
validated before use instead of trusted blindly.

## Tools

- **Deep Research** — topic in, full report out. Optional focus areas, depth
  override, per-call content limit.
- **Local Docs Add / List / Remove / Search** — manage and search your indexed
  folders.

## Settings

| Setting | What it does |
|---|---|
| Research Depth | shallow → exhaustive. Controls rounds, budget, crawler count |
| Content Per Page | 0 = auto (scales 5K–16K chars with depth), or pin a value |
| Research Time Limit | minutes per run, 0 = unlimited |
| Link Following | fetch promising links found inside accepted pages |
| AI Planning & Synthesis | use the loaded model for planning, analysis, contradictions |
| Safe Search | passed to scraped engines |
| Local Document Sources | include indexed collections in research runs |
| SearXNG Base URL | e.g. `http://localhost:8888`. Needs `formats: [html, json]` in the instance settings |

## How a run works

1. The topic gets split into specialized queries (by the loaded model, or by
   templates without one).
2. Queries go out to the engines suited to each scope — academic queries hit
   OpenAlex/arXiv, reference queries hit Wikipedia, general ones hit SearXNG/
   DDG/Brave.
3. Results land in one ranked queue. Crawlers pull from it, fetch pages,
   extract text, drop off-topic or duplicated content, count against the
   global budget.
4. Each round's findings get distilled into learnings. Uncovered angles
   trigger another round until budget, time, coverage, or stagnation ends it.
5. The report: written analysis with inline citations, contradictions between
   sources, a dimension coverage table, source details, and engine
   diagnostics.

## Building and testing

```
npm install
npm test     # unit tests — ranking, BM25 accounting, dedup, SSRF guard
npm run build
npm run dev  # run against LM Studio
```

No engine requires an API key. Scraped engines (DuckDuckGo, Brave) may break
when those sites change or block you — that shows up clearly in the run
diagnostics rather than failing silently. Their usage also isn't something
those sites officially permit, which is worth knowing even if plenty of tools
do the same.

MIT License.
