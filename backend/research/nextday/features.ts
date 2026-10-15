import { bsPrice, bsDelta } from "../../analysis/greeks";
import { Session, Leg, legKey } from "./data";

// ============================ Next-day study — features at D's close (pre-registered, research only) ============================
// Every function here receives history that ENDS at D (hist[hist.length - 1] is D). Nothing after D is visible.

const clip = (v: number, a = -1, b = 1) => Math.max(a, Math.min(b, v));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const RATE = 0.065, STEP = 50, N_STRIKES = 4, PREV = 5, MIN_BARS = 3, MIN_CONTRACTS = 5;

export function yearsBetween(day: string, expiry: string) { return Math.max(0, (Date.parse(expiry + "T10:00:00Z") - Date.parse(day + "T10:00:00Z")) / 86400_000) / 365; }
/** Black-Scholes implied volatility by bisection; null when the price is below intrinsic or not usable. */
export function impliedVol(price: number, spot: number, strike: number, t: number, side: "CE" | "PE"): number | null {
  if (!(price > 0) || !(t > 0)) return null;
  let lo = 0.01, hi = 3;
  const f = (iv: number) => (bsPrice({ spot, strike, tYears: t, iv, rate: RATE }, side) ?? NaN) - price;
  if (!(f(lo) < 0) || !(f(hi) > 0)) return null;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
export function atr14(hist: Session[]): number | null {
  if (hist.length < 15) return null;
  const tr = hist.slice(-14).map((s, i, a) => { const pc = hist[hist.length - 15 + i].nifty.c; return Math.max(s.nifty.h - s.nifty.l, Math.abs(s.nifty.h - pc), Math.abs(s.nifty.l - pc)); });
  return mean(tr);
}
const sma = (xs: number[], n: number) => (xs.length >= n ? mean(xs.slice(-n)) : NaN);

export interface ContractView { strike: number; side: "CE" | "PE"; close: number; support: number; resistance: number; breakout: number; position: number; strength: number; residual: number | null; iv: number | null; pctChg: number | null; oi: number; chgOi: number; touchesR: number; touchesS: number; swingHigh: number | null; swingLow: number | null; bars: number }
export interface Features {
  day: string; close: number; atm: number; expiry: string | null; daysToExpiry: number | null; atr: number | null;
  a1: number; a2: number; a3: number; A: number;
  b1: number | null; b2: number | null; B: number | null; ceScore: number | null; peScore: number | null;
  d1: number | null; d2: number | null; Dx: number | null;
  nCE: number; nPE: number; insufficientSpot: boolean; insufficientPremium: boolean;
  trendUp: boolean | null; vix: number | null; contracts: ContractView[];
}

function contractView(hist: Session[], expiry: string, strike: number, side: "CE" | "PE"): ContractView | null {
  const D = hist[hist.length - 1], k = legKey(expiry, strike, side), leg = D.legs.get(k);
  if (!leg || !(leg.c > 0) || !(leg.vol > 0)) return null;
  const prev = hist.slice(-1 - PREV, -1).map((s) => s.legs.get(k)).filter((x): x is Leg => !!x && x.vol > 0 && x.h > 0 && x.l > 0);
  if (prev.length < MIN_BARS) return null;
  const S = Math.min(...prev.map((x) => x.l)), R = Math.max(...prev.map((x) => x.h));
  const breakout = leg.c > R ? 1 : leg.c < S ? -1 : 0, position = R > S ? clip((leg.c - S) / (R - S), 0, 1) : 0.5;
  // delta-adjusted residual vs D−1 (same contract, D−1 must have traded)
  const P = hist[hist.length - 2], pl = P?.legs.get(k);
  let residual: number | null = null, pctChg: number | null = null;
  if (P && pl && pl.c > 0 && pl.vol > 0) {
    pctChg = (leg.c - pl.c) / pl.c;
    const t0 = yearsBetween(P.day, expiry), iv0 = impliedVol(pl.c, P.nifty.c, strike, t0, side);
    const dl = iv0 != null ? bsDelta({ spot: P.nifty.c, strike, tYears: t0, iv: iv0, rate: RATE }, side) : null;
    if (dl != null) residual = (leg.c - pl.c - dl * (D.nifty.c - P.nifty.c)) / pl.c;
  }
  // display-only: 3-bar fractal swings over 10 sessions (bars up to D; a swing at D−1 is confirmed by D's bar), touches
  const ten = hist.slice(-10).map((s) => s.legs.get(k)).filter((x): x is Leg => !!x && x.vol > 0);
  let swingHigh: number | null = null, swingLow: number | null = null;
  for (let i = 1; i < ten.length - 1; i++) {
    if (ten[i].h > ten[i - 1].h && ten[i].h > ten[i + 1].h && ten[i].h > leg.c && (swingHigh == null || ten[i].h < swingHigh)) swingHigh = ten[i].h;
    if (ten[i].l < ten[i - 1].l && ten[i].l < ten[i + 1].l && ten[i].l < leg.c && (swingLow == null || ten[i].l > swingLow)) swingLow = ten[i].l;
  }
  const touchesR = prev.filter((x) => Math.abs(x.h - R) <= 0.03 * R).length, touchesS = prev.filter((x) => Math.abs(x.l - S) <= 0.03 * S).length;
  const t = yearsBetween(D.day, expiry);
  return { strike, side, close: leg.c, support: S, resistance: R, breakout, position, strength: (breakout + (2 * position - 1)) / 2, residual,
    iv: impliedVol(leg.c, D.nifty.c, strike, t, side), pctChg, oi: leg.oi, chgOi: leg.chgOi, touchesR, touchesS, swingHigh, swingLow, bars: prev.length };
}

export function featuresAt(hist: Session[]): Features {
  const D = hist[hist.length - 1], c = D.nifty.c, closes = hist.map((s) => s.nifty.c);
  // ---- A: spot ----
  const a1 = D.nifty.h > D.nifty.l ? 2 * (c - D.nifty.l) / (D.nifty.h - D.nifty.l) - 1 : 0;
  const p5 = hist.slice(-6, -1);
  const a2 = p5.length === 5 ? (c > Math.max(...p5.map((s) => s.nifty.h)) ? 1 : c < Math.min(...p5.map((s) => s.nifty.l)) ? -1 : 0) : 0;
  const s20 = sma(closes, 20), s20b = sma(closes.slice(0, -5), 20);
  const a3 = Number.isFinite(s20) && Number.isFinite(s20b) ? (c > s20 && s20 > s20b ? 1 : c < s20 && s20 < s20b ? -1 : 0) : 0;
  const s50 = sma(closes, 50);
  // ---- contracts ----
  const atm = Math.round(c / STEP) * STEP, expiry = D.expiries.find((e) => e > D.day) || null;
  const contracts: ContractView[] = [];
  if (expiry) for (let r = -N_STRIKES; r <= N_STRIKES; r++) for (const side of ["CE", "PE"] as const) { const v = contractView(hist, expiry, atm + r * STEP, side); if (v) contracts.push(v); }
  const ce = contracts.filter((x) => x.side === "CE"), pe = contracts.filter((x) => x.side === "PE");
  const insufficientPremium = ce.length < MIN_CONTRACTS || pe.length < MIN_CONTRACTS;
  let b1: number | null = null, b2: number | null = null, B: number | null = null, ceScore: number | null = null, peScore: number | null = null;
  if (!insufficientPremium) {
    ceScore = mean(ce.map((x) => x.strength)); peScore = mean(pe.map((x) => x.strength)); b1 = (ceScore - peScore) / 2;
    const rc = ce.map((x) => x.residual).filter((v): v is number => v != null), rp = pe.map((x) => x.residual).filter((v): v is number => v != null);
    b2 = rc.length >= 3 && rp.length >= 3 ? clip((mean(rc) - mean(rp)) / 0.10) : 0;
    B = (b1 + b2) / 2;
  }
  // ---- OI / IV ----
  let d1: number | null = null;
  const tot = contracts.reduce((s, x) => s + (x.oi || 0), 0);
  if (!insufficientPremium && tot > 0) d1 = clip(((pe.reduce((s, x) => s + (x.chgOi || 0), 0) - ce.reduce((s, x) => s + (x.chgOi || 0), 0)) / tot) / 0.05);
  const P = hist[hist.length - 2];
  const d2 = D.vix && P?.vix && P.vix.c > 0 ? -clip(((D.vix.c / P.vix.c - 1) * 100) / 10) : null;
  const Dx = d1 != null && d2 != null ? (d1 + d2) / 2 : d1 != null ? d1 / 2 : null;
  return {
    day: D.day, close: c, atm, expiry, daysToExpiry: expiry ? Math.round(yearsBetween(D.day, expiry) * 365) : null, atr: atr14(hist),
    a1, a2, a3, A: (a1 + a2 + a3) / 3, b1, b2, B, ceScore, peScore, d1, d2, Dx,
    nCE: ce.length, nPE: pe.length, insufficientSpot: hist.length < 25, insufficientPremium,
    trendUp: Number.isFinite(s50) ? c > s50 : null, vix: D.vix?.c ?? null, contracts,
  };
}

export type Model = "A" | "B" | "C" | "D";
export type Call = "BULLISH" | "BEARISH" | "NEUTRAL" | "NO_EDGE" | "INSUFFICIENT_DATA";
export function modelScore(f: Features, m: Model): { score: number | null; parts: number[] } {
  if (f.insufficientSpot) return { score: null, parts: [] };
  if (m === "A") return { score: f.A, parts: [f.a1, f.a2, f.a3] };
  if (f.B == null) return { score: null, parts: [] };
  if (m === "B") return { score: f.B, parts: [f.b1!, f.b2!] };
  if (m === "C") return { score: (f.A + f.B) / 2, parts: [f.A, f.B] };
  if (f.Dx == null) return { score: null, parts: [] };
  return { score: (f.A + f.B + f.Dx) / 3, parts: [f.A, f.B, f.Dx] };
}
export function classify(f: Features, m: Model, k: number): Call {
  const { score, parts } = modelScore(f, m);
  if (score == null) return "INSUFFICIENT_DATA";
  if (score >= k) return "BULLISH";
  if (score <= -k) return "BEARISH";
  return parts.some((p) => p >= k) && parts.some((p) => p <= -k) ? "NO_EDGE" : "NEUTRAL";
}
