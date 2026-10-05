import { test } from "node:test";
import assert from "node:assert/strict";
import { Candle } from "../types";
import { defaultConfig, defaultDecisionConfig } from "./config";
import { runEngine, walkOutcomes } from "./engine";
import { runDecisionLayer } from "./decision";
import { contractKey, OptBar, OptionSeries } from "./optionsData";
import { gammaRead } from "./strikeGamma";
import { context15ForSeries, Ctx15 } from "./context15";
import { validateOi } from "./oiValidation";
import { decisionCard } from "./decisionCard";
import { labViews } from "./views";
import { FuturesBinding } from "./types";

// Two synthetic sessions: a quiet 998<->1002 oscillation (session 1 = history),
// then session 2 oscillates and a single "break" bar is appended, plus a few
// follow-on bars so a next executable candle exists. Bars: o = prev close,
// h = max(o,c)+1, l = min(o,c)-1, so swing lows sit at 997 and highs at 1003.
const T0 = (d: string) => Math.floor(Date.parse(`${d}T09:15:00+05:30`) / 1000);
function series(breakClose: number, opts: { preBars?: number; follow?: number[] } = {}): Candle[] {
  const out: Candle[] = [];
  let prev = 1000;
  const push = (time: number, close: number) => {
    const o = prev;
    out.push({ time, open: o, high: Math.max(o, close) + 1, low: Math.min(o, close) - 1, close, volume: 1000 });
    prev = close;
  };
  for (let k = 0; k < 75; k++) push(T0("2026-09-28") + k * 300, k % 2 === 0 ? 1002 : 998);
  const pre = opts.preBars ?? 20;
  for (let k = 0; k < pre; k++) push(T0("2026-09-29") + k * 300, k % 2 === 0 ? 1002 : 998);
  push(T0("2026-09-29") + pre * 300, breakClose);
  (opts.follow ?? [breakClose - 1, breakClose - 2, breakClose - 3]).forEach((c, j) => push(T0("2026-09-29") + (pre + 1 + j) * 300, c));
  return out;
}

const BINDING: FuturesBinding = { underlying: "TEST", futuresSymbol: null, securityId: null, expiry: null, exchangeSegment: null, lotSize: null, status: "UNAVAILABLE_HISTORICAL", bindingReason: "synthetic" };

function run(candles: Candle[], o: { oi?: (number | null)[]; options?: OptionSeries | null; agree?: boolean; ctx15?: (Ctx15 | null)[]; precision?: boolean } = {}) {
  const cfg = defaultConfig("NIFTY", "5m");
  cfg.scope = { mode: "full" };
  cfg.dataMode = "SPOT_DIRECTION"; cfg.futuresBinding = "spot-fallback";
  const oi = o.oi ?? candles.map((_, i) => 1_000_000 + i * 10);
  const eng = runEngine({
    config: cfg, binding: BINDING, candles, oi, oiStatus: oi.some((x) => x != null) ? "AVAILABLE" : "UNAVAILABLE", vwapSource: "SPOT",
    expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), symbol: "TEST",
  });
  const before = JSON.stringify(eng.rows);
  const dc = { ...defaultDecisionConfig(), requireEngineAgreement: o.agree ?? false, precisionChain: o.precision ?? false };
  const res = runDecisionLayer({ cfg, dc, candles, rows: eng.rows, oi, options: o.options ?? null, strikeStep: 5, inScope: () => true, ctx15: o.ctx15 });
  return { cfg, eng, res, before };
}
const breakRow = (candles: Candle[], res: ReturnType<typeof run>["res"], pre = 20) => res.rows.find((r) => r.timestamp === candles[75 + pre].time)!;

test("low R:R breakdown is STILL a BUY PE signal — R:R is information only", () => {
  const c = series(985);
  const { res, cfg } = run(c);
  const r = breakRow(c, res);
  assert.equal(r.movementState, "BREAKDOWN_CONFIRMED");
  assert.equal(r.movementDirection, "BEARISH");
  assert.ok(r.plan!.rr < cfg.rrMin, `rr ${r.plan!.rr} should be < ${cfg.rrMin}`);
  assert.equal(r.executionState, "SELL_READY");
  assert.equal(r.action, "TAKE");
  assert.match(r.plan!.rrWarning!, /LOW R:R .* information only, signal unchanged/);
  assert.ok(res.summary.breakdownDetections >= 1);
});

test("low R:R breakout is STILL a BUY CE signal", () => {
  const c = series(1015, { preBars: 21, follow: [1016, 1017, 1018] });
  const { res } = run(c);
  const r = breakRow(c, res, 21);
  assert.equal(r.movementState, "BREAKOUT_CONFIRMED");
  assert.equal(r.executionState, "BUY_READY");
  assert.equal(r.plan!.side, "BUY");
  assert.ok(r.plan!.rr < 2 && r.plan!.rrWarning);
});

test("R:R >= 2 executes with a complete plan; SELL risk/reward use the spec formula", () => {
  const c = series(994);
  const { res } = run(c);
  const r = breakRow(c, res);
  assert.equal(r.movementState, "BREAKDOWN_CONFIRMED");
  assert.equal(r.executionState, "SELL_READY");
  assert.equal(r.action, "TAKE");
  const p = r.plan!;
  assert.equal(p.side, "SELL");
  assert.ok(p.stopLoss > p.entry && p.target1 < p.entry && p.target2 < p.target1);
  assert.equal(p.riskPoints, +(p.stopLoss - p.entry).toFixed(2));
  assert.equal(p.rewardPoints, +(p.entry - p.target1).toFixed(2));
  assert.equal(p.rr, +(p.rewardPoints / p.riskPoints).toFixed(2));
  assert.ok(p.rr >= 2);
  // SL is the structural invalidation (broken level + buffer), not a fixed number
  assert.equal(p.invalidation, 997);
});

test("missing / delayed OI never prevents breakdown detection or execution", () => {
  const c = series(994);
  const withOi = run(c);
  const noOi = run(c, { oi: c.map(() => null) });
  const a = breakRow(c, withOi.res), b = breakRow(c, noOi.res);
  assert.equal(b.oiStatus, "UNAVAILABLE");
  assert.equal(b.movementState, a.movementState);
  assert.equal(b.executionState, a.executionState);
  // stale OI (last value 5 bars back) is reported, still not a gate
  const stale = c.map((_, i) => (i < 75 + 16 ? 1_000_000 : null));
  const s = breakRow(c, run(c, { oi: stale }).res);
  assert.equal(s.oiStatus, "STALE");
  assert.equal(s.executionState, a.executionState);
});

test("dynamic no-trade zone exists in balance and is invalidated by a strong break", () => {
  const c = series(994);
  const { res } = run(c);
  const inside = res.rows.find((r) => r.timestamp === c[75 + 18].time)!;
  assert.ok(inside.noTradeZone, "balance box detected before the break");
  assert.doesNotMatch(inside.movementState, /ATTEMPT|CONFIRMED|EXPANSION/, "no break while inside the box");
  const r = breakRow(c, res);
  assert.equal(r.zoneInvalidated, true);
  assert.notEqual(r.movementState, "NO_EDGE");
});

test("late cutoff blocks the trade but not the movement", () => {
  const c = series(994, { preBars: 71 }); // break bar at 15:10 IST
  const { res } = run(c);
  const r = breakRow(c, res, 71);
  assert.equal(r.movementState, "BREAKDOWN_CONFIRMED");
  assert.equal(r.executionState, "TRADE_BLOCKED_LATE");
  assert.match(r.blockReason!, /LATE CUTOFF/);
});

test("no option data => strike DATA UNAVAILABLE (never fabricated) and it does not block", () => {
  const c = series(994);
  const r = breakRow(c, run(c).res);
  assert.equal(r.option!.status, "DATA UNAVAILABLE");
  assert.equal(r.option!.optionEntry, null);
  assert.equal(r.executionState, "SELL_READY");
});

function optSeries(c: Candle[], mk: (time: number, i: number) => OptBar[]): OptionSeries {
  const byTime = new Map<number, { CE: OptBar[]; PE: OptBar[] }>();
  const byContract = new Map<string, Map<number, OptBar>>();
  c.forEach((cd, i) => {
    const bars = mk(cd.time, i);
    if (!bars.length) return;
    byTime.set(cd.time, { CE: bars.filter((b) => b.side === "CE"), PE: bars.filter((b) => b.side === "PE") });
    bars.forEach((b) => { const k = contractKey(b.expiry, b.side, b.strike); (byContract.get(k) || byContract.set(k, new Map()).get(k)!).set(cd.time, b); });
  });
  return { status: "AVAILABLE", note: "synthetic", byTime, byContract, expiryByDate: new Map(), expirySource: "synthetic" };
}
const pe = (time: number, strike: number, offset: number, close: number, volume: number, spot: number): OptBar =>
  ({ time, strike, offset, side: "PE", open: close, high: close, low: close, close, iv: 15, oi: 50000, volume, spot, expiry: "2026-10-06" });

test("strike selection is dynamic: an illiquid ATM is skipped; primary + alternative + reason returned", () => {
  const c = series(994);
  const bi = 75 + 20;
  const opts = optSeries(c, (t, i) => (i === bi ? [pe(t, 990, -1, 9, 4000, 994), pe(t, 995, 0, 12, 0, 994), pe(t, 1000, 1, 15, 3000, 994)] : []));
  const r = breakRow(c, run(c, { options: opts }).res);
  const o = r.option!;
  assert.equal(o.status, "AVAILABLE");
  assert.ok(o.primary && o.alternative);
  assert.notEqual(o.primary!.strike, 995, "ATM with zero volume must not be selected");
  assert.equal(o.candidates.find((x) => x.strike === 995)!.eligible, false);
  assert.ok(o.selectionReason.length > 0);
  assert.ok(o.optionStop != null && o.optionTarget != null && o.optionTarget > o.optionEntry!);
});

test("gamma: CONFIRMED needs real acceleration; flat premium is not a blast; no data => UNAVAILABLE", () => {
  const dc = defaultDecisionConfig();
  const times = Array.from({ length: 20 }, (_, k) => 1_790_000_000 + k * 300);
  const mk = (accel: boolean) => optSeries(times.map((t) => ({ time: t, open: 0, high: 0, low: 0, close: 0, volume: 0 })),
    (t, i) => [pe(t, 1000, 0, accel && i === 19 ? 14 : 10 + (i % 2) * 0.2, accel && i === 19 ? 400 : 100, i === 19 ? 994 : 1000)]);
  const args = { side: "PE" as const, times, i: 19, strike: null, spot: 994, spotPrev: 1000, atr: 6, strikeStep: 5, movementState: "BREAKDOWN_CONFIRMED" as const, movementDirection: "BEARISH" as const, dc };
  assert.equal(gammaRead({ ...args, series: mk(true) }).state, "CONFIRMED");
  assert.notEqual(gammaRead({ ...args, series: mk(false) }).state, "CONFIRMED");
  assert.equal(gammaRead({ ...args, series: null }).state, "UNAVAILABLE");
});

test("the decision layer never mutates the legacy engine rows", () => {
  const c = series(994);
  const { eng, before } = run(c);
  assert.equal(JSON.stringify(eng.rows), before);
});

test("engine agreement: a confirmed break the engine score does not support is blocked, with the scores in the reason", () => {
  const c = series(994);
  const off = breakRow(c, run(c, { agree: false }).res);
  const on = breakRow(c, run(c, { agree: true }).res);
  assert.equal(off.executionState, "SELL_READY");
  assert.equal(on.movementState, off.movementState, "movement is unchanged by the agreement rule");
  assert.equal(on.executionState, "TRADE_BLOCKED_STRUCTURE");
  assert.match(on.blockReason!, /ENGINE SCORE DOES NOT AGREE \(buy \d+ \/ sell \d+\)/);
});

test("live tail: the last candle is not blocked just because its next candle has not formed yet", () => {
  const c = series(994, { follow: [] });
  const cfg = defaultConfig("NIFTY", "5m"); cfg.scope = { mode: "full" }; cfg.dataMode = "SPOT_DIRECTION"; cfg.futuresBinding = "spot-fallback";
  const oi = c.map(() => 1_000_000);
  const eng = runEngine({ config: cfg, binding: BINDING, candles: c, oi, oiStatus: "AVAILABLE", vwapSource: "SPOT", expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), symbol: "TEST" });
  const dc = { ...defaultDecisionConfig(), requireEngineAgreement: false, precisionChain: false };
  const batch = runDecisionLayer({ cfg, dc, candles: c, rows: eng.rows, oi, options: null, strikeStep: 5, inScope: () => true });
  const live = runDecisionLayer({ cfg, dc, candles: c, rows: eng.rows, oi, options: null, strikeStep: 5, inScope: () => true, liveTail: true });
  assert.equal(batch.rows[batch.rows.length - 1].executionState, "TRADE_BLOCKED_DATA");
  assert.equal(live.rows[live.rows.length - 1].executionState, "SELL_READY");
});

test("default INFO mode: low R:R does NOT block — signal given with a warning and next resistance / support", () => {
  const c = series(985);
  const r = breakRow(c, run(c).res);
  assert.equal(r.movementState, "BREAKDOWN_CONFIRMED");
  assert.equal(r.executionState, "SELL_READY");
  assert.equal(r.action, "TAKE");
  assert.ok(r.plan!.rr < 2);
  assert.match(r.plan!.rrWarning!, /information only, signal unchanged/);
  assert.ok(r.plan!.nextResistance.length >= 1 && r.plan!.nextResistance.every((x) => x > r.plan!.entry));
  assert.ok(r.plan!.nextSupport.every((x) => x < r.plan!.entry));
  assert.ok(!r.blockReasons.some((x) => /R:R/.test(x)));
});

test("R:R never appears as a block: no state, reason or timing mentions it, across scenarios", () => {
  for (const c of [series(985), series(994), series(1015, { preBars: 21, follow: [1016, 1017, 1018] }), series(994, { preBars: 71 })]) {
    const { res } = run(c);
    for (const r of res.rows) {
      assert.doesNotMatch(r.executionState, /RR/);
      assert.ok(!r.blockReasons.some((x) => /R:R/.test(x)));
      assert.doesNotMatch(r.timingClassification, /RR/);
    }
  }
});

// weak break: attempt (close 996 < 997, small body) then follow-through (995) => CONFIRMED but NOT a strong candle
const weakBreak = () => series(996, { follow: [995, 994, 993] });
const ctxAll = (c: Candle[], regime: Ctx15["regime"]): Ctx15[] => c.map(() => ({ regime, master: regime, confidence: "MEDIUM", barIso: "2026-09-29 09:15:00 IST", ema: "FLAT", vwapSide: "AT", structure: "Ranging", trend: "RANGE", support: null, resistance: null, atrPct: null, momentum: "FLAT", votes: { bull: 0, bear: 0 } }));

test("15M + 5M arbitration: aligned weak break is taken; counter-trend weak break needs a strong 5M candle (movement still shown)", () => {
  const c = weakBreak();
  const conf = (res: ReturnType<typeof run>["res"]) => res.rows.find((r) => r.timestamp === c[75 + 21].time)!;
  const aligned = conf(run(c, { ctx15: ctxAll(c, "BEARISH") }).res);
  const counter = conf(run(c, { ctx15: ctxAll(c, "BULLISH") }).res);
  assert.equal(aligned.movementState, "BREAKDOWN_CONFIRMED");
  assert.equal(aligned.executionState, "SELL_READY");
  assert.equal(counter.movementState, "BREAKDOWN_CONFIRMED", "movement is not hidden");
  assert.equal(counter.executionState, "TRADE_BLOCKED_STRUCTURE");
  assert.match(counter.blockReason!, /15M BULLISH vs downside break — needs a strong 5M candle/);
  assert.match(counter.contextWarning!, /reversal warning/);
  assert.equal(counter.regime15, "BULLISH");
});

test("15M context is causal: each candle sees only the last 15M candle CLOSED by its own close", () => {
  const c = series(994);
  const c15: Candle[] = [];
  for (let k = 0; k + 2 < c.length; k += 3) { const g = c.slice(k, k + 3); c15.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[2].close, volume: 3000 }); }
  const ctx = context15ForSeries(c, c15, 300, defaultConfig("NIFTY", "5m"));
  for (let i = 0; i < c.length; i++) {
    const x = ctx[i]; if (!x) continue;
    const t15 = Math.floor(Date.parse(x.barIso.replace(" IST", "+05:30").replace(" ", "T")) / 1000);
    assert.ok(t15 + 900 <= c[i].time + 300, `candle ${i} must not see an unclosed 15M candle`);
    const sameDay = x.barIso.slice(0, 10) === new Date((c[i].time + 19800) * 1000).toISOString().slice(0, 10);
    if (sameDay) assert.ok(t15 + 900 > c[i].time + 300 - 900, `candle ${i} uses the LATEST closed 15M candle`);
  }
});

test("OI freshness: DELAYED two candles back, LIVE on the live tail; never a gate", () => {
  const c = series(994);
  const bi = 75 + 20;
  const r = breakRow(c, run(c, { oi: c.map((_, i) => (i <= bi - 2 ? 1_000_000 : null)) }).res);
  assert.equal(r.oiStatus, "DELAYED");
  assert.equal(r.executionState, "SELL_READY");
  const cfg = defaultConfig("NIFTY", "5m"); cfg.scope = { mode: "full" }; cfg.dataMode = "SPOT_DIRECTION"; cfg.futuresBinding = "spot-fallback";
  const cc = series(994, { follow: [] }); const oi = cc.map(() => 1_000_000);
  const eng = runEngine({ config: cfg, binding: BINDING, candles: cc, oi, oiStatus: "AVAILABLE", vwapSource: "SPOT", expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), symbol: "TEST" });
  const live = runDecisionLayer({ cfg, dc: { ...defaultDecisionConfig(), requireEngineAgreement: false, precisionChain: false }, candles: cc, rows: eng.rows, oi, options: null, strikeStep: 5, inScope: () => true, liveTail: true });
  assert.equal(live.rows[live.rows.length - 1].oiStatus, "LIVE");
});

test("Reversal Risk is shown on directional candles and is a warning only", () => {
  const c = series(994);
  const r = breakRow(c, run(c).res);
  assert.ok(r.reversalRisk && ["LOW", "MEDIUM", "HIGH"].includes(r.reversalRisk.level));
  assert.equal(r.executionState, "SELL_READY");
});

test("OI validation: single-strike jump = OI_SHOCK; persistent neighbour-backed build = OI_CONFIRMED; no data = UNAVAILABLE", () => {
  const times = Array.from({ length: 16 }, (_, k) => 1_790_000_000 + k * 300);
  const mk = (oiAt: (strike: number, k: number) => number) => optSeries(times.map((t) => ({ time: t, open: 0, high: 0, low: 0, close: 0, volume: 0 })),
    (t, k) => [990, 995, 1000].map((st, j) => ({ ...pe(t, st, j - 1, 10 + k * 0.1, 500, 995), oi: oiAt(st, k) })));
  const base = (k: number) => 100000 + k * 100 + (k % 2) * 50;            // small, regular changes
  const shock = mk((st, k) => base(k) + (st === 995 && k === 15 ? 20000 : 0));
  const persist = mk((st, k) => base(k) + (k >= 14 ? (k - 13) * 3000 : 0));
  const args = { times, i: 15, spot: 995, direction: "NEUTRAL" as const };
  assert.equal(validateOi({ ...args, series: shock }).state, "OI_SHOCK");
  assert.equal(validateOi({ ...args, series: persist }).state, "OI_CONFIRMED");
  assert.equal(validateOi({ ...args, series: null }).state, "UNAVAILABLE");
});

// Trade held until SL/Target: after the 09:55 SELL (entry 994, SL 1000, T1 979) price drifts 993-994 without touching either.
test("no new BUY/SELL while a signal is open; no 1-hour time exit; still OPEN when data ends mid-session", () => {
  const drift = Array.from({ length: 30 }, (_, k) => (k % 2 ? 994 : 993));
  const c = series(994, { follow: drift });
  const { res } = run(c);
  const bi = 75 + 20;
  assert.equal(res.trades.length, 1, "exactly one trade");
  const t = res.trades[0];
  assert.equal(t.outcome, "OPEN", "neither SL nor target hit and data ends at 12:25 => still open");
  assert.equal(t.rMultiple, null);
  for (let k = bi + 1; k < c.length; k++) assert.notEqual(res.rows[k].action, "TAKE", `no new signal at candle ${k}`);
  assert.ok(res.rows.slice(bi + 1).every((r) => r.executionState === "HOLD"));
  assert.equal(res.metrics.totalTrades, 0, "an open trade is not counted in closed-trade statistics");
});

test("square-off only at the session close (not after 12 candles)", () => {
  const drift = Array.from({ length: 54 }, (_, k) => (k % 2 ? 994 : 993)); // runs to the 15:25 candle
  const c = series(994, { follow: drift });
  const { res } = run(c);
  const t = res.trades[0];
  assert.equal(t.outcome, "EOD_EXIT");
  assert.equal(t.exitTimestamp, c[c.length - 1].time, "closed on the session's last candle");
  assert.ok((t.holdBars ?? 0) > 12, "held longer than the old 1-hour time exit");
});

test("legacy engine rows: a later SELL while one is open becomes WAIT with a HOLD reason", () => {
  const cfg = defaultConfig("NIFTY", "5m");
  const mk = (i: number, sig: "SELL" | "WAIT") => ({ timestamp: 1_790_000_000 + i * 300, iso: `2026-10-01 10:${String(i * 5).padStart(2, "0")}:00 IST`, signal: sig, entry: sig === "SELL" ? 100 : null, entryTimestamp: 1_790_000_000 + (i + 1) * 300, stopLoss: 110, target1: 80, target2: 70, rr: 2, bos: "NONE", internalState: "NONE", extendedMove: "NORMAL", hardGate: false, hardGateReason: "", primaryReason: "" } as any);
  const candles = Array.from({ length: 8 }, (_, i) => ({ time: 1_790_000_000 + i * 300, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  const rows = [mk(0, "SELL"), mk(1, "SELL"), mk(2, "SELL"), mk(3, "WAIT"), mk(4, "SELL"), mk(5, "WAIT"), mk(6, "WAIT"), mk(7, "WAIT")];
  const trades = walkOutcomes(rows, candles, cfg);
  assert.equal(trades.length, 1);
  assert.equal(rows[1].signal, "WAIT"); assert.match(rows[1].hardGateReason, /HOLD — SELL from 10:00 still open/);
  assert.equal(rows[4].signal, "WAIT");
});

// ============ 5M direction-conflict protection + S/R rejection (spec tests 1-13) ============
// Same two-session base as above (swing highs 1003 / lows 997), then explicit [open, close, high?, low?] candles.
type Bar = [number, number, number?, number?];
function build(extra: Bar[], pre = 20): Candle[] {
  const out: Candle[] = []; let prev = 1000;
  const push = (time: number, o: number, c: number, h?: number, l?: number) => { out.push({ time, open: o, high: h ?? Math.max(o, c) + 1, low: l ?? Math.min(o, c) - 1, close: c, volume: 1000 }); prev = c; };
  for (let k = 0; k < 75; k++) push(T0("2026-09-28") + k * 300, prev, k % 2 === 0 ? 1002 : 998);
  for (let k = 0; k < pre; k++) push(T0("2026-09-29") + k * 300, prev, k % 2 === 0 ? 1002 : 998);
  extra.forEach(([o, c, h, l], j) => push(T0("2026-09-29") + (pre + j) * 300, o, c, h, l));
  return out;
}
const X = 75 + 20; // index of the first explicit candle
const ctxSeq = (c: Candle[], f: (i: number) => Ctx15["regime"]) => ctxAll(c, "RANGE").map((x, i) => ({ ...x, regime: f(i), master: f(i) }));
const at = (res: ReturnType<typeof run>["res"], c: Candle[], i: number) => res.rows.find((r) => r.timestamp === c[i].time)!;
const ENGULF_DOWN: Bar[] = [[998, 1001], [1002, 994]];   // green, then red whose body covers it

test("T1: 15M BULLISH + 5M bullish breakout, no conflict -> existing BUY CE unchanged", () => {
  const c = build([[998, 1010], [1010, 1011], [1011, 1012]]);
  const on = at(run(c, { ctx15: ctxAll(c, "BULLISH") }).res, c, X);
  assert.equal(on.guardState, null); assert.equal(on.directionConflict, false);
  assert.equal(on.executionState, "BUY_READY");
});

test("T2: 15M BULLISH + 5M bearish engulfing -> 5M_DIRECTION_CONFLICT, WAIT_FOR_DIRECTION_RECONFIRMATION, no new entry, 15M unchanged", () => {
  const c = build([...ENGULF_DOWN, [994, 993], [993, 992]]);
  const { res } = run(c, { ctx15: ctxAll(c, "BULLISH") });
  const r = at(res, c, X + 1);
  assert.equal(r.guardState, "5M_DIRECTION_CONFLICT");
  assert.equal(r.reconfirmationRequired, true); assert.equal(r.previousRegime, "BULLISH"); assert.equal(r.current5mDirection, "BEARISH");
  assert.equal(r.regime15, "BULLISH", "one 5M candle never changes the 15M regime");
  assert.equal(r.executionState, "WAIT_FOR_DIRECTION_RECONFIRMATION");
  assert.match(r.entryBlockedReason!, /no BUY PE until the 15M regime itself changes/);
  assert.equal(at(res, c, X + 2).guardState, "WAIT_FOR_DIRECTION_RECONFIRMATION");
  assert.ok(res.rows.filter((x) => x.timestamp >= c[X + 1].time).every((x) => x.action !== "TAKE"));
});

test("T3: conflict, then the existing engine re-confirms bullish -> DIRECTION_RECONFIRMED and BUY CE eligible again", () => {
  const c = build([...ENGULF_DOWN, [994, 999], [999, 1010], [1010, 1011]]);
  const r = at(run(c, { ctx15: ctxAll(c, "BULLISH") }).res, c, X + 3);
  assert.equal(r.movementState, "BREAKOUT_CONFIRMED");
  assert.equal(r.guardState, "DIRECTION_RECONFIRMED"); assert.equal(r.reconfirmationStatus, "DIRECTION_RECONFIRMED");
  assert.equal(r.executionState, "BUY_READY");
});

test("T4: conflict, bearish continuation, existing 15M engine turns BEARISH -> REGIME_CHANGE_CONFIRMED and BUY PE eligible", () => {
  const c = build([...ENGULF_DOWN, [994, 989], [989, 988]]);
  const { res } = run(c, { ctx15: ctxSeq(c, (i) => (i <= X + 1 ? "BULLISH" : "BEARISH")) });
  assert.equal(at(res, c, X + 1).action, "WAIT", "no BUY PE on the conflict candle itself");
  const r = at(res, c, X + 2);
  assert.equal(r.guardState, "REGIME_CHANGE_CONFIRMED");
  assert.equal(r.executionState, "SELL_READY");
});

test("T5: 15M BEARISH + 5M bullish engulfing -> conflict, no new BUY PE (and no immediate BUY CE)", () => {
  const c = build([[1002, 999], [998, 1006], [1006, 1005], [1005, 1004]]);
  const { res } = run(c, { ctx15: ctxAll(c, "BEARISH") });
  const r = at(res, c, X + 1);
  assert.equal(r.guardState, "5M_DIRECTION_CONFLICT");
  assert.equal(r.action, "WAIT");
  assert.ok(res.rows.filter((x) => x.timestamp >= c[X + 1].time).every((x) => x.action !== "TAKE"));
});

test("T6: resistance rejection -> RESISTANCE_REJECTION, WAIT, no immediate BUY PE", () => {
  const c = build([[999, 1000, 1004, 998.5], [1000, 1000.5]]);
  const r = at(run(c).res, c, X);
  assert.equal(r.supportResistanceEvent, "RESISTANCE_REJECTION"); assert.equal(r.guardState, "RESISTANCE_REJECTION");
  assert.equal(r.supportResistanceLevel, 1003);
  assert.equal(r.action, "WAIT");
});

test("T7: resistance rejection followed by bearish 5M confirmation -> existing BUY PE can trigger", () => {
  const c = build([[999, 1000, 1004, 998.5], [1000, 990], [990, 989]]);
  const r = at(run(c).res, c, X + 1);
  assert.equal(r.rejectionStatus, "CONFIRMED");
  assert.equal(r.executionState, "SELL_READY");
});

test("T8: support rejection -> SUPPORT_REJECTION, WAIT, no immediate BUY CE", () => {
  const c = build([[1001, 1000, 1001.5, 996], [1000, 1000.5]]);
  const r = at(run(c).res, c, X);
  assert.equal(r.supportResistanceEvent, "SUPPORT_REJECTION"); assert.equal(r.supportResistanceLevel, 997);
  assert.equal(r.action, "WAIT");
});

test("T9: support rejection followed by bullish 5M confirmation -> existing BUY CE can trigger", () => {
  const c = build([[1001, 1000, 1001.5, 996], [1000, 1010], [1010, 1011]]);
  const r = at(run(c).res, c, X + 1);
  assert.equal(r.rejectionStatus, "CONFIRMED");
  assert.equal(r.executionState, "BUY_READY");
});

const ce = (time: number, strike: number, offset: number, close: number, volume: number, spot: number): OptBar =>
  ({ time, strike, offset, side: "CE", open: close, high: close, low: close, close, iv: 15, oi: 50000, volume, spot, expiry: "2026-10-06" });
const cardHas = (txt: string, side: "CE" | "PE") => {
  for (const k of ["ENTRY (index)", "STOP LOSS (index)", "TARGET 1 (index)", "TARGET 2 (index)", "PRIMARY STRIKE", "ALTERNATIVE STRIKE", "OPTION ENTRY LTP", "OPTION SL", "OPTION TARGET 1", "OPTION TARGET 2", "GAMMA", "OI STATUS", "LIQUIDITY", "R:R STATUS", "FINAL ACTION"]) assert.match(txt, new RegExp(`^${k.replace(/[()]/g, "\\$&")}\\s+:`, "m"), `card has ${k}`);
  assert.match(txt, new RegExp(`^PRIMARY STRIKE\\s+: \\d+ ${side}`, "m"));
  assert.match(txt, new RegExp(`^FINAL ACTION\\s+: BUY ${side}`, "m"));
};

test("T10: BUY CE card shows Entry, SL, T1, T2, primary + alternative strike, option prices, R:R", () => {
  const c = build([[998, 1010], [1010, 1011]]);
  const opts = optSeries(c, (t, i) => (i === X ? [ce(t, 1005, -1, 12, 4000, 1010), ce(t, 1010, 0, 9, 5000, 1010), ce(t, 1015, 1, 6, 3000, 1010)] : []));
  const r = at(run(c, { ctx15: ctxAll(c, "BULLISH"), options: opts }).res, c, X);
  assert.equal(r.action, "TAKE");
  cardHas(decisionCard(r, "NIFTY", "TEST"), "CE");
});

test("T11: BUY PE card shows Entry, SL, T1, T2, primary + alternative strike, option prices, R:R", () => {
  const c = series(994);
  const bi = 75 + 20;
  const opts = optSeries(c, (t, i) => (i === bi ? [pe(t, 990, -1, 9, 4000, 994), pe(t, 995, 0, 12, 3500, 994), pe(t, 1000, 1, 15, 3000, 994)] : []));
  const r = breakRow(c, run(c, { options: opts }).res);
  assert.equal(r.action, "TAKE");
  cardHas(decisionCard(r, "NIFTY", "TEST"), "PE");
});

test("T12: R:R < 2 -> BUY PE still generated, R:R STATUS WARNING, no BLOCKED_RR", () => {
  const c = series(985);
  const r = breakRow(c, run(c).res);
  assert.equal(r.action, "TAKE"); assert.equal(r.rrStatus, "WARNING");
  assert.doesNotMatch(r.executionState, /RR/);
  assert.match(decisionCard(r, "NIFTY", "TEST"), /^R:R STATUS\s+: WARNING/m);
});

test("T13: open BUY CE + 5M bearish conflict -> position untouched (same exit as without the layer); conflict recorded", () => {
  const extra: Bar[] = [[998, 1010], [1010, 1011], [1011, 1012], [1013, 1005], [1005, 1006], [1006, 1007]];
  const c = build(extra);
  const ctx15 = ctxAll(c, "BULLISH");
  const on = run(c, { ctx15 }).res;
  const cfg = defaultConfig("NIFTY", "5m"); cfg.scope = { mode: "full" }; cfg.dataMode = "SPOT_DIRECTION"; cfg.futuresBinding = "spot-fallback";
  const oi = c.map((_, i) => 1_000_000 + i * 10);
  const eng = runEngine({ config: cfg, binding: BINDING, candles: c, oi, oiStatus: "AVAILABLE", vwapSource: "SPOT", expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), symbol: "TEST" });
  const off = runDecisionLayer({ cfg, dc: { ...defaultDecisionConfig(), requireEngineAgreement: false, directionGuard: false, precisionChain: false }, candles: c, rows: eng.rows, oi, options: null, strikeStep: 5, inScope: () => true, ctx15 });
  assert.equal(on.trades.length, 1);
  const a = on.trades[0], b = off.trades[0];
  assert.deepEqual([a.outcome, a.exitTimestamp, a.exitPrice], [b.outcome, b.exitTimestamp, b.exitPrice], "existing management unchanged");
  const conflictRow = at(on, c, X + 3);
  assert.equal(conflictRow.guardState, "5M_DIRECTION_CONFLICT");
  assert.equal(conflictRow.executionState, "HOLD", "the open BUY CE keeps running");
});

// ============ SINGLE SOURCE OF TRUTH: every panel derives from the same decision result ============
test("consistency: chart marker, signals table, trades table and Final Signal agree with the decision layer for every candle", () => {
  for (const c of [series(994), series(985), build([[998, 1010], [1010, 1011], [1011, 1012]]), build([...ENGULF_DOWN, [994, 999], [999, 1010], [1010, 1011]])]) {
    const ctx15 = ctxAll(c, "BULLISH");
    const { res, eng } = run(c, { ctx15 });
    const rr: any = { rows: eng.rows, chart: c.map((x) => ({ t: x.time, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume, oi: null, ema9: null, ema21: null, vwap: null, signal: "WAIT" })), decision: res };
    const v = labViews(rr)!;
    for (const d of res.rows) {
      const ch = v.chart.find((x) => x.t === d.timestamp)!;
      assert.equal(ch.action, d.finalAction, "chart marker = decision");
      const sv = v.signals.find((x) => x.timestamp === d.timestamp);
      if (d.finalAction === "WAIT") { assert.equal(ch.signal, "WAIT"); assert.equal(sv, undefined); continue; }
      assert.equal(ch.signal, d.plan!.side);
      assert.ok(sv, "signals table has every BUY CE / BUY PE");
      assert.equal(sv!.action, d.finalAction);
      assert.deepEqual([sv!.entry, sv!.stopLoss, sv!.target1, sv!.target2, sv!.strike], [d.plan!.entry, d.plan!.stopLoss, d.plan!.target1, d.plan!.target2, d.option?.primary?.strike ?? null]);
    }
    const last = [...res.rows].reverse().find((x) => x.finalAction !== "WAIT");
    assert.equal(v.final.lastSignal?.timestamp ?? null, last?.timestamp ?? null, "Final Signal = latest decision-layer signal");
    assert.equal(v.final.latest?.timestamp, res.rows[res.rows.length - 1].timestamp);
    for (const t of v.trades) assert.ok(v.signals.some((s) => s.timestamp === t.timestamp && s.entry === t.entry), "every trade is a listed signal");
  }
});

test("BUY = BUY CE (call) and SELL = BUY PE (put): finalAction matches the plan side on every signal", () => {
  for (const c of [series(994), build([[998, 1010], [1010, 1011], [1011, 1012]])]) {
    for (const d of run(c, { ctx15: ctxAll(c, "BULLISH") }).res.rows.filter((x) => x.finalAction !== "WAIT")) {
      assert.equal(d.finalAction, d.plan!.side === "BUY" ? "BUY CE" : "BUY PE");
      assert.equal(d.option?.optionType ?? (d.plan!.side === "BUY" ? "CE" : "PE"), d.plan!.side === "BUY" ? "CE" : "PE");
    }
  }
});

test("delayed OI: breakout and breakdown are still detected and signalled", () => {
  const up = build([[998, 1010], [1010, 1011], [1011, 1012]]);
  const dn = series(994);
  const stale = (c: Candle[]) => c.map((_, i) => (i < c.length - 12 ? 1_000_000 : null));
  const u = at(run(up, { ctx15: ctxAll(up, "BULLISH"), oi: stale(up) }).res, up, X);
  const d = breakRow(dn, run(dn, { oi: stale(dn) }).res);
  assert.equal(u.movementState, "BREAKOUT_CONFIRMED"); assert.equal(u.finalAction, "BUY CE"); assert.match(u.oiStatus, /DELAYED|STALE|AGING/);
  assert.equal(d.movementState, "BREAKDOWN_CONFIRMED"); assert.equal(d.finalAction, "BUY PE"); assert.match(d.oiStatus, /DELAYED|STALE|AGING/);
});

test("cooldown never carries into the next session", () => {
  const cfg = defaultConfig("NIFTY", "5m");
  const day1 = Math.floor(Date.parse("2026-09-28T15:20:00+05:30") / 1000), day2 = Math.floor(Date.parse("2026-09-29T09:15:00+05:30") / 1000);
  const times = [day1, day1 + 300, day2, day2 + 300, day2 + 600];
  const candles = times.map((t) => ({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  const mk = (i: number, sig: "SELL" | "WAIT") => ({ timestamp: times[i], iso: new Date((times[i] + 19800) * 1000).toISOString().replace("T", " ").slice(0, 19) + " IST", signal: sig, entry: sig === "SELL" ? 100 : null, entryTimestamp: times[i + 1], stopLoss: 110, target1: 80, target2: 70, rr: 2, bos: "NONE", internalState: "NONE", extendedMove: "NORMAL", hardGate: false, hardGateReason: "", primaryReason: "" } as any);
  const rows = [mk(0, "SELL"), mk(1, "WAIT"), mk(2, "SELL"), mk(3, "WAIT"), mk(4, "WAIT")];
  const trades = walkOutcomes(rows, candles, cfg);
  assert.equal(trades.length, 2, "the next session's first-candle signal is not swallowed by yesterday's cooldown");
});

// ============ PRECISION CHECK chain (2026-10-05 flow) ============
// rising zig-zag: three up candles then one pullback, so real swing highs / lows and BOS form
// rising zig-zag: five up candles then three pullback candles, so real swing highs / lows (3 candles each side) and BOS form
const trend = (n: number, from: number, step: number): Bar[] => {
  const out: Bar[] = []; let p = from;
  for (let k = 0; k < n; k++) {
    const d = k % 8 >= 5 ? -step : step; const o = p, c = p + d; p = c;
    // the leg's top / bottom candle gets a distinct wick so it is a strict swing high / low (engine rule)
    out.push(k % 8 === 4 ? [o, c, c + 3, Math.min(o, c) - 1] : k % 8 === 7 ? [o, c, Math.max(o, c) + 1, c - 3] : [o, c]);
  }
  return out;
};
test("precision chain: every item is evaluated on a candidate and listed; any FAIL -> WAIT with that item named", () => {
  const c = build([[998, 1010], [1010, 1011], [1011, 1012]]);
  const r = at(run(c, { ctx15: ctxAll(c, "RANGE"), precision: true }).res, c, X);
  assert.equal(r.movementState, "BREAKOUT_CONFIRMED", "movement still detected");
  assert.ok(r.precision, "precision record present");
  assert.deepEqual(Object.keys(r.precision!), ["15M + 5M agreement", "EMA 21 / EMA 50", "VWAP", "UT Bot", "Structure / BOS", "Volume / Momentum", "Liquidity"]);
  assert.equal(r.precision!["15M + 5M agreement"], "FAIL");
  assert.equal(r.finalAction, "WAIT");
  assert.match(r.blockReason!, /^PRECISION: 15M \+ 5M agreement does not agree \(15M RANGE\)/);
});

test("precision chain: a clean uptrend with 15M BULLISH passes every item and gives BUY CE", () => {
  // 40 rising candles build EMA21>EMA50, price>VWAP, UT bullish, bullish structure, momentum; then a breakout candle
  const tr = trend(56, 1000, 2); const last = tr[tr.length - 1][1];
  const c = build([...tr, [last, last + 6], [last + 6, last + 7], [last + 7, last + 8], [last + 8, last + 9], [last + 9, last + 10]]);
  const { res } = run(c, { ctx15: ctxAll(c, "BULLISH"), precision: true });
  const sig = res.rows.find((r) => r.finalAction === "BUY CE");
  assert.ok(sig, "a BUY CE is produced when every precision item agrees");
  for (const [k, v] of Object.entries(sig!.precision!)) assert.notEqual(v, "FAIL", `${k} must not fail on the signal`);
});

test("precision chain off -> previous behaviour (no precision record, combined rules)", () => {
  const c = build([[998, 1010], [1010, 1011], [1011, 1012]]);
  const r = at(run(c, { ctx15: ctxAll(c, "BULLISH"), precision: false }).res, c, X);
  assert.equal(r.precision, null);
  assert.equal(r.finalAction, "BUY CE");
});

test("day high / day low are breakout levels only after the opening 15 minutes", () => {
  // tiny first candle; second candle closes below its low at 09:20 -> must NOT be a day-low breakdown
  const c = build([], 0);
  const extra: Candle[] = [];
  const base = T0("2026-09-29");
  extra.push({ time: base, open: 1000, high: 1001, low: 999.5, close: 1000.5, volume: 1000 });
  extra.push({ time: base + 300, open: 1000.5, high: 1000.6, low: 995, close: 995.5, volume: 1000 });
  const cc = [...c, ...extra];
  const r = run(cc, { precision: false }).res.rows.find((x) => x.timestamp === base + 300)!;
  assert.notEqual(r.breakdownLevel, 999.5, "the 09:15 candle's low is not used as a day-low level at 09:20");
});
