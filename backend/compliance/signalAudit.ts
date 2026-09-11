// ============================ Signal Audit Trail ============================
// Writes ONE durable, append-only compliance record per emitted signal to the
// centralized log's `signal-audit` channel. This is additive and never touches
// the trading engine. Called from the OI-Command builder right after the existing
// (de-duplicated) logOiSignal(), so we do not create duplicate rows on polling.
//
// This is a signal + data-provenance audit. It is NOT an order-execution audit —
// this application places no live orders (see docs/compliance/AUDIT_TRAIL.md).

import * as centralLog from "../log/centralLog";
import { RULE_VERSION } from "./disclosures";

export interface SignalAuditInput {
  symbol: string;
  name: string;
  dataSource: string;        // always "GROWW"
  dataTs: number | null;     // epoch seconds of the market-data snapshot (oiAsOf)
  dataAgeSec: number | null; // freshness at emit
  direction: "UP" | "DOWN";
  optionType: "CE" | "PE";
  strike: number | null;
  entry: number | null;      // option LTP at signal
  stopLoss: number | null;
  target: number | null;     // primary target
  confidence: number | null;
  autoTradeEnabled: boolean;  // simulated paper auto-trade active flag
  orderRef?: string | null;   // null — no live order execution
}

function riskReward(entry: number | null, stop: number | null, target: number | null): number | null {
  if (entry == null || stop == null || target == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!(risk > 0)) return null;
  return Math.round((reward / risk) * 100) / 100;
}

/** Record one compliance audit entry for a newly emitted signal. Best-effort. */
export function auditSignal(s: SignalAuditInput): void {
  try {
    const rr = riskReward(s.entry, s.stopLoss, s.target);
    const signalType = `${s.direction === "UP" ? "BUY " : "BUY "}${s.optionType}`; // BUY CE / BUY PE
    centralLog.write({
      channel: "signal-audit",
      symbol: s.symbol,
      mode: "Directional",
      eventType: "SIGNAL_EMITTED",
      severity: "info",
      summary: `${s.name} ${signalType} ${s.strike ?? "-"} @${s.entry ?? "-"} SL ${s.stopLoss ?? "-"} TGT ${s.target ?? "-"} R:R ${rr ?? "-"} (data ${s.dataAgeSec ?? "-"}s)`,
      payload: {
        instrument: { symbol: s.symbol, name: s.name },
        marketDataSource: s.dataSource,
        dataTs: s.dataTs,
        dataTsIST: s.dataTs ? new Date(s.dataTs * 1000 + 19800000).toISOString().slice(0, 19).replace("T", " ") : null,
        dataAgeSec: s.dataAgeSec,
        ruleVersion: RULE_VERSION,
        signalType,
        direction: s.direction,
        optionType: s.optionType,
        strike: s.strike,
        entry: s.entry,
        stopLoss: s.stopLoss,
        target: s.target,
        riskReward: rr,
        confidence: s.confidence,
        status: "EMITTED",
        autoExecutionEnabled: s.autoTradeEnabled,
        liveOrderExecution: false,
        orderRef: s.orderRef ?? null,
      },
    });
  } catch { /* best-effort: auditing must never break a trading tick */ }
}
