import { HoldTimeframe, Interval, OptionSuggestion, SignalResult, StrikeIdea, TimeDecay } from "../types";
import { SymbolDef, getStrikeStep } from "../config";
import { DIRECTION_THRESHOLD } from "../signals/score";

export interface OptionSizingInput {
  capital?: number; // trading capital in INR
  riskPercent?: number; // % of capital to risk on this trade
  premium?: number | null; // optional live option LTP for exact sizing
  interval?: Interval; // chart interval, used to estimate holding time
}

// Approx minutes per candle for each interval (1d ~ one 6.25h session).
const INTERVAL_MINUTES: Record<Interval, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "1d": 375,
};

// Minimum absolute score before we suggest a directional option trade (the same
// cutoff used everywhere else in the app - see signals/score.ts).
const ENTRY_THRESHOLD = DIRECTION_THRESHOLD;
// ATM options behave with a delta of ~0.5; we use this to translate an
// underlying move into an approximate option-premium move.
const ATM_DELTA = 0.5;
// Common intraday premium stop rule when we don't have a delta-based level.
const PREMIUM_STOP_PCT = 30; // exit if the option premium falls 30%

const OPTION_DISCLAIMER =
  "Option entry, strike, stop-loss and quantity are educational estimates. " +
  "Lot sizes and strike steps change - verify with NSE/your broker. Without a live " +
  "option chain, premium-based figures are approximations (ATM delta ~0.5). " +
  "Options can lose value fast due to time decay and IV; always honour your stop.";

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Turn a directional signal into a concrete option trade idea:
 * CALL or PUT, which strike, entry, stop-loss, target, and how many lots.
 */
export function suggestOptionTrade(
  signal: SignalResult,
  def: SymbolDef,
  sizing: OptionSizingInput = {}
): OptionSuggestion {
  const base: OptionSuggestion = {
    symbol: signal.symbol,
    name: def.name,
    fno: !!def.fno,
    reason: "",
    sizingBasis: "none",
    disclaimer: OPTION_DISCLAIMER,
  };

  if (!def.fno || !def.lotSize) {
    base.reason = "This symbol is not set up for options (no F&O lot size configured).";
    return base;
  }

  if (Math.abs(signal.score) < ENTRY_THRESHOLD) {
    base.reason =
      `Signal is neutral (score ${signal.score}). No clear option entry - ` +
      "buying a CALL or PUT here mostly bleeds premium to time decay. Wait for a directional signal.";
    base.spot = signal.price;
    return base;
  }

  const bullish = signal.score > 0;
  const direction = bullish ? "bullish" : "bearish";
  const optionType = bullish ? "CE" : "PE";
  const spot = signal.price;
  const step = getStrikeStep(spot, def);
  const atm = roundToStep(spot, step);

  // Strike ideas. For a CALL, lower strike = ITM; for a PUT, higher strike = ITM.
  const strikes: StrikeIdea[] = bullish
    ? [
        { moneyness: "ITM", strike: atm - step, note: "Higher delta, costlier, moves more with spot", riskLevel: "Low" },
        { moneyness: "ATM", strike: atm, note: "Balanced delta/cost - default intraday choice", riskLevel: "Medium" },
        { moneyness: "OTM", strike: atm + step, note: "Cheapest, but needs a big fast move; fastest theta bleed", riskLevel: "High" },
      ]
    : [
        { moneyness: "ITM", strike: atm + step, note: "Higher delta, costlier, moves more with spot", riskLevel: "Low" },
        { moneyness: "ATM", strike: atm, note: "Balanced delta/cost - default intraday choice", riskLevel: "Medium" },
        { moneyness: "OTM", strike: atm - step, note: "Cheapest, but needs a big fast move; fastest theta bleed", riskLevel: "High" },
      ];

  // Underlying stop/target come from the signal (ATR-based).
  const underlyingStop = signal.suggestedStopLoss;
  const stopDistance =
    underlyingStop != null ? Math.abs(spot - underlyingStop) : signal.atr ? signal.atr * 1.5 : spot * 0.004;

  // Risk sizing.
  const capital = sizing.capital && sizing.capital > 0 ? sizing.capital : 100000;
  const riskPercent = sizing.riskPercent && sizing.riskPercent > 0 ? sizing.riskPercent : 2;
  const riskBudget = (capital * riskPercent) / 100;
  const premium = sizing.premium && sizing.premium > 0 ? sizing.premium : null;

  // Per-lot risk: if we know the premium, risk = (entry premium - premium stop) * lot.
  // Otherwise approximate the premium move from the underlying move via ATM delta.
  let perLotRisk: number;
  let sizingBasis: OptionSuggestion["sizingBasis"];
  let premiumStop: number | null = null;
  let premiumTarget: number | null = null;

  const deltaPremiumRisk = ATM_DELTA * stopDistance; // premium points lost at underlying stop

  if (premium != null) {
    sizingBasis = "premium";
    // Two stop candidates: delta-implied and a %-of-premium floor; use the tighter loss.
    const deltaStop = premium - deltaPremiumRisk;
    const pctStop = premium * (1 - PREMIUM_STOP_PCT / 100);
    premiumStop = round2(Math.max(0, Math.max(deltaStop, pctStop)));
    const targetDist =
      signal.suggestedTarget != null ? Math.abs(signal.suggestedTarget - spot) * ATM_DELTA : deltaPremiumRisk * 1.6;
    premiumTarget = round2(premium + targetDist);
    perLotRisk = (premium - premiumStop) * def.lotSize;
  } else {
    sizingBasis = "delta-approx";
    perLotRisk = deltaPremiumRisk * def.lotSize;
  }

  let suggestedLots = perLotRisk > 0 ? Math.floor(riskBudget / perLotRisk) : 0;
  if (suggestedLots < 0) suggestedLots = 0;
  const quantity = suggestedLots * def.lotSize;
  const estCapitalRequired = premium != null ? round2(premium * quantity) : null;

  const recStrike = atm;
  const reason =
    `Signal is ${direction} (score ${signal.score}, confidence ${signal.confidence}%). ` +
    `Buy the ${def.name} ${recStrike} ${optionType} (ATM). ` +
    (premium != null
      ? `At LTP ~${premium}, stop the option near ${premiumStop} and target ~${premiumTarget}.`
      : `Enter near the ATM premium; place the stop using the underlying level ${underlyingStop ?? "-"} ` +
        `(≈ ${round2(deltaPremiumRisk)} premium points of risk per unit).`) +
    (suggestedLots < 1
      ? " Note: your capital/risk is too small for even 1 lot at this stop - reduce the stop distance, add capital, or skip."
      : "");

  // --- Holding timeframe: how long to wait for the trade to work ---
  const interval = sizing.interval && INTERVAL_MINUTES[sizing.interval] ? sizing.interval : "5m";
  const perCandle = INTERVAL_MINUTES[interval];
  // Intraday moves from this kind of signal typically resolve within a few bars.
  const holdCandles = interval === "1m" ? 8 : interval === "5m" ? 6 : interval === "15m" ? 4 : 3;
  const holdTimeframe: HoldTimeframe = {
    candles: holdCandles,
    approxMinutes: holdCandles * perCandle,
    note:
      `On the ${interval} chart, expect the move to play out within ~${holdCandles} candles ` +
      `(~${holdCandles * perCandle} min). If it hasn't moved in your favour by then, exit - a stalled ` +
      `long option keeps losing to time decay. Square off intraday positions by ~3:15 PM IST; ` +
      `don't carry a bought option overnight (gap + decay risk).`,
  };

  // --- Time decay (theta) factor ---
  // The recommended strike is ATM, which carries the most time value => highest theta.
  const timeDecay: TimeDecay = {
    level: "High",
    note:
      "ATM options hold the most time value, so theta (time decay) is highest and works against a " +
      "buyer every minute. Decay accelerates near expiry and into the closing hour. Avoid buying " +
      "options in the last ~hour on expiry day (premium can evaporate), and don't 'hope and hold' - " +
      "if the move stalls, time decay quietly erodes the premium even when spot is flat.",
  };

  // --- Which option is high risk to trade ---
  const otm = strikes.find((s) => s.moneyness === "OTM")!;
  const riskLevel: OptionSuggestion["riskLevel"] = "Medium"; // ATM = medium
  const riskNote =
    "Recommended ATM option = MEDIUM risk (balanced cost vs. delta). " +
    `HIGHEST risk is the OTM ${otm.strike} ${optionType}: cheap, but it needs a large, fast move and ` +
    "loses premium quickest to theta - most OTM intraday options expire worthless. " +
    "LOWEST risk is the ITM strike (more intrinsic value, higher delta) but it costs more capital. " +
    "Also note: near-expiry (weekly) options and illiquid single-stock options are riskier than " +
    "liquid index options due to faster decay and wider bid-ask spreads.";

  return {
    ...base,
    reason,
    optionType,
    direction,
    spot: round2(spot),
    atmStrike: recStrike,
    strikes,
    lotSize: def.lotSize,
    suggestedLots,
    quantity,
    capital,
    riskPercent,
    riskBudget: round2(riskBudget),
    perLotRisk: round2(perLotRisk),
    underlyingStop,
    premium,
    premiumStop,
    premiumTarget,
    estCapitalRequired,
    sizingBasis,
    holdTimeframe,
    timeDecay,
    riskLevel,
    riskNote,
    highestRiskStrike: { strike: otm.strike, moneyness: otm.moneyness, note: otm.note },
    disclaimer: OPTION_DISCLAIMER,
  };
}
