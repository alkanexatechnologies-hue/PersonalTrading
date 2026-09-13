import { arbitrate, ArbiterResult } from "../paper/ext/tradeArbiter";
import { computeTradeScore, TradeScoreResult } from "../paper/ext/tradeScore";
import { emaConfluenceDirection, emaShortDirection, emaLongDirection } from "../signals/emaConfluence";
import { detectCandlePattern, CandleSignal } from "../signals/candles";
import { detectStructure } from "../commentary/marketCommentary";
import { CONFIG } from "../config/arbitration";
import { Candle } from "../types";
import { Scenario, SCENARIOS, ScenarioCategory, CandleFacts } from "./scenarios";

// ============================ Scenario runner ============================
// Executes each scenario against the REAL, unmodified Master Strategy engine
// (arbitrate / computeTradeScore / emaConfluence* / detectCandlePattern /
// detectStructure) and compares the engine's actual output to the expectation.
//
// This module NEVER implements a strategy rule. Where a scenario asserts
// behaviour the engine has no rule for, the result is NO_ENGINE_RULE - an
// honest gap - not a synthesised pass or fail. That is how a missing gate stays
// visible instead of being papered over by test code.

export type ScenarioResult = "PASS" | "FAIL" | "UNEXPECTED" | "NO_ENGINE_RULE" | "NOT_RUN";

export interface GateOutcome { gate: string; outcome: "PASS" | "FAIL" | "N/A"; detail: string; }

export interface ScenarioRun {
  id: string;
  category: ScenarioCategory;
  kind: Scenario["kind"];
  title: string;
  rationale: string;
  result: ScenarioResult;
  /** What the scenario expected, as displayable text. */
  expected: string;
  /** What the engine actually produced, as displayable text. */
  actual: string;
  reason: string;
  /** Headline numbers for the grid columns. */
  score: number | null;
  direction: string | null;
  tf15: string | null;
  tf5: string | null;
  rr: string | null;
  /** Full evidence for the detail panel. */
  evidence: {
    inputs: Record<string, unknown>;
    scoreBreakdown: string[];
    gates: GateOutcome[];
    engineRaw: Record<string, unknown>;
  };
  durationMs: number;
}

export interface RunSummary {
  runId: string;
  startedAt: number;
  finishedAt: number;
  strategyVersion: string;
  commit: string | null;
  strategyHash: string;
  total: number;
  passed: number;
  failed: number;
  unexpected: number;
  noEngineRule: number;
  passPct: number | null; // null when nothing ran - never a fake 0%
  scenarios: ScenarioRun[];
}

// ---- test-fixture helpers (construct INPUTS only; no strategy logic) ----

/** Build a candle whose wick proportions match the scenario's stated facts. */
function candleFromFacts(f: CandleFacts, closeUp: boolean, t: number): Candle {
  const open = 100;
  const bodySize = 4;
  const close = closeUp ? open + bodySize : open - bodySize;
  const bodyHi = Math.max(open, close);
  const bodyLo = Math.min(open, close);
  // upperWickPct/lowerWickPct are "percent of total range", so derive absolute
  // wick sizes that reproduce that proportion around the fixed body.
  const up = f.upperWickPct ?? 10;
  const lo = f.lowerWickPct ?? 10;
  const bodyPctOfRange = Math.max(1, 100 - up - lo);
  const totalRange = (bodySize / bodyPctOfRange) * 100;
  return {
    time: t,
    open, close,
    high: bodyHi + (up / 100) * totalRange,
    low: bodyLo - (lo / 100) * totalRange,
    volume: f.volume === "HIGH" ? 5_000_000 : f.volume === "LOW" ? 50_000 : 1_000_000,
  };
}

function barsFromCloses(closes: number[]): { high: number; low: number; close: number }[] {
  return closes.map((c) => ({ high: c * 1.002, low: c * 0.998, close: c }));
}

const fmt = (v: unknown) => (v === null || v === undefined ? "—" : String(v));

// ---- per-kind execution against the real engine ----

function runArbiterScenario(s: Scenario): Partial<ScenarioRun> {
  const candidates = s.inputs.candidates ?? [];
  const res: ArbiterResult = arbitrate(candidates); // REAL Master Trade Selector
  const actual = res.verdict;
  const expected = s.expected.verdict!;
  const top = res.primary;

  const gates: GateOutcome[] = [
    {
      gate: "Eligibility", outcome: candidates.some((c) => c.eligible) ? "PASS" : "FAIL",
      detail: `${candidates.filter((c) => c.eligible).length}/${candidates.length} candidate(s) eligible`,
    },
    {
      gate: "Veto (premium decay)", outcome: candidates.some((c) => c.vetoed) ? "FAIL" : "PASS",
      detail: candidates.some((c) => c.vetoed) ? "at least one candidate vetoed" : "no veto",
    },
    {
      gate: "Dedup / cooldown", outcome: candidates.some((c) => c.suppressed) ? "FAIL" : "PASS",
      detail: candidates.some((c) => c.suppressed) ? "a candidate was dedup-suppressed" : "not suppressed",
    },
    {
      gate: `Clarity >= ${CONFIG.setupQuality.displayThreshold}`,
      outcome: candidates.some((c) => c.setupQuality >= CONFIG.setupQuality.displayThreshold) ? "PASS" : "FAIL",
      detail: `max setupQuality ${candidates.length ? Math.max(...candidates.map((c) => c.setupQuality)) : "—"}`,
    },
  ];

  return {
    result: actual === expected ? "PASS" : "FAIL",
    expected, actual,
    reason: res.reason,
    score: top ? top.finalScore : null,
    direction: top ? top.direction : null,
    rr: null,
    evidence: {
      inputs: { candidates, thresholds: CONFIG.arbitration, displayThreshold: CONFIG.setupQuality.displayThreshold },
      scoreBreakdown: candidates.map((c) => `${c.mode} ${c.direction}: finalScore ${c.finalScore}, clarity ${c.setupQuality}${c.vetoed ? ", VETOED" : ""}${c.suppressed ? ", SUPPRESSED" : ""}${c.eligible ? "" : ", NOT ELIGIBLE"}`),
      gates,
      engineRaw: { verdict: res.verdict, primary: res.primary, secondary: res.secondary, suppressed: res.suppressed, reason: res.reason },
    },
  };
}

function runScoreScenario(s: Scenario): Partial<ScenarioRun> {
  const inp = s.inputs.score!;
  const res: TradeScoreResult = computeTradeScore(inp); // REAL scorer
  const e = s.expected;
  const checks: string[] = [];
  let ok = true;

  if (e.vetoed !== undefined) {
    if (res.vetoed !== e.vetoed) { ok = false; checks.push(`vetoed expected ${e.vetoed}, got ${res.vetoed}`); }
  }
  if (e.baseTriggerPassed !== undefined) {
    if (res.baseTriggerPassed !== e.baseTriggerPassed) { ok = false; checks.push(`baseTriggerPassed expected ${e.baseTriggerPassed}, got ${res.baseTriggerPassed}`); }
  }
  if (e.finalScoreMin !== undefined && res.finalScore < e.finalScoreMin) { ok = false; checks.push(`finalScore ${res.finalScore} below expected min ${e.finalScoreMin}`); }
  if (e.finalScoreMax !== undefined && res.finalScore > e.finalScoreMax) { ok = false; checks.push(`finalScore ${res.finalScore} above expected max ${e.finalScoreMax}`); }
  if (e.rrFloorOverride !== undefined && res.rrFloorOverride !== e.rrFloorOverride) {
    ok = false; checks.push(`rrFloorOverride expected ${fmt(e.rrFloorOverride)}, got ${fmt(res.rrFloorOverride)}`);
  }

  const expectedParts = [
    e.vetoed !== undefined ? `vetoed=${e.vetoed}` : null,
    e.baseTriggerPassed !== undefined ? `trigger=${e.baseTriggerPassed}` : null,
    e.finalScoreMin !== undefined ? `score>=${e.finalScoreMin}` : null,
    e.finalScoreMax !== undefined ? `score<=${e.finalScoreMax}` : null,
    e.rrFloorOverride !== undefined ? `rrFloor=${fmt(e.rrFloorOverride)}` : null,
  ].filter(Boolean).join(", ");

  return {
    result: ok ? "PASS" : "FAIL",
    expected: expectedParts,
    actual: `score ${res.finalScore}, clarity ${res.setupQuality}, vetoed=${res.vetoed}, trigger=${res.baseTriggerPassed}, rrFloor=${fmt(res.rrFloorOverride)}`,
    reason: ok ? res.reasons.join("; ") || "all assertions held" : checks.join("; "),
    score: res.finalScore,
    direction: inp.direction,
    rr: res.rrFloorOverride != null ? `1:${res.rrFloorOverride}` : null,
    evidence: {
      inputs: { ...inp, clamp: CONFIG.tradeScore },
      scoreBreakdown: res.reasons,
      gates: [
        { gate: "baseTrigger (OI TAKE + 1h)", outcome: res.baseTriggerPassed ? "PASS" : "FAIL", detail: res.baseTriggerPassed ? "trigger present" : "no baseTrigger" },
        { gate: "Premium veto", outcome: res.vetoed ? "FAIL" : "PASS", detail: res.vetoed ? "premiumState=Decaying" : `premiumState=${inp.premiumState}` },
        { gate: `Score clamp ${CONFIG.tradeScore.floor}..${CONFIG.tradeScore.ceiling}`, outcome: "PASS", detail: `finalScore=${res.finalScore}` },
        { gate: "R:R floor", outcome: res.rrFloorOverride != null ? "FAIL" : "PASS", detail: res.rrFloorOverride != null ? `tightened to 1:${res.rrFloorOverride} (sentiment opposed)` : "default floor" },
      ],
      engineRaw: { ...res },
    },
  };
}

function runCandleScenario(s: Scenario): Partial<ScenarioRun> {
  const closes = s.inputs.closes5m ?? [];
  const price = s.inputs.price ?? closes[closes.length - 1] ?? 0;
  // REAL engine helpers.
  const confluence = emaConfluenceDirection(price, closes);
  const short = emaShortDirection(closes);
  const long = emaLongDirection(price, closes);
  const structure = closes.length >= 12 ? detectStructure(barsFromCloses(closes)) : "Unclear";
  const facts = s.inputs.facts ?? {};

  const e = s.expected;
  let result: ScenarioResult;
  const checks: string[] = [];

  if (e.direction !== undefined) {
    result = confluence === e.direction ? "PASS" : "FAIL";
    if (confluence !== e.direction) checks.push(`EMA confluence expected ${e.direction}, got ${confluence}`);
  } else if (e.tradeable !== undefined) {
    // The only engine-backed proxy for "tradeable direction exists" is a
    // non-Neutral confluence. Anything stricter (confirmed close, volume
    // quality) has no engine gate - see runFalseSetupScenario.
    const engineTradeable = confluence !== "Neutral";
    result = engineTradeable === e.tradeable ? "PASS" : "FAIL";
    if (engineTradeable !== e.tradeable) checks.push(`expected tradeable=${e.tradeable}, engine confluence=${confluence}`);
  } else {
    result = "NO_ENGINE_RULE";
    checks.push("scenario states no engine-checkable expectation");
  }

  return {
    result,
    expected: e.direction !== undefined ? `confluence ${e.direction}` : `tradeable=${e.tradeable}`,
    actual: `confluence ${confluence} (9/21 ${short}, long ${long}), structure ${structure}`,
    reason: checks.length ? checks.join("; ") : `EMA confluence ${confluence}; structure ${structure}`,
    score: null,
    direction: confluence,
    tf15: facts.tf15Trend ?? null,
    tf5: facts.tf5Trend ?? null,
    rr: null,
    evidence: {
      inputs: { price, bars: closes.length, first: closes[0] ?? null, last: closes[closes.length - 1] ?? null, facts },
      scoreBreakdown: [
        `EMA 9/21 (short): ${short}`,
        `EMA long (price vs 21/50): ${long}`,
        `Confluence (both must agree): ${confluence}`,
        `Structure (detectStructure): ${structure}`,
      ],
      gates: [
        { gate: "EMA confluence", outcome: confluence !== "Neutral" ? "PASS" : "FAIL", detail: `${confluence} (needs short AND long agreement)` },
        { gate: "Sufficient history (>=50 bars)", outcome: closes.length >= 50 ? "PASS" : "FAIL", detail: `${closes.length} bars supplied` },
        { gate: "Confirmed close", outcome: "N/A", detail: "NO ENGINE RULE - engine has no confirmed-close gate" },
        { gate: "Candle complete", outcome: "N/A", detail: "NO ENGINE RULE - engine has no candle-completion gate" },
      ],
      engineRaw: { confluence, short, long, structure },
    },
  };
}

function runFalseSetupScenario(s: Scenario): Partial<ScenarioRun> {
  const facts = s.inputs.facts ?? {};
  const closes = s.inputs.closes5m ?? [];
  const price = s.inputs.price ?? closes[closes.length - 1] ?? 0;
  const confluence = emaConfluenceDirection(price, closes);

  // Wick rejection IS implemented in the engine (signals/candles.ts Hammer /
  // Shooting Star), so a wick-based scenario can be asserted for real.
  const hasWickClaim = (facts.upperWickPct ?? 0) >= 50 || (facts.lowerWickPct ?? 0) >= 50;
  let pattern: CandleSignal | null = null;
  if (hasWickClaim) {
    const closeUp = !!facts.breakout;
    // The preceding candle must be WIDER than the one under test, otherwise the
    // engine's 2-candle engulfing rule fires first and the wick rule never gets
    // evaluated - that would test the fixture, not the wick.
    const prev: Candle = { time: 1, open: 90, high: 116, low: 86, close: 112, volume: 1_000_000 };
    pattern = detectCandlePattern([prev, candleFromFacts(facts, closeUp, 2)]);
  }

  // Everything else this scenario describes (confirmed close, candle
  // completion, volume quality, room-to-wall, extension/pullback) has NO
  // corresponding gate in the Master Strategy engine today. Report the gap.
  const unsupported: string[] = [];
  if (facts.closeConfirmed === false) unsupported.push("confirmed-close gate");
  if (facts.candleComplete === false) unsupported.push("candle-completion gate");
  if (facts.volume === "LOW" && (facts.breakout || facts.breakdown)) unsupported.push("breakout volume-quality gate");
  if (s.inputs.context?.roomToWallPts !== undefined) unsupported.push("room-to-wall gate");
  if (s.inputs.context?.extensionAtrMultiple !== undefined) unsupported.push("extension/pullback gate");
  if (facts.tf15Trend && facts.tf5Trend && facts.tf15Trend !== facts.tf5Trend) unsupported.push("15M/5M trend-agreement gate");

  const gates: GateOutcome[] = [
    { gate: "EMA confluence", outcome: confluence !== "Neutral" ? "PASS" : "FAIL", detail: `confluence ${confluence}` },
    pattern
      ? { gate: "Wick rejection (detectCandlePattern)", outcome: pattern.bias === 0 || pattern.pattern === "None" ? "PASS" : "FAIL", detail: `${pattern.pattern} (bias ${pattern.bias}) - ${pattern.reason}` }
      : { gate: "Wick rejection (detectCandlePattern)", outcome: "N/A", detail: "scenario states no dominant wick" },
    ...unsupported.map((g) => ({ gate: g, outcome: "N/A" as const, detail: "NO ENGINE RULE - not implemented in the Master Strategy engine" })),
  ];

  let result: ScenarioResult;
  let reason: string;
  let actual: string;

  if (pattern) {
    // The engine DOES detect this. A rejection pattern means "not a clean
    // continuation", which is what the scenario expects (tradeable=false).
    const engineFlagsRejection = pattern.pattern === "Shooting Star" || pattern.pattern === "Hammer";
    const engineTradeable = !engineFlagsRejection;
    result = engineTradeable === (s.expected.tradeable ?? false) ? "PASS" : "FAIL";
    actual = `${pattern.pattern} (bias ${pattern.bias}) -> tradeable=${engineTradeable}`;
    reason = pattern.reason;
  } else if (unsupported.length) {
    result = "NO_ENGINE_RULE";
    actual = `no engine gate for: ${unsupported.join(", ")}`;
    reason = `The Master Strategy engine has no ${unsupported.join(" / ")}. This scenario cannot pass or fail until such a gate exists - reported as a gap rather than a synthesised result.`;
  } else {
    const engineTradeable = confluence !== "Neutral";
    result = engineTradeable === (s.expected.tradeable ?? false) ? "PASS" : "FAIL";
    actual = `confluence ${confluence} -> tradeable=${engineTradeable}`;
    reason = `Only EMA confluence applies here; it reads ${confluence}.`;
  }

  return {
    result,
    expected: `tradeable=${s.expected.tradeable}`,
    actual, reason,
    score: null,
    direction: confluence,
    tf15: facts.tf15Trend ?? null,
    tf5: facts.tf5Trend ?? null,
    rr: s.inputs.context?.roomToWallPts !== undefined ? `room ${s.inputs.context.roomToWallPts}pts` : null,
    evidence: {
      inputs: { price, bars: closes.length, facts, context: s.inputs.context ?? {} },
      scoreBreakdown: [
        `EMA confluence: ${confluence}`,
        pattern ? `Candle pattern: ${pattern.pattern} (bias ${pattern.bias}, strength ${pattern.strength})` : "Candle pattern: not evaluated (no dominant wick claimed)",
        ...unsupported.map((g) => `NO ENGINE RULE: ${g}`),
      ],
      gates,
      engineRaw: { confluence, pattern, unsupportedGates: unsupported },
    },
  };
}

/** Run one scenario against the real engine. */
export function runScenario(s: Scenario): ScenarioRun {
  const t0 = Date.now();
  let partial: Partial<ScenarioRun>;
  try {
    partial =
      s.kind === "ARBITER" ? runArbiterScenario(s)
      : s.kind === "SCORE" ? runScoreScenario(s)
      : s.kind === "CANDLE" ? runCandleScenario(s)
      : runFalseSetupScenario(s);
  } catch (e: any) {
    // An engine throw is UNEXPECTED - neither a clean pass nor an assertion fail.
    partial = {
      result: "UNEXPECTED",
      expected: JSON.stringify(s.expected),
      actual: `engine threw: ${e?.message || e}`,
      reason: `The engine raised an error for these inputs: ${e?.message || e}`,
      score: null, direction: null, rr: null,
      evidence: { inputs: s.inputs as any, scoreBreakdown: [], gates: [], engineRaw: { error: String(e?.message || e) } },
    };
  }
  return {
    id: s.id, category: s.category, kind: s.kind, title: s.title, rationale: s.rationale,
    result: partial.result ?? "NOT_RUN",
    expected: partial.expected ?? "", actual: partial.actual ?? "", reason: partial.reason ?? "",
    score: partial.score ?? null, direction: partial.direction ?? null,
    tf15: partial.tf15 ?? null, tf5: partial.tf5 ?? null, rr: partial.rr ?? null,
    evidence: partial.evidence ?? { inputs: {}, scoreBreakdown: [], gates: [], engineRaw: {} },
    durationMs: Date.now() - t0,
  };
}

export interface RunOptions {
  /** Limit to these scenario ids (used by RUN FAILED SCENARIOS). */
  ids?: string[];
  /** Limit to these kinds (used by RUN CANDLE TESTS / RUN FALSE SETUP TESTS). */
  kinds?: Scenario["kind"][];
}

export function selectScenarios(opts: RunOptions = {}): Scenario[] {
  let list = SCENARIOS;
  if (opts.kinds?.length) list = list.filter((s) => opts.kinds!.includes(s.kind));
  if (opts.ids?.length) list = list.filter((s) => opts.ids!.includes(s.id));
  return list;
}

export function summarise(runs: ScenarioRun[]): Omit<RunSummary, "runId" | "startedAt" | "finishedAt" | "strategyVersion" | "commit" | "strategyHash"> {
  const passed = runs.filter((r) => r.result === "PASS").length;
  const failed = runs.filter((r) => r.result === "FAIL").length;
  const unexpected = runs.filter((r) => r.result === "UNEXPECTED").length;
  const noEngineRule = runs.filter((r) => r.result === "NO_ENGINE_RULE").length;
  // Pass % is over ASSERTABLE scenarios only, and null when none ran - never a
  // fabricated 0%.
  const assertable = passed + failed + unexpected;
  return {
    total: runs.length, passed, failed, unexpected, noEngineRule,
    passPct: assertable > 0 ? Math.round((passed / assertable) * 1000) / 10 : null,
    scenarios: runs,
  };
}
