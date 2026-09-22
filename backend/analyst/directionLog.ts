import fs from "fs";
import path from "path";

// ===================== Direction-change learning log (read-only) =====================
// Records when the VALIDATED market direction for a symbol flips, with the
// evidence on each side at the moment of the change. This is a learning record,
// not a trading signal — it never changes any rule. Deduped per symbol via an
// in-memory "last direction" so a standing direction is not re-logged on every
// 5-second poll; only an actual change is appended to disk.

export type PlanDir = "BULLISH" | "BEARISH" | "NEUTRAL" | "CONFLICT";

export interface DirectionChangeInput {
  symbol: string;
  at: number;           // epoch seconds
  spot: number;
  direction: PlanDir;
  bullishEvidence: string[];
  bearishEvidence: string[];
}

export interface DirectionChange {
  symbol: string;
  at: number;
  istTime: string;
  spot: number;
  previous: PlanDir;
  next: PlanDir;
  bullishEvidence: string[];
  bearishEvidence: string[];
}

const FILE = path.join(process.cwd(), "data", "analyst", "direction-changes.jsonl");
const _last = new Map<string, PlanDir>();
const istTime = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(11, 19);

/** Records a change when the direction differs from the last seen for the symbol.
 *  Returns the change that was just recorded (or null when unchanged). */
export function recordDirectionChange(inp: DirectionChangeInput): DirectionChange | null {
  const prev = _last.get(inp.symbol);
  _last.set(inp.symbol, inp.direction);
  if (prev === undefined || prev === inp.direction) return null; // first observation or no change

  const change: DirectionChange = {
    symbol: inp.symbol, at: inp.at, istTime: istTime(inp.at), spot: inp.spot,
    previous: prev, next: inp.direction,
    bullishEvidence: inp.bullishEvidence, bearishEvidence: inp.bearishEvidence,
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(change) + "\n", "utf-8");
  } catch { /* best-effort: logging must never break a request */ }
  return change;
}

/** Recent direction changes (optionally for one symbol), newest first. */
export function readDirectionChanges(symbol?: string, limit = 50): DirectionChange[] {
  try {
    const rows = fs.readFileSync(FILE, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DirectionChange);
    return rows.filter((r) => !symbol || r.symbol === symbol).slice(-limit).reverse();
  } catch { return []; }
}

/** Test helper — reset the in-memory dedupe state. */
export function _resetDirectionMemory(): void { _last.clear(); }
