// Test Lab configuration — instrument-agnostic. NO hard-coded NIFTY points,
// strikes, ATR thresholds or expiry weekdays. Instrument-specific facts come
// from this master + the Dhan scrip master (futuresResolver).

import { IndexInstrumentConfig, IndexKey, TestConfig, TfKey } from "./types";

export const INDEX_MASTER: Record<IndexKey, IndexInstrumentConfig> = {
  NIFTY:     { key: "NIFTY",     internalSymbol: "^NSEI",     nseSymbol: "NIFTY",     spotSegment: "IDX_I", futSegment: "NSE_FNO", futInstrument: "FUTIDX", strikeStep: 50 },
  BANKNIFTY: { key: "BANKNIFTY", internalSymbol: "^NSEBANK",  nseSymbol: "BANKNIFTY", spotSegment: "IDX_I", futSegment: "NSE_FNO", futInstrument: "FUTIDX", strikeStep: 100 },
  FINNIFTY:  { key: "FINNIFTY",  internalSymbol: "^CNXFIN",   nseSymbol: "FINNIFTY",  spotSegment: "IDX_I", futSegment: "NSE_FNO", futInstrument: "FUTIDX", strikeStep: 50 },
  SENSEX:    { key: "SENSEX",    internalSymbol: "^BSESN",    nseSymbol: "SENSEX",    spotSegment: "IDX_I", futSegment: "BSE_FNO", futInstrument: "FUTIDX", strikeStep: 100 },
};

export const TF_MINUTES: Record<TfKey, number> = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "25m": 25, "60m": 60 };
// Dhan /charts/intraday supports interval minutes 1,5,15,25,60 natively.
// 3m is NOT native → resampled from 1m (documented deviation).
export const DHAN_NATIVE_INTRADAY = new Set([1, 5, 15, 25, 60]);

// Fixed V1 baseline (spec §51: do NOT auto-optimize; a change is a FINDING).
export function defaultConfig(index: IndexKey, timeframe: TfKey): TestConfig {
  return {
    index,
    timeframe,
    scope: { mode: "custom" },
    emaFast: 21,                   // user choice 2026-10-05: EMA 21 / EMA 50 (was 9 / 21)
    emaSlow: 50,
    atrPeriod: 14,
    utKeyValue: 1,
    utAtrPeriod: 10,
    regLookback: 20,
    srLookback: 20,
    volLookback: 20,
    volExpansionMult: 1.5,
    volWeakMult: 0.6,
    extendedAtrMult: 3.0,
    rrMin: 2.0,
    slAtrBuffer: 0.5,
    targetAtrMult: 2.5,
    minHistory: 30,
    sessionOpenMinIST: 9 * 60 + 15,  // 09:15 IST — session open / first tradable bar
    lateCutoffMinIST: 15 * 60 + 10,  // 15:10 IST — no NEW entry at/after 15:10 (fill uses next open)
    cooldownCandles: 2,
    oneOpenTrade: true,
    timeExitBars: 0,               // 0 = no time exit: hold until SL/Target, square off at session end (user rule 2026-10-05)
    futuresBinding: "strict",      // §1/§6: date-correct binding; invalid => WAIT. (UI may pass spot-fallback research variant.)
    dataMode: "FUTURES_INTERNAL",  // §3 primary validation mode (internally consistent futures)
    rrGateMode: "OFF",             // R:R is information only — it never blocks BUY/SELL (user rule 2026-10-05)
    buyThreshold: 55,
    sellThreshold: 55,
    ablationDisable: [],
    warmupSessions: 5,             // prior sessions loaded ONLY for warmup (never scored); 5 x 75 > the decision layer's 300-candle level window, so a test run sees the same history as live
    decision: defaultDecisionConfig(),
  };
}

// Trade Decision layer defaults. Chosen a priori from common price-action
// conventions BEFORE any 2026-10-01 result was seen; never auto-optimized.
export function defaultDecisionConfig() {
  return {
    dispStrongAtr: 0.6,
    closeLocMax: 0.35,
    preLevelAtr: 0.35,
    falseBreakBars: 3,
    zoneLookback: 6,
    zoneMaxAtr: 2.0,
    targetMinAtr: 1.0,
    genuineMoveAtr: 2.0,
    bigMoveAtr: 3.0,
    strikeOffsets: 3,
    minPremium: 5,
    deltaMin: 0.2,
    deltaMax: 0.8,
    minTradesForRate: 30,
    optionData: "ON" as "ON" | "OFF",
    requireEngineAgreement: false, // superseded 2026-10-05 by precisionChain (same indicators, each checked individually)
    directionGuard: true,          // 2026-10-05: 5M direction-conflict + S/R rejection protection (new entries only)
    precisionChain: true,          // 2026-10-05 flow: each precision item must agree with the trade direction
  };
}

// Option-expiry rule per index for the historical (rolling) option series: the
// expired-options API does not return the expiry date, so time-to-expiry is
// derived from the exchange schedule (weekday; shifted to the prior trading day
// on a holiday). Labelled "derived" wherever it is used.
export const OPTION_EXPIRY_RULE: Record<IndexKey, { flag: "WEEK" | "MONTH"; weekday: number }> = {
  NIFTY: { flag: "WEEK", weekday: 2 },      // Tuesday weekly
  BANKNIFTY: { flag: "MONTH", weekday: 2 }, // last Tuesday monthly
  FINNIFTY: { flag: "MONTH", weekday: 2 },
  SENSEX: { flag: "WEEK", weekday: 4 },     // Thursday weekly (BSE)
};
