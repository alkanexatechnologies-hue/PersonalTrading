import { test } from "node:test";
import assert from "node:assert/strict";
import { nnls, returnRows, walkForward, buildModel, contributions, PASS_RULE, type Bar } from "./niftyWeights";

// Deterministic pseudo-random so the test never flakes.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; }; }

/** n sessions of 5-min bars (09:15–15:25 IST); index = Σ w × stock returns (+ optional noise). */
function synth(weights: number[], sessions: number, noise = 0, seed = 7) {
  const r = rng(seed);
  const stocks: Bar[][] = weights.map(() => []), index: Bar[] = [];
  let px = weights.map(() => 100), ix = 20000;
  for (let d = 0; d < sessions; d++) {
    const day0 = Date.UTC(2026, 6, 1 + d * 1, 3, 45) / 1000;   // 09:15 IST
    // overnight gap applied to every series
    const gaps = weights.map(() => r() * 0.01);
    const gapIx = weights.reduce((a, w, i) => a + w * gaps[i], 0);
    px = px.map((p, i) => p * (1 + gaps[i])); ix *= 1 + gapIx;
    for (let k = 0; k < 75; k++) {
      const t = day0 + k * 300;
      const rets = weights.map(() => r() * 0.004);
      const opens = [...px], ixOpen = ix;
      if (k > 0) { px = px.map((p, i) => p * (1 + rets[i])); ix *= 1 + weights.reduce((a, w, i) => a + w * rets[i], 0) + noise * r(); }
      px.forEach((p, i) => stocks[i].push([t, k === 0 ? p : opens[i], p]));
      index.push([t, k === 0 ? ix : ixOpen, ix]);
    }
  }
  const named: Record<string, Bar[]> = Object.fromEntries(stocks.map((s, i) => ["S" + i, s]));
  return { index, stocks: named };
}

test("nnls recovers known non-negative coefficients", () => {
  const { index, stocks } = synth([0.5, 0.3, 0.2], 12);
  const days = [...new Set(index.map((b) => new Date((b[0] + 19800) * 1000).toISOString().slice(0, 10)))];
  const { X, y } = returnRows(index, stocks, days);
  const w = nnls(X, y);
  [0.5, 0.3, 0.2].forEach((v, i) => assert.ok(Math.abs(w[i] - v) < 0.01, `coef ${i} = ${w[i]}`));
});

test("nnls never returns negative coefficients", () => {
  const X = [[1, 0], [0, 1], [1, 1]], y = [1, -1, 0];
  assert.ok(nnls(X, y).every((v) => v >= 0));
});

test("walk-forward on clean data passes the pre-set rule with tiny errors", () => {
  const { index, stocks } = synth([0.5, 0.3, 0.2], PASS_RULE.minSessions + 12);
  const v = walkForward(index, stocks)!;
  assert.ok(v.sessions >= PASS_RULE.minSessions);
  assert.ok(v.intraMedian < 1 && v.gapMedian < 1, JSON.stringify(v));
  assert.equal(v.pass, true);
});

test("walk-forward fails when the index is not explained by the constituents", () => {
  const { index, stocks } = synth([0.5, 0.3, 0.2], PASS_RULE.minSessions + 12, 0.01);   // heavy unexplained noise
  const v = walkForward(index, stocks)!;
  assert.equal(v.pass, false);
});

test("too few sessions can never pass", () => {
  const { index, stocks } = synth([0.5, 0.5], 15);
  const v = walkForward(index, stocks);
  assert.ok(!v || v.pass === false);
});

test("contributions convert % moves to index points and sum to the explained move", () => {
  const m: any = { coefs: { HDFCBANK: 0.1, ITC: 0.025, TCS: 0.02 } };
  const r = contributions(m, { HDFCBANK: -1, ITC: -3.29, TCS: null }, 22520.45);
  assert.deepEqual(r.rows.map((x) => x.symbol), ["ITC", "HDFCBANK"]);   // most positive first
  assert.equal(r.rows.find((x) => x.symbol === "HDFCBANK")!.points, -22.5);
  assert.equal(r.rows.find((x) => x.symbol === "ITC")!.points, -18.5);
  assert.equal(r.explained, -41);
  assert.equal(r.rows.length, 2, "missing move is skipped, not treated as 0");
});

test("buildModel records version, training window and validation", () => {
  const { index, stocks } = synth([0.6, 0.4], PASS_RULE.minSessions + 12);
  const m = buildModel(index, stocks, 1);
  assert.equal(m.version, "contrib-nnls-v1");
  assert.equal(m.trainedOn.length, 10);
  assert.ok(m.validation && m.validation.pass);
  assert.ok(Math.abs(m.coefs.S0 - 0.6) < 0.01);
});
