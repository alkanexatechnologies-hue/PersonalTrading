// ============================ Connection status tracker ============================
// Tiny in-memory record of "when did each external provider last succeed /
// last get tested" for the Admin Connections panel. Never stores a
// credential, token, or secret - only timestamps and a boolean outcome.

export type ProviderName = "groww" | "dhan" | "telegram";

interface ProviderStatus {
  lastConnectedAt: number | null; // last time a real, successful connection/action happened
  lastTestedAt: number | null;
  lastTestOk: boolean | null;
}

const state: Record<ProviderName, ProviderStatus> = {
  groww: { lastConnectedAt: null, lastTestedAt: null, lastTestOk: null },
  dhan: { lastConnectedAt: null, lastTestedAt: null, lastTestOk: null },
  telegram: { lastConnectedAt: null, lastTestedAt: null, lastTestOk: null },
};

export function recordConnectionTest(provider: ProviderName, ok: boolean): void {
  state[provider].lastTestedAt = Date.now();
  state[provider].lastTestOk = ok;
  if (ok) state[provider].lastConnectedAt = Date.now();
}

export function recordConnectionSuccess(provider: ProviderName): void {
  state[provider].lastConnectedAt = Date.now();
}

export function getConnectionStatus(provider: ProviderName): ProviderStatus {
  return { ...state[provider] };
}
