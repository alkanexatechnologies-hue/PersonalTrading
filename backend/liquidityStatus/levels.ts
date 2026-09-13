// ============================ Section 3 — Key support/resistance ============================
// Primary levels reuse OiAnalysis.support/resistance (max PUT/CALL OI strikes,
// already computed by backend/oi/oi.ts); "strength" reads the SAME strike's own
// OI-change direction from computeOiChange() rather than a new calculation.

import { OiAnalysis } from "../types";
import { OiChangeResult } from "../oi/oiChange";
import { KeyLevel } from "./types";

function strengthOf(oiChg: number | null | undefined): KeyLevel["strength"] {
  if (oiChg == null) return "UNKNOWN";
  if (oiChg > 0) return "STRONG";
  if (oiChg < 0) return "WEAKENING";
  return "MODERATE";
}

function secondStrike(oc: OiChangeResult | null, side: "ce" | "pe", exclude: number | null): { strike: number; oi: number; oiChg: number | null } | null {
  if (!oc || !oc.chain.length) return null;
  let best: { strike: number; oi: number; oiChg: number | null } | null = null;
  for (const level of oc.chain) {
    if (level.strike === exclude) continue;
    const leg = side === "ce" ? level.ce : level.pe;
    if (!best || leg.oi > best.oi) best = { strike: level.strike, oi: leg.oi, oiChg: leg.oiChg };
  }
  return best;
}

export function buildKeyLevels(oi: OiAnalysis, oc: OiChangeResult | null, spot: number, fallbackSupport: number | null, fallbackResistance: number | null): KeyLevel[] {
  const supportStrike = oi.support ?? fallbackSupport;
  const resistanceStrike = oi.resistance ?? fallbackResistance;
  const supportLevel = oc?.chain.find((l) => l.strike === supportStrike);
  const resistanceLevel = oc?.chain.find((l) => l.strike === resistanceStrike);

  const second2 = secondStrike(oc, "pe", supportStrike);
  const second3 = secondStrike(oc, "ce", resistanceStrike);

  const levels: KeyLevel[] = [
    { label: "KEY SUPPORT", price: supportStrike, oi: supportLevel?.pe.oi ?? null, oiChange: supportLevel?.pe.oiChg ?? null, strength: strengthOf(supportLevel?.pe.oiChg), distancePts: supportStrike != null ? Math.round((spot - supportStrike) * 100) / 100 : null },
    { label: "SECOND SUPPORT", price: second2?.strike ?? null, oi: second2?.oi ?? null, oiChange: second2?.oiChg ?? null, strength: strengthOf(second2?.oiChg), distancePts: second2 ? Math.round((spot - second2.strike) * 100) / 100 : null },
    { label: "KEY RESISTANCE", price: resistanceStrike, oi: resistanceLevel?.ce.oi ?? null, oiChange: resistanceLevel?.ce.oiChg ?? null, strength: strengthOf(resistanceLevel?.ce.oiChg), distancePts: resistanceStrike != null ? Math.round((resistanceStrike - spot) * 100) / 100 : null },
    { label: "SECOND RESISTANCE", price: second3?.strike ?? null, oi: second3?.oi ?? null, oiChange: second3?.oiChg ?? null, strength: strengthOf(second3?.oiChg), distancePts: second3 ? Math.round((second3.strike - spot) * 100) / 100 : null },
  ];
  return levels;
}
