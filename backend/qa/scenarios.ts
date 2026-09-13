import { ArbiterCandidate, ArbiterVerdict } from "../paper/ext/tradeArbiter";
import { TradeScoreInputs } from "../paper/ext/tradeScore";
import { Candle } from "../types";

// ============================ Master Strategy QA scenarios ============================
// Declarative test cases for the Master Strategy Lab. Each scenario states its
// INPUTS and the EXPECTED engine decision; the runner feeds the inputs through
// the REAL, unmodified engine and compares.
//
// The expected values here encode the strategy as it is DOCUMENTED to behave
// (config/arbitration.ts thresholds + tradeArbiter.ts/tradeScore.ts rules).
// They are not copied from engine output - otherwise a regression would rewrite
// its own expectation and every test would always pass.
//
// DECISION VOCABULARY: the engine's Master Trade Selector (arbitrate()) returns
// GO / WAIT / CONFLICT. Those are the only verdicts it can produce, so they are
// what scenarios assert. See docs note in the Lab UI about the richer
// TAKE/WAIT_FOR_PULLBACK/NO_EDGE/AVOID vocabulary, which this engine does not
// implement today.

export type ScenarioCategory =
  | "BULLISH" | "BEARISH" | "CONFLICT" | "RANGE" | "PULLBACK" | "BREAKOUT"
  | "FALSE_BREAKOUT" | "OI_WALL" | "CANDLE_15M_5M" | "RISK" | "TIME_VETO"
  | "POSITION" | "COOLDOWN" | "EXPIRY" | "EDGE_CASE";

/** Which engine surface a scenario exercises. */
export type ScenarioKind = "ARBITER" | "SCORE" | "CANDLE" | "FALSE_SETUP";

export interface CandleFacts {
  tf15Trend?: "Bullish" | "Bearish" | "Neutral";
  tf5Trend?: "Bullish" | "Bearish" | "Neutral";
  breakout?: boolean;
  breakdown?: boolean;
  closeConfirmed?: boolean;
  volume?: "HIGH" | "NORMAL" | "LOW";
  upperWickPct?: number;
  lowerWickPct?: number;
  candleComplete?: boolean;
}

export interface ScenarioInputs {
  /** ARBITER scenarios: the candidate set handed to arbitrate(). */
  candidates?: ArbiterCandidate[];
  /** SCORE scenarios: the inputs handed to computeTradeScore(). */
  score?: TradeScoreInputs;
  /** CANDLE / FALSE_SETUP scenarios: closes for the real EMA confluence helpers. */
  closes5m?: number[];
  closes15m?: number[];
  price?: number;
  candles?: Candle[];
  facts?: CandleFacts;
  /** Context shown in the detail panel (never consumed by the engine). */
  context?: Record<string, string | number | boolean | null>;
}

export interface Scenario {
  id: string;
  category: ScenarioCategory;
  kind: ScenarioKind;
  title: string;
  /** Why this case matters - shown in the detail panel. */
  rationale: string;
  inputs: ScenarioInputs;
  /** ARBITER: expected verdict. SCORE: expected vetoed/gate outcome. CANDLE: expected direction. */
  expected: {
    verdict?: ArbiterVerdict;
    direction?: "Bullish" | "Bearish" | "Neutral";
    vetoed?: boolean;
    baseTriggerPassed?: boolean;
    /** Expected finalScore bounds, when the rule is about clamping. */
    finalScoreMin?: number;
    finalScoreMax?: number;
    rrFloorOverride?: number | null;
    /** For false-setup cases: should the engine treat this as tradeable? */
    tradeable?: boolean;
  };
}

// ---- helpers for building candidates/series (test fixtures, not engine code) ----
const cand = (o: Partial<ArbiterCandidate> & { mode: ArbiterCandidate["mode"]; direction: ArbiterCandidate["direction"] }): ArbiterCandidate => ({
  finalScore: 56, setupQuality: 60, eligible: true, vetoed: false, suppressed: false, ...o,
});

const rising = (n: number, from = 100, step = 1) => Array.from({ length: n }, (_, i) => from + i * step);
const falling = (n: number, from = 200, step = 1) => Array.from({ length: n }, (_, i) => from - i * step);
const flat = (n: number, at = 100) => Array.from({ length: n }, () => at);

const baseScore = (o: Partial<TradeScoreInputs> = {}): TradeScoreInputs => ({
  baseTrigger: true, baseConfidence: 56, direction: "Bullish",
  premiumState: "Neutral", regime: "Trending", wallReaction: "BREAK",
  sentimentState: "Neutral", liquidityState: "Normal", ...o,
});

export const SCENARIOS: Scenario[] = [
  // ======================= Arbiter: single candidate =======================
  {
    id: "TC-001", category: "BULLISH", kind: "ARBITER",
    title: "Single eligible bullish Directional candidate",
    rationale: "One actionable candidate and nothing competing must resolve to GO, not WAIT.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bullish", finalScore: 60, setupQuality: 70 })] },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-002", category: "BEARISH", kind: "ARBITER",
    title: "Single eligible bearish Directional candidate",
    rationale: "Direction must not bias actionability - a lone bearish setup is equally a GO.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bearish", finalScore: 59, setupQuality: 65 })] },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-003", category: "EDGE_CASE", kind: "ARBITER",
    title: "No candidates at all",
    rationale: "An empty candidate set must WAIT - never fabricate a trade from nothing.",
    inputs: { candidates: [] },
    expected: { verdict: "WAIT" },
  },
  {
    id: "TC-004", category: "EDGE_CASE", kind: "ARBITER",
    title: "Candidate present but not eligible (trigger unmet)",
    rationale: "eligible=false means its own trigger/gate never fired; it cannot become a trade.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bullish", eligible: false })] },
    expected: { verdict: "WAIT" },
  },

  // ======================= Arbiter: vetoes and suppression =======================
  {
    id: "TC-005", category: "RISK", kind: "ARBITER",
    title: "Premium-decay veto removes the only candidate",
    rationale: "A hard veto (premium Decaying) must not be outvoted by a high score.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bullish", finalScore: 62, setupQuality: 95, vetoed: true })] },
    expected: { verdict: "WAIT" },
  },
  {
    id: "TC-006", category: "COOLDOWN", kind: "ARBITER",
    title: "Dedup-suppressed candidate cannot re-enter",
    rationale: "suppressed=true is the no-re-entry-yet state; it must block the trade.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bullish", finalScore: 61, suppressed: true })] },
    expected: { verdict: "WAIT" },
  },
  {
    id: "TC-007", category: "EDGE_CASE", kind: "ARBITER",
    title: "setupQuality exactly at the display threshold (30)",
    rationale: "displayThreshold is inclusive (>=), so exactly 30 must still be actionable.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bullish", setupQuality: 30 })] },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-008", category: "EDGE_CASE", kind: "ARBITER",
    title: "setupQuality one point below the display threshold (29)",
    rationale: "Below clarity the setup is computed and logged but must never be actionable.",
    inputs: { candidates: [cand({ mode: "Directional", direction: "Bullish", setupQuality: 29 })] },
    expected: { verdict: "WAIT" },
  },

  // ======================= Arbiter: conflict resolution =======================
  {
    id: "TC-009", category: "CONFLICT", kind: "ARBITER",
    title: "Opposing candidates within the conflict margin, both below override clarity",
    rationale: "Genuine CONFLICT - must not be silently resolved into a guessed GO.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 58, setupQuality: 40 }),
        cand({ mode: "Scalp", direction: "Bearish", finalScore: 56, setupQuality: 45 }),
      ],
    },
    expected: { verdict: "CONFLICT" },
  },
  {
    id: "TC-010", category: "CONFLICT", kind: "ARBITER",
    title: "Opposing and close, but exactly one clears override clarity (50)",
    rationale: "Clarity tie-breaker promotes the clear one to GO instead of declaring CONFLICT.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 58, setupQuality: 55 }),
        cand({ mode: "Scalp", direction: "Bearish", finalScore: 56, setupQuality: 40 }),
      ],
    },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-011", category: "CONFLICT", kind: "ARBITER",
    title: "Opposing and close, BOTH clear override clarity",
    rationale: "Two equally clear opposing setups stay a CONFLICT - clarity cannot break the tie.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 58, setupQuality: 60 }),
        cand({ mode: "Scalp", direction: "Bearish", finalScore: 56, setupQuality: 70 }),
      ],
    },
    expected: { verdict: "CONFLICT" },
  },
  {
    id: "TC-012", category: "CONFLICT", kind: "ARBITER",
    title: "Opposing candidates separated by MORE than the conflict margin (6)",
    rationale: "A clear score gap is honest separation - the leader gets GO.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 62, setupQuality: 40 }),
        cand({ mode: "Scalp", direction: "Bearish", finalScore: 55, setupQuality: 40 }),
      ],
    },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-013", category: "CONFLICT", kind: "ARBITER",
    title: "Opposing candidates exactly at the conflict margin (6 apart)",
    rationale: "The margin check is <=, so exactly 6 apart is still a CONFLICT.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 62, setupQuality: 40 }),
        cand({ mode: "Scalp", direction: "Bearish", finalScore: 56, setupQuality: 40 }),
      ],
    },
    expected: { verdict: "CONFLICT" },
  },
  {
    id: "TC-014", category: "BULLISH", kind: "ARBITER",
    title: "Two candidates agreeing on direction",
    rationale: "Same-side agreement is not a conflict - the leader goes, the other is demoted.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 60, setupQuality: 60 }),
        cand({ mode: "Scalp", direction: "Bullish", finalScore: 58, setupQuality: 55 }),
      ],
    },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-015", category: "EDGE_CASE", kind: "ARBITER",
    title: "Identical scores, same direction",
    rationale: "A tie must still resolve deterministically to GO, never to an error or WAIT.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 57, setupQuality: 50 }),
        cand({ mode: "Scalp", direction: "Bullish", finalScore: 57, setupQuality: 50 }),
      ],
    },
    expected: { verdict: "GO" },
  },
  {
    id: "TC-016", category: "CONFLICT", kind: "ARBITER",
    title: "One eligible vs one vetoed opposing candidate",
    rationale: "A vetoed rival is not a conflict - it is removed before arbitration.",
    inputs: {
      candidates: [
        cand({ mode: "Directional", direction: "Bullish", finalScore: 57, setupQuality: 45 }),
        cand({ mode: "Scalp", direction: "Bearish", finalScore: 56, setupQuality: 80, vetoed: true }),
      ],
    },
    expected: { verdict: "GO" },
  },

  // ======================= Score engine: hard gates =======================
  {
    id: "TC-017", category: "RISK", kind: "SCORE",
    title: "baseTrigger false is a hard gate",
    rationale: "Without the OI TAKE + 1h bulletin trigger there is no trade, whatever else agrees.",
    inputs: { score: baseScore({ baseTrigger: false }) },
    expected: { baseTriggerPassed: false, finalScoreMax: 0 },
  },
  {
    id: "TC-018", category: "RISK", kind: "SCORE",
    title: "Decaying premium is an outright veto",
    rationale: "Premium decay must early-return as a veto, not merely subtract points.",
    inputs: { score: baseScore({ premiumState: "Decaying" }) },
    expected: { vetoed: true, finalScoreMax: 0 },
  },
  {
    id: "TC-019", category: "RISK", kind: "SCORE",
    title: "Score ceiling cannot be exceeded by stacked bonuses",
    rationale: "Every bonus aligned must still clamp at 62 - the clamp is the real governor.",
    inputs: {
      score: baseScore({
        baseConfidence: 62, regime: "Trending", wallReaction: "BREAK",
        sentimentState: "Bullish", premiumState: "Favorable", liquidityState: "Normal",
        openingBias: "Bullish", withinFirst30: true,
      }),
    },
    expected: { finalScoreMax: 62, finalScoreMin: 62 },
  },
  {
    id: "TC-020", category: "RISK", kind: "SCORE",
    title: "Score floor holds when penalties stack",
    rationale: "A thin book plus opposed sentiment must not push finalScore below the 52 floor.",
    inputs: { score: baseScore({ baseConfidence: 52, liquidityState: "Thin", sentimentState: "Bearish", direction: "Bullish", regime: "Transitioning", wallReaction: "UNCLEAR" }) },
    expected: { finalScoreMin: 52 },
  },
  {
    id: "TC-021", category: "RISK", kind: "SCORE",
    title: "Opposed sentiment tightens the reward:risk floor to 1.5",
    rationale: "Opposed sentiment withholds the bonus AND demands a better R:R - both must happen.",
    inputs: { score: baseScore({ sentimentState: "Bearish", direction: "Bullish" }) },
    expected: { rrFloorOverride: 1.5 },
  },
  {
    id: "TC-022", category: "RISK", kind: "SCORE",
    title: "Agreeing sentiment leaves the R:R floor unchanged",
    rationale: "The 1.5 override is specific to opposition; agreement must not trigger it.",
    inputs: { score: baseScore({ sentimentState: "Bullish", direction: "Bullish" }) },
    expected: { rrFloorOverride: null },
  },
  {
    id: "TC-023", category: "TIME_VETO", kind: "SCORE",
    title: "Opening-bias bonus applies only inside the first 30 minutes",
    rationale: "Time-gating the opening bonus is a rule; outside the window it must not apply.",
    inputs: { score: baseScore({ baseConfidence: 52, openingBias: "Bullish", withinFirst30: false, regime: "Transitioning", wallReaction: "UNCLEAR" }) },
    expected: { finalScoreMax: 52 },
  },

  // ======================= 15M / 5M candle validation =======================
  {
    id: "TC-024", category: "CANDLE_15M_5M", kind: "CANDLE",
    title: "15M and 5M both rising - confluence Bullish",
    rationale: "Aligned timeframes are the only state the EMA confluence may call Bullish.",
    inputs: { price: 160, closes5m: rising(60, 100), facts: { tf15Trend: "Bullish", tf5Trend: "Bullish", closeConfirmed: true, volume: "HIGH", candleComplete: true } },
    expected: { direction: "Bullish", tradeable: true },
  },
  {
    id: "TC-025", category: "CANDLE_15M_5M", kind: "CANDLE",
    title: "15M and 5M both falling - confluence Bearish",
    rationale: "Mirror of TC-024; a sustained downtrend must read Bearish.",
    inputs: { price: 140, closes5m: falling(60, 200), facts: { tf15Trend: "Bearish", tf5Trend: "Bearish", closeConfirmed: true, volume: "HIGH", candleComplete: true } },
    expected: { direction: "Bearish", tradeable: true },
  },
  {
    id: "TC-026", category: "CANDLE_15M_5M", kind: "CANDLE",
    title: "Flat series - confluence Neutral, not a coin-flip direction",
    rationale: "No edge must read Neutral rather than defaulting to a side.",
    inputs: { price: 100, closes5m: flat(60, 100), facts: { tf15Trend: "Neutral", tf5Trend: "Neutral", closeConfirmed: true, volume: "LOW", candleComplete: true } },
    expected: { direction: "Neutral", tradeable: false },
  },
  {
    id: "TC-027", category: "CANDLE_15M_5M", kind: "CANDLE",
    title: "Insufficient history for EMA21/50",
    rationale: "Too few bars must be Neutral (not computable), never an invented signal.",
    inputs: { price: 105, closes5m: rising(10, 100), facts: { tf15Trend: "Neutral", tf5Trend: "Bullish", closeConfirmed: false, volume: "LOW", candleComplete: false } },
    expected: { direction: "Neutral", tradeable: false },
  },
  {
    id: "TC-028", category: "CANDLE_15M_5M", kind: "CANDLE",
    title: "15M Bullish but 5M rolling over (timeframe conflict)",
    rationale: "A 5M series that ends falling must not read Bullish just because it started up.",
    inputs: {
      price: 120,
      closes5m: [...rising(40, 100), ...falling(20, 140, 2)],
      facts: { tf15Trend: "Bullish", tf5Trend: "Bearish", closeConfirmed: false, volume: "LOW", candleComplete: false },
    },
    expected: { tradeable: false },
  },

  // ======================= False setup detection =======================
  {
    id: "TC-029", category: "FALSE_BREAKOUT", kind: "FALSE_SETUP",
    title: "5M false breakout - no confirmed close",
    rationale: "A breakout without a confirmed close is the classic trap; it must not be tradeable.",
    inputs: { price: 118, closes5m: rising(60, 100), facts: { breakout: true, closeConfirmed: false, volume: "LOW", candleComplete: false, tf15Trend: "Bullish", tf5Trend: "Bullish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-030", category: "FALSE_BREAKOUT", kind: "FALSE_SETUP",
    title: "5M false breakdown - no confirmed close",
    rationale: "Mirror of TC-029 on the short side.",
    inputs: { price: 142, closes5m: falling(60, 200), facts: { breakdown: true, closeConfirmed: false, volume: "LOW", candleComplete: false, tf15Trend: "Bearish", tf5Trend: "Bearish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-031", category: "FALSE_BREAKOUT", kind: "FALSE_SETUP",
    title: "Weak-volume breakout",
    rationale: "A breakout on low volume lacks participation and must not be treated as confirmed.",
    inputs: { price: 160, closes5m: rising(60, 100), facts: { breakout: true, closeConfirmed: true, volume: "LOW", candleComplete: true, tf15Trend: "Bullish", tf5Trend: "Bullish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-032", category: "FALSE_BREAKOUT", kind: "FALSE_SETUP",
    title: "Long upper wick on an up-move (rejection)",
    rationale: "A dominant upper wick is rejection, not strength.",
    inputs: { price: 160, closes5m: rising(60, 100), facts: { breakout: true, closeConfirmed: true, volume: "HIGH", upperWickPct: 65, candleComplete: true, tf15Trend: "Bullish", tf5Trend: "Bullish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-033", category: "FALSE_BREAKOUT", kind: "FALSE_SETUP",
    title: "Long lower wick on a down-move (rejection)",
    rationale: "Mirror of TC-032 - a dominant lower wick rejects the breakdown.",
    inputs: { price: 140, closes5m: falling(60, 200), facts: { breakdown: true, closeConfirmed: true, volume: "HIGH", lowerWickPct: 65, candleComplete: true, tf15Trend: "Bearish", tf5Trend: "Bearish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-034", category: "FALSE_BREAKOUT", kind: "FALSE_SETUP",
    title: "Breakout against the 15M trend",
    rationale: "A 5M breakout opposing the 15M trend is counter-trend and must not be tradeable.",
    inputs: { price: 150, closes5m: rising(60, 100), facts: { breakout: true, closeConfirmed: true, volume: "HIGH", candleComplete: true, tf15Trend: "Bearish", tf5Trend: "Bullish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-035", category: "EDGE_CASE", kind: "FALSE_SETUP",
    title: "Incomplete candle",
    rationale: "An in-progress candle can still reverse - it must never confirm an entry.",
    inputs: { price: 160, closes5m: rising(60, 100), facts: { breakout: true, closeConfirmed: true, volume: "HIGH", candleComplete: false, tf15Trend: "Bullish", tf5Trend: "Bullish" } },
    expected: { tradeable: false },
  },
  {
    id: "TC-036", category: "OI_WALL", kind: "FALSE_SETUP",
    title: "OI wall rejection with no room to target",
    rationale: "Price into a heavy wall with no room is an AVOID, not a breakout trade.",
    inputs: {
      price: 160, closes5m: rising(60, 100),
      facts: { breakout: true, closeConfirmed: true, volume: "HIGH", candleComplete: true, tf15Trend: "Bullish", tf5Trend: "Bullish" },
      context: { callWall: 160, roomToWallPts: 2, requiredRoomPts: 15 },
    },
    expected: { tradeable: false },
  },
  {
    id: "TC-037", category: "PULLBACK", kind: "FALSE_SETUP",
    title: "Extended move with no pullback yet",
    rationale: "Chasing an extended move is the pullback case - entry should not be confirmed here.",
    inputs: {
      price: 175, closes5m: rising(60, 100, 1.25),
      facts: { breakout: true, closeConfirmed: true, volume: "NORMAL", candleComplete: true, tf15Trend: "Bullish", tf5Trend: "Bullish" },
      context: { extensionAtrMultiple: 3.4, pullbackSeen: false },
    },
    expected: { tradeable: false },
  },
  {
    id: "TC-038", category: "RANGE", kind: "FALSE_SETUP",
    title: "Range-bound chop with no directional edge",
    rationale: "Oscillation inside a range must produce no tradeable direction.",
    inputs: {
      price: 100,
      closes5m: Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.4 : -0.4)),
      facts: { breakout: false, closeConfirmed: true, volume: "NORMAL", candleComplete: true, tf15Trend: "Neutral", tf5Trend: "Neutral" },
    },
    expected: { direction: "Neutral", tradeable: false },
  },
];

export const CATEGORIES: ScenarioCategory[] = [
  "BULLISH", "BEARISH", "CONFLICT", "RANGE", "PULLBACK", "BREAKOUT", "FALSE_BREAKOUT",
  "OI_WALL", "CANDLE_15M_5M", "RISK", "TIME_VETO", "POSITION", "COOLDOWN", "EXPIRY", "EDGE_CASE",
];

export function scenariosByKind(kind: ScenarioKind): Scenario[] {
  return SCENARIOS.filter((s) => s.kind === kind);
}
