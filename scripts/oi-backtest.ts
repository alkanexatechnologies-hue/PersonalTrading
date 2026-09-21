import fs from "fs";
import path from "path";
import { DhanProvider } from "../backend/data/dhanProvider";
import { backtestOiCommandLog, LogReplayResult, OiTradeSim } from "../backend/backtest/oiCommand";

// ---- OI Command Back-Test — CLI runner -------------------------------------
// This is a manual reporting tool, NOT an automated test: it prints formatted
// win-rate/outcome stats for a human to read, with no assertions and no
// pass/fail exit code, so it won't catch a signal-logic regression unless
// someone runs it by hand and notices the numbers look wrong. For automated
// regression coverage of the signal/backtest logic, see
// backend/backtest/engine.test.ts (run via `npm test`).
// Usage:
//   npm run backtest:oi                     -> LIVE grid back-test for NIFTY today
//   npm run backtest:oi -- live ^NSEBANK    -> live grid for another F&O index
//   npm run backtest:oi -- log ^NSEI        -> replay TODAY's logged signals (standalone)
//   npm run backtest:oi -- log ^NSEI 2026-09-04
//
//  - "live" hits the RUNNING server (start.ps1) at
//    http://localhost:PORT/api/oi-command/backtest — it uses the exact live OI
//    grid, then simulates the recommended option trade on real Dhan candles.
//  - "log" runs standalone (only needs Dhan config) and replays the signals the
//    server logged into data/oi-command-log.json.

const args = process.argv.slice(2);
const mode = (args[0] === "log" || args[0] === "live" ? args[0] : "live") as "live" | "log";
const symbol = (args.find((a, i) => i > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(a)) as string) || "^NSEI";
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)); // explicit date, if any
const date = dateArg || lastTradingDateIST();
const PORT = process.env.PORT || "5173";

// Last likely TRADING day in IST (before 09:15 IST or on weekends, step back).
function lastTradingDateIST(): string {
  const DAY = 24 * 60 * 60 * 1000;
  let ms = Date.now() + 19800000;
  const d0 = new Date(ms);
  if (d0.getUTCHours() * 60 + d0.getUTCMinutes() < 9 * 60 + 15) ms -= DAY;
  for (let i = 0; i < 7; i++) {
    const d = new Date(ms);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
    ms -= DAY;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function dhanConfigured(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data/dhan-config.json"), "utf-8"));
    return !!cfg?.accessToken;
  } catch { return false; }
}

const money = (v: number | null | undefined) => (v == null ? "—" : "₹" + v);
const pct = (v: number | null | undefined) => (v == null ? "—" : (v >= 0 ? "+" : "") + v + "%");

function printSim(sim: OiTradeSim | null, indent = "  ") {
  if (!sim) { console.log(indent + "(no simulation)"); return; }
  if (!sim.available) { console.log(indent + "unavailable: " + (sim.message || "")); return; }
  console.log(`${indent}${sim.direction}  ${sim.strike} ${sim.optionType}  Exp ${sim.expiry}  (${sim.tradingSymbol})`);
  console.log(`${indent}Entry ${money(sim.entryPremium)} @ ${sim.entryTime} (spot ${sim.entrySpot ?? "—"})  Target ${money(sim.target)}  Stop ${money(sim.stop)}`);
  console.log(`${indent}Outcome: ${sim.outcome}${sim.outcomeTime ? " @ " + sim.outcomeTime : ""}  ->  P&L ${pct(sim.pnlPct)}`);
  console.log(`${indent}Best ${money(sim.bestPremium)} (${pct(sim.bestPct)}) @ ${sim.bestTime}   Worst ${money(sim.worstPremium)} (${pct(sim.worstPct)}) @ ${sim.worstTime}   Close ${money(sim.eodPremium)} (${pct(sim.eodPct)})`);
  const dir = sim.dir.map((d) => `${d.horizon}m:${d.status === "correct" ? "✓" : d.status === "wrong" ? "✗" : d.status}${d.favMove == null ? "" : "(" + (d.favMove >= 0 ? "+" : "") + d.favMove + "p)"}`).join("  ");
  console.log(`${indent}Direction: ${dir}`);
}

function printLog(g: LogReplayResult) {
  if (!g.available || !g.count) { console.log("\nLogged signals: " + (g.message || "none for " + g.date)); return; }
  console.log(`\nLogged signals for ${g.date}${g.symbol ? " · " + g.symbol : ""} (${g.count})`);
  for (const hz of ["5", "15", "60"] as const) {
    const b = (g.direction as any)[hz];
    console.log(`  Direction ${hz}m: win ${b.winPct}%  (${b.correct}✓ / ${b.wrong}✗ / ${b.flat} flat)`);
  }
  const o = g.option;
  console.log(`  Option trades: ${o.trades}  target ${o.targets}  stop ${o.stops}  open ${o.open}  win ${o.winPct}%  avg ${pct(o.avgPnlPct)}  total ${pct(o.sumPnlPct)}`);
  console.log("  " + "-".repeat(70));
  for (const s of g.signals) {
    const sm = s.sim;
    const res = sm && sm.available ? `${sm.outcome} ${pct(sm.pnlPct)}` : "no-data";
    console.log(`  ${s.time}  ${s.direction === "UP" ? "▲" : "▼"}${s.optionType}  ${s.strike ?? "—"}  conf ${s.confidence}%  ->  ${res}`);
  }
}

async function runLive() {
  const url = `http://localhost:${PORT}/api/oi-command/backtest?symbol=${encodeURIComponent(symbol)}${dateArg ? "&date=" + dateArg : ""}`;
  console.log(`\nOI Command Back-test (LIVE grid) · ${symbol} · ${date}`);
  console.log(`GET ${url}`);
  let d: any;
  try {
    const res = await fetch(url);
    d = await res.json();
  } catch (e: any) {
    console.error(`\nCould not reach the server on port ${PORT}. Start it first (./start.ps1), then re-run.`);
    console.error(`Or run standalone log replay:  npm run backtest:oi -- log ${symbol} ${date}`);
    console.error(`(${e?.message || e})`);
    process.exit(1);
  }
  if (!d || !d.available) { console.log("\nBack-test unavailable: " + ((d && (d.message || d.error)) || "unknown")); return; }
  console.log(`\n=== ${d.name} · ${d.date} · entry ${d.entry} ===`);
  console.log("\n[Live grid setup — back-tested on real option candles]");
  if (d.live && d.live.available) printSim(d.live.simulation);
  else console.log("  " + ((d.live && d.live.message) || "grid setup unavailable"));
  printLog(d.log);
  console.log("\nNote: historical intraday OI can't be reconstructed — DIRECTION is the live grid read applied from the entry time; the option premium path & target/stop are measured on real Dhan candles. Education/simulation only.");
}

async function runLog() {
  if (!dhanConfigured()) { console.error("Dhan not configured. Save an access token in data/dhan-config.json."); process.exit(1); }
  const provider = new DhanProvider();
  console.log(`\nOI Command Back-test (LOG replay, standalone) · ${symbol} · ${date}`);
  const g = await backtestOiCommandLog(provider, { date, symbol });
  printLog(g);
  console.log("\nEducation/simulation only.");
}

(async () => {
  try {
    if (mode === "log") await runLog();
    else await runLive();
  } catch (e: any) {
    console.error("Back-test failed:", e?.message || e);
    process.exit(1);
  }
})();
