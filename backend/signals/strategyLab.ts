// Strategy Lab — independent reversal strategies, each with its own level source and
// its own trades. They do NOT touch the live Setup Signals rules (setupSignals.ts);
// every strategy is evaluated on its own (one trade at a time per strategy).
//
// Common reversal trigger, on CLOSED 5m candles only:
//   support (CE): price came DOWN into the level (a close ≥ 0.5 ATR above it in the last 6 bars),
//     the candle's low reaches the level (≤ level + 0.1 ATR, not deeper than 0.6 ATR below),
//     and the candle closes back ABOVE the level, green, in its upper half.
//   resistance (PE): the mirror.
// Entry = break of the trigger candle (high for CE / low for PE) within the next 2 candles.
// Stop = extreme of the last 3 candles ± 0.1 ATR. Target = 1.5R. Anything open exits at 15:15.
import type { Candle } from "../types";
import { atr } from "../indicators";

export type LabStrategyId = "PDH_PDL" | "SWING" | "OI_SR";
export interface LabLevel { price: number; kind: "SUPPORT" | "RESISTANCE"; name: string; from: number /* usable from this candle time */ }
export interface LabTrade {
  strategy: LabStrategyId; side: "CE" | "PE"; level: string; levelPrice: number;
  signalTime: string; entryTime: string | null; entry: number | null; stop: number; target: number | null;
  status: "WAITING" | "OPEN" | "TARGET" | "STOP" | "TIME_EXIT" | "NO_TRIGGER"; exitTime: string | null; resultR: number | null;
}

export const LAB_CONFIG = {
  firstSignalMin: 9 * 60 + 25, lastSignalMin: 14 * 60, dayEndMin: 15 * 60 + 15,
  approachAtr: 0.5, touchAtr: 0.1, maxPierceAtr: 0.6, stopBufferAtr: 0.1, targetR: 1.5, breakBars: 2,
  maxPerLevel: 2, swingBars: 3,
};
const L = LAB_CONFIG;

const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm = (t: number) => { const m = istMin(t); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

export function pdhPdlLevels(prevDay: Candle[], today: Candle[]): LabLevel[] {
  if (!prevDay.length || !today.length) return [];
  const t0 = today[0].time;
  return [
    { price: Math.max(...prevDay.map((c) => c.high)), kind: "RESISTANCE", name: "PDH", from: t0 },
    { price: Math.min(...prevDay.map((c) => c.low)), kind: "SUPPORT", name: "PDL", from: t0 },
  ];
}

// 5m fractal swings (n bars each side) from the previous day and today; a swing is only
// known n candles after it forms, so `from` is the close of the n-th candle after it.
export function swingLevels(prevDay: Candle[], today: Candle[], n = L.swingBars): LabLevel[] {
  const xs = [...prevDay, ...today], out: LabLevel[] = [];
  for (let i = n; i < xs.length - n; i++) {
    const w = xs.slice(i - n, i + n + 1);
    const from = xs[i + n].time + 300;
    if (xs[i].high === Math.max(...w.map((c) => c.high))) out.push({ price: xs[i].high, kind: "RESISTANCE", name: `Swing high ${hm(xs[i].time)}${i < prevDay.length ? " (yday)" : ""}`, from });
    if (xs[i].low === Math.min(...w.map((c) => c.low))) out.push({ price: xs[i].low, kind: "SUPPORT", name: `Swing low ${hm(xs[i].time)}${i < prevDay.length ? " (yday)" : ""}`, from });
  }
  return out;
}

export function oiLevels(snap: { support?: number | null; resistance?: number | null } | null, today: Candle[]): LabLevel[] {
  if (!snap || !today.length) return [];
  const t0 = today[0].time, out: LabLevel[] = [];
  if (snap.support != null) out.push({ price: snap.support, kind: "SUPPORT", name: `OI support ${snap.support}`, from: t0 });
  if (snap.resistance != null) out.push({ price: snap.resistance, kind: "RESISTANCE", name: `OI resistance ${snap.resistance}`, from: t0 });
  return out;
}

// Runs one strategy over a session. `hist` = earlier candles (for ATR warm-up), `asOf` = only
// candles that closed by this time are used (live / replay safe).
export function runLabStrategy(strategy: LabStrategyId, hist: Candle[], today: Candle[], levels: LabLevel[], asOf: number): LabTrade[] {
  const day = today.filter((c) => c.time + 300 <= asOf);
  if (day.length < 2) return [];
  const all = [...hist, ...day], off = hist.length, A = atr(all, 14);
  const trades: LabTrade[] = [], used = new Map<string, number>();
  let open: (LabTrade & { _k: number; _risk: number; _sg: number; _trig: number }) | null = null;

  const step = (k: number) => {
    if (!open) return;
    const c = day[k], sg = open._sg;
    if (open.status === "WAITING") {
      if (k > open._k + L.breakBars) { open.status = "NO_TRIGGER"; open = null; return; }
      if (sg > 0 ? c.high > open._trig : c.low < open._trig) {
        open.status = "OPEN"; open.entry = open._trig; open.entryTime = hm(c.time);
        open._risk = Math.abs(open.entry - open.stop); open.target = open.entry + sg * L.targetR * open._risk;
      } else return;
    }
    if (open.status !== "OPEN") return;
    const hitStop = sg > 0 ? c.low <= open.stop : c.high >= open.stop;
    const hitTgt = sg > 0 ? c.high >= open.target! : c.low <= open.target!;
    if (hitStop) { open.status = "STOP"; open.resultR = -1; }
    else if (hitTgt) { open.status = "TARGET"; open.resultR = L.targetR; }
    else if (istMin(c.time) + 5 >= L.dayEndMin) { open.status = "TIME_EXIT"; open.resultR = Math.round((sg * (c.close - open.entry!) / open._risk) * 100) / 100; }
    if (open.status !== "OPEN") { open.exitTime = hm(c.time + 300); open = null; }
  };

  for (let k = 1; k < day.length; k++) {
    step(k);
    if (open) continue;
    const c = day[k], i = off + k, m = istMin(c.time) + 5, a = A[i] || A[i - 1] || 0;
    if (!(a > 0) || m < L.firstSignalMin || m > L.lastSignalMin) continue;
    const recent = all.slice(Math.max(0, i - 6), i);
    for (const lv of levels) {
      if (lv.from > c.time || (used.get(lv.name) || 0) >= L.maxPerLevel) continue;
      const p = lv.price;
      let sg = 0;
      if (lv.kind === "SUPPORT" && recent.some((x) => x.close >= p + L.approachAtr * a) && c.low <= p + L.touchAtr * a && c.low >= p - L.maxPierceAtr * a
        && c.close > p && c.close > c.open && c.close >= (c.high + c.low) / 2) sg = 1;
      if (lv.kind === "RESISTANCE" && recent.some((x) => x.close <= p - L.approachAtr * a) && c.high >= p - L.touchAtr * a && c.high <= p + L.maxPierceAtr * a
        && c.close < p && c.close < c.open && c.close <= (c.high + c.low) / 2) sg = -1;
      if (!sg) continue;
      const last3 = all.slice(Math.max(0, i - 2), i + 1);
      const stop = sg > 0 ? Math.min(...last3.map((x) => x.low)) - L.stopBufferAtr * a : Math.max(...last3.map((x) => x.high)) + L.stopBufferAtr * a;
      const t: LabTrade = { strategy, side: sg > 0 ? "CE" : "PE", level: lv.name, levelPrice: Math.round(p * 100) / 100, signalTime: hm(c.time + 300),
        entryTime: null, entry: null, stop: Math.round(stop * 100) / 100, target: null, status: "WAITING", exitTime: null, resultR: null };
      trades.push(t); used.set(lv.name, (used.get(lv.name) || 0) + 1);
      open = Object.assign(t, { _k: k, _risk: 0, _sg: sg, _trig: sg > 0 ? c.high : c.low });
      break;
    }
  }
  return trades.map(({ _k, _risk, _sg, _trig, ...t }: any) => t as LabTrade);
}
