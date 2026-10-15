import fs from "fs";
import path from "path";
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { buildRows } from "../../premium/marketEye";
import { DATA_DIR } from "../../config/dataDir";

// Exports a compact, secret-free bundle of what the research learned, so a server without the raw history (Render) can
// still show Market Eye and the 2-year odds. No credentials, no raw candles — only derived rows and summary statistics.
const OUT = path.join(__dirname);
const prep = (days: any[]) => { const out: any[] = []; let pc: number | null = null; for (const d of days) { const m = [...d.spot.entries()].sort((a: any, b: any) => a[0] - b[0]).filter(([t]: any) => { const k = Math.floor(((t + 19800) % 86400) / 60); return k >= 555 && k <= 929; }); if (pc && m.length) out.push({ day: d.day, minutes: m, prevClose: pc }); if (m.length) pc = m[m.length - 1][1]; } return out; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
for (const [sym, days] of [["NSEI", () => assemble("2024-10-14", "2026-10-12").days], ["BSESN", () => assembleIndex("SENSEX", "2024-10-14", "2026-10-12")]] as const) {
  const rows = buildRows(prep((days as any)()));
  // columnar + rounded: compact on disk
  const cols = { day: rows.map((r) => r.day), min: rows.map((r) => r.min), dayChg: rows.map((r) => r3(r.dayChg)), fromHigh: rows.map((r) => r3(r.fromHigh)), fromLow: rows.map((r) => r3(r.fromLow)), ret30: rows.map((r) => r3(r.ret30)), ret5: rows.map((r) => r3(r.ret5)), next30: rows.map((r) => r3(r.next30)), minNext: rows.map((r) => r3(r.minNext)), maxNext: rows.map((r) => r3(r.maxNext)) };
  fs.writeFileSync(path.join(OUT, `marketEye-${sym}.json`), JSON.stringify(cols));
  console.log(sym, rows.length, "rows");
}
// summary odds (breakout + zero-hero), copied from the results files
const rd = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); } catch { return null; } };
const odds: any = { generated: new Date().toISOString(), early: {}, zeroHero: {} };
const nifty = rd("research-early-breakout/results_dev_val.json"); if (nifty) odds.early.NIFTY = { DEV: nifty.periods.DEV.T15_ALL, VALIDATION: nifty.periods.VALIDATION.T15_ALL };
for (const ix of ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]) { const r = rd(`research-multi/results/${ix}.json`); if (r) odds.early[ix] = { DEV: r.early.T15.DEV, VALIDATION: r.early.T15.VALIDATION }; }
for (const ix of ["NIFTY", "SENSEX"]) { const r = rd(`research-zero-hero/${ix}.json`); if (r) odds.zeroHero[ix] = r; }
fs.writeFileSync(path.join(OUT, "odds.json"), JSON.stringify(odds, null, 1));
console.log("odds:", Object.keys(odds.early).join(","), "| zero-hero:", Object.keys(odds.zeroHero).join(","));
