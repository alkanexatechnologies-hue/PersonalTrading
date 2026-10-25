// ============================ PREMIUM STRUCTURE — support / resistance of an option PREMIUM series ============================
// R2 / R1 / S2 / S1 from the premium's own confirmed swings, the latest break in its structure (BIOS) and its swing point, from
// the EXISTING market-structure engine run on PREMIUM candles (not the index). Shared by Market Command's option terminal
// (/option-structure, /replay-premium) and the Gold Desk's option column (/api/gold/option). Nothing is fabricated: missing
// values are null.
import { detectMarketStructure } from "../liquidity/orderBlock";
import { vwap } from "../indicators";

export function premiumStructure(candles: any[]) {
  const r2n = (n: number) => Math.round(n * 100) / 100;
  const ms = detectMarketStructure(candles, 3, vwap(candles));
  const cur = candles[candles.length - 1].close;
  const swings = ms.swingPoints.map((p: any) => ({ type: p.type, price: r2n(p.price), time: candles[p.index]?.time ?? null }));
  const highs = swings.filter((s) => s.type === "HH" || s.type === "LH").map((s) => s.price);
  const lows = swings.filter((s) => s.type === "HL" || s.type === "LL").map((s) => s.price);
  const above = [...new Set(highs.filter((p) => p > cur))].sort((a, b) => a - b);
  const below = [...new Set(lows.filter((p) => p < cur))].sort((a, b) => b - a);
  const lastBos = ms.bosEvents.length ? ms.bosEvents[ms.bosEvents.length - 1] : null;
  return {
    available: true,
    current: r2n(cur),
    r1: above[0] ?? null, r2: above[1] ?? null,
    s1: below[0] ?? null, s2: below[1] ?? null,
    swp: swings.length ? swings[swings.length - 1].price : null,
    support: below[0] ?? null,
    resistance: above[0] ?? null,
    bios: lastBos ? {
      price: r2n(lastBos.level),
      time: candles[lastBos.breakIndex]?.time ?? lastBos.breakTime ?? null,
      direction: lastBos.direction === "Bullish" ? "BULLISH" : "BEARISH",
      stage: lastBos.stage,
    } : null,
    structure: ms.currentStructure,
    swings: swings.slice(-8),
  };
}
