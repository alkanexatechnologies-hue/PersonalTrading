import fs from "fs";
import path from "path";

// ---- Dhan instrument master (for backtesting only - see dhanHistorical.ts) ----
// Dhan's historical-data API needs a numeric securityId + exchangeSegment +
// instrument enum per symbol (not a plain trading symbol like Groww accepts).
// Dhan publishes a scrip master CSV; we download it, cache to disk (refresh at
// most twice a day - same policy as growwInstruments.ts), and index NSE index +
// equity rows by their UNDERLYING_SYMBOL column, which already matches this
// app's own SymbolDef.nseSymbol convention exactly (e.g. "NIFTY", "BANKNIFTY",
// "RELIANCE") - no separate mapping table needed.
//
// Enum values (exchangeSegment / instrument) verified against Dhan's own docs
// (dhanhq.co/docs/v2/annexure/) - IDX_I for indices, NSE_EQ for equity cash.

const CSV_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
const CSV_PATH = path.resolve(process.cwd(), "data", "dhan_instruments.csv");
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // refresh at most twice a day

export interface DhanSecurity {
  securityId: string;
  exchangeSegment: "IDX_I" | "NSE_EQ";
  instrument: "INDEX" | "EQUITY";
}

// Dhan F&O option contract — needed by the historical/intraday charts API, which
// requires the OPTION's own numeric securityId (a Groww trading symbol is rejected
// with DH-905). Segment for NSE F&O historical data is "NSE_FNO".
export interface DhanOptionSecurity {
  securityId: string;
  exchangeSegment: "NSE_FNO";
  instrument: "OPTIDX" | "OPTSTK";
}

let index: Map<string, DhanSecurity> | null = null;
let optionIndex: Map<string, DhanOptionSecurity> | null = null;
let loadingPromise: Promise<void> | null = null;

// Contract key: UNDERLYING|EXPIRY(yyyy-mm-dd)|STRIKE(number)|CE|PE
function optionKey(underlying: string, expiry: string, strike: number, type: "CE" | "PE"): string {
  return `${underlying.toUpperCase()}|${expiry}|${Number(strike)}|${type}`;
}

async function downloadCsv(): Promise<void> {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Dhan instrument CSV ${res.status}`);
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

function parseCsv(): void {
  const map = new Map<string, DhanSecurity>();
  const opts = new Map<string, DhanOptionSecurity>();
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  // Header: EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,
  //   UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,
  //   SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,...
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 8) continue;
    const exch = c[0], segment = c[1], securityId = c[2], instrument = c[4], underlying = (c[6] || "").toUpperCase();
    if (!underlying || exch !== "NSE") continue;
    if (segment === "I" && instrument === "INDEX") {
      if (!map.has(underlying)) map.set(underlying, { securityId, exchangeSegment: "IDX_I", instrument: "INDEX" });
    } else if (segment === "E" && instrument === "EQUITY") {
      if (!map.has(underlying)) map.set(underlying, { securityId, exchangeSegment: "NSE_EQ", instrument: "EQUITY" });
    } else if ((instrument === "OPTIDX" || instrument === "OPTSTK") && c.length >= 15) {
      // Option contract row → index by underlying|expiry|strike|type for the
      // charts API (needs the option's own securityId, not a trading symbol).
      const expiry = (c[12] || "").trim();          // SM_EXPIRY_DATE (yyyy-mm-dd)
      const strike = Number(c[13]);                  // STRIKE_PRICE
      const type = (c[14] || "").trim().toUpperCase(); // OPTION_TYPE (CE/PE)
      if (!expiry || !Number.isFinite(strike) || (type !== "CE" && type !== "PE")) continue;
      const key = optionKey(underlying, expiry, strike, type);
      if (!opts.has(key)) opts.set(key, { securityId, exchangeSegment: "NSE_FNO", instrument });
    }
  }
  index = map;
  optionIndex = opts;
}

// Stale-while-revalidate, same pattern as growwInstruments.ts: a stale-but-
// present CSV is served immediately (parse cost is small - tens of ms even at
// this file's ~35MB size) while a fresh copy downloads in the background and
// swaps in once ready. Only a genuinely MISSING file blocks.
let backgroundRefreshing = false;
function refreshInBackground(): void {
  if (backgroundRefreshing) return;
  backgroundRefreshing = true;
  downloadCsv()
    .then(() => { parseCsv(); })
    .catch(() => { /* keep serving the already-parsed stale copy */ })
    .finally(() => { backgroundRefreshing = false; });
}

async function ensureLoaded(): Promise<void> {
  if (index) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    if (csvFresh()) {
      parseCsv();
      return;
    }
    if (fs.existsSync(CSV_PATH)) {
      parseCsv();
      refreshInBackground();
      return;
    }
    await downloadCsv();
    parseCsv();
  })();
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export async function lookupDhanSecurity(nseSymbol: string): Promise<DhanSecurity | null> {
  await ensureLoaded();
  return index?.get(nseSymbol.toUpperCase()) || null;
}

// Resolve the Dhan securityId for a specific option contract so the charts API
// can fetch its premium candles. Returns null when the contract isn't in the
// scrip master (unknown strike/expiry) — the caller then reports DATA UNAVAILABLE
// rather than guessing.
export async function lookupDhanOption(
  underlying: string,
  type: "CE" | "PE",
  strike: number,
  expiry: string,
): Promise<DhanOptionSecurity | null> {
  await ensureLoaded();
  return optionIndex?.get(optionKey(underlying, expiry, strike, type)) || null;
}
