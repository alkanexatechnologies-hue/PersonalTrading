import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";
import { CRUDE_THRESHOLD_INR } from "./marketInputs";
import { giftOvernightFrom } from "./dhanMarketExtras";

// ============================ Historical similar scenarios ============================
// Past sessions whose 09:25 picture resembled today's, and what NIFTY actually did next.
// Features use ONLY what was knowable at 09:25 IST on that day (no look-ahead):
//   gap (09:15 open vs previous official close) · first two 5-min candles (09:15, 09:20) ·
//   IT and bank heavyweights' weighted move at the 09:20 bar close · MCX crude's last close before
//   the day (vs the ₹ rule) · GIFT NIFTY's overnight move (global hours) · India VIX at the open vs
//   previous close · FII index-futures net change from the previous session's NSE file.
// All market data from Dhan (FII from NSE's official files); no Yahoo.
// Outcomes are measured from the 09:20-bar close (09:25) to 09:40 / 09:55 / 10:25, plus the
// maximum favourable / adverse excursion up to 10:25. Similarity = share of the conditions that
// match; it is NOT a probability. News, OI and option premiums have no history and are excluded.

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface Features {
  gapPct: number | null; first2: string | null; move925Pct: number | null;
  itPct: number | null; bankPct: number | null; crude: number | null; giftNightPct: number | null; vixPct: number | null; fiiNet: number | null;
}
export interface Outcome { ref: number; m15: number | null; m30: number | null; m60: number | null; maxUp: number | null; maxDown: number | null }
export interface DayRow { date: string; features: Features; outcome: Outcome | null }

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istHm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Previous trading day's last bar close (the index's 15:25 bar carries the official close). */
function prevClose(bars: Bar[], d: string): number | null {
  const prev = bars.filter((b) => istDay(b.time) < d); return prev.length ? prev[prev.length - 1].close : null;
}
function barAt(bars: Bar[], d: string, hm: string): Bar | null { return bars.find((b) => istDay(b.time) === d && istHm(b.time) === hm) || null; }

/** Weighted % move of a stock group at the 09:20 bar close vs each stock's previous close. */
export function groupMove(stocks: Record<string, Bar[]>, coefs: Record<string, number>, d: string): number | null {
  let w = 0, s = 0;
  for (const [sym, bars] of Object.entries(stocks)) {
    const pc = prevClose(bars, d), b = barAt(bars, d, "09:20"), c = coefs[sym] || 0;
    if (pc && b && c > 0) { s += c * (b.close / pc - 1) * 100; w += c; }
  }
  return w ? r2(s / w) : null;
}
/** Last value strictly before day d from a dated daily series ([yyyy-mm-dd, close]). */
export function lastBefore(series: [string, number][], d: string): { date: string; value: number; prev: number | null } | null {
  const i = series.findIndex((x) => x[0] >= d); const k = (i < 0 ? series.length : i) - 1;
  return k >= 0 ? { date: series[k][0], value: series[k][1], prev: k > 0 ? series[k - 1][1] : null } : null;
}

export interface History { nifty5: Bar[]; gift5: Bar[]; it: Record<string, Bar[]>; bank: Record<string, Bar[]>; coefs: Record<string, number>; crude: [string, number][]; vix: { date: string; open: number; prevClose: number | null }[]; fii: Record<string, number> }

/** GIFT NIFTY overnight move for day d (same rule as the live input). */
export function giftNight(gift5: Bar[], d: string): number | null { const g = giftOvernightFrom(gift5, d); return g ? g.nightPct : null; }
/** Features knowable at 09:25 of day d. */
export function featuresFor(h: History, d: string): Features {
  const pc = prevClose(h.nifty5, d), b1 = barAt(h.nifty5, d, "09:15"), b2 = barAt(h.nifty5, d, "09:20");
  const crude = lastBefore(h.crude, d), gn = giftNight(h.gift5, d);
  const vix = h.vix.find((v) => v.date === d);
  const prevDays = Object.keys(h.fii).filter((x) => x < d).sort();
  return {
    gapPct: pc && b1 ? r2((b1.open / pc - 1) * 100) : null,
    first2: b1 && b2 ? `${b1.close >= b1.open ? "G" : "R"}${b2.close >= b2.open ? "G" : "R"}` : null,
    move925Pct: b1 && b2 ? r2((b2.close / b1.open - 1) * 100) : null,
    itPct: groupMove(h.it, h.coefs, d), bankPct: groupMove(h.bank, h.coefs, d),
    crude: crude ? crude.value : null,
    giftNightPct: gn,
    vixPct: vix && vix.prevClose ? r2((vix.open / vix.prevClose - 1) * 100) : null,
    fiiNet: prevDays.length ? h.fii[prevDays[prevDays.length - 1]] : null,
  };
}
/** What NIFTY did after 09:25 (09:20-bar close) — only for historical days, never for today. */
export function outcomeFor(nifty5: Bar[], d: string): Outcome | null {
  const ref = barAt(nifty5, d, "09:20"); if (!ref) return null;
  const at = (hm: string) => { const b = barAt(nifty5, d, hm); return b ? r2(b.close - ref.close) : null; };
  const win = nifty5.filter((b) => istDay(b.time) === d && istHm(b.time) >= "09:25" && istHm(b.time) <= "10:20");
  return { ref: ref.close, m15: at("09:35"), m30: at("09:50"), m60: at("10:20"),
    maxUp: win.length ? r2(Math.max(...win.map((b) => b.high)) - ref.close) : null, maxDown: win.length ? r2(Math.min(...win.map((b) => b.low)) - ref.close) : null };
}

// ---- similarity: share of conditions that match (each condition compared only when both sides have it) ----
const sign = (v: number, flat: number) => (v > flat ? 1 : v < -flat ? -1 : 0);
export const CONDITIONS: { key: string; label: string; match: (a: Features, b: Features) => boolean | null }[] = [
  { key: "gap", label: "Gap direction", match: (a, b) => (a.gapPct == null || b.gapPct == null ? null : sign(a.gapPct, 0.15) === sign(b.gapPct, 0.15)) },
  { key: "first2", label: "First two candles", match: (a, b) => (a.first2 == null || b.first2 == null ? null : a.first2 === b.first2) },
  { key: "it", label: "IT heavyweights", match: (a, b) => (a.itPct == null || b.itPct == null ? null : sign(a.itPct, 0.15) === sign(b.itPct, 0.15)) },
  { key: "bank", label: "Bank heavyweights", match: (a, b) => (a.bankPct == null || b.bankPct == null ? null : sign(a.bankPct, 0.15) === sign(b.bankPct, 0.15)) },
  { key: "crude", label: `Crude vs ₹${CRUDE_THRESHOLD_INR}`, match: (a, b) => (a.crude == null || b.crude == null ? null : (a.crude < CRUDE_THRESHOLD_INR) === (b.crude < CRUDE_THRESHOLD_INR)) },
  { key: "global", label: "GIFT NIFTY overnight", match: (a, b) => (a.giftNightPct == null || b.giftNightPct == null ? null : sign(a.giftNightPct, 0.2) === sign(b.giftNightPct, 0.2)) },
  { key: "vix", label: "India VIX at open", match: (a, b) => (a.vixPct == null || b.vixPct == null ? null : sign(a.vixPct, 2) === sign(b.vixPct, 2)) },
  { key: "fii", label: "FII futures change", match: (a, b) => (a.fiiNet == null || b.fiiNet == null ? null : sign(a.fiiNet, 5000) === sign(b.fiiNet, 5000)) },
];
export function similarity(today: Features, past: Features) {
  const res = CONDITIONS.map((c) => ({ key: c.key, label: c.label, match: c.match(today, past) }));
  const compared = res.filter((r) => r.match != null), matched = compared.filter((r) => r.match);
  return { pct: compared.length ? Math.round((matched.length / compared.length) * 100) : 0, matched: matched.map((r) => r.label), compared: compared.length };
}

/** Top matches for today's features from the library (days strictly before `today`). */
export function findSimilar(today: Features, todayDate: string, lib: DayRow[], top = 5) {
  const past = lib.filter((r) => r.date < todayDate && r.outcome);
  const scored = past.map((r) => ({ ...r, sim: similarity(today, r.features) })).filter((r) => r.sim.compared >= 5)
    .sort((a, b) => b.sim.pct - a.sim.pct || b.date.localeCompare(a.date));
  const best = scored.slice(0, top);
  const available = CONDITIONS.filter((c) => c.match(today, today) != null).length;
  const agg = (k: keyof Outcome) => { const v = best.map((r) => r.outcome![k]).filter((x): x is number => x != null); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  return {
    library: past.length, compared: scored.length, completeness: { available, of: CONDITIONS.length },
    rows: best.map((r) => ({ date: r.date, similarity: r.sim.pct, matched: r.sim.matched, compared: r.sim.compared, outcome: r.outcome })),
    averages: { m15: agg("m15"), m30: agg("m30"), m60: agg("m60"), maxUp: agg("maxUp"), maxDown: agg("maxDown") },
    note: "Similarity = share of matching conditions (not a probability). Past results do not predict today's.",
  };
}

/** Build the library from history (every session with a 09:20 bar). */
export function buildLibrary(h: History): DayRow[] {
  const days = [...new Set(h.nifty5.map((b) => istDay(b.time)))].sort();
  return days.slice(1).map((d) => ({ date: d, features: featuresFor(h, d), outcome: outcomeFor(h.nifty5, d) })).filter((r) => r.outcome);
}

/** Walk-forward check: from day 40 on, using only earlier days, does the top-5 average 60-min move
 *  point the right way? (days with |avg| < 10 pts are skipped as "no call"). */
export function validateLibrary(lib: DayRow[], warmup = 40) {
  let n = 0, hit = 0, skipped = 0;
  for (let i = warmup; i < lib.length; i++) {
    const p = findSimilar(lib[i].features, lib[i].date, lib.slice(0, i)).averages.m60, a = lib[i].outcome?.m60;
    if (p == null || a == null) continue;
    if (Math.abs(p) < 10) { skipped++; continue; }
    n++; if (Math.sign(p) === Math.sign(a)) hit++;
  }
  const rate = n ? Math.round((hit / n) * 100) : null;
  return { calls: n, skipped, rightPct: rate, edge: rate != null && n >= 100 && rate >= 55,
    note: rate == null ? "Not enough history" : `Direction from similar sessions was right ${rate} % of ${n} walk-forward calls — ${rate >= 55 && n >= 100 ? "possible edge" : "no predictive edge; shown for context only"}` };
}

// ---- storage ----
const FILE = path.join(DATA_DIR, "sentiment", "scenario-library.json");
export interface LibraryFile { builtAt: number; rows: DayRow[]; validation: ReturnType<typeof validateLibrary> }
export function readLibrary(): LibraryFile | null { try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return null; } }
export function saveLibrary(rows: DayRow[]): LibraryFile { const f = { builtAt: Math.floor(Date.now() / 1000), rows, validation: validateLibrary(rows) }; try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(f)); } catch { /* best-effort */ } return f; }

// ---- library builder (after the close; Dhan market data + NSE participant files, cached) ----
import { giftHistory, crudeDailySeries, vixDaily } from "./dhanMarketExtras";
import { parseParticipantCsv, candidateDates } from "./nseParticipantOi";

export const IT_NAMES = ["INFY", "TCS", "HCLTECH", "TECHM", "WIPRO", "LTIM"];
export const BANK_NAMES = ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "INDUSINDBK"];
/** Top-5 of a group by contribution coefficient (falls back to list order). */
export function topByCoef(names: string[], coefs: Record<string, number>): string[] {
  return [...names].sort((a, b) => (coefs[b] || 0) - (coefs[a] || 0)).slice(0, 5);
}
const FII_FILE = path.join(DATA_DIR, "sentiment", "scenario-fii-nets.json");
/** FII index-futures NET per session from NSE files (cached per date; downloads only missing days). */
async function fiiNets(days: number): Promise<Record<string, number>> {
  let cache: Record<string, number | null> = {};
  try { cache = JSON.parse(fs.readFileSync(FII_FILE, "utf-8")); } catch { cache = {}; }
  const want = candidateDates(Math.floor(Date.now() / 1000), days);
  for (const d of want) {
    if (d in cache) continue;
    const f = `${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(0, 4)}`;
    try {
      const r = await fetch(`https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${f}.csv`, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" } as any, signal: AbortSignal.timeout(10000) });
      if (r.status === 404) { cache[d] = null; continue; }
      const day = r.ok ? parseParticipantCsv(await r.text(), d).day : null;
      if (day) cache[d] = day.fut.FII.long - day.fut.FII.short;
    } catch { /* retry next build */ }
    await new Promise((x) => setTimeout(x, 120));
  }
  try { fs.mkdirSync(path.dirname(FII_FILE), { recursive: true }); fs.writeFileSync(FII_FILE, JSON.stringify(cache)); } catch { /* best-effort */ }
  const nets = Object.entries(cache).filter(([, v]) => v != null).sort((a, b) => a[0].localeCompare(b[0])) as [string, number][];
  const chg: Record<string, number> = {};
  for (let i = 1; i < nets.length; i++) chg[nets[i][0]] = nets[i][1] - nets[i - 1][1];   // change on that session
  return chg;
}
const toBars = (c: any[]): Bar[] => (c || []).map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }));

/** Fetch ~1 year of history and build + save the library. getCandles = provider 5-min candles. */
export async function buildHistory(getCandles: (sym: string, days: number) => Promise<any[]>, coefs: Record<string, number>, days = 365): Promise<History> {
  const now = Math.floor(Date.now() / 1000), to = istDay(now + 86400), from = istDay(now - days * 86400);
  const it: Record<string, Bar[]> = {}, bank: Record<string, Bar[]> = {};
  for (const s of topByCoef(IT_NAMES, coefs)) it[s] = toBars(await getCandles(s + ".NS", days));
  for (const s of topByCoef(BANK_NAMES, coefs)) bank[s] = toBars(await getCandles(s + ".NS", days));
  const vix = await vixDaily(from, to);
  return {
    nifty5: toBars(await getCandles("^NSEI", days)), gift5: toBars(await giftHistory(from, to)), it, bank, coefs,
    crude: await crudeDailySeries(from, to),
    vix: vix.map((b, i) => ({ date: istDay(b.time), open: b.open, prevClose: i ? vix[i - 1].close : null })),
    fii: await fiiNets(Math.ceil(days * 0.72)),
  };
}
