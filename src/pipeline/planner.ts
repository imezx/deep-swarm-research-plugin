/**
 * @file pipeline/planner.ts
 * Topic → worker specs. AI decomposition first (zod-validated),
 * role-template fallback when AI is off/unavailable.
 */
import { z } from "zod";
import type { DepthProfile, ResearchPlan, SearchScope, WorkerSpec } from "../core/types";
import type { StatusFn } from "../core/types";
import { callLLM, callLLMJson } from "../core/model";
import { extractKeywords } from "../core/util";
import { DIMENSIONS } from "../core/dimensions";

const WORKER_ROLES = [
  "breadth", "depth", "recency", "academic", "critical",
  "statistical", "regulatory", "technical", "primary", "comparative",
] as const;

const DECOMPOSITION_SCHEMA = z.object({
  workers: z.array(z.object({
    role: z.enum(WORKER_ROLES).catch("breadth"),
    label: z.string().min(3).max(60),
    queries: z.array(z.string().min(4)).min(2).max(8),
    scope: z.enum(["reference", "academic", "general"]).catch("general"),
  })).min(3).max(10),
});

const SCOPE_BY_ROLE: Readonly<Record<string, SearchScope>> = {
  academic: "academic",
  statistical: "academic",
  primary: "reference",
};

function scopeForRole(role: string): SearchScope {
  return SCOPE_BY_ROLE[role] ?? "general";
}

function makeDecompositionPrompt(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
): string {
  const focus = focusAreas.length > 0 ? `\nFocus areas: ${focusAreas.join(", ")}` : "";
  return `You are a research decomposition system. Given a topic, output JSON with specialized research workers.

Topic: "${topic}"${focus}

Schema:
{"workers":[{"role":"${WORKER_ROLES.join('|')}","label":"short name","queries":["query1","query2"],"scope":"reference|academic|general"}]}

Rules:
- Output ${Math.min(4, profile.pagesPerCrawlerRound > 0 ? 6 : 4)} to 8 workers
- Queries must be specific web-search queries for THIS topic
- scope "academic" for evidence/data workers, "reference" for encyclopedic, else "general"
- ONLY valid JSON, no other text

JSON:`;
}

async function aiDecompose(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
  status: StatusFn,
): Promise<WorkerSpec[] | null> {
  const result = await callLLMJson(
    makeDecompositionPrompt(topic, focusAreas, profile),
    DECOMPOSITION_SCHEMA,
    { timeoutMs: 30_000, maxTokens: 1200 },
    status,
  );

  if (!result.value) {
    if (result.reason === "invalid-json" || result.reason === "schema-mismatch") {
      status(`AI decomposition output invalid (${result.reason}) — using templates`);
    }
    return null;
  }

  const seenQueries = new Set<string>();
  const specs: WorkerSpec[] = [];
  for (const w of result.value.workers) {
    const queries = w.queries.filter((q) => {
      const key = q.toLowerCase().trim();
      if (seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    }).slice(0, profile.maxQueriesPerSpec);
    if (queries.length < 2) continue;
    specs.push({ role: w.role, label: w.label, queries, scope: w.scope });
  }

  if (specs.length < 3) return null;
  status(`AI decomposed topic into ${specs.length} specialized workers`);
  return specs;
}

/* ------------- deterministic template fallback ------------- */

interface RoleTemplate {
  readonly role: string;
  readonly label: string;
  readonly dims: ReadonlyArray<string>;
}

const ROLE_TEMPLATES: ReadonlyArray<RoleTemplate> = [
  { role: "breadth", label: "Breadth Scout", dims: ["overview", "applications", "history"] },
  { role: "depth", label: "Depth Digger", dims: ["mechanism", "evidence"] },
  { role: "recency", label: "Recency Monitor", dims: ["current", "future"] },
  { role: "academic", label: "Academic Analyst", dims: ["evidence", "expert"] },
  { role: "critical", label: "Critical Examiner", dims: ["challenges", "controversy"] },
  { role: "statistical", label: "Data Specialist", dims: ["economics", "evidence"] },
  { role: "comparative", label: "Comparison Builder", dims: ["comparison", "applications"] },
];

const DIMENSION_QUERY_MAKER: Readonly<Record<string, (topic: string) => string>> = {
  overview: (t) => `${t} overview`,
  mechanism: (t) => `how does ${t} work`,
  history: (t) => `history and origin of ${t}`,
  current: (t) => `${t} latest news`,
  applications: (t) => `${t} real-world applications`,
  challenges: (t) => `${t} limitations and risks`,
  comparison: (t) => `${t} compared to alternatives`,
  evidence: (t) => `${t} studies evidence review`,
  expert: (t) => `${t} experts analysis opinion`,
  future: (t) => `${t} future outlook trends`,
  controversy: (t) => `${t} controversy criticism debate`,
  economics: (t) => `${t} cost statistics market data`,
};

export function templatePlan(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
): WorkerSpec[] {
  const specs: WorkerSpec[] = [];
  const usedDims = new Set<string>();

  for (const template of ROLE_TEMPLATES) {
    const queries: string[] = [];
    for (const dimId of template.dims) {
      const maker = DIMENSION_QUERY_MAKER[dimId];
      if (!maker || usedDims.has(dimId) && template.role !== "breadth") continue;
      usedDims.add(dimId);
      queries.push(maker(topic));
    }
    for (const area of focusAreas) queries.push(`${topic} ${area}`);
    const dimKeywordBoost = DIMENSIONS.filter((d) => template.dims.includes(d.id))
      .flatMap((d) => d.keywords.slice(0, 1).map((kw) => `${topic} ${kw}`));

    const finalQueries = [...new Set([...queries, ...dimKeywordBoost])]
      .slice(0, profile.maxQueriesPerSpec);
    if (finalQueries.length > 0) {
      specs.push({
        role: template.role,
        label: template.label,
        queries: finalQueries,
        scope: scopeForRole(template.role),
      });
    }
  }
  return specs;
}

/** Builds the complete plan. Never throws; always yields at least one spec. */
export async function buildResearchPlan(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  useAI: boolean,
  profile: DepthProfile,
  status: StatusFn,
): Promise<ResearchPlan> {
  let specs: WorkerSpec[] | null = null;
  let usedAI = false;

  if (useAI) {
    status("AI task decomposition — analyzing topic…");
    specs = await aiDecompose(topic, focusAreas, profile, status);
    usedAI = specs !== null;
  }

  if (!specs || specs.length === 0) {
    specs = templatePlan(topic, focusAreas, profile);
  }

  return {
    specs,
    topicKeywords: extractKeywords(topic),
    usedAI,
  };
}

/** Gap rounds: turn uncovered dimensions into targeted specs (no AI needed). */
export function gapPlansFromDimensions(
  gaps: ReadonlyArray<{ id: string; label: string }>,
  topic: string,
  profile: DepthProfile,
): WorkerSpec[] {
  const specs: WorkerSpec[] = [];
  for (const gap of gaps) {
    const maker = DIMENSION_QUERY_MAKER[gap.id];
    if (!maker) continue;
    specs.push({
      role: gap.id === "evidence" || gap.id === "expert" ? "academic" : "depth",
      label: `Gap-fill: ${gap.label}`,
      queries: [maker(topic), `${topic} ${gap.label.toLowerCase()}`].slice(0, profile.queriesPerGapDimension),
      scope: scopeForRole(gap.id),
    });
  }
  return specs;
}
