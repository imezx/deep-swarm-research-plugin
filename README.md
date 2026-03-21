# Deep Research & Agent

A deep research engine for LM Studio, built around a **Kimi-style Agent Swarm**. Dynamically spawned specialised worker agents run in parallel, coordinating through shared state to produce a comprehensive, cited research report with contradiction detection — in a single tool call.

---

## Tools

### 1. Deep Research
The flagship tool. Pass it a topic; it returns a fully structured Markdown report with AI narrative synthesis.

**Parameters:**
- `topic` *(required)* — Research topic or question. Be specific.
- `focusAreas` *(optional)* — Sub-topics to emphasise, e.g. `["side effects", "clinical trials"]`
- `depthOverride` *(optional)* — `"shallow"` / `"standard"` / `"deep"`
- `maxSourcesOverride` *(optional)* — Override max sources (5–30)
- `contentLimitOverride` *(optional)* — Override chars-per-page (1000–10000)

### 2. Research Search
DuckDuckGo search with scored, ranked results and real snippet extraction.

### 3. Research Read Page
Fetch and extract a single URL using Mozilla Readability.

### 4. Research Multi-Read
Concurrent batch fetch of up to 10 URLs (3 at a time).

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| Research Depth | Standard | `Shallow` = 1 round · `Standard` = 2 rounds · `Deep` = 3 rounds |
| Max Sources Total | 15 | Hard cap across all workers and rounds (8–30) |
| Content Per Page | 4000 chars | Characters extracted per page (1000–10000) |
| Link Following | On | Depth and Academic workers follow in-page citations |
| AI Query Planning | On | Enables AI decomposition, synthesis, and contradictions |
| Safe Search | Moderate | Strict / Moderate / Off |

---

## Recommended System Prompt Addition

```
When the user requests research, analysis, or wants to understand a topic thoroughly,
use the "Deep Research" tool. After receiving the report:
1. Read the AI Research Analysis section first — it's the primary synthesis.
2. Check the Contradictions section for areas where sources disagree.
3. Cite sources using their index numbers: [1], [2], etc.
4. Note any research dimension gaps and offer to run a follow-up search.
5. If contradictions exist, present both sides fairly to the user.
```

---

## License — MIT
