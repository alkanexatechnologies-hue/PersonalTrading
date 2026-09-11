// Shared domain types for the intraday assistant.

export interface Candle {
  time: number; // epoch seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  marketTime: number; // epoch seconds
}

export type Interval = "1m" | "5m" | "15m" | "30m" | "60m" | "1d";

export type SignalLabel = "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL";

export interface IndicatorVote {
  name: string;
  value: string; // human-readable current value
  bias: "bullish" | "bearish" | "neutral";
  weight: number; // contribution magnitude
  reason: string;
}

export interface SignalResult {
  symbol: string;
  asOf: number; // epoch seconds of last candle used
  price: number;
  dayHigh: number | null; // current session high
  dayLow: number | null; // current session low
  score: number; // -100 .. +100
  label: SignalLabel;
  confidence: number; // 0 .. 100
  votes: IndicatorVote[];
  suggestedStopLoss: number | null;
  suggestedTarget: number | null;
  atr: number | null;
  disclaimer: string;
}

export interface Trade {
  side: "LONG" | "SHORT";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnl: number; // absolute per unit
  // Same concept as PaperTrade.pnlPct (paper/engine.ts) under a different name -
  // this is the backtest engine's trade record, a separate system from paper
  // trading, not a naming bug. NET of costs (what you actually keep).
  pnlPercent: number;
  grossPnlPercent?: number; // before costs
  costPercent?: number; // round-trip cost charged to this trade (% of entry)
  exitReason: "target" | "stop" | "signal" | "eod";
}

export interface BacktestResult {
  symbol: string;
  interval: Interval;
  candles: number;
  trades: Trade[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  netPnlPercent: number; // sum of trade pnl% AFTER costs (1 unit position)
  grossPnlPercent: number; // sum of trade pnl% BEFORE costs
  totalCostPercent: number; // total round-trip costs charged across all trades (%)
  costPerTradePercent: number; // round-trip cost applied per trade (%)
  avgWinPercent: number;
  avgLossPercent: number;
  profitFactor: number; // net of costs
  maxDrawdownPercent: number;
  expectancyPercent: number; // net of costs
  equityCurve: { time: number; equity: number }[];
  params: BacktestParams;
}

export interface BacktestParams {
  stopLossPercent: number;
  targetPercent: number;
  allowShort: boolean;
  entryThreshold: number; // min |score| to enter
  // Round-trip cost as % of turnover, charged per trade (brokerage + STT + exchange
  // + GST + stamp + slippage). Defaults model a discount broker; set 0 for gross.
  roundTripCostPercent?: number;
}

export type OptionType = "CE" | "PE"; // CE = Call, PE = Put

export interface RiskWarning {
  severity: "info" | "caution" | "danger";
  title: string;
  detail: string;
}

export interface RiskRadar {
  spikeRisk: number; // 0..100 composite risk of a sharp adverse swing
  level: "Low" | "Elevated" | "High";
  atrPct: number | null; // ATR as % of price
  atrRatio: number | null; // current ATR vs its recent average
  adx: number | null; // trend strength
  premiumSwingPct: number | null; // one-ATR move as % of supplied premium
  greeksAvailable: boolean; // true only when a Greeks feed (Groww) is wired
  warnings: RiskWarning[];
  note: string;
}

export interface StrikeIdea {
  moneyness: "ITM" | "ATM" | "OTM";
  strike: number;
  note: string;
  riskLevel: "Low" | "Medium" | "High";
}

export interface HoldTimeframe {
  candles: number; // typical bars to hold
  approxMinutes: number; // candles * interval minutes
  note: string;
}

export interface TimeDecay {
  level: "Low" | "Medium" | "High";
  note: string;
}

export interface OptionSuggestion {
  symbol: string;
  name: string;
  fno: boolean;
  reason: string; // why this suggestion (or why none)
  // Present only when a directional trade is warranted and the symbol is F&O:
  optionType?: OptionType; // buy CALL for bullish, PUT for bearish
  direction?: "bullish" | "bearish";
  spot?: number;
  atmStrike?: number;
  strikes?: StrikeIdea[]; // ATM + ITM + OTM ideas
  lotSize?: number;
  suggestedLots?: number;
  quantity?: number; // lots * lotSize
  // Risk sizing inputs / outputs:
  capital?: number;
  riskPercent?: number;
  riskBudget?: number; // capital * risk%
  perLotRisk?: number; // estimated max loss per lot to the stop (delta-approx or premium-based)
  underlyingStop?: number | null;
  premium?: number | null; // optional user-supplied option LTP
  premiumStop?: number | null; // suggested stop-loss on the option premium
  premiumTarget?: number | null; // suggested target on the option premium
  estCapitalRequired?: number | null; // premium * quantity (only if premium given)
  sizingBasis: "premium" | "delta-approx" | "none";
  // Timing & risk guidance:
  holdTimeframe?: HoldTimeframe; // how long to hold the trade
  timeDecay?: TimeDecay; // theta / time-decay risk
  riskLevel?: "Low" | "Medium" | "High"; // risk of the recommended (ATM) option
  riskNote?: string; // explanation of the risk rating
  highestRiskStrike?: { strike: number; moneyness: string; note: string };
  disclaimer: string;
}

export type VolumeBarClass =
  | "Aggressive buying"
  | "Aggressive selling"
  | "Absorption"
  | "High churn";

export interface VolumeBar {
  time: number;
  volume: number;
  rvol: number; // volume / average volume
  clv: number; // close location value -1..+1
  classification: VolumeBarClass;
}

export interface VolumeAnalysis {
  symbol: string;
  asOf: number;
  currentVolume: number;
  avgVolume: number;
  rvol: number; // relative volume of the latest bar
  rvolState: "very high" | "high" | "normal" | "low";
  obvTrend: "rising" | "falling" | "flat";
  mfi: number | null;
  mfiState: "overbought" | "bullish" | "neutral" | "bearish" | "oversold";
  cmf: number | null;
  cmfState: "strong buying" | "buying" | "neutral" | "selling" | "strong selling";
  verdict: {
    bias: "Accumulation" | "Distribution" | "Neutral";
    strength: number; // 0..100
    reasons: string[];
  };
  notableBars: VolumeBar[];
  disclaimer: string;
}

export type BurstState =
  | "Squeeze"       // coiling, low volatility - big move building
  | "Fired Up"      // squeeze just released upward - scalp long
  | "Fired Down"    // squeeze just released downward - scalp short
  | "Expanding Up"  // big move underway, up
  | "Expanding Down"// big move underway, down
  | "Quiet"         // low volatility, no setup - avoid
  | "Normal";

export interface MomentumBurst {
  symbol: string;
  name?: string;
  type?: "index" | "equity";
  price: number;
  state: BurstState;
  burstScore: number; // 0..100 likelihood/strength of a big move now
  direction: "up" | "down" | "flat";
  squeezeOn: boolean; // Bollinger inside Keltner (coiling)
  atrExpansion: number; // current ATR vs recent average
  volumeSurge: number; // relative volume
  rangeExpansion: number; // last bar range vs average
  movementPct: number; // ATR as % of price
  bigMove: boolean; // true when a strong move is happening right now
  scalpNote: string;
  asOf: number;
}

export interface Fundamentals {
  marketCap: number | null;
  capCategory: "Small" | "Mid" | "Large" | "Unknown";
  sector: string | null;
  trailingPE: number | null;
  pegRatio: number | null;
  revenueGrowthPct: number | null;
  earningsGrowthPct: number | null;
  roePct: number | null;
  profitMarginPct: number | null;
  debtToEquity: number | null;
  growthScore: number; // 0..100 (fundamental growth/quality/value)
  growthNote: string;
}

export interface SwingPick {
  symbol: string;
  name: string;
  sector?: string;
  price: number;
  weekChangePct: number; // % change over ~5 trading days
  monthChangePct: number; // % change over ~20 trading days
  volSurge: number; // today's volume vs 20-day average
  rsi: number | null; // daily RSI(14)
  aboveEma20Pct: number; // % above/below the 20-day EMA
  breakout: boolean; // price broke above the prior 20-day high
  stage: "Early breakout" | "Building base" | "Extended" | "Neutral";
  earlyScore: number; // 0..100 - technical EARLY-entry score
  // Trade plan (swing, on daily data):
  entry: number; // breakout / trigger level to enter on
  stop: number; // suggested swing stop (recent swing low)
  target: number; // projected swing target (ATR-based)
  expectedMovePct: number; // projected move from price to target, %
  atrPct: number | null; // daily ATR as % of price (typical daily range)
  riskReward: number | null; // (target-entry)/(entry-stop)
  hasOptions: boolean | null; // true = F&O available (CE/PE); false = cash only; null = unknown
  fundamentals?: Fundamentals; // growth/quality/value layer
  opportunityScore: number; // blended technical + fundamental
  note: string;
}

export interface DayOpportunity {
  symbol: string;
  name: string;
  direction: "Bullish" | "Bearish";
  optionType: OptionType; // CE for bullish, PE for bearish
  confidence: number; // 0..100
  spot: number;
  strike: number; // suggested strike (ATM)
  // Underlying expected range for the day:
  spotTarget: number; // favorable-direction target (upper bound for CE, lower for PE)
  spotStop: number; // adverse stop
  spotUpper: number; // expected day high
  spotLower: number; // expected day low
  // Option premium plan:
  premium: number | null; // entry premium (ATM LTP)
  premiumTarget: number | null; // TODAY's target (intraday, ~1 ATR move)
  premiumStop: number | null; // lower bound on premium
  expectedPremiumMovePct: number; // TODAY's % premium move to target (the ">20%" metric)
  // Next-day (continuation) scenario, NET of one day's theta decay:
  nextDayTarget: number | null; // projected premium if the trend extends to next day
  nextDayTargetPct: number | null; // net % vs entry after overnight decay
  nextDayProbability: number | null; // rough odds the continuation holds (0..100)
  // Theta / time-decay risk:
  theta: number | null; // premium lost per day (absolute)
  thetaPctPerDay: number | null; // daily decay as % of premium
  dte: number | null; // days to expiry
  decayLevel: "Low" | "Moderate" | "High";
  decayNote: string;
  // Capital-preservation ranking (higher = safer, better setup):
  riskReward: number | null; // (target-entry)/(entry-stop)
  qualityScore: number; // 0..100 safety-weighted score used for the Top 10
  tradeable: boolean; // passes the safety gates (no index conflict, no decay trap)
  gateNote: string; // why it's gated out / a caution
  maxLossPct: number; // worst-case % loss to the stop (what you risk)
  lotSize: number | null; // F&O lot size (units per lot) for position sizing
  delta: number | null;
  iv: number | null;
  // Market alignment - handles "index moves opposite -> stock likely reverses".
  // The benchmark is auto-picked per stock (NIFTY or BANK NIFTY, whichever it
  // correlates with most), so bank stocks are judged against BANK NIFTY.
  strikeReason?: string; // why this strike was chosen (OI + delta + theta)
  marketRef: string | null; // which index was used ("NIFTY" / "BANK NIFTY")
  betaMarket: number | null; // stock's beta vs that benchmark (daily returns)
  corrMarket: number | null; // correlation to that benchmark (-1..1)
  marketAlignment: "Aligned" | "Conflict" | "Neutral" | "Market"; // vs the index direction
  reasons: string[];
  highProb?: boolean;
  highProbScore?: number;
  highProbNote?: string;
}

export interface DayIndexOutlook {
  symbol: string;
  name: string;
  spot: number;
  direction: "Bullish" | "Bearish" | "Neutral";
  confidence: number; // 0..100
  expectedMovePts: number; // expected day move (± points)
  expectedMovePct: number; // as % of spot
  upperBound: number; // expected day high
  lowerBound: number; // expected day low
  atmStrike: number;
  straddleImplied: number | null; // ATM CE+PE premium (market-implied move to expiry)
  pcr: number | null;
  futBuildup: string | null;
  reasons: string[];
}

export interface HourlyPick {
  date: string; // YYYY-MM-DD (IST)
  slot: string; // snapshot slot, e.g. "09:30"
  snapshotEpoch: number; // epoch seconds of the snapshot
  symbol: string;
  name: string;
  direction: "Bullish" | "Bearish";
  optionType: OptionType;
  strike: number;
  spot: number;
  spotTarget: number;
  spotStop: number;
  premium: number | null;
  premiumTarget: number | null;
  premiumStop: number | null;
  expectedPremiumMovePct: number;
  confidence: number;
  qualityScore: number;
  marketAlignment: string;
  strikeReason?: string; // why this strike was chosen
  relVolume: number; // recent volume vs average (activity)
  thetaPctPerDay: number | null;
  decayLevel: string;
  dte: number | null;
  hourlyScore: number; // composite: volume + profit% + low decay
  expiry: string | null;
  highProb?: boolean;
  // Filled in by the evening resolve step:
  result?: "WIN" | "LOSS" | "OPEN" | "NODATA";
  hitTime?: string; // IST time the target/stop was hit
  spotAfter?: number | null; // spot at resolution / EOD
}

export interface FrequentMover {
  symbol: string;
  name: string;
  sector?: string;
  price: number;
  totalDays: number; // number of daily sessions analysed
  // % of days with an absolute close-to-close move >= threshold (keys: "2","3","5").
  freqPct: Record<string, number>;
  bigMoveDays: Record<string, number>; // raw count of big-move days per threshold
  avgDailyRangePct: number; // average intraday (high-low) range as % of price
  avgAbsChangePct: number; // average absolute daily % change
  maxDayMovePct: number; // largest single-day % move in the window
  atrPct: number | null; // ATR(14) as % of price (current volatility)
  hasOptions: boolean | null; // F&O available?
}

export interface BigMovePick {
  symbol: string;
  name: string;
  sector?: string;
  price: number;
  stage: "Breaking out" | "Coiled base" | "Extended" | "Weak" | "Neutral";
  readinessScore: number; // 0..100 - how set-up it is for a big move
  // Estimated odds (grounded in history + setup) of the move within ~6 months:
  prob20: number;
  prob50: number;
  prob100: number;
  // Raw historical base rates over 6-month forward windows:
  baseRate20: number;
  baseRate50: number;
  baseRate100: number;
  // Trade plan:
  entry: number; // buy zone / breakout level
  breakoutLevel: number; // recent resistance to clear
  stop: number;
  stopPct: number;
  target20: number;
  target50: number;
  target100: number;
  // Setup diagnostics:
  contractionRatio: number; // recent range vs typical (lower = tighter base)
  volDryup: number; // recent vol vs base vol (<1 = dry-up / accumulation)
  distFrom52wHighPct: number;
  aboveEma200: boolean;
  rsi: number | null;
  atrPct: number | null;
  hasOptions: boolean | null;
  note: string;
  // Short-horizon potential (1 week / 15 days / 30 days): expected favourable move
  // % (volatility-scaled) + historical hit-rate of +20/50/100% within that window.
  horizons?: BigMoveHorizon[];
  // Breakout proximity: is the stock breaking its recent high or near it?
  lastHigh?: number;           // recent swing high it must clear (60-day)
  breakoutDistPct?: number;    // % below lastHigh (<=0 = already broken out)
  breakoutStatus?: "Broke out" | "Near breakout" | "Building" | "Away";
  moveRank?: number;           // composite ordering score (breakout + potential + readiness)
}

export interface BigMoveHorizon {
  key: "1w" | "15d" | "30d";
  days: number;               // trading days in the window
  potentialPct: number;       // expected favourable move % over the window (volatility-scaled)
  hit20: number;              // % of past windows that reached +20% within `days`
  hit50: number;
  hit100: number;
}

export interface MonthlySwingPick {
  symbol: string;
  name: string;
  sector?: string;
  price: number;
  // Target plan (high-risk swing, ~1 month horizon):
  targetPct: number; // 20..50 band
  target: number;
  stopPct: number;
  stop: number;
  riskReward: number;
  expectedMonthlyMovePct: number | null; // ATR-based expected 1-month range
  // Probability, from the stock's own history + current setup:
  probability: number; // 0..100 rough odds of hitting the 20% target in a month
  setupScore: number; // 0..100 current-setup strength
  baseRate20: number; // % of past 1-month windows that gained >= 20%
  baseRate30: number; // >= 30%
  baseRate50: number; // >= 50%
  monthChangePct: number; // last ~1-month change (extension check)
  volSurge: number;
  rsi: number | null;
  atrPct: number | null;
  aboveEma50: boolean;
  hasOptions: boolean | null;
  riskLevel: "High"; // always high-risk by design
  note: string;
}

export interface Multibagger {
  years: number; // years of history available
  multiple: number; // current price / price at start of history (e.g. 8.5 = 8.5x)
  cagrPct: number; // annualised return %
  totalReturnPct: number; // (multiple - 1) * 100
  bigMoveX: number; // largest low->high run within the history
  bigMoveFrom: string; // when the big run started (YYYY-MM)
  bigMoveTo: string; // when it peaked (YYYY-MM)
  isMultibagger: boolean; // >= 2x over the history
  tier: string; // ">10x" / "5-10x" / "3-5x" / "2-3x" / "<2x"
  note: string;
}

export interface LongTermPick {
  symbol: string;
  name: string;
  sector?: string;
  price: number;
  multibagger?: Multibagger | null; // 10-year performance (from Yahoo long history)
  ret1mPct: number; // ~1-month return
  ret3mPct: number; // ~3-month return
  ret6mPct: number; // ~6-month return
  ret12mPct: number; // ~12-month return (long-term relative strength)
  ema50: number; // 50-day EMA (~10-week)
  ema200: number; // 200-day EMA (long-term trend line)
  aboveEma200Pct: number; // % above/below the 200-DMA
  goldenCross: boolean; // 50-DMA above 200-DMA
  distFrom52wHighPct: number; // % from the 52-week high (negative = below)
  rsi: number | null; // daily RSI(14)
  stage: "Strong uptrend" | "Uptrend" | "Base" | "Downtrend";
  trendScore: number; // 0..100 long-term technical trend score
  // Positional trade plan:
  entry: number; // buy-on-dip zone (near the 50-DMA)
  stop: number; // major trend-break stop (below the 200-DMA)
  target: number; // positional target (measured move above 52w high)
  upsidePct: number; // % from price to target
  hasOptions: boolean | null; // F&O available?
  fundamentals?: Fundamentals; // growth/quality/value layer
  opportunityScore: number; // blended trend + fundamentals
  note: string;
}

export interface Opportunity {
  symbol: string;
  name: string;
  type: "index" | "equity";
  price: number;
  score: number;
  label: SignalLabel;
  confidence: number;
  strength: number; // ranking score = |score| * confidence / 100
  direction: "bullish" | "bearish" | "neutral";
  optionType: OptionType | null; // CE / PE / null(neutral)
  atmStrike: number | null;
  lotSize: number | null;
  fno: boolean;
}

export interface OiStrike {
  strike: number;
  ceOi: number;
  peOi: number;
  ceChg: number;
  peChg: number;
  // Live premium + Greeks (populated from the Groww option chain):
  ceLtp?: number | null;
  peLtp?: number | null;
  ceVol?: number | null; // traded volume (contracts) - activity, when the feed provides it
  peVol?: number | null;
  ceDelta?: number | null;
  peDelta?: number | null;
  ceIv?: number | null;
  peIv?: number | null;
  ceTheta?: number | null;
  peTheta?: number | null;
}

export interface OiAnalysis {
  symbol: string;
  nseSymbol: string;
  available: boolean; // false when NSE blocked/unavailable
  message?: string; // shown when not available
  underlying: number | null;
  expiry: string | null;
  pcr: number | null; // put/call OI ratio
  pcrState: "bullish" | "bearish" | "neutral";
  totalCeOi: number;
  totalPeOi: number;
  support: number | null; // strike with max PUT OI
  resistance: number | null; // strike with max CALL OI
  maxPain: number | null;
  ceBuildup: "long buildup" | "short buildup" | "short covering" | "long unwinding" | "mixed";
  peBuildup: "long buildup" | "short buildup" | "short covering" | "long unwinding" | "mixed";
  // Futures OI day-change (genuine-move confirmation):
  futOi?: number | null;
  futOiChangePct?: number | null;
  futBuildup?: "Long buildup" | "Short buildup" | "Short covering" | "Long unwinding" | "—" | null;
  verdict: { bias: "Bullish" | "Bearish" | "Neutral"; reasons: string[] };
  topStrikes: OiStrike[]; // strikes around ATM
  asOf: number;
  disclaimer: string;
}

export interface NextDayPick {
  symbol: string;
  name: string;
  type: "index" | "equity";
  close: number;
  changePercent: number; // today's % change
  dailyScore: number; // daily-timeframe signal score
  confidence: number;
  closingStrength: number; // where close sits in day range (0..100)
  bias: "Bullish" | "Bearish" | "Neutral";
  optionType: OptionType | null;
  outlookScore: number; // ranking value
  note: string;
}

export interface TradeAlert {
  symbol: string;
  name: string;
  type: "index" | "equity";
  price: number;
  label: SignalLabel;
  score: number;
  confidence: number;
  direction: "bullish" | "bearish";
  optionType: OptionType | null; // CALL/PUT hint for F&O names
  atmStrike: number | null;
  // Reward & success:
  targetPrice: number | null;
  stopPrice: number | null;
  potentialGainPct: number; // move to target from current price
  movementPct: number; // typical intraday movement (ATR as % of price)
  successRate: number; // backtest win rate % (historical)
  tradesTested: number;
  expectancyPct: number; // backtest expectancy per trade
  profitFactor: number;
  rankScore: number; // composite used for ordering
}
