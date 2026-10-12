import fs from "fs";
import path from "path";
import zlib from "zlib";
import { DATA_DIR } from "../config/dataDir";

// ============================ Daily OI accuracy check vs NSE's official F&O bhavcopy ============================
// Intraday OI comes from the exchange's live broadcast (through Dhan). After the close NSE publishes the final,
// reconciled OI and last traded price for every contract (BhavCopy_NSE_FO_..._F_0000.csv.zip). Each evening the
// app compares Dhan's final chain (ATM ± 12 strikes, nearest expiry) with that file and stores the result, so the
// 1-Min OI Monitor can show how close the day's OI and premium data were to the official numbers.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const NSE_FO_SYMBOL: Record<string, string> = { "^NSEI": "NIFTY", "^NSEBANK": "BANKNIFTY", "^CNXFIN": "FINNIFTY", "^NSEMDCP50": "MIDCPNIFTY" };
const DIR = path.join(DATA_DIR, "oi-reconcile");

/** Extract the first file of a zip archive (stored or deflated) using the central directory. */
export function unzipFirst(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("bad zip directory");
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip method ${method} not supported`);
}

export interface OfficialLeg { oi: number; last: number; close: number }
/** NSE F&O bhavcopy rows for one index's option expiry, keyed `${strike}${CE|PE}`. */
export function parseFoBhav(csv: string, nseSymbol: string, expiry: string): Map<string, OfficialLeg> {
  const L = csv.split("\n"), h = L[0].split(","), ix = (k: string) => h.indexOf(k), out = new Map<string, OfficialLeg>();
  for (const l of L.slice(1)) {
    const c = l.split(",");
    if (c[ix("TckrSymb")] !== nseSymbol || c[ix("XpryDt")] !== expiry || c[ix("FinInstrmTp")] !== "IDO") continue;
    out.set(Number(c[ix("StrkPric")]) + c[ix("OptnTp")], { oi: Number(c[ix("OpnIntrst")]), last: Number(c[ix("LastPric")]), close: Number(c[ix("ClsPric")]) });
  }
  return out;
}
const bhavFile = (date: string) => path.join(DIR, `fo-bhav-${date}.csv`);
export async function fetchFoBhav(date: string): Promise<string | null> {
  try { return fs.readFileSync(bhavFile(date), "utf8"); } catch { /* download */ }
  const url = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${date.replace(/-/g, "")}_F_0000.csv.zip`;
  const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } as any, signal: ctrl.signal });
    if (!r.ok) return null;
    const csv = unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8");
    if (!/^TradDt,/.test(csv)) return null;
    fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(bhavFile(date), csv);
    return csv;
  } catch { return null; } finally { clearTimeout(to); }
}

export interface LegCheck { key: string; strike: number; side: "CE" | "PE"; appOi: number; nseOi: number; oiDiffPct: number; appLtp: number | null; nseLast: number; ltpMatch: boolean }
/** Compare chain legs (strike, ceOi/peOi, ceLtp/peLtp) with the official file. Pure. */
export function compareWithOfficial(strikes: { strike: number; ceOi: number | null; peOi: number | null; ceLtp: number | null; peLtp: number | null }[], off: Map<string, OfficialLeg>, spot: number | null) {
  const legs: LegCheck[] = [];
  for (const s of strikes) for (const side of ["CE", "PE"] as const) {
    const o = off.get(s.strike + side), oi = side === "CE" ? s.ceOi : s.peOi, ltp = side === "CE" ? s.ceLtp : s.peLtp;
    if (!o || oi == null || !(o.oi > 0)) continue;
    legs.push({ key: s.strike + side, strike: s.strike, side, appOi: oi, nseOi: o.oi, oiDiffPct: Math.round(((oi - o.oi) / o.oi) * 1000) / 10, appLtp: ltp, nseLast: o.last, ltpMatch: ltp != null && Math.abs(ltp - o.last) < 0.051 });
  }
  if (!legs.length) return { legs, n: 0 } as any;
  const ab = legs.map((l) => Math.abs(l.oiDiffPct)).sort((a, b) => a - b), q = (p: number) => ab[Math.min(ab.length - 1, Math.floor(ab.length * p))];
  const near = spot == null ? legs : legs.filter((l) => Math.abs(l.strike - spot) <= 0.01 * spot);
  const nab = near.map((l) => Math.abs(l.oiDiffPct)).sort((a, b) => a - b);
  const median = q(0.5), within5 = ab.filter((x) => x <= 5).length, ltpOk = legs.filter((l) => l.ltpMatch).length;
  const status = ltpOk < legs.length * 0.9 ? "CHECK" : median <= 3 && within5 >= legs.length * 0.8 ? "GOOD" : median <= 6 ? "FAIR" : "POOR";
  return {
    n: legs.length, median, p90: q(0.9), within1: ab.filter((x) => x <= 1).length, within5, ltpOk,
    nearMedian: nab.length ? nab[Math.floor(nab.length / 2)] : null, nearMax: nab.length ? nab[nab.length - 1] : null, nearN: nab.length,
    totalApp: legs.reduce((a, l) => a + l.appOi, 0), totalNse: legs.reduce((a, l) => a + l.nseOi, 0),
    worst: [...legs].sort((a, b) => Math.abs(b.oiDiffPct) - Math.abs(a.oiDiffPct)).slice(0, 5),
    status, legs,
  };
}

export function readReconcile(date: string): any { try { return JSON.parse(fs.readFileSync(path.join(DIR, `${date}.json`), "utf8")); } catch { return null; } }
export function latestReconcile(): any {
  try { const f = fs.readdirSync(DIR).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().pop(); return f ? JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) : null; } catch { return null; }
}
/** Run for one trading date with final chains supplied by the caller (fetched after the close). */
export async function reconcileDay(date: string, chains: Record<string, any>) {
  const csv = await fetchFoBhav(date);
  if (!csv) return { date, available: false, reason: "NSE F&O bhavcopy not published yet (usually after 18:00 IST)" };
  const out: any = { date, available: true, at: Math.floor(Date.now() / 1000), source: "NSE F&O bhavcopy (official end-of-day OI and last price)", indices: {} };
  for (const [sym, chain] of Object.entries(chains)) {
    const nseSym = NSE_FO_SYMBOL[sym]; if (!nseSym || !chain?.expiry || !Array.isArray(chain.topStrikes)) continue;
    const r = compareWithOfficial(chain.topStrikes, parseFoBhav(csv, nseSym, String(chain.expiry)), chain.underlying ?? null);
    const { legs, ...summary } = r;
    out.indices[sym] = { name: nseSym, expiry: chain.expiry, ...summary };
  }
  out.note = "Intraday OI is the exchange's live broadcast (via Dhan); NSE's final end-of-day OI is reconciled after the close, so small differences are normal. Premiums should match exactly.";
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, `${date}.json`), JSON.stringify(out)); } catch { /* best effort */ }
  return out;
}
