import fs from "fs";
import path from "path";
import { DATA_DIR, dataFile } from "../config/dataDir";
import { getProvider, setActiveProvider } from "./index";
import { DhanProvider } from "./dhanProvider";
import { loadDhanConfig, dhanConfigured } from "./dhanConfig";

// DHAN IS THE ONLY MARKET-DATA SOURCE.
//  - In market hours: Dhan live quotes + candles + option chain / OI.
//  - After hours / weekend: Dhan HISTORICAL candles for charts/analysis; the
//    live feed reads MARKET CLOSED and NO live trading signals are generated.

const FLAGS_FILE = dataFile("feed-flags.json");

export interface FeedFlags {
  dhan: boolean;
}

let flags: FeedFlags = { dhan: true };
try {
  const raw = JSON.parse(fs.readFileSync(FLAGS_FILE, "utf-8"));
  // Migrate from old groww flag if present
  flags = { dhan: raw.dhan !== false && raw.groww !== false };
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

export function isMarketOpenIST(d = new Date()): boolean {
  const ist = new Date(d.getTime() + 19800000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930;
}

export type FeedSync = {
  provider: string;      // always "dhan"
  marketOpen: boolean;
  reason: string;
  dhanOn: boolean;       // Dhan flag ON *and* configured
  configured: boolean;   // a Dhan access token exists
  skipLive: boolean;     // true = no live source
  // Legacy compat fields (some UI code may still read these)
  growwOn: boolean;
  growwToken?: string;
};

export function setFeedFlags(next: Partial<FeedFlags>): FeedSync {
  if (next.dhan != null) flags.dhan = !!next.dhan;
  persistFlags();
  return syncSessionProvider();
}

export function dhanProviderForOi(): DhanProvider | null {
  if (!dhanConfigured() || !flags.dhan) return null;
  return new DhanProvider();
}

export function syncSessionProvider(): FeedSync {
  const marketOpen = isMarketOpenIST();
  const configured = dhanConfigured();
  const dhanOn = flags.dhan && configured;
  const skipLive = !dhanOn;

  try {
    if (dhanOn) setActiveProvider("dhan");
  } catch { /* keep last */ }

  let reason: string;
  if (!flags.dhan) reason = "Dhan feed OFF — last cached bars only";
  else if (!configured) reason = "DHAN NOT CONFIGURED — add a token to connect";
  else if (marketOpen) reason = "Dhan LIVE (market hours)";
  else reason = "MARKET CLOSED — Dhan historical only (no live signals)";

  return { provider: "dhan", marketOpen, reason, dhanOn, configured, skipLive, growwOn: dhanOn };
}

// ---- Legacy compatibility shims ----
// Legacy shims: delegate to Dhan config, with an in-memory fallback
// so tests that call rememberGrowwToken(secret) still work.
let _legacyTokenOverride: string | null = null;
let _legacyOverrideActive = false;

function activeToken(): string {
  if (_legacyOverrideActive) return _legacyTokenOverride || "";
  return loadDhanConfig().accessToken;
}

export function hasGrowwToken(): boolean {
  return !!activeToken();
}

export function getGrowwToken(): string {
  return activeToken();
}

export function getGrowwTokenMasked(): string {
  const token = activeToken();
  if (!token) return "";
  return "••••••••••••" + token.slice(-4);
}

export function rememberGrowwToken(token?: string) {
  _legacyTokenOverride = token || null;
  _legacyOverrideActive = true;
}

export function forgetGrowwToken() {
  _legacyTokenOverride = null;
}

export function deletePersistedGrowwToken(): void {
  _legacyTokenOverride = null;
}

export function readPersistedGrowwToken(): string {
  return activeToken();
}

export function scrubGrowwToken(text: string): string {
  if (!text) return text;
  const token = activeToken();
  if (token && token.length > 6) return text.split(token).join("<redacted>");
  return text;
}

export function growwProviderForOi(): DhanProvider | null {
  return dhanProviderForOi();
}
