import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmedSwings, trendlines, breakStates, liquidity, chainMedianSpreadPct, modelPremiumMove, premiumBehaviour, optionDirection, masterDecision, typicalMove, VALIDATION, MasterInput } from "./premiumCenter";

const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: 1_000_000 + i * 300, open: o, high: h, low: l, close: c, volume: 100 });
const flat = (n: number, p = 100) => Array.from({ length: n }, (_, i) => bar(i, p, p + 1, p - 1, p));

test("swings need k CLOSED bars on the right; adding bars never removes an earlier swing (no repaint)", () => {
  const cs = [100, 102, 105, 103, 101, 99, 97, 99, 101, 104, 102, 100].map((p, i) => bar(i, p, p + 1, p - 1, p));
  const s = confirmedSwings(cs, 2);
  assert.deepEqual(s.map((x) => [x.kind, x.index]), [["HIGH", 2], ["LOW", 6], ["HIGH", 9]]);   // bar 9 is confirmed only because bars 10 and 11 have closed
  assert.equal(confirmedSwings(cs.slice(0, 10), 2).some((x) => x.index === 9), false);
  for (let n = 5; n <= cs.length; n++) {
    const now = confirmedSwings(cs.slice(0, n), 2), later = confirmedSwings(cs, 2);
    for (const x of now) assert.ok(later.some((y) => y.index === x.index && y.kind === x.kind), `swing ${x.index} vanished`);
  }
});
test("seller trendline through lower highs; broken only by a CLOSE above the line", () => {
  const p = [100, 104, 110, 104, 100, 98, 101, 106, 101, 98, 96, 99, 103, 100, 97, 98, 99];
  const cs = p.map((v, i) => bar(i, v, v + 0.5, v - 0.5, v));
  const t = trendlines(cs).seller!;
  assert.ok(t && t.p2.price < t.p1.price && t.status === "INTACT");
  const wick = [...cs, { ...bar(17, 99, 120, 98, 99) }];                        // wick far above, close below
  assert.equal(trendlines(wick).seller!.status, "INTACT");
  const brk = [...cs, bar(17, 99, 112, 98, 111)];
  assert.equal(trendlines(brk).seller!.status, "BROKEN");
});
test("break states: wick ≠ breakout; close beyond buffer = confirmed; retest; failure; intrabar attempt", () => {
  const base = flat(20, 100), lv = (n: number) => Array.from({ length: n + 1 }, () => ({ resistance: 101, support: 99 }));
  // pre-breakout: close within 0.5 ATR
  assert.equal(breakStates(base, null, lv(20), 2, 0.2).bull.state, "PRE_BREAKOUT");
  // wick above, close below → not a breakout; forming bar above → ATTEMPT (intrabar)
  const wick = [...base, bar(20, 100, 103, 99.5, 100.5)];
  assert.equal(breakStates(wick, null, lv(21), 2, 0.2).bull.state, "PRE_BREAKOUT");
  const att = breakStates(base, bar(20, 100, 101.6, 99.8, 101.4), lv(20), 2, 0.2).bull;
  assert.equal(att.state, "BREAKOUT_ATTEMPT"); assert.equal(att.intrabar, true);
  const conf = [...base, bar(20, 100, 102.5, 99.9, 102)];
  assert.equal(breakStates(conf, null, lv(21), 2, 0.2).bull.state, "CONFIRMED_BREAKOUT");
  assert.equal(breakStates([...conf, bar(21, 102, 102.4, 101.05, 102.2)], null, lv(22), 2, 0.2).bull.state, "RETEST_HOLD");
  assert.equal(breakStates([...conf, bar(21, 102, 102.1, 100, 100.5)], null, lv(22), 2, 0.2).bull.state, "FAILED_BREAKOUT");
  const dn = [...base, bar(20, 100, 100.1, 97, 98)];
  assert.equal(breakStates(dn, null, lv(21), 2, 0.2).bear.state, "CONFIRMED_BREAKDOWN");
});
test("liquidity is judged against the chain's own spreads; missing quote is never GOOD", () => {
  assert.equal(liquidity(100, 100.5, 100.2, 0.6, 1000).status, "GOOD");
  assert.equal(liquidity(100, 101.5, 100.7, 0.6, 1000).status, "WIDE");
  assert.equal(liquidity(100, 105, 102, 0.6, 1000).status, "POOR");
  assert.equal(liquidity(null, null, 50, 0.6, 1000).status, "NOT AVAILABLE");
  assert.equal(chainMedianSpreadPct([{ strike: 100, ceOi: 0, peOi: 0, ceChg: 0, peChg: 0, ceBid: 10, ceAsk: 10.1, peBid: 20, peAsk: 20.2 }], 100, 50), 1);
});
test("model premium move uses the feed's greeks only; null without delta", () => {
  const m = modelPremiumMove({ delta: 0.5, gamma: 0.001, theta: -15, ltp: 100 }, 30, 15)!;
  assert.equal(m.ifIndexUp, r(0.5 * 30 + 0.5 * 0.001 * 900 - 15 * 15 / 375));
  assert.equal(modelPremiumMove({ delta: null, gamma: null, theta: null, ltp: 100 }, 30, 15), null);
  assert.equal(typicalMove(flat(5), 3), null);
});
const r = (v: number) => Math.round(v * 100) / 100;
test("an option is UP only when the index structure favours it AND its own premium confirms", () => {
  const rising = Array.from({ length: 12 }, (_, i) => bar(i, 50 + i, 51 + i, 49 + i, 50 + i * (i === 11 ? 1.2 : 1)));
  const beh = premiumBehaviour(rising)!;
  assert.equal(beh.response, "RISING");
  assert.equal(optionDirection("CE", "CONFIRMED_BREAKOUT", "NONE", beh).dir, "UP");
  assert.equal(optionDirection("CE", "NONE", "NONE", beh).dir, "SIDEWAYS");                 // premium alone is not enough
  const flatP = premiumBehaviour(flat(12, 50))!;
  assert.equal(optionDirection("CE", "CONFIRMED_BREAKOUT", "NONE", flatP).dir, "SIDEWAYS"); // structure alone is not enough
  assert.equal(optionDirection("PE", "CONFIRMED_BREAKOUT", "NONE", flatP).dir, "DOWN");
  assert.equal(optionDirection("CE", "NONE", "NONE", null).dir, "INSUFFICIENT DATA");
});
const M = (o: Partial<MasterInput> = {}): MasterInput => ({ dataStatus: "LIVE", enoughData: true, chainOk: true,
  bull: { state: "NONE", level: 101, barTime: null, intrabar: false, detail: "" }, bear: { state: "NONE", level: 99, barTime: null, intrabar: false, detail: "" },
  arbiter: null, nowSec: 1_000_000, inTradeWindow: true, cooldown: { active: false }, openTrade: null, liq: { CE: null, PE: null }, ...o });
test("master panel: arbiter and risk gates have final authority", () => {
  const buy = { finalAction: "BUY_CE", candleTime: 1_000_000 - 300, reason: "x", plan: null, option: null };
  assert.equal(masterDecision(M({ arbiter: buy })).state, "BUY CE CANDIDATE");
  assert.equal(masterDecision(M({ arbiter: buy, cooldown: { active: true, reason: "SL cooldown" } })).state, "RISK GATE BLOCKED");
  assert.equal(masterDecision(M({ arbiter: buy, openTrade: { index: "BANKNIFTY" } })).state, "RISK GATE BLOCKED");
  assert.equal(masterDecision(M({ arbiter: buy, inTradeWindow: false })).state, "RISK GATE BLOCKED");
  assert.equal(masterDecision(M({ arbiter: buy, liq: { CE: { status: "POOR", detail: "d" } as any, PE: null } })).state, "AVOID — POOR LIQUIDITY");
  assert.equal(masterDecision(M({ arbiter: { ...buy, candleTime: 1_000_000 - 3600 } })).state, "NO EDGE");          // stale arbiter BUY
  assert.equal(masterDecision(M({ arbiter: buy, dataStatus: "STALE" })).state, "AVOID — STALE DATA");
  assert.equal(masterDecision(M({ chainOk: false })).state, "AVOID — INSUFFICIENT DATA");
  // a confirmed breakout WITHOUT an arbiter BUY never becomes a candidate
  assert.equal(masterDecision(M({ bull: { state: "CONFIRMED_BREAKOUT", level: 101, barTime: 1, intrabar: false, detail: "" } })).state, "WAIT FOR RETEST");
  assert.equal(masterDecision(M({ bear: { state: "PRE_BREAKDOWN", level: 99, barTime: 1, intrabar: false, detail: "" } })).state, "WAIT FOR BREAKDOWN");
  assert.equal(VALIDATION.status, "PROBABILITY NOT VALIDATED");
});
test("probability status: NIFTY 5-min shows the tested NO EDGE result; every other index/timeframe stays NOT VALIDATED; never a number", async () => {
  const { validationFor } = await import("./premiumCenter");
  assert.equal(validationFor("^NSEI", "5m").status, "NO EDGE (TESTED)");
  assert.equal(validationFor("^NSEI", "15m").status, "PROBABILITY NOT VALIDATED");
  assert.equal(validationFor("^NSEBANK", "5m").status, "PROBABILITY NOT VALIDATED");
  for (const v of [validationFor("^NSEI", "5m"), validationFor("^BSESN", "15m")]) assert.equal((v as any).up ?? null, null);
});
