import { Candle, OiAnalysis } from "../types";
import { SymbolDef } from "../config";
import { atr, ema, last, vwap } from "../indicators";

/**
 * OPHL Option Buying System (Opening / Previous High-Low breakout).
 *
 * Produces a 0-100 confidence for an index option BUY, blending a MARKET score
 * (underlying structure + OI, 40%) with an OPTION score (the option's OWN
 * breakout behaviour, 60%). The defining idea is DUAL confirmation: the index
 * must break PDH/PDL AND the ATM option premium must break its own session high.
 *
 * Feasibility note: the option's true VWAP/volume aren't available from the
 * Groww chain, so the option side uses a SELF-TRACKED intraday premium series
 * (opening/high/low/average from live LTP samples) + OI. Weights were adjusted
 * from the original design so no points depend on data we can't compute.
 */

// ---- ATM premium session tracker (in-memory, resets per day) ----
interface PremSample { open: number; high: number; low: number; sum: number; count: number; last: number; lastEpoch: number; upStreak: number; day: string; }
const _premTrack = new Map<string, PremSample>();
const premKey = (symbol: string, type: "CE" | "PE", strike: number, day: string) => `${symbol}:${type}:${strike}:${day}`;

/** Record a live premium sample for an ATM option (called on each scan + by the sampler). */
export function recordPremium(symbol: string, type: "CE" | "PE", strike: number, premium: number, epoch: number, day: string): void {
  if (!(premium > 0)) return;
  const k = premKey(symbol, type, strike, day);
  const cur = _premTrack.get(k);
  if (!cur || cur.day !== day) {
    _premTrack.set(k, { open: premium, high: premium, low: premium, sum: premium, count: 1, last: premium, lastEpoch: epoch, upStreak: 0, day });
    return;
  }
  cur.high = Math.max(cur.high, premium);
  cur.low = Math.min(cur.low, premium);
  cur.sum += premium;
  cur.count += 1;
  cur.upStreak = premium > cur.last ? cur.upStreak + 1 : 0;
  cur.last = premium;
  cur.lastEpoch = epoch;
}

interface PremStats { open: number; high: number; low: number; avg: number; last: number; count: number; upStreak: number; }
function premStats(symbol: string, type: "CE" | "PE", strike: number, day: string): PremStats | null {
  const s = _premTrack.get(premKey(symbol, type, strike, day));
  if (!s) return null;
  return { open: s.open, high: s.high, low: s.low, avg: s.sum / s.count, last: s.last, count: s.count, upStreak: s.upStreak };
}

// ---- scoring weights (each sub-score normalises to 0-100) ----
// MARKET (underlying + OI) - all computable.
const MW = { openVsLevel: 22, breakLevel: 22, newHighLow: 14, priceVsVwap: 16, emaCross: 10, oiStructure: 16 }; // sum 100
// OPTION (self-tracked premium + OI) - option VWAP/volume dropped, points redistributed.
const OW = { optBreakout: 38, optAboveAvg: 20, oiConfirm: 22, optMomentum: 20 }; // sum 100

export interface OphlComponent { label: string; got: number; max: number; ok: boolean; note: string; }
export interface OphlResult {
  symbol: string;
  name: string;
  direction: "Bullish" | "Bearish" | "Neutral";
  optionType: "CE" | "PE" | null;
  strike: number | null;
  premium: number | null;
  // levels
  pdh: number | null; pdl: number | null; pdc: number | null; open: number | null; spot: number | null;
  vwap: number | null; buffer: number | null; gapPct: number | null;
  // scores (0-100)
  marketScore: number;
  optionScore: number;
  finalScore: number;
  band: "NO TRADE" | "WATCH" | "WEAK TRADE" | "GOOD TRADE" | "STRONG TRADE";
  marketComponents: OphlComponent[];
  optionComponents: OphlComponent[];
  // entry gate
  entryOk: boolean;
  entryChecklist: { label: string; ok: boolean }[];
  // risk plan (25% premium risk; T1/T2/T3 = 1R/2R/3R)
  stop: number | null; t1: number | null; t2: number | null; t3: number | null;
  premiumSamples: number;
  notes: string[];
}

const band = (s: number): OphlResult["band"] =>
  s >= 85 ? "STRONG TRADE" : s >= 75 ? "GOOD TRADE" : s >= 65 ? "WEAK TRADE" : s >= 50 ? "WATCH" : "NO TRADE";

function prevDay(daily: Candle[], todayIso: string): Candle | null {
  if (!daily || !daily.length) return null;
  const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  // last bar that is NOT today
  for (let i = daily.length - 1; i >= 0; i--) if (istDay(daily[i].time) !== todayIso) return daily[i];
  return daily[daily.length - 1];
}

export interface OphlContext { gapPct: number | null; oiShiftDir: number; pcrChange: number | null; todayIso: string; nowEpoch: number; }

export function computeOphl(def: SymbolDef, candles: Candle[], daily: Candle[], oi: OiAnalysis, ctx: OphlContext): OphlResult | null {
  if (!candles || candles.length < 20 || !daily || daily.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const spot = closes[closes.length - 1];
  const pd = prevDay(daily, ctx.todayIso);
  if (!pd) return null;
  const pdh = pd.high, pdl = pd.low, pdc = pd.close;
  const atrDaily = last(atr(daily, 14)) ?? spot * 0.01;
  const vwapNow = last(vwap(candles));
  const ema9 = last(ema(closes, 9));
  const ema21 = last(ema(closes, 21));

  // today's session bars
  const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const todayBars = candles.filter((c) => istDay(c.time) === ctx.todayIso).sort((a, b) => a.time - b.time);
  const open = todayBars.length ? todayBars[0].open : spot;
  const dayHigh = todayBars.length ? Math.max(...todayBars.map((c) => c.high)) : spot;
  const dayLow = todayBars.length ? Math.min(...todayBars.map((c) => c.low)) : spot;
  const buffer = Math.max(spot * 0.0005, 0.10 * atrDaily);

  // ---- direction from open vs PDH/PDL (fallback to live breakout) ----
  let dir: 1 | -1 | 0 = 0;
  if (open > pdh) dir = 1;
  else if (open < pdl) dir = -1;
  else if (spot > pdh + buffer) dir = 1;
  else if (spot < pdl - buffer) dir = -1;
  const direction: OphlResult["direction"] = dir === 1 ? "Bullish" : dir === -1 ? "Bearish" : "Neutral";

  // ---- ATM option for the direction ----
  const atmRow = (oi.topStrikes || []).reduce((b: any, r: any) => {
    if (r == null) return b;
    return b == null || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b;
  }, null as any);
  const optionType: "CE" | "PE" | null = dir === 1 ? "CE" : dir === -1 ? "PE" : null;
  const strike = atmRow ? atmRow.strike : null;
  const premium = atmRow ? (optionType === "CE" ? atmRow.ceLtp : optionType === "PE" ? atmRow.peLtp : null) : null;

  // record the premium sample + read stats
  let stats: PremStats | null = null;
  if (optionType && strike != null && premium != null && premium > 0) {
    recordPremium(def.symbol, optionType, strike, premium, ctx.nowEpoch, ctx.todayIso);
    stats = premStats(def.symbol, optionType, strike, ctx.todayIso);
  }

  const mc: OphlComponent[] = [];
  const oc: OphlComponent[] = [];
  const push = (arr: OphlComponent[], label: string, got: number, max: number, note: string) =>
    arr.push({ label, got: Math.round(got), max, ok: got >= max * 0.6, note });

  // ================= MARKET SCORE =================
  if (dir === 0) {
    // Range / no-trade: open inside PDH-PDL and no breakout yet.
    push(mc, "Open vs PDH/PDL", 0, MW.openVsLevel, `Open ${round2(open)} is INSIDE ${round2(pdl)}-${round2(pdh)} - range / wait for breakout.`);
    push(mc, "Break of level", 0, MW.breakLevel, "No PDH/PDL breakout yet.");
    push(mc, "New high/low", 0, MW.newHighLow, "-");
    push(mc, "Price vs VWAP", 0, MW.priceVsVwap, "-");
    push(mc, "EMA 9 vs 21", 0, MW.emaCross, "-");
    push(mc, "OI structure", 0, MW.oiStructure, "-");
  } else {
    const bull = dir === 1;
    // open vs level
    const openBeyond = bull ? open > pdh : open < pdl;
    push(mc, "Open vs PDH/PDL", openBeyond ? MW.openVsLevel : MW.openVsLevel * 0.5, MW.openVsLevel,
      openBeyond ? `Open ${round2(open)} ${bull ? "above PDH" : "below PDL"} - strong ${bull ? "bullish" : "bearish"} open.`
        : `Open inside range but price broke ${bull ? "PDH" : "PDL"} - breakout entry.`);
    // break of level (price beyond level + buffer)
    const broke = bull ? spot > pdh + buffer : spot < pdl - buffer;
    const near = bull ? spot > pdh : spot < pdl;
    push(mc, "Break of level", broke ? MW.breakLevel : near ? MW.breakLevel * 0.5 : 0, MW.breakLevel,
      broke ? `Price ${round2(spot)} cleared ${bull ? "PDH" : "PDL"} by > buffer (${round2(buffer)}).` : near ? "At the level - needs to clear the buffer." : "Below the breakout level.");
    // new day high/low beyond level
    const newHL = bull ? dayHigh >= pdh : dayLow <= pdl;
    push(mc, "New high/low", newHL ? MW.newHighLow : 0, MW.newHighLow, newHL ? `Day ${bull ? "high" : "low"} ${round2(bull ? dayHigh : dayLow)} ${bull ? "above PDH" : "below PDL"}.` : "-");
    // price vs vwap
    const vOk = vwapNow == null ? null : bull ? spot > vwapNow : spot < vwapNow;
    push(mc, "Price vs VWAP", vOk == null ? MW.priceVsVwap * 0.5 : vOk ? MW.priceVsVwap : 0, MW.priceVsVwap,
      vwapNow == null ? "VWAP unavailable." : `Price ${vOk ? (bull ? "above" : "below") : "on wrong side of"} VWAP ${round2(vwapNow)}.`);
    // ema cross
    const eOk = ema9 != null && ema21 != null ? (bull ? ema9 > ema21 : ema9 < ema21) : null;
    push(mc, "EMA 9 vs 21", eOk == null ? MW.emaCross * 0.5 : eOk ? MW.emaCross : 0, MW.emaCross, eOk == null ? "-" : `EMA9 ${eOk ? (bull ? "above" : "below") : "against"} EMA21.`);
    // OI structure: overnight shift dir + PCR change agree
    let oiPts = 0; const oiNotes: string[] = [];
    if (ctx.oiShiftDir === dir) { oiPts += MW.oiStructure * 0.6; oiNotes.push("overnight OI shift agrees"); }
    else if (ctx.oiShiftDir === -dir) { oiNotes.push("overnight OI shift conflicts"); }
    if (ctx.pcrChange != null) {
      if ((bull && ctx.pcrChange > 0) || (!bull && ctx.pcrChange < 0)) { oiPts += MW.oiStructure * 0.4; oiNotes.push(`PCR moving ${bull ? "up (PE writing)" : "down (CE writing)"}`); }
    }
    push(mc, "OI structure", Math.min(MW.oiStructure, oiPts), MW.oiStructure, oiNotes.length ? oiNotes.join("; ") + "." : "OI neutral / no prior snapshot.");
  }
  const marketRaw = mc.reduce((s, c) => s + c.got, 0); // out of 100 (weights sum 100)
  const marketScore = Math.max(0, Math.min(100, Math.round(marketRaw)));

  // ================= OPTION SCORE =================
  const samples = stats?.count ?? 0;
  if (!optionType || premium == null || premium <= 0) {
    push(oc, "Option breakout", 0, OW.optBreakout, "No directional option (range).");
    push(oc, "Above session avg", 0, OW.optAboveAvg, "-");
    push(oc, "OI confirmation", 0, OW.oiConfirm, "-");
    push(oc, "Option momentum", 0, OW.optMomentum, "-");
  } else {
    // option breakout: premium > its session high (needs samples). With <3 samples, give partial from OI.
    if (stats && samples >= 3) {
      const broke = premium >= stats.high - 1e-9;
      push(oc, "Option breakout", broke ? OW.optBreakout : (premium > stats.open ? OW.optBreakout * 0.5 : 0), OW.optBreakout,
        broke ? `Premium ${round2(premium)} at session high (${round2(stats.high)}) - breaking out.` : premium > stats.open ? `Above open (${round2(stats.open)}) but below session high.` : `Below open - no option breakout.`);
      const aboveAvg = premium > stats.avg;
      push(oc, "Above session avg", aboveAvg ? OW.optAboveAvg : 0, OW.optAboveAvg, `Premium ${aboveAvg ? "above" : "below"} session avg ${round2(stats.avg)}.`);
      push(oc, "Option momentum", Math.min(OW.optMomentum, stats.upStreak * (OW.optMomentum / 3)), OW.optMomentum, `Rising for ${stats.upStreak} sample(s).`);
    } else {
      push(oc, "Option breakout", OW.optBreakout * 0.4, OW.optBreakout, `Building option data (${samples} sample${samples === 1 ? "" : "s"}) - breakout confirmed once the session has a few reads.`);
      push(oc, "Above session avg", OW.optAboveAvg * 0.4, OW.optAboveAvg, "Building option data.");
      push(oc, "Option momentum", OW.optMomentum * 0.4, OW.optMomentum, "Building option data.");
    }
    // OI confirmation: long buildup on our side (aggregate shift agrees with direction)
    const oiAgree = ctx.oiShiftDir === dir;
    push(oc, "OI confirmation", oiAgree ? OW.oiConfirm : (ctx.oiShiftDir === 0 ? OW.oiConfirm * 0.4 : 0), OW.oiConfirm,
      oiAgree ? "OI shift supports the option side (writing against, unwinding for)." : ctx.oiShiftDir === 0 ? "OI shift neutral." : "OI shift against - caution.");
  }
  const optionRaw = oc.reduce((s, c) => s + c.got, 0);
  const optionScore = Math.max(0, Math.min(100, Math.round(optionRaw)));

  // ================= FINAL =================
  const finalScore = dir === 0 ? Math.round(marketScore * 0.4) : Math.round(marketScore * 0.4 + optionScore * 0.6);

  // entry checklist
  const idxBreak = mc.find((c) => c.label === "Break of level")?.ok ?? false;
  const optBreak = oc.find((c) => c.label === "Option breakout")?.ok ?? false;
  const oiConf = oc.find((c) => c.label === "OI confirmation")?.ok ?? false;
  const vwapAlign = mc.find((c) => c.label === "Price vs VWAP")?.ok ?? false;
  const entryChecklist = [
    { label: "Final score >= 75", ok: finalScore >= 75 },
    { label: "Index breakout confirmed", ok: idxBreak },
    { label: "Option breakout confirmed", ok: optBreak },
    { label: "OI confirmation", ok: oiConf },
    { label: "Price aligned with VWAP", ok: vwapAlign },
  ];
  const entryOk = dir !== 0 && finalScore >= 75 && idxBreak && optBreak && vwapAlign;

  // risk plan: 25% premium risk, T1/T2/T3 = 1R/2R/3R
  let stop: number | null = null, t1: number | null = null, t2: number | null = null, t3: number | null = null;
  if (premium != null && premium > 0) {
    const r = premium * 0.25;
    stop = round2(premium - r);
    t1 = round2(premium + r);
    t2 = round2(premium + 2 * r);
    t3 = round2(premium + 3 * r);
  }

  const notes: string[] = [];
  if (dir === 0) notes.push(`Range: open inside PDH-PDL. Monitor for a break above ${round2(pdh)} (CE) or below ${round2(pdl)} (PE).`);
  if (samples > 0 && samples < 3) notes.push("Option-breakout confidence grows as the session records more premium samples.");
  notes.push("Best in the 9:25-10:30 window. Avoid gap-and-reverse: prefer a hold above the level, not a first-tick poke.");

  return {
    symbol: def.symbol, name: def.name, direction, optionType, strike, premium: premium != null ? round2(premium) : null,
    pdh: round2(pdh), pdl: round2(pdl), pdc: round2(pdc), open: round2(open), spot: round2(spot),
    vwap: vwapNow != null ? round2(vwapNow) : null, buffer: round2(buffer), gapPct: ctx.gapPct,
    marketScore, optionScore, finalScore, band: band(finalScore),
    marketComponents: mc, optionComponents: oc,
    entryOk, entryChecklist, stop, t1, t2, t3, premiumSamples: samples, notes,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
