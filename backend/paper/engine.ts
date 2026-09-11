import fs from "fs";
import path from "path";
import { CONFIG } from "../config/arbitration";
// SENTIMENT / LIQUIDITY / RISK EXTENSION (additive). Pure modules composed by
// runExtPipeline() below in the exact Step-11 order. Nothing here edits Setup
// (entryRules.ts), the exit stack, or the capital-guard MATH.
import {
  ExtInputs, MarketRegime, WallReactionState,
  scoreExtension, logOpeningBias, buildRiskComment, RiskComment,
  DedupRecord, DedupContext, checkDedup, armDedup, releaseOnExit, observePrice,
  logDecision,
} from "./ext";

// ---- Autonomous PAPER-trading engine (simulated, no real orders) ----
// THREE independent parts, each with its own capital:
//   1) indexOption   - buy CE/PE on indices (NIFTY / BANKNIFTY / ...)
//   2) stockOption   - buy CE/PE on F&O stocks
//   3) stockIntraday - buy the STOCK intraday (squared off same day; no swing)
// The engine opens/closes trades from injected ideas, marks positions live, and
// records realised/unrealised P&L. State persists to data/paper-state.json.

export type PoolKind = "indexOption" | "stockOption" | "stockIntraday";

export interface PaperPosition {
  id: string;
  kind: PoolKind;
  symbol: string;
  name: string;
  direction?: "Bullish" | "Bearish";
  optionType?: "CE" | "PE";
  strike?: number;
  qty: number;
  entryPrice: number; // premium (option) or share price (intraday)
  spotEntry: number;
  spotTarget: number;
  spotStop: number;
  premiumTarget?: number; // option only
  premiumStop?: number; // option only
  entryEpoch: number;
  entryDay: number;
  confidence?: number;
  strikeReason?: string;
  thetaPctPerDay?: number; // option decay
  cleanRating?: number;
  cleanGrade?: string;
  timeframe?: string; // best signal timeframe (5m/15m/1h/1d)
  horizon?: string; // Scalp / Short / Intraday / Positional
  candlePattern?: string; // confirming candlestick pattern at entry
  scalp?: boolean; // momentum-burst SCALP (quick target, fast exit)
  scalpCapUp?: number; // scalp only: premium level = entry + maxProfitPerLot/lotSize (hard profit ceiling)
  scalpCapDn?: number; // scalp only: premium level = entry - maxLossPerLot/lotSize  (hard loss floor)
  potentialPct?: number;
  potentialPnl?: number;
  winProb?: number; // calibrated 0–100, not raw confidence
  lastSpot?: number;
  lastPrice?: number;
  peakPrice?: number;
  // --- Sentiment/Liquidity/Risk extension (directional options only) ---
  finalScore?: number;              // tradeScore.ts, clamped 52..62 (drives sizing)
  setupQuality?: number;            // tradeScore.ts, 0..100 clarity score
  displayed?: boolean;              // Step 10: setupQuality<30 => logged but hidden from UI
  wallReactionState?: WallReactionState;
  riskComment?: RiskComment;        // Step 8: advisory guard snapshot (never blocks)
  dedupFp?: string;                 // Step 9: fingerprint, released on exit
}

export interface PaperTrade extends PaperPosition {
  exitPrice: number;
  exitEpoch: number;
  exitReason: "target" | "stop" | "eod" | "time" | "end" | "decay" | "stall" | "trail" | "profit" | "reversal" | "risk";
  pnl: number; // NET of costs + slippage
  pnlPct: number;
  grossPnl?: number;
  costs?: number;
  capturedPct?: number | null;
  remark?: string;
}

export interface PaperPool {
  startCapital: number;
  cash: number;
}

export interface PaperState {
  version: number;
  active: boolean;
  days: number;
  startEpoch: number;
  startDate: string;
  tradingDaysElapsed: number;
  lastDayCounted: string;
  lastEntry: Record<PoolKind, number>; // per-pool throttle (epoch)
  lastScalpEntry?: number; // scalp throttle (epoch)
  scalpsToday?: number; // scalps opened today (own budget, separate from tradesToday)
  tradesToday: number;
  tradesTodayDate: string;
  indexOption: PaperPool;
  stockOption: PaperPool;
  stockIntraday: PaperPool;
  open: PaperPosition[];
  closed: PaperTrade[];
  lastCheck?: PaperCheck;      // most recent trade-scan diagnostic
  checkLog?: PaperCheck[];     // recent scans (newest first, capped)
  entryLog?: PaperEntryLog[];  // WHY each auto-trade opened (newest first, capped)
  manualOpen?: ManualPosition[];   // user-entered "Manual Trading" positions (open)
  manualClosed?: ManualTrade[];    // Manual Trading history (closed)
  extDedup?: DedupRecord[];        // Sentiment/Liquidity/Risk extension — dedup fingerprints
  peakEquity?: number;             // running peak total equity (for riskComment drawdown-from-peak)
}

// MANUAL TRADING: a user-entered trade the system then tracks LIVE (real premium /
// spot), applies a SYSTEM trailing stop, marks P&L, and holds through the entry
// month. Saved to history under "Manual Trading" with the user's comment.
export interface ManualPosition {
  id: string;
  symbol: string; name: string;
  instrument: "option" | "equity";
  optionType?: "CE" | "PE";
  strike?: number;
  expiry?: string;                    // option expiry (for live premium lookup)
  direction: "Bullish" | "Bearish";   // equity: Bullish=long, Bearish=short; option: view
  lots: number; lotSize: number; qty: number;
  entryPrice: number;                 // premium (option) or share price (equity)
  entryEpoch: number; entryDate: string;
  comment: string;                    // user's note taken WITH the trade
  trailPct: number;                   // system-defined trailing stop % (off the peak)
  initialStopPct: number;             // system-defined initial hard stop %
  stopPrice: number;                  // current (ratcheting) stop level
  peakPrice: number;                  // best favourable price seen (for the trail)
  lastPrice: number; lastSpot?: number;
  monthEnd: string;                   // square-off date (last day of the entry month)
}
export interface ManualTrade extends ManualPosition {
  exitPrice: number; exitEpoch: number;
  exitReason: "trail" | "manual" | "end" | "stop";
  pnl: number; pnlPct: number; grossPnl: number; costs: number;
}

// A record of ONE auto-trade entry: the exact logic/conditions that triggered it
// (surfaced in the Paper tab so the user can see why the system took each trade).
export interface PaperEntryLog {
  at: number;                // epoch seconds
  kind: PoolKind;
  symbol: string;
  name: string;
  optionType?: "CE" | "PE";
  strike?: number;
  direction?: "Bullish" | "Bearish";
  entryPrice: number;
  qty: number;
  lots: number;
  confidence?: number;
  winProb?: number;
  netRR: number;             // net-of-cost reward:risk that passed the gate
  timeframe?: string;
  pattern?: string;
  scalp?: boolean;
  why: string;               // one-line Hindi explanation of the trigger logic
  // --- Sentiment/Liquidity/Risk extension ---
  finalScore?: number;
  setupQuality?: number;
  displayed?: boolean;
  riskComment?: RiskComment;
}

// Diagnostic of ONE trade-scan cycle: when the system checked and why it did /
// did not take a trade. Surfaced in the Paper tab so the user can see, per cycle,
// which condition blocked an entry.
export interface PaperCheckIdea {
  kind: PoolKind;
  symbol: string;
  optionType?: "CE" | "PE";
  confidence?: number;
  winProb?: number;
  reason: string; // "OPENED" or the first gate that blocked it (Hindi)
}
export interface PaperCheck {
  at: number;           // epoch seconds of the scan
  istDate: string;
  minutesIST: number;
  marketOpen: boolean;
  active: boolean;
  window?: "session" | "closed";
  tradesToday: number;
  opened: number;       // positions opened this cycle
  blocked?: string;     // whole-cycle block (market closed / not active / EOD)
  notes: string[];      // source-level gate notes (Hindi)
  ideas: PaperCheckIdea[]; // per-idea decision
}

export interface OptionIdea {
  symbol: string; name: string; direction: "Bullish" | "Bearish"; optionType: "CE" | "PE";
  strike: number; premium: number; premiumTarget: number; premiumStop: number;
  spot: number; spotTarget: number; spotStop: number; lotSize: number;
  expectedMovePct: number; confidence: number; thetaPctPerDay: number; dte: number | null; strikeReason?: string;
  cleanRating?: number; cleanGrade?: string;
  timeframe?: string; horizon?: string; candlePattern?: string; scalp?: boolean;
  winProb?: number;
}
export interface IntradayIdea {
  symbol: string; name: string; entry: number; stop: number; target: number;
  expectedMovePct: number; confidence: number;
  winProb?: number;
  timeframe?: string; horizon?: string; candlePattern?: string;
}

export interface TickDeps {
  marketOpen: boolean;
  istDate: string;
  minutesIST: number;
  nowEpoch: number;
  getSpot: (symbol: string) => Promise<number | null>;
  getIndexOptionIdeas: () => Promise<OptionIdea[]>;
  getStockOptionIdeas: () => Promise<OptionIdea[]>;
  getStockIntradayIdeas: () => Promise<IntradayIdea[]>;
  getOiBias?: (symbol: string) => Promise<string | null>;
  getOiModule?: (symbol: string) => Promise<{ dir: string; scalp5: string; scalp15: string; dir1h: string } | null>;
  getRegime?: (symbol: string) => Promise<{ regime: string; dir: number; adx: number } | null>;
  getRelVol?: (symbol: string) => Promise<number | null>; // recent volume vs avg (null for indices)
  getScalpIdeas?: () => Promise<OptionIdea[]>; // momentum-burst scalps in the current direction
  // Index-aware stop: parent index's short-term direction for a stock (to tighten
  // a stock option's stop when its index turns against the trade).
  getIndexBiasFor?: (symbol: string) => Promise<{ index: string; dir: number } | null>;
  // Trade Minder: is the current pullback a test (HOLD) or a real reversal (EXIT)?
  getMinder?: (symbol: string, direction: "Bullish" | "Bearish") => Promise<{ state: "HOLD" | "WARNING" | "EXIT"; reason: string } | null>;
  // Live option premium for a specific strike (Manual Trading marking). null if unavailable.
  getOptionPremium?: (symbol: string, type: "CE" | "PE", strike: number, expiry: string) => Promise<number | null>;
  // SENTIMENT/LIQUIDITY/RISK EXTENSION (additive): live inputs for ONE directional
  // (non-scalp) option candidate. When absent, the engine behaves exactly as before
  // (old sizing + hard heat-cap block), so existing callers/tests are unaffected.
  getExtInputs?: (idea: OptionIdea) => Promise<ExtInputs | null>;
}

const FILE = path.join(process.cwd(), "data", "paper-state.json");
const STATE_VERSION = 2; // bumped for the 3-pool model (old option/swing state is reset)
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Realistic win% for a bought-option (never advertised as 80–90). Shrinks toward ~47% until enough closed trades exist. */
export function calibratedWinProb(idea: {
  scalp?: boolean;
  confidence?: number;
  netRR?: number;
  strikeReason?: string;
}): number {
  const s = load();
  const subset = s.closed.filter((t) => !!t.scalp === !!idea.scalp && t.pnl !== 0);
  let empirical = 0.47;
  if (subset.length >= 6) {
    const wr = subset.filter((t) => t.pnl > 0).length / subset.length;
    const w = Math.min(1, subset.length / 36);
    empirical = wr * w + 0.47 * (1 - w);
  }
  const conf = Math.max(0, Math.min(100, idea.confidence ?? 50));
  const confTerm = (conf - 55) / 450;
  const rrTerm = Math.min(0.07, Math.max(-0.06, ((idea.netRR ?? 1.3) - 1.3) * 0.12));
  const oi = /OI-/.test(idea.strikeReason || "");
  const oiTerm = oi ? 0.045 : -0.025;
  let p = empirical + confTerm + rrTerm + oiTerm;
  p = Math.max(0.30, Math.min(0.62, p));
  return Math.round(p * 1000) / 10;
}

// Concurrent-position caps (risk), not clock-hour or daily-count caps.
const MAX_INDEX_OPT = 1;
const MAX_STOCK_OPT = 2;
const MAX_INTRADAY = 2;
const MAX_SCALP = 1; // max concurrent scalps
const MAX_SCALPS_PER_DAY = 999; // no daily scalp quota — quality gate only
const SCALP_THROTTLE = 45; // anti-double-fill, not a trading window
const SCALP_STALL_MIN = 12; // scalps are cut fast if they don't move (vs 30 min)
const MAX_TRADES_PER_DAY = 999; // no daily directional quota — quality gate only
const THROTTLE_SEC = 90; // same-symbol spam guard only
const WIN_PROB_MIN_DIR = 52; // calibrated win% required (realistic, not 90% marketing)
const WIN_PROB_MIN_SCALP = 54;
const EOD_FLATTEN_MIN = 15 * 60 + 25; // square-off near close; entries allowed until then
// Confirmation floor: only take setups with Direction Score / Scalp Score >= this.
const CONFIRM_FLOOR = 72; // skip weak “maybe” buys — win-win only
const RISK_PER_TRADE = 0.01; // 1% of that pool per trade
// One index/large-cap option lot often risks more than the 1% budget (e.g. a
// NIFTY 75-lot risks ~8% of a 40k pool). Without a realistic single-lot ceiling,
// sizing floored to 0 lots and index options NEVER opened. Allow exactly 1 lot
// when its stop-loss risk is within this % of the pool; the portfolio-level
// HEAT_CAP_PCT + MAX_INDEX_OPT=1 still bound total risk.
const MAX_SINGLE_LOT_LOSS_PCT = 0.06; // 10%->6%: a single FINNIFTY stop lost -2882 (7% of pool) - cap single-trade risk
const CLEAN_MIN = 40; // skip choppy stock underlyings — loss cluster
// NET-of-cost reward:risk floor. buildDayOpportunity structurally makes ~1.43
// GROSS R:R, which nets ~1.2 after friction - so a 1.3 net floor blocked almost
// every directional index trade (verified: BANKNIFTY netRR 1.23, FINNIFTY 1.19
// on a clear move). 1.15 still requires reward>risk after costs but lets real
// moves trade so the forward-test can actually collect data.
const OPT_RR_MIN = 1.3; // reverted 1.15->1.3: the loose floor let in low-quality index PEs that were 0% win
const INTRADAY_RR_MIN = 1.3; // intraday needs >= 1.3:1
const HEAT_CAP_PCT = 0.06; // max total open risk = 6% of combined start
const PROFIT_TARGET_PCT = 0.15; // reported target; does not freeze new win-win entries
const DAILY_LOSS_CAP_PCT = 0.03; // halt new entries at -3% realised on the day
const MAX_DRAWDOWN_PCT = 0.1; // book all & stop at -10% total equity
const TRADING_DAY_SEC = 6.25 * 3600;
const DECAY_CUT = 0.8; // option -20% premium -> cut (may be widened by the Minder)
const DECAY_BACKSTOP = 0.65; // hard -35% backstop even when the Minder says HOLD
const STALL_MIN = 30;
const STALL_PROGRESS = 0.25;
// Profit is capped at +15% (see evalOptionExit), so the trailing stop must arm
// BELOW that: arm at +8% and lock if it fades back to +4%. This gives the user's
// "trailing SL + profit not more than 15%" behaviour for 1-lot trades too.
const TRAIL_ARM = 1.08;  // arm the trailing stop at +8%
const TRAIL_GIVE = 1.04; // ...and lock the profit if it fades back to +4%
// Scalp-specific trailing stop. A scalp targets only ~15-20%, so the positional
// +40% trail arm never triggered and winners either hit target or got stall-cut
// at +1%. Arm low (+8%) and give back to +3% so a runner's gains are LOCKED and
// it can ride past the small fixed target instead of being shaken out early.
const SCALP_TRAIL_ARM = 1.08;
const SCALP_TRAIL_GIVE = 1.03;
const SCALP_COST_MULT = 2; // a scalp's gross target profit must be >= 2x round-trip friction (cost-aware)
// Scalp per-lot rupee caps (user rule). NIFTY: book at +₹700/lot, cut at -₹350/lot.
// Every other index (BANKNIFTY/FINNIFTY/MIDCAP): +₹1000/lot, -₹350/lot. These are
// hard ceilings on the mark-to-market P&L, applied FIRST in evalOptionExit.
function scalpRupeeCaps(symbol: string): { maxProfit: number; maxLoss: number } {
  return symbol === "^NSEI" ? { maxProfit: 700, maxLoss: 350 } : { maxProfit: 1000, maxLoss: 350 };
}
const OPT_SLIP = 0.004;
const EQ_SLIP = 0.0005;

const POOLS: PoolKind[] = ["indexOption", "stockOption", "stockIntraday"];
const isOption = (k: PoolKind) => k === "indexOption" || k === "stockOption";

let state: PaperState | null = null;

function emptyState(): PaperState {
  return {
    version: STATE_VERSION, active: false, days: 20, startEpoch: 0, startDate: "",
    tradingDaysElapsed: 0, lastDayCounted: "",
    lastEntry: { indexOption: 0, stockOption: 0, stockIntraday: 0 },
    tradesToday: 0, tradesTodayDate: "",
    indexOption: { startCapital: 0, cash: 0 },
    stockOption: { startCapital: 0, cash: 0 },
    stockIntraday: { startCapital: 0, cash: 0 },
    open: [], closed: [],
  };
}
function load(): PaperState {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    // Reset incompatible (pre-3-pool) state.
    state = parsed && parsed.version === STATE_VERSION && parsed.indexOption ? parsed : emptyState();
  } catch {
    state = emptyState();
  }
  return state!;
}
function save() {
  if (!state) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf-8");
  writeCsvs(state);
}

const poolOf = (s: PaperState, k: PoolKind): PaperPool => s[k];
const totalStart = (s: PaperState) => s.indexOption.startCapital + s.stockOption.startCapital + s.stockIntraday.startCapital;

export function startPaper(indexCapital: number, stockOptionCapital: number, intradayCapital: number, days: number, istDate: string): PaperState {
  state = emptyState();
  state.active = true;
  state.days = days;
  state.startEpoch = Math.floor(Date.now() / 1000);
  state.startDate = istDate;
  state.tradingDaysElapsed = 1;
  state.lastDayCounted = istDate;
  state.tradesTodayDate = istDate;
  state.indexOption = { startCapital: indexCapital, cash: indexCapital };
  state.stockOption = { startCapital: stockOptionCapital, cash: stockOptionCapital };
  state.stockIntraday = { startCapital: intradayCapital, cash: intradayCapital };
  save();
  return state;
}
export function stopPaper(): PaperState { const s = load(); s.active = false; save(); return s; }
export function resetPaper(): PaperState { state = emptyState(); save(); return state; }
// Auto-trade ON/OFF toggle (does NOT reset the run). OFF = pause new entries but
// keep open positions + history; ON = resume. If no run has ever been configured
// (fresh state), turning ON starts a default 3-pool run so the button "just works".
export function setAutoTrade(on: boolean, istDate: string): PaperState {
  const s = load();
  if (on && totalStart(s) <= 0) return startPaper(40000, 40000, 40000, 20, istDate);
  s.active = on;
  save();
  return s;
}

// ================= MANUAL TRADING =================
// System-defined trailing stop parameters (off the peak) + initial hard stop, by
// instrument. "Based on market movement" the stop ratchets up with the peak.
function manualTrailParams(instrument: "option" | "equity", isIndex: boolean): { trailPct: number; initialStopPct: number } {
  if (instrument === "equity") return { trailPct: 0.03, initialStopPct: 0.05 };
  return isIndex ? { trailPct: 0.12, initialStopPct: 0.25 } : { trailPct: 0.15, initialStopPct: 0.30 };
}
function lastDayOfMonth(istDate: string): string {
  const [y, m] = istDate.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  return d.toISOString().slice(0, 10);
}
export function openManual(p: {
  symbol: string; name: string; instrument: "option" | "equity";
  optionType?: "CE" | "PE"; strike?: number; expiry?: string;
  direction: "Bullish" | "Bearish"; entry: number; lots: number; lotSize: number;
  comment: string; isIndex?: boolean; nowEpoch: number; istDate: string;
}): { ok: boolean; error?: string; pos?: ManualPosition } {
  const s = load();
  s.manualOpen = s.manualOpen || [];
  s.manualClosed = s.manualClosed || [];
  if (!(p.entry > 0)) return { ok: false, error: "Entry price ग़लत है।" };
  if (!(p.lots >= 1)) return { ok: false, error: "कम से कम 1 lot चाहिए।" };
  const lotSize = p.instrument === "equity" ? (p.lotSize || 1) : p.lotSize;
  if (!(lotSize >= 1)) return { ok: false, error: "Lot size नहीं मिला।" };
  const { trailPct, initialStopPct } = manualTrailParams(p.instrument, !!p.isIndex);
  const long = p.instrument === "equity" ? p.direction === "Bullish" : true; // options are always bought (long premium)
  const stopPrice = round2(long ? p.entry * (1 - initialStopPct) : p.entry * (1 + initialStopPct));
  const pos: ManualPosition = {
    id: `manual-${p.nowEpoch}-${(p.symbol || "").replace(/[^A-Z0-9]/gi, "")}-${Math.floor(Math.random() * 1e4)}`,
    symbol: p.symbol, name: p.name, instrument: p.instrument,
    optionType: p.optionType, strike: p.strike, expiry: p.expiry,
    direction: p.direction, lots: p.lots, lotSize, qty: p.lots * lotSize,
    entryPrice: round2(p.entry), entryEpoch: p.nowEpoch, entryDate: p.istDate,
    comment: (p.comment || "").slice(0, 500),
    trailPct, initialStopPct, stopPrice, peakPrice: round2(p.entry),
    lastPrice: round2(p.entry), monthEnd: lastDayOfMonth(p.istDate),
  };
  s.manualOpen.unshift(pos);
  save();
  return { ok: true, pos };
}
function closeManualPos(s: PaperState, pos: ManualPosition, exitPrice: number, reason: ManualTrade["exitReason"], nowEpoch: number) {
  const long = pos.instrument === "equity" ? pos.direction === "Bullish" : true;
  const entryVal = pos.entryPrice * pos.qty, exitVal = exitPrice * pos.qty;
  const costs = tradeFriction(pos.instrument === "equity" ? "stockIntraday" : "stockOption", entryVal, exitVal);
  const grossPnl = round2((long ? exitVal - entryVal : entryVal - exitVal));
  const pnl = round2(grossPnl - costs);
  const pnlPct = entryVal ? round2((pnl / entryVal) * 100) : 0;
  const trade: ManualTrade = { ...pos, exitPrice: round2(exitPrice), exitEpoch: nowEpoch, exitReason: reason, pnl, pnlPct, grossPnl, costs };
  s.manualClosed = s.manualClosed || [];
  s.manualClosed.unshift(trade);
  s.manualOpen = (s.manualOpen || []).filter((m) => m.id !== pos.id);
}
export function closeManualById(id: string, nowEpoch: number): { ok: boolean; error?: string } {
  const s = load();
  const pos = (s.manualOpen || []).find((m) => m.id === id);
  if (!pos) return { ok: false, error: "Trade नहीं मिला।" };
  closeManualPos(s, pos, pos.lastPrice ?? pos.entryPrice, "manual", nowEpoch);
  save();
  return { ok: true };
}
// Mark every OPEN manual position live (real premium / spot), ratchet the trailing
// stop, and close on trail-hit or month-end. Runs whenever the market is open,
// independent of the auto engine's on/off state.
export async function markManual(deps: TickDeps): Promise<void> {
  const s = load();
  if (!s.manualOpen || !s.manualOpen.length) return;
  for (const pos of [...s.manualOpen]) {
    let price: number | null = null;
    try {
      if (pos.instrument === "option" && pos.optionType && pos.strike != null && pos.expiry && deps.getOptionPremium) {
        price = await deps.getOptionPremium(pos.symbol, pos.optionType, pos.strike, pos.expiry);
      } else {
        price = await deps.getSpot(pos.symbol);
      }
    } catch { price = null; }
    if (price == null || !(price > 0)) continue;
    pos.lastPrice = round2(price);
    const long = pos.instrument === "equity" ? pos.direction === "Bullish" : true;
    // Ratchet the trailing stop off the best favourable price seen.
    if (long) {
      if (price > pos.peakPrice) pos.peakPrice = round2(price);
      const trail = round2(pos.peakPrice * (1 - pos.trailPct));
      if (trail > pos.stopPrice) pos.stopPrice = trail;
    } else {
      if (price < pos.peakPrice) pos.peakPrice = round2(price);
      const trail = round2(pos.peakPrice * (1 + pos.trailPct));
      if (trail < pos.stopPrice) pos.stopPrice = trail;
    }
    // Month-end square-off (hold through the entry month, then close).
    if (deps.istDate > pos.monthEnd) { closeManualPos(s, pos, price, "end", deps.nowEpoch); continue; }
    // Trailing / initial stop hit.
    const hit = long ? price <= pos.stopPrice : price >= pos.stopPrice;
    if (hit) {
      const moved = long ? pos.peakPrice > pos.entryPrice : pos.peakPrice < pos.entryPrice;
      closeManualPos(s, pos, pos.stopPrice, moved ? "trail" : "stop", deps.nowEpoch);
    }
  }
  save();
}
// Manual P&L summary (live) for the UI.
function manualSummary(s: PaperState): any {
  const openMark = (m: ManualPosition) => {
    const long = m.instrument === "equity" ? m.direction === "Bullish" : true;
    return round2((long ? (m.lastPrice - m.entryPrice) : (m.entryPrice - m.lastPrice)) * m.qty);
  };
  const open = (s.manualOpen || []).map((m) => ({ ...m, unrealisedPnl: openMark(m) }));
  const closed = s.manualClosed || [];
  const realised = round2(closed.reduce((a, t) => a + t.pnl, 0));
  const unrealised = round2(open.reduce((a, m) => a + m.unrealisedPnl, 0));
  const wins = closed.filter((t) => t.pnl > 0).length;
  return {
    open, closed, realisedPnl: realised, unrealisedPnl: unrealised, totalPnl: round2(realised + unrealised),
    openCount: open.length, closedCount: closed.length,
    wins, losses: closed.length - wins,
    winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : 0,
  };
}

function openValue(s: PaperState, kind: PoolKind): number {
  return s.open.filter((p) => p.kind === kind).reduce((sum, p) => sum + (p.lastPrice ?? p.entryPrice) * p.qty, 0);
}
function totalEquityNow(s: PaperState): number {
  return POOLS.reduce((sum, k) => sum + poolOf(s, k).cash + openValue(s, k), 0);
}
// Track running peak equity for the advisory drawdown-from-peak in riskComment.
// (Does NOT change the capital-guard math — the kill switch still measures vs
// starting capital in bookIfMaxDrawdown.)
function updatePeakEquity(s: PaperState): void {
  const eq = totalEquityNow(s);
  if (s.peakEquity == null || eq > s.peakEquity) s.peakEquity = round2(eq);
}
function openRisk(s: PaperState): number {
  return s.open.reduce((sum, p) => {
    const stop = isOption(p.kind) ? (p.premiumStop ?? p.entryPrice) : p.spotStop;
    return sum + Math.max(0, p.entryPrice - stop) * p.qty;
  }, 0);
}

function bookIfProfitTarget(_s: PaperState, _nowEpoch: number): boolean {
  // +15% is a report milestone, not a freeze. New win-win entries stay allowed.
  return false;
}
function bookIfMaxDrawdown(s: PaperState, nowEpoch: number): boolean {
  if (totalStart(s) <= 0 || !s.active) return false;
  if (totalEquityNow(s) <= totalStart(s) * (1 - MAX_DRAWDOWN_PCT)) {
    for (const pos of [...s.open]) closePosition(s, pos, pos.lastPrice ?? pos.entryPrice, "risk", nowEpoch);
    s.active = false;
    return true;
  }
  return false;
}
function dayRealisedPnl(s: PaperState, istDate: string): number {
  return s.closed
    .filter((t) => new Date(t.exitEpoch * 1000 + 19800000).toISOString().slice(0, 10) === istDate)
    .reduce((sum, t) => sum + t.pnl, 0);
}
function dailyLossCapHit(s: PaperState, istDate: string): boolean {
  return totalStart(s) > 0 && dayRealisedPnl(s, istDate) <= -totalStart(s) * DAILY_LOSS_CAP_PCT;
}

// ---- costs / marking ----
function tradeFriction(kind: PoolKind, entryVal: number, exitVal: number): number {
  const slip = isOption(kind) ? OPT_SLIP : EQ_SLIP;
  const slippage = slip * (entryVal + exitVal);
  let charges: number;
  if (isOption(kind)) {
    const brokerage = 40, stt = 0.001 * exitVal, exch = 0.00035 * (entryVal + exitVal), stamp = 0.00003 * entryVal;
    charges = brokerage + stt + exch + stamp + 0.18 * (brokerage + exch);
  } else {
    const brokerage = 0, stt = 0.001 * (entryVal + exitVal), exch = 0.0000297 * (entryVal + exitVal), stamp = 0.00015 * entryVal;
    charges = brokerage + stt + exch + stamp + 0.18 * (brokerage + exch);
  }
  return round2(slippage + charges);
}
function optionMark(pos: PaperPosition, spot: number, nowEpoch: number): number {
  const denom = (pos.spotTarget - pos.spotEntry) || 1;
  const slope = ((pos.premiumTarget ?? pos.entryPrice) - pos.entryPrice) / denom;
  let mark = pos.entryPrice + slope * (spot - pos.spotEntry);
  if (pos.thetaPctPerDay && pos.entryEpoch) {
    const heldFrac = Math.min(1, Math.max(0, (nowEpoch - pos.entryEpoch) / TRADING_DAY_SEC));
    mark -= pos.entryPrice * (pos.thetaPctPerDay / 100) * heldFrac;
  }
  return Math.max(0.05, round2(mark));
}

type ExitReason = PaperTrade["exitReason"];

function buildRemark(pos: PaperPosition, reason: ExitReason, pnlPct: number): string {
  const view = pos.kind === "stockIntraday" ? "long (intraday)" : pos.direction === "Bullish" ? "bullish (CE)" : "bearish (PE)";
  const spotMovePct = pos.lastSpot != null && pos.spotEntry ? Math.round(((pos.lastSpot - pos.spotEntry) / pos.spotEntry) * 1000) / 10 : null;
  const moveStr = spotMovePct == null ? "" : `spot moved ${spotMovePct >= 0 ? "+" : ""}${spotMovePct}%`;
  switch (reason) {
    case "target": return `WIN: ${view}; target hit (+${pnlPct}%). ${moveStr}.`;
    case "stop": return `LOSS: ${view}; stopped out (${pnlPct}%). ${moveStr}.`;
    case "decay": return `LOSS (cut early): ${view}; premium bled from theta/adverse drift, cut at ${pnlPct}%. ${moveStr}.`;
    case "stall": return `CUT: ${view}; no progress and/or OI flipped, exited (${pnlPct}%) before theta ate more. ${moveStr}.`;
    case "trail": return `WIN (protected): was up strongly then pulled back; locked +${pnlPct}%.`;
    case "reversal": return `CUT (trend reversed): trend flipped against the ${view} view; exited ${pnlPct}%. ${moveStr}.`;
    case "profit": return `BOOKED: portfolio hit +${Math.round(PROFIT_TARGET_PCT * 100)}% total target - all closed (${pnlPct}%).`;
    case "risk": return `RISK STOP: portfolio drawdown hit -${Math.round(MAX_DRAWDOWN_PCT * 100)}% - kill switch closed all (${pnlPct}%).`;
    case "eod": return `Closed at day-end (intraday, not held overnight). ${moveStr}. Result ${pnlPct}%.`;
    default: return `Closed. ${moveStr}. Result ${pnlPct}%.`;
  }
}

function closePosition(s: PaperState, pos: PaperPosition, exitPrice: number, reason: ExitReason, nowEpoch: number) {
  const pool = poolOf(s, pos.kind);
  const entryVal = pos.entryPrice * pos.qty;
  const exitVal = exitPrice * pos.qty;
  const costs = tradeFriction(pos.kind, entryVal, exitVal);
  pool.cash = round2(pool.cash + exitVal - costs);
  const grossPnl = round2(exitVal - entryVal);
  const pnl = round2(grossPnl - costs);
  const pnlPct = entryVal ? round2((pnl / entryVal) * 100) : 0;
  const capturedPct = pos.potentialPnl && pos.potentialPnl > 0 ? round2((pnl / pos.potentialPnl) * 100) : null;
  const remark = buildRemark(pos, reason, pnlPct);
  s.closed.push({ ...pos, exitPrice: round2(exitPrice), exitEpoch: nowEpoch, exitReason: reason, pnl, pnlPct, grossPnl, costs, capturedPct, remark });
  s.open = s.open.filter((p) => p.id !== pos.id);
  // EXTENSION: mark this trade's dedup fingerprint as exited (re-arm rules in
  // tradeDedup.ts then gate any re-entry at the same wall).
  if (pos.dedupFp && s.extDedup && s.extDedup.length) releaseOnExit(s.extDedup, pos.dedupFp);
}

function evalOptionExit(pos: PaperPosition, spot: number, nowEpoch: number, opts: { eod: boolean; finished: boolean }): { price: number; reason: ExitReason } | null {
  const bull = pos.direction === "Bullish";
  const mark = optionMark(pos, spot, nowEpoch);
  // SCALP rupee caps bind FIRST — per-lot: NIFTY +₹700/-₹350, other index +₹1000/-₹350.
  // (Absolute premium levels stored at open; independent of the +15% / spot targets.)
  if (pos.scalp && pos.scalpCapUp != null && mark >= pos.scalpCapUp) return { price: pos.scalpCapUp, reason: "target" };
  if (pos.scalp && pos.scalpCapDn != null && mark <= pos.scalpCapDn) return { price: pos.scalpCapDn, reason: "stop" };
  if (bull ? spot >= pos.spotTarget : spot <= pos.spotTarget) return { price: pos.premiumTarget!, reason: "target" };
  if (bull ? spot <= pos.spotStop : spot >= pos.spotStop) return { price: pos.premiumStop!, reason: "stop" };
  // PROFIT CAP (positional only): book at +15% of premium. Scalps use their rupee
  // cap above instead, so a low-premium scalp can still reach the full ₹700/₹1000.
  if (!pos.scalp && mark >= pos.entryPrice * 1.15) return { price: round2(pos.entryPrice * 1.15), reason: "target" };
  // Trailing stop: scalps arm low (+8%) and give back to +3% so trend-runners are
  // protected and allowed to ride; positional trades use the wider +40%/+12%.
  const trailArm = pos.scalp ? SCALP_TRAIL_ARM : TRAIL_ARM;
  const trailGive = pos.scalp ? SCALP_TRAIL_GIVE : TRAIL_GIVE;
  if (pos.peakPrice && pos.peakPrice >= pos.entryPrice * trailArm && mark <= pos.entryPrice * trailGive && mark > pos.entryPrice) return { price: mark, reason: "trail" };
  if (mark <= pos.entryPrice * DECAY_CUT) return { price: mark, reason: "decay" };
  const heldMin = (nowEpoch - pos.entryEpoch) / 60;
  const favMove = bull ? spot - pos.spotEntry : pos.spotEntry - spot;
  const expMove = Math.abs(pos.spotTarget - pos.spotEntry) || 1;
  // MAJOR-MOVE profit book: the underlying has run a MAJOR part of the expected
  // trend (>=70% of the way to target) and the option is in decent profit but now
  // fading from its peak -> book the gain instead of riding it back down.
  if (favMove / expMove >= 0.70 && mark > pos.entryPrice * 1.10 && pos.peakPrice && mark <= pos.peakPrice * 0.9) {
    return { price: mark, reason: "trail" };
  }
  const stallMin = pos.scalp ? SCALP_STALL_MIN : STALL_MIN; // scalps are cut faster
  // Stall cut: don't shake out a scalp that is IN PROFIT (let the trailing stop /
  // target handle winners). Only stall-cut a scalp that is flat/red and going
  // nowhere. Positional trades keep the original stall behaviour.
  const stallOk = !pos.scalp || mark <= pos.entryPrice;
  if (heldMin >= stallMin && favMove / expMove < STALL_PROGRESS && stallOk) return { price: mark, reason: "stall" };
  if (opts.eod || opts.finished) return { price: mark, reason: opts.finished ? "end" : "eod" };
  return null;
}

// Apply the Trade Minder to a proposed exit: on a "test" (Minder HOLD) suppress
// the early stall/decay cut so we don't get shaken out; on a confirmed reversal
// (Minder EXIT) cut even without a stall. Hard stop/target/trail are untouched.
async function applyMinderGate(
  ex: { price: number; reason: ExitReason } | null,
  pos: PaperPosition,
  deps: TickDeps,
): Promise<{ price: number; reason: ExitReason } | null> {
  if (!deps.getMinder || !isOption(pos.kind) || !pos.direction) return ex;
  let m: { state: string } | null = null;
  try { m = await deps.getMinder(pos.symbol, pos.direction); } catch { return ex; }
  if (!m) return ex;
  const mark = pos.lastPrice ?? pos.entryPrice;
  if (ex && (ex.reason === "stall" || ex.reason === "decay")) {
    if (m.state === "HOLD") {
      // It's a test - hold, unless the deep -35% backstop is already breached.
      if (ex.reason === "decay" && mark <= pos.entryPrice * DECAY_BACKSTOP) return ex;
      return null;
    }
  }
  // Confirmed structural reversal while not in profit -> exit even without a stall.
  if (!ex && m.state === "EXIT" && mark <= pos.entryPrice) return { price: mark, reason: "reversal" };
  return ex;
}

export async function markPaper(deps: TickDeps): Promise<any> {
  const s = load();
  if (deps.marketOpen) { try { await markManual(deps); } catch { /* manual marking is best-effort */ } }
  if (!s.active || !deps.marketOpen) return getPaperSummary();
  for (const pos of [...s.open]) {
    const spot = await deps.getSpot(pos.symbol);
    if (spot == null) continue;
    pos.lastSpot = spot;
    // EXTENSION: feed the latest price to the dedup store so an exited fingerprint
    // can register a "move away" from its entry zone (half of move-away-and-return).
    if (s.extDedup && s.extDedup.length) observePrice(s.extDedup, spot);
    if (isOption(pos.kind)) {
      pos.lastPrice = optionMark(pos, spot, deps.nowEpoch);
      pos.peakPrice = Math.max(pos.peakPrice ?? pos.entryPrice, pos.lastPrice);
      let ex = evalOptionExit(pos, spot, deps.nowEpoch, { eod: deps.minutesIST >= EOD_FLATTEN_MIN, finished: false });
      ex = await applyMinderGate(ex, pos, deps); // hold through tests, exit on real reversals
      if (ex) closePosition(s, pos, ex.price, ex.reason, deps.nowEpoch);
    } else {
      pos.lastPrice = round2(spot);
      if (spot >= pos.spotTarget) closePosition(s, pos, pos.spotTarget, "target", deps.nowEpoch);
      else if (spot <= pos.spotStop) closePosition(s, pos, pos.spotStop, "stop", deps.nowEpoch);
    }
  }
  updatePeakEquity(s);
  if (!bookIfProfitTarget(s, deps.nowEpoch)) bookIfMaxDrawdown(s, deps.nowEpoch);
  save();
  return getPaperSummary();
}

// Session is the only clock: NSE 09:15–15:30. No lunch / 3pm / 9:20 windows.
function entryWindow(_minutesIST: number, marketOpen: boolean): "session" | "closed" {
  return marketOpen ? "session" : "closed";
}

// ============ SENTIMENT / LIQUIDITY / RISK EXTENSION — orchestration ============
// The ordered call sequence (Step 11) lives HERE in the engine and composes the
// pure ./ext modules. Applies to DIRECTIONAL (non-scalp) option candidates only.
// Scalp is untouched (its regime/liquidity appear ONLY as shared context inside
// wallReaction, never as new Scalp triggers).
const DISPLAY_QUALITY_MIN = CONFIG.setupQuality.displayThreshold; // Step 10: below this the trade is logged, not shown
const istDayOfEpoch = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(0, 10);

export interface ExtDecision {
  finalScore: number;               // 52..62
  setupQuality: number;             // 0..100
  displayed: boolean;               // setupQuality >= DISPLAY_QUALITY_MIN
  vetoed: boolean;                  // premiumState === "Decaying"
  suppressed: boolean;              // dedup blocked re-fire
  reason: string;
  regime: MarketRegime;
  wallReactionState: WallReactionState;
  rrFloorOverride: number | null;   // 1.5 when sentiment opposed
  relaxTargetForBreak: boolean;     // wallReaction === "BREAK"
  fp: string;
  dedupRecord?: DedupRecord;
  inp: ExtInputs;
  scoreReasons: string[];
}

function runExtPipeline(inp: ExtInputs, idea: OptionIdea, dedupStore: DedupRecord[], nowEpoch: number): ExtDecision {
  // Steps 1–7 run as a single PURE function (shared with the OI Command cockpit).
  const baseConfidence = calibratedWinProb({ scalp: false, confidence: idea.confidence, strikeReason: idea.strikeReason });
  const ext = scoreExtension(inp, { direction: idea.direction, optionType: idea.optionType }, baseConfidence);
  const score = ext.score;
  const regime = ext.regime.marketRegime;
  const wallReactionState = ext.wall.wallReactionState;

  // Opening-bias hit-rate logging (side effect kept out of the pure pipeline).
  if (ext.openingBias) {
    try { logOpeningBias(istDayOfEpoch(nowEpoch), idea.symbol, ext.openingBias, inp.dayOpen ?? inp.spot); } catch { /* best-effort */ }
  }

  const base = {
    finalScore: score.finalScore, setupQuality: score.setupQuality, regime,
    wallReactionState, rrFloorOverride: score.rrFloorOverride,
    relaxTargetForBreak: wallReactionState === "BREAK", inp,
    scoreReasons: [ext.regime.note, ext.liquidity.note, ext.sentiment.note, ext.premium.note, ext.wall.note, ...score.reasons].filter(Boolean),
  };

  if (score.vetoed) {
    return { ...base, displayed: false, vetoed: true, suppressed: false, reason: "premium Decaying (veto)", fp: "" };
  }

  // Step 10 — display threshold (still trades + logs; just hidden from the UI).
  const displayed = score.setupQuality >= DISPLAY_QUALITY_MIN;

  // Step 9 — dedup (after Step 7 + display threshold).
  const atrForZone = inp.atrDaily && inp.atrDaily > 0 ? inp.atrDaily : inp.spot * 0.01;
  const wallHeaviest = inp.wallRef != null && inp.oi ? (inp.wallRef === inp.oi.support || inp.wallRef === inp.oi.resistance) : false;
  const dedupCtx: DedupContext = {
    mode: "directional", direction: idea.direction, strike: idea.strike, entryPrice: inp.spot,
    atr: atrForZone, wallRef: inp.wallRef, wallReaction: wallReactionState,
    regime, wallHeaviest,
  };
  const dd = checkDedup(dedupCtx, dedupStore, nowEpoch);

  return {
    ...base, displayed, vetoed: false, suppressed: !dd.allowed,
    reason: dd.allowed ? "ok" : dd.reason, fp: dd.fp, dedupRecord: dd.record,
  };
}

// Read-only dedup status for a candidate setup (used by the OI Command cockpit to
// show "same setup, no re-entry…"). checkDedup does not mutate the store.
export function extDedupPeek(ctx: DedupContext): { suppressed: boolean; reason: string } {
  const s = load();
  const dd = checkDedup(ctx, s.extDedup || [], Math.floor(Date.now() / 1000));
  return { suppressed: !dd.allowed, reason: dd.reason };
}

// Try to open one option position; returns "OPENED" or a Hindi skip reason.
async function tryOpenOption(s: PaperState, deps: TickDeps, idea: OptionIdea, kind: PoolKind, requireClean: boolean): Promise<string> {
  const r2v = (n: number) => Math.round(n * 100) / 100;
  if (s.open.some((p) => p.kind === kind && p.symbol === idea.symbol)) return `पहले से ${idea.symbol} में position खुला है`;
  if (idea.dte != null && idea.dte <= 1 && (idea.confidence ?? 0) < 80) return `expiry के करीब (dte=${idea.dte}) — conf ${idea.confidence ?? 0}<80 चाहिए`;
  if (requireClean && idea.cleanRating != null && idea.cleanRating < CLEAN_MIN) return `underlying choppy (clean ${idea.cleanRating}<${CLEAN_MIN})`;
  const oiMod = (idea.strikeReason || "").startsWith("OI-");
  const confNeed = oiMod ? 55 : CONFIRM_FLOOR;
  if ((idea.confidence ?? 0) < confNeed) return `confidence कम (${idea.confidence ?? 0}<${confNeed} floor)`;
  if (!oiMod && !idea.scalp && deps.getRegime) {
    try { const rg = await deps.getRegime(idea.symbol); if (rg && rg.regime === "Range") return `regime=Range (flat market — theta risk में buy नहीं)`; } catch { /* ignore */ }
  }

  // ===== SENTIMENT/LIQUIDITY/RISK EXTENSION (directional, non-scalp options) =====
  // Scalp is intentionally excluded from this whole block (Sentiment / opening-bias
  // are never applied to Scalp; regime/liquidity only appear as shared context
  // inside wallReaction). When getExtInputs is absent the engine runs exactly as
  // before (old sizing + hard heat-cap block).
  let extDecision: ExtDecision | null = null;
  if (deps.getExtInputs && isOption(kind) && !idea.scalp) {
    let inp: ExtInputs | null = null;
    try { inp = await deps.getExtInputs(idea); } catch { inp = null; }
    if (inp) {
      s.extDedup = s.extDedup || [];
      extDecision = runExtPipeline(inp, idea, s.extDedup, deps.nowEpoch);
      if (extDecision.vetoed) {
        logDecision({ type: "veto", mode: "Directional", symbol: idea.symbol, text: `${idea.symbol} ${idea.optionType}: VETO — premium Decaying (hard suppress)` });
        return `VETO — premium Decaying (कम range + EMA9 गिर रहा), trade suppress`;
      }
      if (extDecision.suppressed) {
        logDecision({ type: "duplicate", mode: "Directional", symbol: idea.symbol, text: `${idea.symbol} ${idea.optionType}: duplicate, no re-entry — ${extDecision.reason}` });
        return `dedup — ${extDecision.reason}`;
      }
      // On a BREAK read, relax Setup's target-anchored-to-wall cap for THIS trade
      // ONLY. Done here at trade construction (the step that consumes Setup's
      // output) — NOT inside entryRules.ts.
      if (extDecision.relaxTargetForBreak && idea.premiumTarget > idea.premium) {
        const bump = 0.5; // extend 50% further beyond the wall on a genuine break
        idea.spotTarget = r2v(idea.spotTarget + (idea.spotTarget - idea.spot) * bump);
        idea.premiumTarget = r2v(idea.premiumTarget + (idea.premiumTarget - idea.premium) * bump);
      }
    }
  }

  const pool = poolOf(s, kind);
  let rrFloor = idea.scalp ? 1.0 : OPT_RR_MIN; // scalps run tight; the cost-margin gate below enforces the cost edge
  if (extDecision?.rrFloorOverride) rrFloor = Math.max(rrFloor, extDecision.rrFloorOverride); // sentiment opposed -> 1.5
  const lossPerLot = Math.max(1, (idea.premium - idea.premiumStop) * idea.lotSize);
  const rewardPerLot = Math.max(0.01, (idea.premiumTarget - idea.premium) * idea.lotSize);
  if (rewardPerLot / lossPerLot < rrFloor) return `reward:risk कम (${r2v(rewardPerLot / lossPerLot)}<${rrFloor})`;
  // Sizing keys off finalScore (52..62) under the extension, replacing the flat
  // confidence-scaled sizing; falls back to the original when the extension is off.
  const confScale = extDecision
    ? Math.max(0.6, Math.min(1.3, 0.6 + ((extDecision.finalScore - 52) / 10) * 0.7))
    : Math.max(0.6, Math.min(1.3, (idea.confidence ?? 55) / 75));
  let lots = Math.floor((pool.startCapital * RISK_PER_TRADE * confScale) / lossPerLot);
  if (lots < 1 && lossPerLot <= pool.startCapital * MAX_SINGLE_LOT_LOSS_PCT) lots = 1;
  if (lots < 1) return `0 lots (एक lot का risk ₹${Math.round(lossPerLot)} > pool budget का ${Math.round(MAX_SINGLE_LOT_LOSS_PCT * 100)}%)`;
  const qty = lots * idea.lotSize;
  // NET-OF-COST edge check: a bought option must still clear OPT_RR_MIN AFTER
  // paying costs on both legs. On a single lot the fixed brokerage + slippage is
  // a big slice of a small premium move, so this skips trades where costs eat the
  // edge (the main reason 1-lot trades quietly turn into net losses).
  const costWin = tradeFriction(kind, idea.premium * qty, idea.premiumTarget * qty);
  const costLoss = tradeFriction(kind, idea.premium * qty, idea.premiumStop * qty);
  const netReward = (idea.premiumTarget - idea.premium) * qty - costWin;
  const netRisk = (idea.premium - idea.premiumStop) * qty + costLoss;
  if (netReward <= 0 || netReward / netRisk < rrFloor) return `cost के बाद RR कम (net ${r2v(netReward / Math.max(0.01, netRisk))}<${rrFloor}) — brokerage/slippage edge खा रहा`;
  // COST-AWARE SCALP GATE: a scalp's gross target profit must clear round-trip
  // friction by a healthy multiple (>=2x). This blocks thin scalps where the
  // fixed brokerage+slippage eats the edge - the churn that quietly turned a
  // +896 gross day into a -70 net loss.
  if (idea.scalp) {
    const grossReward = (idea.premiumTarget - idea.premium) * qty;
    if (grossReward < (costWin + costLoss) * SCALP_COST_MULT) return `scalp में cost ज़्यादा (target profit round-trip cost का ${SCALP_COST_MULT}x भी नहीं)`;
  }
  const netRR = round2(netReward / Math.max(0.01, netRisk));
  // Under the extension the calibrated win-probability IS finalScore (52..62);
  // otherwise use the original calibrated estimate. The floor gate is unchanged.
  const winP = extDecision ? extDecision.finalScore : calibratedWinProb({ scalp: idea.scalp, confidence: idea.confidence, netRR, strikeReason: idea.strikeReason });
  const winFloor = idea.scalp ? WIN_PROB_MIN_SCALP : WIN_PROB_MIN_DIR;
  if (winP < winFloor) return `win-prob ${winP}% < ${winFloor}% (realistic edge नहीं — skip)`;
  const tradeRisk = (idea.premium - idea.premiumStop) * qty;
  // Capital-guard ENFORCEMENT (Step 8): under the extension the 6% heat cap is
  // ADVISORY — the number is surfaced via riskComment, not a hard block. The MATH
  // is unchanged. Without the extension the original hard block still applies.
  if (!extDecision && openRisk(s) + tradeRisk > totalStart(s) * HEAT_CAP_PCT) return `portfolio risk cap (heat ${Math.round(HEAT_CAP_PCT * 100)}%) भर गया`;
  const cost = idea.premium * qty;
  if (cost > pool.cash) return `premium cost ₹${Math.round(cost)} > pool cash ₹${Math.round(pool.cash)}`;
  // Step 8 — advisory capital-guard snapshot attached to the emitted trade. Never
  // blocks; suggestedSize reflects what the OLD hard guards would have sized.
  let riskComment: RiskComment | undefined;
  if (extDecision) {
    const startTotal = totalStart(s);
    riskComment = buildRiskComment({
      openRisk: openRisk(s), tradeRisk, heatCapAbs: startTotal * HEAT_CAP_PCT,
      dailyRealised: dayRealisedPnl(s, deps.istDate), dailyLossCapAbs: startTotal * DAILY_LOSS_CAP_PCT, startTotal,
      equityNow: totalEquityNow(s), peakEquity: s.peakEquity ?? startTotal, drawdownKillPct: MAX_DRAWDOWN_PCT,
      suggestedLots: lots, suggestedQty: qty, premium: idea.premium,
    });
  }
  pool.cash = round2(pool.cash - cost);
  s.open.push({
    id: `${kind}-${deps.nowEpoch}-${idea.symbol}`, kind, symbol: idea.symbol, name: idea.name,
    direction: idea.direction, optionType: idea.optionType, strike: idea.strike, qty,
    entryPrice: idea.premium, spotEntry: idea.spot, spotTarget: idea.spotTarget, spotStop: idea.spotStop,
    premiumTarget: idea.premiumTarget, premiumStop: idea.premiumStop, entryEpoch: deps.nowEpoch, entryDay: s.tradingDaysElapsed,
    confidence: idea.confidence, thetaPctPerDay: idea.thetaPctPerDay, cleanRating: idea.cleanRating, cleanGrade: idea.cleanGrade,
    timeframe: idea.timeframe, horizon: idea.scalp ? (idea.horizon || "Scalp (momentum)") : idea.horizon, candlePattern: idea.candlePattern, scalp: idea.scalp,
    // Scalp rupee caps as absolute premium levels (per-lot ÷ lotSize → per-share).
    scalpCapUp: idea.scalp ? round2(idea.premium + scalpRupeeCaps(idea.symbol).maxProfit / idea.lotSize) : undefined,
    scalpCapDn: idea.scalp ? round2(Math.max(0.05, idea.premium - scalpRupeeCaps(idea.symbol).maxLoss / idea.lotSize)) : undefined,
    strikeReason: (idea.strikeReason || "") + (idea.cleanGrade ? ` · Clean-move ${idea.cleanGrade} (${idea.cleanRating})` : ""),
    potentialPct: idea.expectedMovePct, potentialPnl: round2((idea.premiumTarget - idea.premium) * qty),
    winProb: winP,
    // Sentiment/Liquidity/Risk extension outputs (undefined when extension is off):
    finalScore: extDecision?.finalScore, setupQuality: extDecision?.setupQuality,
    displayed: extDecision ? extDecision.displayed : undefined,
    wallReactionState: extDecision?.wallReactionState, riskComment, dedupFp: extDecision?.fp || undefined,
    lastSpot: idea.spot, lastPrice: idea.premium,
  });
  // Step 9 — arm the dedup fingerprint so this setup can't immediately re-fire.
  if (extDecision && extDecision.dedupRecord) s.extDedup = armDedup(s.extDedup || [], extDecision.dedupRecord);
  // Decision log: emitted (or below-clarity when hidden from the UI).
  if (extDecision) {
    const below = extDecision.displayed === false;
    logDecision({
      type: below ? "below-clarity" : "emitted", mode: "Directional", symbol: idea.symbol,
      finalScore: extDecision.finalScore, setupQuality: extDecision.setupQuality,
      text: below
        ? `${idea.symbol} ${idea.optionType}: below clarity threshold (setupQuality ${extDecision.setupQuality}<${DISPLAY_QUALITY_MIN}), traded but not shown`
        : `${idea.symbol} ${idea.optionType}: emitted · score ${extDecision.finalScore} · clarity ${extDecision.setupQuality} · ${lots} lot`,
    });
  }
  // AUTO-TRADE LOG: record the exact logic that triggered this entry (Hindi).
  const dirWord = idea.direction === "Bullish" ? "तेज़ी (Bullish)" : "मंदी (Bearish)";
  const kindWord = kind === "indexOption" ? "Index option" : "Stock option";
  const why = `${idea.scalp ? "⚡ Scalp — " : ""}${kindWord}: ${dirWord} में ${idea.optionType} लिया` +
    ` · win-prob ${winP}%` +
    `${idea.confidence != null ? ` · conf ${idea.confidence}%` : ""}` +
    `${idea.timeframe ? ` · ${idea.timeframe} signal` : ""}` +
    ` · net R:R ${netRR} (≥${rrFloor})` +
    `${idea.cleanRating != null ? ` · clean ${idea.cleanRating}` : ""}` +
    `${idea.candlePattern ? ` · 🕯️ ${idea.candlePattern}` : ""}` +
    ` · ${lots} lot × ₹${round2(idea.premium)}` +
    `${idea.strikeReason ? ` · ${idea.strikeReason}` : ""}`;
  s.entryLog = [{
    at: deps.nowEpoch, kind, symbol: idea.symbol, name: idea.name, optionType: idea.optionType,
    strike: idea.strike, direction: idea.direction, entryPrice: round2(idea.premium), qty, lots,
    confidence: idea.confidence, winProb: winP, netRR, timeframe: idea.timeframe, pattern: idea.candlePattern, scalp: idea.scalp, why,
    finalScore: extDecision?.finalScore, setupQuality: extDecision?.setupQuality,
    displayed: extDecision ? extDecision.displayed : undefined, riskComment,
  }, ...(s.entryLog || [])].slice(0, 40);
  return "OPENED";
}

export async function tickPaper(deps: TickDeps): Promise<any> {
  const s = load();
  if (deps.marketOpen) { try { await markManual(deps); } catch { /* manual marking best-effort */ } }
  // Per-cycle trade-scan diagnostic (surfaced in the Paper tab).
  const check: PaperCheck = {
    at: deps.nowEpoch, istDate: deps.istDate, minutesIST: deps.minutesIST,
    marketOpen: deps.marketOpen, active: s.active, tradesToday: s.tradesToday,
    opened: 0, notes: [], ideas: [],
  };
  const recordCheck = () => { s.lastCheck = check; s.checkLog = [check, ...(s.checkLog || [])].slice(0, 20); };
  const recIdea = (kind: PoolKind, idea: OptionIdea, reason: string) => {
    check.ideas.push({ kind, symbol: idea.symbol, optionType: idea.optionType, confidence: idea.confidence, winProb: idea.winProb, reason });
    if (reason === "OPENED") check.opened += 1;
  };

  if (!s.active) { check.blocked = "Paper run active नहीं है — ऊपर Start दबाएँ"; recordCheck(); save(); return getPaperSummary(); }
  if (!deps.marketOpen) { check.blocked = "Market बंद है (NSE trading घंटों 9:15-15:30 के बाहर)"; recordCheck(); save(); return getPaperSummary(); }

  if (deps.istDate !== s.lastDayCounted) { s.tradingDaysElapsed += 1; s.lastDayCounted = deps.istDate; }
  if (deps.istDate !== s.tradesTodayDate) { s.tradesToday = 0; s.scalpsToday = 0; s.tradesTodayDate = deps.istDate; }
  const finished = s.tradingDaysElapsed > s.days;
  const eod = deps.minutesIST >= EOD_FLATTEN_MIN;

  // ---- Exits ----
  for (const pos of [...s.open]) {
    const spot = await deps.getSpot(pos.symbol);
    if (spot == null) continue;
    pos.lastSpot = spot;
    if (s.extDedup && s.extDedup.length) observePrice(s.extDedup, spot);
    const bull = pos.kind === "stockIntraday" ? true : pos.direction === "Bullish";
    if (isOption(pos.kind)) {
      pos.lastPrice = optionMark(pos, spot, deps.nowEpoch);
      pos.peakPrice = Math.max(pos.peakPrice ?? pos.entryPrice, pos.lastPrice);
      let ex = evalOptionExit(pos, spot, deps.nowEpoch, { eod, finished });
      if (!ex && deps.getOiModule) {
        try {
          const m = await deps.getOiModule(pos.symbol);
          if (m) {
            const want = bull ? "UP" : "DOWN";
            const against = bull ? "DOWN" : "UP";
            if (pos.scalp) {
              if (m.scalp5 === against && m.scalp15 === against) {
                ex = { price: optionMark(pos, spot, deps.nowEpoch), reason: "reversal" };
              }
            } else if (m.dir1h === against && m.dir !== want) {
              ex = { price: optionMark(pos, spot, deps.nowEpoch), reason: "reversal" };
            }
          }
        } catch { /* ignore */ }
      }
      if (!ex && deps.getOiBias) {
        try {
          const bias = await deps.getOiBias(pos.symbol);
          const against = (bull && bias === "Bearish") || (!bull && bias === "Bullish");
          const favMove = bull ? spot - pos.spotEntry : pos.spotEntry - spot;
          const expMove = Math.abs(pos.spotTarget - pos.spotEntry) || 1;
          if (against && favMove / expMove < 0.5) ex = { price: optionMark(pos, spot, deps.nowEpoch), reason: "stall" };
        } catch { /* ignore */ }
      }
      if (!ex && deps.getRegime) {
        try {
          const rg = await deps.getRegime(pos.symbol);
          const mark = optionMark(pos, spot, deps.nowEpoch);
          if (rg && rg.dir !== 0 && rg.dir !== (bull ? 1 : -1) && mark <= pos.entryPrice) ex = { price: mark, reason: "reversal" };
        } catch { /* ignore */ }
      }
      // INDEX-aware stop (user rule): if this STOCK option's parent index has turned
      // AGAINST the trade and we're not in profit, cut it — the stock tends to snap
      // back to its index. (Index options themselves are the index, so skip them.)
      if (!ex && pos.kind === "stockOption" && deps.getIndexBiasFor) {
        try {
          const ib = await deps.getIndexBiasFor(pos.symbol);
          const mark = optionMark(pos, spot, deps.nowEpoch);
          if (ib && ib.dir !== 0 && ib.dir !== (bull ? 1 : -1) && mark <= pos.entryPrice) ex = { price: mark, reason: "reversal" };
        } catch { /* ignore */ }
      }
      ex = await applyMinderGate(ex, pos, deps); // hold through tests, exit on real reversals
      if (ex) closePosition(s, pos, ex.price, ex.reason, deps.nowEpoch);
    } else {
      // Intraday equity: target / stop / square-off at EOD (never overnight).
      pos.lastPrice = round2(spot);
      // INDEX-aware stop review: if the parent index turned against this long and
      // we're not in profit, exit early (stock tends to follow its index).
      let idxCut = false;
      if (deps.getIndexBiasFor && spot <= pos.spotEntry) {
        try { const ib = await deps.getIndexBiasFor(pos.symbol); if (ib && ib.dir === -1) idxCut = true; } catch { /* ignore */ }
      }
      if (spot >= pos.spotTarget) closePosition(s, pos, pos.spotTarget, "target", deps.nowEpoch);
      else if (spot <= pos.spotStop) closePosition(s, pos, pos.spotStop, "stop", deps.nowEpoch);
      else if (idxCut) closePosition(s, pos, spot, "reversal", deps.nowEpoch);
      else if (eod || finished) closePosition(s, pos, spot, "eod", deps.nowEpoch);
    }
  }

  updatePeakEquity(s);
  if (bookIfMaxDrawdown(s, deps.nowEpoch)) { check.blocked = "Max drawdown लग गया — run रोका गया"; recordCheck(); save(); return getPaperSummary(); }
  if (finished) { s.active = false; check.blocked = "Paper run की अवधि पूरी हुई"; recordCheck(); save(); return getPaperSummary(); }

  check.window = entryWindow(deps.minutesIST, deps.marketOpen);
  const lossCapHit = dailyLossCapHit(s, deps.istDate);
  if (eod) check.notes.push("15:25+ — square-off window (overnight नहीं)");
  if (lossCapHit) check.notes.push("आज daily loss-cap लग गया — और नए trade नहीं");
  check.notes.push("Clock windows off — win-win setup पर किसी भी समय entry (NSE session)");

  // SCALPS: quality + concurrent cap only
  if (!eod && !lossCapHit && deps.getScalpIdeas &&
      s.open.filter((p) => p.scalp).length < MAX_SCALP &&
      deps.nowEpoch - (s.lastScalpEntry || 0) >= SCALP_THROTTLE) {
    try {
      const scalpIdeas = await deps.getScalpIdeas();
      if (!scalpIdeas.length) check.notes.push("कोई scalp win-win नहीं (5m+15m / OI TAKE नहीं मिला)");
      for (const idea of scalpIdeas) {
        if (s.open.filter((p) => p.scalp).length >= MAX_SCALP) break;
        idea.scalp = true;
        const reason = await tryOpenOption(s, deps, idea, "indexOption", false);
        recIdea("indexOption", idea, reason === "OPENED" ? "OPENED (scalp)" : reason);
        if (reason === "OPENED") { s.scalpsToday = (s.scalpsToday || 0) + 1; s.lastScalpEntry = deps.nowEpoch; }
      }
    } catch { /* ignore */ }
  }

  if (!eod && !lossCapHit) {
    // 1) Index options
    if (s.open.filter((p) => p.kind === "indexOption" && !p.scalp).length >= MAX_INDEX_OPT) check.notes.push(`Index option slot भरा (max ${MAX_INDEX_OPT} open)`);
    else if (deps.nowEpoch - s.lastEntry.indexOption < THROTTLE_SEC) check.notes.push(`Index option: ${THROTTLE_SEC}s anti-spam gap`);
    else {
      try {
        const ideas = await deps.getIndexOptionIdeas();
        if (!ideas.length) check.notes.push("कोई index option idea नहीं (OI TAKE + 1h bulletin नहीं)");
        for (const idea of ideas) {
          if (s.open.filter((p) => p.kind === "indexOption" && !p.scalp).length >= MAX_INDEX_OPT) break;
          const reason = await tryOpenOption(s, deps, idea, "indexOption", false);
          recIdea("indexOption", idea, reason);
          if (reason === "OPENED") { s.tradesToday += 1; s.lastEntry.indexOption = deps.nowEpoch; }
        }
      } catch { /* ignore */ }
    }
    // 2) Stock options
    if (s.open.filter((p) => p.kind === "stockOption").length >= MAX_STOCK_OPT) check.notes.push(`Stock option slots भरे (max ${MAX_STOCK_OPT})`);
    else if (deps.nowEpoch - s.lastEntry.stockOption < THROTTLE_SEC) check.notes.push(`Stock option: ${THROTTLE_SEC}s anti-spam gap`);
    else {
      try {
        const ideas = await deps.getStockOptionIdeas();
        if (!ideas.length) check.notes.push("कोई stock option idea नहीं (clean directional नहीं)");
        for (const idea of ideas) {
          if (s.open.filter((p) => p.kind === "stockOption").length >= MAX_STOCK_OPT) break;
          const reason = await tryOpenOption(s, deps, idea, "stockOption", true);
          recIdea("stockOption", idea, reason);
          if (reason === "OPENED") { s.tradesToday += 1; s.lastEntry.stockOption = deps.nowEpoch; }
        }
      } catch { /* ignore */ }
    }
    // 3) Stock intraday
    if (s.open.filter((p) => p.kind === "stockIntraday").length >= MAX_INTRADAY) check.notes.push(`Stock intraday slots भरे (max ${MAX_INTRADAY})`);
    else if (deps.nowEpoch - s.lastEntry.stockIntraday < THROTTLE_SEC) check.notes.push(`Stock intraday: ${THROTTLE_SEC}s anti-spam gap`);
    else {
      try {
        const intradayIdeas = await deps.getStockIntradayIdeas();
        if (!intradayIdeas.length) check.notes.push("कोई stock-intraday idea नहीं");
        for (const idea of intradayIdeas) {
          if (s.open.filter((p) => p.kind === "stockIntraday").length >= MAX_INTRADAY) break;
          if (s.open.some((p) => p.kind === "stockIntraday" && p.symbol === idea.symbol)) continue;
          if ((idea.confidence ?? 0) < CONFIRM_FLOOR) continue;
          const cur = await deps.getSpot(idea.symbol);
          if (cur == null || cur <= idea.stop || cur >= idea.target) continue;
          const riskPerShare = Math.max(0.05, cur - idea.stop);
          const qty = Math.floor((s.stockIntraday.startCapital * RISK_PER_TRADE) / riskPerShare);
          if (qty < 1) continue;
          const costWin = tradeFriction("stockIntraday", cur * qty, idea.target * qty);
          const costLoss = tradeFriction("stockIntraday", cur * qty, idea.stop * qty);
          const netReward = (idea.target - cur) * qty - costWin;
          const netRisk = riskPerShare * qty + costLoss;
          if (netReward <= 0 || netReward / netRisk < INTRADAY_RR_MIN) continue;
          const iNetRR = round2(netReward / Math.max(0.01, netRisk));
          const winP = calibratedWinProb({ scalp: false, confidence: idea.confidence, netRR: iNetRR });
          if (winP < WIN_PROB_MIN_DIR) continue;
          const tradeRisk = riskPerShare * qty;
          if (openRisk(s) + tradeRisk > totalStart(s) * HEAT_CAP_PCT) continue;
          const cost = cur * qty;
          if (cost > s.stockIntraday.cash) continue;
          s.stockIntraday.cash = round2(s.stockIntraday.cash - cost);
          s.open.push({
            id: `stockIntraday-${deps.nowEpoch}-${idea.symbol}`, kind: "stockIntraday", symbol: idea.symbol, name: idea.name,
            direction: "Bullish", qty, entryPrice: round2(cur), spotEntry: round2(cur), spotTarget: idea.target, spotStop: idea.stop,
            entryEpoch: deps.nowEpoch, entryDay: s.tradingDaysElapsed, confidence: idea.confidence, winProb: winP,
            timeframe: idea.timeframe, horizon: idea.horizon, candlePattern: idea.candlePattern,
            potentialPct: idea.expectedMovePct, potentialPnl: round2((idea.target - cur) * qty), lastSpot: round2(cur), lastPrice: round2(cur),
          });
          s.tradesToday += 1; s.lastEntry.stockIntraday = deps.nowEpoch;
          check.ideas.push({ kind: "stockIntraday", symbol: idea.symbol, confidence: idea.confidence, winProb: winP, reason: "OPENED" });
          check.opened += 1;
          const iLog: PaperEntryLog = {
            at: deps.nowEpoch, kind: "stockIntraday", symbol: idea.symbol, name: idea.name, direction: "Bullish",
            entryPrice: round2(cur), qty, lots: 0, confidence: idea.confidence, winProb: winP, netRR: iNetRR,
            timeframe: idea.timeframe, pattern: idea.candlePattern,
            why: `Stock intraday: win-prob ${winP}% · conf ${idea.confidence ?? 0}% · net R:R ${iNetRR} · ${qty} shares × ₹${round2(cur)}`,
          };
          s.entryLog = [iLog, ...(s.entryLog || [])].slice(0, 40);
        }
      } catch { /* ignore */ }
    }
  }

  recordCheck();
  save();
  return getPaperSummary();
}

// Faster OI-scalp algo loop (~90s). Only tries new scalp entries; exits stay on
// the regular mark/tick path. No live broker orders.
export async function tickPaperScalps(deps: TickDeps): Promise<any> {
  const s = load();
  if (!s.active || !deps.marketOpen) return getPaperSummary();
  if (deps.istDate !== s.tradesTodayDate) { s.tradesToday = 0; s.scalpsToday = 0; s.tradesTodayDate = deps.istDate; }
  const eod = deps.minutesIST >= EOD_FLATTEN_MIN;
  const lossCapHit = dailyLossCapHit(s, deps.istDate);
  if (eod || lossCapHit || !deps.getScalpIdeas) return getPaperSummary();
  if ((s.scalpsToday || 0) >= MAX_SCALPS_PER_DAY) return getPaperSummary();
  if (s.open.filter((p) => p.scalp).length >= MAX_SCALP) return getPaperSummary();
  if (deps.nowEpoch - (s.lastScalpEntry || 0) < SCALP_THROTTLE) return getPaperSummary();
  try {
    const scalpIdeas = await deps.getScalpIdeas();
    for (const idea of scalpIdeas) {
      if ((s.scalpsToday || 0) >= MAX_SCALPS_PER_DAY || s.open.filter((p) => p.scalp).length >= MAX_SCALP) break;
      idea.scalp = true;
      const reason = await tryOpenOption(s, deps, idea, "indexOption", false);
      if (reason === "OPENED") { s.scalpsToday = (s.scalpsToday || 0) + 1; s.lastScalpEntry = deps.nowEpoch; break; }
    }
  } catch { /* ignore */ }
  save();
  return getPaperSummary();
}

function poolSummary(s: PaperState, k: PoolKind) {
  const equity = round2(poolOf(s, k).cash + openValue(s, k));
  const pnl = round2(equity - poolOf(s, k).startCapital);
  const pnlPct = poolOf(s, k).startCapital ? round2((pnl / poolOf(s, k).startCapital) * 100) : 0;
  return { ...poolOf(s, k), equity, pnl, pnlPct };
}

export function getPaperSummary(): any {
  const s = load();
  const closed = s.closed;
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl <= 0).length;
  const decided = wins + losses;
  const totalCosts = round2(closed.reduce((a, t) => a + (t.costs || 0), 0));
  const start = totalStart(s);
  const equity = round2(POOLS.reduce((sum, k) => sum + poolSummary(s, k).equity, 0));
  const todayPnl = round2(dayRealisedPnl(s, s.tradesTodayDate || s.startDate));
  return {
    active: s.active, days: s.days, tradingDaysElapsed: s.tradingDaysElapsed, startDate: s.startDate,
    tradesToday: s.tradesToday, maxTradesPerDay: null, unlimitedEntries: true,
    profitTargetPct: Math.round(PROFIT_TARGET_PCT * 100),
    winProbMinDir: WIN_PROB_MIN_DIR, winProbMinScalp: WIN_PROB_MIN_SCALP,
    mode: "win-win-anytime",
    dailyLossCapPct: Math.round(DAILY_LOSS_CAP_PCT * 100), maxDrawdownPct: Math.round(MAX_DRAWDOWN_PCT * 100),
    todayRealisedPnl: todayPnl, dailyLossCapHit: dailyLossCapHit(s, s.tradesTodayDate || s.startDate),
    entriesHalted: dailyLossCapHit(s, s.tradesTodayDate || s.startDate) || !s.active,
    heatCapPct: Math.round(HEAT_CAP_PCT * 100), openRisk: round2(openRisk(s)),
    peakEquity: s.peakEquity ?? round2(totalStart(s)),
    indexOption: poolSummary(s, "indexOption"),
    stockOption: poolSummary(s, "stockOption"),
    stockIntraday: poolSummary(s, "stockIntraday"),
    totalStart: round2(start), totalEquity: equity, totalPnl: round2(equity - start),
    totalPnlPct: start ? round2(((equity - start) / start) * 100) : 0,
    winRate: decided ? Math.round((wins / decided) * 1000) / 10 : 0,
    wins, losses, totalCosts,
    scalpOpen: s.open.filter((p) => p.scalp).length,
    scalpClosed: s.closed.filter((t) => t.scalp).length,
    scalpsToday: s.scalpsToday || 0,
    maxScalpsPerDay: null,
    // Step 10 — display threshold: setupQuality<30 trades are still simulated,
    // marked, exited and kept in the CSV/backtest data (full s.open/s.closed drive
    // totals above), but they are HIDDEN from the surfaced UI lists here. Trades
    // without a setupQuality (scalp / non-extension) have displayed=undefined and
    // are always shown.
    open: s.open.filter((p) => p.displayed !== false),
    closed: s.closed.filter((t) => t.displayed !== false),
    hiddenOpen: s.open.filter((p) => p.displayed === false).length,
    hiddenClosed: s.closed.filter((t) => t.displayed === false).length,
    lastCheck: s.lastCheck || null,
    checkLog: s.checkLog || [],
    entryLog: (s.entryLog || []).filter((e) => e.displayed !== false),
    manual: manualSummary(s),
  };
}

// ---- daily review + CSV ----
const istDateOf = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(0, 10);
const istTimeOf = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(11, 16);

export interface PaperDailyRow {
  date: string; trades: number; wins: number; losses: number;
  grossProfit: number; grossLoss: number; netPnl: number; worstTrade: number; worstTradeSymbol: string | null; winRate: number;
}
export function dailyReview(): { days: PaperDailyRow[]; totalNet: number; totalLoss: number; totalProfit: number; worstDay: PaperDailyRow | null; lossDays: number } {
  const s = load();
  const byDate = new Map<string, PaperTrade[]>();
  for (const t of s.closed) {
    const d = istDateOf(t.exitEpoch);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(t);
  }
  const days: PaperDailyRow[] = [];
  for (const [date, trades] of byDate) {
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossProfit = round2(wins.reduce((a, t) => a + t.pnl, 0));
    const grossLoss = round2(losses.reduce((a, t) => a + t.pnl, 0));
    let worst = 0, worstSym: string | null = null;
    for (const t of trades) if (t.pnl < worst) { worst = t.pnl; worstSym = t.symbol; }
    days.push({ date, trades: trades.length, wins: wins.length, losses: losses.length, grossProfit, grossLoss, netPnl: round2(grossProfit + grossLoss), worstTrade: round2(worst), worstTradeSymbol: worstSym, winRate: trades.length ? Math.round((wins.length / trades.length) * 1000) / 10 : 0 });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalNet = round2(days.reduce((a, d) => a + d.netPnl, 0));
  const totalLoss = round2(days.reduce((a, d) => a + d.grossLoss, 0));
  const totalProfit = round2(days.reduce((a, d) => a + d.grossProfit, 0));
  const worstDay = days.reduce<PaperDailyRow | null>((w, d) => (!w || d.netPnl < w.netPnl ? d : w), null);
  return { days, totalNet, totalLoss, totalProfit, worstDay, lossDays: days.filter((d) => d.netPnl < 0).length };
}

// ---- EOD learning review: attribution + evidence-based tuning suggestions ----
// Breaks every closed trade down by score bucket, time-of-day, exit reason and
// directional-vs-scalp, so logic changes are grounded in what actually won/lost.
export interface LearnBucket { key: string; n: number; wins: number; winRate: number; net: number; avg: number }
export interface LearnReview {
  totalTrades: number; netPnl: number; expectancyPerTrade: number; winRate: number;
  directional: { n: number; net: number; winRate: number };
  scalp: { n: number; net: number; winRate: number };
  byScore: LearnBucket[];
  byExitReason: LearnBucket[];
  byHour: LearnBucket[];
  byDirection: LearnBucket[];
  byWeekday: LearnBucket[];
  suggestions: string[];
  disclaimer: string;
}
function learnAgg(trades: PaperTrade[], keyFn: (t: PaperTrade) => string): LearnBucket[] {
  const m = new Map<string, PaperTrade[]>();
  for (const t of trades) { const k = keyFn(t); if (!m.has(k)) m.set(k, []); m.get(k)!.push(t); }
  return [...m.entries()].map(([key, arr]) => {
    const wins = arr.filter((t) => t.pnl > 0).length;
    const net = round2(arr.reduce((a, t) => a + t.pnl, 0));
    return { key, n: arr.length, wins, winRate: Math.round((wins / arr.length) * 1000) / 10, net, avg: round2(net / arr.length) };
  }).sort((a, b) => b.n - a.n);
}
export function learnReview(): LearnReview {
  const s = load();
  const trades = s.closed;
  const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const scoreBucket = (t: PaperTrade) => { const c: any = (t as any).confidence; return c == null ? "unknown" : c < 55 ? "<55" : c < 65 ? "55-64" : c < 75 ? "65-74" : "75+"; };
  const hourBucket = (t: PaperTrade) => istTimeOf(t.entryEpoch).slice(0, 2) + ":00";
  const dirTrades = trades.filter((t) => !t.scalp);
  const scTrades = trades.filter((t) => t.scalp);
  const net = (arr: PaperTrade[]) => round2(arr.reduce((a, t) => a + t.pnl, 0));
  const wr = (arr: PaperTrade[]) => (arr.length ? Math.round((arr.filter((t) => t.pnl > 0).length / arr.length) * 1000) / 10 : 0);

  const byScore = learnAgg(trades, scoreBucket);
  const byExitReason = learnAgg(trades, (t) => t.exitReason || "?");
  const byHour = learnAgg(trades, hourBucket);
  const byDirection = learnAgg(trades, (t) => t.optionType || t.direction || "?");
  const byWeekday = learnAgg(trades, (t) => WEEK[new Date(t.entryEpoch * 1000 + 19800000).getUTCDay()]);

  const totalNet = net(trades);
  const suggestions: string[] = [];
  if (!trades.length) suggestions.push("No closed trades yet — let the paper engine run for a few sessions to build the learning dataset.");
  // score-bucket edges
  for (const b of byScore) {
    if (b.n >= 4 && b.net < 0 && b.key !== "unknown") suggestions.push(`Score bucket ${b.key} is NET-NEGATIVE (${b.net} over ${b.n} trades, ${b.winRate}% win) → raise the entry floor above the ${b.key} band.`);
    if (b.n >= 4 && b.net > 0 && (b.key === "65-74" || b.key === "75+")) suggestions.push(`Score bucket ${b.key} is net-positive (${b.net} over ${b.n}, ${b.winRate}% win) → this is where the edge is; concentrate here.`);
  }
  // exit-reason diagnosis
  const stall = byExitReason.find((b) => b.key === "stall");
  const decay = byExitReason.find((b) => b.key === "decay");
  if (stall && stall.n >= 4 && stall.net < 0) suggestions.push(`Many losses are 'stall' (${stall.n}, ${stall.net}) → entries are too early / no follow-through; tighten confirmation before entry.`);
  if (decay && decay.n >= 3 && decay.net < 0) suggestions.push(`'decay' losses (${decay.n}, ${decay.net}) → theta bleed; prefer higher-delta strikes or shorter holds / avoid near-expiry buys.`);
  // time-of-day edges
  for (const b of byHour) if (b.n >= 4 && b.net < 0) suggestions.push(`Entries around ${b.key} are net-negative (${b.net} over ${b.n}) → consider a time filter for that window.`);
  // directional vs scalp
  if (dirTrades.length >= 4 && scTrades.length >= 4) {
    suggestions.push(`Directional ${net(dirTrades)} (${wr(dirTrades)}% win, ${dirTrades.length}) vs Scalp ${net(scTrades)} (${wr(scTrades)}% win, ${scTrades.length}) → ${net(dirTrades) >= net(scTrades) ? "directional is carrying; scalp needs tightening" : "scalp is carrying; directional needs tightening"}.`);
  }
  if (trades.length >= 8 && totalNet < 0) suggestions.push(`Overall NET-NEGATIVE after costs (${totalNet}) → the current logic has no positive edge on this sample; be more selective (raise floors) rather than trade more.`);

  return {
    totalTrades: trades.length, netPnl: totalNet,
    expectancyPerTrade: trades.length ? round2(totalNet / trades.length) : 0,
    winRate: wr(trades),
    directional: { n: dirTrades.length, net: net(dirTrades), winRate: wr(dirTrades) },
    scalp: { n: scTrades.length, net: net(scTrades), winRate: wr(scTrades) },
    byScore, byExitReason, byHour, byDirection, byWeekday, suggestions,
    disclaimer: "EOD attribution of closed PAPER trades (net of costs). Suggestions are evidence-based prompts for logic tuning, applied on review — the engine does not self-modify. Small samples are noisy; weigh buckets with n>=8.",
  };
}

// ---- Hindi daily review: how the system gained + the SPECIFIC loss trades ----
// (loss trades are highlighted regardless of whether the day/overall is in profit).
const REASON_HI: Record<string, string> = {
  target: "टारगेट हिट ✅", stop: "स्टॉप लॉस लगा", stall: "मूव नहीं आया (रुका रहा) — थीटा खा गया",
  reversal: "ट्रेंड उल्टा पड़ गया", decay: "प्रीमियम/थीटा घट गया", eod: "दिन खत्म — स्क्वेयर ऑफ", trail: "ट्रेलिंग स्टॉप पर निकला",
};
const LESSON_HI: Record<string, string> = {
  stall: "सीख: entry जल्दी हो रही है — confirmation का इंतज़ार करो, रुके हुए ट्रेड में मत बैठो।",
  reversal: "सीख: ट्रेंड पलटने पर Trade Minder के signal पर तुरंत निकलो।",
  decay: "सीख: थीटा नुकसान — ज़्यादा delta वाली strike लो या expiry के पास मत खरीदो।",
  eod: "सीख: दिन के अंत तक hold मत करो — समय रहते target/stop पर निकलो।",
  stop: "सीख: स्टॉप सही था — नुकसान छोटा रखा, यही अनुशासन है।",
};
export interface HindiLossTrade { symbol: string; name: string; side: string; entry: number; exit: number; pnl: number; pnlPct: number; reason: string; whyHindi: string; techHindi: string; scalp: boolean; }
export interface HindiDay { date: string; net: number; trades: number; wins: number; losses: number; dayBias: string; gainHindi: string; lossHindi: string; lessonHindi: string; winTrades: HindiLossTrade[]; lossTrades: HindiLossTrade[]; }
const winWhy = (t: PaperTrade): string =>
  t.exitReason === "target" ? "टारगेट हिट ✅ — पूरा मूव पकड़ा"
  : t.exitReason === "trail" ? "ट्रेलिंग स्टॉप — फ़ायदा लॉक किया"
  : "छोटा फ़ायदा — जल्दी बुक/निकल गया (और चल सकता था)";
// Per-trade TECHNICAL comment (Hindi): ties the result to trend-alignment + exit reason.
function techComment(t: PaperTrade, dayBias: "Bullish" | "Bearish" | "Neutral"): string {
  const isCE = t.optionType === "CE", isPE = t.optionType === "PE";
  const against = (isCE && dayBias === "Bearish") || (isPE && dayBias === "Bullish");
  const r = t.exitReason;
  if (t.pnl > 0) {
    if (r === "target") return "ट्रेंड के साथ सही दिशा — structure + VWAP ने रास्ता दिखाया, पूरा मूव target तक पकड़ा। 🏆";
    if (r === "trail") return "ट्रेंड के साथ — ट्रेलिंग स्टॉप ने फ़ायदा लॉक किया।";
    return "दिशा सही थी पर exit बहुत जल्दी (छोटा फ़ायदा) — trailing से और चल सकता था।";
  }
  if (against) {
    if (r === "reversal") return "ट्रेंड के खिलाफ (counter-trend) entry — lagging EMA/MACD ने मोड़ पर पुरानी दिशा दी; trend पलटते ही कटा।";
    return "ट्रेंड के खिलाफ (counter-trend) — structure दूसरी ओर मुड़ चुका था; मूव नहीं आया, थीटा खा गया।";
  }
  if (r === "eod") return "देर से/ऊँची entry (extended move) — follow-through नहीं मिला, EOD तक थीटा खा गया।";
  if (r === "decay") return "थीटा नुकसान — देर से/ऊँची entry या expiry-पास strike; प्रीमियम घट गया।";
  if (r === "stall") return "entry जल्दी/कमज़ोर signal — मूव नहीं आया (रुका रहा), थीटा ने खाया।";
  if (r === "stop") return "दिशा गलत रही, पर स्टॉप ने नुकसान छोटा रखा (अनुशासन)।";
  if (r === "reversal") return "trend पलटा — Trade Minder signal पर समय रहते निकलना था।";
  return "सेटअप ने काम नहीं किया — समीक्षा ज़रूरी।";
}
export function hindiReview(): { days: HindiDay[] } {
  const s = load();
  const byDate = new Map<string, PaperTrade[]>();
  for (const t of s.closed) { const d = istDateOf(t.exitEpoch); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d)!.push(t); }
  const rupee = (n: number) => "₹" + round2(n);
  const days: HindiDay[] = [];
  for (const [date, trades] of byDate) {
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0).sort((a, b) => a.pnl - b.pnl); // worst first
    const net = round2(trades.reduce((a, t) => a + t.pnl, 0));
    // Day trend bias: which side (CE/PE) the day actually rewarded.
    const ceNet = trades.filter((t) => t.optionType === "CE").reduce((a, t) => a + t.pnl, 0);
    const peNet = trades.filter((t) => t.optionType === "PE").reduce((a, t) => a + t.pnl, 0);
    const dayBias: "Bullish" | "Bearish" | "Neutral" = ceNet > peNet ? "Bullish" : peNet > ceNet ? "Bearish" : "Neutral";
    const grossWin = round2(wins.reduce((a, t) => a + t.pnl, 0));
    const label = (t: PaperTrade) => `${t.symbol}${t.optionType ? " " + t.strike + " " + t.optionType : ""}${t.scalp ? " ⚡" : ""}`;
    const topWin = wins.slice().sort((a, b) => b.pnl - a.pnl)[0];
    const gainHindi = wins.length
      ? `आज ${wins.length} ट्रेड जीते, कुल फ़ायदा ${rupee(grossWin)}। सबसे अच्छा: ${topWin ? label(topWin) + " (+" + rupee(topWin.pnl).slice(1) + ", " + (REASON_HI[topWin.exitReason] || topWin.exitReason) + ")" : "-"}।`
      : "आज कोई जीतने वाला ट्रेड नहीं रहा।";
    const worst = losses[0];
    const lossHindi = losses.length
      ? `${losses.length} ट्रेड में नुकसान (कुल ${rupee(round2(losses.reduce((a, t) => a + t.pnl, 0)))})। सबसे बड़ा नुकसान: ${worst ? label(worst) + " (" + rupee(worst.pnl) + " — " + (REASON_HI[worst.exitReason] || worst.exitReason) + ")" : "-"}।`
      : "आज कोई नुकसान वाला ट्रेड नहीं — बढ़िया दिन।";
    // dominant loss reason -> lesson
    const reasonCount = new Map<string, number>();
    for (const t of losses) reasonCount.set(t.exitReason, (reasonCount.get(t.exitReason) || 0) + 1);
    const domReason = [...reasonCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const lessonHindi = losses.length ? (LESSON_HI[domReason] || "सीख: नुकसान वाले सेटअप की समीक्षा करो और कमज़ोर signal पर entry मत लो।") : "आज अनुशासन बना रहा — ऐसे ही चलते रहो।";
    const winSorted = wins.slice().sort((a, b) => b.pnl - a.pnl); // best first
    days.push({
      date, net, trades: trades.length, wins: wins.length, losses: losses.length, dayBias, gainHindi, lossHindi, lessonHindi,
      winTrades: winSorted.map((t) => ({
        symbol: t.symbol, name: t.name, side: t.optionType ? `${t.strike} ${t.optionType}` : t.direction || "-",
        entry: round2(t.entryPrice), exit: round2(t.exitPrice), pnl: round2(t.pnl), pnlPct: t.pnlPct, reason: t.exitReason,
        whyHindi: winWhy(t), techHindi: techComment(t, dayBias), scalp: !!t.scalp,
      })),
      lossTrades: losses.map((t) => ({
        symbol: t.symbol, name: t.name, side: t.optionType ? `${t.strike} ${t.optionType}` : t.direction || "-",
        entry: round2(t.entryPrice), exit: round2(t.exitPrice), pnl: round2(t.pnl), pnlPct: t.pnlPct, reason: t.exitReason,
        whyHindi: REASON_HI[t.exitReason] || t.exitReason, techHindi: techComment(t, dayBias), scalp: !!t.scalp,
      })),
    });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  return { days };
}

const csvCell = (v: any) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function writeCsvs(s: PaperState) {
  try {
    const dir = path.dirname(FILE);
    fs.mkdirSync(dir, { recursive: true });
    const th = ["exitDate", "pool", "symbol", "dir", "strike", "qty", "entry", "exit", "entryIST", "exitIST", "grossPnl", "costs", "pnl", "pnlPct", "reason", "remark"];
    const trows = s.closed.map((t) =>
      [istDateOf(t.exitEpoch), t.kind, t.symbol, t.optionType ?? t.direction ?? "", t.strike ?? "", t.qty, t.entryPrice, t.exitPrice,
        `${istDateOf(t.entryEpoch)} ${istTimeOf(t.entryEpoch)}`, `${istDateOf(t.exitEpoch)} ${istTimeOf(t.exitEpoch)}`,
        t.grossPnl ?? "", t.costs ?? "", round2(t.pnl), t.pnlPct, t.exitReason, t.remark ?? ""].map(csvCell).join(","));
    fs.writeFileSync(path.join(dir, "paper-trades.csv"), [th.join(","), ...trows].join("\n"), "utf-8");
    const review = dailyReview();
    const dh = ["date", "trades", "wins", "losses", "grossProfit", "grossLoss", "netPnl", "worstTrade", "worstSymbol", "winRatePct"];
    const drows = review.days.map((d) => [d.date, d.trades, d.wins, d.losses, d.grossProfit, d.grossLoss, d.netPnl, d.worstTrade, d.worstTradeSymbol ?? "", d.winRate].map(csvCell).join(","));
    fs.writeFileSync(path.join(dir, "paper-daily.csv"), [dh.join(","), ...drows].join("\n"), "utf-8");

    // Day-to-day FEEDBACK for recall (per trade, WITH the Hindi technical comment).
    // UTF-8 BOM so Excel renders the Hindi (Devanagari) text correctly.
    const rvw = hindiReview();
    const rh = ["date", "dayBias", "dayNet", "result", "symbol", "type", "side", "entry", "exit", "pnl", "pnlPct", "exitReason", "reasonHindi", "techCommentHindi", "lessonHindi"];
    const rrows: string[] = [];
    for (const d of rvw.days) {
      const row = (t: HindiLossTrade, result: string) => [d.date, d.dayBias, d.net, result, t.symbol, t.scalp ? "SCALP" : "DIRECTIONAL", t.side, t.entry, t.exit, t.pnl, t.pnlPct, t.reason, t.whyHindi, t.techHindi, d.lessonHindi].map(csvCell).join(",");
      for (const w of d.winTrades) rrows.push(row(w, "WIN"));
      for (const l of d.lossTrades) rrows.push(row(l, "LOSS"));
    }
    fs.writeFileSync(path.join(dir, "paper-review.csv"), "\ufeff" + [rh.join(","), ...rrows].join("\n"), "utf-8");
  } catch { /* best-effort */ }
}
