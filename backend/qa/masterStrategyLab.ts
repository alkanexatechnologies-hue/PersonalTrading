import { checkStrategyIntegrity, strategyVersion, currentGitCommit, combinedStrategyHash, IntegrityReport } from "./strategyIntegrity";
import { runScenario, selectScenarios, summarise, RunOptions, RunSummary, ScenarioRun } from "./scenarioRunner";
import { saveRun, latestRun, listRuns, readRun, newRunId, RunIndexEntry } from "./testRunStore";
import { SCENARIOS, CATEGORIES, Scenario } from "./scenarios";
import { CONFIG } from "../config/arbitration";

// ============================ Master Strategy Lab ============================
// Orchestration for the Lab screen: execute scenarios against the real engine,
// persist the run, and assemble the screen's state.
//
// LIVE TRADING: this module never enables live trading. It only REPORTS a
// blocked state so the UI can show it.

export interface QaSummarySection {
  key: string;
  label: string;
  status: "PASS" | "FAIL" | "NOT_RUN" | "GAP";
  detail: string;
}

export interface LabState {
  strategyVersion: string;
  commit: string | null;
  strategyHash: string;
  integrity: IntegrityReport;
  /** null until tests have actually been executed - the UI shows NOT RUN. */
  lastRun: RunSummary | null;
  history: RunIndexEntry[];
  categories: string[];
  /** Total scenarios defined (not the same as executed). */
  scenariosDefined: number;
  thresholds: typeof CONFIG;
  engineVerdicts: string[];
  liveTradingBlocked: boolean;
  liveTradingBlockReasons: string[];
  qaSummary: QaSummarySection[];
  liveReadiness: "GO" | "NO-GO" | "NOT_RUN";
  /** Decision vocabulary the engine actually implements, for the UI to state plainly. */
  vocabularyNote: string;
}

export function runScenarios(opts: RunOptions = {}): RunSummary {
  const startedAt = Date.now();
  const chosen = selectScenarios(opts);
  const runs: ScenarioRun[] = chosen.map((s) => runScenario(s));
  const summary: RunSummary = {
    runId: newRunId(),
    startedAt,
    finishedAt: Date.now(),
    strategyVersion: strategyVersion(),
    commit: currentGitCommit(),
    strategyHash: combinedStrategyHash(),
    ...summarise(runs),
  };
  saveRun(summary);
  return summary;
}

/** Scenario definitions without results - used to render NOT RUN rows. */
export function scenarioCatalogue(): Pick<Scenario, "id" | "category" | "kind" | "title" | "rationale">[] {
  return SCENARIOS.map(({ id, category, kind, title, rationale }) => ({ id, category, kind, title, rationale }));
}

function sectionStatus(runs: ScenarioRun[] | null, kinds: Scenario["kind"][]): QaSummarySection["status"] {
  if (!runs) return "NOT_RUN";
  const scoped = runs.filter((r) => kinds.includes(r.kind));
  if (!scoped.length) return "NOT_RUN";
  if (scoped.some((r) => r.result === "FAIL" || r.result === "UNEXPECTED")) return "FAIL";
  if (scoped.every((r) => r.result === "NO_ENGINE_RULE")) return "GAP";
  return scoped.some((r) => r.result === "PASS") ? "PASS" : "GAP";
}

function countDetail(runs: ScenarioRun[] | null, kinds: Scenario["kind"][]): string {
  if (!runs) return "never executed";
  const scoped = runs.filter((r) => kinds.includes(r.kind));
  if (!scoped.length) return "not executed in the last run";
  const p = scoped.filter((r) => r.result === "PASS").length;
  const f = scoped.filter((r) => r.result === "FAIL").length;
  const u = scoped.filter((r) => r.result === "UNEXPECTED").length;
  const g = scoped.filter((r) => r.result === "NO_ENGINE_RULE").length;
  return `${p} passed, ${f} failed, ${u} unexpected, ${g} no engine rule (of ${scoped.length})`;
}

export function buildLabState(): LabState {
  const integrity = checkStrategyIntegrity();
  const lastRun = latestRun();
  const runs = lastRun ? lastRun.scenarios : null;

  const qaSummary: QaSummarySection[] = [
    { key: "scenario", label: "Scenario testing", status: sectionStatus(runs, ["ARBITER"]), detail: countDetail(runs, ["ARBITER"]) },
    { key: "score", label: "Risk / scoring testing", status: sectionStatus(runs, ["SCORE"]), detail: countDetail(runs, ["SCORE"]) },
    { key: "candle", label: "15M / 5M candle testing", status: sectionStatus(runs, ["CANDLE"]), detail: countDetail(runs, ["CANDLE"]) },
    { key: "falseSetup", label: "False setup testing", status: sectionStatus(runs, ["FALSE_SETUP"]), detail: countDetail(runs, ["FALSE_SETUP"]) },
    {
      key: "integrity", label: "Strategy integrity",
      status: integrity.status === "INTACT" ? "PASS" : integrity.status === "NO_BASELINE" ? "NOT_RUN" : "FAIL",
      detail: integrity.status === "INTACT" ? `${integrity.filesChecked} strategy files match the baseline`
        : integrity.status === "NO_BASELINE" ? "no baseline recorded yet"
        : `${integrity.filesChanged.length} strategy file(s) changed`,
    },
  ];

  const blockReasons: string[] = [];
  if (integrity.status === "CHANGED") blockReasons.push("Master Strategy integrity FAILED - strategy files changed since the baseline");
  if (integrity.status === "NO_BASELINE") blockReasons.push("No strategy baseline recorded - integrity cannot be verified");
  if (!lastRun) blockReasons.push("QA scenarios have never been executed");
  if (lastRun && lastRun.failed > 0) blockReasons.push(`${lastRun.failed} scenario(s) FAILED in the last run`);
  if (lastRun && lastRun.unexpected > 0) blockReasons.push(`${lastRun.unexpected} scenario(s) produced UNEXPECTED engine behaviour`);

  const liveReadiness: LabState["liveReadiness"] = !lastRun ? "NOT_RUN" : blockReasons.length ? "NO-GO" : "GO";

  return {
    strategyVersion: strategyVersion(),
    commit: currentGitCommit(),
    strategyHash: combinedStrategyHash(),
    integrity,
    lastRun,
    history: listRuns(25),
    categories: CATEGORIES as unknown as string[],
    scenariosDefined: SCENARIOS.length,
    thresholds: CONFIG,
    engineVerdicts: ["GO", "WAIT", "CONFLICT"],
    liveTradingBlocked: blockReasons.length > 0,
    liveTradingBlockReasons: blockReasons,
    qaSummary,
    liveReadiness,
    vocabularyNote:
      "The Master Trade Selector (arbitrate(), backend/paper/ext/tradeArbiter.ts) returns GO / WAIT / CONFLICT. " +
      "TAKE / WAIT_FOR_PULLBACK / NO_EDGE / AVOID / HOLD are NOT implemented as engine verdicts today, so scenarios " +
      "assert the engine's real vocabulary rather than a richer one it does not produce.",
  };
}

export { readRun };
