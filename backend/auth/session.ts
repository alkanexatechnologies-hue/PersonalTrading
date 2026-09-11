// ============================ Local access gate (paper desk) ============================
// A lightweight, single-user login gate for the dashboard. This is NOT a
// multi-tenant auth system — it protects a personal, local paper-desk UI.
//
// SECURITY NOTES:
//  - Credentials are checked SERVER-SIDE only (never shipped in frontend JS).
//  - The password is compared as a SHA-256 hash using a constant-time compare.
//  - Defaults are Alkasrivastava / Alkasrivastava, overridable via env
//    (LOGIN_USER / LOGIN_PASS) so the secret can live outside source if desired.
//  - Sessions are opaque random tokens held in memory and expire daily at
//    07:00 AM IST (matching the paper-desk daily reset).

import crypto from "crypto";

const DEFAULT_USER = process.env.LOGIN_USER || "Alkasrivastava";
const DEFAULT_PASS = process.env.LOGIN_PASS || "Alkasrivastava";

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();
const USER_HASH = sha256(DEFAULT_USER);
const PASS_HASH = sha256(DEFAULT_PASS);

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// token -> expiry epoch ms
const sessions = new Map<string, number>();

// Next 07:00 AM IST (= 01:30 UTC) strictly after `now`.
function nextExpiry(now = Date.now()): number {
  const d = new Date(now);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 30, 0, 0); // 01:30 UTC
  let exp = target;
  if (exp <= now) exp += 24 * 60 * 60 * 1000;
  return exp;
}

function sweep(now = Date.now()) {
  for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  error?: string;
}

export function login(username: string, password: string): LoginResult {
  const okUser = safeEqual(sha256(String(username ?? "")), USER_HASH);
  const okPass = safeEqual(sha256(String(password ?? "")), PASS_HASH);
  if (!okUser || !okPass) return { ok: false, error: "Invalid username or password." };
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = nextExpiry();
  sessions.set(token, expiresAt);
  return { ok: true, token, expiresAt };
}

export function validate(token: string | undefined | null): boolean {
  if (!token) return false;
  sweep();
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) { sessions.delete(token); return false; }
  return true;
}

export function logout(token: string | undefined | null): void {
  if (token) sessions.delete(token);
}

// Expiry the frontend can show ("Session ends daily at 7:00 AM IST").
export function sessionInfo(token: string | undefined | null) {
  const valid = validate(token);
  return { valid, expiresAt: valid ? sessions.get(token!) : nextExpiry(), resetLabel: "07:00 AM IST" };
}
