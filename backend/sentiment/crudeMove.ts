// ============================ CRUDE OIL — Brent (USD/bbl) card + last 4 trading hours + next-hour history ============================
// Brent = Yahoo BZ=F front-month future (daily 1 y for 52-week / YTD / 1M, 5-min bars for the last 4 h); the MCX CRUDEOIL
// front month (₹/bbl, Dhan) is shown alongside for Indian traders.
//   last 4 h  = the last 48 five-min bars (4 trading hours; may span the previous evening session)
//   trend     = 5-min EMA 9 vs EMA 21 and price vs EMA 21
//   next hour = HISTORY, not a forecast: over the fetched days, every hour-end where the previous 4 h moved the same way
//               and by a similar size (above / below the median 4-h move) — how often the NEXT hour closed higher / lower.
//               Shown next to the all-hours base rate so the user can see whether the condition adds anything.
import { fetchDhanIntradayAllHours } from "../data/dhanHistorical";
import { crudeContracts, frontContract, mcxCrudeLive } from "./dhanMarketExtras";
import YahooFinance from "yahoo-finance2";
import type { Candle } from "../types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface CrudeMove {
  available: boolean; reason?: string; contract?: string; price?: number; priceTs?: number; live?: boolean;
  last4h?: { from: number; to: number; change: number; changePct: number; high: number; low: number; hourly: { end: number; change: number }[] };
  trend?: { state: "UP" | "DOWN" | "MIXED"; ema9: number; ema21: number };
  nextHour?: { condition: string; n: number; upPct: number; downPct: number; avgMove: number; baseN: number; baseUpPct: number; days: number } | null;
}

/** Pure analysis of 5-min bars (oldest first). `live` overrides the last close for the displayed price. */
export function analyseCrude(bars: Candle[], live?: { value: number; ts: number } | null): Omit<CrudeMove, "contract"> {
  const b = bars.filter((x) => x && x.close > 0).sort((x, y) => x.time - y.time);
  if (b.length < 49) return { available: false, reason: "not enough MCX crude bars" };
  const n = b.length, c = b.map((x) => x.close), last = b[n - 1], win = b.slice(n - 48), ref = c[n - 49];
  const hourly = [0, 1, 2, 3].map((h) => { const seg = win.slice(h * 12, h * 12 + 12), prev = h ? win[h * 12 - 1].close : ref; return { end: seg[seg.length - 1].time + 300, change: r2(seg[seg.length - 1].close - prev) }; });
  // the LTP counts as live only while MCX is trading (within 15 min of the last bar); otherwise show the last close and its time
  if (live && live.ts - (last.time + 300) > 900) live = null;
  const e9 = ema(c, 9), e21 = ema(c, 21), px = live?.value ?? last.close;
  const state = e9[n - 1] > e21[n - 1] && last.close > e21[n - 1] ? "UP" : e9[n - 1] < e21[n - 1] && last.close < e21[n - 1] ? "DOWN" : "MIXED";
  // history: hour-end samples where the next 12 bars are continuous (no session break inside the next hour)
  const samples: { r4: number; next: number }[] = [];
  for (let j = 48; j + 12 < n - 1; j += 12) if (b[j + 12].time - b[j].time <= 3600 + 300) samples.push({ r4: c[j] / c[j - 48] - 1, next: c[j + 12] - c[j] });
  const cur = last.close / ref - 1, abs = samples.map((s) => Math.abs(s.r4)).sort((x, y) => x - y), med = abs.length ? abs[Math.floor(abs.length / 2)] : 0, big = Math.abs(cur) >= med;
  const like = samples.filter((s) => Math.sign(s.r4) === Math.sign(cur) && (Math.abs(s.r4) >= med) === big), pct = (xs: typeof samples, f: (s: { next: number }) => boolean) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 100) : 0);
  const nextHour = like.length >= 20 ? {
    condition: `previous 4 h ${cur >= 0 ? "up" : "down"} ${big ? "≥" : "<"} ${(med * 100).toFixed(2)} % (median 4-h move)`, n: like.length,
    upPct: pct(like, (s) => s.next > 0), downPct: pct(like, (s) => s.next < 0), avgMove: r2(like.reduce((a, s) => a + s.next, 0) / like.length),
    baseN: samples.length, baseUpPct: pct(samples, (s) => s.next > 0), days: new Set(b.map((x) => istDay(x.time))).size } : null;
  return { available: true, price: px, priceTs: live?.ts ?? last.time + 300, live: !!live,
    last4h: { from: win[0].time, to: last.time + 300, change: r2(last.close - ref), changePct: r2(cur * 100), high: Math.max(...win.map((x) => x.high)), low: Math.min(...win.map((x) => x.low)), hourly },
    trend: { state, ema9: r2(e9[n - 1]), ema21: r2(e21[n - 1]) }, nextHour };
}

/** Live: front-month 5-min bars for the last ~60 days + the live LTP. */
export async function crudeMove(): Promise<CrudeMove> {
  const now = Math.floor(Date.now() / 1000), fc = frontContract(crudeContracts(), istDay(now));
  if (!fc) return { available: false, reason: "no MCX crude contract in the instrument master" };
  const bars = await fetchDhanIntradayAllHours({ securityId: fc.securityId, exchangeSegment: "MCX_COMM", instrument: "FUTCOM" }, "5", istDay(now - 60 * 86400), istDay(now + 86400));
  const live = await mcxCrudeLive().catch(() => null);
  return { ...analyseCrude(bars, live && live.contract === fc.name ? live : null), contract: fc.name };
}

export interface BrentCard extends Omit<CrudeMove, "contract"> {
  source: string; currency: "USD"; change?: number; changePct?: number; prevClose?: number; high52?: number; low52?: number; ytdPct?: number | null; m1Pct?: number | null;
  spark?: [number, number][]; mcx?: { price: number; contract: string } | null;
}
type Q = { date: Date; open: number | null; high: number | null; low: number | null; close: number | null; volume?: number | null };
// drops Yahoo's partial "now" row (a timestamp off the bar grid, e.g. 20:59:19)
const toBars = (qs: Q[]): Candle[] => qs.filter((q) => q.close != null && q.close > 0 && (+q.date / 1000) % 60 === 0).map((q) => ({ time: Math.floor(+q.date / 1000), open: q.open ?? q.close!, high: q.high ?? q.close!, low: q.low ?? q.close!, close: q.close!, volume: q.volume ?? 0 }));

/** Pure: the card numbers from daily bars (oldest first) and the latest price; `nowSec` = the time of that price
 *  (so on a weekend the change is Friday's change vs Thursday's close, not zero). */
export function brentStats(daily: Candle[], price: number, nowSec: number) {
  const d = daily.filter((x) => x.close > 0).sort((a, b) => a.time - b.time), today = istDay(nowSec);
  // the price belongs to the last daily bar's session when it is within 24 h of that bar's start → compare with the bar before
  const lastBar = d[d.length - 1], inLast = nowSec >= lastBar.time && nowSec - lastBar.time < 86400, prev = inLast ? d[d.length - 2] : lastBar, yr = d.filter((x) => x.time >= nowSec - 365 * 86400);
  const ytdRef = [...d].reverse().find((x) => istDay(x.time).slice(0, 4) < today.slice(0, 4)), m1Ref = [...d].reverse().find((x) => x.time <= nowSec - 30 * 86400);
  const pct = (ref?: Candle) => (ref ? r2((price / ref.close - 1) * 100) : null);
  return { prevClose: prev?.close, change: prev ? r2(price - prev.close) : undefined, changePct: prev ? r2((price / prev.close - 1) * 100) : undefined,
    high52: Math.max(...yr.map((x) => x.high), price), low52: Math.min(...yr.map((x) => x.low), price), ytdPct: pct(ytdRef), m1Pct: pct(m1Ref),
    spark: d.filter((x) => x.time >= nowSec - 31 * 86400).map((x) => [x.time, r2(x.close)] as [number, number]) };
}

/** Live Brent card. */
export async function brentCard(): Promise<BrentCard> {
  const now = Math.floor(Date.now() / 1000);
  const [day, m5]: any[] = await Promise.all([
    yf.chart("BZ=F", { period1: new Date((now - 400 * 86400) * 1000), interval: "1d" }),
    yf.chart("BZ=F", { period1: new Date((now - 55 * 86400) * 1000), interval: "5m" }).catch(() => null),
  ]);
  const daily = toBars(day?.quotes || []), price = Number(day?.meta?.regularMarketPrice) || daily[daily.length - 1]?.close;
  if (!price || daily.length < 30) return { available: false, reason: "Brent data unavailable", source: "Yahoo BZ=F", currency: "USD" };
  const pts = Number(day?.meta?.regularMarketTime) ? Math.floor(+new Date(day.meta.regularMarketTime) / 1000) : now;
  // "live" only while Brent is trading (the price is under 15 minutes old)
  const intra = analyseCrude(toBars(m5?.quotes || []), now - pts <= 900 ? { value: price, ts: pts } : null);
  const mcx = await (async () => { const fc = frontContract(crudeContracts(), istDay(now)), l = await mcxCrudeLive().catch(() => null); return l && fc && l.contract === fc.name ? { price: l.value, contract: l.contract } : null; })();
  return { ...intra, available: true, price, priceTs: pts, live: now - pts <= 900, ...brentStats(daily, price, pts), source: "Yahoo BZ=F (Brent front-month future)", currency: "USD", mcx };
}
