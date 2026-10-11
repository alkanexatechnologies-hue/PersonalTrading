import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";
import { readXlsFirstSheet } from "./xlsBiff";
import { candidateDates } from "./nseParticipantOi";
import { classifyFiiLegs } from "./fiiFutures";
import type { FiiPositionType } from "./types";

// ============================ NSE FII derivatives statistics (index-wise) ============================
// https://nsearchives.nseindia.com/content/fo/fii_stats_DD-Mon-YYYY.xls — for each index
// (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50) the FIIs' contracts BOUGHT and SOLD
// that day and their end-of-day open interest (gross: long + short). NSE does not publish
// per-index long/short totals, but each day's change in them is exact:
//   ΔLong − ΔShort = Bought − Sold        ΔLong + ΔShort = ΔOI
// A day is accepted only if the title date matches and the per-index rows add up exactly
// to the INDEX FUTURES / INDEX OPTIONS totals.

export const FII_INDEXES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"] as const;
export type FiiIndex = (typeof FII_INDEXES)[number];
export interface StatRow { buyC: number; buyCr: number; sellC: number; sellCr: number; oiC: number; oiCr: number }
export interface FiiStatsDay { date: string; fut: Record<string, StatRow>; opt: Record<string, StatRow> }   // keys: index names + "TOTAL"

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nseDate = (d: string) => `${d.slice(8, 10)}-${MON[+d.slice(5, 7) - 1]}-${d.slice(0, 4)}`;

/** Parse the sheet grid of one fii_stats file. */
export function parseFiiStats(grid: string[][], expectDate: string): { day: FiiStatsDay | null; reason?: string } {
  const title = (grid[0] || []).join(" ");
  const m = title.match(/FOR\s+(\d{2})-([A-Za-z]{3})-(\d{4})/i);
  if (!m) return { day: null, reason: "no date in title" };
  const mi = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  const got = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]}`;
  if (mi < 0 || got !== expectDate) return { day: null, reason: `title date ${got} ≠ ${expectDate}` };
  const rows = new Map<string, StatRow>();
  for (const r of grid) {
    const name = (r[0] || "").toUpperCase().replace(/\s+/g, " ").trim();
    if (!/ (FUTURES|OPTIONS)$/.test(name)) continue;
    const n = r.slice(1, 7).map((x) => Number(String(x).replace(/,/g, "")));
    if (n.length < 6 || n.some((x) => !Number.isFinite(x) || x < 0)) return { day: null, reason: `bad numbers in ${name}` };
    rows.set(name, { buyC: n[0], buyCr: n[1], sellC: n[2], sellCr: n[3], oiC: n[4], oiCr: n[5] });
  }
  const fut: Record<string, StatRow> = {}, opt: Record<string, StatRow> = {};
  for (const [kind, out] of [["FUTURES", fut], ["OPTIONS", opt]] as const) {
    const tot = rows.get(`INDEX ${kind}`); if (!tot) return { day: null, reason: `missing INDEX ${kind}` };
    out.TOTAL = tot;
    for (const ix of FII_INDEXES) { const r = rows.get(`${ix} ${kind}`); if (!r) return { day: null, reason: `missing ${ix} ${kind}` }; out[ix] = r; }
    // every index row (incl. ones we don't show, e.g. NIFTYFPI) must add up to the total
    const parts = [...rows.entries()].filter(([k]) => k.endsWith(` ${kind}`) && !k.startsWith("INDEX ") && !k.startsWith("STOCK ")).map(([, v]) => v);
    for (const f of ["buyC", "sellC", "oiC"] as const) {
      const sum = parts.reduce((s, v) => s + v[f], 0);
      if (sum !== tot[f]) return { day: null, reason: `${kind} ${f}: index rows ${sum} ≠ total ${tot[f]}` };
    }
  }
  return { day: { date: expectDate, fut, opt } };
}

// ---- derived, per index ----
export interface IndexFlow {
  index: FiiIndex | "TOTAL";
  oi: number; oiCr: number; share: number | null;          // share of all FII index-futures OI, %
  netC: number; netCr: number;                              // bought − sold today
  dOi: number | null; dLong: number | null; dShort: number | null; type: FiiPositionType | null;
  net5C: number | null; net5Cr: number | null;              // last 5 sessions' bought − sold
  optOi: number; optNetC: number;                           // index options: OI and bought − sold today
}
/** Per-index flows from days sorted oldest → newest (latest last). */
export function indexFlows(days: FiiStatsDay[]): IndexFlow[] {
  const last = days[days.length - 1]; if (!last) return [];
  const prev = days[days.length - 2];
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return (["TOTAL", ...FII_INDEXES] as const).map((ix) => {
    const t = last.fut[ix], p = prev ? prev.fut[ix] : null;
    const netC = t.buyC - t.sellC, dOi = p ? t.oiC - p.oiC : null;
    // identity gives halves of integers; an odd sum would mean inconsistent data → don't show legs
    const legsOk = dOi != null && (dOi + netC) % 2 === 0;
    const dLong = legsOk ? (dOi! + netC) / 2 : null, dShort = legsOk ? (dOi! - netC) / 2 : null;
    const five = days.slice(-5);
    return {
      index: ix, oi: t.oiC, oiCr: t.oiCr, share: ix === "TOTAL" || !last.fut.TOTAL.oiC ? null : Math.round((t.oiC / last.fut.TOTAL.oiC) * 1000) / 10,
      netC, netCr: r2(t.buyCr - t.sellCr), dOi, dLong, dShort,
      type: dLong != null && dShort != null ? classifyFiiLegs(dLong, dShort) : null,
      net5C: five.length === 5 ? five.reduce((s, d) => s + d.fut[ix].buyC - d.fut[ix].sellC, 0) : null,
      net5Cr: five.length === 5 ? r2(five.reduce((s, d) => s + d.fut[ix].buyCr - d.fut[ix].sellCr, 0)) : null,
      optOi: last.opt[ix].oiC, optNetC: last.opt[ix].buyC - last.opt[ix].sellC,
    };
  });
}

// ---- fetch + disk cache (accepted days are final) ----
const FILE = path.join(DATA_DIR, "sentiment", "nse-fii-stats.json");
interface Store { days: Record<string, FiiStatsDay>; noFile: string[] }
function load(): Store { try { const j = JSON.parse(fs.readFileSync(FILE, "utf-8")); return { days: j.days || {}, noFile: j.noFile || [] }; } catch { return { days: {}, noFile: [] }; } }
function save(s: Store): void { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s)); } catch { /* best-effort */ } }
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function download(date: string): Promise<{ status: number; buf: Buffer | null }> {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://nsearchives.nseindia.com/content/fo/fii_stats_${nseDate(date)}.xls`, { headers: { "User-Agent": UA, Referer: "https://www.nseindia.com/" } as any, signal: ctrl.signal });
    return { status: r.status, buf: r.ok ? Buffer.from(await r.arrayBuffer()) : null };
  } catch { return { status: 0, buf: null }; } finally { clearTimeout(to); }
}

export interface FiiStatsLoad { days: FiiStatsDay[]; rejected: { date: string; reason: string }[] }
let mem: { at: number; data: FiiStatsLoad } | null = null;
let inflight: Promise<FiiStatsLoad> | null = null;

/** Last `sessions` accepted days, oldest first. Downloads only days not cached yet; refreshes ≤ every 15 min. */
export async function loadFiiStats(sessions = 6): Promise<FiiStatsLoad> {
  if (mem && Date.now() - mem.at < 15 * 60_000) return mem.data;
  if (!inflight) inflight = (async () => {
    const store = load();
    const want = candidateDates(Math.floor(Date.now() / 1000), sessions + 4);
    const rejected: FiiStatsLoad["rejected"] = [];
    let changed = false;
    for (const d of want) {
      if (store.days[d] || store.noFile.includes(d)) continue;
      const { status, buf } = await download(d);
      if (status === 200 && buf) {
        let res: { day: FiiStatsDay | null; reason?: string };
        try { res = parseFiiStats(readXlsFirstSheet(buf), d); } catch (e: any) { res = { day: null, reason: "unreadable file: " + (e?.message || e) }; }
        if (res.day) { store.days[d] = res.day; changed = true; } else rejected.push({ date: d, reason: res.reason || "invalid" });
      } else if (status === 404 && (Date.parse(want[0]) - Date.parse(d)) / 86400000 >= 3) { store.noFile.push(d); changed = true; }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (changed) {
      const keep = new Set(want);
      for (const k of Object.keys(store.days)) if (!keep.has(k)) delete store.days[k];
      store.noFile = store.noFile.filter((d) => keep.has(d));
      save(store);
    }
    const days = Object.values(store.days).filter((x) => want.includes(x.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(-sessions);
    const data = { days, rejected };
    mem = { at: Date.now(), data };
    return data;
  })().finally(() => { inflight = null; });
  if (mem) { inflight.catch(() => null); return mem.data; }
  return inflight;
}
