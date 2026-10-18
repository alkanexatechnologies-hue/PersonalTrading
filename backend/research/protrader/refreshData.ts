// Daily ProTrader data refresh (run by the server at 15:50): download this month's rolling-option 1-minute data (ATM±3
// premiums + spot) up to TODAY for NIFTY and SENSEX, then remove this month's older partial chunks once the new chunk is
// complete. Usage: npx tsx refreshData.ts [YYYY-MM-DD]
import fs from "fs";
import path from "path";
import { downloadAll } from "../nifty20/data";
import { download } from "../multiIndex/data";
import { RAW_DIRS } from "./dataRange";

async function main() {
  const day = process.argv[2] || new Date(Date.now() + 19800000).toISOString().slice(0, 10), from = day.slice(0, 8) + "01";
  await downloadAll(from, day); await download("SENSEX", from, day);
  const out: Record<string, number> = {};
  for (const [name, dir] of Object.entries(RAW_DIRS)) {
    const files = fs.readdirSync(dir), fresh = files.filter((f) => f.startsWith(`${from}_${day}_`));
    out[name] = fresh.length;
    if (fresh.length === 14) for (const f of files) if (f.startsWith(`${from}_`) && !f.startsWith(`${from}_${day}_`)) fs.unlinkSync(path.join(dir, f));
  }
  console.log(JSON.stringify({ ok: out.NIFTY === 14 && out.SENSEX === 14, day, files: out }));
  process.exit(0);
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message || e) })); process.exit(1); });
