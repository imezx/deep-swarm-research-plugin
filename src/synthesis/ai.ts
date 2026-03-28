/**
 * @file synthesis/ai.ts
 * AI-powered report synthesis and contradiction detection.
 * Now accepts depth-profile parameters so synthesis scales with depth.
 */

import { LMStudioClient } from "@lmstudio/sdk";
import { ReportSource, ContradictionEntry, StatusFn } from "../types";
import {
  DepthProfile,
  AI_SYNTHESIS_TEMPERATURE,
  AI_SYNTHESIS_TIMEOUT_MS,
  AI_CONTRADICTION_TEMPERATURE,
  AI_CONTRADICTION_TIMEOUT_MS,
  CONTRADICTION_SOURCE_CHARS,
} from "../constants";

async function callModel(
  prompt: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const client = new LMStudioClient();

    const models = await Promise.race<
      Awaited<ReturnType<typeof client.llm.listLoaded>>
    >([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);

    if (!Array.isArray(models) || models.length === 0) return null;

    const model = await client.llm.model(models[0].identifier);
    const stream = model.respond([{ role: "user", content: prompt }], {
      maxTokens,
      temperature,
    });

    let result = "";
    for await (const chunk of stream) result += chunk.content ?? "";

    return result.trim() || null;
  } catch {
    return null;
  }
}

function prepareSources(
  sources: ReadonlyArray<ReportSource>,
  charsPerSrc: number,
  maxSources: number,
): string {
  return sources
    .slice(0, maxSources)
    .map((s) => {
      const preview = s.text.slice(0, charsPerSrc).replace(/\n+/g, " ").trim();
      const pub = s.published ? ` (${s.published})` : "";
      return `[${s.index}] "${s.title}"${pub} — ${s.tier} (score: ${s.domainScore})\n${preview}`;
    })
    .join("\n\n");
}

/**
 * Asks the loaded model to write a coherent, well-structured narrative
 * synthesis of the research findings.
 *
 * Now scales synthesis output size and input sources with depth profile.
 */
export async function synthesiseReport(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  coveredDims: ReadonlyArray<string>,
  gapDims: ReadonlyArray<string>,
  status: StatusFn,
  profile: DepthProfile,
): Promise<string | null> {
  if (sources.length === 0) return null;

  status(
    `AI synthesis — writing narrative research analysis (${sources.length} sources, up to ${profile.synthesisMaxSources} in prompt)…`,
  );

  const sourceBlock = prepareSources(
    sources,
    profile.synthesisSourceChars,
    profile.synthesisMaxSources,
  );

  const paragraphHint =
    sources.length > 50
      ? "8-15 paragraphs"
      : sources.length > 20
        ? "6-10 paragraphs"
        : "4-8 paragraphs";

  const prompt = `You are an expert research analyst. Write a comprehensive, well-structured narrative synthesis of these research findings.

TOPIC: "${topic}"
TOTAL SOURCES AVAILABLE: ${sources.length}
DIMENSIONS COVERED: ${coveredDims.join(", ")}
${gapDims.length > 0 ? `GAPS (not fully covered): ${gapDims.join(", ")}` : "All research dimensions covered."}

SOURCES:
${sourceBlock}

INSTRUCTIONS:
1. Write ${paragraphHint} of coherent analysis — NOT a list of bullet points
2. Synthesise thematically: group related findings across sources, don't just summarise each source
3. Use inline citations like [1], [2], [3] when referencing specific sources
4. Highlight areas where sources AGREE (consensus) and where they DISAGREE (contradictions)
5. Note any important limitations or gaps in the available evidence
6. End with 2-3 key takeaways
7. Write in a neutral, analytical tone — like a research brief
8. Do NOT start with "This report" or "This synthesis" — jump straight into the analysis
9. Be thorough — the user wants comprehensive coverage, not a summary

SYNTHESIS:`;

  const timeoutMs = Math.max(
    AI_SYNTHESIS_TIMEOUT_MS,
    AI_SYNTHESIS_TIMEOUT_MS + sources.length * 500,
  );

  const result = await callModel(
    prompt,
    profile.synthesisMaxTokens,
    AI_SYNTHESIS_TEMPERATURE,
    timeoutMs,
  );

  if (result && result.length > 100) {
    status(`AI synthesis complete (${result.length} chars)`);
    return result;
  }

  status("AI synthesis unavailable — using structured extraction fallback");
  return null;
}

/**
 * Asks the model to identify claims where sources disagree.
 * Now scales with depth profile.
 */
export async function detectContradictions(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  status: StatusFn,
  profile: DepthProfile,
): Promise<ReadonlyArray<ContradictionEntry>> {
  if (sources.length < 3) return [];

  status("Checking for cross-source contradictions...");

  const sourceBlock = prepareSources(
    sources,
    CONTRADICTION_SOURCE_CHARS,
    profile.contradictionMaxSources,
  );

  const maxContradictions = Math.min(
    10,
    Math.max(5, Math.floor(sources.length / 5)),
  );

  const prompt = `You are a fact-checking analyst. Given these research sources on "${topic}", identify any CONTRADICTIONS — places where two sources make conflicting claims about the same thing.

SOURCES:
${sourceBlock}

For each contradiction found, output ONE line in this exact format:
CLAIM: <what the disagreement is about> | SOURCE_A: [<index>] <their stance> | SOURCE_B: [<index>] <their stance> | SEVERITY: <minor/moderate/major>

Rules:
- Only report genuine factual contradictions, not stylistic differences
- SEVERITY: minor = different emphasis, moderate = conflicting data/claims, major = directly opposing conclusions
- If no contradictions found, output: NONE
- Maximum ${maxContradictions} contradictions

OUTPUT:`;

  const raw = await callModel(
    prompt,
    Math.max(1500, maxContradictions * 200),
    AI_CONTRADICTION_TEMPERATURE,
    AI_CONTRADICTION_TIMEOUT_MS,
  );

  if (!raw || /^NONE$/im.test(raw.trim())) {
    status("No contradictions detected");
    return [];
  }

  const entries: ContradictionEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("CLAIM:")) continue;

    try {
      const claimMatch = /CLAIM:\s*(.+?)\s*\|/.exec(trimmed);
      const sourceAMatch = /SOURCE_A:\s*\[(\d+)\]\s*(.+?)\s*\|/.exec(trimmed);
      const sourceBMatch = /SOURCE_B:\s*\[(\d+)\]\s*(.+?)\s*\|/.exec(trimmed);
      const sevMatch = /SEVERITY:\s*(minor|moderate|major)/i.exec(trimmed);

      if (!claimMatch || !sourceAMatch || !sourceBMatch) continue;

      const idxA = parseInt(sourceAMatch[1], 10);
      const idxB = parseInt(sourceBMatch[1], 10);
      const srcA = sources.find((s) => s.index === idxA);
      const srcB = sources.find((s) => s.index === idxB);

      entries.push({
        claim: claimMatch[1].trim(),
        sourceA: {
          index: idxA,
          title: srcA?.title ?? `Source ${idxA}`,
          stance: sourceAMatch[2].trim(),
        },
        sourceB: {
          index: idxB,
          title: srcB?.title ?? `Source ${idxB}`,
          stance: sourceBMatch[2].trim(),
        },
        severity: (sevMatch?.[1]?.toLowerCase() ?? "minor") as
          | "minor"
          | "moderate"
          | "major",
      });
    } catch {
      continue;
    }
  }

  if (entries.length > 0) {
    status(`${entries.length} contradiction(s) detected`);
  } else {
    status("No contradictions detected");
  }

  return entries;
}
