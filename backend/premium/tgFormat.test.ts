import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, bestFor, htmlify, bestOpportunityMsg } from "./tgFormat";
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
