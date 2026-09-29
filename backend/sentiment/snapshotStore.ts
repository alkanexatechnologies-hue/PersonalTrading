import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";
import type { SentimentSnapshot } from "./types";

// ============================ 30-minute sentiment snapshots ============================
// Every 30-min cycle (09:10, 09:40, … 14:40, 15:10 IST) one immutable snapshot of
// the derived sentiment is appended, so the Sentiment Timeline can show how the
// day evolved (e.g. BEARISH → MIXED → BULLISH). Persisted under DATA_DIR so it
// survives restarts. Deduped by (date, slot): re-computing within the same slot
// updates that slot rather than adding a duplicate.

const DIR = path.join(DATA_DIR, "sentiment");
const FILE = path.join(DIR, "snapshots.jsonl");

// Session slot labels (IST). The desk refreshes sentiment on these.
export const SLOTS = ["09:10","09:40","10:10","10:40","11:10","11:40","12:10","12:40","13:10","13:40","14:10","14:40","15:10"];

const istDate = (ms: number) => new Date(ms + 19800000).toISOString().slice(0, 10);

/** The active 30-min slot label for a given time (IST), clamped to the session. */
export function currentSlot(nowMs = Date.now()): string {
  const ist = new Date(nowMs + 19800000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes();
  const mins = h * 60 + m;
  // slots start at 09:10 (550) in 30-min steps up to 15:10 (910)
  const first = 9 * 60 + 10, last = 15 * 60 + 10;
  if (mins < first) return SLOTS[0];
  if (mins >= last) return "15:10";
  const idx = Math.floor((mins - first) / 30);
  return SLOTS[Math.min(idx, SLOTS.length - 1)];
}

/** True during the pre-market → session window when snapshots should accrue. */
export function inSnapshotWindow(nowMs = Date.now()): boolean {
  const ist = new Date(nowMs + 19800000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const day = ist.getUTCDay(); // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return false;
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;
}

function readAll(): SentimentSnapshot[] {
  try { return fs.readFileSync(FILE, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function writeAll(rows: SentimentSnapshot[]): void {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf-8"); } catch { /* best-effort */ }
}

/** Append (or replace within the same date+slot) one snapshot. */
export function saveSnapshot(snap: SentimentSnapshot): void {
  const rows = readAll();
  const i = rows.findIndex((r) => r.date === snap.date && r.slot === snap.slot);
  if (i >= 0) rows[i] = snap; else rows.push(snap);
  // keep it bounded — last ~400 rows (~1 month of sessions)
  writeAll(rows.slice(-400));
}

/** Today's snapshots in slot order (IST). */
export function todaySnapshots(nowMs = Date.now()): SentimentSnapshot[] {
  const d = istDate(nowMs);
  return readAll().filter((r) => r.date === d).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
}

/** True when the current slot has not yet been stored today. */
export function slotNeedsSnapshot(nowMs = Date.now()): boolean {
  if (!inSnapshotWindow(nowMs)) return false;
  const slot = currentSlot(nowMs), d = istDate(nowMs);
  return !readAll().some((r) => r.date === d && r.slot === slot);
}
