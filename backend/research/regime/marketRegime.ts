// MARKET REGIME DETECTOR — research only (owner's brief, 2026-10-25). Nothing in the live app reads this module; it never
// places or blocks a trade. It classifies the market STATE from COMPLETED 15-minute and 5-minute candles:
//   CHOPPY · TRENDING_UP · TRENDING_DOWN · COMPRESSION · TRANSITION · UNKNOWN_DATA
// The regime is NOT a trade direction: `guidance` says what kind of setup the state allows (WAIT in CHOPPY / COMPRESSION,
// breakout + retest required in TRANSITION, only the regime's side in a trend).
// All thresholds live in REGIME_DEFAULTS and are UNVALIDATED research starting points until historical tests support them.
//
// Features (15-min = the latest FULLY CLOSED 15-minute candle and the ones before it; 5-min = completed candles of today):
//   ER10        efficiency ratio of the last 10 completed 15m closes: |net change| / Σ|changes|
//   ADX14, ±DI  Wilder's ADX on 15m candles (needs 2 × 14 + 1 candles)
//   slope       (EMA21 now − EMA21 3 candles ago) / (3 × ATR14), 15m
//   vwapCross   sign changes of (close − session VWAP) over the last 12 completed 5m candles of today. When the candles carry
//               no volume (index spot), the session average price (TWAP) is the documented VWAP proxy.
//   atrRatio    ATR14 / mean true range of the last 50 15m candles (compression < 1)
//   rangeWidth  (highest high − lowest low of the last 8 15m candles) / ATR14
//   premium     optional: ATM CE and PE premium change over the last 3 completed 5m candles vs the spot change
//               (agree = spot up with CE up & PE down, or the mirror). Used only when both premiums are present.

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number }
export type Regime = "CHOPPY" | "TRENDING_UP" | "TRENDING_DOWN" | "COMPRESSION" | "TRANSITION" | "UNKNOWN_DATA";
export interface RegimeConfig {
  erTrend: number; erChop: number; adxTrend: number; adxChop: number; slopeTrend: number;
  vwapCrossChop: number; vwapCrossTrendMax: number; vwapWindow: number; vwapMinCandles: number;
  compressAtrRatio: number; compressRangeWidth: number; maxMissing5m: number; maxMissing15m: number;
  usePremium: boolean; use: { er: boolean; adx: boolean; slope: boolean; vwap: boolean; compression: boolean };
}
export const REGIME_DEFAULTS: RegimeConfig = {
  erTrend: 0.35, erChop: 0.2, adxTrend: 20, adxChop: 18, slopeTrend: 0.1,
  vwapCrossChop: 4, vwapCrossTrendMax: 2, vwapWindow: 12, vwapMinCandles: 6,
  compressAtrRatio: 0.7, compressRangeWidth: 3, maxMissing5m: 2, maxMissing15m: 2,
  usePremium: true, use: { er: true, adx: true, slope: true, vwap: true, compression: true },
};
export interface PremiumInput { ce: (number | null)[]; pe: (number | null)[] }   // ATM closes aligned to the last 4 completed 5m candles
export interface RegimeResult {
  regime: Regime; guidance: string; reasons: string[];
  features: { er10: number | null; adx: number | null; plusDI: number | null; minusDI: number | null; slope: number | null; vwapCross: number | null;
    atrRatio: number | null; rangeWidth: number | null; premiumAgrees: boolean | null; atr15: number | null };
}
const IST = 19800;
export const istDay = (t: number) => Math.floor((t + IST) / 86400);
const mnOf = (t: number) => Math.floor(((t + IST) % 86400) / 60);

/** Only candles whose period has fully ended by `nowSec` (a forming candle is never used). */
export function completed(c: Candle[], nowSec: number, tfSec: number): Candle[] { return c.filter((x) => x.time + tfSec <= nowSec); }

export function efficiencyRatio(closes: number[], n = 10): number | null {
  if (closes.length < n + 1) return null; const w = closes.slice(-(n + 1)); let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
  return path === 0 ? 0 : Math.abs(w[w.length - 1] - w[0]) / path;
}
export function trueRanges(c: Candle[]): number[] { return c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)))); }
export function atr(c: Candle[], n = 14): number | null { if (c.length < n + 1) return null; const tr = trueRanges(c).slice(-n); return tr.reduce((a, b) => a + b, 0) / n; }
/** Wilder's ADX with +DI / −DI. Needs 2n + 1 candles. */
export function adx(c: Candle[], n = 14): { adx: number; plusDI: number; minusDI: number } | null {
  if (c.length < 2 * n + 1) return null;
  const tr = trueRanges(c), pdm: number[] = [0], mdm: number[] = [0];
  for (let i = 1; i < c.length; i++) { const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); }
  let sTr = 0, sP = 0, sM = 0; for (let i = 1; i <= n; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dxs: number[] = []; let pDI = 0, mDI = 0;
  for (let i = n; i < c.length; i++) {
    if (i > n) { sTr = sTr - sTr / n + tr[i]; sP = sP - sP / n + pdm[i]; sM = sM - sM / n + mdm[i]; }
    pDI = sTr ? (100 * sP) / sTr : 0; mDI = sTr ? (100 * sM) / sTr : 0; dxs.push(pDI + mDI ? (100 * Math.abs(pDI - mDI)) / (pDI + mDI) : 0);
  }
  let a = dxs.slice(0, n).reduce((x, y) => x + y, 0) / n; for (let i = n; i < dxs.length; i++) a = (a * (n - 1) + dxs[i]) / n;
  return { adx: a, plusDI: pDI, minusDI: mDI };
}
export function emaSeries(xs: number[], n: number): number[] { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); }
/** Session VWAP (or TWAP when no candle has volume) of today's candles, then sign changes of close − VWAP over the last `window`. */
export function vwapCrossings(today5: Candle[], window = 12): number | null {
  if (!today5.length) return null; const hasVol = today5.some((c) => (c.volume || 0) > 0);
  let pv = 0, v = 0; const vw: number[] = [];
  for (const c of today5) { const tp = (c.high + c.low + c.close) / 3, w = hasVol ? c.volume || 0 : 1; pv += tp * w; v += w; vw.push(v ? pv / v : tp); }
  const s = today5.map((c, i) => Math.sign(c.close - vw[i])).slice(-window).filter((x) => x !== 0);
  let n = 0; for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) n++; return n;
}
/** Missing candles inside a session window (gaps between consecutive candles of the same day > tf). */
export function missingCandles(c: Candle[], tfSec: number): number {
  let miss = 0; for (let i = 1; i < c.length; i++) if (istDay(c[i].time) === istDay(c[i - 1].time)) miss += Math.max(0, Math.round((c[i].time - c[i - 1].time) / tfSec) - 1); return miss;
}

/**
 * Classify the regime at `nowSec` from candles that may include forming ones (they are dropped here).
 * c15 / c5: continuous candles (previous sessions + today). premium: optional ATM CE / PE closes of the last 4 completed 5m candles.
 */
export function classifyRegime(c15all: Candle[], c5all: Candle[], nowSec: number, premium?: PremiumInput | null, cfg: RegimeConfig = REGIME_DEFAULTS): RegimeResult {
  const c15 = completed(c15all, nowSec, 900), c5 = completed(c5all, nowSec, 300), reasons: string[] = [];
  const today5 = c5.filter((c) => istDay(c.time) === istDay(nowSec - 1) && mnOf(c.time) >= 555);
  const empty = { er10: null, adx: null, plusDI: null, minusDI: null, slope: null, vwapCross: null, atrRatio: null, rangeWidth: null, premiumAgrees: null, atr15: null };
  const unknown = (why: string): RegimeResult => ({ regime: "UNKNOWN_DATA", guidance: "WAIT — not enough valid data to classify", reasons: [why], features: empty });
  if (c15.length < 29) return unknown(`only ${c15.length} completed 15m candles (need 29 for ADX14)`);
  const w15 = c15.slice(-29);
  if (w15.some((c) => ![c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0))) return unknown("invalid 15m prices");
  if (missingCandles(w15, 900) > cfg.maxMissing15m) return unknown(`${missingCandles(w15, 900)} missing 15m candles`);
  if (cfg.use.vwap && today5.length < cfg.vwapMinCandles) return unknown(`only ${today5.length} completed 5m candles today (need ${cfg.vwapMinCandles})`);
  if (missingCandles(today5.slice(-cfg.vwapWindow), 300) > cfg.maxMissing5m) return unknown("missing 5m candles");
  const a15 = atr(c15, 14);
  if (!a15 || a15 <= 0) return unknown("flat prices (ATR = 0)");
  const closes = c15.map((c) => c.close), er10 = efficiencyRatio(closes, 10), dx = adx(c15.slice(-60), 14), e = emaSeries(closes.slice(-60), 21);
  const slope = e.length >= 4 ? (e[e.length - 1] - e[e.length - 4]) / (3 * a15) : null;
  const tr50 = trueRanges(c15.slice(-51)).slice(1), atrRatio = tr50.length >= 20 ? a15 / (tr50.reduce((x, y) => x + y, 0) / tr50.length) : null;
  const r8 = c15.slice(-8), rangeWidth = (Math.max(...r8.map((c) => c.high)) - Math.min(...r8.map((c) => c.low))) / a15;
  const vwapCross = vwapCrossings(today5, cfg.vwapWindow);
  let premiumAgrees: boolean | null = null;
  if (premium && premium.ce.length >= 4 && premium.pe.length >= 4 && today5.length >= 4) {
    const ce0 = premium.ce[0], ce1 = premium.ce[premium.ce.length - 1], pe0 = premium.pe[0], pe1 = premium.pe[premium.pe.length - 1];
    const s0 = today5[today5.length - 4].close, s1 = today5[today5.length - 1].close;
    if (ce0 != null && ce1 != null && pe0 != null && pe1 != null && s1 !== s0) premiumAgrees = s1 > s0 ? ce1 > ce0 && pe1 < pe0 : ce1 < ce0 && pe1 > pe0;
  }
  const features = { er10, adx: dx?.adx ?? null, plusDI: dx?.plusDI ?? null, minusDI: dx?.minusDI ?? null, slope, vwapCross, atrRatio, rangeWidth, premiumAgrees, atr15: a15 };
  const U = cfg.use;
  // 1) compression — a quiet, narrow market; NOT a breakout prediction
  if (U.compression && atrRatio != null && atrRatio <= cfg.compressAtrRatio && rangeWidth <= cfg.compressRangeWidth) {
    reasons.push(`ATR ${atrRatio.toFixed(2)}× its 50-candle mean, 8-candle range ${rangeWidth.toFixed(1)} ATR`);
    return { regime: "COMPRESSION", guidance: "WAIT — compressed range; no breakout is predicted", reasons, features };
  }
  // 2) trend: every enabled feature must agree
  const trendOk = (dir: 1 | -1) =>
    (!U.er || (er10 != null && er10 >= cfg.erTrend)) &&
    (!U.adx || (dx != null && dx.adx >= cfg.adxTrend && (dir > 0 ? dx.plusDI > dx.minusDI : dx.minusDI > dx.plusDI))) &&
    (!U.slope || (slope != null && dir * slope >= cfg.slopeTrend)) &&
    (!U.vwap || (vwapCross != null && vwapCross <= cfg.vwapCrossTrendMax)) &&
    (U.er || U.adx || U.slope);
  for (const dir of [1, -1] as const) if (trendOk(dir)) {
    if (cfg.usePremium && premiumAgrees === false) { reasons.push("spot trend not confirmed by the ATM premiums"); return { regime: "TRANSITION", guidance: "Needs a confirmed breakout / breakdown with retest or acceptance", reasons, features }; }
    reasons.push(`ER ${er10?.toFixed(2)} · ADX ${dx?.adx.toFixed(0)} (+DI ${dx?.plusDI.toFixed(0)} / −DI ${dx?.minusDI.toFixed(0)}) · slope ${slope?.toFixed(2)} · VWAP crosses ${vwapCross}`);
    return { regime: dir > 0 ? "TRENDING_UP" : "TRENDING_DOWN", guidance: dir > 0 ? "Only CE / long-side setups; regime is not an entry" : "Only PE / short-side setups; regime is not an entry", reasons, features };
  }
  // 3) chop
  if ((U.er && U.adx && er10 != null && dx != null && er10 <= cfg.erChop && dx.adx < cfg.adxChop) || (U.vwap && vwapCross != null && vwapCross >= cfg.vwapCrossChop) ||
      (!U.adx && U.er && er10 != null && er10 <= cfg.erChop) || (!U.er && U.adx && dx != null && dx.adx < cfg.adxChop)) {
    reasons.push(`ER ${er10?.toFixed(2)} · ADX ${dx?.adx.toFixed(0)} · VWAP crosses ${vwapCross}`);
    return { regime: "CHOPPY", guidance: "WAIT — no directional setups in chop (no validated range strategy)", reasons, features };
  }
  reasons.push("mixed evidence"); return { regime: "TRANSITION", guidance: "Needs a confirmed breakout / breakdown with retest or acceptance", reasons, features };
}

/** Simple baseline for comparison: close vs EMA21 and the EMA's 3-candle direction on 15m. */
export function baselineRegime(c15all: Candle[], nowSec: number): Regime {
  const c = completed(c15all, nowSec, 900); if (c.length < 25) return "UNKNOWN_DATA";
  const e = emaSeries(c.slice(-60).map((x) => x.close), 21), last = c[c.length - 1].close, s = e[e.length - 1] - e[e.length - 4];
  return last > e[e.length - 1] && s > 0 ? "TRENDING_UP" : last < e[e.length - 1] && s < 0 ? "TRENDING_DOWN" : "CHOPPY";
}
