// ===========================================================================
// InstrumentConfig (V1.2) — generalizes the signal engine across index
// instruments. NO hard-coded prices, strikes, point-distances or expiry
// weekdays: instrument facts come from INDEX_MASTER + the Dhan scrip master,
// and tunables come from the fixed V1 baseline (never optimized here).
// ===========================================================================

import { INDEX_MASTER, defaultConfig } from "./config";
import { IndexKey } from "./types";

export interface InstrumentConfig {
  symbol: IndexKey;
  internalSymbol: string;       // app symbol e.g. ^NSEI
  nseSymbol: string;            // Dhan underlying e.g. NIFTY
  exchange: "NSE" | "BSE";
  futSegment: "NSE_FNO" | "BSE_FNO";
  tickSize: number;             // instrument tick (config-driven; not a signal threshold)
  lotSize: number | null;       // from scrip master at bind time (null until resolved)
  futuresBindingRule: "date-correct-front-month"; // §23
  session: { openMinIST: number; closeMinIST: number }; // 09:15 / 15:10 (test-lab trade window)
  timeZone: "Asia/Kolkata";
  vwapRule: "session-reset-same-instrument";       // §7/§23
  atrPeriod: number;
  emaFast: number;
  emaSlow: number;
  rrMin: number;
  lateCutoffMinIST: number;     // no NEW entry at/after 15:10 IST
  expiryRules: "scrip-master-SM_EXPIRY_DATE";      // §22 (no weekday hard-code)
  liquidityRules: "resolved-futures-volume-oi";
}

// Per-index tick size (purely instrument metadata — NOT a signal parameter).
const TICK: Record<IndexKey, number> = { NIFTY: 0.05, BANKNIFTY: 0.05, FINNIFTY: 0.05, SENSEX: 0.05 };

export function instrumentConfig(index: IndexKey): InstrumentConfig {
  const m = INDEX_MASTER[index];
  const d = defaultConfig(index, "5m"); // baseline tunables (fixed; not optimized)
  return {
    symbol: index,
    internalSymbol: m.internalSymbol,
    nseSymbol: m.nseSymbol,
    exchange: m.futSegment === "BSE_FNO" ? "BSE" : "NSE",
    futSegment: m.futSegment,
    tickSize: TICK[index],
    lotSize: null,
    futuresBindingRule: "date-correct-front-month",
    session: { openMinIST: 9 * 60 + 15, closeMinIST: 15 * 60 + 10 },
    timeZone: "Asia/Kolkata",
    vwapRule: "session-reset-same-instrument",
    atrPeriod: d.atrPeriod,
    emaFast: d.emaFast,
    emaSlow: d.emaSlow,
    rrMin: d.rrMin,
    lateCutoffMinIST: d.lateCutoffMinIST,
    expiryRules: "scrip-master-SM_EXPIRY_DATE",
    liquidityRules: "resolved-futures-volume-oi",
  };
}
