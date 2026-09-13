import fs from "fs";
import path from "path";
import { dhanFetch } from "./dhanClient";

// ---- Dhan historical-data connection (BACKTESTING ONLY) ----
// Deliberately isolated from the live trading path: GROWW IS STILL THE ONLY
// SOURCE for OI / EMA / live signals / Master Trade Selector (see
// config/index.ts, data/sessionFeed.ts). Dhan exists here purely so the user
// can pull long-range historical candles for offline backtesting/research -
// nothing in oiGridToIdea, recommendOiTrades, tryOpenOption, or any signal/
// regime/risk engine ever reads this file or Dhan data.
//
// Auth: Dhan's simplest method is a manually-generated access token (24h
// validity) from web.dhan.co -> My Profile -> Access DhanHQ APIs (see
// dhanhq.co/docs/v2/authentication/) - pasted here, same pattern as this
// app's existing Groww "paste an existing token" fallback.

export interface DhanConfig {
  accessToken: string;
  clientId: string; // optional, for display/labeling only - not required by the historical/fund-limit endpoints
}

const FILE = path.join(process.cwd(), "data", "dhan-config.json");

export function loadDhanConfig(): DhanConfig {
  let file: Partial<DhanConfig> = {};
  try { file = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { /* none yet */ }
  return {
    accessToken: process.env.DHAN_ACCESS_TOKEN || file.accessToken || "",
    clientId: process.env.DHAN_CLIENT_ID || file.clientId || "",
  };
}

export function saveDhanConfig(patch: Partial<DhanConfig>): DhanConfig {
  const cur = loadDhanConfig();
  const next: DhanConfig = {
    accessToken: patch.accessToken != null && String(patch.accessToken).trim() ? String(patch.accessToken).trim() : cur.accessToken,
    clientId: patch.clientId != null && String(patch.clientId).trim() ? String(patch.clientId).trim() : cur.clientId,
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch { /* best-effort, matches telegram-config.json's own error handling */ }
  return next;
}

export function dhanConfigured(cfg = loadDhanConfig()): boolean {
  return !!cfg.accessToken;
}

// Explicit "Disconnect" - clears the saved token/clientId outright (unlike
// saveDhanConfig, which only ever fills in a field, never blanks one).
export function disconnectDhan(): DhanConfig {
  const next: DhanConfig = { accessToken: "", clientId: "" };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch { /* best-effort */ }
  return next;
}

// Verifies the saved access token actually works, via the smallest real call
// that needs no instrument-specific parameters (GET /v2/fundlimit - account
// balance/margin info; verified against dhanhq.co/docs/v2/funds/). We only
// check res.ok - the account details themselves are never stored or logged.
export async function testDhanConnection(): Promise<{ ok: boolean; error?: string }> {
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) return { ok: false, error: "No Dhan access token saved yet." };
  try {
    const res = await dhanFetch("/fundlimit", { method: "GET", accessToken: cfg.accessToken });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Dhan ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
