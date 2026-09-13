// ============================ Sections 17-19 — Global sequencing guards ============================
// One-trade-globally and the post-SL cooldown both reuse the REAL paper-trading
// engine's state (backend/paper/engine.ts) rather than a second, parallel notion of
// "a trade is open" — see OptionTopPickDeps.getPaperState() in types.ts, sourced
// from getPaperSummary(). The time filter is this module's own, per its own spec.

import { stopOutCooldownCheck } from "../paper/engine";
import { istMinuteOfDay } from "../util/istTime";
import { OTP_CONFIG } from "./config";

export function checkTimeFilter(nowEpochSec: number): { blocked: boolean; reason: string | null } {
  const minute = istMinuteOfDay(nowEpochSec);
  if (minute >= OTP_CONFIG.timeFilter.newBuyCutoffMinuteIST) {
    return { blocked: true, reason: "New option buying blocked after 2:30 PM." };
  }
  return { blocked: false, reason: null };
}

export function checkOneTradeGlobal(openOptionSymbols: string[]): { blocked: boolean; reason: string | null } {
  if (openOptionSymbols.length > 0) {
    return { blocked: true, reason: `HOLD EXISTING TRADE — an option position is already open (${openOptionSymbols[0]}). Only one open trade at a time.` };
  }
  return { blocked: false, reason: null };
}

export function checkCooldown(stopOutCooldown: Record<string, number>, symbol: string, nowEpochSec: number): { blocked: boolean; remainMin: number } {
  return stopOutCooldownCheck(stopOutCooldown, symbol, nowEpochSec);
}
