// TLS: trust system + bundled CAs (same as server.ts) so Dhan HTTPS works when
// run standalone behind antivirus/proxy self-signed roots. Must run before fetch.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    const system = anyTls.getCACertificates("system") || [];
    const bundled = anyTls.getCACertificates("bundled") || [];
    anyTls.setDefaultCACertificates([...bundled, ...system]);
  }
} catch { /* older Node */ }

// Test Lab CLI runner (research). Usage:
//   tsx backend/testlab/runCli.ts <INDEX> <TF> [fromDate] [toDate]
//   tsx backend/testlab/runCli.ts NIFTY 5m 2026-09-01 2026-09-30
//   tsx backend/testlab/runCli.ts NIFTY 5m full
// Reuses the saved Dhan config/token (never printed). Writes the export package.

import { defaultConfig } from "./config";
import { runTest } from "./runner";
import { writeReviewPackage } from "./exporter";
import { IndexKey, TfKey } from "./types";

async function main() {
  const [, , idxArg, tfArg, a, b] = process.argv;
  const index = (idxArg || "NIFTY").toUpperCase() as IndexKey;
  const timeframe = (tfArg || "5m") as TfKey;
  const cfg = defaultConfig(index, timeframe);
  if ((a || "").toLowerCase() === "full") cfg.scope = { mode: "full" };
  else cfg.scope = { mode: "custom", fromDate: a || "2026-09-01", toDate: b || "2026-09-30" };

  console.log(`\n[testlab] ${index} ${timeframe} scope=${JSON.stringify(cfg.scope)} futuresBinding=${cfg.futuresBinding}`);
  const t0 = Date.now();
  const res = await runTest(cfg);
  const dir = writeReviewPackage(res);
  const m = res.metrics;
  const topGates = Object.entries(res.gateBlocks).sort((x, y) => y[1] - x[1]).slice(0, 10);

  console.log("\n==================== UNIVERSAL INDICATOR TEST RESULT ====================");
  console.log(`Index/TF           : ${index} ${timeframe}`);
  console.log(`Dhan data range    : ${res.dataRange.from} -> ${res.dataRange.to}`);
  console.log(`Candles / rejected : ${res.dataRange.totalCandles} / ${res.dataRange.rejected}`);
  console.log(`Futures binding    : ${res.binding.status} | ${res.binding.futuresSymbol ?? "-"} secId=${res.binding.securityId ?? "-"} exp=${res.binding.expiry ?? "-"} seg=${res.binding.exchangeSegment ?? "-"}`);
  console.log(`Binding reason     : ${res.binding.bindingReason}`);
  console.log(`VWAP source        : ${res.rows[0]?.vwapSource ?? "-"}`);
  console.log(`OI status          : ${res.oiStatus}`);
  console.log(`Data quality       : ${res.dataQuality}`);
  console.log(`BUY / SELL / WAIT  : ${m.buy} / ${m.sell} / ${m.wait}`);
  console.log(`Trades             : ${m.totalTrades} (W ${m.wins} / L ${m.losses} / BE ${m.breakeven})`);
  console.log(`Win rate           : ${m.winRate}%`);
  console.log(`Avg R / Median R   : ${m.avgR} / ${m.medianR}`);
  console.log(`Expectancy         : ${m.expectancy}`);
  console.log(`Profit factor      : ${m.profitFactor}`);
  console.log(`Max drawdown (R)   : ${m.maxDrawdownR}`);
  console.log(`MFE / MAE (avg R)  : ${m.avgMFE} / ${m.avgMAE}`);
  console.log(`Avg hold (bars)    : ${m.avgHoldBars}`);
  console.log(`Timing             : EARLY ${m.timing.EARLY} TIMELY ${m.timing.TIMELY} LATE ${m.timing.LATE} FALSE ${m.timing.FALSE} MISSED ${m.timing.MISSED}`);
  console.log(`Outcomes           : ${JSON.stringify(m.outcomes)}`);
  console.log(`Normal/Expiry days : ${m.normalDays} / ${m.expiryDays}`);
  console.log(`Top gate blocks    : ${topGates.map(([k, v]) => `${k}=${v}`).join(" | ") || "none"}`);
  console.log(`Export package     : ${dir}`);
  console.log(`Elapsed            : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("========================================================================\n");
}

main().catch((e) => { console.error("[testlab] FAILED:", e?.message || e); process.exit(1); });
