// ---- Step 2: liquidityGuard.ts ----
// Continuous module. No dependencies.
//
// Detects a THIN book directly from three inputs — NO hardcoded clock windows
// (no 9:15/12:00/15:00 checks). Thinness is inferred every cycle from:
//   1) bid-ask spread vs its own 20-period rolling average   (primary weight)
//   2) volume vs the same-time-of-day rolling average        (not raw volume)
//   3) total chain OI vs its own recent average
//
// The live feed does not always expose a bid-ask spread (indices in particular),
// so each input is optional; when one is missing its weight is redistributed to
// the others. If NONE are available we cannot detect thinness and report Normal
// (fail-open) rather than inventing a state.

import { LiquidityState, clamp } from "./types";

export interface LiquidityInputs {
  // Bid-ask spread history (per period), newest last. Primary signal.
  spreadSeries?: number[];
  // Volume now vs the average at the SAME time of day (across recent sessions).
  volumeByTod?: { current: number; sameTodAvg: number };
  // Total chain OI now vs its own recent average.
  chainOi?: { current: number; recentAvg: number };
}

export interface LiquidityResult {
  liquidityState: LiquidityState;
  liquidityScore: number; // 0..100, higher = more liquid
  note: string;
}

const THIN_BELOW = 45; // liquidityScore below this => Thin

// Map a "current vs baseline" ratio to a 0..1 liquidity sub-score where a value
// AT or ABOVE baseline is healthy (1.0) and progressively below baseline is worse.
// `invert` = true when a HIGHER ratio means WORSE (bid-ask spread).
function subScore(current: number, baseline: number, invert: boolean): number | null {
  if (!(baseline > 0) || !(current >= 0)) return null;
  const ratio = current / baseline;
  if (invert) {
    // spread ratio 1 => healthy (1.0); 2x avg spread => ~0.
    return clamp(1 - (ratio - 1), 0, 1);
  }
  // volume/OI ratio 1 => healthy (1.0); half of baseline => ~0.5; 0 => 0.
  return clamp(ratio, 0, 1);
}

export function computeLiquidityGuard(inputs: LiquidityInputs): LiquidityResult {
  const parts: { w: number; s: number; label: string }[] = [];

  if (inputs.spreadSeries && inputs.spreadSeries.length >= 2) {
    const arr = inputs.spreadSeries;
    const cur = arr[arr.length - 1];
    const win = arr.slice(-20);
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    const s = subScore(cur, avg, true);
    if (s != null) parts.push({ w: 0.5, s, label: `spread ${cur.toFixed(2)} vs avg ${avg.toFixed(2)}` });
  }
  if (inputs.volumeByTod) {
    const s = subScore(inputs.volumeByTod.current, inputs.volumeByTod.sameTodAvg, false);
    if (s != null) parts.push({ w: 0.3, s, label: `vol ${Math.round(inputs.volumeByTod.current)} vs same-time avg ${Math.round(inputs.volumeByTod.sameTodAvg)}` });
  }
  if (inputs.chainOi) {
    const s = subScore(inputs.chainOi.current, inputs.chainOi.recentAvg, false);
    if (s != null) parts.push({ w: 0.2, s, label: `chainOI ${Math.round(inputs.chainOi.current)} vs avg ${Math.round(inputs.chainOi.recentAvg)}` });
  }

  if (!parts.length) {
    // No liquidity signal available — cannot claim the book is thin.
    return { liquidityState: "Normal", liquidityScore: 100, note: "no liquidity data (feed lacks spread/volume/OI history) — assumed Normal" };
  }

  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const score01 = parts.reduce((a, p) => a + p.w * p.s, 0) / wSum;
  const liquidityScore = Math.round(score01 * 100);
  const liquidityState: LiquidityState = liquidityScore < THIN_BELOW ? "Thin" : "Normal";
  return { liquidityState, liquidityScore, note: parts.map((p) => p.label).join(" · ") };
}
