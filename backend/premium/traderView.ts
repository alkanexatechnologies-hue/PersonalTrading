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
  side: "CE" | "PE"; trigger: number; entry: number; buffer: number; premAtEntry: number | null; triggerLabel: string; zoneFrom: number; stop: number; t1: number; t1Label: string; t2: number | null; t2Label: string | null; rr: number;
  strike: number | null; expiry: string | null; premNow: number | null; premAtTrigger: number | null; premAtStop: number | null; premAtT1: number | null; premAtT2: number | null;
  delta: number | null; history: ReturnType<typeof breakStats>; flags: string[];
}
export function plans(o: { levels: Level[]; spot: number; ref?: number; atr: number; chain: OiStrike[]; expiry: string | null; events: BreakEvent[]; nowMs?: number }) {
  // `ref` = the price the plan is ANCHORED to (fixed through the session); `spot` = live price, used only for premium estimates
  const lv = o.levels, a = o.atr, minGap = 0.15 * a, ref = o.ref ?? o.spot;
  const uniq = (xs: Level[]) => xs.filter((x, i) => i === 0 || Math.abs(x.price - xs[i - 1].price) > 0.1 * a);
  const above = uniq(lv.filter((x) => x.price > ref + minGap).sort((x, y) => x.price - y.price));
  const below = uniq(lv.filter((x) => x.price < ref - minGap).sort((x, y) => y.price - x.price));
  const strikes = o.chain.map((s) => s.strike);
  const build = (side: "CE" | "PE"): Plan | null => {
    const seq = side === "CE" ? above : below; if (!seq.length) return null;
    const dir = side === "CE" ? 1 : -1;
    // levels within 0.75·ATR of each other are ONE zone (e.g. OI wall + prev-day high + trendline): break the whole zone
    // ...but a zone is never wider than 1·ATR in total (dense levels must not chain into one giant band)
    let z = 0; while (z + 1 < seq.length && Math.abs(seq[z + 1].price - seq[z].price) <= 0.75 * a && Math.abs(seq[z + 1].price - seq[0].price) <= a) z++;
    const zone = seq.slice(0, z + 1), trig = zone[zone.length - 1];
    const zoneLabel = zone.length > 1 ? `zone ${Math.round(zone[0].price)}–${Math.round(trig.price)}: ${zone.map((x) => x.label).join(" + ")}` : trig.label + (trig.confluence ? ` ★ (+ ${trig.with!.join(", ")})` : "");
    // the plan STARTS on a 15-min close beyond the level + the engine's break buffer (0.1·ATR) — one exact whole number
    const buffer = Math.max(1, Math.round(0.1 * a)), entry = dir > 0 ? Math.ceil(trig.price + buffer) : Math.floor(trig.price - buffer);
    const tgts = seq.slice(z + 1).filter((x) => dir * (x.price - entry) >= 0.5 * a);
    let t1 = tgts[0] ? { p: tgts[0].price, l: tgts[0].label } : { p: Math.round(entry + dir * a), l: "1 ATR (no level beyond)" };
    let t2: { price: number; label: string } | null = tgts.find((x) => dir * (x.price - t1.p) >= 0.5 * a) || null;
    // P9 (approved 2026-10-18): an OI wall IN FRONT of Target 1 caps the move — Target 1 = the wall, the old Target 1 = Target 2
    const wall = wallInFront(seq.slice(z + 1), entry, t1.p, dir, a);
    if (wall) { t2 = { price: t1.p, label: t1.l }; t1 = { p: wall.price, l: `${wall.label} — OI wall in front` }; }
    // stop: a close back ½·ATR inside = the break failed; R:R from the real entry, not from the level
    const stop = Math.round(entry - dir * 0.5 * a), rr = r2(Math.abs(t1.p - entry) / Math.abs(entry - stop));
    const k = strikes.length ? strikes.reduce((b, s) => (Math.abs(s - entry) < Math.abs(b - entry) ? s : b), strikes[0]) : null;
    const row: any = k != null ? o.chain.find((s) => s.strike === k) : null, p = side === "CE" ? "ce" : "pe";
    const leg = row ? { ltp: row[`${p}Ltp`] ?? null, delta: row[`${p}Delta`] ?? null, gamma: row[`${p}Gamma`] ?? null, iv: row[`${p}Iv`] ?? null } : null;
    const t = yearsToExpiry(o.expiry, o.nowMs);
    const at = (lvl: number | null) => (leg && k != null && lvl != null ? premiumAtLevel({ type: side, strike: k, spot: o.spot, ltp: leg.ltp, delta: leg.delta, gamma: leg.gamma, iv: leg.iv, tYears: t, level: lvl }) : null);
    const history = breakStats(o.events, side === "CE" ? "UP" : "DOWN"), flags: string[] = [];
    if (rr < 1.5) flags.push(`R:R 1:${rr} is below 1:1.5 — skip unless the level is very strong`);
    if (history.weak) flags.push(history.n < 15 ? `only ${history.n} past ${side === "CE" ? "breakouts" : "breakdowns"} to learn from` : `past ${side === "CE" ? "breakouts" : "breakdowns"} followed through only ${history.pct}% of the time`);
    if (zone.some((x) => x.kind === "OI")) flags.push("an OI wall is in the trigger zone — writers defend it; expect a fight there");
    return { side, trigger: trig.price, entry, buffer, premAtEntry: at(entry), triggerLabel: zoneLabel, zoneFrom: zone[0].price, stop, t1: t1.p, t1Label: t1.l, t2: t2?.price ?? null, t2Label: t2?.label ?? null, rr,
      strike: k, expiry: o.expiry, premNow: leg?.ltp ?? null, premAtTrigger: at(trig.price), premAtStop: at(stop), premAtT1: at(t1.p), premAtT2: at(t2?.price ?? null), delta: leg?.delta ?? null, history, flags };
  };
  const bull = build("CE"), bear = build("PE");
  return { bull, bear, noTrade: bull && bear ? { from: bear.entry, to: bull.entry } : null };
}

/** The nearest OI wall between the entry (≥ 0.25·ATR beyond it) and Target 1 (≥ 0.1·ATR before it), in the trade's direction. */
export function wallInFront(levels: Level[], entry: number, t1: number, dir: 1 | -1, a: number): Level | null {
  return levels.filter((x) => x.kind === "OI" && dir * (x.price - entry) >= 0.25 * a && dir * (t1 - x.price) > 0.1 * a).sort((x, y) => dir * (x.price - y.price))[0] ?? null;
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
  const closedBeyond = !!(plan && last15 && dir * (last15.close - plan.entry) >= 0);   // the plan's exact start
  const retestHeld = !!(plan && closedBeyond && prev15 && (side === "CE" ? last15.low <= plan.trigger + 0.2 * m.atr && last15.close > plan.trigger : last15.high >= plan.trigger - 0.2 * m.atr && last15.close < plan.trigger));
  const aligned = side ? (side === "CE" ? htf === "UP" || h1 === "UP" : htf === "DOWN" || h1 === "DOWN") : null;
  const checklist = [
    { item: "Higher timeframe (daily / 1H) agrees", ok: aligned, detail: `Daily ${htf} · 1H ${h1}` },
    { item: "15-min candle CLOSED beyond the start", ok: side ? closedBeyond : null, detail: plan ? `${plan.entry}` : "price inside the no-trade zone" },
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
  else if (m.session === "PRE-OPEN") { action = "PRE-OPEN — PLAN READY, WAIT FOR 09:15"; why = `Pre-open prices are indicative. Bull plan starts on a 15-min close above ${m.bull?.entry ?? "—"}, Bear plan below ${m.bear?.entry ?? "—"}; the first 15 minutes set the range.`; tone = "wait"; }
  else if (m.session !== "OPEN") { action = "MARKET CLOSED — PREPARE THE PLAN"; why = `Next session: Bull plan starts on a 15-min close above ${m.bull?.entry ?? "—"}, Bear plan below ${m.bear?.entry ?? "—"}; nothing in between.`; tone = "wait"; }
  else if (m.istMin < 570) { action = "WAIT — OPENING RANGE"; why = "First 15 minutes set the range. Let the 09:30 candle close before acting."; tone = "wait"; }
  else if (m.istMin > 885) { action = "NO NEW TRADES — LATE SESSION"; why = "After 14:45 theta and the 15:12 exit leave too little room for a buyer."; tone = "stop"; }
  else if (!side) { action = "WAIT — NO-TRADE ZONE"; why = `Price ${Math.round(m.spot)} is between ${m.bear?.entry ?? "—"} and ${m.bull?.entry ?? "—"}. Buying here pays theta for a coin flip. Bull plan starts on a 15-min close above ${m.bull?.entry ?? "—"}; Bear plan below ${m.bear?.entry ?? "—"}.`; tone = "wait"; }
  else if (!closedBeyond) { action = `WATCH — ${side === "CE" ? "BREAKOUT" : "BREAKDOWN"} ATTEMPT`; why = `Price is past ${plan!.trigger} but no 15-min candle has closed beyond ${plan!.entry} yet. Wicks trap buyers.`; tone = "wait"; }
  else if (m.arbiter?.fresh && m.arbiter.finalAction === (side === "CE" ? "BUY_CE" : "BUY_PE") && m.riskOk) { action = `READY — BUY ${side} (arbiter confirmed)`; why = `${passed}/${total} checks pass. Stop ${plan!.stop}, T1 ${plan!.t1}. Size so the stop costs ≤ your fixed risk.`; tone = side === "CE" ? "bull" : "bear"; }
  else if (aligned === false) { action = `CAUTION — COUNTER-TREND ${side === "CE" ? "BREAKOUT" : "BREAKDOWN"}`; why = `Break confirmed but the higher timeframe disagrees. Experienced buyers skip or wait for the retest.`; tone = "wait"; }
  else { action = `WAIT FOR RETEST — ${side === "CE" ? "BREAKOUT" : "BREAKDOWN"} CONFIRMED`; why = `${passed}/${total} checks pass. Arbiter: ${m.arbiter?.finalAction || "not BUY"} — it has the final word.`; tone = "wait"; }
  return { action, why, tone, side, checklist, passed, total };
}

// ---------------------------------------------------------------- tomorrow's map
export function tomorrowMap(o: { bull: Plan | null; bear: Plan | null; lines: { label: string; next: number | null }[]; todayHigh: number | null; todayLow: number | null; close: number; atr: number }) {
  const s: string[] = [];
  if (o.bull) s.push(`Gap-up above ${o.bull.entry}: do not chase the open — wait for the first 15-min candle to close and hold above it (target ${o.bull.t1}).`);
  if (o.bear) s.push(`Gap-down below ${o.bear.entry}: wait for the first 15-min candle to close below it before PE (target ${o.bear.t1}).`);
  if (o.bull && o.bear) s.push(`Open between ${o.bear.entry} and ${o.bull.entry}: no trade until one side breaks on a 15-min close.`);
  return { levels: [{ label: "Today high → tomorrow's PDH", value: o.todayHigh }, { label: "Today low → tomorrow's PDL", value: o.todayLow }, ...o.lines.map((l) => ({ label: `${l.label} at the next open`, value: l.next }))], scenarios: s };
}

// ---------------------------------------------------------------- risk of each level (for an option BUYER trading its break)
export interface LevelRisk { price: number; side: "ABOVE" | "BELOW"; risk: "LOW" | "MEDIUM" | "HIGH" | "FAR"; score: number; reasons: string[]; bounce: string | null; rejections: number; roomPts: number | null }
/**
 * Each factor that makes a break trade harder adds 1 (counter-trend on both higher timeframes adds 2):
 *  room to the next level < 0.5·ATR · an OI wall in the zone · against the daily / 1H trend · rejected ≥ 3 times before
 *  · past breaks in that direction followed through < 50 % (or fewer than 15 of them).
 * Rejections: the last 5 sessions only, one per episode (consecutive candles pushed back from the level count once).
 * 0–1 = LOW, 2 = MEDIUM, ≥ 3 = HIGH. Levels more than one daily ATR away are FAR (not in play for this session).
 */
export function levelRisks(o: { levels: Level[]; spot: number; atr: number; dailyAtr?: number | null; closed: Candle[]; trends: TfTrend[]; events: BreakEvent[] }): LevelRisk[] {
  const a = o.atr || 1, d = o.trends.find((t) => t.tf === "Daily")?.verdict, h = o.trends.find((t) => t.tf === "1H")?.verdict;
  const up = breakStats(o.events, "UP"), dn = breakStats(o.events, "DOWN");
  const sorted = [...o.levels].sort((x, y) => x.price - y.price);
  return o.levels.map((v) => {
    const above = v.price > o.spot, dir = above ? 1 : -1, reasons: string[] = [];
    let score = 0;
    // room: the next distinct level beyond this one
    const beyond = sorted.filter((x) => dir * (x.price - v.price) > 0.1 * a);
    const next = above ? beyond[0] : beyond[beyond.length - 1], room = next ? Math.abs(next.price - v.price) : null;
    if (room != null && room < 0.5 * a) { score++; reasons.push(`only ${Math.round(room)} pts to ${next!.label} — no room`); }
    else reasons.push(room == null ? "open space beyond (no level)" : `${Math.round(room)} pts of room to ${next!.label}`);
    // writers defend OI walls
    const oi = o.levels.find((x) => x.kind === "OI" && Math.abs(x.price - v.price) <= 0.2 * a);
    if (oi) { score++; reasons.push(`${oi.label} — writers defend it`); }
    // higher-timeframe trend for a break in this direction
    const want = above ? "UP" : "DOWN", against = [d, h].filter((t) => t && t !== "RANGE" && t !== "NO DATA" && t !== want).length;
    if (against) { score += against; reasons.push(`break is against the ${against === 2 ? "daily and 1H" : d !== want && d !== "RANGE" ? "daily" : "1H"} trend`); }
    else if (d === want || h === want) reasons.push(`break is with the ${d === want ? "daily" : "1H"} trend`);
    // how often price was pushed back from this level (15-min closes)
    let rej = 0, inEp = false; const tol = 0.15 * a, recentDays = [...new Set(o.closed.map((c) => dayOf(c.time)))].slice(-5);
    for (const c of o.closed.filter((x) => recentDays.includes(dayOf(x.time)))) {
      const hit = above ? c.high >= v.price - tol && c.close < v.price - tol : c.low <= v.price + tol && c.close > v.price + tol;
      if (hit && !inEp) rej++; inEp = hit;
    }
    if (rej >= 3) { score++; reasons.push(`rejected ${rej} times in the last 5 sessions — first breaks often fail`); }
    // what past breaks in this direction did
    const st = above ? up : dn;
    if (st.weak) { score++; reasons.push(st.n < 15 ? `only ${st.n} past ${above ? "breakouts" : "breakdowns"} to learn from` : `past ${above ? "breakouts" : "breakdowns"} followed through ${st.pct}%`); }
    const far = Math.abs(v.price - o.spot) > (o.dailyAtr && o.dailyAtr > 0 ? o.dailyAtr : 2.5 * a);
    const risk: LevelRisk["risk"] = far ? "FAR" : score <= 1 ? "LOW" : score === 2 ? "MEDIUM" : "HIGH";
    // the same level can be a GOOD place to buy the bounce: strong (confluence or ≥ 2 rejections) and with the trend of the bounce
    const strong = !!v.confluence || rej >= 2 || !!oi, bounceDir = above ? "DOWN" : "UP";
    const bounce = !far && strong && (d === bounceDir || h === bounceDir) ? (above ? `strong resistance — lower-risk PE on a rejection (stop just above ${Math.round(v.price)})` : `strong support — lower-risk CE on a bounce (stop just below ${Math.round(v.price)})`) : null;
    return { price: v.price, side: above ? "ABOVE" : "BELOW", risk, score, reasons, bounce, rejections: rej, roomPts: room != null ? Math.round(room) : null };
  });
}

// ---------------------------------------------------------------- opportunity radar (catch the move at the right time)
export type OppState = "IDLE" | "APPROACHING" | "ARMED" | "TRIGGERED" | "FAILED" | "MISSED";
export interface Opp { side: "CE" | "PE"; state: OppState; entry: number | null; distPts: number | null; distAtr: number | null; triggeredAt: number | null; closesAt: number | null; text: string; next: string }
/**
 * One plan's live state from CLOSED 15-min candles + the forming one (kept separate — it is never a confirmation):
 * MISSED (already past T1 — do not chase) · FAILED (triggered in the last 4 closed bars, then closed back inside the level) ·
 * TRIGGERED (a closed bar beyond the start within the last 4 bars and still beyond) · ARMED (the forming bar is beyond the
 * start) · APPROACHING (within 0.3·ATR) · IDLE.
 */
export function opportunity(p: Plan | null, closed15: Candle[], forming15: Candle | null, atr: number): Opp {
  const side = p?.side ?? "CE", base = { side, entry: p?.entry ?? null, triggeredAt: null as number | null, closesAt: forming15 ? forming15.time + 900 : null };
  if (!p) return { ...base, state: "IDLE", distPts: null, distAtr: null, text: "no plan on this side", next: "—" };
  const dir = p.side === "CE" ? 1 : -1, px = forming15 ? forming15.close : closed15[closed15.length - 1]?.close;
  if (px == null) return { ...base, state: "IDLE", distPts: null, distAtr: null, text: "no price", next: "—" };
  const dist = r2(dir * (p.entry - px)), distAtr = atr > 0 ? r2(dist / atr) : null;   // > 0 = still to go
  const recent = closed15.slice(-4);
  const trigIdx = recent.findIndex((c, i) => dir * (c.close - p.entry) >= 0 && (i === 0 ? true : dir * (recent[i - 1].close - p.entry) < 0));
  const trig = trigIdx >= 0 ? recent[trigIdx] : null;
  if (dir * (px - p.t1) >= 0) return { ...base, state: "MISSED", distPts: dist, distAtr, triggeredAt: trig?.time ?? null, text: `price ${Math.round(px)} is already past Target 1 ${Math.round(p.t1)}`, next: "do not chase — wait for a pullback to the start or a new plan" };
  if (trig) {
    const after = recent.slice(trigIdx + 1);
    if (after.some((c) => dir * (c.close - p.trigger) < 0) || (forming15 && dir * (forming15.close - p.stop) <= 0))
      return { ...base, state: "FAILED", distPts: dist, distAtr, triggeredAt: trig.time, text: `triggered ${p.side} but closed back ${dir > 0 ? "below" : "above"} ${Math.round(p.trigger)}`, next: "stand aside — failed breaks often run the other way" };
    return { ...base, state: "TRIGGERED", distPts: dist, distAtr, triggeredAt: trig.time, text: `15-min close ${Math.round(trig.close)} ${dir > 0 ? "above" : "below"} ${p.entry}`, next: `${p.side} plan live: stop ${p.stop}, T1 ${Math.round(p.t1)} — confirm premium + arbiter` };
  }
  if (forming15 && dir * (forming15.close - p.entry) >= 0) return { ...base, state: "ARMED", distPts: dist, distAtr, text: `forming 15-min candle is ${dir > 0 ? "above" : "below"} ${p.entry} — not closed yet`, next: `needs the candle to CLOSE ${dir > 0 ? "above" : "below"} ${p.entry}` };
  if (dist <= 0.3 * atr) return { ...base, state: "APPROACHING", distPts: dist, distAtr, text: `${Math.round(dist)} pts from the start ${p.entry}`, next: "get ready: strike, quantity, stop decided now" };
  return { ...base, state: "IDLE", distPts: dist, distAtr, text: `${Math.round(dist)} pts to the start ${p.entry}`, next: "nothing to do" };
}

/**
 * The session plan stays FIXED: it is anchored to the previous close (the morning plan) and only rolls to the next levels
 * when a plan has PLAYED OUT on a closed 15-min candle — triggered and then reached Target 1, or triggered and closed back
 * inside the level (failed). Re-anchored to that candle's close. Closed candles only, so it never repaints.
 */
/**
 * The session plan as a STATE that only moves forward (P8, approved 2026-10-18): it is created once, then advanced candle by
 * candle. A later change of OI walls can never rewrite what already happened — levels are re-read only at a roll.
 */
export interface PlanState { ref: number; since: number | null; why: string; rolls: { time: number; ref: number; why: string }[]; trig: { CE: boolean; PE: boolean }; lastTime: number; openChecked: boolean; pb: ReturnType<typeof plans> }
type PlanMk = (ref: number) => ReturnType<typeof plans>;
export function planInit(prevClose: number, mk: PlanMk): PlanState {
  return { ref: prevClose, since: null, why: "morning plan (anchored to the previous close)", rolls: [], trig: { CE: false, PE: false }, lastTime: 0, openChecked: false, pb: mk(prevClose) };
}
/** Advance with the 09:15 open (once) and with closed 15-min candles newer than `lastTime`. */
export function planStep(st: PlanState, o: { open?: { price: number; time: number } | null; candles: Candle[]; mk: PlanMk }): PlanState {
  const s: PlanState = { ...st, trig: { ...st.trig }, rolls: [...st.rolls] };
  if (!s.openChecked && o.open && Number.isFinite(o.open.price)) {
    s.openChecked = true;
    const op = o.open.price, b = s.pb.bull, r = s.pb.bear;
    const gap = b && op >= b.entry ? `Gap-up open ${Math.round(op)} above the Bull start ${Math.round(b.entry)}` : r && op <= r.entry ? `Gap-down open ${Math.round(op)} below the Bear start ${Math.round(r.entry)}` : null;
    if (gap) { s.ref = op; s.since = o.open.time - 1; s.why = `${gap} — plan re-anchored to the opening price`; s.rolls.push({ time: o.open.time, ref: r2(op), why: s.why }); s.pb = o.mk(op); }
  }
  for (const c of o.candles) {
    if (c.time <= s.lastTime) continue;
    s.lastTime = c.time;
    for (const [side, p] of [["CE", s.pb.bull], ["PE", s.pb.bear]] as const) {
      if (!p) continue; const dir = side === "CE" ? 1 : -1;
      if (!s.trig[side] && dir * (c.close - p.entry) >= 0) { s.trig[side] = true; continue; }
      if (s.trig[side] && (dir * (c.close - p.t1) >= 0 || dir * (c.close - p.trigger) < 0)) {
        s.why = dir * (c.close - p.t1) >= 0 ? `${side === "CE" ? "Bull" : "Bear"} plan reached Target 1 ${Math.round(p.t1)} — rolled to the next levels` : `${side === "CE" ? "Bull" : "Bear"} plan failed (closed back past ${Math.round(p.trigger)}) — re-planned from here`;
        s.ref = c.close; s.since = c.time; s.rolls.push({ time: c.time, ref: c.close, why: s.why }); s.pb = o.mk(c.close); s.trig = { CE: false, PE: false }; break;
      }
    }
  }
  return s;
}
export function planOut(s: PlanState) { return { ...s.pb, anchor: { ref: r2(s.ref), since: s.since, why: s.why, rolls: s.rolls } }; }
export function anchoredPlans(o: { levels: Level[]; spot: number; prevClose: number; todays15: Candle[]; atr: number; chain: OiStrike[]; expiry: string | null; events: BreakEvent[]; nowMs?: number; levelsAt?: (ref: number) => Level[]; open?: { price: number; time: number } | null }) {
  // today's own high/low keep changing as the day trades — shown on the chart, but they never re-shape the fixed plan.
  // OI walls are ranked against the plan's ANCHOR (not the live price), so a wall never reshuffles the plan as price moves.
  const mk: PlanMk = (ref) => plans({ levels: (o.levelsAt ? o.levelsAt(ref) : o.levels).filter((x) => x.kind !== "TODAY"), spot: o.spot, ref, atr: o.atr, chain: o.chain, expiry: o.expiry, events: o.events, nowMs: o.nowMs });
  return planOut(planStep(planInit(o.prevClose, mk), { open: o.open, candles: o.todays15, mk }));
}

// ---------------------------------------------------------------- the trendlines an experienced trader keeps on the chart
/**
 * Of all lines through confirmed swings, keep per side: the most RESPECTED line still unbroken (most touches — candles that
 * came within 0.15·ATR of it without closing through — then the longest span) and the most recent line that broke (the
 * breakout that just happened). Everything else is noise and is not drawn. Closed bars only.
 */
export function significantLines(c: Candle[], k: number, atr: number, firstShown: number) {
  const n = c.length, out: (Line & { touches: number; brokeAt: number | null; minor?: boolean })[] = [];
  const pick = (kind: "SELLER" | "BUYER", kk: number) => {
    const scored = allLines(c, kk).filter((l) => l.kind === kind && l.p2.index >= firstShown - 40).map((l) => {
      let touches = 0, brokeAt: number | null = null;
      for (let i = l.from + 1; i < n; i++) {
        const v = lineAt(l, i);
        if (kind === "SELLER" ? c[i].close > v : c[i].close < v) { brokeAt = i; break; }
        if (Math.abs((kind === "SELLER" ? c[i].high : c[i].low) - v) <= 0.15 * atr) touches++;
      }
      return { ...l, touches, brokeAt };
    });
    const active = scored.filter((l) => l.brokeAt == null).sort((a, b) => b.touches - a.touches || (b.p2.index - b.p1.index) - (a.p2.index - a.p1.index))[0];
    const broken = scored.filter((l) => l.brokeAt != null && l.brokeAt >= n - 30).sort((a, b) => b.brokeAt! - a.brokeAt!)[0];
    return [active, broken].filter(Boolean) as typeof scored;
  };
  for (const kind of ["SELLER", "BUYER"] as const) {
    let got = pick(kind, k);
    // A smooth staircase (lower highs / higher lows without a clear k-bar pivot) leaves a side empty: retry with a
    // smaller pivot so both sides are always drawn when the structure exists; marked "minor".
    if (!got.some((l) => l.brokeAt == null) && k > 2) got = [...got, ...pick(kind, 2).filter((l) => l.brokeAt == null).slice(0, 1).map((l) => ({ ...l, minor: true }))];
    out.push(...got);
  }
  return out;
}
