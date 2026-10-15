// ============================ Market Eye — "what did NIFTY do next in moments like this?" (descriptive, no I/O) ============================
// From 2 years of 1-minute NIFTY spot, every 5 minutes (09:45–15:00) records the state of the day and what the next 30
// minutes did. Live, the most similar past moments (same time of day ±30 min, nearest by day change, distance from the
// day high / low and the last 30 / 5 minutes' move) are counted: UP / SIDEWAYS / DOWN in the next 30 minutes, with n.
// It is a historical tendency, not a forecast; tiny samples are labelled as such.

export interface EyeRow { day: string; min: number; dayChg: number; fromHigh: number; fromLow: number; ret30: number; ret5: number; next30: number; minNext: number; maxNext: number }
export interface EyeState { min: number; dayChg: number; fromHigh: number; fromLow: number; ret30: number; ret5: number }
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Build rows from per-day 1-minute series [time, price] with the previous close. */
export function buildRows(days: { day: string; minutes: [number, number][]; prevClose: number }[]): EyeRow[] {
  const out: EyeRow[] = [], minOf = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
  for (const d of days) {
    const m = d.minutes; if (m.length < 300 || !(d.prevClose > 0)) continue;
    const byMin = new Map(m.map(([t, p]) => [minOf(t), p]));
    let hi = -Infinity, lo = Infinity; const run: { min: number; hi: number; lo: number }[] = [];
    for (const [t, p] of m) { hi = Math.max(hi, p); lo = Math.min(lo, p); run.push({ min: minOf(t), hi, lo }); }
    for (let mm = 585; mm <= 900; mm += 5) {
      const p = byMin.get(mm), p30 = byMin.get(mm - 30), p5 = byMin.get(mm - 5), f = byMin.get(mm + 30); if (p == null || p30 == null || p5 == null || f == null) continue;
      const st = run.filter((x) => x.min <= mm).pop()!; const fut = m.filter(([t]) => { const k = minOf(t); return k > mm && k <= mm + 30; }).map((x) => x[1]);
      out.push({ day: d.day, min: mm, dayChg: (p / d.prevClose - 1) * 100, fromHigh: (st.hi - p) / p * 100, fromLow: (p - st.lo) / p * 100, ret30: (p / p30 - 1) * 100, ret5: (p / p5 - 1) * 100,
        next30: (f / p - 1) * 100, minNext: (Math.min(...fut) / p - 1) * 100, maxNext: (Math.max(...fut) / p - 1) * 100 });
    }
  }
  return out;
}
/** The k most similar past moments (time of day within ±30 min; no rows from `excludeDay`) and their next-30-minute outcome. */
export function lookup(rows: EyeRow[], s: EyeState, k = 30, excludeDay?: string, flat = 0.1) {
  const W = { dayChg: 1 / 0.5, fromHigh: 1 / 0.25, fromLow: 1 / 0.25, ret30: 1 / 0.2, ret5: 1 / 0.08 };
  const cand = rows.filter((r) => Math.abs(r.min - s.min) <= 30 && r.day !== excludeDay).map((r) => ({ r, d: Math.hypot((r.dayChg - s.dayChg) * W.dayChg, (r.fromHigh - s.fromHigh) * W.fromHigh, (r.fromLow - s.fromLow) * W.fromLow, (r.ret30 - s.ret30) * W.ret30, (r.ret5 - s.ret5) * W.ret5) }));
  cand.sort((a, b) => a.d - b.d);
  // one row per day (consecutive 5-minute rows of the same day are not independent)
  const seen = new Set<string>(), pick: EyeRow[] = [];
  for (const c of cand) { if (seen.has(c.r.day)) continue; seen.add(c.r.day); pick.push(c.r); if (pick.length >= k) break; }
  const n = pick.length; if (!n) return null;
  const up = pick.filter((x) => x.next30 > flat).length, dn = pick.filter((x) => x.next30 < -flat).length, side = n - up - dn;
  const sorted = pick.map((x) => x.next30).sort((a, b) => a - b), med = sorted[Math.floor(n / 2)];
  const typRange = pick.map((x) => x.maxNext - x.minNext).sort((a, b) => a - b)[Math.floor(n / 2)];
  const lead = up > dn && up > side ? "UP" : dn > up && dn > side ? "DOWN" : side >= up && side >= dn ? "SIDEWAYS" : "MIXED";
  return { n, up, side, down: dn, upPct: Math.round((up / n) * 100), sidePct: Math.round((side / n) * 100), downPct: Math.round((dn / n) * 100), medianPct: r2(med), typicalRangePct: r2(typRange), lead, examples: pick.slice(0, 5).map((x) => `${x.day} → ${x.next30 >= 0 ? "+" : ""}${r2(x.next30)}%`) };
}
export function eyeText(name: string, res: ReturnType<typeof lookup>, spot: number): string {
  if (!res) return "Market Eye: no comparable history.";
  const pts = (pct: number) => Math.round((spot * pct) / 100);
  return `👁 Market Eye — next 30 min in the ${res.n} most similar ${name} moments (2 yrs): UP ${res.upPct}% · SIDEWAYS ${res.sidePct}% · DOWN ${res.downPct}% · median ${res.medianPct >= 0 ? "+" : ""}${res.medianPct}% (${pts(res.medianPct) >= 0 ? "+" : ""}${pts(res.medianPct)} pts) · typical 30-min range ±${Math.round(pts(res.typicalRangePct) / 2)} pts → tendency ${res.lead}. History, not a forecast.`;
}
