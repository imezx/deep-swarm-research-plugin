/**
 * @file engines/registry.ts
 * Circuit breaker per engine. Three consecutive failures open it for a
 * cooldown; an explicit HTTP 429 opens it immediately for the server-suggested
 * duration and is logged once instead of on every blocked attempt.
 */
import type { EngineId, SearchHit } from "../core/types";
import { RateLimitedError } from "../core/errors";
import type { SearchEngine } from "./types";

export const BREAKER_OPEN_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;
/** Fallback wait when a 429 carries no usable Retry-After. */
export const RATE_LIMIT_COOLDOWN_MS = 45_000;

export type BreakerState = "closed" | "open" | "half-open";

export interface EngineHealth {
  breaker: BreakerState;
  consecutiveFailures: number;
}

const healthMap = new Map<EngineId, EngineHealth>();
const cooldownUntil = new Map<EngineId, number>();

function healthOf(id: EngineId): EngineHealth {
  let h = healthMap.get(id);
  if (!h) {
    h = { breaker: "closed", consecutiveFailures: 0 };
    healthMap.set(id, h);
  }
  return h;
}

function openBreaker(id: EngineId, cooldownMs: number): void {
  const health = healthOf(id);
  health.breaker = "open";
  health.consecutiveFailures = Math.max(health.consecutiveFailures, BREAKER_OPEN_THRESHOLD);
  cooldownUntil.set(id, Date.now() + cooldownMs);
}

export interface SearchLedgerHooks {
  recordQuery(id: EngineId): void;
  recordHits(id: EngineId, count: number): void;
  recordFailure(id: EngineId, message: string): void;
  recordBreakerOpen(id: EngineId): void;
  /** Called once when a breaker opens (rate limit or repeated failures). */
  noteBreakerOpen?(id: EngineId, reason: string): void;
}

/**
 * Wraps an engine with the circuit breaker and reports outcomes to the
 * ledger. Returns [] immediately while the breaker is open.
 */
export async function guardedSearch(
  engine: SearchEngine,
  query: string,
  limit: number,
  signal: AbortSignal,
  ledger: SearchLedgerHooks,
): Promise<SearchHit[]> {
  const health = healthOf(engine.id);

  if (health.breaker === "open") {
    const until = cooldownUntil.get(engine.id) ?? 0;
    if (Date.now() < until) return []; // still cooling down
    health.breaker = "half-open"; // probe request
  }

  ledger.recordQuery(engine.id);
  try {
    const hits = await engine.search(query, limit, signal);
    if (health.consecutiveFailures > 0 || health.breaker === "half-open") {
      health.consecutiveFailures = 0;
      health.breaker = "closed";
    }
    ledger.recordHits(engine.id, hits.length);
    return hits;
  } catch (err) {
    if (signal.aborted) throw err;

    if (err instanceof RateLimitedError) {
      // Server explicitly said "slow down" — honor it, say so once.
      const wasOpen: string = health.breaker;
      openBreaker(engine.id, err.retryAfterSeconds * 1000);
      if (!wasOpen) {
        ledger.noteBreakerOpen?.(engine.id, err.message);
        ledger.recordFailure(engine.id, `rate limited (${err.retryAfterSeconds}s cooldown)`);
      }
      return [];
    }

    health.consecutiveFailures += 1;
    if (health.consecutiveFailures >= BREAKER_OPEN_THRESHOLD && (health.breaker as string) !== "open") {
      ledger.recordBreakerOpen(engine.id);
      ledger.noteBreakerOpen?.(engine.id, `${health.consecutiveFailures} failures in a row`);
      openBreaker(engine.id, BREAKER_COOLDOWN_MS);
    }
    ledger.recordFailure(engine.id, err instanceof Error ? err.message : String(err));
    return [];
  }
}

export function breakerStates(): ReadonlyArray<{ id: EngineId } & EngineHealth> {
  return [...healthMap.entries()].map(([id, h]) => ({ id, ...h }));
}
