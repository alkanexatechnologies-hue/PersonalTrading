import { CooldownState } from "../trade/cooldownStore";

// ===================== Intraday confirmation flow (NO Master Trade Selector) =====================
// Final agreed flow — a fixed sequence of EXISTING engine reads:
//
//   DATA → MARKET STATE → DIRECTION → PRICE ACTION → STRUCTURE → ROOM → OPTION → RISK → EXECUTION
//
// Mandatory gates only. EMA21 is a CONDITIONAL reversal check (not a permanent
// gate). Conflict is REGIME-DEPENDENT (only blocks in RANGE / TRANSITIONING).
// OI is supporting evidence, never a universal gate. PRICE ACTION is one gate fed
// by the existing multi-timeframe fake-move engine (never a single-candle read).
// Nothing here changes SL/target/risk or strike logic — it only decides WAIT vs
// TRADE, explains why with ONE primary reason, and lists the gates for the UI.

export const CONFIRMATION_FLOW_VERSION = "flow/v2-gates";

export type Dir3 = "BULLISH" | "BEARISH" | "NEUTRAL";
export type FlowAction = "TRADE" | "WAIT" | "DATA UNAVAILABLE" | "DATA STALE";
export type GateStatus = "PASS" | "WAIT" | "FAIL" | "OFF" | "PENDING" | "UNAVAILABLE" | "TRADE";

export interface FlowGate {
  key: "data" | "break" | "priceAction" | "structure" | "direction" | "ema21" | "option" | "entry" | "risk" | "execution";
  label: string;
  status: GateStatus;
  detail: string;
}

// Kept for backward-compatibility with the earlier 5-step consumers.
export interface FlowStep { key: string; label: string; state: string; ok: boolean; detail: string; }

export interface PriceActionInput {
  available: boolean;
  status: string;            // BREAKOUT_ACCEPTED / FAILED_BREAKOUT / EARLY_REJECTION / RETEST / CONFLICT / NONE
  direction: "UP" | "DOWN" | "NONE";
  confidence: number;        // 0..100 evidence score
  confirmationState: string; // CONFIRMED_ALIGNED / WATCH / CONFLICT / NONE
  note: string;
}
export interface RoomInput { pts: number | null; minPts: number; nextLevel: number | null; nextLabel: string | null; }
export interface Ema21Input { state: "OFF" | "ACTIVE" | "CONFIRMED"; detail: string; }

export interface ConfirmationFlowInput {
  dataAvailable: boolean;
  dataStale: boolean;
  marketState: string;       // OPENING_BREAK_UP/DOWN | TRENDING | RANGE | TRANSITIONING | UNKNOWN
  regime: string;            // TRENDING | RANGE | TRANSITIONING | ... (for conflict logic)
  direction: string;         // marketView.direction: BULLISH/BEARISH/NEUTRAL/CONFLICT
  priceAction: PriceActionInput | null;
  structure: string;         // ms.currentStructure: Bullish/Bearish/Ranging
  room: RoomInput;
  ema21: Ema21Input;
  entryReady: boolean;
  entryDetail: string;
  optionReady: boolean;
  optionDetail: string;
  cooldown: CooldownState;
}

export interface ConfirmationFlow {
  version: string;
  direction: Dir3;
  marketState: string;
  activePhase: string;       // PART 1 BREAK / PART 2 SUSTAINED / PART 3 STRUCTURE / RANGE MODE
  gates: FlowGate[];
  steps: FlowStep[];         // legacy 5-step view (marketDirection/priceAction/structure/entry/option)
  conflict: boolean;
  room: RoomInput;
  ema21: Ema21Input;
  action: FlowAction;
  reason: string;
  cooldownActive: boolean;
}

const dir3 = (s: string): Dir3 =>
  s === "BULLISH" || s === "Bullish" ? "BULLISH" :
  s === "BEARISH" || s === "Bearish" ? "BEARISH" : "NEUTRAL";
const paDir = (pa: PriceActionInput | null): Dir3 =>
  !pa || !pa.available ? "NEUTRAL" : pa.direction === "UP" ? "BULLISH" : pa.direction === "DOWN" ? "BEARISH" : "NEUTRAL";

function activePhaseFor(marketState: string, structure: string): string {
  if (marketState === "RANGE") return "RANGE MODE";
  if (marketState === "TRANSITIONING") return "PART 1 — BREAK CONDITION";
  if (marketState === "OPENING_BREAK_UP" || marketState === "OPENING_BREAK_DOWN") return "PART 1 — BREAK CONDITION";
  if (structure === "Bullish" || structure === "Bearish") return "PART 3 — DEFINED STRUCTURE";
  return "PART 2 — SUSTAINED DIRECTION";
}

/** Deterministic gated flow. No Master Trade Selector, no invented thresholds —
 *  every state comes from an existing engine read. Returns ONE primary reason. */
export function buildConfirmationFlow(inp: ConfirmationFlowInput): ConfirmationFlow {
  const md = dir3(inp.direction);
  const pa = inp.priceAction;
  const paState = paDir(pa);
  const st = dir3(inp.structure);
  const room = inp.room || { pts: null, minPts: 20, nextLevel: null, nextLabel: null };
  const ema21 = inp.ema21 || { state: "OFF", detail: "" };
  const marketState = inp.marketState || "UNKNOWN";
  const activePhase = activePhaseFor(marketState, inp.structure);

  const G = (key: FlowGate["key"], label: string, status: GateStatus, detail: string): FlowGate => ({ key, label, status, detail });
  const stepsFrom = (gates: FlowGate[]): FlowStep[] => {
    const pick = (k: string) => gates.find((g) => g.key === k);
    const toStep = (k: string, legacyKey: string, label: string): FlowStep => {
      const g = pick(k)!;
      return { key: legacyKey, label, state: g.status === "PASS" ? (label === "Market Direction" ? md : "CONFIRMED") : g.status, ok: g.status === "PASS", detail: g.detail };
    };
    return [toStep("direction", "marketDirection", "Market Direction"), toStep("priceAction", "priceAction", "Price Action"), toStep("structure", "structure", "Structure"), toStep("entry", "entry", "Entry"), toStep("option", "option", "Option")];
  };
  const done = (gates: FlowGate[], action: FlowAction, reason: string, conflict = false, cooldownActive = false): ConfirmationFlow =>
    ({ version: CONFIRMATION_FLOW_VERSION, direction: md, marketState, activePhase, gates, steps: stepsFrom(gates), conflict, room, ema21, action, reason, cooldownActive });

  // ---- GATE 1: DATA (fresh + available) — always first --------------------------
  if (!inp.dataAvailable) {
    const gates = [G("data", "Data", "UNAVAILABLE", "No live snapshot."), G("break", "Market State", "UNAVAILABLE", "—"), G("priceAction", "Price Action", "UNAVAILABLE", "—"), G("structure", "Structure", "UNAVAILABLE", "—"), G("direction", "Direction", "UNAVAILABLE", "—"), G("ema21", "EMA21", "OFF", "—"), G("option", "Option", "UNAVAILABLE", "—"), G("entry", "Entry", "UNAVAILABLE", "—"), G("risk", "Risk", "PENDING", "—"), G("execution", "Execution", "WAIT", "No data")];
    return done(gates, "DATA UNAVAILABLE", "DATA UNAVAILABLE");
  }

  // Build the informational gates that are always shown.
  const gBreak = G("break", "Market State", marketState === "UNKNOWN" ? "PENDING" : "PASS", marketState.replace(/_/g, " "));
  const gDir = G("direction", "Direction", md !== "NEUTRAL" ? "PASS" : "WAIT", inp.direction === "CONFLICT" ? "Engines conflict on direction." : `Direction ${md}.`);
  const paOk = !!pa && pa.available && paState !== "NEUTRAL" && (paState === md || md === "NEUTRAL");
  const gPa = G("priceAction", "Price Action", paOk ? "PASS" : (pa && pa.available ? "WAIT" : "UNAVAILABLE"), pa && pa.available ? `${pa.status} · ${pa.confirmationState} · ${pa.confidence}%` : "No price-action read.");
  const gStruct = G("structure", "Structure", (st !== "NEUTRAL" && (st === md || md === "NEUTRAL")) ? "PASS" : (st === "NEUTRAL" ? "WAIT" : "WAIT"), st === "NEUTRAL" ? "Ranging" : `${st}.`);
  // EMA21 is conditional: OFF = trend continuation, ACTIVE = reversal check, CONFIRMED = reversal evidence. Never blocks a trend trade.
  const gEma = G("ema21", "EMA21", ema21.state === "OFF" ? "OFF" : ema21.state === "CONFIRMED" ? "PASS" : "PENDING", ema21.detail || (ema21.state === "OFF" ? "Trend continuation" : ema21.state === "ACTIVE" ? "Reversal check" : "Reversal evidence"));
  const gOpt = G("option", "Option", inp.optionReady ? "PASS" : "WAIT", inp.optionDetail || "—");
  const roomOk = room.pts == null || room.pts >= room.minPts; // unknown room does not block
  const entryStatus: GateStatus = !roomOk ? "WAIT" : inp.entryReady ? "PASS" : "WAIT";
  const gEntry = G("entry", "Entry", entryStatus, !roomOk ? `Room ${room.pts}p < ${room.minPts}p` : inp.entryReady ? "Entry zone reached" : (inp.entryDetail || "Entry zone not reached"));
  const gRisk = G("risk", "Risk", inp.entryReady && roomOk ? "PASS" : "PENDING", inp.entryReady && roomOk ? "R:R checked" : "Check on entry");

  const gatesBase = (execStatus: GateStatus, execDetail: string): FlowGate[] =>
    [G("data", "Data", "PASS", "Fresh"), gBreak, gPa, gStruct, gDir, gEma, gOpt, gEntry, gRisk, G("execution", "Execution", execStatus, execDetail)];

  // ---- Cooldown precedence — no new trade during the 15-min window --------------
  if (inp.cooldown && inp.cooldown.active) {
    const conflict = [md, paState, st].includes("BULLISH") && [md, paState, st].includes("BEARISH");
    return done(gatesBase("WAIT", "Post-trade cooldown"), "WAIT", `WAIT — ${inp.cooldown.reason || "POST TRADE COOLDOWN"}`, conflict, true);
  }
  // ---- Stale data — never a live decision ---------------------------------------
  if (inp.dataStale) return done(gatesBase("WAIT", "Data stale"), "DATA STALE", "WAIT — DATA STALE");

  // ---- Direction ----------------------------------------------------------------
  if (md === "NEUTRAL") return done(gatesBase("WAIT", "No direction"), "WAIT", "WAIT — NO CLEAR DIRECTION");

  // ---- Conflict (REGIME-DEPENDENT: only blocks in RANGE / TRANSITIONING) ---------
  const conflict = [md, paState, st].includes("BULLISH") && [md, paState, st].includes("BEARISH");
  const regimeGuarded = /RANGE|TRANSITION/i.test(inp.regime || "") || /RANGE|TRANSITION/i.test(marketState);
  if (conflict && regimeGuarded) {
    const parts: string[] = [];
    if (paState !== "NEUTRAL" && paState !== md) parts.push(`PRICE ACTION ${paState} vs DIRECTION ${md}`);
    if (st !== "NEUTRAL" && st !== md) parts.push(`STRUCTURE ${st} vs DIRECTION ${md}`);
    return done(gatesBase("WAIT", "Conflict"), "WAIT", "CONFLICT — " + (parts[0] || "layers disagree"), true);
  }

  // ---- Price Action -------------------------------------------------------------
  if (!paOk) return done(gatesBase("WAIT", "Price action"), "WAIT", "WAIT — PRICE ACTION NOT CONFIRMED", conflict);
  // ---- Structure ----------------------------------------------------------------
  if (st === "NEUTRAL") return done(gatesBase("WAIT", "Structure"), "WAIT", "WAIT — STRUCTURE RANGING", conflict);
  if (st !== md) return done(gatesBase("WAIT", "Structure"), "WAIT", `WAIT — STRUCTURE ${st} vs DIRECTION ${md}`, conflict);
  // ---- Option -------------------------------------------------------------------
  if (!inp.optionReady) return done(gatesBase("WAIT", "Option"), "WAIT", "WAIT — OPTION NOT READY", conflict);
  // ---- Room (≥ 20 pts to next opposing level) -----------------------------------
  if (!roomOk) return done(gatesBase("WAIT", "Insufficient room"), "WAIT", `WAIT — INSUFFICIENT ROOM (${room.pts}p < ${room.minPts}p)`, conflict);
  // ---- Entry (zone reached) → RISK checked on entry -----------------------------
  if (!inp.entryReady) return done(gatesBase("WAIT", "Entry not reached"), "WAIT", "WAIT — ENTRY NOT READY", conflict);

  // All mandatory gates pass → TRADE.
  return done(gatesBase("TRADE", "All gates passed"), "TRADE", `TRADE — ${md}: data, market state, direction, price action, structure, room and option confirmed; entry reached.`, conflict);
}
