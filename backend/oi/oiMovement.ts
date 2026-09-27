// ============================================================================
//  OI-MOVEMENT JUDGE  (ADDITIVE — read-only, changes NO existing logic)
// ----------------------------------------------------------------------------
//  Purpose: judge how OI is MOVING right now, over two windows:
//    • 5-MIN  → TRADE-purpose read  (short-term OI flow + price)
//    • 15-MIN → DIRECTIONAL bias    (where the market is likely to move)
//
//  This module is a passive observer. It is fed the ATM±band CE/PE OI sums that
//  the /market-command handler ALREADY computes, keeps a small in-memory rolling
//  history per symbol, and derives windowed OI movement. It NEVER votes into
//  marketView / tradePlan / Best Strike, never mutates any input, and fabricates
//  nothing — when there isn't enough history yet it reports available:false with
//  a "building" note.
//
//  Standard option-OI interpretation used throughout:
//    PE OI ↑ = put  WRITING   → support building   → bullish for underlying
//    PE OI ↓ = put  UNWINDING → support pulling out → bearish
//    CE OI ↑ = call WRITING   → resistance building → bearish
//    CE OI ↓ = call COVERING  → resistance lifting  → bullish
//  Net bullish OI flow  =  ΔPE_OI − ΔCE_OI   (positive = bullish).
// ============================================================================

export interface OiSample {
  t: number;      // wall-clock seconds when recorded
  asOf: number;   // OI data timestamp (used to dedupe stale repeats)
  ceOi: number;   // ATM±band summed CALL OI
  peOi: number;   // ATM±band summed PUT  OI
  pcr: number;
  spot: number;
}

export type OiSignal = "BULLISH" | "BEARISH" | "CAUTION" | "NEUTRAL";
export type OiStrength = "CALM" | "ACTIVE" | "FAST" | "EXPLOSIVE";

export interface OiMoveWindow {
  available: boolean;
  building: boolean;        // some data, but less than the full window so far
  windowMin: number;        // requested window (5 or 15)
  coveredSec: number;       // actual span of history used
  ceOiChg: number;          // Δ CALL OI over the window
  peOiChg: number;          // Δ PUT  OI over the window
  pcrChg: number;
  ceFlow: "writing" | "unwinding" | "flat";
  peFlow: "writing" | "unwinding" | "flat";
  dominant: string;         // human: "PE writing", "CE covering", …
  bullishScorePct: number;  // (ΔPE − ΔCE) / baseTotalOI × 100  (signed)
  velocityPctPerMin: number;// (|ΔCE| + |ΔPE|) / baseTotalOI / min × 100
  strength: OiStrength;
  priceMove: number;        // spot change over the window
  pricePct: number;
  signal: OiSignal;
  confirmed: boolean;       // OI flow agrees with the price move
  guidance: string;         // one-line actionable text
}

export interface OiMoveResult {
  available: boolean;
  asOf: number;
  samples: number;
  trade: OiMoveWindow | null;      // 5-min
  direction: OiMoveWindow | null;  // 15-min
  summary: string;
  note?: string;
}

// ---- Tunables (heuristic, documented; not derived from any hidden model) ----
const MAX_HISTORY_SEC = 16 * 60;      // keep ~16 min of samples
const NEUTRAL_BAND_PCT = 0.15;        // |bullishScore%| below this = NEUTRAL flow
const STRENGTH = { active: 0.20, fast: 0.50, explosive: 1.0 }; // %/min of total OI
const MIN_COVER_SEC = 60;             // need at least 60s of history for a read
const FULL_COVER_FRAC = 0.6;          // ≥60% of the window = "not building"

const _history = new Map<string, OiSample[]>();

// Record one OI reading. De-duped on `asOf` so the ~15s-cached OI value isn't
// counted many times by the 5s poll. Safe to call every request.
export function recordOiSample(symbol: string, s: Omit<OiSample, "t">): void {
  if (!symbol || !Number.isFinite(s.ceOi) || !Number.isFinite(s.peOi)) return;
  const now = Math.floor(Date.now() / 1000);
  const arr = _history.get(symbol) || [];
  const last = arr[arr.length - 1];
  if (last && last.asOf === s.asOf) return; // same OI snapshot — skip duplicate
  arr.push({ t: now, asOf: s.asOf, ceOi: s.ceOi, peOi: s.peOi, pcr: s.pcr, spot: s.spot });
  const cutoff = now - MAX_HISTORY_SEC;
  while (arr.length && arr[0].t < cutoff) arr.shift();
  _history.set(symbol, arr);
}

// Optional: clear a symbol's history (e.g., on index switch). Not required.
export function resetOiMovement(symbol?: string): void {
  if (symbol) _history.delete(symbol); else _history.clear();
}

function flowOf(chg: number, side: "CE" | "PE"): "writing" | "unwinding" | "flat" {
  if (chg === 0) return "flat";
  // For both sides a POSITIVE OI change is "writing", negative is "unwinding".
  // (CE unwinding is call covering; PE unwinding is put unwinding.)
  return chg > 0 ? "writing" : "unwinding";
}

function strengthOf(velPctPerMin: number): OiStrength {
  const v = Math.abs(velPctPerMin);
  if (v >= STRENGTH.explosive) return "EXPLOSIVE";
  if (v >= STRENGTH.fast) return "FAST";
  if (v >= STRENGTH.active) return "ACTIVE";
  return "CALM";
}

function dominantFlow(ceChg: number, peChg: number): string {
  const opts: Array<{ mag: number; label: string }> = [
    { mag: peChg > 0 ? peChg : 0, label: "PE writing (support building)" },
    { mag: peChg < 0 ? -peChg : 0, label: "PE unwinding (support pulling out)" },
    { mag: ceChg > 0 ? ceChg : 0, label: "CE writing (resistance building)" },
    { mag: ceChg < 0 ? -ceChg : 0, label: "CE covering (resistance lifting)" },
  ];
  opts.sort((a, b) => b.mag - a.mag);
  return opts[0].mag > 0 ? opts[0].label : "no clear OI flow";
}

function buildWindow(arr: OiSample[], windowMin: number, kind: "trade" | "direction"): OiMoveWindow | null {
  const latest = arr[arr.length - 1];
  if (!latest) return null;
  const windowSec = windowMin * 60;
  const targetT = latest.t - windowSec;
  // Pick the most recent sample at/older than the window start; else the oldest.
  let past: OiSample | null = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= targetT) { past = arr[i]; break; }
  }
  if (!past) past = arr[0];
  const coveredSec = latest.t - past.t;
  if (coveredSec < MIN_COVER_SEC) return { ...emptyWindow(windowMin), building: true };

  const ceOiChg = latest.ceOi - past.ceOi;
  const peOiChg = latest.peOi - past.peOi;
  const pcrChg = +(latest.pcr - past.pcr).toFixed(2);
  const baseTotal = Math.max(1, past.ceOi + past.peOi);
  const minutes = Math.max(coveredSec / 60, 0.5);

  const bullishScorePct = +(((peOiChg - ceOiChg) / baseTotal) * 100).toFixed(2);
  const velocityPctPerMin = +(((Math.abs(ceOiChg) + Math.abs(peOiChg)) / baseTotal / minutes) * 100).toFixed(2);
  const priceMove = +(latest.spot - past.spot).toFixed(2);
  const pricePct = past.spot > 0 ? +((priceMove / past.spot) * 100).toFixed(2) : 0;

  const leanBull = bullishScorePct > NEUTRAL_BAND_PCT;
  const leanBear = bullishScorePct < -NEUTRAL_BAND_PCT;
  const priceAgree = (leanBull && priceMove > 0) || (leanBear && priceMove < 0);

  let signal: OiSignal = "NEUTRAL";
  let confirmed = false;
  if (leanBull || leanBear) {
    if (priceAgree) { signal = leanBull ? "BULLISH" : "BEARISH"; confirmed = true; }
    else { signal = "CAUTION"; confirmed = false; } // OI vs price divergence
  }

  const dominant = dominantFlow(ceOiChg, peOiChg);
  const strength = strengthOf(velocityPctPerMin);

  return {
    available: true,
    building: coveredSec < windowSec * FULL_COVER_FRAC,
    windowMin,
    coveredSec,
    ceOiChg: Math.round(ceOiChg),
    peOiChg: Math.round(peOiChg),
    pcrChg,
    ceFlow: flowOf(ceOiChg, "CE"),
    peFlow: flowOf(peOiChg, "PE"),
    dominant,
    bullishScorePct,
    velocityPctPerMin,
    strength,
    priceMove,
    pricePct,
    signal,
    confirmed,
    guidance: guidanceFor(kind, signal, strength, dominant, confirmed),
  };
}

function emptyWindow(windowMin: number): OiMoveWindow {
  return {
    available: false, building: true, windowMin, coveredSec: 0,
    ceOiChg: 0, peOiChg: 0, pcrChg: 0, ceFlow: "flat", peFlow: "flat",
    dominant: "no clear OI flow", bullishScorePct: 0, velocityPctPerMin: 0,
    strength: "CALM", priceMove: 0, pricePct: 0, signal: "NEUTRAL",
    confirmed: false, guidance: "Building OI history…",
  };
}

function guidanceFor(kind: "trade" | "direction", signal: OiSignal, strength: OiStrength, dominant: string, confirmed: boolean): string {
  const fast = strength === "FAST" || strength === "EXPLOSIVE";
  if (kind === "trade") {
    switch (signal) {
      case "BULLISH": return `${fast ? "Fast " : ""}bullish OI flow (${dominant}) + price up — favours CE / longs.`;
      case "BEARISH": return `${fast ? "Fast " : ""}bearish OI flow (${dominant}) + price down — favours PE / shorts.`;
      case "CAUTION": return `OI (${dominant}) vs price disagree — wait for alignment before a trade.`;
      default: return "OI flat — no fresh trade edge; wait.";
    }
  }
  // direction (15M)
  switch (signal) {
    case "BULLISH": return `15M OI leaning UP — ${dominant}${confirmed ? ", price confirming" : ""}.`;
    case "BEARISH": return `15M OI leaning DOWN — ${dominant}${confirmed ? ", price confirming" : ""}.`;
    case "CAUTION": return `15M OI and price disagree (${dominant}) — likely range / indecision.`;
    default: return "15M OI balanced — rangebound bias.";
  }
}

// Build the dual-window judgement from the current in-memory history.
export function computeOiMovement(symbol: string): OiMoveResult {
  const arr = _history.get(symbol) || [];
  const asOf = arr.length ? arr[arr.length - 1].asOf : Math.floor(Date.now() / 1000);
  if (arr.length < 2) {
    return { available: false, asOf, samples: arr.length, trade: null, direction: null, summary: "Building OI history…", note: "Needs ~1 min of live OI to start; 5/15-min reads fill in as the session runs." };
  }
  const trade = buildWindow(arr, 5, "trade");
  const direction = buildWindow(arr, 15, "direction");
  const tradeSig = trade && trade.available ? trade.signal : "…";
  const dirSig = direction && direction.available ? direction.signal : "…";
  const dirWord = direction && direction.available
    ? (direction.signal === "BULLISH" ? "UP" : direction.signal === "BEARISH" ? "DOWN" : direction.signal === "CAUTION" ? "RANGE?" : "FLAT")
    : "…";
  return {
    available: !!(trade && trade.available) || !!(direction && direction.available),
    asOf,
    samples: arr.length,
    trade,
    direction,
    summary: `Trade (5M): ${tradeSig} · Direction (15M): ${dirWord}`,
  };
}
