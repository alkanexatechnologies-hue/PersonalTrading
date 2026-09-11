import { Candle } from "../types";
import { SymbolDef } from "../config";
import { adx, atr, last, rsi } from "../indicators";
import { computeSignal } from "../signals/engine";

// ---- Multi-timeframe Top Picks ----
// For each stock, run the signal on FOUR timeframes (5m, 15m, 1h, 1d), find how
// well they AGREE (multi-timeframe alignment), pick the strongest ("best")
// timeframe, and rate a win-probability. Classifies each pick for INTRADAY
// (short-timeframe momentum) and for OPTIONS (F&O + clean directional trend),
// with plain-English reasons and a ranking.

export type Tf = "5m" | "15m" | "1h" | "1d";
export const TOP_PICK_TFS: Tf[] = ["5m", "15m", "1h", "1d"];

export interface TfSignal {
  tf: Tf;
  score: number;
  label: string;
  confidence: number;
  dir: 1 | -1 | 0;
  timing: "READY TO MOVE" | "UNDERWAY" | "EXTENDED" | null; // how stretched THIS timeframe's move is (RSI)
  adx: number | null;     // Directional Movement: trend STRENGTH on this timeframe
  plusDI: number | null;  // +DI (upward pressure)
  minusDI: number | null; // -DI (downward pressure)
  // Directional RUN (fixes "ADX high but no fresh move"): when it started + state.
  runStartAt: number | null;     // epoch of the run's origin bar
  runStartPrice: number | null;  // price where the run began
  runMovePct: number | null;     // move since the run started
  runBarsAgo: number | null;     // bars since the last fresh extreme
  runState: "Running" | "Stalling" | "Range" | null;
  expContinuePct: number | null; // expected further move (ATR-measured)
}

export interface TopPick {
  symbol: string;
  name: string;
  price: number;
  isFno: boolean;
  direction: "Bullish" | "Bearish" | "Neutral";
  timing: "READY TO MOVE" | "UNDERWAY" | "EXTENDED" | null; // how far along the move already is
  timingReason: string;
  bestTf: Tf | null;
  bestScore: number;
  bestConfidence: number;
  alignment: number; // 0-100: % of timeframes agreeing with the overall direction
  probability: number; // 0-100 composite win-probability estimate
  expectedDayMovePct: number | null; // typical full-day range = daily ATR as % of price
  todayMoveRawPct: number | null;    // today's move from the open, SIGNED (+ = up)
  atrPct: number | null;
  cleanRating: number | null;
  cleanGrade: string | null;
  intradaySuited: boolean;
  optionSuited: boolean;
  intradayScore: number; // ranking score for intraday
  optionScore: number; // ranking score for options
  tfSignals: TfSignal[];
  reasons: string[];
  rank?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---- Directional RUN detection (fixes the "ADX high but no fresh move" trap) ----
// ADX is a LAGGING indicator: it stays high after a move even when price has gone
// flat/range-bound. So we find WHEN the current bull/bear run actually started
// (the swing low/high it launched from), how far it has travelled, whether it is
// STILL making fresh highs/lows (Running) or has stalled / gone Range, and how
// much more it is expected to continue (ATR-measured).
interface RunInfo {
  startAt: number;      // epoch of the run's origin bar
  startPrice: number;   // price where the run began
  movePct: number;      // move since the run started (favourable direction)
  barsAgo: number;      // bars since the LAST fresh extreme (high for bull / low for bear)
  state: "Running" | "Stalling" | "Range";
  expContinuePct: number; // expected further move to a typical ~1.5x ATR swing
}
function detectRun(c: Candle[], dir: 1 | -1, atrVal: number | null): RunInfo | null {
  const n = c.length;
  if (n < 10) return null;
  const start = Math.max(0, n - 60);
  const price = c[n - 1].close;
  let originIdx = start, extremeIdx = start;
  if (dir > 0) {
    let lo = c[start].low;
    for (let i = start; i < n; i++) if (c[i].low <= lo) { lo = c[i].low; originIdx = i; }
    let hi = c[originIdx].high;
    for (let i = originIdx; i < n; i++) if (c[i].high >= hi) { hi = c[i].high; extremeIdx = i; }
  } else {
    let hi = c[start].high;
    for (let i = start; i < n; i++) if (c[i].high >= hi) { hi = c[i].high; originIdx = i; }
    let lo = c[originIdx].low;
    for (let i = originIdx; i < n; i++) if (c[i].low <= lo) { lo = c[i].low; extremeIdx = i; }
  }
  const startPrice = dir > 0 ? c[originIdx].low : c[originIdx].high;
  const movePct = dir > 0 ? ((price - startPrice) / startPrice) * 100 : ((startPrice - price) / startPrice) * 100;
  const barsAgo = (n - 1) - extremeIdx; // 0 = a fresh extreme on the last bar
  let state: RunInfo["state"];
  if (Math.abs(movePct) < 0.15) state = "Range";
  else if (barsAgo <= 2) state = "Running";
  else if (barsAgo <= 6) state = "Stalling";
  else state = "Range";
  // Typical full swing ~1.5x ATR from origin; whatever's left is the expected continuation.
  const atrPct = atrVal && startPrice ? (atrVal / startPrice) * 100 : 0;
  const expTotal = atrPct * 1.5;
  const expContinuePct = state === "Range" ? 0 : clamp(round1(expTotal - Math.max(0, movePct)), 0, expTotal);
  return { startAt: c[originIdx].time, startPrice: round2(startPrice), movePct: round1(movePct), barsAgo, state, expContinuePct };
}

/**
 * @param candlesByTf candles keyed by timeframe (5m/15m/1h/1d)
 * @param clean       optional { rating, grade } from the clean-move rating
 */
export function computeTopPick(
  symbol: string,
  name: string,
  def: SymbolDef | undefined,
  candlesByTf: Partial<Record<Tf, Candle[]>>,
  clean?: { rating: number; grade: string } | null,
): TopPick | null {
  const tfSignals: TfSignal[] = [];
  let price = 0;
  for (const tf of TOP_PICK_TFS) {
    const c = candlesByTf[tf];
    if (!c || c.length < 30) continue;
    const sig = computeSignal(symbol, c);
    price = sig.price;
    const tdir: 1 | -1 | 0 = sig.score >= 12 ? 1 : sig.score <= -12 ? -1 : 0;
    // Per-timeframe timing from RSI on THIS timeframe (so each segment shows how
    // far along the move is on its own clock, not the overall best-TF clock).
    let tfTiming: TfSignal["timing"] = null;
    if (tdir !== 0) {
      const rv = last(rsi(c.map((x) => x.close), 14));
      if (rv != null) {
        const stretch = tdir > 0 ? rv : 100 - rv;
        tfTiming = stretch >= 70 ? "EXTENDED" : stretch >= 57 ? "UNDERWAY" : "READY TO MOVE";
      }
    }
    // Directional Movement (ADX/DMI) on THIS timeframe — direction + trend strength.
    const dm = adx(c, 14);
    const dmAdx = last(dm.adx);
    const dmPlus = last(dm.plusDI);
    const dmMinus = last(dm.minusDI);
    // WHEN did the current run start + is it still Running / Stalling / Range?
    const atrVal = last(atr(c, 14));
    const run = tdir !== 0 ? detectRun(c, tdir as 1 | -1, atrVal) : null;
    tfSignals.push({
      tf, score: sig.score, label: sig.label, confidence: sig.confidence, dir: tdir, timing: tfTiming,
      adx: dmAdx != null ? round1(dmAdx) : null,
      plusDI: dmPlus != null ? round1(dmPlus) : null,
      minusDI: dmMinus != null ? round1(dmMinus) : null,
      runStartAt: run?.startAt ?? null,
      runStartPrice: run?.startPrice ?? null,
      runMovePct: run?.movePct ?? null,
      runBarsAgo: run?.barsAgo ?? null,
      runState: run?.state ?? null,
      expContinuePct: run?.expContinuePct ?? null,
    });
  }
  if (tfSignals.length < 2 || !price) return null;

  // Overall direction = sign of the |score|-weighted sum across timeframes.
  const weighted = tfSignals.reduce((s, t) => s + t.score, 0);
  const netDir: 1 | -1 | 0 = weighted >= 12 ? 1 : weighted <= -12 ? -1 : 0;
  const direction = netDir > 0 ? "Bullish" : netDir < 0 ? "Bearish" : "Neutral";

  // Aligned = timeframes pointing the same way as the overall direction.
  const aligned = tfSignals.filter((t) => t.dir !== 0 && t.dir === netDir);
  const alignment = Math.round((aligned.length / tfSignals.length) * 100);

  // Best timeframe = strongest |score| among aligned (or overall if none aligned).
  const pool = aligned.length ? aligned : tfSignals;
  const best = pool.reduce((b, t) => (Math.abs(t.score) > Math.abs(b.score) ? t : b), pool[0]);
  const bestScore = best.score;
  const bestConfidence = best.confidence;

  // TIMING: how far along the move already is, from RSI on the best timeframe.
  // "READY TO MOVE" = just turning (not stretched, best entry); "UNDERWAY" = in
  // progress; "EXTENDED" = already ran a lot (chasing risk). Answers the user's
  // "system tells me the direction only AFTER it has moved" — this flags late picks.
  let timing: TopPick["timing"] = null;
  let timingReason = "";
  const bestCandles = candlesByTf[best.tf];
  if (netDir !== 0 && bestCandles && bestCandles.length >= 20) {
    const rsiVal = last(rsi(bestCandles.map((c) => c.close), 14));
    if (rsiVal != null) {
      const bull = netDir > 0;
      const stretch = bull ? rsiVal : 100 - rsiVal; // higher = move more stretched in the trade direction
      if (stretch >= 70) { timing = "EXTENDED"; timingReason = `RSI ${Math.round(rsiVal)} on ${best.tf} — move already stretched; entering now is chasing.`; }
      else if (stretch >= 57) { timing = "UNDERWAY"; timingReason = `RSI ${Math.round(rsiVal)} on ${best.tf} — move in progress; enter on a small pullback.`; }
      else { timing = "READY TO MOVE"; timingReason = `RSI ${Math.round(rsiVal)} on ${best.tf} — just turning ${bull ? "up" : "down"}, not stretched yet (best entry).`; }
    }
  }

  // ATR% from the daily (typical move size) - useful for intraday viability.
  const daily = candlesByTf["1d"];
  const atrv = daily && daily.length > 20 ? last(atr(daily, 14)) : null;
  const atrPct = atrv != null && price ? round2((atrv / price) * 100) : null;
  // Move-vs-potential: how much the stock has moved TODAY (from the open) against
  // its typical full-day range (daily ATR). The endpoint turns this into a
  // per-row "moved so far / potential left" using the row's own direction.
  const expectedDayMovePct = atrPct; // daily ATR% = a typical full day's range
  const todayCandle = daily && daily.length ? daily[daily.length - 1] : null;
  const todayMoveRawPct = todayCandle && todayCandle.open > 0 ? round2(((price - todayCandle.open) / todayCandle.open) * 100) : null;

  // Win-probability estimate: strength of the best TF + how many TFs agree.
  const probability = clamp(
    Math.round(bestConfidence * 0.45 + alignment * 0.35 + Math.min(Math.abs(bestScore), 100) * 0.2),
    5, 95,
  );

  const isFno = def?.fno === true;
  const cleanRating = clean?.rating ?? null;
  const cleanGrade = clean?.grade ?? null;

  // Short-timeframe agreement (5m + 15m aligned with the overall direction).
  const s5 = tfSignals.find((t) => t.tf === "5m");
  const s15 = tfSignals.find((t) => t.tf === "15m");
  const shortAgree = !!(s5 && s15 && s5.dir === netDir && s15.dir === netDir && netDir !== 0);

  // INTRADAY suited: short-TF momentum + enough daily range to move intraday.
  const intradaySuited = shortAgree && (atrPct == null || atrPct >= 1.0);
  // OPTION suited: F&O + directional + clean trend (rating >= 45 when known).
  const optionSuited = isFno && netDir !== 0 && Math.abs(bestScore) >= 15 && (cleanRating == null || cleanRating >= 45);

  const intradayScore = clamp(
    Math.round(probability * 0.6 + (shortAgree ? 20 : 0) + (atrPct != null ? Math.min(atrPct * 5, 20) : 0)),
    0, 100,
  );
  const optionScore = clamp(
    Math.round(probability * 0.5 + (cleanRating != null ? cleanRating * 0.3 : 15) + (isFno ? 10 : 0) + Math.min(Math.abs(bestScore) * 0.1, 10)),
    0, 100,
  );

  // Reasons (why the system picks it).
  const reasons: string[] = [];
  const dirWord = direction === "Bullish" ? "up" : direction === "Bearish" ? "down" : "no clear";
  reasons.push(`${aligned.length}/${tfSignals.length} timeframes aligned ${dirWord} (alignment ${alignment}%).`);
  if (best.tf) reasons.push(`Strongest on ${best.tf}: ${best.label} (score ${bestScore}, conf ${bestConfidence}%).`);
  reasons.push("Timeframes: " + tfSignals.map((t) => `${t.tf} ${t.score >= 0 ? "+" : ""}${t.score}`).join(", ") + ".");
  if (atrPct != null) reasons.push(`Moves ~${atrPct}%/day (${atrPct >= 2 ? "good" : "modest"} intraday range).`);
  if (cleanGrade) reasons.push(`Clean-move ${cleanGrade} (${cleanRating}) - ${cleanRating! >= 55 ? "trends cleanly, good for options" : "moderate cleanliness"}.`);
  if (shortAgree) reasons.push("5m + 15m agree - intraday momentum in sync.");
  if (timing) reasons.push(`${timing === "READY TO MOVE" ? "🟢 READY TO MOVE" : timing === "UNDERWAY" ? "🟡 UNDERWAY" : "🔴 EXTENDED"} — ${timingReason}`);
  reasons.push(isFno ? "F&O available - options tradeable." : "Cash only - no options.");

  return {
    symbol, name, price: round2(price), isFno, direction, timing, timingReason,
    bestTf: best.tf, bestScore, bestConfidence, alignment, probability, atrPct,
    expectedDayMovePct, todayMoveRawPct,
    cleanRating, cleanGrade, intradaySuited, optionSuited, intradayScore, optionScore,
    tfSignals, reasons,
  };
}
