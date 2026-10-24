// 5-minute candle reaction at a support / resistance level — INFORMATION for the trader, never a signal (owner 2026-10-24).
// Shared by the browser (window.LevelReaction, used by mcx.js on the Key Levels ladder) and the unit test
// (backend/ui/levelReaction.test.ts). Rules, fixed before use:
//   candle  = the last CLOSED 5-minute candle (time + 300 s ≤ now)
//   role    = support if the candle OPENED at / above the level (price came from above), else resistance — fixed per
//             candle, so a level never changes side half-way through a move
//   tol     = max(0.04 % of the level, 0.1 × ATR(14) of the 5-minute candles)
//   support    : close < level − tol → BRK_DN (closed below)
//                low ≤ level + tol and close ≥ level and lower wick ≥ 40 % of the range → REJ_UP (rejection)
//                low ≤ level + tol otherwise → TOUCH (reached, no rejection)
//                else NONE
//   resistance : the mirror (BRK_UP / REJ_DN / TOUCH / NONE)
// A 2-year test (backtest RESULTS_FAKE_AUDIT.md) found a single rejection candle at a level right about as often as a
// random entry with the same stop — so the screen shows it as information only.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LevelReaction = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const WICK = 0.4, EPS = 0.0004, ATR_K = 0.1;
  function atr14(c) {
    if (!c || c.length < 15) return null; let s = 0;
    for (let i = c.length - 14; i < c.length; i++) s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    return s / 14;
  }
  /** The last candle whose 5 minutes are over (all candles count as closed when `closedAll`, e.g. a replay). */
  function lastClosed(candles, nowSec, closedAll) {
    if (!candles || !candles.length) return null;
    for (let i = candles.length - 1; i >= 0; i--) if (closedAll || candles[i].time + 300 <= nowSec) return { candle: candles[i], index: i };
    return null;
  }
  const tolOf = (level, atr) => Math.max(level * EPS, atr != null && isFinite(atr) ? ATR_K * atr : 0);
  /** Reaction of one closed candle at one level. */
  function react(c, level, tol) {
    if (!c || level == null || !isFinite(level)) return { code: "NONE", role: null, wickPct: null };
    const range = c.high - c.low, role = c.open >= level ? "support" : "resistance";
    if (role === "support") {
      const wick = Math.min(c.open, c.close) - c.low, wickPct = range > 0 ? wick / range : 0;
      if (c.close < level - tol) return { code: "BRK_DN", role, wickPct };
      if (c.low <= level + tol) return { code: c.close >= level && wickPct >= WICK ? "REJ_UP" : "TOUCH", role, wickPct };
      return { code: "NONE", role, wickPct };
    }
    const wick = c.high - Math.max(c.open, c.close), wickPct = range > 0 ? wick / range : 0;
    if (c.close > level + tol) return { code: "BRK_UP", role, wickPct };
    if (c.high >= level - tol) return { code: c.close <= level && wickPct >= WICK ? "REJ_DN" : "TOUCH", role, wickPct };
    return { code: "NONE", role, wickPct };
  }
  const LABEL = {
    REJ_UP: { short: "5m REJ ▲", cls: "up", text: "rejection: wick into support, closed back above (buyers defended)" },
    REJ_DN: { short: "5m REJ ▼", cls: "dn", text: "rejection: wick into resistance, closed back below (sellers defended)" },
    BRK_DN: { short: "5m BRK ▼", cls: "dn", text: "closed below support (broken on this candle)" },
    BRK_UP: { short: "5m BRK ▲", cls: "up", text: "closed above resistance (broken on this candle)" },
    TOUCH: { short: "5m TOUCH", cls: "wt", text: "reached the level, no rejection candle (weak wick or close on the level)" },
    NONE: { short: "", cls: "", text: "" },
  };
  return { atr14, lastClosed, tolOf, react, LABEL, WICK, EPS, ATR_K };
});
