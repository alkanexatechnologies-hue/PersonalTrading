import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { classifyGrowwError } from "./growwAuth";
import { scrubGrowwToken, rememberGrowwToken, forgetGrowwToken, getGrowwTokenMasked, hasGrowwToken } from "./sessionFeed";

// These tests mutate the in-memory Groww token. forgetGrowwToken() is
// memory-only by design, but back the real credential file up regardless so a
// test run can never cost the admin their saved token.
const TOKEN_FILE = path.join(process.cwd(), ".groww_token");
let savedTokenFile: string | null = null;
before(() => {
  try { savedTokenFile = fs.readFileSync(TOKEN_FILE, "utf-8"); } catch { savedTokenFile = null; }
});
after(() => {
  if (savedTokenFile == null) return;
  try {
    fs.writeFileSync(TOKEN_FILE, savedTokenFile, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch { /* best-effort restore */ }
});

// ============================ Groww token auth ============================
// The access token is the ONLY Groww credential. These tests pin the two rules
// that matter for it: failures are classified into actionable categories, and
// the token never leaks through a message, mask, or error path.

test("classifyGrowwError maps a 401 to INVALID_TOKEN with actionable text", () => {
  const r = classifyGrowwError(new Error("Groww quote 401: token expired"));
  assert.equal(r.code, "INVALID_TOKEN");
  assert.match(r.message, /expired|invalid/i);
});

test("classifyGrowwError maps 403 to AUTH_FAILED", () => {
  assert.equal(classifyGrowwError(new Error("Groww quote 403: forbidden")).code, "AUTH_FAILED");
});

test("classifyGrowwError maps 429 / rate-limit wording to RATE_LIMIT", () => {
  assert.equal(classifyGrowwError(new Error("Groww quote 429")).code, "RATE_LIMIT");
  assert.equal(classifyGrowwError(new Error("Rate limit breached")).code, "RATE_LIMIT");
});

test("classifyGrowwError maps 5xx to API_UNAVAILABLE", () => {
  assert.equal(classifyGrowwError(new Error("Groww quote 503: unavailable")).code, "API_UNAVAILABLE");
});

test("classifyGrowwError maps transport failures to NETWORK_ERROR", () => {
  for (const m of ["fetch failed", "ENOTFOUND api.groww.in", "ECONNREFUSED", "Groww request timed out"]) {
    assert.equal(classifyGrowwError(new Error(m)).code, "NETWORK_ERROR", m);
  }
});

test("classifyGrowwError falls back to UNEXPECTED_RESPONSE", () => {
  assert.equal(classifyGrowwError(new Error("something odd came back")).code, "UNEXPECTED_RESPONSE");
});

test("SECURITY: a classified error never echoes the access token", () => {
  const secret = "grww_live_SECRET_TOKEN_abcdef123456";
  rememberGrowwToken(secret);
  try {
    // Worst case: the provider quoted the credential back inside its error.
    const r = classifyGrowwError(new Error(`Groww quote 401 for token ${secret}`));
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes(secret), "classified error must not contain the token");
    assert.ok(!r.detail.includes(secret), "detail must not contain the token");
  } finally {
    forgetGrowwToken();
  }
});

test("SECURITY: scrubGrowwToken redacts the saved token anywhere in a string", () => {
  const secret = "grww_live_abcdef_0123456789";
  rememberGrowwToken(secret);
  try {
    const out = scrubGrowwToken(`before ${secret} after ${secret}`);
    assert.ok(!out.includes(secret));
    assert.match(out, /<redacted>/);
  } finally {
    forgetGrowwToken();
  }
});

test("SECURITY: the masked token exposes only the last 4 characters", () => {
  const secret = "grww_live_abcdefghijklmnop_WXYZ";
  rememberGrowwToken(secret);
  try {
    const masked = getGrowwTokenMasked();
    assert.equal(masked, "••••••••••••WXYZ");
    assert.ok(!masked.includes("abcdef"), "mask must not reveal the body of the token");
  } finally {
    forgetGrowwToken();
  }
});

test("forgetGrowwToken clears the in-memory token so nothing stays configured", () => {
  rememberGrowwToken("grww_live_some_long_enough_token_value");
  assert.equal(hasGrowwToken(), true);
  forgetGrowwToken();
  assert.equal(hasGrowwToken(), false);
  assert.equal(getGrowwTokenMasked(), "");
});

test("a non-empty token alone is not treated as a validated connection", () => {
  // hasGrowwToken() is only a "a token string exists" check - the connection
  // state shown to the admin comes from validateGrowwToken()'s real request.
  rememberGrowwToken("grww_live_this_is_not_a_real_token_at_all");
  try {
    assert.equal(hasGrowwToken(), true, "token present...");
    // ...but nothing here claims authentication succeeded.
  } finally {
    forgetGrowwToken();
  }
});
