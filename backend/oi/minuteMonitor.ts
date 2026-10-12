import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

// ============================ Strike-wise 1-minute OI change monitor ============================
// One snapshot per (symbol, expiry) per IST minute, captured from the SHARED option-chain cache (no
// extra per-strike polling). Each snapshot keeps two clocks:
//   providerT — when Dhan returned the chain (Dhan's chain has no exchange timestamp of its own)
//   captureT  — when this app stored the snapshot
// Comparisons only use two snapshots of the SAME symbol + expiry. A window (1 / 5 / 15 / 30 min) is
// "aligned" only when the real gap is within tolerance of the window; otherwise the real interval is
// reported and the screen says so. Duplicate provider data (same fetch, or every strike unchanged while
// other strikes should move) is not stored as a new minute, so it can never show as a false addition.
// Snapshots persist to DATA_DIR/oi-minute-monitor/<date>/<symbol>__<expiry>.jsonl for replay.
// Nothing here is used by signals, the arbiter or paper trading.

export interface StrikeRow { strike: number; ceOi: number | null; peOi: number | null; ceLtp: number | null; peLtp: number | null; ceVol: number | null; peVol: number | null }
export interface MinuteSnap { symbol: string; expiry: string; providerT: number; captureT: number; minute: string; spot: number | null; pcr: number | null; maxPain: number | null; strikes: StrikeRow[] }
export type Side = "CE" | "PE";
export type OiClass = "POSSIBLE WRITING" | "POSSIBLE LONG BUILDUP" | "UNWINDING" | "INCONCLUSIVE";

const IST = 19800;
export const istMinute = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
export const istDate = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const num = (v: any): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------------- capture ----------------
export type AcceptResult = { ok: true } | { ok: false; reason: "SAME_FETCH" | "SAME_MINUTE" | "UNCHANGED_DATA" | "NO_STRIKES" | "OUT_OF_ORDER" };
/** Decide whether a new chain reading becomes a stored minute snapshot. */
export function acceptSnapshot(prev: MinuteSnap | null, next: MinuteSnap): AcceptResult {
  if (!next.strikes.length || next.strikes.every((s) => s.ceOi == null && s.peOi == null)) return { ok: false, reason: "NO_STRIKES" };
  if (!prev) return { ok: true };
  if (next.providerT <= prev.providerT) return { ok: false, reason: next.providerT === prev.providerT ? "SAME_FETCH" : "OUT_OF_ORDER" };
  if (next.minute === prev.minute && istDate(next.captureT) === istDate(prev.captureT)) return { ok: false, reason: "SAME_MINUTE" };
  // A chain where not one strike's OI or LTP changed is a repeated provider response, not a quiet minute.
  const pb = new Map(prev.strikes.map((s) => [s.strike, s]));
  const common = next.strikes.filter((s) => pb.has(s.strike));
  if (common.length >= 3 && common.every((s) => { const p = pb.get(s.strike)!; return p.ceOi === s.ceOi && p.peOi === s.peOi && p.ceLtp === s.ceLtp && p.peLtp === s.peLtp; }))
    return { ok: false, reason: "UNCHANGED_DATA" };
  return { ok: true };
}

/** Build a snapshot from the shared chain object (OiAnalysis). */
export function snapFromChain(symbol: string, chain: any, captureT: number): MinuteSnap | null {
  if (!chain || !chain.expiry || !Array.isArray(chain.topStrikes)) return null;
  const strikes: StrikeRow[] = chain.topStrikes.map((s: any) => ({
    strike: Number(s.strike), ceOi: num(s.ceOi), peOi: num(s.peOi), ceLtp: num(s.ceLtp), peLtp: num(s.peLtp), ceVol: num(s.ceVol), peVol: num(s.peVol),
  })).filter((s: StrikeRow) => Number.isFinite(s.strike)).sort((a: StrikeRow, b: StrikeRow) => a.strike - b.strike);
  return { symbol, expiry: String(chain.expiry), providerT: Number(chain.asOf) || captureT, captureT, minute: istMinute(captureT), spot: num(chain.underlying), pcr: num(chain.pcr), maxPain: num(chain.maxPain), strikes };
}

// ---------------- storage ----------------
const ROOT = path.join(DATA_DIR, "oi-minute-monitor");
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
export const snapFile = (date: string, symbol: string, expiry: string, root = ROOT) => path.join(root, date, `${safe(symbol)}__${safe(expiry)}.jsonl`);
const _mem = new Map<string, MinuteSnap[]>();          // `${date}|${symbol}|${expiry}` → today's snapshots
const _stats = new Map<string, Record<string, number>>(); // rejected-reading counters (shown on screen)
const memKey = (date: string, symbol: string, expiry: string) => `${date}|${symbol}|${expiry}`;

export function loadDay(date: string, symbol: string, expiry: string, root = ROOT): MinuteSnap[] {
  const k = memKey(date, symbol, expiry);
  if (root === ROOT && _mem.has(k)) return _mem.get(k)!;
  let rows: MinuteSnap[] = [];
  try { rows = fs.readFileSync(snapFile(date, symbol, expiry, root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { rows = []; }
  rows.sort((a, b) => a.captureT - b.captureT);
  if (root === ROOT) _mem.set(k, rows);
  return rows;
}
/** Store a reading if it is a genuine new minute. Returns why it was skipped otherwise. */
export function recordSnapshot(s: MinuteSnap, root = ROOT): AcceptResult {
  const date = istDate(s.captureT), arr = loadDay(date, s.symbol, s.expiry, root);
  const r = acceptSnapshot(arr[arr.length - 1] || null, s);
  const sk = `${s.symbol}|${s.expiry}`, st = _stats.get(sk) || {};
  if (!r.ok) { st[r.reason] = (st[r.reason] || 0) + 1; _stats.set(sk, st); return r; }
  arr.push(s);
  if (root !== ROOT) { /* tests: no memo */ }
  try { fs.mkdirSync(path.dirname(snapFile(date, s.symbol, s.expiry, root)), { recursive: true }); fs.appendFileSync(snapFile(date, s.symbol, s.expiry, root), JSON.stringify(s) + "\n"); } catch { /* best effort */ }
  return r;
}
export function captureStats(symbol: string, expiry: string) { return _stats.get(`${symbol}|${expiry}`) || {}; }
export function listDays(symbol: string, root = ROOT): { date: string; expiries: string[] }[] {
  try {
    return fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().map((d) => ({
      date: d, expiries: fs.readdirSync(path.join(root, d)).filter((f) => f.startsWith(safe(symbol) + "__")).map((f) => f.slice(safe(symbol).length + 2, -6)),
    })).filter((x) => x.expiries.length);
  } catch { return []; }
}

// ---------------- comparison ----------------
export interface Pair { cur: MinuteSnap; prev: MinuteSnap | null; windowMin: number; actualSec: number | null; aligned: boolean; note: string }
/** The previous snapshot for a window: the newest one at least (window − tol) older than `cur`.
 *  Aligned when the real gap is within ±tol of the window. Never falls back to a too-recent snapshot. */
export function pickPrevious(snaps: MinuteSnap[], curIdx: number, windowMin: number): Pair {
  const cur = snaps[curIdx], target = windowMin * 60, tol = windowMin === 1 ? 20 : Math.min(90, windowMin * 6);
  let prev: MinuteSnap | null = null;
  for (let i = curIdx - 1; i >= 0; i--) {
    if (snaps[i].expiry !== cur.expiry || snaps[i].symbol !== cur.symbol) continue;
    if (cur.captureT - snaps[i].captureT >= target - tol) { prev = snaps[i]; break; }
  }
  if (!prev) return { cur, prev: null, windowMin, actualSec: null, aligned: false, note: `No snapshot ${windowMin} min before ${cur.minute} yet — collecting` };
  const actualSec = cur.captureT - prev.captureT, aligned = Math.abs(actualSec - target) <= tol;
  const mm = `${Math.floor(actualSec / 60)}m ${actualSec % 60}s`;
  return { cur, prev, windowMin, actualSec, aligned, note: aligned ? `${prev.minute} → ${cur.minute}` : `Real interval ${mm} (${prev.minute} → ${cur.minute}) — not a ${windowMin}-min change` };
}

export interface LegChange {
  strike: number; side: Side; prevOi: number | null; curOi: number | null; oiChg: number | null; oiChgPct: number | null;
  prevLtp: number | null; curLtp: number | null; ltpChgPct: number | null; volChg: number | null;
  status: "OK" | "NEW STRIKE" | "MISSING" | "NO DATA"; cls: OiClass; evidence: string[];
}
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Classify one leg. OI addition alone is never called writing: premium and spot must agree. */
export function classify(side: Side, oiChg: number | null, oiChgPct: number | null, ltpChgPct: number | null, spotChg: number | null): { cls: OiClass; evidence: string[] } {
  const ev: string[] = [];
  if (oiChg == null || oiChgPct == null) return { cls: "INCONCLUSIVE", evidence: ["OI change unavailable"] };
  if (Math.abs(oiChgPct) < 0.5) return { cls: "INCONCLUSIVE", evidence: [`OI change ${oiChgPct}% is below the 0.5% noise band`] };
  ev.push(`OI ${oiChg > 0 ? "+" : ""}${oiChg.toLocaleString("en-IN")} (${oiChgPct > 0 ? "+" : ""}${oiChgPct}%)`);
  if (ltpChgPct == null) return { cls: "INCONCLUSIVE", evidence: [...ev, "premium change unavailable — writers and buyers cannot be separated"] };
  ev.push(`premium ${ltpChgPct > 0 ? "+" : ""}${ltpChgPct}%`);
  if (spotChg != null) ev.push(`spot ${spotChg > 0 ? "+" : ""}${r2(spotChg)}`);
  if (oiChg < 0) return { cls: "UNWINDING", evidence: [...ev, ltpChgPct > 0 ? "OI falling with premium rising — shorts covering" : "OI falling with premium falling — longs exiting"] };
  if (Math.abs(ltpChgPct) < 0.5) return { cls: "INCONCLUSIVE", evidence: [...ev, "premium flat — writers and buyers cannot be separated"] };
  // spot move that by itself pushes this option's premium the same way
  const spotPush = spotChg == null ? 0 : side === "CE" ? Math.sign(spotChg) : -Math.sign(spotChg);
  if (ltpChgPct < 0) {
    ev.push(spotPush > 0 ? "premium fell although spot moved in its favour — strong sign of selling" : spotPush < 0 ? "spot moved against this option, which explains part of the premium fall" : "spot flat");
    return { cls: "POSSIBLE WRITING", evidence: ev };
  }
  ev.push(spotPush < 0 ? "premium rose although spot moved against it — strong sign of buying" : spotPush > 0 ? "spot moved in its favour, which explains part of the premium rise" : "spot flat");
  return { cls: "POSSIBLE LONG BUILDUP", evidence: ev };
}

export function legChanges(p: Pair, range?: { min?: number; max?: number }): LegChange[] {
  const out: LegChange[] = [];
  if (!p.prev) return out;
  const pb = new Map(p.prev.strikes.map((s) => [s.strike, s]));
  const spotChg = p.cur.spot != null && p.prev.spot != null ? p.cur.spot - p.prev.spot : null;
  const strikes = new Set([...p.cur.strikes.map((s) => s.strike), ...p.prev.strikes.map((s) => s.strike)]);
  const cb = new Map(p.cur.strikes.map((s) => [s.strike, s]));
  for (const k of [...strikes].sort((a, b) => a - b)) {
    if (range?.min != null && k < range.min) continue;
    if (range?.max != null && k > range.max) continue;
    const c = cb.get(k), q = pb.get(k);
    for (const side of ["CE", "PE"] as Side[]) {
      const g = (s: StrikeRow | undefined, f: "Oi" | "Ltp" | "Vol") => (s ? (s as any)[(side === "CE" ? "ce" : "pe") + f] as number | null : null);
      const curOi = g(c, "Oi"), prevOi = g(q, "Oi"), curLtp = g(c, "Ltp"), prevLtp = g(q, "Ltp"), curVol = g(c, "Vol"), prevVol = g(q, "Vol");
      const status: LegChange["status"] = !c ? "MISSING" : !q ? "NEW STRIKE" : curOi == null || prevOi == null ? "NO DATA" : "OK";
      const oiChg = status === "OK" ? (curOi as number) - (prevOi as number) : null;
      const oiChgPct = oiChg != null && (prevOi as number) > 0 ? r2((oiChg / (prevOi as number)) * 100) : null;
      const ltpChgPct = curLtp != null && prevLtp != null && prevLtp > 0 ? r2(((curLtp - prevLtp) / prevLtp) * 100) : null;
      const volChg = curVol != null && prevVol != null && curVol >= prevVol ? curVol - prevVol : null;   // day volume never falls; a drop = reset → unknown
      const c2 = status === "OK" ? classify(side, oiChg, oiChgPct, ltpChgPct, spotChg) : { cls: "INCONCLUSIVE" as OiClass, evidence: [status === "NEW STRIKE" ? "strike not in the earlier snapshot — no change computed" : status === "MISSING" ? "strike missing from the latest snapshot" : "OI missing"] };
      out.push({ strike: k, side, prevOi, curOi, oiChg, oiChgPct, prevLtp, curLtp, ltpChgPct, volChg, status, cls: c2.cls, evidence: c2.evidence });
    }
  }
  return out;
}

export function topAdditions(rows: LegChange[], side: Side, n = 5) {
  return rows.filter((r) => r.side === side && r.oiChg != null && r.oiChg > 0).sort((a, b) => (b.oiChg as number) - (a.oiChg as number)).slice(0, n);
}

/** Per-minute call / put / net OI change from consecutive aligned 1-minute pairs (latest first). */
export function minuteTimeline(snaps: MinuteSnap[], count = 10, range?: { min?: number; max?: number }) {
  const out: { minute: string; prevMinute: string; aligned: boolean; actualSec: number; callChg: number; putChg: number; net: number; pcr: number | null; spot: number | null }[] = [];
  for (let i = snaps.length - 1; i > 0 && out.length < count; i--) {
    const p = pickPrevious(snaps, i, 1); if (!p.prev) continue;
    const rows = legChanges(p, range);
    const sum = (s: Side) => rows.filter((r) => r.side === s && r.oiChg != null).reduce((a, r) => a + (r.oiChg as number), 0);
    const cc = sum("CE"), pc = sum("PE");
    out.push({ minute: p.cur.minute, prevMinute: p.prev.minute, aligned: p.aligned, actualSec: p.actualSec as number, callChg: cc, putChg: pc, net: pc - cc, pcr: p.cur.pcr, spot: p.cur.spot });
  }
  return out;
}

/** Strike × minute matrix of 1-min OI change for one side (latest minute first). */
export function heatmap(snaps: MinuteSnap[], side: Side, strikes: number[], minutes = 5) {
  const rows: { minute: string; aligned: boolean; cells: (number | null)[] }[] = [];
  for (let i = snaps.length - 1; i > 0 && rows.length < minutes; i--) {
    const p = pickPrevious(snaps, i, 1); if (!p.prev) continue;
    const by = new Map(legChanges(p).filter((r) => r.side === side).map((r) => [r.strike, r.oiChg]));
    rows.push({ minute: p.cur.minute, aligned: p.aligned, cells: strikes.map((k) => (by.has(k) ? (by.get(k) as number | null) : null)) });
  }
  return rows;
}

/** Full screen payload for one symbol + expiry, as of snapshot index `atIdx` (replay) or the latest. */
export function buildView(snaps: MinuteSnap[], opts: { windowMin: number; around?: number; atIdx?: number; minStrike?: number; maxStrike?: number; heatSide?: Side; stats?: Record<string, number>; nowSec?: number }) {
  if (!snaps.length) return { available: false, reason: "No snapshots yet for this expiry today — collection starts automatically in market hours (one per minute).", samples: 0 };
  const idx = opts.atIdx != null ? Math.max(0, Math.min(snaps.length - 1, opts.atIdx)) : snaps.length - 1;
  const hist = snaps.slice(0, idx + 1), cur = hist[hist.length - 1];
  const spot = cur.spot, ks = cur.strikes.map((s) => s.strike);
  const step = ks.length > 1 ? Math.min(...ks.slice(1).map((k, i) => k - ks[i]).filter((d) => d > 0)) : 50;
  const atm = spot != null ? ks.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), ks[0]) : null;
  const around = opts.around || 10;
  const range = { min: opts.minStrike ?? (atm != null ? atm - around * step : undefined), max: opts.maxStrike ?? (atm != null ? atm + around * step : undefined) };
  const pair = pickPrevious(hist, hist.length - 1, opts.windowMin);
  const rows = legChanges(pair, range);
  const tot = (s: Side, pos: boolean) => rows.filter((r) => r.side === s && r.oiChg != null && (pos ? r.oiChg > 0 : true)).reduce((a, r) => a + (r.oiChg as number), 0);
  const prevTot = (s: Side) => rows.filter((r) => r.side === s && r.prevOi != null && r.oiChg != null).reduce((a, r) => a + (r.prevOi as number), 0);
  const addCE = tot("CE", true), addPE = tot("PE", true);
  const topCE = topAdditions(rows, "CE"), topPE = topAdditions(rows, "PE");
  const inRange = cur.strikes.filter((s) => (range.min == null || s.strike >= range.min) && (range.max == null || s.strike <= range.max));
  const pair5 = pickPrevious(hist, hist.length - 1, 5);
  const rows5 = legChanges(pair5, range).filter((r) => r.oiChg != null && r.oiChg > 0).sort((a, b) => (b.oiChg as number) - (a.oiChg as number)).slice(0, 5);
  const heatStrikes = inRange.map((s) => s.strike).filter((k) => atm == null || Math.abs(k - atm) <= 4 * step);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    available: true, symbol: cur.symbol, expiry: cur.expiry, samples: hist.length, firstMinute: hist[0].minute, atIdx: idx, totalSnaps: snaps.length,
    clocks: { providerT: cur.providerT, captureT: cur.captureT, ageSec: now - cur.captureT, note: "Dhan's option chain carries no exchange timestamp: 'Dhan fetch' is when Dhan returned the chain, 'captured' is when this app stored the minute." },
    stale: now - cur.captureT > 150 && opts.atIdx == null,
    spot, atm, step, pcr: cur.pcr, maxPain: cur.maxPain, range,
    window: { min: opts.windowMin, aligned: pair.aligned, actualSec: pair.actualSec, note: pair.note, prevMinute: pair.prev?.minute ?? null, curMinute: cur.minute, prevPcr: pair.prev?.pcr ?? null },
    summary: {
      callAdded: addCE, putAdded: addPE, callNet: tot("CE", false), putNet: tot("PE", false),
      callAddedPct: prevTot("CE") > 0 ? r2((tot("CE", false) / prevTot("CE")) * 100) : null, putAddedPct: prevTot("PE") > 0 ? r2((tot("PE", false) / prevTot("PE")) * 100) : null,
      maxCall: topCE[0] ? { strike: topCE[0].strike, chg: topCE[0].oiChg } : null, maxPut: topPE[0] ? { strike: topPE[0].strike, chg: topPE[0].oiChg } : null,
    },
    chart: inRange.map((s) => { const c = rows.find((r) => r.strike === s.strike && r.side === "CE"), p = rows.find((r) => r.strike === s.strike && r.side === "PE"); return { strike: s.strike, ceOi: s.ceOi, peOi: s.peOi, ceChg: c?.oiChg ?? null, peChg: p?.oiChg ?? null }; }),
    topCE, topPE,
    top5m: { aligned: pair5.aligned, note: pair5.note, rows: rows5 },
    timeline: minuteTimeline(hist, 10, range),
    heat: { side: opts.heatSide || "CE", strikes: heatStrikes, rows: heatmap(hist, opts.heatSide || "CE", heatStrikes, 6) },
    minutes: hist.map((s) => s.minute),
    stats: opts.stats || {},
  };
}
