/**
 * @file engines/types.ts
 * SearchEngine contract + registry interfaces.
 */
import type { EngineId, SearchHit, SearchScope } from "../core/types";

export interface SearchEngine {
  readonly id: EngineId;
  /** Scopes this engine serves well. */
  readonly scopes: ReadonlyArray<SearchScope>;
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]>;
}

/** Circuit breaker states per engine. */
export type BreakerState = "closed" | "open" | "half-open";

export interface EngineHealth {
  breaker: BreakerState;
  consecutiveFailures: number;
}

export const BREAKER_OPEN_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

const healthMap = new Map<EngineId, EngineHealth>();

function healthOf(id: EngineId): EngineHealth {
  let h = healthMap.get(id);
  if (!h) {
    h = { breaker: "closed", consecutiveFailures: 0 };
    healthMap.set(id, h);
  }
  return h;
}

/**
 * Wraps an engine with a circuit breaker and reports outcomes to the ledger.
 * When the breaker is open, returns [] immediately (fast-fail).
 */
const cooldownUntil = new Map<EngineId, number>();

export async function guardedSearch(
  engine: SearchEngine,
  query: string,
  limit: number,
  signal: AbortSignal,
  ledger: { recordQuery(id: EngineId): void; recordHits(id: EngineId, n: number): void; recordFailure(id: EngineId, m: string): void; recordBreakerOpen(id: EngineId): void },
): Promise<SearchHit[]> {
  const health = healthOf(engine.id);

  if (health.breaker === "open") {
    const until = cooldownUntil.get(engine.id) ?? 0;
    if (Date.now() < until) return []; // still cooling down — fast-fail
    health.breaker = "half-open"; // probe
  }

  ledger.recordQuery(engine.id);
  try {
    const hits = await engine.search(query, limit, signal);
    // Success: reset. A half-open probe that returns (even 0 hits) closes it.
    if (health.consecutiveFailures > 0 || health.breaker === "half-open") {
      health.consecutiveFailures = 0;
      health.breaker = "closed";
    }
    ledger.recordHits(engine.id, hits.length);
    return hits;
  } catch (err) {
    if (signal.aborted) throw err;
    const priorState: string = health.breaker;
    health.consecutiveFailures += 1;
    if (health.consecutiveFailures >= BREAKER_OPEN_THRESHOLD && priorState !== "open") {
      ledger.recordBreakerOpen(engine.id);
      health.breaker = "open";
      cooldownUntil.set(engine.id, Date.now() + BREAKER_COOLDOWN_MS);
    }
    ledger.recordFailure(engine.id, err instanceof Error ? err.message : String(err));
    return [];
  }
}

export function breakerStates(): ReadonlyArray<{ id: EngineId } & EngineHealth> {
  return [...healthMap.entries()].map(([id, h]) => ({ id, ...h }));
}
