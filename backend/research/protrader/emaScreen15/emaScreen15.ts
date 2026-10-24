// Owner's EMA-screen rule (confirmed 2026-10-24 "yes"), NIFTY, latest 15 sessions. SIMULATED HISTORICAL REPLAY. Research only.
// CE entry at a 5-min close (09:20–14:30) when ALL are true, and they were not all true on the previous candle:
//   1. NIFTY 5-min close > its EMA 21 (continuous 5-min closes across days, like the main chart)
//   2. ATM CE premium 5-min close > its EMA 9 AND > its EMA 21
//   3. ATM PE premium 5-min close < its EMA 9, and PE EMA 9 < PE EMA 21
// PE entry = the exact mirror. Premium EMAs on 5-min premium candles of that strike, previous session + today (not across
// an expiry), as in emaCrossStudy.ts. R1/S1 not used. Exit on the bought premium: SL = entry − ₹5, target = entry + ₹30,
// else close at 15:24. SL and target in the same minute = SL. One trade at a time; a new entry needs a fresh trigger.
// Costs = corrected standard (final1560 optionPnl). Usage: npx tsx emaScreen15.ts
import fs from "fs";
import path from "path";
import { assemble, DayData, Min } from "../../nifty20/data";
import { expiryDays } from "../premiumBacktest2";
import { optionPnl } from "../final1560/strategy";

type Bar = { time: number; open: number; high: number; low: number; close: number };
const LOT = 75, STEP = 50, SL = 5, TGT = 30, N = 15;
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60), hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const bars5 = (pts: [number, number][]): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of pts) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / 5);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * 5) * 60, open: p, high: p, low: p, close: p }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const emaSeries = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };

const ds = assemble("2026-08-01", "2026-10-23").days.filter((d) => d.spot.size >= 300), last = ds.slice(-N).map((d) => d.day), exp = expiryDays(ds, STEP);
interface Tr { day: string; side: string; sig: string; strike: number; idx: number; idxE21: number; ce: string; pe: string; mode: string; entry: number | null; exit: number | null; reason: string; exitAt: string; net: number | null; gross: number | null }
const trades: Tr[] = [];
let hist: Bar[] = [], prevLegs: Map<string, Bar[]> | null = null, prevExp = false;
for (const d of ds) {
  const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
  const B = bars5(mins), all = hist.concat(B), off = hist.length, e21 = emaSeries(all.map((b) => b.close), 21);
  const legBars = new Map<string, Bar[]>(); for (const [k, arr] of d.legs) legBars.set(k, bars5(arr.map((x: Min) => [x.t, x.c] as [number, number])));
  const legMin = new Map<string, Min[]>(); for (const [k, arr] of d.legs) legMin.set(k, [...arr].sort((a, b) => a.t - b.t));
  const cache = new Map<string, { idx: Map<number, number>; c: number[]; e9: number[]; e21: number[] }>();
  const pe = (k: string) => { if (!cache.has(k)) { const ser = (!prevExp && prevLegs?.get(k) || []).concat(legBars.get(k) || []), c = ser.map((b) => b.close);
    cache.set(k, { idx: new Map(ser.map((b, j) => [b.time, j])), c, e9: emaSeries(c, 9), e21: emaSeries(c, 21) }); } return cache.get(k)!; };
  // premium state of strike/side at the 5-min candle starting at bt: above both EMAs (+1), below EMA 9 with EMA 9 < EMA 21 (-1), else 0
  const st = (k: string, bt: number) => { const s = pe(k), j = s.idx.get(bt); if (j == null || j < 21) return null;
    return { c: s.c[j], e9: s.e9[j], e21: s.e21[j], v: s.c[j] > s.e9[j] && s.c[j] > s.e21[j] ? 1 : s.c[j] < s.e9[j] && s.e9[j] < s.e21[j] ? -1 : 0 }; };
  const cond = (i: number) => { const g = off + i, px = all[g].close, atm = Math.round(px / STEP) * STEP, c = st(`${atm}CE`, all[g].time), p = st(`${atm}PE`, all[g].time);
    if (!c || !p) return { dir: 0, atm, c, p, px, e: e21[g] };
    const dir = px > e21[g] && c.v === 1 && p.v === -1 ? 1 : px < e21[g] && p.v === 1 && c.v === -1 ? -1 : 0; return { dir, atm, c, p, px, e: e21[g] }; };
  if (last.includes(d.day)) {
    let busyUntil = 0, prevDir = 0;
    for (let i = 0; i < B.length; i++) {
      const tEnd = B[i].time + 300, m = mn(tEnd), k = cond(i), fresh = k.dir !== 0 && k.dir !== prevDir; prevDir = k.dir;
      if (m < 560 || m > 870 || !fresh || tEnd < busyUntil) continue;
      const side = k.dir > 0 ? "CE" : "PE", key = `${k.atm}${side}`, L = legMin.get(key) || [], f = (x: { c: number; e9: number; e21: number } | null) => (x ? `${x.c.toFixed(2)} (E9 ${x.e9.toFixed(2)} · E21 ${x.e21.toFixed(2)})` : "—");
      for (const mode of ["BASE", "CONSERVATIVE"]) {
        // BASE: fill at the signal close (1-min close of the minute ending at tEnd), SL at exactly entry − 5.
        // CONSERVATIVE: fill 1 minute later, SL filled at the worse of entry − 5 and the next minute's close.
        const eBar = mode === "BASE" ? L.filter((x) => x.t < tEnd && tEnd - (x.t + 60) <= 120).pop() : L.find((x) => x.t === tEnd);
        const tr: Tr = { day: d.day, side, sig: hm(tEnd), strike: k.atm, idx: k.px, idxE21: k.e, ce: f(k.c), pe: f(k.p), mode, entry: null, exit: null, reason: "UNAVAILABLE", exitAt: "", net: null, gross: null };
        if (eBar) {
          const E = eBar.c, path = L.filter((x) => x.t > eBar.t && mn(x.t) <= 924); let X: number | null = null;
          for (let j = 0; j < path.length; j++) { const x = path[j];
            if (x.l <= E - SL) { tr.reason = "SL"; tr.exitAt = hm(x.t + 60); X = mode === "BASE" ? E - SL : Math.min(E - SL, path[j + 1]?.c ?? x.c); break; }
            if (x.h >= E + TGT) { tr.reason = "TARGET"; tr.exitAt = hm(x.t + 60); X = E + TGT; break; } }
          if (X == null && path.length) { const z = path[path.length - 1]; tr.reason = "TIME"; tr.exitAt = hm(z.t + 60); X = z.c; }
          if (X != null) { const p = optionPnl(E, X, LOT, mode === "CONSERVATIVE"); Object.assign(tr, { entry: E, exit: X, net: p.net, gross: p.gross });
            if (mode === "CONSERVATIVE") { const end = path.find((x) => hm(x.t + 60) === tr.exitAt); busyUntil = end ? end.t + 60 : tEnd; } }
        }
        trades.push(tr);
      }
    }
  }
  hist = all.slice(-200); prevLegs = legBars; prevExp = exp.has(d.day);
}

const C = trades.filter((t) => t.mode === "CONSERVATIVE"), Bs = trades.filter((t) => t.mode === "BASE"), R = (v: number) => Math.round(v).toLocaleString("en-IN");
const dir = __dirname;
fs.writeFileSync(path.join(dir, "ema_screen_nifty_last_15_trades.csv"), ["label,mode,date,signal_time,side,strike,nifty_close,nifty_ema21,ce_close_e9_e21,pe_close_e9_e21,entry_premium,exit_premium,exit_reason,exit_time,gross_pnl,net_pnl"]
  .concat(trades.map((t) => ["SIMULATED_REPLAY", t.mode, t.day, t.sig, t.side, t.strike, t.idx.toFixed(2), t.idxE21.toFixed(2), `"${t.ce}"`, `"${t.pe}"`, t.entry?.toFixed(2) ?? "UNAVAILABLE", t.exit?.toFixed(2) ?? "UNAVAILABLE", t.reason, t.exitAt, t.gross?.toFixed(2) ?? "", t.net?.toFixed(2) ?? ""].join(","))).join("\n") + "\n");
const o: string[] = [];
const sum = (xs: Tr[]) => xs.filter((t) => t.net != null).reduce((a, t) => a + t.net!, 0);
o.push("# Owner's EMA-screen rule — NIFTY, latest 15 sessions: SIMULATED HISTORICAL REPLAY", "", "> Simulated replay of historical data, not live trading.", "",
  `Sessions ${last[0]} → ${last[last.length - 1]}. Rule exactly as confirmed (see the header of emaScreen15.ts). SL premium −₹5, target premium +₹30, else 15:24. 1 lot = 75. Costs: slippage max(₹0.5, 0.25 %)/side + ₹40 + statutory; CONSERVATIVE also +0.5 %/side and a 1-minute delay.`, "",
  "## Trades (conservative)", "", "| Date | Signal | Side | Strike | NIFTY / EMA21 | CE close (E9 · E21) | PE close (E9 · E21) | Entry → Exit ₹ | Result | Exit time | Net ₹ |", "|---|---|---|---|---|---|---|---|---|---|---|");
for (const t of C) o.push(`| ${t.day} | ${t.sig} | ${t.side} | ${t.strike} | ${t.idx.toFixed(1)} / ${t.idxE21.toFixed(1)} | ${t.ce} | ${t.pe} | ${t.entry?.toFixed(2) ?? "UNAVAILABLE"} → ${t.exit?.toFixed(2) ?? "—"} | ${t.reason} | ${t.exitAt} | ${t.net == null ? "—" : R(t.net)} |`);
o.push("", "## Daily (conservative net ₹)", "", "| Date | Trades | Target / SL / Time | Net ₹ | Cumulative ₹ |", "|---|---|---|---|---|");
let cum = 0, pk = 0, dd = 0; const daily: { day: string; net: number; n: number }[] = [];
for (const day of last) { const x = C.filter((t) => t.day === day && t.net != null), n = sum(x); for (const t of x) { cum += t.net!; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); } daily.push({ day, net: n, n: x.length });
  o.push(`| ${day} | ${x.length} | ${x.length ? ["TARGET", "SL", "TIME"].map((r) => x.filter((t) => t.reason === r).length).join(" / ") : "—"} | ${R(n)} | ${R(cum)} |`); }
const pr = (xs: Tr[], lab: string) => { const p = xs.filter((t) => t.net != null), w = p.filter((t) => t.net! > 0).length;
  return `| ${lab} | ${p.length}${xs.length - p.length ? ` (+${xs.length - p.length} unavailable)` : ""} | ${["TARGET", "SL", "TIME"].map((r) => p.filter((t) => t.reason === r).length).join(" / ")} | ${p.length ? ((w / p.length) * 100).toFixed(0) : "—"} % | ${R(sum(p))} | ${p.length ? R(sum(p) / p.length) : "—"} |`; };
o.push("", "## Summary", "", "| Costs | Trades | Target / SL / Time | Win % (net > 0) | Total net ₹ | Net / trade ₹ |", "|---|---|---|---|---|---|", pr(Bs, "Base"), pr(C, "Conservative"), "",
  `Days: ${daily.filter((x) => x.n && x.net > 0).length} profitable · ${daily.filter((x) => x.n && x.net <= 0).length} losing · ${daily.filter((x) => !x.n).length} no trade. Max cumulative drawdown (conservative): ₹${R(dd)}.`);
fs.writeFileSync(path.join(dir, "EMA_SCREEN_NIFTY_LAST_15.md"), o.join("\n") + "\n");
console.log(o.join("\n"));
process.exit(0);
