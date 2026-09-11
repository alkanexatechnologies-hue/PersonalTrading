import { BacktestParams, BacktestResult, Candle, Interval, Trade } from "../types";
import { computeScoreSeries } from "../signals/score";
import { computeFilters, FilterOptions } from "../signals/filters";

const DEFAULT_PARAMS: BacktestParams = {
  stopLossPercent: 0.5,
  targetPercent: 1.0,
  allowShort: true,
  entryThreshold: 30,
  // Realistic discount-broker round-trip for CASH intraday, as % of turnover:
  //   brokerage ~0.06% + STT ~0.025% + exchange/GST/stamp ~0.02% + slippage ~0.10%
  //   ~= 0.20%. Kept slightly conservative. Set 0 to see gross (old behaviour).
  roundTripCostPercent: 0.2,
};

function isNewDay(a: number, b: number): boolean {
  return (
    new Date(a * 1000).toISOString().slice(0, 10) !==
    new Date(b * 1000).toISOString().slice(0, 10)
  );
}

/**
 * Event-driven intraday backtest.
 * - Enters LONG when score >= threshold, SHORT when score <= -threshold.
 * - Exits on stop-loss, target, signal flip, or end-of-day square-off.
 * - One position at a time, one unit sizing (results reported in % terms).
 */
export function runBacktest(
  symbol: string,
  interval: Interval,
  candles: Candle[],
  paramsIn?: Partial<BacktestParams>,
  filterOpts?: Partial<FilterOptions>
): BacktestResult {
  const params: BacktestParams = { ...DEFAULT_PARAMS, ...paramsIn };
  const scores = computeScoreSeries(candles);
  const filters = computeFilters(candles, filterOpts);
  const trades: Trade[] = [];

  let position: null | {
    side: "LONG" | "SHORT";
    entryTime: number;
    entryPrice: number;
    stop: number;
    target: number;
  } = null;

  // Fall back to the default when a caller passes the key as explicit `undefined`
  // (object-spread clobbers the default in that case). Only an explicit 0 = gross.
  const costPct = Math.max(0, params.roundTripCostPercent ?? DEFAULT_PARAMS.roundTripCostPercent ?? 0);
  const closeTrade = (exitPrice: number, exitTime: number, reason: Trade["exitReason"]) => {
    if (!position) return;
    const dir = position.side === "LONG" ? 1 : -1;
    const grossPnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100 * dir;
    const pnlPercent = grossPnlPercent - costPct; // charge full round-trip cost to the trade
    const costAbs = (costPct / 100) * position.entryPrice;
    trades.push({
      side: position.side,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      exitTime,
      exitPrice,
      pnl: (exitPrice - position.entryPrice) * dir - costAbs,
      pnlPercent,
      grossPnlPercent: round2(grossPnlPercent),
      costPercent: round2(costPct),
      exitReason: reason,
    });
    position = null;
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const score = scores[i];

    // End-of-day square-off (intraday only).
    if (position && isNewDay(candles[i - 1].time, c.time)) {
      closeTrade(candles[i - 1].close, candles[i - 1].time, "eod");
    }

    // Manage open position against this bar's range.
    if (position) {
      if (position.side === "LONG") {
        if (c.low <= position.stop) closeTrade(position.stop, c.time, "stop");
        else if (c.high >= position.target) closeTrade(position.target, c.time, "target");
      } else {
        if (c.high >= position.stop) closeTrade(position.stop, c.time, "stop");
        else if (c.low <= position.target) closeTrade(position.target, c.time, "target");
      }
    }

    // Signal-based exit (flip) then entry.
    if (position && score != null) {
      const flip =
        (position.side === "LONG" && score <= -params.entryThreshold) ||
        (position.side === "SHORT" && score >= params.entryThreshold);
      if (flip) closeTrade(c.close, c.time, "signal");
    }

    if (!position && score != null) {
      if (score >= params.entryThreshold && filters.longOk[i]) {
        position = {
          side: "LONG",
          entryTime: c.time,
          entryPrice: c.close,
          stop: c.close * (1 - params.stopLossPercent / 100),
          target: c.close * (1 + params.targetPercent / 100),
        };
      } else if (params.allowShort && score <= -params.entryThreshold && filters.shortOk[i]) {
        position = {
          side: "SHORT",
          entryTime: c.time,
          entryPrice: c.close,
          stop: c.close * (1 + params.stopLossPercent / 100),
          target: c.close * (1 - params.targetPercent / 100),
        };
      }
    }
  }

  // Close any dangling position at the last price.
  if (position) {
    const lastC = candles[candles.length - 1];
    closeTrade(lastC.close, lastC.time, "eod");
  }

  return summarize(symbol, interval, candles.length, trades, params);
}

function summarize(
  symbol: string,
  interval: Interval,
  candleCount: number,
  trades: Trade[],
  params: BacktestParams
): BacktestResult {
  const wins = trades.filter((t) => t.pnlPercent > 0);
  const losses = trades.filter((t) => t.pnlPercent <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlPercent, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0));
  const netPnlPercent = trades.reduce((s, t) => s + t.pnlPercent, 0);
  const grossPnlPercent = trades.reduce((s, t) => s + (t.grossPnlPercent ?? t.pnlPercent), 0);
  const totalCostPercent = trades.reduce((s, t) => s + (t.costPercent ?? 0), 0);
  const costPerTradePercent = trades.length ? totalCostPercent / trades.length : 0;

  // Equity curve (starting at 100, compounding each trade's % result).
  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  const equityCurve: { time: number; equity: number }[] = [
    { time: trades[0]?.entryTime ?? 0, equity: 100 },
  ];
  for (const t of trades) {
    equity *= 1 + t.pnlPercent / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
    equityCurve.push({ time: t.exitTime, equity: round2(equity) });
  }

  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy =
    (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;

  return {
    symbol,
    interval,
    candles: candleCount,
    trades,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round2(winRate),
    netPnlPercent: round2(netPnlPercent),
    grossPnlPercent: round2(grossPnlPercent),
    totalCostPercent: round2(totalCostPercent),
    costPerTradePercent: round2(costPerTradePercent),
    avgWinPercent: round2(avgWin),
    avgLossPercent: round2(avgLoss),
    profitFactor: grossLoss ? round2(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    maxDrawdownPercent: round2(maxDd),
    expectancyPercent: round2(expectancy),
    equityCurve,
    params,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
