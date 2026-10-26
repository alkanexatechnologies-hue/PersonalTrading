import { test } from "node:test";
import assert from "node:assert/strict";
import { syncKeyValid, syncKeyConfigured, _resetSyncKeyBrake } from "./syncKey";

const KEY = "k".repeat(16) + "0123456789abcdef";   // 32 chars

test("sync key: off unless a long key is configured", () => {
  _resetSyncKeyBrake();
  assert.equal(syncKeyConfigured({}), false);
  assert.equal(syncKeyConfigured({ NSA_SYNC_KEY: "short" }), false);
  assert.equal(syncKeyValid(KEY, {}).ok, false);
  assert.equal(syncKeyValid("short", { NSA_SYNC_KEY: "short" }).ok, false);
  assert.equal(syncKeyConfigured({ NSA_SYNC_KEY: KEY }), true);
});

test("sync key: only the exact key passes", () => {
  _resetSyncKeyBrake();
  const env = { NSA_SYNC_KEY: KEY };
  assert.equal(syncKeyValid(KEY, env).ok, true);
  assert.equal(syncKeyValid(KEY + "x", env).ok, false);
  assert.equal(syncKeyValid("", env).ok, false);
  assert.equal(syncKeyValid(undefined, env).ok, false);
});

test("sync key: 10 failures in 10 minutes lock out even the right key, then it recovers", () => {
  _resetSyncKeyBrake();
  const env = { NSA_SYNC_KEY: KEY }, t0 = 1_000_000;
  for (let i = 0; i < 10; i++) syncKeyValid("wrong", env, t0 + i);
  assert.equal(syncKeyValid(KEY, env, t0 + 20).ok, false);
  assert.equal(syncKeyValid(KEY, env, t0 + 601_000).ok, true);
});
