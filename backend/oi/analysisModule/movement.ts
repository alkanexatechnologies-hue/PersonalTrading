// ============================================================================
//  OI ANALYSIS MODULE — OI Movement dashboard assembler  (ADDITIVE)
// ----------------------------------------------------------------------------
//  "What is changing RIGHT NOW?" — the full OI Movement dashboard. Built ONLY
//  from the live Dhan option chain (getOiCached) plus this module's intraday
//  1-minute store; nothing is fabricated. Feeds: the Open-Interest-by-strike
//  chart (with major-move markers + callouts), Top Call/Put OI-change tables,
//  auto-detected Key OI Levels, a multi-window ΔOI% heatmap (1/3/5/15/30-min,
//  which shows "building" until enough history exists), Selected-Strike inputs,
//  live Insights, and the top-bar stats (spot, PCR, totals with session %).
//  Read-only; no orders. Colour: CALL red, PUT green; major increase amber,
//  major decrease purple.
// ============================================================================

import { OiAnalysis } from "../../types";
import { computeOiMovement, OiMoveResult } from "../oiMovement";
import { classifyBuildup, Buildup } from "./classify";
import { recordStrikeSnapshot, strikeDeltas, sampleCount, lastTwoSnapshotTimes, StrikeDelta } from "./intradayStore";
import { sessionPct, buildKeyLevels, KeyLevel } from "./summary";

export type MoveStatus = "Strong Build" | "Build" | "Unwind" | "Flat";

export interface MovementRow {
  strike: number;
  ceOi: number; peOi: number;
  ceDayChg: number; peDayChg: number;
  ceChg: number; peChg: number;         // Δ over the selected window (intraday if available, else day)
  ceChgPct: number; peChgPct: number;
  ceLtp: number | null; peLtp: number | null;
  ceLtpChgPct: number | null; peLtpChgPct: number | null;
  ceVol: number | null; peVol: number | null;
  ceBuildup: Buildup; peBuildup: Buildup;
  ceStatus: MoveStatus; peStatus: MoveStatus;
  majorDir: "up" | "down" | null;        // major-move marker for this strike
  atm: boolean;
}

export interface ActivityRow {
  side: "CALL" | "PUT";
  strike: number;
  oi: number; oiChg: number; oiChgPct: number;
  ltp: number | null; ltpChgPct: number | null;
  buildup: Buildup; status: MoveStatus;
}

export interface Callout {
  strike: number; side: "CE" | "PE";
  oi: number; oiChg: number; oiChgPct: number;
  dir: "up" | "down";
}

export interface HeatCell { pct: number | null; building: boolean; }
export interface HeatRow { strike: number; cells: HeatCell[]; }
export interface Heatmap { windows: number[]; calls: HeatRow[]; puts: HeatRow[]; }

export interface Insight {
  strike: number; side: "CE" | "PE";
  oiChg: number; oiChgPct: number; ltpChgPct: number | null;
  buildup: Buildup; tone: "bullish" | "bearish" | "neutral"; note: string;
}

export interface MovementContext { spot?: number | null; spotChg?: number | null; spotChgPct?: number | null; }

export interface OiMovementView {
  available: boolean;
  message?: string;
  symbol: string;
  underlying: number | null;
  expiry: string | null;
  asOf: number;                 // provider chain timestamp (seconds) — data freshness
  ageSec: number;               // seconds since asOf (staleness)
  source: string;               // "dhan"
  windowMin: number;
  samples: number;
  // Snapshot cadence (honest labelling — the chain refresh, not a true 1-min feed):
  lastSnapshotAt: number | null;   // epoch seconds of the latest 1-min-store snapshot
  prevSnapshotAt: number | null;   // epoch seconds of the previous snapshot
  snapshotGapSec: number | null;   // seconds between the last two snapshots
  // top-bar stats
  spot: number | null; spotChg: number | null; spotChgPct: number | null;
  pcr: number | null;
  pcrState: "bullish" | "bearish" | "neutral";
  pcrVolume: number | null;
  pcrVolumeState: "bullish" | "bearish" | "neutral";
  pcrZone: "extreme-put" | "high" | "balanced" | "low" | "extreme-call";
  pcrNote: string;
  maxPain: number | null;
  totalCeOi: number; totalPeOi: number;
  totalCePct: number | null; totalPePct: number | null;
  aggregate: OiMoveResult;
  rows: MovementRow[];
  callouts: Callout[];
  topCalls: ActivityRow[];
  topPuts: ActivityRow[];
  keyLevels: KeyLevel[];
  heatmap: Heatmap;
  insights: Insight[];
}

const MAJOR_PCT = 15;       // |ΔOI%| for a "major" marker
const STRONG_PCT = 20;      // |ΔOI%| that upgrades a build to "Strong Build"
const HEAT_WINDOWS = [1, 3, 5, 15, 30];

export function buildOiMovement(symbol: string, oi: OiAnalysis | null, windowMin = 1, ctx: MovementContext = {}): OiMovementView {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!oi || !oi.available || !oi.topStrikes?.length) {
    return {
      available: false, message: oi?.message || "OI data unavailable.", symbol,
      underlying: null, expiry: null, asOf: nowSec, ageSec: 0, source: "dhan", windowMin, samples: 0,
      lastSnapshotAt: null, prevSnapshotAt: null, snapshotGapSec: null,
      spot: ctx.spot ?? null, spotChg: ctx.spotChg ?? null, spotChgPct: ctx.spotChgPct ?? null,
      pcr: null, pcrState: "neutral", pcrVolume: null, pcrVolumeState: "neutral",
      pcrZone: "balanced", pcrNote: "DATA UNAVAILABLE", maxPain: null,
      totalCeOi: 0, totalPeOi: 0, totalCePct: null, totalPePct: null,
      aggregate: computeOiMovement(symbol), rows: [], callouts: [], topCalls: [], topPuts: [],
      keyLevels: [], heatmap: { windows: HEAT_WINDOWS, calls: [], puts: [] }, insights: [],
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
  const haveIntra = deltas.some((d) => d.oiChg !== 0);

  const atmStrike = nearestStrike(oi);

  const rows: MovementRow[] = oi.topStrikes.map((s) => {
    const cd = dBy.get(`${s.strike}:CALL`);
    const pd = dBy.get(`${s.strike}:PUT`);
    const ceChg = haveIntra ? (cd?.oiChg ?? 0) : s.ceChg;
    const peChg = haveIntra ? (pd?.oiChg ?? 0) : s.peChg;
    const ceChgPct = haveIntra ? (cd?.oiChgPct ?? 0) : pctOf(s.ceChg, s.ceOi);
    const peChgPct = haveIntra ? (pd?.oiChgPct ?? 0) : pctOf(s.peChg, s.peOi);
    const ceLtpChgPct = ltpPct(cd);
    const peLtpChgPct = ltpPct(pd);
    const ceB = classifyBuildup("CALL", s.ceOi, ceChg, cd?.ltpChg ?? signHint(s.ceChg)).buildup;
    const peB = classifyBuildup("PUT", s.peOi, peChg, pd?.ltpChg ?? signHint(s.peChg)).buildup;
    const majorDir = majorOf(ceChgPct, peChgPct);
    return {
      strike: s.strike, ceOi: s.ceOi, peOi: s.peOi,
      ceDayChg: s.ceChg, peDayChg: s.peChg, ceChg, peChg, ceChgPct, peChgPct,
      ceLtp: s.ceLtp ?? null, peLtp: s.peLtp ?? null, ceLtpChgPct, peLtpChgPct,
      ceVol: s.ceVol ?? null, peVol: s.peVol ?? null,
      ceBuildup: ceB, peBuildup: peB,
      ceStatus: statusOf(ceB, ceChgPct), peStatus: statusOf(peB, peChgPct),
      majorDir, atm: s.strike === atmStrike,
    };
  });

  // Activity tables — biggest OI moves this window.
  const calls: ActivityRow[] = rows.map((r) => ({
    side: "CALL", strike: r.strike, oi: r.ceOi, oiChg: r.ceChg, oiChgPct: r.ceChgPct,
    ltp: r.ceLtp, ltpChgPct: r.ceLtpChgPct, buildup: r.ceBuildup, status: r.ceStatus,
  }));
  const puts: ActivityRow[] = rows.map((r) => ({
    side: "PUT", strike: r.strike, oi: r.peOi, oiChg: r.peChg, oiChgPct: r.peChgPct,
    ltp: r.peLtp, ltpChgPct: r.peLtpChgPct, buildup: r.peBuildup, status: r.peStatus,
  }));
  const topCalls = [...calls].sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 5);
  const topPuts = [...puts].sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 5);

  // Callouts — the largest moves across both sides, for on-chart labels.
  const allMoves: Callout[] = [];
  rows.forEach((r) => {
    allMoves.push({ strike: r.strike, side: "CE", oi: r.ceOi, oiChg: r.ceChg, oiChgPct: r.ceChgPct, dir: r.ceChg >= 0 ? "up" : "down" });
    allMoves.push({ strike: r.strike, side: "PE", oi: r.peOi, oiChg: r.peChg, oiChgPct: r.peChgPct, dir: r.peChg >= 0 ? "up" : "down" });
  });
  const callouts = allMoves.filter((c) => Math.abs(c.oiChgPct) >= (haveIntra ? 8 : 5))
    .sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 6);

  // Insights — top movers with buildup interpretation.
  const insights: Insight[] = [...topCalls.map((a) => toInsight(a)), ...topPuts.map((a) => toInsight(a))]
    .sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg)).slice(0, 5);

  return {
    available: true, symbol, underlying: oi.underlying, expiry: oi.expiry,
    asOf: oi.asOf, ageSec: Math.max(0, nowSec - oi.asOf), source: "dhan", windowMin, samples: sampleCount(symbol),
    ...snapSnap(symbol),
    spot: ctx.spot ?? oi.underlying, spotChg: ctx.spotChg ?? null, spotChgPct: ctx.spotChgPct ?? null,
    pcr: oi.pcr, pcrState: oi.pcrState,
    ...pcrDetail(oi.pcr), pcrVolume: pcrVol(oi).v, pcrVolumeState: pcrVol(oi).s,
    maxPain: oi.maxPain, totalCeOi: oi.totalCeOi, totalPeOi: oi.totalPeOi,
    ...sessionTotals(symbol, oi),
    aggregate: computeOiMovement(symbol),
    rows, callouts, topCalls, topPuts,
    keyLevels: buildKeyLevels(oi),
    heatmap: buildHeatmap(symbol, oi),
    insights,
  };
}

function snapSnap(symbol: string): { lastSnapshotAt: number | null; prevSnapshotAt: number | null; snapshotGapSec: number | null } {
  const t = lastTwoSnapshotTimes(symbol);
  return { lastSnapshotAt: t.last, prevSnapshotAt: t.prev, snapshotGapSec: t.last != null && t.prev != null ? t.last - t.prev : null };
}

function sessionTotals(symbol: string, oi: OiAnalysis): { totalCePct: number | null; totalPePct: number | null } {
  const p = sessionPct(symbol, oi.totalCeOi, oi.totalPeOi);
  return { totalCePct: p.cePct, totalPePct: p.pePct };
}

// Multi-window ΔOI% heatmap. A cell is "building" until the window has enough
// covered history; then it shows the real windowed ΔOI% (never fabricated).
function buildHeatmap(symbol: string, oi: OiAnalysis): Heatmap {
  const underlying = oi.underlying;
  const perWindow = HEAT_WINDOWS.map((w) => ({ w, deltas: strikeDeltas(symbol, w) }));
  // Day OI-change (since prev close) per strike — the honest fallback for any
  // intraday window that hasn't accumulated enough 1-min history yet.
  const dayBy = new Map<number, { ceOi: number; peOi: number; ceChg: number; peChg: number }>();
  oi.topStrikes.forEach((s) => dayBy.set(s.strike, { ceOi: s.ceOi, peOi: s.peOi, ceChg: s.ceChg, peChg: s.peChg }));
  const strikeSet = new Set<number>();
  perWindow[0].deltas.forEach((d) => strikeSet.add(d.strike));
  if (strikeSet.size === 0) oi.topStrikes.forEach((s) => strikeSet.add(s.strike)); // before any sample
  let strikes = Array.from(strikeSet).sort((a, b) => b - a); // high → low (as in the mockup)
  // Keep the ~9 strikes nearest ATM so the heatmap fits one laptop screen.
  const HEAT_ROWS = 9;
  if (underlying != null && strikes.length > HEAT_ROWS) {
    strikes = [...strikes].sort((a, b) => Math.abs(a - underlying) - Math.abs(b - underlying)).slice(0, HEAT_ROWS).sort((a, b) => b - a);
  } else if (strikes.length > HEAT_ROWS) {
    strikes = strikes.slice(0, HEAT_ROWS);
  }
  const rowFor = (side: "CALL" | "PUT"): HeatRow[] => strikes.map((st) => {
    const day = dayBy.get(st);
    const dayPct = day ? pctOf(side === "CALL" ? day.ceChg : day.peChg, side === "CALL" ? day.ceOi : day.peOi) : null;
    return {
      strike: st,
      cells: perWindow.map(({ w, deltas }) => {
        const d = deltas.find((x) => x.strike === st && x.side === side);
        // Intraday window with enough coverage → real windowed ΔOI%.
        if (d && d.windowMin >= w * 0.5) return { pct: d.oiChgPct, building: false };
        // Otherwise show the day ΔOI% (since prev close), marked building/dimmed.
        return { pct: dayPct, building: true };
      }),
    };
  });
  return { windows: HEAT_WINDOWS, calls: rowFor("CALL"), puts: rowFor("PUT") };
}

function toInsight(a: ActivityRow): Insight {
  const side: "CE" | "PE" = a.side === "CALL" ? "CE" : "PE";
  const bullBear = insightTone(a.side, a.buildup);
  return {
    strike: a.strike, side, oiChg: a.oiChg, oiChgPct: a.oiChgPct, ltpChgPct: a.ltpChgPct,
    buildup: a.buildup, tone: bullBear, note: insightNote(a.side, a.buildup),
  };
}
function insightTone(side: "CALL" | "PUT", b: Buildup): "bullish" | "bearish" | "neutral" {
  if (b === "Flat") return "neutral";
  if (side === "CALL") return (b === "Short Buildup") ? "bearish" : (b === "Short Covering" || b === "Long Buildup") ? "bullish" : "bearish";
  return (b === "Short Buildup") ? "bullish" : (b === "Long Buildup" || b === "Short Covering") ? "bearish" : "bullish";
}
function insightNote(side: "CALL" | "PUT", b: Buildup): string {
  if (side === "CALL") {
    if (b === "Short Buildup") return "Strong Call-side build-up → Resistance zone";
    if (b === "Short Covering") return "Call OI unwinding → Resistance weakening";
    if (b === "Long Buildup") return "Call buyers adding → upside bet";
    if (b === "Long Unwinding") return "Call longs exiting";
  } else {
    if (b === "Short Buildup") return "Strong Put-side build-up → Support zone";
    if (b === "Short Covering") return "Put OI unwinding → Support weakening";
    if (b === "Long Buildup") return "Put buyers adding → downside bet";
    if (b === "Long Unwinding") return "Put longs exiting → Support strengthening";
  }
  return "No decisive flow";
}

// PCR interpretation — zone + a plain-language note. Standard reading: a high
// PCR means puts dominate (support/floor building → bullish bias; very high can
// be an oversold reversal signal); a low PCR means calls dominate (resistance/
// cap → bearish bias; very low can be overbought). ~1.0 = balanced, no edge.
function pcrDetail(pcr: number | null): { pcrZone: OiMovementView["pcrZone"]; pcrNote: string } {
  if (pcr == null) return { pcrZone: "balanced", pcrNote: "DATA UNAVAILABLE" };
  if (pcr >= 1.6) return { pcrZone: "extreme-put", pcrNote: `PCR ${pcr.toFixed(2)} — very high: puts heavily outweigh calls. Strong support bias, but stretched — watch for an oversold bounce/reversal.` };
  if (pcr >= 1.2) return { pcrZone: "high", pcrNote: `PCR ${pcr.toFixed(2)} — put writers dominant: support building below. Bias leans bullish while it holds.` };
  if (pcr >= 0.8) return { pcrZone: "balanced", pcrNote: `PCR ${pcr.toFixed(2)} — balanced: puts and calls roughly matched. No clear directional edge from options positioning.` };
  if (pcr >= 0.5) return { pcrZone: "low", pcrNote: `PCR ${pcr.toFixed(2)} — call writers dominant: resistance building above. Bias leans bearish while it holds.` };
  return { pcrZone: "extreme-call", pcrNote: `PCR ${pcr.toFixed(2)} — very low: calls heavily outweigh puts. Strong resistance bias, but stretched — watch for an overbought fade/reversal.` };
}
function pcrVol(oi: OiAnalysis): { v: number | null; s: "bullish" | "bearish" | "neutral" } {
  let ceV = 0, peV = 0, have = false;
  for (const st of oi.topStrikes) { if (st.ceVol != null) { ceV += st.ceVol; have = true; } if (st.peVol != null) { peV += st.peVol; have = true; } }
  if (!have || ceV <= 0) return { v: null, s: "neutral" };
  const r = +(peV / ceV).toFixed(2);
  return { v: r, s: r > 1.1 ? "bullish" : r < 0.9 ? "bearish" : "neutral" };
}

function statusOf(b: Buildup, oiChgPct: number): MoveStatus {
  if (b === "Long Buildup" || b === "Short Buildup") return Math.abs(oiChgPct) >= STRONG_PCT ? "Strong Build" : "Build";
  if (b === "Short Covering" || b === "Long Unwinding") return "Unwind";
  return "Flat";
}
function majorOf(cePct: number, pePct: number): "up" | "down" | null {
  const bigger = Math.abs(cePct) >= Math.abs(pePct) ? cePct : pePct;
  if (bigger >= MAJOR_PCT) return "up";
  if (bigger <= -MAJOR_PCT) return "down";
  return null;
}
function ltpPct(d: StrikeDelta | undefined): number | null {
  if (!d || d.ltpNow == null) return null;
  const base = d.ltpNow - d.ltpChg;
  if (base <= 0) return null;
  return +((d.ltpChg / base) * 100).toFixed(1);
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
