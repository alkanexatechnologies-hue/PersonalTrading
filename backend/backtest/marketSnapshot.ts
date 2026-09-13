// ============================ MarketSnapshot ============================
// The standardized, provider-agnostic shape every stage of the pipeline below
// consumes — no stage after "DATA PROVIDER" ever imports Groww or Dhan
// directly again:
//
//   DATA PROVIDER -> MarketSnapshot -> OI Analysis -> Technical Analysis ->
//   Candidate Generation -> Master Trade Selector -> Risk Management ->
//   Trade Execution Simulator
//
// `optionChain` is either real strike-level data (live: from Groww today) or
// the literal string "NOT_AVAILABLE" (historical, until a real historical
// full-chain provider exists — see historicalOptionChainProvider.ts). It is
// NEVER fabricated, never backfilled from today's or a future chain. Anything
// downstream that needs optionChain MUST check for "NOT_AVAILABLE" and refuse
// to proceed rather than guess.

export interface OptionChainSnapshot {
  strike: number;
  expiry: string;
  callOi: number;
  putOi: number;
  oiChange: number;
  ltp: number;
  volume: number;
}

export type OptionChainAvailability = OptionChainSnapshot[] | "NOT_AVAILABLE";

export interface TechnicalSnapshot {
  ema21: number | null;
  ema50: number | null;
  macd: { line: number | null; signal: number | null; histogram: number | null };
  vwap: number | null;
  structure: string | null; // detectStructure()'s Structure ("Bullish"/"Bearish"/"Range"/"Unclear")
}

export interface MarketSnapshot {
  timestamp: number; // epoch seconds (UTC), matches Candle.time
  symbol: string;
  spot: number;
  atm: number | null;
  technicals: TechnicalSnapshot;
  regime: string | null; // classifyRegime()'s state label, or null if not computable yet
  optionChain: OptionChainAvailability;
}
