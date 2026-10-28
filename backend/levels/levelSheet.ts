// ============================ 09:12 KEY LEVEL SHEET — one ranked level list per index per day (owner, 2026-10-28) ============================
// Built once at 09:12 IST (after the 09:08 pre-open price) for NIFTY and SENSEX and shown on every Indian screen, so all
// screens mark the same levels with the same importance. Importance = HOW MANY REASONS AGREE at a price (confluence):
//   ★★★ score ≥ 3 · ★★ score 2 · ★ score 1. One point per source in the zone; +1 extra for last week's high / low, an owner
//   S/R zone with 3+ turns or a flip, and the biggest OI wall on its side.
// It is NOT a forecast: in the 2-year tests every level type held about as often as a coin flip (SUPERVISOR_LOG,
// RESULTS_OI_LEVELS). Information only — no entry, stop, target or plan uses it. Advisory only.

export type LevelSource = "PDH" | "PDL" | "PDC" | "PWH" | "PWL" | "SR" | "CALL WALL" | "PUT WALL";
export interface SheetInputs {
  index: "NIFTY" | "SENSEX"; day: string; builtAt: number; spot: number; step: number;
  prevDay: { day: string; high: number; low: number; close: number } | null;
  prevWeek: { from: string; to: string; high: number; low: number } | null;
  ownerLevels: { price: number; kind: string; label: string }[];
  callWalls: { strike: number; oi: number }[];   // CE OI by strike (any order)
  putWalls: { strike: number; oi: number }[];    // PE OI by strike
  oiAsOf?: string | null;
}
export interface SheetReason { src: LevelSource; price: number; text: string; extra: boolean }
export interface SheetLevel { price: number; lo: number; hi: number; score: number; stars: 1 | 2 | 3; role: "R" | "S"; dist: number; reasons: SheetReason[] }
export interface LevelSheet { index: "NIFTY" | "SENSEX"; day: string; builtAt: number; spot: number; tol: number; levels: SheetLevel[]; oiAsOf: string | null; note: string }

const r2 = (v: number) => Math.round(v * 100) / 100;
const lakh = (v: number) => `${(v / 1e5).toFixed(0)}L`;

/** Zone width: two sources this close are "the same level" (NIFTY ≈ 30 pts, SENSEX ≈ 75 pts). */
export const zoneTol = (spot: number, step: number) => Math.max(spot * 0.001, step * 0.6);

export function buildLevelSheet(I: SheetInputs): LevelSheet {
  const tol = zoneTol(I.spot, I.step), raw: SheetReason[] = [];
  if (I.prevDay) raw.push(
    { src: "PDH", price: I.prevDay.high, text: "yesterday's high", extra: false },
    { src: "PDL", price: I.prevDay.low, text: "yesterday's low", extra: false },
    { src: "PDC", price: I.prevDay.close, text: "yesterday's close", extra: false });
  if (I.prevWeek) raw.push(
    { src: "PWH", price: I.prevWeek.high, text: "last week's high", extra: true },
    { src: "PWL", price: I.prevWeek.low, text: "last week's low", extra: true });
  for (const o of I.ownerLevels) {
    const strong = o.kind === "PA FLIP" || o.kind === "PA 3+ touches";
    raw.push({ src: "SR", price: o.price, text: o.kind === "PA FLIP" ? "S/R flip zone (turned both ways, last 5 days)" : `price turned here ${o.kind === "PA 3+ touches" ? "3+" : "2"} times (last 5 days)`, extra: strong });
  }
  // OI walls: the 2 biggest call-OI strikes at / above spot and put-OI strikes at / below spot (yesterday's close OI at 09:12)
  const ce = I.callWalls.filter((w) => w.oi > 0 && w.strike >= I.spot - I.step).sort((a, b) => b.oi - a.oi).slice(0, 2);
  const pe = I.putWalls.filter((w) => w.oi > 0 && w.strike <= I.spot + I.step).sort((a, b) => b.oi - a.oi).slice(0, 2);
  ce.forEach((w, i) => raw.push({ src: "CALL WALL", price: w.strike, text: `${i ? "2nd biggest" : "biggest"} call OI ${lakh(w.oi)}`, extra: i === 0 }));
  pe.forEach((w, i) => raw.push({ src: "PUT WALL", price: w.strike, text: `${i ? "2nd biggest" : "biggest"} put OI ${lakh(w.oi)}`, extra: i === 0 }));

  // cluster: sorted by price, a source joins the zone when it is within tol of the zone's first price
  const pts = raw.filter((x) => Number.isFinite(x.price) && x.price > 0 && Math.abs(x.price - I.spot) <= I.spot * 0.03).sort((a, b) => a.price - b.price);
  const zones: SheetReason[][] = [];
  for (const x of pts) { const z = zones[zones.length - 1]; if (z && x.price - z[0].price <= tol) z.push(x); else zones.push([x]); }
  const levels: SheetLevel[] = zones.map((z) => {
    const srcs = new Set(z.map((x) => x.src)), score = srcs.size + z.filter((x) => x.extra).length;
    // the zone's price: an OI strike when there is one (the biggest first), else last week's extreme, else the average
    const lead = z.find((x) => x.extra && (x.src === "CALL WALL" || x.src === "PUT WALL")) || z.find((x) => x.src === "CALL WALL" || x.src === "PUT WALL") || z.find((x) => x.src === "PWH" || x.src === "PWL") || null;
    const price = r2(lead ? lead.price : z.reduce((a, x) => a + x.price, 0) / z.length);
    return { price, lo: r2(Math.min(...z.map((x) => x.price))), hi: r2(Math.max(...z.map((x) => x.price))), score, stars: (score >= 3 ? 3 : score === 2 ? 2 : 1) as 1 | 2 | 3,
      role: (price >= I.spot ? "R" : "S") as "R" | "S", dist: r2(price - I.spot), reasons: z.map((x) => ({ ...x, price: r2(x.price) })) };
  }).sort((a, b) => b.price - a.price);
  return { index: I.index, day: I.day, builtAt: I.builtAt, spot: r2(I.spot), tol: r2(tol), levels, oiAsOf: I.oiAsOf ?? null,
    note: "Importance = how many reasons meet at the price. It is not a hold forecast: in 2-year tests every level type held about as often as a coin flip. Watch the reaction at the level." };
}

/** The sheet level that a price shown elsewhere belongs to (within the zone ± tol), or null. */
export function matchLevel(sheet: LevelSheet, price: number): SheetLevel | null {
  let best: SheetLevel | null = null, bd = Infinity;
  for (const l of sheet.levels) { const d = price < l.lo ? l.lo - price : price > l.hi ? price - l.hi : 0; if (d <= sheet.tol && d < bd) { best = l; bd = d; } }
  return best;
}

/** Previous calendar week (Mon–Fri) high / low from daily candles, for `day`. */
export function prevWeekHL(daily: { time: number; high: number; low: number }[], day: string): { from: string; to: string; high: number; low: number } | null {
  const d = new Date(day + "T00:00:00Z"), dow = (d.getUTCDay() + 6) % 7, mon = new Date(d.getTime() - (dow + 7) * 86400_000).toISOString().slice(0, 10), fri = new Date(Date.parse(mon) + 4 * 86400_000).toISOString().slice(0, 10);
  const ist = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10), wk = daily.filter((c) => { const x = ist(c.time); return x >= mon && x <= fri; });
  return wk.length ? { from: ist(wk[0].time), to: ist(wk[wk.length - 1].time), high: Math.max(...wk.map((c) => c.high)), low: Math.min(...wk.map((c) => c.low)) } : null;
}

const STAR = { 3: "★★★", 2: "★★", 1: "★" } as const;
const fmt = (v: number) => Math.round(v).toLocaleString("en-IN");
/** 09:12 Telegram message: ★★★ and ★★ levels per index, nearest first above and below spot (HTML). */
export function levelSheetMsg(sheets: LevelSheet[]): string {
  const out = ["📍 <b>09:12 KEY LEVELS</b> (importance = reasons agreeing, not a forecast)"];
  for (const s of sheets) {
    const major = s.levels.filter((l) => l.stars >= 2), up = major.filter((l) => l.role === "R").sort((a, b) => a.price - b.price).slice(0, 4), dn = major.filter((l) => l.role === "S").sort((a, b) => b.price - a.price).slice(0, 4);
    const line = (l: SheetLevel) => `${STAR[l.stars]} <b>${fmt(l.price)}</b> (${l.dist > 0 ? "+" : ""}${Math.round(l.dist)}) · ${[...new Set(l.reasons.map((x) => x.text))].join(" + ")}`;
    out.push("", `<b>${s.index}</b> · pre-open ${fmt(s.spot)}`, "Resistance ▲", ...(up.length ? up.reverse().map(line) : ["  none ★★ or more within 3 %"]), "Support ▼", ...(dn.length ? dn.map(line) : ["  none ★★ or more within 3 %"]));
  }
  out.push("", "Watch how price reacts AT the level. A level alone is not a trade.");
  return out.join("\n");
}
