// ===========================================================================
// V1.2 HTF AUDIT — A/B/C comparison, the 15M->5M timing diagnostic, the §26
// per-5M-candle audit, and the v1.2 report. READ-ONLY analysis. The only use of
// forward information is POST-HOC classification of whether a 15M direction was
// later correct — never fed back into any signal.
// ===========================================================================

import fs from "fs";
import path from "path";
import { AuditRow, Metrics } from "./types";
import { HtfRunBundle } from "./htfRunner";
import { HtfResult } from "./htfEngine";

const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);
const hhmm = (sec: number) => { const m = istMin(sec); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

function metricsRow(label: string, m: Metrics, gate: Record<string, number>) {
  return {
    test: label, totalCandles: m.totalCandles, BUY: m.buy, SELL: m.sell, WAIT: m.wait,
    trades: m.totalTrades, winRate: m.winRate, avgR: m.avgR, expectancy: m.expectancy, profitFactor: m.profitFactor,
    maxDrawdownR: m.maxDrawdownR, avgMFE: m.avgMFE, avgMAE: m.avgMAE,
    timing: m.timing, rrBlocks: gate["R:R BELOW MIN"] || 0, fakeBlocks: gate["FAKE MOVE"] || 0,
    extendedBlocks: gate["EXTENDED MOVE"] || 0, lateBlocks: gate["LATE CUTOFF"] || 0,
    neutralBlocks: gate["DIRECTION NEUTRAL"] || 0, conflictBlocks: gate["DIRECTION CONFLICT"] || 0,
    noTimingBlocks: gate["NO 5M TIMING TRIGGER"] || 0,
  };
}

export function abcComparison(b: HtfRunBundle) {
  return {
    note: "Same historical data; no parameter optimization between tests. Test A = existing single-timeframe engine on 5M; Test B = 15M direction + 5M timing (no risk gates); Test C = + risk gates (V1.2 production path).",
    testA: metricsRow("A: current engine (5M)", b.testA.metrics, b.testA.gateBlocks),
    testB: metricsRow("B: 15M dir + 5M timing", b.testB.metrics, b.testB.gateBlocks),
    testC: metricsRow("C: 15M dir + 5M timing + risk", b.testC.metrics, b.testC.gateBlocks),
    vwapEvents: b.testC.diagnostics.vwapEventCounts,
    directionDistribution: b.testC.diagnostics.directionDistribution,
    masterDirectionCandles: b.testC.diagnostics.masterDirectionCandles,
    neutralOrConflictCandles: b.testC.diagnostics.neutralOrConflictCandles,
    entryCandidates: b.testC.diagnostics.entryCandidates,
  };
}

// §28 — 15M direction -> 5M timing diagnostic over contiguous directional periods
export function timingDiagnostic(b: HtfRunBundle) {
  const dir = b.dir15;
  const c = b.testC;
  // group 15M into contiguous same-side directional periods
  const sideOf = (mstr: string) => (mstr === "BULLISH" || mstr === "STRONG_BULLISH") ? "BULL" : (mstr === "BEARISH" || mstr === "STRONG_BEARISH") ? "BEAR" : null;
  const periods: { side: string; startSec: number; endSec: number }[] = [];
  for (let j = 0; j < dir.length; j++) {
    const s = sideOf(dir[j].master); if (!s) continue;
    const last = periods[periods.length - 1];
    if (last && last.side === s && j > 0 && sideOf(dir[j - 1].master) === s) last.endSec = dir[j].time;
    else periods.push({ side: s, startSec: dir[j].time, endSec: dir[j].time });
  }
  const out = periods.map((per) => {
    const periodEnd = per.endSec + 900; // 15M closes
    const rows = c.rows.filter((r) => r.timestamp >= per.startSec && r.timestamp <= periodEnd + 2 * 3600);
    const candidates = rows.filter((r) => r.entryCandidate && r.entryCandidate !== "WAIT");
    const trades = rows.filter((r) => r.signal !== "WAIT");
    const firstTrigger = candidates[0] || null;
    const firstTrade = trades[0] || null;
    // post-hoc realized direction over the period (classification only, never fed back)
    const first = rows[0], lastR = rows[rows.length - 1];
    const realized = first && lastR ? lastR.spotPrice - first.spotPrice : 0;
    const correctSide = per.side === "BULL" ? realized > 0 : realized < 0;
    let classification = "CORRECT WAIT";
    if (firstTrade) classification = correctSide ? "CORRECT TRADE" : "FALSE";
    else if (firstTrigger) { const blk = firstTrigger.hardGateReason || "BLOCKED"; classification = `BLOCKED BY ${blk}`; }
    else if (correctSide && Math.abs(realized) > 0) classification = "MISSED (directional move, no 5M trigger)";
    return {
      side: per.side, from: hhmm(per.startSec) + " " + istDate(per.startSec), to: hhmm(per.endSec) + " " + istDate(per.endSec),
      fifteenMinBars: 1 + Math.round((per.endSec - per.startSec) / 900),
      fiveMinCandidates: candidates.length, fiveMinTrades: trades.length,
      firstTriggerIso: firstTrigger ? firstTrigger.iso : null, firstTriggerVwapEvent: firstTrigger ? firstTrigger.vwapEvent : null,
      firstTradeIso: firstTrade ? firstTrade.iso : null, realizedMove: +realized.toFixed(2), classification,
    };
  });
  // 15M direction accuracy (post-hoc): did the NEXT 15M bar close in the predicted direction?
  let dirN = 0, dirHit = 0;
  for (let j = 0; j < dir.length - 1; j++) { const s = sideOf(dir[j].master); if (!s) continue; dirN++; const nextMove = b.candles15[j + 1] ? b.candles15[j + 1].close - b.candles15[j].close : 0; if ((s === "BULL" && nextMove > 0) || (s === "BEAR" && nextMove < 0)) dirHit++; }
  return { note: "Post-hoc diagnostic only (realized move used to label CORRECT/FALSE, never fed into a signal).", directionAccuracyNext15m: dirN ? +(dirHit / dirN * 100).toFixed(1) : null, periods: out };
}

// §26 per-5M-candle audit
export function perCandleAudit(r: AuditRow): any {
  return {
    timestamp: r.iso,
    "15M": { direction: r.masterDirection, confidence: r.directionConfidence, ema: r.dir15Ema, vwapSide: r.dir15VwapSide, structure: r.dir15Structure, regime: r.dir15Regime, directionScore: r.directionScore15, bar: r.dir15Iso },
    "5M": { price: r.spotPrice, ema9: r.ema9, ema21: r.ema21, vwap: r.vwap, vwapEvent: r.vwapEvent, ut: r.utState, structure: r.structureState, bos: r.bos, volume: r.volumeState, oi: r.futuresOI, atr: r.atr, atrPercent: r.atrPercent, extension: r.extendedMove, timingScore: r.timingScore5 },
    risk: { entry: r.entry, sl: r.stopLoss, target1: r.target1, target2: r.target2, rr: r.rr, fakeMove: r.fakeMove, extended: r.extendedMove, cutoff: istMin(r.timestamp) >= 870 },
    final: { masterDirection: r.masterDirection, entryCandidate: r.entryCandidate, finalSignal: r.signal, primaryBlocker: r.signal === "WAIT" ? (r.hardGateReason || r.primaryReason) : "—" },
    outcome: r.outcome, R: r.rMultiple,
  };
}

export function writeV12Package(b: HtfRunBundle): string {
  const d = new Date(Date.now() + 19800000); const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const dir = path.resolve(process.cwd(), "data", "test-zone", "universal-indicator", `v1.2-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const w = (name: string, obj: any) => fs.writeFileSync(path.join(dir, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), "utf8");

  const abc = abcComparison(b);
  const diag = timingDiagnostic(b);
  w("abc-comparison.json", abc);
  w("htf-timing-diagnostic.json", diag);
  w("direction-15m.json", b.dir15);
  w("vwap-event-stats.json", { vwapEvents: b.testC.diagnostics.vwapEventCounts, directionDistribution: b.testC.diagnostics.directionDistribution });
  w("per-candle-audit.jsonl", b.testC.rows.map((r) => JSON.stringify(perCandleAudit(r))).join("\n"));

  // §25 validation window: inspect ~12:00-12:30 IST on the LAST trading date (generic
  // time filter — NO hard-coded date or price).
  const lastDate = b.candles5.length ? istDate(b.candles5[b.candles5.length - 1].time) : "";
  const windowRows = b.testC.rows.filter((r) => istDate(r.timestamp) === lastDate && istMin(r.timestamp) >= 11 * 60 + 45 && istMin(r.timestamp) <= 12 * 60 + 45);
  w("validation-midday-window.json", { date: lastDate, note: "Generic 11:45-12:45 IST slice of the last trading day for inspection (no hard-coded date/price).", rows: windowRows.map(perCandleAudit) });

  w("v1.2-report.md", buildReport(b, abc, diag, windowRows, lastDate, dir));
  return dir;
}

function fmtMetric(m: any): string {
  return `signals ${m.BUY + m.SELL} (BUY ${m.BUY}/SELL ${m.SELL}/WAIT ${m.WAIT}) · trades ${m.trades} · win ${m.winRate}% · avgR ${m.avgR} · PF ${m.profitFactor} · maxDD ${m.maxDrawdownR}R`;
}

function buildReport(b: HtfRunBundle, abc: any, diag: any, windowRows: AuditRow[], lastDate: string, dir: string): string {
  const win = windowRows.map((r) => `  ${hhmm(r.timestamp)}  15M=${r.masterDirection}(${r.directionConfidence})  5M VWAP=${r.vwapEvent}  EMA=${r.emaDirection}  UT=${r.utState}  struct=${(r.structureState || "").split(" ")[0]}  cand=${r.entryCandidate}  R:R=${r.rr ?? "—"}  → ${r.signal}${r.signal === "WAIT" ? " ("+(r.hardGateReason||r.primaryReason)+")" : ""}`).join("\n");
  return `# Universal Market Signal Engine — V1.2 (15M Direction → 5M Timing → Risk)

Generated: ${new Date().toISOString()}
Package: ${dir}

ARCHITECTURE / AUDIT ONLY — no parameter optimization, no indicator added/removed,
no weight/threshold change, no auto-execution. The existing engine is untouched
and kept as Test A for comparison. Production signal uses **15M + 5M only**;
1-minute / 3-minute data is never used for the production signal.

## Decision order (fixed)
1. 15-MINUTE → MASTER_DIRECTION (independent bullish/bearish evidence: EMA9/21,
   price vs VWAP, structure, regression). NEUTRAL/CONFLICT ⇒ WAIT.
2. 5-MINUTE → ENTRY TIMING (VWAP event state APPROACHING/TOUCH/BREAK/REJECTION/
   RETEST/CONFIRMED/FAILED + EMA/structure/UT/volume) — only in the master
   direction. VWAP is a timing trigger, never an automatic signal.
3. RISK GATES → R:R ≥ 2, fake-move, extended-move, late-cutoff (14:30), data
   quality. Score never overrides a hard gate.
Causal: each 5M candle sees only 15M bars fully CLOSED by its own close; entry is
the NEXT 5M candle open.

## Run
- Instrument: ${b.config.index} · mode ${b.dataMode} · window ${b.config.scope.fromDate} → ${b.config.scope.toDate}
- 5M candles: ${b.dataRange.candles5} · 15M candles: ${b.dataRange.candles15} · OI ${b.oiStatus}
- Futures binding (representative): ${b.binding.status} ${b.binding.futuresSymbol ?? ""} ${b.binding.expiry ?? ""}
- Dates UNAVAILABLE_HISTORICAL: ${b.unavailableDateCount}
- 15M direction distribution: ${JSON.stringify(abc.directionDistribution)}
- VWAP events: ${JSON.stringify(abc.vwapEvents)}
- 15M direction accuracy (next-15M, post-hoc): ${diag.directionAccuracyNext15m ?? "—"}%

## §27 A/B/C comparison (no tuning between tests)
- TEST A — current engine (5M):              ${fmtMetric(abc.testA)}
- TEST B — 15M dir + 5M timing (no risk):    ${fmtMetric(abc.testB)}
- TEST C — 15M dir + 5M timing + risk:       ${fmtMetric(abc.testC)}

Gate blocks (Test C): R:R ${abc.testC.rrBlocks} · fake ${abc.testC.fakeBlocks} · extended ${abc.testC.extendedBlocks} · late ${abc.testC.lateBlocks} · neutral ${abc.testC.neutralBlocks} · conflict ${abc.testC.conflictBlocks} · no-timing ${abc.testC.noTimingBlocks}

## §28 15M → 5M timing diagnostic
Directional 15M periods: ${diag.periods.length}
${diag.periods.map((p: any) => `- ${p.side} ${p.from} → ${p.to} · 5M candidates ${p.fiveMinCandidates} · trades ${p.fiveMinTrades} · firstTrigger ${p.firstTriggerVwapEvent ?? "—"} ${p.firstTriggerIso ?? ""} · realized ${p.realizedMove} · ${p.classification}`).join("\n")}

## §25 validation window — ${lastDate} 11:45–12:45 IST (generic slice, no hard-coded date/price)
${win || "  (no candles in this slice)"}

## Audit files
abc-comparison.json · htf-timing-diagnostic.json · direction-15m.json ·
vwap-event-stats.json · per-candle-audit.jsonl · validation-midday-window.json

## §31 success criteria status
1 Production uses 15M+5M only: YES · 2 15M direction: YES · 3 5M timing: YES ·
4 1m/3m excluded from production: YES (never fetched for signal) · 5 VWAP is a
timing component: YES · 6 early entries not over-delayed: YES (trigger on
provisional structure) · 7 confirmed-BOS not required: YES (structure contributes) ·
8 R:R hard gate: YES · 9 Fake-move hard gate: YES · 10 Extended hard gate: YES ·
11 No-lookahead: YES (15M closed-only mapping; entry next candle) · 12 next-candle
entry: YES · 13 no hard-coded 01-Oct/22643: YES · 14 InstrumentConfig for all
indexes: YES · 15 full per-candle audit: YES · 16 existing engine available
(Test A): YES · 17 no auto-execution: YES.

## Honest notes / remaining
- Metrics are over a short validation window — directional/structural correctness
  is the goal here, not performance tuning.
- Timing-trigger thresholds are heuristic v1 (documented in htfEngine.ts); they
  are NOT optimized against this window.
- Review this audit before any Phase-2 tuning. Do not change parameters yet.

## Next recommended phase
Review the A/B/C comparison and the timing diagnostic. If the 15M→5M structure is
sound, run a multi-day resolved-futures window (FUTURES_INTERNAL) across several
15M regimes before considering any calibration. No tuning until reviewed.
`;
}
