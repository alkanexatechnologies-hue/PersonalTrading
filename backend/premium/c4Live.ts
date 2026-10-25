// ============================ C4 LIVE — the owner's C4 rule evaluated at each closed 5-min candle ============================
// C4 = research/protrader/fakeUpPaperCore.isPaperSignal on fakeMoveGrid.run events, unchanged:
//   5-min FAKE-UP CONFIRMED (analyst/fakeMove.detectFakeMoveTF) at an OWNER S/R level (premium/ownerLevels, the 5 sessions
//   before today) + call writing (ATM CE OI up AND CE premium down over the 4-bar window) + the level touched ≥ 30 min
//   earlier today. Buy the ATM PE at the confirming close; index stop = the 4-bar high (≥ 0.25 × ATR above entry),
//   target 1 : 1 below, 60 minutes.
// Same bars as the research: 5- / 15-min bars built from 1-MINUTE CLOSES (09:15–15:30), ATR 14 over the previous sessions'
// 5-min bars + today's, one test per level per day. The research only kept an event once ≥ 20 minutes of the future were
// known and skipped sessions with < 300 minutes; both are data-availability guards for scoring, so the live scan drops them
// (a signal shows at its own candle close). c4Live.test.ts checks parity with the research rule on real past sessions.
// Information only — advisory; it never places an order.
import { detectFakeMoveTF, FakeMoveLevel } from "../analyst/fakeMove";
import { priceActionLevels } from "./ownerLevels";

export interface C4Day { day: string; mins: [number, number][] }   // 1-min closes keyed by the minute's START (epoch s)
export interface C4Leg { c: number; oi: number | null }
/** ATM option minute lookup: the minute STARTING at t (close at t + 60), or null. */
export type C4LegAt = (strike: number, side: "CE" | "PE", t: number) => C4Leg | null;
export interface C4Signal {
  day: string; t: number; barTime: number; level: number; entryIdx: number; stopIdx: number; targetIdx: number; atr: number; atm: number;
  premIn: number | null; ceOi0: number; ceOi1: number; ce0: number; ce1: number;
}
export interface C4Watch { t: number; level: number; atm: number; reason: string }   // a confirmed fake-up at an owner level that failed a C4 filter

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const barsN = (mins: [number, number][], n: number): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };
const sessionMins = (d: C4Day) => d.mins.filter(([t]) => mn(t) >= 555 && mn(t) < 930).sort((a, b) => a[0] - b[0]);

/** Owner levels for `today` from the previous sessions (only sessions with ≥ 300 minutes count, as in the research). */
export function c4OwnerLevels(prev: C4Day[]): number[] {
  const full = prev.map(sessionMins).filter((m) => m.length >= 300), prev15 = full.slice(-5).flatMap((m) => barsN(m, 15)), a15 = atr14(prev15.slice(-15));
  return prev15.length >= 50 && a15 ? priceActionLevels(prev15, a15).map((l) => l.price) : [];
}

/** Scan today's CLOSED 5-min candles (bars ending ≤ `nowSec`) for C4 signals. `prev` = earlier sessions, oldest first. */
export function c4Scan(prev: C4Day[], today: C4Day, step: number, legAt: C4LegAt, nowSec = Infinity): { signals: C4Signal[]; watch: C4Watch[]; owner: number[]; lastClose: number | null } {
  const full = prev.map(sessionMins).filter((m) => m.length >= 300);
  const owner = c4OwnerLevels(prev), histT = full.flatMap((m) => barsN(m, 5)).slice(-400);
  const mins = sessionMins(today).filter(([t]) => t + 60 <= nowSec), B = barsN(mins, 5).filter((b) => b.time + 300 <= nowSec);
  const signals: C4Signal[] = [], watch: C4Watch[] = [], seen = new Set<string>();
  const leg = (strike: number, side: "CE" | "PE", t: number) => { for (let k = 0; k < 4; k++) { const x = legAt(strike, side, t - 60 - k * 60); if (x) return x; } return null; };
  for (let i = 4; i < B.length; i++) {
    const tEnd = B[i].time + 300, m = mn(tEnd), a = atr14(histT.concat(B.slice(0, i + 1)).slice(-15));
    if (!a || m < 575 || m > 900 || !owner.length) continue;
    const px = B[i].close, w4 = B.slice(i - 3, i + 1), hi4 = Math.max(...w4.map((b) => b.high));
    const levels: FakeMoveLevel[] = owner.map((p) => ({ price: Math.round(p * 100) / 100, label: "PA", side: p >= px ? "resistance" : "support" }));
    const fm = detectFakeMoveTF({ tfLabel: "5M", candles: B.slice(Math.max(0, i - 40), i + 1) as any, levels });
    if (fm.status !== "CONFIRMED" || fm.level == null) continue;
    const dir = fm.direction === "DOWN" ? 1 : -1, lvl = fm.level, key = `${dir}|${Math.round(lvl)}`;
    if (seen.has(key)) continue; seen.add(key);                       // one test per level per direction per day (research `seen`)
    if (dir !== -1) continue;                                          // C4 is the FAKE-UP side only
    const atm = Math.round(px / step) * step, t0 = B[i - 3].time, ce0 = leg(atm, "CE", t0 + 60), ce1 = leg(atm, "CE", tEnd);
    const write = !!(ce0 && ce1 && ce0.oi != null && ce1.oi != null && ce1.oi > ce0.oi && ce1.c < ce0.c);
    const retest = mins.some(([t, p]) => t < tEnd - 1800 && t >= B[0].time && Math.abs(p - lvl) <= 0.15 * a);
    if (!write || !retest) { watch.push({ t: tEnd, level: lvl, atm, reason: !ce0 || !ce1 || ce0.oi == null || ce1.oi == null ? "no ATM call OI data" : !write ? "no call writing" : "level not touched 30 min earlier" }); continue; }
    const d = Math.max(hi4 - px, 0.25 * a);
    signals.push({ day: today.day, t: tEnd, barTime: B[i].time, level: lvl, entryIdx: px, stopIdx: px + d, targetIdx: px - d, atr: a, atm,
      premIn: leg(atm, "PE", tEnd)?.c ?? null, ceOi0: ce0!.oi!, ceOi1: ce1!.oi!, ce0: ce0!.c, ce1: ce1!.c });
  }
  return { signals, watch, owner, lastClose: mins.length ? mins[mins.length - 1][1] : null };
}
