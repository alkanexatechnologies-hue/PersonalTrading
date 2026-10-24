// ProTrader C2 — losing-trade audit + flexible 3-plan exit engine (owner's brief, 2026-10-25). EXPLORATORY on the last 15
// sessions; NOT validated; no 2-year run. Research only — no live logic. Usage: npx tsx c2Audit.ts > RESULTS_C2_AUDIT.md
//
// ENTRY (unchanged C2, from phase1.ts): a 5-min close beyond a MAJOR level (PDH / PDL / PDC / opening range / owner S/R) by
// > 0.1 ATR, the NEXT 5-min candle closes beyond it and does not re-enter by more than 0.1 ATR; entry at that close; the
// opposite-side option at the level strike shows WRITE or FLAT over the last 15 min (no unwind / cover / buy; unknown = no
// trade). Buy the ATM CE (long) / PE (short) at the premium's 1-min close of the minute ending at the entry timestamp.
//
// EXIT MODELS (identical entries):
//   X0  baseline: SL0 = max(₹5, 1 × premium ATR14 of today's completed 5-min premium candles), target 2 × SL0, 60 min
//   LOCK baseline + stop to entry + ₹1 at the first 5-min close after the premium reached +1 × SL0
//   X4  baseline + thesis exit: also exit at the first completed 5-min INDEX close back through the level
//   FIX fixed take-profit +₹5 / +₹10 / +₹15 / +₹20 with the SL0 stop, 60 min
//   TRL trailing stop: SL0, then stop = highest COMPLETED 1-min premium high − SL0 (updated after each minute), no target,
//       until 15:15 or 120 min
//   ADP the three-plan engine below (minimum objective M = ₹5 / 10 / 15 / 20; M = ₹10 is the headline)
//
// THREE-PLAN ENGINE — decisions only at completed 5-min closes (index close, premium close, premium EMA9 of 5-min premium
// closes, OI over the last 15 min at the level strike); between closes only the resting stop / limit can fill.
//   state at a close:
//     INVALID   the index 5-min close is back through the breakout level            → exit at this close (every plan)
//     WEAK      any of: premium close < premium EMA9 · index < 0.2 ATR beyond the level · opposite-side OI at the level strike is
//               UNWIND / COVER / BUY (WRITE / FLAT = supportive, n/a = unknown → ignored) · nearest opposing major level
//               < 0.5 ATR away · time ≥ 14:45
//     STRONG    index ≥ 0.5 ATR beyond the level · premium close > EMA9 · premium closing high made within the last 2 closes ·
//               opposing major level ≥ 1 ATR away (or none) · OI not against · time < 14:00
//     MODERATE  otherwise
//   plan at entry = STRONG → PLAN 1 · MODERATE → PLAN 2 · WEAK → PLAN 3
//   switching at each close: INVALID → exit · WEAK → PLAN 3 · MODERATE while in PLAN 1 → PLAN 2 · STRONG twice in a row while
//   in PLAN 2 with unrealised profit > 0 → PLAN 1 · PLAN 3 never upgrades. The stop only ever moves up.
//   PLAN 1 (major)    limit 3 × SL0 · once the peak reached 1 × SL0: stop ≥ entry + ₹1 · once 2 × SL0: stop ≥ highest premium
//                     close − 1 × SL0
//   PLAN 2 (medium)   limit 2 × SL0 · once the peak reached 1 × SL0: stop ≥ entry + 0.25 × SL0 · once 1.5 × SL0: stop ≥ entry +
//                     0.75 × SL0
//   PLAN 3 (minimum)  limit entry + M · stop ≥ entry − 0.5 × SL0 · exit at the close if unrealised ≥ M (book) · exit at the close
//                     if the peak reached M but unrealised fell below M / 2 (protect) · exit at the close if the state is WEAK
//                     for a 2nd consecutive close (deteriorating)
//   always            exit by 15:15 or after 120 minutes
// Costs max(₹0.5, 0.25 %) per side + ₹40 / lot (NIFTY 75, SENSEX 20). Pessimistic stop fill = min(stop, minute close);
// conservative = pessimistic + 0.5 % extra slippage per side. WIN = net P&L > 0 after costs.
import { assemble, DayData, Min } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { phase1 } from "./phase1";
import { priceActionLevels } from "../priceActionLevels";
import { prepare } from "../regimeStudy";
import { expiryDays } from "../premiumBacktest2";
import { REGIME_DEFAULTS } from "../../regime/marketRegime";

const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60), hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const STEP = { NIFTY: 50, SENSEX: 100 } as const, LOT = { NIFTY: 75, SENSEX: 20 } as const, COST = (p: number) => Math.max(0.5, 0.0025 * p);
type IX = "NIFTY" | "SENSEX";
type Bar = { time: number; open: number; high: number; low: number; close: number };
const barsN = (pts: [number, number][], n: number): Bar[] => { const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of pts) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out; };
const atrAt = (b: Bar[], i: number, n = 14) => { if (i < n) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].high - b[j].low, Math.abs(b[j].high - b[j - 1].close), Math.abs(b[j].low - b[j - 1].close)); return s / n; };
const tbOf = (m: number) => (m < 630 ? "09:30–10:30" : m < 750 ? "10:30–12:30" : "12:30–14:30");

interface Tr { ix: IX; day: string; t: number; dir: number; level: number; kind: string; oiAtEntry: string; strike: number; key: string; expiry: string;
  e: number; sl0: number; a: number; legs: Min[]; spot: [number, number][]; majors: number[]; regime: string; tb: string; oiAt: (t: number) => string; expiryDay: boolean }
interface Ex { model: string; exitT: number; exitP: number; exitPP: number; why: string; peak: number; mae: number; reached: Record<number, boolean>; plans: string }

function build(ix: IX, days: DayData[]) {
  const ds = days.filter((d) => d.spot.size >= 300), step = STEP[ix], lastSet = new Set(ds.slice(-15).map((d) => d.day)), exp = [...expiryDays(ds, step)].sort();
  const mins = new Map(ds.map((d) => [d.day, [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]]));
  const all5: Bar[] = [], start = new Map<string, number>(); for (const d of ds) { start.set(d.day, all5.length); all5.push(...barsN(mins.get(d.day)!, 5)); }
  const legs = new Map<string, Map<string, Min[]>>(); for (const d of ds) { const m = new Map<string, Min[]>(); for (const [k, a] of d.legs) m.set(k, [...a].sort((p, q) => p.t - q.t)); legs.set(d.day, m); }
  const reg = prepare(ix, days, step);
  const oiType = (day: string, strike: number, side: "CE" | "PE", t: number) => {
    const leg = legs.get(day)!.get(`${strike}${side}`) || [], a = leg.filter((m) => m.t < t - 900).pop(), b = leg.filter((m) => m.t < t).pop();
    if (!a || !b || a.oi == null || b.oi == null || b.t - a.t > 1500) return "n/a";
    const dOi = b.oi - a.oi, dP = b.c - a.c; if (Math.abs(dOi) < 0.005 * a.oi) return "FLAT";
    return dOi > 0 ? (dP < 0 ? "WRITE" : "BUY") : dP > 0 ? "COVER" : "UNWIND";
  };
  // major levels of a day (as phase1.ts): PDH / PDL / PDC, opening range (after 09:30), owner S/R of the previous 5 sessions
  const majorsOf = (day: string, t: number) => {
    const di = ds.findIndex((d) => d.day === day), pm = mins.get(ds[di - 1].day)!, B = barsN(mins.get(day)!, 5), orb = B.filter((b) => mn(b.time) < 570);
    const prev15 = ds.slice(Math.max(0, di - 5), di).flatMap((x) => barsN(mins.get(x.day)!, 15)), a15 = atrAt(prev15, prev15.length - 1) || 1;
    const lv = [Math.max(...pm.map(([, p]) => p)), Math.min(...pm.map(([, p]) => p)), pm[pm.length - 1][1], ...priceActionLevels(prev15 as any, a15).map((l) => l.price)];
    if (mn(t) >= 575 && orb.length) lv.push(Math.max(...orb.map((b) => b.high)), Math.min(...orb.map((b) => b.low)));
    return lv;
  };
  // C2 entries: exactly phase1's H2 + major level + WRITE/FLAT at the level strike; one trade per time / direction
  const P = phase1(ix, days), g = new Map<string, any>();
  for (const x of P.trades) { if (x.setup !== "H2" || !x.lvl || x.lvl.kind === "intraday pivot" || !(x.ctx.write === "WRITE" || x.ctx.write === "FLAT")) continue; const k = `${x.t}|${x.dir}`; if (!g.has(k)) g.set(k, x); }
  const out: Tr[] = [];
  for (const x of g.values()) {
    if (!lastSet.has(x.day)) continue;
    const sp = mins.get(x.day)!, s0 = sp.filter(([u]) => u < x.t).pop()![1], strike = Math.round(s0 / step) * step, key = `${strike}${x.dir > 0 ? "CE" : "PE"}`;
    const L = legs.get(x.day)!.get(key) || [], pre = L.filter((m) => m.t < x.t), inM = pre[pre.length - 1]; if (!inM || x.t - inM.t > 180) continue;
    // premium ATR from today's completed 5-min premium candles (same as phase1Complete E1)
    const pb: Bar[] = barsN(pre.map((m) => [m.t, m.c] as [number, number]), 5).filter((b) => b.time + 300 <= x.t); for (const b of pb) { const ms = pre.filter((m) => m.t >= b.time && m.t < b.time + 300); b.high = Math.max(...ms.map((m) => m.h)); b.low = Math.min(...ms.map((m) => m.l)); }
    const tr = pb.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - pb[i].close), Math.abs(b.low - pb[i].close))).slice(-14), patr = tr.length >= 3 ? tr.reduce((a, b) => a + b, 0) / tr.length : 5;
    const gi = (() => { let k = start.get(x.day)!; while (k + 1 < all5.length && all5[k + 1].time + 300 <= x.t) k++; return k; })(), a = atrAt(all5, gi) || 1;
    const lstrike = x.dir > 0 ? Math.floor(x.lvl.p / step) * step : Math.ceil(x.lvl.p / step) * step, oside: "CE" | "PE" = x.dir > 0 ? "PE" : "CE";
    out.push({ ix, day: x.day, t: x.t, dir: x.dir, level: x.lvl.p, kind: x.lvl.kind, oiAtEntry: x.ctx.write, strike, key, expiry: exp.find((d) => d >= x.day) ?? "after data", expiryDay: exp.includes(x.day),
      e: inM.c, sl0: Math.max(5, patr), a, legs: L.filter((m) => m.t >= x.t && mn(m.t) <= 915), spot: sp, majors: majorsOf(x.day, x.t), regime: reg.regimeAt(x.day, x.t, REGIME_DEFAULTS).r.regime,
      tb: tbOf(mn(x.t - 300)), oiAt: (t: number) => oiType(x.day, lstrike, oside, t) });
  }
  return out;
}

// ------------------------------------------------------------------ exit simulation
const THR = [5, 10, 15, 20, 30];
function simulate(T: Tr, model: string, M = 10): Ex {
  const e = T.e, sl0 = T.sl0, dir = T.dir, maxT = Math.min(T.t + (model === "X0" || model === "X4" || model === "LOCK" || model.startsWith("FIX") ? 3600 : 7200), Date.parse(T.day + "T15:15:00+05:30") / 1000);
  let S = e - sl0, Lmt: number | null = model === "X0" || model === "X4" || model === "LOCK" ? e + 2 * sl0 : model.startsWith("FIX") ? e + Number(model.slice(3)) : null;
  let plan = 0, prevState = "", weakRun = 0, peak = 0, mae = 0, hiClose = e, closes: number[] = [], plans: string[] = [];
  const reached: Record<number, boolean> = {}; for (const h of THR) reached[h] = false;
  const premBefore = (t: number) => T.legs.filter((m) => m.t < t).pop()?.c ?? e;
  const idxBefore = (t: number) => T.spot.filter(([u]) => u < t).pop()![1];
  // EMA9 of 5-min premium closes since entry seeded with the entry premium
  let ema9 = e; const k9 = 2 / 10;
  const room = (ic: number) => { const opp = T.majors.filter((p) => dir * (p - ic) > 0.05 * T.a).map((p) => Math.abs(p - ic)); return opp.length ? Math.min(...opp) / T.a : Infinity; };
  const stateAt = (t: number, pc: number, ic: number) => {
    const d = dir * (ic - T.level) / T.a; if (d < 0) return "INVALID";
    const oi = T.oiAt(t), against = oi === "UNWIND" || oi === "COVER" || oi === "BUY", r = room(ic), m = mn(t - 60);
    if (pc < ema9 || d < 0.2 || against || r < 0.5 || m >= 885) return "WEAK";
    const recentHigh = closes.length >= 1 && Math.max(...closes.slice(-2)) >= hiClose;
    if (d >= 0.5 && pc > ema9 && recentHigh && r >= 1 && m < 840) return "STRONG";
    return "MODERATE";
  };
  const fillStop = (m: Min) => ({ p: S, pp: Math.min(S, m.c) });
  if (model.startsWith("ADP")) { const st = stateAt(T.t, e, idxBefore(T.t)); plan = st === "STRONG" ? 1 : st === "WEAK" || st === "INVALID" ? 3 : 2; plans.push(`P${plan}`); }
  const setOrders = (U: number) => {
    if (plan === 1) { Lmt = e + 3 * sl0; if (peak >= sl0) S = Math.max(S, e + 1); if (peak >= 2 * sl0) S = Math.max(S, hiClose - sl0); }
    if (plan === 2) { Lmt = e + 2 * sl0; if (peak >= sl0) S = Math.max(S, e + 0.25 * sl0); if (peak >= 1.5 * sl0) S = Math.max(S, e + 0.75 * sl0); }
    if (plan === 3) { Lmt = e + M; S = Math.max(S, e - 0.5 * sl0); }
    void U;
  };
  if (model.startsWith("ADP")) setOrders(0);
  let peakHi = e;
  for (const m of T.legs) {
    if (m.t >= maxT) break;
    const hitS = m.l <= S, hitT = Lmt != null && m.h >= Lmt;
    if (hitS) { const f = fillStop(m); return done(m.t + 60, f.p, f.pp, hitT ? "AMBIGUOUS→stop" : S >= e ? "trailing/locked stop" : "stop"); }
    if (hitT) return done(m.t + 60, Lmt!, Lmt!, model.startsWith("ADP") ? `P${plan} objective` : "target");
    peak = Math.max(peak, m.h - e); mae = Math.max(mae, e - m.l); for (const h of THR) if (m.h - e >= h) reached[h] = true; peakHi = Math.max(peakHi, m.h);
    if (model === "TRL") S = Math.max(S, peakHi - sl0);   // trail from the COMPLETED minute's high, effective from the next minute
    const tc = m.t + 60;
    if ((tc - T.t) % 300 === 0) {   // a completed 5-min close
      const pc = m.c, ic = idxBefore(tc); closes.push(pc); ema9 = pc * k9 + ema9 * (1 - k9); hiClose = Math.max(hiClose, pc);
      if (model === "X4" && dir * (ic - T.level) < 0) return done(tc, pc, pc, "thesis exit: index back through level");
      if (model === "LOCK" && peak >= sl0) S = Math.max(S, e + 1);   // profit protection decided at the 5-min close
      if (model.startsWith("ADP")) {
        const st = stateAt(tc, pc, ic), U = pc - e;
        if (st === "INVALID") return done(tc, pc, pc, `P${plan} thesis invalid: index back through level`);
        if (st === "WEAK") { weakRun++; if (plan !== 3) { plan = 3; plans.push("P3"); } } else weakRun = 0;
        if (st === "MODERATE" && plan === 1) { plan = 2; plans.push("P2"); }
        if (st === "STRONG" && prevState === "STRONG" && plan === 2 && U > 0) { plan = 1; plans.push("P1"); }
        prevState = st;
        if (plan === 3) {
          if (U >= M) return done(tc, pc, pc, "P3 book minimum profit");
          if (peak >= M && U < M / 2) return done(tc, pc, pc, "P3 protect profit");
          if (weakRun >= 2) return done(tc, pc, pc, "P3 deteriorating (weak twice)");
        }
        setOrders(U);
      }
    }
  }
  const last = T.legs.filter((m) => m.t < maxT).pop(); return done(last ? last.t + 60 : T.t, last?.c ?? e, last?.c ?? e, "time exit");
  function done(t: number, p: number, pp: number, why: string): Ex { return { model, exitT: t, exitP: p, exitPP: pp, why, peak, mae, reached, plans: plans.join("→") }; }
}
const netOf = (T: Tr, x: number) => (x - T.e - COST(T.e) - COST(x) - 40 / LOT[T.ix]) * LOT[T.ix];
const consOf = (T: Tr, x: Ex) => netOf(T, x.exitPP) - 0.005 * (T.e + x.exitPP) * LOT[T.ix];

// ------------------------------------------------------------------ report
if (require.main === module) {
  const TR = [...build("NIFTY", assemble("2026-08-01", "2026-10-23").days), ...build("SENSEX", assembleIndex("SENSEX", "2026-08-01", "2026-10-23"))].sort((p, q) => p.t - q.t);
  const R0 = (v: number) => Math.round(v).toLocaleString("en-IN"), out: string[] = [], P = (...s: string[]) => out.push(...(s.length ? s : [""]));
  const models = ["X0", "X4", "LOCK", "FIX5", "FIX10", "FIX15", "FIX20", "TRL", "ADP5", "ADP10", "ADP15", "ADP20"];
  const label: Record<string, string> = { X0: "X0 baseline (SL0 / 2×SL0 / 60 min)", X4: "X4 baseline + thesis exit", LOCK: "Baseline + breakeven lock after +1×SL0", FIX5: "Fixed take-profit +₹5", FIX10: "Fixed take-profit +₹10", FIX15: "Fixed take-profit +₹15", FIX20: "Fixed take-profit +₹20", TRL: "Simple trailing stop (SL0 from the high)", ADP5: "Adaptive 3-plan, minimum ₹5", ADP10: "Adaptive 3-plan, minimum ₹10", ADP15: "Adaptive 3-plan, minimum ₹15", ADP20: "Adaptive 3-plan, minimum ₹20" };
  const sim = new Map<string, Ex[]>(); for (const m of models) sim.set(m, TR.map((T) => simulate(T, m, m.startsWith("ADP") ? Number(m.slice(3)) : 10)));
  P("# C2 — losing-trade audit and flexible 3-plan exit engine (last 15 sessions · EXPLORATORY · not validated)", "");
  // ---- verification ----
  const x0 = sim.get("X0")!, res0 = x0.map((x) => (x.why === "target" ? "TARGET" : x.why.startsWith("AMBIG") ? "AMBIG" : x.why === "time exit" ? "TIME" : "STOP"));
  const n0 = x0.map((x, i) => netOf(TR[i], x.exitP)), c0 = x0.map((x, i) => consOf(TR[i], x));
  P("## A0. Verification of the reported C2 figures (recomputed from the trade records)", "",
    `- Trades ${TR.length} · target ${res0.filter((r) => r === "TARGET").length} · stop ${res0.filter((r) => r === "STOP").length} · time ${res0.filter((r) => r === "TIME").length} · ambiguous ${res0.filter((r) => r === "AMBIG").length} · target-hit rate ${((res0.filter((r) => r === "TARGET").length / TR.length) * 100).toFixed(1)}%`,
    `- Net per trade ₹${R0(n0.reduce((a, b) => a + b, 0) / TR.length)} · conservative ₹${R0(c0.reduce((a, b) => a + b, 0) / TR.length)} (reported: 121 / 48 / 60 / 13, 39.7 %, +₹362, +₹236)`, "");
  // ---- trade-by-trade audit (baseline X0) ----
  const held = (T: Tr) => { const w = T.spot.filter(([u]) => u >= T.t && u < T.t + 1800), c5 = w.filter(([u]) => (u + 60 - T.t) % 300 === 0).map(([, p]) => p);
    const back = c5.findIndex((p) => T.dir * (p - T.level) < 0), maxd = Math.max(0, ...c5.map((p) => T.dir * (p - T.level) / T.a));
    return back >= 0 ? { s: "FAILED", at: T.t + (back + 1) * 300 } : maxd >= 0.5 ? { s: "HELD", at: 0 } : { s: "CHOPPY", at: 0 }; };
  P("## A1. Trade-by-trade audit (baseline exit X0; premium in ₹ per unit, P&L in ₹ per lot after costs)", "",
    "Columns: thresholds +5/+10/+15/+20 = premium rose that much (1-min high) BEFORE the exit. Breakout = index behaviour over the 30 min after entry (FAILED = a 5-min close back through the level; HELD = no re-entry and ≥ 0.5 ATR beyond; CHOPPY = neither). Expiry = the next expiry inferred from the data (straddle collapse), not from a contract master.", "",
    "| # | Date | Entry | Index | Side | Strike | Expiry | Entry ₹ | Level | Level price | Accepted at | OI at entry | Prem ATR | SL / target | MFE | MAE | +5 | +10 | +15 | +20 | Exit | Exit ₹ | Result | Net ₹ | Breakout | Regime |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  TR.forEach((T, i) => { const x = x0[i], h = held(T);
    P(`| ${i + 1} | ${T.day.slice(5)} | ${hm(T.t)} | ${T.ix} | ${T.dir > 0 ? "CE" : "PE"} | ${T.strike} | ${T.expiry}${T.expiryDay ? " (expiry day)" : ""} | ${T.e.toFixed(2)} | ${T.kind} | ${R0(T.level)} | ${hm(T.t - 300)}–${hm(T.t)} close | ${T.oiAtEntry} | ${T.sl0.toFixed(1)} | ${(T.e - T.sl0).toFixed(1)} / ${(T.e + 2 * T.sl0).toFixed(1)} | ${x.peak.toFixed(1)} | ${x.mae.toFixed(1)} | ${x.reached[5] ? "✓" : "–"} | ${x.reached[10] ? "✓" : "–"} | ${x.reached[15] ? "✓" : "–"} | ${x.reached[20] ? "✓" : "–"} | ${hm(x.exitT)} | ${x.exitP.toFixed(2)} | ${res0[i]} | ${R0(n0[i])} | ${h.s}${h.at ? " " + hm(h.at) : ""} | ${T.regime} |`); });
  // ---- losing trades ----
  P("", "## A2. Every losing trade (net ≤ 0 under X0) — exact date / time, evidence-based classification, and whether an earlier exit was possible in real time", "",
    "| # | Date | Entry | Index · side | Level | Exit (X0) | Net ₹ | Peak before exit | Classification (evidence) | Earlier exit possible in real time? |", "|---|---|---|---|---|---|---|---|---|---|");
  const cls: Record<string, number> = {};
  TR.forEach((T, i) => { if (n0[i] > 0) return; const x = x0[i], h = held(T), stopIdx = T.spot.filter(([u]) => u < x.exitT).pop()![1], beyond = T.dir * (stopIdx - T.level) >= 0;
    const thesis = simulate(T, "X4"), tNet = netOf(T, thesis.exitP); let c = "";
    if (h.s === "FAILED" && h.at <= x.exitT) c = `Failed breakout — index 5-min close back through ${T.kind} ${R0(T.level)} at ${hm(h.at)}`;
    else if (x.peak >= 10) c = `Gave back profit — premium was +₹${x.peak.toFixed(1)} before reversing`;
    else if (res0[i] === "TIME") c = "Stalled — no follow-through in 60 min (time exit)";
    else if (beyond) c = `Premium stop inside noise — stopped at ${hm(x.exitT)} while the index was still beyond the level (stop ₹${T.sl0.toFixed(1)})`;
    else c = "Reversal — index moved back towards / through the level and the stop was hit";
    const key = c.split(" —")[0]; cls[key] = (cls[key] || 0) + 1;
    const lk = simulate(T, "LOCK"), lNet = netOf(T, lk.exitP);
    const parts: string[] = [];
    if (thesis.why.startsWith("thesis") && thesis.exitT < x.exitT) parts.push(`Thesis exit at ${hm(thesis.exitT)} (index 5-min close back through the level — knowable then): ₹${R0(tNet)} vs ₹${R0(n0[i])} → ${tNet > n0[i] ? "smaller loss" : "LARGER loss"}`);
    if (lk.why !== x.why || lk.exitT !== x.exitT) parts.push(`Breakeven lock (after +1×SL0, decided at a 5-min close): ₹${R0(lNet)} → ${lNet > n0[i] ? "better" : "worse"}`);
    const earlier = parts.length ? parts.join(" · ") : "No — no completed-candle signal before the stop";
    P(`| ${i + 1} | ${T.day.slice(5)} | ${hm(T.t)} | ${T.ix} ${T.dir > 0 ? "CE" : "PE"} | ${T.kind} ${R0(T.level)} | ${hm(x.exitT)} ${res0[i]} | ${R0(n0[i])} | +₹${x.peak.toFixed(1)} | ${c} | ${earlier} |`); });
  P("", `Loss classification counts: ${Object.entries(cls).map(([k, v]) => `${k}: ${v}`).join(" · ")}`, "");
  // ---- model comparison ----
  const met = (idx: number[], m: string) => { const xs = idx.map((i) => ({ T: TR[i], x: sim.get(m)![i] })); const n = xs.length; if (!n) return null;
    const nets = xs.map(({ T, x }) => netOf(T, x.exitP)), cons = xs.map(({ T, x }) => consOf(T, x)), gross = xs.map(({ T, x }) => (x.exitP - T.e) * LOT[T.ix]);
    const W = nets.filter((v) => v > 0), L = nets.filter((v) => v <= 0), pos = W.reduce((a, b) => a + b, 0), neg = -L.reduce((a, b) => a + b, 0);
    let cum = 0, pk = 0, dd = 0; for (const v of nets) { cum += v; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
    const turned = xs.filter(({ x }, k) => x.peak >= 10 && nets[k] <= 0).length, surrendered = xs.reduce((a, { T, x }) => a + Math.max(0, x.peak - (x.exitP - T.e)) * LOT[T.ix], 0) / n;
    return { n, win: (W.length / n) * 100, avgW: W.length ? pos / W.length : 0, avgL: L.length ? -neg / L.length : 0, gross: gross.reduce((a, b) => a + b, 0), net: pos - neg, exp: (pos - neg) / n, expC: cons.reduce((a, b) => a + b, 0) / n, pf: neg ? pos / neg : Infinity, dd,
      reach: THR.map((h) => (xs.filter(({ x }) => x.reached[h]).length / n) * 100), turned: (turned / n) * 100, surrendered }; };
  const allIdx = TR.map((_, i) => i);
  P("## B. Exit-model comparison on the SAME 121 entries (win = net > 0 after costs; ₹ per lot)", "",
    "| Exit model | Trades | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Conservative / trade ₹ | PF | Max DD ₹ | Reached +5 / +10 / +15 / +20 % | Profit (≥ +₹10) turned into loss % | Profit surrendered / trade ₹ |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of models) { const r = met(allIdx, m)!; P(`| ${label[m]} | ${r.n} | ${r.win.toFixed(1)} | ${R0(r.avgW)} | ${R0(r.avgL)} | ${R0(r.gross)} | ${R0(r.net)} | ${R0(r.exp)} | ${R0(r.expC)} | ${r.pf === Infinity ? "∞" : r.pf.toFixed(2)} | ${R0(r.dd)} | ${r.reach.slice(0, 4).map((v) => v.toFixed(0)).join(" / ")} | ${r.turned.toFixed(1)} | ${R0(r.surrendered)} |`); }
  // ---- adaptive vs baseline: when it helps / hurts ----
  const a10 = sim.get("ADP10")!, diff = TR.map((T, i) => netOf(T, a10[i].exitP) - n0[i]);
  P("", "## C. Where the adaptive exit (minimum ₹10) helps and hurts vs the baseline (same entries)", "",
    `- Better on ${diff.filter((d) => d > 0).length} trades (total +₹${R0(diff.filter((d) => d > 0).reduce((a, b) => a + b, 0))}), worse on ${diff.filter((d) => d < 0).length} (total −₹${R0(-diff.filter((d) => d < 0).reduce((a, b) => a + b, 0))}), equal on ${diff.filter((d) => d === 0).length}.`);
  const whyCount = (m: string) => { const c: Record<string, number> = {}; for (const x of sim.get(m)!) { const k = x.why.replace(/P[123] /, "P? "); c[k] = (c[k] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "); };
  P(`- Adaptive exit reasons: ${whyCount("ADP10")}`);
  const pl: Record<string, number> = {}; for (const x of a10) { const k = x.plans || "—"; pl[k] = (pl[k] || 0) + 1; }
  P(`- Plan paths (entry plan → switches): ${Object.entries(pl).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  for (const [lab, f] of [["helps most", (d: number) => d > 0], ["hurts most", (d: number) => d < 0]] as const) {
    const top = TR.map((T, i) => ({ T, i, d: diff[i] })).filter(({ d }) => f(d)).sort((p, q) => Math.abs(q.d) - Math.abs(p.d)).slice(0, 6);
    P(`- ${lab}: ${top.map(({ T, i, d }) => `${T.ix} ${T.day.slice(5)} ${hm(T.t)} ${T.dir > 0 ? "CE" : "PE"} (${a10[i].why}, ${d >= 0 ? "+" : ""}₹${R0(d)})`).join(" · ")}`);
  }
  // ---- breakdowns for baseline vs adaptive ----
  const split = (title: string, key: (T: Tr) => string) => { P("", `## D. ${title}`, "", "| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |", "|---|---|---|---|---|---|---|---|");
    const g = new Map<string, number[]>(); TR.forEach((T, i) => { const k = key(T); (g.get(k) || g.set(k, []).get(k)!).push(i); });
    for (const [k, idx] of [...g.entries()].sort()) { const a = met(idx, "X0")!, b = met(idx, "ADP10")!, c = met(idx, "TRL")!; P(`| ${k} | ${idx.length} | ${a.win.toFixed(1)} | ${R0(a.exp)} | ${b.win.toFixed(1)} | ${R0(b.exp)} | ${R0(b.expC)} | ${R0(c.exp)} |`); } };
  split("By index", (T) => T.ix); split("By index and side", (T) => `${T.ix} ${T.dir > 0 ? "CE" : "PE"}`); split("By level type", (T) => T.kind); split("By time of day (breakout candle)", (T) => T.tb); split("By regime at entry (research detector, unvalidated)", (T) => T.regime); split("Expiry day vs other days", (T) => (T.expiryDay ? "expiry day" : "other day"));
  // ---- win rate vs expectancy trade-off ----
  P("", "## E. Win rate vs expectancy trade-off (same entries)", "", "| Exit model | Win % | Avg win ₹ | Avg loss ₹ | Win/loss size ratio | Net / trade ₹ | Max DD ₹ |", "|---|---|---|---|---|---|---|");
  for (const m of models) { const r = met(allIdx, m)!; P(`| ${label[m]} | ${r.win.toFixed(1)} | ${R0(r.avgW)} | ${R0(r.avgL)} | ${(r.avgW / Math.abs(r.avgL || 1)).toFixed(2)} | ${R0(r.exp)} | ${R0(r.dd)} |`); }
  console.log(out.join("\n"));
  process.exit(0);
}
