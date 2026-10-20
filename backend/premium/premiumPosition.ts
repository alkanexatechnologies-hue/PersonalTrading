// ============================ Where the option PREMIUM sits against its own support / resistance (pure) ============================
// Support / resistance come from the premium's own confirmed swing lows / highs (the Option Terminal's structure engine).
// BELOW SUPPORT = the premium is under its most recent swing low (support broke) — buyers are not in control of this option.
// NEAR RESISTANCE = within 5% (or ½ of its typical 1-bar range) of the next swing high above — little room before sellers.

import { confirmedSwings } from "./premiumCenter";

export interface PremSwing { kind: "HIGH" | "LOW"; price: number; time: number | null }
const r1 = (v: number) => Math.round(v * 10) / 10;

export function premiumPosition(o: { current: number; swings: PremSwing[]; typicalBar?: number | null }) {
  const cur = o.current; if (!(cur > 0)) return null;
  const lows = o.swings.filter((s) => s.kind === "LOW"), highs = o.swings.filter((s) => s.kind === "HIGH");
  const lastLow = lows[lows.length - 1] ?? null;
  const support = lows.filter((s) => s.price < cur).sort((a, b) => b.price - a.price)[0] ?? null;
  const resistance = highs.filter((s) => s.price > cur).sort((a, b) => a.price - b.price)[0] ?? null;
  const tol = Math.max(cur * 0.05, (o.typicalBar ?? 0) * 0.5);
  const below = lastLow != null && cur < lastLow.price;
  const nearRes = resistance != null && resistance.price - cur <= tol;
  const nearSup = support != null && cur - support.price <= tol;
  const state: "BELOW SUPPORT" | "NEAR RESISTANCE" | "NEAR SUPPORT" | "MID-RANGE" | "NO LEVELS" =
    below ? "BELOW SUPPORT" : nearRes ? "NEAR RESISTANCE" : nearSup ? "NEAR SUPPORT" : support || resistance ? "MID-RANGE" : "NO LEVELS";
  const pct = (a: number) => `${Math.round(((a - cur) / cur) * 100)}%`;
  const text = state === "BELOW SUPPORT" ? `⚠️ BELOW SUPPORT — premium ₹${r1(cur)} is under its swing low ₹${r1(lastLow!.price)} (support broke)`
    : state === "NEAR RESISTANCE" ? `⚠️ NEAR RESISTANCE — premium ₹${r1(cur)}, resistance ₹${r1(resistance!.price)} (+${pct(resistance!.price).replace("-", "")} away)`
    : state === "NEAR SUPPORT" ? `near support ₹${r1(support!.price)} — premium ₹${r1(cur)}${resistance ? ` · resistance ₹${r1(resistance.price)}` : ""}`
    : state === "MID-RANGE" ? `between support ${support ? `₹${r1(support.price)}` : "—"} and resistance ${resistance ? `₹${r1(resistance.price)}` : "—"}`
    : "no premium swing levels yet";
  return { current: r1(cur), support: support ? r1(support.price) : null, resistance: resistance ? r1(resistance.price) : null, brokenSupport: below ? r1(lastLow!.price) : null, state, danger: state === "BELOW SUPPORT" || state === "NEAR RESISTANCE", text };
}
export type PremPos = NonNullable<ReturnType<typeof premiumPosition>>;

// ============================ Premium SUPPORT / RESISTANCE ZONES (hot premiums) ============================
// From the option's own closed 15-min candles (Dhan, last ~5 sessions): confirmed swing lows / highs (2 bars each side) and each
// session's low / high are grouped into zones (points within max(1.5 % of the premium, ½ the typical bar) are one zone; a zone is never wider than twice that).
// A zone below the live premium is SUPPORT, above is RESISTANCE; strength = how many times price turned there.
// Expiry-day caution: premiums decay, so an old zone far above may never be seen again — the touches and the date say how fresh it is.
export interface PremZone { price: number; lo: number; hi: number; touches: number; strength: "STRONG" | "MEDIUM" | "WEAK"; from: string[]; lastDay: string; distPct: number }
export function premiumZones(o: { candles: { time: number; open: number; high: number; low: number; close: number }[]; current: number }) {
  const cs = o.candles, cur = o.current; if (!(cur > 0) || cs.length < 8) return null;
  const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const rng = cs.slice(-20).map((c) => c.high - c.low).sort((a, b) => a - b), typical = rng[Math.floor(rng.length / 2)] || 0;
  const pts: { price: number; from: string; day: string }[] = [];
  for (const s of confirmedSwings(cs as any, 2)) pts.push({ price: s.price, from: s.kind === "HIGH" ? "swing high" : "swing low", day: dayOf(s.time) });
  const days = [...new Set(cs.map((c) => dayOf(c.time)))];
  for (const d of days.slice(0, -1)) {   // completed sessions only — today's own high / low is still forming
    const b = cs.filter((c) => dayOf(c.time) === d); pts.push({ price: Math.max(...b.map((c) => c.high)), from: `${d.slice(5)} high`, day: d }, { price: Math.min(...b.map((c) => c.low)), from: `${d.slice(5)} low`, day: d });
  }
  const tol = Math.max(cur * 0.015, typical * 0.5), zs: { p: typeof pts }[] = [];
  for (const x of [...pts].sort((a, b) => a.price - b.price)) { const z = zs[zs.length - 1]; if (z && x.price - z.p[z.p.length - 1].price <= tol && x.price - z.p[0].price <= 2 * tol) z.p.push(x); else zs.push({ p: [x] }); }
  const zones: PremZone[] = zs.map((z) => {
    const ps = z.p.map((x) => x.price), price = ps.reduce((a, v) => a + v, 0) / ps.length, n = z.p.length;
    return { price: r1(price), lo: r1(Math.min(...ps)), hi: r1(Math.max(...ps)), touches: n, strength: n >= 3 ? "STRONG" : n === 2 ? "MEDIUM" : "WEAK", from: [...new Set(z.p.map((x) => x.from))].slice(0, 3), lastDay: z.p.map((x) => x.day).sort().pop()!, distPct: Math.round(((price - cur) / cur) * 100) };
  });
  const sup = zones.filter((z) => z.price < cur).sort((a, b) => b.price - a.price).slice(0, 2), res = zones.filter((z) => z.price > cur).sort((a, b) => a.price - b.price).slice(0, 2);
  const tolN = Math.max(cur * 0.05, typical * 0.5), s1 = sup[0], r1z = res[0];
  const lastSwingLow = confirmedSwings(cs as any, 2).filter((s) => s.kind === "LOW").pop();
  const state = lastSwingLow && cur < lastSwingLow.price - tol * 0.5 ? "BELOW SUPPORT" : r1z && r1z.price - cur <= tolN ? "NEAR RESISTANCE" : s1 && cur - s1.price <= tolN ? "NEAR SUPPORT" : s1 || r1z ? "MID-RANGE" : "NO LEVELS";
  const roomUp = r1z ? Math.round(((r1z.price - cur) / cur) * 100) : null, roomDn = s1 ? Math.round(((cur - s1.price) / cur) * 100) : null;
  return { current: r1(cur), support: sup, resistance: res, state, danger: state === "BELOW SUPPORT" || state === "NEAR RESISTANCE", typicalBar: r1(typical), roomUpPct: roomUp, roomDownPct: roomDn,
    read: state === "BELOW SUPPORT" ? `premium broke its last swing low ₹${r1(lastSwingLow!.price)} — sellers in control of this option`
      : state === "NEAR RESISTANCE" ? `₹${r1(cur)} is just under resistance ₹${r1z!.price} — wait for a 15-min close above it or a pullback to support`
      : state === "NEAR SUPPORT" ? `₹${r1(cur)} sits on support ₹${s1!.price} (${s1!.touches}×) — the better entry area; below ₹${s1!.lo} it fails`
      : state === "MID-RANGE" ? `mid-range: ${roomDn != null ? `${roomDn}% above support` : "no support below"}, ${roomUp != null ? `${roomUp}% room to resistance` : "no resistance above"}`
      : "no premium swing levels yet" };
}
