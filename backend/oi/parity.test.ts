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

import { forwardToSpot } from "./parity";
test("parity uses only the strikes nearest the forward — stale far strikes cannot drag it away", () => {
  // true forward ≈ 13,800: near strikes priced consistently; several far strikes carry stale premiums
  const near = [13700, 13750, 13800, 13850, 13900].map((k) => ({ strike: k, ceLtp: 120 + (13800 - k) / 2, peLtp: 120 - (13800 - k) / 2 }));   // CE − PE = F − K
  const stale = [14300, 14350, 14400, 14450, 14500, 14550, 14600].map((k) => ({ strike: k, ceLtp: 300, peLtp: 20 }));   // nonsense far quotes
  const p = parityUnderlying([...near, ...stale])!;
  assert.ok(Math.abs(p - 13800) < 5, `got ${p}`);
});
test("forward converted to spot with carry; no index price → carry-adjusted parity", () => {
  assert.equal(Math.round(forwardToSpot(55721.75, 14)), Math.round(55721.75 / (1 + 0.065 * 14 / 365)));
  assert.equal(forwardToSpot(100, null), 100);
  const strikes = [55300, 55400, 55500, 55600, 55700].map((k) => ({ strike: k, ceLtp: 400 + (55720 - k) / 2, peLtp: 400 - (55720 - k) / 2 }));   // forward 55,720
  const r = checkedUnderlying(56900, strikes, null, 14);
  assert.equal(r.source, "put-call parity"); assert.ok(r.underlying! < 55720 && r.underlying! > 55500);
});
