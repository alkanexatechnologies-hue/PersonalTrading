// ============================ Backtest mode ============================
// TECHNICAL_ONLY — the only mode that actually runs today: EMA/Supertrend/
// VWAP/MACD/RSI/Bollinger composite scoring on historical candles (Dhan). No
// OI, no Master Trade Selector. This is Layer 1 and is unchanged/unaffected
// by anything in this file.
//
// FULL_MASTER — the real Master Trade Selector (arbitrate(), unmodified from
// production) running against historical data, INCLUDING option-chain/OI.
// Requires a real HistoricalOptionChainProvider. None exists yet (see
// historicalOptionChainProvider.ts), so this mode always fails safely with
// FullMasterUnavailableError instead of running with fabricated/missing OI.

export type BacktestMode = "TECHNICAL_ONLY" | "FULL_MASTER";

export const DEFAULT_BACKTEST_MODE: BacktestMode =
  process.env.BACKTEST_MODE === "FULL_MASTER" ? "FULL_MASTER" : "TECHNICAL_ONLY";

export class FullMasterUnavailableError extends Error {
  constructor() {
    super("Historical option-chain data unavailable. Full Master Trade Selector backtest cannot be executed.");
    this.name = "FullMasterUnavailableError";
  }
}
