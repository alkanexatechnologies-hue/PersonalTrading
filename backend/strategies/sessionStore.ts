// ============================ Trader Specific Strategies — 20-session store ============================
// Records, per trading day per symbol, WHAT the layer selected and HOW the market
// actually behaved afterwards — the raw material for the 20-session test and for the
// historical-edge weighting. Append/update a small JSONL file (same storage model as
// the advisory log). Everything here is READ-ONLY over the trading engines: it only
// observes the ConditionSnapshot + spot the route already computed.
//
// No look-ahead: a day's record is only FINALIZED (result/MFE/MAE/correctness) once a
// LATER day opens, so today's outcome can never feed today's ranking.

import fs from "fs";
import path from "path";
import { ConditionSnapshot, DailySelection } from "./types";

export interface StrategySessionRecord {
  symbol: string;
  istDate: string;
  lockedAt: number;
  conditionLabel: string;
  regime: string | null;
  selectedStrategy: string | null;   // null = NO SUITABLE STRATEGY (WAIT)
  selectedName: string | null;
  matchScore: number | null;
  quality: string | null;
  alternatives: { id: string; name: string; score: number }[];
  trigger: string | null;
  spotAtLock: number | null;
  expectedMovePts: number | null;
  // running intraday tracking (updated each poll while the day is open)
  runHigh: number | null;
  runLow: number | null;
  lastSpot: number | null;
  // finalized once a later day opens
  resolved: boolean;
  actualMovePts: number | null;   // lastSpot - spotAtLock (signed)
  mfePts: number | null;          // best favourable excursion from lock (absolute)
  maePts: number | null;          // worst adverse excursion from lock (absolute)
  result: "MOVE_CONFIRMED" | "MUTED" | "NO_TRADE" | null;
  selectionCorrect: boolean | null; // proxy: did the observed behaviour match the pick?
}

const DIR = path.join(process.cwd(), "data", "strategies");
const FILE = path.join(DIR, "sessions.jsonl");

function readAll(): StrategySessionRecord[] {
  try {
    return fs.readFileSync(FILE, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as StrategySessionRecord);
  } catch { return []; }
}
function writeAll(rows: StrategySessionRecord[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch { /* best-effort: never break the cockpit on a log failure */ }
}

// Finalize a record from its tracked intraday high/low. "Confirmed" = the market
// actually produced a move on the order of the expected move; "muted" = it stayed
// small. For a WAIT day (no strategy), a muted market makes the WAIT correct.
function finalize(r: StrategySessionRecord): void {
  if (r.resolved) return;
  if (r.spotAtLock != null && r.runHigh != null && r.runLow != null && r.lastSpot != null) {
    r.actualMovePts = Math.round((r.lastSpot - r.spotAtLock) * 100) / 100;
    r.mfePts = Math.round((r.runHigh - r.spotAtLock) * 100) / 100;
    r.maePts = Math.round((r.spotAtLock - r.runLow) * 100) / 100;
    const span = Math.max(Math.abs(r.mfePts), Math.abs(r.maePts));
    const em = r.expectedMovePts && r.expectedMovePts > 0 ? r.expectedMovePts : null;
    const confirmed = em ? span >= 0.6 * em : span > 0;
    if (r.selectedStrategy == null) { r.result = "NO_TRADE"; r.selectionCorrect = !confirmed; }
    else { r.result = confirmed ? "MOVE_CONFIRMED" : "MUTED"; r.selectionCorrect = confirmed; }
  } else {
    r.result = r.selectedStrategy == null ? "NO_TRADE" : "MUTED";
    r.selectionCorrect = null;
  }
  r.resolved = true;
}

// Called on each cockpit poll. Creates today's record on first lock, updates the
// running high/low, and finalizes any earlier unresolved days (no look-ahead).
export function recordDaily(sel: DailySelection, snap: ConditionSnapshot): void {
  if (snap.dataStale || snap.regime == null) return; // never record a dead read
  const rows = readAll();
  const idx = rows.findIndex((r) => r.symbol === snap.symbol && r.istDate === snap.istDate);

  // Finalize this symbol's earlier, still-open days.
  for (const r of rows) if (r.symbol === snap.symbol && r.istDate !== snap.istDate && !r.resolved) finalize(r);

  const spot = snap.spot;
  if (idx < 0) {
    rows.push({
      symbol: snap.symbol, istDate: snap.istDate, lockedAt: sel.generatedAt,
      conditionLabel: sel.condition.label, regime: sel.condition.regime,
      selectedStrategy: sel.preferred?.id ?? null, selectedName: sel.preferred?.name ?? null,
      matchScore: sel.preferred?.score ?? null, quality: sel.preferred?.quality ?? null,
      alternatives: sel.ranking.filter((r) => r.id !== sel.preferred?.id && r.eligible).slice(0, 2).map((r) => ({ id: r.id, name: r.name, score: r.score })),
      trigger: sel.preferred?.trigger ?? null,
      spotAtLock: spot, expectedMovePts: sel.expectedMove.points,
      runHigh: spot, runLow: spot, lastSpot: spot,
      resolved: false, actualMovePts: null, mfePts: null, maePts: null, result: null, selectionCorrect: null,
    });
  } else {
    const r = rows[idx];
    if (spot != null) {
      r.lastSpot = spot;
      r.runHigh = r.runHigh == null ? spot : Math.max(r.runHigh, spot);
      r.runLow = r.runLow == null ? spot : Math.min(r.runLow, spot);
    }
  }
  writeAll(rows);
}

export function readSessions(symbol?: string, limit = 40): StrategySessionRecord[] {
  let rows = readAll();
  if (symbol) rows = rows.filter((r) => r.symbol === symbol);
  return rows.slice(-limit).reverse();
}

// Resolved-only view for a strategy in a given regime bucket — the evidence base.
export function resolvedFor(strategyId: string, regime: string | null): StrategySessionRecord[] {
  return readAll().filter((r) => r.resolved && r.selectedStrategy === strategyId && (regime == null || r.regime === regime));
}
