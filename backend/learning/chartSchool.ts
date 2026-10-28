// ============================ 📸 Chart School — candle + level lessons from a day's chart (owner, 2026-10-28) ============================
// The owner picks NIFTY / SENSEX and a day; the system reads THAT day's real 5-min candles (Dhan) and builds a training
// chart: the levels that mattered (previous day H / L / C, the opening range, round numbers, swing flip zones, the day's
// high / low) and the 8–12 candles that carried the day, each explained in Hindi — what the candle is, where it stood, why it
// mattered, what an experienced trader does there. Pure functions; education only, no trade signal.

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface CSLevel { key: string; label: string; price: number; kind: "PD" | "OR" | "ROUND" | "SWING" | "DAY"; note: string; from?: number }   // from = first bar index the level is known (no look-ahead)
export interface CSEvent { n: number; time: number; idx: number; kind: string; score: number; tone: "bull" | "bear" | "neutral"; title: string;
  candle: string; level: { label: string; price: number } | null; what: string; lesson: string; action: string }
export interface ChartLesson { index: string; day: string; bars: Bar[]; ema9: (number | null)[]; ema21: (number | null)[]; levels: CSLevel[]; events: CSEvent[];
  zones: { from: number; to: number; label: string }[]; summary: string[]; glossary: { name: string; hi: string; count: number }[]; rules: string[] }

const IST = 19800;
const hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const f0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export function ema(xs: number[], n: number): (number | null)[] { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x, i) => { v = v == null ? x : x * k + v * (1 - k); return i >= n - 1 ? Math.round(v * 100) / 100 : null; }); }

export const PATTERNS: Record<string, string> = {
  "Doji": "Open ≈ Close: खरीदार और बेचने वाले बराबर — अनिर्णय। Level पर आए तो रुकने का पहला इशारा।",
  "Hammer": "नीचे लंबी पूँछ, ऊपर छोटी body: नीचे के भाव पर खरीदार आए। Support पर सबसे काम का।",
  "Shooting star": "ऊपर लंबी पूँछ: ऊपर के भाव पर बेचने वाले आए। Resistance पर सबसे काम का।",
  "Bullish engulfing": "हरी body ने पिछली लाल body को पूरा ढक लिया: खरीदारों ने कमान ली।",
  "Bearish engulfing": "लाल body ने पिछली हरी body को पूरा ढक लिया: बेचने वालों ने कमान ली।",
  "Marubozu": "लगभग बिना पूँछ की बड़ी body: एक तरफ़ा ज़ोर — decision candle।",
  "Big candle": "आम candle से 2 गुना बड़ी: यहाँ बड़ा order आया — इसका high / low आगे level बनता है।",
  "Inside bar": "पिछली candle के अंदर: रुकाव / सिकुड़न — इसके टूटने की दिशा देखें।",
};

/** Name a candle (one main pattern) relative to the day's median range. */
export function classify(b: Bar, p: Bar | null, medR: number): { name: string; bias: 1 | -1 | 0 } {
  const r = b.high - b.low || 1e-9, body = Math.abs(b.close - b.open), up = b.high - Math.max(b.open, b.close), lo = Math.min(b.open, b.close) - b.low, g = b.close >= b.open;
  if (p) {
    const pb = Math.abs(p.close - p.open), pg = p.close >= p.open;
    if (g !== pg && body >= pb && pb > 0.2 * medR && Math.max(b.open, b.close) >= Math.max(p.open, p.close) && Math.min(b.open, b.close) <= Math.min(p.open, p.close)) return { name: g ? "Bullish engulfing" : "Bearish engulfing", bias: g ? 1 : -1 };
  }
  if (body >= 0.8 * r && r >= 1.5 * medR) return { name: "Marubozu", bias: g ? 1 : -1 };
  if (r >= 1.8 * medR) return { name: "Big candle", bias: g ? 1 : -1 };
  if (body <= 0.15 * r && r >= 0.5 * medR) return { name: "Doji", bias: 0 };
  if (lo >= 2 * Math.max(body, 0.1 * r) && up <= 0.35 * r) return { name: "Hammer", bias: 1 };
  if (up >= 2 * Math.max(body, 0.1 * r) && lo <= 0.35 * r) return { name: "Shooting star", bias: -1 };
  if (p && b.high <= p.high && b.low >= p.low) return { name: "Inside bar", bias: 0 };
  return { name: g ? "Green candle" : "Red candle", bias: g ? 1 : -1 };
}

export function buildChartLesson(I: { index: string; day: string; bars: Bar[]; prev: { high: number; low: number; close: number } | null }): ChartLesson {
  const B = I.bars, n = B.length, sx = I.index === "SENSEX", tol = B.length ? B[0].close * 0.0005 : 10, buf = B.length ? B[0].close * 0.0002 : 4;
  const ranges = B.map((b) => b.high - b.low), medR = med(ranges) || 1, e9 = ema(B.map((b) => b.close), 9), e21 = ema(B.map((b) => b.close), 21);
  const pats = B.map((b, i) => classify(b, i ? B[i - 1] : null, medR));
  const dayHi = B.reduce((a, b, i) => (b.high > B[a].high ? i : a), 0), dayLo = B.reduce((a, b, i) => (b.low < B[a].low ? i : a), 0);

  // ---------- levels
  const lv: CSLevel[] = [];
  const add = (l: CSLevel) => { if (!lv.some((x) => Math.abs(x.price - l.price) < tol)) lv.push(l); };
  if (I.prev) {
    add({ key: "PDH", label: "कल का High", price: I.prev.high, kind: "PD", note: "ऊपर buyers के stop-loss — टूटे तो तेज़ी, रुके तो बिकवाली" });
    add({ key: "PDL", label: "कल का Low", price: I.prev.low, kind: "PD", note: "नीचे sellers / option buyers के stop-loss" });
    add({ key: "PDC", label: "कल का Close", price: I.prev.close, kind: "PD", note: "Gap इसी से नापते हैं; दिन में बार-बार चुम्बक" });
  }
  const or = B.slice(0, 3);
  if (or.length === 3) { add({ key: "ORH", label: "पहले 15-min का High", price: Math.max(...or.map((b) => b.high)), kind: "OR", note: "दिन का पहला फ़ैसला: ऊपर 15-min close = खरीदार" });
    add({ key: "ORL", label: "पहले 15-min का Low", price: Math.min(...or.map((b) => b.low)), kind: "OR", note: "नीचे 15-min close = बेचने वाले" }); }
  const R = sx ? 500 : 100, lo = Math.min(...B.map((b) => b.low)), hi = Math.max(...B.map((b) => b.high));
  for (let p = Math.ceil(lo / R) * R; p <= hi; p += R) add({ key: `RND${p}`, label: `${f0(p)} round`, price: p, kind: "ROUND", note: "Round strike — option writers का घर, भाव यहाँ अटकता है" });
  // swing flip zones: a confirmed swing (2 bars each side) later broken by a close and retested from the other side
  for (let i = 2; i < n - 2; i++) for (const side of [1, -1] as const) {
    const v = side > 0 ? B[i].high : B[i].low, ok = [i - 2, i - 1, i + 1, i + 2].every((j) => side > 0 ? B[j].high <= v : B[j].low >= v); if (!ok) continue;
    const kb = B.findIndex((b, j) => j > i + 2 && side * (b.close - v) > buf); if (kb < 0) continue;
    const rt = B.findIndex((b, j) => j > kb && j <= kb + 15 && (side > 0 ? b.low <= v + tol && b.close > v : b.high >= v - tol && b.close < v));
    if (rt >= 0) add({ from: i + 3, key: `SW${i}`, label: side > 0 ? `Flip zone (${hm(B[i].time)} का high)` : `Flip zone (${hm(B[i].time)} का low)`, price: v, kind: "SWING", note: side > 0 ? "पहले resistance था, टूटकर support बना" : "पहले support था, टूटकर resistance बना" });
  }
  add({ key: "DH", label: "दिन का High", price: B[dayHi]?.high ?? 0, kind: "DAY", note: "आज की ऊपरी liquidity" });
  add({ key: "DL", label: "दिन का Low", price: B[dayLo]?.low ?? 0, kind: "DAY", note: "आज की निचली liquidity" });

  // ---------- events (scored; the strongest 8–12 are taught)
  const ev: Omit<CSEvent, "n">[] = [];
  const C = (i: number) => pats[i].name, tone = (i: number): CSEvent["tone"] => (pats[i].bias > 0 ? "bull" : pats[i].bias < 0 ? "bear" : "neutral");
  const move = (i: number, k: number) => { const j = Math.min(n - 1, i + k); return Math.round(B[j].close - B[i].close); };
  // one event per candle: the stronger story leads, the other is kept as a second line
  const push = (e: Omit<CSEvent, "n">) => {
    const o = ev.find((x) => x.idx === e.idx); if (!o) { ev.push(e); return; }
    const [win, lose] = e.score > o.score ? [e, o] : [o, e];
    Object.assign(o, win, { what: `${win.what} साथ में: ${lose.title}।`, score: win.score + 1 });
  };
  if (n) {
    const b = B[0], big = ranges[0] >= 1.8 * medR, g = b.close >= b.open;
    push({ time: b.time, idx: 0, kind: "OPEN", score: big ? 5 : 3, tone: g ? "bull" : "bear", title: big ? `Opening drive — पहली candle ${g ? "हरी" : "लाल"} और बड़ी` : "पहली candle", candle: C(0), level: I.prev ? { label: "कल का Close", price: I.prev.close } : null,
      what: `${hm(b.time)}: ${f0(b.open)} से ${f0(b.close)} (${f0(b.high - b.low)} points, आम candle ~${f0(medR)})${I.prev ? `; कल के close ${f0(I.prev.close)} से ${b.open >= I.prev.close ? "+" : "−"}${f0(Math.abs(b.open - I.prev.close))} पर खुला` : ""}।`,
      lesson: big ? "पहली बड़ी candle दिन का mood तय करती है; इसका high / low दिन का पहला level बनता है।" : "पहली 15 मिनट की range (ORH / ORL) दिन का पहला फ़ैसला है।",
      action: "Opening candle पर trade नहीं — पहले 15 मिनट की range बनने दें, फिर 15-min close किस तरफ़ टूटता है, वह देखें।" });
  }
  for (const [i, isLow] of [[dayLo, true], [dayHi, false]] as const) {
    if (i <= 0) continue;
    const back = isLow ? Math.round(Math.max(...B.slice(i, i + 4).map((b) => b.close)) - B[i].low) : Math.round(B[i].high - Math.min(...B.slice(i, i + 4).map((b) => b.close)));
    const lvl = lv.filter((l) => l.kind !== "DAY").sort((a, b) => Math.abs(a.price - (isLow ? B[i].low : B[i].high)) - Math.abs(b.price - (isLow ? B[i].low : B[i].high)))[0];
    const atLvl = lvl && Math.abs(lvl.price - (isLow ? B[i].low : B[i].high)) <= 2 * tol;
    push({ time: B[i].time, idx: i, kind: isLow ? "DAY_LOW" : "DAY_HIGH", score: 7, tone: isLow ? "bull" : "bear", title: isLow ? "दिन का Low — यहाँ गिरावट थकी" : "दिन का High — यहाँ तेज़ी थकी", candle: C(i),
      level: atLvl ? { label: lvl.label, price: lvl.price } : null,
      what: `${hm(B[i].time)}: ${isLow ? "low" : "high"} ${f0(isLow ? B[i].low : B[i].high)} (${C(i)})${atLvl ? ` — ${lvl.label} ${f0(lvl.price)} के पास` : ""}; अगली 3 candles में ${back} points ${isLow ? "वापसी" : "गिरावट"}।`,
      lesson: `${isLow ? "गिरावट" : "तेज़ी"} के आख़िर में candles छोटी होती हैं और ${isLow ? "नीचे" : "ऊपर"} पूँछ दिखती है = ${isLow ? "बेचने वाले" : "खरीदार"} थक गए।${atLvl ? " Level पर थकान = सबसे मज़बूत इशारा।" : ""}`,
      action: `Low / high को पहले से पकड़ने की कोशिश नहीं — पहली मज़बूत ${isLow ? "हरी" : "लाल"} candle जो 9 EMA के ${isLow ? "ऊपर" : "नीचे"} बंद हो, उसके बाद pullback पर entry; SL ${isLow ? "low के नीचे" : "high के ऊपर"}।` });
  }
  // level breaks / rejections / retests (first two interactions per level)
  for (const L of lv.filter((l) => l.kind !== "DAY")) {
    let cnt = 0, start = Math.max(L.kind === "OR" ? 3 : 1, L.from ?? 0);
    for (let i = start; i < n && cnt < 2; i++) {
      const b = B[i], p = B[i - 1], from = Math.sign(p.close - L.price) || 1;
      if (from * (b.close - L.price) < -buf) {   // closed through the level
        cnt++; const up = b.close > L.price, big = ranges[i] >= 1.5 * medR, d6 = (up ? 1 : -1) * move(i, 6), fake = d6 <= -1.5 * medR, real = d6 >= 1.5 * medR;
        push({ time: b.time, idx: i, kind: fake ? "FALSE_BREAK" : "BREAK", score: 3 + (big ? 1 : 0) + (L.kind === "PD" || L.kind === "SWING" ? 1 : 0) + (fake || real ? 1 : 0), tone: fake ? (up ? "bear" : "bull") : up ? "bull" : "bear",
          title: fake ? `झूठा break — ${L.label} ${up ? "ऊपर" : "नीचे"} टूटा पर टिका नहीं (trap)` : `${L.label} ${up ? "ऊपर" : "नीचे"} टूटा`, candle: C(i), level: { label: L.label, price: L.price },
          what: `${hm(b.time)}: candle ${f0(L.price)} के ${up ? "ऊपर" : "नीचे"} ${f0(b.close)} पर बंद (${C(i)}); अगली 6 candles में ${move(i, 6) >= 0 ? "+" : "−"}${Math.abs(move(i, 6))} points।`,
          lesson: fake ? `Break के बाद भाव उल्टा भागा = trap: ${up ? "खरीदार" : "बेचने वाले"} फँसे और उनके stop-loss ने उल्टी चाल को ईंधन दिया। अक्सर यह बड़े trend के ख़िलाफ़ छोटा उछाल होता है।`
            : big ? "बड़ी body के साथ level के पार close = असली break (wick से नहीं, close से फ़ैसला)।" : "छोटी candle से break कमज़ोर होता है — retest का इंतज़ार ज़्यादा सुरक्षित।",
          action: fake ? `ऐसे break पर तुरंत entry मत लीजिए; 15-min close + retest का नियम इसी trap से बचाता है। भाव level के वापस ${up ? "नीचे" : "ऊपर"} बंद हो तो उल्टी दिशा देखिए।`
            : `Break पर पीछा नहीं; भाव वापस ${f0(L.price)} पर आए और ${up ? "ऊपर" : "नीचे"} बंद हो (retest) तब entry, SL level के ${up ? "नीचे" : "ऊपर"}।` });
        const rt = B.findIndex((x, j) => j > i + 1 && j <= i + 15 && (up ? x.low <= L.price + tol && x.close > L.price : x.high >= L.price - tol && x.close < L.price));
        const r6 = rt > 0 ? (up ? 1 : -1) * move(rt, 6) : 0, ok = r6 >= 1.5 * medR, bad = r6 <= -1.5 * medR;
        if (rt > 0 && !fake) push({ time: B[rt].time, idx: rt, kind: bad ? "RETEST_FAIL" : "RETEST", score: ok ? 6 : bad ? 4 : 3, tone: bad ? (up ? "bear" : "bull") : up ? "bull" : "bear",
          title: bad ? `Retest फेल — ${L.label} ${up ? "support" : "resistance"} नहीं बना` : `Retest — ${L.label} अब ${up ? "support" : "resistance"} (flip)`, candle: C(rt), level: { label: L.label, price: L.price },
          what: `${hm(B[rt].time)}: भाव ${f0(up ? B[rt].low : B[rt].high)} तक लौटा पर ${f0(B[rt].close)} पर ${up ? "ऊपर" : "नीचे"} बंद; अगली 6 candles में ${move(rt, 6) >= 0 ? "+" : "−"}${Math.abs(move(rt, 6))} points।`,
          lesson: bad ? "Retest के बाद भाव उल्टा गया — level ने काम नहीं किया। इसलिए SL हमेशा level के पार 15-min close पर, और 1:2 से कम target नहीं।"
            : `जो level पहले ${up ? "resistance" : "support"} था, टूटने के बाद ${up ? "support" : "resistance"} बनता है (flip zone) — यह सबसे साफ़ entry की जगह है।`,
          action: bad ? `SL hit होता — नुकसान छोटा रखिए और उल्टी दिशा का setup देखिए।`
            : `यहीं entry: ${up ? "CE" : "PE"}, SL ${f0(L.price)} के ${up ? "नीचे" : "ऊपर"} 15-min close पर, target 1:2।${pats[rt].bias === (up ? -1 : 1) ? ` पर यह candle ख़ुद ${up ? "लाल" : "हरी"} (${C(rt)}) है — level पर close सही है, फिर भी अगली candle ${up ? "हरी" : "लाल"} बंद हो तब entry (पुष्टि)।` : ""}` });
        i += 3;
      } else if (from * (b.close - L.price) > 0 && (from > 0 ? L.price - b.low : b.high - L.price) > buf) {   // wick through the level, close back on its side
        const away = from * move(i, 3);
        if (away < tol) continue;
        cnt++;
        push({ time: b.time, idx: i, kind: "REJECT", score: 3 + (["Hammer", "Shooting star", "Bullish engulfing", "Bearish engulfing", "Doji"].includes(C(i)) ? 1 : 0) + (L.kind === "PD" || L.kind === "ROUND" ? 1 : 0), tone: from > 0 ? "bull" : "bear",
          title: `${L.label} पर rejection (${from > 0 ? "support बचा" : "resistance बचा"})`, candle: C(i), level: { label: L.label, price: L.price },
          what: `${hm(b.time)}: wick ${f0(from > 0 ? b.low : b.high)} तक गया (level ${f0(L.price)} के पार) पर close ${f0(b.close)} वापस अंदर; अगली 3 candles में ${away} points दूर।`,
          lesson: "Level के पार सिर्फ़ पूँछ (wick) और close वापस = वहाँ के stop-loss लेकर पलटा (liquidity sweep)। Close ही फ़ैसला है।",
          action: `अगली candle ${from > 0 ? "ऊपर" : "नीचे"} बंद हो तो ${from > 0 ? "CE" : "PE"}, SL wick के ${from > 0 ? "नीचे" : "ऊपर"}।` });
        i += 3;
      }
    }
  }
  // EMA 9 / 21 crosses that held for 3 bars
  for (let i = 22; i < n - 3; i++) {
    const a = e9[i - 1], b2 = e21[i - 1], c = e9[i], d = e21[i]; if (a == null || b2 == null || c == null || d == null) continue;
    const s0 = Math.sign(a - b2), s1 = Math.sign(c - d); if (!s0 || s0 === s1) continue;
    if ([1, 2, 3].every((k) => Math.sign((e9[i + k] as number) - (e21[i + k] as number)) === s1))
      push({ time: B[i].time, idx: i, kind: "EMA_CROSS", score: 2, tone: s1 > 0 ? "bull" : "bear", title: `9 EMA ने 21 EMA को ${s1 > 0 ? "ऊपर" : "नीचे"} काटा`, candle: C(i), level: null,
        what: `${hm(B[i].time)}: तेज़ (9) औसत धीमे (21) के ${s1 > 0 ? "ऊपर" : "नीचे"}; भाव ${f0(B[i].close)}।`,
        lesson: `Trend ${s1 > 0 ? "ऊपर" : "नीचे"} मुड़ने की पुष्टि — पर यह देर से आती है; level + candle पहले बताते हैं।`, action: `अब ${s1 > 0 ? "हर गिरावट 9 / 21 EMA तक" : "हर उछाल 9 / 21 EMA तक"} trade का मौका, उल्टा trade नहीं।` });
  }
  // decision candles not yet covered
  for (let i = 1; i < n; i++) if (ranges[i] >= 2.2 * medR)
    push({ time: B[i].time, idx: i, kind: "BIG", score: 4, tone: tone(i), title: `Decision candle — बड़ी ${B[i].close >= B[i].open ? "हरी" : "लाल"}`, candle: C(i), level: null,
      what: `${hm(B[i].time)}: ${f0(B[i].high - B[i].low)} points की candle (आम ~${f0(medR)}), ${f0(B[i].open)} → ${f0(B[i].close)}।`,
      lesson: "बड़ी candle = बड़ा order। इसका high / low और आधा हिस्सा (50%) आगे support / resistance बनते हैं।", action: "बड़ी candle के बाद पीछा नहीं; उसके 50% तक pullback पर दिशा के साथ entry।" });
  // chop zones: 12+ bars inside a tight band with the EMAs tangled
  const zones: ChartLesson["zones"] = [];
  for (let i = 0; i + 12 <= n; ) {
    let j = i + 12; const w = (a: number, b: number) => Math.max(...B.slice(a, b).map((x) => x.high)) - Math.min(...B.slice(a, b).map((x) => x.low));
    if (w(i, j) <= 3 * medR) { while (j < n && w(i, j + 1) <= 3.2 * medR) j++; zones.push({ from: B[i].time, to: B[j - 1].time, label: "Sideways / chop" });
      const mid = Math.floor((i + j - 1) / 2);   // marked in the middle of the zone
      push({ time: B[mid].time, idx: mid, kind: "CHOP", score: 4, tone: "neutral", title: "Sideways zone — यहाँ trade नहीं", candle: C(mid), level: null,
        what: `${hm(B[i].time)}–${hm(B[j - 1].time)}: ${j - i} candles सिर्फ़ ${f0(w(i, j))} points में; 9 और 21 EMA आपस में उलझे।`,
        lesson: "छोटी, एक-दूसरे पर चढ़ी candles + सपाट EMA = कोई जीत नहीं रहा। यहाँ हर break झूठा निकल सकता है।", action: "Range के बाहर 15-min close तक हाथ बाँधकर बैठें — premium time decay में घटता है।" });
      i = j; } else i++;
  }
  // pick the 12 to teach: highest score first; among equal scores, the one farthest (in candles) from those already picked,
  // so the whole day is covered (not only the busy morning)
  const pick: typeof ev = [], left = ev.slice();
  while (pick.length < 12 && left.length) {
    const gap = (e: (typeof ev)[number]) => (pick.length ? Math.min(...pick.map((p) => Math.abs(p.idx - e.idx))) : n);
    left.sort((a, b) => b.score - a.score || gap(b) - gap(a) || a.idx - b.idx);
    pick.push(left.shift()!);
  }
  const top = pick.sort((a, b) => a.idx - b.idx).map((e, k) => ({ ...e, n: k + 1 }));

  // ---------- summary + glossary
  const summary: string[] = [];
  if (n) {
    const o = B[0].open, c = B[n - 1].close;
    summary.push(`${I.index} ${I.day}: open ${f0(o)}, high ${f0(B[dayHi].high)} (${hm(B[dayHi].time)}), low ${f0(B[dayLo].low)} (${hm(B[dayLo].time)}), close ${f0(c)} — दिन की range ${f0(B[dayHi].high - B[dayLo].low)} points।`);
    summary.push(dayLo < dayHi ? `कहानी: पहले गिरावट ${hm(B[dayLo].time)} तक, फिर वहाँ से ${f0(B[dayHi].high - B[dayLo].low)} points की तेज़ी ${hm(B[dayHi].time)} तक${zones.length ? `, फिर ${hm(zones[zones.length - 1].from)} से sideways` : ""}।`
      : `कहानी: पहले तेज़ी ${hm(B[dayHi].time)} तक, फिर ${f0(B[dayHi].high - B[dayLo].low)} points की गिरावट ${hm(B[dayLo].time)} तक${zones.length ? `, फिर ${hm(zones[zones.length - 1].from)} से sideways` : ""}।`);
    summary.push(`Chart पर ${top.length} ज़रूरी candles नंबर से दिखाई हैं — हर नंबर पर: candle क्या है, किस level पर है, क्यों ज़रूरी है, अनुभवी trader क्या करता।`);
  }
  const counts = new Map<string, number>(); for (const p of pats) if (PATTERNS[p.name]) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  return { index: I.index, day: I.day, bars: B, ema9: e9, ema21: e21, levels: lv.sort((a, b) => b.price - a.price), events: top, zones, summary,
    glossary: [...counts.entries()].map(([name, count]) => ({ name, hi: PATTERNS[name], count })).sort((a, b) => b.count - a.count),
    rules: [
      "1️⃣ जगह पहले, शक्ल बाद में: candle तभी ज़रूरी है जब वह किसी level पर हो (कल का H/L/C, पहले 15-min की range, round number, flip zone, दिन का H/L)।",
      "2️⃣ आकार देखें: आम candle से 2 गुना बड़ी = बड़ा order (decision)। छोटी candles की कतार = अनिर्णय।",
      "3️⃣ Close ही फ़ैसला: level के पार सिर्फ़ wick = rejection / sweep; level के पार body का close = break।",
      "4️⃣ अगली candle पुष्टि करती है: hammer के बाद हरी close, shooting star के बाद लाल close — तभी भरोसा।",
      "5️⃣ EMA से माहौल: भाव 9 और 21 EMA दोनों के ऊपर और EMA ऊपर झुके = uptrend; उलझे EMA = sideways (trade नहीं)।",
      "6️⃣ सबसे अच्छी entry: break के बाद retest (flip zone) — पुराना resistance नया support।",
    ] };
}
