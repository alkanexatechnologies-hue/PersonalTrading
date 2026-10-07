// ============================================================================
// BREAKOUT ENGINE — direction from indicators, trigger from Support/Resistance.
//
//   indicators (EMA / VWAP / UT Bot / LinReg / momentum / structure)
//        → BIAS (why: per-check PASS/FAIL)
//   nearest meaningful S/R in the bias direction
//        → WAIT FOR BREAKOUT / WAIT FOR SUPPORT BREAK
//   closed candle beyond the level (+buffer, strong close, participation)
//        → BUY CONFIRMED / SELL CONFIRMED   (direction is right)
//   not extended, structural SL, target beyond the immediate obstacle, R:R ≥ min
//        → BUY / SELL                       (direction is right AND executable)
//
// STRICT NO-LOOK-AHEAD: every decision at bar i uses candles[0..i] only. Swing
// levels are fractals that are confirmed only once their right-hand bars have
// CLOSED; previous-day levels come from the prior session; the opening range only
// exists once its bars have closed. Signals fire on a CLOSED candle; a backtest
// fills at the NEXT candle's open. Outcomes (replay only) are a forward walk that
// is never fed back as input.
//
// Price-derived levels only (swings, PDH/PDL/PDC, floor pivots, opening range,
// session high/low). OI walls are NOT used as triggers because there is no
// historical option chain — using them live but not in replay would make the
// backtest differ from the live logic.
//
// Pure module: no I/O, no Dhan calls. Option strike selection happens in the
// route using the EXISTING strike analyser + instrument master.
// ============================================================================

import { Candle } from "../types";
import { ema, atr, vwap } from "../indicators";
import { utBot, linReg, volumeState } from "../testlab/components";
import { detectMarketStructure } from "../liquidity/orderBlock";

export const BREAKOUT_CONFIG = {
  emaFast: 9, emaSlow: 21, emaTrend: 50, atrPeriod: 14,
  utKey: 1, utAtrPeriod: 10,           // same UT Bot settings as the Test Lab baseline
  regLookback: 20,
  structureWindow: 120, structureLookback: 3,
  swingStrength: 2,                    // fractal: 2 bars each side (right side must be CLOSED)
  minHistory: 30,                      // bars before any decision
  biasMin: 60,                         // weighted bias score needed (0..100)
  biasEdge: 20,                        // and this far ahead of the opposite side
  breakBufferAtr: 0.1,                 // close must clear the level by 0.1 ATR (no one-tick breaks)
  minCloseStrength: 0.5,               // close in the top (BUY) / bottom (SELL) half of its range
  retestBars: 6,                       // after WAIT FOR PULLBACK, how long a retest entry stays valid
  retestZoneAtr: 0.5,                  // a retest must come back within 0.5 ATR of the broken level
  extEma9Atr: 1.5,                     // extended: > 1.5 ATR from EMA9
  extTriggerAtr: 1.0,                  //           > 1.0 ATR beyond the broken level
  extVwapAtr: 3.0,                     //           > 3.0 ATR from VWAP
  slBufferAtr: 0.25,                   // volatility buffer beyond the structural invalidation
  maxSlAtr: 2.0,                       // a stop wider than 2 ATR is "too wide"
  obstacleAtr: 1.0,                    // a level within 1 ATR of entry is an OBSTACLE, not a target
  targetAtrMult: 2.5,                  // ATR projection when no structure lies beyond (Test Lab value)
  rrMin: 2.0,                          // unchanged minimum R:R
  levelMergeAtr: 0.15,                 // levels closer than this are one zone
  volLookback: 20, volWeakMult: 0.6, volExpMult: 1.5,
  lateCutoffMin: 14 * 60 + 30,         // no NEW entries after 14:30 IST (Test Lab value)
  sessionExitMin: 15 * 60 + 15,        // flatten at 15:15 IST (trader's day ends 15:15)
};
export type BreakoutConfig = typeof BREAKOUT_CONFIG;

export type Dir = "BUY" | "SELL";
export type EngineState =
  | "BUY BIAS" | "WAIT FOR BREAKOUT" | "BUY CONFIRMED" | "BUY"
  | "SELL BIAS" | "WAIT FOR SUPPORT BREAK" | "SELL CONFIRMED" | "SELL"
  | "WAIT FOR PULLBACK" | "NO EDGE" | "AVOID" | "HOLD";

export interface BiasCheck { name: string; weight: number; pass: boolean; detail: string }
export interface Bias {
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  buyScore: number; sellScore: number;
  checks: BiasCheck[];          // for the chosen side (bullish checks when NEUTRAL)
  states: { ema: string; vwap: string; ut: string; lrc: string; momentum: string; structure: string };
}
export interface Level { price: number; kinds: string[]; label: string; major: boolean; touches: number }
export interface TradePlan {
  dir: Dir;
  entry: number; stopLoss: number; target1: number; target2: number | null;
  risk: number; reward: number; rr: number;
  slReason: string; targetReason: string; target2Reason: string | null;
  trigger: number; triggerLabel: string; triggerType: "RESISTANCE BREAKOUT" | "SUPPORT BREAKDOWN" | "BREAKOUT RETEST" | "BREAKDOWN RETEST";
  obstacles: { price: number; label: string }[];   // minor levels inside 1 ATR that the trade must clear
}
export interface BarEval {
  i: number; time: number; iso: string;
  spot: number; atr: number | null;
  ema9: number | null; ema21: number | null; ema50: number | null; vwap: number | null;
  bias: Bias;
  support: Level | null; resistance: Level | null;
  triggerLevel: number | null; triggerLabel: string | null;
  breakoutStatus: "NONE" | "BROKEN" | "FALSE BREAK" | "RETEST HELD" | "FAILED";
  confirmation: "NONE" | "PASS" | "FAIL";
  confirmationDetail: string | null;
  extension: "NORMAL" | "EXTENDED";
  extensionDetail: string | null;
  fakeMove: boolean;
  volumeState: string;
  state: EngineState;
  command: "BUY" | "SELL" | "WAIT" | "HOLD" | "AVOID";
  plan: TradePlan | null;           // set when a plan was constructed (passed OR failed R:R)
  rrBlockReason: string | null;
  rejectionReason: string | null;
  reason: string;                   // one-line explanation for the UI
  marketPhase: string;
}
export interface Signal {
  barTime: number; iso: string; dir: Dir; plan: TradePlan;
  buyScore: number; sellScore: number; bias: Bias["direction"];
  // replay-only forward walk (never an input)
  outcome?: { result: "T1" | "SL" | "EOD"; exitTime: number; exitPrice: number; fillPrice: number; rMultiple: number; mfeR: number; maeR: number; reachedT2: boolean };
}
export interface SessionResult {
  sessionDate: string | null;
  rows: BarEval[];
  signals: Signal[];
  latest: BarEval | null;
  config: BreakoutConfig;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
export const istMin = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const istIso = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 16).replace("T", " ") + " IST";

// ---------------------------------------------------------------------------
// Indicator series (computed once per candle array; each value is causal)
// ---------------------------------------------------------------------------
export interface Series { ema9: (number | null)[]; ema21: (number | null)[]; ema50: (number | null)[]; vwap: (number | null)[]; atr: (number | null)[]; ut: Array<"BULLISH" | "BEARISH" | "NEUTRAL"> }
export function computeSeries(candles: Candle[], cfg: BreakoutConfig = BREAKOUT_CONFIG): Series {
  const closes = candles.map((c) => c.close);
  return {
    ema9: ema(closes, cfg.emaFast), ema21: ema(closes, cfg.emaSlow), ema50: ema(closes, cfg.emaTrend),
    vwap: vwap(candles), atr: atr(candles, cfg.atrPeriod), ut: utBot(candles, cfg.utKey, cfg.utAtrPeriod),
  };
}

// ---------------------------------------------------------------------------
// BIAS — weighted, with the reason for every check exposed.
// Volume / volatility are NOT directional evidence. Ranging structure earns 0.
// ---------------------------------------------------------------------------
export function computeBias(candles: Candle[], s: Series, i: number, cfg: BreakoutConfig = BREAKOUT_CONFIG): Bias {
  const c = candles[i], price = c.close;
  const e9 = s.ema9[i], e21 = s.ema21[i], e50 = s.ema50[i], vw = s.vwap[i], a = s.atr[i], e9p = i > 0 ? s.ema9[i - 1] : null;
  const reg = linReg(candles.slice(Math.max(0, i - cfg.regLookback + 1), i + 1).map((x) => x.close));
  let structure = "Ranging";
  try { structure = detectMarketStructure(candles.slice(Math.max(0, i - cfg.structureWindow + 1), i + 1), cfg.structureLookback).currentStructure || "Ranging"; } catch { structure = "Ranging"; }
  const spreadAtr = e9 != null && e21 != null && a ? (e9 - e21) / a : 0;

  const side = (bull: boolean): BiasCheck[] => {
    const up = bull ? 1 : -1;
    const emaStack = e9 != null && e21 != null && (bull ? e9 > e21 : e9 < e21) && (e50 == null || (bull ? e21 > e50 : e21 < e50));
    return [
      { name: "EMA", weight: 20, pass: emaStack, detail: e9 != null && e21 != null ? `EMA9 ${r2(e9)} ${e9 > e21 ? ">" : "<"} EMA21 ${r2(e21)}${e50 != null ? ` · EMA21 ${e21 > e50 ? ">" : "<"} EMA50 ${r2(e50)}` : ""}` : "EMA not ready" },
      { name: "Price vs EMA9", weight: 10, pass: e9 != null && (bull ? price > e9 : price < e9), detail: e9 != null ? `${r2(price)} ${price > e9 ? "above" : "below"} EMA9` : "EMA9 not ready" },
      { name: "VWAP", weight: 15, pass: vw != null && (bull ? price > vw : price < vw), detail: vw != null ? `${price > vw ? "above" : "below"} VWAP ${r2(vw)}` : "VWAP unavailable" },
      { name: "UT Bot", weight: 15, pass: s.ut[i] === (bull ? "BULLISH" : "BEARISH"), detail: s.ut[i] },
      { name: "LRC", weight: 10, pass: reg.direction === (bull ? "UP" : "DOWN"), detail: `slope ${reg.direction} (R² ${reg.r2})` },
      { name: "Momentum", weight: 10, pass: spreadAtr * up > 0.2 && e9 != null && e9p != null && (bull ? e9 > e9p : e9 < e9p), detail: `EMA spread ${spreadAtr.toFixed(2)} ATR, EMA9 ${e9 != null && e9p != null ? (e9 > e9p ? "rising" : e9 < e9p ? "falling" : "flat") : "—"}` },
      { name: "Structure", weight: 20, pass: structure === (bull ? "Bullish" : "Bearish"), detail: structure },
    ];
  };
  const bullChecks = side(true), bearChecks = side(false);
  const score = (xs: BiasCheck[]) => xs.reduce((t, x) => t + (x.pass ? x.weight : 0), 0);
  const buyScore = score(bullChecks), sellScore = score(bearChecks);
  const direction = buyScore >= cfg.biasMin && buyScore - sellScore >= cfg.biasEdge ? "BULLISH"
    : sellScore >= cfg.biasMin && sellScore - buyScore >= cfg.biasEdge ? "BEARISH" : "NEUTRAL";
  return {
    direction, buyScore, sellScore,
    checks: direction === "BEARISH" ? bearChecks : bullChecks,
    states: {
      ema: e9 != null && e21 != null ? (e9 > e21 ? "UP" : e9 < e21 ? "DOWN" : "FLAT") : "N/A",
      vwap: vw != null ? (price > vw ? "ABOVE" : price < vw ? "BELOW" : "AT") : "N/A",
      ut: s.ut[i], lrc: reg.direction,
      momentum: spreadAtr > 0.2 ? "BULLISH" : spreadAtr < -0.2 ? "BEARISH" : "NEUTRAL",
      structure,
    },
  };
}

// ---------------------------------------------------------------------------
// LEVELS at bar i (causal). Returns merged zones with kind/touch info.
// ---------------------------------------------------------------------------
// `upto` (default i) is the last CLOSED bar whose information may be used: the
// session is the one bar i belongs to, so the levels standing just BEFORE the
// first bar of a session are prior-day levels only (no opening range/day high).
export function levelsAt(candles: Candle[], i: number, a: number, cfg: BreakoutConfig = BREAKOUT_CONFIG, upto: number = i): Level[] {
  const raw: { price: number; kind: string; major: boolean }[] = [];
  const today = istDate(candles[i].time);
  let dayStart = i;
  while (dayStart > 0 && istDate(candles[dayStart - 1].time) === today) dayStart--;

  // Swing fractals inside the trailing window; the right-hand bars must be <= i.
  const k = cfg.swingStrength;
  const from = Math.max(k, upto - cfg.structureWindow + 1);
  for (let j = from; j <= upto - k; j++) {
    const h = candles[j].high, l = candles[j].low;
    let isH = true, isL = true;
    for (let d = 1; d <= k; d++) {
      if (!(h > candles[j - d].high && h >= candles[j + d].high)) isH = false;
      if (!(l < candles[j - d].low && l <= candles[j + d].low)) isL = false;
    }
    if (isH) raw.push({ price: h, kind: "Swing High", major: false });
    if (isL) raw.push({ price: l, kind: "Swing Low", major: false });
  }

  // Previous session H/L/C + classic floor pivots (from REAL prior-day bars).
  if (dayStart > 0) {
    const prevDay = istDate(candles[dayStart - 1].time);
    let ps = dayStart - 1;
    while (ps > 0 && istDate(candles[ps - 1].time) === prevDay) ps--;
    const pd = candles.slice(ps, dayStart);
    const H = Math.max(...pd.map((c) => c.high)), L = Math.min(...pd.map((c) => c.low)), C = pd[pd.length - 1].close;
    const P = (H + L + C) / 3;
    raw.push({ price: H, kind: "PDH", major: true }, { price: L, kind: "PDL", major: true }, { price: C, kind: "PDC", major: true });
    raw.push({ price: P, kind: "Pivot", major: true }, { price: 2 * P - L, kind: "R1 Pivot", major: true }, { price: 2 * P - H, kind: "S1 Pivot", major: true });
    raw.push({ price: P + (H - L), kind: "R2 Pivot", major: true }, { price: P - (H - L), kind: "S2 Pivot", major: true });
  }

  // Opening range (first 15 minutes) — only once those bars have closed.
  const orBars: Candle[] = [];
  for (let j = dayStart; j <= upto; j++) { if (istMin(candles[j].time) < 9 * 60 + 30) orBars.push(candles[j]); }
  let barMin = Infinity;   // bar length from the data itself (5m / 15m / ...)
  for (let j = Math.max(1, upto - 3); j <= upto; j++) { const d = (candles[j].time - candles[j - 1].time) / 60; if (d > 0 && d < 120) barMin = Math.min(barMin, d); }
  if (!isFinite(barMin)) barMin = 5;
  const orClosed = upto >= dayStart && istMin(candles[upto].time) + barMin >= 9 * 60 + 30 && orBars.length > 0;
  if (orBars.length && orClosed) {
    raw.push({ price: Math.max(...orBars.map((c) => c.high)), kind: "ORH", major: true });
    raw.push({ price: Math.min(...orBars.map((c) => c.low)), kind: "ORL", major: true });
  }
  // Session extremes BEFORE the current bar (a breakout of the day high is a real trigger).
  const dayEnd = Math.min(upto, i - 1);   // never the evaluated candle's own range
  if (dayEnd >= dayStart) {
    const sd = candles.slice(dayStart, dayEnd + 1);
    raw.push({ price: Math.max(...sd.map((c) => c.high)), kind: "Day High", major: true });
    raw.push({ price: Math.min(...sd.map((c) => c.low)), kind: "Day Low", major: true });
  }

  // Merge into zones.
  raw.sort((x, y) => x.price - y.price);
  const tol = (a || candles[upto].close * 0.001) * cfg.levelMergeAtr;
  const zones: Level[] = [];
  let cur: { ps: number[]; kinds: string[]; major: boolean; swings: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const price = cur.ps.reduce((t, p) => t + p, 0) / cur.ps.length;
    const kinds = Array.from(new Set(cur.kinds));
    zones.push({ price: r2(price), kinds, label: kinds.join("/"), major: cur.major || cur.swings >= 2, touches: cur.ps.length });
  };
  for (const r of raw) {
    if (cur && r.price - cur.ps[cur.ps.length - 1] <= tol) { cur.ps.push(r.price); cur.kinds.push(r.kind); cur.major = cur.major || r.major; if (r.kind.startsWith("Swing")) cur.swings++; }
    else { flush(); cur = { ps: [r.price], kinds: [r.kind], major: r.major, swings: r.kind.startsWith("Swing") ? 1 : 0 }; }
  }
  flush();
  return zones;
}

const above = (lv: Level[], p: number) => lv.filter((l) => l.price > p).sort((a, b) => a.price - b.price);
const below = (lv: Level[], p: number) => lv.filter((l) => l.price < p).sort((a, b) => b.price - a.price);

// ---------------------------------------------------------------------------
// Trade construction: structural SL, target beyond the immediate obstacle, R:R.
// Returns the plan (even when it fails) and a precise block reason.
// ---------------------------------------------------------------------------
export function constructPlan(
  dir: Dir, entry: number, trigger: Level, triggerType: TradePlan["triggerType"], candle: Candle, lv: Level[], a: number, cfg: BreakoutConfig = BREAKOUT_CONFIG,
): { plan: TradePlan | null; block: string | null } {
  const buy = dir === "BUY";
  const buf = a * cfg.slBufferAtr;

  // ---- STOP: protected swing beyond entry, else breakout-candle extreme, else too wide.
  const swings = (buy ? below(lv, entry) : above(lv, entry)).filter((l) => l.kinds.some((k) => k.startsWith(buy ? "Swing Low" : "Swing High")));
  let sl: number | null = null, slReason = "";
  const protectedSwing = swings[0];
  if (protectedSwing) {
    const cand = buy ? protectedSwing.price - buf : protectedSwing.price + buf;
    if (Math.abs(entry - cand) <= cfg.maxSlAtr * a) { sl = cand; slReason = `Protected swing ${buy ? "low" : "high"} ${protectedSwing.price} + ${cfg.slBufferAtr} ATR buffer`; }
  }
  if (sl == null) {
    const ext = buy ? candle.low - buf : candle.high + buf;
    const lvlInv = buy ? trigger.price - buf : trigger.price + buf;
    // The breakout is invalidated by a close back through the level; the candle's
    // own extreme is the tighter structural line only if it sits beyond the level.
    const cand = buy ? Math.min(ext, lvlInv) : Math.max(ext, lvlInv);
    const why = protectedSwing ? `swing ${buy ? "low" : "high"} ${protectedSwing.price} is ${(Math.abs(entry - protectedSwing.price) / a).toFixed(1)} ATR away` : `no confirmed swing ${buy ? "low" : "high"}`;
    if (Math.abs(entry - cand) <= cfg.maxSlAtr * a) { sl = cand; slReason = `Back inside broken level ${trigger.price} / breakout candle ${buy ? "low" : "high"} + ${cfg.slBufferAtr} ATR buffer (${why})`; }
    else {
      return { plan: null, block: `Structural SL too wide — nearest invalidation is ${(Math.abs(entry - cand) / a).toFixed(1)} ATR from entry (max ${cfg.maxSlAtr} ATR)` };
    }
  }
  sl = r2(sl);
  const risk = r2(buy ? entry - sl : sl - entry);
  if (!(risk > 0)) return { plan: null, block: "Invalid structure — stop is not beyond entry" };

  // ---- TARGET: levels within 1 ATR are OBSTACLES; a MAJOR obstacle blocks the trade.
  const ahead = (buy ? above(lv, entry) : below(lv, entry)).filter((l) => Math.abs(l.price - trigger.price) > 1e-9);
  const obstacleDist = cfg.obstacleAtr * a;
  const obstacles = ahead.filter((l) => Math.abs(l.price - entry) < obstacleDist);
  const majorObstacle = obstacles.find((l) => l.major);
  const beyond = ahead.filter((l) => Math.abs(l.price - entry) >= obstacleDist);
  let t1: number, targetReason: string;
  if (beyond[0]) { t1 = beyond[0].price; targetReason = `${beyond[0].label} ${beyond[0].price}${beyond[0].major ? " (major)" : ""}`; }
  else { t1 = r2(buy ? entry + cfg.targetAtrMult * a : entry - cfg.targetAtrMult * a); targetReason = `ATR projection ${cfg.targetAtrMult}× (no structure ${buy ? "overhead" : "below"})`; }
  let t2: number | null = null, t2Reason: string | null = null;
  const nxt = beyond.slice(1).find((l) => Math.abs(l.price - t1) >= 0.5 * a);
  if (nxt) { t2 = nxt.price; t2Reason = `${nxt.label} ${nxt.price}${nxt.major ? " (major)" : ""}`; }
  const reward = r2(buy ? t1 - entry : entry - t1);
  const rr = r2(reward / risk);
  const plan: TradePlan = {
    dir, entry: r2(entry), stopLoss: sl, target1: r2(t1), target2: t2 != null ? r2(t2) : null,
    risk, reward, rr, slReason, targetReason, target2Reason: t2Reason,
    trigger: trigger.price, triggerLabel: trigger.label, triggerType,
    obstacles: obstacles.map((o) => ({ price: o.price, label: o.label })),
  };
  if (majorObstacle) {
    return { plan, block: `Immediate ${buy ? "resistance" : "support"} too close — ${majorObstacle.label} ${majorObstacle.price} is only ${r2(Math.abs(majorObstacle.price - entry))} pts (${(Math.abs(majorObstacle.price - entry) / a).toFixed(2)} ATR) away; wait for it to break` };
  }
  if (rr < cfg.rrMin) {
    const entryFromTrigger = Math.abs(entry - trigger.price);
    let why: string;
    // Root cause first: a late entry makes the stop look wide, so check it before SL width.
    if (entryFromTrigger > 0.5 * risk && entryFromTrigger > 0.3 * a) why = `Poor entry location — entry is ${r2(entryFromTrigger)} pts past the trigger ${trigger.price}, eating the R:R`;
    else if (risk > 1.5 * a) why = `Structural SL too wide — risk ${risk} pts (${(risk / a).toFixed(1)} ATR) vs reward ${reward}`;
    else why = `Insufficient target room — next target ${targetReason} gives ${reward} pts for ${risk} pts risk`;
    return { plan, block: `R:R 1:${rr.toFixed(2)} below 1:${cfg.rrMin.toFixed(2)} — ${why}` };
  }
  return { plan, block: null };
}

// ---------------------------------------------------------------------------
// SESSION WALK — state machine over one session's CLOSED bars.
// ---------------------------------------------------------------------------
export interface SessionOpts {
  sessionDate?: string;        // default: IST date of the last closed bar
  nowSec?: number;             // drop a still-forming last bar (live)
  intervalSec: number;
  dataIssue?: string | null;   // live data stale/disconnected → AVOID
  withOutcomes?: boolean;      // replay only: forward-walk outcomes
}

export function runSession(candles: Candle[], opts: SessionOpts, cfg: BreakoutConfig = BREAKOUT_CONFIG): SessionResult {
  let n = candles.length;
  if (opts.nowSec != null && n && candles[n - 1].time + opts.intervalSec > opts.nowSec) n--; // forming bar excluded
  const empty: SessionResult = { sessionDate: null, rows: [], signals: [], latest: null, config: cfg };
  if (n <= 0) return empty;
  const cs = candles.slice(0, n);
  const sessionDate = opts.sessionDate ?? istDate(cs[n - 1].time);
  const s = computeSeries(cs, cfg);
  const rows: BarEval[] = [];
  const signals: Signal[] = [];

  let open: { sig: Signal; fillIdx: number } | null = null;            // HOLD tracking
  let pending: { dir: Dir; level: Level; idx: number } | null = null;   // WAIT FOR PULLBACK memory

  for (let i = 0; i < n; i++) {
    if (istDate(cs[i].time) !== sessionDate) continue;
    const c = cs[i];
    const a = s.atr[i] ?? null;
    const bias = computeBias(cs, s, i, cfg);
    const minute = istMin(c.time);
    const volWin = cs.slice(Math.max(0, i - cfg.volLookback), i).map((x) => x.volume);
    const vState = volumeState(volWin, c.volume, cfg.volExpMult, cfg.volWeakMult);
    const row: BarEval = {
      i, time: c.time, iso: istIso(c.time), spot: c.close, atr: a != null ? r2(a) : null,
      ema9: s.ema9[i] != null ? r2(s.ema9[i]!) : null, ema21: s.ema21[i] != null ? r2(s.ema21[i]!) : null,
      ema50: s.ema50[i] != null ? r2(s.ema50[i]!) : null, vwap: s.vwap[i] != null ? r2(s.vwap[i]!) : null,
      bias, support: null, resistance: null, triggerLevel: null, triggerLabel: null,
      breakoutStatus: "NONE", confirmation: "NONE", confirmationDetail: null,
      extension: "NORMAL", extensionDetail: null, fakeMove: false, volumeState: vState,
      state: "NO EDGE", command: "WAIT", plan: null, rrBlockReason: null, rejectionReason: null, reason: "", marketPhase: "",
    };

    // ---- HOLD: an open trade is managed until SL / T1 / session exit ----
    if (open) {
      const p = open.sig.plan, buy = p.dir === "BUY";
      const hitSL = buy ? c.low <= p.stopLoss : c.high >= p.stopLoss;
      const hitT1 = buy ? c.high >= p.target1 : c.low <= p.target1;
      if (i >= open.fillIdx && (hitSL || hitT1 || minute >= cfg.sessionExitMin)) {
        open = null; // closed on this bar (outcome recorded by the forward walk)
      } else {
        row.state = "HOLD"; row.command = "HOLD"; row.plan = p;
        row.reason = `Holding ${p.dir} from ${p.entry}: SL ${p.stopLoss}, T1 ${p.target1}`;
        row.marketPhase = "IN TRADE";
        rows.push(row); continue;
      }
    }

    if (i < cfg.minHistory || a == null || !(a > 0)) {
      row.state = "AVOID"; row.command = "AVOID"; row.rejectionReason = "Insufficient history for indicators"; row.reason = row.rejectionReason;
      rows.push(row); continue;
    }
    if (opts.dataIssue) {
      row.state = "AVOID"; row.command = "AVOID"; row.rejectionReason = opts.dataIssue; row.reason = opts.dataIssue;
      rows.push(row); continue;
    }

    // Levels as they stood at the PREVIOUS close (the level being broken must
    // pre-exist the breakout candle) and at this close (for SL/targets).
    const lvPrev = levelsAt(cs, i, s.atr[i - 1] ?? a, cfg, i - 1);
    const lvNow = levelsAt(cs, i, a, cfg);
    const resNow = above(lvNow, c.close)[0] ?? null, supNow = below(lvNow, c.close)[0] ?? null;
    row.resistance = resNow; row.support = supNow;
    const prevClose = cs[i - 1].close;
    const buf = cfg.breakBufferAtr * a;
    const range = c.high - c.low;
    const closeStrength = range > 0 ? (c.close - c.low) / range : 0.5;
    const late = minute >= cfg.lateCutoffMin;
    const dirBias = bias.direction === "BULLISH" ? "BUY" : bias.direction === "BEARISH" ? "SELL" : null;
    row.marketPhase = bias.direction === "NEUTRAL" ? "RANGE / NO TREND" : `${bias.direction} TREND`;

    // ---- breakout / breakdown detection on THIS closed candle ----
    type Brk = { dir: Dir; level: Level; kind: "BREAK" | "RETEST" };
    let brk: Brk | null = null;
    let falseBreak: string | null = null;
    // levels that were beyond the previous close and are crossed by this candle
    const crossedUp = above(lvPrev, prevClose).filter((l) => c.high > l.price);
    const crossedDn = below(lvPrev, prevClose).filter((l) => c.low < l.price);
    const upBroken = crossedUp.filter((l) => c.close > l.price + buf);
    const dnBroken = crossedDn.filter((l) => c.close < l.price - buf);
    if (dirBias === "BUY" || dirBias === null) {
      if (upBroken.length) brk = { dir: "BUY", level: upBroken[upBroken.length - 1], kind: "BREAK" };
      else if (crossedUp.length && dirBias === "BUY") falseBreak = `Wick above ${crossedUp[0].label} ${crossedUp[0].price} but closed ${c.close > crossedUp[0].price ? `only ${r2(c.close - crossedUp[0].price)} pts above (needs ${r2(buf)})` : "back below"}`;
    }
    if (!brk && (dirBias === "SELL" || dirBias === null)) {
      if (dnBroken.length) brk = { dir: "SELL", level: dnBroken[dnBroken.length - 1], kind: "BREAK" };
      else if (crossedDn.length && !falseBreak && dirBias === "SELL") falseBreak = `Wick below ${crossedDn[0].label} ${crossedDn[0].price} but closed ${c.close < crossedDn[0].price ? `only ${r2(crossedDn[0].price - c.close)} pts below (needs ${r2(buf)})` : "back above"}`;
    }
    // Retest of a level broken earlier (after WAIT FOR PULLBACK).
    if (!brk && pending && i - pending.idx <= cfg.retestBars) {
      const L = pending.level.price, buy = pending.dir === "BUY";
      const failed = buy ? c.close < L - buf : c.close > L + buf;
      if (failed) { row.breakoutStatus = "FAILED"; row.rejectionReason = `Broken level ${L} lost — breakout failed`; pending = null; }
      else {
        const touched = buy ? c.low <= L + cfg.retestZoneAtr * a : c.high >= L - cfg.retestZoneAtr * a;
        const held = buy ? c.close > L + buf : c.close < L - buf;
        if (touched && held) brk = { dir: pending.dir, level: pending.level, kind: "RETEST" };
      }
    } else if (pending && i - pending.idx > cfg.retestBars) pending = null;

    if (falseBreak && !brk) { row.breakoutStatus = "FALSE BREAK"; row.fakeMove = true; }

    if (brk) {
      const buy = brk.dir === "BUY";
      row.triggerLevel = brk.level.price; row.triggerLabel = brk.level.label;
      row.breakoutStatus = brk.kind === "RETEST" ? "RETEST HELD" : "BROKEN";
      const biasOk = buy ? bias.direction === "BULLISH" : bias.direction === "BEARISH";
      const strongClose = buy ? closeStrength >= cfg.minCloseStrength : closeStrength <= 1 - cfg.minCloseStrength;
      const weakVol = vState === "WEAK";
      const fails: string[] = [];
      if (!biasOk) fails.push(`indicators not ${buy ? "bullish" : "bearish"} (buy ${bias.buyScore} / sell ${bias.sellScore})`);
      if (!strongClose) fails.push(`weak close (${Math.round(closeStrength * 100)}% of range) — rejection wick`);
      if (weakVol) fails.push("weak participation (volume ≤ 0.6× median)");
      if (fails.length) {
        row.confirmation = "FAIL"; row.confirmationDetail = fails.join("; ");
        if (!strongClose) { row.fakeMove = true; row.breakoutStatus = "FALSE BREAK"; }
        row.state = dirBias === "BUY" ? "WAIT FOR BREAKOUT" : dirBias === "SELL" ? "WAIT FOR SUPPORT BREAK" : "NO EDGE";
        row.rejectionReason = `${buy ? "Breakout" : "Breakdown"} of ${brk.level.label} ${brk.level.price} not confirmed: ${row.confirmationDetail}`;
        row.reason = row.rejectionReason;
        rows.push(row); continue;
      }
      row.confirmation = "PASS";
      row.confirmationDetail = `${brk.kind === "RETEST" ? "Retest held" : "Closed"} ${buy ? "above" : "below"} ${brk.level.label} ${brk.level.price} by ${r2(Math.abs(c.close - brk.level.price))} pts, close ${Math.round(closeStrength * 100)}% of range, volume ${vState}`;
      row.state = buy ? "BUY CONFIRMED" : "SELL CONFIRMED";

      // ---- extension: do not chase ----
      const e9 = s.ema9[i]!, vw = s.vwap[i];
      const ext: string[] = [];
      if (Math.abs(c.close - e9) > cfg.extEma9Atr * a) ext.push(`${(Math.abs(c.close - e9) / a).toFixed(1)} ATR from EMA9`);
      if (Math.abs(c.close - brk.level.price) > cfg.extTriggerAtr * a) ext.push(`${(Math.abs(c.close - brk.level.price) / a).toFixed(1)} ATR past the level`);
      if (vw != null && Math.abs(c.close - vw) > cfg.extVwapAtr * a) ext.push(`${(Math.abs(c.close - vw) / a).toFixed(1)} ATR from VWAP`);
      if (ext.length) {
        row.extension = "EXTENDED"; row.extensionDetail = ext.join(", ");
        row.state = "WAIT FOR PULLBACK"; row.rejectionReason = `Entry already extended — ${row.extensionDetail}`;
        row.reason = `${buy ? "BUY" : "SELL"} confirmed but extended (${row.extensionDetail}) — wait for a retest of ${brk.level.price}`;
        pending = { dir: brk.dir, level: brk.level, idx: i };
        rows.push(row); continue;
      }
      if (late) {
        row.state = "AVOID"; row.command = "AVOID"; row.rejectionReason = "Late session — no new entries after 14:30 IST"; row.reason = row.rejectionReason;
        rows.push(row); continue;
      }

      // ---- trade construction ----
      const triggerType: TradePlan["triggerType"] = brk.kind === "RETEST" ? (buy ? "BREAKOUT RETEST" : "BREAKDOWN RETEST") : (buy ? "RESISTANCE BREAKOUT" : "SUPPORT BREAKDOWN");
      const { plan, block } = constructPlan(brk.dir, c.close, brk.level, triggerType, c, lvNow, a, cfg);
      row.plan = plan;
      if (block) {
        row.rrBlockReason = block; row.rejectionReason = block;
        row.reason = `${buy ? "BUY" : "SELL"} CONFIRMED — not executable: ${block}`;
        pending = null;
        rows.push(row); continue;
      }
      row.state = brk.dir; row.command = brk.dir;
      row.reason = `${buy ? "BUY" : "SELL"} — ${plan!.triggerType} ${plan!.trigger} · R:R 1:${plan!.rr.toFixed(2)}`;
      const sig: Signal = { barTime: c.time, iso: row.iso, dir: brk.dir, plan: plan!, buyScore: bias.buyScore, sellScore: bias.sellScore, bias: bias.direction };
      signals.push(sig);
      open = { sig, fillIdx: i + 1 };
      pending = null;
      rows.push(row); continue;
    }

    // ---- no breakout on this bar: describe the waiting state ----
    if (pending) {
      row.state = "WAIT FOR PULLBACK";
      row.triggerLevel = pending.level.price; row.triggerLabel = pending.level.label;
      row.reason = `Waiting for a retest of ${pending.level.label} ${pending.level.price} (within ${cfg.retestZoneAtr} ATR) that holds`;
    } else if (dirBias === "BUY") {
      row.state = resNow ? "WAIT FOR BREAKOUT" : "BUY BIAS";
      row.triggerLevel = resNow?.price ?? null; row.triggerLabel = resNow?.label ?? null;
      row.reason = resNow ? `Bullish bias — waiting for a candle close above ${resNow.label} ${resNow.price} (+${r2(buf)} buffer)` : "Bullish bias — price above all known resistance; no trigger level";
    } else if (dirBias === "SELL") {
      row.state = supNow ? "WAIT FOR SUPPORT BREAK" : "SELL BIAS";
      row.triggerLevel = supNow?.price ?? null; row.triggerLabel = supNow?.label ?? null;
      row.reason = supNow ? `Bearish bias — waiting for a candle close below ${supNow.label} ${supNow.price} (−${r2(buf)} buffer)` : "Bearish bias — price below all known support; no trigger level";
    } else {
      row.state = "NO EDGE";
      row.reason = `No directional edge (buy ${bias.buyScore} / sell ${bias.sellScore}; needs ${cfg.biasMin} and a ${cfg.biasEdge}-point lead)`;
    }
    if (row.breakoutStatus === "FALSE BREAK" && falseBreak) { row.rejectionReason = falseBreak; row.reason += ` · ${falseBreak}`; }
    if (late && row.state !== "NO EDGE") { row.reason += " · after 14:30 no new entries"; }
    rows.push(row);
  }

  if (opts.withOutcomes) for (const sig of signals) sig.outcome = walkOutcome(cs, sig, cfg) ?? undefined;
  return { sessionDate, rows, signals, latest: rows.length ? rows[rows.length - 1] : null, config: cfg };
}

// Forward walk (REPLAY ONLY — never an input). Fill at the next bar's open,
// SL-first on an ambiguous bar, flatten at the session exit time.
export function walkOutcome(cs: Candle[], sig: Signal, cfg: BreakoutConfig = BREAKOUT_CONFIG): Signal["outcome"] | null {
  const idx = cs.findIndex((c) => c.time === sig.barTime);
  if (idx < 0 || idx + 1 >= cs.length) return null;
  const p = sig.plan, buy = p.dir === "BUY";
  const day = istDate(cs[idx].time);
  const fill = cs[idx + 1].open;
  const risk = buy ? fill - p.stopLoss : p.stopLoss - fill;
  if (!(risk > 0)) return { result: "SL", exitTime: cs[idx + 1].time, exitPrice: fill, fillPrice: fill, rMultiple: -1, mfeR: 0, maeR: 1, reachedT2: false };
  let mfe = 0, mae = 0, reachedT2 = false;
  for (let k = idx + 1; k < cs.length; k++) {
    const c = cs[k];
    if (istDate(c.time) !== day || istMin(c.time) >= cfg.sessionExitMin) {
      const px = istDate(c.time) !== day ? cs[k - 1].close : c.open;
      return { result: "EOD", exitTime: c.time, exitPrice: r2(px), fillPrice: r2(fill), rMultiple: r2((buy ? px - fill : fill - px) / risk), mfeR: r2(mfe), maeR: r2(mae), reachedT2 };
    }
    mfe = Math.max(mfe, (buy ? c.high - fill : fill - c.low) / risk);
    mae = Math.max(mae, (buy ? fill - c.low : c.high - fill) / risk);
    if (p.target2 != null && (buy ? c.high >= p.target2 : c.low <= p.target2)) reachedT2 = true;
    const hitSL = buy ? c.low <= p.stopLoss : c.high >= p.stopLoss;
    const hitT1 = buy ? c.high >= p.target1 : c.low <= p.target1;
    if (hitSL) return { result: "SL", exitTime: c.time, exitPrice: p.stopLoss, fillPrice: r2(fill), rMultiple: r2((buy ? p.stopLoss - fill : fill - p.stopLoss) / risk), mfeR: r2(mfe), maeR: r2(mae), reachedT2 };
    if (hitT1) return { result: "T1", exitTime: c.time, exitPrice: p.target1, fillPrice: r2(fill), rMultiple: r2((buy ? p.target1 - fill : fill - p.target1) / risk), mfeR: r2(mfe), maeR: r2(mae), reachedT2 };
  }
  const lastC = cs[cs.length - 1];
  return { result: "EOD", exitTime: lastC.time, exitPrice: lastC.close, fillPrice: r2(fill), rMultiple: r2((buy ? lastC.close - fill : fill - lastC.close) / risk), mfeR: r2(mfe), maeR: r2(mae), reachedT2 };
}
