// ---------------------------------------------------------------------------
// Black-Scholes greeks — MODEL-DERIVED fallback.
// ---------------------------------------------------------------------------
// The Dhan option chain supplies delta / theta / IV per strike (real), but its
// gamma/vega fields are usually null. The Market Analysis screen needs gamma for
// its Gamma-Blast model and movement projection, so when the feed does not carry
// gamma/vega we compute them here with a standard Black-Scholes model.
//
// IMPORTANT: these are MODEL-DERIVED, not exchange truth. Every consumer labels
// them as such. We never fabricate the inputs — if spot/strike/IV/time are not
// usable, we return null and the UI shows "—" rather than a guessed number.

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Abramowitz & Stegun 7.1.26 approximation of the standard normal CDF.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface BsInput {
  spot: number;
  strike: number;
  tYears: number; // time to expiry in years
  iv: number; // implied volatility as a fraction (0.14 = 14%)
  rate?: number; // risk-free rate (default ~6.5% for INR)
}

const DEFAULT_RATE = 0.065;

function usable(i: BsInput): boolean {
  return i.spot > 0 && i.strike > 0 && i.iv > 0 && i.tYears > 0 && Number.isFinite(i.spot) && Number.isFinite(i.iv);
}

function d1(i: BsInput): number {
  const r = i.rate ?? DEFAULT_RATE;
  return (Math.log(i.spot / i.strike) + (r + 0.5 * i.iv * i.iv) * i.tYears) / (i.iv * Math.sqrt(i.tYears));
}

/** Gamma (same for CE and PE). Null when inputs are not usable. */
export function bsGamma(i: BsInput): number | null {
  if (!usable(i)) return null;
  const g = normPdf(d1(i)) / (i.spot * i.iv * Math.sqrt(i.tYears));
  return Number.isFinite(g) ? g : null;
}

/** Delta. CE in [0,1], PE in [-1,0]. Null when inputs are not usable. */
export function bsDelta(i: BsInput, type: "CE" | "PE"): number | null {
  if (!usable(i)) return null;
  const nd1 = normCdf(d1(i));
  const delta = type === "CE" ? nd1 : nd1 - 1;
  return Number.isFinite(delta) ? delta : null;
}

/** Vega per 1.00 (i.e. per 100% IV) move. Divide by 100 for per-1%-IV. */
export function bsVega(i: BsInput): number | null {
  if (!usable(i)) return null;
  const v = i.spot * normPdf(d1(i)) * Math.sqrt(i.tYears);
  return Number.isFinite(v) ? v : null;
}

/**
 * Years from "now" to an expiry date string (YYYY-MM-DD), assuming a 15:30 IST
 * expiry close. Clamped to a tiny positive floor so same-day expiry still yields
 * a finite gamma (avoids divide-by-zero near the bell). Returns null if the date
 * can't be parsed.
 */
export function yearsToExpiry(expiryIso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!expiryIso || !/^\d{4}-\d{2}-\d{2}/.test(expiryIso)) return null;
  // 15:30 IST == 10:00 UTC on the expiry date.
  const expiryMs = Date.parse(expiryIso.slice(0, 10) + "T10:00:00Z");
  if (!Number.isFinite(expiryMs)) return null;
  const ms = expiryMs - nowMs;
  const yr = ms / (365 * 24 * 3600 * 1000);
  // Floor at ~15 minutes of a year so near-expiry gamma stays finite.
  return Math.max(yr, 15 / (365 * 24 * 60));
}

/**
 * Resolve a usable gamma for a strike: prefer the feed's gamma when present,
 * else fall back to the Black-Scholes model. Returns { value, source }.
 */
export function resolveGamma(
  feedGamma: number | null | undefined,
  i: BsInput
): { value: number | null; source: "feed" | "model" | "none" } {
  if (feedGamma != null && Number.isFinite(feedGamma) && feedGamma > 0) {
    return { value: feedGamma, source: "feed" };
  }
  const g = bsGamma(i);
  return g != null ? { value: g, source: "model" } : { value: null, source: "none" };
}

/**
 * Local Greek repricing of an option premium for a change in spot (and optional
 * change in IV / time), per the Taylor expansion used across the screen:
 *   ΔPremium ≈ delta·ΔSpot + 0.5·gamma·ΔSpot² + vega·ΔIV − theta·ΔTimeDays
 * Returns the projected premium (never below 0). Null if we lack delta.
 */
export function repriceOption(opts: {
  ltp: number | null | undefined;
  delta: number | null | undefined;
  gamma: number | null | undefined;
  vega?: number | null;
  theta?: number | null;
  dSpot: number;
  dIv?: number; // change in IV as a fraction
  dTimeDays?: number; // calendar days elapsed
}): number | null {
  const { ltp, delta } = opts;
  if (ltp == null || delta == null || !Number.isFinite(ltp) || !Number.isFinite(delta)) return null;
  const gamma = opts.gamma ?? 0;
  const vega = opts.vega ?? 0;
  const theta = opts.theta ?? 0;
  const dSpot = opts.dSpot;
  const projected =
    ltp +
    delta * dSpot +
    0.5 * gamma * dSpot * dSpot +
    vega * (opts.dIv ?? 0) -
    theta * (opts.dTimeDays ?? 0);
  return Math.max(0, projected);
}
