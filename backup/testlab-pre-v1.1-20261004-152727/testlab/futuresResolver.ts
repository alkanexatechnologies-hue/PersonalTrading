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
  // Front month = smallest expiry strictly on/after the test date.
  const onOrAfter = futs.filter((f) => f.expiryMs >= dateMs - DAY);
  if (!onOrAfter.length) {
    const latest = futs[futs.length - 1];
    return { ...base, status: "UNAVAILABLE_HISTORICAL", bindingReason: `All available ${m.nseSymbol} futures expired before ${iso(dateMs)} (latest master expiry ${latest.expiry}).` };
  }
  const front = onOrAfter[0];
  // If the nearest available expiry is far beyond the date (> ~45d), the true
  // historical front-month has expired and is absent from the master.
  const gapDays = (front.expiryMs - dateMs) / DAY;
  if (gapDays > 45) {
    return {
      ...base, status: "UNAVAILABLE_HISTORICAL",
      bindingReason: `Historical front-month for ${iso(dateMs)} has expired and is not in the current scrip master (nearest available expiry ${front.expiry}, ${Math.round(gapDays)}d away).`,
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
    bindingReason: `Front-month ${front.expiry} selected for ${iso(dateMs)} (gap ${Math.round(gapDays)}d).`,
  };
}

/** List all futures expiries currently in the master for an index (diagnostics). */
export async function listFuturesExpiries(index: IndexKey): Promise<string[]> {
  const m = INDEX_MASTER[index];
  await ensureCsv(m.nseSymbol);
  return loadFutures(m.nseSymbol).map((f) => f.expiry);
}

function iso(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
