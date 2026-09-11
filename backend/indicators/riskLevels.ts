// Shared ATR-based stop/target math. Previously duplicated (same 1.5x/2.5x
// multipliers, hardcoded independently) in signals/engine.ts and swing/scan.ts -
// a change to the risk model in one place would silently drift from the other.

export interface AtrStopTargetOptions {
  /** ATR multiple for the stop distance from price (default 1.5). */
  stopMult?: number;
  /** ATR multiple for the target distance from price (default 2.5). */
  targetMult?: number;
}

/**
 * Stop/target levels `stopMult`/`targetMult` ATRs away from `price`, on the
 * correct side for `direction` (1 = long/bullish, -1 = short/bearish).
 */
export function atrStopTarget(
  price: number,
  atrVal: number,
  direction: 1 | -1,
  opts: AtrStopTargetOptions = {}
): { stop: number; target: number } {
  const stopMult = opts.stopMult ?? 1.5;
  const targetMult = opts.targetMult ?? 2.5;
  return direction > 0
    ? { stop: price - stopMult * atrVal, target: price + targetMult * atrVal }
    : { stop: price + stopMult * atrVal, target: price - targetMult * atrVal };
}
