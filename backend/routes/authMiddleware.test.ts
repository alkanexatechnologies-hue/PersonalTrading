// Verifies backend-enforced authorization directly (not just "the UI hides a
// button") - requireAdmin/requirePermission are the exact functions
// routes/api.ts attaches to /api/admin/* and the permission-gated feature
// routes. Isolates its effect on data/users.json (backup/restore) the same
// way session.test.ts does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { requireAdmin, requirePermission } from "./api";
import { login } from "../auth/session";
import { getCredentials, setPasswordless } from "../auth/credentials";
import { createUser } from "../auth/userStore";

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
  else { try { fs.unlinkSync(USERS_FILE); } catch { /* never existed */ } }
  setPasswordless(originalPasswordless);
});

function fakeReq(token?: string): any {
  return { headers: token ? { authorization: `Bearer ${token}` } : {}, path: "/admin/users" };
}
function fakeRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

test("requireAdmin: rejects with 403 when there is no session at all", () => {
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin(fakeReq(), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("requireAdmin: rejects a real, valid, but non-admin (user) session with 403 — a plain USER cannot reach an admin API by manually typing the URL", () => {
  createUser({ username: "test_mw_user1", temporaryPassword: "CorrectPass1", permissions: ["oiAnalysis"] });
  const login1 = login("test_mw_user1", "CorrectPass1", "user");
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin(fakeReq(login1.token), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("requireAdmin: allows a real admin session through", () => {
  const creds = getCredentials();
  const adminLogin = login(creds.username, creds.password, "admin");
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin(fakeReq(adminLogin.token), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requirePermission: a user WITHOUT the required permission is rejected with 403", () => {
  createUser({ username: "test_mw_user2", temporaryPassword: "CorrectPass1", permissions: ["oiAnalysis"] });
  const l = login("test_mw_user2", "CorrectPass1", "user");
  const res = fakeRes();
  let nextCalled = false;
  requirePermission("backtesting")(fakeReq(l.token), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("requirePermission: a user WITH the required permission is let through", () => {
  createUser({ username: "test_mw_user3", temporaryPassword: "CorrectPass1", permissions: ["backtesting"] });
  const l = login("test_mw_user3", "CorrectPass1", "user");
  const res = fakeRes();
  let nextCalled = false;
  requirePermission("backtesting")(fakeReq(l.token), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requirePermission: admin has implicit full access regardless of the permission requested", () => {
  const creds = getCredentials();
  const adminLogin = login(creds.username, creds.password, "admin");
  const res = fakeRes();
  let nextCalled = false;
  requirePermission("adminReports")(fakeReq(adminLogin.token), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requirePermission: no session at all is rejected with 401 (not 403 — distinguishes 'not logged in' from 'logged in but not allowed')", () => {
  const res = fakeRes();
  let nextCalled = false;
  requirePermission("oiAnalysis")(fakeReq(), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});
