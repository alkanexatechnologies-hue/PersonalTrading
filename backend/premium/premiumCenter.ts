// ============================ Option Premium Prediction Center — pure logic (no I/O) ============================
// Everything here works on data handed in by the route: closed spot candles, the forming candle (kept separate),
// real option-premium OHLC candles, the live option chain, the arbiter's decision and the existing risk state.
//
// What it does NOT do:
//  • It never invents a probability. Until a horizon/state has passed the historical validation (step 3), every
//    probability field is null and the screen shows PROBABILITY NOT VALIDATED.
//  • It never creates a trade. BUY CE / BUY PE CANDIDATE only appears when the arbiter itself is BUY on that side on a
//    recent closed candle and every existing risk gate passes. The arbiter and risk gates have final authority.
//  • No look-ahead: trendlines use swing points confirmed by closed bars only; break states use closed bars; the
//    forming bar is reported separately as an intrabar ATTEMPT.

import type { Candle, OiStrike } from "../types";

const r2 = (v: number) => Math.round(v * 100) / 100;
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

// ---------------------------------------------------------------- swings + trendlines (non-repainting)
export interface Swing { index: number; time: number; price: number; kind: "HIGH" | "LOW" }
/** Fractal swings with `k` bars each side. A swing at bar i exists only once bar i+k has CLOSED (all bars passed in are closed). */
export function confirmedSwings(cs: Candle[], k = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].high > cs[i - j].high && cs[i].high >= cs[i + j].high)) hi = false;
      if (!(cs[i].low < cs[i - j].low && cs[i].low <= cs[i + j].low)) lo = false;
    }
    if (hi) out.push({ index: i, time: cs[i].time, price: cs[i].high, kind: "HIGH" });
    if (lo) out.push({ index: i, time: cs[i].time, price: cs[i].low, kind: "LOW" });
  }
  return out;
}
export interface Trendline { kind: "SELLER" | "BUYER"; p1: Swing; p2: Swing; slope: number; valueNow: number; status: "INTACT" | "BROKEN"; brokeAt: number | null }
/** Seller line through the last two confirmed LOWER highs; buyer line through the last two confirmed HIGHER lows. */
export function trendlines(cs: Candle[], k = 2): { seller: Trendline | null; buyer: Trendline | null } {
  const sw = confirmedSwings(cs, k), n = cs.length;
  const build = (kind: "SELLER" | "BUYER"): Trendline | null => {
    const pts = sw.filter((s) => s.kind === (kind === "SELLER" ? "HIGH" : "LOW"));
    for (let a = pts.length - 1; a >= 1; a--) {
      const p2 = pts[a], p1 = pts[a - 1];
      if (kind === "SELLER" ? !(p2.price < p1.price) : !(p2.price > p1.price)) continue;
      const slope = (p2.price - p1.price) / (p2.index - p1.index), at = (i: number) => p1.price + slope * (i - p1.index);
      // first CLOSED bar after the line is confirmed (p2 + k) that closes through it
      let brokeAt: number | null = null;
      for (let i = p2.index + k + 1; i < n; i++) if (kind === "SELLER" ? cs[i].close > at(i) : cs[i].close < at(i)) { brokeAt = cs[i].time; break; }
      return { kind, p1, p2, slope: r2(slope), valueNow: r2(at(n - 1)), status: brokeAt ? "BROKEN" : "INTACT", brokeAt };
    }
    return null;
  };
  return { seller: build("SELLER"), buyer: build("BUYER") };
}

// ---------------------------------------------------------------- breakout / breakdown state
export type BullState = "NONE" | "PRE_BREAKOUT" | "BREAKOUT_ATTEMPT" | "CONFIRMED_BREAKOUT" | "RETEST_HOLD" | "FAILED_BREAKOUT";
export type BearState = "NONE" | "PRE_BREAKDOWN" | "BREAKDOWN_ATTEMPT" | "CONFIRMED_BREAKDOWN" | "RETEST_FAILURE" | "FAILED_BREAKDOWN";
export interface LevelsAt { resistance: number | null; support: number | null }
export interface BreakState<S> { state: S; level: number | null; barTime: number | null; intrabar: boolean; detail: string }
/**
 * `levels[i]` = the resistance/support known BEFORE closed bar i (the engine's levels from bar i−1).
 * A break = a CLOSED bar beyond the level by more than `buf` (a wick is never a break). Looks back `win` closed bars.
 */
export function breakStates(closed: Candle[], forming: Candle | null, levels: LevelsAt[], atr: number | null, buf: number, win = 6): { bull: BreakState<BullState>; bear: BreakState<BearState> } {
  const n = closed.length, near = atr != null ? 0.5 * atr : null;
  const side = (up: boolean): BreakState<any> => {
    const lv = (i: number) => (up ? levels[i]?.resistance : levels[i]?.support) ?? null;
    for (let j = n - 1; j >= Math.max(1, n - win); j--) {
      const L = lv(j); if (L == null) continue;
      const beyond = (c: Candle) => (up ? c.close > L + buf : c.close < L - buf);
      if (beyond(closed[j]) && !beyond(closed[j - 1])) {   // a FRESH cross; bars that merely stay beyond are not new breaks
        const after = closed.slice(j + 1);
        const failed = after.some((c) => (up ? c.close < L : c.close > L));
        const retest = !failed && after.some((c) => (up ? c.low <= L + buf : c.high >= L - buf));
        const st = failed ? (up ? "FAILED_BREAKOUT" : "FAILED_BREAKDOWN") : retest ? (up ? "RETEST_HOLD" : "RETEST_FAILURE") : (up ? "CONFIRMED_BREAKOUT" : "CONFIRMED_BREAKDOWN");
        const d = failed ? `closed back ${up ? "below" : "above"} ${r2(L)} after the break` : retest ? `came back to ${r2(L)} and held` : `closed ${up ? "above" : "below"} ${r2(L)} (beyond the ${r2(buf)} buffer)`;
        return { state: st, level: r2(L), barTime: closed[j].time, intrabar: false, detail: d };
      }
    }
    const L = lv(n); // level known now (before the forming bar)
    if (L == null) return { state: "NONE", level: null, barTime: null, intrabar: false, detail: `no confirmed ${up ? "resistance" : "support"}` };
    if (forming && (up ? forming.high > L : forming.low < L)) return { state: up ? "BREAKOUT_ATTEMPT" : "BREAKDOWN_ATTEMPT", level: r2(L), barTime: forming.time, intrabar: true, detail: `forming candle ${up ? "above" : "below"} ${r2(L)} — not closed yet` };
    const last = closed[n - 1];
    if (near != null && last && (up ? L - last.close <= near && L >= last.close : last.close - L <= near && L <= last.close))
      return { state: up ? "PRE_BREAKOUT" : "PRE_BREAKDOWN", level: r2(L), barTime: last.time, intrabar: false, detail: `${r2(Math.abs(L - last.close))} pts from ${up ? "resistance" : "support"} ${r2(L)}` };
    return { state: "NONE", level: r2(L), barTime: null, intrabar: false, detail: `${up ? "resistance" : "support"} ${r2(L)} not near` };
  };
  return { bull: side(true), bear: side(false) };
}

// ---------------------------------------------------------------- option premium view
export type Side = "CE" | "PE";
export interface Liquidity { bid: number | null; ask: number | null; spread: number | null; spreadPct: number | null; status: "GOOD" | "WIDE" | "POOR" | "NOT AVAILABLE"; detail: string }
export function liquidity(bid: number | null | undefined, ask: number | null | undefined, ltp: number | null | undefined, chainMedianPct: number | null, volume: number | null | undefined): Liquidity {
  if (!(bid! > 0) || !(ask! > 0) || ask! < bid!) return { bid: bid ?? null, ask: ask ?? null, spread: null, spreadPct: null, status: (ltp ?? 0) > 0 ? "NOT AVAILABLE" : "POOR", detail: "no two-sided quote" };
  const spread = ask! - bid!, mid = (ask! + bid!) / 2, pct = (spread / mid) * 100;
  // relative to today's chain (ATM ± 5 median), with a hard ceiling — wide spreads eat the premium move
  const lim = Math.max(chainMedianPct != null ? 2 * chainMedianPct : 1, 1);
  const status = pct > Math.max(lim, 3) || volume === 0 ? "POOR" : pct > lim ? "WIDE" : "GOOD";
  return { bid: r2(bid!), ask: r2(ask!), spread: r2(spread), spreadPct: r2(pct), status, detail: `spread ${r2(spread)} (${r2(pct)}% of mid; chain median ${chainMedianPct != null ? r2(chainMedianPct) + "%" : "—"})` };
}
export function chainMedianSpreadPct(strikes: OiStrike[], atm: number, step: number): number | null {
  const v: number[] = [];
  for (const s of strikes) if (Math.abs(s.strike - atm) <= 5 * step) for (const [b, a] of [[s.ceBid, s.ceAsk], [s.peBid, s.peAsk]] as const) if (b! > 0 && a! >= b!) v.push(((a! - b!) / ((a! + b!) / 2)) * 100);
  const m = median(v); return Number.isFinite(m) ? r2(m) : null;
}
/** Typical |spot move| over `bars` closed bars, from the session's own candles (median of rolling windows). */
export function typicalMove(closed: Candle[], bars: number): number | null {
  const m: number[] = []; for (let i = bars; i < closed.length; i++) m.push(Math.abs(closed[i].close - closed[i - bars].close));
  return m.length >= 10 ? median(m.slice(-60)) : null;
}
/**
 * MODEL (not a prediction): premium change if the index moves by `move` points either way over the horizon,
 * delta + ½·gamma·move², minus theta for the horizon. Needs the feed's delta; gamma/theta used when supplied.
 */
export function modelPremiumMove(o: { delta: number | null | undefined; gamma: number | null | undefined; theta: number | null | undefined; ltp: number | null }, move: number | null, horizonMin: number) {
  if (o.delta == null || move == null || !(o.ltp! > 0)) return null;
  const g = o.gamma ?? 0, th = o.theta != null ? (o.theta * horizonMin) / 375 : 0;   // feed theta is per day; 375 session minutes
  const up = o.delta * move + 0.5 * g * move * move + th, dn = -o.delta * move + 0.5 * g * move * move + th;
  const abs = (Math.abs(up) + Math.abs(dn)) / 2;
  return { ifIndexUp: r2(up), ifIndexDown: r2(dn), absPts: r2(abs), absPct: r2((abs / o.ltp!) * 100), thetaPts: r2(th), indexMove: r2(move), horizonMin };
}
/** How the premium itself is behaving on CLOSED premium candles (never the forming bar). */
export function premiumBehaviour(cs: Candle[]) {
  if (cs.length < 8) return null;
  const c = cs.map((x) => x.close), n = c.length, ret = (k: number) => (c[n - 1 - k] > 0 ? r2(((c[n - 1] / c[n - 1 - k]) - 1) * 100) : null);
  const r1s = c.slice(-21).map((v, i, a) => (i && a[i - 1] > 0 ? Math.log(v / a[i - 1]) : NaN)).slice(1);
  const mu = r1s.reduce((a, b) => a + b, 0) / r1s.length, vol = Math.sqrt(r1s.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, r1s.length - 1));
  const prev3H = Math.max(...cs.slice(-4, -1).map((x) => x.high)), prev3L = Math.min(...cs.slice(-4, -1).map((x) => x.low));
  const sw = confirmedSwings(cs, 2), lastHigh = [...sw].reverse().find((s) => s.kind === "HIGH") || null, lastLow = [...sw].reverse().find((s) => s.kind === "LOW") || null;
  return {
    last: r2(c[n - 1]), ret1: ret(1), ret3: ret(3), ret6: ret(6), realizedVolPct: Number.isFinite(vol) ? r2(vol * 100) : null,
    aboveRecentHigh: c[n - 1] > prev3H, belowRecentLow: c[n - 1] < prev3L,
    swingHigh: lastHigh ? r2(lastHigh.price) : null, swingLow: lastLow ? r2(lastLow.price) : null,
    response: c[n - 1] > prev3H ? "RISING" : c[n - 1] < prev3L ? "FALLING" : "FLAT",
  } as const;
}

// ---------------------------------------------------------------- per-option evidence state (not a probability)
export type Dir = "UP" | "DOWN" | "SIDEWAYS" | "INSUFFICIENT DATA";
export function optionDirection(side: Side, bull: BullState, bear: BearState, beh: ReturnType<typeof premiumBehaviour>): { dir: Dir; bullish: string[]; bearish: string[] } {
  if (!beh) return { dir: "INSUFFICIENT DATA", bullish: [], bearish: ["fewer than 8 closed premium candles"] };
  const up: string[] = [], dn: string[] = [];
  const idxUp = bull === "CONFIRMED_BREAKOUT" || bull === "RETEST_HOLD" || bear === "FAILED_BREAKDOWN";
  const idxDn = bear === "CONFIRMED_BREAKDOWN" || bear === "RETEST_FAILURE" || bull === "FAILED_BREAKOUT";
  const favour = side === "CE" ? idxUp : idxDn, against = side === "CE" ? idxDn : idxUp;
  if (favour) up.push(`index ${side === "CE" ? bull.replace("_", " ").toLowerCase() : bear.replace("_", " ").toLowerCase()} favours ${side}`);
  if (against) dn.push(`index structure works against ${side}`);
  if (beh.response === "RISING") up.push(`premium closed above its last 3 candles' high (${beh.ret3 ?? "—"}% over 3)`);
  if (beh.response === "FALLING") dn.push(`premium closed below its last 3 candles' low (${beh.ret3 ?? "—"}% over 3)`);
  // the premium must CONFIRM: index structure alone never makes an option UP
  const dir: Dir = favour && beh.response === "RISING" ? "UP" : (against && beh.response !== "RISING") || (beh.response === "FALLING" && !favour) ? "DOWN" : "SIDEWAYS";
  return { dir, bullish: up, bearish: dn };
}

// ---------------------------------------------------------------- master decision (exactly one state)
export type MasterState = "BUY CE CANDIDATE" | "BUY PE CANDIDATE" | "WAIT FOR BREAKOUT" | "WAIT FOR BREAKDOWN" | "WAIT FOR RETEST" | "NO EDGE"
  | "AVOID — POOR LIQUIDITY" | "AVOID — STALE DATA" | "AVOID — INSUFFICIENT DATA" | "RISK GATE BLOCKED";
export interface MasterInput {
  dataStatus: string; enoughData: boolean; chainOk: boolean;
  bull: BreakState<BullState>; bear: BreakState<BearState>;
  arbiter: { finalAction: string; candleTime: number | null; reason: string; plan: any; option: any } | null;
  nowSec: number; inTradeWindow: boolean; cooldown: { active: boolean; reason?: string } | null; openTrade: { index: string } | null;
  liq: { CE: Liquidity | null; PE: Liquidity | null };
}
export function masterDecision(m: MasterInput) {
  const gates: { name: string; ok: boolean; detail: string }[] = [
    { name: "Trade window 09:20–15:12", ok: m.inTradeWindow, detail: m.inTradeWindow ? "inside" : "outside the window (time veto)" },
    { name: "Post-stop cooldown", ok: !m.cooldown?.active, detail: m.cooldown?.active ? m.cooldown.reason || "cooldown active" : "none" },
    { name: "One open index option", ok: !m.openTrade, detail: m.openTrade ? `open trade on ${m.openTrade.index}` : "no open trade" },
  ];
  const riskOk = gates.every((g) => g.ok);
  const arbBuy = m.arbiter && /^BUY_(CE|PE)$/.test(m.arbiter.finalAction) && m.arbiter.candleTime != null && m.nowSec - m.arbiter.candleTime <= 15 * 60 ? (m.arbiter.finalAction === "BUY_CE" ? "CE" : "PE") : null;
  const out = (state: MasterState, reason: string, confirm: string | null = null) => ({ state, reason, confirmationRequired: confirm, riskGate: { ok: riskOk, gates }, arbiterSays: m.arbiter ? `${m.arbiter.finalAction} — ${m.arbiter.reason}` : "not decided yet" });
  if (/STALE|DISCONNECTED|UNAVAILABLE/.test(m.dataStatus)) return out("AVOID — STALE DATA", `Data is ${m.dataStatus}; no decision on old prices`);
  if (!m.enoughData || !m.chainOk) return out("AVOID — INSUFFICIENT DATA", !m.chainOk ? "Option chain not available" : "Not enough closed candles yet");
  if (arbBuy) {
    if (!riskOk) return out("RISK GATE BLOCKED", `Arbiter is BUY ${arbBuy} but ${gates.filter((g) => !g.ok).map((g) => g.detail).join("; ")}`);
    if (m.liq[arbBuy]?.status === "POOR") return out("AVOID — POOR LIQUIDITY", `Arbiter is BUY ${arbBuy} but the ${arbBuy} quote is poor (${m.liq[arbBuy]!.detail})`);
    return out(arbBuy === "CE" ? "BUY CE CANDIDATE" : "BUY PE CANDIDATE", `Arbiter BUY ${arbBuy} on the ${new Date((m.arbiter!.candleTime! + 19800) * 1000).toISOString().slice(11, 16)} closed candle; all risk gates pass`);
  }
  const b = m.bull.state, s = m.bear.state;
  if (b === "CONFIRMED_BREAKOUT" || s === "CONFIRMED_BREAKDOWN") return out("WAIT FOR RETEST", `${b === "CONFIRMED_BREAKOUT" ? `Breakout above ${m.bull.level}` : `Breakdown below ${m.bear.level}`} confirmed, but the arbiter is ${m.arbiter?.finalAction || "not BUY"}`, b === "CONFIRMED_BREAKOUT" ? `retest of ${m.bull.level} that holds, and arbiter BUY CE` : `retest of ${m.bear.level} that fails, and arbiter BUY PE`);
  if (b === "PRE_BREAKOUT" || b === "BREAKOUT_ATTEMPT" || b === "RETEST_HOLD") return out("WAIT FOR BREAKOUT", `${m.bull.detail}`, `a 5-min candle CLOSING above ${m.bull.level} and arbiter BUY CE`);
  if (s === "PRE_BREAKDOWN" || s === "BREAKDOWN_ATTEMPT" || s === "RETEST_FAILURE") return out("WAIT FOR BREAKDOWN", `${m.bear.detail}`, `a 5-min candle CLOSING below ${m.bear.level} and arbiter BUY PE`);
  return out("NO EDGE", b === "FAILED_BREAKOUT" || s === "FAILED_BREAKDOWN" ? `Failed ${b === "FAILED_BREAKOUT" ? "breakout" : "breakdown"} — no fresh setup` : "Price is between levels; no breakout or breakdown setup", `price near ${m.bull.level ?? "resistance"} or ${m.bear.level ?? "support"}`);
}

/** Probabilities: none validated yet (step 3). Kept as one place so the screen can never show an unvalidated number. */
export const VALIDATION = { status: "PROBABILITY NOT VALIDATED", detail: "No CE/PE premium probability has passed out-of-sample validation yet (step 3 pending: NIFTY 2-year 1-minute premium history).", lastValidated: null as string | null, sample: null as number | null };
