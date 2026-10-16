// ============================ Market Diary — the app's memory of each session (pure, no I/O) ============================
// One record per index per day: what the market did (gap, opening range, high/low times, close location, VWAP), a
// descriptive day type, a short timestamped story, and how the plan and the trades played out. Facts only — the day
// type is a description of what happened, never a forecast. Times are 5-minute bar start times (IST).

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface DiaryIn {
  symbol: string; name: string; day: string; bars: Bar[]; prevClose: number;
  vwapClose?: number | null; anchor?: { why: string; rolls: { time: number; ref: number; why: string }[] } | null;
  trades?: { source: string; side: string; strike: number; entryPrem: number | null; exitPrem: number | null; exitWhy?: string; openedAt: number }[];
}
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const r = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number) => r(v).toLocaleString("en-IN");

export function buildDiary(o: DiaryIn) {
  const b = o.bars; if (!b.length || !(o.prevClose > 0)) return null;
  const open = b[0].open, close = b[b.length - 1].close;
  const hiBar = b.reduce((a, x) => (x.high > a.high ? x : a)), loBar = b.reduce((a, x) => (x.low < a.low ? x : a));
  const high = hiBar.high, low = loBar.low, range = high - low || 1;
  const gapPts = open - o.prevClose, gapPct = (gapPts / o.prevClose) * 100;
  const gap = Math.abs(gapPct) < 0.1 ? "FLAT" : gapPts > 0 ? "UP" : "DOWN";
  const fillBar = gap === "UP" ? b.find((x) => x.low <= o.prevClose) : gap === "DOWN" ? b.find((x) => x.high >= o.prevClose) : undefined;
  // opening range = the first 15 minutes; the first CLOSE beyond it after that
  const or = b.filter((x) => x.time < b[0].time + 900), orH = Math.max(...or.map((x) => x.high)), orL = Math.min(...or.map((x) => x.low));
  const after = b.filter((x) => x.time >= b[0].time + 900);
  const orUp = after.find((x) => x.close > orH), orDn = after.find((x) => x.close < orL);
  const orBreak = orUp && (!orDn || orUp.time < orDn.time) ? { dir: "UP", time: orUp.time } : orDn ? { dir: "DOWN", time: orDn.time } : null;
  const closeLoc = (close - low) / range;
  const chg = close - o.prevClose;
  let dayType: string;
  if (gap === "UP" && fillBar && close > open && closeLoc >= 0.7) dayType = "GAP-UP SHAKEOUT → RALLY (V-reversal)";
  else if (gap === "DOWN" && fillBar && close < open && closeLoc <= 0.3) dayType = "GAP-DOWN RELIEF → SELL-OFF (inverted V)";
  else if (gap === "UP" && close < open && closeLoc <= 0.3) dayType = "GAP-UP FADE";
  else if (gap === "DOWN" && close > open && closeLoc >= 0.7) dayType = "GAP-DOWN RECOVERY";
  else if (closeLoc >= 0.75 && close > open) dayType = "TREND UP";
  else if (closeLoc <= 0.25 && close < open) dayType = "TREND DOWN";
  else if (range < 2 * (orH - orL)) dayType = "RANGE (stayed near the opening range)";
  else dayType = "MIXED / TWO-WAY";
  const ev: { t: number; s: string }[] = [{ t: hiBar.time, s: `day high ${fmt(high)}` }, { t: loBar.time, s: `day low ${fmt(low)}` }];
  if (fillBar) ev.push({ t: fillBar.time, s: `gap filled (back to the previous close ${fmt(o.prevClose)})` });
  if (orBreak) ev.push({ t: orBreak.time, s: `first close ${orBreak.dir === "UP" ? "above" : "below"} the opening range (${fmt(orL)}–${fmt(orH)})` });
  ev.sort((a, c) => a.t - c.t);
  const story: string[] = [`${hm(b[0].time)} open ${fmt(open)} (${gap === "FLAT" ? "flat open" : `gap ${gap.toLowerCase()} ${gapPts > 0 ? "+" : ""}${r(gapPts)} pts`})`, ...ev.map((e) => `${hm(e.t)} ${e.s}`)];
  story.push(`close ${fmt(close)} (${chg >= 0 ? "+" : ""}${r(chg)} pts, ${r2((chg / o.prevClose) * 100)}%) at ${r(closeLoc * 100)}% of the day range${o.vwapClose != null ? `, ${close >= o.vwapClose ? "above" : "below"} VWAP ${fmt(o.vwapClose)}` : ""}`);
  const notes: string[] = [];
  if (gap !== "FLAT" && fillBar) { const m = r((fillBar.time - b[0].time) / 60); notes.push(`The ${gap === "UP" ? "gap-up" : "gap-down"} was filled ${m < 5 ? "within the first 5 minutes" : `${m} min after the open`}.`); }
  if (gap !== "FLAT" && !fillBar) notes.push(`The gap was never filled.`);
  if (orBreak) notes.push(`The opening range broke ${orBreak.dir === "UP" ? "up" : "down"} first; the close was ${(orBreak.dir === "UP") === (close > (orH + orL) / 2) ? "in the same direction" : "against it"}.`);
  if (closeLoc >= 0.9) notes.push("Closed at the day high."); else if (closeLoc <= 0.1) notes.push("Closed at the day low.");
  return {
    day: o.day, symbol: o.symbol, name: o.name, prevClose: o.prevClose, open, high, low, close,
    changePts: r2(chg), changePct: r2((chg / o.prevClose) * 100), rangePts: r2(range),
    gap: { dir: gap, pts: r2(gapPts), pct: r2(gapPct), filledAt: fillBar ? hm(fillBar.time) : null },
    highAt: hm(hiBar.time), lowAt: hm(loBar.time),
    openingRange: { high: orH, low: orL, breakDir: orBreak?.dir ?? null, breakAt: orBreak ? hm(orBreak.time) : null },
    closeLocationPct: r(closeLoc * 100), vwapClose: o.vwapClose ?? null, closeVsVwap: o.vwapClose == null ? null : close >= o.vwapClose ? "ABOVE" : "BELOW",
    dayType, story, notes,
    plan: o.anchor ? { why: o.anchor.why, rolls: (o.anchor.rolls || []).map((x) => `${hm(x.time)} ${x.why}`) } : null,
    trades: (o.trades || []).map((t) => ({ ...t, openedAt: hm(t.openedAt), pnlPct: t.entryPrem && t.exitPrem != null ? r((t.exitPrem / t.entryPrem - 1) * 100) : null })),
  };
}
export type DiaryEntry = NonNullable<ReturnType<typeof buildDiary>>;

/** One-screen text of a day's diary (Telegram / API). */
export function diaryText(e: DiaryEntry): string {
  return [`📒 ${e.name} ${e.day} — ${e.dayType}`, `  O ${fmt(e.open)} · H ${fmt(e.high)} (${e.highAt}) · L ${fmt(e.low)} (${e.lowAt}) · C ${fmt(e.close)} (${e.changePct >= 0 ? "+" : ""}${e.changePct}%)`,
    ...e.story.map((s) => `  • ${s}`), ...e.notes.map((s) => `  ✎ ${s}`),
    ...(e.plan ? [`  🧭 Plan: ${e.plan.why}`, ...e.plan.rolls.map((x) => `    ↻ ${x}`)] : []),
    ...(e.trades.length ? e.trades.map((t) => `  ⚑ ${t.source} ${t.strike} ${t.side} ${t.openedAt}: ₹${t.entryPrem ?? "—"} → ₹${t.exitPrem ?? "—"}${t.pnlPct != null ? ` (${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct}%)` : ""}${t.exitWhy ? ` · ${t.exitWhy}` : ""}`) : [])].join("\n");
}
