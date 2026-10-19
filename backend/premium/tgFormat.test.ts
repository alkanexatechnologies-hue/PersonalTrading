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
  assert.match(msg, /BEST OPPORTUNITY · NIFTY/); assert.ok(!/</.test(msg.replace(/<\/?(b|i|pre)>/g, "")));
  if (!(m >= 570 && m <= 885)) assert.match(msg, /Senior trader:/);   // outside the entry window the "nothing to do" call is shown
  assert.match(htmlify("🎯 TITLE\n  → do <this>"), /^<b>🎯 TITLE<\/b>\n<b>→ do &lt;this&gt;<\/b>$/);
});
test("next-day plan: date, both sides with SL/targets/risk, nearest levels, expired-premium fallback, expiry flag", () => {
  const x = d({ expiry: "2026-10-16" });
  x.trader.planFor = "2026-10-16"; x.trader.plans.noTrade = { from: 22890, to: 23060 };
  x.trader.plans.bull.premNow = 0.05;
  x.trader.levels = [{ price: 23157, label: "R1 pivot" }, { price: 22897, label: "Pivot <PP>" }, { price: 24000, label: "Major call OI" }];
  x.trader.tomorrow = { scenarios: ["Gap-up above 23060: wait"] };
  const m = nextDayPlanMsg([{ d: x, odds: "no proven edge" }]);
  assert.match(m, /NEXT-DAY PLAN · NIFTY<\/b> · for <b>2026-10-16/);
  assert.match(m, /BULL PLAN<\/b>/); assert.match(m, /Starts on a 15-min close above <b>23,060<\/b>/);
  assert.match(m, /Buy <b>23050 CE<\/b> \(premium at the open\)/); assert.match(m, /Buy <b>22900 PE<\/b> \(now ₹110\)/);
  assert.match(m, /<pre>[\s\S]*Stop\s+23,040[\s\S]*Target 1\s+23,100[\s\S]*<\/pre>/);
  assert.match(m, /HIGH RISK/);
  assert.match(m, /⬆ 23,157 <i>R1 pivot<\/i> · 24,000/);
  assert.match(m, /⬇ 22,897 <i>Pivot &lt;PP&gt;<\/i>/);
  assert.match(m, /NO-TRADE ZONE<\/b> 22,890 – 23,060/);
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
test("trade card: trigger, Entry / Stop Loss / Target 1 / Target 2 with index → premium, delta line, short 5-min read", async () => {
  const { tradeCard, tradeAlert } = await import("./tgFormat");
  const x = d();
  Object.assign(x.trader.plans.bull, { t2: 23200, premAtEntry: 130, premAtStop: 122, premAtT1: 145, premAtT2: 190, delta: 0.42, triggerLabel: "Prev day high" });
  (x.trader as any).candles = { m5: { tf: "5-min", time: 1_792_144_500, tone: "bull", pattern: "BULLISH ENGULFING", shape: "bullish momentum candle (body 90%)", closeLoc: 95, at: "PDH 23,056" } };
  const L = tradeCard(x, "bull").join("\n");
  assert.match(L, /Trigger:<\/b> 15-min candle CLOSES above <b>23,060<\/b> · index now 23,000 \(60 pts away\)/);
  assert.match(L, /why this level: Prev day high/);
  assert.match(L, /<b>Entry: index 23,060<\/b> → CE ≈ ₹130/);
  assert.match(L, /<b>Stop Loss: index 23,040<\/b> <i>\(15-min close below\)<\/i> → CE ≈ ₹122 · −20 pts \/ −₹8/);
  assert.match(L, /<b>Target 1: index 23,100<\/b> → CE ≈ ₹145 · \+40 pts \/ \+₹15 · book half/);
  assert.match(L, /<b>Target 2: index 23,200<\/b> → CE ≈ ₹190 · \+140 pts \/ \+₹60/);
  assert.match(L, /Δ 0\.42: every 10 index pts ≈ ₹4\.2/);
  assert.match(L, /5-min 15:25 ▲ BULLISH ENGULFING · closed at 95% of its range · at PDH 23,056/);
  assert.match(tradeAlert(x, "bull", "TRIGGERED"), /NIFTY BULL TRIGGERED/);
});
test("plan board: screen layout, monospace table untouched by bold, lowest-risk ideas", async () => {
  const { planBoardMsg, emphasize } = await import("./tgFormat");
  const x = d();
  Object.assign(x.trader.plans.bull, { t2: 23200, premAtEntry: 130, premAtStop: 122, premAtT1: 145, premAtT2: 190 });
  (x.trader as any).plans.noTrade = { from: 22890, to: 23060 }; (x.trader as any).atr15 = 40;
  (x.trader as any).levels = [{ price: 22950, label: "OI put wall", risk: { risk: "MEDIUM", bounce: true } }, { price: 23100, label: "R1", risk: { risk: "LOW" } }];
  (x.trader as any).review = { bull: { grade: "B", score: 66, verdict: "TAKE SMALL — half size", checks: [{ ok: true, label: "trend" }, { ok: false, label: "15-min close" }] } };
  const m = emphasize(planBoardMsg(x));
  assert.match(m, /NIFTY — TRADE PLAN/); assert.match(m, /Review B<\/b> 66% → <b>TAKE SMALL/); assert.match(m, /✓ 1 passed · ✗ 1 failed: 15-min close/);
  const pre = m.match(/<pre>([\s\S]*?)<\/pre>/)![1];
  assert.ok(!/<b>/.test(pre), "no tags inside <pre>"); assert.match(pre, /Target 2\s+23,200\s+₹190\s+\+140/);
  assert.match(m, /NO-TRADE ZONE<\/b> 22,890 – 23,060\n170 pts wide \(4\.3 × ATR\)/);
  assert.match(m, /CE on a bounce from <b>22,950<\/b> \(OI put wall\)/); assert.match(m, /CE on a 15-min close above <b>23,100<\/b> — LOW-RISK break/);
});
test("messages are split into short sections: board = Bull · No-trade · Bear (· OI); best opportunity = one per index", async () => {
  const { planBoardMsg, splitParts, bestOpportunityMsg } = await import("./tgFormat");
  const x = d(); (x.trader as any).plans.noTrade = { from: 22890, to: 23060 }; (x.trader as any).atr15 = 40; (x.trader as any).levels = [];
  const parts = splitParts(planBoardMsg(x));
  assert.equal(parts.length, 3); assert.match(parts[0], /NIFTY · BULL PLAN/); assert.match(parts[1], /NIFTY · NO-TRADE ZONE/); assert.match(parts[2], /NIFTY · BEAR PLAN/);
  const y = d({ symbol: "^BSESN", name: "SENSEX" });
  const b = splitParts(bestOpportunityMsg([{ d: x, trade: null, eye: null, zh: null }, { d: y, trade: null, eye: null, zh: null }]));
  assert.equal(b.length, 2); assert.match(b[0], /BEST OPPORTUNITY · NIFTY/); assert.match(b[1], /BEST OPPORTUNITY · SENSEX/);
});
test("15-min candle message: the closed candle, type, VWAP + nearest levels, OI last 15 min, and the senior trader's read", async () => {
  const { candleMsg } = await import("./tgFormat");
  const t0 = 1_792_036_800;   // 09:30 IST
  const x: any = d();
  x.chart = { candles: [{ time: t0 - 900, open: 22950, high: 22990, low: 22940, close: 22980 }, { time: t0, open: 22980, high: 23062, low: 22975, close: 23055 }], vwap: [22960, 22990] };
  x.spot.price = 23055; x.trader.atr15 = 40;
  x.trader.levels = [{ price: 23061, label: "PDH", kind: "PREV DAY" }, { price: 23000, label: "OI put wall", kind: "OI" }];
  x.trader.trends = [{ tf: "Daily", verdict: "UP" }, { tf: "1H", verdict: "UP" }];
  x.trader.candles = { m15: { tf: "15-min", time: t0, tone: "bull", shape: "bullish momentum candle (body 90%)", closeLoc: 92, at: "PDH 23,061" } };
  x.oi = { pcr: 1.3, tiltToday: 70, bias: "BULLISH", last15: { ageMin: 15, ce: 1e5, pe: 4e5, tilt: 80, top: { side: "PE", strike: 23000, chg: 3e5 } } };
  const m = candleMsg(x, { upPct: 50, sidePct: 30, downPct: 20, lead: "UP" }, t0 + 900 + 30);
  assert.match(m, /NIFTY · 15-MIN CANDLE 09:30–09:45/);
  assert.match(m, /O 22,980 · H 23,062 · L 22,975 · C <b>23,055<\/b> \(\+75 pts\) 🟩/);
  assert.match(m, /Type: bullish momentum candle · closed at 92% of its range · at PDH 23,061/);
  assert.match(m, /VWAP 22,990 \(above\)/); assert.match(m, /Resistance <b>23,061<\/b>/); assert.match(m, /Support <b>23,000<\/b>/);
  assert.match(m, /OI last 15 min: CE \+1\.0L · PE \+4\.0L · most at <b>PE 23,000 \+3\.0L<\/b> · tilt Bulls 80%/);
  assert.match(m, /Read:<\/b> Buyers won this candle, now testing resistance 23,061 — a 15-min close above it is the trigger/);
});
test("09:13 opening heat: top 15 by bias, major stocks only, points summed", async () => {
  const { openingHeatMsg } = await import("./tgFormat");
  const rows = Array.from({ length: 20 }, (_, i) => ({ s: "S" + i, weightPct: i < 18 ? 2 : 0.5, pct: i - 9, points: (i - 9) * 2 }));
  const bull = openingHeatMsg(rows, "BULLISH", "2026-10-19");
  assert.match(bull, /OPENING HEAT 09:13 · TOP 15 NIFTY/); assert.equal((bull.match(/<b>S\d+<\/b>/g) || []).length, 15);
  assert.match(bull.split("\n")[2], /<b>S17<\/b> \+8\.00%/);   // biggest major gainer first (S18/S19 are not "major")
  const neu = openingHeatMsg(rows, "NEUTRAL", "2026-10-19");
  assert.match(neu, /8 gainers \+ 7 losers/);
});
