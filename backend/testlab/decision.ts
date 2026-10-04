// ===========================================================================
// TRADE DECISION LAYER — movement detection SEPARATE from trade execution.
// ===========================================================================
// Sequence (fixed):  PRICE -> STRUCTURE -> MOVEMENT -> DIRECTION -> ENTRY ->
//                    STOP LOSS -> TARGET -> R:R -> EXECUTION GATE
// Layer A (movement) runs on every candle and is NEVER suppressed by a gate:
// "BREAKDOWN_CONFIRMED + TRADE_BLOCKED_LATE" is a valid, recorded outcome.
// Layer B builds a structural plan only once a break is structurally confirmed
// and applies the NON-R:R gates. R:R is computed only AFTER the BUY/SELL decision
// and is information only — it never blocks, delays, changes or cancels a signal.
// 15M context (context15.ts) is the higher-timeframe view; 5M detects and times.
//
// Reuses the existing engine's per-candle rows (ATR, EMA, VWAP, volume state,
// UT, structure/BOS, swing S/R) — no indicator is recomputed differently.
// Strictly causal: the read at candle i uses candles[0..i]; levels come from
// candles before i. Decision entry = candle-i close; the outcome walk fills at
// the NEXT candle open with the shared walker (identical accounting). Post-hoc
// audit labels (genuine / missed / timing) use later candles and are OUTCOME
// only — never fed back into a decision. OI is confirmation only.

import { Candle } from "../types";
import { walkOutcomes, computeMetrics, computeDaily } from "./engine";
import { contractKey } from "./optionsData";
import { OptionSeries } from "./optionsData";
import { gammaRead, selectStrike } from "./strikeGamma";
import { Ctx15 } from "./context15";
import { validateOi } from "./oiValidation";
import {
  AuditRow, DecisionConfig, DecisionResult, DecisionRow, DecisionSummary, DecisionTiming, ExecutionState,
  MissedMove, MovementEvent, MovementState, OiFreshness, TestConfig, TradePlan,
} from "./types";

export interface DecisionInput {
  cfg: TestConfig;
  dc: DecisionConfig;
  candles: Candle[];
  rows: AuditRow[];                    // existing engine rows, aligned 1:1 with candles
  oi: (number | null)[];
  spotByTime?: Map<number, number>;    // index spot close by candle time (when the series is futures)
  options: OptionSeries | null;
  strikeStep: number;
  inScope: (sec: number) => boolean;
  liveTail?: boolean;
  ctx15?: (Ctx15 | null)[];            // 15M context per candle (last CLOSED 15M candle), aligned 1:1 with candles                  // live: the last candle's "next candle" is still to come — not a data block
}

const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);
const r2 = (x: number) => +x.toFixed(2);
const LEVEL_BARS = 300; // trailing bars scanned for target levels (~3-4 sessions on 5m)

interface Active {
  id: number; dir: "UP" | "DOWN"; level: number; breakIdx: number; confirmed: boolean;
  extreme: number; startPrice: number; firstState: MovementState; confirmIdx: number | null;
}

type Group = "DATA" | "LATE" | "DIRECTION" | "REJECTION" | "STRUCTURE" | "LIQUIDITY";   // R:R is deliberately NOT a gate group
const GROUP_ORDER: Group[] = ["DATA", "LATE", "DIRECTION", "REJECTION", "STRUCTURE", "LIQUIDITY"];
const GROUP_STATE: Record<Group, ExecutionState> = {
  DATA: "TRADE_BLOCKED_DATA", LATE: "TRADE_BLOCKED_LATE", DIRECTION: "WAIT_FOR_DIRECTION_RECONFIRMATION", REJECTION: "WAIT", STRUCTURE: "TRADE_BLOCKED_STRUCTURE",
  LIQUIDITY: "TRADE_BLOCKED_LIQUIDITY",
};
const GROUP_TIMING: Record<Group, DecisionTiming> = {
  DATA: "BLOCKED_DATA", LATE: "BLOCKED_LATE", DIRECTION: "BLOCKED_DIRECTION", REJECTION: "BLOCKED_DIRECTION", STRUCTURE: "BLOCKED_STRUCTURE", LIQUIDITY: "BLOCKED_LIQUIDITY",
};

/** Pivot highs/lows (2 bars each side, same definition as components.supportResistance). Pivot j is known at j+2. */
function pivots(c: Candle[]): { hi: boolean[]; lo: boolean[] } {
  const hi = new Array(c.length).fill(false), lo = new Array(c.length).fill(false);
  for (let j = 2; j < c.length - 2; j++) {
    hi[j] = c[j].high > c[j - 1].high && c[j].high > c[j - 2].high && c[j].high >= c[j + 1].high && c[j].high >= c[j + 2].high;
    lo[j] = c[j].low < c[j - 1].low && c[j].low < c[j - 2].low && c[j].low <= c[j + 1].low && c[j].low <= c[j + 2].low;
  }
  return { hi, lo };
}

/** Prior-session high / low / close for each candle (from candles before the session). */
function priorSessionLevels(c: Candle[]): Array<{ pdh: number; pdl: number; pdc: number } | null> {
  const out: Array<{ pdh: number; pdl: number; pdc: number } | null> = new Array(c.length).fill(null);
  let curDay = "", prev: { pdh: number; pdl: number; pdc: number } | null = null;
  let dh = -Infinity, dl = Infinity, dc = NaN;
  for (let i = 0; i < c.length; i++) {
    const d = istDate(c[i].time);
    if (d !== curDay) {
      if (curDay) prev = { pdh: dh, pdl: dl, pdc: dc };
      curDay = d; dh = -Infinity; dl = Infinity;
    }
    out[i] = prev;
    dh = Math.max(dh, c[i].high); dl = Math.min(dl, c[i].low); dc = c[i].close;
  }
  return out;
}

function trueRangeMean(c: Candle[], i: number, n = 14): number | null {
  const tr: number[] = [];
  for (let k = Math.max(1, i - n + 1); k <= i; k++) tr.push(Math.max(c[k].high - c[k].low, Math.abs(c[k].high - c[k - 1].close), Math.abs(c[k].low - c[k - 1].close)));
  return tr.length >= 3 ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
}

export function runDecisionLayer(inp: DecisionInput): DecisionResult {
  const { cfg, dc, candles: c, rows, oi } = inp;
  const n = c.length;
  const pv = pivots(c);
  const pd = priorSessionLevels(c);
  const times = c.map((x) => x.time);
  const out: DecisionRow[] = [];
  const events: MovementEvent[] = [];
  const eventById = new Map<number, MovementEvent>();
  let active: Active | null = null;
  // 5M direction-conflict protection + S/R rejection watch (added layer; new-entry permission only)
  let guard: { regime: "BULLISH" | "BEARISH"; sinceIdx: number; reason: string } | null = null;
  let rej: { type: "SUPPORT_REJECTION" | "RESISTANCE_REJECTION"; level: number; source: string; sinceIdx: number } | null = null;
  const hm = (sec: number) => { const m = istMin(sec); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  let moveSeq = 0;
  const openMin = cfg.sessionOpenMinIST ?? 555, cutoffMin = cfg.lateCutoffMinIST ?? 910;

  const endEvent = (idx: number, reason: string) => {
    if (!active) return;
    const ev = eventById.get(active.id);
    if (ev) { ev.endIso = rows[idx]?.iso ?? ev.firstIso; ev.endReason = reason; }
    active = null;
  };

  for (let i = 0; i < n; i++) {
    const bar = c[i], row = rows[i], prow = i > 0 ? rows[i - 1] : null;
    const date = istDate(bar.time);
    const newSession = i > 0 && istDate(c[i - 1].time) !== date;
    if (newSession && active) endEvent(i - 1, "SESSION END");
    const a = row.atr ?? trueRangeMean(c, i);
    const price = bar.close;
    const spot = inp.spotByTime ? (inp.spotByTime.get(bar.time) ?? null) : price;
    const evid: string[] = [];

    // ---------------- dynamic no-trade zone (box of the previous K bars) ----------------
    let zone: DecisionRow["noTradeZone"] = null;
    let zoneInvalidated = false;
    const K = dc.zoneLookback;
    const aPrev = prow?.atr ?? (i > 0 ? trueRangeMean(c, i - 1) : null);
    if (i >= K && aPrev && istDate(c[i - K].time) === date) {
      const box = c.slice(i - K, i);
      const hi = Math.max(...box.map((x) => x.high)), lo = Math.min(...box.map((x) => x.low));
      const flat = prow?.emaSpreadATR == null || prow.emaSpreadATR < 0.3;
      if (hi - lo <= dc.zoneMaxAtr * aPrev && flat) {
        zone = { low: r2(lo), high: r2(hi), source: `${K}-bar balance box ${(((hi - lo) / aPrev)).toFixed(1)} ATR, EMA spread flat (OI walls not available historically)` };
      }
    }

    // ---------------- levels as of the previous candle ----------------
    let breakoutLevel: number | null = null, breakdownLevel: number | null = null;
    if (prow) {
      const pc = c[i - 1].close;
      const ups = [prow.resistance, pd[i]?.pdh ?? null, zone?.high ?? null].filter((x): x is number => x != null && x > pc);
      const dns = [prow.support, pd[i]?.pdl ?? null, zone?.low ?? null].filter((x): x is number => x != null && x < pc);
      breakoutLevel = ups.length ? Math.min(...ups) : null;
      breakdownLevel = dns.length ? Math.max(...dns) : null;
    }

    // ---------------- displacement ----------------
    const body = bar.close - bar.open, rng = bar.high - bar.low;
    const loc = rng > 0 ? (bar.close - bar.low) / rng : 0.5;
    const bearStrong = !!a && -body >= dc.dispStrongAtr * a && loc <= dc.closeLocMax;
    const bullStrong = !!a && body >= dc.dispStrongAtr * a && loc >= 1 - dc.closeLocMax;
    const pc = i > 0 ? c[i - 1].close : bar.open;

    // ---------------- Layer A: movement state machine ----------------
    let state: MovementState = "NO_EDGE";
    let failed = false;
    if (active) {
      const act: Active = active;
      const down = act.dir === "DOWN";
      const reclaimed = down ? price > act.level : price < act.level;
      // a balance box that formed entirely AFTER the break means the move has
      // stopped: end it (the next break of the box starts a fresh event)
      const balanced = !!zone && i - K >= act.breakIdx && price >= zone.low && price <= zone.high;
      if (!reclaimed && balanced) {
        state = "NO_EDGE"; evid.push(`move stalled — balance box ${zone!.low}-${zone!.high} formed after the break`);
        endEvent(i, "BALANCE"); failed = true;
      } else if (reclaimed) {
        state = i - act.breakIdx <= dc.falseBreakBars ? (down ? "FALSE_BREAKDOWN" : "FALSE_BREAKOUT") : "REVERSAL";
        evid.push(`closed back ${down ? "above" : "below"} broken level ${r2(act.level)}`);
        endEvent(i, state); failed = true;
      } else {
        const lvl = down ? breakdownLevel : breakoutLevel;
        const freshCross = lvl != null && (down ? price < lvl && pc >= lvl : price > lvl && pc <= lvl);
        if (freshCross) { act.level = lvl as number; evid.push(`broke next level ${r2(lvl as number)}`); }
        const strong = down ? bearStrong : bullStrong;
        const followThrough = down ? price < pc && body < 0 : price > pc && body > 0;
        if (!act.confirmed) {
          if (strong || followThrough) { act.confirmed = true; act.confirmIdx = i; state = down ? "BREAKDOWN_CONFIRMED" : "BREAKOUT_CONFIRMED"; evid.push(strong ? "strong displacement" : "follow-through close"); }
          else if (i - act.breakIdx > dc.falseBreakBars) { endEvent(i, "NO FOLLOW-THROUGH"); state = "NO_EDGE"; failed = true; }
          else state = down ? "BREAKDOWN_ATTEMPT" : "BREAKOUT_ATTEMPT";
        } else {
          const newExtreme = down ? price < act.extreme : price > act.extreme;
          state = newExtreme && (down ? body < 0 : body > 0) ? "EXPANSION" : (down ? "BREAKDOWN_CONFIRMED" : "BREAKOUT_CONFIRMED");
        }
        if (active) act.extreme = down ? Math.min(act.extreme, price) : Math.max(act.extreme, price);
      }
    }
    if (!active && !failed) {
      const dnCross = breakdownLevel != null && price < breakdownLevel && pc >= breakdownLevel;
      const upCross = breakoutLevel != null && price > breakoutLevel && pc <= breakoutLevel;
      if (dnCross || upCross) {
        const down = dnCross;
        const strong = down ? bearStrong : bullStrong;
        moveSeq++;
        state = down ? (strong ? "BREAKDOWN_CONFIRMED" : "BREAKDOWN_ATTEMPT") : (strong ? "BREAKOUT_CONFIRMED" : "BREAKOUT_ATTEMPT");
        active = { id: moveSeq, dir: down ? "DOWN" : "UP", level: (down ? breakdownLevel : breakoutLevel) as number, breakIdx: i, confirmed: strong, extreme: price, startPrice: price, firstState: state, confirmIdx: strong ? i : null };
        if (zone) { zoneInvalidated = true; evid.push(`no-trade zone ${zone.low}-${zone.high} invalidated`); }
        evid.push(`closed ${down ? "below" : "above"} ${r2(active.level)}${strong ? " with strong displacement" : ""}`);
        const ev: MovementEvent = {
          moveId: moveSeq, direction: down ? "BEARISH" : "BULLISH", firstIso: row.iso, firstState: state,
          confirmIso: strong ? row.iso : null, level: r2(active.level), startPrice: price, endIso: row.iso, endReason: "OPEN",
          mfeAtr: null, genuine: false, candidateBars: 0, readyBars: 0, blockCounts: {}, executed: false, tradeOutcome: null, tradeR: null, timing: "NA",
        };
        events.push(ev); eventById.set(moveSeq, ev);
      } else if (breakdownLevel != null && bar.low < breakdownLevel && price >= breakdownLevel) {
        state = "FALSE_BREAKDOWN"; evid.push(`swept ${r2(breakdownLevel)} and closed back above`);
      } else if (breakoutLevel != null && bar.high > breakoutLevel && price <= breakoutLevel) {
        state = "FALSE_BREAKOUT"; evid.push(`swept ${r2(breakoutLevel)} and closed back below`);
      } else if (a) {
        const bearP = [row.vwap != null && price < row.vwap, row.emaDirection === "DOWN", row.utState === "BEARISH"].filter(Boolean).length;
        const bullP = [row.vwap != null && price > row.vwap, row.emaDirection === "UP", row.utState === "BULLISH"].filter(Boolean).length;
        const dDn = breakdownLevel != null ? price - breakdownLevel : Infinity;
        const dUp = breakoutLevel != null ? breakoutLevel - price : Infinity;
        const nearDn = dDn <= dc.preLevelAtr * a && bearP >= 2, nearUp = dUp <= dc.preLevelAtr * a && bullP >= 2;
        if (nearDn && (!nearUp || dDn <= dUp)) { state = "PRE_BREAKDOWN"; evid.push(`${r2(dDn)} pts above ${r2(breakdownLevel as number)} with bearish pressure`); }
        else if (nearUp) { state = "PRE_BREAKOUT"; evid.push(`${r2(dUp)} pts below ${r2(breakoutLevel as number)} with bullish pressure`); }
        else if (zone && price >= zone.low && price <= zone.high) evid.push(`inside no-trade zone ${zone.low}-${zone.high}`);
      }
    }

    const act = active as Active | null;
    const direction: DecisionRow["movementDirection"] = act ? (act.dir === "UP" ? "BULLISH" : "BEARISH")
      : state === "PRE_BREAKOUT" ? "BULLISH" : state === "PRE_BREAKDOWN" ? "BEARISH" : "NEUTRAL";

    // movement evidence score (0-100, NOT a probability)
    let score = 0;
    if (direction !== "NEUTRAL") {
      const up = direction === "BULLISH";
      if (up ? bullStrong : bearStrong) score += 25;
      score += row.volumeState === "EXPANSION" ? 20 : row.volumeState === "NORMAL" ? 10 : 0;
      if (row.emaDirection === (up ? "UP" : "DOWN")) score += 20;
      if (row.vwap != null && (up ? price > row.vwap : price < row.vwap)) score += 15;
      if (row.bos.includes(up ? "UP" : "DOWN")) score += 20;
    }

    // ---------------- OI (confirmation only; never gates detection) ----------------
    let oiStatus: OiFreshness = "UNAVAILABLE", oiAge: number | null = null;
    if (oi[i] != null) { oiStatus = inp.liveTail && i === n - 1 ? "LIVE" : "FRESH"; oiAge = 0; }
    else { for (let k = 1; k <= 12 && i - k >= 0; k++) if (oi[i - k] != null) { oiAge = k; oiStatus = k === 1 ? "AGING" : k === 2 ? "DELAYED" : "STALE"; break; } }
    let oiConf: DecisionRow["oiConfirmation"] = "UNAVAILABLE";
    if (oi[i] != null && i > 0 && oi[i - 1] != null && direction !== "NEUTRAL") {
      const dOi = (oi[i] as number) - (oi[i - 1] as number), dP = price - pc;
      const up = direction === "BULLISH";
      oiConf = dOi > 0 && (up ? dP > 0 : dP < 0) ? "SUPPORTS" : dOi > 0 && (up ? dP < 0 : dP > 0) ? "CONTRADICTS" : "NEUTRAL";
    }

    // ---------------- Layer B: plan + gates (only after structural confirmation) ----------------
    let plan: TradePlan | null = null;
    let planCore: Omit<TradePlan, "rr" | "rrWarning"> | null = null;
    const ctx = inp.ctx15?.[i] ?? null;
    const reg15 = ctx?.regime ?? "NEUTRAL";
    const contextWarning = direction === "BEARISH" && reg15 === "BULLISH" ? "BEARISH MOVEMENT vs 15M BULLISH — reversal warning"
      : direction === "BULLISH" && reg15 === "BEARISH" ? "BULLISH MOVEMENT vs 15M BEARISH — short-covering warning"
      : direction !== "NEUTRAL" && reg15 !== "BULLISH" && reg15 !== "BEARISH" ? `15M ${reg15} — needs stronger 5M confirmation` : null;
    let option: DecisionRow["option"] = null;
    const reasons: { g: Group; r: string }[] = [];
    const oiVal = validateOi({ series: inp.options, times, i, spot, direction });

    // ---------------- 5M direction-conflict protection (added layer) ----------------
    // A 5M candle whose body fully engulfs the previous candle AGAINST the 15M context
    // raises a conflict. It never changes the 15M regime. It is cleared only by the
    // EXISTING engines: the 5M movement/structure re-confirming the 15M direction, or
    // the 15M regime engine itself changing.
    let guardState: DecisionRow["guardState"] = null;
    let reconStatus: DecisionRow["reconfirmationStatus"] = "NONE";
    let conflictReason: string | null = null, prevRegime: string | null = null;
    const candleDir: DecisionRow["current5mDirection"] = bar.close > bar.open ? "BULLISH" : bar.close < bar.open ? "BEARISH" : "FLAT";
    if (dc.directionGuard) {
      if (newSession && (guard || rej)) { guard = null; rej = null; reconStatus = "SESSION_RESET"; }
      if (guard) {
        const g0: { regime: "BULLISH" | "BEARISH"; sinceIdx: number; reason: string } = guard;
        prevRegime = g0.regime; conflictReason = g0.reason;
        const origUp = g0.regime === "BULLISH";
        if (reg15 !== g0.regime) {
          reconStatus = reg15 === (origUp ? "BEARISH" : "BULLISH") ? "REGIME_CHANGE_CONFIRMED" : "CONTEXT_CHANGED";
          if (reconStatus === "REGIME_CHANGE_CONFIRMED") guardState = "REGIME_CHANGE_CONFIRMED";
          guard = null;
        } else {
          // a FRESH confirmation by the existing engine after the conflict candle — not the
          // "still confirmed" label it keeps on every candle of an ongoing move
          const freshConfirm = !!act && act.confirmIdx === i && i > g0.sinceIdx;
          const freshLevel = evid.some((e) => e.startsWith("broke next level"));
          const moveConfirms = direction === (origUp ? "BULLISH" : "BEARISH") && i > g0.sinceIdx && (state === "EXPANSION" || freshConfirm || freshLevel);
          const bosTag = origUp ? "CONFIRMED-UP" : "CONFIRMED-DOWN";
          const structureConfirms = row.bos === bosTag && i > g0.sinceIdx && rows[i - 1].bos !== bosTag;
          if (moveConfirms || structureConfirms) { reconStatus = "DIRECTION_RECONFIRMED"; guardState = "DIRECTION_RECONFIRMED"; guard = null; }
          else { reconStatus = "PENDING"; guardState = "WAIT_FOR_DIRECTION_RECONFIRMATION"; }
        }
      }
      if (!guard && i > 0 && (reg15 === "BULLISH" || reg15 === "BEARISH") && guardState !== "DIRECTION_RECONFIRMED") {
        const pc0 = c[i - 1];
        const pBody = Math.abs(pc0.close - pc0.open), cBody = Math.abs(bar.close - bar.open);
        const bearEngulf = pc0.close > pc0.open && bar.close < bar.open && bar.open >= pc0.close && bar.close <= pc0.open && cBody > pBody;
        const bullEngulf = pc0.close < pc0.open && bar.close > bar.open && bar.open <= pc0.close && bar.close >= pc0.open && cBody > pBody;
        if ((reg15 === "BULLISH" && bearEngulf) || (reg15 === "BEARISH" && bullEngulf)) {
          conflictReason = `${reg15 === "BULLISH" ? "bearish" : "bullish"} 5M candle engulfed the previous ${reg15 === "BULLISH" ? "green" : "red"} candle against 15M ${reg15} (${hm(bar.time)})`;
          guard = { regime: reg15, sinceIdx: i, reason: conflictReason };
          prevRegime = reg15; guardState = "5M_DIRECTION_CONFLICT"; reconStatus = "PENDING";
        }
      }
    }

    // ---------------- Support / Resistance rejection (added layer; existing levels) ----------------
    let srEvent: DecisionRow["supportResistanceEvent"] = null, srLevel: number | null = null, rejType: string | null = null;
    let rejStatus: DecisionRow["rejectionStatus"] = null;
    let rejectionNow = false;
    if (dc.directionGuard && a) {
      if (rej) {
        const r0: { type: "SUPPORT_REJECTION" | "RESISTANCE_REJECTION"; level: number; source: string; sinceIdx: number } = rej;
        const resist = r0.type === "RESISTANCE_REJECTION";
        srEvent = r0.type; srLevel = r0.level; rejType = r0.source;
        if (resist ? price > r0.level : price < r0.level) {
          // resistance reclaimed => idea rejected; support lost => existing breakdown logic takes over
          rejStatus = resist ? "RECLAIMED" : "FAILED"; rej = null;
        } else if (direction === (resist ? "BEARISH" : "BULLISH") && (state === (resist ? "BREAKDOWN_CONFIRMED" : "BREAKOUT_CONFIRMED") || state === "EXPANSION")) {
          rejStatus = "CONFIRMED"; rej = null;   // existing 5M confirmation: existing entry logic decides
        } else rejStatus = "WATCH";
      }
      if (!rej && rejStatus !== "CONFIRMED") {
        const basisNow = spot != null ? price - spot : 0;
        const sessStart = (() => { let k = i; while (k > 0 && istDate(c[k - 1].time) === date) k--; return k; })();
        const orBars = c.slice(sessStart, i + 1).filter((x) => istMin(x.time) < (cfg.sessionOpenMinIST ?? 555) + 15);
        const orDone = istMin(bar.time) >= (cfg.sessionOpenMinIST ?? 555) + 15 && orBars.length > 0;
        const resLv: [number, string][] = [], supLv: [number, string][] = [];
        if (breakoutLevel != null) resLv.push([breakoutLevel, "5M swing / box resistance"]);
        if (breakdownLevel != null) supLv.push([breakdownLevel, "5M swing / box support"]);
        if (ctx?.resistance != null) resLv.push([ctx.resistance, "15M resistance"]);
        if (ctx?.support != null) supLv.push([ctx.support, "15M support"]);
        if (pd[i]) { resLv.push([pd[i]!.pdh, "previous-day high"]); supLv.push([pd[i]!.pdl, "previous-day low"]); }
        if (orDone) { resLv.push([Math.max(...orBars.map((x) => x.high)), "opening-range high"]); supLv.push([Math.min(...orBars.map((x) => x.low)), "opening-range low"]); }
        if (oiVal.walls.ce != null) resLv.push([oiVal.walls.ce + basisNow, `CE OI wall ${oiVal.walls.ce}`]);
        if (oiVal.walls.pe != null) supLv.push([oiVal.walls.pe + basisNow, `PE OI wall ${oiVal.walls.pe}`]);
        const body = Math.abs(bar.close - bar.open);
        const upW = bar.high - Math.max(bar.open, bar.close), dnW = Math.min(bar.open, bar.close) - bar.low;
        const tol = 0.1 * a;
        const pcl = i > 0 ? c[i - 1].close : bar.open;
        const resHit = resLv.filter(([L]) => bar.high >= L - tol && price < L && pcl < L && upW >= 0.2 * a && upW >= 0.5 * body).sort((x, y) => Math.abs(bar.high - x[0]) - Math.abs(bar.high - y[0]))[0];
        const supHit = supLv.filter(([L]) => bar.low <= L + tol && price > L && pcl > L && dnW >= 0.2 * a && dnW >= 0.5 * body).sort((x, y) => Math.abs(bar.low - x[0]) - Math.abs(bar.low - y[0]))[0];
        // the existing FALSE_BREAKOUT / FALSE_BREAKDOWN sweep states are the same event — reuse them, no duplicate state
        const viaFalse = state === "FALSE_BREAKOUT" && breakoutLevel != null ? ["RESISTANCE_REJECTION", breakoutLevel, "false breakout (existing state)"] as const
          : state === "FALSE_BREAKDOWN" && breakdownLevel != null ? ["SUPPORT_REJECTION", breakdownLevel, "false breakdown (existing state)"] as const : null;
        const pick = resHit && (!supHit || upW >= dnW) ? ["RESISTANCE_REJECTION", resHit[0], `wick rejection at ${resHit[1]}`] as const
          : supHit ? ["SUPPORT_REJECTION", supHit[0], `wick rejection at ${supHit[1]}`] as const : viaFalse;
        if (pick) {
          rej = { type: pick[0], level: +pick[1].toFixed(2), source: pick[2], sinceIdx: i };
          srEvent = pick[0]; srLevel = rej.level; rejType = pick[2]; rejStatus = "NEW"; rejectionNow = true;
        }
      }
      if (rejectionNow && !guardState) guardState = srEvent;
    }
    const isCandidate = !!act && act.confirmed && (state === "BREAKDOWN_CONFIRMED" || state === "BREAKOUT_CONFIRMED" || state === "EXPANSION");
    if (isCandidate && a) {
      const up = act!.dir === "UP";
      const entry = price;
      const invalidation = act!.level;
      const sl = r2(up ? invalidation - cfg.slAtrBuffer * a : invalidation + cfg.slAtrBuffer * a);
      const risk = r2(up ? entry - sl : sl - entry);
      // candidate target levels: confirmed pivots + prior-session H/L/C, in the trade direction
      const lv: number[] = [];
      const allLv: number[] = [];   // pivots both sides + prior-session H/L/C: for next resistance / support
      for (let j = Math.max(0, i - LEVEL_BARS); j <= i - 2; j++) {
        if (up && pv.hi[j]) lv.push(c[j].high); if (!up && pv.lo[j]) lv.push(c[j].low);
        if (pv.hi[j]) allLv.push(c[j].high); if (pv.lo[j]) allLv.push(c[j].low);
      }
      const p0 = pd[i]; if (p0) { lv.push(p0.pdh, p0.pdl, p0.pdc); allLv.push(p0.pdh, p0.pdl, p0.pdc); }
      const uniq = [...new Set(allLv.map(r2))];
      // nearest two DISTINCT levels each side (levels within 0.25 ATR of the previous pick are the same zone)
      const pick2 = (xs: number[]) => xs.reduce((acc: number[], x) => (acc.length < 2 && (!acc.length || Math.abs(x - acc[acc.length - 1]) >= 0.25 * a) ? [...acc, x] : acc), []);
      const nextResistance = pick2(uniq.filter((x) => x > entry).sort((x, y) => x - y));
      const nextSupport = pick2(uniq.filter((x) => x < entry).sort((x, y) => y - x));
      const ahead = [...new Set(lv.filter((x) => (up ? x > entry : x < entry)).map(r2))].sort((x, y) => (up ? x - y : y - x));
      const minD = dc.targetMinAtr * a, capD = cfg.targetAtrMult * a;
      const obstacles = ahead.filter((x) => Math.abs(x - entry) < minD);
      const t1Level = ahead.find((x) => Math.abs(x - entry) >= minD);
      let t1: number, t1Src: string;
      if (t1Level != null && Math.abs(t1Level - entry) <= capD) { t1 = t1Level; t1Src = `next structural level ${t1Level}`; }
      else { t1 = r2(up ? entry + capD : entry - capD); t1Src = t1Level != null ? `ATR×${cfg.targetAtrMult} projection (next level ${t1Level} is beyond it)` : `ATR×${cfg.targetAtrMult} projection (no level ahead)`; }
      const reward = r2(Math.abs(t1 - entry));
      const extCap = up ? entry + reward * 1.6 : entry - reward * 1.6;
      const t2Level = ahead.find((x) => (up ? x > t1 + 0.5 * a && x <= extCap : x < t1 - 0.5 * a && x >= extCap));
      const t2 = t2Level != null ? t2Level : r2(extCap);
      const t2Src = t2Level != null ? `next structural level ${t2Level}` : "1.6× T1 extension";
      planCore = {
        direction: up ? "BULLISH" : "BEARISH", side: up ? "BUY" : "SELL", entry: r2(entry), stopLoss: sl,
        invalidation: r2(invalidation), invalidationSource: `broken level ${r2(invalidation)} (+${cfg.slAtrBuffer} ATR buffer): a close back through it fails the move`,
        target1: r2(t1), target1Source: t1Src, target2: r2(t2), target2Source: t2Src,
        riskPoints: risk, rewardPoints: reward, obstacles, basis: spot != null ? r2(price - spot) : null,
        nextResistance, nextSupport,
      };
      option = selectStrike({ series: inp.options, side: up ? "CE" : "PE", time: bar.time, prevTime: i > 0 ? c[i - 1].time : null, spot, rewardPts: reward, riskPts: Math.max(0, risk), dc, strikeStep: inp.strikeStep });

      // gates — every failing reason is kept; the first by priority names the state
      if (row.dataQualityReasons.includes("INVALID CANDLE")) reasons.push({ g: "DATA", r: "INVALID CANDLE" });
      if (i < cfg.minHistory) reasons.push({ g: "DATA", r: `INSUFFICIENT HISTORY (${i}/${cfg.minHistory} candles)` });
      if (row.dataQualityReasons.includes("INVALID_FUTURES_BINDING")) reasons.push({ g: "DATA", r: "INVALID FUTURES BINDING" });
      if (!c[i + 1] && !inp.liveTail) reasons.push({ g: "DATA", r: "NO EXECUTABLE (NEXT) CANDLE" });
      const m = istMin(bar.time);
      if (m < openMin) reasons.push({ g: "LATE", r: "OUTSIDE SESSION" });
      if (m >= cutoffMin) reasons.push({ g: "LATE", r: `LATE CUTOFF (>= ${String(Math.floor(cutoffMin / 60)).padStart(2, "0")}:${String(cutoffMin % 60).padStart(2, "0")} IST)` });
      // added layer — new-entry permission only (open trades are never touched)
      if (dc.directionGuard && guard) {
        const origUp = guard.regime === "BULLISH";
        reasons.push({ g: "DIRECTION", r: up === origUp
          ? `5M DIRECTION CONFLICT — new ${up ? "BUY CE" : "BUY PE"} waits for reconfirmation (${guard.reason})`
          : `5M DIRECTION CONFLICT — no ${up ? "BUY CE" : "BUY PE"} until the 15M regime itself changes (15M still ${guard.regime})` });
      }
      if (dc.directionGuard && rejectionNow && (srEvent === "RESISTANCE_REJECTION" ? !up : up))
        reasons.push({ g: "REJECTION", r: `WAIT — ${srEvent === "RESISTANCE_REJECTION" ? "RESISTANCE" : "SUPPORT"} REJECTION at ${srLevel} (${rejType}): needs 5M confirmation first` });
      if (!(risk > 0)) reasons.push({ g: "STRUCTURE", r: "INVALID STRUCTURE (risk <= 0)" });
      if (row.extendedMove === "EXTENDED") reasons.push({ g: "STRUCTURE", r: `EXTENDED MOVE (> ${cfg.extendedAtrMult} ATR from EMA${cfg.emaFast})` });
      const prior = c.slice(Math.max(0, i - 6), i);
      if (prior.length >= 3) {
        const ph = Math.max(...prior.map((x) => x.high)), pl = Math.min(...prior.map((x) => x.low));
        const trapAgainst = !(cfg.ablationDisable || []).includes("FAKE_MOVE") && (up ? bar.high > ph && price < ph : bar.low < pl && price > pl);
        if (trapAgainst) reasons.push({ g: "STRUCTURE", r: up ? "FAKE MOVE (bull trap on this bar)" : "FAKE MOVE (bear trap on this bar)" });
      }
      if (row.isExpiryDay && row.expiryRisk === "HIGH") reasons.push({ g: "STRUCTURE", r: "EXPIRY DAY RISK" });
      if (dc.requireEngineAgreement) {
        // same lean rule the existing engine uses (score >= threshold and >= opposite + 10)
        const lean = up ? row.buyScore >= cfg.buyThreshold && row.buyScore >= row.sellScore + 10
                        : row.sellScore >= cfg.sellThreshold && row.sellScore >= row.buyScore + 10;
        if (!lean) reasons.push({ g: "STRUCTURE", r: `ENGINE SCORE DOES NOT AGREE (buy ${row.buyScore} / sell ${row.sellScore})` });
      }
      // 15M + 5M arbitration: a break WITH the 15M context uses the normal 5M confirmation;
      // against it (or in RANGE / TRANSITION / NEUTRAL) it needs a strong 5M candle. The movement itself is never hidden.
      const aligned = up ? reg15 === "BULLISH" : reg15 === "BEARISH";
      if (!aligned) {
        const strongNow = (up ? bullStrong : bearStrong) || (state === "EXPANSION" && row.volumeState === "EXPANSION");
        if (!strongNow) reasons.push({ g: "STRUCTURE", r: `15M ${reg15} vs ${up ? "upside" : "downside"} break — needs a strong 5M candle (body >= ${dc.dispStrongAtr} ATR, close in outer ${Math.round(dc.closeLocMax * 100)}%)` });
      }
      if (option.status === "AVAILABLE" && !option.primary) reasons.push({ g: "LIQUIDITY", r: "NO LIQUID STRIKE" });
    } else if (isCandidate && !a) {
      reasons.push({ g: "DATA", r: "ATR UNAVAILABLE" });
    }

    // execution state
    let exec: ExecutionState;
    let blockReason: string | null = null;
    if (isCandidate) {
      const order: Group[] = GROUP_ORDER;
      const first = order.map((g) => reasons.find((x) => x.g === g)).find(Boolean);
      if (first) { exec = GROUP_STATE[first.g]; blockReason = first.r; }
      else exec = act!.dir === "UP" ? "BUY_READY" : "SELL_READY";
    } else {
      exec = state === "FALSE_BREAKDOWN" || state === "FALSE_BREAKOUT" ? "WAIT"
        : state === "EXPANSION" ? "WAIT" : (state as ExecutionState);
    }

    // R:R — calculated ONLY after the BUY/SELL decision above. Information only: it is not read by any gate.
    if (planCore) {
      const rr = planCore.riskPoints > 0 ? +(planCore.rewardPoints / planCore.riskPoints).toFixed(2) : 0;
      plan = { ...planCore, rr, rrWarning: rr < cfg.rrMin ? `⚠ LOW R:R ${rr.toFixed(2)} (below ${cfg.rrMin.toFixed(2)}) — information only, signal unchanged` : null };
    }

    // gamma: both sides every candle (early BUILD detection), trade side named on the card
    const spotPrev = i > 0 ? (inp.spotByTime ? (inp.spotByTime.get(c[i - 1].time) ?? null) : c[i - 1].close) : null;
    const gArgs = { series: inp.options, times, i, spot, spotPrev, atr: a, strikeStep: inp.strikeStep, movementState: state, movementDirection: direction, dc };
    const tradeStrike = option?.primary?.strike ?? null;
    const gammaCall = gammaRead({ ...gArgs, side: "CE", strike: plan?.side === "BUY" ? tradeStrike : null });
    const gammaPut = gammaRead({ ...gArgs, side: "PE", strike: plan?.side === "SELL" ? tradeStrike : null });
    const gamma = direction === "BULLISH" ? gammaCall : direction === "BEARISH" ? gammaPut : null;

    const momentum = row.emaSpreadATR == null ? "UNKNOWN"
      : `${row.emaDirection === "FLAT" ? "FLAT" : (row.emaSpreadATR > 0.5 ? "STRONG_" : "") + row.emaDirection}`;
    const liq = option?.primary ? `OK (vol ${option.primary.volume}, OI ${option.primary.oi})` : option?.status === "AVAILABLE" ? "THIN" : "UNAVAILABLE";

    const liquidityGrade: DecisionRow["liquidityGrade"] = !option ? null
      : option.status !== "AVAILABLE" ? "DATA UNAVAILABLE" : option.primary && option.alternative ? "GOOD" : option.primary ? "WARNING" : "POOR";

    // Reversal Risk Area — a WARNING (never a blocker): counts independent exhaustion signs against the move
    let reversalRisk: DecisionRow["reversalRisk"] = null;
    if (direction !== "NEUTRAL" && a) {
      const up = direction === "BULLISH", f: string[] = [];
      const lvl15 = up ? ctx?.resistance : ctx?.support;
      if (lvl15 != null && Math.abs(lvl15 - price) <= 0.5 * a) f.push(`15M ${up ? "resistance" : "support"} ${lvl15} within 0.5 ATR`);
      const lvl5 = up ? row.resistance : row.support;
      if (lvl5 != null && Math.abs(lvl5 - price) <= 0.5 * a && lvl5 !== lvl15) f.push(`5M ${up ? "resistance" : "support"} ${lvl5} within 0.5 ATR`);
      const wall = up ? oiVal.walls.ce : oiVal.walls.pe;
      if (wall != null && spot != null && (up ? wall - spot : spot - wall) >= 0 && Math.abs(wall - spot) <= inp.strikeStep) f.push(`${up ? "CE" : "PE"} OI wall ${wall} next to price`);
      const sp2 = i >= 2 ? rows[i - 2].emaSpread : null;
      if (row.emaSpread != null && sp2 != null && (up ? row.emaSpread < sp2 : row.emaSpread > sp2)) f.push("momentum weakening (EMA spread narrowing)");
      if (row.volumeState === "WEAK") f.push("volume fading");
      const g = up ? gammaCall : gammaPut;
      if (g && g.evidence.underlyingDisplacement === "PASS" && g.evidence.premiumAcceleration === "FAIL") f.push("option premium not following price");
      if (g && g.evidence.ivExpansion === "FAIL" && g.evidence.premiumAcceleration === "FAIL" && state === "EXPANSION") f.push("premium / IV flat during expansion");
      if (out.slice(Math.max(0, i - 3), i).some((d) => /FALSE|REVERSAL/.test(d.movementState))) f.push("recent failed break");
      if (contextWarning && !contextWarning.startsWith("15M")) f.push("against 15M context");
      if (oiVal.state === "OI_REVERSAL_WATCH") f.push("OI writing against the move");
      reversalRisk = { level: f.length >= 4 ? "HIGH" : f.length >= 2 ? "MEDIUM" : "LOW", factors: f };
    }

    const dRow: DecisionRow = {
      timestamp: bar.time, iso: row.iso, date, price, spot,
      atr: a != null ? r2(a) : null,
      movementState: state, movementDirection: direction, movementScore: score, movementEvidence: evid,
      moveId: act ? act.id : (failed ? moveSeq : null),
      breakoutLevel: breakoutLevel != null ? r2(breakoutLevel) : null, breakdownLevel: breakdownLevel != null ? r2(breakdownLevel) : null,
      brokenLevel: act ? r2(act.level) : null,
      noTradeZone: zone, zoneInvalidated,
      plan, option, gamma, gammaCall, gammaPut,
      oiStatus, oiAgeBars: oiAge, oiConfirmation: oiConf,
      regime15: reg15, ctx15: ctx, contextWarning, reversalRisk, oiValidation: oiVal, liquidityGrade,
      guardState, directionConflict: guardState === "5M_DIRECTION_CONFLICT" || guardState === "WAIT_FOR_DIRECTION_RECONFIRMATION",
      directionConflictReason: conflictReason, previousRegime: prevRegime, current5mDirection: candleDir,
      reconfirmationRequired: reconStatus === "PENDING", reconfirmationStatus: reconStatus,
      supportResistanceEvent: srEvent, supportResistanceLevel: srLevel, rejectionType: rejType, rejectionStatus: rejStatus,
      entryBlockedReason: planCore && exec !== "BUY_READY" && exec !== "SELL_READY" ? blockReason : null,
      oiStatusLabel: oiStatus === "STALE" || oiStatus === "UNAVAILABLE" ? "STALE"
        : oiConf === "CONTRADICTS" || oiVal.state === "OI_REVERSAL_WATCH" ? "CONTRADICTING"
        : oiVal.state === "OI_CONFIRMED" ? "CONFIRMED" : oiConf === "SUPPORTS" ? "SUPPORTING" : "UNCONFIRMED",
      rrStatus: plan ? (plan.rr >= cfg.rrMin ? "GOOD" : "WARNING") : null,
      volumeState: row.volumeState, momentumState: momentum, structureState: `${row.structureState} · BOS ${row.bos}`,
      vwapState: row.vwap == null ? "UNKNOWN" : price > row.vwap ? "ABOVE" : price < row.vwap ? "BELOW" : "AT",
      emaState: `${row.emaDirection} (price ${row.priceVsEMA} EMA${cfg.emaFast})`, liquidityState: liq,
      executionState: exec, action: exec === "BUY_READY" || exec === "SELL_READY" ? "TAKE" : "WAIT",
      blockReason, blockReasons: reasons.map((x) => x.r), timingClassification: "NA",
      fillPrice: null, outcome: "NONE", rMultiple: null, exitPrice: null, exitIso: null,
      finalAction: exec === "BUY_READY" ? "BUY CE" : exec === "SELL_READY" ? "BUY PE" : "WAIT",
      optionFill: null, optionExit: null, optionPnl: null,
    };
    out.push(dRow);

    // per-event bookkeeping (in-scope only)
    if (act && isCandidate && inp.inScope(bar.time)) {
      const ev = eventById.get(act.id)!;
      ev.candidateBars++;
      if (dRow.action === "TAKE") ev.readyBars++;
      else {
        const g = GROUP_ORDER.find((gg) => reasons.some((x) => x.g === gg));
        if (g) ev.blockCounts[g] = (ev.blockCounts[g] || 0) + 1;
      }
      if (act.confirmIdx === i && !ev.confirmIso) ev.confirmIso = row.iso;
    }
  }
  if (active) endEvent(n - 1, "DATA END");

  // gate-block tally on candidate bars, taken BEFORE HOLD marking overwrites state
  const blocks: Record<string, number> = {};
  out.forEach((d) => {
    if (!d.plan || !inp.inScope(d.timestamp)) return;
    const k = d.executionState.startsWith("TRADE_BLOCKED_") ? d.executionState.replace("TRADE_BLOCKED_", "")
      : d.executionState === "WAIT_FOR_DIRECTION_RECONFIRMATION" ? "DIRECTION_CONFLICT"
      : d.executionState === "WAIT" && /REJECTION at/.test(d.blockReason ?? "") ? "SR_REJECTION" : null;
    if (k) blocks[k] = (blocks[k] || 0) + 1;
  });

  // ---------------- forward walk (shared walker, identical accounting) ----------------
  const pseudo: AuditRow[] = rows.map((r, i) => {
    const d = out[i];
    const ready = d.action === "TAKE" && inp.inScope(d.timestamp) && d.plan && c[i + 1];
    if (!ready) return { ...r, signal: "WAIT", entry: null, entryTimestamp: null };
    const p = d.plan!, fill = c[i + 1].open;
    const gapBad = p.side === "SELL" ? fill >= p.stopLoss || fill <= p.target1 : fill <= p.stopLoss || fill >= p.target1;
    if (gapBad) { d.blockReasons.push("NOT FILLED: next open gapped beyond SL/T1"); return { ...r, signal: "WAIT", entry: null, entryTimestamp: null }; }
    return { ...r, signal: p.side, entry: fill, entryTimestamp: c[i + 1].time, stopLoss: p.stopLoss, target1: p.target1, target2: p.target2, rr: p.rr };
  });
  const trades = walkOutcomes(pseudo, c, cfg);
  const idxByTime = new Map(times.map((t, i) => [t, i]));
  for (const t of trades) {
    const i = idxByTime.get(t.timestamp)!;
    const d = out[i];
    d.fillPrice = t.entry; d.outcome = t.outcome; d.rMultiple = t.rMultiple; d.exitPrice = t.exitPrice;
    // option-buyer result on the REAL premium of the selected strike (never modelled)
    const pk = d.option?.primary && d.option.expiry ? contractKey(d.option.expiry, d.option.optionType, d.option.primary.strike) : null;
    const cm = pk ? inp.options?.byContract.get(pk) : undefined;
    const ob = cm && t.entryTimestamp != null ? cm.get(t.entryTimestamp) : undefined;
    const xb = cm && t.exitTimestamp != null && t.outcome !== "OPEN" ? cm.get(t.exitTimestamp) : undefined;
    d.optionFill = ob ? ob.open : null;
    d.optionExit = xb ? xb.close : null;
    d.optionPnl = d.optionFill != null && d.optionExit != null ? +(d.optionExit - d.optionFill).toFixed(2) : null;
    d.exitIso = t.exitTimestamp != null ? rows[idxByTime.get(t.exitTimestamp) ?? i]?.iso ?? null : null;
    const ev = d.moveId != null ? eventById.get(d.moveId) : undefined;
    if (ev && !ev.executed) { ev.executed = true; ev.tradeOutcome = t.outcome; ev.tradeR = t.rMultiple; }
    // HOLD while the position is open (entry candle .. exit candle)
    const eIdx = idxByTime.get(t.entryTimestamp as number) ?? i + 1, xIdx = t.exitTimestamp != null ? (idxByTime.get(t.exitTimestamp) ?? eIdx) : eIdx;
    for (let k = eIdx; k <= xIdx && k < n; k++) if (k !== i) {
      out[k].executionState = "HOLD"; out[k].action = "WAIT"; out[k].finalAction = "WAIT";
      if (out[k].plan) out[k].entryBlockedReason = `HOLD — ${d.plan?.side === "BUY" ? "BUY CE" : "BUY PE"} from ${hm(d.timestamp)} still open (until SL/Target)`;
    }
    // the shared walker also skips new entries for cfg.cooldownCandles after an exit: say so on the row
    for (let k = xIdx + 1; k <= xIdx + cfg.cooldownCandles && k < n && out[k].date === out[xIdx].date; k++) {
      if (out[k].action === "TAKE") { out[k].executionState = "WAIT"; out[k].action = "WAIT"; out[k].finalAction = "WAIT"; out[k].blockReason = `COOLDOWN (${cfg.cooldownCandles} candles after the last exit)`; out[k].blockReasons.push(out[k].blockReason!); out[k].entryBlockedReason = out[k].blockReason; }
    }
  }

  // ---------------- post-hoc audit (OUTCOME only) ----------------
  for (const ev of events) {
    const s = rows.findIndex((r) => r.iso === ev.firstIso);
    let e = rows.findIndex((r) => r.iso === ev.endIso); if (e < s) e = n - 1;
    const a0 = out[s]?.atr;
    let best = 0;
    for (let k = s; k <= e; k++) best = Math.max(best, ev.direction === "BEARISH" ? ev.startPrice - c[k].low : c[k].high - ev.startPrice);
    ev.mfeAtr = a0 ? +(best / a0).toFixed(2) : null;
    ev.genuine = ev.mfeAtr != null && ev.mfeAtr >= dc.genuineMoveAtr;
    if (ev.executed) {
      if (ev.tradeOutcome === "SL" || !((ev.tradeR ?? 0) > 0)) ev.timing = "FALSE";
      else {
        const tr = out.find((d) => d.moveId === ev.moveId && d.fillPrice != null);
        const frac = tr && best > 0 ? Math.abs((tr.fillPrice as number) - ev.startPrice) / best : 0;
        ev.timing = frac < 0.25 ? "EARLY" : frac <= 0.6 ? "TIMELY" : "LATE"; // fraction of the event's favourable travel already gone at fill
      }
    } else if (!ev.genuine) ev.timing = "FALSE";
    else {
      const top = (Object.entries(ev.blockCounts) as [Group, number][]).sort((x, y) => y[1] - x[1])[0];
      ev.timing = top ? GROUP_TIMING[top[0]] : "MISSED";
    }
  }
  for (const d of out) {
    if (d.moveId == null || !d.plan) continue;
    const ev = eventById.get(d.moveId); if (ev) d.timingClassification = ev.timing;
  }

  // big directional swings (post-hoc zig-zag on closes) -> was each one detected in time?
  const bigMoves: MissedMove[] = [];
  const scopedIdx = out.map((d, i) => (inp.inScope(d.timestamp) ? i : -1)).filter((i) => i >= 0);
  const byDay = new Map<string, number[]>();
  scopedIdx.forEach((i) => { const d = out[i].date; (byDay.get(d) || byDay.set(d, []).get(d)!).push(i); });
  for (const idxs of byDay.values()) {
    const atrs = idxs.map((i) => out[i].atr).filter((x): x is number => x != null).sort((x, y) => x - y);
    if (!atrs.length) continue;
    const A = atrs[Math.floor(atrs.length / 2)];
    const rev = dc.genuineMoveAtr * A;
    const cl = (i: number) => c[i].close;
    let dir = 0, st = idxs[0], ext = idxs[0], hiI = idxs[0], loI = idxs[0];
    const legs: [number, number][] = [];
    for (const i of idxs) {
      const p = cl(i);
      if (dir === 0) {
        if (p > cl(hiI)) hiI = i;
        if (p < cl(loI)) loI = i;
        if (cl(hiI) - cl(loI) >= rev) { if (hiI > loI) { dir = 1; st = loI; ext = hiI; } else { dir = -1; st = hiI; ext = loI; } }
      } else if (dir === 1) {
        if (p > cl(ext)) ext = i;
        else if (cl(ext) - p >= rev) { legs.push([st, ext]); st = ext; ext = i; dir = -1; }
      } else {
        if (p < cl(ext)) ext = i;
        else if (p - cl(ext) >= rev) { legs.push([st, ext]); st = ext; ext = i; dir = 1; }
      }
    }
    if (dir !== 0) legs.push([st, ext]);
    for (const [s, e] of legs) {
      const travel = c[e].close - c[s].close;
      if (Math.abs(travel) < dc.bigMoveAtr * A) continue;
      const bull = travel > 0;
      const want = bull ? "BULLISH" : "BEARISH";
      let det: number | null = null;
      for (let k = s; k <= e; k++) { // from the leg start only (an earlier detection belongs to the previous leg)
        const d = out[k];
        if (d.movementDirection === want && /ATTEMPT|CONFIRMED|EXPANSION/.test(d.movementState)) { det = k; break; }
      }
      const frac = det != null ? (c[det].close - c[s].close) / travel : null;
      bigMoves.push({
        direction: want, startIso: out[s].iso, endIso: out[e].iso, startPrice: c[s].close, endPrice: c[e].close,
        travelAtr: +(Math.abs(travel) / A).toFixed(2), detectedIso: det != null ? out[det].iso : null,
        coverage: det == null ? "MISSED" : (frac as number) < 0.25 ? "EARLY" : (frac as number) <= 0.6 ? "TIMELY" : "LATE",
      });
    }
  }

  // ---------------- summary (in-scope only) ----------------
  const scoped = out.filter((d) => inp.inScope(d.timestamp));
  const scopedEvents = events.filter((ev) => { const r = rows.find((x) => x.iso === ev.firstIso); return r ? inp.inScope(r.timestamp) : false; });
  const count = (xs: string[]) => xs.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {} as Record<string, number>);
  const cands = scoped.filter((d) => d.plan);
  const closed = trades.filter((t) => t.outcome !== "OPEN" && t.outcome !== "NONE");
  const wins = closed.filter((t) => (t.rMultiple ?? 0) > 0).length, losses = closed.filter((t) => (t.rMultiple ?? 0) < 0).length;
  const summary: DecisionSummary = {
    candles: scoped.length,
    movementDetections: scopedEvents.length,
    breakoutDetections: scopedEvents.filter((e) => e.direction === "BULLISH").length,
    breakdownDetections: scopedEvents.filter((e) => e.direction === "BEARISH").length,
    movementStateCounts: count(scoped.map((d) => d.movementState)),
    executionStateCounts: count(scoped.map((d) => d.executionState)),
    buyCandidates: cands.filter((d) => d.plan!.side === "BUY").length,
    sellCandidates: cands.filter((d) => d.plan!.side === "SELL").length,
    buyReady: scoped.filter((d) => d.plan?.side === "BUY" && d.action === "TAKE").length,
    sellReady: scoped.filter((d) => d.plan?.side === "SELL" && d.action === "TAKE").length,
    blocks,
    falseMoves: scopedEvents.filter((e) => !e.genuine).length,
    genuineMoves: scopedEvents.filter((e) => e.genuine).length,
    bigMoves: bigMoves.length, missedMoves: bigMoves.filter((m) => m.coverage === "MISSED").length,
    lateDetections: bigMoves.filter((m) => m.coverage === "LATE").length,
    closedTrades: closed.length, wins, losses,
    winRate: closed.length >= dc.minTradesForRate ? +((wins / closed.length) * 100).toFixed(1) : null,
    winRateNote: closed.length >= dc.minTradesForRate ? `${closed.length} closed trades` : `NOT REPORTED — only ${closed.length} closed trade(s); need >= ${dc.minTradesForRate}`,
    totalR: +closed.reduce((s2, t) => s2 + (t.rMultiple ?? 0), 0).toFixed(2),
  };
  const barsWithChain = inp.options ? scoped.filter((d) => inp.options!.byTime.has(d.timestamp)).length : 0;
  return {
    rows: scoped, events: scopedEvents, bigMoves, trades, metrics: computeMetrics(pseudo.filter((r) => inp.inScope(r.timestamp)), trades),
    daily: computeDaily(pseudo.filter((r) => inp.inScope(r.timestamp)), trades), summary,
    optionData: { status: inp.options?.status ?? "UNAVAILABLE", note: inp.options?.note ?? "option data not requested", barsWithChain },
  };
}
