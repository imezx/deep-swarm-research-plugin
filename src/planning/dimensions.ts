/**
 * @file planning/dimensions.ts
 * The 12 research dimensions that constitute comprehensive coverage.
 * Coverage detection requires minimum keyword density and context length.
 */

import { ResearchDimension } from "../types";
import {
  DIMENSION_COVERAGE_MIN_HITS,
  DIMENSION_COVERAGE_MIN_CHARS,
} from "../constants";

export const DIMENSIONS: ReadonlyArray<ResearchDimension> = [
  {
    id: "overview",
    label: "Overview & Definition",
    keywords: [
      "what is",
      "definition",
      "refers to",
      "is a type",
      "means",
      "overview",
      "introduction",
    ],
    queries: (t) => [`what is ${t}`, `${t} definition and overview`],
  },
  {
    id: "mechanism",
    label: "How It Works",
    keywords: [
      "how",
      "process",
      "mechanism",
      "steps",
      "works by",
      "procedure",
      "method",
      "approach",
    ],
    queries: (t) => [`how does ${t} work`, `${t} mechanism process explained`],
  },
  {
    id: "history",
    label: "History & Origins",
    keywords: [
      "history",
      "origin",
      "founded",
      "invented",
      "developed",
      "background",
      "timeline",
      "evolution",
    ],
    queries: (t) => [`${t} history origin development`],
  },
  {
    id: "current",
    label: "Current State & Recent Developments",
    keywords: [
      "2024",
      "2025",
      "2026",
      "recently",
      "current",
      "today",
      "latest",
      "new",
      "update",
      "now",
    ],
    queries: (t) => [
      `${t} latest news 2025`,
      `${t} current state developments`,
    ],
  },
  {
    id: "applications",
    label: "Applications & Use Cases",
    keywords: [
      "application",
      "use case",
      "used for",
      "example",
      "industry",
      "practice",
      "deploy",
      "implement",
    ],
    queries: (t) => [
      `${t} real world applications examples`,
      `${t} use cases industry`,
    ],
  },
  {
    id: "challenges",
    label: "Challenges & Limitations",
    keywords: [
      "challenge",
      "limitation",
      "problem",
      "issue",
      "drawback",
      "disadvantage",
      "concern",
      "risk",
      "obstacle",
    ],
    queries: (t) => [
      `${t} challenges limitations problems`,
      `${t} risks concerns drawbacks`,
    ],
  },
  {
    id: "comparison",
    label: "Comparisons & Alternatives",
    keywords: [
      "vs",
      "versus",
      "compared to",
      "alternative",
      "difference",
      "better than",
      "similar to",
    ],
    queries: (t) => [`${t} vs alternatives comparison`],
  },
  {
    id: "evidence",
    label: "Research Evidence & Data",
    keywords: [
      "study",
      "research",
      "found that",
      "evidence",
      "data",
      "analysis",
      "survey",
      "paper",
      "peer-reviewed",
    ],
    queries: (t) => [`${t} research study evidence peer-reviewed`],
  },
  {
    id: "expert",
    label: "Expert Opinion & Analysis",
    keywords: [
      "expert",
      "according to",
      "opinion",
      "analyst",
      "researcher",
      "professor",
      "scientist",
      "specialist",
    ],
    queries: (t) => [`${t} expert opinion analysis`],
  },
  {
    id: "future",
    label: "Future Outlook & Trends",
    keywords: [
      "future",
      "trend",
      "predict",
      "forecast",
      "outlook",
      "next",
      "coming",
      "prospect",
      "potential",
    ],
    queries: (t) => [`${t} future trends predictions`],
  },
  {
    id: "controversy",
    label: "Controversy & Criticism",
    keywords: [
      "controversy",
      "criticism",
      "debate",
      "oppose",
      "critique",
      "disagree",
      "concern",
      "ethical",
    ],
    queries: (t) => [`${t} criticism controversy ethical debate`],
  },
  {
    id: "economics",
    label: "Economics & Market Impact",
    keywords: [
      "cost",
      "price",
      "market",
      "economic",
      "billion",
      "million",
      "revenue",
      "growth",
      "industry size",
    ],
    queries: (t) => [`${t} economic impact market size cost`],
  },
];

/** Returns dimension IDs with meaningful coverage based on hit count and context length. */
export function detectCoveredDimensions(
  texts: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const combined = texts.join(" ").toLowerCase();

  return DIMENSIONS.filter((dim) => {
    let totalHits = 0;
    let totalChars = 0;

    for (const kw of dim.keywords) {
      let idx = 0;
      while ((idx = combined.indexOf(kw, idx)) !== -1) {
        totalHits++;
        const ctxStart = Math.max(0, idx - 25);
        const ctxEnd = Math.min(combined.length, idx + kw.length + 25);
        totalChars += ctxEnd - ctxStart;
        idx += kw.length;
      }
    }

    return (
      totalHits >= DIMENSION_COVERAGE_MIN_HITS &&
      totalChars >= DIMENSION_COVERAGE_MIN_CHARS
    );
  }).map((dim) => dim.id);
}

/**
 * Returns the dimensions NOT yet covered by the collected sources.
 */
export function detectGaps(
  coveredIds: ReadonlyArray<string>,
): ReadonlyArray<ResearchDimension> {
  const coveredSet = new Set(coveredIds);
  return DIMENSIONS.filter((d) => !coveredSet.has(d.id));
}

/**
 * Generates gap-filling queries for a given list of uncovered dimensions.
 */
export function gapFillQueries(
  topic: string,
  gaps: ReadonlyArray<ResearchDimension>,
  maxQueries: number,
): ReadonlyArray<string> {
  const queries: string[] = [];
  for (const dim of gaps) {
    for (const q of dim.queries(topic)) {
      if (!queries.includes(q)) queries.push(q);
      if (queries.length >= maxQueries) return queries;
    }
  }
  return queries;
}
