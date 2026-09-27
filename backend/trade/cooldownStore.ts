import fs from "fs";
import path from "path";

// ============================ Post-trade cooldown store ============================
// After ANY trade is executed the whole confirmation flow enters a mandatory
// 15-minute cooldown: no new trade / entry / strike selection until it expires.
// The cooldown is anchored to the ACTUAL EXECUTION TIMESTAMP (not signal time)
// and PERSISTED to DATA_DIR, so a restart/redeploy recovers an in-flight
// cooldown from disk instead of letting a new trade slip through. This store
// only records timing + arms the gate; it never changes SL/target/risk/strike
// logic. The 15 minutes is the user's explicit rule, not an inferred threshold.

export const COOLDOWN_MINUTES = 15;

export interface CooldownState {
  active: boolean;
  execTs: number | null;        // epoch seconds — actual execution time
  startTs: number | null;       // cooldown start (= execTs)
  endTs: number | null;         // cooldown end (= execTs + 15m)
  remainingSec: number;         // 0 when not active
  nextAllowedTs: number | null; // first epoch second a new trade is allowed (= endTs)
  istExec: string | null;       // HH:MM:SS IST
  istEnd: string | null;
  nextAllowedIst: string | null;
  reason: string | null;        // WAIT reason while active, else null
}

export interface ExecutionRecord {
  symbol: string;
  execTs: number;
  side?: string | null;         // CE / PE
  strike?: number | null;
  entry?: number | null;
  source?: string | null;       // where the execution came from (audit)
}

const ist = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(11, 19);

function fmtRemain(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}m ${s}s`;
}

// PURE: derive the full cooldown state from an execution timestamp + "now".
// No disk, no clock — fully deterministic and unit-testable.
export function computeCooldown(execTs: number | null, nowTs: number): CooldownState {
  if (execTs == null || !isFinite(execTs)) {
    return { active: false, execTs: null, startTs: null, endTs: null, remainingSec: 0, nextAllowedTs: null, istExec: null, istEnd: null, nextAllowedIst: null, reason: null };
  }
  const startTs = execTs;
  const endTs = execTs + COOLDOWN_MINUTES * 60;
  const remainingSec = Math.max(0, endTs - nowTs);
  const active = remainingSec > 0;
  return {
    active, execTs, startTs, endTs,
    remainingSec,
    nextAllowedTs: endTs,
    istExec: ist(execTs), istEnd: ist(endTs), nextAllowedIst: ist(endTs),
    reason: active ? `POST TRADE COOLDOWN — ${fmtRemain(remainingSec)} REMAINING` : null,
  };
}

// ---- persistence (survives restart/redeploy via DATA_DIR) --------------------
const _cache = new Map<string, number>(); // symbol -> last execTs (epoch sec)

// Resolve DATA_DIR at call time (matches config/dataDir.ts semantics) so a
// runtime/test override of DATA_DIR is honoured and production points at the
// mounted Persistent Disk.
function baseDir(): string { return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data"); }
function stateFile(): string { return path.join(baseDir(), "trade", "cooldowns.json"); }
function auditFile(): string { return path.join(baseDir(), "trade", "executions.jsonl"); }

function loadAll(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {}; }
  catch { return {}; }
}

function saveAll(obj: Record<string, number>): void {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, f);
}

/** Arm the cooldown for a symbol from an ACTUAL execution timestamp, and append
 *  an immutable audit line. Returns the fresh cooldown state. */
export function recordExecution(rec: ExecutionRecord): CooldownState {
  const all = loadAll();
  all[rec.symbol] = rec.execTs;
  saveAll(all);
  _cache.set(rec.symbol, rec.execTs);
  try {
    const f = auditFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({
      event: "TRADE_EXECUTED", symbol: rec.symbol, execTs: rec.execTs, istExec: ist(rec.execTs),
      cooldownStartTs: rec.execTs, cooldownEndTs: rec.execTs + COOLDOWN_MINUTES * 60,
      nextAllowedTs: rec.execTs + COOLDOWN_MINUTES * 60,
      side: rec.side ?? null, strike: rec.strike ?? null, entry: rec.entry ?? null, source: rec.source ?? null,
    }) + "\n", "utf8");
  } catch { /* audit best-effort; never blocks the cooldown */ }
  return computeCooldown(rec.execTs, Math.floor(Date.now() / 1000));
}

/** Current cooldown state for a symbol. Recovers a persisted execution timestamp
 *  from disk when the in-memory cache is cold (i.e. after a restart). */
export function getCooldownState(symbol: string, nowTs: number = Math.floor(Date.now() / 1000)): CooldownState {
  let execTs = _cache.get(symbol);
  if (execTs === undefined) {
    const all = loadAll();
    if (all[symbol] !== undefined) { execTs = all[symbol]; _cache.set(symbol, execTs); }
  }
  return computeCooldown(execTs ?? null, nowTs);
}

/** Test helper: forget the in-memory cache so the next read comes from disk. */
export function _resetCooldownCache(): void { _cache.clear(); }
