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

import { hotMessage } from "./dayRangeAlerts";
test("hourly hot-premium message: verdict first, best call / put with buy zone, sell zone and the tested % chances", () => {
  const row = (strike: number, side: "CE" | "PE", stars: number, pass: number, state: string) => ({ strike, side, money: "OTM", rank: 1, hot: false, ltp: 87, atTarget: 173.9, upPct: 99, riskPct: 58, rr: 1.7, liq: "GOOD", spreadPct: 1.1, delta: 0.34,
    levels: { support: [{ price: 80.1, touches: 2 }], resistance: [{ price: 98, touches: 1 }], state: "MID-RANGE" }, rating: { stars, passPct: pass, failPct: 44, state, support: 80.1, resistance: 98 } });
  const m = hotMessage({ name: "NIFTY 50", spot: 22811, ceTarget: 23094, peTarget: 22800, ceFrom: "plan T1", peFrom: "plan T1",
    ce: [row(23000, "CE", 2, 12, "MID-RANGE"), row(23050, "CE", 5, 42, "BOUNCING")], pe: [row(22600, "PE", 3, 37, "AT SUPPORT")], label: "11:00 IST" });
  assert.match(m, /👉 OPPORTUNITY: 23050 CE is moving up from its support ₹80\.1 — 42% chance to break ₹98/);
  assert.match(m, /📈 BEST CALL: 23050 CE @ ₹87  ★★★★★/); assert.match(m, /Buy zone \(support\): ₹80\.1  ·  Sell zone \(resistance\): ₹98/);
  assert.match(m, /✅ Chance to break resistance: 42%   ❌ Support breaks first: 44%/); assert.match(m, /Other calls \(strike · price · chance\): 23000 ₹87 12%/);
  const w = hotMessage({ name: "SENSEX", spot: 73710, ceTarget: 74518, peTarget: 73229, ceFrom: "plan T1", peFrom: "plan T1", ce: [row(74000, "CE", 2, 33, "MID-RANGE")], pe: [], label: "11:00 IST" });
  assert.match(w, /👉 WAIT/); assert.match(w, /BEST PUT: none/); assert.ok(m.length < 3800);
});

import { oi15Message } from "./dayRangeAlerts";
test("15-min OI update: NIFTY and SENSEX in one message, total call / put OI, PCR, last 15 min, today, walls and the read", () => {
  const it = (name: string, spot: number) => ({ name, spot, label: "11:15 IST", pcr: 0.88, pcrBefore: 0.86, hourMin: 15, hour: { ce: 210000, pe: 450000, tilt: 68, top: null }, today: { ce: 6500000, pe: 4000000, tilt: 38 },
    totalCeL: 1457.3, totalPeL: 1276.9, bias: "BEARISH", biasWhy: "call writers are adding more", callWall: { strike: spot + 50, oiL: 96.8, state: "STRENGTHENING", pct: 5.2, shiftedFrom: null }, putWall: { strike: spot - 150, oiL: 42.9, state: "WEAKENING", pct: -3.4, shiftedFrom: null },
    majorCall: null, majorPut: null, movers: [] });
  const m = oi15Message([it("NIFTY 50", 22950), it("SENSEX", 73900)], "11:15 IST");
  assert.match(m, /📊 OI UPDATE · 11:15 IST/); assert.match(m, /━━ NIFTY 50 22,950 ━━\nTotal OI: Calls 1457\.3L · Puts 1276\.9L · PCR 0\.88 \(15 min ago 0\.86\)/);
  assert.match(m, /Last 15 min: Calls \+2\.1L · Puts \+4\.5L → Bulls 68% · Bears 32%/); assert.match(m, /Today: Calls \+65\.0L · Puts \+40\.0L/);
  assert.match(m, /🧱 Call wall 23,000 · 96\.8L · STRENGTHENING \(\+5\.2%\)/); assert.match(m, /━━ SENSEX 73,900 ━━/); assert.ok(m.indexOf("NIFTY") < m.indexOf("SENSEX"));
});
