import fs from "fs";
import path from "path";
import { assemble, istHm, type DayData } from "./data";
import { expiryFor } from "./costs";
import { context, familySignals, ALL_ON, type Flags } from "./signals";
import { runDay, stats, bootstrapLB, type TradeLog, type SimParams } from "./sim";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Research runner (follows PREREGISTRATION.md) ============================
export const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-12"] } as const;
export type PeriodName = keyof typeof PERIODS;
// Family default filters, fixed before results: reversal families (B, C) trade against the short-term trend by design,
// so the 15-minute "regime must not oppose" filter is off for them; trend family D has the regime built into its rule.
export const FAMILY_FLAGS: Record<string, Flags> = {
  BASE: { ...ALL_ON, candle: false, regime15: false, noFailedBreak: false, oiCover: false },
  A: ALL_ON, B: { ...ALL_ON, regime15: false }, C: { ...ALL_ON, regime15: false }, D: { ...ALL_ON, regime15: false }, E: ALL_ON,
};
const OUT = path.join(DATA_DIR, "research-nifty20", "results");

export function audit(days: DayData[], st: any) {
  let mins = 0, legMins = 0, zeroVol = 0, gaps20 = 0, gapsN = 0, oiRuns: number[] = [], expiryDays = 0;
  const perDay: number[] = [];
  for (const d of days) {
    perDay.push(d.spot.size); mins += d.spot.size; if (expiryFor(d.day).isExpiryDay) expiryDays++;
    for (const a of d.legs.values()) {
      let run = 1;
      for (let i = 0; i < a.length; i++) {
        legMins++; if (!a[i].v) zeroVol++;
        if (i && a[i].t - a[i - 1].t === 60) { gapsN++; if (Math.abs(a[i].o - a[i - 1].c) / a[i - 1].c > 0.2) gaps20++; }
        if (i && a[i].oi === a[i - 1].oi) run++; else { if (i) oiRuns.push(run); run = 1; }
      }
    }
  }
  perDay.sort((a, b) => a - b); oiRuns.sort((a, b) => a - b);
  return {
    tradingDays: days.length, first: days[0]?.day, last: days[days.length - 1]?.day, expiryDays,
    spotMinutesPerDay: { min: perDay[0], median: perDay[Math.floor(perDay.length / 2)], expected: 375 }, daysUnder300SpotMinutes: perDay.filter((x) => x < 300).length,
    legMinutes: legMins, zeroVolumeLegMinutes: zeroVol, zeroVolumePct: Math.round((zeroVol / legMins) * 10000) / 100,
    oneMinOpenGapOver20pct: gaps20, oneMinConsecutivePairs: gapsN, oneMinGapPct: Math.round((gaps20 / gapsN) * 10000) / 100,
    oiRepeatMinutes: { median: oiRuns[Math.floor(oiRuns.length / 2)], p90: oiRuns[Math.floor(oiRuns.length * 0.9)] },
    assembly: st,
  };
}

export function inPeriod(day: string, p: PeriodName) { const [a, b] = PERIODS[p]; return day >= a && day <= b; }
export function runFamily(ctx: ReturnType<typeof context>, family: string, p: SimParams, period: PeriodName, flags?: Flags): TradeLog[] {
  const trades: TradeLog[] = [];
  for (const d of ctx.days) if (inPeriod(d.day, period)) trades.push(...runDay(d, familySignals(ctx, d.day, family, flags || FAMILY_FLAGS[family]), p));
  return trades;
}
export function csv(trades: TradeLog[]) {
  const cols: (keyof TradeLog)[] = ["day", "family", "side", "strike", "expiry", "isExpiryDay", "lot", "signalHm", "entryHm", "entry", "exitHm", "exit", "why", "gross", "net", "mfe", "mae", "minsHeld", "minsToTarget", "spotAtSignal", "note"];
  return [cols.join(","), ...trades.map((t) => cols.map((c) => { const v = t[c] as any; return v == null ? "" : /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v); }).join(","))].join("\n");
}
export function save(name: string, data: any) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), typeof data === "string" ? data : JSON.stringify(data, null, 1)); }
export function loadAll() { const a = assemble(PERIODS.DEV[0], PERIODS.HOLDOUT[1]); return { a, ctx: context(a.days) }; }
export const nDays = (ctx: ReturnType<typeof context>, p: PeriodName) => ctx.days.filter((d) => inPeriod(d.day, p)).length;
export { stats, bootstrapLB, istHm };
