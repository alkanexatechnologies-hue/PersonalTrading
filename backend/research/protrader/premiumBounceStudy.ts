// ProTrader PREMIUM BOUNCE study: when an option premium starts moving up from its support zone, how often does it close
// through the resistance zone above (before breaking support)? Real Dhan 1-minute premiums (ATM ± 3, nearest weekly expiry),
// NIFTY and SENSEX, ~2 years. One contract = one strike + side inside one expiry week; its 1-minute bars are joined into
// 15-min candles across the week's days and the zones are built exactly as on the screen (premiumZones).
// Writes data/research-premium-bounce/<INDEX>.json (read by the Hot premiums rating). Usage: npx tsx premiumBounceStudy.ts
import fs from "fs";
import path from "path";
import { assemble, DayData } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { expiryDays } from "./premiumBacktest2";
import { DATA_DIR } from "../../config/dataDir";
import { bounceEvents, bounceStudy, BounceEvent, PBar } from "../../premium/premiumBounce";

const OUT = path.join(DATA_DIR, "research-premium-bounce");
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
export function eventsOf(days: DayData[], step: number): BounceEvent[] {
  const ds = days.filter((d) => d.spot.size >= 300), exp = expiryDays(ds, step), expSorted = [...exp].sort();
  const weekOf = (day: string) => expSorted.find((e) => e >= day) ?? "open";
  const series = new Map<string, PBar[]>(), spotAt = new Map<number, number>();
  for (const d of ds) {
    for (const [t, p] of d.spot) spotAt.set(t, p);
    for (const [k, mins] of d.legs) {
      const key = `${weekOf(d.day)}|${k}`, arr = series.get(key) || [];
      for (const m of mins) {
        if (mn(m.t) < 555 || mn(m.t) >= 930) continue;
        const bt = Math.floor((m.t + 19800) / 900) * 900 - 19800, last = arr[arr.length - 1];
        if (last && last.time === bt) { last.high = Math.max(last.high, m.h); last.low = Math.min(last.low, m.l); last.close = m.c; }
        else arr.push({ time: bt, open: m.o, high: m.h, low: m.l, close: m.c });
      }
      series.set(key, arr);
    }
  }
  const out: BounceEvent[] = [];
  for (const [key, cs] of series) {
    const k = key.split("|")[1], side = k.slice(-2) as "CE" | "PE", strike = Number(k.slice(0, -2));
    // a 15-min bar built from only a few minutes (the strike moved in / out of ATM ± 3) is not a real candle
    const full = cs.filter((c) => c.high > 0 && c.low > 0);
    out.push(...bounceEvents(full, { side, strike, step, expiryDays: exp, spotAt: (t) => spotAt.get(t + 840) ?? spotAt.get(t) ?? null }));
  }
  return out.sort((a, b) => a.time - b.time);
}
if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const to = latestRawDay();
  for (const [name, days, step] of [["NIFTY", assemble(FROM, to).days, 50], ["SENSEX", assembleIndex("SENSEX", FROM, to), 100]] as const) {
    const ev = eventsOf(days, step), st = bounceStudy(name, ev);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(st, null, 1));
    const A = st.buckets.ALL;
    console.log(`${name}: ${st.events} bounces ${st.from}→${st.to} · PASS ${A.passPct}% (dev ${A.devPass} / val ${A.valPass}) · FAIL ${A.failPct}% · touched R ${A.touchRPct}% · median best gain ${A.medGainPct}%`);
    for (const [k, b] of Object.entries(st.buckets).filter(([k]) => !k.includes("|S:")).sort((a, b) => a[0].localeCompare(b[0]))) console.log("  ", k.padEnd(34), "n", String(b.n).padStart(5), "pass", String(b.passPct).padStart(3) + "%", "fail", String(b.failPct).padStart(3) + "%", "dev/val", b.devPass, "/", b.valPass);
  }
  process.exit(0);
}
