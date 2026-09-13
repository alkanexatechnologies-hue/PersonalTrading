import test from "node:test";
import assert from "node:assert/strict";
import { runScenario, selectScenarios, summarise } from "./scenarioRunner";
import { SCENARIOS } from "./scenarios";
import { STRATEGY_FILES, hashStrategyFiles, combinedStrategyHash, checkStrategyIntegrity, strategyVersion } from "./strategyIntegrity";
import { arbitrate } from "../paper/ext/tradeArbiter";

// ============================ Master Strategy Lab QA tests ============================
// Tests the TEST HARNESS, not the strategy. The strategy itself must stay
// untouched, so the guarantees pinned here are: every scenario actually executes
// the real engine, nothing is hard-coded, and an unexecuted suite cannot report a
// fabricated pass rate.

test("every scenario has a unique id", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate scenario id");
});

test("every scenario states at least one checkable expectation", () => {
  for (const s of SCENARIOS) {
    const keys = Object.keys(s.expected);
    assert.ok(keys.length > 0, `${s.id} has no expectation`);
  }
});

test("every scenario runs without the harness throwing", () => {
  for (const s of SCENARIOS) {
    const r = runScenario(s);
    assert.ok(r.id === s.id, "result must carry its scenario id");
    assert.ok(["PASS", "FAIL", "UNEXPECTED", "NO_ENGINE_RULE", "NOT_RUN"].includes(r.result), `${s.id} produced an unknown result`);
  }
});

test("runner results carry real evidence, not placeholders", () => {
  const arbiter = SCENARIOS.filter((s) => s.kind === "ARBITER");
  for (const s of arbiter) {
    const r = runScenario(s);
    assert.ok(r.evidence.gates.length > 0, `${s.id} must record gate outcomes`);
    assert.ok(typeof r.evidence.engineRaw === "object" && r.evidence.engineRaw !== null, `${s.id} must record raw engine output`);
    assert.ok(r.reason.length > 0, `${s.id} must record a reason`);
  }
});

test("arbiter scenarios assert the engine's real verdict vocabulary only", () => {
  for (const s of SCENARIOS.filter((x) => x.kind === "ARBITER")) {
    assert.ok(["GO", "WAIT", "CONFLICT"].includes(s.expected.verdict!), `${s.id} expects a verdict the engine cannot produce`);
  }
});

test("runner reports the engine's ACTUAL verdict, not the expectation", () => {
  // Feed a scenario whose expectation is deliberately wrong; the runner must
  // report FAIL with the engine's real output rather than echoing the expectation.
  const real = arbitrate([{ mode: "Directional", direction: "Bullish", finalScore: 60, setupQuality: 70, eligible: true }]);
  const lying = {
    ...SCENARIOS.find((s) => s.id === "TC-001")!,
    id: "TC-LIE", expected: { verdict: "CONFLICT" as const },
  };
  const r = runScenario(lying);
  assert.equal(r.result, "FAIL", "a wrong expectation must FAIL, proving results are not derived from expectations");
  assert.equal(r.actual, real.verdict, "actual must be the engine's verdict");
});

test("an engine throw is reported as UNEXPECTED, never as PASS", () => {
  const broken = {
    ...SCENARIOS[0],
    id: "TC-THROW", kind: "SCORE" as const,
    inputs: { score: null as any }, // forces computeTradeScore to throw
  };
  const r = runScenario(broken);
  assert.equal(r.result, "UNEXPECTED");
  assert.match(r.actual, /engine threw/);
});

test("summarise computes passPct over assertable scenarios and null when none ran", () => {
  assert.equal(summarise([]).passPct, null, "no scenarios must be null, never a fake 0%");
  const onlyGaps = summarise([{ result: "NO_ENGINE_RULE" } as any]);
  assert.equal(onlyGaps.passPct, null, "gaps alone are not a pass rate");
  const mixed = summarise([{ result: "PASS" }, { result: "PASS" }, { result: "FAIL" }, { result: "NO_ENGINE_RULE" }] as any);
  assert.equal(mixed.passed, 2);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.noEngineRule, 1);
  assert.equal(mixed.passPct, 66.7, "pass% excludes NO_ENGINE_RULE from the denominator");
});

test("selectScenarios filters by kind and by id", () => {
  const candles = selectScenarios({ kinds: ["CANDLE"] });
  assert.ok(candles.length > 0);
  assert.ok(candles.every((s) => s.kind === "CANDLE"));
  const one = selectScenarios({ ids: ["TC-001"] });
  assert.equal(one.length, 1);
  assert.equal(one[0].id, "TC-001");
});

test("scenarios with no engine rule are reported as gaps, never as passes", () => {
  // This is the integrity guarantee for the false-setup section: the engine has
  // no confirmed-close / volume-quality / room-to-wall gate, and the harness must
  // say so rather than implement the rule itself and call it a pass.
  const gapRuns = SCENARIOS.filter((s) => s.kind === "FALSE_SETUP").map(runScenario);
  const gaps = gapRuns.filter((r) => r.result === "NO_ENGINE_RULE");
  assert.ok(gaps.length > 0, "expected at least one reported engine gap");
  for (const g of gaps) assert.match(g.reason, /no .*gate|NO ENGINE RULE/i);
});

// ---- strategy integrity ----

test("every listed strategy file exists and hashes", () => {
  const hashes = hashStrategyFiles();
  assert.equal(hashes.length, STRATEGY_FILES.length);
  for (const h of hashes) assert.ok(h.sha256, `strategy file missing: ${h.file}`);
});

test("the combined strategy hash is stable across calls", () => {
  assert.equal(combinedStrategyHash(), combinedStrategyHash());
});

test("integrity check reports a known status and never throws", () => {
  const r = checkStrategyIntegrity();
  assert.ok(["INTACT", "CHANGED", "NO_BASELINE"].includes(r.status));
  assert.equal(r.filesChecked, STRATEGY_FILES.length);
  assert.ok(Array.isArray(r.filesChanged));
});

test("strategy version is reported in MS- form", () => {
  assert.match(strategyVersion(), /^MS-/);
});
