// Breakout Engine → Market Command payload. Runs the pure engine on the SAME
// candles Market Command already fetched (no extra Dhan call), attaches the
// option leg for a FRESH live signal from the SAME option chain snapshot, and
// records that option plan so it is never rebuilt later from a different chain.
// Additive: Market Command's existing command/plan fields are untouched.

import fs from "node:fs";
import path from "node:path";
import { Candle, OiAnalysis } from "../types";
import { SymbolDef } from "../config";
import { lookupDhanOption } from "../data/dhanInstruments";
import { runSession, BREAKOUT_CONFIG, BarEval, Signal, EngineState } from "./breakoutEngine";
import { buildOptionPlan, OptionPlan } from "./breakoutOption";

export const BREAKOUT_VERSION = "breakout/v1";

export interface BreakoutSignalOut {
  barTime: number; iso: string; dir: "BUY" | "SELL"; plan: Signal["plan"];
  buyScore: number; sellScore: number;
  option: OptionPlan | null;
  optionSource: "LIVE" | "RECORDED" | "NOT RECORDED";
  executable: boolean;            // spot plan + option gates passed when evaluated live
  gateNote: string | null;
}
export interface BreakoutPayload {
  available: boolean;
  version: string;
  error?: string;
  sessionDate: string | null;
  live: boolean;
  dataStatus: string;
  latest: (Omit<BarEval, "i"> & { optionGate: string | null }) | null;
  signals: BreakoutSignalOut[];
  blocked: { time: number; dir: "BUY" | "SELL"; trigger: number | null; state: EngineState; reason: string }[];
  counts: Record<string, number>;
  config: { rrMin: number; biasMin: number; biasEdge: number; breakBufferAtr: number; obstacleAtr: number; maxSlAtr: number; extEma9Atr: number; extTriggerAtr: number; extVwapAtr: number; lateCutoff: string };
  note: string;
}

// ---- recorded live option plans (one file per session day) ----
const DEFAULT_DIR = path.join(process.cwd(), "data", "breakout-signals");
const _recorded = new Map<string, Map<string, BreakoutSignalOut>>();
function dayMap(day: string, DIR: string): Map<string, BreakoutSignalOut> {
  const mk = `${DIR}|${day}`;
  let m = _recorded.get(mk);
  if (m) return m;
  m = new Map();
  try {
    for (const line of fs.readFileSync(path.join(DIR, `${day}.jsonl`), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && o.key && o.signal) m.set(o.key, o.signal); } catch { /* skip bad line */ }
    }
  } catch { /* no file yet */ }
  _recorded.set(mk, m);
  return m;
}
function record(day: string, key: string, sig: BreakoutSignalOut, DIR: string) {
  dayMap(day, DIR).set(key, sig);
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(path.join(DIR, `${day}.jsonl`), JSON.stringify({ key, at: Date.now(), signal: sig }) + "\n"); } catch { /* best-effort */ }
}

// The session result only changes when a new candle CLOSES (or data health flips),
// so cache it per (symbol, interval, last closed bar, data status).
const _cache = new Map<string, { at: number; v: ReturnType<typeof runSession> }>();

export async function buildBreakout(input: {
  candles: Candle[]; intervalSec: number; isHistorical: boolean; nowSec: number; marketOpen: boolean;
  def: SymbolDef; symbol: string; interval: string;
  oiChain: OiAnalysis | null; chainStale: boolean;
  chainPending?: boolean;          // chart-only fast payload: chain not loaded yet — don't judge the option gate
  dataStatus: string;              // LIVE / DELAYED / STALE / DISCONNECTED / HISTORICAL / UNAVAILABLE
}, deps: { lookupOption?: typeof lookupDhanOption; recordDir?: string } = {}): Promise<BreakoutPayload> {
  const lookupOption = deps.lookupOption ?? lookupDhanOption;
  const recordDir = deps.recordDir ?? DEFAULT_DIR;
  const cfg = BREAKOUT_CONFIG;
  const { candles, intervalSec, isHistorical, nowSec, marketOpen, def, symbol, interval } = input;
  const live = !isHistorical && marketOpen;
  const dataIssue = live && (input.dataStatus === "DISCONNECTED" || input.dataStatus === "STALE")
    ? (input.dataStatus === "DISCONNECTED" ? "DISCONNECTED — Dhan feed off; no live decision" : "STALE DATA — candles are not fresh; no live decision")
    : null;

  const n = candles.length;
  const lastClosed = n ? (candles[n - 1].time + intervalSec > nowSec ? candles[n - 2]?.time : candles[n - 1].time) : 0;
  const ck = `${symbol}:${interval}:${isHistorical ? "H" : "L"}:${lastClosed}:${dataIssue ? 1 : 0}`;
  let res = _cache.get(ck)?.v;
  if (!res) {
    res = runSession(candles, { intervalSec, nowSec: isHistorical ? undefined : nowSec, dataIssue });
    _cache.set(ck, { at: Date.now(), v: res });
    if (_cache.size > 60) { const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) _cache.delete(oldest[0]); }
  }

  const day = res.sessionDate || "";
  const recorded = day ? dayMap(day, recordDir) : new Map<string, BreakoutSignalOut>();
  const signals: BreakoutSignalOut[] = [];
  let latestGate: string | null = null;
  for (const s of res.signals) {
    const key = `${symbol}|${interval}|${s.barTime}`;
    const rec = recorded.get(key);
    if (rec) { signals.push({ ...rec, optionSource: "RECORDED" }); continue; }
    const fresh = live && !dataIssue && s.barTime === lastClosed;
    if (fresh && input.chainPending) {
      signals.push({ barTime: s.barTime, iso: s.iso, dir: s.dir, plan: s.plan, buyScore: s.buyScore, sellScore: s.sellScore, option: null, optionSource: "NOT RECORDED", executable: false, gateNote: "Option chain loading…" });
      continue;
    }
    if (!fresh) {
      signals.push({ barTime: s.barTime, iso: s.iso, dir: s.dir, plan: s.plan, buyScore: s.buyScore, sellScore: s.sellScore, option: null, optionSource: "NOT RECORDED", executable: false, gateNote: isHistorical ? "Replay — no historical option chain" : "Option plan was not recorded live for this bar" });
      continue;
    }
    // Fresh live signal: build the option leg from the live chain + instrument master.
    const side = s.dir === "BUY" ? "CE" : "PE";
    let securityId: string | null = null, securityDetail = "";
    const pre = buildOptionPlan(s.plan, input.oiChain, { name: def.name, stale: input.chainStale });
    if (pre.strike != null && pre.expiry && def.nseSymbol) {
      try {
        const m = await lookupOption(def.nseSymbol, side, pre.strike, pre.expiry);
        securityId = m ? String(m.securityId) : null;
        securityDetail = m ? `instrument master ${m.exchangeSegment} ${m.instrument}: ${def.nseSymbol} ${pre.expiry} ${pre.strike} ${side}` : `not in instrument master: ${def.nseSymbol} ${pre.expiry} ${pre.strike} ${side}`;
      } catch { securityId = null; securityDetail = "instrument master lookup failed"; }
    }
    const option = buildOptionPlan(s.plan, input.oiChain, { name: def.name, stale: input.chainStale, securityId, securityDetail });
    const executable = option.available && option.passesRR && !!option.identity?.verified;
    const out: BreakoutSignalOut = {
      barTime: s.barTime, iso: s.iso, dir: s.dir, plan: s.plan, buyScore: s.buyScore, sellScore: s.sellScore,
      option, optionSource: "LIVE", executable, gateNote: executable ? null : `Option gate: ${option.reason || "not executable"}`,
    };
    if (option.available || option.strike != null) record(day, key, out, recordDir);   // never re-derive from a later chain
    signals.push(out);
    if (!executable) latestGate = out.gateNote;
  }

  // The latest bar: a fresh signal that failed the option gate is NOT an executable
  // BUY/SELL — direction and breakout are right, the trade is not.
  let latest: BreakoutPayload["latest"] = null;
  if (res.latest) {
    const { i: _i, ...rest } = res.latest;
    latest = { ...rest, optionGate: null };
    const sigNow = signals.find((x) => x.barTime === res!.latest!.time);
    if (sigNow && live && !sigNow.executable && !input.chainPending) {
      latest.state = sigNow.dir === "BUY" ? "BUY CONFIRMED" : "SELL CONFIRMED";
      latest.command = "WAIT";
      latest.optionGate = sigNow.gateNote || latestGate;
      latest.rejectionReason = latest.optionGate;
      latest.reason = `${sigNow.dir} CONFIRMED — not executable: ${latest.optionGate}`;
    }
  }

  const counts: Record<string, number> = {};
  for (const r of res.rows) counts[r.state] = (counts[r.state] || 0) + 1;
  const blocked = res.rows
    .filter((r) => (r.state === "BUY CONFIRMED" || r.state === "SELL CONFIRMED" || r.state === "WAIT FOR PULLBACK") && r.confirmation === "PASS")
    .slice(-20)
    .map((r) => ({ time: r.time, dir: (r.state.startsWith("SELL") || r.bias.direction === "BEARISH" ? "SELL" : "BUY") as "BUY" | "SELL", trigger: r.triggerLevel, state: r.state, reason: r.rejectionReason || r.reason }));

  return {
    available: true, version: BREAKOUT_VERSION, sessionDate: res.sessionDate, live,
    dataStatus: isHistorical ? "HISTORICAL" : input.dataStatus,
    latest, signals, blocked, counts,
    config: {
      rrMin: cfg.rrMin, biasMin: cfg.biasMin, biasEdge: cfg.biasEdge, breakBufferAtr: cfg.breakBufferAtr, obstacleAtr: cfg.obstacleAtr,
      maxSlAtr: cfg.maxSlAtr, extEma9Atr: cfg.extEma9Atr, extTriggerAtr: cfg.extTriggerAtr, extVwapAtr: cfg.extVwapAtr,
      lateCutoff: `${Math.floor(cfg.lateCutoffMin / 60)}:${String(cfg.lateCutoffMin % 60).padStart(2, "0")} IST`,
    },
    note: "Advisory only — no orders. Direction from indicators; trigger from price S/R (swings, PDH/PDL/PDC, pivots, opening range, day high/low). Option premium levels are delta estimates from the live chain.",
  };
}
