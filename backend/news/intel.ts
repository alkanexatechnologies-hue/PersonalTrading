// Global News Intelligence — fresh, category-wise news for the Market Sentiment screen.
//
// Ten categories (oil, rupee, Trump, RBI, Indian market, tax, gold, sentiment, Fed,
// Russia war) from official feeds (RBI, Fed, EIA, White House, USTR, Federal Register)
// plus Google News searches limited to the freshness window. Each headline gets a
// rule-based market direction and the segments it helps or hurts; categories and the
// overall direction are summarised from those rules.
//
// FRESH ONLY: an item is kept only if it was published inside the window — the last
// 24 h, or since the previous session's close when that is older (Monday morning).
// Items without a publish time are dropped. Nothing older is ever shown.
//
// DISPLAY ONLY: this is separate from getMarketNews() (whose summary.bias the paper
// engine reads) and feeds no signal, gate, Arbiter or paper trade.

import { decodeEntities, tag, classify } from "./news";

export type IntelCat = "oil" | "inr" | "trump" | "rbi" | "india" | "tax" | "gold" | "sentiment" | "fed" | "russia";
export type Tier = "OFFICIAL" | "MEDIA";
export type TrumpStatus = "IMPLEMENTED" | "SIGNED" | "ANNOUNCED" | "PROPOSAL" | "STATEMENT";

export interface RawItem { title: string; link: string; source: string; epoch: number; tier: Tier; official?: "fedreg" | "whitehouse" | "ustr" | "rbi" | "fed" | "eia" }
export interface IntelItem extends RawItem {
  ageH: number; dir: -1 | 0 | 1; note: string | null; pos: string[]; neg: string[];
  status?: TrumpStatus; alsoIn: number;
}
export interface IntelCategory {
  id: IntelCat; label: string; count: number; dir: -1 | 0 | 1; tone: string;
  summary: string; pos: string[]; neg: string[]; items: IntelItem[];
}
export interface IntelResult {
  asOf: number; windowStart: number; windowHours: number;
  direction: { score: number; label: string; positive: number; negative: number };
  keyPoints: { cat: IntelCat; label: string; dir: -1 | 0 | 1; text: string; note: string | null; source: string; ageH: number }[];
  segments: { positive: { name: string; why: string }[]; negative: { name: string; why: string }[] };
  categories: IntelCategory[];
  sources: { name: string; ok: boolean; items: number }[];
}

// ---------------- categories ----------------
interface CatDef { id: IntelCat; label: string; weight: number; queries: string[]; include?: RegExp; exclude?: RegExp; officialInclude?: RegExp }
export const CATS: CatDef[] = [
  { id: "rbi", label: "RBI", weight: 2, queries: ["RBI repo OR liquidity OR monetary policy OR forex"], include: /\brbi\b|reserve bank/i },
  { id: "oil", label: "Oil", weight: 2, queries: ["crude oil brent OPEC", "oil prices Hormuz OR supply"], include: /oil|crude|brent|wti|opec|hormuz|refiner|fuel|diesel|petrol|lng|gas/i },
  { id: "inr", label: "Rupee", weight: 1.5, queries: ["rupee dollar", "forex reserves India"], include: /rupee|\binr\b|forex|usd\/inr|dollar/i },
  { id: "india", label: "Indian market", weight: 1.5, queries: ["Sensex Nifty", "Bank Nifty stock market today"], include: /nifty|sensex|d-street|dalal|stock market|markets?\b|stocks?\b|shares?\b/i },
  { id: "fed", label: "Fed", weight: 1, queries: ["Federal Reserve Powell interest rate", "US inflation Fed rate"], include: /\bfed\b|federal reserve|fomc|powell|us (inflation|cpi|jobs|treasury)|rate (hike|cut)/i, officialInclude: /fomc|monetary|rate|minutes|powell|statement|inflation|discount|balance sheet/i },
  { id: "trump", label: "Trump: war & India", weight: 1, queries: ["Trump India", "Trump war OR tariff OR sanctions"], include: /trump|white house|ustr|tariff/i, officialInclude: /tariff|trade|india|russia|ukrain|sanction|oil|energy|fuel|diesel|china|import|export|duty|iran|war|steel|pharma/i },
  { id: "russia", label: "Russia war", weight: 1, queries: ["Russia Ukraine war", "Russia oil sanctions"], include: /russia|ukrain|putin|zelensk|kremlin|moscow|kyiv/i },
  { id: "tax", label: "Tax", weight: 1, queries: ["GST OR income tax OR STT OR LTCG OR customs duty India"], include: /\b(gst|tax|taxes|stt|ltcg|stcg|tds|cess|duty|duties|excise|customs)\b/i, exclude: /\b(itat|cestat|tribunal|high court|supreme court|hc|treaty)\b/i },
  { id: "sentiment", label: "Sentiment", weight: 1, queries: ["Nifty outlook week FII DII", "Indian stock market outlook"], include: /outlook|fii|dii|fpi|sentiment|week ahead|next week|investors?|flows?/i },
  { id: "gold", label: "Gold", weight: 0.5, queries: ["gold price outlook", "gold prices MCX"], include: /gold|bullion|silver/i },
];

// Official feeds and the category they belong to.
interface Official { name: string; url: string; cat: IntelCat; kind: NonNullable<RawItem["official"]>; json?: boolean }
const OFFICIAL: Official[] = [
  { name: "RBI", url: "https://www.rbi.org.in/pressreleases_rss.xml", cat: "rbi", kind: "rbi" },
  { name: "US Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", cat: "fed", kind: "fed" },
  { name: "US EIA", url: "https://www.eia.gov/rss/todayinenergy.xml", cat: "oil", kind: "eia" },
  { name: "US EIA", url: "https://www.eia.gov/rss/press_rss.xml", cat: "oil", kind: "eia" },
  { name: "White House", url: "https://www.whitehouse.gov/presidential-actions/feed/", cat: "trump", kind: "whitehouse" },
  { name: "USTR", url: "https://ustr.gov/rss.xml", cat: "trump", kind: "ustr" },
  { name: "Federal Register", url: "https://www.federalregister.gov/api/v1/documents.json?conditions[type][]=PRESDOCU&order=newest&per_page=20", cat: "trump", kind: "fedreg", json: true },
];

// Pages that are not news: city-wise gold/fuel rate tables, listings, stock-quote pages.
const JUNK = [
  /\b(gold|silver|petrol|diesel) (rate|price)s? (today )?in [a-z]/i,
  /\b22\s*(&|and)\s*24\s*carat\b/i, /\b(18k|22k|24k)\b/i,
  /\btoday \(\d{1,2}(st|nd|rd|th)? [a-z]+ \d{4}\)/i,
  /– (bse|nse):/i, /\bstock price\b.*\bquote\b/i,
  /\bhoroscope\b|\blottery\b|\bcricket\b/i,
  /\bheatmap\b|stocks to watch|(below|above) fair value|intrinsic value|price target|\((nyse|nasdaq|lse|tsx):/i,
];
export function isJunk(title: string): boolean { return JUNK.some((r) => r.test(title)); }

// ---------------- freshness window ----------------
const IST = 19800;
/** Epoch seconds of the most recent 15:30 IST close on a weekday at or before now. */
export function prevSessionClose(nowSec: number): number {
  const d = new Date((nowSec + IST) * 1000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  let wd = d.getUTCDay();
  let back = (wd >= 1 && wd <= 5 && mins >= 930) ? 0 : 1;
  for (; back < 8; back++) {
    const t = new Date(Date.UTC(y, m, day - back));
    const w = t.getUTCDay();
    if (w >= 1 && w <= 5) return Math.floor(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 10, 0) / 1000); // 15:30 IST = 10:00 UTC
  }
  return nowSec - 86400;
}
/** Window start: the last 24 h, stretched back to the previous session close when that is older. */
export function windowStart(nowSec: number): number { return Math.min(nowSec - 86400, prevSessionClose(nowSec)); }

// ---------------- parsing ----------------
export function parseRss(xml: string, source: string, tier: Tier, official?: RawItem["official"]): RawItem[] {
  const out: RawItem[] = [];
  for (const raw of xml.split(/<item[ >]/i).slice(1)) {
    const end = raw.search(/<\/item>/i);
    const block = end >= 0 ? raw.slice(0, end) : raw;
    let title = tag("title", block); if (!title) continue;
    let link = tag("link", block);
    if (!link) { const g = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i); if (g) link = decodeEntities(g[1]); }
    const pub = tag("pubDate", block) || tag("dc:date", block);
    const ts = pub ? Date.parse(pub) : NaN;
    let src = source;
    // Google News: "<headline> - <publisher>" with a <source> tag.
    const gs = tag("source", block);
    if (gs) { src = gs; if (title.endsWith(" - " + gs)) title = title.slice(0, -(gs.length + 3)).trim(); }
    out.push({ title, link, source: src, epoch: isNaN(ts) ? 0 : Math.floor(ts / 1000), tier, official });
  }
  return out;
}
export function parseFedRegister(json: any): RawItem[] {
  const rows: any[] = Array.isArray(json?.results) ? json.results : [];
  return rows.filter((r) => r?.title && r?.publication_date).map((r) => ({
    title: String(r.title), link: String(r.html_url || ""), source: "Federal Register", tier: "OFFICIAL" as Tier, official: "fedreg" as const,
    // documents go public at 08:45 ET; 13:00 UTC is a safe stand-in for the day's publication time
    epoch: Math.floor(Date.parse(String(r.publication_date) + "T13:00:00Z") / 1000) || 0,
  }));
}

// ---------------- rules: direction + segments ----------------
interface Rule { cats: IntelCat[] | "any"; re: RegExp; dir: -1 | 0 | 1; pos: string[]; neg: string[]; note: string }
const OIL_USERS = ["OMCs (BPCL, HPCL, IOC)", "Paints", "Aviation", "Tyres"];
const UPSTREAM = ["Upstream oil (ONGC, Oil India)"];
export const RULES: Rule[] = [
  // peace / de-escalation first: "ceasefire lifts oil" style headlines are risk-on
  { cats: "any", re: /ceasefire|truce|peace (deal|agreement|talks progress)|de-?escalat/i, dir: 1, pos: ["Broad market", ...OIL_USERS.slice(0, 3)], neg: ["Defence"], note: "De-escalation lowers risk and oil" },
  { cats: ["oil"], re: /(production|output|supply|supplies|exports?)[^.]*\b(rise|rises|rising|increase|increases|jump|jumps|record|high|boost)\b|output (hike|increase|boost)|wartime high/i, dir: 1, pos: OIL_USERS, neg: UPSTREAM, note: "More supply caps oil prices" },
  { cats: ["oil", "russia", "trump"], re: /(oil|crude|brent|wti)[^.]*\b(up|rise|rises|rising|jump|jumps|surge|surges|spike|spikes|soar|soars|climb|climbs|rally|rallies|gain|gains|high|hike)\b|hormuz|supply (disruption|risk|shock)|output cut|refiner(y|ies)[^.]*(strike|attack|hit)|strikes? on [^.]*refiner/i, dir: -1, pos: UPSTREAM, neg: OIL_USERS, note: "Higher oil raises input costs and inflation" },
  { cats: ["oil"], re: /(oil|crude|brent|wti)[^.]*\b(fall|falls|drop|drops|slump|slumps|plunge|plunges|slide|slides|decline|declines|ease|eases|low|lower|tumble|tumbles)\b|output (hike|increase|boost)|record (output|production)|wartime high/i, dir: 1, pos: OIL_USERS, neg: UPSTREAM, note: "Lower oil eases costs for oil users" },
  { cats: ["inr", "rbi"], re: /rupee[^.]*\b(fall|falls|weak|weaker|weakens|low|slump|slumps|plunge|plunges|slide|slides|depreciat\w*|hits? record|near 9\d)\b|forex reserves[^.]*\b(dip|dips|fall|falls|drop|drops|decline|declines)\b/i, dir: -1, pos: ["IT", "Pharma exporters"], neg: ["Importers", "OMCs (BPCL, HPCL, IOC)"], note: "Weak rupee: exporters gain, importers and FII flows hurt" },
  { cats: ["inr", "rbi"], re: /rupee[^.]*\b(gain|gains|rise|rises|strong|stronger|strengthens|recover|recovers|appreciat\w*|relief)\b|rupee[- ]defen[cs]e|support(s)? (the )?rupee|curb (rupee )?(volatility|speculation)/i, dir: 1, pos: ["Importers", "OMCs (BPCL, HPCL, IOC)"], neg: ["IT"], note: "Rupee support steadies FII flows" },
  { cats: ["rbi"], re: /(rate cut|cuts? (the )?(repo|rate)|liquidity infusion|omo purchase|crr cut|vrr auction|variable rate repo)\b/i, dir: 1, pos: ["Banks", "NBFCs", "Realty", "Auto"], neg: [], note: "Easier money helps rate-sensitive stocks" },
  { cats: ["rbi"], re: /(rate hike|vrrr|reverse repo|liquidity absorption|crr hike|drain\w* (banking )?liquidity)|\b(hikes?|raises?|raising|increases?)\b[^.]*\b(repo|rates?|crr|slr)\b/i, dir: -1, pos: [], neg: ["Banks", "NBFCs", "Realty"], note: "Tighter liquidity weighs on banks" },
  { cats: ["rbi"], re: /repo rate decision|\bmpc\b|monetary policy (meet|review|decision|outcome)|policy (meet|review) this week/i, dir: 0, pos: [], neg: [], note: "RBI policy decision is a key event" },
  { cats: ["fed"], re: /(fed|federal reserve|powell|fomc)?[^.]*(rate hike|hike rates|raise (interest )?rates|hawkish|higher for longer|another hike)/i, dir: -1, pos: ["IT"], neg: ["Banks", "FII flows"], note: "Hawkish Fed: stronger dollar, FII outflow risk" },
  { cats: ["fed"], re: /(rate cut|cut rates|dovish|easing|pause)/i, dir: 1, pos: ["Banks", "Realty", "Broad market"], neg: [], note: "Dovish Fed supports FII inflows" },
  { cats: ["fed"], re: /\b(inflation|cpi|jobs report|payrolls)\b/i, dir: 0, pos: [], neg: [], note: "US data will set the Fed path" },
  { cats: ["trump", "india", "sentiment"], re: /trade deal|tariff (cut|relief|exemption|pause)|exempt\w* from tariff/i, dir: 1, pos: ["IT", "Pharma", "Textiles", "Auto parts"], neg: [], note: "Tariff relief helps exporters" },
  { cats: ["trump", "india", "sentiment"], re: /tariff/i, dir: -1, pos: [], neg: ["IT", "Pharma", "Textiles", "Auto parts"], note: "US tariffs hurt Indian exporters" },
  { cats: ["russia", "trump", "oil"], re: /sanction/i, dir: -1, pos: [], neg: ["OMCs (BPCL, HPCL, IOC)", "Refiners"], note: "Sanctions risk India's discounted Russian oil" },
  { cats: ["russia", "trump"], re: /attack|strike|strikes|missile|drone|escalat|invasion|fight until|no peace|rules out|war widens|offensive|houthi/i, dir: -1, pos: ["Defence", ...UPSTREAM], neg: ["Aviation", "OMCs (BPCL, HPCL, IOC)", "Broad market"], note: "War risk lifts oil and hurts sentiment" },
  { cats: ["russia", "trump"], re: /settlement|peace|talks/i, dir: 1, pos: ["Broad market"], neg: ["Defence"], note: "Peace hopes ease risk" },
  { cats: ["tax"], re: /(gst|tax|duty|cess)[^.]*\b(cut|cuts|relief|reduc\w*|lower|lowered|exempt\w*|rationalis\w*|refund\w*)\b|\b(cuts?|lowers?|reduces?|slashes?)\b[^.]*\b(gst|tax|duty|cess)\b/i, dir: 1, pos: ["Consumption (FMCG, Auto)"], neg: [], note: "Tax relief supports demand" },
  { cats: ["tax"], re: /(stt|ltcg|stcg|tax|duty|cess)[^.]*\b(hike|hikes|raise|raised|increase|increased|new)\b|\b(hikes?|raises?|increases?)\b[^.]*\b(stt|ltcg|stcg|tax|duty|cess)\b/i, dir: -1, pos: [], neg: ["Capital market stocks", "Broad market"], note: "Higher tax on markets hurts sentiment" },
  { cats: ["gold"], re: /gold[^.]*\b(rise|rises|rally|rallies|record|high|jump|jumps|surge|surges|gain|gains|climb|climbs)\b/i, dir: 0, pos: ["Gold financiers (Muthoot, Manappuram)"], neg: ["Jewellers"], note: "Rising gold often signals risk-off" },
  { cats: ["gold"], re: /gold[^.]*\b(fall|falls|drop|drops|slump|slumps|plunge|plunges|slide|slides|decline|declines|nosedive|lower|low)\b/i, dir: 0, pos: ["Jewellers"], neg: ["Gold financiers (Muthoot, Manappuram)"], note: "Falling gold eases risk-off flows" },
  { cats: ["india", "sentiment"], re: /fii[^.]*\b(sell|sells|selling|outflow|outflows|pull out|dump)\b|fpi[^.]*\b(sell|outflow)/i, dir: -1, pos: [], neg: ["Banks", "Broad market"], note: "FII selling pressures large caps" },
  { cats: ["india", "sentiment"], re: /fii[^.]*\b(buy|buys|buying|inflow|inflows)\b|fpi[^.]*\b(buy|inflow)/i, dir: 1, pos: ["Banks", "Broad market"], neg: [], note: "FII buying supports large caps" },
];

export function applyRules(cat: IntelCat, title: string): { dir: -1 | 0 | 1; note: string | null; pos: string[]; neg: string[] } {
  for (const r of RULES) {
    if (r.cats !== "any" && !r.cats.includes(cat)) continue;
    if (r.re.test(title)) return { dir: r.dir, note: r.note, pos: r.pos, neg: r.neg };
  }
  // market-wide categories fall back to the news.ts keyword sentiment
  if (cat === "india" || cat === "sentiment") {
    const s = classify(title).sentiment;
    if (s !== "neutral") return { dir: s === "positive" ? 1 : -1, note: s === "positive" ? "Positive market tone" : "Negative market tone", pos: s === "positive" ? ["Broad market"] : [], neg: s === "negative" ? ["Broad market"] : [] };
  }
  return { dir: 0, note: null, pos: [], neg: [] };
}

/** Trump items: status comes from the source (official) or the wording (media). */
export function trumpStatus(it: RawItem): TrumpStatus {
  if (it.official === "fedreg") return "IMPLEMENTED";
  if (it.official === "whitehouse") return "SIGNED";
  if (it.official === "ustr") return "ANNOUNCED";
  return /propos|plan(s|ning)? to|consider|weigh|may |could |might |threat|look at|mulls?|eyes /i.test(it.title) ? "PROPOSAL" : "STATEMENT";
}

// ---------------- de-duplication ----------------
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "as", "at", "by", "with", "is", "are", "after", "over", "from", "its", "says", "say"]);
function words(t: string): Set<string> { return new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))); }
function similar(a: Set<string>, b: Set<string>): boolean {
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  const uni = a.size + b.size - inter; return uni > 0 && inter / uni >= 0.5;
}
/** Merge the same story from several outlets: official copy wins, else the newest. */
export function dedupeItems<T extends RawItem>(list: T[]): (T & { alsoIn: number })[] {
  const out: { it: T; w: Set<string>; also: number }[] = [];
  for (const it of list) {
    const w = words(it.title);
    const hit = out.find((o) => similar(o.w, w));
    if (!hit) { out.push({ it, w, also: 0 }); continue; }
    hit.also++;
    const better = (it.tier === "OFFICIAL" && hit.it.tier !== "OFFICIAL") || (it.tier === hit.it.tier && it.epoch > hit.it.epoch);
    if (better) { hit.it = it; hit.w = w; }
  }
  return out.map((o) => ({ ...o.it, alsoIn: o.also }));
}

// ---------------- summary ----------------
const sign = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0);
const TONE: Record<string, string> = { "1": "POSITIVE", "-1": "NEGATIVE", "0": "MIXED" };

export function buildIntel(raw: Record<IntelCat, RawItem[]>, nowSec: number, sources: IntelResult["sources"] = []): IntelResult {
  const ws = windowStart(nowSec);
  const categories: IntelCategory[] = [];
  const claimed = new Set<string>();   // one story belongs to one category (first by weight)
  for (const def of [...CATS].sort((a, b) => b.weight - a.weight)) {
    const fresh = (raw[def.id] || []).filter((r) => r.epoch > 0 && r.epoch >= ws && r.epoch <= nowSec + 600 && !isJunk(r.title)
      && !(def.exclude && def.exclude.test(r.title))
      && (r.tier === "OFFICIAL" ? !def.officialInclude || def.officialInclude.test(r.title) : !def.include || def.include.test(r.title)));
    const merged = dedupeItems(fresh.sort((a, b) => b.epoch - a.epoch)).filter((r) => {
      const k = r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
      if (claimed.has(k)) return false; claimed.add(k); return true;
    });
    const items: IntelItem[] = merged.map((r) => {
      const rule = applyRules(def.id, r.title);
      const it: IntelItem = { ...r, ageH: Math.round(((nowSec - r.epoch) / 3600) * 10) / 10, ...rule };
      if (def.id === "trump") it.status = trumpStatus(r);
      return it;
    }).sort((a, b) => a.ageH - b.ageH);
    // Recency-weighted: an item counts half as much every 8 h, so breaking news outweighs yesterday's.
    const w = (i: IntelItem) => Math.pow(0.5, i.ageH / 8);
    const net = items.reduce((s, i) => s + i.dir * w(i), 0), mass = items.reduce((s, i) => s + Math.abs(i.dir) * w(i), 0);
    const dir: -1 | 0 | 1 = mass > 0 && Math.abs(net) / mass >= 0.25 ? sign(net) : 0;
    const segNet = new Map<string, number>();
    for (const i of items) { i.pos.forEach((x) => segNet.set(x, (segNet.get(x) || 0) + w(i))); i.neg.forEach((x) => segNet.set(x, (segNet.get(x) || 0) - w(i))); }
    const segList = (k: 1 | -1) => [...segNet.entries()].filter(([, v]) => v * k > 1e-6).sort((x, y) => (y[1] - x[1]) * k).slice(0, 4).map(([n]) => n);
    const event = items.some((i) => i.dir === 0 && i.note && /key event|will set/.test(i.note));
    const directional = items.filter((i) => i.dir !== 0 && i.note);
    const tone = !items.length ? "NO FRESH NEWS" : dir === 0 && event ? "EVENT AHEAD" : !directional.length ? "NEUTRAL" : TONE[String(dir)];
    const generic = (n: string | null) => !n || /market tone$/.test(n);
    const lead = directional.filter((i) => dir === 0 || i.dir === dir).sort((x, y) => w(y) - w(x))[0];
    const opp = dir !== 0 ? directional.filter((i) => i.dir === -dir).sort((x, y) => w(y) - w(x))[0] : undefined;
    const say = (i: IntelItem) => (generic(i.note) ? i.title.replace(/[.?!\s]+$/, "") : i.note as string);
    const eventItem = items.find((i) => i.dir === 0 && i.note && /key event|will set/.test(i.note));
    const parts: string[] = [];
    if (lead) parts.push(say(lead));
    if (eventItem && !parts.includes(eventItem.note as string)) parts.push(eventItem.note as string);
    if (opp && say(opp) !== parts[0]) parts.push(`Against: ${say(opp)}`);
    if (!parts.length && items.length) { const n = items.find((i) => i.note); parts.push(n ? `${n.note} (${n.title.replace(/[.?!\s]+$/, "")})` : `Latest: ${items[0].title.replace(/[.?!\s]+$/, "")}`); }
    const summary = !items.length ? `No fresh ${def.label.toLowerCase()} news since ${fmtIst(ws)}.`
      : parts.length ? parts.join(". ") + "." : `${items.length} fresh headline${items.length > 1 ? "s" : ""}; none with a clear market effect.`;
    categories.push({ id: def.id, label: def.label, count: items.length, dir, tone, summary, pos: segList(1), neg: segList(-1), items: items.slice(0, 8) });
  }
  // keep the screen order fixed (by CATS), not the weight order used for claiming
  categories.sort((a, b) => CATS.findIndex((c) => c.id === a.id) - CATS.findIndex((c) => c.id === b.id));

  const wOf = (id: IntelCat) => CATS.find((c) => c.id === id)!.weight;
  const score = Math.round(categories.reduce((s, c) => s + c.dir * wOf(c.id), 0) * 10) / 10;
  const label = score >= 3 ? "POSITIVE" : score >= 1 ? "CAUTIOUS POSITIVE" : score <= -3 ? "NEGATIVE" : score <= -1 ? "CAUTIOUS NEGATIVE" : "MIXED";
  const keyPoints = categories.filter((c) => c.items.length)
    .sort((a, b) => wOf(b.id) * (Math.abs(b.dir) + 0.5) - wOf(a.id) * (Math.abs(a.dir) + 0.5))
    .slice(0, 6).map((c) => {
      const top = c.items.find((i) => i.dir === c.dir && i.dir !== 0 && i.note) || c.items.find((i) => i.note) || c.items[0];
      return { cat: c.id, label: c.label, dir: c.dir, text: top.title, note: top.note, source: top.source, ageH: top.ageH };
    });

  // segments across categories, weighted by category weight; a segment on both sides nets out
  const segW = new Map<string, { w: number; pos: [number, string]; neg: [number, string] }>();
  for (const c of categories) for (const it of c.items) {
    if (!it.note) continue;
    const rw = wOf(c.id) * Math.pow(0.5, it.ageH / 8), why = `${c.label}: ${it.note}`;
    const add = (name: string, v: number) => {
      const p = segW.get(name) || { w: 0, pos: [0, ""] as [number, string], neg: [0, ""] as [number, string] }; p.w += v;
      if (v > p.pos[0]) p.pos = [v, why]; if (-v > p.neg[0]) p.neg = [-v, why]; segW.set(name, p);
    };
    it.pos.forEach((s) => add(s, rw)); it.neg.forEach((s) => add(s, -rw));
  }
  const segs = [...segW.entries()].filter(([n]) => n !== "Broad market");
  const positive = segs.filter(([, v]) => v.w > 1e-6).sort((a, b) => b[1].w - a[1].w).slice(0, 5).map(([name, v]) => ({ name, why: v.pos[1] }));
  const negative = segs.filter(([, v]) => v.w < -1e-6).sort((a, b) => a[1].w - b[1].w).slice(0, 5).map(([name, v]) => ({ name, why: v.neg[1] }));

  return {
    asOf: nowSec, windowStart: ws, windowHours: Math.round((nowSec - ws) / 360) / 10,
    direction: { score, label, positive: categories.filter((c) => c.dir > 0).length, negative: categories.filter((c) => c.dir < 0).length },
    keyPoints, segments: { positive, negative }, categories, sources,
  };
}
function fmtIst(sec: number): string {
  const d = new Date((sec + IST) * 1000);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} IST`;
}

// ---------------- network ----------------
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function getText(url: string): Promise<string | null> {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000);
  try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, application/json, text/xml, */*" } as any, signal: ctrl.signal }); return r.ok ? await r.text() : null; }
  catch { return null; } finally { clearTimeout(to); }
}
function googleNewsUrl(q: string, days: number): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
}

async function fetchIntel(): Promise<IntelResult> {
  const now = Math.floor(Date.now() / 1000);
  const days = Math.max(1, Math.ceil((now - windowStart(now)) / 86400));
  const raw = Object.fromEntries(CATS.map((c) => [c.id, [] as RawItem[]])) as Record<IntelCat, RawItem[]>;
  const sources: IntelResult["sources"] = [];
  const jobs: Promise<void>[] = [];
  for (const o of OFFICIAL) jobs.push((async () => {
    const t = await getText(o.url);
    let items: RawItem[] = [];
    if (t) { try { items = o.json ? parseFedRegister(JSON.parse(t)) : parseRss(t, o.name, "OFFICIAL", o.kind); } catch { items = []; } }
    raw[o.cat].push(...items); sources.push({ name: o.name, ok: !!t, items: items.length });
  })());
  for (const c of CATS) for (const q of c.queries) jobs.push((async () => {
    const t = await getText(googleNewsUrl(q, days));
    const items = t ? parseRss(t, "Google News", "MEDIA") : [];
    raw[c.id].push(...items); sources.push({ name: `News search: ${c.label}`, ok: !!t, items: items.length });
  })());
  await Promise.allSettled(jobs);
  const merged = new Map<string, { name: string; ok: boolean; items: number }>();
  for (const s of sources) { const p = merged.get(s.name); if (p) { p.ok = p.ok || s.ok; p.items += s.items; } else merged.set(s.name, { ...s }); }
  return buildIntel(raw, now, [...merged.values()]);
}

let cache: { at: number; data: IntelResult } | null = null;
let inflight: Promise<IntelResult> | null = null;
const TTL_MS = 5 * 60_000;
/** Cached 5 min; a stale copy is served while one shared refresh runs. */
export async function getNewsIntel(force = false): Promise<IntelResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!inflight) inflight = fetchIntel().then((d) => { cache = { at: Date.now(), data: d }; return d; }).finally(() => { inflight = null; });
  if (!force && cache) { inflight.catch(() => null); return cache.data; }
  return inflight;
}
