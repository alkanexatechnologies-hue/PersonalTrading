import { Candle } from "../types";

// ---- Move-timing profile ----
// From historical 15m candles: WHEN (time of day) does the market move the most,
// how big is that move, and how does the most-active window shift on a weekly /
// monthly basis. Answers "which timeframe moves most and how it changes".

const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istHM = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const WIN_START = 9 * 60 + 30; // 09:30
const WIN_END = 15 * 60; // 15:00 (3 PM) - bars at/after 3 PM are excluded

export interface SlotStat {
  slot: string; // HH:MM (15m bar start, IST)
  avgRangePct: number; // avg (high-low)/open % for that slot across all days
  avgAbsRetPct: number; // avg |close-open|/open %
  samples: number;
}
export interface PeriodStat {
  label: string; // week (Monday date) or month (YYYY-MM)
  days: number;
  avgDailyRangePct: number; // avg full-day (high-low)/open %
  peakSlot: string; // most-active 15m slot in that period
  peakSlotRangePct: number;
}
export interface WeekdayStat {
  day: string; // Monday..Friday
  avgDailyRangePct: number;
  days: number;
}
export interface MoveTimingResult {
  symbol: string;
  name: string;
  period: "weekly" | "monthly";
  intradayProfile: SlotStat[]; // ordered by time of day
  mostActive: SlotStat[]; // top 3 slots
  quietest: SlotStat | null;
  byWeekday: WeekdayStat[]; // Monday..Friday
  periods: PeriodStat[];
  summary: string;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = (date: string) => DAY_NAMES[new Date(date + "T00:00:00Z").getUTCDay()];

function mondayOf(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const off = (d.getUTCDay() + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - off);
  return d.toISOString().slice(0, 10);
}

export function computeMoveTiming(symbol: string, name: string, candles15m: Candle[], period: "weekly" | "monthly" = "weekly"): MoveTimingResult | null {
  if (!candles15m || candles15m.length < 100) return null;

  // Group bars by day.
  const byDay = new Map<string, Candle[]>();
  for (const c of candles15m) {
    const d = istDateOf(c.time);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(c);
  }

  // Intraday slot profile (avg range% per time-of-day slot).
  const slotAgg = new Map<string, { range: number; abs: number; n: number }>();
  // Per-day metrics for period grouping.
  const dayMetrics: { date: string; rangePct: number; peakSlot: string; peakRange: number }[] = [];

  for (const [date, barsUnsorted] of byDay) {
    // Only the 09:30-15:00 window.
    const bars = barsUnsorted.slice().sort((a, b) => a.time - b.time).filter((b) => { const m = istMin(b.time); return m >= WIN_START && m < WIN_END; });
    if (!bars.length) continue;
    let dHigh = -Infinity, dLow = Infinity;
    const dOpen = bars[0].open;
    let peakSlot = "", peakRange = -1;
    for (const b of bars) {
      if (b.high > dHigh) dHigh = b.high;
      if (b.low < dLow) dLow = b.low;
      const slot = istHM(b.time);
      const rangePct = b.open ? ((b.high - b.low) / b.open) * 100 : 0;
      const absPct = b.open ? (Math.abs(b.close - b.open) / b.open) * 100 : 0;
      const cur = slotAgg.get(slot) || { range: 0, abs: 0, n: 0 };
      cur.range += rangePct; cur.abs += absPct; cur.n += 1;
      slotAgg.set(slot, cur);
      if (rangePct > peakRange) { peakRange = rangePct; peakSlot = slot; }
    }
    const dayRangePct = dOpen ? ((dHigh - dLow) / dOpen) * 100 : 0;
    dayMetrics.push({ date, rangePct: dayRangePct, peakSlot, peakRange: round2(peakRange) });
  }

  const intradayProfile: SlotStat[] = [...slotAgg.entries()]
    .map(([slot, v]) => ({ slot, avgRangePct: round2(v.range / v.n), avgAbsRetPct: round2(v.abs / v.n), samples: v.n }))
    .sort((a, b) => (a.slot < b.slot ? -1 : 1));
  const byActivity = intradayProfile.slice().sort((a, b) => b.avgRangePct - a.avgRangePct);
  const mostActive = byActivity.slice(0, 3);
  const quietest = byActivity.length ? byActivity[byActivity.length - 1] : null;

  // Period grouping (weekly / monthly).
  const groups = new Map<string, { date: string; rangePct: number; peakSlot: string; peakRange: number }[]>();
  for (const dm of dayMetrics) {
    const key = period === "weekly" ? mondayOf(dm.date) : dm.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(dm);
  }
  const periods: PeriodStat[] = [...groups.entries()]
    .map(([label, days]) => {
      const avgDailyRangePct = round2(days.reduce((s, d) => s + d.rangePct, 0) / days.length);
      // Most-active slot in the period = the slot that was the day's peak most often.
      const peakCount = new Map<string, { count: number; sumRange: number }>();
      for (const d of days) {
        const c = peakCount.get(d.peakSlot) || { count: 0, sumRange: 0 };
        c.count += 1; c.sumRange += d.peakRange; peakCount.set(d.peakSlot, c);
      }
      let peakSlot = "", best = -1, peakSlotRangePct = 0;
      for (const [slot, c] of peakCount) { if (c.count > best) { best = c.count; peakSlot = slot; peakSlotRangePct = round2(c.sumRange / c.count); } }
      return { label, days: days.length, avgDailyRangePct, peakSlot, peakSlotRangePct };
    })
    .sort((a, b) => (a.label < b.label ? -1 : 1));

  // By day of week (Monday..Friday): which weekday moves most.
  const wdAgg = new Map<string, { sum: number; n: number }>();
  for (const dm of dayMetrics) {
    const wd = weekdayOf(dm.date);
    const c = wdAgg.get(wd) || { sum: 0, n: 0 };
    c.sum += dm.rangePct; c.n += 1; wdAgg.set(wd, c);
  }
  const byWeekday: WeekdayStat[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    .filter((d) => wdAgg.has(d))
    .map((d) => ({ day: d, avgDailyRangePct: round2(wdAgg.get(d)!.sum / wdAgg.get(d)!.n), days: wdAgg.get(d)!.n }));
  const topDay = byWeekday.slice().sort((a, b) => b.avgDailyRangePct - a.avgDailyRangePct)[0];

  const top = mostActive[0];
  const trendDir = periods.length >= 2 ? (periods[periods.length - 1].avgDailyRangePct - periods[0].avgDailyRangePct) : 0;
  const summary =
    `Most active time-of-day: ${top ? top.slot + " (avg " + top.avgRangePct + "% range/bar)" : "-"}. ` +
    `Quietest: ${quietest ? quietest.slot + " (" + quietest.avgRangePct + "%)" : "-"}. ` +
    `Most active weekday: ${topDay ? topDay.day + " (" + topDay.avgDailyRangePct + "%)" : "-"}. ` +
    `Daily volatility is ${trendDir > 0.1 ? "RISING" : trendDir < -0.1 ? "FALLING" : "stable"} ${period === "weekly" ? "week-over-week" : "month-over-month"} ` +
    `(${periods.length ? periods[0].avgDailyRangePct : 0}% -> ${periods.length ? periods[periods.length - 1].avgDailyRangePct : 0}%).`;

  return { symbol, name, period, intradayProfile, mostActive, quietest, byWeekday, periods, summary };
}
