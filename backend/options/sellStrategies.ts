import { OiAnalysis, OiStrike } from "../types";
import { SymbolDef } from "../config";
import { evaluateSellAlgo } from "./highProbAlgo";

// ---- Option-selling strategy builder (premium / theta strategies) ----
// From the LIVE Groww option chain, construct the common Indian index
// premium-selling structures - short straddle, short strangle, iron condor -
// with credit, breakevens, max profit/loss, probability of profit, rough margin,
// net delta/theta, and management levels (profit target / tail stop / adjust).
//
// Selling options is HIGH RISK (naked straddle/strangle have undefined loss);
// these are decision-support + paper only, never live orders.

export interface SellLeg {
  action: "SELL" | "BUY";
  optionType: "CE" | "PE";
  strike: number;
  premium: number;
  delta: number | null;
  theta: number | null;
}

export interface SellStrategy {
  type: "Short Straddle" | "Short Strangle" | "Iron Condor";
  symbol: string;
  name: string;
  underlying: number;
  expiry: string | null;
  lotSize: number;
  legs: SellLeg[];
  netCredit: number; // per share (premium points)
  netCreditValue: number; // per lot (x lot size)
  maxProfit: number; // = net credit value
  maxLoss: number | null; // condor: defined; naked: null (use stop)
  breakevenLow: number;
  breakevenHigh: number;
  pop: number; // probability of profit (estimate, %)
  marginEstimate: number; // rough SPAN+exposure per lot
  netDelta: number; // per lot
  netThetaPerDay: number; // per lot value collected/day (positive = in your favour)
  profitTarget: number; // book at ~50% of credit (value)
  stopLoss: number; // tail stop (value) - naked ~2x credit loss
  adjustNote: string;
  note: string;
  highProb?: boolean;
  recommended?: boolean;
  algoScore?: number;
  algoNote?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const nearestStrikeRow = (rows: OiStrike[], target: number) =>
  rows.reduce<OiStrike | null>((b, r) => (b == null || Math.abs(r.strike - target) < Math.abs(b.strike - target) ? r : b), null);

// Pick an OTM row by target |delta| (e.g., 0.2 for a strangle short).
function rowByCallDelta(rows: OiStrike[], atm: number, targetDelta: number): OiStrike | null {
  const otm = rows.filter((r) => r.strike > atm && r.ceLtp != null);
  let best: OiStrike | null = null;
  let bestD = Infinity;
  for (const r of otm) {
    const d = Math.abs((r.ceDelta != null ? Math.abs(r.ceDelta) : 0.5) - targetDelta);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}
function rowByPutDelta(rows: OiStrike[], atm: number, targetDelta: number): OiStrike | null {
  const otm = rows.filter((r) => r.strike < atm && r.peLtp != null);
  let best: OiStrike | null = null;
  let bestD = Infinity;
  for (const r of otm) {
    const d = Math.abs((r.peDelta != null ? Math.abs(r.peDelta) : 0.5) - targetDelta);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

export function buildSellStrategies(
  oi: OiAnalysis,
  def: SymbolDef,
  regime?: { adx: number | null; atr: number | null }
): SellStrategy[] {
  if (!oi.available || oi.underlying == null || !oi.topStrikes?.length) return [];
  const rows = oi.topStrikes.slice().sort((a, b) => a.strike - b.strike);
  const lot = def.lotSize || 1;
  const under = oi.underlying;
  const atmRow = nearestStrikeRow(rows, under);
  if (!atmRow) return [];
  const atm = atmRow.strike;
  const out: SellStrategy[] = [];

  const legTheta = (r: OiStrike | null, t: "CE" | "PE") =>
    r ? (t === "CE" ? r.ceTheta ?? null : r.peTheta ?? null) : null;
  const legDelta = (r: OiStrike | null, t: "CE" | "PE") =>
    r ? (t === "CE" ? r.ceDelta ?? null : r.peDelta ?? null) : null;

  // POP for a two-short structure ~ 1 - (|callDelta| + |putDelta|) (delta ~ prob ITM).
  const popOf = (cd: number | null, pd: number | null) =>
    clamp(Math.round((1 - (Math.abs(cd ?? 0.5) + Math.abs(pd ?? 0.5))) * 100), 5, 95);

  const marginNaked = round2(0.12 * under * lot); // rough SPAN+exposure for index naked
  const collectedTheta = (ceT: number | null, peT: number | null) =>
    round2((Math.abs(ceT ?? 0) + Math.abs(peT ?? 0)) * lot);

  // ---- Short Straddle: sell ATM CE + ATM PE ----
  if (atmRow.ceLtp != null && atmRow.peLtp != null) {
    const credit = atmRow.ceLtp + atmRow.peLtp;
    const creditVal = round2(credit * lot);
    const cd = legDelta(atmRow, "CE");
    const pd = legDelta(atmRow, "PE");
    out.push({
      type: "Short Straddle", symbol: def.symbol, name: def.name, underlying: under, expiry: oi.expiry, lotSize: lot,
      legs: [
        { action: "SELL", optionType: "CE", strike: atm, premium: round2(atmRow.ceLtp), delta: cd, theta: legTheta(atmRow, "CE") },
        { action: "SELL", optionType: "PE", strike: atm, premium: round2(atmRow.peLtp), delta: pd, theta: legTheta(atmRow, "PE") },
      ],
      netCredit: round2(credit), netCreditValue: creditVal, maxProfit: creditVal, maxLoss: null,
      breakevenLow: round2(atm - credit), breakevenHigh: round2(atm + credit),
      pop: popOf(cd, pd), marginEstimate: marginNaked,
      netDelta: round2(((-(cd ?? 0)) + (-(pd ?? 0))) * lot), // short call -delta, short put +delta (pd is negative)
      netThetaPerDay: collectedTheta(legTheta(atmRow, "CE"), legTheta(atmRow, "PE")),
      profitTarget: round2(creditVal * 0.5), stopLoss: round2(creditVal * 2),
      adjustNote: `Adjust/exit if price breaks the breakevens (${round2(atm - credit)} / ${round2(atm + credit)}) or net delta gets large.`,
      note: `Sell ATM ${atm} CE+PE. Best when you expect the index to stay near ${atm} and IV to fall. Undefined loss - hard stop required.`,
    });
  }

  // ---- Short Strangle: sell ~0.2-delta OTM CE and PE ----
  const scr = rowByCallDelta(rows, atm, 0.2);
  const spr = rowByPutDelta(rows, atm, 0.2);
  if (scr?.ceLtp != null && spr?.peLtp != null) {
    const credit = scr.ceLtp + spr.peLtp;
    const creditVal = round2(credit * lot);
    const cd = scr.ceDelta ?? null;
    const pd = spr.peDelta ?? null;
    out.push({
      type: "Short Strangle", symbol: def.symbol, name: def.name, underlying: under, expiry: oi.expiry, lotSize: lot,
      legs: [
        { action: "SELL", optionType: "CE", strike: scr.strike, premium: round2(scr.ceLtp), delta: cd, theta: scr.ceTheta ?? null },
        { action: "SELL", optionType: "PE", strike: spr.strike, premium: round2(spr.peLtp), delta: pd, theta: spr.peTheta ?? null },
      ],
      netCredit: round2(credit), netCreditValue: creditVal, maxProfit: creditVal, maxLoss: null,
      breakevenLow: round2(spr.strike - credit), breakevenHigh: round2(scr.strike + credit),
      pop: popOf(cd, pd), marginEstimate: marginNaked,
      netDelta: round2(((-(cd ?? 0)) + (-(pd ?? 0))) * lot),
      netThetaPerDay: collectedTheta(scr.ceTheta ?? null, spr.peTheta ?? null),
      profitTarget: round2(creditVal * 0.5), stopLoss: round2(creditVal * 2),
      adjustNote: `Adjust the tested side if price nears ${spr.strike} (PE) or ${scr.strike} (CE); exit if a short strike is breached.`,
      note: `Sell ${scr.strike} CE + ${spr.strike} PE (~0.2 delta). Wider safety than a straddle, smaller credit. Undefined loss - hard stop required.`,
    });
  }

  // ---- Iron Condor: shorts ~1.2% OTM, protective wings 3 steps beyond. Selected
  // by strike VALUE (robust to non-uniform strike spacing in the chain window). ----
  // Infer the strike step from the median gap between consecutive strikes.
  const diffs = rows.slice(1).map((r, i) => r.strike - rows[i].strike).filter((d) => d > 0).sort((a, b) => a - b);
  const step = def.strikeStep || (diffs.length ? diffs[Math.floor(diffs.length / 2)] : Math.max(1, Math.round(under * 0.0005)));
  const shortDist = Math.max(step * 2, Math.round((under * 0.012) / step) * step); // ~1.2% OTM, >= 2 steps
  const wingSpan = step * 3;
  const sc = nearestStrikeRow(rows, atm + shortDist); // short call
  const sp = nearestStrikeRow(rows, atm - shortDist); // short put
  const cw = nearestStrikeRow(rows, atm + shortDist + wingSpan); // long call wing
  const pw = nearestStrikeRow(rows, atm - shortDist - wingSpan); // long put wing
  if (
    sc && sp && cw && pw &&
    sc.ceLtp != null && sp.peLtp != null && cw.ceLtp != null && pw.peLtp != null &&
    cw.strike > sc.strike && sc.strike > atm && atm > sp.strike && sp.strike > pw.strike
  ) {
    const credit = sc.ceLtp + sp.peLtp - cw.ceLtp - pw.peLtp;
    const wingWidth = Math.min(cw.strike - sc.strike, sp.strike - pw.strike); // conservative
    if (credit > 0 && credit < wingWidth) {
      const creditVal = round2(credit * lot);
      const maxLoss = round2((wingWidth - credit) * lot);
      const cd = sc.ceDelta ?? null;
      const pd = sp.peDelta ?? null;
      out.push({
        type: "Iron Condor", symbol: def.symbol, name: def.name, underlying: under, expiry: oi.expiry, lotSize: lot,
        legs: [
          { action: "SELL", optionType: "CE", strike: sc.strike, premium: round2(sc.ceLtp), delta: cd, theta: sc.ceTheta ?? null },
          { action: "SELL", optionType: "PE", strike: sp.strike, premium: round2(sp.peLtp), delta: pd, theta: sp.peTheta ?? null },
          { action: "BUY", optionType: "CE", strike: cw.strike, premium: round2(cw.ceLtp), delta: cw.ceDelta ?? null, theta: cw.ceTheta ?? null },
          { action: "BUY", optionType: "PE", strike: pw.strike, premium: round2(pw.peLtp), delta: pw.peDelta ?? null, theta: pw.peTheta ?? null },
        ],
        netCredit: round2(credit), netCreditValue: creditVal, maxProfit: creditVal, maxLoss,
        breakevenLow: round2(sp.strike - credit), breakevenHigh: round2(sc.strike + credit),
        pop: popOf(cd, pd), marginEstimate: round2(maxLoss + creditVal), // defined risk
        netDelta: round2(((-(cd ?? 0)) + (-(pd ?? 0))) * lot),
        netThetaPerDay: collectedTheta(sc.ceTheta ?? null, sp.peTheta ?? null),
        profitTarget: round2(creditVal * 0.5), stopLoss: round2(creditVal * 2),
        adjustNote: `Defined risk (max loss ${maxLoss}). Exit/adjust if a short strike (${sc.strike}/${sp.strike}) is breached.`,
        note: `Sell ${sc.strike} CE / ${sp.strike} PE, buy ${cw.strike} CE / ${pw.strike} PE wings. DEFINED risk - safest premium-selling structure.`,
      });
    }
  }

  const ctx = { adx: regime?.adx ?? null, atr: regime?.atr ?? null };
  for (const s of out) {
    const hp = evaluateSellAlgo(s, ctx);
    s.highProb = hp.pass;
    s.algoScore = hp.score;
    s.algoNote = hp.pass
      ? `High-prob sell: ${hp.notes.join(" · ") || "clears range + POP gates"}.`
      : `Not high-prob: ${hp.failed.join("; ")}.`;
  }
  // Prefer one defined-risk pick per underlying when any condor clears.
  const condorOk = out.find((s) => s.type === "Iron Condor" && s.highProb);
  for (const s of out) {
    s.recommended = condorOk ? s === condorOk : !!s.highProb && s.type !== "Short Straddle";
  }
  out.sort((a, b) => (Number(b.recommended) - Number(a.recommended)) || (Number(b.highProb) - Number(a.highProb)) || (b.algoScore ?? 0) - (a.algoScore ?? 0));
  return out;
}
