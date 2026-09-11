// ============================ Log Retention Sweep ============================
// Runs once daily (scheduled at market close). NON-DESTRUCTIVE BY DEFAULT.
//
//  1) ARCHIVE: gzip any data/log/*.jsonl and data/oi-log/oi-*.csv older than
//     ARCHIVE_DAYS (default 90) into data/log/archive/, then remove the original
//     from the hot directory. Data is retained (compressed), the working dir stays
//     bounded.
//  2) DELETE archives older than DELETE_DAYS (default 365) — ONLY when explicitly
//     enabled via LOG_ARCHIVE_DELETE=1. Off by default so no trade history is ever
//     silently destroyed.

import fs from "fs";
import path from "path";
import zlib from "zlib";

const LOG_DIR = path.join(process.cwd(), "data", "log");
const OI_DIR = path.join(process.cwd(), "data", "oi-log");
const ARCHIVE_DIR = path.join(LOG_DIR, "archive");

const ARCHIVE_DAYS = Number(process.env.LOG_ARCHIVE_DAYS) || 90;
const DELETE_DAYS = Number(process.env.LOG_ARCHIVE_DELETE_DAYS) || 365;
const DELETE_ENABLED = process.env.LOG_ARCHIVE_DELETE === "1"; // opt-in, default OFF

const DAY_MS = 24 * 3600 * 1000;

// Parse the trailing YYYY-MM-DD in a rotated filename; null if none.
function dateInName(name: string): number | null {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const t = Date.parse(m[1] + "T00:00:00+05:30");
  return Number.isFinite(t) ? t : null;
}

function archiveDir(dir: string, match: (f: string) => boolean, cutoffMs: number, out: { archived: number; deleted: number }) {
  if (!fs.existsSync(dir)) return;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (!match(f)) continue;
    const d = dateInName(f);
    if (d == null || d >= cutoffMs) continue; // keep recent files hot
    const src = path.join(dir, f);
    const dst = path.join(ARCHIVE_DIR, f + ".gz");
    try {
      const raw = fs.readFileSync(src);
      fs.writeFileSync(dst, zlib.gzipSync(raw));
      fs.unlinkSync(src); // moved into the archive, not destroyed
      out.archived++;
    } catch { /* best-effort per file */ }
  }
}

export interface SweepResult { archived: number; deleted: number; deleteEnabled: boolean; ranAt: number; }

export function runRetentionSweep(): SweepResult {
  const now = Date.now();
  const out = { archived: 0, deleted: 0 };
  const archiveCutoff = now - ARCHIVE_DAYS * DAY_MS;

  // 1) Archive old JSONL logs + old OI CSVs.
  archiveDir(LOG_DIR, (f) => f.endsWith(".jsonl"), archiveCutoff, out);
  archiveDir(OI_DIR, (f) => /^oi-\d{4}-\d{2}-\d{2}\.csv$/.test(f), archiveCutoff, out);

  // 2) Delete very old archives — ONLY if explicitly enabled.
  if (DELETE_ENABLED && fs.existsSync(ARCHIVE_DIR)) {
    const deleteCutoff = now - DELETE_DAYS * DAY_MS;
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      const d = dateInName(f);
      if (d == null || d >= deleteCutoff) continue;
      try { fs.unlinkSync(path.join(ARCHIVE_DIR, f)); out.deleted++; } catch { /* ignore */ }
    }
  }

  return { ...out, deleteEnabled: DELETE_ENABLED, ranAt: now };
}
