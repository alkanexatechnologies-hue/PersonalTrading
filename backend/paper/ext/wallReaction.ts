// ---- Step 6: wallReaction.ts ----
// Fires when price reaches a wall that SETUP has already identified. We READ
// Setup's wall output (majorSupport/majorResistance) — we never recompute wall
// selection here.
//
// Signed lean where +ve => BREAK, -ve => REJECT:
//   Primary    : OI velocity at the touched strike (rising OI = defended => REJECT;
//                falling OI = eroding => BREAK).
//   Secondary  : burst state at contact (Quiet/Squeeze => REJECT; Fired/Expanding => BREAK).
//   Tertiary   : approach-candle volume/speed (fast/heavy => BREAK).
//   Tiebreaker : touch count this session (first test favours a hold => REJECT).
//
// Then biased by regime (Step 1) and liquidity (Step 2):
//   Trending                          -> bias BREAK
//   Compressed                        -> bias REJECT
//   Transitioning + prior squeeze     -> strongest BREAK read
//   Transitioning + fire, no squeeze  -> bias REJECT (likely stop-run)
//   Thin liquidity                    -> WIDEN the UNCLEAR band; this input alone
//                                        never flips REJECT<->BREAK.
//
// On BREAK, the caller (trade-construction step consuming Setup's output — NOT
// entryRules.ts) relaxes the target-anchored-to-wall cap for that trade only.

import { BurstState } from "../../types";
import { MarketRegime, LiquidityState, WallReactionState, clamp } from "./types";

export interface WallReactionInputs {
  oiVelocity?: number;     // recent OI change at the touched strike (+rising / -falling)
  burstState: BurstState;
  approachVolume?: number; // relative approach volume/speed (1 = average)
  touchCount: number;      // tests of this wall this session
  regime: MarketRegime;
  liquidity: LiquidityState;
  priorSqueeze: boolean;   // was there a squeeze just before a Transitioning fire
}

export interface WallReactionResult {
  wallReactionState: WallReactionState;
  lean: number; // signed, for diagnostics
  note: string;
}

// Base classification band; widened when liquidity is Thin.
const BAND = 0.18;
const THIN_BAND_EXTRA = 0.22;

export function computeWallReaction(inp: WallReactionInputs): WallReactionResult {
  const notes: string[] = [];
  let lean = 0;

  // Primary: OI velocity (weight 0.4). Rising OI = wall being defended => REJECT.
  if (inp.oiVelocity != null && Math.abs(inp.oiVelocity) > 1e-9) {
    const v = clamp(-Math.sign(inp.oiVelocity) * Math.min(1, Math.abs(inp.oiVelocity) / 1), -1, 1);
    lean += 0.4 * v;
    notes.push(`OIΔ ${inp.oiVelocity > 0 ? "rising(defended)" : "falling(eroding)"}`);
  }

  // Secondary: burst state (weight 0.25).
  let burstLean = 0;
  if (inp.burstState === "Fired Up" || inp.burstState === "Fired Down" || inp.burstState === "Expanding Up" || inp.burstState === "Expanding Down") burstLean = 1;
  else if (inp.burstState === "Quiet" || inp.burstState === "Squeeze") burstLean = -1;
  lean += 0.25 * burstLean;
  if (burstLean) notes.push(`burst ${inp.burstState}`);

  // Tertiary: approach volume/speed (weight 0.2). Heavy/fast approach => BREAK.
  if (inp.approachVolume != null) {
    const v = clamp(inp.approachVolume - 1, -1, 1); // 1 = average => neutral
    lean += 0.2 * v;
    notes.push(`approachVol ${inp.approachVolume.toFixed(2)}x`);
  }

  // Tiebreaker: touch count (weight 0.15). First test favours a hold (REJECT).
  const touchLean = inp.touchCount <= 1 ? -1 : clamp((inp.touchCount - 2) / 3, 0, 1);
  lean += 0.15 * touchLean;
  notes.push(`touch#${inp.touchCount}`);

  // Regime / transition bias.
  let regimeBias = 0;
  if (inp.regime === "Trending") { regimeBias = 0.2; notes.push("regime Trending->BREAK"); }
  else if (inp.regime === "Compressed") { regimeBias = -0.2; notes.push("regime Compressed->REJECT"); }
  else if (inp.regime === "Transitioning") {
    if (inp.priorSqueeze) { regimeBias = 0.3; notes.push("transition+squeeze->strong BREAK"); }
    else { regimeBias = -0.2; notes.push("transition+fire(no squeeze)->REJECT(stop-run)"); }
  }
  lean += regimeBias;

  // Liquidity: widen the UNCLEAR band; never a direct flip.
  const band = inp.liquidity === "Thin" ? BAND + THIN_BAND_EXTRA : BAND;
  if (inp.liquidity === "Thin") notes.push("thin->wider UNCLEAR band");

  lean = clamp(lean, -1, 1);
  let wallReactionState: WallReactionState;
  if (lean > band) wallReactionState = "BREAK";
  else if (lean < -band) wallReactionState = "REJECT";
  else wallReactionState = "UNCLEAR";

  return { wallReactionState, lean: Math.round(lean * 100) / 100, note: notes.join(" · ") };
}
