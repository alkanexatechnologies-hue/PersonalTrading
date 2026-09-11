import fs from "fs";
import path from "path";
import { getProvider, setActiveProvider } from "./index";
import { GrowwProvider } from "./growwProvider";

// GROWW IS THE ONLY MARKET-DATA SOURCE.
//  - In market hours: Groww live quotes + candles + option chain / OI.
//  - After hours / weekend: Groww HISTORICAL candles for charts/analysis; the
//    live feed reads MARKET CLOSED and NO live trading signals are generated.
// There is no Yahoo / TrueData fallback anywhere in the data path.

let growwToken = (process.env.GROWW_ACCESS_TOKEN || "").trim();

const FLAGS_FILE = path.join(process.cwd(), "data", "feed-flags.json");

export interface FeedFlags {
  groww: boolean;
}

let flags: FeedFlags = { groww: true };
try {
  const raw = JSON.parse(fs.readFileSync(FLAGS_FILE, "utf-8"));
  flags = { groww: raw.groww !== false };
} catch { /* defaults */ }

function persistFlags() {
  try {
    fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true });
    fs.writeFileSync(FLAGS_FILE, JSON.stringify(flags));
  } catch { /* ignore */ }
}

export function getFeedFlags(): FeedFlags {
  return { ...flags };
}

export function rememberGrowwToken(token?: string) {
  if (token && token.trim()) growwToken = token.trim();
}

// Clear the in-memory token (used by "Remove saved token" so the next Generate mints fresh).
export function forgetGrowwToken() {
  growwToken = "";
}

export function getGrowwToken(): string {
  return growwToken;
}

export function hasGrowwToken(): boolean {
  return growwToken.length > 10;
}

// Masked token for the UI — never expose the full token (only the last 4 chars).
export function getGrowwTokenMasked(): string {
  if (!growwToken) return "";
  const last4 = growwToken.slice(-4);
  return "••••••••••••" + last4;
}

export function isMarketOpenIST(d = new Date()): boolean {
  const ist = new Date(d.getTime() + 19800000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930;
}

export type FeedSync = {
  provider: string;      // always "groww"
  marketOpen: boolean;
  reason: string;
  growwOn: boolean;      // Groww flag ON *and* a token is present
  configured: boolean;   // a Groww token exists
  skipLive: boolean;     // true = no live source (Groww off / no token)
};

export function setFeedFlags(next: Partial<FeedFlags>): FeedSync {
  if (next.groww != null) flags.groww = !!next.groww;
  persistFlags();
  return syncSessionProvider();
}

export function growwProviderForOi(): GrowwProvider | null {
  if (!hasGrowwToken() || !flags.groww) return null;
  return new GrowwProvider(growwToken);
}

// Resolve the active provider — Groww only. `skipLive` is true only when Groww is
// off or has no token (then callers fall back to last cache, never to another
// provider). After hours Groww HISTORICAL still works, so skipLive stays false.
export function syncSessionProvider(): FeedSync {
  const marketOpen = isMarketOpenIST();
  const configured = hasGrowwToken();
  const growwOn = flags.groww && configured;
  const skipLive = !growwOn;

  try {
    if (growwOn && getProvider().name !== "groww") setActiveProvider("groww", growwToken);
  } catch { /* keep last */ }

  let reason: string;
  if (!flags.groww) reason = "Groww feed OFF — last cached bars only";
  else if (!configured) reason = "GROWW NOT CONFIGURED — add a token to connect";
  else if (marketOpen) reason = "Groww LIVE (market hours)";
  else reason = "MARKET CLOSED — Groww historical only (no live signals)";

  return { provider: "groww", marketOpen, reason, growwOn, configured, skipLive };
}
