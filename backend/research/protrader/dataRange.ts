// The research data range: from the first 2024 chunk to the LATEST day that has been downloaded (the daily refresh at 15:50
// adds each session), so every ProTrader backtest runs on everything available.
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../../config/dataDir";

export const RAW_DIRS = { NIFTY: path.join(DATA_DIR, "research-nifty20", "raw1m"), SENSEX: path.join(DATA_DIR, "research-multi", "SENSEX", "raw1m") };
export const FROM = "2024-10-01";
/** Latest chunk end date present for BOTH indices (file names are `<from>_<to>_<side>_<rel>.json`). */
export function latestRawDay(): string {
  const last = (dir: string) => { try { return fs.readdirSync(dir).map((f) => f.split("_")[1]).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().pop() ?? "2026-10-16"; } catch { return "2026-10-16"; } };
  const a = last(RAW_DIRS.NIFTY), b = last(RAW_DIRS.SENSEX);
  return a < b ? a : b;
}
