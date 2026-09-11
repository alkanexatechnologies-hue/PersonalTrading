import { OiAnalysis } from "../types";
import { istTimeStr } from "../util/istTime";
import { Baseline, getBaseline, recordOiBaseline, oiBaselineStrike, oiBaselineUnderlying } from "./baselineStore";

// Re-exported so existing callers (routes/api.ts) importing these from this
// module keep working unchanged - the persistence itself now lives in
// baselineStore.ts, split out so it isn't interleaved with the classification
// logic below (see the comment in baselineStore.ts for why).
export { recordOiBaseline, oiBaselineStrike, oiBaselineUnderlying };

// ---- OI-change tracker (ITM / ATM / OTM, same strike, both sides) ----
// The feed gives LIVE per-strike OI + premium but not the day's CHANGE. So we
// diff live values against a per-strike BASELINE (OI + LTP) captured at the
// first reading of the day (see baselineStore.ts). We surface THREE strikes -
// one below spot, the ATM, one above spot - and at EACH strike both the Call
// (CE) and Put (PE), with their OI change AND price (premium) change. At a
// strike below spot the CE is ITM and the PE is OTM; above spot it flips; at
// ATM both are ATM.
//   CE OI rising = call WRITING  -> resistance (bearish);  falling = covering (bullish)
//   PE OI rising = put  WRITING  -> support    (bullish);  falling = unwinding (bearish)
// Price is coloured by its BULLISH-for-underlying implication so calls & puts read
// in the same directional frame (CE up = bullish, PE up = bearish).

export interface OiLeg {
  type: "CE" | "PE";
  moneyness: "ITM" | "ATM" | "OTM";
  oi: number;
  oiChg: number | null; oiChgPct: number | null;
  ltp: number | null; ltpChg: number | null; ltpChgPct: number | null;
  vol: number | null;      // traded volume (activity), when the feed provides it
  action: string;          // Call/Put writing / unwinding
  bullish: boolean | null; // does this leg's OI change lean bullish for the underlying?
}

export interface OiLevel { strike: number; ce: OiLeg; pe: OiLeg; }

export interface Buildup {
  strike: number; side: "CE" | "PE";
  oiChg: number; oiChgPct: number | null;
  veryHigh: boolean;   // OI grew a lot at this strike (writing concentrated here)
  label: string;       // "resistance building" (CE) / "support building" (PE)
}

export interface OiChangeResult {
  symbol: string; name: string; type: "index" | "equity";
  underlying: number | null; atmStrike: number | null; expiry: string | null;
  baselineSpot: number | null; spotChg: number | null; spotChgPct: number | null;
  levels: OiLevel[];            // [below-spot, ATM, above-spot]
  chain: OiLevel[];             // mini option chain: ATM ±5 strikes (Call/Put ΔOI each)
  best: OiLevel | null;         // the single BEST strike (most OI action near the money)
  maxCeBuildup: Buildup | null; // strike with the biggest CALL writing (resistance)
  maxPeBuildup: Buildup | null; // strike with the biggest PUT writing (support)
  netCeChg: number | null; netPeChg: number | null;
  bias: "Bullish" | "Bearish" | "Neutral";
  note: string;
  moveRead: string;             // buildup interpreted vs the current market movement
  // Consolidated OI-based directional prediction (multi-factor):
  oiDirScore: number;           // -100..+100 (positive = bullish)
  oiVerdict: "Bullish" | "Bearish" | "Neutral";
  oiConfidence: number;         // 0..100
  oiReasons: string[];
  major: boolean; majorReason: string | null; // big move / big OI or price shift
  hasBaseline: boolean; baselineNote: string;
  asOf: number;
}

function actionFor(type: "CE" | "PE", oiChg: number | null): { action: string; bullish: boolean | null } {
  if (oiChg == null) return { action: "building baseline", bullish: null };
  if (oiChg > 0) return type === "CE" ? { action: "Call writing ↑", bullish: false } : { action: "Put writing ↑", bullish: true };
  if (oiChg < 0) return type === "CE" ? { action: "Call unwinding ↓", bullish: true } : { action: "Put unwinding ↓", bullish: false };
  return { action: "flat", bullish: null };
}

export function computeOiChange(symbol: string, name: string, type: "index" | "equity", oi: OiAnalysis | null): OiChangeResult | null {
  if (!oi || !oi.available || !oi.topStrikes || !oi.topStrikes.length || oi.underlying == null) return null;
  const spot = oi.underlying;
  const rows = oi.topStrikes;
  const base: Baseline | null = getBaseline(symbol);
  const hasBaseline = !!base;

  // ATM = strike closest to spot; plus the nearest strike below and above.
  let atmRow = rows[0];
  for (const r of rows) if (Math.abs(r.strike - spot) < Math.abs(atmRow.strike - spot)) atmRow = r;
  const belowRow = rows.filter((r) => r.strike < spot).sort((a, b) => b.strike - a.strike)[0] || null;
  const aboveRow = rows.filter((r) => r.strike > spot).sort((a, b) => a.strike - b.strike)[0] || null;

  const makeLeg = (t: "CE" | "PE", row: any, moneyness: OiLeg["moneyness"]): OiLeg => {
    const curOi = t === "CE" ? (row.ceOi || 0) : (row.peOi || 0);
    const curLtp = t === "CE" ? (row.ceLtp ?? null) : (row.peLtp ?? null);
    const b = hasBaseline ? base!.strikes.get(row.strike) : null;
    const baseOi = b ? (t === "CE" ? b.ceOi : b.peOi) : null;
    const baseLtp = b ? (t === "CE" ? b.ceLtp : b.peLtp) : null;
    const oiChg = baseOi != null ? curOi - baseOi : null;
    const oiChgPct = baseOi && baseOi > 0 && oiChg != null ? Math.round((oiChg / baseOi) * 1000) / 10 : null;
    const ltpChg = baseLtp != null && curLtp != null ? Math.round((curLtp - baseLtp) * 100) / 100 : null;
    const ltpChgPct = baseLtp && baseLtp > 0 && ltpChg != null ? Math.round((ltpChg / baseLtp) * 1000) / 10 : null;
    const vol = t === "CE" ? (row.ceVol ?? null) : (row.peVol ?? null);
    const { action, bullish } = actionFor(t, oiChg);
    return { type: t, moneyness, oi: curOi, oiChg, oiChgPct, ltp: curLtp, ltpChg, ltpChgPct, vol, action, bullish };
  };

  const levels: OiLevel[] = [];
  if (belowRow) levels.push({ strike: belowRow.strike, ce: makeLeg("CE", belowRow, "ITM"), pe: makeLeg("PE", belowRow, "OTM") });
  levels.push({ strike: atmRow.strike, ce: makeLeg("CE", atmRow, "ATM"), pe: makeLeg("PE", atmRow, "ATM") });
  if (aboveRow) levels.push({ strike: aboveRow.strike, ce: makeLeg("CE", aboveRow, "OTM"), pe: makeLeg("PE", aboveRow, "ITM") });

  // Mini option chain: ATM and 5 strikes above + 5 below the spot.
  const atmChainIdx = rows.findIndex((r) => r.strike === atmRow.strike);
  const chainRows = rows.slice(Math.max(0, atmChainIdx - 5), atmChainIdx + 6);
  const chain: OiLevel[] = chainRows.map((r) => {
    const mCe: OiLeg["moneyness"] = r.strike < spot ? "ITM" : r.strike > spot ? "OTM" : "ATM";
    const mPe: OiLeg["moneyness"] = r.strike > spot ? "ITM" : r.strike < spot ? "OTM" : "ATM";
    return { strike: r.strike, ce: makeLeg("CE", r, mCe), pe: makeLeg("PE", r, mPe) };
  });

  // Net OI change across ±3 strikes around ATM (put-writing minus call-writing).
  const atmIdx = rows.findIndex((r) => r.strike === atmRow.strike);
  const near = rows.slice(Math.max(0, atmIdx - 3), atmIdx + 4);
  let netCeChg: number | null = null, netPeChg: number | null = null;
  if (hasBaseline) {
    netCeChg = 0; netPeChg = 0;
    for (const r of near) {
      const b = base!.strikes.get(r.strike);
      if (!b) continue;
      netCeChg += (r.ceOi || 0) - b.ceOi;
      netPeChg += (r.peOi || 0) - b.peOi;
    }
  }

  let bias: OiChangeResult["bias"] = "Neutral";
  let note = "Waiting for today's baseline (captured on the first chain reading of the day).";
  if (hasBaseline && netCeChg != null && netPeChg != null) {
    const net = netPeChg - netCeChg;
    const scale = Math.max(1, Math.abs(netCeChg) + Math.abs(netPeChg));
    if (net > scale * 0.12) bias = "Bullish";
    else if (net < -scale * 0.12) bias = "Bearish";
    const ceTxt = `CE ${netCeChg >= 0 ? "+" : ""}${Math.round(netCeChg).toLocaleString("en-IN")}`;
    const peTxt = `PE ${netPeChg >= 0 ? "+" : ""}${Math.round(netPeChg).toLocaleString("en-IN")}`;
    note = bias === "Bullish" ? `Put writing dominates (${peTxt} vs ${ceTxt}) - support building, OI BULLISH.`
      : bias === "Bearish" ? `Call writing dominates (${ceTxt} vs ${peTxt}) - resistance building, OI BEARISH.`
      : `Balanced OI change (${ceTxt}, ${peTxt}).`;
  }

  // WHERE IS BUILDUP VERY HIGH? Scan ALL strikes for the biggest OI ADDITIONS
  // (writing). Max CE buildup = the strike where resistance is being built; max PE
  // buildup = where support is being built. Flag "very high" when it's outsized.
  let maxCeBuildup: Buildup | null = null, maxPeBuildup: Buildup | null = null;
  if (hasBaseline) {
    for (const r of rows) {
      const b = base!.strikes.get(r.strike);
      if (!b) continue;
      const ceC = (r.ceOi || 0) - b.ceOi;
      const peC = (r.peOi || 0) - b.peOi;
      if (ceC > 0 && (!maxCeBuildup || ceC > maxCeBuildup.oiChg)) {
        maxCeBuildup = { strike: r.strike, side: "CE", oiChg: Math.round(ceC), oiChgPct: b.ceOi > 0 ? Math.round((ceC / b.ceOi) * 1000) / 10 : null, veryHigh: false, label: "resistance building" };
      }
      if (peC > 0 && (!maxPeBuildup || peC > maxPeBuildup.oiChg)) {
        maxPeBuildup = { strike: r.strike, side: "PE", oiChg: Math.round(peC), oiChgPct: b.peOi > 0 ? Math.round((peC / b.peOi) * 1000) / 10 : null, veryHigh: false, label: "support building" };
      }
    }
    // "Very high" = OI grew >= 50% at that strike, OR it dwarfs the opposite side's buildup.
    const otherCe = maxCeBuildup?.oiChg ?? 0, otherPe = maxPeBuildup?.oiChg ?? 0;
    if (maxCeBuildup) maxCeBuildup.veryHigh = (maxCeBuildup.oiChgPct != null && maxCeBuildup.oiChgPct >= 50) || (otherPe > 0 && maxCeBuildup.oiChg >= otherPe * 2.5);
    if (maxPeBuildup) maxPeBuildup.veryHigh = (maxPeBuildup.oiChgPct != null && maxPeBuildup.oiChgPct >= 50) || (otherCe > 0 && maxPeBuildup.oiChg >= otherCe * 2.5);
  }

  // ---- OI DIRECTIONAL VERDICT (multi-factor prediction from OI data) ----
  // Combines: (1) net OI flow (put vs call writing), (2) PCR level, (3) futures
  // build-up, (4) proximity to the OI support/resistance walls, (5) a very-high
  // concentrated buildup. OI is a POSITIONING read (support/resistance) + a
  // sometimes-contrarian lean - not a guarantee. Best used WITH price action.
  let oiDirScore = 0; const oiReasons: string[] = [];
  if (bias === "Bullish") { oiDirScore += 25; oiReasons.push("Put writing > call writing near ATM (support building)"); }
  else if (bias === "Bearish") { oiDirScore -= 25; oiReasons.push("Call writing > put writing near ATM (resistance building)"); }
  if (oi.pcr != null) {
    if (oi.pcr >= 1.2) { oiDirScore += 15; oiReasons.push(`PCR ${oi.pcr} (put-heavy → bullish lean)`); }
    else if (oi.pcr <= 0.8) { oiDirScore -= 15; oiReasons.push(`PCR ${oi.pcr} (call-heavy → bearish lean)`); }
  }
  const fb = oi.futBuildup;
  if (fb === "Long buildup" || fb === "Short covering") { oiDirScore += 20; oiReasons.push(`Futures: ${fb}`); }
  else if (fb === "Short buildup" || fb === "Long unwinding") { oiDirScore -= 20; oiReasons.push(`Futures: ${fb}`); }
  if (oi.support != null && oi.resistance != null && spot) {
    const distSup = spot - oi.support, distRes = oi.resistance - spot;
    if (distSup > 0 && distRes > 0) {
      if (distSup < distRes * 0.5) { oiDirScore += 10; oiReasons.push(`Near PUT support ${oi.support} (floor → bounce lean)`); }
      else if (distRes < distSup * 0.5) { oiDirScore -= 10; oiReasons.push(`Near CALL resistance ${oi.resistance} (ceiling → cap lean)`); }
    }
  }
  if (maxPeBuildup?.veryHigh) { oiDirScore += 10; oiReasons.push(`Heavy PE writing @ ${maxPeBuildup.strike} (strong support)`); }
  if (maxCeBuildup?.veryHigh) { oiDirScore -= 10; oiReasons.push(`Heavy CE writing @ ${maxCeBuildup.strike} (strong resistance)`); }
  oiDirScore = Math.max(-100, Math.min(100, oiDirScore));
  const oiVerdict: OiChangeResult["oiVerdict"] = oiDirScore >= 20 ? "Bullish" : oiDirScore <= -20 ? "Bearish" : "Neutral";
  const oiConfidence = Math.min(100, Math.abs(oiDirScore));
  if (!oiReasons.length) oiReasons.push("No clear OI edge yet.");

  const baselineSpot = hasBaseline ? (base!.underlying ?? null) : null;
  const spotChg = baselineSpot != null && spot != null ? Math.round((spot - baselineSpot) * 100) / 100 : null;
  const spotChgPct = baselineSpot && spot ? Math.round(((spot - baselineSpot) / baselineSpot) * 10000) / 100 : null;

  // BEST STRIKE: among the strikes within ±5 of ATM, the one with the most OI
  // action (|ΔCE| + |ΔPE|) - that's where positioning is concentrating right now.
  // Falls back to the ATM strike before a baseline exists.
  let best: OiLevel | null = null;
  {
    const atmIdx2 = rows.findIndex((r) => r.strike === atmRow.strike);
    const window = rows.slice(Math.max(0, atmIdx2 - 5), atmIdx2 + 6);
    let bestRow = atmRow, bestScore = -1;
    if (hasBaseline) {
      for (const r of window) {
        const b = base!.strikes.get(r.strike);
        if (!b) continue;
        const score = Math.abs((r.ceOi || 0) - b.ceOi) + Math.abs((r.peOi || 0) - b.peOi);
        if (score > bestScore) { bestScore = score; bestRow = r; }
      }
    }
    const mCe: OiLeg["moneyness"] = bestRow.strike < spot ? "ITM" : bestRow.strike > spot ? "OTM" : "ATM";
    const mPe: OiLeg["moneyness"] = bestRow.strike > spot ? "ITM" : bestRow.strike < spot ? "OTM" : "ATM";
    best = { strike: bestRow.strike, ce: makeLeg("CE", bestRow, mCe), pe: makeLeg("PE", bestRow, mPe) };
  }

  // MOVE READ: interpret the buildup vs the current market movement.
  const moveDir = spotChgPct == null ? 0 : spotChgPct > 0.05 ? 1 : spotChgPct < -0.05 ? -1 : 0;
  const moveWord = moveDir > 0 ? "Spot UP" : moveDir < 0 ? "Spot DOWN" : "Spot flat";
  let moveRead = hasBaseline ? `${moveWord}. ` : "Baseline forming — buildup read available shortly.";
  if (hasBaseline) {
    const res = maxCeBuildup ? `resistance building at ${maxCeBuildup.strike} (CE writing${maxCeBuildup.veryHigh ? ", VERY HIGH" : ""})` : null;
    const sup = maxPeBuildup ? `support building at ${maxPeBuildup.strike} (PE writing${maxPeBuildup.veryHigh ? ", VERY HIGH" : ""})` : null;
    if (moveDir > 0) moveRead += sup ? `Move is supported — ${sup}. Next wall: ${res || "n/a"}.` : `Watch ${res || "resistance"} overhead.`;
    else if (moveDir < 0) moveRead += res ? `Move is capped — ${res}. Floor to watch: ${sup || "n/a"}.` : `Watch ${sup || "support"} below.`;
    else moveRead += [res, sup].filter(Boolean).join(" · ") || "no clear buildup yet.";
  }

  // MAJOR-movement highlight: a big underlying move, or a big OI / premium shift.
  let major = false; const reasons: string[] = [];
  if (spotChgPct != null && Math.abs(spotChgPct) >= 0.4) { major = true; reasons.push(`spot ${spotChgPct >= 0 ? "+" : ""}${spotChgPct}%`); }
  const maxOiPct = Math.max(...levels.flatMap((l) => [Math.abs(l.ce.oiChgPct ?? 0), Math.abs(l.pe.oiChgPct ?? 0)]), 0);
  if (maxOiPct >= 30) { major = true; reasons.push(`OI ${Math.round(maxOiPct)}%`); }
  const maxLtpPct = Math.max(...levels.flatMap((l) => [Math.abs(l.ce.ltpChgPct ?? 0), Math.abs(l.pe.ltpChgPct ?? 0)]), 0);
  if (maxLtpPct >= 25) { major = true; reasons.push(`premium ${Math.round(maxLtpPct)}%`); }
  if (bias !== "Neutral" && netCeChg != null && netPeChg != null && Math.abs(netPeChg - netCeChg) > (Math.abs(netCeChg) + Math.abs(netPeChg)) * 0.35) { major = true; reasons.push(`strong ${bias} OI flow`); }
  if (maxCeBuildup?.veryHigh) { major = true; reasons.push(`heavy CE writing @ ${maxCeBuildup.strike}`); }
  if (maxPeBuildup?.veryHigh) { major = true; reasons.push(`heavy PE writing @ ${maxPeBuildup.strike}`); }

  return {
    symbol, name, type, underlying: spot, atmStrike: atmRow.strike, expiry: oi.expiry,
    baselineSpot, spotChg, spotChgPct, levels, chain, best, maxCeBuildup, maxPeBuildup, netCeChg, netPeChg, bias, note, moveRead,
    oiDirScore, oiVerdict, oiConfidence, oiReasons,
    major, majorReason: major ? reasons.join(" · ") : null,
    hasBaseline, baselineNote: hasBaseline ? "since first reading today" : `baseline forming (${istTimeStr()} IST)`,
    asOf: Math.floor(Date.now() / 1000),
  };
}
