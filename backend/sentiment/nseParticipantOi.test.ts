import { test } from "node:test";
import assert from "node:assert/strict";
import { parseParticipantCsv, candidateDates } from "./nseParticipantOi";
import { classifyFiiLegs, enrichFiiRows, fiiLeanOf } from "./fiiFutures";

// Real NSE file for 09 Oct 2026 (fao_participant_oi_09102026.csv).
const CSV = `""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 09, 2026"",,,,,,,,,,,,,,
Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts      ,Total Short Contracts
Client,291627,62104,3402919,185348,3396080,3418874,3337345,4049875,2104606,822867,1206045,1081989,13436973,9922706
DII,48096,16166,289466,4646105,90783,62924,3788,1452,12110,43691,349667,34218,547070,5051396
FII,34943,328931,3542863,2867395,600034,1245164,946852,704672,197429,316370,347630,186717,5936804,5382197
Pro,64003,31468,833668,370068,1317359,1294501,1116272,1265464,916553,1011209,1327356,891213,5437293,5001841
TOTAL,438669,438669,8068916,8068916,5404257,6021463,5404257,6021463,3230698,2194137,3230698,2194137,25358140,25358140`;

test("parses the real NSE participant file by column name", () => {
  const { day } = parseParticipantCsv(CSV, "2026-10-09");
  assert.ok(day);
  assert.deepEqual(day!.fut.FII, { long: 34943, short: 328931 });
  assert.deepEqual(day!.fut.Client, { long: 291627, short: 62104 });
  assert.deepEqual(day!.opt.FII, { callLong: 600034, callShort: 946852, putLong: 1245164, putShort: 704672 });
});

test("rejects a file whose title date differs from the requested date", () => {
  const r = parseParticipantCsv(CSV, "2026-10-08");
  assert.equal(r.day, null); assert.match(r.reason || "", /title date/);
});

test("rejects a file that does not balance", () => {
  const bad = CSV.replace("FII,34943,", "FII,34944,");
  assert.equal(parseParticipantCsv(bad, "2026-10-09").day, null);
  const unbal = CSV.replace("TOTAL,438669,438669", "TOTAL,438669,438670");
  assert.match(parseParticipantCsv(unbal, "2026-10-09").reason || "", /long ≠ short/);
});

test("rejects missing rows and non-numeric cells", () => {
  assert.equal(parseParticipantCsv(CSV.replace(/\nDII,[^\n]+/, ""), "2026-10-09").day, null);
  assert.equal(parseParticipantCsv(CSV.replace("Pro,64003", "Pro,abc"), "2026-10-09").day, null);
  assert.equal(parseParticipantCsv("<html>blocked</html>", "2026-10-09").day, null);
});

test("candidate dates skip weekends and include today only after 18:00 IST", () => {
  const ist = (y: number, m: number, d: number, hh: number) => Math.floor(Date.UTC(y, m - 1, d, hh) / 1000) - 19800;
  assert.deepEqual(candidateDates(ist(2026, 10, 11, 21), 3), ["2026-10-09", "2026-10-08", "2026-10-07"]);   // Sunday
  assert.equal(candidateDates(ist(2026, 10, 12, 17), 1)[0], "2026-10-09");   // Monday before the file
  assert.equal(candidateDates(ist(2026, 10, 12, 19), 1)[0], "2026-10-12");   // Monday evening
});

test("classifyFiiLegs uses the leg that moved more", () => {
  assert.equal(classifyFiiLegs(5000, 1000), "LONG BUILDUP");
  assert.equal(classifyFiiLegs(-6000, 2000), "LONG UNWINDING");
  assert.equal(classifyFiiLegs(1000, 12000), "SHORT BUILDUP");
  assert.equal(classifyFiiLegs(-500, -9000), "SHORT COVERING");
  assert.equal(classifyFiiLegs(400, -800), "NEUTRAL");
});

test("enrichFiiRows classifies from legs when both days have them", () => {
  const rows = enrichFiiRows([
    { date: "2026-10-08", longQty: 40000, shortQty: 320000 },
    { date: "2026-10-09", longQty: 34943, shortQty: 328931 },
  ]);
  assert.equal(rows[0].positionType, null);            // no prior day → no guess
  assert.equal(rows[1].positionType, "SHORT BUILDUP"); // shorts +8,931 vs longs −5,057
  assert.equal(rows[1].longPct, 9.6);
});

test("fiiLeanOf weighs position level and 5-day trend", () => {
  const rows = (longPct: number) => [{ longPct } as any];
  assert.equal(fiiLeanOf({ available: true, pressure: "UPWARD", rows: rows(9.6) }), -0.1);   // covering but ~90% short
  assert.equal(fiiLeanOf({ available: true, pressure: "DOWNWARD", rows: rows(9.6) }), -0.7);
  assert.equal(fiiLeanOf({ available: true, pressure: "UPWARD", rows: rows(70) }), 0.5);
  assert.equal(fiiLeanOf({ available: false, pressure: null, rows: [] }), null);
});
