// ================= VWAP + 20 EMA Trend Continuation — GENERIC strategy evaluator =================
// One strategy implementation for EVERY index instrument. The strategy code holds
// NO instrument list and NO NIFTY/BANK NIFTY specifics — the caller passes an
// instrument context (from the app's existing config / Dhan mapping) plus the
// values computed by the EXISTING VWAP / EMA / ATR / structure engines. Anything a
// gate needs but doesn't have is UNAVAILABLE (never invented). Pure + deterministic
// so it is unit-testable and behaves identically for every index. It produces a
// signal + reason codes + audit; it never places an order (Master/Risk do that).

export const VE_REASON_CODES = [
  "OUTSIDE_WINDOW", "NO_TREND", "NO_PULLBACK", "NO_REVERSAL", "STRUCTURE_MISALIGNED",
  "OI_CONFLICT", "INSUFFICIENT_ROOM", "RR_FAILED", "RISK_FAILED", "EXISTING_POSITION",
  "OPTION_LIQUIDITY_FAILED", "DATA_UNAVAILABLE",
] as const;
export type VeReasonCode = typeof VE_REASON_CODES[number];

export type GateState = "PASS" | "FAIL" | "UNAVAILABLE";
export type VeStatus = "WAIT" | "CANDIDATE" | "TAKE" | "NO_EDGE";
export type VeDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type VeFinal = "TAKE CE" | "TAKE PE" | "WAIT" | "NO EDGE";

// Instrument context the strategy receives from the EXISTING config/Dhan mapping.
// The strategy reads these; it never hard-codes them per index.
export interface InstrumentContext {
  instrument: string;      // symbol, e.g. "^NSEI"
  name: string;
  instrumentType: string;  // "index"
  exchange?: string | null;
  securityId?: string | number | null;
  tickSize?: number | null;
  lotSize?: number | null;
  strikeStep?: number | null;
  expiry?: string | null;
  optionAvailability?: boolean | null;
}

// Instrument-tunable config. Defaults are generic; per-instrument OVERRIDES are
// applied dynamically by vwapEmaConfigFor() — the values are NOT baked into the
// strategy for any specific index.
export interface VwapEmaConfig {
  timeframe: string;       // "5m"
  setupStartMin: number;   // 10:00 IST
  setupEndMin: number;     // 13:00 IST
  emaPeriod: number;       // 20
  clusterMode: "ATR_RELATIVE" | "FIXED_PCT";
  clusterAtrMult: number;  // pullback counts when within this × ATR of the VWAP/EMA cluster
  clusterFixedPct: number; // fallback when ATR is unavailable (% of price)
  stopLossMode: "STRUCTURE" | "CLUSTER";
  targetMode: "SESSION_EXTREME" | "RR";
  minRR: number;
  oiHardGate: boolean;     // OI is supporting-only unless a per-index config makes it hard
  enabled: boolean;
}

export const DEFAULT_VE_CONFIG: VwapEmaConfig = {
  timeframe: "5m",
  setupStartMin: 10 * 60,   // 10:00
  setupEndMin: 13 * 60,     // 13:00
  emaPeriod: 20,
  clusterMode: "ATR_RELATIVE",
  clusterAtrMult: 0.75,
  clusterFixedPct: 0.15,
  stopLossMode: "STRUCTURE",
  targetMode: "SESSION_EXTREME",
  minRR: 2,
  oiHardGate: false,
  enabled: true,
};

// Per-instrument overrides live HERE (data), keyed by symbol — the strategy stays
// generic. Empty by default: every index uses the generic defaults until an
// instrument genuinely needs different tuning (tick/vol/liquidity differences).
export const VE_INSTRUMENT_OVERRIDES: Record<string, Partial<VwapEmaConfig>> = {
  // e.g. "^NSEMDCP50": { minRR: 2.5 }  // add only when validated by backtest
};

export function vwapEmaConfigFor(instrumentSymbol: string): VwapEmaConfig {
  return { ...DEFAULT_VE_CONFIG, ...(VE_INSTRUMENT_OVERRIDES[instrumentSymbol] || {}) };
}

export interface VwapEmaInputs {
  ctx: InstrumentContext;
  nowMin: number;            // IST minute of the current candle (no look-ahead)
  price: number | null;
  vwap: number | null;
  ema20: number | null;
  ema20Prev: number | null;  // for slope
  atr: number | null;
  structureDirection: VeDirection | null; // existing market-structure verdict
  reversalConfirmed: boolean | null;       // a reversal candle resumed the trend (caller-detected)
  oiSupportsDirection: boolean | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  swingSL: number | null;                  // structural stop (existing engine)
  opposingLevel: number | null;
  optionLiquidityOk: boolean | null;
  masterMinRR: number | null;
  riskOk: boolean | null;
  existingPosition: boolean;
}

export interface VeGates { trend: GateState; pullback: GateState; reversal: GateState; structure: GateState; oi: GateState; room: GateState; rr: GateState; master: GateState; }
export interface VeLevels { entry: number | null; sl: number | null; target: number | null; rr: number | null; roomPoints: number | null; clusterDistance: number | null; }
export interface VwapEmaEvaluation {
  instrument: string; status: VeStatus; direction: VeDirection; final: VeFinal;
  gates: VeGates; levels: VeLevels; reasons: VeReasonCode[]; reasonText: string;
  vwap: number | null; ema20: number | null; atr: number | null; trend: VeDirection;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Derive the trend from price vs VWAP and the EMA20 slope (no look-ahead). */
export function deriveTrend(price: number | null, vwap: number | null, ema20: number | null, ema20Prev: number | null): VeDirection {
  if (price == null || vwap == null || ema20 == null) return "NEUTRAL";
  const slope = ema20Prev != null ? ema20 - ema20Prev : 0;
  const above = price > vwap && price > ema20;
  const below = price < vwap && price < ema20;
  if (above && slope >= 0) return "BULLISH";
  if (below && slope <= 0) return "BEARISH";
  return "NEUTRAL";
}

/** The VWAP/EMA20 confluence cluster and the current pullback distance to it. */
export function clusterDistance(price: number | null, vwap: number | null, ema20: number | null): number | null {
  if (price == null || vwap == null || ema20 == null) return null;
  // Distance to the NEARER of VWAP / EMA20 (the confluence a pullback tags).
  return Math.min(Math.abs(price - vwap), Math.abs(price - ema20));
}

export function evaluateVwapEma(inp: VwapEmaInputs, config: Partial<VwapEmaConfig> = {}): VwapEmaEvaluation {
  const cfg: VwapEmaConfig = { ...vwapEmaConfigFor(inp.ctx.instrument), ...config };
  const gates: VeGates = { trend: "UNAVAILABLE", pullback: "UNAVAILABLE", reversal: "UNAVAILABLE", structure: "UNAVAILABLE", oi: "UNAVAILABLE", room: "UNAVAILABLE", rr: "UNAVAILABLE", master: "UNAVAILABLE" };
  const trend = deriveTrend(inp.price, inp.vwap, inp.ema20, inp.ema20Prev);
  const dist = clusterDistance(inp.price, inp.vwap, inp.ema20);
  const base = { instrument: inp.ctx.instrument, vwap: inp.vwap, ema20: inp.ema20, atr: inp.atr, trend };
  const emptyLv: VeLevels = { entry: null, sl: null, target: null, rr: null, roomPoints: null, clusterDistance: dist };

  // Setup window (fresh entries only within setupStart–setupEnd).
  if (inp.nowMin < cfg.setupStartMin || inp.nowMin > cfg.setupEndMin) {
    return { ...base, status: "WAIT", direction: trend, final: "WAIT", gates, levels: emptyLv, reasons: ["OUTSIDE_WINDOW"], reasonText: `Outside the ${fmt(cfg.setupStartMin)}–${fmt(cfg.setupEndMin)} IST setup window.` };
  }
  // Trend gate.
  gates.trend = trend === "NEUTRAL" ? "FAIL" : "PASS";
  if (gates.trend === "FAIL") return { ...base, status: "WAIT", direction: "NEUTRAL", final: "WAIT", gates, levels: emptyLv, reasons: ["NO_TREND"], reasonText: "No clean trend (price/VWAP/EMA20 not aligned)." };

  const wantCE = trend === "BULLISH";
  const reasons: VeReasonCode[] = [];

  // Pullback gate — price tagged the VWAP/EMA cluster.
  const clusterTol = cfg.clusterMode === "ATR_RELATIVE" && inp.atr != null
    ? inp.atr * cfg.clusterAtrMult
    : (inp.price != null ? inp.price * (cfg.clusterFixedPct / 100) : null);
  if (dist != null && clusterTol != null) { gates.pullback = dist <= clusterTol ? "PASS" : "FAIL"; if (gates.pullback === "FAIL") reasons.push("NO_PULLBACK"); }

  // Reversal candle gate.
  if (inp.reversalConfirmed != null) { gates.reversal = inp.reversalConfirmed ? "PASS" : "FAIL"; if (gates.reversal === "FAIL") reasons.push("NO_REVERSAL"); }

  // Structure gate.
  if (inp.structureDirection != null && inp.structureDirection !== "NEUTRAL") { gates.structure = inp.structureDirection === trend ? "PASS" : "FAIL"; if (gates.structure === "FAIL") reasons.push("STRUCTURE_MISALIGNED"); }

  // OI (supporting-only unless configured hard).
  if (inp.oiSupportsDirection != null) { gates.oi = inp.oiSupportsDirection ? "PASS" : "FAIL"; if (gates.oi === "FAIL") reasons.push("OI_CONFLICT"); }

  // ---- Levels: entry = price; SL = structure swing or cluster edge; target =
  // session extreme or R:R multiple. All from real inputs; null when unavailable. ----
  const entry = inp.price;
  let sl: number | null = null;
  if (cfg.stopLossMode === "STRUCTURE" && inp.swingSL != null) sl = inp.swingSL;
  else if (inp.vwap != null && inp.ema20 != null) sl = wantCE ? Math.min(inp.vwap, inp.ema20) : Math.max(inp.vwap, inp.ema20);
  let target: number | null = null;
  if (cfg.targetMode === "SESSION_EXTREME") target = wantCE ? inp.sessionHigh : inp.sessionLow;
  const risk = entry != null && sl != null ? Math.abs(entry - sl) : null;
  if ((target == null || (wantCE ? (target as number) <= (entry as number) : (target as number) >= (entry as number))) && entry != null && risk != null && risk > 0) {
    target = wantCE ? entry + cfg.minRR * risk : entry - cfg.minRR * risk; // fall back to R:R target
  }
  const rr = entry != null && sl != null && target != null && risk && risk > 0 ? Math.abs(target - entry) / risk : null;
  const roomPoints = inp.opposingLevel != null && entry != null ? Math.abs(inp.opposingLevel - entry) : null;
  const levels: VeLevels = { entry: entry != null ? r2(entry) : null, sl: sl != null ? r2(sl) : null, target: target != null ? r2(target) : null, rr: rr != null ? r2(rr) : null, roomPoints: roomPoints != null ? r2(roomPoints) : null, clusterDistance: dist != null ? r2(dist) : null };

  // Room + R:R gates.
  if (roomPoints != null) { gates.room = roomPoints >= 15 ? "PASS" : "FAIL"; if (gates.room === "FAIL") reasons.push("INSUFFICIENT_ROOM"); }
  if (rr != null) { gates.rr = rr >= cfg.minRR ? "PASS" : "FAIL"; if (gates.rr === "FAIL") reasons.push("RR_FAILED"); }

  // Master gate (existing hard R:R + one-position rule + risk engine).
  if (inp.existingPosition) { gates.master = "FAIL"; reasons.push("EXISTING_POSITION"); }
  else if (inp.masterMinRR != null && rr != null && rr < inp.masterMinRR) { gates.master = "FAIL"; if (!reasons.includes("RR_FAILED")) reasons.push("RR_FAILED"); }
  else if (inp.riskOk === false) { gates.master = "FAIL"; reasons.push("RISK_FAILED"); }
  else if (inp.masterMinRR != null && inp.riskOk != null) gates.master = "PASS";
  if (inp.optionLiquidityOk === false) reasons.push("OPTION_LIQUIDITY_FAILED");

  const blocking = reasons.filter((c) => c !== "OI_CONFLICT" || cfg.oiHardGate);
  if (blocking.length) {
    const anyFail = Object.values(gates).some((g) => g === "FAIL");
    return { ...base, status: anyFail ? "NO_EDGE" : "WAIT", direction: trend, final: anyFail ? "NO EDGE" : "WAIT", gates, levels, reasons, reasonText: veReasonToText(blocking[0]) };
  }
  if (gates.master === "PASS") {
    return { ...base, status: "TAKE", direction: trend, final: wantCE ? "TAKE CE" : "TAKE PE", gates, levels, reasons, reasonText: `VWAP+EMA20 ${trend} continuation confirmed — passes to Master/Risk.` };
  }
  return { ...base, status: "CANDIDATE", direction: trend, final: "WAIT", gates, levels, reasons: gates.master === "UNAVAILABLE" ? ["DATA_UNAVAILABLE"] : [], reasonText: "Setup forming; awaiting Master/Risk verification." };
}

function fmt(min: number): string { const h = Math.floor(min / 60), m = min % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }
function veReasonToText(code: VeReasonCode): string {
  const map: Record<VeReasonCode, string> = {
    OUTSIDE_WINDOW: "Outside the setup window.",
    NO_TREND: "No clean trend.",
    NO_PULLBACK: "Price has not pulled back to the VWAP/EMA20 cluster.",
    NO_REVERSAL: "No reversal candle resuming the trend yet.",
    STRUCTURE_MISALIGNED: "Market structure disagrees with the trend.",
    OI_CONFLICT: "OI does not support the trend side.",
    INSUFFICIENT_ROOM: "Not enough room to the opposing level.",
    RR_FAILED: "Risk:Reward below the required minimum.",
    RISK_FAILED: "Rejected by the Risk Engine.",
    EXISTING_POSITION: "An index-option trade is already open (one at a time).",
    OPTION_LIQUIDITY_FAILED: "Selected option fails liquidity/spread checks.",
    DATA_UNAVAILABLE: "Required data unavailable this cycle.",
  };
  return map[code];
}
