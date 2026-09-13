import fs from "fs";
import path from "path";
import {
  sendTelegram, telegramReady, loadTelegramConfig, botTokenMasked,
  getMe, getChat, TelegramFailureCode,
} from "./telegramProvider";

// ============================ Notification service ============================
//           Trading Application -> Notification Service -> Telegram Provider -> Group
//
// The rest of the application calls notify() and knows nothing about Telegram.
// That is what kept this migration from WhatsApp to a single-file change at each
// call site, and what will keep the next channel change just as small.
//
// THREE GUARANTEES THIS LAYER MAKES TO THE TRADING ENGINE
//   1. It never throws. Every failure path returns a result object, so a
//      notification problem cannot become a trading exception.
//   2. It never blocks indefinitely - the provider enforces an 8s timeout.
//   3. It never logs or returns a credential.
//
// Nothing here reads OI, indicators, regime, setup, risk or the Master Trade
// Selector. It only transports text it is handed.

export type NotificationKind =
  | "TRADE_TAKE"        // OI/paper TAKE ping (was the WhatsApp trade alert)
  | "MARKET_OPEN"       // market-online briefing
  | "CREDENTIAL_ROTATION"
  | "TEST"
  | "SYSTEM";

export interface NotifyResult {
  ok: boolean;
  channel: "telegram";
  kind: NotificationKind;
  code?: TelegramFailureCode;
  /** Safe text, never a credential. */
  error?: string;
  detail?: string;
}

const LOG = path.join(process.cwd(), "data", "notification-log.json");
const MAX_LOG = 60;

interface LogRow {
  at: number;
  istTime: string;
  kind: NotificationKind;
  channel: "telegram";
  ok: boolean;
  code?: string;
  error?: string;
  /** First line only, so the log stays readable; never a credential. */
  preview: string;
}

function appendLog(row: LogRow): void {
  try {
    let rows: LogRow[] = [];
    try { rows = JSON.parse(fs.readFileSync(LOG, "utf-8")); } catch { rows = []; }
    rows.unshift(row);
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.writeFileSync(LOG, JSON.stringify(rows.slice(0, MAX_LOG), null, 2), "utf-8");
  } catch { /* logging is best-effort and never affects the send */ }
}

function istTimeNow(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(11, 19);
}

/**
 * Sends one notification. NEVER throws - the caller can ignore the result
 * entirely and the trading path stays unaffected either way.
 */
export async function notify(kind: NotificationKind, text: string): Promise<NotifyResult> {
  const at = Date.now();
  try {
    const r = await sendTelegram(text);
    const out: NotifyResult = {
      ok: r.ok, channel: "telegram", kind,
      code: r.code, error: r.error, detail: r.detail,
    };
    appendLog({
      at, istTime: istTimeNow(), kind, channel: "telegram", ok: r.ok,
      code: r.code, error: r.error,
      preview: String(text || "").split("\n")[0].slice(0, 120),
    });
    return out;
  } catch (e: any) {
    // Defensive: the provider is written not to throw, but a notification must
    // never be able to surface an exception into a trading tick.
    const out: NotifyResult = {
      ok: false, channel: "telegram", kind,
      code: "UNEXPECTED_RESPONSE",
      error: "Notification failed unexpectedly.",
    };
    appendLog({ at, istTime: istTimeNow(), kind, channel: "telegram", ok: false, code: "UNEXPECTED_RESPONSE", error: out.error, preview: "" });
    return out;
  }
}

/**
 * Fire-and-forget send for callers inside a trading/scheduler path. Returns
 * immediately; the notification completes on its own and can never delay or
 * reject the caller.
 */
export function notifyDetached(kind: NotificationKind, text: string): void {
  void notify(kind, text).catch(() => { /* already handled inside notify */ });
}

/** Is the channel ready to deliver? Used where the old code asked whatsappReady(). */
export function notificationsReady(): { ok: boolean; reason: string } {
  const r = telegramReady();
  return { ok: r.ok, reason: r.reason };
}

export function readNotificationLog(limit = 10): LogRow[] {
  try {
    const rows: LogRow[] = JSON.parse(fs.readFileSync(LOG, "utf-8"));
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

export interface ChannelStatus {
  channel: "telegram";
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  reason: string;
  /** Masked only - the real token never leaves the backend. */
  botTokenMasked: string;
  chatId: string;
  /** Filled by the live probe in telegramStatusLive(). */
  botUsername: string | null;
  groupTitle: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  log: LogRow[];
}

/** Status without any network call - safe to poll. */
export function notificationStatus(): ChannelStatus {
  const cfg = loadTelegramConfig();
  const ready = telegramReady(cfg);
  const log = readNotificationLog(8);
  const lastOk = log.find((r) => r.ok);
  const lastErr = log.find((r) => !r.ok);
  return {
    channel: "telegram",
    enabled: cfg.enabled,
    configured: !!(cfg.botToken && cfg.chatId),
    ready: ready.ok,
    reason: ready.reason,
    botTokenMasked: botTokenMasked(cfg),
    chatId: cfg.chatId,
    botUsername: null,
    groupTitle: null,
    lastSuccessAt: lastOk ? lastOk.at : null,
    lastError: lastErr ? lastErr.error || lastErr.code || "error" : null,
    log,
  };
}

/**
 * Status plus a live probe of the bot and the group. Two read-only Bot API calls
 * (getMe + getChat); sends nothing. Used by the admin screen's status panel.
 */
export async function notificationStatusLive(): Promise<ChannelStatus & { botOk: boolean; groupOk: boolean; probeError?: string }> {
  const base = notificationStatus();
  if (!base.configured) return { ...base, botOk: false, groupOk: false, probeError: base.reason };
  const [me, chat] = await Promise.all([getMe(), getChat()]);
  return {
    ...base,
    botUsername: me.ok ? me.result?.username ?? null : null,
    groupTitle: chat.ok ? chat.result?.title ?? null : null,
    botOk: me.ok,
    groupOk: chat.ok,
    probeError: me.ok ? (chat.ok ? undefined : chat.error) : me.error,
  };
}
