// Research driver: `npx tsx backend/research/nifty20/main.ts <step>` — steps: audit | dev | validate | holdout
// Follows PREREGISTRATION.md. Writes DATA_DIR/research-nifty20/results/*.json and *.csv. Research only.
import { loadAll, audit, runFamily, stats, bootstrapLB, nDays, save, csv, FAMILY_FLAGS, inPeriod, type PeriodName } from "./run";
import { familySignals, context, type Flags } from "./signals";
import { istHm, type DayData } from "./data";
import type { SimParams, TradeLog } from "./sim";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../../config/dataDir";

const STOPS = [10, 15, 20], TIMES = [15, 30, 60], FAMILIES = ["A", "B", "C", "D", "E"];
const SLIP = 1;
const RES = path.join(DATA_DIR, "research-nifty20", "results");
const P = (stop: number, maxMin: number, slip = SLIP): SimParams => ({ target: 20, stop, maxMin, slip });

function lookaheadCheck(days: DayData[]) {
  // For a sample of days D: rebuild everything from (all days BEFORE D intact) + (D cut at 12:00), with no later days.
  // Every signal at or before 11:55 on D must equal the full-data run; any difference = future data leaked in.
  const full = context(days);
  let compared = 0, mismatched = 0; const examples: string[] = [];
  days.forEach((d, idx) => {
    if (idx % 7 !== 0) return;
    const lim = Math.floor(Date.parse(`${d.day}T06:30:00Z`) / 1000);   // 12:00 IST
    const cutD = { ...d, spot: new Map([...d.spot].filter(([t]) => t < lim)), legs: new Map([...d.legs].map(([k, a]) => [k, a.filter((m) => m.t < lim)])) };
    const part = context([...days.slice(0, idx), cutD]);
    for (const f of ["BASE", ...FAMILIES]) {
      const a = familySignals(full, d.day, f, FAMILY_FLAGS[f]).filter((s) => istHm(s.t) <= "11:55").map((s) => `${istHm(s.t)} ${s.side} ${s.strike}`);
      const b = familySignals(part, d.day, f, FAMILY_FLAGS[f]).filter((s) => istHm(s.t) <= "11:55").map((s) => `${istHm(s.t)} ${s.side} ${s.strike}`);
      compared++; if (a.join("|") !== b.join("|")) { mismatched++; if (examples.length < 5) examples.push(`${d.day} ${f}: full [${a}] vs cut [${b}]`); }
    }
  });
  return { compared, mismatched, examples };
}

async function main() {
  const step = process.argv[2] || "audit";
  const { a, ctx } = loadAll();
  if (step === "audit") {
    const au = audit(a.days, a.stats);
    const la = lookaheadCheck(a.days);
    const base: any = {};
    for (const per of ["DEV", "VALIDATION", "HOLDOUT"] as PeriodName[]) for (const slip of [0, 1]) {
      const tr = runFamily(ctx, "BASE", { target: 20, stop: 10, maxMin: 30, slip }, per);
      base[`${per}_slip${slip}`] = stats(tr, nDays(ctx, per));
      if (slip === 1) save(`trades_BASE_${per}.csv`, csv(tr));
    }
    save("audit.json", { audit: au, lookahead: la, baselineClean: base });
    console.log(JSON.stringify({ audit: au, lookahead: la, baselineClean: base }, null, 1));
    return;
  }
  if (step === "dev") {
    const rows: any[] = [];
    for (const f of FAMILIES) for (const stop of STOPS) for (const t of TIMES) {
      const tr = runFamily(ctx, f, P(stop, t), "DEV");
      const s = stats(tr, nDays(ctx, "DEV"));
      rows.push({ variant: `${f}_S${stop}_T${t}`, family: f, stop, maxMin: t, ...s, lb90: bootstrapLB(tr), slip2: tr.length ? stats(runFamily(ctx, f, P(stop, t, 2), "DEV"), 1).expectancy : null });
      save(`trades_DEV_${f}_S${stop}_T${t}.csv`, csv(tr));
    }
    // Phase 5 ablation on DEV: family A with each filter removed (stop 15, 30 min), and B/C/E with option-volume added
    const abl: any[] = [];
    const baseA = FAMILY_FLAGS.A;
    const variants: [string, string, Flags][] = [["A all filters", "A", baseA], ["A − oiCover", "A", { ...baseA, oiCover: false }], ["A − candle", "A", { ...baseA, candle: false }],
      ["A − regime15", "A", { ...baseA, regime15: false }], ["A − noFailedBreak", "A", { ...baseA, noFailedBreak: false }], ["A + optVolume", "A", { ...baseA, optVolume: true }],
      ["A OI signal only", "A", { oiCover: true, candle: false, regime15: false, optVolume: false, noFailedBreak: false }]];
    for (const [name, f, fl] of variants) { const tr = runFamily(ctx, f, P(15, 30), "DEV", fl); abl.push({ name, ...stats(tr, nDays(ctx, "DEV")), lb90: bootstrapLB(tr) }); }
    // candidates: pre-registered rule — DEV expectancy > 0 with ≥ 40 trades, ranked by bootstrap lower bound, max 5
    const cands = rows.filter((r) => r.trades >= 40 && r.expectancy > 0).sort((x, y) => (y.lb90 ?? -99) - (x.lb90 ?? -99)).slice(0, 5).map((r) => r.variant);
    save("dev.json", { variantsTried: rows.length, rows, ablation: abl, candidates: cands });
    console.log(JSON.stringify({ variantsTried: rows.length, candidates: cands }, null, 1));
    for (const r of rows) console.log(r.variant.padEnd(12), "trades", String(r.trades).padStart(4), "win", String(r.winRate).padStart(6) + "%", "BE", String(r.breakEvenWinRate).padStart(6) + "%", "exp", String(r.expectancy).padStart(6), "LB90", String(r.lb90).padStart(6), "PF", r.profitFactor, "DD", r.maxDD, "tgt/stop/time", `${r.targetPct}/${r.stopPct}/${r.timePct}`, "slip2", r.slip2);
    console.log("\nABLATION (A, stop 15, 30 min, DEV)"); for (const r of abl) console.log(r.name.padEnd(20), "trades", r.trades, "win", r.winRate, "exp", r.expectancy, "LB90", r.lb90, "PF", r.profitFactor);
    return;
  }
  if (step === "validate" || step === "holdout") {
    const dev = JSON.parse(fs.readFileSync(path.join(RES, "dev.json"), "utf8"));
    let cands: string[] = dev.candidates;
    if (step === "holdout") { const v = JSON.parse(fs.readFileSync(path.join(RES, "validation.json"), "utf8")); cands = v.passed; }
    const per: PeriodName = step === "validate" ? "VALIDATION" : "HOLDOUT";
    const out: any[] = [];
    for (const name of cands) {
      const [f, s, t] = name.split("_"); const stop = Number(s.slice(1)), mm = Number(t.slice(1));
      const tr = runFamily(ctx, f, P(stop, mm), per), st = stats(tr, nDays(ctx, per));
      out.push({ variant: name, ...st, lb90: bootstrapLB(tr), slip2: stats(runFamily(ctx, f, P(stop, mm, 2), per), 1).expectancy });
      save(`trades_${per}_${name}.csv`, csv(tr));
    }
    const passed = out.filter((r) => r.trades >= 40 && r.expectancy > 0).map((r) => r.variant);
    save(step === "validate" ? "validation.json" : "holdout.json", { period: per, candidates: cands, rows: out, passed });
    console.log(JSON.stringify({ period: per, rows: out, passed }, null, 1));
  }
}
main().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
