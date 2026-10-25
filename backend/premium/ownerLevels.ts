// ============================ OWNER S/R — the owner's way of marking support / resistance ============================
// Horizontal lines where price has TURNED several times: clusters (within 0.2·ATR15) of confirmed 15-min swing highs / lows
// from the previous 5 sessions; a cluster that has been both a high and a low is a FLIP zone. Known before the day starts.
// Moved here from research/protrader/priceActionLevels.ts (unchanged) so Market Command can show the same levels.
// Information only: in the 2-year NIFTY test these levels held about as often as any other level type (≈ coin flip).
import { confirmedSwings } from "./premiumCenter";
import type { Bar, MemLevel } from "./levelMemory";

/** Owner-style levels: clusters (within 0.2·ATR15) of confirmed 15-min swings from the previous 5 sessions. */
export function priceActionLevels(prev15: any[], a15: number): MemLevel[] {
  const sw = confirmedSwings(prev15 as any, 2).sort((a, b) => a.price - b.price), cl: { p: number[]; hi: number; lo: number }[] = [];
  for (const s of sw) { const c = cl[cl.length - 1]; if (c && s.price - c.p[c.p.length - 1] <= 0.2 * a15) { c.p.push(s.price); s.kind === "HIGH" ? c.hi++ : c.lo++; } else cl.push({ p: [s.price], hi: s.kind === "HIGH" ? 1 : 0, lo: s.kind === "LOW" ? 1 : 0 }); }
  return cl.filter((c) => c.p.length >= 2).map((c) => {
    const price = Math.round((c.p.reduce((a, x) => a + x, 0) / c.p.length) * 100) / 100;
    const kind = c.hi && c.lo ? "PA FLIP" : c.p.length >= 3 ? "PA 3+ touches" : "PA 2 touches";
    return { price, kind, label: `${kind} (${c.hi}H/${c.lo}L)` };
  });
}

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
/** ATR 14 as a plain mean of the last 14 true ranges (the research definition). */
function atr14(b: Bar[]): number | null {
  if (b.length < 15) return null; let s = 0;
  for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
  return s / 14;
}
/** Owner S/R for `today` from 15-min candles: only the 5 sessions BEFORE today are used (no look-ahead). */
export function ownerLevelsFor(c15: Bar[], today: string): MemLevel[] {
  const days = [...new Set(c15.map((c) => istDay(c.time)))].filter((d) => d < today).sort().slice(-5);
  if (!days.length) return [];
  const keep = new Set(days), prev15 = c15.filter((c) => keep.has(istDay(c.time))).sort((a, b) => a.time - b.time), a15 = atr14(prev15.slice(-15));
  return prev15.length >= 50 && a15 ? priceActionLevels(prev15, a15) : [];
}
