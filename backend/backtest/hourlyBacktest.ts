import { Candle } from "../types";
import { atr } from "../indicators";
import { computeSignal } from "../signals/engine";

// ---- Hourly prediction check (last N days) ----
// At each hourly slot (9:30,10:30,...,14:30 IST) the system's directional signal
// is computed with NO lookahead, then compared to what the market ACTUALLY did
// over the next hour. Marks each call correct (tick) or wrong (cross) and, when
// wrong, gives a descriptive reason.

const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istHM = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const SLOTS = [9 * 60 + 30, 10 * 60 + 30, 11 * 60 + 30, 12 * 60 + 30, 13 * 60 + 30, 14 * 60 + 30]; // hourly, 9:30-14:30
const SIGNAL_MIN = 15;
const FLAT_PCT = 0.1; // |next-hour move| below this = flat / inconclusive (not a clean win or loss)

export interface HourlyCheck {
  date: string;
  weekday: string;
  time: string;
  direction: "Bullish" | "Bearish" | "None";
  score: number;
  entry: number | null;
  actualMovePct: number; // next-hour net move (signed)
  actualDir: "Up" | "Down" | "Flat";
  correct: boolean | null; // null = no signal / flat
  mark: "correct" | "wrong" | "flat" | "no-signal";
  reason: string;
}
export interface HourlyBacktestResult {
  symbol: string;
  name: string;
  days: number;
  total: number; // directional signals with a meaningful move (correct + wrong)
  correct: number;
  wrong: number;
  flat: number; // signal fired but next hour was flat/inconclusive
  noSignal: number;
  accuracy: number; // % = correct / (correct + wrong)
  checks: HourlyCheck[];
}

export function backtestHourly(symbol: string, name: string, c15: Candle[], daily: Candle[], days = 15): HourlyBacktestResult | null {
  if (!c15 || c15.length < 100) return null;

  const byDate = new Map<string, Candle[]>();
  c15.forEach((c) => { const d = istDateOf(c.time); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d)!.push(c); });
  const idxOf = new Map<number, number>();
  c15.forEach((c, i) => idxOf.set(c.time, i));

  const dates = [...byDate.keys()].sort().slice(-days);
  const checks: HourlyCheck[] = [];

  for (const date of dates) {
    const bars = byDate.get(date)!.slice().sort((a, b) => a.time - b.time);
    const weekday = DAY_NAMES[new Date(date + "T00:00:00Z").getUTCDay()];
    for (const slot of SLOTS) {
      const bar = bars.find((b) => istMin(b.time) === slot);
      if (!bar) continue;
      const idx = idxOf.get(bar.time)!;
      if (idx < 60) continue;
      const sig = computeSignal(symbol, c15.slice(Math.max(0, idx - 199), idx + 1));
      const entry = bar.close;
      // Actual over the next hour (up to 4 bars, capped at 15:00).
      const fwd = bars.filter((b) => b.time > bar.time && istMin(b.time) <= slot + 60 && istMin(b.time) < 15 * 60).slice(0, 4);
      if (!fwd.length) continue;
      const after = fwd[fwd.length - 1].close;
      const actualMovePct = round2(((after - entry) / entry) * 100);
      const actualDir: HourlyCheck["actualDir"] = Math.abs(actualMovePct) < FLAT_PCT ? "Flat" : actualMovePct > 0 ? "Up" : "Down";

      if (Math.abs(sig.score) < SIGNAL_MIN) {
        checks.push({ date, weekday, time: istHM(bar.time), direction: "None", score: sig.score, entry: round2(entry), actualMovePct, actualDir, correct: null, mark: "no-signal", reason: `No signal (score ${sig.score}). Market went ${actualDir}${actualDir !== "Flat" ? " " + Math.abs(actualMovePct) + "%" : ""}.` });
        continue;
      }
      const bull = sig.score > 0;
      const dir: "Bullish" | "Bearish" = bull ? "Bullish" : "Bearish";
      let mark: HourlyCheck["mark"];
      let correct: boolean | null;
      let reason: string;
      if (actualDir === "Flat") {
        // Next hour barely moved - inconclusive, not a clean win or loss.
        mark = "flat"; correct = null;
        reason = `Inconclusive - flat next hour (${actualMovePct}%), no follow-through.` + (Math.abs(sig.score) < 25 ? ` Borderline signal (score ${sig.score}).` : "");
      } else if ((bull && actualDir === "Up") || (!bull && actualDir === "Down")) {
        mark = "correct"; correct = true;
        reason = `Matched: called ${dir}, market moved ${actualDir} ${Math.abs(actualMovePct)}% in the next hour.`;
      } else {
        mark = "wrong"; correct = false;
        reason = `WRONG - price reversed ${actualDir} ${Math.abs(actualMovePct)}% against the ${dir} call.`;
        if (Math.abs(sig.score) < 25) reason += ` Borderline signal (score ${sig.score}).`;
        if (slot >= 11 * 60 + 30 && slot <= 13 * 60 + 30) reason += ` Low-activity midday window.`;
      }
      checks.push({ date, weekday, time: istHM(bar.time), direction: dir, score: sig.score, entry: round2(entry), actualMovePct, actualDir, correct, mark, reason });
    }
  }

  const correct = checks.filter((c) => c.mark === "correct").length;
  const wrong = checks.filter((c) => c.mark === "wrong").length;
  const flat = checks.filter((c) => c.mark === "flat").length;
  const noSignal = checks.filter((c) => c.mark === "no-signal").length;
  const decided = correct + wrong;
  // Newest first for display.
  checks.sort((a, b) => (a.date === b.date ? (a.time < b.time ? 1 : -1) : a.date < b.date ? 1 : -1));
  return {
    symbol, name, days, total: decided, correct, wrong, flat, noSignal,
    accuracy: decided ? Math.round((correct / decided) * 1000) / 10 : 0,
    checks,
  };
}
