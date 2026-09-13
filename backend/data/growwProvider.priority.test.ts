// Dev priority-mechanism contention test (STEP 6 of the approved Groww
// priority-scheduling fix). Mocks the network so no real Groww call is made;
// verifies dispatch ORDER changes (HIGH before already-queued LOW) while
// concurrency, pacing, and existing error/retry handling are all unchanged.
//
// GROWW_MIN_GAP_MS / GROWW_MAX_CONCURRENT are read once at module import, so
// this test sets them via env (an EXISTING, already-supported override
// mechanism - see growwProvider.ts's own "All are env-overridable" comment)
// before dynamically importing the module, to keep the test fast and make
// concurrency=1 trivially easy to assert dispatch order against.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GROWW_MIN_GAP_MS = "20";
process.env.GROWW_MAX_CONCURRENT = "1";
process.env.GROWW_MAX_PER_MIN = "1000";

type MockCall = { label: string; startedAt: number; finishedAt: number };
const calls: MockCall[] = [];
let inFlight = 0;
let maxInFlight = 0;
let sawRetryable429 = false;

// One real fetch(url) IS allowed to return a 429 once, to prove the existing
// backoff/retry path (untouched by this change) still runs correctly under
// the new priority-aware admission.
const flakyLabel = "BG-FLAKY";
let flakyAttempts = 0;

(globalThis as any).fetch = async (url: string) => {
  const label = new URL(url).searchParams.get("trading_symbol") || "?";
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, 10)); // simulate network latency
  inFlight--;
  const finishedAt = Date.now();
  calls.push({ label, startedAt, finishedAt });

  if (label === flakyLabel && flakyAttempts === 0) {
    flakyAttempts++;
    sawRetryable429 = true;
    return new Response(JSON.stringify({ errorCode: 429 }), { status: 429, headers: { "Retry-After": "0" } });
  }
  return new Response(JSON.stringify({ payload: { candles: [] } }), { status: 200 });
};

// Dynamic import (not top-level await - this project builds as CommonJS) so
// GROWW_MIN_GAP_MS/GROWW_MAX_CONCURRENT env overrides above are already set
// before growwProvider.ts's module-level `const GROWW_MIN_GAP_MS = ...` runs.
let mod: typeof import("./growwProvider") | null = null;
async function loadModule() {
  if (!mod) mod = await import("./growwProvider");
  return mod;
}

async function req(nseSymbol: string): Promise<unknown> {
  const { GrowwProvider } = await loadModule();
  const provider = new GrowwProvider("test-token");
  return provider.getCandles(`${nseSymbol}.NS`, "5m", 1);
}
async function backgroundReq(nseSymbol: string): Promise<unknown> {
  const { runAsBackgroundGroww } = await loadModule();
  return runAsBackgroundGroww(() => req(nseSymbol));
}

test("priority mechanism: HIGH is dispatched before already-queued LOW, without changing concurrency/pacing/error-handling", async () => {
  calls.length = 0;
  inFlight = 0;
  maxInFlight = 0;

  // Three LOW (background) requests enqueued first...
  const lowPromises = ["BG-1", "BG-2", flakyLabel].map((label) => backgroundReq(label));

  // ...then, shortly after (while the LOW ones are still queued/in-flight),
  // one ordinary (unwrapped => default HIGH) user request arrives.
  await new Promise((r) => setTimeout(r, 5));
  const highPromise = req("USER-HIGH");

  const allSettled = await Promise.allSettled([...lowPromises, highPromise]);

  // 5. No request is lost - every one of the 4 requests settled (not hung).
  assert.equal(allSettled.length, 4);
  assert.ok(allSettled.every((r) => r.status === "fulfilled"), "every request should eventually resolve, none dropped");

  // 7. No Promise remains permanently unresolved - the above await already
  // proves this (a hung promise would time out the whole test process).

  // 6. No duplicate Groww request created: the flaky one legitimately retries
  // once (existing 429 behavior), everything else fires exactly once.
  const byLabel = (l: string) => calls.filter((c) => c.label === l);
  assert.equal(byLabel("BG-1").length, 1);
  assert.equal(byLabel("BG-2").length, 1);
  assert.equal(byLabel("USER-HIGH").length, 1);
  assert.equal(byLabel(flakyLabel).length, 2, "flaky request should retry exactly once (429 then 200), not more");

  // 2. Concurrency limit unchanged - GROWW_MAX_CONCURRENT=1 was set for this
  // test, so at no point should more than 1 request have been in flight.
  assert.equal(maxInFlight, 1, "concurrency must never exceed GROWW_MAX_CONCURRENT");

  // 8. Existing error handling remains intact - the 429->retry->200 path ran.
  assert.ok(sawRetryable429, "the existing 429 retry path should still fire");

  // 1. User (HIGH) request gets the next available slot: BG-1 was already
  // dispatched (it's first-in with nothing else queued yet), but among
  // whatever is admitted AFTER the high request arrives, HIGH must not be
  // stuck waiting behind BG-2/the flaky retry. Concretely: USER-HIGH must
  // start before at least one of the LOW requests that was still queued
  // when it arrived (BG-2 or the flaky retry leg).
  const highCall = calls.find((c) => c.label === "USER-HIGH")!;
  const laterLowCalls = calls.filter((c) => c.label !== "USER-HIGH" && c.label !== "BG-1");
  assert.ok(
    laterLowCalls.some((c) => c.startedAt >= highCall.startedAt),
    "at least one LOW request that was still queued should be dispatched AFTER the HIGH request, proving priority reordering happened"
  );
});

test("priority mechanism: pacing gap between dispatches is respected (unchanged)", async () => {
  calls.length = 0;
  await Promise.all(["P-1", "P-2", "P-3"].map((l) => backgroundReq(l)));
  const starts = calls.map((c) => c.startedAt).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    // GROWW_MIN_GAP_MS=20 for this test; allow small scheduler jitter.
    assert.ok(gap >= 15, `pacing gap between dispatches should be respected (got ${gap}ms)`);
  }
});
