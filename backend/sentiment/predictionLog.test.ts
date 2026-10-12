import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolated storage: DATA_DIR must be set before the module (and dataDir.ts) is imported.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "predlog-"));
process.env.DATA_DIR = TMP;
let M: typeof import("./predictionLog");
before(async () => { M = await import("./predictionLog"); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const ist = (d: number, hh: number, mm: number) => Math.floor(Date.UTC(2026, 9, d, hh, mm) / 1000) - 19800;
const rec = (t: number, probs: any, extra: any = {}) => ({ id: `NIFTY|${t}`, index: "NIFTY", t, loggedAt: t, modelVersion: "test", probs, predicted: M.argmaxClass(probs), spot: 22500, vix: 15, regime: "RANGE", inputs: {}, inputAgeSec: {}, ...extra });

test("outcome rule: ±0.5 VIX-implied sigma", () => {
  const s15 = M.sigmaH(22500, 15, 15);                     // ≈ 42.5 pts
  assert.ok(Math.abs(s15 - 42.5) < 0.5, String(s15));
  const thr = (0.5 * s15) / 22500;
  assert.equal(M.outcomeLabel(thr * 1.01, 22500, 15, 15), "UP");
  assert.equal(M.outcomeLabel(-thr * 1.01, 22500, 15, 15), "DOWN");
  assert.equal(M.outcomeLabel(thr * 0.99, 22500, 15, 15), "SIDEWAYS");
});

test("resolveHorizon: not due, resolved, beyond session (after 15:20), missing bar", () => {
  const t = ist(13, 10, 0), r = rec(t, { UP: 0.5, DOWN: 0.2, SIDEWAYS: 0.3 });
  const bars = [{ time: t + 15 * 60 - 300, close: 22540 }];
  assert.equal(M.resolveHorizon(r as any, 15, bars, t + 600), null);                 // not due
  const o = M.resolveHorizon(r as any, 15, bars, t + 15 * 60 + 5)!;
  assert.equal(o.outcome, "UP"); assert.equal(o.spotEnd, 22540);
  const late = rec(ist(13, 14, 30), { UP: 0.4, DOWN: 0.3, SIDEWAYS: 0.3 });
  assert.equal(M.resolveHorizon(late as any, 60, [], ist(13, 16, 0))!.outcome, "BEYOND_SESSION");   // ends 15:30
  assert.equal(M.resolveHorizon(late as any, 30, [], ist(13, 14, 59)), null);         // 15:00 end not reached
  assert.equal(M.resolveHorizon(rec(t, { UP: 1, DOWN: 0, SIDEWAYS: 0 }) as any, 30, [], t + 30 * 60 + 1801)!.outcome, "NO_DATA");
});

test("one record per candle; outcomes appended and survive a re-read (restart)", () => {
  const t = ist(14, 10, 0), r = rec(t, { UP: 0.2, DOWN: 0.6, SIDEWAYS: 0.2 });
  assert.equal(M.logPrediction(r as any), true);
  assert.equal(M.logPrediction(r as any), false);                                     // duplicate refused
  const bars = [15, 30, 60].map((h) => ({ time: t + h * 60 - 300, close: 22400 }));
  assert.equal(M.resolveDay("2026-10-14", bars, t + 3700), 3);
  assert.equal(M.resolveDay("2026-10-14", bars, t + 3800), 0);                        // nothing new
  const outs = M.readOutcomes("2026-10-14");
  assert.equal(outs.length, 3); assert.ok(outs.every((o) => o.outcome === "DOWN"));
  assert.ok(fs.existsSync(path.join(TMP, "predictions", "2026-10-14.jsonl")));
});

test("three horizons are reported separately — never pooled into 3n", () => {
  const preds = [rec(ist(15, 10, 0), { UP: 0.6, DOWN: 0.2, SIDEWAYS: 0.2 })] as any[];
  const outs = [15, 30, 60].map((h) => ({ id: preds[0].id, h, end: 0, spotEnd: 1, r: 0.01, outcome: "UP", resolvedAt: 0 })) as any[];
  for (const h of M.HORIZONS) assert.equal(M.scoredFor(h, preds, outs).length, 1);
});

function synthScored(n: number, days: number, accurate: boolean) {
  const out: any[] = []; let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < n; i++) {
    const t = ist(1 + (i % days), 10, 0) + Math.floor(i / days) * 300;
    const truth = (["UP", "DOWN", "SIDEWAYS"] as const)[Math.floor(rnd() * 3)];
    const pc = accurate ? truth : (["UP", "DOWN", "SIDEWAYS"] as const)[Math.floor(rnd() * 3)];
    const probs: any = { UP: 0.1, DOWN: 0.1, SIDEWAYS: 0.1 }; probs[pc] = 0.8;
    out.push({ rec: rec(t, probs), outcome: truth, r: 0, prevOutcome: null });
  }
  return out.sort((a, b) => a.rec.t - b.rec.t);
}

test("small samples stay RESEARCH_ONLY even when perfect", () => {
  const r = M.evaluate(15, synthScored(80, 8, true), 100);
  assert.equal(r.status, "RESEARCH_ONLY"); assert.match(r.reason, /80 of at least 200/);
});

test("a random model stays RESEARCH_ONLY with ≥ 200 samples", () => {
  const r = M.evaluate(30, synthScored(400, 20, false), 200);
  assert.equal(r.n, 400);
  assert.equal(r.status, "RESEARCH_ONLY");
});

test("a genuinely skilful model with ≥ 200 samples over many days can pass", () => {
  const r = M.evaluate(60, synthScored(400, 20, true), 200);
  assert.equal(r.status, "VALIDATED", r.reason);
  assert.ok(r.edgeVsBest && r.edgeVsBest.ci95[0] > 0);
  assert.ok(r.model.brier < r.baselines.alwaysSideways.brier);
});

test("majority baseline uses only earlier outcomes (no look-ahead)", () => {
  // first prediction has no history → baseline defaults to SIDEWAYS even though UP dominates later
  const s = synthScored(3, 3, true).map((x, i) => ({ ...x, outcome: i === 0 ? "SIDEWAYS" : "UP" }));
  const r = M.evaluate(15, s as any, 20);
  assert.equal(r.classCounts.UP, 2);
  assert.equal(r.n, 3);
});

test("balanced accuracy averages per-class recall", () => {
  assert.equal(M.balancedAccuracy(["UP", "UP", "DOWN", "SIDEWAYS"], ["UP", "DOWN", "DOWN", "SIDEWAYS"]), (1 + 0.5 + 1) / 3);
});
