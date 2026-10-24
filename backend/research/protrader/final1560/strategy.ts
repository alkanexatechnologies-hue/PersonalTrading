// LAX — Level-Acceptance eXpansion. Research candidate for the owner's 15–60 index-point objective (2026-10-25).
// PURE functions only (no I/O); unit-tested in strategy.test.ts. Research only — nothing live reads this file.
// The rules below are PRE-REGISTERED in FINAL_15_60_POINT_STRATEGY.md and were fixed before the two-year evaluation.

export interface Bar { time: number; open: number; high: number; low: number; close: number }   // 5-min, time = candle start (UTC s)
export interface Level { p: number; kind: "PDH" | "PDL" | "PDC" | "ORH" | "ORL" | string }
export interface Cfg {
  windowStart: number; windowEnd: number;   // breakout candle START, IST minutes (09:30 = 570, 11:25 = 685)
  breakBuf: number; acceptBuf: number;       // × ATR: breakout close beyond L by > breakBuf; acceptance low stays above L − acceptBuf
  maxConsumed: number;                       // × ATR: entry − level ≤ maxConsumed (freshness)
  minRoomPts: number; minRoomAtr: number;    // room to the nearest opposing level ≥ max(minRoomPts, minRoomAtr × ATR)
  maxRiskAtr: number;                        // initial index risk (entry − stop) ≤ maxRiskAtr × ATR, else NO TRADE
  maxPriorCrosses: number;                   // the level may have been crossed by a 5-min close at most this often earlier today
  targetMaxPts: number; targetBufAtr: number; // target = entry + min(targetMaxPts, room − targetBufAtr × ATR)
  beAfterPts: number; beCushion: number;     // after a +beAfterPts 1-min close, stop → entry + beCushion (index points)
  maxHoldMin: number;
}
export const LAX: Cfg = {
  windowStart: 570, windowEnd: 685, breakBuf: 0.1, acceptBuf: 0.1, maxConsumed: 1.0, minRoomPts: 20, minRoomAtr: 1.0,
  maxRiskAtr: 1.5, maxPriorCrosses: 1, targetMaxPts: 45, targetBufAtr: 0.1, beAfterPts: 15, beCushion: 2, maxHoldMin: 60,
};
export const istMin = (t: number) => Math.floor(((t + 19800) % 86400) / 60);

export function atr14(b: Bar[], i: number, n = 14): number | null {
  if (i < n) return null; let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].high - b[j].low, Math.abs(b[j].high - b[j - 1].close), Math.abs(b[j].low - b[j - 1].close));
  return s / n;
}

/** Market-wide levels known at a candle: previous day high / low / close; opening range (09:15–09:30) once it is complete. */
export function marketLevels(prev: { high: number; low: number; close: number } | null, today: Bar[], candleStartMin: number): Level[] {
  const L: Level[] = []; if (prev) L.push({ p: prev.high, kind: "PDH" }, { p: prev.low, kind: "PDL" }, { p: prev.close, kind: "PDC" });
  const or = today.filter((b) => istMin(b.time) < 570);
  if (candleStartMin >= 570 && or.length >= 3) L.push({ p: Math.max(...or.map((b) => b.high)), kind: "ORH" }, { p: Math.min(...or.map((b) => b.low)), kind: "ORL" });
  return L;
}

export interface Signal { i: number; t: number; dir: 1 | -1; level: Level; entry: number; stop: number; risk: number; room: number; target: number; consumed: number; atr: number; why: string[] }
export interface Reject { i: number; dir: 1 | -1; level: Level; reason: string }

/**
 * Scan today's completed 5-min candles (global indices `off..` in `all`, ATR from the continuous series) for LAX signals.
 * A signal at acceptance candle i+1 uses only candles ≤ i+1. Returns accepted signals and the reasons others were rejected.
 */
export function scan(all: Bar[], off: number, nToday: number, levelsAt: (i: number) => Level[], cfg: Cfg = LAX): { signals: Signal[]; rejects: Reject[] } {
  const signals: Signal[] = [], rejects: Reject[] = [], seen = new Set<string>();
  for (let k = 1; k < nToday - 1; k++) {
    const g = off + k, B = all[g], A = all[g + 1], P = all[g - 1], m = istMin(B.time), a = atr14(all, g);
    if (m < cfg.windowStart || m > cfg.windowEnd || !a) continue;
    for (const L of levelsAt(k)) for (const dir of [1, -1] as const) {
      const key = `${dir}|${L.kind}|${Math.round(L.p)}`; if (seen.has(key)) continue;
      const brk = dir * (P.close - L.p) <= 0 && dir * (B.close - L.p) > cfg.breakBuf * a; if (!brk) continue;
      seen.add(key);   // the first breakout of this level in this direction today is the only one considered
      const rej = (reason: string) => rejects.push({ i: g + 1, dir, level: L, reason });
      if (!(dir * (A.close - L.p) > 0 && dir * ((dir > 0 ? A.low : A.high) - L.p) > -cfg.acceptBuf * a)) { rej("not accepted (next candle closed back / re-entered)"); continue; }
      const entry = A.close, consumed = dir * (entry - L.p);
      if (consumed > cfg.maxConsumed * a) { rej(`stale: ${consumed.toFixed(0)} pts already consumed (> ${cfg.maxConsumed} ATR)`); continue; }
      // earlier crossings of this level today (5-min closes on opposite sides of it)
      let crosses = 0; for (let j = off + 1; j < g; j++) if ((all[j - 1].close - L.p) * (all[j].close - L.p) < 0) crosses++;
      if (crosses > cfg.maxPriorCrosses) { rej(`level already crossed ${crosses}× today (chop)`); continue; }
      // room: the nearest opposing market level or today's extreme beyond the entry
      const today = all.slice(off, g + 2), ext = dir > 0 ? Math.max(...today.slice(0, -2).map((b) => b.high)) : Math.min(...today.slice(0, -2).map((b) => b.low));
      const opp = [...levelsAt(k + 1).map((x) => x.p), ext].filter((p) => dir * (p - entry) > 0.05 * a).map((p) => dir * (p - entry));
      const room = opp.length ? Math.min(...opp) : Infinity;
      if (room < Math.max(cfg.minRoomPts, cfg.minRoomAtr * a)) { rej(`no room: ${room.toFixed(0)} pts to the next level`); continue; }
      const stop = dir > 0 ? Math.min(B.low, A.low) - 0.1 * a : Math.max(B.high, A.high) + 0.1 * a, risk = dir * (entry - stop);
      if (risk > cfg.maxRiskAtr * a) { rej(`risk ${risk.toFixed(0)} pts > ${cfg.maxRiskAtr} ATR`); continue; }
      const target = entry + dir * Math.min(cfg.targetMaxPts, room - cfg.targetBufAtr * a);
      signals.push({ i: g + 1, t: A.time + 300, dir, level: L, entry, stop, risk, room, target, consumed, atr: a,
        why: [`${dir > 0 ? "closed above" : "closed below"} ${L.kind} ${L.p.toFixed(0)} and the next candle held`, `${consumed.toFixed(0)} pts consumed`, `room ${Number.isFinite(room) ? room.toFixed(0) : "open"} pts`, `risk ${risk.toFixed(0)} pts`] });
    }
  }
  // conflicting long and short on the same candle → no trade on either
  const byI = new Map<number, Signal[]>(); for (const s of signals) (byI.get(s.i) || byI.set(s.i, []).get(s.i)!).push(s);
  const ok: Signal[] = [];
  for (const [i, ss] of byI) { const dirs = new Set(ss.map((s) => s.dir)); if (dirs.size > 1) { for (const s of ss) rejects.push({ i, dir: s.dir, level: s.level, reason: "conflict: long and short on the same candle" }); continue; } ok.push(ss.sort((p, q) => q.room - p.room)[0]); }
  return { signals: ok.sort((p, q) => p.i - q.i), rejects };
}

export interface IndexExit { exitT: number; exitPx: number; why: "TARGET" | "STOP" | "BREAKEVEN" | "THESIS" | "TIME"; mfe: number; mae: number; reach: Record<number, boolean> }
export const REACH = [15, 20, 30, 45, 60];
/**
 * Index exit on 1-min closes after the entry (stop orders act on 1-min closes — the index has no 1-min high / low):
 *   STOP at the initial stop · BREAKEVEN after a +beAfterPts close moves the stop to entry + cushion (from the next minute) ·
 *   TARGET at the target · THESIS at a 5-min close back through the level (decided at the 5-min boundary) · TIME after maxHold.
 * `reach` = favourable move ≥ X points before INVALIDATION (initial stop or thesis), tracked up to 120 min / 15:15 even after
 * the trade's own exit, so it measures the move potential independently of the exit rule.
 */
export function indexExit(path: [number, number][], s: Signal, cfg: Cfg = LAX, sessionEnd: number): IndexExit {
  const dir = s.dir; let stop = s.stop, ex: IndexExit | null = null, mfe = 0, mae = 0, invalid = false;
  const reach: Record<number, boolean> = {}; for (const r of REACH) reach[r] = false;
  for (const [t, p] of path) {
    if (t >= Math.min(s.t + 7200, sessionEnd)) break;
    const fav = dir * (p - s.entry);
    if (!invalid) { for (const r of REACH) if (fav >= r) reach[r] = true; }
    const thesisAt = (t + 60 - s.t) % 300 === 0 && dir * (p - s.level.p) < 0;
    if (dir * (p - s.stop) <= 0 || thesisAt) invalid = true;
    if (ex) continue;
    mfe = Math.max(mfe, fav); mae = Math.max(mae, -fav);
    if (dir * (p - stop) <= 0) { ex = { exitT: t + 60, exitPx: p, why: stop === s.stop ? "STOP" : "BREAKEVEN", mfe, mae, reach }; continue; }
    if (dir * (p - s.target) >= 0) { ex = { exitT: t + 60, exitPx: p, why: "TARGET", mfe, mae, reach }; continue; }
    if (thesisAt) { ex = { exitT: t + 60, exitPx: p, why: "THESIS", mfe, mae, reach }; continue; }
    if (t + 60 >= Math.min(s.t + cfg.maxHoldMin * 60, sessionEnd)) { ex = { exitT: t + 60, exitPx: p, why: "TIME", mfe, mae, reach }; continue; }
    if (fav >= cfg.beAfterPts) stop = dir > 0 ? Math.max(stop, s.entry + cfg.beCushion) : Math.min(stop, s.entry - cfg.beCushion);
  }
  if (!ex) { const last = path.filter(([t]) => t < Math.min(s.t + cfg.maxHoldMin * 60, sessionEnd)).pop() ?? [s.t, s.entry]; ex = { exitT: last[0] + 60, exitPx: last[1], why: "TIME", mfe, mae, reach }; }
  ex.mfe = mfe; ex.mae = mae; return ex;
}

/** Option round trip in ₹ per lot. Base: slippage max(₹0.5, 0.25 %) per side + ₹40 brokerage + statutory (0.1 % of sell value
 *  + 0.04 % of turnover). Conservative adds 0.5 % extra slippage per side. */
export function optionPnl(entryPrem: number, exitPrem: number, lot: number, conservative = false) {
  const slip = (p: number) => Math.max(0.5, 0.0025 * p) + (conservative ? 0.005 * p : 0);
  const stat = 0.001 * exitPrem + 0.0004 * (entryPrem + exitPrem);
  const gross = (exitPrem - entryPrem) * lot, net = (exitPrem - entryPrem - slip(entryPrem) - slip(exitPrem) - stat) * lot - 40;
  return { gross, net };
}
