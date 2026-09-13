// ============================ Local access gate (paper desk) ============================
// Now a two-tier gate: ONE admin account (unchanged - auth/credentials.ts,
// still plaintext-at-rest for its existing email/WhatsApp resend feature) plus
// admin-managed USER accounts (auth/userStore.ts, properly hashed). This is
// still NOT a multi-tenant SaaS auth system - it protects a personal,
// admin-controlled dashboard - but every /api route (see routes/api.ts)
// enforces it server-side, never just in the UI.
//
// SECURITY NOTES:
//  - Credentials are checked SERVER-SIDE only (never shipped in frontend JS).
//  - Admin password: SHA-256 + constant-time compare (unchanged from before).
//  - User passwords: scrypt hash + constant-time compare (auth/passwordHash.ts).
//  - Sessions are opaque random tokens held in memory, now carrying identity
//    (userId/username/role/permissions), and expire daily at 07:00 AM IST.
//  - DEV MODE: credentials.ts's setPasswordless(true) makes the ADMIN path
//    accept any password (including blank) for the admin username only - user
//    accounts are never affected by this flag.

import crypto from "crypto";
import { getCredentials } from "./credentials";
import {
  findByUsername, effectiveStatus, recordLoginSuccess, recordLoginFailure, Permission,
} from "./userStore";
import { verifyPassword } from "./passwordHash";
import { logAuditEvent } from "./loginAudit";

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

export type Role = "admin" | "user";

export interface SessionRecord {
  expiresAt: number;
  userId: string; // "admin" for the single admin account (no userStore record)
  username: string;
  role: Role;
  permissions: Permission[]; // empty for admin - admin has implicit full access, checked by role, not this list
}

// token -> session record
const sessions = new Map<string, SessionRecord>();

// Next 07:00 AM IST (= 01:30 UTC) strictly after `now`.
function nextExpiry(now = Date.now()): number {
  const d = new Date(now);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 30, 0, 0); // 01:30 UTC
  let exp = target;
  if (exp <= now) exp += 24 * 60 * 60 * 1000;
  return exp;
}

function sweep(now = Date.now()) {
  for (const [t, rec] of sessions) if (rec.expiresAt <= now) sessions.delete(t);
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  role?: Role;
  username?: string;
  permissions?: Permission[];
  error?: string;
}

// `mode` is a UI affordance only (which card the user clicked) - it is NEVER
// trusted for authorization. The actual role always comes from the matched
// account (the fixed admin credential, or a userStore record's real role),
// never from what the client claims.
export function login(username: string, password: string, mode?: "admin" | "user"): LoginResult {
  const creds = getCredentials();
  const isAdminUsername = safeEqual(sha256(String(username ?? "")), sha256(creds.username));
  if (isAdminUsername) {
    const okPass = creds.passwordless === true || safeEqual(sha256(String(password ?? "")), sha256(creds.password));
    if (okPass) {
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = nextExpiry();
      sessions.set(token, { expiresAt, userId: "admin", username: creds.username, role: "admin", permissions: [] });
      logAuditEvent({ type: "login_success", userId: "admin", username: creds.username, mode: "admin" });
      return { ok: true, token, expiresAt, role: "admin", username: creds.username, permissions: [] };
    }
    logAuditEvent({ type: "login_failure", userId: null, username: String(username ?? ""), mode: mode ?? null, detail: "invalid admin password" });
    return { ok: false, error: "Invalid username or password." };
  }

  // Not the admin username - check the user store.
  const user = findByUsername(String(username ?? ""));
  if (!user) {
    logAuditEvent({ type: "login_failure", userId: null, username: String(username ?? ""), mode: mode ?? null, detail: "no such user" });
    return { ok: false, error: "Invalid username or password." };
  }
  const status = effectiveStatus(user);
  if (status === "DISABLED") {
    logAuditEvent({ type: "login_failure", userId: user.userId, username: user.username, mode: "user", detail: "account disabled" });
    return { ok: false, error: "Your account has been disabled. Please contact your administrator." };
  }
  if (status === "EXPIRED") {
    logAuditEvent({ type: "login_failure", userId: user.userId, username: user.username, mode: "user", detail: "access expired" });
    return { ok: false, error: "Your MarketPil access has expired. Please contact your administrator." };
  }
  if (status === "NOT_STARTED") {
    logAuditEvent({ type: "login_failure", userId: user.userId, username: user.username, mode: "user", detail: "access not yet started" });
    return { ok: false, error: "Your MarketPil access has not started yet. Please contact your administrator." };
  }
  if (!verifyPassword(String(password ?? ""), user.passwordHash)) {
    recordLoginFailure(user.username);
    logAuditEvent({ type: "login_failure", userId: user.userId, username: user.username, mode: "user", detail: "invalid password" });
    return { ok: false, error: "Invalid username or password." };
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = nextExpiry();
  sessions.set(token, { expiresAt, userId: user.userId, username: user.username, role: "user", permissions: user.permissions });
  recordLoginSuccess(user.userId);
  logAuditEvent({ type: "login_success", userId: user.userId, username: user.username, mode: "user" });
  return { ok: true, token, expiresAt, role: "user", username: user.username, permissions: user.permissions };
}

export function validate(token: string | undefined | null): boolean {
  if (!token) return false;
  sweep();
  const rec = sessions.get(token);
  if (!rec) return false;
  if (rec.expiresAt <= Date.now()) { sessions.delete(token); return false; }
  return true;
}

export function getSession(token: string | undefined | null): SessionRecord | null {
  if (!validate(token)) return null;
  return sessions.get(token as string) || null;
}

export function logout(token: string | undefined | null): void {
  if (!token) return;
  const rec = sessions.get(token);
  if (rec) logAuditEvent({ type: "logout", userId: rec.userId, username: rec.username, mode: rec.role });
  sessions.delete(token);
}

// Admin action: kill every active session belonging to a given userId
// ("Revoke Access"). Returns how many sessions were terminated.
export function revokeUserSessions(userId: string): number {
  let count = 0;
  for (const [t, rec] of sessions) {
    if (rec.userId === userId) { sessions.delete(t); count++; }
  }
  return count;
}

// Expiry the frontend can show ("Session ends daily at 7:00 AM IST").
export function sessionInfo(token: string | undefined | null) {
  const rec = getSession(token);
  return {
    valid: !!rec,
    expiresAt: rec ? rec.expiresAt : nextExpiry(),
    resetLabel: "07:00 AM IST",
    role: rec?.role ?? null,
    username: rec?.username ?? null,
    permissions: rec?.permissions ?? [],
  };
}
