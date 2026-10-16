// ============================ Closing statement + day-by-day scorecard (pure, no I/O) ============================
// At the close every trade of the day (co-pilot, the user's BTSD trades, zero-hero) is graded on what it actually paid:
// premium points per unit (half at T1 when T1 was booked) and index points. SUCCESS = positive premium points.
// The scorecard keeps one row per day so the success rate can be followed over time. Facts only — no promises.

export interface ReviewTrade {
  source: string; name: string; side: "CE" | "PE"; strike: number; openedAt: number; closedAt?: number | null;
  entrySpot?: number | null; exitSpot?: number | null; entryPrem: number | null; exitPrem?: number | null; t1Prem?: number | null;
  exitWhy?: string | null; state: string;
}
const r = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : r(v).toLocaleString("en-IN"));
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function gradeTrade(t: ReviewTrade) {
  const closed = t.state === "CLOSED", e = t.entryPrem;
  let premPts: number | null = null;
  if (closed && e != null && t.exitPrem != null) premPts = t.t1Prem != null ? 0.5 * (t.t1Prem - e) + 0.5 * (t.exitPrem - e) : t.exitPrem - e;
  const premPct = premPts != null && e ? (premPts / e) * 100 : null;
  const dir = t.side === "CE" ? 1 : -1;
  const idxPts = closed && t.entrySpot != null && t.exitSpot != null ? dir * (t.exitSpot - t.entrySpot) : null;
  const result: "SUCCESS" | "FAILED" | "FLAT" | "OPEN" | "NO PRICE" = !closed ? "OPEN" : premPts == null ? "NO PRICE" : premPts > 0 ? "SUCCESS" : premPts < 0 ? "FAILED" : "FLAT";
  const why = String(t.exitWhy || "");
  const lesson = result !== "FAILED" ? null
    : /STOP|SL/i.test(why) ? "the move reversed through the stop — the setup failed"
    : /TIME/i.test(why) ? "the move never came — time decay took the premium"
    : /RESET|51/i.test(why) ? "zero-hero lost half and had no fresh reason to hold"
    : "closed below the entry premium";
  return { ...t, premPts: premPts == null ? null : r1(premPts), premPct: premPct == null ? null : r(premPct), idxPts: idxPts == null ? null : r1(idxPts), result, lesson };
}
export type Graded = ReturnType<typeof gradeTrade>;

export interface DayScore { n: number; wins: number; losses: number; flat: number; ratePct: number | null; netPremPts: number }
export interface Scorecard { days: Record<string, DayScore> }
export function dayScore(g: Graded[]): DayScore {
  const done = g.filter((x) => x.result === "SUCCESS" || x.result === "FAILED" || x.result === "FLAT");
  const wins = done.filter((x) => x.result === "SUCCESS").length, losses = done.filter((x) => x.result === "FAILED").length;
  return { n: done.length, wins, losses, flat: done.length - wins - losses, ratePct: done.length ? r((wins / done.length) * 100) : null, netPremPts: r1(done.reduce((a, x) => a + (x.premPts ?? 0), 0)) };
}
/** Pooled success rate of today, the last 5 and 20 trading days (with trades), and the 5 before those, + direction. */
export function trend(card: Scorecard, day: string) {
  const days = Object.keys(card.days).filter((d) => d <= day && card.days[d].n > 0).sort().reverse();
  const pool = (ds: string[]) => { const n = ds.reduce((a, d) => a + card.days[d].n, 0), w = ds.reduce((a, d) => a + card.days[d].wins, 0); return { days: ds.length, n, ratePct: n ? r((w / n) * 100) : null }; };
  const last5 = pool(days.slice(0, 5)), prev5 = pool(days.slice(5, 10)), last20 = pool(days.slice(0, 20));
  const direction = last5.ratePct == null || prev5.ratePct == null ? "BUILDING HISTORY" : last5.ratePct > prev5.ratePct ? "IMPROVING" : last5.ratePct < prev5.ratePct ? "WORSE" : "SAME";
  return { today: card.days[day] ?? null, last5, prev5, last20, direction };
}

/** The Telegram closing statement (HTML; every dynamic value escaped). */
export function closingStatementMsg(o: { day: string; indices: { name: string; close: number; changePct: number; high: number; low: number; dayType?: string }[]; graded: Graded[]; tr: ReturnType<typeof trend> }) {
  const LINE = "━━━━━━━━━━━━━━━";
  const L = [`🔔 <b>MARKET CLOSED — CLOSING STATEMENT</b> · ${esc(o.day)}`, LINE];
  for (const x of o.indices) L.push(`${/SENSEX/.test(x.name) ? "🟣" : "🔵"} <b>${esc(x.name.replace(" 50", ""))}</b> ${n0(x.close)} ${x.changePct >= 0 ? "▲ +" : "▼ "}${esc(x.changePct)}% · H ${n0(x.high)} · L ${n0(x.low)}${x.dayType ? ` · <i>${esc(x.dayType)}</i>` : ""}`);
  L.push(LINE, `📋 <b>TRADES TODAY (${o.graded.length})</b>`);
  if (!o.graded.length) L.push("  No trade was given or recorded today — nothing to score.");
  o.graded.forEach((g, i) => {
    const icon = g.result === "SUCCESS" ? "✅" : g.result === "FAILED" ? "❌" : g.result === "OPEN" ? "⏳" : "➖";
    const pts = g.premPts == null ? "—" : `${g.premPts >= 0 ? "+" : ""}${g.premPts} pts (${g.premPct != null && g.premPct >= 0 ? "+" : ""}${g.premPct ?? "—"}%)`;
    L.push(`${icon} <b>#${i + 1} ${esc(g.name.replace(" 50", ""))} ${g.strike} ${g.side}</b> · ${esc(g.source)} · ${hm(g.openedAt)}→${g.closedAt ? hm(g.closedAt) : "open"}`);
    L.push(`    Premium ₹${n0(g.entryPrem)} → ₹${n0(g.exitPrem)}${g.t1Prem != null ? ` (half at T1 ₹${n0(g.t1Prem)})` : ""} = <b>${pts}</b>${g.idxPts != null ? ` · index ${g.idxPts >= 0 ? "+" : ""}${g.idxPts} pts` : ""} · ${esc(g.exitWhy || g.state)}`);
  });
  const s = o.tr.today;
  if (s && s.n) {
    L.push(LINE, `📊 <b>RESULT: ${s.wins}/${s.n} successful (${s.ratePct}%)</b> · net premium <b>${s.netPremPts >= 0 ? "+" : ""}${s.netPremPts} pts/unit</b>`);
    const failed = o.graded.filter((g) => g.result === "FAILED");
    if (failed.length) { L.push(`⚠️ <b>NOT SUCCESSFUL (${failed.length})</b>`); for (const g of failed) L.push(`  ❌ <b>${esc(g.name.replace(" 50", ""))} ${g.strike} ${g.side}: ${g.premPts} pts</b> — ${esc(g.exitWhy || "")}: ${esc(g.lesson)}`); }
  }
  const f = (p: { days: number; n: number; ratePct: number | null }) => (p.n ? `${p.ratePct}% (${p.n} trade${p.n === 1 ? "" : "s"}, ${p.days} day${p.days === 1 ? "" : "s"})` : "—");
  L.push(LINE, `📈 <b>SUCCESS RATE</b> · today ${s?.n ? `${s.ratePct}%` : "—"} · last 5 days ${f(o.tr.last5)} · last 20 days ${f(o.tr.last20)}`);
  L.push(`   Trend vs the 5 days before: <b>${esc(o.tr.direction)}</b>${o.tr.prev5.n ? ` (was ${o.tr.prev5.ratePct}%)` : ""}`);
  L.push("<i>Graded on the actual premium (half at T1 when booked) · history, not a promise · the plan rules decide trades</i>");
  return L.join("\n");
}
