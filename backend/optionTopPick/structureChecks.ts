// ============================ Sections 7-9 — EMA structure, VWAP, regime ============================
import { Candle } from "../types";
import { MarketRegime } from "../paper/ext/types";
import { ema, vwap } from "../indicators";
import { OTP_CONFIG } from "./config";
import { EmaStructure, StructureFacts, VwapStatus } from "./types";

export function computeEmaStructure(spot: number, ema9: number | null, ema21: number | null, ema50: number | null): EmaStructure {
  if (ema9 != null && ema21 != null && ema50 != null) {
    if (spot > ema9 && ema9 > ema21 && ema21 > ema50) return "Strong Bullish";
    if (spot < ema9 && ema9 < ema21 && ema21 < ema50) return "Strong Bearish";
  }
  return "Mixed";
}

export function computeVwapStatus(candles: Candle[]): { status: VwapStatus; vwapValue: number | null } {
  const series = vwap(candles);
  const n = series.length;
  if (!n) return { status: "Choppy", vwapValue: null };
  const lookback = Math.min(OTP_CONFIG.vwap.lookbackBars, n - 1, candles.length - 1);
  const vNow = series[n - 1];
  if (vNow == null) return { status: "Choppy", vwapValue: null };
  const spotNow = candles[candles.length - 1].close;

  // Count sign changes of (close - vwap) over the lookback window — a market
  // that keeps crossing its own VWAP is choppy, whatever side it's on right now.
  let crosses = 0;
  let prevSign: number | null = null;
  for (let i = n - lookback; i < n; i++) {
    const v = series[i];
    if (v == null || i < 0 || i >= candles.length) continue;
    const sign = Math.sign(candles[i].close - v);
    if (prevSign != null && sign !== 0 && sign !== prevSign) crosses++;
    if (sign !== 0) prevSign = sign;
  }
  if (crosses > OTP_CONFIG.vwap.maxCrossesBeforeChoppy) return { status: "Choppy", vwapValue: vNow };

  const vPast = series[Math.max(0, n - lookback)];
  const slopeUp = vPast != null ? vNow > vPast : null;
  if (spotNow > vNow) return { status: slopeUp ? "Above+Rising" : "Above+Flat", vwapValue: vNow };
  if (spotNow < vNow) return { status: slopeUp === false ? "Below+Falling" : "Below+Flat", vwapValue: vNow };
  return { status: "Choppy", vwapValue: vNow };
}

export function buildStructureFacts(
  candles5m: Candle[],
  regime: { marketRegime: MarketRegime; regimeDir: "up" | "down" | "flat" } | null,
): StructureFacts {
  const closes = candles5m.map((c) => c.close);
  const spot = closes[closes.length - 1] ?? 0;
  const e9 = lastOf(ema(closes, 9));
  const e21 = lastOf(ema(closes, 21));
  const e50 = lastOf(ema(closes, 50));
  const { status, vwapValue } = computeVwapStatus(candles5m);
  return {
    emaStructure: computeEmaStructure(spot, e9, e21, e50),
    ema9: e9, ema21: e21, ema50: e50,
    vwapStatus: status,
    vwapValue,
    regime: regime?.marketRegime ?? null,
    regimeDir: regime ? (regime.regimeDir === "up" ? 1 : regime.regimeDir === "down" ? -1 : 0) : 0,
  };
}

function lastOf(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i];
  return null;
}
