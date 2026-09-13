import { Candle } from "../types";
import { ema, macd, vwap } from "../indicators";
import { detectStructure } from "../commentary/marketCommentary";
import { nearestStrike } from "../config";
import { MarketSnapshot } from "./marketSnapshot";

// ============================ DATA PROVIDER -> MarketSnapshot (Dhan) ============================
// Builds the standardized MarketSnapshot from Dhan historical candles. This is
// the ONLY place Dhan-specific candle data gets translated into the pipeline's
// common shape — everything after this (OI analysis, candidate generation,
// Master Trade Selector, risk, simulator) reads MarketSnapshot only, never a
// Dhan type directly. `optionChain` is always "NOT_AVAILABLE" here: Dhan has
// no historical full-chain data, so this builder never fabricates it — see
// historicalOptionChainProvider.ts for where a real one would plug in instead.
//
// Regime is intentionally left null here rather than reused from
// routes/api.ts's classifyRegime(): that function is written for LIVE
// multi-timeframe candles (5m/15m/1h) fetched together, not a single
// historical series — wiring it in would mean guessing which timeframe
// combination to feed it, which is a design decision for you to make, not one
// to assume silently.

export function buildMarketSnapshot(symbol: string, candles: Candle[], atIndex: number): MarketSnapshot {
  const upTo = candles.slice(0, atIndex + 1);
  const closes = upTo.map((c) => c.close);
  const bar = upTo[upTo.length - 1];

  const ema21Series = ema(closes, 21);
  const ema50Series = ema(closes, 50);
  const macdSeries = macd(closes);
  const vwapSeries = vwap(upTo);
  const structure = detectStructure(upTo);

  return {
    timestamp: bar.time,
    symbol,
    spot: bar.close,
    atm: bar.close > 0 ? nearestStrike(bar.close) : null,
    technicals: {
      ema21: ema21Series[ema21Series.length - 1],
      ema50: ema50Series[ema50Series.length - 1],
      macd: {
        line: macdSeries.macd[macdSeries.macd.length - 1],
        signal: macdSeries.signal[macdSeries.signal.length - 1],
        histogram: macdSeries.histogram[macdSeries.histogram.length - 1],
      },
      vwap: vwapSeries[vwapSeries.length - 1],
      structure,
    },
    regime: null, // see header note — not wired in, not guessed
    optionChain: "NOT_AVAILABLE",
  };
}

// One snapshot per bar, starting once there's enough history for the longest
// indicator (EMA50) to be defined. Used by the FULL_MASTER path to check
// option-chain availability at each historical moment before ever generating
// a candidate.
export function buildMarketSnapshots(symbol: string, candles: Candle[]): MarketSnapshot[] {
  const out: MarketSnapshot[] = [];
  for (let i = 50; i < candles.length; i++) {
    out.push(buildMarketSnapshot(symbol, candles, i));
  }
  return out;
}
