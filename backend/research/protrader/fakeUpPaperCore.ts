// Pure parts of the fake-up PAPER TEST (fakeUpPaper.ts): which grid events are paper signals, how a signal is laid out,
// the scoreboard and the Telegram note. No I/O — unit-tested in fakeUpPaperCore.test.ts.
export const PAPER_START = "2026-10-26";
export const VERDICT_AT = 30;

export interface GridEvent {
  day: string; src: string; dir: number; t: number; lvl: number; px: number; stop: number; atr: number; atm: number;
  premIn: number | null; p0: number | null; f: Record<string, boolean>;
  r0: { win: boolean; loss: boolean; r: number } | null;
}
export interface PaperSignal {
  index: string; day: string; time: string; level: number; entry: number; stop: number; target: number;
  result: "TARGET" | "STOP" | "TIME"; r: number; strike: string; premIn: number | null; premPct: number | null;
}
export interface Score { n: number; target: number; stop: number; time: number; accuracy: number | null; avgR: number | null; avgPremPct: number | null }

const r2 = (x: number) => Math.round(x * 100) / 100, r1 = (x: number) => Math.round(x * 10) / 10;
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);

/** The rule: 5-min FAKE-UP (dir −1) at an OWNER level, with call writing and an earlier touch, entered at the confirming close. */
export function isPaperSignal(e: GridEvent, start = PAPER_START): boolean {
  return e.day >= start && e.src === "OWNER" && e.dir === -1 && !!e.r0 && !!e.f.write && !!e.f.retest;
}

/** Lay out one signal; the stop distance is floored at 0.25 × ATR exactly as the backtest scores it (1 : 1 target). */
export function toSignal(index: string, e: GridEvent): PaperSignal {
  const d = Math.max(e.stop - e.px, 0.25 * e.atr);
  return { index, day: e.day, time: hm(e.t), level: Math.round(e.lvl), entry: r2(e.px), stop: r2(e.px + d), target: r2(e.px - d),
    result: e.r0!.win ? "TARGET" : e.r0!.loss ? "STOP" : "TIME", r: r2(e.r0!.r), strike: `${e.atm} PE`, premIn: e.premIn, premPct: e.p0 == null ? null : r1(e.p0) };
}

/** Accuracy = targets ÷ (targets + stops); time exits count in avg R but not in accuracy. */
export function scoreBoard(sig: PaperSignal[]): Score {
  const w = sig.filter((x) => x.result === "TARGET").length, l = sig.filter((x) => x.result === "STOP").length, pp = sig.filter((x) => x.premPct != null);
  return { n: sig.length, target: w, stop: l, time: sig.length - w - l, accuracy: w + l ? Math.round((w / (w + l)) * 100) : null,
    avgR: sig.length ? r2(sig.reduce((a, x) => a + x.r, 0) / sig.length) : null, avgPremPct: pp.length ? r1(pp.reduce((a, x) => a + x.premPct!, 0) / pp.length) : null };
}

const sgn = (x: number) => (x >= 0 ? "+" : "");
const fmtScore = (s: Score) => s.n
  ? `${s.n} signals · ${s.target} target / ${s.stop} stop / ${s.time} time · accuracy ${s.accuracy ?? "—"}% · avg ${sgn(s.avgR!)}${s.avgR}R · ATM PE ${s.avgPremPct == null ? "—" : sgn(s.avgPremPct) + s.avgPremPct + "%"}`
  : "no signals yet";
const ICON = { TARGET: "✅", STOP: "❌", TIME: "⏱" } as const;

/** The daily Telegram note: today's signals (or "no signal") and the scoreboard since the start. */
export function paperHtml(day: string, sig: PaperSignal[], start = PAPER_START): string {
  const today = sig.filter((x) => x.day === day), all = scoreBoard(sig);
  return [`📝 <b>PAPER TEST · FAKE-UP at owner S/R + call writing</b> · ${day}`,
    `<i>Paper only, not a trade. Judged after ~${VERDICT_AT} signals (backtest: right 61–81% vs 54–55% baseline).</i>`,
    today.length ? `<b>Today</b>` : `Today: no signal`,
    ...today.map((x) => `${x.index === "SENSEX" ? "🟣" : "🔵"} ${x.index} ${x.time} · failed breakout at ${x.level} · BUY ${x.strike} @ ${x.premIn ?? "—"} · index entry ${x.entry} SL ${x.stop} T ${x.target} → ${ICON[x.result]} ${x.result} (${sgn(x.r)}${x.r}R, premium ${x.premPct == null ? "—" : sgn(x.premPct) + x.premPct + "%"})`),
    `<b>Scoreboard since ${start}</b>`,
    `  🔵 NIFTY: ${fmtScore(scoreBoard(sig.filter((x) => x.index === "NIFTY")))}`,
    `  🟣 SENSEX: ${fmtScore(scoreBoard(sig.filter((x) => x.index === "SENSEX")))}`,
    `  Total: ${fmtScore(all)}${all.n >= VERDICT_AT ? " · <b>30+ signals: ready for ProTrader's verdict</b>" : ` · ${VERDICT_AT - all.n} more to the verdict`}`].join("\n");
}
