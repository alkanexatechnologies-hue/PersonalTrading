// ============================ 🎯 3× POTENTIAL — which premiums have really tripled (2 years of Dhan option data) ============================
// The odds come ONLY from what happened (research/protrader/tripleStudy.ts): the share of strikes whose premium reached 3× (2×)
// of its price at that half hour — (a) the same day before 15:20, (b) by its expiry. Bucketed by side, steps out of the money,
// time of day and expiry day (a) / trading days left (b). The live part only looks the current strikes up, picks the two with
// the best tested chance, and shows the index level the calculator model needs for 3× in the next hour. A study of odds, not a
// signal — most strikes almost never triple; the card says so.
export interface Cell { n: number; hit3: number; hit2: number }
export interface TripleTable { index: string; from: string; to: string; sessions: number; step: number; times: number[]; cells: Record<string, Cell>; expiry?: Record<string, Cell> }
const pct = (c: Cell | null) => (c && c.n ? Math.round((c.hit3 / c.n) * 1000) / 10 : null), pct2 = (c: Cell | null) => (c && c.n ? Math.round((c.hit2 / c.n) * 1000) / 10 : null);
const merge = (xs: (Cell | undefined)[]) => xs.reduce<Cell>((a, x) => (x ? { n: a.n + x.n, hit3: a.hit3 + x.hit3, hit2: a.hit2 + x.hit2 } : a), { n: 0, hit3: 0, hit2: 0 });
export const MIN_N = 30;
/** Same-day odds for a strike now: the exact bucket, else both sides together, else the neighbouring half hours. */
export function sameDayOdds(t: TripleTable, side: "CE" | "PE", otm: number, slot: number, expiryDay: boolean) {
  const e = expiryDay ? "E" : "N", k = (sd: string, T: number) => t.cells[`${sd}|${otm}|${T}|${e}`];
  const i = t.times.indexOf(slot), near = [t.times[i - 1], slot, t.times[i + 1]].filter((x) => x != null) as number[];
  for (const c of [k(side, slot), merge([k("CE", slot), k("PE", slot)]), merge(near.flatMap((T) => [k("CE", T), k("PE", T)]))]) if (c && c.n >= MIN_N) return { p3: pct(c), p2: pct2(c), n: c.n };
  return null;
}
/** By-expiry odds: trading days left (0 = expiry day, capped at 4), decision 09:30 (570) or 12:30 (750). */
export function byExpiryOdds(t: TripleTable, side: "CE" | "PE", otm: number, dte: number, slot: number) {
  if (!t.expiry) return null;
  const T = slot >= 690 ? 750 : 570, d = Math.max(0, Math.min(4, dte)), k = (sd: string) => t.expiry![`${sd}|${otm}|${d}|${T}`];
  for (const c of [k(side), merge([k("CE"), k("PE")])]) if (c && c.n >= MIN_N) return { p3: pct(c), p2: pct2(c), n: c.n };
  return null;
}
/** The half-hour slot (09:30 … 14:30) a minute of the day falls in; before 09:30 → 09:30, after 14:30 → 14:30. */
export function slotOf(t: TripleTable, istMin: number) { return [...t.times].reverse().find((x) => x <= istMin) ?? t.times[0]; }

export interface Cand { side: "CE" | "PE"; strike: number; otm: number; ltp: number; liq: string; spreadPct: number | null; delta: number | null;
  today: { p3: number | null; p2: number | null; n: number } | null; toExpiry: { p3: number | null; p2: number | null; n: number } | null }
/** The two strikes with the best tested chance of 3× (the expiry-day / by-expiry horizon that applies), liquid quotes only;
 *  ties → the higher 2× chance, then the nearer strike (cheaper to be wrong about time decay). */
export function topTwo(c: Cand[], expiryDay: boolean): (Cand & { horizon: "today" | "by expiry"; p3: number; p2: number | null; n: number })[] {
  return c.filter((x) => x.liq !== "POOR" && x.ltp >= 1)
    .map((x) => { const h = expiryDay || !x.toExpiry ? x.today : x.toExpiry; return h && h.p3 != null ? { ...x, horizon: (expiryDay || !x.toExpiry ? "today" : "by expiry") as "today" | "by expiry", p3: h.p3, p2: h.p2, n: h.n } : null; })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.p3 - a.p3 || (b.p2 ?? 0) - (a.p2 ?? 0) || Math.abs(a.otm) - Math.abs(b.otm))
    .filter((x, i, arr) => arr.findIndex((y) => y.strike === x.strike && y.side === x.side) === i).slice(0, 2);
}
