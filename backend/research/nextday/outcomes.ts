import { Session } from "./data";
import { Call } from "./features";

// ============================ Next-day study — D+1 outcomes (pre-registered, research only) ============================

export interface Outcome {
  day: string; next: string; o1: "UP" | "DOWN" | null; chg: number; gapPct: number;
  o2: "UP" | "DOWN" | "NONE" | "AMBIGUOUS"; o2Source: "1m" | "daily" | "gap" | "none";
  brokeHigh: boolean; brokeLow: boolean; openToClose: number; small: boolean;
}

/** `spot1m`: Dhan 1-minute spot for D+1 (time-ordered prices), or null when not cached. */
export function outcomeFor(D: Session, N: Session, atr: number | null, spot1m: number[] | null): Outcome {
  const chg = N.nifty.c - D.nifty.c, th = atr != null ? 0.5 * atr : null;
  let o2: Outcome["o2"] = "NONE", o2Source: Outcome["o2Source"] = "none";
  if (th != null) {
    const up = D.nifty.c + th, dn = D.nifty.c - th;
    if (N.nifty.o >= up) { o2 = "UP"; o2Source = "gap"; }
    else if (N.nifty.o <= dn) { o2 = "DOWN"; o2Source = "gap"; }
    else {
      const hitU = N.nifty.h >= up, hitD = N.nifty.l <= dn;
      if (hitU !== hitD) { o2 = hitU ? "UP" : "DOWN"; o2Source = "daily"; }
      else if (hitU && hitD) {
        const first = spot1m?.find((p) => p >= up || p <= dn);
        if (first != null) { o2 = first >= up ? "UP" : "DOWN"; o2Source = "1m"; } else o2 = "AMBIGUOUS";
      }
    }
  }
  return { day: D.day, next: N.day, o1: Math.abs(chg) < 1 ? null : chg > 0 ? "UP" : "DOWN", chg, gapPct: (N.nifty.o / D.nifty.c - 1) * 100,
    o2, o2Source, brokeHigh: N.nifty.h > D.nifty.h, brokeLow: N.nifty.l < D.nifty.l, openToClose: N.nifty.c - N.nifty.o,
    small: atr != null && Math.abs(chg) < 0.3 * atr };
}

export const COST_POINTS = 3;
export interface Graded { call: Call; o1Hit: boolean | null; o2Hit: boolean | null; o3Hit: boolean | null; pnl: number | null; neutralHit: boolean | null }
export function grade(call: Call, o: Outcome): Graded {
  const dir = call === "BULLISH" ? "UP" : call === "BEARISH" ? "DOWN" : null;
  if (!dir) return { call, o1Hit: null, o2Hit: null, o3Hit: null, pnl: null, neutralHit: call === "NEUTRAL" ? o.small : null };
  return {
    call,
    o1Hit: o.o1 == null ? null : o.o1 === dir,
    o2Hit: o.o2 === "UP" || o.o2 === "DOWN" ? o.o2 === dir : o.o2 === "NONE" ? false : null,
    o3Hit: dir === "UP" ? o.brokeHigh : o.brokeLow,
    pnl: (dir === "UP" ? 1 : -1) * o.openToClose - COST_POINTS,
    neutralHit: null,
  };
}
