// TLS (standalone): trust system + bundled CAs like server.ts. Before any fetch.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    anyTls.setDefaultCACertificates([...(anyTls.getCACertificates("bundled") || []), ...(anyTls.getCACertificates("system") || [])]);
  }
} catch { /* older Node */ }

// Trade Decision layer report (research).
//   tsx backend/testlab/decisionCli.ts <INDEX> <TF> <fromDate> <toDate> [FUTURES_INTERNAL|SPOT_DIRECTION] [--cards]
// Runs the existing Test Lab (unchanged legacy signal + new decision layer) and
// prints movement detection vs execution. Writes the review package.

import { defaultConfig } from "./config";
import { runTest } from "./runner";
import { writeReviewPackage } from "./exporter";
import { decisionCard } from "./decisionCard";
import { IndexKey, TfKey, TestConfig } from "./types";

async function main() {
  const args = process.argv.slice(2);
  const cards = args.includes("--cards");
  const [idxArg, tfArg, from, to, modeArg] = args.filter((a) => !a.startsWith("--"));
  const index = (idxArg || "NIFTY").toUpperCase() as IndexKey;
  const tf = (tfArg || "5m") as TfKey;
  const cfg = defaultConfig(index, tf);
  cfg.scope = { mode: "custom", fromDate: from || "2026-10-01", toDate: to || from || "2026-10-01" };
  cfg.dataMode = (modeArg === "SPOT_DIRECTION" ? "SPOT_DIRECTION" : "FUTURES_INTERNAL") as TestConfig["dataMode"];
  cfg.futuresBinding = cfg.dataMode === "FUTURES_INTERNAL" ? "strict" : "spot-fallback";
  if (args.includes("--no-guard")) cfg.decision = { ...cfg.decision!, directionGuard: false }; // previous behaviour, for verification

  const t0 = Date.now();
  const res = await runTest(cfg);
  const dir = writeReviewPackage(res);
  const d = res.decision!;
  const s = d.summary;
  const series = cfg.dataMode === "FUTURES_INTERNAL" ? (res.binding.futuresSymbol || "FUT") : `${index} spot`;
  const L = res.metrics;

  console.log(`\n================ TRADE DECISION REPORT — ${index} ${tf} ${cfg.scope.fromDate} → ${cfg.scope.toDate} (${cfg.dataMode}) ================`);
  console.log(`Series / binding     : ${series} · ${res.binding.status} · unavailable dates ${res.unavailableDateCount} · OI ${res.oiStatus}`);
  console.log(`Warmup (not scored)  : ${res.warmup?.sessions.join(", ") || "none"} (${res.warmup?.candles ?? 0} candles)`);
  console.log(`Option history       : ${d.optionData.status} · ${d.optionData.barsWithChain}/${s.candles} candles with chain · ${d.optionData.note}`);
  console.log(`Candles scored       : ${s.candles}`);
  console.log(`\nLEGACY signal (unchanged engine): BUY ${L.buy} / SELL ${L.sell} / WAIT ${L.wait} · trades ${L.totalTrades} · gate blocks ${JSON.stringify(res.gateBlocks)}`);
  console.log(`\nLAYER A — MOVEMENT (never suppressed by gates)`);
  console.log(`  movement detections : ${s.movementDetections}  (breakout ${s.breakoutDetections} / breakdown ${s.breakdownDetections})`);
  console.log(`  genuine / false     : ${s.genuineMoves} / ${s.falseMoves}   (post-hoc: >= ${cfg.decision!.genuineMoveAtr} ATR favourable before invalidation)`);
  console.log(`  per-candle states   : ${JSON.stringify(s.movementStateCounts)}`);
  console.log(`\nLAYER B — EXECUTION`);
  console.log(`  BUY candidates      : ${s.buyCandidates} candle(s) → BUY_READY ${s.buyReady}`);
  console.log(`  SELL candidates     : ${s.sellCandidates} candle(s) → SELL_READY ${s.sellReady}`);
  console.log(`  blocks (candidates) : ${JSON.stringify(s.blocks)}`);
  console.log(`  per-candle states   : ${JSON.stringify(s.executionStateCounts)}`);
  const cnt = (xs: (string | null | undefined)[]) => xs.reduce((m: Record<string, number>, k) => { const kk = k ?? "—"; m[kk] = (m[kk] || 0) + 1; return m; }, {});
  const sig = d.rows.filter((r) => r.action === "TAKE" && r.plan);
  console.log(`\n15M CONTEXT (per candle)  : ${JSON.stringify(cnt(d.rows.map((r) => r.regime15)))}`);
  console.log(`15M on BUY/SELL signals   : ${JSON.stringify(cnt(sig.map((r) => `${r.plan!.side === "BUY" ? "CE" : "PE"}@${r.regime15}`)))}`);
  console.log(`Counter-trend breaks held : ${d.rows.filter((r) => r.plan && /15M .* needs a strong 5M candle/.test(r.blockReason ?? "")).length} candidate candle(s) (movement still logged)`);
  console.log(`Gamma (trade side, signals): ${JSON.stringify(cnt(sig.map((r) => r.gamma?.state)))} · all candles CE ${JSON.stringify(cnt(d.rows.map((r) => r.gammaCall?.state)))} PE ${JSON.stringify(cnt(d.rows.map((r) => r.gammaPut?.state)))}`);
  console.log(`OI validation (per candle): ${JSON.stringify(cnt(d.rows.map((r) => r.oiValidation.state)))}`);
  console.log(`Reversal risk on signals  : ${JSON.stringify(cnt(sig.map((r) => r.reversalRisk?.level)))}`);
  console.log(`Liquidity on signals      : ${JSON.stringify(cnt(sig.map((r) => r.liquidityGrade)))} · strikes chosen ${JSON.stringify(cnt(sig.map((r) => r.option?.primary ? `ATM${r.option.primary.offset >= 0 ? "+" : ""}${r.option.primary.offset}` : "none")))}`);
  const rrs = sig.map((r) => r.plan!.rr).sort((x, y) => x - y);
  console.log(`R:R on signals (info only): ${rrs.length ? `min ${rrs[0]} · median ${rrs[Math.floor(rrs.length / 2)]} · max ${rrs[rrs.length - 1]} · below 2.00: ${rrs.filter((x) => x < 2).length}/${rrs.length} (all still signalled)` : "no signals"}`);
  console.log(`Event timing              : ${JSON.stringify(cnt(d.events.map((e) => e.timing)))}`);
  if (cfg.decision!.directionGuard) {
    console.log(`Direction guard (per candle): ${JSON.stringify(cnt(d.rows.map((r) => r.guardState).filter(Boolean)))}`);
    console.log(`Reconfirmation outcomes   : ${JSON.stringify(cnt(d.rows.map((r) => r.reconfirmationStatus).filter((x) => x !== "NONE" && x !== "PENDING")))}`);
    console.log(`S/R rejections            : ${JSON.stringify(cnt(d.rows.filter((r) => r.rejectionStatus === "NEW").map((r) => r.supportResistanceEvent)))} · follow-up ${JSON.stringify(cnt(d.rows.map((r) => r.rejectionStatus).filter((x) => x && x !== "NEW" && x !== "WATCH")))}`);
    console.log(`Entries held by new layer : ${d.rows.filter((r) => /5M DIRECTION CONFLICT|REJECTION at/.test(r.entryBlockedReason ?? "")).length} candidate candle(s)`);
  }
  console.log(`\nBIG MOVES (post-hoc >= ${cfg.decision!.bigMoveAtr} ATR swings): ${s.bigMoves} · missed ${s.missedMoves} · late ${s.lateDetections}`);
  d.bigMoves.forEach((m) => console.log(`  ${m.direction.padEnd(8)} ${m.startIso.slice(5, 16)} → ${m.endIso.slice(11, 16)}  ${m.startPrice} → ${m.endPrice} (${m.travelAtr} ATR)  detected ${m.detectedIso ? m.detectedIso.slice(11, 16) : "—"}  ${m.coverage}`));
  console.log(`\nMOVEMENT EVENTS`);
  d.events.forEach((e) => console.log(`  #${String(e.moveId).padEnd(3)} ${e.direction.padEnd(8)} ${e.firstIso.slice(5, 16)} ${e.firstState.padEnd(19)} lvl ${e.level}  conf ${e.confirmIso ? e.confirmIso.slice(11, 16) : "—"}  end ${e.endIso.slice(11, 16)} ${e.endReason.padEnd(17)} MFE ${e.mfeAtr}ATR ${e.genuine ? "GENUINE" : "false  "} cand ${e.candidateBars} ready ${e.readyBars} blocks ${JSON.stringify(e.blockCounts)} → ${e.executed ? `TRADE ${e.tradeOutcome} ${e.tradeR}R` : "no trade"} [${e.timing}]`));
  console.log(`\nCLOSED TRADES (decision layer): ${s.closedTrades} · W ${s.wins} / L ${s.losses} · total ${s.totalR}R · win rate: ${s.winRate == null ? s.winRateNote : s.winRate + "%"}`);
  const dByT = new Map(d.rows.map((r) => [r.timestamp, r]));
  d.trades.forEach((t) => { const r = dByT.get(t.timestamp); console.log(`  ${t.iso.slice(5, 16)} ${t.signal === "BUY" ? "BUY CE" : "BUY PE"} ${r?.option?.primary ? r.option.primary.strike + " " + r.option.optionType : ""} fill ${t.entry} SL ${t.stopLoss} T1 ${t.target1} → ${t.outcome} ${t.exitPrice} (${t.rMultiple}R) · option ${r?.optionFill ?? "n/a"} → ${r?.optionExit ?? "n/a"} (₹${r?.optionPnl ?? "n/a"})`); });

  if (cards) {
    const pick = (side: "BUY" | "SELL") => d.rows.find((r) => r.plan?.side === side && r.action === "TAKE") || d.rows.find((r) => r.plan?.side === side);
    for (const side of ["BUY", "SELL"] as const) {
      const r = pick(side);
      console.log(`\n---------------- EXAMPLE ${side === "BUY" ? "BUY CE" : "BUY PE"} CARD ----------------`);
      console.log(r ? decisionCard(r, index, series) : `no ${side} candidate in this window`);
    }
  }
  console.log(`\nPackage: ${dir}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

main().catch((e) => { console.error("[decision] FAILED:", e?.stack || e?.message || e); process.exit(1); });
