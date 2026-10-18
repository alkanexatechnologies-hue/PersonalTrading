// Friday ProTrader weekly re-check: re-run the 2-year premium backtest of the LIVE logic (plan trigger + retest entry,
// expiry-day plan trades not given, range-day filter) on everything downloaded, compare the last 20 sessions with the
// long run, and flag drift. Proposes, never changes logic. Usage: npx tsx weekly.ts <out.json>
import fs from "fs";
import { run } from "./premiumBacktest2";
import { latestRawDay } from "./dataRange";

const LIVE = { name: "LIVE", range: true, cutoff: 885, skipExpiry: true, entry: "retest" as const, wideStop: false };
const t = run([LIVE]).trades.filter((x: any) => x.net != null);
const S = (r: any[]) => ({ n: r.length, win: r.length ? Math.round((r.filter((x) => x.net > 0).length / r.length) * 100) : 0, avg: r.length ? Math.round((r.reduce((a, x) => a + x.pct, 0) / r.length) * 10) / 10 : 0 });
const out: any = { at: new Date().toISOString(), dataTo: latestRawDay(), idx: {} };
for (const idx of ["NIFTY", "SENSEX"]) {
  const r = t.filter((x: any) => x.idx === idx), days = [...new Set(r.map((x: any) => x.day))].sort(), last20 = new Set(days.slice(-20)), prev20 = new Set(days.slice(-40, -20));
  const all = S(r), l = S(r.filter((x: any) => last20.has(x.day))), p = S(r.filter((x: any) => prev20.has(x.day)));
  const drift = l.n >= 5 && (l.avg < all.avg - 5 || l.win < all.win - 10) ? "WORSE than the long run" : l.n >= 5 && (l.avg > all.avg + 5) ? "BETTER than the long run" : "in line with the long run";
  out.idx[idx] = { all, last20: l, prev20: p, drift, lastTrade: days[days.length - 1] };
}
const f = (s: any) => `${s.n} trades · win ${s.win}% · avg ${s.avg >= 0 ? "+" : ""}${s.avg}%/trade`;
out.html = [`🎖 <b>PROTRADER WEEKLY RE-CHECK</b> · live logic on real Dhan premiums, after costs`,
  ...Object.entries(out.idx).flatMap(([k, v]: any) => [`${k === "SENSEX" ? "🟣" : "🔵"} <b>${k}</b> (data to ${out.dataTo} · last trade ${v.lastTrade})`, `  2-year: ${f(v.all)}`, `  last 20 sessions: ${f(v.last20)} · before that: ${f(v.prev20)}`, `  → <b>${v.drift}</b>`]),
  `<i>Re-check only — any logic change still needs ProTrader's full test (development + validation, both indices)</i>`].join("\n");
fs.writeFileSync(process.argv[2] || "weekly.json", JSON.stringify(out, null, 1));
console.log(out.html);
process.exit(0);
