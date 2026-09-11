import { Candle } from "../types";
import { last, sma } from "../indicators";

// ---- Opening Range Breakout (ORB) ----
// Classic intraday algo: mark the HIGH/LOW of the opening range (first N minutes
// from 09:15 IST), then trade the break of that range - long (buy CE) above the
// range high, short (buy PE) below the range low. Works best on liquid indices
// (NIFTY / BANKNIFTY). Includes a volume-confirmation check and an R:R plan.

export interface OrbSignal {
  symbol: string;
  name: string;
  price: number;
  session: string; // IST date of the data
  orMinutes: number; // opening-range length used
  rangeHigh: number;
  rangeLow: number;
  rangeWidthPct: number;
  state: "Long" | "Short" | "Inside" | "Forming"; // breakout state
  optionSide: "CE" | "PE" | null; // suggested option to buy on a break
  entry: number | null;
  stop: number | null;
  target1: number | null; // 1x range width
  target2: number | null; // 2x range width
  rr: number | null; // reward:risk to target1
  breakoutPct: number; // how far beyond the range (%)
  volConfirm: boolean | null; // breakout bar volume > recent avg (null if no volume feed)
  confidence: number; // 0-100
  note: string;
  asOf: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

/**
 * @param intraday 15-minute candles covering today + a little history
 * @param orMinutes opening-range length in minutes (default 30 = first two 15m bars)
 */
export function computeORB(symbol: string, name: string, intraday: Candle[], orMinutes = 30): OrbSignal | null {
  if (!intraday || intraday.length < 3) return null;
  let lastIdx = intraday.length - 1;
  while (lastIdx > 0 && intraday[lastIdx].close == null) lastIdx--;
  const lastBar = intraday[lastIdx];
  const price = lastBar.close;
  const session = istDateOf(lastBar.time);

  const todays = intraday.filter((c) => istDateOf(c.time) === session);
  if (todays.length < 1) return null;
  const orBars = Math.max(1, Math.round(orMinutes / 15)); // 15m candles
  const asOf = lastBar.time;

  // Not enough bars to have formed the opening range yet.
  if (todays.length <= orBars) {
    const rHigh = Math.max(...todays.map((c) => c.high));
    const rLow = Math.min(...todays.map((c) => c.low));
    return {
      symbol, name, price: round2(price), session, orMinutes,
      rangeHigh: round2(rHigh), rangeLow: round2(rLow),
      rangeWidthPct: round2(((rHigh - rLow) / price) * 100),
      state: "Forming", optionSide: null, entry: null, stop: null, target1: null, target2: null, rr: null,
      breakoutPct: 0, volConfirm: null, confidence: 0,
      note: `Opening range still forming (${todays.length}/${orBars} bars). Wait for the ${orMinutes}m range to complete.`,
      asOf,
    };
  }

  const orCandles = todays.slice(0, orBars);
  const rangeHigh = Math.max(...orCandles.map((c) => c.high));
  const rangeLow = Math.min(...orCandles.map((c) => c.low));
  const width = rangeHigh - rangeLow;
  const rangeWidthPct = round2((width / price) * 100);

  // Breakout state (small buffer so we don't fire on a touch).
  const buf = width * 0.02;
  let state: OrbSignal["state"];
  let optionSide: OrbSignal["optionSide"] = null;
  if (price > rangeHigh + buf) { state = "Long"; optionSide = "CE"; }
  else if (price < rangeLow - buf) { state = "Short"; optionSide = "PE"; }
  else state = "Inside";

  // Volume confirmation: breakout bar volume vs the avg of the day's bars so far.
  const vols = todays.map((c) => c.volume || 0);
  const hasVol = vols.some((v) => v > 0);
  const avgVol = hasVol ? (last(sma(vols, Math.min(vols.length, 10))) ?? 0) : 0;
  const volConfirm = hasVol ? (lastBar.volume || 0) > avgVol : null;

  let entry: number | null = null;
  let stop: number | null = null;
  let target1: number | null = null;
  let target2: number | null = null;
  let rr: number | null = null;
  let breakoutPct = 0;

  if (state === "Long") {
    entry = round2(price);
    stop = round2(rangeLow); // opposite extreme of the range
    target1 = round2(rangeHigh + width);
    target2 = round2(rangeHigh + 2 * width);
    rr = entry - stop > 0 ? round2((target1 - entry) / (entry - stop)) : null;
    breakoutPct = round2(((price - rangeHigh) / rangeHigh) * 100);
  } else if (state === "Short") {
    entry = round2(price);
    stop = round2(rangeHigh);
    target1 = round2(rangeLow - width);
    target2 = round2(rangeLow - 2 * width);
    rr = stop - entry > 0 ? round2((entry - target1) / (stop - entry)) : null;
    breakoutPct = round2(((rangeLow - price) / rangeLow) * 100);
  }

  // Confidence: breakout strength + volume confirm + a sane (not too wide/narrow) range.
  let conf = 0;
  if (state === "Long" || state === "Short") {
    conf += clamp(breakoutPct * 60, 0, 45); // stronger break = more conviction
    if (volConfirm) conf += 25;
    else if (volConfirm === null) conf += 10; // index (no volume) - neutral credit
    if (rangeWidthPct >= 0.3 && rangeWidthPct <= 2.5) conf += 20; // tradeable range
    if (rr && rr >= 1.5) conf += 10;
  }
  const confidence = clamp(Math.round(conf), 0, 100);

  const note =
    state === "Inside"
      ? `Inside the opening range (${round2(rangeLow)}-${round2(rangeHigh)}, ${rangeWidthPct}% wide). No trade yet - wait for a break above ${round2(rangeHigh)} (buy CE) or below ${round2(rangeLow)} (buy PE).`
      : `${state} breakout (${breakoutPct}% ${state === "Long" ? "above" : "below"} the ${orMinutes}m range). ` +
        `${volConfirm === null ? "No volume feed (index)" : volConfirm ? "Volume confirms" : "Volume NOT confirming - weaker"}. ` +
        `Buy ${optionSide}. Entry ${entry}, stop ${stop} (other end of range), target ${target1} / ${target2}${rr ? `, R:R ~${rr}:1` : ""}.`;

  return {
    symbol, name, price: round2(price), session, orMinutes,
    rangeHigh: round2(rangeHigh), rangeLow: round2(rangeLow), rangeWidthPct,
    state, optionSide, entry, stop, target1, target2, rr, breakoutPct, volConfirm, confidence, note, asOf,
  };
}
