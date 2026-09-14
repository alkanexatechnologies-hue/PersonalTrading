// ============================ Watchlist — early-warning scanner ============================
// The watchlist is a WARNING scanner, not a BUY generator. It reuses the
// Liquidity Status engine (backend/liquidityStatus/engine.ts) verbatim for every
// watched symbol - the SAME trend (VWAP/EMA/structure), momentum (ATR/RSI/move
// stage), volume (RVOL), options (OI change + premium evidence), structure
// (support/resistance + trigger/invalidation) and 0-100 score already computed
// there - and only MAPS those existing outputs onto the watch columns and ranks
// them. No indicator/OI/Directional/Setup/Scalp logic is duplicated or invented
// here, and no automatic BUY is produced: the engine's own advisory action is
// surfaced as-is (a stale/missing feed becomes DATA UNAVAILABLE, never a signal).

import { LiquidityStatusDeps, LiquidityStatusResult, MoveStage, TraderAction } from "../liquidityStatus/types";
import { evaluateLiquidityStatus } from "../liquidityStatus/engine";
import { DISCLAIMER, SymbolDef } from "../config";

export type WatchStage =
  | "QUIET" | "BUILDING" | "BREAKOUT WATCH" | "EARLY MOVE" | "DEVELOPING" | "STRONG MOVE" | "EXTENDED" | "REVERSAL WATCH";

export type WatchAction = "WATCH" | "BREAKOUT READY" | "WAIT FOR PULLBACK" | "TAKE" | "AVOID CHASING";
export type WatchDataState = "OK" | "STALE" | "UNAVAILABLE";

export interface WatchRow {
  symbol: string;
  name: string;
  score: number; // 0..100 Watch Score (= Liquidity Flow Score)
  bias: "Bullish" | "Bearish" | "Neutral" | "Conflict";
  stage: WatchStage;
  price: number | null;
  trigger: number | null;
  invalidation: number | null;
  action: WatchAction;
  dataState: WatchDataState; // when not OK the UI shows DATA UNAVAILABLE / WAIT
  note: string;
}

export interface WatchlistScanResult {
  rows: WatchRow[];
  scannedCount: number;
  generatedAt: number;
  disclaimer: string;
}

/** Map the engine's movement stage (+ its advisory action, which encodes
 * "trigger set but not yet crossed") onto the 8 watch stages. Priority is
 * high-magnitude first so an extended/reversing move can never be mislabelled
 * as an early one. Pure + deterministic → unit-tested. */
export function toWatchStage(moveStage: MoveStage, action: TraderAction, score: number): WatchStage {
  if (moveStage === "EXTENDED") return "EXTENDED";
  if (moveStage === "EXHAUSTION" || moveStage === "REVERSAL_WATCH") return "REVERSAL WATCH";
  if (moveStage === "STRONG_MOVE") return "STRONG MOVE";
  if (action === "WAIT FOR BREAKOUT" || action === "WAIT FOR BREAKDOWN") return "BREAKOUT WATCH";
  if (moveStage === "DEVELOPING") return "DEVELOPING";
  if (moveStage === "EARLY_MOVE") return "EARLY MOVE";
  if (moveStage === "PULLBACK") return "BUILDING";
  // PRE_MOVE: quiet unless the flow score is already picking up.
  return score >= 25 ? "BUILDING" : "QUIET";
}

/** Map the engine's advisory action onto the 5 watch actions. The watchlist
 * never manufactures a BUY: this only relabels what the Liquidity Status engine
 * already decided (itself advisory-only). Pure + deterministic → unit-tested. */
export function toWatchAction(action: TraderAction): WatchAction {
  switch (action) {
    case "AVOID CHASING": return "AVOID CHASING";
    case "WAIT FOR PULLBACK": return "WAIT FOR PULLBACK";
    case "WAIT FOR BREAKOUT":
    case "WAIT FOR BREAKDOWN": return "BREAKOUT READY";
    case "PREPARE FOR BUY":
    case "PREPARE FOR SELL": return "TAKE";
    default: return "WATCH"; // WATCH / NO TRADE / REDUCE RISK / HOLD EXISTING POSITION
  }
}

export function toWatchRow(r: LiquidityStatusResult): WatchRow {
  const dataState: WatchDataState = r.freshness.oiStale || r.freshness.liveFeedStale ? "STALE" : "OK";
  const stage = toWatchStage(r.moveStage, r.traderAction, r.liquidityFlowScore.score);
  const action = toWatchAction(r.traderAction);
  return {
    symbol: r.symbol,
    name: r.name,
    score: r.liquidityFlowScore.score,
    bias: r.directionBias,
    stage,
    price: r.spot,
    trigger: r.trigger?.level ?? null,
    invalidation: r.invalidation?.level ?? null,
    action,
    dataState,
    note: dataState === "STALE"
      ? "Data stale — treat as WAIT, not a live read."
      : r.traderActionDetail || r.systemView,
  };
}

/** A watched symbol whose data can't be evaluated (too little history, feed
 * down) — reported honestly, never dropped and never guessed. */
function unavailableRow(def: SymbolDef): WatchRow {
  return {
    symbol: def.symbol, name: def.name, score: 0, bias: "Neutral", stage: "QUIET",
    price: null, trigger: null, invalidation: null, action: "WATCH",
    dataState: "UNAVAILABLE", note: "DATA UNAVAILABLE — no fresh data to evaluate.",
  };
}

export async function scanWatchlist(deps: LiquidityStatusDeps): Promise<WatchlistScanResult> {
  const universe = deps.listEligibleStocks();
  const rows: WatchRow[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const chunk = universe.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map(async (def) => {
      try { return toWatchRow(await evaluateLiquidityStatus(def.symbol, deps)); }
      catch { return unavailableRow(def); }
    }));
    rows.push(...settled);
  }
  // Rank strongest opportunities at the top; unavailable rows sink to the bottom.
  rows.sort((a, b) => {
    if ((a.dataState === "UNAVAILABLE") !== (b.dataState === "UNAVAILABLE")) return a.dataState === "UNAVAILABLE" ? 1 : -1;
    return b.score - a.score;
  });
  return { rows, scannedCount: universe.length, generatedAt: deps.nowEpochSec(), disclaimer: DISCLAIMER };
}
