// ============================ Index FUTURES price + open interest (Dhan) — the live derivatives confirmation ============================
// Near-month index future of NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY (NSE_FNO) or SENSEX (BSE_FNO) from Dhan's scrip master;
// live price + OI from /marketfeed/quote; the previous sessions' closing OI from /charts/historical (oi: true).
// Price × OI change (standard reading, futures only — never the option chain):
//   price ↑ OI ↑ LONG BUILDUP · price ↓ OI ↑ SHORT BUILDUP · price ↑ OI ↓ SHORT COVERING · price ↓ OI ↓ LONG UNWINDING
// A change smaller than the noise band (0.05 % price, 0.5 % OI) is "UNCHANGED"; missing data → null, never guessed.
// Units: OI in CONTRACTS as Dhan reports it for the contract (no lot conversion, no mixing with NSE participant figures).
import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import { lookupDhanIndexFuture } from "../data/dhanInstruments";

export type PriceOi = "LONG BUILDUP" | "SHORT BUILDUP" | "SHORT COVERING" | "LONG UNWINDING" | "UNCHANGED";
/** Classify a price change (points) and an OI change (contracts) against their reference values. */
export function classifyPriceOi(priceChg: number, price: number, oiChg: number, oiRef: number): PriceOi {
  const p = Math.abs(priceChg) / Math.max(1, price) >= 0.0005 ? Math.sign(priceChg) : 0, q = Math.abs(oiChg) / Math.max(1, oiRef) >= 0.005 ? Math.sign(oiChg) : 0;
  if (p === 0 || q === 0) return "UNCHANGED";
  return p > 0 ? (q > 0 ? "LONG BUILDUP" : "SHORT COVERING") : q > 0 ? "SHORT BUILDUP" : "LONG UNWINDING";
}

export interface FuturesSnapshot {
  available: boolean; reason?: string; underlying: string; expiry?: string; securityId?: string; segment?: string;
  price?: number | null; prevClose?: number | null; oi?: number | null; prevOi?: number | null; oiDayHigh?: number | null; oiDayLow?: number | null; volume?: number | null;
  priceChg?: number | null; oiChg?: number | null; oiChgPct?: number | null; reading?: PriceOi | null; quoteTime?: string | null;
  /** previous completed sessions: closing price + OI (for the session-by-session reading) */
  sessions?: { date: string; close: number; oi: number }[];
}
const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

export async function indexFuturesSnapshot(underlying: string): Promise<FuturesSnapshot> {
  const cfg = loadDhanConfig(); if (!cfg.accessToken) return { available: false, underlying, reason: "Dhan not connected" };
  const f = await lookupDhanIndexFuture(underlying); if (!f) return { available: false, underlying, reason: `no ${underlying} index future in Dhan's scrip master` };
  const out: FuturesSnapshot = { available: false, underlying, expiry: f.expiry, securityId: f.securityId, segment: f.exchangeSegment };
  try {
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10), from = new Date(Date.now() + 19800000 - 20 * 86400_000).toISOString().slice(0, 10);
    const [q, h] = await Promise.all([
      dhanFetch("/marketfeed/quote", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId, body: { [f.exchangeSegment]: [Number(f.securityId)] } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      dhanFetch("/charts/historical", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId, body: { securityId: f.securityId, exchangeSegment: f.exchangeSegment, instrument: "FUTIDX", expiryCode: 0, oi: true, fromDate: from, toDate: today } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const d: any = q?.data?.[f.exchangeSegment]?.[f.securityId] ?? q?.data?.[f.exchangeSegment]?.[Number(f.securityId)] ?? null;
    const ts: number[] = h?.timestamp || [], sessions = ts.map((t, i) => ({ date: dayOf(t), close: Number(h.close?.[i]), oi: Number(h.open_interest?.[i]) })).filter((x) => Number.isFinite(x.close) && Number.isFinite(x.oi) && x.oi > 0);
    out.sessions = sessions.filter((x) => x.date < today);
    if (!d) { out.reason = "no futures quote from Dhan"; return out; }
    const prev = out.sessions[out.sessions.length - 1] ?? null;
    out.price = Number(d.last_price) || null; out.oi = Number(d.oi) || null; out.volume = d.volume ?? null; out.oiDayHigh = d.oi_day_high ?? null; out.oiDayLow = d.oi_day_low ?? null;
    out.prevClose = prev?.close ?? (Number(d.ohlc?.close) || null); out.prevOi = prev?.oi ?? null; out.quoteTime = d.last_trade_time ?? null;
    if (out.price != null && out.prevClose != null) out.priceChg = Math.round((out.price - out.prevClose) * 100) / 100;
    if (out.oi != null && out.prevOi != null) { out.oiChg = out.oi - out.prevOi; out.oiChgPct = Math.round((out.oiChg / out.prevOi) * 10000) / 100; }
    out.reading = out.priceChg != null && out.oiChg != null && out.price ? classifyPriceOi(out.priceChg, out.price, out.oiChg, out.prevOi!) : null;
    out.available = out.price != null && out.oi != null;
    if (!out.available) out.reason = "futures price / OI missing in the quote";
    return out;
  } catch (e: any) { out.reason = e?.message || "futures fetch failed"; return out; }
}
