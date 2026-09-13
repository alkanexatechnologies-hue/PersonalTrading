// ============================ Arbitration / scoring config ============================
// SINGLE SOURCE OF TRUTH for every threshold introduced by the sentiment/liquidity/
// risk extension + the trade arbiter. Modules read from here rather than inlining
// literals, so the "am I missing good trades / taking too many?" question is
// answered by tuning ONE number, not hunting through six files.

export const CONFIG = {
  // tradeScore.ts — the finalScore clamp. The 52..62 band is the real governor:
  // no stack of soft bonuses can inflate a weak edge past the ceiling.
  tradeScore: { floor: 52, ceiling: 62 },

  // Step 10 display threshold. Below this a trade is still computed + logged
  // (kept in backtest data) but hidden from the UI.
  setupQuality: { displayThreshold: 30 },

  // tradeArbiter.ts — how it resolves competing candidates into ONE primary.
  //  conflictScoreMargin: if the top two OPPOSING candidates are within this many
  //    finalScore points, it's a genuine CONFLICT (don't guess a GO).
  //  setupQualityMinForOverride: a clarity tie-breaker — if exactly one of the two
  //    close/opposing candidates clears this setupQuality, clarity promotes it to
  //    GO instead of declaring CONFLICT.
  arbitration: {
    conflictScoreMargin: 6,
    setupQualityMinForOverride: 50,
    // Watchdog: a CONFLICT that persists beyond this many minutes gets logged to
    // the 'verification' channel (implausibly long conflict = likely a logic bug).
    conflictPersistMinutes: 15,
  },

  // tradeDedup.ts — "meaningfully away and back" is this multiple of ATR.
  dedup: { atrDistanceMultiplier: 1.0 },

  // liquidityGuard consumers — size dampening when the book is Thin. null = not
  // yet applied (tune after a backtest); Thin never blocks, only dampens.
  liquidity: { thinSizePenaltyPct: null as number | null },

  // premiumSentiment.ts — the ONLY EMA in the extension (on the option's own LTP).
  premiumSentiment: { emaPeriod: 9 },

  // paper/engine.ts tryOpenOption() — minimum time before the engine will open a
  // NEW auto-trade on a symbol it just got stopped out of, regardless of strike/
  // price (independent of tradeDedup.ts's price-distance re-arm logic, which only
  // covers re-entry at the SAME wall/fingerprint). Prevents rapid re-entry at a
  // different strike right after a stop-out. Value not specified by the source
  // plan — 15 min chosen as a reasonable default; tune here if too tight/loose.
  cooldown: { afterStopOutMinutes: 15 },

  // Phase 1.3 — ONE canonical PCR threshold pair for "is PCR alone directionally
  // supportive" (put-heavy=bullish, call-heavy=bearish). Previously 5 different
  // pairs existed: oi.ts/growwProvider.ts (1.2/0.7), oiChange.ts (1.2/0.8),
  // oi/bulletin.ts (1.05/0.85), options/highProbAlgo.ts's score-bonus check
  // (1.1/0.85), and commentary/marketCommentary.ts (1.1/0.7). This value matches
  // oiChange.ts, the canonical OIAnalysisEngine (Phase 1.2) — every consumer listed
  // above now reads this instead of its own literal.
  pcr: { bullish: 1.2, bearish: 0.8 },
  // highProbAlgo.ts's trap-fail VETO is an intentional exception: it should only
  // block a trade when PCR strongly CONTRADICTS the idea's direction, a stricter
  // bar than merely "unsupportive" — so it stays more extreme than CONFIG.pcr.
  pcrTrapFail: { bullishFailBelow: 0.7, bearishFailAbove: 1.2 },

  // Phase 2.1 — HEAT CAP ENFORCEMENT POLICY (decision confirmed, intentional split,
  // do NOT re-flag as an inconsistency): the 6% portfolio-heat cap is a HARD BLOCK
  // in paper/engine.ts's tryOpenOption() for ideas that do NOT go through the
  // sentiment/liquidity/risk extension pipeline, and ADVISORY (surfaced via
  // riskComment, never blocking) for extension-scored directional ideas — those are
  // already sized off finalScore (52..62) rather than a flat confidence scale, so
  // the extension's own sizing discipline substitutes for the hard cap. The full
  // rationale + the math for all four capital guards (heat/daily-loss/drawdown/
  // profit-book) lives in paper/ext/riskComment.ts's header comment — this entry
  // is the single pointer to it so the split is discoverable from the one place
  // every other threshold in this app lives, without duplicating the explanation.
  heatCap: { pct: 6, enforcement: "hard-outside-extension, advisory-inside-extension (see paper/ext/riskComment.ts)" },
};

export type ArbitrationConfig = typeof CONFIG;
