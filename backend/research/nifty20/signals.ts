import { istHm, type DayData, type Side } from "./data";
import type { Signal } from "./sim";

// ============================ Strategy families (research) ============================
// Everything is computed from data available at the signal time: completed 5-minute spot bars (built from 1-minute spot),
// 15-minute regime from completed 15-minute bars, OI = last value reported at or before the signal minute (exchange OI
// refreshes every ~2–3 minutes). Walls are the largest-OI strikes inside the ATM±3 window only (wider strikes are not in
// the historical data). Index VWAP is not available (the index has no volume); option volume is used where noted.

export interface Bar5 { t: number; day: string; o: number; h: number; l: number; c: number }
export interface Flags {
  oiCover: boolean;     // A: holder side's OI falling (writers covering) at the broken wall
  candle: boolean;      // completed 5-minute candle in the trade direction
  regime15: boolean;    // 15-minute regime agrees (or at least not opposite)
  optVolume: boolean;   // ATM option volume above the session's median 5-minute volume
  noFailedBreak: boolean; // A: skip if the same wall was broken and reclaimed in the last 30 min (whipsaw)
}
export const ALL_ON: Flags = { oiCover: true, candle: true, regime15: true, optVolume: false, noFailedBreak: true };

const ema = (vals: number[], p: number) => { const k = 2 / (p + 1); const out: number[] = []; let e = vals[0]; vals.forEach((v, i) => { e = i ? v * k + e * (1 - k) : v; out.push(e); }); return out; };

/** 5- and 15-minute spot bars from 1-minute spot closes, across all days (t = last minute of the bar = completion). */
export function buildBars(days: DayData[], mins: number): Bar5[] {
  const out: Bar5[] = [];
  for (const d of days) {
    const pts = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => istHm(t) >= "09:15" && istHm(t) <= "15:29");
    let cur: Bar5 | null = null, key = -1;
    for (const [t, s] of pts) {
      const m = (() => { const [h, mm] = istHm(t).split(":").map(Number); return h * 60 + mm - (9 * 60 + 15); })();
      const k = Math.floor(m / mins);
      if (k !== key) { if (cur) out.push(cur); cur = { t, day: d.day, o: s, h: s, l: s, c: s }; key = k; }
      else { cur!.t = t; cur!.h = Math.max(cur!.h, s); cur!.l = Math.min(cur!.l, s); cur!.c = s; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** OI of a strike/side at or before time t (last reported). */
export function oiAt(d: DayData, strike: number, side: Side, t: number): number | null {
  const a = d.legs.get(`${strike}${side}`); if (!a) return null;
  let v: number | null = null; for (const m of a) { if (m.t > t) break; if (m.oi != null && m.oi > 0) v = m.oi; } return v;
}
function strikesAt(d: DayData, side: Side, t: number): number[] {
  const out: number[] = [];
  for (const [k, a] of d.legs) if (k.endsWith(side) && a.some((m) => m.t <= t && m.t > t - 300)) out.push(Number(k.slice(0, -2)));
  return out.sort((x, y) => x - y);
}
/** Put wall below spot / call wall above spot inside the visible ATM±3 window, as of time t. */
export function walls(d: DayData, spot: number, t: number) {
  const pick = (side: Side, below: boolean) => {
    let best: { strike: number; oi: number } | null = null;
    for (const k of strikesAt(d, side, t)) { if (below ? k > spot : k < spot) continue; const oi = oiAt(d, k, side, t); if (oi != null && (!best || oi > best.oi)) best = { strike: k, oi }; }
    return best;
  };
  return { put: pick("PE", true), call: pick("CE", false) };
}
function noise1(d: DayData, t: number): number {
  const pts = [...d.spot.entries()].filter(([x]) => x <= t && x > t - 15 * 60).sort((a, b) => a[0] - b[0]);
  const diffs = pts.slice(1).map(([, s], i) => Math.abs(s - pts[i][1])).sort((a, b) => a - b);
  return diffs.length >= 5 ? diffs[Math.floor(diffs.length / 2)] : 0;
}
function atmStrike(d: DayData, spot: number, side: Side, t: number): number | null {
  const ks = strikesAt(d, side, t); if (!ks.length) return null;
  return ks.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), ks[0]);
}
function optVol5(d: DayData, strike: number, side: Side, t: number): number { const a = d.legs.get(`${strike}${side}`) || []; return a.filter((m) => m.t <= t && m.t > t - 300).reduce((s, m) => s + (m.v || 0), 0); }

export interface Ctx { days: DayData[]; byDay: Map<string, DayData>; b5: Bar5[]; b15: Bar5[]; e9: number[]; e21: number[]; atr: number[]; e20_15: number[] }
export function context(days: DayData[]): Ctx {
  const b5 = buildBars(days, 5), b15 = buildBars(days, 15), c5 = b5.map((b) => b.c);
  const tr = b5.map((b, i) => (i && b5[i - 1].day === b.day ? Math.max(b.h - b.l, Math.abs(b.h - b5[i - 1].c), Math.abs(b.l - b5[i - 1].c)) : b.h - b.l));
  return { days, byDay: new Map(days.map((d) => [d.day, d])), b5, b15, e9: ema(c5, 9), e21: ema(c5, 21), atr: ema(tr, 14), e20_15: ema(b15.map((b) => b.c), 20) };
}
/** 15-minute regime from COMPLETED 15-minute bars only (the bar containing t is excluded). */
function regime15(c: Ctx, t: number): "UP" | "DOWN" | "FLAT" {
  let i = -1; for (let k = c.b15.length - 1; k >= 0; k--) if (c.b15[k].t <= t - 60 * 0 && c.b15[k].t < t) { i = k; break; }
  if (i < 3) return "FLAT";
  const up = c.e20_15[i] > c.e20_15[i - 3] && c.b15[i].c > c.e20_15[i], dn = c.e20_15[i] < c.e20_15[i - 3] && c.b15[i].c < c.e20_15[i];
  return up ? "UP" : dn ? "DOWN" : "FLAT";
}

const inWindow = (t: number) => { const hm = istHm(t); return hm >= "09:30" && hm <= "14:30"; };

/** All signals of one family for one day (timestamps = completed 5-minute bar). */
export function familySignals(c: Ctx, day: string, family: string, f: Flags = ALL_ON): Signal[] {
  const d = c.byDay.get(day); if (!d) return [];
  const idx = c.b5.map((b, i) => [b, i] as const).filter(([b]) => b.day === day);
  const out: Signal[] = [];
  const firstIdx = idx.length ? idx[0][1] : 0;
  const or = idx.filter(([b]) => istHm(b.t) < "09:30").map(([b]) => b);
  const orH = or.length ? Math.max(...or.map((b) => b.h)) : null, orL = or.length ? Math.min(...or.map((b) => b.l)) : null;
  const medVol = (side: Side, strike: number, t: number) => { const vs: number[] = []; for (let x = t - 300; x > t - 6 * 3600 && istHm(x) >= "09:20"; x -= 300) vs.push(optVol5(d, strike, side, x)); vs.sort((a, b) => a - b); return vs.length >= 3 ? vs[Math.floor(vs.length / 2)] : null; };
  for (const [b, i] of idx) {
    if (!inWindow(b.t) || i - firstIdx < 3) continue;
    const prev = c.b5[i - 1], spot = b.c, nz = noise1(d, b.t), rg = regime15(c, b.t);
    const bull = b.c > b.o, bear = b.c < b.o;
    const go = (side: Side, note: string) => {
      if (f.regime15 && ((side === "CE" && rg === "DOWN") || (side === "PE" && rg === "UP"))) return;
      if (f.candle && ((side === "CE" && !bull) || (side === "PE" && !bear))) return;
      const k = atmStrike(d, spot, side, b.t); if (k == null) return;
      if (f.optVolume) { const m = medVol(side, k, b.t); if (m == null || optVol5(d, k, side, b.t) < 1.3 * m) return; }
      out.push({ t: b.t, side, strike: k, family, note });
    };
    if (family === "BASE") {
      if (orH == null || orL == null) continue;
      if (b.c > orH && c.e9[i] > c.e21[i]) go("CE", `ORB up ${orH.toFixed(0)}`);
      else if (b.c < orL && c.e9[i] < c.e21[i]) go("PE", `ORB down ${orL.toFixed(0)}`);
      continue;
    }
    const w = walls(d, prev.c, prev.t);                                   // walls as known BEFORE this bar
    if (family === "A") {
      if (w.put && prev.c >= w.put.strike - nz && b.c < w.put.strike - nz) {
        const ch = (oiAt(d, w.put.strike, "PE", b.t) ?? 0) - (oiAt(d, w.put.strike, "PE", b.t - 900) ?? 0);
        const reclaimed = c.b5.slice(Math.max(firstIdx, i - 6), i).some((x) => x.c < w.put!.strike - nz);
        if ((!f.oiCover || ch < 0) && (!f.noFailedBreak || !reclaimed)) go("PE", `put wall ${w.put.strike} broken, PE OI ${ch}`);
      }
      if (w.call && prev.c <= w.call.strike + nz && b.c > w.call.strike + nz) {
        const ch = (oiAt(d, w.call.strike, "CE", b.t) ?? 0) - (oiAt(d, w.call.strike, "CE", b.t - 900) ?? 0);
        const reclaimed = c.b5.slice(Math.max(firstIdx, i - 6), i).some((x) => x.c > w.call!.strike + nz);
        if ((!f.oiCover || ch < 0) && (!f.noFailedBreak || !reclaimed)) go("CE", `call wall ${w.call.strike} broken, CE OI ${ch}`);
      }
    } else if (family === "B") {
      const recent = c.b5.slice(Math.max(firstIdx, i - 3), i);
      const wp = walls(d, c.b5[Math.max(firstIdx, i - 4)].c, c.b5[Math.max(firstIdx, i - 4)].t);   // wall before the break
      if (wp.put && recent.some((x) => x.c < wp.put!.strike - nz) && b.c > wp.put.strike) go("CE", `failed breakdown of ${wp.put.strike}`);
      if (wp.call && recent.some((x) => x.c > wp.call!.strike + nz) && b.c < wp.call.strike) go("PE", `failed breakout of ${wp.call.strike}`);
    } else if (family === "C") {
      const last6 = c.b5.slice(Math.max(firstIdx, i - 6), i);
      if (w.put) {
        const tests = last6.filter((x) => x.l <= w.put!.strike + nz).length, held = last6.every((x) => x.c >= w.put!.strike - nz);
        const add = (oiAt(d, w.put.strike, "PE", b.t) ?? 0) - (oiAt(d, w.put.strike, "PE", b.t - 900) ?? 0);
        if (tests >= 2 && held && add > 0 && b.c > prev.h) go("CE", `put wall ${w.put.strike} absorbed (${tests} tests, PE OI +${add})`);
      }
      if (w.call) {
        const tests = last6.filter((x) => x.h >= w.call!.strike - nz).length, held = last6.every((x) => x.c <= w.call!.strike + nz);
        const add = (oiAt(d, w.call.strike, "CE", b.t) ?? 0) - (oiAt(d, w.call.strike, "CE", b.t - 900) ?? 0);
        if (tests >= 2 && held && add > 0 && b.c < prev.l) go("PE", `call wall ${w.call.strike} absorbed (${tests} tests, CE OI +${add})`);
      }
    } else if (family === "D") {
      const ext = Math.abs(b.c - c.e21[i]) < 1.5 * c.atr[i];
      if (rg === "UP" && prev.l <= c.e9[i - 1] && b.c > prev.h && ext) go("CE", "15m up, 5m pullback to EMA9, resumed");
      if (rg === "DOWN" && prev.h >= c.e9[i - 1] && b.c < prev.l && ext) go("PE", "15m down, 5m pullback to EMA9, resumed");
    } else if (family === "E") {
      const w6 = c.b5.slice(i - 6, i); if (w6.length < 6 || w6.some((x) => x.day !== day)) continue;
      const hi6 = Math.max(...w6.map((x) => x.h)), lo6 = Math.min(...w6.map((x) => x.l));
      const hist: number[] = []; for (let k = i - 7; k >= Math.max(5, i - 6 * 75 * 5); k -= 6) { const z = c.b5.slice(k - 5, k + 1); if (z.length === 6 && z.every((x) => x.day === z[0].day)) hist.push(Math.max(...z.map((x) => x.h)) - Math.min(...z.map((x) => x.l))); }
      hist.sort((a, b2) => a - b2); const med = hist.length >= 20 ? hist[Math.floor(hist.length / 2)] : null;
      if (med == null || hi6 - lo6 >= 0.6 * med || b.h - b.l <= 1.5 * c.atr[i - 1]) continue;
      if (b.c > hi6) go("CE", "compression then expansion up");
      else if (b.c < lo6) go("PE", "compression then expansion down");
    }
  }
  return out;
}
