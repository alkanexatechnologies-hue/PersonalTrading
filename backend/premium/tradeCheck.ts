// ============================ Trade-message checks (pure, no I/O) ============================
// Week of 19–23 Oct 2026: 9 of 15 Telegram trade calls carried wrong or impossible numbers (stop = start, T1 = T2, T1
// already passed, stop already crossed, T1 premium below the current premium, a target 650 pts away). These checks run on
// every plan BEFORE it is shown as a trade. They do not change how levels are chosen (that is ProTrader-gated) — they only
// refuse to present an impossible plan as a trade, and add the market warnings a senior trader would say out loud.

type Side = "bull" | "bear";
const n0 = (v: number) => Math.round(v).toLocaleString("en-IN");

/** Problems that make a plan impossible to trade as shown. Empty = the numbers are consistent. The checks against the index
 *  price apply once the plan has TRIGGERED (before that the price may legitimately sit beyond the stop while approaching). */
export function planProblems(d: any, side: Side, o: { triggered?: boolean } = {}): string[] {
  const p = d?.trader?.plans?.[side]; if (!p) return [];
  const dir = side === "bull" ? 1 : -1, spot = Number(d?.spot?.price), out: string[] = [];
  const ok = (v: any) => typeof v === "number" && Number.isFinite(v);
  if (!ok(p.entry) || !ok(p.stop) || !ok(p.t1)) return ["levels missing"];
  if (dir * (p.entry - p.stop) <= 0) out.push(`stop ${n0(p.stop)} is not beyond the start ${n0(p.entry)} (zero risk shown)`);
  if (dir * (p.t1 - p.entry) <= 0) out.push(`Target 1 ${n0(p.t1)} is not beyond the start ${n0(p.entry)}`);
  if (ok(p.t2) && Math.round(p.t2) === Math.round(p.t1)) out.push(`Target 1 = Target 2 (${n0(p.t1)})`);
  if (o.triggered && ok(spot) && spot > 0) {
    if (dir * (spot - p.stop) <= 0) out.push(`index ${n0(spot)} is already past the stop ${n0(p.stop)}`);
    if (dir * (spot - p.t1) >= 0) out.push(`index ${n0(spot)} has already reached Target 1 ${n0(p.t1)}`);
  }
  // a target further than about two days' worth of 15-min ranges cannot be an intraday target (23 Oct: T1 656 pts away, ATR15 ~60)
  const atr = Number(d?.trader?.atr15);
  if (ok(atr) && atr > 0 && Math.abs(p.t1 - p.entry) > 8 * atr) out.push(`Target 1 is ${n0(Math.abs(p.t1 - p.entry))} pts away — beyond a realistic day's move (~${n0(8 * atr)})`);
  if (ok(p.premAtT1) && ok(p.premNow) && p.premNow >= 1 && p.premAtT1 <= p.premNow) out.push(`Target 1 premium ₹${n0(p.premAtT1)} is not above the premium now ₹${n0(p.premNow)}`);
  return out;
}

/** What a 15-min-CLOSE stop really risks: the stop distance from the index now, plus one 15-min ATR the index can run
 *  before the candle closes (19–23 Oct: shown 18–80 pts, real losses 136–188 pts). Index points, an estimate. */
export function realisticRisk(d: any, side: Side): { stopPts: number; worstPts: number } | null {
  const p = d?.trader?.plans?.[side], spot = Number(d?.spot?.price), atr = Number(d?.trader?.atr15);
  if (!p || !Number.isFinite(p.stop) || !Number.isFinite(atr)) return null;
  // from the index now once it is beyond the start (triggered / chasing); before that, from the start itself
  const beyond = Number.isFinite(spot) && spot > 0 && (side === "bull" ? spot >= p.entry : spot <= p.entry);
  const from = beyond ? spot : p.entry, stopPts = Math.max(0, Math.round(Math.abs(from - p.stop)));
  return { stopPts, worstPts: Math.round(stopPts + atr) };
}

export interface WarnCtx { vix?: { value: number | null; changePct: number | null } | null; day?: string }
/** Market-behaviour and volatility warnings for a plan — information only, they never block or change a trade. */
export function marketWarnings(d: any, side: Side, ctx: WarnCtx = {}): string[] {
  const T = d?.trader, p = T?.plans?.[side], out: string[] = []; if (!T) return out;
  const dir = side === "bull" ? 1 : -1;
  const vx = ctx.vix?.value, vc = ctx.vix?.changePct;
  if (vx != null && (vx >= 18 || (vc != null && vc >= 8))) out.push(`VIX ${vx.toFixed(1)}${vc != null ? ` (${vc >= 0 ? "+" : ""}${vc.toFixed(1)}%)` : ""} — option premiums swing hard; size down`);
  // fast / quiet market: the last hour's 15-min ranges vs the 15-min ATR
  const cs: any[] = (d?.chart?.candles || []).slice(-5, -1), atr = Number(T.atr15);
  if (cs.length >= 3 && Number.isFinite(atr) && atr > 0) {
    const r = cs.reduce((a, c) => a + (c.high - c.low), 0) / cs.length / atr;
    if (r >= 1.5) out.push(`FAST MARKET — last hour's candles ${r.toFixed(1)}× normal size; stops get hit by noise (6 of 6 fast-market trades stopped, 7–23 Oct)`);
    else if (r <= 0.5) out.push(`QUIET MARKET — candles ${r.toFixed(1)}× normal size; targets may take long, premium decays meanwhile`);
  }
  if (ctx.day && d?.expiry === ctx.day) out.push("EXPIRY DAY — premium decays fast after 13:00; normal plans lost on expiry over 2 years");
  if (T.rangeDay) out.push(`RANGE DAY — ${T.rangeDay.why}`);
  const against = (T.trends || []).filter((t: any) => (dir > 0 ? t.verdict === "DOWN" : t.verdict === "UP")).map((t: any) => t.tf);
  if (against.length) out.push(`AGAINST THE TREND — ${against.join(" + ")} ${dir > 0 ? "down" : "up"}`);
  if (p && Number.isFinite(p.premNow) && Number.isFinite(p.premAtEntry ?? p.premAtTrigger)) {
    const base = p.premAtEntry ?? p.premAtTrigger, x = (p.premNow / base - 1) * 100;
    if (base >= 1 && x >= 10) out.push(`LATE — premium now ₹${n0(p.premNow)} is ${Math.round(x)}% above the start premium ₹${n0(base)}; do not chase`);
  }
  for (const f of (p?.flags || []).slice(0, 1)) out.push(String(f));
  return out;
}
