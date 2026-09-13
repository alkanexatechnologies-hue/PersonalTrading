// ============================ Sections 14-15 — Liquidity Shift Detection & Time-Based Change ============================
// Persisted per-symbol, reset daily — same file-based JSON pattern as
// backend/optionTopPick/confirmationState.ts (temp+rename write, owner-only file).
// Only an ACTUAL state change is appended as a new point (not every poll), so the
// history reads as "09:30 Neutral -> 11:15 Bullish -> 12:05 Strong Bullish", not
// a firehose of identical readings.

import fs from "fs";
import path from "path";
import { istDateStr, istTimeStr } from "../util/istTime";
import { LS_CONFIG } from "./config";
import { LiquidityShiftEvent, LiquidityShiftState, TimeSeriesPoint } from "./types";

interface StoredSymbolHistory { date: string; points: TimeSeriesPoint[] }
const FILE = path.join(process.cwd(), "data", "liquidity-status-shift-history.json");

function loadAll(): Record<string, StoredSymbolHistory> {
  try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return {}; }
}
function saveAll(all: Record<string, StoredSymbolHistory>): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.ls-shift.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export interface ShiftRecordResult { history: TimeSeriesPoint[]; lastEvent: LiquidityShiftEvent | null }

export function recordShift(symbol: string, currentState: LiquidityShiftState, nowEpochSec: number): ShiftRecordResult {
  const all = loadAll();
  const today = istDateStr(nowEpochSec * 1000);
  let entry = all[symbol];
  if (!entry || entry.date !== today) entry = { date: today, points: [] };

  const lastPoint = entry.points[entry.points.length - 1] ?? null;
  let lastEvent: LiquidityShiftEvent | null = null;

  if (!lastPoint || lastPoint.state !== currentState) {
    if (lastPoint) {
      lastEvent = {
        timestamp: nowEpochSec, previous: lastPoint.state, current: currentState,
        reason: reasonFor(lastPoint.state, currentState),
      };
    }
    entry.points.push({ time: istTimeStr(nowEpochSec * 1000), state: currentState });
    if (entry.points.length > LS_CONFIG.shift.historyCap) entry.points = entry.points.slice(-LS_CONFIG.shift.historyCap);
  }

  all[symbol] = entry;
  saveAll(all);
  return { history: entry.points, lastEvent };
}

function reasonFor(previous: LiquidityShiftState, current: LiquidityShiftState): string {
  if (previous === "Neutral" && (current === "Bullish" || current === "Strong Bullish")) return "Put support increased while call resistance decreased.";
  if (previous === "Neutral" && (current === "Bearish" || current === "Strong Bearish")) return "Call resistance increased while put support decreased.";
  if ((previous === "Bullish" || previous === "Strong Bullish") && (current === "Bearish" || current === "Strong Bearish")) return "Liquidity flipped from the call side to the put side.";
  if ((previous === "Bearish" || previous === "Strong Bearish") && (current === "Bullish" || current === "Strong Bullish")) return "Liquidity flipped from the put side to the call side.";
  if (current === "Conflict") return "Price and OI structure began disagreeing.";
  return `State moved from ${previous} to ${current}.`;
}

/** Test-only: clear persisted history for a symbol. */
export function clearShiftHistoryForTest(symbol: string): void {
  const all = loadAll();
  delete all[symbol];
  saveAll(all);
}
