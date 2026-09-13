import {
  SuggestionRecord, LayerName, LayerState, Suggestion, WallContext,
  emptyWindows, dedupeKey,
} from "./suggestionLog";

// ============================ Suggestion builder ============================
// Turns what the engine ALREADY decided into an advisory display record. It is a
// pure translation layer:
//
//   * It does not score, gate, veto or threshold anything.
//   * It never overrides the engine. If the engine says WAIT, the suggestion is
//     a flavour of WAIT - never an entry.
//   * WAIT FOR PULLBACK is only ever emitted when the engine itself reports an
//     extension/pullback reason. The engine has no pullback gate today, so in
//     practice this value does not appear. It is not synthesised here, because a
//     display layer inventing a distinction the engine cannot make would be a
//     strategy change wearing a UI costume.

/** Shape of the parts of the OI payload this builder reads. Read-only. */
export interface PayloadLeg {
  take?: boolean;
  algoReady?: boolean;
  optionType?: "CE" | "PE" | "—";
  strike?: number | null;
  ltp?: number | null;
  stop?: number | null;
  target?: number | null;
  spotTarget?: number | null;
  spotStop?: number | null;
  confidence?: number | null;
  reasons?: string[];
  skipReasons?: string[];
}

export interface BuildInput {
  at: number;
  istDate: string;
  istTime: string;
  symbol: string;
  name: string;
  spot: number | null;
  expiry: string | null;
  /** ext.arbitration.verdict - the engine's real vocabulary. */
  masterVerdict: string | null;
  /** ext.arbitration.primary?.mode - which candidate won, when one did. */
  primaryMode: string | null;
  /** ext.arbitration.reason */
  masterReason: string | null;
  /** payload.recommendation.directional */
  directional: PayloadLeg | null;
  /** payload.recommendation.scalp */
  scalp: PayloadLeg | null;
  /** The Setup leg, when the payload exposes one. */
  setup: PayloadLeg | null;
  /** finalScore from the extension pipeline, preferred over leg confidence for Directional. */
  finalScore: number | null;
  support: number | null;
  resistance: number | null;
  /** Engine's expected-low move, the room requirement's first term. */
  expLow: number | null;
}

/**
 * Maps one leg onto a layer state. A leg that is take-able is a CANDIDATE, not a
 * trade - only the Master Selector promotes a candidate.
 */
export function layerStateFor(leg: PayloadLeg | null): LayerState {
  if (!leg) return "NO_EDGE";
  if (leg.take) return "CANDIDATE";
  const skips = leg.skipReasons || [];
  if (!skips.length) return "NO_EDGE";
  // A wall/room/AVOID style skip is an active block; everything else is a wait.
  const blocked = skips.some((s) =>
    /wall|room|AVOID|invalidated|stale|baseline/i.test(s));
  return blocked ? "BLOCK" : "WAIT";
}

/** Which wall matters for a direction, and how much room there is to it. */
export function wallContextFor(
  optionType: "CE" | "PE" | null,
  spot: number | null,
  support: number | null,
  resistance: number | null,
  expLow: number | null,
): WallContext {
  const requiredRoomPts = spot != null ? Math.max(expLow ?? 0, spot * 0.001) : null;
  if (optionType == null || spot == null) {
    return { support, resistance, roomPts: null, requiredRoomPts, wallSide: null };
  }
  const bullish = optionType === "CE";
  const wallSide = bullish ? "resistance" : "support";
  const wall = bullish ? resistance : support;
  // A null wall yields a null room - deliberately NOT zero and NOT "plenty".
  // Unknown must stay unknown here; the engine's own fallback is reported
  // separately by the audit rather than reproduced.
  const roomPts = wall == null ? null : bullish ? wall - spot : spot - wall;
  return { support, resistance, roomPts, requiredRoomPts, wallSide };
}

/**
 * Derives the advisory suggestion from the engine's verdict. GO becomes a BUY
 * only when a concrete option leg exists to buy; otherwise the decision is
 * surfaced as a WAIT flavour with the engine's own reasons attached.
 */
export function deriveSuggestion(i: BuildInput, chosen: PayloadLeg | null): Suggestion {
  const verdict = (i.masterVerdict || "").toUpperCase();

  if (verdict === "GO" && chosen && chosen.optionType && chosen.optionType !== "—") {
    return chosen.optionType === "CE" ? "BUY CE" : "BUY PE";
  }

  const allSkips = [
    ...(i.directional?.skipReasons || []),
    ...(i.scalp?.skipReasons || []),
  ].join(" ");

  // AVOID is reserved for an ACTIVE danger the engine named - a wall
  // invalidation or an explicit AVOID status - not for a generic absence.
  if (/AVOID|invalidated vs OI wall|too close/i.test(allSkips)) return "AVOID";

  // Extension/pullback: only if the engine said so. It has no such gate today.
  if (/pullback|extended/i.test(allSkips)) return "WAIT FOR PULLBACK";

  // CONFLICT is a real engine state: two opposing candidates, no honest winner.
  if (verdict === "CONFLICT") return "WAIT";

  // Nothing actionable and nothing dangerous named -> no edge.
  const anyCandidate = i.directional?.take || i.scalp?.take || i.setup?.take;
  return anyCandidate ? "WAIT" : "NO EDGE";
}

/** Human-readable path of the layer(s) behind the final decision. */
export function deriveSourcePath(i: BuildInput, layers: Record<LayerName, LayerState>): string {
  const verdict = (i.masterVerdict || "").toUpperCase();
  if (verdict !== "GO") {
    const candidates = (Object.keys(layers) as LayerName[]).filter((k) => layers[k] === "CANDIDATE");
    return candidates.length ? `${candidates.join(" + ")} → MASTER (held)` : "NONE";
  }
  // On a GO the winning mode is authoritative; agreeing candidates are shown too.
  const primary = (i.primaryMode || "").toUpperCase();
  const agreeing = (Object.keys(layers) as LayerName[]).filter(
    (k) => layers[k] === "CANDIDATE" && k !== primary);
  const head = primary || "MASTER";
  return agreeing.length ? `${head} + ${agreeing.join(" + ")}` : head;
}

/** Collects the engine's own reasons, preferring skip reasons on a non-GO. */
function collectReasons(i: BuildInput, chosen: PayloadLeg | null): string[] {
  const verdict = (i.masterVerdict || "").toUpperCase();
  if (verdict === "GO") {
    const r = [...(chosen?.reasons || [])];
    if (i.masterReason) r.unshift(i.masterReason);
    return r.slice(0, 6);
  }
  const out: string[] = [];
  if (i.masterReason) out.push(i.masterReason);
  for (const leg of [i.directional, i.scalp]) {
    for (const s of leg?.skipReasons || []) if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 8);
}

/**
 * Builds the record. `tradingSymbol` is resolved separately (it needs an async
 * instruments lookup) and attached by the caller.
 */
export function buildSuggestionRecord(i: BuildInput): SuggestionRecord {
  const layers: Record<LayerName, LayerState> = {
    SETUP: layerStateFor(i.setup),
    DIRECTIONAL: layerStateFor(i.directional),
    SCALP: layerStateFor(i.scalp),
  };

  const verdict = (i.masterVerdict || "").toUpperCase();
  const primary = (i.primaryMode || "").toUpperCase();
  // The leg the Master Selector actually promoted, when it promoted one.
  const chosen =
    verdict !== "GO" ? null
    : primary === "SCALP" ? i.scalp
    : primary === "DIRECTIONAL" ? i.directional
    : i.directional || i.scalp;

  const suggestion = deriveSuggestion(i, chosen);
  const optionType =
    chosen?.optionType && chosen.optionType !== "—" ? chosen.optionType
    : suggestion === "BUY CE" ? "CE"
    : suggestion === "BUY PE" ? "PE"
    : null;

  const confidence =
    primary === "DIRECTIONAL" && i.finalScore != null ? i.finalScore
    : chosen?.confidence ?? null;

  const rec: SuggestionRecord = {
    id: `${i.symbol}-${i.at}`,
    at: i.at,
    istDate: i.istDate,
    istTime: i.istTime,
    symbol: i.symbol,
    name: i.name,
    layers,
    sourcePath: deriveSourcePath(i, layers),
    masterVerdict: verdict || "WAIT",
    suggestion,
    optionType,
    strike: chosen?.strike ?? null,
    expiry: i.expiry,
    tradingSymbol: null,
    spotAtSignal: i.spot,
    entryPremium: chosen?.ltp ?? null,
    stopPremium: chosen?.stop ?? null,
    targetPremium: chosen?.target ?? null,
    spotTarget: chosen?.spotTarget ?? null,
    spotStop: chosen?.spotStop ?? null,
    confidence,
    reasons: collectReasons(i, chosen),
    wall: wallContextFor(optionType, i.spot, i.support, i.resistance, i.expLow),
    resolved: false,
    resolvedAt: null,
    windows: emptyWindows(),
    tradeOutcome: "UNRESOLVED",
    waitEval: "UNRESOLVED",
    wallOutcome: { wallHeld: null, breakoutConfirmed: null, falseBreakout: null },
    unresolvedReason: null,
  };
  return rec;
}

export { dedupeKey };
