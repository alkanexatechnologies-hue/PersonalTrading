import fs from "fs";
import path from "path";

// ============================ Telegram Bot API provider ============================
// Replaces the former WhatsApp sender as the application's delivery channel.
// Messaging only - nothing in this file is read by any trading, OI, indicator or
// decision path, and a Telegram failure can never propagate into one.
//
// WHY A BOT + GROUP, AND NOT A PHONE NUMBER
// The Telegram Bot API addresses a destination by numeric `chat_id` (or by
// @username for a PUBLIC channel). It has no method that accepts a phone number,
// and a bot cannot initiate a conversation with a person or look a person up by
// phone. Resolving a phone number to a Telegram account is only possible through
// the MTProto CLIENT api with a real USER session (contacts.importContacts),
// which is a different product surface and is not what a notification bot should
// do. So the correct setup is: bot -> group -> group's chat_id.
//
// SECURITY
// The bot token is read from the environment or an owner-only (0600) config file,
// is never returned to the frontend, never written to a log line, and never
// included in an error message - errors are scrubbed before they leave this file.

const FILE = path.join(process.cwd(), "data", "telegram-config.json");
const API = "https://api.telegram.org";

/** Network timeout. A hung Telegram call must never hold up a trading tick. */
const TIMEOUT_MS = 8000;

export interface TelegramConfig {
  enabled: boolean;
  /** Bot token from @BotFather. SECRET - never leaves the backend. */
  botToken: string;
  /** Numeric chat id of the destination group (negative for groups/supergroups). */
  chatId: string;
}

export type TelegramFailureCode =
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "INVALID_TOKEN"
  | "CHAT_NOT_FOUND"
  | "BOT_NOT_IN_CHAT"
  | "RATE_LIMITED"
  | "TELEGRAM_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNEXPECTED_RESPONSE";

const FAILURE_TEXT: Record<TelegramFailureCode, string> = {
  NOT_CONFIGURED: "Telegram is not configured — a bot token and group chat id are required.",
  DISABLED: "Telegram alerts are switched off.",
  INVALID_TOKEN: "Bot token was rejected by Telegram. Create or re-issue the token with @BotFather.",
  CHAT_NOT_FOUND: "Chat id not found. Check the group chat id (groups are negative numbers).",
  BOT_NOT_IN_CHAT: "The bot is not a member of that group. Add the bot to the group first.",
  RATE_LIMITED: "Telegram is rate-limiting this bot. Try again shortly.",
  TELEGRAM_UNAVAILABLE: "Telegram API is unavailable (server error on their side).",
  NETWORK_ERROR: "Network error reaching Telegram.",
  TIMEOUT: "Telegram request timed out.",
  UNEXPECTED_RESPONSE: "Unexpected response from the Telegram API.",
};

function digitsAndSign(s: string): string {
  const t = String(s || "").trim();
  return /^-?\d+$/.test(t) ? t : "";
}

export function loadTelegramConfig(): TelegramConfig {
  let file: Partial<TelegramConfig> = {};
  try { file = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { /* none yet */ }
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || file.botToken || "").trim();
  const chatId = digitsAndSign(process.env.TELEGRAM_CHAT_ID || file.chatId || "");
  // Enabled defaults to true once credentials exist, so configuring it is enough.
  const enabled = file.enabled != null ? file.enabled === true : !!(botToken && chatId);
  return { enabled, botToken, chatId };
}

/** Persists config at 0600, matching every other credential file in this app. */
export function saveTelegramConfig(patch: Partial<TelegramConfig>): TelegramConfig {
  const cur = loadTelegramConfig();
  const tokenIn = patch.botToken != null ? String(patch.botToken).trim() : "";
  const chatIn = patch.chatId != null ? digitsAndSign(patch.chatId) : "";
  const next: TelegramConfig = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    // Never blank an existing secret by submitting an empty field.
    botToken: tokenIn || cur.botToken,
    chatId: chatIn || cur.chatId,
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch { /* best-effort */ }
  return next;
}

/** Explicit disconnect - clears both credentials outright. */
export function disconnectTelegram(): TelegramConfig {
  const next: TelegramConfig = { enabled: false, botToken: "", chatId: "" };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(FILE, 0o600);
  } catch { /* best-effort */ }
  return next;
}

export function telegramReady(cfg = loadTelegramConfig()): { ok: boolean; reason: string; code?: TelegramFailureCode } {
  if (!cfg.botToken || !cfg.chatId) return { ok: false, reason: FAILURE_TEXT.NOT_CONFIGURED, code: "NOT_CONFIGURED" };
  if (!cfg.enabled) return { ok: false, reason: FAILURE_TEXT.DISABLED, code: "DISABLED" };
  return { ok: true, reason: "Bot + group configured" };
}

/** Masked token for display. Never the real value. */
export function botTokenMasked(cfg = loadTelegramConfig()): string {
  if (!cfg.botToken) return "";
  return "••••••••••••" + cfg.botToken.slice(-4);
}

/**
 * Removes the bot token from any string before it is returned or logged. The
 * token appears in every request URL, so an unscrubbed fetch error can leak it.
 */
export function scrubToken(text: string, cfg = loadTelegramConfig()): string {
  if (!text) return text;
  let out = String(text);
  if (cfg.botToken) out = out.split(cfg.botToken).join("<redacted>");
  // Defence in depth: strip anything shaped like a bot token.
  out = out.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<redacted>");
  return out;
}

function classify(status: number, description: string): TelegramFailureCode {
  const d = (description || "").toLowerCase();
  if (status === 401 || d.includes("unauthorized")) return "INVALID_TOKEN";
  if (d.includes("chat not found")) return "CHAT_NOT_FOUND";
  if (d.includes("bot is not a member") || d.includes("bot was kicked") || d.includes("not enough rights")) return "BOT_NOT_IN_CHAT";
  if (status === 429 || d.includes("too many requests")) return "RATE_LIMITED";
  if (status >= 500) return "TELEGRAM_UNAVAILABLE";
  if (status === 400) return d.includes("chat") ? "CHAT_NOT_FOUND" : "UNEXPECTED_RESPONSE";
  return "UNEXPECTED_RESPONSE";
}

export interface TelegramCallResult<T = any> {
  ok: boolean;
  result?: T;
  code?: TelegramFailureCode;
  /** Safe, user-facing text. Never contains the token. */
  error?: string;
  /** Telegram's own description, scrubbed. */
  detail?: string;
}

/** One Bot API call, with a hard timeout and token-scrubbed errors. */
async function call<T = any>(method: string, body?: Record<string, unknown>, cfg = loadTelegramConfig()): Promise<TelegramCallResult<T>> {
  if (!cfg.botToken) return { ok: false, code: "NOT_CONFIGURED", error: FAILURE_TEXT.NOT_CONFIGURED };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/bot${cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (res.ok && json?.ok) return { ok: true, result: json.result as T };
    const description = scrubToken(json?.description || text || "", cfg);
    const code = classify(res.status, description);
    return { ok: false, code, error: FAILURE_TEXT[code], detail: description.slice(0, 200) };
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    const code: TelegramFailureCode = aborted ? "TIMEOUT" : "NETWORK_ERROR";
    return { ok: false, code, error: FAILURE_TEXT[code], detail: scrubToken(e?.message || String(e), cfg).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Bot identity — proves the token is valid without sending a message. */
export async function getMe(cfg = loadTelegramConfig()): Promise<TelegramCallResult<{ id: number; username?: string; first_name?: string }>> {
  return call("getMe", {}, cfg);
}

/** Destination group metadata — proves the chat id is reachable by this bot. */
export async function getChat(cfg = loadTelegramConfig()): Promise<TelegramCallResult<{ id: number; title?: string; type?: string }>> {
  const ready = telegramReady(cfg);
  if (!ready.ok) return { ok: false, code: ready.code, error: ready.reason };
  return call("getChat", { chat_id: cfg.chatId }, cfg);
}

/**
 * Sends a plain-text message to the configured group.
 *
 * Plain text (no parse_mode) is deliberate: the existing notification bodies
 * contain characters that Telegram's Markdown/HTML parsers would reject
 * (₹, *, _, +, -, |, .), and a parse failure would silently drop a trade alert.
 * Keeping it plain preserves the existing message content exactly.
 */
export async function sendTelegram(text: string, cfg = loadTelegramConfig()): Promise<TelegramCallResult<{ message_id: number }>> {
  const ready = telegramReady(cfg);
  if (!ready.ok) return { ok: false, code: ready.code, error: ready.reason };
  // Telegram's hard limit is 4096 characters per message.
  const body = String(text || "").slice(0, 4000);
  if (!body.trim()) return { ok: false, code: "UNEXPECTED_RESPONSE", error: "Refusing to send an empty message." };
  return call("sendMessage", { chat_id: cfg.chatId, text: body, disable_web_page_preview: true }, cfg);
}

/**
 * Creates a fresh invite link for the group so the owner can add another member.
 *
 * The Bot API has NO method to add an arbitrary person to a group, and none that
 * accepts a phone number. A bot can only create an invite link (and only when it
 * is an admin with the invite-users right); the person must then join through it
 * themselves. That is the technically correct flow, so it is the one implemented.
 */
export async function createInviteLink(name?: string, cfg = loadTelegramConfig()): Promise<TelegramCallResult<{ invite_link: string; name?: string }>> {
  const ready = telegramReady(cfg);
  if (!ready.ok) return { ok: false, code: ready.code, error: ready.reason };
  const body: Record<string, unknown> = { chat_id: cfg.chatId, creates_join_request: false };
  if (name) body.name = String(name).slice(0, 32);
  return call("createChatInviteLink", body, cfg);
}

export function telegramConfigFilePath(): string {
  return FILE;
}
