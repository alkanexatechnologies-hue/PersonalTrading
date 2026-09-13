import fs from "fs";
import path from "path";

// ============================ Login audit log ============================
// Append-only JSONL (same pattern as backend/data/liveSnapshotRecorder.ts).
// Never stores a password or password hash - only what's needed to answer
// "who logged in/out/failed, when, and what did an admin do".

export type AuditEventType =
  | "login_success" | "login_failure" | "logout" | "session_expired" | "admin_action"
  | "ADMIN_LOGIN"
  | "GROWW_CONNECTION_TEST" | "GROWW_CREDENTIAL_UPDATED" | "GROWW_DISCONNECTED"
  | "DHAN_CONNECTION_TEST" | "DHAN_CREDENTIAL_UPDATED" | "DHAN_DISCONNECTED"
  | "TELEGRAM_CONNECTION_TEST" | "TELEGRAM_CREDENTIAL_UPDATED" | "TELEGRAM_DISCONNECTED"
  | "USER_CREATED" | "USER_DISABLED" | "USER_ENABLED" | "USER_PASSWORD_RESET" | "USER_REVOKED" | "USER_DELETED"
  | "CONNECTION_DISCONNECTED" | "ADMIN_ACCESS_DENIED";

export interface AuditEvent {
  at: number; // epoch ms
  type: AuditEventType;
  userId: string | null;
  username: string | null;
  mode: "admin" | "user" | null;
  provider?: "groww" | "dhan" | "telegram"; // which external provider, when relevant
  result?: "success" | "failure";
  detail?: string; // e.g. "created user X", "disabled user Y", "invalid password" - NEVER a token/password/secret value
}

const FILE = path.join(process.cwd(), "data", "login_audit.jsonl");

export function logAuditEvent(e: Omit<AuditEvent, "at">): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ at: Date.now(), ...e }) + "\n", "utf8");
  } catch { /* audit logging is best-effort - never blocks a login/logout */ }
}

export function readAuditLog(limit = 200): AuditEvent[] {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
