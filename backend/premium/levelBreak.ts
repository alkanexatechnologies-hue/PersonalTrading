// ============================ Support / resistance BREAK candles (5-min and 15-min) — one detector for live AND backtest ============================
// BREAKOUT  = a CLOSED candle closes ABOVE a resistance level by more than 0.05·ATR, after the previous candle closed at or below it.
// BREAKDOWN = a CLOSED candle closes BELOW a support level by more than 0.05·ATR, after the previous candle closed at or above it.
// Each level breaks once per direction per day. The break candle is graded:
//   STRONG = body ≥ 60% of its range · closed in the outer 25% (top for a breakout, bottom for a breakdown) · range ≥ 0.7·ATR
//   WEAK   = body < 35% of its range, or closed in the wrong half of its range
//   NORMAL = everything else
// Outcome (backtest only, future candles): FOLLOW-THROUGH = price went 1·ATR beyond the break close before any close back
// across the level; FAILED = closed back across the level first; STALLED = neither within the horizon. Reporting only.

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface Lvl { price: number; label: string; kind: string }
export type Grade = "STRONG" | "NORMAL" | "WEAK";

export function candleGrade(c: Bar, atr: number, dir: "UP" | "DOWN") {
  const rng = c.high - c.low || 1e-9, body = Math.abs(c.close - c.open) / rng;
  const loc = dir === "UP" ? (c.close - c.low) / rng : (c.high - c.close) / rng;   // 1 = closed at the extreme in the break direction
  const withBody = dir === "UP" ? c.close >= c.open : c.close <= c.open;
  const rAtr = rng / (atr || rng);
  const grade: Grade = withBody && body >= 0.6 && loc >= 0.75 && rAtr >= 0.7 ? "STRONG" : body < 0.35 || loc < 0.5 || !withBody ? "WEAK" : "NORMAL";
  return { grade, bodyPct: Math.round(body * 100), closeLocPct: Math.round(loc * 100), rangeAtr: Math.round(rAtr * 100) / 100 };
}

/** Breaks among `bars` (one session, closed candles only, in order). */
export function detectBreaks(bars: Bar[], levels: Lvl[], atr: number) {
  const out: { dir: "UP" | "DOWN"; level: Lvl; index: number; bar: Bar; q: ReturnType<typeof candleGrade> }[] = [];
  const seen = new Set<string>(), tol = 0.05 * atr;
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], c = bars[i];
    for (const l of levels) {
      if (c.close > l.price + tol && p.close <= l.price && !seen.has(`U${l.price}`)) { seen.add(`U${l.price}`); out.push({ dir: "UP", level: l, index: i, bar: c, q: candleGrade(c, atr, "UP") }); }
      if (c.close < l.price - tol && p.close >= l.price && !seen.has(`D${l.price}`)) { seen.add(`D${l.price}`); out.push({ dir: "DOWN", level: l, index: i, bar: c, q: candleGrade(c, atr, "DOWN") }); }
    }
  }
  return out;
}

/** What happened after a break (backtest): follow-through / failed / stalled within `horizon` candles, plus MFE / MAE. */
export function breakOutcome(bars: Bar[], i: number, level: number, dir: "UP" | "DOWN", atr: number, horizon: number) {
  const s = dir === "UP" ? 1 : -1, c0 = bars[i].close; let mfe = 0, mae = 0, res: "FOLLOW-THROUGH" | "FAILED" | "STALLED" = "STALLED";
  for (let k = i + 1; k < Math.min(bars.length, i + 1 + horizon); k++) {
    const b = bars[k];
    mfe = Math.max(mfe, s > 0 ? b.high - c0 : c0 - b.low); mae = Math.max(mae, s > 0 ? c0 - b.low : b.high - c0);
    if (mfe >= atr) { res = "FOLLOW-THROUGH"; break; }
    if (s * (b.close - level) < 0) { res = "FAILED"; break; }
  }
  return { res, mfe: Math.round(mfe * 10) / 10, mae: Math.round(mae * 10) / 10 };
}

const esc = (x: any) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
/** Telegram alert for one break, with the backtest record of the same timeframe + direction + candle grade. */
export function breakAlertMsg(name: string, tf: "5m" | "15m", b: ReturnType<typeof detectBreaks>[number], tfMin: number, rec: { n: number; ft: number; failed: number } | null, next: Lvl | null) {
  const up = b.dir === "UP", nm = esc(String(name).replace(" 50", "")), span = `${hm(b.bar.time)}–${hm(b.bar.time + tfMin * 60)}`;
  const L = [`${up ? "🚀" : "🔻"} <b>${nm} · ${tf === "5m" ? "5-MIN" : "15-MIN"} ${up ? "BREAKOUT" : "BREAKDOWN"}</b> · ${span}`];
  L.push(`Closed <b>${n0(b.bar.close)}</b> ${up ? "above resistance" : "below support"} <b>${n0(b.level.price)}</b> <i>${esc(b.level.label)}</i>`);
  L.push(`Candle: <b>${b.q.grade}</b> — body ${b.q.bodyPct}% · closed at ${b.q.closeLocPct}% toward the ${up ? "high" : "low"} · range ${b.q.rangeAtr}× ATR`);
  if (rec && rec.n >= 10) L.push(`📊 Backtest (Dhan, ${tf} ${up ? "breakouts" : "breakdowns"}, ${b.q.grade} candle): followed through <b>${rec.ft}/${rec.n} (${Math.round((rec.ft / rec.n) * 100)}%)</b> · failed ${rec.failed}`);
  else if (rec) L.push(`📊 Backtest: only ${rec.n} past cases of this kind — too few to judge`);
  if (next) L.push(`Next ${up ? "resistance" : "support"}: <b>${n0(next.price)}</b> <i>${esc(next.label)}</i>`);
  L.push(b.q.grade === "WEAK" ? `⚠️ <b>WEAK break candle</b> — wait for the next ${tf} close to hold ${up ? "above" : "below"} ${n0(b.level.price)}; a close back ${up ? "below" : "above"} it = failed break.`
    : `Hold ${up ? "above" : "below"} ${n0(b.level.price)} = break valid · <b>a ${tf} close back ${up ? "below" : "above"} it = failed break</b>.`);
  L.push(`<i>Information only — the plan's 15-min trigger and the review decide trades.</i>`);
  return L.join("\n");
}
