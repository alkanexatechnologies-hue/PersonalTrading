import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNews, parseMovers } from "./dhanDataApis";
import { dhanToRaw, dhanStockNews, buildIntel, CATS } from "../news/intel";

const news = { data: { latestNews: [
  { newsObject: { overallSentiment: "positive", title: "Rupee opens stronger against dollar", text: "x" }, category: "CURRENCY", publishDate: "2026-10-12" },
  { newsObject: { overallSentiment: "neutral", title: "Axis Bank block trade: ₹50 crore on BSE", text: "" }, category: "EQUITY_MARKETS", publishDate: "2026-10-12" },
  { newsObject: { overallSentiment: "negative", title: "Crude oil jumps on supply fears", text: "" }, category: "COMMODITIES", publishDate: "2026-10-11" },
  { newsObject: { overallSentiment: "positive", title: "KEC International wins T&D orders of ₹1,014 crore", text: "body" }, category: "COMPANIES", subCategory: "orders", publishDate: "2026-10-12", stockName: "KEC INTERNATIONAL", displaySymbol: "KEC International" },
  { newsObject: { overallSentiment: "odd", title: "" }, publishDate: "bad" },
] } };
const now = Math.floor(Date.parse("2026-10-12T09:30:00Z") / 1000);   // 15:00 IST

test("news parser keeps valid items and normalises sentiment", () => {
  const n = parseNews(news);
  assert.equal(n.length, 4);
  assert.equal(n[0].sentiment, "positive"); assert.equal(n[3].symbol, "KEC International");
});

test("Dhan macro news: today only, noise dropped, mapped by category rule, date-only epoch", () => {
  const r = dhanToRaw(parseNews(news), now);
  assert.deepEqual(r.map((x) => x.cat), ["inr"]);                  // block trade dropped, 11 Oct dropped, company not matched
  assert.equal(r[0].item.dateOnly, true);
  assert.equal(r[0].item.epoch, Math.floor(Date.parse("2026-10-12T00:00:00Z") / 1000) - 19800);
});

test("Dhan sentiment used only when no headline rule decides", () => {
  const raw: any = Object.fromEntries(CATS.map((c) => [c.id, []]));
  for (const m of dhanToRaw(parseNews(news), now)) raw[m.cat].push(m.item);
  const it = buildIntel(raw, now).categories.find((c) => c.id === "inr")!.items[0];
  assert.ok(it.dir !== 0); assert.ok(it.note);
});

test("stock news: today's company headlines", () => {
  const s = dhanStockNews(parseNews(news), now);
  assert.equal(s.length, 2);   // KEC + Rupee (both dated today; caller passes only COMPANIES)
  assert.equal(s.find((x) => /KEC/.test(x.title))!.sentiment, "positive");
});

test("movers parser: numbers or null", () => {
  const m = parseMovers({ data: [{ displayName: "ITC", tradingSymbol: "ITC", instrument: "EQUITY", ltp: 266, changePercent: 4.31, volume: 10, strikePrice: null, putCallRatio: "x" }] });
  assert.equal(m[0].ltp, 266); assert.equal(m[0].changePct, 4.31); assert.equal(m[0].strike, null); assert.equal(m[0].pcr, null);
});
