import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { computeCooldown, COOLDOWN_MINUTES, recordExecution, getCooldownState, _resetCooldownCache } from "./cooldownStore";

// ---- pure logic ------------------------------------------------------------
test("computeCooldown: no execution → inactive", () => {
  const c = computeCooldown(null, 1000);
  assert.equal(c.active, false);
  assert.equal(c.remainingSec, 0);
  assert.equal(c.reason, null);
});

test("computeCooldown: 15-minute window anchored to execution timestamp", () => {
  const exec = 1_000_000; // epoch sec
  const c = computeCooldown(exec, exec + 60); // 1 min later
  assert.equal(c.active, true);
  assert.equal(c.startTs, exec);
  assert.equal(c.endTs, exec + COOLDOWN_MINUTES * 60);
  assert.equal(c.nextAllowedTs, exec + 15 * 60);
  assert.equal(c.remainingSec, 14 * 60); // 15m - 1m
  assert.match(c.reason || "", /POST TRADE COOLDOWN — 14m 0s REMAINING/);
});

test("computeCooldown: exactly at the boundary is no longer active", () => {
  const exec = 500;
  const atEnd = exec + COOLDOWN_MINUTES * 60;
  assert.equal(computeCooldown(exec, atEnd).active, false);
  assert.equal(computeCooldown(exec, atEnd - 1).active, true);
});

test("computeCooldown: remaining formatted as m/s", () => {
  const exec = 0;
  const c = computeCooldown(exec, 7 * 60 + 45); // 7m45s elapsed → 7m15s left
  assert.equal(c.remainingSec, 7 * 60 + 15);
  assert.match(c.reason || "", /7m 15s REMAINING/);
});

// ---- persistence + restart recovery ----------------------------------------
test("recordExecution persists and getCooldownState recovers after a cold cache (restart)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-test-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir; // cooldownStore resolves DATA_DIR at call time
  try {
    const exec = Math.floor(Date.now() / 1000);
    recordExecution({ symbol: "^NSEI", execTs: exec, side: "CE", strike: 23100, entry: 150 });

    const stateFile = path.join(dir, "trade", "cooldowns.json");
    assert.ok(fs.existsSync(stateFile), "cooldown state file written");
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8"))["^NSEI"], exec);

    // Simulate a restart: clear the in-memory cache, then read → recovered from disk.
    _resetCooldownCache();
    const recovered = getCooldownState("^NSEI", exec + 60);
    assert.equal(recovered.active, true);
    assert.equal(recovered.execTs, exec);
    assert.equal(recovered.remainingSec, 14 * 60);

    const audit = path.join(dir, "trade", "executions.jsonl");
    assert.ok(fs.existsSync(audit), "execution audit written");
    const line = JSON.parse(fs.readFileSync(audit, "utf8").trim().split("\n")[0]);
    assert.equal(line.event, "TRADE_EXECUTED");
    assert.equal(line.symbol, "^NSEI");
    assert.equal(line.cooldownEndTs, exec + 15 * 60);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
    _resetCooldownCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
