import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { acceptSnapshot, recordSnapshot, loadDay, pickPrevious, legChanges, classify, topAdditions, minuteTimeline, buildView, snapFromChain, istMinute, type MinuteSnap } from "./minuteMonitor";

const T0 = Math.floor(Date.parse("2026-10-13T04:10:05Z") / 1000);   // 09:40:05 IST
const snap = (t: number, oi: (k: number) => [number, number], ltp: (k: number) => [number, number] = () => [100, 100], spot = 22350, over: Partial<MinuteSnap> = {}): MinuteSnap => ({
  symbol: "^NSEI", expiry: "2026-10-27", providerT: t - 1, captureT: t, minute: istMinute(t), spot, pcr: 0.9, maxPain: 22350,
  strikes: [22250, 22300, 22350, 22400, 22450].map((k) => ({ strike: k, ceOi: oi(k)[0], peOi: oi(k)[1], ceLtp: ltp(k)[0], peLtp: ltp(k)[1], ceVol: 1000, peVol: 1000 })),
  ...over,
});

test("OI change and % from the previous 1-minute snapshot", () => {
  const a = snap(T0, () => [10000, 20000]), b = snap(T0 + 60, (k) => (k === 22400 ? [12500, 20000] : [10000, 19000]), (k) => (k === 22400 ? [90, 100] : [100, 100]));
  const p = pickPrevious([a, b], 1, 1);
  assert.equal(p.aligned, true); assert.equal(p.actualSec, 60);
  const r = legChanges(p).find((x) => x.strike === 22400 && x.side === "CE")!;
  assert.equal(r.oiChg, 2500); assert.equal(r.oiChgPct, 25); assert.equal(r.ltpChgPct, -10);
  const pe = legChanges(p).find((x) => x.strike === 22300 && x.side === "PE")!;
  assert.equal(pe.oiChg, -1000); assert.equal(pe.oiChgPct, -5);
  assert.equal(topAdditions(legChanges(p), "CE")[0].strike, 22400);
});

test("previous OI of zero gives no percentage", () => {
  const a = snap(T0, () => [0, 0]), b = snap(T0 + 60, () => [500, 0]);
  const r = legChanges(pickPrevious([a, b], 1, 1)).find((x) => x.side === "CE")!;
  assert.equal(r.oiChg, 500); assert.equal(r.oiChgPct, null);
});

test("timestamp alignment: a 3-minute gap is never reported as a 1-minute change", () => {
  const a = snap(T0, () => [10000, 10000]), b = snap(T0 + 180, () => [11000, 10000]);
  const p = pickPrevious([a, b], 1, 1);
  assert.equal(p.aligned, false); assert.equal(p.actualSec, 180); assert.match(p.note, /Real interval 3m 0s/);
  // too-recent snapshot is never used as the 5-minute base
  const c = snap(T0 + 240, () => [11500, 10000]);
  const p5 = pickPrevious([a, b, c], 2, 5);
  assert.equal(p5.prev, null); assert.match(p5.note, /collecting/);
  const d = snap(T0 + 300, () => [12000, 10000]);
  const q5 = pickPrevious([a, b, c, d], 3, 5);
  assert.equal(q5.prev!.captureT, T0); assert.equal(q5.aligned, true);
});

test("missing minutes: the timeline marks unaligned pairs instead of inventing data", () => {
  const s = [snap(T0, () => [10000, 10000]), snap(T0 + 60, () => [10100, 10000]), snap(T0 + 240, () => [10400, 10000])];
  const tl = minuteTimeline(s);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].aligned, false); assert.equal(tl[0].actualSec, 180);
  assert.equal(tl[1].aligned, true); assert.equal(tl[1].callChg, 500);
});

test("duplicate and stale readings are rejected (no false additions)", () => {
  const a = snap(T0, () => [10000, 10000]);
  assert.deepEqual(acceptSnapshot(a, { ...a, captureT: T0 + 60, minute: istMinute(T0 + 60) }), { ok: false, reason: "SAME_FETCH" });
  assert.deepEqual(acceptSnapshot(a, snap(T0 + 20, () => [10100, 10000])), { ok: false, reason: "SAME_MINUTE" });
  assert.deepEqual(acceptSnapshot(a, snap(T0 + 60, () => [10000, 10000])), { ok: false, reason: "UNCHANGED_DATA" });
  assert.deepEqual(acceptSnapshot(a, snap(T0 + 60, () => [10000, 10000], () => [100, 100], 22350, { strikes: [] })), { ok: false, reason: "NO_STRIKES" });
  assert.deepEqual(acceptSnapshot(a, snap(T0 + 60, () => [10050, 10000])), { ok: true });
});

test("strike changes: new or missing strikes get a status, not a change", () => {
  const a = snap(T0, () => [10000, 10000]);
  const b = snap(T0 + 60, () => [10200, 10000]);
  b.strikes = b.strikes.filter((s) => s.strike !== 22250).concat([{ strike: 22500, ceOi: 9000, peOi: 1000, ceLtp: 50, peLtp: 200, ceVol: 1, peVol: 1 }]);
  const rows = legChanges(pickPrevious([a, b], 1, 1));
  const nw = rows.find((r) => r.strike === 22500 && r.side === "CE")!, gone = rows.find((r) => r.strike === 22250 && r.side === "CE")!;
  assert.equal(nw.status, "NEW STRIKE"); assert.equal(nw.oiChg, null);
  assert.equal(gone.status, "MISSING"); assert.equal(gone.oiChg, null);
  assert.ok(!topAdditions(rows, "CE").some((r) => r.strike === 22500));
});

test("expiry changes: snapshots of another expiry are never compared", () => {
  const a = snap(T0, () => [10000, 10000], undefined, 22350, { expiry: "2026-10-20" }), b = snap(T0 + 60, () => [12000, 10000]);
  const p = pickPrevious([a, b], 1, 1);
  assert.equal(p.prev, null);
  // storage is per expiry
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oimm-"));
  recordSnapshot(a, root); recordSnapshot(b, root);
  assert.equal(loadDay("2026-10-13", "^NSEI", "2026-10-20", root).length, 1);
  assert.equal(loadDay("2026-10-13", "^NSEI", "2026-10-27", root).length, 1);
});

test("classification combines OI, premium and spot", () => {
  assert.equal(classify("CE", 5000, 10, -8, 0).cls, "POSSIBLE WRITING");
  assert.match(classify("CE", 5000, 10, -8, 20).evidence.join(" "), /strong sign of selling/);
  assert.equal(classify("CE", 5000, 10, 6, 15).cls, "POSSIBLE LONG BUILDUP");
  assert.equal(classify("PE", 5000, 10, -6, 15).cls, "POSSIBLE WRITING");        // spot up pushes puts down: weaker evidence
  assert.match(classify("PE", 5000, 10, -6, 15).evidence.join(" "), /explains part/);
  assert.equal(classify("CE", -5000, -10, 5, 10).cls, "UNWINDING");
  assert.equal(classify("CE", 50, 0.2, -8, 0).cls, "INCONCLUSIVE");            // noise
  assert.equal(classify("CE", 5000, 10, 0.1, 0).cls, "INCONCLUSIVE");          // premium flat
  assert.equal(classify("CE", 5000, 10, null, 0).cls, "INCONCLUSIVE");         // no premium
});

test("volume change: a falling day volume is a reset, shown as unknown", () => {
  const a = snap(T0, () => [10000, 10000]), b = snap(T0 + 60, () => [10100, 10000]);
  b.strikes[0].ceVol = 10; a.strikes[0].ceVol = 500;
  const r = legChanges(pickPrevious([a, b], 1, 1)).find((x) => x.strike === 22250 && x.side === "CE")!;
  assert.equal(r.volChg, null);
});

test("view: replay index, clocks, summary and top-5", () => {
  const s = [0, 60, 120].map((d, i) => snap(T0 + d, (k) => [10000 + i * (k === 22450 ? 900 : 100), 10000 + i * 50], () => [100 - i, 100 + i]));
  const v: any = buildView(s, { windowMin: 1, nowSec: T0 + 125 });
  assert.equal(v.available, true); assert.equal(v.samples, 3); assert.equal(v.window.aligned, true);
  assert.equal(v.summary.maxCall.strike, 22450); assert.equal(v.topCE[0].cls, "POSSIBLE WRITING");
  assert.equal(v.clocks.captureT, T0 + 120); assert.equal(v.clocks.providerT, T0 + 119);
  const r: any = buildView(s, { windowMin: 1, atIdx: 1, nowSec: T0 + 125 });
  assert.equal(r.samples, 2); assert.equal(r.window.curMinute, istMinute(T0 + 60));
  assert.equal((buildView([], { windowMin: 1 }) as any).available, false);
});

test("snapshot from the shared chain object", () => {
  const s = snapFromChain("^NSEI", { expiry: "2026-10-27", asOf: T0, underlying: 22350, pcr: 0.9, maxPain: 22300, topStrikes: [{ strike: 22400, ceOi: 5, peOi: 6, ceLtp: 1, peLtp: 2, ceVol: null }] }, T0 + 2)!;
  assert.equal(s.providerT, T0); assert.equal(s.captureT, T0 + 2); assert.equal(s.strikes[0].ceVol, null);
  assert.equal(snapFromChain("^NSEI", { topStrikes: [] }, T0), null);
});
