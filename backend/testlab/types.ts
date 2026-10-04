// ===========================================================================
// UNIVERSAL MARKET INDICATOR — TEST LAB V1  (research/audit only)
// ===========================================================================
// Shared types. This subsystem is fully isolated from the live trading engine:
// nothing here is imported by production signal/paper code. It only READS Dhan
// historical data (via the existing dhanClient/dhanConfig) and writes research
// artifacts under data/test-zone/. No orders, no auto-execution, no param
// optimization. Strict no-lookahead: evaluation at candle T uses only candles
// with time <= T.

import { Candle } from "../types";

export type TfKey = "1m" | "3m" | "5m" | "15m" | "25m" | "60m";
export type IndexKey = "NIFTY" | "BANKNIFTY" | "FINNIFTY" | "SENSEX";
// §3/§4 signal data modes. FUTURES_INTERNAL = every indicator on the SAME
// futures contract (internally consistent, primary validation). SPOT_DIRECTION
// = indicators on index spot; futures price/basis recorded for reference only
// (spot-vs-futures VWAP is NEVER used as a plain VWAP condition without basis
// adjustment, which V1 does not implement).
export type SignalDataMode = "FUTURES_INTERNAL" | "SPOT_DIRECTION";
export type FinalSignal = "BUY" | "SELL" | "WAIT";
export type InternalState = "PRE-MOVE" | "EARLY" | "TRIGGER" | "CONFIRMED" | "EXTENDED" | "REVERSAL" | "NONE";
export type GateStatus = "PASS" | "WARNING" | "BLOCKED";
export type VwapSource = "SPOT" | "FUTURES" | "BASIS_ADJUSTED";
export type VolumeState = "NORMAL" | "EXPANSION" | "WEAK" | "UNKNOWN";
export type Timing = "EARLY" | "TIMELY" | "LATE" | "FALSE" | "MISSED" | "NA";
export type Outcome = "T1" | "T2" | "SL" | "TIME_EXIT" | "EOD_EXIT" | "OPEN" | "BREAKEVEN" | "NONE";

export interface IndexInstrumentConfig {
  key: IndexKey;
  internalSymbol: string;   // app symbol e.g. ^NSEI
  nseSymbol: string;        // Dhan UNDERLYING_SYMBOL e.g. NIFTY
  spotSegment: "IDX_I";
  futSegment: "NSE_FNO" | "BSE_FNO";
  futInstrument: "FUTIDX";
  strikeStep: number;
}

export interface TestConfig {
  index: IndexKey;
  timeframe: TfKey;
  scope: { mode: "custom" | "full"; fromDate?: string; toDate?: string };
  // all instrument-agnostic, config-driven (no hard-coded NIFTY points)
  emaFast: number;
  emaSlow: number;
  atrPeriod: number;
  utKeyValue: number;       // UT Bot ATR multiplier
  utAtrPeriod: number;      // UT Bot ATR period
  regLookback: number;      // linear-regression window (candles)
  srLookback: number;       // support/resistance swing window
  volLookback: number;      // volume baseline window (normalized, not a fixed count)
  volExpansionMult: number; // EXPANSION when vol > median*mult
  volWeakMult: number;      // WEAK when vol < median*mult
  extendedAtrMult: number;  // distanceFromEMA/ATR beyond this => EXTENDED
  rrMin: number;            // minimum reward:risk (default 2.0)
  slAtrBuffer: number;      // extra ATR beyond structural invalidation
  targetAtrMult: number;    // fallback ATR target when no opposing structure
  minHistory: number;       // min candles before any signal (includes prior-session warmup)
  sessionOpenMinIST: number; // first minute a NEW entry is allowed (09:15 IST)
  lateCutoffMinIST: number; // no NEW entries at/after this IST minute (15:10 IST)
  cooldownCandles: number;  // bars to wait after a trade closes
  oneOpenTrade: boolean;
  timeExitBars: number;     // force time exit after N bars
  futuresBinding: "strict" | "spot-fallback"; // strict => invalid binding blocks (spec §6)
  dataMode: SignalDataMode; // §3/§4 primary=FUTURES_INTERNAL
  rrGateMode: "ON" | "OFF"; // legacy field, kept for saved configs — R:R NEVER blocks a signal (information only)
  buyThreshold: number;     // directional-evidence floor to consider BUY
  sellThreshold: number;
  ablationDisable?: string[]; // component names to disable (research)
  // ---- Trade Decision layer (additive; fixed a-priori defaults, not tuned) ----
  warmupSessions?: number;    // prior sessions fetched for indicator warmup (never scored)
  asOfSec?: number;           // live / replay: keep only candles CLOSED by this epoch second
  decision?: DecisionConfig;
}

export interface DecisionConfig {
  dispStrongAtr: number;      // break-bar body >= this * ATR => strong displacement
  closeLocMax: number;        // close in the outer fraction of the bar range (0.35 => bottom/top 35%)
  preLevelAtr: number;        // within this * ATR of a level (with pressure) => PRE_*
  falseBreakBars: number;     // reclaim within N bars of the break => FALSE_*, later => REVERSAL
  zoneLookback: number;       // bars forming the dynamic no-trade box
  zoneMaxAtr: number;         // box height <= this * ATR => balance / no-trade zone
  targetMinAtr: number;       // a level closer than this * ATR is an obstacle, not a target
  genuineMoveAtr: number;     // post-hoc: favourable travel >= this * ATR => genuine move (audit only)
  bigMoveAtr: number;         // post-hoc swing size that must be detected (MISSED audit)
  strikeOffsets: number;      // evaluate ATM-N..ATM+N strikes
  minPremium: number;         // ignore option premiums below this (rupees)
  deltaMin: number; deltaMax: number; // eligible |delta| band
  minTradesForRate: number;   // do not quote a win rate below this many closed trades
  optionData: "ON" | "OFF";
  requireEngineAgreement: boolean;
  directionGuard: boolean;        // 5M direction-conflict + S/R rejection protection (added layer; false = previous behaviour) // execute only when the existing engine's BUY/SELL score lean agrees with the break
}

export interface FuturesBinding {
  underlying: string;
  futuresSymbol: string | null;
  securityId: string | null;
  expiry: string | null;        // yyyy-mm-dd
  exchangeSegment: string | null;
  lotSize: number | null;
  status: "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID";
  bindingReason: string;
}

export interface ComponentScores {
  trend: number;
  structure: number;
  participation: number;
  momentum: number;
  volatility: number;
}

export interface AuditRow {
  timestamp: number;          // epoch sec of the SIGNAL (closed) candle
  iso: string;                // IST ISO
  symbol: string;
  timeframe: TfKey;
  spotPrice: number;
  futuresSymbol: string | null;
  futuresSecurityId: string | null;
  futuresPrice: number | null;
  futuresVolume: number | null;
  futuresOI: number | null;
  previousOI: number | null;      // §6 causal OI
  oiChange: number | null;
  oiChangePercent: number | null;
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  // §4/§5 basis (recorded, never used as a signal condition in V1)
  basis: number | null;
  basisPercent: number | null;
  dataModeUsed: SignalDataMode;
  bindingStatusForDate: "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID";
  contractChange: boolean;
  vwap: number | null;
  vwapSource: VwapSource;
  vwapInstrument: string | null;  // §7 same instrument as the signal series
  vwapSessionDate: string | null; // §7 IST session the VWAP accumulates within
  ema9: number | null;
  ema21: number | null;
  emaDirection: "UP" | "DOWN" | "FLAT";
  priceVsEMA: "ABOVE" | "BELOW" | "AT";
  emaSpread: number | null;
  emaSpreadATR: number | null;
  utState: "BULLISH" | "BEARISH" | "NEUTRAL";
  structureState: string;     // Bullish/Bearish/Ranging (+ provisional/confirmed)
  bos: string;                // NONE / PRE-UP / CONFIRMED-UP / PRE-DOWN / CONFIRMED-DOWN
  volumeState: VolumeState;
  atr: number | null;
  atrPercent: number | null;
  regressionDirection: "UP" | "DOWN" | "FLAT";
  regressionSlope: number | null;
  regressionR2: number | null;
  support: number | null;
  resistance: number | null;
  distanceToSupportATR: number | null;
  distanceToResistanceATR: number | null;
  fakeMove: boolean;
  extendedMove: "NORMAL" | "EXTENDED";
  buyScore: number;
  sellScore: number;
  components: ComponentScores;
  internalState: InternalState;
  signal: FinalSignal;
  signalTimestamp: number;        // §9 the CLOSED signal candle epoch (== timestamp)
  signalClose: number;            // §9 close of the signal candle
  entry: number | null;
  entryTimestamp: number | null;  // §9 the NEXT executable candle
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  rr: number | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  isExpiryDay: boolean;
  expiryRisk: "LOW" | "MEDIUM" | "HIGH";
  dataQuality: GateStatus;
  dataQualityReasons: string[];
  hardGate: boolean;
  hardGateReason: string;
  primaryReason: string;
  secondaryReasons: string[];
  regime: string;
  // outcome (filled by forward walk — OUTCOME only, never fed back as input)
  outcome: Outcome;
  exitPrice: number | null;
  exitTimestamp: number | null;
  mfe: number | null;         // max favourable excursion (R)
  mae: number | null;         // max adverse excursion (R)
  rMultiple: number | null;
  holdBars: number | null;
  timingClassification: Timing;
  fillAmbiguity: boolean;
  // ---- V1.2 HTF (15M direction -> 5M timing) telemetry (optional) ----
  masterDirection?: MasterDirection;
  directionConfidence?: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  directionScore15?: number;       // net 15M directional evidence (signed)
  timingScore5?: number;           // 5M timing-quality score
  riskScore?: number;              // risk-gate aggregate
  vwapEvent?: VwapEvent;           // 5M VWAP interaction state
  entryCandidate?: FinalSignal;    // 5M timing candidate before risk gates
  dir15Ema?: "UP" | "DOWN" | "FLAT";
  dir15VwapSide?: "ABOVE" | "BELOW" | "AT";
  dir15Structure?: string;
  dir15Regime?: string;
  dir15Iso?: string;               // the 15M candle (closed) that drove direction
}


export type MasterDirection = "STRONG_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONG_BEARISH" | "CONFLICT";
export type VwapEvent = "APPROACHING" | "TOUCH" | "BREAK" | "REJECTION" | "RETEST" | "CONFIRMED" | "FAILED" | "NONE";

// One row per candle for the chart: raw OHLC+volume (+OI) with the engine's
// per-candle overlays and the signal it produced. Zipped from candles+oi+rows
// by index in the runner (never recomputed).
export interface ChartCandle {
  t: number;                // epoch seconds
  o: number; h: number; l: number; c: number;
  v: number;
  oi: number | null;
  ema9: number | null;
  ema21: number | null;
  vwap: number | null;
  signal: FinalSignal;
}

export interface PerDateBindingRow {
  date: string;
  status: "RESOLVED" | "UNAVAILABLE_HISTORICAL" | "INVALID";
  futuresSymbol: string | null;
  securityId: string | null;
  expiry: string | null;
  daysToExpiry: number | null;
  bindingReason: string;
  volumeAvailable: boolean;
  oiAvailable: boolean;
  contractChange: boolean;
}

export interface RunResult {
  config: TestConfig;
  dataMode: SignalDataMode;
  binding: FuturesBinding;              // representative (last resolved, else unavailable)
  perDateBinding: PerDateBindingRow[];  // §1 one entry per trading date
  contractChanges: { date: string; from: string | null; to: string | null }[]; // §2
  unavailableDateCount: number;         // trading dates with no date-correct futures
  researchBlockedSignals: number;       // §8 candidate signals blocked by the 14:30 cutoff
  dataRange: { from: string; to: string; totalCandles: number; rejected: number };
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  dataQuality: GateStatus;
  rows: AuditRow[];
  trades: AuditRow[];       // rows that became OPEN trades
  chart: ChartCandle[];     // per-candle OHLC + overlays for the dashboard chart
  metrics: Metrics;
  daily: DailyRow[];
  gateBlocks: Record<string, number>;
  warmup?: { sessions: string[]; candles: number };   // prior sessions loaded for indicator warmup only
  decision?: DecisionResult;                          // additive Trade Decision layer
}

export interface Metrics {
  totalCandles: number;
  buy: number; sell: number; wait: number;
  totalTrades: number;
  wins: number; losses: number; breakeven: number;
  winRate: number; lossRate: number;
  avgR: number; medianR: number; expectancy: number; profitFactor: number;
  maxDrawdownR: number; avgMFE: number; avgMAE: number; avgHoldBars: number;
  timing: Record<Timing, number>;
  outcomes: Record<string, number>;
  normalDays: number; expiryDays: number;
}

export interface DailyRow {
  date: string;
  regime: string;
  buy: number; sell: number; wait: number;
  trades: number; wins: number; losses: number;
  avgR: number; dailyR: number; maxIntradayDDR: number;
  timing: Record<Timing, number>;
  expiryDay: boolean;
  dataQualityIssues: number;
}

export type { Candle };

// ===========================================================================
// TRADE DECISION LAYER (additive) — movement detection is SEPARATE from trade
// execution. Layer A classifies what the market is doing; Layer B builds a plan
// (entry/SL/target/R:R/strike/gamma) and applies execution gates. A failed gate
// never erases a detected movement. All values are causal (candle <= T).
// ===========================================================================
export type MovementState =
  | "PRE_BREAKOUT" | "BREAKOUT_ATTEMPT" | "BREAKOUT_CONFIRMED"
  | "PRE_BREAKDOWN" | "BREAKDOWN_ATTEMPT" | "BREAKDOWN_CONFIRMED"
  | "EXPANSION" | "FALSE_BREAKOUT" | "FALSE_BREAKDOWN" | "REVERSAL" | "NO_EDGE";
export type ExecutionState =
  | "WAIT" | "PRE_BREAKOUT" | "PRE_BREAKDOWN" | "BREAKOUT_ATTEMPT" | "BREAKDOWN_ATTEMPT"
  | "BREAKOUT_CONFIRMED" | "BREAKDOWN_CONFIRMED" | "BUY_READY" | "SELL_READY"
  | "TRADE_BLOCKED_DATA" | "TRADE_BLOCKED_LATE" | "TRADE_BLOCKED_LIQUIDITY"
  | "TRADE_BLOCKED_STRUCTURE" | "HOLD" | "REVERSAL" | "NO_EDGE"
  | "WAIT_FOR_DIRECTION_RECONFIRMATION";   // 5M direction-conflict protection (added layer)
export type GammaState = "NONE" | "BUILDING" | "PRE-BLAST" | "CONFIRMED" | "UNAVAILABLE";
export type EvidenceStatus = "PASS" | "FAIL" | "UNAVAILABLE";
export type DecisionTiming = "EARLY" | "TIMELY" | "LATE" | "FALSE" | "MISSED" | "BLOCKED_DIRECTION" | "BLOCKED_DATA" | "BLOCKED_LATE" | "BLOCKED_STRUCTURE" | "BLOCKED_LIQUIDITY" | "NA";
export type OiFreshness = "LIVE" | "FRESH" | "AGING" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface GammaRead {
  side: "CE" | "PE";
  state: GammaState;
  score: number;              // PASS count (not a probability)
  evaluated: number;          // evidence items that had data
  strike: number | null;
  evidence: Record<string, EvidenceStatus>;
}

export interface StrikeCandidate {
  strike: number; optionType: "CE" | "PE"; offset: number;
  ltp: number; iv: number | null; oi: number | null; oiChange: number | null; volume: number | null;
  delta: number | null; gamma: number | null;           // MODEL-DERIVED (Black-Scholes, feed IV)
  premiumAtT1: number | null; premiumAtSL: number | null;
  premiumResponse: number | null; capacityPct: number | null;
  score: number; eligible: boolean; ineligibleReason: string | null;
}

export interface OptionPlan {
  status: "AVAILABLE" | "DATA UNAVAILABLE";
  reason: string;
  optionType: "CE" | "PE";
  spotAtDecision: number | null;
  expiry: string | null; expirySource: string;
  primary: StrikeCandidate | null;
  alternative: StrikeCandidate | null;
  selectionReason: string;
  optionEntry: number | null; optionStop: number | null; optionTarget: number | null;
  spread: "DATA UNAVAILABLE";   // Dhan publishes no historical bid/ask
  candidates: StrikeCandidate[];
}

export interface TradePlan {
  direction: "BULLISH" | "BEARISH";
  side: "BUY" | "SELL";             // BUY => BUY CE, SELL => BUY PE
  entry: number;                    // decision price = signal-candle close (no look-ahead)
  stopLoss: number; invalidation: number; invalidationSource: string;
  target1: number; target1Source: string;
  target2: number; target2Source: string;
  riskPoints: number; rewardPoints: number; rr: number;
  obstacles: number[];              // levels inside 1 ATR between entry and T1 (disclosed, not hidden)
  nextResistance: number[];         // nearest structural levels ABOVE entry (up to 2)
  nextSupport: number[];            // nearest structural levels BELOW entry (up to 2)
  rrWarning: string | null;         // "⚠ LOW R:R" when R:R < rrMin — information only, never blocks
  basis: number | null;             // futures - spot at decision (for spot-equivalent levels)
}

export interface DecisionRow {
  timestamp: number; iso: string; date: string;
  price: number; spot: number | null;
  atr: number | null;
  movementState: MovementState;
  movementDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  movementScore: number;            // evidence score 0-100 (not a probability)
  movementEvidence: string[];
  moveId: number | null;            // links bars of one detected movement event
  breakoutLevel: number | null; breakdownLevel: number | null;
  brokenLevel: number | null;
  noTradeZone: { low: number; high: number; source: string } | null;
  zoneInvalidated: boolean;
  plan: TradePlan | null;
  option: OptionPlan | null;
  gamma: GammaRead | null;          // trade-side read (or pressure side)
  gammaCall: GammaRead | null; gammaPut: GammaRead | null;
  oiStatus: OiFreshness; oiAgeBars: number | null;
  regime15: "BULLISH" | "BEARISH" | "RANGE" | "TRANSITION" | "NEUTRAL";   // 15M market context (last closed 15M candle)
  ctx15: import("./context15").Ctx15 | null;
  contextWarning: string | null;    // e.g. counter-trend / short-covering warning — the movement is still shown
  reversalRisk: { level: "LOW" | "MEDIUM" | "HIGH"; factors: string[] } | null;
  oiValidation: import("./oiValidation").OiValidation;
  liquidityGrade: "GOOD" | "WARNING" | "POOR" | "DATA UNAVAILABLE" | null;
  // ---- 5M direction-conflict protection + S/R rejection (added layer; audit fields) ----
  guardState: "5M_DIRECTION_CONFLICT" | "WAIT_FOR_DIRECTION_RECONFIRMATION" | "DIRECTION_RECONFIRMED" | "REGIME_CHANGE_CONFIRMED" | "SUPPORT_REJECTION" | "RESISTANCE_REJECTION" | null;
  directionConflict: boolean;
  directionConflictReason: string | null;
  previousRegime: string | null;          // 15M regime the conflict was raised against
  current5mDirection: "BULLISH" | "BEARISH" | "FLAT";   // this 5M candle's own direction (close vs open)
  reconfirmationRequired: boolean;
  reconfirmationStatus: "NONE" | "PENDING" | "DIRECTION_RECONFIRMED" | "REGIME_CHANGE_CONFIRMED" | "CONTEXT_CHANGED" | "SESSION_RESET";
  supportResistanceEvent: "SUPPORT_REJECTION" | "RESISTANCE_REJECTION" | null;
  supportResistanceLevel: number | null;
  rejectionType: string | null;           // e.g. "wick rejection at PDH" / "false breakout (existing state)"
  rejectionStatus: "NEW" | "WATCH" | "CONFIRMED" | "RECLAIMED" | "FAILED" | null;
  entryBlockedReason: string | null;
  oiStatusLabel: "SUPPORTING" | "CONFIRMED" | "CONTRADICTING" | "UNCONFIRMED" | "STALE";
  rrStatus: "GOOD" | "WARNING" | null;
  oiConfirmation: "SUPPORTS" | "CONTRADICTS" | "NEUTRAL" | "UNAVAILABLE";
  volumeState: string; momentumState: string; structureState: string;
  vwapState: string; emaState: string; liquidityState: string;
  executionState: ExecutionState;
  action: "TAKE" | "WAIT";
  blockReason: string | null;
  blockReasons: string[];
  timingClassification: DecisionTiming;
  // filled by the forward walk (OUTCOME only, never an input)
  fillPrice: number | null; outcome: Outcome; rMultiple: number | null; exitPrice: number | null; exitIso: string | null;
  finalAction: "BUY CE" | "BUY PE" | "WAIT";   // THE final signal (option-buyer view: bullish = buy CALL, bearish = buy PUT)
  // option-buyer result from REAL historical premiums of the primary strike (null = DATA UNAVAILABLE)
  optionFill: number | null;        // option open on the entry candle (same candle the index fill uses)
  optionExit: number | null;        // option close on the exit candle
  optionPnl: number | null;         // ₹ per unit = optionExit - optionFill
}

export interface MovementEvent {
  moveId: number; direction: "BULLISH" | "BEARISH";
  firstIso: string; firstState: MovementState; confirmIso: string | null;
  level: number; startPrice: number;
  endIso: string; endReason: string;
  mfeAtr: number | null; genuine: boolean;   // post-hoc: favourable travel >= genuineMoveAtr before invalidation
  candidateBars: number; readyBars: number;
  blockCounts: Record<string, number>;
  executed: boolean; tradeOutcome: Outcome | null; tradeR: number | null;
  timing: DecisionTiming;
}

export interface MissedMove {
  direction: "BULLISH" | "BEARISH"; startIso: string; endIso: string;
  startPrice: number; endPrice: number; travelAtr: number;
  detectedIso: string | null; coverage: "EARLY" | "TIMELY" | "LATE" | "MISSED";
}

export interface DecisionResult {
  rows: DecisionRow[];
  events: MovementEvent[];
  bigMoves: MissedMove[];
  trades: AuditRow[];               // closed trades (shared walker, identical accounting)
  metrics: Metrics;
  daily: DailyRow[];
  summary: DecisionSummary;
  optionData: { status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE"; note: string; barsWithChain: number };
}

export interface DecisionSummary {
  candles: number;
  movementDetections: number; breakoutDetections: number; breakdownDetections: number;
  movementStateCounts: Record<string, number>;
  executionStateCounts: Record<string, number>;
  buyCandidates: number; sellCandidates: number;
  buyReady: number; sellReady: number;
  blocks: Record<string, number>;          // candidate-bar block counts by reason group
  falseMoves: number; genuineMoves: number;
  bigMoves: number; missedMoves: number; lateDetections: number;
  closedTrades: number; wins: number; losses: number;
  winRate: number | null; winRateNote: string;
  totalR: number;
}
