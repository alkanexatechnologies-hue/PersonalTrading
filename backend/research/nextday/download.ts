import fs from "fs";
import path from "path";
import { unzipFirst } from "../../oi/oiReconcile";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Next-day study — official NSE daily data (research only) ============================
// For every weekday: the F&O bhavcopy (kept rows: NIFTY index options + index futures) and the index close file
// (kept rows: Nifty 50, India VIX). Saved per day; a day NSE has no file for (holiday) is recorded as missing.
// Polite: one request at a time with a pause. No Dhan calls.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const ND_DIR = path.join(DATA_DIR, "research-nextday");
export const FO_DIR = path.join(ND_DIR, "fo"), IDX_DIR = path.join(ND_DIR, "idx");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } as any, signal: AbortSignal.timeout(30_000) });
      if (r.status === 404) return null;
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch { /* retry */ }
    await sleep(3000 * (a + 1));
  }
  throw new Error(`download failed: ${url}`);
}
export function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
}
export async function downloadDay(day: string): Promise<"ok" | "holiday" | "cached"> {
  const fo = path.join(FO_DIR, `${day}.csv`), ix = path.join(IDX_DIR, `${day}.csv`), miss = path.join(ND_DIR, "missing.json");
  const missing: string[] = fs.existsSync(miss) ? JSON.parse(fs.readFileSync(miss, "utf8")) : [];
  if (fs.existsSync(fo) && fs.existsSync(ix)) return "cached";
  if (missing.includes(day)) return "holiday";
  const z = await get(`https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${day.replace(/-/g, "")}_F_0000.csv.zip`);
  if (!z) { missing.push(day); fs.mkdirSync(ND_DIR, { recursive: true }); fs.writeFileSync(miss, JSON.stringify(missing)); return "holiday"; }
  const L = unzipFirst(z).toString("utf8").split("\n"), h = L[0].split(","), sym = h.indexOf("TckrSymb"), tp = h.indexOf("FinInstrmTp");
  const keep = [L[0], ...L.slice(1).filter((l) => { const c = l.split(","); return c[sym] === "NIFTY" && (c[tp] === "IDO" || c[tp] === "IDF"); })];
  await sleep(700);
  const [y, m, d] = day.split("-"), ib = await get(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${d}${m}${y}.csv`);
  if (!ib) throw new Error(`index close file missing for trading day ${day}`);
  const IL = ib.toString("utf8").split("\n"), ikeep = [IL[0], ...IL.slice(1).filter((l) => /^"?(Nifty 50|India VIX)"?,/i.test(l))];
  fs.mkdirSync(FO_DIR, { recursive: true }); fs.mkdirSync(IDX_DIR, { recursive: true });
  fs.writeFileSync(fo, keep.join("\n")); fs.writeFileSync(ix, ikeep.join("\n"));
  return "ok";
}
if (require.main === module) {
  (async () => {
    const [from, to] = [process.argv[2] || "2024-10-01", process.argv[3] || "2026-10-14"];
    const days = weekdays(from, to); let n = 0;
    for (const d of days) {
      const r = await downloadDay(d); n++;
      if (r !== "cached") await sleep(800);
      if (n % 25 === 0 || r === "holiday") console.log(`${n}/${days.length} ${d} ${r}`);
    }
    console.log("done");
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
