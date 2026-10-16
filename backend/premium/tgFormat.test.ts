import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, bestFor, htmlify, bestOpportunityMsg, nextDayPlanMsg } from "./tgFormat";
const d = (o: any = {}) => ({ available: true, symbol: "^NSEI", name: "NIFTY 50", spot: { price: 23000, change: 100, changePct: 0.44, high: 23050, low: 22900 }, ranking: [],
  trader: { coach: { action: "WAIT" }, plans: { bull: { entry: 23060, stop: 23040, t1: 23100, rr: 2, strike: 23050, premNow: 120, triggerRisk: { risk: "LOW" } }, bear: { entry: 22890, stop: 22910, t1: 22850, rr: 2, strike: 22900, premNow: 110, triggerRisk: { risk: "HIGH" } } },
    radar: { bull: { state: "APPROACHING", distAtr: 0.2, distPts: 8 }, bear: { state: "IDLE", distAtr: 2, distPts: 110 } } }, ...o });
test("escaping, best pick (trade > triggered > armed > approaching > idle), html fallback-safe markup", () => {
  assert.equal(esc("R:R < 1.5 & up"), "R:R &lt; 1.5 &amp; up");
  const m = Math.floor(((Math.floor(Date.now() / 1000) + 19800) % 86400) / 60);
  if (m >= 570 && m <= 885) assert.equal((bestFor(d(), null) as any).side, "bull"); else assert.equal(bestFor(d(), null)!.kind, "NONE");   // late session: no new buy
  assert.equal(bestFor(d(), { state: "OPEN", strike: 1, side: "CE" })!.kind, "TRADE");
  const msg = bestOpportunityMsg([{ d: d(), trade: null, eye: { upPct: 20, sidePct: 50, downPct: 30, lead: "SIDEWAYS" }, zh: null }]);
  assert.match(msg, /BEST OPPORTUNITY/); assert.match(msg, /SIDEWAYS/); assert.ok(!/<(?!\/?(b|i)>)/.test(msg.replace(/<\/?(b|i)>/g, "")));
  assert.match(htmlify("🎯 TITLE\n  → do <this>"), /^<b>🎯 TITLE<\/b>\n<b>→ do &lt;this&gt;<\/b>$/);
});
test("next-day plan: date, both sides with SL/targets/risk, nearest levels, expired-premium fallback, expiry flag", () => {
  const x = d({ expiry: "2026-10-16" });
  x.trader.planFor = "2026-10-16"; x.trader.plans.noTrade = { from: 22890, to: 23060 };
  x.trader.plans.bull.premNow = 0.05;
  x.trader.levels = [{ price: 23157, label: "R1 pivot" }, { price: 22897, label: "Pivot <PP>" }, { price: 24000, label: "Major call OI" }];
  x.trader.tomorrow = { scenarios: ["Gap-up above 23060: wait"] };
  const m = nextDayPlanMsg([{ d: x, odds: "no proven edge" }]);
  assert.match(m, /NEXT-DAY PLAN<\/b> · for <b>2026-10-16/);
  assert.match(m, /BULL<\/b> 15-min close above <b>23,060<\/b> → 23050 CE \(premium at the open\)/);
  assert.match(m, /BEAR<\/b> 15-min close below <b>22,890<\/b> → 22900 PE \(₹110\)/);
  assert.match(m, /risk <b>HIGH<\/b>/);
  assert.match(m, /⬆ 23,157 <i>R1 pivot<\/i> · 24,000/);
  assert.match(m, /⬇ 22,897 <i>Pivot &lt;PP&gt;<\/i>/);
  assert.match(m, /No-trade zone 22,890 – 23,060/);
  assert.match(m, /Expiry day/);
  assert.match(nextDayPlanMsg([]), /Plan unavailable/);
});
test("emphasize: SL / targets / danger in bold, never nested inside existing bold", async () => {
  const { emphasize } = await import("./tgFormat");
  const m = emphasize("🎯 T1 23,157 · T2 23,316 · 🛑 SL 23,040 · risk HIGH\n  stop: 15-min close below 23,040\n  Target 1 23,157\n<b>SL 100 already bold</b> · day high 23,150");
  assert.match(m, /<b>T1 23,157<\/b>/); assert.match(m, /<b>T2 23,316<\/b>/); assert.match(m, /<b>🛑 SL 23,040<\/b>/);
  assert.match(m, /<b>risk HIGH<\/b>/); assert.match(m, /<b>stop: 15-min close below 23,040<\/b>/); assert.match(m, /<b>Target 1 23,157<\/b>/);
  assert.ok(!/<b>[^<]*<b>/.test(m), "no nested bold"); assert.match(m, /day high 23,150$/);
  assert.equal(emphasize("T1 done, stop at breakeven"), "T1 done, stop at breakeven");
  assert.match(emphasize("⚠️ NIFTY BULL FAILED — stand aside"), /^<b>⚠️ NIFTY BULL FAILED — stand aside<\/b>$/);
});
