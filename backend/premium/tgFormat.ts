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
    const { o, side } = b;
    const tag = o.state === "TRIGGERED" ? "✅ TRIGGERED" : o.state === "ARMED" ? "⏳ ARMED — wait for the close" : o.state === "APPROACHING" ? "👀 APPROACHING" : "· watching";
    L.push(`  Status: <b>${tag}</b>`);
    L.push(...tradeCard(d, side, { compact: true }).map((x) => `  ${x}`));
    const c5 = candleShort(T?.candles?.m5); if (c5) L.push(`  🕯 ${c5}`);
    const rv = T?.review?.[side];
    if (rv) L.push(`  🧪 Review <b>${esc(rv.grade)}</b> (${esc(rv.score)}%) → ${esc(rv.verdict)}${rv.failed?.length ? ` · ✗ ${rv.failed.map((k: string) => esc(k)).join(", ")}` : ""}`);
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
  if (c?.m5) L.push(`• ${candleShort(c.m5)}`); if (c?.m15) L.push(`• ${candleShort(c.m15)}`);
  L.push(`📐 <b>Trend</b>  ${(T.trends || []).map((x: any) => `${esc(x.tf)} ${x.verdict === "UP" ? "▲" : x.verdict === "DOWN" ? "▼" : "▬"}`).join(" · ")}`);
  L.push(LINE);
  if (b) L.push(`🟢 <b>Bull</b> trigger above <b>${n0(b.entry)}</b> → ${b.strike} CE · Stop Loss ${n0(b.stop)} · Target 1 ${n0(b.t1)}${b.t2 ? ` · Target 2 ${n0(b.t2)}` : ""} · risk <b>${esc(b.triggerRisk?.risk ?? "—")}</b> · ${esc(rb?.state ?? "")}`);
  if (r) L.push(`🔴 <b>Bear</b> trigger below <b>${n0(r.entry)}</b> → ${r.strike} PE · Stop Loss ${n0(r.stop)} · Target 1 ${n0(r.t1)}${r.t2 ? ` · Target 2 ${n0(r.t2)}` : ""} · risk <b>${esc(r.triggerRisk?.risk ?? "—")}</b> · ${esc(rr?.state ?? "")}`);
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
/** After the close: the plan for the NEXT session (NIFTY + SENSEX), from today's finished session. */
export function nextDayPlanMsg(items: { d: any; odds?: string }[]): string {
  const ok = items.filter((x) => x.d?.available && x.d.trader && !x.d.trader.error);
  const forDay = ok[0]?.d.trader.planFor ?? "next session";
  const L = [`🗓 <b>NEXT-DAY PLAN</b> · for <b>${esc(forDay)}</b>`, `<i>prepared ${hm(Math.floor(Date.now() / 1000))} from today's finished session</i>`];
  for (const { d, odds } of ok) {
    const T = d.trader, s = d.spot, b = T.plans?.bull, r = T.plans?.bear, px = s?.price;
    const prem = (p: any) => (p?.premNow != null && p.premNow >= 1 ? `₹${n0(p.premNow)}` : "premium at the open");
    L.push(LINE, `${d.symbol === "^BSESN" ? "🟣" : "🔵"} <b>${esc(short(d.name))}</b>  closed <b>${n0(px)}</b> ${arrow(s?.change)} ${s?.changePct > 0 ? "+" : ""}${esc(s?.changePct)}%`);
    L.push(`  Today O ${n0(s?.open)} · H ${n0(s?.high)} · L ${n0(s?.low)}`);
    const lv = (T.levels || []).filter((x: any) => Number.isFinite(x.price) && px != null);
    const above = lv.filter((x: any) => x.price > px).sort((a: any, c: any) => a.price - c.price).slice(0, 3);
    const below = lv.filter((x: any) => x.price < px).sort((a: any, c: any) => c.price - a.price).slice(0, 3);
    if (above.length) L.push(`  ⬆ ${above.map((x: any) => `${n0(x.price)} <i>${esc(x.label)}</i>`).join(" · ")}`);
    if (below.length) L.push(`  ⬇ ${below.map((x: any) => `${n0(x.price)} <i>${esc(x.label)}</i>`).join(" · ")}`);
    void prem;
    if (b) L.push(...tradeCard(d, "bull", { compact: true }).map((x) => `  ${x}`));
    if (r) L.push(...tradeCard(d, "bear", { compact: true }).map((x) => `  ${x}`));
    if (T.plans?.noTrade) L.push(`  ⏸ No-trade zone ${n0(T.plans.noTrade.from)} – ${n0(T.plans.noTrade.to)}`);
    for (const sc of (T.tomorrow?.scenarios || []).slice(0, 3)) L.push(`  • ${esc(sc)}`);
    if (d.expiry && d.expiry === forDay) L.push(`  🎲 <b>Expiry day</b> — zero-hero search 09:30–15:10`);
    if (odds) L.push(`  <i>📊 ${esc(odds)}</i>`);
  }
  if (!ok.length) L.push("Plan unavailable — data not loaded.");
  L.push(LINE, "<i>Re-checked at 09:13 with the live open · advisory only, the arbiter decides</i>");
  return L.join("\n");
}
/**
 * Bold every Stop-loss / Target value and every danger detail in an HTML message, outside existing <b>…</b> (no nesting,
 * which Telegram may reject). Works on already-escaped HTML.
 */
const LEVEL = String.raw`(?:🛑\s*)?\b(?:SL|Stop|stop|STOP|Target|TARGET|T1|T2)\b(?:\s*[12](?![\d,]))?(?:\s*\([^)<]*\))?\s*:?\s*(?:15-min close (?:below|above)\s*)?(?:at\s*)?(?:breakeven\s*)?₹?\s?\d[\d,]*(?:\.\d+)?`;
const DANGER = String.raw`⚠️[^\n<]*|\b(?:HIGH RISK|risk HIGH|HIGH|FAILED|STOP LOSS|SL HIT|STOP HIT|MISSED|DANGER|CAUTION|COUNTER-TREND|no proven edge|NOT SUCCESSFUL)\b`;
const EMPH = new RegExp(`${LEVEL}|${DANGER}`, "g");
export function emphasize(html: string): string {
  let depth = 0;
  return String(html).split(/(<[^>]+>)/).map((part) => {
    if (/^<b>$/i.test(part)) { depth++; return part; }
    if (/^<\/b>$/i.test(part)) { depth = Math.max(0, depth - 1); return part; }
    if (part.startsWith("<") || depth > 0 || !part) return part;
    return part.replace(EMPH, (m) => `<b>${m}</b>`);
  }).join("");
}

// ---------------------------------------------------------------- the trade card: trigger, Entry / Stop Loss / Target 1 / Target 2
// with the INDEX level and the option PREMIUM expected there (≈ estimated from delta/gamma), + short 5-min / 15-min candle read.
const sgn = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(Math.round(v)).toLocaleString("en-IN");
/** One-line candle read: "5-min 15:25 ▲ BULLISH ENGULFING · closed at 100% of its range · at Prev close 23,146". */
export function candleShort(c: any): string {
  if (!c) return "";
  const arrow = c.tone === "bull" ? "▲" : c.tone === "bear" ? "▼" : "▬";
  const what = c.pattern || String(c.shape || "").replace(/\s*\(body \d+%\)/, "");
  return `${esc(c.tf)} ${hm(c.time)} ${arrow} ${esc(what)} · closed at ${esc(c.closeLoc)}% of its range${c.at ? ` · at ${esc(c.at)}` : ""}`;
}
export function tradeCard(d: any, side: "bull" | "bear", o: { compact?: boolean } = {}): string[] {
  const T = d?.trader, p = T?.plans?.[side]; if (!p) return [];
  const ce = side === "bull", leg = ce ? "CE" : "PE", spot = d.spot?.price, idx = short(d.name);
  const expired = p.premNow != null && p.premNow < 1;   // today's contract expired: no meaningful premium until the next open
  const prem = (v: number | null | undefined) => (expired || v == null || !Number.isFinite(v) ? "—" : `₹${n0(v)}`);
  const base = expired ? null : p.premAtEntry ?? p.premNow;
  const chg = (lvl: number, pv: number | null | undefined) => `${sgn(ce ? lvl - p.entry : p.entry - lvl)} pts${pv != null && base != null ? ` / ${sgn(pv - base).replace(/^([+−])/, "$1₹")}` : ""}`;
  const L: string[] = [];
  L.push(`${ce ? "🟢" : "🔴"} <b>BUY ${p.strike ?? "—"} ${leg}</b> (${esc(idx)})${expired ? " · premium at the open" : p.premNow != null ? ` · premium now ₹${n0(p.premNow)}` : ""}`);
  L.push(`⚡ <b>Trigger:</b> 15-min candle CLOSES ${ce ? "above" : "below"} <b>${n0(p.entry)}</b>${spot != null ? ` · index now ${n0(spot)} (${Math.round(Math.abs(spot - p.entry))} pts ${(ce ? spot < p.entry : spot > p.entry) ? "away" : "beyond"})` : ""}`);
  if (!o.compact && p.triggerLabel) L.push(`   <i>why this level: ${esc(p.triggerLabel)}</i>`);
  L.push(`▶ <b>Entry: index ${n0(p.entry)}</b> → ${leg} ≈ ${prem(base)}`);
  L.push(`🛑 <b>Stop Loss: index ${n0(p.stop)}</b> <i>(15-min close ${ce ? "below" : "above"})</i> → ${leg} ≈ ${prem(p.premAtStop)} · ${chg(p.stop, p.premAtStop)}`);
  L.push(`🎯 <b>Target 1: index ${n0(p.t1)}</b> → ${leg} ≈ ${prem(p.premAtT1)} · ${chg(p.t1, p.premAtT1)}${o.compact ? "" : " · book half, Stop Loss → entry"}`);
  if (p.t2 != null) L.push(`🏁 <b>Target 2: index ${n0(p.t2)}</b> → ${leg} ≈ ${prem(p.premAtT2)} · ${chg(p.t2, p.premAtT2)}${o.compact ? "" : " · exit the rest"}`);
  const dl = p.delta != null ? Math.abs(p.delta) : null;
  L.push(`📐 R:R 1:${esc(p.rr ?? "—")}${dl ? ` · Δ ${dl.toFixed(2)}: every 10 index pts ≈ ₹${(dl * 10).toFixed(1)} on the premium` : ""} · exit by 15:12${p.triggerRisk?.risk ? ` · risk <b>${esc(p.triggerRisk.risk)}</b>` : ""}`);
  if (!o.compact) {
    const c5 = candleShort(T.candles?.m5), c15 = candleShort(T.candles?.m15);
    if (c5) L.push(`🕯 ${c5}`); if (c15) L.push(`🕯 ${c15}`);
    L.push(`<i>≈ premiums are estimates from the option's delta/gamma, not quotes</i>`);
  }
  return L;
}

/** Trade alert: state headline + radar note + the full trade card + odds. */
export function tradeAlert(d: any, side: "bull" | "bear", state: string, odds?: string): string {
  const ce = side === "bull", nm = esc(short(d.name)), o = d?.trader?.radar?.[side];
  const head = state === "TRIGGERED" ? `🎯 <b>${nm} ${ce ? "BULL" : "BEAR"} TRIGGERED</b>` : state === "ARMED" ? `⏳ <b>${nm} ${ce ? "BULL" : "BEAR"} — GET READY</b> (15-min candle not closed yet)` : `ℹ️ <b>${nm} ${esc(state)}</b>`;
  const L = [`${head} · ${hm(Math.floor(Date.now() / 1000))}`];
  if (o?.text) L.push(`<i>${esc(o.text)}</i>`);
  L.push(...tradeCard(d, side));
  if (odds) L.push(`<i>📊 ${esc(odds)}</i>`);
  return L.join("\n");
}
