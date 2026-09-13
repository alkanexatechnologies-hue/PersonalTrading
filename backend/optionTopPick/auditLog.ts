// ============================ Audit log ============================
// Same convention as backend/paper/ext/decisionLog.ts: an append-only, capped JSON
// file for durable history/backtesting, plus a mirror into the app's centralized
// log (backend/log/centralLog.ts) under its own "option-top-pick" channel.

import fs from "fs";
import path from "path";
import * as centralLog from "../log/centralLog";
import { OTP_CONFIG } from "./config";
import { FinalDecision, StrategyTrack } from "./types";

export interface OptionTopPickAuditEntry {
  timestamp: number;
  symbol: string;
  track: StrategyTrack;
  spot: number;
  movePct: number;
  movementStage: string;
  direction: string | null;
  qualityScore: number;
  selectedOption: string | null;
  optionLtp: number | null;
  entry: number | null;
  target1: number | null;
  target2: number | null;
  stop: number | null;
  roomPts: number | null;
  decision: FinalDecision;
  reason: string;
  dataTimestamp: number;
  oiTimestamp: number | null;
  dataAgeSec: number;
}

const FILE = path.join(process.cwd(), "data", "option-top-pick-log.json");

function loadAll(): OptionTopPickAuditEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveAll(entries: OptionTopPickAuditEntry[]): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const capped = entries.slice(-OTP_CONFIG.auditLog.cap);
  const tmp = path.join(dir, `.otp-log.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(capped, null, 2), { encoding: "utf-8" });
  fs.renameSync(tmp, FILE);
}

export function logOptionTopPick(entry: OptionTopPickAuditEntry): void {
  const all = loadAll();
  all.push(entry);
  saveAll(all);

  centralLog.write({
    channel: "option-top-pick",
    symbol: entry.symbol,
    mode: null,
    eventType: entry.decision.replace(/[^A-Z]+/g, "_"),
    severity: entry.decision === "AVOID" || entry.decision === "EXTENDED — DO NOT CHASE" ? "warn" : "info",
    summary: `${entry.symbol} [${entry.track}]: ${entry.decision} — ${entry.reason}`,
    payload: entry,
  });
}

export function getOptionTopPickAuditLog(filter?: { symbol?: string; track?: StrategyTrack; limit?: number }): OptionTopPickAuditEntry[] {
  let entries = loadAll();
  if (filter?.symbol) entries = entries.filter((e) => e.symbol === filter.symbol);
  if (filter?.track) entries = entries.filter((e) => e.track === filter.track);
  entries = entries.slice().reverse();
  return filter?.limit ? entries.slice(0, filter.limit) : entries;
}
