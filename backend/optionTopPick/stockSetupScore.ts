// ============================ Part 4B — Stock Setup (regular trade) ============================
// Pure technical read, no OI/liquidity confirmation required by definition. Built
// entirely from computeSignal() (EMA9/21, VWAP, MACD, RSI, Bollinger, Supertrend —
// already computed elsewhere in this app) plus this module's own EMA9/21/50
// structure check and room-to-wall — no indicator math is reimplemented here.

import { SignalResult } from "../types";
import { Direction, GateCheck, GateResult, RoomResult, StructureFacts } from "./types";

export interface StockSetupEval {
  direction: Direction | null;
  gates: GateResult;
  stockDirectionFrac: number;
  stockSetupFrac: number;
  momentumFrac: number;
}

export function evaluateStockSetup(structure: StructureFacts, signal: SignalResult | null, room: RoomResult): StockSetupEval {
  // Part 4B: Price > VWAP AND EMA9 > EMA21 > EMA50 AND bullish structure AND room
  // (bearish mirrored) — a strict AND, not a weighted blend, is what makes this
  // "regular" track meaningfully different from a scored/graded one.
  let direction: Direction | null = null;
  if (structure.emaStructure === "Strong Bullish" && structure.vwapStatus.startsWith("Above")) direction = "Bullish";
  else if (structure.emaStructure === "Strong Bearish" && structure.vwapStatus.startsWith("Below")) direction = "Bearish";

  const checks: GateCheck[] = [];
  checks.push({ name: "EMA 9/21/50 structure aligned", pass: structure.emaStructure !== "Mixed", detail: `EMA structure: ${structure.emaStructure}` });
  checks.push({
    name: "VWAP agrees with EMA direction",
    pass: direction != null,
    detail: direction != null ? `${structure.vwapStatus} agrees with ${structure.emaStructure}` : `VWAP (${structure.vwapStatus}) and EMA (${structure.emaStructure}) do not confirm the same side`,
  });
  const momentumAgrees = !signal || direction == null || (direction === "Bullish" ? signal.score >= -10 : signal.score <= 10);
  checks.push({ name: "Momentum not contradicting", pass: momentumAgrees, detail: signal ? `signal score ${signal.score}` : "signal unavailable" });
  checks.push({ name: "Sufficient room to opposing level", pass: room.ok, detail: room.wallStrike != null ? `distance ${room.distancePts} pts, need >= ${room.minRequiredPts}` : "opposing level unknown" });

  const failedNames = checks.filter((c) => !c.pass).map((c) => c.name);
  const gates: GateResult = { allPass: failedNames.length === 0, checks, failedNames };

  const momentumFrac = signal ? Math.max(0, Math.min(1, Math.abs(signal.score) / 100)) : 0.3;
  return {
    direction,
    gates,
    stockDirectionFrac: direction != null ? 1 : 0,
    stockSetupFrac: structure.emaStructure === "Mixed" ? 0.3 : 1,
    momentumFrac,
  };
}
