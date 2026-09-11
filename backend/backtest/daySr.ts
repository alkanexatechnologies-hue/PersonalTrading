import { Candle } from "../types";

/**
 * Day S/R hourly analysis.
 *
 * For a chosen index + past date: computes classic FLOOR PIVOTS (PP, R1/R2, S1/S2)
 * from the PRIOR trading day's H/L/C, plus PDH/PDL, then walks the session hour by
 * hour (from 15m candles) and reports how far price broke each support/resistance
 * level in that hour.
 *
 * Historical option premiums aren't available, so the option move is a DELTA
 * ESTIMATE: an ATM option (delta ~0.5) moves ~0.5 x the index move. The % move is
 * sized off an ATM-premium PROXY derived from the day's ATR (a rough stand-in for
 * a real ATM straddle leg). Clearly an estimate - not real option data.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istHM = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const ATM_DELTA = 0.5;      // ATM option delta (per-point premium sensitivity)
const ATM_PREM_ATR_FRAC = 0.40; // ATM premium proxy ~ 40% of daily ATR (rough intraday-expiry stand-in)

// Hourly buckets across the 9:15-15:30 session.
const HOUR_BUCKETS: { label: string; start: number; end: number }[] = [
  { label: "09:15-10:15", start: 9 * 60 + 15, end: 10 * 60 + 15 },
  { label: "10:15-11:15", start: 10 * 60 + 15, end: 11 * 60 + 15 },
  { label: "11:15-12:15", start: 11 * 60 + 15, end: 12 * 60 + 15 },
  { label: "12:15-13:15", start: 12 * 60 + 15, end: 13 * 60 + 15 },
  { label: "13:15-14:15", start: 13 * 60 + 15, end: 14 * 60 + 15 },
  { label: "14:15-15:30", start: 14 * 60 + 15, end: 15 * 60 + 30 },
];

export interface SrLevels {
  pdh: number; pdl: number; pdc: number;
  pp: number; r1: number; r2: number; s1: number; s2: number;
}
export interface HourSr {
  hour: string;
  open: number; high: number; low: number; close: number;
  // resistance side
  resLevel: string | null; resValue: number | null; brokeUp: boolean; breakUpPts: number; breakUpPct: number;
  // support side
  supLevel: string | null; supValue: number | null; brokeDown: boolean; breakDownPts: number; breakDownPct: number;
  // net + estimated option move for the dominant break this hour
  netDir: "Up" | "Down" | "Flat";
  breakPts: number; breakPct: number; // magnitude of the dominant break (0 if none)
  brokeAt: string | null;   // exact HH:MM the level was first broken this hour (move START)
  moveEndAt: string | null; // exact HH:MM price reached its furthest point (move END)
  heldMin: number;          // minutes price stayed beyond the level (close-based) this hour
  reached: number | null;   // where price moved to (hour high on up-break, low on down-break)
  estOptType: "CE" | "PE" | null;
  estPremMovePts: number; // ~ break x delta
  estPremMovePct: number; // vs ATM premium proxy
  note: string;
}
export interface DaySrResult {
  symbol: string; name: string; date: string; weekday: string;
  levels: SrLevels;
  atrDaily: number;
  atmPremProxy: number;
  hours: HourSr[];
  summary: {
    hoursBrokeResistance: number;
    hoursBrokeSupport: number;
    biggestBreakPts: number; biggestBreakPct: number; biggestBreakHour: string | null; biggestBreakDir: "Up" | "Down" | null;
    biggestEstPremMovePct: number; biggestEstPremMoveHour: string | null;
    dayHigh: number; dayLow: number; dayRangePts: number; dayRangePct: number;
  };
  disclaimer: string;
}

function pivots(prev: Candle): SrLevels {
  const { high: H, low: L, close: C } = prev;
  const pp = (H + L + C) / 3;
  const r1 = 2 * pp - L;
  const s1 = 2 * pp - H;
  const r2 = pp + (H - L);
  const s2 = pp - (H - L);
  return { pdh: round2(H), pdl: round2(L), pdc: round2(C), pp: round2(pp), r1: round2(r1), r2: round2(r2), s1: round2(s1), s2: round2(s2) };
}

// Simple daily ATR(14) up to (and including) the prior day.
function atrUpTo(daily: Candle[], endIdx: number, period = 14): number {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0, n = 0;
  for (let i = start; i <= endIdx; i++) {
    const tr = Math.max(daily[i].high - daily[i].low, Math.abs(daily[i].high - daily[i - 1].close), Math.abs(daily[i].low - daily[i - 1].close));
    sum += tr; n++;
  }
  return n ? sum / n : daily[endIdx].high - daily[endIdx].low;
}

export function computeDaySr(symbol: string, name: string, c5: Candle[], c15: Candle[], daily: Candle[], date: string): DaySrResult | { error: string } {
  if (!daily || daily.length < 2) return { error: "Not enough daily history for pivots." };
  // Find the prior trading day's daily bar (strictly before `date`).
  let prevIdx = -1;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (istDateOf(daily[i].time) < date) { prevIdx = i; break; }
  }
  if (prevIdx < 1) return { error: "No prior trading day found before " + date + " in the available history." };
  const levels = pivots(daily[prevIdx]);
  const atrDaily = round2(atrUpTo(daily, prevIdx, 14));
  const atmPremProxy = round2(Math.max(1, atrDaily * ATM_PREM_ATR_FRAC));

  // Prefer 5-minute bars for precise breakout timing; fall back to 15m.
  const day5 = (c5 || []).filter((c) => istDateOf(c.time) === date);
  const day15 = (c15 || []).filter((c) => istDateOf(c.time) === date);
  const bars = (day5.length ? day5 : day15).slice().sort((a, b) => a.time - b.time);
  const barMin = day5.length ? 5 : 15;
  if (!bars.length) return { error: "No intraday data for " + symbol + " on " + date + "." };

  const weekday = DAY_NAMES[new Date(date + "T00:00:00Z").getUTCDay()];
  // Resistance levels above / support levels below, nearest first.
  const resAll = [
    { name: "PDH", v: levels.pdh }, { name: "R1", v: levels.r1 }, { name: "R2", v: levels.r2 }, { name: "PP", v: levels.pp },
  ].sort((a, b) => a.v - b.v);
  const supAll = [
    { name: "PDL", v: levels.pdl }, { name: "S1", v: levels.s1 }, { name: "S2", v: levels.s2 }, { name: "PP", v: levels.pp },
  ].sort((a, b) => b.v - a.v);

  const hours: HourSr[] = [];
  for (const b of HOUR_BUCKETS) {
    const hb = bars.filter((c) => istMin(c.time) >= b.start && istMin(c.time) < b.end);
    if (!hb.length) continue;
    const open = hb[0].open, close = hb[hb.length - 1].close;
    const high = Math.max(...hb.map((c) => c.high));
    const low = Math.min(...hb.map((c) => c.low));

    // Highest resistance cleared (high above it) and lowest support broken (low below it).
    let resLevel: string | null = null, resValue: number | null = null, breakUpPts = 0;
    for (const r of resAll) if (high > r.v && high - r.v >= breakUpPts) { /* pick the level with the largest clearance = furthest broken */ }
    // furthest resistance the price got ABOVE (largest break beyond a level)
    for (const r of resAll) { if (high > r.v) { const pts = high - r.v; if (resValue == null || r.v > resValue) { resLevel = r.name; resValue = r.v; breakUpPts = round2(pts); } } }
    let supLevel: string | null = null, supValue: number | null = null, breakDownPts = 0;
    for (const s of supAll) { if (low < s.v) { const pts = s.v - low; if (supValue == null || s.v < supValue) { supLevel = s.name; supValue = s.v; breakDownPts = round2(pts); } } }

    const brokeUp = resLevel != null;
    const brokeDown = supLevel != null;
    const breakUpPct = brokeUp && resValue ? round2((breakUpPts / resValue) * 100) : 0;
    const breakDownPct = brokeDown && supValue ? round2((breakDownPts / supValue) * 100) : 0;

    // Dominant break this hour = the larger of the two clearances.
    let netDir: HourSr["netDir"] = "Flat";
    let breakPts = 0, breakPct = 0;
    let estOptType: "CE" | "PE" | null = null;
    if (breakUpPts >= breakDownPts && brokeUp) { netDir = "Up"; breakPts = breakUpPts; breakPct = breakUpPct; estOptType = "CE"; }
    else if (breakDownPts > breakUpPts && brokeDown) { netDir = "Down"; breakPts = breakDownPts; breakPct = breakDownPct; estOptType = "PE"; }

    // Exact break time + how long price held beyond the level + where it reached.
    let brokeAt: string | null = null;
    let moveEndAt: string | null = null;
    let heldMin = 0;
    let reached: number | null = null;
    if (netDir === "Up" && resValue != null) {
      let hi = -Infinity, hiT: number | null = null;
      for (const c of hb) {
        if (c.high > resValue && brokeAt == null) brokeAt = istHM(c.time);
        if (c.close > resValue) heldMin += barMin;
        if (c.high > hi) { hi = c.high; hiT = c.time; }
      }
      reached = round2(high);
      moveEndAt = hiT != null ? istHM(hiT) : null;
    } else if (netDir === "Down" && supValue != null) {
      let lo = Infinity, loT: number | null = null;
      for (const c of hb) {
        if (c.low < supValue && brokeAt == null) brokeAt = istHM(c.time);
        if (c.close < supValue) heldMin += barMin;
        if (c.low < lo) { lo = c.low; loT = c.time; }
      }
      reached = round2(low);
      moveEndAt = loT != null ? istHM(loT) : null;
    }

    const estPremMovePts = round2(breakPts * ATM_DELTA);
    const estPremMovePct = round2((estPremMovePts / atmPremProxy) * 100);

    const note = netDir === "Flat"
      ? `Held inside ${round2(low)}-${round2(high)} - no S/R break this hour.`
      : `Broke ${netDir === "Up" ? "resistance " + resLevel : "support " + supLevel} (${netDir === "Up" ? resValue : supValue}) ${brokeAt} -> ${moveEndAt}, held ~${heldMin} min, price moved to ${reached} (${breakPts} pts / ${breakPct}%). Est ${estOptType} premium move ~${estPremMovePts} pts (~${estPremMovePct}% of a ~${atmPremProxy} ATM).`;

    hours.push({
      hour: b.label, open: round2(open), high: round2(high), low: round2(low), close: round2(close),
      resLevel, resValue, brokeUp, breakUpPts, breakUpPct,
      supLevel, supValue, brokeDown, breakDownPts, breakDownPct,
      netDir, breakPts, breakPct, brokeAt, moveEndAt, heldMin, reached, estOptType, estPremMovePts, estPremMovePct, note,
    });
  }

  const dayHigh = Math.max(...bars.map((c) => c.high));
  const dayLow = Math.min(...bars.map((c) => c.low));
  const hoursBrokeResistance = hours.filter((h) => h.netDir === "Up").length;
  const hoursBrokeSupport = hours.filter((h) => h.netDir === "Down").length;
  let biggestBreakPts = 0, biggestBreakPct = 0, biggestBreakHour: string | null = null, biggestBreakDir: "Up" | "Down" | null = null;
  let biggestEstPremMovePct = 0, biggestEstPremMoveHour: string | null = null;
  for (const h of hours) {
    if (h.breakPts > biggestBreakPts) { biggestBreakPts = h.breakPts; biggestBreakPct = h.breakPct; biggestBreakHour = h.hour; biggestBreakDir = h.netDir === "Flat" ? null : h.netDir; }
    if (h.estPremMovePct > biggestEstPremMovePct) { biggestEstPremMovePct = h.estPremMovePct; biggestEstPremMoveHour = h.hour; }
  }

  return {
    symbol, name, date, weekday, levels, atrDaily, atmPremProxy, hours,
    summary: {
      hoursBrokeResistance, hoursBrokeSupport,
      biggestBreakPts, biggestBreakPct, biggestBreakHour, biggestBreakDir,
      biggestEstPremMovePct, biggestEstPremMoveHour,
      dayHigh: round2(dayHigh), dayLow: round2(dayLow), dayRangePts: round2(dayHigh - dayLow), dayRangePct: round2(((dayHigh - dayLow) / dayLow) * 100),
    },
    disclaimer:
      "S/R = classic floor pivots (PP/R1/R2/S1/S2) from the prior day + PDH/PDL, computed on daily candles (exact). " +
      "Option move is a DELTA ESTIMATE (ATM delta ~0.5, premium move ~0.5x the index break; % vs an ATR-based ATM premium proxy) - " +
      "historical option premiums aren't available, so treat the option column as indicative, not actual.",
  };
}
