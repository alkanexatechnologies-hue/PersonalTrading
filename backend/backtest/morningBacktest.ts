import { Candle } from "../types";
import { atr } from "../indicators";
import { computeSignal } from "../signals/engine";
import { istDateOfSec, istMinuteOfDay, istTimeOfSec } from "../util/istTime";

// ---- Morning-window directional backtest (9:15-11:00 IST) ----
// Replays the SIGNAL logic bar-by-bar over the last N days with NO lookahead:
// for each day, the first 15m bar in the 9:15-11:00 window with a directional
// signal becomes a trade (enter at that close, ATR-based target/stop), then we
// walk forward through the rest of THAT day to see if target or stop hits first.
//
// This measures the DIRECTIONAL edge of the model (the basis for option / intraday
// trades). Option premium P&L cannot be backtested (no historical option chain),
// so we report the underlying's win rate + reward-multiple, which is the honest
// core of whether the calls are right.

export interface MorningTrade {
  date: string;
  entryTime: string;
  direction: "Bullish" | "Bearish";
  entry: number;
  target: number;
  stop: number;
  exit: number;
  exitTime: string;
  result: "WIN" | "LOSS" | "FLAT";
  rMultiple: number;
  score: number;
  movePct: number;
}
export interface MorningBacktestResult {
  symbol: string;
  name: string;
  isIndex: boolean;
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number; // decided
  avgR: number;
  totalR: number;
  tradesList: MorningTrade[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = istDateOfSec;
const istMin = istMinuteOfDay;
const istHM = istTimeOfSec;

const WIN_START = 9 * 60 + 15; // 09:15
const WIN_END = 11 * 60; // 11:00
const SIGNAL_MIN = 15; // |score| >= 15 to be directional
const TARGET_ATR = 0.5; // target = 0.5 * daily ATR
const STOP_ATR = 0.4; // stop = 0.4 * daily ATR

export function backtestMorning(
  symbol: string,
  name: string,
  isIndex: boolean,
  candles15m: Candle[],
  daily: Candle[],
  days = 30,
): MorningBacktestResult | null {
  if (!candles15m || candles15m.length < 100 || !daily || daily.length < 20) return null;

  // Daily ATR by date (use the PRIOR day's ATR to size a day's trade - no lookahead).
  const atrSeries = atr(daily, 14);
  const atrByDate = new Map<string, number>();
  for (let i = 1; i < daily.length; i++) {
    const d = istDateOf(daily[i].time);
    const a = atrSeries[i - 1];
    if (a != null) atrByDate.set(d, a);
  }

  // Group 15m bars by IST date, in order.
  const byDate = new Map<string, { idx: number; c: Candle }[]>();
  candles15m.forEach((c, idx) => {
    const d = istDateOf(c.time);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push({ idx, c });
  });

  const allDates = [...byDate.keys()].sort();
  const testDates = allDates.slice(-days);
  const trades: MorningTrade[] = [];

  for (const date of testDates) {
    const dayBars = byDate.get(date)!;
    const dayAtr = atrByDate.get(date);
    if (dayAtr == null || dayAtr <= 0) continue;

    // First directional signal in the 9:15-11:00 window (no lookahead).
    let entry: MorningTrade | null = null;
    for (const { idx, c } of dayBars) {
      const m = istMin(c.time);
      if (m < WIN_START || m >= WIN_END) continue;
      if (idx < 60) continue; // need warmup history
      const slice = candles15m.slice(Math.max(0, idx - 199), idx + 1); // recent history only (fast)
      const sig = computeSignal(symbol, slice);
      if (Math.abs(sig.score) < SIGNAL_MIN) continue;
      const bull = sig.score > 0;
      const e = c.close;
      const target = bull ? e + TARGET_ATR * dayAtr : e - TARGET_ATR * dayAtr;
      const stop = bull ? e - STOP_ATR * dayAtr : e + STOP_ATR * dayAtr;
      entry = {
        date, entryTime: istHM(c.time), direction: bull ? "Bullish" : "Bearish",
        entry: round2(e), target: round2(target), stop: round2(stop),
        exit: round2(e), exitTime: istHM(c.time), result: "FLAT", rMultiple: 0, score: sig.score, movePct: 0,
      };
      // Walk forward through the rest of the day for target/stop.
      const startIdx = idx + 1;
      for (const fb of dayBars) {
        if (fb.idx < startIdx) continue;
        const bar = fb.c;
        const targetHit = bull ? bar.high >= target : bar.low <= target;
        const stopHit = bull ? bar.low <= stop : bar.high >= stop;
        if (stopHit && targetHit) { entry.result = "LOSS"; entry.exit = round2(stop); entry.exitTime = istHM(bar.time); break; }
        if (targetHit) { entry.result = "WIN"; entry.exit = round2(target); entry.exitTime = istHM(bar.time); break; }
        if (stopHit) { entry.result = "LOSS"; entry.exit = round2(stop); entry.exitTime = istHM(bar.time); break; }
      }
      if (entry.result === "FLAT") {
        const lastBar = dayBars[dayBars.length - 1].c;
        entry.exit = round2(lastBar.close);
        entry.exitTime = istHM(lastBar.time);
      }
      const rr = TARGET_ATR / STOP_ATR;
      entry.rMultiple = entry.result === "WIN" ? round2(rr) : entry.result === "LOSS" ? -1 : round2(((bull ? entry.exit - entry.entry : entry.entry - entry.exit) / (STOP_ATR * dayAtr)));
      entry.movePct = round2(((entry.exit - entry.entry) / entry.entry) * 100);
      break; // one trade per day
    }
    if (entry) trades.push(entry);
  }

  const wins = trades.filter((t) => t.result === "WIN").length;
  const losses = trades.filter((t) => t.result === "LOSS").length;
  const flats = trades.filter((t) => t.result === "FLAT").length;
  const decided = wins + losses;
  const totalR = round2(trades.reduce((s, t) => s + t.rMultiple, 0));
  return {
    symbol, name, isIndex, trades: trades.length, wins, losses, flats,
    winRate: decided ? Math.round((wins / decided) * 1000) / 10 : 0,
    avgR: trades.length ? round2(totalR / trades.length) : 0,
    totalR, tradesList: trades,
  };
}
