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

export interface KeyLevel {
  role: string;           // "Call Wall", "Resistance", "Important", "Put Wall", "Support"
  strike: number;
  oi: number;
  oiChg: number;          // day ΔOI at that strike (from the chain)
  changePct: number | null;
  interpretation: string; // "Strong Resistance" / "Resistance" / "Strong Support" / "Support"
  side: "CALL" | "PUT";
}

// Extra market context passed in by the route (from the live quote), so the
// summary never has to guess spot / day-change.
export interface SummaryContext {
  spot?: number | null;
  spotChg?: number | null;
  spotChgPct?: number | null;
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
  totalCePct: number | null;   // % change vs first read of the session (null until baseline)
  totalPePct: number | null;
  pcr: number | null;
  pcrState: "bullish" | "bearish" | "neutral";
  pcrVolume: number | null;    // Put/Call traded-volume ratio (null when volume absent)
  pcrVolumeState: "bullish" | "bearish" | "neutral";
  spot: number | null;
  spotChg: number | null;
  spotChgPct: number | null;
  bias: "Bullish" | "Bearish" | "Neutral";
  biasEmoji: string;
  confidencePct: number;   // 0..100
  confidenceLabel: string; // "Low" / "Moderate" / "High" Confidence
  evidence: Evidence[];
  callWall: Wall | null;   // max CALL OI = resistance
  putWall: Wall | null;    // max PUT OI = support
  supportZone: number | null;
  resistanceZone: number | null;
  maxPain: number | null;
  keyLevels: KeyLevel[];
  directionGuide: string;
  scenarios: Scenario[];
  bullishConditions: string[];
  bearishConditions: string[];
  guidance: string[];      // actionable, numbered on the UI
}

export function buildOiSummary(symbol: string, oi: OiAnalysis | null, move: OiMoveResult | null, ctx: SummaryContext = {}): OiSummary {
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

  // 6) PCR (Volume) — from traded volume when the chain carries it
  const pv = pcrVolumeFrom(oi);
  if (pv.pcrVolume != null) {
    evidence.push({ label: "PCR (Volume)", value: pv.pcrVolume.toFixed(2), lean: pv.state });
    leans.push(pv.state);
  }

  const { bias, confidencePct } = tally(leans);

  const callWall: Wall | null = oi.resistance != null ? { strike: oi.resistance, oi: maxSideOi(oi, "CALL", oi.resistance), side: "CALL" } : null;
  const putWall: Wall | null = oi.support != null ? { strike: oi.support, oi: maxSideOi(oi, "PUT", oi.support), side: "PUT" } : null;

  const pct = sessionPct(symbol, oi.totalCeOi, oi.totalPeOi);
  const keyLevels = buildKeyLevels(oi);

  return {
    available: true,
    symbol,
    underlying: oi.underlying,
    expiry: oi.expiry,
    asOf: oi.asOf,
    totalCeOi: oi.totalCeOi,
    totalPeOi: oi.totalPeOi,
    totalCePct: pct.cePct,
    totalPePct: pct.pePct,
    pcr: oi.pcr,
    pcrState: oi.pcrState,
    pcrVolume: pv.pcrVolume,
    pcrVolumeState: pv.state,
    spot: ctx.spot ?? oi.underlying,
    spotChg: ctx.spotChg ?? null,
    spotChgPct: ctx.spotChgPct ?? null,
    bias,
    biasEmoji: bias === "Bullish" ? "😀" : bias === "Bearish" ? "😟" : "😐",
    confidencePct,
    confidenceLabel: confidencePct >= 55 ? "High" : confidencePct >= 25 ? "Moderate" : "Low",
    evidence,
    callWall,
    putWall,
    supportZone: oi.support,
    resistanceZone: oi.resistance,
    maxPain: oi.maxPain,
    keyLevels,
    directionGuide: guide(bias, confidencePct, oi),
    scenarios: scenarios(oi),
    bullishConditions: buildConditions(oi, "bullish"),
    bearishConditions: buildConditions(oi, "bearish"),
    guidance: buildGuidance(oi, bias),
  };
}

// ---- PCR (Volume) from the chain's traded volume, when present ----
function pcrVolumeFrom(oi: OiAnalysis): { pcrVolume: number | null; state: "bullish" | "bearish" | "neutral" } {
  let ceV = 0, peV = 0, have = false;
  for (const s of oi.topStrikes) {
    if (s.ceVol != null) { ceV += s.ceVol; have = true; }
    if (s.peVol != null) { peV += s.peVol; have = true; }
  }
  if (!have || ceV <= 0) return { pcrVolume: null, state: "neutral" };
  const r = +(peV / ceV).toFixed(2);
  const state: "bullish" | "bearish" | "neutral" = r > 1.1 ? "bullish" : r < 0.9 ? "bearish" : "neutral";
  return { pcrVolume: r, state };
}

// ---- Session baseline for total-OI % change (in-memory, per symbol+IST date) ----
const _totalsBase = new Map<string, { date: string; ce: number; pe: number }>();
function istDate(): string { return new Date(Date.now() + 19800000).toISOString().slice(0, 10); }
export function sessionPct(symbol: string, ce: number, pe: number): { cePct: number | null; pePct: number | null } {
  const date = istDate();
  const b = _totalsBase.get(symbol);
  if (!b || b.date !== date) {
    _totalsBase.set(symbol, { date, ce, pe });
    return { cePct: null, pePct: null }; // first read of the session = baseline
  }
  const cePct = b.ce > 0 ? +(((ce - b.ce) / b.ce) * 100).toFixed(1) : null;
  const pePct = b.pe > 0 ? +(((pe - b.pe) / b.pe) * 100).toFixed(1) : null;
  return { cePct, pePct };
}

// ---- Key OI levels: top-3 CALL-OI strikes (resistance) + top-3 PUT-OI (support) ----
export function buildKeyLevels(oi: OiAnalysis): KeyLevel[] {
  const calls = [...oi.topStrikes].sort((a, b) => b.ceOi - a.ceOi).slice(0, 3);
  const puts = [...oi.topStrikes].sort((a, b) => b.peOi - a.peOi).slice(0, 3);
  const callRoles = ["Call Wall", "Resistance", "Important"];
  const putRoles = ["Put Wall", "Support", "Support"];
  const out: KeyLevel[] = [];
  calls.forEach((s, i) => out.push({
    role: callRoles[i], strike: s.strike, oi: s.ceOi, oiChg: s.ceChg,
    changePct: pctOf(s.ceChg, s.ceOi), interpretation: i === 0 ? "Strong Resistance" : "Resistance", side: "CALL",
  }));
  puts.forEach((s, i) => out.push({
    role: putRoles[i], strike: s.strike, oi: s.peOi, oiChg: s.peChg,
    changePct: pctOf(s.peChg, s.peOi), interpretation: i === 0 ? "Strong Support" : "Support", side: "PUT",
  }));
  return out;
}
function pctOf(chg: number, now: number): number | null {
  const base = now - chg;
  if (base <= 0) return null;
  return +((chg / base) * 100).toFixed(0);
}

function buildConditions(oi: OiAnalysis, kind: "bullish" | "bearish"): string[] {
  const res = oi.resistance, sup = oi.support;
  if (kind === "bullish") {
    const c: string[] = [];
    if (res != null) c.push(`Spot moves above ${res}`);
    c.push("Call OI stops increasing / starts decreasing");
    if (sup != null) c.push(`Put OI unwinds around ${sup}`);
    c.push("PCR (OI) rises above 1.2");
    return c;
  }
  const c: string[] = [];
  if (res != null) c.push(`Spot stays below ${res}`);
  if (res != null) c.push(`Call OI keeps building at/around ${res}`);
  if (sup != null) c.push(`Put OI strong around ${sup}`);
  c.push("PCR (Volume) stays below 1");
  if (sup != null) c.push(`Break of ${sup} can lead to further downside`);
  return c;
}

function buildGuidance(oi: OiAnalysis, bias: string): string[] {
  const g: string[] = [];
  if (oi.resistance != null) g.push(`Immediate Resistance: ${oi.resistance} (high Call OI buildup)`);
  if (oi.support != null) g.push(`Immediate Support: ${oi.support} (high Put OI buildup)`);
  if (oi.support != null) g.push(`If ${oi.support} breaks with rising Put OI → downside may extend`);
  if (oi.resistance != null) g.push(`If ${oi.resistance} breaks with Call OI unwinding → trend may turn up`);
  g.push("Watch OI change over the next 15–30 minutes for confirmation");
  return g;
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
    totalCeOi: 0, totalPeOi: 0, totalCePct: null, totalPePct: null,
    pcr: null, pcrState: "neutral", pcrVolume: null, pcrVolumeState: "neutral",
    spot: null, spotChg: null, spotChgPct: null,
    bias: "Neutral", biasEmoji: "😐", confidencePct: 0, confidenceLabel: "Low",
    evidence: [], callWall: null, putWall: null, supportZone: null, resistanceZone: null,
    maxPain: null, keyLevels: [], directionGuide: "DATA UNAVAILABLE", scenarios: [],
    bullishConditions: [], bearishConditions: [], guidance: [],
  };
}

function fmt(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
