// OI Command trade recommendations — directional (session) + scalp (5–15m).
// Pure scoring/gates on top of computeOiChange + the live chain. Does not place
// live broker orders; Paper Trading consumes the same objects as algo entries.

export type OiDir = "UP" | "DOWN" | "FLAT";

export interface OiTradeInput {
  hasBaseline: boolean;
  stale: boolean;
  dataAgeSec: number;
  oiDirection: OiDir;
  oiConfidence: number;
  oiReasons: string[];
  status: string;
  spot: number;
  atmStrike: number;
  optionType: "CE" | "PE" | "—";
  ltp: number | null;
  strikeOiPct: number | null;
  pricePct: number | null;
  oiHelpful: boolean | null;
  pxHelpful: boolean | null;
  invalidation: number | null;
  support: number | null;
  resistance: number | null;
  expLow: number;
  expHigh: number;
  last5mDir: 1 | -1 | 0; // last 5m close vs prior close
}

export interface OiTradeLeg {
  take: boolean;
  algoReady: boolean; // meets paper auto floor (≥68)
  action: string;
  optionType: "CE" | "PE" | "—";
  strike: number | null;
  ltp: number | null;
  target: number | null;
  stop: number | null;
  confidence: number;
  reasons: string[];
  skipReasons: string[];
  spotTarget: number | null;
  spotStop: number | null;
  expectedMovePct: number;
  horizon: string;
}

export interface OiRecommendations {
  directional: OiTradeLeg;
  scalp: OiTradeLeg;
  algo: { paperAuto: boolean; liveOrders: false; note: string };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const OI_DIR_MIN = 60;       // show TAKE on the tab
export const OI_SCALP_MIN = 50;
export const OI_ALGO_FLOOR = 68;    // matches paper CONFIRM_FLOOR

// expHigh (points, an ATR-derived expected move already computed by the caller)
// relative to spot approximates today's actual volatility. A "normal" day is
// ~0.8% of spot; premium target/stop percentages below scale around that instead
// of applying the same +20%/-12% (directional) or +10%/-6% (scalp) regardless of
// whether today is unusually quiet or unusually violent. Bounded so an extreme
// reading doesn't blow the target/stop out unreasonably.
const BASELINE_EXP_MOVE_PCT = 0.008;
function oiVolMult(p: Pick<OiTradeInput, "spot" | "expHigh">): number {
  const expMovePct = p.spot > 0 ? (p.expHigh || 0) / p.spot : 0;
  if (!expMovePct) return 1;
  return Math.max(0.7, Math.min(1.6, expMovePct / BASELINE_EXP_MOVE_PCT));
}

function roomOk(p: OiTradeInput): { ok: boolean; reason: string } {
  const dir = p.oiDirection === "UP" ? 1 : p.oiDirection === "DOWN" ? -1 : 0;
  if (!dir) return { ok: false, reason: "no OI direction" };
  const wall = dir > 0 ? p.resistance : p.support;
  const need = Math.max(p.expLow || 0, p.spot * 0.001);
  if (wall == null) return { ok: true, reason: "" };
  const room = dir > 0 ? wall - p.spot : p.spot - wall;
  if (room < need) return { ok: false, reason: `OI wall ${wall} too close (room ${r2(room)} pts)` };
  return { ok: true, reason: "" };
}

function commonSkips(p: OiTradeInput): string[] {
  const skip: string[] = [];
  if (!p.hasBaseline) skip.push("no same-day OI baseline yet");
  if (p.stale) skip.push(`chain stale (${p.dataAgeSec}s > 90s)`);
  if (p.oiDirection === "FLAT") skip.push("OI FLAT — WAIT");
  if (p.status.startsWith("AVOID")) skip.push("setup invalidated vs OI wall");
  if (p.ltp == null || !(p.ltp > 0)) skip.push("no live option premium");
  if (p.optionType === "—") skip.push("no CE/PE selected");
  return skip;
}

function scalpConfidence(p: OiTradeInput): number {
  let c = p.oiConfidence;
  if (p.pxHelpful) c += 8;
  if (p.oiHelpful) c += 5;
  const want = p.oiDirection === "UP" ? 1 : p.oiDirection === "DOWN" ? -1 : 0;
  if (want && p.last5mDir === want) c += 7;
  if (want && p.last5mDir === -want) c -= 12;
  return Math.max(0, Math.min(100, Math.round(c)));
}

export function recommendOiTrades(p: OiTradeInput): OiRecommendations {
  const dirSign = p.oiDirection === "UP" ? 1 : p.oiDirection === "DOWN" ? -1 : 0;
  const vm = oiVolMult(p);
  const common = commonSkips(p);
  const room = roomOk(p);

  // ---- Directional (session ATM, +20% / −12%) ----
  const dSkip = [...common];
  if (p.oiConfidence < OI_DIR_MIN) dSkip.push(`OI confidence ${p.oiConfidence} < ${OI_DIR_MIN}`);
  if (!room.ok) dSkip.push(room.reason);
  const dLtp = p.ltp;
  const dTgt = dLtp != null ? r2(dLtp * (1 + 0.20 * vm)) : null;
  const dSl = dLtp != null ? r2(dLtp * (1 - 0.12 * vm)) : null;
  const dTake = dSkip.length === 0;
  const dConf = p.oiConfidence;
  const directional: OiTradeLeg = {
    take: dTake,
    algoReady: dTake && dConf >= OI_ALGO_FLOOR,
    action: dTake ? (p.oiDirection === "UP" ? "BUY ATM CE (directional)" : "BUY ATM PE (directional)") : "NO TRADE — directional",
    optionType: p.optionType,
    strike: dirSign ? p.atmStrike : null,
    ltp: dLtp,
    target: dTgt,
    stop: dSl,
    confidence: dConf,
    reasons: p.oiReasons.slice(0, 4),
    skipReasons: dSkip,
    spotTarget: dirSign ? r2(p.spot + dirSign * p.expHigh) : null,
    spotStop: p.invalidation ?? (dirSign ? r2(p.spot - dirSign * p.expLow) : null),
    expectedMovePct: dLtp && dTgt ? r2(((dTgt - dLtp) / dLtp) * 100) : 0,
    horizon: "Intraday (OI directional)",
  };

  // ---- Scalp (same OI direction, tighter +10% / −6%, needs 5m not against) ----
  const sSkip = [...common];
  const sConf = scalpConfidence(p);
  if (sConf < OI_SCALP_MIN) sSkip.push(`OI-scalp score ${sConf} < ${OI_SCALP_MIN}`);
  if (!room.ok) sSkip.push(room.reason);
  if (p.pxHelpful === false) sSkip.push("premium already falling vs day baseline");
  const want = dirSign;
  if (want && p.last5mDir === -want) sSkip.push("last 5m bar against OI direction");
  if (p.status.startsWith("BOOK")) sSkip.push("move already captured — no fresh scalp");
  const sLtp = p.ltp;
  const sTgt = sLtp != null ? r2(sLtp * (1 + 0.10 * vm)) : null;
  const sSl = sLtp != null ? r2(sLtp * (1 - 0.06 * vm)) : null;
  const sTake = sSkip.length === 0;
  const scalp: OiTradeLeg = {
    take: sTake,
    algoReady: sTake && sConf >= OI_ALGO_FLOOR,
    action: sTake ? (p.oiDirection === "UP" ? "SCALP BUY ATM CE" : "SCALP BUY ATM PE") : "NO SCALP",
    optionType: p.optionType,
    strike: dirSign ? p.atmStrike : null,
    ltp: sLtp,
    target: sTgt,
    stop: sSl,
    confidence: sConf,
    reasons: [
      `OI ${p.oiDirection} score ${p.oiConfidence}`,
      p.last5mDir === want ? "5m bar agrees" : p.last5mDir === 0 ? "5m flat" : "5m against",
      p.pxHelpful ? "premium up vs baseline" : "premium mixed",
      p.oiHelpful ? "strike OI helpful (unwinding)" : "strike OI mixed",
    ],
    skipReasons: sSkip,
    spotTarget: dirSign ? r2(p.spot + dirSign * Math.max(8, p.expLow * 0.45)) : null,
    spotStop: dirSign ? r2(p.spot - dirSign * Math.max(6, p.expLow * 0.35)) : null,
    expectedMovePct: sLtp && sTgt ? r2(((sTgt - sLtp) / sLtp) * 100) : 0,
    horizon: "Scalp (OI model 5–15m)",
  };

  return {
    directional,
    scalp,
    algo: {
      paperAuto: true,
      liveOrders: false,
      note: "Algo uses Paper Trading auto (no live Groww orders). Directional + OI-scalp ideas are injected each paper tick; OI-scalp also retries every ~90s. Paper still requires confidence ≥ 68, cost-aware R:R, and heat caps.",
    },
  };
}

export type ModelDir = "UP" | "DOWN" | "FLAT";
export interface ModelVote {
  key: string;
  name: string;
  dir: ModelDir;
  score: number | null;
  detail: string;
  vsOi: "agree" | "against" | "flat" | "ref";
}
export interface OiCorrelate {
  vwap: number | null;
  vwapPts: number | null;
  adx: number | null;
  consensus: "AGREE" | "MIXED" | "CONFLICT" | "NO EDGE";
  agree: number;
  against: number;
  flat: number;
  models: ModelVote[];
  mondayReady: boolean;
  mondayNotes: string[];
}

function vsOi(oi: ModelDir, dir: ModelDir): ModelVote["vsOi"] {
  if (dir === "FLAT") return "flat";
  if (oi === "FLAT") return "flat";
  return dir === oi ? "agree" : "against";
}

// Phase 3.2 audit (consistency decision, documented here as intentional — kept
// as two separate scorers, not merged): GainzAlgo (options/highProbAlgo.ts's
// evaluateBuyAlgo) enters correlateOiModels below as ONE of six independent
// votes (alongside VWAP, 4-Layer, 5m bar, Futures) that are compared against
// the OI read to produce a read-only "consensus" (AGREE/MIXED/CONFLICT/NO EDGE).
// That consensus does NOT gate paper/engine.ts's tryOpenOption — it only drives
// the WhatsApp alert decision (alerts/paperPing.ts) and the hourly-readiness
// display score (oi/hourlyReady.ts). tradeScore.ts (paper/ext/tradeScore.ts),
// the score that DOES gate entries, never reads GainzAlgo at all.
//
// These answer genuinely different questions: tradeScore is "should THIS engine
// open a position now" (a live risk gate); correlateOiModels is "do independent
// models corroborate the OI read" (a human-facing consensus/alerting signal).
// Merging them would conflate a live entry gate with a diagnostic ensemble
// display, so the coupling stays as two scorers by design.

export function correlateOiModels(p: {
  oiDir: ModelDir;
  oiScore: number;
  hasBaseline: boolean;
  stale: boolean;
  recTake: boolean;
  vwap: number | null;
  spot: number;
  last5mDir: 1 | -1 | 0;
  futBuildup: string | null;
  d4Dir: "Bullish" | "Bearish" | "Neutral" | null;
  d4Score: number | null;
  d4Conf: number | null;
  gainzPass: boolean | null;
  gainzScore: number | null;
  gainzNote: string;
  adx: number | null;
}): OiCorrelate {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const vwapPts = p.vwap != null ? r2(p.spot - p.vwap) : null;
  const vwapDir: ModelDir = p.vwap == null ? "FLAT" : p.spot > p.vwap ? "UP" : p.spot < p.vwap ? "DOWN" : "FLAT";
  const barDir: ModelDir = p.last5mDir > 0 ? "UP" : p.last5mDir < 0 ? "DOWN" : "FLAT";
  const fb = (p.futBuildup || "").toLowerCase();
  const futDir: ModelDir = /long buildup|short covering/.test(fb) ? "UP"
    : /short buildup|long unwinding/.test(fb) ? "DOWN" : "FLAT";
  const d4Dir: ModelDir = p.d4Dir === "Bullish" ? "UP" : p.d4Dir === "Bearish" ? "DOWN" : "FLAT";
  const gainzDir: ModelDir = p.gainzPass == null ? "FLAT" : p.gainzPass ? (p.oiDir === "FLAT" ? "FLAT" : p.oiDir) : "FLAT";

  const models: ModelVote[] = [
    { key: "oi", name: "OI Command", dir: p.oiDir, score: p.oiScore, detail: `score ${p.oiScore}`, vsOi: "ref" },
    { key: "vwap", name: "VWAP", dir: vwapDir, score: null, detail: p.vwap == null ? "no VWAP" : `spot ${vwapPts! >= 0 ? "+" : ""}${vwapPts} vs ${p.vwap}`, vsOi: vsOi(p.oiDir, vwapDir) },
    { key: "d4", name: "4-Layer", dir: d4Dir, score: p.d4Conf, detail: p.d4Dir ? `${p.d4Dir} · score ${p.d4Score ?? "—"} · conf ${p.d4Conf ?? "—"}` : "need 15m+daily", vsOi: vsOi(p.oiDir, d4Dir) },
    { key: "gainz", name: "GainzAlgo v2", dir: gainzDir, score: p.gainzScore, detail: p.gainzNote, vsOi: p.gainzPass == null ? "flat" : (p.gainzPass ? "agree" : "against") },
    { key: "bar5m", name: "5m bar", dir: barDir, score: null, detail: barDir === "FLAT" ? "last 5m flat" : `last 5m ${barDir}`, vsOi: vsOi(p.oiDir, barDir) },
    { key: "fut", name: "Futures", dir: futDir, score: null, detail: p.futBuildup || "—", vsOi: vsOi(p.oiDir, futDir) },
  ];

  const others = models.filter((m) => m.key !== "oi");
  const agree = others.filter((m) => m.vsOi === "agree").length;
  const against = others.filter((m) => m.vsOi === "against").length;
  const flat = others.filter((m) => m.vsOi === "flat").length;
  let consensus: OiCorrelate["consensus"] = "NO EDGE";
  if (p.oiDir !== "FLAT") {
    if (against === 0 && agree >= 2) consensus = "AGREE";
    else if (against >= 2) consensus = "CONFLICT";
    else consensus = "MIXED";
  }

  const mondayNotes: string[] = [];
  if (!p.hasBaseline) mondayNotes.push("wait for first chain (OI baseline)");
  if (p.stale) mondayNotes.push("chain stale >90s");
  if (p.oiDir === "FLAT") mondayNotes.push("OI FLAT — no edge to test yet");
  if (p.oiDir !== "FLAT" && !p.recTake) mondayNotes.push("OI has direction but rec is NO TRADE");
  if (consensus === "AGREE" && p.recTake) mondayNotes.push("models agree with OI — log the paper/live result");
  const mondayReady = p.hasBaseline && !p.stale && p.oiDir !== "FLAT";

  return {
    vwap: p.vwap, vwapPts, adx: p.adx, consensus, agree, against, flat, models, mondayReady, mondayNotes,
  };
}

export interface OiWall {
  strike: number;
  oi: number;
  side: "CE" | "PE";
}
export interface OiLadderRow {
  strike: number;
  ceOi: number;
  peOi: number;
  ceShare: number;
  peShare: number;
  atm: boolean;
}
export interface OiWallBoard {
  bestR: OiWall | null;
  bestS: OiWall | null;
  immR: OiWall | null;
  immS: OiWall | null;
  maxPain: number | null;
  callPct: number;
  putPct: number;
  feverSide: "CALL" | "PUT" | "EVEN";
  fever: string;
  totCe: number;
  totPe: number;
  ladder: OiLadderRow[];
}

export function buildOiWalls(rows: any[], spot: number, atm: number, maxPain: number | null): OiWallBoard {
  const sorted = (rows || []).slice().sort((a: any, b: any) => a.strike - b.strike);
  const above = sorted.filter((r: any) => r.strike > spot);
  const below = sorted.filter((r: any) => r.strike < spot);
  const asR = (r: any): OiWall | null => r ? { strike: r.strike, oi: Math.round(r.ceOi || 0), side: "CE" } : null;
  const asS = (r: any): OiWall | null => r ? { strike: r.strike, oi: Math.round(r.peOi || 0), side: "PE" } : null;
  const immR = asR(above[0] || null);
  const immS = asS(below.length ? below[below.length - 1] : null);
  const bestR = asR([...above].sort((a: any, b: any) => (b.ceOi || 0) - (a.ceOi || 0))[0] || null);
  const bestS = asS([...below].sort((a: any, b: any) => (b.peOi || 0) - (a.peOi || 0))[0] || null);
  const near = sorted
    .slice()
    .sort((a: any, b: any) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm))
    .slice(0, 11)
    .sort((a: any, b: any) => b.strike - a.strike);
  const ladder: OiLadderRow[] = near.map((r: any) => {
    const ce = Math.round(r.ceOi || 0);
    const pe = Math.round(r.peOi || 0);
    const tot = ce + pe || 1;
    return {
      strike: r.strike,
      ceOi: ce,
      peOi: pe,
      ceShare: Math.round((ce / tot) * 100),
      peShare: Math.round((pe / tot) * 100),
      atm: r.strike === atm,
    };
  });
  const totCe = ladder.reduce((s, x) => s + x.ceOi, 0);
  const totPe = ladder.reduce((s, x) => s + x.peOi, 0);
  const tot = totCe + totPe || 1;
  const callPct = Math.round((totCe / tot) * 100);
  const putPct = 100 - callPct;
  let feverSide: OiWallBoard["feverSide"] = "EVEN";
  let fever = `Balanced CE/PE around ATM · CALL ${callPct}% / PUT ${putPct}%`;
  if (putPct >= 55) {
    feverSide = "PUT";
    fever = `PUT fever ${putPct}% — PE writers at support (bullish bias)`;
  } else if (callPct >= 55) {
    feverSide = "CALL";
    fever = `CALL fever ${callPct}% — CE writers at resistance (bearish bias)`;
  }
  return { bestR, bestS, immR, immS, maxPain, callPct, putPct, feverSide, fever, totCe, totPe, ladder };
}

export interface LessonCandle {
  pattern: string;
  bias: 1 | -1 | 0;
  strength: number;
  reason: string;
  tf: "5m" | "15m";
}
export interface OiLesson {
  blink: boolean;
  kind: "DIRECTIONAL" | "SCALP" | "WATCH";
  live: boolean;
  strike: number | null;
  side: string;
  stopLoss: number | null;
  stopHigh: number | null;
  spotStop: number | null;
  spotHigh: number | null;
  mode: "PAY_CHANCE" | "REVERSE_RISK" | "UNCLEAR";
  modeLabel: string;
  scenario: string;
  stopWhy: string;
  candleNote: string;
  c5: LessonCandle;
  c15: LessonCandle;
}

export function buildOiLesson(p: {
  oiDir: OiDir;
  rec: OiRecommendations;
  walls: OiWallBoard;
  plan: any;
  corr: OiCorrelate;
  adx: number | null;
  capturedPct: number;
  hasBaseline: boolean;
  stale: boolean;
  positions: any[];
  c5: LessonCandle;
  c15: LessonCandle;
}): OiLesson {
  const dir = p.rec?.directional;
  const sc = p.rec?.scalp;
  const livePos = p.positions || [];
  const live = livePos.length > 0;
  const scalpLive = livePos.some((x) => x.scalp);
  const kind: OiLesson["kind"] = live
    ? (scalpLive ? "SCALP" : "DIRECTIONAL")
    : sc?.take && !dir?.take ? "SCALP"
    : dir?.take ? "DIRECTIONAL"
    : "WATCH";
  const blink = live || !!(dir?.take || sc?.take);
  const use = livePos[0]
    ? { strike: livePos[0].strike, side: livePos[0].optionType || "—", stop: livePos[0].stop, high: livePos[0].high, ltp: livePos[0].last }
    : (kind === "SCALP" && sc?.take ? sc : dir);
  const want = p.oiDir === "UP" ? 1 : p.oiDir === "DOWN" ? -1 : 0;
  let pay = 0, rev = 0;
  if (p.oiDir !== "FLAT") pay += 1; else rev += 1;
  if (p.corr?.consensus === "AGREE") pay += 2;
  else if (p.corr?.consensus === "CONFLICT") rev += 2;
  else if (p.corr?.consensus === "MIXED") rev += 1;
  if (p.adx != null && p.adx >= 20) pay += 1;
  else if (p.adx != null && p.adx < 16) rev += 1;
  if (want && p.c5?.bias === want) pay += 1;
  else if (want && p.c5?.bias === -want && (p.c5.strength || 0) >= 0.6) rev += 2;
  if (p.c5?.pattern === "Doji") rev += 1;
  if (/Star|Engulfing|Shooting|Hammer/.test(p.c15?.pattern || "") && want && p.c15.bias === -want) rev += 1;
  if ((p.capturedPct || 0) >= 80) rev += 1;
  if (p.stale) rev += 1;
  if (!p.hasBaseline) rev += 1;
  const nearWall = p.oiDir === "UP" && p.walls?.immR && p.plan?.takeSpot
    ? p.walls.immR.strike - p.plan.takeSpot < (p.plan.takeSpot * 0.0015)
    : p.oiDir === "DOWN" && p.walls?.immS && p.plan?.takeSpot
      ? p.plan.takeSpot - p.walls.immS.strike < (p.plan.takeSpot * 0.0015)
      : false;
  if (nearWall) rev += 1;
  let mode: OiLesson["mode"] = "UNCLEAR";
  if (pay >= rev + 2 && p.oiDir !== "FLAT") mode = "PAY_CHANCE";
  else if (rev >= pay + 1) mode = "REVERSE_RISK";
  const modeLabel = mode === "PAY_CHANCE"
    ? "Pay chance — edge lined up (not a guarantee)"
    : mode === "REVERSE_RISK"
      ? "Reverse risk — protect; move can fail"
      : "Unclear — wait; no insured direction";

  const side = (use as any)?.optionType || (use as any)?.side || p.plan?.side || "—";
  const strike = (use as any)?.strike ?? p.plan?.strike ?? null;
  const stopLoss = (use as any)?.stop ?? (use as any)?.stopLoss ?? p.plan?.lowOpt ?? null;
  const stopHigh = (use as any)?.high ?? (use as any)?.target ?? p.plan?.highOpt ?? null;

  const scenario = live
    ? `Paper ${kind === "SCALP" ? "scalp" : "directional"} position is OPEN on ${strike ?? "—"} ${side}. System is managing with a premium stop-loss and a stop-high (target). This is simulated paper, not a live broker order.`
    : dir?.take || sc?.take
      ? `System identified a ${kind === "SCALP" ? "5–15m scalp" : "session directional"} setup: ATM ${strike ?? "—"} ${side} because OI is ${p.oiDir} and models are ${p.corr?.consensus || "—"}. Strike is ATM so delta stays useful if the index actually moves.`
      : `No position. OI is ${p.oiDir}. System waits until baseline + fresh chain + TAKE + model agreement. Education: sitting out is also a decision.`;

  const stopWhy = side === "CE"
    ? `CE stop-loss (low): option premium cut (~12% directional / ~6% scalp) AND spot through PUT wall ${p.walls?.bestS?.strike ?? p.plan?.lowSpot ?? "—"} — that says buyers lost the support auction. Stop-high: premium target (~+20% / +10%) AND spot toward CALL wall ${p.walls?.bestR?.strike ?? p.plan?.highSpot ?? "—"} where CE writers typically cap the rally.`
    : side === "PE"
      ? `PE stop-loss (low on P&L): premium cut AND spot through CALL wall ${p.walls?.bestR?.strike ?? p.plan?.highSpot ?? "—"} — that says sellers lost the resistance auction. Stop-high: premium target AND spot toward PUT wall ${p.walls?.bestS?.strike ?? p.plan?.lowSpot ?? "—"}.`
      : `Stops are not armed until CE or PE is selected. When armed: stop-loss is the invalidation (OI wall + premium heat); stop-high is the measured target from ATR / OI expected move — a plan, not a promise.`;

  const c5 = p.c5 || { pattern: "None", bias: 0 as const, strength: 0, reason: "no 5m", tf: "5m" as const };
  const c15 = p.c15 || { pattern: "None", bias: 0 as const, strength: 0, reason: "no 15m", tf: "15m" as const };
  const candleNote = `5m ${c5.pattern} (${c5.reason}) · 15m ${c15.pattern} (${c15.reason}). A candle does NOT insure the next tick. It only shows who won the last auction. Strong (engulfing / star / marubozu) can support a bias; doji / opposite star = reversal warning. Combine with OI — never the candle alone. Education, not a signal to skip the stop.`;

  return {
    blink, kind, live, strike, side,
    stopLoss, stopHigh,
    spotStop: p.plan?.lowSpot ?? null,
    spotHigh: p.plan?.highSpot ?? null,
    mode, modeLabel, scenario, stopWhy, candleNote, c5, c15,
  };
}
