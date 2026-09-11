// ============================ Trade Arbiter (Phase 3) ============================
// The SOLE gate before display. Takes the up-to-three scored candidates (Setup /
// Directional / Scalp) for a symbol and resolves them into exactly ONE actionable
// primary trade — the user never sees two competing GO cards.
//
// Verdicts:
//   GO       — one primary (highest finalScore) + an optionally demoted secondary.
//   WAIT     — nothing is actionable right now.
//   CONFLICT — the top two candidates OPPOSE each other and are too close to
//              separate honestly. Never silently resolved to a guessed GO.
//
// Pure module: no I/O, no logging. Thresholds come from config/arbitration.ts.

import { CONFIG } from "../../config/arbitration";

export type ArbiterMode = "Setup" | "Directional" | "Scalp";
export type ArbiterVerdict = "GO" | "WAIT" | "CONFLICT";

export interface ArbiterCandidate {
  mode: ArbiterMode;
  direction: "Bullish" | "Bearish";
  finalScore: number;    // 52..62 from tradeScore
  setupQuality: number;  // 0..100
  eligible: boolean;     // passed its own trigger/gate (OI TAKE, 5m+15m, etc.)
  vetoed?: boolean;      // premiumSentiment Decaying (hard veto)
  suppressed?: boolean;  // tradeDedup suppressed
}

export interface SuppressedCandidate extends ArbiterCandidate { why: string; }

export interface ArbiterResult {
  verdict: ArbiterVerdict;
  primary: ArbiterCandidate | null;
  secondary: ArbiterCandidate | null; // demoted (shown as context, not a 2nd action)
  suppressed: SuppressedCandidate[];   // everything not chosen, with the reason
  reason: string;
}

function whyOut(c: ArbiterCandidate): string {
  if (c.vetoed) return "VETO — premium Decaying";
  if (c.suppressed) return "deduped — no re-entry yet";
  if (!c.eligible) return "not eligible (trigger not met)";
  if (c.setupQuality < CONFIG.setupQuality.displayThreshold) return `below clarity (${c.setupQuality}<${CONFIG.setupQuality.displayThreshold})`;
  return "lost arbitration";
}

export function arbitrate(candidates: ArbiterCandidate[]): ArbiterResult {
  const { conflictScoreMargin, setupQualityMinForOverride } = CONFIG.arbitration;
  const displayMin = CONFIG.setupQuality.displayThreshold;

  const actionable = candidates.filter(
    (c) => c.eligible && !c.vetoed && !c.suppressed && c.setupQuality >= displayMin,
  );
  const notActionable = candidates.filter((c) => !actionable.includes(c));
  const suppressed: SuppressedCandidate[] = notActionable.map((c) => ({ ...c, why: whyOut(c) }));

  if (!actionable.length) {
    return { verdict: "WAIT", primary: null, secondary: null, suppressed, reason: "no actionable candidate" };
  }

  // Rank by finalScore, then clarity.
  const ranked = [...actionable].sort((a, b) => (b.finalScore - a.finalScore) || (b.setupQuality - a.setupQuality));
  const top = ranked[0];
  const next = ranked[1] || null;

  if (!next) {
    return { verdict: "GO", primary: top, secondary: null, suppressed, reason: `single candidate (${top.mode})` };
  }

  const opposing = top.direction !== next.direction;
  const close = top.finalScore - next.finalScore <= conflictScoreMargin;

  if (opposing && close) {
    // Clarity tie-breaker: if exactly ONE of the two clears the override bar,
    // clarity promotes it to GO; otherwise it's a genuine CONFLICT.
    const topClears = top.setupQuality >= setupQualityMinForOverride;
    const nextClears = next.setupQuality >= setupQualityMinForOverride;
    if (topClears && !nextClears) {
      return { verdict: "GO", primary: top, secondary: next, suppressed: [...suppressed, { ...next, why: `demoted — opposing, lower clarity (${next.setupQuality}<${setupQualityMinForOverride})` }], reason: `clarity override: ${top.mode} clears ${setupQualityMinForOverride}` };
    }
    if (nextClears && !topClears) {
      return { verdict: "GO", primary: next, secondary: top, suppressed: [...suppressed, { ...top, why: `demoted — opposing, lower clarity (${top.setupQuality}<${setupQualityMinForOverride})` }], reason: `clarity override: ${next.mode} clears ${setupQualityMinForOverride}` };
    }
    return {
      verdict: "CONFLICT", primary: null, secondary: null,
      suppressed: [...suppressed, { ...top, why: "conflict" }, { ...next, why: "conflict" }],
      reason: `${top.mode} ${top.direction} vs ${next.mode} ${next.direction} within ${conflictScoreMargin} pts — no clear winner`,
    };
  }

  // Same direction, or a clear score gap → GO the leader, demote the rest.
  const demoted = ranked.slice(1).map((c) => ({ ...c, why: `demoted — ${top.mode} leads (${top.finalScore} vs ${c.finalScore})` }));
  return { verdict: "GO", primary: top, secondary: next, suppressed: [...suppressed, ...demoted], reason: opposing ? `${top.mode} leads by >${conflictScoreMargin} pts` : `${top.mode} leads; ${next.mode} agrees (same side)` };
}
