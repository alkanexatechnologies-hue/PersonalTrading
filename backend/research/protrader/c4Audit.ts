// C4 audit (owner, 2026-10-24; corrected same day): the EXISTING C4 rule (fakeUpPaperCore.isPaperSignal on fakeMoveGrid.run
// events) replayed over two years. No rule is changed. Research only. Usage: npx tsx c4Audit.ts > RESULTS_C4_AUDIT.md
//
// CORRECTIONS vs the first version of this audit:
//  · Periods now use the SELECTION split of the 22,304-combination grid (fakeMoveGrid.ts, commit 29e3321): that run loaded
//    FROM 2024-10-01, which skips October 2024 because the cached chunks are named 2024-10-14_…; it saw 487 sessions,
//    2024-11-04 → 2026-10-23, first ⅔ = 2024-11-04 → 2026-02-23, last ⅓ = 2026-02-24 → 2026-10-23. The first version used the
//    split of a 501-session run (cut at 2026-02-18) and so mislabelled 4 sessions and mixed in 10 October-2024 sessions.
//  · One cost model for every trade, two variants, both listed with their exact components (section 5).
import { DayData } from "../nifty20/data";
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { run } from "./fakeMoveGrid";
import { isPaperSignal } from "./fakeUpPaperCore";
import { load } from "./final1560/dataAudit";
import { prepareIndex, c2Day } from "./final1560/backtest";
import { optionPnl } from "./final1560/strategy";

const LOT = { NIFTY: 75, SENSEX: 20 } as const, STEP = { NIFTY: 50, SENSEX: 100 } as const;
const slip = (p: number) => Math.max(0.5, 0.0025 * p), hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
type IX = keyof typeof LOT;
interface Sig { ix: IX; day: string; period: string; block: string; t: number; lvl: number; px: number; stopIdx: number; tgtIdx: number; res: string; tOut: number; strike: number;
  premIn: number; premOut: number; netA: number; netAC: number; netB: number | null; netBC: number | null; mfe: number; mae: number; c2dir: number | null; c2before: string }

// the grid's selection split, recomputed exactly as fakeMoveGrid.ts did it
const gridDays = (ix: IX) => (ix === "NIFTY" ? assemble("2024-10-01", "2026-10-23").days : assembleIndex("SENSEX", "2024-10-01", "2026-10-23")).filter((d) => d.spot.size >= 300).map((d) => d.day);
const split: Record<IX, { first: string; cut: string; last: string }> = {} as any;
for (const ix of ["NIFTY", "SENSEX"] as IX[]) { const g = gridDays(ix), c = Math.floor((g.length * 2) / 3); split[ix] = { first: g[0], cut: g[c], last: g[g.length - 1] }; }
const periodOf = (ix: IX, day: string) => (day < split[ix].first ? "NOT IN GRID (Oct 2024)" : day < split[ix].cut ? "SELECTION first ⅔" : "SELECTION last ⅓");

const all: Sig[] = [];
for (const ix of ["NIFTY", "SENSEX"] as IX[]) {
  const days = load(ix), ds = days.filter((d) => d.spot.size >= 300), Pp = prepareIndex(ix), c2: { day: string; t: number; dir: number }[] = [];
  for (let di = 1; di < Pp.ds.length; di++) for (const tr of c2Day(Pp, di)) c2.push({ day: tr.day, t: tr.t, dir: tr.dir });
  for (const e of run(days as DayData[], 5, STEP[ix]).ev) {
    if (!isPaperSignal(e as any, "2000-01-01") || e.premIn == null || e.p0 == null) continue;
    const d = Math.max(e.stop - e.px, 0.25 * e.atr), di = Pp.ds.findIndex((x) => x.day === e.day), spot = [...ds.find((x) => x.day === e.day)!.spot.entries()].sort((a, b) => a[0] - b[0]);
    const tOut = e.r0.tOut ?? e.t, pathMin = spot.filter(([t]) => t >= e.t && t < tOut + 60), lot = LOT[ix], key = `${e.atm}PE`;
    // Model A (as fakeMoveGrid / the paper test score the premium): premium out = premium in × (1 + p0 %)
    const premOut = e.premIn * (1 + e.p0 / 100);
    const netA = (premOut - e.premIn - slip(e.premIn) - slip(premOut)) * lot - 40, netAC = netA - 0.005 * (e.premIn + premOut) * lot;
    // Model B (final1560 standard): base = optionPnl at the entry / exit minutes; conservative = +0.5 %/side AND 1-minute delay
    const b0 = Pp.premAt(di, key, e.t), b1 = Pp.premAt(di, key, tOut + 60), c0 = Pp.premAt(di, key, e.t + 60), c1 = Pp.premAt(di, key, tOut + 120);
    const prior = c2.filter((c) => c.day === e.day && c.t <= e.t).pop(), firstC2 = c2.find((c) => c.day === e.day);
    all.push({ ix, day: e.day, period: periodOf(ix, e.day), block: e.day.slice(0, 4) + (e.day.slice(5, 7) <= "06" ? "-H1" : "-H2"), t: e.t, lvl: e.lvl, px: e.px, stopIdx: e.px + d, tgtIdx: e.px - d,
      res: e.r0.win ? "TARGET" : e.r0.loss ? "STOP" : "TIME", tOut, strike: e.atm, premIn: e.premIn, premOut, netA, netAC,
      netB: b0 != null && b1 != null ? optionPnl(b0, b1, lot).net : null, netBC: c0 != null && c1 != null ? optionPnl(c0, c1, lot, true).net : null,
      mfe: pathMin.length ? e.px - Math.min(...pathMin.map(([, p]) => p)) : 0, mae: pathMin.length ? Math.max(...pathMin.map(([, p]) => p)) - e.px : 0,
      c2dir: prior ? prior.dir : null, c2before: firstC2 ? `first C2 of the day at ${hm(firstC2.t)} (${firstC2.dir > 0 ? "UP" : "DOWN"})` : "no C2 signal that day" });
  }
}
all.sort((a, b) => a.t - b.t);

const R0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-IN") : "—");
function met(xs: Sig[], base: (x: Sig) => number | null, cons: (x: Sig) => number | null) {
  const ok = xs.filter((x) => base(x) != null && cons(x) != null), n = ok.length; if (!n) return null;
  const v = ok.map((x) => base(x)!), vc = ok.map((x) => cons(x)!), P = v.filter((x) => x > 0).reduce((a, b) => a + b, 0), N = -v.filter((x) => x <= 0).reduce((a, b) => a + b, 0);
  const Pc = vc.filter((x) => x > 0).reduce((a, b) => a + b, 0), Nc = -vc.filter((x) => x <= 0).reduce((a, b) => a + b, 0);
  let c = 0, pk = 0, dd = 0; for (const x of vc) { c += x; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
  return { n, missing: xs.length - n, tgt: ok.filter((x) => x.res === "TARGET").length, stp: ok.filter((x) => x.res === "STOP").length, tm: ok.filter((x) => x.res === "TIME").length,
    win: (v.filter((x) => x > 0).length / n) * 100, exp: (P - N) / n, expC: (Pc - Nc) / n, pf: N ? P / N : Infinity, pfC: Nc ? Pc / Nc : Infinity, total: P - N, dd };
}
const HDR = "| Group | Trades | Target / Stop / Time | Win % (net > 0) | Net / trade ₹ | Conservative / trade ₹ | PF / PF cons | Total net ₹ | Max DD cons ₹ |\n|---|---|---|---|---|---|---|---|---|";
const row = (lab: string, xs: Sig[], m = "B") => { const r = m === "A" ? met(xs, (x) => x.netA, (x) => x.netAC) : met(xs, (x) => x.netB, (x) => x.netBC);
  return r ? `| ${lab}${r.missing ? ` (${r.missing} without premium at a fill minute)` : ""} | ${r.n} | ${r.tgt} / ${r.stp} / ${r.tm} | ${r.win.toFixed(1)} | ${R0(r.exp)} | ${R0(r.expC)} | ${r.pf === Infinity ? "∞" : r.pf.toFixed(2)} / ${r.pfC === Infinity ? "∞" : r.pfC.toFixed(2)} | ${R0(r.total)} | ${R0(r.dd)} |` : `| ${lab} | 0 | | | | | | | |`; };

const out: string[] = [], W = (...s: string[]) => out.push(...(s.length ? s : [""]));
W("# C4 audit — corrected (generated by c4Audit.ts)", "",
  "Rule (unchanged): fakeUpPaperCore.isPaperSignal — fake-up CONFIRMED at an OWNER S/R level + call writing (ATM CE OI ↑, CE premium ↓ over the 4-bar window) + level touched ≥ 30 min earlier. ATM PE at the confirming 5-min close; index stop = 4-bar high (≥ 0.25 ATR), target 1 : 1, 60 min (fakeMoveGrid.score1to1). ₹ per lot (NIFTY 75, SENSEX 20).", "");
W("## 1. Selection periods (exact dates)", "",
  `- Grid run that selected the rule (fakeMoveGrid.ts, commit 29e3321, 2026-10-24 16:00 IST): FROM 2024-10-01 → loads ${split.NIFTY.first} → ${split.NIFTY.last} (October 2024 is skipped: cached chunks are named 2024-10-14_…).`,
  `- First ⅔ (rules ranked here): ${split.NIFTY.first} → day before ${split.NIFTY.cut}. Last ⅓ (used to CHECK and to CHOOSE the family that "held"): ${split.NIFTY.cut} → ${split.NIFTY.last}. SENSEX: ${split.SENSEX.first} / ${split.SENSEX.cut} / ${split.SENSEX.last}.`,
  `- 2024-10-14 → 2024-10-31 was never seen by the grid ("NOT IN GRID").`, "");
W("## 2. Two-year replay by period — standard cost model B (corrected table)", "", HDR,
  row("ALL", all), row("NIFTY", all.filter((x) => x.ix === "NIFTY")), row("SENSEX", all.filter((x) => x.ix === "SENSEX")));
for (const p of ["NOT IN GRID (Oct 2024)", "SELECTION first ⅔", "SELECTION last ⅓"]) W(row(p, all.filter((x) => x.period === p)));
W("", "## 3. Half-years — cost model B", "", HDR); for (const b of [...new Set(all.map((x) => x.block))].sort()) W(row(b, all.filter((x) => x.block === b)));
W("", "## 4. C4 alone vs C4 + C2 direction (same C4 signals; cost model B)", "",
  "C2 state = direction of the most recent C2 entry earlier the same day on the same index. A C4 signal has NO C2 state when no C2 entry had happened yet that day — the filter cannot classify it, so it is reported on its own.", "", HDR,
  row("C4 alone", all), row("C4, C2 DOWN (agrees)", all.filter((x) => x.c2dir === -1)), row("C4, C2 UP", all.filter((x) => x.c2dir === 1)), row("C4, no C2 state yet", all.filter((x) => x.c2dir == null)));
W("", "### The C4 signals with no C2 state", "", "| Index | Date | Entry | Owner level | Result | Net ₹ (B) | Why no C2 state |", "|---|---|---|---|---|---|---|");
for (const x of all.filter((x) => x.c2dir == null)) W(`| ${x.ix} | ${x.day} | ${hm(x.t)} | ${R0(x.lvl)} | ${x.res} | ${R0(x.netB ?? NaN)} | ${x.c2before} |`);
W("", "## 5. Cost models (identical for every trade within a model)", "",
  "- Model A (first version of this audit; the premium path as fakeMoveGrid / the paper test record it): premium out = premium in × (1 + p0 %), p0 = the ATM PE 1-min close at the index exit minute vs the entry minute (looked up up to 4 minutes back). Net = (out − in − slip(in) − slip(out)) × lot − ₹40; slip = max(₹0.5, 0.25 %). Conservative = net − 0.5 % × (in + out) × lot. NO statutory charges, NO execution delay.",
  "- Model B (corrected, = final1560/strategy.optionPnl, the standard used for LAX): premium = the 1-min close of the minute ending at the fill time, at most 2 minutes old (else the trade is counted as missing). Net = (out − in − slip(in) − slip(out) − statutory) × lot − ₹40, statutory = 0.1 % of sell value + 0.04 % of turnover. Conservative = +0.5 % slippage per side AND a 1-minute delay on entry and exit.", "", HDR,
  row("ALL — model A", all, "A"), row("ALL — model B", all, "B"));
W("", "## 6. The 30 most recent historical signals (REPLAY — not live paper records; cost model B)", "", "| # | Index | Date | Period | Entry | Owner level | Entry idx | Invalidation | Target | Result | Exit | MFE / MAE pts | PE strike | Prem in → out | Net ₹ | C2 state |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
all.slice(-30).forEach((x, i) => W(`| ${i + 1} | ${x.ix} | ${x.day} | ${x.period.replace("SELECTION ", "")} | ${hm(x.t)} | ${R0(x.lvl)} | ${x.px.toFixed(1)} | ${x.stopIdx.toFixed(1)} | ${x.tgtIdx.toFixed(1)} | ${x.res} | ${hm(x.tOut + 60)} | ${x.mfe.toFixed(1)} / ${x.mae.toFixed(1)} | ${x.strike} | ${x.premIn.toFixed(2)} → ${x.premOut.toFixed(2)} | ${R0(x.netB ?? NaN)} | ${x.c2dir == null ? "none" : x.c2dir < 0 ? "DOWN" : "UP"} |`));
W("", "MFE = most favourable index move (points down, the PE's direction) and MAE = most adverse move (points up) from entry to exit, on 1-min closes; a negative MAE means the index never traded above the entry.");
console.log(out.join("\n"));
process.exit(0);
