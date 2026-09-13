// ============================ Sections 2 & 18 — Big Money / Liquidity Hint evidence ============================
// Never claims to observe an actual institutional order — every interpretation is
// a label derived from a formula (OI change direction + premium direction +
// volume), disclosed as such. Built entirely from computeOiChange()'s existing
// baseline-diffed per-strike data; no OI math is reimplemented here.

import { OiChangeResult } from "../oi/oiChange";
import { EvidenceInterpretation, EvidenceRow } from "./types";

function interpretLeg(side: "PUT" | "CALL", oiChg: number | null, ltpChgPct: number | null): EvidenceInterpretation {
  if (oiChg == null) return "NO CLEAR EVIDENCE";
  const writing = oiChg > 0;
  const premiumFalling = ltpChgPct != null && ltpChgPct < 0;
  const premiumRising = ltpChgPct != null && ltpChgPct > 0;

  if (side === "PUT") {
    if (writing && premiumFalling) return "PUT WRITING / SUPPORT BUILDING";
    if (!writing && premiumRising) return "PUT UNWINDING";
    if (writing) return "ACCUMULATION HINT";
    return "POSITIONING CHANGE";
  }
  if (writing && premiumFalling) return "CALL WRITING / RESISTANCE BUILDING";
  if (!writing && premiumRising) return "CALL UNWINDING";
  if (writing) return "ABSORPTION HINT"; // OI building on the call side without the usual premium-fade signature
  return "POSITIONING CHANGE";
}

export function buildEvidence(oc: OiChangeResult | null): EvidenceRow[] {
  if (!oc || !oc.hasBaseline) return [];
  const rows: EvidenceRow[] = [];

  if (oc.maxPeBuildup) {
    const level = oc.levels.find((l) => l.strike === oc.maxPeBuildup!.strike) ?? oc.chain.find((l) => l.strike === oc.maxPeBuildup!.strike);
    rows.push({
      side: "PUT", strike: oc.maxPeBuildup.strike,
      oiChange: level?.pe.oiChg ?? oc.maxPeBuildup.oiChg,
      oiChangePct: level?.pe.oiChgPct ?? oc.maxPeBuildup.oiChgPct,
      premiumChangePct: level?.pe.ltpChgPct ?? null,
      volumeMultiple: null,
      interpretation: interpretLeg("PUT", level?.pe.oiChg ?? oc.maxPeBuildup.oiChg, level?.pe.ltpChgPct ?? null),
    });
  }
  if (oc.maxCeBuildup) {
    const level = oc.levels.find((l) => l.strike === oc.maxCeBuildup!.strike) ?? oc.chain.find((l) => l.strike === oc.maxCeBuildup!.strike);
    rows.push({
      side: "CALL", strike: oc.maxCeBuildup.strike,
      oiChange: level?.ce.oiChg ?? oc.maxCeBuildup.oiChg,
      oiChangePct: level?.ce.oiChgPct ?? oc.maxCeBuildup.oiChgPct,
      premiumChangePct: level?.ce.ltpChgPct ?? null,
      volumeMultiple: null,
      interpretation: interpretLeg("CALL", level?.ce.oiChg ?? oc.maxCeBuildup.oiChg, level?.ce.ltpChgPct ?? null),
    });
  }
  return rows;
}

/** Section 2's one-line synthesis of the evidence rows — a plain description of
 * which side liquidity is shifting toward, not a claim about who is trading. */
export function summarizeEvidence(rows: EvidenceRow[]): string {
  const putBullish = rows.some((r) => r.side === "PUT" && (r.interpretation === "PUT WRITING / SUPPORT BUILDING"));
  const callBullish = rows.some((r) => r.side === "CALL" && (r.interpretation === "CALL UNWINDING"));
  const putBearish = rows.some((r) => r.side === "PUT" && r.interpretation === "PUT UNWINDING");
  const callBearish = rows.some((r) => r.side === "CALL" && r.interpretation === "CALL WRITING / RESISTANCE BUILDING");

  if ((putBullish || callBullish) && !(putBearish || callBearish)) return "Liquidity is shifting toward the bullish side.";
  if ((putBearish || callBearish) && !(putBullish || callBullish)) return "Liquidity is shifting toward the bearish side.";
  if (rows.length) return "Liquidity evidence is mixed — no clean shift to either side yet.";
  return "No liquidity evidence available yet (OI baseline not established today).";
}
