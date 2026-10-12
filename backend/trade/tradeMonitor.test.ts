import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFromCandles, isMonitorable, MonitorTrade, Candle } from "./tradeMonitor";

const t: MonitorTrade = { execTs: 1000, entry: 100, sl: 80, target: 130 };
const c = (time: number, high: number, low: number, close: number): Candle => ({ time, open: (high + low) / 2, high, low, close });

test("isMonitorable requires entry + both levels in the right order", () => {
  assert.equal(isMonitorable(t), true);
  assert.equal(isMonitorable({ execTs: 1, entry: 100, sl: 0, target: 0 }), false); // the stale/manual case (no levels)
  assert.equal(isMonitorable({ execTs: 1, entry: 100, sl: 120, target: 130 }), false); // stop above entry
});

test("Target Hit when a candle high reaches target", () => {
  const r = resolveFromCandles(t, [c(1000, 110, 95, 105), c(1300, 132, 108, 128)], false);
  assert.equal(r?.status, "Target Hit");
  assert.equal(r?.exitPrice, 130);
  assert.equal(r?.exitTs, 1300);
});

test("SL Hit when a candle low reaches stop", () => {
  const r = resolveFromCandles(t, [c(1000, 110, 95, 100), c(1300, 102, 78, 85)], false);
  assert.equal(r?.status, "SL Hit");
  assert.equal(r?.exitPrice, 80);
});

test("still Open while price stays between stop and target", () => {
  const r = resolveFromCandles(t, [c(1000, 112, 96, 108), c(1300, 120, 98, 115)], false);
  assert.equal(r, null);
});

test("same-bar target+stop → stop taken first (never over-report a win)", () => {
  const r = resolveFromCandles(t, [c(1300, 135, 78, 120)], false);
  assert.equal(r?.status, "SL Hit");
});

test("candles before entry are ignored", () => {
  const r = resolveFromCandles(t, [c(500, 200, 10, 150), c(1300, 118, 99, 110)], false);
  assert.equal(r, null); // the pre-entry spike must not count
});

test("EOD square-off in profit → EOD Exit (never reported as Target Hit) with remark", () => {
  const r = resolveFromCandles(t, [c(1000, 112, 96, 108), c(1300, 120, 98, 118)], true);
  assert.equal(r?.status, "EOD Exit");
  assert.equal(r?.exitPrice, 118);
  assert.match(r?.remark || "", /square-off/i);
});

test("EOD square-off in loss → EOD Exit (never reported as SL Hit)", () => {
  const r = resolveFromCandles(t, [c(1000, 108, 96, 102), c(1300, 104, 90, 92)], true);
  assert.equal(r?.status, "EOD Exit");
  assert.equal(r?.exitPrice, 92);
});

test("unmonitorable trade never resolves (SL/target = 0)", () => {
  const bad: MonitorTrade = { execTs: 1000, entry: 112.4, sl: 0, target: 0 };
  assert.equal(resolveFromCandles(bad, [c(1300, 200, 1, 150)], true), null);
});

import { normalizeEod } from "./tradeLogStore";
test("legacy rows closed by the EOD square-off read back as EOD Exit", () => {
  const row: any = { status: "Target Hit", remarks: "Auto signal · EOD square-off @ 196.75 (in profit; target/SL not touched)" };
  assert.equal(normalizeEod(row).status, "EOD Exit");
  assert.equal(normalizeEod({ status: "Target Hit", remarks: "Target hit" } as any).status, "Target Hit");
});
