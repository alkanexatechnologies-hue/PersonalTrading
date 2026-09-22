// ---- Dhan as the SINGLE live market-data source ----
// Replaces GrowwProvider for all live + historical data: candles, quotes,
// option chains, OI analysis, zero-hero. No order-placement APIs are used.
// All calls go through dhanClient.ts's safety-gated allowlist.

import { MarketDataProvider } from "./provider";
import { Candle, Interval, Quote, OiAnalysis, OiStrike } from "../types";
import { findSymbolDef, SymbolDef } from "../config";
import { loadDhanConfig } from "./dhanConfig";
import { dhanFetch } from "./dhanClient";
import { lookupDhanSecurity, DhanSecurity } from "./dhanInstruments";
import { fetchDhanCandles, DhanBacktestInterval } from "./dhanHistorical";
import { CONFIG } from "../config/arbitration";

const round2 = (n: number) => Math.round(Number(n) * 100) / 100;
const num = (v: any): number => { const n = Number(v); return isFinite(n) ? n : 0; };

// ---- Rate-limit telemetry (mirrors Groww's pattern for /api/dhan/ratelimit-stats) ----
const _rlTotals = { calls: 0, errors: 0, lastAt: 0 };
export function dhanRateLimitStats() {
  return { totals: { ..._rlTotals } };
}

// ---- Dhan interval mapping ----
const INTERVAL_MAP: Record<Interval, DhanBacktestInterval | null> = {
  "1m": null,  // Dhan has no 1-minute data
  "5m": "5",
  "15m": "15",
  "30m": "15", // resample 15m → 30m
  "60m": "60",
  "1d": "1d",
};

// ---- Status / health tracking ----
let _lastOk = 0;
let _lastFail = 0;
let _lastFailMsg = "";
export function recordDhanOk() { _lastOk = Date.now(); }
export function recordDhanFail(msg = "") { _lastFail = Date.now(); _lastFailMsg = msg; }
export function getDhanHealth() {
  return {
    lastOk: _lastOk,
    lastFail: _lastFail,
    lastFailMsg: _lastFailMsg,
    okAgoMs: _lastOk ? Date.now() - _lastOk : null,
    failAgoMs: _lastFail ? Date.now() - _lastFail : null,
  };
}

// ---- Helper: Dhan JSON fetch (POST with body or GET) ----
async function dhanJson(path: string, body?: Record<string, unknown>): Promise<any> {
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) throw new Error("Dhan not connected — paste an access token first.");
  _rlTotals.calls++;
  _rlTotals.lastAt = Date.now();
  const res = await dhanFetch(path, {
    method: body ? "POST" : "GET",
    body,
    accessToken: cfg.accessToken,
    clientId: cfg.clientId,
  });
  if (!res.ok) {
    _rlTotals.errors++;
    const t = await res.text().catch(() => "");
    throw new Error(`Dhan ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ---- DhanProvider class ----
export class DhanProvider implements MarketDataProvider {
  readonly name = "dhan";

  private def(symbol: string): SymbolDef {
    const d = findSymbolDef(symbol);
    if (d && d.nseSymbol) return d;
    if (/\.NS$/i.test(symbol)) {
      const nse = symbol.replace(/\.NS$/i, "");
      return { symbol, name: d?.name || nse, type: "equity", nseSymbol: nse };
    }
    throw new Error(`No Dhan/NSE symbol mapping for "${symbol}".`);
  }

  async getCandles(symbol: string, interval: Interval, days: number): Promise<Candle[]> {
    const def = this.def(symbol);
    const nse = def.nseSymbol!;
    const sec = await lookupDhanSecurity(nse);
    if (!sec) throw new Error(`No Dhan security for "${nse}".`);

    const dhanInterval = INTERVAL_MAP[interval];
    if (!dhanInterval) {
      // 1m not available — fall back to 5m
      return this.getCandles(symbol, "5m", days);
    }

    const toDate = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const fromD = new Date(Date.now() + 19800000 - days * 86400000);
    const fromDate = fromD.toISOString().slice(0, 10);

    let candles = await fetchDhanCandles(sec, dhanInterval, fromDate, toDate);

    // Resample 15m → 30m if requested
    if (interval === "30m" && dhanInterval === "15") {
      candles = resample(candles, 2);
    }

    recordDhanOk();
    return candles;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const def = this.def(symbol);
    const nse = def.nseSymbol!;
    const sec = await lookupDhanSecurity(nse);
    if (!sec) throw new Error(`No Dhan security for "${nse}".`);

    // Use market feed OHLC endpoint for a full quote
    const segKey = sec.exchangeSegment; // "IDX_I" or "NSE_EQ"
    const body: Record<string, unknown> = { [segKey]: [Number(sec.securityId)] };

    const json = await dhanJson("/marketfeed/ohlc", body);
    const data = json?.data?.[segKey]?.[sec.securityId];
    if (!data) throw new Error(`No Dhan quote data for ${nse}`);

    const ohlc = data.ohlc || {};
    const price = round2(num(data.last_price ?? data.LTP ?? data.ltp));
    const open = num(ohlc.open ?? data.open ?? 0);
    const high = num(ohlc.high ?? data.high ?? price);
    const low = num(ohlc.low ?? data.low ?? price);
    const close = num(ohlc.close ?? data.close ?? data.prev_close ?? 0);
    const volume = num(data.volume ?? data.Volume ?? 0);
    const change = round2(price - close);
    const changePct = close > 0 ? round2((change / close) * 100) : 0;

    // Dhan market feed may include last_traded_time as epoch
    let marketTime = 0;
    const t = Number(data.last_traded_time ?? data.exchange_time ?? 0);
    if (Number.isFinite(t) && t > 0) marketTime = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);

    recordDhanOk();
    return {
      symbol,
      name: def.name,
      currency: "INR",
      price,
      previousClose: round2(close),
      change,
      changePercent: changePct,
      dayHigh: round2(high || price),
      dayLow: round2(low || price),
      volume,
      marketTime,
    };
  }
}

// ---- India VIX (live) ----
// India VIX is the IDX_I instrument with Dhan security id 21. It measures the
// expected NIFTY volatility over the next ~30 days; it does NOT indicate market
// direction. Returned value carries the provider's own last-traded time so
// freshness can be judged (never Date.now-as-data).
const INDIA_VIX_SECID = 21;
export interface IndiaVix {
  available: boolean;
  value: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  ts: number | null;      // provider timestamp (epoch sec), when available
  message?: string;
}

export async function getIndiaVix(): Promise<IndiaVix> {
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) return { available: false, value: null, prevClose: null, change: null, changePct: null, dayHigh: null, dayLow: null, ts: null, message: "Dhan not connected" };
  try {
    const json = await dhanJson("/marketfeed/ohlc", { IDX_I: [INDIA_VIX_SECID] });
    const data = json?.data?.IDX_I?.[INDIA_VIX_SECID] ?? json?.data?.IDX_I?.[String(INDIA_VIX_SECID)];
    if (!data) return { available: false, value: null, prevClose: null, change: null, changePct: null, dayHigh: null, dayLow: null, ts: null, message: "No India VIX in feed" };
    const ohlc = data.ohlc || {};
    const value = round2(num(data.last_price ?? data.LTP ?? data.ltp));
    const prevClose = round2(num(ohlc.close ?? data.prev_close ?? 0));
    const change = prevClose > 0 ? round2(value - prevClose) : null;
    const changePct = prevClose > 0 ? round2(((value - prevClose) / prevClose) * 100) : null;
    let ts: number | null = null;
    const t = Number(data.last_traded_time ?? data.exchange_time ?? 0);
    if (Number.isFinite(t) && t > 0) ts = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
    recordDhanOk();
    return { available: value > 0, value: value > 0 ? value : null, prevClose: prevClose > 0 ? prevClose : null, change, changePct, dayHigh: round2(num(ohlc.high)) || null, dayLow: round2(num(ohlc.low)) || null, ts };
  } catch (e: any) {
    recordDhanFail(e?.message);
    return { available: false, value: null, prevClose: null, change: null, changePct: null, dayHigh: null, dayLow: null, ts: null, message: e?.message || "vix failed" };
  }
}

// ---- Resample candles (group every N bars into one) ----
function resample(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    if (!chunk.length) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

// ---- F&O availability check ----
const optionsCache = new Map<string, { v: boolean; ts: number }>();
export async function dhanHasOptions(nseSymbol: string): Promise<boolean | null> {
  const key = nseSymbol.toUpperCase();
  const hit = optionsCache.get(key);
  if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) return hit.v;
  try {
    const cfg = loadDhanConfig();
    if (!cfg.accessToken) return null;
    const res = await dhanFetch(`/option/chain?UnderlyingScrip=${encodeURIComponent(key)}&ExpiryDate=`, {
      method: "GET",
      accessToken: cfg.accessToken,
    });
    if (res.ok) {
      const j: any = await res.json();
      const v = j?.data && Object.keys(j.data).length > 0;
      optionsCache.set(key, { v: !!v, ts: Date.now() });
      return !!v;
    }
    if (res.status === 404 || res.status === 400) {
      optionsCache.set(key, { v: false, ts: Date.now() });
      return false;
    }
  } catch { /* transient */ }
  return null;
}

// ---- Get expiry list for an underlying ----
async function getExpiries(nseSymbol: string): Promise<string[]> {
  try {
    const cfg = loadDhanConfig();
    if (!cfg.accessToken) return [];
    const res = await dhanFetch(`/option/chain?UnderlyingScrip=${encodeURIComponent(nseSymbol)}`, {
      method: "GET",
      accessToken: cfg.accessToken,
    });
    if (!res.ok) return [];
    const j: any = await res.json();
    // Dhan option chain returns expiry list and chain data together
    const expiries: string[] = j?.expiryList || j?.expiry_list || [];
    return expiries.sort();
  } catch {
    return [];
  }
}

// ---- Full option chain for a CHOSEN expiry ----
export async function dhanChainForExpiry(def: SymbolDef, expiryOffset = 0): Promise<any> {
  if (!def.nseSymbol) return { available: false, message: "No NSE symbol." };
  try {
    const cfg = loadDhanConfig();
    if (!cfg.accessToken) return { available: false, message: "Dhan not connected." };

    // First get the underlying's security ID for the option chain
    const sec = await lookupDhanSecurity(def.nseSymbol);
    if (!sec) return { available: false, message: `No Dhan security for ${def.nseSymbol}` };
    // Dhan v2 option-chain underlying segment: indices use IDX_I, F&O stocks NSE_FNO.
    const underlyingSeg = sec.exchangeSegment === "IDX_I" ? "IDX_I" : "NSE_FNO";
    const scrip = Number(sec.securityId);

    // Expiry list — Dhan v2: POST /optionchain/expirylist { UnderlyingScrip, UnderlyingSeg }
    const elRes = await dhanFetch("/optionchain/expirylist", {
      method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
      body: { UnderlyingScrip: scrip, UnderlyingSeg: underlyingSeg },
    });
    if (!elRes.ok) return { available: false, message: `expirylist ${elRes.status}` };
    const elJson: any = await elRes.json();
    const allExpiries: string[] = Array.isArray(elJson?.data) ? elJson.data : [];
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const future = allExpiries.filter((e: string) => e >= today);
    const list = future.length ? future : allExpiries;
    if (!list.length) return { available: false, message: "No expiries." };

    const idx = Math.max(0, Math.min(expiryOffset, list.length - 1));
    const expiry = list[idx];

    // Chain — Dhan v2: POST /optionchain { UnderlyingScrip, UnderlyingSeg, Expiry }
    // (rate-limited to ~1 req / 3s by Dhan; callers cache it).
    const chainRes = await dhanFetch("/optionchain", {
      method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
      body: { UnderlyingScrip: scrip, UnderlyingSeg: underlyingSeg, Expiry: expiry },
    });
    if (!chainRes.ok) return { available: false, message: `chain ${chainRes.status}` };
    const chainData: any = await chainRes.json();

    // Parse Dhan's oc map: { "<strike>": { ce:{...}, pe:{...} } }. Each leg carries
    // last_price, oi, previous_oi, volume, implied_volatility and greeks{delta,theta}.
    const spot = num(chainData?.data?.last_price ?? chainData?.data?.underlyingLTP ?? 0);
    const oc = chainData?.data?.oc || {};
    const nOrNull = (v: any): number | null => { const n = Number(v); return isFinite(n) ? n : null; };
    const ltpOrNull = (v: any): number | null => { const n = Number(v); return isFinite(n) && n > 0 ? n : null; };
    const strikes = Object.entries(oc).map(([k, v]: [string, any]) => {
      const ce = v?.ce || {}, pe = v?.pe || {};
      return {
        strike: num(k),
        ceOi: num(ce.oi), peOi: num(pe.oi),
        ceChg: num(ce.oi) - num(ce.previous_oi), peChg: num(pe.oi) - num(pe.previous_oi),
        ceVol: nOrNull(ce.volume), peVol: nOrNull(pe.volume),
        ceLtp: ltpOrNull(ce.last_price), peLtp: ltpOrNull(pe.last_price),
        ceDelta: nOrNull(ce.greeks?.delta), peDelta: nOrNull(pe.greeks?.delta),
        ceIv: nOrNull(ce.implied_volatility), peIv: nOrNull(pe.implied_volatility),
        ceTheta: nOrNull(ce.greeks?.theta), peTheta: nOrNull(pe.greeks?.theta),
        // gamma/vega if the feed carries them (Dhan greeks object) — else null.
        ceGamma: nOrNull(ce.greeks?.gamma), peGamma: nOrNull(pe.greeks?.gamma),
        ceVega: nOrNull(ce.greeks?.vega), peVega: nOrNull(pe.greeks?.vega),
      };
    }).filter((s: any) => s.strike > 0).sort((a: any, b: any) => a.strike - b.strike);

    if (!strikes.length || !spot) return { available: false, message: "Empty chain." };
    recordDhanOk();
    return { available: true, expiries: list, expiry, expiryIdx: idx, spot, strikes };
  } catch (e: any) {
    recordDhanFail(e?.message);
    return { available: false, message: e?.message || "chain failed" };
  }
}

// ---- Zero-Hero analysis ----
export async function dhanZeroHero(def: SymbolDef): Promise<any> {
  const chain = await dhanChainForExpiry(def, 0);
  if (!chain.available) return chain;

  const { spot, expiry, strikes: rows } = chain;
  const dte = Math.max(0, Math.ceil((Date.parse(expiry) - Date.now()) / 86400000));

  // ATM straddle = expected remaining move to expiry
  const atm = rows.reduce((b: any, r: any) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), rows[0]);
  const straddle = (atm.ceLtp ?? 0) + (atm.peLtp ?? 0);
  const expMove = straddle > 0 ? straddle : spot * 0.006;

  // PCR
  const totCe = rows.reduce((s: number, r: any) => s + r.ceOi, 0);
  const totPe = rows.reduce((s: number, r: any) => s + r.peOi, 0);
  const pcr = totCe > 0 ? Math.round((totPe / totCe) * 100) / 100 : null;
  const bias = pcr == null ? "Neutral" : pcr >= 1.15 ? "Bullish" : pcr <= 0.85 ? "Bearish" : "Neutral";

  // Zero-hero strikes ~1 expected-move OTM
  const ceStrike = rows.find((r: any) => r.strike >= spot + expMove) || rows[rows.length - 1];
  const peStrike = [...rows].reverse().find((r: any) => r.strike <= spot - expMove) || rows[0];
  const zh = (row: any, side: "CE" | "PE") => {
    const premium = side === "CE" ? row.ceLtp : row.peLtp;
    const dist = Math.abs(row.strike - spot);
    const reqMovePct = Math.round((dist / spot) * 1000) / 10;
    const potentialX = premium && premium > 0 ? Math.round(expMove / premium) : null;
    return { strike: row.strike, premium: premium ?? null, delta: null, reqMovePct, probItm: null, probTouch: null, potentialX };
  };

  return {
    available: true,
    symbol: def.symbol,
    name: def.name,
    spot: round2(spot),
    expiry,
    dte,
    straddle: round2(straddle),
    expectedMovePts: round2(expMove),
    expectedMovePct: Math.round((expMove / spot) * 1000) / 10,
    pcr,
    bias,
    ce: zh(ceStrike, "CE"),
    pe: zh(peStrike, "PE"),
  };
}

// ---- Option chain OI / PCR analysis ----
export async function dhanOiAnalysis(def: SymbolDef): Promise<OiAnalysis> {
  const disclaimer =
    "Live OI from Dhan option chain (nearest expiry). PCR, support/resistance and max-pain are " +
    "context — confirm with price action.";
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

  try {
    const chain = await dhanChainForExpiry(def, 0);
    if (!chain.available) return fail(chain.message || "Dhan chain unavailable");

    const underlying = chain.spot;
    const expiry = chain.expiry;
    const all: OiStrike[] = chain.strikes.map((s: any) => ({
      strike: s.strike,
      ceOi: s.ceOi,
      peOi: s.peOi,
      ceChg: s.ceChg ?? 0,
      peChg: s.peChg ?? 0,
      ceVol: s.ceVol ?? null,
      peVol: s.peVol ?? null,
      ceLtp: s.ceLtp ?? null,
      peLtp: s.peLtp ?? null,
      ceDelta: s.ceDelta ?? null,
      peDelta: s.peDelta ?? null,
      ceIv: s.ceIv ?? null,
      peIv: s.peIv ?? null,
      ceTheta: s.ceTheta ?? null,
      peTheta: s.peTheta ?? null,
      ceGamma: s.ceGamma ?? null,
      peGamma: s.peGamma ?? null,
      ceVega: s.ceVega ?? null,
      peVega: s.peVega ?? null,
    }));

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
    const topStrikes = all.slice(Math.max(0, atmIdx - 12), atmIdx + 13);

    const reasons: string[] = [];
    let score = 0;
    if (pcr != null) {
      if (pcr >= CONFIG.pcr.bullish) { score += 1; reasons.push(`PCR ${pcr.toFixed(2)} — put writing (support building, bullish lean)`); }
      else if (pcr <= CONFIG.pcr.bearish) { score -= 1; reasons.push(`PCR ${pcr.toFixed(2)} — call writing (resistance building, bearish lean)`); }
      else reasons.push(`PCR ${pcr.toFixed(2)} — balanced`);
    }
    reasons.push(`Max PUT OI at ${support.strike} (support)`);
    reasons.push(`Max CALL OI at ${resistance.strike} (resistance)`);
    if (maxPain != null) reasons.push(`Max pain ${maxPain}`);

    const bias: OiAnalysis["verdict"]["bias"] = score >= 1 ? "Bullish" : score <= -1 ? "Bearish" : "Neutral";
    const pcrState: OiAnalysis["pcrState"] = pcr == null ? "neutral" : pcr >= CONFIG.pcr.bullish ? "bullish" : pcr <= CONFIG.pcr.bearish ? "bearish" : "neutral";

    return {
      symbol: def.symbol,
      nseSymbol: def.nseSymbol,
      available: true,
      underlying,
      expiry,
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
    recordDhanFail(e?.message);
    return fail("Dhan OI error: " + (e?.message || e));
  }
}

// ---- Historical candles for an OPTION instrument ----
// Uses Dhan intraday endpoint for option contracts.
export async function dhanOptionCandles(
  optionSecurityId: string,
  startEpoch: number,
  endEpoch: number,
  intervalMin = 5,
): Promise<Candle[]> {
  const fromDate = new Date((startEpoch - 86400) * 1000).toISOString().slice(0, 10);
  const toDate = new Date((endEpoch + 86400) * 1000).toISOString().slice(0, 10);
  const interval = String(intervalMin) as DhanBacktestInterval;
  const sec: DhanSecurity = {
    securityId: optionSecurityId,
    exchangeSegment: "NSE_EQ", // options are NSE_FO but we'll try
    instrument: "EQUITY",
  };
  // For options, Dhan uses NSE_FO segment
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) throw new Error("Dhan not connected.");
  const res = await dhanFetch("/charts/intraday", {
    method: "POST",
    body: {
      securityId: optionSecurityId,
      exchangeSegment: "NSE_FO",
      instrument: "OPTIDX",
      interval: Number(intervalMin),
      fromDate,
      toDate,
    },
    accessToken: cfg.accessToken,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Dhan option history ${res.status}: ${t.slice(0, 200)}`);
  }
  const payload = await res.json();
  return toCandles(payload).filter(c => c.time >= startEpoch && c.time <= endEpoch);
}

// ---- Historical candles for underlying spot (CASH/INDEX) over epoch range ----
export async function dhanSpotCandles(
  nseSymbol: string,
  startEpoch: number,
  endEpoch: number,
  intervalMin = 5,
): Promise<Candle[]> {
  const sec = await lookupDhanSecurity(nseSymbol);
  if (!sec) throw new Error(`No Dhan security for "${nseSymbol}".`);
  const fromDate = new Date((startEpoch - 86400) * 1000).toISOString().slice(0, 10);
  const toDate = new Date((endEpoch + 86400) * 1000).toISOString().slice(0, 10);
  const interval = intervalMin <= 5 ? "5" : intervalMin <= 15 ? "15" : "60";
  const candles = await fetchDhanCandles(sec, interval as DhanBacktestInterval, fromDate, toDate);
  return candles.filter(c => c.time >= startEpoch && c.time <= endEpoch);
}

// ---- Convert Dhan parallel-array response to Candle[] ----
function toCandles(payload: any): Candle[] {
  const open: number[] = payload?.open || [];
  const high: number[] = payload?.high || [];
  const low: number[] = payload?.low || [];
  const close: number[] = payload?.close || [];
  const volume: number[] = payload?.volume || [];
  const timestamp: number[] = payload?.timestamp || [];
  const n = Math.min(open.length, high.length, low.length, close.length, timestamp.length);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ time: timestamp[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] ?? 0 });
  }
  return out;
}
