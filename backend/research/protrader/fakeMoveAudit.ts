// QUANTITATIVE AUDIT of the live FAKE-DOWN / FAKE-UP detector (owner's brief, 2026-10-24). Research only — no live code
// is changed. Steps: (1) reproduce the baseline with the EXACT live functions, (2) classify losing signals,
// (3) one-change ablations, (4) pre-registered outcomes, (5) chronological dev / val / untouched test with purging,
// (6) decision gate. Usage: npx tsx fakeMoveAudit.ts <out.json>
//
// PRE-REGISTERED DEFINITIONS (fixed before any result was seen):
//  Data      real Dhan 1-min NIFTY + SENSEX spot + ATM±3 option legs (price, OI, volume), FROM → latest downloaded day.
//  Periods   chronological sessions: DEV first 60 %, VAL next 20 %, TEST last 20 %. The first session of VAL and of TEST
//            is purged (outcome windows are intraday, so this is a one-day buffer, not a requirement).
//  Baseline  live detectFakeMoveTF (4 bars, 0.04 %) on 5-min candles and on 15-min candles INCLUDING the forming candle
//            (as the live chart feed), levels = PDH/PDL + ORB high/low (after 09:30) + last 6 swing points of each
//            timeframe's live structure engine (detectMarketStructure, lookback 3; 5 days of 5m / 15m candles),
//            side = level vs spot (live). Combined by the live buildFakeMoveResult.
//            SIGNAL = a 5-min close where the headline is FAILED_BREAKDOWN / FAILED_BREAKOUT / EARLY_REJECTION with a
//            CONFIRMED timeframe (CONFLICT excluded), first time per (day, direction, lead level).
//            NOT reproducible: the OI-wall levels (no full-chain OI history) — documented deviation.
//  Direction outcome (H = 60 min): CORRECT if the index is ≥ 0.25 × ATR5 in the signal direction at entry + 60 min,
//            WRONG if ≥ 0.25 × ATR5 against, else FLAT. Direction precision = CORRECT / all signals.
//  Trade outcome: entry = the signal 5-min close; stop = the 4-bar sweep extreme (distance floored at 0.25 × ATR5);
//            target = 1R; 60 min on 1-min closes. TP = target first; FP = stop first or no target in 60 min (TIME).
//            Trade precision = TP / all signals (strict). Ambiguous = target and stop crossed in the same 1-min step
//            (the finest data available; it holds closes only, so intra-minute order cannot be resolved further).
//  Net expectancy: buy the ATM CE (fake-down) / PE (fake-up) at the entry minute, sell at the trade's exit minute,
//            approved ProTrader costs: max(0.5, 0.25 % of premium) per side + ₹40 per lot round trip.
//  Recall    positives = eligible setups (each level interaction, first bar per day / level / implied direction) whose
//            reversal trade with the same rules hits 1R; recall = TP signals / positives.
//  Same-stop baseline: a 1R entry at every 5-min close, same stop rule, matched on direction × stop-width bucket
//            (0.25 ATR) × time bucket — the precision a signal-free entry gets with the same geometry.
import fs from "fs";
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { detectFakeMoveTF, buildFakeMoveResult, FakeMoveLevel, FakeMove } from "../../analyst/fakeMove";
import { detectMarketStructure } from "../../liquidity/orderBlock";
import { expiryDays } from "./premiumBacktest2";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const IDX = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
const COST = (p: number) => Math.max(0.5, 0.0025 * p);
const barsN = (mins: [number, number][], n: number): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };

// ---------------------------------------------------------------------------------------------------------------
// Parametrised copy of detectFakeMoveTF (fakeMove.ts). With the default eps it must equal the live function on every
// bar — checked below and reported (mismatches must be 0 before any ablation result is used).
type Det = { direction: "UP" | "DOWN" | "NONE"; status: "NONE" | "WATCH" | "CONFIRMED"; breakoutState: string; level: number | null; levelLabel: string | null };
const NONE: Det = { direction: "NONE", status: "NONE", breakoutState: "NONE", level: null, levelLabel: null };
export function detectP(candles: Bar[], levels: FakeMoveLevel[], epsOf: (lvl: number) => number = (p) => p * 0.0004): Det {
  if (!candles || candles.length < 3 || !levels.length) return NONE;
  const bars = candles.slice(-4), last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  const pick = (side: "resistance" | "support") => { const c = levels.filter((l) => l.side === side && Number.isFinite(l.price))
    .filter((l) => (side === "resistance" ? hi >= l.price && l.price >= lo * 0.99 : lo <= l.price && l.price <= hi * 1.01));
    if (!c.length) return null; c.sort((a, b) => Math.abs(a.price - last.close) - Math.abs(b.price - last.close)); return c[0]; };
  const resL = pick("resistance"), supL = pick("support");
  const resDist = resL ? Math.abs(last.close - resL.price) : Infinity, supDist = supL ? Math.abs(last.close - supL.price) : Infinity;
  const evalR = (l: FakeMoveLevel): Det => { const e = epsOf(l.price), up = (b: Bar) => b.close > l.price + e;
    const pierced = bars.some((b) => b.high > l.price + e), hadAbove = bars.some(up), lastAbove = up(last), prevAbove = prev ? up(prev) : false;
    const base = { level: l.price, levelLabel: l.label };
    if (lastAbove && prevAbove) { const dip = last.low <= l.price + e && last.close > l.price; return { ...base, direction: "NONE", status: dip ? "WATCH" : "NONE", breakoutState: dip ? "RETEST" : "BREAKOUT_ACCEPTED" }; }
    if (pierced) { if (!lastAbove && hadAbove) return { ...base, direction: "UP", status: "CONFIRMED", breakoutState: "FAILED_BREAKOUT" };
      if (!lastAbove && !hadAbove) return { ...base, direction: "UP", status: "WATCH", breakoutState: "NONE" };
      return { ...base, direction: "NONE", status: "WATCH", breakoutState: "NONE" }; }
    return NONE; };   // live: emptyFakeMove → level null
  const evalS = (l: FakeMoveLevel): Det => { const e = epsOf(l.price), dn = (b: Bar) => b.close < l.price - e;
    const pierced = bars.some((b) => b.low < l.price - e), hadBelow = bars.some(dn), lastBelow = dn(last), prevBelow = prev ? dn(prev) : false;
    const base = { level: l.price, levelLabel: l.label };
    if (lastBelow && prevBelow) { const pop = last.high >= l.price - e && last.close < l.price; return { ...base, direction: "NONE", status: pop ? "WATCH" : "NONE", breakoutState: pop ? "RETEST" : "BREAKDOWN_ACCEPTED" }; }
    if (pierced) { if (!lastBelow && hadBelow) return { ...base, direction: "DOWN", status: "CONFIRMED", breakoutState: "FAILED_BREAKDOWN" };
      if (!lastBelow && !hadBelow) return { ...base, direction: "DOWN", status: "WATCH", breakoutState: "NONE" };
      return { ...base, direction: "NONE", status: "WATCH", breakoutState: "NONE" }; }
    return NONE; };   // live: emptyFakeMove → level null
  let primary: Det | null = null;
  if (resL && resDist <= supDist) primary = evalR(resL); else if (supL) primary = evalS(supL);
  if ((!primary || primary.status === "NONE") && resL && resDist > supDist) { const r = evalR(resL); if (r.status !== "NONE") primary = r; }
  if ((!primary || primary.status === "NONE") && supL && supDist > resDist) { const s = evalS(supL); if (s.status !== "NONE") primary = s; }
  return primary ?? NONE;
}
/** The live headline combination (buildFakeMoveResult) reduced to the signal: direction, lead, which TF confirmed. */
export function combine(f5: Det, f15: Det) {
  const a5 = f5.direction !== "NONE" && f5.status !== "NONE", a15 = f15.direction !== "NONE" && f15.status !== "NONE";
  const conflict = a5 && a15 && f5.direction !== f15.direction;
  const c5 = f5.status === "CONFIRMED", c15 = f15.status === "CONFIRMED";
  if (conflict || !(c5 || c15)) return null;
  const lead = c15 ? f15 : f5;
  const conf = a5 && a15 ? (c5 && c15 ? "ALIGNED" : "WATCH") : "WATCH";
  return { dir: lead.direction === "DOWN" ? 1 : -1, lead, src: c5 && c15 ? "5m+15m" : c15 ? "15m" : "5m", conf, confidence: (c5 ? 35 : f5.status === "WATCH" ? 15 : 0) + (c15 ? 45 : f15.status === "WATCH" ? 20 : 0) + (c5 && c15 ? 20 : 0) };
}
const same = (a: FakeMove, b: Det) => a.direction === b.direction && a.status === b.status && a.breakoutState === b.breakoutState && (a.level ?? null) === (b.level ?? null);

// ---------------------------------------------------------------------------------------------------------------
type Trade = { res: "TP" | "STOP" | "TIME" | "AMBIG"; r: number; tOut: number | null; stopAtr: number; mae: number; mfe: number };
function trade(path: [number, number][], entry: number, stopPx: number, dir: number, a: number): Trade {
  const d = Math.max(dir * (entry - stopPx), 0.25 * a), s = entry - dir * d, tg = entry + dir * d; let mae = 0, mfe = 0, prevP = entry;
  for (const [t, p] of path) {
    const hitS = dir * (p - s) <= 0, hitT = dir * (p - tg) >= 0;
    if (hitS && hitT) return { res: "AMBIG", r: 0, tOut: t, stopAtr: d / a, mae, mfe };
    // a gap through both in one step (prev on one side, now beyond the other) is ambiguous as well
    if ((hitS && dir * (prevP - tg) >= 0) || (hitT && dir * (prevP - s) <= 0)) return { res: "AMBIG", r: 0, tOut: t, stopAtr: d / a, mae, mfe };
    mae = Math.max(mae, -dir * (p - entry) / a); mfe = Math.max(mfe, dir * (p - entry) / a); prevP = p;
    if (hitS) return { res: "STOP", r: -1, tOut: t, stopAtr: d / a, mae, mfe };
    if (hitT) return { res: "TP", r: 1, tOut: t, stopAtr: d / a, mae, mfe };
  }
  return { res: "TIME", r: path.length ? dir * (path[path.length - 1][1] - entry) / d : 0, tOut: path.length ? path[path.length - 1][0] : null, stopAtr: d / a, mae, mfe };
}

interface Sig { ix: string; day: string; set: string; t: number; m: number; dir: number; variant: string; src: string; conf: string; confidence: number;
  label: string; level: number; f: Record<string, any>; tr: Trade; dirOut: "CORRECT" | "WRONG" | "FLAT"; net: number | null; netPct: number | null; ft: boolean | null; regime: Record<string, string> }

function runIndex(ix: "NIFTY" | "SENSEX", days: DayData[], check: { n: number; bad: number; d5: number; d15: number; sig: number; conf: number }) {
  const { step, lot } = IDX[ix];
  const ds = days.filter((d) => d.spot.size >= 300), N = ds.length, d1 = Math.floor(N * 0.6), d2 = Math.floor(N * 0.8);
  const expSet = expiryDays(ds, step), dayIx = new Map(ds.map((d, i) => [d.day, i]));
  const setOf = (i: number) => (i === d1 || i === d2 ? "PURGE" : i < d1 ? "DEV" : i < d2 ? "VAL" : "TEST");
  const sigs: Sig[] = [], setups: any[] = [], base: any[] = [], meta = { sessions: { DEV: 0, VAL: 0, TEST: 0, PURGE: 0 } as Record<string, number>, from: ds[0]?.day, to: ds[N - 1]?.day, bounds: [ds[d1]?.day, ds[d2]?.day] };
  let hist5: Bar[] = [], hist15: Bar[] = [], prevDay: { h: number; l: number } | null = null; const atrHist: number[] = [], dayAtrs: number[] = [];
  ds.forEach((d, di) => {
    const set = setOf(di); meta.sessions[set]++;
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
    if (mins.length < 300) return;
    const B5 = barsN(mins, 5), B15full = barsN(mins, 15);
    const legIx = new Map<string, Map<number, Min>>(); for (const [k, arr] of d.legs) legIx.set(k, new Map(arr.map((x) => [x.t, x])));
    const leg = (k: number, side: string, t: number) => { const m = legIx.get(`${k}${side}`); if (!m) return null; for (let j = 0; j < 4; j++) { const x = m.get(t - 60 - j * 60); if (x) return x; } return null; };
    const vol = (k: number, side: string, t0: number, t1: number) => { const m = legIx.get(`${k}${side}`); if (!m) return null; let v = 0, n = 0; for (let t = t0; t < t1; t += 60) { const x = m.get(t); if (x?.v != null) { v += x.v; n++; } } return n ? v / n : null; };
    const orb = B5.filter((b) => mn(b.time) < 570), orbH = Math.max(...orb.map((b) => b.high)), orbL = Math.min(...orb.map((b) => b.low));
    const dayH = Math.max(...mins.map(([, p]) => p)), dayL = Math.min(...mins.map(([, p]) => p)), dayRange = dayH - dayL;
    const prevAtrDay = dayAtrs.length >= 20 ? [...dayAtrs.slice(-60)].sort((a, b) => a - b)[Math.floor(Math.min(60, dayAtrs.length) / 2)] : null;
    const regime = { vol: prevAtrDay == null ? "—" : dayRange > prevAtrDay ? "HIGH-VOL day" : "LOW-VOL day", trend: Math.abs(mins[mins.length - 1][1] - mins[0][1]) >= 0.6 * dayRange ? "TREND day" : "RANGE day",
      half: d.day.slice(0, 4) + (d.day.slice(5, 7) <= "06" ? "-H1" : "-H2") };
    const nextDay = ds[di + 1]?.day, expCtx = expSet.has(d.day) ? "EXPIRY day" : nextDay && expSet.has(nextDay) ? "day before expiry" : "other day";
    const pathFrom = (t0: number) => mins.filter(([t]) => t >= t0 && t < t0 + 3600);
    const seen = new Set<string>(), seenSetup = new Set<string>();
    for (let i = 2; i < B5.length; i++) {
      const tEnd = B5[i].time + 300, m = mn(tEnd), all5 = hist5.concat(B5.slice(0, i + 1)), a = atr14(all5.slice(-15)); if (!a) continue;
      atrHist.push(a); if (atrHist.length > 100) atrHist.shift();
      const px = B5[i].close, path = pathFrom(tEnd); if (path.length < 5) continue;
      const w4 = B5.slice(Math.max(0, i - 3), i + 1), lo4 = Math.min(...w4.map((b) => b.low)), hi4 = Math.max(...w4.map((b) => b.high));
      const tb = m < 630 ? "09:15-10:30" : m < 720 ? "10:30-12:00" : m < 810 ? "12:00-13:30" : "13:30-15:30";
      if (set !== "PURGE") for (const dir of [1, -1]) { const tr = trade(path, px, dir > 0 ? lo4 : hi4, dir, a); if (tr.res !== "AMBIG") base.push({ set, dir, tb, sb: Math.min(12, Math.floor(tr.stopAtr / 0.25)), tp: tr.res === "TP" ? 1 : 0 }); }
      // live inputs: 5m candles; 15m candles incl. the forming one (minutes before tEnd); 15m completed-only (ablation 4)
      const m15 = mins.filter(([t]) => t < tEnd), b15f = barsN(m15, 15), b15c = b15f.filter((b) => b.time + 900 <= tEnd);
      const win5 = all5.slice(-375), win15f = hist15.concat(b15f).slice(-125), win15c = hist15.concat(b15c).slice(-125);
      const sw = (w: Bar[]) => (w.length >= 20 ? ((detectMarketStructure(w as any, 3) as any).swingPoints || []).slice(-6) : []);
      const shared: [number, string][] = []; if (prevDay) shared.push([prevDay.h, "Prev Day High"], [prevDay.l, "Prev Day Low"]); if (m >= 570) shared.push([orbH, "ORB High"], [orbL, "ORB Low"]);
      const mk = (sp: any[], sideOf: (p: number) => "resistance" | "support"): FakeMoveLevel[] => [...shared, ...sp.map((p: any) => [p.price, p.type === "HH" || p.type === "LH" ? "Swing High" : "Swing Low"] as [number, string])]
        .map(([p, label]) => ({ price: Math.round(p * 100) / 100, label, side: sideOf(p) }));
      const bySpot = (p: number) => (p >= px ? "resistance" : "support") as "resistance" | "support";
      const sw5 = sw(win5), sw15f = sw(win15f), L5 = mk(sw5, bySpot), L15 = mk(sw15f, bySpot);
      const c5 = win5.slice(-41), c15f = win15f.slice(-41), c15c = win15c.slice(-41);
      // equivalence check vs the live functions (every bar)
      const live5 = detectFakeMoveTF({ tfLabel: "5M", candles: c5, levels: L5 }), live15 = detectFakeMoveTF({ tfLabel: "15M", candles: c15f, levels: L15 });
      const p5 = detectP(c5, L5), p15 = detectP(c15f, L15);
      const liveRes = buildFakeMoveResult({ tf5: { tfLabel: "5M", candles: c5, levels: L5 }, tf15: { tfLabel: "15M", candles: c15f, levels: L15 }, higher: { timeframe: "1H", available: false }, existingDirection: null, dataStale: false });
      const cb = combine(p5, p15), liveSig = ["FAILED_BREAKDOWN", "FAILED_BREAKOUT", "EARLY_REJECTION"].includes(liveRes.mtfFakeMoveState.status) && (live5.status === "CONFIRMED" || live15.status === "CONFIRMED");
      check.n++; { const m1 = !same(live5, p5), m2 = !same(live15, p15), m3 = liveSig !== !!cb, m4 = !!cb && liveRes.mtfFakeMoveState.confidence !== cb.confidence; if (m1 || m2 || m3 || m4) check.bad++; if (m1) check.d5++; if (m2) check.d15++; if (m3) check.sig++; if (m4) check.conf++; }
      if (set === "PURGE") continue;
      // eligible setups (level interactions) for recall
      for (const fm of [p5, p15]) if (fm.level != null && (fm.status !== "NONE" || fm.breakoutState !== "NONE")) {
        const sideIsSup = fm.level < px || fm.direction === "DOWN", idir = fm.direction === "DOWN" ? 1 : fm.direction === "UP" ? -1 : sideIsSup ? 1 : -1, k = `${idir}|${Math.round(fm.level)}`;
        if (!seenSetup.has(k)) { seenSetup.add(k); const tr = trade(path, px, idir > 0 ? lo4 : hi4, idir, a); setups.push({ set, day: d.day, pos: tr.res === "TP" }); }
      }
      // ---- variants of the signal (baseline + detector-level ablations) ----
      const preSide = (p: number) => ((B5[i - 3] ?? B5[0]).open >= p ? "support" : "resistance") as "resistance" | "support";   // side frozen BEFORE the 4-bar window
      const variants: [string, any][] = [["BASE", cb]];
      { const q5 = detectP(c5, mk(sw5, preSide)), q15 = detectP(c15f, mk(sw15f, preSide)); variants.push(["A1 stable side", combine(q5, q15)]); }
      for (const k of [0.05, 0.1, 0.2]) variants.push([`A2 eps ${k}×ATR`, combine(detectP(c5, L5, () => k * a), detectP(c15f, L15, () => k * a * 1.7))]);
      { const sw15c = sw(win15c); variants.push(["A4a completed 15m", combine(p5, detectP(c15c, mk(sw15c, bySpot)))]); }
      variants.push(["W wick-only (WATCH)", (() => { const w = [p5, p15].find((x) => x.status === "WATCH" && x.direction !== "NONE"); return !cb && w ? { dir: w.direction === "DOWN" ? 1 : -1, lead: w, src: w === p5 ? "5m" : "15m", conf: "WATCH", confidence: 0 } : null; })()]);
      let ctx: any = null;
      for (const [vname, s] of variants) {
        if (!s || s.lead.level == null) continue;
        const key = `${vname}|${s.dir}|${Math.round(s.lead.level)}`; if (seen.has(key)) continue; seen.add(key);
        const lvl = s.lead.level, dir = s.dir;
        if (!ctx) {
          const atm = Math.round(px / step) * step, t0 = B5[Math.max(0, i - 3)].time;
          const vw = (vol(atm, "CE", t0, tEnd) ?? 0) + (vol(atm, "PE", t0, tEnd) ?? 0), vp = (vol(atm, "CE", t0 - 3600, t0) ?? 0) + (vol(atm, "PE", t0 - 3600, t0) ?? 0);
          const s15 = b15c.length + hist15.length >= 20 ? (detectMarketStructure(win15c as any, 3) as any).currentStructure : "—";
          ctx = { atm, t0, volX: vp > 0 ? vw / vp : null, atrX: a / (atrHist.reduce((x, y) => x + y, 0) / atrHist.length), s15,
            ce0: leg(atm, "CE", t0 + 60), ce1: leg(atm, "CE", tEnd), pe0: leg(atm, "PE", t0 + 60), pe1: leg(atm, "PE", tEnd) };
        }
        const poke = (dir > 0 ? lvl - lo4 : hi4 - lvl) / a;
        const touches = (() => { let n = 0, lastT = -1e12; for (const [t, p] of mins) { if (t >= ctx.t0) break; if (Math.abs(p - lvl) <= 0.1 * a) { if (t - lastT > 900) n++; lastT = t; } } return n; })();
        const [my0, my1, ot0, ot1] = dir > 0 ? [ctx.ce0, ctx.ce1, ctx.pe0, ctx.pe1] : [ctx.pe0, ctx.pe1, ctx.ce0, ctx.ce1];
        const tr = trade(path, px, dir > 0 ? lo4 : hi4, dir, a);
        const at60 = path.length ? path[path.length - 1][1] : px, mv = dir * (at60 - px) / a;
        const side = dir > 0 ? "CE" : "PE", e0 = leg(ctx.atm, side, tEnd)?.c ?? null, e1 = tr.tOut != null ? leg(ctx.atm, side, tr.tOut + 60)?.c ?? null : null;
        const net = e0 != null && e1 != null ? e1 - e0 - COST(e0) - COST(e1) - 40 / lot : null;
        const nx = B5[i + 1], ft = nx ? (dir > 0 ? nx.close > B5[i].high : nx.close < B5[i].low) : null;
        // reconciliation: the earlier studies' definition (target 1 × ATR, stop = 4-bar extreme, no floor, 60 min)
        const old = (() => { const st = dir > 0 ? lo4 : hi4, tg = px + dir * a; if (dir * (px - st) <= 0) return "WRONG"; for (const [, q] of path) { if (dir * (q - st) <= 0) return "WRONG"; if (dir * (q - tg) >= 0) return "RIGHT"; } return "TIME"; })();
        if (vname === "BASE" && nx && ft) {   // A9 (post-hoc, from Step 2): enter at the follow-through close, same stop
          const t1 = nx.time + 300, p1 = pathFrom(t1), tr9 = trade(p1, nx.close, dir > 0 ? lo4 : hi4, dir, a), q60 = p1.length ? p1[p1.length - 1][1] : nx.close, mv9 = dir * (q60 - nx.close) / a;
          const g0 = leg(ctx.atm, side, t1)?.c ?? null, g1 = tr9.tOut != null ? leg(ctx.atm, side, tr9.tOut + 60)?.c ?? null : null, n9 = g0 != null && g1 != null ? g1 - g0 - COST(g0) - COST(g1) - 40 / lot : null;
          sigs.push({ ix, day: d.day, set, t: t1, m: m + 5, dir, variant: "A9 follow-through entry", src: s.src, conf: s.conf, confidence: s.confidence, label: s.lead.levelLabel || "—", level: lvl,
            f: { poke, touches, volX: ctx.volX, atrX: ctx.atrX, s15: ctx.s15, tb, exp: expCtx, premUp: false, write: false, oiOk: false, old: "—" },
            tr: tr9, dirOut: mv9 >= 0.25 ? "CORRECT" : mv9 <= -0.25 ? "WRONG" : "FLAT", net: n9, netPct: n9 != null && g0 ? (n9 / g0) * 100 : null, ft: true, regime });
        }
        sigs.push({ ix, day: d.day, set, t: tEnd, m, dir, variant: vname, src: s.src, conf: s.conf, confidence: s.confidence, label: s.lead.levelLabel || "—", level: lvl,
          f: { poke, touches, volX: ctx.volX, atrX: ctx.atrX, s15: ctx.s15, tb, exp: expCtx,
            premUp: !!(my0 && my1 && ot0 && ot1 && my1.c > my0.c && ot1.c < ot0.c),
            write: !!(ot0 && ot1 && ot0.oi != null && ot1.oi != null && ot1.oi > ot0.oi && ot1.c < ot0.c), oiOk: !!(ot0?.oi && ot1?.oi), old },
          tr, dirOut: mv >= 0.25 ? "CORRECT" : mv <= -0.25 ? "WRONG" : "FLAT", net, netPct: net != null && e0 ? (net / e0) * 100 : null, ft, regime });
      }
    }
    hist5 = hist5.concat(B5).slice(-400); hist15 = hist15.concat(B15full).slice(-150);
    prevDay = { h: dayH, l: dayL }; dayAtrs.push(dayRange);
  });
  void dayIx;
  return { sigs, setups, base, meta };
}

// ---------------------------------------------------------------------------------------------------------------
const wilson = (k: number, n: number) => { if (!n) return [NaN, NaN]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [((c - h) / d) * 100, ((c + h) / d) * 100]; };
function bootMean(xs: { day: string; v: number }[], it = 1000) {
  if (xs.length < 5) return [NaN, NaN]; const byDay = new Map<string, number[]>(); for (const x of xs) (byDay.get(x.day) || byDay.set(x.day, []).get(x.day)!).push(x.v);
  const ds = [...byDay.values()]; let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); const means: number[] = [];
  for (let k = 0; k < it; k++) { let s = 0, n = 0; for (let j = 0; j < ds.length; j++) { const g = ds[Math.floor(rnd() * ds.length)]; for (const v of g) { s += v; n++; } } means.push(s / n); }
  means.sort((a, b) => a - b); return [means[Math.floor(it * 0.025)], means[Math.floor(it * 0.975)]];
}
function stats(sg: Sig[], baseIx: Map<string, number>, sessions: number, positives: number) {
  const n = sg.length, tp = sg.filter((x) => x.tr.res === "TP").length, st = sg.filter((x) => x.tr.res === "STOP").length, tm = sg.filter((x) => x.tr.res === "TIME").length, amb = n - tp - st - tm;
  const dc = sg.filter((x) => x.dirOut === "CORRECT").length, dw = sg.filter((x) => x.dirOut === "WRONG").length;
  let bw = 0, bn = 0; for (const x of sg) { const b = baseIx.get(`${x.set}|${x.dir}|${x.f.tb}|${Math.min(12, Math.floor(x.tr.stopAtr / 0.25))}`); if (b != null) { bw += b; bn++; } }
  const nets = sg.filter((x) => x.netPct != null).map((x) => ({ day: x.day, v: x.netPct! }));
  const avgNet = nets.length ? nets.reduce((s, x) => s + x.v, 0) / nets.length : NaN;
  return { n, tp, stop: st, time: tm, ambig: amb, prec: n ? (tp / n) * 100 : NaN, ci: wilson(tp, n), precDecided: tp + st ? (tp / (tp + st)) * 100 : NaN,
    base: bn ? (bw / bn) * 100 : NaN, dirPrec: n ? (dc / n) * 100 : NaN, dirWrong: n ? (dw / n) * 100 : NaN, dirCi: wilson(dc, n),
    avgR: n ? sg.reduce((s, x) => s + x.tr.r, 0) / n : NaN, avgNet, netCi: bootMean(nets), nNet: nets.length,
    perSession: sessions ? n / sessions : NaN, falsePerSession: sessions ? (n - tp) / sessions : NaN, recall: positives ? (tp / positives) * 100 : NaN,
    coverageDays: sessions ? (new Set(sg.map((x) => x.ix + x.day)).size / sessions) * 100 : NaN };
}
const f1 = (x: number) => (isFinite(x) ? x.toFixed(1) : "—"), f2 = (x: number) => (isFinite(x) ? x.toFixed(2) : "—");
const line = (lab: string, s: ReturnType<typeof stats>) =>
  `${lab.padEnd(44)} n ${String(s.n).padStart(5)} | trade prec ${f1(s.prec).padStart(5)}% [${f1(s.ci[0])}–${f1(s.ci[1])}] same-stop ${f1(s.base)}% · decided ${f1(s.precDecided)}% · T/S/time/amb ${s.tp}/${s.stop}/${s.time}/${s.ambig} | dir ${f1(s.dirPrec)}% (wrong ${f1(s.dirWrong)}%) | avgR ${f2(s.avgR)} | net ${f1(s.avgNet)}% [${f1(s.netCi[0])}–${f1(s.netCi[1])}] | ${f2(s.perSession)}/sess, false ${f2(s.falsePerSession)}/sess, recall ${f1(s.recall)}%`;

if (require.main === module) {
  const to = latestRawDay(), check = { n: 0, bad: 0, d5: 0, d15: 0, sig: 0, conf: 0 }, R: Record<string, ReturnType<typeof runIndex>> = {};
  R.NIFTY = runIndex("NIFTY", assemble(FROM, to).days, check);
  R.SENSEX = runIndex("SENSEX", assembleIndex("SENSEX", FROM, to), check);
  const out: string[] = [], P = (s = "") => { out.push(s); console.log(s); };
  const allSig = [...R.NIFTY.sigs, ...R.SENSEX.sigs];
  const baseIx = new Map<string, number>(); { const acc = new Map<string, [number, number]>(); for (const ix of ["NIFTY", "SENSEX"]) for (const b of R[ix].base) { const k = `${b.set}|${b.dir}|${b.tb}|${b.sb}`, v = acc.get(k) || [0, 0]; v[0] += b.tp; v[1]++; acc.set(k, v); } for (const [k, [w, n]] of acc) if (n >= 30) baseIx.set(k, w / n); }
  const sess = (set: string, ix?: string) => (ix ? [ix] : ["NIFTY", "SENSEX"]).reduce((s, k) => s + R[k].meta.sessions[set], 0);
  const pos = (set: string, ix?: string) => (ix ? [ix] : ["NIFTY", "SENSEX"]).reduce((s, k) => s + R[k].setups.filter((x: any) => x.set === set && x.pos).length, 0);
  const S = (sg: Sig[], set: string, ix?: string) => stats(sg.filter((x) => x.set === set && (!ix || x.ix === ix)), baseIx, sess(set, ix), pos(set, ix));
  const V = (name: string) => allSig.filter((x) => x.variant === name);

  P(`# STEP 1 — BASELINE REPRODUCTION`);
  P(`Equivalence of the research copy vs the LIVE detectFakeMoveTF + buildFakeMoveResult: ${check.n} bar evaluations, mismatches ${check.bad} (5m ${check.d5} · 15m ${check.d15} · signal ${check.sig} · confidence ${check.conf})`);
  for (const ix of ["NIFTY", "SENSEX"]) { const m = R[ix].meta; P(`${ix}: ${m.from} → ${m.to} · sessions DEV ${m.sessions.DEV} / VAL ${m.sessions.VAL} / TEST ${m.sessions.TEST} (purged ${m.sessions.PURGE}) · VAL starts ${m.bounds[0]}, TEST starts ${m.bounds[1]}`); }
  for (const set of ["DEV", "VAL"]) {
    const es = ["NIFTY", "SENSEX"].reduce((s, k) => s + R[k].setups.filter((x: any) => x.set === set).length, 0);
    P(`${set}: eligible setups (level interactions) ${es}, of which reversal-positive ${pos(set)}`);
    for (const ix of ["NIFTY", "SENSEX"]) for (const dir of [1, -1]) P(line(`  ${set} ${ix} ${dir > 0 ? "FAKE-DOWN" : "FAKE-UP"}`, S(V("BASE").filter((x) => x.dir === dir), set, ix)));
    P(line(`  ${set} ALL baseline`, S(V("BASE"), set)));
  }
  { P(`Reconciliation with the earlier "55–60 %" (target 1 × ATR vs the 4-bar stop, TIME = not right), same signals:`);
    for (const set of ["DEV", "VAL"]) for (const dir of [1, -1]) { const xs = V("BASE").filter((x) => x.set === set && x.dir === dir), r = xs.filter((x) => x.f.old === "RIGHT").length, w = xs.filter((x) => x.f.old === "WRONG").length;
      P(`  ${set} ${dir > 0 ? "FAKE-DOWN" : "FAKE-UP"}: right ${f1((r / xs.length) * 100)}% of all, ${f1((r / (r + w)) * 100)}% of decided · median stop ${f2([...xs.map((x) => x.tr.stopAtr)].sort((p, q) => p - q)[Math.floor(xs.length / 2)])} ATR vs a 1-ATR target`); } }
  P(`(TEST is untouched until the parameters are frozen — see Step 5.)`);

  P(`\n# STEP 2 — WHERE THE FALSE POSITIVES COME FROM (DEV only; baseline signals)`);
  const dev = V("BASE").filter((x) => x.set === "DEV");
  const bucket = (lab: string, fn: (x: Sig) => string) => { P(`\n## ${lab}`); const g = new Map<string, Sig[]>(); for (const x of dev) { const k = fn(x); (g.get(k) || g.set(k, []).get(k)!).push(x); }
    for (const [k, xs] of [...g.entries()].sort((a, b) => b[1].length - a[1].length)) { const s = stats(xs, baseIx, sess("DEV"), 0); P(`  ${k.padEnd(26)} n ${String(s.n).padStart(5)} · prec ${f1(s.prec)}% [${f1(s.ci[0])}–${f1(s.ci[1])}] vs same-stop ${f1(s.base)}% · losers ${s.n - s.tp} (${f1(((s.n - s.tp) / (dev.length - dev.filter((y) => y.tr.res === "TP").length)) * 100)}% of all losers) · net ${f1(s.avgNet)}%`); } };
  bucket("Level type", (x) => x.label); bucket("Timeframe that confirmed", (x) => x.src);
  bucket("5m/15m state", (x) => x.conf === "ALIGNED" ? "aligned (both confirmed)" : "one TF only / other watching or none");
  bucket("Prior touches today", (x) => (x.f.touches >= 2 ? "2+" : String(x.f.touches)));
  bucket("Break distance (ATR)", (x) => (x.f.poke < 0.25 ? "<0.25" : x.f.poke < 0.5 ? "0.25–0.5" : x.f.poke < 1 ? "0.5–1" : "≥1"));
  bucket("Option volume expansion (index has no volume)", (x) => (x.f.volX == null ? "n/a" : x.f.volX < 1 ? "<1×" : x.f.volX < 1.5 ? "1–1.5×" : "≥1.5×"));
  bucket("Volatility (ATR vs its 100-bar mean)", (x) => (x.f.atrX < 0.8 ? "<0.8 quiet" : x.f.atrX < 1.2 ? "0.8–1.2" : "≥1.2 expanding"));
  bucket("Time of day", (x) => x.f.tb); bucket("Expiry context", (x) => x.f.exp);
  bucket("Follow-through next bar (descriptive, known only after entry)", (x) => (x.ft == null ? "n/a" : x.ft ? "yes" : "no"));
  { P(`\n## Wick-only rejection (WATCH, never shown as confirmed) vs close-through (CONFIRMED) — DEV`); P(line("  close-through (baseline)", S(V("BASE"), "DEV"))); P(line("  wick-only (WATCH)", S(V("W wick-only (WATCH)"), "DEV"))); }
  { const W = dev.filter((x) => x.tr.res === "TP"), L = dev.filter((x) => x.tr.res === "STOP"); const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
    P(`\n## Excursions (ATR): winners MAE median ${f2(q(W.map((x) => x.tr.mae), 0.5))} p90 ${f2(q(W.map((x) => x.tr.mae), 0.9))} · losers MFE median ${f2(q(L.map((x) => x.tr.mfe), 0.5))} p90 ${f2(q(L.map((x) => x.tr.mfe), 0.9))} · stop width median ${f2(q(dev.map((x) => x.tr.stopAtr), 0.5))} ATR`); }

  P(`\n# STEP 3 — ONE-CHANGE ABLATIONS (DEV → VAL; edge = precision − same-stop baseline)`);
  const filt: [string, string, (x: Sig) => boolean][] = [
    ["A1 stable level identity (side frozen pre-break)", "A1 stable side", () => true],
    ["A2 ATR threshold 0.05", "A2 eps 0.05×ATR", () => true], ["A2 ATR threshold 0.1", "A2 eps 0.1×ATR", () => true], ["A2 ATR threshold 0.2", "A2 eps 0.2×ATR", () => true],
    ["A3 prior touches ≥ 1", "BASE", (x) => x.f.touches >= 1], ["A3 prior touches ≥ 2", "BASE", (x) => x.f.touches >= 2],
    ["A4a completed 15m only", "A4a completed 15m", () => true],
    ["A4b completed 15m structure not against", "BASE", (x) => (x.dir > 0 ? x.f.s15 !== "Bearish" : x.f.s15 !== "Bullish")],
    ["A5a option volume ≥ 1.5× pace", "BASE", (x) => x.f.volX != null && x.f.volX >= 1.5], ["A5b ATR expanding ≥ 1.2", "BASE", (x) => x.f.atrX >= 1.2], ["A5c ATR quiet < 0.8", "BASE", (x) => x.f.atrX < 0.8],
    ["A6 premium reaction (my side up, other down)", "BASE", (x) => x.f.premUp],
    ["A7 opposite-side ATM OI writing", "BASE", (x) => x.f.write],
    ["A8 no-trade filter (no expiry day, break < 1 ATR, 09:30–15:00)", "BASE", (x) => x.f.exp !== "EXPIRY day" && x.f.poke < 1 && x.m >= 570 && x.m <= 900],
    ["A9 follow-through entry (post-hoc from Step 2)", "A9 follow-through entry", () => true],
  ];
  const abl: any[] = [];
  const b0 = { DEV: S(V("BASE"), "DEV"), VAL: S(V("BASE"), "VAL") };
  P(line("BASELINE DEV", b0.DEV)); P(line("BASELINE VAL", b0.VAL));
  for (const [lab, vn, fn] of filt) {
    const xs = V(vn).filter(fn), sd = S(xs, "DEV"), sv = S(xs, "VAL");
    const ed = sd.prec - sd.base - (b0.DEV.prec - b0.DEV.base), ev = sv.prec - sv.base - (b0.VAL.prec - b0.VAL.base);
    abl.push({ lab, vn, fn, sd, sv, ed, ev, promising: sd.n >= 100 && ed >= 3 });
    P(`\n${lab}\n  ${line("DEV", sd)}\n  ${line("VAL", sv)}\n  edge change vs baseline: DEV ${ed >= 0 ? "+" : ""}${f1(ed)} pts · VAL ${ev >= 0 ? "+" : ""}${f1(ev)} pts${sd.n >= 100 && ed >= 3 ? "  ← promising on DEV" : ""}`);
  }
  { const oi = V("BASE").filter((x) => x.set !== "TEST"), ok = oi.filter((x) => x.f.oiOk).length; P(`\nOI data reliability (ATM opposite-side OI present at both window ends): ${ok}/${oi.length} signals (${f1((ok / oi.length) * 100)}%)`); }

  P(`\n# STEP 3b — COMBINATIONS OF THE PROMISING CHANGES ONLY (selected on DEV, confirmed on VAL)`);
  const prom = abl.filter((x) => x.promising && x.vn === "BASE");
  const detVar = abl.filter((x) => x.promising && x.vn !== "BASE").sort((a, b) => b.ed - a.ed)[0];
  P(`Promising filters on DEV (n ≥ 100, edge ≥ +3 pts): ${prom.map((x) => x.lab).join(" · ") || "none"}${detVar ? ` · detector variant: ${detVar.lab}` : ""}`);
  const combos: { lab: string; vn: string; fn: (x: Sig) => boolean }[] = [];
  for (const vn of ["BASE", ...(detVar ? [detVar.vn] : [])]) for (let mask = 1; mask < 1 << prom.length; mask++) {
    const fs = prom.filter((_, j) => mask & (1 << j)); combos.push({ lab: `${vn === "BASE" ? "" : detVar.lab + " + "}${fs.map((x) => x.lab.split(" ")[0]).join("+")}`, vn, fn: (x) => fs.every((f) => f.fn(x)) });
  }
  if (detVar) combos.push({ lab: detVar.lab, vn: detVar.vn, fn: () => true });
  const scored = combos.map((c) => { const xs = V(c.vn).filter(c.fn), sd = S(xs, "DEV"), sv = S(xs, "VAL"); return { ...c, sd, sv, eD: sd.prec - sd.base, eV: sv.prec - sv.base }; })
    .filter((c) => c.sd.n >= 100).sort((a, b) => b.eD - a.eD);
  for (const c of scored.slice(0, 12)) P(`  ${c.lab}\n    ${line("DEV", c.sd)}\n    ${line("VAL", c.sv)}`);
  // freeze: the best DEV combination whose VAL edge is positive and VAL n ≥ 50; else the baseline
  const chosen = scored.find((c) => c.sv.n >= 50 && c.eV > 0 && c.sv.avgNet > 0) || null;
  P(`\nFROZEN for the final test: ${chosen ? chosen.lab : "nothing passed DEV → VAL; the baseline is reported on TEST for completeness"}`);

  P(`\n# PRECISION vs COVERAGE (VAL) — can any pre-specified stack reach high precision?`);
  const stack = (x: Sig) => prom.filter((p) => p.fn(x)).length;
  for (let k = 0; k <= prom.length; k++) { const xs = V("BASE").filter((x) => stack(x) >= k); P(line(`  VAL ≥ ${k} promising filters`, S(xs, "VAL"))); }
  const best = [...scored, ...abl.map((a) => ({ lab: a.lab, sv: a.sv }))].filter((c: any) => c.sv.n >= 30).sort((a: any, b: any) => b.sv.prec - a.sv.prec)[0] as any;
  if (best) P(`Highest VAL trade precision among all pre-specified variants with n ≥ 30: ${best.lab} → ${f1(best.sv.prec)}% [${f1(best.sv.ci[0])}–${f1(best.sv.ci[1])}] on n ${best.sv.n} (decided ${f1(best.sv.precDecided)}%), same-stop ${f1(best.sv.base)}%`);

  P(`\n# CALIBRATION of the live confidence score (DEV+VAL, baseline signals)`);
  for (const c of [35, 45, 55, 65, 80, 100]) { const xs = V("BASE").filter((x) => x.set !== "TEST" && x.confidence === c); if (!xs.length) continue; const s = stats(xs, baseIx, 1, 0); P(`  confidence ${String(c).padStart(3)}: n ${String(s.n).padStart(5)} · trade prec ${f1(s.prec)}% [${f1(s.ci[0])}–${f1(s.ci[1])}] · direction ${f1(s.dirPrec)}% · same-stop ${f1(s.base)}%`); }

  P(`\n# STEP 5 — FINAL TEST (untouched by this audit; frozen choice and baseline)`);
  for (const [lab, xs] of [["BASELINE", V("BASE")], ...(chosen ? [[`FROZEN: ${chosen.lab}`, V(chosen.vn).filter(chosen.fn)]] : [])] as [string, Sig[]][]) {
    P(line(`  TEST ${lab}`, S(xs, "TEST")));
    for (const ix of ["NIFTY", "SENSEX"]) P(line(`    ${ix}`, S(xs, "TEST", ix)));
    for (const [rk, vals] of [["vol", ["HIGH-VOL day", "LOW-VOL day"]], ["trend", ["TREND day", "RANGE day"]]] as const)
      for (const v of vals) P(line(`    regime ${v}`, S(xs.filter((x) => x.regime[rk] === v), "TEST")));
  }
  P(`\n# STABILITY by half-year (all periods, baseline${chosen ? " and frozen" : ""})`);
  const halves = [...new Set(allSig.map((x) => x.regime.half))].sort();
  for (const h of halves) { const b = stats(V("BASE").filter((x) => x.regime.half === h), baseIx, 1, 0); const c = chosen ? stats(V(chosen.vn).filter((x) => chosen.fn(x) && x.regime.half === h), baseIx, 1, 0) : null;
    P(`  ${h}: baseline n ${b.n} prec ${f1(b.prec)}% (same-stop ${f1(b.base)}%) net ${f1(b.avgNet)}%${c ? ` | frozen n ${c.n} prec ${f1(c.prec)}% (same-stop ${f1(c.base)}%) net ${f1(c.avgNet)}%` : ""}`); }
  fs.writeFileSync(process.argv[2] || "fake-audit.txt", out.join("\n"));
  process.exit(0);
}
