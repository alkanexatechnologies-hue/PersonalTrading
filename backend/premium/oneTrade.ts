// ============================ 🎯 ONE TRADE — Market Command tab (owner, 2026-10-28; ProTrader APPROVE same day) ============================
// One trade at a time across NIFTY + SENSEX. A new trade is taken only after the open one has closed. The target is fixed at
// 1:2: entry ± 2 × (entry − the plan's stop), one full exit. The stop stays the plan's 15-min CLOSE beyond its stop level,
// and the time exit is 15:12. Entries are the approved co-pilot's: 15-min close beyond the plan start → 5-min retest →
// Trade Review → no chase / fast-market checks. The first co-pilot trade given while this tab is flat becomes THE trade.
// Backtest: research/protrader/RESULTS_ONE_TRADE.md (SUPERVISOR_LOG 2026-10-28). Every event is told in Hindi for the
// screen (and its voice). Advisory only — no order is placed.

export interface OneEvent { t: number; kind: "OPEN" | "PROGRESS" | "WARN" | "TARGET" | "SL" | "TIME" | "INFO"; text: string }
export interface OneTrade {
  symbol: string; name: string; side: "CE" | "PE"; strike: number; openedAt: number; entrySpot: number; entryPrem: number | null;
  stop: number; risk: number; target: number; stopPrem: number | null; targetPrem: number | null; delta: number | null;
  review: string | null; why: string[]; state: "OPEN" | "TARGET" | "SL" | "TIME"; closedAt?: number; exitSpot?: number; exitPrem?: number | null;
  marks: { half?: boolean; near?: boolean };
}
export interface OneState { day: string; trade: OneTrade | null; closed: OneTrade[]; events: OneEvent[] }

const IST = 19800;
const hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const f0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const rs = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `₹${Math.round(v)}`);
export const LOTS: Record<string, number> = { "^NSEI": 75, "^BSESN": 20 };

export function fresh(day: string): OneState { return { day, trade: null, closed: [], events: [] }; }
const push = (st: OneState, e: OneEvent) => { st.events.push(e); if (st.events.length > 200) st.events.shift(); return e; };

/** Adopt a co-pilot trade as THE trade when the tab is flat. Returns the Hindi "new trade" event, or null when busy. */
export function adopt(st: OneState, co: { index: string; name: string; side: "CE" | "PE"; strike: number; openedAt: number; entrySpot: number; entryPrem: number | null; stop: number },
  ctx: { delta?: number | null; review?: string | null; why?: string[]; trigger?: number | null }): OneEvent | null {
  if (st.trade && st.trade.state === "OPEN") return null;
  const dir = co.side === "CE" ? 1 : -1, risk = Math.abs(co.entrySpot - co.stop);
  if (!(risk > 0) || dir * (co.entrySpot - co.stop) <= 0) return null;   // a stop on the wrong side is not a trade
  const d = ctx.delta != null && Number.isFinite(ctx.delta) ? Math.abs(ctx.delta) : null, target = co.entrySpot + dir * 2 * risk;
  const t: OneTrade = {
    symbol: co.index, name: co.name, side: co.side, strike: co.strike, openedAt: co.openedAt, entrySpot: co.entrySpot, entryPrem: co.entryPrem,
    stop: co.stop, risk: Math.round(risk * 100) / 100, target: Math.round(target * 100) / 100,
    stopPrem: co.entryPrem != null && d != null ? Math.round(co.entryPrem - d * risk) : null, targetPrem: co.entryPrem != null && d != null ? Math.round(co.entryPrem + d * 2 * risk) : null,
    delta: d, review: ctx.review ?? null, why: ctx.why || [], state: "OPEN", marks: {},
  };
  st.trade = t;
  const word = co.side === "CE" ? "ऊपर" : "नीचे", trig = ctx.trigger != null ? f0(ctx.trigger) : "plan level";
  return push(st, { t: co.openedAt, kind: "OPEN", text:
    `🎯 नया trade: ${co.name} ${co.strike} ${co.side}, ${rs(co.entryPrem)} पर। क्यों: 15-min candle ${trig} के ${word} बंद हुई और ${hm(co.openedAt)} पर 5-min retest पर entry मिली${t.review ? `, review ${t.review}` : ""}। ` +
    `Stop loss: 15-min candle ${f0(co.stop)} के ${co.side === "CE" ? "नीचे" : "ऊपर"} बंद हो तो बाहर${t.stopPrem != null ? ` (premium लगभग ${rs(t.stopPrem)})` : ""}। ` +
    `Target 1:2: ${co.name} ${f0(target)}${t.targetPrem != null ? ` (premium लगभग ${rs(t.targetPrem)})` : ""}। जब तक यह trade बंद नहीं होता, कोई नया trade नहीं।` });
}

/** Follow THE trade: target touch on the index, stop = a 15-min close beyond the stop, 15:12 time exit, plus progress notes. */
export function step(st: OneState, x: { spot: number; prem: number | null; last15: { time: number; close: number } | null; nowSec: number; istMin: number }): OneEvent[] {
  const t = st.trade; if (!t || t.state !== "OPEN") return [];
  const dir = t.side === "CE" ? 1 : -1, out: OneEvent[] = [], pl = (p: number | null) => (p != null && t.entryPrem != null ? p - t.entryPrem : null);
  const lot = LOTS[t.symbol] || 1, money = (p: number | null) => { const v = pl(p); return v == null ? "" : ` (${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(v))} प्रति unit, 1 lot पर ${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(v * lot)).toLocaleString("en-IN")})`; };
  const close = (state: OneTrade["state"], text: string, kind: OneEvent["kind"]) => {
    t.state = state; t.closedAt = x.nowSec; t.exitSpot = x.spot; t.exitPrem = x.prem; st.closed.push(t); st.trade = null;
    out.push(push(st, { t: x.nowSec, kind, text }));
  };
  if (dir * (x.spot - t.target) >= 0) { close("TARGET", `🎉 Target हिट! ${t.name} ${f0(x.spot)} पहुँचा — ${t.strike} ${t.side} premium ${rs(x.prem)}${money(x.prem)}। पूरा बेचिए। 1:2 का नियम निभाया — अब अगला मौका खुला है।`, "TARGET"); return out; }
  if (x.last15 && x.last15.time > t.openedAt && dir * (x.last15.close - t.stop) < 0) { close("SL", `🛑 Stop loss हिट: 15-min candle ${f0(x.last15.close)} पर ${t.side === "CE" ? "नीचे" : "ऊपर"} बंद हुई। ${t.strike} ${t.side} से बाहर, premium ${rs(x.prem)}${money(x.prem)}। नुकसान छोटा रखा — यही अनुशासन है। अब अगला trade खुला है।`, "SL"); return out; }
  if (x.istMin >= 912) { close("TIME", `⏰ 15:12 — time exit। ${t.strike} ${t.side} premium ${rs(x.prem)}${money(x.prem)}। आज का खेल ख़त्म।`, "TIME"); return out; }
  const r = dir * (x.spot - t.entrySpot) / t.risk;
  if (r >= 1 && !t.marks.half) { t.marks.half = true; out.push(push(st, { t: x.nowSec, kind: "PROGRESS", text: `👍 आधा रास्ता तय — ${t.name} ${f0(x.spot)}, premium ${rs(x.prem)}${money(x.prem)}। Target ${f0(t.target)} है; SL वहीं रखिए, जल्दबाज़ी में मत बेचिए।` })); }
  if (r <= -0.7 && !t.marks.near) { t.marks.near = true; out.push(push(st, { t: x.nowSec, kind: "WARN", text: `⚠️ सावधान — भाव stop के पास (${f0(x.spot)}, stop ${f0(t.stop)})। फ़ैसला 15-min candle के close पर होगा, touch पर नहीं। SL आगे मत खिसकाइए।` })); }
  return out;
}

/** Live numbers of the open trade for the screen. */
export function live(t: OneTrade, spot: number | null, prem: number | null) {
  const dir = t.side === "CE" ? 1 : -1, lot = LOTS[t.symbol] || 1;
  return { spot, prem, pnl: prem != null && t.entryPrem != null ? Math.round((prem - t.entryPrem) * 100) / 100 : null,
    pnlLot: prem != null && t.entryPrem != null ? Math.round((prem - t.entryPrem) * lot) : null, r: spot != null ? Math.round((dir * (spot - t.entrySpot) / t.risk) * 100) / 100 : null, lot };
}
