import { Candle } from "../types";

// Order Block detection from intraday candles.
// An Order Block is the last opposite-direction candle before a strong
// impulsive move (Break of Structure). This is standard SMC (Smart Money
// Concepts) logic applied to the candle data the system already fetches.
//
// Two-stage model so a setup is visible EARLY, not only after it has played out:
//   • Pre       — price has poked through a swing level (the move is starting),
//                 but no candle has CLOSED through it yet. The block is forming.
//   • Confirmed — a candle has closed through the swing level (structural break),
//                 and VWAP agrees with the break direction.
// The same Pre/Confirmed staging is applied to the overall direction so a
// direction change is flagged as it begins (VWAP + momentum) and again once a
// break of structure confirms it.

export type OBSide = "Bullish" | "Bearish";
export type OBStatus = "Fresh" | "Mitigated" | "Invalid";
export type Stage = "Pre" | "Confirmed";
export type Dir = "Bullish" | "Bearish" | "Ranging";

export interface OrderBlock {
  side: OBSide;
  high: number;
  low: number;
  time: number;
  status: OBStatus;
  stage: Stage;          // Pre = forming (poke), Confirmed = closed-through
  vwapAligned: boolean;  // was the break in agreement with VWAP?
  bosTime: number;
  bosPrice: number;
}

export interface StructurePoint {
  type: "HH" | "HL" | "LH" | "LL";
  price: number;
  time: number;
  index: number;
}

export interface BOSEvent {
  direction: "Bullish" | "Bearish";
  level: number;
  breakTime: number;
  breakIndex: number;
  stage: Stage;
}

export interface DirectionChange {
  stage: Stage | "None";
  from: Dir;
  to: Dir;
}

export interface MarketStructureResult {
  swingPoints: StructurePoint[];
  bosEvents: BOSEvent[];
  orderBlocks: OrderBlock[];
  currentStructure: Dir;      // confirmed structure (from closed-through BOS)
  preStructure: Dir;          // early read from VWAP + short-term momentum
  vwapStatus: "Above" | "Below" | "At";
  directionChange: DirectionChange;
}

function findSwingPoints(candles: Candle[], lookback: number = 3): StructurePoint[] {
  const points: StructurePoint[] = [];
  if (candles.length < lookback * 2 + 1) return points;

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isSwingHigh = false;
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) {
      const prev = points.filter((p) => p.type === "HH" || p.type === "LH");
      const lastHigh = prev.length ? prev[prev.length - 1].price : 0;
      points.push({ type: candles[i].high > lastHigh ? "HH" : "LH", price: candles[i].high, time: candles[i].time, index: i });
    }
    if (isSwingLow) {
      const prev = points.filter((p) => p.type === "HL" || p.type === "LL");
      const lastLow = prev.length ? prev[prev.length - 1].price : Infinity;
      points.push({ type: candles[i].low < lastLow ? "LL" : "HL", price: candles[i].low, time: candles[i].time, index: i });
    }
  }

  return points.sort((a, b) => a.index - b.index);
}

// One event per swing: Confirmed if a candle CLOSED through the level, else Pre
// if a candle only POKED through it (high/low breached but no close-through).
// vwapArr, when supplied, decides whether the confirming candle agrees with VWAP.
function detectBOS(candles: Candle[], swingPoints: StructurePoint[], vwapArr?: (number | null)[]): BOSEvent[] {
  const events: BOSEvent[] = [];
  const highs = swingPoints.filter((p) => p.type === "HH" || p.type === "LH");
  const lows = swingPoints.filter((p) => p.type === "HL" || p.type === "LL");
  const SCOPE = 30;

  for (const sh of highs) {
    let pokeIdx = -1, closeIdx = -1;
    for (let i = sh.index + 1; i < candles.length && i - sh.index <= SCOPE; i++) {
      if (pokeIdx < 0 && candles[i].high > sh.price) pokeIdx = i;
      if (candles[i].close > sh.price) { closeIdx = i; break; }
    }
    if (closeIdx >= 0) {
      events.push({ direction: "Bullish", level: sh.price, breakTime: candles[closeIdx].time, breakIndex: closeIdx, stage: "Confirmed" });
    } else if (pokeIdx >= 0) {
      events.push({ direction: "Bullish", level: sh.price, breakTime: candles[pokeIdx].time, breakIndex: pokeIdx, stage: "Pre" });
    }
  }

  for (const sl of lows) {
    let pokeIdx = -1, closeIdx = -1;
    for (let i = sl.index + 1; i < candles.length && i - sl.index <= SCOPE; i++) {
      if (pokeIdx < 0 && candles[i].low < sl.price) pokeIdx = i;
      if (candles[i].close < sl.price) { closeIdx = i; break; }
    }
    if (closeIdx >= 0) {
      events.push({ direction: "Bearish", level: sl.price, breakTime: candles[closeIdx].time, breakIndex: closeIdx, stage: "Confirmed" });
    } else if (pokeIdx >= 0) {
      events.push({ direction: "Bearish", level: sl.price, breakTime: candles[pokeIdx].time, breakIndex: pokeIdx, stage: "Pre" });
    }
  }

  return events.sort((a, b) => a.breakIndex - b.breakIndex);
}

function findOrderBlocks(candles: Candle[], bosEvents: BOSEvent[], vwapArr?: (number | null)[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];

  for (const bos of bosEvents) {
    const searchStart = Math.max(0, bos.breakIndex - 15);
    let obCandle: Candle | null = null;
    let obIndex = -1;

    if (bos.direction === "Bullish") {
      for (let i = bos.breakIndex - 1; i >= searchStart; i--) {
        if (candles[i].close < candles[i].open) { obCandle = candles[i]; obIndex = i; break; }
      }
    } else {
      for (let i = bos.breakIndex - 1; i >= searchStart; i--) {
        if (candles[i].close > candles[i].open) { obCandle = candles[i]; obIndex = i; break; }
      }
    }
    if (!obCandle || obIndex < 0) continue;

    // Impulse quality: the break candle should be meaningfully bigger than the OB.
    const bosCandle = candles[bos.breakIndex];
    const impulseSize = Math.abs(bosCandle.close - bosCandle.open);
    const obSize = Math.abs(obCandle.close - obCandle.open);
    if (impulseSize < obSize * 0.5) continue;

    // VWAP agreement at the break candle.
    const vw = vwapArr && vwapArr[bos.breakIndex] != null ? vwapArr[bos.breakIndex] : null;
    const vwapAligned = vw == null ? true
      : bos.direction === "Bullish" ? bosCandle.close >= vw : bosCandle.close <= vw;

    // A closed-through break only counts as a Confirmed block when VWAP agrees;
    // otherwise it is still Pre (structure broke but VWAP has not confirmed).
    const stage: Stage = bos.stage === "Confirmed" && vwapAligned ? "Confirmed" : "Pre";

    blocks.push({
      side: bos.direction,
      high: obCandle.high,
      low: obCandle.low,
      time: obCandle.time,
      status: "Fresh",
      stage,
      vwapAligned,
      bosTime: bosCandle.time,
      bosPrice: bos.level,
    });
  }

  return blocks;
}

function updateOBStatus(blocks: OrderBlock[], candles: Candle[]): void {
  for (const ob of blocks) {
    const obFormTime = ob.bosTime;
    const laterCandles = candles.filter((c) => c.time > obFormTime);
    for (const c of laterCandles) {
      if (ob.side === "Bullish") {
        if (c.close < ob.low) { ob.status = "Invalid"; break; }
        if (c.low <= ob.high && c.close > ob.high) ob.status = "Mitigated";
      } else {
        if (c.close > ob.high) { ob.status = "Invalid"; break; }
        if (c.high >= ob.low && c.close < ob.low) ob.status = "Mitigated";
      }
    }
  }
}

export function detectMarketStructure(candles: Candle[], lookback: number = 3, vwapArr?: (number | null)[]): MarketStructureResult {
  if (candles.length < 20) {
    return { swingPoints: [], bosEvents: [], orderBlocks: [], currentStructure: "Ranging", preStructure: "Ranging", vwapStatus: "At", directionChange: { stage: "None", from: "Ranging", to: "Ranging" } };
  }

  const swingPoints = findSwingPoints(candles, lookback);
  const bosEvents = detectBOS(candles, swingPoints, vwapArr);
  const orderBlocks = findOrderBlocks(candles, bosEvents, vwapArr);
  updateOBStatus(orderBlocks, candles);

  // Confirmed structure: from the last few CONFIRMED breaks only.
  const confirmed = bosEvents.filter((b) => b.stage === "Confirmed");
  const recent = confirmed.slice(-3);
  const bull = recent.filter((b) => b.direction === "Bullish").length;
  const bear = recent.filter((b) => b.direction === "Bearish").length;
  const currentStructure: Dir = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Ranging";

  // Early (pre) read: VWAP side + short-term momentum over the last 3 bars.
  const lastC = candles[candles.length - 1];
  const vwLast = vwapArr && vwapArr[candles.length - 1] != null ? vwapArr[candles.length - 1] : null;
  const eps = lastC.close * 0.0003;
  const vwapStatus: "Above" | "Below" | "At" =
    vwLast == null ? "At" : lastC.close > vwLast + eps ? "Above" : lastC.close < vwLast - eps ? "Below" : "At";
  const back = candles[Math.max(0, candles.length - 4)];
  const momentumUp = lastC.close > back.close;
  const momentumDown = lastC.close < back.close;
  const preStructure: Dir =
    vwapStatus === "Above" && momentumUp ? "Bullish"
    : vwapStatus === "Below" && momentumDown ? "Bearish"
    : "Ranging";

  // Direction change: Confirmed when the latest confirmed break flips the prior
  // confirmed direction; Pre when VWAP+momentum lean opposite to the confirmed
  // structure (an early turn that has not broken structure yet).
  let directionChange: DirectionChange = { stage: "None", from: currentStructure, to: currentStructure };
  if (confirmed.length >= 2) {
    const lastDir = confirmed[confirmed.length - 1].direction;
    const prevDir = confirmed[confirmed.length - 2].direction;
    if (lastDir !== prevDir) directionChange = { stage: "Confirmed", from: prevDir, to: lastDir };
  }
  if (directionChange.stage === "None" && preStructure !== "Ranging" && currentStructure !== "Ranging" && preStructure !== currentStructure) {
    directionChange = { stage: "Pre", from: currentStructure, to: preStructure };
  }

  return { swingPoints, bosEvents, orderBlocks, currentStructure, preStructure, vwapStatus, directionChange };
}

// Nearest valid (Fresh) OB relative to the current price. Confirmed blocks are
// preferred; a Pre block is only returned when no confirmed one qualifies.
export function nearestValidOB(
  blocks: OrderBlock[],
  spot: number,
  direction: "Bullish" | "Bearish" | null,
): OrderBlock | null {
  const pick = (pool: OrderBlock[]): OrderBlock | null => {
    if (!pool.length) return null;
    if (direction === "Bullish") {
      const below = pool.filter((ob) => ob.side === "Bullish" && ob.high <= spot);
      if (!below.length) return null;
      return below.reduce((best, ob) => (spot - ob.high < spot - best.high ? ob : best));
    }
    if (direction === "Bearish") {
      const above = pool.filter((ob) => ob.side === "Bearish" && ob.low >= spot);
      if (!above.length) return null;
      return above.reduce((best, ob) => (ob.low - spot < best.low - spot ? ob : best));
    }
    return pool.reduce((best, ob) => {
      const distBest = Math.min(Math.abs(spot - best.high), Math.abs(spot - best.low));
      const distOb = Math.min(Math.abs(spot - ob.high), Math.abs(spot - ob.low));
      return distOb < distBest ? ob : best;
    });
  };
  const fresh = blocks.filter((ob) => ob.status === "Fresh");
  return pick(fresh.filter((ob) => ob.stage === "Confirmed")) || pick(fresh);
}

// Is price currently inside or approaching an Order Block zone?
export function priceRelativeToOB(
  spot: number,
  ob: OrderBlock,
  atr: number,
): "Inside" | "Approaching" | "Away" {
  if (spot >= ob.low && spot <= ob.high) return "Inside";
  const dist = spot < ob.low ? ob.low - spot : spot - ob.high;
  if (dist <= atr * 0.5) return "Approaching";
  return "Away";
}
