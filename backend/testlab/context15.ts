// 15-MINUTE MARKET CONTEXT for the Trade Decision layer (higher-timeframe view).
// Reuses the existing V1.2 15M direction engine (htfEngine.direction15Series:
// EMA 9/21 + VWAP side + structure + regression votes) and adds 15M levels,
// volatility and momentum. Strictly causal: a lower-timeframe candle only sees
// 15M candles that have FULLY CLOSED by the time it closes; the latest closed
// 15M context stays active until the next 15M candle closes. The 5M movement
// engine never waits for a 15M close.

import { Candle } from "../types";
import { atrSeries, emaSeries, supportResistance } from "./components";
import { direction15Series } from "./htfEngine";
import { TestConfig } from "./types";

export type Regime15 = "BULLISH" | "BEARISH" | "RANGE" | "TRANSITION" | "NEUTRAL";

export interface Ctx15 {
  regime: Regime15;
  master: string;                 // underlying 15M master direction (STRONG_BULLISH .. CONFLICT)
  confidence: string;
  barIso: string;                 // the closed 15M candle this context comes from
  ema: "UP" | "DOWN" | "FLAT";
  vwapSide: "ABOVE" | "BELOW" | "AT";
  structure: string;
  trend: string;                  // TRENDING UP / TRENDING DOWN / RANGE
  support: number | null; resistance: number | null;   // 15M major levels
  atrPct: number | null;          // 15M volatility
  momentum: "STRONG_UP" | "UP" | "FLAT" | "DOWN" | "STRONG_DOWN";
  votes: { bull: number; bear: number };
}

const WINDOW = 120;
const sign = (m: string) => (m.includes("BULLISH") ? 1 : m.includes("BEARISH") ? -1 : 0);

/** One context per lower-timeframe candle (null until two 15M candles have closed). */
export function context15ForSeries(c: Candle[], c15: Candle[], tfSec: number, cfg: TestConfig): (Ctx15 | null)[] {
  const out: (Ctx15 | null)[] = new Array(c.length).fill(null);
  if (!c15.length) return out;
  const dir = direction15Series(c15, cfg);
  const ema9 = emaSeries(c15, cfg.emaFast), ema21 = emaSeries(c15, cfg.emaSlow), atr = atrSeries(c15, cfg.atrPeriod);
  const ctx: Ctx15[] = dir.map((d, j) => {
    const prevSign = j > 0 ? sign(dir[j - 1].master) : 0, nowSign = sign(d.master);
    const regime: Regime15 = d.master === "CONFLICT" || (prevSign !== 0 && nowSign !== 0 && prevSign !== nowSign) ? "TRANSITION"
      : nowSign > 0 ? "BULLISH" : nowSign < 0 ? "BEARISH" : "RANGE";
    const a = atr[j] ?? null, e9 = ema9[j] ?? null, e21 = ema21[j] ?? null;
    const spreadAtr = e9 != null && e21 != null && a ? (e9 - e21) / a : 0;
    const momentum: Ctx15["momentum"] = spreadAtr > 0.5 ? "STRONG_UP" : spreadAtr > 0.15 ? "UP" : spreadAtr < -0.5 ? "STRONG_DOWN" : spreadAtr < -0.15 ? "DOWN" : "FLAT";
    const { support, resistance } = supportResistance(c15.slice(Math.max(0, j - WINDOW + 1), j + 1), c15[j].close);
    return {
      regime, master: d.master, confidence: d.confidence, barIso: d.iso, ema: d.ema, vwapSide: d.vwapSide,
      structure: d.structure, trend: d.regime,
      support: support != null ? +support.toFixed(2) : null, resistance: resistance != null ? +resistance.toFixed(2) : null,
      atrPct: a != null && c15[j].close ? +((a / c15[j].close) * 100).toFixed(3) : null,
      momentum, votes: { bull: d.bull, bear: d.bear },
    };
  });
  let j = 0;
  for (let i = 0; i < c.length; i++) {
    const closeT = c[i].time + tfSec;
    while (j < c15.length && c15[j].time + 900 <= closeT) j++;
    const k = j - 1; // last 15M candle fully closed by this candle's close
    out[i] = k >= 1 ? ctx[k] : null;
  }
  return out;
}
