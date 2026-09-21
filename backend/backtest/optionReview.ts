import { Candle } from "../types";
import { findSymbolDef } from "../config";
import { dhanOptionCandles, dhanSpotCandles, DhanProvider } from "../data/dhanProvider";
import { findOption, optionStrikes } from "../data/growwInstruments";

// ---- Option Trade Back-Test / Review (commentary in Hindi) ----
// Given a past trade (underlying + CE/PE + strike + expiry + date + entry/exit
// time), fetch that option's historical candles (FNO) + the underlying's candles
// (CASH), then judge whether the STRIKE choice was good or bad and where the user
// can improve. Also compares the nearby ATM / ITM / OTM strikes for the same
// window so the user sees what would have worked better.

export interface ReviewParams {
  symbol: string;      // internal symbol (e.g. ^NSEBANK) or NSE symbol
  type: "CE" | "PE";
  strike: number;
  expiry: string;      // yyyy-mm-dd
  date: string;        // yyyy-mm-dd (trade day)
  start: string;       // HH:mm (entry)
  end: string;         // HH:mm (exit)
  entryPrice?: number; // optional actual premium paid
  exitPrice?: number;  // optional actual premium received
  lots?: number;       // optional, for absolute P&L
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const toEpoch = (date: string, hm: string) => Math.floor(Date.parse(`${date}T${hm}:00+05:30`) / 1000);
const hhmm = (epoch: number) => new Date((epoch + 19800) * 1000).toISOString().slice(11, 16);

function candleAtOrAfter(cs: Candle[], epoch: number): Candle | null {
  for (const c of cs) if (c.time >= epoch) return c;
  return cs.length ? cs[cs.length - 1] : null;
}
function candleAtOrBefore(cs: Candle[], epoch: number): Candle | null {
  let out: Candle | null = null;
  for (const c of cs) { if (c.time <= epoch) out = c; else break; }
  return out || (cs.length ? cs[0] : null);
}
function spotAt(cs: Candle[], epoch: number): number | null {
  const c = candleAtOrBefore(cs, epoch);
  return c ? c.close : null;
}

// Smallest positive gap between strikes (the strike step) near a reference price.
function inferStep(strikes: number[], ref: number): number {
  if (strikes.length < 2) return 0;
  const near = [...strikes].sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref)).slice(0, 8).sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < near.length; i++) { const g = near[i] - near[i - 1]; if (g > 0) step = Math.min(step, g); }
  return Number.isFinite(step) ? step : 0;
}

function moneyness(type: "CE" | "PE", strike: number, spot: number, step: number): { tag: "ITM" | "ATM" | "OTM"; pct: number } {
  const diff = strike - spot;
  const pct = r2((Math.abs(diff) / spot) * 100);
  if (step > 0 && Math.abs(diff) <= step * 0.5) return { tag: "ATM", pct };
  if (type === "CE") return { tag: diff < 0 ? "ITM" : "OTM", pct };
  return { tag: diff > 0 ? "ITM" : "OTM", pct };
}

interface LegResult { entry: number; exit: number; pnlPct: number; }
function legPnl(cs: Candle[], startE: number, endE: number, entryOverride?: number, exitOverride?: number): LegResult | null {
  if (!cs.length) return null;
  const eC = candleAtOrAfter(cs, startE);
  const xC = candleAtOrBefore(cs, endE);
  if (!eC || !xC) return null;
  const entry = entryOverride != null && entryOverride > 0 ? entryOverride : eC.open;
  const exit = exitOverride != null && exitOverride > 0 ? exitOverride : xC.close;
  if (!entry) return null;
  return { entry: r2(entry), exit: r2(exit), pnlPct: r1(((exit - entry) / entry) * 100) };
}

export async function reviewOptionTrade(provider: DhanProvider, p: ReviewParams): Promise<any> {
  const def = findSymbolDef(p.symbol);
  const underlying = (def?.nseSymbol || p.symbol.replace(/\.NS$/i, "")).toUpperCase();
  const name = def?.name || underlying;

  const inst = await findOption(underlying, p.type, p.strike, p.expiry);
  if (!inst) {
    return { available: false, message: `इस strike/expiry के लिए option नहीं मिला (${underlying} ${p.strike} ${p.type} ${p.expiry}). कृपया सही expiry और strike चुनें।` };
  }

  // Fetch the FULL trading day (09:15–15:30 IST) at 5-min so we can measure the
  // best/worst within the user's hold window and the whole-day context.
  const dayStart = toEpoch(p.date, "09:15");
  const dayEnd = toEpoch(p.date, "15:30");
  const startE = toEpoch(p.date, p.start);
  const endE = toEpoch(p.date, p.end);
  if (!(endE > startE)) return { available: false, message: "End time, start time से बड़ा होना चाहिए।" };

  let optCs: Candle[] = [];
  let spotCs: Candle[] = [];
  try {
    optCs = await dhanOptionCandles(inst.tradingSymbol, dayStart, dayEnd, 5);
  } catch (e: any) {
    return { available: false, message: `Option का historical data नहीं मिला: ${e?.message || e}. (उस दिन market बंद/छुट्टी हो सकती है, या data 3 महीने से पुराना है।)` };
  }
  if (!optCs.length) {
    return { available: false, message: `${p.date} को इस option का कोई candle नहीं मिला — शायद छुट्टी/weekend था या strike उस दिन list नहीं था।` };
  }
  try { spotCs = await dhanSpotCandles(underlying, dayStart, dayEnd, 5); } catch { spotCs = []; }

  // User trade P&L within the hold window.
  const leg = legPnl(optCs, startE, endE, p.entryPrice, p.exitPrice);
  if (!leg) return { available: false, message: "दिए गए समय window में candle नहीं मिला।" };
  const lotPnl = r2((leg.exit - leg.entry) * inst.lotSize);
  const totalPnl = p.lots && p.lots > 0 ? r2(lotPnl * p.lots) : null;

  // Best/worst premium within the hold window (was there a better exit?).
  const held = optCs.filter((c) => c.time >= startE && c.time <= endE);
  let bestHigh = leg.entry, bestHighT = startE, worstLow = leg.entry, worstLowT = startE;
  for (const c of held) {
    if (c.high > bestHigh) { bestHigh = c.high; bestHighT = c.time; }
    if (c.low < worstLow) { worstLow = c.low; worstLowT = c.time; }
  }
  const bestPnlPct = r1(((bestHigh - leg.entry) / leg.entry) * 100);
  const worstDrawPct = r1(((worstLow - leg.entry) / leg.entry) * 100);
  const capture = bestPnlPct > 0 ? Math.max(0, Math.min(1, leg.pnlPct / bestPnlPct)) : 0;

  // Underlying move + moneyness of the chosen strike at entry.
  const spotEntry = spotAt(spotCs, startE);
  const spotExit = spotAt(spotCs, endE);
  const spotMovePct = spotEntry && spotExit ? r2(((spotExit - spotEntry) / spotEntry) * 100) : null;
  const spotDir = spotMovePct == null ? "flat" : spotMovePct > 0.05 ? "up" : spotMovePct < -0.05 ? "down" : "flat";
  const dirRight = spotMovePct == null ? null : (p.type === "CE" ? spotMovePct > 0 : spotMovePct < 0);

  const strikes = await optionStrikes(underlying, p.expiry);
  const step = inferStep(strikes, spotEntry || p.strike);
  const mny = spotEntry ? moneyness(p.type, p.strike, spotEntry, step) : { tag: "ATM" as const, pct: 0 };

  // Compare nearby ATM / ITM / OTM strikes for the SAME window.
  const alternatives: any[] = [];
  if (spotEntry && step > 0) {
    const atm = strikes.reduce((b, s) => (Math.abs(s - spotEntry) < Math.abs(b - spotEntry) ? s : b), strikes[0]);
    const itm = p.type === "CE" ? atm - step : atm + step;
    const otm = p.type === "CE" ? atm + step : atm - step;
    const cands = Array.from(new Set([atm, itm, otm])).filter((s) => s !== p.strike && strikes.includes(s));
    for (const s of cands) {
      const ai = await findOption(underlying, p.type, s, p.expiry);
      if (!ai) continue;
      try {
        const acs = await dhanOptionCandles(ai.tradingSymbol, dayStart, dayEnd, 5);
        const al = legPnl(acs, startE, endE);
        if (al) alternatives.push({ strike: s, type: p.type, moneyness: moneyness(p.type, s, spotEntry, step).tag, entry: al.entry, exit: al.exit, pnlPct: al.pnlPct });
      } catch { /* skip candidate */ }
    }
  }
  alternatives.sort((a, b) => b.pnlPct - a.pnlPct);
  const bestAlt = alternatives.length ? alternatives[0] : null;

  // ---- Rating ----
  let rating: "GOOD" | "AVERAGE" | "BAD";
  if (dirRight === false && leg.pnlPct < 0) rating = "BAD";
  else if (leg.pnlPct <= -20) rating = "BAD";
  else if (leg.pnlPct >= 15 && capture >= 0.4) rating = "GOOD";
  else rating = "AVERAGE";
  const ratingHindi = rating === "GOOD" ? "अच्छा ✅" : rating === "AVERAGE" ? "ठीक-ठाक ⚠️" : "ख़राब ❌";

  // ---- Hindi commentary ----
  const dirWord = spotDir === "up" ? "ऊपर" : spotDir === "down" ? "नीचे" : "flat";
  const reasons: string[] = [];
  const improvements: string[] = [];

  reasons.push(`Spot (${name}) entry पर ~${spotEntry ?? "?"} था, exit पर ~${spotExit ?? "?"} — यानी ${spotMovePct == null ? "?" : (spotMovePct > 0 ? "+" : "") + spotMovePct + "%"} ${dirWord}।`);
  reasons.push(`आपका strike ${p.strike} ${p.type} entry पर ${mny.tag} था (spot से ${mny.pct}% दूर)।`);
  reasons.push(`Premium: entry ₹${leg.entry} → exit ₹${leg.exit} = ${leg.pnlPct > 0 ? "+" : ""}${leg.pnlPct}% (₹${lotPnl}/lot)।`);
  reasons.push(`इस window में premium ज़्यादा से ज़्यादा ₹${r2(bestHigh)} (${bestPnlPct > 0 ? "+" : ""}${bestPnlPct}%) तक गया, कम से कम ₹${r2(worstLow)} (${worstDrawPct}%) तक आया।`);

  if (dirRight === false) {
    improvements.push(`Direction ग़लत रही — ${p.type} लिया पर spot ${dirWord} गया। Entry से पहले trend + OI + ADX से दिशा confirm करें, उल्टी चाल में CE/PE न ख़रीदें।`);
  }
  if (mny.tag === "OTM" && mny.pct > (p.type === "CE" ? 1.2 : 1.2)) {
    improvements.push(`Strike काफ़ी OTM (${mny.pct}% दूर) था — delta कम, theta ज़्यादा, इसलिए move का फ़ायदा कम मिला। ATM या 1 strike ITM लेने से delta बेहतर मिलता।`);
  }
  if (dirRight && capture < 0.5 && bestPnlPct > 5) {
    improvements.push(`Exit जल्दी कर दिया — premium +${bestPnlPct}% (₹${r2(bestHigh)}, ${hhmm(bestHighT)} बजे) तक गया था, पर आपने सिर्फ़ ${leg.pnlPct > 0 ? "+" : ""}${leg.pnlPct}% लिया। Trailing stop से ज़्यादा निकाल सकते थे।`);
  }
  if (dirRight && leg.pnlPct > 0 && leg.pnlPct < bestPnlPct - 15 && worstDrawPct < -10) {
    improvements.push(`मुनाफ़ा वापस जाने दिया — top से काफ़ी नीचे exit हुआ। Profit lock/trailing SL रखें।`);
  }
  if (p.expiry === p.date) {
    improvements.push(`यह expiry day था — theta decay बहुत तेज़ होता है; expiry day पर OTM buying से बचें या जल्दी निकलें।`);
  }
  if (bestAlt && bestAlt.pnlPct > leg.pnlPct + 5) {
    improvements.push(`बेहतर strike: ${bestAlt.strike} ${bestAlt.type} (${bestAlt.moneyness}) ने इसी window में ${bestAlt.pnlPct > 0 ? "+" : ""}${bestAlt.pnlPct}% दिया — आपके ${p.strike} से ~${r1(bestAlt.pnlPct - leg.pnlPct)}% ज़्यादा।`);
  }
  if (rating === "GOOD" && !improvements.length) {
    improvements.push(`अच्छा ट्रेड — strike और timing दोनों सही रहे। इसी अनुशासन (सही दिशा + ATM/ITM strike + trailing exit) को दोहराएँ।`);
  }
  if (!improvements.length) {
    improvements.push(`Strike ठीक था; बस entry timing और profit-booking को थोड़ा बेहतर करें।`);
  }

  const strikeVerdict = dirRight === false
    ? "दिशा ग़लत होने से strike का फ़ायदा नहीं मिला"
    : mny.tag === "OTM" && mny.pct > 1.2
      ? "strike ज़रूरत से ज़्यादा OTM था"
      : mny.tag === "ITM"
        ? "strike सुरक्षित (ITM) था — decay कम"
        : "strike ठीक (ATM के पास) था";

  const summary = `आपका ${p.strike} ${p.type} (${name}) — नतीजा: ${ratingHindi}. ${leg.pnlPct > 0 ? "+" : ""}${leg.pnlPct}% (₹${lotPnl}/lot${totalPnl != null ? `, कुल ₹${totalPnl}` : ""}). Spot ${spotMovePct == null ? "?" : (spotMovePct > 0 ? "+" : "") + spotMovePct + "%"} ${dirWord} गया; ${strikeVerdict}।`;

  return {
    available: true,
    meta: {
      underlying, name, type: p.type, strike: p.strike, expiry: p.expiry,
      tradingSymbol: inst.tradingSymbol, lotSize: inst.lotSize,
      date: p.date, start: p.start, end: p.end, interval: 5,
    },
    entry: { time: p.start, premium: leg.entry, spot: spotEntry },
    exit: { time: p.end, premium: leg.exit, spot: spotExit },
    pnlPct: leg.pnlPct, pnlPerLot: lotPnl, totalPnl,
    best: { premium: r2(bestHigh), pnlPct: bestPnlPct, time: hhmm(bestHighT) },
    worst: { premium: r2(worstLow), drawPct: worstDrawPct, time: hhmm(worstLowT) },
    spotMovePct, spotDir, dirRight,
    moneyness: mny.tag, moneynessPct: mny.pct, capturePct: r1(capture * 100),
    alternatives, bestAlternative: bestAlt,
    rating, ratingHindi, summary, reasons, improvements,
    disclaimer: "केवल शैक्षणिक विश्लेषण — निवेश सलाह नहीं। Historical data Dhan से; expiry/holiday पर data न भी मिले।",
  };
}
