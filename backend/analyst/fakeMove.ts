// ============================================================================
//  MULTI-TIMEFRAME FAKE MOVE ENGINE  —  ADDITIVE ANALYSIS LAYER (read-only)
// ----------------------------------------------------------------------------
//  This module is a SEPARATE, additive layer. It DOES NOT compute candles,
//  EMA, VWAP, support/resistance, OI, OI walls, liquidity, BOS, CHoCH, swing
//  points or market direction. It only INTERPRETS values that the existing
//  engines already produced and that the /api/market-command handler already
//  has in hand (candles, structure swing points, OI/S-R levels, per-timeframe
//  direction). It NEVER mutates its inputs and NEVER overrides the existing
//  market-direction / trade-plan (see mtf conflict handling in api.ts).
//
//  A "fake move" here is the classic break-and-reclaim of a level:
//   - FAKE-UP  : price pokes ABOVE a resistance/level then closes back below
//                (a failed breakout — usually bearish).
//   - FAKE-DOWN: price pokes BELOW a support/level then closes back above
//                (a failed breakdown — usually bullish).
//  It also distinguishes a genuine BREAKOUT_ACCEPTED and a post-breakout RETEST
//  so the UI can tell a real move from a trap.
// ============================================================================

export type FakeMoveDirection = "UP" | "DOWN" | "NONE";
export type FakeMoveStatus = "NONE" | "WATCH" | "CONFIRMED";
export type BreakoutState =
  | "NONE"
  | "BREAKOUT_ACCEPTED"
  | "FAILED_BREAKOUT"   // = confirmed fake-up
  | "BREAKDOWN_ACCEPTED"
  | "FAILED_BREAKDOWN"  // = confirmed fake-down
  | "RETEST";

export interface FakeMoveCandle {
  open: number; high: number; low: number; close: number; volume?: number; time?: number;
}

/** One level the fake-move engine can test against. All sourced from EXISTING
 *  calculations (OI walls, S/R, swing highs/lows) — never recomputed here. */
export interface FakeMoveLevel {
  price: number;
  /** Human label for the UI, e.g. "Call OI Wall", "Swing High", "Strong R". */
  label: string;
  side: "resistance" | "support";
}

export interface FakeMoveTFInput {
  tfLabel: string;                 // "5M" / "15M" / "1H"
  candles: FakeMoveCandle[];       // that timeframe's candles (already fetched)
  levels: FakeMoveLevel[];         // resistance/support levels (already computed)
  /** that timeframe's structural direction (already computed). */
  structure?: "BULLISH" | "BEARISH" | "RANGING" | "—" | null;
}

export interface FakeMove {
  timeframe: string;
  direction: FakeMoveDirection;    // UP = fake-up (failed breakout), DOWN = fake-down
  status: FakeMoveStatus;          // NONE / WATCH / CONFIRMED
  breakoutState: BreakoutState;
  level: number | null;            // the level being faked / broken
  levelLabel: string | null;
  crossedAt: number | null;        // candle time the level was first pierced
  reclaimedAt: number | null;      // candle time price closed back on the origin side
  reason: string;
  evidence: string[];
}

export interface HigherTimeframeContext {
  timeframe: string;
  direction: "BULLISH" | "BEARISH" | "RANGING" | "—";
  bias: "SUPPORTS_UP" | "SUPPORTS_DOWN" | "NEUTRAL";
  available: boolean;
  note: string;
}

export type ConfirmationState = "CONFIRMED_ALIGNED" | "WATCH" | "CONFLICT" | "NONE";

export interface MtfFakeMoveState {
  status:
    | "NONE"
    | "BREAKOUT_ACCEPTED"
    | "FAILED_BREAKOUT"
    | "FAILED_BREAKDOWN"
    | "EARLY_REJECTION"
    | "RETEST"
    | "CONFLICT";
  direction: FakeMoveDirection;
  confidence: number;              // 0..100 (evidence-based, not a probability)
  note: string;
}

/** Conflict between the EXISTING market direction and the new MTF read.
 *  Per the spec we NEVER overwrite the existing direction — we report both. */
export interface FakeMoveConflict {
  exists: boolean;
  existingDirection: string | null;   // marketView.direction (unchanged, source of truth)
  mtfImplied: "BULLISH" | "BEARISH" | "NEUTRAL";
  note: string;
}

/** Counter-trend candle visualization state. PRESENTATION ONLY — derived from
 *  the EXISTING structure direction + the last candle's colour. It NEVER changes
 *  the existing direction; a green candle in a bearish structure is flagged as a
 *  pullback candidate, not a reversal. */
export interface CounterTrendState {
  active: boolean;
  candleColor: "GREEN" | "RED" | "DOJI";
  /** the EXISTING 5M structure direction (source of truth, unchanged). */
  structureDirection: "BULLISH" | "BEARISH" | "RANGING" | "—";
  label: string;                    // "COUNTER-TREND PULLBACK" | "CONTINUATION" | "—"
  status: "FAKE WATCH" | "REVERSAL WATCH" | "NONE";
  note: string;
}

/** Packages the EXISTING per-timeframe directions for the MTF Direction panel.
 *  m5 carries an optional annotation (e.g. COUNTER-TREND PULLBACK) WITHOUT
 *  altering the direction itself. */
export interface MtfDirectionView {
  m5: { direction: "BULLISH" | "BEARISH" | "RANGING" | "—"; annotation: string | null };
  m15: { direction: "BULLISH" | "BEARISH" | "RANGING" | "—" };
  h1: { direction: "BULLISH" | "BEARISH" | "RANGING" | "—"; available: boolean };
}

/** Human-readable "confirmation & next scenario" text for the panel. */
export interface FakeScenario {
  status: string;
  confirmationNeeded: string;
  reversalWatchNote: string;
}

export interface FakeMoveResult {
  version: string;
  available: boolean;              // false when inputs are missing/insufficient
  dataStale: boolean;
  fakeMove5m: FakeMove;
  fakeMove15m: FakeMove;
  higherTimeframeContext: HigherTimeframeContext;
  confirmationState: ConfirmationState;
  mtfFakeMoveState: MtfFakeMoveState;
  conflict: FakeMoveConflict;
  // ADDITIVE presentation states (never override existing logic):
  counterTrend: CounterTrendState;
  mtfDirection: MtfDirectionView;
  scenario: FakeScenario;
}

export const FAKE_MOVE_VERSION = "fakeMove/v1";

// How many recent bars to inspect for a break/reclaim sequence.
const LOOKBACK_BARS = 4;
// A close is "beyond" a level only past this fraction of price (filters noise).
const LEVEL_EPS_FRAC = 0.0004; // ~0.04%

const emptyFakeMove = (tf: string, reason: string): FakeMove => ({
  timeframe: tf, direction: "NONE", status: "NONE", breakoutState: "NONE",
  level: null, levelLabel: null, crossedAt: null, reclaimedAt: null, reason, evidence: [],
});

/** Pick the single most-relevant level the recent bars actually interacted with.
 *  Preference: the nearest level (by price) whose price sits within the recent
 *  bars' high/low envelope — i.e. one price is actually testing. */
function pickInteractingLevel(
  bars: FakeMoveCandle[],
  levels: FakeMoveLevel[],
  side: "resistance" | "support",
): FakeMoveLevel | null {
  if (!bars.length || !levels.length) return null;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const last = bars[bars.length - 1].close;
  const candidates = levels
    .filter((l) => l.side === side && Number.isFinite(l.price))
    // the window must have actually reached the level
    .filter((l) => (side === "resistance" ? hi >= l.price && l.price >= lo * 0.99 : lo <= l.price && l.price <= hi * 1.01));
  if (!candidates.length) return null;
  // nearest to the last close
  candidates.sort((a, b) => Math.abs(a.price - last) - Math.abs(b.price - last));
  return candidates[0];
}

/** Core per-timeframe detection. Pure; consumes candles + pre-computed levels. */
export function detectFakeMoveTF(input: FakeMoveTFInput): FakeMove {
  const { tfLabel, candles, levels } = input;
  if (!candles || candles.length < 3) return emptyFakeMove(tfLabel, "Not enough candles");
  if (!levels || !levels.length) return emptyFakeMove(tfLabel, "No reference levels");

  const bars = candles.slice(-LOOKBACK_BARS);
  const last = bars[bars.length - 1];

  // ---- Resistance side → fake-UP / breakout-up ----
  const resL = pickInteractingLevel(bars, levels, "resistance");
  const supL = pickInteractingLevel(bars, levels, "support");

  // Decide which side is more relevant: whichever level the last bar is closest to.
  const resDist = resL ? Math.abs(last.close - resL.price) : Infinity;
  const supDist = supL ? Math.abs(last.close - supL.price) : Infinity;

  const evalResistance = (lvl: FakeMoveLevel): FakeMove => {
    const eps = lvl.price * LEVEL_EPS_FRAC;
    const pierced = bars.filter((b) => b.high > lvl.price + eps);
    const crossedAt = pierced.length ? pierced[0].time ?? null : null;
    const closedAboveBars = bars.filter((b) => b.close > lvl.price + eps);
    const lastCloseAbove = last.close > lvl.price + eps;
    const prev = bars[bars.length - 2];
    const prevCloseAbove = prev ? prev.close > lvl.price + eps : false;

    // Genuine breakout: two consecutive closes above.
    if (lastCloseAbove && prevCloseAbove) {
      // Retest? last bar dipped back near the level then held above.
      const dippedToLevel = last.low <= lvl.price + eps && last.close > lvl.price;
      return {
        timeframe: tfLabel, direction: "NONE",
        status: dippedToLevel ? "WATCH" : "NONE",
        breakoutState: dippedToLevel ? "RETEST" : "BREAKOUT_ACCEPTED",
        level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: null,
        reason: dippedToLevel
          ? `Broke above ${lvl.label} (${lvl.price}) and is retesting it from above — breakout holding.`
          : `Accepted breakout above ${lvl.label} (${lvl.price}) — two closes above.`,
        evidence: [`2 closes above ${lvl.price}`, dippedToLevel ? "retest from above" : "no reclaim below"],
      };
    }

    if (crossedAt != null) {
      // High pierced the level. Did it CLOSE back below after any close above → confirmed fake-up.
      const hadCloseAbove = closedAboveBars.length > 0;
      if (!lastCloseAbove && hadCloseAbove) {
        return {
          timeframe: tfLabel, direction: "UP", status: "CONFIRMED", breakoutState: "FAILED_BREAKOUT",
          level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: last.time ?? null,
          reason: `Fake-up CONFIRMED: closed above ${lvl.label} (${lvl.price}) then reclaimed below — failed breakout.`,
          evidence: [`close pierced ${lvl.price}`, "reclaimed back below", "failed breakout"],
        };
      }
      if (!lastCloseAbove && !hadCloseAbove) {
        // Only wicks above, never closed above, now below → watch for fake-up.
        return {
          timeframe: tfLabel, direction: "UP", status: "WATCH", breakoutState: "NONE",
          level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: null,
          reason: `Wick above ${lvl.label} (${lvl.price}) rejected — watching for a fake-up (needs a close back below to confirm).`,
          evidence: [`wick above ${lvl.price}`, "no close above yet"],
        };
      }
      // Closed above on the last bar but not yet 2 consecutive → breakout forming.
      return {
        timeframe: tfLabel, direction: "NONE", status: "WATCH", breakoutState: "NONE",
        level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: null,
        reason: `Breakout forming above ${lvl.label} (${lvl.price}) — needs a second close above to accept, or a close back below = fake-up.`,
        evidence: [`1 close above ${lvl.price}`, "unconfirmed"],
      };
    }
    return emptyFakeMove(tfLabel, `Near ${lvl.label} (${lvl.price}) — no break yet.`);
  };

  const evalSupport = (lvl: FakeMoveLevel): FakeMove => {
    const eps = lvl.price * LEVEL_EPS_FRAC;
    const pierced = bars.filter((b) => b.low < lvl.price - eps);
    const crossedAt = pierced.length ? pierced[0].time ?? null : null;
    const closedBelowBars = bars.filter((b) => b.close < lvl.price - eps);
    const lastCloseBelow = last.close < lvl.price - eps;
    const prev = bars[bars.length - 2];
    const prevCloseBelow = prev ? prev.close < lvl.price - eps : false;

    if (lastCloseBelow && prevCloseBelow) {
      const poppedToLevel = last.high >= lvl.price - eps && last.close < lvl.price;
      return {
        timeframe: tfLabel, direction: "NONE",
        status: poppedToLevel ? "WATCH" : "NONE",
        breakoutState: poppedToLevel ? "RETEST" : "BREAKDOWN_ACCEPTED",
        level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: null,
        reason: poppedToLevel
          ? `Broke below ${lvl.label} (${lvl.price}) and is retesting from below — breakdown holding.`
          : `Accepted breakdown below ${lvl.label} (${lvl.price}) — two closes below.`,
        evidence: [`2 closes below ${lvl.price}`, poppedToLevel ? "retest from below" : "no reclaim above"],
      };
    }

    if (crossedAt != null) {
      const hadCloseBelow = closedBelowBars.length > 0;
      if (!lastCloseBelow && hadCloseBelow) {
        return {
          timeframe: tfLabel, direction: "DOWN", status: "CONFIRMED", breakoutState: "FAILED_BREAKDOWN",
          level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: last.time ?? null,
          reason: `Fake-down CONFIRMED: closed below ${lvl.label} (${lvl.price}) then reclaimed above — failed breakdown.`,
          evidence: [`close pierced ${lvl.price}`, "reclaimed back above", "failed breakdown"],
        };
      }
      if (!lastCloseBelow && !hadCloseBelow) {
        return {
          timeframe: tfLabel, direction: "DOWN", status: "WATCH", breakoutState: "NONE",
          level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: null,
          reason: `Wick below ${lvl.label} (${lvl.price}) rejected — watching for a fake-down (needs a close back above to confirm).`,
          evidence: [`wick below ${lvl.price}`, "no close below yet"],
        };
      }
      return {
        timeframe: tfLabel, direction: "NONE", status: "WATCH", breakoutState: "NONE",
        level: lvl.price, levelLabel: lvl.label, crossedAt, reclaimedAt: null,
        reason: `Breakdown forming below ${lvl.label} (${lvl.price}) — needs a second close below to accept, or a close back above = fake-down.`,
        evidence: [`1 close below ${lvl.price}`, "unconfirmed"],
      };
    }
    return emptyFakeMove(tfLabel, `Near ${lvl.label} (${lvl.price}) — no break yet.`);
  };

  // Evaluate the more relevant side; if it yields nothing, try the other.
  let primary: FakeMove | null = null;
  if (resL && resDist <= supDist) primary = evalResistance(resL);
  else if (supL) primary = evalSupport(supL);
  if ((!primary || primary.status === "NONE") && resL && resDist > supDist) {
    const r = evalResistance(resL);
    if (r.status !== "NONE") primary = r;
  }
  if ((!primary || primary.status === "NONE") && supL && supDist > resDist) {
    const s = evalSupport(supL);
    if (s.status !== "NONE") primary = s;
  }
  return primary ?? emptyFakeMove(tfLabel, "No level interaction in recent bars.");
}

function biasFromStructure(dir?: string | null): "SUPPORTS_UP" | "SUPPORTS_DOWN" | "NEUTRAL" {
  if (dir === "BULLISH" || dir === "Bullish") return "SUPPORTS_UP";
  if (dir === "BEARISH" || dir === "Bearish") return "SUPPORTS_DOWN";
  return "NEUTRAL";
}

function normStructure(dir?: string | null): "BULLISH" | "BEARISH" | "RANGING" | "—" {
  if (dir === "BULLISH" || dir === "Bullish") return "BULLISH";
  if (dir === "BEARISH" || dir === "Bearish") return "BEARISH";
  if (dir === "RANGING" || dir === "Ranging") return "RANGING";
  return "—";
}

/** A confirmed fake-up implies bearish; fake-down implies bullish. */
function fakeImpliedDirection(fm5: FakeMove, fm15: FakeMove): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const score = (fm: FakeMove, w: number) => {
    if (fm.status === "NONE" || fm.direction === "NONE") return 0;
    const s = fm.status === "CONFIRMED" ? w : w * 0.5;
    return fm.direction === "UP" ? -s : s; // UP fake = bearish (negative), DOWN fake = bullish
  };
  const total = score(fm5, 1) + score(fm15, 1.5);
  if (total > 0.6) return "BULLISH";
  if (total < -0.6) return "BEARISH";
  return "NEUTRAL";
}

export interface BuildFakeMoveArgs {
  tf5: FakeMoveTFInput | null;
  tf15: FakeMoveTFInput | null;
  higher: { timeframe: string; structure?: string | null; available: boolean };
  existingDirection: string | null; // marketView.direction (source of truth, untouched)
  dataStale: boolean;
}

/** Assemble the full multi-timeframe fake-move result from per-TF inputs. */
export function buildFakeMoveResult(args: BuildFakeMoveArgs): FakeMoveResult {
  const { tf5, tf15, higher, existingDirection, dataStale } = args;

  const fakeMove5m = tf5 ? detectFakeMoveTF(tf5) : emptyFakeMove("5M", "5M data unavailable");
  const fakeMove15m = tf15 ? detectFakeMoveTF(tf15) : emptyFakeMove("15M", "15M data unavailable");
  const available = !!(tf5 || tf15);

  // Higher-timeframe context (e.g. 1H, or 15M relative to a 5M chart).
  const htfDir = normStructure(higher.structure);
  const higherTimeframeContext: HigherTimeframeContext = {
    timeframe: higher.timeframe,
    direction: htfDir,
    bias: biasFromStructure(higher.structure),
    available: higher.available,
    note: !higher.available
      ? `${higher.timeframe} context unavailable`
      : `${higher.timeframe} structure is ${htfDir}`,
  };

  // Confirmation state across 5M & 15M.
  let confirmationState: ConfirmationState = "NONE";
  const d5 = fakeMove5m.direction, d15 = fakeMove15m.direction;
  const active5 = d5 !== "NONE" && fakeMove5m.status !== "NONE";
  const active15 = d15 !== "NONE" && fakeMove15m.status !== "NONE";
  if (active5 && active15) {
    if (d5 === d15) {
      confirmationState = (fakeMove5m.status === "CONFIRMED" && fakeMove15m.status === "CONFIRMED")
        ? "CONFIRMED_ALIGNED" : "WATCH";
    } else {
      confirmationState = "CONFLICT";
    }
  } else if (active5 || active15) {
    confirmationState = "WATCH";
  }

  // Headline MTF state.
  const anyConfirmed = fakeMove5m.status === "CONFIRMED" || fakeMove15m.status === "CONFIRMED";
  const anyRetest = fakeMove5m.breakoutState === "RETEST" || fakeMove15m.breakoutState === "RETEST";
  const anyAccepted = fakeMove5m.breakoutState === "BREAKOUT_ACCEPTED" || fakeMove15m.breakoutState === "BREAKOUT_ACCEPTED"
    || fakeMove5m.breakoutState === "BREAKDOWN_ACCEPTED" || fakeMove15m.breakoutState === "BREAKDOWN_ACCEPTED";
  const impliedDir = fakeImpliedDirection(fakeMove5m, fakeMove15m);
  let mtfStatus: MtfFakeMoveState["status"] = "NONE";
  let mtfNote = "No multi-timeframe fake move detected.";
  let mtfDir: FakeMoveDirection = "NONE";
  if (confirmationState === "CONFLICT") {
    mtfStatus = "CONFLICT";
    mtfNote = `5M ${d5} vs 15M ${d15} — timeframes disagree; wait for confirmation.`;
  } else if (anyConfirmed) {
    // A confirmed fake on the higher (15M) drives the headline; else 5M.
    const lead = fakeMove15m.status === "CONFIRMED" ? fakeMove15m : fakeMove5m;
    mtfDir = lead.direction;
    mtfStatus = lead.direction === "UP" ? "FAILED_BREAKOUT" : "FAILED_BREAKDOWN";
    // A 5M confirm while 15M only watches = early rejection developing.
    if (fakeMove5m.status === "CONFIRMED" && fakeMove15m.status !== "CONFIRMED") { mtfStatus = "EARLY_REJECTION"; }
    mtfNote = lead.reason;
  } else if (anyRetest) {
    mtfStatus = "RETEST";
    mtfNote = (fakeMove15m.breakoutState === "RETEST" ? fakeMove15m : fakeMove5m).reason;
  } else if (anyAccepted) {
    mtfStatus = "BREAKOUT_ACCEPTED";
    mtfNote = (fakeMove15m.breakoutState !== "NONE" ? fakeMove15m : fakeMove5m).reason;
  } else if (active5 || active15) {
    mtfStatus = "EARLY_REJECTION";
    mtfDir = active15 ? d15 : d5;
    mtfNote = (active15 ? fakeMove15m : fakeMove5m).reason;
  }

  // Confidence: evidence-weighted, capped.
  let confidence = 0;
  if (fakeMove5m.status === "CONFIRMED") confidence += 35; else if (fakeMove5m.status === "WATCH") confidence += 15;
  if (fakeMove15m.status === "CONFIRMED") confidence += 45; else if (fakeMove15m.status === "WATCH") confidence += 20;
  if (confirmationState === "CONFIRMED_ALIGNED") confidence += 20;
  if (confirmationState === "CONFLICT") confidence = Math.min(confidence, 25);
  confidence = Math.max(0, Math.min(100, confidence));

  const mtfFakeMoveState: MtfFakeMoveState = { status: mtfStatus, direction: mtfDir, confidence, note: mtfNote };

  // Conflict vs the EXISTING direction — reported, NEVER overriding it.
  const existNorm = (existingDirection || "").toUpperCase();
  const conflictExists = (existNorm === "BULLISH" || existNorm === "BEARISH")
    && (impliedDir === "BULLISH" || impliedDir === "BEARISH")
    && existNorm !== impliedDir;
  const conflict: FakeMoveConflict = {
    exists: conflictExists,
    existingDirection: existingDirection ?? null,
    mtfImplied: impliedDir,
    note: conflictExists
      ? `Existing direction is ${existNorm} but the MTF fake-move read implies ${impliedDir}. Existing direction is unchanged; treat as WAIT / needs confirmation.`
      : "No conflict with the existing direction.",
  };

  // ---- Counter-trend candle (PRESENTATION ONLY) --------------------------
  // Uses the EXISTING 5M structure direction + the last 5M candle's colour.
  // A green candle in a bearish structure (or red in a bullish structure) is a
  // COUNTER-TREND PULLBACK candidate — flagged for the chart, NEVER flipping the
  // existing direction. Reversal is only "WATCH" (never a confirmed signal).
  const dir5 = normStructure(tf5?.structure);
  const c5 = tf5 && tf5.candles.length ? tf5.candles[tf5.candles.length - 1] : null;
  const candleColor: CounterTrendState["candleColor"] = !c5
    ? "DOJI" : c5.close > c5.open ? "GREEN" : c5.close < c5.open ? "RED" : "DOJI";
  const ctActive = (dir5 === "BEARISH" && candleColor === "GREEN") || (dir5 === "BULLISH" && candleColor === "RED");
  let ctStatus: CounterTrendState["status"] = "NONE";
  let ctLabel = dir5 === "—" ? "—" : "CONTINUATION";
  let ctNote = "Candle aligns with the existing structure — continuation.";
  if (ctActive) {
    ctLabel = "COUNTER-TREND PULLBACK";
    // A breakout ACCEPTED against the existing structure escalates to REVERSAL WATCH
    // (still not a confirmed signal); otherwise it's a FAKE WATCH pullback.
    const acceptedAgainst =
      (dir5 === "BEARISH" && fakeMove5m.breakoutState === "BREAKOUT_ACCEPTED") ||
      (dir5 === "BULLISH" && fakeMove5m.breakoutState === "BREAKDOWN_ACCEPTED");
    ctStatus = acceptedAgainst ? "REVERSAL WATCH" : "FAKE WATCH";
    const structWord = dir5 === "BEARISH" ? "bearish" : "bullish";
    const colourWord = dir5 === "BEARISH" ? "green" : "red";
    ctNote = `Market structure remains ${structWord}; ${colourWord} candle is a pullback candidate, not a reversal.`;
  }
  const counterTrend: CounterTrendState = {
    active: ctActive, candleColor, structureDirection: dir5, label: ctLabel, status: ctStatus, note: ctNote,
  };

  // ---- MTF Direction view (repackages EXISTING directions, adds annotation) --
  const mtfDirection: MtfDirectionView = {
    m5: { direction: dir5, annotation: ctActive ? "COUNTER-TREND PULLBACK" : null },
    m15: { direction: normStructure(tf15?.structure) },
    h1: { direction: htfDir, available: higher.available },
  };

  // ---- Confirmation & next scenario (presentation text) ------------------
  let scenarioStatus = "No active fake-move / counter-trend";
  let confirmationNeeded = "Watching for a level interaction.";
  if (ctActive) {
    scenarioStatus = ctStatus === "REVERSAL WATCH" ? "Reversal watch (counter-trend)" : "Counter-trend pullback";
    confirmationNeeded = dir5 === "BEARISH"
      ? "Next candle fails to break/hold resistance, or breaks the pullback low → continuation (bearish)."
      : "Next candle fails to break/hold support, or breaks the pullback high → continuation (bullish).";
  } else if (mtfFakeMoveState.status === "FAILED_BREAKOUT") {
    scenarioStatus = "Bearish fake-up (failed breakout)";
    confirmationNeeded = "Continuation lower unless price reclaims and holds above the level.";
  } else if (mtfFakeMoveState.status === "FAILED_BREAKDOWN") {
    scenarioStatus = "Bullish fake-down (failed breakdown)";
    confirmationNeeded = "Continuation higher unless price loses and holds below the level.";
  } else if (mtfFakeMoveState.status === "BREAKOUT_ACCEPTED") {
    scenarioStatus = "Breakout accepted";
    confirmationNeeded = "Holding beyond the level; watch for a retest.";
  } else if (mtfFakeMoveState.status === "RETEST") {
    scenarioStatus = "Retest in progress";
    confirmationNeeded = "Level retest — holding confirms, losing it invalidates.";
  } else if (confirmationState === "CONFLICT") {
    scenarioStatus = "Timeframe conflict";
    confirmationNeeded = "5M and 15M disagree — wait for alignment.";
  }
  const reversalWatchNote = dir5 === "BEARISH"
    ? "If price breaks and HOLDS above resistance → REVERSAL WATCH (not a confirmed bullish signal)."
    : dir5 === "BULLISH"
    ? "If price breaks and HOLDS below support → REVERSAL WATCH (not a confirmed bearish signal)."
    : "Reversal requires a confirmed break-and-hold against the existing structure.";
  const scenario: FakeScenario = { status: scenarioStatus, confirmationNeeded, reversalWatchNote };

  return {
    version: FAKE_MOVE_VERSION,
    available,
    dataStale,
    fakeMove5m, fakeMove15m,
    higherTimeframeContext,
    confirmationState,
    mtfFakeMoveState,
    conflict,
    counterTrend,
    mtfDirection,
    scenario,
  };
}
