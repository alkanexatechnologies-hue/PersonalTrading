// ============================================================================
//  OI ANALYSIS MODULE — buildup + surge classifiers  (ADDITIVE, PURE)
// ----------------------------------------------------------------------------
//  Read-only helpers for the Market Command "OI Analysis" screen. Pure functions
//  (no I/O, no globals) so they are fully unit-testable and deterministic. They
//  change NO existing trading logic and place NO orders.
//
//  Standard option buildup matrix (per strike, per side), from the change in
//  open interest (ΔOI) and the change in that option's premium (ΔLTP):
//
//     ΔOI ↑  &  ΔLTP ↑   → LONG BUILDUP     (fresh buyers; that side strengthening)
//     ΔOI ↑  &  ΔLTP ↓   → SHORT BUILDUP    (fresh writers; that side capping)
//     ΔOI ↓  &  ΔLTP ↑   → SHORT COVERING   (writers exiting; squeeze)
//     ΔOI ↓  &  ΔLTP ↓   → LONG UNWINDING   (buyers exiting)
//
//  Colour convention for the whole module: CALL = red, PUT = green.
// ============================================================================

export type Buildup =
  | "Long Buildup"
  | "Short Buildup"
  | "Short Covering"
  | "Long Unwinding"
  | "Flat";

export type Side = "CALL" | "PUT";

export interface BuildupResult {
  buildup: Buildup;
  // Directional bias this buildup implies FOR THE UNDERLYING (not the option):
  //  - CALL short buildup (writers) = resistance = bearish for underlying
  //  - PUT  short buildup (writers) = support    = bullish for underlying
  //  - CALL long buildup            = bullish     (call buyers)
  //  - PUT  long buildup            = bearish     (put buyers)
  bias: "bullish" | "bearish" | "neutral";
  note: string;
}

// Minimum |ΔOI| relative to base OI to call anything other than Flat.
const FLAT_OI_FRAC = 0.02; // 2% of the strike's OI

export function classifyBuildup(
  side: Side,
  oiNow: number,
  oiChg: number,
  ltpChg: number
): BuildupResult {
  const base = Math.max(1, oiNow - oiChg); // OI at the start of the window
  const oiUp = oiChg > 0;
  const oiDn = oiChg < 0;
  const flatOi = Math.abs(oiChg) < base * FLAT_OI_FRAC;
  const ltpUp = ltpChg > 0;
  const ltpDn = ltpChg < 0;

  if (flatOi || (!ltpUp && !ltpDn)) {
    return { buildup: "Flat", bias: "neutral", note: "No decisive OI/price change." };
  }

  let buildup: Buildup;
  if (oiUp && ltpUp) buildup = "Long Buildup";
  else if (oiUp && ltpDn) buildup = "Short Buildup";
  else if (oiDn && ltpUp) buildup = "Short Covering";
  else if (oiDn && ltpDn) buildup = "Long Unwinding";
  else buildup = "Flat";

  return { buildup, bias: biasFor(side, buildup), note: noteFor(side, buildup) };
}

function biasFor(side: Side, b: Buildup): "bullish" | "bearish" | "neutral" {
  if (b === "Flat") return "neutral";
  if (side === "CALL") {
    // Call writers cap upside (bearish); call buyers push up (bullish).
    if (b === "Short Buildup") return "bearish";
    if (b === "Long Buildup") return "bullish";
    if (b === "Short Covering") return "bullish"; // writers forced out → upside
    return "bearish"; // long unwinding (call buyers exit)
  }
  // PUT
  if (b === "Short Buildup") return "bullish"; // put writers = support
  if (b === "Long Buildup") return "bearish"; // put buyers = downside bet
  if (b === "Short Covering") return "bearish"; // put writers exit → support gone
  return "bullish"; // long unwinding (put buyers exit)
}

function noteFor(side: Side, b: Buildup): string {
  const who = side === "CALL" ? "Call" : "Put";
  switch (b) {
    case "Long Buildup": return `${who} buyers adding — ${side === "CALL" ? "upside bet" : "downside bet"}.`;
    case "Short Buildup": return `${who} writers adding — ${side === "CALL" ? "resistance/cap" : "support floor"} building.`;
    case "Short Covering": return `${who} writers exiting — ${side === "CALL" ? "resistance lifting" : "support pulling out"}.`;
    case "Long Unwinding": return `${who} buyers exiting — conviction fading.`;
    default: return "No decisive flow.";
  }
}

// ---- Surge detection --------------------------------------------------------
// A "surge" is an unusually large intraday OI change on a strike/side over a
// short window, relative to that side's own recent OI. Threshold is a fraction
// of base OI per minute; deterministic and explainable (no hidden model).

export interface SurgeInput {
  side: Side;
  strike: number;
  oiNow: number;
  oiChg: number;       // Δ over the window
  windowMin: number;   // minutes covered by the window
  ltpChg: number;
}

export interface SurgeResult {
  surge: boolean;
  oiChgPct: number;     // ΔOI as % of base OI
  ratePctPerMin: number;
  severity: "none" | "notable" | "strong" | "extreme";
  buildup: Buildup;
  message: string;
}

const SURGE = { notable: 3, strong: 6, extreme: 12 }; // %/min of base OI

export function detectSurge(inp: SurgeInput): SurgeResult {
  const base = Math.max(1, inp.oiNow - inp.oiChg);
  const oiChgPct = +((inp.oiChg / base) * 100).toFixed(2);
  const minutes = Math.max(inp.windowMin, 0.5);
  const ratePctPerMin = +((Math.abs(inp.oiChg) / base / minutes) * 100).toFixed(2);
  const b = classifyBuildup(inp.side, inp.oiNow, inp.oiChg, inp.ltpChg).buildup;

  let severity: SurgeResult["severity"] = "none";
  if (ratePctPerMin >= SURGE.extreme) severity = "extreme";
  else if (ratePctPerMin >= SURGE.strong) severity = "strong";
  else if (ratePctPerMin >= SURGE.notable) severity = "notable";

  const surge = severity !== "none";
  const who = inp.side === "CALL" ? "Call" : "Put";
  const dir = inp.oiChg >= 0 ? "added" : "shed";
  const message = surge
    ? `${who} ${inp.strike} ${dir} ${Math.abs(oiChgPct).toFixed(1)}% OI (${ratePctPerMin.toFixed(1)}%/min) — ${b}.`
    : `${who} ${inp.strike} — no surge.`;

  return { surge, oiChgPct, ratePctPerMin, severity, buildup: b, message };
}
