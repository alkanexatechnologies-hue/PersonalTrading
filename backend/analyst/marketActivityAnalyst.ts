import fs from "fs";
import path from "path";
import { readSuggestions, SuggestionRecord, Suggestion, DirResult } from "../advisory/suggestionLog";
import { buildAccuracyReport } from "../advisory/accuracy";
import { loadOiSignalLog, OiSignal } from "../oi/oiCommandLog";
import { istDateStr } from "../util/istTime";

// ===================== Market Activity Analyst (read-only) =====================
// A background REVIEWER. It reads the application's OWN, already-recorded and
// already-resolved activity and rolls it up into one honest daily "application
// strength" report, then stores that report so future sessions can compare.
//
// It creates NO signals, NO trades, NO new strategy. It never re-derives an
// outcome with look-ahead: it only aggregates evaluations the app already made
// from timestamped market data:
//   • data/advisory/suggestions.jsonl  — live suggestions + resolved 5/15/30m
//     observation windows (direction result, spot move, premium move, tradeOutcome,
//     waitEval)  [written from the real OI-Command flow, deduped]
//   • data/oi-command-log.json          — OI signals + 5/15/60m forward evaluation
//     (favMove, correct/wrong/flat), scheduled + evaluated with no look-ahead
//   • data/log/signal-audit-<date>.jsonl — one durable record per emitted signal,
//     carrying data freshness (dataAgeSec) at emit time
// Honesty rules (mirrors advisory/accuracy.ts): NEUTRAL and UNRESOLVED are never
// counted as right or wrong; a rate is null ("NOT RUN") when nothing is decided.

const ANALYST_DIR = path.join(process.cwd(), "data", "analyst");
const DAILY_DIR = path.join(ANALYST_DIR, "daily");
const HISTORY_FILE = path.join(ANALYST_DIR, "history.jsonl");

const PRIMARY_WINDOW = 15; // minutes — the window used for headline accuracy

type Timing = "TIMELY" | "EARLY" | "LATE" | "FALSE" | "NEUTRAL";

export interface RateStat { decided: number; correct: number; pct: number | null; }
export interface MfeMae { avgMfePts: number | null; avgMaePts: number | null; n: number; }

export interface AnalystDailyReport {
  date: string;
  generatedAt: number;
  marketDataSource: string;

  // Volume of activity
  totalSignals: number;          // actionable BUY CE/PE suggestions
  totalWaits: number;            // WAIT / AVOID / NO EDGE decisions
  emittedAuditCount: number;     // rows in signal-audit for the day
  oiSignalCount: number;         // rows in oi-command-log for the day

  // Headline strength
  overallStrength: "STRONG" | "MODERATE" | "WEAK" | "NOT RUN";
  strengthScore: number | null;  // 0..100, null when nothing decided

  // Quality metrics (all from RESOLVED data only)
  accuracySource: "advisory" | "oi-command-15m" | "none"; // where headline accuracy came from
  signalAccuracyPct: number | null;   // correct / (correct+wrong) at PRIMARY_WINDOW
  falseSignalRatePct: number | null;  // actionable that went wrong
  missedMoveRatePct: number | null;   // WAITs that missed a real move
  timing: Record<Timing, number>;     // counts of each timing verdict
  timingRatePct: Record<Timing, number | null>;

  takeQuality: { decided: number; winPct: number | null } & MfeMae;
  waitQuality: { decided: number; correctWaitPct: number | null; missedOpportunity: number };

  avgMfePts: number | null;
  avgMaePts: number | null;
  avgSignalDurationMin: number | null; // approx: first window (min) a signal turned CORRECT

  // Breakdowns
  perIndex: { symbol: string; name: string; signals: number; accuracyPct: number | null; avgMfePts: number | null }[];
  perOption: { optionType: "CE" | "PE"; signals: number; accuracyPct: number | null; avgMfePts: number | null }[];
  oiHorizons: Record<string, { evaluated: number; correct: number; wrong: number; flat: number; winPct: number | null }>;

  // Data quality
  dataQuality: { avgAgeSec: number | null; maxAgeSec: number | null; freshPct: number | null; samples: number };

  // Strike-type learning (from OI signals: strike vs spot at signal time).
  // Honest: reports per-moneyness responsiveness only where enough signals exist;
  // never declares a "best" strike type without sufficient evidence.
  strikePerformance: { moneyness: "ITM" | "ATM" | "OTM"; signals: number; winPct: number | null; avgFavMovePts: number | null }[];
  strikeVerdict: string;

  // Narrative (derived from the metrics above — never fabricated)
  didWell: string[];
  didPoorly: string[];
  missedOpportunities: string[];
  weakOrFalseSignals: string[];
  consistentComponents: string[];
  conflictingComponents: string[];

  // Cross-session (filled by compareWithHistory)
  trend?: { metric: string; today: number | null; trailingAvg: number | null; delta: number | null }[];
  recurringPatterns?: string[];
  // Advisory-only proposals; NEVER auto-applied.
  suggestions?: { observation: string; evidence: string; historicalValidation: string; suggestedChange: string }[];
}

// ---- helpers ----
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number): number | null => (den > 0 ? round1((num / den) * 100) : null);
const isActionable = (s: Suggestion) => s === "BUY CE" || s === "BUY PE";
const isWaitLike = (s: Suggestion) => s === "WAIT" || s === "AVOID" || s === "NO EDGE" || s === "WAIT FOR PULLBACK";

function windowResult(r: SuggestionRecord, minutes: number): DirResult {
  const w = r.windows.find((x) => x.minutes === minutes);
  return w ? w.dirResult : "UNRESOLVED";
}

// Favourable / adverse spot excursion for the suggested side, per window.
// spotMovePts is signed from the signal spot; a CE (UP) profits on +move.
function favAdverse(r: SuggestionRecord): { mfe: number | null; mae: number | null; firstCorrectMin: number | null } {
  const up = r.optionType === "CE";
  let mfe: number | null = null, mae: number | null = null, firstCorrect: number | null = null;
  for (const w of r.windows) {
    if (w.spotMovePts != null) {
      const fav = up ? w.spotMovePts : -w.spotMovePts;
      mfe = mfe == null ? fav : Math.max(mfe, fav);
      mae = mae == null ? fav : Math.min(mae, fav);
    }
    if (firstCorrect == null && w.dirResult === "CORRECT") firstCorrect = w.minutes;
  }
  return { mfe: mfe == null ? null : round1(mfe), mae: mae == null ? null : round1(mae), firstCorrectMin: firstCorrect };
}

// Timing verdict for one actionable, resolved signal, from its windows.
// No look-ahead: uses only the already-resolved 5/15/30m directional results.
function timingVerdict(r: SuggestionRecord): Timing | null {
  const w5 = windowResult(r, 5), w15 = windowResult(r, 15), w30 = windowResult(r, 30);
  const anyDecided = [w5, w15, w30].some((x) => x === "CORRECT" || x === "WRONG");
  if (!anyDecided) return null; // unresolved / all-neutral — not counted
  if (w15 === "WRONG" || (w5 === "WRONG" && w30 !== "CORRECT")) return "FALSE";
  if (w5 === "CORRECT") return "TIMELY";
  // Right eventually, but flat right after the signal → fired ahead of the move.
  if ((w5 === "NEUTRAL" || w5 === "UNRESOLVED") && (w15 === "CORRECT" || w30 === "CORRECT")) return "EARLY";
  if (w30 === "CORRECT") return "LATE";
  return "NEUTRAL";
}

// Read durable signal-audit JSONL for a date → data freshness samples.
function readSignalAuditFreshness(date: string): number[] {
  const file = path.join(process.cwd(), "data", "log", `signal-audit-${date}.jsonl`);
  const ages: number[] = [];
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (const ln of lines) {
      try { const row = JSON.parse(ln); const a = row?.payload?.dataAgeSec; if (typeof a === "number" && a >= 0) ages.push(a); } catch { /* skip */ }
    }
  } catch { /* no file for the day */ }
  return ages;
}

function avg(nums: number[]): number | null {
  const v = nums.filter((n) => typeof n === "number" && isFinite(n));
  return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

/** Optional injected sources (for tests); production reads from the real logs. */
export interface AnalystSources {
  suggestions?: SuggestionRecord[];
  oiSignals?: OiSignal[];
  freshnessAges?: number[];
}

/** Build the daily report for one IST date purely from existing resolved logs. */
export function buildDailyReport(date: string = istDateStr(), sources?: AnalystSources): AnalystDailyReport {
  const all = (sources?.suggestions ?? readSuggestions(5000)).filter((r) => r.istDate === date);
  const actionable = all.filter((r) => isActionable(r.suggestion));
  const waits = all.filter((r) => isWaitLike(r.suggestion));
  const resolvedActionable = actionable.filter((r) => r.resolved);

  // Headline accuracy (reuse the app's own honest aggregator).
  const acc = buildAccuracyReport(all, PRIMARY_WINDOW);
  const signalAccuracyPct = acc.master.accuracyPct;

  // False-signal rate: actionable that resolved WRONG at the primary window,
  // or whose option trade hit the stop / closed a loss.
  let falseDecided = 0, falseBad = 0;
  for (const r of resolvedActionable) {
    const wr = windowResult(r, PRIMARY_WINDOW);
    const bad = wr === "WRONG" || r.tradeOutcome === "STOP_HIT" || r.tradeOutcome === "LOSS";
    const good = wr === "CORRECT" || r.tradeOutcome === "TARGET_HIT";
    if (bad || good) { falseDecided++; if (bad) falseBad++; }
  }
  const falseSignalRatePct = pct(falseBad, falseDecided);

  // Missed-move rate: WAITs that were a missed opportunity.
  const waitDecided = waits.filter((r) => r.waitEval === "CORRECT_WAIT" || r.waitEval === "MISSED_OPPORTUNITY");
  const missed = waitDecided.filter((r) => r.waitEval === "MISSED_OPPORTUNITY");
  const missedMoveRatePct = pct(missed.length, waitDecided.length);
  const correctWaitPct = pct(waitDecided.length - missed.length, waitDecided.length);

  // Timing distribution.
  const timing: Record<Timing, number> = { TIMELY: 0, EARLY: 0, LATE: 0, FALSE: 0, NEUTRAL: 0 };
  let timingTotal = 0;
  for (const r of resolvedActionable) {
    const v = timingVerdict(r);
    if (v) { timing[v]++; timingTotal++; }
  }
  const timingRatePct = Object.fromEntries(
    (Object.keys(timing) as Timing[]).map((k) => [k, pct(timing[k], timingTotal)]),
  ) as Record<Timing, number | null>;

  // MFE / MAE / duration + TAKE win rate.
  const mfes: number[] = [], maes: number[] = [], durations: number[] = [];
  let takeDecided = 0, takeWins = 0;
  for (const r of resolvedActionable) {
    const { mfe, mae, firstCorrectMin } = favAdverse(r);
    if (mfe != null) mfes.push(mfe);
    if (mae != null) maes.push(mae);
    const wr = windowResult(r, PRIMARY_WINDOW);
    if (wr === "CORRECT" || wr === "WRONG") { takeDecided++; if (wr === "CORRECT") takeWins++; }
    if (firstCorrectMin != null) durations.push(firstCorrectMin);
  }

  // Per-index and per-option breakdowns.
  const perIndexMap = new Map<string, SuggestionRecord[]>();
  for (const r of resolvedActionable) { (perIndexMap.get(r.symbol) || perIndexMap.set(r.symbol, []).get(r.symbol)!).push(r); }
  const perIndex = [...perIndexMap.entries()].map(([symbol, rows]) => {
    const a = buildAccuracyReport(rows, PRIMARY_WINDOW);
    const mf = rows.map((r) => favAdverse(r).mfe).filter((x): x is number => x != null);
    return { symbol, name: rows[0]?.name || symbol, signals: rows.length, accuracyPct: a.master.accuracyPct, avgMfePts: avg(mf) };
  }).sort((x, y) => y.signals - x.signals);

  const perOption = (["CE", "PE"] as const).map((ot) => {
    const rows = resolvedActionable.filter((r) => r.optionType === ot);
    const a = buildAccuracyReport(rows, PRIMARY_WINDOW);
    const mf = rows.map((r) => favAdverse(r).mfe).filter((x): x is number => x != null);
    return { optionType: ot, signals: rows.length, accuracyPct: a.master.accuracyPct, avgMfePts: avg(mf) };
  });

  // OI-command horizon roll-up for the day (independent forward evaluator).
  // This is the app's AUTO-evaluated actionable-signal track record (5/15/60m),
  // and is the actionable-accuracy source when advisory outcomes aren't resolved.
  const oiRows: OiSignal[] = (sources?.oiSignals ?? loadOiSignalLog()).filter((r) => r.istDate === date);
  const oiHorizons: AnalystDailyReport["oiHorizons"] = {};
  for (const hz of ["5", "15", "60"] as const) {
    const evald = oiRows.filter((r) => r.h[hz] && r.h[hz].status !== "pending");
    const correct = evald.filter((r) => r.h[hz].status === "correct").length;
    const wrong = evald.filter((r) => r.h[hz].status === "wrong").length;
    const flat = evald.filter((r) => r.h[hz].status === "flat").length;
    oiHorizons[hz] = { evaluated: evald.length, correct, wrong, flat, winPct: pct(correct, correct + wrong) };
  }
  const oiWinPct15 = oiHorizons["15"].winPct; // OI 15m directional win-rate

  // Strike-type performance from the OI signals (strike vs spot at signal time).
  const byMoney: Record<"ITM" | "ATM" | "OTM", OiSignal[]> = { ITM: [], ATM: [], OTM: [] };
  for (const r of oiRows) {
    if (r.strike == null || !(r.spot > 0)) continue;
    const band = r.spot * 0.0015;
    let m: "ITM" | "ATM" | "OTM";
    if (Math.abs(r.strike - r.spot) <= band) m = "ATM";
    else if (r.optionType === "CE") m = r.strike < r.spot ? "ITM" : "OTM";
    else m = r.strike > r.spot ? "ITM" : "OTM";
    byMoney[m].push(r);
  }
  const strikePerformance = (["ITM", "ATM", "OTM"] as const).map((m) => {
    const rows = byMoney[m];
    const evald = rows.filter((r) => r.h["15"] && r.h["15"].status !== "pending");
    const correct = evald.filter((r) => r.h["15"].status === "correct").length;
    const wrong = evald.filter((r) => r.h["15"].status === "wrong").length;
    const favs = evald.map((r) => r.h["15"].favMove).filter((x): x is number => typeof x === "number");
    return { moneyness: m, signals: rows.length, winPct: pct(correct, correct + wrong), avgFavMovePts: avg(favs) };
  });
  // Only call a strike type stronger when it has enough decided signals AND a clear margin.
  const ranked = strikePerformance.filter((s) => s.winPct != null && s.signals >= 5).sort((a, b) => (b.winPct! - a.winPct!));
  const strikeVerdict = ranked.length >= 2 && (ranked[0].winPct! - ranked[ranked.length - 1].winPct!) >= 15
    ? `${ranked[0].moneyness} responded best today (${ranked[0].winPct}% vs ${ranked[ranked.length - 1].moneyness} ${ranked[ranked.length - 1].winPct}%) — needs multi-session confirmation before it's a rule.`
    : "INSUFFICIENT DATA — not enough decided signals to call one strike type best.";
  // Headline accuracy: prefer resolved advisory suggestions; fall back to the OI
  // 15m forward evaluation when no advisory actionable outcome is resolved.
  const accuracySource = signalAccuracyPct != null ? "advisory" : oiWinPct15 != null ? "oi-command-15m" : "none";
  const headlineAccuracyPct = signalAccuracyPct != null ? signalAccuracyPct : oiWinPct15;

  // Data quality from signal-audit freshness.
  const ages = sources?.freshnessAges ?? readSignalAuditFreshness(date);
  const dataQuality = {
    avgAgeSec: avg(ages),
    maxAgeSec: ages.length ? Math.max(...ages) : null,
    freshPct: ages.length ? pct(ages.filter((a) => a <= 10).length, ages.length) : null, // <=10s = fresh
    samples: ages.length,
  };

  // Overall strength score: blends the honest quality signals we actually have,
  // including the OI forward-evaluation as an actionable-accuracy source. A day
  // with no DECIDED trade/WAIT/OI outcome is NOT RUN — data freshness alone must
  // never masquerade as an application-strength verdict.
  const hasDecidedOutcome = headlineAccuracyPct != null || falseSignalRatePct != null || correctWaitPct != null;
  const strengthScore = hasDecidedOutcome
    ? computeStrengthScore({ signalAccuracyPct: headlineAccuracyPct, falseSignalRatePct, missedMoveRatePct, correctWaitPct, dataFreshPct: dataQuality.freshPct })
    : null;
  const overallStrength = strengthScore == null ? "NOT RUN" : strengthScore >= 65 ? "STRONG" : strengthScore >= 45 ? "MODERATE" : "WEAK";

  const report: AnalystDailyReport = {
    date, generatedAt: Math.floor(Date.now() / 1000), marketDataSource: "DHAN",
    totalSignals: actionable.length, totalWaits: waits.length,
    emittedAuditCount: ages.length, oiSignalCount: oiRows.length,
    overallStrength, strengthScore,
    accuracySource,
    signalAccuracyPct: headlineAccuracyPct, falseSignalRatePct, missedMoveRatePct,
    timing, timingRatePct,
    takeQuality: { decided: takeDecided, winPct: pct(takeWins, takeDecided), avgMfePts: avg(mfes), avgMaePts: avg(maes), n: mfes.length },
    waitQuality: { decided: waitDecided.length, correctWaitPct, missedOpportunity: missed.length },
    avgMfePts: avg(mfes), avgMaePts: avg(maes), avgSignalDurationMin: avg(durations),
    perIndex, perOption, oiHorizons, dataQuality,
    strikePerformance, strikeVerdict,
    didWell: [], didPoorly: [], missedOpportunities: [], weakOrFalseSignals: [],
    consistentComponents: [], conflictingComponents: [],
  };
  fillNarrative(report, resolvedActionable, waitDecided, missed, acc);
  // OI forward-evaluation narrative (the actionable track record when advisory
  // outcomes aren't resolved).
  const oi15 = oiHorizons["15"];
  if (oi15.evaluated >= 3) {
    if (oi15.winPct != null && oi15.winPct >= 60) report.didWell.push(`OI signals: ${oi15.winPct}% moved the predicted way by 15m (${oi15.correct}/${oi15.correct + oi15.wrong} decided).`);
    else if (oi15.winPct != null && oi15.winPct < 40) report.didPoorly.push(`OI signals: only ${oi15.winPct}% correct by 15m.`);
  }
  if (accuracySource === "oi-command-15m") report.consistentComponents.push("Headline accuracy is from the OI forward-evaluator; advisory outcomes were not resolved for this date.");
  return report;
}

function computeStrengthScore(m: { signalAccuracyPct: number | null; falseSignalRatePct: number | null; missedMoveRatePct: number | null; correctWaitPct: number | null; dataFreshPct: number | null }): number | null {
  // Weighted blend of only the components that are decided (null ones drop out,
  // weights renormalise). Not a naive average of indicators — it rewards
  // accurate TAKEs and disciplined WAITs and penalises false/missed.
  const parts: { v: number; w: number }[] = [];
  if (m.signalAccuracyPct != null) parts.push({ v: m.signalAccuracyPct, w: 0.4 });
  if (m.falseSignalRatePct != null) parts.push({ v: 100 - m.falseSignalRatePct, w: 0.2 });
  if (m.correctWaitPct != null) parts.push({ v: m.correctWaitPct, w: 0.2 });
  if (m.missedMoveRatePct != null) parts.push({ v: 100 - m.missedMoveRatePct, w: 0.1 });
  if (m.dataFreshPct != null) parts.push({ v: m.dataFreshPct, w: 0.1 });
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum);
}

function fillNarrative(rep: AnalystDailyReport, actionable: SuggestionRecord[], waitDecided: SuggestionRecord[], missed: SuggestionRecord[], acc: ReturnType<typeof buildAccuracyReport>): void {
  const { didWell, didPoorly, missedOpportunities, weakOrFalseSignals, consistentComponents, conflictingComponents } = rep;

  const advDecided = acc.master.correct + acc.master.wrong;
  if (rep.accuracySource === "advisory" && rep.signalAccuracyPct != null && rep.signalAccuracyPct >= 60 && advDecided > 0) didWell.push(`Directional accuracy ${rep.signalAccuracyPct}% at ${PRIMARY_WINDOW}m (${acc.master.correct}/${advDecided} decided).`);
  if (rep.waitQuality.correctWaitPct != null && rep.waitQuality.correctWaitPct >= 70) didWell.push(`WAIT discipline strong: ${rep.waitQuality.correctWaitPct}% of waits correctly avoided a bad entry.`);
  if (rep.takeQuality.avgMfePts != null && rep.takeQuality.avgMfePts > 0) didWell.push(`Average favourable excursion ${rep.takeQuality.avgMfePts} pts on TAKE signals.`);

  if (rep.signalAccuracyPct != null && rep.signalAccuracyPct < 45) didPoorly.push(`Low directional accuracy ${rep.signalAccuracyPct}% at ${PRIMARY_WINDOW}m.`);
  if (rep.falseSignalRatePct != null && rep.falseSignalRatePct >= 50) didPoorly.push(`High false-signal rate ${rep.falseSignalRatePct}%.`);
  if (rep.avgMaePts != null && rep.avgMaePts < -20) didPoorly.push(`Deep adverse excursions (avg MAE ${rep.avgMaePts} pts) — entries taken into drawdown.`);

  if (rep.missedMoveRatePct != null && rep.missedMoveRatePct >= 40) missedOpportunities.push(`${missed.length} WAIT/AVOID decisions missed a real move (${rep.missedMoveRatePct}% of decided waits).`);
  for (const r of missed.slice(0, 3)) missedOpportunities.push(`${r.istTime} ${r.name}: waited but price moved ${r.suggestion === "AVOID" ? "against the avoid" : "in the blocked direction"}.`);

  if (rep.timing.FALSE > 0) weakOrFalseSignals.push(`${rep.timing.FALSE} signals went the wrong way after firing (FALSE).`);
  if (rep.timing.LATE > 0) weakOrFalseSignals.push(`${rep.timing.LATE} signals fired LATE (move already underway).`);

  // Component alignment: compare per-layer accuracy from the app's own report.
  for (const layer of acc.layers) {
    if (layer.accuracyPct != null && (layer.correct + layer.wrong) >= 3) {
      if (layer.accuracyPct >= 60) consistentComponents.push(`${layer.layer} layer aligned with outcome ${layer.accuracyPct}% (${layer.correct}/${layer.correct + layer.wrong}).`);
      else if (layer.accuracyPct < 40) conflictingComponents.push(`${layer.layer} layer diverged from outcome (${layer.accuracyPct}%).`);
    }
  }
  if (!didWell.length && actionable.length) didWell.push("Activity recorded and resolved; not enough decided outcomes to highlight a standout strength.");
}

// ---- persistence + cross-session learning ----
function ensureDirs() { fs.mkdirSync(DAILY_DIR, { recursive: true }); }

export function saveDailyReport(rep: AnalystDailyReport): void {
  ensureDirs();
  fs.writeFileSync(path.join(DAILY_DIR, `${rep.date}.json`), JSON.stringify(rep, null, 2), "utf-8");
  const compact = {
    date: rep.date, generatedAt: rep.generatedAt, strengthScore: rep.strengthScore, overallStrength: rep.overallStrength,
    signalAccuracyPct: rep.signalAccuracyPct, falseSignalRatePct: rep.falseSignalRatePct, missedMoveRatePct: rep.missedMoveRatePct,
    correctWaitPct: rep.waitQuality.correctWaitPct, avgMfePts: rep.avgMfePts, avgMaePts: rep.avgMaePts,
    totalSignals: rep.totalSignals, dataFreshPct: rep.dataQuality.freshPct,
  };
  // One row per date (replace if rebuilt).
  let rows: any[] = [];
  try { rows = fs.readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* first run */ }
  rows = rows.filter((r) => r.date !== rep.date);
  rows.push(compact);
  fs.writeFileSync(HISTORY_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

export function loadHistory(): any[] {
  try { return fs.readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function loadDailyReport(date: string): AnalystDailyReport | null {
  try { return JSON.parse(fs.readFileSync(path.join(DAILY_DIR, `${date}.json`), "utf-8")); } catch { return null; }
}

/** Compare today vs the trailing history and surface recurring patterns + advisory suggestions. */
export function compareWithHistory(rep: AnalystDailyReport, trailingDays = 10): void {
  const hist = loadHistory().filter((r) => r.date < rep.date).slice(-trailingDays);
  const trailingAvg = (key: string): number | null => {
    const vals = hist.map((r) => r[key]).filter((v: any) => typeof v === "number");
    return vals.length ? round1(vals.reduce((a: number, b: number) => a + b, 0) / vals.length) : null;
  };
  rep.trend = ["strengthScore", "signalAccuracyPct", "falseSignalRatePct", "missedMoveRatePct"].map((k) => {
    const today = (rep as any)[k] ?? (k === "strengthScore" ? rep.strengthScore : null);
    const ta = trailingAvg(k);
    return { metric: k, today: today ?? null, trailingAvg: ta, delta: today != null && ta != null ? round1(today - ta) : null };
  });

  rep.recurringPatterns = [];
  rep.suggestions = [];
  // Recurring low CE/PE accuracy over sessions is an advisory flag, not a change.
  const lowAccDays = [...hist, { signalAccuracyPct: rep.signalAccuracyPct }].filter((r) => typeof r.signalAccuracyPct === "number" && r.signalAccuracyPct < 45);
  if (lowAccDays.length >= 3) {
    rep.recurringPatterns.push(`Directional accuracy has been below 45% on ${lowAccDays.length} of the last ${hist.length + 1} sessions.`);
    rep.suggestions.push({
      observation: "Directional signal accuracy is persistently below 45%.",
      evidence: `${lowAccDays.length}/${hist.length + 1} recent sessions under 45% at ${PRIMARY_WINDOW}m.`,
      historicalValidation: "Measured only from resolved, no-look-ahead observation windows in advisory/suggestions.jsonl.",
      suggestedChange: "Human review of the directional entry filter / confidence threshold. NO automatic change is applied.",
    });
  }
  const highMissed = [...hist, { missedMoveRatePct: rep.missedMoveRatePct }].filter((r) => typeof r.missedMoveRatePct === "number" && r.missedMoveRatePct >= 50);
  if (highMissed.length >= 3) {
    rep.recurringPatterns.push(`WAIT decisions missed a real move on ${highMissed.length} recent sessions (>=50%).`);
    rep.suggestions.push({
      observation: "WAIT decisions frequently miss real moves.",
      evidence: `${highMissed.length} recent sessions with missed-move rate >= 50%.`,
      historicalValidation: "From resolved waitEval (CORRECT_WAIT vs MISSED_OPPORTUNITY) only.",
      suggestedChange: "Human review of the WAIT gating (room-to-wall / confirmation strictness). NO automatic change.",
    });
  }
}

/** Build, cross-reference and persist the report for a date. Returns the report. */
export function runDailyReview(date: string = istDateStr()): AnalystDailyReport {
  const rep = buildDailyReport(date);
  compareWithHistory(rep);
  saveDailyReport(rep);
  return rep;
}
