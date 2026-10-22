// ============================ 🎓 CHART SCHOOL — replay any day candle by candle with a teacher's narration ============================
// Pure, rule-based, NO look-ahead: the lesson at candle i uses only the candles up to i and the levels known before the day
// (previous day high / low / close, classic pivots, previous week high / low, round numbers). Every statistic it quotes comes from
// the app's own studies of real Dhan data (passed in) — nothing is invented. Each lesson is written in Hindi (Devanagari, read by a
// hi-IN voice) and English, and goes into detail: the candle itself, what it means, and what a professional does next with the
// exact entry trigger, stop loss and target (the next level).
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface Level { price: number; label: string; hi: string; kind: "PREV DAY" | "PIVOT" | "WEEK" | "ROUND" }
export interface Step { i: number; time: number; kind: string; text: string; hi: string; level?: number | null; marker?: { position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown" | "circle"; text: string } }
export interface GapStatLite { n: number; fill1015: number; fillClose: number; cont50: number; closeWithGap: number; holds930: { n: number; cont50: number }; against930: { n: number; fillPct: number } }

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60), hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const n0 = (v: number) => Math.round(v).toLocaleString("en-IN"), h0 = (v: number) => String(Math.round(v));   // Hindi voice reads plain digits best
const pts = (v: number) => `${n0(Math.abs(v))} points`, hpts = (v: number) => `${h0(Math.abs(v))} पॉइंट`;
const hTime = (t: number) => { const [H, M] = hm(t).split(":").map(Number); return M ? `${H > 12 ? H - 12 : H} बजकर ${M} मिनट` : `${H > 12 ? H - 12 : H} बजे`; };

/** Join 5-min bars into `minutes`-min bars aligned to 09:15. */
export function resample(b: Bar[], minutes: number): Bar[] {
  if (minutes <= 5) return b;
  const out: Bar[] = [];
  for (const x of b) { const slot = Math.floor((mn(x.time) - 555) / minutes), last = out[out.length - 1];
    if (last && Math.floor((mn(last.time) - 555) / minutes) === slot) { last.high = Math.max(last.high, x.high); last.low = Math.min(last.low, x.low); last.close = x.close; }
    else out.push({ ...x }); }
  return out;
}
/** The levels a trader knows before the day starts (English + Hindi names). */
export function dayLevels(prev: { high: number; low: number; close: number }, prevWeek: { high: number; low: number } | null, roundStep: number, atr: number): Level[] {
  const pp = (prev.high + prev.low + prev.close) / 3, L: Level[] = [
    { price: prev.high, label: "previous day high", hi: "पिछले दिन का हाई", kind: "PREV DAY" }, { price: prev.low, label: "previous day low", hi: "पिछले दिन का लो", kind: "PREV DAY" },
    { price: prev.close, label: "previous close", hi: "पिछला क्लोज़", kind: "PREV DAY" },
    { price: 2 * pp - prev.low, label: "R1 pivot", hi: "आर-वन पिवट", kind: "PIVOT" }, { price: 2 * pp - prev.high, label: "S1 pivot", hi: "एस-वन पिवट", kind: "PIVOT" },
    { price: pp + (prev.high - prev.low), label: "R2 pivot", hi: "आर-टू पिवट", kind: "PIVOT" }, { price: pp - (prev.high - prev.low), label: "S2 pivot", hi: "एस-टू पिवट", kind: "PIVOT" }];
  if (prevWeek) L.push({ price: prevWeek.high, label: "previous week high", hi: "पिछले हफ़्ते का हाई", kind: "WEEK" }, { price: prevWeek.low, label: "previous week low", hi: "पिछले हफ़्ते का लो", kind: "WEEK" });
  for (let p = Math.ceil((prev.close - 1.5 * atr) / roundStep) * roundStep; p <= prev.close + 1.5 * atr; p += roundStep) L.push({ price: p, label: "round number", hi: "राउंड नंबर", kind: "ROUND" });
  return L.filter((x, i) => x.kind !== "ROUND" || !L.some((y, j) => j !== i && y.kind !== "ROUND" && Math.abs(y.price - x.price) < 0.05 * atr)).map((x) => ({ ...x, price: Math.round(x.price * 100) / 100 }));
}

/** A detailed read of one candle, in both languages. */
export function candleRead(c: Bar, avg: number): { en: string; hi: string } {
  const rng = Math.max(1e-9, c.high - c.low), body = Math.abs(c.close - c.open), up = c.close >= c.open, pos = (c.close - c.low) / rng;
  const lw = Math.min(c.open, c.close) - c.low, uw = c.high - Math.max(c.open, c.close), bp = Math.round((body / rng) * 100), size = rng / Math.max(1e-9, avg);
  const where = pos >= 0.67 ? ["top", "ऊपरी"] : pos <= 0.33 ? ["bottom", "निचले"] : ["middle", "बीच वाले"];
  const sz = size >= 1.5 ? ["a big candle, about " + size.toFixed(1) + " times the normal size", "बड़ी कैंडल, सामान्य से लगभग " + size.toFixed(1) + " गुना"] : size <= 0.6 ? ["a small candle", "छोटी कैंडल"] : ["a normal-size candle", "सामान्य आकार की कैंडल"];
  const wk: [string, string][] = [];
  if (lw >= 0.4 * rng) wk.push(["a long lower wick — buyers pushed back from " + n0(c.low), "नीचे लंबी विक — " + h0(c.low) + " से ख़रीदारों ने वापस धकेला"]);
  if (uw >= 0.4 * rng) wk.push(["a long upper wick — sellers pushed back from " + n0(c.high), "ऊपर लंबी विक — " + h0(c.high) + " से बेचने वालों ने वापस धकेला"]);
  return {
    en: `The candle is ${up ? "green" : "red"}, ${sz[0]}: open ${n0(c.open)}, high ${n0(c.high)}, low ${n0(c.low)}, close ${n0(c.close)}. The body is ${bp} percent of its range and it closed in the ${where[0]} part${wk.length ? ", with " + wk.map((w) => w[0]).join(" and ") : ""}.`,
    hi: `यह ${up ? "हरी" : "लाल"} कैंडल है, ${sz[1]}: ओपन ${h0(c.open)}, हाई ${h0(c.high)}, लो ${h0(c.low)}, क्लोज़ ${h0(c.close)}। बॉडी पूरी रेंज का ${bp} प्रतिशत है और क्लोज़ रेंज के ${where[1]} हिस्से में हुआ${wk.length ? "। इसमें " + wk.map((w) => w[1]).join(" और ") : ""}।`,
  };
}

export interface LessonIn { index: string; day: string; interval: number; bars: Bar[]; prevBars: Bar[]; prev: { high: number; low: number; close: number }; prevWeek: { high: number; low: number } | null;
  atrDaily: number; roundStep: number; gap?: GapStatLite | null; gapGroup?: string | null }
/** The lesson for one day: the candles, the levels and the teaching steps (Hindi + English). */
export function buildLesson(o: LessonIn) {
  const bars = resample(o.bars, o.interval), levels = dayLevels(o.prev, o.prevWeek, o.roundStep, o.atrDaily), steps: Step[] = [];
  const prevRanges = resample(o.prevBars, o.interval).map((x) => x.high - x.low);
  const say = (i: number, kind: string, t: { en: string; hi: string }, extra: Partial<Step> = {}) => steps.push({ i, time: bars[i].time, kind, text: t.en, hi: t.hi, ...extra });
  const avgRange = (i: number) => { const r = [...prevRanges, ...bars.slice(0, i).map((x) => x.high - x.low)].slice(-20); return r.length ? r.reduce((a, x) => a + x, 0) / r.length : o.atrDaily / 10; };
  const nextAbove = (p: number) => levels.filter((l) => l.price > p + 1).sort((a, b) => a.price - b.price)[0] ?? null, nextBelow = (p: number) => levels.filter((l) => l.price < p - 1).sort((a, b) => b.price - a.price)[0] ?? null;
  const tgtUp = (p: number) => { const l = nextAbove(p); return l ? { en: `the next level above, the ${l.label} at ${n0(l.price)}`, hi: `ऊपर का अगला लेवल, ${l.hi} ${h0(l.price)}` } : { en: "the day's high", hi: "दिन का हाई" }; };
  const tgtDn = (p: number) => { const l = nextBelow(p); return l ? { en: `the next level below, the ${l.label} at ${n0(l.price)}`, hi: `नीचे का अगला लेवल, ${l.hi} ${h0(l.price)}` } : { en: "the day's low", hi: "दिन का लो" }; };
  const tests = new Map<number, { from: "above" | "below"; start: number; brokeAt: number | null; L: Level; extreme: number }>();
  let dayHi = -Infinity, dayLo = Infinity, vwSum = 0, aboveVw: boolean | null = null; const crs = new Map<number, { en: string; hi: string }>();
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1], rng = c.high - c.low, body = Math.abs(c.close - c.open), avg = avgRange(i), up = c.close >= c.open, cr = candleRead(c, avg); crs.set(i, cr);
    vwSum += (c.high + c.low + c.close) / 3; const vw = vwSum / (i + 1), t = hm(c.time), ht = hTime(c.time + o.interval * 60);
    let said = false;
    // ---------------- the open
    if (i === 0) {
      const gap = c.open - o.prev.close, g = gap / o.atrDaily, flat = Math.abs(g) < 0.15, gs = o.gap && o.gapGroup && o.gapGroup !== "FLAT" ? o.gap : null;
      say(0, "open", {
        en: `Good morning. Today ${o.index} opens at ${n0(c.open)}, ${flat ? "almost flat to yesterday" : gap > 0 ? `${pts(gap)} above yesterday's close — a gap up` : `${pts(gap)} below yesterday's close — a gap down`}. ` +
          `Before you trade, mark the levels on your chart: yesterday's high ${n0(o.prev.high)}, yesterday's low ${n0(o.prev.low)} and yesterday's close ${n0(o.prev.close)}. These are where big players act. ` +
          (gs ? `History: on the ${gs.n} past days with a gap like this, the gap was filled the same day only ${gs.fillClose} percent of the time, and price went another half day-range in the gap's direction ${gs.cont50} percent of the time. So never assume the gap will simply fill. ` : "") +
          `Rule one: do not trade the first fifteen minutes. Let the opening range form. ${cr.en}`,
        hi: `नमस्ते। आज ${o.index} ${h0(c.open)} पर खुला है, ${flat ? "कल के लगभग बराबर" : gap > 0 ? `कल के क्लोज़ से ${hpts(gap)} ऊपर — यानी गैप अप` : `कल के क्लोज़ से ${hpts(gap)} नीचे — यानी गैप डाउन`}। ` +
          `ट्रेड करने से पहले अपने चार्ट पर लेवल मार्क कीजिए: कल का हाई ${h0(o.prev.high)}, कल का लो ${h0(o.prev.low)} और कल का क्लोज़ ${h0(o.prev.close)}। बड़े खिलाड़ी इन्हीं लेवल पर काम करते हैं। ` +
          (gs ? `इतिहास देखिए: ऐसे गैप वाले पिछले ${gs.n} दिनों में गैप उसी दिन सिर्फ़ ${gs.fillClose} प्रतिशत बार भरा, और ${gs.cont50} प्रतिशत बार भाव गैप की दिशा में आधी दिन-रेंज और चला। इसलिए यह मत मानिए कि गैप अपने आप भर जाएगा। ` : "") +
          `पहला नियम: पहले पंद्रह मिनट ट्रेड मत कीजिए, ओपनिंग रेंज बनने दीजिए। ${cr.hi}`,
      }, { marker: { position: "aboveBar", color: "#2962ff", shape: "circle", text: "OPEN" } });
      said = true;
    }
    // ---------------- 09:30: the opening range and the day's direction
    if (o.interval >= 15 ? mn(c.time) === 555 : mn(c.time) === 565) {
      const open = bars[0].open, orh = Math.max(...bars.slice(0, i + 1).map((x) => x.high)), orl = Math.min(...bars.slice(0, i + 1).map((x) => x.low)), below = c.close < open;
      const gdn = (o.gapGroup || "").includes("DOWN"), gup = (o.gapGroup || "").includes("UP"), G = o.gap;
      let ruleEn = "", ruleHi = "";
      if (G && (gdn || gup)) { const holds = gdn ? below : !below;
        ruleEn = holds ? ` It is still on the gap's side of the open — in the past, in this situation, price went another half day-range ${G.holds930.cont50} percent of the time.` : ` It has come back across the open — in the past, the gap was then filled ${G.against930.fillPct} percent of the time.`;
        ruleHi = holds ? ` भाव अभी भी ओपन से गैप की तरफ़ है — इतिहास में ऐसी हालत में ${G.holds930.cont50} प्रतिशत बार भाव आधी दिन-रेंज और चला।` : ` भाव ओपन के पार वापस आ गया है — इतिहास में तब ${G.against930.fillPct} प्रतिशत बार गैप भर गया।`; }
      say(i, "0930", {
        en: `It is nine thirty — the most important moment of the morning. The opening range is ${n0(orl)} to ${n0(orh)}, ${pts(orh - orl)} wide, and price is ${below ? "below" : "above"} the open of ${n0(open)}.${ruleEn} ` +
          `The plan from here: a fifteen-minute close above ${n0(orh)} favours buyers, a close below ${n0(orl)} favours sellers, and inside the range we wait. Do not buy the breakout candle itself — wait for the pull-back. ${cr.en}`,
        hi: `साढ़े नौ बज गए हैं — सुबह का सबसे ज़रूरी समय। ओपनिंग रेंज ${h0(orl)} से ${h0(orh)} है, यानी ${hpts(orh - orl)} चौड़ी, और भाव ${h0(open)} के ओपन से ${below ? "नीचे" : "ऊपर"} है।${ruleHi} ` +
          `आगे का प्लान: ${h0(orh)} के ऊपर पंद्रह मिनट का क्लोज़ ख़रीदारों के पक्ष में, ${h0(orl)} के नीचे क्लोज़ बेचने वालों के पक्ष में, और रेंज के अंदर हम इंतज़ार करेंगे। ब्रेकआउट वाली कैंडल पर सीधे मत ख़रीदिए — पुल-बैक का इंतज़ार कीजिए। ${cr.hi}`,
      }, { marker: { position: below ? "aboveBar" : "belowBar", color: "#ff9800", shape: "circle", text: "9:30" } });
      said = true;
    }
    // ---------------- level tests: touch → held / rejected · break · fake break (sweep) · confirmed break
    const tol = 0.15 * avg;
    for (const L of levels) {
      const tr = tests.get(L.price), from: "above" | "below" | null = p ? (p.close > L.price + tol ? "above" : p.close < L.price - tol ? "below" : null) : (c.open > L.price ? "above" : "below");
      if (!tr) {
        if (!(from === "above" && c.low <= L.price + tol) && !(from === "below" && c.high >= L.price - tol)) continue;
        tests.set(L.price, { from: from!, start: i, brokeAt: null, L, extreme: from === "above" ? c.low : c.high });
        const sup = from === "above";
        say(i, "test", {
          en: `At ${t}, price ${sup ? "comes down" : "rises"} to the ${L.label} at ${n0(L.price)}, which acts as ${sup ? "support" : "resistance"} now. ${cr.en} ` +
            `Do not act on the touch. A professional watches how this candle and the next two close: ${sup ? `a close back above ${n0(L.price)} with a lower wick means buyers are defending it; a close below it is a break` : `a close back below ${n0(L.price)} with an upper wick means sellers are defending it; a close above it is a break`}.`,
          hi: `${ht} पर भाव ${L.hi} ${h0(L.price)} तक ${sup ? "नीचे आया" : "ऊपर गया"}, जो अभी ${sup ? "सपोर्ट" : "रेज़िस्टेंस"} का काम कर रहा है। ${cr.hi} ` +
            `सिर्फ़ छूने पर ट्रेड मत कीजिए। प्रोफ़ेशनल देखता है कि यह और अगली दो कैंडल कहाँ क्लोज़ होती हैं: ${sup ? `अगर क्लोज़ ${h0(L.price)} के ऊपर वापस आए और नीचे विक हो तो ख़रीदार इसे बचा रहे हैं; अगर नीचे क्लोज़ हो तो यह ब्रेक है` : `अगर क्लोज़ ${h0(L.price)} के नीचे वापस आए और ऊपर विक हो तो बेचने वाले इसे बचा रहे हैं; अगर ऊपर क्लोज़ हो तो यह ब्रेक है`}।`,
        }, { level: L.price });
        said = true; continue;
      }
      tr.extreme = tr.from === "above" ? Math.min(tr.extreme, c.low) : Math.max(tr.extreme, c.high);
      const s = tr.from === "above" ? -1 : 1, beyond = s * (c.close - tr.L.price) > tol, away = tr.from === "above" ? c.close - tr.L.price : tr.L.price - c.close, Ln = tr.L;
      if (tr.brokeAt == null && beyond) {
        tr.brokeAt = i;
        say(i, "break", {
          en: `This candle closed ${s < 0 ? "below" : "above"} the ${Ln.label} at ${n0(Ln.price)} — a break. ${cr.en} Here is where most beginners lose money: they ${s < 0 ? "sell" : "buy"} this candle. In two years of NIFTY data, breaks like this followed through only about half the time. ` +
            `The professional waits: if price comes back ${s < 0 ? "above" : "below"} ${n0(Ln.price)} within three candles, it was a fake break; if it moves a full candle away, the break is real and we trade the retest.`,
          hi: `इस कैंडल ने ${Ln.hi} ${h0(Ln.price)} के ${s < 0 ? "नीचे" : "ऊपर"} क्लोज़ किया — यह ब्रेक है। ${cr.hi} यहीं ज़्यादातर नए ट्रेडर पैसा गँवाते हैं: वे इसी कैंडल पर ${s < 0 ? "बेच" : "ख़रीद"} देते हैं। दो साल के निफ़्टी डेटा में ऐसे ब्रेक सिर्फ़ लगभग आधी बार आगे चले। ` +
            `प्रोफ़ेशनल इंतज़ार करता है: अगर तीन कैंडल के अंदर भाव ${h0(Ln.price)} के ${s < 0 ? "ऊपर" : "नीचे"} वापस आ गया तो यह फ़र्ज़ी ब्रेक था; अगर एक पूरी कैंडल जितना दूर चला गया तो ब्रेक असली है और हम रीटेस्ट पर ट्रेड करेंगे।`,
        }, { level: Ln.price, marker: { position: s < 0 ? "aboveBar" : "belowBar", color: "#ef5350", shape: s < 0 ? "arrowDown" : "arrowUp", text: "break" } });
        said = true; continue;
      }
      if (tr.brokeAt != null && i - tr.brokeAt <= 3 && s * (c.close - Ln.price) < -tol) {
        const longIdea = s < 0, tg = longIdea ? tgtUp(Ln.price) : tgtDn(Ln.price), k = i - tr.brokeAt;
        say(i, "sweep", {
          en: `Look carefully — price closed back ${longIdea ? "above" : "below"} the ${Ln.label} at ${n0(Ln.price)} within ${k} candle${k > 1 ? "s" : ""}. That was a fake break: a liquidity sweep. ${cr.en} ` +
            `Traders who ${longIdea ? "sold" : "bought"} the break are now trapped, and their stop losses will push price the other way. This is the set-up we wait for all day. ` +
            `The trade: ${longIdea ? `buy above this candle's high of ${n0(c.high)}` : `sell below this candle's low of ${n0(c.low)}`}, stop loss just ${longIdea ? "below the sweep low" : "above the sweep high"} at ${n0(tr.extreme)}, first target ${tg.en}.`,
          hi: `ध्यान से देखिए — ${k} कैंडल के अंदर भाव ${Ln.hi} ${h0(Ln.price)} के ${longIdea ? "ऊपर" : "नीचे"} वापस क्लोज़ हो गया। यह फ़र्ज़ी ब्रेक था — इसे लिक्विडिटी स्वीप कहते हैं। ${cr.hi} ` +
            `जिन्होंने ब्रेक पर ${longIdea ? "बेचा" : "ख़रीदा"} था वे अब फँस गए हैं, और उनके स्टॉप लॉस भाव को उल्टी दिशा में धकेलेंगे। पूरे दिन हम इसी सेट-अप का इंतज़ार करते हैं। ` +
            `ट्रेड: ${longIdea ? `इस कैंडल के हाई ${h0(c.high)} के ऊपर ख़रीदिए` : `इस कैंडल के लो ${h0(c.low)} के नीचे बेचिए`}, स्टॉप लॉस स्वीप के ${longIdea ? "लो के ठीक नीचे" : "हाई के ठीक ऊपर"} ${h0(tr.extreme)}, पहला टारगेट ${tg.hi}।`,
        }, { level: Ln.price, marker: { position: longIdea ? "belowBar" : "aboveBar", color: "#26a69a", shape: longIdea ? "arrowUp" : "arrowDown", text: "sweep" } });
        tests.delete(Ln.price); said = true; continue;
      }
      if (tr.brokeAt != null && s * (c.close - Ln.price) >= avg) {
        const down = tr.from === "above", tg = down ? tgtDn(c.close) : tgtUp(c.close);
        say(i, "confirmed", {
          en: `The break of the ${Ln.label} at ${n0(Ln.price)} is now confirmed — price moved a full candle-size beyond it. ${down ? "The old support has become resistance" : "The old resistance has become support"}: this is a flip zone. ` +
            `Do not chase here. The trade is the retest: ${down ? `when price pulls back up to ${n0(Ln.price)} and a candle closes back below it, sell; stop loss above ${n0(Ln.price + avg)}` : `when price dips back to ${n0(Ln.price)} and a candle closes back above it, buy; stop loss below ${n0(Ln.price - avg)}`}; target ${tg.en}.`,
          hi: `${Ln.hi} ${h0(Ln.price)} का ब्रेक अब पक्का हो गया — भाव उससे एक पूरी कैंडल जितना आगे निकल गया। ${down ? "पुराना सपोर्ट अब रेज़िस्टेंस बन गया" : "पुराना रेज़िस्टेंस अब सपोर्ट बन गया"} — इसे फ़्लिप ज़ोन कहते हैं। ` +
            `यहाँ पीछा मत कीजिए। ट्रेड रीटेस्ट पर है: ${down ? `जब भाव वापस ${h0(Ln.price)} तक ऊपर आए और कैंडल उसके नीचे क्लोज़ हो, तब बेचिए; स्टॉप लॉस ${h0(Ln.price + avg)} के ऊपर` : `जब भाव वापस ${h0(Ln.price)} तक नीचे आए और कैंडल उसके ऊपर क्लोज़ हो, तब ख़रीदिए; स्टॉप लॉस ${h0(Ln.price - avg)} के नीचे`}; टारगेट ${tg.hi}।`,
        }, { level: Ln.price });
        tests.delete(Ln.price); said = true; continue;
      }
      if (tr.brokeAt == null && away >= avg) {
        const sup = tr.from === "above", tg = sup ? tgtUp(c.close) : tgtDn(c.close);
        say(i, "held", {
          en: sup ? `The ${Ln.label} at ${n0(Ln.price)} held as support: price bounced a full candle-size without closing below it. Buyers defended it. ${cr.en} The trade: buy on a small pull-back that holds above ${n0(Ln.price)}, stop loss below the test low of ${n0(tr.extreme)}, target ${tg.en}.`
            : `The ${Ln.label} at ${n0(Ln.price)} rejected price: it fell a full candle-size without closing above it. Sellers defended it. ${cr.en} The trade: sell on a small bounce that fails below ${n0(Ln.price)}, stop loss above the test high of ${n0(tr.extreme)}, target ${tg.en}.`,
          hi: sup ? `${Ln.hi} ${h0(Ln.price)} ने सपोर्ट का काम किया: भाव उसके नीचे क्लोज़ हुए बिना एक पूरी कैंडल जितना ऊपर उछला। ख़रीदारों ने इसे बचाया। ${cr.hi} ट्रेड: छोटे पुल-बैक पर ख़रीदिए जो ${h0(Ln.price)} के ऊपर टिके, स्टॉप लॉस टेस्ट के लो ${h0(tr.extreme)} के नीचे, टारगेट ${tg.hi}।`
            : `${Ln.hi} ${h0(Ln.price)} ने भाव को रिजेक्ट किया: भाव उसके ऊपर क्लोज़ हुए बिना एक पूरी कैंडल जितना गिरा। बेचने वालों ने इसे बचाया। ${cr.hi} ट्रेड: छोटे उछाल पर बेचिए जो ${h0(Ln.price)} के नीचे फ़ेल हो, स्टॉप लॉस टेस्ट के हाई ${h0(tr.extreme)} के ऊपर, टारगेट ${tg.hi}।`,
        }, { level: Ln.price, marker: { position: sup ? "belowBar" : "aboveBar", color: "#26a69a", shape: sup ? "arrowUp" : "arrowDown", text: sup ? "held" : "rejected" } });
        tests.delete(Ln.price); said = true; continue;
      }
      if (i - tr.start > 12) tests.delete(Ln.price);
    }
    // ---------------- VWAP side
    const nowAbove = c.close > vw;
    if (aboveVw != null && nowAbove !== aboveVw && i >= 3 && !said) {
      say(i, "vwap", {
        en: `Price closed ${nowAbove ? "above" : "below"} the day's average price, about ${n0(vw)}. ${nowAbove ? "Buyers" : "Sellers"} now have the upper hand on the day. ${cr.en} But a cross on its own is close to a coin flip — use it as a filter: ${nowAbove ? "prefer buying dips that hold above it" : "prefer selling bounces that fail below it"}.`,
        hi: `भाव दिन के औसत भाव, लगभग ${h0(vw)}, के ${nowAbove ? "ऊपर" : "नीचे"} क्लोज़ हुआ। अब दिन में ${nowAbove ? "ख़रीदारों" : "बेचने वालों"} का पलड़ा भारी है। ${cr.hi} लेकिन सिर्फ़ इसे पार करना सिक्का उछालने जैसा है — इसे फ़िल्टर की तरह इस्तेमाल कीजिए: ${nowAbove ? "उन गिरावटों पर ख़रीदिए जो इसके ऊपर टिकें" : "उन उछालों पर बेचिए जो इसके नीचे फ़ेल हों"}।`,
      });
      said = true;
    }
    aboveVw = nowAbove;
    // ---------------- new day high / low after the first half hour
    if (i > 0 && mn(c.time) >= 585 && !said) {
      if (c.high > dayHi && c.close > dayHi) { say(i, "newhigh", { en: `A new high of the day at ${n0(c.high)}. ${cr.en} This shows strength, but a professional never buys the new high itself — that is where late buyers get trapped. Wait for a pull-back to ${n0(dayHi)}, the old high, and buy only if it holds there.`, hi: `दिन का नया हाई ${h0(c.high)}। ${cr.hi} यह मज़बूती दिखाता है, लेकिन प्रोफ़ेशनल कभी नए हाई पर सीधे नहीं ख़रीदता — वहीं देर से आने वाले फँसते हैं। पुराने हाई ${h0(dayHi)} तक पुल-बैक का इंतज़ार कीजिए, और वहाँ टिके तभी ख़रीदिए।` }, { marker: { position: "aboveBar", color: "#26a69a", shape: "circle", text: "HOD" } }); said = true; }
      else if (c.low < dayLo && c.close < dayLo) { say(i, "newlow", { en: `A new low of the day at ${n0(c.low)}. ${cr.en} Weakness — but do not sell the new low itself. Wait for a bounce to ${n0(dayLo)}, the old low, and sell only if it fails there.`, hi: `दिन का नया लो ${h0(c.low)}। ${cr.hi} कमज़ोरी है — लेकिन नए लो पर सीधे मत बेचिए। पुराने लो ${h0(dayLo)} तक उछाल का इंतज़ार कीजिए, और वहाँ फ़ेल हो तभी बेचिए।` }, { marker: { position: "belowBar", color: "#ef5350", shape: "circle", text: "LOD" } }); said = true; }
    }
    // ---------------- candle shapes worth a note (honest: alone ~50/50)
    if (!said && rng >= 1.5 * avg && body >= 0.7 * rng) { say(i, "momentum", { en: `A big ${up ? "green" : "red"} momentum candle. ${cr.en} It looks powerful, but in two years of NIFTY data such candles carried on only about half the time — the next candles often give some back. Do not chase it; let it pull back.`, hi: `एक बड़ी ${up ? "हरी" : "लाल"} मोमेंटम कैंडल। ${cr.hi} देखने में ताक़तवर लगती है, लेकिन दो साल के निफ़्टी डेटा में ऐसी कैंडल सिर्फ़ लगभग आधी बार आगे चलीं — अक्सर अगली कैंडल कुछ हिस्सा वापस ले लेती हैं। इसका पीछा मत कीजिए, पुल-बैक आने दीजिए।` }); said = true; }
    else if (!said && p && rng >= avg) {
      const lw = Math.min(c.open, c.close) - c.low, uw = c.high - Math.max(c.open, c.close);
      if (lw >= 0.6 * rng) { say(i, "wick", { en: `A long lower wick. ${cr.en} Sellers pushed price down and buyers pushed it back — at a support level this is a strong sign; in the middle of nowhere it is just noise.`, hi: `नीचे लंबी विक। ${cr.hi} बेचने वालों ने भाव नीचे धकेला और ख़रीदारों ने वापस ऊपर किया — सपोर्ट लेवल पर यह मज़बूत संकेत है, बीच में कहीं हो तो सिर्फ़ शोर है।` }); said = true; }
      else if (uw >= 0.6 * rng) { say(i, "wick", { en: `A long upper wick. ${cr.en} Buyers pushed up and sellers rejected it — at a resistance level this is a warning for buyers.`, hi: `ऊपर लंबी विक। ${cr.hi} ख़रीदारों ने ऊपर धकेला और बेचने वालों ने रिजेक्ट किया — रेज़िस्टेंस लेवल पर यह ख़रीदारों के लिए चेतावनी है।` }); said = true; }
    }
    // ---------------- hourly recap
    if (!said && i > 3 && mn(c.time) >= 615 && (mn(c.time) - 555) % 60 === 0) {
      const lo = Math.min(dayLo, c.low), hiD = Math.max(dayHi, c.high), range = Math.abs(c.close - bars[0].open) < 0.15 * o.atrDaily, upDay = c.close > bars[0].open;
      say(i, "recap", {
        en: `Let us recap at ${t}. The range so far is ${n0(lo)} to ${n0(hiD)}. Price is ${nowAbove ? "above" : "below"} the average price and ${upDay ? "above" : "below"} the open. ${range ? "Not much progress — this looks like a range day. On range days the middle pays nobody: trade only at the edges, or stay out." : `There is a clear ${upDay ? "upward" : "downward"} direction today — trade with it, on pull-backs, not against it.`}`,
        hi: `${ht} पर एक बार दोहराते हैं। अब तक की रेंज ${h0(lo)} से ${h0(hiD)} है। भाव औसत भाव के ${nowAbove ? "ऊपर" : "नीचे"} और ओपन के ${upDay ? "ऊपर" : "नीचे"} है। ${range ? "ज़्यादा प्रगति नहीं — यह रेंज वाला दिन लगता है। रेंज वाले दिन बीच में किसी को पैसा नहीं मिलता: सिर्फ़ किनारों पर ट्रेड कीजिए, या बाहर रहिए।" : `आज साफ़ ${upDay ? "ऊपर" : "नीचे"} की दिशा है — इसी दिशा में, पुल-बैक पर ट्रेड कीजिए, इसके ख़िलाफ़ नहीं।`}`,
      });
      said = true;
    }
    dayHi = Math.max(dayHi, c.high); dayLo = Math.min(dayLo, c.low);
  }
  // ---------------- end of day lesson
  if (bars.length) {
    const L = bars[bars.length - 1], move = L.close - bars[0].open, held = steps.filter((s) => s.kind === "held").length, sw = steps.filter((s) => s.kind === "sweep").length, br = steps.filter((s) => s.kind === "confirmed").length;
    say(bars.length - 1, "end", {
      en: `The day ends at ${n0(L.close)}, ${pts(move)} ${move >= 0 ? "above" : "below"} the open, with a range of ${pts(dayHi - dayLo)}. Today the levels gave ${held} clean hold${held === 1 ? "" : "s"} or rejection${held === 1 ? "" : "s"}, ${sw} liquidity sweep${sw === 1 ? "" : "s"} and ${br} confirmed break${br === 1 ? "" : "s"}. ` +
        `Remember today's lesson: first mark the levels, then decide the direction at nine thirty, then wait for a reaction at a level — a sweep or a retest — and enter with the stop just beyond it. The candle alone is a coin flip; the level and the reaction give you the edge. Small size, strict stop loss.`,
      hi: `दिन ${h0(L.close)} पर ख़त्म हुआ, ओपन से ${hpts(move)} ${move >= 0 ? "ऊपर" : "नीचे"}, और पूरी रेंज ${hpts(dayHi - dayLo)} रही। आज लेवल्स पर ${held} बार साफ़ होल्ड या रिजेक्शन, ${sw} लिक्विडिटी स्वीप और ${br} पक्के ब्रेक मिले। ` +
        `आज का सबक़ याद रखिए: पहले लेवल मार्क कीजिए, फिर साढ़े नौ बजे दिशा तय कीजिए, फिर किसी लेवल पर रिएक्शन का इंतज़ार कीजिए — स्वीप या रीटेस्ट — और स्टॉप लॉस उसके ठीक पार रखकर एंट्री लीजिए। अकेली कैंडल सिक्का उछालने जैसी है; लेवल और रिएक्शन से ही बढ़त मिलती है। छोटी साइज़, सख़्त स्टॉप लॉस।`,
    });
  }
  // at most two lessons per candle (the most instructive), so the voice keeps pace; open / 09:30 / end always stay
  const PRI: Record<string, number> = { open: 0, "0930": 0, end: 0, sweep: 1, confirmed: 2, held: 3, break: 4, newhigh: 5, newlow: 5, test: 6, vwap: 7, momentum: 8, wick: 8, recap: 9 };
  const keep = new Set<Step>(), byI = new Map<number, Step[]>(); for (const st of steps) (byI.get(st.i) || byI.set(st.i, []).get(st.i)!).push(st);
  for (const arr of byI.values()) { const must = arr.filter((x) => PRI[x.kind] === 0), rest = arr.filter((x) => PRI[x.kind] !== 0).sort((a, b) => (PRI[a.kind] ?? 9) - (PRI[b.kind] ?? 9));
    for (const x of [...must, ...rest.slice(0, Math.max(0, 2 - must.filter((m) => m.kind !== "end").length))]) keep.add(x); }   // the end lesson never takes a slot
  // the candle is described once: the second lesson on the same candle skips the description
  const out = steps.filter((x) => keep.has(x)), seen = new Set<number>();
  for (const st of out) { if (seen.has(st.i)) { const r = crs.get(st.i); if (r) { st.text = st.text.replace(r.en, "").replace(/\s{2,}/g, " ").trim(); st.hi = st.hi.replace(r.hi, "").replace(/\s{2,}/g, " ").trim(); } } seen.add(st.i); }
  return { index: o.index, day: o.day, interval: o.interval, candles: bars, levels, steps: out, atrDaily: Math.round(o.atrDaily), prev: o.prev };
}
