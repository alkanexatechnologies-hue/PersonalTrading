import fs from "fs";
import path from "path";
import { Candle, OiAnalysis } from "../types";
import { ema, macd, vwap, rsi, bollinger, supertrend } from "../indicators";
import { detectStructure } from "../commentary/marketCommentary";
import { isMarketOpenIST } from "./sessionFeed";
import { MarketSnapshotRecord, OptionChainRecord, StrategySnapshotRecord } from "./tradingDataTypes";

// ============================ Live Snapshot Recorder ============================
// PASSIVE OBSERVER — data collection only. This file does not call arbitrate(),
// does not compute a trade decision, and does not alter what /oi-command
// returns to the client. It is invoked AFTER the live route has already
// computed its payload (routes/api.ts's GET /oi-command, right after `ext` is
// resolved) and simply writes down what the system already computed/already
// has — every technical indicator here goes through the SAME functions
// (indicators/index.ts, commentary/marketCommentary.ts) already used by the
// live signal path; nothing is recomputed with different logic.
//
// Storage: file-based (this project has no database — see the session's
// architecture note), append-only JSONL, partitioned by IST calendar day:
//   data/trading_data/<YYYY-MM-DD>/market_snapshots.jsonl
//   data/trading_data/<YYYY-MM-DD>/option_chain.jsonl
//   data/trading_data/<YYYY-MM-DD>/strategy_snapshots.jsonl
// Rows are NEVER rewritten or deleted by this file. option_chain rows are
// deduped on timestamp+symbol+expiry+strike+optionType before being appended.

const ROOT = path.join(process.cwd(), "data", "trading_data");

function istDateStr(d = new Date()): string {
  return new Date(d.getTime() + 19_800_000).toISOString().slice(0, 10);
}

function partitionDir(d = new Date()): string {
  return path.join(ROOT, istDateStr(d));
}

function appendLine(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// ---- Dedup guard, per file, per IST calendar day ----
// /oi-command is cached 15s but can be called far more often than that
// (multiple browser tabs, background jobs sharing the same cache) - every one
// of those calls would otherwise try to record the SAME already-computed
// data again. Each file gets its own key set, lazily loaded from that day's
// existing lines (so a server restart mid-day doesn't lose the guard and
// start duplicating), reset automatically when the IST day rolls over.
const dedupState = new Map<string, { day: string; keys: Set<string> }>();
function ensureDedupLoaded(filePath: string, day: string, keyOf: (rec: any) => string): Set<string> {
  const state = dedupState.get(filePath);
  if (state && state.day === day) return state.keys;
  const keys = new Set<string>();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { keys.add(keyOf(JSON.parse(line))); } catch { /* malformed line — dataQualityValidator reports these separately */ }
    }
  } catch { /* no file yet today — empty set is correct */ }
  dedupState.set(filePath, { day, keys });
  return keys;
}
function chainKey(r: Pick<OptionChainRecord, "timestamp" | "symbol" | "expiry" | "strike" | "optionType">): string {
  return `${r.timestamp}|${r.symbol}|${r.expiry}|${r.strike}|${r.optionType}`;
}
function tsSymbolKey(r: Pick<MarketSnapshotRecord, "timestamp" | "symbol">): string {
  return `${r.timestamp}|${r.symbol}`;
}
// Appends `obj` only if `keyOf(obj)` hasn't been written to this file yet
// today; returns true if it was actually written.
function appendIfNew(filePath: string, day: string, obj: any, keyOf: (rec: any) => string): boolean {
  const keys = ensureDedupLoaded(filePath, day, keyOf);
  const key = keyOf(obj);
  if (keys.has(key)) return false;
  keys.add(key);
  appendLine(filePath, obj);
  return true;
}

function lastOf(series: (number | null)[]): number | null {
  return series.length ? series[series.length - 1] : null;
}

function statusFromCompare(a: number | null, b: number | null): "Bullish" | "Bearish" | "Neutral" | null {
  if (a == null || b == null) return null;
  if (a > b) return "Bullish";
  if (a < b) return "Bearish";
  return "Neutral";
}

export interface RecordSnapshotInput {
  symbol: string;
  timestamp: number; // epoch seconds — use the payload's own asOf/bar time, not Date.now()
  spot: number | null;
  atm: number | null; // nearestStrike(spot, def) — the same utility the live payload already uses
  expiry: string | null;
  candles: Candle[]; // the SAME 15m candles already fetched for this /oi-command call
  oi: OiAnalysis | null; // the SAME OiAnalysis already fetched for this call (null = chain unavailable)
  oiVerdict: string | null; // buildOiCommand()'s oiVerdict
  masterDecision: string | null; // ext.arbitration.verdict, or null if ext is unavailable
  finalScore: number | null; // ext.finalScore, if available
  regime: string | null; // ext.regime, if available
}

export interface RecordSnapshotResult {
  marketSnapshot: MarketSnapshotRecord;
  optionChainRows: number;
  strategySnapshot: StrategySnapshotRecord;
}

export function recordLiveSnapshot(input: RecordSnapshotInput): RecordSnapshotResult {
  const day = istDateStr(new Date(input.timestamp * 1000));
  const dir = partitionDir(new Date(input.timestamp * 1000));
  const closes = input.candles.map((c) => c.close);

  const ema9 = lastOf(ema(closes, 9));
  const ema21 = lastOf(ema(closes, 21));
  const ema50 = lastOf(ema(closes, 50));
  const macdSeries = macd(closes);
  const vwapVal = lastOf(vwap(input.candles));
  const rsiVal = lastOf(rsi(closes, 14));
  const bb = bollinger(closes, 20, 2);
  const st = supertrend(input.candles, 10, 3);
  const lastSt = st.length ? st[st.length - 1] : null;
  const structure = input.candles.length ? detectStructure(input.candles) : null;

  const marketSnapshot: MarketSnapshotRecord = {
    timestamp: input.timestamp,
    recordedAt: Date.now(),
    symbol: input.symbol,
    spot: input.spot,
    atm: input.atm,
    expiry: input.expiry,
    marketSession: isMarketOpenIST() ? "OPEN" : "CLOSED",
    technicals: {
      ema9, ema21, ema50,
      macd: lastOf(macdSeries.macd),
      macdSignal: lastOf(macdSeries.signal),
      macdHistogram: lastOf(macdSeries.histogram),
      vwap: vwapVal,
      rsi: rsiVal,
      bollingerUpper: lastOf(bb.upper),
      bollingerMiddle: lastOf(bb.middle),
      bollingerLower: lastOf(bb.lower),
      supertrend: lastSt ? lastSt.value : null,
      supertrendDirection: lastSt ? lastSt.direction : null,
    },
    marketStructure: structure,
    regime: input.regime,
  };
  appendIfNew(path.join(dir, "market_snapshots.jsonl"), day, marketSnapshot, tsSymbolKey);

  // ---- option_chain (one row per CE + one per PE, per strike) ----
  const chainFile = path.join(dir, "option_chain.jsonl");
  let written = 0;
  const strikes = input.oi?.topStrikes || [];
  for (const s of strikes) {
    for (const side of ["CE", "PE"] as const) {
      const rec: OptionChainRecord = {
        timestamp: input.timestamp,
        symbol: input.symbol,
        expiry: input.expiry,
        strike: s.strike,
        optionType: side,
        ltp: side === "CE" ? (s.ceLtp ?? null) : (s.peLtp ?? null),
        open: null, high: null, low: null, close: null, // Groww's live chain has no per-option OHLC — never invented
        volume: side === "CE" ? (s.ceVol ?? null) : (s.peVol ?? null),
        openInterest: side === "CE" ? s.ceOi : s.peOi,
        oiChange: side === "CE" ? s.ceChg : s.peChg,
        iv: side === "CE" ? (s.ceIv ?? null) : (s.peIv ?? null),
      };
      if (appendIfNew(chainFile, day, rec, chainKey)) written++;
    }
  }

  const strategySnapshot: StrategySnapshotRecord = {
    timestamp: input.timestamp,
    symbol: input.symbol,
    oiBias: input.oiVerdict,
    callScore: null, // not exposed anywhere in the live system — see tradingDataTypes.ts
    putScore: null,
    masterDecision: input.masterDecision,
    finalScore: input.finalScore,
    regime: input.regime,
    marketStructure: structure,
    vwapStatus: input.spot != null ? statusFromCompare(input.spot, vwapVal) : null,
    emaStatus: statusFromCompare(ema9, ema21),
    macdStatus: (() => {
      const h = lastOf(macdSeries.histogram);
      if (h == null) return null;
      return h > 0 ? "Bullish" : h < 0 ? "Bearish" : "Neutral";
    })(),
  };
  appendIfNew(path.join(dir, "strategy_snapshots.jsonl"), day, strategySnapshot, tsSymbolKey);

  return { marketSnapshot, optionChainRows: written, strategySnapshot };
}
