import { Candle } from "../types";
import { atr, last } from "../indicators";
import { computeSignal } from "../signals/engine";

// ---- Today's Big Movers ----
// Ranks stocks by how likely they are to make a LARGE move TODAY, from live
// intraday data: opening gap, relative volume (participation), intraday range
// expansion vs typical daily range, how far it's already moved, and the 15m
// signal direction. This is an intraday scan (what's moving now) - distinct from
// the multi-month Big-Move radar (setups that precede 20-100% runs).

export interface TodayMover {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  gapPct: number; // today's open vs prior close
  changePct: number; // move so far today vs prior close
  todayHigh: number;
  todayLow: number;
  intradayRangePct: number; // (high-low)/prevClose
  atrPct: number | null; // typical daily range % (14d ATR)
  rangeExpansion: number | null; // intradayRange / atrPct (>1 = already big)
  rvolDay: number; // today's volume vs the expected volume by this time of day
  rvolState: "very high" | "high" | "normal" | "low";
  nearHighPct: number; // where price sits in today's range (0 = at low, 100 = at high)
  openHighScore: number; // 0-100: opened HIGH (gap up) + good volume + holding near the high
  direction: "Up" | "Down" | "Mixed";
  signalScore: number;
  signalLabel: string;
  confidence: number;
  moverScore: number; // 0-100 composite: how likely a big mover today
  expectedDayMovePct: number; // estimated magnitude of today's move
  entry: number;
  stop: number;
  target: number;
  hasOptions: boolean | null;
  session: string; // IST date the data belongs to
  note: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMinOf = (t: number) => {
  const d = new Date((t + 19800) * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

const SESSION_START_MIN = 9 * 60 + 15; // 09:15 IST
const SESSION_LEN_MIN = 375; // 6h15m

/**
 * Score a single stock as a potential big mover today.
 * @param intraday recent intraday candles (e.g. 15m) covering today + a few days
 * @param daily    daily candles (for prior close, ATR, average volume)
 */
export function computeTodayMover(symbol: string, name: string, intraday: Candle[], daily: Candle[]): TodayMover | null {
  if (!intraday || intraday.length < 5 || !daily || daily.length < 20) return null;

  // Last traded intraday bar (skip trailing zero-volume/partial bars).
  let lastIdx = intraday.length - 1;
  while (lastIdx > 0 && intraday[lastIdx].close == null) lastIdx--;
  const lastBar = intraday[lastIdx];
  const price = lastBar.close;
  const session = istDateOf(lastBar.time);

  // Today's bars = same IST date as the last bar.
  const todays = intraday.filter((c) => istDateOf(c.time) === session);
  if (!todays.length) return null;
  const todayOpen = todays[0].open;
  const todayHigh = Math.max(...todays.map((c) => c.high));
  const todayLow = Math.min(...todays.map((c) => c.low));
  const todayVol = todays.reduce((s, c) => s + (c.volume || 0), 0);

  // Prior close = last daily close BEFORE today.
  let prevClose = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (istDateOf(daily[i].time) < session) { prevClose = daily[i].close; break; }
  }
  if (!prevClose) prevClose = todayOpen || price;
  if (!prevClose) return null;

  const gapPct = round2(((todayOpen - prevClose) / prevClose) * 100);
  const changePct = round2(((price - prevClose) / prevClose) * 100);
  const intradayRangePct = round2(((todayHigh - todayLow) / prevClose) * 100);

  // Typical daily range from 14-day ATR.
  const atrv = last(atr(daily, 14));
  const atrPct = atrv != null && prevClose ? round2((atrv / prevClose) * 100) : null;
  const rangeExpansion = atrPct && atrPct > 0 ? round2(intradayRangePct / atrPct) : null;

  // Relative volume for the day: today's volume vs the volume we'd EXPECT by this
  // time of day (avg full-day volume scaled by the fraction of the session elapsed).
  const dailyVols = daily.filter((c) => istDateOf(c.time) < session).slice(-20).map((c) => c.volume || 0);
  const avgDailyVol = dailyVols.length ? dailyVols.reduce((a, b) => a + b, 0) / dailyVols.length : 0;
  const elapsedMin = clamp(istMinOf(lastBar.time) - SESSION_START_MIN + 15, 15, SESSION_LEN_MIN); // +15 = include the bar
  const sessionFrac = clamp(elapsedMin / SESSION_LEN_MIN, 0.05, 1);
  const expectedVolByNow = avgDailyVol * sessionFrac;
  const rvolDay = expectedVolByNow > 0 ? round2(todayVol / expectedVolByNow) : 0;
  const rvolState: TodayMover["rvolState"] =
    rvolDay >= 2.5 ? "very high" : rvolDay >= 1.5 ? "high" : rvolDay >= 0.6 ? "normal" : "low";

  // OPENING-HIGH score: rewards a stock that OPENED HIGH (gap up) on GOOD volume
  // and is HOLDING near the day's high (gains not faded). Only positive gaps count
  // - a gap-down doesn't qualify as "opening high". Used for the Top-5 block.
  const rangeToday = Math.max(0.01, todayHigh - todayLow);
  const nearHighPct = round1(clamp(((price - todayLow) / rangeToday) * 100, 0, 100));
  const openHighScore = clamp(Math.round(
    clamp(gapPct * 8, 0, 35) +            // opened above prior close (gap up)
    clamp((rvolDay - 1) * 25, 0, 35) +    // good volume / participation
    clamp((nearHighPct - 50) * 0.4, 0, 20) + // holding in the upper half / near high
    clamp(changePct * 2, 0, 10),          // green on the day so far
  ), 0, 100);

  // Direction from today's change confirmed by the 15m signal.
  const sig = computeSignal(symbol, intraday);
  const up = changePct >= 0.3 && sig.score >= 0;
  const down = changePct <= -0.3 && sig.score <= 0;
  const direction: TodayMover["direction"] = up ? "Up" : down ? "Down" : "Mixed";

  // Composite mover score (0-100).
  const rvolC = clamp((rvolDay - 1) * 25, 0, 30); // participation (biggest fuel)
  const gapC = clamp(Math.abs(gapPct) * 4, 0, 20); // gap kick-starts trends
  const rangeC = rangeExpansion != null ? clamp((rangeExpansion - 0.5) * 20, 0, 20) : 0;
  const changeC = clamp(Math.abs(changePct) * 3, 0, 20); // already moving
  const momC = clamp(sig.confidence * 0.1, 0, 10); // directional conviction
  const moverScore = clamp(Math.round(rvolC + gapC + rangeC + changeC + momC), 0, 100);

  // Estimated magnitude of today's move (what a "big" day looks like here).
  const expectedDayMovePct = round1(Math.max(atrPct || 0, intradayRangePct, Math.abs(changePct)));

  // Simple intraday plan in the prevailing direction.
  const dayAtr = atrv || price * 0.02;
  let entry = round2(price);
  let stop: number;
  let target: number;
  const aheadPct = Math.max(0.5, (expectedDayMovePct - Math.abs(changePct)) * 0.6); // remaining move, damped
  if (direction === "Down") {
    stop = round2(Math.max(todayHigh, price + 0.5 * dayAtr));
    target = round2(price * (1 - aheadPct / 100));
  } else {
    // Up or Mixed default to long bias (breakout continuation).
    stop = round2(Math.min(todayLow, price - 0.5 * dayAtr));
    target = round2(price * (1 + aheadPct / 100));
  }

  const note =
    `${direction === "Mixed" ? "Choppy" : direction + " mover"}: ${changePct >= 0 ? "+" : ""}${changePct}% today` +
    `${gapPct !== 0 ? ` (gap ${gapPct >= 0 ? "+" : ""}${gapPct}%)` : ""}, ` +
    `RVOL ${rvolDay}x (${rvolState})${rangeExpansion != null ? `, range ${rangeExpansion}x typical` : ""}. ` +
    `Signal ${sig.label} (${sig.score}). ${direction === "Down" ? "Bias down" : direction === "Up" ? "Bias up" : "No clear bias"}; ` +
    `est. day move ~${expectedDayMovePct}%. Entry ${entry}, stop ${stop}, target ${target}.`;

  return {
    symbol, name, price: round2(price), prevClose: round2(prevClose),
    gapPct, changePct, todayHigh: round2(todayHigh), todayLow: round2(todayLow),
    intradayRangePct, atrPct, rangeExpansion, rvolDay, rvolState, nearHighPct, openHighScore,
    direction, signalScore: sig.score, signalLabel: sig.label, confidence: sig.confidence,
    moverScore, expectedDayMovePct, entry, stop, target,
    hasOptions: null, session, note,
  };
}
