// Phase 2.3 coverage: a stop-out must arm a per-symbol cooldown independent of
// price movement, and tryOpenOption()'s gate (stopOutCooldownCheck) must block
// re-entry on that symbol until the window elapses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePosition, stopOutCooldownCheck, globalOneTradeLock, tryScaleIn, runExtPipeline, PaperState, PaperPosition, TickDeps, OptionIdea } from "./engine";
import { CONFIG } from "../config/arbitration";
import { ExtInputs } from "./ext";

function baseDeps(overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    marketOpen: true, istDate: "2026-09-12", minutesIST: 600, nowEpoch: 2000,
    getSpot: async () => null,
    getIndexOptionIdeas: async () => [],
    getStockOptionIdeas: async () => [],
    getStockIntradayIdeas: async () => [],
    ...overrides,
  };
}

function baseIdea(overrides: Partial<OptionIdea> = {}): OptionIdea {
  return {
    symbol: "NIFTY", name: "NIFTY", direction: "Bullish", optionType: "CE",
    strike: 20100, premium: 110, premiumTarget: 140, premiumStop: 90,
    spot: 20100, spotTarget: 20300, spotStop: 19950, lotSize: 50,
    expectedMovePct: 1, confidence: 70, thetaPctPerDay: 5, dte: 10,
    ...overrides,
  };
}

function emptyTestState(): PaperState {
  return {
    version: 2, active: true, days: 20, startEpoch: 0, startDate: "",
    tradingDaysElapsed: 0, lastDayCounted: "",
    lastEntry: { indexOption: 0, stockOption: 0, stockIntraday: 0 },
    tradesToday: 0, tradesTodayDate: "",
    indexOption: { startCapital: 100000, cash: 100000 },
    stockOption: { startCapital: 100000, cash: 100000 },
    stockIntraday: { startCapital: 100000, cash: 100000 },
    open: [], closed: [],
  };
}

function openPosition(overrides: Partial<PaperPosition>): PaperPosition {
  return {
    id: "p1", kind: "indexOption", symbol: "NIFTY", name: "NIFTY",
    qty: 50, entryPrice: 100, spotEntry: 20000, spotTarget: 20200, spotStop: 19900,
    entryEpoch: 1000, entryDay: 1,
    ...overrides,
  };
}

test("closePosition: a 'stop' exit arms the per-symbol cooldown", () => {
  const s = emptyTestState();
  const pos = openPosition({});
  s.open.push(pos);
  closePosition(s, pos, 95, "stop", 1000);
  assert.equal(s.stopOutCooldown?.["NIFTY"], 1000);
});

test("closePosition: a 'target' exit does NOT arm the cooldown", () => {
  const s = emptyTestState();
  const pos = openPosition({});
  s.open.push(pos);
  closePosition(s, pos, 120, "target", 1000);
  assert.equal(s.stopOutCooldown?.["NIFTY"], undefined);
});

test("stopOutCooldownCheck: blocks immediately after a stop-out", () => {
  const cooldownSec = CONFIG.cooldown.afterStopOutMinutes * 60;
  const stopAt = 1000;
  const result = stopOutCooldownCheck({ NIFTY: stopAt }, "NIFTY", stopAt + 1);
  assert.equal(result.blocked, true);
  assert.equal(result.remainMin, Math.ceil((cooldownSec - 1) / 60));
});

test("stopOutCooldownCheck: allows re-entry once the window has fully elapsed", () => {
  const cooldownSec = CONFIG.cooldown.afterStopOutMinutes * 60;
  const stopAt = 1000;
  const result = stopOutCooldownCheck({ NIFTY: stopAt }, "NIFTY", stopAt + cooldownSec);
  assert.equal(result.blocked, false);
  assert.equal(result.remainMin, 0);
});

test("stopOutCooldownCheck: is independent of price — only nowEpoch matters", () => {
  const cooldownSec = CONFIG.cooldown.afterStopOutMinutes * 60;
  const stopAt = 1000;
  // No price movement provided at all — the function takes no price input, so
  // any caller cannot bypass the cooldown by moving to a different strike/price.
  const result = stopOutCooldownCheck({ NIFTY: stopAt }, "NIFTY", stopAt + cooldownSec - 1);
  assert.equal(result.blocked, true);
});

test("stopOutCooldownCheck: does not affect other symbols", () => {
  const result = stopOutCooldownCheck({ NIFTY: 1000 }, "BANKNIFTY", 1001);
  assert.equal(result.blocked, false);
});

// Phase 2.4 (decided): global one-trade-at-a-time lock — only ONE position may
// be open across the WHOLE account at any moment, regardless of pool or symbol.
test("globalOneTradeLock: false when nothing is open", () => {
  const s = emptyTestState();
  assert.equal(globalOneTradeLock(s), false);
});

test("globalOneTradeLock: true as soon as ANY position is open, any pool", () => {
  const s = emptyTestState();
  s.open.push(openPosition({ kind: "stockIntraday", symbol: "RELIANCE" }));
  assert.equal(globalOneTradeLock(s), true);
});

test("globalOneTradeLock: stays true even for a different symbol/pool than the open position", () => {
  const s = emptyTestState();
  s.open.push(openPosition({ kind: "indexOption", symbol: "BANKNIFTY" }));
  // A NIFTY stockOption idea should still be locked out — the lock is global,
  // not scoped to (symbol, pool) like the old per-pool caps were.
  assert.equal(globalOneTradeLock(s), true);
});

test("globalOneTradeLock: false again once the only open position is closed", () => {
  const s = emptyTestState();
  const pos = openPosition({});
  s.open.push(pos);
  closePosition(s, pos, 105, "target", 1000);
  assert.equal(globalOneTradeLock(s), false);
});

// Phase 2.4 redefined (ScalingEngine conflict resolution): with a `symbol` arg,
// the lock only blocks a DIFFERENT symbol — a same-symbol idea is a scale-in
// candidate and must NOT be reported as locked, so it can reach tryOpenOption.
test("globalOneTradeLock(symbol): does NOT block a same-symbol idea (scale-in candidate)", () => {
  const s = emptyTestState();
  s.open.push(openPosition({ symbol: "NIFTY" }));
  assert.equal(globalOneTradeLock(s, "NIFTY"), false);
});

test("globalOneTradeLock(symbol): still blocks a different-symbol idea", () => {
  const s = emptyTestState();
  s.open.push(openPosition({ symbol: "NIFTY" }));
  assert.equal(globalOneTradeLock(s, "BANKNIFTY"), true);
});

// ScalingEngine (Phase 2, Decision 3): add-on entries to an already-open position.
function scalableOpenPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return openPosition({
    optionType: "CE", direction: "Bullish", confidence: 70,
    qty: 50, originalQty: 50, scaleIns: 0, entryPrice: 110,
    premiumTarget: 140, premiumStop: 90, ...overrides,
  });
}

test("tryScaleIn: rejects when price has not moved favourably since entry (never averages down)", async () => {
  const s = emptyTestState();
  const pos = scalableOpenPosition();
  s.open.push(pos);
  const idea = baseIdea({ spot: 19900, confidence: 85 }); // below spotEntry (20000) for a Bullish position
  const reason = await tryScaleIn(s, baseDeps(), idea, "indexOption", pos);
  assert.match(reason, /favourable/);
  assert.equal(pos.qty, 50); // unchanged
});

test("tryScaleIn: rejects when confirmation is not improved over the original entry", async () => {
  const s = emptyTestState();
  const pos = scalableOpenPosition({ confidence: 80 });
  s.open.push(pos);
  const idea = baseIdea({ spot: 20500, confidence: 75 }); // favourable move, but weaker confidence than original
  const reason = await tryScaleIn(s, baseDeps(), idea, "indexOption", pos);
  assert.match(reason, /confirmation/);
  assert.equal(pos.qty, 50);
});

test("tryScaleIn: accepts a favourable move with improved confirmation and recomputes the weighted-average entry", async () => {
  const s = emptyTestState();
  const pos = scalableOpenPosition({ confidence: 70, entryPrice: 100, qty: 50, originalQty: 50 });
  s.open.push(pos);
  const idea = baseIdea({ spot: 20500, confidence: 85, premium: 150, lotSize: 50 });
  const reason = await tryScaleIn(s, baseDeps(), idea, "indexOption", pos);
  assert.equal(reason, "OPENED");
  assert.equal(pos.qty, 100); // 50 original + 50 add-on
  // weighted avg: (100*50 + 150*50) / 100 = 125
  assert.equal(pos.entryPrice, 125);
  assert.equal(pos.scaleIns, 1);
});

test("tryScaleIn: a second add-on is rejected by its own max-entry cap", async () => {
  const s = emptyTestState();
  const pos = scalableOpenPosition({ scaleIns: 1, qty: 100, originalQty: 50 }); // already scaled in once
  s.open.push(pos);
  const idea = baseIdea({ spot: 20800, confidence: 95 });
  const reason = await tryScaleIn(s, baseDeps(), idea, "indexOption", pos);
  assert.match(reason, /cap पूरा/);
  assert.equal(pos.qty, 100);
});

test("tryScaleIn: rejected by its own exposure cap even with room under the heat cap", async () => {
  const s = emptyTestState();
  // originalQty 50, SCALE_EXPOSURE_MULT 2.0 -> maxQty 100; already at 90 -> only
  // 10 qty of room left, less than a full 50-share lot, so the add-on is rejected.
  const pos = scalableOpenPosition({ scaleIns: 0, qty: 90, originalQty: 50 });
  s.open.push(pos);
  const idea = baseIdea({ spot: 20800, confidence: 95, lotSize: 50 });
  const reason = await tryScaleIn(s, baseDeps(), idea, "indexOption", pos);
  assert.match(reason, /exposure cap/);
  assert.equal(pos.qty, 90);
});

test("tryScaleIn: rejects a mismatched direction/optionType (not the same trade thesis)", async () => {
  const s = emptyTestState();
  const pos = scalableOpenPosition({ direction: "Bullish", optionType: "CE" });
  s.open.push(pos);
  const idea = baseIdea({ direction: "Bearish", optionType: "PE", spot: 19500, confidence: 90 });
  const reason = await tryScaleIn(s, baseDeps(), idea, "indexOption", pos);
  assert.match(reason, /मेल नहीं खाता/);
  assert.equal(pos.qty, 50);
});

// Phase 3.3 coverage: stale technical-indicator data must veto the ext pipeline,
// parity with the OI path's >90s chain-age check — verified as an early-return
// branch (no scoring computed), so a minimal ExtInputs fixture is enough.
function baseExtInputs(overrides: Partial<ExtInputs> = {}): ExtInputs {
  return {
    candles5m: [], candles15m: [], daily: [], oi: null,
    dataAgeSec: 10, dataStale: false,
    burstState: "None" as any, squeezeOn: false,
    pdh: null, pdl: null, pdc: null, dayOpen: null, atrDaily: null, dayHigh: null, dayLow: null,
    wallSupport: null, wallResistance: null,
    spot: 20000, direction: "Bullish", optionType: "CE", strike: 20100, premium: 110, premiumSeries: [],
    atWall: false, wallRef: null, touchCount: 0,
    minutesIST: 600, withinFirst30: false,
    ...overrides,
  };
}

test("runExtPipeline: vetoes when the underlying data feed is stale (>90s)", () => {
  const inp = baseExtInputs({ dataAgeSec: 150, dataStale: true });
  const idea = baseIdea();
  const decision = runExtPipeline(inp, idea, [], 2000);
  assert.equal(decision.vetoed, true);
  assert.match(decision.reason, /stale/);
});

test("runExtPipeline: does not veto on staleness when data is fresh", () => {
  const inp = baseExtInputs({ dataAgeSec: 10, dataStale: false });
  const idea = baseIdea();
  const decision = runExtPipeline(inp, idea, [], 2000);
  assert.notEqual(decision.reason, "data stale (10s > 90s)");
});
