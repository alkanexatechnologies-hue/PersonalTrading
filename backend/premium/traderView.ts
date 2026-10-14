// ============================ Premium Prediction Center — experienced-trader view (pure, no I/O) ============================
// How a seasoned option buyer reads the chart, made explicit and checkable:
//   1. trend by timeframe (daily / 1H / 15m / 5m) from trendlines of CONFIRMED swings + EMA21 slope
//   2. every past break of a swing level or trendline, with what actually happened next (measured, never assumed)
//   3. a level ladder (prev-day / weekly / pivots / trendlines / OI walls) with confluence
//   4. a bull plan, a bear plan and the no-trade zone between them, priced with the live chain
//   5. a "what I'd do now" line + checklist. The arbiter and the risk gates still have final authority.
// No look-ahead: a swing exists only once its right-hand bars have closed; lines and breaks are evaluated bar by bar
// using swings confirmed BEFORE that bar. Outcomes are forward walks used for the history labels only.

import type { Candle, OiStrike } from "../types";
import { confirmedSwings, Swing } from "./premiumCenter";
import { premiumAtLevel, yearsToExpiry } from "../analysis/greeks";
import { rankOiWalls } from "../analysis/marketAnalysis";

const r2 = (v: number) => Math.round(v * 100) / 100;
const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
export function emaS(v: number[], p: number): (number | null)[] { const o: (number | null)[] = new Array(v.length).fill(null); if (v.length < p) return o; const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; o[p - 1] = e; for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; } return o; }
export function atrS(c: Candle[], p = 14): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); let a: number | null = null;
  for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)); a = a == null ? tr : (a * (p - 1) + tr) / p; if (i >= p) o[i] = a; }
  return o;
}

// ---------------------------------------------------------------- trendlines valid at a bar (non-repainting)
export interface Line { kind: "SELLER" | "BUYER"; p1: Swing; p2: Swing; slope: number; from: number /* first bar it is known */ }
export const lineAt = (l: Line, i: number) => l.p1.price + l.slope * (i - l.p1.index);
/** Every trendline the chart would have drawn: through consecutive lower highs (seller) / higher lows (buyer), known once p2 is confirmed. */
export function allLines(c: Candle[], k: number): Line[] {
  const sw = confirmedSwings(c, k), out: Line[] = [];
  for (const kind of ["SELLER", "BUYER"] as const) {
    const pts = sw.filter((s) => s.kind === (kind === "SELLER" ? "HIGH" : "LOW"));
    for (let a = 1; a < pts.length; a++) {
      const p1 = pts[a - 1], p2 = pts[a];
      if (p2.index - p1.index < 3) continue;
      if (kind === "SELLER" ? !(p2.price < p1.price) : !(p2.price > p1.price)) continue;
      out.push({ kind, p1, p2, slope: (p2.price - p1.price) / (p2.index - p1.index), from: p2.index + k });
    }
  }
  return out;
}

// ---------------------------------------------------------------- break events + what happened next
export interface BreakEvent {
  index: number; time: number; dir: "UP" | "DOWN"; source: "SWING" | "TRENDLINE"; level: number; label: string;
  outcome: "FOLLOWED THROUGH" | "FAILED" | "STALLED" | "PENDING"; mfe: number; mae: number; bars: number | null; target: number;
}
/**
 * A break = a CLOSE beyond the level by more than 0.1·ATR (wicks never count), the first time after the level was known.
 * Outcome within `horizon` bars, measured from the ENTRY a trader could actually get (the break candle's close):
 * FOLLOWED THROUGH = price went 1·ATR beyond that close before a close back across the level; FAILED = closed back
 * across the level first; STALLED = neither; PENDING = not enough bars yet.
 */
export function breakEvents(c: Candle[], k: number, horizon: number): BreakEvent[] {
  const atr = atrS(c), sw = confirmedSwings(c, k), lines = allLines(c, k), ev: BreakEvent[] = [];
  const judge = (i: number, dir: "UP" | "DOWN", level: number) => {
    const a = atr[i] ?? 0, tgt = dir === "UP" ? c[i].close + a : c[i].close - a; let mfe = 0, mae = 0;
    for (let j = i + 1; j <= Math.min(c.length - 1, i + horizon); j++) {
      const fav = dir === "UP" ? c[j].high - c[i].close : c[i].close - c[j].low, adv = dir === "UP" ? c[i].close - c[j].low : c[j].high - c[i].close;
      mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
      if (dir === "UP" ? c[j].high >= tgt : c[j].low <= tgt) return { outcome: "FOLLOWED THROUGH" as const, mfe: r2(mfe), mae: r2(mae), bars: j - i, target: r2(tgt) };
      if (dir === "UP" ? c[j].close < level : c[j].close > level) return { outcome: "FAILED" as const, mfe: r2(mfe), mae: r2(mae), bars: j - i, target: r2(tgt) };
    }
    return { outcome: i + horizon <= c.length - 1 ? ("STALLED" as const) : ("PENDING" as const), mfe: r2(mfe), mae: r2(mae), bars: null, target: r2(tgt) };
  };
  // swing levels: first close beyond after confirmation, while untouched by a close
  for (const s of sw) {
    const dir = s.kind === "HIGH" ? "UP" : "DOWN";
    for (let i = s.index + k + 1; i < c.length; i++) {
      const buf = 0.1 * (atr[i] ?? 0);
      if (dir === "UP" ? c[i].close > s.price + buf : c[i].close < s.price - buf) { ev.push({ index: i, time: c[i].time, dir, source: "SWING", level: r2(s.price), label: `${dir === "UP" ? "swing high" : "swing low"} ${Math.round(s.price)}`, ...judge(i, dir, s.price) }); break; }
      if (dir === "UP" ? c[i].close > s.price : c[i].close < s.price) break;   // closed through without the buffer: level consumed, not a clean break
    }
  }
  for (const l of lines) {
    const dir = l.kind === "SELLER" ? "UP" : "DOWN";
    for (let i = l.from + 1; i < c.length; i++) {
      const v = lineAt(l, i), buf = 0.1 * (atr[i] ?? 0);
      if (dir === "UP" ? c[i].close > v + buf : c[i].close < v - buf) { ev.push({ index: i, time: c[i].time, dir, source: "TRENDLINE", level: r2(v), label: `${l.kind === "SELLER" ? "seller" : "buyer"} trendline ${Math.round(v)}`, ...judge(i, dir, v) }); break; }
      if (dir === "UP" ? c[i].close > v : c[i].close < v) break;
    }
  }
  // the same bar often breaks a swing and a line together: keep one event per bar and direction (trendline preferred)
  const seen = new Map<string, BreakEvent>();
  for (const e of ev.sort((a, b) => a.index - b.index || (a.source === "TRENDLINE" ? -1 : 1))) { const key = `${e.index}|${e.dir}`; if (!seen.has(key)) seen.set(key, e); }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}
export function breakStats(ev: BreakEvent[], dir: "UP" | "DOWN") {
  const done = ev.filter((e) => e.dir === dir && e.outcome !== "PENDING"), ft = done.filter((e) => e.outcome === "FOLLOWED THROUGH").length;
  return { n: done.length, followedThrough: ft, failed: done.filter((e) => e.outcome === "FAILED").length, pct: done.length ? Math.round((ft / done.length) * 100) : null, weak: done.length < 15 || (done.length ? ft / done.length < 0.5 : true) };
}

// ---------------------------------------------------------------- trend by timeframe
export interface TfTrend { tf: string; verdict: "UP" | "DOWN" | "RANGE" | "NO DATA"; reasons: string[]; seller: { value: number; broken: boolean } | null; buyer: { value: number; broken: boolean } | null }
/** Latest drawn line of each kind and whether a close has crossed it since it was drawn. */
export function activeLines(c: Candle[], k: number) {
  const ls = allLines(c, k), n = c.length - 1, pick = (kind: Line["kind"]) => ls.filter((l) => l.kind === kind && l.from <= n).sort((a, b) => b.from - a.from)[0] || null;
  const st = (l: Line | null) => { if (!l) return null; let broken = false; for (let i = l.from + 1; i <= n; i++) if (l.kind === "SELLER" ? c[i].close > lineAt(l, i) : c[i].close < lineAt(l, i)) { broken = true; break; } return { line: l, broken, value: r2(lineAt(l, n)), next: r2(lineAt(l, n + 1)) }; };
  return { seller: st(pick("SELLER")), buyer: st(pick("BUYER")) };
}
export function tfTrend(tf: string, c: Candle[], k: number): TfTrend {
  if (c.length < 30) return { tf, verdict: "NO DATA", reasons: ["not enough candles"], seller: null, buyer: null };
  const cl = c.map((x) => x.close), e = emaS(cl, 21), n = c.length - 1, slope = e[n] != null && e[n - 5] != null ? e[n]! - e[n - 5]! : 0;
  const { seller, buyer } = activeLines(c, k), above = e[n] != null && cl[n] > e[n]!, reasons: string[] = [];
  reasons.push(`close ${above ? "above" : "below"} EMA21 (${e[n] != null ? Math.round(e[n]!) : "—"}), EMA ${slope > 0 ? "rising" : slope < 0 ? "falling" : "flat"}`);
  if (buyer) reasons.push(buyer.broken ? "buyer trendline broken" : `buyer trendline holding at ${Math.round(buyer.value)}`);
  if (seller) reasons.push(seller.broken ? "seller trendline broken" : `seller trendline capping at ${Math.round(seller.value)}`);
  const upPts = (above ? 1 : 0) + (slope > 0 ? 1 : 0) + (buyer && !buyer.broken ? 1 : 0) + (seller?.broken ? 1 : 0);
  const dnPts = (!above ? 1 : 0) + (slope < 0 ? 1 : 0) + (seller && !seller.broken ? 1 : 0) + (buyer?.broken ? 1 : 0);
  const verdict = upPts >= 3 && upPts > dnPts ? "UP" : dnPts >= 3 && dnPts > upPts ? "DOWN" : "RANGE";
  return { tf, verdict, reasons, seller: seller ? { value: seller.value, broken: seller.broken } : null, buyer: buyer ? { value: buyer.value, broken: buyer.broken } : null };
}

// ---------------------------------------------------------------- level ladder
export interface Level { price: number; label: string; kind: "PREV DAY" | "TODAY" | "WEEK" | "PIVOT" | "TRENDLINE" | "OI"; confluence?: boolean; with?: string[] }
export function ladder(o: { daily: Candle[]; sessionDay: string; today: { high: number | null; low: number | null }; lines: { label: string; value: number | null }[]; chain: OiStrike[]; spot: number; atr: number }): Level[] {
  const L: Level[] = [], add = (price: number | null | undefined, label: string, kind: Level["kind"]) => { if (price != null && Number.isFinite(price) && price > 0) L.push({ price: r2(price), label, kind }); };
  const prev = [...o.daily].reverse().find((d) => dayOf(d.time) < o.sessionDay);
  if (prev) {
    add(prev.high, "Prev day high", "PREV DAY"); add(prev.low, "Prev day low", "PREV DAY"); add(prev.close, "Prev close", "PREV DAY");
    const pp = (prev.high + prev.low + prev.close) / 3;
    add(2 * pp - prev.low, "R1 pivot", "PIVOT"); add(pp + (prev.high - prev.low), "R2 pivot", "PIVOT"); add(2 * pp - prev.high, "S1 pivot", "PIVOT"); add(pp - (prev.high - prev.low), "S2 pivot", "PIVOT");
  }
  add(o.today.high, "Today high", "TODAY"); add(o.today.low, "Today low", "TODAY");
  // previous week (Mon–Fri before the session's week)
  const wk = (d: string) => { const t = new Date(d + "T00:00:00Z"); const wd = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - wd * 86400_000).toISOString().slice(0, 10); };
  const thisWk = wk(o.sessionDay), prevWkDays = o.daily.filter((d) => wk(dayOf(d.time)) < thisWk), lastWk = prevWkDays.length ? wk(dayOf(prevWkDays[prevWkDays.length - 1].time)) : null;
  const pw = lastWk ? prevWkDays.filter((d) => wk(dayOf(d.time)) === lastWk) : [];
  if (pw.length) { add(Math.max(...pw.map((d) => d.high)), "Prev week high", "WEEK"); add(Math.min(...pw.map((d) => d.low)), "Prev week low", "WEEK"); }
  for (const l of o.lines) add(l.value, l.label, "TRENDLINE");
  if (o.chain.length) {
    const w = rankOiWalls(o.chain, o.spot);
    const lak = (v: number) => `${(v / 1e5).toFixed(1)}L`;
    if (w.ceAbove[0]) add(w.ceAbove[0].strike, `OI call wall (${lak(w.ceAbove[0].ceOi)})`, "OI");
    if (w.peBelow[0]) add(w.peBelow[0].strike, `OI put wall (${lak(w.peBelow[0].peOi)})`, "OI");
    if (w.callMajor && w.callMajor.strike !== w.ceAbove[0]?.strike) add(w.callMajor.strike, `Major call OI (${lak(w.callMajor.ceOi)})`, "OI");
    if (w.putMajor && w.putMajor.strike !== w.peBelow[0]?.strike) add(w.putMajor.strike, `Major put OI (${lak(w.putMajor.peOi)})`, "OI");
  }
  L.sort((a, b) => b.price - a.price);
  const tol = 0.2 * o.atr;
  for (const x of L) { const near = L.filter((y) => y !== x && Math.abs(y.price - x.price) <= tol && y.kind !== x.kind); if (near.length) { x.confluence = true; x.with = near.map((y) => y.label); } }
  return L;
}

// ---------------------------------------------------------------- playbook
export interface Plan {
  side: "CE" | "PE"; trigger: number; triggerLabel: string; zoneFrom: number; stop: number; t1: number; t1Label: string; t2: number | null; t2Label: string | null; rr: number;
  strike: number | null; expiry: string | null; premNow: number | null; premAtTrigger: number | null; premAtStop: number | null; premAtT1: number | null; premAtT2: number | null;
  delta: number | null; history: ReturnType<typeof breakStats>; flags: string[];
}
export function plans(o: { levels: Level[]; spot: number; atr: number; chain: OiStrike[]; expiry: string | null; events: BreakEvent[]; nowMs?: number }) {
  const lv = o.levels, a = o.atr, minGap = 0.15 * a;
  const uniq = (xs: Level[]) => xs.filter((x, i) => i === 0 || Math.abs(x.price - xs[i - 1].price) > 0.1 * a);
  const above = uniq(lv.filter((x) => x.price > o.spot + minGap).sort((x, y) => x.price - y.price));
  const below = uniq(lv.filter((x) => x.price < o.spot - minGap).sort((x, y) => y.price - x.price));
  const strikes = o.chain.map((s) => s.strike);
  const build = (side: "CE" | "PE"): Plan | null => {
    const seq = side === "CE" ? above : below; if (!seq.length) return null;
    const dir = side === "CE" ? 1 : -1;
    // levels within 0.75·ATR of each other are ONE zone (e.g. OI wall + prev-day high + trendline): break the whole zone
    let z = 0; while (z + 1 < seq.length && Math.abs(seq[z + 1].price - seq[z].price) <= 0.75 * a) z++;
    const zone = seq.slice(0, z + 1), trig = zone[zone.length - 1];
    const zoneLabel = zone.length > 1 ? `zone ${Math.round(zone[0].price)}–${Math.round(trig.price)}: ${zone.map((x) => x.label).join(" + ")}` : trig.label + (trig.confluence ? ` ★ (+ ${trig.with!.join(", ")})` : "");
    const tgts = seq.slice(z + 1).filter((x) => dir * (x.price - trig.price) >= 0.5 * a);
    const t1 = tgts[0] ? { p: tgts[0].price, l: tgts[0].label } : { p: r2(trig.price + dir * a), l: "1 ATR (no level beyond)" };
    const t2 = tgts.find((x) => dir * (x.price - t1.p) >= 0.5 * a) || null;
    const stop = r2(trig.price - dir * 0.5 * a), rr = r2(Math.abs(t1.p - trig.price) / Math.abs(trig.price - stop));
    const k = strikes.length ? strikes.reduce((b, s) => (Math.abs(s - trig.price) < Math.abs(b - trig.price) ? s : b), strikes[0]) : null;
    const row: any = k != null ? o.chain.find((s) => s.strike === k) : null, p = side === "CE" ? "ce" : "pe";
    const leg = row ? { ltp: row[`${p}Ltp`] ?? null, delta: row[`${p}Delta`] ?? null, gamma: row[`${p}Gamma`] ?? null, iv: row[`${p}Iv`] ?? null } : null;
    const t = yearsToExpiry(o.expiry, o.nowMs);
    const at = (lvl: number | null) => (leg && k != null && lvl != null ? premiumAtLevel({ type: side, strike: k, spot: o.spot, ltp: leg.ltp, delta: leg.delta, gamma: leg.gamma, iv: leg.iv, tYears: t, level: lvl }) : null);
    const history = breakStats(o.events, side === "CE" ? "UP" : "DOWN"), flags: string[] = [];
    if (rr < 1.5) flags.push(`R:R 1:${rr} is below 1:1.5 — skip unless the level is very strong`);
    if (history.weak) flags.push(history.n < 15 ? `only ${history.n} past ${side === "CE" ? "breakouts" : "breakdowns"} to learn from` : `past ${side === "CE" ? "breakouts" : "breakdowns"} followed through only ${history.pct}% of the time`);
    if (zone.some((x) => x.kind === "OI")) flags.push("an OI wall is in the trigger zone — writers defend it; expect a fight there");
    return { side, trigger: trig.price, triggerLabel: zoneLabel, zoneFrom: zone[0].price, stop, t1: t1.p, t1Label: t1.l, t2: t2?.price ?? null, t2Label: t2?.label ?? null, rr,
      strike: k, expiry: o.expiry, premNow: leg?.ltp ?? null, premAtTrigger: at(trig.price), premAtStop: at(stop), premAtT1: at(t1.p), premAtT2: at(t2?.price ?? null), delta: leg?.delta ?? null, history, flags };
  };
  const bull = build("CE"), bear = build("PE");
  return { bull, bear, noTrade: bull && bear ? { from: bear.trigger, to: bull.trigger } : null };
}

// ---------------------------------------------------------------- what I'd do now + checklist
export interface CoachIn {
  session: string; istMin: number; dataStatus: string; spot: number; atr: number; closed15: Candle[];
  bull: Plan | null; bear: Plan | null; trends: TfTrend[]; arbiter: { finalAction: string; reason: string; fresh: boolean } | null; riskOk: boolean; riskWhy: string;
  premium: { CE: { response: string } | null; PE: { response: string } | null }; liquidity: { CE: string | null; PE: string | null };
}
export function coach(m: CoachIn) {
  const htf = m.trends.find((t) => t.tf === "Daily")?.verdict ?? "NO DATA", h1 = m.trends.find((t) => t.tf === "1H")?.verdict ?? "NO DATA";
  const last15 = m.closed15[m.closed15.length - 1], prev15 = m.closed15[m.closed15.length - 2];
  const side = m.bull && m.spot > m.bull.trigger ? "CE" : m.bear && m.spot < m.bear.trigger ? "PE" : null;
  const plan = side === "CE" ? m.bull : side === "PE" ? m.bear : null;
  const dir = side === "CE" ? 1 : -1;
  const closedBeyond = !!(plan && last15 && dir * (last15.close - plan.trigger) > 0.1 * m.atr);
  const retestHeld = !!(plan && closedBeyond && prev15 && (side === "CE" ? last15.low <= plan.trigger + 0.2 * m.atr && last15.close > plan.trigger : last15.high >= plan.trigger - 0.2 * m.atr && last15.close < plan.trigger));
  const aligned = side ? (side === "CE" ? htf === "UP" || h1 === "UP" : htf === "DOWN" || h1 === "DOWN") : null;
  const checklist = [
    { item: "Higher timeframe (daily / 1H) agrees", ok: aligned, detail: `Daily ${htf} · 1H ${h1}` },
    { item: "15-min candle CLOSED beyond the trigger", ok: side ? closedBeyond : null, detail: plan ? `${plan.trigger}` : "price inside the no-trade zone" },
    { item: "Retest held", ok: side ? retestHeld : null, detail: "optional, but the safest entry" },
    { item: "Option premium confirming (new high)", ok: side ? m.premium[side]?.response === "RISING" : null, detail: side ? `${side} premium ${m.premium[side]?.response?.toLowerCase() || "unknown"}` : "—" },
    { item: "Reward : risk ≥ 1 : 1.5", ok: plan ? plan.rr >= 1.5 : null, detail: plan ? `1 : ${plan.rr}` : "—" },
    { item: "Quote quality", ok: side ? m.liquidity[side] === "GOOD" : null, detail: side ? String(m.liquidity[side] || "—") : "—" },
    { item: "Time window and risk gates", ok: m.riskOk, detail: m.riskWhy },
    { item: "Arbiter agrees (final authority)", ok: m.arbiter ? m.arbiter.fresh && m.arbiter.finalAction === (side === "CE" ? "BUY_CE" : side === "PE" ? "BUY_PE" : "—") : false, detail: m.arbiter ? m.arbiter.finalAction : "not decided" },
  ];
  const passed = checklist.filter((c) => c.ok === true).length, total = checklist.filter((c) => c.ok !== null).length;
  let action: string, why: string, tone: "bull" | "bear" | "wait" | "stop";
  if (/STALE|DISCONNECTED|UNAVAILABLE/.test(m.dataStatus)) { action = "NO TRADE — DATA NOT LIVE"; why = `Feed is ${m.dataStatus}. Never trade on old prices.`; tone = "stop"; }
  else if (m.session !== "OPEN") { action = "MARKET CLOSED — PREPARE THE PLAN"; why = `Next session: CE above ${m.bull?.trigger ?? "—"}, PE below ${m.bear?.trigger ?? "—"}; nothing in between.`; tone = "wait"; }
  else if (m.istMin < 570) { action = "WAIT — OPENING RANGE"; why = "First 15 minutes set the range. Let the 09:30 candle close before acting."; tone = "wait"; }
  else if (m.istMin > 885) { action = "NO NEW TRADES — LATE SESSION"; why = "After 14:45 theta and the 15:12 exit leave too little room for a buyer."; tone = "stop"; }
  else if (!side) { action = "WAIT — NO-TRADE ZONE"; why = `Price ${Math.round(m.spot)} is between ${m.bear?.trigger ?? "—"} and ${m.bull?.trigger ?? "—"}. Buying here pays theta for a coin flip. Ready for CE above ${m.bull?.trigger ?? "—"} or PE below ${m.bear?.trigger ?? "—"} on a 15-min close.`; tone = "wait"; }
  else if (!closedBeyond) { action = `WATCH — ${side === "CE" ? "BREAKOUT" : "BREAKDOWN"} ATTEMPT`; why = `Price is beyond ${plan!.trigger} but no 15-min candle has closed there yet. Wicks trap buyers.`; tone = "wait"; }
  else if (m.arbiter?.fresh && m.arbiter.finalAction === (side === "CE" ? "BUY_CE" : "BUY_PE") && m.riskOk) { action = `READY — BUY ${side} (arbiter confirmed)`; why = `${passed}/${total} checks pass. Stop ${plan!.stop}, T1 ${plan!.t1}. Size so the stop costs ≤ your fixed risk.`; tone = side === "CE" ? "bull" : "bear"; }
  else if (aligned === false) { action = `CAUTION — COUNTER-TREND ${side === "CE" ? "BREAKOUT" : "BREAKDOWN"}`; why = `Break confirmed but the higher timeframe disagrees. Experienced buyers skip or wait for the retest.`; tone = "wait"; }
  else { action = `WAIT FOR RETEST — ${side === "CE" ? "BREAKOUT" : "BREAKDOWN"} CONFIRMED`; why = `${passed}/${total} checks pass. Arbiter: ${m.arbiter?.finalAction || "not BUY"} — it has the final word.`; tone = "wait"; }
  return { action, why, tone, side, checklist, passed, total };
}

// ---------------------------------------------------------------- tomorrow's map
export function tomorrowMap(o: { bull: Plan | null; bear: Plan | null; lines: { label: string; next: number | null }[]; todayHigh: number | null; todayLow: number | null; close: number; atr: number }) {
  const s: string[] = [];
  if (o.bull) s.push(`Gap-up above ${o.bull.trigger}: do not chase the open — wait for the first 15-min candle to close and hold above it (target ${o.bull.t1}).`);
  if (o.bear) s.push(`Gap-down below ${o.bear.trigger}: wait for the first 15-min candle to close below it before PE (target ${o.bear.t1}).`);
  if (o.bull && o.bear) s.push(`Open between ${o.bear.trigger} and ${o.bull.trigger}: no trade until one side breaks on a 15-min close.`);
  return { levels: [{ label: "Today high → tomorrow's PDH", value: o.todayHigh }, { label: "Today low → tomorrow's PDL", value: o.todayLow }, ...o.lines.map((l) => ({ label: `${l.label} at the next open`, value: l.next }))], scenarios: s };
}
