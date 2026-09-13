// ============================ Entry / Target / Stop / R:R ============================
import { OTP_CONFIG } from "./config";
import { LevelsResult } from "./types";

export function computeLevels(entryPremium: number): LevelsResult {
  const { target1Pct, target2Pct, stopPct } = OTP_CONFIG.premium;
  const stop = round2(entryPremium * (1 + stopPct));
  const target1 = round2(entryPremium * (1 + target1Pct));
  const risk = entryPremium - stop;
  const reward = target1 - entryPremium;
  return {
    entry: round2(entryPremium),
    target1,
    target2: round2(entryPremium * (1 + target2Pct)),
    stop,
    riskReward: risk > 0 ? Math.round((reward / risk) * 10) / 10 : null,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
