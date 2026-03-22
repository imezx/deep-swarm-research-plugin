/**
 * @file planning/planner.ts
 * Generates search queries and worker decompositions for the swarm.
 * Supports dynamic AI task decomposition, inter-agent findings summaries,
 * and adaptive gap-fill with targeted worker roles.
 *
 * Now accepts a DepthProfile so query counts, worker limits, and
 * decomposition parameters all scale with the chosen depth preset.
 */

import { LMStudioClient } from "@lmstudio/sdk";
import {
  QueryPlan,
  WorkerRole,
  DynamicWorkerSpec,
  AdaptiveGapPlan,
  CrawledSource,
  AgentMessage,
  StatusFn,
} from "../types";
import { DIMENSIONS, detectGaps, gapFillQueries } from "./dimensions";
import {
  DepthProfile,
  AI_PLANNING_MAX_TOKENS,
  AI_PLANNING_TEMPERATURE,
  AI_PLANNING_TIMEOUT_MS,
  AI_MIN_ACCEPTABLE_QUERIES,
  AI_DECOMPOSITION_MAX_TOKENS,
  AI_DECOMPOSITION_TEMPERATURE,
  AI_DECOMPOSITION_TIMEOUT_MS,
  AI_FINDINGS_SUMMARY_MAX_TOKENS,
  AI_FINDINGS_SUMMARY_TEMPERATURE,
  FINDINGS_SUMMARY_SOURCE_CHARS,
  DECOMPOSITION_MIN_WORKERS,
  QUERY_LINE_MIN_LEN,
  QUERY_LINE_MAX_LEN,
} from "../constants";

async function callLoadedModel(
  prompt: string,
  maxTokens: number = AI_PLANNING_MAX_TOKENS,
  temperature: number = AI_PLANNING_TEMPERATURE,
  timeoutMs: number = AI_PLANNING_TIMEOUT_MS,
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

function parseLines(raw: string, maxLines: number = 6): ReadonlyArray<string> {
  return raw
    .split(/\n/)
    .map((line) => line.replace(/^\d+[.)]\s*|^[-*•]\s*/, "").trim())
    .filter(
      (line) =>
        line.length > QUERY_LINE_MIN_LEN && line.length < QUERY_LINE_MAX_LEN,
    )
    .filter((line, idx, arr) => arr.indexOf(line) === idx)
    .slice(0, maxLines);
}

const VALID_ROLES: ReadonlyArray<WorkerRole> = [
  "breadth",
  "depth",
  "recency",
  "academic",
  "critical",
  "statistical",
  "regulatory",
  "technical",
  "primary",
  "comparative",
];

function makeDecompositionPrompt(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
): string {
  const focus = focusAreas.length
    ? `\nFocus areas: ${focusAreas.join(", ")}`
    : "";
  return `You are a research decomposition system. Given a research topic, output a JSON array of specialized worker agents.

Topic: "${topic}"${focus}

Each worker needs:
- "role": one of "breadth", "depth", "recency", "academic", "critical", "statistical", "regulatory", "technical", "primary", "comparative"
- "label": descriptive name (e.g., "Clinical Evidence Researcher", "Policy Critic")
- "queries": array of ${Math.min(profile.maxQueriesPerWorker, 6)}-${profile.maxQueriesPerWorker} specific search queries for this worker
- "budgetWeight": number 0.1-0.4 (must sum to ~1.0 across all workers)
- "followLinks": true/false (true for depth/academic workers)
- "preferredTiers": optional array of "academic","government","reference","news","professional","general"

Rules:
- Output ${DECOMPOSITION_MIN_WORKERS} to ${profile.maxDecompositionWorkers} workers
- Tailor the workers to THIS specific topic — not generic roles
- Queries must be highly specific to the topic and each worker's assignment
- Generate MORE queries for broader or more complex topics
- Budget weights must roughly sum to 1.0
- Output ONLY valid JSON, no other text

JSON:`;
}

async function aiDecompose(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  status: StatusFn,
  profile: DepthProfile,
): Promise<ReadonlyArray<DynamicWorkerSpec> | null> {
  const raw = await callLoadedModel(
    makeDecompositionPrompt(topic, focusAreas, profile),
    AI_DECOMPOSITION_MAX_TOKENS,
    AI_DECOMPOSITION_TEMPERATURE,
    AI_DECOMPOSITION_TIMEOUT_MS,
  );

  if (!raw) return null;

  try {
    const jsonStr = raw.replace(/```json\s*|```\s*/g, "").trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed) || parsed.length < DECOMPOSITION_MIN_WORKERS)
      return null;

    const specs: DynamicWorkerSpec[] = [];
    for (const item of parsed.slice(0, profile.maxDecompositionWorkers)) {
      const role = VALID_ROLES.includes(item.role) ? item.role : "breadth";
      const queries = Array.isArray(item.queries)
        ? item.queries
            .filter((q: unknown) => typeof q === "string" && q.length > 3)
            .slice(0, profile.maxQueriesPerWorker)
        : [];
      if (queries.length < 2) continue;

      specs.push({
        role: role as WorkerRole,
        label:
          typeof item.label === "string"
            ? item.label.slice(0, 60)
            : `${role} worker`,
        queries,
        budgetWeight:
          typeof item.budgetWeight === "number"
            ? Math.max(0.05, Math.min(0.5, item.budgetWeight))
            : 0.2,
        followLinks: item.followLinks === true,
        preferredTiers: Array.isArray(item.preferredTiers)
          ? item.preferredTiers
          : undefined,
      });
    }

    if (specs.length < DECOMPOSITION_MIN_WORKERS) return null;

    const totalWeight = specs.reduce((sum, s) => sum + s.budgetWeight, 0);
    const normalised = specs.map((s) => ({
      ...s,
      budgetWeight: s.budgetWeight / totalWeight,
    }));

    status(`AI decomposed topic into ${normalised.length} specialised workers`);
    return normalised;
  } catch {
    return null;
  }
}

function makeRolePlanPrompt(
  role: WorkerRole,
  topic: string,
  focusAreas: ReadonlyArray<string>,
  profile: DepthProfile,
): string {
  const roleDescriptions: Readonly<Record<WorkerRole, string>> = {
    breadth: "broad coverage — many different angles, facts, and sub-topics",
    depth:
      "deep dive — mechanisms, how it works, technical detail, and evidence",
    recency:
      "recent developments — 2024-2026+ news, updates, and latest research",
    academic:
      "academic and scientific sources — peer-reviewed studies, journals, authoritative papers",
    critical:
      "critical analysis — limitations, counterarguments, criticism, controversy, drawbacks",
    statistical:
      "statistics and data — numbers, percentages, datasets, surveys, market sizes, quantitative evidence",
    regulatory:
      "regulatory and policy — laws, regulations, government policies, compliance, standards, guidelines",
    technical:
      "technical deep-dive — implementation details, specifications, architecture, engineering approaches",
    primary:
      "primary sources — original reports, official statements, first-hand accounts, press releases, white papers",
    comparative:
      "comparative analysis — vs alternatives, head-to-head comparisons, benchmarks, trade-offs, pros and cons",
  };

  const focus = focusAreas.length
    ? `\nFocus especially on: ${focusAreas.join(", ")}`
    : "";

  return `You are a research planning assistant. Generate search queries for a specialised research agent.

Topic: "${topic}"${focus}

This agent's role: ${roleDescriptions[role]}

Generate exactly ${profile.maxQueriesPerWorker} highly specific, diverse search queries for this role.
Rules:
- Each query must be different from the others
- Use natural language (as a human would type into a search engine)
- Be specific to the role — ${roleDescriptions[role]}
- Vary query structure: some factual, some comparative, some recent
- Return ONLY the queries, one per line, no numbering, no extra text

Queries:`;
}

const ROLE_DIMENSIONS: Readonly<Record<WorkerRole, ReadonlyArray<string>>> = {
  breadth: ["overview", "applications", "history", "economics"],
  depth: ["mechanism", "evidence", "expert"],
  recency: ["current", "future"],
  academic: ["evidence", "expert", "mechanism"],
  critical: ["challenges", "controversy", "comparison"],
  statistical: ["evidence", "economics", "overview"],
  regulatory: ["challenges", "controversy", "current"],
  technical: ["mechanism", "applications", "evidence"],
  primary: ["evidence", "expert", "history"],
  comparative: ["comparison", "challenges", "applications"],
};

function dimensionFallbackQueries(
  role: WorkerRole,
  topic: string,
  focusAreas: ReadonlyArray<string>,
  maxQueries: number,
): ReadonlyArray<string> {
  const dimIds = ROLE_DIMENSIONS[role];
  const dims = DIMENSIONS.filter((d) => dimIds.includes(d.id));
  const queries: string[] = [];

  const shortTopic = shortenTopic(topic);

  for (const dim of dims) {
    for (const q of dim.queries(shortTopic)) {
      if (!queries.includes(q)) queries.push(q);
    }
  }

  for (const area of focusAreas) {
    const q = `${shortTopic} ${area}`;
    if (!queries.includes(q)) queries.push(q);
  }

  return queries.slice(0, maxQueries);
}

/** Builds a full QueryPlan using AI decomposition, per-role planning, or dimension fallback. */
export async function buildQueryPlan(
  topic: string,
  focusAreas: ReadonlyArray<string>,
  useAI: boolean,
  status: StatusFn,
  profile: DepthProfile,
): Promise<QueryPlan> {
  const CORE_ROLES: ReadonlyArray<WorkerRole> = [
    "breadth",
    "depth",
    "recency",
    "academic",
    "critical",
  ];
  const EXTENDED_ROLES: ReadonlyArray<WorkerRole> = [
    "statistical",
    "regulatory",
    "technical",
    "primary",
    "comparative",
  ];

  let roles: ReadonlyArray<WorkerRole>;
  if (profile.depthRounds >= 10) {
    roles = [...CORE_ROLES, ...EXTENDED_ROLES];
  } else if (profile.depthRounds >= 5) {
    roles = [...CORE_ROLES, "technical", "comparative", "statistical"];
  } else {
    roles = CORE_ROLES;
  }

  const queriesByRole: Partial<Record<WorkerRole, ReadonlyArray<string>>> = {};
  let usedAI = false;
  let dynamicSpecs: ReadonlyArray<DynamicWorkerSpec> | undefined;

  if (useAI) {
    status("AI task decomposition — analysing topic for specialised workers…");
    const specs = await aiDecompose(topic, focusAreas, status, profile);

    if (specs && specs.length >= DECOMPOSITION_MIN_WORKERS) {
      dynamicSpecs = specs;
      usedAI = true;

      for (const spec of specs) {
        queriesByRole[spec.role] = spec.queries;
      }
    } else {
      status("AI planning queries for each swarm worker…");
    }

    const uncoveredRoles = roles.filter((r) => !queriesByRole[r]?.length);

    if (uncoveredRoles.length > 0) {
      const results = await Promise.allSettled(
        uncoveredRoles.map(async (role) => ({
          role,
          queries: await callLoadedModel(
            makeRolePlanPrompt(role, topic, focusAreas, profile),
          ),
        })),
      );

      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { role, queries: raw } = result.value;
        if (!raw) continue;
        const parsed = parseLines(raw, profile.maxQueriesPerWorker);
        if (parsed.length >= AI_MIN_ACCEPTABLE_QUERIES) {
          queriesByRole[role] = parsed;
          usedAI = true;
        }
      }
    }

    if (usedAI) {
      status(
        `AI generated queries for ${Object.keys(queriesByRole).length} worker role(s)`,
      );
    } else {
      status("AI unavailable, using dimension-based query planning");
    }
  }

  for (const role of roles) {
    if (!queriesByRole[role] || queriesByRole[role]!.length === 0) {
      queriesByRole[role] = dimensionFallbackQueries(
        role,
        topic,
        focusAreas,
        profile.maxQueriesPerWorker,
      );
    }
  }

  return {
    queriesByRole: queriesByRole as Record<WorkerRole, ReadonlyArray<string>>,
    usedAI,
    topicKeywords: extractKeywords(topic),
    dynamicSpecs,
  };
}

/** Summarises Round 1 findings so gap-fill workers have context. */
export async function summariseFindings(
  sources: ReadonlyArray<CrawledSource>,
  topic: string,
  useAI: boolean,
  status: StatusFn,
): Promise<ReadonlyArray<AgentMessage>> {
  if (!useAI || sources.length === 0) return [];

  const sourceSummaries = sources
    .slice(0, 20)
    .map(
      (s, i) =>
        `[${i + 1}] ${s.workerLabel}: ${s.title} — ${s.text.slice(0, FINDINGS_SUMMARY_SOURCE_CHARS)}`,
    )
    .join("\n\n");

  const prompt = `You are a research coordinator. A team of research agents collected these sources on "${topic}":

${sourceSummaries}

Summarise:
1. The 3-5 most important findings discovered so far (one line each)
2. 3-5 specific questions or angles that were NOT covered and need follow-up

Output format:
FINDINGS:
- finding 1
- finding 2
...

FOLLOW_UP:
- question 1
- question 2
...`;

  const raw = await callLoadedModel(
    prompt,
    AI_FINDINGS_SUMMARY_MAX_TOKENS,
    AI_FINDINGS_SUMMARY_TEMPERATURE,
  );

  if (!raw) return [];

  const findings: string[] = [];
  const followUps: string[] = [];
  let section: "findings" | "followup" | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (/^FINDINGS:/i.test(trimmed)) {
      section = "findings";
      continue;
    }
    if (/^FOLLOW.?UP:/i.test(trimmed)) {
      section = "followup";
      continue;
    }
    const item = trimmed.replace(/^[-*•]\s*/, "").trim();
    if (item.length < 5) continue;
    if (section === "findings") findings.push(item);
    if (section === "followup") followUps.push(item);
  }

  if (findings.length === 0 && followUps.length === 0) return [];

  status(
    `AI summarised ${findings.length} key findings, ${followUps.length} follow-up suggestions`,
  );

  return [
    {
      fromWorker: "round-coordinator",
      keyFindings: findings,
      suggestedFollowUps: followUps,
    },
  ];
}

/** Maps each dimension to the worker role best suited to fill it. */
const GAP_ROLE_MAP: Readonly<
  Record<
    string,
    {
      role: WorkerRole;
      followLinks: boolean;
      tiers?: ReadonlyArray<import("../types").SourceTier>;
    }
  >
> = {
  overview: { role: "breadth", followLinks: false },
  mechanism: { role: "technical", followLinks: true },
  history: { role: "breadth", followLinks: false },
  current: { role: "recency", followLinks: false },
  applications: { role: "breadth", followLinks: false },
  challenges: { role: "critical", followLinks: false },
  comparison: { role: "comparative", followLinks: false },
  evidence: {
    role: "academic",
    followLinks: true,
    tiers: ["academic", "government", "reference"],
  },
  expert: { role: "primary", followLinks: true, tiers: ["academic", "news"] },
  future: { role: "recency", followLinks: false },
  controversy: { role: "critical", followLinks: false },
  economics: { role: "statistical", followLinks: false },
};

/** Generates adaptive gap-fill plans with targeted worker roles per gap. */
export async function buildAdaptiveGapFill(
  topic: string,
  coveredIds: ReadonlyArray<string>,
  priorMessages: ReadonlyArray<AgentMessage>,
  useAI: boolean,
  status: StatusFn,
  profile: DepthProfile,
): Promise<ReadonlyArray<AdaptiveGapPlan>> {
  const gaps = detectGaps(coveredIds);
  if (gaps.length === 0) {
    status("All research dimensions covered — no gap queries needed");
    return [];
  }

  status(`Gaps: ${gaps.map((g) => g.label).join(", ")}`);

  const byRole = new Map<
    WorkerRole,
    {
      dimIds: string[];
      dimLabels: string[];
      queries: string[];
      followLinks: boolean;
      tiers?: ReadonlyArray<import("../types").SourceTier>;
    }
  >();

  const shortTopic = shortenTopic(topic);

  for (const gap of gaps) {
    const mapping = GAP_ROLE_MAP[gap.id] ?? {
      role: "breadth" as WorkerRole,
      followLinks: false,
    };
    const existing = byRole.get(mapping.role) ?? {
      dimIds: [],
      dimLabels: [],
      queries: [],
      followLinks: mapping.followLinks,
      tiers: mapping.tiers,
    };
    existing.dimIds.push(gap.id);
    existing.dimLabels.push(gap.label);
    existing.queries.push(...gap.queries(shortTopic));
    byRole.set(mapping.role, existing);
  }

  if (useAI) {
    const followUpContext = priorMessages
      .flatMap((m) => m.suggestedFollowUps)
      .slice(0, 6);

    const entries = Array.from(byRole.entries());
    const aiResults = await Promise.allSettled(
      entries.map(async ([role, group]) => {
        const queryCount = Math.min(
          group.dimLabels.length * 3,
          profile.maxGapFillQueries,
        );
        const prompt = `You are a research assistant. A research session on "${topic}" is missing these angles:
${group.dimLabels.join(", ")}

${followUpContext.length > 0 ? `Previous round suggested exploring:\n${followUpContext.join("\n")}\n` : ""}
Generate ${queryCount} specific search queries to fill these gaps.
The queries should be best suited for a ${role} research agent.
Make queries diverse — cover different angles and phrasings.
Return ONLY the queries, one per line.

Queries:`;
        return { role, raw: await callLoadedModel(prompt) };
      }),
    );

    for (const result of aiResults) {
      if (result.status !== "fulfilled" || !result.value.raw) continue;
      const { role, raw } = result.value;
      const parsed = parseLines(raw, profile.maxGapFillQueries);
      if (parsed.length >= 2) {
        const group = byRole.get(role);
        if (group) group.queries = [...parsed];
      }
    }
  }

  const plans: AdaptiveGapPlan[] = [];
  for (const [role, group] of byRole) {
    plans.push({
      role,
      label: `Gap-fill: ${group.dimLabels.slice(0, 3).join(", ")}`,
      queries: group.queries.slice(0, profile.maxGapFillQueries),
      followLinks: group.followLinks,
      preferredTiers: group.tiers,
    });
  }

  status(`${plans.length} adaptive gap-fill worker(s) planned`);
  return plans;
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
  "that",
  "could",
  "which",
  "about",
  "their",
  "this",
  "these",
  "those",
  "would",
  "should",
  "current",
  "hypothetical",
  "scenarios",
  "lead",
]);

function extractKeywords(topic: string): ReadonlyArray<string> {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

function shortenTopic(topic: string): string {
  const colonIdx = topic.indexOf(":");
  const dashIdx = topic.indexOf(" — ");
  const sepIdx = colonIdx > 3 ? colonIdx : dashIdx > 3 ? dashIdx : -1;

  let core: string;
  if (sepIdx > 3 && sepIdx < topic.length * 0.6) {
    core = topic.slice(0, sepIdx).trim();
  } else {
    core = topic;
  }

  const words = core
    .replace(/[,;()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));

  let result = "";
  let count = 0;
  for (const w of words) {
    if (count >= 6 || result.length + w.length > 58) break;
    result += (result ? " " : "") + w;
    count++;
  }

  if (result.length < 5) {
    result = topic.split(/\s+/).slice(0, 5).join(" ");
  }

  return result;
}
