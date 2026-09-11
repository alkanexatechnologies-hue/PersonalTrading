import { Candle, OiAnalysis } from "../types";
import { Direction4LResult } from "../signals/direction4L";
import { ema, vwap, last } from "../indicators";
import { DIRECTION_THRESHOLD } from "../signals/score";

// ---- Paper auto-trade ENTRY RULES (price-structure driven, NO RSI/MACD) ----
// The user's ruleset: decide direction from PDH/PDL, Previous Day Close, Day Open,
// VWAP, Opening Range H/L, major support/resistance (OI walls) and previous swing
// high/low — and explicitly DROP momentum (RSI/MACD). Targets are capped and
// anchored to the major S/R; profit is capped at +15% of premium with a trailing
// stop. This module is used ONLY by the paper engine's idea generators, so the
// rest of the app (Direction engine, Top Picks) keeps its original behaviour.

const PROFIT_CAP_PCT = 0.15; // baseline profit cap at +15% of premium on a "normal" volatility day (per user rule)
const FLOOR_STOP_PCT = 0.12; // baseline max loss on premium on a "normal" volatility day
// A daily ATR at/around this fraction of spot is treated as a "normal" volatility
// day (matches the spot*0.01 fallback already used elsewhere in this codebase,
// e.g. paper/engine.ts's atrForZone, for consistency). Actual ATR above/below
// this scales the profit cap / stop floor / S/R room requirement instead of
// applying the same fixed percentages regardless of how volatile the day is.
const BASELINE_ATR_PCT = 0.01;

/** Ratio of today's actual volatility to the baseline "normal" day, clamped to a
 * sane band so an extreme reading doesn't blow the cap/stop out unreasonably. */
function volMult(spot: number, atrDaily: number | null): number {
  const atrPct = atrDaily && atrDaily > 0 && spot > 0 ? atrDaily / spot : BASELINE_ATR_PCT;
  return Math.max(0.7, Math.min(1.6, atrPct / BASELINE_ATR_PCT));
}

export interface NoMomoDirection {
  direction: "Bullish" | "Bearish" | "Neutral";
  score: number;       // -100..+100 (structure+trend+derivatives only)
  confidence: number;  // 0..100
  reasons: string[];
}

// Re-derive the 4-Layer direction WITHOUT the momentum layer (no RSI/MACD/BB/vol).
// Weights structure 40 + trend 25 + derivatives 20 = 85 → renormalised to 100.
export function directionNoMomentum(d4: Direction4LResult): NoMomoDirection {
  const layers = d4.layers.filter((L) => L.key !== "momentum");
  const raw = layers.reduce((s, L) => s + L.contribution, 0); // contribution = layerScore(-1..1) * weight
  const score = Math.max(-100, Math.min(100, Math.round(raw * (100 / 85))));
  const direction = score >= DIRECTION_THRESHOLD ? "Bullish" : score <= -DIRECTION_THRESHOLD ? "Bearish" : "Neutral";
  const netSign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const agree = netSign === 0 ? 0 : layers.filter((L) => Math.sign(L.contribution) === netSign).length;
  const confidence = Math.max(5, Math.min(97, Math.round(Math.abs(score) * 0.7 + agree * 9)));
  const reasons = layers
    .filter((L) => Math.sign(L.contribution) === netSign && netSign !== 0)
    .map((L) => `${L.name} ${L.contribution > 0 ? "+" : ""}${L.contribution}`);
  return { direction, score, confidence, reasons };
}

// Previous-day + day-open + VWAP structure confirmation (the levels the user listed
// that the 4L engine did not use explicitly). Returns a small bias nudge and notes.
export interface LevelContext {
  pdh: number | null; pdl: number | null; pdc: number | null; dayOpen: number | null;
  vwap: number | null; orHigh: number | null; orLow: number | null;
  majorSupport: number | null; majorResistance: number | null;
  swingHigh: number | null; swingLow: number | null;
  bias: 1 | -1 | 0; notes: string[];
}

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMinute = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// Major support/resistance = the heaviest OI walls (max PE OI = support, max CE OI
// = resistance); falls back to PDH/PDL when OI is unavailable.
export function majorLevels(oi: OiAnalysis | null, pdh: number | null, pdl: number | null): { support: number | null; resistance: number | null } {
  const rows: any[] = (oi && (oi as any).topStrikes) || [];
  if (rows.length) {
    let res = rows[0], sup = rows[0];
    for (const r of rows) {
      if ((r.ceOi || 0) > (res.ceOi || 0)) res = r;
      if ((r.peOi || 0) > (sup.peOi || 0)) sup = r;
    }
    return { support: sup?.strike ?? pdl, resistance: res?.strike ?? pdh };
  }
  return { support: pdl, resistance: pdh };
}

// Recent swing high/low via a 2-bar fractal over the last ~40 bars.
function lastSwing(bars: Candle[]): { high: number | null; low: number | null } {
  const win = bars.slice(-40);
  let hi: number | null = null, lo: number | null = null;
  for (let i = 2; i < win.length - 2; i++) {
    const h = win[i].high, l = win[i].low;
    if (h >= win[i - 1].high && h >= win[i - 2].high && h >= win[i + 1].high && h >= win[i + 2].high) hi = h;
    if (l <= win[i - 1].low && l <= win[i - 2].low && l <= win[i + 1].low && l <= win[i + 2].low) lo = l;
  }
  return { high: hi, low: lo };
}

export function levelContext(candles: Candle[], daily: Candle[], oi: OiAnalysis | null): LevelContext {
  const price = candles.length ? candles[candles.length - 1].close : 0;
  const todayIso = candles.length ? istDay(candles[candles.length - 1].time) : "";
  // previous day OHLC
  let pd: Candle | null = null;
  for (let i = daily.length - 1; i >= 0; i--) { if (istDay(daily[i].time) < todayIso) { pd = daily[i]; break; } }
  const pdh = pd ? pd.high : null, pdl = pd ? pd.low : null, pdc = pd ? pd.close : null;
  // today's bars → day open + opening range (9:15-9:45)
  const today = candles.filter((c) => istDay(c.time) === todayIso).sort((a, b) => a.time - b.time);
  const dayOpen = today.length ? today[0].open : null;
  const orBars = today.filter((c) => istMinute(c.time) >= 9 * 60 + 15 && istMinute(c.time) < 9 * 60 + 45);
  const orHigh = orBars.length ? Math.max(...orBars.map((c) => c.high)) : null;
  const orLow = orBars.length ? Math.min(...orBars.map((c) => c.low)) : null;
  const vw = last(vwap(candles));
  const { support: majorSupport, resistance: majorResistance } = majorLevels(oi, pdh, pdl);
  const sw = lastSwing(candles);

  // Bias nudge from the extra levels the 4L engine ignores: Day Open and PDC.
  let up = 0, down = 0; const notes: string[] = [];
  if (dayOpen != null) { if (price > dayOpen) { up++; notes.push(`Day Open ${Math.round(dayOpen)} के ऊपर`); } else if (price < dayOpen) { down++; notes.push(`Day Open ${Math.round(dayOpen)} के नीचे`); } }
  if (pdc != null) { if (price > pdc) { up++; notes.push(`Prev Close ${Math.round(pdc)} के ऊपर`); } else if (price < pdc) { down++; notes.push(`Prev Close ${Math.round(pdc)} के नीचे`); } }
  if (vw != null) { if (price > vw) { up++; notes.push(`VWAP ${Math.round(vw)} के ऊपर`); } else if (price < vw) { down++; notes.push(`VWAP ${Math.round(vw)} के नीचे`); } }
  const bias: 1 | -1 | 0 = up > down ? 1 : down > up ? -1 : 0;

  return { pdh, pdl, pdc, dayOpen, vwap: vw, orHigh, orLow, majorSupport, majorResistance, swingHigh: sw.high, swingLow: sw.low, bias, notes };
}

// S/R ROOM GATE: don't buy into the opposing major wall. For a CE (bullish) there
// must be meaningful room UP to major resistance; for a PE (bearish) room DOWN to
// major support. `minRoom` scales with the daily ATR. Thresholds raised from an
// earlier 0.15%/0.15xATR (loose enough to barely block an entry sitting right at
// the wall) to 0.3%/0.35xATR - meaningfully protective without being so wide it
// blocks legitimate room-to-run setups.
export function srRoomOk(direction: "Bullish" | "Bearish", spot: number, lv: LevelContext, atrDaily: number | null): { ok: boolean; reason: string } {
  const minRoom = Math.max(spot * 0.003, 0.35 * (atrDaily || spot * 0.01));
  if (direction === "Bullish") {
    if (lv.majorResistance != null && lv.majorResistance - spot < minRoom) {
      return { ok: false, reason: `major resistance ${Math.round(lv.majorResistance)} बिल्कुल पास (room ${Math.round(lv.majorResistance - spot)}) — CE के लिए जगह नहीं` };
    }
  } else {
    if (lv.majorSupport != null && spot - lv.majorSupport < minRoom) {
      return { ok: false, reason: `major support ${Math.round(lv.majorSupport)} बिल्कुल पास (room ${Math.round(spot - lv.majorSupport)}) — PE के लिए जगह नहीं` };
    }
  }
  return { ok: true, reason: "" };
}

// Anchor the SPOT target to the major S/R (don't project beyond the wall) and cap
// the PREMIUM target around +15% of entry premium. Also tighten the premium stop
// so a capped target still keeps a healthy (~1.3) reward:risk. `atrDaily` scales
// the profit cap / stop floor with actual volatility instead of applying the same
// fixed +15%/-12% regardless of whether today is quiet or violent: a quiet day
// (low ATR) caps profit tighter and a volatile day allows more room, both bounded
// so neither drifts to an unreasonable extreme. Returns adjusted values.
export function capTargetAndStop(idea: {
  direction: "Bullish" | "Bearish"; spot: number; spotTarget: number; spotStop: number;
  premium: number; premiumTarget: number; premiumStop: number;
}, lv: LevelContext, atrDaily: number | null = null): { spotTarget: number; premiumTarget: number; premiumStop: number; expectedMovePct: number; note: string } {
  const notes: string[] = [];
  let spotTarget = idea.spotTarget;
  // Stick to major S/R: cap the projected spot target at the wall.
  if (idea.direction === "Bullish" && lv.majorResistance != null && spotTarget > lv.majorResistance) { spotTarget = lv.majorResistance; notes.push(`target major resistance ${Math.round(lv.majorResistance)} पर सीमित`); }
  if (idea.direction === "Bearish" && lv.majorSupport != null && spotTarget < lv.majorSupport) { spotTarget = lv.majorSupport; notes.push(`target major support ${Math.round(lv.majorSupport)} पर सीमित`); }

  const vm = volMult(idea.spot, atrDaily);
  const profitCapPct = PROFIT_CAP_PCT * vm;
  const floorStopPct = FLOOR_STOP_PCT * vm;

  // Cap premium profit at ~+15% of entry, scaled by today's volatility.
  const cap = idea.premium * (1 + profitCapPct);
  let premiumTarget = Math.min(idea.premiumTarget, cap);
  if (premiumTarget < idea.premium) premiumTarget = cap; // guard bad inputs
  if (premiumTarget >= cap - 1e-6) notes.push(`profit +${Math.round(profitCapPct * 1000) / 10}% (₹${Math.round(cap * 100) / 100}) पर capped`);

  // Tighten stop so the (volatility-scaled) target keeps ~1.3 reward:risk; never
  // looser than the original stop, and never worse than the volatility-scaled
  // premium floor.
  const rewardAbs = premiumTarget - idea.premium;
  const stopForRR = idea.premium - rewardAbs / 1.3;                 // gives ~1.3 gross RR
  const floorStop = idea.premium * (1 - floorStopPct);               // max loss on premium, volatility-scaled
  let premiumStop = Math.max(idea.premiumStop, stopForRR, floorStop); // higher = tighter
  if (premiumStop >= idea.premium) premiumStop = idea.premium * 0.9;  // safety

  const expectedMovePct = idea.premium > 0 ? Math.round(((premiumTarget - idea.premium) / idea.premium) * 1000) / 10 : 0;
  return {
    spotTarget: Math.round(spotTarget * 100) / 100,
    premiumTarget: Math.round(premiumTarget * 100) / 100,
    premiumStop: Math.round(premiumStop * 100) / 100,
    expectedMovePct,
    note: notes.join(" · "),
  };
}

export { PROFIT_CAP_PCT };
