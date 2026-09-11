import { Candle } from "../types";

export interface AttemptsResult {
  level: number | null; // the level being repeatedly tested (resistance for up-pressure, support for down)
  attemptsUp: number; // how many times price tried to break the resistance ceiling
  attemptsDown: number; // how many times price tried to break the support floor
  higherLows: boolean; // lows are rising toward resistance = buyers stepping up (bullish coil)
  lowerHighs: boolean; // highs are falling toward support = sellers pressing down (bearish coil)
  pressure: "up" | "down" | "none"; // the side the market is coiling to break
  nearLevelPct: number | null; // how far price is from the tested level, % (small = coiling right under/over it)
  note: string;
  noteHindi: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * "Repeated attempts" detector — encodes how a human reads a chart.
 *
 * When price tests the SAME ceiling two+ times while carving HIGHER LOWS, buyers
 * are absorbing supply and pressure is building to break UP (the third attempt
 * often goes). The mirror image (repeated tests of a floor with LOWER HIGHS) is
 * pressure to break DOWN. This lets the system anticipate the breakout side and
 * scalp WITH it, instead of sitting in a counter-trend option that bleeds.
 */
export function computeAttempts(candles: Candle[], lookback = 40, tolPct = 0.0018): AttemptsResult {
  const none: AttemptsResult = {
    level: null, attemptsUp: 0, attemptsDown: 0, higherLows: false, lowerHighs: false,
    pressure: "none", nearLevelPct: null, note: "No repeated-level pattern.", noteHindi: "कोई साफ़ लेवल पैटर्न नहीं।",
  };
  if (!candles || candles.length < 12) return none;
  const win = candles.slice(-lookback);
  const n = win.length;
  const price = win[n - 1].close;
  if (!price) return none;

  // Swing highs / lows via a 2-bar fractal (robust to intraday noise).
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    const h = win[i].high, l = win[i].low;
    if (h >= win[i - 1].high && h >= win[i - 2].high && h >= win[i + 1].high && h >= win[i + 2].high) swingHighs.push(h);
    if (l <= win[i - 1].low && l <= win[i - 2].low && l <= win[i + 1].low && l <= win[i + 2].low) swingLows.push(l);
  }
  if (!swingHighs.length && !swingLows.length) return none;

  // Resistance = the top cluster of swing highs; count how many tests fall in it.
  const resistance = swingHighs.length ? Math.max(...swingHighs) : Math.max(...win.map((c) => c.high));
  const support = swingLows.length ? Math.min(...swingLows) : Math.min(...win.map((c) => c.low));
  const attemptsUp = swingHighs.filter((h) => Math.abs(h - resistance) / resistance <= tolPct).length || (swingHighs.length ? 1 : 0);
  const attemptsDown = swingLows.filter((l) => Math.abs(l - support) / support <= tolPct).length || (swingLows.length ? 1 : 0);

  // Structure: are the swing lows rising (higher lows) / swing highs falling (lower highs)?
  const rising = (arr: number[]) => arr.length >= 2 && arr[arr.length - 1] > arr[0];
  const falling = (arr: number[]) => arr.length >= 2 && arr[arr.length - 1] < arr[0];
  const higherLows = rising(swingLows);
  const lowerHighs = falling(swingHighs);

  const toResPct = round2(((resistance - price) / price) * 100); // + = below resistance
  const toSupPct = round2(((price - support) / price) * 100); // + = above support

  // Pressure: 2+ tests of a level + confirming structure + price coiling near it (<=0.35%).
  // "Coiling near the level" window. Kept generous (<=0.6%) so the durable part of
  // the read — repeated attempts + confirming structure — isn't lost every time
  // price wiggles a few points in/out of a tight band.
  const NEAR = 0.6;
  let pressure: "up" | "down" | "none" = "none";
  let level: number | null = null;
  let nearLevelPct: number | null = null;
  if (attemptsUp >= 2 && higherLows && toResPct >= -0.1 && toResPct <= NEAR) {
    pressure = "up"; level = round2(resistance); nearLevelPct = toResPct;
  } else if (attemptsDown >= 2 && lowerHighs && toSupPct >= -0.1 && toSupPct <= NEAR) {
    pressure = "down"; level = round2(support); nearLevelPct = toSupPct;
  }

  const note =
    pressure === "up"
      ? `${attemptsUp} attempts at ${round2(resistance)} with higher lows — coiling under resistance, breakout UP likely (scalp the break).`
      : pressure === "down"
      ? `${attemptsDown} attempts at ${round2(support)} with lower highs — pressing on support, breakdown DOWN likely (scalp the break).`
      : `Highs ${round2(resistance)} / lows ${round2(support)} — no clean repeated-attempt setup yet.`;
  const noteHindi =
    pressure === "up"
      ? `${attemptsUp} बार ${round2(resistance)} तोड़ने की कोशिश + ऊँचे लो — ऊपर ब्रेकआउट संभव, तेज़ी का स्कैल्प।`
      : pressure === "down"
      ? `${attemptsDown} बार ${round2(support)} तोड़ने की कोशिश + नीचे हाई — नीचे ब्रेकडाउन संभव, मंदी का स्कैल्प।`
      : `अभी साफ़ बार-बार टेस्ट वाला सेटअप नहीं।`;

  return { level, attemptsUp, attemptsDown, higherLows, lowerHighs, pressure, nearLevelPct, note, noteHindi };
}
