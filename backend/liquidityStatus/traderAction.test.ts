import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTraderAction } from "./traderAction";

const noRemaining = { confirmed: [], remaining: [] };
const someRemaining = { confirmed: [], remaining: [{ label: "x", confirmed: false }] };
const noConflict = { conflict: false, reason: null };

test("decideTraderAction: an EXTENDED move always AVOID CHASING regardless of other inputs", () => {
  const r = decideTraderAction({ direction: "Bullish", moveStage: "EXTENDED", conflict: noConflict, confirmations: noRemaining, triggerAlreadyCrossed: true });
  assert.equal(r.action, "AVOID CHASING");
});

// N. False breakout: trigger crossed but conflict present -> WATCH, never PREPARE
test("decideTraderAction: trigger crossed but a conflict is present -> WATCH, not a prepare-to-trade action", () => {
  const r = decideTraderAction({
    direction: "Bullish", moveStage: "STRONG_MOVE",
    conflict: { conflict: true, reason: "Price up, OI bearish." },
    confirmations: noRemaining, triggerAlreadyCrossed: true,
  });
  assert.equal(r.action, "WATCH");
});

test("decideTraderAction: no confirmed direction -> NO TRADE", () => {
  const r = decideTraderAction({ direction: null, moveStage: "PRE_MOVE", conflict: noConflict, confirmations: someRemaining, triggerAlreadyCrossed: false });
  assert.equal(r.action, "NO TRADE");
});

test("decideTraderAction: PULLBACK stage -> WAIT FOR PULLBACK", () => {
  const r = decideTraderAction({ direction: "Bullish", moveStage: "PULLBACK", conflict: noConflict, confirmations: someRemaining, triggerAlreadyCrossed: false });
  assert.equal(r.action, "WAIT FOR PULLBACK");
});

test("decideTraderAction: developing move, trigger not yet crossed -> WAIT FOR BREAKOUT (bullish) / BREAKDOWN (bearish)", () => {
  const bull = decideTraderAction({ direction: "Bullish", moveStage: "DEVELOPING", conflict: noConflict, confirmations: someRemaining, triggerAlreadyCrossed: false });
  assert.equal(bull.action, "WAIT FOR BREAKOUT");
  const bear = decideTraderAction({ direction: "Bearish", moveStage: "DEVELOPING", conflict: noConflict, confirmations: someRemaining, triggerAlreadyCrossed: false });
  assert.equal(bear.action, "WAIT FOR BREAKDOWN");
});

test("decideTraderAction: trigger crossed AND every confirmation in place -> PREPARE FOR BUY/SELL", () => {
  const r = decideTraderAction({ direction: "Bullish", moveStage: "STRONG_MOVE", conflict: noConflict, confirmations: noRemaining, triggerAlreadyCrossed: true });
  assert.equal(r.action, "PREPARE FOR BUY");
});

test("decideTraderAction: trigger crossed but confirmations still pending -> WATCH, not a premature PREPARE", () => {
  const r = decideTraderAction({ direction: "Bullish", moveStage: "STRONG_MOVE", conflict: noConflict, confirmations: someRemaining, triggerAlreadyCrossed: true });
  assert.equal(r.action, "WATCH");
});
