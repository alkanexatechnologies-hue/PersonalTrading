import { Candle, Interval, Quote } from "../types";

// Abstraction so the trading engine never hard-codes a vendor. It currently
// resolves EXCLUSIVELY to Groww (the single market-data source).
export interface MarketDataProvider {
  readonly name: string;
  getCandles(symbol: string, interval: Interval, days: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<Quote>;
}
