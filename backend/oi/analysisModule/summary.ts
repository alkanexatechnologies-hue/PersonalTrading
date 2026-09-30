// ============================================================================
//  OI ANALYSIS MODULE — OI Summary assembler  (ADDITIVE, PURE)
// ----------------------------------------------------------------------------
//  Answers "what does the OI movement INDICATE?" for the OI Summary screen.
//  Pure: takes the already-computed OiAnalysis chain (getOiCached) plus the
//  windowed OiMoveResult and derives totals, PCR read, a bias with a confidence
//  score and NUMERICAL evidence, Call/Put walls, support/resistance zones, a
//  plain-language direction guide, and conditional bull/bear scenarios.
//  It votes into no trading engine and places no orders. Colour: CALL red, PUT green.
// ============================================================================

import { OiAnalysis } from "../../types";
import { OiMoveResult } from "../oiMovement";

export interface Evidence {
  label: string;
  value: string;
  lean: "bullish" | "bearish" | "neutral";
}

export interface Wall {
  strike: number;
  oi: number;
  side: "CALL" | "PUT";
}

export interface Scenario {
  kind: "bullish" | "bearish";
  trigger: string;      // the condition to watch
  implication: string;  // what it would mean
}

export interface OiSummary {
  available: boolean;
  message?: string;
  symbol: string;
  underlying: number | null;
  expiry: string | null;
  asOf: number;
  totalCeOi: number;
  totalPeOi: number;
  pcr: number | null;
  pcrState: "bullish" | "bearish" | "neutral";
  bias: "Bullish" | "Bearish" | "Neutral";
  confidencePct: number;   // 0..100
  evidence: Evidence[];
  callWall: Wall | null;   // max CALL OI = resistance
  putWall: Wall | null;    // max PUT OI = support
  supportZone: number | null;
  resistanceZone: number | null;
  maxPain: number | null;
  directionGuide: string;
  scenarios: Scenario[];
}

export function buildOiSummary(symbol: string, oi: OiAnalysis | null, move: OiMoveResult | null): OiSummary {
  if (!oi || !oi.available) {
    return emptySummary(symbol, oi?.message || "OI data unavailable.");
  }

  const evidence: Evidence[] = [];
  const leans: Array<"bullish" | "bearish" | "neutral"> = [];

  // 1) PCR
  if (oi.pcr != null) {
    evidence.push({ label: "PCR (Put/Call OI)", value: oi.pcr.toFixed(2), lean: oi.pcrState });
    leans.push(oi.pcrState);
  }

  // 2) Wall balance — total PUT OI vs total CALL OI
  const totalOi = Math.max(1, oi.totalCeOi + oi.totalPeOi);
  const putShare = +((oi.totalPeOi / totalOi) * 100).toFixed(1);
  const wallLean: "bullish" | "bearish" | "neutral" = putShare > 55 ? "bullish" : putShare < 45 ? "bearish" : "neutral";
  evidence.push({
    label: "Put OI share",
    value: `${putShare}%  (PUT ${fmt(oi.totalPeOi)} vs CALL ${fmt(oi.totalCeOi)})`,
    lean: wallLean,
  });
  leans.push(wallLean);

  // 3) Buildup on each side (chain-level)
  const ceLean = buildupLean("CALL", oi.ceBuildup);
  const peLean = buildupLean("PUT", oi.peBuildup);
  evidence.push({ label: "Call buildup", value: cap(oi.ceBuildup), lean: ceLean });
  evidence.push({ label: "Put buildup", value: cap(oi.peBuildup), lean: peLean });
  leans.push(ceLean, peLean);

  // 4) Windowed OI flow (15-min direction), when available
  if (move && move.direction && move.direction.available) {
    const d = move.direction;
    const flowLean: "bullish" | "bearish" | "neutral" =
      d.signal === "BULLISH" ? "bullish" : d.signal === "BEARISH" ? "bearish" : "neutral";
    evidence.push({
      label: "15-min OI flow",
      value: `${d.signal} (${d.dominant}), score ${d.bullishScorePct >= 0 ? "+" : ""}${d.bullishScorePct}%`,
      lean: flowLean,
    });
    leans.push(flowLean);
  }

  // 5) Futures OI buildup, when the chain carries it
  if (oi.futBuildup && oi.futBuildup !== "—" && oi.futOiChangePct != null) {
    const fb = oi.futBuildup.toLowerCase();
    const futLean: "bullish" | "bearish" | "neutral" =
      fb.includes("long buildup") || fb.includes("short covering") ? "bullish"
      : fb.includes("short buildup") || fb.includes("long unwinding") ? "bearish" : "neutral";
    evidence.push({ label: "Futures OI", value: `${oi.futBuildup} (${oi.futOiChangePct >= 0 ? "+" : ""}${oi.futOiChangePct}%)`, lean: futLean });
    leans.push(futLean);
  }

  const { bias, confidencePct } = tally(leans);

  const callWall: Wall | null = oi.resistance != null ? { strike: oi.resistance, oi: maxSideOi(oi, "CALL", oi.resistance), side: "CALL" } : null;
  const putWall: Wall | null = oi.support != null ? { strike: oi.support, oi: maxSideOi(oi, "PUT", oi.support), side: "PUT" } : null;

  return {
    available: true,
    symbol,
    underlying: oi.underlying,
    expiry: oi.expiry,
    asOf: oi.asOf,
    totalCeOi: oi.totalCeOi,
    totalPeOi: oi.totalPeOi,
    pcr: oi.pcr,
    pcrState: oi.pcrState,
    bias,
    confidencePct,
    evidence,
    callWall,
    putWall,
    supportZone: oi.support,
    resistanceZone: oi.resistance,
    maxPain: oi.maxPain,
    directionGuide: guide(bias, confidencePct, oi),
    scenarios: scenarios(oi),
  };
}

function tally(leans: Array<"bullish" | "bearish" | "neutral">): { bias: "Bullish" | "Bearish" | "Neutral"; confidencePct: number } {
  const bull = leans.filter((l) => l === "bullish").length;
  const bear = leans.filter((l) => l === "bearish").length;
  const total = Math.max(1, leans.length);
  const net = bull - bear;
  const bias: "Bullish" | "Bearish" | "Neutral" = net > 0 ? "Bullish" : net < 0 ? "Bearish" : "Neutral";
  // Confidence = how lopsided the agreeing signals are, scaled to 0..100.
  const confidencePct = Math.round((Math.abs(net) / total) * 100);
  return { bias, confidencePct };
}

function buildupLean(side: "CALL" | "PUT", b: string): "bullish" | "bearish" | "neutral" {
  const s = (b || "").toLowerCase();
  if (side === "CALL") {
    if (s.includes("short buildup")) return "bearish";
    if (s.includes("long buildup")) return "bullish";
    if (s.includes("short covering")) return "bullish";
    if (s.includes("long unwinding")) return "bearish";
  } else {
    if (s.includes("short buildup")) return "bullish";
    if (s.includes("long buildup")) return "bearish";
    if (s.includes("short covering")) return "bearish";
    if (s.includes("long unwinding")) return "bullish";
  }
  return "neutral";
}

function maxSideOi(oi: OiAnalysis, side: "CALL" | "PUT", strike: number): number {
  const row = oi.topStrikes.find((s) => s.strike === strike);
  if (!row) return 0;
  return side === "CALL" ? row.ceOi : row.peOi;
}

function guide(bias: string, conf: number, oi: OiAnalysis): string {
  const sup = oi.support != null ? oi.support : null;
  const res = oi.resistance != null ? oi.resistance : null;
  const band = sup != null && res != null ? ` Expect ${sup} (support) ↔ ${res} (resistance) to contain price until one breaks.` : "";
  if (conf < 25) return `OI is balanced — no clear edge. Likely rangebound.${band}`;
  const strength = conf >= 55 ? "strongly" : "modestly";
  if (bias === "Bullish") return `OI structure ${strength} favours the upside — puts holding / calls unwinding.${band}`;
  if (bias === "Bearish") return `OI structure ${strength} favours the downside — calls holding / puts unwinding.${band}`;
  return `OI is balanced — no clear edge. Likely rangebound.${band}`;
}

function scenarios(oi: OiAnalysis): Scenario[] {
  const out: Scenario[] = [];
  if (oi.resistance != null) {
    out.push({
      kind: "bullish",
      trigger: `Price sustains above the call wall ${oi.resistance} with call OI unwinding there`,
      implication: `Resistance lifts → room toward the next call wall; favours CE.`,
    });
  }
  if (oi.support != null) {
    out.push({
      kind: "bearish",
      trigger: `Price breaks below the put wall ${oi.support} with put OI unwinding there`,
      implication: `Support gone → room toward the next put wall; favours PE.`,
    });
  }
  return out;
}

function emptySummary(symbol: string, message: string): OiSummary {
  return {
    available: false, message, symbol, underlying: null, expiry: null, asOf: Date.now(),
    totalCeOi: 0, totalPeOi: 0, pcr: null, pcrState: "neutral", bias: "Neutral", confidencePct: 0,
    evidence: [], callWall: null, putWall: null, supportZone: null, resistanceZone: null,
    maxPain: null, directionGuide: "DATA UNAVAILABLE", scenarios: [],
  };
}

function fmt(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
