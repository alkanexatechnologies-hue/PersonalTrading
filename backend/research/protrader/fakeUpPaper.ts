// ProTrader PAPER TEST of the one fake-move rule that held in the grid search (RESULTS_FAKE_MOVE.md §5), from 2026-10-26.
// Rule (5-min, NIFTY + SENSEX): FAKE-UP at an OWNER S/R level (15-min turn clusters / flip zones of the previous 5
// sessions) + call writing (ATM CE OI up, CE premium down over the 4-bar window) + the level touched earlier today
// (≥ 30 min before). Entry at the confirming 5-min close, stop = the 4-bar high (≥ 0.25 ATR), target 1 : 1, 60 min.
// Runs after the 15:50 data refresh on the day's real Dhan 1-min data through the SAME code as the backtest
// (fakeMoveGrid.run), so paper and backtest cannot drift apart. PAPER ONLY — never a co-pilot trade.
// Judge after ~30 signals: backtest validation was 61–81 % right vs a 54–55 % baseline.
// Usage: npx tsx fakeUpPaper.ts <out.json>   (env PAPER_FROM=YYYY-MM-DD to replay an earlier start for a check)
import fs from "fs";
import { assemble, DayData } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { latestRawDay } from "./dataRange";
import { run } from "./fakeMoveGrid";

const START = process.env.PAPER_FROM || "2026-10-26";
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const to = latestRawDay(), warm = new Date(new Date(START + "T00:00:00Z").getTime() - 45 * 86400e3).toISOString().slice(0, 10);
const sig: any[] = [];
for (const [ix, days, step] of [["NIFTY", assemble(warm, to).days, 50], ["SENSEX", assembleIndex("SENSEX", warm, to), 100]] as const) {
  for (const e of run(days as DayData[], 5, step).ev) {
    if (e.day < START || e.src !== "OWNER" || e.dir !== -1 || !e.r0 || !e.f.write || !e.f.retest) continue;
    const d = Math.max(e.stop - e.px, 0.25 * e.atr);
    sig.push({ index: ix, day: e.day, time: hm(e.t), level: Math.round(e.lvl), entry: Math.round(e.px * 100) / 100, stop: Math.round((e.px + d) * 100) / 100,
      target: Math.round((e.px - d) * 100) / 100, result: e.r0.win ? "TARGET" : e.r0.loss ? "STOP" : "TIME", r: Math.round(e.r0.r * 100) / 100,
      strike: `${e.atm} PE`, premIn: e.premIn, premPct: e.p0 == null ? null : Math.round(e.p0 * 10) / 10 });
  }
}
sig.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
const score = (r: any[]) => { const w = r.filter((x) => x.result === "TARGET").length, l = r.filter((x) => x.result === "STOP").length, pp = r.filter((x) => x.premPct != null);
  return { n: r.length, target: w, stop: l, time: r.length - w - l, accuracy: w + l ? Math.round((w / (w + l)) * 100) : null,
    avgR: r.length ? Math.round((r.reduce((a, x) => a + x.r, 0) / r.length) * 100) / 100 : null, avgPremPct: pp.length ? Math.round((pp.reduce((a, x) => a + x.premPct, 0) / pp.length) * 10) / 10 : null }; };
const board = { all: score(sig), NIFTY: score(sig.filter((x) => x.index === "NIFTY")), SENSEX: score(sig.filter((x) => x.index === "SENSEX")) };
const today = sig.filter((x) => x.day === to), icon: Record<string, string> = { TARGET: "✅", STOP: "❌", TIME: "⏱" };
const f = (s: any) => s.n ? `${s.n} signals · ${s.target} target / ${s.stop} stop / ${s.time} time · accuracy ${s.accuracy ?? "—"}% · avg ${s.avgR! >= 0 ? "+" : ""}${s.avgR}R · ATM PE ${s.avgPremPct == null ? "—" : (s.avgPremPct >= 0 ? "+" : "") + s.avgPremPct + "%"}` : "no signals yet";
const html = [`📝 <b>PAPER TEST · FAKE-UP at owner S/R + call writing</b> · ${to}`,
  `<i>Paper only, not a trade. Judged after ~30 signals (backtest: right 61–81% vs 54–55% baseline).</i>`,
  today.length ? `<b>Today</b>` : `Today: no signal`,
  ...today.map((x) => `${x.index === "SENSEX" ? "🟣" : "🔵"} ${x.index} ${x.time} · failed breakout at ${x.level} · BUY ${x.strike} @ ${x.premIn ?? "—"} · index entry ${x.entry} SL ${x.stop} T ${x.target} → ${icon[x.result]} ${x.result} (${x.r >= 0 ? "+" : ""}${x.r}R, premium ${x.premPct == null ? "—" : (x.premPct >= 0 ? "+" : "") + x.premPct + "%"})`),
  `<b>Scoreboard since ${START}</b>`, `  🔵 NIFTY: ${f(board.NIFTY)}`, `  🟣 SENSEX: ${f(board.SENSEX)}`, `  Total: ${f(board.all)}${board.all.n >= 30 ? " · <b>30+ signals: ready for ProTrader's verdict</b>" : ` · ${30 - board.all.n} more to the verdict`}`].join("\n");
const out = { rule: "5m FAKE-UP · OWNER S/R · call writing · retest · 1:1 · 60 min", from: START, dataTo: to, at: new Date().toISOString(), board, signals: sig, html };
fs.writeFileSync(process.argv[2] || "paper-fakeup.json", JSON.stringify(out, null, 1));
console.log(html);
process.exit(0);
