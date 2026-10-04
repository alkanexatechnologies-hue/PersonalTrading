// Running-candle BUY/SELL recommendation for the Universal Indicator Lab chart.
// Advisory only — never places an order (LIVE_ORDER_EXECUTION stays false).
//
//   CONFIRMED  = the decision layer on CLOSED candles (final, never changes).
//   FORMING    = the same logic on the still-open candle, built from its closed
//                1-minute bars. Provisional: it can change until the candle closes.
// The engine is causal, so appending the forming candle cannot alter any earlier
// row. A replay `asOfSec` shows a past session exactly as it looked at that
// moment: nothing after asOf is used (the forming candle's own option bar is
// masked, because the rolling-option bar for it would contain its final close).

import { Candle } from "../types";
import { ALL_SYMBOLS } from "../config";
import { dhanChainForExpiry } from "../data/dhanProvider";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { defaultConfig, INDEX_MASTER, TF_MINUTES } from "./config";
import { fetchIntraday } from "./dhanData";
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
const minuteCache = new Map<string, { at: number; p: Promise<{ candles: Candle[]; oi: (number | null)[] }> }>();
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
  time: number; hm: string; state: "FORMING" | "CONFIRMED";
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
  formingAsOfHm: string | null;      // last closed 1-minute bar inside the forming candle
  series: string;
  logic: string;
  chart: Array<{ t: number; o: number; h: number; l: number; c: number; v: number; ema9: number | null; ema21: number | null; vwap: number | null; forming: boolean; exec: string; movement: string }>;
  markers: Array<{ t: number; side: "BUY" | "SELL"; state: "CONFIRMED" | "FORMING"; text: string }>;
  forming: LiveRead | null;
  lastClosed: LiveRead | null;
  lastSignal: (LiveRead & { barsAgo: number }) | null;
  note: string;
}

function marketOpenAt(sec: number): boolean {
  const d = new Date(sec * 1000 + 19800000);
  const wd = d.getUTCDay(), min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd >= 1 && wd <= 5 && min >= OPEN_MIN && min < CLOSE_MIN;
}

/** Copy of the option series with every bar at/after `fromSec` removed (no look-ahead into the forming candle). */
function maskOptions(o: OptionSeries | null, fromSec: number): OptionSeries | null {
  if (!o) return o;
  const byTime = new Map([...o.byTime].filter(([t]) => t < fromSec));
  const byContract = new Map([...o.byContract].map(([k, m]) => [k, new Map([...m].filter(([t]) => t < fromSec))]));
  return { ...o, byTime, byContract };
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

function aggregate(bars: Candle[], start: number): Candle | null {
  if (!bars.length) return null;
  return {
    time: start, open: bars[0].open, high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)),
    close: bars[bars.length - 1].close, volume: bars.reduce((s, b) => s + b.volume, 0),
  };
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

  // forming bucket (session-relative so 25m/60m bars line up with Dhan's 09:15 grid)
  const sessOpen = dayStart(today) + OPEN_MIN * 60;
  const bucketStart = open ? sessOpen + Math.floor((now - sessOpen) / tfSec) * tfSec : null;

  // closed series: reload once per candle close (plus every 5 minutes at most)
  const bucketKey = bucketStart ?? Math.floor(now / tfSec);
  const L = await cached(seriesCache, `${index}|${timeframe}|${today}|${bucketKey}|${replay ? now : ""}`, replay ? 60_000 : 300_000, () => loadSeries(cfg));

  // forming candle from closed 1-minute bars of the SAME instrument as the signal series
  let forming: { candle: Candle; oi: number | null; spotClose: number | null } | null = null;
  let formingAsOf: number | null = null;
  if (bucketStart != null && TF_MINUTES[timeframe] > 1 && L.repBinding.status === "RESOLVED" && L.repBinding.securityId) {
    const fut = L.repBinding;
    const spotSec = await lookupDhanSecurity(m.nseSymbol);
    const min1 = (id: string, seg: string, inst: string) => cached(minuteCache, `${id}|${bucketStart}|${replay ? now : Math.floor(Date.now() / 10_000)}`, 10_000,
      async () => {
        const r = await fetchIntraday(id, seg, inst, 1, bucketStart, now + 60);
        const keep = r.candles.map((c, i) => (c.time >= bucketStart && c.time + 60 <= now ? i : -1)).filter((i) => i >= 0);
        return { candles: keep.map((i) => r.candles[i]), oi: keep.map((i) => r.oi[i]) };
      });
    const empty = { candles: [] as Candle[], oi: [] as (number | null)[] };
    const fm = await min1(fut.securityId!, fut.exchangeSegment || m.futSegment, "FUTIDX").catch(() => empty);
    const sm = spotSec ? await min1(spotSec.securityId, spotSec.exchangeSegment, spotSec.instrument).catch(() => empty) : empty;
    const fBars = fm.candles, sBars = sm.candles;
    const fc = aggregate(fBars, bucketStart);
    if (fc) {
      const lastOi = [...fm.oi].reverse().find((x) => x != null) ?? null;   // futures OI from the latest closed minute
      forming = { candle: fc, oi: lastOi, spotClose: sBars.length ? sBars[sBars.length - 1].close : null };
      formingAsOf = fBars[fBars.length - 1].time;
    }
  }

  const masked: LoadedSeries = bucketStart != null ? { ...L, options: maskOptions(L.options, bucketStart) } : L;
  const res = evaluateSeries(cfg, masked, { forming });
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

  const formingRow = forming ? rows[rows.length - 1] : undefined;
  const closedRows = forming ? rows.slice(0, -1) : rows;
  const lastClosedRow = closedRows[closedRows.length - 1];
  const sigIdx = (() => { for (let k = closedRows.length - 1; k >= 0; k--) if (closedRows[k].action === "TAKE") return k; return -1; })();

  const formingRead = await read(formingRow, "FORMING", lastClosedRow?.timestamp ?? null);
  const lastClosed = await read(lastClosedRow, "CONFIRMED", closedRows.length > 1 ? closedRows[closedRows.length - 2].timestamp : null);
  const lastSig = sigIdx >= 0 ? await read(closedRows[sigIdx], "CONFIRMED", sigIdx > 0 ? closedRows[sigIdx - 1].timestamp : null) : null;

  const markers: LivePayload["markers"] = closedRows.filter((r) => r.action === "TAKE" && r.plan).map((r) => ({
    t: r.timestamp, side: r.plan!.side, state: "CONFIRMED" as const, text: r.plan!.side === "BUY" ? "BUY CE" : "BUY PE",
  }));
  if (formingRow?.action === "TAKE" && formingRow.plan) markers.push({ t: formingRow.timestamp, side: formingRow.plan.side, state: "FORMING", text: `forming ${formingRow.plan.side === "BUY" ? "BUY CE" : "BUY PE"}?` });

  const rowByTime = new Map(rows.map((r) => [r.timestamp, r]));
  const chart = chartAll.map((c) => ({
    t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, ema9: c.ema9, ema21: c.ema21, vwap: c.vwap,
    forming: !!forming && c.t === forming.candle.time,
    exec: rowByTime.get(c.t)?.executionState ?? "WAIT", movement: rowByTime.get(c.t)?.movementState ?? "NO_EDGE",
  }));

  const lastDataSec = formingAsOf != null ? formingAsOf + 60 : (lastClosedRow ? lastClosedRow.timestamp + tfSec : null);
  const age = lastDataSec != null ? Math.max(0, now - lastDataSec) : null;
  const dataStatus: LivePayload["dataStatus"] = !open ? "CLOSED" : age == null ? "UNAVAILABLE" : age > 150 ? "STALE" : "LIVE";

  return {
    mode: replay ? "REPLAY" : "LIVE", index, timeframe, asOf: now, asOfHm: istHm(now),
    market: open ? "OPEN" : "CLOSED", session, dataStatus, dataAgeSec: age,
    formingAsOfHm: formingAsOf != null ? istHm(formingAsOf + 60) : null,
    series,
    logic: "15M context + 5M confirmed break + engine score agrees (counter-trend / range breaks need a strong 5M candle). R:R is information only.",
    chart, markers, forming: formingRead, lastClosed, lastSignal: lastSig ? { ...lastSig, barsAgo: closedRows.length - 1 - sigIdx } : null,
    note: !open
      ? `Market closed — showing the last session (${session ?? "none"}); no forming candle.`
      : forming ? "FORMING is provisional and can change until the candle closes. Only CONFIRMED (closed candle) signals are final."
      : "Waiting for the first closed minute of the new candle.",
  };
}
