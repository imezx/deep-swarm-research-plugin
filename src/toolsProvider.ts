/**
 * @file toolsProvider.ts
 * Tool registration. Thin — logic lives in pipeline/synthesis/local modules.
 */
import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./config";
import { runDeepResearch } from "./engine-entry";
import { errorMessage, isAbortError } from "./core/types";
import { getDocumentStore } from "./local/store";
import { setSearxngEndpoint } from "./engines/searxng";

function readConfig(ctl: ToolsProviderController) {
  const c = ctl.getPluginConfig(configSchematics);
  return {
    depthPreset: c.get("researchDepth") as "shallow" | "standard" | "deep" | "deeper" | "exhaustive",
    /** Raw stored number; 0 (or junk ≤0) = Auto → depth-scaled limit. */
    contentLimitRaw: c.get("contentLimitPerPage") as number,
    enableLinkFollowing: (c.get("enableLinkFollowing") as string) === "on",
    enableAIPlanning: (c.get("enableAIPlanning") as string) === "on",
    safeSearch: (c.get("safeSearch") as "strict" | "moderate" | "off"),
    searxngBaseUrl: (c.get("searxngBaseUrl") as string) ?? "",
    /** Minutes; 0 ⇒ unlimited. */
    researchTimeoutMinutes: c.get("researchTimeoutMinutes") as number,
    enableLocalSources: (c.get("enableLocalSources") as string) === "on",
  };
}

export async function toolsProvider(
  ctl: ToolsProviderController,
): Promise<Tool[]> {
  const cfg = readConfig(ctl);
  // Plugin config owns the SearXNG endpoint (may be a local address).
  setSearxngEndpoint(cfg.searxngBaseUrl);

  const deepResearchTool = tool({
    name: "Deep Research",
    description: `Runs an autonomous multi-round research session on a topic.

The topic is split into specialized queries (optionally by the loaded model).
Results come from Wikipedia, OpenAlex, and arXiv APIs first; DuckDuckGo and
Brave are used as general-web fallbacks, or a configured SearXNG instance if
set. Pages are ranked by source authority, filtered for relevance, and
deduplicated before acceptance against a global page budget. Uncovered
research dimensions trigger follow-up rounds until the budget, coverage, or
time limit is reached.

The result is a Markdown report: written analysis with inline citations
(when a model is loaded), detected contradictions, a coverage table, the
source list with metadata, and engine diagnostics for the run.

Always call this tool before answering a research question — never compose a
research answer from memory alone. After the tool returns, answer the user in
plain prose or Markdown based on the report. Do not reply with JSON.

Use this tool when thorough, cited research is needed. Not for simple lookups.`,
    parameters: {
      topic: z.string().min(3).describe("The research topic or question. Be specific."),
      focusAreas: z.array(z.string()).max(6).optional()
        .describe("Optional angles to emphasize, e.g. ['side effects', 'FDA status']."),
      depthOverride: z.enum(["shallow", "standard", "deep", "deeper", "exhaustive"]).optional()
        .describe("Override research depth for this call."),
      contentLimitOverride: z.number().int().min(1000).max(20000).optional()
        .describe("Chars of extracted content per page for this call."),
    },
    implementation: async (
      { topic, focusAreas, depthOverride, contentLimitOverride },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);
      try {
        const result = await runDeepResearch(
          {
            topic,
            focusAreas: focusAreas ?? [],
            depthPreset: depthOverride ?? cfg.depthPreset,
            timeoutMs: cfg.researchTimeoutMinutes > 0
              ? Math.round(cfg.researchTimeoutMinutes * 60_000)
              : null,
            contentLimitPerPage:
              contentLimitOverride ??
              (cfg.contentLimitRaw > 0 ? cfg.contentLimitRaw : null),
            enableLinkFollowing: cfg.enableLinkFollowing,
            enableAIPlanning: cfg.enableAIPlanning,
            safeSearch: cfg.safeSearch,
            enableLocalSources: cfg.enableLocalSources,
          },
          status,
          warn,
          signal,
        );

        const r = result.report;
        // Plain Markdown with a small stats header — structured JSON wrappers
        // make small local models echo JSON back instead of using the report.
        return [
          `Research complete: ${result.totalSources} sources, ` +
          `${result.roundsRun} round(s), ${result.queriesUsed.length} queries. ` +
          `Coverage: ${r.coveredDims.length}/12 dimensions` +
          (r.contradictions.length > 0 ? `, ${r.contradictions.length} contradiction(s) detected.` : "."),
          "",
          "Present the report below to the user as-is; summarize in your own words afterwards.",
          "",
          r.markdown,
        ].join("\n");
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return "Research cancelled by user.";
        warn(`Deep research error: ${errorMessage(err)}`);
        return `Error during deep research: ${errorMessage(err)}`;
      }
    },
  });

  const localDocsAddTool = tool({
    name: "Local Docs Add Collection",
    description:
      "Index a local folder into a searchable document collection. The index is " +
      "saved to disk and available in future sessions. Deep Research uses these " +
      "collections when Local Document Sources is enabled.",
    parameters: {
      name: z.string().min(1).max(100).describe("Descriptive collection name."),
      folderPath: z.string().min(1).describe("Absolute path to the documents folder."),
    },
    implementation: async ({ name, folderPath }, { status }) => {
      try {
        const store = getDocumentStore();
        const info = store.indexCollection(name, folderPath, status);
        return {
          success: true,
          collection: info,
          note: "Indexed AND persisted — available in future sessions automatically.",
        };
      } catch (err) {
        return `Error indexing collection: ${errorMessage(err)}`;
      }
    },
  });

  const localDocsListTool = tool({
    name: "Local Docs List Collections",
    description: "List indexed local collections with stats.",
    parameters: {},
    implementation: async () => {
      const store = getDocumentStore();
      const collections = store.getCollections();
      if (collections.length === 0) {
        return { collections: [], message: "No collections indexed yet." };
      }
      return { collections };
    },
  });

  const localDocsRemoveTool = tool({
    name: "Local Docs Remove Collection",
    description: "Remove an indexed local collection by ID (also deletes its disk snapshot).",
    parameters: {
      collectionId: z.string().uuid().describe("UUID of the collection to remove."),
    },
    implementation: async ({ collectionId }, { status }) => {
      const store = getDocumentStore();
      const target = store.getCollections().find((c) => c.id === collectionId);
      if (!target) return `Collection not found: ${collectionId}`;
      const removed = store.removeCollection(collectionId);
      if (removed) {
        status(`Removed "${target.name}"`);
        return { success: true, removedCollection: target.name };
      }
      return "Failed to remove collection.";
    },
  });

  const localDocsSearchTool = tool({
    name: "Local Docs Search",
    description:
      "BM25 search across your indexed local collections. For blended local+web research use Deep Research.",
    parameters: {
      query: z.string().min(2).describe("Natural-language search query."),
      maxResults: z.number().int().min(1).max(20).optional()
        .describe("Maximum results (default 8)."),
    },
    implementation: async ({ query, maxResults }, { status }) => {
      const store = getDocumentStore();
      if (!store.hasCollections()) {
        return "No collections indexed. Use 'Local Docs Add Collection' first.";
      }
      status(`Searching local documents: "${query}"`);
      const hits = store.search(query, maxResults ?? 8);
      if (hits.length === 0) return { results: [], message: "No relevant chunks found." };
      return hits.map((h, i) => ({
        rank: i + 1,
        collection: h.collectionName,
        file: h.fileName,
        score: Math.round(h.score * 1000) / 1000,
        wordCount: h.wordCount,
        content: h.text,
      }));
    },
  });

  return [
    deepResearchTool,
    localDocsAddTool,
    localDocsListTool,
    localDocsRemoveTool,
    localDocsSearchTool,
  ];
}
