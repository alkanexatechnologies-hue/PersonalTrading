import { test } from "node:test";
import assert from "node:assert/strict";
import { parityUnderlying, checkedUnderlying } from "./parity";

// Real after-hours NIFTY chain (Sat 10 Oct 2026): Dhan last_price 23,122.1, premiums price ≈ 22,565.
const chain = [[22850, 15.15, 296.35], [22900, 10.6, 345.35], [22950, 8, 393.2], [23000, 6.2, 442.2], [23050, 4.55, 491], [23100, 3.55, 538.65]]
  .map(([strike, ceLtp, peLtp]) => ({ strike, ceLtp, peLtp }));

test("parity: median of strike + CE − PE", () => {
  const p = parityUnderlying(chain)!;
  assert.ok(Math.abs(p - 22564.4) < 1, String(p));
  assert.equal(parityUnderlying([{ strike: 1, ceLtp: 1, peLtp: 1 }]), null);   // too few strikes
});

test("index price wins when the chain's last_price is off by > 0.4 %", () => {
  const r = checkedUnderlying(23122.1, chain, 22520.45);
  assert.equal(r.source, "index quote"); assert.equal(r.underlying, 22520.45); assert.equal(r.chainSpot, 23122.1);
});

test("chain last_price kept when it agrees with the index", () => {
  const r = checkedUnderlying(22530, chain, 22520.45);
  assert.equal(r.source, "chain"); assert.equal(r.underlying, 22530);
});

test("no index price: parity replaces a wrong chain price", () => {
  const r = checkedUnderlying(23122.1, chain, null);
  assert.equal(r.source, "put-call parity"); assert.ok(Math.abs((r.underlying as number) - 22564.4) < 1);
});
