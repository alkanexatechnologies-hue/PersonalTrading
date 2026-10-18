// ============================ Premium calculator — "what will the premium be if the index goes to X (after N minutes)?" ============================
// Same model as the plan cards (analysis/greeks premiumAtLevel): the LIVE premium + the Black-Scholes change from the live
// spot to the target index level, using each strike's live IV; with "after N minutes" the time left shrinks (time decay).
// Falls back to delta-gamma when IV is missing. An estimate — real premiums also move with IV and demand.
import { premiumAtLevel, yearsToExpiry } from "../analysis/greeks";

export interface CalcRow { strike: number; side: "CE" | "PE"; ltp: number | null; iv: number | null; delta: number | null; est: number | null; chg: number | null; chgPct: number | null; money: "ITM" | "ATM" | "OTM" }
export function premiumCalc(o: { spot: number; level: number; step: number; expiry: string | null; mins: number; strikes: any[]; strike?: number | null; nowMs?: number }) {
  const t = yearsToExpiry(o.expiry, o.nowMs), tAt = t == null ? null : t - Math.max(0, o.mins) / (365 * 24 * 60);
  const atmS = Math.round(o.spot / o.step) * o.step, atmL = Math.round(o.level / o.step) * o.step;
  const want = o.strike != null ? [o.strike] : [...new Set([-2, -1, 0, 1, 2].flatMap((k) => [atmS + k * o.step, atmL + k * o.step]))].sort((a, b) => a - b);
  const rows: CalcRow[] = [];
  for (const k of want) {
    const r = o.strikes.find((x: any) => x.strike === k); if (!r) continue;
    for (const side of ["CE", "PE"] as const) {
      const p = side === "CE" ? "ce" : "pe", ltp = r[`${p}Ltp`] ?? null, iv = r[`${p}Iv`] ?? null, delta = r[`${p}Delta`] ?? null;
      const est = premiumAtLevel({ type: side, strike: k, spot: o.spot, ltp, delta, gamma: r[`${p}Gamma`] ?? null, iv, tYears: t, level: o.level, tYearsAt: tAt });
      const chg = est != null && ltp != null ? Math.round((est - ltp) * 100) / 100 : null;
      const money = k === atmS ? "ATM" : (side === "CE") === (k < o.spot) ? "ITM" : "OTM";
      rows.push({ strike: k, side, ltp, iv, delta, est, chg, chgPct: chg != null && ltp ? Math.round((chg / ltp) * 1000) / 10 : null, money });
    }
  }
  return { spot: o.spot, level: o.level, move: Math.round((o.level - o.spot) * 100) / 100, mins: o.mins, expiry: o.expiry, daysToExpiry: t == null ? null : Math.round(t * 365 * 10) / 10, rows };
}
