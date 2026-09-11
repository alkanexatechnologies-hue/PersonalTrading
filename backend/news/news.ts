// Market news aggregator.
//
// Pulls India-focused market headlines from public RSS feeds (Economic Times,
// Moneycontrol, Business Standard, LiveMint), parses them, and tags each item
// with a lightweight keyword SENTIMENT (positive/negative/neutral) and an
// IMPACT flag (does it mention a market-moving event: RBI/Fed/inflation/results
// /crude/FII etc.). Results are deduped, sorted newest-first and cached ~5 min.
//
// This is INFORMATIONAL only - it is deliberately NOT wired into the paper-trade
// entry logic (headline sentiment is noisy and lags price). It powers the News
// panel and a market-bias summary the user can read alongside the signals.

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedEpoch: number; // seconds; 0 if unknown
  ago: string;            // human "12m ago"
  sentiment: "positive" | "negative" | "neutral";
  impact: "high" | "normal";
  tags: string[];         // matched event keywords (RBI, Results, Crude...)
}

export interface NewsResult {
  asOf: number;
  items: NewsItem[];
  summary: { total: number; positive: number; negative: number; neutral: number; highImpact: number; bias: "Bullish" | "Bearish" | "Neutral" };
}

interface Feed { source: string; url: string; }

const FEEDS: Feed[] = [
  { source: "ET Markets", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms" },
  { source: "Moneycontrol", url: "https://www.moneycontrol.com/rss/business.xml" },
  { source: "Moneycontrol Mkts", url: "https://www.moneycontrol.com/rss/marketreports.xml" },
  { source: "Business Standard", url: "https://www.business-standard.com/rss/markets-106.rss" },
  { source: "LiveMint", url: "https://www.livemint.com/rss/markets" },
];

// ---- sentiment + impact keyword lexicons (lowercase) ----
const POSITIVE = ["surge", "surges", "jump", "jumps", "rally", "rallies", "gain", "gains", "rise", "rises", "soar", "soars", "record high", "all-time high", "52-week high", "beat", "beats", "upgrade", "outperform", "bullish", "profit", "profits", "boost", "buy", "multibagger", "strong", "rebound", "recovery", "up "];
const NEGATIVE = ["fall", "falls", "plunge", "plunges", "slump", "slumps", "crash", "crashes", "drop", "drops", "decline", "declines", "tumble", "tumbles", "slide", "sinks", "loss", "losses", "downgrade", "underperform", "bearish", "cut", "cuts", "miss", "misses", "probe", "fraud", "ban", "selloff", "sell-off", "weak", "warning", "default", "layoff", "52-week low", "record low", "down "];
// Market-moving event tags -> impact = high
const IMPACT_TAGS: Array<{ tag: string; kws: string[] }> = [
  { tag: "RBI", kws: ["rbi", "repo rate", "monetary policy", "mpc"] },
  { tag: "Fed", kws: ["fed", "fomc", "powell", "us federal reserve"] },
  { tag: "Inflation", kws: ["inflation", "cpi", "wpi"] },
  { tag: "GDP", kws: ["gdp", "growth rate"] },
  { tag: "Rates", kws: ["rate hike", "rate cut", "interest rate", "bond yield"] },
  { tag: "Budget", kws: ["budget", "fiscal", "gst"] },
  { tag: "Results", kws: ["q1 ", "q2 ", "q3 ", "q4 ", "results", "earnings", "profit ", "net profit"] },
  { tag: "Crude", kws: ["crude", "oil price", "brent", "opec"] },
  { tag: "FII/DII", kws: ["fii", "dii", "foreign investor", "fpi"] },
  { tag: "Global", kws: ["us market", "dow", "nasdaq", "tariff", "war", "geopolit"] },
  { tag: "Rupee", kws: ["rupee", "forex", "dollar index"] },
  { tag: "IPO", kws: ["ipo", "listing", "gmp"] },
];

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "") // strip any stray HTML tags
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ").trim();
}

function tag(el: string, xml: string): string {
  const m = xml.match(new RegExp(`<${el}[^>]*>([\\s\\S]*?)</${el}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function timeAgo(epoch: number): string {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function classify(title: string): { sentiment: NewsItem["sentiment"]; impact: NewsItem["impact"]; tags: string[] } {
  const t = " " + title.toLowerCase() + " ";
  let pos = 0, neg = 0;
  for (const w of POSITIVE) if (t.includes(w)) pos++;
  for (const w of NEGATIVE) if (t.includes(w)) neg++;
  const sentiment = pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
  const tags: string[] = [];
  for (const { tag: tg, kws } of IMPACT_TAGS) if (kws.some((k) => t.includes(k))) tags.push(tg);
  return { sentiment, impact: tags.length ? "high" : "normal", tags };
}

async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NSA/1.0)" } as any, signal: ctrl.signal });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: NewsItem[] = [];
    for (const raw of xml.split(/<item[ >]/i).slice(1)) {
      const block = raw.slice(0, raw.search(/<\/item>/i) >= 0 ? raw.search(/<\/item>/i) : raw.length);
      const title = tag("title", block);
      if (!title) continue;
      let link = tag("link", block);
      if (!link) { const g = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i); if (g) link = decodeEntities(g[1]); }
      const pub = tag("pubDate", block) || tag("dc:date", block);
      const ts = pub ? Date.parse(pub) : NaN;
      const epoch = isNaN(ts) ? 0 : Math.floor(ts / 1000);
      const { sentiment, impact, tags } = classify(title);
      items.push({ title, link, source: feed.source, publishedEpoch: epoch, ago: timeAgo(epoch), sentiment, impact, tags });
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(to);
  }
}

let cache: { at: number; data: NewsResult } | null = null;
const TTL_MS = 5 * 60_000;

export async function getMarketNews(force = false): Promise<NewsResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all: NewsItem[] = [];
  for (const r of settled) if (r.status === "fulfilled") all.push(...r.value);
  // dedupe by normalized title (keep the newest)
  const seen = new Map<string, NewsItem>();
  for (const it of all) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    const prev = seen.get(key);
    if (!prev || it.publishedEpoch > prev.publishedEpoch) seen.set(key, it);
  }
  const items = [...seen.values()].sort((a, b) => b.publishedEpoch - a.publishedEpoch).slice(0, 40);
  const positive = items.filter((i) => i.sentiment === "positive").length;
  const negative = items.filter((i) => i.sentiment === "negative").length;
  const neutral = items.length - positive - negative;
  const highImpact = items.filter((i) => i.impact === "high").length;
  const bias = positive > negative * 1.3 ? "Bullish" : negative > positive * 1.3 ? "Bearish" : "Neutral";
  const data: NewsResult = { asOf: Math.floor(Date.now() / 1000), items, summary: { total: items.length, positive, negative, neutral, highImpact, bias } };
  cache = { at: Date.now(), data };
  return data;
}
