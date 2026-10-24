// Data audit for the 15–60 point research (owner's final brief, 2026-10-25). Research only. Usage: npx tsx dataAudit.ts
// For NIFTY / BANKNIFTY / SENSEX: sessions available, minutes per session, ATM option availability at every 5-min close,
// OI / IV presence, detected expiry days (straddle collapse) by weekday.
import { assemble, DayData } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { expiryDays } from "../premiumBacktest2";

export const FROM = "2024-10-14", TO = "2026-10-23";
export const STEP = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 } as const;
export function load(ix: keyof typeof STEP): DayData[] { return ix === "NIFTY" ? assemble(FROM, TO).days : assembleIndex(ix, FROM, TO); }
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);

if (require.main === module) {
  for (const ix of ["NIFTY", "BANKNIFTY", "SENSEX"] as const) {
    const all = load(ix), ds = all.filter((d) => d.spot.size >= 300), step = STEP[ix];
    let checks = 0, atmCE = 0, atmPE = 0, oi = 0, iv = 0; const short: string[] = [];
    for (const d of ds) {
      const sp = [...d.spot.entries()].filter(([t]) => mn(t) >= 555 && mn(t) < 930); if (sp.length < 370) short.push(`${d.day}(${sp.length})`);
      for (const [t, p] of sp) { if ((mn(t) - 555) % 5 !== 4 || mn(t) < 570 || mn(t) > 870) continue; checks++; const k = Math.round(p / step) * step;
        const ce = (d.legs.get(`${k}CE`) || []).find((m) => m.t === t), pe = (d.legs.get(`${k}PE`) || []).find((m) => m.t === t);
        if (ce) atmCE++; if (pe) atmPE++; if (ce?.oi != null) oi++; if (ce?.iv) iv++; }
    }
    const exp = [...expiryDays(ds, step)].sort(), wd = new Map<string, number>(); for (const e of exp) { const w = new Date(e + "T00:00:00Z").toUTCString().slice(0, 3); wd.set(w, (wd.get(w) || 0) + 1); }
    console.log(`${ix}: sessions ${ds.length} (${ds[0]?.day} → ${ds[ds.length - 1]?.day}), dropped (<300 spot minutes) ${all.length - ds.length}`);
    console.log(`  sessions with < 370 index minutes: ${short.length}${short.length ? " — " + short.slice(0, 8).join(", ") + (short.length > 8 ? " …" : "") : ""}`);
    console.log(`  ATM option present at 5-min closes 09:30–14:30: CE ${((atmCE / checks) * 100).toFixed(1)}% · PE ${((atmPE / checks) * 100).toFixed(1)}% · CE OI ${((oi / checks) * 100).toFixed(1)}% · CE IV ${((iv / checks) * 100).toFixed(1)}% (of ${checks})`);
    console.log(`  detected expiry days ${exp.length}: by weekday ${[...wd.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  process.exit(0);
}
