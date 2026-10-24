import { test } from "node:test";
import assert from "node:assert/strict";
// the same file the browser loads (UMD) — the ladder's 5-minute rejection / break read
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LR = require("../../frontend/levelReaction.js");

const c = (open: number, high: number, low: number, close: number, time = 1_800_000_000) => ({ time, open, high, low, close });
const L = 22500, TOL = LR.tolOf(L, 20);   // max(9, 2) = 9 pts

test("tolerance = max(0.04 % of the level, 0.1 × ATR)", () => {
  assert.equal(LR.tolOf(22500, 20), 9);
  assert.equal(LR.tolOf(22500, 200), 20);
  assert.equal(LR.tolOf(22500, null), 9);
});

test("support rejection: wick into the level, close back above, wick ≥ 40 %", () => {
  const r = LR.react(c(22530, 22540, 22495, 22532), L, TOL);   // range 45, lower wick 35 (78 %)
  assert.equal(r.role, "support"); assert.equal(r.code, "REJ_UP"); assert.ok(r.wickPct > 0.7);
});
test("support touch without rejection: small wick or close sitting on the level", () => {
  assert.equal(LR.react(c(22560, 22565, 22505, 22510), L, TOL).code, "TOUCH");     // reached within tol, wick 5 of 60
  assert.equal(LR.react(c(22520, 22525, 22492, 22498), L, TOL).code, "TOUCH");     // closed 2 pts below but within tol, under the level
});
test("support break: a close below the level minus the tolerance", () => {
  assert.equal(LR.react(c(22520, 22525, 22470, 22480), L, TOL).code, "BRK_DN");
});
test("support not reached → NONE", () => {
  assert.equal(LR.react(c(22560, 22580, 22540, 22570), L, TOL).code, "NONE");
});

test("resistance rejection / touch / break / none (mirror)", () => {
  assert.equal(LR.react(c(22470, 22508, 22462, 22468), L, TOL).code, "REJ_DN");   // upper wick 38 of 46
  assert.equal(LR.react(c(22440, 22495, 22435, 22490), L, TOL).code, "TOUCH");    // reached within tol, no wick
  assert.equal(LR.react(c(22480, 22530, 22475, 22520), L, TOL).code, "BRK_UP");
  assert.equal(LR.react(c(22400, 22450, 22390, 22440), L, TOL).code, "NONE");
});

test("role comes from the candle's OPEN, so a level does not flip side mid-candle", () => {
  // opened above 22500 and closed below → support broken (not a 'resistance rejection')
  const r = LR.react(c(22510, 22512, 22470, 22475), L, TOL);
  assert.equal(r.role, "support"); assert.equal(r.code, "BRK_DN");
});

test("doji / zero-range candle never divides by zero", () => {
  const r = LR.react(c(22500, 22500, 22500, 22500), L, TOL);
  assert.equal(r.code, "TOUCH"); assert.equal(r.wickPct, 0);
});
test("bad inputs → NONE", () => {
  assert.equal(LR.react(null, L, TOL).code, "NONE");
  assert.equal(LR.react(c(1, 2, 0, 1), NaN, TOL).code, "NONE");
});

test("last CLOSED candle: the forming one is skipped; a replay counts all as closed", () => {
  const cs = [c(1, 2, 0, 1, 1000), c(1, 2, 0, 1, 1300), c(1, 2, 0, 1, 1600)];
  assert.equal(LR.lastClosed(cs, 1700, false).index, 1);   // 1600 + 300 > 1700 → still forming
  assert.equal(LR.lastClosed(cs, 1900, false).index, 2);
  assert.equal(LR.lastClosed(cs, 1700, true).index, 2);
  assert.equal(LR.lastClosed([], 1700, false), null);
  assert.equal(LR.lastClosed(cs, 1100, false), null);
});

test("ATR(14) needs 15 candles", () => {
  const cs = Array.from({ length: 15 }, (_, i) => c(100, 110, 90, 100, i * 300));
  assert.equal(LR.atr14(cs), 20);
  assert.equal(LR.atr14(cs.slice(1)), null);
});

test("every code has a short label with an arrow or word (colour is never the only signal)", () => {
  for (const k of ["REJ_UP", "REJ_DN", "BRK_UP", "BRK_DN", "TOUCH"]) { assert.match(LR.LABEL[k].short, /▲|▼|TOUCH/); assert.ok(LR.LABEL[k].text.length > 10); }
});
