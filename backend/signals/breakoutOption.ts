// Option leg for a Breakout Engine signal. REUSES the existing strike analyser
// (analyzeStrikes: liquidity = OI + volume, responsiveness = |delta|, premium
// SL/target = LTP ± |delta| × underlying move) with the engine's STRUCTURAL spot
// stop/target. Adds Target 2 and the option-level R:R gate. Pure: the Security ID
// is resolved by the caller from the instrument master and passed in.
// Nothing is invented — every missing input yields null / N/A with a reason.

import { OiAnalysis } from "../types";
import { analyzeStrikes, StrikeRow } from "../analyst/strikeAnalysis";
import { TradePlan, BREAKOUT_CONFIG } from "./breakoutEngine";

export interface OptionPlan {
  available: boolean;
  reason: string | null;              // why unavailable / why the gate failed
  index: string;
  side: "CE" | "PE";
  strike: number | null;
  expiry: string | null;
  securityId: string | null;
  identity: { index: string; expiry: string | null; strike: number | null; type: "CE" | "PE"; securityId: string | null; verified: boolean; detail: string } | null;
  spot: number | null;
  optionLtp: number | null;
  entry: number | null; stopLoss: number | null; target1: number | null; target2: number | null;
  risk: number | null; reward: number | null; rr: number | null;
  passesRR: boolean;
  delta: number | null; iv: number | null; oi: number | null; oiChg: number | null; volume: number | null;
  why: string | null;
  alternative: { strike: number; why: string } | null;
  candidates: Pick<StrikeRow, "strike" | "moneyness" | "ltp" | "oi" | "volume" | "delta" | "assessment">[];
  method: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildOptionPlan(
  plan: TradePlan, oi: OiAnalysis | null,
  opts: { name: string; stale?: boolean; securityId?: string | null; securityDetail?: string; rrMin?: number } ,
): OptionPlan {
  const side: "CE" | "PE" = plan.dir === "BUY" ? "CE" : "PE";
  const rrMin = opts.rrMin ?? BREAKOUT_CONFIG.rrMin;
  const base: OptionPlan = {
    available: false, reason: null, index: opts.name, side, strike: null, expiry: oi?.expiry ?? null, securityId: null, identity: null,
    spot: oi?.underlying ?? null, optionLtp: null, entry: null, stopLoss: null, target1: null, target2: null,
    risk: null, reward: null, rr: null, passesRR: false, delta: null, iv: null, oi: null, oiChg: null, volume: null,
    why: null, alternative: null, candidates: [],
    method: "Existing strike analyser (OI + volume liquidity, |delta| responsiveness); premium levels = LTP ± |delta| × underlying move to the structural SL / target (delta estimate).",
  };
  const sa = analyzeStrikes(oi, plan.dir === "BUY" ? "BULLISH" : "BEARISH", { stale: opts.stale, name: opts.name, spotSL: plan.stopLoss, spotTarget: plan.target1 });
  base.candidates = (sa.rows || []).map((r) => ({ strike: r.strike, moneyness: r.moneyness, ltp: r.ltp, oi: r.oi, volume: r.volume, delta: r.delta, assessment: r.assessment }));
  if (!sa.available) { base.reason = sa.reason || "Option chain unavailable"; return base; }
  if (!sa.primary || !sa.bestSetup) { base.reason = sa.summary?.why || "No strike with adequate liquidity and responsiveness"; return base; }
  const row = sa.rows.find((r) => r.strike === sa.primary!.strike) || null;
  const bs = sa.bestSetup;
  base.strike = sa.primary.strike; base.expiry = sa.expiry; base.why = sa.primary.why;
  base.alternative = sa.alternative ? { strike: sa.alternative.strike, why: sa.alternative.why } : null;
  base.optionLtp = bs.entryPremium; base.entry = bs.entryPremium;
  base.stopLoss = bs.stopPremium; base.target1 = bs.targetPremium;
  base.risk = bs.riskPts; base.reward = bs.rewardPts; base.rr = bs.rr;
  base.delta = row?.delta ?? null; base.iv = row?.iv ?? null; base.oi = row?.oi ?? null; base.oiChg = row?.oiChg ?? null; base.volume = row?.volume ?? null;
  // Target 2 from the same delta model when the engine has a structural T2.
  if (plan.target2 != null && bs.entryPremium != null && bs.responsiveness != null && sa.spot != null) {
    base.target2 = r2(bs.entryPremium + bs.responsiveness * Math.abs(plan.target2 - sa.spot));
  }
  base.securityId = opts.securityId ?? null;
  base.identity = {
    index: opts.name, expiry: sa.expiry, strike: base.strike, type: side, securityId: base.securityId,
    verified: !!base.securityId, detail: opts.securityDetail || (base.securityId ? "instrument master" : "Security ID not resolved"),
  };
  base.available = bs.entryPremium != null && bs.stopPremium != null && bs.targetPremium != null;
  base.passesRR = base.available && base.rr != null && base.rr >= rrMin;
  if (!base.available) base.reason = bs.note || "Option LTP / delta unavailable";
  else if (!base.identity.verified) base.reason = "Contract identity not verified (Security ID missing)";
  else if (!base.passesRR) base.reason = `Option R:R 1:${base.rr ?? "—"} below 1:${rrMin.toFixed(2)}`;
  return base;
}
