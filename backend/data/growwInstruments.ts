import fs from "fs";
import path from "path";

// ---- Groww Instruments master (for option back-testing) ----
// Groww publishes a CSV of every tradable instrument. For options it gives the
// exact `trading_symbol` (e.g. BANKNIFTY26NOV46400PE) which is what the historical
// candle API needs (segment=FNO). We download it, cache to disk (refresh daily),
// and index the FNO CE/PE rows by underlying so the back-test can resolve any
// strike/expiry the user picks.

const CSV_URL = "https://growwapi-assets.groww.in/instruments/instrument.csv";
const CSV_PATH = path.resolve(process.cwd(), "data", "groww_instruments.csv");
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // refresh at most twice a day

export interface OptionInstrument {
  tradingSymbol: string; // e.g. BANKNIFTY26NOV46400PE
  underlying: string;    // e.g. BANKNIFTY
  type: "CE" | "PE";
  strike: number;
  expiry: string;        // yyyy-mm-dd
  lotSize: number;
}

// underlyingUPPER -> option rows
let index: Map<string, OptionInstrument[]> | null = null;
let loadingPromise: Promise<void> | null = null;

async function downloadCsv(): Promise<void> {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`instruments CSV ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  fs.writeFileSync(CSV_PATH, text, "utf8");
}

function csvFresh(): boolean {
  try {
    const st = fs.statSync(CSV_PATH);
    return Date.now() - st.mtimeMs < MAX_AGE_MS && st.size > 1_000_000;
  } catch {
    return false;
  }
}

function parseCsv(): Map<string, OptionInstrument[]> {
  const map = new Map<string, OptionInstrument[]>();
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  // Header: exchange,exchange_token,trading_symbol,groww_symbol,name,instrument_type,
  //         segment,series,isin,underlying_symbol,underlying_exchange_token,
  //         expiry_date,strike_price,lot_size,...
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 14) continue;
    if (c[6] !== "FNO") continue;
    const type = c[5];
    if (type !== "CE" && type !== "PE") continue; // skip futures
    const underlying = (c[9] || "").toUpperCase();
    const strike = Number(c[12]);
    const expiry = c[11];
    if (!underlying || !expiry || !Number.isFinite(strike)) continue;
    const rec: OptionInstrument = {
      tradingSymbol: c[2],
      underlying,
      type,
      strike,
      expiry,
      lotSize: Number(c[13]) || 0,
    };
    let arr = map.get(underlying);
    if (!arr) { arr = []; map.set(underlying, arr); }
    arr.push(rec);
  }
  return map;
}

// Stale-while-revalidate (same pattern as computeNiftyMacroSetupLive in
// routes/api.ts): a stale-but-present CSV is parsed and served immediately -
// its ~19MB size costs ~80ms to parse (measured), so that part was never the
// blocking cost. The live re-download from Groww's CDN (measured ~1.7s on a
// fast connection, more on a slower one) is what used to block the first
// caller; it now runs in the background and swaps `index` in once it
// succeeds, so a LATER request in the same process picks up the refreshed
// data - matching "future requests use refreshed copy". A missing CSV (no
// on-disk copy at all) is unchanged: still a normal blocking download, since
// there is no valid data to serve in the meantime.
let backgroundRefreshing = false;
function refreshInBackground(): void {
  if (backgroundRefreshing) return;
  backgroundRefreshing = true;
  downloadCsv()
    .then(() => { index = parseCsv(); })
    .catch(() => { /* keep serving the already-parsed stale copy */ })
    .finally(() => { backgroundRefreshing = false; });
}

async function ensureLoaded(): Promise<void> {
  if (index) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    if (csvFresh()) {
      index = parseCsv();
      return;
    }
    if (fs.existsSync(CSV_PATH)) {
      // Stale but present: serve the existing valid copy now, refresh later.
      index = parseCsv();
      refreshInBackground();
      return;
    }
    // No CSV at all - nothing valid to serve yet, so this stays a blocking download.
    await downloadCsv();
    index = parseCsv();
  })();
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

/** All future (>= today IST) expiries for an underlying, sorted ascending. */
export async function optionExpiries(underlying: string): Promise<string[]> {
  await ensureLoaded();
  const arr = index!.get(underlying.toUpperCase()) || [];
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const set = new Set<string>();
  for (const r of arr) set.add(r.expiry);
  const all = Array.from(set).sort();
  const future = all.filter((e) => e >= today);
  return future.length ? future : all;
}

/** Sorted unique strikes for an underlying+expiry (optionally a single side). */
export async function optionStrikes(underlying: string, expiry: string, type?: "CE" | "PE"): Promise<number[]> {
  await ensureLoaded();
  const arr = index!.get(underlying.toUpperCase()) || [];
  const set = new Set<number>();
  for (const r of arr) {
    if (r.expiry !== expiry) continue;
    if (type && r.type !== type) continue;
    set.add(r.strike);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** Resolve the exact option instrument for a strike/expiry/side. */
export async function findOption(underlying: string, type: "CE" | "PE", strike: number, expiry: string): Promise<OptionInstrument | null> {
  await ensureLoaded();
  const arr = index!.get(underlying.toUpperCase()) || [];
  return arr.find((r) => r.type === type && r.strike === strike && r.expiry === expiry) || null;
}

/** True if we have any option rows for this underlying. */
export async function hasOptionData(underlying: string): Promise<boolean> {
  await ensureLoaded();
  return (index!.get(underlying.toUpperCase()) || []).length > 0;
}
