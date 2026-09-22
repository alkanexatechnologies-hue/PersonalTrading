import fs from "fs";
import path from "path";

// ===================== India VIX environment (evidence-based) =====================
// Classifies the CURRENT India VIX environment from the app's OWN accumulated VIX
// history — a percentile of the recorded distribution — NOT a hard-coded absolute
// threshold ("VIX < X = good" is explicitly forbidden). Until enough history has
// been recorded it honestly reports INSUFFICIENT HISTORICAL EVIDENCE. The
// option-buying environment is only asserted once VIX-tagged outcomes exist;
// today that is INSUFFICIENT DATA (VIX measures expected volatility, not
// direction, so it is never used to force a bullish/bearish call).

const FILE = path.join(process.cwd(), "data", "analyst", "vix-samples.jsonl");
const MIN_SAMPLES = 40;        // need a real distribution before classifying
const DEDUP_SEC = 4 * 60;      // one sample per ~4 min

export type VixEnv = "LOW" | "NORMAL" | "ELEVATED" | "EXTREME" | "INSUFFICIENT DATA";
export type OptionEnv = "FAVOURABLE" | "SELECTIVE" | "UNFAVOURABLE" | "INSUFFICIENT DATA";

export interface VixEnvironment {
  environment: VixEnv;
  optionBuying: OptionEnv;
  percentile: number | null;   // where current VIX sits in the app's own history
  samples: number;
  why: string;
}

let _lastSampleAt = 0;

function loadSamples(): { at: number; v: number }[] {
  try { return fs.readFileSync(FILE, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

/** Record a VIX sample (deduped to ~4 min) so a percentile history can build. */
export function recordVixSample(value: number | null, at: number): void {
  if (value == null || !(value > 0)) return;
  if (at - _lastSampleAt < DEDUP_SEC) return;
  _lastSampleAt = at;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ at, v: Math.round(value * 100) / 100 }) + "\n", "utf-8");
  } catch { /* best-effort */ }
}

/** Classify the current VIX using the recorded distribution (percentile).
 *  `histOverride` (test only) supplies the sample series in place of the file. */
export function classifyVixEnvironment(current: number | null, histOverride?: number[]): VixEnvironment {
  const insufficient = (why: string, pct: number | null, n: number): VixEnvironment =>
    ({ environment: "INSUFFICIENT DATA", optionBuying: "INSUFFICIENT DATA", percentile: pct, samples: n, why });

  if (current == null || !(current > 0)) return insufficient("India VIX unavailable.", null, 0);
  const hist = (histOverride ?? loadSamples().map((s) => s.v)).filter((v) => v > 0);
  if (hist.length < MIN_SAMPLES) return insufficient(`INSUFFICIENT HISTORICAL EVIDENCE — ${hist.length}/${MIN_SAMPLES} VIX samples recorded so far.`, null, hist.length);

  const sorted = hist.slice().sort((a, b) => a - b);
  const below = sorted.filter((v) => v <= current).length;
  const percentile = Math.round((below / sorted.length) * 100);

  const environment: VixEnv = percentile < 25 ? "LOW" : percentile < 60 ? "NORMAL" : percentile < 85 ? "ELEVATED" : "EXTREME";
  // Option-buying environment stays INSUFFICIENT until VIX-tagged outcomes exist
  // to validate it — VIX level alone never asserts favourable/unfavourable.
  const optionBuying: OptionEnv = "INSUFFICIENT DATA";
  const why = `India VIX ${current} is at the ${percentile}th percentile of ${sorted.length} recorded readings → ${environment}. Option-buying suitability needs VIX-tagged outcome history (not yet sufficient).`;
  return { environment, optionBuying, percentile, samples: sorted.length, why };
}
