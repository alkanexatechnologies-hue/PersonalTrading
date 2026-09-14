import fs from "fs";
import path from "path";
import { DATA_DIR, dataFile } from "../config/dataDir";
import { getProvider, setActiveProvider } from "./index";
import { GrowwProvider } from "./growwProvider";

// GROWW IS THE ONLY MARKET-DATA SOURCE.
//  - In market hours: Groww live quotes + candles + option chain / OI.
//  - After hours / weekend: Groww HISTORICAL candles for charts/analysis; the
//    live feed reads MARKET CLOSED and NO live trading signals are generated.
// There is no Yahoo / TrueData fallback anywhere in the data path.

let growwToken = (process.env.GROWW_ACCESS_TOKEN || "").trim();

const FLAGS_FILE = dataFile("feed-flags.json");
// The Groww access token is the ONLY Groww credential. It is a live broker
// credential in plaintext on disk, so it is owner-read/write only and
// gitignored - it must never reach Git, a log line, or the frontend.
// Persisted on DATA_DIR (the mounted disk in production) so it survives a
// restart/redeploy instead of forcing a re-paste. LEGACY_TOKEN_FILE is the
// old repo-root location: still READ as a one-time fallback so an existing
// token is never lost, but new writes always go to the DATA_DIR path.
const TOKEN_FILE = dataFile(".groww_token");
const LEGACY_TOKEN_FILE = path.join(process.cwd(), ".groww_token");

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

// Clear the IN-MEMORY token only. Deliberately does not touch the saved file -
// disk state is removed explicitly via deletePersistedGrowwToken() so that
// merely resetting session state (in a test, say) can never destroy the
// admin's saved credential.
export function forgetGrowwToken() {
  growwToken = "";
}

// Remove the saved token file, so a restart doesn't silently reconnect with a
// token the admin just disconnected.
export function deletePersistedGrowwToken(): void {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }
  // Also clear the legacy repo-root copy, else readPersistedGrowwToken() would
  // re-migrate it on the next boot and silently reconnect after a disconnect.
  try { fs.unlinkSync(LEGACY_TOKEN_FILE); } catch { /* already gone */ }
}

// Persist the access token so it survives restarts (server.ts reads it on boot).
// mode 0600 is applied with an explicit chmod too, because writeFileSync's
// `mode` only applies when the file is newly created - not when an existing
// file is overwritten.
export function persistGrowwToken(token: string): void {
  const t = (token || "").trim();
  if (!t) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, t, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch { /* non-fatal: the in-memory token still works for this session */ }
}

// The token saved on disk, if any (used on boot to auto-reconnect). Reads the
// DATA_DIR path first; if empty, falls back to the legacy repo-root file and
// migrates it onto DATA_DIR so the next restart finds it in the new location.
export function readPersistedGrowwToken(): string {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    if (t) return t;
  } catch { /* not in the new location - try legacy below */ }
  try {
    const legacy = fs.readFileSync(LEGACY_TOKEN_FILE, "utf-8").trim();
    if (legacy) { persistGrowwToken(legacy); return legacy; }
  } catch { /* none anywhere */ }
  return "";
}

// Strips the access token out of any string before it reaches a response, a log
// line or the UI. Defence-in-depth: provider errors quote Groww's response body,
// never the token, but a credential must never leak through an error path.
export function scrubGrowwToken(text: string): string {
  if (!text) return text;
  let out = String(text);
  if (growwToken && growwToken.length > 6) out = out.split(growwToken).join("<redacted>");
  return out;
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
