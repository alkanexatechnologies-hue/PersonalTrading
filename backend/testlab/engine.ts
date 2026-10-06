// Universal Indicator engine (research). Strict no-lookahead: the signal at a
// closed candle i is computed from candles[0..i] only; entry is the NEXT
// candle's open; outcomes are a forward walk recorded as OUTCOME (never fed back
// as input). Independent BUY/SELL scores. Hard gates override scores. No param
// optimization — the baseline config is fixed.

import { Candle } from "../types";
import {
  AuditRow, ComponentScores, FinalSignal, FuturesBinding, InternalState, Metrics,
  Outcome, TestConfig, Timing, VolumeState, VwapSource, DailyRow, GateStatus,
} from "./types";
import { TF_MINUTES } from "./config";
import { emaSeries, atrSeries, vwapSeries, utBot, linReg, supportResistance, volumeState, structureAt, fakeMoveAt } from "./components";

export interface EngineInput {
  config: TestConfig;
  binding: FuturesBinding;
  candles: Candle[];            // signal series (futures if resolved+fetched, else spot)
  oi: (number | null)[];
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  vwapSource: VwapSource;
  spotForDisplay?: Candle[];    // index spot (for display when signal series is futures)
  expiryForDate: (ms: number) => { expiryDate: string | null; daysToExpiry: number | null; isExpiryDay: boolean };
  symbol: string;
  // §4/§5/§7: the "other" instrument price keyed by candle epoch sec (spot when
  // the signal series is futures, futures when the signal series is spot) — used
  // ONLY to record basis, never as a signal condition.
  otherPriceByTime?: Map<number, number>;
  // §1/§2: per-candle historical binding status (by epoch sec) + contract-change
  // marks for the dates where the active futures contract rolled.
  bindingStatusByTime?: Map<number, "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID">;
  contractChangeTimes?: Set<number>;
  vwapInstrument?: string;      // §7 instrument the VWAP series belongs to
  // Leading candles that precede the test window: they feed indicators/history
  // (causal) but produce no audit rows, signals or trades.
  warmupCount?: number;
}

const istMinuteOfDay = (epochSec: number) => Math.floor(((epochSec + 19800) % 86400) / 60);
const istDate = (epochSec: number) => new Date(epochSec * 1000 + 19800000).toISOString().slice(0, 10);
const istIso = (epochSec: number) => new Date(epochSec * 1000 + 19800000).toISOString().slice(0, 19).replace("T", " ") + " IST";
const WINDOW = 120; // trailing window for structure / S-R (bounded, backward-only)

function off(cfg: TestConfig, name: string): boolean { return (cfg.ablationDisable || []).includes(name); }

export function runEngine(input: EngineInput): { rows: AuditRow[]; trades: AuditRow[]; metrics: Metrics; daily: DailyRow[]; gateBlocks: Record<string, number> } {
  const { config: cfg, binding, candles, oi, oiStatus, vwapSource, expiryForDate, symbol } = input;
  const otherByTime = input.otherPriceByTime;
  const bindByTime = input.bindingStatusByTime;
  const changeTimes = input.contractChangeTimes;
  const vwapInstrument = input.vwapInstrument ?? (vwapSource === "FUTURES" ? (binding.futuresSymbol || null) : symbol);
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const ema9 = emaSeries(candles, cfg.emaFast);
  const ema21 = emaSeries(candles, cfg.emaSlow);
  const atr = atrSeries(candles, cfg.atrPeriod);
  const vwp = vwapSeries(candles);
  const ut = utBot(candles, cfg.utKeyValue, cfg.utAtrPeriod);

  const rows: AuditRow[] = [];
  const gateBlocks: Record<string, number> = {};
  const bump = (k: string) => { gateBlocks[k] = (gateBlocks[k] || 0) + 1; };

  const warmup = Math.min(Math.max(0, input.warmupCount ?? 0), n);
  for (let i = warmup; i < n; i++) {
    const c = candles[i];
    const price = c.close;
    const a = atr[i] ?? null;
    const atrPct = a != null && price ? +(a / price * 100).toFixed(3) : null;
    const e9 = ema9[i] ?? null, e21 = ema21[i] ?? null;
    const vw = vwp[i] ?? null;
    const win = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const volWin = candles.slice(Math.max(0, i - cfg.volLookback), i).map((x) => x.volume);
    const { structure, bos } = off(cfg, "BOS") ? { structure: "Ranging", bos: "NONE" } : structureAt(win);
    const { support, resistance, supports, resistances } = supportResistance(win, price);
    const reg = off(cfg, "LINEAR_REGRESSION") ? { direction: "FLAT" as const, slope: 0, r2: 0 } : linReg(closes.slice(Math.max(0, i - cfg.regLookback + 1), i + 1));
    const vState: VolumeState = off(cfg, "VOLUME") ? "UNKNOWN" : volumeState(volWin, c.volume, cfg.volExpansionMult, cfg.volWeakMult);
    const utState = off(cfg, "UT") ? "NEUTRAL" : ut[i];
    const fake = off(cfg, "FAKE_MOVE") ? false : fakeMoveAt(win);
    const emaDir: "UP" | "DOWN" | "FLAT" = e9 != null && e21 != null ? (e9 > e21 ? "UP" : e9 < e21 ? "DOWN" : "FLAT") : "FLAT";
    const priceVsEMA: "ABOVE" | "BELOW" | "AT" = e9 != null ? (price > e9 ? "ABOVE" : price < e9 ? "BELOW" : "AT") : "AT";
    const emaSpread = e9 != null && e21 != null ? +(e9 - e21).toFixed(2) : null;
    const emaSpreadATR = emaSpread != null && a ? +(Math.abs(emaSpread) / a).toFixed(2) : null;
    const distSupATR = support != null && a ? +((price - support) / a).toFixed(2) : null;
    const distResATR = resistance != null && a ? +((resistance - price) / a).toFixed(2) : null;
    const distEmaATR = e9 != null && a ? Math.abs(price - e9) / a : 0;
    const extended = off(cfg, "EXTENDED_MOVE") ? false : distEmaATR > cfg.extendedAtrMult;

    const exp = expiryForDate(c.time);
    const isExpiryDay = exp.isExpiryDay;
    const expiryRisk: "LOW" | "MEDIUM" | "HIGH" = exp.daysToExpiry == null ? "LOW" : exp.daysToExpiry <= 0 ? "HIGH" : exp.daysToExpiry <= 1 ? "MEDIUM" : "LOW";

    // ---- scoring (independent BUY/SELL; grouped; correlated trend inputs averaged) ----
    const bull = (b: boolean) => (b ? 1 : 0);
    const trendBull = off(cfg, "EMA") && off(cfg, "VWAP") && off(cfg, "UT") ? 0 :
      avg([
        off(cfg, "EMA") ? null : bull(emaDir === "UP" && priceVsEMA === "ABOVE"),
        off(cfg, "UT") ? null : bull(utState === "BULLISH"),
        off(cfg, "VWAP") ? null : (vw != null ? bull(price > vw) : null),
        off(cfg, "LINEAR_REGRESSION") ? null : bull(reg.direction === "UP"),
      ]);
    const trendBear = off(cfg, "EMA") && off(cfg, "VWAP") && off(cfg, "UT") ? 0 :
      avg([
        off(cfg, "EMA") ? null : bull(emaDir === "DOWN" && priceVsEMA === "BELOW"),
        off(cfg, "UT") ? null : bull(utState === "BEARISH"),
        off(cfg, "VWAP") ? null : (vw != null ? bull(price < vw) : null),
        off(cfg, "LINEAR_REGRESSION") ? null : bull(reg.direction === "DOWN"),
      ]);
    const structBull = structure.startsWith("Bullish") ? (bos.includes("CONFIRMED-UP") ? 1 : bos.includes("PRE-UP") ? 0.7 : 0.6) : structure.startsWith("Ranging") ? 0.3 : 0;
    const structBear = structure.startsWith("Bearish") ? (bos.includes("CONFIRMED-DOWN") ? 1 : bos.includes("PRE-DOWN") ? 0.7 : 0.6) : structure.startsWith("Ranging") ? 0.3 : 0;
    const participation = vState === "EXPANSION" ? 1 : vState === "NORMAL" ? 0.6 : vState === "WEAK" ? 0.2 : 0.4;
    const momBull = bull(emaDir === "UP" && (emaSpreadATR ?? 0) > 0.2 && priceVsEMA === "ABOVE");
    const momBear = bull(emaDir === "DOWN" && (emaSpreadATR ?? 0) > 0.2 && priceVsEMA === "BELOW");
    const volOk = atrPct != null ? bull(atrPct > 0.03 && atrPct < 3) : 0.5; // tradeable volatility band

    const comp: ComponentScores = {
      trend: +(trendBull * 100).toFixed(0), structure: +((structBull) * 100).toFixed(0),
      participation: +(participation * 100).toFixed(0), momentum: +(momBull * 100).toFixed(0), volatility: +(volOk * 100).toFixed(0),
    };
    const buyScore = Math.round(35 * trendBull + 30 * structBull + 15 * participation + 10 * momBull + 10 * (typeof volOk === "number" ? volOk : 0));
    const sellScore = Math.round(35 * trendBear + 30 * structBear + 15 * participation + 10 * momBear + 10 * (typeof volOk === "number" ? volOk : 0));

    const leanBuy = buyScore >= cfg.buyThreshold && buyScore >= sellScore + 10;
    const leanSell = sellScore >= cfg.sellThreshold && sellScore >= buyScore + 10;

    // ---- hard gates ----
    const dqReasons: string[] = [];
    let dq: GateStatus = "PASS";
    const invalidCandle = !(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0) || c.high < c.low;
    if (invalidCandle) { dq = "BLOCKED"; dqReasons.push("INVALID CANDLE"); }
    if (i < cfg.minHistory) { dq = "BLOCKED"; dqReasons.push("INSUFFICIENT HISTORY"); }
    if (vw == null) { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("INVALID VWAP"); }
    if (vState === "UNKNOWN") { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("MISSING VOLUME"); }
    // §1/§6/§23 — per-candle (date-correct) binding + OI data-quality.
    const candleBindingStatus = (bindByTime?.get(c.time) ?? binding.status);
    if (cfg.dataMode === "FUTURES_INTERNAL" && candleBindingStatus !== "RESOLVED") {
      if (cfg.futuresBinding === "strict") { dq = "BLOCKED"; dqReasons.push("INVALID_FUTURES_BINDING"); }
      else { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("FUTURES UNAVAILABLE (spot-fallback)"); }
    }
    if (oiStatus === "UNAVAILABLE") {
      if (cfg.dataMode === "FUTURES_INTERNAL") { dq = "BLOCKED"; dqReasons.push("HISTORICAL OI UNAVAILABLE"); }   // §6 strict
      else { if (dq !== "BLOCKED") dq = "WARNING"; dqReasons.push("OI UNAVAILABLE (spot research — price only)"); } // §4 price-only research
    }

    let hardGate = false; let hardGateReason = "";
    const block = (r: string) => { if (!hardGate) { hardGate = true; hardGateReason = r; bump(r); } };
    if (dq === "BLOCKED") block(dqReasons[0] || "DATA QUALITY");
    const lateMin = istMinuteOfDay(c.time);
    const isLate = lateMin >= cfg.lateCutoffMinIST;

    // ---- directional candidate + entry/SL/target (only if a lean exists) ----
    let signal: FinalSignal = "WAIT";
    let entry: number | null = null, sl: number | null = null, t1: number | null = null, t2: number | null = null, rr: number | null = null;
    let internal: InternalState = "NONE";
    const next = candles[i + 1];

    if (!hardGate && (leanBuy || leanSell)) {
      const dir = leanBuy ? "BUY" : "SELL";
      // gates that only matter when there IS directional intent
      if (fake) block("FAKE MOVE");
      else if (extended) block("EXTENDED MOVE");
      else if (!off(cfg, "EXPIRY_RISK") && expiryRisk === "HIGH" && isExpiryDay) block("EXPIRY RISK");
      else if (isLate) block("LATE CUTOFF");
      else if (!next) block("NO EXECUTABLE CANDLE");
      else {
        entry = next.open; // next executable candle open (no same-candle fill)
        // first S/R level at least targetMinAtr away; nearer levels are the ones being broken
        const minTgt = (a ?? 0) * (cfg.targetMinAtr ?? 0);
        // structural stop, but never further than slMaxAtr from entry
        const maxSl = (a ?? 0) * (cfg.slMaxAtr ?? 0);
        if (dir === "BUY") {
          const invalidation = support != null ? support : price - (a ?? price * 0.003);
          sl = +(invalidation - (a ?? 0) * cfg.slAtrBuffer).toFixed(2);
          if (maxSl > 0 && entry - sl > maxSl) sl = +(entry - maxSl).toFixed(2);
          const risk = entry - sl;
          const e = entry;
          const structT = minTgt > 0 ? resistances.find((r) => r > e && r - e >= minTgt) : (resistance != null && resistance > e ? resistance : undefined);
          t1 = structT != null ? structT : +(entry + (a ?? 0) * cfg.targetAtrMult).toFixed(2);
          rr = risk > 0 ? +((t1 - entry) / risk).toFixed(2) : 0;
          t2 = +(entry + (t1 - entry) * 1.6).toFixed(2);
          if (!(risk > 0)) block("INVALID STRUCTURE");
          else if (cfg.rrGateMode !== "OFF" && (rr ?? 0) < cfg.rrMin) block("R:R BELOW MIN");
          else signal = "BUY";
        } else {
          const invalidation = resistance != null ? resistance : price + (a ?? price * 0.003);
          sl = +(invalidation + (a ?? 0) * cfg.slAtrBuffer).toFixed(2);
          if (maxSl > 0 && sl - entry > maxSl) sl = +(entry + maxSl).toFixed(2);
          const risk = sl - entry;
          const e = entry;
          const structT = minTgt > 0 ? supports.find((s) => s < e && e - s >= minTgt) : (support != null && support < e ? support : undefined);
          t1 = structT != null ? structT : +(entry - (a ?? 0) * cfg.targetAtrMult).toFixed(2);
          rr = risk > 0 ? +((entry - t1) / risk).toFixed(2) : 0;
          t2 = +(entry - (entry - t1) * 1.6).toFixed(2);
          if (!(risk > 0)) block("INVALID STRUCTURE");
          else if (cfg.rrGateMode !== "OFF" && (rr ?? 0) < cfg.rrMin) block("R:R BELOW MIN");
          else signal = "SELL";
        }
      }
    }

    // internal state (research telemetry)
    if (extended) internal = "EXTENDED";
    else if (fake) internal = "REVERSAL";
    else if ((leanBuy || leanSell) && bos.includes("CONFIRMED")) internal = "CONFIRMED";
    else if ((leanBuy || leanSell) && bos.includes("PRE")) internal = "TRIGGER";
    else if (utState !== "NEUTRAL" && (leanBuy || leanSell)) internal = "EARLY";
    else if (leanBuy || leanSell) internal = "PRE-MOVE";

    const regime = classifyRegime(reg.direction, atrPct, emaDir, structure, vw, price);
    const primaryReason = signal !== "WAIT" ? reasonFor(signal, emaDir, vw, price, bos, vState) : (hardGate ? hardGateReason : (leanBuy || leanSell ? "lean present, gate pending" : "no directional edge"));
    const secondary: string[] = [];
    if (reg.direction !== "FLAT") secondary.push(`LinReg ${reg.direction} (R²${reg.r2})`);
    if (utState !== "NEUTRAL") secondary.push(`UT ${utState}`);
    secondary.push(`ATR% ${atrPct ?? "—"}`);

    // §6 causal OI change (uses only the current and previous candle).
    const oiNow = oiStatus === "AVAILABLE" ? (oi[i] ?? null) : null;
    const oiPrev = oiStatus === "AVAILABLE" ? (i > 0 ? (oi[i - 1] ?? null) : null) : null;
    const oiChg = oiNow != null && oiPrev != null ? oiNow - oiPrev : null;
    const oiChgPct = oiChg != null && oiPrev ? +((oiChg / oiPrev) * 100).toFixed(3) : null;
    // §4/§5 basis = futures - spot (recorded only; the "other" series is spot in
    // FUTURES_INTERNAL and futures in SPOT_DIRECTION).
    const other = otherByTime?.get(c.time);
    let basis: number | null = null, basisPct: number | null = null, futPrice: number | null = null;
    if (cfg.dataMode === "FUTURES_INTERNAL") { futPrice = price; if (other != null) { basis = +(price - other).toFixed(2); basisPct = other ? +((basis / other) * 100).toFixed(4) : null; } }
    else { futPrice = other != null ? other : null; if (other != null) { basis = +(other - price).toFixed(2); basisPct = price ? +((basis / price) * 100).toFixed(4) : null; } }

    rows.push({
      timestamp: c.time, iso: istIso(c.time), symbol, timeframe: cfg.timeframe,
      spotPrice: price,
      futuresSymbol: candleBindingStatus === "RESOLVED" ? binding.futuresSymbol : null,
      futuresSecurityId: candleBindingStatus === "RESOLVED" ? binding.securityId : null,
      futuresPrice: cfg.dataMode === "FUTURES_INTERNAL" ? price : futPrice,
      futuresVolume: vwapSource === "FUTURES" ? c.volume : null,
      futuresOI: oiNow,
      previousOI: oiPrev, oiChange: oiChg, oiChangePercent: oiChgPct,
      oiStatus,
      basis, basisPercent: basisPct,
      dataModeUsed: cfg.dataMode,
      bindingStatusForDate: candleBindingStatus,
      contractChange: !!changeTimes?.has(c.time),
      vwap: vw != null ? +vw.toFixed(2) : null, vwapSource,
      vwapInstrument, vwapSessionDate: istDate(c.time),
      ema9: e9 != null ? +e9.toFixed(2) : null, ema21: e21 != null ? +e21.toFixed(2) : null,
      emaDirection: emaDir, priceVsEMA, emaSpread, emaSpreadATR,
      utState, structureState: structure, bos, volumeState: vState,
      atr: a != null ? +a.toFixed(2) : null, atrPercent: atrPct,
      regressionDirection: reg.direction, regressionSlope: reg.slope, regressionR2: reg.r2,
      support: support != null ? +support.toFixed(2) : null, resistance: resistance != null ? +resistance.toFixed(2) : null,
      distanceToSupportATR: distSupATR, distanceToResistanceATR: distResATR,
      fakeMove: fake, extendedMove: extended ? "EXTENDED" : "NORMAL",
      buyScore, sellScore, components: comp, internalState: internal,
      signal, signalTimestamp: c.time, signalClose: price,
      entry, entryTimestamp: signal !== "WAIT" && next ? next.time : null,
      stopLoss: signal !== "WAIT" ? sl : null, target1: signal !== "WAIT" ? t1 : null, target2: signal !== "WAIT" ? t2 : null, rr: signal !== "WAIT" ? rr : null,
      expiryDate: exp.expiryDate, daysToExpiry: exp.daysToExpiry, isExpiryDay, expiryRisk,
      dataQuality: dq, dataQualityReasons: dqReasons, hardGate, hardGateReason,
      primaryReason, secondaryReasons: secondary, regime,
      outcome: "NONE", exitPrice: null, exitTimestamp: null, mfe: null, mae: null, rMultiple: null, holdBars: null,
      timingClassification: "NA", fillAmbiguity: false,
    });
  }

  // ---- forward-walk OUTCOMES (post-hoc; never fed back as input) ----
  const trades = walkOutcomes(rows, candles, cfg);
  const metrics = computeMetrics(rows, trades);
  const daily = computeDaily(rows, trades);
  return { rows, trades, metrics, daily, gateBlocks };
}

export function walkOutcomes(rows: AuditRow[], candles: Candle[], cfg: TestConfig): AuditRow[] {
  const trades: AuditRow[] = [];
  let openUntilIdx = -1; let cooldownUntilIdx = -1;
  // rows are the tail of candles (leading warm-up candles have no row): convert
  // candle indexes to row indexes before comparing with r.
  const rowOffset = candles.length - rows.length;
  const idxByTime = new Map<number, number>();
  candles.forEach((c, i) => idxByTime.set(c.time, i));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.signal === "WAIT" || row.entry == null) continue;
    if (cfg.oneOpenTrade && r <= openUntilIdx) continue;
    if (r <= cooldownUntilIdx) continue;
    const entryIdx = idxByTime.get(row.entryTimestamp as number);
    if (entryIdx == null) continue;
    const isBuy = row.signal === "BUY";
    const entry = row.entry!, sl = row.stopLoss!, t1 = row.target1!, t2 = row.target2!;
    const risk = isBuy ? entry - sl : sl - entry;
    let outcome: Outcome = "OPEN"; let exitPrice: number | null = null; let exitIdx = entryIdx; let fillAmbig = false;
    let mfe = 0, mae = 0;
    const entryDay = istDate(candles[entryIdx].time);
    for (let k = entryIdx; k < candles.length && k < entryIdx + cfg.timeExitBars; k++) {
      const cd = candles[k];
      // excursions in R
      const fav = isBuy ? (cd.high - entry) : (entry - cd.low);
      const adv = isBuy ? (entry - cd.low) : (cd.high - entry);
      if (risk > 0) { mfe = Math.max(mfe, fav / risk); mae = Math.max(mae, adv / risk); }
      const hitSL = isBuy ? cd.low <= sl : cd.high >= sl;
      const hitT1 = isBuy ? cd.high >= t1 : cd.low <= t1;
      const hitT2 = isBuy ? cd.high >= t2 : cd.low <= t2;
      if (hitSL && (hitT1 || hitT2)) { outcome = "SL"; exitPrice = sl; exitIdx = k; fillAmbig = true; break; } // §29 SL-first
      if (hitSL) { outcome = "SL"; exitPrice = sl; exitIdx = k; break; }
      if (hitT2) { outcome = "T2"; exitPrice = t2; exitIdx = k; break; }
      if (hitT1) { outcome = "T1"; exitPrice = t1; exitIdx = k; break; }
      if (istDate(cd.time) !== entryDay) { outcome = "EOD_EXIT"; exitPrice = cd.open; exitIdx = k; break; }
    }
    if (outcome === "OPEN") {
      const lastK = Math.min(candles.length - 1, entryIdx + cfg.timeExitBars - 1);
      outcome = "TIME_EXIT"; exitPrice = candles[lastK].close; exitIdx = lastK;
    }
    const rMultiple = risk > 0 && exitPrice != null ? +(((isBuy ? exitPrice - entry : entry - exitPrice)) / risk).toFixed(2) : null;
    row.outcome = outcome; row.exitPrice = exitPrice != null ? +exitPrice.toFixed(2) : null;
    row.exitTimestamp = candles[exitIdx]?.time ?? null; row.mfe = +mfe.toFixed(2); row.mae = +mae.toFixed(2);
    row.rMultiple = rMultiple; row.holdBars = exitIdx - entryIdx; row.fillAmbiguity = fillAmbig;
    row.timingClassification = classifyTiming(row);
    trades.push(row);
    openUntilIdx = exitIdx - rowOffset; cooldownUntilIdx = exitIdx - rowOffset + cfg.cooldownCandles;
  }
  return trades;
}

function classifyTiming(row: AuditRow): Timing {
  if (row.outcome === "SL") return "FALSE";
  const win = row.rMultiple != null && row.rMultiple > 0;
  if (!win) return "FALSE";
  if (row.bos.includes("CONFIRMED")) return "TIMELY";
  if (row.bos.includes("PRE") || row.internalState === "EARLY") return "EARLY";
  if (row.extendedMove === "EXTENDED") return "LATE";
  return "TIMELY";
}

function classifyRegime(regDir: string, atrPct: number | null, emaDir: string, structure: string, vw: number | null, price: number): string {
  const hiVol = atrPct != null && atrPct > 1.2;
  const loVol = atrPct != null && atrPct < 0.2;
  if (regDir === "UP" && emaDir === "UP") return "TRENDING UP";
  if (regDir === "DOWN" && emaDir === "DOWN") return "TRENDING DOWN";
  if (hiVol) return "HIGH VOLATILITY";
  if (loVol) return "LOW VOLATILITY";
  return "RANGE";
}

function reasonFor(sig: FinalSignal, emaDir: string, vw: number | null, price: number, bos: string, vol: VolumeState): string {
  const parts: string[] = [];
  if (emaDir !== "FLAT") parts.push("EMA");
  if (vw != null) parts.push("VWAP");
  if (bos !== "NONE") parts.push("BOS");
  if (vol === "EXPANSION") parts.push("Volume");
  return parts.join("+") || sig;
}

export function computeMetrics(rows: AuditRow[], trades: AuditRow[]): Metrics {
  const buy = rows.filter((r) => r.signal === "BUY").length;
  const sell = rows.filter((r) => r.signal === "SELL").length;
  const wait = rows.filter((r) => r.signal === "WAIT").length;
  const rs = trades.map((t) => t.rMultiple ?? 0);
  const wins = trades.filter((t) => (t.rMultiple ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.rMultiple ?? 0) < 0).length;
  const be = trades.filter((t) => (t.rMultiple ?? 0) === 0).length;
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const timing: Record<Timing, number> = { EARLY: 0, TIMELY: 0, LATE: 0, FALSE: 0, MISSED: 0, NA: 0 };
  trades.forEach((t) => { timing[t.timingClassification] = (timing[t.timingClassification] || 0) + 1; });
  const outcomes: Record<string, number> = {};
  trades.forEach((t) => { outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1; });
  // max drawdown on cumulative R
  let cum = 0, peak = 0, maxDD = 0;
  trades.forEach((t) => { cum += t.rMultiple ?? 0; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak); });
  const days = new Set(rows.map((r) => istDate(r.timestamp)));
  const expiryDays = new Set(rows.filter((r) => r.isExpiryDay).map((r) => istDate(r.timestamp)));
  const sorted = [...rs].sort((a, b) => a - b);
  return {
    totalCandles: rows.length, buy, sell, wait, totalTrades: trades.length,
    wins, losses, breakeven: be,
    winRate: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
    lossRate: trades.length ? +(losses / trades.length * 100).toFixed(1) : 0,
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : 0,
    medianR: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(3) : 0,
    expectancy: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : 0,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : 0),
    maxDrawdownR: +maxDD.toFixed(2),
    avgMFE: trades.length ? +(trades.reduce((a, b) => a + (b.mfe ?? 0), 0) / trades.length).toFixed(2) : 0,
    avgMAE: trades.length ? +(trades.reduce((a, b) => a + (b.mae ?? 0), 0) / trades.length).toFixed(2) : 0,
    avgHoldBars: trades.length ? +(trades.reduce((a, b) => a + (b.holdBars ?? 0), 0) / trades.length).toFixed(1) : 0,
    timing, outcomes, normalDays: days.size - expiryDays.size, expiryDays: expiryDays.size,
  };
}

export function computeDaily(rows: AuditRow[], trades: AuditRow[]): DailyRow[] {
  const byDay = new Map<string, AuditRow[]>();
  rows.forEach((r) => { const d = istDate(r.timestamp); (byDay.get(d) || byDay.set(d, []).get(d)!).push(r); });
  const tradesByDay = new Map<string, AuditRow[]>();
  trades.forEach((t) => { const d = istDate(t.timestamp); (tradesByDay.get(d) || tradesByDay.set(d, []).get(d)!).push(t); });
  const out: DailyRow[] = [];
  for (const [date, drows] of byDay) {
    const dt = tradesByDay.get(date) || [];
    const timing: Record<Timing, number> = { EARLY: 0, TIMELY: 0, LATE: 0, FALSE: 0, MISSED: 0, NA: 0 };
    dt.forEach((t) => { timing[t.timingClassification]++; });
    const rs = dt.map((t) => t.rMultiple ?? 0);
    let cum = 0, peak = 0, dd = 0; rs.forEach((r) => { cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); });
    const regimes = drows.map((r) => r.regime);
    const regime = mode(regimes);
    out.push({
      date, regime,
      buy: drows.filter((r) => r.signal === "BUY").length, sell: drows.filter((r) => r.signal === "SELL").length, wait: drows.filter((r) => r.signal === "WAIT").length,
      trades: dt.length, wins: dt.filter((t) => (t.rMultiple ?? 0) > 0).length, losses: dt.filter((t) => (t.rMultiple ?? 0) < 0).length,
      avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : 0,
      dailyR: +rs.reduce((a, b) => a + b, 0).toFixed(2), maxIntradayDDR: +dd.toFixed(2),
      timing, expiryDay: drows.some((r) => r.isExpiryDay), dataQualityIssues: drows.filter((r) => r.dataQuality !== "PASS").length,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const avg = (xs: Array<number | null>): number => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
const mode = (xs: string[]): string => { const m = new Map<string, number>(); xs.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); let best = "", bc = -1; for (const [k, v] of m) if (v > bc) { bc = v; best = k; } return best; };
