// ============================ Trader Specific Strategies — daily selector ============================
// Pure ranking + a WAIT gate, plus a per-day lock so "TODAY'S PREFERRED STRATEGY"
// stays stable through the session instead of flip-flopping every 15s poll.
//
// CRITICAL RULE (enforced here): the score is condition-support × historical-edge,
// NOT a probability of profit. When no eligible strategy clears the gate, preferred
// is null → "NO SUITABLE STRATEGY TODAY → WAIT". The layer never overrides the
// Master Trade Selector: masterAction only reflects the arbiter's own verdict.

import { ConditionSnapshot, DailySelection, EvidenceLookup, RankedStrategy, StrategyQuality, StrategyTier } from "./types";
import { STRATEGIES } from "./registry";

// A strategy must both clear this condition-support score AND be eligible to be the
// day's pick. Deliberately selective: a middling match is not a reason to trade.
export const GATE_THRESHOLD = 62;

function quality(score: number): StrategyQuality {
  if (score >= 75) return "HIGH";
  if (score >= 62) return "MEDIUM";
  return "LOW";
}

function conditionLabel(s: ConditionSnapshot): { label: string; detail: string } {
  if (s.dataStale || s.regime == null) return { label: "Data unavailable", detail: "Market data is stale or closed — no read." };
  const dir = s.regimeDir === "up" ? "up" : s.regimeDir === "down" ? "down" : "";
  if (s.regime === "Trending") {
    const stage = s.moveStage === "PULLBACK" ? ", pulling back"
      : s.moveStage === "EXTENDED" || s.moveStage === "EXHAUSTION" ? ", looking stretched"
      : s.moveStage === "STRONG_MOVE" ? ", strong" : "";
    return { label: `Trending ${dir}${stage}`.trim(), detail: `Regime trending ${dir}; stage ${s.moveStage ?? "—"}.` };
  }
  if (s.regime === "Compressed") {
    const firing = s.burstState === "Fired Up" || s.burstState === "Fired Down";
    return { label: firing ? "Coiled, just released" : "Compressed / coiling", detail: `Regime compressed; burst ${s.burstState ?? "—"}.` };
  }
  // Transitioning
  const firing = s.burstState === "Fired Up" || s.burstState === "Fired Down";
  if (s.atWall) return { label: "At an OI wall", detail: `Transitioning near a wall; reaction ${s.wallReactionState ?? "—"}.` };
  return { label: firing ? "Breaking out" : "Transitioning / no clear edge", detail: `Regime transitioning; burst ${s.burstState ?? "—"}.` };
}

function expectedMoveLabel(pts: number | null): { points: number | null; label: string } {
  if (pts == null) return { points: null, label: "—" };
  return { points: Math.round(pts), label: `± ${Math.round(pts)} pts (session)` };
}

function masterActionLabel(verdict: string | null): string {
  if (verdict === "GO") return "Master Trade Selector: GO — conditions met.";
  if (verdict === "CONFLICT") return "Master Trade Selector: CONFLICT — signals disagree, hold.";
  return "Master Trade Selector: WAIT — conditions not yet met.";
}

// Pure: rank every strategy for this snapshot, apply the gate, assign tiers.
export function selectDaily(snap: ConditionSnapshot, evidenceFor: EvidenceLookup): DailySelection {
  const cond = conditionLabel(snap);

  const ranked: RankedStrategy[] = STRATEGIES.map((def) => {
    const m = def.match(snap);
    const evidence = evidenceFor(def.id, snap);
    const score = Math.max(0, Math.min(100, Math.round(m.match * evidence.edgeWeight)));
    return {
      id: def.id, name: def.name, blurb: def.blurb,
      match: m.match, eligible: m.eligible, why: m.why,
      requiredConfirmation: def.requiredConfirmation(snap),
      trigger: def.trigger(snap),
      invalidation: def.invalidation(snap),
      evidence,
      score: m.eligible ? score : 0,
      quality: quality(m.eligible ? score : 0),
      tier: "NOT_SUITABLE" as StrategyTier,
    };
  });

  // Sort desc by score; ineligible sink to the bottom (score forced to 0 above).
  ranked.sort((a, b) => b.score - a.score);

  const passes = (r: RankedStrategy) => r.eligible && !snap.dataStale && r.score >= GATE_THRESHOLD;
  const preferred = ranked.find(passes) || null;

  // Tiering: the gate-passing top is PREFERRED, the next eligible one ALTERNATIVE,
  // everything else NOT_SUITABLE.
  if (preferred) {
    preferred.tier = "PREFERRED";
    const alt = ranked.find((r) => r !== preferred && r.eligible);
    if (alt) alt.tier = "ALTERNATIVE";
  }

  const historySufficient = ranked.some((r) => r.evidence.sufficientHistory);

  return {
    symbol: snap.symbol,
    istDate: snap.istDate,
    condition: { label: cond.label, regime: snap.regime, detail: cond.detail },
    preferred,
    ranking: ranked,
    gate: { threshold: GATE_THRESHOLD, passed: !!preferred },
    historySufficient,
    expectedMove: expectedMoveLabel(snap.expectedMovePts),
    masterAction: masterActionLabel(snap.masterVerdict),
    locked: false,
    generatedAt: Date.now(),
    note: preferred
      ? (historySufficient ? "Ranked on current-condition match, weighted by validated history." : "Ranked on current-condition match only — historical edge fills in as sessions are recorded.")
      : "No strategy has a strong enough edge for today's condition. WAIT / no trade.",
  };
}

// ---- Per-day lock ----
// Keeps the day's PREFERRED strategy + ranking order stable once a valid (non-stale)
// read locks them, while still refreshing the live display fields (condition detail,
// expected move, master action, trigger/invalidation copy) on each subsequent call.
// In-memory (resets on restart) — matches this app's paper/testing storage model.
interface LockedDay { istDate: string; selection: DailySelection; }
const _locks = new Map<string, LockedDay>();

export function getOrLockDaily(snap: ConditionSnapshot, evidenceFor: EvidenceLookup): DailySelection {
  const key = snap.symbol;
  const fresh = selectDaily(snap, evidenceFor);
  const existing = _locks.get(key);

  // New day, or nothing locked yet: only lock once we have a real (non-stale) read.
  if (!existing || existing.istDate !== snap.istDate) {
    if (snap.dataStale || snap.regime == null) return fresh; // don't lock a dead read
    _locks.set(key, { istDate: snap.istDate, selection: { ...fresh, locked: true } });
    return { ...fresh, locked: true };
  }

  // Same day, already locked: keep the locked preferred + ranking, refresh live fields.
  const locked = existing.selection;
  return {
    ...locked,
    condition: fresh.condition,
    expectedMove: fresh.expectedMove,
    masterAction: fresh.masterAction,
    // refresh the copy on the locked preferred/ranking from the current snapshot
    preferred: locked.preferred ? { ...locked.preferred } : null,
    generatedAt: Date.now(),
    locked: true,
  };
}

// Test/day-rollover helper.
export function _resetLocks(): void { _locks.clear(); }
