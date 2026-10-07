import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../types";
import type { Quote } from "./types";
import { globalCues, indexSentiment, briefPhase } from "./brief";

const q = (key: string, changePct: number | null, freshness: Quote["freshness"] = "DELAYED"): Quote =>
  ({ key, label: key, value: changePct == null ? null : 100, change: null, changePct, ts: 1, freshness, source: "test" });

test("global cues: weak world + rising crude/dollar → BEARISH; gold is shown but never scored", () => {
  const md: Record<string, Quote> = {
    SPX: q("SPX", -0.8), NASDAQ: q("NASDAQ", -1.1), DOW: q("DOW", -0.6), USFUT: q("USFUT", -0.4),
    NIKKEI: q("NIKKEI", -1.2), HANGSENG: q("HANGSENG", -0.9), DAX: q("DAX", -0.7),
    BRENT: q("BRENT", 2.5), USDINR: q("USDINR", 0.4), DXY: q("DXY", 0.5), GOLD: q("GOLD", -2),
  };
  const c = globalCues(md);
  assert.equal(c.lean, "BEARISH");
  assert.ok(c.negatives.some((n) => /Crude/.test(n)), "rising crude counts against India");
  assert.ok(!c.negatives.some((n) => /Gold/.test(n)) && !c.positives.some((n) => /Gold/.test(n)));
});

test("global cues: nothing available → NEUTRAL with null score (never fabricated)", () => {
  const c = globalCues({ SPX: q("SPX", null, "UNAVAILABLE") });
  assert.equal(c.score, null);
  assert.equal(c.lean, "NEUTRAL");
});

// Two IST sessions of 5m candles: day 1 flat at 100, day 2 trending up.
function twoDays(): Candle[] {
  const out: Candle[] = [];
  const d1 = Date.parse("2026-10-05T03:45:00Z") / 1000, d2 = Date.parse("2026-10-06T03:45:00Z") / 1000;   // 09:15 IST
  for (let i = 0; i < 75; i++) out.push({ time: d1 + i * 300, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 });
  for (let i = 0; i < 75; i++) { const p = 100 + i * 0.02; out.push({ time: d2 + i * 300, open: p, high: p + 0.05, low: p - 0.03, close: p + 0.02, volume: 1000 }); }
  return out;
}

test("index sentiment: change vs the PREVIOUS session close, uptrend → BULLISH", () => {
  const cs = twoDays();
  const now = cs[cs.length - 1].time + 600;
  const s = indexSentiment("NIFTY", "NIFTY", cs, now);
  assert.equal(s.prevClose, 100);
  assert.ok(s.changePct! > 0);
  assert.equal(s.lean, "BULLISH");
});

test("index sentiment ignores the forming candle and candles at/after 15:15", () => {
  const cs = twoDays();
  const t1515 = Date.parse("2026-10-06T09:45:00Z") / 1000;
  const spike = [...cs.filter((c) => c.time < t1515), { time: t1515, open: 101, high: 140, low: 101, close: 139, volume: 1 }];
  const s = indexSentiment("NIFTY", "NIFTY", spike, t1515 + 3600);
  assert.ok(s.last! < 102, "15:15+ move excluded");
  const mid = cs.slice(0, 75 + 40);                                   // day 2 up to 12:35 IST
  const forming = indexSentiment("NIFTY", "NIFTY", mid, mid[mid.length - 1].time + 100);   // last bar still forming
  assert.equal(forming.candleTime, mid[mid.length - 2].time);
});

test("brief phase follows the trader's day (pre-market / live / day end at 15:15)", () => {
  assert.equal(briefPhase(Date.parse("2026-10-07T03:00:00Z") / 1000), "PRE_MARKET");   // 08:30 IST
  assert.equal(briefPhase(Date.parse("2026-10-07T06:00:00Z") / 1000), "LIVE");         // 11:30 IST
  assert.equal(briefPhase(Date.parse("2026-10-07T09:50:00Z") / 1000), "DAY_END");      // 15:20 IST
  assert.equal(briefPhase(Date.parse("2026-10-10T06:00:00Z") / 1000), "CLOSED");       // Saturday
});
