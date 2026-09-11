import test from "node:test";
import assert from "node:assert/strict";
import { tradeFriction, optionMark, closePosition, PaperState, PaperPosition } from "./engine";

// The paper-trading P&L math drives every number this app reports to the
// user (realised P&L, cash balance, win rate). A sign or formula error here
// would silently corrupt data/paper-state.json with no crash to catch it -
// previously untested end to end.

function emptyTestState(): PaperState {
  return {
    version: 1, active: true, days: 20, startEpoch: 0, startDate: "2026-01-01",
    tradingDaysElapsed: 1, lastDayCounted: "2026-01-01",
    lastEntry: { indexOption: 0, stockOption: 0, stockIntraday: 0 },
    tradesToday: 0, tradesTodayDate: "2026-01-01",
    indexOption: { startCapital: 40000, cash: 40000 },
    stockOption: { startCapital: 40000, cash: 40000 },
    stockIntraday: { startCapital: 40000, cash: 40000 },
    open: [], closed: [],
  };
}

function testPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "t1", kind: "indexOption", symbol: "^NSEI", name: "NIFTY",
    direction: "Bullish", optionType: "CE", strike: 25000,
    qty: 75, entryPrice: 100, spotEntry: 25000, spotTarget: 25100, spotStop: 24950,
    premiumTarget: 150, premiumStop: 70, entryEpoch: 0, entryDay: 0,
    ...overrides,
  };
}

test("tradeFriction: option costs scale with brokerage + STT + exchange + slippage", () => {
  // Hand-computed for kind="indexOption", entryVal=7500 (100*75), exitVal=11250 (150*75):
  //   slippage = 0.004 * (7500+11250) = 75
  //   brokerage=40, stt=0.001*11250=11.25, exch=0.00035*18750=6.5625, stamp=0.00003*7500=0.225
  //   charges = 40+11.25+6.5625+0.225 + 0.18*(40+6.5625) = 58.0375 + 8.38125 = 66.41875
  //   total = round2(75 + 66.41875) = 141.42
  const costs = tradeFriction("indexOption", 7500, 11250);
  assert.equal(costs, 141.42);
});

test("tradeFriction: equity intraday has no brokerage, uses the equity slip/charge schedule", () => {
  const costs = tradeFriction("stockIntraday", 10000, 10500);
  // slippage = 0.0005 * 20500 = 10.25
  // stt = 0.001*20500=20.5, exch=0.0000297*20500=0.60885, stamp=0.00015*10000=1.5
  // charges = 0 + 20.5 + 0.60885 + 1.5 + 0.18*(0+0.60885) = 22.60885 + 0.1095930... ≈ 22.7184...
  // total ≈ round2(10.25 + 22.7184) = 32.97
  assert.equal(costs, 32.97);
});

test("closePosition: a winning long option trade credits cash and records a positive net P&L", () => {
  const s = emptyTestState();
  const pos = testPosition();
  s.open.push(pos);
  const startCash = s.indexOption.cash;

  closePosition(s, pos, 150, "target", 1000);

  assert.equal(s.open.length, 0);
  assert.equal(s.closed.length, 1);
  const t = s.closed[0];
  // entryVal=7500, exitVal=11250, gross=3750, costs=141.42 (from the case above) -> pnl=3608.58
  assert.equal(t.grossPnl, 3750);
  assert.equal(t.costs, 141.42);
  assert.equal(t.pnl, 3608.58);
  assert.ok(t.pnl > 0, "a target-hit exit above entry must be a net win after costs");
  // Cash increases by (exitVal - costs), i.e. by exactly pnl + entryVal.
  assert.equal(s.indexOption.cash, Math.round((startCash + 11250 - 141.42) * 100) / 100);
});

test("closePosition: a losing trade (stopped out below entry) records a negative net P&L", () => {
  const s = emptyTestState();
  const pos = testPosition({ id: "t2" });
  s.open.push(pos);

  closePosition(s, pos, 70, "stop", 1000);

  const t = s.closed[0];
  assert.equal(t.grossPnl, -2250); // (70-100)*75
  assert.ok(t.pnl < t.grossPnl, "costs must widen the loss, never shrink it");
  assert.ok(t.pnl < 0);
});

test("optionMark: at spotEntry, mark equals entryPrice (zero theta held)", () => {
  const pos = testPosition();
  const mark = optionMark(pos, pos.spotEntry, pos.entryEpoch);
  assert.equal(mark, pos.entryPrice);
});

test("optionMark: interpolates linearly toward premiumTarget as spot approaches spotTarget", () => {
  const pos = testPosition(); // entry 100 -> target 150 over spot 25000 -> 25100
  const halfway = optionMark(pos, 25050, pos.entryEpoch);
  assert.equal(halfway, 125); // linear midpoint
});

test("optionMark: a degenerate position (spotTarget === spotEntry) holds at entry price instead of fabricating a slope", () => {
  const pos = testPosition({ spotTarget: 25000 }); // == spotEntry
  const mark = optionMark(pos, 25200, pos.entryEpoch);
  assert.equal(mark, pos.entryPrice, "must NOT divide by zero / a fake denominator and extrapolate a huge mark");
});
