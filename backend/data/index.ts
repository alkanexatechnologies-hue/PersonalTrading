import { MarketDataProvider } from "./provider";
import { GrowwProvider } from "./growwProvider";

// GROWW IS THE ONLY MARKET-DATA PROVIDER.
// The MarketDataProvider abstraction is preserved (so the trading engine never
// hard-codes a vendor), but it resolves EXCLUSIVELY to Groww. There is no Yahoo
// or TrueData provider. BrokerProvider exists only for future ORDER EXECUTION and
// must never be used as a market-data source, so it is not wired here.

let provider: MarketDataProvider | null = null;

export function getProvider(): MarketDataProvider {
  if (provider) return provider;
  provider = new GrowwProvider(process.env.GROWW_ACCESS_TOKEN);
  return provider;
}

// Kept for API compatibility with the connect flow. Only Groww is accepted as a
// market-data provider; any other name is ignored (Groww stays active).
export function setActiveProvider(_name: "groww", token?: string): MarketDataProvider {
  provider = new GrowwProvider(token || process.env.GROWW_ACCESS_TOKEN);
  return provider;
}

export { MarketDataProvider };
