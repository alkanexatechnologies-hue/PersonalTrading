// ============================================================================
// THE ARBITER — the single source of truth for an index trading decision.
//
//   closed 5m candles ─→ regime (context) ─→ setup candidates (S1, S2)
//      ─→ timing state ─→ evidence/EV gate ─→ option quality ─→ ONE FinalAction
//
// S1 = the Test Lab scorer (testlab/engine.runEngine, imported read-only — the
//      lab is not modified) in SPOT_DIRECTION mode: the only logic positive in
//      both replay periods. S2 = the Breakout Engine state machine.
// Early Move A/B, OI, breakout context are FEATURES — they never set the action.
//
// Closed-candle safety: every setup reads closed candles only. S1's entry is the
// NEXT candle's open, so the forming candle is passed to S1 ONLY so its (already
// final) open price can be the entry; its high/low/close never reach a decision.
// ============================================================================

import { Candle, OiAnalysis } from "../types";
import { runEngine } from "../testlab/engine";
import { defaultConfig } from "../testlab/config";
import { runSession, TradePlan } from "../signals/breakoutEngine";
import { buildOptionPlan } from "../signals/breakoutOption";
import { tradeFriction } from "../paper/engine";
import { regimeAt, sessionPhase, istMin } from "./regime";
import { biasShiftAt } from "./biasShift";
import { evaluateEvidence, setupEligible, LATE_ENTRY_CUTOFF_MIN } from "./evidence";
import {
  Decision, DECISION_TF, DECISION_VERSION, TRADING_END_MIN, FinalAction, OptionLeg, SetupCandidate, SpotPlan, TimingState,
} from "./types";

export const OPTION_NET_RR_MIN = 1.3;   // same floor the paper engine enforces (paper/engine.ts OPT_RR_MIN)
export const TIME_EXIT_BARS = 12;       // S1 evidence: time exits after 12 bars carried most of its edge
const SESSION_EXIT_MIN = TRADING_END_MIN;

const r2 = (n: number) => Math.round(n * 100) / 100;
const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istIso = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 16).replace("T", " ") + " IST";

export interface ArbiterInput {
  index: string;                    // NIFTY / BANKNIFTY / FINNIFTY / SENSEX / MIDCPNIFTY
  symbol: string;                   // ^NSEI …
  name: string;
  nseSymbol: string;
  lotSize: number | null;
  candles: Candle[];                // 5m, may end with the still-forming candle
  nowSec: number;
  marketOpen: boolean;
  dataStatus: string;               // LIVE / DELAYED / STALE / DISCONNECTED
  dailyAtr: number | null;
  oiChain: OiAnalysis | null;
  chainStale: boolean;
  features?: Record<string, any>;  // evidence-only context (Early Move, OI, …)
  hold?: Decision["hold"] & { plan: SpotPlan; setup: string; direction: "BULLISH" | "BEARISH"; triggerLevel: number | null } | null;
  lookupOption: (underlying: string, type: "CE" | "PE", strike: number, expiry: string) => Promise<{ securityId: string; exchangeSegment: string; instrument: string } | null>;
  getNextExpiryChain?: () => Promise<OiAnalysis | null>;   // only called when the nearest expiry is < MIN_DTE days away
}

// ---------------- S1: Test Lab scorer ----------------
function s1Candidate(index: string, closed: Candle[], forming: Candle | null): SetupCandidate | null {
  const n = closed.length;
  if (n < 40) return null;
  const today = istDate(closed[n - 1].time);
  let start = n - 1;
  while (start > 0 && istDate(closed[start - 1].time) === today) start--;
  const series = forming ? [...closed, forming] : closed;   // forming only provides the next OPEN
  const key = (["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"].includes(index) ? index : "NIFTY") as any;
  const cfg: any = { ...defaultConfig(key, "5m"), dataMode: "SPOT_DIRECTION" };
  const out = runEngine({
    config: cfg, candles: series, oi: series.map(() => null), oiStatus: "UNAVAILABLE", vwapSource: "SPOT", symbol: index,
    binding: { underlying: index, futuresSymbol: null, securityId: null, expiry: null, exchangeSegment: null, lotSize: null, status: "UNAVAILABLE_HISTORICAL", bindingReason: "spot (arbiter S1)" },
    expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), warmupCount: start,
  });
  const row = out.rows.find((r) => r.timestamp === closed[n - 1].time);
  if (!row) return null;
  const lean = row.buyScore >= cfg.buyThreshold && row.buyScore >= row.sellScore + 10 ? "BULLISH"
    : row.sellScore >= cfg.sellThreshold && row.sellScore >= row.buyScore + 10 ? "BEARISH" : null;
  const dir = lean ?? (row.buyScore >= row.sellScore ? "BULLISH" : "BEARISH");
  const ev = [`buy ${row.buyScore} / sell ${row.sellScore} (needs ${cfg.buyThreshold} + 10 lead)`,
    `trend ${row.components.trend} · structure ${row.structureState} (${row.bos}) · volume ${row.volumeState} · UT ${row.utState} · VWAP ${row.vwap}`];
  let state: TimingState = "NONE", block: string | null = null, plan: SpotPlan | null = null;
  if (row.signal === "BUY" || row.signal === "SELL") {
    state = "ENTRY_READY";
    const risk = Math.abs((row.entry ?? 0) - (row.stopLoss ?? 0)), reward = Math.abs((row.target1 ?? 0) - (row.entry ?? 0));
    plan = { entry: row.entry!, stopLoss: row.stopLoss!, target1: row.target1!, target2: row.target2 ?? null,
      risk: r2(risk), reward: r2(reward), rr: row.rr ?? (risk > 0 ? r2(reward / risk) : 0),
      slReason: row.signal === "BUY" ? `Support ${row.support} − 0.5 ATR` : `Resistance ${row.resistance} + 0.5 ATR`,
      targetReason: row.signal === "BUY" ? `Nearest resistance ${row.resistance} (or 2.5 ATR)` : `Nearest support ${row.support} (or 2.5 ATR)` };
    if (istMin(closed[n - 1].time) >= LATE_ENTRY_CUTOFF_MIN) { state = "INVALID"; block = "After 14:00 — S1 entries lost in both replay periods"; }
  } else if (lean) {
    const g = row.hardGateReason;
    state = g === "FAKE MOVE" ? "FAILED" : g === "EXTENDED MOVE" ? "EXTENDED" : g === "R:R BELOW MIN" || g === "NO EXECUTABLE CANDLE" ? "CONFIRMED" : "INVALID";
    block = g === "NO EXECUTABLE CANDLE" ? "Confirmed on the closed candle — waiting for the next candle's open (entry price)"
      : g === "R:R BELOW MIN" ? "R:R below 2 to the nearest obstacle (S1 rule)"
      : g === "FAKE MOVE" ? "Fake-move candle (poke and close back) — S1 rule"
      : g === "EXTENDED MOVE" ? "Price > 3 ATR from EMA9 — extended (S1 rule)"
      : g === "LATE CUTOFF" ? "After 14:30 (S1 rule)" : `${g || "gate"} (S1 rule)`;
  } else if (Math.max(row.buyScore, row.sellScore) >= 45) {
    state = "WATCH"; block = "Score building but below threshold / lead";
  }
  return {
    setup: "S1_MOMENTUM", label: "Momentum continuation", direction: dir, state,
    triggerLevel: dir === "BULLISH" ? row.resistance : row.support, triggerLabel: dir === "BULLISH" ? "S1 nearest resistance" : "S1 nearest support",
    invalidation: plan ? plan.stopLoss : (dir === "BULLISH" ? row.support : row.resistance),
    plan, evidence: ev, blockReason: block, production: setupEligible("S1_MOMENTUM", index),
  };
}

// ---------------- S2: Breakout Engine ----------------
function s2Candidate(index: string, closed: Candle[], nowSec: number): { cand: SetupCandidate | null; live: any } {
  const res = runSession(closed, { intervalSec: 300 });
  const L = res.latest;
  if (!L) return { cand: null, live: null };
  const map: Record<string, TimingState> = {
    "BUY": "ENTRY_READY", "SELL": "ENTRY_READY", "BUY CONFIRMED": "CONFIRMED", "SELL CONFIRMED": "CONFIRMED",
    "WAIT FOR PULLBACK": "EXTENDED", "WAIT FOR BREAKOUT": "WATCH", "WAIT FOR SUPPORT BREAK": "WATCH",
    "BUY BIAS": "WATCH", "SELL BIAS": "WATCH", "AVOID": "INVALID", "NO EDGE": "NONE", "HOLD": "NONE",
  };
  let state = map[L.state] ?? "NONE";
  if (L.breakoutStatus === "FALSE BREAK") state = "FAILED";
  const dir: "BULLISH" | "BEARISH" = L.state.startsWith("SELL") || L.state === "WAIT FOR SUPPORT BREAK" || L.bias.direction === "BEARISH" ? "BEARISH" : "BULLISH";
  const p = L.plan;
  const plan: SpotPlan | null = p ? { entry: p.entry, stopLoss: p.stopLoss, target1: p.target1, target2: p.target2, risk: p.risk, reward: p.reward, rr: p.rr, slReason: p.slReason, targetReason: p.targetReason } : null;
  return {
    cand: {
      setup: "S2_BREAKOUT", label: "Level breakout / breakdown", direction: dir, state,
      triggerLevel: L.triggerLevel, triggerLabel: L.triggerLabel, invalidation: p ? p.stopLoss : null,
      plan: state === "ENTRY_READY" || state === "CONFIRMED" ? plan : null,
      evidence: [L.reason, `bias ${L.bias.direction} B${L.bias.buyScore}/S${L.bias.sellScore}`],
      blockReason: L.rrBlockReason || L.rejectionReason || (state === "WATCH" ? "Waiting for a closed-candle break of the level" : null),
      production: setupEligible("S2_BREAKOUT", index),
    },
    live: { s2State: L.state, s2Trigger: L.triggerLevel, atr: L.atr },
  };
}

// ---------------- expiry choice ----------------
// The holding horizon is ~1 hour (S1 evidence: 12-bar time exit). An option that
// expires today or tomorrow carries expiry-day gamma / overnight theta risk the
// evidence never measured, so the NEXT expiry is used (fetched only at this point,
// i.e. only when a trade is actually being considered). If it cannot be loaded → WAIT.
export const MIN_DTE = 2;
async function pickExpiryChain(inp: ArbiterInput): Promise<{ oi: OiAnalysis | null; reason: string | null; note: string | null }> {
  const oi = inp.oiChain;
  if (!oi || !oi.available || !oi.expiry) return { oi, reason: null, note: null };
  const dte = Math.round((Date.parse(oi.expiry + "T00:00:00Z") - Date.parse(istDate(inp.nowSec) + "T00:00:00Z")) / 86400000);
  if (dte >= MIN_DTE) return { oi, reason: null, note: null };
  if (!inp.getNextExpiryChain) return { oi: null, reason: `Nearest expiry ${oi.expiry} is ${dte} day(s) away and the next expiry chain is unavailable`, note: null };
  const nx = await inp.getNextExpiryChain().catch(() => null);
  if (!nx || !nx.available) return { oi: null, reason: `Nearest expiry ${oi.expiry} is ${dte} day(s) away; next expiry chain could not be loaded`, note: null };
  return { oi: nx, reason: null, note: `Using next expiry ${nx.expiry} (nearest ${oi.expiry} is ${dte} day(s) away)` };
}

// ---------------- option quality ----------------
async function optionLeg(inp: ArbiterInput, dir: "BULLISH" | "BEARISH", plan: SpotPlan): Promise<{ leg: OptionLeg; costR: number | null }> {
  const tp: TradePlan = {
    dir: dir === "BULLISH" ? "BUY" : "SELL", entry: plan.entry, stopLoss: plan.stopLoss, target1: plan.target1, target2: plan.target2,
    risk: plan.risk, reward: plan.reward, rr: plan.rr, slReason: plan.slReason, targetReason: plan.targetReason, target2Reason: null,
    trigger: plan.entry, triggerLabel: "", triggerType: dir === "BULLISH" ? "RESISTANCE BREAKOUT" : "SUPPORT BREAKDOWN", obstacles: [],
  };
  const chain = await pickExpiryChain(inp);
  if (!chain.oi) {
    const leg0: OptionLeg = { available: false, side: dir === "BULLISH" ? "CE" : "PE", strike: null, expiry: null, securityId: null, verified: false, ltp: null, entry: null, stopLoss: null, target1: null, target2: null, risk: null, reward: null, rr: null, costPerUnit: null, netRR: null, delta: null, iv: null, oi: null, volume: null, liquidity: null, why: null, reason: chain.reason };
    return { leg: leg0, costR: null };
  }
  const pre = buildOptionPlan(tp, chain.oi, { name: inp.name, stale: inp.chainStale, rrMin: 0 });
  let securityId: string | null = null, detail = "";
  if (pre.strike != null && pre.expiry) {
    try {
      const m = await inp.lookupOption(inp.nseSymbol, pre.side, pre.strike, pre.expiry);
      securityId = m ? String(m.securityId) : null;
      detail = m ? `instrument master ${m.exchangeSegment}` : "not in instrument master";
    } catch { detail = "instrument master lookup failed"; }
  }
  const op = buildOptionPlan(tp, chain.oi, { name: inp.name, stale: inp.chainStale, securityId, securityDetail: detail, rrMin: 0 });
  const row = op.candidates.find((c) => c.strike === op.strike);
  let why: string | null = null;
  let costPerUnit: number | null = null, netRR: number | null = null, costR: number | null = null;
  if (op.available && op.entry != null && op.risk != null && op.reward != null && inp.lotSize) {
    const lot = inp.lotSize;
    costPerUnit = r2(tradeFriction("indexOption", op.entry * lot, op.entry * lot) / lot);
    netRR = r2((op.reward - costPerUnit) / (op.risk + costPerUnit));
    costR = op.risk > 0 ? costPerUnit / op.risk : null;
  }
  let reason: string | null = op.reason;
  if (chain.note && !reason) why = chain.note;
  if (!reason && !inp.lotSize) reason = "Lot size unknown — cannot cost the trade";
  if (!reason && netRR != null && netRR < OPTION_NET_RR_MIN) reason = `Option R:R after costs 1:${netRR} < 1:${OPTION_NET_RR_MIN}`;
  const leg: OptionLeg = {
    available: op.available, side: op.side, strike: op.strike, expiry: op.expiry, securityId: op.securityId, verified: !!op.identity?.verified,
    ltp: op.optionLtp, entry: op.entry, stopLoss: op.stopLoss, target1: op.target1, target2: op.target2,
    risk: op.risk, reward: op.reward, rr: op.rr, costPerUnit, netRR,
    delta: op.delta, iv: op.iv, oi: op.oi, volume: op.volume, liquidity: row?.assessment ?? null, why: why ?? op.why, reason,
  };
  return { leg, costR };
}

// ---------------- the arbiter ----------------
export async function arbitrate(inp: ArbiterInput): Promise<Decision> {
  // Index movement in candles that start at/after 15:15 is ignored (trader's day ends 15:15).
  const all = inp.candles.filter((c) => istMin(c.time) < TRADING_END_MIN);
  const lastC = all[all.length - 1];
  const formingNow = !!lastC && lastC.time + 300 > inp.nowSec && istDate(lastC.time) === istDate(inp.nowSec) && istMin(inp.nowSec) < TRADING_END_MIN;
  const closed = formingNow ? all.slice(0, -1) : all;
  const forming = formingNow ? lastC : null;
  const c = closed[closed.length - 1] || null;
  const phase = sessionPhase(istMin(inp.nowSec));
  const expiryDay = !!(inp.oiChain?.expiry && inp.oiChain.expiry === istDate(inp.nowSec));
  const base: Decision = {
    version: DECISION_VERSION, key: `${inp.index}|${DECISION_TF}|${c ? c.time : 0}`,
    index: inp.index, symbol: inp.symbol, timeframe: DECISION_TF,
    candleTime: c ? c.time : null, candleIso: c ? istIso(c.time) : null, candleClosed: true, decidedAt: inp.nowSec,
    dataStatus: inp.marketOpen ? inp.dataStatus : "CLOSED", sessionPhase: phase, expiryDay,
    regime: null, regimeEvidence: [], volatility: { atr: null, atrRatio: null, state: "—" },
    direction: "NEUTRAL", setup: null, setupLabel: null, setupState: "NONE",
    trigger: { level: null, label: null, status: "—" }, spot: c ? c.close : null,
    plan: null, option: null, evidence: null, invalidation: null, candidates: [], features: inp.features || {}, bias: null,
    finalAction: "WAIT", reason: "", rejection: null, hold: null, live: null,
  };
  if (!c || closed.length < 40) return { ...base, finalAction: "AVOID", reason: "Not enough closed 5m candles", rejection: "INSUFFICIENT DATA" };

  // Regime (context)
  const rg = regimeAt(closed, inp.dailyAtr);
  base.regime = rg.regime; base.regimeEvidence = rg.evidence;
  base.volatility = { atr: rg.atr != null ? r2(rg.atr) : null, atrRatio: rg.atrRatio, state: rg.atrRatio == null ? "—" : rg.atrRatio >= 1.4 ? "EXPANDING" : rg.atrRatio < 0.85 ? "COMPRESSED" : "NORMAL" };

  // Market Bias Shift (context + entry permission). Replay Apr–Jul and Aug–Oct 2026:
  // S1 trades taken AGAINST this state averaged −0.053R / −0.032R (with-bias +0.302R
  // / +0.104R), so entries the state forbids are refused. It never creates a trade.
  try { base.bias = biasShiftAt(closed); } catch { base.bias = null; }

  // Setups (evidence for every state, even when no trade is possible)
  const s1 = s1Candidate(inp.index, closed, forming);
  const s2r = s2Candidate(inp.index, closed, inp.nowSec);
  base.candidates = [s1, s2r.cand].filter(Boolean) as SetupCandidate[];

  // Forming-candle context (informational only — never an action)
  if (forming && s2r.cand && s2r.cand.triggerLevel != null) {
    const L = s2r.cand.triggerLevel, a = s2r.live?.atr || 0, bull = s2r.cand.direction === "BULLISH";
    const beyond = bull ? forming.close > L + 0.1 * a : forming.close < L - 0.1 * a;
    const poked = bull ? forming.high > L : forming.low < L;
    const near = Math.abs(forming.close - L) <= 0.5 * a;
    base.live = { formingTime: forming.time, formingClose: forming.close, s2Trigger: L,
      state: beyond ? "CONFIRMING" : poked ? "ATTEMPT" : near ? "PRE_MOVE" : "—",
      note: "Forming candle — context only; a decision needs the candle to CLOSE" };
  }

  // 1) data / session gates
  if (inp.marketOpen && (inp.dataStatus === "STALE" || inp.dataStatus === "DISCONNECTED")) {
    return { ...base, finalAction: "AVOID", reason: `Data ${inp.dataStatus} — no live decision`, rejection: "DATA" };
  }
  // 2) open position → HOLD until a closed-candle exit (managed by the service)
  if (inp.hold) {
    const h = inp.hold;
    return { ...base, finalAction: "HOLD", direction: h.direction, setup: h.setup as any, setupLabel: h.setup, setupState: "ENTRY_READY",
      plan: h.plan, option: h.option, invalidation: h.plan.stopLoss, trigger: { level: h.triggerLevel, label: null, status: "IN TRADE" },
      hold: { since: h.since, entrySpot: h.entrySpot, barsHeld: h.barsHeld, option: h.option },
      reason: `Holding ${h.direction === "BULLISH" ? "CE" : "PE"} from ${h.entrySpot}: SL ${h.plan.stopLoss}, T1 ${h.plan.target1}, time exit after ${TIME_EXIT_BARS} bars (${h.barsHeld} held)` };
  }
  if (inp.marketOpen && istMin(inp.nowSec) >= TRADING_END_MIN) {
    const best = pickContext(base.candidates);
    return { ...base, ...ctxFields(best), finalAction: "WAIT", reason: "Trading day ended at 15:15 — no new trades (15:15–15:30 movement is ignored)", rejection: "DAY END" };
  }
  if (!inp.marketOpen) {
    const best = pickContext(base.candidates);
    return { ...base, ...ctxFields(best), finalAction: "WAIT", reason: "Market closed — no live decision", rejection: "MARKET CLOSED" };
  }

  // 3) entry-ready candidates from production-eligible setups
  const ready = base.candidates.filter((x) => x.state === "ENTRY_READY" && x.plan);
  const dirs = new Set(ready.map((x) => x.direction));
  if (dirs.size > 1) {
    return { ...base, ...ctxFields(ready[0]), finalAction: "WAIT", reason: "Setups disagree on direction on the same closed candle — conflict, no trade", rejection: "CONFLICT" };
  }
  const prodReady = ready.filter((x) => x.production).sort((a, b) => (a.setup === "S1_MOMENTUM" ? -1 : 1) - (b.setup === "S1_MOMENTUM" ? -1 : 1));
  if (!prodReady.length) {
    const best = ready[0] || pickContext(base.candidates);
    const why = ready.length ? `${ready[0].label} is ready, but ${ready[0].setup} has no positive evidence on ${inp.index} (both replay periods) — evidence only`
      : best ? `${best.label}: ${best.blockReason || best.state}` : "No setup developing";
    // Confirmed on the close but the next candle (entry price) is not in the data yet:
    // a PROVISIONAL wait — the service recomputes as soon as the next open exists.
    const awaiting = !forming && base.candidates.some((x) => x.production && x.state === "CONFIRMED" && (x.blockReason || "").startsWith("Confirmed on the closed candle"));
    return { ...base, ...ctxFields(best), evidence: ready.length ? evaluateEvidence(ready[0].setup, inp.index, null) : null,
      finalAction: "WAIT", reason: why, rejection: awaiting ? "AWAITING_ENTRY" : ready.length ? "EVIDENCE" : (best?.state === "NONE" || !best ? "NO EDGE" : best.state) };
  }
  const pick = prodReady[0];
  if (base.bias && !base.bias.allow[pick.direction === "BULLISH" ? "CE" : "PE"]) {
    return { ...base, ...ctxFields(pick), finalAction: "WAIT", rejection: "BIAS_SHIFT",
      reason: `${pick.label} ${pick.direction} ready, but the market bias forbids it — ${base.bias.traderMessage}` };
  }
  const { leg, costR } = await optionLeg(inp, pick.direction, pick.plan!);
  const evid = evaluateEvidence(pick.setup, inp.index, costR);
  const decided = { ...base, ...ctxFields(pick), option: leg, evidence: evid };
  if (!leg.available || !leg.verified || leg.reason) {
    return { ...decided, finalAction: "WAIT", reason: `${pick.label} ready, but option is not a good vehicle: ${leg.reason || "unavailable"}`, rejection: "OPTION" };
  }
  if (!evid.passes) {
    return { ...decided, finalAction: "WAIT", reason: `${pick.label} ready, but expected value does not clear costs: ${evid.note}`, rejection: "EV" };
  }
  const action: FinalAction = pick.direction === "BULLISH" ? "BUY_CE" : "BUY_PE";
  return { ...decided, finalAction: action,
    reason: `${pick.label} — ${pick.direction} on the ${istIso(c.time).slice(11)} close; ${leg.strike} ${leg.side} @ ₹${leg.entry}, option R:R 1:${leg.netRR} after costs; ${evid.note}`, rejection: null };
}

function pickContext(cands: SetupCandidate[]): SetupCandidate | null {
  const order: TimingState[] = ["ENTRY_READY", "CONFIRMED", "EXTENDED", "FAILED", "WATCH", "INVALID", "NONE"];
  return cands.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0] || null;
}
function ctxFields(x: SetupCandidate | null): Partial<Decision> {
  if (!x) return {};
  return {
    direction: x.state === "NONE" ? "NEUTRAL" : x.direction, setup: x.setup, setupLabel: x.label, setupState: x.state,
    trigger: { level: x.triggerLevel, label: x.triggerLabel, status: x.state }, plan: x.plan, invalidation: x.invalidation,
  };
}
