import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TwelveDataProvider, fetchMarketData, getMarketDataHealth,
  _setFetchForTests, _resetMarketDataForTests, marketDataConfigured,
} from "./marketDataProvider";

const KEY = "SECRETKEY_9f8a7b6c5d";
function withKey() { process.env.MARKET_DATA_PROVIDER = "twelvedata"; process.env.MARKET_DATA_API_KEY = KEY; }
function noKey() { process.env.MARKET_DATA_PROVIDER = "twelvedata"; delete process.env.MARKET_DATA_API_KEY; }

// A stub Twelve Data response for the GOLD symbol (XAU/USD), single-symbol shape.
const goldRow = (over: any = {}) => ({
  symbol: "XAU/USD", close: "2412.5", change: "13.2", percent_change: "0.55",
  timestamp: Math.floor(Date.now() / 1000) - 20, is_market_open: true, ...over,
});
const okFetch = (row: any, calls?: { n: number }) => async (_url: string) => { if (calls) calls.n++; return { ok: true, status: 200, json: async () => row }; };

function reset() { _resetMarketDataForTests(); }

test("1. API key missing → UNAVAILABLE with reason, value null", async () => {
  noKey(); reset();
  const out = await fetchMarketData(["GOLD"]);
  assert.equal(out.GOLD.value, null);
  assert.equal(out.GOLD.freshness, "UNAVAILABLE");
  assert.match(out.GOLD.reason || "", /not configured/i);
});

test("2. configured + success → LIVE with real value", async () => {
  withKey(); reset(); _setFetchForTests(okFetch(goldRow()));
  const p = new TwelveDataProvider();
  const out = await p.getQuote(["GOLD"]);
  assert.equal(out.GOLD.value, 2412.5);
  assert.equal(out.GOLD.freshness, "LIVE");
  assert.equal(out.GOLD.source, "twelvedata");
});

test("3. provider timeout/throw → DISCONNECTED (no last good)", async () => {
  withKey(); reset(); _setFetchForTests(async () => { throw new Error("aborted"); });
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.value, null);
  assert.equal(out.GOLD.freshness, "DISCONNECTED");
});

test("4. provider HTTP 500 → DISCONNECTED", async () => {
  withKey(); reset(); _setFetchForTests(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "DISCONNECTED");
});

test("5. HTTP 429 → DISCONNECTED + rate-limit noted in health", async () => {
  withKey(); reset(); _setFetchForTests(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "DISCONNECTED");
  const h = await getMarketDataHealth();
  assert.match((h.lastError || "").toLowerCase(), /429|rate/);
});

test("6. malformed response → UNAVAILABLE", async () => {
  withKey(); reset(); _setFetchForTests(okFetch({ nonsense: true }));
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.value, null);
  assert.equal(out.GOLD.freshness, "UNAVAILABLE");
});

test("7. stale provider timestamp → STALE", async () => {
  withKey(); reset(); _setFetchForTests(okFetch(goldRow({ timestamp: Math.floor(Date.now() / 1000) - 3600 })));
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "STALE");
  assert.equal(out.GOLD.value, 2412.5); // value still real
});

test("8. unsupported symbol (GIFT NIFTY) → UNAVAILABLE, not substituted", async () => {
  withKey(); reset(); _setFetchForTests(okFetch(goldRow()));
  const out = await new TwelveDataProvider().getQuote(["GIFTNIFTY"]);
  assert.equal(out.GIFTNIFTY.value, null);
  assert.equal(out.GIFTNIFTY.freshness, "UNAVAILABLE");
  assert.match(out.GIFTNIFTY.reason || "", /not supported/i);
});

test("9. provider recovery → LIVE again after an error", async () => {
  withKey(); reset();
  _setFetchForTests(async () => { throw new Error("down"); });
  let out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "DISCONNECTED");
  _setFetchForTests(okFetch(goldRow()));
  out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "LIVE");
});

test("10. last-good preserved as STALE on a later error", async () => {
  withKey(); reset();
  _setFetchForTests(okFetch(goldRow()));
  let out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "LIVE");
  _setFetchForTests(async () => { throw new Error("down"); });
  out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.freshness, "STALE");
  assert.equal(out.GOLD.value, 2412.5); // preserved last good
});

test("11. API key never exposed via health", async () => {
  withKey(); reset(); _setFetchForTests(okFetch(goldRow()));
  const h = await getMarketDataHealth();
  assert.equal(JSON.stringify(h).includes(KEY), false);
});

test("12. API key never appears in reason/error", async () => {
  withKey(); reset(); _setFetchForTests(async () => { throw new Error(`bad apikey=${KEY} rejected`); });
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal((out.GOLD.reason || "").includes(KEY), false);
  const h = await getMarketDataHealth();
  assert.equal((h.lastError || "").includes(KEY), false);
});

test("13. cached response: 2nd call within TTL does not re-fetch", async () => {
  withKey(); reset(); const calls = { n: 0 }; _setFetchForTests(okFetch(goldRow(), calls));
  await fetchMarketData(["GOLD"]);
  const after1 = calls.n;
  await fetchMarketData(["GOLD"]);
  assert.equal(calls.n, after1); // served from cache, no extra provider call
});

test("14. duplicate concurrent requests deduped into one fetch", async () => {
  withKey(); reset(); const calls = { n: 0 };
  _setFetchForTests(async (_url: string) => { calls.n++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200, json: async () => ({ "XAU/USD": goldRow() }) }; });
  await Promise.all([fetchMarketData(["GOLD"]), fetchMarketData(["GOLD"]), fetchMarketData(["GOLD"])]);
  assert.equal(calls.n, 1);
});

test("15. provider timestamp is preserved (not Date.now)", async () => {
  withKey(); reset();
  const providerTs = Math.floor(Date.now() / 1000) - 45;
  _setFetchForTests(okFetch(goldRow({ timestamp: providerTs })));
  const out = await new TwelveDataProvider().getQuote(["GOLD"]);
  assert.equal(out.GOLD.ts, providerTs);
  assert.notEqual(out.GOLD.ts, out.GOLD.receivedTs); // received differs from provider ts
});

test("cleanup env", () => { noKey(); _setFetchForTests(null); assert.equal(marketDataConfigured(), false); });
