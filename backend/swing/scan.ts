import { Candle, SwingPick } from "../types";
import { ema, rsi, last, atr } from "../indicators";
import { atrStopTarget } from "../indicators/riskLevels";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Short-term swing scan on DAILY candles.
 * Finds stocks starting a multi-day move (breakout + volume + fresh momentum)
 * and - crucially - flags whether you're EARLY or the move is already EXTENDED,
 * so you enter near the start rather than chasing.
 */
export function computeSwing(symbol: string, name: string, daily: Candle[]): SwingPick | null {
  const n = daily.length;
  if (n < 30) return null;
  const closes = daily.map((c) => c.close);
  const vols = daily.map((c) => c.volume);
  const price = closes[n - 1];

  const back = (k: number) => (n - 1 - k >= 0 ? closes[n - 1 - k] : closes[0]);
  const weekChangePct = round2(((price - back(5)) / back(5)) * 100);
  const monthChangePct = round2(((price - back(20)) / back(20)) * 100);

  // Volume surge vs prior 20-day average.
  const priorVols = vols.slice(Math.max(0, n - 21), n - 1);
  const avgVol = priorVols.length ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : 0;
  const volSurge = avgVol > 0 ? round2(vols[n - 1] / avgVol) : 0;

  const rsiVal = last(rsi(closes, 14));
  const ema20 = last(ema(closes, 20));
  const aboveEma20Pct = ema20 ? round2(((price - ema20) / ema20) * 100) : 0;

  // Prior 20-day high (excluding today) => breakout when today closes above it.
  const priorHighs = daily.slice(Math.max(0, n - 21), n - 1).map((c) => c.high);
  const prevHigh = priorHighs.length ? Math.max(...priorHighs) : price;
  const breakout = price > prevHigh;

  // Stage classification.
  const extended = (rsiVal != null && rsiVal > 72) || aboveEma20Pct > 15 || weekChangePct > 30;
  let stage: SwingPick["stage"] = "Neutral";
  if (extended) stage = "Extended";
  else if (breakout && volSurge >= 1.5 && rsiVal != null && rsiVal >= 55 && rsiVal <= 70 && weekChangePct >= 1 && weekChangePct <= 20)
    stage = "Early breakout";
  else if (volSurge >= 1.3 && rsiVal != null && rsiVal >= 50 && rsiVal <= 65 && aboveEma20Pct >= -3 && aboveEma20Pct <= 8)
    stage = "Building base";

  // Early-entry score (higher = better early opportunity).
  let score = 0;
  if (breakout) score += 28;
  score += Math.min(25, Math.max(0, (volSurge - 1) * 22)); // volume interest
  if (rsiVal != null) {
    if (rsiVal >= 55 && rsiVal <= 68) score += 20; // momentum turning up, not overbought
    else if (rsiVal > 68 && rsiVal <= 72) score += 8;
  }
  if (weekChangePct >= 1 && weekChangePct <= 15) score += 15; // move just starting
  else if (weekChangePct > 15 && weekChangePct <= 25) score += 6;
  if (aboveEma20Pct >= -2 && aboveEma20Pct <= 8) score += 12; // near the launch zone
  if (extended) score -= 35; // penalise chasing an extended move
  const earlyScore = Math.max(0, Math.min(100, Math.round(score)));

  // ---- Trade plan: entry trigger, swing stop, projected target, expected move ----
  const atrVal = last(atr(daily, 14));
  const atrPct = atrVal != null && price ? round2((atrVal / price) * 100) : null;
  // Entry = the breakout level (buy on a close above / retest of the prior high).
  // If it hasn't broken out yet (base), same level is the trigger to watch.
  const entry = round2(prevHigh);
  // Swing stop = the most recent 10-day low (structure), fenced by ~1.5 ATR so it
  // isn't unreasonably far on very volatile names.
  const recentLows = daily.slice(Math.max(0, n - 10)).map((c) => c.low);
  const swingLow = recentLows.length ? Math.min(...recentLows) : price;
  const atrLevels = atrVal != null ? atrStopTarget(entry, atrVal, 1) : null;
  const atrFloor = atrLevels != null ? atrLevels.stop : swingLow;
  const stop = round2(Math.max(swingLow, atrFloor));
  // Projected swing target: a typical multi-day breakout runs ~2.5 ATR from the
  // trigger. Honest, volatility-based - not a promise.
  const target = atrLevels != null ? round2(atrLevels.target) : round2(entry * 1.08);
  const expectedMovePct = round2(((target - entry) / entry) * 100);
  const riskReward = entry - stop > 0 ? round2((target - entry) / (entry - stop)) : null;

  const note =
    stage === "Early breakout"
      ? `Fresh breakout above ${round2(prevHigh)} on ${volSurge}x volume - early stage, momentum turning up.`
      : stage === "Building base"
      ? `Coiling with rising volume (${volSurge}x) - accumulation; watch for a breakout over ${round2(prevHigh)}.`
      : stage === "Extended"
      ? `Already moved (${weekChangePct >= 0 ? "+" : ""}${weekChangePct}% / week, RSI ${rsiVal != null ? Math.round(rsiVal) : "-"}). Chasing is risky - wait for a pullback.`
      : "No clear early setup.";

  return {
    symbol,
    name,
    price: round2(price),
    weekChangePct,
    monthChangePct,
    volSurge,
    rsi: rsiVal != null ? round2(rsiVal) : null,
    aboveEma20Pct,
    breakout,
    stage,
    earlyScore,
    entry,
    stop,
    target,
    expectedMovePct,
    atrPct,
    riskReward,
    hasOptions: null, // filled in by the endpoint when Groww is connected
    opportunityScore: earlyScore, // updated with fundamentals in the endpoint
    note,
  };
}
