// ============================ EXPIRY MODE — the index's own expiry day, PAPER / MIN SIZE (owner's choice, 2026-10-18) ============================
// The best-tested expiry-day buyer method from backend/research/protrader/expiryDay.ts (EMA20 pullback, 1 strike ITM,
// premium management). Research verdict: NOT validated as profitable — it cut the loss and lifted the win rate versus the
// normal plan on expiry day, so it runs as a labelled paper / minimum-size forward test, scored separately.
//   Entry 10:30–13:30: trend = price above (below) the day's open AND the 5-min EMA20 rising (falling); a CLOSED 5-min candle
//   dips (pops) to within 0.15·ATR15 of the EMA20 and closes beyond it with the trend → CE (PE). Max 2 a day, one at a time.
//   Strike: one step in the money. Exits on the PREMIUM: −40% stop · half at 1.5× · then stop at the entry premium ·
//   rest at 2.5× · 40-minute time stop if 1.5× is not reached · out by 15:15.

export const EXPIRY_RULES = { stop: 0.6, half: 1.5, full: 2.5, timeMin: 40, from: 630, to: 810, maxTrades: 2 } as const;
export interface Bar5 { time: number; open: number; high: number; low: number; close: number }
const mnOf = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Signal on the LAST closed 5-min candle (or null). `ema20` aligned with `bars`. */
export function expirySignal(bars: Bar5[], ema20: (number | null)[], dayOpen: number, atr15: number) {
  const k = bars.length - 1; if (k < 21) return null;
  const x = bars[k], m = mnOf(x.time) + 5, e = ema20[k], e5 = ema20[k - 5];
  if (m < EXPIRY_RULES.from || m > EXPIRY_RULES.to || e == null || e5 == null) return null;
  if (x.close > dayOpen && e > e5 && x.low <= e + 0.15 * atr15 && x.close > e) return { side: "CE" as const, bar: x, ema: e };
  if (x.close < dayOpen && e < e5 && x.high >= e - 0.15 * atr15 && x.close < e) return { side: "PE" as const, bar: x, ema: e };
  return null;
}
/** One step in the money: CE strike below the ATM, PE strike above it. */
export const itmStrike = (spot: number, step: number, side: "CE" | "PE") => Math.round(spot / step) * step + (side === "CE" ? -step : step);

export interface ExpTrade { index: string; name: string; side: "CE" | "PE"; strike: number; openedAt: number; entrySpot: number; entryPrem: number; state: "OPEN" | "HALF" | "CLOSED"; halfPrem?: number; exitPrem?: number; exitWhy?: string; closedAt?: number }
/** Follow an expiry-mode trade with the live premium (polled). Returns the messages to send. */
export function stepExpiryTrade(t: ExpTrade, prem: number | null, nowSec: number): string[] {
  if (t.state === "CLOSED" || prem == null) return [];
  const R = EXPIRY_RULES, e0 = t.entryPrem, msgs: string[] = [], head = `🎲 <b>EXPIRY MODE · ${esc(t.name.replace(" 50", ""))} ${t.strike} ${t.side}</b>`;
  const close = (why: string, px: number) => { t.state = "CLOSED"; t.exitPrem = r1(px); t.exitWhy = why; t.closedAt = nowSec; };
  const pnl = (px: number) => `${px >= e0 ? "+" : "−"}${Math.abs(Math.round(((px / e0) - 1) * 100))}%`;
  if (mnOf(nowSec) >= 915) { close("TIME 15:15", prem); msgs.push(`${head} — ⏰ <b>OUT AT 15:15</b> · ₹${r1(prem)} (${pnl(prem)})`); return msgs; }
  if (t.state === "OPEN") {
    if (prem <= R.stop * e0) { close("PREMIUM STOP −40%", prem); msgs.push(`${head} — 🛑 <b>PREMIUM STOP −40%</b> · ₹${e0} → ₹${r1(prem)} (${pnl(prem)}) · exit, no averaging`); return msgs; }
    if (prem >= R.half * e0) { t.state = "HALF"; t.halfPrem = r1(prem); msgs.push(`${head} — ✅ <b>1.5× HIT</b> · ₹${e0} → ₹${r1(prem)} · <b>book HALF</b>, stop the rest at the entry premium ₹${e0}, let it run to 2.5× (₹${r1(R.full * e0)})`); return msgs; }
    if (nowSec - t.openedAt >= R.timeMin * 60) { close("TIME STOP 40 min", prem); msgs.push(`${head} — ⏱ <b>40-MIN TIME STOP</b> · 1.5× not reached · ₹${r1(prem)} (${pnl(prem)}) · on expiry, time is the enemy — exit`); return msgs; }
  } else if (t.state === "HALF") {
    if (prem >= R.full * e0) { close("2.5× TARGET", prem); msgs.push(`${head} — 🏁 <b>2.5× HIT</b> · ₹${r1(prem)} · exit the rest`); return msgs; }
    if (prem <= e0) { close("BREAKEVEN after 1.5×", prem); msgs.push(`${head} — ↩️ <b>BACK TO ENTRY</b> · rest out at ₹${r1(prem)} (half was booked at ₹${t.halfPrem})`); return msgs; }
  }
  return msgs;
}
export function expiryEntryMsg(t: ExpTrade, sig: NonNullable<ReturnType<typeof expirySignal>>, n: number): string {
  const R = EXPIRY_RULES, e0 = t.entryPrem;
  return [`🎲 <b>EXPIRY MODE · PAPER / MIN SIZE</b> · trade ${n}/${R.maxTrades}`,
    `<b>${esc(t.name.replace(" 50", ""))} ${t.strike} ${t.side}</b> (1 strike in the money) · premium <b>₹${e0}</b> · index ${Math.round(t.entrySpot)}`,
    `Why: trend ${t.side === "CE" ? "UP" : "DOWN"} on the day, 5-min candle ${hm(sig.bar.time)} pulled back to the EMA20 (${Math.round(sig.ema)}) and closed ${t.side === "CE" ? "above" : "below"} it.`,
    `🛑 <b>Stop Loss: premium ₹${r1(R.stop * e0)} (−40%)</b> · 🎯 <b>Target 1: ₹${r1(R.half * e0)} (1.5×) — book half</b> · 🏁 <b>Target 2: ₹${r1(R.full * e0)} (2.5×)</b>`,
    `⏱ If 1.5× is not reached in 40 min → exit · out by 15:15`,
    `<i>Expiry method is NOT validated as profitable (2-yr test: fewer losses than the normal plan, still slightly negative). Paper or minimum size only.</i>`].join("\n");
}
