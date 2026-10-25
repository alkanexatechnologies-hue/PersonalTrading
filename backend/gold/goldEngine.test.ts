import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { goldContracts, optionExpiries, underlyingFuture, frontFuture, strikesFor, atmStrike, optionAt, goldSession, goldLevels, levelPlan, vwapOf, expiryInfo } from "./goldEngine";

const CSV = [
  "EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE",
  "MCX,M,571445,NA,FUTCOM,117,GOLDM,GOLDM,GOLDM NOV FUT,FUTCOM,2,1.0,2026-11-05,0,XX",
  "MCX,M,575011,NA,FUTCOM,117,GOLDM,GOLDM,GOLDM DEC FUT,FUTCOM,2,1.0,2026-12-04,0,XX",
  "MCX,M,1,NA,OPTFUT,117,GOLDM,GOLDM,GOLDM 29 OCT 140000 CALL,OPTFUT,2,1.0,2026-10-29,140000,CE",
  "MCX,M,2,NA,OPTFUT,117,GOLDM,GOLDM,GOLDM 29 OCT 140500 CALL,OPTFUT,2,1.0,2026-10-29,140500,CE",
  "MCX,M,3,NA,OPTFUT,117,GOLDM,GOLDM,GOLDM 29 OCT 140500 PUT,OPTFUT,2,1.0,2026-10-29,140500,PE",
  "MCX,M,4,NA,OPTFUT,117,GOLDM,GOLDM,GOLDM 27 NOV 141000 CALL,OPTFUT,2,1.0,2026-11-27,141000,CE",
  "MCX,M,9,NA,FUTCOM,1,CRUDEOIL,CRUDEOIL,CRUDEOIL NOV FUT,FUTCOM,2,1.0,2026-11-19,0,XX",
  "NSE,D,5,NA,OPTIDX,13,NIFTY,NIFTY,NIFTY 27 OCT 22600 CALL,OPTIDX,2,75,2026-10-27,22600,CE",
].join("\n");

test("goldContracts reads only MCX GOLD / GOLDM futures and options", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gold-")), "i.csv"); fs.writeFileSync(f, CSV);
  const rows = goldContracts(f);
  assert.equal(rows.length, 6);
  assert.deepEqual(optionExpiries(rows, "GOLDM", "2026-10-25"), ["2026-10-29", "2026-11-27"]);
  assert.equal(underlyingFuture(rows, "GOLDM", "2026-10-29")!.name, "GOLDM NOV FUT");     // options expire before their future
  assert.equal(underlyingFuture(rows, "GOLDM", "2026-11-27")!.name, "GOLDM DEC FUT");
  assert.equal(frontFuture(rows, "GOLDM", "2026-11-06")!.name, "GOLDM DEC FUT");
  assert.deepEqual(strikesFor(rows, "GOLDM", "2026-10-29"), [140000, 140500]);
  assert.equal(atmStrike([140000, 140500, 141000], 140611), 140500);
  assert.equal(optionAt(rows, "GOLDM", "2026-10-29", 140500, "PE")!.securityId, "3");
});

test("goldSession: IST hours follow the UK / US clock changes", () => {
  const at = (d: string, hm = "12:00") => goldSession(Date.parse(`${d}T${hm}:00+05:30`));
  assert.deepEqual([at("2026-10-23").close, at("2026-10-23").london, at("2026-10-23").usData], [1410, 750, 1080]);   // 23:30 · 12:30 · 18:00
  assert.deepEqual([at("2026-10-26").close, at("2026-10-26").london, at("2026-10-26").usData], [1410, 810, 1080]);   // UK changed 25 Oct
  assert.deepEqual([at("2026-11-02").close, at("2026-11-02").usData], [1435, 1140]);                                // US changed 1 Nov
  assert.equal(at("2026-10-23", "08:59").open, false); assert.equal(at("2026-10-23", "09:00").open, true);
  assert.equal(at("2026-10-23", "23:29").open, true); assert.equal(at("2026-10-23", "23:30").open, false);
  assert.equal(at("2026-10-25").open, false);                                                                        // Sunday
});

const T = (d: string, hm: string) => Date.parse(`${d}T${hm}:00+05:30`) / 1000;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 10) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });

test("goldLevels: previous session, pivots, first hour only after 10:00, VWAP", () => {
  const bars = [bar(T("2026-10-22", "09:00"), 100000, 100900, 99800, 100500), bar(T("2026-10-22", "23:25"), 100500, 101000, 100400, 100800),
    bar(T("2026-10-23", "09:00"), 100800, 101200, 100700, 101100), bar(T("2026-10-23", "09:55"), 101100, 101300, 100600, 100700)];
  const early = goldLevels(bars.slice(0, 3), T("2026-10-23", "09:30"));
  assert.equal(early.pdh, 101000); assert.equal(early.pdl, 99800); assert.equal(early.pdc, 100800);
  assert.ok(!early.levels.some((l) => /First-hour/.test(l.label)), "first hour not finished");
  const later = goldLevels(bars, T("2026-10-23", "10:05"));
  assert.ok(later.levels.some((l) => /First-hour H/.test(l.label) && l.price === 101300));
  assert.ok(later.levels.some((l) => /First-hour L/.test(l.label) && l.price === 100600));
  assert.ok(Math.abs(vwapOf(bars.slice(2))! - ((101200 + 100700 + 101100) / 3 + (101300 + 100600 + 100700) / 3) / 2) < 1e-6);
  const p = levelPlan(later.levels, later.last)!;
  assert.ok(p.bull!.start > later.last! && p.bull!.stop < later.last! && p.bull!.t1 > p.bull!.start);
  assert.ok(p.bear!.start < later.last! && p.bear!.stop > later.last! && p.bear!.t1 < p.bear!.start);
  assert.equal(p.bull!.rr, Math.round(((p.bull!.t1 - p.bull!.start) / (p.bull!.start - p.bull!.stop)) * 100) / 100);
});

test("expiryInfo counts days to the expiry-day close", () => {
  assert.equal(expiryInfo("2026-10-29", Date.parse("2026-10-25T12:00:00+05:30")).daysLeft, 5);
  assert.equal(expiryInfo("2026-10-29", Date.parse("2026-10-28T12:00:00+05:30")).nearExpiry, true);
});
