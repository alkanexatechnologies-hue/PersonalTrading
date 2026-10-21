// ============================ Participant positioning HISTORY (NSE participant-wise OI, every session kept) ============================
// The live loader (nseParticipantOi.ts) keeps ~60 sessions for the sentiment cards. The positioning engine needs a long,
// auditable history (percentiles, the backtest), so every accepted NSE file is kept here:
//   raw report   → DATA_DIR/sentiment/raw/participant/<yyyy-mm-dd>.csv   (exactly as NSE served it — the audit trail)
//   parsed day   → DATA_DIR/sentiment/participant-history.json           (one row per trading date — the unique key)
// Idempotent: re-ingesting a date with the SAME file is a no-op; a DIFFERENT valid file for the same date (an NSE
// correction) replaces the row and is logged in `corrections`. A missing session stays missing — never zero-filled.
// Units: every figure is a number of CONTRACTS of open interest (NSE's own unit) — never lots, quantity or ₹ notional.
// Timing: NSE posts the file after the session (evening); a report for date D is usable from the NEXT session's open.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "../config/dataDir";
import { parseParticipantCsv, ParticipantDay } from "./nseParticipantOi";

export interface HistRow extends ParticipantDay { source: "NSE fao_participant_oi"; sourceReportId: string; sha1: string; ingestedAt: string; dataStatus: "OK" }
export interface HistStore { days: Record<string, HistRow>; noFile: string[]; rejected: Record<string, string>; corrections: { date: string; at: string; oldSha1: string; newSha1: string }[] }
const RAW_DIR = path.join(DATA_DIR, "sentiment", "raw", "participant"), FILE = path.join(DATA_DIR, "sentiment", "participant-history.json");
export const reportId = (date: string) => `fao_participant_oi_${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}.csv`;
const URL_OF = (date: string) => `https://nsearchives.nseindia.com/content/nsccl/${reportId(date)}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function loadHistory(file = FILE): HistStore {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return { days: j.days || {}, noFile: j.noFile || [], rejected: j.rejected || {}, corrections: j.corrections || [] }; }
  catch { return { days: {}, noFile: [], rejected: {}, corrections: [] }; }
}
export function saveHistory(s: HistStore, file = FILE) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s)); }

/** Upsert one report's text into the store (pure apart from the store object). Returns what happened. */
export function upsertReport(store: HistStore, date: string, text: string, nowIso = new Date().toISOString()): "ADDED" | "SAME" | "CORRECTED" | "REJECTED" {
  const { day, reason } = parseParticipantCsv(text, date);
  if (!day) { store.rejected[date] = reason || "invalid"; return "REJECTED"; }
  const sha1 = crypto.createHash("sha1").update(text).digest("hex"), old = store.days[date];
  if (old && old.sha1 === sha1) return "SAME";
  store.days[date] = { ...day, source: "NSE fao_participant_oi", sourceReportId: reportId(date), sha1, ingestedAt: nowIso, dataStatus: "OK" };
  delete store.rejected[date]; store.noFile = store.noFile.filter((d) => d !== date);
  if (old) { store.corrections.push({ date, at: nowIso, oldSha1: old.sha1, newSha1: sha1 }); return "CORRECTED"; }
  return "ADDED";
}

async function download(date: string): Promise<{ status: number; text: string | null }> {
  const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 12_000);
  try { const r = await fetch(URL_OF(date), { headers: { "User-Agent": UA, Accept: "text/csv,*/*", Referer: "https://www.nseindia.com/" } as any, signal: ctrl.signal }); return { status: r.status, text: r.ok ? await r.text() : null }; }
  catch { return { status: 0, text: null }; } finally { clearTimeout(to); }
}

/** Fetch the given dates that are not stored yet (one at a time, with a pause — NSE's public archive, no login). */
export async function ingestDates(dates: string[], o: { pauseMs?: number; force?: boolean; onDay?: (d: string, r: string) => void } = {}) {
  const store = loadHistory(); let changed = false; const out: Record<string, string> = {};
  for (const d of dates) {
    if (!o.force && (store.days[d] || store.noFile.includes(d))) continue;
    const { status, text } = await download(d);
    if (status === 200 && text) {
      fs.mkdirSync(RAW_DIR, { recursive: true }); fs.writeFileSync(path.join(RAW_DIR, `${d}.csv`), text);
      out[d] = upsertReport(store, d, text); changed = true;
    } else if (status === 404) {
      const ageDays = (Date.now() - Date.parse(d + "T12:30:00Z")) / 86400_000;
      if (ageDays >= 3) { store.noFile.push(d); changed = true; }   // a holiday: no file will ever come
      out[d] = "NO FILE";
    } else out[d] = `HTTP ${status}`;
    o.onDay?.(d, out[d]);
    await new Promise((r) => setTimeout(r, o.pauseMs ?? 400));
  }
  if (changed) saveHistory(store);
  return out;
}

/** Stored sessions, oldest first. */
export function historyDays(store = loadHistory()): HistRow[] { return Object.values(store.days).sort((a, b) => a.date.localeCompare(b.date)); }
