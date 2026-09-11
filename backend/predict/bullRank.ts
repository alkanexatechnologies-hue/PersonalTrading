import { Candle } from "../types";

// ---- Bull % ranking ----
// For each stock, over its historical DAILY candles, what share of days closed
// UP vs the previous close. "Bull %" = up-days / (up+down days) * 100. A high
// value means the stock has a persistent upward bias historically (good CE
// candidate); a low value means a downward bias. Also reports a RECENT (last N
// days) bull %, the window return, average up/down day size, and current streak.
// This is a HISTORICAL TENDENCY, not a prediction - a stock can flip regime.

export interface BullStat {
  symbol: string;
  name: string;
  sector?: string | null;
  price: number;
  total: number;      // up+down days counted
  upDays: number;
  downDays: number;
  bullPct: number;    // up / total * 100
  bearPct: number;
  recentN: number;
  recentBullPct: number | null; // last-N-day bull %
  windowReturnPct: number;      // first->last close return over the window
  avgUpPct: number | null;      // average size of an up day (%)
  avgDownPct: number | null;    // average size of a down day (%)
  streak: number;               // current consecutive up (+) / down (-) days
  bias: "Strong Bull" | "Bullish" | "Neutral" | "Bearish" | "Strong Bear";
  rank?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

export function computeBullStats(symbol: string, name: string, daily: Candle[], recentN = 20): BullStat | null {
  if (!daily || daily.length < 10) return null;
  let up = 0, down = 0;
  const upMoves: number[] = [], downMoves: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].close;
    if (!prev) continue;
    const chPct = ((daily[i].close - prev) / prev) * 100;
    if (daily[i].close > prev) { up++; upMoves.push(chPct); }
    else if (daily[i].close < prev) { down++; downMoves.push(Math.abs(chPct)); }
  }
  const total = up + down;
  if (!total) return null;
  const bullPct = round1((up / total) * 100);

  // recent-N bull %
  const recent = daily.slice(-(recentN + 1));
  let ru = 0, rt = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close === recent[i - 1].close) continue;
    rt++;
    if (recent[i].close > recent[i - 1].close) ru++;
  }
  const recentBullPct = rt ? round1((ru / rt) * 100) : null;

  const windowReturnPct = round1(((daily[daily.length - 1].close - daily[0].close) / daily[0].close) * 100);

  // current streak (consecutive up/down days)
  let streak = 0;
  for (let i = daily.length - 1; i > 0; i--) {
    const u = daily[i].close > daily[i - 1].close;
    const d = daily[i].close < daily[i - 1].close;
    if (!u && !d) break;
    if (i === daily.length - 1) { streak = u ? 1 : -1; }
    else if (u && streak > 0) streak++;
    else if (d && streak < 0) streak--;
    else break;
  }

  const bias: BullStat["bias"] =
    bullPct >= 58 ? "Strong Bull" : bullPct >= 53 ? "Bullish" : bullPct <= 42 ? "Strong Bear" : bullPct <= 47 ? "Bearish" : "Neutral";

  return {
    symbol, name, price: round2(daily[daily.length - 1].close),
    total, upDays: up, downDays: down, bullPct, bearPct: round1(100 - bullPct),
    recentN, recentBullPct, windowReturnPct,
    avgUpPct: upMoves.length ? round2(mean(upMoves)) : null,
    avgDownPct: downMoves.length ? round2(mean(downMoves)) : null,
    streak, bias,
  };
}
