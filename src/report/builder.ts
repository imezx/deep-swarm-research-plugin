/**
 * @file report/builder.ts
 * Compiles a structured Markdown research report from swarm results.
 * AI synthesis is the primary narrative section; structured extraction
 * is retained as a fallback when AI is unavailable.
 */

import { CrawledSource } from "../types";
import {
  CompiledReport,
  ReportSource,
  WorkerRole,
  ContradictionEntry,
} from "../types";
import { DIMENSIONS, detectCoveredDimensions } from "../planning/dimensions";
import { synthesiseReport, detectContradictions } from "../synthesis/ai";
import { StatusFn } from "../types";
import {
  MAX_SENTENCE_CHARS,
  IDEAL_SENTENCE_LENGTH,
  CONSENSUS_OVERLAP_FRACTION,
  MAX_CONSENSUS_PHRASES,
  KEY_SENTENCES_PER_SOURCE,
  MAX_SOURCES_PER_DIMENSION,
  REPORT_SOURCE_PREVIEW_CHARS,
} from "../constants";

const INFO_MARKERS: ReadonlyArray<string> = [
  "is a",
  "is the",
  "refers to",
  "known as",
  "defined as",
  "found that",
  "shows that",
  "research",
  "study",
  "according to",
  "estimated",
  "reported",
  "discovered",
  "demonstrated",
  "evidence",
  "however",
  "although",
  "despite",
  "unlike",
  "compared to",
  "increased",
  "decreased",
  "improved",
  "reduced",
  "percent",
  "%",
  "million",
  "billion",
  "2024",
  "2025",
  "2026",
];

function extractKeySentences(
  text: string,
  keywords: ReadonlyArray<string>,
  count: number,
): ReadonlyArray<string> {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < MAX_SENTENCE_CHARS);

  const lowerKw = keywords.map((k) => k.toLowerCase());

  const scored = sentences.map((s) => {
    const lower = s.toLowerCase();
    let score = 0;
    score += INFO_MARKERS.filter((m) => lower.includes(m)).length * 2;
    score += lowerKw.filter((kw) => lower.includes(kw)).length * 3;
    score -= Math.abs(s.length - IDEAL_SENTENCE_LENGTH) / 50;
    return { s, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => text.indexOf(a.s) - text.indexOf(b.s))
    .map((x) => x.s);
}

function detectConsensus(
  sources: ReadonlyArray<ReportSource>,
  keywords: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (sources.length < 2) return [];

  const lowerKw = keywords.map((k) => k.toLowerCase());
  const ngramCounts = new Map<string, number>();
  const threshold = Math.max(
    2,
    Math.ceil(sources.length * CONSENSUS_OVERLAP_FRACTION),
  );

  for (const src of sources) {
    const words = src.text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 500);

    const local = new Set<string>();
    for (let i = 0; i < words.length - 2; i++) {
      local.add(`${words[i]} ${words[i + 1]}`);
      local.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    for (const ng of local) ngramCounts.set(ng, (ngramCounts.get(ng) ?? 0) + 1);
  }

  return Array.from(ngramCounts.entries())
    .filter(
      ([ng, count]) =>
        count >= threshold && lowerKw.some((kw) => ng.includes(kw)),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CONSENSUS_PHRASES)
    .map(([ng, count]) => `"${ng}" (${count} of ${sources.length} sources)`);
}

interface DimGroup {
  label: string;
  entries: ReadonlyArray<{
    index: number;
    title: string;
    sentences: ReadonlyArray<string>;
  }>;
}

function groupByDimension(
  sources: ReadonlyArray<ReportSource>,
  keywords: ReadonlyArray<string>,
): ReadonlyArray<DimGroup> {
  return DIMENSIONS.map((dim) => {
    const matching = sources
      .filter((s) =>
        dim.keywords.some((kw) => s.text.toLowerCase().includes(kw)),
      )
      .slice(0, MAX_SOURCES_PER_DIMENSION);

    const entries = matching
      .map((s) => ({
        index: s.index,
        title: s.title,
        sentences: extractKeySentences(
          s.text,
          [...keywords, ...dim.keywords],
          KEY_SENTENCES_PER_SOURCE,
        ),
      }))
      .filter((e) => e.sentences.length > 0);

    return { label: dim.label, entries };
  }).filter((g) => g.entries.length > 0);
}

const ROLE_LABELS: Readonly<Record<WorkerRole, string>> = {
  breadth: "Breadth",
  depth: "Depth",
  recency: "Recency",
  academic: "Academic",
  critical: "Critical",
};

const TIER_BADGES: Readonly<Record<string, string>> = {
  academic: "[academic]",
  government: "[gov]",
  reference: "[ref]",
  news: "[news]",
  professional: "[pro]",
  general: "[general]",
  low: "[low]",
};

/** Compiles the final research report from swarm-collected sources. */
export async function buildReport(
  topic: string,
  crawled: ReadonlyArray<CrawledSource>,
  queriesUsed: ReadonlyArray<string>,
  topicKws: ReadonlyArray<string>,
  totalRounds: number,
  usedAI: boolean,
  enableAI: boolean,
  status: StatusFn,
): Promise<CompiledReport> {
  const now = new Date().toUTCString();

  const keywords: ReadonlyArray<string> =
    topicKws.length > 0 ? topicKws : extractKeywordsFromTopic(topic);

  const sources: ReportSource[] = crawled.map((c, i) => ({
    index: i + 1,
    url: c.finalUrl || c.url,
    title: c.title || "Untitled",
    description: c.description,
    published: c.published,
    text: c.text,
    wordCount: c.wordCount,
    sourceQuery: c.sourceQuery,
    workerRole: c.workerRole,
    workerLabel: c.workerLabel,
    domainScore: c.domainScore,
    freshnessScore: c.freshnessScore,
    tier: c.tier,
    relevanceScore: c.relevanceScore,
  }));

  const allTexts = sources.map((s) => s.text);
  const coveredIds = detectCoveredDimensions(allTexts);
  const gapIds = DIMENSIONS.filter((d) => !coveredIds.includes(d.id)).map(
    (d) => d.id,
  );
  const coveredLabels = DIMENSIONS.filter((d) => coveredIds.includes(d.id)).map(
    (d) => d.label,
  );
  const gapLabels = DIMENSIONS.filter((d) => gapIds.includes(d.id)).map(
    (d) => d.label,
  );

  let aiSynthesis: string | null = null;
  let contradictions: ReadonlyArray<ContradictionEntry> = [];

  if (enableAI && sources.length > 0) {
    const [synthResult, contradResult] = await Promise.all([
      synthesiseReport(topic, sources, coveredLabels, gapLabels, status).catch(
        () => null,
      ),
      detectContradictions(topic, sources, status).catch(
        () => [] as ContradictionEntry[],
      ),
    ]);

    aiSynthesis = synthResult;
    contradictions = contradResult;
  }

  const header = buildHeader(
    topic,
    sources,
    totalRounds,
    usedAI,
    coveredIds.length,
    now,
    !!aiSynthesis,
  );
  const coverageTable = buildCoverageTable(coveredIds);
  const swarmActivity = buildSwarmActivity(sources, queriesUsed);
  const queryList = buildQueryList(queriesUsed);
  const consensus = buildConsensus(sources, keywords);

  const sections: string[] = [header, "---"];

  if (aiSynthesis) {
    sections.push(`## Research Analysis\n\n${aiSynthesis}`);
    sections.push("---");
  }

  if (contradictions.length > 0) {
    sections.push(buildContradictions(contradictions));
    sections.push("---");
  }

  sections.push(coverageTable, "---");
  sections.push(swarmActivity, "---");
  sections.push(queryList);

  if (consensus) {
    sections.push("---\n" + consensus);
  }

  const findings = buildFindings(sources, keywords);
  sections.push("---", findings, "---");

  sections.push(buildFullSources(sources), "---");
  sections.push(buildCitationIndex(sources), "---");
  sections.push(
    "*Generated by LM Studio Deep Research Plugin · Swarm Architecture · Verify important claims with primary sources.*",
  );

  return {
    markdown: sections.join("\n\n"),
    sources,
    topicKeywords: keywords,
    coveredDims: coveredIds,
    gapDims: gapIds,
    aiSynthesis: aiSynthesis ?? undefined,
    contradictions,
  };
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "in",
  "of",
  "and",
  "or",
  "for",
  "to",
  "how",
  "what",
  "why",
  "when",
  "does",
  "with",
  "from",
  "its",
]);

function extractKeywordsFromTopic(topic: string): ReadonlyArray<string> {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

function buildHeader(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  rounds: number,
  usedAI: boolean,
  covered: number,
  timestamp: string,
  hasSynthesis: boolean,
): string {
  const workerLabels = [...new Set(sources.map((s) => s.workerLabel))];

  return [
    `# Deep Research Report: ${esc(topic)}`,
    ``,
    `> **Generated:** ${timestamp}`,
    `> **Architecture:** Swarm (${workerLabels.length} parallel workers)`,
    `> **Workers:** ${workerLabels.join(", ")}`,
    `> **Research rounds:** ${rounds}`,
    `> **Total sources:** ${sources.length}`,
    `> **AI query planning:** ${usedAI ? " Enabled" : " Fallback (dimension-based)"}`,
    `> **AI narrative synthesis:** ${hasSynthesis ? " Enabled" : " Structured extraction"}`,
    `> **Dimension coverage:** ${covered}/${DIMENSIONS.length}`,
  ].join("\n");
}

function buildCoverageTable(coveredIds: ReadonlyArray<string>): string {
  const covered = new Set(coveredIds);
  const rows = DIMENSIONS.map(
    (d) => `| ${covered.has(d.id) ? "" : ""} | **${d.label}** |`,
  );
  return [
    `## Research Dimension Coverage`,
    ``,
    `| | Dimension |`,
    `|---|-----------|`,
    ...rows,
  ].join("\n");
}

function buildSwarmActivity(
  sources: ReadonlyArray<ReportSource>,
  queries: ReadonlyArray<string>,
): string {
  const byLabel = new Map<string, number>();
  for (const s of sources)
    byLabel.set(s.workerLabel, (byLabel.get(s.workerLabel) ?? 0) + 1);

  const roleRows = Array.from(byLabel.entries())
    .map(([label, count]) => `| ${label} | ${count} sources |`)
    .join("\n");

  return [
    `## Swarm Activity`,
    ``,
    `| Worker | Sources Collected |`,
    `|--------|------------------|`,
    roleRows,
    ``,
    `**Total queries executed:** ${queries.length}`,
  ].join("\n");
}

function buildQueryList(queries: ReadonlyArray<string>): string {
  const unique = [...new Set(queries)];
  return [
    `## Queries Executed`,
    ``,
    unique.map((q, i) => `${i + 1}. \`${esc(q)}\``).join("\n"),
  ].join("\n");
}

function buildConsensus(
  sources: ReadonlyArray<ReportSource>,
  keywords: ReadonlyArray<string>,
): string | null {
  const points = detectConsensus(sources, keywords);
  if (points.length === 0) return null;
  return [
    `## Cross-Source Consensus`,
    ``,
    `These concepts appeared consistently across multiple independent sources:`,
    ``,
    points.map((p) => `- ${p}`).join("\n"),
  ].join("\n");
}

function buildContradictions(
  entries: ReadonlyArray<ContradictionEntry>,
): string {
  const SEVERITY_ICONS: Record<string, string> = {
    minor: "[minor]",
    moderate: "[moderate]",
    major: "[major]",
  };

  const rows = entries.map((e) => {
    const icon = SEVERITY_ICONS[e.severity] ?? "";
    return [
      `### ${icon} ${esc(e.claim)}`,
      ``,
      `- **\\[${e.sourceA.index}\\] ${esc(e.sourceA.title)}**: ${esc(e.sourceA.stance)}`,
      `- **\\[${e.sourceB.index}\\] ${esc(e.sourceB.title)}**: ${esc(e.sourceB.stance)}`,
      `- **Severity:** ${e.severity}`,
    ].join("\n");
  });

  return [
    `## Cross-Source Contradictions`,
    ``,
    `The following disagreements were detected between sources:`,
    ``,
    ...rows,
  ].join("\n\n");
}

function buildFindings(
  sources: ReadonlyArray<ReportSource>,
  keywords: ReadonlyArray<string>,
): string {
  const groups = groupByDimension(sources, keywords);

  const sections = groups.map((g) => {
    const entries = g.entries
      .map((e) => {
        const sentences = e.sentences.map((s) => ` > ${esc(s)}`).join("\n");
        return `**\\[${e.index}\\] ${esc(e.title)}**\n${sentences}`;
      })
      .join("\n\n");
    return `### ${g.label}\n\n${entries}`;
  });

  return [`## Findings by Research Dimension`, ``, ...sections].join(
    "\n\n---\n\n",
  );
}

function buildFullSources(sources: ReadonlyArray<ReportSource>): string {
  const entries = sources.map((s) => {
    const badge = TIER_BADGES[s.tier] ?? "";
    const preview = s.text
      .slice(0, REPORT_SOURCE_PREVIEW_CHARS)
      .replace(/\n+/g, " ")
      .trim();
    const isTruncated = s.text.length > REPORT_SOURCE_PREVIEW_CHARS;

    const meta = [
      `${badge} **${s.tier}** · Score: ${s.domainScore}/100`,
      `Relevance: ${(s.relevanceScore * 100).toFixed(0)}%`,
      s.published ? ` ${s.published}` : null,
      `~${s.wordCount.toLocaleString()} words`,
      `Worker: ${s.workerLabel}`,
      `Query: \`${esc(s.sourceQuery)}\``,
    ]
      .filter(Boolean)
      .join(" · ");

    return [
      `### \\[${s.index}\\] ${esc(s.title)}`,
      `<${s.url}>`,
      ``,
      meta,
      ``,
      `> ${esc(s.description)}`,
      ``,
      `<details>`,
      `<summary>Extracted content (~${s.wordCount.toLocaleString()} words)</summary>`,
      ``,
      esc(preview) + (isTruncated ? "\n\n*…truncated…*" : ""),
      ``,
      `</details>`,
    ].join("\n");
  });

  return [`## Full Source Details`, ``, entries.join("\n\n---\n\n")].join("\n");
}

function buildCitationIndex(sources: ReadonlyArray<ReportSource>): string {
  const lines = sources.map(
    (s) =>
      `**\\[${s.index}\\]** [${esc(s.title)}](${s.url})${s.published ? ` *(${s.published})*` : ""} ${TIER_BADGES[s.tier] ?? ""}`,
  );
  return [`## Citation Index`, ``, ...lines].join("\n");
}

function esc(text: string): string {
  return text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
