// ============================================================================
// Unified Arbiter — the ONE normalized Decision per index per CLOSED candle.
// Every screen (Market Command, Option Terminal, Trade Execution) and the paper
// engine read this object; no other module may produce a trading decision.
// ============================================================================

import type { BiasShift } from "./biasShift";
export const DECISION_VERSION = "arbiter/v2";   // v2: Market Bias Shift gate
export const DECISION_TF = "5m";            // canonical decision timeframe (the evidence is 5m)
// The trader's day ends at 15:15 IST (user rule): candles starting at/after 15:15
// are ignored, no decision is made after it, and open positions are closed at it.
export const TRADING_END_MIN = 15 * 60 + 15;

export type FinalAction = "BUY_CE" | "BUY_PE" | "WAIT" | "HOLD" | "AVOID";
export type Regime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "TRANSITION" | "EXPANSION" | "REVERSAL";
export type SessionPhase = "PRE_OPEN" | "OPEN" | "MORNING" | "MIDDAY" | "LATE" | "CLOSING" | "CLOSED";
export type TimingState =
  | "NONE" | "WATCH" | "PRE_MOVE" | "ATTEMPT" | "CONFIRMING" | "CONFIRMED"
  | "ENTRY_READY" | "EXTENDED" | "FAILED" | "INVALID" | "MISSED";
export type SetupId = "S1_MOMENTUM" | "S2_BREAKOUT";

export interface SpotPlan {
  entry: number; stopLoss: number; target1: number; target2: number | null;
  risk: number; reward: number; rr: number;
  slReason: string; targetReason: string;
}

export interface SetupCandidate {
  setup: SetupId;
  label: string;                       // human name
  direction: "BULLISH" | "BEARISH";
  state: TimingState;
  triggerLevel: number | null;
  triggerLabel: string | null;
  invalidation: number | null;
  plan: SpotPlan | null;
  evidence: string[];                  // why the setup says what it says
  blockReason: string | null;          // setup-level reason it is not ENTRY_READY
  production: boolean;                 // may this setup trade today (evidence gate), see evidence.ts
}

export interface OptionLeg {
  available: boolean;
  side: "CE" | "PE";
  strike: number | null; expiry: string | null; securityId: string | null; verified: boolean;
  ltp: number | null; entry: number | null; stopLoss: number | null; target1: number | null; target2: number | null;
  risk: number | null; reward: number | null; rr: number | null;
  costPerUnit: number | null;          // round-trip friction per unit (paper engine's cost model)
  netRR: number | null;                // (reward − cost) / (risk + cost)
  delta: number | null; iv: number | null; oi: number | null; volume: number | null;
  liquidity: string | null;            // strike analyser assessment
  why: string | null;
  reason: string | null;               // why not acceptable
}

export interface EvidenceSummary {
  setup: SetupId | null;
  index: string;
  samples: number;                     // out-of-sample trades behind the number
  avgR: number | null;                 // pooled replay avg R (spot, before costs)
  shrunkR: number | null;              // shrunk toward 0: avgR × n/(n+K)
  costR: number | null;                // option friction expressed in R for THIS trade
  netEvR: number | null;               // shrunkR − costR
  passes: boolean;
  source: string;
  note: string;
}

export interface Decision {
  version: string;
  key: string;                         // index|tf|candleTime — exactly one per closed candle
  index: string; symbol: string;
  timeframe: string;
  candleTime: number | null;           // epoch sec of the CLOSED candle the decision is for
  candleIso: string | null;
  candleClosed: boolean;
  decidedAt: number;                   // epoch sec when first computed (frozen afterwards)
  dataStatus: string;                  // LIVE / DELAYED / STALE / DISCONNECTED / CLOSED / HISTORICAL
  sessionPhase: SessionPhase;
  expiryDay: boolean;
  regime: Regime | null; regimeEvidence: string[];
  volatility: { atr: number | null; atrRatio: number | null; state: string };
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  setup: SetupId | null; setupLabel: string | null; setupState: TimingState;
  trigger: { level: number | null; label: string | null; status: string };
  spot: number | null;
  plan: SpotPlan | null;
  option: OptionLeg | null;
  evidence: EvidenceSummary | null;
  invalidation: number | null;
  candidates: SetupCandidate[];        // all setups evaluated (shown as evidence)
  features: Record<string, any>;      // Early Move / OI / breakout context — evidence only, never a trigger
  bias: BiasShift | null;              // Market Bias Shift state (trader alert + entry permission)
  finalAction: FinalAction;
  reason: string;
  rejection: string | null;
  hold: { since: number; entrySpot: number; barsHeld: number; option: OptionLeg | null } | null;
  live: Record<string, any> | null;   // forming-candle context (ATTEMPT/CONFIRMING) — informational only
}
