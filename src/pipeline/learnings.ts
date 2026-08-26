/**
 * @file pipeline/learnings.ts
 * Distills a crawl round's sources into factual learnings and follow-up
 * research questions using one batched LLM call per round. Falls back to an
 * extractive summary when no model is loaded.
 */
import type { CrawledSource } from "../core/types";
import type { StatusFn } from "../core/types";
import { callLLMJson } from "../core/model";
import { z } from "zod";

const LEARNINGS_SCHEMA = z.object({
  learnings: z.array(z.string().min(15)).max(10),
  followUpQuestions: z.array(z.string().min(10)).max(6),
});

export interface DistilledRound {
  readonly learnings: ReadonlyArray<string>;
  readonly followUps: ReadonlyArray<string>;
  readonly usedModel: boolean;
}

const EXCERPT_CHARS_PER_SOURCE = 900;
const MAX_SOURCES_PER_DISTILL = 18;

/** Extractive fallback: lead sentences of the most relevant sources. */
function extractiveFallback(
  sources: ReadonlyArray<CrawledSource>,
): DistilledRound {
  const learnings = sources
    .slice(0, MAX_SOURCES_PER_DISTILL)
    .map((s) => {
      const sentences = s.text.split(/(?<=[.!?])\s+/);
      const informative = sentences.find(
        (line) => line.length > 80 && /\d|percent|study|according/i.test(line),
      );
      const best = informative ?? sentences[0] ?? "";
      return `${best.trim()} [${s.index}]`;
    })
    .filter((l) => l.length > 40);

  return { learnings: [...new Set(learnings)].slice(0, 10), followUps: [], usedModel: false };
}

/**
 * Distills a round's sources. Never throws — falls back to extraction.
 */
export async function distillRound(
  topic: string,
  sources: ReadonlyArray<CrawledSource>,
  priorLearnings: ReadonlyArray<string>,
  status: StatusFn,
): Promise<DistilledRound> {
  if (sources.length === 0) return { learnings: [], followUps: [], usedModel: false };

  const sourceBlock = sources
    .slice(0, MAX_SOURCES_PER_DISTILL)
    .map((s) => `<content index="${s.index}" url="${s.url}">\n${
      s.text.slice(0, EXCERPT_CHARS_PER_SOURCE).replace(/\n+/g, " ").trim()
    }\n</content>`)
    .join("\n");

  const priorBlock = priorLearnings.length > 0
    ? `\n\nAlready-known learnings (do NOT repeat these):\n${priorLearnings.slice(-12).map((l) => `- ${l}`).join("\n")}`
    : "";

  const result = await callLLMJson(
    `Research topic: "${topic}"${priorBlock}

Below are excerpts from web sources gathered so far:
${sourceBlock}

Extract the most important LEARNINGS — concise, information-dense factual statements. Include exact entities (people, places, companies, products), metrics, numbers, and dates whenever present. Do not repeat known learnings.

Also list follow-up questions worth researching next, if clear gaps remain (empty array if coverage feels complete).

Schema:
{"learnings":["..."],"followUpQuestions":["..."]}

JSON:`,
    LEARNINGS_SCHEMA,
    { maxTokens: 1200, temperature: 0.3, timeoutMs: 90_000 },
    status,
  );

  if (!result.value) {
    status("Learnings distillation unavailable — using extractive fallback");
    return extractiveFallback(sources);
  }

  return {
    learnings: [...new Set(result.value.learnings)],
    followUps: result.value.followUpQuestions,
    usedModel: true,
  };
}
