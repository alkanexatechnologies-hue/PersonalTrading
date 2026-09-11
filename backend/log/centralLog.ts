// ============================ Centralized Log Module ============================
// The SINGLE write path for every log entry across the app. Every other module
// (paper engine, decision log, opening-bias, oi-command signals, and the
// sentiment/liquidity/risk extension modules) calls `centralLog.write(entry)`
// instead of touching the filesystem directly.
//
// Two sinks fed by the same write():
//   1) an in-memory RING BUFFER per channel (UI reads hit this, never disk), and
//   2) an APPEND-ONLY JSONL file per channel per day (durable record):
//        data/log/<channel>-<YYYY-MM-DD>.jsonl   (one JSON object per line)
//
// JSONL append is O(1) (vs the old full-JSON rewrite) and date-rotation gives
// retention for free (see retentionSweep.ts). Ring buffers lazily hydrate from
// the most recent JSONL lines on first read after a restart.
//
// This module is ADDITIVE: it does not remove the existing per-module writers.
// Modules can dual-write during migration so no history is lost.

import fs from "fs";
import path from "path";

export type LogChannel =
  | "paper-trade" | "paper-sell" | "decision" | "opening-bias" | "oi-command"
  | "oi-snapshot" | "oi-baseline" | "oi-hourly-ready" | "regime" | "liquidity"
  | "sentiment" | "wall-reaction" | "premium-sentiment" | "trade-score" | "dedup"
  | "arbitration"
  | "verification"   // §C live-verification records — kept separate from trade channels
  | "signal-audit"   // compliance audit trail: one durable record per emitted signal
  | "agent-narration"; // plain-language guidance produced by the narration agent

export type LogSeverity = "info" | "warn" | "veto";
export type LogMode = "Directional" | "Scalp" | "Setup" | null;

export interface LogEntry {
  id: string;              // monotonic id
  ts: number;              // epoch ms
  channel: LogChannel;
  symbol: string | null;
  mode: LogMode;
  eventType: string;       // e.g. GO_WAIT_FLIP, REGIME_CHANGE, TRADE_EMITTED, VETO_DECAYING
  severity: LogSeverity;
  summary: string;         // one-line human-readable (renders in the log list)
  payload: Record<string, any>; // full detail for the expandable "why" view
}

export type LogInput = Omit<LogEntry, "id" | "ts"> & { id?: string; ts?: number };

const DIR = path.join(process.cwd(), "data", "log");
const DEFAULT_CAP = 800;
const CHANNEL_CAP: Partial<Record<LogChannel, number>> = {
  "decision": 800, "opening-bias": 500, "oi-command": 800,
};

const ALL_CHANNELS: LogChannel[] = [
  "paper-trade", "paper-sell", "decision", "opening-bias", "oi-command",
  "oi-snapshot", "oi-baseline", "oi-hourly-ready", "regime", "liquidity",
  "sentiment", "wall-reaction", "premium-sentiment", "trade-score", "dedup",
  "arbitration", "verification", "signal-audit", "agent-narration",
];

// ---- generic bounded ring buffer ----
class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private cap: number) {}
  push(v: T) { this.buf.push(v); if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap); }
  seed(items: T[]) { this.buf = items.slice(-this.cap); }
  all(): T[] { return this.buf; }
  clear() { this.buf = []; }
  get size() { return this.buf.length; }
}

const rings = new Map<LogChannel, RingBuffer<LogEntry>>();
const hydrated = new Set<LogChannel>();
let seq = 0;

// Decoupled write subscribers. centralLog imports NOTHING from subscribers — they
// register themselves (e.g. the narration agent). Each callback runs inside a
// try/catch so a subscriber can never break a log write or the pipeline.
type WriteSubscriber = (entry: LogEntry) => void;
const subscribers: WriteSubscriber[] = [];
export function onWrite(cb: WriteSubscriber): void { subscribers.push(cb); }

function ringFor(channel: LogChannel): RingBuffer<LogEntry> {
  let r = rings.get(channel);
  if (!r) { r = new RingBuffer<LogEntry>(CHANNEL_CAP[channel] ?? DEFAULT_CAP); rings.set(channel, r); }
  if (!hydrated.has(channel)) { hydrate(channel, r); hydrated.add(channel); }
  return r;
}

const istDate = (ms: number) => new Date(ms + 19800000).toISOString().slice(0, 10);
function fileFor(channel: LogChannel, ms: number) { return path.join(DIR, `${channel}-${istDate(ms)}.jsonl`); }

// Lazily rebuild a channel's ring from the two most recent JSONL files on disk.
function hydrate(channel: LogChannel, ring: RingBuffer<LogEntry>) {
  try {
    if (!fs.existsSync(DIR)) return;
    const files = fs.readdirSync(DIR)
      .filter((f) => f.startsWith(channel + "-") && f.endsWith(".jsonl"))
      .sort();
    const recent = files.slice(-2); // today + yesterday is plenty for a warm start
    const out: LogEntry[] = [];
    for (const f of recent) {
      const text = fs.readFileSync(path.join(DIR, f), "utf-8");
      for (const line of text.split("\n")) {
        const s = line.trim(); if (!s) continue;
        try { out.push(JSON.parse(s)); } catch { /* skip a corrupt line */ }
      }
    }
    if (out.length) { ring.seed(out); seq = Math.max(seq, out.length); }
  } catch { /* best-effort */ }
}

/** THE single write path. Fills id/ts, pushes to the ring, appends one JSONL line. */
export function write(input: LogInput): LogEntry {
  const ts = input.ts ?? Date.now();
  const entry: LogEntry = {
    id: input.id ?? `${ts.toString(36)}-${(++seq).toString(36)}`,
    ts,
    channel: input.channel,
    symbol: input.symbol ?? null,
    mode: input.mode ?? null,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    summary: input.summary,
    payload: input.payload ?? {},
  };
  ringFor(entry.channel).push(entry);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(entry.channel, ts), JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* best-effort: never let logging break a trading tick */ }
  // Notify subscribers (non-blocking, isolated). Used by the narration agent.
  for (const cb of subscribers) { try { cb(entry); } catch { /* subscriber must never break a write */ } }
  return entry;
}

export interface LogQuery {
  channel?: LogChannel | "all";
  symbol?: string;
  mode?: LogMode;
  severity?: LogSeverity;
  from?: number;  // epoch ms inclusive
  to?: number;    // epoch ms inclusive
  eventType?: string;
  limit?: number;
}

/** Read from ring buffers (never disk). channel=all merges every channel by ts desc. */
export function query(q: LogQuery = {}): LogEntry[] {
  const channels: LogChannel[] = !q.channel || q.channel === "all" ? ALL_CHANNELS : [q.channel];
  let rows: LogEntry[] = [];
  for (const ch of channels) rows = rows.concat(ringFor(ch).all());
  rows = rows.filter((e) =>
    (q.symbol ? e.symbol === q.symbol : true) &&
    (q.mode ? e.mode === q.mode : true) &&
    (q.severity ? e.severity === q.severity : true) &&
    (q.eventType ? e.eventType === q.eventType : true) &&
    (q.from ? e.ts >= q.from : true) &&
    (q.to ? e.ts <= q.to : true),
  );
  rows.sort((a, b) => b.ts - a.ts); // newest first
  return rows.slice(0, q.limit ?? 200);
}

/** Clear ONE channel's ring buffer (durable JSONL on disk is untouched). */
export function clearChannel(channel: LogChannel): void {
  ringFor(channel).clear();
}

const csvCell = (v: any) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export derived from the log (one row per entry). BOM for Excel/Hindi. */
export function exportCsv(q: LogQuery = {}): string {
  const rows = query({ ...q, limit: q.limit ?? 5000 });
  const head = ["tsIST", "channel", "symbol", "mode", "eventType", "severity", "summary"];
  const lines = rows.map((e) => [
    new Date(e.ts + 19800000).toISOString().replace("T", " ").slice(0, 19),
    e.channel, e.symbol ?? "", e.mode ?? "", e.eventType, e.severity, e.summary,
  ].map(csvCell).join(","));
  return "\ufeff" + [head.join(","), ...lines].join("\r\n");
}

export const LOG_CHANNELS = ALL_CHANNELS;
