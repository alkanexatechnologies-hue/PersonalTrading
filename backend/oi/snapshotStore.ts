import fs from "fs";
import path from "path";
import { OiAnalysis } from "../types";
import { istDateStr } from "../hourly/store";

// ---- Daily OI snapshot store ----
// Persists a per-symbol OI snapshot each time the chain is read, keyed by IST
// date (latest reading of the day wins ~= near-close). This lets the morning
// "opening play" compare TODAY's early OI to the PREVIOUS session's OI.

export interface OiSnapshot {
  date: string; // IST date
  ts: number; // epoch seconds
  pcr: number | null;
  totalCeOi: number;
  totalPeOi: number;
  support: number | null;
  resistance: number | null;
  maxPain: number | null;
  underlying: number | null;
}

const FILE = path.join(process.cwd(), "data", "oi-snapshots.json");

function loadAll(): Record<string, OiSnapshot[]> {
  try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return {}; }
}
function saveAll(store: Record<string, OiSnapshot[]>) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store, null, 2), "utf-8"); } catch { /* best-effort */ }
}

// Record/refresh today's snapshot for a symbol (latest reading wins).
export function saveOiSnapshot(symbol: string, oi: OiAnalysis): void {
  if (!oi || !oi.available) return;
  const store = loadAll();
  const arr = store[symbol] || [];
  const date = istDateStr();
  const snap: OiSnapshot = {
    date, ts: Math.floor(Date.now() / 1000),
    pcr: oi.pcr, totalCeOi: oi.totalCeOi, totalPeOi: oi.totalPeOi,
    support: oi.support, resistance: oi.resistance, maxPain: oi.maxPain, underlying: oi.underlying,
  };
  const kept = arr.filter((s) => s.date !== date); // replace today's with the newest
  kept.push(snap);
  store[symbol] = kept.slice(-40);
  saveAll(store);
}

// Most recent snapshot from a PRIOR day (the "yesterday" reference).
export function latestSnapshot(symbol: string): OiSnapshot | null {
  const arr = loadAll()[symbol] || [];
  if (!arr.length) return null;
  return arr.reduce((b, s) => (s.ts >= b.ts ? s : b));
}

export function priorDaySnapshot(symbol: string, todayDate = istDateStr()): OiSnapshot | null {
  const arr = (loadAll()[symbol] || []).filter((s) => s.date < todayDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  return arr.length ? arr[arr.length - 1] : null;
}
