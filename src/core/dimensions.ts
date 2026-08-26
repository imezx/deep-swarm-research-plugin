/**
 * @file core/dimensions.ts
 * The 12 research dimensions + keyword-based coverage detection.
 * Kept deterministic (no AI) so gap analysis is reproducible.
 */
import { containsPhrase } from "./util";

export interface ResearchDimension {
  readonly id: string;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
}

export const DIMENSIONS: ReadonlyArray<ResearchDimension> = [
  { id: "overview", label: "Overview & Basics", keywords: ["overview", "introduction", "basics", "definition", "what is"] },
  { id: "mechanism", label: "Mechanisms & How It Works", keywords: ["mechanism", "how it works", "principle", "architecture", "pathway"] },
  { id: "history", label: "History & Background", keywords: ["history", "origin", "timeline", "development", "background"] },
  { id: "current", label: "Current State & News", keywords: ["latest", "recent", "news", "update", "current status"] },
  { id: "applications", label: "Applications & Use Cases", keywords: ["application", "use case", "implementation", "industry", "deployment"] },
  { id: "challenges", label: "Challenges & Limitations", keywords: ["challenge", "limitation", "drawback", "problem", "barrier", "risk"] },
  { id: "comparison", label: "Comparisons & Alternatives", keywords: ["comparison", "alternative", "versus", "compared", "benchmark"] },
  { id: "evidence", label: "Evidence & Studies", keywords: ["study", "trial", "meta-analysis", "review", "evidence", "research"] },
  { id: "expert", label: "Expert Opinions", keywords: ["expert", "opinion", "interview", "commentary", "analysis by"] },
  { id: "future", label: "Future Outlook", keywords: ["future", "outlook", "forecast", "roadmap", "projection", "trend"] },
  { id: "controversy", label: "Controversies & Debate", keywords: ["controversy", "debate", "criticism", "dispute", "opposition"] },
  { id: "economics", label: "Economics & Data", keywords: ["cost", "market size", "revenue", "statistics", "economics", "funding"] },
];

/** Dimension ids whose keywords appear in ANY of the collected texts. */
export function detectCoveredDimensions(texts: ReadonlyArray<string>): string[] {
  const corpusLower = texts.map((t) => t.toLowerCase()).join("\n");
  const covered: string[] = [];

  for (const dim of DIMENSIONS) {
    // A dimension counts as covered when 2+ distinct keywords hit
    // (single generic words like "risk" would otherwise over-trigger).
    let hits = 0;
    for (const kw of dim.keywords) {
      if (containsPhrase(corpusLower, kw)) hits++;
      if (hits >= 2) break;
    }
    if (hits >= 2) covered.push(dim.id);
  }
  return covered;
}

export function detectGapDimensions(coveredIds: ReadonlyArray<string>): ReadonlyArray<ResearchDimension> {
  const covered = new Set(coveredIds);
  return DIMENSIONS.filter((d) => !covered.has(d.id));
}
