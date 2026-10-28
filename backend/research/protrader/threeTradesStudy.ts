// ProTrader gate — "the experienced trader's best day" as a rule (owner, 2026-10-28: "three trades … I need that strategy").
// The 28 Oct lesson had three trades: (1) the approved plan entry (15-min close + retest), (2) a 5-min sweep below / above a
// ladder level that closes back inside, (3) a 5-min close beyond the day's range so far (10:30–14:30). All with a fixed 1:2
// target, one trade at a time across NIFTY + SENSEX, 14:45 cut-off, 15:12 exit. Same engine and real Dhan data as #2/#3.
// Run: npx tsx backend/research/protrader/threeTradesStudy.ts
import * as fs from "fs";
import * as path from "path";
import { run, Cfg } from "./premiumBacktest3";

const BASE: Cfg = { name: "ONE_TRADE_1to2", range: true, cutoff: 885, skipExpiry: true, entry: "retest", wideStop: false, fixedR: 2 };
const CFGS: Cfg[] = [BASE, { ...BASE, name: "PLAN+SWEEP", extra: ["sweep"] }, { ...BASE, name: "PLAN+BREAK", extra: ["break"] }, { ...BASE, name: "THREE_TRADES", extra: ["sweep", "break"] },
  { ...BASE, name: "THREE_TRADES_no_range_skip", range: false, extra: ["sweep", "break"] }];
const { trades } = run(CFGS);
const done = trades.filter((t: any) => t.net != null);
const days = [...new Set(done.map((t: any) => t.day))].sort(), cut = days[Math.floor(days.length / 2)];
function oneAtATime(rows: any[]) {
  const out: any[] = [];
  for (const d of [...new Set(rows.map((t) => t.day))]) { let free = 0; for (const t of rows.filter((x) => x.day === d).sort((a, b) => a.time - b.time || (a.idx < b.idx ? -1 : 1))) { if (t.time < free) continue; out.push(t); free = t.end + 1; } }
  return out;
}
function stats(rows: any[]) {
  const n = rows.length, w = rows.filter((t) => t.net > 0).length, gw = rows.filter((t) => t.net > 0).reduce((a, t) => a + t.rs, 0), gl = -rows.filter((t) => t.net <= 0).reduce((a, t) => a + t.rs, 0);
  const tot = rows.reduce((a, t) => a + t.rs, 0); let peak = 0, cum = 0, dd = 0; for (const t of rows.slice().sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time))) { cum += t.rs; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, win: n ? Math.round((w / n) * 1000) / 10 : 0, per: n ? Math.round(tot / n) : 0, tot, pf: gl ? Math.round((gw / gl) * 100) / 100 : null, dd };
}
const L = (lbl: string, s: ReturnType<typeof stats>) => `| ${lbl} | ${s.n} | ${s.win}% | ₹${s.per} | ₹${s.tot.toLocaleString("en-IN")} | ₹${(s.tot * 3).toLocaleString("en-IN")} | ${s.pf ?? "—"} | ₹${(s.dd * 3).toLocaleString("en-IN")} |`;
const md = [`# ProTrader gate — "three trades" strategy (plan + sweep-reclaim + day-range breakout), 1:2, one at a time · ${new Date().toISOString().slice(0, 10)}`, "",
  `Real Dhan 1-min data ${days[0]} → ${days[days.length - 1]} (${days.length} sessions with trades). DEV before ${cut}, VAL from ${cut}. Net of costs, ₹ per lot; the 3-lot column = × 3 (NIFTY 3 × 75, SENSEX 3 × 20).`, "",
  "| Rule set (one at a time, NIFTY + SENSEX) | Trades | Win % | ₹ / trade (1 lot) | ₹ total (1 lot) | ₹ total (3 lots) | PF | Worst drawdown (3 lots) |", "|---|---|---|---|---|---|---|---|"];
for (const c of CFGS) {
  const one = oneAtATime(done.filter((t: any) => t.cfg === c.name));
  md.push(L(`${c.name} · all`, stats(one)), L(`${c.name} · DEV`, stats(one.filter((t: any) => t.day < cut))), L(`${c.name} · VAL`, stats(one.filter((t: any) => t.day >= cut))));
}
md.push("", "## THREE_TRADES by entry type (one at a time)", "", "| Entry | Trades | Win % | ₹ / trade | ₹ total | ₹ total (3 lots) | PF | Worst DD (3 lots) |", "|---|---|---|---|---|---|---|---|");
const three = oneAtATime(done.filter((t: any) => t.cfg === "THREE_TRADES"));
for (const k of ["plan", "sweep", "break"]) for (const [lbl, f] of [["DEV", (t: any) => t.day < cut], ["VAL", (t: any) => t.day >= cut]] as const) md.push(L(`${k} · ${lbl}`, stats(three.filter((t: any) => t.kind === k && f(t)))));
md.push("", "## Last 10 sessions (THREE_TRADES, one at a time, 3 lots)", "", "| Day | Trades |", "|---|---|");
for (const d of days.slice(-10)) md.push(`| ${d} | ${three.filter((t) => t.day === d).map((t) => `${t.idx === "NIFTY" ? "N" : "S"} ${t.kind} ${t.side > 0 ? "CE" : "PE"} ${String(Math.floor(t.time / 60)).padStart(2, "0")}:${String(t.time % 60).padStart(2, "0")} ${t.res} ₹${(t.rs * 3).toLocaleString("en-IN")}`).join("; ") || "—"} |`);
const out = path.join(__dirname, "RESULTS_THREE_TRADES.md"); fs.writeFileSync(out, md.join("\n") + "\n"); console.log(md.join("\n"));
