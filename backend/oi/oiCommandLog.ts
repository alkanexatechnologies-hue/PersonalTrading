import fs from "fs";
import path from "path";
import { istDateStr } from "../hourly/store";

// ---- OI Command signal log + multi-horizon evaluator ----
// Records each high-confidence OI Command signal and later checks whether the
// predicted direction played out at THREE horizons: 5 min, 15 min, 1 hour.
// This builds a forward track-record ("how often the OI logic was correct").

export type Horizon = "5" | "15" | "60";
export const HORIZONS: Horizon[] = ["5", "15", "60"];

export interface OiSignalEval {
  due: number;                 // epoch when this horizon can be evaluated
  at?: number;                 // epoch when actually evaluated
  evalSpot?: number;           // underlying spot at evaluation
  favMove?: number;            // move in the predicted direction (points)
  status: "pending" | "correct" | "wrong" | "flat";
}
export interface OiSignal {
  id: string; at: number; istDate: string;
  symbol: string; name: string;
  direction: "UP" | "DOWN"; optionType: "CE" | "PE"; strike: number | null;
  confidence: number; spot: number; expLow: number; expHigh: number;
  h: Record<Horizon, OiSignalEval>;
}

const FILE = path.join(process.cwd(), "data", "oi-command-log.json");

function loadAll(): OiSignal[] {
  try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return []; }
}
function saveAll(rows: OiSignal[]) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(rows.slice(-800), null, 2), "utf-8"); } catch { /* best-effort */ }
}

// Log a signal (deduped: only one per symbol per ~15-min slot per day).
export function logOiSignal(s: {
  symbol: string; name: string; direction: "UP" | "DOWN"; optionType: "CE" | "PE";
  strike: number | null; confidence: number; spot: number; expLow: number; expHigh: number;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  const rows = loadAll();
  const date = istDateStr();
  // Dedupe: skip if this symbol already has a signal in the last 14 min today.
  const recent = rows.find((r) => r.symbol === s.symbol && r.istDate === date && now - r.at < 14 * 60);
  if (recent) return false;
  const mk = (mins: number): OiSignalEval => ({ due: now + mins * 60, status: "pending" });
  rows.push({
    id: `oisig-${now}-${s.symbol.replace(/[^A-Z0-9]/gi, "")}`,
    at: now, istDate: date, symbol: s.symbol, name: s.name,
    direction: s.direction, optionType: s.optionType, strike: s.strike,
    confidence: s.confidence, spot: Math.round(s.spot * 100) / 100,
    expLow: Math.max(1, Math.round(s.expLow)), expHigh: Math.max(1, Math.round(s.expHigh)),
    h: { "5": mk(5), "15": mk(15), "60": mk(60) },
  });
  saveAll(rows);
  return true;
}

// Evaluate every pending horizon whose time is due, using a live-spot fetcher.
export async function evaluateOiSignals(getSpot: (symbol: string) => Promise<number | null>): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows = loadAll();
  let changed = false;
  // Cache spot per symbol for this pass.
  const spotCache = new Map<string, number | null>();
  const spotOf = async (sym: string) => {
    if (spotCache.has(sym)) return spotCache.get(sym)!;
    let v: number | null = null;
    try { v = await getSpot(sym); } catch { v = null; }
    spotCache.set(sym, v);
    return v;
  };
  for (const r of rows) {
    for (const hz of HORIZONS) {
      const e = r.h[hz];
      if (e.status !== "pending" || now < e.due) continue;
      const spot = await spotOf(r.symbol);
      if (spot == null || !(spot > 0)) continue;
      const favMove = r.direction === "UP" ? spot - r.spot : r.spot - spot;
      e.at = now; e.evalSpot = Math.round(spot * 100) / 100; e.favMove = Math.round(favMove * 100) / 100;
      e.status = favMove >= r.expLow ? "correct" : favMove <= -r.expLow ? "wrong" : "flat";
      changed = true;
    }
  }
  if (changed) saveAll(rows);
}

const istTime = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(11, 16);

// Review: per-horizon stats for TODAY's signals with confidence >= minConf, plus
// the last N correct signals (with their time) for each horizon.
export function reviewOiSignals(symbol: string | undefined, minConf: number, lastN: number): any {
  const date = istDateStr();
  const rows = loadAll().filter((r) => r.istDate === date && (!symbol || r.symbol === symbol) && r.confidence >= minConf);
  const horizons: Record<string, any> = {};
  for (const hz of HORIZONS) {
    const evald = rows.filter((r) => r.h[hz].status !== "pending");
    const correct = evald.filter((r) => r.h[hz].status === "correct");
    const wrong = evald.filter((r) => r.h[hz].status === "wrong");
    const flat = evald.filter((r) => r.h[hz].status === "flat");
    const high80 = rows.filter((r) => r.confidence >= 80);
    const lastCorrect = correct.slice().sort((a, b) => b.at - a.at).slice(0, lastN).map((r) => ({
      time: istTime(r.at), symbol: r.symbol, name: r.name, dir: r.direction,
      optionType: r.optionType, strike: r.strike, confidence: r.confidence,
      favMove: r.h[hz].favMove, evalSpot: r.h[hz].evalSpot, entrySpot: r.spot,
    }));
    horizons[hz] = {
      total: rows.length, evaluated: evald.length,
      correct: correct.length, wrong: wrong.length, flat: flat.length, pending: rows.length - evald.length,
      winPct: evald.length ? Math.round((correct.length / evald.length) * 1000) / 10 : 0,
      high80Count: high80.length,
      lastCorrect,
    };
  }
  return { date, minConf, count: rows.length, horizons };
}
