// ============================ Liquidity Analysis — morning levels, takes, 20-day history ============================
// RESEARCH / ANALYSIS ONLY. Nothing here is a trading signal: it never produces
// BUY CE / BUY PE and is never read by the arbiter, paper engine or trade
// execution. Pure functions over real candles (the caller supplies Dhan data).
//
// DEFINITIONS (all times IST; the trader's day ends at 15:15 — candles starting
// at/after 15:15 are ignored, like everywhere else in Market Command):
//
// Levels (known BEFORE they are used — no look-ahead):
//   Previous Day High / Low / Close  previous session's 5m candles      active from 09:15
//   Today 15M High / Low             the first 15-min candle 09:15-09:30 active from 09:30
//   Opening Range High / Low         existing app definition (liquidityLevels.openingRange,
//                                    09:15-09:20)                       active from its end
//   Swing High / Low                 15m fractal pivots (2 bars each side) from the previous
//                                    5 sessions that are still UNTAKEN at today's open
//   Equal High / Low                 two or more untaken swing highs (lows) within
//                                    max(0.05% of price, 0.1 x ATR15)
//   Structure Resistance / Support   price zones touched by >= 3 pivots (highs or lows)
//                                    within 0.15% over the previous 5 sessions
//   Levels closer than max(0.03% of price, 0.1 x ATR) are consolidated into ONE level
//   that lists every source (highest-priority source names it).
//   Side: DOWNSIDE if the level is below the price when it becomes active, else UPSIDE.
//
// Liquidity TAKEN (decided on CLOSED candles only): the first candle whose low
//   (downside level) trades below level − tol, or whose high (upside) trades above
//   level + tol, where tol = max(0.5 pt, 0.05 x ATR14 of the chosen timeframe).
//
// TIME TO LIQUIDITY: from the close of the LAST candle that closed farther than
//   1 x ATR14 from the level ("market was far"), or from the level's activation if
//   price was never far, to the close of the candle that took the liquidity.
//   Resolution = the candle interval (5 min on 5M) because Dhan provides no
//   1-minute data; shown as HH:MM:SS.
//
// AFTER LIQUIDITY (future candles used ONLY for the outcome, never to find the take):
//   moves at +1/+2/+3/+5/+10 candles = close[i+k] − close[i] (signed, + = up).
//   Reversal side = back toward where price came from (up after a downside take).
//   MFE = furthest reversal extent, MAE = furthest continuation extent, within 10 candles.
//   Outcome: first side to travel 1 x ATR14 → REVERSAL / CONTINUATION; if both
//   happen → FALSE (whipsaw); neither within 10 candles → NO EDGE; fewer than 10
//   candles so far and neither → PENDING.

import type { Candle } from "../types";
import { ema, atr } from "../indicators";
import { openingRange } from "./liquidityLevels";

const IST = 19800;
export const LT_END_MIN = 15 * 60 + 15;
const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + IST) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const r2 = (n: number) => Math.round(n * 100) / 100;
const last = <T>(a: (T | null)[]): T | null => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as T; return null; };

export type LevelSide = "DOWNSIDE" | "UPSIDE";
export type LevelStatus = "WAITING" | "APPROACHING" | "TOUCHED" | "LIQUIDITY TAKEN" | "REJECTED" | "ACCEPTED" | "BROKEN" | "INVALIDATED";
export type Outcome = "REVERSAL" | "CONTINUATION" | "FALSE" | "NO EDGE" | "PENDING";
export type Dir = "UP" | "DOWN" | "SIDEWAYS";

export interface LiqLevel {
  id: string; type: string; sources: string[]; price: number; side: LevelSide;
  activeFrom: number;            // epoch sec the level becomes known
  refPrice: number;              // price when it became active (side reference)
  priority: number;
}
export interface LiqEvent {
  date: string; day: string; time: string; takenAt: number;
  levelType: string; sources: string[]; side: LevelSide; level: number; marketPrice: number;
  prevDirection: Dir; dir15: Dir | null; dir5: Dir | null;
  candleHigh: number; candleLow: number; candleClose: number; candleRange: number;
  timeToLiquiditySec: number; timeToLiquidity: string; sweepSize: number; atr: number;
  afterDirection: Dir | null; moves: Record<string, number | null>;
  mfe: number | null; mae: number | null; pointsCaptured: number | null; pctMove: number | null; atrMove: number | null;
  timeToMaxSec: number | null; outcome: Outcome; pattern: string;
  strike: number | null;
}
export interface LevelTrack { level: LiqLevel; status: LevelStatus; distance: number | null; takenAt: number | null; event: LiqEvent | null; }

export function sessionsOf(candles: Candle[]): Map<string, Candle[]> {
  const m = new Map<string, Candle[]>();
  for (const c of candles) {
    const mm = istMin(c.time);
    if (mm < 9 * 60 + 15 || mm >= LT_END_MIN) continue;
    const d = istDay(c.time);
    let a = m.get(d); if (!a) { a = []; m.set(d, a); } a.push(c);
  }
  for (const a of m.values()) a.sort((x, y) => x.time - y.time);
  return m;
}

/** 5m → n×5m candles aligned to 09:15 within one session. */
export function aggregate(s5: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  for (const c of s5) {
    const slot = Math.floor((istMin(c.time) - (9 * 60 + 15)) / (5 * n));
    const start = c.time - ((istMin(c.time) - (9 * 60 + 15)) % (5 * n)) * 60;
    const b = out[out.length - 1];
    if (b && (b as any)._slot === slot) { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.volume += c.volume; }
    else { const nb: any = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; Object.defineProperty(nb, "_slot", { value: slot, enumerable: false }); out.push(nb); }
  }
  return out;
}

function pivots(c: Candle[], k = 2): { highs: { t: number; p: number }[]; lows: { t: number; p: number }[] } {
  const highs: { t: number; p: number }[] = [], lows: { t: number; p: number }[] = [];
  for (let i = k; i < c.length - k; i++) {
    let h = true, l = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (c[j].high >= c[i].high) h = false; if (c[j].low <= c[i].low) l = false; }
    if (h) highs.push({ t: c[i].time, p: c[i].high });
    if (l) lows.push({ t: c[i].time, p: c[i].low });
  }
  return { highs, lows };
}

const PRIORITY: Record<string, number> = {
  "Previous Day High": 1, "Previous Day Low": 1, "Previous Day Close": 2, "Opening Range High": 3, "Opening Range Low": 3,
  "Today 15M High": 4, "Today 15M Low": 4, "Equal High": 5, "Equal Low": 5, "Swing High": 6, "Swing Low": 6,
  "Structure Resistance": 7, "Structure Support": 7, "OI Support": 3, "OI Resistance": 3,
};

/** Levels for session `day`, built only from data known before each level's activation. */
/** `extra` = levels supplied by the caller (e.g. today's morning OI support/resistance). */
export function buildLevels(prior: Candle[][], today5: Candle[], nowSec: number, extra: LiqLevel[] = []): LiqLevel[] {
  const out: LiqLevel[] = [];
  if (!prior.length || !today5.length) return out;
  const pd = prior[prior.length - 1];
  const open = today5[0];
  const openT = open.time;
  const add = (type: string, price: number | null, activeFrom: number, refPrice: number, source: string) => {
    if (price == null || !isFinite(price) || activeFrom > nowSec) return;
    out.push({ id: "", type, sources: [source], price: r2(price), side: price < refPrice ? "DOWNSIDE" : "UPSIDE", activeFrom, refPrice, priority: PRIORITY[type] ?? 9 });
  };
  const pdh = Math.max(...pd.map((c) => c.high)), pdl = Math.min(...pd.map((c) => c.low)), pdc = pd[pd.length - 1].close;
  // Previous-session levels: side vs previous close; a gap through them is handled as INVALIDATED by the tracker.
  add("Previous Day High", pdh, openT, pdc, "Previous day");
  add("Previous Day Low", pdl, openT, pdc, "Previous day");
  add("Previous Day Close", pdc, openT, open.open, "Previous day");
  // Today's first 15 minutes (09:15-09:30), known at 09:30.
  const first15 = today5.filter((c) => istMin(c.time) < 9 * 60 + 30);
  const t930 = openT + 15 * 60;
  if (first15.length === 3) {
    const ref = first15[2].close;
    add("Today 15M High", Math.max(...first15.map((c) => c.high)), t930, ref - 1e-9, "Today 09:15-09:30");
    add("Today 15M Low", Math.min(...first15.map((c) => c.low)), t930, ref + 1e-9, "Today 09:15-09:30");
  }
  // Opening range — the app's existing definition.
  const or = openingRange(today5.filter((c) => istMin(c.time) < 9 * 60 + 30), nowSec);
  if (or.established && or.high != null && or.low != null) {
    const orBars = today5.filter((c) => istMin(c.time) < 9 * 60 + 15 + 5 * Math.max(1, or.barCount));
    const orEnd = orBars[orBars.length - 1].time + 300;
    const ref = orBars[orBars.length - 1].close;
    add("Opening Range High", or.high, orEnd, ref - 1e-9, `Opening range ${or.window}`);
    add("Opening Range Low", or.low, orEnd, ref + 1e-9, `Opening range ${or.window}`);
  }
  // Structure from the previous 5 sessions (15m).
  const hist15 = prior.slice(-5).flatMap((s) => aggregate(s, 3));
  const a15 = last(atr(hist15, 14)) ?? (pdh - pdl) / 6;
  const pv = pivots(hist15);
  const after = (t: number) => hist15.filter((c) => c.time > t);
  const untakenHigh = pv.highs.filter((h) => after(h.t).every((c) => c.high <= h.p) && h.p > open.open);
  const untakenLow = pv.lows.filter((l) => after(l.t).every((c) => c.low >= l.p) && l.p < open.open);
  const nearest = <T extends { p: number }>(a: T[], above: boolean, n: number) => a.slice().sort((x, y) => above ? x.p - y.p : y.p - x.p).slice(0, n);
  for (const h of nearest(untakenHigh, true, 3)) add("Swing High", h.p, openT, open.open, `15m pivot ${istDay(h.t).slice(5)} ${hm(h.t)}`);
  for (const l of nearest(untakenLow, false, 3)) add("Swing Low", l.p, openT, open.open, `15m pivot ${istDay(l.t).slice(5)} ${hm(l.t)}`);
  const eqTol = Math.max(open.open * 0.0005, a15 * 0.1);
  const equal = (a: { t: number; p: number }[], hi: boolean) => {
    const used = new Set<number>();
    for (let i = 0; i < a.length; i++) {
      if (used.has(i)) continue;
      const grp = a.filter((x, j) => j !== i && !used.has(j) && Math.abs(x.p - a[i].p) <= eqTol);
      if (!grp.length) continue;
      grp.forEach((g) => used.add(a.indexOf(g))); used.add(i);
      const all = [a[i], ...grp];
      const p = hi ? Math.max(...all.map((x) => x.p)) : Math.min(...all.map((x) => x.p));
      add(hi ? "Equal High" : "Equal Low", p, openT, open.open, `${all.length} untaken 15m pivots`);
    }
  };
  equal(untakenHigh, true); equal(untakenLow, false);
  const zTol = open.open * 0.0015;
  const allPiv = [...pv.highs, ...pv.lows].map((x) => x.p).sort((x, y) => x - y);
  const zones: { p: number; n: number }[] = [];
  for (const p of allPiv) { const z = zones[zones.length - 1]; if (z && Math.abs(p - z.p) <= zTol) { z.p = (z.p * z.n + p) / (z.n + 1); z.n++; } else zones.push({ p, n: 1 }); }
  const strong = zones.filter((z) => z.n >= 3);
  const res = strong.filter((z) => z.p > open.open).sort((x, y) => x.p - y.p)[0];
  const sup = strong.filter((z) => z.p < open.open).sort((x, y) => y.p - x.p)[0];
  if (res) add("Structure Resistance", res.p, openT, open.open, `${res.n} pivot touches (5 sessions)`);
  if (sup) add("Structure Support", sup.p, openT, open.open, `${sup.n} pivot touches (5 sessions)`);
  for (const x of extra) if (x.activeFrom <= nowSec) out.push({ ...x, sources: x.sources.slice() });
  return consolidate(out, Math.max(open.open * 0.0003, a15 * 0.1));
}

function consolidate(levels: LiqLevel[], tol: number): LiqLevel[] {
  const sorted = levels.slice().sort((a, b) => a.priority - b.priority);
  const kept: LiqLevel[] = [];
  for (const l of sorted) {
    const k = kept.find((x) => Math.abs(x.price - l.price) <= tol && x.side === l.side);
    if (k) { for (const s of [l.type + ": " + l.sources[0]]) if (!k.sources.includes(s)) k.sources.push(s); k.activeFrom = Math.min(k.activeFrom, l.activeFrom); }
    else kept.push({ ...l, sources: [l.type + ": " + l.sources[0]] });
  }
  return kept.sort((a, b) => b.price - a.price).map((l, i) => ({ ...l, id: `${l.side[0]}${i}-${l.type}` }));
}

export function hm(t: number): string { return new Date((t + IST) * 1000).toISOString().slice(11, 16); }
export function hms(sec: number): string { const s = Math.max(0, Math.round(sec)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, "0")).join(":"); }
const dirOf = (d: number, thr: number): Dir => d > thr ? "UP" : d < -thr ? "DOWN" : "SIDEWAYS";

/**
 * Track one level through a session's CLOSED candles (chosen timeframe).
 * `c15` = the session's closed 15m candles plus prior history (for the 15M trend).
 */
export function trackLevel(level: LiqLevel, ses: Candle[], tfSec: number, nowSec: number, hist: Candle[], c15: Candle[], strikeStep: number | null): LevelTrack {
  const closed = ses.filter((c) => c.time + tfSec <= nowSec);
  const all = [...hist, ...closed];
  const atrs = atr(all, 14);
  const off = hist.length;
  const down = level.side === "DOWNSIDE", L = level.price;
  let status: LevelStatus = "WAITING", takenIdx = -1, lastFar = level.activeFrom;
  const start = closed.findIndex((c) => c.time + tfSec > level.activeFrom);
  if (start < 0) return { level, status, distance: null, takenAt: null, event: null };
  // Gapped through at activation (previous-session levels): no sweep happened.
  const first = closed[start];
  if (level.type.startsWith("Previous Day") && level.type !== "Previous Day Close" && (down ? first.open < L : first.open > L) && first.time <= level.activeFrom) {
    return { level, status: "INVALIDATED", distance: r2(down ? first.close - L : L - first.close), takenAt: null, event: null };
  }
  for (let i = start; i < closed.length; i++) {
    const c = closed[i], a = atrs[off + i] ?? atrs[off + i - 1] ?? (c.high - c.low);
    const tol = Math.max(0.5, 0.05 * a);
    const dist = down ? c.close - L : L - c.close;
    if (down ? c.low < L - tol : c.high > L + tol) { takenIdx = i; break; }
    if (dist > a) { lastFar = c.time + tfSec; status = "WAITING"; }
    else status = (down ? c.low <= L + tol : c.high >= L - tol) ? "TOUCHED" : "APPROACHING";
  }
  const lastC = closed[closed.length - 1];
  const distance = lastC ? r2(down ? lastC.close - L : L - lastC.close) : null;
  if (takenIdx < 0) return { level, status, distance, takenAt: null, event: null };

  const i = takenIdx, c = closed[i];
  const a = atrs[off + i] ?? (c.high - c.low);
  const takenAt = c.time + tfSec;
  // Post-take status from later closes.
  const beyond = (x: Candle) => down ? x.close < L : x.close > L;
  const rejectedOnTake = !beyond(c);
  let st: LevelStatus = "LIQUIDITY TAKEN", consec = beyond(c) ? 1 : 0, accepted = false, closedBack = rejectedOnTake;
  if (rejectedOnTake) st = "REJECTED";
  for (let j = i + 1; j < closed.length && j <= i + 10; j++) {
    if (beyond(closed[j])) { consec++; if (consec >= 2 && !closedBack) { accepted = true; st = "ACCEPTED"; } if (accepted && (down ? L - closed[j].close : closed[j].close - L) >= a) st = "BROKEN"; }
    else { consec = 0; if (!closedBack || accepted) { closedBack = true; st = "REJECTED"; } }
  }
  // After-event metrics (future candles → outcome only).
  const post = closed.slice(i + 1, i + 11);
  const moves: Record<string, number | null> = {};
  for (const k of [1, 2, 3, 5, 10]) moves[`${k}C`] = post[k - 1] ? r2(post[k - 1].close - c.close) : null;
  let mfe = 0, mae = 0, tMax = 0, tR = -1, tC = -1;
  post.forEach((x, k) => {
    const rev = down ? x.high - c.close : c.close - x.low;
    const cont = down ? c.close - x.low : x.high - c.close;
    if (rev > mfe) { mfe = rev; tMax = (k + 1) * tfSec; }
    if (cont > mae) mae = cont;
    if (tR < 0 && rev >= a) tR = k;
    if (tC < 0 && cont >= a) tC = k;
  });
  let outcome: Outcome;
  if (tR >= 0 && tC >= 0) outcome = "FALSE";
  else if (tR >= 0) outcome = "REVERSAL";
  else if (tC >= 0) outcome = "CONTINUATION";
  else outcome = post.length >= 10 ? "NO EDGE" : "PENDING";
  const endMove = post.length ? post[post.length - 1].close - c.close : null;
  const afterDirection = endMove == null ? null : dirOf(endMove, 0.3 * a);
  const signedCapture = post.length ? (mfe >= mae ? (down ? mfe : -mfe) : (down ? -mae : mae)) : null;
  let pattern = "No Edge";
  if (outcome !== "PENDING") {
    if (accepted) pattern = outcome === "CONTINUATION" ? "Breakout + Continuation" : outcome === "REVERSAL" ? "Failed Breakout + Reversal" : closedBack ? "Breakout + Rejection" : "No Edge";
    else if (rejectedOnTake) pattern = outcome === "REVERSAL" ? "Liquidity Grab + Rejection" : outcome === "CONTINUATION" ? "Sweep + Continuation" : "No Edge";
    else pattern = outcome === "REVERSAL" ? "Sweep + Reversal" : outcome === "CONTINUATION" ? "Sweep + Continuation" : "No Edge";
  } else pattern = "Pending";
  // Directions known AT the take (no look-ahead).
  const pre = all.slice(Math.max(0, off + i - 6), off + i);
  const prevDirection = pre.length ? dirOf(c.close - pre[0].close, 0.3 * a) : "SIDEWAYS";
  const e = (xs: Candle[]) => { const cl = xs.map((x) => x.close); const f = last(ema(cl, 9)), s = last(ema(cl, 21)); return f == null || s == null ? null : f > s ? "UP" as Dir : f < s ? "DOWN" as Dir : "SIDEWAYS" as Dir; };
  const dir5 = e(all.slice(0, off + i + 1));
  const dir15 = e(c15.filter((x) => x.time + 900 <= takenAt));
  const event: LiqEvent = {
    date: istDay(c.time), day: new Date((c.time + IST) * 1000).toUTCString().slice(0, 3), time: hm(takenAt), takenAt,
    levelType: level.type, sources: level.sources, side: level.side, level: L, marketPrice: c.close,
    prevDirection, dir15, dir5, candleHigh: c.high, candleLow: c.low, candleClose: c.close, candleRange: r2(c.high - c.low),
    timeToLiquiditySec: takenAt - lastFar, timeToLiquidity: hms(takenAt - lastFar),
    sweepSize: r2(down ? L - c.low : c.high - L), atr: r2(a),
    afterDirection, moves, mfe: post.length ? r2(mfe) : null, mae: post.length ? r2(mae) : null,
    pointsCaptured: signedCapture == null ? null : r2(signedCapture), pctMove: signedCapture == null ? null : r2(signedCapture / c.close * 100),
    atrMove: signedCapture == null ? null : r2(signedCapture / a), timeToMaxSec: post.length ? tMax : null,
    outcome, pattern, strike: strikeStep ? Math.round(L / strikeStep) * strikeStep : null,
  };
  return { level, status: st, distance, takenAt, event };
}

export interface DayAnalysis { date: string; levels: LevelTrack[]; events: LiqEvent[]; }

/** Analyse one session (index `di` of the ordered session list) as of `nowSec`. */
export function analyseDay(days: string[], ses: Map<string, Candle[]>, di: number, tfMin: 5 | 15, nowSec: number, strikeStep: number | null, extra: LiqLevel[] = []): DayAnalysis | null {
  if (di < 1) return null;
  const date = days[di];
  const prior = days.slice(Math.max(0, di - 6), di).map((d) => ses.get(d)!);
  const today5 = ses.get(date)!.filter((c) => c.time + 300 <= nowSec);
  if (!today5.length) return { date, levels: [], events: [] };
  const levels = buildLevels(prior, today5, nowSec, extra);
  const tfSec = tfMin * 60;
  const sesTf = tfMin === 15 ? aggregate(ses.get(date)!, 3) : ses.get(date)!;
  const histTf = (tfMin === 15 ? prior.slice(-2).flatMap((s) => aggregate(s, 3)) : prior.slice(-2).flat());
  const c15 = [...prior.slice(-3).flatMap((s) => aggregate(s, 3)), ...aggregate(ses.get(date)!, 3)];
  const tracks = levels.map((l) => trackLevel(l, sesTf, tfSec, nowSec, histTf, c15, strikeStep));
  const events = tracks.map((t) => t.event).filter((e): e is LiqEvent => !!e).sort((a, b) => b.takenAt - a.takenAt);
  return { date, levels: tracks, events };
}
