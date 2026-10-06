import { Candle, Interval, Quote } from "../types";

// Abstraction so the trading engine never hard-codes a vendor. It currently
// resolves EXCLUSIVELY to Groww (the single market-data source).
export interface MarketDataProvider {
  readonly name: string;
  getCandles(symbol: string, interval: Interval, days: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<Quote>;
  // Optional batched quotes: fetch many symbols in as few provider calls as
  // possible (one multi-instrument request where the vendor supports it). Falls
  // back to per-symbol getQuote when a provider doesn't implement it.
  getQuotes?(symbols: string[]): Promise<Record<string, Quote | null>>;
}
