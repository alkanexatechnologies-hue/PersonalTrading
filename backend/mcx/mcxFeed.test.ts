import { test } from "node:test";
import assert from "node:assert/strict";

// The isolation guarantees of the gold feed: serialized + spaced calls, circuit breaker, last-good fallback.
// dhanFetch is replaced with a stub so no network is used.
test("MCX feed: one call at a time, spaced, breaker opens after 3 failures, stale fallback", async () => {
  process.env.GOLD_GAP_MS = "200";
  const F = await import("./mcxFeed");
  let inFlight = 0, maxInFlight = 0, starts: number[] = [], fail = false;
  F._setMcxTransport((async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 30)); inFlight--;
    if (fail) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ timestamp: [1, 2], open: [1, 1], high: [2, 2], low: [1, 1], close: [1.5, 1.6], volume: [1, 1], open_interest: [5, 6] }), { status: 200 });
  }) as any, (() => ({ accessToken: "x", clientId: "y" })) as any);
  F._resetMcxFeed();
  const r = await Promise.all([F.mcxBars("a", "FUTCOM", 5), F.mcxBars("b", "FUTCOM", 5), F.mcxBars("c", "OPTFUT", 5)]);
  assert.equal(maxInFlight, 1, "never more than one MCX Dhan call in flight");
  assert.ok(starts[1] - starts[0] >= 190 && starts[2] - starts[1] >= 190, "calls are spaced");
  assert.equal(r[0].v.length, 2); assert.equal(r[0].v[1].oi, 6);
  // failures: last good data is served as stale; after 3 failures the breaker opens and no call is made
  fail = true; const before = starts.length;
  const s1 = await F.mcxBars("a", "FUTCOM", 5, 7, 0); assert.equal(s1.stale, true);
  await F.mcxBars("b", "FUTCOM", 5, 7, 0); await F.mcxBars("c", "OPTFUT", 5, 7, 0);
  assert.equal(F.mcxBreaker().open, true);
  const n = starts.length; await F.mcxBars("a", "FUTCOM", 5, 7, 0);
  assert.equal(starts.length, n, "no Dhan call while the breaker is open"); assert.equal(n - before, 3);
  F._resetMcxFeed(); F._setMcxTransport(null, null);
});
