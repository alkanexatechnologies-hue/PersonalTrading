import { test } from "node:test";
import assert from "node:assert/strict";
import { Candle, OiAnalysis, OiStrike } from "../types";
import { arbitrate, ArbiterInput, OPTION_NET_RR_MIN } from "./arbiter";
import { evaluateEvidence, setupEligible } from "./evidence";
import { session, setBar, Leg } from "../signals/breakoutFixtures";

// Same ascending-triangle fixture as the Breakout Engine tests (S2 ENTRY_READY on the last bar).
const LEGS: Leg[] = [
  { to: 22090, bars: 6 }, { to: 22080, bars: 3 }, { to: 22100, bars: 5 }, { to: 22085, bars: 4 }, { to: 22100, bars: 4 },
  { to: 22090, bars: 3 }, { to: 22100, bars: 3 }, { to: 22094, bars: 3 }, { to: 22098, bars: 2 }, { to: 22098, bars: 1 },
];
const breakout = (): Candle[] => { const cs = session(22060, 42, 22070, LEGS); setBar(cs, cs.length - 1, 22098, 22105, 22097.5, 22104.5); return cs; };

function chain(spot: number, step = 50): OiAnalysis {
  const atm = Math.round(spot / step) * step, strikes: OiStrike[] = [];
  for (let k = -6; k <= 6; k++) {
    const K = atm + k * step, m = (spot - K) / step, ceD = Math.min(0.95, Math.max(0.05, 0.5 + m * 0.12));
    strikes.push({ strike: K, ceOi: 100000 - Math.abs(k) * 6000, peOi: 100000 - Math.abs(k) * 6000, ceChg: 1000, peChg: 1000,
      ceLtp: +(Math.max(0, spot - K) + step * 1.2 * ceD).toFixed(2), peLtp: +(Math.max(0, K - spot) + step * 1.2 * (1 - ceD)).toFixed(2),
      ceVol: 50000, peVol: 50000, ceDelta: +ceD.toFixed(2), peDelta: -(1 - ceD) });
  }
  return { symbol: "X", nseSymbol: "X", available: true, underlying: spot, expiry: "2026-10-13", topStrikes: strikes } as unknown as OiAnalysis;
}
const verified = async () => ({ securityId: "1", exchangeSegment: "NSE_FNO", instrument: "OPTIDX" });
function input(cs: Candle[], over: Partial<ArbiterInput> = {}): ArbiterInput {
  const lastT = cs[cs.length - 1].time;
  return { index: "FINNIFTY", symbol: "^CNXFIN", name: "FIN NIFTY", nseSymbol: "FINNIFTY", lotSize: 60, candles: cs,
    nowSec: lastT + 300 + 5, marketOpen: true, dataStatus: "LIVE", dailyAtr: 120, oiChain: chain(22104.5), chainStale: false,
    lookupOption: verified, ...over };
}

test("exactly one decision object, keyed by the CLOSED candle", async () => {
  const cs = breakout();
  const d = await arbitrate(input(cs));
  assert.equal(d.key, `FINNIFTY|5m|${cs[cs.length - 1].time}`);
  assert.equal(d.candleClosed, true);
  assert.ok(["BUY_CE", "BUY_PE", "WAIT", "HOLD", "AVOID"].includes(d.finalAction));
});

test("closed-candle safety: a breakout that exists only in the FORMING candle never becomes BUY", async () => {
  const cs = breakout();
  const lastT = cs[cs.length - 1].time;
  const d = await arbitrate(input(cs, { nowSec: lastT + 120 }));   // last bar still forming
  assert.notEqual(d.candleTime, lastT);
  assert.ok(d.finalAction === "WAIT" || d.finalAction === "AVOID", d.finalAction);
});

test("invariant: any BUY satisfies option quality AND the evidence gate", async () => {
  const d = await arbitrate(input(breakout()));
  if (d.finalAction === "BUY_CE" || d.finalAction === "BUY_PE") {
    assert.ok(d.option && d.option.available && d.option.verified);
    assert.ok(d.option!.netRR! >= OPTION_NET_RR_MIN);
    assert.ok(d.evidence && d.evidence.passes && (d.evidence.netEvR ?? 0) > 0);
  } else {
    assert.ok(d.rejection, "a non-BUY always carries a rejection reason");
  }
});

test("spot setup ready but NO option chain → WAIT (option is not a good vehicle)", async () => {
  const d = await arbitrate(input(breakout(), { oiChain: null }));
  if (d.candidates.some((c) => c.state === "ENTRY_READY" && c.production)) {
    assert.equal(d.finalAction, "WAIT");
    assert.equal(d.rejection, "OPTION");
  }
});

test("unverified contract (not in instrument master) → never BUY", async () => {
  const d = await arbitrate(input(breakout(), { lookupOption: async () => null }));
  assert.ok(d.finalAction !== "BUY_CE" && d.finalAction !== "BUY_PE");
});

test("index with no measured evidence (MIDCPNIFTY) → WAIT even when a setup is ready", async () => {
  const d = await arbitrate(input(breakout(), { index: "MIDCPNIFTY", symbol: "^NSEMDCP50", nseSymbol: "MIDCPNIFTY" }));
  assert.ok(d.finalAction === "WAIT", d.finalAction);
  assert.equal(setupEligible("S1_MOMENTUM", "MIDCPNIFTY"), false);
});

test("stale live data → AVOID", async () => {
  const d = await arbitrate(input(breakout(), { dataStatus: "STALE" }));
  assert.equal(d.finalAction, "AVOID");
});

test("market closed → WAIT, never BUY", async () => {
  const d = await arbitrate(input(breakout(), { marketOpen: false }));
  assert.equal(d.finalAction, "WAIT");
});

test("an open arbiter trade → HOLD with its plan, no new entry", async () => {
  const plan = { entry: 22104.5, stopLoss: 22096, target1: 22132, target2: null, risk: 8.5, reward: 27.5, rr: 3.2, slReason: "x", targetReason: "y" };
  const d = await arbitrate(input(breakout(), { hold: { since: 1, entrySpot: 22104.5, barsHeld: 2, option: null, plan, setup: "S2_BREAKOUT", direction: "BULLISH", triggerLevel: 22101 } }));
  assert.equal(d.finalAction, "HOLD");
  assert.equal(d.plan!.stopLoss, 22096);
});

test("evidence gate: unproven / not-positive-in-both-periods setups never pass", () => {
  assert.equal(evaluateEvidence("S1_MOMENTUM", "BANKNIFTY", 0).passes, false);   // −0.193R Aug–Oct
  assert.equal(evaluateEvidence("S2_BREAKOUT", "SENSEX", 0).passes, false);      // negative both periods
  assert.equal(evaluateEvidence("S1_MOMENTUM", "MIDCPNIFTY", 0).passes, false);  // no evidence
  const n = evaluateEvidence("S1_MOMENTUM", "NIFTY", 0.05);
  assert.equal(n.passes, true);
  assert.ok(n.shrunkR! < n.avgR!, "shrunk toward zero");
  assert.equal(evaluateEvidence("S1_MOMENTUM", "NIFTY", 1).passes, false, "costs larger than the edge fail");
});

// ---------------- trading-day end (15:15) and expiry choice ----------------
const at1515 = (cs: Candle[]) => { const d = new Date((cs[cs.length - 1].time + 19800) * 1000).toISOString().slice(0, 10); return Math.floor(Date.parse(d + "T09:45:00Z") / 1000); }; // 15:15 IST

test("after 15:15 IST no new trade (DAY END)", async () => {
  const cs = breakout();
  const d = await arbitrate(input(cs, { nowSec: at1515(cs) + 60 }));
  assert.equal(d.finalAction, "WAIT");
  assert.equal(d.rejection, "DAY END");
});

test("index movement in candles starting at/after 15:15 is ignored", async () => {
  const cs = breakout();
  const t1515 = at1515(cs);
  const late = [...cs, { time: t1515, open: 22104, high: 22300, low: 22000, close: 22290, volume: 5000 }, { time: t1515 + 300, open: 22290, high: 22310, low: 22280, close: 22300, volume: 5000 }];
  const d = await arbitrate(input(late, { nowSec: t1515 + 900, marketOpen: false }));
  assert.ok(d.candleTime! < t1515, "decision candle is before 15:15");
  assert.ok(d.spot! < 22200, "the 15:15+ move is not in the decision");
});

test("expiry: an option expiring within 1 day is never used — next expiry or WAIT", async () => {
  const cs = breakout();
  const today = new Date((cs[cs.length - 1].time + 19800) * 1000).toISOString().slice(0, 10);
  const near = { ...chain(22104.5), expiry: today } as OiAnalysis;
  const noNext = await arbitrate(input(cs, { oiChain: near }));
  if (noNext.option) assert.ok(noNext.finalAction !== "BUY_CE" && noNext.finalAction !== "BUY_PE", "no BUY on a 0-DTE option without a next-expiry chain");
  const next = { ...chain(22104.5), expiry: "2026-10-13" } as OiAnalysis;
  const withNext = await arbitrate(input(cs, { oiChain: near, getNextExpiryChain: async () => next }));
  if (withNext.option && withNext.option.expiry) assert.equal(withNext.option.expiry, "2026-10-13");
});
