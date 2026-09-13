import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

// ============================ Master Strategy integrity ============================
// Answers ONE question: "has the Master Strategy changed since the baseline?"
//
// This module is READ-ONLY with respect to strategy code. It hashes the files
// that define the strategy and compares them against a recorded baseline, so
// any edit to scoring, thresholds, weights, gates or rules shows up as a
// MASTER STRATEGY CHANGED state with the exact file list.
//
// The baseline lives in data/ (gitignored) and is written only when an operator
// explicitly accepts the current state as the new baseline.

// Every file that defines the Master Strategy's behaviour. Adding a strategy
// file here is deliberate: if it can change a decision, it belongs in this list.
export const STRATEGY_FILES = [
  "backend/paper/ext/tradeArbiter.ts",   // Master Trade Selector (GO/WAIT/CONFLICT)
  "backend/paper/ext/tradeScore.ts",     // composite scorer + hard gates
  "backend/paper/ext/pipeline.ts",       // scoreExtension orchestration
  "backend/paper/ext/marketRegime.ts",
  "backend/paper/ext/premiumSentiment.ts",
  "backend/paper/ext/liquidityGuard.ts",
  "backend/paper/ext/wallReaction.ts",
  "backend/paper/ext/sentiment4L.ts",
  "backend/paper/ext/openingBias.ts",
  "backend/paper/ext/tradeDedup.ts",
  "backend/paper/ext/macroSetup.ts",
  "backend/config/arbitration.ts",       // every threshold
  "backend/signals/emaConfluence.ts",
  "backend/signals/direction4L.ts",
  "backend/signals/score.ts",
  "backend/signals/engine.ts",
  "backend/oi/oi.ts",
  "backend/oi/oiChange.ts",
  "backend/oi/oiTrade.ts",
  "backend/options/highProbAlgo.ts",
  "backend/options/riskRadar.ts",
];

const BASELINE_FILE = path.join(process.cwd(), "data", "strategy-baseline.json");

export interface FileHash { file: string; sha256: string | null; }

export interface StrategyBaseline {
  recordedAt: number;
  commit: string | null;
  strategyVersion: string;
  files: FileHash[];
}

export interface ChangedFile {
  file: string;
  state: "MODIFIED" | "ADDED" | "REMOVED" | "MISSING";
}

export interface IntegrityReport {
  status: "INTACT" | "CHANGED" | "NO_BASELINE";
  strategyVersion: string;
  /** Combined hash of every strategy file - changes if any rule changes. */
  strategyHash: string;
  baselineCommit: string | null;
  currentCommit: string | null;
  baselineRecordedAt: number | null;
  filesChecked: number;
  filesChanged: ChangedFile[];
}

function sha256OfFile(abs: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

/** Short git commit of the working tree, or null outside a repo. */
export function currentGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Strategy version from package.json, prefixed MS- (MS = Master Strategy). */
export function strategyVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    return `MS-${pkg.version || "0.0.0"}`;
  } catch {
    return "MS-0.0.0";
  }
}

export function hashStrategyFiles(): FileHash[] {
  return STRATEGY_FILES.map((file) => ({ file, sha256: sha256OfFile(path.join(process.cwd(), file)) }));
}

/** One hash over all strategy files - the strategy's fingerprint. */
export function combinedStrategyHash(files = hashStrategyFiles()): string {
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(`${f.file}:${f.sha256 ?? "MISSING"}\n`);
  return h.digest("hex").slice(0, 12);
}

export function readBaseline(): StrategyBaseline | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as StrategyBaseline;
  } catch {
    return null;
  }
}

/**
 * Record the CURRENT strategy state as the baseline. Called only on explicit
 * operator action - never automatically, or a changed strategy would silently
 * become "intact".
 */
export function writeBaseline(): StrategyBaseline {
  const baseline: StrategyBaseline = {
    recordedAt: Date.now(),
    commit: currentGitCommit(),
    strategyVersion: strategyVersion(),
    files: hashStrategyFiles(),
  };
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), "utf-8");
  return baseline;
}

export function checkStrategyIntegrity(): IntegrityReport {
  const files = hashStrategyFiles();
  const strategyHash = combinedStrategyHash(files);
  const baseline = readBaseline();
  const common = {
    strategyVersion: strategyVersion(),
    strategyHash,
    currentCommit: currentGitCommit(),
    filesChecked: files.length,
  };

  // Missing strategy files are a problem regardless of whether a baseline exists.
  const missing: ChangedFile[] = files.filter((f) => f.sha256 == null).map((f) => ({ file: f.file, state: "MISSING" as const }));

  if (!baseline) {
    return {
      ...common,
      status: missing.length ? "CHANGED" : "NO_BASELINE",
      baselineCommit: null,
      baselineRecordedAt: null,
      filesChanged: missing,
    };
  }

  const baseByFile = new Map(baseline.files.map((f) => [f.file, f.sha256]));
  const nowByFile = new Map(files.map((f) => [f.file, f.sha256]));
  const changed: ChangedFile[] = [];

  for (const f of files) {
    if (f.sha256 == null) { changed.push({ file: f.file, state: "MISSING" }); continue; }
    if (!baseByFile.has(f.file)) { changed.push({ file: f.file, state: "ADDED" }); continue; }
    if (baseByFile.get(f.file) !== f.sha256) changed.push({ file: f.file, state: "MODIFIED" });
  }
  for (const f of baseline.files) {
    if (!nowByFile.has(f.file)) changed.push({ file: f.file, state: "REMOVED" });
  }

  return {
    ...common,
    status: changed.length ? "CHANGED" : "INTACT",
    baselineCommit: baseline.commit,
    baselineRecordedAt: baseline.recordedAt,
    filesChanged: changed,
  };
}
