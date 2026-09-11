import { Candle } from "../types";
import { atr, last, rsi } from "../indicators";
import { computeSignal } from "../signals/engine";
import { computeMomentumBurst } from "../scalp/momentum";

// ---- Early-Move detector ----
// Flags a move in its INITIAL stage so you can act early instead of chasing:
//   - a CLEAR fresh direction on 5m,
//   - momentum IGNITING (squeeze just fired / expansion just starting) or a YOUNG
//     trend that isn't extended yet,
//   - VOLUME confirming the move,
//   - only a SMALL part of the typical day range used so far (lots of potential left).
// A move that is already extended (high RSI stretch / most of the day range spent)
// is deliberately NOT flagged - that's late, not initial.

export interface EarlyMove {
  symbol: string; name: string; type: "index" | "equity"; price: number;
  direction: "up" | "down"; optionType: "CE" | "PE";
  stage: "Igniting" | "Early"; // Igniting = squeeze just fired; Early = young, not extended
  burstState: string; burstScore: number;
  rvol: number | null;
  movedTodayPct: number | null;     // move from today's open in the move's direction
  expectedDayMovePct: number | null; // typical full-day range (daily ATR%)
  potentialPct: number | null;      // % still available to the typical day range
  progressPct: number | null;       // how much of the day range is used (0-100)
  rsiStretch: number | null;        // 0-100: how stretched (in the move's direction)
  earlyScore: number;               // 0-100 freshness/quality of the initial move
  dayHigh: number; dayLow: number;  // today's session high / low
  posInRange: number;               // 0=at day low, 100=at day high
  distToExtremePct: number;         // % distance to the day HIGH (up) or day LOW (down) it is pressing
  message: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function relVol(c: Candle[]): number | null {
  if (!c || c.length < 12) return null;
  const vols = c.map((x) => Number(x.volume) || 0);
  const recent = vols.slice(-3);
  const meanRecent = recent.reduce((s, v) => s + v, 0) / recent.length;
  const base = vols.slice(-30, -3);
  const meanBase = base.length ? base.reduce((s, v) => s + v, 0) / base.length : 0;
  return meanBase > 0 ? meanRecent / meanBase : null;
}

export function computeEarlyMove(
  symbol: string, name: string, type: "index" | "equity",
  c5: Candle[], c15: Candle[], daily: Candle[],
): EarlyMove | null {
  if (!c5 || c5.length < 30 || !c15 || c15.length < 20) return null;
  const burst = computeMomentumBurst(symbol, c5);
  const sig5 = computeSignal(symbol, c5);
  const price = sig5.price;
  if (!price) return null;

  // 1) A clear fresh direction on the fast (5m) clock.
  const dir: "up" | "down" | null = sig5.score >= 20 ? "up" : sig5.score <= -20 ? "down" : null;
  if (!dir) return null;

  // 2) The 15m must not actively oppose it.
  const sig15 = computeSignal(symbol, c15);
  if (dir === "up" && sig15.score < -15) return null;
  if (dir === "down" && sig15.score > 15) return null;

  // 2b) NEAR the day's extreme ONLY (user filter): an UP move must be pressing the
  // day HIGH (breakout side), a DOWN move pressing the day LOW. Mid-range early
  // moves are excluded — we only want names about to break the day's high/low.
  const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const todayIso = istDay(c5[c5.length - 1].time);
  const todayBars = c5.filter((x) => istDay(x.time) === todayIso);
  const dayHigh = todayBars.length ? Math.max(...todayBars.map((x) => x.high)) : price;
  const dayLow = todayBars.length ? Math.min(...todayBars.map((x) => x.low)) : price;
  const dayRange = Math.max(1e-9, dayHigh - dayLow);
  const posInRange = clamp(((price - dayLow) / dayRange) * 100, 0, 100); // 0=at low, 100=at high
  const distHighPct = round2(((dayHigh - price) / price) * 100);
  const distLowPct = round2(((price - dayLow) / price) * 100);
  const NEAR_PCT = 0.3; // within 0.3% of the extreme (or top/bottom 18% of the range)
  const nearHigh = distHighPct <= NEAR_PCT || posInRange >= 82;
  const nearLow = distLowPct <= NEAR_PCT || posInRange <= 18;
  if (dir === "up" && !nearHigh) return null;
  if (dir === "down" && !nearLow) return null;

  // 3) NOT already extended (that would be late, not initial).
  const rsi15 = last(rsi(c15.map((x) => x.close), 14));
  const rsiStretch = rsi15 == null ? null : (dir === "up" ? rsi15 : 100 - rsi15);
  if (rsiStretch != null && rsiStretch >= 68) return null;

  // 4) Volume confirmation (indices often have no volume feed - fall back to burst).
  const rvol = relVol(c5);
  const volOk = (rvol != null && rvol >= 1.2) || burst.volumeSurge >= 1.3;

  // 5) Only a small part of the typical day range used so far -> lots of potential.
  const atrD = daily && daily.length > 20 ? last(atr(daily, 14)) : null;
  const expectedDayMovePct = atrD != null && price > 0 ? round2((atrD / price) * 100) : null;
  const today = daily && daily.length ? daily[daily.length - 1] : null;
  let movedTodayPct: number | null = null, progressPct: number | null = null, potentialPct: number | null = null;
  if (today && today.open > 0) {
    const raw = ((price - today.open) / today.open) * 100;
    movedTodayPct = round2(dir === "up" ? raw : -raw);
  }
  if (expectedDayMovePct != null && movedTodayPct != null) {
    progressPct = Math.round(clamp((Math.max(0, movedTodayPct) / expectedDayMovePct) * 100, 0, 100));
    potentialPct = round2(Math.max(0, expectedDayMovePct - Math.max(0, movedTodayPct)));
  }
  const young = progressPct == null || progressPct < 45;

  // Stage classification.
  const firedDir = (burst.state === "Fired Up" && dir === "up") || (burst.state === "Fired Down" && dir === "down");
  const expandingDir = (burst.state === "Expanding Up" && dir === "up") || (burst.state === "Expanding Down" && dir === "down");
  let stage: "Igniting" | "Early" | null = null;
  if (firedDir) stage = "Igniting";                                   // squeeze just released our way = textbook initial stage
  else if ((expandingDir || burst.squeezeOn) && young && volOk) stage = "Early";
  else if (young && volOk && Math.abs(sig5.score) >= 30 && (rsiStretch == null || rsiStretch < 60)) stage = "Early";
  if (!stage) return null;
  if (!volOk && stage !== "Igniting") return null; // igniting squeeze may precede the volume print

  const earlyScore = clamp(Math.round(
    (stage === "Igniting" ? 30 : 12) +
    clamp(burst.burstScore * 0.3, 0, 30) +
    clamp(((rvol ?? burst.volumeSurge) - 1) * 20, 0, 20) +
    clamp((45 - (progressPct ?? 20)) * 0.4, 0, 18) +     // less progress = fresher
    clamp((60 - (rsiStretch ?? 50)) * 0.2, 0, 10),
  ), 0, 100);

  const optionType = dir === "up" ? "CE" : "PE";
  const arrow = dir === "up" ? "▲" : "▼";
  const potTxt = potentialPct != null ? `~${potentialPct}% potential left` : "room to run";
  const movedTxt = movedTodayPct != null ? `, moved ${movedTodayPct}% today` : "";
  const volTxt = rvol != null ? `, vol ${round1(rvol)}x` : "";
  const extremeTxt = dir === "up" ? `day High ${round2(dayHigh)} के पास (${distHighPct}% दूर)` : `day Low ${round2(dayLow)} के पास (${distLowPct}% दूर)`;
  const message = `${arrow} ${name} ${stage === "Igniting" ? "IGNITING" : "EARLY"} ${dir.toUpperCase()} — ${optionType} side · ${extremeTxt}${movedTxt}, ${potTxt}${volTxt}.`;

  return {
    symbol, name, type, price: round2(price), direction: dir, optionType, stage,
    burstState: burst.state, burstScore: burst.burstScore,
    rvol: rvol == null ? null : round2(rvol),
    movedTodayPct, expectedDayMovePct, potentialPct, progressPct,
    rsiStretch: rsiStretch == null ? null : Math.round(rsiStretch),
    dayHigh: round2(dayHigh), dayLow: round2(dayLow), posInRange: Math.round(posInRange),
    distToExtremePct: dir === "up" ? distHighPct : distLowPct,
    earlyScore, message,
  };
}
