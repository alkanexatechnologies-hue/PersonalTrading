// ============================ LEVEL MEMORY — how NIFTY (and SENSEX) behaved at support / resistance, remembered day by day ============================
// Every time price reaches a level known BEFORE the day (prev-day H/L/C, pivots, prev week, OI walls, trendlines, round
// numbers), the 5-minute candles decide what happened in the next hour:
//   RESPECTED  = price turned away 1·ATR5 without a 5-min close beyond the level (support held / resistance rejected)
//   FAKE BREAK = a 5-min close beyond the level, back on the original side within 3 candles (a liquidity grab — it held)
//   BROKEN     = a 5-min close beyond and price ran 1·ATR5 beyond before closing back (the level gave way)
//   UNCLEAR    = none of these within 12 candles
// One test per level per approach (a new test needs price to leave by 1·ATR5 first). Facts only — informational.

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface MemLevel { price: number; label: string; kind: string }
export type MemOutcome = "RESPECTED" | "FAKE BREAK" | "BROKEN" | "UNCLEAR";
export interface MemEvent { day: string; time: number; price: number; label: string; kind: string; role: "SUPPORT" | "RESISTANCE"; outcome: MemOutcome; moveAtr: number }

const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const r1 = (v: number) => Math.round(v * 10) / 10;
/** Round-number levels (every `step`) within ±2% of a reference price. */
export function roundLevels(ref: number, step = 100): MemLevel[] {
  const out: MemLevel[] = []; for (let p = Math.ceil((ref * 0.98) / step) * step; p <= ref * 1.02; p += step) out.push({ price: p, label: `Round ${p.toLocaleString("en-IN")}`, kind: "ROUND" });
  return out;
}
/** All level tests in one session (bars = that day's closed 5-min candles, in order). */
export function levelTests(bars: Bar[], levels: MemLevel[], atr: number): MemEvent[] {
  const out: MemEvent[] = [], tol = 0.1 * atr;
  for (const L of levels) {
    let armed = true;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], prev = bars[i - 1];
      if (!armed) { if (Math.abs(b.close - L.price) >= atr) armed = true; continue; }
      const fromBelow = prev.close < L.price - tol && b.high >= L.price - tol, fromAbove = prev.close > L.price + tol && b.low <= L.price + tol;
      if (!fromBelow && !fromAbove) continue;
      const role: MemEvent["role"] = fromBelow ? "RESISTANCE" : "SUPPORT", s = fromBelow ? 1 : -1;   // s = the break direction
      let outcome: MemOutcome = "UNCLEAR", move = 0, beyondAt = -1;
      for (let k = i; k < Math.min(bars.length, i + 12); k++) {
        const x = bars[k];
        const away = s > 0 ? L.price - x.low : x.high - L.price, through = s > 0 ? x.high - L.price : L.price - x.low;
        if (beyondAt < 0 && s * (x.close - L.price) > tol) beyondAt = k;
        if (beyondAt >= 0) {
          if (through >= atr) { outcome = "BROKEN"; move = through / atr; break; }
          if (k > beyondAt && k - beyondAt <= 3 && s * (x.close - L.price) < -tol) { outcome = "FAKE BREAK"; move = away / atr; break; }
        } else if (away >= atr) { outcome = "RESPECTED"; move = away / atr; break; }
      }
      out.push({ day: dayOf(b.time), time: b.time, price: L.price, label: L.label, kind: L.kind, role, outcome, moveAtr: r1(move) });
      armed = false;
    }
  }
  return out.sort((a, b) => a.time - b.time);
}
/** Price zones from many sessions: tests within `width` points are one zone. Held = RESPECTED + FAKE BREAK. */
export function zones(events: MemEvent[], width: number) {
  const z: { price: number; tests: MemEvent[] }[] = [];
  for (const e of [...events].sort((a, b) => a.price - b.price)) { const last = z[z.length - 1]; if (last && e.price - last.price <= width) { last.tests.push(e); last.price = (last.price * (last.tests.length - 1) + e.price) / last.tests.length; } else z.push({ price: e.price, tests: [e] }); }
  return z.map((x) => {
    const sup = x.tests.filter((t) => t.role === "SUPPORT"), res = x.tests.filter((t) => t.role === "RESISTANCE"), held = (a: MemEvent[]) => a.filter((t) => t.outcome === "RESPECTED" || t.outcome === "FAKE BREAK").length;
    const decided = x.tests.filter((t) => t.outcome !== "UNCLEAR");
    return { price: Math.round(x.price), tests: x.tests.length, support: { n: sup.length, held: held(sup) }, resistance: { n: res.length, held: held(res) },
      broken: x.tests.filter((t) => t.outcome === "BROKEN").length, holdPct: decided.length ? Math.round((held(decided) / decided.length) * 100) : null,
      lastDay: x.tests.map((t) => t.day).sort().pop()!, labels: [...new Set(x.tests.map((t) => t.label))].slice(0, 3) };
  }).sort((a, b) => b.tests - a.tests);
}
/** How often each KIND of level held, as support and as resistance. */
export function kindStats(events: MemEvent[]) {
  const m: Record<string, { n: number; held: number; broken: number }> = {};
  for (const e of events) { if (e.outcome === "UNCLEAR") continue; const k = `${e.kind}|${e.role}`; const s = (m[k] = m[k] || { n: 0, held: 0, broken: 0 }); s.n++; if (e.outcome === "BROKEN") s.broken++; else s.held++; }
  return Object.entries(m).map(([k, s]) => ({ kind: k.split("|")[0], role: k.split("|")[1], n: s.n, holdPct: Math.round((s.held / s.n) * 100) })).sort((a, b) => b.n - a.n);
}
