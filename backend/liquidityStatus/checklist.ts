// ============================ Sections 8, 13, 17 — Confirmation, Early Warning, Conflict ============================
import { EmaStructure, EvidenceRow, ConfirmationChecklist, EarlyWarning, LiquidityConflict, VwapStatus } from "./types";
import { OiChangeResult } from "../oi/oiChange";

export interface ConfirmationInput {
  direction: "Bullish" | "Bearish" | null;
  vwapStatus: VwapStatus;
  emaStructure: EmaStructure;
  ema9: number | null; ema21: number | null; ema50: number | null;
  evidence: EvidenceRow[];
  rvol: number | null;
  rvolExpansion: number;
  premiumConfirming: boolean;
  triggerLabel: string | null; // e.g. "Breakout above 25,200 required"
}

/** Section 8 — a clear, itemized ✓/⚠ list. What's confirmed vs. what's still needed. */
export function buildConfirmationChecklist(input: ConfirmationInput): ConfirmationChecklist {
  if (!input.direction) return { confirmed: [], remaining: [{ label: "No confirmed direction yet", confirmed: false }] };
  const bull = input.direction === "Bullish";
  const items = [
    { label: `Spot ${bull ? "above" : "below"} VWAP`, confirmed: bull ? input.vwapStatus.startsWith("Above") : input.vwapStatus.startsWith("Below") },
    { label: `EMA 9 ${bull ? ">" : "<"} EMA 21`, confirmed: input.ema9 != null && input.ema21 != null && (bull ? input.ema9 > input.ema21 : input.ema9 < input.ema21) },
    { label: `EMA 21 ${bull ? ">" : "<"} EMA 50`, confirmed: input.ema21 != null && input.ema50 != null && (bull ? input.ema21 > input.ema50 : input.ema21 < input.ema50) },
    { label: bull ? "Put support strengthening" : "Call resistance strengthening", confirmed: input.evidence.some((e) => bull ? e.interpretation === "PUT WRITING / SUPPORT BUILDING" : e.interpretation === "CALL WRITING / RESISTANCE BUILDING") },
    { label: bull ? "Call resistance unwinding" : "Put support unwinding", confirmed: input.evidence.some((e) => bull ? e.interpretation === "CALL UNWINDING" : e.interpretation === "PUT UNWINDING") },
    { label: `RVOL ${input.rvol != null ? input.rvol.toFixed(1) + "x" : ""}`.trim(), confirmed: input.rvol != null && input.rvol >= input.rvolExpansion },
    { label: `${bull ? "CE" : "PE"} premium confirming`, confirmed: input.premiumConfirming },
  ];
  const confirmed = items.filter((i) => i.confirmed);
  const remaining = items.filter((i) => !i.confirmed);
  if (input.triggerLabel) remaining.push({ label: input.triggerLabel, confirmed: false });
  return { confirmed, remaining };
}

/** Section 13 — flags a change worth noticing; never a directional call by itself. */
export function buildEarlyWarnings(input: {
  evidence: EvidenceRow[]; distanceToResistancePts: number | null; distanceToSupportPts: number | null;
  rvol: number | null; rvolStrong: number; vwapStatus: VwapStatus;
}): EarlyWarning[] {
  const warnings: EarlyWarning[] = [];
  const callUnwind = input.evidence.find((e) => e.side === "CALL" && e.interpretation === "CALL UNWINDING");
  if (callUnwind && input.distanceToResistancePts != null && input.distanceToResistancePts >= 0) {
    warnings.push({
      severity: "warn",
      text: `Resistance is weakening — call OI ${callUnwind.oiChangePct != null ? "decreased " + Math.abs(callUnwind.oiChangePct).toFixed(1) + "%" : "unwinding"} while premium ${callUnwind.premiumChangePct != null ? "increased " + callUnwind.premiumChangePct.toFixed(1) + "%" : "rose"}. Spot is ${input.distanceToResistancePts.toFixed(0)} pts away.`,
    });
  }
  const putUnwind = input.evidence.find((e) => e.side === "PUT" && e.interpretation === "PUT UNWINDING");
  if (putUnwind && input.distanceToSupportPts != null) {
    warnings.push({ severity: "warn", text: `Support is weakening — put OI is unwinding near the key support level.` });
  }
  if (input.rvol != null && input.rvol >= input.rvolStrong) {
    warnings.push({ severity: "info", text: `Unusual volume expansion — RVOL ${input.rvol.toFixed(1)}x.` });
  }
  if (input.vwapStatus === "Choppy") {
    warnings.push({ severity: "info", text: "Price is whipsawing across VWAP — directional read is currently unclear." });
  }
  return warnings;
}

/** Section 17 — price and OI disagreeing must never be silently resolved into a
 * directional call; it forces WAIT (see traderAction.ts). */
export function detectConflict(priceDirection: "up" | "down" | "flat", oc: OiChangeResult | null): LiquidityConflict {
  if (!oc || !oc.hasBaseline || priceDirection === "flat") return { conflict: false, reason: null };
  const oiOpposesUp = priceDirection === "up" && oc.oiVerdict === "Bearish";
  const oiOpposesDown = priceDirection === "down" && oc.oiVerdict === "Bullish";
  if (oiOpposesUp) return { conflict: true, reason: "Price is moving higher, but OI structure is bearish (call OI increasing aggressively). Breakout is not confirmed." };
  if (oiOpposesDown) return { conflict: true, reason: "Price is moving lower, but OI structure is bullish (put OI increasing aggressively). Breakdown is not confirmed." };
  return { conflict: false, reason: null };
}
