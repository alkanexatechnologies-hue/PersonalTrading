// ============================ 🎯 PREMIUM BOUNCE → RESISTANCE: the opportunity rating of an option premium ============================
// The question an option buyer asks of every premium: "it is starting to move up from its support — how likely is it to get
// THROUGH the resistance above?" Answered from ~2 years of real Dhan 1-minute option premiums (research study
// premiumBounceStudy.ts), with the SAME support / resistance zones the screen shows (premiumZones, 15-min candles).
//   BOUNCE  = a closed 15-min premium candle (09:30–14:30) that dips into its support zone (low ≤ zone top + ½ typical bar)
//             and closes GREEN above the zone — the premium starting to move up from support
//   PASS    = within the next 8 candles (2 hours, same day) a candle CLOSES above the resistance zone above it,
//             before any candle closes below the support zone's low (FAIL = support broke first; NONE = neither)
// The rating per premium combines that tested probability with where the premium is now (bouncing / at support / mid-range /
// near resistance / below support), its liquidity and reward ÷ risk. Information for choosing a strike — never a trade signal.
import { premiumZones } from "./premiumPosition";

export interface PBar { time: number; open: number; high: number; low: number; close: number }
const hmOf = (t: number) => { const m = Math.floor(((t + 19800) % 86400) / 60); return m; };
const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

/** Is candle i a bounce off support (zones from the candles BEFORE it)? */
export function bounceAt(cs: PBar[], i: number) {
  if (i < 8) return null;
  const c = cs[i], z = premiumZones({ candles: cs.slice(0, i), current: c.close }); if (!z) return null;
  const s1 = z.support[0]; if (!s1) return null;
  const ok = c.low <= s1.hi + 0.5 * z.typicalBar && c.close > c.open && c.close > s1.hi;
  return ok ? { s1, r1: z.resistance[0] ?? null, typical: z.typicalBar, zones: z } : null;
}

export const roomBucket = (room: number | null) => (room == null ? "no R" : room <= 1.5 ? "≤1.5 bars" : room <= 3 ? "1.5–3 bars" : ">3 bars");
const tBucket = (n: number) => (n >= 3 ? "3+×" : `${n}×`);
export interface BounceEvent { day: string; time: number; side: "CE" | "PE"; strike: number; money: string; expiryDay: boolean; sT: string; rT: string; room: string; outcome: "PASS" | "FAIL" | "NONE"; touchedR: boolean; maxGainPct: number }

/** Every bounce in one contract's 15-min premium series, with what happened next. */
export function bounceEvents(cs: PBar[], meta: { side: "CE" | "PE"; strike: number; spotAt: (t: number) => number | null; step: number; expiryDays: Set<string> }, horizon = 8): BounceEvent[] {
  const out: BounceEvent[] = [];
  for (let i = 8; i < cs.length; i++) {
    const m = hmOf(cs[i].time); if (m < 570 || m > 870) continue;   // bar starts 09:30 … 14:30
    const b = bounceAt(cs, i); if (!b) continue;
    const entry = cs[i].close, day = dayOf(cs[i].time);
    let outcome: BounceEvent["outcome"] = "NONE", touchedR = false, maxHi = entry;
    for (let j = i + 1; j <= Math.min(cs.length - 1, i + horizon); j++) {
      const x = cs[j]; if (dayOf(x.time) !== day || hmOf(x.time) > 915) break;
      maxHi = Math.max(maxHi, x.high); if (b.r1 && x.high >= b.r1.price) touchedR = true;
      if (b.r1 && x.close > b.r1.price) { outcome = "PASS"; break; }
      if (x.close < b.s1.lo) { outcome = "FAIL"; break; }
    }
    const spot = meta.spotAt(cs[i].time), money = spot == null ? "?" : Math.abs(meta.strike - spot) < meta.step / 2 ? "ATM" : (meta.side === "CE") === (meta.strike < spot) ? "ITM" : "OTM";
    out.push({ day, time: cs[i].time, side: meta.side, strike: meta.strike, money, expiryDay: meta.expiryDays.has(day), sT: tBucket(b.s1.touches), rT: b.r1 ? tBucket(b.r1.touches) : "—",
      room: roomBucket(b.r1 ? (b.r1.price - entry) / Math.max(0.01, b.typical) : null), outcome, touchedR, maxGainPct: Math.round(((maxHi - entry) / entry) * 1000) / 10 });
    i += 3;   // one event per bounce, not one per candle of the same bounce
  }
  return out;
}

export interface BucketStat { n: number; passPct: number; failPct: number; touchRPct: number; medGainPct: number; devPass: number | null; valPass: number | null }
export interface BounceStudy { index: string; from: string; to: string; events: number; generatedAt: string; buckets: Record<string, BucketStat> }
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 100) : 0);
/** Odds per bucket: ALL · room · room|R · room|R|S · room|money · expiry. Dev = first ⅔ of days, val = last ⅓. */
export function bounceStudy(index: string, ev: BounceEvent[]): BounceStudy {
  const days = [...new Set(ev.map((e) => e.day))].sort(), cut = days[Math.floor((days.length * 2) / 3)] ?? "", B: Record<string, BounceEvent[]> = {};
  const add = (k: string, e: BounceEvent) => (B[k] = B[k] || []).push(e);
  for (const e of ev) {
    add("ALL", e); add(`room:${e.room}`, e); add(`room:${e.room}|R:${e.rT}`, e); add(`room:${e.room}|R:${e.rT}|S:${e.sT}`, e); add(`room:${e.room}|${e.money}`, e);
    add(e.expiryDay ? "expiry day" : "not expiry day", e); add(`${e.expiryDay ? "expiry" : "normal"}|room:${e.room}`, e);
  }
  const buckets: Record<string, BucketStat> = {};
  for (const [k, xs] of Object.entries(B)) {
    const dev = xs.filter((e) => e.day < cut), val = xs.filter((e) => e.day >= cut), g = xs.map((e) => e.maxGainPct).sort((a, b) => a - b);
    buckets[k] = { n: xs.length, passPct: pct(xs.filter((e) => e.outcome === "PASS").length, xs.length), failPct: pct(xs.filter((e) => e.outcome === "FAIL").length, xs.length),
      touchRPct: pct(xs.filter((e) => e.touchedR).length, xs.length), medGainPct: g[Math.floor(g.length / 2)] ?? 0,
      devPass: dev.length >= 20 ? pct(dev.filter((e) => e.outcome === "PASS").length, dev.length) : null, valPass: val.length >= 20 ? pct(val.filter((e) => e.outcome === "PASS").length, val.length) : null };
  }
  return { index, from: days[0] ?? "", to: days[days.length - 1] ?? "", events: ev.length, generatedAt: new Date().toISOString(), buckets };
}

/** The tested odds for a set-up: the most specific bucket with ≥ 40 events. */
export function oddsFor(st: BounceStudy, k: { room: string; rT: string; sT: string; expiryDay: boolean }) {
  const keys = [`room:${k.room}|R:${k.rT}|S:${k.sT}`, `room:${k.room}|R:${k.rT}`, k.expiryDay ? `expiry|room:${k.room}` : `normal|room:${k.room}`, `room:${k.room}`, "ALL"];
  for (const key of keys) { const b = st.buckets[key]; if (b && b.n >= 40) return { key, ...b }; }
  return null;
}

export type Stars = 1 | 2 | 3 | 4 | 5;
/** The opportunity rating of one premium now (closed 15-min candles of the contract, live premium, liquidity, R:R). */
export function rateOpportunity(o: { candles: PBar[]; ltp: number; liq: string; rr: number; expiryDay: boolean; study: BounceStudy | null }) {
  const cs = o.candles, z = premiumZones({ candles: cs, current: o.ltp });
  if (!z || !o.study) return null;
  // a "bounce now" counts only for a candle starting 09:30–14:30 of the LAST session (as tested: 2 hours must be left)
  const lastM = cs.length ? hmOf(cs[cs.length - 1].time) : 0, b = cs.length && lastM >= 570 && lastM <= 870 ? bounceAt(cs, cs.length - 1) : null, s1 = z.support[0] ?? null, r1 = z.resistance[0] ?? null;
  // the set-up being rated: bouncing now → from the bounce close; otherwise "if it bounces from support S1"
  const from = b ? cs[cs.length - 1].close : s1?.price ?? o.ltp, rUse = b ? b.r1 : r1, sUse = b ? b.s1 : s1;
  const room = roomBucket(rUse ? (rUse.price - from) / Math.max(0.01, z.typicalBar) : null);
  const odds = sUse ? oddsFor(o.study, { room, rT: rUse ? tBucket(rUse.touches) : "—", sT: tBucket(sUse.touches), expiryDay: o.expiryDay }) : null;
  const p = odds?.passPct ?? null, liquid = o.liq === "GOOD";
  const state = z.state === "BELOW SUPPORT" ? "BELOW SUPPORT" : b ? "BOUNCING" : z.state === "NEAR SUPPORT" ? "AT SUPPORT" : z.state === "NEAR RESISTANCE" ? "AT RESISTANCE" : "MID-RANGE";
  let stars: Stars, label: string;
  if (state === "BELOW SUPPORT") { stars = 1; label = "AVOID — support broke"; }
  // star levels follow the 2-year data: a support bounce passes the next resistance ~29 % of the time overall; the best
  // set-up (strong support, resistance within 1.5 typical bars) ~40–43 %; resistance 1.5–3 bars away ~12 %, further ~5 %
  else if (state === "BOUNCING") {
    if (!rUse) { stars = 3; label = "moving up from support — no resistance above (open room, but no tested pass odds)"; }
    else { stars = p != null && p >= 40 ? 5 : p != null && p >= 33 ? 4 : p != null && p >= 15 ? 3 : 2; label = stars === 5 ? "BEST — moving up from strong support, resistance close" : stars === 4 ? "GOOD — moving up from support" : stars === 3 ? "bouncing — resistance often holds" : "bouncing, but resistance is far — rarely passed in 2 hours"; }
  }
  else if (state === "AT SUPPORT") { stars = p != null && p >= 33 ? 3 : 2; label = `at support — wait for a green 15-min close off ₹${s1!.price}`; }
  else if (state === "AT RESISTANCE") { stars = 2; label = `at resistance ₹${r1!.price} — needs a 15-min close above it`; }
  else { stars = 2; label = s1 ? `mid-range — better entry near ₹${s1.price}` : "mid-range — no support below"; }
  if (!liquid && stars > 3) { stars = 3; label += " (spread not checked / wide)"; }
  if (o.rr < 1 && stars > 2) stars = (stars - 1) as Stars;
  return { stars, label, state, passPct: p, failPct: odds?.failPct ?? null, touchRPct: odds?.touchRPct ?? null, medGainPct: odds?.medGainPct ?? null, n: odds?.n ?? 0, basis: odds?.key ?? null,
    devPass: odds?.devPass ?? null, valPass: odds?.valPass ?? null, from: Math.round(from * 10) / 10, support: sUse ? sUse.price : null, resistance: rUse ? rUse.price : null, room };
}
