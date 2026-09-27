// ============================================================================
//  Dhan connection / token lifecycle — SINGLE SOURCE OF TRUTH
// ----------------------------------------------------------------------------
//  The whole app (Market Command, OI Command, Option Terminal, Charts,
//  Dashboard, Admin Connections) must read ONE authoritative Dhan health state
//  instead of each screen re-deciding "is Dhan connected?" from token presence.
//
//  The rule this module enforces: token PRESENCE is NOT "connected". We only
//  report DHAN_LIVE after (a) the token is present and not locally expired, and
//  (b) an actual market-data response was received recently. A valid token with
//  no fresh data is CONNECTING / DATA_STALE / MARKET_CLOSED — never a green LIVE.
//
//  DESIGN: this module is intentionally low-level and self-contained. It imports
//  ONLY dhanConfig (for the stored token) so it can be imported by dhanProvider
//  without creating an import cycle. It does not read feed-flags / market hours
//  itself; the composing layer (routes/api.ts) passes those in via getDhanHealth().
//  This keeps the state machine pure and unit-testable.
// ============================================================================

import { loadDhanConfig } from "./dhanConfig";

// ---- Canonical lifecycle states (§1) ---------------------------------------
export type DhanState =
  | "DHAN_LIVE"
  | "DHAN_TOKEN_EXPIRING"
  | "DHAN_TOKEN_EXPIRED"
  | "DHAN_AUTH_FAILED"
  | "DHAN_FEED_DISABLED"
  | "DHAN_RATE_LIMITED"
  | "DHAN_MARKET_CLOSED"
  | "DHAN_DATA_STALE"
  | "DHAN_CONNECTING"
  | "DHAN_DISCONNECTED";

export type DhanAuthStatus = "VALID" | "EXPIRING" | "EXPIRED" | "AUTH_FAILED" | "NO_TOKEN" | "UNKNOWN";
export type DhanFeedStatus = "LIVE" | "CONNECTING" | "STALE" | "RATE_LIMITED" | "DISABLED" | "DISCONNECTED";
export type DhanMarketStatus = "OPEN" | "CLOSED";
export type DhanFreshness = "LIVE" | "FRESH" | "STALE" | "LAST_GOOD" | "NONE";

// Error codes we classify Dhan/network failures into (§13). Kept in sync with
// growwAuth.ts's GrowwFailureCode vocabulary, but this module classifies from a
// raw message locally so it never has to import the provider (cycle-free).
export type DhanErrorCode =
  | "TOKEN_EXPIRED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "API_UNAVAILABLE"
  | "STREAM_DISCONNECTED"
  | "UNEXPECTED";

// ---- Thresholds ------------------------------------------------------------
// Warn this long before the JWT exp (§2). Dhan tokens are ~24h; 30 min gives a
// comfortable heads-up without nagging for most of the session.
export const TOKEN_EXPIRING_WINDOW_MS = 30 * 60_000;
// During market hours, no successful data within this window ⇒ DATA_STALE (§4).
// Live quote cadence is ~3s and OI ~90s; 45s catches a real stall without
// flapping on a single slow poll.
export const DATA_STALE_MS = 45_000;
// A data point fresher than this is shown as "LIVE" (roughly ~2× the 3s quote
// cadence); up to DATA_STALE_MS it is "FRESH"; beyond that "STALE".
export const FRESHNESS_LIVE_MS = 8_000;
// A rate-limit error keeps us in RATE_LIMITED for at least this long so the UI
// doesn't bounce back to green between the limiter's spaced retries.
const RATE_LIMIT_STICKY_MS = 20_000;
// An auth failure/error is considered "current" for this long after it fired.
const ERROR_STICKY_MS = 15_000;

// ---- Mutable telemetry (process-lifetime) ----------------------------------
let lastSuccessfulAuthAt = 0;
let lastSuccessfulDataAt = 0;
let lastSuccessfulQuoteAt = 0;
let lastSuccessfulCandleAt = 0;
let lastWebSocketMessageAt = 0; // reserved for the streaming feed (§4, §8)
let lastResponseAt = 0;
let lastError: { code: DhanErrorCode; message: string; at: number } | null = null;
let connecting = false;
let firstLiveConfirmed = false;
let reconnectAttempt = 0;

// ---- Recorders (called from the data path & lifecycle) ---------------------

/** A successful market-data response proves the token authenticated AND that
 *  fresh data arrived. Clears any sticky error and confirms first-live. */
export function recordDhanDataSuccess(kind: "quote" | "candle" | "chain" | "vix" | "other" = "other"): void {
  const now = Date.now();
  lastResponseAt = now;
  lastSuccessfulDataAt = now;
  lastSuccessfulAuthAt = now;
  if (kind === "quote") lastSuccessfulQuoteAt = now;
  else if (kind === "candle") lastSuccessfulCandleAt = now;
  firstLiveConfirmed = true;
  connecting = false;
  reconnectAttempt = 0;
  lastError = null;
}

/** A token validation (auth-only) succeeded — proves the token is good even if
 *  we haven't consumed a data payload yet. */
export function recordDhanAuthSuccess(): void {
  const now = Date.now();
  lastSuccessfulAuthAt = now;
  lastResponseAt = now;
  lastError = null;
}

/** Record a failure. Message is classified locally into a DhanErrorCode. */
export function recordDhanError(message: string): DhanErrorCode {
  const code = classifyDhanError(message);
  lastResponseAt = Date.now();
  lastError = { code, message: (message || "").slice(0, 200), at: Date.now() };
  return code;
}

/** Record a failure with an already-known code (e.g. mapped from the token
 *  validator's GrowwFailureCode) so classification stays precise even when the
 *  raw message wouldn't self-classify (403 auth failures, etc.). */
export function noteDhanErrorCode(code: DhanErrorCode, message = ""): void {
  lastResponseAt = Date.now();
  lastError = { code, message: (message || "").slice(0, 200), at: Date.now() };
}

export function setDhanConnecting(on: boolean): void {
  connecting = on;
  if (on) firstLiveConfirmed = false;
}

export function recordDhanReconnectAttempt(): number {
  reconnectAttempt += 1;
  return reconnectAttempt;
}

export function recordWebSocketMessage(): void {
  lastWebSocketMessageAt = Date.now();
  recordDhanDataSuccess("other");
}

/** Full reset — used on explicit disconnect / forget-token. */
export function resetDhanHealth(): void {
  lastSuccessfulAuthAt = 0;
  lastSuccessfulDataAt = 0;
  lastSuccessfulQuoteAt = 0;
  lastSuccessfulCandleAt = 0;
  lastWebSocketMessageAt = 0;
  lastResponseAt = 0;
  lastError = null;
  connecting = false;
  firstLiveConfirmed = false;
  reconnectAttempt = 0;
}

// ---- Error classification (§13) --------------------------------------------
export function classifyDhanError(message: unknown): DhanErrorCode {
  const raw = String((message as any) || "");
  if (/DH-901|invalid.?authentication|token.*(expired|invalid)|expired.*token/i.test(raw)) return "TOKEN_EXPIRED";
  if (/\b401\b|unauthor/i.test(raw)) return "TOKEN_EXPIRED";
  if (/\b403\b|forbidden/i.test(raw)) return "AUTH_FAILED";
  if (/DH-904|\b429\b|rate.?limit|too many/i.test(raw)) return "RATE_LIMITED";
  if (/websocket|stream.*(closed|disconnect)|ws.*close/i.test(raw)) return "STREAM_DISCONNECTED";
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timeout|timed out|abort/i.test(raw)) return "NETWORK_ERROR";
  if (/\b5\d\d\b|unavailable|bad gateway|server error/i.test(raw)) return "API_UNAVAILABLE";
  return "UNEXPECTED";
}

// ---- JWT expiry decode (§2) ------------------------------------------------
export interface DhanTokenMeta {
  present: boolean;
  clientId: string | null;
  /** Epoch ms of `exp`, or null when the token has no/undecodable exp. */
  expiresAt: number | null;
  /** Epoch ms of `iat`. */
  issuedAt: number | null;
  /** ms until expiry (negative when already expired), null when unknown. */
  timeUntilExpiryMs: number | null;
  /** ms since issued, null when unknown. */
  tokenAgeMs: number | null;
  /** True only when we could decode an exp AND it is in the past. */
  expired: boolean;
  /** True when valid but within the expiring window. */
  expiringSoon: boolean;
}

/** Decode the Dhan JWT locally to read exp/iat. NEVER logs or returns the token
 *  itself — only the non-secret claim timestamps + clientId. */
export function decodeDhanToken(token?: string, now = Date.now()): DhanTokenMeta {
  const t = token ?? loadDhanConfig().accessToken;
  const empty: DhanTokenMeta = {
    present: false, clientId: null, expiresAt: null, issuedAt: null,
    timeUntilExpiryMs: null, tokenAgeMs: null, expired: false, expiringSoon: false,
  };
  if (!t) return empty;
  try {
    const parts = t.split(".");
    if (parts.length !== 3) return { ...empty, present: true };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    const expSec = Number(payload.exp);
    const iatSec = Number(payload.iat);
    const expiresAt = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : null;
    const issuedAt = Number.isFinite(iatSec) && iatSec > 0 ? iatSec * 1000 : null;
    const timeUntilExpiryMs = expiresAt != null ? expiresAt - now : null;
    const tokenAgeMs = issuedAt != null ? now - issuedAt : null;
    const expired = timeUntilExpiryMs != null ? timeUntilExpiryMs <= 0 : false;
    const expiringSoon = timeUntilExpiryMs != null ? timeUntilExpiryMs > 0 && timeUntilExpiryMs <= TOKEN_EXPIRING_WINDOW_MS : false;
    return {
      present: true,
      clientId: payload.dhanClientId ? String(payload.dhanClientId) : null,
      expiresAt, issuedAt, timeUntilExpiryMs, tokenAgeMs, expired, expiringSoon,
    };
  } catch {
    return { ...empty, present: true };
  }
}

// ---- Data freshness classifier (§6) ----------------------------------------
/** Classify a single data point's freshness from its age and the session.
 *  - marketOpen + very recent  ⇒ LIVE
 *  - marketOpen + recent        ⇒ FRESH
 *  - marketOpen + old           ⇒ STALE
 *  - market closed + has value  ⇒ LAST_GOOD (never "stale" just because ticks
 *    stopped after the bell, §7)
 *  - servedFromCache flag forces LAST_GOOD regardless. */
export function classifyFreshness(opts: {
  ageMs: number | null;
  marketOpen: boolean;
  servedFromCache?: boolean;
  hasValue: boolean;
}): DhanFreshness {
  const { ageMs, marketOpen, servedFromCache, hasValue } = opts;
  if (!hasValue || ageMs == null) return "NONE";
  if (!marketOpen) return "LAST_GOOD";
  if (servedFromCache) return "LAST_GOOD";
  if (ageMs <= FRESHNESS_LIVE_MS) return "LIVE";
  if (ageMs <= DATA_STALE_MS) return "FRESH";
  return "STALE";
}

// ---- The authoritative health object (§12, §16) ----------------------------
export interface DhanHealthInputs {
  /** dhanConfigured() — a token exists. */
  configured: boolean;
  /** feed flag ON (flags.dhan) — the operator hasn't turned the feed off. */
  feedEnabled: boolean;
  /** syncSessionProvider().skipLive. */
  skipLive: boolean;
  /** market session open right now. */
  marketOpen: boolean;
}

export interface DhanUiStatus {
  level: "green" | "yellow" | "orange" | "red" | "blue" | "grey";
  label: string;
  detail: string;
  /** Suggested action label for the UI, or null when none is needed. */
  action: string | null;
}

export interface DhanHealth {
  provider: "DHAN";
  state: DhanState;
  authStatus: DhanAuthStatus;
  feedStatus: DhanFeedStatus;
  marketStatus: DhanMarketStatus;
  freshness: DhanFreshness;
  tokenPresent: boolean;
  clientId: string | null;
  tokenExpiresAt: number | null;
  tokenIssuedAt: number | null;
  tokenAgeMs: number | null;
  timeUntilExpiryMs: number | null;
  tokenExpiringSoon: boolean;
  lastSuccessfulAuthAt: number | null;
  lastSuccessfulDataAt: number | null;
  lastSuccessfulQuoteAt: number | null;
  lastSuccessfulCandleAt: number | null;
  lastWebSocketMessageAt: number | null;
  lastResponseAt: number | null;
  dataAgeMs: number | null;
  lastError: { code: DhanErrorCode; message: string; at: number } | null;
  errorCode: DhanErrorCode | null;
  reconnectAttempt: number;
  signalsBlocked: boolean;
  ui: DhanUiStatus;
}

/** Derive the one true Dhan health state from telemetry + the passed-in feed /
 *  market context. Pure w.r.t. its inputs (only reads module telemetry + token).*/
export function getDhanHealth(inputs: DhanHealthInputs, now = Date.now()): DhanHealth {
  const { configured, feedEnabled, skipLive, marketOpen } = inputs;
  const tok = decodeDhanToken(undefined, now);
  const dataAgeMs = lastSuccessfulDataAt ? now - lastSuccessfulDataAt : null;
  const errorCurrent = !!lastError && now - lastError.at <= ERROR_STICKY_MS;
  const rateLimitedNow = errorCurrent && lastError!.code === "RATE_LIMITED" && now - lastError!.at <= RATE_LIMIT_STICKY_MS;

  // ---- Decide the canonical state. Order = severity precedence. ----
  let state: DhanState;

  if (!tok.present || !configured) {
    // No usable token at all.
    state = "DHAN_DISCONNECTED";
  } else if (tok.expired) {
    // Local JWT clock says it's past exp — don't even try (§2, §3).
    state = "DHAN_TOKEN_EXPIRED";
  } else if (errorCurrent && lastError!.code === "TOKEN_EXPIRED") {
    // Dhan told us 401/DH-901 (§13).
    state = "DHAN_TOKEN_EXPIRED";
  } else if (errorCurrent && lastError!.code === "AUTH_FAILED") {
    state = "DHAN_AUTH_FAILED";
  } else if (rateLimitedNow) {
    state = "DHAN_RATE_LIMITED";
  } else if (!feedEnabled || skipLive) {
    // Token is fine but the live feed is switched off.
    state = "DHAN_FEED_DISABLED";
  } else if (connecting && !firstLiveConfirmed) {
    // Validating on boot / after a new token — not yet proven live (§3, §14).
    state = "DHAN_CONNECTING";
  } else if (!marketOpen) {
    // Auth healthy, market closed — this is NOT stale/disconnected (§7).
    state = "DHAN_MARKET_CLOSED";
  } else if (dataAgeMs == null || dataAgeMs > DATA_STALE_MS) {
    // Market open, token valid, but no fresh data within the window (§4).
    state = "DHAN_DATA_STALE";
  } else if (tok.expiringSoon) {
    // Live, but the token will lapse soon — warn while still green-ish (§2).
    state = "DHAN_TOKEN_EXPIRING";
  } else {
    state = "DHAN_LIVE";
  }

  // ---- Derive sub-statuses for consumers that want the axes separately. ----
  const authStatus: DhanAuthStatus =
    !tok.present ? "NO_TOKEN" :
    tok.expired || state === "DHAN_TOKEN_EXPIRED" ? "EXPIRED" :
    state === "DHAN_AUTH_FAILED" ? "AUTH_FAILED" :
    tok.expiringSoon ? "EXPIRING" :
    lastSuccessfulAuthAt ? "VALID" : "UNKNOWN";

  const feedStatus: DhanFeedStatus =
    state === "DHAN_DISCONNECTED" ? "DISCONNECTED" :
    state === "DHAN_FEED_DISABLED" ? "DISABLED" :
    state === "DHAN_RATE_LIMITED" ? "RATE_LIMITED" :
    state === "DHAN_CONNECTING" ? "CONNECTING" :
    state === "DHAN_DATA_STALE" ? "STALE" :
    state === "DHAN_LIVE" || state === "DHAN_TOKEN_EXPIRING" || state === "DHAN_MARKET_CLOSED" ? "LIVE" :
    "DISCONNECTED";

  const freshness = classifyFreshness({
    ageMs: dataAgeMs,
    marketOpen,
    hasValue: lastSuccessfulDataAt > 0,
  });

  // Live signals require a genuine green LIVE (matches growwSignalsAllowed()).
  const signalsBlocked = state !== "DHAN_LIVE";

  return {
    provider: "DHAN",
    state,
    authStatus,
    feedStatus,
    marketStatus: marketOpen ? "OPEN" : "CLOSED",
    freshness,
    tokenPresent: tok.present,
    clientId: tok.clientId,
    tokenExpiresAt: tok.expiresAt,
    tokenIssuedAt: tok.issuedAt,
    tokenAgeMs: tok.tokenAgeMs,
    timeUntilExpiryMs: tok.timeUntilExpiryMs,
    tokenExpiringSoon: tok.expiringSoon,
    lastSuccessfulAuthAt: lastSuccessfulAuthAt || null,
    lastSuccessfulDataAt: lastSuccessfulDataAt || null,
    lastSuccessfulQuoteAt: lastSuccessfulQuoteAt || null,
    lastSuccessfulCandleAt: lastSuccessfulCandleAt || null,
    lastWebSocketMessageAt: lastWebSocketMessageAt || null,
    lastResponseAt: lastResponseAt || null,
    dataAgeMs,
    lastError: errorCurrent ? lastError : null,
    errorCode: errorCurrent ? lastError!.code : null,
    reconnectAttempt,
    signalsBlocked,
    ui: uiForState(state, tok),
  };
}

// ---- UI presentation for each state (§5, §14) ------------------------------
export function uiForState(state: DhanState, tok?: DhanTokenMeta): DhanUiStatus {
  switch (state) {
    case "DHAN_LIVE":
      return { level: "green", label: "DHAN LIVE", detail: "Live market data receiving", action: null };
    case "DHAN_TOKEN_EXPIRING": {
      const mins = tok?.timeUntilExpiryMs != null ? Math.max(1, Math.round(tok.timeUntilExpiryMs / 60000)) : null;
      return {
        level: "yellow",
        label: "TOKEN EXPIRING",
        detail: mins != null ? `Token expires in ~${mins} min — reconnect required soon` : "Token expires soon — reconnect required",
        action: "Reconnect Dhan",
      };
    }
    case "DHAN_TOKEN_EXPIRED":
      return { level: "red", label: "TOKEN EXPIRED", detail: "Dhan token expired — reconnect required", action: "Reconnect Dhan" };
    case "DHAN_AUTH_FAILED":
      return { level: "red", label: "DHAN AUTH FAILED", detail: "Dhan authentication failed — reconnect required", action: "Reconnect Dhan" };
    case "DHAN_FEED_DISABLED":
      return { level: "red", label: "DHAN FEED OFF", detail: "Live feed is disabled — reconnect to resume live data", action: "Reconnect Dhan" };
    case "DHAN_RATE_LIMITED":
      return { level: "orange", label: "DHAN RATE LIMITED", detail: "Dhan is rate-limiting — backing off and retrying", action: null };
    case "DHAN_MARKET_CLOSED":
      return { level: "blue", label: "MARKET CLOSED", detail: "Market closed — showing last available market data", action: null };
    case "DHAN_DATA_STALE":
      return { level: "orange", label: "DATA STALE", detail: "No fresh market data received", action: null };
    case "DHAN_CONNECTING":
      return { level: "yellow", label: "DHAN CONNECTING", detail: "Validating Dhan connection...", action: null };
    case "DHAN_DISCONNECTED":
    default:
      return { level: "grey", label: "DHAN NOT CONNECTED", detail: "No Dhan token — connect to go live", action: "Connect Dhan" };
  }
}

// ---- Structured, secret-free log line (§15) --------------------------------
/** Returns a structured object safe to log — NEVER contains the token/JWT. */
export function dhanHealthLogRecord(h: DhanHealth): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    provider: h.provider,
    state: h.state,
    authStatus: h.authStatus,
    feedStatus: h.feedStatus,
    marketStatus: h.marketStatus,
    freshness: h.freshness,
    tokenExpiresAt: h.tokenExpiresAt ? new Date(h.tokenExpiresAt).toISOString() : null,
    lastSuccessfulDataAt: h.lastSuccessfulDataAt ? new Date(h.lastSuccessfulDataAt).toISOString() : null,
    lastWebSocketMessageAt: h.lastWebSocketMessageAt ? new Date(h.lastWebSocketMessageAt).toISOString() : null,
    errorCode: h.errorCode,
    reconnectAttempt: h.reconnectAttempt,
    dataAgeMs: h.dataAgeMs,
  };
}
