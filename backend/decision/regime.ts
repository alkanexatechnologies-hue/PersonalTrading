// ============================================================================
// REGIME — context only, never a trade trigger. Built from EXISTING blocks:
//   • gatedTrend (strategies/regimeGate.ts) — the validated trend definition
//     (sustained VWAP side + stacked EMA9/21/50 + EMA9 slope + |move| ≥ 0.6×daily ATR
//      + ATR expanding)
//   • detectMarketStructure (liquidity/orderBlock.ts) — confirmed direction change
//   • ATR ratio (14-bar ATR / its 20-bar mean) for expansion / compression
// Classification per CLOSED 5m bar, priority:
//   TREND_UP / TREND_DOWN  gatedTrend true
//   REVERSAL               structure directionChange.stage === "Confirmed" within the last 3 bars
//   EXPANSION              ATR ratio ≥ 1.4
//   RANGE                  ATR ratio < 0.85 (compressed)
//   TRANSITION             otherwise
// Hysteresis: a new label must hold for 2 consecutive closed bars before it
// replaces the current one (the walk restarts each session, so it is
// deterministic and reproducible — no hidden memory).
// ============================================================================

import { Candle } from "../types";
import { atr } from "../indicators";
import { gatedTrend } from "../strategies/regimeGate";
import { detectMarketStructure } from "../liquidity/orderBlock";
import { Regime, SessionPhase } from "./types";

export const REGIME_HOLD_BARS = 2;
const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
export const istMin = (t: number) => Math.floor(((t + 19800) % 86400) / 60);

export function sessionPhase(minuteIST: number): SessionPhase {
  if (minuteIST < 9 * 60 + 15) return "PRE_OPEN";
  if (minuteIST < 9 * 60 + 45) return "OPEN";
  if (minuteIST < 11 * 60 + 30) return "MORNING";
  if (minuteIST < 13 * 60 + 30) return "MIDDAY";
  if (minuteIST < 14 * 60) return "LATE";
  if (minuteIST < 15 * 60 + 30) return "CLOSING";
  return "CLOSED";
}

interface RawRegime { label: Regime; evidence: string[]; atrRatio: number | null }

function rawAt(c5: Candle[], i: number, a14: (number | null)[], dailyAtr: number | null): RawRegime {
  const upto = c5.slice(0, i + 1);
  const d = istDate(c5[i].time);
  const dayOpen = upto.find((c) => istDate(c.time) === d)?.open ?? null;
  const vals = a14.slice(Math.max(0, i - 19), i + 1).filter((v): v is number => v != null);
  const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  const atrRatio = a14[i] != null && avg ? Math.round((a14[i]! / avg) * 100) / 100 : null;
  const gt = gatedTrend(upto.slice(-120), dailyAtr, dayOpen);
  if (gt.trend && gt.dir) return { label: gt.dir === "up" ? "TREND_UP" : "TREND_DOWN", evidence: [gt.note], atrRatio };
  let dc: any = null;
  try { const ms = detectMarketStructure(upto.slice(-120), 3); dc = ms.directionChange; } catch { dc = null; }
  if (dc && dc.stage === "Confirmed") {
    // only a FRESH change counts: the confirming break must be within the last 3 bars
    try {
      const ms = detectMarketStructure(upto.slice(-120), 3);
      const conf = ms.bosEvents.filter((b: any) => b.stage === "Confirmed");
      const lastB = conf[conf.length - 1];
      if (lastB && lastB.breakIndex >= Math.min(120, upto.length) - 3) {
        return { label: "REVERSAL", evidence: [`Structure flipped ${dc.from} → ${dc.to} (confirmed BOS ${lastB.level})`], atrRatio };
      }
    } catch { /* ignore */ }
  }
  if (atrRatio != null && atrRatio >= 1.4) return { label: "EXPANSION", evidence: [`ATR ${atrRatio}× its 20-bar mean`], atrRatio };
  if (atrRatio != null && atrRatio < 0.85) return { label: "RANGE", evidence: [`ATR ${atrRatio}× its 20-bar mean (compressed)`], atrRatio };
  return { label: "TRANSITION", evidence: [gt.note, atrRatio != null ? `ATR ratio ${atrRatio}` : "ATR n/a"], atrRatio };
}

/** Regime for the LAST bar of `c5` (all bars must be closed), with hysteresis over today's session. */
export function regimeAt(c5: Candle[], dailyAtr: number | null): { regime: Regime | null; evidence: string[]; atrRatio: number | null; atr: number | null; raw: Regime | null } {
  const n = c5.length;
  if (n < 30) return { regime: null, evidence: ["Not enough closed candles"], atrRatio: null, atr: null, raw: null };
  const a14 = atr(c5, 14);
  const today = istDate(c5[n - 1].time);
  let start = n - 1;
  while (start > 0 && istDate(c5[start - 1].time) === today) start--;
  let cur: RawRegime | null = null, pending: Regime | null = null, pendingCount = 0, last: RawRegime | null = null;
  for (let i = Math.max(start, 30); i < n; i++) {
    const r = rawAt(c5, i, a14, dailyAtr);
    last = r;
    if (!cur) { cur = r; continue; }
    if (r.label === cur.label) { cur = r; pending = null; pendingCount = 0; continue; }
    if (r.label === pending) pendingCount++; else { pending = r.label; pendingCount = 1; }
    if (pendingCount >= REGIME_HOLD_BARS) { cur = r; pending = null; pendingCount = 0; }
  }
  if (!cur || !last) return { regime: null, evidence: ["Session too young for a regime read"], atrRatio: null, atr: a14[n - 1] ?? null, raw: null };
  const ev = cur.label === last.label ? cur.evidence : [...cur.evidence, `(raw ${last.label} not yet held ${REGIME_HOLD_BARS} bars)`];
  return { regime: cur.label, evidence: ev, atrRatio: last.atrRatio, atr: a14[n - 1] ?? null, raw: last.label };
}
