// Final trade card for one decision row (text form, shared by the CLI and API).
// Field order follows the BUY CE / BUY PE card spec. Movement is always shown,
// even when a NON-R:R check blocks the trade. R:R is information only.

import { DecisionRow } from "./types";

const v = (x: number | null | undefined, d = 2) => (x == null ? "DATA UNAVAILABLE" : x.toFixed(d));
const human = (s: string) => s.replace(/_/g, " ");

export function decisionCard(r: DecisionRow, index: string, seriesLabel: string): string {
  const L: string[] = [];
  const p = r.plan;
  const signal = p && r.action === "TAKE" ? (p.side === "BUY" ? "BUY CE" : "BUY PE") : "WAIT";
  const row = (k: string, val: string) => L.push(`${k.padEnd(21)}: ${val}`);
  row("ACTION", signal);
  row("INDEX", `${index}   (${r.iso}; ${seriesLabel})`);
  row("15M REGIME", `${r.regime15}${r.ctx15 ? ` — ${r.ctx15.master}, EMA ${r.ctx15.ema}, VWAP ${r.ctx15.vwapSide}, ${r.ctx15.trend}, momentum ${r.ctx15.momentum} (last closed 15M candle ${r.ctx15.barIso.slice(0, 10) === r.date ? r.ctx15.barIso.slice(11, 16) : r.ctx15.barIso.slice(5, 16) + " — previous session"})` : " — no closed 15M candle yet"}`);
  row("5M MOVEMENT", `${human(r.movementState)} (${r.movementDirection}, evidence ${r.movementScore}/100)`);
  if (r.movementEvidence.length) row("  evidence", r.movementEvidence.join("; "));
  if (r.contextWarning) row("  ⚠ context", r.contextWarning);
  if (r.noTradeZone) row("NO-TRADE ZONE", `${r.noTradeZone.low}–${r.noTradeZone.high}${r.zoneInvalidated ? " (INVALIDATED by this break)" : ""}`);
  if (!p) { row("FINAL", `WAIT (${r.executionState})`); return L.join("\n"); }
  const spotEq = (x: number) => (p.basis != null ? ` (spot ≈ ${(x - p.basis).toFixed(2)})` : "");
  const o = r.option;
  row(p.side === "BUY" ? "BREAKOUT LEVEL" : "BREAKDOWN LEVEL", `${p.invalidation}${spotEq(p.invalidation)}`);
  row("ENTRY (index)", `${p.entry}${spotEq(p.entry)}   (candle close; fill = next candle open)`);
  row("STOP LOSS (index)", `${p.stopLoss}${spotEq(p.stopLoss)}   (${p.invalidationSource})`);
  row("TARGET 1 (index)", `${p.target1}${spotEq(p.target1)}   (${p.target1Source})`);
  row("TARGET 2 (index)", `${p.target2}${spotEq(p.target2)}   (${p.target2Source})`);
  row("PRIMARY STRIKE", o?.primary ? `${o.primary.strike} ${o.optionType}   (rank ${o.primary.score}, Δ ${o.primary.delta}, IV ${o.primary.iv?.toFixed(1)}%)` : `DATA UNAVAILABLE${o?.reason ? " — " + o.reason : ""}`);
  row("ALTERNATIVE STRIKE", o?.alternative ? `${o.alternative.strike} ${o.optionType}   (rank ${o.alternative.score})` : o?.primary ? "none eligible" : "DATA UNAVAILABLE");
  row("OPTION ENTRY LTP", o?.optionEntry != null ? `₹${o.optionEntry.toFixed(2)}` : "DATA UNAVAILABLE");
  row("OPTION SL", o?.optionStop != null ? `₹${o.optionStop.toFixed(2)}   (model reprice at index SL)` : "DATA UNAVAILABLE");
  row("OPTION TARGET 1", o?.optionTarget != null ? `₹${o.optionTarget.toFixed(2)}   (model reprice at index T1)` : "DATA UNAVAILABLE");
  row("OPTION TARGET 2", "NOT CALCULATED by the existing engine");
  const g = r.gamma;
  row("GAMMA", g ? `${g.side === "CE" ? "CALL" : "PUT"} ${g.state}   (score ${g.score}/10)` : "DATA UNAVAILABLE");
  row("OI STATUS", `${r.oiStatusLabel}   (${r.oiStatus}${r.oiAgeBars ? `, ${r.oiAgeBars} candle(s) old` : ""} · ${r.oiConfirmation} · ${r.oiValidation.state})`);
  row("LIQUIDITY", r.liquidityGrade ?? "DATA UNAVAILABLE");
  row("R:R", `${p.rr.toFixed(2)}`);
  row("R:R STATUS", `${r.rrStatus ?? "—"} — information only, never blocks${p.rrWarning ? "   " + p.rrWarning : ""}`);
  row("FINAL ACTION", signal === "WAIT" ? `WAIT — ${human(r.executionState)}${r.blockReason ? ": " + r.blockReason : ""}` : signal);
  row("NEXT RESISTANCE", p.nextResistance.length ? p.nextResistance.join(", ") : "none in view");
  row("NEXT SUPPORT", p.nextSupport.length ? p.nextSupport.join(", ") : "none in view");
  row("REVERSAL RISK", r.reversalRisk ? `${r.reversalRisk.level}${r.reversalRisk.factors.length ? " — " + r.reversalRisk.factors.join("; ") : ""}` : "—");
  if (r.guardState) row("DIRECTION GUARD", `${r.guardState}${r.directionConflictReason ? " — " + r.directionConflictReason : ""}`);
  if (r.supportResistanceEvent) row("S/R EVENT", `${r.supportResistanceEvent} at ${r.supportResistanceLevel} (${r.rejectionType}; ${r.rejectionStatus})`);
  if (o?.primary) row("  strike reason", o.selectionReason);
  if (r.blockReasons.length > 1) row("  all reasons", r.blockReasons.join(" | "));
  if (r.outcome === "OPEN") row("STATUS", `OPEN — filled ${r.fillPrice} at the next open; still running`);
  else if (r.outcome !== "NONE") row("OUTCOME (after)", `filled ${r.fillPrice} → ${r.outcome} at ${r.exitPrice} (${r.rMultiple}R) ${r.exitIso ?? ""}`);
  return L.join("\n");
}
