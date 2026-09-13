import crypto from "crypto";

// ============================ Password hashing (new USER accounts only) ============================
// Node's built-in scrypt KDF - no new dependency needed (bcrypt isn't in this
// project's package.json and adding a native-binding dependency for this
// alone isn't warranted when Node already ships a real, salted, slow KDF).
// The existing single ADMIN credential (auth/credentials.ts) is untouched by
// this file - it keeps its own already-approved plaintext-at-rest design
// (needed to re-send by email/WhatsApp on rotation). This module is only for
// the new admin-managed USER accounts, which must never be re-sendable in
// plaintext - only a fresh temporary password the admin sets and hands over
// once.

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(candidate, expected); } catch { return false; }
}
