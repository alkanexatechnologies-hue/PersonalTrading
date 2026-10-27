// ============================ LEARNING ENGINE — replay one trade on real 1-minute data and explain it ============================
// Input: the trade (index, strike, CE/PE, buy above/at price, SL, targets, time) + the day's index and option 1-minute bars.
// Output: what happened (fill, targets / SL, best and worst point), the levels, the 3 / 5 / 15-minute charts with the major
// candles explained, the pattern checklist, OI shift, "what if" scenarios, the market-behaviour phases and a lesson — all in
// simple English. Pure functions, no network, no look-ahead into the trade decision (everything before the entry uses only
// bars before the entry; after-entry facts are labelled as results). Learning / advisory only — no trading logic reads this.

export interface Bar1 { t: number; o: number; h: number; l: number; c: number; oi?: number | null }
export interface BandLeg { strike: number; side: "CE" | "PE"; bars: Bar1[] }
export interface LearnTrade {
  index: "NIFTY" | "SENSEX"; date: string; strike: number; side: "CE" | "PE"; how: "above" | "at"; price: number;
  sl: number | null; targets: number[]; time: string; note?: string;
}
export interface LearnInput {
  trade: LearnTrade; idx: Bar1[]; prev: { day: string; h: number; l: number; c: number } | null; opt: Bar1[]; band: BandLeg[];
  lot: number; step: number; expiryDay: boolean; source: string;
}
export type Tone = "fear" | "strength" | "fomo" | "warning" | "signal" | "patience" | "panic" | "done" | "lesson" | "decay";
export interface KeyCandle { t: number; title: string; tag: string; tone: Tone; meaning: string; todo: string }
export interface Mark { t: number; v: number; text: string; tone: Tone; pos: "above" | "below" }

const IST = 19800;
const mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
export const hm = (t: number) => { const m = mn(t); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
export const tOf = (day: string, time: string) => Date.parse(`${day}T${time}:00+05:30`) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const fx = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IN") : String(r1(v)));
const pts = (v: number) => `${v >= 0 ? "+" : "−"}${fx(Math.abs(v))}`;
const rs = (v: number) => `${v >= 0 ? "+" : "−"}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
const lakh = (v: number) => `${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1e5).toFixed(1)}L`;

/** 1-minute → n-minute bars anchored at 09:15 IST (OI = last of the bucket). */
export function agg(bars: Bar1[], n: number): Bar1[] {
  const out: Bar1[] = []; let cur: Bar1 | null = null, key = -1;
  for (const b of bars) { const m = mn(b.t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { t: b.t - (m - 555 - k * n) * 60, o: b.o, h: b.h, l: b.l, c: b.c, oi: b.oi ?? null }; key = k; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; if (b.oi != null) cur.oi = b.oi; } }
  if (cur) out.push(cur); return out;
}
const at = (bars: Bar1[], t: number) => { let x: Bar1 | null = null; for (const b of bars) { if (b.t > t) break; x = b; } return x; };
const between = (bars: Bar1[], a: number, b: number) => bars.filter((x) => x.t >= a && x.t < b);
const avgRange = (bars: Bar1[]) => (bars.length ? bars.reduce((s, b) => s + (b.h - b.l), 0) / bars.length : 1) || 1;
const bucket = (t: number, n: number) => { const m = mn(t); return t - ((m - 555) % n) * 60; };

// ---------------------------------------------------------------------------------------------------------- outcome
export interface Sim { hits: { k: number; t: number; px: number }[]; sl: { t: number; px: number } | null; exitT: number; mfe: { v: number; t: number; px: number }; mae: { v: number; t: number; px: number } }
/** Walk the option bars after the fill: targets in order, SL (a bar touching both counts as SL — the careful reading). */
export function simulate(opt: Bar1[], fillT: number, fillPx: number, sl: number | null, targets: number[], endT: number): Sim {
  const hits: Sim["hits"] = []; let slHit: Sim["sl"] = null, exitT = endT;
  let mfe = { v: 0, t: fillT, px: fillPx }, mae = { v: 0, t: fillT, px: fillPx };
  for (const b of opt) {
    if (b.t <= fillT || b.t > endT) continue;
    if (b.h - fillPx > mfe.v) mfe = { v: b.h - fillPx, t: b.t, px: b.h };
    if (b.l - fillPx < mae.v) mae = { v: b.l - fillPx, t: b.t, px: b.l };
    if (sl != null && b.l <= sl) { slHit = { t: b.t, px: Math.min(sl, b.o) }; exitT = b.t; break; }
    for (let k = hits.length; k < targets.length; k++) { if (b.h >= targets[k]) hits.push({ k: k + 1, t: b.t, px: targets[k] }); else break; }
    if (targets.length && hits.length === targets.length) { exitT = b.t; break; }
  }
  return { hits, sl: slHit, exitT, mfe, mae };
}
function fillOf(opt: Bar1[], t0: number, how: "above" | "at", price: number): { t: number; px: number } | null {
  for (const b of opt) {
    if (b.t < t0 || b.t >= t0 + 3600) continue;
    if (how === "above" && b.h >= price) return { t: b.t, px: b.o > price ? b.o : price };
    if (how === "at" && b.l <= price) return { t: b.t, px: b.o < price ? b.o : price };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------- analysis
export function analyzeTrade(I: LearnInput) {
  const { trade: T, idx, opt, lot, step } = I, day = T.date, isPE = T.side === "PE", name = `${T.strike} ${T.side}`;
  const t0 = tOf(day, T.time), endT = tOf(day, "15:15"), dataNotes: string[] = [];
  if (!idx.length) throw new Error("no index data for this day");
  if (!opt.length) throw new Error(`no ${name} premium data for this day`);
  const spotAt = (t: number) => at(idx, t)?.c ?? idx[0].o, premAt = (t: number) => at(opt, t)?.c ?? null;

  // fill (or not) and what happened
  const fill = fillOf(opt, t0, T.how, T.price);
  const ref = fill || { t: t0, px: premAt(t0) ?? T.price };
  if (!fill) dataNotes.push(`The premium did not trade ${T.how} ${fx(T.price)} within 60 minutes of ${T.time}, so the trade was not triggered. The study below uses the price at ${T.time} (${fx(ref.px)}).`);
  if (fill && Math.abs(fill.px - T.price) >= 0.5) dataNotes.push(`At ${hm(fill.t)} the premium was already ${fx(fill.px)}, ${fill.px > T.price ? "above" : "below"} your ${fx(T.price)}, so the real buy price is ${fx(fill.px)} (${pts(fill.px - T.price)}). All results use ${fx(fill.px)}.`);
  const targets = [...T.targets].sort((a, b) => a - b);
  const sim = simulate(opt, ref.t, ref.px, T.sl, targets, endT);
  const lastHit = sim.hits[sim.hits.length - 1] || null;
  const status = !fill ? "NOT_TRIGGERED" : sim.sl ? (sim.hits.length ? `T${sim.hits.length} then SL` : "SL HIT") : !targets.length ? "NO TARGETS GIVEN" : sim.hits.length === targets.length ? "ALL TARGETS" : sim.hits.length ? `T${sim.hits.length} HIT` : "NO TARGET · 15:15 EXIT";
  const exitT = sim.exitT, closeEnd = premAt(endT) ?? ref.px;

  // levels (only data up to the entry decides "at a level")
  const f15 = between(idx, tOf(day, "09:15"), tOf(day, "09:30")), dayOpen = idx[0].o, spot = spotAt(ref.t);
  const levels: { v: number; key: string; label: string }[] = [];
  if (I.prev) levels.push({ v: I.prev.c, key: "pdc", label: `Yesterday's close ${fx(I.prev.c)}` }, { v: I.prev.h, key: "pdh", label: `Yesterday's high ${fx(I.prev.h)}` }, { v: I.prev.l, key: "pdl", label: `Yesterday's low ${fx(I.prev.l)}` });
  if (f15.length) levels.push({ v: Math.max(...f15.map((b) => b.h)), key: "f15h", label: "First 15 min high" }, { v: Math.min(...f15.map((b) => b.l)), key: "f15l", label: "First 15 min low" });
  levels.push({ v: dayOpen, key: "open", label: `Day open ${fx(dayOpen)}` });
  // OI walls in the recorded band at the entry minute
  const oiAt = (leg: BandLeg, t: number) => { let v: number | null = null; for (const b of leg.bars) { if (b.t > t) break; if (b.oi != null) v = b.oi; } return v; };
  const walls = (side: "CE" | "PE", t: number) => I.band.filter((l) => l.side === side).map((l) => ({ strike: l.strike, oi: oiAt(l, t) })).filter((x) => x.oi != null && x.oi > 0) as { strike: number; oi: number }[];
  const ceNow = walls("CE", ref.t), peNow = walls("PE", ref.t);
  const callWall = ceNow.filter((x) => x.strike >= spot - step).sort((a, b) => b.oi - a.oi)[0] || null;
  const putWall = peNow.filter((x) => x.strike <= spot + step).sort((a, b) => b.oi - a.oi)[0] || null;
  if (callWall) levels.push({ v: callWall.strike, key: "callwall", label: `Call wall ${callWall.strike} (sellers' wall)` });
  if (putWall) levels.push({ v: putWall.strike, key: "putwall", label: `Put wall ${putWall.strike} (buyers' floor)` });

  // the index extreme just before the entry, and the level it was at
  const pre15 = between(idx, ref.t - 15 * 60, ref.t + 60), ext = isPE ? Math.max(...pre15.map((b) => b.h)) : Math.min(...pre15.map((b) => b.l));
  const tol = Math.max(spot * 0.0008, step * 0.3);
  const nearLv = levels.filter((l) => l.key !== "open").map((l) => ({ ...l, d: Math.abs(ext - l.v) })).sort((a, b) => a.d - b.d)[0];
  const atLevel = nearLv && nearLv.d <= tol ? nearLv : null;

  // trend 09:15 → entry
  const chg = spot - dayOpen, pct = (chg / dayOpen) * 100, trend = pct > 0.15 ? "UP" : pct < -0.15 ? "DOWN" : "SIDEWAYS";
  const withTrend = (isPE && trend === "DOWN") || (!isPE && trend === "UP"), against = (isPE && trend === "UP") || (!isPE && trend === "DOWN");

  // index double top (PE) / double bottom (CE) in the hour before the entry (1-minute pivots, 3 bars each side)
  const win = between(idx, ref.t - 3600, ref.t + 15 * 60);
  const piv: Bar1[] = []; for (let i = 3; i < win.length - 3; i++) { const v = isPE ? win[i].h : win[i].l, side = win.slice(i - 3, i + 4).map((b) => (isPE ? b.h : b.l));
    if (v === (isPE ? Math.max(...side) : Math.min(...side))) piv.push(win[i]); }
  let dbl: { a: Bar1; b: Bar1 } | null = null;
  if (piv.length >= 2) { const pv = (b: Bar1) => (isPE ? b.h : b.l), first = [...piv].sort((a, b) => (isPE ? pv(b) - pv(a) : pv(a) - pv(b)))[0];
    const second = piv.filter((p) => Math.abs(p.t - first.t) >= 4 * 60 && Math.abs(pv(p) - pv(first)) <= tol * 1.5).sort((a, b) => Math.abs(pv(a) - pv(first)) - Math.abs(pv(b) - pv(first)))[0];
    if (second) dbl = first.t < second.t ? { a: first, b: second } : { a: second, b: first };
    if (dbl && dbl.b.t > ref.t + 12 * 60) dbl = null; }
  const pv = (b: Bar1) => (isPE ? b.h : b.l), dblAfter = !!dbl && dbl.b.t > ref.t;   // second touch after the entry = confirmation, not a reason
  const secondWord = isPE ? "failed" : "held";

  // premium base before the entry: lowest low in the 45 minutes before, the fall into it, and the distance of the entry above it
  const preP = between(opt, ref.t - 45 * 60, ref.t + 60), baseBar = preP.length ? preP.reduce((m, b) => (b.l < m.l ? b : m), preP[0]) : null;
  const priorHigh = baseBar ? Math.max(...between(opt, tOf(day, "09:15"), baseBar.t + 60).map((b) => b.h)) : null;
  const fall = baseBar && priorHigh ? (priorHigh - baseBar.l) / priorHigh : 0;
  const base = baseBar && fall >= 0.2 ? { t: baseBar.t, v: baseBar.l, fallFrom: priorHigh!, fallPct: Math.round(fall * 100) } : null;
  const nearBase = base ? (ref.px - base.v) / base.v <= 0.3 : false, slUnder = base && T.sl != null ? T.sl < base.v : null;
  const higherLow = base && fill ? sim.mae.px > base.v : null;

  // reversal candle on 3 minutes: the bar holding the fill or the one before it
  const p3 = agg(opt, 3), fi = p3.findIndex((b) => b.t === bucket(ref.t, 3));
  const isEng = (i: number) => i > 0 && p3[i].c > p3[i].o && p3[i - 1].c < p3[i - 1].o && p3[i].c >= p3[i - 1].o && p3[i].o <= p3[i - 1].c * 1.02;
  const isStrong = (i: number) => i >= 0 && p3[i].c > p3[i].o && (p3[i].c - p3[i].o) >= 0.5 * (p3[i].h - p3[i].l);
  const revI = [fi - 1, fi].find((i) => i >= 0 && isEng(i)) ?? [fi - 1, fi].find((i) => i >= 0 && isStrong(i)) ?? null;
  const rev = revI != null ? { t: p3[revI].t, bar: p3[revI], kind: isEng(revI) ? "engulfing" : "strong green" } : null;

  // OI shift in the band: 12 minutes before the entry → the entry
  const tA = ref.t - 12 * 60, strikes = [...new Set(I.band.map((l) => l.strike))].sort((a, b) => a - b);
  const oiRows = strikes.map((k) => { const ce = I.band.find((l) => l.strike === k && l.side === "CE"), pe = I.band.find((l) => l.strike === k && l.side === "PE");
    const d = (l?: BandLeg) => { if (!l) return null; const a = oiAt(l, tA), b = oiAt(l, ref.t); return a != null && b != null ? b - a : null; };
    return { strike: k, ce: d(ce), pe: d(pe), ceNow: ce ? oiAt(ce, ref.t) : null, peNow: pe ? oiAt(pe, ref.t) : null }; })
    .filter((r) => (r.ce != null || r.pe != null) && Math.abs(r.strike - spot) <= step * 3);
  const wall = isPE ? callWall : putWall, wallLeg = wall ? I.band.find((l) => l.strike === wall.strike && l.side === (isPE ? "CE" : "PE")) : null;
  const wallA = wallLeg ? oiAt(wallLeg, tA) : null, wallB = wallLeg ? oiAt(wallLeg, ref.t) : null;
  const wallHeld = wallA && wallB ? wallB >= wallA * 0.97 : null;
  const oiRead = !wall ? "No OI wall found in the recorded strikes." : wallHeld
    ? `${wall.strike} ${isPE ? "CE" : "PE"} OI stayed at ${(wallB! / 1e5).toFixed(0)} lakh (${lakh(wallB! - wallA!)} in 12 min): the ${isPE ? "call" : "put"} writers did not run. The wall held.`
    : `${wall.strike} ${isPE ? "CE" : "PE"} OI fell ${lakh(wallB! - wallA!)} in 12 min: the ${isPE ? "call" : "put"} writers were leaving. The wall was weak.`;

  // ------------------------------------------------------------------ scenarios (₹ for 1 lot, before charges)
  const pnl = (px: number, entry = ref.px) => (px - entry) * lot;
  const scen: { label: string; pnl: number | null; text?: string }[] = [];
  const legExit = (k: number, s: Sim) => { const h = s.hits.find((x) => x.k === k); return h ? h.px : s.sl ? s.sl.px : premAt(s.exitT) ?? closeEnd; };
  if (targets.length) {
    scen.push({ label: `Sold everything at T1 (${fx(targets[0])})`, pnl: pnl(legExit(1, sim)) });
    if (targets.length > 1) scen.push({ label: `Sold ${targets.length === 2 ? "half" : "1/3"} at each target`, pnl: targets.reduce((s, _, i) => s + pnl(legExit(i + 1, sim)), 0) / targets.length });
    if (targets.length > 1 && sim.hits.length) { // half at T1, rest with the SL moved to cost
      const after = opt.filter((b) => b.t > sim.hits[0].t && b.t <= endT); let px = premAt(endT) ?? closeEnd;
      for (const b of after) { if (b.l <= ref.px) { px = ref.px; break; } if (b.h >= targets[targets.length - 1]) { px = targets[targets.length - 1]; break; } }
      scen.push({ label: "Half at T1, rest with SL moved to cost", pnl: (pnl(targets[0]) + pnl(px)) / 2 });
    }
  }
  const late = opt.find((b) => b.t >= ref.t + 180);
  if (late && fill) { const s2 = simulate(opt, late.t, late.o, T.sl, targets, endT), px = targets.length ? legExit(1, s2) : s2.mfe.px;
    scen.push({ label: `Entered 3 min late (${fx(late.o)})`, pnl: pnl(px, late.o), text: targets.length ? (s2.hits.length ? "T1 still hit" : s2.sl ? "SL hit" : "no target") : "at the best price" }); }
  if (T.sl != null) scen.push({ label: `Your SL ${fx(T.sl)} had been hit`, pnl: pnl(T.sl) });
  if (lastHit) { const tt = Math.min(lastHit.t + 30 * 60, endT), px = premAt(tt) ?? closeEnd; scen.push({ label: `Held without booking till ${hm(tt)}`, pnl: pnl(px), text: `premium ${fx(px)}` }); }
  scen.push({ label: "Held till 15:15", pnl: pnl(closeEnd), text: `premium ${fx(closeEnd)}` });
  scen.push({ label: `Perfect exit at the top (${fx(sim.mfe.px)} at ${hm(sim.mfe.t)})`, pnl: pnl(sim.mfe.px), text: "only for reference, nobody gets this" });
  if (base && base.t < ref.t - 4 * 60) { const early = at(opt, base.t - 10 * 60); if (early && early.c > base.v * 1.15)
    scen.push({ label: `Bought 10 min before the bottom (${fx(early.c)})`, pnl: null, text: `fell to ${fx(base.v)} first (${pts(base.v - early.c)} pts)` }); }

  // ------------------------------------------------------------------ timeline
  const tl: { t: number; text: string; tone?: Tone }[] = [];
  if (base) tl.push({ t: base.t, text: `Premium stops falling at ${fx(base.v)} (fell from ${fx(base.fallFrom)}, −${base.fallPct}%). NIFTY at ${fx(spotAt(base.t))}.`.replace("NIFTY", T.index) });
  if (dbl) tl.push({ t: dbl.b.t, text: `${T.index} ${isPE ? "top" : "bottom"} again at ${fx(pv(dbl.b))} (first ${fx(pv(dbl.a))} at ${hm(dbl.a.t)}): ${isPE ? (pv(dbl.b) <= pv(dbl.a) ? "a lower top" : "a slightly higher top") : (pv(dbl.b) >= pv(dbl.a) ? "a higher bottom" : "a slightly lower bottom")}.` });
  if (rev) tl.push({ t: rev.t, text: `${rev.kind === "engulfing" ? "Engulfing" : "Strong green"} candle on the premium: ${fx(rev.bar.o)} → ${fx(rev.bar.c)}.` });
  if (fill) tl.push({ t: fill.t, text: `You buy ${T.how} ${fx(T.price)} (filled ${fx(fill.px)}).`, tone: "signal" });
  if (fill && sim.mae.v < 0) tl.push({ t: sim.mae.t, text: `Lowest after entry: ${fx(sim.mae.px)} (${pts(sim.mae.v)} pts)${T.sl != null && !sim.sl ? ". SL was safe" : ""}.`, tone: "patience" });
  for (const h of sim.hits) tl.push({ t: h.t, text: `T${h.k} ${fx(h.px)} hit (${Math.round((h.t - ref.t) / 60)} min after entry).`, tone: "strength" });
  if (sim.sl) tl.push({ t: sim.sl.t, text: `SL hit at ${fx(sim.sl.px)}.`, tone: "fear" });
  if (fill) tl.push({ t: sim.mfe.t, text: `Best price after entry: ${fx(sim.mfe.px)} (${pts(sim.mfe.v)} pts).` });
  if (lastHit) { const tt = Math.min(lastHit.t + 20 * 60, endT), px = premAt(tt); if (px != null) tl.push({ t: tt, text: `20 min later the premium is ${fx(px)}${px < lastHit.px ? `: late holders gave back ${fx(lastHit.px - px)} pts` : ""}.`, tone: "done" }); }
  if (sim.sl) { const after = opt.filter((b) => b.t > sim.sl!.t && b.t <= endT), best = after.reduce((m, b) => (b.h > m ? b.h : m), 0);
    if (targets.length && best >= targets[0]) { const b = after.find((x) => x.h >= targets[0])!; tl.push({ t: b.t, text: `After your SL, the premium still reached T1 ${fx(targets[0])}: the SL was too tight or the entry too early.`, tone: "lesson" }); } }
  tl.sort((a, b) => a.t - b.t);

  // ------------------------------------------------------------------ checklist
  const wallWord = isPE ? "call wall" : "put wall";
  const checklist = [
    { ok: !!atLevel, text: atLevel ? `${T.index} was at a key level: ${atLevel.label} (${isPE ? "high" : "low"} ${fx(ext)})` : `${T.index} was not at a key level (nearest: ${nearLv?.label ?? "none"}, ${fx(nearLv?.d ?? 0)} pts away)` },
    { ok: !!dbl, text: dbl ? `${T.index} double ${isPE ? "top" : "bottom"}: ${fx(pv(dbl.a))} then ${fx(pv(dbl.b))}${dblAfter ? ` (the second one at ${hm(dbl.b.t)}, after your entry, confirmed it)` : ""}` : `No double ${isPE ? "top" : "bottom"} on ${T.index} around the entry` },
    { ok: !!base, text: base ? `Premium bottom after a long fall (${fx(base.fallFrom)} → ${fx(base.v)})` : "The premium had no clear bottom before the entry" },
    { ok: !!rev, text: rev ? `Reversal candle at the bottom (${hm(rev.t)} ${rev.kind})` : "No reversal candle on the premium at the entry" },
    { ok: nearBase, text: base ? `Entry ${fx(ref.px)} is ${nearBase ? "just" : "far"} above the bottom ${fx(base.v)}` : "Entry not tied to a premium bottom" },
    { ok: slUnder === true, text: T.sl == null ? "No SL given" : base ? `SL ${fx(T.sl)} ${slUnder ? "is under" : "is above"} the bottom ${fx(base.v)}` : `SL ${fx(T.sl)} (no bottom to compare)` },
    { ok: wallHeld === true, text: wall ? `OI: the ${wallWord} ${wall.strike} ${wallHeld ? "held" : "did not hold"}` : "OI: no wall in the recorded strikes" },
  ];

  // ------------------------------------------------------------------ angles (today's line for each lesson card)
  const p15 = agg(opt, 15), i15 = agg(idx, 15), bi15 = i15.find((b) => b.t === bucket(ref.t, 15)), bp15 = p15.find((b) => b.t === bucket(ref.t, 15));
  const wick = (b?: Bar1) => (b ? { up: b.h - Math.max(b.o, b.c), dn: Math.min(b.o, b.c) - b.l, r: b.h - b.l } : null);
  const wi = wick(bi15), wp = wick(bp15), risk = T.sl != null ? ref.px - T.sl : null, rew = targets.length ? targets[0] - ref.px : null;
  const angles: Record<string, string> = {
    trend: `${T.index} went ${trend === "SIDEWAYS" ? "SIDEWAYS" : trend} from 09:15 to ${hm(ref.t)} (${pts(chg)} pts). ${withTrend ? `Your ${T.side} was WITH the trend.` : against ? `Your ${T.side} was AGAINST the trend, so you needed a strong reason.` : "No clear trend: levels matter more."}`,
    level: atLevel ? `${T.index} reached <b>${atLevel.label}</b> just before your entry.` : `Your entry was not at a key level. The nearest was ${nearLv?.label ?? "—"}, ${fx(nearLv?.d ?? 0)} pts away.`,
    pattern: dbl ? `<b>${fx(pv(dbl.a))} at ${hm(dbl.a.t)}, then ${fx(pv(dbl.b))} at ${hm(dbl.b.t)}</b>. The second ${isPE ? "top" : "bottom"} ${secondWord}${dblAfter ? " just after your entry, which confirmed the trade" : ""}.` : `No double ${isPE ? "top" : "bottom"}. Look for the index failing twice at the same price.`,
    premium: base ? `The ${T.side} fell ${fx(base.fallFrom)} → <b>${fx(base.v)}</b> and stopped. Entry ${fx(ref.px)} was ${nearBase ? "just above" : "far above"} it.` : "The premium had no clear bottom. That is a riskier entry.",
    candle: rev ? `<b>${hm(rev.t)} candle, ${fx(rev.bar.o)} → ${fx(rev.bar.c)}</b> (${rev.kind}).` : "No clear reversal candle at your entry. Wait for one next time.",
    wick: wi && wp ? `On 15 min (${hm(bucket(ref.t, 15))}): ${T.index} top wick ${fx(wi.up)}, bottom wick ${fx(wi.dn)}. Premium bottom wick ${fx(wp.dn)}, top wick ${fx(wp.up)}.` : "Not enough 15 min data.",
    oi: oiRead,
    risk: risk != null && rew != null ? `Risk ${fx(risk)} pts (${rs(-risk * lot).replace("−", "")}), first target ${pts(rew)} pts (${rs(rew * lot)}). <b>${rew >= 2 * risk ? "Good: reward is 2× the risk or more." : rew >= risk ? "OK: reward is more than the risk." : "Weak: the risk is bigger than the first target."}</b>` : "Give an SL and targets to see the risk and reward.",
    time: lastHit ? `All ${sim.hits.length} target${sim.hits.length > 1 ? "s" : ""} came in ${Math.round((lastHit.t - ref.t) / 60)} minutes. ${I.expiryDay ? "Expiry day: the premium decays fast after the move." : ""}` : sim.sl ? `SL came ${Math.round((sim.sl.t - ref.t) / 60)} minutes after the entry.` : `At 15:15 the premium was ${fx(closeEnd)} (${pts(closeEnd - ref.px)}).`,
  };

  // ------------------------------------------------------------------ charts per timeframe + the major candles
  const tf: Record<string, any> = {};
  for (const n of [3, 5, 15]) {
    const ib = agg(idx, n), ob = agg(opt, n), aI = avgRange(ib), aP = avgRange(ob), K: KeyCandle[] = [];
    const bi = (t: number) => ib.find((b) => b.t === bucket(t, n)), bo = (t: number) => ob.find((b) => b.t === bucket(t, n));
    const desc = (t: number) => { const a = bi(t), b = bo(t); if (!a || !b) return "";
      return `${T.index} ${a.c >= a.o ? "rose" : "fell"} ${fx(Math.abs(a.c - a.o))} (${fx(a.o)} → ${fx(a.c)}). ${name} ${b.c >= b.o ? "rose" : "fell"} ${fx(b.o)} → ${fx(b.c)}.`; };
    const add = (t: number, title: string, tag: string, tone: Tone, meaning: string, todo: string) => { const bt = bucket(t, n); if (!K.some((k) => k.t === bt)) K.push({ t: bt, title, tag, tone, meaning, todo }); };
    if (n === 15) { const o = ib[0]; if (o) add(o.t, "Opening candle", o.c >= o.o ? "TREND UP" : "TREND DOWN", o.c >= o.o ? "strength" : "fear", `${desc(o.t)} ${o.c >= o.o ? "Buyers won the first 15 minutes." : "Sellers won the first 15 minutes."}`, (isPE && o.c >= o.o) || (!isPE && o.c < o.o) ? `The morning is against a ${T.side}. You need a strong reason.` : `The morning favours a ${T.side}.`); }
    // biggest index candle in the 45 minutes before the entry
    const pre = ib.filter((b) => b.t >= ref.t - 30 * 60 && b.t < bucket(ref.t, n)), big = pre.length ? pre.reduce((m, b) => (Math.abs(b.c - b.o) > Math.abs(m.c - m.o) ? b : m), pre[0]) : null;
    if (big && big.h - big.l >= 1.4 * aI) { const up = big.c > big.o, toward = (isPE && up) || (!isPE && !up);
      add(big.t, toward ? `Rush ${up ? "up" : "down"} to the level` : `Big ${up ? "green" : "red"} candle`, toward ? "FOMO" : "STRENGTH", toward ? "fomo" : "strength",
        `${desc(big.t)} Size ${(Math.abs(big.c - big.o) / aI).toFixed(1)}× a normal candle.${toward ? " Late traders are chasing." : ""}`, toward ? "Get READY, not IN. The crowd is most excited right at the level." : "The move in your direction has started. Don't chase it, wait for a small pullback."); }
    if (dbl) add(dbl.a.t, `${isPE ? "Top" : "Bottom"} 1 at ${fx(pv(dbl.a))}`, "WARNING", "warning", `${desc(dbl.a.t)} ${atLevel ? `It touched ${atLevel.label}.` : ""}`, `Mark this ${isPE ? "high" : "low"}. Watch if the next try fails.`);
    if (base) add(base.t, `Premium bottom ${fx(base.v)}`, "BOTTOM", "warning", `${desc(base.t)} Lowest premium before your entry, after a −${base.fallPct}% fall.`, T.sl != null ? `Your SL (${fx(T.sl)}) belongs below this bottom.` : "Put your SL just below this bottom.");
    if (rev) add(rev.t, rev.kind === "engulfing" ? "Engulfing on the premium" : "Strong green on the premium", "SIGNAL", "signal", `${desc(rev.t)} ${rev.kind === "engulfing" ? "A bigger green body than the last red one: buyers took control." : "A strong green body: buyers took control."}`, `This is the trigger. Buy ${T.how} ${fx(T.price)}${T.sl != null ? ` with SL ${fx(T.sl)}` : ""}.`);
    add(ref.t, fill ? "Your entry candle" : "Your planned entry", "ENTRY", "signal", `${desc(ref.t)} ${fill ? `Filled at ${fx(fill.px)}.` : "The price never reached your entry."}`, fill ? "Now place the SL and stop watching every tick." : "No fill = no trade. That is fine.");
    if (dbl && dbl.b.t > dbl.a.t) add(dbl.b.t, `${isPE ? "Second top fails" : "Second bottom holds"}`, "PATIENCE", "patience", `${desc(dbl.b.t)} Only ${fx(pv(dbl.b))} this time${isPE ? (pv(dbl.b) < pv(dbl.a) ? ": a lower top" : "") : (pv(dbl.b) > pv(dbl.a) ? ": a higher bottom" : "")}.`, higherLow ? "The premium made a higher low. Hold, don't panic." : "Watch your SL. Don't add more.");
    if (fill) { const post = ob.filter((b) => b.t > bucket(ref.t, n) && b.t <= exitT), mv = post.length ? post.reduce((m, b) => (b.c - b.o > m.c - m.o ? b : m), post[0]) : null;
      if (mv && mv.c - mv.o >= aP) add(mv.t, sim.hits.length ? (isPE ? "Breakdown: trapped buyers run" : "Breakout: trapped sellers run") : "Big move", "PANIC", "panic", `${desc(mv.t)} The other side is exiting in a hurry.`, sim.hits.length ? "Targets come fast. Book them as they hit." : "Book part profit into big candles."); }
    if (sim.sl) add(sim.sl.t, "SL hit", "SL", "fear", `${desc(sim.sl.t)} The premium went to ${fx(sim.sl.px)}.`, "Accept it. A small loss is part of the plan.");
    else if (lastHit && !K.some((k) => k.t === bucket(lastHit.t, n))) add(lastHit.t, `T${lastHit.k} hit`, "TARGET", "strength", `${desc(lastHit.t)}`, "Book it. Don't wait for more.");
    const after = ob.filter((b) => b.t > bucket(exitT, n) && b.t <= Math.min(exitT + 45 * 60, endT)).find((b) => b.o - b.c >= 0.8 * aP);
    if (fill && after) add(after.t, sim.sl ? "After the SL" : "Profit booking", "DONE", "done", `${desc(after.t)} ${sim.sl ? "" : "Smart money already booked."}`, sim.sl ? "Don't take revenge trades." : "The trade is over. Don't re-enter for more.");
    if (n === 15 && I.expiryDay) { const dec = ob.filter((b) => b.t > exitT + 30 * 60 && b.t <= endT).reduce<Bar1 | null>((m, b) => (!m || b.o - b.c > m.o - m.c ? b : m), null);
      if (dec && dec.o - dec.c > 0) add(dec.t, "Time decay", "DECAY", "decay", `${desc(dec.t)} Expiry day eats the premium.`, "Never 'hold and hope' on expiry day."); }
    K.sort((a, b) => a.t - b.t);

    const mI: Mark[] = [], mP: Mark[] = [];
    if (dbl) { mI.push({ t: bucket(dbl.a.t, n), v: pv(dbl.a), text: `${isPE ? "Top" : "Bottom"} 1 · ${fx(pv(dbl.a))}`, tone: "fear", pos: isPE ? "above" : "below" }); if (bucket(dbl.b.t, n) !== bucket(dbl.a.t, n)) mI.push({ t: bucket(dbl.b.t, n), v: pv(dbl.b), text: `${isPE ? "Top" : "Bottom"} 2`, tone: "warning", pos: isPE ? "above" : "below" }); }
    mI.push({ t: bucket(ref.t, n), v: spotAt(ref.t), text: `${fill ? "You buy" : "Plan"} ${T.side} ${hm(ref.t)}`, tone: "signal", pos: isPE ? "below" : "above" });
    if (base) mP.push({ t: bucket(base.t, n), v: base.v, text: `Bottom ${fx(base.v)}`, tone: "warning", pos: "below" });
    mP.push({ t: bucket(ref.t, n), v: ref.px, text: `${fill ? "BUY" : "Plan"} ${hm(ref.t)}`, tone: "signal", pos: "above" });
    for (const h of sim.hits) mP.push({ t: bucket(h.t, n), v: h.px, text: `T${h.k}`, tone: "strength", pos: "above" });
    if (sim.sl) mP.push({ t: bucket(sim.sl.t, n), v: sim.sl.px, text: "SL", tone: "fear", pos: "below" });
    if (lastHit) mI.push({ t: bucket(lastHit.t, n), v: spotAt(lastHit.t), text: `Targets ${hm(lastHit.t)}`, tone: "strength", pos: isPE ? "below" : "above" });

    const eb = bi(ref.t), ebo = bo(ref.t), next = ob.find((b) => b.t > bucket(ref.t, n));
    const note = n === 3
      ? `<b>3 min chart = the entry chart.</b> It shows the exact moment to buy.${dbl ? ` You can see the double ${isPE ? "top" : "bottom"} on ${T.index} (${fx(pv(dbl.a))}, ${fx(pv(dbl.b))})` : ""}${base ? ` and the premium bottom (${fx(base.v)})` : ""}${rev ? `, then the ${rev.kind} candle at ${hm(rev.t)}` : ""}. <b>Use 3 min to time your entry and SL.</b>`
      : n === 5
        ? `<b>5 min chart = the confirmation chart.</b> There is less noise.${ebo ? ` The 5 min premium candle at ${hm(ebo.t)} closed <b>${ebo.c >= ebo.o ? "green" : "red"}</b> (${fx(ebo.o)} → ${fx(ebo.c)})` : ""}${next ? `, and the next one closed ${next.c >= next.o ? "green" : "red"} (${fx(next.c)})` : ""}. ${ebo && ebo.c >= ebo.o && next && next.c >= next.o ? "Two green candles agree: the signal is real." : "The candles don't fully agree, so be careful with size."} <b>Use 5 min to check that the 3 min signal is not a fake.</b>`
        : `<b>15 min chart = the big picture.</b> From 09:15 to ${hm(ref.t)} ${T.index} went ${trend.toLowerCase()} (${pts(chg)} pts), so your ${T.side} was ${withTrend ? "with" : against ? "against" : "not against"} the trend.${eb && wi ? ` The ${hm(bucket(ref.t, 15))} candle had a ${T.index} top wick of ${fx(wi.up)} and a bottom wick of ${fx(wi.dn)}.` : ""} At 15:15 the premium was ${fx(closeEnd)}. <b>Use 15 min to know the trend and how long to stay in.</b>`;
    tf[n] = { idx: ib, opt: ob, keyCandles: K, marksIdx: mI, marksOpt: mP, note, avgIdx: r1(aI), avgOpt: r1(aP) };
  }

  // ------------------------------------------------------------------ market behaviour phases
  const P: { from: number; to: number; title: string; mood: string; tone: Tone; who: string; text: string; you: string }[] = [];
  const s0 = tOf(day, "09:15"), s1 = tOf(day, "09:30"), o15 = between(idx, s0, s1);
  if (o15.length) { const d = o15[o15.length - 1].c - o15[0].o, lo = Math.min(...o15.map((b) => b.l)), hi = Math.max(...o15.map((b) => b.h));
    P.push({ from: s0, to: s1, title: "Opening nerves", mood: d < 0 ? "FEAR" : "HOPE", tone: d < 0 ? "fear" : "strength", who: d < 0 ? "Sellers" : "Buyers", text: `${T.index} moved between ${fx(lo)} and ${fx(hi)} and closed the first 15 min ${pts(d)}. Everyone is nervous after the open.`, you: "Sit on your hands. Mark the first 15 min high and low." }); }
  const rushStart = Math.max(s1, ref.t - 15 * 60);
  if (rushStart > s1 + 10 * 60) { const seg = between(idx, s1, rushStart), d = seg.length ? seg[seg.length - 1].c - seg[0].o : 0, s15 = agg(seg, 15),
      hl = d > 0 ? s15.filter((b, i) => i && b.l > s15[i - 1].l).length : s15.filter((b, i) => i && b.h < s15[i - 1].h).length, hlWord = d > 0 ? "higher low" : "lower high";
    P.push({ from: s1, to: rushStart, title: d > 0 ? "Buyers slowly win" : d < 0 ? "Sellers slowly win" : "Nobody wins", mood: d > 0 ? "HOPE" : d < 0 ? "WORRY" : "BORED", tone: d > 0 ? "strength" : d < 0 ? "fear" : "done", who: d > 0 ? "Buyers" : d < 0 ? "Sellers" : "Nobody",
      text: `${T.index} ${pts(d)} pts${hl && d !== 0 ? `, with ${hl} ${hlWord}${hl > 1 ? "s" : ""}` : ""}. ${atLevel ? `It was heading to ${atLevel.label}.` : ""}`, you: (isPE && d > 0) || (!isPE && d < 0) ? `The trend is against a ${T.side}. Don't buy yet. Watch the level.` : `The trend helps a ${T.side}. Wait for a pullback to a level.` }); }
  const baseIn = !!base && base.t > rushStart + 2 * 60 && base.t < ref.t, rushEnd = baseIn ? base!.t : Math.max(rushStart + 3 * 60, ref.t - 3 * 60), rs1 = between(idx, rushStart, rushEnd + 60);
  if (rs1.length) { const d = rs1[rs1.length - 1].c - rs1[0].o, toward = (isPE && d > 0) || (!isPE && d < 0);
    P.push({ from: rushStart, to: rushEnd, title: toward ? (isPE ? "Rush up to the level" : "Fall to the level") : "Move starts", mood: toward ? (isPE ? "GREED" : "FEAR") : "DOUBT", tone: toward ? (isPE ? "fomo" : "fear") : "patience", who: toward ? (isPE ? "Late buyers" : "Late sellers") : "Both sides",
      text: `${T.index} ${pts(d)} pts in ${Math.max(1, Math.round((rushEnd - rushStart) / 60))} min.${baseIn ? ` ${name} holders sold the premium down to ${fx(base!.v)}.` : ""}`, you: toward ? "The crowd is most wrong here. Get ready, but don't buy yet." : "Let the level prove itself first." }); }
  if (fill) P.push({ from: rushEnd, to: fill.t + 60, title: wallHeld ? "The wall holds" : "Turn at the level", mood: "DOUBT", tone: "patience", who: wallHeld ? (isPE ? "Call writers" : "Put writers") : "Undecided",
    text: `${dbl ? `The second ${isPE ? "top" : "bottom"} ${fx(pv(dbl.b))} ${secondWord}. ` : ""}${base ? `The premium stopped falling at ${fx(base.v)}.` : ""}`, you: `This is YOUR entry zone: buy ${T.how} ${fx(T.price)}${T.sl != null ? `, SL ${fx(T.sl)}` : ""}.` });
  if (fill) { const seg = between(idx, fill.t, exitT + 60), d = seg.length ? seg[seg.length - 1].c - seg[0].o : 0, moved = sim.hits.length > 0 || sim.mfe.v >= Math.max(10, 0.3 * ref.px);
    P.push(sim.sl ? { from: fill.t, to: exitT, title: "The level breaks", mood: "PAIN", tone: "fear", who: isPE ? "Buyers" : "Sellers", text: `${T.index} ${pts(d)} pts against you. SL hit at ${fx(sim.sl.px)}.`, you: "Accept the SL. Don't average down and don't take revenge." }
      : { from: fill.t, to: exitT, title: moved ? "Trapped traders run" : "Slow drift", mood: moved ? "PANIC" : "BORED", tone: moved ? "panic" : "done", who: isPE ? "Sellers" : "Buyers", text: `${T.index} ${pts(d)} pts. ${name} ${fx(ref.px)} → best ${fx(sim.mfe.px)}.`, you: sim.hits.length ? "Book your targets. Panic moves are fast and short." : moved ? "Big moves don't last. Book part profit into them." : "No target yet. Trail your SL, don't hope." });
    const aft = between(opt, exitT, Math.min(exitT + 30 * 60, endT)); if (aft.length && exitT < endT - 5 * 60) P.push({ from: exitT, to: Math.min(exitT + 30 * 60, endT), title: "Calm returns", mood: "CALM", tone: "done", who: "Nobody", text: `${name} went to ${fx(aft[aft.length - 1].c)} in the next 30 min.`, you: sim.sl ? "Close the chart. Review the trade later, calmly." : "The trade is done. Close the chart and protect your profit." }); }

  const dos = ["Wait for the first 15 minutes. Let the levels form.", "Buy only <b>at a level</b> (wall, yesterday's close, first 15 min high/low), never in the middle.", "Wait for the premium to stop falling (a higher low) before buying.", "Decide your SL and rupee loss <b>before</b> you click buy.", "Book part profit at T1, then move SL to cost."];
  const donts = ["Don't chase a big candle. That is FOMO.", "Don't panic-exit on a dip that stays above your SL.", "Don't hold for 'more' after the targets hit.", "Don't buy an option just because 'it is cheap now'. Wait for the level to hold.", "Don't re-enter the same trade to 'make more'."];
  if (against) donts.unshift(`This ${T.side} was against the morning trend. Take such trades only at a strong wall, with a small SL.`);
  if (lastHit) { const px = premAt(Math.min(lastHit.t + 30 * 60, endT)); if (px != null && px < lastHit.px - 0.4 * (lastHit.px - ref.px)) donts.unshift(`Holding past ${hm(lastHit.t)} gave back ${fx(lastHit.px - px)} pts in 30 minutes. Book in parts.`); }
  if (slUnder === false) dos.unshift(`Put the SL below the premium bottom (${fx(base!.v)}). Your SL ${fx(T.sl!)} was above it.`);
  const big: string[] = [];
  if (wall && wallA != null && wallB != null) big.push(`<b>${isPE ? "Call" : "Put"} writers</b> at ${wall.strike} had ${(wallB / 1e5).toFixed(0)} lakh OI and ${wallHeld ? "did not run" : "were leaving"} (${lakh(wallB - wallA)} in 12 min).`);
  if (dbl && sim.hits.length) big.push(`Traders who ${isPE ? "bought near the top" : "sold near the bottom"} (${fx(pv(dbl.a))}) got <b>trapped</b>. Their exit made the move bigger.`);
  const sum = (k: "ce" | "pe") => oiRows.reduce((s, r) => s + (r[k] ?? 0), 0);
  if (oiRows.length) big.push(`Near the money in those 12 min: CE OI ${lakh(sum("ce"))}, PE OI ${lakh(sum("pe"))}. ${sum("pe") > 0 && sum("ce") < 0 ? "Put writing + call covering is a floor under the index." : sum("ce") > 0 && sum("pe") < 0 ? "Call writing + put covering is a ceiling over the index." : "Both sides were adding: a fight at this level."}${(isPE && sum("pe") > 0 && sum("ce") < 0) || (!isPE && sum("ce") > 0 && sum("pe") < 0) ? ` That total was against your ${T.side}. Here the wall at ${wall?.strike ?? "the level"} mattered more, but it is a warning to keep the SL tight.` : ""}`);

  const okN = checklist.filter((c) => c.ok).length;
  const lesson = `${!fill ? "The trade was never triggered. Not every plan fills, and that is fine. " : ""}${atLevel ? `${T.index} hit ${atLevel.label}` : `${T.index} was not at a key level`}${dbl ? ` and failed twice there (${fx(pv(dbl.a))}, ${fx(pv(dbl.b))})` : ""}. ${base ? `The ${T.side} premium stopped falling at ${fx(base.v)}${nearBase ? `, and buying just above it (${fx(ref.px)}) kept the risk small` : ""}.` : ""} ${risk != null && rew != null ? `Risk ${fx(risk)} pts vs ${fx(rew)} pts to T1. ` : ""}${status === "ALL TARGETS" && lastHit ? `The move came fast (${Math.round((lastHit.t - ref.t) / 60)} min). <b>Book profit in parts${I.expiryDay ? " and don't hold an expiry-day option after the targets hit" : ""}.</b>` : sim.sl ? `<b>The SL hit${against ? " because the trade was against the trend" : ""}. ${okN >= 5 ? "The setup was good, and losses like this are normal." : "Several checks were missing. Wait for more of them next time."}</b>` : `<b>${okN}/7 checks were in place.</b>`}`;

  return {
    trade: { ...T, targets }, status, fill, ref, lot, spotAtEntry: spot, source: I.source, dataNotes,
    sim: { hits: sim.hits, sl: sim.sl, exitT, mfe: sim.mfe, mae: sim.mae }, levels, callWall, putWall, atLevel, trend: { dir: trend, chg: r1(chg), withTrend, against },
    double: dbl ? { a: { t: dbl.a.t, v: pv(dbl.a) }, b: { t: dbl.b.t, v: pv(dbl.b) } } : null, base, reversal: rev ? { t: rev.t, kind: rev.kind } : null,
    timeline: tl, checklist, oi: { from: tA, to: ref.t, rows: oiRows, read: oiRead, wall: wall ? { strike: wall.strike, held: wallHeld } : null },
    scenarios: scen.map((s) => ({ ...s, pnl: s.pnl == null ? null : Math.round(s.pnl) })), angles, tf, phases: P, dos, donts, big, lesson,
  };
}
