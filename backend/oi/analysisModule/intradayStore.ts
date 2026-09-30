// ============================================================================
//  OI ANALYSIS MODULE — intraday per-strike snapshot store  (ADDITIVE)
// ----------------------------------------------------------------------------
//  Keeps a small in-memory, per-symbol rolling history of per-strike CE/PE OI
//  and LTP, sampled ~once per minute. Used by the OI Movement screen to compute
//  "what is changing right now" (intraday ΔOI, ΔOI%, per-strike history and
//  surge alerts) WITHOUT look-ahead: a read at time T only sees samples whose
//  timestamp ≤ T. De-duped on the chain's `asOf` so the ~15s OI cache is not
//  double-counted. Purely observational — feeds no trading logic, no orders.
// ============================================================================

export interface StrikePoint {
  strike: number;
  ceOi: number;
  peOi: number;
  ceLtp: number | null;
  peLtp: number | null;
}

export interface StrikeSnapshot {
  t: number;      // wall-clock seconds recorded
  asOf: number;   // chain data timestamp (dedupe key)
  spot: number | null;
  strikes: StrikePoint[];
}

export interface StrikeDelta {
  strike: number;
  side: "CALL" | "PUT";
  oiNow: number;
  oiChg: number;      // Δ over the window (0 if only one sample)
  oiChgPct: number;
  ltpNow: number | null;
  ltpChg: number;
  windowMin: number;  // minutes actually covered
}

const MAX_HISTORY_SEC = 6.5 * 60 * 60; // a full trading session
const MIN_SAMPLE_GAP_SEC = 55;         // ~1-minute cadence (allow slight jitter)

const _history = new Map<string, StrikeSnapshot[]>();

// Record one chain reading. Skips duplicates (same asOf) and enforces a ~1-min
// minimum gap so the 5s poll doesn't flood the store with near-identical rows.
export function recordStrikeSnapshot(
  symbol: string,
  asOf: number,
  spot: number | null,
  strikes: StrikePoint[]
): void {
  if (!symbol || !Array.isArray(strikes) || strikes.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const arr = _history.get(symbol) || [];
  const last = arr[arr.length - 1];
  if (last) {
    if (last.asOf === asOf) return;            // same chain snapshot
    if (now - last.t < MIN_SAMPLE_GAP_SEC) return; // enforce 1-min cadence
  }
  arr.push({ t: now, asOf, spot, strikes: strikes.map((s) => ({ ...s })) });
  const cutoff = now - MAX_HISTORY_SEC;
  while (arr.length && arr[0].t < cutoff) arr.shift();
  _history.set(symbol, arr);
}

export function resetStrikeStore(symbol?: string): void {
  if (symbol) _history.delete(symbol); else _history.clear();
}

export function sampleCount(symbol: string): number {
  return (_history.get(symbol) || []).length;
}

// The last two snapshot wall-clock timestamps (epoch seconds), newest first.
// Used to show the true snapshot cadence on the OI Movement screen.
export function lastTwoSnapshotTimes(symbol: string): { last: number | null; prev: number | null } {
  const arr = _history.get(symbol) || [];
  return { last: arr.length ? arr[arr.length - 1].t : null, prev: arr.length > 1 ? arr[arr.length - 2].t : null };
}

// The most recent sample at/older than (now - windowMin). No look-ahead: only
// samples already recorded are considered.
function pastSnapshot(arr: StrikeSnapshot[], windowMin: number): StrikeSnapshot | null {
  if (!arr.length) return null;
  const latest = arr[arr.length - 1];
  const targetT = latest.t - windowMin * 60;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= targetT) return arr[i];
  }
  return arr[0]; // not enough history yet — use the oldest we have
}

// Per-strike intraday deltas over the window. Returns one CALL and one PUT row
// per strike present in the latest snapshot.
export function strikeDeltas(symbol: string, windowMin: number): StrikeDelta[] {
  const arr = _history.get(symbol) || [];
  if (!arr.length) return [];
  const latest = arr[arr.length - 1];
  const past = pastSnapshot(arr, windowMin);
  const coveredMin = past ? Math.max((latest.t - past.t) / 60, 0) : 0;
  const pastBy = new Map<number, StrikePoint>();
  if (past) past.strikes.forEach((s) => pastBy.set(s.strike, s));

  const out: StrikeDelta[] = [];
  for (const s of latest.strikes) {
    const p = pastBy.get(s.strike);
    const ceOiChg = p ? s.ceOi - p.ceOi : 0;
    const peOiChg = p ? s.peOi - p.peOi : 0;
    const ceLtpChg = p && p.ceLtp != null && s.ceLtp != null ? +(s.ceLtp - p.ceLtp).toFixed(2) : 0;
    const peLtpChg = p && p.peLtp != null && s.peLtp != null ? +(s.peLtp - p.peLtp).toFixed(2) : 0;
    out.push({
      strike: s.strike, side: "CALL", oiNow: s.ceOi, oiChg: ceOiChg,
      oiChgPct: pct(ceOiChg, s.ceOi), ltpNow: s.ceLtp, ltpChg: ceLtpChg, windowMin: coveredMin,
    });
    out.push({
      strike: s.strike, side: "PUT", oiNow: s.peOi, oiChg: peOiChg,
      oiChgPct: pct(peOiChg, s.peOi), ltpNow: s.peLtp, ltpChg: peLtpChg, windowMin: coveredMin,
    });
  }
  return out;
}

// Per-strike, per-side time series for the "selected strike OI history" panel.
export function strikeHistory(symbol: string, strike: number, side: "CALL" | "PUT"): Array<{ t: number; oi: number; ltp: number | null }> {
  const arr = _history.get(symbol) || [];
  const out: Array<{ t: number; oi: number; ltp: number | null }> = [];
  for (const snap of arr) {
    const p = snap.strikes.find((s) => s.strike === strike);
    if (!p) continue;
    out.push({ t: snap.t, oi: side === "CALL" ? p.ceOi : p.peOi, ltp: side === "CALL" ? p.ceLtp : p.peLtp });
  }
  return out;
}

function pct(chg: number, now: number): number {
  const base = now - chg;
  if (base <= 0) return 0;
  return +((chg / base) * 100).toFixed(2);
}
