import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

// ============================ Prediction log + honest scoring ============================
// Every prediction the Command Center shows is logged once per closed 5-minute NIFTY candle with
// its timestamp, model version, full input snapshot and each input's age. It is then scored at
// 15, 30 and 60 minutes with the outcome rule below, which is fixed BEFORE any scoring:
//
//   r   = last-traded NIFTY at t+h ÷ last-traded NIFTY at t − 1   (closes of 5-min bars that had
//         closed by t and by t+h; the 15:25 bar is never used — it carries NSE's closing calc)
//   σh  = spot × (India VIX at t / 100) × √(h / 375) / √252          (VIX-implied h-minute sigma)
//   UP  if r > +0.5·σh/spot · DOWN if r < −0.5·σh/spot · otherwise SIDEWAYS
//   A horizon whose end falls after 15:20 IST is NOT scored (marked "beyond session").
//
// One prediction = one record. Its three horizons are scored and reported SEPARATELY (each with
// its own n); they are never pooled into 3n "independent" predictions. Horizons overlap from one
// 5-minute record to the next, so uncertainty is a by-day block bootstrap, not a naive binomial.
// Status stays RESEARCH_ONLY until, for that horizon, n ≥ 200 AND the model beats every baseline
// on balanced accuracy with the 95 % bootstrap interval of the difference above zero AND its Brier
// score is lower than every baseline's. 200 is a minimum checkpoint, not automatic approval.

export const HORIZONS = [15, 30, 60] as const;
export type Horizon = (typeof HORIZONS)[number];
export type Cls = "UP" | "DOWN" | "SIDEWAYS";
export const CLASSES: Cls[] = ["UP", "DOWN", "SIDEWAYS"];
export const OUTCOME_K = 0.5;           // threshold in VIX-implied sigmas
export const LAST_SCORABLE_MIN = 15 * 60 + 20;
export const MIN_N = 200;

export interface PredictionRecord {
  id: string;                    // `${index}|${t}`
  index: string;                 // "NIFTY"
  t: number;                     // epoch sec: close time of the 5-min bar the prediction uses
  loggedAt: number;
  modelVersion: string;
  probs: Record<Cls, number>;    // 0..1, sum 1
  predicted: Cls;
  spot: number;                  // last traded NIFTY at t
  vix: number | null;
  regime: string | null;
  inputs: Record<string, unknown>;      // full input snapshot
  inputAgeSec: Record<string, number | null>;
}
export interface OutcomeRecord { id: string; h: Horizon; end: number; spotEnd: number | null; r: number | null; outcome: Cls | "BEYOND_SESSION" | "NO_DATA"; resolvedAt: number }

const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

export function sigmaH(spot: number, vix: number, h: number): number { return spot * (vix / 100) * Math.sqrt(h / 375) / Math.sqrt(252); }
export function outcomeLabel(r: number, spot: number, vix: number, h: number): Cls {
  const thr = (OUTCOME_K * sigmaH(spot, vix, h)) / spot;
  return r > thr ? "UP" : r < -thr ? "DOWN" : "SIDEWAYS";
}
export function argmaxClass(p: Record<Cls, number>): Cls { return CLASSES.reduce((b, c) => (p[c] > p[b] ? c : b), "SIDEWAYS" as Cls); }

/** Resolve one horizon from 5-min bars ([startTime, close]; a bar closes at start+300). */
export function resolveHorizon(rec: PredictionRecord, h: Horizon, bars: { time: number; close: number }[], nowSec: number): OutcomeRecord | null {
  const end = rec.t + h * 60;
  if (istMin(end) > LAST_SCORABLE_MIN || istDate(end) !== istDate(rec.t)) return { id: rec.id, h, end, spotEnd: null, r: null, outcome: "BEYOND_SESSION", resolvedAt: nowSec };
  if (nowSec < end) return null;                                  // not due yet
  const bar = bars.find((b) => b.time + 300 === end);
  if (!bar) return nowSec > end + 1800 ? { id: rec.id, h, end, spotEnd: null, r: null, outcome: "NO_DATA", resolvedAt: nowSec } : null;
  if (rec.vix == null || !(rec.spot > 0)) return { id: rec.id, h, end, spotEnd: bar.close, r: null, outcome: "NO_DATA", resolvedAt: nowSec };
  const r = bar.close / rec.spot - 1;
  return { id: rec.id, h, end, spotEnd: bar.close, r, outcome: outcomeLabel(r, rec.spot, rec.vix, h), resolvedAt: nowSec };
}

// ---- storage: append-only JSONL per day (survives restarts; DATA_DIR = Render persistent disk) ----
const DIR = path.join(DATA_DIR, "predictions");
const predFile = (d: string) => path.join(DIR, `${d}.jsonl`);
const outFile = (d: string) => path.join(DIR, `${d}.outcomes.jsonl`);
const readJsonl = <T>(f: string): T[] => { try { return fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export function readPredictions(d: string): PredictionRecord[] { return readJsonl<PredictionRecord>(predFile(d)); }
export function readOutcomes(d: string): OutcomeRecord[] { return readJsonl<OutcomeRecord>(outFile(d)); }
export function logPrediction(rec: PredictionRecord): boolean {
  const d = istDate(rec.t);
  if (readPredictions(d).some((p) => p.id === rec.id)) return false;            // one record per candle
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(predFile(d), JSON.stringify(rec) + "\n"); return true; } catch { return false; }
}
/** Resolve every due horizon for a day; appends new outcomes; returns how many were added. */
export function resolveDay(d: string, bars: { time: number; close: number }[], nowSec: number): number {
  const done = new Set(readOutcomes(d).map((o) => `${o.id}|${o.h}`));
  const add: OutcomeRecord[] = [];
  for (const rec of readPredictions(d)) for (const h of HORIZONS) {
    if (done.has(`${rec.id}|${h}`)) continue;
    const o = resolveHorizon(rec, h, bars, nowSec); if (o) add.push(o);
  }
  if (add.length) { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(outFile(d), add.map((o) => JSON.stringify(o)).join("\n") + "\n"); } catch { return 0; } }
  return add.length;
}
export function listDays(): string[] { try { return fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort(); } catch { return []; } }

// ---- evaluation ----
export interface Scored { rec: PredictionRecord; outcome: Cls; r: number; prevOutcome: Cls | null }
export interface HorizonReport {
  h: Horizon; n: number; days: number;
  classCounts: Record<Cls, number>;
  model: { balancedAcc: number; brier: number; precision: Record<Cls, number | null>; recall: Record<Cls, number | null>; falseBreakouts: number; missedMoves: number };
  baselines: Record<"majority" | "alwaysSideways" | "persistence", { balancedAcc: number; brier: number }>;
  edgeVsBest: { diff: number; ci95: [number, number] } | null;
  calibration: { bin: string; n: number; meanProb: number; hitRate: number }[];
  byRegime: Record<string, { n: number; balancedAcc: number }>;
  status: "RESEARCH_ONLY" | "VALIDATED";
  reason: string;
}

const oneHot = (c: Cls): Record<Cls, number> => ({ UP: c === "UP" ? 1 : 0, DOWN: c === "DOWN" ? 1 : 0, SIDEWAYS: c === "SIDEWAYS" ? 1 : 0 });
const brierOf = (p: Record<Cls, number>, y: Cls) => CLASSES.reduce((s, c) => s + (p[c] - (c === y ? 1 : 0)) ** 2, 0);
export function balancedAccuracy(pred: Cls[], truth: Cls[]): number {
  const rec = CLASSES.map((c) => { const idx = truth.map((t, i) => (t === c ? i : -1)).filter((i) => i >= 0); return idx.length ? idx.filter((i) => pred[i] === c).length / idx.length : null; }).filter((x): x is number => x != null);
  return rec.length ? rec.reduce((a, b) => a + b, 0) / rec.length : 0;
}

/** Chronological report for one horizon. `scored` must be sorted by time. Deterministic bootstrap. */
export function evaluate(h: Horizon, scored: Scored[], bootstrapIters = 500): HorizonReport {
  const n = scored.length, truth = scored.map((s) => s.outcome), pred = scored.map((s) => s.rec.predicted);
  // Majority baseline uses ONLY outcomes resolved before each prediction (no look-ahead).
  const seen: Record<Cls, number> = { UP: 0, DOWN: 0, SIDEWAYS: 0 };
  const majority: Cls[] = scored.map((s) => { const m = CLASSES.reduce((b, c) => (seen[c] > seen[b] ? c : b), "SIDEWAYS" as Cls); seen[s.outcome]++; return m; });
  const always: Cls[] = scored.map(() => "SIDEWAYS");
  const persist: Cls[] = scored.map((s) => s.prevOutcome || "SIDEWAYS");
  const brierModel = n ? scored.reduce((a, s) => a + brierOf(s.rec.probs, s.outcome), 0) / n : NaN;
  const brierHard = (p: Cls[]) => (n ? p.reduce((a, c, i) => a + brierOf(oneHot(c), truth[i]), 0) / n : NaN);
  const precision = {} as Record<Cls, number | null>, recall = {} as Record<Cls, number | null>;
  for (const c of CLASSES) {
    const pc = pred.filter((p) => p === c).length, tc = truth.filter((t) => t === c).length, both = pred.filter((p, i) => p === c && truth[i] === c).length;
    precision[c] = pc ? both / pc : null; recall[c] = tc ? both / tc : null;
  }
  const falseBreakouts = pred.filter((p, i) => p !== "SIDEWAYS" && truth[i] !== p).length;
  const missedMoves = pred.filter((p, i) => p === "SIDEWAYS" && truth[i] !== "SIDEWAYS").length;
  const ba = balancedAccuracy(pred, truth);
  const baselines = {
    majority: { balancedAcc: balancedAccuracy(majority, truth), brier: brierHard(majority) },
    alwaysSideways: { balancedAcc: balancedAccuracy(always, truth), brier: brierHard(always) },
    persistence: { balancedAcc: balancedAccuracy(persist, truth), brier: brierHard(persist) },
  };
  const bestKey = (Object.keys(baselines) as (keyof typeof baselines)[]).reduce((b, k) => (baselines[k].balancedAcc > baselines[b].balancedAcc ? k : b), "majority" as keyof typeof baselines);
  const bestPred = bestKey === "majority" ? majority : bestKey === "alwaysSideways" ? always : persist;
  // by-day block bootstrap of (model − best baseline) balanced accuracy
  const dayOf = (s: Scored) => istDate(s.rec.t);
  const days = [...new Set(scored.map(dayOf))];
  let edge: HorizonReport["edgeVsBest"] = null;
  if (n && days.length >= 2) {
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    const idxByDay = days.map((d) => scored.map((s, i) => (dayOf(s) === d ? i : -1)).filter((i) => i >= 0));
    const diffs: number[] = [];
    for (let b = 0; b < bootstrapIters; b++) {
      const idx = Array.from({ length: days.length }, () => idxByDay[Math.floor(rnd() * days.length)]).flat();
      diffs.push(balancedAccuracy(idx.map((i) => pred[i]), idx.map((i) => truth[i])) - balancedAccuracy(idx.map((i) => bestPred[i]), idx.map((i) => truth[i])));
    }
    diffs.sort((a, b) => a - b);
    edge = { diff: ba - baselines[bestKey].balancedAcc, ci95: [diffs[Math.floor(bootstrapIters * 0.025)], diffs[Math.floor(bootstrapIters * 0.975) - 1]] };
  }
  // calibration of the predicted class's probability
  const bins = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1.01]];
  const calibration = bins.map(([lo, hi]) => { const s = scored.filter((x) => { const p = x.rec.probs[x.rec.predicted]; return p >= lo && p < hi; }); return { bin: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: s.length, meanProb: s.length ? s.reduce((a, x) => a + x.rec.probs[x.rec.predicted], 0) / s.length : 0, hitRate: s.length ? s.filter((x) => x.rec.predicted === x.outcome).length / s.length : 0 }; });
  const byRegime: Record<string, { n: number; balancedAcc: number }> = {};
  for (const rg of [...new Set(scored.map((s) => s.rec.regime || "UNKNOWN"))]) { const s = scored.filter((x) => (x.rec.regime || "UNKNOWN") === rg); byRegime[rg] = { n: s.length, balancedAcc: balancedAccuracy(s.map((x) => x.rec.predicted), s.map((x) => x.outcome)) }; }
  const beatsAll = (Object.values(baselines) as { balancedAcc: number; brier: number }[]).every((b) => ba > b.balancedAcc && brierModel < b.brier);
  const validated = n >= MIN_N && beatsAll && !!edge && edge.ci95[0] > 0;
  const reason = n < MIN_N ? `${n} of at least ${MIN_N} scored predictions` : !beatsAll ? "does not beat every baseline on balanced accuracy and Brier score" : !edge || edge.ci95[0] <= 0 ? "edge over the best baseline is not clear of zero (95 % interval)" : "beats every baseline; interval clear of zero";
  const classCounts = { UP: truth.filter((t) => t === "UP").length, DOWN: truth.filter((t) => t === "DOWN").length, SIDEWAYS: truth.filter((t) => t === "SIDEWAYS").length };
  return { h, n, days: days.length, classCounts, model: { balancedAcc: ba, brier: brierModel, precision, recall, falseBreakouts, missedMoves }, baselines, edgeVsBest: edge, calibration, byRegime, status: validated ? "VALIDATED" : "RESEARCH_ONLY", reason };
}

/** Join predictions with outcomes for one horizon, chronologically, with the previous h-move (persistence baseline). */
export function scoredFor(h: Horizon, preds: PredictionRecord[], outs: OutcomeRecord[]): Scored[] {
  const byId = new Map(outs.filter((o) => o.h === h).map((o) => [o.id, o]));
  const sorted = [...preds].sort((a, b) => a.t - b.t);
  const res: Scored[] = [];
  for (const p of sorted) {
    const o = byId.get(p.id); if (!o || o.r == null || !CLASSES.includes(o.outcome as Cls)) continue;
    // persistence: the outcome of the record whose horizon ENDED at (or just before) this prediction's time
    // (same day, window ending within 5 minutes of this prediction — otherwise no persistence call)
    const prev = [...res].reverse().find((s) => istDate(s.rec.t) === istDate(p.t) && s.rec.t + h * 60 <= p.t && p.t - (s.rec.t + h * 60) <= 300);
    res.push({ rec: p, outcome: o.outcome as Cls, r: o.r, prevOutcome: prev ? prev.outcome : null });
  }
  return res;
}

export function report(): Record<string, HorizonReport> {
  const preds: PredictionRecord[] = [], outs: OutcomeRecord[] = [];
  for (const d of listDays()) { preds.push(...readPredictions(d)); outs.push(...readOutcomes(d)); }
  return Object.fromEntries(HORIZONS.map((h) => [String(h), evaluate(h, scoredFor(h, preds, outs))]));
}
