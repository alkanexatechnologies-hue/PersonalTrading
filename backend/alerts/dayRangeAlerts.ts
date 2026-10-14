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

export function summaryMessage(rows: { name: string; price: number | null; high: number | null; low: number | null; changePct?: number | null; lv: Levels }[], label: string): string {
  const lines = [`📊 Index levels — ${label}`];
  for (const r of rows) {
    lines.push(`\n${r.name}: ${n0(r.price)}${r.changePct != null ? ` (${r.changePct > 0 ? "+" : ""}${r.changePct.toFixed(2)}%)` : ""}`);
    lines.push(`  Day H ${n0(r.high)} · L ${n0(r.low)}`);
    lines.push(`  Resistance ${n0(r.lv.resistance)}${r.lv.nextResistance ? ` / ${n0(r.lv.nextResistance)}` : ""} · Support ${n0(r.lv.support)}${r.lv.nextSupport ? ` / ${n0(r.lv.nextSupport)}` : ""}`);
    if (r.lv.pcr != null) lines.push(`  PCR ${r.lv.pcr.toFixed(2)} ${r.lv.pcrLabel || ""}${r.lv.pdh != null ? ` · Prev day H ${n0(r.lv.pdh)} / L ${n0(r.lv.pdl)}` : ""}`);
  }
  lines.push("\nOI walls: nearest strike holding ≥ half of the biggest OI on that side. Context only.");
  return lines.join("\n");
}
