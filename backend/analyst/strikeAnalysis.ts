import { OiAnalysis, OiStrike } from "../types";

// ===================== Live Option Strike Analysis (read-only) =====================
// For the selected index, review the option strikes around ATM using ONLY the
// data the existing option chain provides, and surface which strikes are actually
// responding + liquid. It recommends NOTHING on its own: the side follows the
// Master direction and the STATUS follows the Master/Command final action. If the
// data is stale or thin it says so. It never fabricates expected profit.
//
// Principled measures (not arbitrary formulas):
//   • Responsiveness = |delta| — the option's own sensitivity of premium to a
//     move in the underlying (textbook; ITM ≈ high, ATM ≈ 0.5, OTM ≈ low).
//   • Liquidity      = open interest + traded volume (both from the chain).
//   • Activity       = OI change + short-window LTP change (diffed vs the last
//     snapshot this process saw; null on the first sample).
//   • Spread / depth  = NOT provided by the chain → reported INSUFFICIENT DATA,
//     never guessed.

export type Side = "CE" | "PE";
export type Moneyness = "ITM" | "ATM" | "OTM";
export type Assessment = "RESPONSIVE" | "LIQUID" | "BALANCED" | "WEAK" | "AVOID" | "INSUFFICIENT DATA";

export interface StrikeRow {
  strike: number;
  side: Side;
  moneyness: Moneyness;
  ltp: number | null;
  ltpChg: number | null;     // vs last snapshot this process saw
  ltpChgPct: number | null;
  oi: number | null;
  oiChg: number | null;
  volume: number | null;
  delta: number | null;      // responsiveness
  iv: number | null;
  responsiveness: number | null; // |delta|, 0..1
  liquidityRank: number | null;  // 0..1 within the comparison set (OI+vol)
  assessment: Assessment;
  evidence: string;
}

export interface StrikeAnalysis {
  available: boolean;
  reason?: string;               // set when not available
  index: string;
  spot: number | null;
  expiry: string | null;
  atmStrike: number | null;
  side: Side | null;             // traded side per Master direction
  atm: { ce: StrikeRow | null; pe: StrikeRow | null };
  rows: StrikeRow[];             // the comparison set on the traded side
  primary: { strike: number; side: Side; why: string } | null;
  alternative: { strike: number; side: Side; why: string } | null;
  avoid: { strike: number; side: Side; why: string } | null;
  spreadNote: string;            // execution-quality caveat
  // Trader-friendly conclusion
  summary: {
    index: string; direction: string; atm: number | null; optionView: Side | null;
    preferred: string | null; why: string; alternative: string | null; status: string;
  };
  dataQuality: { stale: boolean; strikesWithPremium: number; hasDelta: boolean };
}

// Short-lived previous-snapshot memory for LTP change (per process).
const _lastLtp = new Map<string, { ltp: number; at: number }>();
const ltpKey = (sym: string, strike: number, side: Side) => `${sym}:${strike}:${side}`;

const num = (v: any): number | null => (typeof v === "number" && isFinite(v) ? v : null);

function sideFields(s: OiStrike, side: Side) {
  return side === "CE"
    ? { ltp: num(s.ceLtp), oi: num(s.ceOi), oiChg: num(s.ceChg), vol: num(s.ceVol), delta: num(s.ceDelta), iv: num(s.ceIv) }
    : { ltp: num(s.peLtp), oi: num(s.peOi), oiChg: num(s.peChg), vol: num(s.peVol), delta: num(s.peDelta), iv: num(s.peIv) };
}

function moneyness(strike: number, spot: number, side: Side): Moneyness {
  const atmBand = spot * 0.0015; // within ~0.15% = ATM
  if (Math.abs(strike - spot) <= atmBand) return "ATM";
  if (side === "CE") return strike < spot ? "ITM" : "OTM";
  return strike > spot ? "ITM" : "OTM";
}

function buildRow(sym: string, s: OiStrike, side: Side, spot: number): StrikeRow {
  const f = sideFields(s, side);
  const key = ltpKey(sym, s.strike, side);
  const prev = _lastLtp.get(key);
  let ltpChg: number | null = null, ltpChgPct: number | null = null;
  if (f.ltp != null) {
    if (prev && prev.ltp > 0) { ltpChg = Math.round((f.ltp - prev.ltp) * 100) / 100; ltpChgPct = Math.round((ltpChg / prev.ltp) * 1000) / 10; }
    _lastLtp.set(key, { ltp: f.ltp, at: Date.now() });
  }
  const responsiveness = f.delta != null ? Math.abs(f.delta) : null;
  return {
    strike: s.strike, side, moneyness: moneyness(s.strike, spot, side),
    ltp: f.ltp, ltpChg, ltpChgPct, oi: f.oi, oiChg: f.oiChg, volume: f.vol, delta: f.delta, iv: f.iv,
    responsiveness, liquidityRank: null, assessment: "INSUFFICIENT DATA", evidence: "",
  };
}

/** Analyse the strikes around ATM for the selected index. Read-only. */
export function analyzeStrikes(oi: OiAnalysis | null, direction: "BULLISH" | "BEARISH" | "NEUTRAL", opts: { stale?: boolean; finalAction?: string; masterVerdict?: string; name?: string } = {}): StrikeAnalysis {
  const index = oi?.symbol || "";
  const indexName = opts.name || index;
  const spot = oi?.underlying ?? null;
  const strikes = (oi?.topStrikes || []).filter((s) => s && typeof s.strike === "number");
  const withPrem = strikes.filter((s) => (num(s.ceLtp) ?? 0) > 0 || (num(s.peLtp) ?? 0) > 0);
  const hasDelta = strikes.some((s) => num(s.ceDelta) != null || num(s.peDelta) != null);

  const status = opts.finalAction === "TAKE" ? "TAKE" : opts.masterVerdict === "GO" ? "READY" : "WAIT";
  const empty = (reason: string): StrikeAnalysis => ({
    available: false, reason, index, spot, expiry: oi?.expiry ?? null, atmStrike: null, side: null,
    atm: { ce: null, pe: null }, rows: [], primary: null, alternative: null, avoid: null,
    spreadNote: "Bid/ask depth is not in the option feed — execution quality can't be measured.",
    summary: { index: indexName, direction, atm: null, optionView: null, preferred: null, why: reason, alternative: null, status },
    dataQuality: { stale: !!opts.stale, strikesWithPremium: withPrem.length, hasDelta },
  });

  if (!oi || !oi.available) return empty("DATA UNAVAILABLE");
  if (opts.stale) return empty("DATA UNAVAILABLE — option chain is stale");
  if (spot == null || !withPrem.length) return empty("INSUFFICIENT DATA — no live premiums in the chain");

  // ATM strike = nearest chart strike to spot.
  const atmStrike = strikes.reduce((b, s) => (b == null || Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b), null as OiStrike | null)!.strike;
  const sorted = strikes.slice().sort((a, b) => a.strike - b.strike);
  const atmIdx = sorted.findIndex((s) => s.strike === atmStrike);

  const atmRow = sorted[atmIdx];
  const atm = { ce: buildRow(index, atmRow, "CE", spot), pe: buildRow(index, atmRow, "PE", spot) };

  const side: Side | null = direction === "BULLISH" ? "CE" : direction === "BEARISH" ? "PE" : null;

  // Comparison set: ATM, one strike each side, plus one deeper ITM on the traded
  // side — bounded by what the chain actually contains (no fixed count assumed).
  const idxs = new Set<number>([atmIdx]);
  if (atmIdx - 1 >= 0) idxs.add(atmIdx - 1);
  if (atmIdx + 1 < sorted.length) idxs.add(atmIdx + 1);
  if (side === "CE" && atmIdx - 2 >= 0) idxs.add(atmIdx - 2); // deeper ITM call
  if (side === "PE" && atmIdx + 2 < sorted.length) idxs.add(atmIdx + 2); // deeper ITM put

  const analysisSide: Side = side ?? "CE";
  const rows = [...idxs].sort((a, b) => a - b).map((i) => buildRow(index, sorted[i], analysisSide, spot));

  // Liquidity rank within the set (OI + volume, normalised 0..1).
  const liq = rows.map((r) => (r.oi ?? 0) + (r.volume ?? 0));
  const maxLiq = Math.max(...liq, 1);
  rows.forEach((r, i) => { r.liquidityRank = maxLiq > 0 ? Math.round((liq[i] / maxLiq) * 100) / 100 : null; });

  // Assess each row from actual numbers.
  for (const r of rows) {
    if (r.responsiveness == null && r.liquidityRank == null) { r.assessment = "INSUFFICIENT DATA"; r.evidence = "No delta or liquidity from the feed."; continue; }
    const resp = r.responsiveness ?? 0;
    const lq = r.liquidityRank ?? 0;
    const parts: string[] = [];
    if (r.delta != null) parts.push(`delta ${r.delta.toFixed(2)}`);
    if (r.oi != null) parts.push(`OI ${fmtK(r.oi)}`);
    if (r.volume != null) parts.push(`vol ${fmtK(r.volume)}`);
    if (r.oiChg != null) parts.push(`OIΔ ${r.oiChg >= 0 ? "+" : ""}${fmtK(r.oiChg)}`);
    r.evidence = parts.join(", ") || "limited data";
    if (lq < 0.25 && r.oi != null) r.assessment = "AVOID";
    else if (resp >= 0.55 && lq >= 0.5) r.assessment = "BALANCED";
    else if (resp >= 0.55) r.assessment = "RESPONSIVE";
    else if (lq >= 0.6) r.assessment = "LIQUID";
    else r.assessment = "WEAK";
  }

  // Pick primary / alternative / avoid on the traded side, from evidence.
  let primary = null as StrikeAnalysis["primary"], alternative = null as StrikeAnalysis["alternative"], avoid = null as StrikeAnalysis["avoid"];
  if (side) {
    // Candidates that are tradable: have delta and are not the least liquid.
    const usable = rows.filter((r) => r.responsiveness != null && r.assessment !== "AVOID");
    // Rank by responsiveness gated on adequate liquidity, preferring ATM/near strikes.
    const ranked = usable.slice().sort((a, b) => {
      const la = (a.liquidityRank ?? 0) >= 0.4 ? 1 : 0, lb = (b.liquidityRank ?? 0) >= 0.4 ? 1 : 0;
      if (la !== lb) return lb - la;                       // liquid-enough first
      return (b.responsiveness ?? 0) - (a.responsiveness ?? 0); // then most responsive
    });
    if (ranked[0]) primary = { strike: ranked[0].strike, side, why: whyLine(ranked[0], "preferred") };
    if (ranked[1]) alternative = { strike: ranked[1].strike, side, why: whyLine(ranked[1], "alternative") };
    const worst = rows.filter((r) => r.assessment === "AVOID" || (r.responsiveness != null && (r.liquidityRank ?? 0) < 0.25))[0];
    if (worst) avoid = { strike: worst.strike, side, why: `Thin liquidity (${worst.evidence}) — poor fills likely.` };
  }

  const preferred = primary ? `${primary.strike} ${primary.side}` : null;
  const summaryWhy = primary
    ? whyLine(rows.find((r) => r.strike === primary!.strike)!, "preferred")
    : side ? "No strike had both adequate responsiveness and liquidity." : "Master direction is neutral — no option side selected.";

  return {
    available: true, index, spot, expiry: oi.expiry ?? null, atmStrike, side,
    atm, rows, primary, alternative, avoid,
    spreadNote: "Bid/ask depth is not in the option feed — execution quality (spread) is INSUFFICIENT DATA; liquidity is judged from OI + volume only.",
    summary: {
      index: indexName, direction, atm: atmStrike, optionView: side,
      preferred, why: summaryWhy, alternative: alternative ? `${alternative.strike} ${alternative.side}` : null, status,
    },
    dataQuality: { stale: false, strikesWithPremium: withPrem.length, hasDelta },
  };
}

function whyLine(r: StrikeRow, role: "preferred" | "alternative"): string {
  const bits: string[] = [];
  if (r.delta != null) bits.push(`responsiveness ${Math.abs(r.delta).toFixed(2)} (delta)`);
  if (r.liquidityRank != null) bits.push(`liquidity ${Math.round(r.liquidityRank * 100)}% of set`);
  if (r.oi != null) bits.push(`OI ${fmtK(r.oi)}`);
  const lead = role === "preferred" ? "Most responsive with adequate liquidity" : "Solid backup";
  return `${lead} — ${bits.join(", ") || "limited data"}. (${r.moneyness})`;
}

function fmtK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (a >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
