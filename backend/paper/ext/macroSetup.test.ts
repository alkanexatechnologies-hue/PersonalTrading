import test from "node:test";
import assert from "node:assert/strict";
import {
  voteFromPct, combineTwoVotes, classifyGlobalMarketBias, computeBasketPct,
  rankSectors, pctChangeSinceOpen, computeNiftyMacroSetup, NIFTY_IT_MAJORS,
} from "./macroSetup";
import { Candle } from "../../types";

// ---- voteFromPct ----
test("voteFromPct: positive/negative/zero/null/NaN all classify correctly", () => {
  assert.equal(voteFromPct(1.5), 1);
  assert.equal(voteFromPct(-0.01), -1);
  assert.equal(voteFromPct(0), 0);
  assert.equal(voteFromPct(null), 0);
  assert.equal(voteFromPct(undefined), 0);
  assert.equal(voteFromPct(NaN), 0);
});

// ---- combineTwoVotes ----
test("combineTwoVotes: agreement passes through, disagreement cancels, one-sided wins", () => {
  assert.equal(combineTwoVotes(1, 1), 1);
  assert.equal(combineTwoVotes(-1, -1), -1);
  assert.equal(combineTwoVotes(1, -1), 0);
  assert.equal(combineTwoVotes(1, 0), 1);
  assert.equal(combineTwoVotes(0, -1), -1);
  assert.equal(combineTwoVotes(0, 0), 0);
});

// ---- classifyGlobalMarketBias ----
test("classifyGlobalMarketBias: US+Asia agreeing today, matching yesterday -> consistent bullish", () => {
  const r = classifyGlobalMarketBias({ usTodayPct: 0.8, asiaTodayPct: 0.3, usYesterdayPct: 0.5, asiaYesterdayPct: 0.2 });
  assert.equal(r.todayBias, 1);
  assert.equal(r.yesterdayBias, 1);
  assert.equal(r.consistent, true);
});

test("classifyGlobalMarketBias: today reverses yesterday -> not consistent", () => {
  const r = classifyGlobalMarketBias({ usTodayPct: -0.6, asiaTodayPct: -0.2, usYesterdayPct: 0.5, asiaYesterdayPct: 0.4 });
  assert.equal(r.todayBias, -1);
  assert.equal(r.yesterdayBias, 1);
  assert.equal(r.consistent, false);
});

test("classifyGlobalMarketBias: US vs Asia disagree today -> Neutral, never invents a side", () => {
  const r = classifyGlobalMarketBias({ usTodayPct: 0.5, asiaTodayPct: -0.5, usYesterdayPct: null, asiaYesterdayPct: null });
  assert.equal(r.todayBias, 0);
  assert.equal(r.yesterdayBias, 0);
  assert.equal(r.consistent, false);
});

test("classifyGlobalMarketBias: missing data on one side falls back to the other, doesn't null out", () => {
  const r = classifyGlobalMarketBias({ usTodayPct: 0.7, asiaTodayPct: null, usYesterdayPct: null, asiaYesterdayPct: null });
  assert.equal(r.todayBias, 1);
});

// ---- computeBasketPct ----
test("computeBasketPct: averages available symbols, skips missing ones (not 0)", () => {
  const pctBySymbol = { "INFY.NS": 1.0, "TCS.NS": 2.0 }; // HCLTECH.NS missing
  const v = computeBasketPct(pctBySymbol, NIFTY_IT_MAJORS);
  assert.equal(v, 1.5); // average of just the 2 available, not (1+2+0)/3
});

test("computeBasketPct: no data at all -> null, not 0", () => {
  assert.equal(computeBasketPct({}, NIFTY_IT_MAJORS), null);
});

// ---- rankSectors ----
test("rankSectors: sorts descending by average move", () => {
  const baskets = { IT: ["A", "B"], Auto: ["C", "D"] };
  const pct = { A: 1, B: 3, C: -2, D: -4 }; // IT avg=2, Auto avg=-3
  const ranked = rankSectors(pct, baskets);
  assert.equal(ranked[0].sector, "IT");
  assert.equal(ranked[0].avgPct, 2);
  assert.equal(ranked[1].sector, "Auto");
  assert.equal(ranked[1].symbolsUsed, 2);
});

test("rankSectors: a sector with zero available readings is excluded, not scored as 0", () => {
  const baskets = { IT: ["A", "B"], Metals: ["X", "Y"] };
  const pct = { A: 1, B: 1 }; // Metals has no data at all
  const ranked = rankSectors(pct, baskets);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sector, "IT");
});

// ---- pctChangeSinceOpen ----
function mkCandle(time: number, open: number, close: number): Candle {
  return { time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000 } as Candle;
}
// IST midnight epoch for 2026-09-12 = Date.UTC(2026,8,11,18,30,0)/1000 (IST = UTC+5:30)
const IST_MIDNIGHT_SEC = Date.UTC(2026, 8, 11, 18, 30, 0) / 1000;
const mins = (m: number) => IST_MIDNIGHT_SEC + m * 60;

test("pctChangeSinceOpen: computes % move from today's first bar's open to the latest close", () => {
  const candles = [
    mkCandle(mins(9 * 60 + 15), 100, 101), // day open = 100
    mkCandle(mins(9 * 60 + 16), 101, 102),
    mkCandle(mins(9 * 60 + 17), 102, 105), // latest close = 105
  ];
  const pct = pctChangeSinceOpen(candles);
  assert.ok(pct != null && Math.abs(pct - 5) < 1e-9);
});

test("pctChangeSinceOpen: only counts today's session, ignores a prior day's bars in the same array", () => {
  const priorDayMidnight = IST_MIDNIGHT_SEC - 24 * 60 * 60;
  const candles = [
    mkCandle(priorDayMidnight + 9 * 60 * 60, 50, 60), // prior day, should be ignored
    mkCandle(mins(9 * 60 + 15), 100, 100), // today's open = 100
    mkCandle(mins(9 * 60 + 20), 100, 110),
  ];
  const pct = pctChangeSinceOpen(candles);
  assert.ok(pct != null && Math.abs(pct - 10) < 1e-9);
});

test("pctChangeSinceOpen: empty input -> null", () => {
  assert.equal(pctChangeSinceOpen([]), null);
});

// ---- computeNiftyMacroSetup ----
test("computeNiftyMacroSetup: all four votes bullish -> bias Bullish, agree=4", () => {
  const global = classifyGlobalMarketBias({ usTodayPct: 0.5, asiaTodayPct: 0.4, usYesterdayPct: 0.5, asiaYesterdayPct: 0.4 });
  const sectorLeaderboard = rankSectors({ A: 2, B: 3 }, { IT: ["A", "B"] });
  const r = computeNiftyMacroSetup({
    global, sectorLeaderboard, bankNiftyPctSinceOpen: 0.3, itMajorsPctSinceOpen: 0.2,
  });
  assert.equal(r.bias, 1);
  assert.equal(r.agree, 4);
  assert.equal(r.against, 0);
  assert.equal(r.topSector, "IT");
});

test("computeNiftyMacroSetup: mixed votes with no majority -> Neutral bias, never forces a side", () => {
  const global = classifyGlobalMarketBias({ usTodayPct: 0.5, asiaTodayPct: 0.4, usYesterdayPct: null, asiaYesterdayPct: null }); // bullish
  const sectorLeaderboard = rankSectors({ A: -2, B: -3 }, { IT: ["A", "B"] }); // bearish
  const r = computeNiftyMacroSetup({
    global, sectorLeaderboard, bankNiftyPctSinceOpen: 0.1, itMajorsPctSinceOpen: -0.1, // 1 bullish, 1 bearish
  });
  assert.equal(r.agree, 2);
  assert.equal(r.against, 2);
  assert.equal(r.bias, 0);
});

test("computeNiftyMacroSetup: no sector data at all -> topSector null, that vote is Neutral, others still count", () => {
  const global = classifyGlobalMarketBias({ usTodayPct: 0.5, asiaTodayPct: 0.5, usYesterdayPct: null, asiaYesterdayPct: null });
  const r = computeNiftyMacroSetup({
    global, sectorLeaderboard: [], bankNiftyPctSinceOpen: 0.3, itMajorsPctSinceOpen: 0.2,
  });
  assert.equal(r.topSector, null);
  assert.equal(r.votes.find((v) => v.name.startsWith("Morning sector leader"))?.dir, 0);
  assert.equal(r.bias, 1); // global + bankNifty + IT still agree bullish
});
