import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, onTick, breakMessage, summaryMessage } from "./dayRangeAlerts";

const T = (hm: string) => Math.floor(Date.parse(`2026-10-14T${hm}:00Z`) / 1000) - 19800;

test("no alert before 09:30 or while the high is being made; alert when a high that stood 10 min is broken", () => {
  const st = newState();
  assert.equal(onTick(st, T("09:15"), 100), null);
  assert.equal(onTick(st, T("09:20"), 110), null);           // new high, but before 09:30 and not standing
  for (let m = 21; m <= 35; m++) onTick(st, T(`09:${m}`), 105);
  const ev = onTick(st, T("09:36"), 112)!;                     // 110 set at 09:20, stood 16 min
  assert.equal(ev.side, "HIGH"); assert.equal(ev.level, 110); assert.equal(ev.by, 2);
  assert.equal(onTick(st, T("09:40"), 108), null);
});
test("trending market: each fresh high does not re-alert; cooldown 15 min per side", () => {
  const st = newState();
  for (let m = 15; m <= 40; m++) onTick(st, T(`09:${m}`), 100);
  assert.ok(onTick(st, T("09:41"), 105));                      // breaks 100 (stood since 09:15)
  assert.equal(onTick(st, T("09:42"), 106), null);             // new high only 1 min old
  for (let m = 43; m <= 54; m++) onTick(st, T(`09:${m}`), 104);
  assert.equal(onTick(st, T("09:55"), 107), null);             // 106 stood 13 min but cooldown (14 min since 09:41); 107 is the new high
  for (let m = 56; m <= 59; m++) onTick(st, T(`09:${m}`), 104);
  for (let m = 0; m <= 5; m++) onTick(st, T(`10:0${m}`), 104);
  assert.ok(onTick(st, T("10:06"), 109));                      // 107 stood 11 min, cooldown over
});
test("low break and the exchange's day low are respected", () => {
  const st = newState();
  onTick(st, T("09:15"), 100, 101, 95);                        // exchange low 95 before our first tick
  for (let m = 16; m <= 31; m++) onTick(st, T(`09:${m}`), 99);
  const ev = onTick(st, T("09:32"), 94)!;
  assert.equal(ev.side, "LOW"); assert.equal(ev.level, 95);
});
test("messages carry levels", () => {
  const m = breakMessage("NIFTY 50", { side: "HIGH", level: 22750, levelAt: T("10:42"), price: 22768, by: 18 }, { support: 22700, resistance: 22800, resistanceOi: 3719885, nextResistance: 23000, pcr: 1.38, pcrLabel: "BULLISH" });
  assert.match(m, /HIGH 22,750 \(set 10:42\) BROKEN/); assert.match(m, /Next resistance: 22,800 \(37\.2 L OI\), then 23,000/);
  const s = summaryMessage([{ name: "NIFTY 50", price: 22721, high: 22750, low: 22600, changePct: 0.4, lv: { support: 22700, resistance: 22800, pcr: 1.38, pcrLabel: "BULLISH" } }], "09:30");
  assert.match(s, /Day H 22,750 · L 22,600/);
});
