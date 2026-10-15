// ============================ Zero-Hero (expiry-day cheap OTM) — live read, pure logic (no I/O) ============================
// What an experienced expiry-day buyer checks before paying for a cheap OTM option, made explicit:
//   window (expiry day, 13:30–14:45 only) · trigger (a 5-min CLOSE beyond the day's range) · the 2-step OTM strike and its
//   real quote · how far the index must move for the premium to DOUBLE vs the move the market is pricing (ATM straddle)
//   · the chance of touching that level before 15:30 (from the option's own IV) · writers covering at that strike ·
//   a fixed risk budget · the 2-year record of exactly this setup. It never trades; the arbiter and risk gates decide.

import { bsPrice } from "../analysis/greeks";
import type { OiStrike } from "../types";

const r2 = (v: number) => Math.round(v * 100) / 100;
function normCdf(x: number) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
export const ZH_HISTORY: Record<string, { text: string; hit2x: string; avg: string }> = {
  "^NSEI": { text: "NIFTY, 2 years of expiry days (54 trades): day-range breakout after 13:30 → only 2 trades reached 2×; every exit style lost (−4 to −11 premium pts/trade after costs); losing streaks up to 28.", hit2x: "0–8 %", avg: "−4 to −11 pts" },
};
export interface ZhCandle { time: number; high: number; low: number; close: number }
export interface ZhInput {
  symbol: string; expiry: string | null; today: string; istMin: number; spot: number; step: number; lot: number | null;
  chain: OiStrike[]; closed5Today: ZhCandle[]; oiNow: Map<number, { ceOi: number | null; peOi: number | null }> | null; oi15Ago: Map<number, { ceOi: number | null; peOi: number | null }> | null;
  budget: number | null; history?: { text: string; hit2x: string; avg: string } | null;
}
export interface ZhSide {
  side: "CE" | "PE"; strike: number | null; premium: number | null; bid: number | null; ask: number | null; spreadPct: number | null; iv: number | null; delta: number | null;
  trigger: { state: "WAIT" | "TRIGGERED" | "NOT IN WINDOW"; at: number | null; level: number | null; detail: string };
  doubleAt: number | null; moveToDouble: number | null; pTouchDouble: number | null; writersCovering: boolean | null; oiChange15: number | null;
  lots: number | null; costPerLot: number | null; verdict: string;
}
/** Years from now to 15:30 IST today (expiry), floored at 1 minute. */
const yearsToClose = (istMin: number) => Math.max(1, 930 - istMin) / (375 * 252);   // trading-time convention: 375 min/day, 252 days

/** Index level at which the option's premium reaches `target` (Black-Scholes at its own IV, remaining time to 15:30). */
export function levelForPremium(side: "CE" | "PE", strike: number, spot: number, iv: number, t: number, target: number): number | null {
  const price = (s: number) => bsPrice({ spot: s, strike, tYears: t, iv, rate: 0.065 }, side) ?? 0;
  let lo = spot, hi = side === "CE" ? spot * 1.05 : spot * 0.95;
  if ((price(hi) - target) * (price(lo) - target) > 0) return null;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if ((price(mid) - target) * (price(lo) - target) > 0) lo = mid; else hi = mid; }
  return r2((lo + hi) / 2);
}
/** Volatility implied by the option's OWN market price on the same clock (time to 15:30), so the model matches the quote. */
export function impliedVolNow(side: "CE" | "PE", strike: number, spot: number, t: number, price: number): number | null {
  if (!(price > 0)) return null; let lo = 0.01, hi = 5;
  const f = (iv: number) => (bsPrice({ spot, strike, tYears: t, iv, rate: 0.065 }, side) ?? 0) - price;
  if (f(lo) > 0 || f(hi) < 0) return null;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
/** Probability that the index TOUCHES `level` before the close (reflection principle, driftless): 2·(1 − N(|ln(L/S)| / σ√t)). */
export function pTouch(spot: number, level: number, iv: number, t: number) { const x = Math.abs(Math.log(level / spot)) / (iv * Math.sqrt(t)); return r2(Math.min(1, 2 * (1 - normCdf(x))) * 100); }

export function zeroHero(o: ZhInput) {
  const isExpiry = !!o.expiry && o.expiry === o.today;
  const windowState = !isExpiry ? "NOT AN EXPIRY DAY" : o.istMin < 810 ? "WAIT — opens 13:30" : o.istMin <= 885 ? "ACTIVE (13:30–14:45)" : "CLOSED — no new zero-hero after 14:45";
  const atm = o.chain.length ? o.chain.reduce((b, s) => (Math.abs(s.strike - o.spot) < Math.abs(b.strike - o.spot) ? s : b), o.chain[0]) : null;
  const straddle = atm && atm.ceLtp != null && atm.peLtp != null ? r2(atm.ceLtp + atm.peLtp) : null;
  const t = yearsToClose(o.istMin);
  const sides = (["CE", "PE"] as const).map((side): ZhSide => {
    const dir = side === "CE" ? 1 : -1;
    const strike = atm ? atm.strike + dir * 2 * o.step : null, row = strike != null ? o.chain.find((s) => s.strike === strike) : null;
    const p = side === "CE" ? "ce" : "pe", premium = (row as any)?.[`${p}Ltp`] ?? null, bid = (row as any)?.[`${p}Bid`] ?? null, ask = (row as any)?.[`${p}Ask`] ?? null;
    const ivRaw = (row as any)?.[`${p}Iv`] ?? null, iv = ivRaw != null ? (ivRaw > 1 ? ivRaw / 100 : ivRaw) : null, delta = (row as any)?.[`${p}Delta`] ?? null;
    // trigger: first 5-min CLOSE beyond the day's range set before it, closing 13:30–14:45
    let trig: ZhSide["trigger"] = { state: isExpiry && o.istMin >= 810 && o.istMin <= 885 ? "WAIT" : "NOT IN WINDOW", at: null, level: null, detail: "" };
    const bars = o.closed5Today;
    for (let j = 1; isExpiry && j < bars.length; j++) {   // the trigger is only judged on the expiry day itself
      const c = bars[j].time + 300, m = Math.floor(((c + 19800) % 86400) / 60); if (m < 810 || m > 885) continue;
      const prior = bars.slice(0, j), hi = Math.max(...prior.map((b) => b.high)), lo = Math.min(...prior.map((b) => b.low));
      if (dir > 0 ? bars[j].close > hi : bars[j].close < lo) { trig = { state: "TRIGGERED", at: c, level: r2(dir > 0 ? hi : lo), detail: `5-min close ${r2(bars[j].close)} ${dir > 0 ? "above the day high" : "below the day low"} ${r2(dir > 0 ? hi : lo)}` }; break; }
    }
    if (trig.state === "WAIT" && bars.length) { const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low)); trig.level = r2(dir > 0 ? hi : lo); trig.detail = `needs a 5-min close ${dir > 0 ? "above the day high" : "below the day low"} ${r2(dir > 0 ? hi : lo)} (${Math.round(Math.abs((dir > 0 ? hi : lo) - o.spot))} pts away)`; }
    const ivMkt = premium && strike != null ? impliedVolNow(side, strike, o.spot, t, premium) : null;   // from the live quote
    const doubleAt = premium && ivMkt && strike != null ? levelForPremium(side, strike, o.spot, ivMkt, t, 2 * premium) : null;
    const moveToDouble = doubleAt != null ? r2(Math.abs(doubleAt - o.spot)) : null;
    const pT = doubleAt != null && ivMkt ? pTouch(o.spot, doubleAt, ivMkt, t) : null;
    const key = side === "CE" ? "ceOi" : "peOi", now = strike != null ? o.oiNow?.get(strike)?.[key] ?? null : null, then = strike != null ? o.oi15Ago?.get(strike)?.[key] ?? null : null;
    const oiChg = now != null && then != null ? now - then : null, covering = oiChg != null ? oiChg < 0 : null;
    const costPerLot = premium != null && o.lot ? r2(premium * o.lot) : null, lots = costPerLot && o.budget ? Math.floor(o.budget / costPerLot) : null;
    const spreadPct = bid > 0 && ask >= bid ? r2(((ask - bid) / ((ask + bid) / 2)) * 100) : null;
    let verdict: string;
    if (!isExpiry) verdict = "Not an expiry day — zero-hero is an expiry-afternoon trade only.";
    else if (o.istMin > 885) verdict = "After 14:45 the remaining time is too short — no new zero-hero.";
    else if (o.istMin < 810) verdict = "Wait for 13:30; morning OTM premiums still carry time value that will melt.";
    else if (trig.state !== "TRIGGERED") verdict = `No trigger yet — ${trig.detail}. Do not pre-empt the break.`;
    else if (spreadPct != null && spreadPct > 10) verdict = "Triggered, but the quote is too wide — a cheap option with a wide spread is a guaranteed loss to enter.";
    else verdict = `Triggered${covering ? " and writers are covering" : ""}. Index must reach ${doubleAt ?? "—"} (${moveToDouble ?? "—"} pts) for 2×; market prices a ±${straddle ?? "—"} pt move to the close; touch chance ≈ ${pT ?? "—"} %. Risk only a fixed amount you accept losing in full.`;
    return { side, strike, premium, bid, ask, spreadPct, iv: ivRaw, delta, trigger: trig, doubleAt, moveToDouble, pTouchDouble: pT, writersCovering: covering, oiChange15: oiChg, lots, costPerLot, verdict };
  });
  return { isExpiry, window: windowState, spot: r2(o.spot), atm: atm?.strike ?? null, straddle, minutesToClose: Math.max(0, 930 - o.istMin), sides, history: o.history ?? ZH_HISTORY[o.symbol] ?? null,
    rules: ["Expiry day only, 13:30–14:45", "Trigger = a 5-min CLOSE beyond the day's high/low (never a wick, never in advance)", "Strike 2 steps OTM; skip if the spread is wide", "Fixed budget you accept losing 100 %; never average down", "Book half at 2–3×; everything out by 15:20"] };
}
