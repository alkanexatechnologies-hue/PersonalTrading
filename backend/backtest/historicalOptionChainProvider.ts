import { OptionChainAvailability } from "./marketSnapshot";

// ============================ HistoricalOptionChainProvider ============================
// The plug point for a FUTURE real historical full-option-chain data source.
// Implement this interface against that provider when one exists, and swap
// `historicalOptionChainProvider` below — nothing else in the pipeline (OI
// analysis, candidate generation, Master Trade Selector, scoring, risk
// management, the trade simulator, or the UI) needs to change, because they
// all consume MarketSnapshot.optionChain, not this interface directly.

export interface HistoricalOptionChainProvider {
  readonly name: string;
  // Returns the full option chain for `symbol`/`expiry` as it stood AT
  // `timestamp` (epoch seconds) — never today's chain, never a future one.
  // Returns the literal string "NOT_AVAILABLE" when the provider has no data
  // for that exact historical moment (the honest answer, not an approximation).
  getSnapshot(timestamp: number, symbol: string, expiry: string): Promise<OptionChainAvailability>;
}

// No historical full-option-chain provider exists yet, from any vendor this
// app has evaluated (Groww: live chain only, no historical replay; Dhan:
// per-contract OHLC+OI only, no whole-chain historical snapshot — both
// verified directly against their real APIs, not assumed). This stub is the
// explicit, honest placeholder required by that gap: it always returns
// NOT_AVAILABLE. It never synthesizes OI, never reuses today's chain for a
// historical timestamp, and never reuses a future chain for a past one.
export class UnavailableHistoricalOptionChainProvider implements HistoricalOptionChainProvider {
  readonly name = "none connected (no historical full-option-chain provider exists yet)";
  async getSnapshot(): Promise<OptionChainAvailability> {
    return "NOT_AVAILABLE";
  }
}

// Single instance the rest of the backtest pipeline depends on. Replace this
// assignment (only) when a real provider is implemented.
export const historicalOptionChainProvider: HistoricalOptionChainProvider = new UnavailableHistoricalOptionChainProvider();
