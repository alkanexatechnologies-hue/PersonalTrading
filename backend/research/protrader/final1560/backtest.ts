// FINAL 15–60 point backtest (owner's brief, 2026-10-25). Evaluates the PRE-REGISTERED LAX candidate (strategy.ts) and the
// comparisons, on NIFTY / BANKNIFTY / SENSEX, 2024-10-14 → 2026-10-23. Research only. Writes:
//   FINAL_15_60_POINT_BACKTEST_raw.md (all tables) · lax_trades.csv (trade-level audit) · lax_dev15_trades.csv
// Usage: npx tsx backtest.ts
import fs from "fs";
import path from "path";
import { DayData, Min } from "../../nifty20/data";
import { load, STEP } from "./dataAudit";
import { scan, indexExit, optionPnl, marketLevels, atr14, LAX, Bar, Signal, IndexExit, REACH, istMin } from "./strategy";
import { priceActionLevels } from "../priceActionLevels";
import { expiryDays } from "../premiumBacktest2";
import { run as emaRun } from "../emaCrossStudy";

type IX = "NIFTY" | "BANKNIFTY" | "SENSEX";
const LOT: Record<IX, number> = { NIFTY: 75, BANKNIFTY: 30, SENSEX: 20 };
const OUT = path.join(__dirname);
// LAX_STRIKE=ITM1 (pre-registered 2026-10-25): buy the strike 1 step IN the money (CE: ATM − step, PE: ATM + step); everything
// else unchanged. Output goes to *_ITM1 files so the ATM results stay as they were.
const ITM1 = process.env.LAX_STRIKE === "ITM1", SFX = ITM1 ? "_ITM1" : "";
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const barsN = (pts: [number, number][], n: number): Bar[] => { const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of pts) { const m = istMin(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out; };

export interface Trade {
  strat: string; ix: IX; day: string; set: string; dev15: boolean; block: string; expiry: boolean; dayType: string; volDay: string;
  t: number; dir: 1 | -1; levelKind: string; level: number; entry: number; stop: number; target: number; room: number; consumed: number; atr: number;
  x: IndexExit; idxPts: number; strike: number; prem0: number | null; prem1: number | null; net: number | null; netC: number | null; gross: number | null; native?: { net: number; res: string };
}

function prepareIndex(ix: IX) {
  const days = load(ix), ds = days.filter((d) => d.spot.size >= 300), N = ds.length, d1 = Math.floor(N * 0.6), d2 = Math.floor(N * 0.8), step = STEP[ix];
  const setOf = (i: number) => (i === d1 || i === d2 ? "PURGE" : i < d1 ? "DEV" : i < d2 ? "VAL" : "TEST");
  const dev15 = new Set(ds.slice(-15).map((d) => d.day)), exp = expiryDays(ds, step);
  const mins = ds.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => istMin(t) >= 555 && istMin(t) < 930) as [number, number][]);
  const all5: Bar[] = [], off: number[] = [], n5: number[] = [];
  mins.forEach((m) => { off.push(all5.length); const b = barsN(m, 5); n5.push(b.length); all5.push(...b); });
  const legs = ds.map((d) => { const m = new Map<string, Min[]>(); for (const [k, a] of d.legs) m.set(k, [...a].sort((p, q) => p.t - q.t)); return m; });
  // premium of the minute ENDING at t (its 1-min close), at most 2 minutes old
  const premAt = (di: number, key: string, t: number) => { const a = legs[di].get(key) || []; let v: Min | null = null; for (const m of a) { if (m.t >= t) break; v = m; } return v && t - (v.t + 60) <= 120 ? v.c : null; };
  const ranges = mins.map((m) => Math.max(...m.map(([, p]) => p)) - Math.min(...m.map(([, p]) => p)));
  const dayInfo = (di: number) => { const m = mins[di], o = m[0][1], c = m[m.length - 1][1], rg = ranges[di], avg = di >= 20 ? ranges.slice(di - 20, di).reduce((a, b) => a + b, 0) / 20 : rg;
    return { dayType: Math.abs(c - o) >= 0.6 * rg ? "TREND day" : "RANGE day", volDay: rg >= avg ? "HIGH-VOL day" : "LOW-VOL day" }; };   // hindsight labels, reporting only
  return { ix, ds, step, setOf, dev15, exp, mins, all5, off, n5, legs, premAt, dayInfo, lot: LOT[ix] };
}
type P = ReturnType<typeof prepareIndex>;

/** Evaluate one signal with the LAX index exit and the ATM option P&L (base and conservative = +0.5 %/side and 1-min delay). */
function evaluate(Pp: P, di: number, strat: string, s: Signal): Trade | null {
  const d = Pp.ds[di], end = Math.floor(Date.parse(d.day + "T15:15:00+05:30") / 1000), path = Pp.mins[di].filter(([t]) => t >= s.t);
  if (path.length < 5) return null;
  const x = indexExit(path, s, LAX, end), strike = Math.round(s.entry / Pp.step) * Pp.step - (ITM1 ? s.dir * Pp.step : 0), key = `${strike}${s.dir > 0 ? "CE" : "PE"}`;
  const prem0 = Pp.premAt(di, key, s.t), prem1 = Pp.premAt(di, key, x.exitT), p0c = Pp.premAt(di, key, s.t + 60), p1c = Pp.premAt(di, key, x.exitT + 60);
  const b = prem0 != null && prem1 != null ? optionPnl(prem0, prem1, Pp.lot) : null, c = p0c != null && p1c != null ? optionPnl(p0c, p1c, Pp.lot, true) : null;
  const info = Pp.dayInfo(di), dt = d.day;
  return { strat, ix: Pp.ix, day: dt, set: Pp.setOf(di), dev15: Pp.dev15.has(dt), block: dt.slice(0, 4) + (dt.slice(5, 7) <= "06" ? "-H1" : "-H2"), expiry: Pp.exp.has(dt), ...info,
    t: s.t, dir: s.dir, levelKind: s.level.kind, level: s.level.p, entry: s.entry, stop: s.stop, target: s.target, room: s.room, consumed: s.consumed, atr: s.atr,
    x, idxPts: s.dir * (x.exitPx - s.entry), strike, prem0, prem1, net: b?.net ?? null, netC: c?.net ?? null, gross: b?.gross ?? null };
}

/** Portfolio layer: one open trade per index, ≤ 2 trades / index / day, stop the index after 2 losses, 15-min cooldown. */
function portfolio(cands: { s: Signal; tr: Trade }[], log: Record<string, number>) {
  const out: Trade[] = []; let busyTill = 0, n = 0, losses = 0;
  for (const { s, tr } of cands.sort((p, q) => p.s.t - q.s.t)) {
    if (s.t < busyTill) { log["blocked: trade already open / cooldown"] = (log["blocked: trade already open / cooldown"] || 0) + 1; continue; }
    if (n >= 2) { log["blocked: 2 trades already today"] = (log["blocked: 2 trades already today"] || 0) + 1; continue; }
    if (losses >= 2) { log["blocked: 2 losses today"] = (log["blocked: 2 losses today"] || 0) + 1; continue; }
    if (tr.prem0 == null) { log["no trade: premium missing / stale"] = (log["no trade: premium missing / stale"] || 0) + 1; continue; }
    out.push(tr); n++; if ((tr.net ?? 0) <= 0) losses++; busyTill = tr.x.exitT + 900;
  }
  return out;
}

// ---------------- strategies ----------------
function laxDay(Pp: P, di: number, log: Record<string, number>) {
  const o = Pp.off[di], n = Pp.n5[di], today = Pp.all5.slice(o, o + n), pm = Pp.mins[di - 1], prev = pm ? { high: Math.max(...pm.map(([, p]) => p)), low: Math.min(...pm.map(([, p]) => p)), close: pm[pm.length - 1][1] } : null;
  const r = scan(Pp.all5, o, n, (k) => marketLevels(prev, today, istMin(today[Math.min(k, n - 1)].time)), LAX);
  for (const j of r.rejects) { const k = "WAIT: " + j.reason.replace(/[0-9.]+ pts/g, "N pts").replace(/[0-9]+×/, "N×").replace(/\(> .*\)/, ""); log[k] = (log[k] || 0) + 1; }
  log["signals"] = (log["signals"] || 0) + r.signals.length;
  return { cands: r.signals.map((s) => ({ s, tr: evaluate(Pp, di, "LAX", s) })).filter((x): x is { s: Signal; tr: Trade } => !!x.tr), rejects: r.rejects };
}
function orbDay(Pp: P, di: number) {
  const o = Pp.off[di], n = Pp.n5[di], B = Pp.all5.slice(o, o + n), or = B.filter((b) => istMin(b.time) < 570); if (or.length < 3) return [];
  const H = Math.max(...or.map((b) => b.high)), L = Math.min(...or.map((b) => b.low)), out: { s: Signal; tr: Trade }[] = [], done = new Set<number>();
  for (let k = 1; k < n; k++) { const b = B[k], m = istMin(b.time), a = atr14(Pp.all5, o + k); if (m < 570 || m > 685 || !a) continue;
    for (const [lvl, dir, kind] of [[H, 1, "ORH"], [L, -1, "ORL"]] as const) { if (done.has(dir)) continue;
      if (dir * (B[k - 1].close - lvl) <= 0 && dir * (b.close - lvl) > 0.1 * a) { done.add(dir);
        const s: Signal = { i: o + k, t: b.time + 300, dir, level: { p: lvl, kind }, entry: b.close, stop: dir > 0 ? b.low - 0.1 * a : b.high + 0.1 * a, risk: 0, room: Infinity, target: b.close + dir * 45, consumed: dir * (b.close - lvl), atr: a, why: [] };
        const tr = evaluate(Pp, di, "ORB", s); if (tr) out.push({ s, tr }); } } }
  return out;
}
function randomDay(Pp: P, di: number) {
  const o = Pp.off[di], n = Pp.n5[di], out: Trade[] = [];
  for (let k = 1; k < n; k++) { const b = Pp.all5[o + k], m = istMin(b.time), a = atr14(Pp.all5, o + k); if (m < 575 || m > 690 || !a) continue;
    for (const dir of [1, -1] as const) { const s: Signal = { i: o + k, t: b.time + 300, dir, level: { p: b.open, kind: "candle open" }, entry: b.close, stop: b.close - dir * a, risk: a, room: Infinity, target: b.close + dir * 45, consumed: 0, atr: a, why: [] };
      const tr = evaluate(Pp, di, "RANDOM", s); if (tr) out.push(tr); } }
  return out;
}
// C2, re-implemented exactly as phase1.ts (H2 at major levels incl. owner S/R, 09:30–14:25, first ACCEPTED event per level /
// direction / day, opposite-side OI at the level strike WRITE or FLAT) — checked against the 121 Phase-1 trades
function c2Day(Pp: P, di: number) {
  const o = Pp.off[di], n = Pp.n5[di], B = Pp.all5.slice(o, o + n), d = Pp.ds[di], pm = Pp.mins[di - 1]; if (!pm) return [];
  const pdh = Math.max(...pm.map(([, p]) => p)), pdl = Math.min(...pm.map(([, p]) => p)), pdc = pm[pm.length - 1][1];
  const prev15 = Pp.mins.slice(Math.max(0, di - 5), di).flatMap((m) => barsN(m, 15)), a15 = atr14(prev15, prev15.length - 1) || 1;
  const owner = priceActionLevels(prev15 as any, a15).map((l) => ({ p: l.price, kind: "owner S/R" }));
  const orb = B.filter((b) => istMin(b.time) < 570), seen = new Set<string>(), ev: { s: Signal; oi: string }[] = [];
  const oiType = (strike: number, side: "CE" | "PE", t: number) => { const leg = Pp.legs[di].get(`${strike}${side}`) || [], a = leg.filter((m) => m.t < t - 900).pop(), b = leg.filter((m) => m.t < t).pop();
    if (!a || !b || a.oi == null || b.oi == null || b.t - a.t > 1500) return "n/a"; const dOi = b.oi - a.oi, dP = b.c - a.c; if (Math.abs(dOi) < 0.005 * a.oi) return "FLAT"; return dOi > 0 ? (dP < 0 ? "WRITE" : "BUY") : dP > 0 ? "COVER" : "UNWIND"; };
  for (let i = 3; i < n - 1; i++) {
    const c = B[i], m = istMin(c.time), a = atr14(Pp.all5, o + i); if (!a || m < 570 || m > 865) continue;
    const lv = [{ p: pdh, kind: "PDH" }, { p: pdl, kind: "PDL" }, { p: pdc, kind: "PDC" }, ...(orb.length ? [{ p: Math.max(...orb.map((b) => b.high)), kind: "ORH" }, { p: Math.min(...orb.map((b) => b.low)), kind: "ORL" }] : []), ...owner];
    for (const L of lv) for (const dir of [1, -1] as const) {
      if (!(dir * (B[i - 1].close - L.p) <= 0 && dir * (c.close - L.p) > 0.1 * a)) continue;
      const nx = B[i + 1]; if (!(dir * (nx.close - L.p) > 0 && dir * ((dir > 0 ? nx.low : nx.high) - L.p) > -0.1 * a)) continue;
      const key = `${dir}|${Math.round(L.p)}`; if (seen.has(key)) continue; seen.add(key);
      const t = nx.time + 300, strike = dir > 0 ? Math.floor(L.p / Pp.step) * Pp.step : Math.ceil(L.p / Pp.step) * Pp.step;
      ev.push({ s: { i: o + i + 1, t, dir, level: L, entry: nx.close, stop: dir > 0 ? Math.min(c.low, nx.low) - 0.1 * a : Math.max(c.high, nx.high) + 0.1 * a, risk: 0, room: Infinity, target: nx.close + dir * 45, consumed: dir * (nx.close - L.p), atr: a, why: [] }, oi: oiType(strike, dir > 0 ? "PE" : "CE", t) });
    }
  }
  const uniq = new Map<string, { s: Signal; oi: string }>(); for (const e of ev) { if (!(e.oi === "WRITE" || e.oi === "FLAT")) continue; const k = `${e.s.t}|${e.s.dir}`; if (!uniq.has(k)) uniq.set(k, e); }
  const out: Trade[] = [];
  for (const e of uniq.values()) { const tr = evaluate(Pp, di, "C2", e.s); if (!tr) continue; tr.native = c2Native(Pp, di, e.s); out.push(tr); }
  return out;
}
/** C2's own Phase-1 exit E1: SL0 = max(₹5, 1 × premium ATR14 of today's completed 5-min premium candles), target 2 × SL0, 60 min,
 *  stop first when both in a minute; Phase-1 costs (max(₹0.5, 0.25 %) per side + ₹40 / lot). */
function c2Native(Pp: P, di: number, s: Signal) {
  const key = `${Math.round(s.entry / Pp.step) * Pp.step}${s.dir > 0 ? "CE" : "PE"}`, leg = Pp.legs[di].get(key) || [], pre = leg.filter((m) => m.t < s.t), inM = pre[pre.length - 1];
  if (!inM || s.t - inM.t > 180) return { net: NaN, res: "no premium" };
  const lb: { h: number; l: number; c: number; t: number }[] = []; for (const m of pre) { const x = istMin(m.t); if (x < 555) continue; const k = Math.floor((x - 555) / 5), bt = m.t - (x - 555 - k * 5) * 60; if (bt + 300 > s.t) break; const last = lb[lb.length - 1]; if (last && last.t === bt) { last.h = Math.max(last.h, m.h); last.l = Math.min(last.l, m.l); last.c = m.c; } else lb.push({ t: bt, h: m.h, l: m.l, c: m.c }); }
  const tr = lb.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - lb[i].c), Math.abs(b.l - lb[i].c))).slice(-14), sl = Math.max(5, tr.length >= 3 ? tr.reduce((a, b) => a + b, 0) / tr.length : 5), e = inM.c;
  let res = "TIME", x = e; for (const m of leg.filter((m) => m.t >= s.t && m.t < s.t + 3600 && istMin(m.t) <= 925)) { if (m.l <= e - sl) { res = "STOP"; x = e - sl; break; } if (m.h >= e + 2 * sl) { res = "TARGET"; x = e + 2 * sl; break; } x = m.c; }
  const C = (p: number) => Math.max(0.5, 0.0025 * p); return { net: (x - e - C(e) - C(x) - 40 / Pp.lot) * Pp.lot, res };
}

// ---------------- metrics ----------------
function boot(xs: { day: string; v: number }[], it = 2000, seed = 7) {
  if (xs.length < 5) return [NaN, NaN]; const g = new Map<string, number[]>(); for (const x of xs) (g.get(x.day) || g.set(x.day, []).get(x.day)!).push(x.v); const ds = [...g.values()];
  let s0 = seed; const rnd = () => ((s0 = (s0 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff), ms: number[] = [];
  for (let k = 0; k < it; k++) { let s = 0, n = 0; for (let j = 0; j < ds.length; j++) for (const v of ds[Math.floor(rnd() * ds.length)]) { s += v; n++; } ms.push(s / n); }
  ms.sort((a, b) => a - b); return [ms[Math.floor(it * 0.025)], ms[Math.floor(it * 0.975)]];
}
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
export function metrics(T: Trade[]) {
  const n = T.length; if (!n) return null;
  const nets = T.filter((t) => t.net != null), cons = T.filter((t) => t.netC != null);
  const W = nets.filter((t) => t.net! > 0), Lo = nets.filter((t) => t.net! <= 0), pos = W.reduce((a, t) => a + t.net!, 0), neg = -Lo.reduce((a, t) => a + t.net!, 0);
  const posC = cons.filter((t) => t.netC! > 0).reduce((a, t) => a + t.netC!, 0), negC = -cons.filter((t) => t.netC! <= 0).reduce((a, t) => a + t.netC!, 0), lossesC = cons.filter((t) => t.netC! <= 0);
  let cum = 0, pk = 0, dd = 0; for (const t of [...cons].sort((p, q) => p.t - q.t)) { cum += t.netC!; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  return { n, reach: REACH.map((r) => (T.filter((t) => t.x.reach[r]).length / n) * 100), mfe: med(T.map((t) => t.x.mfe)), mae: med(T.map((t) => t.x.mae)), consumed: med(T.map((t) => t.consumed)),
    idxAvg: T.reduce((a, t) => a + t.idxPts, 0) / n, exits: ["TARGET", "STOP", "BREAKEVEN", "THESIS", "TIME"].map((w) => T.filter((t) => t.x.why === w).length),
    win: nets.length ? (W.length / nets.length) * 100 : NaN, avgW: W.length ? pos / W.length : 0, avgL: Lo.length ? -neg / Lo.length : 0, gross: nets.reduce((a, t) => a + t.gross!, 0),
    exp: nets.length ? (pos - neg) / nets.length : NaN, ci: boot(nets.map((t) => ({ day: t.day, v: t.net! }))), expC: cons.length ? (posC - negC) / cons.length : NaN, ciC: boot(cons.map((t) => ({ day: t.day, v: t.netC! }))),
    pf: neg ? pos / neg : Infinity, pfC: negC ? posC / negC : Infinity, ddC: dd, avgLC: lossesC.length ? negC / lossesC.length : 0 };
}
const R0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-IN") : "—"), F1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const HDR = "| Group | Trades | Reach +15 / +20 / +30 / +45 / +60 % | Median MFE / MAE pts | Median pts consumed | Exits T / S / BE / Thesis / Time | Avg index pts | Win % | Avg win / loss ₹ | Net / trade ₹ [95% CI] | Conservative / trade ₹ [95% CI] | PF / PF cons | Max DD cons ₹ |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";
const row = (lab: string, T: Trade[]) => { const m = metrics(T); if (!m) return `| ${lab} | 0 | | | | | | | | | | | |`;
  return `| ${lab} | ${m.n} | ${m.reach.map((v) => v.toFixed(0)).join(" / ")} | ${F1(m.mfe)} / ${F1(m.mae)} | ${F1(m.consumed)} | ${m.exits.join(" / ")} | ${F1(m.idxAvg)} | ${F1(m.win)} | ${R0(m.avgW)} / ${R0(m.avgL)} | ${R0(m.exp)} [${R0(m.ci[0])}, ${R0(m.ci[1])}] | ${R0(m.expC)} [${R0(m.ciC[0])}, ${R0(m.ciC[1])}] | ${m.pf === Infinity ? "∞" : m.pf.toFixed(2)} / ${m.pfC === Infinity ? "∞" : m.pfC.toFixed(2)} | ${R0(m.ddC)} |`; };

if (require.main === module) {
  const out: string[] = [], W = (...s: string[]) => out.push(...(s.length ? s : [""])), all: Record<string, Trade[]> = { LAX: [], C2: [], ORB: [], RANDOM: [], EMA: [] };
  const waitLog: Record<string, Record<string, number>> = {}, dev15Rejects: string[] = [];
  for (const ix of ["NIFTY", "BANKNIFTY", "SENSEX"] as IX[]) {
    const Pp = prepareIndex(ix), log: Record<string, number> = (waitLog[ix] = {});
    for (let di = 1; di < Pp.ds.length; di++) {
      if (Pp.setOf(di) === "PURGE") continue;
      const lx = laxDay(Pp, di, log); all.LAX.push(...portfolio(lx.cands, log));
      if (Pp.dev15.has(Pp.ds[di].day)) for (const j of lx.rejects) dev15Rejects.push(`${ix} ${Pp.ds[di].day} ${hm(Pp.all5[j.i].time + 300)} ${j.dir > 0 ? "long" : "short"} ${j.level.kind} ${Math.round(j.level.p)} — ${j.reason}`);
      all.ORB.push(...portfolio(orbDay(Pp, di), {})); all.RANDOM.push(...randomDay(Pp, di)); all.C2.push(...c2Day(Pp, di));
    }
    if (ix !== "BANKNIFTY") {   // EMA baseline (emaCrossStudy supports NIFTY / SENSEX only)
      for (const x of emaRun(ix, Pp.ds as any).sigs.filter((s: any) => s.pt)) {
        const di = Pp.ds.findIndex((d) => d.day === x.day); if (di < 1 || Pp.setOf(di) === "PURGE") continue;
        const g = (() => { let k = Pp.off[di]; while (k + 1 < Pp.off[di] + Pp.n5[di] && Pp.all5[k + 1].time + 300 <= x.t) k++; return k; })(), b = Pp.all5[g], a = atr14(Pp.all5, g) || 1;
        const s: Signal = { i: g, t: x.t, dir: x.dir as 1 | -1, level: { p: x.dir > 0 ? b.low : b.high, kind: "EMA signal candle" }, entry: b.close, stop: x.dir > 0 ? b.low - 0.1 * a : b.high + 0.1 * a, risk: 0, room: Infinity, target: b.close + x.dir * 45, consumed: 0, atr: a, why: [] };
        const tr = evaluate(Pp, di, "EMA", s); if (tr) all.EMA.push(tr);
      }
    }
  }
  const oos = (t: Trade) => (t.set === "VAL" || t.set === "TEST") && !t.dev15;
  // ---- C2 replication check (Phase 1: 121 trades, +₹362 / trade on NIFTY + SENSEX, last 15 sessions, native exit) ----
  const c2d = all.C2.filter((t) => t.dev15 && t.ix !== "BANKNIFTY"), nat = c2d.filter((t) => Number.isFinite(t.native!.net));
  W("# FINAL 15–60 point backtest — raw tables (generated by backtest.ts)", "", "## 0. C2 replication check (must match Phase 1: 121 trades, 48 / 60 / 13, +₹362 per trade)", "",
    `- Re-implemented C2 on NIFTY + SENSEX, last 15 sessions: ${c2d.length} trades · native exit target / stop / time ${["TARGET", "STOP", "TIME"].map((r) => nat.filter((t) => t.native!.res === r).length).join(" / ")} · native net / trade ₹${R0(nat.reduce((a, t) => a + t.native!.net, 0) / nat.length)}`, "");
  // ---- main comparison ----
  const sets: [string, (t: Trade) => boolean][] = [["DEV15 (development window)", (t) => t.dev15], ["DEV (first 60 %)", (t) => t.set === "DEV"], ["VAL", (t) => t.set === "VAL"], ["TEST excl. DEV15", (t) => t.set === "TEST" && !t.dev15], ["PRIMARY OOS (VAL + TEST excl. DEV15)", oos], ["ALL periods", () => true]];
  for (const [lab, f] of sets) { W(`## ${lab}`, "", HDR); for (const k of ["LAX", "C2", "EMA", "ORB", "RANDOM"]) W(row(k + (k === "EMA" ? " (NIFTY+SENSEX)" : ""), all[k].filter(f))); const c2n = all.C2.filter(f).filter((t) => Number.isFinite(t.native!.net)); W("", `C2 with its own E1 option exit (Phase-1 costs): ${c2n.length} trades · net / trade ₹${R0(c2n.reduce((a, t) => a + t.native!.net, 0) / (c2n.length || 1))}`, ""); }
  // ---- LAX splits ----
  const split = (title: string, T: Trade[], key: (t: Trade) => string) => { W(`## ${title}`, "", HDR); const g = new Map<string, Trade[]>(); for (const t of T) { const k = key(t); (g.get(k) || g.set(k, []).get(k)!).push(t); } for (const [k, v] of [...g.entries()].sort()) W(row(k, v)); W(""); };
  const L = all.LAX;
  split("LAX by index (all periods)", L, (t) => t.ix); split("LAX by index (primary OOS)", L.filter(oos), (t) => t.ix);
  split("LAX by side (primary OOS)", L.filter(oos), (t) => `${t.ix} ${t.dir > 0 ? "CE" : "PE"}`); split("LAX by level (primary OOS)", L.filter(oos), (t) => t.levelKind);
  split("LAX by entry time (primary OOS)", L.filter(oos), (t) => { const m = istMin(t.t); return m < 600 ? "09:35–10:00" : m < 630 ? "10:00–10:30" : m < 660 ? "10:30–11:00" : "11:00–11:35"; });
  split("LAX by day type (hindsight label, reporting only; primary OOS)", L.filter(oos), (t) => t.dayType); split("LAX by volatility (hindsight; primary OOS)", L.filter(oos), (t) => t.volDay);
  split("LAX expiry vs other days (primary OOS)", L.filter(oos), (t) => (t.expiry ? "expiry day" : "other day")); split("LAX by half-year block (all periods)", L, (t) => t.block);
  split("LAX by session (DEV15)", L.filter((t) => t.dev15), (t) => `${t.day} ${t.ix}`);
  // ---- WAIT / NO-TRADE decisions ----
  W("## LAX WAIT / NO-TRADE decisions (all periods)", "", "| Reason | NIFTY | BANKNIFTY | SENSEX |", "|---|---|---|---|");
  const keys = [...new Set(Object.values(waitLog).flatMap((o) => Object.keys(o)))].sort(); for (const k of keys) W(`| ${k} | ${waitLog.NIFTY[k] || 0} | ${waitLog.BANKNIFTY[k] || 0} | ${waitLog.SENSEX[k] || 0} |`);
  // ---- acceptance criteria on the primary OOS ----
  const O = L.filter(oos), m = metrics(O)!, R = all.RANDOM.filter(oos), rr = (R.filter((t) => t.x.reach[15]).length / R.length) * 100;
  // bootstrap of the +15 reach difference (LAX − random), resampling days
  const days = [...new Set(O.map((t) => t.ix + t.day))], byL = new Map<string, Trade[]>(), byR = new Map<string, Trade[]>();
  for (const t of O) (byL.get(t.ix + t.day) || byL.set(t.ix + t.day, []).get(t.ix + t.day)!).push(t); for (const t of R) (byR.get(t.ix + t.day) || byR.set(t.ix + t.day, []).get(t.ix + t.day)!).push(t);
  let s0 = 11; const rnd = () => ((s0 = (s0 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff), diffs: number[] = [];
  for (let k = 0; k < 2000; k++) { let lh = 0, ln = 0, rh = 0, rn = 0; for (let j = 0; j < days.length; j++) { const d = days[Math.floor(rnd() * days.length)]; for (const t of byL.get(d) || []) { ln++; if (t.x.reach[15]) lh++; } for (const t of byR.get(d) || []) { rn++; if (t.x.reach[15]) rh++; } } diffs.push((lh / ln - rh / rn) * 100); }
  diffs.sort((a, b) => a - b); const dlo = diffs[50], dhi = diffs[1949];
  const perIx = (["NIFTY", "BANKNIFTY", "SENSEX"] as IX[]).map((ix) => metrics(O.filter((t) => t.ix === ix))?.expC ?? NaN), blocks = [...new Set(L.map((t) => t.block))].sort().map((b) => metrics(L.filter((t) => t.block === b))!.expC);
  const A = [
    ["A1 conservative net / trade > 0 with 95% lower bound > 0", `₹${R0(m.expC)} [${R0(m.ciC[0])}, ${R0(m.ciC[1])}]`, m.expC > 0 && m.ciC[0] > 0],
    ["A2 +15 reach ≥ 60% and ≥ random + 10 pts (CI excludes 0)", `${F1(m.reach[0])}% vs random ${F1(rr)}% · difference CI [${F1(dlo)}, ${F1(dhi)}]`, m.reach[0] >= 60 && m.reach[0] - rr >= 10 && dlo > 0],
    ["A3 profit factor (conservative) ≥ 1.2", m.pfC.toFixed(2), m.pfC >= 1.2],
    ["A4 max DD (conservative) ≤ 10 × average loss", `DD ₹${R0(m.ddC)} vs 10 × ₹${R0(m.avgLC)} = ₹${R0(10 * m.avgLC)}`, m.ddC <= 10 * m.avgLC],
    ["A5 conservative net > 0 in ≥ 2 of 3 indices and ≥ 60% of half-year blocks", `indices ${perIx.map((v) => R0(v)).join(" / ")} · blocks positive ${blocks.filter((v) => v > 0).length} of ${blocks.length}`, perIx.filter((v) => v > 0).length >= 2 && blocks.filter((v) => v > 0).length / blocks.length >= 0.6],
    ["A6 ≥ 100 OOS trades", String(m.n), m.n >= 100]] as const;
  W("", "## ACCEPTANCE CRITERIA (pre-registered) on the primary OOS", "", "| Criterion | Result | Pass |", "|---|---|---|"); for (const [c, r, p] of A) W(`| ${c} | ${r} | ${p ? "PASS" : "FAIL"} |`);
  W("", `VERDICT INPUT: ${A.filter((x) => x[2]).length} of ${A.length} criteria pass.`);
  // ---- DEV15 failed signals and rejected setups ----
  W("", "## DEV15 — every LAX trade and every rejected setup", "", "| Index | Date | Entry | Side | Level | Entry idx | Stop | Target | Exit | Why | Index pts | Premium in → out | Net ₹ | Net ₹ cons |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const t of L.filter((t) => t.dev15).sort((p, q) => p.t - q.t)) W(`| ${t.ix} | ${t.day.slice(5)} | ${hm(t.t)} | ${t.dir > 0 ? "CE" : "PE"} | ${t.levelKind} ${Math.round(t.level)} | ${Math.round(t.entry)} | ${Math.round(t.stop)} | ${Math.round(t.target)} | ${hm(t.x.exitT)} | ${t.x.why} | ${F1(t.idxPts)} | ${t.prem0?.toFixed(1)} → ${t.prem1?.toFixed(1)} | ${R0(t.net ?? NaN)} | ${R0(t.netC ?? NaN)} |`);
  W("", "Rejected setups (WAIT) in DEV15:", "", ...dev15Rejects.map((x) => `- ${x}`));
  fs.writeFileSync(path.join(OUT, `FINAL_15_60_POINT_BACKTEST${SFX}_raw.md`), out.join("\n"));
  // ---- trade-level CSV ----
  const csvHead = "strategy,index,date,set,dev15,block,expiry_day,day_type_hindsight,entry_time,side,level_kind,level,entry_index,stop,target,room_pts,consumed_pts,atr5,exit_time,exit_why,exit_index,index_pts,mfe_pts,mae_pts,reach15,reach20,reach30,reach45,reach60,strike,premium_in,premium_out,gross_rs,net_rs,net_conservative_rs";
  const csv = (T: Trade[]) => [csvHead, ...T.sort((p, q) => p.t - q.t).map((t) => [t.strat, t.ix, t.day, t.set, t.dev15, t.block, t.expiry, t.dayType, hm(t.t), t.dir > 0 ? "CE" : "PE", t.levelKind, t.level.toFixed(2), t.entry.toFixed(2), t.stop.toFixed(2), t.target.toFixed(2), Number.isFinite(t.room) ? t.room.toFixed(1) : "", t.consumed.toFixed(1), t.atr.toFixed(2), hm(t.x.exitT), t.x.why, t.x.exitPx.toFixed(2), t.idxPts.toFixed(1), t.x.mfe.toFixed(1), t.x.mae.toFixed(1), ...REACH.map((r) => (t.x.reach[r] ? 1 : 0)), t.strike, t.prem0 ?? "", t.prem1 ?? "", t.gross?.toFixed(0) ?? "", t.net?.toFixed(0) ?? "", t.netC?.toFixed(0) ?? ""].join(","))].join("\n");
  fs.writeFileSync(path.join(OUT, `lax_trades${SFX}.csv`), csv(L)); if (!ITM1) fs.writeFileSync(path.join(OUT, "comparison_trades.csv"), csv([...all.C2, ...all.EMA, ...all.ORB]));
  console.log(out.slice(0, 40).join("\n"));
  console.log(`\nwrote FINAL_15_60_POINT_BACKTEST_raw.md, lax_trades.csv (${L.length} rows), comparison_trades.csv`);
  process.exit(0);
}
