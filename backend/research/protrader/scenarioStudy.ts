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

const to = latestRawDay();
const sess = (days: any[]): Sess[] => days.filter((d) => d.spot.size >= 300).map((d) => ({ day: d.day, m: ([...d.spot.entries()] as [number, number][]).sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) }));
const S: Record<string, Sess[]> = { NIFTY: sess(assemble(FROM, to).days), SENSEX: sess(assembleIndex("SENSEX", FROM, to)) };
const out: Record<string, { all: IndexStats; dev: IndexStats; val: IndexStats }> = {};
for (const [name, ss] of Object.entries(S)) {
  const cut = Math.floor(ss.length / 2), k = SCALE[name];
  out[name] = { all: computeStats(ss, k), dev: computeStats(ss.slice(0, cut), k), val: computeStats(ss.slice(cut - 5), k) };
}
const json = { generated: new Date().toISOString().slice(0, 10), rules: RULES, source: "Real Dhan 1-min index data (research raw1m), " + FROM + " → " + to, indices: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.all])), split: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { dev: v.dev, val: v.val }])) };
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
fs.writeFileSync(path.join(__dirname, "RESULTS_SCENARIO.md"), md.join("\n") + "\n");
console.log(md.join("\n"));
