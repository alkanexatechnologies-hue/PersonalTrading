import fs from "fs";
import path from "path";
import { OiAnalysis } from "../types";
import { isMarketOpenIST } from "../data/sessionFeed";

const DIR = path.join(process.cwd(), "data", "oi-log");
const COLS = [
  "date", "timeIST", "epoch", "symbol", "name", "spot", "pcr", "oiDir", "oiScore",
  "putPct", "callPct", "bestR", "bestS", "immR", "immS",
  "scalp5", "scalp15", "dir1h", "mood15", "mood1h",
  "rvol", "volState", "volBreak", "provider",
];

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}
function csvPath(date: string) {
  return path.join(DIR, `oi-${date}.csv`);
}
function jsonPath(symbol: string) {
  return path.join(DIR, `last-${symbol.replace(/[^A-Za-z0-9]/g, "_")}.json`);
}
function esc(v: any) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function istParts(epoch = Date.now()) {
  const d = new Date(epoch + 19800000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), epoch: Math.floor(epoch / 1000) };
}

const lastWrite = new Map<string, number>();

export function saveLastOiJson(symbol: string, oi: OiAnalysis) {
  try {
    ensure();
    fs.writeFileSync(jsonPath(symbol), JSON.stringify(oi));
  } catch { /* ignore */ }
}

export function loadLastOiJson(symbol: string): OiAnalysis | null {
  try {
    return JSON.parse(fs.readFileSync(jsonPath(symbol), "utf-8"));
  } catch { return null; }
}

export function appendOiExcel(grid: any, provider: string) {
  if (!grid || !grid.available) return;
  if (!isMarketOpenIST()) return;
  const now = Date.now();
  const prev = lastWrite.get(grid.symbol) || 0;
  if (now - prev < 4 * 60 * 1000) return; // at most ~5 min
  lastWrite.set(grid.symbol, now);
  const t = istParts(now);
  const W = grid.walls || {};
  const B = grid.bulletin || {};
  const V = grid.volume || {};
  const volBreak = V.available && V.breakout ? `${V.breakout}${V.breakoutConfirmed ? "+" : "?"}` : "";
  const mood = reviewMoodFromFile(grid.symbol, t.date, B);
  const row = [
    t.date, t.time, t.epoch, grid.symbol, grid.name, grid.spot, grid.pcr, grid.oiDirection, grid.oiMoveScore,
    W.putPct, W.callPct, W.bestR?.strike, W.bestS?.strike, W.immR?.strike, W.immS?.strike,
    B.scalp5?.dir, B.scalp15?.dir, B.dir1h?.dir, mood.mood15, mood.mood1h,
    V.available ? V.rvol : "", V.available ? V.state : "N/A", volBreak, provider,
  ].map(esc).join(",");
  try {
    ensure();
    const file = csvPath(t.date);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "\uFEFF" + COLS.join(",") + "\r\n");
    fs.appendFileSync(file, row + "\r\n");
  } catch { /* ignore */ }
}

export function readOiExcel(date: string): any[] {
  const file = csvPath(date);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const o: any = {};
    header.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}

export function reviewMoodFromFile(symbol: string, date: string, liveBull: any): {
  mood15: string; mood1h: string; saved15: string; saved1h: string; live15: string; live1h: string; rows: number; file: string;
} {
  let rows = readOiExcel(date).filter((r) => r.symbol === symbol);
  let used = date;
  if (!rows.length) {
    try {
      const files = fs.readdirSync(DIR).filter((f) => /^oi-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
      const last = files[files.length - 1];
      if (last) {
        used = last.slice(3, 13);
        rows = readOiExcel(used).filter((r) => r.symbol === symbol);
      }
    } catch { /* none */ }
  }
  const last = rows[rows.length - 1];
  const live15 = liveBull?.scalp15?.dir || "—";
  const live1h = liveBull?.dir1h?.dir || "—";
  const saved15 = last?.scalp15 || "—";
  const saved1h = last?.dir1h || "—";
  if (!rows.length) {
    return {
      mood15: "15m scalp: no Excel yet — first print Mon–Fri 09:15–15:30 IST",
      mood1h: "1h directional: no Excel yet — compare starts after first save",
      saved15: "—", saved1h: "—", live15, live1h, rows: 0, file: csvPath(used),
    };
  }
  const shift = (saved: string, live: string, tf: string) => {
    if (saved === "—" && live === "—") return `${tf}: no print yet`;
    if (saved === live) return `${tf}: mood held ${live} (saved Excel = live)`;
    if (live === "FLAT" || live === "—") return `${tf}: saved ${saved} → live WAIT (chop / after hours)`;
    if (saved === "FLAT" || saved === "—") return `${tf}: new ${live} vs empty save`;
    return `${tf}: mood changed ${saved} → ${live}`;
  };
  return {
    mood15: shift(saved15, live15, "15m scalp"),
    mood1h: shift(saved1h, live1h, "1h directional"),
    saved15, saved1h, live15, live1h,
    rows: rows.length,
    file: csvPath(used),
  };
}
