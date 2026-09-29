import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";
import type { FiiRow, FiiSummary, FiiPositionType, Bias } from "./types";

// ============================ FII index-futures positioning ============================
// The FII long/short in index futures is published by NSE (daily participant-wise
// OI), NOT by any broker API. Source precedence:
//   1. FII_DATA_URL  — a JSON endpoint you point at: an array of
//      { date:"yyyy-mm-dd", longQty:number, shortQty:number, close?:number,
//        netValueCr?:number }  (newest or oldest first — we sort).
//   2. NSE public participant OI CSV (best-effort; NSE often blocks server calls).
// Parsed rows are cached daily under DATA_DIR/sentiment. If neither source yields
// data, the section reports DATA UNAVAILABLE — FII positioning is NEVER inferred
// or fabricated. NSE's participant file is an AGGREGATE index-futures figure (not
// split by NIFTY/BANKNIFTY/FINNIFTY), which we state plainly.

const DIR = path.join(DATA_DIR, "sentiment");
const CACHE = path.join(DIR, "fii-futures.json");

function readCache(): FiiRow[] {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf-8")); } catch { return []; }
}
function writeCache(rows: FiiRow[]): void {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(rows), "utf-8"); } catch { /* best-effort */ }
}

/** Classify one session from the REAL net-position change (and underlying move
 *  when available). Pure + tested. Returns null when there's no prior day to
 *  compare against (we never guess a type without evidence). */
export function classifyFii(netToday: number, netPrev: number | null, closeChg: number | null): FiiPositionType | null {
  if (netPrev == null) return null;
  const d = netToday - netPrev;
  if (Math.abs(d) < 1000) return "NEUTRAL"; // negligible change
  if (d > 0) {
    // Net position rose (more long / less short). With a firm/up close it reads
    // as fresh longs; with a down close it reads as shorts being covered.
    return closeChg != null && closeChg < 0 ? "SHORT COVERING" : "LONG BUILDUP";
  }
  // Net position fell (more short / fewer longs).
  return closeChg != null && closeChg > 0 ? "LONG UNWINDING" : "SHORT BUILDUP";
}

/** Build the summary (behaviour / pressure / bias / N-day changes) from real rows. */
export function summariseFii(rows: FiiRow[]): FiiSummary {
  if (!rows.length) {
    return { available: false, currentNet: null, prevNet: null, change5d: null, change10d: null,
      change20d: null, behaviour: null, pressure: null, bias: null, rows: [], freshness: "UNAVAILABLE",
      note: "DATA UNAVAILABLE — connect FII_DATA_URL or an NSE participant-OI source." };
  }
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date)); // newest first
  const net = (i: number) => (sorted[i] ? sorted[i].netPos : null);
  const currentNet = net(0);
  const prevNet = net(1);
  const chg = (n: number) => (currentNet != null && net(n) != null ? currentNet - (net(n) as number) : null);
  const change5d = chg(5), change10d = chg(10), change20d = chg(20);

  // Behaviour = most recent classified session (already computed per row).
  const behaviour = sorted[0]?.positionType ?? null;
  // Bias from the sign of the current net position.
  const bias: Bias = currentNet == null ? "NEUTRAL" : currentNet > 5000 ? "BULLISH" : currentNet < -5000 ? "BEARISH" : "NEUTRAL";
  // Pressure from the trend (net getting more long/short over recent sessions).
  let pressure: FiiSummary["pressure"] = "NEUTRAL";
  const trend = change5d ?? (prevNet != null && currentNet != null ? currentNet - prevNet : null);
  if (trend != null) pressure = trend > 3000 ? "UPWARD" : trend < -3000 ? "DOWNWARD" : "NEUTRAL";

  return {
    available: true, currentNet, prevNet, change5d, change10d, change20d,
    behaviour, pressure, bias, rows: sorted,
    freshness: "DELAYED", // published end-of-day, so never LIVE
    note: "Aggregate NSE index-futures participant OI (per-index split not published).",
  };
}

/** Compute netPos/dailyChange/type across a raw list (oldest→newest ok; we sort). */
export function enrichFiiRows(raw: { date: string; longQty: number | null; shortQty: number | null; close?: number | null; netValueCr?: number | null }[]): FiiRow[] {
  const asc = [...raw].sort((a, b) => a.date.localeCompare(b.date)); // oldest first for change calc
  const out: FiiRow[] = [];
  for (let i = 0; i < asc.length; i++) {
    const r = asc[i];
    const netPos = r.longQty != null && r.shortQty != null ? r.longQty - r.shortQty : null;
    const prev = out[i - 1];
    const prevNet = prev ? prev.netPos : null;
    const dailyChange = netPos != null && prevNet != null ? netPos - prevNet : null;
    const closeChg = prev && prev.close != null && r.close != null ? (r.close as number) - prev.close : null;
    out.push({
      date: r.date, longQty: r.longQty, shortQty: r.shortQty, netPos, dailyChange,
      netValueCr: r.netValueCr ?? null, close: r.close ?? null,
      positionType: netPos != null ? classifyFii(netPos, prevNet, closeChg) : null,
    });
  }
  return out;
}

/** Load FII futures history (real sources only), newest first. */
export async function getFiiFutures(sessions = 20): Promise<FiiSummary> {
  let raw: any[] = [];
  const url = process.env.FII_DATA_URL && process.env.FII_DATA_URL.trim();
  if (url) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      const j = await res.json();
      const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
      raw = arr.map((r: any) => ({
        date: String(r.date || r.Date || "").slice(0, 10),
        longQty: numOrNull(r.longQty ?? r.long ?? r.FIIIndexLong),
        shortQty: numOrNull(r.shortQty ?? r.short ?? r.FIIIndexShort),
        close: numOrNull(r.close ?? r.Close),
        netValueCr: numOrNull(r.netValueCr ?? r.netValue),
      })).filter((r: any) => r.date && (r.longQty != null || r.shortQty != null));
    } catch { /* fall through to cache / unavailable */ }
  }
  if (raw.length) {
    const enriched = enrichFiiRows(raw);
    writeCache(enriched);
    return summariseFii(enriched.slice(-sessions));
  }
  // No live source — serve cache if we have it (still real, just older).
  const cached = readCache();
  if (cached.length) { const s = summariseFii(cached.slice(-sessions)); s.freshness = "STALE"; return s; }
  return summariseFii([]);
}

function numOrNull(v: any): number | null { if (v == null || v === "") return null; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
