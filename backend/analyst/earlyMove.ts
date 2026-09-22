// ===================== Early-Move classifier (sequence-based, read-only) =====================
// Reads the SEQUENCE — prior structure → EMA21 interaction → liquidity behaviour
// → candle reaction → next-candle behaviour → BOS — from the app's EXISTING
// candle/EMA/structure/swing data. It does NOT use the simplistic
// "price>EMA9>EMA21 = bullish" rule, invents no indicator, and hard-codes no
// pattern. It NEVER manufactures a trade: it classifies the situation and hands
// the interpretation to the Master Trade Selector, which stays the final authority.

export type EarlyLabel =
  | "BULLISH CONTINUATION" | "BEARISH CONTINUATION"
  | "PULLBACK" | "EMA REJECTION" | "LIQUIDITY SWEEP"
  | "REVERSAL DEVELOPING" | "NO CLEAR EDGE" | "TIMEFRAME CONFLICT";

export interface Candle { open: number; high: number; low: number; close: number; volume?: number; time: number; }
export type Dir = "Bullish" | "Bearish" | "Ranging";

export interface EarlyMoveInput {
  candles: Candle[];             // 5M series
  ema21: (number | null)[];      // aligned to candles
  ema9?: (number | null)[];
  context5m: Dir;                // structure.currentStructure (5M)
  structure15m?: Dir | null;     // 15M structure, when available
  lastBos?: { direction: "Bullish" | "Bearish"; breakIndex: number; stage: "Pre" | "Confirmed"; time: number } | null;
  swingHigh?: number | null;     // most recent prior swing high before the last bars
  swingLow?: number | null;      // most recent prior swing low
  tfLabel?: string;              // label for the primary timeframe (e.g. "5M")
  otherTfLabel?: string;         // label for the cross-check timeframe (e.g. "15M")
}

export interface EarlyMove {
  label: EarlyLabel;
  emoji: string;
  timeframe: string;             // "5M"
  context: Dir;                  // prior market condition
  direction: "BULLISH" | "BEARISH" | "NEUTRAL"; // the move being watched
  emaReaction: string;           // EMA21 interaction description
  liquidity: string;             // liquidity behaviour
  candleBehaviour: string;       // reaction candle
  nextCandle: string;            // acceleration / stall
  bosStatus: "CONFIRMED" | "NOT YET CONFIRMED" | "NONE";
  watch: boolean;                // true = EARLY MOVE WATCH (pre-BOS developing move)
  confidence: number;            // 0..100 from evidence count (not a probability of profit)
  evidence: string[];
  action: string;                // advisory only — Master Selector is final
}

const EMOJI: Record<EarlyLabel, string> = {
  "BULLISH CONTINUATION": "🟢", "BEARISH CONTINUATION": "🔴",
  "PULLBACK": "🟡", "EMA REJECTION": "🟡", "LIQUIDITY SWEEP": "🟠",
  "REVERSAL DEVELOPING": "🔵", "NO CLEAR EDGE": "⚪", "TIMEFRAME CONFLICT": "⚠️",
};

const body = (c: Candle) => c.close - c.open;
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const range = (c: Candle) => c.high - c.low;

export function classifyEarlyMove(i: EarlyMoveInput): EarlyMove {
  const n = i.candles.length;
  const base = (label: EarlyLabel, direction: EarlyMove["direction"], extra: Partial<EarlyMove>): EarlyMove => ({
    label, emoji: EMOJI[label], timeframe: (i.tfLabel || "5M"), context: i.context5m, direction,
    emaReaction: "—", liquidity: "—", candleBehaviour: "—", nextCandle: "—",
    bosStatus: "NONE", watch: false, confidence: 0, evidence: [], action: "WAIT — insufficient sequence",
    ...extra,
  });
  if (n < 5) return base("NO CLEAR EDGE", "NEUTRAL", { action: "WAIT — not enough candles" });

  const last = i.candles[n - 1], prev = i.candles[n - 2];
  const e21 = i.ema21[n - 1];
  const avgRange = i.candles.slice(-10).reduce((s, c) => s + range(c), 0) / Math.min(10, n);

  // --- EMA21 interaction over the last 3 bars ---
  let emaTouch = false;
  for (let k = Math.max(0, n - 3); k < n; k++) { const e = i.ema21[k]; if (e != null && i.candles[k].low <= e && e <= i.candles[k].high) emaTouch = true; }
  const distEma = e21 != null ? Math.round((last.close - e21) * 10) / 10 : null;
  const emaReaction = e21 == null ? "EMA21 unavailable"
    : emaTouch ? `Price interacted with EMA21 (now ${distEma! >= 0 ? "+" : ""}${distEma} pts)`
    : `Price ${distEma! >= 0 ? "above" : "below"} EMA21 by ${Math.abs(distEma!)} pts (no touch)`;

  // --- Liquidity behaviour: did the last 3 bars sweep a prior swing then close back? ---
  let sweepLow = false, sweepHigh = false;
  for (let k = n - 3; k < n; k++) {
    const c = i.candles[k];
    if (i.swingLow != null && c.low < i.swingLow && c.close > i.swingLow) sweepLow = true;   // took liquidity below, closed back
    if (i.swingHigh != null && c.high > i.swingHigh && c.close < i.swingHigh) sweepHigh = true; // took liquidity above, closed back
  }
  const liquidity = sweepLow ? "Liquidity swept BELOW then reclaimed (sweep/rejection)"
    : sweepHigh ? "Liquidity swept ABOVE then rejected (sweep/rejection)"
    : "No clean liquidity sweep in the last 3 bars";

  // --- Candle reaction (last bar) ---
  const b = body(last), lw = lowerWick(last), uw = upperWick(last);
  const bullRejection = b > 0 && lw > Math.abs(b) * 1.2 && lw > uw;   // long lower wick + bullish close
  const bearRejection = b < 0 && uw > Math.abs(b) * 1.2 && uw > lw;   // long upper wick + bearish close
  const candleBehaviour = bullRejection ? "Bullish rejection candle (long lower wick)"
    : bearRejection ? "Bearish rejection candle (long upper wick)"
    : b > 0 ? "Bullish candle" : b < 0 ? "Bearish candle" : "Doji / flat";

  // --- Next-candle behaviour: is the latest bar accelerating vs the prior? ---
  const accelerating = Math.abs(b) > Math.abs(body(prev)) && Math.abs(b) > avgRange * 0.6;
  const nextCandle = accelerating ? "Latest candle accelerating (expansion)" : "No acceleration yet (stall/small body)";

  // --- BOS status (recent confirmed break of structure) ---
  const recentBos = i.lastBos && i.lastBos.stage === "Confirmed" && i.lastBos.breakIndex >= n - 2 ? i.lastBos : null;
  const bosStatus: EarlyMove["bosStatus"] = recentBos ? "CONFIRMED"
    : (bullRejection || bearRejection) && (sweepLow || sweepHigh) ? "NOT YET CONFIRMED" : "NONE";

  // --- Timeframe agreement ---
  const conflict = !!i.structure15m && i.structure15m !== "Ranging" && i.context5m !== "Ranging" && i.structure15m !== i.context5m;

  const ev: string[] = [];
  if (emaTouch) ev.push("EMA21 interaction");
  if (sweepLow || sweepHigh) ev.push("liquidity sweep");
  if (bullRejection || bearRejection) ev.push("rejection candle");
  if (accelerating) ev.push("acceleration");
  if (recentBos) ev.push("confirmed BOS");
  const confidence = Math.min(100, ev.length * 20);

  // ---- Classification (precedence: conflict → BOS → developing → trend) ----
  let label: EarlyLabel, direction: EarlyMove["direction"], action: string, watch = false;

  if (conflict) {
    label = "TIMEFRAME CONFLICT"; direction = "NEUTRAL";
    action = `WAIT — ${i.tfLabel||"5M"} ${i.context5m} vs ${i.otherTfLabel||"15M"} ${i.structure15m}`;
  } else if (recentBos) {
    const bosDir = recentBos.direction;
    const reversal = i.context5m !== "Ranging" && ((bosDir === "Bullish") !== (i.context5m === "Bullish"));
    direction = bosDir === "Bullish" ? "BULLISH" : "BEARISH";
    label = reversal ? "REVERSAL DEVELOPING" : (bosDir === "Bullish" ? "BULLISH CONTINUATION" : "BEARISH CONTINUATION");
    action = "BOS CONFIRMED — Master Trade Selector decides entry";
  } else if ((bullRejection && (sweepLow || emaTouch)) || (bearRejection && (sweepHigh || emaTouch))) {
    // A reaction against/with the trend near EMA21 with liquidity behaviour, no BOS yet.
    const reactDir: EarlyMove["direction"] = bullRejection ? "BULLISH" : "BEARISH";
    const against = (reactDir === "BULLISH") !== (i.context5m === "Bullish");
    if (against && (sweepLow || sweepHigh) && accelerating) { label = "REVERSAL DEVELOPING"; watch = true; }
    else if (against) { label = sweepLow || sweepHigh ? "LIQUIDITY SWEEP" : "EMA REJECTION"; watch = true; }
    else { label = "PULLBACK"; }
    direction = reactDir;
    action = watch ? "EARLY MOVE WATCH — WAIT FOR CONFIRMATION (BOS)" : "WAIT — pullback within trend";
  } else if (i.context5m !== "Ranging") {
    label = i.context5m === "Bullish" ? "BULLISH CONTINUATION" : "BEARISH CONTINUATION";
    direction = i.context5m === "Bullish" ? "BULLISH" : "BEARISH";
    action = "In-trend — Master Trade Selector decides";
  } else {
    label = "NO CLEAR EDGE"; direction = "NEUTRAL"; action = "WAIT — no clear edge";
  }

  return { label, emoji: EMOJI[label], timeframe: (i.tfLabel || "5M"), context: i.context5m, direction, emaReaction, liquidity, candleBehaviour, nextCandle, bosStatus, watch, confidence, evidence: ev, action };
}
