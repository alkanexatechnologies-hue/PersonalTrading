// ===================== AI Market Analyst — Market View (read-only) =====================
// Explains the EXISTING system's current read: what the direction is, what
// supports it, what contradicts it, what confirmation is missing, and where the
// view is invalidated. Every input is an output the app's own engines already
// produced (structure, VWAP/EMA liquidity, Order Block, OI, the confirmation
// checklist, the OI management invalidation level). It invents nothing and it
// NEVER overrides the Master Trade Selector — the final state is passed in.

export type Dir = "BULLISH" | "BEARISH" | "NEUTRAL";
export type SystemState = "TAKE" | "READY" | "WAIT" | "AVOID" | "REPLAY";

export interface MarketViewInput {
  direction: Dir;                 // the command's direction (OI-derived, or structure in replay)
  finalAction: string;            // TAKE / WAIT / NO TRADE / DATA STALE / REPLAY
  masterVerdict: string;          // GO / WAIT / CONFLICT
  structure: string;              // ms.currentStructure: Bullish/Bearish/Ranging
  preStructure: string;           // ms.preStructure
  vwapStatus: string;             // ms.vwapStatus: Above/Below/At
  oiDirection: string;            // UP / DOWN / FLAT
  oiAvailable: boolean;           // is the live OI chain delivering (not the degraded bulletin)?
  emaStructure?: string | null;   // ls.structure.emaStructure, when liquidity status is live
  lsVwapStatus?: string | null;   // ls.structure.vwapStatus
  obSide?: string | null;         // nearest OB side (Bullish/Bearish)
  obStatus?: string | null;       // Fresh/Mitigated/Invalid
  obStage?: string | null;        // Pre/Confirmed
  confirmations: { label: string; passed: boolean }[];
  invalidationSpot?: number | null; // oiData.management.invalidation (spot level)
  optionView?: "CE" | "PE" | null;
  preferredStrike?: string | null;  // from strike analysis
  dataStale: boolean;
}

export interface DirectionValidation {
  dominant: "BULLISH" | "BEARISH" | "NEUTRAL" | "CONFLICT";
  bullishEvidence: string[];
  bearishEvidence: string[];
  bullVotes: number;
  bearVotes: number;
  confirmationRequired: string | null;
}

export interface MarketView {
  direction: Dir | "CONFLICT";
  validation: DirectionValidation;
  state: SystemState;
  strength: "STRONG" | "MODERATE" | "WEAK";
  strengthEvidence: string;       // e.g. "5/7 confirmations aligned"
  supporting: string[];
  contradicting: string[];
  missing: string[];
  invalidation: string;
  optionView: "CE" | "PE" | null;
  preferredStrike: string | null;
  basedOn: string;                // provenance / caveat (e.g. OI unavailable → structure-only)
}

// ---- Direction validation: a transparent one-vote-per-engine cross-check.
// No invented weights — each deterministic engine that has a reading casts a
// single bullish/bearish vote, and the dominant side wins. A near-even split of
// meaningful votes is CONFLICT (the agent is allowed to refuse a call), and no
// votes at all is NEUTRAL. This is what keeps "market direction" grounded in the
// app's real-time engines rather than a language-model opinion.
export function validateDirection(i: MarketViewInput): DirectionValidation {
  const bull: string[] = [], bear: string[] = [];

  if (i.structure === "Bullish") bull.push("Market structure Bullish");
  else if (i.structure === "Bearish") bear.push("Market structure Bearish");

  if (i.vwapStatus === "Above") bull.push("Price above VWAP");
  else if (i.vwapStatus === "Below") bear.push("Price below VWAP");

  if (i.emaStructure) {
    if (/Bullish/i.test(i.emaStructure)) bull.push(`EMA structure ${i.emaStructure}`);
    else if (/Bearish/i.test(i.emaStructure)) bear.push(`EMA structure ${i.emaStructure}`);
  }

  if (i.preStructure === "Bullish") bull.push("Short-term momentum up");
  else if (i.preStructure === "Bearish") bear.push("Short-term momentum down");

  if (i.obSide && i.obStatus && i.obStatus !== "Invalid") {
    if (i.obSide === "Bullish") bull.push(`${i.obStage || ""} Bullish Order Block (${i.obStatus})`.trim());
    else if (i.obSide === "Bearish") bear.push(`${i.obStage || ""} Bearish Order Block (${i.obStatus})`.trim());
  }

  if (i.oiAvailable) {
    if (i.oiDirection === "UP") bull.push("OI direction UP");
    else if (i.oiDirection === "DOWN") bear.push("OI direction DOWN");
  }

  const bv = bull.length, brv = bear.length;
  let dominant: DirectionValidation["dominant"];
  if (bv === 0 && brv === 0) dominant = "NEUTRAL";
  else if (bv >= 2 && brv >= 2 && Math.abs(bv - brv) <= 1) dominant = "CONFLICT"; // both sides strong & close
  else if (bv > brv) dominant = "BULLISH";
  else if (brv > bv) dominant = "BEARISH";
  else dominant = "CONFLICT"; // exact tie with votes on both sides

  const confReq = i.confirmations.filter((c) => !c.passed).map((c) => c.label);
  return {
    dominant, bullishEvidence: bull, bearishEvidence: bear, bullVotes: bv, bearVotes: brv,
    confirmationRequired: confReq.length ? confReq.join(", ") : null,
  };
}

export function buildMarketView(i: MarketViewInput): MarketView {
  const passed = i.confirmations.filter((c) => c.passed);
  const failed = i.confirmations.filter((c) => !c.passed);
  const n = i.confirmations.length || 1;

  // Direction is the validated cross-check, not a passed-in opinion.
  const validation = validateDirection(i);
  const direction = validation.dominant;

  const state: SystemState =
    i.finalAction === "TAKE" ? "TAKE"
    : i.finalAction === "REPLAY" ? "REPLAY"
    : i.finalAction === "NO TRADE" ? "AVOID"
    : i.masterVerdict === "GO" ? "READY"
    : "WAIT";

  const strength = passed.length >= 5 ? "STRONG" : passed.length >= 3 ? "MODERATE" : "WEAK";

  // Supporting = the dominant side's evidence; contradicting = the other side's.
  let supporting: string[] = [], contradicting: string[] = [];
  if (direction === "BULLISH") { supporting = validation.bullishEvidence; contradicting = validation.bearishEvidence; }
  else if (direction === "BEARISH") { supporting = validation.bearishEvidence; contradicting = validation.bullishEvidence; }
  else { supporting = []; contradicting = [...validation.bullishEvidence, ...validation.bearishEvidence]; }

  const missing = failed.map((c) => c.label);

  const invalidation = i.invalidationSpot != null
    ? `Spot through ${Math.round(i.invalidationSpot * 100) / 100} invalidates this view`
    : "Existing system has no invalidation level yet";

  let basedOn: string;
  if (i.dataStale) basedOn = "Live OI is stale — direction from fresh candle structure/VWAP only; final action gated to WAIT.";
  else if (!i.oiAvailable) basedOn = "OI option chain unavailable — direction is structure/VWAP-based; option side not confirmed.";
  else basedOn = "Cross-check of structure + VWAP/EMA + momentum + Order Block + OI.";

  return {
    direction, validation, state, strength,
    strengthEvidence: `${passed.length}/${n} confirmations aligned`,
    supporting, contradicting, missing,
    invalidation,
    optionView: i.optionView ?? null,
    preferredStrike: i.preferredStrike ?? null,
    basedOn,
  };
}
