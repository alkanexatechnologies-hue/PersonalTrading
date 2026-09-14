import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataFile } from "../config/dataDir";
import { sendCredentialsEmail } from "./mailer";
import { notify, notificationsReady } from "../integrations/notificationService";

// ============================ Persisted, rotating login credentials ============================
// The dashboard's login used to regenerate a brand-new random password every
// server restart - restart the app and the password you just saw in the log
// stopped working. Credentials now persist to disk (data/auth-credentials.json,
// owner-only permissions) and only actually ROTATE on a schedule: once per IST
// calendar day, at/after 08:00 IST (see maybeRotateForNewDay, called from the
// scheduler in routes/api.ts). A restart mid-day reuses the same credentials.
//
// If a notification email is configured (setNotifyEmail, exposed via
// POST /api/auth/email), each rotation also emails the new username/password
// there (see mailer.ts) instead of only printing to the server console. If a
// Telegram channel is configured (POST /api/telegram/config - bot token + group
// chat id, see integrations/telegramProvider.ts), each rotation is
// also sent there.

export interface StoredCredentials {
  username: string;
  password: string; // plaintext at rest (needed to re-send by email on rotation) - file is 0600, matching how .groww_token is protected elsewhere in this app.
  lastRotatedDate: string; // IST calendar date "YYYY-MM-DD" of the last rotation
  notifyEmail: string | null;
  // DEV-ONLY: skip the password check entirely (username still required). Set
  // via setPasswordless(true) - a deliberate, explicit, reversible choice for
  // local development, requested to be turned back off before going live (see
  // session.ts's login()). Never auto-enabled; defaults to false.
  passwordless?: boolean;
}

// Persisted on DATA_DIR (a mounted disk in production) so a restart/redeploy
// keeps the same login instead of regenerating a random password. See dataDir.ts.
const FILE = dataFile("auth-credentials.json");
const IST_OFFSET_MS = 19_800_000;

function istDateStr(d = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function istHour(d = new Date()): number {
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
}

function randomPassword(): string {
  return crypto.randomBytes(9).toString("base64url");
}

function save(creds: StoredCredentials): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.auth-credentials.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, FILE);
  fs.chmodSync(FILE, 0o600);
}

function load(): StoredCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    if (raw && typeof raw.username === "string" && typeof raw.password === "string") {
      return {
        username: raw.username, password: raw.password, lastRotatedDate: raw.lastRotatedDate || "",
        notifyEmail: raw.notifyEmail ?? null, passwordless: raw.passwordless === true,
      };
    }
  } catch { /* missing or corrupt - fall through to generating fresh credentials */ }
  return null;
}

function announce(creds: StoredCredentials, justRotated: boolean): void {
  if (creds.passwordless) {
    console.log(`\n  ⚠️  Dashboard login PASSWORD DISABLED (dev mode) — user "${creds.username}", any password (including blank) is accepted.`);
    console.log(`  Turn real authentication back on before going live (ask to re-enable passwordless: false).\n`);
    return;
  }
  if (process.env.LOGIN_PASS) return; // fixed via env - nothing new to report
  console.log(`\n  Dashboard login${justRotated ? " (just rotated)" : ""}:`);
  console.log(`    user     : ${creds.username}`);
  console.log(`    password : ${creds.password}`);
  console.log(`  Stays the same across restarts now; rotates automatically at 08:00 IST daily.`);
  console.log(
    creds.notifyEmail
      ? `  New credentials are emailed to ${creds.notifyEmail} on each rotation.`
      : `  Set a notification email (Connect panel -> Login notifications) to have new credentials emailed to you instead of checking this log.`
  );
  console.log(
    notificationsReady().ok
      ? `  New credentials are also sent via Telegram on each rotation.\n`
      : `  Configure Telegram (Connect panel -> Telegram alerts) to also get new credentials on Telegram.\n`
  );
}

const envUser = process.env.LOGIN_USER;
const envPass = process.env.LOGIN_PASS;

let current: StoredCredentials = (() => {
  const loaded = load();
  if (loaded && !envUser && !envPass) return loaded; // reuse across restarts
  const fresh: StoredCredentials = {
    username: envUser || "admin",
    password: envPass || randomPassword(),
    lastRotatedDate: istDateStr(),
    notifyEmail: loaded?.notifyEmail ?? null,
  };
  save(fresh);
  return fresh;
})();
announce(current, false);

export function getCredentials(): StoredCredentials {
  return current;
}

export function getNotifyEmail(): string | null {
  return current.notifyEmail;
}

export function setNotifyEmail(email: string | null): void {
  const trimmed = email && email.trim() ? email.trim() : null;
  current = { ...current, notifyEmail: trimmed };
  save(current);
}

export function isPasswordless(): boolean {
  return current.passwordless === true;
}

// DEV-ONLY toggle: skip the password check (username still required).
// setPasswordless(true) is a deliberate, explicit choice - call this again
// with false ("go live") to restore real password checking + daily rotation.
export function setPasswordless(on: boolean): StoredCredentials {
  current = { ...current, passwordless: on };
  save(current);
  announce(current, false);
  return current;
}

// Rotate to a brand-new random password, persist, and email it if a
// notification address is configured. Used by the daily 08:00 IST schedule and
// available standalone for a manual "rotate now".
export async function rotateCredentials(): Promise<StoredCredentials> {
  current = {
    username: envUser || current.username,
    password: envPass || randomPassword(),
    lastRotatedDate: istDateStr(),
    notifyEmail: current.notifyEmail,
  };
  save(current);
  announce(current, true);
  if (current.notifyEmail) {
    try {
      await sendCredentialsEmail(current.notifyEmail, current.username, current.password);
    } catch (e) {
      console.error("[auth] failed to email rotated credentials:", e instanceof Error ? e.message : e);
    }
  }
  // Same rotated credentials, second delivery channel - reuses the notification
  // service already built for trade alerts (integrations/notificationService.ts),
  // so this needs no new integration, only a bot token + group chat id configured
  // via POST /api/telegram/config (see the Connect panel's Telegram section).
  // Message body unchanged by the WhatsApp -> Telegram migration.
  if (notificationsReady().ok) {
    try {
      const r = await notify(
        "CREDENTIAL_ROTATION",
        `NSA Dashboard login (today):\nuser: ${current.username}\npass: ${current.password}\n\nRotates again tomorrow ~08:00 IST.`
      );
      if (!r.ok) console.error("[auth] failed to send rotated credentials:", r.error);
    } catch (e) {
      console.error("[auth] failed to send rotated credentials:", e instanceof Error ? e.message : e);
    }
  }
  return current;
}

// Call periodically from the scheduler. Rotates at most once per IST calendar
// day, only once 08:00 IST has actually passed - never on every restart.
export async function maybeRotateForNewDay(): Promise<void> {
  if (envPass) return; // fixed credentials via env - never auto-rotate
  if (current.passwordless) return; // dev mode - password check is skipped anyway
  const today = istDateStr();
  if (current.lastRotatedDate === today) return;
  if (istHour() < 8) return;
  await rotateCredentials();
}
