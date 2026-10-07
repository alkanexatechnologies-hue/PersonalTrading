// 1-minute OI log — one row per index per minute (summary) plus one row per strike per
// minute (ATM ± 10 strikes), for offline OI analysis. Written as CSV under
// DATA_DIR/oi-minute/<date>/ so it survives restarts when a persistent disk is mounted
// (Render), and pulled to the desktop by scripts/pull-oi-logs.mjs.
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

export const OI_MINUTE_DIR = path.join(DATA_DIR, "oi-minute");
export const SUMMARY_HEADER = "date,timeIST,symbol,index,spot,expiry,chainAgeSec,pcr,totalCeOi,totalPeOi,ceChgTotal,peChgTotal,support,resistance,maxPain,atmStrike,atmCeLtp,atmPeLtp,atmCeIv,atmPeIv,atmCeOi,atmPeOi";
export const STRIKE_HEADER = "date,timeIST,index,spot,strike,distFromSpot,ceOi,ceChg,ceVol,ceLtp,ceIv,ceDelta,peOi,peChg,peVol,peLtp,peIv,peDelta";
const STRIKES_EACH_SIDE = 10;

const num = (v: any) => (v == null || !isFinite(Number(v)) ? "" : String(Math.round(Number(v) * 100) / 100));
const csv = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export interface OiMinuteInput {
  date: string; timeIST: string; symbol: string; index: string; spot: number;
  chainAsOf?: number | null;   // epoch seconds of the option-chain read
  nowSec: number;
  oi: { expiry?: string | null; pcr?: number | null; totalCeOi?: number | null; totalPeOi?: number | null; support?: number | null; resistance?: number | null; maxPain?: number | null; topStrikes?: any[] };
}

export function buildOiMinuteRows(x: OiMinuteInput): { summary: string; strikes: string[] } {
  const rows = (x.oi.topStrikes || []).filter((r) => r && r.strike != null).sort((a, b) => a.strike - b.strike);
  const atm = rows.reduce((b: any, r: any) => (b == null || Math.abs(r.strike - x.spot) < Math.abs(b.strike - x.spot) ? r : b), null);
  const ai = atm ? rows.indexOf(atm) : -1;
  const near = ai < 0 ? [] : rows.slice(Math.max(0, ai - STRIKES_EACH_SIDE), ai + STRIKES_EACH_SIDE + 1);
  const sum = (k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const age = x.chainAsOf ? Math.max(0, x.nowSec - x.chainAsOf) : null;
  const summary = [x.date, x.timeIST, x.symbol, x.index, num(x.spot), x.oi.expiry ?? "", age ?? "", num(x.oi.pcr), num(x.oi.totalCeOi), num(x.oi.totalPeOi),
    num(sum("ceChg")), num(sum("peChg")), num(x.oi.support), num(x.oi.resistance), num(x.oi.maxPain),
    num(atm?.strike), num(atm?.ceLtp), num(atm?.peLtp), num(atm?.ceIv), num(atm?.peIv), num(atm?.ceOi), num(atm?.peOi)].map(csv).join(",");
  const strikes = near.map((r) => [x.date, x.timeIST, x.index, num(x.spot), num(r.strike), num(r.strike - x.spot),
    num(r.ceOi), num(r.ceChg), num(r.ceVol), num(r.ceLtp), num(r.ceIv), num(r.ceDelta),
    num(r.peOi), num(r.peChg), num(r.peVol), num(r.peLtp), num(r.peIv), num(r.peDelta)].map(csv).join(","));
  return { summary, strikes };
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");
function appendCsv(file: string, header: string, lines: string[]) {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isNew = !fs.existsSync(file);
  fs.appendFileSync(file, (isNew ? header + "\n" : "") + lines.join("\n") + "\n");
}
// One summary row per index + strike rows; skips a minute already written for that index.
const _written = new Map<string, string>();
export function writeOiMinute(x: OiMinuteInput, dir = OI_MINUTE_DIR): boolean {
  const key = `${x.date}|${x.index}`;
  if (_written.get(key) === x.timeIST) return false;
  const r = buildOiMinuteRows(x);
  appendCsv(path.join(dir, x.date, "summary.csv"), SUMMARY_HEADER, [r.summary]);
  appendCsv(path.join(dir, x.date, `strikes-${safe(x.index)}.csv`), STRIKE_HEADER, r.strikes);
  _written.set(key, x.timeIST);
  return true;
}

export function listOiMinuteDays(dir = OI_MINUTE_DIR): { date: string; files: { name: string; bytes: number }[] }[] {
  try {
    return fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().map((d) => ({
      date: d, files: fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith(".csv")).sort().map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, d, f)).size })),
    }));
  } catch { return []; }
}
export function oiMinuteFilePath(date: string, name: string, dir = OI_MINUTE_DIR): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]+\.csv$/.test(name)) return null;
  const f = path.join(dir, date, name);
  return fs.existsSync(f) ? f : null;
}
