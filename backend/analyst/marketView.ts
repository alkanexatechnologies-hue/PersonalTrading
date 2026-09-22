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

export interface MarketView {
  direction: Dir;
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

const matches = (dir: Dir, bull: boolean, bear: boolean) =>
  (dir === "BULLISH" && bull) || (dir === "BEARISH" && bear);

export function buildMarketView(i: MarketViewInput): MarketView {
  const passed = i.confirmations.filter((c) => c.passed);
  const failed = i.confirmations.filter((c) => !c.passed);
  const n = i.confirmations.length || 1;

  const state: SystemState =
    i.finalAction === "TAKE" ? "TAKE"
    : i.finalAction === "REPLAY" ? "REPLAY"
    : i.finalAction === "NO TRADE" ? "AVOID"
    : i.masterVerdict === "GO" ? "READY"
    : "WAIT";

  const strength = passed.length >= 5 ? "STRONG" : passed.length >= 3 ? "MODERATE" : "WEAK";

  const supporting: string[] = [];
  const contradicting: string[] = [];

  // Structure
  const structBull = i.structure === "Bullish", structBear = i.structure === "Bearish";
  if (matches(i.direction, structBull, structBear)) supporting.push(`Market structure ${i.structure}`);
  else if (structBull || structBear) contradicting.push(`Structure is ${i.structure}`);

  // VWAP (candle-derived) + liquidity-status VWAP if present
  const vwapBull = i.vwapStatus === "Above", vwapBear = i.vwapStatus === "Below";
  if (matches(i.direction, vwapBull, vwapBear)) supporting.push(`Price ${i.vwapStatus} VWAP`);
  else if (vwapBull || vwapBear) contradicting.push(`Price ${i.vwapStatus} VWAP`);

  // EMA structure (only when liquidity status is live)
  if (i.emaStructure) {
    const emaBull = /Bullish/i.test(i.emaStructure), emaBear = /Bearish/i.test(i.emaStructure);
    if (matches(i.direction, emaBull, emaBear)) supporting.push(`EMA structure ${i.emaStructure}`);
    else if (emaBull || emaBear) contradicting.push(`EMA structure ${i.emaStructure}`);
  }

  // Order Block
  if (i.obSide && i.obStatus && i.obStatus !== "Invalid") {
    const obBull = i.obSide === "Bullish", obBear = i.obSide === "Bearish";
    if (matches(i.direction, obBull, obBear)) supporting.push(`${i.obStage || ""} ${i.obSide} Order Block (${i.obStatus})`.trim());
    else contradicting.push(`Nearest Order Block is ${i.obSide}`);
  }

  // OI
  if (i.oiAvailable) {
    const oiBull = i.oiDirection === "UP", oiBear = i.oiDirection === "DOWN";
    if (matches(i.direction, oiBull, oiBear)) supporting.push(`OI direction ${i.oiDirection}`);
    else if (i.oiDirection === "FLAT") contradicting.push("OI direction FLAT (no derivatives edge)");
    else contradicting.push(`OI direction ${i.oiDirection}`);
  }

  // Short-term momentum via pre-structure (early read)
  const preBull = i.preStructure === "Bullish", preBear = i.preStructure === "Bearish";
  if ((preBull || preBear) && !matches(i.direction, preBull, preBear)) contradicting.push(`Short-term momentum ${i.preStructure}`);

  const missing = failed.map((c) => c.label);

  const invalidation = i.invalidationSpot != null
    ? `Spot through ${Math.round(i.invalidationSpot * 100) / 100} invalidates this view`
    : "Existing system has no invalidation level yet";

  let basedOn: string;
  if (i.dataStale) basedOn = "Live OI is stale — view is from fresh candle structure/VWAP only; final action gated to WAIT.";
  else if (!i.oiAvailable) basedOn = "OI option chain unavailable — view is structure/VWAP-based; option side not confirmed.";
  else basedOn = "Structure + VWAP/EMA + Order Block + OI + confirmation checklist.";

  return {
    direction: i.direction, state, strength,
    strengthEvidence: `${passed.length}/${n} confirmations aligned`,
    supporting, contradicting, missing,
    invalidation,
    optionView: i.optionView ?? null,
    preferredStrike: i.preferredStrike ?? null,
    basedOn,
  };
}
