import fs from "fs";
import path from "path";
import { HourlyPick } from "../types";
import { istDateStr, istTimeStr } from "../util/istTime";

const DATA_DIR = path.join(process.cwd(), "data");

// Re-exported from the shared util so existing callers of `istDateStr`/`istSlot`
// from this module keep working unchanged.
export { istDateStr };
export const istSlot = istTimeStr;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function picksFilePath(date: string): string {
  return path.join(DATA_DIR, `hourly-picks-${date}.csv`);
}

// Cumulative master "database" - every snapshot from every day appended here,
// so the full history lives in one Excel/Access-importable file for backtesting.
export function masterFilePath(): string {
  return path.join(DATA_DIR, "hourly-master.csv");
}

// Column order for the CSV (Excel-friendly). Keep stable so resolve can re-read.
const COLUMNS: (keyof HourlyPick)[] = [
  "date", "slot", "snapshotEpoch", "symbol", "name", "direction", "optionType", "strike",
  "spot", "spotTarget", "spotStop", "premium", "premiumTarget", "premiumStop",
  "expectedPremiumMovePct", "confidence", "qualityScore", "marketAlignment", "relVolume",
  "thetaPctPerDay", "decayLevel", "dte", "hourlyScore", "expiry",
  "result", "hitTime", "spotAfter",
];

const esc = (v: any) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function appendHourlyPicks(picks: HourlyPick[]): { file: string; master: string; added: number } {
  ensureDir();
  if (!picks.length) return { file: "", master: "", added: 0 };
  const date = picks[0].date;
  const rows = picks.map((p) => COLUMNS.map((c) => esc((p as any)[c])).join(","));

  // 1) Per-day file.
  const file = picksFilePath(date);
  const dayNew = !fs.existsSync(file);
  fs.appendFileSync(file, (dayNew ? "\uFEFF" + COLUMNS.join(",") + "\r\n" : "") + rows.join("\r\n") + "\r\n", "utf-8");

  // 2) Cumulative master database (all days).
  const master = masterFilePath();
  const masterNew = !fs.existsSync(master);
  fs.appendFileSync(master, (masterNew ? "\uFEFF" + COLUMNS.join(",") + "\r\n" : "") + rows.join("\r\n") + "\r\n", "utf-8");

  return { file, master, added: picks.length };
}

export function readHourlyPicks(date: string): HourlyPick[] {
  const file = picksFilePath(date);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const rows = raw.split(/\r?\n/);
  const header = parseCsvLine(rows[0]);
  const out: HourlyPick[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = parseCsvLine(rows[i]);
    if (cells.length < 5) continue;
    const obj: any = {};
    header.forEach((h, idx) => (obj[h] = cells[idx]));
    // Coerce numerics.
    for (const k of [
      "snapshotEpoch", "strike", "spot", "spotTarget", "spotStop", "premium", "premiumTarget",
      "premiumStop", "expectedPremiumMovePct", "confidence", "qualityScore", "relVolume",
      "thetaPctPerDay", "dte", "hourlyScore", "spotAfter",
    ]) {
      if (obj[k] === "" || obj[k] == null) obj[k] = k === "premium" || k === "spotAfter" ? null : obj[k];
      else obj[k] = Number(obj[k]);
    }
    out.push(obj as HourlyPick);
  }
  return out;
}

// Overwrite the file with resolved rows (adds result/hitTime/spotAfter).
// Resilient: if the CSV is locked (e.g. open in Excel/editor -> EBUSY on Windows)
// it falls back to a "-resolved" copy and NEVER throws, so resolve can't crash
// the server.
export function writeResolvedPicks(date: string, picks: HourlyPick[]): string {
  ensureDir();
  const file = picksFilePath(date);
  const lines = [COLUMNS.join(",")];
  for (const p of picks) lines.push(COLUMNS.map((c) => esc((p as any)[c])).join(","));
  const content = "\uFEFF" + lines.join("\r\n") + "\r\n";
  try {
    fs.writeFileSync(file, content, "utf-8");
    return file;
  } catch {
    const fallback = path.join(DATA_DIR, `hourly-picks-${date}-resolved.csv`);
    try { fs.writeFileSync(fallback, content, "utf-8"); return fallback; } catch { return file; }
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
