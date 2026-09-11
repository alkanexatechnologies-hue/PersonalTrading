import { Candle, IndicatorVote, SignalLabel, SignalResult } from "../types";
import {
  atr,
  bollinger,
  ema,
  last,
  macd,
  rsi,
  sma,
  supertrend,
  vwap,
} from "../indicators";
import { DISCLAIMER } from "../config";
import { MAX_SCORE, WEIGHTS } from "./score";
import { atrStopTarget } from "../indicators/riskLevels";
import { dayHighLow } from "../indicators/dayRange";

// Each indicator contributes a signed vote in [-weight, +weight].
// The sum is normalised to a -100..+100 score. Weights are shared with the
// backtest scorer (src/signals/score.ts) so live and historical scores match.

export function computeSignal(symbol: string, candles: Candle[]): SignalResult {
  const closes = candles.map((c) => c.close);
  const votes: IndicatorVote[] = [];
  let raw = 0;

  const price = closes[closes.length - 1];
  const asOf = candles[candles.length - 1].time;

  // Current session (day) high/low - key intraday levels for CALL/PUT decisions.
  const { high: dHigh, low: dLow } = dayHighLow(candles);
  const dayHigh = dHigh != null ? round2(dHigh) : null;
  const dayLow = dLow != null ? round2(dLow) : null;

  // 1. EMA 9/21 crossover (trend)
  const ema9 = last(ema(closes, 9));
  const ema21 = last(ema(closes, 21));
  if (ema9 != null && ema21 != null) {
    const spreadPct = ((ema9 - ema21) / ema21) * 100;
    const bias = ema9 > ema21 ? "bullish" : ema9 < ema21 ? "bearish" : "neutral";
    // Scale contribution by spread size, capped.
    const strength = Math.min(1, Math.abs(spreadPct) / 0.5);
    const contrib = (ema9 > ema21 ? 1 : -1) * WEIGHTS.emaCross * strength;
    raw += contrib;
    votes.push({
      name: "EMA 9/21",
      value: `9=${ema9.toFixed(2)} / 21=${ema21.toFixed(2)}`,
      bias,
      weight: Math.abs(contrib),
      reason:
        bias === "bullish"
          ? "Fast EMA above slow EMA - short-term uptrend"
          : bias === "bearish"
          ? "Fast EMA below slow EMA - short-term downtrend"
          : "EMAs flat",
    });
  }

  // 2. Supertrend (trend-following)
  const st = supertrend(candles, 10, 3);
  const stLast = st[st.length - 1];
  if (stLast && stLast.direction !== 0) {
    const bias = stLast.direction === 1 ? "bullish" : "bearish";
    const contrib = stLast.direction * WEIGHTS.supertrend;
    raw += contrib;
    votes.push({
      name: "Supertrend",
      value: stLast.value != null ? stLast.value.toFixed(2) : "-",
      bias,
      weight: WEIGHTS.supertrend,
      reason:
        bias === "bullish"
          ? "Price above Supertrend line - trend up"
          : "Price below Supertrend line - trend down",
    });
  }

  // 3. VWAP (intraday fair value)
  const vwapLast = last(vwap(candles));
  if (vwapLast != null) {
    const diffPct = ((price - vwapLast) / vwapLast) * 100;
    const bias = price > vwapLast ? "bullish" : price < vwapLast ? "bearish" : "neutral";
    const strength = Math.min(1, Math.abs(diffPct) / 0.4);
    const contrib = (price > vwapLast ? 1 : -1) * WEIGHTS.vwap * strength;
    raw += contrib;
    votes.push({
      name: "VWAP",
      value: vwapLast.toFixed(2),
      bias,
      weight: Math.abs(contrib),
      reason:
        bias === "bullish"
          ? "Trading above VWAP - buyers in control"
          : "Trading below VWAP - sellers in control",
    });
  }

  // 4. MACD histogram (momentum)
  const m = macd(closes);
  const hist = last(m.histogram);
  const macdLine = last(m.macd);
  const signalLine = last(m.signal);
  if (hist != null && macdLine != null && signalLine != null) {
    const bias = hist > 0 ? "bullish" : hist < 0 ? "bearish" : "neutral";
    const strength = Math.min(1, Math.abs(hist) / (Math.abs(macdLine) + 1e-9));
    const contrib = (hist > 0 ? 1 : -1) * WEIGHTS.macd * Math.max(0.4, strength);
    raw += contrib;
    votes.push({
      name: "MACD",
      value: `hist=${hist.toFixed(2)}`,
      bias,
      weight: Math.abs(contrib),
      reason:
        bias === "bullish"
          ? "MACD above signal - upward momentum"
          : "MACD below signal - downward momentum",
    });
  }

  // 5. RSI (overbought / oversold)
  const rsiLast = last(rsi(closes, 14));
  if (rsiLast != null) {
    let contrib = 0;
    let bias: IndicatorVote["bias"] = "neutral";
    let reason = "RSI neutral";
    if (rsiLast < 30) {
      contrib = WEIGHTS.rsi; // oversold -> potential bounce
      bias = "bullish";
      reason = "RSI oversold (<30) - possible bounce";
    } else if (rsiLast > 70) {
      contrib = -WEIGHTS.rsi; // overbought -> potential pullback
      bias = "bearish";
      reason = "RSI overbought (>70) - possible pullback";
    } else if (rsiLast >= 55) {
      contrib = WEIGHTS.rsi * 0.4;
      bias = "bullish";
      reason = "RSI above 55 - bullish momentum";
    } else if (rsiLast <= 45) {
      contrib = -WEIGHTS.rsi * 0.4;
      bias = "bearish";
      reason = "RSI below 45 - bearish momentum";
    }
    raw += contrib;
    votes.push({
      name: "RSI (14)",
      value: rsiLast.toFixed(1),
      bias,
      weight: Math.abs(contrib),
      reason,
    });
  }

  // 6. Bollinger position (mean reversion hint)
  const bb = bollinger(closes, 20, 2);
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  if (bbUpper != null && bbLower != null) {
    let contrib = 0;
    let bias: IndicatorVote["bias"] = "neutral";
    let reason = "Inside Bollinger Bands";
    if (price >= bbUpper) {
      contrib = -WEIGHTS.bollinger;
      bias = "bearish";
      reason = "At/above upper band - stretched";
    } else if (price <= bbLower) {
      contrib = WEIGHTS.bollinger;
      bias = "bullish";
      reason = "At/below lower band - stretched";
    }
    raw += contrib;
    votes.push({
      name: "Bollinger",
      value: `U=${bbUpper.toFixed(2)} L=${bbLower.toFixed(2)}`,
      bias,
      weight: Math.abs(contrib),
      reason,
    });
  }

  const score = clamp(Math.round((raw / MAX_SCORE) * 100), -100, 100);
  const label = toLabel(score);

  // Confidence blends signal magnitude with how much indicators agree.
  const bullVotes = votes.filter((v) => v.bias === "bullish").length;
  const bearVotes = votes.filter((v) => v.bias === "bearish").length;
  const totalDirectional = bullVotes + bearVotes || 1;
  const agreement = Math.abs(bullVotes - bearVotes) / totalDirectional;
  const confidence = clamp(
    Math.round((Math.abs(score) * 0.6 + agreement * 100 * 0.4)),
    0,
    100
  );

  // ATR-based stop / target suggestions in the signal's direction.
  const atrLast = last(atr(candles, 14));
  let suggestedStopLoss: number | null = null;
  let suggestedTarget: number | null = null;
  if (atrLast != null && score !== 0) {
    const { stop, target } = atrStopTarget(price, atrLast, score > 0 ? 1 : -1);
    suggestedStopLoss = round2(stop);
    suggestedTarget = round2(target);
  }

  votes.sort((a, b) => b.weight - a.weight);

  return {
    symbol,
    asOf,
    price: round2(price),
    dayHigh,
    dayLow,
    score,
    label,
    confidence,
    votes,
    suggestedStopLoss,
    suggestedTarget,
    atr: atrLast != null ? round2(atrLast) : null,
    disclaimer: DISCLAIMER,
  };
}

function toLabel(score: number): SignalLabel {
  if (score >= 50) return "STRONG BUY";
  if (score >= 15) return "BUY";
  if (score <= -50) return "STRONG SELL";
  if (score <= -15) return "SELL";
  return "HOLD";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
