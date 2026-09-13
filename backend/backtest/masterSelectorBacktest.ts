import { BacktestMode, FullMasterUnavailableError } from "./backtestMode";
import { historicalOptionChainProvider } from "./historicalOptionChainProvider";
import { MarketSnapshot } from "./marketSnapshot";

// ============================ FULL_MASTER orchestrator ============================
// Where candidate generation -> arbitrate() (paper/ext/tradeArbiter.ts, the
// SAME production Master Trade Selector, completely unmodified) -> risk
// management -> trade simulation would run, once a real
// HistoricalOptionChainProvider exists. Until then, this checks availability
// FIRST and fails safely — it never reaches candidate generation or
// arbitrate() without real option-chain data, so arbitrate() is never called
// with fabricated or reused-from-elsewhere OI.

export interface MasterSelectorBacktestResult {
  mode: BacktestMode;
  blocked: boolean;
  reason?: string;
  checkedSnapshots?: number;
}

export async function runMasterSelectorBacktest(
  mode: BacktestMode,
  symbol: string,
  expiry: string,
  snapshots: MarketSnapshot[]
): Promise<MasterSelectorBacktestResult> {
  if (mode === "TECHNICAL_ONLY") {
    // Layer 1 - unaffected by this file. The caller runs the existing,
    // unmodified backtest/engine.ts runBacktest() for this mode instead.
    return { mode, blocked: false };
  }

  // FULL_MASTER: verify real historical option-chain data exists for every
  // requested moment BEFORE any candidate generation or arbitrate() call.
  for (const snap of snapshots) {
    const chain = await historicalOptionChainProvider.getSnapshot(snap.timestamp, symbol, expiry);
    if (chain === "NOT_AVAILABLE") {
      throw new FullMasterUnavailableError();
    }
  }

  // Not reachable today (historicalOptionChainProvider always returns
  // NOT_AVAILABLE - see that file). Once a real provider exists, this is
  // where OI analysis + candidate generation would build ArbiterCandidate[]
  // per snapshot and call arbitrate() from paper/ext/tradeArbiter.ts unchanged,
  // then feed the result into a risk-management + trade-execution simulator.
  throw new FullMasterUnavailableError();
}
