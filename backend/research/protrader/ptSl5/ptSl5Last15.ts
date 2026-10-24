// PT rule with the owner's exits (2026-10-25): entry when the ATM premium EMA 9 crosses its EMA 21 (index already past its
// EMA 21), SL = entry premium − 5, target = entry premium + 35 / 40 / 45, until 15:25. Premium 1-min high/low decide the exit
// (target and SL in the same minute = ambiguous). Last 15 sessions. Research only. Usage: npx tsx ptSl5Last15.ts
import { assemble } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { run } from "../emaCrossStudy";
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16), mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const COST = (p: number) => Math.max(0.5, 0.0025 * p), LOT = { NIFTY: 75, SENSEX: 20 } as const, STEP = { NIFTY: 50, SENSEX: 100 } as const;
const TGTS = [35, 40, 45], SL = 5;
const rows: any[] = [];
for (const [ix, days] of [["NIFTY", assemble("2026-08-01", "2026-10-23").days], ["SENSEX", assembleIndex("SENSEX", "2026-08-01", "2026-10-23")]] as const) {
  const ds = (days as any[]).filter((d) => d.spot.size >= 300), last15 = ds.slice(-15).map((d) => d.day);
  for (const x of run(ix as any, days as any).sigs.filter((s: any) => s.pt && last15.includes(s.day))) {
    const D = ds.find((d) => d.day === x.day), spot = [...D.spot.entries()].sort((a: any, b: any) => a[0] - b[0]) as [number, number][];
    const s0 = spot.filter(([t]) => t < x.t).pop()![1], atm = Math.round(s0 / STEP[ix]) * STEP[ix], key = `${atm}${x.dir > 0 ? "CE" : "PE"}`;
    const leg = ((D.legs.get(key) || []) as any[]).sort((a, b) => a.t - b.t), inBar = leg.filter((m) => m.t < x.t).pop();
    if (!inBar) { rows.push({ ix, day: x.day, t: hm(x.t - 300), key, note: "no premium" }); continue; }
    const e = inBar.c, path = leg.filter((m) => m.t >= x.t && mn(m.t) <= 925);
    const res: any = {};
    for (const T of TGTS) {
      let r = "MISS", at = "", exitP = path.length ? path[path.length - 1].c : e, exitPess = exitP, mfe = 0, mae = 0;
      for (const m of path) { mfe = Math.max(mfe, m.h - e); mae = Math.max(mae, e - m.l);
        const hitS = m.l <= e - SL, hitT = m.h >= e + T;
        if (hitS && hitT) { r = "AMBIG"; at = hm(m.t + 60); exitP = e - SL; exitPess = Math.min(e - SL, m.c); break; }
        if (hitS) { r = "SL"; at = hm(m.t + 60); exitP = e - SL; exitPess = Math.min(e - SL, m.c); break; }
        if (hitT) { r = "TARGET"; at = hm(m.t + 60); exitP = e + T; exitPess = exitP; break; } }
      if (r === "MISS") { at = path.length ? hm(path[path.length - 1].t + 60) : ""; exitPess = exitP; }
      const net = exitP - e - COST(e) - COST(exitP) - 40 / LOT[ix], netPess = exitPess - e - COST(e) - COST(exitPess) - 40 / LOT[ix];
      res[T] = { r, at, net, netPess, exitP, exitPess, mfe, mae };
    }
    // index-point version: SL 5 / target 35-45 index points on 1-min closes (spot has closes only)
    const sp = spot.filter(([t]) => t >= x.t && mn(t) <= 925), idx: any = {};
    for (const T of TGTS) { let r = "MISS", at = ""; for (const [t, p] of sp) { if (x.dir * (p - s0) <= -SL) { r = "SL"; at = hm(t + 60); break; } if (x.dir * (p - s0) >= T) { r = "TARGET"; at = hm(t + 60); break; } } idx[T] = { r, at }; }
    rows.push({ ix, day: x.day, t: hm(x.t - 300), entryT: hm(x.t), key, e, res, idx, spot: s0, dir: x.dir });
  }
}
const mins = (a: string, b: string) => { const [h1, m1] = a.split(":").map(Number), [h2, m2] = b.split(":").map(Number); return h2 * 60 + m2 - (h1 * 60 + m1); };
const pc = (a: number, b: number) => (b ? Math.round((a / b) * 100) + "%" : "—");
const out: string[] = [];
out.push("# PT entry + premium SL −5 / target +35·40·45 — last 15 sessions (research)", "",
  "Entry = close of the 5-min candle where the ATM premium EMA 9 crossed its EMA 21 (index already past its EMA 21); entry price = the premium's 1-min close at that candle's close. SL = entry − ₹5, target = entry + ₹35 / 40 / 45, checked on every 1-min premium high / low until 15:25. MISS = neither reached by 15:25. P&L after costs (₹0.5 or 0.25 % slippage per side + ₹40 per lot); the pessimistic column exits a stop at that minute's close when it is below −5.", "");
for (const ix of ["NIFTY", "SENSEX"] as const) {
  const R = rows.filter((r) => r.ix === ix && r.res), n = R.length;
  out.push(`## ${ix} — ${n} trades`, "", "| Target | Target hit | SL hit | Missed | Ambiguous | Avg minutes to target | Avg minutes to SL | Net P&L, 1 lot each (stop at −5 / at minute close) |", "|---|---|---|---|---|---|---|---|");
  for (const T of TGTS) { const g = (k: string) => R.filter((r) => r.res[T].r === k), tg = g("TARGET"), sl = g("SL");
    const avg = (xs: any[]) => (xs.length ? Math.round(xs.reduce((a, r) => a + mins(r.entryT, r.res[T].at), 0) / xs.length) : 0);
    const sum = (k: string) => Math.round(R.reduce((a, r) => a + r.res[T][k], 0) * LOT[ix]);
    out.push(`| +${T} | ${tg.length} (${pc(tg.length, n)}) | ${sl.length} (${pc(sl.length, n)}) | ${g("MISS").length} (${pc(g("MISS").length, n)}) | ${g("AMBIG").length} | ${avg(tg)} | ${avg(sl)} | ₹${sum("net")} / ₹${sum("netPess")} |`); }
  out.push("", `### ${ix} trades (target +40)`, "", "| # | Date | Signal candle | Entry time | Option | Entry ₹ | SL ₹ | Target ₹ | Result | Exit time | Exit ₹ | Minutes | Net ₹/unit (stop at −5 / minute close) | +35 | +45 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  R.forEach((r, k) => { const x = r.res[40];
    out.push(`| ${k + 1} | ${r.day.slice(8)} Oct | ${r.t} | ${r.entryT} | ${r.key.replace(/(CE|PE)$/, " $1")} | ${r.e.toFixed(2)} | ${(r.e - SL).toFixed(2)} | ${(r.e + 40).toFixed(2)} | ${x.r === "TARGET" ? "✅ TARGET" : x.r === "SL" ? "❌ SL" : x.r} | ${x.at} | ${x.exitP.toFixed(2)}${x.exitPess !== x.exitP ? ` (${x.exitPess.toFixed(2)})` : ""} | ${mins(r.entryT, x.at)} | ${x.net.toFixed(2)} / ${x.netPess.toFixed(2)} | ${r.res[35].r === "TARGET" ? "✅" : "❌"} ${r.res[35].at} | ${r.res[45].r === "TARGET" ? "✅" : "❌"} ${r.res[45].at} |`); });
  out.push("");
}
console.log(out.join("\n"));
process.exit(0);

