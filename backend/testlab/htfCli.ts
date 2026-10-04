// TLS (standalone): trust system + bundled CAs like server.ts. Before any fetch.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    anyTls.setDefaultCACertificates([...(anyTls.getCACertificates("bundled") || []), ...(anyTls.getCACertificates("system") || [])]);
  }
} catch { /* older Node */ }

// V1.2 HTF audit runner (research/audit only).
//   tsx backend/testlab/htfCli.ts [INDEX] [fromDate] [toDate] [MODE]
//   default: NIFTY 2026-09-30 2026-10-01 FUTURES_INTERNAL  (§25 validation)
// Runs Test A/B/C + the 15M->5M timing diagnostic and writes the v1.2 package.

import { defaultConfig } from "./config";
import { runHtf } from "./htfRunner";
import { writeV12Package } from "./htfAudit";
import { IndexKey, TestConfig } from "./types";

async function main() {
  const [, , idxArg, a, b, modeArg] = process.argv;
  const index = (idxArg || "NIFTY").toUpperCase() as IndexKey;
  const from = a || "2026-09-30", to = b || "2026-10-01";
  const dataMode = (modeArg === "SPOT_DIRECTION" ? "SPOT_DIRECTION" : "FUTURES_INTERNAL") as TestConfig["dataMode"];

  const cfg = defaultConfig(index, "5m");
  cfg.scope = { mode: "custom", fromDate: from, toDate: to };
  cfg.dataMode = dataMode;
  cfg.futuresBinding = dataMode === "FUTURES_INTERNAL" ? "strict" : "spot-fallback";

  console.log(`\n[htf v1.2] ${index} 5M+15M ${from} → ${to} mode=${dataMode}`);
  const bundle = await runHtf(cfg);
  const dir = writeV12Package(bundle);

  const A = bundle.testA.metrics, B = bundle.testB.metrics, C = bundle.testC.metrics;
  console.log("\n==================== V1.2 HTF SUMMARY ====================");
  console.log(`5M candles / 15M candles : ${bundle.dataRange.candles5} / ${bundle.dataRange.candles15} · OI ${bundle.oiStatus}`);
  console.log(`Binding                  : ${bundle.binding.status} ${bundle.binding.futuresSymbol ?? ""} ${bundle.binding.expiry ?? ""}`);
  console.log(`15M direction dist       : ${JSON.stringify(bundle.testC.diagnostics.directionDistribution)}`);
  console.log(`VWAP events              : ${JSON.stringify(bundle.testC.diagnostics.vwapEventCounts)}`);
  console.log(`TEST A (current 5M)      : BUY ${A.buy}/SELL ${A.sell}/WAIT ${A.wait} · trades ${A.totalTrades} · win ${A.winRate}% · PF ${A.profitFactor}`);
  console.log(`TEST B (15M+5M)          : BUY ${B.buy}/SELL ${B.sell}/WAIT ${B.wait} · trades ${B.totalTrades} · win ${B.winRate}% · PF ${B.profitFactor}`);
  console.log(`TEST C (15M+5M+risk)     : BUY ${C.buy}/SELL ${C.sell}/WAIT ${C.wait} · trades ${C.totalTrades} · win ${C.winRate}% · PF ${C.profitFactor}`);
  console.log(`Package                  : ${dir}`);
  console.log("==========================================================\n");
}

main().catch((e) => { console.error("[htf v1.2] FAILED:", e?.stack || e?.message || e); process.exit(1); });
