import { Candle } from "../types";
import { atr } from "../indicators";
import { computeSignal } from "../signals/engine";

// ---- Single-day REPLAY (manual testing) ----
// For one chosen date: (1) what the system's logic would have DECIDED for a
// symbol in the 9:15-11:00 window (no lookahead) and how it turned out, and
// (2) the day's ACTUAL best movers across the universe (the answer key) - so you
// can see where the logic missed the better trade.

const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istHM = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);

const WIN_START = 9 * 60 + 30; // 09:30
const WIN_END = 15 * 60; // 15:00 (3 PM)
const SIGNAL_MIN = 15;
const TARGET_ATR = 0.5;
const STOP_ATR = 0.4;

export interface SystemCall {
  hasSignal: boolean;
  direction: "Bullish" | "Bearish" | "None";
  entryTime: string | null;
  entry: number | null;
  target: number | null;
  stop: number | null;
  result: "WIN" | "LOSS" | "FLAT" | "NO-TRADE";
  exitTime: string | null;
  capturedPct: number; // move the trade actually captured (signed, %)
  score: number;
  note: string;
}

export interface DayMover {
  symbol: string;
  name: string;
  isIndex: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  bestDir: "Up" | "Down";
  bestMovePct: number; // max favourable intraday excursion from the 9:15 open
  bestMoveTime: string; // IST time the best-move extreme was reached
  closePct: number; // open -> close
}

function dayBars(c15: Candle[], date: string): Candle[] {
  return c15.filter((c) => istDateOf(c.time) === date).sort((a, b) => a.time - b.time);
}
// Bars inside the analysis window (09:30-15:00 IST).
function windowBars(c15: Candle[], date: string): Candle[] {
  return dayBars(c15, date).filter((c) => { const m = istMin(c.time); return m >= WIN_START && m < WIN_END; });
}

// The system's morning decision for a symbol on a date (no lookahead).
export function systemCallForDate(symbol: string, c15: Candle[], daily: Candle[], date: string): SystemCall {
  const none: SystemCall = { hasSignal: false, direction: "None", entryTime: null, entry: null, target: null, stop: null, result: "NO-TRADE", exitTime: null, capturedPct: 0, score: 0, note: "No data for this date." };
  const bars = windowBars(c15, date); // 09:30-15:00 window
  if (!bars.length) return none;

  // Daily ATR from the prior day (no lookahead).
  const atrSeries = atr(daily, 14);
  let dayAtr = 0;
  for (let i = 1; i < daily.length; i++) {
    if (istDateOf(daily[i].time) === date) { dayAtr = atrSeries[i - 1] ?? 0; break; }
  }
  if (dayAtr <= 0) { const a = atrSeries[atrSeries.length - 1]; dayAtr = a ?? 0; }

  // Index of each day-bar within the full series (for no-lookahead slicing).
  const idxOf = new Map<number, number>();
  c15.forEach((c, i) => idxOf.set(c.time, i));

  for (const c of bars) {
    const idx = idxOf.get(c.time)!;
    if (idx < 60) continue;
    const sig = computeSignal(symbol, c15.slice(Math.max(0, idx - 199), idx + 1));
    if (Math.abs(sig.score) < SIGNAL_MIN) continue;
    const bull = sig.score > 0;
    const entry = c.close;
    const target = bull ? entry + TARGET_ATR * dayAtr : entry - TARGET_ATR * dayAtr;
    const stop = bull ? entry - STOP_ATR * dayAtr : entry + STOP_ATR * dayAtr;
    const call: SystemCall = {
      hasSignal: true, direction: bull ? "Bullish" : "Bearish", entryTime: istHM(c.time),
      entry: round2(entry), target: round2(target), stop: round2(stop), result: "FLAT", exitTime: istHM(c.time),
      capturedPct: 0, score: sig.score, note: "",
    };
    for (const fb of bars) {
      if (fb.time <= c.time) continue;
      const targetHit = bull ? fb.high >= target : fb.low <= target;
      const stopHit = bull ? fb.low <= stop : fb.high >= stop;
      if (stopHit && targetHit) { call.result = "LOSS"; call.exitTime = istHM(fb.time); break; }
      if (targetHit) { call.result = "WIN"; call.exitTime = istHM(fb.time); break; }
      if (stopHit) { call.result = "LOSS"; call.exitTime = istHM(fb.time); break; }
    }
    const exitPx = call.result === "WIN" ? target : call.result === "LOSS" ? stop : bars[bars.length - 1].close;
    call.capturedPct = round2(((bull ? exitPx - entry : entry - exitPx) / entry) * 100);
    call.note =
      `System took a ${call.direction} trade at ${call.entryTime} (15m signal score ${sig.score}). ` +
      `Target ${call.target}, stop ${call.stop} -> ${call.result}` + (call.result !== "FLAT" ? ` at ${call.exitTime}` : " (no target/stop hit, closed at day end)") + `.`;
    return call;
  }
  none.result = "NO-TRADE";
  none.note = "System found NO directional signal in the 9:30-15:00 window (score below threshold / neutral).";
  return none;
}

// Actual intraday metrics for a symbol on a date (the "answer key").
export function dayMoveMetrics(symbol: string, name: string, isIndex: boolean, c15: Candle[], date: string): DayMover | null {
  const bars = windowBars(c15, date); // 09:30-15:00 window
  if (!bars.length) return null;
  const open = bars[0].open;
  let high = -Infinity, low = Infinity, highBar = bars[0], lowBar = bars[0];
  for (const b of bars) {
    if (b.high > high) { high = b.high; highBar = b; }
    if (b.low < low) { low = b.low; lowBar = b; }
  }
  const close = bars[bars.length - 1].close;
  const up = ((high - open) / open) * 100;
  const down = ((open - low) / open) * 100;
  const bestDir: "Up" | "Down" = up >= down ? "Up" : "Down";
  return {
    symbol, name, isIndex, open: round2(open), high: round2(high), low: round2(low), close: round2(close),
    bestDir, bestMovePct: round2(Math.max(up, down)),
    bestMoveTime: istHM((bestDir === "Up" ? highBar : lowBar).time),
    closePct: round2(((close - open) / open) * 100),
  };
}
