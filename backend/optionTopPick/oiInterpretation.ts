// ============================ OI walls + OI/price confirmation ============================
// Wraps backend/oi/oiChange.ts's computeOiChange() (the richer, baseline-diffed,
// per-strike OI classifier already in this app) rather than reimplementing OI-wall
// or writing/unwinding detection. OI alone never decides a track's direction —
// see liquidityDirectionalScore.ts, which also weighs volume, premium and VWAP,
// and directionScore.ts, where OI is one of seven votes, never the sole trigger.

import { OiAnalysis } from "../types";
import { OiChangeResult } from "../oi/oiChange";
import { OiInterpretation, OiLegAction, WallInfo } from "./types";

function toWallInfo(b: OiChangeResult["maxCeBuildup"]): WallInfo | null {
  if (!b) return null;
  return { strike: b.strike, oiChg: b.oiChg, veryHigh: b.veryHigh, label: b.label };
}

function findAtmLevel(oc: OiChangeResult | null, atmStrike: number) {
  return oc?.levels.find((l) => l.strike === atmStrike) ?? oc?.chain.find((l) => l.strike === atmStrike) ?? null;
}

/** The ATM leg's own %-premium change since today's baseline (from computeOiChange's
 * per-strike diff) — used by liquidityDirectionalScore.ts's "option premium
 * confirming" check instead of re-deriving it from raw LTPs with no baseline. */
export function atmPremiumChangePct(oc: OiChangeResult | null, atmStrike: number, side: "CE" | "PE"): number | null {
  const level = findAtmLevel(oc, atmStrike);
  if (!level) return null;
  return side === "CE" ? level.ce.ltpChgPct : level.pe.ltpChgPct;
}

function classifyAction(raw: string | undefined): OiLegAction {
  if (!raw) return "Unclear";
  if (raw.includes("Call writing")) return "Call writing";
  if (raw.includes("Call unwinding")) return "Call unwinding";
  if (raw.includes("Put writing")) return "Put writing";
  if (raw.includes("Put unwinding")) return "Put unwinding";
  return "Unclear";
}

/** Walls + per-strike OI+price confirmation at the ATM strike. */
export function interpretOi(oc: OiChangeResult | null, oi: OiAnalysis, atmStrike: number): OiInterpretation {
  const atmLevel = findAtmLevel(oc, atmStrike);
  return {
    callResistanceWall: oc ? toWallInfo(oc.maxCeBuildup) : null,
    putSupportWall: oc ? toWallInfo(oc.maxPeBuildup) : null,
    atmAction: {
      ce: classifyAction(atmLevel?.ce.action),
      pe: classifyAction(atmLevel?.pe.action),
    },
    oiVerdict: oc?.oiVerdict ?? (oi.verdict.bias === "Bullish" ? "Bullish" : oi.verdict.bias === "Bearish" ? "Bearish" : "Neutral"),
    oiConfidence: oc?.oiConfidence ?? 0,
    oiReasons: oc?.oiReasons ?? (oc ? [] : ["OI baseline not established yet today — verdict unavailable until the first daily reading"]),
    pcr: oi.pcr,
    pcrState: oi.pcrState,
    hasBaseline: oc?.hasBaseline ?? false,
  };
}

/** A stock has no F&O option chain — a "neutral, no OI" interpretation so downstream
 * scoring degrades gracefully (Stock Setup track doesn't need this; Liquidity
 * Directional track's gates will correctly fail on "insufficient OI confidence"). */
export function emptyOiInterpretation(): OiInterpretation {
  return {
    callResistanceWall: null, putSupportWall: null,
    atmAction: { ce: "Unclear", pe: "Unclear" },
    oiVerdict: "Neutral", oiConfidence: 0, oiReasons: ["No option chain available for this stock"],
    pcr: null, pcrState: "neutral", hasBaseline: false,
  };
}
