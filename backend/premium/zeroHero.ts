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
export const yearsToClose = (istMin: number) => Math.max(1, 930 - istMin) / (375 * 252);   // trading-time convention: 375 min/day, 252 days

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

// ---------------------------------------------------------------- frozen zero-hero trades (one at a time per index)
export interface ZhEvent { t: number; what: string; prem: number | null; index: number | null }
export interface ZhTrade {
  id: string; n: number; day: string; symbol: string; name: string; side: "CE" | "PE"; strike: number; expiry: string; lot: number | null;
  openedAt: number; entryPrem: number; entryIndex: number; triggerLevel: number;
  t1Prem: number; t2Prem: number; slPrem: number; slIndexRule: string;
  state: "OPEN" | "T1" | "CLOSED"; events: ZhEvent[]; exitPrem?: number | null; exitWhy?: string; closedAt?: number;
  rechecked?: boolean; floorPrem?: number; recheckNote?: string; reset?: boolean;
}
/** Freeze a new trade from a trigger. Every number here is fixed for the life of the trade. */
export function newZhTrade(o: { n: number; day: string; symbol: string; name: string; side: "CE" | "PE"; strike: number; expiry: string; lot: number | null; at: number; entryPrem: number; entryIndex: number; triggerLevel: number }): ZhTrade {
  const p = o.entryPrem;
  return { id: `${o.day}|${o.symbol}|${o.n}`, n: o.n, day: o.day, symbol: o.symbol, name: o.name, side: o.side, strike: o.strike, expiry: o.expiry, lot: o.lot,
    openedAt: o.at, entryPrem: r2(p), entryIndex: r2(o.entryIndex), triggerLevel: r2(o.triggerLevel), t1Prem: r2(2 * p), t2Prem: r2(3 * p), slPrem: r2(0.5 * p),
    slIndexRule: `5-min close ${o.side === "CE" ? "below" : "above"} ${r2(o.triggerLevel)} (breakout failed)`, state: "OPEN", events: [{ t: o.at, what: "ENTRY", prem: r2(p), index: r2(o.entryIndex) }] };
}
/**
 * Recheck at −51%: is the trade still alive? Keep only if (1) the index is still on the breakout side of the broken
 * day high/low, (2) ≥ 30 min remain before 15:20, and (3) the index move needed to bring the premium back to entry is
 * ≤ half of the move the market still prices (ATM straddle). Pure; returns the verdict and the reasons.
 */
export function recheckZh(tr: ZhTrade, x: { prem: number; spot: number; istMin: number; straddle: number | null }) {
  const dir = tr.side === "CE" ? 1 : -1, t = yearsToClose(x.istMin), reasons: string[] = [];
  const alive = dir * (x.spot - tr.triggerLevel) > 0;
  reasons.push(alive ? `breakout intact (index ${Math.round(x.spot)} ${dir > 0 ? "above" : "below"} ${Math.round(tr.triggerLevel)})` : `breakout gone (index back ${dir > 0 ? "below" : "above"} ${Math.round(tr.triggerLevel)})`);
  const timeOk = x.istMin <= 890; reasons.push(timeOk ? `${920 - x.istMin} min left` : `only ${Math.max(0, 920 - x.istMin)} min left`);
  const iv = impliedVolNow(tr.side, tr.strike, x.spot, t, x.prem), backAt = iv ? levelForPremium(tr.side, tr.strike, x.spot, iv, t, tr.entryPrem) : null;
  const need = backAt != null ? Math.abs(backAt - x.spot) : null, room = x.straddle != null ? 0.5 * x.straddle : null;
  const reachable = need != null && room != null && need <= room;
  reasons.push(need == null ? "recovery move not computable" : `needs ${Math.round(need)} pts to get back to entry vs ±${room != null ? Math.round(room) : "—"} still realistic`);
  return { keep: alive && timeOk && reachable, reasons, need, backAt };
}
/** Advance a frozen trade. The levels never change; only the state moves forward. Returns event names that fired. */
export function stepZhTrade(tr: ZhTrade, x: { prem: number | null; spot: number | null; last5: { time: number; close: number } | null; nowSec: number; istMin: number; straddle?: number | null }): string[] {
  if (tr.state === "CLOSED") return [];
  const fired: string[] = [], dir = tr.side === "CE" ? 1 : -1;
  const close = (why: string) => { tr.state = "CLOSED"; tr.exitWhy = why; tr.exitPrem = x.prem; tr.closedAt = x.nowSec; tr.events.push({ t: x.nowSec, what: why, prem: x.prem, index: x.spot }); fired.push(why); };
  if (x.prem != null && tr.state === "OPEN" && x.prem >= tr.t1Prem) { tr.state = "T1"; tr.events.push({ t: x.nowSec, what: "TARGET 1 (2×) — half booked, premium stop moved to entry", prem: x.prem, index: x.spot }); fired.push("T1"); }
  if (x.prem != null && x.prem >= tr.t2Prem) { close("TARGET 2 (3×)"); return fired; }
  if (tr.state === "T1" && x.prem != null && x.prem <= tr.entryPrem) { close("BREAKEVEN STOP (after T1)"); return fired; }
  // −51 %: recheck once (hold with a −75 % floor if still alive, otherwise RESET); after a hold, the floor is final
  if (tr.state === "OPEN" && x.prem != null && x.spot != null) {
    if (!tr.rechecked && x.prem <= 0.49 * tr.entryPrem) {
      const r = recheckZh(tr, { prem: x.prem, spot: x.spot, istMin: x.istMin, straddle: x.straddle ?? null });
      tr.rechecked = true; tr.recheckNote = r.reasons.join(" · ");
      if (r.keep) { tr.floorPrem = r2(0.25 * tr.entryPrem); tr.events.push({ t: x.nowSec, what: `RECHECK at −51% → HOLD (${tr.recheckNote}); final floor ${tr.floorPrem}`, prem: x.prem, index: x.spot }); fired.push("RECHECK_HOLD"); }
      else { tr.reset = true; close(`RESET at −51% — no longer an opportunity (${tr.recheckNote})`); return fired; }
    }
    if (tr.rechecked && tr.floorPrem != null && x.prem <= tr.floorPrem) { close("STOP — final floor −75% after recheck"); return fired; }
  }
  if (x.last5 && x.last5.time > tr.openedAt && dir * (x.last5.close - tr.triggerLevel) < 0) { close(tr.state === "T1" ? "EXIT — breakout failed (after T1)" : "STOP LOSS (breakout failed)"); return fired; }
  if (x.istMin >= 920) close("TIME EXIT 15:20");
  return fired;
}

/** First 5-min CLOSE beyond the day's range (as it stood before that bar) after `after`, inside 13:30–14:45. */
export function freshTrigger(bars: ZhCandle[], side: "CE" | "PE", after: number): { at: number; level: number; close: number } | null {
  const dir = side === "CE" ? 1 : -1;
  for (let j = 1; j < bars.length; j++) {
    const c = bars[j].time + 300, m = Math.floor(((c + 19800) % 86400) / 60); if (c <= after || m < 810 || m > 885) continue;
    const prior = bars.slice(0, j), hi = Math.max(...prior.map((b) => b.high)), lo = Math.min(...prior.map((b) => b.low));
    if (dir > 0 ? bars[j].close > hi : bars[j].close < lo) return { at: c, level: r2(dir > 0 ? hi : lo), close: bars[j].close };
  }
  return null;
}
