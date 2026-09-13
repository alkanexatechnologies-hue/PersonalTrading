// ============================ Option Top Pick — config ============================
// Every threshold this module uses, named and in one place (same convention as
// backend/config/arbitration.ts and backend/liquidity/liquidityConfig.ts).

export const OTP_CONFIG = {
  // Per-stock CE/PE directional lean (reused by the Liquidity Directional track).
  // OI structure counts double every other vote; max = sum of all seven (2+1*6=8).
  votes: {
    oiWeight: 2, priceStructureWeight: 1, vwapWeight: 1, emaCrossWeight: 1,
    candleStructureWeight: 1, pcrWeight: 1, momentumWeight: 1,
  },
  maxScore: 8,
  minScoreEdge: 2, // a tied/near-tied lean is not a real edge — never force a signal
  minWinningScore: 4,

  // VWAP: count crosses over this many recent 5m bars; more than
  // maxCrossesBeforeChoppy flips vwapStatus to "Choppy" regardless of current side.
  vwap: { lookbackBars: 12, maxCrossesBeforeChoppy: 3 },

  // Part 8 — movement-stage thresholds, expressed as a multiple of today's
  // ATR% (the stock's own "normal move" yardstick, not a fixed point count —
  // unlike the old index-only room formula, a flat point threshold doesn't
  // generalize across a ₹200 stock and a ₹4,000 stock).
  movement: {
    earlyMaxRatio: 0.3,      // |move%| < 0.3x ATR% -> EARLY MOVE
    movingMaxRatio: 1.0,     // < 1.0x -> MOVING
    strongMaxRatio: 1.8,     // < 1.8x -> STRONG MOVE, else EXTENDED
    pullbackMinRatio: 0.5,   // retracement only counts as a "pullback" once real movement happened
    pullbackMinRetrace: 0.3, // >=30% given back from today's extreme, in the move's direction
    reversalMinRatio: 1.0,   // momentum divergence only flagged once the move is significant
  },

  // Part 10 — Option Quality Score weights, ONE distribution per track (kept
  // identical between tracks so the two scores are comparable in scale, even
  // though what feeds "Liquidity/Flow" is zero for Stock Setup by definition —
  // see stockSetupScore.ts). Must sum to 100. "Spread" uses OI depth as a proxy
  // (no bid/ask anywhere in this app's option data feed — disclosed in the UI).
  quality: {
    stockDirectionPct: 20, stockSetupPct: 20, liquidityFlowPct: 20,
    momentumPct: 15, optionLiquidityPct: 10, volumePct: 5, spreadPct: 5, roomRewardPct: 5,
  },

  gates: {
    minQualityScoreTopPick: 60, // below this -> WATCH, not TOP PICK
    minQualityScoreWatch: 40,   // below this -> NO_EDGE
    minOiConfidenceLiquidity: 30, // Liquidity Directional track requires real OI confirmation
  },

  // Part 4A — Liquidity Directional track thresholds.
  liquidity: {
    minRvol: 1.3,           // relative-volume expansion floor
    strongRvol: 2.0,
    minPremiumChangePct: 3, // option premium must actually be moving, not just OI
  },

  // Room to the opposing wall for a STOCK (not the index-point-scale formula):
  // relative to the stock's own price and expected move, never a fixed point count.
  room: { spotPctFloor: 0.006 },

  // Entry/target/stop off option premium. Two targets (Part 11/13): a
  // conservative first target and a stretch second target, plus the R:R this implies.
  premium: { target1Pct: 0.20, target2Pct: 0.35, stopPct: -0.12 },

  // A fresh directional flip must hold this long, on the SAME side, before
  // it's eligible to move past WATCH toward TOP PICK.
  confirmation: { minHoldMinutes: 3 },

  // Part 12 — no-chase: premium already this extended vs its confirmation-time
  // reading means "wait for pullback", even if every gate otherwise passes.
  pullback: { extendedPct: 0.25 },

  // No NEW option BUY after this IST minute-of-day (14:30) — carried over from
  // this module's earlier spec; distinct from ORB's own 14:30 veto
  // (backend/orb/OpeningRangeBreakoutEngine.ts) and signals/filters.ts's
  // default-off 14:45 filter — this is Option Top Pick's own, always-on cutoff.
  timeFilter: { newBuyCutoffMinuteIST: 14 * 60 + 30 },

  // OI chain staleness — matches the SAME 90s threshold already used by
  // /oi-command and oi/oiTrade.ts, rather than inventing a new number.
  freshness: { oiStaleSec: 90 },

  // Part 6 — scanner limits: cap how many F&O stocks get a full evaluation per
  // scan (cost control — each candidate needs candles + an OI chain fetch) and
  // how many OI fetches run concurrently (mirrors /api/quotes's own chunk-of-5
  // pattern so this scan never bursts past the same Groww rate budget).
  scan: { maxCandidates: 60, oiConcurrency: 5, topN: 8 },

  auditLog: { cap: 500 },
} as const;
