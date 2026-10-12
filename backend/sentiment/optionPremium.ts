// ============================ Option premium analysis + strike comparison ============================
// From the shared option-chain cache only (Dhan chain: last price, previous close, best bid / ask, IV,
// delta, volume, OI). Spread = ask − bid from the chain; missing quotes show "—", never estimated.
// Spike classification compares each premium's change since the previous close with what the spot
// move explains through delta:
//   explained = delta × Δspot ;  excess = actual change − explained
//   SPOT-DRIVEN: |excess| ≤ 15 % of the previous premium · IV-DRIVEN: excess > 15 % with spot move
//   < 0.2 % · BOTH: excess > 15 % and spot moved ≥ 0.2 % the same way · LOW-LIQUIDITY: a spike on a
//   strike with low volume. The strike comparison never picks a strike because its premium is rising;
//   the arbiter's own choice is shown as SELECTED, the others are explained against it.

export interface ChainStrike { strike: number; ceBid?: number | null; ceAsk?: number | null; peBid?: number | null; peAsk?: number | null; ceLtp?: number | null; peLtp?: number | null; cePrevClose?: number | null; pePrevClose?: number | null; ceIv?: number | null; peIv?: number | null; ceDelta?: number | null; peDelta?: number | null; ceVol?: number | null; peVol?: number | null; ceOi?: number; peOi?: number }
export type SpikeClass = "NONE" | "SPOT-DRIVEN" | "IV-DRIVEN" | "BOTH" | "LOW-LIQUIDITY SPIKE" | "NO DATA";
export interface LegView { ltp: number | null; chgPct: number | null; iv: number | null; delta: number | null; volume: number | null; liquidity: string; spike: SpikeClass; spread: number | null; spreadPct: number | null }
export function spreadOf(bid: number | null | undefined, ask: number | null | undefined): { spread: number | null; spreadPct: number | null } {
  if (!bid || !ask || ask < bid) return { spread: null, spreadPct: null };
  const mid = (bid + ask) / 2; return { spread: Math.round((ask - bid) * 100) / 100, spreadPct: Math.round(((ask - bid) / mid) * 1000) / 10 };
}
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;

export function liquidityGrade(vol: number | null, maxVol: number): string {
  if (vol == null || !maxVol) return "Unknown";
  const r = vol / maxVol; return r >= 0.6 ? "Excellent" : r >= 0.3 ? "Good" : r >= 0.1 ? "Moderate" : "Low";
}
export function classifyLeg(ltp: number | null | undefined, prev: number | null | undefined, delta: number | null | undefined, dSpot: number, spotPct: number, liquidity: string): { chgPct: number | null; spike: SpikeClass } {
  if (!ltp || !prev || delta == null) return { chgPct: ltp && prev ? r1((ltp / prev - 1) * 100) : null, spike: "NO DATA" };
  const chg = ltp - prev, excess = (chg - delta * dSpot) / prev;
  const sameWay = Math.sign(delta * dSpot) === Math.sign(chg);
  let spike: SpikeClass = Math.abs(excess) <= 0.15 ? (Math.abs(chg / prev) > 0.15 ? "SPOT-DRIVEN" : "NONE") : excess > 0.15 ? (Math.abs(spotPct) < 0.2 ? "IV-DRIVEN" : sameWay ? "BOTH" : "IV-DRIVEN") : "NONE";
  if ((spike === "IV-DRIVEN" || spike === "BOTH") && liquidity === "Low") spike = "LOW-LIQUIDITY SPIKE";
  return { chgPct: r1((chg / prev) * 100), spike };
}

export function premiumAnalysis(strikes: ChainStrike[], spot: number, spotPrevClose: number | null, width = 2) {
  if (!strikes.length || !(spot > 0)) return null;
  const atmIdx = strikes.reduce((b, s, i) => (Math.abs(s.strike - spot) < Math.abs(strikes[b].strike - spot) ? i : b), 0);
  const win = strikes.slice(Math.max(0, atmIdx - width), atmIdx + width + 1);
  const maxVol = Math.max(0, ...win.flatMap((s) => [s.ceVol || 0, s.peVol || 0]));
  const dSpot = spotPrevClose ? spot - spotPrevClose : 0, spotPct = spotPrevClose ? (dSpot / spotPrevClose) * 100 : 0;
  const leg = (s: ChainStrike, side: "ce" | "pe"): LegView => {
    const ltp = (side === "ce" ? s.ceLtp : s.peLtp) ?? null, vol = (side === "ce" ? s.ceVol : s.peVol) ?? null, liq = liquidityGrade(vol, maxVol);
    const c = classifyLeg(ltp, side === "ce" ? s.cePrevClose : s.pePrevClose, side === "ce" ? s.ceDelta : s.peDelta, dSpot, spotPct, liq);
    const sp = spreadOf(side === "ce" ? s.ceBid : s.peBid, side === "ce" ? s.ceAsk : s.peAsk);
    return { ltp, chgPct: c.chgPct, iv: (side === "ce" ? s.ceIv : s.peIv) ?? null, delta: (side === "ce" ? s.ceDelta : s.peDelta) ?? null, volume: vol, liquidity: liq, spike: c.spike, ...sp };
  };
  const rows = win.map((s) => ({ strike: s.strike, atm: s === strikes[atmIdx], ce: leg(s, "ce"), pe: leg(s, "pe") }));
  const atm = rows.find((r) => r.atm)!;
  const isSpike = (x: SpikeClass) => x === "IV-DRIVEN" || x === "BOTH" || x === "LOW-LIQUIDITY SPIKE";
  const ceSpike = isSpike(atm.ce.spike), peSpike = isSpike(atm.pe.spike);
  const detection = {
    ceSpike, peSpike, bothSidesIv: ceSpike && peSpike,
    withoutSpot: (ceSpike || peSpike) && Math.abs(spotPct) < 0.2,
    lowLiquidity: rows.some((r) => r.ce.spike === "LOW-LIQUIDITY SPIKE" || r.pe.spike === "LOW-LIQUIDITY SPIKE"),
    label: ceSpike && peSpike ? "Both sides (IV expansion)" : ceSpike ? "CE premium spike" : peSpike ? "PE premium spike" : "No spike",
    driver: !ceSpike && !peSpike ? "Premiums move in line with spot (delta-explained)" : Math.abs(spotPct) < 0.2 ? "IV expansion — spot has barely moved" : "Spot move plus IV expansion",
  };
  return { spot, spotChangePct: r2(spotPct), rows, detection, spread: "best ask − best bid from the Dhan chain", rule: "Spike = premium change beyond delta × spot move by more than 15 % of the previous close" };
}

/** Compare ATM / ITM / OTM strikes on one side. `pick` = the arbiter's chosen strike (if any). */
export function strikeComparison(strikes: ChainStrike[], spot: number, side: "CE" | "PE", plan: { entry: number; stopLoss: number; target1: number } | null, pick: number | null, costPerUnit = 2.73) {
  if (!strikes.length) return [];
  const step = strikes.length > 1 ? Math.abs(strikes[1].strike - strikes[0].strike) : 50;
  const atm = strikes.reduce((b, s) => (Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b)).strike;
  const dir = side === "CE" ? 1 : -1;
  const want: [number, string][] = [[atm - dir * step, "ITM"], [atm, "ATM"], [atm + dir * step, "OTM"], [atm + 2 * dir * step, "OTM+2"]];
  const vols = strikes.flatMap((s) => [s.ceVol || 0, s.peVol || 0]); const maxVol = Math.max(0, ...vols);
  return want.map(([k, kind]) => {
    const s = strikes.find((x) => x.strike === k); if (!s) return null;
    const ltp = (side === "CE" ? s.ceLtp : s.peLtp) ?? null, delta = (side === "CE" ? s.ceDelta : s.peDelta) ?? null, iv = (side === "CE" ? s.ceIv : s.peIv) ?? null;
    const liq = liquidityGrade((side === "CE" ? s.ceVol : s.peVol) ?? null, maxVol);
    let rr: number | null = null;
    if (plan && delta != null) {
      const d = Math.abs(delta), reward = d * Math.abs(plan.target1 - plan.entry) - costPerUnit, risk = d * Math.abs(plan.entry - plan.stopLoss) + costPerUnit;
      rr = risk > 0 ? r2(reward / risk) : null;
    }
    const why = k === pick ? "SELECTED by the arbiter (liquidity, delta and R:R after costs)"
      : kind === "ITM" ? "Higher delta, moves more with spot, but costs more and risks more per lot"
      : kind === "ATM" ? "Balanced delta and liquidity; usual choice for a 1-hour move"
      : kind === "OTM" ? "Cheaper, lower delta — needs a bigger spot move; faster time decay"
      : "Lottery-like: low delta, decays fastest — only for a strong breakout";
    const sp = spreadOf(side === "CE" ? s.ceBid : s.peBid, side === "CE" ? s.ceAsk : s.peAsk);
    return { strike: k, kind, type: side, ltp, delta, iv, liquidity: liq, spreadPct: sp.spreadPct, rr, selected: k === pick, why };
  }).filter(Boolean);
}
