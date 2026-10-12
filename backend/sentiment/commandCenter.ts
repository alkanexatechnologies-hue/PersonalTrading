// ============================ Market Sentiment · Prediction Command Center ============================
// Composes the top section of the Market Sentiment screen from engines that ALREADY exist — it adds
// no decision logic of its own:
//   · master decision  = the arbiter (decision/service getDecision) — the single source of truth.
//                        This module only DISPLAYS it, adding a freshness/consistency guard that can
//                        downgrade to BLOCK TRADE (never upgrade to a trade). No CE/PE from OI alone.
//   · probabilities    = sentiment/probability.ts, shown RESEARCH ONLY until predictionLog validates it
//   · levels           = the shared option-chain cache (OI walls) + closed 5-min NIFTY candles
//   · contributions    = niftyWeights ESTIMATED CONTRIBUTION MODEL (walk-forward validated, not
//                        official index weights)
//   · heat map         = the stored 09:13 pre-open snapshot (pre-open data only)
// Every value carries its source time; missing inputs are flagged, never filled in.

import type { Decision } from "../decision/types";
import type { HeatSnapshot } from "./sectorHeatmap";
import type { ModelFile } from "./niftyWeights";
import { contributions } from "./niftyWeights";
import type { HorizonReport } from "./predictionLog";
import { sigmaH } from "./predictionLog";

export const CC_VERSION = "cc-v1";
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const istHm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface OiStrike { strike: number; ceOi: number; peOi: number; ceChg: number; peChg: number }
export interface CCInputs {
  nowSec: number;
  phase: "PRE_OPEN" | "OPEN" | "CLOSED";
  nifty: { live: number | null; liveTs: number | null; prevClose: number | null; prevCloseDate: string | null };
  candles5: Bar[];                                  // NIFTY 5-min bars (shared cache), oldest first
  vix: { value: number; ts: number | null } | null;
  oi: { asOf: number | null; expiry: string | null; pcr: number | null; maxPain: number | null; strikes: OiStrike[] } | null;
  decision: Decision | null;                        // NIFTY, from the arbiter
  bankDecision: Decision | null;                    // BANKNIFTY, latest known (not recomputed here)
  probability: { nifty: any | null; bank: any | null; ts: number | null };
  predictionReport: Record<string, HorizonReport> | null;
  overview: { positives: string[]; negatives: string[]; globalPcts: number[]; globalTs: number | null; fii: any | null } | null;
  heat: HeatSnapshot | null;
  model: ModelFile | null;
  liveMoves: { moves: Record<string, number | null>; ts: number } | null;   // NIFTY constituents % vs prev close
}

// ---------------- price kinds ----------------
export function priceKinds(inp: CCInputs) {
  const bars = inp.candles5.filter((b) => istDay(b.time) === istDay(inp.nowSec));
  const lastBar = bars[bars.length - 1];
  const pre = bars.filter((b) => istHm(b.time) <= "15:20");
  const lastTraded = inp.phase === "CLOSED" && pre.length ? { value: pre[pre.length - 1].close, ts: pre[pre.length - 1].time + 300 } : null;
  const officialClose = inp.phase === "CLOSED" && lastBar && istHm(lastBar.time) === "15:25" ? { value: lastBar.close, ts: lastBar.time + 300 } : null;
  const adj = officialClose && lastTraded ? r2(officialClose.value - lastTraded.value) : null;
  return {
    live: inp.nifty.live != null ? { value: inp.nifty.live, ts: inp.nifty.liveTs } : null,
    previousClose: inp.nifty.prevClose != null ? { value: inp.nifty.prevClose, date: inp.nifty.prevCloseDate } : null,
    lastTraded, officialClose,
    closingAdjustment: adj != null && Math.abs(adj) >= 0.05 ? { points: adj, note: `NSE's official close (last-30-minute average of constituents) moved the index ${adj > 0 ? "+" : ""}${adj} pts from the last traded value` } : null,
  };
}

// ---------------- ATR + level status from closed 5-min bars ----------------
export function atr14(bars: Bar[]): number | null {
  if (bars.length < 15) return null;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  const last = tr.slice(-14); return last.reduce((a, b) => a + b, 0) / last.length;
}
export type LevelStatus = "FAR" | "APPROACHING" | "BREAKING" | "RECLAIMING" | "REJECTING";
/** side = which side of the level price sits on when the level is "intact" ("below" for resistance). */
export function levelStatus(level: number, side: "below" | "above", closed: Bar[], atr: number | null): LevelStatus {
  const b = closed[closed.length - 1], p = closed[closed.length - 2]; if (!b) return "FAR";
  const beyond = (x: number) => (side === "below" ? x > level : x < level);
  const wick = side === "below" ? b.high >= level : b.low <= level;
  if (beyond(b.close) && (!p || !beyond(p.close))) return "BREAKING";
  if (!beyond(b.close) && p && beyond(p.close)) return "RECLAIMING";
  if (!beyond(b.close) && wick) return "REJECTING";
  if (atr != null && Math.abs(b.close - level) <= 0.5 * atr) return "APPROACHING";
  return "FAR";
}

export interface Level { kind: string; price: number; method: string; evidence: string; invalidation: string; ts: number | null; status: LevelStatus }
export function buildLevels(inp: CCInputs, spot: number | null): { levels: Level[]; atr: number | null; note: string | null } {
  const closed = inp.candles5.filter((b) => b.time + 300 <= inp.nowSec && istDay(b.time) === istDay(inp.nowSec) && istHm(b.time) <= "15:20");
  const atr = atr14(inp.candles5.filter((b) => b.time + 300 <= inp.nowSec));
  if (spot == null) return { levels: [], atr, note: "No NIFTY price — levels not computed" };
  const lv: Level[] = [];
  const o = inp.oi;
  const L = (n: number) => `${(n / 1e5).toFixed(0)}L`;
  if (o && o.strikes.length) {
    // Only strikes within 1 % of spot: far-away walls are not tradeable levels for the session.
    const band = spot * 0.01;
    const above = o.strikes.filter((s) => s.strike > spot && s.strike - spot <= band), below = o.strikes.filter((s) => s.strike < spot && spot - s.strike <= band);
    const ceWall = above.reduce<OiStrike | null>((b, s) => (!b || s.ceOi > b.ceOi ? s : b), null);
    const peWall = below.reduce<OiStrike | null>((b, s) => (!b || s.peOi > b.peOi ? s : b), null);
    const near = (arr: OiStrike[], key: "ceOi" | "peOi", up: boolean) => {
      const big = [...arr].sort((a, b) => b[key] - a[key]).slice(0, 3);   // top-3 walls on that side
      return big.sort((a, b) => (up ? a.strike - b.strike : b.strike - a.strike))[0] || null;
    };
    const r1s = near(above, "ceOi", true), s1s = near(below, "peOi", false);
    const ts = o.asOf;
    if (r1s) lv.push({ kind: "Immediate resistance", price: r1s.strike, method: "Nearest of the 3 largest call-OI strikes within 1 % above spot", evidence: `CE OI ${L(r1s.ceOi)} (${r1s.ceChg >= 0 ? "+" : ""}${L(r1s.ceChg)} today)`, invalidation: `5-min close above ${r1s.strike}`, ts, status: levelStatus(r1s.strike, "below", closed, atr) });
    if (s1s) lv.push({ kind: "Immediate support", price: s1s.strike, method: "Nearest of the 3 largest put-OI strikes within 1 % below spot", evidence: `PE OI ${L(s1s.peOi)} (${s1s.peChg >= 0 ? "+" : ""}${L(s1s.peChg)} today)`, invalidation: `5-min close below ${s1s.strike}`, ts, status: levelStatus(s1s.strike, "above", closed, atr) });
    if (ceWall) {
      const next = above.filter((s) => s.strike > ceWall.strike).sort((a, b) => b.ceOi - a.ceOi)[0];
      lv.push({ kind: "Upside breakout zone", price: ceWall.strike, method: "Largest call-OI strike within 1 % above spot (call writers positioned here)", evidence: `CE OI ${L(ceWall.ceOi)}; next ${next ? next.strike : "—"}`, invalidation: `Confirmed only by a 5-min CLOSE above ${ceWall.strike}; fails on a close back below`, ts, status: levelStatus(ceWall.strike, "below", closed, atr) });
      lv.push({ kind: "Reversal-down zone", price: ceWall.strike, method: "Rejection at the largest call-OI strike (high reaches it, close stays below)", evidence: `CE OI ${L(ceWall.ceOi)}`, invalidation: `Void after a 5-min close above ${ceWall.strike}`, ts, status: levelStatus(ceWall.strike, "below", closed, atr) });
    }
    if (peWall) {
      const next = below.filter((s) => s.strike < peWall.strike).sort((a, b) => b.peOi - a.peOi)[0];
      lv.push({ kind: "Downside breakdown zone", price: peWall.strike, method: "Largest put-OI strike within 1 % below spot (put writers positioned here)", evidence: `PE OI ${L(peWall.peOi)}; next ${next ? next.strike : "—"}`, invalidation: `Confirmed only by a 5-min CLOSE below ${peWall.strike}; fails on a close back above`, ts, status: levelStatus(peWall.strike, "above", closed, atr) });
      lv.push({ kind: "Reversal-up zone", price: peWall.strike, method: "Reclaim of the largest put-OI strike after a break below it", evidence: `PE OI ${L(peWall.peOi)}`, invalidation: `Void while 5-min closes stay below ${peWall.strike}`, ts, status: levelStatus(peWall.strike, "above", closed, atr) });
    }
  }
  const today = inp.candles5.filter((b) => istDay(b.time) === istDay(inp.nowSec) && b.time + 300 <= inp.nowSec);
  if (today.length) {
    const hi = Math.max(...today.map((b) => b.high)), lo = Math.min(...today.map((b) => b.low)), t = today[today.length - 1].time + 300;
    lv.push({ kind: "Day high", price: r2(hi), method: "Highest traded value of today's closed 5-min bars", evidence: `${today.length} bars`, invalidation: "—", ts: t, status: levelStatus(hi, "below", closed, atr) });
    lv.push({ kind: "Day low", price: r2(lo), method: "Lowest traded value of today's closed 5-min bars", evidence: `${today.length} bars`, invalidation: "—", ts: t, status: levelStatus(lo, "above", closed, atr) });
  }
  const afterHours = !!(o && o.asOf != null && inp.phase === "CLOSED" && (() => { const d = new Date((o.asOf! + 19800) * 1000); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 15 * 60 + 30 || m < 9 * 60; })());
  const note = !o ? "Option chain unavailable — OI levels not shown"
    : afterHours ? "Option chain read after the close — Dhan's after-hours chain can differ from the session's final OI; treat OI levels as provisional until 09:15"
    : null;
  return { levels: lv, atr: atr != null ? r1(atr) : null, note };
}

// ---------------- master decision (display + guard only) ----------------
export type DisplayDecision = "TAKE CE" | "TAKE PE" | "WAIT" | "WAIT FOR PULLBACK" | "NO EDGE" | "BLOCK TRADE" | "HOLD";
export function displayDecision(inp: CCInputs, spot: number | null, atr: number | null, levels: Level[]) {
  const d = inp.decision;
  if (!d) return { action: "NO EDGE" as DisplayDecision, reason: "No arbiter decision available", guard: "missing", decision: null, distanceToOpposing: null };
  let action: DisplayDecision =
    d.finalAction === "BUY_CE" ? "TAKE CE" : d.finalAction === "BUY_PE" ? "TAKE PE" : d.finalAction === "HOLD" ? "HOLD"
    : d.finalAction === "AVOID" ? "BLOCK TRADE"
    : /pullback|retest/i.test(d.reason || "") ? "WAIT FOR PULLBACK" : /no directional edge|no edge/i.test(d.reason || "") ? "NO EDGE" : "WAIT";
  let reason = d.reason || d.rejection || "";
  let guard: string | null = null;
  if (inp.phase === "OPEN") {
    const age = d.candleTime != null ? inp.nowSec - (d.candleTime + 300) : Infinity;
    if (age > 600) { guard = "stale"; action = "BLOCK TRADE"; reason = `Arbiter decision is ${Math.round(age / 60)} min old — waiting for a fresh closed-candle decision`; }
    else if (d.dataStatus && d.dataStatus !== "LIVE") { guard = "data"; action = "BLOCK TRADE"; reason = `Data ${d.dataStatus} — no live decision`; }
    else if ((action === "TAKE CE" || action === "TAKE PE") && spot != null && d.spot != null && atr != null && Math.abs(spot - d.spot) > atr) {
      guard = "moved"; action = "BLOCK TRADE"; reason = `Price moved ${r1(spot - d.spot)} pts (> 1 ATR) since the decision candle — entry no longer valid`;
    }
  }
  let distanceToOpposing: { level: number; kind: string; points: number } | null = null;
  if ((d.finalAction === "BUY_CE" || d.finalAction === "BUY_PE") && d.plan) {
    const up = d.finalAction === "BUY_CE";
    const opp = levels.filter((l) => (up ? l.price > d.plan!.entry : l.price < d.plan!.entry) && /resistance|breakout|support|breakdown/i.test(l.kind)).sort((a, b) => (up ? a.price - b.price : b.price - a.price))[0];
    if (opp) distanceToOpposing = { level: opp.price, kind: opp.kind, points: r1(Math.abs(opp.price - d.plan.entry)) };
  }
  return { action, reason, guard, decision: d, distanceToOpposing };
}

// ---------------- regime ----------------
export function regimeLabel(d: Decision | null): { label: string; detail: string } {
  if (!d || !d.regime) return { label: "UNKNOWN", detail: "No closed-candle regime yet" };
  if (d.bias && /^SHIFT_/.test(d.bias.state)) return { label: "REVERSAL", detail: d.bias.reasons?.[0] || d.bias.state };
  const m: Record<string, string> = { TREND_UP: "TRENDING", TREND_DOWN: "TRENDING", RANGE: "SIDEWAYS", EXPANSION: "VOLATILITY EXPANSION", REVERSAL: "REVERSAL", TRANSITION: "TRANSITION" };
  return { label: m[d.regime] || d.regime, detail: (d.regimeEvidence || []).join(" · ") };
}

// ---------------- experimental scores (formulas shown; hidden when inputs are missing) ----------------
export function scores(inp: CCInputs, contribExplainedPct: number | null) {
  const out: { key: string; label: string; value: number | null; formula: string; inputs: string; experimental: boolean; ts: number | null }[] = [];
  const fii = inp.overview?.fii;
  const longPct = fii?.rows?.[0]?.longPct ?? null;
  const pcr = inp.oi?.pcr ?? null;
  if (longPct != null && pcr != null) {
    const v = Math.round(clamp(((longPct - 50) / 50) * 50 + clamp((pcr - 1) / 0.4, -1, 1) * 50, -100, 100));
    out.push({ key: "institutional", label: "Institutional positioning", value: v, formula: "50 × (FII index-futures long% − 50)/50 + 50 × clamp((PCR − 1)/0.4)", inputs: `FII ${longPct}% long (${fii?.asOf || "?"}) · PCR ${pcr}`, experimental: true, ts: inp.oi?.asOf ?? null });
  } else out.push({ key: "institutional", label: "Institutional positioning", value: null, formula: "needs FII long% and PCR", inputs: "missing input", experimental: true, ts: null });
  const g = inp.overview?.globalPcts || [];
  out.push(g.length ? { key: "global", label: "Global cues", value: Math.round(clamp((g.reduce((a, b) => a + b, 0) / g.length) * 100, -100, 100)), formula: "100 × average % change of available global indices (clamped ±100)", inputs: `${g.length} indices`, experimental: true, ts: inp.overview?.globalTs ?? null }
    : { key: "global", label: "Global cues", value: null, formula: "needs global index quotes", inputs: "missing input", experimental: true, ts: null });
  out.push(contribExplainedPct != null ? { key: "heat", label: "Weighted stock move", value: r2(contribExplainedPct), formula: "Σ (estimated contribution coefficient × stock % move), in % of NIFTY", inputs: "ESTIMATED CONTRIBUTION MODEL (validated)", experimental: false, ts: inp.liveMoves?.ts ?? null }
    : { key: "heat", label: "Weighted stock move", value: null, formula: "needs constituent prices and a validated model", inputs: "missing input", experimental: false, ts: null });
  const s = inp.oi?.strikes || [];
  if (s.length) {
    const ce = s.reduce((a, x) => a + x.ceChg, 0), pe = s.reduce((a, x) => a + x.peChg, 0), tot = Math.abs(ce) + Math.abs(pe);
    out.push({ key: "oi", label: "OI change balance", value: tot ? Math.round(((pe - ce) / tot) * 100) : 0, formula: "100 × (Δput OI − Δcall OI) / (|Δcall| + |Δput|) over the shown strikes (+ = put-heavy)", inputs: `Δcall ${(ce / 1e5).toFixed(0)}L · Δput ${(pe / 1e5).toFixed(0)}L`, experimental: true, ts: inp.oi?.asOf ?? null });
  } else out.push({ key: "oi", label: "OI change balance", value: null, formula: "needs the option chain", inputs: "missing input", experimental: true, ts: null });
  return out;
}

export function moveSizes(spot: number | null, vix: CCInputs["vix"]) {
  if (spot == null || !vix) return null;
  return { basis: "India VIX-implied 1σ for the horizon (size only — not a direction)", ts: vix.ts, h15: r1(sigmaH(spot, vix.value, 15)), h30: r1(sigmaH(spot, vix.value, 30)), h60: r1(sigmaH(spot, vix.value, 60)) };
}

// ---------------- contributions (pre-open vs session kept separate) ----------------
export function contributionView(inp: CCInputs, prevClose: number | null) {
  const m = inp.model;
  if (!m || !m.validation || !m.validation.pass) return { available: false, reason: m ? "Contribution model has not passed validation" : "Contribution model not built yet", model: null };
  const meta = { label: "ESTIMATED CONTRIBUTION MODEL", note: "Coefficients estimated from NIFTY's own 5-minute moves — not NSE's official index weights (not available to the app).", version: m.version, fittedAt: m.fittedAt, validation: m.validation };
  const preopenMoves: Record<string, number | null> = {};
  if (inp.heat && inp.heat.status === "OK" && inp.heat.date === istDay(inp.nowSec)) for (const s of inp.heat.sectors) for (const k of s.stocks) preopenMoves[k.s] = k.pct;
  const pre = prevClose != null && Object.keys(preopenMoves).length ? contributions(m, preopenMoves, prevClose) : null;
  const sess = prevClose != null && inp.phase !== "PRE_OPEN" && inp.liveMoves ? contributions(m, inp.liveMoves.moves, prevClose) : null;
  const pack = (c: ReturnType<typeof contributions> | null, ts: number | null, label: string) => c && { label, ts, explainedPoints: c.explained, explainedPct: prevClose ? r2((c.explained / prevClose) * 100) : null, top: c.rows.slice(0, 5), bottom: c.rows.slice(-5).reverse(), covered: c.rows.length };
  return { available: true, model: meta, preopen: pack(pre, inp.heat?.takenAt ?? null, "Pre-open 09:13 (pre-open prices only)"), session: pack(sess, inp.liveMoves?.ts ?? null, inp.phase === "CLOSED" ? "Session (last traded prices)" : "Live session (after 09:15)") };
}

// ---------------- explanation ----------------
export function explanation(inp: CCInputs, contrib: any, levels: Level[], dec: ReturnType<typeof displayDecision>) {
  const bull: string[] = [], bear: string[] = [], contra: string[] = [];
  for (const p of inp.overview?.positives || []) bull.push(p);
  for (const n of inp.overview?.negatives || []) bear.push(n);
  const sess = contrib?.session;
  if (sess) {
    const up = sess.top.filter((r: any) => r.points > 0).slice(0, 3), dn = sess.bottom.filter((r: any) => r.points < 0).slice(0, 3);
    if (up.length) bull.push(`Supporting stocks: ${up.map((r: any) => `${r.symbol} ${r.points > 0 ? "+" : ""}${r.points}`).join(", ")} pts`);
    if (dn.length) bear.push(`Dragging stocks: ${dn.map((r: any) => `${r.symbol} ${r.points}`).join(", ")} pts`);
  }
  if (contrib?.preopen && sess && Math.sign(contrib.preopen.explainedPoints) !== Math.sign(sess.explainedPoints) && Math.abs(sess.explainedPoints) > 10)
    contra.push(`Pre-open (09:13) pointed ${contrib.preopen.explainedPoints > 0 ? "up" : "down"} (${contrib.preopen.explainedPoints} pts); the session has gone ${sess.explainedPoints > 0 ? "up" : "down"} (${sess.explainedPoints} pts)`);
  const g = inp.overview?.globalPcts || []; const gAvg = g.length ? g.reduce((a, b) => a + b, 0) / g.length : null;
  const dir = inp.decision?.direction;
  if (gAvg != null && dir && ((gAvg > 0.2 && dir === "BEARISH") || (gAvg < -0.2 && dir === "BULLISH"))) contra.push(`Global cues ${gAvg > 0 ? "positive" : "negative"} (${r2(gAvg)}%) while the 5-min structure is ${dir.toLowerCase()}`);
  const p = inp.probability.nifty;
  if (p && dir && ((p.bias === "BULLISH" && dir === "BEARISH") || (p.bias === "BEARISH" && dir === "BULLISH"))) contra.push(`Research model leans ${String(p.bias).toLowerCase()}, arbiter structure is ${dir.toLowerCase()}`);
  const inval: string[] = [];
  const res = levels.find((l) => l.kind === "Immediate resistance"), sup = levels.find((l) => l.kind === "Immediate support");
  if (dir === "BEARISH" && res) inval.push(`Bearish view void on a 5-min close above ${res.price}`);
  if (dir === "BULLISH" && sup) inval.push(`Bullish view void on a 5-min close below ${sup.price}`);
  if (dec.decision?.invalidation != null) inval.push(`The arbiter's ${dec.decision.setupLabel || "setup"} is invalid beyond ${dec.decision.invalidation} (its stop-side level)`);
  const why = dir === "BEARISH" ? "5-min structure is bearish (arbiter)" : dir === "BULLISH" ? "5-min structure is bullish (arbiter)" : "No directional structure on closed 5-min candles";
  return { why, bullish: bull.slice(0, 3), bearish: bear.slice(0, 3), contradictions: contra, invalidation: inval, oiDisclaimer: "OI shows where open positions sit; it does not reveal any institution's intentions." };
}

// ---------------- assemble ----------------
export function buildCommandCenter(inp: CCInputs) {
  const prices = priceKinds(inp);
  const spot = prices.live?.value ?? prices.lastTraded?.value ?? null;
  const { levels, atr, note: levelsNote } = buildLevels(inp, spot);
  const dec = displayDecision(inp, spot, atr, levels);
  const contrib = contributionView(inp, inp.nifty.prevClose);
  const sessExplainedPct = (contrib as any).session?.explainedPct ?? null;
  const rep = inp.predictionReport;
  const probStatus = (["15", "30", "60"] as const).map((h) => ({ h: Number(h), status: rep?.[h]?.status || "RESEARCH_ONLY", n: rep?.[h]?.n ?? 0, reason: rep?.[h]?.reason || "no scored predictions yet", balancedAcc: rep?.[h]?.model.balancedAcc ?? null, ci: rep?.[h]?.edgeVsBest?.ci95 ?? null }));
  const validatedAny = probStatus.some((p) => p.status === "VALIDATED");
  const pn = inp.probability.nifty;
  const fresh = (ts: number | null, maxAge: number) => (ts == null ? "MISSING" : inp.nowSec - ts <= maxAge ? "FRESH" : "STALE");
  const freshness = {
    price: fresh(prices.live?.ts ?? prices.lastTraded?.ts ?? null, inp.phase === "OPEN" ? 120 : 86400 * 4),
    candles: fresh(inp.candles5.length ? inp.candles5[inp.candles5.length - 1].time + 300 : null, inp.phase === "OPEN" ? 600 : 86400 * 4),
    oi: fresh(inp.oi?.asOf ?? null, inp.phase === "OPEN" ? 300 : 86400 * 4) === "FRESH" && inp.phase === "CLOSED" && levelsNote && /after the close/.test(levelsNote) ? "AFTER-HOURS" : fresh(inp.oi?.asOf ?? null, inp.phase === "OPEN" ? 300 : 86400 * 4),
    decision: fresh(inp.decision?.candleTime != null ? inp.decision.candleTime + 300 : null, inp.phase === "OPEN" ? 600 : 86400 * 4),
    fii: inp.overview?.fii?.asOf ? `as on ${inp.overview.fii.asOf}` : "MISSING",
    heat: inp.heat ? `${inp.heat.date} ${inp.heat.status}` : "MISSING",
  };
  return {
    version: CC_VERSION, generatedAt: inp.nowSec, phase: inp.phase,
    prices,
    a: {
      regime: regimeLabel(inp.decision),
      niftyBias: { direction: inp.decision?.direction || "NEUTRAL", source: "arbiter 5-min structure", candle: inp.decision?.candleIso || null },
      bankBias: inp.bankDecision ? { direction: inp.bankDecision.direction, source: "arbiter 5-min structure", candle: inp.bankDecision.candleIso } : { direction: inp.probability.bank?.bias || "UNKNOWN", source: inp.probability.bank ? "research model (RESEARCH ONLY)" : "missing", candle: null },
      probabilities: { status: validatedAny ? "PARTLY VALIDATED" : "RESEARCH ONLY", model: pn ? { up: pn.upside, down: pn.downside, sideways: pn.range, modelVersion: "probability.ts fixed weights v1" } : null, horizons: probStatus, ts: inp.probability.ts, note: "Not a validated forecast — shown for research until the logged predictions beat every baseline." },
      moveSize: moveSizes(spot, inp.vix),
      scores: scores(inp, sessExplainedPct),
      freshness,
    },
    b: explanation(inp, contrib, levels, dec),
    c: { spot, spotTs: prices.live?.ts ?? prices.lastTraded?.ts ?? null, atr, levels, note: levelsNote, oi: inp.oi ? { asOf: inp.oi.asOf, expiry: inp.oi.expiry, pcr: inp.oi.pcr, maxPain: inp.oi.maxPain } : null },
    d: {
      action: dec.action, reason: dec.reason, guard: dec.guard,
      candle: dec.decision?.candleIso || null, setup: dec.decision?.setupLabel || null, direction: dec.decision?.direction || null,
      plan: dec.decision && (dec.decision.finalAction === "BUY_CE" || dec.decision.finalAction === "BUY_PE" || dec.decision.finalAction === "HOLD") ? dec.decision.plan : null,
      option: dec.decision && (dec.decision.finalAction === "BUY_CE" || dec.decision.finalAction === "BUY_PE" || dec.decision.finalAction === "HOLD") ? dec.decision.option : null,
      evidence: dec.decision?.evidence?.note || null,
      candidates: (dec.decision?.candidates || []).map((c) => ({ setup: c.label, direction: c.direction, state: c.state, block: c.blockReason, evidence: c.evidence })),
      distanceToOpposing: dec.distanceToOpposing,
      gates: ["Closed 5-min candle only", "S1 no new entries after 14:00", "Option R:R ≥ 2 after costs", "Paper: 1 % capital risk/trade, one open index-options trade, 15-min cooldown after a stop-out"],
    },
    contributions: contrib,
    heat: inp.heat ? { date: inp.heat.date, takenAt: inp.heat.takenAt, refilledAt: inp.heat.refilledAt ?? null, status: inp.heat.status, sectors: inp.heat.sectors.map((s) => ({ name: s.name, avg: s.avg, adv: s.adv, dec: s.dec, n: s.n })) } : null,
  };
}
export type CommandCenter = ReturnType<typeof buildCommandCenter>;

// ---------------- route handler (cache + coalescing; testable without the server) ----------------
/** One build per TTL for all viewers; concurrent requests share the in-flight build. Never throws to the client. */
export function commandRoute(gather: () => Promise<CCInputs>, ttlMs = 30_000) {
  let cache: { at: number; v: CommandCenter } | null = null;
  let inflight: Promise<CommandCenter> | null = null;
  return async (_req: any, res: any) => {
    try {
      if (cache && Date.now() - cache.at < ttlMs) return res.json({ ...cache.v, cached: true });
      if (!inflight) inflight = gather().then((inp) => buildCommandCenter(inp)).finally(() => { inflight = null; });
      const v = await inflight;
      cache = { at: Date.now(), v };
      res.json(v);
    } catch (e: any) {
      res.json({ available: false, error: `Command Center unavailable: ${e?.message || e}` });
    }
  };
}
