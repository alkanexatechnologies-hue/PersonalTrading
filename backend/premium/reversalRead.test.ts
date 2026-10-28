import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, judge, readReversals } from "./reversalRead";

const t0 = Date.parse("2026-10-28T09:15:00+05:30") / 1000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: t0 + i * 900, open: o, high: h, low: l, close: c });
// a fall of 3 candles, a hammer at the low, then a rise (real) — and the same start followed by a close below the low (fake)
const fall = [bar(0, 1100, 1102, 1080, 1082), bar(1, 1082, 1084, 1060, 1062), bar(2, 1062, 1064, 1040, 1042)];
const hammer = bar(3, 1030, 1040, 1010, 1038);   // new low, long lower wick, green close near the top

test("a hammer after a fall is a bullish reversal candidate; the 3-candle prior move is measured", () => {
  const c = candidate([...fall, hammer], 3, 20);
  assert.equal(c?.dir, "UP"); assert.equal(c?.pattern, "Hammer"); assert.equal(c?.priorMove, 60);
  assert.equal(candidate([...fall, bar(3, 1042, 1046, 1038, 1040)], 3, 20), null);   // no new low / red close → not a reversal
});

test("judge: real when it travels 1 typical range up first; fake when a close goes back below the low; pending while live", () => {
  const real = [...fall, hammer, bar(4, 1038, 1050, 1035, 1048), bar(5, 1048, 1062, 1046, 1060)];
  assert.deepEqual(judge(real, 3, "UP", 20), { status: "REAL", after: 24 });
  const fake = [...fall, hammer, bar(4, 1038, 1042, 1020, 1022), bar(5, 1022, 1024, 1000, 1005)];
  assert.equal(judge(fake, 3, "UP", 20).status, "FAKE");
  assert.equal(judge([...fall, hammer, bar(4, 1038, 1045, 1030, 1040)], 3, "UP", 20).status, "PENDING");
  const side = [...fall, hammer, ...[4, 5, 6, 7].map((i) => bar(i, 1038, 1045, 1030, 1039))];
  assert.equal(judge(side, 3, "UP", 20).status, "WEAK");
});

test("readReversals names the nearby level and writes the Hindi reading", () => {
  const fake = [...fall, hammer, bar(4, 1038, 1042, 1020, 1022), bar(5, 1022, 1024, 1000, 1005)];
  const r = readReversals(fake, 20, [{ label: "कल का Low", price: 1012 }]);
  assert.equal(r.length, 1); assert.equal(r[0].status, "FAKE"); assert.equal(r[0].level?.label, "कल का Low");
  assert.match(r[0].text, /Hammer — कल का Low 1,012 पर.*पलटाव झूठा/);
});
