// ============================ Premium calculator — "what will the premium be if the index goes to X (after N minutes)?" ============================
// Model: the LIVE premium + the Black-Scholes change from the live spot to the target index level (analysis/greeks
// premiumAtLevel). With "after N minutes" the time left shrinks (time decay).
// IV: ONE IV for the expiry = the average of the at-the-money CALL and PUT IV (put-call parity says they are the same; Dhan's
// legs often disagree after hours, e.g. ATM CE 10.1% vs PE 20.8% while VIX ≈ 14). Missing → the other leg → the median of
// the valid IVs. Dhan's in-the-money IVs are often 0 or stale (e.g. 23050 CE 6.4%), so they are never used per strike.
// STALE LTP: a premium below its intrinsic value is impossible (e.g. 22900 CE ₹221.85 with spot 23,146 → intrinsic ₹246); for
// those rows the model's own price is used and the row is flagged. Results are then made arbitrage-free across strikes.
import { premiumAtLevel, yearsToExpiry, bsPrice, bsGamma, bsDelta } from "../analysis/greeks";
import { liquidity } from "./premiumCenter";

export interface CalcRow { strike: number; side: "CE" | "PE"; ltp: number | null; iv: number | null; delta: number | null; est: number | null; chg: number | null; chgPct: number | null; money: "ITM" | "ATM" | "OTM"; stale: boolean }
const okIv = (v: any) => (typeof v === "number" && v > 1 && v < 200 ? v : null);   // percent; 0 / garbage → missing

/** One IV for the expiry: the average of the ATM call and put IV (each must be valid); else one leg; else the median of all. */
export function expiryIv(strikes: any[], spot: number): number | null {
  if (!strikes.length) return null;
  const atm = strikes.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b));
  const c = okIv(atm.ceIv), p = okIv(atm.peIv);
  if (c != null && p != null) return (c + p) / 2;
  if (c != null || p != null) return (c ?? p)!;
  const all = strikes.flatMap((r) => [okIv(r.ceIv), okIv(r.peIv)]).filter((v): v is number => v != null).sort((a, b) => a - b);
  return all.length ? all[Math.floor(all.length / 2)] : null;
}

export function premiumCalc(o: { spot: number; level: number; step: number; expiry: string | null; mins: number; strikes: any[]; strike?: number | null; nowMs?: number }) {
  const t = yearsToExpiry(o.expiry, o.nowMs), tAt = t == null ? null : t - Math.max(0, o.mins) / (365 * 24 * 60);
  const atmS = Math.round(o.spot / o.step) * o.step, atmL = Math.round(o.level / o.step) * o.step, ivAll = expiryIv(o.strikes, o.spot);
  const near = [...new Set([-2, -1, 0, 1, 2].flatMap((k) => [atmS + k * o.step, atmL + k * o.step]))].sort((a, b) => a - b);
  const want = o.strike != null ? [o.strike] : near;
  // price the wider neighbourhood too, so the across-strike check also covers the requested strike
  const priced = [...new Set([...near, ...want])].sort((a, b) => a - b);
  const est = new Map<string, number | null>(), meta = new Map<string, any>();
  for (const k of priced) {
    const r = o.strikes.find((x: any) => x.strike === k); if (!r) continue;
    for (const side of ["CE", "PE"] as const) {
      const p = side === "CE" ? "ce" : "pe", ltp = r[`${p}Ltp`] ?? null, iv = ivAll;
      const intrNow = side === "CE" ? Math.max(0, o.spot - k) : Math.max(0, k - o.spot), stale = ltp == null || ltp < intrNow - 0.5;
      let e: number | null;
      if (!stale) e = premiumAtLevel({ type: side, strike: k, spot: o.spot, ltp, delta: r[`${p}Delta`] || null, gamma: r[`${p}Gamma`] ?? null, iv, tYears: t, level: o.level, tYearsAt: tAt });
      else {   // the quoted premium cannot be right (below intrinsic) → the model's own price at the target
        const intrAt = side === "CE" ? Math.max(0, o.level - k) : Math.max(0, k - o.level);
        e = iv != null && tAt != null && tAt > 0 ? bsPrice({ spot: o.level, strike: k, tYears: tAt, iv: iv / 100 }, side) : intrAt;
        if (e != null) e = Math.max(e, intrAt);
      }
      est.set(k + side, e);
      meta.set(k + side, { ltp, iv, delta: r[`${p}Delta`] ?? null, stale });
    }
  }
  // arbitrage-free across strikes: CE non-increasing as the strike rises, PE non-decreasing; never below intrinsic
  const ks = priced.filter((k) => est.has(k + "CE"));
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i], ce = est.get(k + "CE"), pe = est.get(k + "PE");
    if (ce != null) est.set(k + "CE", Math.max(o.level - k, 0, i ? Math.min(ce, est.get(ks[i - 1] + "CE") ?? ce) : ce));
    if (pe != null) est.set(k + "PE", Math.max(k - o.level, 0, pe));
  }
  for (let i = ks.length - 2; i >= 0; i--) { const k = ks[i], pe = est.get(k + "PE"), up = est.get(ks[i + 1] + "PE"); if (pe != null && up != null) est.set(k + "PE", Math.min(pe, up)); }
  const rows: CalcRow[] = [];
  for (const k of want) for (const side of ["CE", "PE"] as const) {
    if (!meta.has(k + side)) continue;
    const m = meta.get(k + side), e = est.get(k + side) ?? null, ev = e == null ? null : Math.round(e * 100) / 100;
    const chg = ev != null && m.ltp != null ? Math.round((ev - m.ltp) * 100) / 100 : null;
    rows.push({ strike: k, side, ltp: m.ltp, iv: m.iv != null ? Math.round(m.iv * 10) / 10 : null, delta: m.delta, est: ev, chg, chgPct: chg != null && m.ltp ? Math.round((chg / m.ltp) * 1000) / 10 : null, money: k === atmS ? "ATM" : (side === "CE") === (k < o.spot) ? "ITM" : "OTM", stale: !!m.stale });
  }
  return { spot: o.spot, level: o.level, move: Math.round((o.level - o.spot) * 100) / 100, mins: o.mins, expiry: o.expiry, daysToExpiry: t == null ? null : Math.round(t * 365 * 10) / 10, iv: ivAll != null ? Math.round(ivAll * 10) / 10 : null, rows };
}

// ============================ 🔥 HOT PREMIUMS — the 5 best calls and 5 best puts for a buyer right now ============================
// Every strike within ATM ± 8 with a live, two-sided, non-stale quote is priced with the calculator's own model:
//   UPSIDE = premium if the index reaches the side's target within the horizon (time decay included), minus the spread paid
//   RISK   = premium lost if the index moves the SAME distance the other way in the same time
//   HALF   = premium if the index gets only HALF way in that time (how the strike holds up when the move stalls)
//   R:R    = upside ÷ risk. Ranked by R:R, scaled for the delta an experienced buyer wants: 0.30–0.60 full, 0.20–0.30 ×0.85,
//            outside ×0.7 (a far out-of-the-money lottery ticket loses most when the move stalls; deep ITM gives little leverage);
//            a WIDE spread ×0.7. POOR liquidity is left out. After the close (no quotes, e.g. BSE) rows show NO QUOTE, never hot.
// 🔥 HOT = the top row of a side only when ALL hold: GOOD liquidity, delta 0.30–0.60, R:R ≥ 1.3, upside ≥ 20 % after the spread,
//          and it is not losing money even if the move stops half way.
// A model estimate for choosing a strike — it never gives or blocks a trade (the plan and its checks do that).
export interface HotRow { strike: number; side: "CE" | "PE"; money: "ITM" | "ATM" | "OTM"; rank: number; ltp: number; delta: number | null; gamma: number | null; greeksModel: boolean; atTarget: number; upPct: number; atAgainst: number; riskPct: number; rr: number; score: number;
  atHalf: number; halfPct: number; liq: string; spread: number | null; spreadPct: number | null; volume: number | null; oi: number | null; hot: boolean; why: string }
export function hotPremiums(o: { spot: number; step: number; expiry: string | null; strikes: any[]; ceTarget: number; peTarget: number; horizonMin: number; nowMs?: number; noQuotesOk?: boolean }) {
  const atm = Math.round(o.spot / o.step) * o.step, r2 = (v: number) => Math.round(v * 100) / 100;
  const near = o.strikes.filter((s) => Math.abs(s.strike - atm) <= 5 * o.step), sp: number[] = [];
  for (const s of near) for (const [b, a] of [[s.ceBid, s.ceAsk], [s.peBid, s.peAsk]]) if (b > 0 && a >= b) sp.push(((a - b) / ((a + b) / 2)) * 100);
  sp.sort((x, y) => x - y); const medPct = sp.length ? sp[Math.floor(sp.length / 2)] : null;
  const side = (S: "CE" | "PE"): HotRow[] => {
    const target = S === "CE" ? o.ceTarget : o.peTarget, dist = Math.abs(target - o.spot), against = S === "CE" ? o.spot - dist : o.spot + dist, p = S === "CE" ? "ce" : "pe";
    const rows: HotRow[] = [];
    for (const r of o.strikes.filter((x) => Math.abs(x.strike - atm) <= 8 * o.step)) {
      const ltp = r[`${p}Ltp`]; if (!(ltp > 0)) continue;
      const L0 = liquidity(r[`${p}Bid`], r[`${p}Ask`], ltp, medPct, r[`${p}Vol`]);
      if (L0.status === "POOR" || (L0.status === "NOT AVAILABLE" && !o.noQuotesOk)) continue;
      const L = L0.status === "NOT AVAILABLE" ? { ...L0, status: "NO QUOTE" } : L0;
      const up = premiumCalc({ spot: o.spot, level: target, step: o.step, expiry: o.expiry, mins: o.horizonMin, strikes: o.strikes, strike: r.strike, nowMs: o.nowMs }).rows.find((x) => x.side === S);
      const dn = premiumCalc({ spot: o.spot, level: against, step: o.step, expiry: o.expiry, mins: o.horizonMin, strikes: o.strikes, strike: r.strike, nowMs: o.nowMs }).rows.find((x) => x.side === S);
      const hf = premiumCalc({ spot: o.spot, level: (o.spot + target) / 2, step: o.step, expiry: o.expiry, mins: o.horizonMin, strikes: o.strikes, strike: r.strike, nowMs: o.nowMs }).rows.find((x) => x.side === S);
      if (!up || !dn || !hf || up.stale || up.est == null || dn.est == null || hf.est == null) continue;
      const upPct = ((up.est - ltp - (L.spread ?? 0)) / ltp) * 100, riskPct = Math.max(1, ((ltp - dn.est) / ltp) * 100), rr = upPct / riskPct;
      if (upPct <= 0) continue;
      // delta / gamma: the feed's; when Dhan leaves them out, Black-Scholes at the expiry IV (flagged greeksModel)
      const tY = yearsToExpiry(o.expiry, o.nowMs), ivE = expiryIv(o.strikes, o.spot), bs = tY != null && tY > 0 && ivE != null ? { spot: o.spot, strike: r.strike, tYears: tY, iv: ivE / 100 } : null;
      const dRaw = r[`${p}Delta`] || (bs ? bsDelta(bs, S) : null), gRaw = r[`${p}Gamma`] || (bs ? bsGamma(bs) : null), greeksModel = !r[`${p}Delta`] || !r[`${p}Gamma`];
      const d = dRaw != null ? Math.abs(dRaw) : null, inBand = d != null && d >= 0.3 && d <= 0.6, nearBand = d != null && d >= 0.2 && d < 0.3;
      const score = rr * (L.status === "GOOD" ? 1 : 0.7) * (inBand ? 1 : nearBand ? 0.85 : 0.7), halfPct = ((hf.est - ltp - (L.spread ?? 0)) / ltp) * 100;
      rows.push({ strike: r.strike, side: S, rank: 0, gamma: gRaw != null ? Math.round(gRaw * 1e5) / 1e5 : null, greeksModel, money: r.strike === atm ? "ATM" : (S === "CE") === (r.strike < o.spot) ? "ITM" : "OTM", ltp, delta: d != null ? r2(d) : null,
        atTarget: r2(up.est), atHalf: r2(hf.est), halfPct: Math.round(halfPct), upPct: Math.round(upPct), atAgainst: r2(dn.est), riskPct: Math.round(riskPct), rr: r2(rr), score: r2(score),
        liq: L.status, spread: L.spread, spreadPct: L.spreadPct, volume: r[`${p}Vol`] ?? null, oi: r[`${p}Oi`] ?? null, hot: false,
        why: [L.status === "GOOD" ? "tight spread" : L.status === "NO QUOTE" ? "no live quote — liquidity not checked" : "spread wide", d == null ? "no delta in the feed" : inBand ? `delta ${r2(d)}` : d < 0.3 ? `delta ${r2(d)} — out of the money, needs the full move fast` : `delta ${r2(d)} — deep ITM, little leverage`].join(" · ") });
    }
    rows.sort((a, b) => b.score - a.score || b.upPct - a.upPct);
    const t = rows[0]; if (t && t.liq === "GOOD" && t.delta != null && t.delta >= 0.3 && t.delta <= 0.6 && t.rr >= 1.3 && t.upPct >= 20 && t.halfPct >= 0) t.hot = true;
    // top 5 by score, shown in STRIKE order (rank kept on each row)
    return rows.slice(0, 5).map((x, i) => ({ ...x, rank: i + 1 })).sort((a, b) => a.strike - b.strike);
  };
  return { ce: side("CE"), pe: side("PE"), ceTarget: r2(o.ceTarget), peTarget: r2(o.peTarget), horizonMin: o.horizonMin, chainMedianSpreadPct: medPct != null ? r2(medPct) : null };
}
