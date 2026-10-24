// ProTrader PAPER TEST of the one fake-move rule that held in the grid search (RESULTS_FAKE_MOVE.md §5), from 2026-10-26.
// Rule (5-min, NIFTY + SENSEX): FAKE-UP at an OWNER S/R level (15-min turn clusters / flip zones of the previous 5
// sessions) + call writing (ATM CE OI up, CE premium down over the 4-bar window) + the level touched earlier today
// (≥ 30 min before). Entry at the confirming 5-min close, stop = the 4-bar high (≥ 0.25 ATR), target 1 : 1, 60 min.
// Runs after the 15:50 data refresh on the day's real Dhan 1-min data through the SAME code as the backtest
// (fakeMoveGrid.run), so paper and backtest cannot drift apart. PAPER ONLY — never a co-pilot trade.
// Pure parts (rule, signal, scoreboard, note) live in fakeUpPaperCore.ts.
// Usage: npx tsx fakeUpPaper.ts <out.json>   (env PAPER_FROM=YYYY-MM-DD to replay an earlier start for a check)
import fs from "fs";
import { assemble, DayData } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { latestRawDay } from "./dataRange";
import { run } from "./fakeMoveGrid";
import { PAPER_START, isPaperSignal, toSignal, scoreBoard, paperHtml, PaperSignal } from "./fakeUpPaperCore";

const START = process.env.PAPER_FROM || PAPER_START;
const to = latestRawDay(), warm = new Date(new Date(START + "T00:00:00Z").getTime() - 45 * 86400e3).toISOString().slice(0, 10);
const sig: PaperSignal[] = [];
for (const [ix, days, step] of [["NIFTY", assemble(warm, to).days, 50], ["SENSEX", assembleIndex("SENSEX", warm, to), 100]] as const)
  for (const e of run(days as DayData[], 5, step).ev) if (isPaperSignal(e, START)) sig.push(toSignal(ix, e));
sig.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
const board = { all: scoreBoard(sig), NIFTY: scoreBoard(sig.filter((x) => x.index === "NIFTY")), SENSEX: scoreBoard(sig.filter((x) => x.index === "SENSEX")) };
const html = paperHtml(to, sig, START);
fs.writeFileSync(process.argv[2] || "paper-fakeup.json", JSON.stringify({ rule: "5m FAKE-UP · OWNER S/R · call writing · retest · 1:1 · 60 min", from: START, dataTo: to, at: new Date().toISOString(), board, signals: sig, html }, null, 1));
console.log(html);
process.exit(0);
