// ProTrader PHASE 1 (owner's brief, 2026-10-25): exploratory development on the LAST 15 SESSIONS only — preliminary, not
// validated. Research only; nothing live reads this. Usage: npx tsx phase1.ts
//
// Data (confirmed): Dhan 1-min index CLOSE (no 1-min OHLC — 5m candles are built from minute closes, wicks understated);
// ATM±3 option legs with 1-min O/H/L/C, volume, OI, IV (OI updates almost every minute; a strike exists only while inside
// the rolling ±3 band). The app's ±10-strike OI log is complete on only 6 of these sessions, so OI here = the ±3 legs.
//
// Levels (all known BEFORE the candle; no look-ahead): PDH / PDL / PDC · opening range high / low (from 09:30) · owner S/R
// (priceActionLevels: 15m turn clusters / flip zones of the previous 5 sessions) · intraday 5m pivots (high / low above the
// 2 candles each side, confirmed 2 candles later, formed ≥ 30 min before).
// Setups (5-min candle closes, 09:30 … 14:30; first event per level / direction / day):
//   B0  PT: ATM premium EMA 9 × EMA 21 with the index past its EMA 21 (emaCrossStudy) — the current logic
//   H1  S/R rejection: the candle reaches the level (low ≤ S + 0.1 ATR for support), closes back ≥ S, lower wick ≥ 40 % of the
//       range and close in the upper half → CE (mirror at resistance → PE). Index stop: the candle extreme − 0.1 ATR.
//   H2  breakout acceptance: candle i closes > R + 0.1 ATR, candle i+1 closes > R and its low stays > R − 0.1 ATR → CE at
//       i+1 (mirror below support → PE). Index stop: the level − 0.1 ATR.   H2a: the same breakout entered at candle i.
//   H3  H1 / H2 with fresh OPPOSITE writing at the level strike over the last 15 min (support → PE OI ↑ with PE premium ↓;
//       resistance → CE OI ↑ with CE premium ↓) — positioning that defends the level the trade relies on.
//   H4  M0: index close crosses EMA 21 and the trade-side ATM premium close crosses its EMA 21 on the same candle (earlier).
//   H5  the owner's paper rule: fake-up at an owner S/R level + call writing + level touched earlier (fakeMoveGrid).
// Exits (common, so setups compare fairly):
//   X1 option: ATM CE / PE bought at the entry minute; SL = max(₹5, 1 × premium ATR14 of 5m), target = 2 × SL, 60 min;
//      1-min premium high / low; both in one minute = loss; costs max(₹0.5, 0.25 %) per side + ₹40 / lot.
//   X2 index: the setup's own stop; target 2R; 60 min; 1-min closes (time exit marked in R).
//   RANDOM: the same exits from every 5-min close (both directions; X2 stop = the candle extreme) — what any entry gets.
import { assemble, DayData, Min } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { run as emaRun } from "../emaCrossStudy";
import { run as fmRun } from "../fakeMoveGrid";
import { priceActionLevels } from "../priceActionLevels";

const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60), hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const STEP = { NIFTY: 50, SENSEX: 100 } as const, LOT = { NIFTY: 75, SENSEX: 20 } as const, COST = (p: number) => Math.max(0.5, 0.0025 * p);
type Bar = { time: number; open: number; high: number; low: number; close: number };
const barsN = (pts: [number, number][], n: number): Bar[] => { const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of pts) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out; };
const legBars = (ms: Min[]): Bar[] => { const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const m of ms) { const x = mn(m.t); if (x < 555 || x >= 930) continue; const k = Math.floor((x - 555) / 5);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: m.t - (x - 555 - k * 5) * 60, open: m.o, high: m.h, low: m.l, close: m.c }; key = k; }
    else { cur.high = Math.max(cur.high, m.h); cur.low = Math.min(cur.low, m.l); cur.close = m.c; } }
  if (cur) out.push(cur); return out; };
const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
const atrAt = (b: Bar[], i: number, n = 14) => { if (i < n) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].high - b[j].low, Math.abs(b[j].high - b[j - 1].close), Math.abs(b[j].low - b[j - 1].close)); return s / n; };

type Lvl = { p: number; kind: string };
type Trade = { ix: string; setup: string; day: string; t: number; dir: number; lvl?: Lvl; x1: { res: string; net: number; netP: number; mfe: number } | null; x2: { res: string; r: number } | null;
  ctx: { tb: string; atrX: number; flip?: boolean; touches?: number; wick?: number; dist?: number; write?: string; lag?: number } };

export function phase1(ix: "NIFTY" | "SENSEX", days: DayData[]) {
  const ds = days.filter((d) => d.spot.size >= 300), last = ds.slice(-15), step = STEP[ix], trades: Trade[] = [], rnd: Trade[] = [];
  const mins = new Map(ds.map((d) => [d.day, [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]]));
  const all5: Bar[] = []; const dayStart = new Map<string, number>();
  for (const d of ds) { dayStart.set(d.day, all5.length); all5.push(...barsN(mins.get(d.day)!, 5)); }
  const e9 = ema(all5.map((b) => b.close), 9), e21 = ema(all5.map((b) => b.close), 21), atrs = all5.map((_, i) => atrAt(all5, i)), atrMean = (i: number) => { const w = atrs.slice(Math.max(15, i - 100), i + 1).filter((x): x is number => x != null); return w.reduce((a, b) => a + b, 0) / (w.length || 1); };
  const legIx = new Map<string, Map<string, Min[]>>(); for (const d of ds) { const m = new Map<string, Min[]>(); for (const [k, a] of d.legs) m.set(k, [...a].sort((p, q) => p.t - q.t)); legIx.set(d.day, m); }

  // ---------------- exits ----------------
  const x1 = (day: string, t: number, dir: number, spot: number) => {
    const key = `${Math.round(spot / step) * step}${dir > 0 ? "CE" : "PE"}`, leg = legIx.get(day)!.get(key) || [], pre = leg.filter((m) => m.t < t);
    const inM = pre[pre.length - 1]; if (!inM) return null;
    const lb = legBars(pre).filter((b) => b.time + 300 <= t); const tr = lb.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - lb[i].close), Math.abs(b.low - lb[i].close))).slice(-14);
    const patr = tr.length >= 3 ? tr.reduce((a, b) => a + b, 0) / tr.length : 5, sl = Math.max(5, patr), tg = 2 * sl, e = inM.c;
    let res = "TIME", ex = e, exP = e, mfe = 0;
    const path = leg.filter((m) => m.t >= t && m.t < t + 3600 && mn(m.t) <= 925);
    for (const m of path) { mfe = Math.max(mfe, m.h - e); const hs = m.l <= e - sl, ht = m.h >= e + tg;
      if (hs) { res = "SL"; ex = e - sl; exP = Math.min(e - sl, m.c); break; } if (ht) { res = "TARGET"; ex = exP = e + tg; break; } ex = exP = m.c; }
    const f = (x: number) => x - e - COST(e) - COST(x) - 40 / LOT[ix];
    return { res, net: f(ex), netP: f(exP), mfe: mfe / sl };
  };
  const x2 = (day: string, t: number, dir: number, entry: number, stop: number, a: number) => {
    const risk = Math.max(dir * (entry - stop), 0.25 * a), s = entry - dir * risk, tg = entry + dir * 2 * risk;
    const path = mins.get(day)!.filter(([u]) => u >= t && u < t + 3600);
    for (const [, p] of path) { if (dir * (p - s) <= 0) return { res: "SL", r: -1 }; if (dir * (p - tg) >= 0) return { res: "TARGET", r: 2 }; }
    return { res: "TIME", r: path.length ? dir * (path[path.length - 1][1] - entry) / risk : 0 };
  };
  const tbOf = (m: number) => (m < 630 ? "09:30-10:30" : m < 750 ? "10:30-12:30" : "12:30-14:30");
  // OI positioning at a strike over the last 15 minutes: WRITE (OI↑ prem↓) · BUY (OI↑ prem↑) · COVER (OI↓ prem↑) · UNWIND (OI↓ prem↓)
  const oiType = (day: string, strike: number, side: "CE" | "PE", t: number) => {
    const leg = legIx.get(day)!.get(`${strike}${side}`) || [], a = leg.filter((m) => m.t < t - 900).pop(), b = leg.filter((m) => m.t < t).pop();
    if (!a || !b || a.oi == null || b.oi == null || b.t - a.t > 1500) return "n/a";
    const dOi = b.oi - a.oi, dP = b.c - a.c; if (Math.abs(dOi) < 0.005 * a.oi) return "FLAT";
    return dOi > 0 ? (dP < 0 ? "WRITE" : "BUY") : dP > 0 ? "COVER" : "UNWIND";
  };

  // ---------------- levels per day + setups H1 / H2 / H2a / H3 + random ----------------
  for (let di = 0; di < ds.length; di++) {
    const d = ds[di]; if (!last.includes(d)) continue;
    const s0 = dayStart.get(d.day)!, B = barsN(mins.get(d.day)!, 5), prev = ds[di - 1], pm = mins.get(prev.day)!;
    const pdh = Math.max(...pm.map(([, p]) => p)), pdl = Math.min(...pm.map(([, p]) => p)), pdc = pm[pm.length - 1][1];
    const prev15 = ds.slice(Math.max(0, di - 5), di).flatMap((x) => barsN(mins.get(x.day)!, 15)), a15 = atrAt(prev15, prev15.length - 1) || 1;
    const owner = priceActionLevels(prev15 as any, a15).map((l) => ({ p: l.price, kind: "owner S/R" }));
    const orb = B.filter((b) => mn(b.time) < 570), seen = new Set<string>(), ev: Trade[] = [];
    for (let i = 3; i < B.length - 1; i++) {
      const g = s0 + i, c = B[i], tEnd = c.time + 300, m = mn(c.time); const a = atrs[g]; if (!a || m < 570 || m > 865) continue;
      const atrX = a / atrMean(g), tb = tbOf(m);
      // random baseline from every candle
      for (const dir of [1, -1]) rnd.push({ ix, setup: "RANDOM", day: d.day, t: tEnd, dir, x1: x1(d.day, tEnd, dir, c.close), x2: x2(d.day, tEnd, dir, c.close, dir > 0 ? c.low : c.high, a), ctx: { tb, atrX } });
      const piv: Lvl[] = []; for (let j = 2; j <= i - 6; j++) { if (B[j].high > Math.max(B[j - 1].high, B[j - 2].high, B[j + 1].high, B[j + 2].high)) piv.push({ p: B[j].high, kind: "intraday pivot" }); if (B[j].low < Math.min(B[j - 1].low, B[j - 2].low, B[j + 1].low, B[j + 2].low)) piv.push({ p: B[j].low, kind: "intraday pivot" }); }
      const lv: Lvl[] = [{ p: pdh, kind: "PDH" }, { p: pdl, kind: "PDL" }, { p: pdc, kind: "PDC" }, ...(m >= 570 && orb.length ? [{ p: Math.max(...orb.map((b) => b.high)), kind: "ORB high" }, { p: Math.min(...orb.map((b) => b.low)), kind: "ORB low" }] : []), ...owner, ...piv];
      const touchesBefore = (L: number) => { let n = 0, inside = false; for (const [u, p] of mins.get(d.day)!) { if (u >= c.time) break; const near = Math.abs(p - L) <= 0.15 * a; if (near && !inside) n++; inside = near; } return n; };
      const rng = c.high - c.low || 1e-9;
      for (const L of lv) {
        // H1 rejection at support (CE) / resistance (PE): price came from the level's side (previous close on the safe side)
        if (B[i - 1].close > L.p && c.low <= L.p + 0.1 * a && c.close >= L.p && (Math.min(c.open, c.close) - c.low) / rng >= 0.4 && (c.close - c.low) / rng >= 0.5) ev.push(mk("H1", 1, L, c.low - 0.1 * a));
        if (B[i - 1].close < L.p && c.high >= L.p - 0.1 * a && c.close <= L.p && (c.high - Math.max(c.open, c.close)) / rng >= 0.4 && (c.high - c.close) / rng >= 0.5) ev.push(mk("H1", -1, L, c.high + 0.1 * a));
        // H2a / H2: breakout of resistance (CE) / breakdown of support (PE); H2 needs the NEXT candle to accept (entered at i+1)
        if (B[i - 1].close <= L.p && c.close > L.p + 0.1 * a) { ev.push(mk("H2a", 1, L, L.p - 0.1 * a)); const n = B[i + 1]; if (n && n.close > L.p && n.low > L.p - 0.1 * a) ev.push(mk("H2", 1, L, L.p - 0.1 * a, 1)); }
        if (B[i - 1].close >= L.p && c.close < L.p - 0.1 * a) { ev.push(mk("H2a", -1, L, L.p + 0.1 * a)); const n = B[i + 1]; if (n && n.close < L.p && n.high < L.p + 0.1 * a) ev.push(mk("H2", -1, L, L.p + 0.1 * a, 1)); }
      }
      function mk(setup: string, dir: number, L: Lvl, stop: number, shift = 0): Trade {
        const cc = B[i + shift], t = cc.time + 300, entry = cc.close;
        const strike = dir > 0 ? Math.floor(L.p / step) * step : Math.ceil(L.p / step) * step, write = setup.startsWith("H1") ? oiType(d.day, strike, dir > 0 ? "PE" : "CE", t) : oiType(d.day, strike, dir > 0 ? "PE" : "CE", t);
        return { ix, setup, day: d.day, t, dir, lvl: L, x1: x1(d.day, t, dir, entry), x2: x2(d.day, t, dir, entry, stop, a!), ctx: { tb, atrX, touches: touchesBefore(L.p), wick: dir > 0 ? (Math.min(c.open, c.close) - c.low) / rng : (c.high - Math.max(c.open, c.close)) / rng, dist: Math.abs(entry - L.p) / a!, write } };
      }
    }
    for (const e of ev) { const k = `${e.setup}|${e.dir}|${Math.round(e.lvl!.p)}`; if (seen.has(k)) continue; seen.add(k); trades.push(e); }
  }
  // H3 = H1 / H2 with fresh opposite writing at the level strike
  for (const tr of trades.filter((x) => (x.setup === "H1" || x.setup === "H2") && x.ctx.write === "WRITE")) trades.push({ ...tr, setup: tr.setup + "+OI" });

  // ---------------- B0 (PT) and H4 (M0) from emaCrossStudy; H5 from fakeMoveGrid ----------------
  const lastDays = new Set(last.map((d) => d.day));
  for (const x of emaRun(ix, ds as any).sigs) {
    if (!lastDays.has(x.day) || !(x.pt || x.m0)) continue;
    const g = (() => { const s0 = dayStart.get(x.day)!; let k = s0; while (k + 1 < all5.length && all5[k + 1].time + 300 <= x.t) k++; return k; })(), a = atrs[g] || 1, c = all5[g];
    // lag: how far the index already moved from the last hour's extreme, in ATR
    const w = all5.slice(Math.max(0, g - 11), g + 1), lag = x.dir > 0 ? (c.close - Math.min(...w.map((b) => b.low))) / a : (Math.max(...w.map((b) => b.high)) - c.close) / a;
    for (const [setup, on] of [["B0 PT", x.pt], ["H4 M0", x.m0]] as const) if (on) trades.push({ ix, setup, day: x.day, t: x.t, dir: x.dir, x1: x1(x.day, x.t, x.dir, c.close), x2: x2(x.day, x.t, x.dir, c.close, x.dir > 0 ? c.low : c.high, a), ctx: { tb: tbOf(mn(x.t - 300)), atrX: (atrs[g] || 1) / atrMean(g), lag } });
  }
  for (const e of fmRun(ds as any, 5, step).ev) {
    if (!lastDays.has(e.day) || e.src !== "OWNER" || e.dir !== -1 || !e.f.write || !e.f.retest) continue;
    const g = (() => { const s0 = dayStart.get(e.day)!; let k = s0; while (k + 1 < all5.length && all5[k + 1].time + 300 <= e.t) k++; return k; })(), a = atrs[g] || 1;
    trades.push({ ix, setup: "H5 fake-up+OI", day: e.day, t: e.t, dir: -1, x1: x1(e.day, e.t, -1, e.px), x2: x2(e.day, e.t, -1, e.px, e.stop, a), ctx: { tb: tbOf(mn(e.t - 300)), atrX: a / atrMean(g) } });
  }
  // flips (an opposite signal of the same setup within 60 min before)
  for (const x of trades) x.ctx.flip = trades.some((y) => y.setup === x.setup && y.day === x.day && y.dir !== x.dir && y.t < x.t && x.t - y.t <= 3600);
  return { trades, rnd, days: last.map((d) => d.day) };
}

const fmt = (xs: Trade[]) => {
  const o1 = xs.map((x) => x.x1).filter(Boolean) as NonNullable<Trade["x1"]>[], o2 = xs.map((x) => x.x2).filter(Boolean) as NonNullable<Trade["x2"]>[];
  if (!xs.length) return "n 0";
  const w1 = o1.filter((o) => o.res === "TARGET").length, s1 = o1.filter((o) => o.res === "SL").length, w2 = o2.filter((o) => o.res === "TARGET").length;
  return `n ${String(xs.length).padStart(3)} | OPTION X1: target ${((w1 / o1.length) * 100).toFixed(0).padStart(3)}% · SL ${((s1 / o1.length) * 100).toFixed(0).padStart(3)}% · net ₹${(o1.reduce((a, o) => a + o.net, 0) / o1.length).toFixed(2).padStart(6)} / ₹${(o1.reduce((a, o) => a + o.netP, 0) / o1.length).toFixed(2).padStart(6)} pess | INDEX X2: 2R ${((w2 / o2.length) * 100).toFixed(0).padStart(3)}% · avg ${(o2.reduce((a, o) => a + o.r, 0) / o2.length).toFixed(2).padStart(5)}R`;
};

if (require.main === module) {
  const R = { NIFTY: phase1("NIFTY", assemble("2026-08-01", "2026-10-23").days), SENSEX: phase1("SENSEX", assembleIndex("SENSEX", "2026-08-01", "2026-10-23")) };
  console.log(`PHASE 1 · last 15 sessions ${R.NIFTY.days[0]} → ${R.NIFTY.days[14]} · PRELIMINARY (exploratory, not validated)`);
  const setups = ["RANDOM", "B0 PT", "H4 M0", "H1", "H1+OI", "H2a", "H2", "H2+OI", "H5 fake-up+OI"];
  for (const ix of ["NIFTY", "SENSEX"] as const) {
    console.log(`\n${ix}`);
    for (const s of setups) console.log(`  ${s.padEnd(16)} ${fmt(s === "RANDOM" ? R[ix].rnd : R[ix].trades.filter((x) => x.setup === s))}`);
  }
  const both = [...R.NIFTY.trades, ...R.SENSEX.trades], bothR = [...R.NIFTY.rnd, ...R.SENSEX.rnd];
  console.log(`\nBOTH INDICES`); for (const s of setups) console.log(`  ${s.padEnd(16)} ${fmt(s === "RANDOM" ? bothR : both.filter((x) => x.setup === s))}`);
  // ---- diagnostics: when do the setups work / fail (both indices) ----
  const by = (lab: string, xs: Trade[], key: (x: Trade) => string) => { console.log(`\n  ${lab}`); const g = new Map<string, Trade[]>(); for (const x of xs) { const k = key(x); (g.get(k) || g.set(k, []).get(k)!).push(x); } for (const [k, v] of [...g.entries()].sort()) console.log(`    ${k.padEnd(26)} ${fmt(v)}`); };
  const pt = both.filter((x) => x.setup === "B0 PT"), h1 = both.filter((x) => x.setup === "H1"), h2 = both.filter((x) => x.setup === "H2");
  console.log(`\nWHY / WHEN — B0 PT (current logic)`);
  by("lag: index move already made from the last hour's extreme (ATR)", pt, (x) => (x.ctx.lag! < 1 ? "<1 ATR (early)" : x.ctx.lag! < 2 ? "1–2 ATR" : "≥2 ATR (late)"));
  by("time of day", pt, (x) => x.ctx.tb); by("ATR vs normal", pt, (x) => (x.ctx.atrX >= 1.2 ? "ATR ≥1.2× (hot)" : "ATR <1.2×")); by("opposite signal in last 60 min", pt, (x) => (x.ctx.flip ? "after a flip" : "no flip"));
  console.log(`\nWHY / WHEN — H1 S/R rejection`);
  by("level type", h1, (x) => x.lvl!.kind); by("touches of the level earlier today", h1, (x) => (x.ctx.touches! >= 2 ? "2+" : String(x.ctx.touches))); by("entry distance from level (ATR)", h1, (x) => (x.ctx.dist! < 0.5 ? "<0.5 ATR" : x.ctx.dist! < 1 ? "0.5–1 ATR" : "≥1 ATR"));
  by("rejection wick", h1, (x) => (x.ctx.wick! >= 0.6 ? "wick ≥60%" : "wick 40–60%")); by("OI at the level strike (opposite side)", h1, (x) => x.ctx.write!); by("ATR vs normal", h1, (x) => (x.ctx.atrX >= 1.2 ? "ATR ≥1.2× (hot)" : "ATR <1.2×")); by("time of day", h1, (x) => x.ctx.tb);
  console.log(`\nWHY / WHEN — H2 breakout acceptance`);
  by("level type", h2, (x) => x.lvl!.kind); by("OI at the level strike (opposite side)", h2, (x) => x.ctx.write!); by("ATR vs normal", h2, (x) => (x.ctx.atrX >= 1.2 ? "ATR ≥1.2× (hot)" : "ATR <1.2×"));
  // ---- a few combinations, each justified by the diagnostics above (chosen AFTER seeing these 15 sessions → hypotheses only) ----
  const major = (x: Trade) => x.lvl != null && x.lvl.kind !== "intraday pivot", morning = (x: Trade) => x.ctx.tb !== "12:30-14:30";
  const C: [string, (x: Trade) => boolean][] = [
    ["C1 rejection · major level · wick ≥60% · before 12:30", (x) => x.setup === "H1" && major(x) && x.ctx.wick! >= 0.6 && morning(x)],
    ["C2 acceptance · major level · no unwind/cover/buy", (x) => x.setup === "H2" && major(x) && (x.ctx.write === "WRITE" || x.ctx.write === "FLAT")],
    ["C3 PT · before 12:30 · no flip", (x) => x.setup === "B0 PT" && morning(x) && !x.ctx.flip],
    ["C4 = H5 fake-up + call writing (paper rule)", (x) => x.setup === "H5 fake-up+OI"]];
  // one trade per index / entry time / direction (an entry on several levels at once counts once)
  const uniq = (xs: Trade[]) => { const m = new Map<string, Trade>(); for (const x of xs) { const k = `${x.ix}|${x.t}|${x.dir}`; if (!m.has(k)) m.set(k, x); } return [...m.values()]; };
  console.log(`\nUNIQUE ENTRIES (each index / time / direction once)`);
  for (const s2 of ["H1", "H1+OI", "H2a", "H2", "H2+OI"]) console.log(`  ${s2.padEnd(16)} ${fmt(uniq(both.filter((x) => x.setup === s2)))}`);
  console.log(`\nCOMBINATIONS (hypotheses for phase 2)`);
  for (const [lab, f] of C) { console.log(`  ${lab}`); for (const ix of ["NIFTY", "SENSEX"] as const) console.log(`    ${ix.padEnd(6)} ${fmt(uniq(R[ix].trades.filter(f)))}`); console.log(`    BOTH   ${fmt(uniq(both.filter(f)))}`); }
  console.log(`  RANDOM before 12:30 (reference)\n    BOTH   ${fmt(bothR.filter((x) => x.ctx.tb !== "12:30-14:30"))}`);
  // per-trade list of the combinations for manual review
  console.log(`\nTRADES OF C1 / C2 / C3 / C4 (for review on the replay screen)`);
  for (const [lab, f] of C) { console.log(`  ${lab}`); for (const x of uniq(both.filter(f)).sort((p, q) => (p.day + p.t).localeCompare(q.day + q.t))) console.log(`    ${x.ix.padEnd(6)} ${x.day} entry ${new Date((x.t + 19800) * 1000).toISOString().slice(11, 16)} ${x.dir > 0 ? "CE" : "PE"}${x.lvl ? ` · ${x.lvl.kind} ${Math.round(x.lvl.p)}` : ""} · option ${x.x1?.res ?? "—"} ${x.x1 ? (x.x1.netP >= 0 ? "+" : "") + x.x1.netP.toFixed(1) : ""} · index ${x.x2?.res} ${x.x2?.r.toFixed(2)}R`); }
  process.exit(0);
}
