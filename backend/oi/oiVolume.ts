// =====================================================================
//  OI Command - Groww-style volume indicator
//  ----------------------------------------------------------------
//  Groww shows a volume histogram under the price chart: green/red bars
//  whose height reflects how much traded, and the bars visibly "spike"
//  (get taller / more active) when price breaks out of a range.
//
//  This module reproduces that read for the OI Command using the 5-minute
//  underlying candles. It is honest about indices (NIFTY/BANKNIFTY) that
//  report no volume on the feed - it returns { available:false } so the UI
//  can show "N/A" instead of a misleading flat bar.
//
//  The key idea the user asked for: in a BREAKOUT, the volume indicator is
//  MORE ACTIVE. We detect breakout state (spot beyond the opening range /
//  previous-day high-low) and confirm it with relative volume (rvol). When
//  a breakout happens on elevated volume we flag `breakoutConfirmed` and
//  push the activity meter high, exactly like Groww's tall breakout bars.
// =====================================================================
import { Candle } from "../types";
import { analyzeVolume } from "../volume/analyze";

export interface OiVolumeBar {
  time: number;
  rvol: number;      // volume vs trailing average (x)
  rel: number;       // 0..1 height fraction vs the tallest bar in the window
  up: boolean;       // close >= open (green) else red
  breakout: boolean; // this bar poked beyond the opening range / PD level
}

export interface OiVolume {
  available: boolean;                 // false for symbols with no volume feed (indices)
  rvol: number | null;                // current relative volume (x average)
  rvolState: "very high" | "high" | "normal" | "low" | null;
  state: "SURGING" | "ACTIVE" | "NORMAL" | "QUIET" | "N/A";
  activity: number;                   // 0..100 activity meter for the display
  flow: "Accumulation" | "Distribution" | "Neutral";
  obvTrend: "rising" | "falling" | "flat";
  breakout: "UP" | "DOWN" | null;     // current price-structure breakout
  breakoutConfirmed: boolean;         // breakout happening on active volume
  bars: OiVolumeBar[];                // recent bars for a Groww-style histogram
  note: string;
}

interface Levels {
  spot: number;
  orbHigh: number | null;
  orbLow: number | null;
  pdh: number | null;
  pdl: number | null;
  oiDirection: "UP" | "DOWN" | "FLAT";
}

const BAR_WINDOW = 14; // how many recent 5m bars to show as histogram
const AVG_PERIOD = 20; // trailing average for per-bar rvol

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeOiVolume(candles: Candle[], lv: Levels): OiVolume {
  const emptyBars: OiVolumeBar[] = [];
  const na: OiVolume = {
    available: false,
    rvol: null,
    rvolState: null,
    state: "N/A",
    activity: 0,
    flow: "Neutral",
    obvTrend: "flat",
    breakout: null,
    breakoutConfirmed: false,
    bars: emptyBars,
    note: "No volume feed for this symbol (common for indices like NIFTY/BANKNIFTY). Use the index FUTURES or a stock to see live volume.",
  };
  if (!candles || candles.length < 2) return na;

  const totalVol = candles.reduce((a, c) => a + (c.volume || 0), 0);
  if (totalVol <= 0) return na;

  // Reuse the shared volume engine for the aggregate read (rvol, flow, OBV).
  const va = analyzeVolume("oi", candles);

  // --- current breakout state (price structure) ---------------------------
  // A breakout = spot pushed beyond the opening 15m range (and, stronger,
  // beyond the previous-day high/low). This mirrors Groww's "range break".
  let breakout: "UP" | "DOWN" | null = null;
  if (lv.orbHigh != null && lv.spot > lv.orbHigh) breakout = "UP";
  else if (lv.orbLow != null && lv.spot < lv.orbLow) breakout = "DOWN";
  else if (lv.pdh != null && lv.spot > lv.pdh) breakout = "UP";
  else if (lv.pdl != null && lv.spot < lv.pdl) breakout = "DOWN";

  const rvol = va.rvol || 0;
  // Volume is "active" once relative volume is meaningfully above average.
  const volActive = rvol >= 1.3;
  const breakoutConfirmed = breakout != null && volActive;

  // --- Groww-style histogram (recent bars) --------------------------------
  const n = candles.length;
  const from = Math.max(0, n - BAR_WINDOW);
  const slice = candles.slice(from);
  const maxVol = Math.max(1, ...slice.map((c) => c.volume || 0));
  const bars: OiVolumeBar[] = slice.map((c, i) => {
    const gi = from + i; // global index
    const avgFrom = Math.max(0, gi - AVG_PERIOD);
    const prior = candles.slice(avgFrom, gi).map((x) => x.volume || 0);
    const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : (c.volume || 0);
    const r = avg > 0 ? (c.volume || 0) / avg : 0;
    // did this bar itself poke beyond a breakout level?
    const brk =
      (lv.orbHigh != null && c.high > lv.orbHigh) ||
      (lv.orbLow != null && c.low < lv.orbLow) ||
      (lv.pdh != null && c.high > lv.pdh) ||
      (lv.pdl != null && c.low < lv.pdl);
    return {
      time: c.time,
      rvol: round2(r),
      rel: round2((c.volume || 0) / maxVol),
      up: c.close >= c.open,
      breakout: !!brk && r >= 1.3, // only a "breakout bar" if it also traded actively
    };
  });

  // --- headline state + activity meter ------------------------------------
  // SURGING = breakout on strong volume (Groww's tall bars); ACTIVE = high
  // rvol without a clean break; QUIET = drying up; NORMAL otherwise.
  let state: OiVolume["state"];
  if (breakoutConfirmed && rvol >= 2) state = "SURGING";
  else if (breakoutConfirmed || rvol >= 2) state = "ACTIVE";
  else if (rvol < 0.6) state = "QUIET";
  else state = "NORMAL";

  // Activity 0..100: scale rvol (2.5x ~= full) then boost on a confirmed break.
  let activity = Math.min(100, Math.round((rvol / 2.5) * 100));
  if (breakoutConfirmed) activity = Math.min(100, activity + 20);
  activity = Math.max(0, activity);

  const flow = va.verdict?.bias || "Neutral";

  const note = (() => {
    if (breakoutConfirmed) {
      return `${breakout} breakout on ${round2(rvol)}x volume - move is BACKED by participation (Groww bars spiking).`;
    }
    if (breakout && !volActive) {
      return `${breakout} breakout but volume only ${round2(rvol)}x - weak participation, watch for a fake-out.`;
    }
    if (rvol >= 2) return `Volume ${round2(rvol)}x average - unusually active even without a clean range break.`;
    if (state === "QUIET") return `Volume ${round2(rvol)}x - drying up, market waiting for a trigger.`;
    return `Volume ${round2(rvol)}x average - routine participation.`;
  })();

  return {
    available: true,
    rvol: round2(rvol),
    rvolState: va.rvolState,
    state,
    activity,
    flow,
    obvTrend: va.obvTrend,
    breakout,
    breakoutConfirmed,
    bars,
    note,
  };
}
