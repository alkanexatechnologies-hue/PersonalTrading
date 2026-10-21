// ============================ Day-range break alerts + index level summaries (context only) ============================
// Every minute in market hours each index's price is compared with TODAY's high / low as they stood BEFORE this
// minute. A level counts only after it has stood for ≥ 10 minutes (so a trending market does not alert on every new
// tick high) and only after 09:30 (opening range done). Same index + side: at most one alert per 15 minutes.
// A break must exceed the market's own noise (median 1-minute move of the last 15 minutes). Messages go through the
// app's notification service (Telegram). Nothing here trades.

export interface Tick { t: number; price: number }
export interface RangeState { high: number | null; highAt: number | null; low: number | null; lowAt: number | null; ticks: Tick[]; lastAlert: { HIGH?: number; LOW?: number } }
export const newState = (): RangeState => ({ high: null, highAt: null, low: null, lowAt: null, ticks: [], lastAlert: {} });

const istHm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
export const STAND_SEC = 10 * 60, COOLDOWN_SEC = 15 * 60, START_HM = "09:30";

function noise(ticks: Tick[], now: number): number {
  const w = ticks.filter((k) => now - k.t <= 15 * 60);
  const d = w.slice(1).map((k, i) => Math.abs(k.price - w[i].price)).sort((a, b) => a - b);
  return d.length >= 5 ? d[Math.floor(d.length / 2)] : 0;
}

/** Feed one price (and the exchange's day high / low when known). Returns a break event or null. Mutates `st`. */
export function onTick(st: RangeState, t: number, price: number, dayHigh?: number | null, dayLow?: number | null): { side: "HIGH" | "LOW"; level: number; levelAt: number; price: number; by: number } | null {
  let ev: ReturnType<typeof onTick> = null;
  const nz = noise(st.ticks, t);
  if (st.high != null && st.highAt != null && istHm(t) >= START_HM && price > st.high + nz && t - st.highAt >= STAND_SEC && t - (st.lastAlert.HIGH || 0) >= COOLDOWN_SEC) {
    ev = { side: "HIGH", level: st.high, levelAt: st.highAt, price, by: Math.round((price - st.high) * 100) / 100 }; st.lastAlert.HIGH = t;
  } else if (st.low != null && st.lowAt != null && istHm(t) >= START_HM && price < st.low - nz && t - st.lowAt >= STAND_SEC && t - (st.lastAlert.LOW || 0) >= COOLDOWN_SEC) {
    ev = { side: "LOW", level: st.low, levelAt: st.lowAt, price, by: Math.round((st.low - price) * 100) / 100 }; st.lastAlert.LOW = t;
  }
  // update the running range AFTER the check (the level that was broken is the one that stood before this tick)
  const hi = Math.max(price, dayHigh ?? -Infinity), lo = Math.min(price, dayLow ?? Infinity);
  if (st.high == null || hi > st.high) { st.high = hi; st.highAt = t; }
  if (st.low == null || lo < st.low) { st.low = lo; st.lowAt = t; }
  st.ticks.push({ t, price }); if (st.ticks.length > 40) st.ticks.shift();
  return ev;
}

export interface Levels { support: number | null; supportOi?: number | null; nextSupport?: number | null; resistance: number | null; resistanceOi?: number | null; nextResistance?: number | null; pcr?: number | null; pcrLabel?: string | null; pdh?: number | null; pdl?: number | null }
const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const lakh = (v: number | null | undefined) => (v == null ? "" : ` (${(v / 1e5).toFixed(1)} L OI)`);

export function breakMessage(name: string, ev: NonNullable<ReturnType<typeof onTick>>, lv: Levels): string {
  const up = ev.side === "HIGH";
  return [
    `${up ? "🔺" : "🔻"} ${name}: today's ${up ? "HIGH" : "LOW"} ${n0(ev.level)} (set ${istHm(ev.levelAt)}) BROKEN — now ${n0(ev.price)} (${up ? "+" : "−"}${ev.by.toFixed(1)}) at ${istHm(Math.floor(Date.now() / 1000))} IST`,
    up ? `Next resistance: ${n0(lv.resistance)}${lakh(lv.resistanceOi)}${lv.nextResistance ? `, then ${n0(lv.nextResistance)}` : ""}` : `Next support: ${n0(lv.support)}${lakh(lv.supportOi)}${lv.nextSupport ? `, then ${n0(lv.nextSupport)}` : ""}`,
    up ? `Support now: ${n0(lv.support)}` : `Resistance now: ${n0(lv.resistance)}`,
    lv.pcr != null ? `PCR ${lv.pcr.toFixed(2)} ${lv.pcrLabel || ""}` : "",
    "Context only — confirm on a closed candle; the arbiter decides trades.",
  ].filter(Boolean).join("\n");
}

const SHORT: [RegExp, string][] = [[/^Prev week high/, "PWH"], [/^Prev week low/, "PWL"], [/^Prev day high/, "PDH"], [/^Prev day low/, "PDL"], [/^Prev close/, "PDC"],
  [/^R(\d) pivot/, "R$1"], [/^S(\d) pivot/, "S$1"], [/^OI call wall/, "CallWall"], [/^OI put wall/, "PutWall"], [/^Major call OI/, "MaxCall"], [/^Major put OI/, "MaxPut"], [/^Daily (buyer|seller) trendline/, "D-TL"], [/^15m (buyer|seller) trendline/, "15m-TL"]];
export const shortLabel = (l: string) => { for (const [re, t] of SHORT) if (re.test(l)) return l.replace(re, t); return l; };
export interface LadderRow { price: number; label: string; dist: number; hold: number | null; tests: number; confluence?: boolean }
export function summaryMessage(rows: { name: string; price: number | null; high: number | null; low: number | null; changePct?: number | null; lv: Levels }[], label: string): string {
  const lines = [`📊 Index levels — ${label}`];
  for (const r of rows) {
    lines.push(`\n${r.name}: ${n0(r.price)}${r.changePct != null ? ` (${r.changePct > 0 ? "+" : ""}${r.changePct.toFixed(2)}%)` : ""}`);
    lines.push(`  Day H ${n0(r.high)} · L ${n0(r.low)} · R ${n0(r.lv.resistance)} · S ${n0(r.lv.support)}${r.lv.pcr != null ? ` · PCR ${r.lv.pcr.toFixed(2)}` : ""}`);
    // 📏 level ladder: nearest levels above / below, short names, tested hold % — one line each side
    const lad = (r as any).ladder as { above: LadderRow[]; below: LadderRow[] } | undefined;
    if (lad && (lad.above.length || lad.below.length)) {
      const it = (x: LadderRow) => `${n0(x.price)} ${shortLabel(x.label)}${x.hold != null ? ` ${x.hold}%` : ""}${x.confluence ? "★" : ""}`;
      lines.push(`  🔺 ${lad.above.length ? lad.above.map(it).join(" · ") : "—"}`);
      lines.push(`  🔻 ${lad.below.length ? lad.below.map(it).join(" · ") : "—"}`);
    }
  }
  return lines.join("\n");
}

// 🔥 Hourly HOT PREMIUMS — summary first: one verdict, the best call and the best put (buy zone = the premium's support, sell
// zone = its resistance, the TESTED % chance it breaks that resistance and the % chance support breaks first), then the other
// strikes in one line each. Numbers come from the Premium Calculator engine (same as the screen). Plain text, one message per index.
export interface HotMsgRow { strike: number; side: "CE" | "PE"; money: string; rank: number; hot: boolean; ltp: number; atTarget: number; upPct: number; riskPct: number; rr: number;
  liq: string; spreadPct: number | null; delta: number | null; levels: { support: { price: number; touches: number }[]; resistance: { price: number; touches: number }[]; state: string } | null;
  rating: { stars: number; passPct: number | null; failPct?: number | null; n?: number; state?: string; label?: string; support?: number | null; resistance?: number | null } | null }
const rs = (v: number | null | undefined) => (v == null ? "—" : "₹" + (Math.round(v * 10) / 10).toLocaleString("en-IN"));
/** The best row of a side: most stars, then 🔥, then (chance to break R − chance support breaks first), then the engine's own
 *  rank (reward ÷ risk preferring delta 0.30–0.60 — never just the cheapest far-OTM strike). */
export function bestRow(rows: HotMsgRow[]): HotMsgRow | null {
  const edge = (x: HotMsgRow) => (x.rating?.passPct ?? 0) - (x.rating?.failPct ?? 100);
  return [...rows].sort((a, b) => (b.rating?.stars ?? 0) - (a.rating?.stars ?? 0) || Number(b.hot) - Number(a.hot) || edge(b) - edge(a) || a.rank - b.rank)[0] ?? null;
}
export function hotMessage(o: { name: string; spot: number; ceTarget: number; peTarget: number; ceFrom: string; peFrom: string; ce: HotMsgRow[]; pe: HotMsgRow[]; label: string }): string {
  const bc = bestRow(o.ce), bp = bestRow(o.pe), all = [bc, bp].filter(Boolean) as HotMsgRow[];
  const top = [...all].sort((a, b) => (b.rating?.stars ?? 0) - (a.rating?.stars ?? 0) || (b.rating?.passPct ?? -1) - (a.rating?.passPct ?? -1))[0];
  const st = top?.rating?.state, verdict = !top ? "👉 NO DATA — no liquid premium right now."
    : (top.rating?.stars ?? 0) >= 4 ? `👉 BUY ${top.strike} ${top.side} — rising from ${rs(top.rating?.support)}, ${top.rating?.passPct}% chance to break ${rs(top.rating?.resistance)}`
    : st === "AT SUPPORT" ? `👉 WATCH ${top.strike} ${top.side} on support ${rs(top.rating?.support)} — buy on a green 15-min close (${top.rating?.passPct}% chance to break ${rs(top.rating?.resistance)})`
    : "👉 WAIT — no premium rising from support.";
  const where: Record<string, string> = { BOUNCING: "🟢 rising from S", "AT SUPPORT": "🟡 on S", "MID-RANGE": "⚪ mid", "AT RESISTANCE": "🟠 near R", "BELOW SUPPORT": "🔴 below S" };
  const block = (x: HotMsgRow | null, side: "CE" | "PE", target: number) => {
    if (!x) return [`${side === "CE" ? "📈 CALL" : "📉 PUT"}: none liquid`];
    const R = x.rating;
    return [`${side === "CE" ? "📈 CALL" : "📉 PUT"} ${x.strike} ${side} ${rs(x.ltp)} ${R ? "★".repeat(R.stars) + "☆".repeat(5 - R.stars) : ""}${x.hot ? "🔥" : ""} · ${where[R?.state || ""] ?? "—"}`,
      `   Buy ${rs(R?.support ?? x.levels?.support?.[0]?.price)} · Sell ${rs(R?.resistance ?? x.levels?.resistance?.[0]?.price)} · Break R ${R?.passPct != null ? R.passPct + "%" : "—"} · S fails ${R?.failPct != null ? R.failPct + "%" : "—"}`,
      `   At ${n0(target)}: ${rs(x.atTarget)} (+${x.upPct}%) · other way −${x.riskPct}% · ${x.liq === "GOOD" ? "liquid" : x.liq === "NO QUOTE" ? "no quote" : "wide"}`];
  };
  const others = (rows: HotMsgRow[], best: HotMsgRow | null) => rows.filter((x) => x !== best).map((x) => `${x.strike} ${rs(x.ltp)} ${x.rating?.passPct != null ? x.rating.passPct + "%" : "—"}`).join(" · ") || "—";
  return [`🔥 ${o.name} ${n0(o.spot)} — HOT PREMIUMS · ${o.label}`, verdict, "",
    ...block(bc, "CE", o.ceTarget), ...block(bp, "PE", o.peTarget), "",
    `Calls: ${others(o.ce, bc)}`, `Puts: ${others(o.pe, bp)}`].join("\n");
}

// 📊 OI ANALYSIS data (Dhan option chain + the app's own minute snapshots) for the 15-min OI update below.
export interface OiMsgIn { name: string; spot: number; label: string; pcr: number | null; pcrBefore: number | null; hourMin: number | null;
  hour: { ce: number; pe: number; tilt: number | null; top: { side: string; strike: number; chg: number; meaning: string } | null } | null;
  today: { ce: number; pe: number; tilt: number | null }; totalCeL: number; totalPeL: number; bias: string; biasWhy: string;
  callWall: { strike: number; oiL: number; state: string; pct: number | null; shiftedFrom: number | null } | null; putWall: { strike: number; oiL: number; state: string; pct: number | null; shiftedFrom: number | null } | null;
  majorCall: number | null; majorPut: number | null; movers: { side: string; strike: number; chgL: number; meaning: string }[] }
const lk = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round((v / 1e5) * 10) / 10).toFixed(1)}L`;
/** 📊 15-min OI UPDATE — NIFTY and SENSEX in ONE message (a gap between them): total call / put OI, PCR (and 15 min ago), the last
 *  15 minutes' writing, today's writing, the two walls and the read. */
export function oi15Message(items: OiMsgIn[], label: string): string {
  const tl = (t: number | null) => (t == null ? "—" : `Bulls ${t}% · Bears ${100 - t}%`);
  const sec = (o: OiMsgIn) => {
    const w = (x: OiMsgIn["callWall"]) => (x ? `${n0(x.strike)} · ${x.oiL}L · ${x.state}${x.pct != null && x.shiftedFrom == null ? ` (${x.pct >= 0 ? "+" : ""}${x.pct}%)` : x.shiftedFrom != null ? ` from ${n0(x.shiftedFrom)}` : ""}` : "—");
    return [`━━ ${o.name} ${n0(o.spot)} ━━`,
      `Total OI: Calls ${o.totalCeL}L · Puts ${o.totalPeL}L · PCR ${o.pcr ?? "—"}${o.pcrBefore != null ? ` (${o.hourMin} min ago ${o.pcrBefore})` : ""}`,
      o.hour ? `Last ${o.hourMin} min: Calls ${lk(o.hour.ce)} · Puts ${lk(o.hour.pe)} → ${tl(o.hour.tilt)}` : "Last 15 min: — (first read)",
      `Today: Calls ${lk(o.today.ce)} · Puts ${lk(o.today.pe)} → ${tl(o.today.tilt)}`,
      `🧱 ${w(o.callWall)}  🛡 ${w(o.putWall)}`,
      `👉 ${o.bias === "BULLISH" ? "🟢 BULLISH — put writing heavier" : o.bias === "BEARISH" ? "🔴 BEARISH — call writing heavier" : "⚪ NEUTRAL — balanced writing"}`].join("\n");
  };
  return [`📊 OI UPDATE · ${label}`, "", ...items.flatMap((o, i) => [...(i ? ["", "⁣", ""] : []), sec(o)])].join("\n");
}
