import { CooldownState } from "../trade/cooldownStore";

// ===================== Intraday confirmation flow (NO Master Trade Selector) =====================
// The trade decision is a fixed sequence of EXISTING engine reads:
//
//   MARKET DIRECTION → PRICE ACTION → STRUCTURE → ENTRY → OPTION → ACTION
//
// PRICE ACTION is its own context-aware layer (fed by the existing multi-timeframe
// fake-move engine — candle behaviour, breakout/failed-breakout, HH/HL vs LH/LL,
// EMA/VWAP reaction, liquidity sweep + rejection). It is NEVER a single-candle or
// "price>EMA" read. The Master Trade Selector is intentionally NOT part of this
// flow and is not required for a decision. ACTION = TRADE only when direction,
// price action and structure AGREE and entry + option are confirmed; any conflict
// or a live post-trade cooldown forces WAIT. Nothing here changes SL/target/risk
// or strike logic — it only decides WAIT vs TRADE and explains why.

export const CONFIRMATION_FLOW_VERSION = "flow/v1-noMTS";

export type Dir3 = "BULLISH" | "BEARISH" | "NEUTRAL";
export type FlowAction = "TRADE" | "WAIT" | "DATA UNAVAILABLE";

export interface FlowStep {
  key: "marketDirection" | "priceAction" | "structure" | "entry" | "option";
  label: string;
  state: string;   // BULLISH / BEARISH / NEUTRAL / CONFIRMED / PENDING / CONFLICT / UNAVAILABLE / WAIT
  ok: boolean;     // does this step agree/pass for a trade?
  detail: string;
}

export interface ConfirmationFlow {
  version: string;
  direction: Dir3;
  steps: FlowStep[];
  conflict: boolean;
  action: FlowAction;
  reason: string;
  cooldownActive: boolean;
}

export interface PriceActionInput {
  // From the existing multi-timeframe fake-move engine (read-only).
  available: boolean;
  status: string;          // e.g. BREAKOUT_ACCEPTED / FAILED_BREAKOUT / EARLY_REJECTION / RETEST / CONFLICT / NONE
  direction: "UP" | "DOWN" | "NONE";
  confidence: number;      // 0..100 evidence score
  confirmationState: string; // CONFIRMED_ALIGNED / WATCH / CONFLICT / NONE
  note: string;
}

export interface ConfirmationFlowInput {
  direction: string;              // marketView.direction: BULLISH/BEARISH/NEUTRAL/CONFLICT
  priceAction: PriceActionInput | null;
  structure: string;              // ms.currentStructure: Bullish/Bearish/Ranging
  entryReady: boolean;
  entryDetail: string;
  optionReady: boolean;
  optionDetail: string;
  dataAvailable: boolean;
  dataStale: boolean;
  cooldown: CooldownState;
}

const dir3 = (s: string): Dir3 =>
  s === "BULLISH" || s === "Bullish" ? "BULLISH" :
  s === "BEARISH" || s === "Bearish" ? "BEARISH" : "NEUTRAL";

const paDir = (pa: PriceActionInput | null): Dir3 =>
  !pa || !pa.available ? "NEUTRAL" : pa.direction === "UP" ? "BULLISH" : pa.direction === "DOWN" ? "BEARISH" : "NEUTRAL";

/** Deterministic 6-step confirmation flow. No Master Trade Selector, no invented
 *  thresholds — every state comes from an existing engine read. */
export function buildConfirmationFlow(inp: ConfirmationFlowInput): ConfirmationFlow {
  const md = dir3(inp.direction);
  const pa = inp.priceAction;
  const paState = paDir(pa);
  const st = dir3(inp.structure);

  const mk = (key: FlowStep["key"], label: string, state: string, ok: boolean, detail: string): FlowStep =>
    ({ key, label, state, ok, detail });

  // ---- Data gates first (never decide a trade on missing/stale data) ----------
  if (!inp.dataAvailable) {
    const steps = [
      mk("marketDirection", "Market Direction", "UNAVAILABLE", false, "No live snapshot."),
      mk("priceAction", "Price Action", "UNAVAILABLE", false, "No candle data."),
      mk("structure", "Structure", "UNAVAILABLE", false, "No structure."),
      mk("entry", "Entry", "UNAVAILABLE", false, "—"),
      mk("option", "Option", "UNAVAILABLE", false, "—"),
    ];
    return { version: CONFIRMATION_FLOW_VERSION, direction: "NEUTRAL", steps, conflict: false, action: "DATA UNAVAILABLE", reason: "DATA UNAVAILABLE", cooldownActive: false };
  }

  // Build the five steps (always computed — monitoring continues during cooldown).
  const paStateLabel = pa && pa.available ? (paState === "NEUTRAL" ? (pa.status || "NO CLEAR EDGE") : `${paState} RESPONSE`) : "DATA UNAVAILABLE";
  const steps: FlowStep[] = [
    mk("marketDirection", "Market Direction", md, md !== "NEUTRAL", inp.direction === "CONFLICT" ? "Engines conflict on direction." : `Validated direction: ${md}.`),
    mk("priceAction", "Price Action", paStateLabel, !!pa && pa.available && paState !== "NEUTRAL", pa && pa.available ? `${pa.status} · ${pa.confirmationState} · evidence ${pa.confidence}%${pa.note ? " · " + pa.note : ""}` : "Price-action engine has no read yet."),
    mk("structure", "Structure", st === "NEUTRAL" ? "RANGING" : st, st !== "NEUTRAL", `Market structure ${inp.structure}.`),
    mk("entry", "Entry", inp.entryReady ? "CONFIRMED" : "PENDING", inp.entryReady, inp.entryDetail || "—"),
    mk("option", "Option", inp.optionReady ? "CONFIRMED" : "PENDING", inp.optionReady, inp.optionDetail || "—"),
  ];

  // ---- Conflict detection across the three directional layers -----------------
  const dirs = [md, paState, st];
  const hasBull = dirs.includes("BULLISH");
  const hasBear = dirs.includes("BEARISH");
  const conflict = hasBull && hasBear; // two layers point opposite ways
  if (conflict) {
    steps.forEach((s) => { if (s.key === "priceAction" && paState !== md && paState !== "NEUTRAL") s.state = `${paState} RESPONSE`; });
  }

  // ---- Post-trade cooldown takes precedence: no new trade during the window,
  // but analysis keeps running (steps above are still computed). This is the
  // mandatory 15-minute gate — it wins over conflict/stale for the shown reason.
  if (inp.cooldown && inp.cooldown.active) {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict, action: "WAIT", reason: `WAIT — ${inp.cooldown.reason || "POST TRADE COOLDOWN"}`, cooldownActive: true };
  }

  if (conflict) {
    const mdS = md, paS = paState, stS = st;
    const parts: string[] = [];
    if (paS !== "NEUTRAL" && paS !== mdS) parts.push(`PRICE ACTION ${paS} vs DIRECTION ${mdS}`);
    if (stS !== "NEUTRAL" && stS !== mdS) parts.push(`STRUCTURE ${stS} vs DIRECTION ${mdS}`);
    if (stS !== "NEUTRAL" && paS !== "NEUTRAL" && stS !== paS) parts.push(`PRICE ACTION ${paS} vs STRUCTURE ${stS}`);
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: true, action: "WAIT", reason: "CONFLICT — " + (parts[0] || "layers disagree"), cooldownActive: false };
  }

  // ---- Stale data: never issue a live trade decision --------------------------
  if (inp.dataStale) {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "WAIT", reason: "WAIT — DATA STALE", cooldownActive: false };
  }

  // ---- No clear directional edge ---------------------------------------------
  if (md === "NEUTRAL") {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "WAIT", reason: "WAIT — NO CLEAR DIRECTION", cooldownActive: false };
  }
  if (paState === "NEUTRAL" || !pa || !pa.available) {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "WAIT", reason: "WAIT — PRICE ACTION NOT CONFIRMED", cooldownActive: false };
  }
  if (st === "NEUTRAL") {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "WAIT", reason: "WAIT — STRUCTURE RANGING", cooldownActive: false };
  }

  // Direction + Price Action + Structure all AGREE. Gate on entry + option.
  if (!inp.entryReady) {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "WAIT", reason: "WAIT — ENTRY NOT CONFIRMED", cooldownActive: false };
  }
  if (!inp.optionReady) {
    return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "WAIT", reason: "WAIT — OPTION NOT CONFIRMED", cooldownActive: false };
  }

  return { version: CONFIRMATION_FLOW_VERSION, direction: md, steps, conflict: false, action: "TRADE", reason: `TRADE — ${md}: direction, price action and structure aligned; entry + option confirmed.`, cooldownActive: false };
}
