// Writes the EXPORT REVIEW PACKAGE to a fresh timestamped run dir (never
// overwrites). All research artifacts; NEVER contains the access token/secret.

import fs from "fs";
import path from "path";
import { AuditRow, RunResult } from "./types";

function ts(): string {
  const d = new Date(Date.now() + 19800000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function csv(rows: any[], cols: string[]): string {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export function writeReviewPackage(result: RunResult): string {
  const base = path.resolve(process.cwd(), "data", "test-zone", "universal-indicator", `run-${ts()}`);
  fs.mkdirSync(base, { recursive: true });
  const w = (name: string, content: string) => fs.writeFileSync(path.join(base, name), content, "utf8");

  const m = result.metrics;
  w("test-config.json", JSON.stringify(result.config, null, 2));
  w("data-validation.json", JSON.stringify({
    binding: result.binding, oiStatus: result.oiStatus, dataQuality: result.dataQuality,
    dataRange: result.dataRange,
  }, null, 2));
  w("summary.json", JSON.stringify({
    config: result.config, binding: result.binding, dataRange: result.dataRange,
    oiStatus: result.oiStatus, dataQuality: result.dataQuality, metrics: m,
  }, null, 2));
  w("indicator-analysis.json", JSON.stringify({
    timing: m.timing, outcomes: m.outcomes,
    avgComponents: avgComponents(result.rows),
    regimes: regimeBreakdown(result.rows),
  }, null, 2));
  w("gate-analysis.json", JSON.stringify({ gateBlocks: result.gateBlocks, waits: m.wait }, null, 2));

  w("daily-results.csv", csv(result.daily.map((d) => ({
    date: d.date, regime: d.regime, buy: d.buy, sell: d.sell, wait: d.wait,
    trades: d.trades, wins: d.wins, losses: d.losses, avgR: d.avgR, dailyR: d.dailyR,
    maxIntradayDDR: d.maxIntradayDDR, early: d.timing.EARLY, timely: d.timing.TIMELY, late: d.timing.LATE,
    false_: d.timing.FALSE, expiryDay: d.expiryDay, dqIssues: d.dataQualityIssues,
  })), ["date", "regime", "buy", "sell", "wait", "trades", "wins", "losses", "avgR", "dailyR", "maxIntradayDDR", "early", "timely", "late", "false_", "expiryDay", "dqIssues"]));

  const sigCols = ["iso", "spotPrice", "signal", "buyScore", "sellScore", "entry", "stopLoss", "target1", "target2", "rr", "primaryReason", "outcome", "rMultiple", "timingClassification"];
  const signals = result.rows.filter((r) => r.signal !== "WAIT");
  w("signals.csv", csv(signals, sigCols));
  w("signals.jsonl", signals.map((r) => JSON.stringify(r)).join("\n"));
  w("trades.csv", csv(result.trades, ["iso", "signal", "entry", "stopLoss", "target1", "target2", "rr", "entryTimestamp", "exitTimestamp", "exitPrice", "outcome", "rMultiple", "mfe", "mae", "holdBars", "timingClassification", "fillAmbiguity"]));
  w("audit.jsonl", result.rows.map((r) => JSON.stringify(r)).join("\n"));

  w("implementation-diff.md", implementationDiff(result));
  w("README.md", readme(result, base));
  return base;
}

function avgComponents(rows: AuditRow[]) {
  const keys = ["trend", "structure", "participation", "momentum", "volatility"] as const;
  const out: Record<string, number> = {};
  keys.forEach((k) => { out[k] = +(rows.reduce((a, r) => a + (r.components[k] || 0), 0) / Math.max(1, rows.length)).toFixed(1); });
  return out;
}
function regimeBreakdown(rows: AuditRow[]) {
  const m: Record<string, number> = {};
  rows.forEach((r) => { m[r.regime] = (m[r.regime] || 0) + 1; });
  return m;
}

function readme(r: RunResult, dir: string): string {
  const m = r.metrics;
  return `# Universal Indicator Test Lab — Run

Generated: ${new Date().toISOString()}
Directory: ${dir}

RESEARCH / AUDIT ONLY — no orders, no auto-execution, no parameter optimization.
Strict no-lookahead: each signal uses only candles up to its own closed candle;
entry is the next candle's open; outcomes are a forward walk (never fed back).

## Scope
- Index: ${r.config.index}
- Timeframe: ${r.config.timeframe}
- Data range: ${r.dataRange.from} → ${r.dataRange.to} (${r.dataRange.totalCandles} candles, ${r.dataRange.rejected} rejected)
- Futures binding: ${r.binding.status} — ${r.binding.bindingReason}
- Signal series VWAP source: ${r.rows[0]?.vwapSource ?? "—"}
- OI status: ${r.oiStatus}
- Data quality: ${r.dataQuality}

## Result
- BUY ${m.buy} / SELL ${m.sell} / WAIT ${m.wait}
- Trades ${m.totalTrades} | Win% ${m.winRate} | Avg R ${m.avgR} | Expectancy ${m.expectancy} | PF ${m.profitFactor} | MaxDD ${m.maxDrawdownR}R
- Timing: EARLY ${m.timing.EARLY} TIMELY ${m.timing.TIMELY} LATE ${m.timing.LATE} FALSE ${m.timing.FALSE} MISSED ${m.timing.MISSED}

## Files
test-config.json, data-validation.json, summary.json, indicator-analysis.json,
gate-analysis.json, daily-results.csv, signals.csv, signals.jsonl, trades.csv,
audit.jsonl, implementation-diff.md

Win rate alone is not a verdict — review expectancy, average R, profit factor,
drawdown, MFE/MAE and signal timing together.
`;
}

function implementationDiff(r: RunResult): string {
  return `# Implementation Deviation Report

Format: REQUIREMENT / STATUS / REASON / CURRENT IMPLEMENTATION / IMPACT

1. 1-minute & 3-minute timeframes
   STATUS: PARTIAL
   REASON: Dhan /charts/intraday supports native minutes 1,5,15,25,60 (not 3).
   CURRENT: 1m/5m/15m/25m/60m native; 3m is resampled from fetched 1m candles.
   IMPACT: 3m is derived, not exchange-native (OHLC aggregation is standard).

2. Historical per-candle OI (section 5)
   STATUS: ${r.oiStatus === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE (this run)"}
   REASON: Empirically probed Dhan derivative /charts/intraday with oi:true.
   CURRENT: OI stored/used when the feed returns it; otherwise OI_STATUS=UNAVAILABLE.
            Live option-chain OI is NEVER substituted for historical OI.
   IMPACT: ${r.oiStatus === "AVAILABLE" ? "OI participation usable." : "OI-based evidence inactive this run; signals use price/structure/volume only."}

3. Historical futures binding for EXPIRED contracts (section 6)
   STATUS: ${r.binding.status === "RESOLVED" ? "RESOLVED (this run)" : "PARTIAL"}
   REASON: The Dhan scrip master lists only currently-tradeable contracts; a
           month that already expired is absent, so its securityId can't be
           resolved for past dates.
   CURRENT: Binding resolved at the window-end date; if the correct contract is
           unavailable, config.futuresBinding='strict' => WAIT, 'spot-fallback'
           => index SPOT series (vwapSource=SPOT, OI UNAVAILABLE). This run: ${r.binding.status}.
   IMPACT: For long/old windows the exact front-month per day may differ; V1 uses
           a single contiguous series (no multi-expiry stitching). Reported, not faked.

4. Multi-expiry stitching across long windows
   STATUS: NOT IMPLEMENTED (V1)
   REASON: V1 fetches one contiguous series for the window.
   CURRENT: One binding/series per run.
   IMPACT: "Full history" futures continuity across many expiries is a future item.

5. Candle Replay / full charting UI (sections 38,42)
   STATUS: PARTIAL (if UI shipped minimal) — engine is replay-exact (candle-by-candle, causal).
   REASON: Prioritized the no-lookahead engine + export over chart polish.
   CURRENT: Backend computes exactly as at each historical candle; UI depth may be limited.
   IMPACT: Research/audit via export package is complete; interactive replay may be basic.

6. MISSED-signal classification
   STATUS: HEURISTIC
   REASON: "Missed good trade" needs a reference of ideal moves.
   CURRENT: Timing uses EARLY/TIMELY/LATE/FALSE from realized outcomes; MISSED is
           surfaced via the hard-gate block counts (gate-analysis.json), not a count.
   IMPACT: Over-strict filtering is auditable through gate blocks rather than a MISSED tally.

No requirement was silently replaced with an alternative; every gap is listed above.
`;
}
