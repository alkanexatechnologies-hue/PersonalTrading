// ============================ Trade monitor — resolve Open trades ============================
// Advisory only (LIVE_ORDER_EXECUTION stays false): this NEVER places or closes a
// real order. It reads the option's OWN premium candles after the logged entry and
// marks the recorded trade Target Hit / SL Hit when the premium actually reached
// those levels — fixing "every trade stays Open". A trade is bought premium (CE or
// PE): it wins when the premium rises, so target is above entry and stop below,
// and the same math applies to both sides.

export type MonitorStatus = "Target Hit" | "SL Hit";

export interface MonitorTrade {
  execTs: number;            // entry time (epoch sec)
  entry: number | null;
  sl: number | null;
  target: number | null;
}
export interface Candle { time: number; open: number; high: number; low: number; close: number; }

export interface Resolution {
  status: MonitorStatus;
  exitPrice: number;
  exitTs: number;
  remark: string;
}

/** True when a trade can even be monitored (needs a real entry and both levels,
 *  with target above entry above stop — otherwise there is nothing to resolve). */
export function isMonitorable(t: MonitorTrade): boolean {
  return t.entry != null && t.sl != null && t.target != null &&
    t.entry > 0 && t.sl > 0 && t.target > 0 && t.target > t.entry && t.sl < t.entry;
}

/**
 * Resolve a trade from its option premium candles.
 * - Scans candles at/after the entry, in time order.
 * - Target Hit when a candle's HIGH ≥ target; SL Hit when a candle's LOW ≤ SL.
 * - If both happen in the same candle, the STOP is taken first (conservative — we
 *   cannot see intrabar order, so we never over-report a win).
 * - `windowEnded` (past the trade window at EOD): if still unresolved, square off
 *   at the last candle close and label by realised P&L, with a clear remark.
 * Returns null while the trade is still legitimately open.
 */
export function resolveFromCandles(t: MonitorTrade, candles: Candle[], windowEnded: boolean): Resolution | null {
  if (!isMonitorable(t)) return null;
  const entry = t.entry as number, sl = t.sl as number, target = t.target as number;
  const bars = candles.filter((c) => c.time >= t.execTs).sort((a, b) => a.time - b.time);
  for (const c of bars) {
    const hitSl = c.low <= sl;
    const hitTarget = c.high >= target;
    if (hitSl && hitTarget) return { status: "SL Hit", exitPrice: sl, exitTs: c.time, remark: "SL hit (stop taken first within the bar)" };
    if (hitTarget) return { status: "Target Hit", exitPrice: target, exitTs: c.time, remark: "Target hit" };
    if (hitSl) return { status: "SL Hit", exitPrice: sl, exitTs: c.time, remark: "SL hit" };
  }
  if (windowEnded && bars.length) {
    const last = bars[bars.length - 1];
    const win = last.close >= entry;
    return {
      status: win ? "Target Hit" : "SL Hit",
      exitPrice: last.close, exitTs: last.time,
      remark: `EOD square-off @ ${last.close} (${win ? "in profit" : "in loss"}; target/SL not touched)`,
    };
  }
  return null;
}
