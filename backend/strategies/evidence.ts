// ============================ Trader Specific Strategies — historical edge ============================
// Turns recorded past sessions into an edge weight for a strategy IN SIMILAR
// CONDITIONS. Deliberately conservative to avoid overfitting a small sample:
//  - Only RESOLVED past sessions count (no look-ahead — today never weights itself).
//  - Similar condition = same regime bucket.
//  - Below MIN_SAMPLE the weight is neutral (1.0) and sufficientHistory=false, so a
//    fresh install ranks on current-condition match alone (clearly labelled).
//  - The weight is a modest multiplier, never a probability of profit.

import { ConditionSnapshot, EvidenceLookup, StrategyEvidence, StrategyId } from "./types";
import { resolvedFor } from "./sessionStore";

const MIN_SAMPLE = 8;          // sessions before history influences ranking
const W_MIN = 0.7, W_MAX = 1.3; // edge-weight band

export const liveEvidence: EvidenceLookup = (id: StrategyId, snap: ConditionSnapshot): StrategyEvidence => {
  let rows: ReturnType<typeof resolvedFor> = [];
  try { rows = resolvedFor(id, snap.regime); } catch { rows = []; }
  const n = rows.length;
  if (n < MIN_SAMPLE) {
    return { sufficientHistory: false, sampleSize: n, hitRate: null, edgeWeight: 1.0,
      note: n === 0 ? "No recorded history yet — current-condition match only." : `Only ${n} similar session(s) recorded — building history.` };
  }
  const correct = rows.filter((r) => r.selectionCorrect === true).length;
  const hitRate = correct / n;
  // Map a 0..1 hit-rate onto the weight band around neutral.
  const edgeWeight = Math.max(W_MIN, Math.min(W_MAX, W_MIN + (W_MAX - W_MIN) * hitRate));
  return { sufficientHistory: true, sampleSize: n, hitRate: Math.round(hitRate * 100) / 100, edgeWeight: Math.round(edgeWeight * 100) / 100,
    note: `Validated on ${n} similar session(s): ${Math.round(hitRate * 100)}% matched.` };
};

// A neutral lookup for tests / when history should be ignored.
export const neutralEvidence: EvidenceLookup = () => ({ sufficientHistory: false, sampleSize: 0, hitRate: null, edgeWeight: 1.0, note: "History disabled." });
