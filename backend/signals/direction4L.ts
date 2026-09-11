import { Candle, OiAnalysis } from "../types";
import { atr, bollinger, ema, last, macd, rsi, supertrend, vwap } from "../indicators";
import { DIRECTION_THRESHOLD } from "./score";

/**
 * 4-Layer Direction Engine.
 *
 * Replaces flat indicator voting with a weighted, layered model:
 *   Layer 1  Market Structure  40%   (PDH/PDL, opening range, HH/HL vs LH/LL, day range position)
 *   Layer 2  Trend             25%   (EMA 9/21, Supertrend, VWAP)
 *   Layer 3  Derivatives       20%   (OI bias, OI-change buildup, futures buildup, IV skew)
 *   Layer 4  Momentum          15%   (RSI, MACD, Bollinger, Volume)
 *
 * Each layer averages its sub-signals (each a -1/0/+1 directional vote) into a
 * layer score in [-1,+1]; contribution = layerScore x weight. The final score is
 * the sum of contributions (-100..+100). Confidence blends |score| with how many
 * layers agree with the net direction.
 *
 * Layer-3 feasibility: futures BASIS (no live futures price) and OPTION VOLUME
 * (not in the chain) aren't available, so they're omitted - the remaining
 * derivatives sub-signals carry the layer.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

export interface SubSignal { name: string; dir: -1 | 0 | 1; note: string; }
export interface DirLayer { key: string; name: string; weight: number; score: number; contribution: number; sub: SubSignal[]; }
export interface Direction4LResult {
  symbol: string; name: string; price: number; asOf: number;
  direction: "Bullish" | "Bearish" | "Neutral";
  score: number;       // -100..+100
  confidence: number;  // 0..100
  layers: DirLayer[];
  reasons: string[];
  disclaimer: string;
}

const WEIGHTS = { structure: 40, trend: 25, derivatives: 20, momentum: 15 };

function prevDay(daily: Candle[], todayIso: string): Candle | null {
  for (let i = daily.length - 1; i >= 0; i--) if (istDateOf(daily[i].time) < todayIso) return daily[i];
  return daily.length ? daily[daily.length - 1] : null;
}

// last two swing highs / lows via a 2-bar fractal over the recent window
function swingStructure(bars: Candle[]): { hh: boolean; hl: boolean; lh: boolean; ll: boolean } {
  const win = bars.slice(-40);
  const highs: number[] = [], lows: number[] = [];
  for (let i = 2; i < win.length - 2; i++) {
    const h = win[i].high, l = win[i].low;
    if (h >= win[i - 1].high && h >= win[i - 2].high && h >= win[i + 1].high && h >= win[i + 2].high) highs.push(h);
    if (l <= win[i - 1].low && l <= win[i - 2].low && l <= win[i + 1].low && l <= win[i + 2].low) lows.push(l);
  }
  const hh = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2];
  const lh = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
  return { hh, hl, lh, ll };
}

const layerScore = (sub: SubSignal[]): number => {
  if (!sub.length) return 0;
  const s = sub.reduce((a, b) => a + b.dir, 0) / sub.length;
  return Math.round(s * 100) / 100;
};

export function computeDirection4L(symbol: string, name: string, c15: Candle[], daily: Candle[], oi: OiAnalysis | null): Direction4LResult | null {
  if (!c15 || c15.length < 30 || !daily || daily.length < 2) return null;
  const closes = c15.map((c) => c.close);
  const price = closes[closes.length - 1];
  const asOf = c15[c15.length - 1].time;
  const todayIso = istDateOf(asOf);
  const pd = prevDay(daily, todayIso);
  const pdh = pd ? pd.high : Math.max(...daily.map((d) => d.high));
  const pdl = pd ? pd.low : Math.min(...daily.map((d) => d.low));

  const todayBars = c15.filter((c) => istDateOf(c.time) === todayIso).sort((a, b) => a.time - b.time);
  const dayHigh = todayBars.length ? Math.max(...todayBars.map((c) => c.high)) : price;
  const dayLow = todayBars.length ? Math.min(...todayBars.map((c) => c.low)) : price;
  const orBars = todayBars.filter((c) => istMin(c.time) >= 9 * 60 + 15 && istMin(c.time) < 9 * 60 + 45);
  const orHigh = orBars.length ? Math.max(...orBars.map((c) => c.high)) : null;
  const orLow = orBars.length ? Math.min(...orBars.map((c) => c.low)) : null;
  const atrDaily = last(atr(daily, 14)) ?? price * 0.01;
  const buffer = Math.max(price * 0.0005, 0.1 * atrDaily);

  // ---------------- Layer 1: Market Structure ----------------
  const l1: SubSignal[] = [];
  l1.push({ name: "PDH / PDL", dir: price > pdh + buffer ? 1 : price < pdl - buffer ? -1 : 0,
    note: price > pdh + buffer ? `Above PDH ${round2(pdh)} - breakout` : price < pdl - buffer ? `Below PDL ${round2(pdl)} - breakdown` : `Inside PDH-PDL (${round2(pdl)}-${round2(pdh)})` });
  if (orHigh != null && orLow != null) {
    l1.push({ name: "Opening range", dir: price > orHigh ? 1 : price < orLow ? -1 : 0,
      note: price > orHigh ? `Above OR high ${round2(orHigh)}` : price < orLow ? `Below OR low ${round2(orLow)}` : `Inside opening range` });
  } else {
    l1.push({ name: "Opening range", dir: 0, note: "Opening range not formed yet." });
  }
  const ss = swingStructure(c15);
  l1.push({ name: "HH-HL / LH-LL", dir: ss.hh && ss.hl ? 1 : ss.lh && ss.ll ? -1 : 0,
    note: ss.hh && ss.hl ? "Higher highs + higher lows (uptrend structure)" : ss.lh && ss.ll ? "Lower highs + lower lows (downtrend structure)" : "Mixed / range structure" });
  const dayRange = Math.max(1e-9, dayHigh - dayLow);
  const posInRange = (price - dayLow) / dayRange; // 0=at low, 1=at high
  l1.push({ name: "Day range position", dir: posInRange >= 0.75 ? 1 : posInRange <= 0.25 ? -1 : 0,
    note: `Trading in the ${posInRange >= 0.75 ? "TOP" : posInRange <= 0.25 ? "BOTTOM" : "middle"} of the day range (${Math.round(posInRange * 100)}%)` });

  // ---------------- Layer 2: Trend ----------------
  const l2: SubSignal[] = [];
  const ema9 = last(ema(closes, 9)), ema21 = last(ema(closes, 21));
  l2.push({ name: "EMA 9 / 21", dir: ema9 != null && ema21 != null ? (ema9 > ema21 ? 1 : ema9 < ema21 ? -1 : 0) : 0,
    note: ema9 != null && ema21 != null ? `EMA9 ${ema9 > ema21 ? "above" : "below"} EMA21` : "EMA unavailable" });
  const st = supertrend(c15, 10, 3); const stLast = st[st.length - 1];
  l2.push({ name: "Supertrend", dir: stLast ? (stLast.direction as -1 | 0 | 1) : 0,
    note: stLast && stLast.direction === 1 ? "Price above Supertrend (up)" : stLast && stLast.direction === -1 ? "Price below Supertrend (down)" : "Supertrend flat" });
  const vw = last(vwap(c15));
  l2.push({ name: "VWAP", dir: vw != null ? (price > vw ? 1 : price < vw ? -1 : 0) : 0,
    note: vw != null ? `Price ${price > vw ? "above" : "below"} VWAP ${round2(vw)}` : "VWAP unavailable" });

  // ---------------- Layer 3: Derivatives ----------------
  const l3: SubSignal[] = [];
  const oiOk = !!(oi && oi.available);
  const biasDir = oiOk ? (oi!.verdict.bias === "Bullish" ? 1 : oi!.verdict.bias === "Bearish" ? -1 : 0) : 0;
  l3.push({ name: "OI bias (PCR/levels)", dir: biasDir as -1 | 0 | 1, note: oiOk ? `Option OI ${oi!.verdict.bias} (PCR ${oi!.pcr ?? "-"})` : "OI unavailable" });
  // OI-change via CE/PE buildup
  let ocDir: -1 | 0 | 1 = 0; let ocNote = "OI-change neutral / unavailable";
  if (oiOk) {
    const ce = oi!.ceBuildup, pe = oi!.peBuildup;
    const bull = pe === "short buildup" || pe === "long unwinding" || ce === "long unwinding" || ce === "short covering";
    const bear = ce === "short buildup" || ce === "long buildup" || pe === "short covering";
    ocDir = bull && !bear ? 1 : bear && !bull ? -1 : 0;
    ocNote = `CE ${ce}, PE ${pe}`;
  }
  l3.push({ name: "Change in OI (buildup)", dir: ocDir, note: ocNote });
  // Futures buildup
  let futDir: -1 | 0 | 1 = 0; let futNote = "Futures buildup unavailable";
  if (oiOk && oi!.futBuildup) {
    const fb = oi!.futBuildup;
    futDir = fb === "Long buildup" || fb === "Short covering" ? 1 : fb === "Short buildup" || fb === "Long unwinding" ? -1 : 0;
    futNote = `Futures: ${fb}${oi!.futOiChangePct != null ? ` (OI ${oi!.futOiChangePct >= 0 ? "+" : ""}${oi!.futOiChangePct}%)` : ""}`;
  }
  l3.push({ name: "Futures buildup", dir: futDir, note: futNote });
  // IV skew (ATM CE IV vs PE IV)
  let ivDir: -1 | 0 | 1 = 0; let ivNote = "IV skew unavailable";
  if (oiOk && oi!.topStrikes?.length) {
    const spot = price;
    const atm = oi!.topStrikes.reduce((b: any, r: any) => (b == null || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), null as any);
    const ceIv = atm?.ceIv, peIv = atm?.peIv;
    if (ceIv != null && peIv != null && ceIv > 0 && peIv > 0) {
      const rel = (ceIv - peIv) / ((ceIv + peIv) / 2);
      ivDir = rel > 0.04 ? 1 : rel < -0.04 ? -1 : 0; // calls bid = bullish, puts bid = bearish
      ivNote = `ATM IV: CE ${round2(ceIv)} vs PE ${round2(peIv)} (${ivDir === 1 ? "calls bid" : ivDir === -1 ? "puts bid" : "balanced"})`;
    }
  }
  l3.push({ name: "IV skew", dir: ivDir, note: ivNote });

  // ---------------- Layer 4: Momentum ----------------
  const l4: SubSignal[] = [];
  const rsiVal = last(rsi(closes, 14));
  l4.push({ name: "RSI (14)", dir: rsiVal != null ? (rsiVal >= 55 ? 1 : rsiVal <= 45 ? -1 : 0) : 0,
    note: rsiVal != null ? `RSI ${Math.round(rsiVal)} - ${rsiVal >= 55 ? "bullish momentum" : rsiVal <= 45 ? "bearish momentum" : "neutral"}` : "RSI unavailable" });
  const hist = last(macd(closes).histogram);
  l4.push({ name: "MACD", dir: hist != null ? (hist > 0 ? 1 : hist < 0 ? -1 : 0) : 0, note: hist != null ? `MACD histogram ${round2(hist)}` : "MACD unavailable" });
  const bb = bollinger(closes, 20, 2); const bbMid = last(bb.middle);
  l4.push({ name: "Bollinger", dir: bbMid != null ? (price > bbMid ? 1 : price < bbMid ? -1 : 0) : 0, note: bbMid != null ? `Price ${price > bbMid ? "above" : "below"} BB mid ${round2(bbMid)}` : "BB unavailable" });
  // Volume confirmation (last bar body direction if volume is above average; indices have no volume)
  const vols = c15.map((c) => Number(c.volume) || 0);
  const totalVol = vols.reduce((a, b) => a + b, 0);
  let volDir: -1 | 0 | 1 = 0; let volNote = "No volume feed (index) - neutral";
  if (totalVol > 0) {
    const avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const lastBar = c15[c15.length - 1];
    const rvol = avg > 0 ? (Number(lastBar.volume) || 0) / avg : 0;
    if (rvol >= 1.2) volDir = lastBar.close >= lastBar.open ? 1 : -1;
    volNote = `RVol ${round2(rvol)}x - ${volDir === 1 ? "buying volume" : volDir === -1 ? "selling volume" : "no volume confirmation"}`;
  }
  l4.push({ name: "Volume", dir: volDir, note: volNote });

  // ---------------- combine ----------------
  const layers: DirLayer[] = [
    { key: "structure", name: "Market Structure", weight: WEIGHTS.structure, sub: l1, score: layerScore(l1), contribution: 0 },
    { key: "trend", name: "Trend", weight: WEIGHTS.trend, sub: l2, score: layerScore(l2), contribution: 0 },
    { key: "derivatives", name: "Derivatives", weight: WEIGHTS.derivatives, sub: l3, score: layerScore(l3), contribution: 0 },
    { key: "momentum", name: "Momentum", weight: WEIGHTS.momentum, sub: l4, score: layerScore(l4), contribution: 0 },
  ];
  layers.forEach((L) => { L.contribution = round2(L.score * L.weight); });
  const score = Math.max(-100, Math.min(100, Math.round(layers.reduce((s, L) => s + L.contribution, 0))));
  const direction: Direction4LResult["direction"] = score >= DIRECTION_THRESHOLD ? "Bullish" : score <= -DIRECTION_THRESHOLD ? "Bearish" : "Neutral";

  const netSign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const layersAgree = netSign === 0 ? 0 : layers.filter((L) => Math.sign(L.contribution) === netSign).length;
  const confidence = Math.max(5, Math.min(97, Math.round(Math.abs(score) * 0.7 + layersAgree * 7)));

  const reasons: string[] = [];
  const topLayer = [...layers].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))[0];
  if (topLayer && topLayer.contribution !== 0) reasons.push(`${topLayer.name} is the strongest driver (${topLayer.contribution > 0 ? "+" : ""}${topLayer.contribution}).`);
  layers.forEach((L) => { const lead = L.sub.filter((s) => s.dir === netSign).map((s) => s.name); if (netSign !== 0 && lead.length) reasons.push(`${L.name}: ${lead.join(", ")} agree.`); });

  return {
    symbol, name, price: round2(price), asOf, direction, score, confidence, layers, reasons,
    disclaimer: "4-Layer Direction Engine: Market Structure 40% + Trend 25% + Derivatives 20% + Momentum 15%. " +
      "Futures basis and option volume aren't available on this feed, so Layer 3 uses OI bias, OI-change buildup, futures buildup and IV skew. " +
      "Directional estimate, not a guarantee - confirm on entry and use a stop.",
  };
}
