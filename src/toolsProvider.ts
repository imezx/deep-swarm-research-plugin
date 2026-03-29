/**
 * @file toolsProvider.ts
 * Registers all four tools with LM Studio.
 */

import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";

import { configSchematics } from "./config";
import { runDeepResearch } from "./researcher";
import { ResearchConfig } from "./types";
import { DepthPreset, getDepthProfile } from "./constants";
import { searchDDG } from "./net/ddg";
import { fetchPage } from "./net/http";
import { extractPage, computeRelevance } from "./net/extractor";
import {
  isPdfUrl,
  isPdfContentType,
  extractPdf,
  PdfImage,
} from "./net/pdf-extractor";
import { scoreCandidate, rankCandidates } from "./scoring/authority";
import { sleep } from "./net/http";
import {
  MULTI_READ_BATCH_DELAY_MS,
  CONTENT_LIMIT_MIN,
  CONTENT_LIMIT_MAX,
  CONTENT_LIMIT_EXTENDED,
  CONTENT_LIMIT_DEFAULT,
  SEARCH_RESULTS_MIN,
  SEARCH_RESULTS_MAX,
} from "./constants";

import { getGlobalStore, LocalCollection } from "./local/store";
import { isLocalUrl } from "./local/search";

function readConfig(ctl: ToolsProviderController) {
  const c = ctl.getPluginConfig(configSchematics);
  const depth = c.get("researchDepth") as string;
  const depthPreset: DepthPreset =
    depth === "shallow"
      ? "shallow"
      : depth === "deep"
        ? "deep"
        : depth === "deeper"
          ? "deeper"
          : depth === "exhaustive"
            ? "exhaustive"
            : "standard";
  return {
    depthPreset,
    contentLimitPerPage:
      (c.get("contentLimitPerPage") as number) ||
      getDepthProfile(depthPreset).defaultContentLimit,
    enableLinkFollowing: (c.get("enableLinkFollowing") as string) !== "off",
    enableAIPlanning: (c.get("enableAIPlanning") as string) !== "off",
    safeSearch:
      (c.get("safeSearch") as "strict" | "moderate" | "off") || "moderate",
    enableLocalSources: (c.get("enableLocalSources") as string) !== "off",
  } as const;
}

export async function toolsProvider(
  ctl: ToolsProviderController,
): Promise<Tool[]> {
  const deepResearchTool = tool({
    name: "Deep Research",
    description: `Performs autonomous, multi-round deep web research using a Kimi-style Agent Swarm with AI-powered synthesis.

HOW IT WORKS:
  1. AI TASK DECOMPOSITION: The loaded model analyses the topic and dynamically creates specialised worker agents with roles. Each worker gets custom queries tailored to its assignment.

  2. PARALLEL SWARM EXECUTION: All workers launch simultaneously:
     • Workers search DuckDuckGo, score candidates by domain authority, fetch pages concurrently
     • Post-fetch RELEVANCE FILTERING discards off-topic pages
     • Multi-window content fingerprinting prevents duplicates
     • Depth and Academic workers follow in-page citations

  3. INTER-AGENT COMMUNICATION: After Round 1, an AI coordinator summarises key findings and suggests follow-up angles for gap-fill workers.

  4. ADAPTIVE GAP-FILL: Coverage gaps are filled by TARGETED workers (e.g., Academic worker for missing evidence, Critical worker for missing controversy).

  5. ADAPTIVE SOURCE COLLECTION: No hard source cap — each worker has its own page budget that scales with depth preset. Collection stops only when: all research dimensions are covered, a round yields zero new sources (stagnation), or all rounds are exhausted.

  6. AI NARRATIVE SYNTHESIS: The loaded model writes a coherent, multi-paragraph research analysis with inline citations.

  7. CONTRADICTION DETECTION: The model identifies claims where sources disagree, with severity ratings.

  8. LOCAL DOCUMENT INTEGRATION: When enabled, each worker searches your indexed local document collections BEFORE hitting the web. Local sources are blended with web results in the final report, giving you a progressive source approach — proprietary knowledge first, public web to fill gaps.

WHAT YOU GET:
  A structured Markdown report including:
  - AI-written narrative analysis (primary section)
  - Cross-source contradictions with severity ratings
  - Coverage table (upto 12 research dimensions)
  - Swarm activity summary (sources per worker)
  - Cross-source consensus detection
  - Key findings grouped by dimension (detail layer)
  - Full source details with domain authority, relevance score, and publication date
  - Numbered citation index

USE THIS TOOL for thorough, cited research. Not for simple lookups.
When Local Document Sources is enabled in settings, your indexed local collections are searched alongside the web — each worker draws from your proprietary data first, then fills gaps from public sources.`,
    parameters: {
      topic: z
        .string()
        .min(3)
        .describe(
          "The research topic or question. Be specific. " +
            "Example: 'long-term safety profile of GLP-1 receptor agonists' rather than just 'weight loss drugs'.",
        ),
      focusAreas: z
        .array(z.string())
        .max(6)
        .optional()
        .describe(
          "Optional sub-topics or angles to emphasise across all worker queries. " +
            "Example: ['side effects', 'clinical trial data', 'FDA approval status']",
        ),
      depthOverride: z
        .enum(["shallow", "standard", "deep", "deeper", "exhaustive"])
        .optional()
        .describe(
          "Override depth for this call only. " +
            "shallow = 1 round (~10-25 sources, fast) · " +
            "standard = 3 rounds (~30-60 sources) · " +
            "deep = 5 rounds (~60-120 sources, thorough) · " +
            "deeper = 10 rounds (~100-200+ sources, very thorough) · " +
            "exhaustive = 15 rounds (200+ sources, maximum depth)",
        ),
      contentLimitOverride: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_MAX)
        .optional()
        .describe(
          "Override chars-per-page for this call only. " +
            "Higher = richer context per source but slower overall.",
        ),
    },

    implementation: async (
      { topic, focusAreas, depthOverride, contentLimitOverride },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);

      const researchCfg: ResearchConfig = {
        topic,
        focusAreas: focusAreas ?? [],
        depthPreset: (depthOverride as DepthPreset) ?? cfg.depthPreset,
        contentLimitPerPage: contentLimitOverride ?? cfg.contentLimitPerPage,
        enableLinkFollowing: cfg.enableLinkFollowing,
        enableAIPlanning: cfg.enableAIPlanning,
        safeSearch: cfg.safeSearch,
        enableLocalSources: cfg.enableLocalSources,
      };

      try {
        const result = await runDeepResearch(researchCfg, status, warn, signal);

        return {
          topic,
          totalRounds: result.totalRounds,
          totalSources: result.totalSources,
          queriesUsed: result.queriesUsed,
          coveredDimensions: result.report.coveredDims,
          gapDimensions: result.report.gapDims,
          hasAISynthesis: !!result.report.aiSynthesis,
          contradictions: result.report.contradictions.length,
          report: result.report.markdown,
          sourceIndex: result.report.sources.map((s) => ({
            index: s.index,
            title: s.title,
            url: s.url,
            published: s.published,
            domainScore: s.domainScore,
            tier: s.tier,
            workerRole: s.workerRole,
            workerLabel: s.workerLabel,
            relevance: Math.round(s.relevanceScore * 100),
            origin: s.origin,
            excerpt: s.description.slice(0, 200),
          })),
        };
      } catch (err: unknown) {
        if (isAbortError(err) || signal.aborted)
          return "Research cancelled by user.";
        const msg = errorMessage(err);
        warn(`Deep research error: ${msg}`);
        return `Error during deep research: ${msg}`;
      }
    },
  });

  const researchSearchTool = tool({
    name: "Research Search",
    description:
      "Search DuckDuckGo and return scored, ranked results with domain authority tiers. " +
      "Each result includes a domain score (0-100), source tier (academic/government/news/etc.), " +
      "URL quality score, and freshness estimate. Results are ranked by combined quality. " +
      "Use this for focused lookups. For full research, use 'Deep Research'.",
    parameters: {
      query: z
        .string()
        .min(2)
        .describe(
          "Search query — use natural language as you would type into a search engine.",
        ),
      maxResults: z
        .number()
        .int()
        .min(SEARCH_RESULTS_MIN)
        .max(SEARCH_RESULTS_MAX)
        .optional()
        .describe("Max results to return (default: 8)."),
    },

    implementation: async ({ query, maxResults }, { status, warn, signal }) => {
      const cfg = readConfig(ctl);
      const max = maxResults ?? 8;

      status(`Searching: "${query}"`);

      try {
        const hits = await searchDDG(query, max, cfg.safeSearch, signal);
        const scored = hits.map((h) => scoreCandidate(h, query));
        const ranked = rankCandidates(scored, max);

        status(`Found ${ranked.length} ranked results.`);

        return ranked.map((c, i) => ({
          rank: i + 1,
          url: c.url,
          title: c.title,
          snippet: c.snippet,
          domainScore: c.domainScore,
          freshnessScore: c.freshnessScore,
          urlQuality: c.urlQuality,
          totalScore: c.totalScore,
          tier: c.tier,
        }));
      } catch (err: unknown) {
        if (isAbortError(err) || signal.aborted) return "Search cancelled.";
        const msg = errorMessage(err);
        warn(`Search error: ${msg}`);
        return `Error during search: ${msg}`;
      }
    },
  });

  const researchReadPageTool = tool({
    name: "Research Read Page",
    description:
      "Visit a URL and return cleanly extracted text using Mozilla Readability " +
      "(the same engine as Firefox Reader Mode). " +
      "Automatically detects PDF URLs (arXiv, Springer, IEEE, etc.) and extracts " +
      "text content and embedded images from the PDF instead of returning garbled bytes. " +
      "Also returns: title, description, detected publication date, word count, " +
      "domain authority score, source tier, and top outbound links. " +
      "For PDFs, embedded images are saved to temp files and returned as file paths " +
      "with dimensions and size metadata (not inline base64). " +
      "Use this to read individual pages. For reading multiple URLs at once use 'Research Multi-Read'.",
    parameters: {
      url: z.string().url().describe("The URL to visit and read."),
      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract from the page " +
            "(default: plugin content-per-page setting).",
        ),
    },

    implementation: async ({ url, contentLimit }, { status, warn, signal }) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;

      status(`Reading: ${url}`);

      try {
        const fetchResult = await fetchPage(url, signal);
        const { finalUrl } = fetchResult;

        const isPdf =
          (fetchResult.rawBuffer &&
            isPdfContentType(fetchResult.contentType)) ||
          (!fetchResult.rawBuffer && isPdfUrl(url));

        let page: ReturnType<typeof extractPage> & {
          images?: ReadonlyArray<PdfImage>;
        };
        let images: ReadonlyArray<PdfImage> = [];

        if (isPdf && fetchResult.rawBuffer) {
          status("Found PDF — extracting contents");
          const pdfResult = await extractPdf(
            fetchResult.rawBuffer,
            url,
            finalUrl,
            limit,
            true,
            20,
          );
          page = pdfResult;
          images = pdfResult.images;
        } else if (
          isPdf &&
          fetchResult.html &&
          fetchResult.html.startsWith("%PDF")
        ) {
          status("Found PDF — extracting contents");
          const buf = Buffer.from(fetchResult.html, "binary");
          const pdfResult = await extractPdf(
            buf,
            url,
            finalUrl,
            limit,
            true,
            20,
          );
          page = pdfResult;
          images = pdfResult.images;
        } else {
          page = extractPage(fetchResult.html, url, finalUrl, limit);
        }

        const scored = scoreCandidate(
          { url, title: page.title, snippet: page.description },
          "",
        );

        status(
          images.length > 0
            ? `Page read successfully. Extracted ${images.length} image(s).`
            : "Page read successfully.",
        );

        const result: Record<string, unknown> = {
          url: page.finalUrl,
          title: page.title,
          description: page.description,
          published: page.published,
          wordCount: page.wordCount,
          domainScore: scored.domainScore,
          tier: scored.tier,
          content: page.text,
          topLinks: page.outlinks.slice(0, 10).map((l) => ({
            text: l.text,
            href: l.href,
          })),
        };

        if (images.length > 0) {
          result.images = images.map((img, idx) => ({
            index: idx + 1,
            page: img.page,
            format: img.format,
            width: img.width,
            height: img.height,
            sizeKB: Math.round(img.byteSize / 1024),
            filePath: img.filePath,
          }));
          result.imageCount = images.length;

          const imageNote = images
            .map(
              (img, idx) =>
                `[Image ${idx + 1} on page ${img.page}: ${img.width}×${img.height}, ${Math.round(img.byteSize / 1024)} KB — saved to ${img.filePath}]`,
            )
            .join("\n");
          result.content =
            (result.content as string) +
            "\n\n--- Extracted Images ---\n" +
            imageNote;
        }

        return result;
      } catch (err: unknown) {
        if (isAbortError(err) || signal.aborted) return "Page read cancelled.";
        const msg = errorMessage(err);
        warn(`Read error: ${msg}`);
        return `Error reading page: ${msg}`;
      }
    },
  });

  const researchMultiReadTool = tool({
    name: "Research Multi-Read",
    description:
      "Fetch up to 10 URLs concurrently (3 at a time) and return extracted text " +
      "and metadata for all of them. Automatically handles PDF URLs — extracts " +
      "clean text instead of returning garbled binary data. Returns domain authority " +
      "score, publication date, and word count per page. " +
      "Use this when you already have a list of URLs and want to read them all " +
      "at once without running a full deep research session.",
    parameters: {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(10)
        .describe("List of URLs to read (1-10)."),
      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract per page " +
            "(default: plugin content-per-page setting).",
        ),
    },

    implementation: async (
      { urls, contentLimit },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;

      status(`Reading ${urls.length} page(s) — 3 at a time…`);

      const CONCURRENCY = 3;
      const results: Array<{
        index: number;
        url: string;
        title: string;
        published: string | null;
        wordCount: number;
        domainScore: number;
        tier: string;
        content: string;
        error: string | null;
      }> = [];

      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        if (signal.aborted) break;

        const batch = urls.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (url, bi) => {
            const fetchResult = await fetchPage(url, signal);
            const { finalUrl } = fetchResult;

            const isPdf =
              (fetchResult.rawBuffer &&
                isPdfContentType(fetchResult.contentType)) ||
              (!fetchResult.rawBuffer && isPdfUrl(url));

            let page;
            if (isPdf && fetchResult.rawBuffer) {
              page = await extractPdf(
                fetchResult.rawBuffer,
                url,
                finalUrl,
                limit,
                false,
              );
            } else if (
              isPdf &&
              fetchResult.html &&
              fetchResult.html.startsWith("%PDF")
            ) {
              const buf = Buffer.from(fetchResult.html, "binary");
              page = await extractPdf(buf, url, finalUrl, limit, false);
            } else {
              page = extractPage(fetchResult.html, url, finalUrl, limit);
            }

            const scored = scoreCandidate(
              { url, title: page.title, snippet: page.description },
              "",
            );
            return {
              index: i + bi + 1,
              url: page.finalUrl,
              title: page.title,
              published: page.published,
              wordCount: page.wordCount,
              domainScore: scored.domainScore,
              tier: scored.tier,
              content: page.text,
              error: null as string | null,
            };
          }),
        );

        for (let bi = 0; bi < settled.length; bi++) {
          const outcome = settled[bi];
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
          } else {
            const msg = errorMessage(outcome.reason);
            if (!isAbortError(outcome.reason)) {
              warn(`Failed to read ${batch[bi]}: ${msg}`);
            }
            results.push({
              index: i + bi + 1,
              url: batch[bi],
              title: "",
              published: null,
              wordCount: 0,
              domainScore: 0,
              tier: "general",
              content: "",
              error: msg,
            });
          }
        }

        if (i + CONCURRENCY < urls.length)
          await sleep(MULTI_READ_BATCH_DELAY_MS);
      }

      const succeeded = results.filter((r) => r.error === null).length;
      status(`Done: ${succeeded}/${urls.length} pages read successfully.`);

      if (succeeded === 0) {
        return "All page reads failed. Verify the URLs are publicly accessible.";
      }

      return results;
    },
  });

  const localDocsAddTool = tool({
    name: "Local Docs Add Collection",
    description:
      "Index a local folder of documents into a searchable collection. " +
      "Once indexed, the Deep Research tool can search these documents alongside the web " +
      "when Local Document Sources is enabled in settings. " +
      "Supports text files, markdown, HTML, code files, CSV, JSON, XML, and more. " +
      "Recursively scans subdirectories up to 10 levels deep. " +
      "Each collection is identified by a name you choose. " +
      "Re-indexing a folder that was already indexed replaces the old collection.",
    parameters: {
      name: z
        .string()
        .min(1)
        .max(100)
        .describe(
          "A descriptive name for this collection, e.g. 'Legal Documents', " +
            "'Research Papers', 'Internal Reports'. Used in search results and reports.",
        ),
      folderPath: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the folder containing your documents. " +
            "All supported files in subdirectories will be included.",
        ),
    },

    implementation: async ({ name, folderPath }, { status }) => {
      try {
        const store = getGlobalStore();
        const cfg = readConfig(ctl);
        const collection = await store.indexCollection(
          name,
          folderPath,
          cfg.contentLimitPerPage,
          status,
        );
        return {
          success: true,
          collection: {
            id: collection.id,
            name: collection.name,
            folderPath: collection.folderPath,
            fileCount: collection.fileCount,
            chunkCount: collection.chunkCount,
            totalWords: collection.totalWords,
            indexedAt: collection.indexedAt,
          },
          instructions:
            "Collection indexed. Enable 'Local Document Sources' in plugin settings " +
            "to include these documents in Deep Research results.",
        };
      } catch (err: unknown) {
        return `Error indexing collection: ${errorMessage(err)}`;
      }
    },
  });

  const localDocsListTool = tool({
    name: "Local Docs List Collections",
    description:
      "List all indexed local document collections with their stats. " +
      "Shows collection name, folder path, file count, chunk count, and index date.",
    parameters: {},

    implementation: async () => {
      const store = getGlobalStore();
      const collections = store.getCollections();

      if (collections.length === 0) {
        return {
          collections: [],
          message:
            "No collections indexed yet. Use 'Local Docs Add Collection' to index a folder.",
        };
      }

      return {
        collections: collections.map((c) => ({
          id: c.id,
          name: c.name,
          folderPath: c.folderPath,
          fileCount: c.fileCount,
          chunkCount: c.chunkCount,
          totalWords: c.totalWords,
          indexedAt: c.indexedAt,
        })),
        stats: store.getStats(),
      };
    },
  });

  const localDocsRemoveTool = tool({
    name: "Local Docs Remove Collection",
    description:
      "Remove an indexed local document collection by its ID. " +
      "Use 'Local Docs List Collections' first to find the collection ID.",
    parameters: {
      collectionId: z
        .string()
        .uuid()
        .describe("The UUID of the collection to remove."),
    },

    implementation: async ({ collectionId }, { status }) => {
      const store = getGlobalStore();
      const collection = store.getCollection(collectionId);

      if (!collection) {
        return `Collection not found: ${collectionId}`;
      }

      const name = collection.name;
      const removed = store.removeCollection(collectionId);

      if (removed) {
        status(`Removed collection "${name}"`);
        return {
          success: true,
          removedCollection: name,
          remainingCollections: store.getCollections().length,
        };
      }

      return "Failed to remove collection.";
    },
  });

  const localDocsSearchTool = tool({
    name: "Local Docs Search",
    description:
      "Search across your indexed local document collections. " +
      "Returns the most relevant chunks from your documents ranked by keyword relevance. " +
      "Use this for quick lookups in your local data. For full research that combines " +
      "local and web sources, use 'Deep Research' with Local Document Sources enabled.",
    parameters: {
      query: z
        .string()
        .min(1)
        .describe(
          "Search query — natural language works best. Use '*' to return all chunks from a collection.",
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum results to return (default: 8)."),
      collectionId: z
        .string()
        .uuid()
        .optional()
        .describe("Optional: limit search to a specific collection by its ID."),
    },

    implementation: async ({ query, maxResults, collectionId }, { status }) => {
      const store = getGlobalStore();

      if (!store.hasCollections()) {
        return "No collections indexed. Use 'Local Docs Add Collection' first.";
      }

      const max = maxResults ?? 8;
      const targetIds = collectionId ? [collectionId] : undefined;

      const isWildcard = query.trim() === "*";

      status(
        isWildcard
          ? "Listing all local document chunks…"
          : `Searching local documents: "${query}"`,
      );
      const hits = isWildcard
        ? store.listAll(max, targetIds)
        : store.search(query, max, targetIds);

      if (hits.length === 0) {
        return {
          results: [],
          message: "No relevant documents found for this query.",
        };
      }

      status(`Found ${hits.length} relevant chunks.`);

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
    researchSearchTool,
    researchReadPageTool,
    researchMultiReadTool,
    localDocsAddTool,
    localDocsListTool,
    localDocsRemoveTool,
    localDocsSearchTool,
  ];
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}
