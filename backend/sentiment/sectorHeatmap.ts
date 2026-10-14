import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

// ============================ 09:13 sector heatmap ============================
// Once each trading morning at 09:13 IST (after the 09:08 pre-open price fix), one batched
// quote call for every stock in NSE's sector indices; each stock's pre-open price vs its
// previous close, averaged per sector. The snapshot is saved for the day and shown in the
// Market Sentiment screen's "India Market Sector Analysis" panel. Display only.
//
// Sector membership comes from NSE's official index constituent lists (refreshed weekly).
// Checks: a stock is dropped if its quote is missing or moves more than 20% (outside any
// circuit band); the snapshot is marked PREOPEN_NOT_AVAILABLE when most stocks still sit
// exactly at the previous close (the feed has not delivered pre-open prices yet).

export const SECTORS: { name: string; file: string }[] = [
  { name: "Bank", file: "ind_niftybanklist" },
  { name: "PSU Bank", file: "ind_niftypsubanklist" },
  { name: "Fin Services", file: "ind_niftyfinancelist" },
  { name: "IT", file: "ind_niftyitlist" },
  { name: "Auto", file: "ind_niftyautolist" },
  { name: "Pharma", file: "ind_niftypharmalist" },
  { name: "Healthcare", file: "ind_niftyhealthcarelist" },
  { name: "FMCG", file: "ind_niftyfmcglist" },
  { name: "Metal", file: "ind_niftymetallist" },
  { name: "Realty", file: "ind_niftyrealtylist" },
  { name: "Energy", file: "ind_niftyenergylist" },
  { name: "Oil & Gas", file: "ind_niftyoilgaslist" },
  { name: "Media", file: "ind_niftymedialist" },
  { name: "Consumer Durables", file: "ind_niftyconsumerdurableslist" },
  { name: "Defence", file: "ind_niftyindiadefence_list" },
  { name: "Infra", file: "ind_niftyinfralist" },
];

export interface HeatStock { s: string; price: number; prev: number; pct: number }
export interface HeatSector { name: string; avg: number; adv: number; dec: number; n: number; stocks: HeatStock[] }
export interface HeatSnapshot {
  date: string; takenAt: number; refilledAt?: number; refilled?: number; status: "OK" | "PREOPEN_NOT_AVAILABLE" | "FAILED";
  sectors: HeatSector[]; stocksUp: number; stocksDown: number; quoted: number; listed: number; atPrevClose: number; dropped: string[];
  note?: string;
}

/** Parse an NSE index constituent CSV ("Company Name,Industry,Symbol,Series,ISIN Code"). */
export function parseConstituents(csv: string): string[] {
  const lines = csv.replace(/\r/g, "").trim().split("\n");
  const head = (lines[0] || "").split(",").map((h) => h.trim().toLowerCase());
  const si = head.indexOf("symbol");
  if (si < 0) return [];
  return [...new Set(lines.slice(1).map((l) => (l.split(",")[si] || "").trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]+$/.test(s)))];
}

/** Build the snapshot from quotes. Pure + tested. */
export function buildHeatmap(members: Record<string, string[]>, quotes: Record<string, { price: number; previousClose: number } | null>, date: string, takenAt: number): HeatSnapshot {
  const dropped: string[] = [];
  const stock = new Map<string, HeatStock>();
  const all = [...new Set(Object.values(members).flat())];
  for (const s of all) {
    const q = quotes[s];
    if (!q || !(q.price > 0) || !(q.previousClose > 0)) { dropped.push(s); continue; }
    const pct = Math.round(((q.price - q.previousClose) / q.previousClose) * 10000) / 100;
    if (Math.abs(pct) > 20) { dropped.push(s); continue; }
    stock.set(s, { s, price: q.price, prev: q.previousClose, pct });
  }
  const sectors: HeatSector[] = Object.entries(members).map(([name, syms]) => {
    const v = syms.map((s) => stock.get(s)).filter((x): x is HeatStock => !!x).sort((a, b) => b.pct - a.pct);
    const avg = v.length ? Math.round((v.reduce((a, x) => a + x.pct, 0) / v.length) * 100) / 100 : 0;
    return { name, avg, adv: v.filter((x) => x.pct > 0).length, dec: v.filter((x) => x.pct < 0).length, n: v.length, stocks: v };
  }).filter((s) => s.n > 0).sort((a, b) => b.avg - a.avg);
  const vals = [...stock.values()];
  const atPrevClose = vals.filter((x) => x.price === x.prev).length;
  const status: HeatSnapshot["status"] = !vals.length ? "FAILED" : atPrevClose / vals.length > 0.6 ? "PREOPEN_NOT_AVAILABLE" : "OK";
  return {
    date, takenAt, status, sectors, stocksUp: vals.filter((x) => x.pct > 0).length, stocksDown: vals.filter((x) => x.pct < 0).length,
    quoted: vals.length, listed: all.length, atPrevClose, dropped,
    note: status === "PREOPEN_NOT_AVAILABLE" ? `${atPrevClose} of ${vals.length} stocks still at the previous close at 09:13 — pre-open prices not delivered by the feed.` : undefined,
  };
}

// ---- sector lists: NSE CSVs, cached on disk, refreshed when older than 7 days ----
const DIR = path.join(DATA_DIR, "sentiment");
const LISTS = path.join(DIR, "nse-sector-lists.json");
const SNAPS = path.join(DIR, "sector-heatmap");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function sectorMembers(): Promise<Record<string, string[]>> {
  let cached: { at: number; members: Record<string, string[]> } | null = null;
  try { cached = JSON.parse(fs.readFileSync(LISTS, "utf-8")); } catch { cached = null; }
  if (cached && Date.now() - cached.at < 7 * 86400_000 && Object.keys(cached.members).length) return cached.members;
  const members: Record<string, string[]> = {};
  for (const s of SECTORS) {
    try {
      const r = await fetch(`https://nsearchives.nseindia.com/content/indices/${s.file}.csv`, { headers: { "User-Agent": UA } as any, signal: AbortSignal.timeout(10000) });
      const list = r.ok ? parseConstituents(await r.text()) : [];
      if (list.length >= 5) members[s.name] = list;
      else if (cached?.members[s.name]) members[s.name] = cached.members[s.name];   // keep last good list
    } catch { if (cached?.members[s.name]) members[s.name] = cached.members[s.name]; }
  }
  if (Object.keys(members).length) {
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(LISTS, JSON.stringify({ at: Date.now(), members })); } catch { /* best-effort */ }
  }
  return members;
}

// ---- snapshots on disk ----
export function saveSnapshot(s: HeatSnapshot): void {
  try { fs.mkdirSync(SNAPS, { recursive: true }); fs.writeFileSync(path.join(SNAPS, `${s.date}.json`), JSON.stringify(s)); } catch { /* best-effort */ }
}
export function readSnapshot(date: string): HeatSnapshot | null {
  try { return JSON.parse(fs.readFileSync(path.join(SNAPS, `${date}.json`), "utf-8")); } catch { return null; }
}
/** Newest saved snapshot on or before `date` (only usable ones when `okOnly`). */
export function latestSnapshot(date: string, okOnly = false): HeatSnapshot | null {
  try {
    const files = fs.readdirSync(SNAPS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) <= date).sort().reverse();
    for (const f of files) { const s = readSnapshot(f.slice(0, 10)); if (s && (!okOnly || s.status === "OK")) return s; }
    return null;
  } catch { return null; }
}

/** Second pass (09:14:30, pre-open prices still fixed): re-quote stocks still at the previous
 *  close — Dhan delivered ~6% of pre-open prices after 09:13 on 12 Oct (e.g. RELIANCE showed 0%
 *  but opened +0.85%) — and recompute sector averages / counts. Pure apart from getQuotes. */
export async function refillSnapshot(snap: HeatSnapshot, getQuotes: (syms: string[]) => Promise<Record<string, any>>): Promise<HeatSnapshot> {
  const flat = new Set<string>();
  for (const s of snap.sectors) for (const k of s.stocks) if (k.price === k.prev) flat.add(k.s);
  const out: HeatSnapshot = { ...snap, refilledAt: Math.floor(Date.now() / 1000), refilled: 0 };
  if (!flat.size) return out;
  const raw = await getQuotes([...flat].map((s) => s + ".NS"));
  const upd = new Map<string, number>();
  for (const s of flat) { const q = raw[s + ".NS"]; const p = q ? Number(q.price) : NaN; if (p > 0) upd.set(s, p); }
  return applyRefill(snap, upd, out.refilledAt!);
}
export function applyRefill(snap: HeatSnapshot, upd: Map<string, number>, at: number): HeatSnapshot {
  let refilled = 0; const seen = new Set<string>();
  const sectors = snap.sectors.map((sec) => {
    const stocks = sec.stocks.map((k) => {
      const p = upd.get(k.s);
      if (p == null || p === k.price || k.price !== k.prev) return k;
      const pct = Math.round(((p - k.prev) / k.prev) * 10000) / 100;
      if (Math.abs(pct) > 20) return k;
      if (!seen.has(k.s)) { seen.add(k.s); refilled++; }
      return { ...k, price: p, pct };
    }).sort((a, b) => b.pct - a.pct);
    const avg = stocks.length ? Math.round((stocks.reduce((a, x) => a + x.pct, 0) / stocks.length) * 100) / 100 : 0;
    return { ...sec, stocks, avg, adv: stocks.filter((x) => x.pct > 0).length, dec: stocks.filter((x) => x.pct < 0).length };
  }).sort((a, b) => b.avg - a.avg);
  const uniq = new Map<string, HeatStock>(); for (const s of sectors) for (const k of s.stocks) uniq.set(k.s, k);
  const vals = [...uniq.values()];
  return { ...snap, sectors, refilledAt: at, refilled, stocksUp: vals.filter((x) => x.pct > 0).length, stocksDown: vals.filter((x) => x.pct < 0).length, atPrevClose: vals.filter((x) => x.price === x.prev).length };
}

/** Take today's snapshot with the given batched-quote function. */
export async function takeSnapshot(getQuotes: (syms: string[]) => Promise<Record<string, any>>, date: string): Promise<HeatSnapshot> {
  const members = await sectorMembers();
  const all = [...new Set(Object.values(members).flat())];
  if (!all.length) return { date, takenAt: Math.floor(Date.now() / 1000), status: "FAILED", sectors: [], stocksUp: 0, stocksDown: 0, quoted: 0, listed: 0, atPrevClose: 0, dropped: [], note: "NSE sector lists unavailable." };
  const raw = await getQuotes(all.map((s) => s + ".NS"));
  const quotes: Record<string, { price: number; previousClose: number } | null> = {};
  for (const s of all) { const q = raw[s + ".NS"]; quotes[s] = q ? { price: Number(q.price), previousClose: Number(q.previousClose) } : null; }
  return buildHeatmap(members, quotes, date, Math.floor(Date.now() / 1000));
}

// ---- NIFTY 50 constituents view: the 09:13 move of each NIFTY stock with its weight and index points ----
// Weights = the validated estimated contribution model (NNLS on 5-min returns; sums to ≈ 100 %), not NSE's official
// weights. Index points = weight × the stock's % move × the NIFTY reference level (previous close).
export interface NiftyHeatRow { s: string; weightPct: number; pct: number | null; points: number | null; price: number | null; prev: number | null }
export function niftyConstituentHeat(snap: HeatSnapshot | null, coefs: Record<string, number> | null, indexRef: number | null) {
  if (!snap || !coefs) return null;
  const bySym = new Map<string, HeatStock>();
  for (const sec of snap.sectors || []) for (const k of sec.stocks) if (!bySym.has(k.s)) bySym.set(k.s, k);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const rows: NiftyHeatRow[] = Object.entries(coefs).filter(([, c]) => c > 0).map(([s, c]) => {
    const k = bySym.get(s);
    return { s, weightPct: r2(c * 100), pct: k ? k.pct : null, price: k ? k.price : null, prev: k ? k.prev : null,
      points: k && indexRef ? Math.round(c * (k.pct / 100) * indexRef * 10) / 10 : null };
  }).sort((a, b) => b.weightPct - a.weightPct);
  const priced = rows.filter((r) => r.pct != null);
  const sumW = (rs: NiftyHeatRow[]) => r2(rs.reduce((a, r) => a + r.weightPct, 0));
  const top10 = rows.slice(0, 10);
  return {
    rows, priced: priced.length, of: rows.length, indexRef,
    up: priced.filter((r) => (r.pct as number) > 0).length, down: priced.filter((r) => (r.pct as number) < 0).length,
    totalPoints: indexRef ? Math.round(priced.reduce((a, r) => a + (r.points ?? 0), 0) * 10) / 10 : null,
    top10Weight: sumW(top10), top10Points: indexRef ? Math.round(top10.reduce((a, r) => a + (r.points ?? 0), 0) * 10) / 10 : null,
    note: "Weights: estimated contribution model (not NSE's official weights). Points ≈ weight × 09:13 move × NIFTY previous close.",
  };
}
