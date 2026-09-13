// ============================ Section 14 — Trade confirmation ============================
// A fresh directional flip is never immediately TAKE-able. It must hold on the SAME
// side for OTP_CONFIG.confirmation.minHoldMinutes before decision.ts will consider it
// confirmed. Persisted the same way as other small per-symbol state in this app
// (backend/auth/credentials.ts, backend/auth/userStore.ts): a JSON file, temp+rename
// write, owner-only permissions.

import fs from "fs";
import path from "path";
import { OTP_CONFIG } from "./config";
import { OptionSide } from "./types";

export interface PendingSignal { direction: OptionSide; firstSeenAt: number; confirmationPremium: number | null }
export type ConfirmationStatus = "NEW" | "PENDING" | "CONFIRMED" | "NONE";

const FILE = path.join(process.cwd(), "data", "option-top-pick-confirmation.json");

function loadAll(): Record<string, PendingSignal> {
  try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return {}; }
}
function saveAll(all: Record<string, PendingSignal>): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.otp-confirm.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export interface ConfirmationResult { status: ConfirmationStatus; pending: PendingSignal | null; holdMinutes: number }

export function updateConfirmation(symbol: string, currentSide: OptionSide | null, nowEpoch: number, currentPremium: number | null): ConfirmationResult {
  const all = loadAll();
  const existing = all[symbol] ?? null;

  if (currentSide == null) {
    if (existing) { delete all[symbol]; saveAll(all); }
    return { status: "NONE", pending: null, holdMinutes: 0 };
  }

  if (!existing || existing.direction !== currentSide) {
    const fresh: PendingSignal = { direction: currentSide, firstSeenAt: nowEpoch, confirmationPremium: null };
    all[symbol] = fresh;
    saveAll(all);
    return { status: "NEW", pending: fresh, holdMinutes: 0 };
  }

  const holdMinutes = (nowEpoch - existing.firstSeenAt) / 60;
  if (holdMinutes >= OTP_CONFIG.confirmation.minHoldMinutes) {
    if (existing.confirmationPremium == null && currentPremium != null) {
      existing.confirmationPremium = currentPremium;
      all[symbol] = existing;
      saveAll(all);
    }
    return { status: "CONFIRMED", pending: existing, holdMinutes };
  }
  return { status: "PENDING", pending: existing, holdMinutes };
}

/** Test-only: clear persisted confirmation state for a symbol. */
export function clearConfirmationForTest(symbol: string): void {
  const all = loadAll();
  delete all[symbol];
  saveAll(all);
}
