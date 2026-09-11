import { MarketDataProvider } from "./provider";
import { Candle, Interval, Quote, OiAnalysis, OiStrike } from "../types";
import { findSymbolDef, SymbolDef } from "../config";

const BASE = "https://api.groww.in";

// ---- GLOBAL Groww request throttle + 429 back-off ----
// Every Groww API call (candles, quotes, expiries, option-chain) goes through
// growwFetch, which (1) caps the request RATE + concurrency so bursts (the 26-
// symbol scans, OI snapshot, etc.) don't breach Groww's limit, and (2) on a 429
// waits (respecting Retry-After) and retries with exponential back-off. This is
// the single place that keeps the whole app rate-limit-safe.
const nativeFetch = fetch;

// Client-side ceilings — kept BELOW Groww's documented per-category (Orders / Live Data /
// Non-Trading) per-second + per-minute limits so we never trip a server-side 429. All are
// env-overridable in case Groww changes them (verify against groww.in/trade-api/docs).
const GROWW_MIN_GAP_MS = Number(process.env.GROWW_MIN_GAP_MS) || 220;          // ~4-5 req/s pacing
const GROWW_MAX_CONCURRENT = Number(process.env.GROWW_MAX_CONCURRENT) || 2;
const GROWW_MAX_PER_MIN = Number(process.env.GROWW_MAX_PER_MIN) || 240;        // < ~300/min live-data ceiling
const GROWW_MAX_PER_DAY = Number(process.env.GROWW_MAX_PER_DAY) || 0;          // 0 = no hard daily cap (log only)
const GROWW_BACKOFF_BASE_MS = 1000;   // 1s → 2s → 4s → 8s → 16s (…cap)
const GROWW_BACKOFF_CAP_MS = 60_000;  // never wait more than 60s
const GROWW_MAX_RETRIES = 5;

let _growwLast = 0;
let _growwActive = 0;
const _minuteWindow: number[] = []; // dispatch timestamps within the last 60s
let _dayCount = 0;
let _dayKey = "";
const _growwSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- rate-limit telemetry (surfaced at GET /api/groww/ratelimit-stats) ----
interface EpStat { calls: number; rateLimited: number; retries: number; lastStatus?: number; lastBackoffMs?: number; lastAt?: number; }
const _rlStats = new Map<string, EpStat>();
const _rlTotals = { calls: 0, rateLimited: 0, retries: 0, throttleWaits: 0, gaveUp: 0, lastRateLimitAt: 0 };
function epKey(url: string): string {
  try { return new URL(url).pathname.replace(/\/[0-9]+(?=\/|$)/g, "/:n"); } catch { return url.split("?")[0]; }
}
export function growwRateLimitStats() {
  const now = Date.now();
  while (_minuteWindow.length && now - _minuteWindow[0] > 60_000) _minuteWindow.shift();
  return {
    totals: { ..._rlTotals },
    perMinute: { used: _minuteWindow.length, cap: GROWW_MAX_PER_MIN },
    perDay: { used: _dayCount, cap: GROWW_MAX_PER_DAY || null, day: _dayKey },
    inFlight: _growwActive,
    endpoints: [..._rlStats.entries()].map(([endpoint, v]) => ({ endpoint, ...v })).sort((a, b) => b.calls - a.calls),
  };
}
const istDayKey = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

// Reserve one call slot: enforces per-day (IST) counter + per-minute sliding window +
// per-second pacing. Only called on the FIRST attempt so a retry isn't double-counted.
async function acquireSlot(key: string): Promise<void> {
  const dk = istDayKey();
  if (dk !== _dayKey) { _dayKey = dk; _dayCount = 0; }
  if (GROWW_MAX_PER_DAY && _dayCount >= GROWW_MAX_PER_DAY) {
    console.warn(`[groww-rl] DAILY cap ${GROWW_MAX_PER_DAY} reached — blocking ${key} until IST midnight`);
    throw new Error(`Groww daily call cap (${GROWW_MAX_PER_DAY}) reached — try again after IST midnight`);
  }
  // per-minute sliding window: wait until an old dispatch ages out of the 60s window.
  for (;;) {
    const now = Date.now();
    while (_minuteWindow.length && now - _minuteWindow[0] > 60_000) _minuteWindow.shift();
    if (_minuteWindow.length < GROWW_MAX_PER_MIN) break;
    _rlTotals.throttleWaits++;
    const waitMs = Math.min(2000, 60_000 - (now - _minuteWindow[0]) + 5);
    console.warn(`[groww-rl] per-minute cap ${GROWW_MAX_PER_MIN} reached — throttling ${key} ${waitMs}ms`);
    await _growwSleep(waitMs);
  }
  // per-second pacing.
  const gap = _growwLast + GROWW_MIN_GAP_MS - Date.now();
  if (gap > 0) await _growwSleep(gap);
  _growwLast = Date.now();
  _minuteWindow.push(_growwLast);
  _dayCount++;
  if (GROWW_MAX_PER_DAY && _dayCount === Math.floor(GROWW_MAX_PER_DAY * 0.8)) {
    console.warn(`[groww-rl] reached 80% of daily cap (${_dayCount}/${GROWW_MAX_PER_DAY})`);
  }
}

async function growwFetch(url: string, init?: any, _tries = 0): Promise<Response> {
  const key = epKey(url);
  if (_tries === 0) {
    await acquireSlot(key);
    const st = _rlStats.get(key) || { calls: 0, rateLimited: 0, retries: 0 };
    st.calls++; st.lastAt = Date.now(); _rlStats.set(key, st);
    _rlTotals.calls++;
  }
  // concurrency guard around the actual network call (applies to retries too).
  const waitStart = Date.now();
  while (_growwActive >= GROWW_MAX_CONCURRENT) {
    if (Date.now() - waitStart > 12_000) throw new Error("Groww queue timeout (12s) — skipped to avoid hang");
    await _growwSleep(25);
  }
  _growwActive++;
  let res: Response;
  try {
    const signal = init?.signal || AbortSignal.timeout(8000);
    res = await nativeFetch(url, { ...init, signal });
  } finally {
    _growwActive--;
  }
  if ((res.status === 429 || res.status === 503) && _tries < GROWW_MAX_RETRIES) {
    // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s (capped at 60s), honouring
    // a larger Retry-After if the server sent one.
    const ra = Number(res.headers.get("retry-after"));
    const expo = Math.min(GROWW_BACKOFF_CAP_MS, GROWW_BACKOFF_BASE_MS * Math.pow(2, _tries));
    const backoff = Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0, expo) + Math.floor(Math.random() * 400);
    const st = _rlStats.get(key) || { calls: 0, rateLimited: 0, retries: 0 };
    st.rateLimited++; st.retries++; st.lastStatus = res.status; st.lastBackoffMs = backoff; st.lastAt = Date.now();
    _rlStats.set(key, st);
    _rlTotals.rateLimited++; _rlTotals.retries++; _rlTotals.lastRateLimitAt = Date.now();
    console.warn(`[groww-rl] ${res.status} on ${key} — retry ${_tries + 1}/${GROWW_MAX_RETRIES} after ${backoff}ms (retry-after=${Number.isFinite(ra) && ra > 0 ? ra + "s" : "none"})`);
    await _growwSleep(backoff);
    return growwFetch(url, init, _tries + 1);
  }
  if (res.status === 429 || res.status === 503) {
    _rlTotals.gaveUp++;
    console.warn(`[groww-rl] ${res.status} on ${key} — exhausted ${GROWW_MAX_RETRIES} retries, giving up (caller serves last-good cache)`);
  }
  return res;
}

// Chart interval -> Groww interval_in_minutes.
const INTERVAL_MIN: Record<Interval, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "1d": 1440,
};

// Max lookback Groww allows per request for each interval (days).
const MAX_DAYS: Record<number, number> = {
  1: 7,
  5: 15,
  15: 30,
  30: 45,
  60: 150,
  240: 365,
  1440: 1080,
};

/**
 * Real-time NSE data via the Groww Trade API.
 *
 * Activate by setting env vars before starting the server:
 *   DATA_PROVIDER=groww
 *   GROWW_ACCESS_TOKEN=<your daily access token from the Groww API dashboard>
 *
 * Groww Trade API is a paid add-on (~Rs 499 + tax / month). The access token is
 * generated from the Groww API portal (Access Token / API Key+secret / TOTP flow).
 */
export class GrowwProvider implements MarketDataProvider {
  readonly name = "groww";

  constructor(private token?: string) {}

  private headers(): Record<string, string> {
    if (!this.token) {
      throw new Error(
        "GROWW_ACCESS_TOKEN is not set. Subscribe to the Groww Trade API, generate an access " +
          "token, then set DATA_PROVIDER=groww and GROWW_ACCESS_TOKEN=<token> before starting."
      );
    }
    return {
      Authorization: `Bearer ${this.token}`,
      "X-API-VERSION": "1.0",
      Accept: "application/json",
    };
  }

  private def(symbol: string): SymbolDef {
    const d = findSymbolDef(symbol);
    if (d && d.nseSymbol) return d;
    // Fallback: derive the NSE trading symbol from a ".NS" equity symbol.
    if (/\.NS$/i.test(symbol)) {
      const nse = symbol.replace(/\.NS$/i, "");
      return { symbol, name: d?.name || nse, type: "equity", nseSymbol: nse };
    }
    throw new Error(`No Groww/NSE symbol mapping for "${symbol}".`);
  }

  async getCandles(symbol: string, interval: Interval, days: number): Promise<Candle[]> {
    const def = this.def(symbol);
    const mins = INTERVAL_MIN[interval];
    const cappedDays = Math.min(days, MAX_DAYS[mins] ?? days);
    const end = Math.floor(Date.now() / 1000);
    const start = end - cappedDays * 24 * 60 * 60;

    const params = new URLSearchParams({
      exchange: "NSE",
      segment: "CASH",
      trading_symbol: def.nseSymbol!,
      start_time: String(start),
      end_time: String(end),
      interval_in_minutes: String(mins),
    });

    const res = await growwFetch(`${BASE}/v1/historical/candle/range?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Groww historical ${res.status}: ${await safeText(res)}`);
    const json: any = await res.json();
    const payload = json.payload ?? json;
    const rows: any[] = payload.candles ?? [];

    // Each candle: [epochSec, open, high, low, close, volume]
    return rows
      .filter((c) => Array.isArray(c) && c[1] != null)
      .map((c) => ({
        time: Number(c[0]),
        open: round2(c[1]),
        high: round2(c[2]),
        low: round2(c[3]),
        close: round2(c[4]),
        volume: Number(c[5] ?? 0),
      }));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const def = this.def(symbol);
    const params = new URLSearchParams({
      exchange: "NSE",
      segment: "CASH",
      trading_symbol: def.nseSymbol!,
    });
    const res = await growwFetch(`${BASE}/v1/live-data/quote?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Groww quote ${res.status}: ${await safeText(res)}`);
    const json: any = await res.json();
    const q = json.payload ?? json;
    const ohlc = q.ohlc ?? {};

    const price = num(q.last_price);
    const change = num(q.day_change);
    // Groww nests OHLC; ohlc.close is the previous day's close.
    const prevClose = ohlc.close != null ? num(ohlc.close) : price - change;

    // last_trade_time may be epoch seconds or milliseconds - normalise to seconds.
    let marketTime = Math.floor(Date.now() / 1000);
    if (q.last_trade_time) {
      const t = Number(q.last_trade_time);
      marketTime = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
    }

    return {
      symbol,
      name: def.name,
      currency: "INR",
      price: round2(price),
      previousClose: round2(prevClose),
      change: round2(change),
      changePercent: round2(num(q.day_change_perc)),
      dayHigh: round2(num(ohlc.high) || price),
      dayLow: round2(num(ohlc.low) || price),
      volume: num(q.volume),
      marketTime,
    };
  }
}

// ---- F&O availability check (does this stock have options?) ----
// Cached long-term because F&O membership changes rarely (monthly at most).
const optionsCache = new Map<string, { v: boolean; ts: number }>();
export async function growwHasOptions(provider: GrowwProvider, nseSymbol: string): Promise<boolean | null> {
  const key = nseSymbol.toUpperCase();
  const hit = optionsCache.get(key);
  if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) return hit.v;
  // A non-F&O stock returns HTTP 200 with an EMPTY expiries list - that's the
  // only definitive "no options" answer. A 429/5xx/network error is transient:
  // return null (unknown) and DON'T cache it, so a rate-limit blip never
  // permanently mislabels an F&O stock as cash-only. One short retry included.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await growwFetch(
        `${BASE}/v1/historical/expiries?exchange=NSE&underlying_symbol=${encodeURIComponent(nseSymbol)}`,
        { headers: (provider as any).headers() }
      );
      if (res.ok) {
        const j: any = await res.json();
        const v = Array.isArray(j.payload?.expiries) && j.payload.expiries.length > 0;
        optionsCache.set(key, { v, ts: Date.now() });
        return v;
      }
      // 404 also means the underlying has no F&O -> definitive.
      if (res.status === 404) {
        optionsCache.set(key, { v: false, ts: Date.now() });
        return false;
      }
    } catch {
      /* transient - fall through to retry / unknown */
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
  }
  return null; // unknown - not cached, will be re-checked next scan
}

// ---- Full option chain for a CHOSEN expiry (0 = current, 1 = next, ...) ----
// Returns the expiries list + raw per-strike OI/LTP/volume so the OI-chain view
// can show current vs next-expiry build-up.
export async function growwChainForExpiry(provider: GrowwProvider, def: SymbolDef, expiryOffset = 0): Promise<any> {
  if (!def.nseSymbol) return { available: false, message: "No NSE symbol." };
  const h = (provider as any).headers();
  const eRes = await growwFetch(
    `${BASE}/v1/historical/expiries?exchange=NSE&underlying_symbol=${encodeURIComponent(def.nseSymbol)}`,
    { headers: h }
  );
  if (!eRes.ok) return { available: false, message: `expiries ${eRes.status}` };
  const eJson: any = await eRes.json();
  const all: string[] = eJson.payload?.expiries || [];
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const future = all.filter((e) => e >= today);
  const list = future.length ? future : all;
  if (!list.length) return { available: false, message: "No expiries." };
  const idx = Math.max(0, Math.min(expiryOffset, list.length - 1));
  const expiry = list[idx];
  let ocRes = await growwFetch(
    `${BASE}/v1/option-chain/exchange/NSE/underlying/${encodeURIComponent(def.nseSymbol)}?expiry_date=${expiry}`,
    { headers: h }
  );
  if (!ocRes.ok) {
    await new Promise((r) => setTimeout(r, 400));
    ocRes = await growwFetch(
      `${BASE}/v1/option-chain/exchange/NSE/underlying/${encodeURIComponent(def.nseSymbol)}?expiry_date=${expiry}`,
      { headers: h }
    );
  }
  if (!ocRes.ok) return { available: false, message: `chain ${ocRes.status}` };
  const p = ((await ocRes.json()) as any).payload || {};
  const spot = Number(p.underlying_ltp) || 0;
  const map = p.strikes || {};
  const strikes = Object.keys(map)
    .map((k) => {
      const v = map[k];
      return {
        strike: Number(k),
        ceOi: Number(v?.CE?.open_interest) || 0,
        peOi: Number(v?.PE?.open_interest) || 0,
        ceLtp: v?.CE?.ltp != null ? Number(v.CE.ltp) : null,
        peLtp: v?.PE?.ltp != null ? Number(v.PE.ltp) : null,
        ceVol: v?.CE?.volume != null ? Number(v.CE.volume) : (v?.CE?.traded_volume != null ? Number(v.CE.traded_volume) : null),
        peVol: v?.PE?.volume != null ? Number(v.PE.volume) : (v?.PE?.traded_volume != null ? Number(v.PE.traded_volume) : null),
      };
    })
    .sort((a, b) => a.strike - b.strike);
  if (!strikes.length || !spot) return { available: false, message: "Empty chain." };
  return { available: true, expiries: list, expiry, expiryIdx: idx, spot, strikes };
}

// ---- Zero-Hero (deep-OTM expiry lottery) analysis for an index ----
// Uses the ATM straddle as the expected move and each option's DELTA as the
// honest probability of finishing in-the-money. Zero-hero = far-OTM cheap option
// that multiplies on a big move but usually expires worthless.
export async function growwZeroHero(provider: GrowwProvider, def: SymbolDef): Promise<any> {
  if (!def.nseSymbol) return { available: false, message: "No NSE symbol." };
  const h = (provider as any).headers();
  try {
    const eRes = await growwFetch(
      `${BASE}/v1/historical/expiries?exchange=NSE&underlying_symbol=${encodeURIComponent(def.nseSymbol)}`,
      { headers: h }
    );
    if (!eRes.ok) return { available: false, message: `expiries ${eRes.status}` };
    const eJson: any = await eRes.json();
    const expiries: string[] = eJson.payload?.expiries || [];
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const expiry = expiries.find((e) => e >= today) || expiries[0];
    if (!expiry) return { available: false, message: "No expiry." };

    let ocRes = await growwFetch(
      `${BASE}/v1/option-chain/exchange/NSE/underlying/${encodeURIComponent(def.nseSymbol)}?expiry_date=${expiry}`,
      { headers: h }
    );
    if (!ocRes.ok) {
      // one retry (transient rate-limit under load)
      await new Promise((r) => setTimeout(r, 400));
      ocRes = await growwFetch(
        `${BASE}/v1/option-chain/exchange/NSE/underlying/${encodeURIComponent(def.nseSymbol)}?expiry_date=${expiry}`,
        { headers: h }
      );
    }
    if (!ocRes.ok) return { available: false, message: `chain ${ocRes.status}` };
    const p = ((await ocRes.json()) as any).payload || {};
    const spot = num(p.underlying_ltp) || 0;
    const map = p.strikes || {};
    const rows = Object.keys(map)
      .map((k) => {
        const v = map[k];
        return {
          strike: Number(k),
          ceLtp: v?.CE?.ltp != null ? Number(v.CE.ltp) : null,
          peLtp: v?.PE?.ltp != null ? Number(v.PE.ltp) : null,
          ceVol: v?.CE?.volume != null ? Number(v.CE.volume) : (v?.CE?.traded_volume != null ? Number(v.CE.traded_volume) : null),
          peVol: v?.PE?.volume != null ? Number(v.PE.volume) : (v?.PE?.traded_volume != null ? Number(v.PE.traded_volume) : null),
          ceDelta: v?.CE?.greeks?.delta != null ? Number(v.CE.greeks.delta) : null,
          peDelta: v?.PE?.greeks?.delta != null ? Number(v.PE.greeks.delta) : null,
          ceOi: Number(v?.CE?.open_interest) || 0,
          peOi: Number(v?.PE?.open_interest) || 0,
        };
      })
      .sort((a, b) => a.strike - b.strike);
    if (!rows.length || !spot) return { available: false, message: "Empty chain." };

    const dte = Math.max(0, Math.ceil((Date.parse(expiry) - Date.now()) / 86400000));
    // ATM straddle = expected remaining move to expiry.
    const atm = rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), rows[0]);
    const straddle = (atm.ceLtp ?? 0) + (atm.peLtp ?? 0);
    const expMove = straddle > 0 ? straddle : spot * 0.006;

    // PCR bias.
    const totCe = rows.reduce((s, r) => s + r.ceOi, 0);
    const totPe = rows.reduce((s, r) => s + r.peOi, 0);
    const pcr = totCe > 0 ? Math.round((totPe / totCe) * 100) / 100 : null;
    const bias = pcr == null ? "Neutral" : pcr >= 1.15 ? "Bullish" : pcr <= 0.85 ? "Bearish" : "Neutral";

    // Zero-hero strikes ~1 expected-move OTM (a full move needed = cheap lottery).
    const ceStrike = rows.find((r) => r.strike >= spot + expMove) || rows[rows.length - 1];
    const peStrike = [...rows].reverse().find((r) => r.strike <= spot - expMove) || rows[0];
    const zh = (row: any, side: "CE" | "PE") => {
      const premium = side === "CE" ? row.ceLtp : row.peLtp;
      const delta = side === "CE" ? row.ceDelta : row.peDelta;
      const dist = Math.abs(row.strike - spot);
      const reqMovePct = Math.round((dist / spot) * 1000) / 10;
      const probItm = delta != null ? Math.round(Math.abs(delta) * 100) : null; // delta ~ prob finishing ITM
      const probTouch = probItm != null ? Math.min(96, Math.round(probItm * 1.8)) : null; // ~touch odds
      const potentialX = premium && premium > 0 ? Math.round(expMove / premium) : null; // rough hero multiple
      return { strike: row.strike, premium: premium ?? null, delta: delta != null ? Math.round(delta * 100) / 100 : null, reqMovePct, probItm, probTouch, potentialX };
    };

    return {
      available: true,
      symbol: def.symbol,
      name: def.name,
      spot: Math.round(spot * 100) / 100,
      expiry,
      dte,
      straddle: Math.round(straddle * 100) / 100,
      expectedMovePts: Math.round(expMove * 100) / 100,
      expectedMovePct: Math.round((expMove / spot) * 1000) / 10,
      pcr,
      bias,
      ce: zh(ceStrike, "CE"),
      pe: zh(peStrike, "PE"),
    };
  } catch (e: any) {
    return { available: false, message: e?.message || "zero-hero failed" };
  }
}

// ---- Option chain OI / PCR analysis (real, from Groww) ----
export async function growwOiAnalysis(provider: GrowwProvider, def: SymbolDef): Promise<OiAnalysis> {
  const disclaimer =
    "Live OI from Groww option chain (nearest expiry). PCR, support/resistance and max-pain are " +
    "context - confirm with price action.";
  const fail = (msg: string): OiAnalysis => ({
    symbol: def.symbol,
    nseSymbol: def.nseSymbol || def.symbol,
    available: false,
    message: msg,
    underlying: null,
    expiry: null,
    pcr: null,
    pcrState: "neutral",
    totalCeOi: 0,
    totalPeOi: 0,
    support: null,
    resistance: null,
    maxPain: null,
    ceBuildup: "mixed",
    peBuildup: "mixed",
    verdict: { bias: "Neutral", reasons: [msg] },
    topStrikes: [],
    asOf: Math.floor(Date.now() / 1000),
    disclaimer,
  });

  if (!def.nseSymbol) return fail("No NSE symbol configured.");
  const h = (provider as any).headers();

  try {
    const eRes = await growwFetch(
      `${BASE}/v1/historical/expiries?exchange=NSE&underlying_symbol=${encodeURIComponent(def.nseSymbol)}`,
      { headers: h }
    );
    if (!eRes.ok) return fail(`Groww expiries ${eRes.status}`);
    const eJson: any = await eRes.json();
    const expiries: string[] = eJson.payload?.expiries || [];
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const expiry = expiries.find((e) => e >= today) || expiries[0];
    if (!expiry) return fail("No expiries returned.");

    const ocRes = await growwFetch(
      `${BASE}/v1/option-chain/exchange/NSE/underlying/${encodeURIComponent(def.nseSymbol)}?expiry_date=${expiry}`,
      { headers: h }
    );
    if (!ocRes.ok) return fail(`Groww option-chain ${ocRes.status}`);
    const ocJson: any = await ocRes.json();
    const p = ocJson.payload || {};
    const underlying = num(p.underlying_ltp) || null;
    const strikesMap = p.strikes || {};

    const all: OiStrike[] = Object.keys(strikesMap)
      .map((k) => {
        const v = strikesMap[k];
        return {
          strike: Number(k),
          ceOi: Number(v?.CE?.open_interest) || 0,
          peOi: Number(v?.PE?.open_interest) || 0,
          ceChg: 0,
          peChg: 0,
          ceVol: v?.CE?.volume != null ? Number(v.CE.volume) : (v?.CE?.traded_volume != null ? Number(v.CE.traded_volume) : null),
          peVol: v?.PE?.volume != null ? Number(v.PE.volume) : (v?.PE?.traded_volume != null ? Number(v.PE.traded_volume) : null),
          ceLtp: v?.CE?.ltp != null ? Number(v.CE.ltp) : null,
          peLtp: v?.PE?.ltp != null ? Number(v.PE.ltp) : null,
          ceDelta: v?.CE?.greeks?.delta != null ? Number(v.CE.greeks.delta) : null,
          peDelta: v?.PE?.greeks?.delta != null ? Number(v.PE.greeks.delta) : null,
          ceIv: v?.CE?.greeks?.iv != null ? Number(v.CE.greeks.iv) : null,
          peIv: v?.PE?.greeks?.iv != null ? Number(v.PE.greeks.iv) : null,
          ceTheta: v?.CE?.greeks?.theta != null ? Number(v.CE.greeks.theta) : null,
          peTheta: v?.PE?.greeks?.theta != null ? Number(v.PE.greeks.theta) : null,
        };
      })
      .sort((a, b) => a.strike - b.strike);
    if (!all.length) return fail("Empty option chain.");

    const totalCeOi = all.reduce((s, x) => s + x.ceOi, 0);
    const totalPeOi = all.reduce((s, x) => s + x.peOi, 0);
    const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;

    let support = all[0];
    let resistance = all[0];
    for (const x of all) {
      if (x.peOi > support.peOi) support = x;
      if (x.ceOi > resistance.ceOi) resistance = x;
    }

    let maxPain: number | null = null;
    let minPain = Infinity;
    for (const k of all) {
      let pain = 0;
      for (const x of all) {
        if (x.strike < k.strike) pain += x.ceOi * (k.strike - x.strike);
        if (x.strike > k.strike) pain += x.peOi * (x.strike - k.strike);
      }
      if (pain < minPain) { minPain = pain; maxPain = k.strike; }
    }

    const atm = underlying != null
      ? all.reduce((pv, c) => (Math.abs(c.strike - underlying) < Math.abs(pv.strike - underlying) ? c : pv), all[0])
      : all[Math.floor(all.length / 2)];
    const atmIdx = all.indexOf(atm);
    // ±12 strikes around ATM: enough for OTM strangle (~0.2 delta) + condor wings.
    const topStrikes = all.slice(Math.max(0, atmIdx - 12), atmIdx + 13);

    const reasons: string[] = [];
    let score = 0;
    if (pcr != null) {
      if (pcr >= 1.2) { score += 1; reasons.push(`PCR ${pcr.toFixed(2)} - put writing (support building, bullish lean)`); }
      else if (pcr <= 0.7) { score -= 1; reasons.push(`PCR ${pcr.toFixed(2)} - call writing (resistance building, bearish lean)`); }
      else reasons.push(`PCR ${pcr.toFixed(2)} - balanced`);
    }
    reasons.push(`Max PUT OI at ${support.strike} (support)`);
    reasons.push(`Max CALL OI at ${resistance.strike} (resistance)`);
    if (maxPain != null) reasons.push(`Max pain ${maxPain}`);

    const bias: OiAnalysis["verdict"]["bias"] = score >= 1 ? "Bullish" : score <= -1 ? "Bearish" : "Neutral";
    const pcrState: OiAnalysis["pcrState"] = pcr == null ? "neutral" : pcr >= 1.2 ? "bullish" : pcr <= 0.7 ? "bearish" : "neutral";

    // Futures OI day-change -> buildup type (genuine move vs bluff).
    let futOi: number | null = null;
    let futOiChangePct: number | null = null;
    let futBuildup: OiAnalysis["futBuildup"] = null;
    try {
      const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const futSym = `${def.nseSymbol}${expiry.slice(2, 4)}${MON[Number(expiry.slice(5, 7)) - 1]}FUT`;
      const fRes = await growwFetch(
        `${BASE}/v1/live-data/quote?exchange=NSE&segment=FNO&trading_symbol=${encodeURIComponent(futSym)}`,
        { headers: h }
      );
      if (fRes.ok) {
        const fq: any = await fRes.json();
        const fp = fq.payload || {};
        futOi = fp.open_interest != null ? Number(fp.open_interest) : null;
        futOiChangePct = fp.oi_day_change_percentage != null ? Math.round(Number(fp.oi_day_change_percentage) * 100) / 100 : null;
        const oiChg = Number(fp.oi_day_change) || 0;
        const priceChg = Number(fp.day_change) || 0;
        if (priceChg === 0 || oiChg === 0) futBuildup = "—";
        else if (priceChg > 0 && oiChg > 0) futBuildup = "Long buildup";
        else if (priceChg < 0 && oiChg > 0) futBuildup = "Short buildup";
        else if (priceChg > 0 && oiChg < 0) futBuildup = "Short covering";
        else futBuildup = "Long unwinding";
      }
    } catch {
      /* futures OI optional */
    }

    return {
      symbol: def.symbol,
      nseSymbol: def.nseSymbol,
      available: true,
      underlying,
      expiry,
      futOi,
      futOiChangePct,
      futBuildup,
      pcr: pcr != null ? Math.round(pcr * 100) / 100 : null,
      pcrState,
      totalCeOi,
      totalPeOi,
      support: support.strike,
      resistance: resistance.strike,
      maxPain,
      ceBuildup: "mixed",
      peBuildup: "mixed",
      verdict: { bias, reasons },
      topStrikes,
      asOf: Math.floor(Date.now() / 1000),
      disclaimer,
    };
  } catch (e: any) {
    return fail("Groww OI error: " + (e?.message || e));
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function num(v: any): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(Number(n) * 100) / 100;
}

// ---- Historical candles for an OPTION instrument (FNO segment) ----
// Used by the option trade back-test. `tradingSymbol` is the exact option symbol
// from the instruments master (e.g. BANKNIFTY26NOV46400PE). start/end are epoch
// seconds; intervalMin is 1/5/15 etc. Returns [] if no candles.
export async function growwOptionCandles(
  provider: GrowwProvider,
  tradingSymbol: string,
  startEpoch: number,
  endEpoch: number,
  intervalMin = 5,
): Promise<Candle[]> {
  const h = (provider as any).headers();
  const params = new URLSearchParams({
    exchange: "NSE",
    segment: "FNO",
    trading_symbol: tradingSymbol,
    start_time: String(startEpoch),
    end_time: String(endEpoch),
    interval_in_minutes: String(intervalMin),
  });
  let res = await growwFetch(`${BASE}/v1/historical/candle/range?${params}`, { headers: h });
  if (!res.ok) {
    await new Promise((r) => setTimeout(r, 400));
    res = await growwFetch(`${BASE}/v1/historical/candle/range?${params}`, { headers: h });
  }
  if (!res.ok) throw new Error(`Groww option history ${res.status}: ${await safeText(res)}`);
  const json: any = await res.json();
  const payload = json.payload ?? json;
  const rows: any[] = payload.candles ?? [];
  return rows
    .filter((c) => Array.isArray(c) && c[1] != null)
    .map((c) => ({
      time: Number(c[0]),
      open: round2(c[1]),
      high: round2(c[2]),
      low: round2(c[3]),
      close: round2(c[4]),
      volume: Number(c[5] ?? 0),
    }));
}

// ---- Historical candles for an underlying (CASH segment) over an epoch range ----
// Like getCandles but for an explicit [start,end] window (needed to back-test a
// specific past date). `nseSymbol` is the equity/index NSE symbol (e.g. NIFTY).
export async function growwSpotCandles(
  provider: GrowwProvider,
  nseSymbol: string,
  startEpoch: number,
  endEpoch: number,
  intervalMin = 5,
): Promise<Candle[]> {
  const h = (provider as any).headers();
  const params = new URLSearchParams({
    exchange: "NSE",
    segment: "CASH",
    trading_symbol: nseSymbol,
    start_time: String(startEpoch),
    end_time: String(endEpoch),
    interval_in_minutes: String(intervalMin),
  });
  let res = await growwFetch(`${BASE}/v1/historical/candle/range?${params}`, { headers: h });
  if (!res.ok) {
    await new Promise((r) => setTimeout(r, 400));
    res = await growwFetch(`${BASE}/v1/historical/candle/range?${params}`, { headers: h });
  }
  if (!res.ok) throw new Error(`Groww spot history ${res.status}: ${await safeText(res)}`);
  const json: any = await res.json();
  const payload = json.payload ?? json;
  const rows: any[] = payload.candles ?? [];
  return rows
    .filter((c) => Array.isArray(c) && c[1] != null)
    .map((c) => ({
      time: Number(c[0]),
      open: round2(c[1]),
      high: round2(c[2]),
      low: round2(c[3]),
      close: round2(c[4]),
      volume: Number(c[5] ?? 0),
    }));
}
