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
  date: string; takenAt: number; status: "OK" | "PREOPEN_NOT_AVAILABLE" | "FAILED";
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
/** Newest saved snapshot on or before `date`. */
export function latestSnapshot(date: string): HeatSnapshot | null {
  try {
    const f = fs.readdirSync(SNAPS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) <= date).sort().pop();
    return f ? readSnapshot(f.slice(0, 10)) : null;
  } catch { return null; }
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
