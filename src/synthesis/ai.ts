/**
 * @file synthesis/ai.ts
 * AI synthesis + contradiction detection. Zod-validated, null-safe,
 * depth-profile scaled.
 */
import { z } from "zod";
import type { ContradictionEntry, DepthProfile, CrawledSource as ReportSource } from "../core/types";
import type { StatusFn } from "../core/types";
import { callLLMJson, callLLM } from "../core/model";

const CONTRADICTION_SCHEMA = z.object({
  contradictions: z.array(z.object({
    claim: z.string().min(10),
    sourceA: z.object({ index: z.number().int().positive(), stance: z.string() }),
    sourceB: z.object({ index: z.number().int().positive(), stance: z.string() }),
    severity: z.enum(["minor", "moderate", "major"]),
  })).max(12),
});

function prepareSources(
  sources: ReadonlyArray<ReportSource>,
  charsPerSrc: number,
  maxSources: number,
): string {
  return sources
    .slice(0, maxSources)
    .map((s) => {
      const preview = s.text.slice(0, charsPerSrc).replace(/\n+/g, " ").trim();
      const pub = s.published !== null ? ` (${s.published})` : "";
      const originTag = s.origin === "local" ? "[local]" : "";
      return `[${s.index}]${originTag} "${s.title}"${pub} — ${s.tier}\n${preview}`;
    })
    .join("\n\n");
}

export async function synthesiseReport(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  coveredLabels: ReadonlyArray<string>,
  gapLabels: ReadonlyArray<string>,
  status: StatusFn,
  profile: DepthProfile,
  learnings: ReadonlyArray<string> = [],
  signal?: AbortSignal,
): Promise<string | null> {
  if (sources.length === 0) return null;

  status(`AI synthesis — ${sources.length} sources (up to ${profile.synthesisMaxSources} in prompt)…`);

  const paragraphHint =
    sources.length > 40 ? "8-12 paragraphs"
    : sources.length > 15 ? "6-9 paragraphs"
    : "4-7 paragraphs";

  const prompt = `Write a research analysis of the topic below, based only on the
provided sources and learnings.

TOPIC: "${topic}"
DIMENSIONS COVERED: ${coveredLabels.join(", ") || "(none detected)"}
${gapLabels.length > 0 ? `KNOWN GAPS: ${gapLabels.join(", ")}\n` : ""}${learnings.length > 0 ? `VERIFIED LEARNINGS (high confidence, use as the backbone):\n${learnings.map((l) => `- ${l}`).join("\n")}\n` : ""}
SOURCES:
${prepareSources(sources, profile.synthesisSourceChars, profile.synthesisMaxSources)}

Rules:
- Write ${paragraphHint} of thematic analysis. Do not summarize sources one by one.
- Lead with specifics: numbers, dates, percentages, prices, sample sizes.
  Where the sources give them, repeat them exactly; never invent figures.
- When a set of figures would compare well across categories or over time,
  add a line like "Chart suggestion: ..." describing the axes.
- Cite inline as [1], [2], matching the source indexes above.
- State where sources agree, where they conflict, and what the evidence
  does not cover.
- End with 2-3 takeaways that follow from the data.

ANALYSIS:`;

  const raw = await callLLM(
    prompt,
    { maxTokens: profile.synthesisMaxTokens, temperature: 0.4, timeoutMs: 180_000, signal },
    status,
  );

  if (raw !== null && raw.length > 100) {
    status(`AI synthesis complete (${raw.length} chars)`);
    return raw;
  }
  status("AI synthesis unavailable — report will use structured extraction");
  return null;
}

export async function detectContradictions(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  status: StatusFn,
  profile: DepthProfile,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ContradictionEntry>> {
  if (sources.length < 2) return [];

  const byIndex = new Map(sources.map((s) => [s.index, s]));
  const result = await callLLMJson(
    `You are a fact-checker. Identify claims where the sources below DISAGREE on facts, numbers, or causal conclusions about "${topic}".

SOURCES:
${prepareSources(sources, profile.synthesisSourceChars, Math.min(profile.synthesisMaxSources, 25))}

Schema:
{"contradictions":[{"claim":"the disputed claim","sourceA":{"index":N,"stance":"what A says"},"sourceB":{"index":M,"stance":"what B says"},"severity":"minor|moderate|major"}]}

Only genuine factual disagreements — different focus is NOT a contradiction. Empty array if none.

JSON:`,
    CONTRADICTION_SCHEMA,
    { maxTokens: 1500, temperature: 0.2, timeoutMs: 120_000, signal },
    status,
  );

  if (!result.value) return [];

  // Keep only contradictions referencing existing source indexes.
  const valid = result.value.contradictions.filter(
    (c) => byIndex.has(c.sourceA.index) && byIndex.has(c.sourceB.index),
  );

  return valid.map((c) => ({
    claim: c.claim,
    sourceA: {
      index: c.sourceA.index,
      title: byIndex.get(c.sourceA.index)?.title ?? "",
      stance: c.sourceA.stance,
    },
    sourceB: {
      index: c.sourceB.index,
      title: byIndex.get(c.sourceB.index)?.title ?? "",
      stance: c.sourceB.stance,
    },
    severity: c.severity,
  }));
}
