import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfirmationFlow, ConfirmationFlowInput, PriceActionInput } from "./confirmationFlow";
import { computeCooldown } from "../trade/cooldownStore";

const pa = (dir: "UP" | "DOWN" | "NONE", state = "BREAKOUT_ACCEPTED", conf = 70): PriceActionInput =>
  ({ available: true, status: state, direction: dir, confidence: conf, confirmationState: "CONFIRMED_ALIGNED", note: "" });

const base = (over: Partial<ConfirmationFlowInput> = {}): ConfirmationFlowInput => ({
  dataAvailable: true,
  dataStale: false,
  marketState: "TRENDING",
  regime: "TRENDING",
  direction: "BULLISH",
  priceAction: pa("UP"),
  structure: "Bullish",
  room: { pts: 50, minPts: 20, nextLevel: 23400, nextLabel: "resistance" },
  ema21: { state: "OFF", detail: "continuation" },
  entryReady: true,
  entryDetail: "In entry zone",
  optionReady: true,
  optionDetail: "23100 CE",
  cooldown: computeCooldown(null, 0),
  ...over,
});

const gate = (f: ReturnType<typeof buildConfirmationFlow>, k: string) => f.gates.find((g) => g.key === k)!;

test("all gates pass → TRADE", () => {
  const f = buildConfirmationFlow(base());
  assert.equal(f.action, "TRADE");
  assert.equal(gate(f, "execution").status, "TRADE");
  assert.equal(f.gates.length, 10);
});

test("no Master Trade Selector anywhere", () => {
  const f = buildConfirmationFlow(base());
  const blob = JSON.stringify(f).toLowerCase();
  assert.ok(!/master|selector|\bmts\b/.test(blob));
  assert.deepEqual(f.gates.map((g) => g.key), ["data", "break", "priceAction", "structure", "direction", "ema21", "option", "entry", "risk", "execution"]);
});

test("ROOM gate: < 20 points → WAIT INSUFFICIENT ROOM", () => {
  const f = buildConfirmationFlow(base({ room: { pts: 12, minPts: 20, nextLevel: 23160, nextLabel: "resistance" } }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /INSUFFICIENT ROOM/);
  assert.equal(gate(f, "entry").status, "WAIT");
});

test("ROOM gate: >= 20 points passes", () => {
  const f = buildConfirmationFlow(base({ room: { pts: 20, minPts: 20, nextLevel: 23200, nextLabel: "resistance" } }));
  assert.equal(f.action, "TRADE");
});

test("ROOM unknown (null) does NOT block", () => {
  const f = buildConfirmationFlow(base({ room: { pts: null, minPts: 20, nextLevel: null, nextLabel: null } }));
  assert.equal(f.action, "TRADE");
});

test("conflict in TRENDING regime does NOT block (regime-dependent)", () => {
  const f = buildConfirmationFlow(base({ priceAction: pa("DOWN"), regime: "TRENDING", marketState: "TRENDING" }));
  // price action bearish vs bullish direction, but trending → not a hard conflict block;
  // it fails on price-action-not-confirmed instead of a CONFLICT block.
  assert.equal(f.action, "WAIT");
  assert.ok(!/CONFLICT/.test(f.reason), "no conflict block in a trend");
});

test("conflict in RANGE regime DOES block", () => {
  const f = buildConfirmationFlow(base({ priceAction: pa("DOWN"), regime: "RANGE", marketState: "RANGE", structure: "Bearish" }));
  assert.equal(f.action, "WAIT");
  assert.match(f.reason, /CONFLICT/);
  assert.equal(f.conflict, true);
});

test("neutral direction → WAIT NO CLEAR DIRECTION", () => {
  const f = buildConfirmationFlow(base({ direction: "NEUTRAL", priceAction: pa("NONE"), structure: "Ranging" }));
  assert.match(f.reason, /NO CLEAR DIRECTION/);
});

test("price action not confirmed → WAIT", () => {
  const f = buildConfirmationFlow(base({ priceAction: pa("NONE", "NONE", 5) }));
  assert.match(f.reason, /PRICE ACTION NOT CONFIRMED/);
});

test("structure ranging → WAIT", () => {
  const f = buildConfirmationFlow(base({ structure: "Ranging" }));
  assert.match(f.reason, /STRUCTURE RANGING/);
});

test("option not ready → WAIT", () => {
  const f = buildConfirmationFlow(base({ optionReady: false }));
  assert.match(f.reason, /OPTION NOT READY/);
});

test("entry not reached → WAIT ENTRY NOT READY", () => {
  const f = buildConfirmationFlow(base({ entryReady: false }));
  assert.match(f.reason, /ENTRY NOT READY/);
  assert.equal(gate(f, "risk").status, "PENDING");
});

test("EMA21 is conditional — ACTIVE reversal check never blocks a valid trade", () => {
  const f = buildConfirmationFlow(base({ ema21: { state: "ACTIVE", detail: "Testing EMA21" } }));
  assert.equal(f.action, "TRADE");
  assert.equal(gate(f, "ema21").status, "PENDING");
});

test("cooldown active → WAIT POST TRADE COOLDOWN (wins over everything)", () => {
  const exec = 1000;
  const f = buildConfirmationFlow(base({ cooldown: computeCooldown(exec, exec + 60) }));
  assert.equal(f.action, "WAIT");
  assert.equal(f.cooldownActive, true);
  assert.match(f.reason, /POST TRADE COOLDOWN/);
});

test("data unavailable → DATA UNAVAILABLE", () => {
  const f = buildConfirmationFlow(base({ dataAvailable: false }));
  assert.equal(f.action, "DATA UNAVAILABLE");
  assert.equal(gate(f, "data").status, "UNAVAILABLE");
});

test("stale data → DATA STALE", () => {
  const f = buildConfirmationFlow(base({ dataStale: true }));
  assert.equal(f.action, "DATA STALE");
  assert.match(f.reason, /DATA STALE/);
});

test("marketState + activePhase are surfaced", () => {
  const f = buildConfirmationFlow(base({ marketState: "OPENING_BREAK_UP" }));
  assert.equal(f.marketState, "OPENING_BREAK_UP");
  assert.match(f.activePhase, /PART 1/);
});
