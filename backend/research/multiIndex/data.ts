import fs from "fs";
import path from "path";
import { dhanFetch } from "../../data/dhanClient";
import { loadDhanConfig } from "../../data/dhanConfig";
import { DATA_DIR } from "../../config/dataDir";
import { monthChunks, istDay, DayData, Min, Side } from "../nifty20/data";

// ============================ Multi-index history (same format as the NIFTY study, research only) ============================
// Dhan /charts/rollingoption, 1-minute, ATM−3…ATM+3 CE/PE with OI/IV/spot. Monthly expiries for BANKNIFTY / FINNIFTY /
// MIDCPNIFTY (weeklies ended Nov 2024), weekly for SENSEX. Approximate constant lot sizes (only the ₹40 brokerage per
// round trip depends on it — per-unit costs barely move).
export const INDICES = {
  BANKNIFTY: { securityId: 25, seg: "NSE_FNO", flag: "MONTH", step: 100, lot: 30 },
  FINNIFTY: { securityId: 27, seg: "NSE_FNO", flag: "MONTH", step: 50, lot: 65 },
  MIDCPNIFTY: { securityId: 442, seg: "NSE_FNO", flag: "MONTH", step: 25, lot: 120 },
  SENSEX: { securityId: 51, seg: "BSE_FNO", flag: "WEEK", step: 100, lot: 20 },
} as const;
export type IndexName = keyof typeof INDICES;
const dir = (n: IndexName) => path.join(DATA_DIR, "research-multi", n, "raw1m");
const FIELDS = ["open", "high", "low", "close", "strike", "spot", "oi", "iv", "volume"];

async function fetchRaw(n: IndexName, from: string, to: string, side: Side, rel: number) {
  const f = path.join(dir(n), `${from}_${to}_${side}_${rel}.json`);
  if (fs.existsSync(f)) return;
  const c = INDICES[n], cfg = loadDhanConfig(), strike = rel === 0 ? "ATM" : rel > 0 ? `ATM+${rel}` : `ATM${rel}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2500 * attempt));
    try {
      const r = await dhanFetch("/charts/rollingoption", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
        body: { exchangeSegment: c.seg, interval: "1", securityId: c.securityId, instrument: "OPTIDX", expiryFlag: c.flag, expiryCode: 1, strike, drvOptionType: side === "CE" ? "CALL" : "PUT", requiredData: FIELDS, fromDate: from, toDate: to } });
      const j: any = await r.json().catch(() => null), x = j?.data?.[side === "CE" ? "ce" : "pe"];
      if (r.ok && x && Array.isArray(x.timestamp)) { fs.mkdirSync(dir(n), { recursive: true }); fs.writeFileSync(f, JSON.stringify(x)); return; }
      if (r.ok && j && !x) { fs.mkdirSync(dir(n), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ timestamp: [], open: [], high: [], low: [], close: [], strike: [], spot: [], oi: [], iv: [], volume: [] })); return; }
    } catch { /* retry */ }
  }
  console.error(`failed ${n} ${from} ${side} ${rel}`);
}
export async function download(n: IndexName, from: string, to: string, workers = 4) {
  const jobs: [string, string, Side, number][] = [];
  for (const [a, b] of monthChunks(from, to)) for (const s of ["CE", "PE"] as Side[]) for (let r = -3; r <= 3; r++) jobs.push([a, b, s, r]);
  let next = 0, done = 0;
  const w = async () => { while (next < jobs.length) { const j = jobs[next++]; await fetchRaw(n, ...j); done++; if (done % 50 === 0) console.log(`${n} ${done}/${jobs.length}`); } };
  await Promise.all(Array.from({ length: workers }, w));
}
export function assembleIndex(n: IndexName, from: string, to: string): DayData[] {
  const byDay = new Map<string, DayData>();
  for (const [a, b] of monthChunks(from, to)) for (const s of ["CE", "PE"] as Side[]) for (let r = -3; r <= 3; r++) {
    let d: any; try { d = JSON.parse(fs.readFileSync(path.join(dir(n), `${a}_${b}_${s}_${r}.json`), "utf8")); } catch { continue; }
    (d.timestamp || []).forEach((t: number, i: number) => {
      const day = istDay(t), dd = byDay.get(day) || { day, spot: new Map(), legs: new Map(), expiryGuess: null };
      if (d.spot[i] > 0) dd.spot.set(t, d.spot[i]);
      if (d.close[i] > 0) { const k = `${d.strike[i]}${s}`, arr = dd.legs.get(k) || []; if (!arr.length || arr[arr.length - 1].t !== t) arr.push({ t, o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i], v: d.volume?.[i] ?? null, oi: d.oi?.[i] ?? null, iv: d.iv?.[i] ?? null } as Min); dd.legs.set(k, arr); }
      byDay.set(day, dd);
    });
  }
  const days = [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
  for (const d of days) for (const arr of d.legs.values()) arr.sort((x, y) => x.t - y.t);
  return days;
}
if (require.main === module) {
  (async () => { for (const n of (process.argv[2] ? [process.argv[2]] : Object.keys(INDICES)) as IndexName[]) { console.log("downloading", n); await download(n, "2024-10-14", "2026-10-12"); } console.log("done"); })();
}
