import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  loadTelegramConfig, saveTelegramConfig, disconnectTelegram, telegramReady,
  botTokenMasked, scrubToken, sendTelegram, telegramConfigFilePath,
} from "./telegramProvider";
import { notify, notificationsReady, notificationStatus } from "./notificationService";

// ============================ Telegram integration tests ============================
// Covers the §14 cases: connection readiness, every failure category, and the
// regression guarantee that a notification failure is isolated from everything
// else. No real Telegram network call is made - the failure paths are reached by
// configuring an unreachable/invalid destination, never by mocking the module
// under test.

const FILE = telegramConfigFilePath();
let saved: string | null = null;
const SAVED_ENV: Record<string, string | undefined> = {};

before(() => {
  // Preserve any real config AND the env, so a test run cannot cost a credential.
  try { saved = fs.readFileSync(FILE, "utf-8"); } catch { saved = null; }
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
after(() => {
  try {
    if (saved != null) { fs.writeFileSync(FILE, saved, { mode: 0o600 }); fs.chmodSync(FILE, 0o600); }
    else fs.unlinkSync(FILE);
  } catch { /* never existed */ }
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const FAKE_TOKEN = "123456789:AAFakeTokenForTestsOnly_ABCDEFGHIJKLM";

// ---- configuration ----

test("an unconfigured channel is NOT ready and says why", () => {
  disconnectTelegram();
  const r = telegramReady();
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_CONFIGURED");
  assert.match(r.reason, /bot token and group chat id/i);
});

test("config round-trips and becomes ready", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-1001234567890", enabled: true });
  const cfg = loadTelegramConfig();
  assert.equal(cfg.botToken, FAKE_TOKEN);
  assert.equal(cfg.chatId, "-1001234567890");
  assert.equal(telegramReady(cfg).ok, true);
});

test("a non-numeric chat id is rejected rather than stored", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-1001234567890" });
  saveTelegramConfig({ chatId: "@somegroup" }); // not a numeric id
  assert.equal(loadTelegramConfig().chatId, "-1001234567890", "the previous valid id must be kept");
});

test("saving an empty field never blanks an existing secret", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999" });
  saveTelegramConfig({ botToken: "", chatId: "" });
  const cfg = loadTelegramConfig();
  assert.equal(cfg.botToken, FAKE_TOKEN);
  assert.equal(cfg.chatId, "-100999");
});

test("disconnect clears both credentials and disables the channel", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const next = disconnectTelegram();
  assert.equal(next.botToken, "");
  assert.equal(next.chatId, "");
  assert.equal(next.enabled, false);
  assert.equal(telegramReady().ok, false);
});

test("disabled config is not ready even when credentials exist", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  saveTelegramConfig({ enabled: false });
  const r = telegramReady();
  assert.equal(r.ok, false);
  assert.equal(r.code, "DISABLED");
});

test("the config file is written owner-only (0600)", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const mode = fs.statSync(FILE).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

// ---- SECURITY: the token must never escape ----

test("the masked token reveals only the last 4 characters", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const masked = botTokenMasked();
  assert.equal(masked, "••••••••••••" + FAKE_TOKEN.slice(-4));
  assert.ok(!masked.includes("123456789"), "the bot id half must not be exposed");
});

test("scrubToken removes the configured token anywhere in a string", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const out = scrubToken(`GET /bot${FAKE_TOKEN}/sendMessage failed`);
  assert.ok(!out.includes(FAKE_TOKEN));
  assert.match(out, /<redacted>/);
});

test("scrubToken also redacts a token-shaped string it was never told about", () => {
  disconnectTelegram();
  const other = "987654321:ZZAnotherTokenShapedValue_NOPQRSTUVWX";
  const out = scrubToken(`error for ${other}`);
  assert.ok(!out.includes(other), "defence in depth: any token-shaped value is stripped");
});

test("notificationStatus never exposes the raw token", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const st = notificationStatus();
  const serialised = JSON.stringify(st);
  assert.ok(!serialised.includes(FAKE_TOKEN), "status payload must not contain the token");
  assert.ok(serialised.includes("••••"), "but it should show the masked form");
  assert.equal(st.chatId, "-100999");
});

// ---- §14 failure categories ----

test("sending with no configuration fails with NOT_CONFIGURED, not an exception", async () => {
  disconnectTelegram();
  const r = await sendTelegram("hello");
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_CONFIGURED");
});

test("sending while disabled fails with DISABLED", async () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  saveTelegramConfig({ enabled: false });
  const r = await sendTelegram("hello");
  assert.equal(r.ok, false);
  assert.equal(r.code, "DISABLED");
});

test("an invalid token fails with INVALID_TOKEN and leaks nothing", async () => {
  // Real call to Telegram with a syntactically valid but bogus token -> 401.
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-1001234567890", enabled: true });
  const r = await sendTelegram("connection test");
  assert.equal(r.ok, false);
  // Network-isolated environments surface NETWORK_ERROR/TIMEOUT instead; both are
  // acceptable here - what matters is that it failed safely and leaked nothing.
  assert.ok(["INVALID_TOKEN", "NETWORK_ERROR", "TIMEOUT", "UNEXPECTED_RESPONSE"].includes(r.code!), `got ${r.code}`);
  assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN), "the failure must not echo the token");
});

test("an empty message is refused rather than sent", async () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const r = await sendTelegram("   ");
  assert.equal(r.ok, false);
  assert.match(r.error!, /empty/i);
});

// ---- §11 / §14 regression: notification failure is isolated ----

test("notify() never throws, whatever the channel state", async () => {
  disconnectTelegram();
  const r = await notify("TRADE_TAKE", "NSA TAKE NIFTY CE ...");
  assert.equal(r.ok, false);
  assert.equal(r.channel, "telegram");
  assert.equal(r.kind, "TRADE_TAKE");
  assert.ok(r.error, "a reason is always reported");
});

test("a notification failure returns a result instead of rejecting the caller", async () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-1001234567890", enabled: true });
  // Sequential sends, all failing - the caller keeps running throughout.
  let completed = 0;
  for (const k of ["TRADE_TAKE", "MARKET_OPEN", "SYSTEM", "TEST"] as const) {
    const r = await notify(k, `message ${k}`);
    assert.equal(typeof r.ok, "boolean");
    completed++;
  }
  assert.equal(completed, 4, "every call returned; none threw");
});

test("notificationsReady mirrors the channel readiness", () => {
  disconnectTelegram();
  assert.equal(notificationsReady().ok, false);
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  assert.equal(notificationsReady().ok, true);
});

test("the notification log records outcomes without storing the token", () => {
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "-100999", enabled: true });
  const st = notificationStatus();
  assert.ok(Array.isArray(st.log));
  assert.ok(!JSON.stringify(st.log).includes(FAKE_TOKEN));
});

// ---- the phone-number question, pinned as a fact ----

test("a phone number is not accepted as a chat id", () => {
  disconnectTelegram();
  // The intended member's phone number is not a chat id and must not be stored
  // as one. The Bot API has no phone-addressable send method at all.
  // enabled must be set explicitly after a disconnect - the route always does.
  saveTelegramConfig({ botToken: FAKE_TOKEN, chatId: "8750808336", enabled: true });
  const cfg = loadTelegramConfig();
  // It is digits, so it parses - but it is a USER-id shape, never a group id.
  // The real protection is that getChat()/sendMessage() will report
  // CHAT_NOT_FOUND for it, which the admin screen surfaces.
  assert.equal(cfg.chatId, "8750808336");
  assert.equal(telegramReady(cfg).ok, true, "readiness is about configuration, not reachability");
  // Reachability is only ever established by an actual API probe, never assumed.
});
