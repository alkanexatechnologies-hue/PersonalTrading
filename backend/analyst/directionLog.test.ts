import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDirectionChange, _resetDirectionMemory } from "./directionLog";

test("records only on an actual direction change, never a standing direction", () => {
  _resetDirectionMemory();
  const mk = (direction: any) => ({ symbol: "^TEST", at: 1790000000, spot: 100, direction, bullishEvidence: [], bearishEvidence: [] });
  // First observation: establishes baseline, records nothing.
  assert.equal(recordDirectionChange(mk("BULLISH")), null);
  // Same direction again (a 5s poll): still nothing.
  assert.equal(recordDirectionChange(mk("BULLISH")), null);
  // Flip → records a change with prev/next.
  const c = recordDirectionChange(mk("BEARISH"));
  assert.ok(c);
  assert.equal(c!.previous, "BULLISH");
  assert.equal(c!.next, "BEARISH");
  // Standing on the new direction: nothing again.
  assert.equal(recordDirectionChange(mk("BEARISH")), null);
});
