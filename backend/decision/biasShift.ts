// ============================================================================
// MARKET BIAS SHIFT monitor — tells the trader when the intraday bias is turning.
// Context only: it never creates a trade. Closed 5m candles only, strictly causal
// (the state at bar i uses candles[0..i]).
//
//   BULLISH_CONTEXT  close > VWAP and EMA9 > EMA21
//      │ any of, on a closed bar:
//      │   • failed breakout — within 2 bars of closing above a level (prior day-high
//      │     of the session or a confirmed swing high), a close back BELOW that level
//      │   • close below the low of the most recent breakout candle (within 3 bars)
//      ▼
//   BULLISH_WEAKENING (warning)        → "protect longs, no new CE"
//      │ 2 of 3 on one closed bar (with bullish context within the last 12 bars):
//      │   close < VWAP · EMA9 < EMA21 · fresh bearish BOS (confirmed, ≤3 bars old)
//      ▼
//   SHIFT_BEARISH (confirmed)          → "bias turned bearish — only PE setups"
//      │ a lower low below the lowest low since the shift
//      ▼
//   BEARISH_LEG
//   Invalidation: a close back above the failed level (warning) / back above VWAP
//   with EMA9 > EMA21 (shift) → back to context.  Mirror image for bearish → bullish.
// ============================================================================

import { Candle } from "../types";
import { ema, vwap, atr } from "../indicators";
import { detectMarketStructure } from "../liquidity/orderBlock";

export type BiasState =
  | "NO_DATA" | "MIXED" | "BULLISH_CONTEXT" | "BEARISH_CONTEXT"
  | "BULLISH_WEAKENING" | "BEARISH_WEAKENING"
  | "SHIFT_BEARISH" | "SHIFT_BULLISH" | "BEARISH_LEG" | "BULLISH_LEG";

export interface BiasEvent { time: number; state: BiasState; reason: string; level: number | null }
export interface BiasShift {
  state: BiasState;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";   // the bias the trader should act on
  since: number | null;                            // bar time the current state began
  level: number | null;                            // failed level / shift level
  invalidation: number | null;                     // a CLOSE beyond this cancels the state
  reasons: string[];
  traderMessage: string;
  allow: { CE: boolean; PE: boolean };             // what the state would permit (informational until validated)
  events: BiasEvent[];                             // today's state changes
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const BREAK_WINDOW = 2, BREAK_CANDLE_WINDOW = 3, CONTEXT_LOOKBACK = 12, BOS_FRESH = 3;

interface Brk { dir: 1 | -1; level: number; idx: number; candleLow: number; candleHigh: number }

/** Walk today's closed candles and return the bias-shift state at the LAST candle. */
export function biasShiftAt(closed: Candle[]): BiasShift {
  const n = closed.length;
  const empty = (s: BiasState, why: string): BiasShift => ({ state: s, direction: "NEUTRAL", since: null, level: null, invalidation: null, reasons: [why], traderMessage: why, allow: { CE: true, PE: true }, events: [] });
  if (n < 30) return empty("NO_DATA", "Not enough closed candles");
  const closes = closed.map((c) => c.close);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), vw = vwap(closed), a14 = atr(closed, 14);
  const day = istDate(closed[n - 1].time);
  let start = n - 1;
  while (start > 0 && istDate(closed[start - 1].time) === day) start--;

  const ctx = (i: number): 1 | -1 | 0 => {
    if (vw[i] == null || e9[i] == null || e21[i] == null) return 0;
    if (closed[i].close > vw[i]! && e9[i]! > e21[i]!) return 1;
    if (closed[i].close < vw[i]! && e9[i]! < e21[i]!) return -1;
    return 0;
  };
  // confirmed swing highs/lows (2 bars each side, right side closed)
  const swingHighBefore = (i: number) => { for (let j = i - 2; j >= Math.max(2, i - 60); j--) { const h = closed[j].high; if (h > closed[j - 1].high && h > closed[j - 2].high && h >= closed[j + 1].high && h >= closed[j + 2].high) return h; } return null; };
  const swingLowBefore = (i: number) => { for (let j = i - 2; j >= Math.max(2, i - 60); j--) { const l = closed[j].low; if (l < closed[j - 1].low && l < closed[j - 2].low && l <= closed[j + 1].low && l <= closed[j + 2].low) return l; } return null; };

  let state = "MIXED" as BiasState, since: number | null = null, level: number | null = null, inval: number | null = null;
  let reasons: string[] = [];
  const events: BiasEvent[] = [];
  let lastBrk: Brk | null = null;
  let shiftExtreme: number | null = null;
  const set = (s: BiasState, i: number, why: string[], lv: number | null, inv: number | null) => {
    if (s !== state) events.push({ time: closed[i].time, state: s, reason: why.join("; "), level: lv });
    if (s !== state) since = closed[i].time;
    state = s; reasons = why; level = lv; inval = inv;
  };

  for (let i = Math.max(start, 25); i < n; i++) {
    const c = closed[i], a = a14[i] || 1;
    // day extremes BEFORE this bar
    const sess = closed.slice(start, i);
    const dayHi = sess.length ? Math.max(...sess.map((x) => x.high)) : null;
    const dayLo = sess.length ? Math.min(...sess.map((x) => x.low)) : null;
    const swH = swingHighBefore(i), swL = swingLowBefore(i);
    // fresh confirmed BOS (≤ BOS_FRESH bars old)
    let bos: 1 | -1 | 0 = 0, bosLevel: number | null = null;
    try {
      const win = closed.slice(Math.max(0, i - 119), i + 1);
      const ms = detectMarketStructure(win, 3);
      const conf = ms.bosEvents.filter((b: any) => b.stage === "Confirmed");
      const lb = conf[conf.length - 1];
      if (lb && lb.breakIndex >= win.length - 1 - BOS_FRESH) { bos = lb.direction === "Bullish" ? 1 : -1; bosLevel = lb.level; }
    } catch { /* none */ }
    const cx = ctx(i);
    const wasCtx = (d: 1 | -1) => { for (let k = Math.max(start, i - CONTEXT_LOOKBACK); k < i; k++) if (ctx(k) === d) return true; return false; };

    // record breakouts (close beyond the session extreme / last swing)
    const upLv = [dayHi, swH].filter((x): x is number => x != null && c.close > x && closed[i - 1].close <= x);
    const dnLv = [dayLo, swL].filter((x): x is number => x != null && c.close < x && closed[i - 1].close >= x);
    if (upLv.length) lastBrk = { dir: 1, level: Math.max(...upLv), idx: i, candleLow: c.low, candleHigh: c.high };
    else if (dnLv.length) lastBrk = { dir: -1, level: Math.min(...dnLv), idx: i, candleLow: c.low, candleHigh: c.high };

    // ---- invalidation of an active warning / shift ----
    if ((state === "BULLISH_WEAKENING" && inval != null && c.close > inval) || (state === "BEARISH_WEAKENING" && inval != null && c.close < inval)) {
      set(cx === 1 ? "BULLISH_CONTEXT" : cx === -1 ? "BEARISH_CONTEXT" : "MIXED", i, [`Warning cancelled — closed back ${state === "BULLISH_WEAKENING" ? "above" : "below"} ${r2(inval)}`], null, null);
    }
    if ((state === "SHIFT_BEARISH" || state === "BEARISH_LEG") && cx === 1) set("BULLISH_CONTEXT", i, ["Bearish shift invalidated — back above VWAP with EMA9 > EMA21"], null, null);
    if ((state === "SHIFT_BULLISH" || state === "BULLISH_LEG") && cx === -1) set("BEARISH_CONTEXT", i, ["Bullish shift invalidated — back below VWAP with EMA9 < EMA21"], null, null);

    // ---- confirmed shift: 2 of 3 opposite signals after recent opposite context ----
    const bearVotes = [c.close < (vw[i] ?? Infinity) ? "close below VWAP " + r2(vw[i] ?? 0) : null, e9[i]! < e21[i]! ? "EMA9 < EMA21" : null, bos === -1 ? `bearish BOS ${r2(bosLevel!)}` : null].filter(Boolean) as string[];
    const bullVotes = [c.close > (vw[i] ?? -Infinity) ? "close above VWAP " + r2(vw[i] ?? 0) : null, e9[i]! > e21[i]! ? "EMA9 > EMA21" : null, bos === 1 ? `bullish BOS ${r2(bosLevel!)}` : null].filter(Boolean) as string[];
    const bullishSide = state === "BULLISH_CONTEXT" || state === "BULLISH_WEAKENING" || state === "SHIFT_BULLISH" || state === "BULLISH_LEG";
    const bearishSide = state === "BEARISH_CONTEXT" || state === "BEARISH_WEAKENING" || state === "SHIFT_BEARISH" || state === "BEARISH_LEG";
    if (!bearishSide && bearVotes.length >= 2 && wasCtx(1)) {
      const inv = Math.max(level ?? -Infinity, vw[i] ?? -Infinity);
      set("SHIFT_BEARISH", i, ["Bias turned BEARISH: " + bearVotes.join(" · ")], level ?? bosLevel ?? null, isFinite(inv) ? r2(inv) : null);
      shiftExtreme = c.low; continue;
    }
    if (!bullishSide && bullVotes.length >= 2 && wasCtx(-1)) {
      const inv = Math.min(level ?? Infinity, vw[i] ?? Infinity);
      set("SHIFT_BULLISH", i, ["Bias turned BULLISH: " + bullVotes.join(" · ")], level ?? bosLevel ?? null, isFinite(inv) ? r2(inv) : null);
      shiftExtreme = c.high; continue;
    }
    // ---- warnings: failed breakout / breakdown ----
    if (lastBrk && i > lastBrk.idx && i - lastBrk.idx <= BREAK_CANDLE_WINDOW && state !== "BULLISH_WEAKENING" && state !== "BEARISH_WEAKENING") {
      const b = lastBrk;
      if (b.dir === 1 && ((i - b.idx <= BREAK_WINDOW && c.close < b.level) || c.close < b.candleLow) && (cx === 1 || wasCtx(1))) {
        const why = c.close < b.level ? `Breakout above ${r2(b.level)} at ${hm(closed[b.idx].time)} FAILED — closed back below it` : `Closed below the ${hm(closed[b.idx].time)} breakout candle low ${r2(b.candleLow)}`;
        set("BULLISH_WEAKENING", i, [why], r2(b.level), r2(Math.max(b.level, b.candleHigh))); lastBrk = null; continue;
      }
      if (b.dir === -1 && ((i - b.idx <= BREAK_WINDOW && c.close > b.level) || c.close > b.candleHigh) && (cx === -1 || wasCtx(-1))) {
        const why = c.close > b.level ? `Breakdown below ${r2(b.level)} at ${hm(closed[b.idx].time)} FAILED — closed back above it` : `Closed above the ${hm(closed[b.idx].time)} breakdown candle high ${r2(b.candleHigh)}`;
        set("BEARISH_WEAKENING", i, [why], r2(b.level), r2(Math.min(b.level, b.candleLow))); lastBrk = null; continue;
      }
    }
    // ---- leg after a shift ----
    if (state === "SHIFT_BEARISH" && shiftExtreme != null && c.low < shiftExtreme) { set("BEARISH_LEG", i, [`Lower low ${r2(c.low)} after the bearish shift`], level, inval); }
    if (state === "SHIFT_BULLISH" && shiftExtreme != null && c.high > shiftExtreme) { set("BULLISH_LEG", i, [`Higher high ${r2(c.high)} after the bullish shift`], level, inval); }
    if (state === "SHIFT_BEARISH" || state === "BEARISH_LEG") { shiftExtreme = Math.min(shiftExtreme ?? c.low, c.low); continue; }
    if (state === "SHIFT_BULLISH" || state === "BULLISH_LEG") { shiftExtreme = Math.max(shiftExtreme ?? c.high, c.high); continue; }

    // ---- plain context when nothing special is active ----
    if (state !== "BULLISH_WEAKENING" && state !== "BEARISH_WEAKENING") {
      const s: BiasState = cx === 1 ? "BULLISH_CONTEXT" : cx === -1 ? "BEARISH_CONTEXT" : "MIXED";
      const why = cx === 1 ? [`Above VWAP ${r2(vw[i]!)}, EMA9 > EMA21`] : cx === -1 ? [`Below VWAP ${r2(vw[i]!)}, EMA9 < EMA21`] : ["VWAP and EMA disagree"];
      set(s, i, why, null, null);
    }
    void a;
  }

  const last = closed[n - 1];
  const direction: BiasShift["direction"] =
    state === "BULLISH_CONTEXT" || state === "SHIFT_BULLISH" || state === "BULLISH_LEG" ? "BULLISH"
    : state === "BEARISH_CONTEXT" || state === "SHIFT_BEARISH" || state === "BEARISH_LEG" ? "BEARISH" : "NEUTRAL";
  const allow = {
    CE: !(state === "BULLISH_WEAKENING" || state === "SHIFT_BEARISH" || state === "BEARISH_LEG"),
    PE: !(state === "BEARISH_WEAKENING" || state === "SHIFT_BULLISH" || state === "BULLISH_LEG"),
  };
  const at = since ? hm(since) : hm(last.time);
  const msg: Record<BiasState, string> = {
    NO_DATA: "Not enough data",
    MIXED: "No clear bias — VWAP and EMA disagree",
    BULLISH_CONTEXT: "Bullish bias",
    BEARISH_CONTEXT: "Bearish bias",
    BULLISH_WEAKENING: `⚠ BULLISH WEAKENING since ${at} — ${reasons[0]}. Protect CE positions; no new CE.${inval != null ? ` Cancelled on a close above ${inval}.` : ""}`,
    BEARISH_WEAKENING: `⚠ BEARISH WEAKENING since ${at} — ${reasons[0]}. Protect PE positions; no new PE.${inval != null ? ` Cancelled on a close below ${inval}.` : ""}`,
    SHIFT_BEARISH: `🔻 BIAS SHIFT: BEARISH at ${at} — ${reasons[0].replace("Bias turned BEARISH: ", "")}. Only PE setups.${inval != null ? ` Invalidation: close above ${inval}.` : ""}`,
    SHIFT_BULLISH: `🔺 BIAS SHIFT: BULLISH at ${at} — ${reasons[0].replace("Bias turned BULLISH: ", "")}. Only CE setups.${inval != null ? ` Invalidation: close below ${inval}.` : ""}`,
    BEARISH_LEG: `🔻 BEARISH LEG — ${reasons[0]}. Bias shift held since ${events.filter((e) => e.state === "SHIFT_BEARISH").slice(-1)[0] ? hm(events.filter((e) => e.state === "SHIFT_BEARISH").slice(-1)[0].time) : at}.`,
    BULLISH_LEG: `🔺 BULLISH LEG — ${reasons[0]}. Bias shift held since ${events.filter((e) => e.state === "SHIFT_BULLISH").slice(-1)[0] ? hm(events.filter((e) => e.state === "SHIFT_BULLISH").slice(-1)[0].time) : at}.`,
  };
  return { state, direction, since, level, invalidation: inval, reasons, traderMessage: msg[state], allow, events };
}
