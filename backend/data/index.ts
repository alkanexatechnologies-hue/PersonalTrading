import { MarketDataProvider } from "./provider";
import { DhanProvider } from "./dhanProvider";

// DHAN IS THE ONLY MARKET-DATA PROVIDER.
// The MarketDataProvider abstraction is preserved (so the trading engine never
// hard-codes a vendor), but it resolves EXCLUSIVELY to Dhan. There is no Groww,
// Yahoo or TrueData provider. BrokerProvider exists only for future ORDER
// EXECUTION and must never be used as a market-data source.

let provider: MarketDataProvider | null = null;

export function getProvider(): MarketDataProvider {
  if (provider) return provider;
  provider = new DhanProvider();
  return provider;
}

export function setActiveProvider(_name: "dhan"): MarketDataProvider {
  provider = new DhanProvider();
  return provider;
}

export { MarketDataProvider };
