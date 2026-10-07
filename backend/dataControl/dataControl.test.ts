import { test } from "node:test";
import assert from "node:assert/strict";
import { screenOn, jobOn, setDataControl, countRequest, dataControlStatus, _resetDataControlForTests } from "./dataControl";

test("everything is ON by default; unknown screens are never blocked", () => {
  _resetDataControlForTests();
  assert.equal(screenOn("marketcommand"), true);
  assert.equal(screenOn("some-new-tab"), true);
  assert.equal(screenOn(null), true);
  assert.equal(jobOn("paperEngine"), true);
});

test("switching a screen / job OFF and back ON", () => {
  _resetDataControlForTests();
  assert.equal(setDataControl("screen", "earlymoves", false, false), true);
  assert.equal(screenOn("earlymoves"), false);
  assert.equal(setDataControl("job", "warmFeeds", false, false), true);
  assert.equal(jobOn("warmFeeds"), false);
  setDataControl("screen", "earlymoves", true, false);
  assert.equal(screenOn("earlymoves"), true);
});

test("unknown keys are rejected (no silent typos)", () => {
  _resetDataControlForTests();
  assert.equal(setDataControl("screen", "nope", false, false), false);
  assert.equal(setDataControl("job", "nope", false, false), false);
});

test("status lists every screen and job with its state", () => {
  _resetDataControlForTests();
  setDataControl("screen", "news", false, false);
  countRequest("marketcommand", false);
  const s = dataControlStatus();
  assert.equal(s.screens.find((x) => x.key === "news")!.enabled, false);
  assert.equal(s.screens.find((x) => x.key === "marketcommand")!.enabled, true);
  assert.ok(s.jobs.some((j) => j.key === "tradeMonitor" && j.important));
});
