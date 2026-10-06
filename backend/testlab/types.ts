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
  slMaxAtr: number;         // cap stop distance at this many ATR from entry (0 = no cap)
  targetAtrMult: number;    // fallback ATR target when no opposing structure
  targetMinAtr: number;     // skip S/R target levels closer than this many ATR to entry
  minHistory: number;       // min candles before any signal
  warmupCandles: number;    // prior-session candles loaded before the window (indicator warm-up only; no rows/signals)
  lateCutoffMinIST: number; // no new entries after this IST minute-of-day
  cooldownCandles: number;  // bars to wait after a trade closes
  oneOpenTrade: boolean;
  timeExitBars: number;     // force time exit after N bars
  futuresBinding: "strict" | "spot-fallback"; // strict => invalid binding blocks (spec §6)
  dataMode: SignalDataMode; // §3/§4 primary=FUTURES_INTERNAL
  rrGateMode: "ON" | "OFF"; // §11 research-only R:R gate switch
  buyThreshold: number;     // directional-evidence floor to consider BUY
  sellThreshold: number;
  ablationDisable?: string[]; // component names to disable (research)
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
  dataRange: { from: string; to: string; totalCandles: number; rejected: number; warmupCandles?: number; warmupFrom?: string | null };
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  dataQuality: GateStatus;
  rows: AuditRow[];
  trades: AuditRow[];       // rows that became OPEN trades
  chart: ChartCandle[];     // per-candle OHLC + overlays for the dashboard chart
  metrics: Metrics;
  daily: DailyRow[];
  gateBlocks: Record<string, number>;
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
