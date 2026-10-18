import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepRecord, sweepMapMsg, sweepAlertMsg } from "./sweepMsg";

const liq = {
  name: "NIFTY 50", dataStatus: "LIVE", opening: { price: 23121.6 },
  levels: [
    { side: "UPSIDE", price: 23076.55, type: "Opening Range High", status: "ACCEPTED", distance: -45, event: { time: "10:15" } },
    { side: "UPSIDE", price: 23150, type: "Previous Day High", status: "APPROACHING", distance: 28.4 },
    { side: "DOWNSIDE", price: 22938.85, type: "Previous Day Close", status: "REJECTED", distance: 182.75, event: { time: "09:35", pointsCaptured: 211.4, outcome: "REVERSAL" } },
    { side: "DOWNSIDE", price: 22894.15, type: "Swing Low", status: "WAITING", distance: 227.45 },
    { side: "DOWNSIDE", price: 22637.4, type: "Previous Day Low", status: "INVALIDATED", distance: 484 },
  ],
  history: [
    { side: "DOWNSIDE", pattern: "Liquidity Grab + Rejection" }, { side: "DOWNSIDE", pattern: "Sweep + Continuation" }, { side: "DOWNSIDE", pattern: "Sweep + Reversal" },
    { side: "UPSIDE", pattern: "Sweep + Continuation" }, { side: "UPSIDE", pattern: "Breakout + Continuation" },
  ],
};

test("sweep record per side counts only sweeps (reversed vs continued)", () => {
  const r = sweepRecord(liq.history);
  assert.deepEqual(r.bull, { reversed: 2, continued: 1, n: 3, pct: 67 });
  assert.deepEqual(r.put, { reversed: 0, continued: 1, n: 1, pct: 0 });
});
test("sweep map: both sides — swept levels, real breaks, next pools with distance, 20-session record", () => {
  const m = sweepMapMsg(liq, "10:30");
  assert.match(m, /NIFTY · LIQUIDITY SWEEP MAP<\/b> · 10:30/);
  assert.match(m, /BULL SIDE<\/b>[\s\S]*SWEPT 09:35<\/b> 22,939 Previous Day Close → closed back above · then index \+211 pts → <b>sweep worked<\/b>/);
  assert.match(m, /next pool <b>22,894<\/b> Swing Low · 227 pts below/);
  assert.match(m, /2\/3 sweeps reversed \(67%\)/);
  assert.match(m, /PUT SIDE<\/b>[\s\S]*23,077 Opening Range High — <b>ACCEPTED<\/b> \(real break 10:15, not a sweep\)/);
  assert.match(m, /next pool <b>23,150<\/b> Previous Day High · 28 pts above · <b>APPROACHING<\/b> — sweep zone/);
  assert.ok(!/22,637/.test(m), "invalidated levels are not shown");
});
test("sweep alert: side, level, closed back, CE / PE idea with the stop", () => {
  const a = sweepAlertMsg(liq, liq.levels[2]);
  assert.match(a, /NIFTY · BULL-SIDE LIQUIDITY SWEEP<\/b> · 09:35/);
  assert.match(a, /closed back above<\/b> it/); assert.match(a, /CE idea/); assert.match(a, /Stop Loss: a 5-min close back below 22,939/);
});
test("sweep map shows the real index direction after a failed put-side sweep", () => {
  const m = sweepMapMsg({ name: "SENSEX", opening: { price: 74675 }, levels: [{ side: "UPSIDE", price: 74504, type: "Opening Range High", status: "REJECTED", distance: -171, event: { time: "10:05", pointsCaptured: 300.2, outcome: "CONTINUATION" } }], history: [] }, "15:30");
  assert.match(m, /SWEPT 10:05<\/b> 74,504 Opening Range High → closed back below · then index \+300 pts → <b>sweep failed \(break continued\)<\/b>/);
});
