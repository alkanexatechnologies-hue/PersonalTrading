// ProTrader gate — "One Trade" proposal (owner, 2026-10-28): one trade at a time across NIFTY + SENSEX, no new trade
// until the open one has closed, and the target fixed at 1:2 (entry ± 2 × the index risk to the plan's stop).
// Same engine and real Dhan data as premiumBacktest #2/#3. LIVE = the approved co-pilot (retest entry, T1 half + T2,
// expiry-day skip, range-day skip, 14:45 cut-off). Run: npx tsx backend/research/protrader/oneTradeStudy.ts
import * as fs from "fs";
import * as path from "path";
import { run, Cfg } from "./premiumBacktest3";

const LIVE: Cfg = { name: "LIVE", range: true, cutoff: 885, skipExpiry: true, entry: "retest", wideStop: false };
const R2: Cfg = { ...LIVE, name: "FIXED_1to2", fixedR: 2 };
const { trades } = run([LIVE, R2]);
const done = trades.filter((t: any) => t.net != null);
const days = [...new Set(done.map((t: any) => t.day))].sort(), cut = days[Math.floor(days.length / 2)];

/** One at a time across both indices: in time order, a trade is taken only after the previous one closed. */
function oneAtATime(rows: any[]) {
  const out: any[] = [];
  for (const d of [...new Set(rows.map((t) => t.day))]) {
    let free = 0;
    for (const t of rows.filter((x) => x.day === d).sort((a, b) => a.time - b.time || (a.idx < b.idx ? -1 : 1))) { if (t.time < free) continue; out.push(t); free = t.end + 1; }
  }
  return out;
}
function stats(rows: any[]) {
  const n = rows.length, w = rows.filter((t) => t.net > 0).length, gw = rows.filter((t) => t.net > 0).reduce((a, t) => a + t.rs, 0), gl = -rows.filter((t) => t.net <= 0).reduce((a, t) => a + t.rs, 0);
  const res: Record<string, number> = {}; for (const t of rows) res[t.res] = (res[t.res] || 0) + 1;
  return { n, win: n ? Math.round((w / n) * 1000) / 10 : 0, rsPer: n ? Math.round(rows.reduce((a, t) => a + t.rs, 0) / n) : 0, total: rows.reduce((a, t) => a + t.rs, 0), pf: gl ? Math.round((gw / gl) * 100) / 100 : null, res };
}
const line = (lbl: string, s: ReturnType<typeof stats>) => `| ${lbl} | ${s.n} | ${s.win}% | ₹${s.rsPer} | ₹${s.total.toLocaleString("en-IN")} | ${s.pf ?? "—"} | ${Object.entries(s.res).map(([k, v]) => `${k} ${v}`).join(", ")} |`;
const md: string[] = [`# ProTrader gate — "One Trade" (1:2 target, one at a time) · generated ${new Date().toISOString().slice(0, 10)}`, "",
  `Data: real Dhan 1-minute index + ATM option premiums, ${days[0]} → ${days[days.length - 1]} (${days.length} sessions with trades). DEV = before ${cut}, VAL = from ${cut}. Net of costs (0.25 % per side + ₹40 per trade), per lot (NIFTY 75, SENSEX 20).`, "",
  "| Rule set | Trades | Win % | ₹ / trade | ₹ total | PF | Exits |", "|---|---|---|---|---|---|---|"];
for (const cfg of ["LIVE", "FIXED_1to2"]) {
  const rows = done.filter((t: any) => t.cfg === cfg);
  for (const ix of ["NIFTY", "SENSEX"]) { const r = rows.filter((t: any) => t.idx === ix); md.push(line(`${cfg} · ${ix} · all`, stats(r)), line(`${cfg} · ${ix} · DEV`, stats(r.filter((t: any) => t.day < cut))), line(`${cfg} · ${ix} · VAL`, stats(r.filter((t: any) => t.day >= cut)))); }
  const one = oneAtATime(rows);
  md.push(line(`${cfg} · ONE AT A TIME (both) · all`, stats(one)), line(`${cfg} · ONE AT A TIME · DEV`, stats(one.filter((t: any) => t.day < cut))), line(`${cfg} · ONE AT A TIME · VAL`, stats(one.filter((t: any) => t.day >= cut))));
}
md.push("", "## Last 10 sessions, one at a time", "", "| Day | LIVE | FIXED 1:2 |", "|---|---|---|");
const fmt = (rows: any[]) => rows.map((t) => `${t.idx === "NIFTY" ? "N" : "S"} ${t.side > 0 ? "CE" : "PE"} ${String(Math.floor(t.time / 60)).padStart(2, "0")}:${String(t.time % 60).padStart(2, "0")} ${t.res} ₹${t.rs}`).join("; ") || "—";
const L1 = oneAtATime(done.filter((t: any) => t.cfg === "LIVE")), L2 = oneAtATime(done.filter((t: any) => t.cfg === "FIXED_1to2"));
for (const d of days.slice(-10)) md.push(`| ${d} | ${fmt(L1.filter((t) => t.day === d))} | ${fmt(L2.filter((t) => t.day === d))} |`);
const out = path.join(__dirname, "RESULTS_ONE_TRADE.md"); fs.writeFileSync(out, md.join("\n") + "\n"); console.log(md.join("\n"));
