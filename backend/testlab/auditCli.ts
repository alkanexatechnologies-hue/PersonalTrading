// TLS: trust system + bundled CAs (same as server.ts) so Dhan HTTPS works when
// run standalone. Must run before any fetch.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    const system = anyTls.getCACertificates("system") || [];
    const bundled = anyTls.getCACertificates("bundled") || [];
    anyTls.setDefaultCACertificates([...bundled, ...system]);
  }
} catch { /* older Node */ }

// Test Lab V1.1 correction audit runner (research/audit only).
//   tsx backend/testlab/auditCli.ts [INDEX] [TF] [fromDate] [toDate]
//   default: NIFTY 5m 2026-09-01 2026-09-30  (§26)
// Runs FUTURES_INTERNAL then SPOT_DIRECTION, plus R:R and Fake-Move ablations,
// and writes the full §27 review package + V1.1 report. No optimization.

import { defaultConfig } from "./config";
import { runTest } from "./runner";
import { writeV11Package, V11Inputs } from "./audit";
import { Candle } from "../types";
import { IndexKey, TestConfig, TfKey } from "./types";

const candlesFrom = (r: any): Candle[] => (r.chart || []).map((c: any) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));

async function main() {
  const [, , idxArg, tfArg, a, b] = process.argv;
  const index = (idxArg || "NIFTY").toUpperCase() as IndexKey;
  const timeframe = (tfArg || "5m") as TfKey;
  const from = a || "2026-09-01", to = b || "2026-09-30";

  const base = (): TestConfig => { const c = defaultConfig(index, timeframe); c.scope = { mode: "custom", fromDate: from, toDate: to }; return c; };

  console.log(`\n[testlab v1.1] ${index} ${timeframe} ${from} → ${to}`);
  console.log("[1/6] FUTURES_INTERNAL (strict, primary)…");
  const fiCfg: TestConfig = { ...base(), dataMode: "FUTURES_INTERNAL", futuresBinding: "strict" };
  const fi = await runTest(fiCfg);

  console.log("[2/6] SPOT_DIRECTION (price-only research)…");
  const sdCfg: TestConfig = { ...base(), dataMode: "SPOT_DIRECTION", futuresBinding: "spot-fallback" };
  const sd = await runTest(sdCfg);

  const useFi = fi.rows.length > 0;
  const primary = useFi ? fi : sd;
  const primaryCfg = useFi ? fiCfg : sdCfg;
  console.log(`[info] primary analysis mode = ${primary.dataMode} (${primary.rows.length} candles)`);

  console.log("[3/6] R:R ablation OFF…");
  const rrOff = await runTest({ ...primaryCfg, rrGateMode: "OFF" });
  console.log("[4/6] Fake-Move ablation OFF…");
  const fmOff = await runTest({ ...primaryCfg, ablationDisable: ["FAKE_MOVE"] });

  const inputs: V11Inputs = {
    fi, sd, primary, primaryCfg, primaryCandles: candlesFrom(primary),
    rrOn: primary, rrOff, fmOn: primary, fmOff,
  };

  console.log("[5/6] computing audits + writing package…");
  const dir = writeV11Package(inputs);

  console.log("[6/6] done.\n");
  console.log("==================== V1.1 CORRECTION SUMMARY ====================");
  console.log(`Dates in window        : ${fi.perDateBinding.length}`);
  console.log(`  resolved futures     : ${fi.perDateBinding.filter((d) => d.status === "RESOLVED").length}`);
  console.log(`  UNAVAILABLE_HISTORICAL: ${fi.perDateBinding.filter((d) => d.status !== "RESOLVED").length}`);
  console.log(`Contract changes       : ${fi.contractChanges.length}`);
  console.log(`FUTURES_INTERNAL        : ${fi.dataRange.totalCandles} candles · DQ ${fi.dataQuality} · OI ${fi.oiStatus} · trades ${fi.metrics.totalTrades}`);
  console.log(`SPOT_DIRECTION          : ${sd.dataRange.totalCandles} candles · DQ ${sd.dataQuality} · OI ${sd.oiStatus} · BUY ${sd.metrics.buy}/SELL ${sd.metrics.sell}/WAIT ${sd.metrics.wait} · trades ${sd.metrics.totalTrades} · win ${sd.metrics.winRate}% · PF ${sd.metrics.profitFactor}`);
  console.log(`researchBlocked(14:30)  : ${sd.researchBlockedSignals}`);
  console.log(`Package                 : ${dir}`);
  console.log("================================================================\n");
}

main().catch((e) => { console.error("[testlab v1.1] FAILED:", e?.stack || e?.message || e); process.exit(1); });
