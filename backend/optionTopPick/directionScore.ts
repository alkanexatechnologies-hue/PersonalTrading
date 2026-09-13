// ============================ Section 3 — Direction engine ============================
// Independent CE/PE vote scores, built entirely from votes ALREADY computed
// elsewhere in this app (backend/signals/engine.ts's computeSignal(), which already
// evaluates EMA 9/21, VWAP, MACD, Bollinger and Supertrend on real candles) plus the
// options-specific OI verdict and PCR state. No indicator math is reimplemented here.

import { IndicatorVote } from "../types";
import { OTP_CONFIG } from "./config";
import { DirectionScoreResult, OptionSide, Vote } from "./types";

export interface DirectionScoreInput {
  signalVotes: IndicatorVote[]; // computeSignal(symbol, candles5m).votes
  oiVerdict: "Bullish" | "Bearish" | "Neutral" | "TWO_SIDED";
  pcrState: "bullish" | "bearish" | "neutral";
}

function findVote(votes: IndicatorVote[], name: string): IndicatorVote | undefined {
  return votes.find((v) => v.name === name);
}

/** One factor -> at most one side gets the weight; the other side's vote entry is
 * recorded at weight 0 (bias "neutral") purely for a transparent, symmetric report. */
function apply(
  ceVotes: Vote[], peVotes: Vote[],
  name: string, weight: number,
  bias: "bullish" | "bearish" | "neutral", reason: string,
): void {
  if (bias === "bullish") {
    ceVotes.push({ name, bias: "bullish", weight, reason });
    peVotes.push({ name, bias: "neutral", weight: 0, reason: `not bearish: ${reason}` });
  } else if (bias === "bearish") {
    peVotes.push({ name, bias: "bearish", weight, reason });
    ceVotes.push({ name, bias: "neutral", weight: 0, reason: `not bullish: ${reason}` });
  } else {
    ceVotes.push({ name, bias: "neutral", weight: 0, reason });
    peVotes.push({ name, bias: "neutral", weight: 0, reason });
  }
}

export function computeDirectionScore(input: DirectionScoreInput): DirectionScoreResult {
  const { votes: W, maxScore } = OTP_CONFIG;
  const ceVotes: Vote[] = [];
  const peVotes: Vote[] = [];

  // +2 / -2 — OI structure (the only double-weighted vote).
  apply(
    ceVotes, peVotes, "OI structure", W.oiWeight,
    input.oiVerdict === "Bullish" ? "bullish" : input.oiVerdict === "Bearish" ? "bearish" : "neutral",
    input.oiVerdict === "TWO_SIDED" ? "OI shows heavy writing on both sides — conflicted, no OI edge" : `OI verdict: ${input.oiVerdict}`,
  );

  // +1 — price structure (Bollinger: price vs mid-band).
  const bb = findVote(input.signalVotes, "Bollinger");
  apply(ceVotes, peVotes, "Price structure", W.priceStructureWeight, bb?.bias ?? "neutral", bb?.reason ?? "Bollinger unavailable");

  // +1 — spot vs VWAP.
  const vwapV = findVote(input.signalVotes, "VWAP");
  apply(ceVotes, peVotes, "Spot vs VWAP", W.vwapWeight, vwapV?.bias ?? "neutral", vwapV?.reason ?? "VWAP unavailable");

  // +1 — EMA 9 vs EMA 21.
  const emaV = findVote(input.signalVotes, "EMA 9/21");
  apply(ceVotes, peVotes, "EMA 9 vs 21", W.emaCrossWeight, emaV?.bias ?? "neutral", emaV?.reason ?? "EMA unavailable");

  // +1 — recent candle/trend structure (Supertrend is this app's existing
  // trend-following read on recent candles).
  const stV = findVote(input.signalVotes, "Supertrend");
  apply(ceVotes, peVotes, "Recent candle structure", W.candleStructureWeight, stV?.bias ?? "neutral", stV?.reason ?? "Supertrend unavailable");

  // +1 — PCR.
  apply(
    ceVotes, peVotes, "PCR", W.pcrWeight,
    input.pcrState === "bullish" ? "bullish" : input.pcrState === "bearish" ? "bearish" : "neutral",
    `PCR state: ${input.pcrState}`,
  );

  // +1 — momentum (MACD histogram vs signal).
  const macdV = findVote(input.signalVotes, "MACD");
  apply(ceVotes, peVotes, "Momentum", W.momentumWeight, macdV?.bias ?? "neutral", macdV?.reason ?? "MACD unavailable");

  const ceScore = ceVotes.reduce((s, v) => s + (v.bias === "bullish" ? v.weight : 0), 0);
  const peScore = peVotes.reduce((s, v) => s + (v.bias === "bearish" ? v.weight : 0), 0);

  return { ceScore, peScore, maxScore, ceVotes, peVotes };
}

/** Section 22 — "do not force a signal": a side only wins if it clears the other
 * by at least minScoreEdge AND clears its own minWinningScore floor. A 6-6 tie or
 * an 8-5 lead that's still numerically weak both return null (NO EDGE / WAIT). */
export function pickWinningSide(ceScore: number, peScore: number): OptionSide | null {
  const edge = ceScore - peScore;
  if (Math.abs(edge) < OTP_CONFIG.minScoreEdge) return null;
  const side: OptionSide = edge > 0 ? "CE" : "PE";
  const winScore = edge > 0 ? ceScore : peScore;
  return winScore >= OTP_CONFIG.minWinningScore ? side : null;
}
