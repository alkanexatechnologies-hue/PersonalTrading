import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";
import type { FiiOptions, ParticipantFut } from "./types";

// ============================ NSE participant-wise open interest ============================
// NSE publishes, after each session, the open interest (no. of contracts) held by each
// participant type — Client, DII, FII, Pro — in index/stock futures and options:
//   https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv
// No broker API (Dhan included) carries this. A day is accepted ONLY when the file
//   - names the same date in its title ("... as on Oct 09, 2026"),
//   - has all four participant rows and a TOTAL row, and
//   - balances: TOTAL index-futures long == short (every contract has both sides).
// Anything else is rejected — never patched or guessed. Accepted days are final, so they
// are cached on disk and never re-downloaded.

export interface ParticipantDay {
  date: string;                                        // yyyy-mm-dd
  fut: Record<ParticipantFut["type"], { long: number; short: number }>;
  opt: Record<ParticipantFut["type"], FiiOptions>;
  /** stock futures / stock options (same file; optional for days cached before they were read) */
  stockFut?: Record<ParticipantFut["type"], { long: number; short: number }>;
  stockOpt?: Record<ParticipantFut["type"], FiiOptions>;
}

const TYPES: ParticipantFut["type"][] = ["Client", "DII", "FII", "Pro"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Parse one NSE participant OI CSV. Returns null (with a reason) when it fails any check. */
export function parseParticipantCsv(text: string, expectDate: string): { day: ParticipantDay | null; reason?: string } {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 6) return { day: null, reason: "too few lines" };
  const m = lines[0].match(/as on\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{4})/i);   // older files: "Nov 04,2024" (no space)
  if (!m) return { day: null, reason: "no date in title" };
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  const titleDate = `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (mon < 0 || titleDate !== expectDate) return { day: null, reason: `title date ${titleDate} ≠ ${expectDate}` };
  const hi = lines.findIndex((l) => /client type/i.test(l));
  if (hi < 0) return { day: null, reason: "no header" };
  const head = splitCsvLine(lines[hi]).map((h) => h.toLowerCase().replace(/\s+/g, " ").trim());   // some headers carry trailing tabs
  const col = (name: string) => head.indexOf(name);
  const C = {
    fl: col("future index long"), fs: col("future index short"),
    cl: col("option index call long"), pl: col("option index put long"), cs: col("option index call short"), ps: col("option index put short"),
  };
  const S = { fl: col("future stock long"), fs: col("future stock short"), cl: col("option stock call long"), pl: col("option stock put long"), cs: col("option stock call short"), ps: col("option stock put short") };
  const hasStock = Object.values(S).every((i) => i >= 0);
  if (Object.values(C).some((i) => i < 0)) return { day: null, reason: "missing index columns" };
  const rows = new Map<string, number[]>();
  for (const l of lines.slice(hi + 1)) {
    const cells = splitCsvLine(l);
    const nums = cells.map((c) => Number(c.replace(/,/g, "")));
    rows.set(cells[0].toLowerCase(), nums);
  }
  const fut = {} as ParticipantDay["fut"], opt = {} as ParticipantDay["opt"], stockFut = {} as NonNullable<ParticipantDay["stockFut"]>, stockOpt = {} as NonNullable<ParticipantDay["stockOpt"]>;
  for (const t of TYPES) {
    const r = rows.get(t.toLowerCase());
    if (!r) return { day: null, reason: `missing ${t} row` };
    const v = (i: number) => r[i];
    if ([C.fl, C.fs, C.cl, C.cs, C.pl, C.ps].some((i) => !Number.isFinite(v(i)) || v(i) < 0)) return { day: null, reason: `bad number in ${t} row` };
    fut[t] = { long: v(C.fl), short: v(C.fs) };
    opt[t] = { callLong: v(C.cl), callShort: v(C.cs), putLong: v(C.pl), putShort: v(C.ps) };
    if (hasStock) {
      if ([S.fl, S.fs, S.cl, S.cs, S.pl, S.ps].some((i) => !Number.isFinite(v(i)) || v(i) < 0)) return { day: null, reason: `bad stock number in ${t} row` };
      stockFut[t] = { long: v(S.fl), short: v(S.fs) };
      stockOpt[t] = { callLong: v(S.cl), callShort: v(S.cs), putLong: v(S.pl), putShort: v(S.ps) };
    }
  }
  const tot = rows.get("total");
  if (!tot) return { day: null, reason: "missing TOTAL row" };
  if (tot[C.fl] !== tot[C.fs]) return { day: null, reason: "TOTAL index futures long ≠ short" };
  const sumL = TYPES.reduce((s, t) => s + fut[t].long, 0), sumS = TYPES.reduce((s, t) => s + fut[t].short, 0);
  if (sumL !== tot[C.fl] || sumS !== tot[C.fs]) return { day: null, reason: "participants do not add up to TOTAL" };
  if (hasStock) {   // stock futures must balance the same way; otherwise the stock part is left out (index part stays valid)
    const sl = TYPES.reduce((a, t) => a + stockFut[t].long, 0), ss = TYPES.reduce((a, t) => a + stockFut[t].short, 0);
    if (tot[S.fl] === tot[S.fs] && sl === tot[S.fl] && ss === tot[S.fs]) return { day: { date: expectDate, fut, opt, stockFut, stockOpt } };
  }
  return { day: { date: expectDate, fut, opt } };
}

// ---- dates ----
const IST = 19800;
function istDate(sec: number): Date { return new Date((sec + IST) * 1000); }
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Weekday dates (yyyy-mm-dd), newest first, whose file could exist now. Today counts
 *  only after 18:00 IST (NSE posts the file in the evening). */
export function candidateDates(nowSec: number, count: number): string[] {
  const now = istDate(nowSec);
  const out: string[] = [];
  const startBack = now.getUTCHours() >= 18 ? 0 : 1;
  for (let back = startBack; out.length < count && back < count * 2 + 10; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    const w = d.getUTCDay(); if (w === 0 || w === 6) continue;
    out.push(ymd(d));
  }
  return out;
}
const fileUrl = (date: string) => `https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}.csv`;

// ---- disk cache: accepted days are final; 404s older than 3 days are treated as holidays ----
const FILE = path.join(DATA_DIR, "sentiment", "nse-participant-oi.json");
interface Store { days: Record<string, ParticipantDay>; noFile: string[] }
function load(): Store { try { const j = JSON.parse(fs.readFileSync(FILE, "utf-8")); return { days: j.days || {}, noFile: j.noFile || [] }; } catch { return { days: {}, noFile: [] }; } }
function save(s: Store): void { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s)); } catch { /* best-effort */ } }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function download(date: string): Promise<{ status: number; text: string | null }> {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(fileUrl(date), { headers: { "User-Agent": UA, Accept: "text/csv,*/*", Referer: "https://www.nseindia.com/" } as any, signal: ctrl.signal });
    return { status: r.status, text: r.ok ? await r.text() : null };
  } catch { return { status: 0, text: null }; } finally { clearTimeout(to); }
}

export interface ParticipantLoad { days: ParticipantDay[]; rejected: { date: string; reason: string }[]; reachable: boolean }
let mem: { at: number; data: ParticipantLoad } | null = null;
let inflight: Promise<ParticipantLoad> | null = null;
const REFRESH_MS = 15 * 60_000;

/** The last `sessions` accepted days, oldest first. Downloads only days not cached yet. */
export async function loadParticipantOi(sessions = 22): Promise<ParticipantLoad> {
  if (mem && Date.now() - mem.at < REFRESH_MS) return mem.data;
  if (!inflight) inflight = (async () => {
    const store = load();
    const nowSec = Math.floor(Date.now() / 1000);
    const want = candidateDates(nowSec, sessions + 8);
    const rejected: ParticipantLoad["rejected"] = [];
    let reachable = false, changed = false;
    for (const d of want) {
      if (store.days[d] || store.noFile.includes(d)) { reachable = reachable || !!store.days[d]; continue; }
      const { status, text } = await download(d);
      if (status === 200 && text) {
        reachable = true;
        const { day, reason } = parseParticipantCsv(text, d);
        if (day) { store.days[d] = day; changed = true; } else rejected.push({ date: d, reason: reason || "invalid" });
      } else if (status === 404) {
        reachable = true;
        const ageDays = (Date.parse(want[0]) - Date.parse(d)) / 86400000;
        if (ageDays >= 3) { store.noFile.push(d); changed = true; }   // holiday: no file will ever come
      }
      await new Promise((r) => setTimeout(r, 150));   // be gentle with NSE
    }
    if (changed) {
      const keep = new Set(want);
      for (const k of Object.keys(store.days)) if (!keep.has(k) && Object.keys(store.days).length > 60) delete store.days[k];
      store.noFile = store.noFile.filter((d) => keep.has(d));
      save(store);
    }
    const days = Object.values(store.days).filter((x) => want.includes(x.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(-sessions);
    const data = { days, rejected, reachable };
    mem = { at: Date.now(), data };
    return data;
  })().finally(() => { inflight = null; });
  // serve the last good copy while a refresh runs
  if (mem) { inflight.catch(() => null); return mem.data; }
  return inflight;
}
