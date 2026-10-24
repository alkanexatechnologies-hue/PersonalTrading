// ProTrader PHASE 1 — COMPLETE (owner's brief, 2026-10-25). EXPLORATORY: the same last 15 sessions are used to compare all
// variants; nothing here is validated. Phase 2 (2-year validation) is NOT run until the owner approves a candidate.
// Research only; no live logic. Usage: npx tsx phase1Complete.ts > RESULTS_PHASE1_COMPLETE.md
//
// Trades are evaluated one by one from trade-level records (no rate is inferred from P&L):
//   entry   ATM option (CE for long, PE for short) at the strike nearest the index at entry; bought at the premium's 1-min
//           close of the minute that ends at the entry timestamp (a completed 5-min candle close)
//   E1      SL = max(₹5, 1 × premium ATR14 of today's completed 5-min premium candles), target = 2 × SL, 60 minutes   (default)
//   E2      SL as E1, target = 3 × SL, 60 minutes
//   E3      owner's fixed SL ₹5 / target ₹40, until 15:25
//   path    every 1-min premium high / low after entry; SL first → STOP, target first → TARGET, both in one minute → AMBIGUOUS
//           (booked as a stop), neither → TIME (exit at the last minute's close)
//   costs   max(₹0.5, 0.25 %) per side + ₹40 per lot (NIFTY lot 75, SENSEX lot 20); ₹ figures are per 1 lot
//   fills   base = stop at the stop price · pessimistic = stop at min(stop, that minute's close) · conservative = pessimistic +
//           an extra 0.5 % of premium slippage on entry and exit
//   win     a TARGET outcome (win rate = targets / trades); avg win / loss use net > 0 / net ≤ 0 trades
//   PF      Σ positive net / |Σ negative net| · max drawdown = worst peak-to-trough of cumulative net in time order
import { assemble, DayData, Min } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { phase1 } from "./phase1";
import { run as fmRun } from "../fakeMoveGrid";
import { prepare } from "../regimeStudy";
import { REGIME_DEFAULTS } from "../../regime/marketRegime";

const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60), hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const STEP = { NIFTY: 50, SENSEX: 100 } as const, LOT = { NIFTY: 75, SENSEX: 20 } as const, COST = (p: number) => Math.max(0.5, 0.0025 * p);
type IX = "NIFTY" | "SENSEX";
type Exit = "E1" | "E2" | "E3";
interface Out { res: "TARGET" | "STOP" | "TIME" | "AMBIG"; gross: number; net: number; netP: number; netC: number; prem: number; exitAt: string; mins: number }
interface Cand { ix: IX; src: string; day: string; t: number; dir: number; spot: number; kinds: string[]; tags: Record<string, any>; regime: string; tb: string }

function tbOf(m: number) { return m < 570 ? "09:15–09:30" : m < 630 ? "09:30–10:30" : m < 750 ? "10:30–12:30" : "12:30–14:30"; }

function build(ix: IX, days: DayData[]) {
  const ds = days.filter((d) => d.spot.size >= 300), last = ds.slice(-15).map((d) => d.day), lastSet = new Set(last), step = STEP[ix], lot = LOT[ix];
  const mins = new Map(ds.map((d) => [d.day, [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]]));
  const legs = new Map<string, Map<string, Min[]>>(); for (const d of ds) { const m = new Map<string, Min[]>(); for (const [k, a] of d.legs) m.set(k, [...a].sort((p, q) => p.t - q.t)); legs.set(d.day, m); }
  const spotAt = (day: string, t: number) => { let v: number | null = null; for (const [u, p] of mins.get(day)!) { if (u >= t) break; v = p; } return v; };
  const reg = prepare(ix, days, step);
  const regimeOf = (day: string, t: number) => reg.regimeAt(day, t, REGIME_DEFAULTS).r.regime;
  // index 5-min candle that ENDS at t: direction of open → close
  const candleDir = (day: string, t: number) => { const w = mins.get(day)!.filter(([u]) => u >= t - 300 && u < t); return w.length ? Math.sign(w[w.length - 1][1] - w[0][1]) : 0; };
  // OI positioning at a strike over the last 15 minutes (same rule as phase1.ts)
  const oiType = (day: string, strike: number, side: "CE" | "PE", t: number) => {
    const leg = legs.get(day)!.get(`${strike}${side}`) || [], a = leg.filter((m) => m.t < t - 900).pop(), b = leg.filter((m) => m.t < t).pop();
    if (!a || !b || a.oi == null || b.oi == null || b.t - a.t > 1500) return "n/a";
    const dOi = b.oi - a.oi, dP = b.c - a.c; if (Math.abs(dOi) < 0.005 * a.oi) return "FLAT";
    return dOi > 0 ? (dP < 0 ? "WRITE" : "BUY") : dP > 0 ? "COVER" : "UNWIND";
  };
  const trade = (day: string, t: number, dir: number, spot: number, ex: Exit): Out | null => {
    const key = `${Math.round(spot / step) * step}${dir > 0 ? "CE" : "PE"}`, leg = legs.get(day)!.get(key) || [], pre = leg.filter((m) => m.t < t), inM = pre[pre.length - 1];
    if (!inM || t - inM.t > 180) return null;   // no premium at the entry minute
    // premium ATR from today's completed 5-min premium candles
    const bars: { h: number; l: number; c: number }[] = []; let cur: any = null, kk = -1;
    for (const m of pre) { const x = mn(m.t); if (x < 555) continue; const k = Math.floor((x - 555) / 5); if (m.t - (x - 555 - k * 5) * 60 + 300 > t) break; if (k !== kk || !cur) { if (cur) bars.push(cur); cur = { h: m.h, l: m.l, c: m.c }; kk = k; } else { cur.h = Math.max(cur.h, m.h); cur.l = Math.min(cur.l, m.l); cur.c = m.c; } }
    if (cur) bars.push(cur);
    const tr = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c))).slice(-14), patr = tr.length >= 3 ? tr.reduce((a, b) => a + b, 0) / tr.length : 5;
    const sl = ex === "E3" ? 5 : Math.max(5, patr), tg = ex === "E1" ? 2 * sl : ex === "E2" ? 3 * sl : 40, end = ex === "E3" ? Infinity : t + 3600, e = inM.c;
    const path = leg.filter((m) => m.t >= t && m.t < end && mn(m.t) <= 925);
    let res: Out["res"] = "TIME", x = e, xP = e, at = t;
    for (const m of path) { const hs = m.l <= e - sl, ht = m.h >= e + tg; at = m.t + 60;
      if (hs && ht) { res = "AMBIG"; x = e - sl; xP = Math.min(e - sl, m.c); break; }
      if (hs) { res = "STOP"; x = e - sl; xP = Math.min(e - sl, m.c); break; }
      if (ht) { res = "TARGET"; x = xP = e + tg; break; }
      x = xP = m.c; }
    const net = (p: number) => p - e - COST(e) - COST(p) - 40 / lot;
    return { res, gross: (x - e) * lot, net: net(x) * lot, netP: net(xP) * lot, netC: (net(xP) - 0.005 * e - 0.005 * xP) * lot, prem: e, exitAt: hm(at), mins: Math.round((at - t) / 60) };
  };

  // ---------------- candidates ----------------
  const P = phase1(ix, days), cands: Cand[] = [];
  const major = (k: string) => k !== "intraday pivot";
  // RANDOM: every 5-min close, both directions
  for (const r of P.rnd) { const s = spotAt(r.day, r.t)!; cands.push({ ix, src: "RANDOM", day: r.day, t: r.t, dir: r.dir, spot: s, kinds: [], tags: {}, regime: "", tb: tbOf(mn(r.t)) }); }
  // phase1 setups grouped to one trade per setup / time / direction (an entry on several levels counts once; level facts kept)
  const grp = new Map<string, any[]>();
  for (const x of P.trades) { if (!["B0 PT", "H1", "H2", "H2a"].includes(x.setup)) continue; const k = `${x.setup}|${x.t}|${x.dir}`; (grp.get(k) || grp.set(k, []).get(k)!).push(x); }
  for (const xs of grp.values()) {
    const x = xs[0], kinds = xs.filter((y) => y.lvl).map((y) => y.lvl.kind as string), s = spotAt(x.day, x.t)!;
    const majorRec = xs.filter((y) => y.lvl && major(y.lvl.kind));
    cands.push({ ix, src: x.setup, day: x.day, t: x.t, dir: x.dir, spot: s, kinds, regime: "", tb: tbOf(mn(x.t)),
      tags: { major: majorRec.length > 0, majorKinds: [...new Set(majorRec.map((y) => y.lvl.kind))], wick: Math.max(...xs.map((y) => y.ctx.wick ?? 0)),
        oiOk: majorRec.some((y) => y.ctx.write === "WRITE" || y.ctx.write === "FLAT"), oiTypes: [...new Set(majorRec.map((y) => y.ctx.write))], flip: !!x.ctx.flip, lag: x.ctx.lag,
        idxAgree: candleDir(x.day, x.t) === x.dir } });
  }
  // fake moves at owner S/R (both directions) from the 2-year grid code, last 15 sessions
  const fseen = new Set<string>();
  for (const e of fmRun(ds as any, 5, step).ev) {
    if (!lastSet.has(e.day) || e.src !== "OWNER") continue; const k = `${e.t}|${e.dir}`; if (fseen.has(k)) continue; fseen.add(k);
    const atm = Math.round(e.px / step) * step, own = e.dir < 0 ? "CE" : "PE";   // fake-up (bearish): positioning on the CE side; fake-down: PE side
    cands.push({ ix, src: e.dir < 0 ? "FAKE-UP" : "FAKE-DOWN", day: e.day, t: e.t, dir: e.dir, spot: e.px, kinds: ["owner S/R"], regime: "", tb: tbOf(mn(e.t)),
      tags: { write: !!e.f.write, retest: !!e.f.retest, strong: !!e.f.strong, oiSide: oiType(e.day, atm, own, e.t) } });
  }
  for (const c of cands) c.regime = c.src === "RANDOM" ? "" : regimeOf(c.day, c.t);
  // confirmation entry (F): the NEXT 5-min candle must close further in the trade direction than the signal close; entry at that close
  const confirm = (c: Cand): Cand | null => { const t2 = c.t + 300, s2 = spotAt(c.day, t2); if (s2 == null || mn(t2) > 870 || c.dir * (s2 - c.spot) <= 0) return null; return { ...c, t: t2, spot: s2 }; };
  // EMA lateness vs S/R: the most recent same-direction major S/R entry (H1 / H2) earlier the same day within 60 min
  for (const c of cands.filter((x) => x.src === "B0 PT")) {
    const prior = cands.filter((y) => (y.src === "H1" || y.src === "H2") && y.tags.major && y.day === c.day && y.dir === c.dir && y.t < c.t && c.t - y.t <= 3600).sort((p, q) => q.t - p.t)[0];
    c.tags.srBefore = prior ? { mins: Math.round((c.t - prior.t) / 60), pts: c.dir * (c.spot - prior.spot) } : null;
  }
  return { cands, trade, confirm, last, lot };
}

// ---------------- metrics ----------------
type Row = Cand & { o: Out };
function metrics(rs: Row[]) {
  const n = rs.length; if (!n) return null;
  const c = (r: string) => rs.filter((x) => x.o.res === r).length, sum = (f: (x: Row) => number) => rs.reduce((a, x) => a + f(x), 0);
  const winsN = rs.filter((x) => x.o.net > 0), lossN = rs.filter((x) => x.o.net <= 0), pos = sum((x) => Math.max(0, x.o.net)), neg = -sum((x) => Math.min(0, x.o.net));
  let cum = 0, peak = 0, mdd = 0; for (const x of [...rs].sort((p, q) => p.t - q.t)) { cum += x.o.net; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  return { n, T: c("TARGET"), S: c("STOP"), TM: c("TIME"), A: c("AMBIG"), win: (c("TARGET") / n) * 100, avgW: winsN.length ? sum((x) => (x.o.net > 0 ? x.o.net : 0)) / winsN.length : 0,
    avgL: lossN.length ? sum((x) => (x.o.net <= 0 ? x.o.net : 0)) / lossN.length : 0, gross: sum((x) => x.o.gross), net: sum((x) => x.o.net), netP: sum((x) => x.o.netP), netC: sum((x) => x.o.netC),
    exp: sum((x) => x.o.net) / n, expC: sum((x) => x.o.netC) / n, pf: neg ? pos / neg : Infinity, mdd };
}
const R0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const HDR = "| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
const rowOf = (lab: string, sig: number, m: ReturnType<typeof metrics>) => m ? `| ${lab} | ${sig} | ${m.n} | ${m.T} | ${m.S} | ${m.TM} | ${m.A} | ${m.win.toFixed(1)} | ${R0(m.avgW)} | ${R0(m.avgL)} | ${R0(m.gross)} | ${R0(m.net)} | ${R0(m.exp)} | ${R0(m.expC)} | ${m.pf === Infinity ? "∞" : m.pf.toFixed(2)} | ${R0(m.mdd)} |` : `| ${lab} | ${sig} | 0 | | | | | | | | | | | | | |`;

if (require.main === module) {
  const B = { NIFTY: build("NIFTY", assemble("2026-08-01", "2026-10-23").days), SENSEX: build("SENSEX", assembleIndex("SENSEX", "2026-08-01", "2026-10-23")) };
  const all = [...B.NIFTY.cands, ...B.SENSEX.cands];
  const ev = (cs: Cand[], ex: Exit = "E1", conf = false) => { let noPrem = 0, rejected = 0; const rows: Row[] = [];
    for (const c0 of cs) { const c = conf ? B[c0.ix].confirm(c0) : c0; if (!c) { rejected++; continue; } const o = B[c.ix].trade(c.day, c.t, c.dir, c.spot, ex); if (!o) { noPrem++; continue; } rows.push({ ...c, o }); }
    return { rows, noPrem, rejected }; };
  const is = (src: string) => (c: Cand) => c.src === src, am = (c: Cand) => c.t && mn(c.t - 300) < 750;   // signal candle before 12:30
  const V: [string, string, (c: Cand) => boolean, Exit?, boolean?][] = [
    ["REF", "RANDOM entry (every 5-min close, both directions)", is("RANDOM")],
    ["C", "B0 EMA baseline: premium EMA9×EMA21, index past EMA21", is("B0 PT")],
    ["C", "B0 + index signal candle agrees", (c) => c.src === "B0 PT" && c.tags.idxAgree],
    ["C", "B0 + 60-min opposite-signal cooldown", (c) => c.src === "B0 PT" && !c.tags.flip],
    ["C", "B0 + before 12:30", (c) => c.src === "B0 PT" && am(c)],
    ["C", "C3 = B0 + before 12:30 + cooldown", (c) => c.src === "B0 PT" && am(c) && !c.tags.flip],
    ["C", "B0 + index candle agrees + cooldown", (c) => c.src === "B0 PT" && c.tags.idxAgree && !c.tags.flip],
    ["A", "H2 breakout accepted, all levels", is("H2")],
    ["A", "H2 accepted, major level, no OI filter", (c) => c.src === "H2" && c.tags.major],
    ["A", "C2 = H2 major + OI exclusion (no unwind/cover/buy)", (c) => c.src === "H2" && c.tags.major && c.tags.oiOk],
    ["A", "H2a breakout without acceptance, major level", (c) => c.src === "H2a" && c.tags.major],
    ["B", "H1 rejection, all levels", is("H1")],
    ["B", "H1 rejection, major level", (c) => c.src === "H1" && c.tags.major],
    ["B", "H1 major + wick ≥60%", (c) => c.src === "H1" && c.tags.major && c.tags.wick >= 0.6],
    ["B", "H1 major + before 12:30", (c) => c.src === "H1" && c.tags.major && am(c)],
    ["B", "C1 = H1 major + wick ≥60% + before 12:30", (c) => c.src === "H1" && c.tags.major && c.tags.wick >= 0.6 && am(c)],
    ["D", "Fake-up at owner S/R (no OI)", is("FAKE-UP")],
    ["D", "Fake-up + call writing (OI addition)", (c) => c.src === "FAKE-UP" && c.tags.write],
    ["D", "Fake-up + CE unwinding", (c) => c.src === "FAKE-UP" && c.tags.oiSide === "UNWIND"],
    ["D", "Fake-up + strong bearish close (price reaction)", (c) => c.src === "FAKE-UP" && c.tags.strong],
    ["D", "C4 = fake-up + call writing + earlier touch", (c) => c.src === "FAKE-UP" && c.tags.write && c.tags.retest],
    ["D", "Fake-down at owner S/R (no OI)", is("FAKE-DOWN")],
    ["D", "Fake-down + put writing (OI addition)", (c) => c.src === "FAKE-DOWN" && c.tags.write],
    ["D", "Fake-down + PE unwinding", (c) => c.src === "FAKE-DOWN" && c.tags.oiSide === "UNWIND"],
    ["D", "Fake-down + strong bullish close", (c) => c.src === "FAKE-DOWN" && c.tags.strong],
    ["D", "Fake-down + put writing + earlier touch (C4 mirror)", (c) => c.src === "FAKE-DOWN" && c.tags.write && c.tags.retest],
    ["E", "B0 except CHOPPY regime", (c) => c.src === "B0 PT" && c.regime !== "CHOPPY"],
    ["E", "B0 only when regime trend agrees", (c) => c.src === "B0 PT" && ((c.regime === "TRENDING_UP" && c.dir > 0) || (c.regime === "TRENDING_DOWN" && c.dir < 0))],
    ["E", "C2 except CHOPPY regime", (c) => c.src === "H2" && c.tags.major && c.tags.oiOk && c.regime !== "CHOPPY"],
    ["E", "C1 except CHOPPY regime", (c) => c.src === "H1" && c.tags.major && c.tags.wick >= 0.6 && am(c) && c.regime !== "CHOPPY"],
    ["F", "C2 with confirmation entry (next candle extends)", (c) => c.src === "H2" && c.tags.major && c.tags.oiOk, "E1", true],
    ["F", "C1 with confirmation entry", (c) => c.src === "H1" && c.tags.major && c.tags.wick >= 0.6 && am(c), "E1", true],
    ["F", "B0 with confirmation entry", is("B0 PT"), "E1", true],
    ["F", "C2 exit E2 (target 3 × SL)", (c) => c.src === "H2" && c.tags.major && c.tags.oiOk, "E2"],
    ["F", "C2 exit E3 (owner SL ₹5 / T ₹40)", (c) => c.src === "H2" && c.tags.major && c.tags.oiOk, "E3"],
    ["F", "C1 exit E2 (target 3 × SL)", (c) => c.src === "H1" && c.tags.major && c.tags.wick >= 0.6 && am(c), "E2"],
    ["F", "B0 exit E3 (owner SL ₹5 / T ₹40)", is("B0 PT"), "E3"],
  ];
  const signals = (f: (c: Cand) => boolean) => all.filter(f).length;
  const out: string[] = [];
  const P = (...s: string[]) => { out.push(...(s.length ? s : [""])); };
  P("# Phase 1 — complete comparison on the last 15 sessions (EXPLORATORY · not validated)", "");
  P(`Sessions: ${B.NIFTY.last.join(", ")} (NIFTY and SENSEX). All variants use the same sessions, data and costs; Phase 2 has NOT been run.`, "");
  P("Default exit E1: ATM option, SL = max(₹5, 1 × premium ATR), target 2 × SL, 60 min. Costs max(₹0.5, 0.25 %) per side + ₹40 / lot. ₹ figures per 1 lot (NIFTY 75, SENSEX 20). Ambiguous = target and SL in the same minute, booked as a stop. Conservative = stop filled at the minute's close + 0.5 % extra slippage per side. Win % = target hits / trades.", "");
  P("## 1. All variants (both indices)", "", HDR);
  const res: Record<string, ReturnType<typeof metrics>> = {};
  for (const [g, lab, f, ex, conf] of V) { const r = ev(all.filter(f), ex || "E1", !!conf), m = metrics(r.rows); res[lab] = m;
    P(rowOf(`${g} · ${lab}${r.rejected ? ` (rejected by confirmation: ${r.rejected})` : ""}${r.noPrem ? ` (no premium: ${r.noPrem})` : ""}`, signals(f), m)); }
  // ---- change vs the EMA baseline ----
  const b0 = res["B0 EMA baseline: premium EMA9×EMA21, index past EMA21"]!;
  P("", "## 2. What each change does vs the EMA baseline (B0)", "", "| Variant | Trades vs B0 | Win % change | Net / trade change ₹ | Conservative net / trade change ₹ | Reading |", "|---|---|---|---|---|---|");
  for (const [g, lab] of V) { const m = res[lab]; if (!m || g === "REF" || lab.startsWith("B0 EMA")) continue;
    const dw = m.win - b0.win, de = m.exp - b0.exp, dc = m.expC - b0.expC;
    const read = m.n < 15 ? "too few trades to read" : dw > 2 && de > 0 ? "improves win rate AND expectancy" : dw > 2 ? "improves win rate only" : de > 0 ? "improves expectancy only" : m.n < b0.n && Math.abs(dw) <= 2 && Math.abs(de) < 50 ? "mostly reduces trades" : "worse";
    P(`| ${g} · ${lab} | ${m.n} vs ${b0.n} | ${dw >= 0 ? "+" : ""}${dw.toFixed(1)} | ${de >= 0 ? "+" : ""}${R0(de)} | ${dc >= 0 ? "+" : ""}${R0(dc)} | ${read} |`); }
  // ---- key candidates split ----
  const key: [string, (c: Cand) => boolean][] = [["B0 EMA baseline", is("B0 PT")], ["C1 rejection", (c) => c.src === "H1" && c.tags.major && c.tags.wick >= 0.6 && am(c)], ["C2 acceptance", (c) => c.src === "H2" && c.tags.major && c.tags.oiOk], ["C3 EMA filtered", (c) => c.src === "B0 PT" && am(c) && !c.tags.flip], ["C4 fake-up + OI", (c) => c.src === "FAKE-UP" && c.tags.write && c.tags.retest]];
  const split = (title: string, part: (r: Row) => string) => { P("", `## ${title}`, "", HDR); for (const [lab, f] of key) { const rows = ev(all.filter(f)).rows, g = new Map<string, Row[]>(); for (const r of rows) { const k = part(r); (g.get(k) || g.set(k, []).get(k)!).push(r); } for (const [k, v] of [...g.entries()].sort()) P(rowOf(`${lab} · ${k}`, v.length, metrics(v))); } };
  split("3. By index and option side", (r) => `${r.ix} ${r.dir > 0 ? "CE" : "PE"}`);
  split("4. By index", (r) => r.ix);
  split("5. By time of day (signal candle)", (r) => r.tb);
  split("6. By major level type (first major level of the entry)", (r) => (r.tags.majorKinds?.[0] as string) || (r.kinds[0] ?? "—"));
  split("7. By market regime at entry (research regime detector, unvalidated thresholds)", (r) => r.regime || "—");
  // ---- EMA lateness vs S/R ----
  const pt = ev(all.filter(is("B0 PT"))).rows, pre = pt.filter((r) => r.tags.srBefore);
  P("", "## 8. Is the EMA entry late relative to S/R and price structure?", "");
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  P(`- ${pre.length} of ${pt.length} EMA (B0) entries were preceded by a same-direction MAJOR S/R entry (rejection or accepted breakout) earlier the same day within 60 minutes; median ${med(pre.map((r) => r.tags.srBefore.mins))} minutes earlier, the index ${med(pre.map((r) => r.tags.srBefore.pts)).toFixed(0)} points further in the trade direction by the EMA entry.`);
  P(`- Phase-1 lag check (phase1.ts): 74 of 76 EMA signals came after the index had moved ≥ 2 ATR from the last hour's extreme.`);
  const mp = metrics(pre), mn0 = metrics(pt.filter((r) => !r.tags.srBefore));
  P(`- EMA entries WITH a prior S/R entry: ${mp ? `${mp.n} trades · win ${mp.win.toFixed(1)}% · net/trade ₹${R0(mp.exp)}` : "—"} · WITHOUT: ${mn0 ? `${mn0.n} trades · win ${mn0.win.toFixed(1)}% · net/trade ₹${R0(mn0.exp)}` : "—"}.`);
  // ---- trade lists of the main candidates ----
  P("", "## 9. Trade-level records of C1, C2, C3, C4 and B0 (E1 exit, base costs; ₹ per lot)", "");
  for (const [lab, f] of key) {
    P(`### ${lab}`, "", "| Index | Date | Entry | Option side | Level(s) | Regime | Premium in ₹ | Result | Exit | Minutes | Net ₹ | Net ₹ conservative |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of ev(all.filter(f)).rows.sort((p, q) => p.t - q.t)) P(`| ${r.ix} | ${r.day.slice(5)} | ${hm(r.t)} | ${r.dir > 0 ? "CE" : "PE"} | ${(r.tags.majorKinds?.length ? r.tags.majorKinds : r.kinds).join(", ") || "—"} | ${r.regime} | ${r.o.prem.toFixed(2)} | ${r.o.res} | ${r.o.exitAt} | ${r.o.mins} | ${R0(r.o.net)} | ${R0(r.o.netC)} |`);
    P("");
  }
  P("## 10. Data quality and limits", "",
    "- Index: 1-min CLOSE only → 5-min candle highs / lows (and wick %) come from minute closes and understate true wicks.",
    "- Options: ATM±3 1-min legs (O/H/L/C, volume, OI, IV); a strike exists only while inside the rolling ±3 band; OI positioning is read at the level strike only when that strike is inside the band (else n/a, which C2's OI exclusion does not accept).",
    "- The app's ±10-strike OI log is complete on only 6 of the 15 sessions and is not used.",
    "- Exits use the premium's 1-min high / low; the order of SL and target inside one minute is unknown (ambiguous → stop).",
    "- 15 sessions, overlapping trades on the same days, and variants compared on the same dates: every number here is exploratory.");
  console.log(out.join("\n"));
  process.exit(0);
}
