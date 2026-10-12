import fs from "fs";
import path from "path";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Costs, lots and expiries for the research backtest ============================
// Charges use the SAME itemised rates as the paper engine (backend/paper/engine.ts tradeFriction), which are the rates in
// force from 1 Oct 2024 (STT on option sale 0.1 %, NSE option transaction charge 0.03503 %) — the whole research period
// starts 14 Oct 2024. Added: SEBI turnover fee (₹10 / crore). Not verifiable from the data: any rate change during
// 2025–26 — disclosed in the report. Bid/ask history does not exist, so slippage is a separate, scenario-tested input.
// Lot size and expiry come from NSE's own F&O bhavcopy files (per contract), not from today's values.

export interface ChargeBreakdown { brokerage: number; stt: number; exchange: number; sebi: number; gst: number; stamp: number; total: number }
/** Statutory + broker charges in ₹ for one round trip (buy then sell) of `qty` units. */
export function charges(entryPrem: number, exitPrem: number, qty: number, brokeragePerOrder = 20): ChargeBreakdown {
  const buyVal = entryPrem * qty, sellVal = exitPrem * qty, turn = buyVal + sellVal;
  const brokerage = 2 * brokeragePerOrder, stt = 0.001 * sellVal, exchange = 0.00035 * turn, sebi = 0.000001 * turn, stamp = 0.00003 * buyVal;
  const gst = 0.18 * (brokerage + exchange + sebi);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { brokerage: r(brokerage), stt: r(stt), exchange: r(exchange), sebi: r(sebi), gst: r(gst), stamp: r(stamp), total: r(brokerage + stt + exchange + sebi + gst + stamp) };
}
/** Net points per unit after charges and slippage (slippage in premium points per side, against the trader). */
export function netPoints(entryPrem: number, exitPrem: number, qty: number, slipPerSide: number) {
  const gross = exitPrem - entryPrem;
  const c = charges(entryPrem + slipPerSide, Math.max(0.05, exitPrem - slipPerSide), qty);
  return { gross: Math.round(gross * 100) / 100, net: Math.round((gross - 2 * slipPerSide - c.total / qty) * 100) / 100, chargesPerUnit: Math.round((c.total / qty) * 100) / 100 };
}

// ---- NIFTY weekly expiry calendar + lot per expiry, from cached NSE bhavcopy samples ----
const BHAV = path.join(DATA_DIR, "research-nifty20", "bhav");
let _cal: { expiries: string[]; lot: Map<string, number> } | null = null;
export function calendar() {
  if (_cal) return _cal;
  const lot = new Map<string, number>();
  for (const f of fs.existsSync(BHAV) ? fs.readdirSync(BHAV).filter((x) => /^\d{8}\.csv$/.test(x)) : []) {
    const L = fs.readFileSync(path.join(BHAV, f), "utf8").split("\n"), h = L[0].split(","), ix = (k: string) => h.indexOf(k);
    for (const l of L.slice(1)) { const c = l.split(","); if (c[ix("TckrSymb")] === "NIFTY" && c[ix("FinInstrmTp")] === "IDO") lot.set(c[ix("XpryDt")], Number(c[ix("NewBrdLotQty")])); }
  }
  _cal = { expiries: [...lot.keys()].sort(), lot };
  return _cal;
}
/** Nearest expiry on/after a trading date (what Dhan's expiryCode 1 / WEEK resolves to) and its lot size. */
export function expiryFor(day: string): { expiry: string | null; lot: number | null; isExpiryDay: boolean } {
  const c = calendar(), e = c.expiries.find((x) => x >= day) || null;
  return { expiry: e, lot: e ? c.lot.get(e) ?? null : null, isExpiryDay: e === day };
}
