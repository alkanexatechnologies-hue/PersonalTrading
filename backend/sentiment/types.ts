// ============================ 09:10 Market & Global Sentiment — shared types ============================
// This desk is MARKET CONTEXT ONLY. It never executes trades, never generates
// CE/PE orders, and never touches the Market Command trade gates. Every value it
// shows is either REAL (from a provider/engine, tagged with the provider's own
// timestamp) or explicitly DATA UNAVAILABLE — nothing here is fabricated.

/** Truthful freshness of one data block — never show STALE/UNAVAILABLE as LIVE. */
export type Freshness = "LIVE" | "DELAYED" | "STALE" | "CLOSED" | "DISCONNECTED" | "UNAVAILABLE";

/** One quoted instrument (index / macro / fx / commodity). Carries full data-
 *  integrity metadata: the value is either real (with the PROVIDER's own
 *  timestamp) or null with a reason — it is never fabricated or estimated. */
export interface Quote {
  key: string;             // stable id, e.g. "NIFTY", "DXY"
  label: string;           // display name
  value: number | null;    // last price/level
  change: number | null;   // absolute change
  changePct: number | null;// percent change
  ts: number | null;       // PROVIDER/exchange timestamp (epoch sec) — never Date.now()
  receivedTs?: number | null; // when WE received it (epoch sec) — for age, not display
  ageSec?: number | null;  // dataAgeSeconds = received − provider timestamp
  freshness: Freshness;    // status: LIVE | DELAYED | STALE | CLOSED | DISCONNECTED | UNAVAILABLE
  source: string | null;   // "DHAN" | "twelvedata" | …
  reason?: string | null;  // why UNAVAILABLE/DISCONNECTED (never contains the API key)
}

export type Direction = "UP" | "DOWN" | "NEUTRAL";
export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED";
export type Strength = "STRONG" | "MODERATE" | "WEAK";

export interface SectorRow {
  sector: string;
  direction: Direction;
  pctMove: number | null;
  advancers: number | null;
  decliners: number | null;
  weight: number | null;      // index weight %
  estImpact: number | null;   // estimated NIFTY points contribution
  strength: Strength | null;
  keyStocks: string[];
  reason: string;
  ts: number | null;
  freshness: Freshness;
}

export interface BankRow {
  stock: string;
  price: number | null;
  pctMove: number | null;
  direction: Direction;
  weight: number | null;       // NIFTY weight %
  ptsPer1pct: number | null;   // estimated NIFTY pts per 1% move
  estContribution: number | null;
  volume: number | null;
  ts: number | null;
  freshness: Freshness;
}

export interface MoverRow {
  rank: number;
  stock: string;
  price: number | null;
  changePct: number | null;
  weight: number | null;
  estImpact: number | null;
  direction: Direction;
}

export type FiiPositionType = "LONG BUILDUP" | "SHORT BUILDUP" | "LONG UNWINDING" | "SHORT COVERING" | "NEUTRAL";

export interface FiiRow {
  date: string;                // yyyy-mm-dd
  longQty: number | null;
  shortQty: number | null;
  netPos: number | null;
  dailyChange: number | null;
  netValueCr: number | null;   // ₹ Cr (when available)
  close: number | null;        // underlying close
  positionType: FiiPositionType | null;
}

export interface FiiSummary {
  available: boolean;
  currentNet: number | null;
  prevNet: number | null;
  change5d: number | null;
  change10d: number | null;
  change20d: number | null;
  behaviour: FiiPositionType | "MIXED" | null;   // "What are FIIs doing?"
  pressure: "UPWARD" | "DOWNWARD" | "NEUTRAL" | "MIXED" | null;
  bias: Bias | null;
  rows: FiiRow[];
  freshness: Freshness;
  note: string;
}

/** One index's model probability + the evidence behind it. */
export interface IndexProbability {
  index: string;
  available: boolean;
  upside: number | null;      // %
  range: number | null;       // %
  downside: number | null;    // %
  expectedLow: number | null;
  expectedHigh: number | null;
  confidence: "LOW" | "MEDIUM" | "HIGH" | null;
  bias: Bias | null;
  factors: { label: string; value: string; lean: "bull" | "bear" | "neutral" }[];
  note: string;               // "DATA INSUFFICIENT" when inputs are too thin
}

export interface OverallSentiment {
  bias: Bias;
  confidence: number | null;  // 0..100
  estNiftyMove: string | null;// e.g. "-48 to -78 pts" — only when supported
  breadthUp: number; breadthDown: number; breadthNeutral: number;
  bankingBias: Bias;
  globalBias: Bias;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  positives: string[];
  negatives: string[];
  freshness: Freshness;
}

/** The immutable per-cycle snapshot stored every 30 minutes. */
export interface SentimentSnapshot {
  ts: number;                 // epoch sec (the calc cycle time)
  slot: string;               // "09:10" … the 30-min slot label (IST)
  date: string;               // yyyy-mm-dd (IST)
  overall: Bias;
  breadthUp: number; breadthDown: number; breadthNeutral: number;
  bankingBias: Bias;
  globalBias: Bias;
  riskLevel: string | null;
  fiiContext: string | null;
  niftyProb: number | null;   // downside% (headline lean) — compact for the timeline
  bankniftyProb: number | null;
  finniftyProb: number | null;
  topPositive: string | null;
  topNegative: string | null;
}
