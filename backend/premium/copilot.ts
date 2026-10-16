// ============================ Daily trading co-pilot — message builders (pure, no I/O) ============================
// Turns a Premium Prediction payload into the messages an experienced trading buddy sends: the morning plan, live
// opportunity alerts WITH their risk grade and the measured 2-year odds, hourly candle reads and the day review.
// Risk is a label, never a reason to hide a setup. Advisory only — the arbiter and risk gates decide trades.

const r0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);

export function planLines(d: any): string[] {
  const T = d?.trader; if (!T || T.error) return [`${d?.name ?? "?"}: plan unavailable`];
  const b = T.plans?.bull, r = T.plans?.bear, tr = (T.trends || []).map((x: any) => `${x.tf} ${x.verdict}`).join(" · ");
  const L: string[] = [`<b>${d.name}</b> ${r0(d.spot?.price)} (${d.spot?.changePct > 0 ? "+" : ""}${d.spot?.changePct ?? "—"}%) · ${tr}`];
  if (b) L.push(`  🟢 Bull: trigger = 15-min close above <b>${r0(b.entry)}</b> → buy ${b.strike} CE (₹${b.premNow != null ? Math.round(b.premNow) : "—"})`, `      Stop Loss ${r0(b.stop)} · Target 1 ${r0(b.t1)}${b.t2 ? ` · Target 2 ${r0(b.t2)}` : ""} · R:R 1:${b.rr} · risk ${b.triggerRisk?.risk ?? "—"}`);
  if (r) L.push(`  🔴 Bear: trigger = 15-min close below <b>${r0(r.entry)}</b> → buy ${r.strike} PE (₹${r.premNow != null ? Math.round(r.premNow) : "—"})`, `      Stop Loss ${r0(r.stop)} · Target 1 ${r0(r.t1)}${r.t2 ? ` · Target 2 ${r0(r.t2)}` : ""} · R:R 1:${r.rr} · risk ${r.triggerRisk?.risk ?? "—"}`);
  if (T.plans?.noTrade) L.push(`  ⏸ No-trade zone ${r0(T.plans.noTrade.from)} – ${r0(T.plans.noTrade.to)}`);
  return L;
}
export function morningPlan(list: any[], odds: Record<string, string>): string {
  return [`☀️ <b>Today's plan</b> (${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}) — first 15 minutes set the range; nothing counts until a 15-min candle CLOSES beyond a start.`, ...list.flatMap((d) => [...planLines(d), odds[d.symbol] ? `  📊 ${odds[d.symbol]}` : ""]).filter(Boolean), "Advisory only — the arbiter has the final word."].join("\n");
}
export function candleLine(d: any): string {
  const c = d?.trader?.candles; return [c?.m15?.text, c?.m5?.text].filter(Boolean).map((x: string) => `  🕯 ${x}`).join("\n");
}
export function opportunity(d: any, side: "bull" | "bear", state: string, odds: string | undefined): string {
  const T = d.trader, p = T.plans?.[side], o = T.radar?.[side], ce = side === "bull";
  const head = state === "TRIGGERED" ? `🎯 <b>${d.name} ${ce ? "BULL" : "BEAR"} TRIGGERED</b>` : state === "ARMED" ? `⏳ <b>${d.name} ${ce ? "BULL" : "BEAR"} — GET READY</b> (candle not closed yet)` : state === "FAILED" ? `⚠️ <b>${d.name} ${ce ? "BULL" : "BEAR"} FAILED</b> — stand aside` : `ℹ️ <b>${d.name} ${state}</b>`;
  const lines = [`${head} ${hm(Math.floor(Date.now() / 1000))}`, `  ${o?.text ?? ""}`];
  if (p && state !== "FAILED") {
    lines.push(`  Buy ${p.strike} ${ce ? "CE" : "PE"} (now ₹${p.premNow != null ? Math.round(p.premNow) : "—"}) · start ${r0(p.entry)} · stop: 15-min close ${ce ? "below" : "above"} ${r0(p.stop)}`);
    lines.push(`  Targets ${r0(p.t1)}${p.t2 ? ` → ${r0(p.t2)}` : ""} · R:R 1:${p.rr} · risk <b>${p.triggerRisk?.risk ?? "—"}</b>${p.triggerRisk?.reasons?.length ? ` (${p.triggerRisk.reasons.slice(0, 2).join("; ")})` : ""}`);
  }
  const cl = candleLine(d); if (cl) lines.push(cl);
  lines.push(`  Checklist ${T.coach?.passed ?? "—"}/${T.coach?.total ?? "—"} · Arbiter: ${String(d.master?.arbiterSays || "—").split(" — ")[0]} (final word)`);
  if (odds) lines.push(`  📊 ${odds}`);
  return lines.join("\n");
}
export function hourlyBrief(list: any[]): string {
  return [`🕐 <b>Candle read ${hm(Math.floor(Date.now() / 1000))}</b>`, ...list.flatMap((d) => {
    const T = d?.trader; if (!T || T.error) return [];
    const rb = T.radar?.bull, rr = T.radar?.bear;
    return [`<b>${d.name}</b> ${r0(d.spot?.price)} (${d.spot?.changePct > 0 ? "+" : ""}${d.spot?.changePct ?? "—"}%) · Bull ${rb?.state ?? "—"} (${rb?.entry ? r0(rb.entry) : "—"}) · Bear ${rr?.state ?? "—"} (${rr?.entry ? r0(rr.entry) : "—"})`, candleLine(d), `  → ${T.coach?.action ?? ""}`];
  })].filter(Boolean).join("\n");
}
export function dayReview(list: any[]): string {
  return [`🌙 <b>Day review</b> ${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}`, ...list.flatMap((d) => {
    const T = d?.trader, s = d?.spot; if (!T || !s) return [];
    const rolls = T.plans?.anchor?.rolls || [];
    return [`<b>${d.name}</b> O ${r0(s.open)} H ${r0(s.high)} L ${r0(s.low)} C ${r0(s.price)} (${s.changePct > 0 ? "+" : ""}${s.changePct}%)`,
      rolls.length ? `  Plans rolled ${rolls.length}×: ${rolls.map((x: any) => `${hm(x.time)} ${x.why}`).join(" | ")}` : "  No plan played out to Target 1 / failure today.",
      `  Tomorrow: ${(T.tomorrow?.scenarios || []).slice(0, 1).join(" ")}`];
  }), "🗓 The next-day plan follows at 15:31 (re-checked at 09:13)."].join("\n");
}

// ---------------------------------------------------------------- one trade at a time, followed to its end
export interface CoTrade {
  index: string; name: string; side: "CE" | "PE"; strike: number; openedAt: number; entrySpot: number; entryPrem: number | null;
  stop: number; t1: number; t2: number | null; state: "OPEN" | "T1" | "CLOSED"; t1At?: number; t1Prem?: number | null; closedAt?: number; exitWhy?: string; exitPrem?: number | null; exitSpot?: number;
}
export const stripTags = (s: string) => s.replace(/<\/?b>/g, "");
export function openTrade(d: any, side: "bull" | "bear", nowSec: number): CoTrade | null {
  const p = d?.trader?.plans?.[side]; if (!p || p.strike == null) return null;
  return { index: d.symbol, name: d.name, side: side === "bull" ? "CE" : "PE", strike: p.strike, openedAt: nowSec, entrySpot: d.spot?.price, entryPrem: p.premNow ?? null, stop: p.stop, t1: p.t1, t2: p.t2 ?? null, state: "OPEN" };
}
/**
 * Advance an open trade with the latest data. Targets are touches of the INDEX level; the stop is a 15-min CLOSE beyond
 * the stop level (after the trade opened); after Target 1 the stop moves to the entry level (breakeven); 15:12 = time exit.
 * Returns the follow-up messages to send (empty when nothing happened).
 */
export function stepTrade(tr: CoTrade, x: { spot: number; prem: number | null; last15: { time: number; close: number } | null; nowSec: number; istMin: number }): string[] {
  if (tr.state === "CLOSED") return [];
  const dir = tr.side === "CE" ? 1 : -1, msgs: string[] = [], pr = (v: number | null | undefined) => (v == null ? "—" : `₹${Math.round(v)}`);
  const pnl = (v: number | null) => (v != null && tr.entryPrem != null ? `${v - tr.entryPrem >= 0 ? "+" : ""}${Math.round(v - tr.entryPrem)} per unit (${Math.round(((v / tr.entryPrem) - 1) * 100)}%)` : "");
  const close = (why: string) => { tr.state = "CLOSED"; tr.closedAt = x.nowSec; tr.exitWhy = why; tr.exitPrem = x.prem; tr.exitSpot = x.spot; };
  const head = `${tr.name} ${tr.strike} ${tr.side}`;
  if (tr.state === "OPEN" && dir * (x.spot - tr.t1) >= 0) {
    tr.state = "T1"; tr.t1At = x.nowSec; tr.t1Prem = x.prem;
    msgs.push(`✅ ${head} — TARGET 1 HIT at ${r0(x.spot)} (${hm(x.nowSec)})\n  Premium ${pr(x.prem)} (entry ${pr(tr.entryPrem)}) · ${pnl(x.prem)}\n  → Book HALF now. Move the stop to breakeven: 15-min close ${dir > 0 ? "below" : "above"} ${r0(tr.entrySpot)}.${tr.t2 ? ` Hold the rest for T2 ${r0(tr.t2)}.` : " No T2 — trail the rest under each 15-min candle."}`);
  }
  if (tr.state === "T1" && tr.t2 != null && dir * (x.spot - tr.t2) >= 0) {
    close("TARGET 2");
    msgs.push(`🏁 ${head} — TARGET 2 HIT at ${r0(x.spot)} (${hm(x.nowSec)})\n  Premium ${pr(x.prem)} · ${pnl(x.prem)} on the second half\n  → Exit the rest. Trade complete.`);
    return msgs;
  }
  const stopLevel = tr.state === "T1" ? tr.entrySpot : tr.stop;
  if (x.last15 && x.last15.time >= tr.openedAt && dir * (x.last15.close - stopLevel) < 0) {
    const why = tr.state === "T1" ? "BREAKEVEN STOP (after T1)" : "STOP LOSS"; close(why);
    msgs.push(`${tr.exitWhy === "STOP LOSS" ? "🛑" : "↩️"} ${head} — ${why} (${hm(x.nowSec)})\n  15-min close ${r0(x.last15.close)} ${dir > 0 ? "below" : "above"} ${r0(stopLevel)}\n  Premium ${pr(x.prem)} · ${pnl(x.prem)}\n  → Exit. ${why === "STOP LOSS" ? "Loss taken as planned — no averaging, no revenge trade; wait for the next setup." : "Half was already booked at T1."}`);
    return msgs;
  }
  if (x.istMin >= 912) {
    close("TIME EXIT 15:12");
    msgs.push(`⏰ ${head} — TIME EXIT 15:12\n  Index ${r0(x.spot)} · premium ${pr(x.prem)} · ${pnl(x.prem)}\n  → Close everything; never carry an intraday option into the last minutes.`);
  }
  return msgs;
}
/** The 15-minute NIFTY update: movement, candle read, plan position, trade possibility, open trade, zero-hero (expiry). */
export function fifteenMinUpdate(d: any, trade: CoTrade | null, zh: any | null, odds: string | undefined): string {
  const T = d?.trader, s = d?.spot; if (!T || !s) return `${d?.name ?? "NIFTY"} update unavailable`;
  const rb = T.radar?.bull, rr = T.radar?.bear, b = T.plans?.bull, r = T.plans?.bear;
  const L = [`📈 ${d.name} ${hm(Math.floor(Date.now() / 1000))} — ${r0(s.price)} (${s.change > 0 ? "+" : ""}${r0(s.change)}, ${s.changePct > 0 ? "+" : ""}${s.changePct}%) · day H ${r0(s.high)} L ${r0(s.low)}`];
  const cl = candleLine(d); if (cl) L.push(cl);
  L.push(`  Trend: ${(T.trends || []).map((x: any) => `${x.tf} ${x.verdict}`).join(" · ")}`);
  L.push(`  Bull: ${rb?.state ?? "—"} — ${rb?.text ?? ""}${b ? ` [start ${r0(b.entry)}, risk ${b.triggerRisk?.risk ?? "—"}]` : ""}`);
  L.push(`  Bear: ${rr?.state ?? "—"} — ${rr?.text ?? ""}${r ? ` [start ${r0(r.entry)}, risk ${r.triggerRisk?.risk ?? "—"}]` : ""}`);
  L.push(`  Trade possibility: ${T.coach?.action ?? "—"} — ${T.coach?.why ?? ""}`);
  if (trade && trade.state !== "CLOSED") {
    const prem = (d.ranking || []).find((x: any) => x.side === trade.side && x.strike === trade.strike)?.ltp ?? null;
    L.push(`  Open trade: ${trade.strike} ${trade.side} from ${r0(trade.entrySpot)} (₹${trade.entryPrem != null ? Math.round(trade.entryPrem) : "—"}) · now ₹${prem != null ? Math.round(prem) : "—"} · ${trade.state === "T1" ? `T1 done, stop at breakeven ${r0(trade.entrySpot)}` : `stop ${r0(trade.stop)}, T1 ${r0(trade.t1)}`}`);
  }
  if (zh && zh.isExpiry && zh.window && !/NOT AN EXPIRY/.test(zh.window)) {
    const z = (x: any) => `${x.side} ${x.strike} ₹${x.premium != null ? Math.round(x.premium) : "—"} · ${x.trigger.state}${x.moveToDouble != null ? ` · 2× needs ${Math.round(x.moveToDouble)} pts` : ""}${x.writersCovering != null ? ` · writers ${x.writersCovering ? "covering" : "adding"}` : ""}`;
    L.push(`  🎲 Zero-hero (${zh.window}): ${zh.sides.map(z).join(" | ")}`);
    if (zh.history?.text) L.push(`     2-yr: ${zh.history.text}`);
  }
  if (odds) L.push(`  📊 ${odds}`);
  return L.join("\n");
}
