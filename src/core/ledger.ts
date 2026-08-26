/**
 * @file core/ledger.ts
 * Per-run diagnostics: engine stats and filter counters, rendered into the
 * final report.
 */
import type { EngineId, StatusFn, WarnFn } from "./types";

export interface EngineStat {
  queries: number;
  hits: number;
  failures: number;
  breakerOpens: number;
  lastError: string | null;
}

export interface LedgerStats {
  engines: Record<string, EngineStat>;
  fetched: number;
  filteredOffTopic: number;
  filteredDuplicate: number;
  filteredTooShort: number;
  cacheFallbacks: number;
  pdfExtracts: number;
  localHits: number;
  budget: { total: number; used: number };
  errors: ReadonlyArray<string>;
}

export class RunLedger {
  private readonly engineStats = new Map<EngineId, EngineStat>();
  private readonly errorLog: string[] = [];
  fetched = 0;
  filteredOffTopic = 0;
  filteredDuplicate = 0;
  filteredTooShort = 0;
  cacheFallbacks = 0;
  pdfExtracts = 0;
  localHits = 0;

  constructor(
    private readonly status: StatusFn,
    private readonly warn: WarnFn,
  ) {}

  engine(id: EngineId): EngineStat {
    let s = this.engineStats.get(id);
    if (!s) {
      s = { queries: 0, hits: 0, failures: 0, breakerOpens: 0, lastError: null };
      this.engineStats.set(id, s);
    }
    return s;
  }

  recordQuery(id: EngineId): void {
    const s = this.engine(id);
    s.queries++;
  }

  recordHits(id: EngineId, count: number): void {
    const s = this.engine(id);
    if (count > 0) s.hits += count;
  }

  recordFailure(id: EngineId, message: string): void {
    const s = this.engine(id);
    s.failures++;
    s.lastError = message.slice(0, 160);
    this.warn(`${id} search failed: ${message}`);
  }

  recordBreakerOpen(id: EngineId): void {
    this.engine(id).breakerOpens++;
  }

  note(message: string): void {
    this.status(`  · ${message}`);
  }

  warnOnce(key: string, message: string): void {
    if (this.errorLog.some((e) => e.startsWith(key))) return;
    this.errorLog.push(`${key}: ${message}`);
    this.warn(message);
  }

  addError(source: string, err: unknown): void {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.errorLog.push(`${source}: ${msg.slice(0, 200)}`);
  }

  snapshot(totalBudget: number, usedBudget: number): LedgerStats {
    const engines: Record<string, EngineStat> = {};
    for (const [id, stat] of [...this.engineStats.entries()].sort()) {
      engines[id] = { ...stat };
    }
    return {
      engines,
      fetched: this.fetched,
      filteredOffTopic: this.filteredOffTopic,
      filteredDuplicate: this.filteredDuplicate,
      filteredTooShort: this.filteredTooShort,
      cacheFallbacks: this.cacheFallbacks,
      pdfExtracts: this.pdfExtracts,
      localHits: this.localHits,
      budget: { total: totalBudget, used: usedBudget },
      errors: [...this.errorLog],
    };
  }
}

/** Renders the ledger as a Markdown diagnostics section. */
export function renderDiagnostics(stats: LedgerStats): string {
  const lines: string[] = [
    "## Run Diagnostics",
    "",
    "| Engine | Queries | Hits | Failures | Breaker Opens | Last Error |",
    "|---|---|---|---|---|---|",
  ];
  let anyEngine = false;
  for (const [id, s] of Object.entries(stats.engines)) {
    anyEngine = true;
    lines.push(
      `| ${id} | ${s.queries} | ${s.hits} | ${s.failures} | ${s.breakerOpens} | ${s.lastError ?? "—"} |`,
    );
  }
  if (!anyEngine) lines.push("| (no engines invoked) | 0 | 0 | 0 | 0 | — |");

  lines.push(
    "",
    `- Pages fetched & accepted: **${stats.fetched}** (budget ${stats.budget.used}/${stats.budget.total})`,
    `- Filtered: off-topic ${stats.filteredOffTopic} · duplicate ${stats.filteredDuplicate} · too short ${stats.filteredTooShort}`,
    `- Fallbacks used: cache/archive ${stats.cacheFallbacks} · PDF extractions ${stats.pdfExtracts} · local chunks ${stats.localHits}`,
  );

  if (stats.errors.length > 0) {
    lines.push("", "<details><summary>Errors encountered (first 15)</summary>", "");
    for (const e of stats.errors.slice(0, 15)) lines.push(`- \`${e}\``);
    lines.push("", "</details>");
  }

  return lines.join("\n");
}
