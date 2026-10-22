// ============================ 🎓 CHART SCHOOL — replay any day candle by candle with a teacher's narration ============================
// Pure, rule-based, NO look-ahead: the lesson at candle i uses only the candles up to i and the levels known before the day
// (previous day high / low / close, classic pivots, previous week high / low, round numbers). Every statistic it quotes comes from
// the app's own studies of real Dhan data (passed in) — nothing is invented. Text is written to be read aloud.
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface Level { price: number; label: string; kind: "PREV DAY" | "PIVOT" | "WEEK" | "ROUND" }
export interface Step { i: number; time: number; kind: string; text: string; level?: number | null; marker?: { position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown" | "circle"; text: string } }
export interface GapStatLite { n: number; fill1015: number; fillClose: number; cont50: number; closeWithGap: number; holds930: { n: number; cont50: number }; against930: { n: number; fillPct: number } }

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60), hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const n0 = (v: number) => Math.round(v).toLocaleString("en-IN"), pts = (v: number) => `${n0(Math.abs(v))} points`;

/** Join 5-min bars into `minutes`-min bars aligned to 09:15. */
export function resample(b: Bar[], minutes: number): Bar[] {
  if (minutes <= 5) return b;
  const out: Bar[] = [];
  for (const x of b) { const slot = Math.floor((mn(x.time) - 555) / minutes), last = out[out.length - 1];
    if (last && Math.floor((mn(last.time) - 555) / minutes) === slot) { last.high = Math.max(last.high, x.high); last.low = Math.min(last.low, x.low); last.close = x.close; }
    else out.push({ ...x }); }
  return out;
}
/** The levels a trader knows before the day starts. */
export function dayLevels(prev: { high: number; low: number; close: number }, prevWeek: { high: number; low: number } | null, roundStep: number, atr: number): Level[] {
  const pp = (prev.high + prev.low + prev.close) / 3, L: Level[] = [
    { price: prev.high, label: "previous day high", kind: "PREV DAY" }, { price: prev.low, label: "previous day low", kind: "PREV DAY" }, { price: prev.close, label: "previous close", kind: "PREV DAY" },
    { price: 2 * pp - prev.low, label: "R1 pivot", kind: "PIVOT" }, { price: 2 * pp - prev.high, label: "S1 pivot", kind: "PIVOT" },
    { price: pp + (prev.high - prev.low), label: "R2 pivot", kind: "PIVOT" }, { price: pp - (prev.high - prev.low), label: "S2 pivot", kind: "PIVOT" }];
  if (prevWeek) L.push({ price: prevWeek.high, label: "previous week high", kind: "WEEK" }, { price: prevWeek.low, label: "previous week low", kind: "WEEK" });
  for (let p = Math.ceil((prev.close - 1.5 * atr) / roundStep) * roundStep; p <= prev.close + 1.5 * atr; p += roundStep) L.push({ price: p, label: "round number", kind: "ROUND" });
  // drop a round number sitting on another level (one name per place)
  return L.filter((x, i) => x.kind !== "ROUND" || !L.some((y, j) => j !== i && y.kind !== "ROUND" && Math.abs(y.price - x.price) < 0.05 * atr)).map((x) => ({ ...x, price: Math.round(x.price * 100) / 100 }));
}

export interface LessonIn { index: string; day: string; interval: number; bars: Bar[]; prevBars: Bar[]; prev: { high: number; low: number; close: number }; prevWeek: { high: number; low: number } | null;
  atrDaily: number; roundStep: number; gap?: GapStatLite | null; gapGroup?: string | null }
/** The lesson for one day: the candles, the levels and one teaching step per notable candle. */
export function buildLesson(o: LessonIn) {
  const bars = resample(o.bars, o.interval), levels = dayLevels(o.prev, o.prevWeek, o.roundStep, o.atrDaily), steps: Step[] = [];
  const prevRanges = resample(o.prevBars, o.interval).map((x) => x.high - x.low), say = (i: number, kind: string, text: string, extra: Partial<Step> = {}) => steps.push({ i, time: bars[i].time, kind, text, ...extra });
  const avgRange = (i: number) => { const r = [...prevRanges, ...bars.slice(0, i).map((x) => x.high - x.low)].slice(-20); return r.length ? r.reduce((a, x) => a + x, 0) / r.length : o.atrDaily / 10; };
  // level tests in progress (one per level)
  const tests = new Map<number, { from: "above" | "below"; start: number; brokeAt: number | null; label: string; price: number }>();
  let dayHi = -Infinity, dayLo = Infinity, vwSum = 0, aboveVw: boolean | null = null, lastNote = -9;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1], rng = c.high - c.low, body = Math.abs(c.close - c.open), avg = avgRange(i), up = c.close >= c.open;
    vwSum += (c.high + c.low + c.close) / 3; const vw = vwSum / (i + 1), t = hm(c.time);
    let said = false;
    // --- the open
    if (i === 0) {
      const gap = c.open - o.prev.close, g = gap / o.atrDaily;
      say(0, "open", `${o.index} opens at ${n0(c.open)}, ${Math.abs(g) < 0.15 ? "almost flat" : gap > 0 ? `${pts(gap)} above yesterday's close — a gap up` : `${pts(gap)} below yesterday's close — a gap down`}. ` +
        `Before trading, mark the levels: yesterday's high ${n0(o.prev.high)}, low ${n0(o.prev.low)} and close ${n0(o.prev.close)}. ` +
        (o.gap && o.gapGroup && o.gapGroup !== "FLAT" ? `On the ${o.gap.n} past days with a gap like this, the gap was filled the same day only ${o.gap.fillClose} percent of the time, and price went another half day-range in the gap's direction ${o.gap.cont50} percent of the time. So do not assume it comes straight back. ` : "") +
        `Rule one: nothing counts until the first fifteen minutes are over.`, { marker: { position: "aboveBar", color: "#2962ff", shape: "circle", text: "OPEN" } });
      said = true;
    }
    // --- 09:30: the stand
    const end930 = o.interval >= 15 ? mn(c.time) === 555 : mn(c.time) === 565;
    if (end930) {   // the candle that closes at 09:30 (5-min: the 09:25 candle; 15-min: the first candle)
      const open = bars[0].open, below = c.close < open, gdn = (o.gapGroup || "").includes("DOWN"), gup = (o.gapGroup || "").includes("UP");
      let rule = "";
      if (o.gap && (gdn || gup)) { const holds = gdn ? below : !below; rule = holds ? ` It is still on the gap's side of the open. In the past, when that happened, price went another half day-range ${o.gap.holds930.cont50} percent of the time.` : ` It is back across the open. In the past, the gap was then filled ${o.gap.against930.fillPct} percent of the time.`; }
      say(i, "0930", `It is nine thirty. The first fifteen minutes made a range from ${n0(Math.min(...bars.slice(0, i + 1).map((x) => x.low)))} to ${n0(Math.max(...bars.slice(0, i + 1).map((x) => x.high)))}, and price is ${below ? "below" : "above"} the open.${rule} This is where a professional decides the direction for the day.`,
        { marker: { position: below ? "aboveBar" : "belowBar", color: "#ff9800", shape: "circle", text: "9:30" } });
      said = true;
    }
    // --- level tests: touch → held / rejected, broke, fake break (sweep), confirmed break
    const tol = 0.15 * avg;
    for (const L of levels) {
      const tr = tests.get(L.price), from: "above" | "below" | null = p ? (p.close > L.price + tol ? "above" : p.close < L.price - tol ? "below" : null) : (c.open > L.price ? "above" : "below");
      if (!tr) {
        if (from === "above" && c.low <= L.price + tol) tests.set(L.price, { from, start: i, brokeAt: null, label: L.label, price: L.price });
        else if (from === "below" && c.high >= L.price - tol) tests.set(L.price, { from, start: i, brokeAt: null, label: L.label, price: L.price });
        else continue;
        const T = tests.get(L.price)!, role = T.from === "above" ? "support" : "resistance";
        if (i - lastNote >= 1) { say(i, "test", `At ${t}, price comes down to test the ${L.label} at ${n0(L.price)}`.replace("comes down", T.from === "above" ? "comes down" : "rises") + ` — ${role}. Do not act on the touch. Watch how this candle and the next ones close.`, { level: L.price }); said = true; lastNote = i; }
        continue;
      }
      const s = tr.from === "above" ? -1 : 1, beyond = s * (c.close - tr.price) > tol, away = tr.from === "above" ? c.close - tr.price : tr.price - c.close;
      if (tr.brokeAt == null && beyond) {
        tr.brokeAt = i;
        say(i, "break", `This candle closed ${s < 0 ? "below" : "above"} the ${tr.label} at ${n0(tr.price)}. A close beyond a level is a break — but many breaks fail. The safe trade is to wait for a retest from the other side, not to chase this candle.`, { level: tr.price, marker: { position: s < 0 ? "aboveBar" : "belowBar", color: "#ef5350", shape: s < 0 ? "arrowDown" : "arrowUp", text: "break" } });
        said = true; lastNote = i; continue;
      }
      if (tr.brokeAt != null && i - tr.brokeAt <= 3 && s * (c.close - tr.price) < -tol) {
        say(i, "sweep", `Look — price closed back ${s < 0 ? "above" : "below"} the ${tr.label} within ${i - tr.brokeAt} candle${i - tr.brokeAt > 1 ? "s" : ""}. That was a fake break: a liquidity sweep. Traders who sold the break are now trapped, and their stops fuel the move the other way. This is the kind of set-up you wait for.`, { level: tr.price, marker: { position: s < 0 ? "belowBar" : "aboveBar", color: "#26a69a", shape: s < 0 ? "arrowUp" : "arrowDown", text: "sweep" } });
        tests.delete(tr.price); said = true; lastNote = i; continue;
      }
      if (tr.brokeAt != null && s * (c.close - tr.price) >= avg) {
        say(i, "confirmed", `The break of the ${tr.label} is now confirmed: price moved a full candle-size beyond it. ${tr.from === "above" ? `The old support becomes resistance — a flip zone. The entry is a pull-back up to ${n0(tr.price)} that gets rejected, a short, with the stop just above it.` : `The old resistance becomes support — a flip zone. The entry is a dip back to ${n0(tr.price)} that holds, a long, with the stop just below it.`}`, { level: tr.price });
        tests.delete(tr.price); said = true; lastNote = i; continue;
      }
      if (tr.brokeAt == null && away >= avg) {
        say(i, "held", tr.from === "above" ? `The ${tr.label} at ${n0(tr.price)} held as support: price bounced a full candle-size without a close below it. Buyers defended it. A higher low here is a long idea with the stop below the low.` : `The ${tr.label} at ${n0(tr.price)} rejected price: it fell a full candle-size without a close above. Sellers defended it.`, { level: tr.price, marker: { position: tr.from === "above" ? "belowBar" : "aboveBar", color: "#26a69a", shape: tr.from === "above" ? "arrowUp" : "arrowDown", text: tr.from === "above" ? "held" : "rejected" } });
        tests.delete(tr.price); said = true; lastNote = i; continue;
      }
      if (i - tr.start > 12) tests.delete(tr.price);
    }
    // --- VWAP side
    const nowAbove = c.close > vw;
    if (aboveVw != null && nowAbove !== aboveVw && i >= 3 && !said) { say(i, "vwap", `Price closed ${nowAbove ? "above" : "below"} the day's average price, about ${n0(vw)}. ${nowAbove ? "Buyers" : "Sellers"} now have the upper hand on the day — but on its own a cross is close to a coin flip, so use it as context, not as an entry.`); said = true; lastNote = i; }
    aboveVw = nowAbove;
    // --- new day high / low after the first half hour
    if (i > 0 && mn(c.time) >= 585 && !said) {
      if (c.high > dayHi && c.close > dayHi) { say(i, "newhigh", `A new high of the day at ${n0(c.high)}. Strength — but a professional does not buy the new high. Wait for the pull-back that holds.`, { marker: { position: "aboveBar", color: "#26a69a", shape: "circle", text: "HOD" } }); said = true; lastNote = i; }
      else if (c.low < dayLo && c.close < dayLo) { say(i, "newlow", `A new low of the day at ${n0(c.low)}. Weakness — but do not sell the new low. Wait for the bounce that fails.`, { marker: { position: "belowBar", color: "#ef5350", shape: "circle", text: "LOD" } }); said = true; lastNote = i; }
    }
    // --- candle shapes worth a note (honest: alone they are ~50/50)
    if (!said && rng >= 1.5 * avg && body >= 0.7 * rng) { say(i, "momentum", `A big ${up ? "green" : "red"} momentum candle, one and a half times the normal size. It looks powerful, but in two years of NIFTY data such candles carried on only about half the time — often the next candles give some of it back.`); said = true; lastNote = i; }
    else if (!said && p && rng >= avg) {
      const lw = Math.min(c.open, c.close) - c.low, uw = c.high - Math.max(c.open, c.close);
      if (lw >= 0.6 * rng) { say(i, "wick", `A long lower wick: sellers pushed price down to ${n0(c.low)} and buyers pushed it back. At a support level this matters; in the middle of nowhere it is noise.`); said = true; lastNote = i; }
      else if (uw >= 0.6 * rng) { say(i, "wick", `A long upper wick: buyers pushed to ${n0(c.high)} and sellers rejected it. At a resistance level this is a warning for longs.`); said = true; lastNote = i; }
    }
    // --- hourly recap
    if (!said && i > 3 && mn(c.time) >= 615 && (mn(c.time) - 555) % 60 === 0) {   // every hour from 10:15
      say(i, "recap", `Recap at ${t}: the range so far is ${n0(Math.min(dayLo, c.low))} to ${n0(Math.max(dayHi, c.high))}, price is ${nowAbove ? "above" : "below"} the average price, and ${c.close > bars[0].open ? "above" : "below"} the open. ${Math.abs(c.close - bars[0].open) < 0.15 * o.atrDaily ? "Not much progress — a range day; the middle pays nobody." : "There is a clear direction today."}`);
      said = true; lastNote = i;
    }
    dayHi = Math.max(dayHi, c.high); dayLo = Math.min(dayLo, c.low);
  }
  // --- end of day lesson
  if (bars.length) {
    const L = bars[bars.length - 1], move = L.close - bars[0].open, held = steps.filter((s) => s.kind === "held").length, sw = steps.filter((s) => s.kind === "sweep").length, br = steps.filter((s) => s.kind === "confirmed").length;
    say(bars.length - 1, "end", `The day ends at ${n0(L.close)}, ${pts(move)} ${move >= 0 ? "above" : "below"} the open, with a range of ${pts(dayHi - dayLo)}. Today the levels gave ${held} clean hold${held === 1 ? "" : "s"} or rejection${held === 1 ? "" : "s"}, ${sw} liquidity sweep${sw === 1 ? "" : "s"} and ${br} confirmed break${br === 1 ? "" : "s"}. ` +
      `The lesson: mark the levels first, decide the direction at nine thirty, and enter only on a reaction at a level — a sweep or a retest — with the stop just beyond it. The candle alone is a coin flip; the level and the reaction give you the edge.`);
  }
  // at most two lessons per candle (the most instructive), so the voice keeps pace; open / 09:30 / end always stay
  const PRI: Record<string, number> = { open: 0, "0930": 0, end: 0, sweep: 1, confirmed: 2, held: 3, break: 4, newhigh: 5, newlow: 5, test: 6, vwap: 7, momentum: 8, wick: 8, recap: 9 };
  const keep = new Set<Step>(); const byI = new Map<number, Step[]>(); for (const st of steps) (byI.get(st.i) || byI.set(st.i, []).get(st.i)!).push(st);
  for (const arr of byI.values()) { const must = arr.filter((x) => PRI[x.kind] === 0), rest = arr.filter((x) => PRI[x.kind] !== 0).sort((a, b) => (PRI[a.kind] ?? 9) - (PRI[b.kind] ?? 9)); for (const x of [...must, ...rest.slice(0, Math.max(0, 2 - must.length))]) keep.add(x); }
  return { index: o.index, day: o.day, interval: o.interval, candles: bars, levels, steps: steps.filter((x) => keep.has(x)), atrDaily: Math.round(o.atrDaily), prev: o.prev };
}
