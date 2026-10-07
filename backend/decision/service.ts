// ============================================================================
// Arbiter service — freezes ONE Decision per index per closed 5m candle, manages
// the arbiter's own HOLD state on closed candles, writes the observation ledger,
// and grades what happened afterwards (post-hoc; never fed back into a decision).
//
// Ledger: data/decision-ledger/<IST date>.jsonl
//   {type:"decision", ...Decision}             one per index per closed candle
//   {type:"outcome",  key, setup, kind, ...}    after the forward window resolves
// State (open arbiter trades, pending outcome checks): data/decision-ledger/state.json
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { Candle, OiAnalysis } from "../types";
import { arbitrate, ArbiterInput, TIME_EXIT_BARS } from "./arbiter";
import { istMin } from "./regime";
import { Decision, OptionLeg, SpotPlan, TRADING_END_MIN } from "./types";

const DIR = path.join(process.cwd(), "data", "decision-ledger");
const STATE_FILE = path.join(DIR, "state.json");
const SESSION_EXIT_MIN = TRADING_END_MIN;
const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

interface OpenTrade {
  index: string; key: string; since: number; entrySpot: number; plan: SpotPlan; option: OptionLeg | null;
  setup: string; direction: "BULLISH" | "BEARISH"; triggerLevel: number | null; barsHeld: number;
  mfe: number; mae: number;
}
interface PendingCheck {
  key: string; index: string; kind: "TAKEN" | "NOT_TAKEN"; setup: string; state: string; direction: "BULLISH" | "BEARISH";
  barTime: number; plan: SpotPlan; finalAction: string; rejection: string | null; moveFromOpenAtr: number | null;
}
interface State { open: Record<string, OpenTrade>; pending: PendingCheck[] }

let state: State = loadState();
function loadState(): State {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); return { open: s.open || {}, pending: s.pending || [] }; } catch { return { open: {}, pending: [] }; }
}
function saveState() { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* best-effort */ } }
function append(day: string, obj: any) { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(path.join(DIR, `${day}.jsonl`), JSON.stringify(obj) + "\n"); } catch { /* best-effort */ } }

const _frozen = new Map<string, Decision>();          // key → decision (one per closed candle)
// Survive restarts: a candle already decided (and logged) is re-used from the
// ledger exactly as decided, never decided a second time.
const _ledgerLoaded = new Set<string>();
function loadLedgerDay(day: string) {
  if (_ledgerLoaded.has(day)) return;
  _ledgerLoaded.add(day);
  try {
    for (const line of fs.readFileSync(path.join(DIR, `${day}.jsonl`), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.type === "decision" && o.key && !_frozen.has(o.key)) { const { type: _t, ...d } = o; _frozen.set(o.key, d as Decision); } } catch { /* skip */ }
    }
  } catch { /* no ledger yet */ }
}
const _latestByIndex = new Map<string, Decision>();

export interface DecisionDeps {
  getCandles5: (symbol: string) => Promise<Candle[]>;
  getDailyAtr: (symbol: string) => Promise<number | null>;
  getChain: (symbol: string) => Promise<OiAnalysis | null>;
  chainIsStale: (oi: OiAnalysis | null) => boolean;
  dhanOn: () => boolean;
  marketOpen: () => boolean;
  lookupOption: ArbiterInput["lookupOption"];
  getNextExpiryChain?: (symbol: string) => Promise<OiAnalysis | null>;
  features?: (symbol: string) => Promise<Record<string, any>>;
}
export interface IndexDef { index: string; symbol: string; name: string; nseSymbol: string; lotSize: number | null }

function dataStatusFor(candles: Candle[], nowSec: number, dhanOn: boolean, marketOpen: boolean): string {
  if (!dhanOn) return "DISCONNECTED";
  if (!candles.length) return "UNAVAILABLE";
  if (!marketOpen) return "CLOSED";
  const age = nowSec - candles[candles.length - 1].time;          // forming candle starts every 300s
  return age <= 450 ? "LIVE" : age <= 900 ? "DELAYED" : "STALE";
}

const _inflight = new Map<string, Promise<Decision>>();   // one computation per index at a time

/** The authoritative decision for one index (computes it once per closed candle). */
export async function getDecision(def: IndexDef, deps: DecisionDeps, nowSec = Math.floor(Date.now() / 1000)): Promise<Decision> {
  const running = _inflight.get(def.index);
  if (running) return running;
  const p = getDecisionImpl(def, deps, nowSec).finally(() => _inflight.delete(def.index));
  _inflight.set(def.index, p);
  return p;
}

async function getDecisionImpl(def: IndexDef, deps: DecisionDeps, nowSec: number): Promise<Decision> {
  const candles = await deps.getCandles5(def.symbol).catch(() => [] as Candle[]);
  const marketOpen = deps.marketOpen();
  const dataStatus = dataStatusFor(candles, nowSec, deps.dhanOn(), marketOpen);
  const last = candles[candles.length - 1];
  const closedLast = last ? (last.time + 300 > nowSec ? candles[candles.length - 2] : last) : null;
  const key = `${def.index}|5m|${closedLast ? closedLast.time : 0}`;
  if (closedLast) loadLedgerDay(istDate(closedLast.time));
  const prev = _frozen.get(key);
  if (prev && !(prev.finalAction === "AVOID" && prev.rejection === "DATA" && dataStatus === "LIVE")) {
    return withLive(prev, candles, nowSec);
  }
  // advance the arbiter's own open trade on the newly closed candles BEFORE deciding
  if (closedLast) advanceOpenTrade(def.index, candles.filter((c) => c.time <= closedLast.time));
  const oi = await deps.getChain(def.symbol).catch(() => null);
  const dailyAtr = await deps.getDailyAtr(def.symbol).catch(() => null);
  const features = deps.features ? await deps.features(def.symbol).catch(() => ({})) : {};
  const ot = state.open[def.index];
  const t0 = Date.now();
  const d = await arbitrate({
    index: def.index, symbol: def.symbol, name: def.name, nseSymbol: def.nseSymbol, lotSize: def.lotSize,
    candles, nowSec, marketOpen, dataStatus, dailyAtr, oiChain: oi, chainStale: deps.chainIsStale(oi), features,
    hold: ot ? { since: ot.since, entrySpot: ot.entrySpot, barsHeld: ot.barsHeld, option: ot.option, plan: ot.plan, setup: ot.setup, direction: ot.direction, triggerLevel: ot.triggerLevel } : null,
    lookupOption: deps.lookupOption,
    getNextExpiryChain: deps.getNextExpiryChain ? () => deps.getNextExpiryChain!(def.symbol) : undefined,
  });
  d.features = { ...d.features, computeMs: Date.now() - t0 };
  // Provisional: S1 confirmed but the next candle's open (entry) is not in the data
  // yet — do NOT freeze or log; the next poll decides once the entry price exists.
  if (d.rejection === "AWAITING_ENTRY") { _latestByIndex.set(def.index, d); return withLive(d, candles, nowSec); }
  _frozen.set(d.key, d);
  if (_frozen.size > 400) { const k = _frozen.keys().next().value; if (k) _frozen.delete(k); }
  _latestByIndex.set(def.index, d);
  if (d.candleTime) {
    const day = istDate(d.candleTime);
    append(day, { type: "decision", ...d });
    registerOutcomes(d, candles);
    if ((d.finalAction === "BUY_CE" || d.finalAction === "BUY_PE") && d.plan && !state.open[def.index]) {
      state.open[def.index] = { index: def.index, key: d.key, since: d.candleTime, entrySpot: d.plan.entry, plan: d.plan, option: d.option,
        setup: d.setup || "", direction: d.direction === "BEARISH" ? "BEARISH" : "BULLISH", triggerLevel: d.trigger.level, barsHeld: 0, mfe: 0, mae: 0 };
    }
    gradePending(def.index, candles.filter((c) => c.time <= (closedLast?.time ?? 0)));
    saveState();
  }
  return withLive(d, candles, nowSec);
}

export function latestDecision(index: string): Decision | null { return _latestByIndex.get(index) || null; }

function withLive(d: Decision, candles: Candle[], nowSec: number): Decision {
  // live context may change inside the candle; the decision itself is frozen
  const last = candles[candles.length - 1];
  if (!d.live || !last || last.time + 300 <= nowSec) return d;
  const L = d.live.s2Trigger, bull = d.direction !== "BEARISH";
  if (L == null) return d;
  const poked = bull ? last.high > L : last.low < L;
  const beyond = bull ? last.close > L : last.close < L;
  return { ...d, live: { ...d.live, formingClose: last.close, state: beyond ? "CONFIRMING" : poked ? "ATTEMPT" : Math.abs(last.close - L) <= (d.volatility.atr || 0) * 0.5 ? "PRE_MOVE" : "—" } };
}

// ---- arbiter HOLD management on CLOSED candles (fill = next open) ----
function advanceOpenTrade(index: string, closed: Candle[]) {
  const t = state.open[index];
  if (!t) return;
  const after = closed.filter((c) => c.time > t.since);
  if (!after.length) return;
  const fill = after[0].open, bull = t.direction === "BULLISH", p = t.plan;
  const risk = Math.abs(fill - p.stopLoss) || 1;
  let exit: { reason: string; price: number; time: number } | null = null;
  for (let k = 0; k < after.length; k++) {
    const c = after[k];
    t.mfe = Math.max(t.mfe, (bull ? c.high - fill : fill - c.low) / risk);
    t.mae = Math.max(t.mae, (bull ? fill - c.low : c.high - fill) / risk);
    if (istDate(c.time) !== istDate(t.since) || istMin(c.time) >= SESSION_EXIT_MIN) { exit = { reason: "SESSION_END", price: c.open, time: c.time }; break; }
    if (bull ? c.low <= p.stopLoss : c.high >= p.stopLoss) { exit = { reason: "SL", price: p.stopLoss, time: c.time }; break; }
    if (bull ? c.high >= p.target1 : c.low <= p.target1) { exit = { reason: "T1", price: p.target1, time: c.time }; break; }
    if (k + 1 >= TIME_EXIT_BARS) { exit = { reason: "TIME_EXIT", price: c.close, time: c.time }; break; }
  }
  t.barsHeld = after.length;
  if (exit) {
    const R = r2((bull ? exit.price - fill : fill - exit.price) / risk);
    append(istDate(t.since), { type: "exit", key: t.key, index, setup: t.setup, direction: t.direction, fillSpot: fill, ...exit, R, mfeR: r2(t.mfe), maeR: r2(t.mae), bars: after.length });
    delete state.open[index];
  }
}

// ---- outcome grading (post-hoc) ----
function registerOutcomes(d: Decision, candles: Candle[]) {
  if (!d.candleTime) return;
  const day = istDate(d.candleTime);
  const todays = candles.filter((c) => istDate(c.time) === day);
  const open = todays[0]?.open ?? null;
  const mv = open != null && d.volatility.atr ? (d.spot! - open) / d.volatility.atr : null;
  const taken = d.finalAction === "BUY_CE" || d.finalAction === "BUY_PE";
  for (const cand of d.candidates) {
    if (!cand.plan || !(cand.state === "ENTRY_READY" || cand.state === "CONFIRMED" || cand.state === "EXTENDED")) continue;
    const isPick = taken && d.setup === cand.setup;
    state.pending.push({ key: d.key, index: d.index, kind: isPick ? "TAKEN" : "NOT_TAKEN", setup: cand.setup, state: cand.state, direction: cand.direction,
      barTime: d.candleTime, plan: cand.plan, finalAction: d.finalAction, rejection: d.rejection, moveFromOpenAtr: mv != null ? r2(mv * (cand.direction === "BULLISH" ? 1 : -1)) : null });
  }
  if (state.pending.length > 500) state.pending = state.pending.slice(-500);
}

// BUG 2 fix: grade ONLY this index's pending checks against this index's candles.
function gradePending(index: string, closed: Candle[]) {
  const keep: PendingCheck[] = [];
  for (const p of state.pending) {
    if (p.index !== index) { keep.push(p); continue; }
    const after = closed.filter((c) => c.time > p.barTime && istDate(c.time) === istDate(p.barTime));
    const sessionOver = closed.length && (istDate(closed[closed.length - 1].time) !== istDate(p.barTime) || istMin(closed[closed.length - 1].time) >= SESSION_EXIT_MIN);
    if (after.length < 1 || (after.length < TIME_EXIT_BARS && !sessionOver)) {
      // still resolving unless SL/T1 already hit
      const res = walk(p, after);
      if (!res || res.reason === "OPEN") { keep.push(p); continue; }
      writeOutcome(p, res); continue;
    }
    const res = walk(p, after) || { reason: "NO_FILL", R: 0, mfe: 0, mae: 0, bars: 0 };
    writeOutcome(p, res);
  }
  state.pending = keep;
}
function walk(p: PendingCheck, after: Candle[]): { reason: string; R: number; mfe: number; mae: number; bars: number } | null {
  if (!after.length) return null;
  const fill = after[0].open, bull = p.direction === "BULLISH";
  const risk = Math.abs(fill - p.plan.stopLoss) || 1;
  let mfe = 0, mae = 0;
  for (let k = 0; k < after.length; k++) {
    const c = after[k];
    if (istMin(c.time) >= SESSION_EXIT_MIN) return { reason: "SESSION_END", R: r2((bull ? c.open - fill : fill - c.open) / risk), mfe: r2(mfe), mae: r2(mae), bars: k };
    mfe = Math.max(mfe, (bull ? c.high - fill : fill - c.low) / risk);
    mae = Math.max(mae, (bull ? fill - c.low : c.high - fill) / risk);
    if (bull ? c.low <= p.plan.stopLoss : c.high >= p.plan.stopLoss) return { reason: "SL", R: r2((bull ? p.plan.stopLoss - fill : fill - p.plan.stopLoss) / risk), mfe: r2(mfe), mae: r2(mae), bars: k + 1 };
    if (bull ? c.high >= p.plan.target1 : c.low <= p.plan.target1) return { reason: "T1", R: r2((bull ? p.plan.target1 - fill : fill - p.plan.target1) / risk), mfe: r2(mfe), mae: r2(mae), bars: k + 1 };
    if (k + 1 >= TIME_EXIT_BARS) return { reason: "TIME_EXIT", R: r2((bull ? c.close - fill : fill - c.close) / risk), mfe: r2(mfe), mae: r2(mae), bars: k + 1 };
  }
  return { reason: "OPEN", R: 0, mfe: r2(mfe), mae: r2(mae), bars: after.length };
}
// Objective classes:
//  TAKEN:     SL → FALSE · win after MAE ≥ 0.5R → EARLY · win → TIMELY · loss after ≥3 ATR move from open → LATE
//  NOT_TAKEN: would have hit T1 / positive time exit → MISSED · otherwise → NO_EDGE (correctly avoided)
function writeOutcome(p: PendingCheck, res: { reason: string; R: number; mfe: number; mae: number; bars: number }) {
  let cls: string;
  if (p.kind === "TAKEN") {
    if (res.R > 0) cls = res.mae >= 0.5 ? "EARLY" : "TIMELY";
    else cls = p.moveFromOpenAtr != null && p.moveFromOpenAtr >= 3 ? "LATE" : "FALSE";
  } else cls = res.R > 0 ? "MISSED" : "NO_EDGE";
  append(istDate(p.barTime), { type: "outcome", key: p.key, index: p.index, setup: p.setup, kind: p.kind, candidateState: p.state, direction: p.direction,
    finalAction: p.finalAction, rejection: p.rejection, plan: p.plan, ...res, class: cls });
}

/** Today's ledger lines for one index (for UI markers / reports). */
export function ledgerFor(index: string, day: string): any[] {
  try {
    return fs.readFileSync(path.join(DIR, `${day}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.index === index);
  } catch { return []; }
}
export function openArbiterTrade(index: string): OpenTrade | null { return state.open[index] || null; }
