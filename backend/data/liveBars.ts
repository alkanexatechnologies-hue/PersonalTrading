// ============================ LIVE BARS — candle fallback when Dhan's chart API is down ============================
// Dhan's /charts/intraday + /charts/historical can fail for a whole morning (23 Oct 2026: DH-905 on every request,
// index and options alike, while quotes and the option chain kept working). The screens then had no candles at all.
// This module keeps REAL Dhan prices only — nothing is invented:
//   • every Dhan quote (index LTP) and option-chain read (each strike's LTP + day volume) is written into 1-minute bars
//     in memory (and flushed to data/live-bars-<day>.json so a restart keeps the morning);
//   • history up to yesterday comes from the Dhan 5-min + official daily candles the 15:50 job saves
//     (data/research-nextday/dhan5m_<INDEX>.json).
// It is used ONLY when the chart API call fails; the source is reported (chartApiStatus) so the screens can say so.
// Bars built from samples can miss a spike between two reads — highs/lows may be slightly understated.
import fs from "fs";
import path from "path";
import { Candle } from "../types";
import { DATA_DIR, dataFile } from "../config/dataDir";

const IST = 19800, OPEN_MIN = 555, CLOSE_MIN = 930;
const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const r2 = (n: number) => Math.round(n * 100) / 100;

let day = istDay(Math.floor(Date.now() / 1000));
let bars = new Map<string, Map<number, Candle>>();          // key → minute epoch → bar
const lastCumVol = new Map<string, number>();
const dayOhlc = new Map<string, { open: number; high: number; low: number; close: number; volume: number; at: number }>();
const fileFor = (d: string) => dataFile(`live-bars-${d}.json`);

function load(d: string) {
  bars = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(d), "utf8"));
    for (const [k, rows] of Object.entries<any[]>(j.bars || {})) bars.set(k, new Map(rows.map((c) => [c.time, c])));
  } catch { /* nothing saved yet today */ }
}
load(day);
function rollDay(t: number) { const d = istDay(t); if (d !== day) { day = d; lastCumVol.clear(); dayOhlc.clear(); load(d); } }

let dirty = false;
const flush = setInterval(() => {
  if (!dirty) return; dirty = false;
  try { const out: Record<string, Candle[]> = {}; for (const [k, m] of bars) out[k] = [...m.values()];
    fs.mkdirSync(path.dirname(fileFor(day)), { recursive: true }); fs.writeFileSync(fileFor(day), JSON.stringify({ day, bars: out })); } catch { /* best effort */ }
}, 60_000);
flush.unref?.();

/** Record one real Dhan price for `key` ("sym:NIFTY" for an index / stock, "sec:<securityId>" for an option).
 *  `cumVol` is the day's cumulative volume when the feed carries it (turned into per-minute volume). */
export function recordTick(key: string, price: number, cumVol?: number | null, t = Math.floor(Date.now() / 1000)) {
  if (!(price > 0)) return;
  const m = istMin(t); if (m < OPEN_MIN || m >= CLOSE_MIN) return;
  const dow = new Date((t + IST) * 1000).getUTCDay(); if (dow === 0 || dow === 6) return;
  rollDay(t);
  const mt = t - (t % 60), mp = bars.get(key) || bars.set(key, new Map()).get(key)!;
  let v = 0;
  if (cumVol != null && cumVol > 0) { const prev = lastCumVol.get(key); if (prev != null && cumVol >= prev) v = cumVol - prev; lastCumVol.set(key, cumVol); }
  const b = mp.get(mt);
  if (!b) mp.set(mt, { time: mt, open: r2(price), high: r2(price), low: r2(price), close: r2(price), volume: v });
  else { b.high = Math.max(b.high, r2(price)); b.low = Math.min(b.low, r2(price)); b.close = r2(price); b.volume += v; }
  dirty = true;
}
/** Dhan's own day OHLC from a quote (gives today's daily candle exactly, even before we started sampling). */
export function recordDayOhlc(nse: string, q: { open?: number; high: number; low: number; close: number; volume?: number }) {
  if (!(q.close > 0)) return;
  const t = Math.floor(Date.now() / 1000), m = istMin(t); if (m < OPEN_MIN) return;
  rollDay(t);
  dayOhlc.set(nse, { open: q.open && q.open > 0 ? q.open : dayOhlc.get(nse)?.open ?? q.close, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0, at: t });
}

/** Resample 1-minute (or 5-minute) bars into `iv`-minute bars aligned to 09:15 IST. */
export function resampleSession(cs: Candle[], iv: number): Candle[] {
  const out = new Map<number, Candle>();
  for (const c of [...cs].sort((a, b) => a.time - b.time)) {
    const dayStart = c.time - ((c.time + IST) % 86400), m = istMin(c.time); if (m < OPEN_MIN) continue;
    const bt = dayStart + (OPEN_MIN + Math.floor((m - OPEN_MIN) / iv) * iv) * 60, b = out.get(bt);
    if (!b) out.set(bt, { ...c, time: bt });
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.volume += c.volume; }
  }
  return [...out.values()];
}
/** Today's live bars for a key at `iv` minutes (1, 5, 15, 25, 60 …). */
export function liveCandles(key: string, iv: number): Candle[] {
  rollDay(Math.floor(Date.now() / 1000));
  const m = bars.get(key); if (!m) return [];
  return resampleSession([...m.values()], Math.max(1, iv));
}

// ---- saved Dhan history (up to yesterday) ----
const SAVED: Record<string, string> = { NIFTY: "NIFTY", "NIFTY 50": "NIFTY", SENSEX: "SENSEX" };
const savedCache = new Map<string, { mtime: number; c5: Candle[]; d1: Candle[] }>();
function saved(nse: string) {
  const ix = SAVED[nse.toUpperCase()]; if (!ix) return null;
  const f = path.join(DATA_DIR, "research-nextday", `dhan5m_${ix}.json`);
  try { const mt = fs.statSync(f).mtimeMs, c = savedCache.get(ix); if (c && c.mtime === mt) return c;
    const j = JSON.parse(fs.readFileSync(f, "utf8")), v = { mtime: mt, c5: (j.c5 || []) as Candle[], d1: (j.d1 || []) as Candle[] }; savedCache.set(ix, v); return v; } catch { return null; }
}

/** Fallback candles for an index / stock: saved Dhan history (indices) + today's live bars. `iv` in minutes, or "1d". */
export function fallbackCandles(nse: string, iv: number | "1d", days: number): Candle[] {
  const now = Math.floor(Date.now() / 1000), from = now - days * 86400, today = istDay(now), s = saved(nse);
  if (iv === "1d") {
    const hist = (s?.d1 || []).filter((c) => c.time >= from && istDay(c.time) < today), d = dayOhlc.get(nse);
    const lb = liveCandles(`sym:${nse}`, 1), dayStart = now - ((now + IST) % 86400);
    const todayBar: Candle | null = d ? { time: dayStart, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }
      : lb.length ? { time: dayStart, open: lb[0].open, high: Math.max(...lb.map((c) => c.high)), low: Math.min(...lb.map((c) => c.low)), close: lb[lb.length - 1].close, volume: lb.reduce((a, c) => a + c.volume, 0) } : null;
    return todayBar ? [...hist, todayBar] : hist;
  }
  const hist = iv >= 5 && s ? resampleSession(s.c5.filter((c) => c.time >= from && istDay(c.time) < today), iv) : [];
  return [...hist, ...liveCandles(`sym:${nse}`, iv)];
}

// ---- chart-API status (for the screens' "source" line) ----
let downSince = 0, lastErr = "", lastOk = 0;
export function noteChartFail(msg: string) { if (!downSince || (lastOk && lastOk > downSince)) downSince = Math.floor(Date.now() / 1000); lastErr = msg.slice(0, 160); }
export function noteChartOk() { lastOk = Math.floor(Date.now() / 1000); downSince = 0; }
export function chartApiDown() { return downSince > 0; }
export function chartApiStatus() {
  return { down: downSince > 0, since: downSince || null, lastError: downSince ? lastErr : null, lastOk: lastOk || null,
    source: downSince > 0 ? "live Dhan quotes (chart API down)" : "Dhan chart API" };
}
