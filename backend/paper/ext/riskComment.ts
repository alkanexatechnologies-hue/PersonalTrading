// ---- Step 8: riskComment.ts ----
// The capital-guard MATH is unchanged (6% portfolio heat, −3% daily realised-loss
// halt, −10% drawdown kill switch, +15% book-and-stop). This object COMPUTES all
// four numbers and attaches them to every emitted trade for visibility.
//
// ENFORCEMENT POLICY (reviewed + confirmed — do NOT re-flag as a gap):
//   • Portfolio HEAT (6%) is ADVISORY on the extension path — it flexes with the
//     user's per-trade judgment (this is the guard the "advisory" instruction was
//     written for). It is surfaced here, not hard-blocked.
//   • The −3% daily-loss halt and the −10% drawdown kill switch are HARD BACKSTOPS,
//     kept as circuit breakers in the engine (tickPaper / bookIfMaxDrawdown). Their
//     job is to stop the system once the day's judgment has already failed, so they
//     are intentionally NOT advisory. riskComment only DISPLAYS their state; it does
//     not weaken them.
//
// `suggestedSize` is still computed from the real guard math — it is the size the
// old hard-guard logic WOULD have allowed (0 when a guard would have blocked),
// surfaced as a recommendation rather than being silently discarded.

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${round2(n * 100)}%`;

export interface RiskCommentInputs {
  // heat
  openRisk: number;
  tradeRisk: number;
  heatCapAbs: number;      // HEAT_CAP_PCT * totalStart
  // daily realised
  dailyRealised: number;
  dailyLossCapAbs: number; // DAILY_LOSS_CAP_PCT * totalStart  (a positive magnitude)
  startTotal: number;      // combined starting capital across pools
  // drawdown
  equityNow: number;
  peakEquity: number;
  drawdownKillPct: number; // e.g. 0.10
  // suggested size (what the OLD hard guards would have sized this at)
  suggestedLots: number;
  suggestedQty: number;
  premium: number;
}

export interface RiskComment {
  currentHeat: string;         // "<x>% of 6% cap"
  headroomToHeatCap: string;   // "<x>%"
  dailyPnL: string;            // "<x>% (halt threshold -3%)"
  drawdownFromPeak: string;    // "<x>% (kill switch -10%)"
  suggestedSize: string;       // human-readable size the old guards would allow
  // machine-readable mirror (handy for the UI / CSV):
  wouldBlock: boolean;         // true if any old hard guard would have blocked
  blockReasons: string[];
}

export function buildRiskComment(inp: RiskCommentInputs): RiskComment {
  const blockReasons: string[] = [];

  // Heat: current open risk (incl. this trade) vs the 6% cap.
  const projectedRisk = inp.openRisk + inp.tradeRisk;
  const heatFrac = inp.heatCapAbs > 0 ? projectedRisk / inp.heatCapAbs : 0;
  const headroomFrac = inp.heatCapAbs > 0 ? Math.max(0, (inp.heatCapAbs - projectedRisk) / inp.heatCapAbs) : 0;
  if (projectedRisk > inp.heatCapAbs) blockReasons.push("heat cap (6%) breached");

  // Daily realised P&L as a % of starting capital vs the −3% halt.
  const dailyPnlFrac = inp.startTotal > 0 ? inp.dailyRealised / inp.startTotal : 0;
  if (inp.dailyRealised <= -Math.abs(inp.dailyLossCapAbs)) blockReasons.push("daily loss cap (-3%) hit");

  // Drawdown from peak vs the −10% kill switch.
  const ddFrac = inp.peakEquity > 0 ? (inp.equityNow - inp.peakEquity) / inp.peakEquity : 0; // negative
  if (-ddFrac >= inp.drawdownKillPct) blockReasons.push(`drawdown kill (-${Math.round(inp.drawdownKillPct * 100)}%) hit`);

  const wouldBlock = blockReasons.length > 0;
  // Old hard-guard size: what the guards would allow. If a guard would block, the
  // old logic sized 0; otherwise it's the risk-based lots we computed.
  const allowLots = wouldBlock ? 0 : inp.suggestedLots;
  const allowQty = wouldBlock ? 0 : inp.suggestedQty;
  const suggestedSize = wouldBlock
    ? `0 (old guards would block: ${blockReasons.join(", ")})`
    : `${allowLots} lot(s) / ${allowQty} qty @ ₹${round2(inp.premium)}`;

  return {
    currentHeat: `${pct(heatFrac)} of 6% cap`,
    headroomToHeatCap: pct(headroomFrac),
    dailyPnL: `${pct(dailyPnlFrac)} (halt threshold -3%)`,
    drawdownFromPeak: `${pct(ddFrac)} (kill switch -${Math.round(inp.drawdownKillPct * 100)}%)`,
    suggestedSize,
    wouldBlock,
    blockReasons,
  };
}
