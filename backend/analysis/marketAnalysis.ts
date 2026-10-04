// ===========================================================================
// MARKET ANALYSIS ENGINE  (pure / no network)
// ===========================================================================
// Assembles the single MarketAnalysisState consumed by the Market Analysis
// screen. It is a PURE domain function: all live data (option chain, VIX,
// candles, 9:15 baseline, freshness timestamps) is fetched by the route and
// passed in; this module performs NO network I/O so it is deterministic and
// unit-testable.
//
// REUSE: imports the existing indicator engine (atr/ema/vwap), the strike-step
// helper (nearestStrike) and shared domain types. It does NOT re-implement the
// Dhan chain, OI classifier, VIX fetch or structure engine — those run in the
// route and (for OI flow) are passed in via `oiMovement`.
//
// HONESTY: new quantities that are MODEL-DERIVED (gamma via Black-Scholes,
// Gamma-Blast staging, Spike Trigger, movement bands, dynamic no-trade zone,
// VIX movement envelope) are flagged as such in the payload (`basis`/`model`
// fields) and are never presented as guaranteed outcomes. Where a value cannot
// be computed from real inputs we emit null and the UI shows "—". No win-rate /
// probability / accuracy figure is ever fabricated.

import { Candle, Interval, OiAnalysis, OiStrike } from "../types";
import { SymbolDef, nearestStrike } from "../config";
import { atr, ema, vwap, last } from "../indicators";
import { resolveGamma, bsDelta, yearsToExpiry, repriceOption, BsInput } from "./greeks";

// ---------- VIX type (mirror of dhanProvider.IndiaVix, kept local to avoid a
// value import from the network module) ----------
export interface VixLike {
  available: boolean;
  value: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  ts: number | null;
}

export interface BaselineLike {
  underlying: number | null;
  strikes: Map<number, { ceOi: number; peOi: number; ceLtp: number | null; peLtp: number | null }>;
}

export interface MarketAnalysisInput {
  def: SymbolDef;
  interval: Interval;
  nowMs: number;
  marketOpen: boolean;
  dhanLive: boolean;
  spot: number | null;
  quote: { price: number | null; change: number | null; changePercent: number | null; open?: number | null; high?: number | null; low?: number | null; previousClose?: number | null } | null;
  oi: OiAnalysis | null;
  oiAgeSec: number | null;
  vix: VixLike | null;
  vixAgeSec: number | null;
  candles5m: Candle[];
  candles15m: Candle[];
  daily: Candle[];
  baseline: BaselineLike | null;
  // Optional OI-flow movement summary (from oi/oiMovement.computeOiMovement) so
  // persistence/shock handling uses real multi-sample history, not a single tick.
  oiMovement?: {
    trade?: { signal?: string; strength?: string; confirmed?: boolean } | null;
    direction?: { signal?: string; strength?: string; confirmed?: boolean } | null;
  } | null;
  strikeRange?: number; // ± strikes to display (count), default 10
}

// ---------------- output shapes ----------------
export type LevelKind =
  | "strongResistance" | "resistance" | "pdh" | "todayHigh" | "open" | "vwap"
  | "current" | "todayLow" | "pdl" | "support" | "strongSupport" | "veryStrongSupport"
  | "reference";

export interface LevelRow {
  type: string;        // display label e.g. "R2", "Prev Day High"
  kind: LevelKind;     // color bucket for the UI
  price: number;
  distancePts: number; // price - spot
  distancePct: number;
  strength: string;    // qualitative
  source: string;      // reason / origin
}

export interface OptRow {
  strike: number;
  moneyness: "ITM" | "ATM" | "OTM";
  ltp: number | null;
  chgPct: number | null;
  oi: number | null;
  oiChgPct: number | null;   // vs 9:15 baseline when available, else feed tick chg
  volume: number | null;
  // Option PREMIUM projected (MODEL-DERIVED via local Greek reprice) at each
  // underlying level: supports S1/S2/SWL/PDL and resistances R1/R2/SWH/PDH.
  // Each value = what this option is worth if the index reaches that level.
  s1: number | null; s2: number | null; swl: number | null; pdl: number | null;
  r1: number | null; r2: number | null; swh: number | null; pdh: number | null;
  srLevel: string;           // "RESISTANCE"/"SUPPORT"/"NEUTRAL" (OI-based)
  strength: string;          // Weak/Medium/Strong/Very Strong (OI concentration)
  strengthPct: number;       // 0..100 OI concentration vs window max
  move5m: string | null;     // model band e.g. "+10 to +20"  (null => "—")
  move15m: string | null;
  respMid: number | null;    // numeric expected 15m premium response (for ranking)
  topMover: boolean;         // strongest liquidity-gated responder on its side
  gammaState: "NORMAL" | "BUILDING" | "PRE-BLAST" | "BLAST";
  spikeTrigger: { ltp: number | null; preSpike: number | null; trigger: number | null; state: "NORMAL" | "PRE-SPIKE" | "SPIKE STARTING" } ;
  oiFlow: string;            // NORMAL/BUILDING/STRONG BUILD/UNWINDING/OI SHOCK/UNDER REVIEW
  gammaSource: "feed" | "model" | "none";
  // Alignment with the current market direction (drives row highlighting):
  // CE favoured when BULLISH, PE favoured when BEARISH; NEUTRAL in SIDEWAYS.
  dirAlign: "FAVORED" | "AGAINST" | "NEUTRAL";
}

export interface HeatRow { strike: number; callOi: number; putOi: number; callBucket: Bucket; putBucket: Bucket; }
export type Bucket = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";

export interface SRCard {
  strike: number; distancePts: number; oi: number | null; oiChgPct: number | null; strength: string; gammaState: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1n = (n: number) => Math.round(n * 10) / 10;
const pctClamp = (n: number) => Math.max(0, Math.min(100, n));

// ---------- IST session timing ----------
function sessionMinutes(nowMs: number): { minOfDay: number; elapsed: number; remaining: number } {
  const minOfDay = Math.floor(((nowMs / 60000) + 330) % 1440); // IST minutes since midnight
  const START = 555, END = 930; // 09:15 .. 15:30
  const elapsed = Math.max(0, Math.min(END - START, minOfDay - START));
  const remaining = Math.max(0, Math.min(END - START, END - minOfDay));
  return { minOfDay, elapsed, remaining };
}

function istDate(epochSec: number): string {
  return new Date(epochSec * 1000 + 19800000).toISOString().slice(0, 10);
}

// Today's intraday aggregates from candles.
function todaySession(candles: Candle[], nowMs: number): { open: number | null; high: number | null; low: number | null; orbHigh: number | null; orbLow: number | null } {
  if (!candles.length) return { open: null, high: null, low: null, orbHigh: null, orbLow: null };
  const today = new Date(nowMs + 19800000).toISOString().slice(0, 10);
  const todays = candles.filter((c) => istDate(c.time) === today);
  const use = todays.length ? todays : candles.slice(-26); // fallback: last ~day of 15m bars
  const open = use[0]?.open ?? null;
  let high = -Infinity, low = Infinity;
  for (const c of use) { if (c.high > high) high = c.high; if (c.low < low) low = c.low; }
  // Opening range = first 30 min. For 15m candles that's the first 2 bars; 5m = 6.
  const orbCount = Math.max(2, Math.round(30 / inferIntervalMin(use)));
  const orb = use.slice(0, orbCount);
  let orbHigh = -Infinity, orbLow = Infinity;
  for (const c of orb) { if (c.high > orbHigh) orbHigh = c.high; if (c.low < orbLow) orbLow = c.low; }
  return {
    open,
    high: high === -Infinity ? null : r2(high),
    low: low === Infinity ? null : r2(low),
    orbHigh: orbHigh === -Infinity ? null : r2(orbHigh),
    orbLow: orbLow === Infinity ? null : r2(orbLow),
  };
}

function inferIntervalMin(candles: Candle[]): number {
  if (candles.length < 2) return 15;
  const d = Math.abs(candles[candles.length - 1].time - candles[candles.length - 2].time) / 60;
  return d >= 1 ? d : 15;
}

// Previous completed daily bar (for classic pivots) — the last daily candle
// strictly before today's IST date, else the last available.
function prevDaily(daily: Candle[], nowMs: number): Candle | null {
  if (!daily.length) return null;
  const today = new Date(nowMs + 19800000).toISOString().slice(0, 10);
  for (let i = daily.length - 1; i >= 0; i--) {
    if (istDate(daily[i].time) < today) return daily[i];
  }
  return daily[daily.length - 1];
}

// Simple intraday swing high/low proxy: the highest high / lowest low over the
// last ~20 CLOSED candles (excludes the forming bar). Real, no fabrication.
function swingHighLow(candles: Candle[], lookback = 20): { high: number | null; low: number | null } {
  if (!candles.length) return { high: null, low: null };
  const closed = candles.slice(Math.max(0, candles.length - 1 - lookback), Math.max(0, candles.length - 1));
  const use = closed.length ? closed : candles;
  let hi = -Infinity, lo = Infinity;
  for (const c of use) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  return { high: hi === -Infinity ? null : r2(hi), low: lo === Infinity ? null : r2(lo) };
}

function classicPivots(p: Candle): { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number } {
  const pp = (p.high + p.low + p.close) / 3;
  return {
    pp: r2(pp),
    r1: r2(2 * pp - p.low),
    s1: r2(2 * pp - p.high),
    r2: r2(pp + (p.high - p.low)),
    s2: r2(pp - (p.high - p.low)),
    r3: r2(p.high + 2 * (pp - p.low)),
    s3: r2(p.low - 2 * (p.high - pp)),
  };
}

// ===========================================================================
// MAIN
// ===========================================================================
export function buildMarketAnalysis(input: MarketAnalysisInput) {
  const { def, interval, nowMs, marketOpen, dhanLive } = input;
  const nowSec = Math.floor(nowMs / 1000);
  const asOfIst = new Date(nowMs + 19800000).toISOString().slice(11, 19) + " IST";

  const spot = input.spot ?? input.oi?.underlying ?? input.quote?.price ?? null;
  const oi = input.oi;
  const chainOk = !!(oi && oi.available && Array.isArray(oi.topStrikes) && oi.topStrikes.length && spot != null);

  // ---------------- freshness ----------------
  const freshState = (ageSec: number | null, liveMax = 8, freshMax = 45): string => {
    if (ageSec == null) return "NONE";
    if (ageSec <= liveMax) return "LIVE";
    if (ageSec <= freshMax) return "FRESH";
    if (ageSec <= 180) return "DELAYED";
    return "STALE";
  };
  const oiAge = input.oiAgeSec;
  const dataFreshness = {
    price: { status: dhanLive ? "LIVE" : "OFF", ageSec: dhanLive ? 0 : null },
    volume: { status: dhanLive ? "LIVE" : "OFF", ageSec: dhanLive ? 0 : null },
    oi: { status: freshState(oiAge), ageSec: oiAge },
    vix: { status: input.vix?.available ? freshState(input.vixAgeSec) : "UNAVAILABLE", ageSec: input.vixAgeSec },
    chain: { status: chainOk ? freshState(oiAge) : "UNAVAILABLE", ageSec: oiAge },
    lastUpdate: asOfIst,
    // Price-first rule: breakout detection stays ACTIVE even if OI is delayed.
    breakoutDetection: dhanLive ? "ACTIVE" : "PAUSED (feed off)",
  };

  if (spot == null) {
    return {
      available: false,
      reason: dhanLive ? "No live spot/chain yet — waiting for Dhan." : "Dhan feed OFF — reconnect token for live Market Analysis.",
      symbol: def.symbol, name: def.name, index: def.name, interval,
      timestamp: nowSec, asOfIst, dhanLive, marketOpen, dataFreshness,
      disclaimer: DISCLAIMER_TEXT,
    };
  }

  // ---------------- indicators ----------------
  const c5 = input.candles5m, c15 = input.candles15m, daily = input.daily;
  const atr5 = last(atr(c5, 14)) ?? null;
  const atr15 = last(atr(c15, 14)) ?? null;
  const vwap15 = last(vwap(c15.length ? c15 : c5)) ?? null;
  const ema9_5 = last(ema(c5.map((c) => c.close), 9));
  const ema21_5 = last(ema(c5.map((c) => c.close), 21));
  const sess = todaySession(c15.length ? c15 : c5, nowMs);
  const pd = prevDaily(daily, nowMs);
  const piv = pd ? classicPivots(pd) : null;

  // ---------------- top summary ----------------
  const summary = {
    price: r2(spot),
    change: input.quote?.change ?? null,
    changePct: input.quote?.changePercent ?? null,
    open: input.quote?.open ?? sess.open,
    high: input.quote?.high ?? sess.high,
    low: input.quote?.low ?? sess.low,
    prevClose: input.quote?.previousClose ?? (pd ? pd.close : null),
  };

  // ---------------- India VIX regime / trend ----------------
  const vixBlock = buildVix(input.vix);

  // ---------------- VIX movement envelope (Phase 6) ----------------
  const movement = buildMovementEnvelope(spot, vixBlock.value, atr5, atr15, c5, nowMs);

  // ---------------- all levels (Phase 5) ----------------
  const allLevels = buildAllLevels({ spot, piv, sess, pd, vwap15, oi, c15 });

  // ---------------- nearest S/R from levels ----------------
  const resAbove = allLevels.filter((l) => l.price > spot).sort((a, b) => a.price - b.price);
  const supBelow = allLevels.filter((l) => l.price < spot).sort((a, b) => b.price - a.price);
  const nearestRes = resAbove[0] ?? null;
  const nearestSup = supBelow[0] ?? null;

  // ---------------- breakout / breakdown (price-first, Phase 15) ----------------
  const breakout = buildBreakout({ spot, nearestRes, nearestSup, atr15, c15, vwap15 });

  // ---------------- dynamic no-trade zone (Phase 7) ----------------
  const noTradeZone = buildNoTradeZone({ spot, nearestRes, nearestSup, vwap15, atr15, movement, breakout });

  // ---------------- market DIRECTION (drives row highlighting) -------------
  // Shared directional evidence (OI flow + option bias + price momentum + VWAP).
  // CALL rows are favoured when BULLISH, PUT rows when BEARISH. India VIX is NOT
  // a direction input (volatility only).
  const dirScore = directionEvidence({ oi, oiMovement: input.oiMovement, breakout, vwap15, spot });
  const marketDirection = {
    bias: dirScore > 12 ? "BULLISH" : dirScore < -12 ? "BEARISH" : "SIDEWAYS",
    score: Math.round(dirScore),
    basis: "OI flow + option bias + momentum + VWAP (price-driven; VIX excluded)",
  } as const;

  // ---------------- underlying levels used for per-strike premium projection ----
  // supports: S1/S2 (pivots), SWL (swing low), PDL (prev day low)
  // resistances: R1/R2 (pivots), SWH (swing high), PDH (prev day high)
  const swing = swingHighLow(c15.length ? c15 : c5);
  const idxLevels = {
    s1: piv?.s1 ?? null, s2: piv?.s2 ?? null, swl: swing.low, pdl: pd?.low ?? null,
    r1: piv?.r1 ?? null, r2: piv?.r2 ?? null, swh: swing.high, pdh: pd?.high ?? null,
  };

  // ---------------- option tables + heatmap + gamma + spikes (Phases 8-18) ----------------
  const tYears = yearsToExpiry(oi?.expiry ?? null, nowMs);
  let callOptions: OptRow[] = [];
  let putOptions: OptRow[] = [];
  let oiHeatmap: HeatRow[] = [];
  let gammaBlast: Array<{ strike: number; side: "CE" | "PE"; state: string; spikePremium: number | null }> = [];
  let spikeTriggers: Array<{ strike: number; side: "CE" | "PE"; ltp: number | null; trigger: number | null; state: string }> = [];
  let nearestPutSupport: SRCard | null = null;
  let nearestCallResistance: SRCard | null = null;
  let nextPutSupport: SRCard | null = null;
  let nextCallResistance: SRCard | null = null;
  let oiFlowSummary = { state: "UNAVAILABLE", note: "Option chain unavailable.", shock: false };
  let movementOpportunity: { ce: any; pe: any; note: string } = { ce: null, pe: null, note: "Option chain unavailable." };

  if (chainOk && oi) {
    const built = buildOptionTables({
      oi, spot, baseline: input.baseline, movement, atr15, idxLevels,
      tYears, nowMs, breakout, strikeRange: input.strikeRange ?? 10, oiMovement: input.oiMovement,
      direction: marketDirection.bias,
    });
    callOptions = built.callOptions;
    putOptions = built.putOptions;
    oiHeatmap = built.heatmap;
    gammaBlast = built.gammaBlast;
    spikeTriggers = built.spikeTriggers;
    nearestPutSupport = built.nearestPutSupport;
    nearestCallResistance = built.nearestCallResistance;
    nextPutSupport = built.nextPutSupport;
    nextCallResistance = built.nextCallResistance;
    oiFlowSummary = built.oiFlowSummary;
    movementOpportunity = built.movementOpportunity;
  }

  // ---------------- selected-index movement indicator (Phase 21) ----------------
  const indexMove = {
    upside: {
      current: r2(spot),
      resistance: nearestRes?.price ?? null,
      distancePts: nearestRes ? r1n(nearestRes.price - spot) : null,
      breakoutLevel: breakout.upside.level,
      stage: breakout.upside.stage,
    },
    downside: {
      current: r2(spot),
      support: nearestSup?.price ?? null,
      distancePts: nearestSup ? r1n(spot - nearestSup.price) : null,
      breakdownLevel: breakout.downside.level,
      stage: breakout.downside.stage,
    },
  };

  // ---------------- index movement TILT (model lean — NOT a win rate) ------
  const movementTilt = buildMovementTilt({ oi, oiMovement: input.oiMovement, breakout, vwap15, spot });

  // ---------------- expected index levels from the VIX envelope ------------
  const expectedLevels = {
    m5: movement.expectedMove5m ? { low: movement.expectedMove5m.low, current: r2(spot), high: movement.expectedMove5m.high, pts: movement.expectedMove5m.pts } : null,
    m15: movement.expectedMove15m ? { low: movement.expectedMove15m.low, current: r2(spot), high: movement.expectedMove15m.high, pts: movement.expectedMove15m.pts } : null,
    basis: "India VIX σ scaled to horizon (model-derived band, not a guaranteed level)",
  };

  // ---------------- 9:15 baseline (Phase 12) ----------------
  const baseline915 = buildBaseline915(input.baseline, oi, spot);

  return {
    available: true,
    symbol: def.symbol,
    name: def.name,
    index: def.name,
    interval,
    expiry: oi?.expiry ?? null,
    timestamp: nowSec,
    asOfIst,
    dhanLive,
    marketOpen,
    spot: r2(spot),
    summary,
    indiaVix: vixBlock,
    movement,
    allLevels,
    noTradeZone,
    breakout,
    indexMove,
    oiHeatmap,
    nearestPutSupport,
    nearestCallResistance,
    nextPutSupport,
    nextCallResistance,
    callOptions,
    putOptions,
    gammaBlast,
    spikeTriggers,
    oiFlow: oiFlowSummary,
    movementOpportunity,
    marketDirection,
    movementTilt,
    expectedLevels,
    baseline915,
    dataFreshness,
    dataQuality: chainOk ? "OK" : (dhanLive ? "CHAIN UNAVAILABLE" : "FEED OFF"),
    disclaimer: DISCLAIMER_TEXT,
  };
}

const DISCLAIMER_TEXT =
  "Model-derived analytics for study. Gamma/Gamma-Blast, Spike Trigger, movement bands, VIX envelope and the no-trade zone are MODELLED from live data, not guarantees. No win-rate/probability is implied. Not investment advice.";

// ===========================================================================
// SUB-BUILDERS
// ===========================================================================

function buildVix(v: VixLike | null) {
  if (!v || !v.available || v.value == null) {
    return { available: false, value: null, change: null, changePct: null, regime: "UNAVAILABLE", trend: "UNAVAILABLE", percentile: null };
  }
  const val = v.value;
  // NIFTY-calibrated regime bands (India VIX historically ~9-30+).
  const regime = val < 12 ? "LOW" : val < 18 ? "NORMAL" : val < 26 ? "HIGH" : "EXTREME";
  const chg = v.change ?? (v.prevClose != null ? r2(val - v.prevClose) : null);
  const trend = chg == null ? "FLAT" : chg > 0.15 ? "RISING" : chg < -0.15 ? "FALLING" : "FLAT";
  // Percentile within the day's own range only (honest: we lack a long history
  // store here, so this is an intraday position, not a historical percentile).
  let percentile: number | null = null;
  if (v.dayHigh != null && v.dayLow != null && v.dayHigh > v.dayLow) {
    percentile = Math.round(((val - v.dayLow) / (v.dayHigh - v.dayLow)) * 100);
  }
  return {
    available: true,
    value: r2(val),
    change: chg,
    changePct: v.changePct ?? null,
    regime,
    trend,
    percentile,
    percentileBasis: percentile == null ? null : "intraday range (not historical)",
  };
}

function buildMovementEnvelope(spot: number, vixValue: number | null, atr5: number | null, atr15: number | null, c5: Candle[], nowMs: number) {
  const { remaining } = sessionMinutes(nowMs);
  const basisParts: string[] = [];
  // VIX-implied per-horizon sigma (annualised VIX → session minute scaling).
  const vixMove = (mins: number): number | null => {
    if (vixValue == null || vixValue <= 0) return null;
    const dailySigma = (spot * (vixValue / 100)) / Math.sqrt(252); // 1-day sigma in points
    return dailySigma * Math.sqrt(mins / 375); // scale by fraction of a session
  };
  const vix5 = vixMove(5), vix15 = vixMove(15);
  if (vix5 != null) basisParts.push("India VIX");
  // ATR-implied: a 5m bar's ATR ≈ a 5-min move; 15m ATR ≈ a 15-min move.
  if (atr5 != null) basisParts.push("ATR(5m)");
  if (atr15 != null) basisParts.push("ATR(15m)");
  // Recent realized range (last up-to-6 5m bars) as a floor.
  const recent = c5.slice(-6);
  const realized = recent.length ? recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length : null;
  if (realized != null) basisParts.push("realized range");

  const blend = (vals: Array<number | null>): number | null => {
    const v = vals.filter((x): x is number => x != null && x > 0 && Number.isFinite(x));
    if (!v.length) return null;
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  const move5 = blend([vix5, atr5, realized]);
  const move15 = blend([vix15, atr15, realized != null ? realized * 1.7 : null]);

  const band = (mv: number | null) => mv == null ? null : {
    pts: r1n(mv),
    low: r2(spot - mv),
    high: r2(spot + mv),
  };
  // Capacity from the 15m one-sided move as a fraction of spot.
  const capBps = move15 != null ? (move15 / spot) * 10000 : null;
  const capacity = capBps == null ? "UNKNOWN"
    : capBps < 12 ? "LOW" : capBps < 28 ? "MEDIUM" : capBps < 50 ? "HIGH" : "EXTREME";
  const regime = vixValue == null ? "UNKNOWN"
    : vixValue < 12 ? "LOW" : vixValue < 18 ? "NORMAL" : vixValue < 26 ? "HIGH" : "EXTREME";

  return {
    expectedMove5m: band(move5),
    expectedMove15m: band(move15),
    expectedMovePts: move15 != null ? r1n(move15) : null,
    capacity,
    regime,
    sessionMinsRemaining: remaining,
    basis: basisParts.length ? basisParts.join(" + ") : "insufficient data",
    model: "VIX σ scaled to horizon, blended with ATR + realized range (model-derived; not a guaranteed range)",
  };
}

function buildAllLevels(a: {
  spot: number; piv: ReturnType<typeof classicPivots> | null;
  sess: { open: number | null; high: number | null; low: number | null; orbHigh: number | null; orbLow: number | null };
  pd: Candle | null; vwap15: number | null; oi: OiAnalysis | null; c15: Candle[];
}): LevelRow[] {
  const { spot, piv, sess, pd, vwap15, oi } = a;
  const out: Array<Omit<LevelRow, "distancePts" | "distancePct"> & { price: number }> = [];
  const push = (type: string, kind: LevelKind, price: number | null | undefined, strength: string, source: string) => {
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    out.push({ type, kind, price: r2(price), strength, source });
  };

  if (piv) {
    push("R3", "strongResistance", piv.r3, "Strong", "Classic pivot R3");
    push("R2", "resistance", piv.r2, "Medium", "Classic pivot R2");
    push("R1", "resistance", piv.r1, "Medium", "Classic pivot R1");
    push("Pivot", "reference", piv.pp, "Reference", "Classic daily pivot");
    push("S1", "support", piv.s1, "Medium", "Classic pivot S1");
    push("S2", "strongSupport", piv.s2, "Strong", "Classic pivot S2");
    push("S3", "veryStrongSupport", piv.s3, "Very Strong", "Classic pivot S3");
  }
  push("Today's High", "todayHigh", sess.high, "Session", "Intraday high");
  push("Today's Low", "todayLow", sess.low, "Session", "Intraday low");
  push("Opening Range High", "resistance", sess.orbHigh, "ORB", "First 30-min high");
  push("Opening Range Low", "support", sess.orbLow, "ORB", "First 30-min low");
  push("Open (Today)", "open", sess.open, "Reference", "Today's open");
  push("VWAP", "vwap", vwap15, "Dynamic", "Session VWAP");
  if (pd) {
    push("Prev Day High", "pdh", pd.high, "Prev Day", "PDH");
    push("Prev Day Low", "pdl", pd.low, "Prev Day", "PDL");
    push("Prev Day Close", "reference", pd.close, "Prev Day", "PDC");
  }
  if (oi) {
    if (oi.resistance != null) push("OI Resistance (CE wall)", "strongResistance", oi.resistance, "OI wall", "Max CALL OI strike");
    if (oi.support != null) push("OI Support (PE wall)", "veryStrongSupport", oi.support, "OI wall", "Max PUT OI strike");
    if (oi.maxPain != null) push("Max Pain", "reference", oi.maxPain, "Reference", "Option max-pain strike");
  }

  // Current price row — always present, visually prominent on the UI.
  const rows: LevelRow[] = out.map((l) => ({
    ...l,
    distancePts: r1n(l.price - spot),
    distancePct: r2(((l.price - spot) / spot) * 100),
  }));
  rows.push({
    type: "CURRENT PRICE", kind: "current", price: r2(spot),
    distancePts: 0, distancePct: 0, strength: "LTP", source: "Live spot",
  });
  // Strict high → low sort.
  rows.sort((x, y) => y.price - x.price);
  return rows;
}

function buildBreakout(a: {
  spot: number; nearestRes: LevelRow | null; nearestSup: LevelRow | null;
  atr15: number | null; c15: Candle[]; vwap15: number | null;
}) {
  const { spot, nearestRes, nearestSup, atr15, c15, vwap15 } = a;
  const unit = atr15 && atr15 > 0 ? atr15 : spot * 0.0025;
  const closed = c15.length >= 2 ? c15[c15.length - 2] : null; // last CLOSED 15m candle
  const closeC = closed?.close ?? null;
  // momentum: slope of last 3 closes normalised by atr
  const n = c15.length;
  let momentum = 0;
  if (n >= 4) momentum = (c15[n - 2].close - c15[n - 4].close) / unit;
  const momo = momentum > 0.4 ? "ACCELERATING ↑" : momentum < -0.4 ? "ACCELERATING ↓" : "FLAT";
  const aboveV = vwap15 != null ? spot >= vwap15 : null;

  const upLevel = nearestRes?.price ?? null;
  const dnLevel = nearestSup?.price ?? null;

  const upStage = (() => {
    if (upLevel == null) return "N/A";
    const dist = upLevel - spot;
    const brokeClose = closeC != null && closeC > upLevel;
    if (closeC != null && closeC > upLevel + 0.5 * unit) return "Expansion";
    if (brokeClose) return "Breakout Confirmed";
    if (spot >= upLevel) return "Breakout Attempt";
    if (dist <= 0.25 * unit && momentum > 0.2 && aboveV !== false) return "Pre-Breakout";
    if (dist <= 0.7 * unit) return "Approaching";
    return "—";
  })();
  const dnStage = (() => {
    if (dnLevel == null) return "N/A";
    const dist = spot - dnLevel;
    const brokeClose = closeC != null && closeC < dnLevel;
    if (closeC != null && closeC < dnLevel - 0.5 * unit) return "Expansion";
    if (brokeClose) return "Breakdown Confirmed";
    if (spot <= dnLevel) return "Breakdown Attempt";
    if (dist <= 0.25 * unit && momentum < -0.2 && aboveV !== true) return "Pre-Breakdown";
    if (dist <= 0.7 * unit) return "Approaching";
    return "—";
  })();

  const active = (s: string) => s !== "—" && s !== "N/A";
  return {
    upside: { stage: upStage, level: upLevel, distancePts: upLevel != null ? r1n(upLevel - spot) : null, active: active(upStage) },
    downside: { stage: dnStage, level: dnLevel, distancePts: dnLevel != null ? r1n(spot - dnLevel) : null, active: active(dnStage) },
    momentum: momo,
    momentumVal: r2(momentum),
    vwapStatus: aboveV == null ? "N/A" : aboveV ? "Above VWAP" : "Below VWAP",
    basis: "price-first (price/level/ATR/VWAP/momentum) — independent of OI delay",
  };
}

function buildNoTradeZone(a: {
  spot: number; nearestRes: LevelRow | null; nearestSup: LevelRow | null;
  vwap15: number | null; atr15: number | null; movement: ReturnType<typeof buildMovementEnvelope>;
  breakout: ReturnType<typeof buildBreakout>;
}) {
  const { spot, nearestRes, nearestSup, vwap15, atr15, movement, breakout } = a;
  const reasons: string[] = [];
  const unit = atr15 && atr15 > 0 ? atr15 : spot * 0.0025;

  // A breakout already underway invalidates the no-trade state immediately.
  const breakoutLive = ["Breakout Attempt", "Breakout Confirmed", "Expansion"].includes(breakout.upside.stage)
    || ["Breakdown Attempt", "Breakdown Confirmed", "Expansion"].includes(breakout.downside.stage);
  if (breakoutLive) {
    return { active: false, low: null, high: null, reasons: ["Breakout/breakdown in progress — no-trade state invalidated."], invalidatedBy: "active breakout", model: "dynamic" };
  }

  const distRes = nearestRes ? nearestRes.price - spot : Infinity;
  const distSup = nearestSup ? spot - nearestSup.price : Infinity;
  const roomPts = Math.min(distRes, distSup);
  const nearVwap = vwap15 != null && Math.abs(spot - vwap15) <= 0.2 * unit;
  const weakMomo = breakout.momentum === "FLAT";
  const tightRoom = roomPts <= 0.6 * unit; // squeezed between opposing levels
  const lowCapacity = movement.capacity === "LOW";

  if (nearVwap) reasons.push("price pinned at VWAP (value area)");
  if (tightRoom) reasons.push("squeezed between strong opposing levels");
  if (weakMomo) reasons.push("weak momentum / low displacement");
  if (lowCapacity) reasons.push("low expected move (poor R:R)");

  // Zone active when at least two conditions agree.
  const active = reasons.length >= 2;
  if (!active) {
    return { active: false, low: null, high: null, reasons: reasons.length ? reasons : ["displacement adequate — tradeable"], invalidatedBy: null, model: "dynamic" };
  }
  // Build the zone around the current value area, bounded by the nearest levels.
  const half = Math.max(0.25 * unit, (movement.expectedMovePts ?? unit) * 0.25);
  const lowRaw = Math.max(nearestSup?.price ?? spot - half, spot - half);
  const highRaw = Math.min(nearestRes?.price ?? spot + half, spot + half);
  return {
    active: true,
    low: r2(Math.min(lowRaw, highRaw)),
    high: r2(Math.max(lowRaw, highRaw)),
    reasons,
    invalidatedBy: "a strong breakout from the zone",
    note: "No new trade inside this band. It does NOT mean price cannot move here.",
    model: "dynamic (levels + VWAP + ATR + VIX + momentum)",
  };
}

// ---------- OI concentration bucket ----------
function bucketOf(oi: number, max: number): Bucket {
  if (max <= 0) return "LOW";
  const r = oi / max;
  return r >= 0.75 ? "VERY_HIGH" : r >= 0.45 ? "HIGH" : r >= 0.2 ? "MEDIUM" : "LOW";
}
function strengthOf(oi: number, max: number): { label: string; pct: number } {
  if (max <= 0) return { label: "Weak", pct: 0 };
  const pct = pctClamp(Math.round((oi / max) * 100));
  const label = pct >= 75 ? "Very Strong" : pct >= 45 ? "Strong" : pct >= 20 ? "Medium" : "Weak";
  return { label, pct };
}

function buildOptionTables(a: {
  oi: OiAnalysis; spot: number; baseline: BaselineLike | null;
  movement: ReturnType<typeof buildMovementEnvelope>; atr15: number | null;
  tYears: number | null; nowMs: number; breakout: ReturnType<typeof buildBreakout>;
  strikeRange: number; oiMovement?: MarketAnalysisInput["oiMovement"];
  idxLevels: { s1: number | null; s2: number | null; swl: number | null; pdl: number | null; r1: number | null; r2: number | null; swh: number | null; pdh: number | null };
  direction: "BULLISH" | "BEARISH" | "SIDEWAYS";
}) {
  const { oi, spot, baseline, movement, tYears, breakout, strikeRange, oiMovement, idxLevels, direction } = a;
  const sorted = oi.topStrikes.filter((s) => s.strike > 0).sort((x, y) => x.strike - y.strike);
  // ATM index + window (dynamic follow). Preserve major OI walls even if outside window.
  const atm = sorted.reduce<OiStrike | null>((b, s) => (b == null || Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b), null);
  const ai = atm ? sorted.findIndex((s) => s.strike === atm.strike) : -1;
  const lo = ai < 0 ? 0 : Math.max(0, ai - strikeRange);
  const hi = ai < 0 ? sorted.length : Math.min(sorted.length, ai + strikeRange + 1);
  const windowSet = new Set(sorted.slice(lo, hi).map((s) => s.strike));
  // Major walls to always keep.
  if (oi.support != null) windowSet.add(oi.support);
  if (oi.resistance != null) windowSet.add(oi.resistance);
  const win = sorted.filter((s) => windowSet.has(s.strike));

  const maxCe = Math.max(1, ...win.map((s) => s.ceOi || 0));
  const maxPe = Math.max(1, ...win.map((s) => s.peOi || 0));
  const expMove5 = movement.expectedMove5m?.pts ?? null;
  const expMove15 = movement.expectedMove15m?.pts ?? null;

  const atmBand = spot * 0.0015;

  const buildRow = (s: OiStrike, side: "CE" | "PE"): OptRow => {
    const ltp = side === "CE" ? (s.ceLtp ?? null) : (s.peLtp ?? null);
    const feedDelta = side === "CE" ? (s.ceDelta ?? null) : (s.peDelta ?? null);
    const iv = side === "CE" ? (s.ceIv ?? null) : (s.peIv ?? null);
    const theta = side === "CE" ? (s.ceTheta ?? null) : (s.peTheta ?? null);
    const feedGamma = side === "CE" ? (s.ceGamma ?? null) : (s.peGamma ?? null);
    const oiVal = side === "CE" ? (s.ceOi ?? null) : (s.peOi ?? null);
    const vol = side === "CE" ? (s.ceVol ?? null) : (s.peVol ?? null);
    const feedChg = side === "CE" ? (s.ceChg ?? null) : (s.peChg ?? null);

    // model-derived gamma + delta (fallback) for projection/blast.
    const ivFrac = iv != null ? (iv > 1 ? iv / 100 : iv) : null;
    const bs: BsInput | null = (ivFrac != null && tYears != null) ? { spot, strike: s.strike, tYears, iv: ivFrac } : null;
    const g = bs ? resolveGamma(feedGamma, bs) : { value: feedGamma ?? null, source: (feedGamma != null ? "feed" : "none") as "feed" | "none" };
    const delta = feedDelta ?? (bs ? bsDelta(bs, side) : null);
    const gamma = g.value;

    // OI change vs 9:15 baseline (preferred) else feed tick change.
    const base = baseline?.strikes.get(s.strike);
    const baseOi = side === "CE" ? base?.ceOi : base?.peOi;
    let oiChgPct: number | null = null;
    if (baseOi != null && baseOi > 0 && oiVal != null) oiChgPct = r1n(((oiVal - baseOi) / baseOi) * 100);
    else if (feedChg != null && oiVal != null && oiVal - feedChg !== 0) oiChgPct = r1n((feedChg / Math.max(1, oiVal - feedChg)) * 100);

    // premium chg%: from feed ltp change not available per-strike historically; use baseline LTP if present.
    const baseLtp = side === "CE" ? base?.ceLtp : base?.peLtp;
    const chgPct = (baseLtp != null && baseLtp > 0 && ltp != null) ? r1n(((ltp - baseLtp) / baseLtp) * 100) : null;

    // Project this option's PREMIUM (model-derived, Greek reprice) at each real
    // underlying level. Same level set + column order for CE and PE: the column
    // is keyed by the INDEX level and the value is the option's premium there.
    const projAt = (level: number | null): number | null => {
      if (level == null || ltp == null || delta == null) return null;
      const v = repriceOption({ ltp, delta, gamma, theta, dSpot: level - spot });
      return v != null ? r2(v) : null;
    };
    // Premium projected at each underlying level.
    const pAtS1 = projAt(idxLevels.s1), pAtS2 = projAt(idxLevels.s2);
    const pAtSwl = projAt(idxLevels.swl), pAtPdl = projAt(idxLevels.pdl);
    const pAtR1 = projAt(idxLevels.r1), pAtR2 = projAt(idxLevels.r2);
    const pAtSwh = projAt(idxLevels.swh), pAtPdh = projAt(idxLevels.pdh);
    // Map into the option's OWN support/resistance ladder so S ≤ LTP ≤ R for BOTH
    // sides (correctly mapped). A CALL gains as the index rises: its premium
    // SUPPORTS are the index down-levels (S1/S2/SWL/PDL), resistances the up-levels
    // (R1/R2/SWH/PDH). A PUT is inverted — its premium SUPPORT is on the index
    // UP-side (put loses) and its RESISTANCE on the index DOWN-side (put gains).
    const lv = side === "CE"
      ? { s1: pAtS1, s2: pAtS2, swl: pAtSwl, pdl: pAtPdl, r1: pAtR1, r2: pAtR2, swh: pAtSwh, pdh: pAtPdh }
      : { s1: pAtR1, s2: pAtR2, swl: pAtSwh, pdl: pAtPdh, r1: pAtS1, r2: pAtS2, swh: pAtSwl, pdh: pAtPdl };

    // S/R classification + strength from OI concentration.
    const strength = strengthOf(oiVal ?? 0, side === "CE" ? maxCe : maxPe);
    const srLevel = side === "CE" ? "RESISTANCE" : "SUPPORT";

    // movement opportunity bands (favourable direction), model-derived.
    const moveBand = (underMove: number | null): string | null => {
      if (underMove == null || delta == null || ltp == null) return null;
      const mid = Math.abs(delta) * underMove + 0.5 * (gamma ?? 0) * underMove * underMove;
      if (!(mid > 0) || !Number.isFinite(mid)) return null;
      const lo2 = Math.max(0, Math.round(mid * 0.6));
      const hi2 = Math.round(mid * 1.2);
      return `+${lo2} to +${hi2}`;
    };
    const move5m = moveBand(expMove5);
    const move15m = moveBand(expMove15);
    // Numeric expected 15m premium response (|Δ|·move + ½·Γ·move²) — the
    // "movement opportunity": how strongly this strike reprices if the index
    // moves. Index-agnostic (uses the selected index's own spot/levels).
    const respMid = (expMove15 != null && delta != null && ltp != null && Number.isFinite(expMove15))
      ? Math.round(Math.abs(delta) * expMove15 + 0.5 * (gamma ?? 0) * expMove15 * expMove15)
      : null;

    // OI flow classification (single-chain + baseline + optional movement history).
    const oiFlow = classifyStrikeFlow(oiChgPct, feedChg, oiVal, oiMovement);

    // gamma state (per-strike, combines model gamma + flow + proximity + displacement).
    const nearATM = Math.abs(s.strike - spot) <= atmBand * 3;
    const gammaState = classifyGammaState({
      gamma, nearATM, oiFlow, breakout, side, vol, oiVal,
    });

    // spike trigger (model-derived premium ladder).
    const trigger = (move15m && ltp != null && delta != null)
      ? r2(ltp + Math.abs(delta) * (expMove15 ?? 0) + 0.5 * (gamma ?? 0) * (expMove15 ?? 0) * (expMove15 ?? 0))
      : null;
    const preSpike = (trigger != null && ltp != null) ? r2(ltp + (trigger - ltp) * 0.5) : null;
    const relevantStage = side === "CE" ? breakout.upside.stage : breakout.downside.stage;
    const momoAccel = side === "CE" ? breakout.momentumVal > 0.2 : breakout.momentumVal < -0.2;
    let spikeState: "NORMAL" | "PRE-SPIKE" | "SPIKE STARTING" = "NORMAL";
    if (nearATM && (gammaState === "PRE-BLAST" || gammaState === "BLAST") && momoAccel) spikeState = "SPIKE STARTING";
    else if (nearATM && (gammaState === "BUILDING" || gammaState === "PRE-BLAST") && ["Approaching", "Pre-Breakout", "Pre-Breakdown", "Breakout Attempt", "Breakdown Attempt"].includes(relevantStage)) spikeState = "PRE-SPIKE";

    return {
      strike: s.strike,
      moneyness: Math.abs(s.strike - spot) <= atmBand ? "ATM" : (side === "CE" ? (s.strike < spot ? "ITM" : "OTM") : (s.strike > spot ? "ITM" : "OTM")),
      ltp: ltp != null ? r2(ltp) : null,
      chgPct,
      oi: oiVal,
      oiChgPct,
      volume: vol,
      s1: lv.s1, s2: lv.s2, swl: lv.swl, pdl: lv.pdl,
      r1: lv.r1, r2: lv.r2, swh: lv.swh, pdh: lv.pdh,
      srLevel,
      strength: strength.label,
      strengthPct: strength.pct,
      move5m,
      move15m,
      respMid,
      topMover: false,
      gammaState,
      spikeTrigger: { ltp: ltp != null ? r2(ltp) : null, preSpike, trigger, state: spikeState },
      oiFlow,
      gammaSource: g.source,
      dirAlign: direction === "SIDEWAYS" ? "NEUTRAL"
        : ((side === "CE" && direction === "BULLISH") || (side === "PE" && direction === "BEARISH")) ? "FAVORED" : "AGAINST",
    };
  };

  const callOptions = win.map((s) => buildRow(s, "CE"));
  const putOptions = win.map((s) => buildRow(s, "PE"));

  // Movement Opportunity: the strongest liquidity-gated premium responder on
  // EACH side (CE + PE). Rank by expected 15m premium response (respMid) among
  // strikes that actually have open interest, then flag the top 2 per side.
  const markMovers = (rows: OptRow[]) => {
    const liquid = rows.filter((r) => r.respMid != null && r.oi != null && r.oi > 0);
    liquid.sort((a, b) => (b.respMid || 0) - (a.respMid || 0));
    liquid.slice(0, 2).forEach((r) => { r.topMover = true; });
    return liquid[0] || null;
  };
  const bestCe = markMovers(callOptions);
  const bestPe = markMovers(putOptions);
  const moverCard = (r: OptRow | null): { strike: number; move15m: string | null; respMid: number | null; strength: string } | null =>
    r ? { strike: r.strike, move15m: r.move15m, respMid: r.respMid, strength: r.strength } : null;
  const movementOpportunity = {
    ce: moverCard(bestCe),
    pe: moverCard(bestPe),
    note: "strongest premium responder per side if the index moves — model-derived (Δ,Γ × expected move), liquidity-gated. Not a profit guarantee.",
  };

  // Heatmap: exactly 6 strikes ABOVE and 6 BELOW the ATM (ATM ±6 = up to 13
  // rows), centred on the live ATM so the window shifts as the index moves.
  // Independent of the detailed tables' strike range.
  const HEAT_SIDE = 6;
  const heatWin = ai < 0 ? win : sorted.slice(Math.max(0, ai - HEAT_SIDE), ai + HEAT_SIDE + 1);
  const heatMaxCe = Math.max(1, ...heatWin.map((s) => s.ceOi || 0));
  const heatMaxPe = Math.max(1, ...heatWin.map((s) => s.peOi || 0));
  const heatmap: HeatRow[] = heatWin.map((s) => ({
    strike: s.strike,
    callOi: s.ceOi || 0,
    putOi: s.peOi || 0,
    callBucket: bucketOf(s.ceOi || 0, heatMaxCe),
    putBucket: bucketOf(s.peOi || 0, heatMaxPe),
  }));

  // Nearest PE support (PE OI below spot) + CE resistance (CE OI above spot).
  const peBelow = win.filter((s) => s.strike <= spot).sort((x, y) => y.strike - x.strike);
  const ceAbove = win.filter((s) => s.strike >= spot).sort((x, y) => x.strike - y.strike);
  const toCard = (s: OiStrike | undefined, side: "CE" | "PE"): SRCard | null => {
    if (!s) return null;
    const row = (side === "CE" ? callOptions : putOptions).find((r) => r.strike === s.strike);
    return {
      strike: s.strike,
      distancePts: r1n(Math.abs(s.strike - spot)),
      oi: side === "CE" ? (s.ceOi ?? null) : (s.peOi ?? null),
      oiChgPct: row?.oiChgPct ?? null,
      strength: row?.strength ?? "—",
      gammaState: row?.gammaState ?? "NORMAL",
    };
  };
  const nearestPutSupport = toCard(peBelow[0], "PE");
  const nextPutSupport = toCard(peBelow[1], "PE");
  const nearestCallResistance = toCard(ceAbove[0], "CE");
  const nextCallResistance = toCard(ceAbove[1], "CE");

  // Key strikes for gamma-blast + spike panels (ATM±2).
  const keyStrikes = win.filter((s) => Math.abs(s.strike - spot) <= atmBand * 2 + (sorted.length > 1 ? Math.abs(sorted[1].strike - sorted[0].strike) * 2 : 0));
  const gammaBlast = keyStrikes.flatMap((s) => {
    const ce = callOptions.find((r) => r.strike === s.strike);
    const pe = putOptions.find((r) => r.strike === s.strike);
    const arr: Array<{ strike: number; side: "CE" | "PE"; state: string; spikePremium: number | null }> = [];
    if (ce && ce.gammaState !== "NORMAL") arr.push({ strike: s.strike, side: "CE", state: ce.gammaState, spikePremium: ce.spikeTrigger.trigger });
    if (pe && pe.gammaState !== "NORMAL") arr.push({ strike: s.strike, side: "PE", state: pe.gammaState, spikePremium: pe.spikeTrigger.trigger });
    return arr;
  });
  const spikeTriggers = keyStrikes.flatMap((s) => {
    const ce = callOptions.find((r) => r.strike === s.strike);
    const pe = putOptions.find((r) => r.strike === s.strike);
    const arr: Array<{ strike: number; side: "CE" | "PE"; ltp: number | null; trigger: number | null; state: string }> = [];
    if (ce && ce.spikeTrigger.state !== "NORMAL") arr.push({ strike: s.strike, side: "CE", ltp: ce.ltp, trigger: ce.spikeTrigger.trigger, state: ce.spikeTrigger.state });
    if (pe && pe.spikeTrigger.state !== "NORMAL") arr.push({ strike: s.strike, side: "PE", ltp: pe.ltp, trigger: pe.spikeTrigger.trigger, state: pe.spikeTrigger.state });
    return arr;
  });

  // Aggregate OI flow + shock handling.
  const oiFlowSummary = buildOiFlowSummary(oiMovement, callOptions, putOptions);

  return { callOptions, putOptions, heatmap, gammaBlast, spikeTriggers, nearestPutSupport, nextPutSupport, nearestCallResistance, nextCallResistance, oiFlowSummary, movementOpportunity };
}

function classifyStrikeFlow(oiChgPct: number | null, feedChg: number | null, oiVal: number | null, mv?: MarketAnalysisInput["oiMovement"]): string {
  // Single-tick OI shock guard: a sudden large one-tick jump relative to the
  // standing OI is flagged for review, not treated as confirmed flow.
  if (feedChg != null && oiVal != null && oiVal > 0) {
    const tickPct = (feedChg / Math.max(1, oiVal - feedChg)) * 100;
    if (Math.abs(tickPct) >= 20) {
      const confirmed = mv?.trade?.confirmed === true || mv?.direction?.confirmed === true;
      return confirmed ? "CONFIRMED FLOW" : "OI SHOCK — UNDER REVIEW";
    }
  }
  if (oiChgPct == null) return "NORMAL";
  if (oiChgPct >= 25) return "STRONG BUILD";
  if (oiChgPct >= 8) return "BUILDING";
  if (oiChgPct <= -12) return "UNWINDING";
  return "NORMAL";
}

function classifyGammaState(a: {
  gamma: number | null; nearATM: boolean; oiFlow: string; side: "CE" | "PE";
  breakout: ReturnType<typeof buildBreakout>; vol: number | null; oiVal: number | null;
}): "NORMAL" | "BUILDING" | "PRE-BLAST" | "BLAST" {
  // Gamma alone must NOT trigger a blast. Require ATM proximity (where gamma
  // matters), supportive OI flow / volume, and underlying displacement toward a
  // trigger for escalation. This is an EARLY-MOVEMENT model, not a prediction.
  if (!a.nearATM || a.gamma == null || a.gamma <= 0) return "NORMAL";
  const flowBuild = a.oiFlow === "BUILDING" || a.oiFlow === "STRONG BUILD" || a.oiFlow === "CONFIRMED FLOW";
  const volOk = a.vol != null && a.oiVal != null && a.oiVal > 0 ? a.vol / a.oiVal > 0.05 : false;
  const stage = a.side === "CE" ? a.breakout.upside.stage : a.breakout.downside.stage;
  const accel = a.side === "CE" ? a.breakout.momentumVal > 0.4 : a.breakout.momentumVal < -0.4;
  const atTrigger = ["Pre-Breakout", "Pre-Breakdown", "Breakout Attempt", "Breakdown Attempt"].includes(stage);
  const confirmed = ["Breakout Confirmed", "Breakdown Confirmed", "Expansion"].includes(stage);

  if (confirmed && accel && (flowBuild || volOk)) return "BLAST";
  if (atTrigger && (flowBuild || volOk)) return "PRE-BLAST";
  if (flowBuild || volOk) return "BUILDING";
  return "NORMAL";
}

function buildOiFlowSummary(mv: MarketAnalysisInput["oiMovement"] | undefined, calls: OptRow[], puts: OptRow[]) {
  const shock = calls.some((r) => r.oiFlow.startsWith("OI SHOCK")) || puts.some((r) => r.oiFlow.startsWith("OI SHOCK"));
  if (mv && (mv.trade || mv.direction)) {
    const d = mv.direction || mv.trade;
    const confirmed = d?.confirmed === true;
    const state = shock && !confirmed ? "OI SHOCK — UNDER REVIEW"
      : confirmed ? "CONFIRMED FLOW"
      : (d?.signal && d.signal !== "NEUTRAL" ? "BUILDING" : "NORMAL");
    return {
      state,
      note: shock && !confirmed
        ? "A sudden single-strike OI jump is awaiting price/volume confirmation before changing the read."
        : `OI movement ${d?.signal ?? "NEUTRAL"} / ${d?.strength ?? "CALM"}${confirmed ? " (price-confirmed)" : ""}.`,
      shock,
    };
  }
  return {
    state: shock ? "OI SHOCK — UNDER REVIEW" : "NORMAL",
    note: shock ? "Sudden single-strike OI jump — awaiting confirmation." : "No OI movement history yet this session.",
    shock,
  };
}

// Directional TILT across DOWN / SIDEWAYS / UP. This is a MODEL LEAN built from
// OI flow + option bias + price momentum + VWAP position — it is explicitly NOT
// a win-rate or probability of profit, and we never claim historical accuracy.
// VIX only widens the sideways band in calm regimes; it does not set direction.
// Shared bullish(+)/bearish(-) evidence score in ~[-100,100]. Price-driven: OI
// flow + option bias + momentum + VWAP. India VIX is deliberately NOT included
// (it measures volatility, not direction). Used by BOTH the market-direction
// read (row highlighting) and the movement tilt so they never disagree.
function directionEvidence(a: {
  oi: OiAnalysis | null; oiMovement?: MarketAnalysisInput["oiMovement"];
  breakout: ReturnType<typeof buildBreakout>; vwap15: number | null; spot: number;
}): number {
  const sig = (s?: string | null) => (s === "BULLISH" ? 1 : s === "BEARISH" ? -1 : 0);
  let e = 0;
  const dir = a.oiMovement?.direction || a.oiMovement?.trade;
  e += sig(dir?.signal) * 25;
  if (a.oi?.verdict?.bias === "Bullish") e += 15; else if (a.oi?.verdict?.bias === "Bearish") e -= 15;
  e += Math.max(-25, Math.min(25, a.breakout.momentumVal * 20));
  if (a.vwap15 != null) e += a.spot >= a.vwap15 ? 10 : -10;
  const pcr = a.oi?.pcr ?? null;
  if (pcr != null) { if (pcr > 1.2) e += 8; else if (pcr < 0.8) e -= 8; }
  return Math.max(-100, Math.min(100, e));
}

function buildMovementTilt(a: {
  oi: OiAnalysis | null; oiMovement?: MarketAnalysisInput["oiMovement"];
  breakout: ReturnType<typeof buildBreakout>; vwap15: number | null; spot: number;
}) {
  const e = directionEvidence(a);

  const dist = (damp: number) => {
    const ev = e * damp;
    let up = 34 + ev * 0.42;
    let down = 34 - ev * 0.42;
    let side = 32 - Math.abs(ev) * 0.22; // stronger evidence => less sideways
    up = Math.max(5, up); down = Math.max(5, down); side = Math.max(8, side);
    const tot = up + down + side;
    return { down: Math.round((down / tot) * 100), sideways: Math.round((side / tot) * 100), up: Math.round((up / tot) * 100) };
  };
  // 5-min is noisier (more sideways) → damp the directional evidence a touch.
  const n5 = dist(0.7);
  const n15 = dist(1.0);
  // fix rounding to sum 100
  const fix = (o: { down: number; sideways: number; up: number }) => { const s = o.down + o.sideways + o.up; if (s !== 100) o.sideways += 100 - s; return o; };
  return {
    next5m: fix(n5),
    next15m: fix(n15),
    lean: e > 12 ? "UP" : e < -12 ? "DOWN" : "SIDEWAYS",
    basis: "model tilt from OI flow + bias + momentum + VWAP (not a win rate / not accuracy)",
  };
}

function buildBaseline915(baseline: BaselineLike | null, oi: OiAnalysis | null, spot: number) {
  if (!baseline || !baseline.strikes.size) {
    return { captured: false, note: "9:15 baseline not captured yet (captures on the first chain of the session)." };
  }
  let baseCe = 0, basePe = 0;
  for (const v of baseline.strikes.values()) { baseCe += v.ceOi || 0; basePe += v.peOi || 0; }
  const curCe = oi?.totalCeOi ?? null, curPe = oi?.totalPeOi ?? null;
  const pctChg = (cur: number | null, base: number) => (cur != null && base > 0 ? r1n(((cur - base) / base) * 100) : null);
  const basePrice = baseline.underlying;
  return {
    captured: true,
    niftyPrice: basePrice,
    priceVsPts: basePrice != null ? r1n(spot - basePrice) : null,
    priceVsPct: basePrice != null && basePrice > 0 ? r2(((spot - basePrice) / basePrice) * 100) : null,
    totalCeOi915: baseCe,
    totalPeOi915: basePe,
    ceOiVsPct: pctChg(curCe, baseCe),
    peOiVsPct: pctChg(curPe, basePe),
    // Support strengthens when PE OI grows vs 9:15; resistance when CE OI grows.
    supportTrend: pctChg(curPe, basePe) == null ? "—" : (pctChg(curPe, basePe)! > 3 ? "STRENGTHENED" : pctChg(curPe, basePe)! < -3 ? "WEAKENED" : "STABLE"),
    resistanceTrend: pctChg(curCe, baseCe) == null ? "—" : (pctChg(curCe, baseCe)! > 3 ? "STRENGTHENED" : pctChg(curCe, baseCe)! < -3 ? "WEAKENED" : "STABLE"),
  };
}
