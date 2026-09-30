// ============================================================================
//  AUDIT MODE — runtime market-data telemetry  (feature-flagged, read-only)
// ----------------------------------------------------------------------------
//  Off by default (AUDIT_MODE=false). When on, the Dhan/Groww fetch chokepoints
//  and the shared cache record one lightweight entry per event into an in-memory
//  ring buffer, and /api/audit/summary rolls them up (calls/min, cache hit/miss,
//  p50/p95 latency, duplicates, errors, retries, rate-limit events, provider
//  split). It NEVER changes what any endpoint fetches or returns — it only
//  observes. Dependency-free (node built-ins only) so the low-level clients can
//  import it without any circular dependency.
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export const AUDIT_ENABLED = String(process.env.AUDIT_MODE ?? "false").trim().toLowerCase() === "true";

export interface AuditCtx { screen: string; reqId: string; }
const als = new AsyncLocalStorage<AuditCtx>();
export function runWithAuditCtx<T>(ctx: AuditCtx, fn: () => T): T { return als.run(ctx, fn); }
export function newReqId(): string { return randomBytes(6).toString("hex"); }

export interface CallEntry {
  ts: number;            // epoch ms (request start)
  provider: "dhan" | "groww";
  endpoint: string;      // path, query stripped
  screen: string;        // referer / route that triggered it (or "background")
  reqId: string | null;
  securityId?: string | null;
  interval?: string | number | null;
  symbol?: string | null;
  strike?: number | null;
  expiry?: string | null;
  optType?: string | null;
  latencyMs: number;
  httpStatus: number;    // 0 = network/exception
  respBytes: number | null;
  error: string | null;
  retry: number;         // retry attempt index (0 = first try)
  rateLimit: boolean;    // 429 / DH-904 observed
}

interface CacheEntry { ts: number; key: string; hit: boolean; }

const MAX = 8000;
const _calls: CallEntry[] = [];
const _cache: CacheEntry[] = [];

export function recordCall(e: Omit<CallEntry, "ts" | "screen" | "reqId"> & { ts?: number }): void {
  if (!AUDIT_ENABLED) return;
  const ctx = als.getStore();
  _calls.push({ ts: e.ts ?? Date.now(), screen: ctx?.screen ?? "background", reqId: ctx?.reqId ?? null, ...e });
  if (_calls.length > MAX) _calls.splice(0, _calls.length - MAX);
}

export function recordCache(key: string, hit: boolean): void {
  if (!AUDIT_ENABLED) return;
  _cache.push({ ts: Date.now(), key, hit });
  if (_cache.length > MAX) _cache.splice(0, _cache.length - MAX);
}

// Pull request-shaped metadata out of a Dhan POST body for the log.
export function dhanBodyMeta(body: any): Pick<CallEntry, "securityId" | "interval"> {
  if (!body || typeof body !== "object") return { securityId: null, interval: null };
  return {
    securityId: body.securityId != null ? String(body.securityId) : null,
    interval: body.interval != null ? body.interval : null,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[i];
}

export interface AuditSummary {
  enabled: boolean;
  windowMin: number;
  now: number;
  totalCalls: number;
  byProvider: Record<string, { calls: number; callsPerMin: number; errors: number; retries: number; rateLimits: number; p50ms: number | null; p95ms: number | null }>;
  byEndpoint: Array<{ provider: string; endpoint: string; calls: number; callsPerMin: number; errors: number; rateLimits: number; p50ms: number | null; p95ms: number | null }>;
  cache: { hits: number; misses: number; hitPct: number | null };
  duplicates: { count: number; note: string; top: Array<{ endpoint: string; key: string; n: number }> };
  rateLimitEvents: number;
  byScreen: Array<{ screen: string; calls: number }>;
  note: string;
}

// Roll up the last `windowMin` minutes.
export function auditSummary(windowMin = 10): AuditSummary {
  const now = Date.now();
  const cut = now - windowMin * 60_000;
  const calls = _calls.filter((c) => c.ts >= cut);
  const cache = _cache.filter((c) => c.ts >= cut);
  const spanMin = Math.max(1 / 60, (now - (calls.length ? calls[0].ts : now)) / 60_000) || windowMin;

  const byProvider: AuditSummary["byProvider"] = {};
  for (const prov of ["dhan", "groww"] as const) {
    const cs = calls.filter((c) => c.provider === prov);
    const lat = cs.map((c) => c.latencyMs).sort((a, b) => a - b);
    byProvider[prov] = {
      calls: cs.length,
      callsPerMin: +(cs.length / spanMin).toFixed(1),
      errors: cs.filter((c) => c.error).length,
      retries: cs.filter((c) => c.retry > 0).length,
      rateLimits: cs.filter((c) => c.rateLimit).length,
      p50ms: percentile(lat, 50),
      p95ms: percentile(lat, 95),
    };
  }

  const epMap = new Map<string, CallEntry[]>();
  for (const c of calls) { const k = `${c.provider} ${c.endpoint}`; (epMap.get(k) || epMap.set(k, []).get(k)!).push(c); }
  const byEndpoint = Array.from(epMap.entries()).map(([k, cs]) => {
    const [provider, ...rest] = k.split(" ");
    const lat = cs.map((c) => c.latencyMs).sort((a, b) => a - b);
    return { provider, endpoint: rest.join(" "), calls: cs.length, callsPerMin: +(cs.length / spanMin).toFixed(1), errors: cs.filter((c) => c.error).length, rateLimits: cs.filter((c) => c.rateLimit).length, p50ms: percentile(lat, 50), p95ms: percentile(lat, 95) };
  }).sort((a, b) => b.calls - a.calls);

  const hits = cache.filter((c) => c.hit).length, misses = cache.filter((c) => !c.hit).length;

  // Duplicates: same provider+endpoint+securityId+interval fired within 2s of another.
  const dupKey = (c: CallEntry) => `${c.provider} ${c.endpoint} ${c.securityId ?? ""} ${c.interval ?? ""}`;
  const groups = new Map<string, number[]>();
  for (const c of calls) { const k = dupKey(c); (groups.get(k) || groups.set(k, []).get(k)!).push(c.ts); }
  let dupCount = 0; const dupTop: Array<{ endpoint: string; key: string; n: number }> = [];
  for (const [k, tss] of groups) {
    tss.sort((a, b) => a - b);
    let n = 0;
    for (let i = 1; i < tss.length; i++) if (tss[i] - tss[i - 1] <= 2000) n++;
    if (n > 0) { dupCount += n; dupTop.push({ endpoint: k.split(" ").slice(0, 2).join(" "), key: k, n }); }
  }
  dupTop.sort((a, b) => b.n - a.n);

  const screenMap = new Map<string, number>();
  for (const c of calls) screenMap.set(c.screen, (screenMap.get(c.screen) || 0) + 1);

  return {
    enabled: AUDIT_ENABLED, windowMin, now, totalCalls: calls.length, byProvider, byEndpoint,
    cache: { hits, misses, hitPct: hits + misses ? +(hits / (hits + misses) * 100).toFixed(1) : null },
    duplicates: { count: dupCount, note: "same provider+endpoint+securityId+interval within 2s", top: dupTop.slice(0, 10) },
    rateLimitEvents: calls.filter((c) => c.rateLimit).length,
    byScreen: Array.from(screenMap.entries()).map(([screen, calls]) => ({ screen, calls })).sort((a, b) => b.calls - a.calls).slice(0, 15),
    note: AUDIT_ENABLED ? "Live telemetry. Buffer is in-memory (last ~8000 events); resets on restart." : "AUDIT_MODE is OFF — set AUDIT_MODE=true to collect telemetry.",
  };
}

export function auditReset(): void { _calls.length = 0; _cache.length = 0; }
export function auditRawCount(): number { return _calls.length; }
