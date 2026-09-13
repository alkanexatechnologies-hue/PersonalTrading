import { ema, last } from "../indicators";

export type EmaDirection = "Bullish" | "Bearish" | "Neutral";

// EMA 9/21 short-term crossover — the SAME definition already live in
// signals/engine.ts / signals/score.ts / signals/direction4L.ts. No new
// threshold introduced; this just re-exposes the existing crossover as its
// own reusable read for the Master Trade Selector confluence check.
export function emaShortDirection(closes: number[]): EmaDirection {
  if (closes.length < 21) return "Neutral";
  const e9 = last(ema(closes, 9));
  const e21 = last(ema(closes, 21));
  if (e9 == null || e21 == null) return "Neutral";
  return e9 > e21 ? "Bullish" : e9 < e21 ? "Bearish" : "Neutral";
}

// EMA 21/50 — reuses BOTH existing marketCommentary.ts factors verbatim
// (commentary/marketCommentary.ts:156-163): "21/50 EMA" (price vs both EMAs)
// and "EMA Cross" (EMA21 vs EMA50), and requires them to agree before calling
// a direction. No new formula invented — this is a stricter AND of two
// pre-existing, previously display-only conditions, chosen because it was the
// most literal way to turn two existing display factors into one binary
// confluence read without picking one over the other or blending new weights.
export function emaLongDirection(price: number, closes: number[]): EmaDirection {
  if (closes.length < 50) return "Neutral";
  const e21 = last(ema(closes, 21));
  const e50 = last(ema(closes, 50));
  if (e21 == null || e50 == null) return "Neutral";
  const priceVsBoth: EmaDirection = price > e21 && price > e50 ? "Bullish" : price < e21 && price < e50 ? "Bearish" : "Neutral";
  const cross: EmaDirection = e21 > e50 ? "Bullish" : e21 < e50 ? "Bearish" : "Neutral";
  return priceVsBoth === cross ? priceVsBoth : "Neutral";
}

// Master Trade Selector EMA confluence (session decision): EMA counts as
// aligned with a direction only when EMA9/21 AND EMA21/50 agree with EACH
// OTHER. Any disagreement between the two, or either being Neutral (flat
// crossover / insufficient history), reads as Neutral overall — never itself
// an opposing signal. paper/engine.ts's veto only blocks on an ACTIVE
// opposing read (Neutral never blocks), per the "flat = neutral" decision.
export function emaConfluenceDirection(price: number, closes: number[]): EmaDirection {
  const short = emaShortDirection(closes);
  const long = emaLongDirection(price, closes);
  return short === long ? short : "Neutral";
}
