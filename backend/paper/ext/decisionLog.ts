// ---- Decision Log — the trust layer for the whole extension ----
// Every soft-scoring state change and hard-veto decision from the new modules is
// appended here (newest-first), so a trader can trace WHY the cockpit flipped or
// WHY a trade was/ wasn't taken, without reading code. Persisted to
// data/decision-log.json (capped). Two writers:
//   - the OI Command read (GO/WAIT flips, regime/liquidity/sentiment/wall changes)
//   - the paper engine (trade emitted / veto / dedup / below-clarity)

import fs from "fs";
import path from "path";
import * as centralLog from "../../log/centralLog";
import { CONFIG } from "../../config/arbitration";

export type DecisionEventType =
  | "go-flip"          // GO <-> WAIT changed
  | "regime"           // marketRegime state change
  | "liquidity"        // Normal <-> Thin flip
  | "sentiment"        // sentimentState change
  | "wall"             // wallReactionState fired on a wall touch
  | "emitted"          // trade opened (with finalScore + setupQuality)
  | "veto"             // premiumSentiment.Decaying hard suppress
  | "duplicate"        // tradeDedup suppressed a re-fire
  | "below-clarity";   // setupQuality < 30 (computed/logged, not surfaced)

export type DecisionMode = "Directional" | "Scalp" | "-";

export interface DecisionLogEntry {
  at: number;             // epoch seconds
  type: DecisionEventType;
  mode: DecisionMode;
  symbol: string;
  text: string;           // one-line human summary
  finalScore?: number;
  setupQuality?: number;
  from?: string;          // previous state (for flips/changes)
  to?: string;            // new state
}

const FILE = path.join(process.cwd(), "data", "decision-log.json");
const CAP = 800;

let cache: DecisionLogEntry[] | null = null;

function read(): DecisionLogEntry[] {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { cache = []; }
  return cache!;
}
function write(rows: DecisionLogEntry[]) {
  cache = rows.slice(0, CAP);
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf-8"); } catch { /* best-effort */ }
}

// Map a decision event to the central log's common schema.
const CENTRAL_EVENT: Record<DecisionEventType, { eventType: string; severity: centralLog.LogSeverity }> = {
  "go-flip": { eventType: "GO_WAIT_FLIP", severity: "info" },
  "regime": { eventType: "REGIME_CHANGE", severity: "info" },
  "liquidity": { eventType: "LIQUIDITY_FLIP", severity: "info" },
  "sentiment": { eventType: "SENTIMENT_CHANGE", severity: "info" },
  "wall": { eventType: "WALL_REACTION", severity: "info" },
  "emitted": { eventType: "TRADE_EMITTED", severity: "info" },
  "veto": { eventType: "VETO_DECAYING", severity: "veto" },
  "duplicate": { eventType: "DEDUP_SUPPRESSED", severity: "warn" },
  "below-clarity": { eventType: "BELOW_CLARITY_THRESHOLD", severity: "warn" },
};

/** Append one decision event (newest-first) and mirror it into the central log. */
export function logDecision(e: Omit<DecisionLogEntry, "at"> & { at?: number }): void {
  const at = e.at ?? Math.floor(Date.now() / 1000);
  const rows = read();
  rows.unshift({ at, ...e } as DecisionLogEntry);
  write(rows);
  // Mirror into the centralized log (common schema) — additive; the legacy
  // decision-log.json above stays intact so nothing is lost during migration.
  try {
    const m = CENTRAL_EVENT[e.type] || { eventType: e.type.toUpperCase(), severity: "info" as centralLog.LogSeverity };
    centralLog.write({
      ts: at * 1000, channel: "decision", symbol: e.symbol ?? null,
      mode: e.mode === "Directional" || e.mode === "Scalp" ? e.mode : null,
      eventType: m.eventType, severity: m.severity, summary: e.text,
      payload: { dataSource: "DHAN", from: e.from, to: e.to, finalScore: e.finalScore, setupQuality: e.setupQuality },
    });
  } catch { /* best-effort */ }
}

export interface DecisionLogFilter {
  type?: DecisionEventType | "all";
  mode?: DecisionMode | "all";
  sinceEpoch?: number;   // only entries at/after this time
  symbol?: string;
  limit?: number;
}

/** Read the log with optional filters (event type, mode, time range, symbol). */
export function getDecisionLog(f: DecisionLogFilter = {}): DecisionLogEntry[] {
  let rows = read();
  if (f.type && f.type !== "all") rows = rows.filter((r) => r.type === f.type);
  if (f.mode && f.mode !== "all") rows = rows.filter((r) => r.mode === f.mode);
  if (f.symbol) rows = rows.filter((r) => r.symbol === f.symbol);
  if (f.sinceEpoch) rows = rows.filter((r) => r.at >= f.sinceEpoch!);
  return rows.slice(0, f.limit ?? 200);
}

export function clearDecisionLog(): void { write([]); }

// ---- per-symbol "last snapshot" used to DETECT changes to log ----
// Stored in memory (rebuilt on restart); the log itself is the durable record.
interface OiSnapshot { go: boolean; regime?: string; liquidity?: string; sentiment?: string; wall?: string; arbVerdict?: string; stale?: boolean }
const lastSnap = new Map<string, OiSnapshot>();

/**
 * Compare the latest OI Command read for a symbol against the previous one and
 * append a log entry for each thing that changed. Called from the /oi-command
 * route (user-facing) only.
 */
export function reconcileOiState(symbol: string, snap: OiSnapshot): void {
  const prev = lastSnap.get(symbol);
  lastSnap.set(symbol, snap);
  if (!prev) return; // first read establishes a baseline, nothing to diff
  const at = Math.floor(Date.now() / 1000);
  if (prev.go !== snap.go) {
    logDecision({ at, type: "go-flip", mode: "Directional", symbol, from: prev.go ? "GO" : "WAIT", to: snap.go ? "GO" : "WAIT", text: `${symbol}: ${prev.go ? "GO" : "WAIT"} → ${snap.go ? "GO" : "WAIT"}` });
  }
  if (prev.regime !== snap.regime && snap.regime) {
    logDecision({ at, type: "regime", mode: "-", symbol, from: prev.regime, to: snap.regime, text: `${symbol}: regime ${prev.regime || "—"} → ${snap.regime}` });
  }
  if (prev.liquidity !== snap.liquidity && snap.liquidity) {
    logDecision({ at, type: "liquidity", mode: "-", symbol, from: prev.liquidity, to: snap.liquidity, text: `${symbol}: liquidity ${prev.liquidity || "—"} → ${snap.liquidity}` });
  }
  if (prev.sentiment !== snap.sentiment && snap.sentiment) {
    logDecision({ at, type: "sentiment", mode: "Directional", symbol, from: prev.sentiment, to: snap.sentiment, text: `${symbol}: sentiment ${prev.sentiment || "—"} → ${snap.sentiment}` });
  }
  // Wall reaction: log when it FIRES a directional read on a touch (not UNCLEAR).
  if (prev.wall !== snap.wall && snap.wall && snap.wall !== "UNCLEAR") {
    logDecision({ at, type: "wall", mode: "Directional", symbol, from: prev.wall, to: snap.wall, text: `${symbol}: wall reaction ${snap.wall}` });
  }
  // Arbiter verdict change -> dedicated 'arbitration' channel (CONFLICT = warn).
  if (prev.arbVerdict !== snap.arbVerdict && snap.arbVerdict) {
    try {
      centralLog.write({
        ts: at * 1000, channel: "arbitration", symbol, mode: "Directional",
        eventType: `ARBITER_${snap.arbVerdict}`,
        severity: snap.arbVerdict === "CONFLICT" ? "warn" : "info",
        summary: `${symbol}: arbiter ${prev.arbVerdict || "—"} → ${snap.arbVerdict}`,
        payload: { from: prev.arbVerdict, to: snap.arbVerdict },
      });
    } catch { /* best-effort */ }
  }
  // Data-health degrade/restore (OI feed) -> 'oi-command' channel, so the narration
  // agent can explain a lagging board. Caller passes stale already gated to
  // market-open (after-hours 'stale' is expected, not a degradation).
  if (prev.stale !== snap.stale && snap.stale != null) {
    try {
      centralLog.write({
        ts: at * 1000, channel: "oi-command", symbol, mode: null,
        eventType: snap.stale ? "DATA_HEALTH_DEGRADE" : "DATA_HEALTH_RESTORED",
        severity: snap.stale ? "warn" : "info",
        summary: `${symbol}: OI feed ${snap.stale ? "degraded (stale / rate-limited) — reads may lag" : "back to normal — reads live again"}`,
        payload: {},
      });
    } catch { /* best-effort */ }
  }
}

// ---- Arbiter watchdog (log-only safety net) ----
// Replaces "a human watching" with "the system watching itself". Writes a
// 'verification'-channel entry when either invariant is violated:
//   (a) a GO whose finalScore falls outside [floor, ceiling] — structurally
//       impossible given tradeScore's clamp, kept as belt-and-suspenders; or
//   (b) a CONFLICT that persists beyond CONFIG.arbitration.conflictPersistMinutes.
// Each condition is de-duped per symbol so it logs on onset, not every cycle.
const _conflictSince = new Map<string, number>();
const _conflictWarned = new Set<string>();
const _scoreWarned = new Set<string>();

export function checkArbiterWatchdog(p: { symbol: string; verdict: string; primaryFinalScore?: number | null }): void {
  const now = Date.now();
  const { floor, ceiling } = CONFIG.tradeScore;
  const persistMs = (CONFIG.arbitration.conflictPersistMinutes || 15) * 60000;

  // (a) finalScore out of band on a GO.
  if (p.verdict === "GO" && p.primaryFinalScore != null && (p.primaryFinalScore < floor || p.primaryFinalScore > ceiling)) {
    if (!_scoreWarned.has(p.symbol)) {
      _scoreWarned.add(p.symbol);
      try {
        centralLog.write({
          channel: "verification", symbol: p.symbol, mode: "Directional",
          eventType: "WATCHDOG_SCORE_OUT_OF_BAND", severity: "warn",
          summary: `${p.symbol}: GO finalScore ${p.primaryFinalScore} outside [${floor},${ceiling}]`,
          payload: { finalScore: p.primaryFinalScore, floor, ceiling },
        });
      } catch { /* best-effort */ }
    }
  } else {
    _scoreWarned.delete(p.symbol);
  }

  // (b) CONFLICT persistence.
  if (p.verdict === "CONFLICT") {
    const start = _conflictSince.get(p.symbol);
    if (start == null) {
      _conflictSince.set(p.symbol, now);
    } else if (now - start >= persistMs && !_conflictWarned.has(p.symbol)) {
      _conflictWarned.add(p.symbol);
      try {
        centralLog.write({
          channel: "verification", symbol: p.symbol, mode: "Directional",
          eventType: "WATCHDOG_CONFLICT_PERSIST", severity: "warn",
          summary: `${p.symbol}: CONFLICT persisted > ${CONFIG.arbitration.conflictPersistMinutes}m`,
          payload: { sinceMs: start, minutes: Math.round((now - start) / 60000) },
        });
      } catch { /* best-effort */ }
    }
  } else {
    _conflictSince.delete(p.symbol);
    _conflictWarned.delete(p.symbol);
  }
}
