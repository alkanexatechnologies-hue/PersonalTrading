// TLS (standalone)
import tls from "node:tls";
try { const a = tls as any; if (a.getCACertificates && a.setDefaultCACertificates) a.setDefaultCACertificates([...(a.getCACertificates("bundled") || []), ...(a.getCACertificates("system") || [])]); } catch {}

// READ-ONLY R:R evidence diagnostic (does NOT modify the engine). Re-fetches the
// same window via runHtf, then recomputes entry/SL/target/rr for a time slice
// using the SAME formulas and component functions the engine uses, so we can see
// the numbers the engine nulls on WAIT rows. No tuning; evidence only.

import { defaultConfig } from "./config";
import { runHtf } from "./htfRunner";
import { atrSeries, vwapSeries, emaSeries, supportResistance } from "./components";
import { IndexKey } from "./types";

const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);
const hhmm = (sec: number) => `${String(Math.floor(istMin(sec) / 60)).padStart(2, "0")}:${String(istMin(sec) % 60).padStart(2, "0")}`;
const WINDOW = 120;

async function main() {
  const index = ((process.argv[2] || "NIFTY").toUpperCase()) as IndexKey;
  const cfg = defaultConfig(index, "5m");
  cfg.scope = { mode: "custom", fromDate: process.argv[3] || "2026-09-30", toDate: process.argv[4] || "2026-10-01" };
  cfg.dataMode = "FUTURES_INTERNAL"; cfg.futuresBinding = "strict";
  const sliceDate = process.argv[5] || "2026-10-01";
  const fromMin = 12 * 60 + 10, toMin = 12 * 60 + 40;

  const b = await runHtf(cfg);
  const c5 = b.candles5;
  const atr = atrSeries(c5, cfg.atrPeriod);
  const vw = vwapSeries(c5);
  const ema9 = emaSeries(c5, cfg.emaFast);

  console.log(`\n[rr-evidence] ${index} FUTURES_INTERNAL ${cfg.scope.fromDate}..${cfg.scope.toDate}`);
  console.log(`binding ${b.binding.status} ${b.binding.futuresSymbol} ${b.binding.expiry} · 5M candles ${c5.length}`);
  // slippageAllowance is a Phase-B InstrumentConfig field (not yet in defaultConfig);
  // use 0 here as a placeholder and label it, so decisionEntry == close for now.
  const slippage = (cfg as any).slippageAllowance ?? 0;
  console.log(`\nslAtrBuffer=${cfg.slAtrBuffer} targetAtrMult=${cfg.targetAtrMult} rrMin(cfg)=${cfg.rrMin} slippageAllowance=${slippage}`);
  console.log("candle label = bar START (e.g. 12:25 = bar 12:25-12:30, closing 12:30)");
  console.log("decisionEntry = signal-candle CLOSE − slippage (SELL); outcomeEntry = NEXT 5M open (analysis only). rr computed on decisionEntry per spec.");
  console.log("\ntime   close    decEntry  outEntry  SLsrc(res)       SL       riskPts  T1src              T1        rewardPts  rr(dec)  note");
  for (let i = 0; i < c5.length; i++) {
    const c = c5[i];
    if (istDate(c.time) !== sliceDate) continue;
    const m = istMin(c.time); if (m < fromMin || m > toMin) continue;
    const a = atr[i] ?? 0;
    const price = c.close;
    const win = c5.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const { support, resistance } = supportResistance(win, price);
    const next = c5[i + 1];
    const decisionEntry = +(price - slippage).toFixed(2);  // SELL: close − slippage (spec)
    const outcomeEntry = next ? next.open : price;         // analysis-layer entry only
    // SELL SL above entry from opposing swing (resistance). R:R uses decisionEntry.
    const inval = resistance != null ? resistance : price + (a || price * 0.003);
    const sl = +(inval + a * cfg.slAtrBuffer).toFixed(2);
    const risk = +(sl - decisionEntry).toFixed(2);
    const usedStructTarget = support != null && support < decisionEntry;
    const t1 = usedStructTarget ? support! : +(decisionEntry - a * cfg.targetAtrMult).toFixed(2);
    const reward = +(decisionEntry - t1).toFixed(2);
    const rr = risk > 0 ? +(reward / risk).toFixed(2) : 0;
    const slSrc = resistance != null ? `swingHigh ${resistance.toFixed(1)}` : "price+ATR";
    const t1Src = usedStructTarget ? `swingLow ${support!.toFixed(1)}` : `ATR×${cfg.targetAtrMult} (${(a * cfg.targetAtrMult).toFixed(1)})`;
    console.log(`${hhmm(c.time)}  ${price.toFixed(1)}  ${decisionEntry.toFixed(1).padStart(7)}  ${outcomeEntry.toFixed(1).padStart(7)}  ${slSrc.padEnd(16)} ${sl.toFixed(1)}  ${risk.toFixed(1).padStart(7)}  ${t1Src.padEnd(18)} ${t1.toFixed(1)}  ${reward.toFixed(1).padStart(8)}  ${rr.toFixed(2)}  ATR=${a.toFixed(1)}`);
  }
  console.log("");
}
main().catch((e) => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
