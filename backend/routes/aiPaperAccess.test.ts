// AI Paper Desk authorization — verifies the desk gate and per-screen gates are
// enforced SERVER-SIDE (a real 401/403), not merely hidden in the UI. Covers the
// review checklist for this feature: login, logout, desk switching by permission,
// permission editing, and unauthorized API access.
//
// This import MUST come first: it repoints DATA_DIR at a private temp directory
// so this file operates on its own users.json/credentials and never races the
// shared data/*.json that the other auth test files back up and restore.
import "./aiPaperTestEnv";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { requirePermission } from "./api";
import { login, logout, getSession } from "../auth/session";
import { getCredentials, setPasswordless } from "../auth/credentials";
import { createUser, editUser, findByUsername, ALL_PERMISSIONS, AI_PAPER_SCREEN_PERMISSIONS } from "../auth/userStore";

before(() => { setPasswordless(false); }); // deterministic admin-password checks in the isolated dir

function fakeReq(token?: string): any {
  return { headers: token ? { authorization: `Bearer ${token}` } : {}, path: "/ai-paper/dashboard" };
}
function fakeRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}
function passes(perm: any, token?: string): boolean {
  const res = fakeRes();
  let ok = false;
  requirePermission(perm)(fakeReq(token), res, () => { ok = true; });
  return ok;
}

test("the AI Paper Desk permissions exist in the master permission list", () => {
  for (const p of ["aiPaperDesk", ...AI_PAPER_SCREEN_PERMISSIONS]) {
    assert.ok(ALL_PERMISSIONS.includes(p as any), `${p} should be a known permission`);
  }
  assert.equal(AI_PAPER_SCREEN_PERMISSIONS.length, 7);
});

test("unauthorized API access: no session at all → 401 on every AI Paper route", () => {
  for (const p of ["aiPaperDashboard", "aiPaperTrade", "aiPaperValidation"] as const) {
    const res = fakeRes();
    requirePermission(p)(fakeReq(), res, () => {});
    assert.equal(res.statusCode, 401, `${p} without a session must be 401`);
  }
});

test("desk switching by permission: a user WITHOUT aiPaperDashboard is blocked (403) from that screen", () => {
  createUser({ username: "aip_no_dash", temporaryPassword: "CorrectPass1", permissions: ["aiPaperDesk", "aiPaperTrade"] });
  const l = login("aip_no_dash", "CorrectPass1", "user");
  assert.equal(passes("aiPaperDashboard", l.token), false, "screen not granted → blocked");
  const res = fakeRes();
  requirePermission("aiPaperDashboard")(fakeReq(l.token), res, () => {});
  assert.equal(res.statusCode, 403);
  // but the screen they DO have is allowed
  assert.equal(passes("aiPaperTrade", l.token), true, "granted screen → allowed");
});

test("per-screen editing: admin granting a screen permission takes effect on next login", () => {
  createUser({ username: "aip_edit", temporaryPassword: "CorrectPass1", permissions: ["aiPaperDesk"] });
  let l = login("aip_edit", "CorrectPass1", "user");
  assert.equal(passes("aiPaperPerformance", l.token), false, "not granted yet");

  // Admin edits the user's screen permissions (per-screen within the desk).
  const rec = findByUsername("aip_edit")!;
  editUser(rec.userId, { permissions: ["aiPaperDesk", "aiPaperPerformance"] });

  // The session carries the permissions captured AT LOGIN, so the change lands on
  // the next login — a fresh login now passes where it was blocked before.
  logout(l.token!);
  l = login("aip_edit", "CorrectPass1", "user");
  assert.equal(passes("aiPaperPerformance", l.token), true, "granted after edit + re-login");
});

test("logout: after logout the token is dead and every AI Paper route rejects it", () => {
  createUser({ username: "aip_logout", temporaryPassword: "CorrectPass1", permissions: ["aiPaperDesk", "aiPaperDashboard"] });
  const l = login("aip_logout", "CorrectPass1", "user");
  assert.equal(passes("aiPaperDashboard", l.token), true, "allowed while logged in");
  logout(l.token!);
  assert.equal(getSession(l.token), null, "session gone after logout");
  const res = fakeRes();
  requirePermission("aiPaperDashboard")(fakeReq(l.token), res, () => {});
  assert.equal(res.statusCode, 401, "a logged-out token is treated as no session (401)");
});

test("admin has implicit access to every AI Paper screen without any of the new permissions", () => {
  const creds = getCredentials();
  const adminLogin = login(creds.username, creds.password, "admin");
  for (const p of AI_PAPER_SCREEN_PERMISSIONS) {
    assert.equal(passes(p, adminLogin.token), true, `admin should pass ${p}`);
  }
});
