import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { getProvider, setActiveProvider } from "../data";
import { syncSessionProvider, rememberGrowwToken, forgetGrowwToken, isMarketOpenIST, setFeedFlags, getFeedFlags, hasGrowwToken, growwProviderForOi, getGrowwTokenMasked, persistGrowwToken, getGrowwToken, deletePersistedGrowwToken } from "../data/sessionFeed";

// ---- Groww data-health tracker (single source, so we can surface connection
// health + block live signals when Groww is unhealthy). Updated on each live
// data touch; counters are process-lifetime.
const growwHealth = { updates: 0, failures: 0, reconnects: 0, lastDataTs: 0, lastLatencyMs: 0 };
export function recordGrowwOk(latencyMs: number) { growwHealth.updates++; growwHealth.lastDataTs = Date.now(); growwHealth.lastLatencyMs = Math.round(latencyMs); }
export function recordGrowwFail() { growwHealth.failures++; }
export function recordGrowwReconnect() { growwHealth.reconnects++; }
export function getGrowwHealth() {
  const ageSec = growwHealth.lastDataTs ? (Date.now() - growwHealth.lastDataTs) / 1000 : null;
  return { ...growwHealth, dataAgeSec: ageSec == null ? null : Math.round(ageSec * 10) / 10 };
}
// Single source of truth for the Groww connection state (GREEN/YELLOW/RED/GREY/
// CLOSED) + whether live signals are blocked. Reused by /data-status + /groww/*.
export function computeGrowwStatus() {
  const feed = syncSessionProvider();
  const health = getGrowwHealth();
  let status: "GREEN" | "YELLOW" | "RED" | "GREY" | "CLOSED";
  if (!hasGrowwToken()) status = "GREY";              // not configured
  else if (!feed.growwOn) status = "RED";             // token present but feed OFF / unhealthy
  else if (!feed.marketOpen) status = "CLOSED";       // configured + on, market closed
  else if (health.dataAgeSec == null || health.dataAgeSec > 30) status = "YELLOW"; // connected, data delayed
  else status = "GREEN";                              // connected + fresh
  const signalsBlocked = status !== "GREEN";
  const reason =
    status === "GREY" ? "Groww not configured — connect a token" :
    status === "RED" ? "Groww disconnected — no valid market data" :
    status === "CLOSED" ? "Market closed — no live signals" :
    status === "YELLOW" ? "Groww data stale / delayed" : "";
  return { status, signalsBlocked, reason, marketOpen: feed.marketOpen, growwOn: feed.growwOn, configured: feed.configured, health };
}

// TRADING SAFETY GATE: live signals require healthy, fresh Groww data during
// market hours. When false, callers must NOT emit a live signal.
export function growwSignalsAllowed(): { allowed: boolean; reason: string } {
  if (!hasGrowwToken()) return { allowed: false, reason: "Groww not configured" };
  const feed = syncSessionProvider();
  if (!feed.growwOn) return { allowed: false, reason: "Groww disconnected" };
  if (!feed.marketOpen) return { allowed: false, reason: "Market closed — no live signals" };
  const age = getGrowwHealth().dataAgeSec;
  if (age != null && age > 30) return { allowed: false, reason: "Groww data stale" };
  return { allowed: true, reason: "" };
}
import { withTimeout } from "../util/timeout";
import { appendOiExcel, saveLastOiJson, loadLastOiJson, reviewMoodFromFile } from "../oi/oiExcel";
import { computeSignal } from "../signals/engine";
import { computeScoreSeries, DIRECTION_THRESHOLD } from "../signals/score";
import { runBacktest } from "../backtest/engine";
import { suggestOptionTrade } from "../options/suggest";
import { computeRiskRadar } from "../options/riskRadar";
import { analyzeVolume } from "../volume/analyze";
import { getOiAnalysis } from "../oi/oi";
import { growwOiAnalysis, GrowwProvider, growwHasOptions, growwZeroHero, growwRateLimitStats, runAsBackgroundGroww } from "../data/growwProvider";
import { buildNextDayPick } from "../nextday/outlook";
import { computeMomentumBurst } from "../scalp/momentum";
import { computeEarlyMove } from "../movement/earlyMove";
import { computeAttempts } from "../scalp/attempts";
import { computeOphl, recordPremium } from "../predict/ophl";
import { computeSwing } from "../swing/scan";
import { computeLongTerm } from "../longterm/scan";
import { getMultibagger } from "../longterm/multibagger";
import { computeMonthlyShot } from "../swing/monthly";
import { computeBigMove } from "../bigmove/radar";
import { startPaper, stopPaper, resetPaper, setAutoTrade, openManual, closeManualById, getPaperSummary, tickPaper, tickPaperScalps, markPaper, dailyReview, learnReview, hindiReview, TickDeps, OptionIdea, IntradayIdea, calibratedWinProb, extDedupPeek } from "../paper/engine";
import { computeFrequentMover } from "../movement/frequent";
import { computeTodayMover } from "../movement/todayMover";
import { computeCleanMover } from "../rating/cleanMover";
import { computeORB } from "../orb/orb";
import { buildSellStrategies } from "../options/sellStrategies";
import { startSell, stopSell, resetSell, markSell, getSellSummary, SellTickDeps } from "../paper/sellEngine";
import { computeTopPick, TOP_PICK_TFS, Tf } from "../predict/topPicks";
import { computeBullStats } from "../predict/bullRank";
import { detectCandlePattern } from "../signals/candles";
import { computeTradeMinder } from "../signals/tradeMinder";
import { saveOiSnapshot, priorDaySnapshot, latestSnapshot } from "../oi/snapshotStore";
import { recordOiBaseline, computeOiChange, oiBaselineStrike } from "../oi/oiChange";
import { recommendOiTrades, correlateOiModels, buildOiWalls, buildOiLesson } from "../oi/oiTrade";
import { buildMoveBulletin } from "../oi/bulletin";
import { tickPaperAlerts, sendAlertsTest, alertsStatus } from "../alerts/paperPing";
import { loadDhanConfig, saveDhanConfig, dhanConfigured, testDhanConnection, disconnectDhan } from "../data/dhanConfig";
import { saveTelegramConfig, disconnectTelegram, createInviteLink } from "../integrations/telegramProvider";
import { notificationStatusLive } from "../integrations/notificationService";
import { recordConnectionTest, recordConnectionSuccess, getConnectionStatus } from "../data/connectionStatusTracker";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { fetchDhanCandles, DhanBacktestInterval } from "../data/dhanHistorical";
import { BacktestMode, DEFAULT_BACKTEST_MODE, FullMasterUnavailableError } from "../backtest/backtestMode";
import { recordLiveSnapshot } from "../data/liveSnapshotRecorder";
import { validateDay } from "../data/dataQualityValidator";
import { MODEL_TRAINING_ENABLED } from "../ml/aiConfig";
import { historicalOptionChainProvider } from "../backtest/historicalOptionChainProvider";
import { buildMarketSnapshots } from "../backtest/dhanSnapshotBuilder";
import { runMasterSelectorBacktest } from "../backtest/masterSelectorBacktest";
import { evaluateBuyAlgo, buyContextFromCandles } from "../options/highProbAlgo";
import { logOiSignal, evaluateOiSignals, reviewOiSignals } from "../oi/oiCommandLog";
import { auditSignal } from "../compliance/signalAudit";
import { complianceMeta } from "../compliance/disclosures";
import { login as doLogin, logout as doLogout, sessionInfo, validate as validateSession, getSession, revokeUserSessions } from "../auth/session";
import {
  listUsers, createUser, editUser, setUserStatus, resetPassword, findById, effectiveStatus, userStats,
  ALL_PERMISSIONS, Permission, deleteUser,
} from "../auth/userStore";
import { readAuditLog, logAuditEvent } from "../auth/loginAudit";
import { getNotifyEmail, setNotifyEmail, rotateCredentials, maybeRotateForNewDay, getCredentials } from "../auth/credentials";
import { emailConfigured } from "../auth/mailer";
import { computeOiVolume } from "../oi/oiVolume";
import { growwChainForExpiry } from "../data/growwProvider";
import { reviewOptionTrade } from "../backtest/optionReview";
import { optionExpiries, optionStrikes, hasOptionData, findOption } from "../data/growwInstruments";
import { growwOptionCandles } from "../data/growwProvider";
import { directionNoMomentum, levelContext, srRoomOk, capTargetAndStop } from "../paper/entryRules";
import {
  computeNiftyMacroSetup, classifyGlobalMarketBias, fetchGlobalMarketReads,
  pctChangeSinceOpen, computeBasketPct, rankSectors, NIFTY_IT_MAJORS, NIFTY_SECTOR_PROXIES,
} from "../paper/ext/macroSetup";
import { ExtInputs, scoreExtension, buildRiskComment, logDecision, getDecisionLog, reconcileOiState, clearDecisionLog, computeTradeScore, arbitrate, ArbiterCandidate, checkArbiterWatchdog, computeMarketRegime, MarketRegime } from "../paper/ext";
import * as centralLog from "../log/centralLog";
import { runRetentionSweep } from "../log/retentionSweep";
import { initNarrationAgent } from "../agent/narrationAgent";
// Register the narration agent's centralLog subscriber at module load (read-only,
// event-driven; produces plain-language guidance into the 'agent-narration' channel).
initNarrationAgent();
import { backtestMorning } from "../backtest/morningBacktest";
import { systemCallForDate, dayMoveMetrics } from "../backtest/dayReplay";
import { computeMoveTiming } from "../backtest/moveTiming";
import { backtestHourly } from "../backtest/hourlyBacktest";
import { computeDaySr } from "../backtest/daySr";
import { computeDirection4L } from "../signals/direction4L";
import { emaConfluenceDirection } from "../signals/emaConfluence";
import { backtestDirection4L } from "../backtest/direction4LBacktest";
import { simulateOiOptionTrade, backtestOiCommandLog } from "../backtest/oiCommand";
import { buildIndexOutlook, buildDayOpportunity } from "../predict/dayOutlook";
import { HourlyPick } from "../types";
import { appendHourlyPicks, readHourlyPicks, writeResolvedPicks, picksFilePath, masterFilePath, istDateStr, istSlot } from "../hourly/store";
import { getFundamentals } from "../fundamentals/fundamentals";
import { validateGrowwToken, classifyGrowwError } from "../data/growwAuth";
import { buildLabState, runScenarios, scenarioCatalogue, readRun as readQaRun } from "../qa/masterStrategyLab";
import { buildSuggestionRecord as buildAdvisoryRecord } from "../advisory/suggestionBuilder";
import { recordAdvisorySuggestion } from "../advisory/recorder";
import { readSuggestions, rewriteSuggestions, WINDOWS_MIN } from "../advisory/suggestionLog";
import { resolveRecord } from "../advisory/outcomeResolver";
import { buildAccuracyReport } from "../advisory/accuracy";
import { LIQUIDITY_CONFIG, NOT_DEFINED } from "../liquidity/liquidityConfig";
import { buildLiquidityLevels, nearestLevel } from "../liquidity/liquidityLevels";
import { detectLiquidity, atr14Of, entryAfterSweepConcept } from "../liquidity/sweepDetector";
import {
  logLiquidityEventOnce, readLiquidityEvents, buildConfirmations,
  oiStateFrom, vwapStateFrom, VIX_UNAVAILABLE,
} from "../liquidity/liquidityAudit";
import { writeBaseline as writeStrategyBaseline, checkStrategyIntegrity } from "../qa/strategyIntegrity";
import { getMarketNews } from "../news/news";
import fs from "fs";
import path from "path";
import {
  ema,
  vwap,
  bollinger,
  supertrend,
  rsi,
  macd,
  atr,
  adx,
  last,
} from "../indicators";
import { buildMarketCommentary, detectStructure, formatTradeReview } from "../commentary/marketCommentary";
import { CONFIG, DEFAULT_SYMBOLS, DISCLAIMER, SymbolDef, nearestStrike, SWING_SYMBOLS, findSymbolDef, ALL_SYMBOLS } from "../config";
import { istDateOfSec } from "../util/istTime";
import { getOptionTopPickAuditLog } from "../optionTopPick/auditLog";
import { scanOptionTopPick, evaluateStockBothTracks } from "../optionTopPick/scanner";
import { OptionTopPickDeps } from "../optionTopPick/types";
import { evaluateLiquidityStatus } from "../liquidityStatus/engine";
import { scanLiquidityStatus } from "../liquidityStatus/scanner";
import { getLiquidityStatusAuditLog } from "../liquidityStatus/auditLog";
import { LiquidityStatusDeps } from "../liquidityStatus/types";
import { dayHighLow } from "../indicators/dayRange";
import { Interval, NextDayPick, Opportunity, TradeAlert, OiAnalysis } from "../types";

const router = Router();

// ---- Access gate: require a valid session on every route except the login
// flow itself. A login UI existed on the frontend (backend/auth/session.ts)
// but nothing server-side ever checked it, so the entire trading/paper/OI API
// was reachable with zero authentication regardless of what the dashboard
// showed. This is a single-user local gate (see auth/session.ts), not
// multi-tenant auth.
const PUBLIC_API_PATHS = new Set(["/login", "/session", "/logout"]);
function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : undefined;
}
router.use((req: Request, res: Response, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (validateSession(bearerToken(req))) return next();
  res.status(401).json({ error: "Unauthorized. Please log in." });
});

// ---- Admin/permission gates (backend enforcement — never trust the frontend
// to hide a button and call that "authorization"). requireAdmin rejects
// anyone whose session role isn't "admin" with a real 403, even if they type
// an /api/admin/* URL directly. requirePermission(x) lets admin through
// unconditionally (implicit full access) and checks a user's stored
// permissions[] otherwise. ----
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const sess = getSession(bearerToken(req));
  if (!sess || sess.role !== "admin") {
    logAuditEvent({
      type: "ADMIN_ACCESS_DENIED", userId: sess?.userId ?? null, username: sess?.username ?? null,
      mode: sess?.role ?? null, detail: `denied ${req.method} ${req.path}`, result: "failure",
    });
    return res.status(403).json({ error: "ADMIN_ACCESS_REQUIRED" });
  }
  next();
}
export function requirePermission(perm: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const sess = getSession(bearerToken(req));
    if (!sess) return res.status(401).json({ error: "Unauthorized. Please log in." });
    if (sess.role === "admin") return next();
    if (!sess.permissions.includes(perm)) {
      return res.status(403).json({ error: `Access denied — this feature requires the "${perm}" permission. Contact your administrator.` });
    }
    next();
  };
}

// ---- Short-TTL in-memory cache to speed up (and de-duplicate) repeated scans ----
// The day-outlook and hourly scans hit overlapping symbols and run back-to-back;
// caching candles / daily / OI avoids re-fetching the same data every time.
const _cache = new Map<string, { ts: number; v: any }>();
// Last successful value per key, kept beyond the TTL. When the provider throws
// (Groww 429 rate-limit, transient network error) we serve this instead of
// letting the error bubble up and silently DROP the symbol from a scan. Without
// this, a single 429 on NIFTY's candle fetch was enough to make the paper engine
// skip NIFTY entirely for that tick (the "NIFTY opportunity missed" bug).
const _lastGood = new Map<string, { ts: number; v: any }>();
const LAST_GOOD_MAX_MS = 30 * 60_000; // serve stale-but-usable data up to 30 min on provider errors
// In-flight coalescing: if several callers ask for the SAME key before the first
// fetch resolves (tick + banner + scheduler hitting one symbol at once), they all
// share the single pending fetch instead of each firing one - a big 429 reducer.
const _inflight = new Map<string, Promise<any>>();
// Swing top-picks cache. Cached long (10 min) when it finds setups, but only
// briefly (90s) when empty - so a rate-limited/empty scan retries soon instead
// of being stuck showing "no swing" for 10 minutes.
let _swingTop: { ts: number; v: any[] } | null = null;
const isEmpty = (v: any) => v == null || (Array.isArray(v) && v.length === 0);
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.v as T;
  const flying = _inflight.get(key);
  if (flying) return flying as Promise<T>; // coalesce concurrent callers into one fetch
  const p = (async () => {
    try {
      const v = await withTimeout(fn(), 18_000, key);
      _cache.set(key, { ts: Date.now(), v });
      if (!isEmpty(v)) _lastGood.set(key, { ts: Date.now(), v });
      return v;
    } catch (e) {
      const lg = _lastGood.get(key);
      if (lg && Date.now() - lg.ts < LAST_GOOD_MAX_MS) return lg.v; // resilience: stale beats dropped
      throw e;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p as Promise<T>;
}
// Phase 3.3 (stale-data parity with the OI path): age since `key` was last
// FETCHED LIVE and succeeded — _cache's timestamp only advances on a successful
// fn() call (see `cached` above), so during a provider outage being served from
// _lastGood this keeps growing, unlike a candle's own bar timestamp which only
// reflects normal bar-close lag. null when nothing has ever been fetched for `key`.
function cacheAgeMs(key: string): number | null {
  const hit = _cache.get(key);
  return hit ? Date.now() - hit.ts : null;
}
// Relative volume "right now": average of the last 3 bars vs the average bar over
// the window. >1 = above-normal participation (move has conviction), <1 = quiet
// (higher false-move risk). Returns null when there's no volume feed (indices).
function relVolNow(candles: any[]): number | null {
  if (!candles || candles.length < 8) return null;
  const vols = candles.map((c) => Number(c.volume) || 0);
  const base = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (base <= 0) return null; // indices have no volume
  const tail = vols.slice(-3);
  const recent = tail.reduce((a, b) => a + b, 0) / tail.length;
  return Math.round((recent / base) * 100) / 100;
}
// Cache TTLs: intraday candles refresh fast; daily bars barely change intraday; OI ~1 min.
const TTL_INTRADAY = 30_000;
const TTL_DAILY = 10 * 60_000;
const TTL_OI = 90_000; // option chain: 90s (was 60s) - eases Groww rate-limit pressure
const getCandlesCached = (symbol: string, interval: Interval) =>
  cached(`c:${symbol}:${interval}`, interval === "1d" ? TTL_DAILY : TTL_INTRADAY, () => fetchCandles(symbol, interval));
const getDailyCached = (symbol: string, days = 40) =>
  cached(`d:${symbol}:${days}`, TTL_DAILY, () => getProvider().getCandles(symbol, "1d", days));
// Clean-move rating per symbol (cached 10 min) - how cleanly it trends, used to
// prefer clean directional movers for option trades (paper + best-trade).
const getCleanRatingCached = (symbol: string, name: string) =>
  cached(`clean:${symbol}`, 10 * 60_000, async () => {
    const daily = await getDailyCached(symbol, 160);
    return computeCleanMover(symbol, name, daily);
  });
// LIVE OPTION POLICY: option decisions (OI, greeks, strikes) use ONLY the Groww
// feed. When Groww is not the active provider we return an explicit "unavailable"
// analysis instead of falling back to NSE-public / Yahoo data - so no option
// trade is ever taken on non-Groww data in a live scenario.
function oiRequiresGroww(def: SymbolDef): OiAnalysis {
  return {
    symbol: def.symbol,
    nseSymbol: def.nseSymbol || def.symbol,
    available: false,
    message: "Options use live Groww data only. Connect the Groww feed for OI, greeks and option trades.",
    underlying: null,
    expiry: null,
    pcr: null,
    pcrState: "neutral",
    totalCeOi: 0,
    totalPeOi: 0,
    support: null,
    resistance: null,
    maxPain: null,
    ceBuildup: "mixed",
    peBuildup: "mixed",
    verdict: { bias: "Neutral", reasons: ["Groww feed required for live option data."] },
    topStrikes: [],
    asOf: Math.floor(Date.now() / 1000),
    disclaimer: "Live option data (OI / greeks / strikes) is sourced exclusively from Groww.",
  };
}
async function liveOptionOi(def: SymbolDef): Promise<OiAnalysis> {
  const feed = syncSessionProvider();
  const gp = growwProviderForOi();
  if (gp && isMarketOpenIST()) {
    const oi = await withTimeout(growwOiAnalysis(gp, def), 15_000, `groww OI ${def.symbol}`);
    try { recordOiBaseline(def.symbol, oi); } catch { /* best-effort */ }
    try { saveOiSnapshot(def.symbol, oi); } catch { /* best-effort */ }
    try { if (oi && oi.available) saveLastOiJson(def.symbol, oi); } catch { /* best-effort */ }
    return oi;
  }
  const disk = loadLastOiJson(def.symbol);
  if (disk && disk.available) return { ...disk, message: disk.message || "After hours: last saved Groww OI" };
  return {
    ...oiRequiresGroww(def),
    message: feed.growwOn
      ? (isMarketOpenIST()
        ? "Groww OI not ready (token/timeout) — retrying."
        : "Market closed. No saved Groww OI yet — Excel fills 09:15–15:30 IST.")
      : "Groww OFF / not configured — no live option chain. Connect Groww for OI.",
  };
}
// An OI chain is only USEFUL if at least one near-money strike carries a live
// premium. Under Groww rate-limiting the chain sometimes returns with OI but NO
// premiums (ceLtp/peLtp null) - a degraded response that still isn't an "error",
// so the generic cache would happily store it and block every option/scalp build.
const oiHasPremiums = (oi: any): boolean =>
  !!(oi && oi.available && Array.isArray(oi.topStrikes) &&
     oi.topStrikes.some((s: any) => (s.ceLtp != null && s.ceLtp > 0) || (s.peLtp != null && s.peLtp > 0)));
// Last option chain that actually had premiums (kept beyond TTL for resilience).
const _lastGoodOi = new Map<string, { ts: number; v: OiAnalysis }>();
const OI_LASTGOOD_MS = 5 * 60_000; // serve a recent premium-bearing chain when the fresh one is degraded
// Bespoke OI cache: prefer fresh chains WITH premiums; otherwise fall back to the
// most recent premium-bearing chain (up to 5 min) instead of a degraded/empty one.
function oiRefreshMeta(symbol: string, extra?: Record<string, any>) {
  const feed = syncSessionProvider();
  const age = (k: string) => {
    const h = _cache.get(k);
    return h ? Date.now() - h.ts : null;
  };
  return {
    provider: feed.provider,
    marketOpen: feed.marketOpen,
    reason: feed.reason,
    at: Math.floor(Date.now() / 1000),
    atIst: new Date(Date.now() + 19800000).toISOString().slice(11, 19) + " IST",
    oiAgeMs: age(`oi:${symbol}`),
    c5AgeMs: age(`c:${symbol}:5m`),
    c15AgeMs: age(`c:${symbol}:15m`),
    c1hAgeMs: age(`c:${symbol}:60m`),
    ...(extra || {}),
  };
}

function oiBarIstDate(c: any): string | null {
  if (!c || c.time == null) return null;
  return new Date(c.time * 1000 + 19800000).toISOString().slice(0, 10);
}

function oiQuality(p: {
  marketOpen: boolean; provider: string; oiSource: string;
  hasPremiums: boolean; hasBaseline: boolean; stale: boolean;
  excelRows: number; bars: number; lastBarDate: string | null;
}) {
  let score = 15;
  const notes: string[] = [];
  if (p.bars >= 30) score += 18; else notes.push("few candles");
  if (p.oiSource === "groww") { score += 32; notes.push("live Groww OI"); }
  else if (p.oiSource === "file") { score += 18; notes.push("saved chain"); }
  else if (p.oiSource === "snapshot") { score += 10; notes.push("last session PCR/walls"); }
  else notes.push("no OI chain");
  if (p.hasPremiums) score += 10;
  if (p.hasBaseline) score += 8;
  if (!p.stale) score += 8; else notes.push("stale");
  if (p.excelRows > 0) score += 5;
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  if (p.lastBarDate && p.lastBarDate !== today) { score -= 8; notes.push("bars " + p.lastBarDate); }
  if (!p.marketOpen) score = Math.min(score, 70);
  score = Math.max(18, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? "HIGH" : score >= 60 ? "MED" : "LOW";
  return { score, grade, notes: notes.slice(0, 4).join(" · ") };
}

const getOiCached = async (def: SymbolDef): Promise<OiAnalysis> => {
  const key = `oi:${def.symbol}`;
  if (!isMarketOpenIST()) {
    const disk = loadLastOiJson(def.symbol);
    if (disk && disk.available) return disk;
    const lg = _lastGoodOi.get(key);
    if (lg) return lg.v;
  }
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_OI && oiHasPremiums(hit.v)) return hit.v as OiAnalysis;
  const flying = _inflight.get(key);
  if (flying) return flying as Promise<OiAnalysis>; // coalesce concurrent OI callers
  const p = (async (): Promise<OiAnalysis> => {
    try {
      const oi = await liveOptionOi(def);
      if (oiHasPremiums(oi)) {
        _cache.set(key, { ts: Date.now(), v: oi });
        _lastGoodOi.set(key, { ts: Date.now(), v: oi });
        return oi;
      }
      const lg = _lastGoodOi.get(key); // degraded (no premiums) -> use recent good chain
      const lgOk = lg && (isMarketOpenIST() ? Date.now() - lg.ts < OI_LASTGOOD_MS : true);
      if (lg && lgOk) return lg.v;
      _cache.set(key, { ts: Date.now(), v: oi });
      return oi;
    } catch (e) {
      const lg = _lastGoodOi.get(key);
      if (lg && Date.now() - lg.ts < OI_LASTGOOD_MS) return lg.v;
      throw e;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
};

const VALID_INTERVALS: Interval[] = ["1m", "5m", "15m", "30m", "60m", "1d"];

function parseInterval(q: unknown): Interval {
  const v = String(q || CONFIG.defaultInterval) as Interval;
  return VALID_INTERVALS.includes(v) ? v : CONFIG.defaultInterval;
}

function daysFor(interval: Interval): number {
  return CONFIG.historyDaysByInterval[interval] ?? 30;
}

async function fetchCandles(symbol: string, interval: Interval) {
  const feed = syncSessionProvider();
  if (feed.skipLive) throw new Error("Groww feed off / not configured — using last cache");
  const provider = getProvider(); // always Groww
  const t0 = Date.now();
  try {
    const c = await withTimeout(provider.getCandles(symbol, interval, daysFor(interval)), 15_000, `candles ${symbol} ${interval}`);
    recordGrowwOk(Date.now() - t0);
    return c;
  } catch (e) {
    recordGrowwFail();
    throw e;
  }
}

// Live-feed freshness: provider + last tick time of a reference symbol + refresh cadence.
router.get("/data-status", async (_req: Request, res: Response) => {
  const feed = syncSessionProvider();
  const provider = getProvider();
  let lastTick: number | null = null;
  let refPrice: number | null = null;
  let refSymbol = "RELIANCE.NS";
  try {
    const q = await getProvider().getQuote(refSymbol);
    refPrice = q?.price ?? null;
    lastTick = q?.marketTime ?? null; // epoch seconds of the last trade
  } catch {
    /* ignore */
  }
  // Market regime: the ONE MarketRegimeEngine (fractal + ATR, Phase 1.1) — was
  // previously an independent NIFTY-only ADX calculation here. `state` is
  // translated to this panel's pre-existing vocabulary (Trending / Range-bound /
  // Weak trend) so the dashboard copy is unchanged, but the underlying VALUE is
  // now the exact same read the paper engine's entry/exit gates use for NIFTY —
  // this panel can no longer show "fine to trade" while the engine sees Compressed.
  let regime: any = null;
  let canonicalRegime: MarketRegime | null = null;
  try {
    const rg = await getMarketRegimeForSymbol("^NSEI");
    if (rg) {
      canonicalRegime = rg.regime;
      const state = rg.regime === "Trending" ? "Trending" : rg.regime === "Compressed" ? "Range-bound" : "Weak trend";
      regime = { state, dir: rg.dir > 0 ? "up" : rg.dir < 0 ? "down" : "flat", adx: rg.adx };
    }
  } catch {
    /* ignore */
  }
  // TRADE-ZONE verdict: combine regime (trend strength) with index conviction
  // (NIFTY + BANK NIFTY 15m signal scores) to tell the user, honestly, whether
  // this is a no-trade zone. Low ADX or weak/divergent index signals => NO-TRADE.
  let tradeZone: any = null;
  try {
    if (!isTradingTimeIST()) {
      tradeZone = { zone: "CLOSED", reason: "Market is closed - no live trade decisions.", conviction: 0 };
    } else {
      const [nifty, bank] = await Promise.all([
        getCandlesCached("^NSEI", "15m"),
        getCandlesCached("^NSEBANK", "15m"),
      ]);
      const nSig = nifty && nifty.length >= 30 ? computeSignal("^NSEI", nifty) : null;
      const bSig = bank && bank.length >= 30 ? computeSignal("^NSEBANK", bank) : null;
      const nScore = nSig?.score ?? 0;
      const bScore = bSig?.score ?? 0;
      const conviction = Math.round((Math.abs(nScore) + Math.abs(bScore)) / 2);
      const adxV = regime?.adx ?? 0;
      const rangeBound = canonicalRegime === "Compressed";
      const weak = canonicalRegime === "Transitioning";
      // Aligned = both indices lean the same way (both >0 or both <0) with force.
      const aligned = Math.sign(nScore) === Math.sign(bScore) && Math.sign(nScore) !== 0;
      let zone: string;
      let reason: string;
      if (rangeBound || conviction < 15) {
        zone = "NO-TRADE";
        reason = rangeBound
          ? `Range-bound/Compressed (NIFTY ADX ${adxV}) with weak index conviction (${conviction}/100). Bought options bleed theta - stay out; wait for a breakout.`
          : `Index conviction is weak (${conviction}/100, NIFTY ${nScore>0?"+":""}${nScore} / BANKNIFTY ${bScore>0?"+":""}${bScore}). No clear edge - mostly a no-trade zone.`;
      } else if (canonicalRegime === "Trending" && aligned && conviction >= 30) {
        zone = "TRADE-ON";
        reason = `Trending (ADX ${adxV}) and both indices aligned ${nScore>0?"bullish":"bearish"} (conviction ${conviction}/100). Directional option buys favoured.`;
      } else {
        zone = "SELECTIVE";
        reason = `${regime?.state ?? "Weak"} market (ADX ${adxV}), conviction ${conviction}/100${aligned?"":", indices divergent"}. Trade only A+ setups; skip marginal ones.`;
      }
      tradeZone = { zone, reason, conviction, niftyScore: nScore, bankScore: bScore, aligned };
    }
  } catch {
    /* ignore */
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const gStatus = computeGrowwStatus();
  const health = gStatus.health;
  const growwStatus = gStatus.status;
  const signalsBlocked = gStatus.signalsBlocked;
  const signalsBlockedReason = gStatus.reason;
  res.json({
    provider: provider.name, // always "groww"
    dataSource: "GROWW",
    signalsBlocked,
    signalsBlockedReason,
    live: provider.name === "groww" && feed.marketOpen && feed.growwOn,
    marketOpen: isTradingTimeIST(),
    regime,
    tradeZone,
    serverTime: nowSec,
    refSymbol,
    refPrice,
    lastTick,
    lastTickAgeSec: lastTick ? Math.max(0, nowSec - lastTick) : null,
    // How often each layer refreshes (seconds), so the UI can show the cadence.
    cadence: {
      quotesSec: 20,
      oiSec: 90,
      dailySec: 600,
      alertsSec: 1800,
      hourlySec: 3600,
      paperTickSec: 300,
      bulletinSec: 15,
    },
    feedMode: feed.reason,
    growwOn: feed.growwOn,
    growwStatus,
    configured: feed.configured,
    skipLive: feed.skipLive,
    hasGrowwToken: hasGrowwToken(),
    // Groww connection / data-health telemetry (§5–7).
    growwHealth: {
      status: growwStatus,
      dataAgeSec: health.dataAgeSec,
      lastDataTs: health.lastDataTs || null,
      latencyMs: health.lastLatencyMs || null,
      updates: health.updates,
      failures: health.failures,
      reconnects: health.reconnects,
    },
    refreshAt: nowSec,
    refreshIst: new Date(nowSec * 1000 + 19800000).toISOString().slice(11, 19) + " IST",
  });
});

// Current data-source connection status.
router.get("/connection", requireAdmin, (_req: Request, res: Response) => {
  const feed = syncSessionProvider();
  res.json({
    provider: getProvider().name, // always "groww"
    dataSource: "GROWW",
    growwOn: feed.growwOn,
    configured: feed.configured,
    skipLive: feed.skipLive,
    hasGrowwToken: hasGrowwToken(),
    marketOpen: feed.marketOpen,
    reason: feed.reason,
  });
});

// Groww connection config for the settings screen (desktop + mobile). Returns
// NON-SECRET status only: a masked token (never the full token), the connection
// state, and live data-health telemetry. Safe to poll.
router.get("/groww/config", requireAdmin, (_req: Request, res: Response) => {
  const g = computeGrowwStatus();
  const health = getGrowwHealth();
  const tracked = getConnectionStatus("groww");
  res.json({
    dataSource: "GROWW",
    configured: hasGrowwToken(),
    tokenMasked: getGrowwTokenMasked(),
    status: g.status,                 // GREEN / YELLOW / RED / GREY / CLOSED
    growwOn: g.growwOn,
    marketOpen: g.marketOpen,
    reason: g.reason,
    signalsBlocked: g.signalsBlocked,
    // Headline fields for the shared connection-status component. Derived from
    // the last real probe - never from "a token string exists".
    connection: g.status === "GREEN" || g.status === "YELLOW" || g.status === "CLOSED" ? "CONNECTED"
      : g.status === "GREY" ? "DISCONNECTED" : "ERROR",
    authentication: !hasGrowwToken() ? "NONE" : tracked.lastTestOk === false ? "INVALID" : tracked.lastTestOk ? "VALID" : "UNKNOWN",
    dataStatus: g.status === "GREEN" ? "RECEIVING" : g.status === "YELLOW" ? "DELAYED" : g.status === "CLOSED" ? "MARKET CLOSED" : "NOT RECEIVING",
    lastSuccessfulCheck: tracked.lastConnectedAt || null,
    health: {
      lastUpdate: health.lastDataTs ? new Date(health.lastDataTs + 19800000).toISOString().slice(11, 19) : null,
      lastDataTs: health.lastDataTs || null,
      dataAgeSec: health.dataAgeSec,
      latencyMs: health.lastLatencyMs || null,
      updates: health.updates,
      failures: health.failures,
      reconnects: health.reconnects,
    },
  });
});

// TEST GROWW CONNECTION — makes a real authenticated Groww request and only
// reports connected when actual market data comes back. A non-empty token field
// is never sufficient. Returns a credential-free summary the UI renders
// directly: Connection / Authentication / Data Status / Last Successful Check.
router.get("/groww/test", requireAdmin, async (req: Request, res: Response) => {
  const checks = { auth: false, api: false, data: false, optionChain: false, freshness: false };
  const messages: Record<string, string> = {};
  const admin = getSession(bearerToken(req));

  // No token at all — nothing to authenticate with.
  if (!hasGrowwToken()) {
    messages.auth = "No access token saved. Paste a Groww access token and save it.";
    recordConnectionTest("groww", false);
    logAuditEvent({ type: "GROWW_CONNECTION_TEST", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "groww", result: "failure", detail: "no token configured" });
    return res.json({
      ok: false, dataSource: "GROWW", code: "NO_TOKEN", checks, messages,
      connection: "DISCONNECTED", authentication: "NONE", dataStatus: "NOT RECEIVING",
      tokenMasked: "", lastSuccessfulCheck: getConnectionStatus("groww").lastConnectedAt || null,
      error: messages.auth,
    });
  }

  // Real authenticated request against Groww.
  const v = await validateGrowwToken();
  checks.auth = v.ok || (v.code !== "INVALID_TOKEN" && v.code !== "AUTH_FAILED");
  checks.api = v.ok || v.code === "UNEXPECTED_RESPONSE" || v.code === "INVALID_TOKEN" || v.code === "AUTH_FAILED";
  checks.data = v.ok;
  messages.auth = checks.auth ? "Token accepted by Groww." : v.message;
  messages.api = checks.api ? `Groww API reachable (${v.latencyMs} ms).` : v.message;
  messages.data = v.ok ? v.message : v.message;

  if (v.ok) { recordGrowwOk(v.latencyMs); recordConnectionSuccess("groww"); }
  else recordGrowwFail();

  // OPTION-CHAIN PROBE (pre-market validation). The quote check above proves the
  // token authenticates; this proves the OI/option-chain path the trading screens
  // actually depend on is reachable too. Read-only: it calls the existing chain
  // reader and inspects nothing but the row count. No OI analysis, no scoring,
  // no calculation is performed or altered here.
  if (v.ok) {
    try {
      const chainDef = findSymbolDef("^NSEI") || DEFAULT_SYMBOLS.find((d) => d.type === "index");
      const prov = growwProviderForOi();
      if (!chainDef || !prov) {
        messages.optionChain = "Skipped — no index symbol or Groww provider available.";
      } else {
        const chain: any = await withTimeout(growwChainForExpiry(prov, chainDef, 0), 12_000, "groww option-chain probe");
        const rows = Array.isArray(chain?.rows) ? chain.rows.length
          : Array.isArray(chain?.strikes) ? chain.strikes.length
          : Array.isArray(chain) ? chain.length : 0;
        checks.optionChain = rows > 0;
        messages.optionChain = rows > 0
          ? `Option chain reachable — ${rows} strikes for ${chainDef.symbol}${chain?.expiry ? ` (expiry ${chain.expiry})` : ""}.`
          : "Option chain returned no strikes.";
      }
    } catch (e: any) {
      const { message } = classifyGrowwError(e);
      messages.optionChain = `Option chain not reachable: ${message}`;
    }
  } else {
    messages.optionChain = "Not attempted — authentication failed first.";
  }

  const g = computeGrowwStatus();
  checks.freshness = g.status === "GREEN";
  messages.freshness = g.status === "GREEN" ? "Data freshness healthy (live)."
    : g.status === "CLOSED" ? "Market closed — historical only, no live signals."
    : g.status === "YELLOW" ? "Connected but data delayed/stale."
    : g.reason;

  recordConnectionTest("groww", v.ok);
  logAuditEvent({
    type: "GROWW_CONNECTION_TEST", userId: admin?.userId ?? null, username: admin?.username ?? null,
    mode: "admin", provider: "groww", result: v.ok ? "success" : "failure",
    detail: v.ok ? "authenticated, data received" : `failed (${v.code})`,
  });

  res.json({
    ok: v.ok,
    dataSource: "GROWW",
    code: v.ok ? undefined : v.code,
    checks,
    messages,
    // Headline fields for the connection-status component.
    connection: v.ok ? "CONNECTED" : "DISCONNECTED",
    authentication: v.ok ? "VALID" : (v.code === "INVALID_TOKEN" || v.code === "AUTH_FAILED" ? "INVALID" : "UNKNOWN"),
    dataStatus: v.ok ? "RECEIVING" : "NOT RECEIVING",
    optionChainStatus: checks.optionChain ? "REACHABLE" : (v.ok ? "UNAVAILABLE" : "NOT ATTEMPTED"),
    lastSuccessfulCheck: getConnectionStatus("groww").lastConnectedAt || null,
    latencyMs: v.latencyMs,
    tokenMasked: getGrowwTokenMasked(),
    status: g.status,
    signalsBlocked: g.signalsBlocked,
    error: v.ok ? undefined : v.message,
  });
});

// Toggle the single Groww market-data feed on/off (Groww is the only source).
router.post("/feed", requireAdmin, (req: Request, res: Response) => {
  const b = req.body || {};
  const next: { groww?: boolean } = {};
  if (b.groww != null) next.groww = b.groww === true || b.groww === "true" || b.groww === 1;
  if (next.groww === true && !hasGrowwToken()) {
    return res.status(400).json({
      ok: false,
      error: "Groww ON needs a token — Connect data first.",
      ...getFeedFlags(),
      hasGrowwToken: false,
    });
  }
  const feed = setFeedFlags(next);
  res.json({
    ok: true,
    provider: getProvider().name,
    dataSource: "GROWW",
    growwOn: feed.growwOn,
    configured: feed.configured,
    skipLive: feed.skipLive,
    hasGrowwToken: hasGrowwToken(),
    marketOpen: feed.marketOpen,
    reason: feed.reason,
  });
});

// Remove the saved Groww token (clears .groww_token + in-memory) and turn the
// feed off. After this the admin must paste a fresh access token.
router.post("/groww/forget-token", requireAdmin, (req: Request, res: Response) => {
  forgetGrowwToken();
  deletePersistedGrowwToken();
  setFeedFlags({ groww: false });
  const admin = getSession(bearerToken(req));
  logAuditEvent({ type: "GROWW_DISCONNECTED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "groww", result: "success" });
  return res.json({ ok: true, tokenMasked: getGrowwTokenMasked(), configured: hasGrowwToken(), message: "Saved token removed. Paste a fresh Groww access token to reconnect." });
});

// Connect Groww with an ACCESS TOKEN — the only Groww credential this app takes.
// The token is accepted only after a real authenticated Groww request succeeds
// and returns usable data; a non-empty field is never treated as "connected".
// Body: { token }
router.post("/connect", requireAdmin, async (req: Request, res: Response) => {
  const token = String(req.body?.token || "").trim();
  if (!token) {
    return res.status(400).json({ ok: false, code: "NO_TOKEN", error: "A Groww access token is required." });
  }

  // Keep the currently-working token so a bad paste doesn't kill a live feed.
  // With no previous token, a rejected one must be cleared rather than left in
  // the slot - otherwise hasGrowwToken() would report "configured" off a
  // credential Groww just refused.
  const previous = getGrowwToken();
  const restorePrevious = () => {
    if (!previous) {
      forgetGrowwToken();
      setFeedFlags({ groww: false });
      return;
    }
    try { setActiveProvider("groww", previous); rememberGrowwToken(previous); } catch { /* best-effort */ }
  };

  try {
    setActiveProvider("groww", token);
    rememberGrowwToken(token);
  } catch (e) {
    restorePrevious();
    const { code, message } = classifyGrowwError(e);
    return res.status(502).json({ ok: false, provider: "groww", code, error: message });
  }

  const v = await validateGrowwToken();
  const admin = getSession(bearerToken(req));

  if (!v.ok) {
    // Rejected: do NOT persist, and put the previously working token back.
    restorePrevious();
    recordGrowwFail();
    recordConnectionTest("groww", false);
    logAuditEvent({
      type: "GROWW_CREDENTIAL_UPDATED", userId: admin?.userId ?? null, username: admin?.username ?? null,
      mode: "admin", provider: "groww", result: "failure", detail: `token rejected (${v.code})`,
    });
    return res.status(v.code === "RATE_LIMIT" ? 429 : 502).json({
      ok: false, provider: "groww", dataSource: "GROWW",
      code: v.code, rateLimited: v.code === "RATE_LIMIT", error: v.message,
    });
  }

  // Validated: now it is safe to turn the feed on and persist for restarts.
  setFeedFlags({ groww: true });
  persistGrowwToken(token);
  recordGrowwReconnect();
  recordGrowwOk(v.latencyMs);
  recordConnectionSuccess("groww");
  recordConnectionTest("groww", true);
  logAuditEvent({
    type: "GROWW_CREDENTIAL_UPDATED", userId: admin?.userId ?? null, username: admin?.username ?? null,
    mode: "admin", provider: "groww", result: "success", detail: "access token saved and validated",
  });
  // SECURITY: never return the token itself — masked form only.
  return res.json({
    ok: true, provider: "groww", dataSource: "GROWW",
    tokenSaved: true, tokenMasked: getGrowwTokenMasked(),
    dataReceived: true, latencyMs: v.latencyMs,
    message: `${v.message} Token stored securely server-side (persists across restarts).`,
  });
});

// List available symbols + meta.
router.get("/symbols", (_req: Request, res: Response) => {
  res.json({ symbols: DEFAULT_SYMBOLS, provider: getProvider().name, disclaimer: DISCLAIMER });
});

// Quote for one symbol.
router.get("/quote/:symbol", async (req: Request, res: Response) => {
  try {
    const quote = await getProvider().getQuote(req.params.symbol);
    res.json(quote);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to fetch quote" });
  }
});

// Batch LIVE quotes for many symbols (for the 1-second app-wide price refresh).
// Per-symbol cached ~1.2s so per-second polling doesn't hammer the Groww feed.
const lastGoodQuote: Record<string, any> = {}; // last non-null quote per symbol (resilience)
router.get("/quotes", async (req: Request, res: Response) => {
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
  const quotes: Record<string, any> = {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Limit concurrency to 5 Groww calls at a time (cached 3s per symbol) so the
  // live ticker never bursts the feed and rate-limits the other tabs. On a
  // transient failure, serve the LAST GOOD price so the UI never blanks/flickers.
  for (let i = 0; i < symbols.length; i += 5) {
    const chunk = symbols.slice(i, i + 5);
    await Promise.all(chunk.map(async (sym) => {
      try {
        const v = await cached(`liveq:${sym}`, 3000, async () => {
          const q = await getProvider().getQuote(sym);
          return { price: q?.price ?? null, changePercent: q?.changePercent ?? null, marketTime: q?.marketTime ?? null };
        });
        if (v && v.price != null) { lastGoodQuote[sym] = v; quotes[sym] = v; }
        else quotes[sym] = lastGoodQuote[sym] ? { ...lastGoodQuote[sym], stale: true } : v;
      } catch {
        quotes[sym] = lastGoodQuote[sym] ? { ...lastGoodQuote[sym], stale: true } : null;
      }
    }));
    if (i + 5 < symbols.length) await sleep(40);
  }
  res.json({ ts: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), quotes });
});

// OPENING PLAY (9:20 AM): compare TODAY's early OI to the PRIOR session's OI
// (where fresh positions are being built), combine with the opening gap + move,
// and surface the best index option play. Snapshots build over time; the prior
// day is available once the system has run on a previous session.
router.get("/opening-play", async (_req: Request, res: Response) => {
  const today = istDateStr();
  const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  const picks: any[] = [];
  for (const def of defs) {
    try {
      const [oi, candles, daily] = await Promise.all([
        getOiCached(def) as Promise<OiAnalysis>,
        getCandlesCached(def.symbol, "15m"),
        getDailyCached(def.symbol, 40),
      ]);
      if (!oi || !oi.available || !candles || candles.length < 30) continue;
      const signal = computeSignal(def.symbol, candles);
      const atrDaily = last(atr(daily, 14));
      const opp: any = buildDayOpportunity(def, signal, oi, atrDaily, { benchmarks: [], stockDaily: daily || [], candles });
      if (!opp) continue;

      // Overnight OI shift vs the prior session.
      const prior = priorDaySnapshot(def.symbol, today);
      const pcrNow = oi.pcr;
      const pcrPrev = prior?.pcr ?? null;
      const pcrChange = pcrPrev != null && pcrNow != null ? Math.round((pcrNow - pcrPrev) * 100) / 100 : null;
      const ceOiChange = prior ? oi.totalCeOi - prior.totalCeOi : null;
      const peOiChange = prior ? oi.totalPeOi - prior.totalPeOi : null;
      let oiShiftBias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
      let oiShiftDir = 0;
      if (ceOiChange != null && peOiChange != null) {
        const diff = peOiChange - ceOiChange; // more PUT writing (bullish) vs CALL writing (bearish)
        if (diff > Math.abs(ceOiChange + peOiChange) * 0.05) { oiShiftBias = "Bullish"; oiShiftDir = 1; }
        else if (-diff > Math.abs(ceOiChange + peOiChange) * 0.05) { oiShiftBias = "Bearish"; oiShiftDir = -1; }
      }

      // Opening gap + first-move direction.
      const todayBars = candles.filter((c) => istDay(c.time) === today).sort((a, b) => a.time - b.time);
      const prevClose = daily.length >= 2 ? daily[daily.length - (istDay(daily[daily.length - 1].time) === today ? 2 : 1)].close : null;
      const todayOpen = todayBars.length ? todayBars[0].open : null;
      const gapPct = prevClose && todayOpen ? Math.round(((todayOpen - prevClose) / prevClose) * 10000) / 100 : null;
      const gapDir = gapPct == null ? 0 : gapPct > 0.1 ? 1 : gapPct < -0.1 ? -1 : 0;

      // Opening-adjusted confidence: confirm/conflict the tradeable idea with the
      // overnight OI shift + the gap.
      const oppDir = opp.direction === "Bullish" ? 1 : opp.direction === "Bearish" ? -1 : 0;
      let adj = 0;
      const reasons: string[] = [];
      if (prior) {
        if (oiShiftDir !== 0 && oiShiftDir === oppDir) { adj += 8; reasons.push(`Overnight OI confirms: ${oiShiftBias} (PE OI ${peOiChange! >= 0 ? "+" : ""}${Math.round(peOiChange!)} vs CE OI ${ceOiChange! >= 0 ? "+" : ""}${Math.round(ceOiChange!)}).`); }
        else if (oiShiftDir !== 0 && oiShiftDir === -oppDir) { adj -= 12; reasons.push(`Overnight OI CONFLICTS (${oiShiftBias}) - caution.`); }
        if (pcrChange != null) reasons.push(`PCR ${pcrPrev} -> ${pcrNow} (${pcrChange >= 0 ? "+" : ""}${pcrChange}).`);
      } else {
        reasons.push("No prior-day OI snapshot yet - overnight-shift comparison starts once the system has run a previous session.");
      }
      if (gapDir !== 0 && gapDir === oppDir) { adj += 5; reasons.push(`Gap ${gapPct}% supports the ${opp.direction} view.`); }
      else if (gapDir !== 0 && gapDir === -oppDir) { adj -= 6; reasons.push(`Gap ${gapPct}% is against the view - wait for confirmation.`); }

      const openingConfidence = Math.max(0, Math.min(99, Math.round((opp.confidence ?? 0) + adj)));

      // OPHL Option Buying System score (0-100): market structure (40%) + the
      // option's own breakout behaviour (60%), with dual-confirmation entry gate.
      const ophl = computeOphl(def, candles, daily, oi, {
        gapPct, oiShiftDir, pcrChange, todayIso: today, nowEpoch: Math.floor(Date.now() / 1000),
      });

      picks.push({
        symbol: def.symbol, name: def.name, direction: opp.direction, optionType: opp.optionType, strike: opp.strike,
        premium: opp.premium, premiumTarget: opp.premiumTarget, premiumStop: opp.premiumStop,
        spot: opp.spot, spotTarget: opp.spotTarget, spotStop: opp.spotStop,
        expectedPremiumMovePct: opp.expectedPremiumMovePct, tradeable: opp.tradeable,
        baseConfidence: opp.confidence, openingConfidence,
        gapPct, pcrNow, pcrPrev, pcrChange, ceOiChange: ceOiChange != null ? Math.round(ceOiChange) : null, peOiChange: peOiChange != null ? Math.round(peOiChange) : null,
        oiShiftBias, strikeReason: opp.strikeReason, reasons, ophl,
      });
    } catch { /* skip */ }
  }
  // Rank by the OPHL final score (the featured method), then tradeable/opening confidence.
  picks.sort((a, b) =>
    ((b.ophl?.finalScore ?? -1) - (a.ophl?.finalScore ?? -1)) ||
    ((b.tradeable ? 1 : 0) - (a.tradeable ? 1 : 0)) ||
    (b.openingConfidence - a.openingConfidence));
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), window: "09:00-09:20 IST (act at 9:20)",
    best: picks[0] || null, picks,
    disclaimer: "OPHL Option Buying System: index PDH/PDL breakout + the ATM option's OWN breakout (dual confirmation), scored 0-100 (market 40% + option 60%). Option-breakout needs a few live premium samples to arm. Overnight OI shift needs a prior recorded session. Estimate, not a guarantee.",
  });
});

// Top 2 OPTION opportunities (CE/PE) for the app-level bar. Cached 60s.
router.get("/top-opportunities", async (_req: Request, res: Response) => {
  if (!isTradingTimeIST() && !isFeedWindowIST()) return res.json({ marketOpen: false, picks: [] });
  try {
    const picks = await cached("hourly-scan-shared", 60_000, () => runHourlyScan());
    const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
    const top = await Promise.all((picks || []).slice(0, 2).map(async (p: any) => {
      // Entry-timing: are we EARLY (move building/just started) or EXTENDED
      // (already ran - chasing risky)? So you know if it's the RIGHT time.
      let timing = "UNDERWAY", todayMovePct: number | null = null, burstState: string | null = null, timingHindi = "";
      let rvol: number | null = null;
      try {
        const c = await getCandlesCached(p.symbol, "15m");
        rvol = relVolNow(c);
        if (c && c.length > 30) {
          const burst = computeMomentumBurst(p.symbol, c);
          burstState = burst.state;
          const day = istDay(c[c.length - 1].time);
          const todays = c.filter((x) => istDay(x.time) === day);
          const open = todays.length ? todays[0].open : p.spot;
          todayMovePct = open ? Math.round(((p.spot - open) / open) * 10000) / 100 : 0;
          const favMove = p.direction === "Bullish" ? todayMovePct : -todayMovePct; // move so far in our favour
          if (burst.state === "Squeeze") { timing = "EARLY"; timingHindi = "अभी शुरुआत — मूव बन रहा है, सही समय।"; }
          else if ((burst.state === "Fired Up" || burst.state === "Fired Down") && favMove < 0.8) { timing = "EARLY"; timingHindi = "अभी-अभी ब्रेकआउट, ज़्यादा नहीं भागा — एंट्री का सही समय।"; }
          else if (favMove >= 1.2 || (burst.state.startsWith("Expanding") && favMove >= 1.0)) { timing = "EXTENDED"; timingHindi = `पहले ही ${Math.abs(todayMovePct)}% भाग चुका — पीछा मत करो, पुलबैक का इंतज़ार करो।`; }
          else timingHindi = "मूव चल रहा है — टाइट स्टॉप के साथ ही लो।";
        }
      } catch { /* timing optional */ }
      return {
        symbol: p.symbol, name: p.name, direction: p.direction, optionType: p.optionType, strike: p.strike,
        spot: p.spot, spotTarget: p.spotTarget, spotStop: p.spotStop, premium: p.premium, premiumTarget: p.premiumTarget,
        expectedPremiumMovePct: p.expectedPremiumMovePct, confidence: p.confidence, thetaPctPerDay: p.thetaPctPerDay, decayLevel: p.decayLevel,
        timing, todayMovePct, burstState, timingHindi, rvol,
      };
    }));
    // Index WATCH strip: always show every F&O index with its current direction,
    // the option play, confidence and a clear TRADE/WATCH/WAIT level + message.
    // This is the "watch bar" for NIFTY/BANKNIFTY/FINNIFTY the user asked to flash
    // for the other indices too, not just NIFTY.
    const idxDefs = DEFAULT_SYMBOLS.filter((x) => x.type === "index" && x.fno);
    const today = istDateStr();
    const dirWord = (dir: string) => (dir === "Bullish" ? "तेज़ी (Bullish)" : dir === "Bearish" ? "मंदी (Bearish)" : "न्यूट्रल");
    const arrowOf = (dir: string) => (dir === "Bullish" ? "▲" : dir === "Bearish" ? "▼" : "•");
    const TRADE_FLOOR = 68; // matches the paper engine high-prob confirmation floor
    const indices = await Promise.all(idxDefs.map(async (def) => {
      try {
        const [candles, c5, daily, oi] = await Promise.all([
          getCandlesCached(def.symbol, "15m"), getCandlesCached(def.symbol, "5m"), getDailyCached(def.symbol, 40), getOiCached(def),
        ]);
        if (!candles || candles.length < 30) return { symbol: def.symbol, name: def.name, available: false, msg: "डेटा नहीं मिला।" };
        const signal = computeSignal(def.symbol, candles);
        const atrDaily = last(atr(daily, 14));
        const att = computeAttempts(c5 || [], 40);
        const sr = computeSrLevels(candles, daily, oi as any, today, 10); // S/R (±10) + major S/R + spot + sentiment
        const o: any = buildDayOpportunity(def, signal, oi as any, atrDaily, { benchmarks: [], stockDaily: daily || [], candles });
        if (!o) {
          // No clean directional call — but if the chart is coiling with repeated
          // attempts at a level, show that "trying to break" read (human-style).
          if (att.pressure !== "none") {
            const up = att.pressure === "up";
            return { symbol: def.symbol, name: def.name, available: true, direction: up ? "Bullish" : "Bearish", arrow: up ? "▲" : "▼",
              confidence: 0, level: "WATCH", attempts: att.pressure === "up" ? att.attemptsUp : att.attemptsDown, sr,
              msg: `👀 ${up ? "ऊपर" : "नीचे"} जाने की कोशिश (${att.pressure === "up" ? att.attemptsUp : att.attemptsDown} बार) — ${att.noteHindi} स्कैल्प का मौका बन सकता है।` };
          }
          return { symbol: def.symbol, name: def.name, available: true, direction: "Neutral", arrow: "•", confidence: 0,
            level: "WAIT", sr, msg: "⏳ रुको: दिशा साफ़ नहीं — कोई साफ़ ट्रेड नहीं।" };
        }
        const conf = o.confidence ?? 0;
        const level = conf >= TRADE_FLOOR && o.tradeable ? "TRADE" : conf >= 35 ? "WATCH" : "WAIT";
        const play = `${o.strike} ${o.optionType} ~₹${Math.round(o.premium)}`;
        const attemptTag = att.pressure !== "none"
          ? ` · 🔁 ${att.pressure === "up" ? "ऊपर" : "नीचे"} ${att.pressure === "up" ? att.attemptsUp : att.attemptsDown} कोशिश`
          : "";
        const msg = (level === "TRADE"
          ? `✅ ट्रेड: ${dirWord(o.direction)} — ${play} (conf ${conf}%)`
          : level === "WATCH"
          ? `👀 नज़र रखो: ${dirWord(o.direction)} झुकाव (conf ${conf}%) — पुष्टि का इंतज़ार।`
          : `⏳ रुको: ${dirWord(o.direction)} पर कमज़ोर (conf ${conf}%) — अभी ट्रेड नहीं।`) + attemptTag;
        return {
          symbol: def.symbol, name: def.name, available: true, direction: o.direction, arrow: arrowOf(o.direction),
          optionType: o.optionType, strike: o.strike, confidence: conf, level, tradeable: level === "TRADE",
          spot: o.spot, spotTarget: o.spotTarget, spotStop: o.spotStop, premium: o.premium, premiumTarget: o.premiumTarget,
          expectedPremiumMovePct: o.expectedPremiumMovePct, dte: o.dte, msg, rvol: relVolNow(candles), sr,
          attempts: att.pressure !== "none" ? (att.pressure === "up" ? att.attemptsUp : att.attemptsDown) : 0,
        };
      } catch { return { symbol: def.symbol, name: def.name, available: false, msg: "डेटा नहीं मिला (रेट-लिमिट)।" }; }
    }));
    // SWING strip: top early-stage multi-day equity setups (daily data, slow-moving
    // -> cached 10 min so it's cheap and rate-limit-safe). Long-bias by nature.
    let swing: any[] = [];
    try {
      const swingFresh = _swingTop && Date.now() - _swingTop.ts < (_swingTop.v.length ? 10 * 60_000 : 90_000);
      let swingPicks: any[];
      if (swingFresh) {
        swingPicks = _swingTop!.v;
      } else {
        const uni = SWING_SYMBOLS.filter((d) => d.type === "equity");
        const found: any[] = [];
        const BATCH = 6;
        for (let i = 0; i < uni.length; i += BATCH) {
          const chunk = uni.slice(i, i + BATCH);
          const part = await Promise.all(chunk.map(async (def) => {
            try {
              const daily = await getDailyCached(def.symbol, 500);
              const sp = computeSwing(def.symbol, def.name, daily);
              return sp && (sp.stage === "Early breakout" || sp.stage === "Building base") ? sp : null;
            } catch { return null; }
          }));
          found.push(...part.filter(Boolean));
          if (i + BATCH < uni.length) await new Promise((r) => setTimeout(r, 150));
        }
        swingPicks = found.sort((a: any, b: any) => b.earlyScore - a.earlyScore).slice(0, 3);
        _swingTop = { ts: Date.now(), v: swingPicks };
      }
      swing = (swingPicks || []).map((s: any) => {
        const early = s.stage === "Early breakout";
        const level = early ? "ENTER" : "WATCH";
        const movePct = Math.round((s.expectedMovePct ?? 0) * 100) / 100;
        const msg = early
          ? `🚀 ब्रेकआउट: ₹${Math.round(s.entry)} के ऊपर, टारगेट ₹${Math.round(s.target)} (~+${movePct}%)।`
          : `🔧 बेस बन रहा: ₹${Math.round(s.entry)} पर नज़र, टारगेट ₹${Math.round(s.target)} (~+${movePct}%)।`;
        return {
          symbol: s.symbol, name: s.name, direction: "Bullish", stage: s.stage, level,
          spot: s.price, spotTarget: s.target, spotStop: s.stop, entry: s.entry,
          expectedMovePct: s.expectedMovePct, riskReward: s.riskReward, earlyScore: s.earlyScore, msg,
          rvol: s.volSurge ?? null, // swing already measures volume surge vs its average
        };
      });
    } catch { swing = []; }
    res.json({ marketOpen: true, generatedAt: Math.floor(Date.now() / 1000), indices, picks: top, swing });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to build top opportunities" });
  }
});

// Candles + indicator overlays for charting.
router.get("/candles/:symbol", async (req: Request, res: Response) => {
  try {
    const interval = parseInterval(req.query.interval);
    const candles = await fetchCandles(req.params.symbol, interval);
    if (candles.length === 0) {
      return res.status(404).json({ error: "No candle data returned for this symbol/interval." });
    }
    const closes = candles.map((c) => c.close);
    const bb = bollinger(closes, 20, 2);
    // Keltner Channels: EMA20 +/- 1.5 * ATR20 (used with BB to visualise the squeeze).
    const kcMid = ema(closes, 20);
    const kcAtr = atr(candles, 20);
    const kcUpper = kcMid.map((m, i) => (m != null && kcAtr[i] != null ? m + 1.5 * (kcAtr[i] as number) : null));
    const kcLower = kcMid.map((m, i) => (m != null && kcAtr[i] != null ? m - 1.5 * (kcAtr[i] as number) : null));
    const overlays = {
      ema9: ema(closes, 9),
      ema21: ema(closes, 21),
      ema50: ema(closes, 50),
      vwap: vwap(candles),
      bbUpper: bb.upper,
      bbLower: bb.lower,
      kcUpper,
      kcLower,
      supertrend: supertrend(candles, 10, 3).map((s) => s.value),
    };
    const sub = {
      rsi: rsi(closes, 14),
      macd: macd(closes),
    };
    const scores = computeScoreSeries(candles);
    res.json({ symbol: req.params.symbol, interval, candles, overlays, sub, scores });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to fetch candles" });
  }
});

// Live signal.
router.get("/signal/:symbol", async (req: Request, res: Response) => {
  try {
    const interval = parseInterval(req.query.interval);
    const candles = await fetchCandles(req.params.symbol, interval);
    if (candles.length < 30) {
      return res.status(404).json({ error: "Not enough data to compute a signal." });
    }
    // Attach the market-condition regime (Range / Whipsaw / Good move / Lottery)
    // on THESE same candles — free (no extra Groww call) — so the watchlist can
    // show each symbol's condition on the current interval.
    res.json({ ...computeSignal(req.params.symbol, candles), regime: classifyRegime(candles), rvol: relVolNow(candles) });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to compute signal" });
  }
});

function deskTf(sig: any) {
  if (!sig) return { dir: "Neutral" as const, option: null as string | null, score: 0, label: "—" };
  const dir = sig.score >= 12 ? "Bullish" : sig.score <= -12 ? "Bearish" : "Neutral";
  return {
    dir, option: dir === "Bullish" ? "CE" : dir === "Bearish" ? "PE" : null,
    score: Math.round(sig.score), label: sig.label, conf: sig.confidence ?? 0,
  };
}

/** Right-rail NIFTY desk: 15m + 1h, immediate & major S/R, CE+PE OI buildup. Cached ~55s. */
router.get("/index-desk", requirePermission("tradingDashboard"), async (_req: Request, res: Response) => {
  try {
    const data = await cached("index-desk", 55_000, async () => {
      const today = istDateStr();
      const idxs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
      // Each index is independent (no shared state, no ordering dependency
      // between iterations) - was a sequential for-loop across 2-3 symbols.
      // Promise.all preserves idxs' input order in the resolved array
      // regardless of completion order, so row order in the response is
      // unchanged; the shared Groww throttle (growwProvider.ts) still paces
      // the actual outbound calls exactly as before - this only removes the
      // artificial extra wait of finishing one index before starting the next.
      const rowsOrNull = await Promise.all(idxs.map(async (def) => {
        try {
          const [c15, c60, daily, oi] = await Promise.all([
            getCandlesCached(def.symbol, "15m"),
            getCandlesCached(def.symbol, "60m").catch(() => []),
            getDailyCached(def.symbol, 40).catch(() => []),
            def.fno ? getOiCached(def).catch(() => null) : Promise.resolve(null),
          ]);
          if (!c15 || c15.length < 20) return null;
          const sig15 = computeSignal(def.symbol, c15);
          const sig1h = c60 && c60.length >= 30 ? computeSignal(def.symbol, c60) : null;
          const sr = computeSrLevels(c15, daily || [], oi as any, today, 10);
          if (oi) { try { recordOiBaseline(def.symbol, oi as any); } catch { /* ok */ } }
          const oc = oi ? computeOiChange(def.symbol, def.name, "index", oi as any) : null;
          const ceB = oc?.maxCeBuildup || null;
          const peB = oc?.maxPeBuildup || null;
          const ceN = ceB?.oiChg ?? 0;
          const peN = peB?.oiChg ?? 0;
          let buildHot: "CE" | "PE" | "even" | "wait" = "wait";
          let buildText = oc?.note || "OI baseline forming — first reading of the day.";
          if (ceN > 0 || peN > 0) {
            if (ceN > peN * 1.12) { buildHot = "CE"; buildText = `CE writing ↑ at ${ceB?.strike} (resist) — new call contracts adding faster.`; }
            else if (peN > ceN * 1.12) { buildHot = "PE"; buildText = `PE writing ↑ at ${peB?.strike} (support) — new put contracts adding faster.`; }
            else { buildHot = "even"; buildText = `Both sides adding — CE ${ceB?.strike || "—"} / PE ${peB?.strike || "—"}.`; }
          }
          return {
            symbol: def.symbol, name: def.name, spot: sr.spot,
            tf15: deskTf(sig15), tf1h: deskTf(sig1h),
            immSupport: sr.support, immResistance: sr.resistance,
            majorSupport: sr.majorSupport, majorResistance: sr.majorResistance,
            pcr: sr.pcr, sentiment: sr.sentiment,
            ceBuild: ceB ? { strike: ceB.strike, oiChg: ceB.oiChg, pct: ceB.oiChgPct } : null,
            peBuild: peB ? { strike: peB.strike, oiChg: peB.oiChg, pct: peB.oiChgPct } : null,
            buildHot, buildText,
            netCe: oc?.netCeChg ?? null, netPe: oc?.netPeChg ?? null,
          };
        } catch (e) { console.error(`[api] skipped ${def.symbol}:`, e instanceof Error ? e.message : e); return null; }
      }));
      const rows = rowsOrNull.filter((r): r is NonNullable<typeof r> => r != null);
      return { rows };
    });
    res.json({
      generatedAt: Math.floor(Date.now() / 1000),
      marketOpen: isTradingTimeIST(),
      refreshSec: 60,
      ...data,
    });
  } catch (e: any) {
    res.status(504).json({ error: e?.message || "index desk timed out", rows: [] });
  }
});

// Option trade suggestion: which option (CE/PE), strike, stop-loss, target, lots.
router.get("/options/:symbol", async (req: Request, res: Response) => {
  try {
    const interval = parseInterval(req.query.interval);
    const def = DEFAULT_SYMBOLS.find((s) => s.symbol === req.params.symbol) || {
      symbol: req.params.symbol,
      name: req.params.symbol,
      type: "equity" as const,
    };
    const candles = await fetchCandles(req.params.symbol, interval);
    if (candles.length < 30) {
      return res.status(404).json({ error: "Not enough data to compute an option suggestion." });
    }
    const signal = computeSignal(req.params.symbol, candles);
    const sizing = {
      capital: req.query.capital ? Number(req.query.capital) : undefined,
      riskPercent: req.query.risk ? Number(req.query.risk) : undefined,
      premium: req.query.premium ? Number(req.query.premium) : undefined,
      interval,
    };
    const risk = computeRiskRadar(candles, {
      interval,
      premium: sizing.premium,
    });
    res.json({ signal, option: suggestOptionTrade(signal, def, sizing), risk });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to build option suggestion" });
  }
});

// Live trade alerts: ranked stocks to trade now, with backtested success rate.
router.get("/alerts", async (req: Request, res: Response) => {
  const interval = parseInterval(req.query.interval);
  const results = await Promise.all(
    DEFAULT_SYMBOLS.map(async (def: SymbolDef) => {
      try {
        const candles = await fetchCandles(def.symbol, interval);
        if (candles.length < 60) return null;
        const sig = computeSignal(def.symbol, candles);
        // Only actionable, directional signals become alerts.
        if (Math.abs(sig.score) < 15) return null;

        const bt = runBacktest(def.symbol, interval, candles, {
          stopLossPercent: 0.5,
          targetPercent: 1.0,
          entryThreshold: 30,
          allowShort: true,
        });

        const bullish = sig.score > 0;
        const target = sig.suggestedTarget;
        const potentialGainPct =
          target != null && sig.price ? Math.abs((target - sig.price) / sig.price) * 100 : 0;
        // Movement = typical intraday range (ATR as % of price). Higher = more
        // premium swing for options, which is what we want to surface first.
        const atrNow = last(atr(candles, 14));
        const movementPct = atrNow != null && sig.price ? (atrNow / sig.price) * 100 : 0;
        const successRate = bt.winRate;
        // Composite: current conviction x reward x historical hit-rate.
        const rankScore = Math.round(
          (sig.confidence / 100) * potentialGainPct * (Math.max(successRate, 1) / 100) * 100
        );

        const alert: TradeAlert = {
          symbol: def.symbol,
          name: def.name,
          type: def.type,
          price: sig.price,
          label: sig.label,
          score: sig.score,
          confidence: sig.confidence,
          direction: bullish ? "bullish" : "bearish",
          optionType: def.fno ? (bullish ? "CE" : "PE") : null,
          atmStrike: def.fno ? nearestStrike(sig.price, def) : null,
          targetPrice: target,
          stopPrice: sig.suggestedStopLoss,
          potentialGainPct: Math.round(potentialGainPct * 100) / 100,
          movementPct: Math.round(movementPct * 100) / 100,
          successRate,
          tradesTested: bt.totalTrades,
          expectancyPct: bt.expectancyPercent,
          profitFactor: isFinite(bt.profitFactor) ? bt.profitFactor : 99,
          rankScore,
        };
        return alert;
      } catch {
        return null;
      }
    })
  );

  // Order by MOST MOVEMENT first (bigger intraday range = bigger option premium
  // swings); tie-break by success rate then composite rank.
  const alerts = (results.filter(Boolean) as TradeAlert[]).sort(
    (a, b) => b.movementPct - a.movementPct || b.successRate - a.successRate || b.rankScore - a.rankScore
  );
  res.json({
    interval,
    generatedAt: Math.floor(Date.now() / 1000),
    refreshIntervalSec: 1800,
    alerts,
    disclaimer:
      "Success rate is the historical backtest win rate on recent data - NOT a guarantee. " +
      "Rankings use delayed data and can change every refresh. Educational use only; trade with a stop-loss.",
  });
});

// Open Interest (OI) analysis from NSE option chain.
router.get("/oi/:symbol", async (req: Request, res: Response) => {
  try {
    const def = findSymbolDef(req.params.symbol);
    if (!def) return res.status(404).json({ error: "Unknown symbol." });
    const provider = getProvider();
    // Prefer Groww's real option-chain OI when connected; else NSE public API.
    if (provider.name === "groww") {
      res.json(await growwOiAnalysis(provider as GrowwProvider, def));
    } else {
      res.json(await getOiAnalysis(def));
    }
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to fetch OI" });
  }
});

// Final combined suggestion: technical signal + OI/PCR -> one verdict + levels.
router.get("/final/:symbol", async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol;
    const interval = parseInterval(req.query.interval);
    const def = findSymbolDef(symbol) || { symbol, name: symbol, type: "equity" as const };
    const candles = await fetchCandles(symbol, interval);
    if (candles.length < 30) return res.status(404).json({ error: "Not enough data." });
    const signal = computeSignal(symbol, candles);
    const price = signal.price;

    const provider = getProvider();
    let oi: any = null;
    if (def.fno) {
      oi = provider.name === "groww" ? await growwOiAnalysis(provider as GrowwProvider, def) : await getOiAnalysis(def);
    }

    const oiOk = oi && oi.available;
    const oiDir = oiOk ? (oi.verdict.bias === "Bullish" ? 1 : oi.verdict.bias === "Bearish" ? -1 : 0) : 0;

    // Multi-factor confirmation: require several INDEPENDENT signals to agree
    // before calling a trade. More agreement = more accurate confirmation.
    const momentum = computeMomentumBurst(symbol, candles);
    const volume = analyzeVolume(symbol, candles);
    const voteBias = (name: string) => {
      const v = signal.votes.find((x) => x.name === name);
      return v ? (v.bias === "bullish" ? 1 : v.bias === "bearish" ? -1 : 0) : 0;
    };
    const sgn = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
    // Weighted factors: trend & options positioning carry the most weight.
    const factors: { name: string; dir: number; weight: number }[] = [
      { name: "Trend (EMA + Supertrend)", dir: sgn(voteBias("EMA 9/21") + voteBias("Supertrend")), weight: 2.5 },
      { name: "Options OI / PCR", dir: oiDir, weight: 2.0 },
      {
        name: "Futures OI buildup",
        dir: oiOk
          ? oi.futBuildup === "Long buildup" || oi.futBuildup === "Short covering"
            ? 1
            : oi.futBuildup === "Short buildup" || oi.futBuildup === "Long unwinding"
            ? -1
            : 0
          : 0,
        weight: 2.0,
      },
      { name: "Momentum burst", dir: momentum.direction === "up" ? 1 : momentum.direction === "down" ? -1 : 0, weight: 1.5 },
      { name: "VWAP position", dir: voteBias("VWAP"), weight: 1.5 },
      { name: "Volume (smart money)", dir: volume.verdict.bias === "Accumulation" ? 1 : volume.verdict.bias === "Distribution" ? -1 : 0, weight: 1.5 },
      { name: "Momentum (MACD)", dir: voteBias("MACD"), weight: 1.0 },
      { name: "RSI", dir: voteBias("RSI (14)"), weight: 1.0 },
    ];
    const totalFactors = factors.length;
    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    const bullW = factors.filter((f) => f.dir > 0).reduce((s, f) => s + f.weight, 0);
    const bearW = factors.filter((f) => f.dir < 0).reduce((s, f) => s + f.weight, 0);
    const bull = factors.filter((f) => f.dir > 0).length;
    const bear = factors.filter((f) => f.dir < 0).length;
    const netDir = bullW > bearW ? 1 : bearW > bullW ? -1 : 0;
    const confirmations = Math.max(bull, bear);
    const conflicting = Math.min(bull, bear);
    const netW = Math.abs(bullW - bearW); // weighted conviction
    const side = netDir > 0 ? "CALL" : "PUT";

    let action: string;
    if (netDir === 0 || netW <= 0) action = "WAIT / NO TRADE";
    else if (netW >= 6) action = "STRONG BUY " + side;
    else if (netW >= 3.5) action = "BUY " + side;
    else action = "WEAK - WAIT (" + side + " bias)";

    // ----- Time-of-day safety block (IST) -----
    const istNow = new Date(Date.now() + 19800000);
    const istMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    const istDay = istNow.getUTCDay();
    const istToday = istNow.toISOString().slice(0, 10);
    let blockReason: string | null = null;
    if (istDay >= 1 && istDay <= 5) {
      if (istMin >= 555 && istMin < 570)
        blockReason = "First 15 minutes (9:15-9:30) - opening volatility; wait for the range to form.";
      else if (oiOk && oi.expiry === istToday && istMin >= 870)
        blockReason = "Expiry-day last hour - extreme theta/settlement risk; do not buy options now.";
    }
    if (blockReason) action = "WAIT / NO TRADE";

    // ----- Market BLUFF / TRAP detection in the option move -----
    const closesArr = candles.map((c) => c.close);
    const rsiVal = last(rsi(closesArr, 14));
    const vwapVal = last(vwap(candles));
    const bluff: string[] = [];
    if (netDir !== 0 && !blockReason) {
      const vb = volume.verdict.bias;
      if (netDir > 0 && vb === "Distribution") bluff.push("Up-bias but smart-money volume shows DISTRIBUTION - possible bull trap.");
      if (netDir < 0 && vb === "Accumulation") bluff.push("Down-bias but volume shows ACCUMULATION - possible bear trap.");
      if (netDir > 0 && oiDir < 0) bluff.push("Heavy CALL writing (PCR bearish) into an up-move - upside likely capped/trapped.");
      if (netDir < 0 && oiDir > 0) bluff.push("Heavy PUT writing (PCR bullish) into a down-move - downside likely cushioned.");
      if (oiOk && netDir > 0 && oi.futBuildup === "Short covering") bluff.push("Up-move is SHORT COVERING (futures OI falling), not fresh longs - rally may fade.");
      if (oiOk && netDir < 0 && oi.futBuildup === "Long unwinding") bluff.push("Down-move is LONG UNWINDING (futures OI falling), not fresh shorts - may bounce.");
      if (rsiVal != null && netDir > 0 && rsiVal > 72) bluff.push(`RSI ${Math.round(rsiVal)} overbought - chasing a stretched move.`);
      if (rsiVal != null && netDir < 0 && rsiVal < 28) bluff.push(`RSI ${Math.round(rsiVal)} oversold - shorting into exhaustion.`);
      if (vwapVal != null) {
        const dv = ((price - vwapVal) / vwapVal) * 100;
        if (netDir > 0 && dv > 0.6) bluff.push(`Price ${dv.toFixed(2)}% above VWAP - stretched, mean-reversion risk.`);
        if (netDir < 0 && dv < -0.6) bluff.push(`Price ${Math.abs(dv).toFixed(2)}% below VWAP - stretched, bounce risk.`);
      }
      if (oiOk && oi.maxPain && oi.expiry) {
        const dte = Math.round((Date.parse(oi.expiry) - Date.parse(istToday)) / 86400000);
        const mpDist = ((price - oi.maxPain) / price) * 100;
        if (dte <= 1 && Math.abs(mpDist) > 0.4)
          bluff.push(`Near expiry & ${mpDist.toFixed(2)}% from max-pain ${oi.maxPain} - writers may pin/pull price back.`);
      }
    }
    const bluffLevel = bluff.length >= 3 ? "High" : bluff.length === 2 ? "Medium" : bluff.length === 1 ? "Low" : "None";
    // Downgrade / block on detected bluff.
    if (bluffLevel === "High") action = "WAIT / NO TRADE";
    else if (bluffLevel === "Medium" && action.startsWith("STRONG BUY")) action = "BUY " + side + " (caution)";

    const isBuy = action.startsWith("STRONG BUY") || action.startsWith("BUY ");
    const bullish = isBuy && side === "CALL";
    const bearish = isBuy && side === "PUT";
    const optionType = bullish ? "CE" : bearish ? "PE" : null;
    let confidence = Math.max(15, Math.min(96, Math.round((netW / totalWeight) * 100) + (oiOk ? 6 : 0)));
    confidence = Math.max(15, confidence - bluff.length * 12); // each bluff flag cuts confidence
    if (blockReason) confidence = Math.min(confidence, 15);

    // Tag each factor as aligned / against / neutral relative to the chosen side.
    const checklist = factors.map((f) => ({
      name: f.name,
      weight: f.weight,
      state: netDir === 0 || f.dir === 0 ? "neutral" : f.dir === netDir ? "confirm" : "against",
    }));

    const entry = bullish ? signal.dayHigh ?? price : bearish ? signal.dayLow ?? price : price;
    const stop = bullish ? signal.dayLow : bearish ? signal.dayHigh : null;
    let target: number | null = null;
    if (oiOk) target = bullish ? oi.resistance : bearish ? oi.support : null;
    if (target == null) target = bullish ? signal.suggestedTarget : bearish ? signal.suggestedTarget : null;

    // Live option premium (buy price) for the recommended strike, from Groww's chain.
    let optionPremium: number | null = null;
    let premiumStop: number | null = null;
    let premiumTarget: number | null = null;
    let optionIv: number | null = null;
    let optionTheta: number | null = null;
    let premiumDerivation: string | null = null;
    const atmStrikeVal = def.fno ? nearestStrike(price, def) : null;
    if (oiOk && atmStrikeVal != null && (bullish || bearish)) {
      const row = (oi.topStrikes || []).reduce(
        (best: any, s: any) => (best == null || Math.abs(s.strike - atmStrikeVal) < Math.abs(best.strike - atmStrikeVal) ? s : best),
        null
      );
      if (row) {
        optionPremium = bullish ? row.ceLtp ?? null : row.peLtp ?? null;
        optionIv = bullish ? row.ceIv ?? null : row.peIv ?? null;
        optionTheta = bullish ? row.ceTheta ?? null : row.peTheta ?? null;
        const delta = Math.abs((bullish ? row.ceDelta : row.peDelta) ?? 0.5) || 0.5;
        if (optionPremium != null && stop != null) {
          const uRisk = Math.abs((entry as number) - stop); // underlying move to stop
          const uReward = target != null ? Math.abs(target - (entry as number)) : uRisk * 1.6;
          // Stop at the delta-implied level, but never risk more than ~40% of premium.
          const deltaStop = optionPremium - delta * uRisk;
          const pctFloor = optionPremium * 0.6; // = 40% max loss
          premiumStop = Math.round(Math.max(deltaStop, pctFloor) * 100) / 100;
          premiumTarget = Math.round((optionPremium + delta * uReward) * 100) / 100;
          premiumDerivation =
            `Derivation: LTP ${optionPremium} + delta ${Math.round(delta * 100) / 100} x ` +
            `${Math.round(uReward)}-pt move to target ${target} = ${premiumTarget}.`;
        }
      }
    }

    const reasons: string[] = [];
    if (blockReason) reasons.push("BLOCKED: " + blockReason);
    if (bluffLevel !== "None") reasons.push(`Bluff/trap check: ${bluffLevel} - ${bluff.join(" ")}`);
    reasons.push(
      `Confirmation: ${confirmations} of ${totalFactors} factors ${netDir >= 0 ? "bullish" : "bearish"}` +
        (conflicting ? `, ${conflicting} conflicting` : "") +
        ` (weighted conviction ${Math.round(netW * 10) / 10}/${totalWeight}) -> ${action}.`
    );
    reasons.push(`Technical signal: ${signal.label} (score ${signal.score}, conf ${signal.confidence}%)`);
    if (oiOk) reasons.push(`Option OI: ${oi.verdict.bias} - PCR ${oi.pcr}, support ${oi.support}, resistance ${oi.resistance}, max-pain ${oi.maxPain}`);
    else reasons.push("Option OI: not available for this symbol.");
    if (bullish) reasons.push(`Plan: buy CALL on break above day high ${entry}; stop below day low ${stop}; target near OI resistance ${target}.`);
    else if (bearish) reasons.push(`Plan: buy PUT on break below day low ${entry}; stop above day high ${stop}; target near OI support ${target}.`);
    else reasons.push("Technical and OI don't align - stay out until they agree.");
    if (optionPremium != null) {
      reasons.push(
        `Option to buy: ${atmStrikeVal} ${optionType} at ~${optionPremium} (LTP). ` +
          `Book/exit near ${premiumTarget}, cut at ~${premiumStop}. IV ${optionIv ?? "-"}%, theta ${optionTheta ?? "-"}/day.`
      );
      if (premiumDerivation) reasons.push(premiumDerivation);
      reasons.push(
        "Premium target/stop are delta-based estimates (premium moves = delta x spot move). " +
          "Gamma can push it higher, theta/IV crush lower - treat as a guide."
      );
    }

    res.json({
      symbol,
      name: def.name,
      price,
      action,
      confidence,
      confirmations,
      conflicting,
      totalFactors,
      checklist,
      blockReason,
      bluffLevel,
      bluff,
      entry,
      stop,
      target,
      optionType,
      atmStrike: atmStrikeVal,
      optionPremium,
      premiumStop,
      premiumTarget,
      optionIv,
      optionTheta,
      dayHigh: signal.dayHigh,
      dayLow: signal.dayLow,
      pcr: oiOk ? oi.pcr : null,
      support: oiOk ? oi.support : null,
      resistance: oiOk ? oi.resistance : null,
      maxPain: oiOk ? oi.maxPain : null,
      futOi: oiOk ? oi.futOi ?? null : null,
      futOiChangePct: oiOk ? oi.futOiChangePct ?? null : null,
      futBuildup: oiOk ? oi.futBuildup ?? null : null,
      reasons,
      disclaimer: "Combined technical + OI view. Educational, not advice - confirm on entry and use the stop.",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to build final suggestion" });
  }
});

// Next-Day Outlook: daily-timeframe trend bias for tomorrow (read ~3:10 PM IST).
router.get("/next-day", async (_req: Request, res: Response) => {
  const results = await Promise.all(
    DEFAULT_SYMBOLS.map(async (def) => {
      try {
        const daily = await getProvider().getCandles(def.symbol, "1d", 365);
        return buildNextDayPick(def, daily);
      } catch {
        return null;
      }
    })
  );
  const picks = (results.filter(Boolean) as NextDayPick[])
    .filter((p) => p.bias !== "Neutral")
    .sort((a, b) => b.outlookScore - a.outlookScore);
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks,
    disclaimer:
      "Next-day bias is a probabilistic read of the DAILY trend - not a prediction of tomorrow's gains. " +
      "Best used near the close (~3:10 PM IST) as a carry-forward watchlist. Gaps and news can flip it. Use a stop.",
  });
});

// Short-term swing scan: stocks starting a multi-day move (early vs extended).
router.get("/swing", async (_req: Request, res: Response) => {
  // Fetch in small batches with a short delay + one retry, to respect the
  // data provider's rate limits so the whole universe comes through.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fetchOne = async (def: SymbolDef) => {
    let pick: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const daily = await getProvider().getCandles(def.symbol, "1d", 160); // Groww technical
        pick = computeSwing(def.symbol, def.name, daily);
        break;
      } catch {
        if (attempt === 0) await sleep(400);
      }
    }
    if (!pick) return null;

    // F&O availability (can you trade CE/PE, or cash only?). Use the config flag
    // if set, else ask Groww (cached) when connected.
    if (def.fno === true) {
      pick.hasOptions = true;
    } else {
      const prov = getProvider();
      if (prov.name === "groww") {
        const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
        try {
          pick.hasOptions = await growwHasOptions(prov as GrowwProvider, nse);
        } catch {
          pick.hasOptions = null;
        }
      } else {
        pick.hasOptions = def.fno ?? null;
      }
    }

    // Fundamentals from Yahoo (growth/valuation) - graceful if unavailable.
    const fundamentals = await getFundamentals(def.symbol);
    pick.sector = def.sector || null;
    if (fundamentals) {
      pick.fundamentals = fundamentals;
      // Blend: technical early-entry + fundamental growth.
      pick.opportunityScore = Math.round(0.55 * pick.earlyScore + 0.45 * fundamentals.growthScore);
      pick.note = `${pick.note} | ${fundamentals.growthNote}`;
    } else {
      pick.note = `${pick.note} | Fundamentals N/A (technical only)`;
    }
    return pick;
  };

  const BATCH = 4;
  const results: any[] = [];
  for (let i = 0; i < SWING_SYMBOLS.length; i += BATCH) {
    const chunk = SWING_SYMBOLS.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(fetchOne));
    results.push(...part);
    if (i + BATCH < SWING_SYMBOLS.length) await sleep(250);
  }
  // Rank by blended opportunity (technical + fundamental); early setups with
  // real growth rise to the top, extended movers sink.
  const picks = (results.filter(Boolean) as any[]).sort((a, b) => b.opportunityScore - a.opportunityScore);
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks,
    disclaimer:
      "Short-term swing scan on daily data. 'Early breakout' / 'Building base' = potential early entry; " +
      "'Extended' = already moved, chasing is risky. Not a recommendation - confirm and use a stop. " +
      "Universe is a defined list; add more symbols in SWING_SYMBOLS.",
  });
});

// Long-term (positional) scan: durable multi-month up-trends with growth.
router.get("/longterm", async (_req: Request, res: Response) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const universe = ALL_SYMBOLS.filter((d) => d.type === "equity"); // stocks only, no indices
  const fetchOne = async (def: SymbolDef) => {
    let pick: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const daily = await getProvider().getCandles(def.symbol, "1d", 500); // ~1.5yr for 200-DMA + 12m return
        pick = computeLongTerm(def.symbol, def.name, daily);
        break;
      } catch {
        if (attempt === 0) await sleep(400);
      }
    }
    if (!pick) return null;

    // F&O availability (config flag, else Groww cached lookup).
    if (def.fno === true) {
      pick.hasOptions = true;
    } else {
      const prov = getProvider();
      if (prov.name === "groww") {
        const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
        try {
          pick.hasOptions = await growwHasOptions(prov as GrowwProvider, nse);
        } catch {
          pick.hasOptions = null;
        }
      } else {
        pick.hasOptions = def.fno ?? null;
      }
    }

    // Fundamentals (growth/quality/value) + 10-year multibagger history (Yahoo) - both cached.
    const [fundamentals, multibagger] = await Promise.all([
      getFundamentals(def.symbol),
      getMultibagger(def.symbol),
    ]);
    pick.sector = def.sector || null;
    pick.multibagger = multibagger;
    if (fundamentals) {
      pick.fundamentals = fundamentals;
      // For positional holds, fundamentals matter as much as trend: 50/50 blend.
      pick.opportunityScore = Math.round(0.5 * pick.trendScore + 0.5 * fundamentals.growthScore);
      pick.note = `${pick.note} | ${fundamentals.growthNote}`;
    } else {
      pick.note = `${pick.note} | Fundamentals N/A (trend only)`;
    }
    if (multibagger) pick.note = `${pick.note} | ${multibagger.note}`;
    return pick;
  };

  const BATCH = 4;
  const results: any[] = [];
  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(fetchOne));
    results.push(...part);
    if (i + BATCH < universe.length) await sleep(250);
  }
  const picks = (results.filter(Boolean) as any[]).sort((a, b) => b.opportunityScore - a.opportunityScore);
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks,
    disclaimer:
      "Long-term positional scan on daily data. 'Strong uptrend' / 'Uptrend' (above 200-DMA, golden cross, near highs) " +
      "= trend leaders; 'Base' = watch for a reclaim; 'Downtrend' = avoid for longs. Entry = buy-on-dip near the 50-DMA, " +
      "stop = below the 200-DMA, target = measured move. Educational, not investment advice - do your own research.",
  });
});

// Daily Plan "brain": given day-start capital + risk appetite, allocate across
// option plays and swing equity, size each so total daily risk is capped, and
// set daily stop / profit-book rules. Honest money management, not a profit promise.
router.get("/daily-plan", async (req: Request, res: Response) => {
  const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const capital = clampN(Number(req.query.capital) || 100000, 1000, 1e9);
  const riskPct = clampN(Number(req.query.risk) || 3, 0.5, 10); // max % of capital to RISK today
  const mode = (["conservative", "balanced", "aggressive"].includes(String(req.query.mode)) ? req.query.mode : "balanced") as string;

  const riskBudget = Math.round((capital * riskPct) / 100); // max rupees you allow yourself to lose today
  const dailyStop = -riskBudget;
  const dailyTarget = Math.round(riskBudget * 1.5); // book profits / go flat around +1.5R
  // Allocation of the RISK budget across buckets by mode.
  const split = mode === "conservative" ? { opt: 0.3, sw: 0.7 } : mode === "aggressive" ? { opt: 0.7, sw: 0.3 } : { opt: 0.5, sw: 0.5 };
  const optRisk = Math.round(riskBudget * split.opt);
  const swRisk = Math.round(riskBudget * split.sw);

  const rules = [
    `Max loss today: ₹${riskBudget} (${riskPct}% of ₹${capital}). If you hit -₹${riskBudget}, STOP trading for the day.`,
    `Book/trim around +₹${dailyTarget} (~1.5x your risk) - protect a green day, don't give it back.`,
    "Max ~3 option trades + ~3 swing positions. No averaging into losers. Honor every stop.",
    "Options are intraday/short - don't hold a decaying option overnight near expiry.",
    "Skip low-conviction days: if nothing passes the safety gates, the best trade is NO trade.",
  ];

  if (!isTradingTimeIST()) {
    return res.json({
      marketOpen: false,
      capital, riskPct, mode, riskBudget, dailyStop, dailyTarget, optRisk, swRisk,
      options: [], swing: [], rules,
      message: "Market closed. Your risk budget & rules are ready; specific positions populate at open (9:15 AM - 3:30 PM IST).",
      disclaimer: "Money-management plan, NOT a profit guarantee. Markets have losing days; the edge is small and risk control is the point.",
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- Option bucket: reuse the safety-gated hourly engine, size to fit optRisk ----
  let optionIdeas: any[] = [];
  try {
    const raw = (await runHourlyScan()).slice(0, 3);
    const per = raw.length ? Math.floor(optRisk / raw.length) : 0;
    optionIdeas = raw
      .map((p: any) => {
        const def = findSymbolDef(p.symbol);
        const lot = def?.lotSize ?? null;
        if (!lot || p.premium == null || p.premiumStop == null) return null;
        const lossPerLot = Math.max(1, (p.premium - p.premiumStop) * lot);
        const lots = Math.floor(per / lossPerLot);
        if (lots < 1) return null;
        const qty = lots * lot;
        return {
          symbol: p.symbol, name: p.name, strike: p.strike, optionType: p.optionType, direction: p.direction,
          premium: p.premium, target: p.premiumTarget, stop: p.premiumStop,
          lots, qty, outlay: Math.round(p.premium * qty), maxLoss: Math.round(lossPerLot * lots),
          expectedMovePct: p.expectedPremiumMovePct, decayLevel: p.decayLevel, thetaPctPerDay: p.thetaPctPerDay,
        };
      })
      .filter(Boolean);
  } catch {
    optionIdeas = [];
  }

  // ---- Swing bucket: top early-stage equity setups, sized to fit swRisk ----
  let swingIdeas: any[] = [];
  try {
    const uni = SWING_SYMBOLS.filter((d) => d.type === "equity");
    const picks: any[] = [];
    const BATCH = 6;
    for (let i = 0; i < uni.length; i += BATCH) {
      const chunk = uni.slice(i, i + BATCH);
      const part = await Promise.all(
        chunk.map(async (def) => {
          try {
            const daily = await getDailyCached(def.symbol, 500);
            const s = computeSwing(def.symbol, def.name, daily);
            if (s && (s.stage === "Early breakout" || s.stage === "Building base")) return s;
          } catch {
            /* skip */
          }
          return null;
        })
      );
      picks.push(...part.filter(Boolean));
      if (i + BATCH < uni.length) await sleep(80);
    }
    const top = picks.sort((a, b) => b.earlyScore - a.earlyScore).slice(0, 3);
    const per = top.length ? Math.floor(swRisk / top.length) : 0;
    swingIdeas = top
      .map((s: any) => {
        const riskPerShare = Math.max(0.05, s.entry - s.stop);
        const qty = Math.floor(per / riskPerShare);
        if (qty < 1) return null;
        return {
          symbol: s.symbol, name: s.name, stage: s.stage, entry: s.entry, stop: s.stop, target: s.target,
          expectedMovePct: s.expectedMovePct, qty, outlay: Math.round(s.entry * qty), maxLoss: Math.round(riskPerShare * qty),
        };
      })
      .filter(Boolean);
  } catch {
    swingIdeas = [];
  }

  const optDeployed = optionIdeas.reduce((s, o) => s + o.outlay, 0);
  const swDeployed = swingIdeas.reduce((s, o) => s + o.outlay, 0);
  const optRiskUsed = optionIdeas.reduce((s, o) => s + o.maxLoss, 0);
  const swRiskUsed = swingIdeas.reduce((s, o) => s + o.maxLoss, 0);
  const totalRiskUsed = optRiskUsed + swRiskUsed;

  // Honest daily scenarios (illustrative, ~50-55% win assumption, 1.5R winners).
  const scenarios = {
    badDay: -totalRiskUsed, // all stops hit
    typicalDay: Math.round(totalRiskUsed * 0.1), // roughly flat with small edge
    goodDay: Math.round(totalRiskUsed * 1.3), // most winners hit ~1.5R
  };

  res.json({
    marketOpen: true,
    capital, riskPct, mode, riskBudget, dailyStop, dailyTarget, optRisk, swRisk,
    options: optionIdeas, swing: swingIdeas,
    summary: {
      optDeployed, swDeployed, totalDeployed: optDeployed + swDeployed,
      optRiskUsed, swRiskUsed, totalRiskUsed,
      cashIdle: Math.max(0, capital - optDeployed - swDeployed),
    },
    scenarios, rules,
    disclaimer:
      "Money-management plan, NOT a profit guarantee. Sizing caps your worst-case daily loss to your risk budget. " +
      "Daily gains are NOT guaranteed - many days are flat or down; discipline over time is the edge. Educational only.",
  });
});

// Combined swing movers: Short-Term + Frequent + Monthly in ONE pass (one daily fetch).
router.get("/movers", async (_req: Request, res: Response) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const universe = SWING_SYMBOLS.filter((d) => d.type === "equity");
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

  const fetchOne = async (def: SymbolDef) => {
    let daily: any[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        daily = await getDailyCached(def.symbol, 500);
        break;
      } catch {
        if (attempt === 0) await sleep(300);
      }
    }
    if (!daily || daily.length < 150) return null;

    // Three lenses on the SAME daily data.
    const st = computeSwing(def.symbol, def.name, daily);
    const fq = computeFrequentMover(def.symbol, def.name, daily);
    const mo = computeMonthlyShot(def.symbol, def.name, daily);
    if (!st && !fq && !mo) return null;

    const [fundamentals] = await Promise.all([getFundamentals(def.symbol)]);
    let hasOptions: boolean | null = def.fno === true ? true : null;
    if (hasOptions == null) {
      const prov = getProvider();
      if (prov.name === "groww") {
        const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
        try {
          hasOptions = await growwHasOptions(prov as GrowwProvider, nse);
        } catch {
          hasOptions = null;
        }
      } else hasOptions = def.fno ?? null;
    }

    const earlyScore = st ? st.earlyScore : 0;
    const opportunityScore = fundamentals && st ? Math.round(0.55 * earlyScore + 0.45 * fundamentals.growthScore) : earlyScore;
    const freqScore = fq ? clamp(Math.round(fq.freqPct["3"] * 1.8 + fq.avgDailyRangePct * 6), 0, 100) : 0;
    const monthlyProb = mo ? mo.probability : 0;
    // Blended: short-term setup (incl. fundamentals) + monthly odds + activity.
    const combinedScore = Math.round(0.4 * opportunityScore + 0.35 * monthlyProb + 0.25 * freqScore);

    return {
      symbol: def.symbol,
      name: def.name,
      sector: def.sector || null,
      price: st?.price ?? fq?.price ?? mo?.price ?? null,
      hasOptions,
      // Short-term
      stage: st?.stage ?? "—",
      earlyScore,
      breakout: st?.breakout ?? false,
      volSurge: st?.volSurge ?? null,
      weekChangePct: st?.weekChangePct ?? null,
      entry: st?.entry ?? null,
      stStop: st?.stop ?? null,
      stTarget: st?.target ?? null,
      expectedMovePct: st?.expectedMovePct ?? null,
      // Frequent
      freq3: fq ? fq.freqPct["3"] : null,
      freq5: fq ? fq.freqPct["5"] : null,
      avgDailyRangePct: fq?.avgDailyRangePct ?? null,
      maxDayMovePct: fq?.maxDayMovePct ?? null,
      atrPct: fq?.atrPct ?? st?.atrPct ?? null,
      freqScore,
      // Monthly
      monthlyProb,
      monthlyTargetPct: mo?.targetPct ?? null,
      monthlyTarget: mo?.target ?? null,
      baseRate20: mo?.baseRate20 ?? null,
      // Blends
      rsi: st?.rsi ?? mo?.rsi ?? null,
      fundamentals: fundamentals || undefined,
      opportunityScore,
      combinedScore,
    };
  };

  const BATCH = 6;
  const results: any[] = [];
  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(fetchOne));
    results.push(...part.filter(Boolean));
    if (i + BATCH < universe.length) await sleep(120);
  }
  const picks = results.sort((a, b) => b.combinedScore - a.combinedScore);
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks,
    disclaimer:
      "Combined swing view: Short-term setup + Frequent-mover volatility + Monthly-swing odds on the same daily data. " +
      "'Combined' blends the short-term opportunity, monthly probability and activity. Estimates, not guarantees - use stops.",
  });
});

// Big-move radar (HIGH RISK): stocks set up for a 20-100% run over ~6 months.
router.get("/big-move", async (_req: Request, res: Response) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const universe = SWING_SYMBOLS.filter((d) => d.type === "equity");
  const fetchOne = async (def: SymbolDef) => {
    let pick: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const daily = await getDailyCached(def.symbol, 500);
        pick = computeBigMove(def.symbol, def.name, daily);
        break;
      } catch {
        if (attempt === 0) await sleep(300);
      }
    }
    if (!pick) return null;
    pick.sector = def.sector || null;
    if (def.fno === true) {
      pick.hasOptions = true;
    } else {
      const prov = getProvider();
      if (prov.name === "groww") {
        const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
        try {
          pick.hasOptions = await growwHasOptions(prov as GrowwProvider, nse);
        } catch {
          pick.hasOptions = null;
        }
      } else {
        pick.hasOptions = def.fno ?? null;
      }
    }
    return pick;
  };

  const BATCH = 6;
  const results: any[] = [];
  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(fetchOne));
    results.push(...part);
    if (i + BATCH < universe.length) await sleep(120);
  }
  // Keep names that aren't outright weak; ORDER by the composite move-rank
  // (breakout proximity + short-term potential + readiness), then breakout distance.
  const picks = (results.filter(Boolean) as any[])
    .filter((p) => p.stage !== "Weak" && p.readinessScore >= 25)
    .sort((a, b) => (b.moveRank ?? 0) - (a.moveRank ?? 0) || (a.breakoutDistPct ?? 999) - (b.breakoutDistPct ?? 999) || b.readinessScore - a.readinessScore);
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks,
    disclaimer:
      "HIGH-RISK big-move radar. It flags SETUPS that historically precede large runs (tight base, volume dry-up, " +
      "breakout proximity, strong trend) and grounds the odds in the stock's own 6-month history of 20/50/100% moves. " +
      "'Probability' is an estimate, NOT a prediction - most setups do NOT double. Use the stop, size small, be patient.",
  });
});

// Today's Big Movers: intraday scan - stocks most likely to make a LARGE move
// TODAY (gap + relative volume + range expansion + momentum). Cached 60s.
router.get("/today-movers", async (_req: Request, res: Response) => {
  const data = await cached("today-movers", 60_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const universe = SWING_SYMBOLS.filter((d) => d.type === "equity");
    const fetchOne = async (def: SymbolDef) => {
      let pick: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const [intraday, daily] = await Promise.all([
            getCandlesCached(def.symbol, "15m"),
            getDailyCached(def.symbol, 60),
          ]);
          pick = computeTodayMover(def.symbol, def.name, intraday, daily);
          break;
        } catch {
          if (attempt === 0) await sleep(300);
        }
      }
      if (!pick) return null;
      pick.sector = def.sector || null;
      if (def.fno === true) pick.hasOptions = true;
      else {
        const prov = getProvider();
        if (prov.name === "groww") {
          const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
          try { pick.hasOptions = await growwHasOptions(prov as GrowwProvider, nse); } catch { pick.hasOptions = null; }
        } else pick.hasOptions = def.fno ?? null;
      }
      return pick;
    };

    const BATCH = 6;
    const results: any[] = [];
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      const part = await Promise.all(chunk.map(fetchOne));
      results.push(...part.filter(Boolean));
      if (i + BATCH < universe.length) await sleep(120);
    }
    // Rank by mover score; keep names with a real move / activity signature.
    const picks = (results as any[])
      .filter((p) => p.moverScore >= 20 || Math.abs(p.changePct) >= 1 || p.rvolDay >= 1.5)
      .sort((a, b) => b.moverScore - a.moverScore);
    // TOP 5 OPENING-HIGH movers: opened UP (gap) on good volume. F&O names (which
    // carry option OI) are prioritized to the top; cash-only names still appear,
    // each badged. Sort key nudges F&O above cash when scores are comparable.
    const top5OpeningHigh = (results as any[])
      .filter((p) => p.gapPct >= 0.1 && p.rvolDay >= 1.0)
      .sort((a, b) => (b.openHighScore + (b.hasOptions === true ? 8 : 0)) - (a.openHighScore + (a.hasOptions === true ? 8 : 0)))
      .slice(0, 5);
    return { picks, top5OpeningHigh, session: picks[0]?.session ?? null };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    marketOpen: isTradingTimeIST(),
    session: data.session,
    picks: data.picks,
    top5OpeningHigh: data.top5OpeningHigh,
    disclaimer:
      "Today's Big Movers is an INTRADAY scan of what's moving now: opening gap, relative volume (participation), " +
      "range expansion vs typical daily range, and 15m momentum. It highlights activity/likelihood of a big day, " +
      "NOT a guaranteed direction. Use the stop; intraday moves reverse fast.",
  });
});

// Clean-Move Rating: rank stocks by how CLEANLY they trend - the best names to
// BUY options on (clean directional moves that follow through, low whipsaw).
router.get("/clean-movers", async (_req: Request, res: Response) => {
  const data = await cached("clean-movers", 10 * 60_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const universe = SWING_SYMBOLS.filter((d) => d.type === "equity");
    const fetchOne = async (def: SymbolDef) => {
      let pick: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const daily = await getDailyCached(def.symbol, 160);
          pick = computeCleanMover(def.symbol, def.name, daily);
          break;
        } catch {
          if (attempt === 0) await sleep(300);
        }
      }
      if (!pick) return null;
      pick.sector = def.sector || null;
      if (def.fno === true) pick.hasOptions = true;
      else {
        const prov = getProvider();
        if (prov.name === "groww") {
          const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
          try { pick.hasOptions = await growwHasOptions(prov as GrowwProvider, nse); } catch { pick.hasOptions = null; }
        } else pick.hasOptions = def.fno ?? null;
      }
      return pick;
    };

    const BATCH = 6;
    const results: any[] = [];
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      const part = await Promise.all(chunk.map(fetchOne));
      results.push(...part.filter(Boolean));
      if (i + BATCH < universe.length) await sleep(120);
    }
    const picks = (results as any[]).sort((a, b) => b.rating - a.rating);
    return { picks };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks: data.picks,
    disclaimer:
      "Clean-Move Rating scores how CLEANLY a stock trends (Kaufman efficiency ratio + ADX strength + move size + " +
      "follow-through, minus choppiness/whipsaw) - i.e. how suitable it is for BUYING options. A high grade means " +
      "directional moves tend to follow through cleanly; it is NOT a direction call or a profit guarantee.",
  });
});

// TRADE MINDER for a symbol: is the current pullback a test (HOLD) or a real
// reversal (EXIT)? dir=auto uses the current signal direction.
router.get("/trade-minder/:symbol", async (req: Request, res: Response) => {
  const symbol = req.params.symbol;
  const interval = parseInterval(req.query.interval);
  const dirParam = String(req.query.dir || "auto");
  try {
    const candles = await getCandlesCached(symbol, interval);
    if (!candles || candles.length < 20) return res.status(404).json({ error: "Not enough data for the Trade Minder." });
    let direction: "Bullish" | "Bearish";
    if (dirParam === "Bullish" || dirParam === "Bearish") direction = dirParam;
    else { const sig = computeSignal(symbol, candles); direction = sig.score >= 0 ? "Bullish" : "Bearish"; }
    const m = computeTradeMinder(candles, direction);
    if (!m) return res.status(404).json({ error: "Could not compute the Trade Minder." });
    res.json({ symbol, interval, ...m, disclaimer: "Trade Minder distinguishes a normal test/shakeout (HOLD) from a real reversal (EXIT) using VWAP + swing structure + volume. It reduces premature exits but is not a guarantee - a test can still become a reversal." });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Trade Minder failed." });
  }
});

// HOURLY CHECK (last N days): at each hourly slot, system prediction vs the
// market's ACTUAL next-hour move, marked correct/wrong with a reason when wrong.
router.get("/backtest/hourly", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "^NSEI");
  const days = Math.max(3, Math.min(30, Number(req.query.days) || 15));
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });
  try {
    const [c15, daily] = await Promise.all([getCandlesCached(symbol, "15m"), getDailyCached(symbol, 80)]);
    const result = backtestHourly(symbol, def.name, c15, daily, days);
    if (!result) return res.json({ symbol, error: "Not enough intraday data for this symbol." });
    res.json({ generatedAt: Math.floor(Date.now() / 1000), ...result, disclaimer: "No-lookahead: the signal at each hourly slot uses data up to that bar only, then is checked against the ACTUAL next-hour move (9:30-15:00). Directional check - option premium P&L isn't reconstructable." });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Hourly check failed." });
  }
});

// MOVE-TIMING profile: when (time of day) does the symbol move most, and how the
// most-active window / volatility shifts weekly or monthly. /api/move-timing?symbol=^NSEI&period=weekly
router.get("/move-timing", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "^NSEI");
  const period = (String(req.query.period || "weekly") === "monthly" ? "monthly" : "weekly") as "weekly" | "monthly";
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });
  try {
    const c15 = await getCandlesCached(symbol, "15m");
    const result = computeMoveTiming(symbol, def.name, c15, period);
    if (!result) return res.json({ symbol, error: "Not enough intraday data for this symbol." });
    res.json({ generatedAt: Math.floor(Date.now() / 1000), ...result, disclaimer: "Based on ~45 days of 15-minute history, 09:30-15:00 window only. 'Range%' is (high-low)/open per bar. Descriptive of when volatility clusters - not a prediction." });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Move-timing failed." });
  }
});

// MANUAL DAY REPLAY: pick a date + symbol + mode -> what the system decided that
// day (no lookahead) AND the day's actual best movers, so you can see where the
// logic missed the better trade. /api/replay?date=YYYY-MM-DD&symbol=^NSEI&mode=option
router.get("/replay", async (req: Request, res: Response) => {
  const date = String(req.query.date || "").slice(0, 10);
  const symbol = String(req.query.symbol || "^NSEI");
  const mode = (String(req.query.mode || "option") as "option" | "intraday" | "swing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Provide date=YYYY-MM-DD." });
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });

  try {
    // Chosen symbol: system's decision + its own actual move that day.
    const [c15, daily] = await Promise.all([getCandlesCached(symbol, "15m"), getDailyCached(symbol, 80)]);
    const systemCall = systemCallForDate(symbol, c15, daily, date);
    const chosenMover = dayMoveMetrics(symbol, def.name, def.type === "index", c15, date);
    if (!chosenMover) return res.json({ date, symbol, mode, error: `No 15m data for ${symbol} on ${date} (only ~45 days of intraday history is available).` });

    // Universe leaderboard: only the SAME asset class as the selected symbol
    // (index selected -> indices only; stock selected -> stocks only).
    const universe = DEFAULT_SYMBOLS.filter((d) => d.fno && d.type === def.type);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const movers: any[] = [];
    const BATCH = 6;
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      const part = await Promise.all(chunk.map(async (d) => {
        try { const c = await getCandlesCached(d.symbol, "15m"); return dayMoveMetrics(d.symbol, d.name, d.type === "index", c, date); } catch { return null; }
      }));
      movers.push(...part.filter(Boolean));
      if (i + BATCH < universe.length) await sleep(100);
    }
    const leaderboard = movers.sort((a, b) => b.bestMovePct - a.bestMovePct).slice(0, 8);
    const best = leaderboard[0] || null;

    // Verdict: where did the logic miss?
    const chosenRank = movers.findIndex((m) => m.symbol === symbol) + 1;
    let verdict = "";
    let missed = false;
    if (!systemCall.hasSignal) {
      missed = !!(best && best.bestMovePct >= 1.5);
      verdict = `Your system took NO trade on ${symbol} that day.` + (best ? ` The day's best mover was ${best.name} (${best.bestDir} ${best.bestMovePct}%). ${missed ? "MISSED - a strong move was available." : "No strong move existed anyway, so sitting out was fine."}` : "");
    } else if (systemCall.result === "WIN") {
      verdict = `Your system was RIGHT on ${symbol} (${systemCall.direction}, captured ${systemCall.capturedPct}%). Day's best mover: ${best ? best.name + " " + best.bestMovePct + "%" : "-"}${chosenRank ? ` · ${symbol} ranked #${chosenRank} of ${movers.length} movers.` : ""}`;
    } else {
      const dirActual = chosenMover.bestDir === "Up" ? "Bullish" : "Bearish";
      const wrongDir = (systemCall.direction === "Bullish") !== (chosenMover.bestDir === "Up");
      missed = true;
      verdict = `Your system was ${systemCall.result} on ${symbol} (called ${systemCall.direction}). ${wrongDir ? `WRONG DIRECTION - the stock's bigger move that day was ${dirActual} (${chosenMover.bestMovePct}%).` : "Right direction but stopped/flat - target/stop or timing was off."} Day's best mover: ${best ? best.name + " " + best.bestDir + " " + best.bestMovePct + "%" : "-"}.`;
    }

    res.json({
      date, symbol, name: def.name, mode, systemCall, chosenMover, chosenRank: chosenRank || null, leaderboard, best, missed, verdict,
      disclaimer: "Manual day replay: system decision is no-lookahead within the 09:30-15:00 window. 'Best mover' is the actual max intraday excursion in that window. Directional only - option premium P&L isn't reconstructable (no historical chain).",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Replay failed." });
  }
});

// BACKTEST the 4-layer Direction Engine (no lookahead) -> win probability per day.
// /api/backtest/direction?symbol=^NSEI&days=7&minScore=15
router.get("/backtest/direction", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "^NSEI");
  const days = Math.max(1, Math.min(30, Number(req.query.days) || 7));
  const minScore = Math.max(0, Math.min(80, Number(req.query.minScore) || 15));
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });
  try {
    const [c15, daily] = await Promise.all([getCandlesCached(symbol, "15m"), getDailyCached(symbol, 60)]);
    const result = backtestDirection4L(symbol, def.name, c15, daily, days, minScore);
    if (!result) return res.json({ symbol, error: "Not enough intraday history for this symbol." });
    res.json({ generatedAt: Math.floor(Date.now() / 1000), ...result });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Direction backtest failed." });
  }
});

// Support/Resistance around spot: nearest immediate S/R (from OI walls + pivots +
// PDH/PDL) with a ±margin zone, PLUS the MAJOR OI walls (max CE/PE OI) and the
// OI sentiment side. Used inside the Best Option Plays index chips.
function computeSrLevels(candles: any[], daily: any[], oi: OiAnalysis | null, todayIso: string, margin = 10) {
  const r0 = (n: number) => Math.round(n);
  const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const spot = candles[candles.length - 1].close;
  let pd: any = null;
  for (let i = daily.length - 1; i >= 0; i--) { if (istDay(daily[i].time) < todayIso) { pd = daily[i]; break; } }
  let pdh: number | null = null, pdl: number | null = null, pp: number | null = null, r1: number | null = null, s1: number | null = null;
  if (pd) { pdh = pd.high; pdl = pd.low; pp = (pd.high + pd.low + pd.close) / 3; r1 = 2 * pp - pd.low; s1 = 2 * pp - pd.high; }
  const oiRes = oi && oi.available ? oi.resistance : null; // max CE OI wall (major resistance)
  const oiSup = oi && oi.available ? oi.support : null;     // max PE OI wall (major support)
  const resCands = [oiRes, pdh, r1, pp].filter((v): v is number => v != null && v > spot + 1).sort((a, b) => a - b);
  const supCands = [oiSup, pdl, s1, pp].filter((v): v is number => v != null && v < spot - 1).sort((a, b) => b - a);
  const resistance = resCands.length ? resCands[0] : null;
  const support = supCands.length ? supCands[0] : null;
  const srcOf = (v: number | null) => v == null ? "" : (v === oiRes || v === oiSup) ? "OI" : v === pdh ? "PDH" : v === pdl ? "PDL" : v === r1 ? "R1" : v === s1 ? "S1" : v === pp ? "PP" : "";
  const bias = oi && oi.available ? oi.verdict.bias : "Neutral";
  const pcr = oi && oi.available ? oi.pcr : null;
  return {
    spot: r0(spot),
    support: support != null ? r0(support) : null, supportSrc: srcOf(support),
    resistance: resistance != null ? r0(resistance) : null, resistanceSrc: srcOf(resistance),
    supportZone: support != null ? [r0(support - margin), r0(support + margin)] : null,
    resistanceZone: resistance != null ? [r0(resistance - margin), r0(resistance + margin)] : null,
    majorSupport: oiSup != null ? r0(oiSup) : (pdl != null ? r0(pdl) : null),
    majorResistance: oiRes != null ? r0(oiRes) : (pdh != null ? r0(pdh) : null),
    distToSupport: support != null ? r0(spot - support) : null,
    distToResistance: resistance != null ? r0(resistance - spot) : null,
    sentiment: bias, pcr, marginPts: margin,
  };
}

// 4-LAYER DIRECTION ENGINE: Market Structure(40) + Trend(25) + Derivatives(20)
// + Momentum(15) -> direction + 0-100 confidence with a full layer breakdown.
// /api/direction/:symbol
router.get("/direction/:symbol", async (req: Request, res: Response) => {
  const symbol = req.params.symbol;
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });
  try {
    const [c15, daily] = await Promise.all([getCandlesCached(symbol, "15m"), getDailyCached(symbol, 60)]);
    let oi: OiAnalysis | null = null;
    if (def.fno) { try { oi = (await getOiCached(def)) as OiAnalysis; } catch { oi = null; } }
    const result = computeDirection4L(symbol, def.name, c15, daily, oi);
    if (!result) return res.status(404).json({ error: "Not enough data for the direction engine." });
    res.json({ generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), ...result });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Direction engine failed." });
  }
});

// ASK: natural-language Q&A about a stock/index using its LIVE analysis (direction
// without RSI/MACD, option idea, OI walls/build-up, ADX trend, S/R, timing). The
// user types a question; we detect intent and answer from the live data (Hindi).
// /api/ask?symbol=RELIANCE.NS&q=should%20i%20buy
router.get("/ask", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "").trim();
  const q = String(req.query.q || "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const def = findSymbolDef(symbol);
  if (!def) return res.json({ answer: `"${symbol}" pehchana nahi. Watchlist se koi stock/index chunein.`, bullets: [] });
  try {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const [c5, c15, c60, daily] = await Promise.all([
      getCandlesCached(symbol, "5m").catch(() => []), getCandlesCached(symbol, "15m"), getCandlesCached(symbol, "60m").catch(() => []), getDailyCached(symbol, 60),
    ]);
    if (!c15 || c15.length < 30) return res.json({ answer: `${def.name} ka intraday data abhi nahi mila — thodi der baad poochein.`, bullets: [] });
    let oi: OiAnalysis | null = null;
    if (def.fno) { try { oi = (await getOiCached(def)) as OiAnalysis; } catch { oi = null; } }

    const sig = computeSignal(symbol, c15);
    const spot = sig.price;
    const atrDaily = last(atr(daily, 14));
    const d4 = computeDirection4L(symbol, def.name, c15, daily, oi as any);
    const nm = d4 ? directionNoMomentum(d4) : null;
    // Directional trend strength (ADX/DMI) on 15m.
    const dm = adx(c15, 14);
    const adxV = last(dm.adx), plusDI = last(dm.plusDI), minusDI = last(dm.minusDI);
    const adxStrength = adxV == null ? "n/a" : adxV >= 40 ? "बहुत मज़बूत" : adxV >= 25 ? "मज़बूत" : adxV >= 20 ? "बन रहा" : "कमज़ोर (range)";
    // Timing / extension via RSI stretch on 15m.
    const rsi15 = last(rsi(c15.map((x) => x.close), 14));
    // Option idea (CE/PE + strike + premium/target/stop) — the tradeable read.
    const opp: any = buildDayOpportunity(def, sig, oi as any, atrDaily, { benchmarks: [], stockDaily: daily || [], candles: c15 });
    // Levels: OI walls + S/R.
    const lv = levelContext(c15, daily, oi as any);

    const dir = nm && nm.direction !== "Neutral" ? nm.direction : (d4?.direction ?? "Neutral");
    const bull = dir === "Bullish";
    const rsiStretch = rsi15 == null ? null : (bull ? rsi15 : 100 - rsi15);
    const timing = rsiStretch == null ? "n/a" : rsiStretch >= 70 ? "EXTENDED (bahut bhag chuka)" : rsiStretch >= 57 ? "UNDERWAY (chal raha)" : "READY (shuruaat)";
    const conf = nm ? nm.confidence : (d4?.confidence ?? 0);
    const optType = opp?.optionType ?? (bull ? "CE" : "PE");

    // TODAY'S RANGE: intraday low–high + where spot sits inside it.
    const lastC = c15[c15.length - 1];
    const { high: dHigh, low: dLow } = dayHighLow(c15);
    const dayHigh = dHigh ?? lastC.high;
    const dayLow = dLow ?? lastC.low;
    const rangePos = dayHigh > dayLow ? Math.round(((spot - dayLow) / (dayHigh - dayLow)) * 100) : null;
    const rangeWhere = rangePos == null ? "" : rangePos >= 70 ? "ऊपरी हिस्से में (High के पास)" : rangePos <= 30 ? "निचले हिस्से में (Low के पास)" : "बीच में";

    // OI BUILD-UP: which side is writing MORE (support vs resistance) + the strikes.
    const oiRows: any[] = oi?.topStrikes || [];
    let ceBuild: any = null, peBuild: any = null, netCe = 0, netPe = 0;
    const anyChg = oiRows.some((r) => (r.ceChg || 0) !== 0 || (r.peChg || 0) !== 0);
    for (const r of oiRows) {
      netCe += r.ceChg || 0; netPe += r.peChg || 0;
      if (anyChg ? (r.ceChg || 0) > (ceBuild?.ceChg || -1e18) : (r.ceOi || 0) > (ceBuild?.ceOi || -1)) ceBuild = r;
      if (anyChg ? (r.peChg || 0) > (peBuild?.peChg || -1e18) : (r.peOi || 0) > (peBuild?.peOi || -1)) peBuild = r;
    }
    const buildSide = !oi?.available ? "n/a"
      : netPe > netCe * 1.15 ? "PUT ज़्यादा (support बन रहा → तेज़ी झुकाव)"
      : netCe > netPe * 1.15 ? "CALL ज़्यादा (resistance बन रहा → मंदी झुकाव)"
      : "दोनों तरफ़ बराबर (range)";
    // Suggested CE / PE strikes: the tradeable strike (from the option engine) +
    // the ATM as a reference. CE = tezi me, PE = mandi me.
    const atmStrike = def.fno ? nearestStrike(spot, def) : null;
    const ceStrike = optType === "CE" && opp?.strike ? opp.strike : atmStrike;
    const peStrike = optType === "PE" && opp?.strike ? opp.strike : atmStrike;

    // Compact OI number + build-up % helpers.
    const oiN = (n: number | null | undefined) => {
      if (n == null || isNaN(n as number)) return "-";
      const a = Math.abs(n as number);
      if (a >= 1e7) return ((n as number) / 1e7).toFixed(2) + "Cr";
      if (a >= 1e5) return ((n as number) / 1e5).toFixed(2) + "L";
      if (a >= 1e3) return ((n as number) / 1e3).toFixed(1) + "K";
      return String(Math.round(n as number));
    };
    const bpct = (chg: number, oiNow: number) => { const prev = oiNow - chg; return prev > 0 ? Math.round((chg / prev) * 1000) / 10 : null; };
    const cePctB = ceBuild ? bpct(ceBuild.ceChg || 0, ceBuild.ceOi || 0) : null;
    const pePctB = peBuild ? bpct(peBuild.peChg || 0, peBuild.peOi || 0) : null;

    // ---- build data + bullets (ORDER: levels → RANGE → OI build-up NUMBERS → takat → direction → strikes → option) ----
    const bullets: string[] = [];
    // 1) PDH / PDL levels FIRST
    bullets.push(`स्तर: कल का High <b>${lv.pdh ?? "-"}</b> (PDH) / कल का Low <b>${lv.pdl ?? "-"}</b> (PDL) · VWAP ${lv.vwap ?? "-"} · आज का Open ${lv.dayOpen ?? "-"}`);
    // 2) Today's range (green, live — expands as price makes new highs/lows)
    bullets.push(`<span class="ask-range">📊 आज की रेंज: <b>${Math.round(dayLow)}</b> – <b>${Math.round(dayHigh)}</b> · spot ${Math.round(spot)}${rangePos != null ? ` (रेंज के ${rangePos}% पर, ${rangeWhere})` : ""}</span>`);
    // 2b) MARKET CONDITION per timeframe (5m / 15m / 1h) — option-buyer's caution guide.
    const regByTf = { "5m": classifyRegime(c5), "15m": classifyRegime(c15), "1h": classifyRegime(c60) };
    const regTxt = (tf: string, r: any) => r ? `${tf}: ${r.emoji} ${r.label}` : `${tf}: —`;
    bullets.push(`<span class="ask-mkt">🩺 बाज़ार की हालत — ${regTxt("5m", regByTf["5m"])} · ${regTxt("15m", regByTf["15m"])} · ${regTxt("1h", regByTf["1h"])}</span>`);
    // 3) OI build-up NUMBERS (right after range)
    if (oi && oi.available) {
      bullets.push(`OI build-up: <b>${buildSide}</b>${ceBuild ? ` · CE @ <b>${ceBuild.strike}</b>: OI ${oiN(ceBuild.ceOi)}${cePctB != null ? ` (${cePctB >= 0 ? "+" : ""}${cePctB}%)` : ""}` : ""}${peBuild ? ` · PE @ <b>${peBuild.strike}</b>: OI ${oiN(peBuild.peOi)}${pePctB != null ? ` (${pePctB >= 0 ? "+" : ""}${pePctB}%)` : ""}` : ""} · PCR ${oi.pcr ?? "-"}`);
    }
    // 4) Market strength (ADX)
    if (adxV != null) bullets.push(`ताक़त (ADX ${r1(adxV)}): <b>${adxStrength}</b> · +DI ${r1(plusDI || 0)} / -DI ${r1(minusDI || 0)} → ${(plusDI || 0) >= (minusDI || 0) ? "ख़रीदार भारी" : "बिकवाली भारी"}`);
    // 5) Direction
    bullets.push(`दिशा (RSI/MACD-free): <b>${dir === "Bullish" ? "तेज़ी ▲" : dir === "Bearish" ? "मंदी ▼" : "न्यूट्रल"}</b> · conf ${conf}% · टाइमिंग ${timing}`);
    // 6) Suggested CE/PE strikes
    if (oi && oi.available) {
      bullets.push(`सुझाव strike: <b>CE ${ceStrike ?? "-"}</b> (तेज़ी में) · <b>PE ${peStrike ?? "-"}</b> (मंदी में) · सपोर्ट ${lv.majorSupport ?? oi.support ?? "-"} / रेज़िस्टेंस ${lv.majorResistance ?? oi.resistance ?? "-"}`);
    }
    // 6) Option play
    if (opp && opp.tradeable && opp.premium != null) {
      bullets.push(`ऑप्शन play: <b>${opp.strike} ${optType}</b> ~₹${Math.round(opp.premium)} → टारगेट ₹${Math.round(opp.premiumTarget)} (+${r1(opp.expectedPremiumMovePct || 0)}%), स्टॉप ₹${Math.round(opp.premiumStop)}`);
    } else if (opp && !opp.tradeable) {
      bullets.push(`ऑप्शन: अभी साफ़ tradeable setup नहीं (safety gate) — इंतज़ार।`);
    }

    // ---- intent → headline answer (Hindi) ----
    const ql = q.toLowerCase();
    const has = (...ks: string[]) => ks.some((k) => ql.includes(k));
    let headline: string;
    const dirWord = dir === "Bullish" ? "तेज़ी (Bullish)" : dir === "Bearish" ? "मंदी (Bearish)" : "कोई साफ़ दिशा नहीं";
    const tradeableGood = opp && opp.tradeable && conf >= 50 && adxV != null && adxV >= 20;

    if (dir === "Neutral") {
      headline = `${def.name}: अभी <b>कोई साफ़ दिशा नहीं</b> (न्यूट्रल) — ट्रेड avoid करें, breakout का इंतज़ार।`;
    } else if (has("buy", "sell", "trade", "kya karu", "karu", "lू", "loon", "लूं", "खरीद", "बेच", "should")) {
      headline = tradeableGood
        ? `${def.name}: <b>${dirWord}</b> — ${opp.strike} ${optType} लिया जा सकता है (conf ${conf}%, ADX ${adxV != null ? r1(adxV) : "-"}). ${timing.startsWith("EXTENDED") ? "पर move काफ़ी bhag chuka — छोटा/ट्रेलिंग SL." : "टाइट स्टॉप के साथ।"}`
        : `${def.name}: झुकाव <b>${dirWord}</b> पर है, पर अभी conviction कम (conf ${conf}%${adxV != null && adxV < 20 ? ", ADX kamzor/range" : ""}) — मैं अभी <b>इंतज़ार</b> करूँगा।`;
    } else if (has("target", "kitna", "कितना", "move", "kahan", "कहां", "upside")) {
      headline = opp && opp.premium != null
        ? `${def.name}: ${optType} का टारगेट ~₹${Math.round(opp.premiumTarget)} (+${r1(opp.expectedPremiumMovePct || 0)}% premium), spot target ${bull ? "up" : "down"} ~${Math.round(opp.spotTarget)}. ${timing}.`
        : `${def.name}: expected move ~${atrDaily && spot ? r1((atrDaily / spot) * 100) : "?"}% (daily range). दिशा ${dirWord}.`;
    } else if (has("stop", "sl", "स्टॉप", "loss")) {
      headline = opp && opp.premiumStop != null
        ? `${def.name}: स्टॉप — premium ₹${Math.round(opp.premiumStop)} पर, या spot ${Math.round(opp.spotStop)} टूटने पर निकल जाएँ।`
        : `${def.name}: नज़दीकी ${bull ? "सपोर्ट" : "रेज़िस्टेंस"} ${bull ? (lv.majorSupport ?? "-") : (lv.majorResistance ?? "-")} के पार स्टॉप रखें।`;
    } else if (has("support", "resist", "सपोर्ट", "रेज़िस", "level", "स्तर")) {
      headline = `${def.name}: सपोर्ट <b>${lv.majorSupport ?? oi?.support ?? "-"}</b>, रेज़िस्टेंस <b>${lv.majorResistance ?? oi?.resistance ?? "-"}</b> (spot ${Math.round(spot)}). कल का High ${lv.pdh ?? "-"} (PDH) / कल का Low ${lv.pdl ?? "-"} (PDL).`;
    } else if (has("oi", "open interest", "pcr", "buildup", "build up", "बिल्ड", "लिखाई")) {
      headline = oi && oi.available
        ? `${def.name}: OI build-up <b>${buildSide}</b>${ceBuild ? ` · CE @ ${ceBuild.strike}` : ""}${peBuild ? ` · PE @ ${peBuild.strike}` : ""}. सुझाव: <b>CE ${ceStrike ?? "-"}</b> / <b>PE ${peStrike ?? "-"}</b> · PCR ${oi.pcr ?? "-"}, सपोर्ट ${lv.majorSupport ?? oi.support}, रेज़िस्टेंस ${lv.majorResistance ?? oi.resistance}.`
        : `${def.name}: OI abhi available nahi (rate-limit ya cash-only).`;
    } else if (has("condition", "हालत", "halat", "regime", "lottery", "लॉटरी", "whipsaw", "sl", "range bound", "rangebound", "careful", "chop")) {
      const r5 = regByTf["5m"], r15 = regByTf["15m"], r1h = regByTf["1h"];
      const worst = [r5, r15, r1h].find((r) => r && r.state === "good") ? "good" : [r5, r15, r1h].find((r) => r && r.state === "lottery") ? "lottery" : "caution";
      const line = (tf: string, r: any) => r ? `${tf} ${r.emoji} ${r.label}` : `${tf} —`;
      headline = `${def.name}: बाज़ार की हालत — ${line("5m", r5)} | ${line("15m", r15)} | ${line("1h", r1h)}. ` +
        (worst === "good" ? "किसी TF पर साफ़ move — सही TF पर CE/PE लें, टाइट SL." : worst === "lottery" ? "coil बना है — सस्ता OTM छोटी size (बड़ा move आ सकता, high risk)." : "ज़्यादातर range/whipsaw — अभी buying से बचें, सिर्फ़ SL लगेगा।");
    } else if (has("range", "रेंज", "kis range", "kaha tak", "kahan tak", "band")) {
      headline = `${def.name}: आज की रेंज <b>${Math.round(dayLow)} – ${Math.round(dayHigh)}</b>, spot ${Math.round(spot)}${rangePos != null ? ` (रेंज के ${rangePos}% पर — ${rangeWhere})` : ""}. कल: PDH ${lv.pdh ?? "-"} / PDL ${lv.pdl ?? "-"}. ${adxV != null && adxV < 20 ? "ADX कमज़ोर → range-bound." : "ट्रेंड " + adxStrength + "."}`;
    } else if (has("takat", "ताक़त", "ताकत", "strength", "strong", "kitni jaan", "power", "momentum")) {
      headline = `${def.name}: ताक़त — ADX <b>${adxV != null ? r1(adxV) : "-"}</b> (${adxStrength}), +DI ${r1(plusDI || 0)} vs -DI ${r1(minusDI || 0)} → ${(plusDI || 0) >= (minusDI || 0) ? "ख़रीदार भारी (तेज़ी)" : "बिकवाली भारी (मंदी)"}. ${adxV != null && adxV >= 25 ? "मज़बूत trend — directional trade ठीक।" : adxV != null && adxV < 20 ? "कमज़ोर/range — buying से बचें।" : "trend बन रहा।"}`;
    } else if (has("when", "timing", "kab", "कब", "abhi", "अभी", "entry")) {
      headline = `${def.name}: टाइमिंग <b>${timing}</b> · ट्रेंड ${adxStrength}. ${timing.startsWith("READY") ? "शुरुआती स्टेज — entry का अच्छा समय।" : timing.startsWith("EXTENDED") ? "बहुत bhag chuka — pullback का इंतज़ार करें।" : "move चल रहा — टाइट स्टॉप के साथ ही।"}`;
    } else if (has("ce", "pe", "call", "put", "option", "kaun", "कौन")) {
      headline = opp && opp.premium != null
        ? `${def.name}: <b>${opp.strike} ${optType}</b> ~₹${Math.round(opp.premium)} (${dirWord}). टारगेट ₹${Math.round(opp.premiumTarget)}, स्टॉप ₹${Math.round(opp.premiumStop)}.`
        : `${def.name}: दिशा ${dirWord} → ${optType} side, पर अभी clean strike/premium नहीं।`;
    } else if (has("direction", "bull", "bear", "दिशा", "तेजी", "मंदी", "upar", "niche", "ऊपर", "नीचे")) {
      headline = `${def.name}: दिशा <b>${dirWord}</b> (conf ${conf}%), ट्रेंड ${adxStrength}. ${bull ? "Bank/index tailwind देखें।" : ""}`.trim();
    } else {
      // generic / full summary
      headline = `${def.name} (₹${Math.round(spot)}): <b>${dirWord}</b>, conf ${conf}%, ट्रेंड ${adxStrength}, टाइमिंग ${timing}.` +
        (opp && opp.tradeable && opp.premium != null ? ` Play: ${opp.strike} ${optType} ~₹${Math.round(opp.premium)}.` : "");
    }

    res.json({
      symbol, name: def.name, spot: Math.round(spot * 100) / 100, marketOpen: isTradingTimeIST(),
      question: q, answer: headline, bullets,
      data: {
        direction: dir, confidence: conf, adx: adxV != null ? r1(adxV) : null, adxStrength, timing,
        optionType: optType, strike: opp?.strike ?? null, premium: opp?.premium ?? null,
        target: opp?.premiumTarget ?? null, stop: opp?.premiumStop ?? null, tradeable: !!opp?.tradeable,
        support: lv.majorSupport ?? oi?.support ?? null, resistance: lv.majorResistance ?? oi?.resistance ?? null, pcr: oi?.pcr ?? null,
      },
      disclaimer: "Live data पर आधारित शैक्षणिक विश्लेषण — निवेश सलाह नहीं। स्टॉप ज़रूर लगाएँ।",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "ask failed" });
  }
});

// DAY S/R (hourly): for a date + index, how much price broke support/resistance
// (floor pivots + PDH/PDL) each hour, and the DELTA-ESTIMATED ATM option move.
// /api/day-sr?symbol=^NSEI&date=YYYY-MM-DD
router.get("/day-sr", async (req: Request, res: Response) => {
  const date = String(req.query.date || "").slice(0, 10);
  const symbol = String(req.query.symbol || "^NSEI");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Provide date=YYYY-MM-DD." });
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });
  try {
    const [c5, c15, daily] = await Promise.all([
      getCandlesCached(symbol, "5m").catch(() => []),
      getCandlesCached(symbol, "15m"),
      getDailyCached(symbol, 80),
    ]);
    const result = computeDaySr(symbol, def.name, c5, c15, daily, date);
    res.json({ generatedAt: Math.floor(Date.now() / 1000), ...result });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Day S/R failed." });
  }
});

// MORNING BACKTEST (9:15-11:00 IST, last N days): replays the signal logic with
// no lookahead on indices + F&O stocks and reports the directional win rate /
// reward-multiple. Option premium P&L is NOT backtestable (no historical chain);
// this validates whether the directional CALLS are right - the basis for the
// option / intraday trades. Cached 30 min (heavy).
router.get("/backtest/morning", async (req: Request, res: Response) => {
  const days = Math.max(5, Math.min(45, Number(req.query.days) || 30));
  const data = await cached(`bt-morning:${days}`, 30 * 60_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const indices = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
    const stocks = DEFAULT_SYMBOLS.filter((d) => d.type === "equity" && d.fno);
    const universe = [...indices, ...stocks];
    const fetchOne = async (def: SymbolDef) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const [c15, daily] = await Promise.all([
            getCandlesCached(def.symbol, "15m"),
            getDailyCached(def.symbol, 80),
          ]);
          return backtestMorning(def.symbol, def.name, def.type === "index", c15, daily, days);
        } catch { if (attempt === 0) await sleep(300); }
      }
      return null;
    };
    const BATCH = 5;
    const results: any[] = [];
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      results.push(...(await Promise.all(chunk.map(fetchOne))).filter(Boolean));
      if (i + BATCH < universe.length) await sleep(120);
    }
    // Overall aggregation.
    const allTrades = results.flatMap((r: any) => r.tradesList);
    const wins = allTrades.filter((t: any) => t.result === "WIN").length;
    const losses = allTrades.filter((t: any) => t.result === "LOSS").length;
    const flats = allTrades.filter((t: any) => t.result === "FLAT").length;
    const decided = wins + losses;
    const totalR = Math.round(allTrades.reduce((s: number, t: any) => s + t.rMultiple, 0) * 100) / 100;
    // Per-day win rate across the whole universe.
    const byDate = new Map<string, { w: number; l: number }>();
    for (const t of allTrades) {
      if (!byDate.has(t.date)) byDate.set(t.date, { w: 0, l: 0 });
      if (t.result === "WIN") byDate.get(t.date)!.w++;
      else if (t.result === "LOSS") byDate.get(t.date)!.l++;
    }
    const perDay = [...byDate.entries()].sort().map(([date, v]) => ({
      date, wins: v.w, losses: v.l, winRate: v.w + v.l ? Math.round((v.w / (v.w + v.l)) * 1000) / 10 : 0,
    }));
    const bySymbol = results
      .map((r: any) => ({ symbol: r.symbol, name: r.name, isIndex: r.isIndex, trades: r.trades, wins: r.wins, losses: r.losses, flats: r.flats, winRate: r.winRate, avgR: r.avgR, totalR: r.totalR }))
      .sort((a: any, b: any) => b.totalR - a.totalR);
    return {
      overall: { trades: allTrades.length, wins, losses, flats, winRate: decided ? Math.round((wins / decided) * 1000) / 10 : 0, totalR, avgR: allTrades.length ? Math.round((totalR / allTrades.length) * 100) / 100 : 0 },
      bySymbol, perDay,
    };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), days, window: "09:15-11:00 IST", ...data,
    disclaimer:
      "DIRECTIONAL backtest of the signal logic in the 9:15-11:00 window, no lookahead, ATR target/stop, one trade/symbol/day. " +
      "Option premium P&L is NOT included (no historical option chain data exists) - this measures whether the directional calls " +
      "are right, which is the basis for the option & intraday trades. Reward:risk is fixed at " + (0.5 / 0.4).toFixed(2) + ":1.",
  });
});

// 1-HOUR CANDLE BREAKOUT proximity: how close spot is to CROSSING the last
// COMPLETED 1h candle's high (top → bullish/CE) or low (bottom → bearish/PE).
// "imminent" (flash) when within a small % or already crossed. Predicts the
// break of the prior hour's range.
function computeHourBreak(symbol: string, name: string, c60: any[]): any | null {
  if (!c60 || c60.length < 3) return null;
  const prev = c60[c60.length - 2]; // last COMPLETED 1h candle (the last bar is still forming)
  const cur = c60[c60.length - 1];
  const spot = cur.close;
  const hi = prev.high, lo = prev.low;
  if (!spot || !hi || !lo || hi <= lo) return null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let crossed: "up" | "down" | null = null;
  if (spot >= hi) crossed = "up"; else if (spot <= lo) crossed = "down";
  const distTopPct = r2((Math.abs(hi - spot) / spot) * 100);
  const distBotPct = r2((Math.abs(spot - lo) / spot) * 100);
  const nearest: "top" | "bottom" = distTopPct <= distBotPct ? "top" : "bottom";
  const nearestPct = Math.min(distTopPct, distBotPct);
  const nearestPts = r2(nearest === "top" ? hi - spot : spot - lo);
  // 1-HOUR Support / Resistance: the recent 1h swing zone (last ~8 completed 1h
  // candles) — resistance = highest high, support = lowest low. Both on the 1h clock.
  const look = c60.slice(Math.max(0, c60.length - 9), c60.length - 1);
  const resistance1h = look.length ? r2(Math.max(...look.map((c: any) => c.high))) : r2(hi);
  const support1h = look.length ? r2(Math.min(...look.map((c: any) => c.low))) : r2(lo);
  return {
    symbol, name, spot: r2(spot), hourHigh: r2(hi), hourLow: r2(lo),
    support1h, resistance1h,
    distTopPts: r2(hi - spot), distTopPct, distBotPts: r2(spot - lo), distBotPct,
    nearest, nearestPct, nearestPts,
    direction: nearest === "top" ? "Bullish" : "Bearish",
    optionType: nearest === "top" ? "CE" : "PE",
    crossed,
    imminent: crossed == null && nearestPct <= 0.12,
    late: crossed != null,
  };
}

// NEXT-1-HOUR OUTLOOK: reads the SAME picture as the chart (EMA21/EMA50 + session
// VWAP + RSI14 on the 15m clock, plus ADX/DI) and gives a direction call for the
// coming hour — confidence, expected range and the key levels to watch.
function computeHourOutlook(symbol: string, name: string, c15: any[], c60: any[]): any | null {
  if (!c15 || c15.length < 40) return null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const closes = c15.map((x) => x.close);
  const price = closes[closes.length - 1];
  if (!price) return null;
  const e21ser = ema(closes, 21);
  const e21 = last(e21ser);
  const e50 = last(ema(closes, 50));
  const vw = last(vwap(c15));
  const rsiV = last(rsi(closes, 14));
  const dm = adx(c15, 14);
  const adxV = last(dm.adx) ?? 0;
  const pDI = last(dm.plusDI) ?? 0;
  const mDI = last(dm.minusDI) ?? 0;
  const e21prev = e21ser[e21ser.length - 5] ?? e21; // EMA21 slope over ~1 hour
  const slopeUp = e21 != null && e21prev != null && e21 > e21prev;
  const slopeDn = e21 != null && e21prev != null && e21 < e21prev;

  let score = 0; const reasons: string[] = [];
  const aboveVwap = vw != null && price > vw;
  const belowVwap = vw != null && price < vw;
  if (aboveVwap) { score += 22; reasons.push("VWAP के ऊपर (ख़रीदार भारी)"); }
  else if (belowVwap) { score -= 22; reasons.push("VWAP के नीचे (बिकवाली भारी)"); }
  if (e21 != null && e50 != null) {
    if (price > e21 && e21 > e50) { score += 24; reasons.push("EMA21>EMA50 व भाव दोनों के ऊपर (तेज़ी structure)"); }
    else if (price < e21 && e21 < e50) { score -= 24; reasons.push("EMA21<EMA50 व भाव दोनों के नीचे (मंदी structure)"); }
    else if (price > e21 && price > e50) { score += 10; reasons.push("भाव EMAs के ऊपर"); }
    else if (price < e21 && price < e50) { score -= 10; reasons.push("भाव EMAs के नीचे"); }
    else reasons.push("EMAs के बीच (mixed)");
  }
  if (rsiV != null) {
    if (rsiV >= 55) score += 12; else if (rsiV <= 45) score -= 12;
    reasons.push(rsiV >= 70 ? `RSI ${Math.round(rsiV)} (overbought — सावधानी)` : rsiV <= 30 ? `RSI ${Math.round(rsiV)} (oversold — सावधानी)` : `RSI ${Math.round(rsiV)}`);
  }
  const diBull = pDI >= mDI;
  if (adxV >= 20) { score += diBull ? 14 : -14; reasons.push(`ADX ${Math.round(adxV)} (${diBull ? "+DI भारी, तेज़ी" : "-DI भारी, मंदी"})`); }
  else reasons.push(`ADX ${Math.round(adxV)} (कमज़ोर trend)`);
  if (slopeUp) score += 6; else if (slopeDn) score -= 6;

  const strong = adxV >= 22;
  let direction: "Bullish" | "Bearish" | "Range";
  if (!strong && Math.abs(score) < 26) direction = "Range";
  else direction = score > 0 ? "Bullish" : score < 0 ? "Bearish" : "Range";
  const confidence = Math.max(0, Math.min(100, Math.round(Math.abs(score) + (strong ? 12 : 0))));

  const atr15 = last(atr(c15, 14)) ?? price * 0.003;
  const hourMove = r2(atr15 * 2); // ~1h swing (≈4×15m bars)
  const upTarget = r2(price + hourMove), dnTarget = r2(price - hourMove);
  const look = c60 && c60.length >= 3 ? c60.slice(Math.max(0, c60.length - 9), c60.length - 1) : [];
  const resistance1h = look.length ? r2(Math.max(...look.map((c: any) => c.high))) : null;
  const support1h = look.length ? r2(Math.min(...look.map((c: any) => c.low))) : null;

  const dirWord = direction === "Bullish" ? "तेज़ी ▲" : direction === "Bearish" ? "मंदी ▼" : "Range ◆";
  const optionType = direction === "Bullish" ? "CE" : direction === "Bearish" ? "PE" : "—";
  const scenario = direction === "Range"
    ? `अगले 1 घंटे: साफ़ दिशा नहीं (Range) — ${support1h ?? dnTarget} – ${resistance1h ?? upTarget} के बीच; breakout का इंतज़ार, अभी buying से बचें।`
    : direction === "Bullish"
    ? `अगले 1 घंटे: तेज़ी ▲ का झुकाव — ${resistance1h ?? upTarget} तोड़ा तो ${upTarget} तक; नीचे ${support1h ?? dnTarget} सपोर्ट (टूटा तो सोच बदलें).`
    : `अगले 1 घंटे: मंदी ▼ का झुकाव — ${support1h ?? dnTarget} टूटा तो ${dnTarget} तक; ऊपर ${resistance1h ?? upTarget} रुकावट (पार हुआ तो सोच बदलें).`;

  return {
    symbol, name, price: r2(price),
    ema21: e21 != null ? r2(e21) : null, ema50: e50 != null ? r2(e50) : null,
    vwap: vw != null ? r2(vw) : null, rsi: rsiV != null ? Math.round(rsiV) : null,
    adx: Math.round(adxV), plusDI: Math.round(pDI), minusDI: Math.round(mDI),
    aboveVwap, aboveEma21: e21 != null ? price > e21 : null, aboveEma50: e50 != null ? price > e50 : null,
    direction, optionType, confidence, score,
    expectedRange: { up: upTarget, down: dnTarget, movePts: hourMove },
    support1h, resistance1h, reasons, scenario,
  };
}

// MARKET CONDITION per timeframe — classify into one of four states so an OPTION
// BUYER knows how careful to be: Range-bound (dead), Whipsaw (only hits SL),
// Good move (clean directional), or Lottery (tightly coiled — a big burst pending).
function classifyRegime(c: any[]): { state: string; emoji: string; label: string; note: string; dir: string } | null {
  if (!c || c.length < 30) return null;
  const closes = c.map((x) => x.close);
  const dm = adx(c, 14);
  const adxV = last(dm.adx) ?? 0;
  const pDI = last(dm.plusDI) ?? 0;
  const mDI = last(dm.minusDI) ?? 0;
  const dir = pDI >= mDI ? "तेज़ी ▲" : "मंदी ▼";
  // Volatility contraction (squeeze) via ATR-now vs its recent average.
  const atrArr = atr(c, 14);
  const atrNow = last(atrArr) ?? 0;
  const w = atrArr.slice(Math.max(0, atrArr.length - 25), atrArr.length - 1).filter((x): x is number => x != null);
  const atrAvg = w.length ? w.reduce((s, v) => s + v, 0) / w.length : atrNow;
  const squeeze = atrAvg > 0 ? atrNow / atrAvg : 1; // < ~0.7 = coiled
  // Whipsaw = many EMA9/EMA21 crossovers in the last ~12 bars (choppy, SL-hunting).
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  let crosses = 0;
  for (let i = Math.max(1, closes.length - 12); i < closes.length; i++) {
    const a0 = e9[i - 1], b0 = e21[i - 1], a1 = e9[i], b1 = e21[i];
    if (a0 == null || b0 == null || a1 == null || b1 == null) continue;
    if (Math.sign(a0 - b0) !== Math.sign(a1 - b1)) crosses++;
  }
  if (adxV >= 23) return { state: "good", emoji: "🟢", label: `अच्छा move तैयार (${dir})`, note: "ले सकते हैं — ATM/ITM, टाइट SL", dir };
  if (squeeze < 0.7 && adxV < 22) return { state: "lottery", emoji: "🎰", label: "लॉटरी move (coil — बड़ा धमाका बाक़ी)", note: "सस्ता OTM, छोटी size (high risk/high reward)", dir };
  if (adxV < 20 && crosses >= 3) return { state: "whipsaw", emoji: "⚠️", label: "Whipsaw — सिर्फ़ SL लगेगा", note: "मत लो — बार-बार SL हिट होगा", dir };
  return { state: "range", emoji: "🔴", label: "Range-bound (सुस्त)", note: "मत लो — theta खा जाएगा", dir };
}

// BEST LOW-DECAY option to buy now for a direction: among the ATM + a few ITM
// strikes (ITM has lower theta%), pick the one with a live premium and the LOWEST
// theta%/day (least time decay). ITM = strikes below spot for CE, above for PE.
function bestLowDecayOption(oi: any, spot: number, direction: "Bullish" | "Bearish"): any | null {
  const bull = direction === "Bullish";
  const rows = oi?.topStrikes || [];
  if (!rows.length || !spot) return null;
  let atmIdx = 0;
  for (let i = 0; i < rows.length; i++) if (Math.abs(rows[i].strike - spot) < Math.abs(rows[atmIdx].strike - spot)) atmIdx = i;
  const cands: any[] = [];
  for (let d = 0; d <= 3; d++) {
    const idx = bull ? atmIdx - d : atmIdx + d; // step toward ITM
    const s = rows[idx];
    if (!s) continue;
    const ltp = bull ? s.ceLtp : s.peLtp;
    const thetaRaw = bull ? s.ceTheta : s.peTheta;
    if (ltp == null || ltp <= 0) continue;
    const thetaPct = thetaRaw != null ? (Math.abs(thetaRaw) / ltp) * 100 : null;
    cands.push({ strike: s.strike, ltp, thetaPct, moneyness: s.strike === rows[atmIdx].strike ? "ATM" : "ITM" });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (a.thetaPct ?? 99) - (b.thetaPct ?? 99)); // least decay first
  const best = cands[0];
  const decayLevel = best.thetaPct == null ? "n/a" : best.thetaPct < 5 ? "Low" : best.thetaPct < 12 ? "Moderate" : "High";
  return {
    optStrike: best.strike, optType: bull ? "CE" : "PE", optMoneyness: best.moneyness,
    optPremium: Math.round(best.ltp * 100) / 100,
    optThetaPct: best.thetaPct == null ? null : Math.round(best.thetaPct * 10) / 10,
    decayLevel,
  };
}

function istStamp(t: number) {
  return new Date(t * 1000 + 19800000);
}
function sessionChartFacts(c15: any[] | undefined, c5: any[] | undefined) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const dayOf = (c: any) => istStamp(c.time).toISOString().slice(0, 10);
  const sorted = [...(c15 || [])].sort((a, b) => a.time - b.time);
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  let session = sorted.filter((c) => dayOf(c) === today);
  if (!session.length && sorted.length) {
    const lastDay = dayOf(sorted[sorted.length - 1]);
    session = sorted.filter((c) => dayOf(c) === lastDay);
  }
  const first = session[0];
  const sod15High = first ? r2(first.high) : null;
  const sod15Low = first ? r2(first.low) : null;
  const day15High = session.length ? r2(Math.max(...session.map((c) => c.high))) : null;
  const day15Low = session.length ? r2(Math.min(...session.map((c) => c.low))) : null;
  const last5 = detectCandlePattern([...(c5 || [])].sort((a, b) => a.time - b.time) as any);
  const good = last5.strength >= 0.6 && last5.pattern !== "None";
  return {
    sod15High, sod15Low, day15High, day15Low,
    candle5m: last5.pattern,
    candle5mBias: last5.bias,
    candle5mGood: good,
    candle5mReason: last5.reason,
    candle5mStrength: last5.strength,
  };
}

/** ATM call vs put theta as % of premium — warn the hotter (faster decaying) side. */
function atmDecaySides(oi: any, spot: number): {
  ceThetaPct: number | null; peThetaPct: number | null; decayHot: "CE" | "PE" | "even" | null; decayWarn: string | null;
} {
  const rows: any[] = oi?.topStrikes || [];
  if (!rows.length || !spot) return { ceThetaPct: null, peThetaPct: null, decayHot: null, decayWarn: null };
  let atm = rows[0];
  for (const s of rows) if (Math.abs(s.strike - spot) < Math.abs(atm.strike - spot)) atm = s;
  const ceL = Number(atm.ceLtp), peL = Number(atm.peLtp);
  const ceT = atm.ceTheta != null && ceL > 0 ? (Math.abs(Number(atm.ceTheta)) / ceL) * 100 : null;
  const peT = atm.peTheta != null && peL > 0 ? (Math.abs(Number(atm.peTheta)) / peL) * 100 : null;
  const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  const ceThetaPct = r1(ceT), peThetaPct = r1(peT);
  if (ceThetaPct == null && peThetaPct == null) return { ceThetaPct, peThetaPct, decayHot: null, decayWarn: null };
  if (ceThetaPct != null && peThetaPct != null) {
    if (ceThetaPct > peThetaPct * 1.12) {
      return { ceThetaPct, peThetaPct, decayHot: "CE", decayWarn: `CE decays faster (ATM θ ${ceThetaPct}%/d vs PE ${peThetaPct}%/d) — CALL bleeds more if spot is flat.` };
    }
    if (peThetaPct > ceThetaPct * 1.12) {
      return { ceThetaPct, peThetaPct, decayHot: "PE", decayWarn: `PE decays faster (ATM θ ${peThetaPct}%/d vs CE ${ceThetaPct}%/d) — PUT bleeds more if spot is flat.` };
    }
    return { ceThetaPct, peThetaPct, decayHot: "even", decayWarn: `ATM θ similar — CE ${ceThetaPct}%/d · PE ${peThetaPct}%/d.` };
  }
  const only = ceThetaPct != null ? "CE" : "PE";
  const v = ceThetaPct ?? peThetaPct;
  return { ceThetaPct, peThetaPct, decayHot: only as "CE" | "PE", decayWarn: `ATM ${only} θ ~${v}%/d.` };
}

/** Separate from leftover Top Pick: directional + early + win-case. LATE/extended = skip. */
function winCaseScore(r: any): number {
  if (!r || r.warn) return 0;
  if (r.late || r.runState === "Range" || r.timing === "EXTENDED") return 0;
  if (r.progressPct != null && r.progressPct >= 68) return 0;
  if (r.runState === "Stalling") return 0;
  const want = r.optionType === "CE" ? 1 : r.optionType === "PE" ? -1 : 0;
  const fast = (r.tfSignals || []).find((t: any) => t.tf === "5m");
  if (want && fast?.dir && fast.dir !== want) return 0;
  if (r.adx != null && r.adx < 18) return 0;
  if (r.dmAgree === false) return 0;
  if (r.runBarsAgo != null && r.runBarsAgo > 3) return 0;
  let s = 30;
  if (r.timing === "READY TO MOVE") s += 38;
  else if (r.timing === "UNDERWAY") s += 12;
  if (r.runState === "Running") s += 28;
  if (r.runBarsAgo != null && r.runBarsAgo <= 1) s += 16;
  if (r.dmTradeable) s += 14;
  if (r.remainingPct != null) s += Math.min(22, r.remainingPct * 10);
  if ((r.alignment || 0) >= 75) s += 10;
  else if ((r.alignment || 0) >= 50) s += 4;
  if (r.candle5mGood && r.candle5mBias === want) s += 8;
  if (r.decaySideWarn) s -= 18;
  return Math.round(s);
}
function slimWinCase(r: any, score: number) {
  const t = r.runStartAt ? new Date(r.runStartAt * 1000 + 19800000).toISOString().slice(11, 16) : null;
  const why = r.timing === "READY TO MOVE"
    ? "Just turning — best time, not chasing."
    : (r.runBarsAgo != null && r.runBarsAgo <= 1 ? "Fresh extreme now — directional, not delayed." : "Aligned 5m+15m with room left.");
  return {
    symbol: r.symbol, name: r.name, optionType: r.optionType, direction: r.direction,
    timing: r.timing, runState: r.runState, remainingPct: r.remainingPct,
    runStartAt: r.runStartAt, runStartClock: t, runBarsAgo: r.runBarsAgo,
    strike: r.optStrike ?? null, premium: r.optPremium ?? null,
    winScore: score, why,
  };
}
function pickBestWin(rows: any[] | undefined) {
  let best: any = null, bestS = 0;
  for (const r of rows || []) {
    const s = winCaseScore(r);
    if (s > bestS) { bestS = s; best = r; }
  }
  return best && bestS >= 55 ? slimWinCase(best, bestS) : null;
}
function attachBestCase(byTf: any, byTfIndex: any) {
  const index = pickBestWin(byTfIndex?.["15m"]) || pickBestWin(byTfIndex?.["5m"]);
  const stock = pickBestWin(byTf?.["15m"]) || pickBestWin(byTf?.["5m"]);
  return {
    index, stock,
    wait: !index && !stock ? "No clean directional win-case yet — WAIT. Do not chase a late / spent move." : null,
  };
}

function mindRowsFromPicks(picks: any[], tf: Tf = "15m") {
  return picks.map((p) => {
    const ts = (p.tfSignals || []).find((t: any) => t.tf === tf);
    if (!ts || ts.dir === 0) return null;
    const exp = p.expectedDayMovePct;
    const movedPct = p.todayMoveRawPct == null ? null : Math.round((ts.dir > 0 ? p.todayMoveRawPct : -p.todayMoveRawPct) * 100) / 100;
    const remainingPct = exp != null && movedPct != null ? Math.round(Math.max(0, exp - Math.max(0, movedPct)) * 100) / 100 : null;
    const progressPct = exp != null && exp > 0 && movedPct != null ? Math.round(Math.min(100, Math.max(0, (Math.max(0, movedPct) / exp) * 100))) : null;
    const fast = (p.tfSignals || []).find((t: any) => t.tf === "5m");
    const warn = fast && fast.dir && fast.dir !== ts.dir ? "5m against" : null;
    const adxV = ts.adx, plusDI = ts.plusDI, minusDI = ts.minusDI;
    const dmDir = adxV != null && plusDI != null && minusDI != null ? (plusDI >= minusDI ? "Bullish" : "Bearish") : null;
    const dmAgree = dmDir != null ? dmDir === (ts.dir > 0 ? "Bullish" : "Bearish") : null;
    const late = ts.runState === "Range" || ts.timing === "EXTENDED" || (progressPct != null && progressPct >= 82);
    return {
      symbol: p.symbol, name: p.name, optionType: ts.dir > 0 ? "CE" : "PE",
      direction: ts.dir > 0 ? "Bullish" : "Bearish", timing: ts.timing, runState: ts.runState,
      remainingPct, progressPct, warn, late, adx: adxV, dmAgree,
      dmTradeable: !!(adxV != null && adxV >= 25 && dmAgree),
      runBarsAgo: ts.runBarsAgo, runStartAt: ts.runStartAt, alignment: p.alignment,
      candle5mGood: !!p.candle5mGood, candle5mBias: p.candle5mBias ?? 0, tfSignals: p.tfSignals,
    };
  }).filter(Boolean);
}

async function scanMindBestCase() {
  const idx = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  const stocks: SymbolDef[] = [];
  const seen = new Set<string>();
  for (const d of DEFAULT_SYMBOLS) {
    if (d.type === "equity" && d.fno && !seen.has(d.symbol) && stocks.length < 8) {
      seen.add(d.symbol); stocks.push(d);
    }
  }
  const one = async (def: SymbolDef) => {
    try {
      const byTf: any = {};
      await Promise.all((["5m", "15m"] as Interval[]).map(async (tf) => {
        try { byTf[tf] = await getCandlesCached(def.symbol, tf); } catch { byTf[tf] = []; }
      }));
      const pick = computeTopPick(def.symbol, def.name, def, byTf, null);
      if (pick) Object.assign(pick, sessionChartFacts(byTf["15m"], byTf["5m"]));
      return pick;
    } catch { return null; }
  };
  const allIndex = (await Promise.all(idx.map(one))).filter(Boolean);
  const all = (await Promise.all(stocks.map(one))).filter(Boolean);
  return attachBestCase({ "15m": mindRowsFromPicks(all) }, { "15m": mindRowsFromPicks(allIndex) });
}

// Multi-timeframe TOP PICKS: rank F&O stocks by a probability built from 5m/15m/
// 1h/1d signal alignment; classify each for intraday vs options with reasons.
// NEXT-1-HOUR OUTLOOK for the F&O indices — chart-style read (EMA21/EMA50/VWAP/
// RSI + ADX) → direction call + expected range + key levels. Cached 60s.
router.get("/hour-outlook", async (_req: Request, res: Response) => {
  try {
    const data = await cached("hour-outlook", 60_000, async () => {
      const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno).slice(0, 4);
      const out: any[] = [];
      for (const def of defs) {
        try {
          const [c15, c60] = await Promise.all([
            getCandlesCached(def.symbol, "15m"),
            getCandlesCached(def.symbol, "60m"),
          ]);
          const o = computeHourOutlook(def.symbol, def.name, c15 as any, c60 as any);
          if (o) out.push(o);
        } catch (e) { console.error(`[api] skipped ${def.symbol}:`, e instanceof Error ? e.message : e); }
      }
      return { generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), outlook: out, disclaimer: DISCLAIMER };
    });
    res.json(data);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "hour-outlook failed" });
  }
});

// OI COMMAND screen: one F&O symbol's live OI-CHANGE read → direction + move
// score, best option setup (strike/LTP/OI%/vol/premium%), opportunity tracker
// (captured/pending), and trade management (entry/target/SL/zones). Cached 15s.
// Latest closed paper trade (today) per mode for a symbol → fixed-format HIT/MISS review line.
// Reads ONLY existing paper-trade state (getPaperSummary().closed); no new tracking fields.
function tradeReviewsForSymbol(symbol: string): { directional?: string; scalp?: string } {
  try {
    const s: any = getPaperSummary();
    const closed: any[] = (s && s.closed) || [];
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const isToday = (t: any) => new Date(((t.exitEpoch || 0) * 1000) + 19800000).toISOString().slice(0, 10) === today;
    const latest = (scalp: boolean) =>
      closed
        .filter((t) => t.symbol === symbol && !!t.scalp === scalp && isToday(t))
        .sort((a, b) => (b.exitEpoch || 0) - (a.exitEpoch || 0))[0] || null;
    const out: { directional?: string; scalp?: string } = {};
    const dir = latest(false); if (dir) out.directional = formatTradeReview(dir);
    const sc = latest(true); if (sc) out.scalp = formatTradeReview(sc);
    return out;
  } catch { return {}; }
}

// Per-session intraday hi/lo of the ATM CALL and PUT LTP (display-only; resets daily).
const _optDayRange = new Map<string, { date: string; callHi: number | null; callLo: number | null; putHi: number | null; putLo: number | null }>();
function trackOptDayRange(symbol: string, call: number | null, put: number | null) {
  const date = istDateStr();
  let r = _optDayRange.get(symbol);
  if (!r || r.date !== date) { r = { date, callHi: null, callLo: null, putHi: null, putLo: null }; _optDayRange.set(symbol, r); }
  if (call != null && call > 0) { r.callHi = r.callHi == null ? call : Math.max(r.callHi, call); r.callLo = r.callLo == null ? call : Math.min(r.callLo, call); }
  if (put != null && put > 0) { r.putHi = r.putHi == null ? put : Math.max(r.putHi, put); r.putLo = r.putLo == null ? put : Math.min(r.putLo, put); }
  return { callHi: r.callHi, callLo: r.callLo, putHi: r.putHi, putLo: r.putLo };
}

// ============================ Macro Setup (NIFTY only, display-only) ============================
// Orchestrates backend/paper/ext/macroSetup.ts's pure functions with data this
// route already knows how to fetch (getCandlesCached). ADVISORY ONLY: attached
// to the OI-Command payload for the dashboard to show; never read by
// oiGridToIdea/recommendOiTrades, so it cannot veto or size any trade — that
// stays an open decision (hard-gate vs. vote) for you to make later. Cached 3
// min (global markets + sector rotation don't need per-15s freshness), and
// every fetch is try/caught so a Yahoo hiccup or a thin quote never breaks the
// main OI-Command payload.
const MACRO_SETUP_TTL_MS = 3 * 60_000;
let _macroSetupCache: { ts: number; v: any } | null = null;
let _macroSetupRefreshing = false;

async function computeNiftyMacroSetupCompute(): Promise<any> {
  try {
    const global = classifyGlobalMarketBias(await fetchGlobalMarketReads());

    const symbols = Array.from(new Set<string>([
      "^NSEBANK", ...NIFTY_IT_MAJORS, ...Object.values(NIFTY_SECTOR_PROXIES).flat(),
    ]));
    const pctBySymbol: Record<string, number | null> = {};
    await Promise.all(symbols.map(async (sym) => {
      try {
        const interval = sym === "^NSEBANK" || NIFTY_IT_MAJORS.includes(sym) ? "5m" : "15m";
        const candles = await getCandlesCached(sym, interval as any);
        pctBySymbol[sym] = pctChangeSinceOpen(candles as any);
      } catch { pctBySymbol[sym] = null; }
    }));

    const bankNiftyPctSinceOpen = pctBySymbol["^NSEBANK"] ?? null;
    const itMajorsPctSinceOpen = computeBasketPct(pctBySymbol, NIFTY_IT_MAJORS);
    const sectorLeaderboard = rankSectors(pctBySymbol, NIFTY_SECTOR_PROXIES);

    return computeNiftyMacroSetup({ global, sectorLeaderboard, bankNiftyPctSinceOpen, itMajorsPctSinceOpen });
  } catch (e: any) {
    return { votes: [], agree: 0, against: 0, bias: 0, topSector: null, notes: [`macro setup unavailable: ${e?.message || e}`] };
  }
}

// Stale-while-revalidate instead of a blocking cache: a request never waits on
// this (advisory, display-only) computation once it has served once. A stale
// hit is returned immediately and a background refresh is kicked off (not
// awaited) so the NEXT request picks up fresh data - only the very first call
// after server start has nothing to serve yet and pays the real latency once.
async function computeNiftyMacroSetupLive(): Promise<any> {
  const now = Date.now();
  if (_macroSetupCache) {
    if (now - _macroSetupCache.ts >= MACRO_SETUP_TTL_MS && !_macroSetupRefreshing) {
      _macroSetupRefreshing = true;
      computeNiftyMacroSetupCompute()
        .then((v) => { _macroSetupCache = { ts: Date.now(), v }; })
        .catch(() => { /* keep serving the last good value on a failed refresh */ })
        .finally(() => { _macroSetupRefreshing = false; });
    }
    return _macroSetupCache.v;
  }
  const v = await computeNiftyMacroSetupCompute();
  _macroSetupCache = { ts: Date.now(), v };
  return v;
}

// Stashes the candles/OI buildOiCommand already fetched onto its returned
// payload as a NON-enumerable property, so extForOiPayload can reuse them
// (via assembleExtInputs's `pre` param) instead of re-fetching the same
// symbol's candles a second time under a different cache key. Non-enumerable
// means JSON.stringify (res.json) never sends this to the client - it only
// rides along in-process for the one call site that reads it.
function withRawExt(payload: any, raw: { c5?: any[]; c15?: any[]; daily?: any[]; oi?: OiAnalysis | null }): any {
  try { Object.defineProperty(payload, "__rawExt", { value: raw, enumerable: false }); } catch { /* best-effort */ }
  return payload;
}

async function buildOiCommand(def: SymbolDef): Promise<any> {
      const feed0 = syncSessionProvider();
      // OI-chain fetch and candle fetches don't depend on each other, but used
      // to run one after the other (oi() fully finishing before loadBars() even
      // started) - kicking both off together lets them share the Groww
      // throttle's queue concurrently instead of serially, which is most of
      // where "dashboard feels slow after login" comes from. The per-request
      // Groww rate-limit pacing (growwProvider.ts) is untouched - this only
      // removes an unnecessary extra wait that wasn't protecting anything.
      const oiPromise = getOiCached(def) as Promise<OiAnalysis>;
      const loadBars = async () => {
        const [c15arr, c5arr, c60arr, dailyArr] = await Promise.all([
          getCandlesCached(def.symbol, "15m").catch(() => [] as any[]),
          getCandlesCached(def.symbol, "5m").catch(() => [] as any[]),
          getCandlesCached(def.symbol, "60m").catch(() => [] as any[]),
          getDailyCached(def.symbol, 40).catch(() => [] as any[]),
        ]);
        return { c5arr: c5arr as any[], c15arr: c15arr as any[], c60arr: c60arr as any[], dailyArr: dailyArr as any[] };
      };
      const barsPromise = loadBars();
      const oi = await oiPromise;
      if (!oi || !oi.available || oi.underlying == null) {
        const { c5arr, c15arr, c60arr, dailyArr } = await barsPromise;
        const snap = latestSnapshot(def.symbol);
        const lastBar = (c15arr.length ? c15arr : c5arr.length ? c5arr : c60arr).slice(-1)[0];
        const lastBarDate = oiBarIstDate(lastBar);
        // Groww-style volume indicator (works after hours on Groww historical bars too).
        // Opening-range from the first 15m bar of the latest session drives the
        // breakout read; PDH/PDL omitted here (no daily load on this path).
        const fbSpot = lastBar ? lastBar.close : (snap?.underlying ?? 0);
        let fbOrbHigh: number | null = null, fbOrbLow: number | null = null;
        if (c15arr.length) {
          const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
          const minOf = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
          const day = dayOf(c15arr[c15arr.length - 1].time);
          const todays = c15arr.filter((x: any) => dayOf(x.time) === day).sort((a: any, b: any) => a.time - b.time);
          const orBars = todays.filter((x: any) => { const m = minOf(x.time); return m >= 9 * 60 + 15 && m < 9 * 60 + 30; });
          const use = orBars.length ? orBars : todays.slice(0, 1);
          if (use.length) {
            fbOrbHigh = Math.round(Math.max(...use.map((x: any) => x.high)) * 100) / 100;
            fbOrbLow = Math.round(Math.min(...use.map((x: any) => x.low)) * 100) / 100;
          }
        }
        const fbVolume = computeOiVolume(c5arr as any, {
          spot: fbSpot, orbHigh: fbOrbHigh, orbLow: fbOrbLow, pdh: null, pdl: null, oiDirection: "FLAT",
        });
        const tot = (snap?.totalCeOi || 0) + (snap?.totalPeOi || 0);
        const putPct = tot ? Math.round((snap!.totalPeOi / tot) * 100) : null;
        const callPct = tot ? Math.round((snap!.totalCeOi / tot) * 100) : null;
        const bulletin = buildMoveBulletin({
          c5: c5arr, c15: c15arr, c60: c60arr,
          oiDir: "FLAT", fut: null, pcr: snap?.pcr ?? null,
          hourDir: (() => {
            try { return computeHourOutlook(def.symbol, def.name, c15arr as any, c60arr as any)?.direction ?? null; }
            catch { return null; }
          })(),
        });
        const moodReview = reviewMoodFromFile(
          def.symbol,
          new Date(Date.now() + 19800000).toISOString().slice(0, 10),
          bulletin
        );
        const oiSource = snap ? "snapshot" : "none";
        const quality = oiQuality({
          marketOpen: feed0.marketOpen, provider: feed0.provider, oiSource,
          hasPremiums: false, hasBaseline: false, stale: true,
          excelRows: moodReview.rows || 0, bars: c15arr.length, lastBarDate,
        });
        return withRawExt({
          available: true,
          oiSource,
          symbol: def.symbol,
          name: def.name,
          spot: lastBar ? Math.round(lastBar.close * 100) / 100 : (snap?.underlying ?? null),
          asOf: Math.floor(Date.now() / 1000),
          oiDirection: "FLAT",
          oiVerdict: "Neutral",
          oiMoveScore: 0,
          pcr: snap?.pcr ?? null,
          maxPain: snap?.maxPain ?? null,
          lastBarDate,
          message: feed0.marketOpen
            ? (oi?.message || "Groww OI chain not ready (timeout / rate-limit). Candles still refresh.")
            : (snap
              ? `After hours: Groww historical bars + last session OI snapshot ${snap.date} (PCR/walls). Full chain Excel starts 09:15 IST.`
              : "After hours: Groww historical bars. No saved Groww chain — Excel + last chain fill Mon–Fri 09:15–15:30 IST."),
          bulletin,
          moodReview,
          quality,
          refresh: oiRefreshMeta(def.symbol, { lastBarDate }),
          volume: fbVolume,
          levels: { orbHigh: fbOrbHigh, orbLow: fbOrbLow, pdh: null, pdl: null },
          setup: { action: "WAIT — no live OI chain", optionType: "—" },
          walls: snap ? {
            bestR: snap.resistance != null ? { strike: snap.resistance, side: "CE", oi: snap.totalCeOi } : null,
            bestS: snap.support != null ? { strike: snap.support, side: "PE", oi: snap.totalPeOi } : null,
            immR: null, immS: null,
            putPct, callPct, maxPain: snap.maxPain,
            fever: `Last session ${snap.date} snapshot — not a live ladder`,
            ladder: [],
          } : {},
          recommendation: {},
          correlate: {},
          lesson: { scenario: snap
            ? `No live chain. PCR ${snap.pcr} · S ${snap.support} / R ${snap.resistance} from ${snap.date}. 15m/1h mood is Groww historical vs Excel.`
            : "No Groww OI this print. 15m/1h mood is from Groww historical bars vs last Excel row." },
          stale: true,
          hasBaseline: false,
        }, { c5: c5arr, c15: c15arr, daily: dailyArr, oi: null });
      }
      recordOiBaseline(def.symbol, oi); // ensure a day-baseline exists for %-change
      const oc = computeOiChange(def.symbol, def.name, def.type === "index" ? "index" : "equity", oi);
      if (!oc) return { available: false, message: "OI-change अभी compute नहीं हुआ।" };
      const spot = oi.underlying as number;
      const { c5arr, c15arr, c60arr, dailyArr } = await barsPromise;
      let atr15 = spot * 0.0015;
      try { const a = last(atr(c15arr as any, 14)); if (a) atr15 = a; } catch { /* fallback */ }
      let last5mDir: 1 | -1 | 0 = 0;
      if (c5arr && c5arr.length >= 2) {
        const a = c5arr[c5arr.length - 1].close, b = c5arr[c5arr.length - 2].close;
        last5mDir = a > b ? 1 : a < b ? -1 : 0;
      }
      const bullish = oc.oiVerdict === "Bullish";
      const bearish = oc.oiVerdict === "Bearish";
      const dir = bullish ? 1 : bearish ? -1 : 0;
      const expLow = Math.round(atr15 * 1.0), expHigh = Math.round(atr15 * 1.8);
      // Chosen strike = ATM; leg = CE (bullish) / PE (bearish).
      const atmStrike = oc.atmStrike ?? nearestStrike(spot, def);
      const atmRow = (oi.topStrikes || []).reduce((b: any, s: any) => (b == null || Math.abs(s.strike - atmStrike) < Math.abs(b.strike - atmStrike) ? s : b), null);
      const level = (oc.chain || []).find((l) => l.strike === atmStrike) || oc.best;
      const leg = level ? (bullish ? level.ce : level.pe) : null;
      const optionType = dir === 0 ? "—" : bearish ? "PE" : "CE";
      const ltp = dir === 0 ? null : (leg?.ltp ?? (bearish ? atmRow?.peLtp : atmRow?.ceLtp) ?? null);
      // Trade management off the option LTP.
      const r0 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
      const tgtLo = ltp != null ? r0(ltp * 1.20) : null;
      const tgtHi = ltp != null ? r0(ltp * 1.35) : null;
      const sl = ltp != null ? r0(ltp * 0.88) : null;
      const profitZone = ltp != null ? r0(ltp * 1.28) : null;
      const dangerLo = ltp != null ? r0(ltp * 0.92) : null;
      const dangerHi = ltp != null ? r0(ltp * 0.95) : null;
      // Invalidation on the underlying: CE → below PUT support; PE → above CALL resistance.
      const support = oc.maxPeBuildup?.strike ?? oi.support ?? null;
      const resistance = oc.maxCeBuildup?.strike ?? oi.resistance ?? null;
      const invalidation = bullish ? support : bearish ? resistance : null;
      // Opportunity tracker: signal = day OI baseline; captured = favourable move so far.
      const signalPrice = oc.baselineSpot ?? spot;
      const rawMove = Math.round((spot - signalPrice) * 100) / 100;
      const favMove = dir === 0 ? Math.abs(rawMove) : dir > 0 ? rawMove : -rawMove; // + = in the OI direction
      const captured = Math.max(0, Math.min(favMove, expHigh));
      const pending = Math.max(0, expHigh - captured);
      const capturedPct = expHigh > 0 ? Math.round((captured / expHigh) * 100) : 0;
      // Status: progressing & not invalidated → HOLD/MANAGE; neutral OI → WAIT.
      let status = "WAIT / NO EDGE", statusCls = "neu";
      if (dir !== 0) {
        const invalidated = invalidation != null && (bullish ? spot < invalidation : spot > invalidation);
        if (invalidated) { status = "AVOID / INVALIDATED"; statusCls = "down"; }
        else if (capturedPct >= 90) { status = "BOOK / TRAIL — move done"; statusCls = "up"; }
        else { status = "HOLD / MANAGE"; statusCls = "up"; }
      }
      // KEY LEVELS for Trade Management:
      // OI walls — strong = strike with the MOST OI (CE above spot = resistance,
      // PE below spot = support), weak = the 2nd-most. Plus opening-15m H/L and
      // previous-day H/L.
      const above = (oi.topStrikes || []).filter((s: any) => s.strike > spot).sort((a: any, b: any) => (b.ceOi || 0) - (a.ceOi || 0));
      const below = (oi.topStrikes || []).filter((s: any) => s.strike < spot).sort((a: any, b: any) => (b.peOi || 0) - (a.peOi || 0));
      const oiLvl = (r: any, side: "CE" | "PE") => r ? { strike: r.strike, oi: Math.round((side === "CE" ? r.ceOi : r.peOi) || 0) } : null;
      const strongResistance = oiLvl(above[0], "CE"), weakResistance = oiLvl(above[1], "CE");
      const strongSupport = oiLvl(below[0], "PE"), weakSupport = oiLvl(below[1], "PE");
      // Opening 15-min high/low (first 15m bar today) + previous-day high/low.
      let orbHigh: number | null = null, orbLow: number | null = null, pdh: number | null = null, pdl: number | null = null;
      const istDayOf = istDateOfSec;
      const istMinOf = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
      if (c15arr.length) {
        const today = istDayOf(c15arr[c15arr.length - 1].time);
        const todays = c15arr.filter((x: any) => istDayOf(x.time) === today).sort((a: any, b: any) => a.time - b.time);
        const orBars = todays.filter((x: any) => { const m = istMinOf(x.time); return m >= 9 * 60 + 15 && m < 9 * 60 + 30; });
        const use = orBars.length ? orBars : todays.slice(0, 1);
        if (use.length) {
          orbHigh = Math.round(Math.max(...use.map((x: any) => x.high)) * 100) / 100;
          orbLow = Math.round(Math.min(...use.map((x: any) => x.low)) * 100) / 100;
        }
      }
      try {
        const daily = dailyArr.length ? dailyArr : (await getDailyCached(def.symbol, 8)) as any[];
        const todayIso = c15arr.length ? istDayOf(c15arr[c15arr.length - 1].time) : istDateStr();
        let prev: any = null;
        if (daily && daily.length) {
          for (let i = daily.length - 1; i >= 0; i--) {
            if (istDayOf(daily[i].time) < todayIso) { prev = daily[i]; break; }
          }
        }
        if (prev) { pdh = Math.round(prev.high * 100) / 100; pdl = Math.round(prev.low * 100) / 100; }
      } catch { /* PDH/PDL optional */ }
      // Groww-style volume indicator (more active on a breakout). Built from
      // the 5m underlying candles; returns available:false for index feeds
      // that carry no volume so the UI shows N/A rather than a flat bar.
      const oiVol = computeOiVolume(c5arr as any, {
        spot, orbHigh, orbLow, pdh, pdl,
        oiDirection: bullish ? "UP" : bearish ? "DOWN" : "FLAT",
      });
      const nowSec = Math.floor(Date.now() / 1000);
      const oiAsOf = oi.asOf || nowSec;
      const dataAgeSec = Math.max(0, nowSec - oiAsOf);
      const payload: any = {
        available: true, dataSource: "GROWW", symbol: def.symbol, name: def.name, expiry: oi.expiry, asOf: nowSec, oiAsOf, dataAgeSec,
        stale: dataAgeSec > 90,
        spot: Math.round(spot * 100) / 100,
        oiDirection: bullish ? "UP" : bearish ? "DOWN" : "FLAT",
        oiVerdict: oc.oiVerdict, oiMoveScore: oc.oiConfidence, oiReasons: oc.oiReasons,
        expectedMove: { low: dir < 0 ? -expLow : expLow, high: dir < 0 ? -expHigh : expHigh, dir },
        setup: {
          action: dir === 0 ? "WAIT — no OI edge" : bearish ? "BUY PE" : "BUY CE",
          optionType, strike: atmStrike, strikeType: dir === 0 ? "—" : "ATM",
          ltp: r0(ltp),
          strikeOiPct: leg?.oiChgPct ?? null, volume: leg?.vol ?? null, pricePct: leg?.ltpChgPct ?? null,
          oiHelpful: leg?.oiChg != null ? leg.oiChg < 0 : null,
          pxHelpful: leg?.ltpChgPct != null ? leg.ltpChgPct >= 0 : null,
          confidence: oc.oiConfidence,
        },
        tracker: { signalPrice: Math.round(signalPrice * 100) / 100, currentPrice: Math.round(spot * 100) / 100, currentMove: rawMove, favMove: Math.round(favMove * 100) / 100, expLow, expHigh, captured: Math.round(captured), pending: Math.round(pending), capturedPct },
        management: { entry: r0(ltp), targetLo: tgtLo, targetHi: tgtHi, stopLoss: sl, profitZone, dangerLo, dangerHi, invalidation, support, resistance, status, statusCls },
        levels: { strongResistance, weakResistance, strongSupport, weakSupport, orbHigh, orbLow, pdh, pdl },
        volume: oiVol,
        moveRead: oc.moveRead, hasBaseline: oc.hasBaseline, baselineNote: oc.baselineNote,
        futBuildup: oi.futBuildup ?? null, pcr: oi.pcr ?? null, maxPain: oi.maxPain ?? null,
      };
      // Surface BOTH ATM legs (CALL + PUT LTP) for the Master Trade Selector, plus a
      // per-session intraday hi/lo tracker for each leg. These are display-only and
      // never feed the trading logic.
      const callLtp = atmRow?.ceLtp ?? null;
      const putLtp = atmRow?.peLtp ?? null;
      const optRange = trackOptDayRange(def.symbol, callLtp, putLtp);
      payload.callLtp = callLtp;
      payload.putLtp = putLtp;
      payload.callLtpChgPct = atmRow?.ceLtpChgPct ?? null;
      payload.putLtpChgPct = atmRow?.peLtpChgPct ?? null;
      payload.optRange = optRange;
      // Market-review (post-exit HIT/MISS) lines for today's closed trades on this symbol.
      payload.tradeReviews = tradeReviewsForSymbol(def.symbol);
      payload.recommendation = recommendOiTrades({
        hasBaseline: !!oc.hasBaseline, stale: !!payload.stale, dataAgeSec: payload.dataAgeSec,
        oiDirection: payload.oiDirection, oiConfidence: oc.oiConfidence, oiReasons: oc.oiReasons || [],
        status, spot, atmStrike, optionType, ltp: r0(ltp),
        strikeOiPct: leg?.oiChgPct ?? null, pricePct: leg?.ltpChgPct ?? null,
        oiHelpful: payload.setup.oiHelpful, pxHelpful: payload.setup.pxHelpful,
        invalidation, support, resistance, expLow, expHigh, last5mDir,
      });
      // Pre-trade risk score (volatility spike, choppy-market theta trap, time-of-
      // day risk, volume spike, sharp-candle risk, premium sensitivity to a single
      // bar's move). computeRiskRadar already existed and was fully built/tested,
      // but was previously wired into nothing except the standalone
      // GET /options/:symbol route - disconnected from OI Command entirely, so a
      // trader saw a trade recommendation here with no risk read next to it. Now
      // attached to every OI Command response.
      try {
        payload.riskRadar = c15arr.length ? computeRiskRadar(c15arr, { interval: "15m" as Interval, premium: r0(ltp) }) : null;
      } catch { payload.riskRadar = null; }
      const recDir = payload.recommendation?.directional || {};
      const band = [payload.spot, recDir.spotTarget, recDir.spotStop, invalidation, r0(spot + expHigh), r0(spot - expLow)]
        .filter((x: any) => x != null && Number(x) > 0)
        .map(Number);
      payload.plan = {
        takeSpot: payload.spot,
        takeOpt: r0(ltp),
        strike: atmStrike,
        side: optionType,
        highSpot: band.length ? Math.round(Math.max(...band) * 100) / 100 : null,
        lowSpot: band.length ? Math.round(Math.min(...band) * 100) / 100 : null,
        highOpt: recDir.target ?? tgtHi,
        lowOpt: recDir.stop ?? sl,
      };
      payload.walls = buildOiWalls(oi.topStrikes || [], spot, atmStrike, oi.maxPain ?? null);
      // Live option-chain slice + writing-wall summary for the OI Details drawer.
      // Sourced from the same OI read that drives the arbiter, so it updates every poll.
      const W0 = payload.walls || {};
      payload.oiChain = (oc.chain || []).map((l: any) => ({
        strike: l.strike,
        atm: l.strike === (oc.atmStrike ?? atmStrike),
        ce: { oi: l.ce?.oi ?? null, oiChgPct: l.ce?.oiChgPct ?? null, ltp: l.ce?.ltp ?? null, ltpChgPct: l.ce?.ltpChgPct ?? null, action: l.ce?.action ?? null },
        pe: { oi: l.pe?.oi ?? null, oiChgPct: l.pe?.oiChgPct ?? null, ltp: l.pe?.ltp ?? null, ltpChgPct: l.pe?.ltpChgPct ?? null, action: l.pe?.action ?? null },
      }));
      payload.oiSummary = {
        spot: payload.spot, atmStrike: oc.atmStrike ?? atmStrike, expiry: payload.expiry,
        pcr: oi.pcr ?? null, support: support ?? oi.support ?? null, resistance: resistance ?? oi.resistance ?? null,
        maxPain: oi.maxPain ?? null, bias: oc.bias ?? payload.oiVerdict,
        callWall: W0.bestR ?? null, putWall: W0.bestS ?? null,
        callPct: W0.callPct ?? null, putPct: W0.putPct ?? null,
        feverSide: W0.feverSide ?? null, fever: W0.fever ?? null,
        totCe: W0.totCe ?? null, totPe: W0.totPe ?? null,
        netCeChg: oc.netCeChg ?? null, netPeChg: oc.netPeChg ?? null,
      };
      const vw = c15arr.length ? last(vwap(c15arr as any)) : null;
      const adxNow = c15arr.length >= 20 ? last(adx(c15arr as any, 14).adx) : null;
      let d4Dir: "Bullish" | "Bearish" | "Neutral" | null = null;
      let d4Score: number | null = null;
      let d4Conf: number | null = null;
      if (c15arr.length >= 30 && dailyArr.length >= 2) {
        const d4 = computeDirection4L(def.symbol, def.name, c15arr as any, dailyArr as any, oi);
        if (d4) {
          const nm = directionNoMomentum(d4);
          d4Dir = nm.direction;
          d4Score = nm.score;
          d4Conf = nm.confidence;
        }
      }
      let gainzPass: boolean | null = null;
      let gainzScore: number | null = null;
      let gainzNote = "OI FLAT — GainzAlgo waits for a direction";
      if (payload.oiDirection !== "FLAT") {
        const playDir = payload.oiDirection === "UP" ? "Bullish" : "Bearish";
        const atrDaily = dailyArr.length ? last(atr(dailyArr as any, 14)) : null;
        const ctx = buyContextFromCandles(def.symbol, def.name, playDir, spot, c15arr as any, dailyArr as any, oi, atrDaily);
        const hp = evaluateBuyAlgo({
          direction: playDir,
          confidence: Math.max(oc.oiConfidence, d4Conf ?? 0),
          qualityScore: oc.oiConfidence,
          marketAlignment: "Market",
          decayLevel: "Low",
          dte: null,
          thetaPctPerDay: null,
          premium: (r0(ltp) ?? 10),
          delta: null,
          pcr: oi.pcr ?? null,
          oiBias: oc.oiVerdict,
          adx: ctx.adx ?? (adxNow != null ? Math.round(adxNow * 10) / 10 : null),
          vwapBias: ctx.vwapBias ?? 0,
          orFormed: ctx.orFormed ?? false,
          orBreak: ctx.orBreak ?? 0,
          srRoomOk: ctx.srRoomOk ?? null,
          d4Dir: ctx.d4Dir ?? d4Dir,
          relVolume: oiVol.available ? oiVol.rvol : null,
          exhausted: ctx.exhausted ?? false,
        });
        gainzPass = hp.pass;
        gainzScore = hp.score;
        gainzNote = hp.pass ? `PASS ${hp.score} · ${(hp.notes || []).slice(0, 3).join(", ")}` : `SKIP ${hp.score} · ${(hp.failed || []).slice(0, 2).join("; ")}`;
      }
      payload.correlate = correlateOiModels({
        oiDir: payload.oiDirection, oiScore: oc.oiConfidence,
        hasBaseline: !!oc.hasBaseline, stale: !!payload.stale,
        recTake: !!(payload.recommendation?.directional?.take || payload.recommendation?.scalp?.take),
        vwap: vw != null ? Math.round(vw * 100) / 100 : null, spot, last5mDir,
        futBuildup: oi.futBuildup ?? null, d4Dir, d4Score, d4Conf,
        gainzPass, gainzScore, gainzNote,
        adx: adxNow != null ? Math.round(adxNow * 10) / 10 : null,
      });
      // Intelligent Market Commentary (pure Hindi, multi-factor, data-driven). Best-effort.
      try {
        const closesC = (c15arr as any[]).map((c) => c.close);
        const ema21C = closesC.length >= 21 ? last(ema(closesC, 21)) : null;
        const ema50C = closesC.length >= 50 ? last(ema(closesC, 50)) : null;
        const macdC = closesC.length >= 35 ? macd(closesC) : null;
        const histC = macdC ? macdC.histogram : [];
        const macdHistC = histC.length ? (histC[histC.length - 1] as number | null) : null;
        const macdHistPrevC = histC.length >= 2 ? (histC[histC.length - 2] as number | null) : null;
        const structureC = detectStructure((c15arr as any[]).map((c) => ({ high: c.high, low: c.low, close: c.close })));
        const W1: any = payload.walls || {};
        const lv: any = payload.levels || {};
        payload.commentary = buildMarketCommentary({
          spot,
          immSupport: W1.immS?.strike ?? support ?? null,
          majorSupport: W1.bestS?.strike ?? lv.strongSupport?.strike ?? support ?? null,
          immResistance: W1.immR?.strike ?? resistance ?? null,
          majorResistance: W1.bestR?.strike ?? lv.strongResistance?.strike ?? resistance ?? null,
          ema21: ema21C, ema50: ema50C, vwap: vw != null ? Math.round(vw * 100) / 100 : null,
          macdHist: macdHistC, macdHistPrev: macdHistPrevC,
          pcr: oi.pcr ?? null, oiVerdict: oc.oiVerdict ?? null,
          callWall: W1.bestR ?? null, putWall: W1.bestS ?? null,
          callPct: W1.callPct ?? null, putPct: W1.putPct ?? null,
          chain: payload.oiChain || [],
          structure: structureC,
          marketOpen: !payload.stale && isMarketOpenIST(),
        });
      } catch { /* commentary is best-effort — never break the OI command */ }
      const paperOpen = (() => {
        try {
          return (getPaperSummary().open || []).filter((p: any) => p.symbol === def.symbol);
        } catch { return []; }
      })();
      payload.positions = paperOpen.map((p: any) => ({
        id: p.id, scalp: !!p.scalp, strike: p.strike, optionType: p.optionType,
        entry: p.entryPrice, stop: p.premiumStop ?? p.spotStop, high: p.premiumTarget ?? p.spotTarget,
        last: p.lastPrice ?? p.entryPrice, name: p.name, confidence: p.confidence,
        candlePattern: p.candlePattern || null,
      }));
      payload.lesson = buildOiLesson({
        oiDir: payload.oiDirection,
        rec: payload.recommendation,
        walls: payload.walls,
        plan: payload.plan,
        corr: payload.correlate,
        adx: adxNow != null ? Math.round(adxNow * 10) / 10 : null,
        capturedPct,
        hasBaseline: !!oc.hasBaseline,
        stale: !!payload.stale,
        positions: payload.positions,
        c5: { ...detectCandlePattern(c5arr as any), tf: "5m" },
        c15: { ...detectCandlePattern(c15arr as any), tf: "15m" },
      });
      // The OI lesson's own "reverse risk" read (model conflict, weak ADX trend,
      // late-in-the-move candle) previously only ever showed up as narration in
      // the lesson panel while the trade card next to it still read as a clean
      // TAKE with algoReady=true. Feed it back: downgrade confidence, disable
      // auto-trade eligibility (oiGridToIdea below checks algoReady before the
      // paper engine will act on this idea), and add an explicit reason so the
      // trader sees WHY, rather than the recommendation and the lesson silently
      // disagreeing with each other.
      if (payload.lesson?.mode === "REVERSE_RISK") {
        const REVERSE_RISK_PENALTY = 15;
        for (const leg of [payload.recommendation?.directional, payload.recommendation?.scalp]) {
          if (!leg) continue;
          leg.confidence = Math.max(0, leg.confidence - REVERSE_RISK_PENALTY);
          leg.algoReady = false;
          if (leg.take) {
            leg.reasons = [...(leg.reasons || []), "⚠ reverse-risk read (model conflict / weak trend / late move) — auto-trade disabled, size down or wait"];
          }
        }
      }
      payload.bulletin = buildMoveBulletin({
        c5: c5arr, c15: c15arr, c60: c60arr,
        oiDir: payload.oiDirection,
        fut: oi.futBuildup ?? null,
        pcr: oi.pcr ?? null,
        feverSide: payload.walls?.feverSide,
        d4Dir,
        hourDir: (() => {
          try { return computeHourOutlook(def.symbol, def.name, c15arr as any, c60arr as any)?.direction ?? null; }
          catch { return null; }
        })(),
      });
      payload.moodReview = reviewMoodFromFile(
        def.symbol,
        new Date(Date.now() + 19800000).toISOString().slice(0, 10),
        payload.bulletin
      );
      const feed = syncSessionProvider();
      payload.oiSource = feed.marketOpen ? "groww" : "file";
      payload.refresh = oiRefreshMeta(def.symbol, { oiSource: payload.oiSource });
      payload.lastBarDate = oiBarIstDate(c15arr.length ? c15arr[c15arr.length - 1] : null);
      payload.quality = oiQuality({
        marketOpen: feed.marketOpen,
        provider: feed.provider,
        oiSource: payload.oiSource,
        hasPremiums: oiHasPremiums(oi),
        hasBaseline: !!oc.hasBaseline,
        stale: !!payload.stale,
        excelRows: payload.moodReview?.rows || 0,
        bars: c15arr.length,
        lastBarDate: payload.lastBarDate,
      });
      try { appendOiExcel(payload, feed.provider); } catch { /* excel log */ }
      if (payload.oiDirection !== "FLAT" && (payload.oiMoveScore ?? 0) >= 60) {
        try {
            const newlyLogged = logOiSignal({
              symbol: def.symbol, name: def.name, direction: payload.oiDirection as "UP" | "DOWN", optionType: payload.setup.optionType as "CE" | "PE",
            strike: payload.setup.strike, confidence: payload.oiMoveScore, spot: payload.spot,
            expLow: Math.abs(payload.expectedMove.low), expHigh: Math.abs(payload.expectedMove.high),
          });
            // COMPLIANCE: write one durable audit record per NEW signal (deduped by logOiSignal).
            if (newlyLogged) {
              let autoTradeEnabled = false;
              try { autoTradeEnabled = !!getPaperSummary()?.active; } catch { /* best-effort */ }
              auditSignal({
                symbol: def.symbol, name: def.name, dataSource: "GROWW",
                dataTs: payload.oiAsOf ?? null, dataAgeSec: payload.dataAgeSec ?? null,
                direction: payload.oiDirection as "UP" | "DOWN",
                optionType: payload.setup.optionType as "CE" | "PE",
                strike: payload.setup.strike ?? null,
                entry: payload.management?.entry ?? payload.setup?.ltp ?? null,
                stopLoss: payload.management?.stopLoss ?? null,
                target: payload.management?.targetHi ?? payload.management?.targetLo ?? null,
                confidence: payload.oiMoveScore ?? null,
                autoTradeEnabled,
                orderRef: null,
              });
            }
        } catch { /* log is best-effort */ }
      }
      if (def.symbol === "^NSEI") {
        try { payload.macroSetup = await computeNiftyMacroSetupLive(); } catch { /* advisory only, never block the OI-Command payload */ }
      }
      return withRawExt(payload, { c5: c5arr, c15: c15arr, daily: dailyArr, oi });
}

function oiGridToIdea(def: SymbolDef, grid: any, kind: "directional" | "scalp"): OptionIdea | null {
  const rec = grid?.recommendation?.[kind];
  if (!rec || !rec.take || !rec.algoReady || rec.ltp == null || rec.strike == null || rec.optionType === "—" || !def.lotSize) return null;
  if (rec.target == null || rec.stop == null || rec.spotTarget == null || rec.spotStop == null) return null;
  const B = grid.bulletin || {};
  const want = rec.optionType === "CE" ? "UP" : "DOWN";
  if (kind === "directional") {
    const h = B.dir1h?.dir;
    if (h !== want) return null; // 1h bulletin must match OI directional
  } else {
    const a = B.scalp5?.dir, b = B.scalp15?.dir;
    if (a !== want || b !== want) return null; // 5m + 15m must agree with OI scalp
  }
  let dte: number | null = null;
  if (grid.expiry && /^\d{4}-\d{2}-\d{2}$/.test(grid.expiry)) {
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    dte = Math.max(0, Math.round((Date.parse(grid.expiry + "T00:00:00+05:30") - Date.parse(today + "T00:00:00+05:30")) / 86400000));
  }
  return {
    symbol: def.symbol,
    name: def.name + (kind === "scalp" ? " (OI Scalp)" : " (OI Dir)"),
    direction: rec.optionType === "CE" ? "Bullish" : "Bearish",
    optionType: rec.optionType,
    strike: rec.strike,
    premium: rec.ltp,
    premiumTarget: rec.target,
    premiumStop: rec.stop,
    spot: grid.spot,
    spotTarget: rec.spotTarget,
    spotStop: rec.spotStop,
    lotSize: def.lotSize,
    expectedMovePct: rec.expectedMovePct,
    confidence: rec.confidence,
    thetaPctPerDay: 0,
    dte,
    strikeReason: kind === "scalp"
      ? `OI-SCALP · ${rec.action} · ${(rec.reasons || []).join(" · ")}`
      : `OI-DIR · ${rec.action} · ${(rec.reasons || []).join(" · ")}`,
    timeframe: kind === "scalp" ? "5m+15m" : "1h",
    horizon: rec.horizon || (kind === "scalp" ? "OI scalp (5m+15m bulletin)" : "OI directional (1h bulletin)"),
    scalp: kind === "scalp",
  };
}

// ============================ MarketRegimeEngine (Phase 1.1) ============================
// ONE regime classifier for the whole app: the fractal + ATR classifier in
// paper/ext/marketRegime.ts (Trending / Compressed / Transitioning). This function
// is the sole I/O wrapper around it — every consumer that needs "what regime is
// symbol X in right now" (the paper engine's live entry/exit gates, and the
// /data-status + /paper/gate + /paper/why diagnostics) calls THIS, so they can
// never disagree. Replaces three independent ADX-only classifiers that used to
// live at this route file's /data-status handler, its TickDeps.getRegime, and the
// /paper/gate + /paper/why debug mirrors of that same getRegime.
//
// NOT folded in here: classifyRegime() (below) — it classifies per-TIMEFRAME chop/
// coil/whipsaw across 5m/15m/1h for the option-buyer caution panel, a different
// question (micro-structure per timeframe) than "what is THE current regime"
// (one fractal+ATR read off 15m+daily). Collapsing it would redesign a separate
// display feature the plan does not specify, so it is intentionally left as-is.
//
// `adx` in the return value is diagnostic display-only context (several existing
// panels show an ADX number) — it does NOT drive the regime verdict; marketRegime.ts
// owns that decision entirely now.
async function getMarketRegimeForSymbol(symbol: string): Promise<{ regime: MarketRegime; dir: -1 | 0 | 1; adx: number | null } | null> {
  try {
    const def = findSymbolDef(symbol);
    const [c15, daily] = await Promise.all([
      getCandlesCached(symbol, "15m").catch(() => [] as any[]),
      getDailyCached(symbol, 60).catch(() => [] as any[]),
    ]);
    if (!c15 || c15.length < 30) return null;
    let oi: OiAnalysis | null = null;
    if (def?.fno) { try { oi = await getOiCached(def); } catch { oi = null; } }
    const burst = computeMomentumBurst(symbol, c15);
    const result = computeMarketRegime(c15 as any, daily as any, oi, burst.state);
    const dir: -1 | 0 | 1 = result.regimeDir === "up" ? 1 : result.regimeDir === "down" ? -1 : 0;
    let adxNum: number | null = null;
    try { const a = adx(c15, 14); const v = last(a.adx); adxNum = v != null ? Math.round(v) : null; } catch { adxNum = null; }
    return { regime: result.marketRegime, dir, adx: adxNum };
  } catch {
    return null;
  }
}

// SENTIMENT/LIQUIDITY/RISK EXTENSION — assemble live inputs for ONE directional
// (non-scalp) option candidate. Shared by the paper engine dep (getExtInputs) and
// the OI Command cockpit read (buildOiCommand), so both score off identical data.
// `pre` lets a caller pass candles/oi it already fetched (buildOiCommand) to avoid
// re-hitting the feed. Returns null if core data is unavailable.
async function assembleExtInputs(
  idea: OptionIdea,
  pre?: { c5?: any[]; c15?: any[]; daily?: any[]; oi?: OiAnalysis | null },
): Promise<ExtInputs | null> {
  try {
    const def = findSymbolDef(idea.symbol);
    let c5: any[], c15: any[], daily: any[];
    if (pre && pre.c15 && pre.c15.length) {
      c5 = pre.c5 || []; c15 = pre.c15; daily = pre.daily || [];
    } else {
      [c5, c15, daily] = await Promise.all([
        getCandlesCached(idea.symbol, "5m").catch(() => [] as any[]),
        getCandlesCached(idea.symbol, "15m").catch(() => [] as any[]),
        getDailyCached(idea.symbol, 60).catch(() => [] as any[]),
      ]);
    }
    if (!c15 || c15.length < 30) return null;
    // Phase 3.3: staleness parity with the OI path (oi/oiTrade.ts's >90s chain
    // check) — age since candles15m was last actually fetched live, not the last
    // bar's own timestamp (which lags by design, not by feed failure).
    const ageMs = cacheAgeMs(`c:${idea.symbol}:15m`);
    const dataAgeSec = ageMs != null ? Math.round(ageMs / 1000) : null;
    const dataStale = dataAgeSec != null && dataAgeSec > 90;
    let oi: OiAnalysis | null = pre && pre.oi !== undefined ? pre.oi : null;
    if (pre?.oi === undefined) { try { if (def?.fno) oi = await getOiCached(def); } catch { oi = null; } }

    const burst = computeMomentumBurst(idea.symbol, (c5 && c5.length >= 30) ? c5 : c15);
    const lv = levelContext(c15, daily || [], oi);
    const atrDaily = last(atr(daily || [], 14));

    // Today's high/low from intraday candles (IST day of the latest bar).
    const istDayLocal = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
    const src: any[] = (c5 && c5.length) ? c5 : c15;
    const todayIso = src.length ? istDayLocal(src[src.length - 1].time) : "";
    const todayBars = src.filter((c: any) => istDayLocal(c.time) === todayIso);
    const dayHigh = todayBars.length ? Math.max(...todayBars.map((c: any) => c.high)) : null;
    const dayLow = todayBars.length ? Math.min(...todayBars.map((c: any) => c.low)) : null;

    // Option-premium series for THIS strike (for premiumSentiment's EMA9 slope).
    // Groww-only; falls back to [] (module then treats the slope as flat). This
    // fetch had zero caching (unlike every other Groww call in this file), so
    // every /oi-command poll paid for it fresh - cached 45s (comparable to the
    // intraday candle caches) keyed by symbol+strike+type+expiry.
    let premiumSeries: number[] = [];
    try {
      const gp = growwProviderForOi();
      if (gp && oi?.expiry && def) {
        const underlying = (def.nseSymbol || idea.symbol.replace(/\.NS$/i, "")).toUpperCase();
        const expiry: string = oi.expiry;
        const cacheKey = `opt-premium:${underlying}:${idea.strike}:${idea.optionType}:${expiry}`;
        premiumSeries = await cached(cacheKey, 45_000, async () => {
          const inst = await findOption(underlying, idea.optionType, idea.strike, expiry);
          if (!inst) return [] as number[];
          const now = Math.floor(Date.now() / 1000);
          const oc = await growwOptionCandles(gp!, inst.tradingSymbol, now - 2 * 24 * 3600, now, 5);
          return (oc || []).map((c: any) => Number(c.close)).filter((n: number) => Number.isFinite(n));
        });
      }
    } catch { premiumSeries = []; }

    // Liquidity inputs (feed-dependent). Indices lack a bid-ask spread and per-bar
    // volume, so those are left undefined and liquidityGuard reweights.
    const chainOiNow = (oi?.totalCeOi || 0) + (oi?.totalPeOi || 0);
    const liquidityInputs = {
      chainOi: chainOiNow > 0 ? { current: chainOiNow, recentAvg: chainOiNow } : undefined,
    };

    // News-flow bias (module-cached ~5 min).
    let newsBias: "Bullish" | "Bearish" | "Neutral" | undefined;
    try { const nw = await cached("news-bias", 300_000, () => getMarketNews()); newsBias = nw?.summary?.bias; } catch { newsBias = undefined; }

    // Is spot at a Setup wall? Band scales with ATR. Wall selection is READ from
    // Setup's levelContext output — never recomputed here.
    const spot = idea.spot;
    const band = Math.max(spot * 0.0015, 0.2 * (atrDaily || spot * 0.01));
    const walls: { level: number; kind: "res" | "sup" }[] = [];
    if (lv.majorResistance != null) walls.push({ level: lv.majorResistance, kind: "res" });
    if (lv.majorSupport != null) walls.push({ level: lv.majorSupport, kind: "sup" });
    let atWall = false, wallRef: number | null = null, wallKind: "res" | "sup" | null = null;
    for (const w of walls) {
      if (Math.abs(spot - w.level) <= band) { atWall = true; wallRef = w.level; wallKind = w.kind; break; }
    }

    // OI velocity at the touched wall (nearest topStrike's OI change).
    let oiVelocity: number | undefined;
    if (atWall && wallRef != null && oi?.topStrikes?.length) {
      let nearest = oi.topStrikes[0];
      for (const st of oi.topStrikes) if (Math.abs(st.strike - wallRef) < Math.abs(nearest.strike - wallRef)) nearest = st;
      oiVelocity = wallKind === "res" ? (nearest.ceChg || 0) : (nearest.peChg || 0);
    }

    // Touch count this session: intraday bars that came within band of the wall.
    let touchCount = 0;
    if (atWall && wallRef != null) {
      for (const c of todayBars) if (c.high >= wallRef - band && c.low <= wallRef + band) touchCount++;
    }

    const approachVolume = relVolNow(c15) ?? undefined;
    const minutesIST = (() => { const d = new Date(Date.now() + 19800000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
    const withinFirst30 = minutesIST >= 555 && minutesIST < 585; // 9:15–9:45 IST

    return {
      candles5m: (c5 || []) as any, candles15m: c15 as any, daily: (daily || []) as any, oi,
      dataAgeSec, dataStale,
      burstState: burst.state, squeezeOn: burst.squeezeOn,
      pdh: lv.pdh, pdl: lv.pdl, pdc: lv.pdc, dayOpen: lv.dayOpen, atrDaily,
      dayHigh, dayLow, wallSupport: lv.majorSupport, wallResistance: lv.majorResistance,
      spot, direction: idea.direction, optionType: idea.optionType, strike: idea.strike, premium: idea.premium, premiumSeries,
      liquidityInputs,
      newsBias, pcrSeries: oi?.pcr != null ? [oi.pcr] : undefined, ivSkewSeries: undefined,
      atWall, wallRef, oiVelocity, approachVolume, touchCount,
      minutesIST, withinFirst30,
    };
  } catch { return null; }
}

// Compute the extension read for the OI Command cockpit: the module states +
// finalScore/setupQuality + a per-line score breakdown + an advisory riskComment
// + the dedup-suppression status for the current directional recommendation. This
// SHOWS what the modules say (read-only) — it does not open trades or arm dedup.
async function extForOiPayload(payload: any): Promise<any> {
  try {
    const recDir = payload?.recommendation?.directional || {};
    const hasIdea = recDir.strike != null && recDir.ltp != null && (recDir.optionType === "CE" || recDir.optionType === "PE");
    const idea: OptionIdea = {
      symbol: payload.symbol, name: payload.name,
      direction: recDir.optionType === "PE" ? "Bearish" : "Bullish",
      optionType: (recDir.optionType === "PE" ? "PE" : "CE"),
      strike: recDir.strike ?? payload.setup?.strike ?? 0,
      premium: recDir.ltp ?? payload.setup?.ltp ?? 0,
      premiumTarget: recDir.target ?? 0, premiumStop: recDir.stop ?? 0,
      spot: payload.spot, spotTarget: recDir.spotTarget ?? payload.spot, spotStop: recDir.spotStop ?? payload.spot,
      lotSize: 0, expectedMovePct: recDir.expectedMovePct ?? 0, confidence: recDir.confidence ?? payload.oiMoveScore ?? 55,
      thetaPctPerDay: 0, dte: null, strikeReason: "OI-DIR",
    };
    // Reuse the candles/OI buildOiCommand already fetched for this same symbol
    // (stashed non-enumerably on payload by withRawExt) instead of paying for a
    // second, mismatched-cache-key fetch of the same data.
    const inp = await assembleExtInputs(idea, payload?.__rawExt);
    if (!inp) return null;
    const baseConfidence = calibratedWinProb({ scalp: false, confidence: idea.confidence, strikeReason: idea.strikeReason });
    const ext = scoreExtension(inp, { direction: idea.direction, optionType: idea.optionType }, baseConfidence);

    // Advisory riskComment from the current paper-run guard snapshot (indicative
    // 1-lot size; the paper engine attaches the exact size when it emits).
    const sum = getPaperSummary();
    const startTotal = Number(sum.totalStart) || 0;
    const tradeRisk = hasIdea ? Math.max(0, (idea.premium - idea.premiumStop)) : 0;
    const riskComment = buildRiskComment({
      openRisk: Number(sum.openRisk) || 0, tradeRisk,
      heatCapAbs: startTotal * ((Number(sum.heatCapPct) || 6) / 100),
      dailyRealised: Number(sum.todayRealisedPnl) || 0,
      dailyLossCapAbs: startTotal * ((Number(sum.dailyLossCapPct) || 3) / 100),
      startTotal,
      equityNow: Number(sum.totalEquity) || startTotal,
      peakEquity: Number(sum.peakEquity) || startTotal,
      drawdownKillPct: (Number(sum.maxDrawdownPct) || 10) / 100,
      suggestedLots: 1, suggestedQty: 1, premium: idea.premium,
    });

    // Read-only dedup status for this setup (does not arm anything).
    let dedupSuppressed = false, dedupReason = "";
    if (hasIdea) {
      const atrForZone = inp.atrDaily && inp.atrDaily > 0 ? inp.atrDaily : inp.spot * 0.01;
      const wallHeaviest = inp.wallRef != null && inp.oi ? (inp.wallRef === inp.oi.support || inp.wallRef === inp.oi.resistance) : false;
      const st = extDedupPeek({
        mode: "directional", direction: idea.direction, strike: idea.strike, entryPrice: inp.spot,
        atr: atrForZone, wallRef: inp.wallRef, wallReaction: ext.wall.wallReactionState,
        regime: ext.regime.marketRegime, wallHeaviest,
      });
      dedupSuppressed = st.suppressed; dedupReason = st.reason;
    }

    // ---- Phase 3 arbiter: resolve Directional vs Scalp into ONE primary ----
    const candidates: ArbiterCandidate[] = [];
    if (hasIdea) {
      candidates.push({
        mode: "Directional", direction: idea.direction,
        finalScore: ext.score.finalScore, setupQuality: ext.score.setupQuality,
        eligible: !!(payload?.recommendation?.directional?.take), vetoed: ext.score.vetoed, suppressed: dedupSuppressed,
      });
    }
    const recSc = payload?.recommendation?.scalp;
    if (recSc && recSc.take && (recSc.optionType === "CE" || recSc.optionType === "PE")) {
      const scDir: "Bullish" | "Bearish" = recSc.optionType === "PE" ? "Bearish" : "Bullish";
      const scBase = calibratedWinProb({ scalp: true, confidence: recSc.confidence ?? 55, strikeReason: "OI-SCALP" });
      // Scalp scored WITHOUT sentiment/opening-bias (constraint); regime/liquidity/
      // wall are shared context only. No premium veto (no scalp premium series here).
      const scScore = computeTradeScore({
        baseTrigger: true, baseConfidence: scBase, direction: scDir, premiumState: "Neutral",
        regime: ext.regime.marketRegime, wallReaction: ext.wall.wallReactionState,
        sentimentState: "Neutral", liquidityState: ext.liquidity.liquidityState,
      });
      candidates.push({ mode: "Scalp", direction: scDir, finalScore: scScore.finalScore, setupQuality: scScore.setupQuality, eligible: true, vetoed: false, suppressed: false });
    }
    const arbitration = arbitrate(candidates);

    return {
      hasIdea,
      arbitration,
      regime: ext.regime.marketRegime, regimeNote: ext.regime.note,
      liquidityState: ext.liquidity.liquidityState, liquidityScore: ext.liquidity.liquidityScore,
      sentimentState: ext.sentiment.sentimentState, sentimentScore: ext.sentiment.sentimentScore,
      premiumState: ext.premium.premiumState,
      wallReactionState: ext.wall.wallReactionState, wallNote: ext.wall.note, atWall: inp.atWall,
      finalScore: ext.score.finalScore, setupQuality: ext.score.setupQuality,
      vetoed: ext.score.vetoed, rrFloorOverride: ext.score.rrFloorOverride,
      scoreBreakdown: ext.score.reasons,
      openingBias: ext.openingBias?.openingBias, withinFirst30: inp.withinFirst30,
      riskComment, dedupSuppressed, dedupReason,
    };
  } catch { return null; }
}

// OI Command route (cached 15s). The same builder feeds the 15-min signal logger.
router.get("/oi-command", requirePermission("oiAnalysis"), async (req: Request, res: Response) => {
  const feed = syncSessionProvider();
  const def = findSymbolDef(String(req.query.symbol || "^NSEI"));
  if (!def || !def.fno) return res.status(400).json({ available: false, error: "valid F&O symbol चाहिए" });
  if (isMarketOpenIST() && !growwProviderForOi()) {
    return res.json({
      available: false,
      message: feed.growwOn
        ? "Market hours में OI Command के लिए Groww token चाहिए।"
        : "Groww OFF / not configured — OI chain के लिए Groww connect करें।",
      refresh: oiRefreshMeta(def.symbol),
    });
  }
  try {
    const data = await cached(`oi-command:${def.symbol}`, 15_000, () => buildOiCommand(def));
    // Surface the sentiment/liquidity/risk extension read for the cockpit, and
    // reconcile the Decision Log (user-facing route only, so background scans /
    // the paper engine don't spam state-change events). Cached with the same
    // key scheme + 15s TTL as buildOiCommand's own cache immediately above -
    // extForOiPayload was being recomputed on every request even when `data`
    // was itself served from cache (same effective freshness window, no new
    // calculation, no output change - just skips redundant work).
    let ext: any = null;
    try { ext = await cached(`oi-command-ext:${def.symbol}`, 15_000, () => extForOiPayload(data)); } catch { ext = null; }
    if (ext) {
      const verdict = ext.arbitration ? ext.arbitration.verdict : "WAIT";
      // Data-health = stale ONLY during market hours (after-hours 'stale' is expected).
      const staleNow = !!(data && data.stale) && !(data && data.refresh && data.refresh.marketOpen === false);
      try { reconcileOiState(def.symbol, { go: verdict === "GO", regime: ext.regime, liquidity: ext.liquidityState, sentiment: ext.sentimentState, wall: ext.wallReactionState, arbVerdict: verdict, stale: staleNow }); } catch { /* best-effort */ }
      try { checkArbiterWatchdog({ symbol: def.symbol, verdict, primaryFinalScore: ext.arbitration && ext.arbitration.primary ? ext.arbitration.primary.finalScore : null }); } catch { /* best-effort */ }
    }
    // Data-collection recorder (AI dataset prep) — PASSIVE OBSERVER, reads only
    // what buildOiCommand/extForOiPayload already computed above; never calls
    // arbitrate() itself, never alters `data`/`ext`, never affects the response.
    // See backend/data/liveSnapshotRecorder.ts's header comment.
    try {
      const raw = (data as any).__rawExt;
      if (raw?.c15?.length) {
        recordLiveSnapshot({
          symbol: def.symbol,
          timestamp: data.asOf ?? Math.floor(Date.now() / 1000),
          spot: data.spot ?? null,
          atm: data.spot ? nearestStrike(data.spot, def) : null,
          expiry: data.expiry ?? null,
          candles: raw.c15,
          oi: raw.oi ?? null,
          oiVerdict: data.oiVerdict ?? null,
          masterDecision: ext?.arbitration?.verdict ?? null,
          finalScore: ext?.finalScore ?? null,
          regime: ext?.regime ?? null,
        });
      }
    } catch (e) { console.error("[liveSnapshotRecorder] failed:", e instanceof Error ? e.message : e); }

    // ADVISORY suggestion recorder — PASSIVE OBSERVER, same contract as the
    // snapshot recorder above: it reads only what was already computed, never
    // calls arbitrate(), never mutates `data`/`ext`, and never affects the
    // response. It exists so the UI can later compare what the system SUGGESTED
    // against what the market ACTUALLY DID. It places no orders.
    try {
      recordAdvisorySuggestion(buildAdvisoryRecord({
        at: data.asOf ?? Math.floor(Date.now() / 1000),
        istDate: istDateStr(),
        istTime: new Date(Date.now() + 19800000).toISOString().slice(11, 19),
        symbol: def.symbol,
        name: def.name,
        spot: data.spot ?? null,
        expiry: data.expiry ?? null,
        masterVerdict: ext?.arbitration?.verdict ?? null,
        primaryMode: ext?.arbitration?.primary?.mode ?? null,
        masterReason: ext?.arbitration?.reason ?? null,
        directional: data.recommendation?.directional ?? null,
        scalp: data.recommendation?.scalp ?? null,
        setup: (data as any).setup ?? null,
        finalScore: ext?.finalScore ?? null,
        support: data.oi?.support ?? null,
        resistance: data.oi?.resistance ?? null,
        expLow: (data as any).expLow ?? null,
      }));
    } catch (e) { console.error("[advisoryRecorder] failed:", e instanceof Error ? e.message : e); }

    res.json(ext ? { ...data, ext } : data);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "oi-command failed" });
  }
});

// Decision Log — the extension's trust layer (GO/WAIT flips, regime/liquidity/
// sentiment/wall changes, and every trade emit/veto/dedup/below-clarity event).
// Filters: ?type=&mode=&symbol=&mins=&limit=
router.get("/oi-command/decision-log", (req: Request, res: Response) => {
  try {
    const mins = Number(req.query.mins);
    const sinceEpoch = Number.isFinite(mins) && mins > 0 ? Math.floor(Date.now() / 1000) - Math.round(mins * 60) : undefined;
    res.json({
      entries: getDecisionLog({
        type: (req.query.type as any) || "all",
        mode: (req.query.mode as any) || "all",
        symbol: req.query.symbol ? String(req.query.symbol) : undefined,
        sinceEpoch,
        limit: Math.max(1, Math.min(500, Number(req.query.limit) || 200)),
      }),
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "decision-log failed" });
  }
});
router.get("/oi-command/decision-log/clear", (_req: Request, res: Response) => { clearDecisionLog(); res.json({ ok: true }); });

// COMPLIANCE: non-secret metadata for the disclosure/consent layer. The frontend reads
// this to know the current app + disclosure version (re-prompt on change) and honest
// capability flags. Displaying disclaimers does NOT make the app "SEBI compliant".
router.get("/compliance/meta", (_req: Request, res: Response) => {
  res.json(complianceMeta());
});

// Groww rate-limit telemetry: per-endpoint call counts, 429s seen, retries, whether the
// client-side throttle is kicking in, and per-minute/per-day usage vs caps.
router.get("/groww/ratelimit-stats", requireAdmin, (_req: Request, res: Response) => {
  res.json(growwRateLimitStats());
});

// ============ Local access gate (paper desk single-user login) ============
// Credentials are verified server-side only. The client stores the returned
// opaque token and sends it as a Bearer header to check its session.
const bearer = (req: Request): string | null => {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};
// Rate-limit login attempts so a USER account's password can't be brute-forced
// over the network. The ADMIN username is exempt (skip) — requested
// explicitly: the admin account should never get locked out of its own
// dashboard. Trade-off, stated plainly: this removes brute-force throttling
// for the single most privileged account. Acceptable today because this is a
// personal/local single-operator tool (not a public multi-tenant service) and
// the admin password already rotates daily outside dev/passwordless mode -
// revisit this exemption before ever exposing this app on the open internet.
const loginLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many login attempts. Try again later." },
  skip: (req) => {
    const attempted = String(req.body?.username || "").trim().toLowerCase();
    return !!attempted && attempted === getCredentials().username.toLowerCase();
  },
});
router.post("/login", loginLimiter, (req: Request, res: Response) => {
  const { username, password, mode } = req.body || {};
  const r = doLogin(String(username || ""), String(password || ""), mode === "admin" || mode === "user" ? mode : undefined);
  if (!r.ok) return res.status(401).json({ ok: false, error: r.error });
  res.json({ ok: true, token: r.token, expiresAt: r.expiresAt, role: r.role, username: r.username, permissions: r.permissions });
});
router.get("/session", (req: Request, res: Response) => {
  res.json(sessionInfo(bearer(req)));
});
router.post("/logout", (req: Request, res: Response) => {
  doLogout(bearer(req));
  res.json({ ok: true });
});

// ============================ Admin: user management ============================
// Every route below requires requireAdmin - a real 403 server-side, not a
// hidden UI button. See requireAdmin's comment above.
router.get("/admin/stats", requireAdmin, (_req: Request, res: Response) => {
  res.json(userStats());
});
router.get("/admin/users", requireAdmin, (_req: Request, res: Response) => {
  res.json({ users: listUsers() });
});
router.post("/admin/users", requireAdmin, (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const username = String(b.username || "").trim();
    const temporaryPassword = String(b.temporaryPassword || "");
    if (!username || !temporaryPassword) return res.status(400).json({ error: "Username and temporary password are required." });
    if (temporaryPassword.length < 6) return res.status(400).json({ error: "Temporary password must be at least 6 characters." });
    const permissions: Permission[] = Array.isArray(b.permissions) ? b.permissions.filter((p: any) => ALL_PERMISSIONS.includes(p)) : [];
    const user = createUser({
      username, temporaryPassword,
      accessStartDate: b.accessStartDate || null,
      accessExpiryDate: b.accessExpiryDate || null,
      permissions,
    });
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "USER_CREATED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `created user ${username}`, result: "success" });
    res.json({ ok: true, user });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Could not create user." });
  }
});
router.put("/admin/users/:userId", requireAdmin, (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const permissions: Permission[] | undefined = Array.isArray(b.permissions) ? b.permissions.filter((p: any) => ALL_PERMISSIONS.includes(p)) : undefined;
    const user = editUser(req.params.userId, {
      accessStartDate: b.accessStartDate !== undefined ? b.accessStartDate : undefined,
      accessExpiryDate: b.accessExpiryDate !== undefined ? b.accessExpiryDate : undefined,
      permissions,
    });
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "admin_action", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `edited user ${user.username}`, result: "success" });
    res.json({ ok: true, user });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Could not edit user." });
  }
});
router.post("/admin/users/:userId/disable", requireAdmin, (req: Request, res: Response) => {
  try {
    const user = setUserStatus(req.params.userId, "DISABLED");
    revokeUserSessions(req.params.userId); // a disabled user's existing session is killed immediately
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "USER_DISABLED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `disabled user ${user.username}`, result: "success" });
    res.json({ ok: true, user });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Could not disable user." });
  }
});
router.post("/admin/users/:userId/enable", requireAdmin, (req: Request, res: Response) => {
  try {
    const user = setUserStatus(req.params.userId, "ACTIVE");
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "USER_ENABLED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `enabled user ${user.username}`, result: "success" });
    res.json({ ok: true, user });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Could not enable user." });
  }
});
router.post("/admin/users/:userId/reset-password", requireAdmin, (req: Request, res: Response) => {
  try {
    const newTemporaryPassword = String((req.body || {}).temporaryPassword || "");
    if (newTemporaryPassword.length < 6) return res.status(400).json({ error: "Temporary password must be at least 6 characters." });
    const user = resetPassword(req.params.userId, newTemporaryPassword);
    revokeUserSessions(req.params.userId); // force re-login with the new password
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "USER_PASSWORD_RESET", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `reset password for user ${user.username}`, result: "success" });
    res.json({ ok: true, user });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Could not reset password." });
  }
});
router.post("/admin/users/:userId/revoke", requireAdmin, (req: Request, res: Response) => {
  const target = findById(req.params.userId);
  const count = revokeUserSessions(req.params.userId);
  const admin = getSession(bearerToken(req));
  logAuditEvent({ type: "USER_REVOKED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `revoked ${count} session(s) for user ${target?.username || req.params.userId}`, result: "success" });
  res.json({ ok: true, revokedSessions: count });
});
// Permanent delete (separate from Disable, which is reversible). Revokes any
// active session for that user FIRST so a delete can never leave a live
// session behind, then removes the record entirely.
router.delete("/admin/users/:userId", requireAdmin, (req: Request, res: Response) => {
  try {
    const target = findById(req.params.userId);
    if (!target) return res.status(404).json({ error: "User not found." });
    revokeUserSessions(req.params.userId);
    deleteUser(req.params.userId);
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "USER_DELETED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", detail: `deleted user ${target.username}`, result: "success" });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Could not delete user." });
  }
});
// scope=admin (default) shows only entries the admin actually performed -
// login_success/login_failure/logout from USER accounts and ADMIN_ACCESS_DENIED
// (a non-admin session trying an admin route) are excluded, since those are
// activity BY users/attempted-intruders, not BY the admin. Pass scope=all to
// see the complete, unfiltered trail (nothing is ever deleted from the file
// itself - security-relevant denied/failed attempts stay on disk either way,
// just not shown by default).
router.get("/admin/login-history", requireAdmin, (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const scope = req.query.scope === "all" ? "all" : "admin";
  const all = readAuditLog(Number.isFinite(limit) ? limit * 4 : 800); // over-fetch before filtering so `limit` still means "N admin events"
  const events = scope === "admin" ? all.filter((e) => e.mode === "admin") : all;
  res.json({ events: events.slice(0, Number.isFinite(limit) ? limit : 200), scope });
});
router.get("/admin/permissions", requireAdmin, (_req: Request, res: Response) => {
  res.json({ permissions: ALL_PERMISSIONS });
});

// ---- Admin: unified Connections summary (Groww/Dhan/Telegram) ----
// Every value here is either a boolean/status/timestamp or an ALREADY-MASKED
// string - never a raw token/secret. This route (and every /admin/* route) is
// requireAdmin-gated; a plain USER account cannot reach this even by typing
// the URL directly (enforced server-side, not just hidden in the nav).
// Exported (not just used inline) so it's directly unit-testable without
// faking Express request/response machinery - see routes/adminConnections.test.ts.
export function buildConnectionsSummary() {
  const growwCfgured = hasGrowwToken();
  const growwSt = getConnectionStatus("groww");
  const dhanCfg = loadDhanConfig();
  const dhanSt = getConnectionStatus("dhan");
  const tg = alertsStatus();
  const tgSt = getConnectionStatus("telegram");

  const maskToken = (t: string) => (t ? "••••••••••••" + t.slice(-4) : null);

  return {
    groww: {
      status: growwCfgured ? "CONNECTED" : "DISCONNECTED",
      tokenMasked: getGrowwTokenMasked() || null,
      lastConnectedAt: growwSt.lastConnectedAt,
      lastTestedAt: growwSt.lastTestedAt,
      lastTestOk: growwSt.lastTestOk,
    },
    dhan: {
      status: dhanConfigured(dhanCfg) ? "CONNECTED" : "DISCONNECTED",
      clientId: dhanCfg.clientId || null,
      tokenMasked: maskToken(dhanCfg.accessToken),
      lastConnectedAt: dhanSt.lastConnectedAt,
      lastTestedAt: dhanSt.lastTestedAt,
      lastTestOk: dhanSt.lastTestOk,
    },
    telegram: {
      status: tg.ready ? "CONNECTED" : (tg.configured ? "ERROR" : "DISCONNECTED"),
      // Masked only - the bot token never leaves the backend.
      botTokenMasked: tg.botTokenMasked || null,
      chatId: tg.chatId || null,
      lastConnectedAt: tgSt.lastConnectedAt,
      lastTestedAt: tgSt.lastTestedAt,
      lastTestOk: tgSt.lastTestOk,
    },
  };
}

router.get("/admin/connections", requireAdmin, (_req: Request, res: Response) => {
  res.json(buildConnectionsSummary());
});

// ---- Safe, non-admin system status ----
// For regular users: high-level operational status ONLY. No provider names
// beyond what's already shown elsewhere in the app, no client IDs, no tokens,
// no connection configuration. Any logged-in user (admin or user role) may
// call this - it exposes nothing an unauthenticated visitor couldn't already
// infer from the dashboard simply not showing live data.
router.get("/system-status", (_req: Request, res: Response) => {
  const feed = syncSessionProvider();
  res.json({
    marketData: feed.growwOn && feed.configured ? "AVAILABLE" : "UNAVAILABLE",
    notifications: alertsStatus().ready ? "AVAILABLE" : "UNAVAILABLE",
  });
});

// Login-credential email notifications. Requires an existing valid session
// (this router's auth gate already covers everything except /login, /session,
// /logout) - so the very first login still uses the console-printed password,
// but from then on the user can have every future 08:00 IST rotation emailed
// to them instead of hunting through server logs.
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return email;
  return email.slice(0, 1) + "***" + email.slice(at - 1);
}
router.get("/auth/email", requireAdmin, (_req: Request, res: Response) => {
  const email = getNotifyEmail();
  res.json({ email: email ? maskEmail(email) : null, configured: !!email, smtpConfigured: emailConfigured() });
});
router.post("/auth/email", requireAdmin, (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "That doesn't look like a valid email address." });
  }
  setNotifyEmail(email || null);
  res.json({ ok: true, email: email ? maskEmail(email) : null, smtpConfigured: emailConfigured() });
});
// Manual "rotate now" - mostly useful right after setting a notification email,
// so you don't have to wait for the next 08:00 IST to see it work.
router.post("/auth/rotate", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const creds = await rotateCredentials();
    res.json({
      ok: true,
      username: creds.username,
      emailed: !!creds.notifyEmail && emailConfigured(),
      telegramSent: alertsStatus().ready,
      smtpConfigured: emailConfigured(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "Rotation failed." });
  }
});

// COMPLIANCE: read the signal audit trail (JSON). CSV export is available via
// /api/log/export.csv?channel=signal-audit. Filters: ?symbol=&mins=&limit=
router.get("/audit/signals", (req: Request, res: Response) => {
  const mins = Number(req.query.mins);
  const from = Number.isFinite(mins) && mins > 0 ? Date.now() - mins * 60000 : undefined;
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const entries = centralLog.query({
    channel: "signal-audit",
    symbol: req.query.symbol ? String(req.query.symbol) : undefined,
    from, limit,
  });
  res.json({ channel: "signal-audit", count: entries.length, entries });
});

// ============ Centralized Log API (one family for all channels) ============
// Powers the unified Decision Log drawer/dock. channel=all merges every channel.
// (GET is used for clear/export to match this app's all-GET route convention.)
router.get("/log", (req: Request, res: Response) => {
  try {
    const mins = Number(req.query.mins);
    const fromMins = Number.isFinite(mins) && mins > 0 ? Date.now() - mins * 60000 : undefined;
    res.json({
      channels: centralLog.LOG_CHANNELS,
      entries: centralLog.query({
        channel: (req.query.channel as any) || "all",
        symbol: req.query.symbol ? String(req.query.symbol) : undefined,
        mode: req.query.mode && req.query.mode !== "all" ? (req.query.mode as any) : undefined,
        severity: req.query.severity && req.query.severity !== "all" ? (req.query.severity as any) : undefined,
        eventType: req.query.eventType ? String(req.query.eventType) : undefined,
        from: req.query.from ? Number(req.query.from) : fromMins,
        to: req.query.to ? Number(req.query.to) : undefined,
        limit: Math.max(1, Math.min(1000, Number(req.query.limit) || 200)),
      }),
    });
  } catch (e: any) { res.status(502).json({ error: e?.message || "log failed" }); }
});
router.get("/log/clear", (req: Request, res: Response) => {
  const ch = String(req.query.channel || "");
  if (!ch) return res.status(400).json({ error: "channel required (per-channel clear only)" });
  centralLog.clearChannel(ch as any);
  res.json({ ok: true, cleared: ch });
});
router.get("/log/export.csv", (req: Request, res: Response) => {
  const mins = Number(req.query.mins);
  const from = Number.isFinite(mins) && mins > 0 ? Date.now() - mins * 60000 : undefined;
  const csv = centralLog.exportCsv({ channel: (req.query.channel as any) || "all", from, limit: 5000 });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=central-log.csv");
  res.send(csv);
});
router.get("/log/retention-sweep", (_req: Request, res: Response) => { res.json(runRetentionSweep()); });

// Record ONE §C live-verification observation into the dedicated 'verification'
// channel (kept separate from trade channels). result = pass | fail | untested.
// e.g. /api/log/verify?item=staleness&result=pass&note=amber dot on 429
router.get("/log/verify", (req: Request, res: Response) => {
  const item = String(req.query.item || "").trim();
  if (!item) return res.status(400).json({ error: "item required (staleness|na-styling|data-health|cadence|banner-states)" });
  const result = (["pass", "fail", "untested"].includes(String(req.query.result)) ? String(req.query.result) : "untested");
  const note = String(req.query.note || "").slice(0, 300);
  const entry = centralLog.write({
    channel: "verification", symbol: null, mode: null,
    eventType: `SECTION_C_${item.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    severity: result === "fail" ? "warn" : "info",
    summary: `§C ${item}: ${result}${note ? " — " + note : ""}`,
    payload: { section: "C", item, result, note },
  });
  res.json({ ok: true, entry });
});

// ======================= Telegram notifications (messaging only) =======================
// Replaces the former /whatsapp/* routes. Messaging layer only - no trading,
// OI, indicator or decision logic is reachable from here, and a Telegram failure
// cannot propagate into one.
router.get("/telegram/status", requireAdmin, (_req: Request, res: Response) => {
  res.json({ ...alertsStatus(), marketOpen: isTradingTimeIST(), provider: getProvider().name });
});

// Live probe: getMe + getChat (read-only, sends nothing). Confirms the bot token
// is valid AND that the bot can actually see the configured group.
router.get("/telegram/status/live", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const live = await notificationStatusLive();
    recordConnectionTest("telegram", !!(live.botOk && live.groupOk));
    res.json({ ...live, marketOpen: isTradingTimeIST() });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "telegram probe failed" });
  }
});

router.post("/telegram/config", requireAdmin, (req: Request, res: Response) => {
  const b = req.body || {};
  saveTelegramConfig({ enabled: b.enabled, botToken: b.botToken, chatId: b.chatId });
  const admin = getSession(bearerToken(req));
  // The token is NEVER written to the audit log - only that it was updated.
  logAuditEvent({ type: "TELEGRAM_CREDENTIAL_UPDATED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "telegram", result: "success" });
  res.json({ ok: true, ...alertsStatus() });
});

router.post("/telegram/test", requireAdmin, async (req: Request, res: Response) => {
  const admin = getSession(bearerToken(req));
  try {
    const r = await sendAlertsTest();
    recordConnectionTest("telegram", !!r.ok);
    if (r.ok) recordConnectionSuccess("telegram");
    logAuditEvent({ type: "TELEGRAM_CONNECTION_TEST", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "telegram", result: r.ok ? "success" : "failure" });
    res.json(r);
  } catch (e: any) {
    recordConnectionTest("telegram", false);
    logAuditEvent({ type: "TELEGRAM_CONNECTION_TEST", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "telegram", result: "failure" });
    res.status(502).json({ ok: false, error: e?.message || "test failed" });
  }
});

router.post("/telegram/disconnect", requireAdmin, (req: Request, res: Response) => {
  disconnectTelegram();
  const admin = getSession(bearerToken(req));
  logAuditEvent({ type: "TELEGRAM_DISCONNECTED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "telegram", result: "success" });
  res.json({ ok: true });
});

// Invite link so the owner can add another member. The Bot API has no method to
// add a person to a group, and none that accepts a phone number - the invitee
// must join through a link themselves. Requires the bot to be a group admin with
// the invite-users right.
router.post("/telegram/invite", requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = await createInviteLink(String(req.body?.name || "Trading Alerts invite"));
    if (!r.ok) return res.status(502).json({ ok: false, code: r.code, error: r.error, detail: r.detail });
    const admin = getSession(bearerToken(req));
    logAuditEvent({ type: "admin_action", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", result: "success", detail: "created a Telegram group invite link" });
    res.json({ ok: true, inviteLink: r.result?.invite_link ?? null });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message || "invite failed" });
  }
});

router.post("/telegram/tick", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const r = await tickPaperAlerts({
      marketOpen: isTradingTimeIST(),
      provider: getProvider().name,
      scan: scanOiGridsForPing,
    });
    res.json({ ok: true, ...r, ...alertsStatus(), marketOpen: isTradingTimeIST() });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message || "tick failed" });
  }
});

// ---- Dhan historical-data connection (BACKTESTING ONLY - see dhanConfig.ts).
// GROWW remains the only source for OI/live signals/Master Trade Selector;
// this exists purely to let the user pull historical candles for research. ----
router.get("/dhan/status", requireAdmin, (_req: Request, res: Response) => {
  const cfg = loadDhanConfig();
  res.json({
    configured: dhanConfigured(cfg),
    clientId: cfg.clientId || null,
    hasToken: !!cfg.accessToken,
  });
});
router.post("/dhan/config", requireAdmin, (req: Request, res: Response) => {
  const b = req.body || {};
  const next = saveDhanConfig({ accessToken: b.accessToken, clientId: b.clientId });
  const admin = getSession(bearerToken(req));
  logAuditEvent({ type: "DHAN_CREDENTIAL_UPDATED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "dhan", result: "success" });
  res.json({ ok: true, configured: dhanConfigured(next), clientId: next.clientId || null });
});
router.post("/dhan/test", requireAdmin, async (req: Request, res: Response) => {
  const admin = getSession(bearerToken(req));
  try {
    const r = await testDhanConnection();
    recordConnectionTest("dhan", r.ok);
    logAuditEvent({ type: "DHAN_CONNECTION_TEST", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "dhan", result: r.ok ? "success" : "failure" });
    res.json(r);
  } catch (e: any) {
    recordConnectionTest("dhan", false);
    logAuditEvent({ type: "DHAN_CONNECTION_TEST", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "dhan", result: "failure" });
    res.status(502).json({ ok: false, error: e?.message || "test failed" });
  }
});
router.post("/dhan/disconnect", requireAdmin, (req: Request, res: Response) => {
  disconnectDhan();
  const admin = getSession(bearerToken(req));
  logAuditEvent({ type: "DHAN_DISCONNECTED", userId: admin?.userId ?? null, username: admin?.username ?? null, mode: "admin", provider: "dhan", result: "success" });
  res.json({ ok: true });
});

// ---- AI data-collection status (backend/data/liveSnapshotRecorder.ts) ----
// Placeholder, clearly-labeled minimum (not derived from any ML requirement -
// there isn't one to derive from yet): reported as-is so it's easy to change
// once real training requirements are known.
const MIN_OBSERVATIONS_FOR_TRAINING = 5000;

function tradingDataDir(date: string): string {
  return path.join(process.cwd(), "data", "trading_data", date);
}
function countLines(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split("\n").filter((l) => l.length > 0).length;
  } catch { return 0; }
}
function firstLastTimestamp(filePath: string): { first: number | null; last: number | null } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (!lines.length) return { first: null, last: null };
    const firstTs = JSON.parse(lines[0])?.timestamp ?? null;
    const lastTs = JSON.parse(lines[lines.length - 1])?.timestamp ?? null;
    return { first: firstTs, last: lastTs };
  } catch { return { first: null, last: null }; }
}
function hhmmIST(epochSec: number | null): string | null {
  if (epochSec == null) return null;
  const d = new Date(epochSec * 1000 + 19_800_000);
  return d.toISOString().slice(11, 16);
}

router.get("/ai/data-status", requirePermission("aiSignals"), (_req: Request, res: Response) => {
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const dir = tradingDataDir(today);
  const marketFile = path.join(dir, "market_snapshots.jsonl");
  const chainFile = path.join(dir, "option_chain.jsonl");
  const todaySnapshots = countLines(marketFile);
  const optionChainRecords = countLines(chainFile);
  const { first, last } = firstLastTimestamp(marketFile);
  const report = todaySnapshots > 0 ? validateDay(today) : null;
  res.json({
    status: todaySnapshots > 0 ? "ACTIVE" : "INACTIVE",
    todaySnapshots,
    optionChainRecords,
    firstCollection: hhmmIST(first),
    lastCollection: hhmmIST(last),
    dataQualityPercent: report?.qualityScorePercent ?? null,
    trainingDatasetReady: todaySnapshots >= MIN_OBSERVATIONS_FOR_TRAINING,
    observations: todaySnapshots,
    minObservationsRequired: MIN_OBSERVATIONS_FOR_TRAINING,
  });
});

router.get("/ai/training-status", requirePermission("aiSignals"), (_req: Request, res: Response) => {
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const todaySnapshots = countLines(path.join(tradingDataDir(today), "market_snapshots.jsonl"));
  const minReached = todaySnapshots >= MIN_OBSERVATIONS_FOR_TRAINING;
  res.json({
    historicalTechnicalData: "AVAILABLE", // Dhan backtest path (Layer 1) — see backend/backtest/
    liveOiArchive: todaySnapshots > 0 ? "COLLECTING" : "NOT_STARTED",
    featurePipeline: "READY", // backend/ml/featureSchema.ts
    labelPipeline: "READY", // backend/ml/labelBuilder.ts
    minimumObservations: minReached ? "REACHED" : "NOT_REACHED",
    observations: todaySnapshots,
    minObservationsRequired: MIN_OBSERVATIONS_FOR_TRAINING,
    modelTraining: MODEL_TRAINING_ENABLED ? "ENABLED" : "DISABLED",
  });
});

// ---- Backtest (Dhan historical data) - PRICE/TECHNICAL LOGIC ONLY ----
// Deliberately does NOT include OI walls, PCR, or the Master Trade Selector:
// Dhan's historical API has no live option-chain snapshot history, so that
// part of the live strategy cannot be reconstructed here. Reuses the exact
// same runBacktest() engine (signals/score.ts's EMA/Supertrend/VWAP/MACD/RSI/
// Bollinger composite) already used by the Groww-backed per-symbol backtest -
// no new strategy logic, just a different candle source and a longer lookback.
router.get("/backtest-dhan/symbols", requirePermission("backtesting"), (_req: Request, res: Response) => {
  const symbols = DEFAULT_SYMBOLS.filter((d) => d.fno).map((d) => ({ symbol: d.symbol, name: d.name, type: d.type }));
  res.json({ symbols });
});

// DATA MODE status - shown verbatim on the backtest UI so it's never implied
// that a historical OI backtest ran when it didn't. historicalFullOptionChain
// reflects historicalOptionChainProvider's real (currently NOT_AVAILABLE)
// state, not a hardcoded string, so this stays honest if a provider is ever
// plugged in later.
router.get("/backtest-dhan/data-mode", requirePermission("backtesting"), async (_req: Request, res: Response) => {
  const probe = await historicalOptionChainProvider.getSnapshot(0, "^NSEI", "");
  const chainAvailable = probe !== "NOT_AVAILABLE";
  res.json({
    technicalData: "AVAILABLE",
    historicalFullOptionChain: chainAvailable ? "AVAILABLE" : "NOT_AVAILABLE",
    historicalOiBacktest: chainAvailable ? "AVAILABLE" : "BLOCKED",
    provider: historicalOptionChainProvider.name,
    defaultMode: DEFAULT_BACKTEST_MODE,
  });
});

const DHAN_INTERVAL_TO_APP: Record<DhanBacktestInterval, Interval> = { "1d": "1d", "5": "5m", "15": "15m", "60": "60m" };
// runBacktest()'s end-of-day square-off assumes multiple bars per calendar
// day (true for intraday candles). Fed daily bars, EVERY bar is its own "new
// day" relative to the previous one, so every position opens and immediately
// closes on the same bar (confirmed live: gross P&L always 0, pure cost
// drag). Restricting this endpoint to intraday intervals avoids handing back
// a backtest result that looks real but is a fixed cost-drag artifact.
const DHAN_BACKTESTABLE_INTERVALS: DhanBacktestInterval[] = ["5", "15", "60"];

router.post("/backtest-dhan/run", requirePermission("backtesting"), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const def = findSymbolDef(String(b.symbol || ""));
    if (!def) return res.status(400).json({ error: "Unknown symbol." });
    if (!DHAN_BACKTESTABLE_INTERVALS.includes(String(b.interval) as DhanBacktestInterval)) {
      return res.status(400).json({ error: "Interval must be 5, 15, or 60 (minutes) — daily bars don't work with this engine's end-of-day square-off logic." });
    }
    const dhanInterval = String(b.interval) as DhanBacktestInterval;
    const fromDate = String(b.fromDate || "");
    const toDate = String(b.toDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      return res.status(400).json({ error: "fromDate/toDate must be yyyy-mm-dd." });
    }
    const sec = await lookupDhanSecurity(def.nseSymbol || def.symbol);
    if (!sec) return res.status(400).json({ error: `No Dhan instrument mapping found for ${def.symbol}.` });

    const cacheKey = `dhan-backtest-candles:${def.symbol}:${dhanInterval}:${fromDate}:${toDate}`;
    const candles = await cached(cacheKey, 10 * 60_000, () => fetchDhanCandles(sec, dhanInterval, fromDate, toDate));
    if (!candles || candles.length < 60) {
      return res.status(404).json({ error: "Not enough Dhan candles in this range to backtest (need 60+)." });
    }

    // BACKTEST_MODE gate - see backend/backtest/backtestMode.ts. FULL_MASTER
    // is checked BEFORE any scoring/candidate work: it fails safely (no
    // fabricated OI, arbitrate() never called) since no historical
    // full-option-chain provider exists yet.
    const mode: BacktestMode = b.mode === "FULL_MASTER" ? "FULL_MASTER" : "TECHNICAL_ONLY";
    if (mode === "FULL_MASTER") {
      try {
        const snapshots = buildMarketSnapshots(def.symbol, candles);
        const masterResult = await runMasterSelectorBacktest(mode, def.symbol, "", snapshots);
        // Not reachable today (runMasterSelectorBacktest always throws for
        // FULL_MASTER — see that file) but handled for when a real provider
        // makes this path live.
        return res.json(masterResult);
      } catch (e: any) {
        if (e instanceof FullMasterUnavailableError) {
          return res.status(409).json({ mode, blocked: true, error: e.message });
        }
        throw e;
      }
    }

    const appInterval = DHAN_INTERVAL_TO_APP[dhanInterval];
    const params = {
      stopLossPercent: b.sl != null ? Number(b.sl) : undefined,
      targetPercent: b.target != null ? Number(b.target) : undefined,
      allowShort: b.short != null ? !!b.short : undefined,
      entryThreshold: b.threshold != null ? Number(b.threshold) : undefined,
    };
    const result = runBacktest(def.symbol, appInterval, candles, params);

    // Informational-only reads (NOT part of the entry/exit decision above) -
    // the same live functions used elsewhere in the app, evaluated once on the
    // final bars of this candle series, so the user can see where these three
    // signals stood at the end of the tested window.
    let informational: any = {};
    try {
      const closes = candles.map((c) => c.close);
      const lastPrice = closes[closes.length - 1];
      const emaConfluence = emaConfluenceDirection(lastPrice, closes);
      const burst = computeMomentumBurst(def.symbol, candles as any);
      const regime = classifyRegime(candles as any);
      informational = {
        emaConfluence,
        momentumBurst: { state: burst.state, direction: burst.direction, squeezeOn: burst.squeezeOn },
        marketRegime: regime ? { state: regime.state, label: regime.label } : null,
      };
    } catch { informational = {}; }

    res.json({ ...result, mode, dhanInterval, fromDate, toDate, informational });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Dhan backtest failed" });
  }
});

async function scanOiGridsForPing(): Promise<any[]> {
  const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  const out: any[] = [];
  for (const def of defs) {
    try {
      const g = await cached(`oi-command:${def.symbol}`, 15_000, () => buildOiCommand(def));
      if (g) out.push(g);
    } catch (e) { console.error(`[api] skipped ${def.symbol}:`, e instanceof Error ? e.message : e); }
  }
  return out;
}

// OI Command LOGIC REVIEW: today's logged signals (≥ conf), how many were correct
// (15-min horizon), + the last N correct signals with their time.
router.get("/oi-command/review", (req: Request, res: Response) => {
  const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
  const minConf = req.query.conf != null ? Number(req.query.conf) : 80;
  res.json(reviewOiSignals(symbol, minConf, 7));
});
// OI COMMAND BACK-TEST: for a given day (default today), back-test the grid's
// concrete recommendation on REAL Groww option + spot candles. Two parts:
//   live  - build the CURRENT grid setup and simulate that exact ATM CE/PE trade
//           (grid targets/stop) across the session, plus its 5/15/60m direction.
//   log   - replay every OI-Command signal logged for that day (track record).
// NOTE: historical intraday OI can't be reconstructed, so the DIRECTION read is
// the grid's live read applied from the entry time; the option P&L path is real.
// Default back-test date: the last likely TRADING day in IST. Before 09:15 IST
// (session not started) or on weekends we step back so we never ask Groww for a
// future/non-trading day (which errors). Holidays are not tracked - if the picked
// day has no candles the response says so and the user can pass ?date=YYYY-MM-DD.
function lastTradingDateIST(): string {
  const IST = 19800000;
  let ms = Date.now() + IST;
  const d0 = new Date(ms);
  const minutesOfDay = d0.getUTCHours() * 60 + d0.getUTCMinutes();
  if (minutesOfDay < 9 * 60 + 15) ms -= 24 * 60 * 60 * 1000; // before open -> previous day
  for (let i = 0; i < 7; i++) {
    const d = new Date(ms);
    const dow = d.getUTCDay(); // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
    ms -= 24 * 60 * 60 * 1000;
  }
  return new Date(ms).toISOString().slice(0, 10);
}
router.get("/oi-command/backtest", async (req: Request, res: Response) => {
  if (getProvider().name !== "groww") return res.json({ available: false, message: "OI Command back-test के लिए Groww feed चाहिए।" });
  const def = findSymbolDef(String(req.query.symbol || "^NSEI"));
  if (!def || !def.fno) return res.status(400).json({ available: false, error: "valid F&O symbol चाहिए" });
  const date = req.query.date ? String(req.query.date) : lastTradingDateIST();
  const entryHM = req.query.entry ? String(req.query.entry) : "09:20";
  try {
    const provider = getProvider() as GrowwProvider;
    // 1) Live grid setup -> simulate that exact recommended option trade for the day.
    let live: any = { available: false, message: "grid setup अभी उपलब्ध नहीं।" };
    try {
      const grid = await buildOiCommand(def);
      if (grid && grid.available && grid.setup) {
        const sim = await simulateOiOptionTrade(provider, {
          symbol: def.symbol, optionType: grid.setup.optionType, strike: grid.setup.strike,
          expiry: /^\d{4}-\d{2}-\d{2}$/.test(grid.expiry || "") ? grid.expiry : undefined,
          date, entryHM, direction: grid.oiDirection,
          expLow: Math.abs(grid.expectedMove?.low ?? Math.max(5, Math.round(grid.spot * 0.0015))),
          // Entry premium is taken from the ACTUAL option candle at entryHM (not the
          // live LTP) so a morning entry back-tests against the real opening price.
        });
        live = {
          available: true,
          setup: {
            direction: grid.oiDirection, optionType: grid.setup.optionType, strike: grid.setup.strike,
            action: grid.setup.action, confidence: grid.setup.confidence, spot: grid.spot,
            expectedMove: grid.expectedMove, expiry: grid.expiry,
          },
          simulation: sim,
        };
      } else {
        live = { available: false, message: grid?.message || "grid setup नहीं बना।" };
      }
    } catch (e: any) {
      live = { available: false, message: e?.message || "live grid back-test विफल।" };
    }
    // 2) Replay the day's logged signals (real track record).
    const log = await backtestOiCommandLog(provider, { date, symbol: def.symbol });
    res.json({ available: true, symbol: def.symbol, name: def.name, date, entry: entryHM, live, log });
  } catch (e: any) {
    res.status(502).json({ available: false, error: e?.message || "oi-command backtest failed" });
  }
});

// ============================ Option Top Pick — stock scanner (backend/optionTopPick/) ============================
// Dependency-injected per OptionTopPickDeps so backend/optionTopPick/ never imports
// upward from routes/ (circular). getOi() never throws — a chain that's genuinely
// unavailable for a given stock degrades that candidate gracefully instead of
// failing the whole scan.
const otpDeps: OptionTopPickDeps = {
  listEligibleStocks: () => DEFAULT_SYMBOLS.filter((d) => d.type === "equity" && d.fno),
  getCandles: (symbol, interval) => getCandlesCached(symbol, interval as Interval),
  getOi: async (symbol) => {
    const d = findSymbolDef(symbol);
    if (!d) return null;
    try { return await getOiCached(d); } catch { return null; }
  },
  nowEpochSec: () => Math.floor(Date.now() / 1000),
};

// Scanning ~60 stocks (candles + OI chain each) is expensive - cached like
// /top-picks so repeated tab views/refreshes within the window are free.
router.get("/option-top-pick/scan", async (_req: Request, res: Response) => {
  try {
    const result = await cached("otp:scan", 90_000, () => scanOptionTopPick(otpDeps));
    res.json(result);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Option Top Pick scan failed" });
  }
});

router.get("/option-top-pick/:symbol", async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol;
    const def = findSymbolDef(symbol);
    if (!def) return res.status(404).json({ error: `Unknown symbol: ${symbol}` });
    const result = await evaluateStockBothTracks(symbol, otpDeps);
    res.json(result);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to evaluate Option Top Pick" });
  }
});

router.get("/option-top-pick/:symbol/audit", (req: Request, res: Response) => {
  try {
    res.json({ entries: getOptionTopPickAuditLog({ symbol: req.params.symbol, limit: Number(req.query.limit) || 50 }) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to read audit log" });
  }
});

// ============================ Liquidity Status (backend/liquidityStatus/) ============================
// Same dependency-injection convention as Option Top Pick's otpDeps above - kept
// as a separate deps object (not reused) since getOi()'s contract differs
// slightly (returns OiAnalysis | null here vs a thrown/degraded OiAnalysis there).
const liquidityStatusDeps: LiquidityStatusDeps = {
  listEligibleStocks: () => DEFAULT_SYMBOLS.filter((d) => d.type === "equity" && d.fno),
  getCandles: (symbol, interval) => getCandlesCached(symbol, interval as Interval),
  getOi: async (symbol) => {
    const d = findSymbolDef(symbol);
    if (!d) return null;
    try { return await getOiCached(d); } catch { return null; }
  },
  nowEpochSec: () => Math.floor(Date.now() / 1000),
};

router.get("/liquidity-status/:symbol", async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol;
    const def = findSymbolDef(symbol);
    if (!def) return res.status(404).json({ error: `Unknown symbol: ${symbol}` });
    const result = await cached(`ls:${symbol}`, 15_000, () => evaluateLiquidityStatus(symbol, liquidityStatusDeps));
    res.json(result);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Liquidity Status evaluation failed" });
  }
});

router.get("/liquidity-status/scan/movers", async (_req: Request, res: Response) => {
  try {
    const result = await cached("ls:scan", 90_000, () => scanLiquidityStatus(liquidityStatusDeps));
    res.json(result);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Liquidity Status scan failed" });
  }
});

router.get("/liquidity-status/:symbol/audit", (req: Request, res: Response) => {
  try {
    res.json({ entries: getLiquidityStatusAuditLog({ symbol: req.params.symbol, limit: Number(req.query.limit) || 50 }) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to read audit log" });
  }
});

router.get("/top-picks", async (_req: Request, res: Response) => {
  try {
  // 3-min cache: the enrichment fetches the option chain (getOiCached) per pick,
  // so re-running too often (60s) hammered Groww and returned HTTP 429 on the
  // chains. 3 min matches OI's natural update cadence and keeps the chain API
  // safe; the tab's auto-refresh mostly re-serves cache and re-renders (cheap).
  const data = await cached("top-picks", 60_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tfToInterval: Record<Tf, Interval> = { "5m": "5m", "15m": "15m", "1h": "60m", "1d": "1d" };
    const universe = DEFAULT_SYMBOLS.filter((d) => d.type === "equity" && d.fno);
    const fetchOne = async (def: SymbolDef) => {
      try {
        const byTf: any = {};
        await Promise.all(
          TOP_PICK_TFS.map(async (tf) => {
            try { byTf[tf] = await getCandlesCached(def.symbol, tfToInterval[tf]); } catch { byTf[tf] = []; }
          }),
        );
        let clean: any = null;
        try { const cm = await getCleanRatingCached(def.symbol, def.name); if (cm) clean = { rating: cm.rating, grade: cm.grade }; } catch { /* optional */ }
        const pick = computeTopPick(def.symbol, def.name, def, byTf, clean);
        if (pick) {
          (pick as any).sector = def.sector || null;
          // Relative volume (participation quality) — from 15m (fallback 5m) candles.
          (pick as any).rvol = relVolNow(byTf["15m"]) ?? relVolNow(byTf["5m"]);
          Object.assign(pick, sessionChartFacts(byTf["15m"], byTf["5m"]));
        }
        return pick;
      } catch { return null; }
    };
    // INDICES first (only 4) with a retry, so they get the fresh rate budget and
    // don't get dropped after the 25-stock scan exhausts it.
    const indexDefs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
    const allIndex: any[] = [];
    for (const def of indexDefs) {
      let p = await fetchOne(def);
      if (!p) { await sleep(300); p = await fetchOne(def); }
      if (p) allIndex.push(p);
    }
    const BATCH = 5;
    const all: any[] = [];
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      all.push(...(await Promise.all(chunk.map(fetchOne))).filter(Boolean));
      if (i + BATCH < universe.length) await sleep(150);
    }
    const rankList = (arr: any[], key: string) =>
      arr.slice().sort((a, b) => b[key] - a[key]).map((p, i) => ({ ...p, rank: i + 1 }));
    const intradayTop5 = rankList(all.filter((p) => p.intradaySuited), "intradayScore").slice(0, 5);
    const optionTop5 = rankList(all.filter((p) => p.optionSuited), "optionScore").slice(0, 5);
    const overall = rankList(all, "probability").slice(0, 10);
    // PER-TIMEFRAME option picks: for each of 5m/15m/1h, rank F&O stocks by THAT
    // timeframe's own signal strength (confidence + |score|), with the CE/PE the
    // timeframe implies and its own timing. Answers "5m / 15m / 1h top option picks".
    const perTfHorizon: Record<string, string> = { "5m": "Fast (scalp)", "15m": "Intraday", "1h": "Positional intraday", "1d": "Positional / swing (daily)" };
    // Rank a set of picks per timeframe (5m/15m/1d) - reused for stocks AND indices.
    const rankByTf = (picks: any[]): Record<string, any[]> => {
      const out: Record<string, any[]> = {};
      for (const tf of ["5m", "15m", "1d"] as Tf[]) {
      const rows = picks
        .filter((p) => p.isFno)
        .map((p) => {
          const ts = (p.tfSignals || []).find((t: any) => t.tf === tf);
          if (!ts || ts.dir === 0) return null;
          const tfRankScore = Math.round(ts.confidence * 0.6 + Math.min(Math.abs(ts.score), 100) * 0.4);
          // Move leftover in THIS row's direction (don't rank a spent move as "best").
          // signed to the row's CE/PE side; potential left = daily-ATR range minus
          // what's already been used up (only counts favourable movement).
          const exp = p.expectedDayMovePct;
          const movedPct = p.todayMoveRawPct == null ? null : Math.round((ts.dir > 0 ? p.todayMoveRawPct : -p.todayMoveRawPct) * 100) / 100;
          const remainingPct = exp != null && movedPct != null ? Math.round(Math.max(0, exp - Math.max(0, movedPct)) * 100) / 100 : null;
          const progressPct = exp != null && exp > 0 && movedPct != null ? Math.round(Math.min(100, Math.max(0, (Math.max(0, movedPct) / exp) * 100))) : null;
          // LIVE-CONFLICT check (human-mind): the segment shows a HIGHER-timeframe
          // bias, but the fast (5m) signal or today's move may be going the OTHER
          // way right now (pullback / early reversal). Flag it so the user doesn't
          // buy a CE into an active sell-off (the Axis-Bank-1h-Bull-but-falling case).
          const fast = (p.tfSignals || []).find((t: any) => t.tf === "5m");
          const fastDir = fast ? fast.dir : 0;
          const againstFast = fastDir !== 0 && fastDir !== ts.dir;
          const againstToday = p.todayMoveRawPct != null && ((ts.dir > 0 && p.todayMoveRawPct < -0.3) || (ts.dir < 0 && p.todayMoveRawPct > 0.3));
          let warn: string | null = null;
          if (againstFast || againstToday) {
            const bits: string[] = [];
            if (againstFast && fast) bits.push(`5m ${fast.label}`);
            if (againstToday) bits.push(`${p.todayMoveRawPct > 0 ? "+" : ""}${p.todayMoveRawPct}% today`);
            warn = `Moving AGAINST this call right now (${bits.join(", ")}). This is a ${tf} / higher-timeframe bias; the immediate move is the other way — a pullback or early reversal. Wait for the ${ts.dir > 0 ? "sell-off to stall and turn up" : "bounce to stall and turn down"} before buying ${ts.dir > 0 ? "CE" : "PE"}.`;
          }
          // DIRECTIONAL MOVEMENT (ADX/DMI) on this row's timeframe: which way the
          // trend points (+DI vs -DI), how strong it is (ADX), and whether that
          // agrees with this CE/PE call — so the user can take directional trades
          // only when a real trend backs the call.
          const adxV = ts.adx, plusDI = ts.plusDI, minusDI = ts.minusDI;
          let dmDir: string | null = null, dmStrength: string | null = null, dmAgree: boolean | null = null, dmTradeable = false;
          if (adxV != null && plusDI != null && minusDI != null) {
            dmDir = plusDI >= minusDI ? "Bullish" : "Bearish";
            dmStrength = adxV >= 40 ? "Very strong" : adxV >= 25 ? "Strong" : adxV >= 20 ? "Building" : "No trend";
            dmAgree = dmDir === (ts.dir > 0 ? "Bullish" : "Bearish");
            dmTradeable = adxV >= 25 && dmAgree; // strong trend that backs the call
          }
          return {
            symbol: p.symbol, name: p.name, price: p.price, isFno: p.isFno, sector: p.sector || null,
            tf, horizon: perTfHorizon[tf],
            direction: ts.dir > 0 ? "Bullish" : "Bearish",
            optionType: ts.dir > 0 ? "CE" : "PE",
            tfScore: ts.score, tfConfidence: ts.confidence, tfLabel: ts.label, timing: ts.timing,
            rvol: p.rvol ?? null,
            movedPct, targetMovePct: exp, remainingPct, progressPct, warn,
            adx: adxV, plusDI, minusDI, dmDir, dmStrength, dmAgree, dmTradeable,
            runStartAt: ts.runStartAt ?? null, runStartPrice: ts.runStartPrice ?? null,
            runMovePct: ts.runMovePct ?? null, runBarsAgo: ts.runBarsAgo ?? null,
            runState: ts.runState ?? null, expContinuePct: ts.expContinuePct ?? null,
            tfRankScore, alignment: p.alignment, probability: p.probability,
            atrPct: p.atrPct, cleanRating: p.cleanRating, cleanGrade: p.cleanGrade,
            tfSignals: p.tfSignals,
            sod15High: p.sod15High ?? null, sod15Low: p.sod15Low ?? null,
            day15High: p.day15High ?? null, day15Low: p.day15Low ?? null,
            candle5m: p.candle5m ?? null, candle5mBias: p.candle5mBias ?? 0,
            candle5mGood: !!p.candle5mGood, candle5mReason: p.candle5mReason ?? "",
          };
        })
        .filter(Boolean) as any[];
      const oppScore = (r: any) => {
        let s = 40;
        if (r.runState === "Running") s += 34;
        else if (r.runState === "Stalling") s += 6;
        else if (r.runState === "Range") s -= 38;
        if (r.timing === "READY TO MOVE") s += 30;
        else if (r.timing === "UNDERWAY") s += 10;
        else if (r.timing === "EXTENDED") s -= 42;
        if (r.remainingPct != null) s += Math.min(32, r.remainingPct * 12);
        if (r.progressPct != null) s -= Math.max(0, r.progressPct - 40) * 0.75;
        if (r.expContinuePct != null) s += Math.min(20, r.expContinuePct * 9);
        if (r.runBarsAgo != null && r.runBarsAgo <= 1) s += 14;
        if (r.warn) s -= 24;
        if (r.dmTradeable && r.runState === "Running") s += 8;
        s += (r.tfRankScore || 0) * 0.06;
        return Math.round(s);
      };
      const isSpent = (r: any) =>
        r.runState === "Range" || r.timing === "EXTENDED" || (r.progressPct != null && r.progressPct >= 82);
      const fresh = rows.filter((r) => !isSpent(r) || (r.remainingPct != null && r.remainingPct >= 0.75));
      const ranked = (fresh.length ? fresh : rows)
        .map((r) => ({ ...r, oppScore: oppScore(r), late: isSpent(r) }))
        .sort((a, b) => b.oppScore - a.oppScore)
        .slice(0, 6)
        .map((p, i) => ({ ...p, rank: i + 1 }));
      out[tf] = ranked;
      }
      return out;
    };
    const byTf = rankByTf(all);
    // F&O INDICES ranked the same way (scanned first, above) for the Index Top Pick tab.
    const byTfIndex = rankByTf(allIndex);
    // 1H-candle breakout watch for the indices (nearest to cross prior hour's high/low).
    const indexHourBreak: any[] = [];
    for (const def of indexDefs) {
      try {
        const c60 = await getCandlesCached(def.symbol, "60m");
        const hb = computeHourBreak(def.symbol, def.name, c60);
        if (hb) indexHourBreak.push(hb);
      } catch { /* skip */ }
    }
    indexHourBreak.sort((a, b) => {
      if (!!a.late !== !!b.late) return a.late ? 1 : -1;
      return (b.imminent ? 1 : 0) - (a.imminent ? 1 : 0) || a.nearestPct - b.nearestPct;
    });
    // Enrich each displayed pick with the BEST LOW-DECAY option to buy now (premium
    // + theta) from the live chain. Chains are shared with the OI-change cache.
    const enrichSyms = new Set<string>();
    for (const tf of Object.keys(byTf)) for (const r of byTf[tf]) enrichSyms.add(r.symbol);
    for (const tf of Object.keys(byTfIndex)) for (const r of byTfIndex[tf]) enrichSyms.add(r.symbol);
    const oiMap = new Map<string, any>();
    for (const sym of enrichSyms) {
      const def = findSymbolDef(sym);
      if (!def || !def.fno) continue;
      try { oiMap.set(sym, await getOiCached(def)); } catch { /* skip */ }
    }
    // MAJOR OI MOVEMENT with strike + % — PREFER the OI-change snapshot (real
    // intraday build-up % vs the day's baseline: maxCeBuildup = resistance being
    // written, maxPeBuildup = support being written). Fall back to the heaviest
    // absolute OI wall (from the cached chain) when no baseline is formed yet.
    const oiChangeBySym = new Map<string, any>((oiChangeSnap.rows || []).map((row: any) => [row.symbol, row]));
    const majorFromWalls = (oi: any) => {
      const rows: any[] = oi.topStrikes || [];
      if (!rows.length) return null;
      let ce = rows[0], pe = rows[0];
      for (const r of rows) { if ((r.ceOi || 0) > (ce.ceOi || 0)) ce = r; if ((r.peOi || 0) > (pe.peOi || 0)) pe = r; }
      return {
        oiCeStrike: ce.strike, oiCeVal: Math.round(ce.ceOi || 0), oiCePct: null, oiCeVeryHigh: false,
        oiPeStrike: pe.strike, oiPeVal: Math.round(pe.peOi || 0), oiPePct: null, oiPeVeryHigh: false,
        oiIsBuildup: false, oiSupport: oi.support ?? null, oiResistance: oi.resistance ?? null,
      };
    };
    const enrich = (r: any) => {
      const oi = oiMap.get(r.symbol);
      if (!oi || !oi.available || !oi.topStrikes?.length || !oi.underlying) return;
      const opt = bestLowDecayOption(oi, oi.underlying, r.direction);
      if (opt) Object.assign(r, opt);
      const sides = atmDecaySides(oi, oi.underlying);
      Object.assign(r, sides);
      if (r.optionType && sides.decayHot && sides.decayHot !== "even" && r.optionType === sides.decayHot) {
        r.decaySideWarn = true;
      }
      // Prefer real build-up (movement) from the OI-change snapshot.
      const oc = oiChangeBySym.get(r.symbol);
      if (oc && (oc.maxCeBuildup || oc.maxPeBuildup)) {
        Object.assign(r, {
          oiCeStrike: oc.maxCeBuildup?.strike ?? null, oiCeVal: oc.maxCeBuildup?.oiChg ?? null, oiCePct: oc.maxCeBuildup?.oiChgPct ?? null, oiCeVeryHigh: !!oc.maxCeBuildup?.veryHigh,
          oiPeStrike: oc.maxPeBuildup?.strike ?? null, oiPeVal: oc.maxPeBuildup?.oiChg ?? null, oiPePct: oc.maxPeBuildup?.oiChgPct ?? null, oiPeVeryHigh: !!oc.maxPeBuildup?.veryHigh,
          oiIsBuildup: true, oiSupport: oc.levels?.support ?? oi.support ?? null, oiResistance: oc.levels?.resistance ?? oi.resistance ?? null,
        });
      } else {
        const mo = majorFromWalls(oi);
        if (mo) Object.assign(r, mo);
      }
    };
    for (const tf of Object.keys(byTf)) byTf[tf].forEach(enrich);
    for (const tf of Object.keys(byTfIndex)) byTfIndex[tf].forEach(enrich);
    const bestCase = attachBestCase(byTf, byTfIndex);
    return { overall, intradayTop5, optionTop5, byTf, byTfIndex, indexHourBreak, bestCase, scanned: all.length, scannedIndex: allIndex.length };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), timeframes: TOP_PICK_TFS, ...data,
    disclaimer:
      "Top Picks rank leftover opportunity (fresh run + room left), not a move that already happened. " +
      "Probability is a model estimate, not a guarantee. GO = still time. LATE = already spent — do not chase.",
  });
  } catch (e: any) {
    res.status(504).json({ error: e?.message || "top-picks timed out" });
  }
});

// Fast Trader Mind win-case (index + stock). Uses top-picks cache when warm;
// otherwise a 4-index + 8-stock 5m/15m scan so Monday morning does not hang.
router.get("/best-case", async (_req: Request, res: Response) => {
  try {
    const hit = _cache.get("top-picks") as { ts: number; v: any } | undefined;
    let best = hit?.v?.bestCase;
    if (!best || Date.now() - (hit?.ts || 0) > 90_000) {
      best = await cached("best-case", 30_000, () => withTimeout(scanMindBestCase(), 12_000, "best-case"));
    }
    res.json({
      generatedAt: Math.floor(Date.now() / 1000),
      marketOpen: isTradingTimeIST(),
      feedWindow: isFeedWindowIST(),
      ...best,
      disclaimer: "Separate from leftover Top Pick. Only early directional CE/PE with 5m+15m agreement. WAIT if nothing qualifies.",
    });
  } catch {
    res.json({
      generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), feedWindow: isFeedWindowIST(),
      index: null, stock: null, wait: "Groww still warming feeds — Trader Mind will fill as soon as candles arrive.",
    });
  }
});

// Bull % ranking: for each stock, the share of UP days over ?days of daily
// history (default 120). Ranks stocks by historical upward bias, with a recent
// 20-day bull %, window return, avg up/down day, and current streak.
router.get("/bull-rank", async (req: Request, res: Response) => {
  const days = Math.max(20, Math.min(400, Number(req.query.days) || 120));
  const data = await cached(`bull-rank:${days}`, 10 * 60_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const universe = DEFAULT_SYMBOLS.filter((d) => d.type === "equity");
    const out: any[] = [];
    const BATCH = 5;
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      const part = await Promise.all(chunk.map(async (def) => {
        try {
          const daily = await getDailyCached(def.symbol, days + 5);
          const st: any = computeBullStats(def.symbol, def.name, daily, 20);
          if (st) { st.sector = def.sector || null; st.isFno = def.fno === true; }
          return st;
        } catch { return null; }
      }));
      out.push(...part.filter(Boolean));
      if (i + BATCH < universe.length) await sleep(120);
    }
    out.sort((a, b) => b.bullPct - a.bullPct).forEach((p, i) => (p.rank = i + 1));
    return { rows: out, scanned: out.length };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), days, ...data,
    disclaimer:
      "Bull % = share of UP days (close > previous close) over the selected daily-history window. It is a HISTORICAL TENDENCY, " +
      "not a prediction - a stock's regime can change. Use it to see which names have a persistent upward (or downward) bias.",
  });
});

// Opening Range Breakout (ORB): first N-min range break on indices + liquid F&O
// stocks. Suggests CE (long break) / PE (short break) with entry/stop/target.
router.get("/orb", async (req: Request, res: Response) => {
  const orMinutes = Math.max(15, Math.min(60, Number(req.query.minutes) || 30));
  const data = await cached(`orb:${orMinutes}`, 60_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const indices = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
    const stocks = DEFAULT_SYMBOLS.filter((d) => d.type === "equity" && d.fno).slice(0, 12);
    const universe = [...indices, ...stocks];
    const fetchOne = async (def: SymbolDef) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const intraday = await getCandlesCached(def.symbol, "15m");
          const sig = computeORB(def.symbol, def.name, intraday, orMinutes);
          if (sig) (sig as any).isIndex = def.type === "index";
          return sig;
        } catch { if (attempt === 0) await sleep(250); }
      }
      return null;
    };
    const BATCH = 6;
    const results: any[] = [];
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      results.push(...(await Promise.all(chunk.map(fetchOne))).filter(Boolean));
      if (i + BATCH < universe.length) await sleep(120);
    }
    // Breakouts first (by confidence), then inside/forming.
    const rank = (s: any) => (s.state === "Long" || s.state === "Short" ? 1000 + s.confidence : s.state === "Inside" ? 100 : 0);
    results.sort((a, b) => rank(b) - rank(a));
    return { picks: results, session: results[0]?.session ?? null };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), orMinutes, session: data.session, picks: data.picks,
    disclaimer:
      "Opening Range Breakout: trade the break of the first " + orMinutes + "m high/low. Indices have no volume feed so the " +
      "volume-confirmation is neutral there. Breakouts fail often - always use the range's other end as the stop.",
  });
});

// ---- Option-SELLING (premium/theta) ----
const istMinutesNow = () => { const d = new Date(Date.now() + 19800000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const sellDeps = (): SellTickDeps => ({
  marketOpen: isTradingTimeIST(),
  minutesIST: istMinutesNow(),
  nowEpoch: Math.floor(Date.now() / 1000),
  getChain: async (symbol: string) => {
    const def = findSymbolDef(symbol);
    if (!def) return null;
    return (await getOiCached(def)) as OiAnalysis;
  },
});

// Recommended selling structures (straddle/strangle/condor) for the indices.
router.get("/option-sell", async (_req: Request, res: Response) => {
  if (getProvider().name !== "groww") {
    return res.json({ available: false, message: "Option-selling needs the live Groww option chain (connect Groww).", strategies: [] });
  }
  const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  const strategies: any[] = [];
  for (const def of defs) {
    try {
      const [oi, candles, daily] = await Promise.all([
        getOiCached(def) as Promise<OiAnalysis>,
        getCandlesCached(def.symbol, "15m"),
        getDailyCached(def.symbol, 40),
      ]);
      const adxV = candles && candles.length >= 40 ? last(adx(candles, 14).adx) : null;
      const atrV = daily && daily.length >= 20 ? last(atr(daily, 14)) : null;
      if (oi?.available) strategies.push(...buildSellStrategies(oi, def, { adx: adxV ?? null, atr: atrV ?? null }));
    } catch { /* skip */ }
  }
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), strategies,
    recommended: strategies.filter((s) => s.recommended),
    disclaimer:
      "Option SELLING is HIGH RISK - naked straddle/strangle have UNDEFINED loss. " +
      "High-prob picks require a RANGE day (ADX < 22) + POP ≥ 65% and prefer Iron Condor. " +
      "That is a selectivity target, not an 80% guarantee. Paper/education only; always run the tail stop.",
  });
});

// Start a sell-paper run with a chosen structure. ?symbol=^NSEI&type=Iron%20Condor&capital=200000
router.get("/option-sell/start", async (req: Request, res: Response) => {
  if (getProvider().name !== "groww") return res.status(400).json({ error: "Connect Groww for the live option chain." });
  const symbol = (req.query.symbol as string) || "^NSEI";
  const type = (req.query.type as string) || "Iron Condor";
  const capital = Math.max(0, Number(req.query.capital) || 200000);
  const def = findSymbolDef(symbol);
  if (!def) return res.status(404).json({ error: "Unknown symbol." });
  try {
    const [oi, candles, daily] = await Promise.all([
      getOiCached(def) as Promise<OiAnalysis>,
      getCandlesCached(def.symbol, "15m"),
      getDailyCached(def.symbol, 40),
    ]);
    const adxV = candles && candles.length >= 40 ? last(adx(candles, 14).adx) : null;
    const atrV = daily && daily.length >= 20 ? last(atr(daily, 14)) : null;
    const strategies = buildSellStrategies(oi, def, { adx: adxV ?? null, atr: atrV ?? null });
    const chosen = strategies.find((s) => s.type === type) || strategies.find((s) => s.recommended) || strategies[0];
    if (!chosen) return res.status(404).json({ error: "Could not build a structure from the current chain." });
    res.json(startSell(chosen, capital, istDateStr()));
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to start sell paper." });
  }
});
router.get("/option-sell/mark", async (_req: Request, res: Response) => {
  try { res.json(await markSell(sellDeps())); } catch (e: any) { res.status(502).json({ error: e?.message || "mark failed" }); }
});
router.get("/option-sell/state", (_req: Request, res: Response) => res.json(getSellSummary()));
router.get("/option-sell/stop", (_req: Request, res: Response) => res.json(stopSell()));

// ---- OPTION TRADE BACK-TEST / REVIEW (commentary in Hindi) ----
// Underlyings the user can back-test (F&O indices + stocks).
router.get("/backtest/option/underlyings", (_req: Request, res: Response) => {
  const list = DEFAULT_SYMBOLS.filter((d) => d.fno).map((d) => ({
    symbol: d.symbol, name: d.name, type: d.type,
    nseSymbol: d.nseSymbol || d.symbol.replace(/\.NS$/i, ""),
  }));
  res.json({ underlyings: list, provider: getProvider().name });
});

// Available expiries for a chosen underlying (from the Groww instruments master).
router.get("/backtest/option/meta", async (req: Request, res: Response) => {
  try {
    const def = findSymbolDef(String(req.query.symbol || ""));
    const underlying = (def?.nseSymbol || String(req.query.symbol || "").replace(/\.NS$/i, "")).toUpperCase();
    if (!underlying) return res.status(400).json({ error: "symbol required" });
    if (!(await hasOptionData(underlying))) {
      return res.json({ underlying, expiries: [], message: `${underlying} के लिए option data नहीं मिला।` });
    }
    const expiries = await optionExpiries(underlying);
    res.json({ underlying, name: def?.name || underlying, expiries });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "meta failed" });
  }
});

// Strikes for an underlying + expiry (optionally one side).
router.get("/backtest/option/strikes", async (req: Request, res: Response) => {
  try {
    const def = findSymbolDef(String(req.query.symbol || ""));
    const underlying = (def?.nseSymbol || String(req.query.symbol || "").replace(/\.NS$/i, "")).toUpperCase();
    const expiry = String(req.query.expiry || "");
    if (!underlying || !expiry) return res.status(400).json({ error: "symbol and expiry required" });
    const type = req.query.type === "CE" || req.query.type === "PE" ? (req.query.type as "CE" | "PE") : undefined;
    const strikes = await optionStrikes(underlying, expiry, type);
    res.json({ underlying, expiry, strikes });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "strikes failed" });
  }
});

// Live premium CANDLES for one option strike (clicked in the chain) → its chart.
// /api/option-candles?symbol=^NSEI&type=PE&strike=23900&expiry=2026-09-08&interval=15
router.get("/option-candles", async (req: Request, res: Response) => {
  const provider = getProvider();
  if (provider.name !== "groww") return res.json({ available: false, message: "Option chart के लिए Groww चाहिए।" });
  const def = findSymbolDef(String(req.query.symbol || ""));
  const underlying = (def?.nseSymbol || String(req.query.symbol || "").replace(/\.NS$/i, "")).toUpperCase();
  const type = req.query.type === "PE" ? "PE" : "CE";
  const strike = Number(req.query.strike);
  const expiry = String(req.query.expiry || "");
  const interval = Math.max(1, Math.min(60, Number(req.query.interval) || 15));
  if (!underlying || !expiry || !Number.isFinite(strike)) return res.status(400).json({ error: "symbol, type, strike, expiry required" });
  try {
    const inst = await findOption(underlying, type, strike, expiry);
    if (!inst) return res.json({ available: false, message: `${underlying} ${strike} ${type} (${expiry}) instrument नहीं मिला।` });
    const now = Math.floor(Date.now() / 1000);
    const start = now - 5 * 24 * 3600; // last ~5 days
    const candles = await growwOptionCandles(provider as GrowwProvider, inst.tradingSymbol, start, now, interval);
    res.json({
      available: candles.length > 0, tradingSymbol: inst.tradingSymbol,
      underlying, name: def?.name || underlying, type, strike, expiry, interval, lotSize: inst.lotSize,
      candles, message: candles.length ? undefined : "इस option का candle नहीं मिला (rate-limit या नया strike)।",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "option candles failed" });
  }
});

// ---- OPTION PRICE PROJECTOR: "if spot moves to X, what will CE/PE be?" ----
// Uses the live chain's IV + a Black-Scholes reprice (which naturally includes
// gamma/convexity), calibrated to the actual market LTP. Falls back to a delta
// approximation when IV is missing. Time & IV held constant (an intraday move).
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function bsPrice(type: "CE" | "PE", S: number, K: number, Tyears: number, iv: number, r = 0.065): number | null {
  const sig = iv > 1 ? iv / 100 : iv; // Groww IV comes as percent (e.g. 12.5) → decimal
  if (!(S > 0) || !(K > 0) || !(Tyears > 0) || !(sig > 0)) return null;
  const sqrtT = Math.sqrt(Tyears);
  const d1 = (Math.log(S / K) + (r + (sig * sig) / 2) * Tyears) / (sig * sqrtT);
  const d2 = d1 - sig * sqrtT;
  if (type === "CE") return S * normCdf(d1) - K * Math.exp(-r * Tyears) * normCdf(d2);
  return K * Math.exp(-r * Tyears) * normCdf(-d2) - S * normCdf(-d1);
}
// Project one option's price when spot moves S0 -> S1. Prefers BS reprice on the
// user's/market LTP; else delta-linear. Returns null if nothing usable.
function projectOptionPrice(type: "CE" | "PE", ltp: number | null, S0: number, S1: number, K: number, Tyears: number, iv: number | null, delta: number | null): { price: number; method: string } | null {
  if (ltp == null || !(ltp >= 0)) {
    // No LTP: pure-BS theoretical if IV available.
    const th = iv != null ? bsPrice(type, S1, K, Tyears, iv) : null;
    return th != null ? { price: Math.max(0.05, Math.round(th * 100) / 100), method: "BS theoretical" } : null;
  }
  if (iv != null && Tyears > 0) {
    const now = bsPrice(type, S0, K, Tyears, iv);
    const tgt = bsPrice(type, S1, K, Tyears, iv);
    if (now != null && tgt != null) return { price: Math.max(0.05, Math.round((ltp + (tgt - now)) * 100) / 100), method: `Black-Scholes (IV ${Math.round((iv > 1 ? iv : iv * 100) * 10) / 10}%)` };
  }
  if (delta != null) {
    const d = type === "CE" ? Math.abs(delta) : -Math.abs(delta); // CE gains on up-move, PE loses
    return { price: Math.max(0.05, Math.round((ltp + d * (S1 - S0)) * 100) / 100), method: `Delta-approx (Δ ${Math.round(Math.abs(delta) * 100) / 100})` };
  }
  return null;
}
// /api/option-projector?symbol=^NSEI&targetSpot=23950&strike=23950&ceLtp=103&peLtp=99.5&spot=23906
router.get("/option-projector", async (req: Request, res: Response) => {
  const provider = getProvider();
  if (provider.name !== "groww") return res.json({ available: false, message: "Projector के लिए Groww feed चाहिए (live IV/greeks)।" });
  const def = findSymbolDef(String(req.query.symbol || ""));
  if (!def || !def.fno) return res.status(400).json({ error: "valid F&O symbol required" });
  try {
    const oi: any = await getOiCached(def);
    if (!oi || !oi.available || !oi.topStrikes?.length) return res.json({ available: false, message: "OI chain अभी उपलब्ध नहीं (rate-limit)।" });
    const spot = req.query.spot != null && req.query.spot !== "" ? Number(req.query.spot) : oi.underlying;
    if (!(spot > 0)) return res.json({ available: false, message: "spot नहीं मिला।" });
    // Chosen strike (default nearest to spot).
    const wantStrike = req.query.strike != null && req.query.strike !== "" ? Number(req.query.strike) : null;
    const row = wantStrike != null
      ? oi.topStrikes.reduce((b: any, s: any) => (b == null || Math.abs(s.strike - wantStrike) < Math.abs(b.strike - wantStrike) ? s : b), null)
      : oi.topStrikes.reduce((b: any, s: any) => (b == null || Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b), null);
    if (!row) return res.json({ available: false, message: "strike नहीं मिला।" });
    // Time to expiry (years) from the chain expiry; floor at ~2h so expiry-day works.
    let Tyears = 0.02;
    if (oi.expiry) {
      const exp = new Date(oi.expiry + "T15:30:00+05:30").getTime();
      const days = (exp - Date.now()) / 86400000;
      Tyears = Math.max(2 / 24 / 365, days / 365);
    }
    const ceLtp = req.query.ceLtp != null && req.query.ceLtp !== "" ? Number(req.query.ceLtp) : (row.ceLtp ?? null);
    const peLtp = req.query.peLtp != null && req.query.peLtp !== "" ? Number(req.query.peLtp) : (row.peLtp ?? null);
    const targetSpot = req.query.targetSpot != null && req.query.targetSpot !== "" ? Number(req.query.targetSpot) : spot;
    const proj = (S1: number) => ({
      spot: Math.round(S1 * 100) / 100,
      ce: projectOptionPrice("CE", ceLtp, spot, S1, row.strike, Tyears, row.ceIv ?? null, row.ceDelta ?? null),
      pe: projectOptionPrice("PE", peLtp, spot, S1, row.strike, Tyears, row.peIv ?? null, row.peDelta ?? null),
    });
    // Ladder: a spread of spots around the current level for context.
    const step = def.type === "index" ? (def.symbol === "^NSEBANK" ? 100 : 50) : Math.max(1, Math.round(spot * 0.004));
    const ladder = [];
    for (let k = -4; k <= 4; k++) ladder.push(proj(Math.round((spot + k * step) / 1) ));
    res.json({
      available: true, symbol: def.symbol, name: def.name, expiry: oi.expiry, dteDays: Math.round(Tyears * 365 * 100) / 100,
      spot: Math.round(spot * 100) / 100, strike: row.strike, targetSpot: Math.round(targetSpot * 100) / 100,
      current: { ce: ceLtp, pe: peLtp, ceIv: row.ceIv ?? null, peIv: row.peIv ?? null, ceDelta: row.ceDelta ?? null, peDelta: row.peDelta ?? null },
      strikes: oi.topStrikes.map((s: any) => ({ strike: s.strike, ceLtp: s.ceLtp ?? null, peLtp: s.peLtp ?? null })),
      target: proj(targetSpot),
      ladder,
      disclaimer: "अनुमान: IV व time constant मानकर Black-Scholes reprice (calibrated to LTP). वास्तविक भाव IV बदलने/theta से अलग हो सकते हैं।",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "projector failed" });
  }
});

// The review itself: judge the taken strike (good/bad) + improvements in Hindi.
router.get("/backtest/option/review", async (req: Request, res: Response) => {
  try {
    const provider = getProvider();
    if (provider.name !== "groww") {
      return res.json({ available: false, message: "Trade back-test के लिए Groww connect करें (historical option data चाहिए)।" });
    }
    const q = req.query;
    const type = q.type === "PE" ? "PE" : "CE";
    const strike = Number(q.strike);
    const symbol = String(q.symbol || "");
    const expiry = String(q.expiry || "");
    const date = String(q.date || "");
    const start = String(q.start || "09:20");
    const end = String(q.end || "15:15");
    if (!symbol || !expiry || !date || !Number.isFinite(strike)) {
      return res.status(400).json({ error: "symbol, strike, expiry, date required" });
    }
    const entryPrice = q.entry != null && q.entry !== "" ? Number(q.entry) : undefined;
    const exitPrice = q.exit != null && q.exit !== "" ? Number(q.exit) : undefined;
    const lots = q.lots != null && q.lots !== "" ? Number(q.lots) : undefined;
    const result = await reviewOptionTrade(provider as GrowwProvider, {
      symbol, type, strike, expiry, date, start, end, entryPrice, exitPrice, lots,
    });
    res.json(result);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "review failed" });
  }
});
router.get("/option-sell/reset", (_req: Request, res: Response) => res.json(resetSell()));

// Monthly swing (HIGH RISK): stocks with a real shot at +20-50% in ~1 month.
router.get("/monthly-swing", async (_req: Request, res: Response) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const universe = SWING_SYMBOLS.filter((d) => d.type === "equity"); // high-beta small/mid caps
  const fetchOne = async (def: SymbolDef) => {
    let pick: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const daily = await getDailyCached(def.symbol, 500);
        pick = computeMonthlyShot(def.symbol, def.name, daily);
        break;
      } catch {
        if (attempt === 0) await sleep(300);
      }
    }
    if (!pick) return null;
    pick.sector = def.sector || null;
    if (def.fno === true) {
      pick.hasOptions = true;
    } else {
      const prov = getProvider();
      if (prov.name === "groww") {
        const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
        try {
          pick.hasOptions = await growwHasOptions(prov as GrowwProvider, nse);
        } catch {
          pick.hasOptions = null;
        }
      } else {
        pick.hasOptions = def.fno ?? null;
      }
    }
    return pick;
  };

  const BATCH = 6;
  const results: any[] = [];
  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(fetchOne));
    results.push(...part);
    if (i + BATCH < universe.length) await sleep(120);
  }
  // Keep names with a real historical shot at a 20% month; rank by probability.
  const picks = (results.filter(Boolean) as any[])
    .filter((p) => p.baseRate20 >= 5)
    .sort((a, b) => b.probability - a.probability || b.riskReward - a.riskReward);
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    picks,
    disclaimer:
      "HIGH-RISK monthly swing model. 'Probability' blends the stock's OWN history (how often it gained >=20% in a " +
      "1-month window) with its current setup - it is an estimate, NOT a guarantee. Targets of 20-50% carry matching " +
      "downside; always use the stop and size small. Educational, not investment advice.",
  });
});

// Frequent movers: stocks that historically make big moves most OFTEN, ranked.
router.get("/frequent-movers", async (_req: Request, res: Response) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const universe = ALL_SYMBOLS.filter((d) => d.type === "equity");
  const fetchOne = async (def: SymbolDef) => {
    let mover: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const daily = await getProvider().getCandles(def.symbol, "1d", 365); // ~1yr sample
        mover = computeFrequentMover(def.symbol, def.name, daily);
        break;
      } catch {
        if (attempt === 0) await sleep(400);
      }
    }
    if (!mover) return null;
    mover.sector = def.sector || null;

    if (def.fno === true) {
      mover.hasOptions = true;
    } else {
      const prov = getProvider();
      if (prov.name === "groww") {
        const nse = def.nseSymbol || def.symbol.replace(/\.NS$/i, "");
        try {
          mover.hasOptions = await growwHasOptions(prov as GrowwProvider, nse);
        } catch {
          mover.hasOptions = null;
        }
      } else {
        mover.hasOptions = def.fno ?? null;
      }
    }
    return mover;
  };

  const BATCH = 4;
  const results: any[] = [];
  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(fetchOne));
    results.push(...part);
    if (i + BATCH < universe.length) await sleep(250);
  }
  // Default ranking: how often it moves >= 3% (client can re-sort by any threshold).
  const movers = (results.filter(Boolean) as any[]).sort((a, b) => (b.freqPct["3"] ?? 0) - (a.freqPct["3"] ?? 0));
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    thresholds: [2, 3, 5],
    movers,
    disclaimer:
      "Frequent-mover profile from ~1 year of daily data. 'Freq' = share of days with an absolute close-to-close move " +
      "at/above the chosen threshold; higher = moves big more often. High frequency + wide daily range = repeated " +
      "tradeable swings, but also higher risk. Past volatility does not guarantee future moves. Educational only.",
  });
});

// Zero-Hero (deep-OTM expiry lottery) analysis for NIFTY & BANK NIFTY.
router.get("/zero-hero", async (_req: Request, res: Response) => {
  const provider = getProvider();
  if (provider.name !== "groww") {
    return res.json({ available: false, message: "Zero-Hero needs the live Groww option chain (connect Groww).", indices: [] });
  }
  const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  const indices: any[] = [];
  for (const def of defs) {
    try {
      indices.push(await cached(`zh:${def.symbol}`, 60_000, () => growwZeroHero(provider as GrowwProvider, def)));
    } catch {
      /* skip */
    }
  }
  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    marketOpen: isTradingTimeIST(),
    indices: indices.filter((z) => z && z.available),
    disclaimer:
      "Zero-Hero = deep-OTM expiry-day options bought cheap for a big multiple. They EXPIRE WORTHLESS most of the time. " +
      "'Prob (delta)' is the option's honest chance of finishing in-the-money. Risk only tiny amounts you can lose fully. Not advice.",
  });
});

// AI-style day outlook: NIFTY & BANK NIFTY direction + top 3 option plays (>=20% premium swing).
router.get("/day-outlook", async (req: Request, res: Response) => {
  const interval = parseInterval(req.query.interval) === "1d" ? "5m" : parseInterval(req.query.interval);
  const provider = getProvider();

  // No prediction when the market is closed - after-hours signals are stale/misleading.
  if (!isTradingTimeIST()) {
    return res.json({
      generatedAt: Math.floor(Date.now() / 1000),
      interval,
      marketOpen: false,
      indices: [],
      opportunities: [],
      bestPlays: [],
      highConviction: [],
      message: "Market is closed. Live predictions run only during market hours: Mon-Fri, 9:15 AM - 3:30 PM IST.",
      disclaimer: "Predictions are generated only on live market data.",
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Per-symbol bundle: intraday signal + option OI + daily ATR. Retries once so a
  // transient rate-limit doesn't silently drop a symbol (e.g. BANK NIFTY).
  const bundle = async (def: SymbolDef) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [candles, daily] = await Promise.all([
          getCandlesCached(def.symbol, interval),
          getDailyCached(def.symbol, 40),
        ]);
        if (!candles || candles.length < 30) return null;
        const signal = computeSignal(def.symbol, candles);
        const atrDaily = last(atr(daily, 14));
        let oi: any = null;
        if (def.fno) {
          try {
            oi = await getOiCached(def);
          } catch {
            oi = null;
          }
        }
        return { def, signal, oi, atrDaily, daily, candles };
      } catch {
        if (attempt === 0) await sleep(300);
      }
    }
    return null;
  };

  // High-conviction bar (win-case %) and minimum premium-swing %, both tunable.
  const minConf = Math.max(0, Math.min(95, Number(req.query.minConf) || 0));
  const minMove = Math.max(0, Number(req.query.minMove) || 20);

  // Indices we predict direction for.
  const indexDefs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  // Candidate universe for option opportunities: all F&O names with strike metadata.
  const oppDefs = ALL_SYMBOLS.filter((d) => d.fno === true);

  const allDefs = [...new Set([...indexDefs, ...oppDefs])];
  // Throttle: batches + small delay so the Groww feed doesn't rate-limit us.
  const bundles: any[] = [];
  const BATCH = 6;
  for (let i = 0; i < allDefs.length; i += BATCH) {
    const chunk = allDefs.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(bundle));
    bundles.push(...part.filter(Boolean));
    if (i + BATCH < allDefs.length) await sleep(120);
  }

  const indices = bundles
    .filter((b) => b.def.type === "index")
    .map((b) => buildIndexOutlook(b.def, b.signal, b.oi, b.atrDaily));

  // Build market benchmarks (NIFTY + BANK NIFTY) with their direction + daily series,
  // so each stock play can be checked against whichever index it tracks most.
  const dirNum = (d: string): 1 | -1 | 0 => (d === "Bullish" ? 1 : d === "Bearish" ? -1 : 0);
  const benchmarks: { name: string; dir: 1 | -1 | 0; daily: any[] }[] = [];
  for (const nseSym of ["NIFTY", "BANKNIFTY"]) {
    const b = bundles.find((x) => x.def.nseSymbol === nseSym && x.def.type === "index");
    const o = indices.find((x) => (x.symbol === b?.def.symbol));
    if (b && o) benchmarks.push({ name: o.name, dir: dirNum(o.direction), daily: b.daily || [] });
  }

  const allOpps = bundles
    .map((b) => buildDayOpportunity(b.def, b.signal, b.oi, b.atrDaily, { benchmarks, stockDaily: b.daily || [], candles: b.candles }))
    .filter((o): o is NonNullable<typeof o> => o != null && o.expectedPremiumMovePct >= minMove)
    // Rank by expected premium swing weighted by conviction.
    .sort((a, b) => b.expectedPremiumMovePct * b.confidence - a.expectedPremiumMovePct * a.confidence);

  const opportunities = allOpps.slice(0, 6);
  // Curated Top 10: only plays that pass the SAFETY GATES (no index headwind, no
  // decay trap, R:R >= 1), ranked by the capital-preservation quality score.
  const bestPlays = allOpps
    .filter((o) => o.tradeable && o.highProb)
    .sort((a, b) => (b.highProbScore ?? b.qualityScore) - (a.highProbScore ?? a.qualityScore))
    .slice(0, 10);
  // High-conviction = high-prob + win-case bar (default >=70%) and the >=20% swing.
  const convBar = minConf > 0 ? minConf : 70;
  const highConviction = allOpps.filter((o) => o.confidence >= convBar && o.tradeable && o.highProb).slice(0, 10);

  res.json({
    generatedAt: Math.floor(Date.now() / 1000),
    interval,
    minConf,
    minMove,
    marketOpen: true,
    indices,
    opportunities,
    bestPlays,
    highConviction,
    disclaimer:
      "AI-style projection from technicals + option-chain OI + futures buildup. Direction and the expected day range " +
      "(spot ± 1 ATR) are PROBABILISTIC, not guaranteed. The >=20% premium swing is a delta-approx estimate that only " +
      "plays out if the move happens in the predicted direction - a wrong call plus theta can lose 20%+ just as fast. " +
      "Buy near-ATM only with a hard stop. Educational, not investment advice.",
  });
});

// ================= HOURLY 15-MIN MODEL (record -> evening backtest) =================

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shortlist the best option plays right now on the 15-min model, ranked by a
 * blend of HIGH VOLUME + HIGH PROFIT% + LOW THETA DECAY. Safety-gated (no index
 * conflicts) and low/moderate decay only.
 */
async function runHourlyScan(): Promise<HourlyPick[]> {
  const interval: Interval = "15m";
  const provider = getProvider();
  const universe = ALL_SYMBOLS.filter((d) => d.type === "equity" && d.fno === true);
  const indexDefs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
  const allDefs = [...new Set([...indexDefs, ...universe])];

  const bundle = async (def: SymbolDef) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [candles, daily] = await Promise.all([
          getCandlesCached(def.symbol, interval),
          getDailyCached(def.symbol, 40),
        ]);
        if (!candles || candles.length < 30) return null;
        const signal = computeSignal(def.symbol, candles);
        const atrDaily = last(atr(daily, 14));
        // Relative volume: recent 3 bars vs the day's average bar volume.
        const vols = candles.map((c) => c.volume).filter((v) => v > 0);
        const meanAll = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
        const recent = vols.slice(-3);
        const meanRecent = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
        const relVolume = meanAll > 0 ? Math.round((meanRecent / meanAll) * 100) / 100 : 1;
        let oi: any = null;
        if (def.fno) {
          try {
            oi = await getOiCached(def);
          } catch {
            oi = null;
          }
        }
        return { def, signal, oi, atrDaily, daily, relVolume, candles };
      } catch {
        if (attempt === 0) await sleepMs(300);
      }
    }
    return null;
  };

  const bundles: any[] = [];
  const BATCH = 6;
  for (let i = 0; i < allDefs.length; i += BATCH) {
    const chunk = allDefs.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(bundle));
    bundles.push(...part.filter(Boolean));
    if (i + BATCH < allDefs.length) await sleepMs(120);
  }

  // Benchmarks for index alignment.
  const indexOutlooks = bundles.filter((b) => b.def.type === "index").map((b) => buildIndexOutlook(b.def, b.signal, b.oi, b.atrDaily));
  const dirNum = (d: string): 1 | -1 | 0 => (d === "Bullish" ? 1 : d === "Bearish" ? -1 : 0);
  const benchmarks: { name: string; dir: 1 | -1 | 0; daily: any[] }[] = [];
  for (const nseSym of ["NIFTY", "BANKNIFTY"]) {
    const b = bundles.find((x) => x.def.nseSymbol === nseSym && x.def.type === "index");
    const o = indexOutlooks.find((x) => x.symbol === b?.def.symbol);
    if (b && o) benchmarks.push({ name: o.name, dir: dirNum(o.direction), daily: b.daily || [] });
  }

  const now = Math.floor(Date.now() / 1000);
  const date = istDateStr();
  const slot = istSlot();
  // LESSON (from resolved history): the biggest loss driver is DOUBLING DOWN -
  // re-picking the same symbol+direction hour after hour while it fails. Load
  // today's earlier picks so we can skip a thesis that's already NOT working.
  const priorToday = readHourlyPicks(date);

  const picks: HourlyPick[] = [];
  for (const b of bundles) {
    if (b.def.type === "index") continue; // stocks only for this model
    const o = buildDayOpportunity(b.def, b.signal, b.oi, b.atrDaily, { benchmarks, stockDaily: b.daily || [], candles: b.candles, relVolume: b.relVolume });
    if (!o || !o.tradeable) continue; // safety gate already removes decay-traps (>60%/day) & index conflicts
    if (!o.highProb) continue; // high-probability algo: structure + OI + trend + VWAP/OR agreement
    if (o.expectedPremiumMovePct < 15) continue;
    // No double-down: if we already called this symbol the SAME way earlier today
    // and price hasn't moved in our favour since the first call, skip it - the
    // thesis isn't working (this is what turned PETRONET/MARUTI into repeat losses).
    const priors = priorToday.filter((p) => p.symbol === b.def.symbol && p.direction === o.direction);
    if (priors.length) {
      const firstSpot = priors[0].spot;
      const cur = o.spot ?? b.signal.price;
      const working = o.direction === "Bullish" ? cur > firstSpot : cur < firstSpot;
      if (!working) continue;
    }
    // "Less theta decay" is a RANKING preference (see decayComp below), not a hard
    // filter - otherwise the model would be empty on every weekly-expiry day.

    // Composite the user asked for: HIGH win-rate potential + LOW theta + HIGH volume.
    const winComp = o.confidence * 0.3; // win-rate potential (0..~29)
    const volComp = Math.min(25, Math.max(0, (b.relVolume - 1) * 25)); // high relative volume
    const thetaComp = o.thetaPctPerDay != null ? Math.max(0, 25 - o.thetaPctPerDay * 0.5) : 15; // reward LOW theta
    const profitComp = Math.min(21, o.expectedPremiumMovePct * 0.3); // profit potential
    const hourlyScore = Math.round(Math.max(0, Math.min(100, winComp + volComp + thetaComp + profitComp)));

    picks.push({
      date,
      slot,
      snapshotEpoch: now,
      symbol: o.symbol,
      name: o.name,
      direction: o.direction,
      optionType: o.optionType,
      strike: o.strike,
      spot: o.spot,
      spotTarget: o.spotTarget,
      spotStop: o.spotStop,
      premium: o.premium,
      premiumTarget: o.premiumTarget,
      premiumStop: o.premiumStop,
      expectedPremiumMovePct: o.expectedPremiumMovePct,
      confidence: o.confidence,
      qualityScore: o.qualityScore,
      marketAlignment: o.marketAlignment,
      strikeReason: o.strikeReason,
      relVolume: b.relVolume,
      thetaPctPerDay: o.thetaPctPerDay,
      decayLevel: o.decayLevel,
      dte: o.dte,
      hourlyScore,
      expiry: b.oi && b.oi.available ? b.oi.expiry : null,
      highProb: true,
    });
  }

  // Rank by the composite (win potential + low theta + high volume); take TOP 6.
  picks.sort((a, b) => b.hourlyScore - a.hourlyScore || b.relVolume - a.relVolume);
  return picks.slice(0, 6);
}

// Run a snapshot now and append to today's CSV (also used by the scheduler).
router.get("/hourly/run", async (req: Request, res: Response) => {
  try {
    // No snapshot when the market is closed (unless ?force=true for testing).
    if (!isTradingTimeIST() && req.query.force !== "true") {
      return res.json({
        ranAt: Math.floor(Date.now() / 1000),
        slot: istSlot(),
        marketOpen: false,
        count: 0,
        picks: [],
        message: "Market is closed. Snapshots run only during market hours: Mon-Fri, 9:15 AM - 3:30 PM IST.",
      });
    }
    const picks = await runHourlyScan();
    const saved = appendHourlyPicks(picks);
    res.json({ ranAt: Math.floor(Date.now() / 1000), slot: istSlot(), marketOpen: true, count: picks.length, file: saved.file, picks });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Hourly scan failed" });
  }
});

// Market news: India-focused headlines from public RSS feeds, tagged with a
// keyword sentiment + high-impact-event flag. Informational (not wired into the
// trade engine). ?force=true bypasses the 5-min cache. ?q= filters by keyword.
router.get("/news", async (req: Request, res: Response) => {
  try {
    const data = await getMarketNews(String(req.query.force) === "true");
    const q = (req.query.q as string || "").trim().toLowerCase();
    if (q) {
      const items = data.items.filter((i) => i.title.toLowerCase().includes(q));
      return res.json({ ...data, items, summary: { ...data.summary, total: items.length } });
    }
    res.json(data);
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to fetch news." });
  }
});

// Best trade RIGHT NOW on the 15-min model (the top safety-gated option play).
// Shown in the header across every section. Cached 60s so polling is cheap.
router.get("/best-trade", async (_req: Request, res: Response) => {
  if (!isTradingTimeIST()) return res.json({ marketOpen: false });
  try {
    const picks = await cached("hourly-scan-shared", 60_000, () => runHourlyScan());
    res.json({ marketOpen: true, best: picks && picks.length ? picks[0] : null, count: picks ? picks.length : 0 });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "best-trade failed" });
  }
});

// Today's recorded picks (all snapshots so far).
router.get("/hourly/today", (_req: Request, res: Response) => {
  const date = istDateStr();
  res.json({ date, picks: readHourlyPicks(date) });
});

// Download today's (or ?date=) CSV.
router.get("/hourly/csv", (req: Request, res: Response) => {
  const date = (req.query.date as string) || istDateStr();
  const file = picksFilePath(date);
  if (!fs.existsSync(file)) return res.status(404).send("No picks recorded for " + date);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="hourly-picks-${date}.csv"`);
  res.send(fs.readFileSync(file, "utf-8"));
});

// Download the cumulative master database (all days) - Excel/Access importable.
router.get("/hourly/database", (_req: Request, res: Response) => {
  const file = masterFilePath();
  if (!fs.existsSync(file)) return res.status(404).send("No data recorded yet.");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="hourly-master-database.csv"`);
  res.send(fs.readFileSync(file, "utf-8"));
});

// Evening backtest: resolve each recorded pick against intraday candles -> win rate.
router.get("/hourly/resolve", async (req: Request, res: Response) => {
  const date = (req.query.date as string) || istDateStr();
  const picks = readHourlyPicks(date);
  if (!picks.length) return res.json({ date, picks: [], summary: { total: 0, wins: 0, losses: 0, open: 0, winRate: 0 } });

  // Fetch 5m candles once per unique symbol.
  const symbols = [...new Set(picks.map((p) => p.symbol))];
  const candleMap = new Map<string, any[]>();
  for (const s of symbols) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        candleMap.set(s, await getProvider().getCandles(s, "5m", 5));
        break;
      } catch {
        if (attempt === 0) await sleepMs(300);
      }
    }
    await sleepMs(120);
  }

  const istTime = (epoch: number) => new Date((epoch + 19800) * 1000).toISOString().slice(11, 16);
  for (const p of picks) {
    const candles = candleMap.get(p.symbol) || [];
    const after = candles.filter((c) => c.time >= p.snapshotEpoch);
    if (!after.length) { p.result = "NODATA"; p.spotAfter = null; continue; }
    const bullish = p.direction === "Bullish";
    let result: HourlyPick["result"] = "OPEN";
    let hitTime = "";
    for (const c of after) {
      const targetHit = bullish ? c.high >= p.spotTarget : c.low <= p.spotTarget;
      const stopHit = bullish ? c.low <= p.spotStop : c.high >= p.spotStop;
      // If both touched in the same bar, treat conservatively as a LOSS (stop first).
      if (stopHit && targetHit) { result = "LOSS"; hitTime = istTime(c.time); break; }
      if (targetHit) { result = "WIN"; hitTime = istTime(c.time); break; }
      if (stopHit) { result = "LOSS"; hitTime = istTime(c.time); break; }
    }
    p.result = result;
    p.hitTime = hitTime || undefined;
    p.spotAfter = after[after.length - 1].close;
  }

  writeResolvedPicks(date, picks);
  const wins = picks.filter((p) => p.result === "WIN").length;
  const losses = picks.filter((p) => p.result === "LOSS").length;
  const open = picks.filter((p) => p.result === "OPEN").length;
  const decided = wins + losses;
  const summary = {
    total: picks.length,
    wins,
    losses,
    open,
    winRate: decided ? Math.round((wins / decided) * 1000) / 10 : 0,
  };
  res.json({ date, summary, picks });
});

// ================= AUTONOMOUS PAPER TRADING (20 days, no human input) =================

// Build the idea/quote providers the paper engine needs from our existing logic.
// Multi-timeframe context for a trade: which timeframe is strongest (the "best
// part"), the holding horizon (short vs long), and whether the latest candle
// pattern FAVOURS the intended direction (the extra confirmation check).
const TF_HORIZON: Record<Tf, string> = { "5m": "Scalp (5m)", "15m": "Short (15m)", "1h": "Intraday (1h)", "1d": "Positional (1d)" };
async function tradeContext(symbol: string, direction: "Bullish" | "Bearish"): Promise<{
  timeframe: string; horizon: string; candlePattern: string; candleBias: number; favoured: boolean; alignment: number; reason: string;
}> {
  // Cached 2 min: the 4-timeframe read is heavy; without this every paper tick
  // would re-fetch 5m/15m/1h/1d for every idea and rate-limit the Groww feed.
  return cached(`tctx:${symbol}:${direction}`, 120_000, () => tradeContextRaw(symbol, direction));
}
async function tradeContextRaw(symbol: string, direction: "Bullish" | "Bearish"): Promise<{
  timeframe: string; horizon: string; candlePattern: string; candleBias: number; favoured: boolean; alignment: number; reason: string;
}> {
  const dir = direction === "Bullish" ? 1 : -1;
  const tfMap: Record<Tf, Interval> = { "5m": "5m", "15m": "15m", "1h": "60m", "1d": "1d" };
  const sigs: { tf: Tf; score: number; candles: any[] }[] = [];
  for (const tf of TOP_PICK_TFS) {
    try {
      const c = await getCandlesCached(symbol, tfMap[tf]);
      if (c && c.length >= 30) sigs.push({ tf, score: computeSignal(symbol, c).score, candles: c });
    } catch { /* skip */ }
  }
  if (!sigs.length) return { timeframe: "15m", horizon: TF_HORIZON["15m"], candlePattern: "n/a", candleBias: 0, favoured: true, alignment: 0, reason: "no candles" };
  const aligned = sigs.filter((x) => Math.sign(x.score) === dir);
  const pool = aligned.length ? aligned : sigs;
  const best = pool.reduce((b, x) => (Math.abs(x.score) > Math.abs(b.score) ? x : b), pool[0]);
  const pat = detectCandlePattern(best.candles);
  // Favoured unless a reasonably strong candle pattern points the OTHER way.
  const favoured = !(pat.bias !== 0 && pat.bias !== dir && pat.strength >= 0.5);
  return {
    timeframe: best.tf, horizon: TF_HORIZON[best.tf], candlePattern: pat.pattern, candleBias: pat.bias,
    favoured, alignment: Math.round((aligned.length / sigs.length) * 100), reason: pat.reason,
  };
}

function paperDeps(force = false): TickDeps {
  const ist = new Date(Date.now() + 19800000);
  const minutesIST = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return {
    marketOpen: force || isTradingTimeIST(),
    istDate: istDateStr(),
    minutesIST,
    nowEpoch: Math.floor(Date.now() / 1000),
    getSpot: async (symbol: string) => {
      try {
        // Cache quotes ~1s so per-second polling doesn't hammer the feed.
        return await cached(`q:${symbol}`, 1000, async () => {
          const q = await getProvider().getQuote(symbol);
          return q?.price ?? null;
        });
      } catch {
        return null;
      }
    },
    // PART 1: index options (directional CE/PE on NIFTY/BANKNIFTY/FINNIFTY/MIDCAP).
    getIndexOptionIdeas: async (): Promise<OptionIdea[]> => {
      const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
      const out: OptionIdea[] = [];
      for (const def of defs) {
        try {
          const grid = await buildOiCommand(def);
          const oiIdea = oiGridToIdea(def, grid, "directional");
          if (oiIdea) out.push(oiIdea);
          // Index directional paper follows OI Command only (1h bulletin + OI TAKE).
          // No 4-layer fallback — that used to open the opposite side of the OI tab.
        } catch { /* skip */ }
      }
      return out.sort((a, b) => b.confidence * b.expectedMovePct - a.confidence * a.expectedMovePct);
    },
    // PART 2: stock options (safety-gated hourly scan, ranked by clean-move + conviction).
    getStockOptionIdeas: async (): Promise<OptionIdea[]> => {
      const picks = await cached("hourly-scan-shared", 60_000, () => runHourlyScan());
      const ideas = (await Promise.all(
        picks.map(async (p: any) => {
          const def = findSymbolDef(p.symbol);
          const lot = def?.lotSize;
          if (!lot || p.premium == null || p.premiumStop == null || p.premiumTarget == null) return null;
          // DIRECTION without RSI/MACD + price-structure levels (15m base for stocks).
          let candles: any[] = [], daily: any[] = [], oi: any = null;
          try { [candles, daily] = await Promise.all([getCandlesCached(p.symbol, "15m"), getDailyCached(p.symbol, 40)]); } catch { /* skip */ }
          if (!candles || candles.length < 30) return null;
          try { if (def?.fno) oi = await getOiCached(def); } catch { oi = null; }
          const d4 = computeDirection4L(p.symbol, p.name, candles, daily, oi);
          if (!d4) return null;
          const nm = directionNoMomentum(d4);
          if (nm.direction === "Neutral" || nm.direction !== p.direction) return null; // no RSI/MACD; must agree with strike-picker
          const lv = levelContext(candles, daily, oi);
          if (lv.bias !== 0 && lv.bias !== (p.direction === "Bullish" ? 1 : -1)) return null; // trend alignment (Day Open/PDC/VWAP)
          const atrDaily = last(atr(daily, 14));
          const room = srRoomOk(p.direction, p.spot, lv, atrDaily);
          if (!room.ok) return null; // major S/R room
          const cap = capTargetAndStop({
            direction: p.direction, spot: p.spot, spotTarget: p.spotTarget, spotStop: p.spotStop,
            premium: p.premium, premiumTarget: p.premiumTarget, premiumStop: p.premiumStop,
          }, lv, atrDaily);
          let cleanRating: number | undefined;
          let cleanGrade: string | undefined;
          try { const cm = await getCleanRatingCached(p.symbol, p.name); if (cm) { cleanRating = cm.rating; cleanGrade = cm.grade; } } catch { /* optional */ }
          const ctx = await tradeContext(p.symbol, p.direction); // candle context = informational (shown, not a hard block)
          return {
            symbol: p.symbol, name: p.name, direction: p.direction, optionType: p.optionType, strike: p.strike,
            premium: p.premium, premiumTarget: cap.premiumTarget, premiumStop: cap.premiumStop,
            spot: p.spot, spotTarget: cap.spotTarget, spotStop: p.spotStop, lotSize: lot,
            expectedMovePct: cap.expectedMovePct, confidence: nm.confidence, thetaPctPerDay: p.thetaPctPerDay ?? 0, dte: p.dte ?? null,
            strikeReason: `[15m base · no RSI/MACD] दिशा ${nm.direction} (conf ${nm.confidence})${lv.notes.length ? ` · ${lv.notes.join(", ")}` : ""}${cap.note ? ` · ${cap.note}` : ""}. ${p.strikeReason || ""}`,
            cleanRating, cleanGrade,
            timeframe: ctx.timeframe, horizon: ctx.horizon, candlePattern: ctx.candlePattern,
          } as OptionIdea;
        }),
      )).filter(Boolean) as OptionIdea[];
      const blend = (i: OptionIdea) => (i.cleanRating ?? 50) * 0.4 + i.confidence * 0.4 + i.expectedMovePct * 0.2;
      return ideas.sort((a, b) => blend(b) - blend(a));
    },
    // PART 3: stock intraday (long equity, squared off same day) - bullish scan picks.
    getStockIntradayIdeas: async (): Promise<IntradayIdea[]> => {
      const picks = await cached("hourly-scan-shared", 60_000, () => runHourlyScan());
      const bulls = picks.filter((p: any) => p.direction === "Bullish" && p.spot != null && p.spotStop != null && p.spotTarget != null && p.spotStop < p.spot && p.spotTarget > p.spot);
      const ideas = (await Promise.all(
        bulls.map(async (p: any) => {
          const ctx = await tradeContext(p.symbol, "Bullish"); // candle context = informational
          return { symbol: p.symbol, name: p.name, entry: p.spot, stop: p.spotStop, target: p.spotTarget, expectedMovePct: p.expectedPremiumMovePct ?? 0, confidence: p.confidence ?? 0, timeframe: ctx.timeframe, horizon: ctx.horizon, candlePattern: ctx.candlePattern } as IntradayIdea;
        }),
      )).filter(Boolean) as IntradayIdea[];
      return ideas.sort((a, b) => b.confidence - a.confidence);
    },
    // SCALP: quick momentum-burst option on an index, only when the burst FIRES
    // in the same direction as the current signal (current market direction).
    getScalpIdeas: async (): Promise<OptionIdea[]> => {
      const r2 = (n: number) => Math.round(n * 100) / 100;
      // ALL F&O indices (was first 2 = NIFTY/BANKNIFTY only, so FINNIFTY/MIDCAP
      // never got a scalp). The best-scored setup across all of them wins the slot.
      const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno).slice(0, 4);
      const out: OptionIdea[] = [];
      const scalpScore = (dir: "up" | "down", burst: any, att: any, sigDir: string): number => {
        const burstC = burst.direction === dir ? burst.burstScore : burst.burstScore * 0.5;
        const volC = Math.max(0, Math.min(100, (burst.volumeSurge - 1) * 100));
        const attN = att.pressure === "up" ? att.attemptsUp : att.pressure === "down" ? att.attemptsDown : 0;
        const attC = att.pressure === dir ? Math.min(100, 60 + (attN - 2) * 10) : att.pressure === "none" ? 30 : 12;
        const alignC = sigDir === dir ? 100 : sigDir === "flat" ? 50 : 20;
        return Math.round(Math.max(0, Math.min(100, 0.4 * burstC + 0.25 * volC + 0.25 * attC + 0.1 * alignC)));
      };
      for (const def of defs) {
        try {
          try {
            const grid = await buildOiCommand(def);
            const oiSc = oiGridToIdea(def, grid, "scalp");
            if (oiSc) { out.push(oiSc); continue; }
            if (grid && grid.available) continue; // OI WAIT — do not open a burst scalp against the OI tab
          } catch { /* if OI grid fails, fall through to burst path */ }
          const [c5, oi] = await Promise.all([
            getCandlesCached(def.symbol, "5m"),
            getOiCached(def) as Promise<OiAnalysis>,
          ]);
          if (!oi || !oi.available || !c5 || c5.length < 30 || !def.lotSize) continue;
          let daily: any[] = [];
          try { daily = await getDailyCached(def.symbol, 40); } catch { daily = []; }
          const atrDaily = last(atr(daily, 14));
          const signal = computeSignal(def.symbol, c5);
          const burst = computeMomentumBurst(def.symbol, c5);
          const firing = burst.state === "Fired Up" || burst.state === "Fired Down" || burst.state === "Expanding Up" || burst.state === "Expanding Down";
          const sigDir = signal.score > 0 ? "up" : signal.score < 0 ? "down" : "flat";
          const att = computeAttempts(c5, 40);

          // Win-win scalp only: burst fires AND agrees with 5m signal. No anticipation-against-signal.
          if (firing && burst.direction !== "flat" && sigDir === burst.direction) {
            const opp: any = buildDayOpportunity(def, signal, oi, atrDaily, { benchmarks: [], stockDaily: daily || [], candles: c5 });
            if (opp && opp.premium != null && opp.premiumStop != null && opp.premiumTarget != null && (opp.optionType === "CE") === (burst.direction === "up")) {
              const premiumTarget = r2(opp.premium + (opp.premiumTarget - opp.premium) * 0.5);
              const spotTarget = r2(opp.spot + (opp.spotTarget - opp.spot) * 0.5);
              const scA = scalpScore(burst.direction as "up" | "down", burst, att, sigDir);
              if (scA >= 72) {
                out.push({
                  symbol: def.symbol, name: def.name + " (Scalp)", direction: opp.direction, optionType: opp.optionType, strike: opp.strike,
                  premium: opp.premium, premiumTarget, premiumStop: opp.premiumStop, spot: opp.spot, spotTarget, spotStop: opp.spotStop, lotSize: def.lotSize,
                  expectedMovePct: r2(((premiumTarget - opp.premium) / opp.premium) * 100), confidence: scA,
                  thetaPctPerDay: opp.thetaPctPerDay ?? 0, dte: opp.dte ?? null,
                  strikeReason: `SCALP · Score ${scA} · burst ${burst.state} (score ${burst.burstScore}, vol ${burst.volumeSurge}x, ATR ${burst.atrExpansion}x). ${opp.strikeReason || ""}`, scalp: true,
                } as OptionIdea);
              }
            }
          }
        } catch { /* skip */ }
      }
      // Prefer OI-model scalps, then higher-confidence momentum scalps.
      return out.sort((a, b) => {
        const ao = (a.strikeReason || "").includes("OI-SCALP") ? 1 : 0;
        const bo = (b.strikeReason || "").includes("OI-SCALP") ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      });
    },
    getMinder: async (symbol: string, direction: "Bullish" | "Bearish") => {
      try {
        return await cached(`minder:${symbol}:${direction}`, 30_000, async () => {
          const c = await getCandlesCached(symbol, "15m");
          const m = c && c.length >= 20 ? computeTradeMinder(c, direction) : null;
          return m ? { state: m.state, reason: m.reason } : null;
        });
      } catch { return null; }
    },
    getOiBias: async (symbol: string): Promise<string | null> => {
      const def = findSymbolDef(symbol);
      if (!def || !def.fno) return null;
      try {
        const grid: any = await cached(`oi-command:${def.symbol}`, 15_000, () => buildOiCommand(def));
        if (grid?.oiDirection === "UP") return "Bullish";
        if (grid?.oiDirection === "DOWN") return "Bearish";
        return "Neutral";
      } catch {
        return null;
      }
    },
    getOiModule: async (symbol: string) => {
      const def = findSymbolDef(symbol);
      if (!def || !def.fno) return null;
      try {
        const grid: any = await cached(`oi-command:${def.symbol}`, 15_000, () => buildOiCommand(def));
        return {
          dir: grid?.oiDirection || "FLAT",
          scalp5: grid?.bulletin?.scalp5?.dir || "FLAT",
          scalp15: grid?.bulletin?.scalp15?.dir || "FLAT",
          dir1h: grid?.bulletin?.dir1h?.dir || "FLAT",
        };
      } catch { return null; }
    },
    // Phase 1.1: the ONE MarketRegimeEngine (fractal + ATR). Was previously an
    // independent ADX-only calculation here — now just calls the same engine the
    // rest of the app reads, so the live entry/exit gate can never disagree with
    // what /data-status or /paper/why show for the same symbol.
    getRegime: async (symbol: string) => {
      try {
        return await getMarketRegimeForSymbol(symbol);
      } catch {
        return null;
      }
    },
    getRelVol: async (symbol: string) => {
      try { const candles = await getCandlesCached(symbol, "15m"); return relVolNow(candles); } catch { return null; }
    },
    // INDEX-aware stop review: for a stock that tracks an index, return the parent
    // index's current short-term direction (EMA9/21 + VWAP — no RSI/MACD). The
    // engine uses this to tighten/exit a stock option when its index turns against.
    getIndexBiasFor: async (symbol: string) => {
      try {
        const def = findSymbolDef(symbol);
        if (!def || def.type !== "equity") return null;
        const key = (def.nseSymbol || def.symbol).toUpperCase();
        const bankish = /BANK|FIN|SBIN|HDFC|ICICI|AXIS|KOTAK|BAJAJFIN|BAJFINANCE|PNB|IDFC|AUBANK|CHOLA|SHRIRAM|MUTHOOT/.test(key);
        const idxSym = bankish ? "^NSEBANK" : "^NSEI";
        const candles = await getCandlesCached(idxSym, "15m");
        if (!candles || candles.length < 30) return null;
        const closes = candles.map((c: any) => c.close);
        const price = closes[closes.length - 1];
        const e9 = last(ema(closes, 9)), e21 = last(ema(closes, 21)), vw = last(vwap(candles));
        let up = 0, dn = 0;
        if (e9 != null && e21 != null) { if (e9 > e21) up++; else if (e9 < e21) dn++; }
        if (vw != null) { if (price > vw) up++; else if (price < vw) dn++; }
        return { index: bankish ? "BANKNIFTY" : "NIFTY", dir: up > dn ? 1 : dn > up ? -1 : 0 };
      } catch { return null; }
    },
    // Live option premium for Manual Trading marking (cached 30s, any strike).
    getOptionPremium: async (symbol: string, type: "CE" | "PE", strike: number, expiry: string) => {
      try {
        const gp = growwProviderForOi();
        if (!gp) return null;
        return await cached(`optprem:${symbol}:${type}:${strike}:${expiry}`, 30_000, async () => {
          const def = findSymbolDef(symbol);
          const underlying = (def?.nseSymbol || symbol.replace(/\.NS$/i, "")).toUpperCase();
          const inst = await findOption(underlying, type, strike, expiry);
          if (!inst) return null;
          const now = Math.floor(Date.now() / 1000);
          const candles = await growwOptionCandles(gp, inst.tradingSymbol, now - 2 * 24 * 3600, now, 5);
          return candles.length ? candles[candles.length - 1].close : null;
        });
      } catch { return null; }
    },
    // SENTIMENT/LIQUIDITY/RISK EXTENSION: assemble live inputs for ONE directional
    // (non-scalp) option candidate. Returns null if core data is unavailable, in
    // which case the engine falls back to its original behaviour for that idea.
    // NOTE: this is the DATA-supply half; the ordered pipeline itself lives in
    // engine.ts (runExtPipeline). Scalp ideas never reach this closure.
    getExtInputs: (idea: OptionIdea) => assembleExtInputs(idea),
    // Phase 2.2 (RiskEngine): pre-trade Risk Radar, now also read by the entry
    // gate (previously only attached to already-open positions via withRiskRadar).
    getRiskRadar: async (symbol: string, premium: number) => {
      try {
        const candles = await getCandlesCached(symbol, "15m");
        if (!candles || candles.length < 15) return null;
        return computeRiskRadar(candles, { interval: "15m" as Interval, premium });
      } catch { return null; }
    },
    // Master Trade Selector EMA + Momentum-Burst confluence (session decision):
    // blocks only on an ACTIVE opposing read from either signal; Neutral/flat
    // never blocks. Applied to every option idea type — see engine.ts's
    // TickDeps.getConfluenceVeto doc comment for the full design rationale.
    getConfluenceVeto: async (symbol: string, direction: "Bullish" | "Bearish") => {
      try {
        const candles = await getCandlesCached(symbol, "15m");
        if (!candles || candles.length < 50) return null; // not enough history for EMA21/50 — never block on insufficient data
        const closes = (candles as any[]).map((c) => c.close);
        const price = closes[closes.length - 1];
        const emaDir = emaConfluenceDirection(price, closes);
        const burst = computeMomentumBurst(symbol, candles as any);
        const burstDir: "Bullish" | "Bearish" | "Neutral" = burst.direction === "up" ? "Bullish" : burst.direction === "down" ? "Bearish" : "Neutral";
        const opposite: "Bullish" | "Bearish" = direction === "Bullish" ? "Bearish" : "Bullish";
        if (emaDir === opposite) {
          return { blocked: true, reason: `EMA confluence opposes ${direction} (EMA9/21 + EMA21/50 both read ${opposite})` };
        }
        if (burstDir === opposite) {
          return { blocked: true, reason: `Momentum Burst opposes ${direction} (${burst.state}, dir ${burst.direction})` };
        }
        return { blocked: false, reason: "" };
      } catch { return null; }
    },
  };
}

// Start a fresh paper run with three capital pools: index options, stock
// options, and stock intraday. e.g. ?indexCapital=40000&stockOptionCapital=40000&intradayCapital=40000&days=20
router.get("/paper/start", (req: Request, res: Response) => {
  const indexCapital = Math.max(0, Number(req.query.indexCapital) || 40000);
  const stockOptionCapital = Math.max(0, Number(req.query.stockOptionCapital) || 40000);
  const intradayCapital = Math.max(0, Number(req.query.intradayCapital) || 40000);
  const days = Math.max(1, Math.min(60, Number(req.query.days) || 20));
  res.json(startPaper(indexCapital, stockOptionCapital, intradayCapital, days, istDateStr()));
});
router.get("/paper/stop", (_req: Request, res: Response) => res.json(stopPaper()));
// Auto-trade ON/OFF toggle (pause/resume without resetting the run).
router.get("/paper/auto", (req: Request, res: Response) => res.json(setAutoTrade(req.query.on === "true", istDateStr())));
router.get("/paper/reset", (_req: Request, res: Response) => res.json(resetPaper()));
router.get("/paper/state", (_req: Request, res: Response) => res.json(getPaperSummary()));
// MANUAL TRADING: user opens a trade (index/stock + entry price + comment); system
// applies a trailing SL, marks it live, holds through the month, saves to history.
router.get("/paper/manual/open", (req: Request, res: Response) => {
  const q = req.query;
  const symbol = String(q.symbol || "");
  const def = findSymbolDef(symbol);
  if (!def) return res.status(400).json({ ok: false, error: "Unknown symbol." });
  const instrument = q.instrument === "equity" ? "equity" : "option";
  const optionType = q.type === "PE" ? "PE" : "CE";
  const strike = q.strike != null && q.strike !== "" ? Number(q.strike) : undefined;
  const expiry = q.expiry ? String(q.expiry) : undefined;
  const direction = q.direction === "Bearish" ? "Bearish" : "Bullish";
  const entry = Number(q.entry);
  const lots = Math.max(1, Math.floor(Number(q.lots) || 1));
  const comment = String(q.comment || "");
  if (instrument === "option" && (strike == null || !Number.isFinite(strike) || !expiry)) {
    return res.status(400).json({ ok: false, error: "Option के लिए strike व expiry चाहिए।" });
  }
  const r = openManual({
    symbol: def.symbol, name: def.name, instrument,
    optionType: instrument === "option" ? optionType : undefined,
    strike: instrument === "option" ? strike : undefined,
    expiry: instrument === "option" ? expiry : undefined,
    direction, entry, lots, lotSize: def.lotSize || 1, comment,
    isIndex: def.type === "index", nowEpoch: Math.floor(Date.now() / 1000), istDate: istDateStr(),
  });
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, ...getPaperSummary().manual });
});
router.get("/paper/manual/close", (req: Request, res: Response) => {
  const r = closeManualById(String(req.query.id || ""), Math.floor(Date.now() / 1000));
  if (!r.ok) return res.status(400).json(r);
  res.json({ ...r, ...getPaperSummary().manual });
});
// Per-day realised P&L review (how much loss/profit happened each day).
router.get("/paper/daily", (_req: Request, res: Response) => res.json(dailyReview()));
// EOD learning review: attribution (score/time/exit/directional-vs-scalp) + tuning suggestions.
router.get("/paper/learn", (_req: Request, res: Response) => res.json(learnReview()));
// Hindi daily review: how the system gained + the specific loss trades (per day).
router.get("/paper/hindi", (_req: Request, res: Response) => res.json(hindiReview()));
// LIGHTWEIGHT gate diagnosis: for each index idea, the FIRST gate that blocks it.
router.get("/paper/gate", async (_req: Request, res: Response) => {
  try {
    const deps = paperDeps(true);
    const OPT_RR_MIN = 1.3, POOL = 40000, FLOOR = 50;
    const ideas = await deps.getIndexOptionIdeas();
    const friction = (entryVal: number, exitVal: number) => 0.004 * (entryVal + exitVal) + Math.max(40, 0.0003 * (entryVal + exitVal));
    const rows = await Promise.all(ideas.map(async (idea) => {
      const conf = idea.confidence ?? 0;
      const lot = idea.lotSize ?? 0;
      const lossPerLot = Math.max(1, (idea.premium - (idea.premiumStop ?? 0)) * lot);
      const confScale = Math.max(0.6, Math.min(1.3, conf / 75));
      let lots = Math.floor((POOL * 0.01 * confScale) / lossPerLot);
      if (lots < 1 && lossPerLot <= POOL * 0.1) lots = 1;
      const qty = Math.max(lots, 1) * lot;
      const grossRR = Math.round((((idea.premiumTarget ?? 0) - idea.premium) / Math.max(0.01, idea.premium - (idea.premiumStop ?? 0))) * 100) / 100;
      const costWin = friction(idea.premium * qty, (idea.premiumTarget ?? 0) * qty);
      const costLoss = friction(idea.premium * qty, (idea.premiumStop ?? 0) * qty);
      const netReward = ((idea.premiumTarget ?? 0) - idea.premium) * qty - costWin;
      const netRisk = (idea.premium - (idea.premiumStop ?? 0)) * qty + costLoss;
      const netRR = Math.round((netReward / Math.max(0.01, netRisk)) * 100) / 100;
      let rg: any = null; try { rg = deps.getRegime ? await deps.getRegime(idea.symbol) : null; } catch {}
      let block = "WOULD OPEN ✅";
      if (conf < FLOOR) block = `conf<${FLOOR} (have ${conf})`;
      else if (idea.dte != null && idea.dte <= 1 && conf < 80) block = `near-expiry dte=${idea.dte} needs conf>=80`;
      else if (rg && rg.regime === "Compressed") block = "regime=Compressed";
      else if (grossRR < OPT_RR_MIN) block = `grossRR<1.3 (${grossRR})`;
      else if (lots < 1) block = `0 lots (risk ${Math.round(lossPerLot)} > 10% pool)`;
      else if (netReward <= 0 || netRR < OPT_RR_MIN) block = `net-cost RR<1.3 (${netRR}, gross ${grossRR})`;
      return { s: idea.symbol, ot: idea.optionType, conf, dte: idea.dte, premium: idea.premium, stop: idea.premiumStop, target: idea.premiumTarget, lot, lots, grossRR, netRR, regime: rg?.regime, adx: rg?.adx, block, reason: idea.strikeReason };
    }));
    res.json({ marketOpen: isTradingTimeIST(), floor: FLOOR, ideas: rows });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "gate failed" });
  }
});
// Download the day-to-day feedback CSV (per trade, with Hindi technical comment) for Excel.
router.get("/paper/review.csv", (_req: Request, res: Response) => {
  try {
    const p = path.join(process.cwd(), "data", "paper-review.csv");
    if (!fs.existsSync(p)) return res.status(404).send("No review file yet — it is written after the first closed trade.");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=paper-review.csv");
    res.send(fs.readFileSync(p));
  } catch (e: any) {
    res.status(500).send(e?.message || "Failed to read review file.");
  }
});
// Manual tick (also used by the scheduler). ?force=true bypasses the market-hours gate for testing.
// Diagnostic: what ideas actually reach the paper engine + their key gate values.
router.get("/paper/why", async (_req: Request, res: Response) => {
  const deps = paperDeps(true);
  const rr = (i: any) => { const risk = i.premium - i.premiumStop; return risk > 0 ? Math.round(((i.premiumTarget - i.premium) / risk) * 100) / 100 : null; };
  // Per-index raw verdict: shows exactly why NIFTY/BANKNIFTY is or isn't tradeable.
  const indexDebug = async () => {
    const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
    const rows: any[] = [];
    for (const def of defs) {
      try {
        const [candles, daily, oi] = await Promise.all([
          getCandlesCached(def.symbol, "15m"), getDailyCached(def.symbol, 40), getOiCached(def),
        ]);
        if (!candles || candles.length < 30) { rows.push({ s: def.symbol, drop: `candles=${candles?.length ?? 0} (<30)` }); continue; }
        const signal = computeSignal(def.symbol, candles);
        const atrDaily = last(atr(daily, 14));
        const o: any = buildDayOpportunity(def, signal, oi as any, atrDaily, { benchmarks: [], stockDaily: daily || [], candles });
        const rg = deps.getRegime ? await deps.getRegime(def.symbol) : null;
        if (!o) { rows.push({ s: def.symbol, drop: "no direction (dir=0) or no OI", regime: rg?.regime, adx: rg?.adx }); continue; }
        // Replicate the engine sizing math so we can see exactly why 0 lots.
        const lot = def.lotSize || 0;
        const lossPerLot = Math.max(1, (o.premium - o.premiumStop) * lot);
        const pool = 40000; // default index pool
        const confScale = Math.max(0.6, Math.min(1.3, (o.confidence ?? 55) / 75));
        let lots = Math.floor((pool * 0.01 * confScale) / lossPerLot);
        if (lots < 1 && lossPerLot <= pool * 0.10) lots = 1;
        const cost = o.premium * lot;
        rows.push({
          s: def.symbol, dir: o.direction, conf: o.confidence, tradeable: o.tradeable,
          dte: o.dte, thetaPctDay: o.thetaPctPerDay,
          regime: rg?.regime, adx: rg?.adx,
          premium: o.premium, premiumStop: o.premiumStop, premiumTarget: o.premiumTarget, lot,
          lossPerLot: Math.round(lossPerLot), ceil10pct: pool * 0.10, lots, costPerLot: Math.round(cost),
          blockedBy: !o.tradeable ? "source:tradeable=false" : !o.highProb ? "source:highProb=false" : (o.confidence ?? 0) < 68 ? "engine:conf<68" : rg?.regime === "Compressed" ? "engine:regime=Compressed" : lots < 1 ? "engine:0-lots (risk>10% pool)" : cost > pool ? "engine:cost>cash" : "would-open",
        });
      } catch (e: any) { rows.push({ s: def.symbol, drop: "threw: " + (e?.message || "?") }); }
    }
    return rows;
  };
  // Scalp-path debug: what the anticipation scalp sees across all F&O indices.
  const scalpDebug = async () => {
    const defs = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno).slice(0, 4);
    const rows: any[] = [];
    for (const def of defs) {
      try {
        const [c5, oi] = await Promise.all([getCandlesCached(def.symbol, "5m"), getOiCached(def) as Promise<OiAnalysis>]);
        if (!c5 || c5.length < 30) { rows.push({ s: def.symbol, note: `c5=${c5?.length ?? 0}` }); continue; }
        const att = computeAttempts(c5, 40);
        const spot = c5[c5.length - 1].close;
        const atmStrike = nearestStrike(spot, def);
        const atm = (oi?.topStrikes || []).reduce((b: any, s: any) => (b == null || Math.abs(s.strike - atmStrike) < Math.abs(b.strike - atmStrike) ? s : b), null as any);
        rows.push({
          s: def.symbol, pressure: att.pressure, attU: att.attemptsUp, attD: att.attemptsDown,
          hl: att.higherLows, lh: att.lowerHighs, nearPct: att.nearLevelPct, level: att.level, spot: Math.round(spot),
          oiAvail: !!(oi && oi.available), atmStrike: atm?.strike, ceLtp: atm?.ceLtp, peLtp: atm?.peLtp,
        });
      } catch (e: any) { rows.push({ s: def.symbol, err: e?.message }); }
    }
    return rows;
  };
  try {
    const scDbg = await scalpDebug();
    const [io, so, si, sc, idbg] = await Promise.all([
      deps.getIndexOptionIdeas(),
      deps.getStockOptionIdeas(),
      deps.getStockIntradayIdeas(),
      deps.getScalpIdeas ? deps.getScalpIdeas() : Promise.resolve([]),
      indexDebug(),
    ]);
    res.json({
      note: "Ideas that survived the source-level filters (candle-favoured etc). tryOpenOption then applies: conf>=50 (RSI/MACD-free direction), clean>=25, netRR>=1.15, range, heat.",
      scalpDebug: scDbg,
      indexDebug: idbg,
      indexOptions: io.map((i) => ({ s: i.symbol, ot: i.optionType, conf: i.confidence, rr: rr(i), dte: i.dte })),
      stockOptions: so.map((i) => ({ s: i.symbol, ot: i.optionType, conf: i.confidence, clean: i.cleanRating, rr: rr(i), dte: i.dte })),
      intraday: si.map((i) => ({ s: i.symbol, entry: i.entry, rr: i.entry - i.stop > 0 ? Math.round(((i.target - i.entry) / (i.entry - i.stop)) * 100) / 100 : null })),
      scalps: sc.map((i) => ({ s: i.symbol, ot: i.optionType, conf: i.confidence })),
    });
  } catch (e: any) { res.status(502).json({ error: e?.message || "why failed" }); }
});
router.get("/paper/tick", async (req: Request, res: Response) => {
  try {
    res.json(await tickPaper(paperDeps(req.query.force === "true")));
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Paper tick failed" });
  }
});
// Attach a pre-trade risk read (computeRiskRadar) to each OPEN position, so the
// Paper Desk shows the same risk badge as OI Command instead of a bare P&L
// number. Attached at the route layer (not inside paper/engine.ts's tick loop)
// so it never touches the hot autonomous-trading path - purely additive to what
// the UI receives. Best-effort per position: a candle-fetch failure for one
// symbol just omits that position's badge rather than failing the whole poll.
async function withRiskRadar(summary: any): Promise<any> {
  if (!summary || !Array.isArray(summary.open) || !summary.open.length) return summary;
  const open = await Promise.all(
    summary.open.map(async (pos: any) => {
      try {
        const candles = await getCandlesCached(pos.symbol, "15m");
        if (!candles || candles.length < 15) return pos;
        const riskRadar = computeRiskRadar(candles, { interval: "15m" as Interval, premium: pos.lastPrice ?? pos.entryPrice });
        return { ...pos, riskRadar };
      } catch {
        return pos;
      }
    })
  );
  return { ...summary, open };
}
// Fast mark-to-market (open premiums + target/stop exits only). Polled ~1s by the UI.
router.get("/paper/marks", async (req: Request, res: Response) => {
  try {
    res.json(await withRiskRadar(await markPaper(paperDeps(req.query.force === "true"))));
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Paper marks failed" });
  }
});

// ---- Scheduler: auto-snapshot at 9:30, 10:30 ... 15:30 IST on trading days ----
const HOURLY_SLOTS = ["09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30"];
const firedSlots = new Set<string>();
function isTradingTimeIST(d = new Date()): boolean {
  const ist = new Date(d.getTime() + 19800000);
  const day = ist.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930; // 09:15 - 15:30
}
/** Weekday 09:00–15:35 IST — pre-open warmup + a few minutes after close. */
function isFeedWindowIST(d = new Date()): boolean {
  const ist = new Date(d.getTime() + 19800000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 540 && mins <= 935;
}
let hourlySchedulerStarted = false;
export function startHourlyScheduler() {
  if (hourlySchedulerStarted) return;
  hourlySchedulerStarted = true;
  try { syncSessionProvider(); } catch { /* ignore */ }
  setInterval(() => { try { syncSessionProvider(); } catch { /* ignore */ } }, 30_000);
  // Daily login-credential rotation (08:00 IST) - checked every minute so the
  // 08:00 boundary is caught promptly without polling too often; the rotation
  // itself is a no-op unless today hasn't rotated yet (see credentials.ts).
  maybeRotateForNewDay().catch(() => {});
  setInterval(() => { maybeRotateForNewDay().catch(() => {}); }, 60_000);
  setInterval(async () => {
    try {
      if (!isTradingTimeIST()) return;
      const slot = istSlot();
      if (!HOURLY_SLOTS.includes(slot)) return;
      const key = `${istDateStr()} ${slot}`;
      if (firedSlots.has(key)) return;
      firedSlots.add(key);
      const picks = await runHourlyScan();
      appendHourlyPicks(picks);
      // eslint-disable-next-line no-console
      console.log(`[hourly] ${key} recorded ${picks.length} picks.`);
    } catch (e) {
      /* ignore scheduler errors */
    }
  }, 60 * 1000);

  // Autonomous paper-trading tick every 5 minutes during market hours.
  let paperBusy = false;
  setInterval(async () => {
    if (paperBusy || !isTradingTimeIST()) return;
    paperBusy = true;
    try {
      await tickPaper(paperDeps(false));
    } catch {
      /* ignore */
    } finally {
      paperBusy = false;
    }
  }, 5 * 60 * 1000);

  // OI-model scalp algo: retry entries every 90s (OI cache is 90s; paper marks
  // handle exits). Still simulated — no live Groww orders.
  let oiScalpBusy = false;
  setInterval(async () => {
    if (oiScalpBusy || !isTradingTimeIST()) return;
    oiScalpBusy = true;
    try { await tickPaperScalps(paperDeps(false)); } catch { /* ignore */ }
    finally { oiScalpBusy = false; }
  }, 90 * 1000);

  // Telegram: market-online briefing after 09:16 + detailed paper-trade ping
  // when OI Command + correlated models agree. 90s cadence; 20 min cooldown per
  // setup - frequency UNCHANGED by the WhatsApp -> Telegram migration.
  let waBusy = false;
  const runWa = async () => {
    if (waBusy || getProvider().name !== "groww") return;
    waBusy = true;
    try {
      // Background-only ping scan - LOW priority (dev priority mechanism,
      // growwProvider.ts). Only the delivery channel changed.
      const r = await runAsBackgroundGroww(() => tickPaperAlerts({
        marketOpen: isTradingTimeIST(),
        provider: getProvider().name,
        scan: scanOiGridsForPing,
      }));
      if (r.sent.length) console.log(`[telegram] sent ${r.sent.join(", ")}`);
    } catch { /* ignore */ }
    finally { waBusy = false; }
  };
  setTimeout(runWa, 20_000);
  setInterval(runWa, 90 * 1000);

  // OI Change tab is hidden from the UI, but its 3-min background snapshot MUST keep
  // running: it warms the option-chain cache that the Option Top Pick data relies on
  // (best low-decay option + expandable broker chain) and keeps a clean 3-min cadence.
  // Scheduled (background) refresh - LOW priority. The two call sites inside
  // the /oi-change route handler itself (stale-kickoff, cold-start) are
  // serving an actual request and are deliberately left at the default HIGH.
  setInterval(() => { if (isTradingTimeIST()) runAsBackgroundGroww(() => refreshOiChangeSnapshot()); }, 3 * 60 * 1000);

  // Daily log retention sweep — archives files >90d (gzip into data/log/archive),
  // deletes archives >1yr ONLY if LOG_ARCHIVE_DELETE=1. Runs once/day after close.
  let lastSweepDate = "";
  setInterval(() => {
    try {
      const ist = new Date(Date.now() + 19800000);
      const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      const today = ist.toISOString().slice(0, 10);
      if (mins >= 15 * 60 + 35 && lastSweepDate !== today) { lastSweepDate = today; runRetentionSweep(); }
    } catch { /* ignore */ }
  }, 10 * 60 * 1000);
  setTimeout(() => { runAsBackgroundGroww(() => refreshOiChangeSnapshot()); }, 10_000); // seed shortly after startup, LOW priority

  // Monday-morning / session warmup: pull index + liquid F&O candles and OI
  // from 09:00 IST so tabs do not all stampede Groww at 09:15 and hang.
  let warmBusy = false;
  const warmCoreFeeds = async () => {
    if (warmBusy) return;
    warmBusy = true;
    try {
      // Background-only pre-warm - marked LOW priority (dev priority mechanism,
      // growwProvider.ts) so it never makes a real user's dashboard request wait
      // behind it. Nothing else about this function changed.
      await runAsBackgroundGroww(async () => {
        // Each symbol's cache is independent (keyed per symbol/interval, no
        // shared/ordered state) - was sequential across symbols AND across each
        // symbol's own 3 calls. This is background-only (no HTTP response to
        // order), and the shared Groww throttle (growwProvider.ts) still caps
        // real outbound concurrency regardless of how many calls are issued at
        // once here, so this only removes an artificial extra wait, not a limit.
        const idx = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
        await Promise.all(idx.map((def) => Promise.all([
          getCandlesCached(def.symbol, "15m").catch(() => {}),
          getCandlesCached(def.symbol, "5m").catch(() => {}),
          getOiCached(def).catch(() => {}),
        ])));
        const seen = new Set<string>();
        const equitySymbols: typeof DEFAULT_SYMBOLS = [];
        for (const def of DEFAULT_SYMBOLS) {
          if (def.type !== "equity" || !def.fno || seen.has(def.symbol) || equitySymbols.length >= 6) continue;
          seen.add(def.symbol);
          equitySymbols.push(def);
        }
        await Promise.all(equitySymbols.map((def) => getCandlesCached(def.symbol, "15m").catch(() => {})));
      });
    } finally { warmBusy = false; }
  };
  setTimeout(() => { warmCoreFeeds().catch(() => {}); }, 4_000);
  setInterval(() => { if (isFeedWindowIST()) warmCoreFeeds().catch(() => {}); }, 45_000);

  // OI COMMAND signal logger + multi-horizon (5/15/60 min) evaluator. Every 5 min:
  // (1) evaluate any due horizons vs live spot, (2) log a fresh high-confidence
  // signal per F&O index (deduped to a ~15-min cadence per symbol).
  const OI_LOG_MIN = 60; // log signals with confidence >= 60 (review filters >= 80)
  setInterval(async () => {
    try {
      await evaluateOiSignals(async (sym) => { try { const q = await getProvider().getQuote(sym); return (q as any)?.price ?? null; } catch { return null; } });
      if (!isTradingTimeIST() || !growwProviderForOi()) {
        if (!isTradingTimeIST()) {
          for (const def of DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno).slice(0, 2)) {
            try { await withTimeout(buildOiCommand(def), 20_000, "after-hours bulletin " + def.symbol); } catch { /* timeout ok */ }
          }
        }
        return;
      }
      for (const def of DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno)) {
        try {
          const d = await buildOiCommand(def);
          if (d && d.available && d.oiDirection !== "FLAT" && (d.oiMoveScore ?? 0) >= OI_LOG_MIN) {
            logOiSignal({
              symbol: def.symbol, name: def.name, direction: d.oiDirection, optionType: d.setup.optionType,
              strike: d.setup.strike, confidence: d.oiMoveScore, spot: d.spot,
              expLow: Math.abs(d.expectedMove.low), expHigh: Math.abs(d.expectedMove.high),
            });
          }
        } catch (e) { console.error(`[api] skipped ${def.symbol}:`, e instanceof Error ? e.message : e); }
      }
    } catch { /* scheduler best-effort */ }
  }, 5 * 60 * 1000);

  // OPHL ATM-premium sampler: record the ATM CE & PE premiums for the F&O indices
  // every 60s during market hours so the option-breakout signal arms on its own
  // (the OPHL scorer needs a running intraday premium high/avg per strike).
  let sampleBusy = false;
  setInterval(async () => {
    if (sampleBusy || !isTradingTimeIST()) return;
    sampleBusy = true;
    try {
      const day = istDateStr();
      const now = Math.floor(Date.now() / 1000);
      const idx = DEFAULT_SYMBOLS.filter((d) => d.type === "index" && d.fno);
      for (const def of idx) {
        try {
          const oi = (await getOiCached(def)) as OiAnalysis;
          if (!oi || !oi.available || !oi.topStrikes?.length) continue;
          const q = await getProvider().getQuote(def.symbol).catch(() => null);
          const spot = q?.price ?? null;
          if (spot == null) continue;
          const atm = oi.topStrikes.reduce((b: any, r: any) => (b == null || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), null as any);
          if (!atm) continue;
          if (atm.ceLtp != null && atm.ceLtp > 0) recordPremium(def.symbol, "CE", atm.strike, atm.ceLtp, now, day);
          if (atm.peLtp != null && atm.peLtp > 0) recordPremium(def.symbol, "PE", atm.strike, atm.peLtp, now, day);
        } catch { /* skip symbol */ }
      }
    } catch {
      /* ignore */
    } finally {
      sampleBusy = false;
    }
  }, 60 * 1000);

}

// Scalp / momentum-burst for one symbol.
router.get("/scalp/:symbol", async (req: Request, res: Response) => {
  try {
    const interval = parseInterval(req.query.interval);
    const candles = await fetchCandles(req.params.symbol, interval);
    if (candles.length < 30) {
      return res.status(404).json({ error: "Not enough data for momentum analysis." });
    }
    res.json(computeMomentumBurst(req.params.symbol, candles));
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to compute momentum" });
  }
});

// EARLY-MOVE alert: indices + F&O stocks whose move is in its INITIAL stage
// (fresh momentum + volume, not yet extended, potential still to run). Cached 45s.
router.get("/early-moves", async (_req: Request, res: Response) => {
  // 5s cache: the heavy Groww fetches are gated by the independent 30s candle
  // cache (getCandlesCached/getDailyCached), so a 5s recompute just re-reads cached
  // candles + re-runs the detector — fresh UX without extra API load / 429 risk.
  const data = await cached("early-moves", 5_000, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const universe = DEFAULT_SYMBOLS.filter((d) => d.fno);
    const out: any[] = [];
    const BATCH = 6;
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk = universe.slice(i, i + BATCH);
      const part = await Promise.all(chunk.map(async (def) => {
        try {
          const [c5, c15, daily] = await Promise.all([
            getCandlesCached(def.symbol, "5m").catch(() => []),
            getCandlesCached(def.symbol, "15m").catch(() => []),
            getDailyCached(def.symbol, 60).catch(() => []),
          ]);
          const em: any = computeEarlyMove(def.symbol, def.name, def.type === "index" ? "index" : "equity", c5 as any, c15 as any, daily as any);
          if (em) em.isFno = true;
          return em;
        } catch { return null; }
      }));
      out.push(...part.filter(Boolean));
      if (i + BATCH < universe.length) await sleep(120);
    }
    out.sort((a, b) => b.earlyScore - a.earlyScore);
    return { moves: out };
  });
  res.json({
    generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), ...data,
    disclaimer:
      "Early-Move alert flags moves in their INITIAL stage: fresh momentum (squeeze fire / expansion) + volume, " +
      "NOT yet extended, with potential still to run. Direction is a read from price/volume, not a guarantee - confirm and use stops.",
  });
});

// Nearest-ITM OI CHANGE for indices + F&O stocks. Intraday change (vs the day's
// first reading) of the nearest ITM call/put + ATM, with a writing/unwinding read
// and an OI-change bias. ?symbol= for one symbol; otherwise scans the F&O set.
// Scan the OI-change rows for a set of symbols (indices first, with a retry, so an
// index never drops; stocks batched best-effort). Used by the background snapshot.
async function scanOiChangeRows(universe: SymbolDef[]): Promise<any[]> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const indexDefs = universe.filter((d) => d.type === "index");
  const stockDefs = universe.filter((d) => d.type !== "index");
  const rows: any[] = [];
  for (const def of indexDefs) {
    let r: any = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      try {
        const oi = (await getOiCached(def)) as OiAnalysis;
        r = computeOiChange(def.symbol, def.name, "index", oi);
      } catch { /* retry */ }
      if (!r && attempt === 0) await sleep(300);
    }
    if (r) { r.isFno = true; rows.push(r); }
    else rows.push({ symbol: def.symbol, name: def.name, type: "index", isFno: true, underlying: null, atmStrike: null, levels: [], chain: [], best: null, maxCeBuildup: null, maxPeBuildup: null, bias: "Neutral", spotChg: null, spotChgPct: null, major: false, majorReason: null, moveRead: "", note: "Option chain temporarily unavailable — retrying next refresh." });
  }
  const BATCH = 5;
  for (let i = 0; i < stockDefs.length; i += BATCH) {
    const chunk = stockDefs.slice(i, i + BATCH);
    const part = await Promise.all(chunk.map(async (def) => {
      try {
        const oi = (await getOiCached(def)) as OiAnalysis;
        const r: any = computeOiChange(def.symbol, def.name, "equity", oi);
        if (r) r.isFno = true;
        return r;
      } catch { return null; }
    }));
    rows.push(...part.filter(Boolean));
    if (i + BATCH < stockDefs.length) await sleep(150);
  }
  const rank = (b: string) => (b === "Bullish" || b === "Bearish" ? 0 : 1);
  rows.sort((a, b) => (a.type === b.type ? rank(a.bias) - rank(b.bias) : a.type === "index" ? -1 : 1));
  return rows;
}

// Background snapshot so the /oi-change endpoint returns INSTANTLY (the heavy
// 26-chain scan runs on a timer, not on the request).
const oiChangeSnap: { at: number; rows: any[]; busy: boolean } = { at: 0, rows: [], busy: false };
export async function refreshOiChangeSnapshot(): Promise<void> {
  if (oiChangeSnap.busy) return;
  if (!growwProviderForOi()) { oiChangeSnap.at = Date.now(); oiChangeSnap.rows = []; return; }
  oiChangeSnap.busy = true;
  try {
    // INDICES ONLY (4 chains) in the background — this was scanning all ~26 F&O
    // chains every 3 min and breaching Groww's option-chain limit (429). Stocks'
    // OI is now fetched ON-DEMAND when the user opens that stock's OI/chain, so the
    // rate budget stays free for the chain the user is actually looking at.
    const rows = await scanOiChangeRows(DEFAULT_SYMBOLS.filter((d) => d.fno && d.type === "index"));
    oiChangeSnap.rows = rows; oiChangeSnap.at = Date.now();
  } catch { /* keep previous snapshot */ } finally { oiChangeSnap.busy = false; }
}

const OI_CHANGE_DISCLAIMER =
  "OI change is INTRADAY (vs the day's first captured reading). CE OI rising = call writing (resistance); " +
  "PE OI rising = put writing (support). Read alongside price - OI is one input, not a standalone signal.";

router.get("/oi-change", requirePermission("oiAnalysis"), async (req: Request, res: Response) => {
  const provider = getProvider();
  if (provider.name !== "groww") return res.json({ marketOpen: isTradingTimeIST(), rows: [], message: "OI change needs the Groww option chain." });
  // Single symbol: compute on-demand (only 1 chain - fast).
  const one = req.query.symbol ? findSymbolDef(String(req.query.symbol)) : null;
  if (one) {
    const rows = await scanOiChangeRows([one]);
    return res.json({ generatedAt: Math.floor(Date.now() / 1000), marketOpen: isTradingTimeIST(), rows, disclaimer: OI_CHANGE_DISCLAIMER });
  }
  // Full list: return the pre-computed snapshot INSTANTLY. Kick off a background
  // refresh if it's stale (>3 min) so the next poll has fresh data - but never block.
  const ageMs = Date.now() - oiChangeSnap.at;
  if (ageMs > 3 * 60_000 && !oiChangeSnap.busy) refreshOiChangeSnapshot();
  if (oiChangeSnap.at === 0 && !oiChangeSnap.rows.length) {
    // Cold start: compute once so the very first open isn't empty.
    await refreshOiChangeSnapshot();
  }
  res.json({
    generatedAt: Math.floor((oiChangeSnap.at || Date.now()) / 1000),
    marketOpen: isTradingTimeIST(), rows: oiChangeSnap.rows, stale: ageMs > 120_000,
    disclaimer: OI_CHANGE_DISCLAIMER,
  });
});

// Full broker-style option chain for ONE symbol (index or stock) at a chosen
// EXPIRY (exp=0 current, 1 next, ...). Returns Call/Put OI + LTP + % change
// (intraday vs baseline for the current expiry) around the ATM. Used by the
// expandable chain in the OI Change tab.
router.get("/oi-chain", async (req: Request, res: Response) => {
  const provider = getProvider();
  if (provider.name !== "groww") return res.json({ available: false, message: "OI chain needs the Groww feed." });
  const def = findSymbolDef(String(req.query.symbol || ""));
  if (!def || !def.fno) return res.status(404).json({ error: "Unknown F&O symbol." });
  const exp = Math.max(0, Math.min(6, Number(req.query.exp) || 0));
  try {
    const ch = await growwChainForExpiry(provider as GrowwProvider, def, exp);
    if (!ch.available) return res.json({ available: false, symbol: def.symbol, name: def.name, message: ch.message || "chain unavailable" });
    const spot = ch.spot;
    let atm = ch.strikes[0].strike;
    for (const s of ch.strikes) if (Math.abs(s.strike - spot) < Math.abs(atm - spot)) atm = s.strike;
    const atmIdx = ch.strikes.findIndex((s: any) => s.strike === atm);
    const win = ch.strikes.slice(Math.max(0, atmIdx - 7), atmIdx + 8);
    const useBase = exp === 0; // baseline is captured for the current/default expiry only
    const pct = (cur: number | null, base: number | null | undefined) => (base && base > 0 && cur != null ? Math.round(((cur - base) / base) * 1000) / 10 : null);
    const rows = win.map((s: any) => {
      const b = useBase ? oiBaselineStrike(def.symbol, s.strike) : null;
      return {
        strike: s.strike, atm: s.strike === atm,
        ceMoneyness: s.strike < spot ? "ITM" : s.strike > spot ? "OTM" : "ATM",
        peMoneyness: s.strike > spot ? "ITM" : s.strike < spot ? "OTM" : "ATM",
        ceOi: s.ceOi, ceOiPct: b ? pct(s.ceOi, b.ceOi) : null, ceLtp: s.ceLtp, ceLtpPct: b ? pct(s.ceLtp, b.ceLtp) : null, ceVol: s.ceVol,
        peOi: s.peOi, peOiPct: b ? pct(s.peOi, b.peOi) : null, peLtp: s.peLtp, peLtpPct: b ? pct(s.peLtp, b.peLtp) : null, peVol: s.peVol,
      };
    });
    // Spot day-change for the banner (from the live quote).
    let dayChg: number | null = null, dayChgPct: number | null = null;
    try { const q = await provider.getQuote(def.symbol); dayChg = q?.change ?? null; dayChgPct = q?.changePercent ?? null; } catch { /* best effort */ }

    // DIRECTION INDICATOR from the chain: which side OI is building (Call=resistance
    // /bearish, Put=support/bullish), PCR, the OI walls (max CE=resistance, max PE=
    // support) and where price is likely to move.
    let totCe = 0, totPe = 0, ceChg = 0, peChg = 0;
    let maxCe = { oi: -1, strike: 0 }, maxPe = { oi: -1, strike: 0 };
    for (const r of rows) {
      totCe += r.ceOi; totPe += r.peOi;
      if (r.ceOiPct != null) ceChg += (r.ceOi * r.ceOiPct) / 100;
      if (r.peOiPct != null) peChg += (r.peOi * r.peOiPct) / 100;
      if (r.ceOi > maxCe.oi) maxCe = { oi: r.ceOi, strike: r.strike };
      if (r.peOi > maxPe.oi) maxPe = { oi: r.peOi, strike: r.strike };
    }
    const pcr = totCe > 0 ? Math.round((totPe / totCe) * 100) / 100 : null;
    const net = peChg - ceChg; // + = put writing (bullish), - = call writing (bearish)
    const scale = Math.max(1, Math.abs(ceChg) + Math.abs(peChg));
    let score = 0; const reasons: string[] = [];
    if (net > scale * 0.12) { score += 30; reasons.push("Put OI building (support)"); }
    else if (net < -scale * 0.12) { score -= 30; reasons.push("Call OI building (resistance)"); }
    if (pcr != null) {
      if (pcr >= 1.2) { score += 15; reasons.push(`PCR ${pcr} put-heavy`); }
      else if (pcr <= 0.8) { score -= 15; reasons.push(`PCR ${pcr} call-heavy`); }
    }
    if (maxPe.strike && maxCe.strike) {
      const distSup = spot - maxPe.strike, distRes = maxCe.strike - spot;
      if (distSup > 0 && distRes > 0) {
        if (distSup < distRes * 0.5) { score += 10; reasons.push(`near PUT support ${maxPe.strike}`); }
        else if (distRes < distSup * 0.5) { score -= 10; reasons.push(`near CALL resistance ${maxCe.strike}`); }
      }
    }
    score = Math.max(-100, Math.min(100, score));
    const direction = score >= 20 ? "Bullish" : score <= -20 ? "Bearish" : "Neutral";
    const side = net > scale * 0.12 ? "Put" : net < -scale * 0.12 ? "Call" : "Balanced";
    const verdict = {
      side, direction, confidence: Math.min(100, Math.abs(score)),
      pcr, support: maxPe.strike || null, resistance: maxCe.strike || null,
      reasons: reasons.length ? reasons : ["balanced OI - no clear edge"],
    };

    res.json({
      available: true, symbol: def.symbol, name: def.name, type: def.type,
      expiries: ch.expiries, expiry: ch.expiry, expiryIdx: ch.expiryIdx,
      spot, atmStrike: atm, dayChg, dayChgPct, hasBaseline: useBase, verdict,
      rows, asOf: Math.floor(Date.now() / 1000),
      note: useBase ? "% = intraday change vs the day's first reading." : "Next expiry: absolute OI/LTP (intraday % builds once viewed today).",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "chain failed" });
  }
});

// Market-wide scan: WHERE is the big movement / scalp opportunity right now.
router.get("/scalp-scan", async (req: Request, res: Response) => {
  const interval = parseInterval(req.query.interval);
  const results = await Promise.all(
    DEFAULT_SYMBOLS.map(async (def: SymbolDef) => {
      try {
        const candles = await fetchCandles(def.symbol, interval);
        if (candles.length < 30) return null;
        const m = computeMomentumBurst(def.symbol, candles);
        return { ...m, name: def.name, type: def.type };
      } catch {
        return null;
      }
    })
  );
  const scan = (results.filter(Boolean) as any[]).sort((a, b) => b.burstScore - a.burstScore);
  res.json({
    interval,
    generatedAt: Math.floor(Date.now() / 1000),
    scan,
    disclaimer:
      "Momentum burst flags coiling/expanding volatility from price action - it signals WHERE a big " +
      "move may occur, not its direction with certainty. Confirm on entry; scalping needs tight stops and speed.",
  });
});

// Volume & big-player (smart-money) analysis.
router.get("/volume/:symbol", async (req: Request, res: Response) => {
  try {
    const interval = parseInterval(req.query.interval);
    const candles = await fetchCandles(req.params.symbol, interval);
    if (candles.length < 30) {
      return res.status(404).json({ error: "Not enough data for volume analysis." });
    }
    res.json(analyzeVolume(req.params.symbol, candles));
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to analyze volume" });
  }
});

// Ranked best shares to trade now (across the watchlist).
router.get("/opportunities", async (req: Request, res: Response) => {
  const interval = parseInterval(req.query.interval);
  const results = await Promise.all(
    DEFAULT_SYMBOLS.map(async (def: SymbolDef) => {
      try {
        const candles = await fetchCandles(def.symbol, interval);
        if (candles.length < 30) return null;
        const sig = computeSignal(def.symbol, candles);
        const direction: Opportunity["direction"] =
          sig.score >= DIRECTION_THRESHOLD ? "bullish" : sig.score <= -DIRECTION_THRESHOLD ? "bearish" : "neutral";
        const optionType = direction === "bullish" ? "CE" : direction === "bearish" ? "PE" : null;
        const atmStrike = def.fno ? nearestStrike(sig.price, def) : null;
        const opp: Opportunity = {
          symbol: def.symbol,
          name: def.name,
          type: def.type,
          price: sig.price,
          score: sig.score,
          label: sig.label,
          confidence: sig.confidence,
          strength: Math.round((Math.abs(sig.score) * sig.confidence) / 100),
          direction,
          optionType,
          atmStrike,
          lotSize: def.lotSize ?? null,
          fno: !!def.fno,
        };
        return opp;
      } catch {
        return null;
      }
    })
  );

  const opportunities = (results.filter(Boolean) as Opportunity[]).sort(
    (a, b) => b.strength - a.strength
  );
  res.json({ interval, opportunities, disclaimer: DISCLAIMER });
});

// Backtest.
router.get("/backtest/:symbol", requirePermission("backtesting"), async (req: Request, res: Response) => {
  try {
    const interval = parseInterval(req.query.interval);
    const candles = await fetchCandles(req.params.symbol, interval);
    if (candles.length < 60) {
      return res.status(404).json({ error: "Not enough data to backtest." });
    }
    const params = {
      stopLossPercent: req.query.sl ? Number(req.query.sl) : undefined,
      targetPercent: req.query.target ? Number(req.query.target) : undefined,
      allowShort: req.query.short ? req.query.short === "true" : undefined,
      entryThreshold: req.query.threshold ? Number(req.query.threshold) : undefined,
      // cost=0 shows gross; omit for the realistic default round-trip cost.
      roundTripCostPercent: req.query.cost != null ? Number(req.query.cost) : undefined,
    };
    res.json(runBacktest(req.params.symbol, interval, candles, params));
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to run backtest" });
  }
});

// Compare 5m vs 15m over the SAME recent window and pick the better timeframe.
router.get("/backtest-compare/:symbol", requirePermission("backtesting"), async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol;
    const days = req.query.days ? Number(req.query.days) : 15;
    const params = {
      stopLossPercent: req.query.sl ? Number(req.query.sl) : undefined,
      targetPercent: req.query.target ? Number(req.query.target) : undefined,
      allowShort: req.query.short ? req.query.short === "true" : undefined,
      entryThreshold: req.query.threshold ? Number(req.query.threshold) : undefined,
    };
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const intervals: Interval[] = ["5m", "15m"];

    const results = await Promise.all(
      intervals.map(async (iv) => {
        try {
          const all = await getProvider().getCandles(symbol, iv, days + 7);
          const candles = all.filter((c) => c.time >= cutoff);
          if (candles.length < 60) return { interval: iv, error: "Not enough data" };
          const r = runBacktest(symbol, iv, candles, params);
          return {
            interval: iv,
            trades: r.totalTrades,
            winRate: r.winRate,
            netPnlPercent: r.netPnlPercent,
            profitFactor: isFinite(r.profitFactor) ? r.profitFactor : 99,
            expectancyPercent: r.expectancyPercent,
            maxDrawdownPercent: r.maxDrawdownPercent,
          };
        } catch (e: any) {
          return { interval: iv, error: e?.message || "failed" };
        }
      })
    );

    const valid = results.filter((r: any) => !r.error) as any[];
    valid.sort((a, b) => b.netPnlPercent - a.netPnlPercent || b.profitFactor - a.profitFactor);
    const best = valid.length ? valid[0].interval : null;

    res.json({
      symbol,
      days,
      results,
      best,
      bestBasis: "highest net P&L over the same recent window (tie-break: profit factor)",
      disclaimer:
        "Both timeframes tested on the same recent " +
        days +
        "-day window. No brokerage/slippage/taxes; delayed data; small sample - indicative only.",
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "Failed to compare backtests" });
  }
});

// ======================= Master Strategy Lab (QA / validation) =======================
// Read + execute endpoints for the Master Strategy Lab screen. These run the
// REAL engine through backend/qa/* and never modify strategy logic. Gated on the
// "backtesting" permission (admin passes implicitly) - the Lab exposes strategy
// file hashes and the git commit, which is operator information, not user data.
//
// NOTE: nothing here enables live trading. /qa/state only REPORTS a blocked
// state for the UI to display.

router.get("/qa/state", requirePermission("backtesting"), (_req: Request, res: Response) => {
  try {
    res.json({ ...buildLabState(), catalogue: scenarioCatalogue() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Could not build Master Strategy Lab state." });
  }
});

// Executes scenarios against the real engine. Body: { kinds?: string[], ids?: string[] }
router.post("/qa/run", requirePermission("backtesting"), (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k: any) => ["ARBITER", "SCORE", "CANDLE", "FALSE_SETUP"].includes(k)) : undefined;
    const ids = Array.isArray(b.ids) ? b.ids.filter((i: any) => typeof i === "string").slice(0, 500) : undefined;
    const summary = runScenarios({ kinds: kinds?.length ? kinds : undefined, ids: ids?.length ? ids : undefined });
    res.json(summary);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Test run failed." });
  }
});

router.get("/qa/run/:runId", requirePermission("backtesting"), (req: Request, res: Response) => {
  const run = readQaRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Test run not found." });
  res.json(run);
});

// Records the CURRENT strategy state as the integrity baseline. Admin only and
// never automatic: doing this silently would let a changed strategy report as
// intact, which is exactly what the integrity check exists to prevent.
router.post("/qa/baseline", requireAdmin, (req: Request, res: Response) => {
  try {
    const baseline = writeStrategyBaseline();
    const admin = getSession(bearerToken(req));
    logAuditEvent({
      type: "admin_action", userId: admin?.userId ?? null, username: admin?.username ?? null,
      mode: "admin", result: "success",
      detail: `recorded Master Strategy baseline at commit ${baseline.commit ?? "unknown"} (${baseline.files.length} files)`,
    });
    res.json({ ok: true, baseline, integrity: checkStrategyIntegrity() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Could not record baseline." });
  }
});

// ======================= Liquidity sweep detection (observation only) =======================
// DETECTION + LOGGING + UI ONLY. Per §13 this is deliberately NOT wired into
// tryOpenOption() or the Master Trade Selector, and no entry or exit path reads
// it. It reuses the application's existing candles, ATR(14), VWAP, EMA and OI
// rather than recomputing any of them.
router.get("/liquidity/status", requirePermission("oiAnalysis"), async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "").trim();
  const def = findSymbolDef(symbol);
  if (!def) return res.status(400).json({ error: "valid F&O symbol चाहिए" });

  try {
    // 1m for detection (3m is not a supported Interval here), 5m for EMA21/50 +
    // VWAP, daily for PDH/PDL and the previous week.
    const [c1, c5, daily] = await Promise.all([
      getCandlesCached(def.symbol, "1m"),
      getCandlesCached(def.symbol, "5m"),
      getDailyCached(def.symbol, 40),
    ]);
    let oi: any = null;
    try { oi = (await getOiCached(def)) as OiAnalysis; } catch { oi = null; }

    // Reused, not recomputed: PDH/PDL/VWAP/5m swings come from levelContext().
    const lv = levelContext(c5 || [], daily || [], oi);
    const closes5 = (c5 || []).map((c: any) => c.close);
    const ema21 = closes5.length >= 21 ? last(ema(closes5, 21)) : null;
    const ema50 = closes5.length >= 50 ? last(ema(closes5, 50)) : null;
    const spot = c5 && c5.length ? c5[c5.length - 1].close : null;

    const levelSet = buildLiquidityLevels({
      intraday: c1 || [],
      daily: daily || [],
      pdh: lv.pdh, pdl: lv.pdl,
      swingHigh5m: lv.swingHigh, swingLow5m: lv.swingLow,
      oi,
      nowEpoch: Math.floor(Date.now() / 1000),
    });

    const atr14 = atr14Of(c1 || []);
    const detection = detectLiquidity({
      symbol: def.symbol,
      candles: c1 || [],
      rangeHigh: levelSet.openingRange.high,
      rangeLow: levelSet.openingRange.low,
      atr14,
    });

    const entryConcept = entryAfterSweepConcept(detection.sweep);
    const nearest = spot != null ? nearestLevel(levelSet.levels, spot) : null;
    const confirmations = buildConfirmations({
      direction: detection.direction,
      ceBuildup: oi?.ceBuildup ?? null,
      peBuildup: oi?.peBuildup ?? null,
      spot, vwap: lv.vwap, ema21, ema50,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const event = {
      timestamp: nowSec,
      istDate: istDateStr(),
      istTime: new Date(Date.now() + 19800000).toISOString().slice(11, 19),
      symbol: def.symbol,
      rangeHigh: levelSet.openingRange.high,
      rangeLow: levelSet.openingRange.low,
      liquidityLevel: nearest?.price ?? null,
      liquidityLevelType: (nearest?.type ?? "NONE") as any,
      eventType: detection.eventType,
      sweepDirection: detection.direction,
      sweepPrice: detection.sweep?.sweepPrice ?? detection.realBreak?.closePrice ?? null,
      reclaimPrice: detection.sweep?.reclaimPrice ?? null,
      candleTimeframe: LIQUIDITY_CONFIG.detectionInterval,
      ATR14: detection.atr14,
      wickPercentage: detection.sweep?.wickPct ?? null,
      bodyPercentage: detection.sweep?.bodyPct ?? detection.realBreak?.bodyPct ?? null,
      OIState: oiStateFrom(oi?.ceBuildup ?? null, oi?.peBuildup ?? null),
      VWAPState: vwapStateFrom(spot, lv.vwap),
      EMA21: ema21, EMA50: ema50,
      VIX: VIX_UNAVAILABLE,
      trapFlag: detection.trapFlag,
      confirmations,
      entryConcept,
      skipReason: detection.skipReason,
    };
    // Logged once per symbol/event/direction/session; NONE is never logged.
    const logged = logLiquidityEventOnce(event);

    res.json({
      symbol: def.symbol, name: def.name, spot,
      openingRange: levelSet.openingRange,
      levels: levelSet.levels,
      detection: {
        eventType: detection.eventType,
        direction: detection.direction,
        reclaimed: detection.reclaimed,
        trapFlag: detection.trapFlag,
        sweep: detection.sweep,
        realBreak: detection.realBreak,
        sweepCount: detection.allSweeps.length,
        atr14: detection.atr14,
        bufferUsed: detection.bufferUsed,
        skipReason: detection.skipReason,
      },
      confirmations,
      entryConcept,
      notDefined: NOT_DEFINED,
      config: {
        openingRangeWindow: LIQUIDITY_CONFIG.openingRange.label,
        sweepBufferPts: detection.bufferUsed,
        trapWindow: LIQUIDITY_CONFIG.trapWindow.label,
        detectionInterval: LIQUIDITY_CONFIG.detectionInterval,
      },
      loggedThisCall: logged,
      tradingGateConnected: false,
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || "liquidity detection failed" });
  }
});

// Recorded liquidity events, for the §14 observation period.
router.get("/liquidity/events", requirePermission("oiAnalysis"), (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = readLiquidityEvents(limit);
  const count = (t: string) => rows.filter((r) => r.eventType === t).length;
  res.json({
    events: rows,
    summary: {
      total: rows.length,
      sweeps: count("SWEEP"),
      realBreaks: count("REAL_BREAK"),
      traps: count("TRAP"),
      sessions: [...new Set(rows.map((r) => r.istDate))].length,
    },
  });
});

// ======================= Advisory suggestion tracking =======================
// ADVISORY ONLY. These routes read what the system suggested and measure what
// the market actually did. None of them can place an order, and none of them is
// consulted by the decision path.

router.get("/advisory/suggestions", (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const symbol = (req.query.symbol as string) || "";
  let rows = readSuggestions(limit * 3);
  if (symbol) rows = rows.filter((r) => r.symbol === symbol);
  res.json({ windowsMin: WINDOWS_MIN, suggestions: rows.slice(-limit).reverse() });
});

// Measures outcomes for records whose observation windows have elapsed. Spot
// candles come from the active provider; option-premium candles are fetched per
// distinct option symbol and ABSTAIN (rather than guess) when unavailable.
router.get("/advisory/resolve", async (_req: Request, res: Response) => {
  const all = readSuggestions(1000);
  if (!all.length) return res.json({ resolved: 0, pending: 0, total: 0, message: "No advisory suggestions recorded yet." });

  const now = Math.floor(Date.now() / 1000);
  const maxWindow = Math.max(...WINDOWS_MIN) * 60;
  const due = all.filter((r) => !r.resolved && now >= r.at + Math.min(...WINDOWS_MIN) * 60);
  if (!due.length) return res.json({ resolved: 0, pending: all.filter((r) => !r.resolved).length, total: all.length, message: "Nothing due for resolution yet." });

  // One spot-candle fetch per symbol.
  const spotBySymbol = new Map<string, any[]>();
  for (const sym of [...new Set(due.map((r) => r.symbol))]) {
    try { spotBySymbol.set(sym, await getProvider().getCandles(sym, "5m", 5)); }
    catch { spotBySymbol.set(sym, []); }
  }

  // One option-candle fetch per distinct option contract, best-effort.
  const optByKey = new Map<string, any[] | null>();
  const provider: any = growwProviderForOi();
  for (const r of due) {
    if (!r.suggestion.startsWith("BUY") || r.strike == null || !r.optionType || !r.expiry) continue;
    const key = `${r.symbol}|${r.optionType}|${r.strike}|${r.expiry}`;
    if (optByKey.has(key)) continue;
    if (!provider) { optByKey.set(key, null); continue; }
    try {
      const inst = await findOption(r.symbol, r.optionType, r.strike, r.expiry);
      if (!inst) { optByKey.set(key, null); continue; }
      const candles = await growwOptionCandles(provider, inst.tradingSymbol, r.at - 300, r.at + maxWindow + 600, 5);
      optByKey.set(key, candles);
    } catch { optByKey.set(key, null); }
  }

  const byId = new Map(due.map((r) => [r.id, r]));
  let resolvedCount = 0;
  const updated = all.map((rec) => {
    if (!byId.has(rec.id)) return rec;
    const key = `${rec.symbol}|${rec.optionType}|${rec.strike}|${rec.expiry}`;
    const out = resolveRecord(rec, {
      spotCandles: spotBySymbol.get(rec.symbol) || [],
      optionCandles: optByKey.get(key) ?? null,
      now,
    });
    if (out.resolved && !rec.resolved) resolvedCount++;
    return out;
  });
  rewriteSuggestions(updated);

  res.json({
    resolved: resolvedCount,
    pending: updated.filter((r) => !r.resolved).length,
    total: updated.length,
    windowsMin: WINDOWS_MIN,
  });
});

// Per-layer accuracy, computed ONLY from resolved measurements. Returns nulls
// (rendered as NOT RUN) rather than 0% when nothing has been measured.
router.get("/advisory/accuracy", (req: Request, res: Response) => {
  const win = Number(req.query.window);
  const windowMinutes = WINDOWS_MIN.includes(win) ? win : 15;
  res.json(buildAccuracyReport(readSuggestions(1000), windowMinutes));
});

export default router;
