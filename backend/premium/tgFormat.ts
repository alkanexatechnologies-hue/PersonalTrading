// ============================ Telegram message design (HTML; every dynamic value escaped) ============================
// 15-minute "Best Opportunity" (NIFTY + SENSEX in one message) · 30-minute full read per index · event alerts.
// Advisory only — the arbiter and risk gates decide trades.

export const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const LINE = "━━━━━━━━━━━━━━━";
const arrow = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "▲" : v < 0 ? "▼" : "▬");
const short = (name: string) => String(name || "").replace(" 50", "");
const priceLine = (d: any) => `<b>${n0(d.spot?.price)}</b>  ${arrow(d.spot?.change)} ${d.spot?.change > 0 ? "+" : ""}${n0(d.spot?.change)} (${d.spot?.changePct > 0 ? "+" : ""}${esc(d.spot?.changePct)}%) · H ${n0(d.spot?.high)} · L ${n0(d.spot?.low)}`;
const RANK: Record<string, number> = { TRIGGERED: 0, ARMED: 1, APPROACHING: 2, IDLE: 3 };

/** The single best thing to watch on this index right now (an open trade always wins). */
export function bestFor(d: any, trade: any | null) {
  const T = d?.trader; if (!T || T.error) return null;
  if (trade && trade.state !== "CLOSED") return { kind: "TRADE" as const, trade };
  // the same time rules as the coach: no new buy before 09:30 or after 14:45
  const m = Math.floor(((Math.floor(Date.now() / 1000) + 19800) % 86400) / 60);
  if (m < 570 || m > 885) return { kind: "NONE" as const };
  const c = (["bull", "bear"] as const).map((side) => ({ side, p: T.plans?.[side], o: T.radar?.[side] })).filter((x) => x.p && x.o && x.p.strike != null && RANK[x.o.state] != null);
  c.sort((a, b) => RANK[a.o.state] - RANK[b.o.state] || Math.abs(a.o.distAtr ?? 9) - Math.abs(b.o.distAtr ?? 9));
  return c.length ? { kind: "PLAN" as const, ...c[0] } : { kind: "NONE" as const };
}
function bestBlock(d: any, trade: any | null, eye: any | null, zh: any | null): string {
  const b = bestFor(d, trade), T = d?.trader, L: string[] = [`${d.symbol === "^BSESN" ? "🟣" : "🔵"} <b>${esc(short(d.name))}</b>  ${priceLine(d)}`];
  if (!b) L.push("  data unavailable");
  else if (b.kind === "TRADE") {
    const t = b.trade, prem = (d.ranking || []).find((x: any) => x.side === t.side && x.strike === t.strike)?.ltp ?? null;
    const pnl = prem != null && t.entryPrem != null ? Math.round(((prem / t.entryPrem) - 1) * 100) : null;
    L.push(`  📌 <b>OPEN TRADE</b> ${t.strike} ${t.side} · entry ₹${n0(t.entryPrem)} → now <b>₹${n0(prem)}</b>${pnl != null ? ` (${pnl >= 0 ? "+" : ""}${pnl}%)` : ""}`);
    L.push(`  🎯 T1 ${n0(t.t1)}${t.t2 ? ` · T2 ${n0(t.t2)}` : ""} · 🛑 ${t.state === "T1" ? `breakeven ${n0(t.entrySpot)} (T1 done)` : `15-min close ${t.side === "CE" ? "below" : "above"} ${n0(t.stop)}`}`);
  } else if (b.kind === "PLAN") {
    const { p, o, side } = b, ce = side === "bull";
    const tag = o.state === "TRIGGERED" ? "✅ TRIGGERED" : o.state === "ARMED" ? "⏳ ARMED — wait for the close" : o.state === "APPROACHING" ? "👀 APPROACHING" : "· watching";
    L.push(`  ${ce ? "🟢 BUY CE" : "🔴 BUY PE"} <b>${p.strike} ${ce ? "CE" : "PE"}</b> (₹${n0(p.premNow)}) — ${tag}`);
    L.push(`  ▶ Start: 15-min close ${ce ? "above" : "below"} <b>${n0(p.entry)}</b>${o.distPts != null && o.state !== "TRIGGERED" ? ` (${Math.round(Math.abs(o.distPts))} pts away)` : ""}`);
    L.push(`  🎯 T1 <b>${n0(p.t1)}</b>${p.t2 ? ` · T2 ${n0(p.t2)}` : ""} · 🛑 SL ${n0(p.stop)} · R:R 1:${esc(p.rr)} · risk <b>${esc(p.triggerRisk?.risk ?? "—")}</b>`);
  } else L.push(`  ⏸ No setup near — ${esc(T?.coach?.action ?? "wait")}`);
  if (eye) L.push(`  👁 Next 30m (history): ↑${eye.upPct}% ↔${eye.sidePct}% ↓${eye.downPct}% → <b>${esc(eye.lead)}</b>`);
  if (zh?.isExpiry) {
    const open = (zh.zhTrades || []).find((t: any) => t.state !== "CLOSED"), trig = (zh.sides || []).find((x: any) => x.trigger?.state === "TRIGGERED");
    L.push(open ? `  🎲 Zero-hero #${open.n} ${open.strike} ${open.side} · entry ₹${n0(open.entryPrem)} · now ₹${n0(open.livePrem)} · T1 ₹${n0(open.t1Prem)}`
      : trig ? `  🎲 Zero-hero TRIGGERED: ${trig.strike} ${trig.side} ₹${n0(trig.premium)} · 2× needs ${Math.round(trig.moveToDouble ?? 0)} pts`
      : `  🎲 Zero-hero (expiry): no trigger · ${esc(zh.window)}`);
  }
  return L.join("\n");
}
/** 15-minute message: the best opportunity on NIFTY and SENSEX, together. */
export function bestOpportunityMsg(items: { d: any; trade: any | null; eye: any | null; zh: any | null }[]): string {
  const t = hm(Math.floor(Date.now() / 1000));
  return [`⭐ <b>BEST OPPORTUNITY</b> · ${t}`, LINE, ...items.filter((x) => x.d?.available).map((x) => bestBlock(x.d, x.trade, x.eye, x.zh)).join(`\n${LINE}\n`).split("\n"), LINE, "<i>Start = a 15-min candle CLOSE beyond the level · advisory only, the arbiter decides</i>"].join("\n");
}
/** 30-minute message: the full read of one index. */
export function fullReadMsg(d: any, trade: any | null, eye: any | null, zh: any | null, odds?: string): string {
  const T = d?.trader; if (!T || T.error) return `<b>${esc(d?.name)}</b>: full read unavailable`;
  const c = T.candles, b = T.plans?.bull, r = T.plans?.bear, rb = T.radar?.bull, rr = T.radar?.bear;
  const L = [`📊 <b>${esc(short(d.name))} — FULL READ</b> · ${hm(Math.floor(Date.now() / 1000))}`, priceLine(d), LINE];
  L.push("🕯 <b>Candles</b>");
  if (c?.m15) L.push(`• ${esc(c.m15.text)}`); if (c?.m5) L.push(`• ${esc(c.m5.text)}`);
  L.push(`📐 <b>Trend</b>  ${(T.trends || []).map((x: any) => `${esc(x.tf)} ${x.verdict === "UP" ? "▲" : x.verdict === "DOWN" ? "▼" : "▬"}`).join(" · ")}`);
  L.push(LINE);
  if (b) L.push(`🟢 <b>Bull</b>  above <b>${n0(b.entry)}</b> → ${b.strike} CE · SL ${n0(b.stop)} · T1 ${n0(b.t1)}${b.t2 ? `/${n0(b.t2)}` : ""} · <b>${esc(b.triggerRisk?.risk ?? "—")}</b> · ${esc(rb?.state ?? "")}`);
  if (r) L.push(`🔴 <b>Bear</b>  below <b>${n0(r.entry)}</b> → ${r.strike} PE · SL ${n0(r.stop)} · T1 ${n0(r.t1)}${r.t2 ? `/${n0(r.t2)}` : ""} · <b>${esc(r.triggerRisk?.risk ?? "—")}</b> · ${esc(rr?.state ?? "")}`);
  if (T.plans?.noTrade) L.push(`⏸ No-trade zone ${n0(T.plans.noTrade.from)} – ${n0(T.plans.noTrade.to)}`);
  L.push(`🧭 <b>${esc(T.coach?.action ?? "")}</b>`);
  if (T.coach?.why) L.push(`<i>${esc(T.coach.why)}</i>`);
  if (trade && trade.state !== "CLOSED") L.push(`📌 Open trade ${trade.strike} ${trade.side} from ${n0(trade.entrySpot)} (₹${n0(trade.entryPrem)}) · ${trade.state === "T1" ? "T1 done, SL at breakeven" : `SL ${n0(trade.stop)} · T1 ${n0(trade.t1)}`}`);
  if (eye) { L.push(LINE); L.push(`👁 <b>Market Eye</b> (${eye.n} similar moments, 2 yrs): ↑${eye.upPct}% ↔${eye.sidePct}% ↓${eye.downPct}% · median ${eye.medianPct >= 0 ? "+" : ""}${esc(eye.medianPct)}% → <b>${esc(eye.lead)}</b>`); }
  if (zh?.isExpiry) {
    L.push(LINE); L.push(`🎲 <b>Zero-hero</b> (${esc(zh.window)})`);
    for (const t of zh.zhTrades || []) L.push(`• #${t.n} ${t.strike} ${t.side} · ₹${n0(t.entryPrem)} → ${t.state === "CLOSED" ? `${esc(t.exitWhy)} ₹${n0(t.exitPrem)}` : `now ₹${n0(t.livePrem)}`}`);
    for (const x of zh.sides || []) L.push(`• ${x.side} ${x.strike} ₹${n0(x.premium)} · ${esc(x.trigger?.state)} · 2× needs ${x.moveToDouble != null ? Math.round(x.moveToDouble) : "—"} pts`);
  }
  if (odds) L.push(`<i>📊 ${esc(odds)}</i>`);
  L.push("<i>History and levels, not a forecast · the arbiter decides</i>");
  return L.join("\n");
}
/** Event alert from a plain-text body: bold title line, emphasised "→" action lines, everything escaped. */
export function htmlify(plain: string): string {
  const lines = String(plain).split("\n");
  return lines.map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : /^\s*→/.test(l) ? `<b>${esc(l.trim())}</b>` : /^\s*📊/.test(l) ? `<i>${esc(l.trim())}</i>` : esc(l))).join("\n");
}
