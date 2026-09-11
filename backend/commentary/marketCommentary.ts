// ============================ Intelligent Market Commentary Engine ============================
// Generates HINGLISH decision-support commentary from LIVE market data — the way Indian traders
// actually talk: Hindi sentence structure/connectors (Devanagari), but trading/technical terms
// kept in English (support, resistance, breakout, CALL/PUT, LTP, target, stop loss, bullish/
// bearish, trend, confirmation, OI, PCR, EMA, VWAP, MACD). It never decides from a single
// indicator: it scores Support/Resistance, OI writing, 21/50 EMA, VWAP, MACD, market structure,
// writer pressure and PCR. It is a guidance engine, NOT a guarantee engine.
//
// CONSISTENCY: each technical term uses ONE fixed English form everywhere (support, not समर्थन;
// resistance, not प्रतिरोध; PUT/CALL writing, not पुट/कॉल लेखन). Numbers stay as digits.

export type Structure = "Bullish" | "Bearish" | "Range" | "Unclear";

export interface CommentaryLeg {
  strike: number;
  ce: { oi: number | null; oiChgPct: number | null; ltp: number | null; ltpChgPct: number | null };
  pe: { oi: number | null; oiChgPct: number | null; ltp: number | null; ltpChgPct: number | null };
  atm?: boolean;
}

export interface CommentaryInput {
  spot: number | null;
  immSupport: number | null; majorSupport: number | null;
  immResistance: number | null; majorResistance: number | null;
  ema21: number | null; ema50: number | null; vwap: number | null;
  macdHist: number | null; macdHistPrev: number | null;
  pcr: number | null;
  oiVerdict: string | null;           // Bullish | Bearish | Neutral
  callWall: { strike: number; oi: number } | null;
  putWall: { strike: number; oi: number } | null;
  callPct: number | null; putPct: number | null;
  chain: CommentaryLeg[];
  structure: Structure;
  marketOpen: boolean;
}

export interface CommentaryFactor { name: string; dir: "bull" | "bear" | "neutral"; weight: number; text: string; }

export interface MarketCommentary {
  headline: string;                   // top line
  conclusion: "WAIT" | "BULL_CONFIRM" | "BEAR_CONFIRM" | "CONFLICT";
  levels: { majorResistance: number | null; immResistance: number | null; price: number | null; immSupport: number | null; majorSupport: number | null };
  situation: string;                  // स्थिति
  reasons: string[];                  // मुख्य कारण (2–3)
  bullCase: string;                   // संभावित तेजी
  bearCase: string;                   // संभावित मंदी
  nextConfirm: string;                // अगली पुष्टि
  guidance: string;                   // ट्रेडर निर्देश
  path: { up: string; down: string }; // बाजार पथ
  aggressiveCallWriter: number | null;
  aggressivePutWriter: number | null;
  writerBattle: { callPct: number | null; putPct: number | null; note: string };
  factors: CommentaryFactor[];        // multi-confirmation breakdown
  bullScore: number; bearScore: number;
  lines: string[];                    // ordered middle commentary (priority §17)
}

// Indian-grouped integer (23,418). Non-finite → "—".
const g = (n: number | null | undefined): string => (n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("en-IN"));
const near = (a: number | null, b: number | null, pct = 0.006): boolean =>
  a != null && b != null && b !== 0 && Math.abs(a - b) / Math.abs(b) <= pct;

export function buildMarketCommentary(inp: CommentaryInput): MarketCommentary {
  const {
    spot, immSupport, majorSupport, immResistance, majorResistance,
    ema21, ema50, vwap, macdHist, macdHistPrev, pcr, oiVerdict,
    callWall, putWall, callPct, putPct, chain, structure, marketOpen,
  } = inp;

  const factors: CommentaryFactor[] = [];
  const lines: string[] = [];
  let bull = 0, bear = 0;
  const add = (name: string, dir: "bull" | "bear" | "neutral", weight: number, text: string) => {
    factors.push({ name, dir, weight, text });
    if (dir === "bull") bull += weight; else if (dir === "bear") bear += weight;
    if (text) lines.push(text);
  };

  // Only when there is genuinely no data do we fall back to a one-liner. When the chain
  // exists but the market is closed, we still build the full structural commentary below
  // (flagged as non-live and forced to WAIT).
  if (spot == null || !chain.length) {
    return {
      headline: marketOpen ? "Wait करें — अभी पर्याप्त data नहीं" : "Market बंद — कोई live signal नहीं",
      conclusion: "WAIT",
      levels: { majorResistance, immResistance, price: spot, immSupport, majorSupport },
      situation: marketOpen ? "अभी पर्याप्त live OI/candle data available नहीं है, इसलिए analysis limited है।" : "Market बंद है — live signals नहीं बनेंगे; सिर्फ historical levels available हैं।",
      reasons: [],
      bullCase: "", bearCase: "",
      nextConfirm: "Market खुलने और live data आने तक wait करें।",
      guidance: "अभी कोई entry न लें।",
      path: { up: "", down: "" },
      aggressiveCallWriter: callWall?.strike ?? null,
      aggressivePutWriter: putWall?.strike ?? null,
      writerBattle: { callPct, putPct, note: "" },
      factors: [], bullScore: 0, bearScore: 0, lines: [],
    };
  }

  // --- Helpers to read OI at a given strike from the chain ---
  const legAt = (strike: number | null) => (strike == null ? null : chain.find((r) => r.strike === strike) || null);
  const supLeg = legAt(immSupport);
  const resLeg = legAt(immResistance);

  // ---------- §17 priority 1–3: price location vs immediate/major levels ----------
  const nearSupport = near(spot, immSupport);
  const nearResistance = near(spot, immResistance);
  let situation: string;
  if (nearSupport && !nearResistance) {
    situation = `Market immediate support ${g(immSupport)} के पास है।`;
  } else if (nearResistance && !nearSupport) {
    situation = `Market immediate resistance ${g(immResistance)} के पास है।`;
  } else if (immSupport != null && immResistance != null) {
    situation = `Market ${g(immSupport)} support और ${g(immResistance)} resistance के बीच trade कर रहा है।`;
  } else {
    situation = `Spot ${g(spot)} के पास market direction तलाश रहा है।`;
  }
  lines.push(situation);

  // ---------- §7 OI writing at the nearby level (support/resistance strength) ----------
  const putStrong = !!(supLeg && supLeg.pe.oi != null && (supLeg.pe.oiChgPct == null || supLeg.pe.oiChgPct >= 0));
  const putWeak = !!(supLeg && supLeg.pe.oiChgPct != null && supLeg.pe.oiChgPct < -3 && (supLeg.pe.ltpChgPct ?? 0) < 0);
  const callStrong = !!(resLeg && resLeg.ce.oi != null && (resLeg.ce.oiChgPct == null || resLeg.ce.oiChgPct >= 0));
  const callWeak = !!(resLeg && resLeg.ce.oiChgPct != null && resLeg.ce.oiChgPct < -3);

  if (nearSupport) {
    if (putStrong) add("PUT writing (support)", "bull", 2, `${g(immSupport)} पर PUT writing strong है — ये support बनने का संकेत है। सीधे bearish position लेने के बजाय support टूटने या bounce होने का confirmation आने का wait करें।`);
    else if (putWeak) add("PUT writing (support)", "bear", 2, `${g(immSupport)} पर PUT OI घट रहा है और LTP कमजोर है — support कमजोर होने का संकेत है, जिससे downside pressure बढ़ सकता है।`);
  }
  if (nearResistance) {
    if (callStrong) add("CALL writing (resistance)", "bear", 2, `${g(immResistance)} पर CALL writing strong है — इससे upside momentum में रुकावट आ सकती है।`);
    else if (callWeak) add("CALL writing (resistance)", "bull", 2, `${g(immResistance)} पर CALL OI घट रहा है — ये CALL short covering / resistance कमजोर होने का संकेत हो सकता है।`);
  }

  // ---------- §8/§9 aggressive writers + writer battle ----------
  const aggCall = callWall?.strike ?? null;
  const aggPut = putWall?.strike ?? null;
  let battleNote = "";
  if (callPct != null && putPct != null) {
    const diff = callPct - putPct;
    if (Math.abs(diff) <= 8) {
      battleNote = "CALL और PUT writers के बीच pressure लगभग बराबर है, इसलिए direction clear नहीं है।";
      add("Writer Battle", "neutral", 0, battleNote);
    } else if (diff > 0) {
      battleNote = `CALL writers अभी ज़्यादा dominant हैं (${callPct}% vs ${putPct}%) — इससे market पर upside resistance का pressure बना हुआ है।`;
      add("Writer Battle", "bear", 1, battleNote);
    } else {
      battleNote = `PUT writers अभी ज़्यादा dominant हैं (${putPct}% vs ${callPct}%) — इससे downside पर support मज़बूत होने का संकेत है।`;
      add("Writer Battle", "bull", 1, battleNote);
    }
  }

  // ---------- §5/§6 EMA logic (21 EMA, 50 EMA) ----------
  if (ema21 != null && ema50 != null) {
    if (spot > ema21 && spot > ema50) add("21/50 EMA", "bull", 2, "Price 21 EMA और 50 EMA दोनों के ऊपर है — short-term और medium-term trend bullish है। गिरावट में 21 EMA पहला dynamic support रहेगा।");
    else if (spot < ema21 && spot < ema50) add("21/50 EMA", "bear", 2, "Price 21 EMA और 50 EMA दोनों के नीचे है — market में bearish pressure है। 21 EMA ऊपर पहला resistance और 50 EMA अहम dynamic resistance है।");
    else add("21/50 EMA", "neutral", 0, "Price 21 EMA और 50 EMA के बीच है — direction clear नहीं है और यहाँ false signals ज़्यादा आते हैं; entry से पहले confirmation का wait करें।");
    // EMA cross (medium-term trend)
    if (ema21 > ema50) add("EMA Cross", "bull", 1, "21 EMA, 50 EMA के ऊपर है — medium-term trend bullish है।");
    else if (ema21 < ema50) add("EMA Cross", "bear", 1, "21 EMA, 50 EMA के नीचे है — medium-term trend bearish है।");
  }

  // ---------- §11 VWAP ----------
  if (vwap != null) {
    if (spot > vwap) add("VWAP", "bull", 1, "Price VWAP के ऊपर है — intraday buyers का control अपेक्षाकृत strong है।");
    else if (spot < vwap) add("VWAP", "bear", 1, "Price VWAP के नीचे है — intraday sellers का control अपेक्षाकृत strong है।");
  }

  // ---------- §12 MACD ----------
  if (macdHist != null) {
    const rising = macdHistPrev != null && macdHist > macdHistPrev;
    const falling = macdHistPrev != null && macdHist < macdHistPrev;
    if (macdHist > 0 && rising) add("MACD", "bull", 1, "MACD momentum bullish side बढ़ रहा है।");
    else if (macdHist < 0 && falling) add("MACD", "bear", 1, "MACD momentum bearish side बढ़ रहा है।");
    else add("MACD", "neutral", 0, "MACD में clear momentum नहीं है।");
  }

  // ---------- §10 market structure ----------
  if (structure === "Bullish") add("Structure", "bull", 1, "Market structure bullish है (Higher High / Higher Low)।");
  else if (structure === "Bearish") add("Structure", "bear", 1, "Market structure bearish है (Lower High / Lower Low)।");
  else if (structure === "Range") add("Structure", "neutral", 0, "Market range में है — range के बाहर टिकाव मिलने तक wait करें।");
  else add("Structure", "neutral", 0, "Market structure clear नहीं है।");

  // ---------- §12/PCR ----------
  if (pcr != null) {
    if (pcr >= 1.1) add("PCR", "bull", 1, `PCR ${pcr} है — PUT writing अपेक्षाकृत heavy है, जो support का संकेत देता है।`);
    else if (pcr <= 0.7) add("PCR", "bear", 1, `PCR ${pcr} है — CALL writing अपेक्षाकृत heavy है, जो resistance का संकेत देता है।`);
    else add("PCR", "neutral", 0, `PCR ${pcr} — लगभग balanced।`);
  }

  // ---------- OI verdict (independent read) ----------
  if (oiVerdict === "Bullish") add("OI trend", "bull", 1, "Overall OI trend bullish side है।");
  else if (oiVerdict === "Bearish") add("OI trend", "bear", 1, "Overall OI trend bearish side है।");

  // ---------- §13/§14 multi-confirmation → conclusion ----------
  const total = bull + bear;
  const net = bull - bear;
  // A meaningful factor pointing the "wrong" way against a strong lean = conflict.
  const strongBull = factors.filter((f) => f.dir === "bull" && f.weight >= 2).length;
  const strongBear = factors.filter((f) => f.dir === "bear" && f.weight >= 2).length;
  const conflict = strongBull >= 1 && strongBear >= 1 && Math.abs(net) < 3;

  let conclusion: MarketCommentary["conclusion"];
  let headline: string;
  if (conflict) {
    conclusion = "CONFLICT";
    headline = "Wait करें — signals में मतभेद है";
  } else if (net >= 4 && bull >= 6) {
    conclusion = "BULL_CONFIRM";
    headline = "Bullish confirmation — risk management के साथ";
  } else if (net <= -4 && bear >= 6) {
    conclusion = "BEAR_CONFIRM";
    headline = "Bearish confirmation — risk management के साथ";
  } else {
    conclusion = "WAIT";
    headline = "Wait करें — अभी clear trade नहीं";
  }

  // ---------- §18 structured reasons / bull-bear / next confirmation / guidance ----------
  // Writer Battle is shown in its own aggressive-writer section, so keep it OUT of the
  // reasons list to avoid stating call/put dominance twice.
  const reasons = factors
    .filter((f) => f.weight >= 1 && f.name !== "Writer Battle")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((f) => f.text);

  const bullCase = immSupport != null
    ? `${g(immSupport)} के ऊपर टिकाव और buying confirmation मिलने पर ${g(immResistance ?? majorResistance)} की ओर upside की संभावना है।`
    : `Resistance के ऊपर टिकाव मिलने पर upside momentum संभव है।`;
  const bearCase = immSupport != null
    ? `${g(immSupport)} के नीचे टिकाव मिलने पर ${g(majorSupport ?? immSupport)} की ओर downside की संभावना बढ़ेगी।`
    : `Support के नीचे टिकाव मिलने पर downside pressure बढ़ेगा।`;

  let nextConfirm: string;
  if (conclusion === "BULL_CONFIRM") nextConfirm = `${g(immResistance ?? spot)} के ऊपर strong टिकाव और CALL writing घटने का confirmation मिलने पर bullish signal और strong होगा।`;
  else if (conclusion === "BEAR_CONFIRM") nextConfirm = `${g(immSupport ?? spot)} के नीचे टिकाव और PUT writing कमज़ोर होने का confirmation मिलने पर bearish signal और strong होगा।`;
  else nextConfirm = `Trade लेने से पहले ${g(immSupport ?? spot)} के टूटने या bounce होने का confirmation का wait करें।`;

  let guidance: string;
  if (conclusion === "CONFLICT") guidance = "Signals एक-दूसरे को confirm नहीं कर रहे — clear confirmation के बिना trade न लें।";
  else if (conclusion === "WAIT") guidance = `अभी entry न लें। ${g(immSupport ?? spot)} के आसपास market की reaction और OI change का confirmation का wait करें।`;
  else if (conclusion === "BULL_CONFIRM") guidance = "Bullish signals aligned हैं, फिर भी stop loss के साथ ही position लें — risk management ज़रूरी है।";
  else guidance = "Bearish signals aligned हैं, फिर भी stop loss के साथ ही position लें — risk management ज़रूरी है।";

  const path = {
    up: immResistance != null ? `${g(immResistance)} के ऊपर टिकाव → ${g(majorResistance ?? immResistance)}` : "",
    down: immSupport != null ? `${g(immSupport)} के नीचे टिकाव → ${g(majorSupport ?? immSupport)}` : "",
  };

  // When the market is closed, keep the structural analysis for reference but never imply a
  // live trade: force WAIT and label the commentary accordingly.
  if (!marketOpen) {
    conclusion = "WAIT";
    headline = "Market बंद है — ये analysis पिछले available data पर based है (कोई live signal नहीं)";
    guidance = "Market बंद है — अभी कोई live trade न लें, ये analysis सिर्फ reference के लिए है।";
  }

  return {
    headline, conclusion,
    levels: { majorResistance, immResistance, price: spot, immSupport, majorSupport },
    situation, reasons, bullCase, bearCase, nextConfirm, guidance, path,
    aggressiveCallWriter: aggCall, aggressivePutWriter: aggPut,
    writerBattle: { callPct, putPct, note: battleNote },
    factors, bullScore: bull, bearScore: bear, lines,
  };
}

// Fixed-wording, Hinglish market-result clause per exit path (why the trade hit/missed).
const REVIEW_CLAUSE: Record<string, string> = {
  target: "trend clean चला, target तक पहुँच गया — कोई reversal नहीं आया।",
  stop: "SL पर बाहर — level जल्दी टूट गया, expected move नहीं मिला।",
  decay: "premium decay हो गया जबकि spot सही direction में था (theta bleed)।",
  stall: "30-min तक follow-through नहीं आया — stall exit।",
  reversal: "trend पलट गया — reversal पर बाहर निकलना पड़ा।",
  eod: "EOD square-off — दिन ख़त्म, target से पहले flatten हुआ।",
  time: "time exit — move समय पर नहीं आया।",
  trail: "trailing stop पर profit book हुआ, target touch नहीं हुआ।",
  profit: "portfolio profit target पर सब book हुआ।",
  risk: "risk kill-switch — drawdown पर सब बंद।",
  end: "run end पर position बंद।",
};

// Build the fixed-format post-exit review line for ONE closed paper trade:
// "Target HIT — 22 min — +9 points — <clause>"  (sourced from existing paper-trade fields).
export function formatTradeReview(t: {
  exitReason: string; entryEpoch: number; exitEpoch: number;
  exitPrice: number; premiumTarget?: number | null; pnl?: number;
}): string {
  const hasTgt = t.premiumTarget != null && isFinite(t.premiumTarget as number);
  const hit = hasTgt ? t.exitPrice >= (t.premiumTarget as number) - 0.01 : t.exitReason === "target";
  const mins = Math.max(0, Math.round(((t.exitEpoch || 0) - (t.entryEpoch || 0)) / 60));
  let varStr = "—";
  if (hasTgt) {
    const v = Math.round((t.exitPrice - (t.premiumTarget as number)) * 10) / 10;
    varStr = `${v >= 0 ? "+" : ""}${v} points`;
  }
  const clause = REVIEW_CLAUSE[t.exitReason] || "trade बंद हुआ।";
  const tag = hit ? "Target HIT" : "Target MISS";
  return `${tag} — ${mins} min — ${varStr} — ${clause}`;
}

// Lightweight market-structure read from recent bars (HH/HL vs LH/LL, else Range/Unclear).
export function detectStructure(bars: { high: number; low: number; close: number }[]): Structure {
  const n = bars.length;
  if (n < 12) return "Unclear";
  const recent = bars.slice(-6);
  const prior = bars.slice(-12, -6);
  const hi = (a: { high: number }[]) => Math.max(...a.map((x) => x.high));
  const lo = (a: { low: number }[]) => Math.min(...a.map((x) => x.low));
  const rHi = hi(recent), rLo = lo(recent), pHi = hi(prior), pLo = lo(prior);
  const price = bars[n - 1].close || 1;
  const span = (Math.max(rHi, pHi) - Math.min(rLo, pLo)) / price;
  if (span < 0.005) return "Range";
  const hh = rHi > pHi, hl = rLo > pLo, lh = rHi < pHi, ll = rLo < pLo;
  if (hh && hl) return "Bullish";
  if (lh && ll) return "Bearish";
  return "Unclear";
}
