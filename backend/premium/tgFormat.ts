import { oiHtml, wallReviewHtml } from "./oiFlow";
// ============================ Telegram message design (HTML; every dynamic value escaped) ============================
// 15-minute "Best Opportunity" (NIFTY + SENSEX in one message) · 30-minute full read per index · event alerts.
// Advisory only — the arbiter and risk gates decide trades.

export const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const LINE = "━━━━━━━━━━━━━━━";
/** Clear gap between the NIFTY and SENSEX sections of one message. */
const GAP = `\n\n${LINE}\n\n`;
/** Section boundary: the sender sends every section as its own short Telegram message, in order. */
export const SPLIT = "\n\u2063§SPLIT§\u2063\n";
export function splitParts(text: string): string[] { return String(text).split(SPLIT).map((x) => x.trim()).filter(Boolean); }
const icon = (d: any) => (d?.symbol === "^BSESN" ? "🟣" : "🔵");
/** Review in one short line: grade, verdict, how many checks passed and which ones failed. */
export function reviewShort(rv: any): string[] {
  const ok = rv.checks.filter((c: any) => c.ok === true).length, bad = rv.checks.filter((c: any) => c.ok === false).map((c: any) => esc(c.label));
  return [`🧪 <b>Review ${esc(rv.grade)}</b> ${esc(rv.score)}% → <b>${esc(rv.verdict)}</b>`, `✓ ${ok} passed${bad.length ? ` · ✗ ${bad.length} failed: ${bad.join(", ")}` : " · nothing failed"}`];
}
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
  const b = bestFor(d, trade), T = d?.trader, L: string[] = [priceLine(d)];
  if (!b) L.push("  data unavailable");
  else if (b.kind === "TRADE") {
    const t = b.trade, prem = (d.ranking || []).find((x: any) => x.side === t.side && x.strike === t.strike)?.ltp ?? null;
    const pnl = prem != null && t.entryPrem != null ? Math.round(((prem / t.entryPrem) - 1) * 100) : null;
    L.push(`  📌 <b>OPEN TRADE</b> ${t.strike} ${t.side} · entry ₹${n0(t.entryPrem)} → now <b>₹${n0(prem)}</b>${pnl != null ? ` (${pnl >= 0 ? "+" : ""}${pnl}%)` : ""}`);
    L.push(`  🎯 T1 ${n0(t.t1)}${t.t2 ? ` · T2 ${n0(t.t2)}` : ""} · 🛑 ${t.state === "T1" ? `breakeven ${n0(t.entrySpot)} (T1 done)` : `15-min close ${t.side === "CE" ? "below" : "above"} ${n0(t.stop)}`}`);
  } else if (b.kind === "PLAN") {
    const { o, side } = b;
    const tag = o.state === "TRIGGERED" ? "✅ TRIGGERED" : o.state === "ARMED" ? "⏳ ARMED — wait for the close" : o.state === "APPROACHING" ? "👀 APPROACHING" : "· watching";
    L.push(`Status: <b>${tag}</b>`);
    if (T?.rangeDay) L.push(`⚠️ <b>RANGE DAY</b> — ${esc(T.rangeDay.why)}: shown for information, no new trade.`);
    L.push(...planBlock(d, side));
    const rv = T?.review?.[side], why: string[] = rv?.reasoning || [];
    const dec = why[why.length - 1], wrong = why.find((x: string) => /^Wrong if/.test(x));
    if (dec) L.push(`🧠 <b>Senior trader:</b> ${esc(dec.replace(/^Decision:\s*/, ""))}`);
    if (wrong) L.push(`⚠️ ${esc(wrong)}`);
  } else {
    const P = T?.plans, nt = P?.noTrade;
    if (T?.rangeDay) L.push(`⚠️ <b>RANGE DAY</b> — ${esc(T.rangeDay.why)}: no new trades after ${esc(T.rangeDay.at)}.`);
    L.push(`🧠 <b>Senior trader:</b> nothing to do right now — ${esc(T?.coach?.action ?? "wait")}.`);
    if (P?.bull || P?.bear) L.push(`${P?.bull ? `🟢 Bull only on a 15-min close above <b>${n0(P.bull.entry)}</b>` : ""}${P?.bull && P?.bear ? " · " : ""}${P?.bear ? `🔴 Bear only below <b>${n0(P.bear.entry)}</b>` : ""}`);
    if (nt && d.spot?.price >= nt.from && d.spot?.price <= nt.to) L.push(`<i>Price is in the no-trade zone ${n0(nt.from)}–${n0(nt.to)}: the middle pays nobody — wait for a side to break.</i>`);
  }
  void eye;
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
  return items.filter((x) => x.d?.available).map((x) => [`⭐ <b>BEST OPPORTUNITY · ${esc(short(x.d.name))}</b> · ${t}`, bestBlock(x.d, x.trade, x.eye, x.zh), "<i>Start = a 15-min candle CLOSE beyond the level · advisory only</i>"].join("\n")).join(SPLIT);
}
/** 30-minute message: the full read of one index. */
export function fullReadMsg(d: any, trade: any | null, eye: any | null, zh: any | null, odds?: string): string {
  const T = d?.trader; if (!T || T.error) return `<b>${esc(d?.name)}</b>: full read unavailable`;
  const c = T.candles, b = T.plans?.bull, r = T.plans?.bear, rb = T.radar?.bull, rr = T.radar?.bear;
  const L = [`📊 <b>${esc(short(d.name))} — FULL READ</b> · ${hm(Math.floor(Date.now() / 1000))}`, priceLine(d), LINE];
  L.push("🕯 <b>Candles</b>");
  if (c?.m5) L.push(`• ${candleShort(c.m5)}`); if (c?.m15) L.push(`• ${candleShort(c.m15)}`);
  L.push(`📐 <b>Trend</b>  ${(T.trends || []).map((x: any) => `${esc(x.tf)} ${x.verdict === "UP" ? "▲" : x.verdict === "DOWN" ? "▼" : "▬"}`).join(" · ")}`);
  void b; void r; void rb; void rr;
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
  return [L.join("\n"), boardParts(d)].join(SPLIT);
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
  if (!ok.length) return `🗓 <b>NEXT-DAY PLAN</b> · for <b>${esc(forDay)}</b>\nPlan unavailable — data not loaded.`;
  const parts: string[] = [];
  for (const { d, odds } of ok) {
    // per index: 1 short summary message, then Bull plan · No-trade zone · Bear plan · OI movement
    const T = d.trader, s = d.spot, px = s?.price;
    const L = [`🗓 <b>NEXT-DAY PLAN · ${esc(short(d.name))}</b> · for <b>${esc(forDay)}</b>`, `${icon(d)} closed <b>${n0(px)}</b> ${arrow(s?.change)} ${s?.changePct > 0 ? "+" : ""}${esc(s?.changePct)}% · O ${n0(s?.open)} · H ${n0(s?.high)} · L ${n0(s?.low)}`];
    const lv = (T.levels || []).filter((x: any) => Number.isFinite(x.price) && px != null);
    const above = lv.filter((x: any) => x.price > px).sort((a: any, c: any) => a.price - c.price).slice(0, 3);
    const below = lv.filter((x: any) => x.price < px).sort((a: any, c: any) => c.price - a.price).slice(0, 3);
    if (above.length) L.push(`⬆ ${above.map((x: any) => `${n0(x.price)} <i>${esc(x.label)}</i>`).join(" · ")}`);
    if (below.length) L.push(`⬇ ${below.map((x: any) => `${n0(x.price)} <i>${esc(x.label)}</i>`).join(" · ")}`);
    for (const sc of (T.tomorrow?.scenarios || []).slice(0, 3)) L.push(`• ${esc(sc)}`);
    if (d.expiry && d.expiry === forDay) L.push(`🎲 <b>Expiry day</b> — zero-hero search 09:30–15:10`);
    if (odds) L.push(`<i>📊 ${esc(odds)}</i>`);
    L.push("<i>Re-checked at 09:13 with the live open · advisory only</i>");
    parts.push(L.join("\n"), boardParts(d));
  }
  return parts.join(SPLIT);
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
    if (/^<(b|pre|code)>$/i.test(part)) { depth++; return part; }
    if (/^<\/(b|pre|code)>$/i.test(part)) { depth = Math.max(0, depth - 1); return part; }
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
  L.push(...planBlock(d, side, { candle: true }));
  if (d.oi) L.push(...oiHtml(d.oi, { compact: true }));
  if (odds) L.push(`<i>📊 ${esc(odds)}</i>`);
  return L.join("\n");
}

// ---------------------------------------------------------------- the PLAN BOARD — same layout as the Premium Prediction screen
const RISKW: Record<string, string> = { LOW: "LOW RISK", MEDIUM: "MED RISK", HIGH: "HIGH RISK", FAR: "FAR" };
const pad = (v: string, n: number, right = false) => (right ? v.padStart(n) : v.padEnd(n));
/** One plan exactly like the screen card: risk, start, buy, review + chips, Start/Stop/Target table, R:R. */
export function planBlock(d: any, side: "bull" | "bear", o: { candle?: boolean } = {}): string[] {
  const T = d?.trader, p = T?.plans?.[side], ce = side === "bull", leg = ce ? "CE" : "PE", idx = short(d?.name);
  if (!p) return [`${ce ? "🟢" : "🔴"} <b>${ce ? "BULL" : "BEAR"} PLAN</b> — no level ${ce ? "above" : "below"} the price`];
  const expired = p.premNow != null && p.premNow < 1;
  const rk = p.triggerRisk?.risk, L: string[] = [];
  L.push(`${ce ? "🟢" : "🔴"} <b>${esc(idx)} · ${ce ? "BULL" : "BEAR"} PLAN</b>${rk ? ` · <b>${esc(RISKW[rk] ?? rk)}</b>` : ""}`);
  L.push(`Starts on a 15-min close ${ce ? "above" : "below"} <b>${n0(p.entry)}</b>`);
  L.push(`Buy <b>${p.strike ?? "—"} ${leg}</b> ${expired ? "(premium at the open)" : p.premNow != null ? `(now ₹${n0(p.premNow)})` : ""}`);
  if (p.premPos && !expired) L.push(p.premPos.danger ? `<b>${esc(p.premPos.text)}</b>` : `Premium ${esc(p.premPos.text)}`);
  const rv = T?.review?.[side];
  if (rv) L.push(...reviewShort(rv));
  const pr = (v: number | null | undefined) => (expired || v == null || !Number.isFinite(v) ? "—" : `₹${n0(v)}`);
  const row = (lbl: string, lvl: number, pv: number | null | undefined, pts: string) => `${pad(lbl, 9)}${pad(n0(lvl), 7, true)}${pad(pr(pv), 7, true)}${pad(pts, 7, true)}`;
  const d1 = (lvl: number) => `${(ce ? lvl - p.entry : p.entry - lvl) >= 0 ? "+" : "−"}${n0(Math.abs(lvl - p.entry))}`;
  const tbl = [`${pad("", 9)}${pad(esc(idx), 7, true)}${pad(leg, 7, true)}${pad("pts", 7, true)}`,
    row("Start", p.entry, p.premAtEntry ?? p.premAtTrigger, ""), row("Stop", p.stop, p.premAtStop, d1(p.stop)), row("Target 1", p.t1, p.premAtT1, d1(p.t1))];
  if (p.t2 != null) tbl.push(row("Target 2", p.t2, p.premAtT2, d1(p.t2)));
  L.push(`<pre>${tbl.join("\n")}</pre>`);
  L.push(`Reward : risk <b>1 : ${esc(p.rr ?? "—")}</b> · exit by 15:12`);
  if (o.candle) { const c5 = candleShort(T?.candles?.m5); if (c5) L.push(`🕯 ${c5}`); }
  return L;
}
/** The no-trade zone and the lowest-risk ideas (same rules as the screen). */
export function noTradeBlock(d: any): string[] {
  const T = d?.trader, nt = T?.plans?.noTrade, spot = d?.spot?.price; if (!T) return [];
  const L: string[] = [];
  if (nt) L.push(`⏸ <b>${esc(short(d?.name))} · NO-TRADE ZONE</b> ${n0(nt.from)} – ${n0(nt.to)}`, `${n0(nt.to - nt.from)} pts wide (${((nt.to - nt.from) / (T.atr15 || 1)).toFixed(1)} × ATR)`);
  if (spot == null) return L;
  const lv = (T.levels || []).filter((v: any) => v.risk && v.risk.risk !== "FAR");
  const near = (arr: any[]) => arr.sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))[0];
  const sup = near(lv.filter((v: any) => v.price < spot && v.risk.bounce)), res = near(lv.filter((v: any) => v.price > spot && v.risk.bounce));
  const items: string[] = [];
  if (sup) items.push(`• CE on a bounce from <b>${n0(sup.price)}</b> (${esc(sup.label)}) — stop just below`);
  if (res) items.push(`• PE on a rejection from <b>${n0(res.price)}</b> (${esc(res.label)}) — stop just above`);
  for (const v of lv.filter((x: any) => x.risk.risk === "LOW").slice(0, 2)) items.push(`• ${v.price > spot ? "CE" : "PE"} on a 15-min close ${v.price > spot ? "above" : "below"} <b>${n0(v.price)}</b> — LOW-RISK break`);
  L.push(`<b>Lowest-risk ideas now</b>`, ...(items.length ? items : ["• none — every nearby level is risky; standing aside is a position"]));
  return L;
}
/** The whole board for one index: Bull plan · No-trade zone · Bear plan. */
/** Bull plan · No-trade zone · Bear plan · OI movement — four short messages. */
export function boardParts(d: any): string {
  const parts = [planBlock(d, "bull").join("\n"), noTradeBlock(d).join("\n"), planBlock(d, "bear").join("\n")];
  if (d?.oi) parts.push(oiHtml(d.oi, { expiry: d.expiry, name: short(d.name) }).join("\n"));
  return parts.join(SPLIT);
}
export function planBoardMsg(d: any, title = "TRADE PLAN"): string {
  return `${icon(d)} <b>${esc(short(d?.name))} — ${esc(title)}</b> · ${n0(d?.spot?.price)} · ${hm(Math.floor(Date.now() / 1000))}\n` + boardParts(d);
}

/** 15-minute CANDLE message: the candle that just closed, where it closed, OI in the last 15 min, Market Eye — a senior trader's read. */
export function candleMsg(d: any, eye: any | null, nowSec = Math.floor(Date.now() / 1000)): string {
  const T = d?.trader, nm = esc(short(d?.name));
  const cs = (d?.chart?.candles || []).filter((c: any) => c.time + 900 <= nowSec);
  const c = cs[cs.length - 1], pc = cs[cs.length - 2];
  if (!c || !T) return `🕯 <b>${nm} · 15-MIN CANDLE</b>\ncandle data unavailable`;
  const chg = pc ? c.close - pc.close : c.close - c.open, rng = c.high - c.low || 1, loc = Math.round(((c.close - c.low) / rng) * 100);
  const L = [`🕯 <b>${nm} · 15-MIN CANDLE ${hm(c.time)}–${hm(c.time + 900)}</b>`];
  L.push(`O ${n0(c.open)} · H ${n0(c.high)} · L ${n0(c.low)} · C <b>${n0(c.close)}</b> (${chg >= 0 ? "+" : "−"}${n0(Math.abs(chg))} pts) ${c.close >= c.open ? "🟩" : "🟥"}`);
  const m15 = T.candles?.m15, m5 = T.candles?.m5;
  if (m15 && m15.time === c.time) L.push(`Type: ${esc(m15.pattern || String(m15.shape || "").replace(/\s*\(body \d+%\)/, ""))} · closed at ${loc}% of its range${m15.at ? ` · at ${esc(m15.at)}` : ""}`);
  else L.push(`Closed at ${loc}% of its range (${loc >= 70 ? "buyers held the close" : loc <= 30 ? "sellers held the close" : "two-way"})`);
  if (m5) L.push(`5-min: ${candleShort(m5).replace(/^5-min /, "")}`);
  const vw = (d.chart?.vwap || []).filter((v: any) => Number.isFinite(v)).slice(-1)[0], px = d.spot?.price ?? c.close;
  const lv = (T.levels || []).filter((x: any) => Number.isFinite(x.price) && x.kind !== "TODAY");
  const up = lv.filter((x: any) => x.price > px).sort((a: any, b: any) => a.price - b.price)[0], dn = lv.filter((x: any) => x.price < px).sort((a: any, b: any) => b.price - a.price)[0];
  L.push(`Index <b>${n0(px)}</b>${vw != null ? ` · VWAP ${n0(vw)} (${px >= vw ? "above" : "below"})` : ""}`);
  if (up || dn) L.push(`${up ? `Resistance <b>${n0(up.price)}</b> <i>${esc(up.label)}</i>` : ""}${up && dn ? " · " : ""}${dn ? `Support <b>${n0(dn.price)}</b> <i>${esc(dn.label)}</i>` : ""}`);
  L.push(`Trend: ${(T.trends || []).map((x: any) => `${esc(x.tf)} ${x.verdict === "UP" ? "▲" : x.verdict === "DOWN" ? "▼" : "▬"}`).join(" · ")}`);
  const f = d.oi;
  if (f) {
    const l15 = f.last15;
    L.push(`📊 OI ${l15 ? `last ${l15.ageMin} min: CE ${sgnOi(l15.ce)} · PE ${sgnOi(l15.pe)}${l15.top ? ` · most at <b>${l15.top.side} ${n0(l15.top.strike)} ${sgnOi(l15.top.chg)}</b>` : ""} · tilt ${l15.tilt == null ? "—" : `Bulls ${l15.tilt}%`}` : `today: tilt Bulls ${f.tiltToday ?? "—"}% (${esc(f.bias)})`} · PCR ${f.pcr ?? "—"}`);
  }
  if (d.oiWalls) L.push(...wallReviewHtml(d.oiWalls));
  if (d.lmLines?.length) {
    L.push(`🧠 <b>Levels tested</b>`);
    for (const { e, z } of d.lmLines) {
      const word = e.outcome === "RESPECTED" ? (e.role === "SUPPORT" ? "support HELD" : "resistance REJECTED") : e.outcome === "FAKE BREAK" ? `fake break — ${e.role === "SUPPORT" ? "support" : "resistance"} held` : `${e.role === "SUPPORT" ? "support" : "resistance"} BROKEN`;
      const rec = z ? ` · zone record (60 sessions): held ${z.holdPct ?? "—"}% of ${z.tests}` : "";
      L.push(`  ${hm(e.time)} <b>${n0(e.price)}</b> ${esc(e.label)} — ${word}${rec}`);
    }
  }
  if (eye) L.push(`👁 Next 30 min in similar moments: ↑${eye.upPct}% ↔${eye.sidePct}% ↓${eye.downPct}% → <b>${esc(eye.lead)}</b>`);
  // the senior trader's one-line read of this candle
  const atr = T.atr15 || rng, near = (x: any) => x && Math.abs(x.price - px) <= 0.5 * atr;
  const who = loc >= 70 && c.close > c.open ? "Buyers won this candle" : loc <= 30 && c.close < c.open ? "Sellers won this candle" : "Neither side won this candle";
  const where = near(up) ? `, now testing resistance ${n0(up.price)} — a 15-min close above it is the trigger, a rejection is a warning` : near(dn) ? `, now sitting on support ${n0(dn.price)} — hold = bounce idea, close below = breakdown` : vw != null ? `, ${px >= vw ? "holding above" : "trading below"} VWAP` : "";
  L.push(`🧠 <b>Read:</b> ${esc(who + where)}.`);
  return L.join("\n");
}
const sgnOi = (v: number) => `${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1e5).toFixed(1)}L`;

/** 09:14 Telegram: the 09:13 opening heat of the top 15 major NIFTY stocks, picked by the market bias (same rule as the screen). */
export function openingHeatMsg(rows: { s: string; weightPct: number; pct: number | null; points: number | null }[], bias: string, date: string): string {
  const major = rows.filter((r) => r.pct != null && r.weightPct >= 1) as { s: string; weightPct: number; pct: number; points: number | null }[];
  const up = [...major].sort((a, b) => b.pct - a.pct), dn = [...major].sort((a, b) => a.pct - b.pct);
  const pick = bias === "BULLISH" ? up.slice(0, 15) : bias === "BEARISH" ? dn.slice(0, 15) : [...up.slice(0, 8), ...dn.slice(0, 7).reverse()];
  const pts = major.reduce((a, r) => a + (r.points ?? 0), 0), upN = major.filter((r) => r.pct > 0).length;
  const sq = (p: number) => (p >= 1 ? "🟩" : p > 0 ? "🟢" : p <= -1 ? "🟥" : p < 0 ? "🔴" : "⬜");
  return [`🔥 <b>OPENING HEAT 09:13 · TOP 15 NIFTY</b> · ${esc(date)}`,
    `Market bias <b>${esc(bias)}</b> · ${upN}/${major.length} major stocks up · ≈ <b>${pts >= 0 ? "+" : ""}${Math.round(pts)} NIFTY pts</b> from the open`,
    ...pick.map((r) => `${sq(r.pct)} <b>${esc(r.s)}</b> ${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}% · wt ${r.weightPct}%${r.points != null ? ` · ${r.points >= 0 ? "+" : ""}${r.points} pts` : ""}`),
    `<i>09:13 pre-open prices (Dhan) · ${bias === "BULLISH" ? "top gainers" : bias === "BEARISH" ? "top losers" : "8 gainers + 7 losers"} · weights = the app's NIFTY model</i>`].join("\n");
}
