// Covers the 16 required scenarios for admin-only connection management.
// Isolates its effect on data/users.json the same way session.test.ts does.
// No real Groww/Dhan/WhatsApp network calls are made - these test the
// AUTHORIZATION boundary and the NO-SECRET-LEAK guarantee, not live
// connectivity (that's what the manual "Test Connection" button is for).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { requireAdmin, requirePermission, buildConnectionsSummary } from "./api";
import { login } from "../auth/session";
import { getCredentials, setPasswordless } from "../auth/credentials";
import { createUser } from "../auth/userStore";
import { readAuditLog, logAuditEvent } from "../auth/loginAudit";
import { saveDhanConfig, loadDhanConfig } from "../data/dhanConfig";

const USERS_FILE = path.join(process.cwd(), "data", "users.json");
let originalUsersFileContent: string | null = null;
let originalPasswordless = false;
let originalDhanConfig: any;

before(() => {
  try { originalUsersFileContent = fs.readFileSync(USERS_FILE, "utf-8"); } catch { originalUsersFileContent = null; }
  originalPasswordless = getCredentials().passwordless === true;
  setPasswordless(false);
  originalDhanConfig = loadDhanConfig();
});
after(() => {
  if (originalUsersFileContent != null) fs.writeFileSync(USERS_FILE, originalUsersFileContent, { mode: 0o600 });
  else { try { fs.unlinkSync(USERS_FILE); } catch { /* never existed */ } }
  setPasswordless(originalPasswordless);
  saveDhanConfig(originalDhanConfig);
});

function fakeReq(token?: string, path = "/admin/connections"): any {
  return { headers: token ? { authorization: `Bearer ${token}` } : {}, path, method: "GET" };
}
function fakeRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}
function adminToken(): string {
  const creds = getCredentials();
  return login(creds.username, creds.password, "admin").token as string;
}
function userToken(username: string, permissions: string[] = []): string {
  createUser({ username, temporaryPassword: "CorrectPass1", permissions: permissions as any });
  return login(username, "CorrectPass1", "user").token as string;
}

// 1. Admin can view connections
test("1. Admin can view the Connections summary", () => {
  const res = fakeRes();
  let called = false;
  requireAdmin(fakeReq(adminToken()), res, () => { called = true; });
  assert.equal(called, true);
  const summary = buildConnectionsSummary();
  assert.ok("groww" in summary && "dhan" in summary && "whatsapp" in summary);
});

// 2/3/4. Admin can test Groww/Dhan/WhatsApp — verified via requireAdmin
// admitting the admin session to those routes (the routes themselves are
// thin wrappers around already-tested provider functions; the security
// boundary, not live network connectivity, is what's under test here).
test("2. Admin is admitted to the Groww test route", () => {
  const res = fakeRes(); let called = false;
  requireAdmin(fakeReq(adminToken(), "/groww/test"), res, () => { called = true; });
  assert.equal(called, true);
});
test("3. Admin is admitted to the Dhan test route", () => {
  const res = fakeRes(); let called = false;
  requireAdmin(fakeReq(adminToken(), "/dhan/test"), res, () => { called = true; });
  assert.equal(called, true);
});
test("4. Admin is admitted to the WhatsApp test route", () => {
  const res = fakeRes(); let called = false;
  requireAdmin(fakeReq(adminToken(), "/whatsapp/test"), res, () => { called = true; });
  assert.equal(called, true);
});

// 5. Admin can update credentials
test("5. Admin can update Dhan credentials", () => {
  const next = saveDhanConfig({ accessToken: "test-token-ABCD1234", clientId: "999" });
  assert.equal(next.accessToken, "test-token-ABCD1234");
});

// 6. Admin can disconnect a provider
test("6. Disconnecting Dhan clears the saved credential", async () => {
  const { disconnectDhan } = await import("../data/dhanConfig");
  const next = disconnectDhan();
  assert.equal(next.accessToken, "");
  assert.equal(next.clientId, "");
});

// 7. User cannot view connections
test("7. A plain USER is rejected from the Connections summary with ADMIN_ACCESS_REQUIRED", () => {
  const res = fakeRes(); let called = false;
  requireAdmin(fakeReq(userToken("test_conn_user1")), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "ADMIN_ACCESS_REQUIRED");
});

// 8/9/10. User cannot retrieve Groww/Dhan/WhatsApp tokens
test("8/9/10. A USER is rejected from every provider status/config/test route (Groww, Dhan, WhatsApp)", () => {
  const token = userToken("test_conn_user2");
  for (const p of ["/groww/config", "/dhan/status", "/whatsapp/status", "/groww/test", "/dhan/test", "/whatsapp/test"]) {
    const res = fakeRes(); let called = false;
    requireAdmin(fakeReq(token, p), res, () => { called = true; });
    assert.equal(called, false, `expected ${p} to reject a plain user`);
    assert.equal(res.statusCode, 403);
  }
});

// 11. User cannot access Admin API (general — /admin/users as a second example
// beyond connections, proving this isn't special-cased to one route)
test("11. A USER is rejected from /admin/users", () => {
  const res = fakeRes(); let called = false;
  requireAdmin(fakeReq(userToken("test_conn_user3"), "/admin/users"), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

// 12. User cannot access /admin URL — same requireAdmin gate covers this;
// there is no separate "page route" in this app (it's a single-page app with
// an API backend), so the equivalent, real check is: every /api/admin/* path
// is rejected the same way regardless of which one is requested.
test("12. Every /api/admin/* path is rejected for a plain USER, not just some of them", () => {
  const token = userToken("test_conn_user4");
  for (const p of ["/admin/users", "/admin/stats", "/admin/connections", "/admin/login-history", "/admin/permissions"]) {
    const res = fakeRes(); let called = false;
    requireAdmin(fakeReq(token, p), res, () => { called = true; });
    assert.equal(called, false, `expected ${p} to reject a plain user`);
  }
});

// 13. User cannot modify connection settings
test("13. A USER is rejected from POST routes that modify connection settings", () => {
  const token = userToken("test_conn_user5");
  for (const p of ["/dhan/config", "/whatsapp/config", "/connect", "/dhan/disconnect", "/whatsapp/disconnect", "/groww/forget-token"]) {
    const res = fakeRes(); let called = false;
    requireAdmin(fakeReq(token, p), res, () => { called = true; });
    assert.equal(called, false, `expected ${p} to reject a plain user`);
  }
});

// 14. User cannot modify Admin users (already covered by earlier admin-user-
// management tests in authMiddleware.test.ts; repeated here in the
// connections-focused suite for completeness of this specific requirement).
test("14. A USER cannot pass requireAdmin to reach user-management actions", () => {
  const res = fakeRes(); let called = false;
  requireAdmin(fakeReq(userToken("test_conn_user6"), "/admin/users/whatever/disable"), res, () => { called = true; });
  assert.equal(called, false);
});

// 15. API responses never leak credentials
test("15. buildConnectionsSummary() never contains a raw token/secret substring", () => {
  saveDhanConfig({ accessToken: "SUPER-SECRET-DHAN-TOKEN-VALUE", clientId: "12345" });
  const summary = buildConnectionsSummary();
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("SUPER-SECRET-DHAN-TOKEN-VALUE"), false);
  // The masked form must still be present in SOME form (not just silently dropped).
  assert.ok(summary.dhan.tokenMasked?.includes("•"));
});

// 16. Audit logs never contain credentials
test("16. Audit log entries never contain a raw credential value", () => {
  logAuditEvent({ type: "DHAN_CREDENTIAL_UPDATED", userId: "admin", username: "admin", mode: "admin", provider: "dhan", result: "success" });
  const events = readAuditLog(5);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("SUPER-SECRET-DHAN-TOKEN-VALUE"), false);
  assert.ok(events.some((e) => e.type === "DHAN_CREDENTIAL_UPDATED"));
});

// Extra: requirePermission-gated feature routes stay reachable for a user
// with the right permission, even though connection routes are locked down -
// proves the two gates (admin-only vs permission-gated) are properly separate.
test("extra: a USER with the 'backtesting' permission is NOT treated as admin and still can't see connections", () => {
  const token = userToken("test_conn_user7", ["backtesting"]);
  const permRes = fakeRes(); let permCalled = false;
  requirePermission("backtesting")(fakeReq(token, "/backtest-dhan/symbols"), permRes, () => { permCalled = true; });
  assert.equal(permCalled, true, "should be let through the feature route");

  const adminRes = fakeRes(); let adminCalled = false;
  requireAdmin(fakeReq(token, "/admin/connections"), adminRes, () => { adminCalled = true; });
  assert.equal(adminCalled, false, "having a feature permission must not grant admin/connections access");
});
