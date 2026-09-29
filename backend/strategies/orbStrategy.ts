import type { OrbRange, OrbBreakoutSignal } from "../orb/OpeningRangeBreakoutEngine";

// ============================ Opening Range Breakout — strategy evaluator ============================
// Deterministic, PURE evaluation of the ORB setup for the Strategy Lab / Test Zone.
// It REUSES the existing OpeningRangeBreakoutEngine (OR + close-based breakout +
// volume-SMA) and CONSUMES the app's existing VWAP / EMA / structure / OI / levels
// engines through inputs — it never recomputes them and never invents data. Every
// confirmation is PASS / FAIL / UNAVAILABLE; a missing engine is UNAVAILABLE, not a
// guessed pass. No look-ahead: the caller must pass only values known up to the
// current candle. This produces a signal + reason codes + an audit record; it does
// NOT place orders — the existing Master / Risk / Paper engines do that downstream.

export const ORB_REASON_CODES = [
  "NO_OPENING_RANGE", "NO_BREAKOUT", "BREAKOUT_NOT_CONFIRMED", "LOW_VOLUME",
  "VWAP_MISALIGNED", "EMA_MISALIGNED", "STRUCTURE_MISALIGNED", "OI_CONFLICT",
  "INSUFFICIENT_ROOM", "RR_FAILED", "RISK_FAILED", "EXISTING_POSITION",
  "TIME_WINDOW_EXPIRED", "FALSE_BREAKOUT", "OPTION_LIQUIDITY_FAILED", "DATA_UNAVAILABLE",
] as const;
export type OrbReasonCode = typeof ORB_REASON_CODES[number];

export type GateState = "PASS" | "FAIL" | "UNAVAILABLE";
export type OrbStatus = "WAIT" | "CANDIDATE" | "TAKE" | "INVALIDATED" | "FALSE_BREAKOUT";
export type OrbDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type OrbFinal = "TAKE CE" | "TAKE PE" | "WAIT" | "NO EDGE";

export const ORB_ENTRY_START_MIN = 9 * 60 + 30; // 09:30 IST
export const ORB_ENTRY_END_MIN = 11 * 60 + 30;  // 11:30 IST

export interface OrbConfig {
  entryStartMin: number;   // first minute a fresh ORB entry is allowed (09:30)
  entryEndMin: number;     // last minute a fresh ORB entry is allowed (11:30)
  minRoomPoints: number;   // required distance (index pts) to the opposing level
  minRR: number;           // ORB default target R:R (1:2)
  slMode: "structure" | "or_mid";  // stop at the opposite OR side, or OR mid
  oiHardGate: boolean;     // false ⇒ OI is supporting info only (never a hard veto)
}

export const DEFAULT_ORB_CONFIG: OrbConfig = {
  entryStartMin: ORB_ENTRY_START_MIN,
  entryEndMin: ORB_ENTRY_END_MIN,
  minRoomPoints: 20,
  minRR: 2,
  slMode: "structure",
  oiHardGate: false,
};

export interface OrbInputs {
  nowMin: number;                 // IST minute-of-day of the CURRENT candle (no look-ahead)
  range: OrbRange | null;         // from computeOpeningRange (5-min candles)
  breakout: OrbBreakoutSignal | null; // from detectOrbBreakout (null ⇒ no confirmed close outside)
  falseBreakout: boolean;         // a later candle closed back inside the range (caller-detected)
  // --- confirmations from the EXISTING engines (null ⇒ UNAVAILABLE, never invented) ---
  price: number | null;           // current close
  vwap: number | null;
  ema9: number | null;
  ema21: number | null;
  structureDirection: OrbDirection | null;  // existing market-structure verdict
  oiSupportsDirection: boolean | null;       // existing OI read supports the breakout side?
  opposingLevel: number | null;   // next major resistance (CE) / support (PE)
  optionLiquidityOk: boolean | null;
  // --- master / risk (existing engines) ---
  masterMinRR: number | null;     // the existing Master's REQUIRED R:R hard gate
  riskOk: boolean | null;         // existing Risk Engine verdict
  existingPosition: boolean;      // one open index-option trade already?
}

export interface OrbGates {
  volume: GateState; vwap: GateState; ema: GateState; structure: GateState;
  liquidity: GateState; oi: GateState; room: GateState; rr: GateState; master: GateState;
}

export interface OrbLevels { entry: number | null; sl: number | null; target: number | null; rr: number | null; roomPoints: number | null; }

export interface OrbEvaluation {
  status: OrbStatus;
  direction: OrbDirection;
  final: OrbFinal;
  gates: OrbGates;
  levels: OrbLevels;
  reasons: OrbReasonCode[];   // deterministic, ordered
  reasonText: string;          // human summary of the FIRST blocking reason
  orHigh: number | null; orLow: number | null; orRange: number | null; orMid: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Compute the index-based entry / SL / target / R:R for a confirmed breakout. */
export function computeOrbLevels(breakout: OrbBreakoutSignal, range: OrbRange, cfg: OrbConfig): OrbLevels {
  const entry = breakout.breakoutClose;
  const orMid = (range.high + range.low) / 2;
  const sl = cfg.slMode === "or_mid" ? orMid : (breakout.optionType === "CE" ? range.low : range.high);
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return { entry: r2(entry), sl: r2(sl), target: null, rr: null, roomPoints: null };
  const target = breakout.optionType === "CE" ? entry + cfg.minRR * risk : entry - cfg.minRR * risk;
  return { entry: r2(entry), sl: r2(sl), target: r2(target), rr: r2(Math.abs(target - entry) / risk), roomPoints: null };
}

/**
 * Evaluate the ORB setup deterministically. Returns the signal, the per-gate
 * PASS/FAIL/UNAVAILABLE map, the ordered reason codes, and the index levels.
 * A gate that is UNAVAILABLE never blocks (we cannot require an engine we do not
 * have — it is recorded, not invented); only a FAIL blocks. FALSE_BREAKOUT,
 * TIME_WINDOW_EXPIRED and EXISTING_POSITION are hard blocks.
 */
export function evaluateOrb(inp: OrbInputs, config: Partial<OrbConfig> = {}): OrbEvaluation {
  const cfg: OrbConfig = { ...DEFAULT_ORB_CONFIG, ...config };
  const reasons: OrbReasonCode[] = [];
  const gates: OrbGates = { volume: "UNAVAILABLE", vwap: "UNAVAILABLE", ema: "UNAVAILABLE", structure: "UNAVAILABLE", liquidity: "UNAVAILABLE", oi: "UNAVAILABLE", room: "UNAVAILABLE", rr: "UNAVAILABLE", master: "UNAVAILABLE" };
  const orHigh = inp.range ? r2(inp.range.high) : null;
  const orLow = inp.range ? r2(inp.range.low) : null;
  const orRange = inp.range ? r2(inp.range.high - inp.range.low) : null;
  const orMid = inp.range ? r2((inp.range.high + inp.range.low) / 2) : null;
  const base = { gates, orHigh, orLow, orRange, orMid };

  // No opening range yet (before 09:30 / no bars) ⇒ WAIT.
  if (!inp.range || !inp.range.formed) {
    return { status: "WAIT", direction: "NEUTRAL", final: "WAIT", levels: { entry: null, sl: null, target: null, rr: null, roomPoints: null }, reasons: ["NO_OPENING_RANGE"], reasonText: "Opening range still building (09:15–09:30).", ...base };
  }
  // No confirmed breakout close outside the range ⇒ WAIT.
  if (!inp.breakout) {
    return { status: "WAIT", direction: "NEUTRAL", final: "WAIT", levels: { entry: null, sl: null, target: null, rr: null, roomPoints: null }, reasons: ["NO_BREAKOUT"], reasonText: "No 5-min candle has closed outside the opening range yet.", ...base };
  }

  const direction: OrbDirection = inp.breakout.optionType === "CE" ? "BULLISH" : "BEARISH";
  const wantCE = inp.breakout.optionType === "CE";
  const levels = computeOrbLevels(inp.breakout, inp.range, cfg);

  // ---- Room to the opposing level (recomputes levels.roomPoints when known) ----
  if (inp.opposingLevel != null) {
    levels.roomPoints = r2(Math.abs(inp.opposingLevel - inp.breakout.breakoutClose));
  }

  // False breakout — a hard "no edge" (never auto-reverse; a new setup is required).
  if (inp.falseBreakout) {
    return { status: "FALSE_BREAKOUT", direction, final: "NO EDGE", levels, reasons: ["FALSE_BREAKOUT"], reasonText: `Price closed back inside the range after breaking — false breakout (no auto-reverse).`, ...base };
  }

  // ---- Gate evaluation (records PASS/FAIL/UNAVAILABLE; only FAIL blocks) ----
  // 1. Volume: index candles may have no volume ⇒ UNAVAILABLE (neutral), never a guess.
  gates.volume = inp.breakout.volumeSma20 > 0 ? (inp.breakout.volumeConfirmed ? "PASS" : "FAIL") : "UNAVAILABLE";
  if (gates.volume === "FAIL") reasons.push("LOW_VOLUME");
  // 2. VWAP
  if (inp.price != null && inp.vwap != null) { gates.vwap = (wantCE ? inp.price > inp.vwap : inp.price < inp.vwap) ? "PASS" : "FAIL"; if (gates.vwap === "FAIL") reasons.push("VWAP_MISALIGNED"); }
  // 3. EMA9 vs EMA21
  if (inp.ema9 != null && inp.ema21 != null) { gates.ema = (wantCE ? inp.ema9 > inp.ema21 : inp.ema9 < inp.ema21) ? "PASS" : "FAIL"; if (gates.ema === "FAIL") reasons.push("EMA_MISALIGNED"); }
  // 4. Market structure
  if (inp.structureDirection != null && inp.structureDirection !== "NEUTRAL") { gates.structure = inp.structureDirection === direction ? "PASS" : "FAIL"; if (gates.structure === "FAIL") reasons.push("STRUCTURE_MISALIGNED"); }
  // 5. Liquidity / opposing level present
  gates.liquidity = inp.opposingLevel != null ? "PASS" : "UNAVAILABLE";
  // 6. OI (supporting info by default; a hard gate only when configured)
  if (inp.oiSupportsDirection != null) {
    gates.oi = inp.oiSupportsDirection ? "PASS" : "FAIL";
    if (gates.oi === "FAIL") { reasons.push("OI_CONFLICT"); if (!cfg.oiHardGate) gates.oi = "FAIL"; }
  }
  // 7. Room to opposing level
  if (levels.roomPoints != null) { gates.room = levels.roomPoints >= cfg.minRoomPoints ? "PASS" : "FAIL"; if (gates.room === "FAIL") reasons.push("INSUFFICIENT_ROOM"); }
  // 8. R:R (ORB default 1:2)
  if (levels.rr != null) { gates.rr = levels.rr >= cfg.minRR ? "PASS" : "FAIL"; if (gates.rr === "FAIL") reasons.push("RR_FAILED"); }
  // 9. Master gate = existing hard R:R + one-position rule + risk engine.
  if (inp.existingPosition) { gates.master = "FAIL"; reasons.push("EXISTING_POSITION"); }
  else if (inp.masterMinRR != null && levels.rr != null && levels.rr < inp.masterMinRR) { gates.master = "FAIL"; if (!reasons.includes("RR_FAILED")) reasons.push("RR_FAILED"); }
  else if (inp.riskOk === false) { gates.master = "FAIL"; reasons.push("RISK_FAILED"); }
  else if (inp.masterMinRR != null && inp.riskOk != null) { gates.master = "PASS"; }
  // Option liquidity (downstream; recorded here when known)
  if (inp.optionLiquidityOk === false) reasons.push("OPTION_LIQUIDITY_FAILED");

  // ---- Entry window (fresh entries only 09:30–11:30) ----
  if (inp.nowMin > cfg.entryEndMin) { reasons.unshift("TIME_WINDOW_EXPIRED"); }

  // ---- Blocking decision: any FAIL gate, an expired window, false breakout,
  // existing position, failed risk, or failed option liquidity blocks a TAKE ----
  const hardBlock = reasons.some((c) => c !== "OI_CONFLICT" || cfg.oiHardGate);
  const anyFail = Object.values(gates).some((g) => g === "FAIL");

  if (reasons.includes("TIME_WINDOW_EXPIRED")) {
    return { status: "INVALIDATED", direction, final: "WAIT", levels, reasons, reasonText: "After 11:30 IST — no new ORB entry (existing trade follows the exit engine).", ...base };
  }
  if (hardBlock && anyFail) {
    return { status: "INVALIDATED", direction, final: "NO EDGE", levels, reasons, reasonText: reasonToText(reasons[0]), ...base };
  }
  if (hardBlock) {
    return { status: "INVALIDATED", direction, final: "WAIT", levels, reasons, reasonText: reasonToText(reasons[0]), ...base };
  }

  // ---- No blocking failure. TAKE only when the master gate has actually passed
  // (existing R:R + risk verified); otherwise it is a CANDIDATE still resolving. ----
  if (gates.master === "PASS" && inp.nowMin >= cfg.entryStartMin) {
    // Non-blocking notes (e.g. a supporting-only OI conflict) stay recorded.
    return { status: "TAKE", direction, final: wantCE ? "TAKE CE" : "TAKE PE", levels, reasons, reasonText: `ORB ${direction} confirmed — passes to Master/Risk.`, ...base };
  }
  return { status: "CANDIDATE", direction, final: "WAIT", levels, reasons: gates.master === "UNAVAILABLE" ? ["DATA_UNAVAILABLE"] : [], reasonText: "Breakout confirmed; awaiting Master/Risk verification.", ...base };
}

function reasonToText(code: OrbReasonCode): string {
  const map: Record<OrbReasonCode, string> = {
    NO_OPENING_RANGE: "Opening range not formed yet.",
    NO_BREAKOUT: "No confirmed close outside the opening range.",
    BREAKOUT_NOT_CONFIRMED: "Breakout not confirmed.",
    LOW_VOLUME: "Breakout volume below the confirmation threshold.",
    VWAP_MISALIGNED: "Price on the wrong side of VWAP for this direction.",
    EMA_MISALIGNED: "EMA9/EMA21 not aligned with the breakout.",
    STRUCTURE_MISALIGNED: "Market structure disagrees with the breakout.",
    OI_CONFLICT: "OI does not support the breakout side.",
    INSUFFICIENT_ROOM: "Not enough room to the opposing level.",
    RR_FAILED: "Risk:Reward below the required minimum.",
    RISK_FAILED: "Rejected by the Risk Engine.",
    EXISTING_POSITION: "An index-option trade is already open (one at a time).",
    TIME_WINDOW_EXPIRED: "Past the 11:30 IST entry cutoff.",
    FALSE_BREAKOUT: "False breakout — price closed back inside the range.",
    OPTION_LIQUIDITY_FAILED: "Selected option fails liquidity/spread checks.",
    DATA_UNAVAILABLE: "Required data unavailable this cycle.",
  };
  return map[code];
}
