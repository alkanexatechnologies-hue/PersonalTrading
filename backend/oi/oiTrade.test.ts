import test from "node:test";
import assert from "node:assert/strict";
import { recommendOiTrades, OiTradeInput, OI_DIR_MIN } from "./oiTrade";

// recommendOiTrades gates whether a live OI-based trade idea is shown/auto-
// traded. A misclassification here (e.g. treating FLAT as directional, or
// missing the wall-room check) would silently generate a wrong-direction or
// too-late trade call - previously untested.

function baseInput(overrides: Partial<OiTradeInput> = {}): OiTradeInput {
  return {
    hasBaseline: true,
    stale: false,
    dataAgeSec: 10,
    oiDirection: "UP",
    oiConfidence: 75,
    oiReasons: ["PE writing > CE writing"],
    status: "OK",
    spot: 25000,
    atmStrike: 25000,
    optionType: "CE",
    ltp: 100,
    strikeOiPct: 5,
    pricePct: 2,
    oiHelpful: true,
    pxHelpful: true,
    invalidation: null,
    support: 24800,
    resistance: 25300, // far enough away that roomOk passes
    expLow: 60,
    expHigh: 200, // 0.8% of spot = BASELINE_EXP_MOVE_PCT, so volMult is exactly 1
    last5mDir: 1,
    ...overrides,
  };
}

test("recommendOiTrades: FLAT direction takes neither leg, with an explicit reason", () => {
  const out = recommendOiTrades(baseInput({ oiDirection: "FLAT" }));
  assert.equal(out.directional.take, false);
  assert.equal(out.scalp.take, false);
  assert.ok(out.directional.skipReasons.includes("OI FLAT — WAIT"));
});

test("recommendOiTrades: a clean UP setup is taken directionally with +20% target / -12% stop off ltp on a normal-volatility day", () => {
  const out = recommendOiTrades(baseInput()); // expHigh=200=0.8% of spot -> volMult exactly 1
  assert.equal(out.directional.take, true);
  assert.equal(out.directional.action, "BUY ATM CE (directional)");
  assert.equal(out.directional.target, 120); // 100 * (1 + 0.20*1)
  assert.equal(out.directional.stop, 88); // 100 * (1 - 0.12*1)
});

test("recommendOiTrades: a quiet day (low expHigh) tightens the target/stop instead of using the flat +20%/-12%", () => {
  // expHigh=100 -> expMovePct=0.4% of spot -> half the baseline -> volMult clamps to 0.7
  const out = recommendOiTrades(baseInput({ expHigh: 100 }));
  assert.equal(out.directional.target, 114); // 100 * (1 + 0.20*0.7)
  assert.equal(out.directional.stop, 91.6); // 100 * (1 - 0.12*0.7)
});

test("recommendOiTrades: a volatile day (high expHigh) widens the target/stop instead of using the flat +20%/-12%", () => {
  // expHigh=500 -> expMovePct=2% of spot -> 2.5x baseline -> volMult clamps to 1.6
  const out = recommendOiTrades(baseInput({ expHigh: 500 }));
  assert.equal(out.directional.target, 132); // 100 * (1 + 0.20*1.6)
  assert.equal(out.directional.stop, 80.8); // 100 * (1 - 0.12*1.6)
});

test("recommendOiTrades: DOWN direction recommends a PE, not a CE", () => {
  const out = recommendOiTrades(baseInput({ oiDirection: "DOWN", optionType: "PE" }));
  assert.equal(out.directional.action, "BUY ATM PE (directional)");
});

test("recommendOiTrades: confidence below the directional floor is skipped with the threshold reason", () => {
  const out = recommendOiTrades(baseInput({ oiConfidence: OI_DIR_MIN - 1 }));
  assert.equal(out.directional.take, false);
  assert.ok(out.directional.skipReasons.some((r) => r.includes(`< ${OI_DIR_MIN}`)));
});

test("recommendOiTrades: a resistance wall too close to spot blocks the UP directional trade", () => {
  // expLow=60 means the required room is at least 60 (or 0.1% of spot); put
  // resistance only 10 points above spot, well inside that.
  const out = recommendOiTrades(baseInput({ resistance: 25010 }));
  assert.equal(out.directional.take, false);
  assert.ok(out.directional.skipReasons.some((r) => r.includes("OI wall")));
});

test("recommendOiTrades: no same-day baseline yet blocks both legs regardless of confidence", () => {
  const out = recommendOiTrades(baseInput({ hasBaseline: false }));
  assert.equal(out.directional.take, false);
  assert.equal(out.scalp.take, false);
  assert.ok(out.directional.skipReasons.includes("no same-day OI baseline yet"));
});

test("recommendOiTrades: a stale chain blocks both legs", () => {
  const out = recommendOiTrades(baseInput({ stale: true, dataAgeSec: 200 }));
  assert.ok(out.directional.skipReasons.some((r) => r.startsWith("chain stale")));
  assert.equal(out.directional.take, false);
});

test("recommendOiTrades: scalp leg is skipped when the last 5m bar ran against the OI direction", () => {
  const out = recommendOiTrades(baseInput({ last5mDir: -1 })); // OI says UP, last bar went down
  assert.ok(out.scalp.skipReasons.includes("last 5m bar against OI direction"));
  assert.equal(out.scalp.take, false);
});
