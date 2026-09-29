import fs from "fs";
import path from "path";

// ============================ Daily trade log (persisted) ============================
// Append-only record of executed trades for the Trade Execution screen's "Trade
// Details (Daily Log)" table. Persisted under DATA_DIR (survives restart/redeploy).
// This store does NOT compute SL/target/risk — it only records what the existing
// engines produced at execution and lets the outcome (status/exit) be updated
// later. One row per execution; a stable sequence number per IST day.

export type TradeType = "CE" | "PE";
export type TradeStatus = "Open" | "Target Hit" | "SL Hit" | "No Trade";

export interface TradeRow {
  id: string;
  seq: number;            // per-day sequence (1,2,3… within the IST day)
  date: string;          // yyyy-mm-dd (IST)
  time: string;          // HH:MM:SS (IST) — execution time
  execTs: number;        // epoch sec — actual execution timestamp
  index: string;         // NIFTY / BANKNIFTY / …
  symbol: string;        // ^NSEI / …
  type: TradeType;       // CE / PE
  strike: number | null;
  expiry?: string | null; // option expiry (yyyy-mm-dd) — lets the monitor fetch this contract's premium
  entry: number | null;
  sl: number | null;
  target: number | null;
  totalPoint: number | null;   // realized points once closed
  rr: string | null;           // "1:2" etc (from existing setup)
  status: TradeStatus;
  exitPrice: number | null;
  exitTime: string | null;     // HH:MM:SS IST
  remarks: string;
  // Immutable decision snapshot captured at execution — the gates/context that
  // produced this trade, so clicking the row reconstructs THAT trade's logic
  // (never today's current logic). Free-form; written once, never recomputed.
  snapshot?: any;
}

const istDay = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(0, 10);
const istTime = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(11, 19);

function baseDir(): string { return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data"); }
function file(): string { return path.join(baseDir(), "trade", "trade-log.jsonl"); }

function readAll(): TradeRow[] {
  try {
    return fs.readFileSync(file(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as TradeRow);
  } catch { return []; }
}

function appendLine(row: TradeRow): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(row) + "\n", "utf8");
}

// Rewrites the whole file (used only when updating an existing row's outcome).
function rewrite(rows: TradeRow[]): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, f);
}

export interface AppendTradeInput {
  execTs: number;
  index: string;
  symbol: string;
  type: TradeType;
  strike: number | null;
  expiry?: string | null;
  entry: number | null;
  sl: number | null;
  target: number | null;
  rr?: string | null;
  remarks?: string;
  snapshot?: any;
}

/** Record a newly executed trade. Returns the stored row (with its day-sequence). */
export function appendTrade(inp: AppendTradeInput): TradeRow {
  const day = istDay(inp.execTs);
  const seq = readAll().filter((r) => r.date === day).length + 1;
  const row: TradeRow = {
    id: `${inp.symbol}:${inp.execTs}:${inp.type}:${inp.strike ?? ""}`,
    seq, date: day, time: istTime(inp.execTs), execTs: inp.execTs,
    index: inp.index, symbol: inp.symbol, type: inp.type, strike: inp.strike, expiry: inp.expiry ?? null,
    entry: inp.entry, sl: inp.sl, target: inp.target, totalPoint: null,
    rr: inp.rr ?? null, status: "Open", exitPrice: null, exitTime: null,
    remarks: inp.remarks || "",
    snapshot: inp.snapshot ?? null,
  };
  appendLine(row);
  return row;
}

export interface UpdateTradeInput {
  id: string;
  status?: TradeStatus;
  exitPrice?: number | null;
  exitTs?: number | null;
  remarks?: string;
}

/** Update an existing trade's outcome (status / exit / remarks). No-op if not found. */
export function updateTrade(inp: UpdateTradeInput): TradeRow | null {
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === inp.id);
  if (i < 0) return null;
  const r = rows[i];
  if (inp.status) r.status = inp.status;
  if (inp.exitPrice !== undefined) r.exitPrice = inp.exitPrice;
  if (inp.exitTs != null) r.exitTime = istTime(inp.exitTs);
  if (inp.remarks !== undefined) r.remarks = inp.remarks;
  if (r.exitPrice != null && r.entry != null) r.totalPoint = Math.round((r.exitPrice - r.entry) * 100) / 100;
  rows[i] = r;
  rewrite(rows);
  return r;
}

/** All trades (optionally filtered to one IST day), newest first. */
export function listTrades(date?: string): TradeRow[] {
  const rows = readAll();
  const filtered = date ? rows.filter((r) => r.date === date) : rows;
  return filtered.sort((a, b) => b.execTs - a.execTs);
}

export interface DaySummary { date: string; trades: number; win: number; loss: number; pl: number; }

/** Per-day win/loss/P&L summary, newest day first (default last 7 days present). */
export function weeklySummary(days = 7): DaySummary[] {
  const byDay = new Map<string, DaySummary>();
  for (const r of readAll()) {
    let s = byDay.get(r.date);
    if (!s) { s = { date: r.date, trades: 0, win: 0, loss: 0, pl: 0 }; byDay.set(r.date, s); }
    s.trades++;
    if (r.status === "Target Hit") s.win++;
    else if (r.status === "SL Hit") s.loss++;
    if (r.totalPoint != null) s.pl += r.totalPoint;
  }
  return [...byDay.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, days)
    .map((s) => ({ ...s, pl: Math.round(s.pl * 100) / 100 }));
}

const CSV_HEAD = ["SeqNo", "Date", "Time", "Index", "Type", "Strike", "Entry", "SL", "Target", "TotalPoint", "RR", "Status", "ExitPrice", "ExitTime", "Remarks"];

export function tradesToCsv(rows: TradeRow[]): string {
  const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [CSV_HEAD.join(",")];
  for (const r of rows) {
    lines.push([r.seq, r.date, r.time, r.index, r.type, r.strike, r.entry, r.sl, r.target, r.totalPoint, r.rr, r.status, r.exitPrice, r.exitTime, r.remarks].map(esc).join(","));
  }
  return lines.join("\n");
}
