// ============================ Strategy Replay (analysis / presentation only) ============================
// Runs the EXISTING engines + the Trader Specific Strategies selector + the gated
// Trending path over one session's REAL candles, strictly no-look-ahead, and returns
// the staged events + the validated timing verdict for the UI to draw.
//
// This module places NO trades and changes NO trading behaviour. It only READS the
// existing engines (computeMarketRegime, computeMomentumBurst, classifyMoveStage,
// levelContext, indicators, selectDaily, gatedTrend). The timing classification
// (EARLY / TIMELY / LATE / FALSE / MISSED) is exactly the methodology used in the
// approved 90-session validation harness — not a new one.

import { Candle } from "../types";
import { computeMarketRegime } from "../paper/ext/marketRegime";
import { computeMomentumBurst } from "../scalp/momentum";
import { classifyMoveStage } from "../liquidityStatus/moveStage";
import { levelContext } from "../paper/entryRules";
import { ema, rsi, vwap, atr, last } from "../indicators";
import { selectDaily } from "./selector";
import { neutralEvidence } from "./evidence";
import { gatedTrend } from "./regimeGate";
import { ConditionSnapshot } from "./types";

export type EventKind = "MOVE_START" | "SYSTEM_DETECTED" | "TREND_CONFIRMED" | "GOOD_MOVE" | "TRADE_TRIGGER" | "INVALIDATION" | "WAIT";
export type TimingVerdict = "EARLY" | "TIMELY" | "LATE" | "FALSE" | "MISSED" | "NO_TRADE" | "IN_PROGRESS";

export interface ReplayEvent { kind: EventKind; time: number | null; spot: number | null; label: string; note: string; }
export interface ReplayResult {
  available: boolean; message?: string;
  symbol: string; name: string; date: string;
  candles: Candle[];
  ema9: (number | null)[]; ema21: (number | null)[]; vwap: (number | null)[]; rsi: (number | null)[]; volume: { time: number; value: number }[];
  open: number | null; close: number | null; orHigh: number | null; orLow: number | null; dailyATR: number | null;
  events: ReplayEvent[];
  decision: {
    condition: string; regime: string | null; regimeSource: "existing" | "gated" | null;
    moveDeveloping: boolean; conditionMatchScore: number | null; strategy: string | null;
    masterAction: "TAKE" | "WAIT"; direction: "up" | "down" | null;
    triggerSpot: number | null; invalidationSpot: number | null; expectedMovePts: number | null;
    why: string[]; optionDataAvailable: boolean;
  };
  timing: { verdict: TimingVerdict; moveStartTime: number | null; detectTime: number | null; confirmTime: number | null; triggerTime: number | null; mfePts: number | null; maePts: number | null; note: string };
  sessionComplete: boolean;
}

const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const to15 = (c: Candle[]): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i < c.length; i += 3) { const g = c.slice(i, i + 3); if (!g.length) break; out.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1].close } as Candle); }
  return out;
};
const alignFull = (c: Candle[], s: (number | null | undefined)[]) => c.map((_, i) => (s[i] != null ? +(s[i] as number).toFixed(2) : null));

// Build the per-bar ConditionSnapshot from the existing engines (+ additive gated path).
function snapshotAt(sess: Candle[], i: number, prevDaily: Candle[], dayOpen: number, dATR: number | null, sym: string): ConditionSnapshot & { swingHigh: number | null; swingLow: number | null } {
  const upto = sess.slice(0, i + 1);
  const closes = upto.map((x) => x.close);
  const spot = upto[i].close;
  const burst = computeMomentumBurst(sym, upto);
  const reg = computeMarketRegime(to15(upto), prevDaily, null, burst.state);
  const e9 = last(ema(closes, 9)), e21 = last(ema(closes, 21)), e50 = last(ema(closes, 50)), vw = last(vwap(upto));
  let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  if (e9 != null && e21 != null && e50 != null && vw != null) { if (spot > vw && e9 > e21 && e21 > e50) bias = "Bullish"; else if (spot < vw && e9 < e21 && e21 < e50) bias = "Bearish"; }
  const movePct = dayOpen ? ((spot - dayOpen) / dayOpen) * 100 : 0;
  const atrPct = dATR && spot > 0 ? (dATR / spot) * 100 : 1;
  const rsiS = rsi(closes, 14); const rN = last(rsiS), rP = rsiS[rsiS.length - 11];
  const momDiv = rN != null && rP != null ? (movePct > 0 ? spot > closes[closes.length - 11] && rN < rP - 5 : spot < closes[closes.length - 11] && rN > rP + 5) : false;
  const ext = movePct >= 0 ? Math.max(...upto.map((x) => x.high)) : Math.min(...upto.map((x) => x.low));
  const retr = Math.abs(ext - spot) / (Math.abs(ext - dayOpen) || 1);
  const ms = classifyMoveStage({ movePct, atrPct, rvol: null, oiConfirming: false, premiumConfirming: false, retracedFromExtremePct: Math.min(1, Math.max(0, retr)), momentumDiverging: momDiv });
  const lv = levelContext(upto, prevDaily, null);
  let regime: any = reg.marketRegime, regimeDir: any = reg.regimeDir, regimeSource: "existing" | "gated" | undefined = reg.marketRegime === "Trending" ? "existing" : undefined;
  if (regime !== "Trending") { const g = gatedTrend(upto, dATR, dayOpen); if (g.trend && g.dir) { regime = "Trending"; regimeDir = g.dir; regimeSource = "gated"; } }
  const withinFirst30 = i <= 3;
  return {
    symbol: sym, istDate: istDate(sess[0].time), regime, regimeDir, burstState: burst.state, moveStage: ms.stage,
    directionBias: bias, openingBias: withinFirst30 ? (spot > dayOpen ? "Bullish" : spot < dayOpen ? "Bearish" : "Neutral") : null,
    withinFirst30, sentimentState: "Neutral", wallReactionState: "UNCLEAR", atWall: false, liquidityState: "Normal",
    spot, expectedMovePts: dATR ? Math.round(dATR) : null, wallSupport: null, wallResistance: null, masterVerdict: null,
    dataStale: false, regimeSource, swingHigh: lv.swingHigh, swingLow: lv.swingLow,
  };
}

export function runStrategyReplay(symbol: string, name: string, sess: Candle[], prevDaily: Candle[]): ReplayResult {
  const base: ReplayResult = {
    available: false, symbol, name, date: sess.length ? istDate(sess[0].time) : "",
    candles: [], ema9: [], ema21: [], vwap: [], rsi: [], volume: [], open: null, close: null, orHigh: null, orLow: null, dailyATR: null,
    events: [], decision: { condition: "—", regime: null, regimeSource: null, moveDeveloping: false, conditionMatchScore: null, strategy: null, masterAction: "WAIT", direction: null, triggerSpot: null, invalidationSpot: null, expectedMovePts: null, why: [], optionDataAvailable: false },
    timing: { verdict: "NO_TRADE", moveStartTime: null, detectTime: null, confirmTime: null, triggerTime: null, mfePts: null, maePts: null, note: "" }, sessionComplete: false,
  };
  if (sess.length < 12 || prevDaily.length < 15) { base.message = "Not enough candle history to replay this session."; return base; }

  const dayOpen = sess[0].open;
  const dATR = last(atr(prevDaily, 14));
  const closes = sess.map((x) => x.close);
  const orBars = sess.slice(0, 6);
  const orHigh = Math.max(...orBars.map((b) => b.high)), orLow = Math.min(...orBars.map((b) => b.low));
  const sHi = Math.max(...sess.map((b) => b.high)), sLo = Math.min(...sess.map((b) => b.low));
  const netMove = sess[sess.length - 1].close - dayOpen;
  const dayDir: "up" | "down" = netMove >= 0 ? "up" : "down";
  const actualTrend = dATR ? Math.abs(netMove) >= 1.0 * dATR && ((sess[sess.length - 1].close - sLo) / ((sHi - sLo) || 1) >= 0.7 || (sess[sess.length - 1].close - sLo) / ((sHi - sLo) || 1) <= 0.3) : false;

  // Per-bar snapshots + selector (no-look-ahead).
  const snaps = sess.map((_, i) => (i >= 1 ? snapshotAt(sess, i, prevDaily, dayOpen, dATR, symbol) : null));
  const picks = snaps.map((s) => (s ? selectDaily(s, neutralEvidence) : null));

  // Stage detection from the existing engine outputs.
  let detectIdx = picks.findIndex((p) => p && p.preferred);                          // SYSTEM_DETECTED
  let trendIdx = snaps.findIndex((s) => s && s.regime === "Trending");                // TREND_CONFIRMED
  let goodIdx = snaps.findIndex((s) => s && s.moveStage === "STRONG_MOVE");           // GOOD_MOVE
  // MOVE_START = the opening-range break in the day's net direction (objective initiation).
  let moveIdx = -1;
  for (let i = 6; i < sess.length; i++) { if ((dayDir === "up" && sess[i].close > orHigh) || (dayDir === "down" && sess[i].close < orLow)) { moveIdx = i; break; } }

  const preferred = detectIdx >= 0 ? picks[detectIdx]!.preferred : null;
  const stratId = preferred ? preferred.id : null;
  const stratName = preferred ? preferred.name : null;

  // Trigger detection for the day's preferred strategy (validated generic rules).
  let trigIdx = -1, dir: "up" | "down" | null = null, invalid: number | null = null;
  if (stratId && detectIdx >= 0) {
    if (stratId === "opening_range_breakout") {
      const ob = sess[2] ? (sess[2].close < dayOpen ? "down" : sess[2].close > dayOpen ? "up" : null) : null;
      if (ob) { dir = ob; invalid = ob === "up" ? orLow : orHigh; for (let i = 6; i < sess.length; i++) { const c = sess[i].close; if ((ob === "up" && c > orHigh) || (ob === "down" && c < orLow)) { trigIdx = i; break; } } }
    } else if (stratId === "trend_continuation" || stratId === "pullback_continuation") {
      const s = snaps[detectIdx]!; dir = (s.regimeDir === "down" ? "down" : "up"); const sw = dir === "up" ? s.swingHigh : s.swingLow; invalid = dir === "up" ? (s.swingLow ?? orLow) : (s.swingHigh ?? orHigh);
      if (sw != null) for (let j = detectIdx + 1; j < sess.length; j++) { const b = sess[j]; if ((dir === "up" && b.close > sw) || (dir === "down" && b.close < sw)) { trigIdx = j; break; } }
    } else if (stratId === "squeeze_breakout") {
      for (let i = 6; i < sess.length; i++) { const st = snaps[i]?.burstState; if (st === "Fired Up" || st === "Fired Down") { dir = st === "Fired Up" ? "up" : "down"; const w = sess.slice(Math.max(0, i - 6), i); invalid = dir === "up" ? Math.min(...w.map((b) => b.low)) : Math.max(...w.map((b) => b.high)); trigIdx = i; break; } }
    }
  }

  // Outcome + validated timing verdict (identical methodology to the 90-session harness).
  let mfe: number | null = null, mae: number | null = null, verdict: TimingVerdict = "NO_TRADE", note = "";
  const sessionComplete = true; // replay is over a completed session's candles
  if (!stratId || trigIdx < 0) {
    verdict = actualTrend ? "MISSED" : "NO_TRADE";
    note = actualTrend ? "A real trend move occurred but no strategy triggered." : "No strong edge — WAIT was correct (quiet/range session).";
  } else if (dir && dATR) {
    const px = sess[trigIdx].close, target = dir === "up" ? px + dATR : px - dATR;
    let hit = ""; mfe = 0; mae = 0;
    for (let i = trigIdx + 1; i < sess.length; i++) { const b = sess[i]; const fav = dir === "up" ? b.high - px : px - b.low; const adv = dir === "up" ? px - b.low : b.high - px; mfe = Math.max(mfe, fav); mae = Math.max(mae, adv); const tH = dir === "up" ? b.high >= target : b.low <= target; const iH = invalid != null && (dir === "up" ? b.low <= invalid : b.high >= invalid); if (iH && !hit) { hit = "INVAL"; break; } if (tH && !hit) { hit = "TARGET"; break; } }
    const moveFromOpenAtTrig = dir === "up" ? px - dayOpen : dayOpen - px;
    if (hit === "INVAL") { verdict = "FALSE"; note = "Trigger fired but invalidation was hit before target."; }
    else if (moveFromOpenAtTrig >= dATR) { verdict = "LATE"; note = "Triggered after the move had already travelled ~1× ATR — most of it was gone."; }
    else if (hit === "TARGET" && mae <= 0.4 * dATR) { verdict = "TIMELY"; note = "Triggered near the start of the move with little adverse excursion."; }
    else if (hit === "TARGET") { verdict = "EARLY"; note = "Right direction and reached target, but endured notable heat before running."; }
    else { verdict = "IN_PROGRESS"; note = "Triggered; neither target nor invalidation reached by the close."; }
    mfe = Math.round(mfe); mae = Math.round(mae);
  }

  // Assemble events (real times/spots).
  const ev = (kind: EventKind, idx: number, label: string, note2: string): ReplayEvent => ({ kind, time: idx >= 0 ? sess[idx].time : null, spot: idx >= 0 ? +sess[idx].close.toFixed(2) : null, label, note: note2 });
  const events: ReplayEvent[] = [];
  if (moveIdx >= 0) events.push(ev("MOVE_START", moveIdx, "Market started moving", `Price broke the opening range (${dayDir === "up" ? "upside" : "downside"}).`));
  if (detectIdx >= 0) events.push(ev("SYSTEM_DETECTED", detectIdx, "System detected a setup", `Preferred strategy became eligible: ${stratName}.`));
  if (trendIdx >= 0) events.push(ev("TREND_CONFIRMED", trendIdx, "Trend confirmed", `Regime read Trending${snaps[trendIdx]?.regimeSource === "gated" ? " (gated path)" : ""}.`));
  if (goodIdx >= 0) events.push(ev("GOOD_MOVE", goodIdx, "Good move potential", "Move stage reached STRONG_MOVE."));
  if (trigIdx >= 0) events.push(ev("TRADE_TRIGGER", trigIdx, "Trade trigger", `${stratName} trigger fired (${dir === "up" ? "long/CE bias" : "short/PE bias"}).`));
  if (invalid != null) events.push({ kind: "INVALIDATION", time: null, spot: +invalid.toFixed(2), label: "Invalidation level", note: "Setup is wrong if price closes beyond this." });
  if (!preferred) events.push({ kind: "WAIT", time: null, spot: null, label: "WAIT — no suitable strategy", note: "No strategy cleared the edge gate for this session." });
  events.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));

  const p = preferred;
  return {
    available: true, symbol, name, date: istDate(sess[0].time),
    candles: sess.map((c) => ({ time: c.time, open: +c.open.toFixed(2), high: +c.high.toFixed(2), low: +c.low.toFixed(2), close: +c.close.toFixed(2) } as Candle)),
    ema9: alignFull(sess, ema(closes, 9)), ema21: alignFull(sess, ema(closes, 21)), vwap: alignFull(sess, vwap(sess)), rsi: alignFull(sess, rsi(closes, 14)),
    volume: sess.map((c) => ({ time: c.time, value: (c as any).volume || 0 })),
    open: +dayOpen.toFixed(2), close: +sess[sess.length - 1].close.toFixed(2), orHigh: +orHigh.toFixed(2), orLow: +orLow.toFixed(2), dailyATR: dATR ? Math.round(dATR) : null,
    events,
    decision: {
      condition: picks[detectIdx >= 0 ? detectIdx : (picks.length - 1)]?.condition.label || snaps[snaps.length - 1]?.regime || "—",
      regime: snaps[snaps.length - 1]?.regime || null, regimeSource: (snaps[snaps.length - 1]?.regimeSource as any) || null,
      moveDeveloping: goodIdx >= 0 || trendIdx >= 0, conditionMatchScore: p ? p.score : null, strategy: stratName,
      masterAction: trigIdx >= 0 ? "TAKE" : "WAIT", direction: dir,
      triggerSpot: trigIdx >= 0 ? +sess[trigIdx].close.toFixed(2) : null, invalidationSpot: invalid != null ? +invalid.toFixed(2) : null,
      expectedMovePts: dATR ? Math.round(dATR) : null, why: p ? p.why : [], optionDataAvailable: false,
    },
    timing: { verdict, moveStartTime: moveIdx >= 0 ? sess[moveIdx].time : null, detectTime: detectIdx >= 0 ? sess[detectIdx].time : null, confirmTime: trendIdx >= 0 ? sess[trendIdx].time : null, triggerTime: trigIdx >= 0 ? sess[trigIdx].time : null, mfePts: mfe, maePts: mae, note },
    sessionComplete,
  };
}
