// Test Lab runner — orchestrates: resolve futures binding, choose signal series
// (resolved futures w/ OI, else spot-fallback), fetch Dhan historical candles,
// build the expiry function, run the engine, assemble the RunResult. Read-only.

import { lookupDhanSecurity } from "../data/dhanInstruments";
import { Candle } from "../types";
import { INDEX_MASTER, TF_MINUTES } from "./config";
import { resolvePerDateBindings } from "./futuresResolver";
import { fetchIntraday } from "./dhanData";
import { runEngine, computeMetrics, computeDaily } from "./engine";
import { runDecisionLayer } from "./decision";
import { fetchOptionSeries, OptionSeries } from "./optionsData";
import { defaultDecisionConfig } from "./config";
import { context15ForSeries } from "./context15";
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

export interface LoadedSeries {
  m: (typeof INDEX_MASTER)[keyof typeof INDEX_MASTER];
  native: number;
  warmupSessions: string[];
  dateSet: string[];
  spotByTime: Map<number, number>;
  perDateBinding: PerDateBindingRow[];
  contractChanges: { date: string; from: string | null; to: string | null }[];
  unavailableDateCount: number;
  candles: Candle[]; oi: (number | null)[];
  candles15: Candle[];               // 15M series of the SAME instrument (higher-timeframe context), closed candles only
  oiStatus: "AVAILABLE" | "UNAVAILABLE"; vwapSource: VwapSource; repBinding: FuturesBinding;
  bindingStatusByTime: Map<number, "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID">;
  contractChangeTimes: Set<number>; otherPriceByTime: Map<number, number>; vwapInstrument: string;
  bindingByDate: Map<string, FuturesBinding>;
  options: OptionSeries | null;
}

/** One-shot batch run (unchanged behaviour): fetch everything, then evaluate. */
export async function runTest(cfg: TestConfig): Promise<RunResult> {
  return evaluateSeries(cfg, await loadSeries(cfg));
}

/** Fetch (async) every series a run needs. `cfg.asOfSec` keeps only candles CLOSED by then (live / replay). */
export async function loadSeries(cfg: TestConfig): Promise<LoadedSeries> {
  const m = INDEX_MASTER[cfg.index];
  assertLabTimeframe(cfg.timeframe);
  const tfMin = TF_MINUTES[cfg.timeframe];
  const native = tfMin; // STRICTLY 5M / 15M Dhan-native candles — no 1-minute data, no resampling

  // ---- window ----
  let fromMs: number, toMs: number;
  if (cfg.scope.mode === "full") { toMs = Date.now(); fromMs = toMs - 730 * DAY; }
  else {
    if (!cfg.scope.fromDate || !cfg.scope.toDate) throw new Error("custom scope needs fromDate/toDate");
    fromMs = toEpoch(cfg.scope.fromDate) * 1000; toMs = endEpoch(cfg.scope.toDate) * 1000;
  }
  let startSec = Math.floor(fromMs / 1000);
  const endSec = Math.floor(toMs / 1000);
  // Warmup: the engine already scores only in-scope candles ("WARMUP HISTORY"),
  // but nothing loaded prior sessions, so the first minHistory bars of a short
  // window were blind. Load N prior sessions for indicator warmup only.
  const warmupN = cfg.scope.mode === "custom" ? Math.max(0, cfg.warmupSessions ?? 0) : 0;
  if (warmupN > 0) startSec -= (warmupN * 2 + 6) * 86400;

  // ---- SPOT series (always fetched: establishes trading dates + basis) ----
  const spotSec = await lookupDhanSecurity(m.nseSymbol);
  if (!spotSec) throw new Error(`No Dhan index security for ${m.nseSymbol}`);
  const spotFetch = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, native, startSec, endSec);
  const closedBy = (c: Candle) => cfg.asOfSec == null || c.time + tfMin * 60 <= cfg.asOfSec;
  let spotCandles = spotFetch.candles.filter(closedBy), spotOi = spotFetch.oi.filter((_, i) => closedBy(spotFetch.candles[i]));
  let warmupSessions: string[] = [];
  if (warmupN > 0 && cfg.scope.fromDate) {
    const before = [...new Set(spotCandles.map((c) => istDate(c.time)).filter((d) => d < cfg.scope.fromDate!))].sort();
    warmupSessions = before.slice(-warmupN);
    const keepFrom = warmupSessions[0] ?? cfg.scope.fromDate;
    const keep = spotCandles.map((c, i) => (istDate(c.time) >= keepFrom ? i : -1)).filter((i) => i >= 0);
    spotCandles = keep.map((i) => spotCandles[i]); spotOi = keep.map((i) => spotOi[i]);
    startSec = toEpoch(keepFrom);
  }
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
  const unavailableDateCount = perDate.filter((p) => p.binding.status !== "RESOLVED" && !warmupSessions.includes(p.date)).length;

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
  const fut15: Candle[] = [];
  const closed15 = (c: Candle) => cfg.asOfSec == null || c.time + 900 <= cfg.asOfSec;
  let anyFutOi = false;
  for (const per of periods) {
    const ps = toEpoch(per.dates[0]); const pe = endEpoch(per.dates[per.dates.length - 1]);
    try {
      const f = await fetchIntraday(per.secId, per.seg, "FUTIDX", native, ps, pe);
      let fc = f.candles.filter(closedBy), fo = f.oi.filter((_, i) => closedBy(f.candles[i]));
      if (f.oiStatus === "AVAILABLE") anyFutOi = true;
      fc.forEach((c, i) => { futCandlesAll.push(c); futOiAll.push(fo[i]); futByTime.set(c.time, c.close); });
      if (cfg.dataMode === "FUTURES_INTERNAL") {
        const f15 = native === 15 ? f : await fetchIntraday(per.secId, per.seg, "FUTIDX", 15, ps, pe).catch(() => null);
        if (f15) f15.candles.filter(closed15).forEach((c) => fut15.push(c));
      }
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

  const dcfg0 = cfg.decision ?? defaultDecisionConfig();
  let options: OptionSeries | null = null;
  if (dcfg0.optionData === "ON") {
    try { options = await fetchOptionSeries(cfg.index, native, dateSet.filter((d) => d >= (warmupSessions[warmupSessions.length - 1] ?? "")), dcfg0.strikeOffsets); }
    catch { options = null; }
  }
  let candles15: Candle[] = fut15;
  if (cfg.dataMode !== "FUTURES_INTERNAL") {
    const s15 = native === 15 ? spotFetch : await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, 15, startSec, endSec).catch(() => null);
    candles15 = s15 ? s15.candles.filter((c) => closed15(c) && c.time >= startSec) : [];
  }
  return {
    candles15,
    m, native, warmupSessions, dateSet, spotByTime, perDateBinding, contractChanges, unavailableDateCount,
    candles, oi, oiStatus, vwapSource, repBinding, bindingStatusByTime, contractChangeTimes, otherPriceByTime,
    vwapInstrument, bindingByDate, options,
  };
}

/** Live evaluation flag: the latest CLOSED candle's next candle has not opened yet. No forming / intrabar candle exists. */
export interface LiveExtra {}

/** Trading timeframes of the Lab: STRICTLY 5M (with 15M context) or 15M. 1-minute based timeframes are not allowed. */
export const LAB_TIMEFRAMES = ["5m", "15m"] as const;
export function assertLabTimeframe(tf: string): void {
  if (!(LAB_TIMEFRAMES as readonly string[]).includes(tf)) throw new Error(`Lab trading timeframe must be 5m or 15m (got ${tf}); 1-minute data is not used`);
}

/** Pure compute over CLOSED candles only. */
export function evaluateSeries(cfg: TestConfig, L: LoadedSeries, live?: LiveExtra): RunResult {
  const { m, warmupSessions, perDateBinding: pdb0, contractChanges, unavailableDateCount, oiStatus, vwapSource, repBinding, vwapInstrument, bindingByDate, options } = L;
  let candles = [...L.candles]; let oi = [...L.oi];
  const spotByTime = new Map(L.spotByTime), otherPriceByTime = new Map(L.otherPriceByTime);
  const bindingStatusByTime = new Map(L.bindingStatusByTime), contractChangeTimes = L.contractChangeTimes;
  const perDateBinding = pdb0.map((x) => ({ ...x }));
  const expiryForDate = (sec: number) => {
    const d = istDate(sec);
    const b = bindingByDate.get(d);
    if (!b || !b.expiry) return { expiryDate: null, daysToExpiry: null, isExpiryDay: false };
    const expMs = Date.parse(b.expiry + "T10:00:00Z");
    return { expiryDate: b.expiry, daysToExpiry: Math.round((expMs - sec * 1000) / DAY), isExpiryDay: d === b.expiry };
  };

  const eng = runEngine({
    config: cfg, binding: repBinding, candles, oi, oiStatus, vwapSource, expiryForDate,
    symbol: m.internalSymbol, otherPriceByTime, bindingStatusByTime, contractChangeTimes, vwapInstrument,
  });
  const gateBlocks = eng.gateBlocks;
  const inScope = (sec: number) => {
    if (cfg.scope.mode === "full") return true;
    const d = istDate(sec);
    return (!cfg.scope.fromDate || d >= cfg.scope.fromDate) && (!cfg.scope.toDate || d <= cfg.scope.toDate);
  };

  // ---- Trade Decision layer (additive): movement detection separate from execution ----
  const dcfg = cfg.decision ?? defaultDecisionConfig();
  const decision = runDecisionLayer({
    cfg, dc: dcfg, candles, rows: eng.rows, oi, liveTail: !!live,
    ctx15: context15ForSeries(candles, L.candles15, TF_MINUTES[cfg.timeframe] * 60, cfg),
    spotByTime: cfg.dataMode === "FUTURES_INTERNAL" ? spotByTime : undefined,
    options, strikeStep: m.strikeStep, inScope,
  });

  // Warmup candles are never scored or reported: keep only the requested window.
  const scopedIdx = eng.rows.map((r, i) => (inScope(r.timestamp) ? i : -1)).filter((i) => i >= 0);
  const rows = scopedIdx.map((i) => eng.rows[i]);
  const trades = eng.trades.filter((t) => inScope(t.timestamp));
  const metrics = warmupSessions.length ? computeMetrics(rows, trades) : eng.metrics;
  const daily = warmupSessions.length ? computeDaily(rows, trades) : eng.daily;
  const warmupCandles = eng.rows.length - rows.length;
  candles = scopedIdx.map((i) => candles[i]); oi = scopedIdx.map((i) => oi[i]);

  // mark volume/OI availability back on the per-date binding rows (diagnostics)
  const scopedBinding = perDateBinding.filter((pb) => inScope(toEpoch(pb.date) + 43200));
  perDateBinding.length = 0; perDateBinding.push(...scopedBinding);
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
    warmup: { sessions: warmupSessions, candles: warmupCandles },
    decision,
  };
}

/** Lightweight availability probe for the UI "Full Available History" display. */
export async function availableHistory(cfg: Pick<TestConfig, "index" | "timeframe">): Promise<{ from: string; to: string; totalCandles: number }> {
  const m = INDEX_MASTER[cfg.index];
  assertLabTimeframe(cfg.timeframe);
  const native = TF_MINUTES[cfg.timeframe];
  const spotSec = await lookupDhanSecurity(m.nseSymbol);
  if (!spotSec) return { from: "—", to: "—", totalCandles: 0 };
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - 730 * 86400;
  const r = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, native, startSec, endSec);
  const cands = r.candles;
  return {
    from: cands.length ? istDate(cands[0].time) : "—",
    to: cands.length ? istDate(cands[cands.length - 1].time) : "—",
    totalCandles: cands.length,
  };
}
