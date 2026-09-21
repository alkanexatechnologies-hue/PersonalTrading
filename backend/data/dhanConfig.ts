import fs from "fs";
import path from "path";
import { dataFile } from "../config/dataDir";
import { dhanFetch } from "./dhanClient";

// ---- Dhan connection config (SINGLE market-data source) ----
// Dhan is the sole source for all market data: live quotes, candles, OI,
// option chains, and historical data.
//
// Auth: Dhan uses a manually-generated access token (24h validity) from
// web.dhan.co -> Access DhanHQ APIs (see dhanhq.co/docs/v2/authentication/).
// The client ID is auto-extracted from the JWT payload on save.

export interface DhanConfig {
  accessToken: string;
  clientId: string; // required by market-feed endpoints (sent as client-id header)
}

// Persisted on DATA_DIR (the mounted disk in production) so the Dhan
// configuration survives a restart/redeploy. See config/dataDir.ts.
const FILE = dataFile("dhan-config.json");

export function loadDhanConfig(): DhanConfig {
  let file: Partial<DhanConfig> = {};
  try { file = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { /* none yet */ }
  return {
    accessToken: process.env.DHAN_ACCESS_TOKEN || file.accessToken || "",
    clientId: process.env.DHAN_CLIENT_ID || file.clientId || "",
  };
}

function extractClientIdFromJwt(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return String(payload.dhanClientId || "");
  } catch { return ""; }
}

export function saveDhanConfig(patch: Partial<DhanConfig>): DhanConfig {
  const cur = loadDhanConfig();
  const newToken = patch.accessToken != null && String(patch.accessToken).trim() ? String(patch.accessToken).trim() : cur.accessToken;
  const autoClientId = newToken && newToken !== cur.accessToken ? extractClientIdFromJwt(newToken) : "";
  const next: DhanConfig = {
    accessToken: newToken,
    clientId: patch.clientId != null && String(patch.clientId).trim() ? String(patch.clientId).trim() : autoClientId || cur.clientId,
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
    const res = await dhanFetch("/fundlimit", { method: "GET", accessToken: cfg.accessToken, clientId: cfg.clientId });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Dhan ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
