import fs from "fs";
import path from "path";

// ============================ Advisory suggestion log ============================
// ADVISORY ONLY. This module records what the system SUGGESTED and, later, what
// the market ACTUALLY DID. It never places, sizes or routes an order, and it is
// never consulted by the decision path - it only observes it.
//
// Two things are deliberately kept apart everywhere in this file:
//   CONFIDENCE  - the engine's own score at signal time (a prediction)
//   OUTCOME     - what the market did afterwards (a measurement)
// A high confidence never becomes an outcome, and an outcome is never inferred
// from a score. Accuracy is computed only from resolved measurements.

export type LayerName = "SETUP" | "DIRECTIONAL" | "SCALP";

/** What an individual layer produced, independent of the final decision. */
export type LayerState = "PASS" | "WAIT" | "BLOCK" | "NO_EDGE" | "CANDIDATE";

/** The advisory suggestion shown to the trader. Not an order instruction. */
export type Suggestion = "BUY CE" | "BUY PE" | "WAIT" | "WAIT FOR PULLBACK" | "NO EDGE" | "AVOID";

/** Directional correctness at one observation window. */
export type DirResult = "CORRECT" | "WRONG" | "NEUTRAL" | "UNRESOLVED";

/** Whether the simulated trade would have worked - separate from direction. */
export type TradeOutcome = "TARGET_HIT" | "STOP_HIT" | "PARTIAL" | "LOSS" | "FLAT" | "UNRESOLVED";

/** For WAIT decisions: was holding back right? */
export type WaitEval = "CORRECT_WAIT" | "MISSED_OPPORTUNITY" | "NEUTRAL" | "UNRESOLVED";

export interface ObservationWindow {
  minutes: number;
  /** Spot at the end of the window, or null when no candle covered it yet. */
  spotAfter: number | null;
  /** Signed spot move in points from the signal spot. */
  spotMovePts: number | null;
  /** Directional correctness for the suggested side. */
  dirResult: DirResult;
  /** Option premium at the window end, when option history was available. */
  premiumAfter: number | null;
  /** Signed premium move as a percentage of the entry premium. */
  premiumMovePct: number | null;
}

export interface WallContext {
  support: number | null;
  resistance: number | null;
  /** Points of room toward the wall in the suggested direction. */
  roomPts: number | null;
  /** Points of room the engine required (max(expLow, spot*0.001) in oiTrade). */
  requiredRoomPts: number | null;
  /** Which wall was relevant for the direction under consideration. */
  wallSide: "resistance" | "support" | null;
}

export interface WallOutcome {
  /** Did price stay on the original side of the wall through the horizon? */
  wallHeld: boolean | null;
  /** Did a completed 5m candle close beyond the wall? */
  breakoutConfirmed: boolean | null;
  /** Did price pierce the wall intrabar but close back inside? */
  falseBreakout: boolean | null;
}

export interface SuggestionRecord {
  id: string;
  at: number;          // epoch seconds of the signal
  istDate: string;     // YYYY-MM-DD
  istTime: string;     // HH:MM:SS
  symbol: string;
  name: string;

  /** Per-layer states, so the UI can show where the suggestion came from. */
  layers: Record<LayerName, LayerState>;
  /** The layer(s) that actually produced the actionable candidate, e.g. "DIRECTIONAL + SCALP". */
  sourcePath: string;
  /** The engine's real verdict vocabulary - GO / WAIT / CONFLICT. */
  masterVerdict: string;
  /** The advisory suggestion derived for display. */
  suggestion: Suggestion;

  optionType: "CE" | "PE" | null;
  strike: number | null;
  expiry: string | null;
  /** Exact option symbol, needed to resolve premium history. */
  tradingSymbol: string | null;

  spotAtSignal: number | null;
  entryPremium: number | null;
  stopPremium: number | null;
  targetPremium: number | null;
  spotTarget: number | null;
  spotStop: number | null;

  /** The engine's score AT SIGNAL TIME. A prediction, never an outcome. */
  confidence: number | null;
  /** Why the system said what it said - especially the WAIT reasons. */
  reasons: string[];
  wall: WallContext;

  // ---- filled in later by the resolver, from real market data ----
  resolved: boolean;
  resolvedAt: number | null;
  /** Observation windows in minutes, in ascending order. */
  windows: ObservationWindow[];
  /** Target/stop outcome on the option premium - distinct from direction. */
  tradeOutcome: TradeOutcome;
  /** For non-actionable decisions: was the WAIT justified? */
  waitEval: WaitEval;
  wallOutcome: WallOutcome;
  /** Set when something prevented resolution (no candles, no option history...). */
  unresolvedReason: string | null;
}

const DIR = path.join(process.cwd(), "data", "advisory");
const FILE = path.join(DIR, "suggestions.jsonl");

/** Observation windows in minutes. Fixed set, per the advisory spec. */
export const WINDOWS_MIN = [5, 15, 30];

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

export function emptyWindows(): ObservationWindow[] {
  return WINDOWS_MIN.map((minutes) => ({
    minutes, spotAfter: null, spotMovePts: null, dirResult: "UNRESOLVED",
    premiumAfter: null, premiumMovePct: null,
  }));
}

export function appendSuggestion(rec: SuggestionRecord): void {
  try {
    ensureDir();
    fs.appendFileSync(FILE, JSON.stringify(rec) + "\n", "utf-8");
  } catch { /* advisory logging is best-effort - never blocks a decision */ }
}

export function readSuggestions(limit = 500): SuggestionRecord[] {
  try {
    const lines = fs.readFileSync(FILE, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as SuggestionRecord);
  } catch {
    return [];
  }
}

/**
 * Rewrites the whole log with the given records. Used by the resolver to fill in
 * outcomes. The file is small (a few hundred rows per day) so a rewrite is
 * simpler and safer than in-place patching of a JSONL file.
 */
export function rewriteSuggestions(records: SuggestionRecord[]): void {
  try {
    ensureDir();
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf-8");
    fs.renameSync(tmp, FILE);
  } catch { /* best-effort */ }
}

/**
 * De-duplication key. The dashboard re-polls every ~15s, so the same standing
 * suggestion must not be recorded dozens of times: one row per symbol per
 * distinct suggestion per 5-minute bucket.
 */
export function dedupeKey(r: Pick<SuggestionRecord, "symbol" | "suggestion" | "strike" | "at">): string {
  const bucket = Math.floor(r.at / 300);
  return `${r.symbol}|${r.suggestion}|${r.strike ?? "-"}|${bucket}`;
}

export function suggestionsFilePath(): string {
  return FILE;
}
