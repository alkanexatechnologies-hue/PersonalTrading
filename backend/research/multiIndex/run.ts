import fs from "fs";
import path from "path";
import { INDICES, IndexName, assembleIndex } from "./data";
import { runStudy, stats as ebStats } from "../earlyBreakout/run";
import { run as rootRun, VARIANTS, vName, stats as rStats } from "../earlyBreakout/root";
import { analyse } from "../earlyBreakout/trendday";
import { istHm } from "../nifty20/data";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Multi-index replication (PREREGISTRATION.md, research only) ============================
// npx tsx backend/research/multiIndex/run.ts [INDEX ...]     → DEV + VALIDATION for every study, HOLDOUT closed
const OUT = path.join(DATA_DIR, "research-multi", "results");
const per = <T extends { period: string }>(x: T[], p: string) => x.filter((t) => t.period === p);

export function runIndex(n: IndexName) {
  const c = INDICES[n], days = assembleIndex(n, "2024-10-14", "2026-10-12"), opt = { step: c.step, lot: c.lot };
  const res: any = { index: n, days: days.length, first: days[0]?.day, last: days[days.length - 1]?.day, early: {}, root: {}, trendday: {}, c1: {} };
  // 1. early breakout (T15 / E5 / E5P / BNC)
  const eb = runStudy(days, opt);
  for (const s of ["T15", "E5", "E5P", "BNC"]) res.early[s] = { DEV: ebStats(per(eb, "DEV").filter((t) => t.sig === s)), VALIDATION: ebStats(per(eb, "VALIDATION").filter((t) => t.sig === s)) };
  // 2. root breakout — 16 variants, DEV-best (≥ 60 trades) carried to VALIDATION
  const rt = rootRun(days, VARIANTS, opt);
  const rows = VARIANTS.map((v) => { const nm = vName(v), t = rt.filter((x) => x.v === nm); return { nm, DEV: rStats(per(t, "DEV")), VALIDATION: rStats(per(t, "VALIDATION")) }; });
  const best = rows.filter((r) => (r.DEV.n ?? 0) >= 60).sort((a, b) => b.DEV.avgNet - a.DEV.avgNet)[0] || null;
  res.root = { best: best?.nm ?? null, bestDEV: best?.DEV ?? null, bestVALIDATION: best?.VALIDATION ?? null, allDEV: Object.fromEntries(rows.map((r) => [r.nm, { n: r.DEV.n, avg: r.DEV.avgNet }])) };
  // 3. trend-day detector variants + confirmatory C1 (E5 after 10:00 with detector agreement)
  const td = analyse(days, undefined, opt);
  const vnames = [...new Set(td.trades.map((t: any) => t.v))];
  for (const v of vnames) { const t = td.trades.filter((x: any) => x.v === v); res.trendday[v as string] = { DEV: rStats(per(t, "DEV")).avgNet, VALIDATION: rStats(per(t, "VALIDATION")).avgNet, nDEV: per(t, "DEV").length }; }
  const fd = new Map(td.feats.map((f) => [f.day, f]));
  const c1 = (p: string) => eb.filter((t) => t.period === p && t.sig === "E5" && istHm(t.sigTime) >= "10:00").filter((t) => { const f = fd.get(t.day); return f && f.score >= 3 && (t.side === "CE" ? 1 : -1) === f.D; });
  res.c1 = { DEV: rStats(c1("DEV") as any), VALIDATION: rStats(c1("VALIDATION") as any) };
  // verdicts by the pre-registered rules (HOLDOUT stays closed unless positive in DEV and VALIDATION)
  const pos = (x: any) => x && x.n > 0 && x.avgNet > 0;
  res.passToHoldout = {
    early: Object.entries<any>(res.early).filter(([, r]) => pos(r.DEV) && pos(r.VALIDATION)).map(([k]) => k),
    root: best && pos(best.DEV) && pos(best.VALIDATION) ? [best.nm] : [],
    c1: pos(res.c1.DEV) && pos(res.c1.VALIDATION) ? ["C1"] : [],
  };
  return res;
}

if (require.main === module) {
  const list = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(INDICES)) as IndexName[];
  fs.mkdirSync(OUT, { recursive: true });
  for (const n of list) {
    const r = runIndex(n);
    fs.writeFileSync(path.join(OUT, `${n}.json`), JSON.stringify(r, null, 1));
    const e = (s: string) => `${s} ${r.early[s].DEV.avgNet ?? "—"}/${r.early[s].VALIDATION.avgNet ?? "—"} (n ${r.early[s].DEV.n}/${r.early[s].VALIDATION.n})`;
    console.log(`\n== ${n}: ${r.days} days ${r.first} → ${r.last}`);
    console.log("  early breakout avgNet DEV/VAL:", ["T15", "E5", "E5P", "BNC"].map(e).join(" · "));
    console.log("  root best:", r.root.best, "DEV", JSON.stringify({ n: r.root.bestDEV?.n, avg: r.root.bestDEV?.avgNet, win: r.root.bestDEV?.winPct }), "VAL", JSON.stringify({ n: r.root.bestVALIDATION?.n, avg: r.root.bestVALIDATION?.avgNet, lb: r.root.bestVALIDATION?.lb95 }));
    console.log("  trend-day variants DEV/VAL:", Object.entries<any>(r.trendday).map(([k, v]) => `${k} ${v.DEV}/${v.VALIDATION}`).join(" · "));
    console.log("  C1:", JSON.stringify({ DEV: { n: r.c1.DEV.n, avg: r.c1.DEV.avgNet }, VAL: { n: r.c1.VALIDATION.n, avg: r.c1.VALIDATION.avgNet, lb: r.c1.VALIDATION.lb95 } }));
    console.log("  pass to HOLDOUT:", JSON.stringify(r.passToHoldout));
  }
}
