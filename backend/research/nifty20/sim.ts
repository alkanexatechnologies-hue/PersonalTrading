import { netPoints, expiryFor } from "./costs";
import { istHm, type DayData, type Min, type Side } from "./data";

// ============================ 1-minute trade simulator (research) ============================
// Signal at a completed minute (t = that minute's timestamp). Fill = OPEN of the strike's next 1-minute bar (+ slippage),
// only if that bar starts within 2 minutes of the signal. Then minute by minute: stop checked before target inside the
// same minute; a bar that opens beyond the stop fills at its open. Time exit at the close after `maxMin` minutes;
// hard exit 15:20. Records MFE / MAE (points), minutes to target, exit reason. Costs from costs.ts per contract lot.

export interface SimParams { target: number; stop: number; maxMin: number; slip: number }
export interface Signal { t: number; side: Side; strike: number; family: string; note?: string }
export interface TradeLog {
  day: string; family: string; side: Side; strike: number; expiry: string | null; isExpiryDay: boolean; lot: number | null;
  signalHm: string; entryHm: string; entry: number; exitHm: string; exit: number; why: "TARGET" | "STOP" | "TIME" | "EOD" | "DATA_GAP";
  gross: number; net: number; mfe: number; mae: number; minsHeld: number; minsToTarget: number | null; spotAtSignal: number | null; note?: string;
}

export function legOf(d: DayData, strike: number, side: Side): Min[] { return d.legs.get(`${strike}${side}`) || []; }

export function simulateTrade(d: DayData, sig: Signal, p: SimParams): TradeLog | null {
  const bars = legOf(d, sig.strike, sig.side);
  const i0 = bars.findIndex((b) => b.t > sig.t);
  if (i0 < 0 || bars[i0].t - sig.t > 120) return null;                       // no executable bar right after the signal
  const exp = expiryFor(d.day), qty = exp.lot || 65;
  const entry = bars[i0].o + p.slip, tgt = entry + p.target, stp = entry - p.stop;
  let exit = bars[i0].c, why: TradeLog["why"] = "EOD", j = i0, hi = -Infinity, lo = Infinity, toT: number | null = null;
  for (j = i0; j < bars.length; j++) {
    const b = bars[j];
    if (j > i0 && b.t - bars[j - 1].t > 180) { exit = b.o; why = "DATA_GAP"; break; }   // strike left the ATM±3 data window
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    if (b.o <= stp && j > i0) { exit = b.o; why = "STOP"; break; }
    if (b.l <= stp) { exit = stp; why = "STOP"; break; }
    if (b.o >= tgt && j > i0) { exit = b.o; why = "TARGET"; toT = Math.round((b.t - bars[i0].t) / 60); break; }
    if (b.h >= tgt) { exit = tgt; why = "TARGET"; toT = Math.round((b.t - bars[i0].t) / 60); break; }
    exit = b.c;
    if ((b.t - bars[i0].t) / 60 + 1 >= p.maxMin) { why = "TIME"; break; }
    if (istHm(b.t) >= "15:20") { why = "EOD"; break; }
  }
  if (j >= bars.length) j = bars.length - 1;
  const fillExit = exit - p.slip;                                   // every exit pays the exit-side slippage
  const n = netPoints(entry, fillExit, qty, 0);                       // gross = executable exit − executable entry
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    day: d.day, family: sig.family, side: sig.side, strike: sig.strike, expiry: exp.expiry, isExpiryDay: exp.isExpiryDay, lot: exp.lot,
    signalHm: istHm(sig.t), entryHm: istHm(bars[i0].t), entry: r2(entry), exitHm: istHm(bars[j].t), exit: r2(fillExit), why,
    gross: n.gross, net: n.net, mfe: r2(hi - entry), mae: r2(entry - lo), minsHeld: Math.round((bars[j].t - bars[i0].t) / 60) + 1, minsToTarget: toT,
    spotAtSignal: d.spot.get(sig.t) ?? null, note: sig.note,
  };
}

/** Run a family's signals for one day with the daily rules: max 2 trades, no overlap, stop after a target. */
export function runDay(d: DayData, signals: Signal[], p: SimParams, maxTrades = 2): TradeLog[] {
  const out: TradeLog[] = []; let busyUntil = 0;
  for (const s of signals.sort((a, b) => a.t - b.t)) {
    if (out.length >= maxTrades || s.t < busyUntil) continue;
    const tr = simulateTrade(d, s, p); if (!tr) continue;
    out.push(tr);
    const [h, m] = tr.exitHm.split(":").map(Number); busyUntil = Math.floor(Date.parse(`${d.day}T00:00:00Z`) / 1000) - 19800 + h * 3600 + m * 60;
    if (tr.why === "TARGET") break;
  }
  return out;
}

// ---------------- statistics ----------------
export function stats(trades: TradeLog[], days: number) {
  const n = trades.length, r2 = (v: number) => Math.round(v * 100) / 100;
  if (!n) return { trades: 0, days, tradeDays: 0 } as any;
  const wins = trades.filter((t) => t.net > 0), losses = trades.filter((t) => t.net <= 0);
  const sumW = wins.reduce((a, t) => a + t.net, 0), sumL = -losses.reduce((a, t) => a + t.net, 0);
  let eq = 0, peak = 0, dd = 0; for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const p = wins.length / n, se = Math.sqrt((p * (1 - p)) / n);
  const byDay = new Map<string, number>(); trades.forEach((t) => byDay.set(t.day, (byDay.get(t.day) || 0) + t.net));
  const total = trades.reduce((a, t) => a + t.net, 0), maxDay = Math.max(...byDay.values());
  const avgW = wins.length ? sumW / wins.length : 0, avgL = losses.length ? sumL / losses.length : 0;
  return {
    trades: n, days, tradeDays: byDay.size, noTradeDays: days - byDay.size,
    winRate: r2(p * 100), winRate95: [r2(Math.max(0, p - 1.96 * se) * 100), r2(Math.min(1, p + 1.96 * se) * 100)],
    breakEvenWinRate: avgW + avgL > 0 ? r2((avgL / (avgW + avgL)) * 100) : null,
    expectancy: r2(total / n), totalNet: r2(total), profitFactor: sumL > 0 ? r2(sumW / sumL) : null, maxDD: r2(dd),
    avgWin: r2(avgW), avgLoss: r2(-avgL),
    targetPct: r2((trades.filter((t) => t.why === "TARGET").length / n) * 100), stopPct: r2((trades.filter((t) => t.why === "STOP").length / n) * 100),
    timePct: r2((trades.filter((t) => t.why === "TIME" || t.why === "EOD").length / n) * 100), gapPct: r2((trades.filter((t) => t.why === "DATA_GAP").length / n) * 100),
    medMinsToTarget: (() => { const a = trades.map((t) => t.minsToTarget).filter((x): x is number => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; })(),
    medMAE: (() => { const a = trades.map((t) => t.mae).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; })(),
    maxDayShare: total > 0 ? r2((maxDay / total) * 100) : null,
  };
}
/** Bootstrap lower bound of mean net per trade (day-block resampling keeps same-day trades together). */
export function bootstrapLB(trades: TradeLog[], q = 0.05, iters = 2000, seed = 7): number | null {
  if (trades.length < 10) return null;
  const byDay = [...trades.reduce((m, t) => m.set(t.day, [...(m.get(t.day) || []), t.net]), new Map<string, number[]>()).values()];
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const means: number[] = [];
  for (let k = 0; k < iters; k++) { let sum = 0, cnt = 0; for (let i = 0; i < byDay.length; i++) { const d = byDay[Math.floor(rnd() * byDay.length)]; sum += d.reduce((a, b) => a + b, 0); cnt += d.length; } means.push(sum / cnt); }
  means.sort((a, b) => a - b); return Math.round(means[Math.floor(iters * q)] * 100) / 100;
}
