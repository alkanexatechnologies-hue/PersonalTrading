import { test } from "node:test";
import assert from "node:assert/strict";
import { prevSessionClose, windowStart, parseRss, parseFedRegister, isJunk, applyRules, trumpStatus, dedupeItems, buildIntel, type RawItem, type IntelCat } from "./intel";

const ist = (y: number, m: number, d: number, hh: number, mm: number) => Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000) - 19800;

test("freshness window: 24 h on a weekday evening, back to Friday close on Monday morning", () => {
  const sunEve = ist(2026, 10, 11, 21, 0);             // Sunday
  assert.equal(prevSessionClose(sunEve), ist(2026, 10, 9, 15, 30));
  assert.equal(windowStart(sunEve), ist(2026, 10, 9, 15, 30));
  const monAm = ist(2026, 10, 12, 8, 30);
  assert.equal(windowStart(monAm), ist(2026, 10, 9, 15, 30));
  const tueEve = ist(2026, 10, 13, 20, 0);
  assert.equal(prevSessionClose(tueEve), ist(2026, 10, 13, 15, 30));
  assert.equal(windowStart(tueEve), tueEve - 86400);      // 24 h is older than today's close
  const wedNoon = ist(2026, 10, 14, 12, 0);
  assert.equal(prevSessionClose(wedNoon), ist(2026, 10, 13, 15, 30));
  assert.equal(windowStart(wedNoon), wedNoon - 86400);
});

test("parseRss strips the Google News publisher suffix and keeps the publish time", () => {
  const xml = `<rss><channel><item><title>Rupee near 97 vs dollar - The Indian Express</title><link>https://x/1</link>
    <pubDate>Sun, 11 Oct 2026 10:00:00 GMT</pubDate><source url="https://indianexpress.com">The Indian Express</source></item>
    <item><title>No date item</title><link>https://x/2</link></item></channel></rss>`;
  const r = parseRss(xml, "Google News", "MEDIA");
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "Rupee near 97 vs dollar");
  assert.equal(r[0].source, "The Indian Express");
  assert.equal(r[0].epoch, Date.UTC(2026, 9, 11, 10) / 1000);
  assert.equal(r[1].epoch, 0);
});

test("parseFedRegister marks presidential documents official", () => {
  const r = parseFedRegister({ results: [{ title: "Adjusting Imports of Steel", publication_date: "2026-10-09", html_url: "https://fr/1" }, { title: "" }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].official, "fedreg");
  assert.equal(r[0].tier, "OFFICIAL");
});

test("junk filter drops city gold-rate pages, keeps gold news", () => {
  assert.equal(isJunk("Gold Rate in Gorakhpur Today (11th October 2026), 22 & 24 Carat Gold Price in Gorakhpur"), true);
  assert.equal(isJunk("Gold Price Today in Cuttack – 18K, 22K & 24K Rate | 11 October 2026"), true);
  assert.equal(isJunk("Will gold prices nosedive? Check reasons behind the recent fall"), false);
});

test("rules: oil, rupee, RBI, war, tariff, tax", () => {
  assert.equal(applyRules("oil", "Oil Prices Up Over 3% Over Concerns About Prolonged Hormuz Disruption").dir, -1);
  assert.ok(applyRules("oil", "Oil Prices Up Over 3% Over Hormuz").neg.some((s) => s.startsWith("OMCs")));
  assert.equal(applyRules("oil", "Brent slides as OPEC+ output hits record").dir, 1);
  assert.equal(applyRules("inr", "Rupee near 97 vs dollar, RBI unveils measures").dir, -1);
  assert.equal(applyRules("inr", "RBI's rupee-defence measures may offer near-term relief").dir, 1);
  assert.equal(applyRules("rbi", "RBI to conduct 3-day Variable Rate Reverse Repo (VRRR) auction").dir, -1);
  assert.equal(applyRules("rbi", "RBI May Raise Repo Rate by 75–100 Basis Points in Current Cycle: Report").dir, -1);
  assert.equal(applyRules("rbi", "RBI Raises Banks' Daily CRR Maintenance Requirement to 99% from October 16").dir, -1);
  const ev = applyRules("rbi", "RBI set to announce repo rate decision amid geopolitical tensions");
  assert.equal(ev.dir, 0); assert.match(ev.note || "", /key event/);
  assert.equal(applyRules("india", "Nifty, Sensex jump 3.5% as US-Iran ceasefire lifts sentiment").dir, 1);
  assert.equal(applyRules("russia", "Putin rules out Ukraine war peace breakthrough").dir, -1);
  assert.equal(applyRules("trump", "Trump threatens 100% tariff on Indian goods").dir, -1);
  assert.equal(applyRules("trump", "India and US close in on trade deal").dir, 1);
  assert.equal(applyRules("tax", "GST council cuts rates on 30 items").dir, 1);
  assert.equal(applyRules("tax", "Govt hikes STT on F&O trades").dir, -1);
  assert.equal(applyRules("fed", "Expectations of Another Fed Rate Hike This Month Are Shifting").dir, -1);
  assert.equal(applyRules("gold", "Gold hits record high").dir, 0);
});

test("Trump status comes from the source, else the wording", () => {
  const base: RawItem = { title: "x", link: "", source: "", epoch: 1, tier: "OFFICIAL" };
  assert.equal(trumpStatus({ ...base, official: "fedreg" }), "IMPLEMENTED");
  assert.equal(trumpStatus({ ...base, official: "whitehouse" }), "SIGNED");
  assert.equal(trumpStatus({ ...base, official: "ustr" }), "ANNOUNCED");
  assert.equal(trumpStatus({ ...base, tier: "MEDIA", title: "Trump says he is 'going to look at' joining Saudi Arabia" }), "PROPOSAL");
  assert.equal(trumpStatus({ ...base, tier: "MEDIA", title: "Trump calls for Ukraine election" }), "STATEMENT");
});

test("dedupe merges the same story and prefers the official copy", () => {
  const a: RawItem = { title: "RBI announces regulatory measures for the foreign exchange market", link: "", source: "ET", epoch: 200, tier: "MEDIA" };
  const b: RawItem = { title: "RBI Announces Regulatory Measures for the Foreign Exchange Market", link: "", source: "RBI", epoch: 100, tier: "OFFICIAL", official: "rbi" };
  const c: RawItem = { title: "Rupee falls to record low", link: "", source: "BS", epoch: 150, tier: "MEDIA" };
  const r = dedupeItems([a, b, c]);
  assert.equal(r.length, 2);
  assert.equal(r[0].source, "RBI"); assert.equal(r[0].alsoIn, 1);
});

test("buildIntel keeps only fresh items and summarises direction and segments", () => {
  const now = ist(2026, 10, 14, 12, 0);   // Wednesday noon -> 24 h window
  const mk = (title: string, hoursAgo: number, extra: Partial<RawItem> = {}): RawItem => ({ title, link: "", source: "Media", epoch: now - hoursAgo * 3600, tier: "MEDIA", ...extra });
  const raw = { oil: [mk("Oil prices jump 3% on Hormuz disruption", 2), mk("Crude oil surges to record", 30)], inr: [mk("Rupee falls to record low against dollar", 3)],
    trump: [mk("Trump threatens tariff on India", 1)], rbi: [mk("RBI set to announce repo rate decision", 4), mk("RBI old news", 0, { epoch: 0 })],
    india: [mk("Sensex, Nifty jump as IT stocks rally", 5)], tax: [], gold: [mk("Gold Rate in Patna Today (14th October 2026), 22 & 24 Carat", 1)],
    sentiment: [], fed: [], russia: [] } as Record<IntelCat, RawItem[]>;
  const r = buildIntel(raw, now);
  const oil = r.categories.find((c) => c.id === "oil")!;
  assert.equal(oil.count, 1, "30-hour-old item dropped");
  assert.equal(oil.dir, -1); assert.equal(oil.tone, "NEGATIVE");
  assert.equal(r.categories.find((c) => c.id === "rbi")!.count, 1, "undated item dropped");
  assert.equal(r.categories.find((c) => c.id === "rbi")!.tone, "EVENT AHEAD");
  assert.equal(r.categories.find((c) => c.id === "gold")!.tone, "NO FRESH NEWS");
  assert.equal(r.categories.find((c) => c.id === "trump")!.items[0].status, "PROPOSAL");
  assert.ok(r.direction.score < 0);
  assert.ok(r.keyPoints.length >= 4 && r.keyPoints[0].cat === "oil");
  assert.ok(r.segments.negative.some((s) => s.name.startsWith("OMCs")));
  assert.ok(r.segments.positive.some((s) => s.name === "IT"));
  assert.ok(r.categories.every((c) => c.items.every((i) => i.epoch >= r.windowStart)));
  assert.deepEqual(r.categories.map((c) => c.id), ["rbi", "oil", "inr", "india", "fed", "trump", "russia", "tax", "sentiment", "gold"]);
});
