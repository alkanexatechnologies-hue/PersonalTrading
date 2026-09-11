import { Candle } from "../types";
import { atr, vwap, last, sma } from "../indicators";

// ---- Trade Minder: "is this a test, or a real reversal?" ----
// The small option-buyer's problem: a normal pullback / liquidity-grab shakes
// them out, then price resumes their way. The Minder classifies the CURRENT
// pullback for an open directional view as:
//   HOLD    - structure intact (above VWAP + prior swing, shallow pullback) -> it's a test, don't cut
//   WARNING - pullback deepening toward the structural stop
//   EXIT    - structure BROKEN (swing + VWAP lost with momentum/volume) -> real reversal, get out
// Uses the underlying's recent candles (VWAP, ATR, swing structure, volume).

export interface TradeMinder {
  state: "HOLD" | "WARNING" | "EXIT";
  direction: "Bullish" | "Bearish";
  price: number;
  vwap: number | null;
  atr: number | null;
  structuralStop: number | null; // swing that, if broken, = real reversal
  holdLevel: number | null; // the level price should keep holding
  pullbackAtr: number; // current pullback size in ATR units
  reason: string;
  hindi: string; // Hindi discipline cue (helps the trader stay calm / disciplined)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const SWING_LOOKBACK = 8; // bars used to define the structural swing
const SHALLOW_ATR = 0.6; // pullback below this (x ATR) = still shallow / a test

export function computeTradeMinder(candles: Candle[], direction: "Bullish" | "Bearish"): TradeMinder | null {
  const n = candles.length;
  if (n < 20) return null;
  const price = candles[n - 1].close;
  const vw = last(vwap(candles));
  const atrv = last(atr(candles, 14));
  const bull = direction === "Bullish";

  // Structural swing over the recent window (exclude the last bar so a fresh spike
  // doesn't define its own stop).
  const win = candles.slice(Math.max(0, n - 1 - SWING_LOOKBACK), n - 1);
  const swingLow = Math.min(...win.map((c) => c.low));
  const swingHigh = Math.max(...win.map((c) => c.high));
  const recentHigh = Math.max(...candles.slice(n - SWING_LOOKBACK).map((c) => c.high));
  const recentLow = Math.min(...candles.slice(n - SWING_LOOKBACK).map((c) => c.low));

  // Volume: is the pullback bar on strong (distribution) volume?
  const vols = candles.map((c) => c.volume || 0);
  const hasVol = vols.some((v) => v > 0);
  const avgVol = hasVol ? (last(sma(vols, Math.min(20, vols.length))) ?? 0) : 0;
  const lastBar = candles[n - 1];
  const strongBar = hasVol && (lastBar.volume || 0) > avgVol * 1.2;
  const bearBar = lastBar.close < lastBar.open;
  const bullBar = lastBar.close > lastBar.open;

  const structuralStop = bull ? round2(swingLow) : round2(swingHigh);
  const holdLevel = vw != null ? round2(bull ? Math.max(vw, swingLow) : Math.min(vw, swingHigh)) : structuralStop;
  const pullback = bull ? recentHigh - price : price - recentLow;
  const pullbackAtr = atrv && atrv > 0 ? round2(pullback / atrv) : 0;

  const aboveVwap = vw == null ? true : price > vw;
  const belowVwap = vw == null ? true : price < vw;
  const structureBroken = bull ? price < swingLow : price > swingHigh;
  const vwapFlip = bull ? (vw != null && price < vw) : (vw != null && price > vw);
  const momentumAgainst = bull ? (bearBar && strongBar) : (bullBar && strongBar);

  let state: TradeMinder["state"];
  let reason: string;
  let hindi: string;
  if (structureBroken || (vwapFlip && momentumAgainst)) {
    state = "EXIT";
    reason = structureBroken
      ? `Structure BROKEN: price ${round2(price)} lost the ${bull ? "swing low" : "swing high"} ${structuralStop}. This is a real reversal, not a test - exit.`
      : `VWAP flipped ${bull ? "below" : "above"} (${round2(vw!)}) on strong ${bull ? "selling" : "buying"} volume - momentum turned against the ${direction} view. Exit.`;
    hindi = `असली रिवर्सल — स्ट्रक्चर टूट गया (${structuralStop} लेवल)। अभी बाहर निकलो, लॉस बढ़ने मत दो। उम्मीद पर ट्रेड मत रखो।`;
  } else if ((bull ? aboveVwap : belowVwap) && !structureBroken && pullbackAtr < SHALLOW_ATR) {
    state = "HOLD";
    reason = `It's a TEST, not a reversal: price still ${bull ? "above" : "below"} VWAP (${vw != null ? round2(vw) : "n/a"}) and holding the ${bull ? "swing low" : "swing high"}. Pullback only ${pullbackAtr} ATR - hold, don't cut.`;
    hindi = `यह सिर्फ़ टेस्ट है, रिवर्सल नहीं। घबराकर बाहर मत निकलो — पोजीशन होल्ड करो। मार्केट स्टॉप हंट कर रहा है, ${bull ? "VWAP के ऊपर" : "VWAP के नीचे"} टिका है।`;
  } else {
    state = "WARNING";
    reason = `Pullback deepening (${pullbackAtr} ATR)${vwapFlip ? ", VWAP lost" : ""}. Watch the ${bull ? "swing low" : "swing high"} ${structuralStop} - exit only if it breaks.`;
    hindi = `सावधान — पुलबैक गहरा हो रहा है। ${structuralStop} लेवल पर नज़र रखो। टूटे तभी निकलो, उससे पहले नहीं। स्टॉपलॉस मत हटाओ।`;
  }

  return { state, direction, price: round2(price), vwap: vw != null ? round2(vw) : null, atr: atrv != null ? round2(atrv) : null, structuralStop, holdLevel, pullbackAtr, reason, hindi };
}
