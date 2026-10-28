#!/usr/bin/env node
// Copy the application's own records into the local SQL Server (NSA_MARKET) so they can be queried next to the market data.
//
//   node scripts/sqlserver/load-app.mjs        # full reload of the app_* tables (a few seconds)
//
// app_copilot_trades   co-pilot trades (data/copilot-history.jsonl, appended each night by the app)
// app_one_trade        🎯 One Trade trades (data/one-trade-history.jsonl, appended each night by the app)
// app_learning_trades  the owner's own trade calls with their checked result (data/learning-trades.json)
// app_decisions        every arbiter decision / outcome / exit (data/decision-ledger/*.jsonl)
// app_market_diary     the end-of-day market snapshot per index (data/market-diary/<day>.json)
// app_paper_trades     paper trades (data/paper-trades.csv)
// Every table keeps the original record in a `raw` JSON column, so nothing is lost when a field is not flattened.
import fs from "fs";
import path from "path";
import { ROOT, sql, bulk, ist } from "./lib.mjs";

const D = (...p) => path.join(ROOT, "data", ...p);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const t2 = (sec) => (Number.isFinite(sec) && sec > 0 ? ist(sec) : null);
const LOT = { "^NSEI": 75, "^BSESN": 20 };

function table(name, cols, rows) {
  sql(`IF OBJECT_ID('dbo.${name}') IS NOT NULL DROP TABLE dbo.${name}; CREATE TABLE dbo.${name} (${cols.map(([c, t]) => `[${c}] ${t} NULL`).join(", ")});`);
  const n = bulk(`dbo.${name}`, rows, name);
  console.log(`${name}: ${n.toLocaleString("en-IN")} rows`);
}
/** one row per trade even if the app appended the same day twice */
const uniq = (rows, key) => { const seen = new Set(); return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; }); };

// ---- co-pilot trades
// history (appended each night) + today's trades still in the live state file
const cpNow = readJson(D("copilot-state.json"), {}), cpToday = cpNow.day ? [...(cpNow.closed || []), ...Object.values(cpNow.trades || {})].map((t) => ({ day: cpNow.day, ...t })) : [];
const cp = uniq([...cpToday.filter((t) => t.state === "CLOSED"), ...readLines(D("copilot-history.jsonl")), ...cpToday], (t) => `${t.day}|${t.index}|${t.openedAt}`);
table("app_copilot_trades", [["trade_date", "DATE"], ["index_symbol", "VARCHAR(12)"], ["index_name", "NVARCHAR(40)"], ["side", "CHAR(2)"], ["strike", "DECIMAL(10,2)"], ["opened_at", "DATETIME2(0)"],
  ["entry_spot", "DECIMAL(12,2)"], ["entry_prem", "DECIMAL(10,2)"], ["stop", "DECIMAL(12,2)"], ["t1", "DECIMAL(12,2)"], ["t2", "DECIMAL(12,2)"], ["state", "VARCHAR(10)"], ["t1_at", "DATETIME2(0)"], ["t1_prem", "DECIMAL(10,2)"],
  ["closed_at", "DATETIME2(0)"], ["exit_why", "NVARCHAR(200)"], ["exit_spot", "DECIMAL(12,2)"], ["exit_prem", "DECIMAL(10,2)"], ["pnl_per_unit", "DECIMAL(10,2)"], ["lot_size", "INT"], ["pnl_per_lot", "DECIMAL(12,2)"], ["raw", "NVARCHAR(MAX)"]],
  cp.map((t) => { const pl = t.exitPrem != null && t.entryPrem != null ? t.exitPrem - t.entryPrem : null, lot = LOT[t.index] || null;
    return [t.day, t.index, t.name, t.side, t.strike, t2(t.openedAt), t.entrySpot, t.entryPrem, t.stop, t.t1, t.t2, t.state, t2(t.t1At), t.t1Prem, t2(t.closedAt), t.exitWhy, t.exitSpot, t.exitPrem,
      pl, lot, pl != null && lot ? pl * lot : null, JSON.stringify(t)]; }));

// ---- One Trade
const otNow = readJson(D("one-trade.json"), {}), otToday = otNow.day ? [...(otNow.closed || []), ...(otNow.trade ? [otNow.trade] : [])].map((t) => ({ day: otNow.day, ...t })) : [];
const ot = uniq([...otToday, ...readLines(D("one-trade-history.jsonl"))], (t) => `${t.day}|${t.symbol}|${t.openedAt}`);
table("app_one_trade", [["trade_date", "DATE"], ["index_symbol", "VARCHAR(12)"], ["index_name", "NVARCHAR(40)"], ["side", "CHAR(2)"], ["strike", "DECIMAL(10,2)"], ["opened_at", "DATETIME2(0)"],
  ["entry_spot", "DECIMAL(12,2)"], ["entry_prem", "DECIMAL(10,2)"], ["stop", "DECIMAL(12,2)"], ["target", "DECIMAL(12,2)"], ["risk_pts", "DECIMAL(10,2)"], ["result", "VARCHAR(10)"],
  ["closed_at", "DATETIME2(0)"], ["exit_spot", "DECIMAL(12,2)"], ["exit_prem", "DECIMAL(10,2)"], ["pnl_per_unit", "DECIMAL(10,2)"], ["lot_size", "INT"], ["pnl_per_lot", "DECIMAL(12,2)"], ["review", "VARCHAR(4)"], ["raw", "NVARCHAR(MAX)"]],
  ot.map((t) => { const pl = t.exitPrem != null && t.entryPrem != null ? t.exitPrem - t.entryPrem : null, lot = LOT[t.symbol] || null;
    return [t.day, t.symbol, t.name, t.side, t.strike, t2(t.openedAt), t.entrySpot, t.entryPrem, t.stop, t.target, t.risk, t.state, t2(t.closedAt), t.exitSpot, t.exitPrem, pl, lot, pl != null && lot ? pl * lot : null, t.review, JSON.stringify(t)]; }));

// ---- the owner's trade calls (Learning)
const lt = readJson(D("learning-trades.json"), []);
table("app_learning_trades", [["id", "VARCHAR(40)"], ["created_at", "DATETIME2(0)"], ["call_text", "NVARCHAR(1000)"], ["index_name", "VARCHAR(12)"], ["trade_date", "DATE"], ["trade_time", "VARCHAR(5)"], ["strike", "DECIMAL(10,2)"],
  ["side", "CHAR(2)"], ["entry_rule", "VARCHAR(10)"], ["price", "DECIMAL(10,2)"], ["sl", "DECIMAL(10,2)"], ["targets", "VARCHAR(100)"], ["result", "NVARCHAR(40)"], ["fill", "DECIMAL(10,2)"], ["best", "DECIMAL(10,2)"],
  ["targets_hit", "INT"], ["sl_hit", "BIT"], ["raw", "NVARCHAR(MAX)"]],
  lt.map((x) => { const t = x.trade || {}, r = x.result || {};
    return [x.id, t2(x.createdAt), x.text, t.index, t.date, t.time, t.strike, t.side, t.how, t.price, t.sl, (t.targets || []).join(","), r.status, r.fill, r.best, r.hits, r.sl, JSON.stringify(x)]; }));

// ---- decision ledger
const dl = fs.existsSync(D("decision-ledger")) ? fs.readdirSync(D("decision-ledger")).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().flatMap((f) => readLines(D("decision-ledger", f)).map((r) => ({ ...r, _day: f.slice(0, 10) }))) : [];
table("app_decisions", [["trade_date", "DATE"], ["record_type", "VARCHAR(12)"], ["index_name", "VARCHAR(12)"], ["timeframe", "VARCHAR(6)"], ["candle_time", "DATETIME2(0)"], ["decided_at", "DATETIME2(0)"],
  ["data_status", "VARCHAR(20)"], ["session_phase", "VARCHAR(20)"], ["expiry_day", "BIT"], ["regime", "VARCHAR(30)"], ["direction", "VARCHAR(20)"], ["setup", "VARCHAR(40)"], ["setup_label", "NVARCHAR(100)"],
  ["setup_state", "VARCHAR(20)"], ["final_action", "NVARCHAR(60)"], ["trigger_level", "DECIMAL(12,2)"], ["trigger_label", "NVARCHAR(100)"], ["trigger_status", "VARCHAR(20)"], ["spot", "DECIMAL(12,2)"], ["raw", "NVARCHAR(MAX)"]],
  dl.map((r) => { const { _day, ...x } = r, fa = x.finalAction;
    return [_day, x.type, x.index, x.timeframe, t2(x.candleTime), t2(x.decidedAt), x.dataStatus, x.sessionPhase, x.expiryDay, x.regime, x.direction, x.setup, x.setupLabel, x.setupState,
      fa == null ? null : typeof fa === "string" ? fa : fa.action || fa.label || JSON.stringify(fa).slice(0, 60), x.trigger?.level, x.trigger?.label, x.trigger?.status, x.spot, JSON.stringify(x)]; }));

// ---- market diary (end-of-day snapshot per index)
const md = fs.existsSync(D("market-diary")) ? fs.readdirSync(D("market-diary")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().flatMap((f) => {
  const j = readJson(D("market-diary", f), null); return j && j.entries ? Object.values(j.entries).map((e) => ({ day: j.day || f.slice(0, 10), e })) : []; }) : [];
table("app_market_diary", [["trade_date", "DATE"], ["index_symbol", "VARCHAR(12)"], ["index_name", "NVARCHAR(40)"], ["prev_close", "DECIMAL(12,2)"], ["open", "DECIMAL(12,2)"], ["high", "DECIMAL(12,2)"],
  ["low", "DECIMAL(12,2)"], ["close", "DECIMAL(12,2)"], ["change_pts", "DECIMAL(12,2)"], ["raw", "NVARCHAR(MAX)"]],
  md.map(({ day, e }) => [day, e.symbol, e.name, e.prevClose, e.open, e.high, e.low, e.close, e.close != null && e.prevClose != null ? e.close - e.prevClose : null, JSON.stringify(e)]));

// ---- paper trades (CSV with a header row; quoted cells allowed)
const csv = (() => { try { return fs.readFileSync(D("paper-trades.csv"), "utf8"); } catch { return ""; } })();
const parse = (line) => { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
const lines = csv.split(/\r?\n/).filter(Boolean), head = lines.length ? parse(lines[0]) : [];
const col = (r, k) => { const i = head.indexOf(k); return i < 0 || r[i] === "" ? null : r[i]; };
table("app_paper_trades", [["exit_date", "DATE"], ["pool", "VARCHAR(30)"], ["index_symbol", "VARCHAR(12)"], ["side", "VARCHAR(4)"], ["strike", "DECIMAL(10,2)"], ["qty", "INT"], ["entry", "DECIMAL(10,2)"], ["exit", "DECIMAL(10,2)"],
  ["entry_time", "DATETIME2(0)"], ["exit_time", "DATETIME2(0)"], ["gross_pnl", "DECIMAL(12,2)"], ["costs", "DECIMAL(12,2)"], ["pnl", "DECIMAL(12,2)"], ["pnl_pct", "DECIMAL(8,2)"], ["reason", "NVARCHAR(40)"], ["remark", "NVARCHAR(500)"]],
  lines.slice(1).map(parse).map((r) => ["exitDate", "pool", "symbol", "dir", "strike", "qty", "entry", "exit", "entryIST", "exitIST", "grossPnl", "costs", "pnl", "pnlPct", "reason", "remark"].map((k) => col(r, k))));
