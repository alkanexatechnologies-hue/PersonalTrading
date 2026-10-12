import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
process.env.DATA_DIR = TMP;
let M: typeof import("./marketInputs");
before(async () => { M = await import("./marketInputs"); });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ist = (hh: number, mm: number, d = 13) => Math.floor(Date.UTC(2026, 9, d, hh, mm) / 1000) - 19800;
function bars(fromH: number, fromM: number, n: number, step: number, start: number, slope: number, d = 13) {
  return Array.from({ length: n }, (_, i) => { const c = start + slope * i; return { time: ist(fromH, fromM, d) + i * step, open: c - slope * 0.5, high: c + 3, low: c - 3, close: c }; });
}
function data(over: any = {}) {
  const now = ist(9, 26);
  return {
    nowSec: now,
    crude: { value: 8982, ts: now - 600, contract: "CRUDEOIL Oct-26" },
    itMoves: [{ s: "INFY", pct: 1, coef: 0.035 }, { s: "TCS", pct: 0.8, coef: 0.022 }, { s: "HCLTECH", pct: 0.5, coef: 0.015 }, { s: "TECHM", pct: 0.4, coef: 0.01 }, { s: "WIPRO", pct: -0.2, coef: 0.007 }],
    bankMoves: [{ s: "HDFCBANK", pct: -1, coef: 0.1 }, { s: "ICICIBANK", pct: -0.8, coef: 0.09 }, { s: "SBIN", pct: -0.5, coef: 0.035 }, { s: "AXISBANK", pct: -0.6, coef: 0.035 }, { s: "KOTAKBANK", pct: 0.2, coef: 0.03 }],
    movesTs: now - 30,
    oi: { asOf: now - 60, spot: 22380, strikes: [
      { strike: 22300, ceOi: 1, peOi: 9, ceChg: 0, peChg: 3e6 }, { strike: 22350, ceOi: 2, peOi: 8, ceChg: 0, peChg: 5e6, ceLtp: 120, peLtp: 95, cePrevClose: 100, pePrevClose: 110, ceDelta: 0.55, peDelta: -0.45 },
      { strike: 22400, ceOi: 9, peOi: 4, ceChg: 7e6, peChg: 1e6, ceLtp: 90, peLtp: 115, cePrevClose: 80, pePrevClose: 125, ceDelta: 0.45, peDelta: -0.55 } ] },
    spotPrevClose: 22363,
    c5: [...bars(9, 15 - 5 * 30, 30, 300, 22300, 1, 12), { time: ist(9, 15), open: 22370, high: 22390, low: 22360, close: 22385 }, { time: ist(9, 20), open: 22385, high: 22386, low: 22370, close: 22375 }],
    c15: bars(6, 0, 30, 900, 22200, 4, 12), c60: bars(0, 0, 30, 3600, 22000, 10, 11),
    fii: { asOf: "2026-10-12", netChange: 13121, longPct: 9.6, diiNet: 31930 },
    gift: { nightPct: 0.45, ts: now - 3600 * 3 },
    news: { positive: 1, negative: 2, ts: now - 120 },
    ...over,
  };
}

test("evaluates all 14 inputs from full data, each with status, impact and reason", () => {
  const ins = M.evaluateInputs(data() as any);
  assert.equal(ins.length, 14);
  assert.deepEqual(ins.map((i) => i.id), Array.from({ length: 14 }, (_, i) => i + 1));
  const by = (k: string) => ins.find((i) => i.key === k)!;
  assert.equal(by("crude").impact, "Positive"); assert.match(by("crude").value, /< 9,600/); assert.equal(by("crude").source, "Dhan MCX");
  assert.equal(by("global").impact, "Positive"); assert.equal(by("global").source, "Dhan GIFT NIFTY");
  assert.equal(by("it").impact, "Positive"); assert.equal(by("bank").impact, "Negative");
  assert.equal(by("support").value, "22350 (+50L)"); assert.equal(by("resistance").value, "22400 (+70L)");
  assert.equal(by("first2").value, "Bullish → Bearish"); assert.equal(by("first2").impact, "Mixed");
  assert.equal(by("news").impact, "Negative");
  assert.ok(ins.every((i) => i.reason && i.source));
});

test("missing sources are UNAVAILABLE with a reason — never filled in", () => {
  const ins = M.evaluateInputs(data({ crude: null, gift: null, oi: null, itMoves: null, fii: null, news: null }) as any);
  for (const k of ["crude", "global", "it", "support", "resistance", "spike", "atm", "fii", "news"]) {
    const i = ins.find((x) => x.key === k)!;
    assert.equal(i.status, "UNAVAILABLE", k); assert.equal(i.value, "—"); assert.ok(i.reason.length > 5);
  }
});

test("old data is STALE", () => {
  const now = ist(9, 26);
  const ins = M.evaluateInputs(data({ crude: { value: 9800, ts: now - 8 * 3600, contract: "x" }, movesTs: now - 1200 }) as any);
  assert.equal(ins.find((i) => i.key === "crude")!.status, "STALE");
  assert.equal(ins.find((i) => i.key === "it")!.status, "STALE");
  assert.equal(ins.find((i) => i.key === "crude")!.impact, "Negative");
});

test("trend rule on closed bars", () => {
  const now = ist(15, 0);
  assert.equal(M.tfDirection(bars(9, 15, 40, 300, 22000, 5), now, 300), "BULLISH");
  assert.equal(M.tfDirection(bars(9, 15, 40, 300, 22000, -5), now, 300), "BEARISH");
  assert.equal(M.tfDirection(bars(9, 15, 10, 300, 22000, 5), now, 300), null);
});

test("premium spike is judged against the delta-explained move", () => {
  const ins = M.evaluateInputs(data() as any);
  const s = ins.find((i) => i.key === "spike")!;
  // ATM 22400: CE 80→90 (+10), spot +17 × 0.45 ≈ +7.7 → excess small; no spike
  assert.equal(s.value, "No spike");
  const hot = data(); hot.oi.strikes[2].ceLtp = 130;            // CE +50 with spot +17 → IV-driven
  assert.equal(M.evaluateInputs(hot as any).find((i) => i.key === "spike")!.value, "CE spike (IV)");
});

test("what-if scenarios work on a copy and mark overrides SIMULATED", () => {
  const ins = M.evaluateInputs(data() as any);
  const before = JSON.stringify(ins);
  const s = M.simulate(ins, { crude: "Negative", bank: "Positive" });
  assert.equal(JSON.stringify(ins), before);                     // original untouched
  assert.deepEqual(s.changed.sort(), ["bank", "crude"]);
  assert.ok(s.inputs.find((i) => i.key === "crude")!.simulated);
  assert.equal(s.simulated, true);
  assert.match(s.tally.note, /not a probability/);
});

test("09:25 snapshot is immutable; revisions record what changed", () => {
  const ins = M.evaluateInputs(data() as any);
  assert.equal(M.saveSnapshot("2026-10-13", ist(9, 25), ins), true);
  const changed = ins.map((i) => (i.key === "crude" ? { ...i, impact: "Negative" as const } : i));
  assert.equal(M.saveSnapshot("2026-10-13", ist(9, 30), changed), false);       // refused
  assert.equal(M.readDay("2026-10-13").snapshot!.inputs.find((i) => i.key === "crude")!.impact, "Positive");
  assert.equal(M.recordRevision("2026-10-13", ist(9, 30), ins, "5-min re-evaluation"), false);   // nothing changed
  assert.equal(M.recordRevision("2026-10-13", ist(9, 35), changed, "5-min re-evaluation"), true);
  const r = M.readDay("2026-10-13");
  assert.equal(r.revisions.length, 1); assert.deepEqual(r.revisions[0].changes.map((c) => c.key), ["crude"]);
  assert.equal(M.recordRevision("2026-10-13", ist(9, 40), changed, "major news: RBI"), true);   // news always logged
});
