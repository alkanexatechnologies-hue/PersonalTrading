// ============================ Trading data recorder — shared record shapes ============================
// Pure data shapes only (no logic). Written by liveSnapshotRecorder.ts, read
// by backend/ml/*.ts. Every field here is either a DIRECT COPY of something
// the live system already computed, or a value from an EXISTING reusable
// indicator function (indicators/index.ts, commentary/marketCommentary.ts,
// routes/api.ts's classifyRegime) — nothing here recomputes strategy logic.

export type OptionType = "CE" | "PE";

export interface MarketSnapshotRecord {
  timestamp: number; // epoch seconds (UTC) — the OI-command payload's own `asOf`/bar time
  recordedAt: number; // epoch ms — when THIS recorder wrote the row (wall-clock, for gap/latency checks)
  symbol: string;
  spot: number | null;
  atm: number | null;
  expiry: string | null;
  marketSession: "OPEN" | "CLOSED";
  technicals: {
    ema9: number | null;
    ema21: number | null;
    ema50: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHistogram: number | null;
    vwap: number | null;
    rsi: number | null;
    bollingerUpper: number | null;
    bollingerMiddle: number | null;
    bollingerLower: number | null;
    supertrend: number | null;
    supertrendDirection: number | null; // 1 / -1 / 0 from indicators/index.ts's supertrend()
  };
  // Structure/regime are null when the underlying function can't yet compute
  // one (not enough bars) — never a guessed default.
  marketStructure: string | null; // commentary/marketCommentary.ts's detectStructure()
  regime: string | null; // routes/api.ts's classifyRegime()
}

export interface OptionChainRecord {
  timestamp: number;
  symbol: string;
  expiry: string | null;
  strike: number;
  optionType: OptionType;
  ltp: number | null;
  // Groww's live option-chain snapshot has no per-option OHLC (only current
  // LTP/OI/Greeks) — these three are ALWAYS null, per the "never invent a
  // field the provider doesn't supply" rule. Kept as explicit fields (rather
  // than omitted) so the schema documents the gap instead of hiding it.
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  openInterest: number | null;
  oiChange: number | null;
  iv: number | null;
}

export interface StrategySnapshotRecord {
  timestamp: number;
  symbol: string;
  oiBias: string | null; // buildOiCommand()'s oiVerdict (Bullish/Bearish/Neutral/TWO_SIDED)
  // NOT exposed anywhere in the live system today: there is only one combined
  // directional score (oiMoveScore / finalScore), never separate CE vs PE
  // scores. Left null rather than invented a split — see the session's
  // architecture-summary note on this.
  callScore: null;
  putScore: null;
  masterDecision: string | null; // ext.arbitration.verdict (GO/WAIT/CONFLICT), null if ext unavailable
  finalScore: number | null; // ext.finalScore — the one combined directional score that IS exposed (see callScore/putScore note above)
  regime: string | null;
  marketStructure: string | null;
  // The three *Status fields below are plain relabels of an already-computed
  // number (spot-vs-vwap, ema9-vs-ema21, macd-histogram sign) into
  // Bullish/Bearish/Neutral — the same kind of label->number mapping already
  // used elsewhere in this app (e.g. deskTf()) — NOT a new strategic signal,
  // no new threshold, no new weight.
  vwapStatus: "Bullish" | "Bearish" | "Neutral" | null;
  emaStatus: "Bullish" | "Bearish" | "Neutral" | null;
  macdStatus: "Bullish" | "Bearish" | "Neutral" | null;
}
