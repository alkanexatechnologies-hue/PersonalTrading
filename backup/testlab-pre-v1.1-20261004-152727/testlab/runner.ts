// Test Lab runner — orchestrates: resolve futures binding, choose signal series
// (resolved futures w/ OI, else spot-fallback), fetch Dhan historical candles,
// build the expiry function, run the engine, assemble the RunResult. Read-only.

import { lookupDhanSecurity } from "../data/dhanInstruments";
import { Candle } from "../types";
import { INDEX_MASTER, TF_MINUTES } from "./config";
import { resolveFuturesBinding } from "./futuresResolver";
import { fetchIntraday, resample } from "./dhanData";
import { runEngine } from "./engine";
import { RunResult, TestConfig, VwapSource } from "./types";

const DAY = 86_400_000;
const toEpoch = (d: string) => Math.floor(Date.parse(d + "T00:00:00+05:30") / 1000);
const endEpoch = (d: string) => Math.floor(Date.parse(d + "T23:59:59+05:30") / 1000);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);

export async function runTest(cfg: TestConfig): Promise<RunResult> {
  const m = INDEX_MASTER[cfg.index];
  const tfMin = TF_MINUTES[cfg.timeframe];

  // resolve window
  let fromMs: number, toMs: number;
  if (cfg.scope.mode === "full") {
    toMs = Date.now();
    fromMs = toMs - 730 * DAY; // probe ~2y back; actual availability reported from returned candles
  } else {
    if (!cfg.scope.fromDate || !cfg.scope.toDate) throw new Error("custom scope needs fromDate/toDate");
    fromMs = toEpoch(cfg.scope.fromDate) * 1000;
    toMs = endEpoch(cfg.scope.toDate) * 1000;
  }
  const startSec = Math.floor(fromMs / 1000), endSec = Math.floor(toMs / 1000);

  // futures binding resolved at the window END date (most likely active contract)
  const binding = await resolveFuturesBinding(cfg.index, toMs);

  // choose the native fetch interval (3m => fetch 1m then resample)
  const native = cfg.timeframe === "3m" ? 1 : tfMin;

  // decide the signal series: resolved futures (real volume+OI) else spot-fallback
  let candles: Candle[] = [];
  let oi: (number | null)[] = [];
  let oiStatus: "AVAILABLE" | "UNAVAILABLE" = "UNAVAILABLE";
  let vwapSource: VwapSource = "SPOT";

  if (binding.status === "RESOLVED" && binding.securityId) {
    try {
      const fut = await fetchIntraday(binding.securityId, binding.exchangeSegment!, "FUTIDX", native, startSec, endSec);
      if (fut.candles.length > 0) {
        candles = fut.candles; oi = fut.oi; oiStatus = fut.oiStatus; vwapSource = "FUTURES";
      }
    } catch { /* fall through to spot */ }
  }
  if (candles.length === 0) {
    const spotSec = await lookupDhanSecurity(m.nseSymbol);
    if (!spotSec) throw new Error(`No Dhan index security for ${m.nseSymbol}`);
    const spot = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, native, startSec, endSec);
    candles = spot.candles; oi = spot.oi; oiStatus = spot.oiStatus; // index spot OI almost always absent
    vwapSource = "SPOT";
  }
  if (cfg.timeframe === "3m") { const r = resample(candles, oi, 3); candles = r.candles; oi = r.oi; }

  // expiry function from the bound contract (monthly). Documented: uses futures
  // expiry from the scrip master, not a hard-coded weekday.
  const expMs = binding.expiry ? Date.parse(binding.expiry + "T10:00:00Z") : null;
  const expDate = binding.expiry;
  const expiryForDate = (sec: number) => {
    if (expMs == null) return { expiryDate: null, daysToExpiry: null, isExpiryDay: false };
    const d = istDate(sec);
    const days = Math.round((expMs - sec * 1000) / DAY);
    return { expiryDate: expDate, daysToExpiry: days, isExpiryDay: d === expDate };
  };

  const { rows, trades, metrics, daily, gateBlocks } = runEngine({
    config: cfg, binding, candles, oi, oiStatus, vwapSource, expiryForDate, symbol: m.internalSymbol,
  });

  // Chart series: zip raw OHLC+volume+OI with the engine's per-candle overlays
  // and signal (rows[i] corresponds to candles[i]). Never recomputed here.
  const chart = candles.map((c, i) => ({
    t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
    oi: oiStatus === "AVAILABLE" ? (oi[i] ?? null) : null,
    ema9: rows[i]?.ema9 ?? null, ema21: rows[i]?.ema21 ?? null, vwap: rows[i]?.vwap ?? null,
    signal: rows[i]?.signal ?? "WAIT",
  }));

  const rejected = rows.filter((r) => r.dataQualityReasons.includes("INVALID CANDLE")).length;
  const dataQuality = rows.length === 0 ? "BLOCKED" : (binding.status !== "RESOLVED" && cfg.futuresBinding === "strict" ? "BLOCKED" : (oiStatus === "UNAVAILABLE" ? "WARNING" : "PASS"));

  return {
    config: cfg, binding,
    dataRange: {
      from: candles.length ? istDate(candles[0].time) : "—",
      to: candles.length ? istDate(candles[candles.length - 1].time) : "—",
      totalCandles: candles.length, rejected,
    },
    oiStatus, dataQuality, rows, trades, chart, metrics, daily, gateBlocks,
  };
}

/** Lightweight availability probe for the UI "Full Available History" display. */
export async function availableHistory(cfg: Pick<TestConfig, "index" | "timeframe">): Promise<{ from: string; to: string; totalCandles: number }> {
  const m = INDEX_MASTER[cfg.index];
  const native = cfg.timeframe === "3m" ? 1 : TF_MINUTES[cfg.timeframe];
  const spotSec = await lookupDhanSecurity(m.nseSymbol);
  if (!spotSec) return { from: "—", to: "—", totalCandles: 0 };
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - 730 * 86400;
  const r = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, native, startSec, endSec);
  const cands = cfg.timeframe === "3m" ? resample(r.candles, r.oi, 3).candles : r.candles;
  return {
    from: cands.length ? istDate(cands[0].time) : "—",
    to: cands.length ? istDate(cands[cands.length - 1].time) : "—",
    totalCandles: cands.length,
  };
}
