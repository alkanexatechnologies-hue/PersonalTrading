// ---- Step 4: openingBias.ts ----
// Runs once at 9:15 (before the 09:15–09:45 OR window starts tracking).
// DIRECTIONAL-ONLY, and consumed only within the first 30 minutes post-open.
//
// Inputs:
//   gapPct       = (open − PDC) / ATR
//   wallDirection= nearest heavy OI wall above/below today's open (READ from
//                  Setup's existing OI-wall output — we do not recompute walls)
//   openVsPDHPDL = opened inside vs outside yesterday's PDH/PDL
//
// Hit-rate: we LOG each morning's predicted bias and later reconcile it against
// the actual OR breakout direction (logOpeningOutcome). Until a real backtest
// validates it, tradeScore applies openingBias at a REDUCED weight (see
// tradeScore.ts) — this module just produces the read and records the evidence.

import fs from "fs";
import path from "path";
import { OpeningBiasState, clamp } from "./types";

export interface OpeningBiasInputs {
  open: number;
  pdc: number | null;
  pdh: number | null;
  pdl: number | null;
  atr: number | null;
  wallSupport: number | null;    // Setup's OI-wall support (majorSupport)
  wallResistance: number | null; // Setup's OI-wall resistance (majorResistance)
}

export interface OpeningBiasResult {
  openingBias: OpeningBiasState;
  openingBiasConfidence: number; // 0..100
  note: string;
}

export function computeOpeningBias(inp: OpeningBiasInputs): OpeningBiasResult {
  let up = 0, down = 0;
  const notes: string[] = [];

  // 1) Gap vs volatility (ATR-normalised).
  if (inp.pdc != null && inp.atr != null && inp.atr > 0) {
    const gapPct = (inp.open - inp.pdc) / inp.atr;
    if (gapPct > 0.15) { up++; notes.push(`gap up ${gapPct.toFixed(2)}xATR`); }
    else if (gapPct < -0.15) { down++; notes.push(`gap down ${gapPct.toFixed(2)}xATR`); }
  }

  // 2) Wall direction: nearest heavy wall above/below the open. If the open sits
  //    closer to support (room UP to resistance), lean bullish; mirror for bearish.
  if (inp.wallSupport != null && inp.wallResistance != null) {
    const toSup = inp.open - inp.wallSupport;
    const toRes = inp.wallResistance - inp.open;
    if (toSup >= 0 && toRes >= 0) {
      if (toSup < toRes) { up++; notes.push("open near support wall (room up)"); }
      else if (toRes < toSup) { down++; notes.push("open near resistance wall (room down)"); }
    }
  }

  // 3) Open vs yesterday's PDH/PDL.
  if (inp.pdh != null && inp.open > inp.pdh) { up++; notes.push("opened above PDH"); }
  else if (inp.pdl != null && inp.open < inp.pdl) { down++; notes.push("opened below PDL"); }

  const votes = up + down;
  let openingBias: OpeningBiasState = "Neutral";
  if (up > down) openingBias = "Bullish";
  else if (down > up) openingBias = "Bearish";

  // Confidence scales with agreement across the (up to 3) inputs.
  const agreement = votes ? Math.abs(up - down) / votes : 0;
  const openingBiasConfidence = clamp(Math.round(agreement * 100), 0, 100);

  return { openingBias, openingBiasConfidence, note: notes.join(" · ") || "no opening signal" };
}

// ---- hit-rate logging (evidence for a later backtest) ----
const LOG_FILE = path.join(process.cwd(), "data", "opening-bias-log.json");

interface OpeningLogRow {
  date: string;
  symbol: string;
  openingBias: OpeningBiasState;
  confidence: number;
  open: number;
  orBreakout?: "up" | "down" | "none"; // filled in once the OR window resolves
  hit?: boolean;
}

function readLog(): OpeningLogRow[] {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8")); } catch { return []; }
}
function writeLog(rows: OpeningLogRow[]) {
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.writeFileSync(LOG_FILE, JSON.stringify(rows.slice(-500), null, 2), "utf-8"); } catch { /* best-effort */ }
}

/** Record the morning prediction (idempotent per date+symbol). */
export function logOpeningBias(date: string, symbol: string, res: OpeningBiasResult, open: number): void {
  const rows = readLog();
  if (rows.some((r) => r.date === date && r.symbol === symbol)) return;
  rows.push({ date, symbol, openingBias: res.openingBias, confidence: res.openingBiasConfidence, open });
  writeLog(rows);
}

/** Reconcile the prediction against the actual OR breakout direction. */
export function logOpeningOutcome(date: string, symbol: string, orBreakout: "up" | "down" | "none"): void {
  const rows = readLog();
  const row = rows.find((r) => r.date === date && r.symbol === symbol);
  if (!row || row.orBreakout != null) return;
  row.orBreakout = orBreakout;
  const pred = row.openingBias === "Bullish" ? "up" : row.openingBias === "Bearish" ? "down" : "none";
  row.hit = pred !== "none" && pred === orBreakout;
  writeLog(rows);
}

/** Current empirical hit-rate (0..1) and sample size — for trust weighting. */
export function openingBiasHitRate(): { hitRate: number; n: number } {
  const rows = readLog().filter((r) => r.hit != null);
  if (!rows.length) return { hitRate: 0, n: 0 };
  const hits = rows.filter((r) => r.hit).length;
  return { hitRate: hits / rows.length, n: rows.length };
}
