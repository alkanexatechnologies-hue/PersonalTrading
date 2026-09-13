import { Candle, OiAnalysis } from "../types";
import { adx, last, vwap } from "../indicators";
import { computeDirection4L } from "../signals/direction4L";
import { directionNoMomentum, levelContext, srRoomOk } from "../paper/entryRules";
import { CONFIG } from "../config/arbitration";

/**
 * High-probability option filter (buy + sell).
 *
 * Goal: raise hit-rate by being VERY selective — fewer trades, skip chop,
 * require structure + OI + trend agreement. This does NOT guarantee 80% wins.
 * ~80% is a TARGET via small profit targets + hard skips, not a promise.
 *
 * Buy: trend-day directional CE/PE only.
 * Sell: range-day defined-risk premium (iron condor / wide strangle).
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMinute = (t: number) => {
  const d = new Date((t + 19800) * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

export const HIGH_PROB_CONF = 68;
export const HIGH_PROB_QUALITY = 52;
export const HIGH_PROB_ADX_BUY = 18;
export const HIGH_PROB_ADX_SELL = 22; // above this, do not sell premium
export const HIGH_PROB_POP = 65;

export interface HighProbResult {
  pass: boolean;
  score: number;
  failed: string[];
  notes: string[];
}

export interface HighProbBuyInput {
  direction: "Bullish" | "Bearish";
  confidence: number;
  qualityScore: number;
  marketAlignment: string;
  decayLevel: string;
  dte: number | null;
  thetaPctPerDay: number | null;
  premium: number;
  delta: number | null;
  pcr: number | null;
  oiBias: string | null;
  adx: number | null;
  vwapBias: 1 | -1 | 0;
  orFormed: boolean;
  orBreak: 1 | -1 | 0;
  srRoomOk: boolean | null;
  d4Dir: "Bullish" | "Bearish" | "Neutral" | null;
  relVolume: number | null;
  exhausted: boolean;
}

export function evaluateBuyAlgo(i: HighProbBuyInput): HighProbResult {
  const failed: string[] = [];
  const notes: string[] = [];
  let score = 36;

  if (i.confidence < HIGH_PROB_CONF) failed.push(`conviction ${i.confidence} < ${HIGH_PROB_CONF}`);
  else {
    score += Math.min(16, (i.confidence - HIGH_PROB_CONF) * 0.7);
    notes.push(`conviction ${i.confidence}`);
  }

  if (i.qualityScore < HIGH_PROB_QUALITY) failed.push(`quality ${i.qualityScore} < ${HIGH_PROB_QUALITY}`);
  else score += 8;

  if (i.marketAlignment === "Conflict") failed.push("index headwind");
  else if (i.marketAlignment === "Aligned" || i.marketAlignment === "Market") {
    score += 10;
    notes.push("index aligned");
  }

  if (i.decayLevel === "High" && (i.dte == null || i.dte <= 2)) failed.push("high theta near expiry");
  if (i.thetaPctPerDay != null && i.thetaPctPerDay > 22) failed.push(`theta ${i.thetaPctPerDay}%/day too fast for a buy`);

  if (i.oiBias === "Bearish" && i.direction === "Bullish") failed.push("OI bias against CE");
  if (i.oiBias === "Bullish" && i.direction === "Bearish") failed.push("OI bias against PE");
  if (i.oiBias === (i.direction === "Bullish" ? "Bullish" : "Bearish")) {
    score += 8;
    notes.push("OI agrees");
  }

  if (i.pcr != null) {
    // Trap-fail veto: intentionally MORE extreme than CONFIG.pcr (see arbitration.ts) —
    // only veto when PCR strongly contradicts the idea's direction, not merely unsupportive.
    if (i.direction === "Bullish" && i.pcr <= CONFIG.pcrTrapFail.bullishFailBelow) failed.push(`PCR ${i.pcr} = heavy call writing (CE trap)`);
    if (i.direction === "Bearish" && i.pcr >= CONFIG.pcrTrapFail.bearishFailAbove) failed.push(`PCR ${i.pcr} = heavy put writing (PE trap)`);
    // Score bonus: the canonical supportive threshold (Phase 1.3).
    if (i.direction === "Bullish" && i.pcr >= CONFIG.pcr.bullish) score += 6;
    if (i.direction === "Bearish" && i.pcr <= CONFIG.pcr.bearish) score += 6;
  }

  if (i.adx != null) {
    if (i.adx < HIGH_PROB_ADX_BUY) failed.push(`ADX ${round1(i.adx)} range — bought options bleed`);
    else if (i.adx >= 25) {
      score += 10;
      notes.push(`ADX ${round1(i.adx)} trend`);
    } else score += 4;
  }

  const want = i.direction === "Bullish" ? 1 : -1;
  if (i.vwapBias !== 0) {
    if (i.vwapBias !== want) failed.push("price vs VWAP disagrees");
    else {
      score += 6;
      notes.push("VWAP aligned");
    }
  }

  if (i.orFormed) {
    if (i.orBreak !== want) failed.push("no opening-range break in trade direction");
    else {
      score += 8;
      notes.push("OR breakout");
    }
  }

  if (i.srRoomOk === false) failed.push("no room to major OI S/R wall");
  else if (i.srRoomOk === true) score += 4;

  if (i.d4Dir) {
    if (i.d4Dir === "Neutral") failed.push("4-layer direction Neutral");
    else if (i.d4Dir !== i.direction) failed.push(`4-layer ${i.d4Dir} vs play ${i.direction}`);
    else {
      score += 8;
      notes.push("4-layer agrees");
    }
  }

  if (i.relVolume != null && i.relVolume < 0.85) failed.push(`volume dry (rvol ${i.relVolume})`);
  else if (i.relVolume != null && i.relVolume >= 1.2) score += 5;

  if (i.exhausted) failed.push("day move already exhausted (>65% of daily ATR)");

  if (i.delta != null && i.delta < 0.4) failed.push(`delta ${i.delta} too OTM`);
  else if (i.delta != null && i.delta >= 0.5 && i.delta <= 0.7) score += 4;

  if (i.premium < 1.5) failed.push("premium too thin");

  return { pass: failed.length === 0, score: Math.round(clamp(score, 0, 100)), failed, notes };
}

/** Pull ADX / VWAP / OR / 4L / S-R / exhaustion from live candles. */
export function buyContextFromCandles(
  symbol: string,
  name: string,
  direction: "Bullish" | "Bearish",
  spot: number,
  candles: Candle[] | undefined,
  daily: Candle[] | undefined,
  oi: OiAnalysis | null,
  atrDaily: number | null
): Partial<HighProbBuyInput> {
  const out: Partial<HighProbBuyInput> = {
    adx: null,
    vwapBias: 0,
    orFormed: false,
    orBreak: 0,
    srRoomOk: null,
    d4Dir: null,
    exhausted: false,
  };
  if (!candles || candles.length < 30) return out;

  const adxLast = last(adx(candles, 14).adx);
  out.adx = adxLast != null ? round1(adxLast) : null;

  const vw = last(vwap(candles));
  if (vw != null) out.vwapBias = spot > vw ? 1 : spot < vw ? -1 : 0;

  const todayIso = istDay(candles[candles.length - 1].time);
  const today = candles.filter((c) => istDay(c.time) === todayIso).sort((a, b) => a.time - b.time);
  const orBars = today.filter((c) => istMinute(c.time) >= 9 * 60 + 15 && istMinute(c.time) < 9 * 60 + 45);
  if (orBars.length >= 2) {
    out.orFormed = true;
    const orHigh = Math.max(...orBars.map((c) => c.high));
    const orLow = Math.min(...orBars.map((c) => c.low));
    out.orBreak = spot > orHigh ? 1 : spot < orLow ? -1 : 0;
  }

  if (daily && daily.length >= 2) {
    const lv = levelContext(candles, daily, oi);
    const room = srRoomOk(direction, spot, lv, atrDaily);
    out.srRoomOk = room.ok;
    if (atrDaily && atrDaily > 0 && lv.dayOpen != null) {
      const moveToday = direction === "Bullish" ? spot - lv.dayOpen : lv.dayOpen - spot;
      out.exhausted = moveToday >= 0.65 * atrDaily;
    }
    const d4 = computeDirection4L(symbol, name, candles, daily, oi);
    if (d4) {
      const nm = directionNoMomentum(d4);
      out.d4Dir = nm.direction;
    }
  }
  return out;
}

export function evaluateSellAlgo(
  s: { type: string; pop: number; netCredit: number; maxLoss: number | null },
  ctx: { adx: number | null; atr: number | null }
): HighProbResult {
  const failed: string[] = [];
  const notes: string[] = [];
  let score = 40;

  const trending = ctx.adx != null && ctx.adx >= HIGH_PROB_ADX_SELL;
  const ranging = ctx.adx != null && ctx.adx < 18;

  if (s.pop < HIGH_PROB_POP) failed.push(`POP ${s.pop}% < ${HIGH_PROB_POP}%`);
  else {
    score += Math.min(18, (s.pop - HIGH_PROB_POP) * 0.5);
    notes.push(`POP ${s.pop}%`);
  }

  if (trending && s.type !== "Iron Condor") {
    failed.push(`ADX ${ctx.adx} trending — do not sell naked premium`);
  } else if (trending && s.type === "Iron Condor") {
    notes.push("trend day: condor only (defined risk)");
    score -= 6;
  }

  if (ranging) {
    score += 12;
    notes.push(`ADX ${ctx.adx} range — sell theta`);
  }

  if (s.type === "Iron Condor") {
    score += 14;
    notes.push("defined-risk condor");
  } else if (s.type === "Short Strangle") {
    score += 4;
    notes.push("undefined loss — tail stop required");
  } else {
    score -= 8;
    notes.push("ATM straddle = highest gamma risk");
  }

  if (s.type === "Short Straddle" || s.type === "Short Strangle") {
    if (s.maxLoss == null) notes.push("naked: hard 2x-credit stop is mandatory");
  }

  if (ctx.atr != null && ctx.atr > 0 && s.type === "Short Straddle") {
    const implied = s.netCredit;
    if (implied < ctx.atr * 0.75) failed.push("straddle cheap vs ATR (IV not rich enough to sell)");
    else {
      score += 8;
      notes.push("IV rich vs ATR");
    }
  }

  return { pass: failed.length === 0, score: Math.round(clamp(score, 0, 100)), failed, notes };
}
