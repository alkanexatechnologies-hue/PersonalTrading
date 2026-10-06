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
    emaFast: 9,
    emaSlow: 21,
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
    slMaxAtr: 0,                   // research: >0 caps stop distance at N ATR (0 = structural stop, V1 behaviour)
    targetAtrMult: 2.5,
    targetMinAtr: 0,               // research: >0 skips S/R targets closer than N ATR (0 = nearest level, V1 behaviour)
    minHistory: 30,
    warmupCandles: 75,             // ~1 session of 5m; window's first candle already has minHistory behind it
    lateCutoffMinIST: 14 * 60 + 30, // 14:30 IST (870) — no NEW entry after (§8)
    cooldownCandles: 2,
    oneOpenTrade: true,
    timeExitBars: 12,
    futuresBinding: "strict",      // §1/§6: date-correct binding; invalid => WAIT. (UI may pass spot-fallback research variant.)
    dataMode: "FUTURES_INTERNAL",  // §3 primary validation mode (internally consistent futures)
    rrGateMode: "ON",              // §11 research switch (never auto-changed)
    buyThreshold: 55,
    sellThreshold: 55,
    ablationDisable: [],
  };
}
