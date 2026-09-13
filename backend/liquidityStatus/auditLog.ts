// ============================ Section 26 — Audit log ============================
import fs from "fs";
import path from "path";
import * as centralLog from "../log/centralLog";
import { LS_CONFIG } from "./config";
import { LiquidityShiftState, MoveStage, TraderAction } from "./types";

export interface LiquidityStatusAuditEntry {
  timestamp: number;
  symbol: string;
  spot: number;
  atmStrike: number | null;
  support: number | null;
  resistance: number | null;
  oi: number | null;
  oiChange: number | null;
  premiumChange: number | null;
  volume: number | null;
  rvol: number | null;
  vwap: number | null;
  ema9: number | null; ema21: number | null; ema50: number | null;
  momentum: number | null;
  liquidityScore: number;
  direction: string;
  movementStage: MoveStage;
  liquidityShift: LiquidityShiftState;
  trigger: number | null;
  invalidation: number | null;
  dataAgeSec: number;
  oiAgeSec: number | null;
  finalAction: TraderAction;
  commentary: string;
}

const FILE = path.join(process.cwd(), "data", "liquidity-status-log.json");

function loadAll(): LiquidityStatusAuditEntry[] {
  try { const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")); return Array.isArray(raw) ? raw : []; } catch { return []; }
}
function saveAll(entries: LiquidityStatusAuditEntry[]): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const capped = entries.slice(-LS_CONFIG.auditLog.cap);
  const tmp = path.join(dir, `.ls-log.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(capped, null, 2), { encoding: "utf-8" });
  fs.renameSync(tmp, FILE);
}

export function logLiquidityStatus(entry: LiquidityStatusAuditEntry): void {
  const all = loadAll();
  all.push(entry);
  saveAll(all);
  centralLog.write({
    channel: "liquidity-status", symbol: entry.symbol, mode: null,
    eventType: entry.liquidityShift.toUpperCase().replace(/[^A-Z]+/g, "_"),
    severity: entry.finalAction === "AVOID CHASING" ? "warn" : "info",
    summary: `${entry.symbol}: ${entry.liquidityShift} / ${entry.movementStage} — ${entry.finalAction}`,
    payload: entry,
  });
}

export function getLiquidityStatusAuditLog(filter?: { symbol?: string; limit?: number }): LiquidityStatusAuditEntry[] {
  let entries = loadAll();
  if (filter?.symbol) entries = entries.filter((e) => e.symbol === filter.symbol);
  entries = entries.slice().reverse();
  return filter?.limit ? entries.slice(0, filter.limit) : entries;
}
