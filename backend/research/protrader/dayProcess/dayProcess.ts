// Owner's day process (2026-10-24), replayed for ONE day on NIFTY and SENSEX only. SIMULATED HISTORICAL REPLAY. Research only.
//  STEP 1  09:15  mark levels known before the open: owner S/R (15-min turn clusters / flip zones of the previous 5 sessions,
//                 priceActionLevels), previous-day high / low / close.
//  STEP 2  09:30  first-15-min high / low (09:15–09:29 1-min closes); OI review from the app's ±10-strike minute log
//                 (data/oi-minute): which strikes ADDED call OI and put OI between 09:15 and 09:30, and the biggest walls.
//  STEP 3  09:30  trend = majority of 3 votes: price vs previous close, price vs 5-min EMA 21, put OI added vs call OI added.
//  STEP 4  every 5-min close 09:35–14:30: BREAKOUT (BREAKDOWN mirror) of a marked level L = within the last three 5-min
//                 candles one candle closed across L and every close since stayed beyond L, with at least 2 closes beyond
//                 (the breakout candle + one holding candle). Each level once per direction per day.
//  STEP 5  premium cross-check (secondary): the ATM option on the trade side has 5-min EMA 9 > EMA 21 at that close.
//          Premiums (EMAs and fills) come from the app's ±10-strike minute log (data/oi-minute ceLtp / peLtp, previous logged
//          session as EMA warm-up unless it was an expiry); the research cache keeps only ATM ± 3, which loses strikes on a
//          big SENSEX day. A snapshot logged at hh:mm is the price at hh:mm; a fill uses the latest snapshot ≤ 2 min old.
//  Skipped breakouts are also scored with the same exit ("if taken"), for review only.
//  TRADE   only when the breakout agrees with the 09:30 trend AND the premium confirms. Buy the ATM CE / PE at that close.
//          Exit on the index: target +30 NIFTY / +100 SENSEX points, thesis stop = a 5-min close back across L, hard stop =
//          the breakout candle's opposite extreme on a 1-min close, 60 minutes. One trade at a time per index.
//          ₹ = 1 lot (NIFTY 75, SENSEX 20), corrected standard costs, conservative (1-minute delay, +0.5 %/side).
// Usage: npx tsx dayProcess.ts [YYYY-MM-DD]   (default 2026-10-23; writes DAY_PROCESS_<date>.md next to this file)
import fs from "fs";
import path from "path";
import { assemble, DayData } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { barsOf, expiryDays } from "../premiumBacktest2";
import { priceActionLevels } from "../priceActionLevels";
import { optionPnl } from "../final1560/strategy";

const DAY = process.argv[2] || "2026-10-23";
const CFG = { NIFTY: { step: 50, lot: 75, tgt: 30 }, SENSEX: { step: 100, lot: 20, tgt: 100 } } as const;
type IX = keyof typeof CFG; type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60), hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };
const R = (v: number) => Math.round(v).toLocaleString("en-IN"), F = (v: number) => v.toFixed(1);

const toT = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`) / 1000;
function logRows(day: string, ix: string) { const f = path.join(process.cwd(), "data", "oi-minute", day, `strikes-${ix}.csv`); if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((r) => r.split(",")).filter((r) => r[0] === day && r[2] === ix); }
function logPrem(rows: string[][]) { const m = new Map<string, [number, number][]>();
  for (const r of rows) for (const [side, col] of [["CE", 9], ["PE", 15]] as const) { const v = +r[col]; if (!(v > 0)) continue; const k = `${r[4]}${side}`; if (!m.has(k)) m.set(k, []); m.get(k)!.push([toT(r[0], r[1]) - 60, v]); }
  for (const a of m.values()) a.sort((x, y) => x[0] - y[0]); return m; }
const out: string[] = [], W = (...s: string[]) => out.push(...s);
W(`# Day process replay — ${DAY} — NIFTY and SENSEX`, "", "> Simulated historical replay of the owner's day process, not live trading. Rules are in the header of dayProcess.ts.", "");

for (const ix of ["NIFTY", "SENSEX"] as IX[]) {
  const { step, lot, tgt } = CFG[ix];
  const raw: DayData[] = ix === "NIFTY" ? assemble("2026-08-01", DAY).days : (assembleIndex("SENSEX", "2026-08-01", DAY) as any);
  const ds = raw.filter((d) => d.spot.size >= 300), di = ds.findIndex((d) => d.day === DAY);
  if (di < 6) { W(`## ${ix}`, "", `No data for ${DAY}.`, ""); continue; }
  const minsOf = (d: DayData) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
  const D = ds[di], P = ds[di - 1], mins = minsOf(D), pm = minsOf(P).map(([, p]) => p);
  // STEP 1 — levels before the open
  const prev15 = ds.slice(di - 5, di).flatMap((d) => barsOf(minsOf(d), 15)) as any[], a15 = atr14(prev15.slice(-15))!;
  const owner = priceActionLevels(prev15, a15);
  const pdh = Math.max(...pm), pdl = Math.min(...pm), pdc = pm[pm.length - 1], open = mins[0][1];
  const lv: { p: number; name: string }[] = [...owner.map((l) => ({ p: l.price, name: `S/R ${l.kind.replace("PA ", "")}` })), { p: pdh, name: "PDH" }, { p: pdl, name: "PDL" }, { p: pdc, name: "PDC" }];
  W(`## ${ix}`, "", "### Step 1 — 09:15 levels (known before the open)", "",
    `Open ${F(open)} · PDH ${F(pdh)} · PDL ${F(pdl)} · PDC ${F(pdc)} · gap ${open - pdc >= 0 ? "+" : ""}${F(open - pdc)} pts`, "",
    "| Level | Type | Distance from open |", "|---|---|---|");
  for (const l of [...lv].sort((a, b) => b.p - a.p)) if (Math.abs(l.p - open) <= 3 * a15) W(`| ${F(l.p)} | ${l.name} | ${l.p - open >= 0 ? "+" : ""}${F(l.p - open)} |`);
  W("", `(${owner.length} owner S/R levels from the previous 5 sessions; listed: those within 3 × 15-min ATR ≈ ${R(3 * a15)} pts of the open.)`, "");
  // STEP 2 — 09:30: first 15 min + OI
  const or = mins.filter(([t]) => mn(t) < 570).map(([, p]) => p), orh = Math.max(...or), orl = Math.min(...or), px930 = mins.filter(([t]) => mn(t) < 570).pop()![1];
  lv.push({ p: orh, name: "First-15 HIGH" }, { p: orl, name: "First-15 LOW" });
  W("### Step 2 — 09:30 first 15 minutes + OI", "", `First-15 HIGH ${F(orh)} · LOW ${F(orl)} · range ${F(orh - orl)} pts · price at 09:30 ${F(px930)}`, "");
  const rows = logRows(DAY, ix); let oiVote = 0, oiNote = "OI log missing for this day";
  if (rows) {
    // latest logged minute at or before hh:mm (the SENSEX log has gaps, e.g. no 09:30 row on 23 Oct)
    const at = (hhmm: string) => { const t = rows.map((r) => r[1]).filter((x) => x <= hhmm).sort().pop(); return { t, m: new Map(rows.filter((r) => r[1] === t).map((r) => [+r[4], { ce: +r[6], pe: +r[12] }])) }; };
    const A = at("09:15"), Bq = at("09:30"), a = A.m, b = Bq.m;
    W(`OI snapshots used: ${A.t} → ${Bq.t}`, ""); const ch = [...b.entries()].filter(([k]) => a.has(k)).map(([k, v]) => ({ k, ce: v.ce - a.get(k)!.ce, pe: v.pe - a.get(k)!.pe, ceOi: v.ce, peOi: v.pe }));
    const ceAdd = ch.reduce((s, x) => s + x.ce, 0), peAdd = ch.reduce((s, x) => s + x.pe, 0);
    const ceWall = [...ch].filter((x) => x.k >= px930).sort((x, y) => y.ceOi - x.ceOi)[0], peWall = [...ch].filter((x) => x.k <= px930).sort((x, y) => y.peOi - x.peOi)[0];
    oiVote = peAdd > ceAdd ? 1 : ceAdd > peAdd ? -1 : 0;
    oiNote = `Call OI added ${R(ceAdd)} · Put OI added ${R(peAdd)} → ${oiVote > 0 ? "PUT writers stronger (bullish)" : oiVote < 0 ? "CALL writers stronger (bearish)" : "balanced"}`;
    if (ceWall) lv.push({ p: ceWall.k, name: "OI CALL wall" }); if (peWall) lv.push({ p: peWall.k, name: "OI PUT wall" });
    W("| Strike | Call OI added 09:15→09:30 | Put OI added 09:15→09:30 |", "|---|---|---|");
    for (const x of ch.filter((x) => Math.abs(x.k - px930) <= 3 * step).sort((x, y) => y.k - x.k)) W(`| ${x.k} | ${R(x.ce)} | ${R(x.pe)} |`);
    W("", `${oiNote}. Biggest CALL wall above: ${ceWall ? `${ceWall.k} (${R(ceWall.ceOi)})` : "—"} · biggest PUT wall below: ${peWall ? `${peWall.k} (${R(peWall.peOi)})` : "—"}`, "");
  } else W(oiNote, "");
  // STEP 3 — trend at 09:30
  const hist = ds.slice(Math.max(0, di - 10), di).flatMap((d) => barsOf(minsOf(d), 5)), B = barsOf(mins, 5), all = [...hist, ...B], off = hist.length, e21 = ema(all.map((b) => b.close), 21);
  const g930 = off + B.findIndex((b) => mn(b.time) === 565), v1 = px930 > pdc ? 1 : -1, v2 = all[g930].close > e21[g930] ? 1 : -1, trend = Math.sign(v1 + v2 + oiVote);
  W("### Step 3 — 09:30 trend", "", `vs previous close: ${v1 > 0 ? "above (+)" : "below (−)"} · vs 5-min EMA 21 (${F(e21[g930])}): ${v2 > 0 ? "above (+)" : "below (−)"} · OI: ${oiVote > 0 ? "+" : oiVote < 0 ? "−" : "0"} → **${trend > 0 ? "UP" : trend < 0 ? "DOWN" : "SIDEWAYS"}**`, "");
  // premium 5-min EMAs (previous session warm-up, not across an expiry)
  const exp = expiryDays(ds.slice(di - 3, di + 1), step), today = logPrem(rows || []), pr = logRows(P.day, ix), prevP = pr && !exp.has(P.day) ? logPrem(pr) : new Map<string, [number, number][]>();
  const legB = (m: Map<string, [number, number][]>, k: string) => barsOf(m.get(k) || [], 5);
  const premState = (k: string, bt: number) => { const ser = legB(prevP, k).concat(legB(today, k)), j = ser.findIndex((b) => b.time === bt); if (j < 21) return null;
    const c = ser.map((b) => b.close), e9 = ema(c, 9), e2 = ema(c, 21); return { c: c[j], e9: e9[j], e21: e2[j], fresh: [0, 1, 2].some((q) => j - q - 1 >= 0 && e9[j - q] > e2[j - q] && e9[j - q - 1] <= e2[j - q - 1]) }; };
  const premAt = (k: string, t: number) => { const v = (today.get(k) || []).filter(([s]) => s + 60 <= t).pop(); return v && t - (v[0] + 60) <= 120 ? v[1] : null; };
  // STEP 4 + 5 — 5-min scan
  W("### Steps 4–5 — every 5-min close: breakout / breakdown + premium cross-check", "", "| Time | Event | Level | Index close | Trend agrees? | ATM premium (close · E9 · E21) | Decision | Outcome with the same exit (conservative ₹) |", "|---|---|---|---|---|---|---|---|");
  const used = new Set<string>(), trades: any[] = []; let busy = 0;
  for (let i = 3; i < B.length; i++) {
    const tEnd = B[i].time + 300; if (mn(tEnd) < 575 || mn(tEnd) > 870) continue;
    for (const L of lv) for (const dir of [1, -1]) {
      const key = `${L.name}|${R(L.p)}|${dir}`; if (used.has(key)) continue;
      const k = [i - 2, i - 1].find((q) => dir * (B[q - 1].close - L.p) <= 0 && dir * (B[q].close - L.p) > 0 && B.slice(q, i + 1).every((b) => dir * (b.close - L.p) > 0));
      if (k == null || (L.name.startsWith("First-15") && mn(B[k].time) < 570)) continue;
      used.add(key);
      const atm = Math.round(B[i].close / step) * step, side = dir > 0 ? "CE" : "PE", ps = premState(`${atm}${side}`, B[i].time), agree = trend === dir, prem = !!ps && ps.e9 > ps.e21;
      const why = !agree ? "SKIP — against the 09:30 trend" : !prem ? "SKIP — premium EMA 9 not above EMA 21" : tEnd < busy ? "SKIP — a trade is already open" : "TRADE";
      // exit on the index (scored for skipped breakouts too, review only)
      const entry = B[i].close, hard = dir > 0 ? Math.min(B[k].low, B[i].low) : Math.max(B[k].high, B[i].high), path = mins.filter(([t]) => t >= tEnd && t < tEnd + 3600);
      let res = "TIME 60 min", tx = path.length ? path[path.length - 1][0] + 60 : tEnd, mfe = 0;
      for (const [t, p] of path) { mfe = Math.max(mfe, dir * (p - entry));
        if (dir * (p - entry) >= tgt) { res = `TARGET +${tgt}`; tx = t + 60; break; }
        if (dir * (p - hard) <= 0) { res = "HARD STOP"; tx = t + 60; break; }
        if ((mn(t + 60) - 555) % 5 === 0 && t + 60 > tEnd && dir * (p - L.p) <= 0) { res = "THESIS (5-min close back across level)"; tx = t + 60; break; } }
      const k2 = `${atm}${side}`, e0 = premAt(k2, tEnd + 60), x1 = premAt(k2, tx + 60);   // conservative: 1-minute delay on both fills
      const pnl = e0 != null && x1 != null ? optionPnl(e0, x1, lot, true) : null, idxPts = dir * ((mins.filter(([t]) => t <= tx - 60).pop()?.[1] ?? entry) - entry);
      W(`| ${hm(tEnd)} | ${dir > 0 ? "BREAKOUT ↑" : "BREAKDOWN ↓"} (candle ${hm(B[k].time + 300)} + hold) | ${L.name} ${F(L.p)} | ${F(B[i].close)} | ${agree ? "yes" : "no"} | ${side} ${atm}: ${ps ? `${ps.c.toFixed(1)} · ${ps.e9.toFixed(1)} · ${ps.e21.toFixed(1)}${ps.fresh ? " (fresh cross)" : ""}` : "n/a (no premium history)"} | ${why} | ${res} ${hm(tx)}: ${idxPts >= 0 ? "+" : ""}${F(idxPts)} pts (best ${F(mfe)}), ${pnl ? `₹${R(pnl.net)}` : "₹ n/a"} |`);
      if (why !== "TRADE") continue;
      busy = tx;
      trades.push({ t: hm(tEnd), dir, L, entry, hard, res, tx: hm(tx), idxPts, mfe, k2, e0, x1, pnl });
    }
  }
  if (!used.size) W("| — | no breakout or breakdown of a marked level | | | | | | |");
  W("", "### Trades", "");
  if (!trades.length) W("No trade: no breakout agreed with the trend AND had premium confirmation.", "");
  else { W("| Entry | Side | Level | Index entry → hard stop | Exit | Reason | Index pts (best) | Option | Premium in → out | Net ₹ (conservative) |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const x of trades) W(`| ${x.t} | ${x.dir > 0 ? "CE" : "PE"} | ${x.L.name} ${F(x.L.p)} | ${F(x.entry)} → ${F(x.hard)} | ${x.tx} | ${x.res} | ${x.idxPts >= 0 ? "+" : ""}${F(x.idxPts)} (${F(x.mfe)}) | ${x.k2} | ${x.e0 ?? "UNAVAILABLE"} → ${x.x1 ?? "UNAVAILABLE"} | ${x.pnl ? R(x.pnl.net) : "—"} |`);
    W("", `Day net: ₹${R(trades.reduce((s, x) => s + (x.pnl?.net ?? 0), 0))}`, ""); }
}
fs.writeFileSync(path.join(__dirname, `DAY_PROCESS_${DAY}.md`), out.join("\n") + "\n");
console.log(out.join("\n"));
process.exit(0);
