// ===========================================================================
// V1.2 HTF ENGINE — 15M DIRECTION -> 5M TIMING -> RISK GATES
// ===========================================================================
// Order is fixed: (1) 15M answers "what direction?", (2) 5M answers "is this a
// good moment?", (3) risk gates answer "is it safe & economic?". Direction gates
// which side the 5M engine may even look for. STRICTLY CAUSAL: a 5M candle only
// sees 15M candles that have FULLY CLOSED by the time it closes; no 1m/3m data;
// entry is the NEXT 5M candle open. Reuses the existing component math and the
// existing trade-lifecycle walker (identical outcome accounting). No parameter
// optimization; no hard-coded dates/prices.

import { Candle } from "../types";
import { AuditRow, ComponentScores, DailyRow, FinalSignal, FuturesBinding, InternalState, MasterDirection, Metrics, TestConfig, VwapEvent, VwapSource } from "./types";
import { InstrumentConfig } from "./instrumentConfig";
import { emaSeries, atrSeries, vwapSeries, utBot, linReg, supportResistance, volumeState, structureAt } from "./components";
import { walkOutcomes, computeMetrics, computeDaily } from "./engine";

const istMinuteOfDay = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);
const istIso = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 19).replace("T", " ") + " IST";
const off = (cfg: TestConfig, n: string) => (cfg.ablationDisable || []).includes(n);
const WINDOW = 120;

export interface Dir15 {
  time: number; iso: string; master: MasterDirection; confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  score: number; ema: "UP" | "DOWN" | "FLAT"; vwapSide: "ABOVE" | "BELOW" | "AT"; structure: string; regime: string;
  bull: number; bear: number;
}

export interface HtfInput {
  config: TestConfig;
  inst: InstrumentConfig;
  candles5: Candle[];
  candles15: Candle[];
  oi5: (number | null)[];
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  vwapSource: VwapSource;
  vwapInstrument: string;
  binding: FuturesBinding;
  symbol: string;
  expiryForDate: (sec: number) => { expiryDate: string | null; daysToExpiry: number | null; isExpiryDay: boolean };
  otherPriceByTime?: Map<number, number>;
  applyRiskGates: boolean;     // Test B = false (direction+timing only), Test C = true
}

export interface HtfResult {
  rows: AuditRow[]; trades: AuditRow[]; metrics: Metrics; daily: DailyRow[];
  gateBlocks: Record<string, number>;
  dir15: Dir15[];
  diagnostics: {
    directionDistribution: Record<string, number>;
    vwapEventCounts: Record<string, number>;
    masterDirectionCandles: number;
    neutralOrConflictCandles: number;
    entryCandidates: number;
  };
}

// ---- 15M master direction (independent bullish/bearish evidence) ----
function classify(bull: number, bear: number): { master: MasterDirection; confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE" } {
  const net = bull - bear;
  const conf = Math.abs(net) >= 3 ? "HIGH" : Math.abs(net) === 2 ? "MEDIUM" : Math.abs(net) === 1 ? "LOW" : "NONE";
  if (bull >= 2 && bear >= 2) return { master: "CONFLICT", confidence: conf };
  if (bull >= 4 && bear === 0) return { master: "STRONG_BULLISH", confidence: "HIGH" };
  if (bear >= 4 && bull === 0) return { master: "STRONG_BEARISH", confidence: "HIGH" };
  if (net >= 2) return { master: "BULLISH", confidence: conf };
  if (net <= -2) return { master: "BEARISH", confidence: conf };
  return { master: "NEUTRAL", confidence: conf };
}

export function direction15Series(c15: Candle[], cfg: TestConfig): Dir15[] {
  const ema9 = emaSeries(c15, cfg.emaFast), ema21 = emaSeries(c15, cfg.emaSlow);
  const vw = vwapSeries(c15); const closes = c15.map((c) => c.close);
  const out: Dir15[] = [];
  for (let j = 0; j < c15.length; j++) {
    const c = c15[j], e9 = ema9[j] ?? null, e21 = ema21[j] ?? null, v = vw[j] ?? null;
    const win = c15.slice(Math.max(0, j - WINDOW + 1), j + 1);
    const { structure } = off(cfg, "BOS") ? { structure: "Ranging" } : structureAt(win);
    const reg = off(cfg, "LINEAR_REGRESSION") ? { direction: "FLAT" as const } : linReg(closes.slice(Math.max(0, j - cfg.regLookback + 1), j + 1));
    const emaDir: "UP" | "DOWN" | "FLAT" = e9 != null && e21 != null ? (e9 > e21 ? "UP" : e9 < e21 ? "DOWN" : "FLAT") : "FLAT";
    const vwapSide: "ABOVE" | "BELOW" | "AT" = v != null ? (c.close > v ? "ABOVE" : c.close < v ? "BELOW" : "AT") : "AT";
    let bull = 0, bear = 0;
    if (emaDir === "UP") bull++; else if (emaDir === "DOWN") bear++;
    if (vwapSide === "ABOVE") bull++; else if (vwapSide === "BELOW") bear++;
    if (structure.startsWith("Bullish")) bull++; else if (structure.startsWith("Bearish")) bear++;
    if (reg.direction === "UP") bull++; else if (reg.direction === "DOWN") bear++;
    const { master, confidence } = classify(bull, bear);
    const regime = emaDir === "UP" && reg.direction === "UP" ? "TRENDING UP" : emaDir === "DOWN" && reg.direction === "DOWN" ? "TRENDING DOWN" : "RANGE";
    out.push({ time: c.time, iso: istIso(c.time), master, confidence, score: (bull - bear) * 25, ema: emaDir, vwapSide, structure, regime, bull, bear });
  }
  return out;
}

// map each 5M candle to the latest 15M bar fully CLOSED by the 5M close (causal)
function map5to15(c5: Candle[], c15: Candle[]): number[] {
  const idx: number[] = new Array(c5.length).fill(-1);
  let j = 0;
  for (let i = 0; i < c5.length; i++) {
    const close5 = c5[i].time + 300; // 5M candle close epoch
    while (j < c15.length && c15[j].time + 900 <= close5) j++; // advance past all 15M closed by now
    idx[i] = j - 1; // last fully-closed 15M
  }
  return idx;
}

// ---- 5M VWAP event (causal; master-direction aware) ----
function vwapEventAt(c5: Candle[], vw: (number | null)[], atr: (number | null)[], i: number, master: MasterDirection): VwapEvent {
  const v = vw[i], a = atr[i] ?? null, cur = c5[i], prev = i > 0 ? c5[i - 1] : null, pv = i > 0 ? vw[i - 1] : null;
  if (v == null) return "NONE";
  const dist = a ? (cur.close - v) / a : (cur.close - v);
  const near = a ? Math.abs(cur.close - v) < 0.35 * a : Math.abs(cur.close - v) < v * 0.0015;
  const bearish = master === "BEARISH" || master === "STRONG_BEARISH";
  const bullish = master === "BULLISH" || master === "STRONG_BULLISH";
  if (bearish) {
    if (cur.high >= v && cur.close < v && cur.close <= cur.open) return "REJECTION"; // poked up to VWAP, closed back below
    if (prev && pv != null && prev.close >= pv && cur.close < v) return "BREAK";      // was above, broke below
    if (dist < -0.4) return "CONFIRMED";                                              // decisively below
    if (cur.close < v && near) return "RETEST";                                       // hovering just below
    if (near) return "TOUCH";
    if (Math.abs(dist) < 0.9) return "APPROACHING";
    if (cur.close > v && prev && prev.close < pv!) return "FAILED";                   // failed to stay below
    return "NONE";
  }
  if (bullish) {
    if (cur.low <= v && cur.close > v && cur.close >= cur.open) return "REJECTION";   // dipped to VWAP, closed back above
    if (prev && pv != null && prev.close <= pv && cur.close > v) return "BREAK";
    if (dist > 0.4) return "CONFIRMED";
    if (cur.close > v && near) return "RETEST";
    if (near) return "TOUCH";
    if (Math.abs(dist) < 0.9) return "APPROACHING";
    if (cur.close < v && prev && prev.close > pv!) return "FAILED";
    return "NONE";
  }
  return near ? "TOUCH" : "NONE";
}
const TRIGGER_EVENTS: VwapEvent[] = ["REJECTION", "BREAK", "CONFIRMED", "RETEST"];

export function runHtfEngine(input: HtfInput): HtfResult {
  const { config: cfg, candles5: c5, candles15: c15, oi5, oiStatus, vwapSource, vwapInstrument, binding, symbol, expiryForDate, otherPriceByTime: otherByTime, applyRiskGates } = input;
  const n = c5.length;
  const dir15 = direction15Series(c15, cfg);
  const map = map5to15(c5, c15);

  const closes5 = c5.map((c) => c.close);
  const ema9 = emaSeries(c5, cfg.emaFast), ema21 = emaSeries(c5, cfg.emaSlow);
  const atr = atrSeries(c5, cfg.atrPeriod), vw = vwapSeries(c5);
  const ut = utBot(c5, cfg.utKeyValue, cfg.utAtrPeriod);

  const rows: AuditRow[] = [];
  const gateBlocks: Record<string, number> = {};
  const bump = (k: string) => { gateBlocks[k] = (gateBlocks[k] || 0) + 1; };
  const vwapEventCounts: Record<string, number> = {};
  const directionDistribution: Record<string, number> = {};
  let entryCandidates = 0;

  for (let i = 0; i < n; i++) {
    const c = c5[i], price = c.close, a = atr[i] ?? null;
    const atrPct = a != null && price ? +(a / price * 100).toFixed(3) : null;
    const e9 = ema9[i] ?? null, e21 = ema21[i] ?? null, v = vw[i] ?? null;
    const win = c5.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const volWin = c5.slice(Math.max(0, i - cfg.volLookback), i).map((x) => x.volume);
    const { structure, bos } = off(cfg, "BOS") ? { structure: "Ranging", bos: "NONE" } : structureAt(win);
    const { support, resistance } = supportResistance(win, price);
    const reg = off(cfg, "LINEAR_REGRESSION") ? { direction: "FLAT" as const, slope: 0, r2: 0 } : linReg(closes5.slice(Math.max(0, i - cfg.regLookback + 1), i + 1));
    const vState = off(cfg, "VOLUME") ? "UNKNOWN" : volumeState(volWin, c.volume, cfg.volExpansionMult, cfg.volWeakMult);
    const utState = off(cfg, "UT") ? "NEUTRAL" : ut[i];
    const fake = off(cfg, "FAKE_MOVE") ? false : (() => { const d = win; if (d.length < 6) return false; const j = d.length - 1; const prior = d.slice(Math.max(0, j - 6), j); const ph = Math.max(...prior.map((x) => x.high)); const pl = Math.min(...prior.map((x) => x.low)); return (d[j].high > ph && d[j].close < ph) || (d[j].low < pl && d[j].close > pl); })();
    const emaDir: "UP" | "DOWN" | "FLAT" = e9 != null && e21 != null ? (e9 > e21 ? "UP" : e9 < e21 ? "DOWN" : "FLAT") : "FLAT";
    const priceVsEMA: "ABOVE" | "BELOW" | "AT" = e9 != null ? (price > e9 ? "ABOVE" : price < e9 ? "BELOW" : "AT") : "AT";
    const emaSpread = e9 != null && e21 != null ? +(e9 - e21).toFixed(2) : null;
    const emaSpreadATR = emaSpread != null && a ? +(Math.abs(emaSpread) / a).toFixed(2) : null;
    const distEmaATR = e9 != null && a ? Math.abs(price - e9) / a : 0;
    const extended = off(cfg, "EXTENDED_MOVE") ? false : distEmaATR > cfg.extendedAtrMult;
    const exp = expiryForDate(c.time);
    const expiryRisk: "LOW" | "MEDIUM" | "HIGH" = exp.daysToExpiry == null ? "LOW" : exp.daysToExpiry <= 0 ? "HIGH" : exp.daysToExpiry <= 1 ? "MEDIUM" : "LOW";

    const d15 = map[i] >= 0 ? dir15[map[i]] : null;
    const master: MasterDirection = d15 ? d15.master : "NEUTRAL";
    directionDistribution[master] = (directionDistribution[master] || 0) + 1;
    const vwapEvent = vwapEventAt(c5, vw, atr, i, master);
    vwapEventCounts[vwapEvent] = (vwapEventCounts[vwapEvent] || 0) + 1;

    // ---- component scores (independent BUY/SELL; direction from 15M) ----
    const bull = (b: boolean) => (b ? 1 : 0);
    const participation = vState === "EXPANSION" ? 1 : vState === "NORMAL" ? 0.6 : vState === "WEAK" ? 0.2 : 0.4;
    const volOk = atrPct != null ? bull(atrPct > 0.03 && atrPct < 3) : 0.5;
    const comp: ComponentScores = {
      trend: +(((emaDir === "UP" ? 1 : emaDir === "DOWN" ? 0 : 0.5)) * 100).toFixed(0),
      structure: +((structure.startsWith("Bullish") ? 1 : structure.startsWith("Bearish") ? 0 : 0.5) * 100).toFixed(0),
      participation: +(participation * 100).toFixed(0), momentum: +((emaSpreadATR ?? 0) > 0.2 ? 100 : 0).toFixed(0), volatility: +(volOk * 100).toFixed(0),
    };
    // direction score from 15M; timing score from 5M alignment in that direction
    const directionScore15 = d15 ? d15.score : 0;
    const bearishTiming = (TRIGGER_EVENTS.includes(vwapEvent) ? 40 : vwapEvent === "TOUCH" ? 15 : 0)
      + (emaDir === "DOWN" || priceVsEMA === "BELOW" ? 20 : 0)
      + (structure.startsWith("Bearish") ? 15 : structure.startsWith("Ranging") ? 7 : 0)
      + (utState === "BEARISH" ? 15 : 0) + (vState === "EXPANSION" ? 10 : vState === "NORMAL" ? 5 : 0);
    const bullishTiming = (TRIGGER_EVENTS.includes(vwapEvent) ? 40 : vwapEvent === "TOUCH" ? 15 : 0)
      + (emaDir === "UP" || priceVsEMA === "ABOVE" ? 20 : 0)
      + (structure.startsWith("Bullish") ? 15 : structure.startsWith("Ranging") ? 7 : 0)
      + (utState === "BULLISH" ? 15 : 0) + (vState === "EXPANSION" ? 10 : vState === "NORMAL" ? 5 : 0);
    const isBear = master === "BEARISH" || master === "STRONG_BEARISH";
    const isBull = master === "BULLISH" || master === "STRONG_BULLISH";
    const timingScore5 = isBear ? bearishTiming : isBull ? bullishTiming : 0;
    const buyScore = Math.round((isBull ? 50 : 0) + (isBull ? bullishTiming / 2 : 0) + comp.trend * 0.0);
    const sellScore = Math.round((isBear ? 50 : 0) + (isBear ? bearishTiming / 2 : 0));

    // ---- entry candidate: ONLY in the 15M master direction, timing valid ----
    let entryCandidate: FinalSignal = "NONE" as any;
    const timingValid = (dir: "BUY" | "SELL") => {
      if (!TRIGGER_EVENTS.includes(vwapEvent)) return false;
      if (dir === "SELL") return (emaDir !== "UP" || priceVsEMA === "BELOW") && !structure.startsWith("Bullish/conf") && utState !== "BULLISH";
      return (emaDir !== "DOWN" || priceVsEMA === "ABOVE") && !structure.startsWith("Bearish/conf") && utState !== "BEARISH";
    };
    if (isBear && timingValid("SELL")) entryCandidate = "SELL";
    else if (isBull && timingValid("BUY")) entryCandidate = "BUY";
    else entryCandidate = "WAIT";
    if (entryCandidate !== "WAIT") entryCandidates++;

    // ---- data quality ----
    const dqReasons: string[] = []; let dq: "PASS" | "WARNING" | "BLOCKED" = "PASS";
    const invalidCandle = !(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0) || c.high < c.low;
    if (invalidCandle) { dq = "BLOCKED"; dqReasons.push("INVALID CANDLE"); }
    if (i < cfg.minHistory) { dq = "BLOCKED"; dqReasons.push("INSUFFICIENT HISTORY"); }
    if (map[i] < 1) { dq = "BLOCKED"; dqReasons.push("INSUFFICIENT 15M HISTORY"); }
    if (v == null) { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("INVALID VWAP"); }
    if (vState === "UNKNOWN") { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("MISSING VOLUME"); }
    if (oiStatus === "UNAVAILABLE") { if (cfg.dataMode === "FUTURES_INTERNAL") { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("HISTORICAL OI UNAVAILABLE"); } else { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("OI UNAVAILABLE (spot research)"); } }

    // ---- build signal + risk gates ----
    let hardGate = false, hardGateReason = ""; const block = (r: string) => { if (!hardGate) { hardGate = true; hardGateReason = r; bump(r); } };
    let signal: FinalSignal = "WAIT";
    let entry: number | null = null, sl: number | null = null, t1: number | null = null, t2: number | null = null, rr: number | null = null;
    const next = c5[i + 1];
    const lateMin = istMinuteOfDay(c.time); const isLate = lateMin >= cfg.lateCutoffMinIST;

    if (master === "NEUTRAL") block("DIRECTION NEUTRAL");
    else if (master === "CONFLICT") block("DIRECTION CONFLICT");
    else if (dq === "BLOCKED") block(dqReasons[0] || "DATA QUALITY");
    else if (entryCandidate === "WAIT") block("NO 5M TIMING TRIGGER");
    else {
      // compute entry/sl/target (same formulas as the base engine)
      const dir = entryCandidate;
      if (!next) block("NO EXECUTABLE CANDLE");
      else {
        entry = next.open;
        if (dir === "SELL") {
          const inval = resistance != null ? resistance : price + (a ?? price * 0.003);
          sl = +(inval + (a ?? 0) * cfg.slAtrBuffer).toFixed(2); const risk = sl - entry;
          t1 = support != null && support < entry ? support : +(entry - (a ?? 0) * cfg.targetAtrMult).toFixed(2);
          rr = risk > 0 ? +((entry - t1) / risk).toFixed(2) : 0; t2 = +(entry - (entry - t1) * 1.6).toFixed(2);
          if (applyRiskGates) {
            if (fake) block("FAKE MOVE"); else if (extended) block("EXTENDED MOVE");
            else if (expiryRisk === "HIGH" && exp.isExpiryDay) block("EXPIRY RISK"); else if (isLate) block("LATE CUTOFF");
            else if (!(risk > 0)) block("INVALID STRUCTURE");
            else if (cfg.rrGateMode !== "OFF" && (rr ?? 0) < cfg.rrMin) block("R:R BELOW MIN");
            else signal = "SELL";
          } else { if (risk > 0) signal = "SELL"; else block("INVALID STRUCTURE"); }
        } else {
          const inval = support != null ? support : price - (a ?? price * 0.003);
          sl = +(inval - (a ?? 0) * cfg.slAtrBuffer).toFixed(2); const risk = entry - sl;
          t1 = resistance != null && resistance > entry ? resistance : +(entry + (a ?? 0) * cfg.targetAtrMult).toFixed(2);
          rr = risk > 0 ? +((t1 - entry) / risk).toFixed(2) : 0; t2 = +(entry + (t1 - entry) * 1.6).toFixed(2);
          if (applyRiskGates) {
            if (fake) block("FAKE MOVE"); else if (extended) block("EXTENDED MOVE");
            else if (expiryRisk === "HIGH" && exp.isExpiryDay) block("EXPIRY RISK"); else if (isLate) block("LATE CUTOFF");
            else if (!(risk > 0)) block("INVALID STRUCTURE");
            else if (cfg.rrGateMode !== "OFF" && (rr ?? 0) < cfg.rrMin) block("R:R BELOW MIN");
            else signal = "BUY";
          } else { if (risk > 0) signal = "BUY"; else block("INVALID STRUCTURE"); }
        }
      }
    }

    // internal state (telemetry)
    let internal: InternalState = "NONE";
    if (extended) internal = "EXTENDED"; else if (fake) internal = "REVERSAL";
    else if (entryCandidate !== "WAIT" && bos.includes("CONFIRMED")) internal = "CONFIRMED";
    else if (entryCandidate !== "WAIT" && TRIGGER_EVENTS.includes(vwapEvent)) internal = "TRIGGER";
    else if (entryCandidate !== "WAIT") internal = "EARLY";
    else if (master !== "NEUTRAL" && master !== "CONFLICT") internal = "PRE-MOVE";

    const other = otherByTime?.get(c.time);
    const oiNow = oiStatus === "AVAILABLE" ? (oi5[i] ?? null) : null;
    const oiPrev = oiStatus === "AVAILABLE" ? (i > 0 ? (oi5[i - 1] ?? null) : null) : null;
    const oiChg = oiNow != null && oiPrev != null ? oiNow - oiPrev : null;
    const primaryReason = signal !== "WAIT"
      ? `15M ${master} + 5M ${vwapEvent} + ${signal === "SELL" ? "bearish" : "bullish"} timing`
      : (hardGate ? hardGateReason : "no setup");

    rows.push({
      timestamp: c.time, iso: istIso(c.time), symbol, timeframe: cfg.timeframe, spotPrice: price,
      futuresSymbol: binding.status === "RESOLVED" ? binding.futuresSymbol : null,
      futuresSecurityId: binding.status === "RESOLVED" ? binding.securityId : null,
      futuresPrice: cfg.dataMode === "FUTURES_INTERNAL" ? price : (other ?? null),
      futuresVolume: vwapSource === "FUTURES" ? c.volume : null,
      futuresOI: oiNow, previousOI: oiPrev, oiChange: oiChg, oiChangePercent: oiChg != null && oiPrev ? +((oiChg / oiPrev) * 100).toFixed(3) : null,
      oiStatus,
      basis: other != null ? +(cfg.dataMode === "FUTURES_INTERNAL" ? price - other : other - price).toFixed(2) : null,
      basisPercent: null, dataModeUsed: cfg.dataMode, bindingStatusForDate: binding.status, contractChange: false,
      vwap: v != null ? +v.toFixed(2) : null, vwapSource, vwapInstrument, vwapSessionDate: istDate(c.time),
      ema9: e9 != null ? +e9.toFixed(2) : null, ema21: e21 != null ? +e21.toFixed(2) : null,
      emaDirection: emaDir, priceVsEMA, emaSpread, emaSpreadATR, utState,
      structureState: structure, bos, volumeState: vState, atr: a != null ? +a.toFixed(2) : null, atrPercent: atrPct,
      regressionDirection: reg.direction, regressionSlope: reg.slope, regressionR2: reg.r2,
      support: support != null ? +support.toFixed(2) : null, resistance: resistance != null ? +resistance.toFixed(2) : null,
      distanceToSupportATR: support != null && a ? +((price - support) / a).toFixed(2) : null,
      distanceToResistanceATR: resistance != null && a ? +((resistance - price) / a).toFixed(2) : null,
      fakeMove: fake, extendedMove: extended ? "EXTENDED" : "NORMAL",
      buyScore, sellScore, components: comp, internalState: internal,
      signal, signalTimestamp: c.time, signalClose: price,
      entry, entryTimestamp: signal !== "WAIT" && next ? next.time : null,
      stopLoss: signal !== "WAIT" ? sl : null, target1: signal !== "WAIT" ? t1 : null, target2: signal !== "WAIT" ? t2 : null, rr: signal !== "WAIT" ? rr : null,
      expiryDate: exp.expiryDate, daysToExpiry: exp.daysToExpiry, isExpiryDay: exp.isExpiryDay, expiryRisk,
      dataQuality: dq, dataQualityReasons: dqReasons, hardGate, hardGateReason,
      primaryReason, secondaryReasons: [], regime: d15 ? d15.regime : "RANGE",
      outcome: "NONE", exitPrice: null, exitTimestamp: null, mfe: null, mae: null, rMultiple: null, holdBars: null,
      timingClassification: "NA", fillAmbiguity: false,
      // HTF telemetry
      masterDirection: master, directionConfidence: d15 ? d15.confidence : "NONE",
      directionScore15, timingScore5, riskScore: hardGate ? 0 : 100,
      vwapEvent, entryCandidate, dir15Ema: d15?.ema, dir15VwapSide: d15?.vwapSide,
      dir15Structure: d15?.structure, dir15Regime: d15?.regime, dir15Iso: d15?.iso,
    });
  }

  const trades = walkOutcomes(rows, c5, cfg);
  const metrics = computeMetrics(rows, trades);
  const daily = computeDaily(rows, trades);
  const neutralOrConflict = rows.filter((r) => r.masterDirection === "NEUTRAL" || r.masterDirection === "CONFLICT").length;
  return {
    rows, trades, metrics, daily, gateBlocks, dir15,
    diagnostics: {
      directionDistribution, vwapEventCounts,
      masterDirectionCandles: rows.length - neutralOrConflict, neutralOrConflictCandles: neutralOrConflict, entryCandidates,
    },
  };
}
