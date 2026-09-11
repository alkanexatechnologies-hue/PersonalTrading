import { Candle } from "../types";
import { computeDirection4L } from "../signals/direction4L";

/**
 * Backtest the 4-Layer Direction Engine, no-lookahead, per hourly slot, and report
 * the directional WIN PROBABILITY per day.
 *
 * IMPORTANT: historical option-chain OI isn't available, so the engine runs with
 * Layer 3 (Derivatives) NEUTRAL - this measures Layers 1+2+4 (Structure + Trend +
 * Momentum, 80% of the weight). It's a directional-accuracy test of the available
 * layers, not a P&L backtest.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istHM = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SLOTS = [9 * 60 + 30, 10 * 60 + 30, 11 * 60 + 30, 12 * 60 + 30, 13 * 60 + 30, 14 * 60 + 30];
const FLAT_PCT = 0.1; // |next-hour move| below this = inconclusive/flat

export interface Dir4LCall {
  date: string; time: string; direction: "Bullish" | "Bearish"; score: number; confidence: number;
  entry: number; nextMovePct: number; mark: "win" | "loss" | "flat";
}
export interface Dir4LDay {
  date: string; weekday: string; calls: number; wins: number; losses: number; flat: number; winProb: number;
}
export interface Dir4LBacktest {
  symbol: string; name: string; days: number; l3Neutral: true;
  totalCalls: number; wins: number; losses: number; flat: number; winProb: number;
  minScore: number;
  byDate: Dir4LDay[];
  calls: Dir4LCall[];
  disclaimer: string;
}

export function backtestDirection4L(symbol: string, name: string, c15: Candle[], daily: Candle[], days = 7, minScore = 15): Dir4LBacktest | null {
  if (!c15 || c15.length < 100 || !daily || daily.length < 5) return null;

  const byDateBars = new Map<string, Candle[]>();
  c15.forEach((c) => { const d = istDateOf(c.time); if (!byDateBars.has(d)) byDateBars.set(d, []); byDateBars.get(d)!.push(c); });
  const idxOf = new Map<number, number>();
  c15.forEach((c, i) => idxOf.set(c.time, i));

  const dates = [...byDateBars.keys()].sort().slice(-days);
  const calls: Dir4LCall[] = [];
  const dayMap = new Map<string, Dir4LDay>();

  for (const date of dates) {
    const weekday = DAY_NAMES[new Date(date + "T00:00:00Z").getUTCDay()];
    dayMap.set(date, { date, weekday, calls: 0, wins: 0, losses: 0, flat: 0, winProb: 0 });
    const bars = byDateBars.get(date)!.slice().sort((a, b) => a.time - b.time);
    for (const slot of SLOTS) {
      const bar = bars.find((b) => istMin(b.time) === slot);
      if (!bar) continue;
      const idx = idxOf.get(bar.time)!;
      if (idx < 60) continue;
      // No lookahead: only candles up to and including this bar. OI = null (Layer 3 neutral).
      const slice = c15.slice(0, idx + 1);
      const d4 = computeDirection4L(symbol, name, slice, daily, null);
      if (!d4 || d4.direction === "Neutral" || Math.abs(d4.score) < minScore) continue;

      // Actual over the next hour (up to 4 bars, capped at 15:00).
      const fwd = bars.filter((b) => b.time > bar.time && istMin(b.time) <= slot + 60 && istMin(b.time) < 15 * 60).slice(0, 4);
      if (!fwd.length) continue;
      const entry = bar.close;
      const after = fwd[fwd.length - 1].close;
      const nextMovePct = round2(((after - entry) / entry) * 100);
      const bull = d4.direction === "Bullish";
      let mark: Dir4LCall["mark"];
      if (Math.abs(nextMovePct) < FLAT_PCT) mark = "flat";
      else if ((bull && nextMovePct > 0) || (!bull && nextMovePct < 0)) mark = "win";
      else mark = "loss";

      calls.push({ date, time: istHM(bar.time), direction: d4.direction, score: d4.score, confidence: d4.confidence, entry: round2(entry), nextMovePct, mark });
      const dd = dayMap.get(date)!;
      dd.calls += 1;
      if (mark === "win") dd.wins += 1; else if (mark === "loss") dd.losses += 1; else dd.flat += 1;
    }
  }

  const byDate = [...dayMap.values()].map((d) => {
    const decided = d.wins + d.losses;
    d.winProb = decided ? round1((d.wins / decided) * 100) : 0;
    return d;
  });
  const wins = byDate.reduce((s, d) => s + d.wins, 0);
  const losses = byDate.reduce((s, d) => s + d.losses, 0);
  const flat = byDate.reduce((s, d) => s + d.flat, 0);
  const decided = wins + losses;

  return {
    symbol, name, days, l3Neutral: true,
    totalCalls: wins + losses + flat, wins, losses, flat,
    winProb: decided ? round1((wins / decided) * 100) : 0,
    minScore,
    byDate,
    calls,
    disclaimer:
      "4-Layer Direction Engine backtest, no lookahead, hourly slots (9:30-14:30), next-hour move as the outcome. " +
      "Historical option OI isn't available so LAYER 3 (Derivatives) is NEUTRAL - this scores Layers 1+2+4 (Structure+Trend+Momentum). " +
      "'Win probability' = directional hit rate (correct calls / decided calls); flat/inconclusive next-hours are excluded from the ratio. Not a P&L backtest.",
  };
}
