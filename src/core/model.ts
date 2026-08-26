/**
 * @file core/model.ts
 * THE single LLM wrapper. Timeout-bounded, signal-aware, optional zod schema
 * validation, null on any failure (caller decides fallback; ledger records).
 */
import { LMStudioClient } from "@lmstudio/sdk";
import { z } from "zod";
import type { StatusFn } from "./types";

export interface ModelCallOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0.3;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collectModel(
  prompt: string,
  opts: ModelCallOptions,
): Promise<string | null> {
  const client = new LMStudioClient();
  const models = await withTimeout(client.llm.listLoaded(), opts.timeoutMs);
  if (!Array.isArray(models) || models.length === 0) return null;

  const model = await client.llm.model(models[0].identifier);
  const stream = model.respond([{ role: "user", content: prompt }], {
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
  });

  let result = "";
  for await (const chunk of stream) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    result += chunk.content ?? "";
  }
  return result.trim() || null;
}

/** Runs a prompt; returns trimmed text or null on ANY failure. */
export async function callLLM(
  prompt: string,
  opts: ModelCallOptions,
  status: StatusFn | null,
): Promise<string | null> {
  try {
    const raw = await collectModel(prompt, opts);
    if (raw === null && status) status("No LLM loaded — skipping AI step");
    return raw;
  } catch {
    return null;
  }
}

function stripCodeFence(raw: string): string {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenceMatch) return fenceMatch[1].trim();
  // Also tolerate raw JSON embedded in prose.
  const braceStart = Math.min(
    ...[raw.indexOf("{"), raw.indexOf("[")].filter((i) => i !== -1),
  );
  if (Number.isFinite(braceStart)) {
    const lastBrace = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
    if (lastBrace > braceStart) return raw.slice(braceStart, lastBrace + 1);
  }
  return raw.trim();
}

export interface JsonCallResult<T> {
  value: T | null;
  reason: "model-unavailable" | "invalid-json" | "schema-mismatch" | null;
}

/** Calls the LLM and validates the response against a zod schema. */
export async function callLLMJson<S extends z.ZodType>(
  prompt: string,
  schema: S,
  opts: ModelCallOptions,
  status: StatusFn | null,
): Promise<JsonCallResult<z.infer<S>>> {
  const raw = await callLLM(prompt, opts, status);
  if (raw === null) return { value: null, reason: "model-unavailable" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripCodeFence(raw));
  } catch {
    return { value: null, reason: "invalid-json" };
  }

  const check = schema.safeParse(parsedJson);
  if (!check.success) {
    if (status) status(`AI output failed validation (${check.error.issues.length} issue(s))`);
    return { value: null, reason: "schema-mismatch" };
  }
  return { value: check.data, reason: null };
}
