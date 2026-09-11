import { SymbolDef, nearestStrike } from "../config";
import { Candle, DayIndexOutlook, DayOpportunity, OiAnalysis, SignalResult } from "../types";
import { buyContextFromCandles, evaluateBuyAlgo } from "../options/highProbAlgo";

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Daily beta + correlation of a stock vs NIFTY (from close-to-close returns). */
export function betaCorrVsNifty(stockDaily: Candle[], niftyDaily: Candle[]): { beta: number | null; corr: number | null } {
  const toRet = (c: Candle[]) => c.map((x) => x.close).map((v, i, a) => (i === 0 || !a[i - 1] ? 0 : v / a[i - 1] - 1)).slice(1);
  const s = toRet(stockDaily);
  const m = toRet(niftyDaily);
  const n = Math.min(s.length, m.length);
  if (n < 20) return { beta: null, corr: null };
  const sa = s.slice(s.length - n);
  const ma = m.slice(m.length - n);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(sa);
  const mm = mean(ma);
  let cov = 0, vs = 0, vm = 0;
  for (let i = 0; i < n; i++) {
    const ds = sa[i] - ms;
    const dm = ma[i] - mm;
    cov += ds * dm;
    vs += ds * ds;
    vm += dm * dm;
  }
  const beta = vm > 0 ? round2(cov / vm) : null;
  const corr = vs > 0 && vm > 0 ? round2(cov / Math.sqrt(vs * vm)) : null;
  return { beta, corr };
}

/**
 * Blend the technical signal, option-chain OI bias and futures buildup into a
 * single directional call with a confidence. This is a MODEL-BASED projection
 * (statistical/technical), NOT a guaranteed forecast - markets are uncertain.
 */
function directionFrom(signal: SignalResult, oi: OiAnalysis | null): { dir: 1 | -1 | 0; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const sigDir = signal.score >= 12 ? 1 : signal.score <= -12 ? -1 : 0;
  if (sigDir !== 0) reasons.push(`Technical ${sigDir > 0 ? "bullish" : "bearish"} (${signal.label}, score ${signal.score})`);
  else reasons.push(`Technical neutral (score ${signal.score})`);

  let oiDir = 0;
  if (oi && oi.available) {
    oiDir = oi.verdict.bias === "Bullish" ? 1 : oi.verdict.bias === "Bearish" ? -1 : 0;
    reasons.push(`Option OI ${oi.verdict.bias} (PCR ${oi.pcr})`);
  }
  let futDir = 0;
  if (oi && oi.available && oi.futBuildup) {
    if (oi.futBuildup === "Long buildup") futDir = 1;
    else if (oi.futBuildup === "Short buildup") futDir = -1;
    else if (oi.futBuildup === "Short covering") futDir = 1;
    else if (oi.futBuildup === "Long unwinding") futDir = -1;
    if (futDir !== 0) reasons.push(`Futures ${oi.futBuildup}`);
  }

  // Weighted vote.
  const net = sigDir * 2 + oiDir * 1.5 + futDir * 1.5;
  const dir: 1 | -1 | 0 = net >= 1.5 ? 1 : net <= -1.5 ? -1 : 0;

  // Confidence: base on the technical confidence, boosted when factors agree.
  const agree = [sigDir, oiDir, futDir].filter((d) => d !== 0 && d === dir).length;
  const conflict = [sigDir, oiDir, futDir].filter((d) => d !== 0 && d !== dir).length;
  let confidence = clamp(Math.round(signal.confidence * 0.6 + agree * 12 - conflict * 14), 10, 94);
  if (dir === 0) confidence = Math.min(confidence, 35);
  return { dir, confidence, reasons };
}

/** Index-level outlook (NIFTY / BANK NIFTY): direction + expected day range. */
export function buildIndexOutlook(def: SymbolDef, signal: SignalResult, oi: OiAnalysis | null, atrDaily: number | null): DayIndexOutlook {
  const spot = signal.price;
  const { dir, confidence, reasons } = directionFrom(signal, oi);

  // Expected day move = daily ATR (typical range), floored to a sane minimum.
  const expectedMovePts = round2(atrDaily && atrDaily > 0 ? atrDaily : spot * 0.006);
  const expectedMovePct = round2((expectedMovePts / spot) * 100);
  const upperBound = round2(spot + expectedMovePts);
  const lowerBound = round2(spot - expectedMovePts);

  const atmStrike = def.fno ? nearestStrike(spot, def) : Math.round(spot);
  // ATM straddle = market-implied move to expiry.
  let straddleImplied: number | null = null;
  if (oi && oi.available && oi.topStrikes.length) {
    const atm = oi.topStrikes.reduce((b, s) => (b == null || Math.abs(s.strike - atmStrike) < Math.abs(b.strike - atmStrike) ? s : b), null as any);
    if (atm && atm.ceLtp != null && atm.peLtp != null) straddleImplied = round2(atm.ceLtp + atm.peLtp);
  }

  return {
    symbol: def.symbol,
    name: def.name,
    spot: round2(spot),
    direction: dir === 1 ? "Bullish" : dir === -1 ? "Bearish" : "Neutral",
    confidence,
    expectedMovePts,
    expectedMovePct,
    upperBound,
    lowerBound,
    atmStrike,
    straddleImplied,
    pcr: oi && oi.available ? oi.pcr : null,
    futBuildup: oi && oi.available ? oi.futBuildup ?? null : null,
    reasons,
  };
}

/**
 * Build the directional option play for a symbol and estimate the premium swing.
 * Returns null if there's no clear direction or no live option premium.
 *
 * Premium move is delta-approximated: dPremium ≈ delta × dSpot. A near-ATM
 * option with delta ~0.5 moving one ATR typically swings well over 20% - but
 * ONLY if the move happens in the predicted direction; theta + a wrong call can
 * lose just as fast.
 */
export function buildDayOpportunity(
  def: SymbolDef,
  signal: SignalResult,
  oi: OiAnalysis | null,
  atrDaily: number | null,
  market?: {
    benchmarks: { name: string; dir: 1 | -1 | 0; daily: Candle[] }[];
    stockDaily: Candle[];
    candles?: Candle[];
    relVolume?: number;
  }
): DayOpportunity | null {
  if (!def.fno || !oi || !oi.available || !oi.topStrikes.length) return null;
  const { dir, confidence, reasons } = directionFrom(signal, oi);
  if (dir === 0) return null;

  // ---- Market alignment (NIFTY / BANK NIFTY) ----
  // Most stocks track an index. We pick the benchmark this stock correlates with
  // MOST (so bank stocks are judged against BANK NIFTY, not NIFTY). If that index
  // is pushing the OTHER way, a positively correlated stock's move tends to fade
  // or reverse - so we penalise conviction (and flag it); when they agree, we
  // give a modest boost.
  let conf = confidence;
  let marketRef: string | null = null;
  let betaMarket: number | null = null;
  let corrMarket: number | null = null;
  let marketAlignment: DayOpportunity["marketAlignment"] = "Neutral";
  const isIndex = def.type === "index";
  if (isIndex) {
    marketAlignment = "Market";
  } else if (market && market.stockDaily.length && market.benchmarks.length) {
    // Choose the benchmark with the strongest absolute correlation.
    let best: { name: string; dir: 1 | -1 | 0; beta: number | null; corr: number | null } | null = null;
    for (const b of market.benchmarks) {
      if (!b.daily.length) continue;
      const bc = betaCorrVsNifty(market.stockDaily, b.daily);
      if (bc.corr == null) continue;
      if (best == null || Math.abs(bc.corr) > Math.abs(best.corr ?? 0)) best = { name: b.name, dir: b.dir, beta: bc.beta, corr: bc.corr };
    }
    if (best) {
      marketRef = best.name;
      betaMarket = best.beta;
      corrMarket = best.corr;
      let marketDrivenDir = 0;
      if (best.corr != null && best.corr >= 0.3) marketDrivenDir = best.dir;
      else if (best.corr != null && best.corr <= -0.3) marketDrivenDir = (-best.dir as 1 | -1 | 0);
      if (marketDrivenDir !== 0) {
        const word = best.dir === 1 ? "Bullish" : best.dir === -1 ? "Bearish" : "Neutral";
        if (marketDrivenDir === dir) {
          marketAlignment = "Aligned";
          conf = clamp(conf + 8, 10, 96);
          reasons.push(`Index tailwind: ${best.name} ${word} and stock agrees (corr ${best.corr}, beta ${best.beta}).`);
        } else {
          marketAlignment = "Conflict";
          conf = clamp(conf - 18, 8, 96);
          reasons.push(
            `Index HEADWIND: ${best.name} ${word} but this play is ${dir === 1 ? "Bullish" : "Bearish"} (corr ${best.corr}, beta ${best.beta}) - ` +
              `high reversal risk if the stock snaps back to the index. Conviction cut.`
          );
        }
      } else {
        reasons.push(`Low index correlation (best ${best.name} corr ${best.corr}) - moves fairly independent of the market.`);
      }
    }
  }

  const spot = signal.price;
  const expectedMove = atrDaily && atrDaily > 0 ? atrDaily : spot * 0.006;
  const atmStrike = nearestStrike(spot, def);
  const bullish = dir === 1;
  const optionType = bullish ? "CE" : "PE";

  // ---- BEST-STRIKE selection: liquidity (OI) + delta fit - theta decay ----
  // We don't just grab ATM. Among near-money strikes we pick the one that best
  // balances: high open interest (liquid, tight fills), a delta near ~0.55 (strong
  // directional capture without paying full ATM theta), and LOW theta%/day.
  const sLtp = (s: any) => (bullish ? s.ceLtp : s.peLtp);
  const sDelta = (s: any) => (bullish ? (s.ceDelta != null ? Math.abs(s.ceDelta) : null) : s.peDelta != null ? Math.abs(s.peDelta) : null);
  const sTheta = (s: any) => (bullish ? (s.ceTheta != null ? Math.abs(s.ceTheta) : null) : s.peTheta != null ? Math.abs(s.peTheta) : null);
  const sIv = (s: any) => (bullish ? s.ceIv : s.peIv);
  const sOi = (s: any) => (bullish ? s.ceOi : s.peOi) || 0;

  const candidates = (oi.topStrikes || []).filter((s: any) => {
    const l = sLtp(s);
    const d = sDelta(s);
    return l != null && l > 0 && d != null && d >= 0.35 && d <= 0.75; // near-ATM to slightly ITM
  });
  const maxOi = Math.max(1, ...candidates.map(sOi));
  const scoreOf = (s: any) => {
    const l = sLtp(s) || 1;
    const d = sDelta(s) ?? 0.5;
    const th = sTheta(s) ?? 0;
    const thetaPct = (th / l) * 100;
    const liquidity = sOi(s) / maxOi; // 0..1 (higher OI = better)
    const deltaFit = 1 - Math.min(1, Math.abs(d - 0.55) / 0.3); // 1 at delta ~0.55
    const decayPenalty = Math.min(1, thetaPct / 50); // more theta = worse
    return liquidity * 0.5 + deltaFit * 0.3 - decayPenalty * 0.2;
  };
  const atmFallback = oi.topStrikes.reduce(
    (b: any, s: any) => (b == null || Math.abs(s.strike - atmStrike) < Math.abs(b.strike - atmStrike) ? s : b),
    null as any
  );
  const atm = candidates.length ? candidates.reduce((a: any, b: any) => (scoreOf(b) > scoreOf(a) ? b : a)) : atmFallback;
  if (!atm) return null;

  const premium = sLtp(atm) ?? null;
  const deltaRaw = bullish ? atm.ceDelta ?? null : atm.peDelta ?? null;
  const iv = sIv(atm);
  const thetaRaw = sTheta(atm);
  const delta = deltaRaw != null ? Math.abs(deltaRaw) : 0.5; // ATM ~0.5 fallback
  if (premium == null || premium <= 0) return null;

  // Explain WHY this strike was chosen.
  const chosenThetaPct = thetaRaw != null && premium ? Math.round((thetaRaw / premium) * 1000) / 10 : null;
  const moneyness = atm.strike === atmStrike ? "ATM" : bullish ? (atm.strike < spot ? "ITM" : "OTM") : atm.strike > spot ? "ITM" : "OTM";
  const decayWord = chosenThetaPct == null ? "n/a" : chosenThetaPct < 5 ? "low" : chosenThetaPct < 12 ? "moderate" : "high";
  const strikeReason =
    `Chose ${atm.strike} ${optionType} (${moneyness}) as the best strike: ${bullish ? "CALL" : "PUT"} OI ${sOi(atm).toLocaleString("en-IN")} ` +
    `(most liquid near money), delta ${round2(delta)} (strong directional capture), theta ${chosenThetaPct ?? "?"}%/day (${decayWord} decay). ` +
    `Balances liquidity + move-capture against time decay.`;
  reasons.push(strikeReason);

  const dte = oi.expiry ? Math.max(0, Math.ceil((Date.parse(oi.expiry) - Date.now()) / 86400000)) : null;

  // ---- REALISTIC, expiry-aware target ----
  // The old target assumed a full daily-ATR move, which inflated the premium target
  // far beyond what actually happens in the holding window - so trades rarely hit it
  // and decayed into losses. Now the target is a realistic FRACTION of the ATR that
  // can plausibly be captured: ~half a day's range intraday, and smaller near expiry
  // (less time for the move). The stop is set tighter than the target so R:R stays > 1.
  const targetFraction = dte != null && dte <= 1 ? 0.35 : 0.5; // near expiry -> smaller, reachable target
  const targetMove = expectedMove * targetFraction;
  const spotTarget = round2(bullish ? spot + targetMove : spot - targetMove);
  const spotStop = round2(bullish ? spot - targetMove * 0.7 : spot + targetMove * 0.7); // R:R ~1.4
  const spotUpper = round2(spot + expectedMove); // full expected day range (for display)
  const spotLower = round2(spot - expectedMove);

  // TODAY's premium bounds (delta-approx), with a 40% max-loss floor on the stop.
  const premiumTarget = round2(premium + delta * Math.abs(spotTarget - spot));
  const rawStop = premium - delta * Math.abs(spot - spotStop);
  const premiumStop = round2(Math.max(premium * 0.6, rawStop));
  const expectedPremiumMovePct = round2(((premiumTarget - premium) / premium) * 100);

  // ---- Theta / time-decay risk ----
  const theta = thetaRaw != null ? Math.round(Math.abs(thetaRaw) * 100) / 100 : null;
  const thetaPctPerDay = theta != null && premium > 0 ? round2((theta / premium) * 100) : null;

  let decayLevel: DayOpportunity["decayLevel"] = "Low";
  if ((dte != null && dte <= 1) || (thetaPctPerDay != null && thetaPctPerDay >= 8)) decayLevel = "High";
  else if (thetaPctPerDay != null && thetaPctPerDay >= 4) decayLevel = "Moderate";
  const decayNote =
    decayLevel === "High"
      ? dte != null && dte <= 1
        ? `Expiry ~${dte}d away - theta is brutal: premium can bleed ~${thetaPctPerDay ?? "?"}%/day even if spot is flat. Intraday ONLY, do not hold overnight.`
        : `Fast decay ~${thetaPctPerDay}%/day - an overnight hold eats a big chunk. Prefer a same-day exit.`
      : decayLevel === "Moderate"
      ? `Moderate decay ~${thetaPctPerDay}%/day - fine intraday; if held to next day, decay trims the gain.`
      : `Decay ~${thetaPctPerDay ?? "?"}%/day - manageable for a 1-2 day hold.`;

  // ---- Next-day (continuation) scenario, NET of one day's theta ----
  // If the trend extends, a ~2-day move is roughly 1.6x a 1-day ATR (sqrt-of-time).
  const spotTarget2 = bullish ? spot + expectedMove * 1.6 : spot - expectedMove * 1.6;
  const grossNextDay = premium + delta * Math.abs(spotTarget2 - spot);
  const nextDayTarget = round2(Math.max(0, grossNextDay - (theta ?? 0)));
  const nextDayTargetPct = round2(((nextDayTarget - premium) / premium) * 100);
  // Multi-day continuation is less certain than an intraday move; decay lowers it further.
  let nextDayProbability = clamp(conf * 0.75, 5, 90);
  if (decayLevel === "High") nextDayProbability = clamp(nextDayProbability - 20, 5, 90);
  nextDayProbability = round2(nextDayProbability);

  reasons.push(
    `Next-day (if trend continues): target ~${nextDayTarget} (+${nextDayTargetPct}%) at ~${nextDayProbability}% odds, ` +
      `AFTER ~1 day theta of ${theta ?? "?"} (${thetaPctPerDay ?? "?"}%/day, ${dte ?? "?"}d to expiry).`
  );

  // ---- Risk:reward + capital-preservation quality score + safety gates ----
  const downside = Math.max(0.01, premium - premiumStop); // ₹ risked to the stop (<= 40% of premium)
  const upside = Math.max(0, premiumTarget - premium);
  const riskReward = round2(upside / downside);
  const maxLossPct = round2((downside / premium) * 100);

  let q = conf * 0.5; // conviction is the backbone (0..48)
  if (marketAlignment === "Aligned") q += 14;
  else if (marketAlignment === "Market") q += 7;
  else if (marketAlignment === "Conflict") q -= 30; // fighting the index is the #1 loss driver
  if (decayLevel === "Low") q += 12;
  else if (decayLevel === "Moderate") q += 2;
  else q -= 12;
  if (dte != null && dte <= 1) q -= 8; // expiry-day gamma/decay risk
  q += clamp(riskReward, 0, 3) * 6; // reward:risk up to +18
  q += delta * 8; // higher delta = premium tracks spot more reliably
  const qualityScore = Math.round(clamp(q, 0, 100));

  // Safety gates - keep the loss-makers OUT of the curated Top 10.
  const gates: string[] = [];
  if (marketAlignment === "Conflict") gates.push("index headwind");
  if (thetaPctPerDay != null && thetaPctPerDay > 60) gates.push("decay trap (>60%/day - near-worthless option)");
  if (premium < 1) gates.push("premium too thin to trade cleanly");
  if (riskReward < 1) gates.push("reward:risk below 1:1");
  const tradeable = gates.length === 0;
  const gateNote = tradeable
    ? `Passes safety gates - R:R ${riskReward}:1, max loss ${maxLossPct}% to stop.`
    : `Filtered from the safe list: ${gates.join(", ")}.`;

  const ctx = buyContextFromCandles(
    def.symbol,
    def.name,
    bullish ? "Bullish" : "Bearish",
    spot,
    market?.candles,
    market?.stockDaily,
    oi,
    atrDaily
  );
  const hp = evaluateBuyAlgo({
    direction: bullish ? "Bullish" : "Bearish",
    confidence: conf,
    qualityScore,
    marketAlignment,
    decayLevel,
    dte,
    thetaPctPerDay,
    premium,
    delta,
    pcr: oi.available ? oi.pcr : null,
    oiBias: oi.available ? oi.verdict.bias : null,
    adx: ctx.adx ?? null,
    vwapBias: ctx.vwapBias ?? 0,
    orFormed: ctx.orFormed ?? false,
    orBreak: ctx.orBreak ?? 0,
    srRoomOk: ctx.srRoomOk ?? null,
    d4Dir: ctx.d4Dir ?? null,
    relVolume: market?.relVolume ?? null,
    exhausted: ctx.exhausted ?? false,
  });
  const highProbNote = hp.pass
    ? `High-prob BUY: ${hp.notes.join(" · ") || "all structure/OI/trend gates clear"} (score ${hp.score}).`
    : `Not high-prob: ${hp.failed.join("; ")}.`;
  reasons.push(highProbNote);

  reasons.unshift(
    `${bullish ? "Buy CALL" : "Buy PUT"} ${atm.strike} ${optionType} @ ~${round2(premium)}; ` +
      `realistic target if ${def.name} ${bullish ? "rises" : "falls"} ~${round2(targetMove)} pts ` +
      `(${Math.round(targetFraction * 100)}% of the ${round2(expectedMove)}-pt daily range${dte != null && dte <= 1 ? ", trimmed for near-expiry" : ""}): ` +
      `premium ≈ ${premiumTarget} (delta ${round2(delta)}).`
  );

  return {
    symbol: def.symbol,
    name: def.name,
    direction: bullish ? "Bullish" : "Bearish",
    optionType,
    confidence: conf,
    spot: round2(spot),
    strike: atm.strike,
    spotTarget,
    spotStop,
    spotUpper,
    spotLower,
    premium: round2(premium),
    premiumTarget,
    premiumStop,
    expectedPremiumMovePct,
    nextDayTarget,
    nextDayTargetPct,
    nextDayProbability,
    theta,
    thetaPctPerDay,
    dte,
    decayLevel,
    decayNote,
    riskReward,
    qualityScore,
    tradeable,
    gateNote,
    maxLossPct,
    lotSize: def.lotSize ?? null,
    delta: round2(delta),
    iv: iv != null ? round2(iv) : null,
    strikeReason,
    marketRef,
    betaMarket,
    corrMarket,
    marketAlignment,
    reasons,
    highProb: hp.pass,
    highProbScore: hp.score,
    highProbNote,
  };
}
