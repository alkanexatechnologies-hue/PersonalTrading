// Owner's day process, OLD (V1, as dayProcess.ts) vs NEW (V2 = the 4 fixes agreed 2026-10-24), NIFTY + SENSEX only,
// the latest 15 sessions of each. SIMULATED HISTORICAL REPLAY. Research only. Usage: npx tsx process15.ts
//
// SHARED (both versions): levels at 09:15 = owner S/R (priceActionLevels, previous 5 sessions) + PDH / PDL / PDC; at 09:30
// + first-15 HIGH / LOW + OI CALL wall / PUT wall (app minute log, when that day has a 09:15 and a 09:30 snapshot).
// Breakout of level L at a 5-min close (09:35–14:30) = one of the last three candles closed across L and every close since
// stayed beyond (≥ 2 closes). Premium check: trade-side ATM option 5-min EMA 9 > EMA 21 (premiums = app minute log where
// present, else the research cache; previous session as warm-up unless it was an expiry). One trade at a time per index.
// Exit on the index: target +30 NIFTY / +100 SENSEX, thesis = 5-min close back across L, hard stop, 60 min. Option ₹ =
// 1 lot, corrected standard costs, conservative (1-minute delay on both fills, +0.5 %/side).
//
// V1 (OLD): trend fixed at 09:30 = majority of {price vs PDC, price vs 5-min EMA 21, put OI added vs call OI added};
//           trade a breakout only if it agrees with that trend; hard stop = breakout candle's opposite extreme.
// V2 (NEW):
//   1. Trend updates at every 5-min close: two consecutive closes below BOTH first-15 LOW and PDC → DOWN; two consecutive
//      closes above BOTH first-15 HIGH and PDH → UP.
//   2. Gap > 0.3 % from PDC: the 09:30 OI vote is ignored (opening OI can be a trap).
//   3. STRONG BREAK: ≥ 2 levels broken by the same breakout candle → taken even against the trend, and it flips the trend.
//   4. A breakout in the opposite direction through a level already broken today needs 3 closes beyond it AND the trend
//      agreeing; otherwise "RETEST — WAIT".
//   Stop: thesis close + hard stop capped at 20 NIFTY / 70 SENSEX points from entry.
import fs from "fs";
import path from "path";
import { assemble, DayData, Min } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { barsOf, expiryDays } from "../premiumBacktest2";
import { priceActionLevels } from "../priceActionLevels";
import { optionPnl } from "../final1560/strategy";

const CFG = { NIFTY: { step: 50, lot: 75, tgt: 30, cap: 20 }, SENSEX: { step: 100, lot: 20, tgt: 100, cap: 70 } } as const;
type IX = keyof typeof CFG; type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60), hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };
const R = (v: number) => Math.round(v).toLocaleString("en-IN");
const toT = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`) / 1000;
function logRows(day: string, ix: string) { const f = path.join(process.cwd(), "data", "oi-minute", day, `strikes-${ix}.csv`); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((r) => r.split(",")).filter((r) => r[0] === day && r[2] === ix); }
// premium minute series per strike/side: research cache, overwritten by the app log where the log has that minute
function premSeries(d: DayData, rows: string[][]) {
  const m = new Map<string, Map<number, number>>(), put = (k: string, t: number, v: number) => { if (!m.has(k)) m.set(k, new Map()); m.get(k)!.set(t, v); };
  for (const [k, arr] of d.legs) for (const x of arr as Min[]) put(k, x.t, x.c);
  for (const r of rows) for (const [side, col] of [["CE", 9], ["PE", 15]] as const) { const v = +r[col]; if (v > 0) put(`${r[4]}${side}`, toT(r[0], r[1]) - 60, v); }
  const o = new Map<string, [number, number][]>(); for (const [k, mm] of m) o.set(k, [...mm.entries()].sort((a, b) => a[0] - b[0])); return o;
}

interface Tr { ix: IX; ver: string; day: string; t: string; side: string; levels: string; strong: boolean; entry: number; res: string; tx: string; pts: number; strike: string; e0: number | null; x1: number | null; net: number | null }
interface Note { ix: IX; ver: string; day: string; text: string }
const trades: Tr[] = [], notes: Note[] = [];
const sessions: Record<IX, string[]> = { NIFTY: [], SENSEX: [] };

for (const ix of ["NIFTY", "SENSEX"] as IX[]) {
  const { step, lot, tgt, cap } = CFG[ix];
  const raw: DayData[] = ix === "NIFTY" ? assemble("2026-08-01", "2026-10-23").days : (assembleIndex("SENSEX", "2026-08-01", "2026-10-23") as any);
  const ds = raw.filter((d) => d.spot.size >= 300), exp = expiryDays(ds, step);
  const minsOf = (d: DayData) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
  for (let di = ds.length - 15; di < ds.length; di++) {
    const D = ds[di], P = ds[di - 1], mins = minsOf(D), pm = minsOf(P).map(([, p]) => p); sessions[ix].push(D.day);
    const prev15 = ds.slice(di - 5, di).flatMap((d) => barsOf(minsOf(d), 15)) as any[], a15 = atr14(prev15.slice(-15))!;
    const pdh = Math.max(...pm), pdl = Math.min(...pm), pdc = pm[pm.length - 1], open = mins[0][1];
    const or = mins.filter(([t]) => mn(t) < 570).map(([, p]) => p), orh = Math.max(...or), orl = Math.min(...or), px930 = or[or.length - 1];
    const baseLv = [...priceActionLevels(prev15, a15).map((l) => ({ p: l.price, name: `S/R ${l.kind.replace("PA ", "")}` })),
      { p: pdh, name: "PDH" }, { p: pdl, name: "PDL" }, { p: pdc, name: "PDC" }, { p: orh, name: "First-15 HIGH" }, { p: orl, name: "First-15 LOW" }];
    // OI at 09:30 (only when the log has a 09:15 snapshot and one between 09:25 and 09:30)
    const rows = logRows(D.day, ix), tms = [...new Set(rows.map((r) => r[1]))].sort(), t15 = tms.find((x) => x === "09:15"), t30 = tms.filter((x) => x >= "09:25" && x <= "09:30").pop();
    let oiVote = 0, oiOk = false;
    if (t15 && t30) { oiOk = true;
      const at = (h: string) => new Map(rows.filter((r) => r[1] === h).map((r) => [+r[4], { ce: +r[6], pe: +r[12] }])), a = at(t15), b = at(t30);
      const ch = [...b.entries()].filter(([k]) => a.has(k)).map(([k, v]) => ({ k, ce: v.ce - a.get(k)!.ce, pe: v.pe - a.get(k)!.pe, ceOi: v.ce, peOi: v.pe }));
      const ce = ch.reduce((s, x) => s + x.ce, 0), pe = ch.reduce((s, x) => s + x.pe, 0); oiVote = pe > ce ? 1 : ce > pe ? -1 : 0;
      const cw = ch.filter((x) => x.k >= px930).sort((x, y) => y.ceOi - x.ceOi)[0], pw = ch.filter((x) => x.k <= px930).sort((x, y) => y.peOi - x.peOi)[0];
      if (cw) baseLv.push({ p: cw.k, name: "OI CALL wall" }); if (pw) baseLv.push({ p: pw.k, name: "OI PUT wall" }); }
    const hist = ds.slice(Math.max(0, di - 10), di).flatMap((d) => barsOf(minsOf(d), 5)), B = barsOf(mins, 5), all = [...hist, ...B], off = hist.length, e21 = ema(all.map((b) => b.close), 21);
    const g930 = off + B.findIndex((b) => mn(b.time) === 565), vP = px930 > pdc ? 1 : -1, vE = all[g930].close > e21[g930] ? 1 : -1;
    const today = premSeries(D, rows), prevS = exp.has(P.day) ? new Map<string, [number, number][]>() : premSeries(P, logRows(P.day, ix));
    const premState = (k: string, bt: number) => { const ser = barsOf(prevS.get(k) || [], 5).concat(barsOf(today.get(k) || [], 5)), j = ser.findIndex((b) => b.time === bt); if (j < 21) return null;
      const c = ser.map((b) => b.close), e9 = ema(c, 9), e2 = ema(c, 21); return { e9: e9[j], e21: e2[j] }; };
    const premAt = (k: string, t: number) => { const v = (today.get(k) || []).filter(([s]) => s + 60 <= t).pop(); return v && t - (v[0] + 60) <= 120 ? v[1] : null; };
    const gapBig = Math.abs(open - pdc) / pdc > 0.003;

    for (const ver of ["V1", "V2"]) {
      let trend = Math.sign(vP + vE + (ver === "V2" && gapBig ? 0 : oiVote)), busy = 0;
      if (ver === "V2" && gapBig && oiOk) notes.push({ ix, ver, day: D.day, text: `gap ${R(open - pdc)} pts > 0.3 %: 09:30 OI vote ignored` });
      const used = new Set<string>(), broken = new Map<string, number>();
      for (let i = 3; i < B.length; i++) {
        const tEnd = B[i].time + 300; if (mn(tEnd) < 575 || mn(tEnd) > 870) continue;
        if (ver === "V2") { const lo = Math.min(orl, pdc), hi = Math.max(orh, pdh);
          const nt = B[i - 1].close < lo && B[i].close < lo ? -1 : B[i - 1].close > hi && B[i].close > hi ? 1 : trend;
          if (nt !== trend) { notes.push({ ix, ver, day: D.day, text: `${hm(tEnd)} trend → ${nt > 0 ? "UP" : "DOWN"}` }); trend = nt; } }
        for (const dir of [1, -1]) {
          // levels broken in this direction at this close, grouped by their breakout candle
          const hits: { L: { p: number; name: string }; k: number; retest: boolean }[] = [];
          for (const L of baseLv) {
            const key = `${L.name}|${R(L.p)}|${dir}`; if (used.has(key)) continue;
            const k = [i - 2, i - 1].find((q) => dir * (B[q - 1].close - L.p) <= 0 && dir * (B[q].close - L.p) > 0 && B.slice(q, i + 1).every((b) => dir * (b.close - L.p) > 0));
            if (k == null || (L.name.startsWith("First-15") && mn(B[k].time) < 570)) continue;
            const retest = ver === "V2" && broken.get(`${L.name}|${R(L.p)}`) === -dir;
            if (retest && k !== i - 2) continue;                       // V2 rule 4: wait for the 3rd close beyond
            hits.push({ L, k, retest }); used.add(key);
          }
          if (!hits.length) continue;
          for (const h of hits) broken.set(`${h.L.name}|${R(h.L.p)}`, dir);
          const groups = ver === "V2" ? [hits] : hits.map((h) => [h]);
          for (const g of groups) {
            const strong = ver === "V2" && new Set(g.map((h) => h.k)).size < g.length, k = Math.max(...g.map((h) => h.k));
            const L = g.slice().sort((a, b) => Math.abs(a.L.p - B[i].close) - Math.abs(b.L.p - B[i].close))[0].L;   // thesis = nearest broken level
            const atm = Math.round(B[i].close / step) * step, side = dir > 0 ? "CE" : "PE", key = `${atm}${side}`, ps = premState(key, B[i].time);
            if (strong && trend !== dir) { notes.push({ ix, ver, day: D.day, text: `${hm(tEnd)} STRONG BREAK (${g.length} levels) → trend ${dir > 0 ? "UP" : "DOWN"}` }); trend = dir; }
            const retest = g.every((h) => h.retest);
            const why = retest && trend !== dir ? "RETEST — WAIT" : trend !== dir ? "against trend" : !ps ? "no premium history" : !(ps.e9 > ps.e21) ? "premium EMA not confirming" : tEnd < busy ? "trade open" : "TRADE";
            if (why !== "TRADE") { notes.push({ ix, ver, day: D.day, text: `${hm(tEnd)} ${dir > 0 ? "breakout" : "breakdown"} ${g.map((h) => h.L.name).join("+")}: ${why}` }); continue; }
            const entry = B[i].close, ext = dir > 0 ? Math.min(B[k].low, B[i].low) : Math.max(B[k].high, B[i].high);
            const hard = ver === "V2" ? (dir > 0 ? Math.max(ext, entry - cap) : Math.min(ext, entry + cap)) : ext, pth = mins.filter(([t]) => t >= tEnd && t < tEnd + 3600);
            let res = "TIME", tx = pth.length ? pth[pth.length - 1][0] + 60 : tEnd;
            for (const [t, p] of pth) { if (dir * (p - entry) >= tgt) { res = "TARGET"; tx = t + 60; break; } if (dir * (p - hard) <= 0) { res = "HARD STOP"; tx = t + 60; break; }
              if ((mn(t + 60) - 555) % 5 === 0 && dir * (p - L.p) <= 0) { res = "THESIS"; tx = t + 60; break; } }
            const e0 = premAt(key, tEnd + 60), x1 = premAt(key, tx + 60), pts = dir * ((mins.filter(([t]) => t <= tx - 60).pop()?.[1] ?? entry) - entry);
            trades.push({ ix, ver, day: D.day, t: hm(tEnd), side, levels: g.map((h) => `${h.L.name} ${h.L.p.toFixed(0)}`).join(" + "), strong, entry, res, tx: hm(tx), pts, strike: key, e0, x1, net: e0 != null && x1 != null ? optionPnl(e0, x1, lot, true).net : null });
            busy = tx;
          }
        }
      }
    }
  }
}

// ---- report
const o: string[] = [], W = (...s: string[]) => o.push(...s);
const sumNet = (xs: Tr[]) => xs.reduce((a, t) => a + (t.net ?? 0), 0);
W("# Day process — OLD (V1) vs NEW (V2), NIFTY + SENSEX, latest 15 sessions", "", "> Simulated historical replay, not live trading. Rules in the header of process15.ts.", "",
  `NIFTY ${sessions.NIFTY[0]} → ${sessions.NIFTY[14]} · SENSEX ${sessions.SENSEX[0]} → ${sessions.SENSEX[14]}. OI is used only on days whose log has 09:15 and 09:25–09:30 snapshots.`, "");
for (const ix of ["NIFTY", "SENSEX"] as IX[]) {
  W(`## ${ix} — day by day (conservative net ₹)`, "", "| Date | OLD trades (T / SL / thesis / time) | OLD net ₹ | NEW trades (T / SL / thesis / time) | NEW net ₹ |", "|---|---|---|---|---|");
  const cnt = (xs: Tr[]) => `${xs.length} (${["TARGET", "HARD STOP", "THESIS", "TIME"].map((r) => xs.filter((t) => t.res === r).length).join(" / ")})`;
  for (const day of sessions[ix]) { const a = trades.filter((t) => t.ix === ix && t.day === day && t.ver === "V1"), b = trades.filter((t) => t.ix === ix && t.day === day && t.ver === "V2");
    W(`| ${day} | ${cnt(a)} | ${R(sumNet(a))} | ${cnt(b)} | ${R(sumNet(b))} |`); }
  for (const ver of ["V1", "V2"]) { const xs = trades.filter((t) => t.ix === ix && t.ver === ver), p = xs.filter((t) => t.net != null), w = p.filter((t) => t.net! > 0).length;
    let c = 0, pk = 0, dd = 0; for (const t of p) { c += t.net!; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
    W(`| **${ver === "V1" ? "OLD" : "NEW"} total** | ${xs.length} trades${xs.length - p.length ? ` (${xs.length - p.length} premium unavailable)` : ""} · win ${p.length ? Math.round((w / p.length) * 100) : 0} % | **${R(sumNet(p))}** | per trade ${p.length ? R(sumNet(p) / p.length) : "—"} | max DD ${R(dd)} |`); }
  W("");
}
W("## Combined", "", "| Version | Trades | Win % | Net ₹ | Per trade ₹ | Profitable days / losing days |", "|---|---|---|---|---|---|");
for (const ver of ["V1", "V2"]) { const p = trades.filter((t) => t.ver === ver && t.net != null), w = p.filter((t) => t.net! > 0).length;
  const days = [...new Set(p.map((t) => `${t.ix}|${t.day}`))].map((k) => sumNet(p.filter((t) => `${t.ix}|${t.day}` === k)));
  W(`| ${ver === "V1" ? "OLD" : "NEW"} | ${p.length} | ${p.length ? Math.round((w / p.length) * 100) : 0} | **${R(sumNet(p))}** | ${p.length ? R(sumNet(p) / p.length) : "—"} | ${days.filter((x) => x > 0).length} / ${days.filter((x) => x <= 0).length} |`); }
W("", "## All trades", "", "| Index | Ver | Date | Entry | Side | Levels broken | Strong | Exit | Reason | Index pts | Option | Premium in → out | Net ₹ |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const t of trades) W(`| ${t.ix} | ${t.ver === "V1" ? "OLD" : "NEW"} | ${t.day} | ${t.t} | ${t.side} | ${t.levels} | ${t.strong ? "yes" : ""} | ${t.tx} | ${t.res} | ${t.pts >= 0 ? "+" : ""}${t.pts.toFixed(1)} | ${t.strike} | ${t.e0 ?? "UNAVAILABLE"} → ${t.x1 ?? "UNAVAILABLE"} | ${t.net == null ? "—" : R(t.net)} |`);
W("", "## NEW version decisions log (trend changes, strong breaks, skips)", "");
for (const n of notes.filter((n) => n.ver === "V2")) W(`- ${n.ix} ${n.day} — ${n.text}`);
fs.writeFileSync(path.join(__dirname, "PROCESS_OLD_VS_NEW_15.md"), o.join("\n") + "\n");
fs.writeFileSync(path.join(__dirname, "process_old_vs_new_15_trades.csv"), ["label,index,version,date,entry,side,levels,strong,exit,reason,index_pts,option,prem_in,prem_out,net_conservative"]
  .concat(trades.map((t) => ["SIMULATED_REPLAY", t.ix, t.ver === "V1" ? "OLD" : "NEW", t.day, t.t, t.side, `"${t.levels}"`, t.strong, t.tx, t.res, t.pts.toFixed(1), t.strike, t.e0 ?? "UNAVAILABLE", t.x1 ?? "UNAVAILABLE", t.net?.toFixed(2) ?? ""].join(","))).join("\n") + "\n");
console.log(o.join("\n"));
process.exit(0);
