import { Candle, Interval, RiskRadar, RiskWarning } from "../types";
import { adx as adxIndicator, atr, last } from "../indicators";

export interface RiskRadarInput {
  interval?: Interval;
  premium?: number | null; // option LTP, for the "one bad bar" check
}

const SEVERITY_WEIGHT = { danger: 35, caution: 18, info: 8 };

// Phase 2.2 (RiskEngine): these are the ONLY two danger-level reads the entry
// gate vetoes on (paper/engine.ts tryOpenOption), matching the plan's named
// examples exactly — no additional thresholds invented. Exported so the gate
// checks the SAME numbers this module already computes its own "danger" severity
// from (RiskRadar.atrRatio / RiskRadar.premiumSwingPct), never a re-derived copy.
export const ATR_SPIKE_DANGER = 1.8;
export const PREMIUM_SWING_DANGER = 40;

const RADAR_NOTE =
  "Risk Radar flags conditions that commonly cause sudden option losses (volatility spikes, " +
  "theta bleed in choppy markets, late-session decay, IV crush). It is derived from the underlying's " +
  "price action; connect a Greeks feed (Groww) for exact delta/gamma/theta/vega/IV warnings.";

function istMinuteOfDay(epochSec: number): number {
  return Math.floor(((epochSec + 19800) % 86400) / 60);
}

/**
 * Compute a pre-trade risk radar from underlying OHLCV.
 * Warns BEFORE entry about spike / decay / whipsaw conditions.
 */
export function computeRiskRadar(candles: Candle[], input: RiskRadarInput = {}): RiskRadar {
  const warnings: RiskWarning[] = [];
  const n = candles.length;
  const price = candles[n - 1].close;

  // --- Volatility (ATR) expansion ---
  const atrSeries = atr(candles, 14);
  const atrNow = last(atrSeries);
  const atrVals = atrSeries.filter((v) => v != null) as number[];
  const atrAvg = atrVals.length
    ? atrVals.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atrVals.length)
    : null;
  const atrPct = atrNow != null && price ? (atrNow / price) * 100 : null;
  const atrRatio = atrNow != null && atrAvg ? atrNow / atrAvg : null;

  if (atrRatio != null && atrRatio >= 1.4) {
    warnings.push({
      severity: atrRatio >= ATR_SPIKE_DANGER ? "danger" : "caution",
      title: `Volatility spike (ATR ${atrRatio.toFixed(1)}x normal)`,
      detail:
        "Price is swinging much wider than usual, so option premiums are moving fast in both " +
        "directions. A quick reversal can hit your stop before the trade works. Size down and keep a tight stop.",
    });
  }

  // --- Choppy / trendless = theta trap ---
  const adxNow = last(adxIndicator(candles, 14).adx);
  if (adxNow != null && adxNow < 20) {
    warnings.push({
      severity: "caution",
      title: `No clear trend (ADX ${Math.round(adxNow)})`,
      detail:
        "The market is rangebound. A bought option will bleed premium to time decay while price chops " +
        "sideways - you need a decisive directional move, which isn't present right now.",
    });
  }

  // --- Time-of-day risk (IST) ---
  const istMin = istMinuteOfDay(candles[n - 1].time);
  if (istMin >= 555 && istMin <= 570) {
    warnings.push({
      severity: "caution",
      title: "Opening 15 minutes",
      detail:
        "9:15-9:30 is the most erratic window - wide swings, gaps, slippage and fake breakouts. " +
        "Premiums and spreads are unstable; many pros wait for it to settle.",
    });
  } else if (istMin >= 885) {
    warnings.push({
      severity: "caution",
      title: "Late session (post 2:45 PM)",
      detail:
        "Time decay accelerates into the close and liquidity thins. Buying options here is risky " +
        "unless scalping; on expiry day premium can evaporate fast.",
    });
  }

  // --- Unusual volume / big-player spikes ---
  const volumes = candles.map((c) => c.volume);
  let refIdx = n - 1;
  while (refIdx > 0 && volumes[refIdx] === 0) refIdx--;
  const priorVol = volumes.slice(Math.max(0, refIdx - 20), refIdx);
  const avgVol = priorVol.length ? priorVol.reduce((a, b) => a + b, 0) / priorVol.length : 0;
  const rvol = avgVol > 0 ? volumes[refIdx] / avgVol : 0;
  if (rvol >= 2) {
    warnings.push({
      severity: rvol >= 3 ? "danger" : "caution",
      title: `Unusual volume (${rvol.toFixed(1)}x)`,
      detail:
        "A burst of volume signals big-player activity - expect sharp, fast spikes that can whipsaw " +
        "an option position. Wait for direction to confirm rather than chasing.",
    });
  }

  // --- Large recent candle (gap / spike) ---
  if (atrPct != null && atrNow) {
    let maxRange = 0;
    for (let i = Math.max(1, n - 5); i < n; i++) {
      maxRange = Math.max(maxRange, candles[i].high - candles[i].low);
    }
    const spikeMult = atrNow ? maxRange / atrNow : 0;
    if (spikeMult >= 2) {
      warnings.push({
        severity: "caution",
        title: `Sharp candle recently (${spikeMult.toFixed(1)}x ATR)`,
        detail:
          "A recent bar moved far more than the average range. After such spikes, mean-reversion and " +
          "violent retracements are common - option premiums can reverse just as fast.",
      });
    }
  }

  // --- "One bad bar" vs premium (needs premium) ---
  let premiumSwingPct: number | null = null;
  const premium = input.premium && input.premium > 0 ? input.premium : null;
  if (premium != null && atrNow != null) {
    // ATM delta ~0.5: a one-ATR underlying move ~ 0.5*ATR in premium.
    const swing = 0.5 * atrNow;
    premiumSwingPct = (swing / premium) * 100;
    if (premiumSwingPct >= 25) {
      warnings.push({
        severity: premiumSwingPct >= PREMIUM_SWING_DANGER ? "danger" : "caution",
        title: `One ATR move ≈ ${Math.round(premiumSwingPct)}% of your premium`,
        detail:
          `A single average bar (~${atrNow.toFixed(2)} pts) can move the option premium by about ` +
          `${Math.round(premiumSwingPct)}%. Your entire premium can swing in a couple of bars - use a hard stop and small size.`,
      });
    }
  }

  // Baseline theta reminder for option buyers.
  warnings.push({
    severity: "info",
    title: "Time decay is always working against a buyer",
    detail:
      "As a long-option holder, every minute of no movement costs you premium (theta), fastest for ATM " +
      "and near expiry. Have a time-stop: if it doesn't move within a few candles, exit.",
  });

  // Composite spike-risk score.
  let score = 0;
  for (const w of warnings) score += SEVERITY_WEIGHT[w.severity];
  const spikeRisk = Math.min(100, score);
  const level: RiskRadar["level"] = spikeRisk >= 60 ? "High" : spikeRisk >= 30 ? "Elevated" : "Low";

  // Order warnings by severity (danger first).
  const rank = { danger: 0, caution: 1, info: 2 };
  warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    spikeRisk,
    level,
    atrPct: atrPct != null ? Math.round(atrPct * 100) / 100 : null,
    atrRatio: atrRatio != null ? Math.round(atrRatio * 100) / 100 : null,
    adx: adxNow != null ? Math.round(adxNow * 10) / 10 : null,
    premiumSwingPct: premiumSwingPct != null ? Math.round(premiumSwingPct) : null,
    greeksAvailable: false,
    warnings,
    note: RADAR_NOTE,
  };
}
