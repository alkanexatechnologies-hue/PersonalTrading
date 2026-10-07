// ============================================================================
// EVIDENCE SCORECARD — measured, not invented.
//
// Source runs (spot index 5m candles from Dhan, strict no-look-ahead, fill at
// the next candle's open, SL-first on ambiguous bars, results in UNDERLYING R,
// BEFORE costs):
//   Apr 1 – Jul 31 2026 (83 sessions): data/breakout-replay/run-20261007091316
//   Aug 1 – Oct 6 2026  (45 sessions): data/breakout-replay/run-20261007015015
//   S1 = Test Lab scorer in SPOT_DIRECTION mode (the "before" engine of those runs)
//   S2 = Breakout Engine (the "after" engine of those runs)
//
// Gate (fixed BEFORE live observation, never tuned to a live day):
//   1. the setup's avg R must be > 0 for this index in BOTH periods;
//   2. pooled avg R is shrunk toward zero: shrunkR = avgR × n / (n + K), K = 50;
//   3. this trade's option friction (paper engine cost model) is subtracted in R;
//   4. netEvR must be > 0.
// An index / setup with no measured evidence never passes.
//
// Entry hour evidence (S1, both periods negative from 14:00): see LATE_ENTRY_CUTOFF.
// ============================================================================

import { SetupId, EvidenceSummary } from "./types";

export const SHRINK_K = 50;
export const LATE_ENTRY_CUTOFF_MIN = 14 * 60;   // S1 14:xx entries: −0.212R (Apr–Jul, n=44), −0.323R (Aug–Oct, n=20)

interface Period { n: number; avgR: number }
type Card = Record<string, { aprJul: Period; augOct: Period }>;

export const SCORECARD: Record<SetupId, { label: string; byIndex: Card }> = {
  S1_MOMENTUM: {
    label: "Momentum continuation (Test Lab scorer)",
    byIndex: {
      NIFTY:     { aprJul: { n: 86, avgR: 0.339 }, augOct: { n: 46, avgR: 0.407 } },
      BANKNIFTY: { aprJul: { n: 88, avgR: 0.084 }, augOct: { n: 44, avgR: -0.193 } },
      FINNIFTY:  { aprJul: { n: 89, avgR: 0.143 }, augOct: { n: 40, avgR: 0.063 } },
      SENSEX:    { aprJul: { n: 95, avgR: 0.295 }, augOct: { n: 46, avgR: 0.085 } },
    },
  },
  S2_BREAKOUT: {
    label: "Level breakout / breakdown (Breakout Engine)",
    byIndex: {
      NIFTY:     { aprJul: { n: 51, avgR: 0.122 }, augOct: { n: 28, avgR: 0.012 } },
      BANKNIFTY: { aprJul: { n: 33, avgR: 0.072 }, augOct: { n: 26, avgR: -0.220 } },
      FINNIFTY:  { aprJul: { n: 49, avgR: 0.395 }, augOct: { n: 32, avgR: 0.067 } },
      SENSEX:    { aprJul: { n: 42, avgR: -0.099 }, augOct: { n: 19, avgR: -0.101 } },
    },
  },
};

const SOURCE = "Replays Apr–Jul + Aug–Oct 2026, spot 5m, next-open fill, before costs (data/breakout-replay)";

/** Evidence for one setup on one index, given this trade's cost in R (null = cost unknown). */
export function evaluateEvidence(setup: SetupId, index: string, costR: number | null): EvidenceSummary {
  const card = SCORECARD[setup]?.byIndex[index];
  if (!card) {
    return { setup, index, samples: 0, avgR: null, shrunkR: null, costR, netEvR: null, passes: false, source: SOURCE,
      note: `No measured evidence for ${setup} on ${index} — unproven, cannot trade` };
  }
  const n = card.aprJul.n + card.augOct.n;
  const avgR = (card.aprJul.n * card.aprJul.avgR + card.augOct.n * card.augOct.avgR) / n;
  const shrunkR = avgR * n / (n + SHRINK_K);
  const bothPositive = card.aprJul.avgR > 0 && card.augOct.avgR > 0;
  const netEvR = costR != null ? shrunkR - costR : null;
  const passes = bothPositive && netEvR != null && netEvR > 0;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const note = !bothPositive
    ? `Not positive in both periods (Apr–Jul ${card.aprJul.avgR}R, Aug–Oct ${card.augOct.avgR}R) — evidence only`
    : netEvR == null ? "Option cost unknown — cannot confirm positive EV"
    : netEvR > 0 ? `Expected ${r3(shrunkR)}R (shrunk) − cost ${r3(costR!)}R = +${r3(netEvR)}R`
    : `Expected ${r3(shrunkR)}R (shrunk) does not cover cost ${r3(costR!)}R`;
  return { setup, index, samples: n, avgR: r3(avgR), shrunkR: r3(shrunkR), costR: costR != null ? r3(costR) : null,
    netEvR: netEvR != null ? r3(netEvR) : null, passes, source: SOURCE, note };
}

/** Can this setup trade on this index at all (before the per-trade cost is known)? */
export function setupEligible(setup: SetupId, index: string): boolean {
  const card = SCORECARD[setup]?.byIndex[index];
  return !!card && card.aprJul.avgR > 0 && card.augOct.avgR > 0;
}
