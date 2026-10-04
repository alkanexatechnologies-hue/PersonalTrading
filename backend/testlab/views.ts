// SINGLE SOURCE OF TRUTH for every Lab panel. All screen views (chart markers,
// signals table, trades table, results metrics, daily table, Final Signal) are
// derived here from ONE runDecisionLayer result, so no panel can disagree with
// another for the same candle. The legacy engines' numbers are exposed only
// under explicit `legacy*` names for comparison.
//
// Option-buyer view: a bullish signal is BUY CE (buy a CALL), a bearish signal is
// BUY PE (buy a PUT). `signal` keeps BUY / SELL only as the direction code the
// chart/CSS use; `action` is the label shown to the trader.

import { AuditRow, DecisionResult, DecisionRow, RunResult } from "./types";

export interface SignalView {
  iso: string; timestamp: number; spotPrice: number;
  signal: "BUY" | "SELL"; action: "BUY CE" | "BUY PE";
  buyScore: number | null; sellScore: number | null;
  entry: number; stopLoss: number; target1: number; target2: number; rr: number; rrStatus: "GOOD" | "WARNING" | null;
  strike: number | null; optionType: "CE" | "PE"; altStrike: number | null;
  optionLtp: number | null; optionSl: number | null; optionT1: number | null;
  regime15: string; movementState: string; gamma: string | null; oiStatus: string; liquidity: string | null;
  primaryReason: string; outcome: string; rMultiple: number | null; timingClassification: string;
  fill: number | null; optionFill: number | null; optionExit: number | null; optionPnl: number | null;
}

export const actionOf = (r: DecisionRow): "BUY CE" | "BUY PE" | "WAIT" => r.finalAction;

export function signalView(r: DecisionRow, eng?: AuditRow): SignalView {
  const p = r.plan!, o = r.option;
  return {
    iso: r.iso, timestamp: r.timestamp, spotPrice: r.price,
    signal: p.side, action: p.side === "BUY" ? "BUY CE" : "BUY PE",
    buyScore: eng?.buyScore ?? null, sellScore: eng?.sellScore ?? null,
    entry: p.entry, stopLoss: p.stopLoss, target1: p.target1, target2: p.target2, rr: p.rr, rrStatus: r.rrStatus,
    strike: o?.primary?.strike ?? null, optionType: p.side === "BUY" ? "CE" : "PE", altStrike: o?.alternative?.strike ?? null,
    optionLtp: o?.optionEntry ?? null, optionSl: o?.optionStop ?? null, optionT1: o?.optionTarget ?? null,
    regime15: r.regime15, movementState: r.movementState, gamma: r.gamma ? `${r.gamma.state} ${r.gamma.score}/10` : null,
    oiStatus: r.oiStatusLabel, liquidity: r.liquidityGrade,
    primaryReason: `${r.movementState.replace(/_/g, " ")} · 15M ${r.regime15}${r.movementEvidence.length ? " · " + r.movementEvidence.join("; ") : ""}`,
    outcome: r.outcome, rMultiple: r.rMultiple, timingClassification: r.timingClassification,
    fill: r.fillPrice, optionFill: r.optionFill, optionExit: r.optionExit, optionPnl: r.optionPnl,
  };
}

export interface LabViews {
  chart: Array<RunResult["chart"][number] & { action: "BUY CE" | "BUY PE" | "WAIT"; legacySignal: string }>;
  signals: SignalView[];          // every BUY CE / BUY PE the decision layer gave
  trades: SignalView[];           // the signals that became trades (filled), with outcomes
  metrics: DecisionResult["metrics"];
  daily: DecisionResult["daily"];
  gateBlocks: Record<string, number>;
  final: { latest: DecisionRow | null; lastSignal: SignalView | null };
}

export function labViews(r: RunResult): LabViews | null {
  const d = r.decision;
  if (!d) return null;
  const byT = new Map(d.rows.map((x) => [x.timestamp, x]));
  const engByT = new Map(r.rows.map((x) => [x.timestamp, x]));
  const chart = r.chart.map((c) => {
    const x = byT.get(c.t);
    const action = x ? actionOf(x) : "WAIT";
    return { ...c, signal: (action === "BUY CE" ? "BUY" : action === "BUY PE" ? "SELL" : "WAIT") as "BUY" | "SELL" | "WAIT", action, legacySignal: c.signal };
  });
  const sigRows = d.rows.filter((x) => x.finalAction !== "WAIT" && x.plan);
  const signals = sigRows.map((x) => signalView(x, engByT.get(x.timestamp)));
  const trades = signals.filter((s) => s.fill != null);
  const latest = d.rows.length ? d.rows[d.rows.length - 1] : null;
  return {
    chart, signals, trades, metrics: d.metrics, daily: d.daily, gateBlocks: d.summary.blocks,
    final: { latest, lastSignal: signals.length ? signals[signals.length - 1] : null },
  };
}
