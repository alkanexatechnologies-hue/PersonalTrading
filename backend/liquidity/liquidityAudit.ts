import fs from "fs";
import path from "path";
import { LiquidityEventType, SweepDirection } from "./sweepDetector";
import { LevelType } from "./liquidityLevels";
import { NOT_DEFINED } from "./liquidityConfig";

// ============================ Liquidity audit log ============================
// Append-only JSONL, one row per detected liquidity event. Same pattern as
// auth/loginAudit.ts and advisory/suggestionLog.ts.
//
// Every field named in §11 is present. Fields this application cannot supply are
// written as the explicit string "UNAVAILABLE" / "NOT_DEFINED" with a reason,
// never as a plausible-looking number:
//
//   VIX              -> UNAVAILABLE (no India VIX symbol, feed or series exists)
//   liquidityLevel   -> may be NOT_DEFINED for EQUAL_HIGH/EQUAL_LOW/ROUND_NUMBER/
//                       TRENDLINE_TOUCH, whose definitions were not supplied

export type OiState =
  | "CALL_OI_ADDING" | "CALL_OI_UNWINDING"
  | "PUT_OI_ADDING" | "PUT_OI_UNWINDING"
  | "MIXED" | "UNAVAILABLE";

export type VwapState = "ABOVE_VWAP" | "BELOW_VWAP" | "AT_VWAP" | "UNAVAILABLE";

export interface LiquidityAuditEvent {
  timestamp: number;          // epoch seconds
  istDate: string;
  istTime: string;
  symbol: string;
  rangeHigh: number | null;
  rangeLow: number | null;
  /** Nearest liquidity level price, or null. */
  liquidityLevel: number | null;
  liquidityLevelType: LevelType | "NONE";
  eventType: LiquidityEventType;
  sweepDirection: SweepDirection;
  sweepPrice: number | null;
  reclaimPrice: number | null;
  candleTimeframe: string;
  ATR14: number | null;
  wickPercentage: number | null;
  bodyPercentage: number | null;
  OIState: OiState;
  VWAPState: VwapState;
  EMA21: number | null;
  EMA50: number | null;
  /** Always "UNAVAILABLE" in this application - see NOT_DEFINED.indiaVix. */
  VIX: string;
  trapFlag: boolean;
  /** Supplied §8 confirmation reads, recorded without any scoring applied. */
  confirmations: {
    oiNote: string;
    vwapNote: string;
    emaNote: string;
    vixNote: string;
  };
  /** §7 concept only, never connected to execution. */
  entryConcept: { direction: "BULLISH" | "BEARISH" | "NONE"; slConcept: string };
  /** Present when detection could not run. */
  skipReason?: string | null;
}

const DIR = path.join(process.cwd(), "data", "liquidity");
const FILE = path.join(DIR, "liquidity-events.jsonl");

export function logLiquidityEvent(e: LiquidityAuditEvent): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(e) + "\n", "utf-8");
  } catch { /* audit logging is best-effort - it never blocks anything */ }
}

export function readLiquidityEvents(limit = 500): LiquidityAuditEvent[] {
  try {
    const lines = fs.readFileSync(FILE, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function liquidityEventsFilePath(): string {
  return FILE;
}

/**
 * Dedupe key: one row per symbol per event kind per direction per session. The
 * dashboard re-polls every ~15s, and without this a single sweep would be logged
 * hundreds of times and make the §14 frequency counts meaningless.
 */
export function liquidityDedupeKey(e: Pick<LiquidityAuditEvent, "symbol" | "istDate" | "eventType" | "sweepDirection" | "sweepPrice">): string {
  return `${e.symbol}|${e.istDate}|${e.eventType}|${e.sweepDirection}|${e.sweepPrice ?? "-"}`;
}

const seen = new Set<string>();

/** Logs the event unless an equivalent one was already recorded this session. */
export function logLiquidityEventOnce(e: LiquidityAuditEvent): boolean {
  if (e.eventType === "NONE") return false; // nothing happened - not an event
  const key = liquidityDedupeKey(e);
  if (seen.has(key)) return false;
  if (seen.size > 5000) seen.clear();
  seen.add(key);
  logLiquidityEvent(e);
  return true;
}

export function _resetLiquidityDedupe(): void {
  seen.clear();
}

/** The fixed VIX value for this application, with its reason. */
export const VIX_UNAVAILABLE = "UNAVAILABLE";
export const VIX_NOTE = NOT_DEFINED.indiaVix;

/**
 * §8 confirmation reads. These record WHAT THE DATA SAYS using the exact supplied
 * wording. No threshold, weight or score is applied, and none of them alters the
 * classification produced by sweepDetector.
 */
export function buildConfirmations(inp: {
  direction: SweepDirection;
  ceBuildup: string | null;
  peBuildup: string | null;
  spot: number | null;
  vwap: number | null;
  ema21: number | null;
  ema50: number | null;
}): LiquidityAuditEvent["confirmations"] {
  // OI — supplied: "Call OI unwinding -> supports genuine upside break;
  //                 Call OI adding -> more likely sweep".
  let oiNote = "UNAVAILABLE";
  if (inp.ceBuildup) {
    const unwinding = /unwinding|short covering/i.test(inp.ceBuildup);
    const adding = /buildup/i.test(inp.ceBuildup);
    oiNote = unwinding
      ? `Call OI ${inp.ceBuildup} — supports genuine upside break`
      : adding
        ? `Call OI ${inp.ceBuildup} — more likely sweep`
        : `Call OI ${inp.ceBuildup}`;
  }

  // VWAP — supplied: "a break on the wrong side of VWAP fails more often".
  let vwapNote = "UNAVAILABLE";
  if (inp.spot != null && inp.vwap != null) {
    const above = inp.spot > inp.vwap;
    const wrongSide =
      (inp.direction === "UP" && !above) || (inp.direction === "DOWN" && above);
    vwapNote = `${above ? "above" : "below"} VWAP${wrongSide ? " — break is on the wrong side of VWAP, fails more often" : ""}`;
  }

  // EMA21/50 on 5m — supplied: "price breaks range high AND EMA21 < EMA50 -> sweep-biased".
  let emaNote = "UNAVAILABLE";
  if (inp.ema21 != null && inp.ema50 != null) {
    const below = inp.ema21 < inp.ema50;
    emaNote = `EMA21 ${below ? "<" : ">="} EMA50 (5m)`;
    if (inp.direction === "UP" && below) emaNote += " — sweep-biased";
    if (inp.direction === "DOWN" && !below) emaNote += " — sweep-biased";
  }

  return { oiNote, vwapNote, emaNote, vixNote: VIX_NOTE };
}

/** OI state for the audit row, from the existing buildup strings. */
export function oiStateFrom(ceBuildup: string | null, peBuildup: string | null): OiState {
  if (!ceBuildup && !peBuildup) return "UNAVAILABLE";
  const ce = ceBuildup || "";
  if (/unwinding|short covering/i.test(ce)) return "CALL_OI_UNWINDING";
  if (/buildup/i.test(ce)) return "CALL_OI_ADDING";
  const pe = peBuildup || "";
  if (/unwinding|short covering/i.test(pe)) return "PUT_OI_UNWINDING";
  if (/buildup/i.test(pe)) return "PUT_OI_ADDING";
  return "MIXED";
}

export function vwapStateFrom(spot: number | null, vwap: number | null): VwapState {
  if (spot == null || vwap == null) return "UNAVAILABLE";
  if (spot > vwap) return "ABOVE_VWAP";
  if (spot < vwap) return "BELOW_VWAP";
  return "AT_VWAP";
}
