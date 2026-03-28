# Deep Research w/ Swarm Agent

Autonomous deep research for LM Studio. A swarm of specialized workers searches the web and your local documents, then synthesizes everything into a structured report — one tool call, no API keys.

---

## Tools

### Deep Research
The main tool. Give it a topic, get back a full Markdown report with AI-written analysis, citations, contradiction detection, and a coverage breakdown across 12 research dimensions. When local document sources are enabled, workers search your indexed collections first and fill gaps from the web.

**Parameters:**
- `topic` - what to research (be specific)
- `focusAreas` - optional angles to emphasize, e.g. `["side effects", "FDA status"]`
- `depthOverride` - `"shallow"` / `"standard"` / `"deep"` / `"deeper"` / `"exhaustive"`
- `contentLimitOverride` - chars per page (1K–20K, auto-scales with depth)

### Research Search
Scored DuckDuckGo results with domain authority tiers and snippet extraction.

### Research Read Page
Fetch and extract a single URL. Handles PDFs automatically.

### Research Multi-Read
Batch-fetch up to 10 URLs concurrently.

### Local Docs Add Collection
Index a local folder into a searchable collection. Recursively scans subdirectories, supports 30+ file types (text, markdown, HTML, code, CSV, JSON, XML, config files, and more). Each collection gets a name you choose — re-indexing the same folder replaces the old one.

### Local Docs List Collections
Show all indexed collections with file counts, chunk counts, word totals, and index dates.

### Local Docs Remove Collection
Remove an indexed collection by its ID.

### Local Docs Search
Search across your indexed collections directly. Returns the most relevant chunks ranked by keyword relevance. For full research that blends local and web sources, use Deep Research instead.

---

## How It Works

1. **Decomposes** the topic into specialized workers (up to 10 roles: breadth, depth, recency, academic, critical, statistical, regulatory, technical, primary sources, comparative)
2. **Searches local documents first** — when enabled, each worker queries your indexed collections and claims up to 30% of its page budget from local sources before touching the web
3. **Searches the web** across multiple engines in parallel — DuckDuckGo, Brave, Google Scholar, SearXNG, Mojeek (all scraped, no keys)
4. **Fetches & extracts** pages with aggressive boilerplate removal, relevance scoring, and duplicate detection
5. **Follows links** recursively (1–3 levels deep depending on depth preset)
6. **Detects gaps** across 12 research dimensions and spawns targeted follow-up workers
7. **Stops intelligently** — when coverage is complete, sources stagnate, or rounds run out
8. **Synthesizes** a narrative report with inline citations, contradiction detection, and source origin tags (web vs local)

---

## Local Document Sources

Index your proprietary files once, then every Deep Research session can draw from them alongside the web. This gives you a progressive source approach — local knowledge first, public web to fill gaps.

**Quick start:**

1. Use **Local Docs Add Collection** to index a folder (e.g. your research papers, internal reports, legal docs)
2. Turn on **Local Document Sources** in plugin settings
3. Run **Deep Research** as usual — workers will search your collections automatically

You can create multiple collections for different domains. The report marks each source as `[local]` or web so you always know where information came from.

**Supported file types:** `.txt`, `.md`, `.html`, `.csv`, `.json`, `.xml`, `.log`, and many more.

---

## Depth Presets

| | Shallow | Standard | Deep | Deeper | Exhaustive |
|---|---|---|---|---|---|
| Rounds | 1 | 3 | 5 | 10 | 15 |
| Worker roles | 5 | 5 | 8 | 10 | 10 |
| Pages/worker | 5 | 8 | 12 | 18 | 25 |
| Search engines | 1 | 2 | 3 | 4 | 5 |
| Link depth | 1 | 1 | 2 | 2 | 3 |
| Fan-out | ×1 | ×1 | ×2 | ×2 | ×3 |
| Content/page | 5K | 6K | 8K | 12K | 16K |
| ~Sources | 25–50 | 40–80 | 80–150 | 150–250+ | 250–400+ |

No hard source cap — collection is fully adaptive. Local sources are additional — they don't eat into the web budget shown above.

---

## Configuration

| Setting | Description |
|---|---|
| Research Depth | Shallow -> Exhaustive (scales everything) |
| Content Per Page | Chars extracted per page (auto-scales, up to 20K) |
| Link Following | Follow in-page citations and references |
| AI Query Planning | Use loaded model for query generation and synthesis |
| Safe Search | DuckDuckGo safe search level |
| Local Document Sources | Search indexed local collections alongside the web |

---

## Recommended System Prompt

```
When the user asks for research or wants to understand a topic in depth, use the "Deep Research" tool. After receiving the report:
1. Lead with the AI Research Analysis - it's the main synthesis.
2. Check the Contradictions section for disagreements between sources.
3. Cite sources by index: [1], [2], etc.
4. Note any coverage gaps and offer to dig deeper.
5. Present both sides where sources conflict.
6. Distinguish between local and web sources when relevant.
```

---

MIT License
