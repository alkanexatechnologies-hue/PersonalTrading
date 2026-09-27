import fs from "fs";
import path from "path";
import { dataFile } from "../config/dataDir";
import { GrowwProvider } from "./growwProvider";

// ---- Groww connection config (OPTION TERMINAL premium data ONLY) ----
// Dhan remains the single source for Market Command and everything else. Groww is
// used ONLY for the Option Terminal's premium candles / structure / hourly levels
// (its Trade API returns option premium candles WITH volume and has a friendlier
// rate-limit profile). Groww Trade API is a paid add-on; the access token is a JWT
// generated from the Groww API portal and expires (typically daily).
//
// Precedence: GROWW_ACCESS_TOKEN env (set by start.ps1 from .groww_token) →
// saved groww-config.json. A saved token from the UI takes effect immediately and
// survives restart.

export interface GrowwConfig {
  accessToken: string;
  apiKey?: string; // optional — stored for reference / future TOTP auto-token flow; auth uses accessToken
}

const FILE = dataFile("groww-config.json");

export function loadGrowwConfig(): GrowwConfig {
  let file: Partial<GrowwConfig> = {};
  try { file = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { /* none yet */ }
  return {
    // A UI-saved token (file) wins over the env seed so the user can update it
    // without editing .groww_token / restarting.
    accessToken: (file.accessToken && file.accessToken.trim()) || process.env.GROWW_ACCESS_TOKEN || "",
    apiKey: (file.apiKey && String(file.apiKey).trim()) || process.env.GROWW_API_KEY || "",
  };
}

export function saveGrowwConfig(patch: Partial<GrowwConfig>): GrowwConfig {
  const cur = loadGrowwConfig();
  const token = patch.accessToken != null && String(patch.accessToken).trim()
    ? String(patch.accessToken).trim()
    : cur.accessToken;
  const apiKey = patch.apiKey != null ? String(patch.apiKey).trim() : (cur.apiKey || "");
  const next: GrowwConfig = { accessToken: token, apiKey };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch { /* best-effort */ }
  return next;
}

export function disconnectGroww(): GrowwConfig {
  const next: GrowwConfig = { accessToken: "", apiKey: "" };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch { /* best-effort */ }
  return next;
}

export function growwConfigured(cfg = loadGrowwConfig()): boolean {
  return !!cfg.accessToken;
}

// Decode the JWT `exp` (seconds) so the UI can show token freshness without
// storing anything extra. Returns null if the token isn't a decodable JWT.
export function growwTokenExpiry(cfg = loadGrowwConfig()): number | null {
  try {
    const parts = cfg.accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return Number(payload.exp) || null;
  } catch { return null; }
}

// A GrowwProvider bound to the configured token — used ONLY by the Option
// Terminal premium endpoints. Returns null when no token is configured (callers
// then fall back to the Dhan path).
export function growwProviderForOptionTerminal(): GrowwProvider | null {
  const cfg = loadGrowwConfig();
  if (!cfg.accessToken) return null;
  return new GrowwProvider(cfg.accessToken);
}
