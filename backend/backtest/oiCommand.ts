import { Candle } from "../types";
import { findSymbolDef } from "../config";
import { GrowwProvider, growwOptionCandles, growwSpotCandles } from "../data/growwProvider";
import { findOption, optionStrikes, optionExpiries } from "../data/growwInstruments";
import { OiSignal, Horizon, HORIZONS, loadOiSignalLog } from "../oi/oiCommandLog";

// ---- OI Command Back-Test engine ------------------------------------------
// The OI Command grid's DIRECTION read comes from LIVE intraday open-interest
// change vs a same-day baseline. Historical intraday OI is NOT retrievable, so
// the grid cannot be recomputed for past timestamps. What we CAN back-test for a
// given day is the concrete recommendation the grid produces:
//   1) DIRECTION accuracy: did the underlying move the predicted way at the
//      5 / 15 / 60-minute horizons (measured on real spot candles)?
//   2) OPTION TRADE result: taking the exact recommended leg (ATM CE/PE at the
//      signal LTP) with the grid's own targets/stop, did it hit target or stop,
//      what was the best/worst premium, and what was the end-of-session P&L -
//      all measured on the option's REAL historical candles from Groww.
// Two entry points:
//   - simulateOiOptionTrade(): back-test ONE setup (used for the live grid).
//   - backtestOiCommandLog():  replay all of a day's logged signals.

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const toEpoch = (date: string, hm: string) => Math.floor(Date.parse(`${date}T${hm}:00+05:30`) / 1000);
const hhmm = (epoch: number) => new Date((epoch + 19800) * 1000).toISOString().slice(11, 16);
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

function candleAtOrAfter(cs: Candle[], epoch: number): Candle | null {
  for (const c of cs) if (c.time >= epoch) return c;
  return cs.length ? cs[cs.length - 1] : null;
}
function candleAtOrBefore(cs: Candle[], epoch: number): Candle | null {
  let out: Candle | null = null;
  for (const c of cs) { if (c.time <= epoch) out = c; else break; }
  return out || (cs.length ? cs[0] : null);
}
function spotAt(cs: Candle[], epoch: number): number | null {
  const c = candleAtOrBefore(cs, epoch);
  return c ? c.close : null;
}

// Grid's default option trade-management multipliers (see buildOiCommand()).
const TGT_LO = 1.20, TGT_HI = 1.35, SL = 0.88;

export interface DirEval {
  horizon: Horizon;
  evalTime: string | null;
  evalSpot: number | null;
  favMove: number | null;               // move in the predicted direction (pts)
  status: "correct" | "wrong" | "flat" | "no-data";
}

export interface OiTradeSim {
  available: boolean;
  message?: string;
  underlying: string;
  optionType: "CE" | "PE";
  strike: number;
  expiry: string;
  tradingSymbol?: string;
  lotSize?: number;
  date: string;
  entryTime: string;
  entrySpot: number | null;
  entryPremium: number | null;
  target: number | null;                 // targetLo (first take-profit)
  targetHi: number | null;
  stop: number | null;
  outcome: "TARGET" | "STOP" | "OPEN";   // what happened first through the session
  outcomeTime: string | null;
  exitPremium: number | null;            // premium used for the result
  pnlPct: number | null;                 // entry -> exit
  bestPremium: number | null; bestPct: number | null; bestTime: string | null;
  worstPremium: number | null; worstPct: number | null; worstTime: string | null;
  eodPremium: number | null; eodPct: number | null;
  direction: "UP" | "DOWN" | "FLAT";
  dir: DirEval[];                        // 5 / 15 / 60-min direction accuracy
}

export interface SimParams {
  symbol: string;                        // internal symbol (^NSEI) or NSE symbol
  optionType: "CE" | "PE";
  strike: number;
  expiry?: string;                       // yyyy-mm-dd; nearest is used if omitted/unmatched
  date: string;                          // yyyy-mm-dd (IST)
  entryHM: string;                       // "09:20"
  direction: "UP" | "DOWN" | "FLAT";
  expLow: number;                        // expected favourable move (pts) for a "correct" call
  entryPremium?: number;                 // grid LTP; else first candle open
  exitHM?: string;                       // session end for the sim (default 15:25)
}

// Resolve the option's expiry: use the requested one if it exists, else the
// nearest available expiry on/after the trade date for that underlying.
async function resolveExpiry(underlying: string, date: string, wanted?: string): Promise<string | null> {
  const exps = await optionExpiries(underlying).catch(() => [] as string[]);
  if (wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) && exps.includes(wanted)) return wanted;
  // nearest expiry on/after the trade date (weekly ATM scalps use the front expiry)
  const onOrAfter = exps.filter((e) => e >= date).sort();
  if (onOrAfter.length) return onOrAfter[0];
  return exps.length ? exps[exps.length - 1] : (wanted || null);
}

// Snap to the nearest listed strike for that expiry (guards against a strike that
// isn't listed, e.g. spacing/rounding differences).
async function resolveStrike(underlying: string, expiry: string, type: "CE" | "PE", wanted: number): Promise<number> {
  const strikes = await optionStrikes(underlying, expiry, type).catch(() => [] as number[]);
  if (!strikes.length) return wanted;
  if (strikes.includes(wanted)) return wanted;
  return strikes.reduce((b, s) => (Math.abs(s - wanted) < Math.abs(b - wanted) ? s : b), strikes[0]);
}

export async function simulateOiOptionTrade(provider: GrowwProvider, p: SimParams): Promise<OiTradeSim> {
  const def = findSymbolDef(p.symbol);
  const underlying = (def?.nseSymbol || p.symbol.replace(/\.NS$/i, "")).toUpperCase();
  const base: OiTradeSim = {
    available: false, underlying, optionType: p.optionType, strike: p.strike, expiry: p.expiry || "",
    date: p.date, entryTime: p.entryHM, entrySpot: null, entryPremium: null,
    target: null, targetHi: null, stop: null, outcome: "OPEN", outcomeTime: null, exitPremium: null, pnlPct: null,
    bestPremium: null, bestPct: null, bestTime: null, worstPremium: null, worstPct: null, worstTime: null,
    eodPremium: null, eodPct: null, direction: p.direction, dir: [],
  };

  const expiry = await resolveExpiry(underlying, p.date, p.expiry);
  if (!expiry) return { ...base, message: `${underlying} के लिए कोई option expiry नहीं मिली (instruments master).` };
  const strike = await resolveStrike(underlying, expiry, p.optionType, p.strike);
  const inst = await findOption(underlying, p.optionType, strike, expiry);
  if (!inst) return { ...base, expiry, strike, message: `Option नहीं मिला: ${underlying} ${strike} ${p.optionType} ${expiry}.` };

  const dayStart = toEpoch(p.date, "09:15");
  const dayEnd = toEpoch(p.date, "15:30");
  const entryE = toEpoch(p.date, p.entryHM);
  const exitE = toEpoch(p.date, p.exitHM || "15:25");

  let optCs: Candle[] = [];
  try {
    optCs = await growwOptionCandles(provider, inst.tradingSymbol, dayStart, dayEnd, 5);
  } catch (e: any) {
    return { ...base, expiry, strike, tradingSymbol: inst.tradingSymbol, message: `Option historical data नहीं मिला: ${e?.message || e}` };
  }
  if (!optCs.length) return { ...base, expiry, strike, tradingSymbol: inst.tradingSymbol, message: `${p.date} को इस option की कोई candle नहीं (छुट्टी/weekend या strike उस दिन list नहीं था)।` };
  let spotCs: Candle[] = [];
  try { spotCs = await growwSpotCandles(provider, underlying, dayStart, dayEnd, 5); } catch { spotCs = []; }

  // Entry premium = grid LTP if given, else the first option candle open at/after entry.
  const entryC = candleAtOrAfter(optCs, entryE);
  const entryPremium = p.entryPremium && p.entryPremium > 0 ? r2(p.entryPremium) : entryC ? r2(entryC.open) : null;
  if (entryPremium == null || !(entryPremium > 0)) return { ...base, expiry, strike, tradingSymbol: inst.tradingSymbol, lotSize: inst.lotSize, message: "Entry premium नहीं मिला।" };

  const target = r2(entryPremium * TGT_LO);
  const targetHi = r2(entryPremium * TGT_HI);
  const stop = r2(entryPremium * SL);

  // Walk the option candles from entry to session end. Track best/worst and the
  // FIRST touch of target or stop (conservative: if a single bar spans both,
  // assume the stop triggered first).
  const window = optCs.filter((c) => c.time >= (entryC ? entryC.time : entryE) && c.time <= exitE);
  let bestHigh = entryPremium, bestHighT = entryC ? entryC.time : entryE;
  let worstLow = entryPremium, worstLowT = entryC ? entryC.time : entryE;
  let outcome: OiTradeSim["outcome"] = "OPEN";
  let outcomeTime: number | null = null;
  let exitPremium = entryPremium;
  for (const c of window) {
    if (c.high > bestHigh) { bestHigh = c.high; bestHighT = c.time; }
    if (c.low < worstLow) { worstLow = c.low; worstLowT = c.time; }
    const hitStop = c.low <= stop;
    const hitTgt = c.high >= target;
    if (hitStop && hitTgt) { outcome = "STOP"; outcomeTime = c.time; exitPremium = stop; break; }
    if (hitStop) { outcome = "STOP"; outcomeTime = c.time; exitPremium = stop; break; }
    if (hitTgt) { outcome = "TARGET"; outcomeTime = c.time; exitPremium = target; break; }
  }
  const eodC = candleAtOrBefore(optCs, exitE) || optCs[optCs.length - 1];
  const eodPremium = eodC ? r2(eodC.close) : entryPremium;
  if (outcome === "OPEN") exitPremium = eodPremium; // never hit target/stop -> exit at close

  const pnlPct = r1(((exitPremium - entryPremium) / entryPremium) * 100);
  const bestPct = r1(((bestHigh - entryPremium) / entryPremium) * 100);
  const worstPct = r1(((worstLow - entryPremium) / entryPremium) * 100);
  const eodPct = r1(((eodPremium - entryPremium) / entryPremium) * 100);

  // Direction accuracy at 5 / 15 / 60 min on real spot candles.
  const entrySpot = spotAt(spotCs, entryE);
  const dirEvals: DirEval[] = HORIZONS.map((hz) => {
    const dueE = entryE + Number(hz) * 60;
    const s = spotAt(spotCs, dueE);
    if (entrySpot == null || s == null) return { horizon: hz, evalTime: null, evalSpot: null, favMove: null, status: "no-data" };
    const favMove = p.direction === "DOWN" ? entrySpot - s : s - entrySpot;
    const status: DirEval["status"] = p.direction === "FLAT" ? "flat" : favMove >= p.expLow ? "correct" : favMove <= -p.expLow ? "wrong" : "flat";
    return { horizon: hz, evalTime: hhmm(dueE), evalSpot: r2(s), favMove: r2(favMove), status };
  });

  return {
    available: true, underlying, optionType: p.optionType, strike, expiry,
    tradingSymbol: inst.tradingSymbol, lotSize: inst.lotSize,
    date: p.date, entryTime: hhmm(entryC ? entryC.time : entryE), entrySpot: entrySpot != null ? r2(entrySpot) : null,
    entryPremium, target, targetHi, stop,
    outcome, outcomeTime: outcomeTime != null ? hhmm(outcomeTime) : null, exitPremium: r2(exitPremium), pnlPct,
    bestPremium: r2(bestHigh), bestPct, bestTime: hhmm(bestHighT),
    worstPremium: r2(worstLow), worstPct, worstTime: hhmm(worstLowT),
    eodPremium, eodPct,
    direction: p.direction, dir: dirEvals,
  };
}

// ---- Logged-signal replay -------------------------------------------------

export interface LogReplayResult {
  available: boolean;
  message?: string;
  date: string;
  symbol: string | null;
  count: number;
  signals: Array<{
    time: string; symbol: string; name: string; direction: "UP" | "DOWN";
    optionType: "CE" | "PE"; strike: number | null; confidence: number; spot: number;
    sim: OiTradeSim | null;
  }>;
  direction: Record<Horizon, { evaluated: number; correct: number; wrong: number; flat: number; winPct: number }>;
  option: { trades: number; targets: number; stops: number; open: number; wins: number; winPct: number; avgPnlPct: number; sumPnlPct: number };
}

// Reads the same log oi/oiCommandLog.ts writes - delegated there instead of
// duplicating the file path + read logic in this module.
const readLog = loadOiSignalLog;

export async function backtestOiCommandLog(
  provider: GrowwProvider,
  opts: { date?: string; symbol?: string } = {}
): Promise<LogReplayResult> {
  const date = opts.date || istDateOf(Math.floor(Date.now() / 1000));
  const symbol = opts.symbol;
  const empty: LogReplayResult = {
    available: false, date, symbol: symbol || null, count: 0, signals: [],
    direction: { "5": { evaluated: 0, correct: 0, wrong: 0, flat: 0, winPct: 0 }, "15": { evaluated: 0, correct: 0, wrong: 0, flat: 0, winPct: 0 }, "60": { evaluated: 0, correct: 0, wrong: 0, flat: 0, winPct: 0 } },
    option: { trades: 0, targets: 0, stops: 0, open: 0, wins: 0, winPct: 0, avgPnlPct: 0, sumPnlPct: 0 },
  };

  const rows = readLog().filter((r) => r.istDate === date && (!symbol || r.symbol === symbol)).sort((a, b) => a.at - b.at);
  if (!rows.length) {
    return { ...empty, message: `${date} के लिए कोई logged OI-Command signal नहीं. Server के market-hours में चलने पर हर ~5 min signal log होते हैं (data/oi-command-log.json).` };
  }

  const signals: LogReplayResult["signals"] = [];
  const dirAgg = empty.direction;
  const opt = { trades: 0, targets: 0, stops: 0, open: 0, wins: 0, winPct: 0, avgPnlPct: 0, sumPnlPct: 0 };

  for (const r of rows) {
    let sim: OiTradeSim | null = null;
    if (r.strike != null) {
      sim = await simulateOiOptionTrade(provider, {
        symbol: r.symbol, optionType: r.optionType, strike: r.strike,
        date, entryHM: hhmm(r.at), direction: r.direction, expLow: r.expLow, entryPremium: undefined,
      }).catch(() => null);
    }
    signals.push({
      time: hhmm(r.at), symbol: r.symbol, name: r.name, direction: r.direction,
      optionType: r.optionType, strike: r.strike, confidence: r.confidence, spot: r.spot, sim,
    });
    if (sim && sim.available) {
      for (const de of sim.dir) {
        const bucket = dirAgg[de.horizon];
        if (de.status === "correct") { bucket.correct++; bucket.evaluated++; }
        else if (de.status === "wrong") { bucket.wrong++; bucket.evaluated++; }
        else if (de.status === "flat") { bucket.flat++; bucket.evaluated++; }
      }
      opt.trades++;
      if (sim.outcome === "TARGET") opt.targets++;
      else if (sim.outcome === "STOP") opt.stops++;
      else opt.open++;
      if ((sim.pnlPct ?? 0) > 0) opt.wins++;
      opt.sumPnlPct += sim.pnlPct ?? 0;
    }
  }
  for (const hz of HORIZONS) { const b = dirAgg[hz]; const denom = b.correct + b.wrong; b.winPct = denom ? r1((b.correct / denom) * 100) : 0; }
  opt.winPct = opt.trades ? r1((opt.wins / opt.trades) * 100) : 0;
  opt.avgPnlPct = opt.trades ? r1(opt.sumPnlPct / opt.trades) : 0;
  opt.sumPnlPct = r1(opt.sumPnlPct);

  return { available: true, date, symbol: symbol || null, count: rows.length, signals, direction: dirAgg, option: opt };
}
