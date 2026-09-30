// ============================================================================
//  OI ANALYSIS MODULE — OI Movement assembler  (ADDITIVE)
// ----------------------------------------------------------------------------
//  Answers "what is changing RIGHT NOW?" for the OI Movement screen. Combines
//  the already-fetched OiAnalysis chain (getOiCached: per-strike ceOi/peOi/ceChg/
//  peChg/ceLtp/peLtp) with this module's intraday 1-minute store to produce a
//  strike-wise table (day ΔOI + intraday ΔOI/ΔOI%, LTP, buildup), Top Call /
//  Top Put activity, and surge alerts. Reuses the existing computeOiMovement()
//  for the 5M/15M aggregate header. Read-only; no orders. Colour: CALL red, PUT green.
// ============================================================================

import { OiAnalysis } from "../../types";
import { computeOiMovement, OiMoveResult } from "../oiMovement";
import { classifyBuildup, detectSurge, Buildup } from "./classify";
import { recordStrikeSnapshot, strikeDeltas, sampleCount, StrikeDelta } from "./intradayStore";

export interface MovementRow {
  strike: number;
  ceOi: number;
  peOi: number;
  ceDayChg: number;    // Δ since prior close (from the chain)
  peDayChg: number;
  ceIntraChg: number;  // Δ over the intraday window (from our 1-min store)
  peIntraChg: number;
  ceIntraPct: number;
  peIntraPct: number;
  ceLtp: number | null;
  peLtp: number | null;
  ceBuildup: Buildup;
  peBuildup: Buildup;
  atm: boolean;
}

export interface ActivityRow {
  side: "CALL" | "PUT";
  strike: number;
  oi: number;
  oiChg: number;
  oiChgPct: number;
  ltp: number | null;
  buildup: Buildup;
}

export interface SurgeAlert {
  side: "CALL" | "PUT";
  strike: number;
  severity: "notable" | "strong" | "extreme";
  message: string;
}

export interface OiMovementView {
  available: boolean;
  message?: string;
  symbol: string;
  underlying: number | null;
  expiry: string | null;
  asOf: number;
  windowMin: number;
  samples: number;
  aggregate: OiMoveResult;      // reused 5M/15M judge
  rows: MovementRow[];
  topCalls: ActivityRow[];      // biggest CALL OI adds
  topPuts: ActivityRow[];       // biggest PUT OI adds
  surges: SurgeAlert[];
}

// Record the current chain into the intraday store, then build the view.
export function buildOiMovement(symbol: string, oi: OiAnalysis | null, windowMin = 5): OiMovementView {
  if (!oi || !oi.available || !oi.topStrikes?.length) {
    return {
      available: false, message: oi?.message || "OI data unavailable.", symbol,
      underlying: null, expiry: null, asOf: Date.now(), windowMin, samples: 0,
      aggregate: computeOiMovement(symbol), rows: [], topCalls: [], topPuts: [], surges: [],
    };
  }

  // Feed the 1-minute store (deduped internally on asOf + cadence).
  recordStrikeSnapshot(
    symbol, oi.asOf, oi.underlying,
    oi.topStrikes.map((s) => ({ strike: s.strike, ceOi: s.ceOi, peOi: s.peOi, ceLtp: s.ceLtp ?? null, peLtp: s.peLtp ?? null }))
  );

  const deltas = strikeDeltas(symbol, windowMin);
  const dBy = new Map<string, StrikeDelta>();
  deltas.forEach((d) => dBy.set(`${d.strike}:${d.side}`, d));

  const atmStrike = nearestStrike(oi);

  const rows: MovementRow[] = oi.topStrikes.map((s) => {
    const cd = dBy.get(`${s.strike}:CALL`);
    const pd = dBy.get(`${s.strike}:PUT`);
    // Prefer intraday LTP change from the store; fall back to day change sign.
    const ceLtpChg = cd?.ltpChg ?? 0;
    const peLtpChg = pd?.ltpChg ?? 0;
    const ceIntraChg = cd?.oiChg ?? 0;
    const peIntraChg = pd?.oiChg ?? 0;
    // Buildup: use intraday flow if we have any, else the chain's day change.
    const ceB = classifyBuildup("CALL", s.ceOi, ceIntraChg !== 0 ? ceIntraChg : s.ceChg, ceLtpChg !== 0 ? ceLtpChg : signHint(s.ceChg)).buildup;
    const peB = classifyBuildup("PUT", s.peOi, peIntraChg !== 0 ? peIntraChg : s.peChg, peLtpChg !== 0 ? peLtpChg : signHint(s.peChg)).buildup;
    return {
      strike: s.strike, ceOi: s.ceOi, peOi: s.peOi,
      ceDayChg: s.ceChg, peDayChg: s.peChg,
      ceIntraChg, peIntraChg,
      ceIntraPct: cd?.oiChgPct ?? 0, peIntraPct: pd?.oiChgPct ?? 0,
      ceLtp: s.ceLtp ?? null, peLtp: s.peLtp ?? null,
      ceBuildup: ceB, peBuildup: peB,
      atm: s.strike === atmStrike,
    };
  });

  // Activity ranking — biggest OI adds this window (intraday if present, else day).
  const useIntra = deltas.length > 0 && deltas.some((d) => d.oiChg !== 0);
  const calls: ActivityRow[] = rows.map((r) => ({
    side: "CALL" as const, strike: r.strike, oi: r.ceOi,
    oiChg: useIntra ? r.ceIntraChg : r.ceDayChg,
    oiChgPct: useIntra ? r.ceIntraPct : pctOf(r.ceDayChg, r.ceOi),
    ltp: r.ceLtp, buildup: r.ceBuildup,
  }));
  const puts: ActivityRow[] = rows.map((r) => ({
    side: "PUT" as const, strike: r.strike, oi: r.peOi,
    oiChg: useIntra ? r.peIntraChg : r.peDayChg,
    oiChgPct: useIntra ? r.peIntraPct : pctOf(r.peDayChg, r.peOi),
    ltp: r.peLtp, buildup: r.peBuildup,
  }));
  const topCalls = [...calls].sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 5);
  const topPuts = [...puts].sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 5);

  // Surge alerts — only from genuine intraday windows (avoid day-change noise).
  const surges: SurgeAlert[] = [];
  for (const d of deltas) {
    if (d.oiChg === 0 || d.windowMin < 1) continue;
    const r = detectSurge({ side: d.side, strike: d.strike, oiNow: d.oiNow, oiChg: d.oiChg, windowMin: d.windowMin, ltpChg: d.ltpChg });
    if (r.surge && r.severity !== "none") {
      surges.push({ side: d.side, strike: d.strike, severity: r.severity as SurgeAlert["severity"], message: r.message });
    }
  }
  surges.sort((a, b) => sev(b.severity) - sev(a.severity));

  return {
    available: true, symbol, underlying: oi.underlying, expiry: oi.expiry, asOf: oi.asOf,
    windowMin, samples: sampleCount(symbol),
    aggregate: computeOiMovement(symbol),
    rows, topCalls, topPuts, surges: surges.slice(0, 8),
  };
}

function nearestStrike(oi: OiAnalysis): number | null {
  if (oi.underlying == null || !oi.topStrikes.length) return null;
  return oi.topStrikes.reduce((best, s) =>
    Math.abs(s.strike - oi.underlying!) < Math.abs(best - oi.underlying!) ? s.strike : best,
    oi.topStrikes[0].strike);
}
function pctOf(chg: number, now: number): number {
  const base = now - chg;
  if (base <= 0) return 0;
  return +((chg / base) * 100).toFixed(2);
}
function signHint(oiChg: number): number { return oiChg > 0 ? 1 : oiChg < 0 ? -1 : 0; }
function sev(s: string): number { return s === "extreme" ? 3 : s === "strong" ? 2 : 1; }
