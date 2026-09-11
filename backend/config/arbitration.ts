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
};

export type ArbitrationConfig = typeof CONFIG;
