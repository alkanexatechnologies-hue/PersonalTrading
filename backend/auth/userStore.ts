import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dataFile } from "../config/dataDir";
import { hashPassword } from "./passwordHash";

// ============================ Admin-managed user store ============================
// Separate from auth/credentials.ts (the single ADMIN account, unchanged).
// This file is only for USER accounts an admin creates. File-based, matching
// this project's existing storage architecture (no database anywhere in this
// app - see the session's earlier architecture note). Mutable (unlike the
// append-only trading-data recorder) since users are genuinely edited -
// read-modify-write with a temp-file+rename, same pattern as credentials.ts's
// save().

export type Permission = "tradingDashboard" | "marketAnalysis" | "oiAnalysis" | "aiSignals" | "backtesting" | "tradeJournal" | "adminReports";
export const ALL_PERMISSIONS: Permission[] = ["tradingDashboard", "marketAnalysis", "oiAnalysis", "aiSignals", "backtesting", "tradeJournal", "adminReports"];

export interface UserRecord {
  userId: string;
  username: string;
  passwordHash: string; // scrypt "salt:hash" - never returned to any client
  status: "ACTIVE" | "DISABLED"; // EXPIRED is DERIVED (see effectiveStatus), not stored
  createdAt: number;
  accessStartDate: string | null; // yyyy-mm-dd, null = starts immediately
  accessExpiryDate: string | null; // yyyy-mm-dd, null = never expires
  permissions: Permission[];
  lastLogin: number | null;
  failedLoginAttempts: number;
}

export type PublicUser = Omit<UserRecord, "passwordHash">;
export type EffectiveStatus = "ACTIVE" | "DISABLED" | "EXPIRED" | "NOT_STARTED";

// Persisted on DATA_DIR (a mounted disk in production) so admin-created user
// accounts survive restart/redeploy instead of resetting to empty. See dataDir.ts.
const FILE = dataFile("users.json");

function istDateStr(d = new Date()): string {
  return new Date(d.getTime() + 19_800_000).toISOString().slice(0, 10);
}

function loadAll(): UserRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAll(users: UserRecord[]): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.users.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, FILE);
  fs.chmodSync(FILE, 0o600);
}

export function toPublicUser(u: UserRecord): PublicUser {
  const { passwordHash, ...pub } = u;
  return pub;
}

export function effectiveStatus(u: UserRecord, today = istDateStr()): EffectiveStatus {
  if (u.status === "DISABLED") return "DISABLED";
  if (u.accessExpiryDate && u.accessExpiryDate < today) return "EXPIRED";
  if (u.accessStartDate && u.accessStartDate > today) return "NOT_STARTED";
  return "ACTIVE";
}

export function listUsers(): PublicUser[] {
  return loadAll().map(toPublicUser);
}

export function findByUsername(username: string): UserRecord | null {
  const u = loadAll().find((x) => x.username.toLowerCase() === username.toLowerCase());
  return u || null;
}

export function findById(userId: string): UserRecord | null {
  return loadAll().find((x) => x.userId === userId) || null;
}

export interface CreateUserInput {
  username: string;
  temporaryPassword: string;
  accessStartDate?: string | null;
  accessExpiryDate?: string | null;
  permissions: Permission[];
}

export function createUser(input: CreateUserInput): PublicUser {
  const users = loadAll();
  if (users.some((u) => u.username.toLowerCase() === input.username.toLowerCase())) {
    throw new Error(`Username "${input.username}" already exists.`);
  }
  const rec: UserRecord = {
    userId: crypto.randomBytes(8).toString("hex"),
    username: input.username.trim(),
    passwordHash: hashPassword(input.temporaryPassword),
    status: "ACTIVE",
    createdAt: Date.now(),
    accessStartDate: input.accessStartDate || null,
    accessExpiryDate: input.accessExpiryDate || null,
    permissions: input.permissions.filter((p) => ALL_PERMISSIONS.includes(p)),
    lastLogin: null,
    failedLoginAttempts: 0,
  };
  users.push(rec);
  saveAll(users);
  return toPublicUser(rec);
}

export interface EditUserInput {
  accessStartDate?: string | null;
  accessExpiryDate?: string | null;
  permissions?: Permission[];
}

export function editUser(userId: string, patch: EditUserInput): PublicUser {
  const users = loadAll();
  const idx = users.findIndex((u) => u.userId === userId);
  if (idx < 0) throw new Error("User not found.");
  if (patch.accessStartDate !== undefined) users[idx].accessStartDate = patch.accessStartDate;
  if (patch.accessExpiryDate !== undefined) users[idx].accessExpiryDate = patch.accessExpiryDate;
  if (patch.permissions !== undefined) users[idx].permissions = patch.permissions.filter((p) => ALL_PERMISSIONS.includes(p));
  saveAll(users);
  return toPublicUser(users[idx]);
}

export function setUserStatus(userId: string, status: "ACTIVE" | "DISABLED"): PublicUser {
  const users = loadAll();
  const idx = users.findIndex((u) => u.userId === userId);
  if (idx < 0) throw new Error("User not found.");
  users[idx].status = status;
  saveAll(users);
  return toPublicUser(users[idx]);
}

// Permanent removal (not "Disable") - for accounts genuinely not needed
// anymore, e.g. a test/mistake account. Unlike disable, this cannot be undone
// from the Admin Control Center; the caller (route) is responsible for
// revoking any of this user's active sessions first.
export function deleteUser(userId: string): PublicUser {
  const users = loadAll();
  const idx = users.findIndex((u) => u.userId === userId);
  if (idx < 0) throw new Error("User not found.");
  const [removed] = users.splice(idx, 1);
  saveAll(users);
  return toPublicUser(removed);
}

export function resetPassword(userId: string, newTemporaryPassword: string): PublicUser {
  const users = loadAll();
  const idx = users.findIndex((u) => u.userId === userId);
  if (idx < 0) throw new Error("User not found.");
  users[idx].passwordHash = hashPassword(newTemporaryPassword);
  users[idx].failedLoginAttempts = 0;
  saveAll(users);
  return toPublicUser(users[idx]);
}

export function recordLoginSuccess(userId: string): void {
  const users = loadAll();
  const idx = users.findIndex((u) => u.userId === userId);
  if (idx < 0) return;
  users[idx].lastLogin = Date.now();
  users[idx].failedLoginAttempts = 0;
  saveAll(users);
}

export function recordLoginFailure(username: string): void {
  const users = loadAll();
  const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx < 0) return;
  users[idx].failedLoginAttempts = (users[idx].failedLoginAttempts || 0) + 1;
  saveAll(users);
}

export function userStats(): { total: number; active: number; expired: number; disabled: number } {
  const users = loadAll();
  const today = istDateStr();
  let active = 0, expired = 0, disabled = 0;
  for (const u of users) {
    const s = effectiveStatus(u, today);
    if (s === "DISABLED") disabled++;
    else if (s === "EXPIRED") expired++;
    else active++; // ACTIVE and NOT_STARTED both counted as not-yet-a-problem
  }
  return { total: users.length, active, expired, disabled };
}
