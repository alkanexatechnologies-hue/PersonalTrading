// 🗺️ Scenario Map odds (owner, 2026-10-28): gap down / up 50–100, which level holds / breaks / recovers, liquidity sweeps,
// and the 1:2 trade (40 target / 20 stop) at each — measured on real Dhan 1-min index data, NIFTY + SENSEX, DEV / VAL halves.
// Writes backend/premium/scenario-stats.json (read by the One Trade scenario map) and RESULTS_SCENARIO.md.
// Run: npx tsx backend/research/protrader/scenarioStudy.ts
import * as fs from "fs";
import * as path from "path";
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { computeStats, mn, SCALE, Sess, IndexStats, RULES } from "../../premium/scenarioStats";
import { readReversals } from "../../premium/reversalRead";

const to = latestRawDay();
const sess = (days: any[]): Sess[] => days.filter((d) => d.spot.size >= 300).map((d) => ({ day: d.day, m: ([...d.spot.entries()] as [number, number][]).sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) }));
const S: Record<string, Sess[]> = { NIFTY: sess(assemble(FROM, to).days), SENSEX: sess(assembleIndex("SENSEX", FROM, to)) };
const out: Record<string, { all: IndexStats; dev: IndexStats; val: IndexStats }> = {};
for (const [name, ss] of Object.entries(S)) {
  const cut = Math.floor(ss.length / 2), k = SCALE[name];
  out[name] = { all: computeStats(ss, k), dev: computeStats(ss.slice(0, cut), k), val: computeStats(ss.slice(cut - 5), k) };
}
// 🔄 reversal vs ❌ fake reversal (premium/reversalRead.ts) on 15-min bars built from the minutes; levels = previous day H / L / C
const bars15 = (m: [number, number][]) => { const out: any[] = []; let k = -1, cur: any = null; for (const [t, p] of m) { const b = Math.floor((mn(t) - 555) / 15); if (b !== k) { if (cur) out.push(cur); k = b; cur = { time: t, open: p, high: p, low: p, close: p }; } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } } if (cur) out.push(cur); return out; };
const revStats = (ss: Sess[]) => {
  const z = () => ({ n: 0, REAL: 0, FAKE: 0, WEAK: 0 }), all = z(), lvl = z(), noLvl = z(), pat: Record<string, any> = {}, dev = z(), val = z(), cut = Math.floor(ss.length / 2);
  for (let i = 1; i < ss.length; i++) {
    const B = bars15(ss[i].m), P = bars15(ss[i - 1].m); if (B.length < 20 || P.length < 20) continue;
    const rs = [...P, ...B].map((x) => x.high - x.low).sort((a, b) => a - b), medR = rs[Math.floor(rs.length / 2)] || 1, pv = ss[i - 1].m.map((x) => x[1]);
    const levels = [{ label: "PDH", price: Math.max(...pv) }, { label: "PDL", price: Math.min(...pv) }, { label: "PDC", price: pv[pv.length - 1] }];
    for (const r of readReversals(B, medR, levels)) {
      if (r.status === "PENDING") continue;
      for (const g of [all, r.level ? lvl : noLvl, (pat[r.pattern] ||= z()), i < cut ? dev : val]) { g.n++; g[r.status]++; }
    }
  }
  const pc = (g: any) => ({ n: g.n, realPct: g.n ? Math.round((g.REAL / g.n) * 1000) / 10 : 0, fakePct: g.n ? Math.round((g.FAKE / g.n) * 1000) / 10 : 0, weakPct: g.n ? Math.round((g.WEAK / g.n) * 1000) / 10 : 0 });
  return { all: pc(all), atLevel: pc(lvl), noLevel: pc(noLvl), dev: pc(dev), val: pc(val), byPattern: Object.fromEntries(Object.entries(pat).map(([k, g]) => [k, pc(g)])) };
};
const reversal = Object.fromEntries(Object.entries(S).map(([k, ss]) => [k, revStats(ss)]));
const json = { reversal, generated: new Date().toISOString().slice(0, 10), rules: RULES, source: "Real Dhan 1-min index data (research raw1m), " + FROM + " → " + to, indices: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.all])), split: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { dev: v.dev, val: v.val }])) };
fs.writeFileSync(path.join(__dirname, "../../premium/scenario-stats.json"), JSON.stringify(json, null, 1));
const T = (t: any) => `${t.n} · ${t.winPct}% · ${t.avgPts > 0 ? "+" : ""}${t.avgPts}`;
const md = [`# 🗺️ Scenario Map odds · ${json.generated}`, "", json.source + `. Trades 1:2: target ${RULES.target} / stop ${RULES.stop} NIFTY pts (SENSEX × 3.25), 15:12 exit. Trade cells = n · win % · avg pts per trade (before premium costs; ~1 pt per trade on NIFTY options ≈ breakeven needs avg > +1).`, ""];
for (const [name, v] of Object.entries(out)) {
  md.push(`## ${name} (${v.all.sessions} sessions, median day range ${v.all.medRange} pts)`, "", "| Gap | Split | Days | Share | Fill | Fill by 10:15 | +40 in gap dir first | OR-low sweep | OR-low sweep long | OR-high sweep short | OR break up long | OR break down short |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const g of ["BIG_DOWN", "DOWN", "FLAT", "UP", "BIG_UP"]) for (const [lbl, s] of [["all", v.all], ["DEV", v.dev], ["VAL", v.val]] as const) { const x = (s as any).gaps[g]; md.push(`| ${g} | ${lbl} | ${x.n} | ${x.sharePct}% | ${x.fillPct}% | ${x.fillBy1015Pct}% | ${x.contPct}% | ${x.orLowSweepPct}% | ${T(x.orLowSweepLong)} | ${T(x.orHighSweepShort)} | ${T(x.orBreakUpLong)} | ${T(x.orBreakDownShort)} |`); }
  md.push("", "| Level (S support / R resistance) | Split | Touches | Hold +40 | Break −40 | Sweep then hold | Recover after break | Defend trade | Break trade |", "|---|---|---|---|---|---|---|---|---|");
  for (const key of Object.keys(v.all.levels).sort()) for (const [lbl, s] of [["all", v.all], ["DEV", v.dev], ["VAL", v.val]] as const) { const x = (s as any).levels[key]; if (!x) continue; md.push(`| ${key} | ${lbl} | ${x.n} | ${x.holdPct}% | ${x.breakPct}% | ${x.sweepPct}% | ${x.recoverPct}% | ${T(x.defend)} | ${T(x.breakTrade)} |`); }
  md.push("");
}
md.push("## 🔄 Reversal vs ❌ fake reversal candles (15-min, premium/reversalRead.ts)", "", "| Index | Group | Candles | Real | Fake | Sideways |", "|---|---|---|---|---|---|");
for (const [k, r] of Object.entries(reversal) as any) for (const [g, x] of [["all", r.all], ["at PDH/PDL/PDC", r.atLevel], ["away from levels", r.noLevel], ["DEV", r.dev], ["VAL", r.val], ...Object.entries(r.byPattern)] as any) md.push(`| ${k} | ${g} | ${x.n} | ${x.realPct}% | ${x.fakePct}% | ${x.weakPct}% |`);
fs.writeFileSync(path.join(__dirname, "RESULTS_SCENARIO.md"), md.join("\n") + "\n");
console.log(md.join("\n"));
