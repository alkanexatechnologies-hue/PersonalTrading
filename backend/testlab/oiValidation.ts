// OI VALIDATION (supporting evidence only — never changes direction, never gates).
// Reads per-strike option OI from the option series (real historical bars, or a
// live chain slice) across ATM±N and classifies the latest OI behaviour:
//   NORMAL           no strike's OI change stands out
//   OI_CHANGE        meaningful change (> 2x the strike's typical change)
//   OI_SHOCK         one strike jumps (> 5x typical) while its neighbours do not
//   OI_UNDER_REVIEW  a shock in the last 2 candles that has neither persisted nor faded yet
//   OI_CONFIRMED     the change persists (same sign 2+ candles), neighbours agree, premium/volume agree
//   OI_NOISE         a recent shock reversed by >= 50%
//   OI_REVERSAL_WATCH writers building AGAINST the current move (e.g. PE writing into a fall)
// A single-strike spike can never flip the market direction by itself.

import { contractKey, OptBar, OptionSeries } from "./optionsData";

export type OiValidationState = "NORMAL" | "OI_CHANGE" | "OI_SHOCK" | "OI_UNDER_REVIEW" | "OI_CONFIRMED" | "OI_NOISE" | "OI_REVERSAL_WATCH" | "UNAVAILABLE";

export interface OiValidation {
  state: OiValidationState;
  detail: string;
  walls: { ce: number | null; pe: number | null };   // max-OI CE strike above spot / PE strike below spot
}

const median = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };

function chg(series: OptionSeries, b: OptBar, t0: number | undefined, t1: number | undefined): number | null {
  if (t0 == null || t1 == null) return null;
  const m = series.byContract.get(contractKey(b.expiry, b.side, b.strike));
  const x = m?.get(t0), y = m?.get(t1);
  return x?.oi != null && y?.oi != null ? x.oi - y.oi : null;
}

export function validateOi(a: {
  series: OptionSeries | null; times: number[]; i: number; spot: number | null;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
}): OiValidation {
  const none: OiValidation = { state: "UNAVAILABLE", detail: "no option OI for this candle", walls: { ce: null, pe: null } };
  const s = a.series;
  // use this candle's slice, else the previous candle's (e.g. a forming candle in live mode)
  let k = a.i;
  if (!s || !s.byTime.get(a.times[k])) k = a.i - 1;
  const slot = s && k >= 0 ? s.byTime.get(a.times[k]) : undefined;
  if (!s || !slot) return none;
  const spot = a.spot ?? slot.CE.concat(slot.PE).find((b) => b.spot != null)?.spot ?? null;
  const walls = {
    ce: spot == null ? null : slot.CE.filter((b) => b.strike >= spot && b.oi != null).sort((x, y) => (y.oi as number) - (x.oi as number))[0]?.strike ?? null,
    pe: spot == null ? null : slot.PE.filter((b) => b.strike <= spot && b.oi != null).sort((x, y) => (y.oi as number) - (x.oi as number))[0]?.strike ?? null,
  };
  const T = (n: number) => a.times[k - n];
  type St = { b: OptBar; now: number | null; prev: number | null; prev2: number | null; typical: number; next?: number | null };
  const rows: St[] = [];
  for (const b of [...slot.CE, ...slot.PE]) {
    const hist: number[] = [];
    for (let n = 1; n <= 12; n++) { const c = chg(s, b, T(n), T(n + 1)); if (c != null) hist.push(Math.abs(c)); }
    rows.push({ b, now: chg(s, b, T(0), T(1)), prev: chg(s, b, T(1), T(2)), prev2: chg(s, b, T(2), T(3)), typical: median(hist) });
  }
  const usable = rows.filter((r) => r.now != null && Number.isFinite(r.typical) && r.typical > 0);
  if (!usable.length) return { ...none, walls, detail: "not enough OI history yet" };

  const ratio = (r: St, v: number | null) => (v == null ? 0 : Math.abs(v) / r.typical);
  const neighbours = (r: St) => usable.filter((x) => x.b.side === r.b.side && Math.abs(x.b.offset - r.b.offset) === 1);
  const sameSign = (x: number | null, y: number | null) => x != null && y != null && Math.sign(x) === Math.sign(y) && x !== 0;

  // 1. recent shock that faded => noise; still open => under review
  for (const r of usable) {
    if (ratio(r, r.prev) > 5 && r.now != null && r.prev != null && Math.sign(r.now) !== Math.sign(r.prev) && Math.abs(r.now) >= 0.5 * Math.abs(r.prev))
      return { state: "OI_NOISE", detail: `${r.b.strike} ${r.b.side}: last candle's OI jump reversed`, walls };
  }
  // 2. writers building against the move (calls written into a rise / puts written into a fall)
  const sideAgainst = a.direction === "BEARISH" ? "PE" : a.direction === "BULLISH" ? "CE" : null;
  if (sideAgainst) {
    const near = usable.filter((r) => r.b.side === sideAgainst && Math.abs(r.b.offset) <= 1);
    const writing = near.filter((r) => (r.now as number) > 0 && ratio(r, r.now) > 2 && sameSign(r.now, r.prev) && (() => {
      const m = s.byContract.get(contractKey(r.b.expiry, r.b.side, r.b.strike)); const p1 = m?.get(T(1));
      return p1 ? r.b.close <= p1.close : false;   // OI up while premium flat/down = fresh writing
    })());
    if (writing.length) return { state: "OI_REVERSAL_WATCH", detail: `${writing.map((r) => r.b.strike + " " + r.b.side).join(", ")} writing against the ${a.direction.toLowerCase()} move`, walls };
  }
  // 3. shock: a single strike far above its typical change, neighbours not following
  const shocks = usable.filter((r) => ratio(r, r.now) > 5 && !neighbours(r).some((nb) => sameSign(nb.now, r.now) && ratio(nb, nb.now) > 2));
  if (shocks.length) return { state: "OI_SHOCK", detail: `${shocks[0].b.strike} ${shocks[0].b.side} OI jumped ${ratio(shocks[0], shocks[0].now).toFixed(1)}x its usual change — single strike, not a direction signal`, walls };
  const reviewing = usable.filter((r) => ratio(r, r.prev) > 5 && !sameSign(r.now, r.prev));
  if (reviewing.length) return { state: "OI_UNDER_REVIEW", detail: `${reviewing[0].b.strike} ${reviewing[0].b.side} shock last candle — waiting for persistence`, walls };
  // 4. confirmed: persistent, neighbour-backed, accelerating or steady, premium/volume consistent
  const big = usable.filter((r) => ratio(r, r.now) > 2);
  const confirmed = big.filter((r) => sameSign(r.now, r.prev) && neighbours(r).some((nb) => sameSign(nb.now, r.now)) && (r.b.volume ?? 0) > 0);
  if (confirmed.length) {
    const r = confirmed[0];
    return { state: "OI_CONFIRMED", detail: `${r.b.strike} ${r.b.side} OI ${(r.now as number) > 0 ? "build" : "unwind"} persists 2+ candles with neighbours${Math.abs(r.now as number) > Math.abs(r.prev as number) ? ", accelerating" : ""}`, walls };
  }
  if (big.length) return { state: "OI_CHANGE", detail: `${big.map((r) => r.b.strike + " " + r.b.side).slice(0, 3).join(", ")}: OI change above usual`, walls };
  return { state: "NORMAL", detail: "OI changes within the usual range", walls };
}
