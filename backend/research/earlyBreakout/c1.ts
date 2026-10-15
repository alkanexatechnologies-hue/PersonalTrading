import fs from "fs";
import path from "path";
import { assemble } from "../nifty20/data";
import { analyse } from "./trendday";
import { DATA_DIR } from "../../config/dataDir";

// Confirmatory test C1 (TRENDDAY_PREREGISTRATION.md): E5 breakouts closing at/after 10:00, taken only when the 10:00
// detector score ≥ 3 and the trade side equals the day direction D. `--holdout` opens HOLDOUT (only if DEV and VAL pass).
const open = process.argv.includes("--holdout");
const { days } = assemble("2024-10-14", "2026-10-12");
const { feats } = analyse(days, []);
const fd = new Map(feats.map((f) => [f.day, f]));
const L = fs.readFileSync(path.join(DATA_DIR, "research-early-breakout", "trades.csv"), "utf8").trim().split("\n"), h = L[0].split(",");
const rows = L.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [h[i], v]))) as any[];
const pick = (p: string) => rows.filter((r) => r.period === p && r.sig === "E5" && r.sigTime >= "10:00").filter((r) => { const f = fd.get(r.day); return f && f.score >= 3 && (r.side === "CE" ? 1 : -1) === f.D; });
function st(x: any[]) {
  const n = x.length; if (!n) return { n: 0 };
  const nets = x.map((r) => Number(r.net)), tot = nets.reduce((s, v) => s + v, 0);
  const byDay = [...x.reduce((m, r) => m.set(r.day, [...(m.get(r.day) || []), Number(r.net)]), new Map<string, number[]>()).values()];
  let s = 11; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648), ms: number[] = [];
  for (let i = 0; i < 2000; i++) { let sum = 0, c = 0; for (let k = 0; k < byDay.length; k++) for (const v of byDay[Math.floor(rnd() * byDay.length)]) { sum += v; c++; } ms.push(sum / c); }
  ms.sort((a, b) => a - b);
  return { n, winPct: Math.round((nets.filter((v) => v > 0).length / n) * 1000) / 10, avgNet: Math.round((tot / n) * 100) / 100, lb95: Math.round(ms[Math.floor(0.05 * ms.length)] * 100) / 100, totalNet: Math.round(tot) };
}
const out: any = { DEV: st(pick("DEV")), VALIDATION: st(pick("VALIDATION")) };
if (open) out.HOLDOUT = st(pick("HOLDOUT"));
const others = (p: string) => st(rows.filter((r) => r.period === p && r.sig === "E5" && r.sigTime >= "10:00" && !pick(p).includes(r)));
out.compare_other_E5_after_10 = { DEV: others("DEV"), VALIDATION: others("VALIDATION"), ...(open ? { HOLDOUT: others("HOLDOUT") } : {}) };
fs.writeFileSync(path.join(DATA_DIR, "research-early-breakout", open ? "c1_holdout.json" : "c1_dev_val.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
