// ============================ 🗺️ Scenario Map — historical probabilities (owner, 2026-10-28) ============================
// "If the market drops, which level holds, where can it recover, where do I take the trade for 40 points; the same going up;
// liquidity-sweep chance; gap down / up 50–100." This file measures those odds on real 1-min index data (research script
// research/protrader/scenarioStudy.ts writes scenario-stats.json). Pure functions, no look-ahead: every level comes from
// the sessions BEFORE the day being measured. Points are NIFTY points; SENSEX uses the same rules × SCALE.
// Trades: fixed 1:2 — target 40, stop 20 (index points), one full exit, 15:12 time exit, no entry after 14:45.
// Advisory only. These are odds of the past, not a new co-pilot rule (the co-pilot / One Trade signal is unchanged).

export type Mins = [number, number][];          // [unix sec, index price] for 09:15–15:29
export interface Sess { day: string; m: Mins }
export interface TradeStat { n: number; win: number; loss: number; time: number; winPct: number; avgPts: number }
export interface LevelStat { n: number; holdPct: number; breakPct: number; sweepPct: number; recoverPct: number; chopPct: number; defend: TradeStat; breakTrade: TradeStat }
export interface GapStat { n: number; sharePct: number; fillPct: number; fillBy1015Pct: number; contPct: number; closeGapDirPct: number; medOr15: number;
  orLowSweepPct: number; orHighSweepPct: number; orLowSweepLong: TradeStat; orHighSweepShort: TradeStat; orBreakUpLong: TradeStat; orBreakDownShort: TradeStat }
export interface IndexStats { scale: number; sessions: number; from: string; to: string; medRange: number; gaps: Record<GapKey, GapStat>; levels: Record<string, LevelStat> }
export type GapKey = "BIG_DOWN" | "DOWN" | "FLAT" | "UP" | "BIG_UP";

export const SCALE: Record<string, number> = { NIFTY: 1, SENSEX: 3.25 };
export const RULES = { target: 40, stop: 20, near: 3, buf: 5, sweep: 7, lastEntry: 885, lastTouch: 870, exit: 912 };
const IST = 19800;
export const mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function gapKey(g: number): GapKey { return g < -100 ? "BIG_DOWN" : g < -50 ? "DOWN" : g <= 50 ? "FLAT" : g <= 100 ? "UP" : "BIG_UP"; }

/** Bar-close flags: minute i closes its 5 / 15-min bar when the next minute is in another bucket (or is the last minute). */
function closes(m: Mins, step: number) { return m.map((x, i) => i === m.length - 1 || Math.floor((mn(m[i + 1][0]) - 555) / step) !== Math.floor((mn(x[0]) - 555) / step)); }

/** Simulate one 1:2 trade from minute i (entry at that minute's price) in direction dir. */
export function sim(m: Mins, i: number, dir: 1 | -1, k: number): { res: "WIN" | "LOSS" | "TIME"; pts: number } {
  const e = m[i][1], tg = RULES.target * k, sl = RULES.stop * k;
  for (let j = i + 1; j < m.length; j++) {
    const v = dir * (m[j][1] - e);
    if (v >= tg) return { res: "WIN", pts: RULES.target };
    if (v <= -sl) return { res: "LOSS", pts: -RULES.stop };
    if (mn(m[j][0]) >= RULES.exit) return { res: "TIME", pts: v / k };
  }
  return { res: "TIME", pts: (dir * (m[m.length - 1][1] - e)) / k };
}
type Acc = { n: number; win: number; loss: number; time: number; pts: number };
const acc = (): Acc => ({ n: 0, win: 0, loss: 0, time: 0, pts: 0 });
const add = (a: Acc, r: ReturnType<typeof sim>) => { a.n++; a.pts += r.pts; if (r.res === "WIN") a.win++; else if (r.res === "LOSS") a.loss++; else a.time++; };
const fin = (a: Acc): TradeStat => ({ n: a.n, win: a.win, loss: a.loss, time: a.time, winPct: pct(a.win, a.n), avgPts: a.n ? Math.round((a.pts / a.n) * 10) / 10 : 0 });

export type LevelOutcome = { hold: boolean; brk: boolean; sweep: boolean; recover: boolean; defend: ReturnType<typeof sim> | null; breakTrade: ReturnType<typeof sim> | null };
/** First touch of level L in a session. dir = +1 support (price above, defended upward), −1 resistance. null = no touch. */
export function levelTest(m: Mins, L: number, dir: 1 | -1, k: number): LevelOutcome | null {
  const c15 = closes(m, 15), c5 = closes(m, 5), near = RULES.near * k, buf = RULES.buf * k, T = RULES.target * k, sw = RULES.sweep * k;
  const i0 = m.findIndex((x) => mn(x[0]) <= RULES.lastTouch && dir * (x[1] - L) <= near);
  if (i0 < 0) return null;
  let ib = -1, hold = false, pierce = 0, pierceBeforeHold = 0, defendAt = -1, pierced = false;
  for (let j = i0; j < m.length; j++) {
    const v = dir * (m[j][1] - L);
    pierce = Math.min(pierce, v);
    if (v < -buf) pierced = true;
    if (!hold && ib < 0 && v >= T) { hold = true; pierceBeforeHold = pierce; }
    if (defendAt < 0 && pierced && ib < 0 && c5[j] && v > 0 && mn(m[j][0]) <= RULES.lastEntry) defendAt = j;
    if (ib < 0 && !hold && c15[j] && v < -buf) ib = j;
  }
  let brk = false, recover = false;
  if (ib >= 0) for (let j = ib + 1; j < m.length; j++) { const v = dir * (m[j][1] - L); if (v <= -T) brk = true; if (c15[j] && v > buf) recover = true; }
  return { hold, brk, sweep: hold && pierceBeforeHold <= -sw, recover: ib >= 0 && recover,
    defend: defendAt >= 0 ? sim(m, defendAt, dir, k) : null, breakTrade: ib >= 0 && mn(m[ib][0]) <= RULES.lastEntry ? sim(m, ib, (-dir) as 1 | -1, k) : null };
}

/** Levels known before session i: previous day H/L/C, 5-session H/L, nearest round strike above / below the open. */
export function levelsBefore(ss: Sess[], i: number, k: number) {
  const p = ss[i - 1].m.map((x) => x[1]), w = ss.slice(Math.max(0, i - 5), i).flatMap((s) => s.m.map((x) => x[1])), open = ss[i].m[0][1], R = (k > 1 ? 500 : 100);
  return { PDH: Math.max(...p), PDL: Math.min(...p), PDC: p[p.length - 1], WH: Math.max(...w), WL: Math.min(...w),
    RND_UP: Math.ceil((open + 30 * k) / R) * R, RND_DN: Math.floor((open - 30 * k) / R) * R };
}

export function computeStats(ss: Sess[], k: number): IndexStats {
  const L: Record<string, { n: number; hold: number; brk: number; sweep: number; rec: number; chop: number; d: Acc; b: Acc }> = {};
  const G: Record<string, any> = {}, ranges: number[] = [];
  for (let i = 5; i < ss.length; i++) {
    const m = ss[i].m; if (m.length < 300) continue;
    const lv = levelsBefore(ss, i, k), open = m[0][1], g = (open - lv.PDC) / k, gk = gapKey(g);
    ranges.push((Math.max(...m.map((x) => x[1])) - Math.min(...m.map((x) => x[1]))) / k);
    for (const [name, v] of Object.entries(lv)) {
      if (Math.abs(open - v) < RULES.buf * k) continue;
      const dir: 1 | -1 = open > v ? 1 : -1, key = `${name}:${dir > 0 ? "S" : "R"}`, o = levelTest(m, v, dir, k);
      if (!o) continue;
      const a = (L[key] ||= { n: 0, hold: 0, brk: 0, sweep: 0, rec: 0, chop: 0, d: acc(), b: acc() });
      a.n++; if (o.hold) a.hold++; if (o.brk) a.brk++; if (o.sweep) a.sweep++; if (o.recover) a.rec++; if (!o.hold && !o.brk) a.chop++;
      if (o.defend) add(a.d, o.defend); if (o.breakTrade) add(a.b, o.breakTrade);
    }
    // the gap day: fill, continuation, the opening-range sweep / break trades
    const s = (G[gk] ||= { n: 0, fill: 0, fill1015: 0, cont: 0, closeDir: 0, or: [] as number[], lowSw: 0, highSw: 0, lsl: acc(), hss: acc(), bul: acc(), bds: acc() });
    s.n++;
    const gd = Math.sign(g) || 1, iFill = m.findIndex((x) => (gd > 0 ? x[1] <= lv.PDC : x[1] >= lv.PDC));
    if (Math.abs(g) >= 15 && iFill >= 0) { s.fill++; if (mn(m[iFill][0]) <= 615) s.fill1015++; }
    const iCont = m.findIndex((x) => gd * (x[1] - open) >= RULES.target * k);
    if (iCont >= 0 && (iFill < 0 || iCont < iFill)) s.cont++;
    if (gd * (m[m.length - 1][1] - open) > 0) s.closeDir++;
    const orM = m.filter((x) => mn(x[0]) < 570); if (orM.length < 5) continue;
    const oh = Math.max(...orM.map((x) => x[1])), ol = Math.min(...orM.map((x) => x[1])); s.or.push((oh - ol) / k);
    const c5 = closes(m, 5), c15 = closes(m, 15), buf = RULES.buf * k, from = m.findIndex((x) => mn(x[0]) >= 570);
    const sweepTrade = (side: 1 | -1) => {   // side 1: sweep of the OR low then a 5-min close back above it → long
      const lvl = side > 0 ? ol : oh; let pierceAt = -1;
      for (let j = from; j >= 0 && j < m.length && mn(m[j][0]) <= RULES.lastEntry; j++) {
        const v = side * (m[j][1] - lvl);
        if (pierceAt < 0 && v < -buf) pierceAt = j;
        if (pierceAt >= 0 && c5[j] && v > 0) return mn(m[j][0]) - mn(m[pierceAt][0]) <= 30 ? j : -1;
      }
      return -1;
    };
    const breakTrade = (side: 1 | -1) => { for (let j = from; j >= 0 && j < m.length && mn(m[j][0]) <= 660; j++) if (c15[j] && side * (m[j][1] - (side > 0 ? oh : ol)) > buf) return j; return -1; };
    const a1 = sweepTrade(1), a2 = sweepTrade(-1), b1 = breakTrade(1), b2 = breakTrade(-1);
    if (a1 >= 0) { s.lowSw++; add(s.lsl, sim(m, a1, 1, k)); }
    if (a2 >= 0) { s.highSw++; add(s.hss, sim(m, a2, -1, k)); }
    if (b1 >= 0) add(s.bul, sim(m, b1, 1, k));
    if (b2 >= 0) add(s.bds, sim(m, b2, -1, k));
  }
  const total = Object.values(G).reduce((a: number, s: any) => a + s.n, 0);
  const gaps = {} as Record<GapKey, GapStat>;
  for (const gk of ["BIG_DOWN", "DOWN", "FLAT", "UP", "BIG_UP"] as GapKey[]) {
    const s = G[gk] || { n: 0, fill: 0, fill1015: 0, cont: 0, closeDir: 0, or: [], lowSw: 0, highSw: 0, lsl: acc(), hss: acc(), bul: acc(), bds: acc() };
    gaps[gk] = { n: s.n, sharePct: pct(s.n, total), fillPct: pct(s.fill, s.n), fillBy1015Pct: pct(s.fill1015, s.n), contPct: pct(s.cont, s.n), closeGapDirPct: pct(s.closeDir, s.n),
      medOr15: Math.round(med(s.or)), orLowSweepPct: pct(s.lowSw, s.n), orHighSweepPct: pct(s.highSw, s.n),
      orLowSweepLong: fin(s.lsl), orHighSweepShort: fin(s.hss), orBreakUpLong: fin(s.bul), orBreakDownShort: fin(s.bds) };
  }
  const levels: Record<string, LevelStat> = {};
  for (const [key, a] of Object.entries(L)) levels[key] = { n: a.n, holdPct: pct(a.hold, a.n), breakPct: pct(a.brk, a.n), sweepPct: pct(a.sweep, a.n), recoverPct: pct(a.rec, a.n), chopPct: pct(a.chop, a.n), defend: fin(a.d), breakTrade: fin(a.b) };
  return { scale: k, sessions: ss.length, from: ss[0]?.day ?? "", to: ss[ss.length - 1]?.day ?? "", medRange: Math.round(med(ranges)), gaps, levels };
}
