import { test } from "node:test";
import assert from "node:assert/strict";
import { lunchStats, lunchCautionMsg } from "./lunchWindow";

// synthetic sessions: 75 five-minute bars from 09:15 IST; noon→2pm drop of `drop` points
const session = (dayStartUtc: number, open: number, morning: number, drop: number) => Array.from({ length: 75 }, (_, i) => {
  const t = dayStartUtc + 3 * 3600 + 45 * 60 + i * 300, m = 555 + i * 5;
  const p = m < 720 ? open + (morning * (m - 555)) / 165 : m < 840 ? open + morning - (drop * (m - 720)) / 120 : open + morning - drop;
  return { time: t, open: p, high: p + 2, low: p - 2, close: p };
});
const D = (k: number) => Date.UTC(2026, 9, 1 + k) / 1000;

test("lunch stats: closed lower count, morning split, deep-dip recovery; caution text is a warning only", () => {
  const bars = [...session(D(0), 23000, 50, 40), ...session(D(1), 23000, -50, 80), ...session(D(2), 23000, 30, -20), ...session(D(3), 23000, -30, 10), ...session(D(4), 23000, 40, 0)];
  const st = lunchStats(bars, "2026-10-05");   // the 5th session is "today"
  assert.equal(st.sessions, 4); assert.equal(st.last15.down, 3);
  assert.equal(st.downMorning.n, 2); assert.equal(st.downMorning.down, 2); assert.equal(st.upMorning.down, 1);
  assert.ok(Math.abs(st.today!.morning! - 40) < 2);   // 12:00 = close of the 11:55 bar
  const m = lunchCautionMsg("NIFTY 50", st);
  assert.match(m, /NIFTY · 12:00–14:00 CAUTION<\/b> <i>\(warning only — plans and rules unchanged\)/);
  assert.match(m, /<b>UP morning<\/b>/); assert.match(m, /closed lower <b>3\/4<\/b>/); assert.match(m, /After an UP morning \(4 sessions\): lower <b>1\/2 \(50%\)<\/b>/);
  assert.match(m, /not a forecast/);
});
