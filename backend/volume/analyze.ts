import { Candle, VolumeAnalysis, VolumeBar, VolumeBarClass } from "../types";
import { cmf, last, mfi, obv } from "../indicators";

const AVG_PERIOD = 20; // lookback for average volume
const SPIKE_MULT = 2.0; // volume >= 2x average = notable "big player" bar
const NOTABLE_LOOKBACK = 40; // scan the most recent N bars for notable activity
const MAX_NOTABLE = 8; // cap how many we surface

const VOLUME_DISCLAIMER =
  "Big-player activity here is INFERRED from public OHLCV (relative volume, money flow, " +
  "close location, absorption) - it is not real FII/DII, bulk-deal or order-book data. " +
  "For true institutional flow, connect a broker/NSE feed. Educational use only.";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function closeLocationValue(c: Candle): number {
  const range = c.high - c.low;
  if (range === 0) return 0;
  return ((c.close - c.low) - (c.high - c.close)) / range; // -1 (at low) .. +1 (at high)
}

function classifyBar(clv: number, rangePct: number, avgRangePct: number): VolumeBarClass {
  // Small range on big volume = someone absorbing the flow (accumulation/distribution).
  if (Math.abs(clv) <= 0.3 && rangePct < avgRangePct) return "Absorption";
  if (clv > 0.3) return "Aggressive buying";
  if (clv < -0.3) return "Aggressive selling";
  return "High churn";
}

export function analyzeVolume(symbol: string, candles: Candle[]): VolumeAnalysis {
  const n = candles.length;
  const volumes = candles.map((c) => c.volume);

  // The most recent bar is often a partial/zero-volume bar from the feed.
  // Use the last bar that actually traded as the "current" reference.
  let lastIdx = n - 1;
  while (lastIdx > 0 && volumes[lastIdx] === 0) lastIdx--;

  // Average volume over the prior AVG_PERIOD bars (excluding the reference bar).
  const avgFrom = Math.max(0, lastIdx - AVG_PERIOD);
  const priorVols = volumes.slice(avgFrom, lastIdx);
  const avgVolume = priorVols.length
    ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
    : volumes[lastIdx] || 0;

  const currentVolume = volumes[lastIdx] || 0;

  // Many index symbols report no volume on this feed - be honest about it.
  const totalVol = volumes.reduce((a, b) => a + b, 0);
  if (totalVol === 0) {
    return {
      symbol,
      asOf: candles[lastIdx].time,
      currentVolume: 0,
      avgVolume: 0,
      rvol: 0,
      rvolState: "low",
      obvTrend: "flat",
      mfi: null,
      mfiState: "neutral",
      cmf: null,
      cmfState: "neutral",
      verdict: {
        bias: "Neutral",
        strength: 0,
        reasons: [
          "No volume data for this symbol on the current feed (common for indices like NIFTY/BANKNIFTY).",
          "Tip: use the index FUTURES or a broker feed to see real volume & big-player activity.",
        ],
      },
      notableBars: [],
      disclaimer: VOLUME_DISCLAIMER,
    };
  }

  const rvol = avgVolume > 0 ? currentVolume / avgVolume : 0;
  const rvolState: VolumeAnalysis["rvolState"] =
    rvol >= 2.5 ? "very high" : rvol >= 1.5 ? "high" : rvol >= 0.6 ? "normal" : "low";

  // Average range% for absorption comparison.
  const ranges = candles.map((c) => (c.close ? (c.high - c.low) / c.close : 0));
  const avgRangePct =
    ranges.slice(avgFrom, lastIdx).reduce((a, b) => a + b, 0) / (priorVols.length || 1);

  // OBV trend (slope over last ~10 bars).
  const obvSeries = obv(candles);
  const obvNow = last(obvSeries) ?? 0;
  const obvPrevIdx = Math.max(0, n - 11);
  const obvPrev = obvSeries[obvPrevIdx] ?? obvNow;
  const obvDelta = obvNow - obvPrev;
  const obvScale = Math.max(1, avgVolume);
  const obvTrend: VolumeAnalysis["obvTrend"] =
    obvDelta > obvScale ? "rising" : obvDelta < -obvScale ? "falling" : "flat";

  // MFI & CMF.
  const mfiVal = last(mfi(candles, 14));
  const mfiState: VolumeAnalysis["mfiState"] =
    mfiVal == null
      ? "neutral"
      : mfiVal >= 80
      ? "overbought"
      : mfiVal >= 55
      ? "bullish"
      : mfiVal <= 20
      ? "oversold"
      : mfiVal <= 45
      ? "bearish"
      : "neutral";

  const cmfVal = last(cmf(candles, 20));
  const cmfState: VolumeAnalysis["cmfState"] =
    cmfVal == null
      ? "neutral"
      : cmfVal >= 0.2
      ? "strong buying"
      : cmfVal >= 0.05
      ? "buying"
      : cmfVal <= -0.2
      ? "strong selling"
      : cmfVal <= -0.05
      ? "selling"
      : "neutral";

  // Notable (big-player) bars in the recent window.
  const notableBars: VolumeBar[] = [];
  const scanFrom = Math.max(AVG_PERIOD, lastIdx - NOTABLE_LOOKBACK + 1);
  for (let i = scanFrom; i <= lastIdx; i++) {
    const localAvg =
      volumes.slice(Math.max(0, i - AVG_PERIOD), i).reduce((a, b) => a + b, 0) /
      Math.max(1, Math.min(AVG_PERIOD, i));
    const r = localAvg > 0 ? volumes[i] / localAvg : 0;
    if (r >= SPIKE_MULT) {
      const clv = closeLocationValue(candles[i]);
      const rangePct = candles[i].close ? (candles[i].high - candles[i].low) / candles[i].close : 0;
      notableBars.push({
        time: candles[i].time,
        volume: volumes[i],
        rvol: round2(r),
        clv: round2(clv),
        classification: classifyBar(clv, rangePct, avgRangePct),
      });
    }
  }
  // Keep the most recent, strongest ones.
  notableBars.sort((a, b) => b.time - a.time);
  const trimmed = notableBars.slice(0, MAX_NOTABLE);

  // Verdict: combine flow signals into an accumulation/distribution read.
  let score = 0;
  const reasons: string[] = [];
  if (cmfVal != null) {
    if (cmfVal >= 0.05) { score += cmfVal >= 0.2 ? 2 : 1; reasons.push(`CMF ${round2(cmfVal)} - net buying pressure`); }
    else if (cmfVal <= -0.05) { score -= cmfVal <= -0.2 ? 2 : 1; reasons.push(`CMF ${round2(cmfVal)} - net selling pressure`); }
  }
  if (obvTrend === "rising") { score += 1; reasons.push("OBV rising - volume flowing in"); }
  else if (obvTrend === "falling") { score -= 1; reasons.push("OBV falling - volume flowing out"); }
  if (mfiVal != null) {
    if (mfiVal >= 55 && mfiVal < 80) { score += 1; reasons.push(`MFI ${Math.round(mfiVal)} - money flow bullish`); }
    else if (mfiVal >= 80) { reasons.push(`MFI ${Math.round(mfiVal)} - overbought, buying may be exhausting`); }
    else if (mfiVal <= 45 && mfiVal > 20) { score -= 1; reasons.push(`MFI ${Math.round(mfiVal)} - money flow bearish`); }
    else if (mfiVal <= 20) { reasons.push(`MFI ${Math.round(mfiVal)} - oversold, selling may be exhausting`); }
  }
  const buyBars = trimmed.filter((b) => b.classification === "Aggressive buying").length;
  const sellBars = trimmed.filter((b) => b.classification === "Aggressive selling").length;
  if (buyBars > sellBars) { score += 1; reasons.push(`${buyBars} high-volume buying bar(s) recently`); }
  else if (sellBars > buyBars) { score -= 1; reasons.push(`${sellBars} high-volume selling bar(s) recently`); }
  if (rvolState === "very high" || rvolState === "high") {
    reasons.push(`Relative volume ${round2(rvol)}x - unusually active (big players likely present)`);
  }
  if (!reasons.length) reasons.push("No strong volume signature - activity looks routine.");

  const bias: VolumeAnalysis["verdict"]["bias"] =
    score >= 2 ? "Accumulation" : score <= -2 ? "Distribution" : "Neutral";
  const strength = Math.min(100, Math.abs(score) * 25);

  return {
    symbol,
    asOf: candles[lastIdx].time,
    currentVolume,
    avgVolume: Math.round(avgVolume),
    rvol: round2(rvol),
    rvolState,
    obvTrend,
    mfi: mfiVal != null ? round2(mfiVal) : null,
    mfiState,
    cmf: cmfVal != null ? round2(cmfVal) : null,
    cmfState,
    verdict: { bias, strength, reasons },
    notableBars: trimmed,
    disclaimer: VOLUME_DISCLAIMER,
  };
}
