import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfirmationFlow, ConfirmationFlowInput, PriceActionInput } from "./confirmationFlow";
import { computeCooldown } from "../trade/cooldownStore";

const pa = (dir: "UP" | "DOWN" | "NONE", state = "BREAKOUT_ACCEPTED", conf = 70): PriceActionInput =>
  ({ available: true, status: state, direction: dir, confidence: conf, confirmationState: "CONFIRMED_ALIGNED", note: "" });

const base = (over: Partial<ConfirmationFlowInput> = {}): ConfirmationFlowInput => ({
  direction: "BULLISH",
  priceAction: pa("UP"),
  structure: "Bullish",
  entryReady: true,
  entryDetail: "In entry zone",
  optionReady: true,
  optionDetail: "23100 CE responsive + liquid",
  dataAvailable: true,
  dataStale: false,
  cooldown: computeCooldown(null, 0),
  ...over,
});

test("all layers agree + entry + option → TRADE", () => {
  const f = buildConfirmationFlow(base());
  assert.equal(f.action, "TRADE");
  assert.equal(f.conflict, false);
  assert.equal(f.direction, "BULLISH");
  assert.equal(f.steps.length, 5);
});

test("Master Trade Selector is NOT part of the flow", () => {
  const f = buildConfirmationFlow(base());
  const labels = f.steps.map((s) => s.label.toLowerCase()).join("|");
  assert.ok(!/master|selector|mts/.test(labels), "no MTS step");
  assert.ok(!/master|selector|mts/.test(f.reason.toLowerCase()), "no MTS in reason");
  assert.deepEqual(f.steps.map((s) => s.key), ["marketDirection", "priceAction", "structure", "entry", "option"]);
});

test("price action opposes structure → CONFLICT → WAIT", () => {
  const f = buildConfirmationFlow(base({ priceAction: pa("DOWN"), structure: "Bullish", direction: "BULLISH" }));
  assert.equal(f.conflict, true);
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /CONFLICT/);
});

test("neutral market direction → WAIT (no clear direction)", () => {
  const f = buildConfirmationFlow(base({ direction: "NEUTRAL", priceAction: pa("NONE"), structure: "Ranging" }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /NO CLEAR DIRECTION/);
});

test("price action not confirmed → WAIT", () => {
  const f = buildConfirmationFlow(base({ priceAction: pa("NONE", "NONE", 10) }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /PRICE ACTION NOT CONFIRMED/);
});

test("structure ranging → WAIT", () => {
  const f = buildConfirmationFlow(base({ structure: "Ranging" }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /STRUCTURE RANGING/);
});

test("entry pending → WAIT", () => {
  const f = buildConfirmationFlow(base({ entryReady: false }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /ENTRY NOT CONFIRMED/);
});

test("option pending → WAIT", () => {
  const f = buildConfirmationFlow(base({ optionReady: false }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /OPTION NOT CONFIRMED/);
});

test("active cooldown forces WAIT even when everything else would TRADE (monitoring continues)", () => {
  const exec = 1000;
  const cd = computeCooldown(exec, exec + 60); // 14m left
  const f = buildConfirmationFlow(base({ cooldown: cd }));
  assert.equal(f.action, "WAIT");
  assert.equal(f.cooldownActive, true);
  assert.match(f.reason, /POST TRADE COOLDOWN/);
  // Steps are still computed during cooldown (analysis keeps running).
  assert.equal(f.steps.length, 5);
  assert.equal(f.steps[0].state, "BULLISH");
});

test("active cooldown wins over a conflict for the shown reason (still WAIT)", () => {
  const exec = 1000;
  const cd = computeCooldown(exec, exec + 60);
  const f = buildConfirmationFlow(base({ priceAction: pa("DOWN"), structure: "Bullish", cooldown: cd }));
  assert.equal(f.action, "WAIT");
  assert.equal(f.cooldownActive, true);
  assert.match(f.reason, /POST TRADE COOLDOWN/);
});

test("expired cooldown does NOT block a valid TRADE", () => {
  const exec = 1000;
  const cd = computeCooldown(exec, exec + 15 * 60 + 1); // ended
  const f = buildConfirmationFlow(base({ cooldown: cd }));
  assert.equal(f.cooldownActive, false);
  assert.equal(f.action, "TRADE");
});

test("data unavailable → DATA UNAVAILABLE", () => {
  const f = buildConfirmationFlow(base({ dataAvailable: false }));
  assert.equal(f.action, "DATA UNAVAILABLE");
});

test("stale data → WAIT (no live decision)", () => {
  const f = buildConfirmationFlow(base({ dataStale: true }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /DATA STALE/);
});
