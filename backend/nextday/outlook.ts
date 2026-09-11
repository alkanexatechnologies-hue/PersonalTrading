import { SymbolDef } from "../config";
import { Candle, NextDayPick } from "../types";
import { computeSignal } from "../signals/engine";
import { DIRECTION_THRESHOLD } from "../signals/score";

/**
 * Build a next-session bias for one symbol from DAILY candles.
 * Best read near the close (~3:10 PM IST) when the day's candle is nearly final.
 * This is a probabilistic trend bias for tomorrow - NOT a prediction of gains.
 */
export function buildNextDayPick(def: SymbolDef, daily: Candle[]): NextDayPick | null {
  if (daily.length < 30) return null;
  const sig = computeSignal(def.symbol, daily);
  const lastC = daily[daily.length - 1];
  const prevC = daily[daily.length - 2];

  const range = lastC.high - lastC.low;
  const closingStrength = range > 0 ? ((lastC.close - lastC.low) / range) * 100 : 50;
  const changePercent = prevC.close ? ((lastC.close - prevC.close) / prevC.close) * 100 : 0;

  const bias: NextDayPick["bias"] = sig.score >= DIRECTION_THRESHOLD ? "Bullish" : sig.score <= -DIRECTION_THRESHOLD ? "Bearish" : "Neutral";

  // Outlook score: conviction x confidence, tilted by whether the close aligns
  // with the bias (strong close supports a bullish carry; weak close supports bearish).
  let base = (Math.abs(sig.score) * sig.confidence) / 100;
  if (bias === "Bullish") base *= 0.6 + (closingStrength / 100) * 0.8;
  else if (bias === "Bearish") base *= 0.6 + ((100 - closingStrength) / 100) * 0.8;
  const outlookScore = Math.round(base);

  const optionType = bias === "Bullish" ? "CE" : bias === "Bearish" ? "PE" : null;

  const note =
    bias === "Neutral"
      ? "Daily trend flat - no clear carry-forward bias."
      : `Daily trend ${bias.toLowerCase()} (score ${sig.score}, conf ${sig.confidence}%); ` +
        `closed at ${Math.round(closingStrength)}% of the day's range. ` +
        (bias === "Bullish"
          ? "Leans up for the next session if it holds above today's close."
          : "Leans down for the next session if it stays below today's close.");

  return {
    symbol: def.symbol,
    name: def.name,
    type: def.type,
    close: sig.price,
    changePercent: Math.round(changePercent * 100) / 100,
    dailyScore: sig.score,
    confidence: sig.confidence,
    closingStrength: Math.round(closingStrength),
    bias,
    optionType,
    outlookScore,
    note,
  };
}
