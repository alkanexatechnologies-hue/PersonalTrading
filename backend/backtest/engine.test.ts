import test from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "./engine";
import { Candle } from "../types";

// runBacktest drives the "historical success rate" shown live to users
// (routes/api.ts) - a flipped long/short entry condition would silently
// misreport that number without ever crashing. These tests don't hand-derive
// exact P&L (that depends on the full multi-indicator score composition in
// signals/score.ts), but they pin down the one thing that must never invert:
// a clean uptrend must only ever produce LONG trades, and a clean downtrend
// must only ever produce SHORT trades, each winning when the price moves in
// its favour.

function trend(n: number, stepPct: number, base = 100): Candle[] {
  const startEpoch = Date.UTC(2026, 0, 5, 4, 0, 0) / 1000; // single IST trading day
  const out: Candle[] = [];
  let close = base;
  for (let i = 0; i < n; i++) {
    close = i === 0 ? base : close * (1 + stepPct / 100);
    const wick = Math.abs(close * stepPct) / 200;
    out.push({ time: startEpoch + i * 300, open: close, high: close + wick, low: close - wick, close, volume: 1000 });
  }
  return out;
}

const PARAMS = { entryThreshold: 5, stopLossPercent: 5, targetPercent: 5 };

test("runBacktest: a clean, sustained uptrend produces only LONG trades", () => {
  const result = runBacktest("TEST", "5m", trend(60, 0.6), PARAMS);
  assert.ok(result.trades.length > 0, "an obvious trending market must produce at least one trade");
  for (const t of result.trades) {
    assert.equal(t.side, "LONG", `expected a LONG trade in an uptrend, got ${t.side}`);
  }
});

test("runBacktest: a clean, sustained downtrend produces only SHORT trades", () => {
  const result = runBacktest("TEST", "5m", trend(60, -0.6), PARAMS);
  assert.ok(result.trades.length > 0, "an obvious trending market must produce at least one trade");
  for (const t of result.trades) {
    assert.equal(t.side, "SHORT", `expected a SHORT trade in a downtrend, got ${t.side}`);
  }
});

test("runBacktest: every target-hit exit is a net winner (after costs)", () => {
  const up = runBacktest("TEST", "5m", trend(60, 0.6), PARAMS);
  const down = runBacktest("TEST", "5m", trend(60, -0.6), PARAMS);
  for (const t of [...up.trades, ...down.trades]) {
    if (t.exitReason === "target") {
      assert.ok(t.pnl > 0, `a target-hit trade must be profitable, got pnl=${t.pnl} (${t.side})`);
      assert.ok(t.pnlPercent > 0);
    }
  }
});
