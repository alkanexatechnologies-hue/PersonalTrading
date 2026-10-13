// Put-call parity check for an option chain's underlying price.
// For each strike with both premiums, strike + CE − PE ≈ the forward (≈ spot a few days
// before expiry). The median across strikes is robust to a few stale far-OTM prices.
// Used to catch a wrong `last_price` in Dhan's chain (seen after hours: 23,122 reported
// while every strike priced NIFTY at ≈ 22,565), which would shift ATM and the strike window.
export function parityUnderlying(strikes: { strike: number; ceLtp?: number | null; peLtp?: number | null }[]): number | null {
  // Only the 5 strikes nearest the forward (smallest |CE − PE|): far ITM / OTM premiums are often stale and pulled the
  // median 4 % away on MIDCPNIFTY (13 Oct: 14,348 vs the index's 13,762).
  const both = strikes.filter((s) => (s.ceLtp ?? 0) > 0 && (s.peLtp ?? 0) > 0)
    .sort((a, b) => Math.abs((a.ceLtp as number) - (a.peLtp as number)) - Math.abs((b.ceLtp as number) - (b.peLtp as number))).slice(0, 5);
  const v = both.map((s) => s.strike + (s.ceLtp as number) - (s.peLtp as number)).sort((a, b) => a - b);
  if (v.length < 3) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const PARITY_MAX_GAP = 0.004; // 0.4 %: larger gap ⇒ the chain's own underlying is not trusted
// Parity gives the FORWARD (spot + carry to expiry). Converted back to spot with this approximate annual cost of carry
// (only when no index price exists at all) — a 14-day monthly expiry otherwise reads ~0.3 % above spot.
export const CARRY_RATE = 0.065;
export function forwardToSpot(forward: number, daysToExpiry: number | null | undefined): number {
  return daysToExpiry != null && daysToExpiry > 0 ? forward / (1 + CARRY_RATE * daysToExpiry / 365) : forward;
}

// Returns the underlying to use and where it came from. Priority:
//   1. the INDEX's own price (indexSpot) when the chain's last_price disagrees with it by > 0.4 %
//      (after hours even the option premiums can be stale, so parity can be wrong too — seen on SENSEX);
//   2. put-call parity when there is no index price and the chain's last_price disagrees with parity;
//   3. otherwise the chain's own last_price.
export function checkedUnderlying(chainSpot: number | null | undefined, strikes: { strike: number; ceLtp?: number | null; peLtp?: number | null }[], indexSpot?: number | null, daysToExpiry?: number | null): { underlying: number | null; source: "chain" | "index quote" | "put-call parity"; chainSpot: number | null; parity: number | null } {
  const pf = parityUnderlying(strikes);
  const p = pf != null ? forwardToSpot(pf, daysToExpiry) : null;
  const c = chainSpot && chainSpot > 0 ? chainSpot : null;
  const ix = indexSpot && indexSpot > 0 ? indexSpot : null;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const par = p != null ? r2(p) : null;
  if (ix != null) {
    if (c == null || Math.abs(c - ix) / ix > PARITY_MAX_GAP) return { underlying: r2(ix), source: "index quote", chainSpot: c, parity: par };
    return { underlying: c, source: "chain", chainSpot: c, parity: par };
  }
  if (p != null && (c == null || Math.abs(c - p) / p > PARITY_MAX_GAP)) return { underlying: r2(p), source: "put-call parity", chainSpot: c, parity: par };
  return { underlying: c, source: "chain", chainSpot: c, parity: par };
}
