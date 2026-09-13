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

let index: Map<string, DhanSecurity> | null = null;
let loadingPromise: Promise<void> | null = null;

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

function parseCsv(): Map<string, DhanSecurity> {
  const map = new Map<string, DhanSecurity>();
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  // Header: EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,
  //         UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,...
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
    }
  }
  return map;
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
      index = parseCsv();
      refreshInBackground();
      return;
    }
    await downloadCsv();
    index = parseCsv();
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
