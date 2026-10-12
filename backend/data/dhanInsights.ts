import fs from "fs";
import path from "path";
import { dhanMovers, dhanTechnical, type DhanSec, type MoverRow } from "./dhanDataApis";
import { fetchDhanCandles } from "./dhanHistorical";
import { ema, rsi, macd, atr } from "../indicators";
import { DATA_DIR } from "../config/dataDir";
import type { Candle } from "../types";

// ============================ Dhan insights (display only) ============================
// · F&O movers (market-wide): highest-OI and top-volume index options, futures OI gainers / losers
// · Dhan floor pivots (Classic / Fibonacci / Camarilla) for the selected index — shown beside the
//   app's own levels; they never enter the ladder, signals or the arbiter
// · Indicator cross-check: the app's EMA / RSI / MACD / ATR (backend/indicators) on Dhan 5-min
//   candles vs Dhan's /data/technical values for the same last closed candle

export const INDEX_SEC: Record<string, DhanSec & { name: string }> = {
  "^NSEI": { securityId: "13", exchangeSegment: "IDX_I", instrument: "INDEX", name: "NIFTY 50" },
  "^NSEBANK": { securityId: "25", exchangeSegment: "IDX_I", instrument: "INDEX", name: "BANKNIFTY" },
  "^CNXFIN": { securityId: "27", exchangeSegment: "IDX_I", instrument: "INDEX", name: "FINNIFTY" },
  "^NSEMDCP50": { securityId: "442", exchangeSegment: "IDX_I", instrument: "INDEX", name: "MIDCPNIFTY" },
  "^BSESN": { securityId: "51", exchangeSegment: "IDX_I", instrument: "INDEX", name: "SENSEX" },
};
const istDate = (ms: number) => new Date(ms + 19800_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

// ---- F&O movers ----
const clean = (r: MoverRow): MoverRow => ({ ...r, strike: r.strike != null && r.strike > 0 ? r.strike : null, pcr: r.pcr ? Math.round(r.pcr * 100) / 100 : null });
async function futures(category: "OI_GAINERS" | "OI_LOSERS") {
  const today = istDate(Date.now());
  // Dhan picks the futures month from the date given; after this month's expiry it can be empty → try next month.
  let r = await dhanMovers({ exchangeSegment: "NSE_FNO", instrument: ["FUTSTK", "FUTIDX"], category, expiry: today, limit: 10 });
  if (!r.rows.length) r = await dhanMovers({ exchangeSegment: "NSE_FNO", instrument: ["FUTSTK", "FUTIDX"], category, expiry: addDays(today, 10), limit: 10 });
  return r;
}
export async function fnoMovers() {
  const today = istDate(Date.now());
  const settle = async (p: Promise<{ rows: MoverRow[]; at: number; stale: boolean }>) => { try { const r = await p; return { rows: r.rows.map(clean), at: r.at, stale: r.stale }; } catch (e: any) { return { rows: [], at: null, stale: false, error: e?.message || "unavailable" }; } };
  const [highestOi, topVolume, futOiGainers, futOiLosers] = await Promise.all([
    settle(dhanMovers({ exchangeSegment: "NSE_FNO", instrument: ["OPTIDX"], category: "HIGHEST_OI", expiry: today, limit: 10 })),
    settle(dhanMovers({ exchangeSegment: "NSE_FNO", instrument: ["OPTIDX"], category: "TOP_VOLUME", expiry: today, limit: 10 })),
    settle(futures("OI_GAINERS")), settle(futures("OI_LOSERS")),
  ]);
  return { highestOi, topVolume, futOiGainers, futOiLosers, source: "Dhan market movers (market-wide; options ranked across expiries)", note: "Display only — not used by signals, the arbiter or paper trading." };
}

// ---- pivots ----
export async function indexPivots(symbol: string) {
  const sec = INDEX_SEC[symbol]; if (!sec) return { available: false, reason: "No Dhan index id for this symbol" };
  const { name, ...s } = sec;
  const t = await dhanTechnical(s, "D", ["PIVOT_CLASSIC", "PIVOT_FIBONACCI", "PIVOT_CAMARILLA"]);
  const p = t.data?.PIVOT; if (!p) return { available: false, reason: "Dhan returned no pivots" };
  const r2 = (v: any) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
  const KEYS = ["R3", "R2", "R1", "PP", "S1", "S2", "S3"];
  const sets = Object.fromEntries(["Classic", "Fibonacci", "Camarilla"].map((k) => [k, Object.fromEntries(KEYS.map((x) => [x, r2(p[k]?.[x])]))]));
  return { available: true, index: name, sets, keys: KEYS, at: t.at, stale: t.stale, note: "Dhan pivots from the previous session's OHLC. Reference only — the app's own levels are unchanged." };
}

// ---- indicator cross-check ----
export interface CheckRow { name: string; app: number | null; dhan: number | null; diff: number | null; tol: number; ok: boolean | null }
const last = (s: (number | null)[]) => { for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i] as number; return null; };
/** Compare app indicator values on `bars` (closed 5-min candles) with Dhan's values. Pure, testable. */
export function compareIndicators(bars: Candle[], dhan: any): CheckRow[] {
  const closes = bars.map((b) => b.close), px = closes[closes.length - 1] || 0;
  const dEma = (p: number) => (dhan?.EMA || []).find((e: any) => Number(e.period) === p)?.value ?? null;
  const rows: [string, number | null, number | null, number][] = [
    ["EMA 20", last(ema(closes, 20)), dEma(20), px * 0.0005],
    ["EMA 50", last(ema(closes, 50)), dEma(50), px * 0.0005],
    ["RSI 14", last(rsi(closes, 14)), dhan?.RSI?.value ?? null, 2],
    ["MACD hist", last(macd(closes).histogram), dhan?.MACD_HIST?.value ?? null, Math.max(1, px * 0.00005)],
    ["ATR 14", last(atr(bars, 14)), dhan?.ATR?.value ?? null, 0],
  ];
  return rows.map(([name, a, d, tol0]) => {
    const tol = name === "ATR 14" && d != null ? Math.abs(d) * 0.1 : tol0;
    const ok = a == null || d == null ? null : Math.abs(a - Number(d)) <= tol;
    const r = (v: number | null) => (v == null ? null : Math.round(Number(v) * 100) / 100);
    return { name, app: r(a), dhan: r(d == null ? null : Number(d)), diff: a == null || d == null ? null : r(a - Number(d)), tol: r(tol) as number, ok };
  });
}
const CHECK_FILE = path.join(DATA_DIR, "indicator-check.json");
export function readIndicatorCheck(): any { try { return JSON.parse(fs.readFileSync(CHECK_FILE, "utf-8")); } catch { return null; } }
/** NIFTY 5-min: drop the forming candle, compute the app's values, fetch Dhan's, store the result. */
export async function runIndicatorCheck(symbol = "^NSEI") {
  const { name, ...sec } = INDEX_SEC[symbol];
  const today = istDate(Date.now());
  const bars = (await fetchDhanCandles(sec as any, "5", addDays(today, -7), addDays(today, 1))).filter((b) => b.time + 300 <= Date.now() / 1000);
  if (bars.length < 60) throw new Error("not enough 5-min candles");
  const t = await dhanTechnical(sec, "5", ["EMA_20", "EMA_50", "RSI_14", "MACD_HIST", "ATR_14"]);
  const rows = compareIndicators(bars, t.data);
  const judged = rows.filter((r) => r.ok != null);
  const out = { at: Math.floor(Date.now() / 1000), index: name, candle: bars[bars.length - 1].time, rows,
    status: !judged.length ? "NO DATA" : judged.every((r) => r.ok) ? "MATCH" : "MISMATCH",
    note: "App indicators (backend/indicators) on Dhan 5-min candles vs Dhan /data/technical, last closed candle. Timing can differ by one candle while a bar closes." };
  try { fs.mkdirSync(path.dirname(CHECK_FILE), { recursive: true }); fs.writeFileSync(CHECK_FILE, JSON.stringify(out)); } catch { /* best effort */ }
  return out;
}
