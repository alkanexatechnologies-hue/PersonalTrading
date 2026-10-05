// Live BUY CE / BUY PE for the Universal Indicator Lab chart — STRICTLY 5M + 15M.
// Advisory only — never places an order (LIVE_ORDER_EXECUTION stays false).
//
// Live evaluates ONLY CLOSED 5M candles (and the 15M context from CLOSED 15M
// candles) with the same decision layer as a test run. No 1-minute data is
// fetched or used for direction, entry, SL, T1/T2 or exit, and there is no
// forming / intrabar candle: a signal or an SL / Target hit is known when the
// 5M candle closes, exactly as in a backtest. A replay `asOfSec` shows a past
// session as it looked at that moment (only candles closed by then).

import fs from "fs";
import path from "path";
import { ALL_SYMBOLS } from "../config";
import { dhanChainForExpiry } from "../data/dhanProvider";
import { defaultConfig, INDEX_MASTER, TF_MINUTES } from "./config";
import { decisionCard } from "./decisionCard";
import { contractKey, OptBar, OptionSeries } from "./optionsData";
import { evaluateSeries, loadSeries, LoadedSeries } from "./runner";
import { selectStrike } from "./strikeGamma";
import { DecisionRow, IndexKey, TestConfig, TfKey } from "./types";

const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);
const istHm = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(11, 16);
const dayStart = (d: string) => Math.floor(Date.parse(d + "T00:00:00+05:30") / 1000);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const OPEN_MIN = 9 * 60 + 15, CLOSE_MIN = 15 * 60 + 30;

const seriesCache = new Map<string, { at: number; p: Promise<LoadedSeries> }>();
const chainCache = new Map<string, { at: number; p: Promise<any> }>();
function cached<T>(m: Map<string, { at: number; p: Promise<T> }>, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = fn(); m.set(key, { at: Date.now(), p });
  p.catch(() => m.delete(key));
  if (m.size > 12) m.delete(m.keys().next().value as string);
  return p;
}

export interface LiveRead {
  time: number; hm: string; state: "CONFIRMED";
  row: DecisionRow; text: string;
  optionNote: string | null;
}

export interface LivePayload {
  mode: "LIVE" | "REPLAY";
  index: IndexKey; timeframe: TfKey;
  asOf: number; asOfHm: string;
  market: "OPEN" | "CLOSED";
  session: string | null;
  dataStatus: "LIVE" | "STALE" | "CLOSED" | "UNAVAILABLE";
  dataAgeSec: number | null;
  lastClosedHm: string | null;       // the latest CLOSED 5M candle evaluated
  awaitingCandleHm: string | null;   // LIVE: this closed candle is not published by Dhan yet (retried every poll)
  // same panel data a test run sends, so EVERY Lab panel refreshes in Live mode
  evidence: Record<string, unknown> | null;   // latest closed candle's indicator values (indicator strip)
  currentCandle: { t: number; o: number; h: number; l: number; c: number; v: number; oi: number | null } | null;
  binding: unknown; dataMode: string; dataQuality: string; oiStatus: string; vwapSource: string | null;
  dataRange: unknown; unavailableDateCount: number;
  liveLog: LiveLogEntry[];           // today's live log (LIVE mode), sent with the data so no extra request is needed
  nextCloseHm: string | null;        // when the next 5M candle closes (next evaluation)
  series: string;
  logic: string;
  chart: Array<{ t: number; o: number; h: number; l: number; c: number; v: number; ema9: number | null; ema21: number | null; vwap: number | null; exec: string; movement: string }>;
  markers: Array<{ t: number; side: "BUY" | "SELL"; state: "CONFIRMED"; text: string }>;
  lastClosed: LiveRead | null;
  lastSignal: (LiveRead & { barsAgo: number }) | null;
  note: string;
}

function marketOpenAt(sec: number): boolean {
  const d = new Date(sec * 1000 + 19800000);
  const wd = d.getUTCDay(), min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd >= 1 && wd <= 5 && min >= OPEN_MIN && min < CLOSE_MIN;
}

/** Live option chain snapshot -> one-time OptBar slice (ATM±N). Volume is the day's cumulative volume. */
function chainSlice(chain: any, time: number, step: number, offsets: number): OptionSeries | null {
  if (!chain?.available || !Array.isArray(chain.strikes)) return null;
  const spot = Number(chain.spot);
  const atm = Math.round(spot / step) * step;
  const byTime = new Map<number, { CE: OptBar[]; PE: OptBar[] }>();
  const byContract = new Map<string, Map<number, OptBar>>();
  const slot = { CE: [] as OptBar[], PE: [] as OptBar[] };
  for (const s of chain.strikes) {
    const k = Math.round((s.strike - atm) / step);
    if (Math.abs(k) > offsets || s.strike % step !== 0) continue;
    for (const side of ["CE", "PE"] as const) {
      const ltp = side === "CE" ? s.ceLtp : s.peLtp;
      if (ltp == null || !(ltp > 0)) continue;
      const bar: OptBar = {
        time, strike: s.strike, offset: k, side, open: ltp, high: ltp, low: ltp, close: ltp,
        iv: side === "CE" ? s.ceIv : s.peIv, oi: side === "CE" ? s.ceOi : s.peOi,
        volume: side === "CE" ? s.ceVol : s.peVol, spot, expiry: chain.expiry,
      };
      slot[side].push(bar);
      byContract.set(contractKey(chain.expiry, side, s.strike), new Map([[time, bar]]));
    }
  }
  byTime.set(time, slot);
  return { status: "AVAILABLE", note: "live option chain snapshot", byTime, byContract, expiryByDate: new Map(), expirySource: "exchange expiry list (live chain)" };
}

export async function liveDecision(opts: { index: IndexKey; timeframe: TfKey; asOfSec?: number }): Promise<LivePayload> {
  const { index, timeframe } = opts;
  const replay = opts.asOfSec != null;
  const now = opts.asOfSec ?? Math.floor(Date.now() / 1000);
  const tfSec = TF_MINUTES[timeframe] * 60;
  const today = istDate(now);
  const open = marketOpenAt(now);

  const cfg: TestConfig = defaultConfig(index, timeframe);
  cfg.dataMode = "FUTURES_INTERNAL"; cfg.futuresBinding = "strict";
  cfg.scope = { mode: "custom", fromDate: addDays(today, -6), toDate: today };
  cfg.asOfSec = now;
  const m = INDEX_MASTER[index];

  // closed series: reloaded once per 5M candle close (session-relative grid from 09:15)
  const sessOpen = dayStart(today) + OPEN_MIN * 60;
  const bucketKey = open ? Math.floor((now - sessOpen) / tfSec) : Math.floor(now / tfSec);
  const cacheKey = `${index}|${timeframe}|${today}|${bucketKey}|${replay ? now : ""}`;
  const L = await cached(seriesCache, cacheKey, replay ? 60_000 : 300_000, () => loadSeries(cfg));
  // LIVE: the 5M candle that just closed may not be published by Dhan yet — if it is missing,
  // drop the cache so the next poll (15 s) fetches again instead of waiting for the next candle.
  const expectedLast = open ? sessOpen + (bucketKey - 1) * tfSec : null;   // start time of the latest candle that should be closed
  const haveLast = L.candles.length ? L.candles[L.candles.length - 1].time : null;
  const awaitingCandle = !replay && expectedLast != null && expectedLast >= sessOpen && (haveLast == null || haveLast < expectedLast);
  if (awaitingCandle) seriesCache.delete(cacheKey);
  // evaluate ONLY the closed candles (loadSeries keeps candles with time + interval <= now); no forming candle
  const res = evaluateSeries(cfg, L, {});
  const d = res.decision!;
  const session = d.rows.length ? d.rows[d.rows.length - 1].date : null;
  const rows = d.rows.filter((r) => r.date === session);
  const chartAll = res.chart.filter((c) => istDate(c.t) === session);
  const series = res.binding.futuresSymbol || `${m.nseSymbol} FUT`;

  // live option chain for the card when the historical slice has no bar for that candle (LIVE only)
  const fillStrike = async (r: DecisionRow, prevTime: number | null): Promise<string | null> => {
    if (!r.plan || r.option?.status === "AVAILABLE") return null;
    if (!replay) {
      const def = ALL_SYMBOLS.find((s) => s.nseSymbol === m.nseSymbol);
      const chain = def ? await cached(chainCache, `${m.nseSymbol}`, 15_000, () => dhanChainForExpiry(def)).catch(() => null) : null;
      const snap = chainSlice(chain, r.timestamp, m.strikeStep, (cfg.decision!).strikeOffsets);
      if (snap) {
        r.option = selectStrike({ series: snap, side: r.plan.side === "BUY" ? "CE" : "PE", time: r.timestamp, prevTime: null, spot: r.spot ?? chain.spot, rewardPts: r.plan.rewardPoints, riskPts: r.plan.riskPoints, dc: cfg.decision!, strikeStep: m.strikeStep });
        return "strike from the live option chain (volume = today's cumulative)";
      }
    }
    if (prevTime != null && L.options) {
      r.option = selectStrike({ series: L.options, side: r.plan.side === "BUY" ? "CE" : "PE", time: prevTime, prevTime: null, spot: r.spot, rewardPts: r.plan.rewardPoints, riskPts: r.plan.riskPoints, dc: cfg.decision!, strikeStep: m.strikeStep });
      if (r.option.status === "AVAILABLE") return `option prices from the last closed candle ${istHm(prevTime)}`;
    }
    return null;
  };

  const read = async (r: DecisionRow | undefined, state: LiveRead["state"], prevTime: number | null): Promise<LiveRead | null> => {
    if (!r) return null;
    const optionNote = await fillStrike(r, prevTime);
    return { time: r.timestamp, hm: istHm(r.timestamp), state, row: r, text: decisionCard(r, index, series), optionNote };
  };

  const closedRows = rows;
  const lastClosedRow = closedRows[closedRows.length - 1];
  const sigIdx = (() => { for (let k = closedRows.length - 1; k >= 0; k--) if (closedRows[k].action === "TAKE") return k; return -1; })();

  const lastClosed = await read(lastClosedRow, "CONFIRMED", closedRows.length > 1 ? closedRows[closedRows.length - 2].timestamp : null);
  const lastSig = sigIdx >= 0 ? await read(closedRows[sigIdx], "CONFIRMED", sigIdx > 0 ? closedRows[sigIdx - 1].timestamp : null) : null;

  const markers: LivePayload["markers"] = closedRows.filter((r) => r.action === "TAKE" && r.plan).map((r) => ({
    t: r.timestamp, side: r.plan!.side, state: "CONFIRMED" as const, text: r.plan!.side === "BUY" ? "BUY CE" : "BUY PE",
  }));

  const rowByTime = new Map(rows.map((r) => [r.timestamp, r]));
  const chart = chartAll.map((c) => ({
    t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, ema9: c.ema9, ema21: c.ema21, vwap: c.vwap,
    exec: rowByTime.get(c.t)?.executionState ?? "WAIT", movement: rowByTime.get(c.t)?.movementState ?? "NO_EDGE",
  }));

  // data age = time since the last CLOSED 5M candle closed; STALE once the next close is overdue by > 150 s
  const lastCloseSec = lastClosedRow ? lastClosedRow.timestamp + tfSec : null;
  const age = lastCloseSec != null ? Math.max(0, now - lastCloseSec) : null;
  const dataStatus: LivePayload["dataStatus"] = !open ? "CLOSED" : age == null ? "UNAVAILABLE" : age > tfSec + 150 ? "STALE" : "LIVE";
  if (!replay && open) appendLiveLog(index, timeframe, today, closedRows, now);
  const nextCloseSec = lastCloseSec != null ? lastCloseSec + tfSec : null;

  return {
    mode: replay ? "REPLAY" : "LIVE", index, timeframe, asOf: now, asOfHm: istHm(now),
    market: open ? "OPEN" : "CLOSED", session, dataStatus, dataAgeSec: age,
    lastClosedHm: lastClosedRow ? istHm(lastClosedRow.timestamp) : null,
    evidence: (() => {
      const er = lastClosedRow ? res.rows.find((x) => x.timestamp === lastClosedRow.timestamp) : undefined;
      if (!er) return null;
      return {
        iso: er.iso, spotPrice: er.spotPrice, utState: er.utState, emaDirection: er.emaDirection, priceVsEMA: er.priceVsEMA,
        ema9: er.ema9, ema21: er.ema21, vwap: er.vwap, vwapSource: er.vwapSource, structureState: er.structureState, bos: er.bos,
        volumeState: er.volumeState, atr: er.atr, atrPercent: er.atrPercent, regressionDirection: er.regressionDirection, regressionR2: er.regressionR2,
        support: er.support, resistance: er.resistance, fakeMove: er.fakeMove, extendedMove: er.extendedMove,
        expiryRisk: er.expiryRisk, daysToExpiry: er.daysToExpiry, dataQuality: er.dataQuality, futuresOI: er.futuresOI, oiStatus: er.oiStatus,
      };
    })(),
    currentCandle: (() => { const cc = res.chart.length ? res.chart[res.chart.length - 1] : null; return cc && istDate(cc.t) === session ? { t: cc.t, o: cc.o, h: cc.h, l: cc.l, c: cc.c, v: cc.v, oi: cc.oi } : null; })(),
    binding: res.binding, dataMode: res.dataMode, dataQuality: res.dataQuality, oiStatus: res.oiStatus,
    vwapSource: res.rows.length ? res.rows[res.rows.length - 1].vwapSource : null,
    dataRange: { ...res.dataRange, from: session ?? res.dataRange.from, to: session ?? res.dataRange.to, totalCandles: chartAll.length },
    unavailableDateCount: res.unavailableDateCount,
    liveLog: !replay ? readLiveLog(today).slice(-50) : [],
    awaitingCandleHm: awaitingCandle && expectedLast != null ? istHm(expectedLast) : null,
    nextCloseHm: open && nextCloseSec != null ? istHm(nextCloseSec) : null,
    series,
    logic: "15M context + 5M confirmed break + engine score agrees (counter-trend / range breaks need a strong 5M candle). R:R is information only.",
    chart, markers, lastClosed, lastSignal: lastSig ? { ...lastSig, barsAgo: closedRows.length - 1 - sigIdx } : null,
    note: !open
      ? `Market closed — showing the last session (${session ?? "none"}).`
      : `Evaluated on CLOSED 5M candles only (15M context from closed 15M candles). Last closed candle ${lastClosedRow ? istHm(lastClosedRow.timestamp) : "—"}; next evaluation when the candle closes at ${nextCloseSec != null ? istHm(nextCloseSec) : "—"}.`,
  };
}

// ---------------- live test log (server-side, LIVE mode only) ----------------
// Records each BUY CE / BUY PE signal and every change of its status exactly as the
// live screen saw it, with the wall-clock time, so a live session can be compared
// with a backtest of the same day afterwards. Append-only JSONL per day.
const LIVE_LOG_DIR = path.resolve(process.cwd(), "data", "test-zone", "live-log");
const lastLogged = new Map<string, string>();   // `${date}|${index}|${tf}|${signalTime}` -> last logged status

export interface LiveLogEntry {
  loggedAt: string; index: string; timeframe: string; signalCandle: string;
  action: string; regime15: string; movement: string;
  entry: number; stopLoss: number; target1: number; target2: number; rr: number;
  strike: string | null; optionLtp: number | null;
  fill: number | null; status: string; exitPrice: number | null; rMultiple: number | null;
  optionFill: number | null; optionExit: number | null; optionPnl: number | null;
}

function appendLiveLog(index: string, tf: string, date: string, rows: DecisionRow[], now: number) {
  try {
    const signals = rows.filter((r) => r.finalAction !== "WAIT" && r.plan);
    if (!signals.length) return;
    fs.mkdirSync(LIVE_LOG_DIR, { recursive: true });
    const file = path.join(LIVE_LOG_DIR, `${date}.jsonl`);
    for (const r of signals) {
      const key = `${date}|${index}|${tf}|${r.timestamp}`;
      const status = r.outcome === "NONE" ? "SIGNAL (awaiting next-candle fill)" : r.outcome;
      if (lastLogged.get(key) === status) continue;
      lastLogged.set(key, status);
      const p = r.plan!, o = r.option;
      const e: LiveLogEntry = {
        loggedAt: new Date(now * 1000 + 19800000).toISOString().slice(0, 19).replace("T", " ") + " IST",
        index, timeframe: tf, signalCandle: istHm(r.timestamp), action: r.finalAction, regime15: r.regime15, movement: r.movementState,
        entry: p.entry, stopLoss: p.stopLoss, target1: p.target1, target2: p.target2, rr: p.rr,
        strike: o?.primary ? `${o.primary.strike} ${o.optionType}` : null, optionLtp: o?.optionEntry ?? null,
        fill: r.fillPrice, status, exitPrice: r.exitPrice, rMultiple: r.rMultiple,
        optionFill: r.optionFill, optionExit: r.optionExit, optionPnl: r.optionPnl,
      };
      fs.appendFileSync(file, JSON.stringify(e) + "\n", "utf8");
    }
  } catch { /* logging must never break the live view */ }
}

export function readLiveLog(date: string): LiveLogEntry[] {
  try {
    const file = path.join(LIVE_LOG_DIR, `${date}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
