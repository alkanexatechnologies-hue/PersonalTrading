// ============================ Machine sync key — Mac → Render Dhan-token hand-over ============================
// The Mac renews the Dhan token daily and hands it to the Render copy. That used to log in with Render's admin password,
// which rotates daily at 08:00 IST — so the hand-over silently broke and Render ran on an expired token (no Market Command
// data). Instead the Mac now sends the token with a long random key that BOTH sides hold (env / ~/.nsa-pull.env
// NSA_SYNC_KEY). The key can only set and test the Dhan market-data token (POST /api/dhan/sync) — nothing else. With no
// NSA_SYNC_KEY configured on the server the endpoint does not exist (404).
import crypto from "crypto";

const MIN_LEN = 24;
const _fails: number[] = [];   // failed attempts in the last 10 minutes (brute-force brake)

export function syncKeyConfigured(env = process.env): boolean { return (env.NSA_SYNC_KEY || "").length >= MIN_LEN; }

/** Constant-time check of a presented key; after 10 failures in 10 minutes every attempt is refused for the window. */
export function syncKeyValid(given: string | undefined, env = process.env, now = Date.now()): { ok: boolean; reason?: string } {
  const key = env.NSA_SYNC_KEY || "";
  if (key.length < MIN_LEN) return { ok: false, reason: "not configured" };
  while (_fails.length && now - _fails[0] > 600_000) _fails.shift();
  if (_fails.length >= 10) return { ok: false, reason: "too many failed attempts — try again later" };
  const h = (s: string) => crypto.createHash("sha256").update(s).digest();
  const ok = typeof given === "string" && given.length > 0 && crypto.timingSafeEqual(h(given), h(key));
  if (!ok) _fails.push(now);
  return ok ? { ok } : { ok, reason: "invalid sync key" };
}
/** Test hook. */
export function _resetSyncKeyBrake() { _fails.length = 0; }
