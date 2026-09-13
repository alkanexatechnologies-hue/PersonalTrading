// Isolates its effect on real app state: data/users.json is backed up before
// these tests run and restored exactly afterward (tests create/edit real-shaped
// user records via the real userStore.ts functions, since that's the only way
// to genuinely exercise session.ts's login() branches). The admin path uses
// the REAL current admin credentials (never logged/printed) so this exercises
// the actual production code path, not a fake stand-in. passwordless dev mode
// is temporarily forced off for determinism, then restored to whatever it was.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { login, validate, logout, getSession, revokeUserSessions } from "./session";
import { getCredentials, setPasswordless } from "./credentials";
import { createUser, setUserStatus, editUser } from "./userStore";

const USERS_FILE = path.join(process.cwd(), "data", "users.json");
let originalUsersFileContent: string | null = null;
let originalPasswordless = false;

before(() => {
  try { originalUsersFileContent = fs.readFileSync(USERS_FILE, "utf-8"); } catch { originalUsersFileContent = null; }
  originalPasswordless = getCredentials().passwordless === true;
  setPasswordless(false);
});

after(() => {
  if (originalUsersFileContent != null) fs.writeFileSync(USERS_FILE, originalUsersFileContent, { mode: 0o600 });
  else { try { fs.unlinkSync(USERS_FILE); } catch { /* never existed - nothing to remove */ } }
  setPasswordless(originalPasswordless);
});

test("admin login success with the real admin credentials", () => {
  const creds = getCredentials();
  const r = login(creds.username, creds.password, "admin");
  assert.equal(r.ok, true);
  assert.equal(r.role, "admin");
  assert.ok(r.token);
});

test("admin login failure with the correct username but wrong password", () => {
  const creds = getCredentials();
  const r = login(creds.username, creds.password + "-definitely-wrong", "admin");
  assert.equal(r.ok, false);
  assert.equal(r.error, "Invalid username or password.");
});

test("admin creates a user, and that user can log in successfully", () => {
  const created = createUser({ username: "test_session_user1", temporaryPassword: "TempPass123", permissions: ["oiAnalysis"] });
  const r = login("test_session_user1", "TempPass123", "user");
  assert.equal(r.ok, true);
  assert.equal(r.role, "user");
  assert.deepEqual(r.permissions, ["oiAnalysis"]);
  assert.ok(created.userId);
});

test("user login failure with wrong password", () => {
  createUser({ username: "test_session_user2", temporaryPassword: "CorrectPass1", permissions: [] });
  const r = login("test_session_user2", "WrongPass1", "user");
  assert.equal(r.ok, false);
});

test("disabled user cannot log in, with the exact required message", () => {
  const u = createUser({ username: "test_session_user3", temporaryPassword: "CorrectPass1", permissions: [] });
  setUserStatus(u.userId, "DISABLED");
  const r = login("test_session_user3", "CorrectPass1", "user");
  assert.equal(r.ok, false);
  assert.equal(r.error, "Your account has been disabled. Please contact your administrator.");
});

test("expired user cannot log in, with the exact required message", () => {
  const u = createUser({ username: "test_session_user4", temporaryPassword: "CorrectPass1", permissions: [] });
  editUser(u.userId, { accessExpiryDate: "2000-01-01" }); // long past
  const r = login("test_session_user4", "CorrectPass1", "user");
  assert.equal(r.ok, false);
  assert.equal(r.error, "Your MarketPil access has expired. Please contact your administrator.");
});

test("unknown username fails the same generic way as a wrong password (no username enumeration)", () => {
  const r = login("no_such_user_at_all", "whatever", "user");
  assert.equal(r.ok, false);
  assert.equal(r.error, "Invalid username or password.");
});

test("a claimed mode is never trusted for authorization — logging in as the real admin while claiming mode=user still returns role=admin", () => {
  const creds = getCredentials();
  const r = login(creds.username, creds.password, "user"); // lying about mode
  assert.equal(r.ok, true);
  assert.equal(r.role, "admin"); // role comes from the matched account, not the claimed mode
});

test("validate/getSession: a fresh token is valid, an invalid/unknown token is not", () => {
  const creds = getCredentials();
  const r = login(creds.username, creds.password, "admin");
  assert.equal(validate(r.token), true);
  assert.equal(validate("not-a-real-token"), false);
  assert.equal(validate(undefined), false);
  const sess = getSession(r.token);
  assert.equal(sess?.role, "admin");
});

test("logout invalidates the session immediately", () => {
  const creds = getCredentials();
  const r = login(creds.username, creds.password, "admin");
  assert.equal(validate(r.token), true);
  logout(r.token);
  assert.equal(validate(r.token), false);
});

test("revokeUserSessions kills every active session for that user (e.g. after a password reset)", () => {
  const u = createUser({ username: "test_session_user5", temporaryPassword: "CorrectPass1", permissions: [] });
  const r1 = login("test_session_user5", "CorrectPass1", "user");
  const r2 = login("test_session_user5", "CorrectPass1", "user"); // a second concurrent session
  assert.equal(validate(r1.token), true);
  assert.equal(validate(r2.token), true);
  const count = revokeUserSessions(u.userId);
  assert.equal(count, 2);
  assert.equal(validate(r1.token), false);
  assert.equal(validate(r2.token), false);
});
