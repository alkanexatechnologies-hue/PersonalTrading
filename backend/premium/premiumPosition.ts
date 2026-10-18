// ============================ Where the option PREMIUM sits against its own support / resistance (pure) ============================
// Support / resistance come from the premium's own confirmed swing lows / highs (the Option Terminal's structure engine).
// BELOW SUPPORT = the premium is under its most recent swing low (support broke) — buyers are not in control of this option.
// NEAR RESISTANCE = within 5% (or ½ of its typical 1-bar range) of the next swing high above — little room before sellers.

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
