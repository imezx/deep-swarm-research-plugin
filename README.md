# Deep Research w/ Swarm Agent

Autonomous deep web research for LM Studio. A swarm of specialized workers searches, reads, scores, and synthesizes web sources into a structured report - one tool call, no API keys.

---

## Tools

### Deep Research
The main tool. Give it a topic, get back a full Markdown report with AI-written analysis, citations, contradiction detection, and a coverage breakdown across 12 research dimensions.

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

---

## How It Works

1. **Decomposes** the topic into specialized workers (upto 10 roles: breadth, depth, recency, academic, critical, statistical, regulatory, technical, primary sources, comparative)
2. **Searches** across multiple engines in parallel - DuckDuckGo, Brave, Google Scholar, SearXNG, Mojeek (all scraped, no keys)
3. **Fetches & extracts** pages with aggressive boilerplate removal, relevance scoring, and duplicate detection
4. **Follows links** recursively (1–3 levels deep depending on depth preset)
5. **Detects gaps** across 12 research dimensions and spawns targeted follow-up workers
6. **Stops intelligently** - when coverage is complete, sources stagnate, or rounds run out
7. **Synthesizes** a narrative report with inline citations and contradiction detection

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

No hard source cap - collection is fully adaptive.

---

## Configuration

| Setting | Description |
|---|---|
| Research Depth | Shallow → Exhaustive (scales everything) |
| Content Per Page | Chars extracted per page (auto-scales, up to 20K) |
| Link Following | Follow in-page citations and references |
| AI Query Planning | Use loaded model for query generation and synthesis |
| Safe Search | DuckDuckGo safe search level |

---

## Recommended System Prompt

```
When the user asks for research or wants to understand a topic in depth, use the "Deep Research" tool. After receiving the report:
1. Lead with the AI Research Analysis - it's the main synthesis.
2. Check the Contradictions section for disagreements between sources.
3. Cite sources by index: [1], [2], etc.
4. Note any coverage gaps and offer to dig deeper.
5. Present both sides where sources conflict.
```

---

MIT License