// ============================ 🎖 ProTrader NEXT-DAY MAP — the opening, the first 5 minutes, 09:30 and the day's turn ============================
// Point-wise next-session analysis the way an experienced index trader prepares the night before:
//   1. where the market will probably OPEN (gap odds from ~2 years of real Dhan 1-minute data, by how the last day closed)
//   2. the first 5 minutes: if it rises, how often it falls back to the open / fills the gap; if not, how far it travels
//   3. where it STANDS at 09:30 (vs the previous day's high / close / low and the open) → what that stand did next
//   4. the direction odds from that stand (a bias only when development AND validation agree, else "no edge")
//   5. if it goes UP: the level most likely to give rejection, and how far a rejection usually falls
//   6. if it goes DOWN: the level most likely to give a bounce, and how far a bounce usually rises
// Every probability comes from the study file (research script openingStudy.ts) — nothing is invented. Informational only:
// it never gives, blocks or changes a trade.

/** One session reduced to the numbers the study needs (index points). */
export interface DayFeat {
  day: string; pdc: number; pdh: number; pdl: number; atr: number;
  open: number; p920: number; p930: number; close: number; or15h: number; or15l: number;
  /** min / max between 09:20 and 09:45, and between 09:15 and 10:15 */
  lo2045: number; hi2045: number; lo1015: number; hi1015: number;
  /** after 09:30: day high / low, and the deepest pullback after that high / the highest bounce after that low */
  hiAfter: number; loAfter: number; pullAfterHi: number; bounceAfterLo: number;
}
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);

/** Features of one session from its 1-minute prices ([epoch sec, price], 09:15–15:29) and the previous sessions' ranges. */
export function dayFeatures(day: string, mins: [number, number][], prev: { high: number; low: number; close: number }, prevRanges: number[]): DayFeat | null {
  const m = mins.filter(([t]) => mn(t) >= 555 && mn(t) < 930);
  if (m.length < 300 || mn(m[0][0]) > 557 || prevRanges.length < 5) return null;
  const atr = prevRanges.slice(-14).reduce((a, x) => a + x, 0) / Math.min(14, prevRanges.length);
  const at = (minute: number) => { let v = m[0][1]; for (const [t, p] of m) { if (mn(t) <= minute) v = p; else break; } return v; };
  const rng = (a: number, b: number) => m.filter(([t]) => mn(t) >= a && mn(t) <= b).map((x) => x[1]);
  const or = rng(555, 569), w2045 = rng(560, 585), w1015 = rng(555, 615), after = m.filter(([t]) => mn(t) >= 570);
  if (!or.length || !w2045.length || !after.length) return null;
  let hiAfter = -Infinity, hiAt = 0, loAfter = Infinity, loAt = 0;
  after.forEach(([, p], i) => { if (p > hiAfter) { hiAfter = p; hiAt = i; } if (p < loAfter) { loAfter = p; loAt = i; } });
  const tailAfterHi = after.slice(hiAt).map((x) => x[1]), tailAfterLo = after.slice(loAt).map((x) => x[1]);
  return { day, pdc: prev.close, pdh: prev.high, pdl: prev.low, atr, open: m[0][1], p920: at(559), p930: at(569), close: m[m.length - 1][1],
    or15h: Math.max(...or), or15l: Math.min(...or), lo2045: Math.min(...w2045), hi2045: Math.max(...w2045), lo1015: Math.min(...w1015), hi1015: Math.max(...w1015),
    hiAfter, loAfter, pullAfterHi: hiAfter - Math.min(...tailAfterHi), bounceAfterLo: Math.max(...tailAfterLo) - loAfter };
}

/** Features of one session from Dhan's 5-MIN candles (true OHLC: the 09:15 candle's open is NSE's official open, highs / lows
 *  include every tick) and the OFFICIAL previous day (Dhan daily: high / low / close; the close is NSE's closing price). The
 *  1-minute research series stores one price per minute, so its "open" was ~27 pts off the official open (median, 2 years) —
 *  this is the source the opening study uses. */
export function dayFeatures5m(day: string, bars: { time: number; open: number; high: number; low: number; close: number }[], prev: { high: number; low: number; close: number }, prevRanges: number[], officialClose?: number | null): DayFeat | null {
  const b = bars.filter((x) => mn(x.time) >= 555 && mn(x.time) < 930).sort((p, q) => p.time - q.time);
  if (b.length < 60 || mn(b[0].time) !== 555 || prevRanges.length < 5) return null;
  const atr = prevRanges.slice(-14).reduce((a, x) => a + x, 0) / Math.min(14, prevRanges.length);
  const at = (m: number) => b.find((x) => mn(x.time) === m) ?? null, win = (a: number, z: number) => b.filter((x) => mn(x.time) >= a && mn(x.time) <= z);
  const c915 = at(555), c925 = at(565), or = win(555, 565), w2045 = win(560, 580), w1015 = win(555, 610), after = b.filter((x) => mn(x.time) >= 570);
  if (!c915 || !c925 || or.length < 3 || !w2045.length || !after.length) return null;
  let hiAfter = -Infinity, hiAt = 0, loAfter = Infinity, loAt = 0;
  after.forEach((x, i) => { if (x.high > hiAfter) { hiAfter = x.high; hiAt = i; } if (x.low < loAfter) { loAfter = x.low; loAt = i; } });
  const tailLo = after.slice(hiAt + 1).map((x) => x.low), tailHi = after.slice(loAt + 1).map((x) => x.high);
  return { day, pdc: prev.close, pdh: prev.high, pdl: prev.low, atr, open: c915.open, p920: c915.close, p930: c925.close, close: officialClose ?? b[b.length - 1].close,
    or15h: Math.max(...or.map((x) => x.high)), or15l: Math.min(...or.map((x) => x.low)), lo2045: Math.min(...w2045.map((x) => x.low)), hi2045: Math.max(...w2045.map((x) => x.high)),
    lo1015: Math.min(...w1015.map((x) => x.low)), hi1015: Math.max(...w1015.map((x) => x.high)), hiAfter, loAfter,
    pullAfterHi: tailLo.length ? hiAfter - Math.min(...tailLo) : 0, bounceAfterLo: tailHi.length ? Math.max(...tailHi) - loAfter : 0 };
}

// ---------------------------------------------------------------- buckets
export const GAP_BUCKETS = [
  { key: "BIG GAP DOWN", lo: -Infinity, hi: -0.5 }, { key: "GAP DOWN", lo: -0.5, hi: -0.15 }, { key: "FLAT", lo: -0.15, hi: 0.15 },
  { key: "GAP UP", lo: 0.15, hi: 0.5 }, { key: "BIG GAP UP", lo: 0.5, hi: Infinity },
] as const;
export type GapKey = (typeof GAP_BUCKETS)[number]["key"];
export const gapBucket = (gapAtr: number): GapKey => GAP_BUCKETS.find((b) => gapAtr >= b.lo && gapAtr < b.hi)!.key;
export const gapGroup = (g: GapKey) => (g.includes("UP") ? "UP" : g.includes("DOWN") ? "DOWN" : "FLAT");
/** Where the last day closed inside its own range: WEAK (bottom third), MID, STRONG (top third). */
export const closeLoc = (c: number, h: number, l: number) => { const x = h > l ? (c - l) / (h - l) : 0.5; return x < 1 / 3 ? "WEAK" : x > 2 / 3 ? "STRONG" : "MID"; };
/** The first 5 minutes: UP / DOWN when the 09:20 price is 0.03·ATR or more from the open, else FLAT. */
export const first5 = (f: DayFeat) => { const x = (f.p920 - f.open) / f.atr; return x >= 0.03 ? "UP" : x <= -0.03 ? "DOWN" : "FLAT"; };
/** Where the 09:30 price stands vs the previous day's high / close / low. */
export const standZone = (p: number, pdh: number, pdc: number, pdl: number) => (p > pdh ? "ABOVE PDH" : p >= pdc ? "PDC–PDH" : p >= pdl ? "PDL–PDC" : "BELOW PDL");

// ---------------------------------------------------------------- opening GAP scenarios (7 groups by gap size in daily ATR)
export const GAP7 = [
  { key: "BIG GAP DOWN", lo: -Infinity, hi: -0.7 }, { key: "GAP DOWN", lo: -0.7, hi: -0.35 }, { key: "SMALL GAP DOWN", lo: -0.35, hi: -0.15 }, { key: "FLAT", lo: -0.15, hi: 0.15 },
  { key: "SMALL GAP UP", lo: 0.15, hi: 0.35 }, { key: "GAP UP", lo: 0.35, hi: 0.7 }, { key: "BIG GAP UP", lo: 0.7, hi: Infinity },
] as const;
export const gap7 = (gapAtr: number) => GAP7.find((b) => gapAtr >= b.lo && gapAtr < b.hi)!.key;
export interface GapStat { n: number; fill1015: number; fillClose: number; cont25: number; cont50: number; contMed: number; againstMed: number; closeWithGap: number;
  holds930: { n: number; contPct: number; cont50: number }; against930: { n: number; fillPct: number; closeAgainst: number } }
/** What the day did after each kind of opening gap. "With the gap" = further in the gap's direction (down for a gap down);
 *  fill = touched the previous close; the 09:30 split: still beyond the open in the gap direction (holds) or back across it. */
export function gapStats(feats: DayFeat[]): Record<string, GapStat> {
  const out: Record<string, GapStat> = {}, P = (a: number, n: number) => (n ? Math.round((a / n) * 100) : 0);
  for (const g of GAP7) {
    const xs = feats.filter((f) => gap7((f.open - f.pdc) / f.atr) === g.key), n = xs.length; if (!n) continue;
    const dn = g.key.includes("DOWN"), up = g.key.includes("UP"), dir = dn ? -1 : up ? 1 : 0;
    const lo = (f: DayFeat) => Math.min(f.or15l, f.lo1015, f.loAfter), hi = (f: DayFeat) => Math.max(f.or15h, f.hi1015, f.hiAfter);
    const cont = (f: DayFeat) => (dir < 0 ? f.open - lo(f) : dir > 0 ? hi(f) - f.open : Math.max(f.open - lo(f), hi(f) - f.open)) / f.atr;
    const ag = (f: DayFeat) => (dir < 0 ? hi(f) - f.open : dir > 0 ? f.open - lo(f) : 0) / f.atr;
    const filled = (f: DayFeat, until: "1015" | "close") => (dir < 0 ? (until === "1015" ? f.hi1015 : hi(f)) >= f.pdc : dir > 0 ? (until === "1015" ? f.lo1015 : lo(f)) <= f.pdc : true);
    const holds = xs.filter((f) => (dir < 0 ? f.p930 < f.open : dir > 0 ? f.p930 > f.open : false)), back = xs.filter((f) => !holds.includes(f) && f.p930 !== f.open);
    const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)] * 100) / 100 : 0; };
    out[g.key] = { n, fill1015: P(xs.filter((f) => filled(f, "1015")).length, n), fillClose: P(xs.filter((f) => filled(f, "close")).length, n),
      cont25: P(xs.filter((f) => cont(f) >= 0.25).length, n), cont50: P(xs.filter((f) => cont(f) >= 0.5).length, n), contMed: med(xs.map(cont)), againstMed: med(xs.map(ag)),
      closeWithGap: P(xs.filter((f) => (dir < 0 ? f.close < f.open : dir > 0 ? f.close > f.open : false)).length, n),
      holds930: { n: holds.length, contPct: P(holds.filter((f) => (dir < 0 ? f.close < f.p930 : f.close > f.p930)).length, holds.length), cont50: P(holds.filter((f) => cont(f) >= 0.5).length, holds.length) },
      against930: { n: back.length, fillPct: P(back.filter((f) => filled(f, "close")).length, back.length), closeAgainst: P(back.filter((f) => (dir < 0 ? f.close > f.p930 : f.close < f.p930)).length, back.length) } };
  }
  return out;
}

// ---------------------------------------------------------------- aggregation (the study)
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 100) : null);
const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return r2(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]); };
export interface Study {
  index: string; from: string; to: string; days: number; generatedAt: string;
  gap: Record<string, { n: number; dist: Record<GapKey, number | null>; abovePdh: number | null; belowPdl: number | null; medGapAtr: number | null }>;
  first5: Record<string, { n: number; fallBackPct: number | null; gapFillPct: number | null; heldTravelMed: number | null; heldTravelP75: number | null; fellBackDepthMed: number | null }>;
  stand: Record<string, { n: number; upClosePct: number | null; devUp: number | null; valUp: number | null; medMoveAtr: number | null; upExtMed: number | null; upExtP75: number | null; dnExtMed: number | null; dnExtP75: number | null; newHighPct: number | null; newLowPct: number | null }>;
  turn: Record<string, { n: number; pullMed: number | null; pullP75: number | null; bounceMed: number | null; bounceP75: number | null }>;
}
/** All the odds from a list of sessions (in date order). Extensions / travel / pullbacks are in ATR units. */
export function study(index: string, feats: DayFeat[]): Study {
  const cut = Math.floor((feats.length * 2) / 3), out: Study = { index, from: feats[0]?.day ?? "", to: feats[feats.length - 1]?.day ?? "", days: feats.length, generatedAt: new Date().toISOString(), gap: {}, first5: {}, stand: {}, turn: {} };
  // 1. gap odds by how the last day closed (and ALL)
  for (const loc of ["ALL", "WEAK", "MID", "STRONG"]) {
    const xs = feats.filter((f) => loc === "ALL" || closeLoc(f.pdc, f.pdh, f.pdl) === loc), n = xs.length, g = xs.map((f) => (f.open - f.pdc) / f.atr);
    out.gap[loc] = { n, dist: Object.fromEntries(GAP_BUCKETS.map((b) => [b.key, pct(g.filter((x) => gapBucket(x) === b.key).length, n)])) as any,
      abovePdh: pct(xs.filter((f) => f.open > f.pdh).length, n), belowPdl: pct(xs.filter((f) => f.open < f.pdl).length, n), medGapAtr: q(g, 0.5) };
  }
  // 2. first 5 minutes, by gap group × first-5 direction (and by first-5 direction alone as the fallback)
  for (const gg of ["ALL", "UP", "FLAT", "DOWN"]) for (const d5 of ["UP", "DOWN"]) {
    const xs = feats.filter((f) => (gg === "ALL" || gapGroup(gapBucket((f.open - f.pdc) / f.atr)) === gg) && first5(f) === d5), n = xs.length, up = d5 === "UP";
    const fell = xs.filter((f) => (up ? f.lo2045 < f.open : f.hi2045 > f.open)), held = xs.filter((f) => !fell.includes(f));
    const gapped = xs.filter((f) => gg !== "FLAT" && Math.abs(f.open - f.pdc) >= 0.15 * f.atr);   // a real gap that can be "filled" back to the previous close
    out.first5[`${gg}|${d5}`] = { n, fallBackPct: pct(fell.length, n),
      gapFillPct: gapped.length >= 10 ? pct(gapped.filter((f) => (f.open > f.pdc ? f.lo1015 <= f.pdc : f.hi1015 >= f.pdc)).length, gapped.length) : null,
      heldTravelMed: q(held.map((f) => (up ? f.hi1015 - f.open : f.open - f.lo1015) / f.atr), 0.5), heldTravelP75: q(held.map((f) => (up ? f.hi1015 - f.open : f.open - f.lo1015) / f.atr), 0.75),
      fellBackDepthMed: q(fell.map((f) => (up ? f.open - f.lo1015 : f.hi1015 - f.open) / f.atr), 0.5) };
  }
  // 3–4. the 09:30 stand → the rest of the day (dev = first ⅔, val = last ⅓ for the stability check)
  const zoneOf = (f: DayFeat) => standZone(f.p930, f.pdh, f.pdc, f.pdl), sideOf = (f: DayFeat) => (f.p930 >= f.open ? "above open" : "below open");
  const keys = ["ABOVE PDH", "PDC–PDH", "PDL–PDC", "BELOW PDL"].flatMap((z) => [z, `${z}|above open`, `${z}|below open`]);
  for (const k of keys) {
    const [z, s] = k.split("|"), pick = (arr: DayFeat[]) => arr.filter((f) => zoneOf(f) === z && (!s || sideOf(f) === s));
    const xs = pick(feats), n = xs.length, dev = pick(feats.slice(0, cut)), val = pick(feats.slice(cut));
    const upPct = (a: DayFeat[]) => (a.length >= 15 ? pct(a.filter((f) => f.close > f.p930).length, a.length) : null);
    out.stand[k] = { n, upClosePct: pct(xs.filter((f) => f.close > f.p930).length, n), devUp: upPct(dev), valUp: upPct(val), medMoveAtr: q(xs.map((f) => (f.close - f.p930) / f.atr), 0.5),
      upExtMed: q(xs.map((f) => (f.hiAfter - f.p930) / f.atr), 0.5), upExtP75: q(xs.map((f) => (f.hiAfter - f.p930) / f.atr), 0.75),
      dnExtMed: q(xs.map((f) => (f.p930 - f.loAfter) / f.atr), 0.5), dnExtP75: q(xs.map((f) => (f.p930 - f.loAfter) / f.atr), 0.75),
      newHighPct: pct(xs.filter((f) => f.hiAfter > f.or15h).length, n), newLowPct: pct(xs.filter((f) => f.loAfter < f.or15l).length, n) };
  }
  // 5–6. how far the day turns back from its post-09:30 high / low
  for (const z of ["ALL", "ABOVE PDH", "PDC–PDH", "PDL–PDC", "BELOW PDL"]) {
    const xs = feats.filter((f) => z === "ALL" || zoneOf(f) === z);
    out.turn[z] = { n: xs.length, pullMed: q(xs.map((f) => f.pullAfterHi / f.atr), 0.5), pullP75: q(xs.map((f) => f.pullAfterHi / f.atr), 0.75), bounceMed: q(xs.map((f) => f.bounceAfterLo / f.atr), 0.5), bounceP75: q(xs.map((f) => f.bounceAfterLo / f.atr), 0.75) };
  }
  (out as any).gapDay = gapStats(feats);
  return out;
}

// ---------------------------------------------------------------- the map for the next (or current) session
export interface MapLevel { price: number; label: string; kind: string; holdPct?: number | null; tests?: number }
export interface MapIn {
  index: string; planFor: string; study: Study;
  pdh: number; pdl: number; pdc: number; atr: number;
  levels: MapLevel[];
  /** what has already happened in this session (live), when it has */
  seen?: { open?: number | null; p920?: number | null; p930?: number | null; or15h?: number | null; or15l?: number | null } | null;
  gift?: { implied: number; at: string } | null;
}
export interface MapPoint { n: number; title: string; lines: string[]; live?: boolean }
const nf = (v: number) => Math.round(v).toLocaleString("en-IN");
/** The nearest level to a price (within 0.25·ATR), for naming targets. */
function nameAt(levels: MapLevel[], price: number, atr: number) {
  const L = levels.filter((l) => Math.abs(l.price - price) <= 0.25 * atr).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  return L ? `${L.label} ${nf(L.price)}` : `~${nf(price)}`;
}
/** The level inside [a, b] most likely to turn price (best level-memory hold %, then most tests, then nearest a). */
function turnLevel(levels: MapLevel[], a: number, b: number) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return levels.filter((l) => l.price >= lo && l.price <= hi).sort((x, y) => (y.holdPct ?? -1) - (x.holdPct ?? -1) || (y.tests ?? 0) - (x.tests ?? 0) || Math.abs(x.price - a) - Math.abs(y.price - a))[0] ?? null;
}
const held = (l: MapLevel) => (l.holdPct != null && l.tests ? ` — held ${l.holdPct}% of ${l.tests} past tests${l.tests < 8 ? " (small sample)" : ""}` : "");
/** A weak first level (held < 50 %) is named as such, with the strongest level just beyond it (the next 3 in that direction). */
const weakNote = (l: MapLevel, beyond: MapLevel[], up: boolean) => {
  if (l.holdPct == null || l.holdPct >= 50 || (l.tests ?? 0) < 5) return [];
  const strong = beyond.filter((x) => (x.holdPct ?? 0) >= 50 && (x.tests ?? 0) >= 8).sort((a, b) => (b.holdPct ?? 0) - (a.holdPct ?? 0))[0];
  return [`⚠️ ${l.label} ${nf(l.price)} is a WEAK level (usually breaks)${strong ? ` — the stronger ${up ? "rejection" : "support"} is ${strong.label} ${nf(strong.price)} (held ${strong.holdPct}% of ${strong.tests})` : ""}`];
};

export function nextDayMap(o: MapIn): { points: MapPoint[]; basis: string; reference: number } {
  const S = o.study, A = o.atr, P: MapPoint[] = [], seen = o.seen || {};
  const loc = closeLoc(o.pdc, o.pdh, o.pdl), g = S.gap[loc]?.n >= 60 ? S.gap[loc] : S.gap.ALL, gName = S.gap[loc]?.n >= 60 ? `after a ${loc} close` : "all sessions";
  // 1. the opening
  const ranges = GAP_BUCKETS.map((b) => ({ key: b.key, p: g.dist[b.key] ?? 0, from: Number.isFinite(b.lo) ? o.pdc + b.lo * A : null, to: Number.isFinite(b.hi) ? o.pdc + b.hi * A : null }));
  const best = [...ranges].sort((a, b) => b.p - a.p)[0];
  const rng = (r: typeof ranges[number]) => (r.from == null ? `below ${nf(r.to!)}` : r.to == null ? `above ${nf(r.from)}` : `${nf(r.from)}–${nf(r.to)}`);
  const open = seen.open ?? null, gapK = open != null ? gapBucket((open - o.pdc) / A) : best.key;
  P.push({ n: 1, title: "Where it will probably OPEN", live: open != null, lines: [
    ...(open != null ? [`<b>Opened ${nf(open)} → ${gapK}</b> (${open >= o.pdc ? "+" : ""}${nf(open - o.pdc)} pts vs the previous close ${nf(o.pdc)})`] : []),
    `Most likely: <b>${best.key} ${rng(best)} — ${best.p}%</b> (${gName}, ${g.n} sessions)`,
    ranges.filter((r) => r !== best).map((r) => `${r.key} ${rng(r)} ${r.p}%`).join(" · "),
    `Opens above the previous high ${nf(o.pdh)}: ${g.abovePdh}% · below the previous low ${nf(o.pdl)}: ${g.belowPdl}%`,
    ...(o.gift && open == null ? [`GIFT Nifty now implies ~${nf(o.gift.implied)} (${o.gift.at}) → ${gapBucket((o.gift.implied - o.pdc) / A)}`] : []),
  ] });
  // 2. the first 5 minutes
  const gg = gapGroup(gapK), ref = open ?? (best.from != null && best.to != null ? (best.from + best.to) / 2 : o.pdc);
  const f5 = (d: "UP" | "DOWN") => { const s = S.first5[`${gg}|${d}`]; return s && s.n >= 30 ? { s, base: `${gg === "FLAT" ? "flat" : "gap-" + gg.toLowerCase()} opens` } : { s: S.first5[`ALL|${d}`], base: "all opens" }; };
  const up5 = f5("UP"), dn5 = f5("DOWN"), d5Seen = seen.p920 != null && open != null ? ((seen.p920 - open) / A >= 0.03 ? "UP" : (seen.p920 - open) / A <= -0.03 ? "DOWN" : "FLAT") : null;
  const f5line = (d: "UP" | "DOWN", x: ReturnType<typeof f5>) => {
    const u = d === "UP", s = x.s, sgn = u ? 1 : -1;
    return [`<b>If the first 5 min ${u ? "RISE" : "FALL"}</b> (${x.base}, ${s.n}): falls back ${u ? "below" : "above"} the open by 09:45 in <b>${s.fallBackPct}%</b>${s.gapFillPct != null && gg !== "FLAT" ? ` · fills the gap back to ${nf(o.pdc)} by 10:15 in ${s.gapFillPct}%` : ""}`,
      `  if it does NOT fall back: travels <b>${u ? "+" : "−"}${nf((s.heldTravelMed ?? 0) * A)} pts</b> typical → ${nameAt(o.levels, ref + sgn * (s.heldTravelMed ?? 0) * A, A)} · strong day ${u ? "+" : "−"}${nf((s.heldTravelP75 ?? 0) * A)} → ${nameAt(o.levels, ref + sgn * (s.heldTravelP75 ?? 0) * A, A)} (by 10:15)`,
      `  if it falls back: usually ${nf((s.fellBackDepthMed ?? 0) * A)} pts past the open → ${nameAt(o.levels, ref - sgn * (s.fellBackDepthMed ?? 0) * A, A)}`];
  };
  P.push({ n: 2, title: "The first 5 minutes (09:15–09:20)", live: d5Seen != null, lines: [
    ...(d5Seen ? [`<b>First 5 min: ${d5Seen}</b> (${nf(open!)} → ${nf(seen.p920!)})`] : []),
    ...(d5Seen !== "DOWN" ? f5line("UP", up5) : []), ...(d5Seen !== "UP" ? f5line("DOWN", dn5) : []),
  ] });
  // 3–4. the 09:30 stand and the direction
  const p930 = seen.p930 ?? null, standRow = (z: string) => { const s = S.stand[z], at = z === "ABOVE PDH" ? `above ${nf(o.pdh)}` : z === "PDC–PDH" ? `${nf(o.pdc)}–${nf(o.pdh)}` : z === "PDL–PDC" ? `${nf(o.pdl)}–${nf(o.pdc)}` : `below ${nf(o.pdl)}`; return s && s.n ? `${z} (${at}): rest of day closed higher ${s.upClosePct}% · typical ${s.medMoveAtr! >= 0 ? "+" : ""}${nf(s.medMoveAtr! * A)} pts · ${s.n} sessions` : null; };
  const verdict = (s: Study["stand"][string]) => {
    if (!s || s.n < 40 || s.devUp == null || s.valUp == null) return { dir: "NO EDGE", why: "too few sessions to call it" };
    if (s.devUp >= 56 && s.valUp >= 56) return { dir: "UP", why: `closed higher ${s.upClosePct}% (dev ${s.devUp}% / val ${s.valUp}%)` };
    if (s.devUp <= 44 && s.valUp <= 44) return { dir: "DOWN", why: `closed lower ${100 - s.upClosePct!}% (dev ${100 - s.devUp}% / val ${100 - s.valUp}%)` };
    return { dir: "NO EDGE", why: `closed higher ${s.upClosePct}% — dev ${s.devUp}% vs val ${s.valUp}%: a coin flip, not a bias` };
  };
  let zKey: string | null = null;
  if (p930 != null && open != null) zKey = `${standZone(p930, o.pdh, o.pdc, o.pdl)}|${p930 >= open ? "above open" : "below open"}`;
  P.push({ n: 3, title: "Where it stands at 09:30 — and what that stand did next", live: p930 != null, lines: p930 != null && zKey ? (() => {
    const s = S.stand[zKey] ?? S.stand[zKey.split("|")[0]];
    return [`<b>09:30: ${nf(p930)} → ${zKey.replace("|", ", ")}</b> (${s.n} past sessions)`,
      `Rest of day from here: closed higher ${s.upClosePct}% · typical close ${s.medMoveAtr! >= 0 ? "+" : ""}${nf(s.medMoveAtr! * A)} pts · made a new high above the 09:15–09:30 range ${s.newHighPct}% · new low ${s.newLowPct}%`];
  })() : ["ABOVE PDH", "PDC–PDH", "PDL–PDC", "BELOW PDL"].map(standRow).filter(Boolean) as string[] });
  const sNow = zKey ? S.stand[zKey] ?? S.stand[zKey.split("|")[0]] : null, v = sNow ? verdict(sNow) : null;
  const likelyZone = standZone(ref, o.pdh, o.pdc, o.pdl), vPre = verdict(S.stand[likelyZone]);
  P.push({ n: 4, title: "Direction from the 09:30 stand", live: !!v, lines: v
    ? [`<b>${v.dir === "NO EDGE" ? "NO EDGE — trade only the levels, not a direction" : v.dir + " bias"}</b>: ${v.why}`]
    : [`If it stands ${likelyZone} at 09:30 (the likely open area): <b>${vPre.dir === "NO EDGE" ? "NO EDGE" : vPre.dir + " bias"}</b> — ${vPre.why}`, "The real read comes at 09:30 — this point updates live after the open."] });
  // 5–6. rejection above / bounce below
  const base = p930 ?? ref, sz = S.stand[zKey ?? likelyZone] ?? S.stand[likelyZone], tz = S.turn[standZone(base, o.pdh, o.pdc, o.pdl)]?.n >= 40 ? S.turn[standZone(base, o.pdh, o.pdc, o.pdl)] : S.turn.ALL;
  const above = o.levels.filter((l) => l.price > base), below = o.levels.filter((l) => l.price < base);
  const upA = base + (sz?.upExtMed ?? 0.4) * A * 0.5, upB = base + (sz?.upExtP75 ?? 0.8) * A, dnA = base - (sz?.dnExtMed ?? 0.4) * A * 0.5, dnB = base - (sz?.dnExtP75 ?? 0.8) * A;
  const rej = turnLevel(above, upA, upB) ?? above.sort((a, b) => a.price - b.price)[0] ?? null, bnc = turnLevel(below, dnA, dnB) ?? below.sort((a, b) => b.price - a.price)[0] ?? null;
  P.push({ n: 5, title: "If it goes UP — where rejection is most likely", lines: rej ? [
    `<b>Rejection zone: ${rej.label} ${nf(rej.price)}</b>${held(rej)}`,
    ...weakNote(rej, above.filter((l) => l.price > rej.price).sort((a, b) => a.price - b.price).slice(0, 3), true),
    `Typical rise after 09:30 from this stand: +${nf((sz?.upExtMed ?? 0) * A)} pts (strong day +${nf((sz?.upExtP75 ?? 0) * A)}) → ${nameAt(o.levels, base + (sz?.upExtMed ?? 0) * A, A)}`,
    `<b>If rejected there: falls ${nf((tz.pullMed ?? 0) * A)} pts typical → ${nameAt(o.levels, rej.price - (tz.pullMed ?? 0) * A, A)}</b> (deep: ${nf((tz.pullP75 ?? 0) * A)} → ${nameAt(o.levels, rej.price - (tz.pullP75 ?? 0) * A, A)})`,
    `Above it: ${above.filter((l) => l !== rej).sort((a, b) => a.price - b.price).slice(0, 3).map((l) => `${l.label} ${nf(l.price)}`).join(" · ") || "—"}`,
  ] : ["No level above in the ladder."] });
  P.push({ n: 6, title: "If it goes DOWN — where the bounce is most likely", lines: bnc ? [
    `<b>Support zone: ${bnc.label} ${nf(bnc.price)}</b>${held(bnc)}`,
    ...weakNote(bnc, below.filter((l) => l.price < bnc.price).sort((a, b) => b.price - a.price).slice(0, 3), false),
    `Typical fall after 09:30 from this stand: −${nf((sz?.dnExtMed ?? 0) * A)} pts (weak day −${nf((sz?.dnExtP75 ?? 0) * A)}) → ${nameAt(o.levels, base - (sz?.dnExtMed ?? 0) * A, A)}`,
    `<b>If it bounces there: rises ${nf((tz.bounceMed ?? 0) * A)} pts typical → ${nameAt(o.levels, bnc.price + (tz.bounceMed ?? 0) * A, A)}</b> (strong: ${nf((tz.bounceP75 ?? 0) * A)} → ${nameAt(o.levels, bnc.price + (tz.bounceP75 ?? 0) * A, A)})`,
    `Below it: ${below.filter((l) => l !== bnc).sort((a, b) => b.price - a.price).slice(0, 3).map((l) => `${l.label} ${nf(l.price)}`).join(" · ") || "—"}`,
  ] : ["No level below in the ladder."] });
  return { points: P, reference: r1(base), basis: `${S.index} · ${S.days} sessions of ${(S as any).source || "Dhan data"} (${S.from} → ${S.to}) · daily ATR ${nf(A)} pts · probabilities are history, not a promise; most are close to a coin flip` };
}
