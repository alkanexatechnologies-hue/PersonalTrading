import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Candle, OiAnalysis, OiStrike } from "../types";
import { buildBreakout } from "./breakoutService";
import { session, setBar, Leg } from "./breakoutFixtures";

const LEGS: Leg[] = [
  { to: 22090, bars: 6 }, { to: 22080, bars: 3 }, { to: 22100, bars: 5 }, { to: 22085, bars: 4 }, { to: 22100, bars: 4 },
  { to: 22090, bars: 3 }, { to: 22100, bars: 3 }, { to: 22094, bars: 3 }, { to: 22098, bars: 2 }, { to: 22098, bars: 1 },
];
const breakoutCandles = (): Candle[] => { const cs = session(22060, 42, 22070, LEGS); setBar(cs, cs.length - 1, 22098, 22105, 22097.5, 22104.5); return cs; };

function chain(spot: number, step = 50): OiAnalysis {
  const atm = Math.round(spot / step) * step;
  const strikes: OiStrike[] = [];
  for (let k = -6; k <= 6; k++) {
    const K = atm + k * step, m = (spot - K) / step, ceD = Math.min(0.95, Math.max(0.05, 0.5 + m * 0.12));
    strikes.push({ strike: K, ceOi: 100000 - Math.abs(k) * 6000, peOi: 100000 - Math.abs(k) * 6000, ceChg: 1000, peChg: 1000,
      ceLtp: +(Math.max(0, spot - K) + step * 1.2 * ceD).toFixed(2), peLtp: +(Math.max(0, K - spot) + step * 1.2 * (1 - ceD)).toFixed(2),
      ceVol: 50000, peVol: 50000, ceDelta: +ceD.toFixed(2), peDelta: -(1 - ceD) });
  }
  return { symbol: "NIFTY", nseSymbol: "NIFTY", available: true, underlying: spot, expiry: "2026-10-13", topStrikes: strikes } as unknown as OiAnalysis;
}
const def = { symbol: "^NSEI", name: "NIFTY 50", nseSymbol: "NIFTY", fno: true } as any;

function live(cs: Candle[], sym: string, extra: Partial<Parameters<typeof buildBreakout>[0]> = {}) {
  const lastT = cs[cs.length - 1].time;
  return {
    candles: cs, intervalSec: 300, isHistorical: false, nowSec: lastT + 300 + 5,   // the breakout bar has just CLOSED
    marketOpen: true, def, symbol: sym, interval: "5m", oiChain: chain(22104.5), chainStale: false, dataStatus: "LIVE", ...extra,
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bo-"));

test("live fresh BUY + liquid strike + verified Security ID → executable BUY CE, recorded once", async () => {
  const dir = tmp();
  const lookupOption = async () => ({ securityId: "48211", exchangeSegment: "NSE_FNO" as const, instrument: "OPTIDX" as const });
  const r = await buildBreakout(live(breakoutCandles(), "T1"), { lookupOption, recordDir: dir });
  assert.equal(r.latest!.state, "BUY");
  const s = r.signals[0];
  assert.equal(s.optionSource, "LIVE");
  assert.equal(s.executable, true);
  assert.equal(s.option!.side, "CE");
  assert.equal(s.option!.securityId, "48211");
  assert.equal(s.option!.identity!.verified, true);
  // Recorded: a later call (e.g. a new chain snapshot) must reuse the recorded plan, not rebuild it.
  const again = await buildBreakout(live(breakoutCandles(), "T1", { oiChain: chain(22150) }), { lookupOption, recordDir: dir });
  assert.equal(again.signals[0].optionSource, "RECORDED");
  assert.equal(again.signals[0].option!.entry, s.option!.entry);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("live fresh BUY without option chain → BUY CONFIRMED, not executable, reason shown", async () => {
  const r = await buildBreakout(live(breakoutCandles(), "T2", { oiChain: null }), { lookupOption: async () => null, recordDir: tmp() });
  assert.equal(r.latest!.state, "BUY CONFIRMED");
  assert.equal(r.latest!.command, "WAIT");
  assert.match(r.latest!.optionGate!, /Option gate/);
  assert.equal(r.signals[0].executable, false);
});

test("live fresh BUY with unverified contract (not in instrument master) → not executable", async () => {
  const r = await buildBreakout(live(breakoutCandles(), "T3"), { lookupOption: async () => null, recordDir: tmp() });
  assert.equal(r.latest!.state, "BUY CONFIRMED");
  assert.match(r.latest!.optionGate!, /Security ID|identity/);
});

test("chart-only fast payload (chain loading) does not downgrade or record the signal", async () => {
  const dir = tmp();
  const r = await buildBreakout(live(breakoutCandles(), "T4", { oiChain: null, chainPending: true }), { lookupOption: async () => null, recordDir: dir });
  assert.equal(r.latest!.state, "BUY");
  assert.equal(r.signals[0].gateNote, "Option chain loading…");
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("stale live data → AVOID, no signal", async () => {
  const r = await buildBreakout(live(breakoutCandles(), "T5", { dataStatus: "STALE" }), { lookupOption: async () => null, recordDir: tmp() });
  assert.equal(r.latest!.state, "AVOID");
  assert.equal(r.signals.length, 0);
});

test("replay / historical → spot plan only, option explicitly not available", async () => {
  const cs = breakoutCandles();
  const r = await buildBreakout({ ...live(cs, "T6"), isHistorical: true, marketOpen: false, oiChain: null, dataStatus: "HISTORICAL" }, { lookupOption: async () => null, recordDir: tmp() });
  assert.equal(r.dataStatus, "HISTORICAL");
  assert.equal(r.signals[0].option, null);
  assert.match(r.signals[0].gateNote!, /no historical option chain/);
});
