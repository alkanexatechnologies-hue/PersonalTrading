// Strike selection + Gamma read for the Trade Decision layer (research).
// Inputs are REAL historical option bars (Dhan rolling options: premium, IV, OI,
// volume). Delta / gamma are MODEL-DERIVED (Black-Scholes on the feed's IV, via
// the shared analysis/greeks helpers) and labelled so. No probabilities: the
// strike score is a fixed-weight rank, the gamma read is an evidence count.

import { bsDelta, bsGamma, repriceOption, yearsToExpiry } from "../analysis/greeks";
import { contractKey, OptBar, OptionSeries } from "./optionsData";
import { DecisionConfig, EvidenceStatus, GammaRead, MovementState, OptionPlan, StrikeCandidate } from "./types";

// Fixed rank weights (sum 100). Not optimized.
const W = { response: 25, capacity: 20, volume: 15, oi: 10, ivLow: 10, delta: 10, gamma: 10 };

function greeks(bar: OptBar, spot: number, timeSec: number): { delta: number | null; gamma: number | null } {
  const tYears = yearsToExpiry(bar.expiry, timeSec * 1000);
  if (bar.iv == null || tYears == null || !(spot > 0)) return { delta: null, gamma: null };
  const i = { spot, strike: bar.strike, tYears, iv: bar.iv / 100 };
  return { delta: bsDelta(i, bar.side), gamma: bsGamma(i) };
}

const norm = (xs: number[]) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1));
};
const r2 = (x: number | null) => (x == null ? null : +x.toFixed(2));

export function selectStrike(a: {
  series: OptionSeries | null; side: "CE" | "PE"; time: number; prevTime: number | null;
  spot: number | null; rewardPts: number; riskPts: number; dc: DecisionConfig; strikeStep: number;
}): OptionPlan {
  const base: OptionPlan = {
    status: "DATA UNAVAILABLE", reason: "", optionType: a.side, spotAtDecision: a.spot,
    expiry: null, expirySource: a.series?.expirySource ?? "none",
    primary: null, alternative: null, selectionReason: "", optionEntry: null, optionStop: null, optionTarget: null,
    spread: "DATA UNAVAILABLE", candidates: [],
  };
  const slice = a.series?.byTime.get(a.time)?.[a.side];
  if (!a.series || a.series.status === "UNAVAILABLE") return { ...base, reason: `option history unavailable (${a.series?.note ?? "not fetched"})` };
  if (!slice || !slice.length) return { ...base, reason: "no option bar for this candle" };
  const spot = a.spot ?? slice.find((b) => b.spot != null)?.spot ?? null;
  if (spot == null) return { ...base, reason: "spot unavailable for this candle" };
  const sign = a.side === "CE" ? 1 : -1;

  const cands: StrikeCandidate[] = slice.map((b) => {
    const { delta, gamma } = greeks(b, spot, a.time);
    const prev = a.prevTime != null ? a.series!.byContract.get(contractKey(b.expiry, a.side, b.strike))?.get(a.prevTime) : undefined;
    const atT1 = repriceOption({ ltp: b.close, delta, gamma, dSpot: sign * a.rewardPts });
    const atSL = repriceOption({ ltp: b.close, delta, gamma, dSpot: -sign * a.riskPts });
    const response = atT1 != null ? atT1 - b.close : null;
    let why: string | null = null;
    if (b.close < a.dc.minPremium) why = `premium ${b.close} < ${a.dc.minPremium}`;
    else if (!(b.volume != null && b.volume > 0)) why = "no traded volume in bar";
    else if (delta == null) why = "IV unavailable (greeks not computable)";
    else if (Math.abs(delta) < a.dc.deltaMin || Math.abs(delta) > a.dc.deltaMax) why = `|delta| ${Math.abs(delta).toFixed(2)} outside ${a.dc.deltaMin}-${a.dc.deltaMax}`;
    else if (!(response != null && response > 0)) why = "no positive premium response to T1";
    return {
      strike: b.strike, optionType: a.side, offset: b.offset, ltp: b.close, iv: b.iv, oi: b.oi,
      oiChange: prev && prev.oi != null && b.oi != null ? b.oi - prev.oi : null, volume: b.volume,
      delta: delta != null ? +delta.toFixed(3) : null, gamma: gamma != null ? +gamma.toFixed(5) : null,
      premiumAtT1: r2(atT1), premiumAtSL: r2(atSL), premiumResponse: r2(response),
      capacityPct: response != null ? +((response / b.close) * 100).toFixed(1) : null,
      score: 0, eligible: why == null, ineligibleReason: why,
    };
  });
  const el = cands.filter((c) => c.eligible);
  if (!el.length) {
    return { ...base, status: "AVAILABLE", expiry: slice[0].expiry, candidates: cands, reason: "no strike passed liquidity / delta / premium checks", selectionReason: "NO LIQUID STRIKE" };
  }
  const nResp = norm(el.map((c) => c.premiumResponse as number));
  const nCap = norm(el.map((c) => c.capacityPct as number));
  const nVol = norm(el.map((c) => Math.log10(1 + (c.volume as number))));
  const nOi = norm(el.map((c) => Math.log10(1 + (c.oi ?? 0))));
  const nIv = norm(el.map((c) => -(c.iv as number)));
  const nDelta = norm(el.map((c) => -Math.abs(Math.abs(c.delta as number) - 0.5)));   // closest to 0.5 delta
  const nGamma = norm(el.map((c) => c.gamma ?? 0));
  el.forEach((c, k) => { c.score = Math.round(W.response * nResp[k] + W.capacity * nCap[k] + W.volume * nVol[k] + W.oi * nOi[k] + W.ivLow * nIv[k] + W.delta * nDelta[k] + W.gamma * nGamma[k]); });
  el.sort((x, y) => y.score - x.score);
  const p = el[0], alt = el[1] ?? null;
  const fmt = (c: StrikeCandidate) => `${c.strike} ${c.optionType}: Δ${c.delta} Γ${c.gamma} IV ${c.iv?.toFixed(1)}% · LTP ${c.ltp} → ~${c.premiumAtT1} at T1 (+${c.capacityPct}%) · vol ${c.volume} · OI ${c.oi}`;
  return {
    ...base, status: "AVAILABLE", reason: "real option bars; delta/gamma model-derived (Black-Scholes, feed IV, derived expiry)",
    expiry: p ? slice.find((b) => b.strike === p.strike)?.expiry ?? null : null,
    primary: p, alternative: alt,
    selectionReason: `Best rank of premium gain to T1 (${W.response}), % gain (${W.capacity}), volume (${W.volume}), OI (${W.oi}), lower IV (${W.ivLow}), delta near 0.5 (${W.delta}), gamma (${W.gamma}); bid/ask spread not published by Dhan. ${fmt(p)}`,
    optionEntry: p.ltp, optionStop: p.premiumAtSL, optionTarget: p.premiumAtT1,
    candidates: cands,
  };
}

const median = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };

/**
 * Gamma read for one side on one candle. BUILD/PRE-BLAST try to catch developing
 * conditions BEFORE a large move; CONFIRMED needs actual acceleration evidence
 * (underlying displacement + premium acceleration + option volume + level break).
 */
export function gammaRead(a: {
  series: OptionSeries | null; side: "CE" | "PE"; times: number[]; i: number; // candle times, index of current
  strike: number | null;   // trade strike, else ATM (offset 0) is used
  spot: number | null; spotPrev: number | null; atr: number | null; strikeStep: number;
  movementState: MovementState; movementDirection: "BULLISH" | "BEARISH" | "NEUTRAL"; dc: DecisionConfig;
}): GammaRead {
  const t = a.times[a.i];
  const slice = a.series?.byTime.get(t)?.[a.side];
  const unavailable: GammaRead = { side: a.side, state: "UNAVAILABLE", score: 0, evaluated: 0, strike: null, evidence: {} };
  if (!a.series || !slice || !slice.length) return unavailable;
  const bar = a.strike != null ? slice.find((b) => b.strike === a.strike) : (slice.find((b) => b.offset === 0) ?? null);
  if (!bar) return unavailable;
  const contract = a.series.byContract.get(contractKey(bar.expiry, a.side, bar.strike));
  const hist = (k: number): OptBar | undefined => (a.i - k >= 0 ? contract?.get(a.times[a.i - k]) : undefined);
  const spot = a.spot ?? bar.spot;
  const ev: Record<string, EvidenceStatus> = {};
  const set = (k: string, v: boolean | null) => { ev[k] = v == null ? "UNAVAILABLE" : v ? "PASS" : "FAIL"; };
  const dirUp = a.side === "CE";

  set("strikeProximity", spot != null ? Math.abs(spot - bar.strike) <= a.strikeStep * 0.5 : null);
  // model gamma now vs its own trailing median (gamma rises into ATM / near expiry)
  const gNow = spot != null ? greeks(bar, spot, t).gamma : null;
  const gPast: number[] = [];
  for (let k = 1; k <= 12; k++) { const h = hist(k); if (h && h.spot != null) { const g = greeks(h, h.spot, a.times[a.i - k]).gamma; if (g != null) gPast.push(g); } }
  set("gammaLevel", gNow != null && gPast.length >= 4 ? gNow >= 1.2 * median(gPast) : null);
  const h2 = hist(2);
  const dNow = spot != null ? greeks(bar, spot, t).delta : null;
  const d2 = h2 && h2.spot != null ? greeks(h2, h2.spot, a.times[a.i - 2]).delta : null;
  set("deltaAcceleration", dNow != null && d2 != null ? Math.abs(dNow) - Math.abs(d2) >= 0.08 : null);
  const vols: number[] = []; for (let k = 1; k <= 12; k++) { const h = hist(k); if (h?.volume != null) vols.push(h.volume); }
  set("optionVolumeExpansion", bar.volume != null && vols.length >= 4 ? bar.volume >= 1.5 * median(vols) : null);
  const h3 = hist(3);
  set("ivExpansion", bar.iv != null && h3?.iv != null ? bar.iv - h3.iv >= 0.5 : null);
  const h1 = hist(1);
  set("oiFlow", h1 && h1.oi && bar.oi != null ? bar.close > h1.close && Math.abs(bar.oi - h1.oi) / h1.oi >= 0.02 : null);
  const dSpot = spot != null && a.spotPrev != null ? spot - a.spotPrev : null;
  set("underlyingDisplacement", dSpot != null && a.atr ? (dirUp ? dSpot : -dSpot) >= a.dc.dispStrongAtr * a.atr : null);
  const s = a.movementState;
  const matches = dirUp ? ["PRE_BREAKOUT", "BREAKOUT_ATTEMPT", "BREAKOUT_CONFIRMED"] : ["PRE_BREAKDOWN", "BREAKDOWN_ATTEMPT", "BREAKDOWN_CONFIRMED"];
  const expansionHere = s === "EXPANSION" && a.movementDirection === (dirUp ? "BULLISH" : "BEARISH");
  const levelState = matches.includes(s) || expansionHere;
  set("levelProximity", levelState);
  const pct: number[] = [];
  for (let k = 1; k <= 6; k++) { const x = hist(k), y = hist(k + 1); if (x && y && y.close > 0) pct.push(Math.abs((x.close - y.close) / y.close)); }
  const pctNow = h1 && h1.close > 0 ? (bar.close - h1.close) / h1.close : null;
  set("premiumAcceleration", pctNow != null && pct.length >= 3 ? pctNow > 0 && pctNow >= 2 * (pct.reduce((p, q) => p + q, 0) / pct.length) : null);
  set("liquidity", bar.volume != null && bar.oi != null ? bar.volume > 0 && bar.oi > 0 : null);

  const pass = (k: string) => ev[k] === "PASS";
  const build = ["gammaLevel", "deltaAcceleration", "optionVolumeExpansion", "ivExpansion", "oiFlow", "levelProximity"].filter(pass).length;
  const broken = (dirUp ? ["BREAKOUT_ATTEMPT", "BREAKOUT_CONFIRMED"] : ["BREAKDOWN_ATTEMPT", "BREAKDOWN_CONFIRMED"]).includes(s) || expansionHere;
  const pre = (dirUp ? ["PRE_BREAKOUT", "BREAKOUT_ATTEMPT"] : ["PRE_BREAKDOWN", "BREAKDOWN_ATTEMPT"]).includes(s);
  let state: GammaRead["state"] = "NONE";
  if (broken && pass("underlyingDisplacement") && pass("premiumAcceleration") && pass("optionVolumeExpansion")) state = "CONFIRMED";
  else if (pre && build >= 3) state = "PRE-BLAST";
  else if (build >= 3) state = "BUILDING";
  const vals = Object.values(ev);
  return { side: a.side, state, score: vals.filter((v) => v === "PASS").length, evaluated: vals.filter((v) => v !== "UNAVAILABLE").length, strike: bar.strike, evidence: ev };
}
