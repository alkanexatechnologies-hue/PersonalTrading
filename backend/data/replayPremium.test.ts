import { test } from "node:test";
import assert from "node:assert/strict";
import { coveringFile, legsOf, aggregate, atmOf, sameContract, istDay, Raw } from "./replayPremium";

// 2026-10-23 09:15 IST = 03:45 UTC
const T915 = Date.UTC(2026, 9, 23, 3, 45) / 1000;
const raw = (rows: [number, number, number, number][]): Raw => ({   // [minute offset, strike, close, spot]
  timestamp: rows.map((r) => T915 + r[0] * 60), open: rows.map((r) => r[2]), high: rows.map((r) => r[2] + 1), low: rows.map((r) => r[2] - 1),
  close: rows.map((r) => r[2]), strike: rows.map((r) => r[1]), spot: rows.map((r) => r[3]), volume: rows.map(() => 10),
});

test("covering file: picks the month chunk whose range holds the day, by side and strike offset", () => {
  const files = ["2026-09-01_2026-09-30_CE_0.json", "2026-10-01_2026-10-23_CE_0.json", "2026-10-01_2026-10-23_PE_0.json", "2026-10-01_2026-10-23_CE_-2.json", "notes.txt"];
  assert.equal(coveringFile(files, "2026-10-23", "CE", 0), "2026-10-01_2026-10-23_CE_0.json");
  assert.equal(coveringFile(files, "2026-09-15", "CE", 0), "2026-09-01_2026-09-30_CE_0.json");
  assert.equal(coveringFile(files, "2026-10-23", "CE", -2), "2026-10-01_2026-10-23_CE_-2.json");
  assert.equal(coveringFile(files, "2026-10-24", "CE", 0), null, "after the cache → fetch");
  assert.equal(coveringFile(files, "2026-10-10", "PE", 1), null);
});

test("legs: one series per absolute strike, the day only, 09:15–15:30, first bar wins on a duplicate minute", () => {
  const a = raw([[0, 73100, 650, 73120], [1, 73100, 655, 73125], [2, 73200, 600, 73160]]);   // ATM rolls 73100 → 73200
  const b = raw([[1, 73100, 999, 73125], [3, 73200, 610, 73170]]);                            // duplicate minute for 73100 → ignored
  const prevDay = raw([[-1440, 73100, 500, 73000]]);                                           // the day before → dropped
  const late = raw([[380, 73100, 700, 73100]]);                                                // 15:35 → dropped
  const { legs, spot } = legsOf([a, b, prevDay, late], "2026-10-23");
  assert.deepEqual([...legs.keys()].sort(), [73100, 73200]);
  assert.deepEqual(legs.get(73100)!.map((x) => x.close), [650, 655]);
  assert.deepEqual(legs.get(73200)!.map((x) => x.close), [600, 610]);
  assert.equal(spot.size, 4);
});

test("aggregate: 5-minute candles anchored at 09:15 with O/H/L/C/volume", () => {
  const bars = Array.from({ length: 12 }, (_, i) => ({ time: T915 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 }));
  const c5 = aggregate(bars, 5);
  assert.equal(c5.length, 3);
  assert.deepEqual([c5[0].time, c5[0].open, c5[0].high, c5[0].low, c5[0].close, c5[0].volume], [T915, 100, 105, 99, 104.5, 50]);
  assert.equal(c5[1].time, T915 + 300);
  assert.equal(c5[2].close, 111.5);
  assert.equal(istDay(c5[0].time), "2026-10-23");
});

test("ATM at the day's last spot, rounded to the strike step", () => {
  const s = new Map([[1, 73080], [3, 73140], [2, 72990]]);
  assert.equal(atmOf(s, 100), 73100);
  assert.equal(atmOf(new Map([[1, 22618]]), 50), 22600);
  assert.equal(atmOf(new Map(), 50), null);
});

test("same contract: the previous session is joined only without an expiry roll", () => {
  assert.equal(sameContract(600, 640), true);
  assert.equal(sameContract(120, 640), false, "expiring weekly straddle ≪ next weekly's");
  assert.equal(sameContract(null, 640), false);
});
