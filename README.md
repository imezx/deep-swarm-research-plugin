# Deep Research w/ Swarm Agent

Autonomous deep research for LM Studio. A swarm of specialized workers searches your **local libraries** and the web, then synthesizes everything into a structured report - one tool call, no API keys.

---

## Tools

### # Deep Research
The main tool. Give it a topic, get back a full Markdown report with AI-written analysis, citations, contradiction detection, and a coverage breakdown across 12 research dimensions. When local document sources are enabled, workers search your RAG libraries progressively - proprietary first, web to fill gaps.

**Parameters:**
- `topic` - what to research (be specific)
- `focusAreas` - optional angles to emphasize, e.g. `["side effects", "FDA status"]`
- `depthOverride` - `"shallow"` / `"standard"` / `"deep"` / `"deeper"` / `"exhaustive"`
- `contentLimitOverride` - chars per page (1K-20K, auto-scales with depth)

### # Research Search
Scored DuckDuckGo results with domain authority tiers and snippet extraction.

### # Research Read Page
Fetch and extract a single URL. Handles PDFs automatically.

### # Research Multi-Read
Batch-fetch up to 10 URLs concurrently.

---

## Local Library Tools

### # Add Library
Index a local folder into a searchable library with full metadata.

**Parameters:**
- `name` - descriptive name (e.g. "Company Policies", "Research Papers")
- `folderPath` - absolute path to the document folder
- `priority` - `"proprietary"` / `"internal"` / `"reference"` / `"general"` (default: general)
- `tags` - array of routing tags: `["legal"]`, `["academic", "technical"]`, `["financial", "reports"]`, etc.
- `description` - optional description

**Example usage:**
```
RAG Add Library(
  name: "Client Contracts",
  folderPath: "/home/user/documents/contracts",
  priority: "proprietary",
  tags: ["legal"],
  description: "All active client contracts and SLAs"
)
```

### # List Libraries
Show all indexed libraries sorted by priority, with file counts, chunk counts, word totals, tags, and file type breakdown.

### # Remove Library
Remove a library by its UUID (id).

### # Search
Search across libraries with BM25 + fuzzy hybrid scoring mechanism.

**Features:**
- Progressive mode (default): searches proprietary -> internal -> reference -> general
- Context windows: includes surrounding chunk text with each result
- Library-specific search: filter to a single library by ID
- Heading-aware: boosts results where the query matches section headings

### # Update Library
Change a library's name, description, priority, or tags without re-indexing.

### # Check Changes
Detect modified, deleted, and newly added files since last indexing.

### # Save Index
Persist the entire RAG index to a JSON file on disk.

### # Load Index
Restore a previously saved index - instant library access without re-scanning.

### # Legacy
The previous `Local Docs Add/List/Remove/Search Collection` tools still work as aliases for backward compatibility.

**Supported file types:** `.txt`, `.md`, `.html`, `.csv`, `.json`, `.xml`, `.log`, and many more.

---

## How It Works

1. **Decomposes** the topic into specialized workers (up to 10 roles: breadth, depth, recency, academic, critical, statistical, regulatory, technical, primary sources, comparative)
2. **Searches local/RAG libraries progressively** - proprietary -> internal -> reference -> general, with auto-routing by tag. Each worker claims up to 30% of its page budget from local sources before touching the web
3. **Searches the web** across multiple engines in parallel - DuckDuckGo, Brave, Google Scholar, SearXNG, Mojeek (all scraped, no keys)
4. **Fetches & extracts** pages with aggressive boilerplate removal, relevance scoring, and duplicate detection
5. **Follows links** recursively (1-3 levels deep depending on depth preset)
6. **Detects gaps** across 12 research dimensions and spawns targeted follow-up workers
7. **Stops intelligently** - when coverage is complete, sources stagnate, or rounds run out
8. **Synthesizes** a narrative report with inline citations, contradiction detection, and source origin tags (web vs local)

---

## Progressive Source Approach

This is the key innovation for organizations with large proprietary datalakes. Instead of treating all sources equally, the plugin searches in priority order:

```
┌─────────────────────┐
│  1. PROPRIETARY      │  < Your confidential data (contracts, internal memos, trade secrets)
│     Searched first   │
├─────────────────────┤
│  2. INTERNAL         │  < Shared team knowledge (wikis, documentation, reports)
│     Searched second  │
├─────────────────────┤
│  3. REFERENCE        │  < Curated reference materials (papers, standards, regulations)
│     Searched third   │
├─────────────────────┤
│  4. GENERAL          │  < Miscellaneous local documents
│     Searched fourth  │
├─────────────────────┤
│  5. WEB              │  < Public internet (fills remaining gaps)
│     Searched last    │
└─────────────────────┘
```

Workers also auto-route to the right library by tag:
- **Academic worker** -> searches `academic` and `technical` tagged libraries
- **Regulatory worker** -> searches `legal` and `policy` tagged libraries  
- **Technical worker** -> searches `technical` and `code` tagged libraries
- **Statistical worker** -> searches `financial` and `reports` tagged libraries

---

## Quick Start

**1. Index your document libraries:**
```
RAG Add Library(name: "Research Papers", folderPath: "/papers", priority: "reference", tags: ["academic"])
RAG Add Library(name: "Internal Docs", folderPath: "/company/docs", priority: "internal", tags: ["reports"])
RAG Add Library(name: "Legal", folderPath: "/legal", priority: "proprietary", tags: ["legal", "policy"])
```

**2. Enable local sources** in plugin settings (Local Document Sources -> On)

**3. Run Deep Research** as usual - workers will search your libraries progressively

**4. Save your index** so you don't need to re-index next session:
```
RAG Save Index(filePath: "~/.lmstudio/rag-index.json")
```

**5. Next session, load it back:**
```
RAG Load Index(filePath: "~/.lmstudio/rag-index.json")
```

---

## Depth Presets

| | Shallow | Standard | Deep | Deeper | Exhaustive |
|---|---|---|---|---|---|
| Rounds | 1 | 3 | 5 | 10 | 15 |
| Worker roles | 5 | 5 | 8 | 10 | 10 |
| Pages/worker | 5 | 8 | 12 | 18 | 25 |
| Search engines | 1 | 2 | 3 | 4 | 5 |
| Link depth | 1 | 1 | 2 | 2 | 3 |
| Fan-out | x1 | x1 | x2 | x2 | x3 |
| Content/page | 5K | 6K | 8K | 12K | 16K |
| Sources (upto) | ~25-50 | ~40-80 | ~80-150 | ~150-250+ | ~250-400+ |

No hard source cap - collection is fully adaptive. Local sources are additional - they don't eat into the web budget shown above.

---

## Configuration

| Setting | Description |
|---|---|
| Research Depth | Shallow -> Exhaustive (scales everything) |
| Content Per Page | Chars extracted per page (auto-scales, up to 20K) |
| Link Following | Follow in-page citations and references |
| AI Query Planning | Use loaded model for query generation and synthesis |
| Safe Search | DuckDuckGo safe search level |
| Local Document Sources | Search indexed local/RAG libraries alongside the web |

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
7. Prioritise findings from proprietary/internal sources when only they're available.
```

---

MIT License
