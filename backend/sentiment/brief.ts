// ============================ Market Sentiment Brief (Market Command strip) ============================
// MARKET CONTEXT ONLY — never a trade trigger, never read by the arbiter or the
// paper engine. Morning (before 09:15 IST): the overnight view — US close + US
// futures, Asia, Europe, crude, gold, rupee, dollar, US yields, VIX. During the
// session: Indian market sentiment per index from CLOSED 5m candles (candles
// starting at/after 15:15 are ignored — the trader's day ends then), plus India
// VIX. Always: RBI / government-policy headlines. Every number is real (provider
// timestamped) or shown as unavailable — nothing is estimated or fabricated.

import type { Candle } from "../types";
import type { Quote } from "./types";
import { ema, vwap } from "../indicators";
import { TRADING_END_MIN } from "../decision/types";

export type Lean = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED";
export type BriefPhase = "PRE_MARKET" | "LIVE" | "DAY_END" | "CLOSED";

export interface CueFactor { name: string; value: number | null; changePct: number | null; effect: -1 | 0 | 1; note: string; freshness: string; }
export interface GlobalCues { lean: Lean; score: number | null; factors: CueFactor[]; positives: string[]; negatives: string[]; }

export interface IndexSentiment {
  index: string; label: string;
  last: number | null; prevClose: number | null; changePct: number | null;
  gapPct: number | null; aboveVwap: boolean | null; emaUp: boolean | null;
  dayHigh: number | null; dayLow: number | null; posInRange: number | null;   // 0 = day low, 1 = day high
  lean: Lean; reasons: string[]; candleTime: number | null;
  bias: { state: string; message: string } | null;   // Market Bias Shift (arbiter), when decided
}
export interface IndiaSentiment { lean: Lean; summary: string; indices: IndexSentiment[]; vix: Quote | null; reasons: string[]; }

export interface PolicyItem { title: string; source: string; ago: string; publishedEpoch: number; tags: string[]; sentiment: string; link: string; }

export interface SentimentBrief {
  ts: number; phase: BriefPhase; headline: string;
  global: { us: Quote[]; usFutures: Quote | null; asia: Quote[]; europe: Quote[]; cues: GlobalCues };
  macro: { brent: Quote | null; wti: Quote | null; gold: Quote | null; usdinr: Quote | null; dxy: Quote | null; us10y: Quote | null; cboeVix: Quote | null };
  india: IndiaSentiment;
  policy: { items: PolicyItem[]; rbi: number; govt: number };
  provider: string; note: string;
}

const IST = 19800;
const istMin = (t: number) => { const d = new Date((t + IST) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const has = (q?: Quote | null): q is Quote => !!q && q.value != null && q.changePct != null && q.freshness !== "UNAVAILABLE" && q.freshness !== "DISCONNECTED";

export function briefPhase(nowSec: number): BriefPhase {
  const d = new Date((nowSec + IST) * 1000), dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return "CLOSED";
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m < 9 * 60 + 15) return "PRE_MARKET";
  if (m < TRADING_END_MIN) return "LIVE";
  return "DAY_END";
}

const avgPct = (qs: (Quote | null | undefined)[]) => { const v = qs.filter(has).map((q) => q.changePct as number); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };

/** Overnight / global cues for Indian equities. Each factor votes −1/0/+1 with a
 *  stated threshold; the lean is the weighted sum. Risk-off inputs (crude, dollar,
 *  rupee weakness, US yields, VIX) count AGAINST Indian equities when they rise. */
export function globalCues(md: Record<string, Quote>): GlobalCues {
  const f: CueFactor[] = [];
  const add = (name: string, q: Quote | null, pct: number | null, thr: number, invert: boolean, upNote: string, downNote: string, weight = 1) => {
    if (pct == null) { f.push({ name, value: q?.value ?? null, changePct: null, effect: 0, note: "unavailable", freshness: q?.freshness ?? "UNAVAILABLE" }); return 0; }
    let e: -1 | 0 | 1 = pct > thr ? 1 : pct < -thr ? -1 : 0;
    const note = e === 0 ? "flat" : e > 0 ? upNote : downNote;
    if (invert) e = (-e) as -1 | 0 | 1;
    if (weight === 0) e = 0;   // shown for context, not scored
    f.push({ name, value: q?.value ?? null, changePct: pct, effect: e, note, freshness: q?.freshness ?? "UNAVAILABLE" });
    return e * weight;
  };
  const usClose = avgPct([md.SPX, md.NASDAQ, md.DOW]);
  const asia = avgPct([md.NIKKEI, md.HANGSENG, md.SHANGHAI, md.KOSPI, md.TAIWAN]);
  const europe = avgPct([md.FTSE, md.DAX, md.CAC]);
  let s = 0, w = 0;
  const vote = (v: number, wt: number, avail: boolean) => { s += v; if (avail) w += wt; };
  vote(add("US markets", md.SPX ?? null, usClose, 0.3, false, "US closed higher", "US closed lower", 1.5), 1.5, usClose != null);
  vote(add("US futures", md.USFUT ?? null, has(md.USFUT) ? md.USFUT.changePct : null, 0.25, false, "US futures up", "US futures down"), 1, has(md.USFUT));
  vote(add("Asia", md.NIKKEI ?? null, asia, 0.4, false, "Asian markets up", "Asian markets down", 1.5), 1.5, asia != null);
  vote(add("Europe", md.DAX ?? null, europe, 0.3, false, "Europe up", "Europe down"), 1, europe != null);
  vote(add("Crude (Brent)", md.BRENT ?? null, has(md.BRENT) ? md.BRENT.changePct : null, 1.0, true, "crude rising — costlier imports", "crude falling — eases inflation"), 1, has(md.BRENT));
  vote(add("USD/INR", md.USDINR ?? null, has(md.USDINR) ? md.USDINR.changePct : null, 0.2, true, "rupee weakening", "rupee strengthening"), 1, has(md.USDINR));
  vote(add("Dollar index", md.DXY ?? null, has(md.DXY) ? md.DXY.changePct : null, 0.3, true, "dollar stronger — FII outflow risk", "dollar weaker — supports EM flows", 0.5), 0.5, has(md.DXY));
  vote(add("US 10Y yield", md.US10Y ?? null, has(md.US10Y) ? md.US10Y.changePct : null, 1.0, true, "US yields up", "US yields down", 0.5), 0.5, has(md.US10Y));
  vote(add("CBOE VIX", md.CBOEVIX ?? null, has(md.CBOEVIX) ? md.CBOEVIX.changePct : null, 5, true, "global fear rising", "global fear easing", 0.5), 0.5, has(md.CBOEVIX));
  add("Gold", md.GOLD ?? null, has(md.GOLD) ? md.GOLD.changePct : null, 1.0, false, "gold up (safe-haven demand)", "gold down", 0);   // shown, not scored
  const score = w ? r2(s / w) : null;
  const lean: Lean = score == null ? "NEUTRAL" : score >= 0.25 ? "BULLISH" : score <= -0.25 ? "BEARISH" : f.some((x) => x.effect > 0) && f.some((x) => x.effect < 0) ? "MIXED" : "NEUTRAL";
  return {
    lean, score, factors: f,
    positives: f.filter((x) => x.effect > 0).map((x) => `${x.name}: ${x.note}${x.changePct != null ? ` (${x.changePct > 0 ? "+" : ""}${x.changePct.toFixed(2)}%)` : ""}`),
    negatives: f.filter((x) => x.effect < 0).map((x) => `${x.name}: ${x.note}${x.changePct != null ? ` (${x.changePct > 0 ? "+" : ""}${x.changePct.toFixed(2)}%)` : ""}`),
  };
}

/** Indian index sentiment from CLOSED 5m candles of the latest session (no look-ahead). */
export function indexSentiment(index: string, label: string, candles: Candle[], nowSec: number): IndexSentiment {
  const empty: IndexSentiment = { index, label, last: null, prevClose: null, changePct: null, gapPct: null, aboveVwap: null, emaUp: null,
    dayHigh: null, dayLow: null, posInRange: null, lean: "NEUTRAL", reasons: ["no candles"], candleTime: null, bias: null };
  const closed = (candles || []).filter((c) => c.time + 300 <= nowSec && istMin(c.time) < TRADING_END_MIN);
  if (!closed.length) return empty;
  const lastC = closed[closed.length - 1], day = istDay(lastC.time);
  const today = closed.filter((c) => istDay(c.time) === day);
  const prior = closed.filter((c) => istDay(c.time) < day);
  const prevClose = prior.length ? prior[prior.length - 1].close : null;
  const last = lastC.close;
  const changePct = prevClose ? r2((last - prevClose) / prevClose * 100) : null;
  const gapPct = prevClose ? r2((today[0].open - prevClose) / prevClose * 100) : null;
  const vw = vwap(closed); const vwNow = vw[vw.length - 1];
  const closes = closed.map((c) => c.close);
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const a = e9[e9.length - 1], b = e21[e21.length - 1];
  const aboveVwap = vwNow != null ? last > vwNow : null;
  const emaUp = a != null && b != null ? a > b : null;
  const dayHigh = Math.max(...today.map((c) => c.high)), dayLow = Math.min(...today.map((c) => c.low));
  const posInRange = dayHigh > dayLow ? r2((last - dayLow) / (dayHigh - dayLow)) : null;
  let s = 0; const reasons: string[] = [];
  if (changePct != null) { s += changePct > 0.15 ? 1 : changePct < -0.15 ? -1 : 0; reasons.push(`${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% vs prev close`); }
  if (aboveVwap != null) { s += aboveVwap ? 1 : -1; reasons.push(aboveVwap ? "above VWAP" : "below VWAP"); }
  if (emaUp != null) { s += emaUp ? 1 : -1; reasons.push(emaUp ? "EMA9 > EMA21" : "EMA9 < EMA21"); }
  if (posInRange != null) { s += posInRange >= 0.7 ? 0.5 : posInRange <= 0.3 ? -0.5 : 0; reasons.push(posInRange >= 0.7 ? "near day high" : posInRange <= 0.3 ? "near day low" : "mid-range"); }
  const lean: Lean = s >= 2 ? "BULLISH" : s <= -2 ? "BEARISH" : s === 0 ? "NEUTRAL" : "MIXED";
  return { index, label, last, prevClose, changePct, gapPct, aboveVwap, emaUp, dayHigh, dayLow, posInRange, lean, reasons, candleTime: lastC.time, bias: null };
}

export function indiaSentiment(indices: IndexSentiment[], vix: Quote | null): IndiaSentiment {
  const known = indices.filter((x) => x.changePct != null);
  const bull = known.filter((x) => x.lean === "BULLISH").length, bear = known.filter((x) => x.lean === "BEARISH").length;
  const reasons: string[] = [];
  let lean: Lean = !known.length ? "NEUTRAL" : bull > known.length / 2 ? "BULLISH" : bear > known.length / 2 ? "BEARISH" : bull && bear ? "MIXED" : bull > bear ? "BULLISH" : bear > bull ? "BEARISH" : "NEUTRAL";
  if (known.length) reasons.push(`${bull} of ${known.length} indices bullish, ${bear} bearish`);
  if (has(vix)) {
    const v = vix.changePct as number;
    if (v >= 5) reasons.push(`India VIX +${v.toFixed(1)}% — fear rising, expect wider swings`);
    else if (v <= -5) reasons.push(`India VIX ${v.toFixed(1)}% — fear easing`);
    else reasons.push(`India VIX ${vix.value} (${v >= 0 ? "+" : ""}${v.toFixed(1)}%)`);
    if (v >= 5 && lean === "BULLISH") lean = "MIXED";
  }
  const shifts = indices.filter((x) => x.bias && /SHIFT|WEAKENING/.test(x.bias.state));
  for (const x of shifts) reasons.push(`${x.label}: ${x.bias!.state.replace(/_/g, " ")}`);
  const summary = !known.length ? "Indian index data not loaded yet"
    : `${lean === "BULLISH" ? "Bullish" : lean === "BEARISH" ? "Bearish" : lean === "MIXED" ? "Mixed" : "Neutral"} — ${known.map((x) => `${x.label} ${x.changePct! >= 0 ? "+" : ""}${x.changePct!.toFixed(2)}%`).join(" · ")}`;
  return { lean, summary, indices, vix, reasons };
}

export function briefHeadline(phase: BriefPhase, cues: GlobalCues, india: IndiaSentiment): string {
  const g = cues.lean === "BULLISH" ? "positive" : cues.lean === "BEARISH" ? "negative" : cues.lean === "MIXED" ? "mixed" : "neutral";
  if (phase === "PRE_MARKET") return `Morning view: global cues ${g} for India's open`;
  if (phase === "LIVE") return `Indian market: ${india.lean.toLowerCase()} · global cues ${g}`;
  if (phase === "DAY_END") return `Day end (15:15) — Indian market closed ${india.lean.toLowerCase()} · global cues ${g}`;
  return `Market closed — last session ${india.lean.toLowerCase()} · global cues ${g}`;
}
