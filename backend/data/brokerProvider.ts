import { MarketDataProvider } from "./provider";
import { Candle, Interval, Quote } from "../types";

/**
 * Placeholder for a real-time broker feed (Upstox / Zerodha Kite / Fyers).
 *
 * To make this live later:
 *  1. Add the broker SDK (e.g. `upstox-js-sdk` or `kiteconnect`).
 *  2. Complete OAuth: exchange your API key/secret + login for an access token.
 *  3. Implement getCandles() via the broker's historical-candle REST endpoint.
 *  4. Implement getQuote() via the broker's LTP/quote endpoint, and optionally
 *     stream ticks over the broker WebSocket into an in-memory candle builder.
 *
 * Everything else in the app (indicators, signals, backtest, UI) already works
 * against the MarketDataProvider interface, so only this file needs to change.
 */
export class BrokerProvider implements MarketDataProvider {
  readonly name = "broker";

  constructor(private accessToken?: string) {}

  private notConfigured(): never {
    throw new Error(
      "BrokerProvider is reserved for future ORDER EXECUTION only and is NOT a " +
        "market-data source. Groww is the sole market-data provider. Do not wire " +
        "this into getProvider()."
    );
  }

  async getCandles(_symbol: string, _interval: Interval, _days: number): Promise<Candle[]> {
    this.notConfigured();
  }

  async getQuote(_symbol: string): Promise<Quote> {
    this.notConfigured();
  }
}
