// ============================ Liquidity Status — config ============================
export const LS_CONFIG = {
  // Section 6 — Liquidity Flow Score weights, must sum to 100.
  score: {
    oiPositioningPct: 20, oiChangePct: 15, priceOiConfirmationPct: 15, rvolPct: 15,
    optionPremiumPct: 10, vwapPct: 10, marketStructurePct: 10, momentumPct: 5,
  },

  // RVOL — reuses optionTopPick/scanner.ts's rvolOf() window (17-bar trailing
  // baseline excluding the measured tail-3), not routes/api.ts's relVolNow(),
  // per the audit's recommendation (cleaner, non-self-diluting baseline).
  rvol: { window: 20, tail: 3, expansion: 1.3, strongExpansion: 2.0 },

  // Section 4/5 — movement stage, relative to the symbol's own daily ATR%.
  movement: {
    preMoveMaxRatio: 0.15, earlyMaxRatio: 0.35, developingMaxRatio: 0.8, strongMaxRatio: 1.8,
    pullbackMinRetrace: 0.3, pullbackMinRatio: 0.4,
    reversalMinRatio: 0.6, exhaustionMinRatio: 1.8,
  },

  // Section 7 — directional confidence quality buckets (never a probability).
  confidence: { veryStrong: 80, strong: 60, moderate: 35, weak: 15 },

  // Section 16 — data freshness. Same thresholds already used elsewhere in this
  // app: OI >90s stale (/oi-command), live feed >30s stale (growwSignalsAllowed()).
  freshness: { oiStaleSec: 90, liveFeedStaleSec: 30 },

  // Section 14/15 — liquidity-shift persistence: only log/record a NEW point in
  // the time-series when the state actually changed, or at most this often.
  shift: { minRecordGapMinutes: 10, historyCap: 30 },

  // Section 19 — scanner limits (mirrors optionTopPick/config.ts's scan section).
  scan: { maxCandidates: 60, oiConcurrency: 5, topN: 10 },

  auditLog: { cap: 500 },
} as const;
