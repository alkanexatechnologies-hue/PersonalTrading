// ============================ 🏛 INSTITUTIONAL POSITIONING INTELLIGENCE — deterministic, auditable rule engine ============================
// Inputs (all real, all timestamped — nothing is inferred or filled in):
//   • NSE participant-wise OI (participantHistory.ts): CONTRACTS of open interest per participant (FII, DII, Client, Pro) and
//     instrument (index futures, stock futures, index calls / puts, stock calls / puts). End-of-day: a report for date D is
//     usable from the next session. It is ONE aggregate across all NSE indices — not NIFTY-only, and not SENSEX at all.
//   • Dhan index FUTURES price + OI (indexFutures.ts) — the live derivatives confirmation.
//   • The live price structure from the existing Premium Prediction payload (VWAP, 15-min verdict, closed 5-min candles,
//     breakout / breakdown states, BOS / CHoCH) — reused, never recomputed, so there is ONE structure engine.
//   • Dhan option-chain OI bias (strike-level writers) — kept separate from participant positioning (different data).
// Outputs: participant metrics, FII short intelligence, six rule cards, four 0–100 scores, an explanation and the structured
// object for the Arbiter. Information only: it never gives, blocks or changes a trade (the Arbiter and risk gates decide).
// Client ≠ retail and Pro ≠ HNI: the categories are shown exactly as NSE names them. FII/DII cash flows are not available.

export type Cat = "FII" | "DII" | "Client" | "Pro";
export const CATS: Cat[] = ["FII", "DII", "Client", "Pro"];
export type Inst = "INDEX_FUT" | "STOCK_FUT" | "INDEX_CALL" | "INDEX_PUT" | "STOCK_CALL" | "STOCK_PUT";
export const INST_LABEL: Record<Inst, string> = { INDEX_FUT: "Index futures", STOCK_FUT: "Stock futures", INDEX_CALL: "Index calls", INDEX_PUT: "Index puts", STOCK_CALL: "Stock calls", STOCK_PUT: "Stock puts" };
/** One stored NSE session (participantHistory row shape, only what the engine reads). */
export interface PDay { date: string; sourceReportId?: string; fut: Record<Cat, { long: number; short: number }>; opt: Record<Cat, { callLong: number; callShort: number; putLong: number; putShort: number }>;
  stockFut?: Record<Cat, { long: number; short: number }>; stockOpt?: Record<Cat, { callLong: number; callShort: number; putLong: number; putShort: number }> }

/** Long / short contracts of one participant in one instrument on one day; null when the report has no such column. */
export function legOf(d: PDay, c: Cat, i: Inst): { long: number; short: number } | null {
  if (i === "INDEX_FUT") return d.fut[c];
  if (i === "STOCK_FUT") return d.stockFut?.[c] ?? null;
  const o = i === "INDEX_CALL" || i === "INDEX_PUT" ? d.opt[c] : d.stockOpt?.[c]; if (!o) return null;
  return i.endsWith("CALL") ? { long: o.callLong, short: o.callShort } : { long: o.putLong, short: o.putShort };
}

export type ChangeClass = "NET LONG INCREASING" | "NET LONG DECREASING" | "NET SHORT INCREASING" | "NET SHORT DECREASING" | "RELATIVELY UNCHANGED" | "INSUFFICIENT DATA";
/** A net change is "relatively unchanged" when smaller than 1 % of the gross (long + short) contracts. */
export function classifyChange(net: number | null, chg: number | null, gross: number | null): ChangeClass {
  if (net == null || chg == null || gross == null) return "INSUFFICIENT DATA";
  if (Math.abs(chg) < 0.01 * Math.max(1, gross)) return "RELATIVELY UNCHANGED";
  const after = net, before = net - chg;
  if (before >= 0 && after >= 0) return chg > 0 ? "NET LONG INCREASING" : "NET LONG DECREASING";
  if (before <= 0 && after <= 0) return chg < 0 ? "NET SHORT INCREASING" : "NET SHORT DECREASING";
  return chg > 0 ? "NET LONG INCREASING" : "NET SHORT INCREASING";   // crossed zero: the side it ended on grew
}

export interface Metric { tradingDate: string; participant: Cat; instrument: Inst; sourceReportId: string | null; grossLong: number; grossShort: number; net: number; longShortRatio: number | null;
  previousNet: number | null; netChange: number | null; ch1: number | null; ch3: number | null; ch5: number | null; change1: ChangeClass; trend3: ChangeClass }
/** Metrics for the LAST day of `days` (oldest first; consecutive stored sessions — missing sessions are never zero-filled). */
export function metricOf(days: PDay[], c: Cat, i: Inst): Metric | null {
  const n = days.length; if (!n) return null;
  const legs = days.map((d) => legOf(d, c, i)), L = legs[n - 1]; if (!L) return null;
  const net = L.long - L.short, netAt = (k: number) => (n - 1 - k >= 0 && legs[n - 1 - k] ? legs[n - 1 - k]!.long - legs[n - 1 - k]!.short : null);
  const ch = (k: number) => { const p = netAt(k); return p == null ? null : net - p; }, gross = L.long + L.short;
  return { tradingDate: days[n - 1].date, participant: c, instrument: i, sourceReportId: days[n - 1].sourceReportId ?? null, grossLong: L.long, grossShort: L.short, net,
    longShortRatio: L.short > 0 ? Math.round((L.long / L.short) * 1000) / 1000 : null, previousNet: netAt(1), netChange: ch(1), ch1: ch(1), ch3: ch(3), ch5: ch(5),
    change1: classifyChange(net, ch(1), gross), trend3: classifyChange(net, ch(3), gross) };
}

// ---------------------------------------------------------------- FII short intelligence
export type PosTrend = "INCREASING BEARISH" | "DECREASING BEARISH" | "INCREASING BULLISH" | "DECREASING BULLISH" | "NEUTRAL" | "INSUFFICIENT DATA";
export function posTrend(net: number | null, ch3: number | null, gross: number | null): PosTrend {
  if (net == null || ch3 == null || gross == null) return "INSUFFICIENT DATA";
  if (Math.abs(ch3) < 0.01 * Math.max(1, gross)) return "NEUTRAL";
  return net < 0 ? (ch3 < 0 ? "INCREASING BEARISH" : "DECREASING BEARISH") : ch3 > 0 ? "INCREASING BULLISH" : "DECREASING BULLISH";
}
export const PCT_MIN_SESSIONS = 120, PCT_WINDOW = 250, ELEVATED_SHORT_PCT = 80;
/** Where today's FII index-futures NET sits in the last PCT_WINDOW sessions: % of sessions that were LESS short (net higher).
 *  90 = more short than 90 % of the window. Null below PCT_MIN_SESSIONS comparable sessions. */
export function shortPercentile(nets: number[]): number | null {
  if (nets.length < PCT_MIN_SESSIONS) return null;
  const w = nets.slice(-PCT_WINDOW), cur = w[w.length - 1];
  return Math.round((w.filter((x) => x > cur).length / (w.length - 1)) * 100);
}

// ---------------------------------------------------------------- live structure (from the existing payload)
export interface Structure {
  session: string; asOf: number | null; spot: number | null; vwap: number | null;
  closed5: { time: number; open: number; high: number; low: number; close: number }[];   // today's closed 5-min candles (oldest first)
  trend15: "UP" | "DOWN" | "RANGE" | "NO DATA" | null;
  breakout: { state: string; barTime: number | null } | null; breakdown: { state: string; barTime: number | null } | null;
  bos: { time: number; direction: "Bullish" | "Bearish"; kind: string }[];
  chainOiBias: "BULLISH" | "BEARISH" | "NEUTRAL" | string | null;
}
export interface Futures { available: boolean; reading?: string | null; priceChg?: number | null; oiChg?: number | null; oiChgPct?: number | null; reason?: string; sessions?: { date: string; close: number; oi: number }[] }

type Tri = boolean | null;   // null = the input is missing (never read as false)
export interface Cond { name: string; pass: Tri; detail: string; required: boolean }
export interface Card { key: "BEARISH_CONTINUATION" | "BULLISH_CONTINUATION" | "SHORT_SQUEEZE_RISK" | "SHORT_COVERING" | "LONG_BUILDUP" | "MIXED_NO_EDGE";
  title: string; status: "ACTIVE" | "WATCH" | "INACTIVE" | "INSUFFICIENT DATA"; conditions: Cond[]; supporting: string[]; contradicting: string[]; missing: string[]; note: string; evaluatedAt: number }

const RECENT_BARS = 6;   // a breakout / BOS counts as "now" only within the last 6 closed 5-min candles (30 min)
function recent(s: Structure, t: number | null | undefined) { if (t == null || !s.closed5.length) return false; const last = s.closed5[s.closed5.length - 1].time; return t <= last && t > last - RECENT_BARS * 300; }
function cardOf(key: Card["key"], title: string, conds: Cond[], now: number, note: string, watch = false): Card {
  const req = conds.filter((c) => c.required), missing = conds.filter((c) => c.pass === null).map((c) => `${c.name}: ${c.detail}`);
  const status: Card["status"] = req.some((c) => c.pass === false) ? (watch ? "WATCH" : "INACTIVE") : req.some((c) => c.pass === null) ? "INSUFFICIENT DATA" : "ACTIVE";
  return { key, title, status, conditions: conds, supporting: conds.filter((c) => c.pass === true).map((c) => c.detail), contradicting: conds.filter((c) => c.pass === false).map((c) => c.detail), missing, note, evaluatedAt: now };
}

export interface EngineIn { underlying: string; nseCovered: boolean; days: PDay[]; expectedReportDate: string | null; structure: Structure | null; futures: Futures | null; now: number }
export function evaluate(o: EngineIn) {
  const days = o.days, last = days[days.length - 1] ?? null, now = o.now;
  // ---- participant metrics (every category × instrument the report has)
  const metrics: Metric[] = []; for (const c of CATS) for (const i of Object.keys(INST_LABEL) as Inst[]) { const m = metricOf(days, c, i); if (m) metrics.push(m); }
  const fii = metrics.find((m) => m.participant === "FII" && m.instrument === "INDEX_FUT") ?? null;
  const fiiNets = days.map((d) => d.fut.FII.long - d.fut.FII.short);
  const freshness = !last ? "UNKNOWN" : o.expectedReportDate && last.date < o.expectedReportDate ? "STALE" : "FRESH";
  const pct = shortPercentile(fiiNets), trend = fii ? posTrend(fii.net, fii.ch3, fii.grossLong + fii.grossShort) : "INSUFFICIENT DATA";
  const posOk = o.nseCovered && freshness !== "UNKNOWN";
  // participant direction only where NSE data covers the index (never for SENSEX) — null = not known, never "neutral"
  const fiiBear: Tri = !posOk || trend === "INSUFFICIENT DATA" ? null : trend === "INCREASING BEARISH" || trend === "DECREASING BULLISH";
  const fiiBull: Tri = !posOk || trend === "INSUFFICIENT DATA" ? null : trend === "INCREASING BULLISH" || trend === "DECREASING BEARISH";
  // ---- live structure
  const S = o.structure, live = !!S && S.session === "OPEN" && S.closed5.length > 0, c5 = live ? S!.closed5[S!.closed5.length - 1] : null;
  const vw = live && S!.vwap != null ? S!.vwap : null;
  const belowVwap: Tri = c5 && vw != null ? c5.close < vw : null, aboveVwap: Tri = belowVwap == null ? null : !belowVwap;
  const t15: Tri = live && S!.trend15 && S!.trend15 !== "NO DATA" ? S!.trend15 === "DOWN" : null, u15: Tri = t15 == null ? null : S!.trend15 === "UP";
  const lastBos = live ? [...S!.bos].reverse().find((b) => recent(S!, b.time)) : undefined;
  const bearBreak: Tri = live ? (["CONFIRMED_BREAKDOWN", "RETEST_FAILURE"].includes(S!.breakdown?.state ?? "") && recent(S!, S!.breakdown?.barTime)) || lastBos?.direction === "Bearish" : null;
  const bullBreak: Tri = live ? (["CONFIRMED_BREAKOUT", "RETEST_HOLD"].includes(S!.breakout?.state ?? "") && recent(S!, S!.breakout?.barTime)) || lastBos?.direction === "Bullish" : null;
  const F = o.futures, fr = F?.available ? F.reading ?? null : null;
  const futDetail = !F?.available ? `index futures OI not available (${F?.reason || "no data"})` : `index futures: ${fr} (price ${F.priceChg! >= 0 ? "+" : ""}${F.priceChg}, OI ${F.oiChg! >= 0 ? "+" : ""}${F.oiChg} = ${F.oiChgPct}%)`;
  const posDetail = (txt: string) => (!o.nseCovered ? "NSE participant data does not cover this index" : freshness === "UNKNOWN" ? "participant report unavailable" : `${txt} (NSE report ${last!.date}${freshness === "STALE" ? ", STALE" : ""})`);
  const fiiTxt = fii ? `FII index-futures net ${fmt(fii.net)} contracts, 3-session change ${fmt(fii.ch3)} → ${trend}` : "no FII metric";
  const liveMiss = !S ? "live price structure unavailable" : S.session !== "OPEN" ? `market ${S.session.toLowerCase()} — no completed 5-min candle today` : "no completed 5-min candle yet";
  const structTxt = (b: Tri, yes: string, no: string) => (b == null ? liveMiss : b ? yes : no);

  // A. bearish continuation
  const A = cardOf("BEARISH_CONTINUATION", "Bearish continuation", [
    { name: "FII positioning more bearish", pass: posOk ? fiiBear : null, detail: posDetail(fiiTxt), required: true },
    { name: "price below VWAP", pass: belowVwap, detail: structTxt(belowVwap, `last 5-min close ${c5?.close} below VWAP ${r(vw)}`, `last 5-min close ${c5?.close} above VWAP ${r(vw)}`), required: true },
    { name: "15-min regime bearish", pass: t15, detail: structTxt(t15, "15-min verdict DOWN", `15-min verdict ${S?.trend15}`), required: true },
    { name: "completed 5-min breakdown / bearish BOS", pass: bearBreak, detail: structTxt(bearBreak, "a completed 5-min candle confirmed the breakdown / bearish BOS (last 30 min)", "no confirmed breakdown or bearish BOS in the last 30 min"), required: true },
    { name: "futures short buildup", pass: fr == null ? null : fr === "SHORT BUILDUP" ? true : fr === "SHORT COVERING" || fr === "LONG BUILDUP" ? false : null, detail: futDetail, required: false },
  ], now, "Evaluate PE only if the existing Arbiter and risk gates approve.");
  // B. bullish continuation
  const B = cardOf("BULLISH_CONTINUATION", "Bullish continuation", [
    { name: "FII positioning more bullish", pass: posOk ? fiiBull : null, detail: posDetail(fiiTxt), required: true },
    { name: "price above VWAP", pass: aboveVwap, detail: structTxt(aboveVwap, `last 5-min close ${c5?.close} above VWAP ${r(vw)}`, `last 5-min close ${c5?.close} below VWAP ${r(vw)}`), required: true },
    { name: "15-min regime bullish", pass: u15, detail: structTxt(u15, "15-min verdict UP", `15-min verdict ${S?.trend15}`), required: true },
    { name: "completed 5-min breakout / bullish BOS", pass: bullBreak, detail: structTxt(bullBreak, "a completed 5-min candle confirmed the breakout / bullish BOS (last 30 min)", "no confirmed breakout or bullish BOS in the last 30 min"), required: true },
    { name: "futures long buildup", pass: fr == null ? null : fr === "LONG BUILDUP" ? true : fr === "SHORT BUILDUP" || fr === "LONG UNWINDING" ? false : null, detail: futDetail, required: false },
  ], now, "Evaluate CE only if the existing Arbiter and risk gates approve.");
  // C. short squeeze risk — elevated shorts are a CONDITION, never a signal on their own
  const elevated: Tri = !posOk || pct == null ? null : pct >= ELEVATED_SHORT_PCT && (fii?.net ?? 0) < 0;
  const closes = live ? S!.closed5.map((x) => x.close) : [];
  const reclaim: Tri = live && vw != null && closes.length >= 2 ? closes[closes.length - 1] > vw && closes.slice(-4, -1).some((x) => x < vw) : live ? null : null;
  const stoppedLL: Tri = live && S!.closed5.length >= 4 ? (S!.breakdown?.state === "FAILED_BREAKDOWN" && recent(S!, S!.breakdown?.barTime)) || Math.min(...S!.closed5.slice(-3).map((x) => x.low)) > Math.min(...S!.closed5.slice(0, -3).map((x) => x.low)) : live ? null : null;
  const turnBull: Tri = live ? u15 === true || lastBos?.direction === "Bullish" || bullBreak === true : null;
  const C = cardOf("SHORT_SQUEEZE_RISK", "Short-squeeze risk", [
    { name: "FII net short historically elevated", pass: elevated, detail: pct == null ? `percentile needs ≥ ${PCT_MIN_SESSIONS} sessions (have ${fiiNets.length})` : `FII net short is more short than ${pct}% of the last ${Math.min(PCT_WINDOW, fiiNets.length)} sessions (elevated ≥ ${ELEVATED_SHORT_PCT}%)`, required: true },
    { name: "lower lows stopped / breakdown failed", pass: stoppedLL, detail: structTxt(stoppedLL, "price stopped making lower lows (or a breakdown failed)", "price is still making lower lows"), required: true },
    { name: "completed 5-min reclaims VWAP or breaks resistance", pass: reclaim == null && bullBreak == null ? null : !!(reclaim || bullBreak), detail: structTxt(reclaim || bullBreak, "a completed 5-min candle reclaimed VWAP / broke resistance", "no VWAP reclaim or resistance break yet"), required: true },
    { name: "structure turning bullish", pass: turnBull, detail: structTxt(turnBull, "15-min UP or a bullish BOS / breakout", "structure not turned bullish"), required: true },
    { name: "futures short covering", pass: fr == null ? null : fr === "SHORT COVERING", detail: futDetail, required: false },
  ], now, "Elevated FII shorts alone are a positioning condition, not an entry signal.", true);
  // D. short covering (futures OI ↓ with price ↑) — live futures first; the EOD participant read is supporting context
  const fiiShortDown = fii && days.length >= 2 ? fii.grossShort < (legOf(days[days.length - 2], "FII", "INDEX_FUT")?.short ?? fii.grossShort) : null;
  const D = cardOf("SHORT_COVERING", "Short covering", [
    { name: "futures: price ↑ with OI ↓", pass: fr == null ? null : fr === "SHORT COVERING", detail: futDetail, required: true },
    { name: "FII gross shorts fell on the last report", pass: posOk ? fiiShortDown : null, detail: posDetail(fii ? `FII index-futures shorts ${cnt(fii.grossShort)} (${fiiShortDown ? "down" : "not down"} vs the previous report)` : "no FII metric"), required: false },
  ], now, "Short covering is not fresh long buildup.");
  // E. long buildup (futures OI ↑ with price ↑)
  const fiiLongUp = fii && days.length >= 2 ? fii.grossLong > (legOf(days[days.length - 2], "FII", "INDEX_FUT")?.long ?? fii.grossLong) : null;
  const E = cardOf("LONG_BUILDUP", "Long buildup", [
    { name: "futures: price ↑ with OI ↑", pass: fr == null ? null : fr === "LONG BUILDUP", detail: futDetail, required: true },
    { name: "FII gross longs rose on the last report", pass: posOk ? fiiLongUp : null, detail: posDetail(fii ? `FII index-futures longs ${cnt(fii.grossLong)} (${fiiLongUp ? "up" : "not up"} vs the previous report)` : "no FII metric"), required: false },
  ], now, "Needs compatible futures data; the end-of-day participant change is context, not a live position.");
  // F. mixed / no edge — the default whenever evidence conflicts or is missing
  const conflicts: string[] = [];
  if (fiiBear === true && aboveVwap === true) conflicts.push("FII positioning is bearish but price is above VWAP");
  if (fiiBull === true && belowVwap === true) conflicts.push("FII positioning is bullish but price is below VWAP");
  if (fiiBear === true && u15 === true) conflicts.push("FII positioning is bearish but the 15-min regime is UP");
  if (fiiBull === true && t15 === true) conflicts.push("FII positioning is bullish but the 15-min regime is DOWN");
  const lastFut = F?.sessions?.length ? F.sessions : null;
  if (fii && fii.ch1 != null && fii.ch1 < 0 && lastFut && lastFut.length >= 2) { const a = lastFut[lastFut.length - 2], b = lastFut[lastFut.length - 1]; if (b.date === last?.date && b.close > a.close) conflicts.push(`FII added net shorts on ${b.date} while the futures price rose`); }
  if (fiiBear === true && stoppedLL === true) conflicts.push("FII positioning is bearish but price is holding support (no lower lows)");
  const missing = ["FII / DII cash-market flows: not available (NSE serves them only through its browser session — not fetched)"];
  if (!o.nseCovered) missing.push("NSE participant data does not cover this index (BSE)");
  else if (freshness === "UNKNOWN") missing.push("participant report unavailable");
  else if (freshness === "STALE") missing.push(`participant report STALE: latest ${last!.date}, expected ${o.expectedReportDate}`);
  if (!F?.available) missing.push(`index futures OI: ${F?.reason || "not available"}`);
  if (!live) missing.push(`live structure: ${liveMiss}`);
  const dirActive = A.status === "ACTIVE" || B.status === "ACTIVE";
  const Fc: Card = { key: "MIXED_NO_EDGE", title: "Mixed / no edge", status: dirActive && !conflicts.length ? "INACTIVE" : "ACTIVE", conditions: [], supporting: conflicts.length ? conflicts : dirActive ? [] : ["no continuation set-up has all its conditions"], contradicting: dirActive ? [`${A.status === "ACTIVE" ? A.title : B.title} conditions all pass`] : [], missing, note: "Never forced bullish or bearish when evidence conflicts.", evaluatedAt: now };
  const cards = [A, B, C, D, E, Fc];

  // ---- scores (0–100; 50 = neutral; >50 bullish evidence, <50 bearish; squeeze risk separate) with confidence
  const chHist = fiiNets.slice(1).map((x, i) => x - fiiNets[i]).map((_, i, arr) => (i >= 2 ? arr[i] + arr[i - 1] + arr[i - 2] : null)).filter((x): x is number => x != null);
  const rank = (xs: number[], v: number) => (xs.length < 30 ? null : xs.filter((x) => x < v).length / xs.length);
  const instR = posOk && fii?.ch3 != null ? rank(chHist.slice(-PCT_WINDOW), fii.ch3) : null;
  const institutional = { score: instR == null ? null : Math.round(instR * 100), confidence: instR == null ? 0 : freshness === "STALE" ? 0.5 : 1,
    parts: instR == null ? [] : [`FII 3-session net change ${fmt(fii!.ch3)} ranks at ${Math.round(instR * 100)}% of the last ${Math.min(PCT_WINDOW, chHist.length)} 3-session changes (one feature: the net change; the net level is used only for squeeze risk)`] };
  const sComps = [aboveVwap == null ? null : aboveVwap ? 1 : -1, u15 == null ? null : u15 ? 1 : t15 ? -1 : 0, bullBreak == null ? null : bullBreak ? 1 : bearBreak ? -1 : 0];
  const sAv = sComps.filter((x): x is number => x != null);
  const structure = { score: sAv.length ? Math.round(50 + 50 * (sAv.reduce((a, x) => a + x, 0) / 3)) : null, confidence: sAv.length / 3,
    parts: [`VWAP ${aboveVwap == null ? "n/a" : aboveVwap ? "+1 above" : "−1 below"}`, `15-min ${u15 == null ? "n/a" : u15 ? "+1 UP" : t15 ? "−1 DOWN" : "0 RANGE"}`, `5-min break/BOS ${bullBreak == null ? "n/a" : bullBreak ? "+1 bullish" : bearBreak ? "−1 bearish" : "0 none"}`] };
  const fv = fr == null ? null : ({ "LONG BUILDUP": 1, "SHORT COVERING": 0.5, UNCHANGED: 0, "LONG UNWINDING": -0.5, "SHORT BUILDUP": -1 } as Record<string, number>)[fr] ?? 0;
  const cb = S?.chainOiBias == null ? null : S.chainOiBias === "BULLISH" ? 0.5 : S.chainOiBias === "BEARISH" ? -0.5 : 0;
  const dAv = [fv, cb].filter((x): x is number => x != null);
  const derivatives = { score: dAv.length ? Math.round(50 + 50 * (dAv.reduce((a, x) => a + x, 0) / 1.5)) : null, confidence: dAv.length / 2,
    parts: [`index futures ${fr ?? "n/a"}${fv != null ? ` (${fv >= 0 ? "+" : ""}${fv})` : ""}`, `option-chain writers (Dhan strike OI) ${S?.chainOiBias ?? "n/a"}${cb != null ? ` (${cb >= 0 ? "+" : ""}${cb})` : ""}`] };
  const conf = [stoppedLL, reclaim || bullBreak, turnBull].filter((x) => x === true).length;
  const squeeze = { score: pct == null || !posOk ? null : Math.round(Math.min(100, (fii!.net < 0 ? pct : 0) * 0.6 + (40 * conf) / 3)), confidence: pct == null ? 0 : live ? 1 : 0.5,
    parts: pct == null ? [] : [`net-short percentile ${fii!.net < 0 ? pct : 0} × 0.6`, `price confirmations ${conf}/3 × 40/3`] };
  const scores = { institutional, structure, derivatives, squeeze };

  // ---- institutional bias and explanation (rule outputs only)
  const bias = !posOk ? "UNKNOWN" : fiiBear ? "BEARISH" : fiiBull ? "BULLISH" : "NEUTRAL";
  const active = cards.filter((c) => c.status === "ACTIVE" && c.key !== "MIXED_NO_EDGE");
  const interp = A.status === "ACTIVE" && !conflicts.length ? "BEARISH_CONTINUATION_CANDIDATE" : B.status === "ACTIVE" && !conflicts.length ? "BULLISH_CONTINUATION_CANDIDATE" : C.status === "ACTIVE" ? "SHORT_SQUEEZE_RISK" : !posOk && !live ? "NO_EDGE" : "MIXED";
  const ex: string[] = [];
  if (fii && posOk) ex.push(`FII index-futures positioning is ${fmt(fii.net)} contracts net (long/short ${fii.longShortRatio ?? "n/a"}); over 3 sessions it changed by ${fmt(fii.ch3)} → ${trend}${pct != null ? `, more short than ${pct}% of the last ${Math.min(PCT_WINDOW, fiiNets.length)} sessions` : ""}.`);
  else ex.push(o.nseCovered ? "No usable participant report." : "NSE participant reports do not cover this index; only the live structure and futures are read.");
  if (live) ex.push(`Price is ${aboveVwap ? "above" : "below"} VWAP${vw != null ? ` (${r(vw)})` : ""}, the 15-min regime is ${S!.trend15}, and ${bullBreak ? "a completed 5-min candle confirmed a breakout / bullish BOS" : bearBreak ? "a completed 5-min candle confirmed a breakdown / bearish BOS" : "no 5-min break is confirmed in the last 30 min"}.`);
  else ex.push(`Live structure: ${liveMiss}.`);
  if (F?.available && fr) ex.push(`Index futures: ${fr.toLowerCase()} (OI ${F.oiChgPct! >= 0 ? "+" : ""}${F.oiChgPct}% vs the previous session).`);
  if (conflicts.length) ex.push(`Conflicts: ${conflicts.join("; ")}.`);
  ex.push(`Current interpretation: ${interp.replace(/_/g, " ")}.${interp === "MIXED" || interp === "NO_EDGE" ? " Wait for a completed 5-min structure confirmation." : interp === "SHORT_SQUEEZE_RISK" ? " Avoid fresh shorts; a CE needs the Arbiter's own confirmation." : " The Arbiter and risk gates still decide."}`);
  const explanation = ex.join(" ");

  // ---- the structured object for the Master Trade Selector / Arbiter (information only)
  const sentiment = { underlying: o.underlying, data_as_of: last?.date ?? null, freshness_status: o.nseCovered ? freshness : "NOT COVERED", institutional_bias: bias, positioning_trend: trend,
    bearish_continuation_status: A.status, bullish_continuation_status: B.status, short_squeeze_risk: C.status, short_covering_status: D.status, long_buildup_status: E.status,
    interpretation: interp, component_scores: { institutional: institutional.score, structure: structure.score, derivatives: derivatives.score, squeeze_risk: squeeze.score },
    supporting_evidence: active.flatMap((c) => c.supporting), contradicting_evidence: conflicts, missing_data: missing, explanation,
    authority: "INFORMATION ONLY — the Arbiter and hard risk gates decide; this object never changes a decision until ProTrader approves it on the backtest" };
  return { underlying: o.underlying, nseCovered: o.nseCovered, reportDate: last?.date ?? null, sourceReportId: last?.sourceReportId ?? null, freshness, expectedReportDate: o.expectedReportDate,
    sessions: days.length, metrics, fii: fii ? { ...fii, trend, shortPercentile: pct, elevated, window: Math.min(PCT_WINDOW, fiiNets.length), basis: "NET position (long − short contracts), index futures, all NSE indices together" } : null,
    cards, scores, interpretation: interp, conflicts, missing, explanation, sentiment, live: { session: S?.session ?? null, asOf: S?.asOf ?? null, aboveVwap, trend15: S?.trend15 ?? null, bullBreak, bearBreak, vwap: vw, lastClose: c5?.close ?? null }, futures: F };
}
const fmt = (v: number | null | undefined) => (v == null ? "n/a" : (v > 0 ? "+" : "") + Math.round(v).toLocaleString("en-IN"));
const cnt = (v: number | null | undefined) => (v == null ? "n/a" : Math.round(v).toLocaleString("en-IN"));   // gross counts carry no sign
const r = (v: number | null) => (v == null ? "n/a" : Math.round(v * 100) / 100);
