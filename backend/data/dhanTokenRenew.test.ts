import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtExp, renewDecision, inMarketWindow, pickRenewedToken, RENEW_BELOW_SEC } from "./dhanTokenRenew";

const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (p: any) => `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.${b64(p)}.c2ln`;
const ist = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000 - 19800;

test("jwtExp reads the expiry", () => {
  assert.equal(jwtExp(jwt({ exp: 1791728792, dhanClientId: "1" })), 1791728792);
  assert.equal(jwtExp("not-a-token"), null);
});

test("market window: Mon–Fri 09:00–15:30 only", () => {
  assert.equal(inMarketWindow(ist(2026, 10, 12, 10, 0)), true);    // Monday 10:00
  assert.equal(inMarketWindow(ist(2026, 10, 12, 15, 31)), false);  // Monday 15:31
  assert.equal(inMarketWindow(ist(2026, 10, 12, 8, 59)), false);
  assert.equal(inMarketWindow(ist(2026, 10, 11, 10, 0)), false);   // Sunday
});

test("renew only outside market hours, when < 13 h remain and the token is still active", () => {
  const sat = ist(2026, 10, 10, 20, 30), exp = ist(2026, 10, 11, 19, 56);
  assert.equal(renewDecision(sat, exp).renew, false);                         // 23 h left
  assert.equal(renewDecision(exp - RENEW_BELOW_SEC + 60, exp).renew, true);    // Sunday ~07:00, < 13 h left
  const mon11 = ist(2026, 10, 12, 11, 0);
  assert.equal(renewDecision(mon11, mon11 + 3600).renew, false);              // market hours: wait
  assert.equal(renewDecision(mon11, mon11 + 60).renew, false);                // already (nearly) expired
  assert.match(renewDecision(mon11, mon11 + 60).why, /expired/);
});

test("weekly simulation: the token never expires and is never swapped in market hours", () => {
  let now = ist(2026, 10, 10, 20, 30), exp = ist(2026, 10, 11, 19, 56), renewals = 0;
  const end = now + 9 * 86400;
  for (; now < end; now += 600) {                   // check every 10 minutes
    assert.ok(exp > now, `token expired at ${new Date((now + 19800) * 1000).toISOString()}`);
    if (renewDecision(now, exp).renew) { assert.equal(inMarketWindow(now), false); exp = now + 86400; renewals++; }
  }
  assert.ok(renewals >= 9 && renewals <= 20, String(renewals));
});

test("pickRenewedToken: newer JWT for the same client, anywhere in the body", () => {
  const old = jwt({ exp: 100, dhanClientId: "1102021164" });
  const fresh = jwt({ exp: 200, dhanClientId: "1102021164" });
  assert.equal(pickRenewedToken({ data: { accessToken: fresh } }, old, "1102021164"), fresh);
  assert.equal(pickRenewedToken({ token: fresh }, old, "1102021164"), fresh);
  assert.equal(pickRenewedToken({ token: old }, old, "1102021164"), null);                                   // same token
  assert.equal(pickRenewedToken({ token: jwt({ exp: 200, dhanClientId: "999" }) }, old, "1102021164"), null); // other client
  assert.equal(pickRenewedToken({ status: "error" }, old, "1102021164"), null);
});
