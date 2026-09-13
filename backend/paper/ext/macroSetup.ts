// ============================ Macro Setup Signals ============================
// STANDALONE MODULE — not yet wired into entryRules.ts's live Setup gate or into
// tryOpenOption. Per your explicit choice: written + unit-tested only, exactly
// like OpeningRangeBreakoutEngine.ts was before it was wired in. Nothing here
// changes live trading behavior until it's deliberately plugged in.
//
// What this adds to "Setup" (per your request): four new votes, following the
// exact same convention entryRules.ts's levelContext() already uses for its own
// 3-vote bias (Day Open / PDC / VWAP) — majority-of-votes, ties/unavailable data
// read as Neutral (0), never as an opposing signal.
//   1. Global market pattern — today's US overnight close + this morning's Asian
//      session, AND yesterday's equivalent read (your "last day also"), so you
//      can see whether today's global cue reinforces or reverses yesterday's.
//   2. Which sector is up this morning — a leaderboard across the sector tags
//      already in config/index.ts's SWING_SYMBOLS/OIL_GAS_SYMBOLS lists.
//   3. Bank Nifty's own movement (Nifty-specific).
//   4. IT sector movement (Nifty-specific).
//
// DATA-SOURCING NOTE (flagging deliberately, since it crosses a documented
// boundary elsewhere in this app): data/index.ts states "there is no Yahoo /
// TrueData fallback anywhere in the data path" — Yahoo is used ONLY for
// fundamentals/multibagger (yf.quoteSummary/yf.chart), never for live
// prices/candles that feed a trading decision. fetchGlobalMarketReads() below
// is a deliberate, explicit exception to that rule, per your choice — there is
// no GIFT Nifty / SGX Nifty feed available anywhere in this app, and no live
// Dow/Nasdaq/S&P feed either, so Yahoo's daily-close history is the only
// available source for a global-market read. If that boundary matters to you
// or to whoever else is editing this codebase, this comment is the flag.
//
// IT-SECTOR NOTE: config/index.ts's own sector:"IT" tag only covers 3 small/
// mid-cap names (KPIT Technologies, Tata Elxsi, Tata Technologies) — none of
// them F&O, none of them what actually moves Nifty. The stocks that actually
// carry Nifty's IT weight (Infosys, TCS, HCL Tech) live in DEFAULT_SYMBOLS
// untagged. NIFTY_IT_MAJORS below is a deliberate override of the generic
// sector-tag data for the Nifty-specific IT vote only — flagged here rather
// than silently picked, since it diverges from what's already in config.

import { Candle } from "../../types";
import { istDateOfSec } from "../../util/istTime";
import { ALL_SYMBOLS } from "../../config";

export type MacroVote = 1 | -1 | 0;

/** Sign of a % change. Missing/zero/non-finite reads as Neutral (0) — never an
 * opposing vote, matching levelContext()'s existing "flat = neutral" behavior. */
export function voteFromPct(pct: number | null | undefined): MacroVote {
  if (pct == null || !isFinite(pct) || pct === 0) return 0;
  return pct > 0 ? 1 : -1;
}

/** Combine two independent votes the same way levelContext's 3-vote bias would:
 * agreement (or one side simply unavailable) passes the nonzero side through;
 * active disagreement cancels out to Neutral. */
export function combineTwoVotes(a: MacroVote, b: MacroVote): MacroVote {
  if (a === 0) return b;
  if (b === 0) return a;
  return a === b ? a : 0;
}

// ---------------------------- Global market pattern ----------------------------

export interface GlobalMarketReads {
  usTodayPct: number | null;    // avg % change, most recent completed US session (Dow/Nasdaq/S&P)
  usYesterdayPct: number | null; // the US session before that
  asiaTodayPct: number | null;  // avg % change, this morning's Asian session (Nikkei/Hang Seng)
  asiaYesterdayPct: number | null;
}

export interface GlobalMarketBias {
  todayBias: MacroVote;
  yesterdayBias: MacroVote;
  /** true when today's read isn't Neutral AND agrees with yesterday's — i.e. the
   * global cue is reinforcing, not reversing. */
  consistent: boolean;
  notes: string[];
}

export function classifyGlobalMarketBias(r: GlobalMarketReads): GlobalMarketBias {
  const usToday = voteFromPct(r.usTodayPct);
  const asiaToday = voteFromPct(r.asiaTodayPct);
  const todayBias = combineTwoVotes(usToday, asiaToday);

  const usYesterday = voteFromPct(r.usYesterdayPct);
  const asiaYesterday = voteFromPct(r.asiaYesterdayPct);
  const yesterdayBias = combineTwoVotes(usYesterday, asiaYesterday);

  const consistent = todayBias !== 0 && todayBias === yesterdayBias;

  const fmt = (label: string, pct: number | null) => (pct == null ? `${label} n/a` : `${label} ${pct > 0 ? "+" : ""}${Math.round(pct * 100) / 100}%`);
  const notes = [
    fmt("US (today)", r.usTodayPct), fmt("Asia (today)", r.asiaTodayPct),
    fmt("US (prior day)", r.usYesterdayPct), fmt("Asia (prior day)", r.asiaYesterdayPct),
    consistent ? "today's global read confirms yesterday's" : (todayBias !== 0 && yesterdayBias !== 0 ? "today's global read REVERSES yesterday's" : "no prior-day confirmation available"),
  ];
  return { todayBias, yesterdayBias, consistent, notes };
}

// ---------------------------- Sector leaderboard ----------------------------

/** % change since today's session open, from whatever candle series is passed
 * in (1m/5m/15m all work). Pure — the caller fetches candles via whatever
 * source (getCandlesCached etc.) is already live elsewhere in the app. */
export function pctChangeSinceOpen(candles: Candle[]): number | null {
  if (!candles || !candles.length) return null;
  const lastBar = candles[candles.length - 1];
  const session = istDateOfSec(lastBar.time);
  const todayBars = candles.filter((c) => istDateOfSec(c.time) === session);
  if (!todayBars.length) return null;
  const dayOpen = todayBars[0].open;
  if (!dayOpen) return null;
  return ((lastBar.close - dayOpen) / dayOpen) * 100;
}

/** Average % change across whichever of `symbols` have a reading in
 * `pctBySymbol`. Missing symbols are skipped, not treated as 0. */
export function computeBasketPct(pctBySymbol: Record<string, number | null | undefined>, symbols: string[]): number | null {
  const vals = symbols.map((s) => pctBySymbol[s]).filter((v): v is number => v != null && isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Sector -> constituent symbols, built from config/index.ts's own `sector` tags
 * (ALL_SYMBOLS already merges DEFAULT_SYMBOLS + OIL_GAS_SYMBOLS + SWING_SYMBOLS).
 * Most of these sectors are the SWING_SYMBOLS watchlist, not the live F&O-20 —
 * only oil_gas is F&O throughout. Sectors with fewer than `minSymbols` tagged
 * members are excluded, since a 1-stock "sector" isn't a rotation read. */
export function buildSectorBaskets(minSymbols = 2): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const def of ALL_SYMBOLS as any[]) {
    const sector = def?.sector;
    if (!sector) continue;
    (out[sector] ||= []).push(def.symbol);
  }
  for (const k of Object.keys(out)) if (out[k].length < minSymbols) delete out[k];
  return out;
}

export interface SectorMove {
  sector: string;
  avgPct: number;
  symbolsUsed: number;
}

/** Ranks sectors by average % move, richest data first. Pass a fixture
 * `baskets` map in tests instead of buildSectorBaskets() for determinism. */
export function rankSectors(pctBySymbol: Record<string, number | null | undefined>, baskets: Record<string, string[]>): SectorMove[] {
  const rows: SectorMove[] = [];
  for (const [sector, syms] of Object.entries(baskets)) {
    const vals = syms.map((s) => pctBySymbol[s]).filter((v): v is number => v != null && isFinite(v));
    if (!vals.length) continue;
    rows.push({ sector, avgPct: vals.reduce((a, b) => a + b, 0) / vals.length, symbolsUsed: vals.length });
  }
  return rows.sort((a, b) => b.avgPct - a.avgPct);
}

// ---------------------------- Nifty-specific votes ----------------------------

// Deliberate override of the generic sector tag — see IT-SECTOR NOTE above.
export const NIFTY_IT_MAJORS = ["INFY.NS", "TCS.NS", "HCLTECH.NS"];

// LIVE-WIRING scope note: buildSectorBaskets() above (from config's generic
// `sector` tags) would mean dozens of extra Groww calls every few minutes for
// a display feature, most of them names Groww may not even quote reliably
// (the SWING_SYMBOLS watchlist, not the live F&O-20). This curated map reuses
// symbols from DEFAULT_SYMBOLS's F&O-20 that other features already poll live
// (runHourlyScan, the paper engine's own scans) — so in the common case this
// sector-leader vote costs zero incremental Groww load beyond a cache hit on
// getCandlesCached's existing 30s TTL. Deliberately narrower than the generic
// tag-based baskets, flagged here rather than silently swapped in.
export const NIFTY_SECTOR_PROXIES: Record<string, string[]> = {
  Bank: ["HDFCBANK.NS", "ICICIBANK.NS", "AXISBANK.NS", "KOTAKBANK.NS", "SBIN.NS"],
  IT: NIFTY_IT_MAJORS,
  Auto: ["TATAMOTORS.NS", "M&M.NS", "MARUTI.NS"],
  "Oil & Gas": ["RELIANCE.NS"],
  Metals: ["TATASTEEL.NS"],
  Pharma: ["SUNPHARMA.NS"],
  Finance: ["BAJFINANCE.NS"],
  Telecom: ["BHARTIARTL.NS"],
  Infra: ["LT.NS", "POWERGRID.NS", "ADANIENT.NS"],
  Consumer: ["ITC.NS", "TITAN.NS"],
};

export interface NiftyMacroInputs {
  global: GlobalMarketBias;
  sectorLeaderboard: SectorMove[];
  bankNiftyPctSinceOpen: number | null;
  itMajorsPctSinceOpen: number | null; // computeBasketPct(pctBySymbol, NIFTY_IT_MAJORS)
}

export interface NiftyMacroVote {
  name: string;
  dir: MacroVote;
  note: string;
}

export interface NiftyMacroSetupResult {
  votes: NiftyMacroVote[];
  agree: number;
  against: number;
  bias: MacroVote;
  topSector: string | null;
  notes: string[];
}

export function computeNiftyMacroSetup(inp: NiftyMacroInputs): NiftyMacroSetupResult {
  const votes: NiftyMacroVote[] = [];

  votes.push({
    name: "Global markets (US+Asia, today vs prior day)",
    dir: inp.global.todayBias,
    note: inp.global.notes.join(" · "),
  });

  const bnVote = voteFromPct(inp.bankNiftyPctSinceOpen);
  votes.push({
    name: "Bank Nifty",
    dir: bnVote,
    note: inp.bankNiftyPctSinceOpen == null ? "Bank Nifty: n/a" : `Bank Nifty ${inp.bankNiftyPctSinceOpen > 0 ? "+" : ""}${Math.round(inp.bankNiftyPctSinceOpen * 100) / 100}% since open`,
  });

  const itVote = voteFromPct(inp.itMajorsPctSinceOpen);
  votes.push({
    name: "IT majors (INFY/TCS/HCLTECH)",
    dir: itVote,
    note: inp.itMajorsPctSinceOpen == null ? "IT majors: n/a" : `IT majors ${inp.itMajorsPctSinceOpen > 0 ? "+" : ""}${Math.round(inp.itMajorsPctSinceOpen * 100) / 100}% since open`,
  });

  const top = inp.sectorLeaderboard[0] ?? null;
  const topSectorVote = top ? voteFromPct(top.avgPct) : 0;
  votes.push({
    name: `Morning sector leader${top ? ` (${top.sector})` : ""}`,
    dir: topSectorVote,
    note: top ? `${top.sector} leads at ${top.avgPct > 0 ? "+" : ""}${Math.round(top.avgPct * 100) / 100}% (${top.symbolsUsed} names)` : "no sector data available",
  });

  const nonZero = votes.filter((v) => v.dir !== 0);
  const up = nonZero.filter((v) => v.dir === 1).length;
  const down = nonZero.filter((v) => v.dir === -1).length;
  const bias: MacroVote = up > down ? 1 : down > up ? -1 : 0;

  return { votes, agree: Math.max(up, down), against: Math.min(up, down), bias, topSector: top?.sector ?? null, notes: votes.map((v) => v.note) };
}

// ---------------------------- I/O wrapper (untested, thin) ----------------------------
// Same convention as fundamentals.ts/multibagger.ts: a module-level YahooFinance
// instance, try/catch-to-null, and a short cache (global indices don't need
// per-tick freshness — once every few minutes is plenty for a morning read).

import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });

const US_TICKERS = ["^DJI", "^IXIC", "^GSPC"];
const ASIA_TICKERS = ["^N225", "^HSI"];
const GLOBAL_CACHE_TTL_MS = 5 * 60 * 1000;
let globalCache: { at: number; data: GlobalMarketReads } | null = null;

/** Last two daily closes -> % change for the most recent session and the one
 * before it. Returns [null, null] if Yahoo has nothing usable for this ticker. */
async function lastTwoDailyChanges(ticker: string): Promise<[number | null, number | null]> {
  try {
    const res: any = await yf.chart(ticker, {
      period1: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000), // 12 calendar days back, comfortably covers weekends/holidays
      interval: "1d",
    });
    const closes: number[] = (res?.quotes || [])
      .map((q: any) => q?.close)
      .filter((c: any) => c != null && isFinite(c));
    if (closes.length < 2) return [null, null];
    const n = closes.length;
    const today = ((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100;
    const yesterday = n >= 3 ? ((closes[n - 2] - closes[n - 3]) / closes[n - 3]) * 100 : null;
    return [today, yesterday];
  } catch {
    return [null, null];
  }
}

function avg(vals: (number | null)[]): number | null {
  const v = vals.filter((x): x is number => x != null && isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export async function fetchGlobalMarketReads(): Promise<GlobalMarketReads> {
  if (globalCache && Date.now() - globalCache.at < GLOBAL_CACHE_TTL_MS) return globalCache.data;
  const [us, asia] = await Promise.all([
    Promise.all(US_TICKERS.map(lastTwoDailyChanges)),
    Promise.all(ASIA_TICKERS.map(lastTwoDailyChanges)),
  ]);
  const data: GlobalMarketReads = {
    usTodayPct: avg(us.map((x) => x[0])),
    usYesterdayPct: avg(us.map((x) => x[1])),
    asiaTodayPct: avg(asia.map((x) => x[0])),
    asiaYesterdayPct: avg(asia.map((x) => x[1])),
  };
  globalCache = { at: Date.now(), data };
  return data;
}
