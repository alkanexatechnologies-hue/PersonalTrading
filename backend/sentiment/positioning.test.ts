import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluate, metricOf, legOf, classifyChange, posTrend, shortPercentile, PDay, Structure, PCT_MIN_SESSIONS } from "./positioning";
import { classifyPriceOi } from "./indexFutures";
import { upsertReport, loadHistory, HistStore } from "./participantHistory";

const zero = { long: 0, short: 0 }, zo = { callLong: 0, callShort: 0, putLong: 0, putShort: 0 };
/** a session where FII index futures are (long, short); other participants balance the book. */
const day = (date: string, fl: number, fs_: number, extra: Partial<PDay> = {}): PDay => ({ date, sourceReportId: `fao_participant_oi_${date}.csv`,
  fut: { FII: { long: fl, short: fs_ }, DII: zero, Client: { long: fs_, short: fl }, Pro: zero }, opt: { FII: { ...zo, callLong: 10, callShort: 4 }, DII: zo, Client: zo, Pro: zo }, ...extra });
const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400_000).toISOString().slice(0, 10));

test("net position, net change, 1/3/5-session changes and the change class", () => {
  const ds = dates(6).map((d, i) => day(d, 100, 200 + i * 10));   // net -100, -110, … -150
  const m = metricOf(ds, "FII", "INDEX_FUT")!;
  assert.equal(m.net, -150); assert.equal(m.previousNet, -140); assert.equal(m.netChange, -10); assert.equal(m.ch3, -30); assert.equal(m.ch5, -50);
  assert.equal(m.longShortRatio, 0.4);   // 100 long / 250 short assert.equal(m.change1, "NET SHORT INCREASING");
  assert.equal(classifyChange(500, 100, 2000), "NET LONG INCREASING"); assert.equal(classifyChange(-500, 100, 2000), "NET SHORT DECREASING");
  assert.equal(classifyChange(500, 5, 2000), "RELATIVELY UNCHANGED"); assert.equal(classifyChange(null, 1, 1), "INSUFFICIENT DATA");
});
test("zero shorts → no ratio (no division by zero); one session → changes are insufficient, never zero", () => {
  const m = metricOf([day("2025-01-01", 50, 0)], "FII", "INDEX_FUT")!;
  assert.equal(m.longShortRatio, null); assert.equal(m.ch1, null); assert.equal(m.change1, "INSUFFICIENT DATA");
});
test("instrument types are kept apart; a report without stock columns gives no stock metric (never mixed with index)", () => {
  const d = day("2025-01-01", 1, 2, { stockFut: { FII: { long: 900, short: 100 }, DII: zero, Client: zero, Pro: zero } });
  assert.deepEqual(legOf(d, "FII", "STOCK_FUT"), { long: 900, short: 100 }); assert.deepEqual(legOf(d, "FII", "INDEX_FUT"), { long: 1, short: 2 });
  assert.deepEqual(legOf(d, "FII", "INDEX_CALL"), { long: 10, short: 4 }); assert.equal(legOf(day("2025-01-01", 1, 2), "FII", "STOCK_FUT"), null);
});
test("futures price × OI: long buildup / short buildup / short covering / long unwinding / unchanged", () => {
  assert.equal(classifyPriceOi(+50, 23000, +100000, 1e7), "LONG BUILDUP");     // rising price, rising OI
  assert.equal(classifyPriceOi(-50, 23000, +100000, 1e7), "SHORT BUILDUP");    // falling price, rising OI
  assert.equal(classifyPriceOi(+50, 23000, -100000, 1e7), "SHORT COVERING");   // rising price, falling OI
  assert.equal(classifyPriceOi(-50, 23000, -100000, 1e7), "LONG UNWINDING");
  assert.equal(classifyPriceOi(+1, 23000, +100000, 1e7), "UNCHANGED");
});
test("short percentile needs enough history; trend labels", () => {
  assert.equal(shortPercentile(Array(PCT_MIN_SESSIONS - 1).fill(0)), null);
  const nets = [...Array.from({ length: 199 }, (_, i) => -i), -500];   // today the most short
  assert.equal(shortPercentile(nets), 100);
  assert.equal(posTrend(-100, -50, 1000), "INCREASING BEARISH"); assert.equal(posTrend(-100, +50, 1000), "DECREASING BEARISH"); assert.equal(posTrend(10, 1, 1000), "NEUTRAL");
});
test("duplicate ingestion is a no-op; a corrected report replaces the row and is logged; a bad report is rejected", () => {
  const csv = (fl: number) => `"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Jan 01, 2025",,,,,,,
Client Type,Future Index Long,Future Index Short,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short
Client,${300 - fl},150,1,1,1,1
DII,0,0,0,0,0,0
FII,${fl},150,1,1,1,1
Pro,0,0,0,0,0,0
TOTAL,300,300,2,2,2,2`;   // balanced book: total long = total short
  const s: HistStore = { days: {}, noFile: [], rejected: {}, corrections: [] };
  assert.equal(upsertReport(s, "2025-01-01", csv(100)), "ADDED");
  assert.equal(upsertReport(s, "2025-01-01", csv(100)), "SAME");
  assert.equal(upsertReport(s, "2025-01-01", csv(90)), "CORRECTED"); assert.equal(s.corrections.length, 1); assert.equal(s.days["2025-01-01"].fut.FII.long, 90);
  assert.equal(upsertReport(s, "2025-01-02", csv(100)), "REJECTED", "title date must match"); assert.ok(s.rejected["2025-01-02"]);
  const f = path.join(os.tmpdir(), `ph-${process.pid}.json`); assert.equal(Object.keys(loadHistory(f).days).length, 0, "missing store → empty, not an error");
});

// ---- the rule engine with live structure
const T0 = Date.parse("2026-10-21T03:45:00Z") / 1000;
const bars = (closes: number[]) => closes.map((c, i) => ({ time: T0 + i * 300, open: c - 1, high: c + 3, low: c - 3, close: c }));
const struct = (o: Partial<Structure>): Structure => ({ session: "OPEN", asOf: T0, spot: 100, vwap: 100, closed5: bars([100, 101]), trend15: "RANGE", breakout: null, breakdown: null, bos: [], chainOiBias: "NEUTRAL", ...o });
const hist = (n: number, lastNets: number[]) => { const ds = dates(n).map((d, i) => day(d, 100, 200 + (i % 7) * 5)); lastNets.forEach((net, k) => { const i = n - lastNets.length + k; ds[i] = day(ds[i].date, 100, 100 - net); }); return ds; };
const ev = (days: PDay[], S: Structure | null, fut: any = null) => evaluate({ underlying: "NIFTY", nseCovered: true, days, expectedReportDate: days[days.length - 1].date, structure: S, futures: fut, now: T0 + 3600 });

test("bearish continuation is ACTIVE only when FII turns more bearish AND price confirms (below VWAP, 15m DOWN, completed 5-min breakdown)", () => {
  const days = hist(200, [-200, -300, -400, -500]);
  const S = struct({ vwap: 120, closed5: bars([118, 112, 105, 100]), trend15: "DOWN", breakdown: { state: "CONFIRMED_BREAKDOWN", barTime: T0 + 3 * 300 } });
  const o = ev(days, S, { available: true, reading: "SHORT BUILDUP", priceChg: -40, oiChg: 9e4, oiChgPct: 1 });
  assert.equal(o.cards[0].status, "ACTIVE"); assert.equal(o.interpretation, "BEARISH_CONTINUATION_CANDIDATE");
  assert.match(o.sentiment.authority, /INFORMATION ONLY/);
});
test("FII bearish but NIFTY above VWAP → MIXED with the reason (never forced bearish)", () => {
  const days = hist(200, [-200, -300, -400, -500]);
  const o = ev(days, struct({ vwap: 90, closed5: bars([95, 100]), trend15: "UP" }));
  assert.notEqual(o.cards[0].status, "ACTIVE"); assert.equal(o.interpretation, "MIXED");
  assert.ok(o.conflicts.some((c) => /bearish but price is above VWAP/.test(c)));
});
test("elevated FII shorts + a bullish reversal (lows stop, VWAP reclaimed, structure turns up) → SHORT_SQUEEZE_RISK; elevated shorts alone → WATCH", () => {
  const days = hist(200, [-900, -950, -1000, -1000]);   // far more short than the window
  const rev = struct({ vwap: 100, closed5: bars([96, 92, 90, 93, 97, 102]), trend15: "UP", breakdown: { state: "FAILED_BREAKDOWN", barTime: T0 + 2 * 300 } });
  const o = ev(days, rev, { available: true, reading: "SHORT COVERING", priceChg: 30, oiChg: -8e4, oiChgPct: -1 });
  assert.equal(o.cards[2].status, "ACTIVE", JSON.stringify(o.cards[2].conditions)); assert.equal(o.interpretation, "SHORT_SQUEEZE_RISK");
  assert.equal(o.cards[3].status, "ACTIVE", "futures short covering");
  const still = ev(days, struct({ vwap: 110, closed5: bars([108, 104, 100, 96]), trend15: "DOWN" }));
  assert.equal(still.cards[2].status, "WATCH", "elevated shorts are a condition, not a signal");
});
test("stale or missing participant data and no live candles → visible STALE / NO_EDGE, missing inputs listed, never read as neutral", () => {
  const days = hist(30, [-100, -150]);
  const o = evaluate({ underlying: "NIFTY", nseCovered: true, days, expectedReportDate: "2099-01-01", structure: struct({ session: "CLOSED", closed5: [] }), futures: { available: false, reason: "no quote" }, now: T0 });
  assert.equal(o.freshness, "STALE"); assert.ok(o.missing.some((m) => /STALE/.test(m))); assert.ok(o.missing.some((m) => /index futures OI/.test(m)));
  assert.equal(o.scores.structure.score, null); assert.equal(o.scores.structure.confidence, 0);
  assert.equal(o.fii!.shortPercentile, null, "30 sessions is not enough history for a percentile");
  const bse = evaluate({ underlying: "SENSEX", nseCovered: false, days, expectedReportDate: null, structure: null, futures: null, now: T0 });
  assert.equal(bse.interpretation, "NO_EDGE"); assert.equal(bse.sentiment.freshness_status, "NOT COVERED");
  const bseLive = evaluate({ underlying: "SENSEX", nseCovered: false, days: hist(200, [-100, -50, 0, 50]), expectedReportDate: null, structure: struct({ vwap: 120, closed5: bars([110, 100]) }), futures: null, now: T0 + 3600 });
  assert.equal(bseLive.conflicts.length, 0, "no participant conflicts for an index NSE data does not cover"); assert.equal(bseLive.sentiment.institutional_bias, "UNKNOWN");
});
test("contradictory participants: FII adds shorts on a day the futures price rose → listed as a conflict", () => {
  const days = hist(200, [-200, -300]);
  const d1 = days[days.length - 2].date, d2 = days[days.length - 1].date;
  const o = ev(days, null, { available: true, reading: "UNCHANGED", priceChg: 0, oiChg: 0, oiChgPct: 0, sessions: [{ date: d1, close: 100, oi: 1 }, { date: d2, close: 110, oi: 1 }] });
  assert.ok(o.conflicts.some((c) => /added net shorts .* futures price rose/.test(c)));
});
test("the Arbiter object carries no trade instruction — only evidence, statuses and the information-only authority", () => {
  const o = ev(hist(200, [-200, -300, -400, -500]), struct({}));
  const keys = Object.keys(o.sentiment);
  for (const k of ["underlying", "data_as_of", "freshness_status", "institutional_bias", "positioning_trend", "bearish_continuation_status", "bullish_continuation_status", "short_squeeze_risk", "short_covering_status", "long_buildup_status", "component_scores", "supporting_evidence", "contradicting_evidence", "missing_data", "explanation"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.some((k) => /action|order|entry|trade/i.test(k)), "no trade-instruction field");
});
