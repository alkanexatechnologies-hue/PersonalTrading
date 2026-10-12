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

import { parseMinuteLog } from "./minuteMonitor";
test("minute OI log: parsed per index, chain age sets Dhan fetch time, repeated chains dropped", () => {
  const sum = "date,timeIST,symbol,index,spot,expiry,chainAgeSec,pcr,totalCeOi,totalPeOi,ceChgTotal,peChgTotal,support,resistance,maxPain\n"
    + "2026-10-12,09:15,^NSEI,NIFTY,22600,2026-10-13,0,1.2,0,0,0,0,0,0,22500\n2026-10-12,09:16,^NSEI,NIFTY,22610,2026-10-13,60,1.2,0,0,0,0,0,0,22500\n2026-10-12,09:17,^NSEI,NIFTY,22620,2026-10-13,5,1.3,0,0,0,0,0,0,22500\n2026-10-12,09:15,^NSEBANK,BANKNIFTY,55000,2026-10-27,0,1,0,0,0,0,0,0,55000\n";
  const hdr = "date,timeIST,index,spot,strike,distFromSpot,ceOi,ceChg,ceVol,ceLtp,ceIv,ceDelta,peOi,peChg,peVol,peLtp,peIv,peDelta\n";
  const row = (t: string, k: number, ce: number) => `2026-10-12,${t},NIFTY,22600,${k},0,${ce},0,10,50,0,0,1000,0,10,60,0,0\n`;
  const str = hdr + [22550, 22600, 22650].map((k) => row("09:15", k, 1000)).join("") + [22550, 22600, 22650].map((k) => row("09:16", k, 1000)).join("") + [22550, 22600, 22650].map((k) => row("09:17", k, 1500)).join("");
  const r = parseMinuteLog("^NSEI", sum, str);
  assert.deepEqual(r.snaps.map((s) => s.minute), ["09:15", "09:17"]);   // 09:16 = same chain (fetched 60 s earlier)
  assert.equal(r.stats.SAME_FETCH, 1);
  assert.equal(r.snaps[1].providerT, r.snaps[1].captureT - 5);
  assert.equal(r.snaps[0].source, "minute-log"); assert.equal(r.snaps[0].expiry, "2026-10-13");
});

import { marketRead } from "./minuteMonitor";
test("market read: put writing leans up, call writing leans down, big two-sided exits = closing", () => {
  const mk = (ce: (k: number, m: number) => number, pe: (k: number, m: number) => number, cl: (m: number) => number, pl: (m: number) => number, spot: (m: number) => number) =>
    [0, 5, 10, 15].map((m) => snap(T0 + m * 60, (k) => [ce(k, m), pe(k, m)], () => [cl(m), pl(m)], spot(m)));
  const up = marketRead(mk(() => 10000, (k, m) => 10000 + m * 800, () => 100, (m) => 100 - m, (m) => 22350 + m), 50) as any;
  assert.equal(up.lean, "UP"); assert.equal(up.spotAgrees, true); assert.equal(up.supportWritten.strike != null, true);
  const dn = marketRead(mk((k, m) => 10000 + m * 800, () => 10000, (m) => 100 - m, () => 100, (m) => 22350 + m), 50) as any;
  assert.equal(dn.lean, "DOWN"); assert.equal(dn.spotAgrees, false);
  const cls = marketRead(mk((k, m) => 50000 - m * 2000, (k, m) => (k === 22250 ? 50000 + m * 10 : 50000 - m * 2000), () => 100, (m) => 100 - m, () => 22350), 50) as any;
  assert.equal(cls.lean, "POSITIONS CLOSING");
  assert.equal(up.speed.ce.length > 0 || up.speed.pe.length > 0, true);
  assert.match(up.caveat, /not back-tested/);
});

test("session window 09:15–15:12: later minutes are not stored or shown", () => {
  const late = Math.floor(Date.parse("2026-10-13T09:45:05Z") / 1000);   // 15:15 IST
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oimw-"));
  assert.deepEqual(recordSnapshot(snap(late, () => [1, 1]), root), { ok: false, reason: "OUTSIDE_WINDOW" });
  const v: any = buildView([snap(T0, () => [10000, 10000]), snap(T0 + 60, () => [10100, 10000]), snap(late, () => [20000, 10000])], { windowMin: 1, nowSec: late });
  assert.equal(v.samples, 2); assert.equal(v.window.curMinute, istMinute(T0 + 60));
});
