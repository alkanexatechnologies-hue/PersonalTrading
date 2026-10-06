// VolumeBindingResolver — resolves the appropriate FUTURES contract for a given
// historical date (NOT simply "current front month"). Reuses the existing Dhan
// scrip-master CSV (data/dhan_instruments.csv) that dhanInstruments.ts already
// downloads/caches — no new download/auth mechanism. The production parser only
// indexes INDEX/EQUITY/OPTION rows, so we read FUTIDX rows here, test-lab-local.
//
// IMPORTANT limitation (reported, not hidden): the scrip master is a POINT-IN-
// TIME snapshot of currently-tradeable contracts. A monthly future that already
// EXPIRED is not in it, so for past dates whose front-month has expired the
// binding is UNAVAILABLE_HISTORICAL (never silently bound to a wrong/far month).

import fs from "fs";
import path from "path";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { INDEX_MASTER } from "./config";
import { FuturesBinding, IndexKey } from "./types";

const CSV_PATH = path.resolve(process.cwd(), "data", "dhan_instruments.csv");

interface FutRow { securityId: string; expiry: string; expiryMs: number; segment: string; lotSize: number; symbolName: string; }
const _futCache = new Map<string, FutRow[]>(); // underlying -> sorted futures rows

async function ensureCsv(nseSymbol: string): Promise<void> {
  // Trigger the existing loader (downloads+caches the CSV if missing/stale).
  try { await lookupDhanSecurity(nseSymbol); } catch { /* best-effort */ }
}

function loadFutures(underlying: string): FutRow[] {
  const key = underlying.toUpperCase();
  const cached = _futCache.get(key);
  if (cached) return cached;
  const rows: FutRow[] = [];
  try {
    const raw = fs.readFileSync(CSV_PATH, "utf8");
    const lines = raw.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const c = line.split(",");
      if (c.length < 13) continue;
      if (c[4] !== "FUTIDX") continue;
      if ((c[6] || "").toUpperCase() !== key) continue;
      const expiry = (c[12] || "").trim();
      const expiryMs = Date.parse(expiry + "T10:00:00Z"); // ~15:30 IST close
      if (!expiry || !Number.isFinite(expiryMs)) continue;
      rows.push({
        securityId: c[2],
        expiry,
        expiryMs,
        segment: c[0] === "BSE" ? "BSE_FNO" : "NSE_FNO",
        lotSize: Number(c[11]) || 0,
        symbolName: (c[8] || c[7] || "").trim(),
      });
    }
  } catch { /* no csv */ }
  rows.sort((a, b) => a.expiryMs - b.expiryMs);
  _futCache.set(key, rows);
  return rows;
}

const DAY = 86_400_000;

// Median gap (days) between consecutive available monthly expiries — used to
// judge, data-drivenly (NOT by hard-coding an expiry weekday, §22), whether the
// nearest available contract really is the date's front-month or whether an
// earlier (now-expired, absent) monthly contract should have been the front-month.
function cycleDays(futs: FutRow[]): number {
  if (futs.length < 2) return 31;
  const gaps: number[] = [];
  for (let i = 1; i < futs.length; i++) gaps.push((futs[i].expiryMs - futs[i - 1].expiryMs) / DAY);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)] || 31;
  return med > 5 && med < 70 ? med : 31;
}

/** Resolve the futures contract that was the active front-month on `dateMs`. */
export async function resolveFuturesBinding(index: IndexKey, dateMs: number): Promise<FuturesBinding> {
  const m = INDEX_MASTER[index];
  await ensureCsv(m.nseSymbol);
  const futs = loadFutures(m.nseSymbol);
  const base: FuturesBinding = {
    underlying: m.nseSymbol, futuresSymbol: null, securityId: null, expiry: null,
    exchangeSegment: null, lotSize: null, status: "INVALID", bindingReason: "",
  };
  if (!futs.length) {
    return { ...base, status: "UNAVAILABLE_HISTORICAL", bindingReason: `No ${m.nseSymbol} FUTIDX rows in scrip master.` };
  }
  // Front month = smallest available expiry on/after the test date.
  const onOrAfter = futs.filter((f) => f.expiryMs >= dateMs - DAY);
  if (!onOrAfter.length) {
    const latest = futs[futs.length - 1];
    return { ...base, status: "UNAVAILABLE_HISTORICAL", bindingReason: `All available ${m.nseSymbol} futures expired before ${iso(dateMs)} (latest master expiry ${latest.expiry}).` };
  }
  const front = onOrAfter[0];
  const gapDays = (front.expiryMs - dateMs) / DAY;
  // Cycle-aware guard (§1): if the nearest AVAILABLE expiry is more than ~one
  // monthly cycle away, an earlier monthly contract was the true front-month on
  // this date — it has since expired and is absent from the point-in-time scrip
  // master. We must NOT bind the next month to a past date, so report it honestly.
  const threshold = cycleDays(futs) + 3;
  if (gapDays > threshold) {
    return {
      ...base, status: "UNAVAILABLE_HISTORICAL",
      bindingReason: `Historical front-month for ${iso(dateMs)} has expired and is absent from the current scrip master (nearest available expiry ${front.expiry} is ${Math.round(gapDays)}d away > ~1 cycle ${Math.round(threshold)}d).`,
    };
  }
  return {
    underlying: m.nseSymbol,
    futuresSymbol: front.symbolName || `${m.nseSymbol} FUT`,
    securityId: front.securityId,
    expiry: front.expiry,
    exchangeSegment: front.segment,
    lotSize: front.lotSize,
    status: "RESOLVED",
    bindingReason: `Front-month ${front.expiry} selected for ${iso(dateMs)} (gap ${Math.round(gapDays)}d <= ~1 cycle).`,
  };
}

export interface PerDateBinding { date: string; binding: FuturesBinding; contractChange: boolean; }

/**
 * §1/§2 — resolve the date-correct binding for EACH trading date and flag the
 * dates where the active contract rolled (contractChange). Returns one entry per
 * input IST date (ascending). Noon IST is used as the representative instant.
 */
export async function resolvePerDateBindings(index: IndexKey, istDates: string[]): Promise<PerDateBinding[]> {
  const out: PerDateBinding[] = [];
  let prevKey = "";
  for (const d of istDates) {
    const noonMs = Date.parse(d + "T12:00:00+05:30");
    const b = await resolveFuturesBinding(index, noonMs);
    const key = b.status === "RESOLVED" ? (b.securityId || b.expiry || "R") : b.status;
    out.push({ date: d, binding: b, contractChange: prevKey !== "" && key !== prevKey });
    prevKey = key;
  }
  return out;
}

/** List all futures expiries currently in the master for an index (diagnostics). */
export async function listFuturesExpiries(index: IndexKey): Promise<string[]> {
  const m = INDEX_MASTER[index];
  await ensureCsv(m.nseSymbol);
  return loadFutures(m.nseSymbol).map((f) => f.expiry);
}

function iso(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
