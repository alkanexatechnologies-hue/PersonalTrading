import fs from "fs";
import path from "path";
import { OiAnalysis } from "../types";
import { istDateStr } from "../util/istTime";

// ---- OI baseline store ----
// Persistence layer for the per-strike OI/LTP baseline captured at the first
// chain reading of the day (see oi/oiChange.ts for the classification logic
// that DIFFS live values against this baseline). Split out from oiChange.ts
// so the fs reads/writes live in one small, dedicated module - following the
// same pattern as oi/snapshotStore.ts - instead of being interleaved with the
// OI-change calculation logic, which made that module harder to unit test
// (every test would otherwise need to mock fs) and harder to reuse.

export interface StrikeBase { ceOi: number; peOi: number; ceLtp: number | null; peLtp: number | null; }
export interface Baseline { date: string; underlying: number | null; strikes: Map<number, StrikeBase>; }

const baselines = new Map<string, Baseline>();
const FILE = path.join(process.cwd(), "data", "oi-baselines.json");
let loaded = false;

function loadBaselines(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, { date: string; underlying: number | null; strikes: Record<string, StrikeBase> }>;
    const today = istDateStr();
    for (const [sym, b] of Object.entries(raw || {})) {
      if (!b || b.date !== today || !b.strikes) continue;
      const strikes = new Map<number, StrikeBase>();
      for (const [k, v] of Object.entries(b.strikes)) strikes.set(Number(k), v);
      if (strikes.size) baselines.set(sym, { date: b.date, underlying: b.underlying ?? null, strikes });
    }
  } catch { /* first run / corrupt file */ }
}

function persistBaselines(): void {
  try {
    const today = istDateStr();
    const out: Record<string, { date: string; underlying: number | null; strikes: Record<string, StrikeBase> }> = {};
    for (const [sym, b] of baselines) {
      if (b.date !== today) continue;
      const strikes: Record<string, StrikeBase> = {};
      for (const [k, v] of b.strikes) strikes[String(k)] = v;
      out[sym] = { date: b.date, underlying: b.underlying, strikes };
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(out), "utf-8");
  } catch { /* best-effort */ }
}

// Capture the EARLIEST chain of the day as the baseline (only the first per day sticks).
export function recordOiBaseline(symbol: string, oi: OiAnalysis): void {
  if (!oi || !oi.available || !oi.topStrikes || !oi.topStrikes.length) return;
  loadBaselines();
  const date = istDateStr();
  const existing = baselines.get(symbol);
  if (existing && existing.date === date) return;
  const strikes = new Map<number, StrikeBase>();
  for (const s of oi.topStrikes) strikes.set(s.strike, { ceOi: s.ceOi || 0, peOi: s.peOi || 0, ceLtp: s.ceLtp ?? null, peLtp: s.peLtp ?? null });
  baselines.set(symbol, { date, underlying: oi.underlying, strikes });
  persistBaselines();
}

/** Today's full baseline record for a symbol (or null if there isn't one yet). */
export function getBaseline(symbol: string): Baseline | null {
  loadBaselines();
  const b = baselines.get(symbol);
  return b && b.date === istDateStr() ? b : null;
}

// Baseline accessors (used by the full option-chain view for % change).
export function oiBaselineStrike(symbol: string, strike: number): StrikeBase | null {
  return getBaseline(symbol)?.strikes.get(strike) || null;
}
export function oiBaselineUnderlying(symbol: string): number | null {
  return getBaseline(symbol)?.underlying ?? null;
}
