// ===========================================================================
// V1.2 HTF RUNNER — fetches BOTH 5M and 15M (date-aware futures binding,
// FUTURES_INTERNAL primary; SPOT_DIRECTION research fallback) and runs:
//   Test A: the existing single-timeframe engine on 5M (unchanged, for compare)
//   Test B: 15M direction + 5M timing, NO risk gates
//   Test C: 15M direction + 5M timing + risk gates   (the V1.2 production path)
// 1-minute / 3-minute data is never fetched or used for the production signal.
// Reuses futuresResolver + dhanData; no parameter optimization.
// ===========================================================================

import { lookupDhanSecurity } from "../data/dhanInstruments";
import { Candle } from "../types";
import { INDEX_MASTER, TF_MINUTES } from "./config";
import { resolvePerDateBindings } from "./futuresResolver";
import { fetchIntraday } from "./dhanData";
import { runEngine } from "./engine";
import { runHtfEngine, HtfResult, Dir15 } from "./htfEngine";
import { instrumentConfig } from "./instrumentConfig";
import { FuturesBinding, Metrics, DailyRow, AuditRow, TestConfig } from "./types";

const DAY = 86_400_000;
const toEpoch = (d: string) => Math.floor(Date.parse(d + "T00:00:00+05:30") / 1000);
const endEpoch = (d: string) => Math.floor(Date.parse(d + "T23:59:59+05:30") / 1000);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);

export interface BaseResult { rows: AuditRow[]; trades: AuditRow[]; metrics: Metrics; daily: DailyRow[]; gateBlocks: Record<string, number>; }
export interface HtfRunBundle {
  config: TestConfig;
  binding: FuturesBinding;
  dataMode: TestConfig["dataMode"];
  dataRange: { from: string; to: string; candles5: number; candles15: number };
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  unavailableDateCount: number;
  testA: BaseResult;    // existing engine on 5M
  testB: HtfResult;     // 15M + 5M, no risk gates
  testC: HtfResult;     // 15M + 5M + risk gates (production path)
  dir15: Dir15[];
  candles5: Candle[];
  candles15: Candle[];
}

async function fetchSeries(index: TestConfig["index"], dataMode: TestConfig["dataMode"], startSec: number, endSec: number, nativeMin: number, dateSet: string[], bindingByDate: Map<string, FuturesBinding>, spotByTimeOut?: Map<number, number>) {
  const m = INDEX_MASTER[index];
  if (dataMode === "SPOT_DIRECTION") {
    const spotSec = await lookupDhanSecurity(m.nseSymbol);
    if (!spotSec) throw new Error(`No Dhan index security for ${m.nseSymbol}`);
    const f = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, nativeMin, startSec, endSec);
    return { candles: f.candles, oi: f.oi, oiStatus: f.oiStatus, vwapInstrument: m.nseSymbol };
  }
  // FUTURES_INTERNAL: concatenate resolved contract periods
  const periods: { secId: string; seg: string; sym: string; dates: string[] }[] = [];
  for (const d of dateSet) {
    const b = bindingByDate.get(d);
    if (!b || b.status !== "RESOLVED" || !b.securityId) continue;
    const last = periods[periods.length - 1];
    if (last && last.secId === b.securityId) last.dates.push(d);
    else periods.push({ secId: b.securityId, seg: b.exchangeSegment || "NSE_FNO", sym: b.futuresSymbol || "", dates: [d] });
  }
  const candles: Candle[] = []; const oi: (number | null)[] = []; let anyOi = false; let vwapInstrument = `${m.nseSymbol} FUT`;
  for (const per of periods) {
    const ps = toEpoch(per.dates[0]); const pe = endEpoch(per.dates[per.dates.length - 1]);
    const f = await fetchIntraday(per.secId, per.seg, "FUTIDX", nativeMin, ps, pe);
    if (f.oiStatus === "AVAILABLE") anyOi = true; vwapInstrument = per.sym || vwapInstrument;
    f.candles.forEach((c, i) => { candles.push(c); oi.push(f.oi[i]); });
  }
  return { candles, oi, oiStatus: anyOi ? "AVAILABLE" as const : "UNAVAILABLE" as const, vwapInstrument };
}

export async function runHtf(cfg: TestConfig): Promise<HtfRunBundle> {
  const m = INDEX_MASTER[cfg.index];
  const inst = instrumentConfig(cfg.index);
  if (cfg.scope.mode !== "custom" || !cfg.scope.fromDate || !cfg.scope.toDate) throw new Error("HTF run needs a custom window (fromDate/toDate)");
  const startSec = toEpoch(cfg.scope.fromDate), endSec = endEpoch(cfg.scope.toDate);

  // trading dates via spot 5M
  const spotSec = await lookupDhanSecurity(m.nseSymbol);
  if (!spotSec) throw new Error(`No Dhan index security for ${m.nseSymbol}`);
  const spot5 = await fetchIntraday(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument, 5, startSec, endSec);
  const spotByTime = new Map<number, number>(); spot5.candles.forEach((c) => spotByTime.set(c.time, c.close));
  const dateSet: string[] = []; const seen = new Set<string>();
  spot5.candles.forEach((c) => { const d = istDate(c.time); if (!seen.has(d)) { seen.add(d); dateSet.push(d); } });

  const perDate = await resolvePerDateBindings(cfg.index, dateSet);
  const bindingByDate = new Map(perDate.map((p) => [p.date, p.binding]));
  const unavailableDateCount = perDate.filter((p) => p.binding.status !== "RESOLVED").length;

  // 5M + 15M series on the SAME source as the data mode
  const s5 = await fetchSeries(cfg.index, cfg.dataMode, startSec, endSec, 5, dateSet, bindingByDate);
  const s15 = await fetchSeries(cfg.index, cfg.dataMode, startSec, endSec, 15, dateSet, bindingByDate);

  const vwapSource = cfg.dataMode === "FUTURES_INTERNAL" ? "FUTURES" : "SPOT";
  const otherPriceByTime = new Map<number, number>();
  if (cfg.dataMode === "FUTURES_INTERNAL") s5.candles.forEach((c) => { const sp = spotByTime.get(c.time); if (sp != null) otherPriceByTime.set(c.time, sp); });

  const repBinding: FuturesBinding = (() => {
    for (let i = perDate.length - 1; i >= 0; i--) if (perDate[i].binding.status === "RESOLVED") return perDate[i].binding;
    return perDate[perDate.length - 1]?.binding ?? { underlying: m.nseSymbol, futuresSymbol: null, securityId: null, expiry: null, exchangeSegment: null, lotSize: null, status: "UNAVAILABLE_HISTORICAL", bindingReason: "no resolved contract" };
  })();

  const expiryForDate = (sec: number) => {
    const d = istDate(sec); const b = bindingByDate.get(d);
    if (!b || !b.expiry) return { expiryDate: null, daysToExpiry: null, isExpiryDay: false };
    const expMs = Date.parse(b.expiry + "T10:00:00Z");
    return { expiryDate: b.expiry, daysToExpiry: Math.round((expMs - sec * 1000) / DAY), isExpiryDay: d === b.expiry };
  };

  const bindingStatusByTime = new Map<number, "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID">();
  s5.candles.forEach((c) => bindingStatusByTime.set(c.time, cfg.dataMode === "FUTURES_INTERNAL" ? "RESOLVED" : (bindingByDate.get(istDate(c.time))?.status ?? "UNAVAILABLE_HISTORICAL")));

  // Test A — existing engine on 5M (identical data), unchanged logic
  const a = runEngine({ config: cfg, binding: repBinding, candles: s5.candles, oi: s5.oi, oiStatus: s5.oiStatus, vwapSource, expiryForDate, symbol: m.internalSymbol, otherPriceByTime, bindingStatusByTime, vwapInstrument: s5.vwapInstrument });

  const htfInput = {
    config: cfg, inst, candles5: s5.candles, candles15: s15.candles, oi5: s5.oi, oiStatus: s5.oiStatus,
    vwapSource: vwapSource as any, vwapInstrument: s5.vwapInstrument, binding: repBinding, symbol: m.internalSymbol, expiryForDate, otherPriceByTime,
  };
  const testB = runHtfEngine({ ...htfInput, applyRiskGates: false });
  const testC = runHtfEngine({ ...htfInput, applyRiskGates: true });

  return {
    config: cfg, binding: repBinding, dataMode: cfg.dataMode,
    dataRange: { from: s5.candles.length ? istDate(s5.candles[0].time) : "—", to: s5.candles.length ? istDate(s5.candles[s5.candles.length - 1].time) : "—", candles5: s5.candles.length, candles15: s15.candles.length },
    oiStatus: s5.oiStatus, unavailableDateCount,
    testA: { rows: a.rows, trades: a.trades, metrics: a.metrics, daily: a.daily, gateBlocks: a.gateBlocks },
    testB, testC, dir15: testC.dir15, candles5: s5.candles, candles15: s15.candles,
  };
}
