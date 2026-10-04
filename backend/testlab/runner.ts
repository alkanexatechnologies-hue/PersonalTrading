// Test Lab runner — orchestrates: resolve futures binding, choose signal series
// (resolved futures w/ OI, else spot-fallback), fetch Dhan historical candles,
// build the expiry function, run the engine, assemble the RunResult. Read-only.

import { lookupDhanSecurity } from "../data/dhanInstruments";
import { Candle } from "../types";
import { INDEX_MASTER, TF_MINUTES } from "./config";
import { resolvePerDateBindings } from "./futuresResolver";
import { fetchIntraday, resample } from "./dhanData";
import { runEngine } from "./engine";
import { FuturesBinding, PerDateBindingRow, RunResult, TestConfig, VwapSource } from "./types";

const DAY = 86_400_000;
const toEpoch = (d: string) => Math.floor(Date.parse(d + "T00:00:00+05:30") / 1000);
const endEpoch = (d: string) => Math.floor(Date.parse(d + "T23:59:59+05:30") / 1000);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);

const INVALID_BINDING: FuturesBinding = {
  underlying: "", futuresSymbol: null, securityId: null, expiry: null,
  exchangeSegment: null, lotSize: null, status: "UNAVAILABLE_HISTORICAL",
  bindingReason: "No date-correct futures contract available for this window.",
};

export async function runTest(cfg: TestConfig): Promise<RunResult> {
  const m = INDEX_MASTER[cfg.index];
  const tfMin = TF_MINUTES[cfg.timeframe];
  const native = cfg.timeframe === "3m" ? 1 : tfMin; // 3m => fetch 1m then resample

  // ---- window ----
  let fromMs: number, toMs: number;
  if (cfg.scope.mode === "full") { toMs = Date.now(); fromMs = toMs - 730 * DAY; }
  else {
    if (!cfg.scope.fromDate || !cfg.scope.toDate) throw new Error("custom scope needs fromDate/toDate");
    fromMs = toEpoch(cfg.scope.fromDate) * 1000; toMs = endEpoch(cfg.scope.toDate) * 1000;
  }
  const startSec = Math.floor(fromMs / 1000), endSec = Math.floor(toMs / 1000);

  // ---- SPOT series (always fetched: establishes trading dates + basis) ----
  const spotSec = await lookupDhanSecurity(m.nseSymbol);
  if (!spotSec) throw new Error(`No Dhan index security for ${m.nseSymbol}`);
  const spotFetch = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, native, startSec, endSec);
  let spotCandles = spotFetch.candles, spotOi = spotFetch.oi;
  if (cfg.timeframe === "3m") { const r = resample(spotCandles, spotOi, 3); spotCandles = r.candles; spotOi = r.oi; }
  const spotByTime = new Map<number, number>(); spotCandles.forEach((c) => spotByTime.set(c.time, c.close));

  // trading dates (IST) in order
  const dateSet: string[] = []; const seenD = new Set<string>();
  spotCandles.forEach((c) => { const d = istDate(c.time); if (!seenD.has(d)) { seenD.add(d); dateSet.push(d); } });

  // ---- §1/§2 per-date date-correct binding ----
  const perDate = await resolvePerDateBindings(cfg.index, dateSet);
  const bindingByDate = new Map(perDate.map((p) => [p.date, p.binding]));
  const perDateBinding: PerDateBindingRow[] = perDate.map((p) => ({
    date: p.date, status: p.binding.status, futuresSymbol: p.binding.futuresSymbol,
    securityId: p.binding.securityId, expiry: p.binding.expiry,
    daysToExpiry: p.binding.expiry ? Math.round((Date.parse(p.binding.expiry + "T10:00:00Z") - Date.parse(p.date + "T12:00:00+05:30")) / DAY) : null,
    bindingReason: p.binding.bindingReason, volumeAvailable: false, oiAvailable: false, contractChange: p.contractChange,
  }));
  const contractChanges = perDate
    .map((p, i) => ({ p, prev: i > 0 ? perDate[i - 1] : null }))
    .filter((x) => x.p.contractChange)
    .map((x) => ({ date: x.p.date, from: x.prev ? x.prev.binding.futuresSymbol : null, to: x.p.binding.futuresSymbol }));
  const unavailableDateCount = perDate.filter((p) => p.binding.status !== "RESOLVED").length;

  // ---- choose the signal series per data mode ----
  let candles: Candle[] = [];
  let oi: (number | null)[] = [];
  let oiStatus: "AVAILABLE" | "UNAVAILABLE" = "UNAVAILABLE";
  let vwapSource: VwapSource = "SPOT";
  let repBinding: FuturesBinding = INVALID_BINDING;
  const bindingStatusByTime = new Map<number, "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID">();
  const contractChangeTimes = new Set<number>();
  const otherPriceByTime = new Map<number, number>();
  let vwapInstrument: string;

  // Group consecutive RESOLVED dates by contract (securityId) into periods.
  const periods: { secId: string; seg: string; sym: string; expiry: string; dates: string[] }[] = [];
  for (const p of perDate) {
    if (p.binding.status !== "RESOLVED" || !p.binding.securityId) continue;
    const sid = p.binding.securityId;
    const last = periods[periods.length - 1];
    if (last && last.secId === sid) last.dates.push(p.date);
    else periods.push({ secId: sid, seg: p.binding.exchangeSegment || "NSE_FNO", sym: p.binding.futuresSymbol || "", expiry: p.binding.expiry || "", dates: [p.date] });
  }

  // futures-by-time (for basis in SPOT_DIRECTION and the FUTURES_INTERNAL series)
  const futByTime = new Map<number, number>();
  const futCandlesAll: Candle[] = []; const futOiAll: (number | null)[] = [];
  let anyFutOi = false;
  for (const per of periods) {
    const ps = toEpoch(per.dates[0]); const pe = endEpoch(per.dates[per.dates.length - 1]);
    try {
      const f = await fetchIntraday(per.secId, per.seg, "FUTIDX", native, ps, pe);
      let fc = f.candles, fo = f.oi;
      if (cfg.timeframe === "3m") { const r = resample(fc, fo, 3); fc = r.candles; fo = r.oi; }
      if (f.oiStatus === "AVAILABLE") anyFutOi = true;
      const firstTime = futCandlesAll.length ? null : (fc[0]?.time ?? null);
      fc.forEach((c, i) => { futCandlesAll.push(c); futOiAll.push(fo[i]); futByTime.set(c.time, c.close); });
      // mark the first candle of a NEW contract period as a contract-change bar
      if (periods.indexOf(per) > 0 && fc.length) contractChangeTimes.add(fc[0].time);
    } catch { /* period unavailable at fetch — treated as unavailable */ }
  }

  if (cfg.dataMode === "FUTURES_INTERNAL") {
    candles = futCandlesAll; oi = futOiAll; oiStatus = anyFutOi ? "AVAILABLE" : "UNAVAILABLE"; vwapSource = "FUTURES";
    candles.forEach((c) => bindingStatusByTime.set(c.time, "RESOLVED")); // series only contains resolved candles
    candles.forEach((c) => { const s = spotByTime.get(c.time); if (s != null) otherPriceByTime.set(c.time, s); });
    repBinding = periods.length ? { underlying: m.nseSymbol, futuresSymbol: periods[periods.length - 1].sym, securityId: periods[periods.length - 1].secId, expiry: periods[periods.length - 1].expiry, exchangeSegment: periods[periods.length - 1].seg, lotSize: null, status: "RESOLVED", bindingReason: `${periods.length} resolved contract period(s).` } : INVALID_BINDING;
    vwapInstrument = repBinding.futuresSymbol || `${m.nseSymbol} FUT`;
  } else { // SPOT_DIRECTION
    candles = spotCandles; oi = spotOi; oiStatus = spotFetch.oiStatus; vwapSource = "SPOT";
    candles.forEach((c) => bindingStatusByTime.set(c.time, bindingByDate.get(istDate(c.time))?.status ?? "UNAVAILABLE_HISTORICAL"));
    candles.forEach((c) => { const f = futByTime.get(c.time); if (f != null) otherPriceByTime.set(c.time, f); });
    repBinding = bindingByDate.get(dateSet[dateSet.length - 1]) ?? INVALID_BINDING;
    vwapInstrument = m.nseSymbol;
  }

  // ---- expiry (instrument-master driven, §22): per candle's date binding ----
  const expiryForDate = (sec: number) => {
    const d = istDate(sec);
    const b = bindingByDate.get(d);
    if (!b || !b.expiry) return { expiryDate: null, daysToExpiry: null, isExpiryDay: false };
    const expMs = Date.parse(b.expiry + "T10:00:00Z");
    return { expiryDate: b.expiry, daysToExpiry: Math.round((expMs - sec * 1000) / DAY), isExpiryDay: d === b.expiry };
  };

  const { rows, trades, metrics, daily, gateBlocks } = runEngine({
    config: cfg, binding: repBinding, candles, oi, oiStatus, vwapSource, expiryForDate,
    symbol: m.internalSymbol, otherPriceByTime, bindingStatusByTime, contractChangeTimes, vwapInstrument,
  });

  // mark volume/OI availability back on the per-date binding rows (diagnostics)
  perDateBinding.forEach((pb) => {
    const resolved = pb.status === "RESOLVED";
    pb.volumeAvailable = resolved && cfg.dataMode === "FUTURES_INTERNAL";
    pb.oiAvailable = resolved && oiStatus === "AVAILABLE" && cfg.dataMode === "FUTURES_INTERNAL";
  });

  const chart = candles.map((c, i) => ({
    t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
    oi: oiStatus === "AVAILABLE" ? (oi[i] ?? null) : null,
    ema9: rows[i]?.ema9 ?? null, ema21: rows[i]?.ema21 ?? null, vwap: rows[i]?.vwap ?? null,
    signal: rows[i]?.signal ?? "WAIT",
  }));

  const rejected = rows.filter((r) => r.dataQualityReasons.includes("INVALID CANDLE")).length;
  const dataQuality = rows.length === 0
    ? "BLOCKED"
    : (cfg.dataMode === "FUTURES_INTERNAL" && oiStatus === "UNAVAILABLE" ? "BLOCKED"
      : (oiStatus === "UNAVAILABLE" ? "WARNING" : "PASS"));

  return {
    config: cfg, dataMode: cfg.dataMode, binding: repBinding, perDateBinding, contractChanges, unavailableDateCount,
    researchBlockedSignals: gateBlocks["LATE CUTOFF"] || 0,
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
