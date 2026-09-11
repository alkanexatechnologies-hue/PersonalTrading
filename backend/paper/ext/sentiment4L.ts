// ---- Step 3: sentiment4L.ts ----
// Continuous module. No dependencies. DIRECTIONAL-ONLY — this module is never
// called from the Scalp trigger path.
//
// Three equally-weighted signed inputs (do NOT add more without a backtest that
// shows they help):
//   1) News-flow polarity  — headline sentiment on filings + top finance feeds
//      (getMarketNews().summary.bias), mapped to +1 / -1 / 0.
//   2) PCR trend           — the RATE OF CHANGE of PCR over recent snapshots, not
//      the absolute level. Rising PCR (more put writing) => bullish lean.
//   3) IV skew shift       — change in (call-side IV − put-side IV) over a recent
//      window. Rising relative call IV => bullish demand.
//
// Output sentimentScore in [-1, 1] and a state. When the components openly
// disagree (a clear +1 and a clear -1 present) with no strong majority, the state
// is Conflicted so tradeScore withholds the agreement bonus.

import { SentimentState, UnderlyingBias, clamp } from "./types";

export interface Sentiment4LInputs {
  newsBias?: UnderlyingBias;
  pcrSeries?: number[]; // newest last
  ivSkewSeries?: { callIv: number; putIv: number }[]; // newest last
}

export interface Sentiment4LResult {
  sentimentScore: number; // -1..1
  sentimentState: SentimentState;
  note: string;
}

const DEADBAND = 0.05; // slopes/deltas within this are treated as flat (0)

function sign3(x: number, band: number): -1 | 0 | 1 {
  if (x > band) return 1;
  if (x < -band) return -1;
  return 0;
}

// Rate of change of a series (last vs a short baseline), normalised.
function rateOfChange(series: number[]): number {
  if (!series || series.length < 2) return 0;
  const cur = series[series.length - 1];
  const prev = series[Math.max(0, series.length - 4)]; // ~3 steps back if available
  if (!(Math.abs(prev) > 1e-9)) return 0;
  return (cur - prev) / Math.abs(prev);
}

export function computeSentiment4L(inputs: Sentiment4LInputs): Sentiment4LResult {
  const comps: number[] = [];
  const labels: string[] = [];

  // 1) News polarity
  if (inputs.newsBias) {
    const v = inputs.newsBias === "Bullish" ? 1 : inputs.newsBias === "Bearish" ? -1 : 0;
    comps.push(v);
    labels.push(`news ${inputs.newsBias}`);
  }

  // 2) PCR trend (rate of change; rising PCR => bullish)
  if (inputs.pcrSeries && inputs.pcrSeries.length >= 2) {
    const roc = rateOfChange(inputs.pcrSeries);
    comps.push(sign3(roc, DEADBAND));
    labels.push(`PCRΔ ${(roc * 100).toFixed(1)}%`);
  }

  // 3) IV skew shift (change in call−put IV; rising => bullish)
  if (inputs.ivSkewSeries && inputs.ivSkewSeries.length >= 2) {
    const s = inputs.ivSkewSeries;
    const skewNow = s[s.length - 1].callIv - s[s.length - 1].putIv;
    const skewPrev = s[Math.max(0, s.length - 4)].callIv - s[Math.max(0, s.length - 4)].putIv;
    const shift = skewNow - skewPrev;
    comps.push(sign3(shift, DEADBAND));
    labels.push(`IV-skewΔ ${shift.toFixed(2)}`);
  }

  if (!comps.length) {
    return { sentimentScore: 0, sentimentState: "Neutral", note: "no sentiment inputs available" };
  }

  // Equal weighting.
  const sentimentScore = clamp(comps.reduce((a, b) => a + b, 0) / comps.length, -1, 1);

  const hasBull = comps.some((c) => c > 0);
  const hasBear = comps.some((c) => c < 0);
  let sentimentState: SentimentState;
  if (hasBull && hasBear && Math.abs(sentimentScore) < 0.4) {
    sentimentState = "Conflicted"; // openly opposing signals, no majority
  } else if (sentimentScore > 0.15) {
    sentimentState = "Bullish";
  } else if (sentimentScore < -0.15) {
    sentimentState = "Bearish";
  } else {
    sentimentState = "Neutral";
  }

  return { sentimentScore: Math.round(sentimentScore * 100) / 100, sentimentState, note: labels.join(" · ") };
}
