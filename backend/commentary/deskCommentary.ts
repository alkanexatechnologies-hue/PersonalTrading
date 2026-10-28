// ============================ PROTRADER DESK COMMENTARY — Market Command, in Hindi (owner, 2026-10-28) ============================
// The owner asked for the screen to talk like the live chat guidance: what just happened on the 5-min candles (range,
// rejection, SL hunt), the market condition (pin strike, walls), then the UP and DOWN trade with the strike and the EXACT
// premium to buy at, the stop and the target, and the rules (no-trade zone, one trade, skip a premium that already ran,
// time cut-offs). Formatting / messages only: every level, stop, target and premium comes from the existing ProTrader-
// approved Trade Plan (premium/traderView.plans) and the co-pilot's own trade state — this module adds NO trading rule.
// Candle reads (rejection, SL hunt, range) are descriptions, never triggers. Advisory only.

export interface DeskBar { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface DeskPlan {
  side: "CE" | "PE"; trigger: number; entry: number; stop: number; t1: number; t1Label?: string; t2: number | null; t2Label?: string | null; rr: number;
  strike: number | null; expiry: string | null; premNow: number | null; premAtEntry: number | null; premAtStop: number | null; premAtT1: number | null; premAtT2: number | null;
  triggerLabel?: string; triggerRisk?: { risk: string; reasons?: string[] } | null; history?: { pct: number; n: number } | null;
}
export interface DeskInput {
  index: string; nowSec: number; step: number; lot: number; atr15: number | null;
  spot: number; dayHigh: number | null; dayLow: number | null; prevClose: number | null;
  c5: DeskBar[];                                  // today's 5-min bars, oldest first (the last one may still be forming)
  bull: DeskPlan | null; bear: DeskPlan | null; noTrade: { from: number; to: number } | null;
  callWall: { strike: number; oiL: number; state?: string } | null; putWall: { strike: number; oiL: number; state?: string } | null;
  atm: { strike: number; ceOi: number; peOi: number; ceChg?: number | null; peChg?: number | null; ceLtpChgPct?: number | null; peLtpChgPct?: number | null } | null;
  movers?: { side: "CE" | "PE"; strike: number; chg: number }[];   // today's biggest OI additions near the price
  trade: { side: "CE" | "PE"; strike: number; entrySpot: number; entryPrem: number | null; stop: number; t1: number; t2: number | null; state: string; openedAt: number; exitWhy?: string } | null;
  pending: { side: "bull" | "bear"; trigger: number; from: number; until: number } | null;
  premLive?: number | null;                       // the open trade's live premium
  closedToday?: { side: "CE" | "PE"; strike: number; won: boolean }[];   // the co-pilot's closed trades today
}
export interface DeskCard {
  side: "CE" | "PE"; strike: number | null; expiry: string | null; trigger: string; risk: string; history: string | null;
  buyAt: number | null; buyMax: number | null; skipAbove: number | null; stopIdx: number; stopPrem: number | null; t1Idx: number; t1Prem: number | null; t2Idx: number | null; t2Prem: number | null;
  rr: number; perLotRisk: number | null; perLotReward: number | null; premNow: number | null; status: string;
}
export interface DeskCommentary {
  index: string; asOf: string; tone: "wait" | "ce" | "pe" | "closed"; headline: string; condition: { label: string; text: string };
  story: string[]; market: string[]; up: DeskCard | null; down: DeskCard | null; rules: string[]; note: string;
  // the live-class layer (owner, 2026-10-28: "like a YouTuber, the best experienced trader guiding a junior")
  intro: string; structure: { label: string; text: string; bias: "UP" | "DOWN" | null } | null; oiRead: string[];
  best: { side: "CE" | "PE" | null; title: string; steps: { k: string; v: string }[]; why: string } | null; lessons: string[];
}

/** Price structure of the last hour from 3-bar pivots: lower highs / higher lows / flat floor or top → a plain-Hindi read. */
export function readStructure(I: DeskInput): { label: string; text: string; bias: "UP" | "DOWN" | null; highs: number[]; lows: number[] } | null {
  const b = I.c5.filter((x) => x.time + 300 <= I.nowSec).slice(-14); if (b.length < 6) return null;
  const highs: number[] = [], lows: number[] = [];
  for (let i = 1; i < b.length - 1; i++) {   // a pivot needs the bar after it (the latest bar is not a pivot yet)
    if (b[i].high >= b[i - 1].high && b[i].high >= b[i + 1].high) highs.push(b[i].high);
    if (b[i].low <= b[i - 1].low && b[i].low <= b[i + 1].low) lows.push(b[i].low);
  }
  const atr = I.atr15 && I.atr15 > 0 ? I.atr15 : I.spot * 0.002, flat = atr * 0.35;
  const H = highs.slice(-3), L = lows.slice(-3), seq = (a: number[]) => a.map((x) => f0(x)).join(" → ");
  const lh = H.length >= 3 && H.every((x, i) => !i || x < H[i - 1]), hh = H.length >= 3 && H.every((x, i) => !i || x > H[i - 1]);
  const hl = L.length >= 3 && L.every((x, i) => !i || x > L[i - 1]), ll = L.length >= 3 && L.every((x, i) => !i || x < L[i - 1]);
  const lowFlat = L.length >= 2 && Math.max(...L) - Math.min(...L) <= flat, highFlat = H.length >= 2 && Math.max(...H) - Math.min(...H) <= flat;
  if (lh && lowFlat) return { label: "DESCENDING TRIANGLE", bias: "DOWN", highs: H, lows: L, text: `हर high पिछले से नीचे: <b>${seq(H)}</b>, और low ${f0(Math.min(...L))}–${f0(Math.max(...L))} पर सपाट। छत नीचे आ रही है, फ़र्श सपाट — आमतौर पर नीचे टूटता है, पर पक्का नहीं।` };
  if (hl && highFlat) return { label: "ASCENDING TRIANGLE", bias: "UP", highs: H, lows: L, text: `हर low पिछले से ऊपर: <b>${seq(L)}</b>, और high ${f0(Math.min(...H))}–${f0(Math.max(...H))} पर सपाट। फ़र्श ऊपर आ रहा है — आमतौर पर ऊपर टूटता है, पर पक्का नहीं।` };
  if (lh && ll) return { label: "DOWNTREND", bias: "DOWN", highs: H, lows: L, text: `Lower highs (<b>${seq(H)}</b>) और lower lows — sellers हर उछाल पर बेच रहे हैं।` };
  if (hh && hl) return { label: "UPTREND", bias: "UP", highs: H, lows: L, text: `Higher highs (<b>${seq(H)}</b>) और higher lows — buyers हर गिरावट पर खरीद रहे हैं।` };
  if (lh) return { label: "LOWER HIGHS", bias: "DOWN", highs: H, lows: L, text: `हर high पिछले से नीचे: <b>${seq(H)}</b> — ऊपर दबाव है, sellers सक्रिय।` };
  if (hl) return { label: "HIGHER LOWS", bias: "UP", highs: H, lows: L, text: `हर low पिछले से ऊपर: <b>${seq(L)}</b> — नीचे खरीदार खड़े हैं।` };
  return { label: "MIXED", bias: null, highs: H, lows: L, text: "Highs और lows कोई साफ़ सीढ़ी नहीं बना रहे — दिशा तय नहीं, इंतज़ार बेहतर।" };
}

/** Volume-weighted average price of today's 5-min bars (typical price), or null without volume. */
export function vwapOf(c5: DeskBar[]): number | null {
  let pv = 0, v = 0; for (const b of c5) { const q = b.volume || 0; pv += ((b.high + b.low + b.close) / 3) * q; v += q; }
  return v > 0 ? pv / v : null;
}

const IST = 19800;
const hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const f0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const r0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v));
const RISK_HI: Record<string, string> = { LOW: "कम", MEDIUM: "मध्यम", HIGH: "ज़्यादा", FAR: "दूर" };

/** Candle reads of the last hour, in Hindi: the hour's range, rejections, buying and SL hunts at the plan / wall levels. */
export function readCandles(I: DeskInput): { story: string[]; range: { hi: number; lo: number } | null } {
  const closed = I.c5.filter((b) => b.time + 300 <= I.nowSec), story: string[] = [];
  if (!closed.length) return { story: ["आज के 5-min candles अभी नहीं बने।"], range: null };
  const last12 = closed.slice(-12), hi = Math.max(...last12.map((b) => b.high)), lo = Math.min(...last12.map((b) => b.low));
  const hiBar = last12.find((b) => b.high === hi)!, loBar = last12.find((b) => b.low === lo)!;
  story.push(`पिछले 1 घंटे की range <b>${f0(lo)} – ${f0(hi)}</b> (${f0(hi - lo)} pts) · high ${hm(hiBar.time)}, low ${hm(loBar.time)}।`);
  const atr = I.atr15 && I.atr15 > 0 ? I.atr15 : I.spot * 0.002;
  // levels the reads refer to: the plan triggers and the OI walls (never the day's own high / low — that is the bar itself)
  const highs = [I.bull?.trigger, I.callWall?.strike].filter((x): x is number => x != null);
  const lows = [I.bear?.trigger, I.putWall?.strike].filter((x): x is number => x != null);
  const tol = Math.max(atr * 0.35, I.step * 0.5), pierce = Math.max(3, atr * 0.15), near = (p: number, arr: number[]) => arr.find((x) => Math.abs(p - x) <= tol) ?? null;
  const ev: string[] = [];
  for (const b of last12) {
    const rng = b.high - b.low; if (rng <= 0) continue;
    // SL hunt: the bar pierced a level and closed back on the other side of it
    const lvLo = lows.find((x) => b.low <= x - pierce && b.close > x + 2), lvHi = highs.find((x) => b.high >= x + pierce && b.close < x - 2);
    if (lvLo != null) { ev.push(`${hm(b.time)}: <b>${f0(lvLo)}</b> के नीचे ${f0(lvLo - b.low)} pts का wick, फिर ${f0(b.close)} पर ऊपर close — <b>SL hunt</b> (नीचे बेचने वाले फँसे)।`); continue; }
    if (lvHi != null) { ev.push(`${hm(b.time)}: <b>${f0(lvHi)}</b> के ऊपर ${f0(b.high - lvHi)} pts का wick, फिर ${f0(b.close)} पर नीचे close — <b>SL hunt</b> (ऊपर खरीदने वाले फँसे)।`); continue; }
    if (rng < atr * 0.25) continue;
    const at = near(b.high, highs), atL = near(b.low, lows), pos = (b.close - b.low) / rng;
    if (at != null && pos <= 0.4) ev.push(`${hm(b.time)}: ${f0(b.high)} से <b>rejection</b> — high से ${f0(b.high - b.close)} pts नीचे close, ${f0(at)} के पास sellers सक्रिय।`);
    else if (atL != null && pos >= 0.6) ev.push(`${hm(b.time)}: ${f0(b.low)} से <b>खरीदारी</b> — low से ${f0(b.close - b.low)} pts ऊपर close, ${f0(atL)} के पास buyers सक्रिय।`);
  }
  story.push(...ev.slice(-3));   // the latest three reads
  return { story, range: { hi, lo } };
}

function card(p: DeskPlan, I: DeskInput, status: string): DeskCard {
  const buyAt = r0(p.premAtEntry), stopP = r0(p.premAtStop), t1P = r0(p.premAtT1);
  const word = p.side === "CE" ? "ऊपर" : "नीचे";
  return {
    side: p.side, strike: p.strike, expiry: p.expiry, trigger: `15-min close <b>${f0(p.trigger)}</b> के ${word}, फिर 5-min retest पर entry (${f0(p.entry)})`,
    risk: RISK_HI[p.triggerRisk?.risk || ""] || "—", history: p.history ? `पिछले ${p.history.n} breaks में ${p.history.pct}% आगे बढ़े` : null,
    buyAt, buyMax: buyAt != null ? Math.round(buyAt * 1.05) : null, skipAbove: buyAt != null ? Math.round(buyAt * 1.1) : null,
    stopIdx: Math.round(p.stop), stopPrem: stopP, t1Idx: Math.round(p.t1), t1Prem: t1P, t2Idx: p.t2 != null ? Math.round(p.t2) : null, t2Prem: r0(p.premAtT2),
    rr: p.rr, perLotRisk: buyAt != null && stopP != null ? Math.round((buyAt - stopP) * I.lot) : null, perLotReward: buyAt != null && t1P != null ? Math.round((t1P - buyAt) * I.lot) : null,
    premNow: r0(p.premNow), status,
  };
}

export function buildDeskCommentary(I: DeskInput): DeskCommentary {
  const istMin = Math.floor(((I.nowSec + IST) % 86400) / 60), { story, range } = readCandles(I);
  const nt = I.noTrade, inZone = !!nt && I.spot > nt.from && I.spot < nt.to;
  // market condition — a description of the last hour, not a signal
  let condition = { label: "—", text: "" };
  if (range) {
    const w = range.hi - range.lo, atr = I.atr15 && I.atr15 > 0 ? I.atr15 : I.spot * 0.002, closed = I.c5.filter((b) => b.time + 300 <= I.nowSec).slice(-12);
    const move = closed.length ? closed[closed.length - 1].close - closed[0].open : 0;
    condition = Math.abs(move) >= w * 0.6 && w >= atr ? { label: move > 0 ? "TREND ▲" : "TREND ▼", text: `पिछले घंटे ${move > 0 ? "+" : "−"}${f0(Math.abs(move))} pts एक दिशा में — ${move > 0 ? "buyers" : "sellers"} हावी।` }
      : { label: "RANGE", text: `पिछले घंटे भाव ${f0(range.lo)}–${f0(range.hi)} में घूम रहा है — दोनों तरफ़ के signal जल्दी fail होते हैं (whipsaw)।` };
  }
  const market: string[] = [];
  if (I.atm && I.atm.ceOi > 0 && I.atm.peOi > 0) {
    const ratio = I.atm.peOi / I.atm.ceOi;
    if (ratio >= 0.75 && ratio <= 1.33) market.push(`<b>${f0(I.atm.strike)} pin</b> — ATM पर call (${(I.atm.ceOi / 1e5).toFixed(0)}L) और put (${(I.atm.peOi / 1e5).toFixed(0)}L) OI लगभग बराबर; writers भाव को यहीं रोकना चाहते हैं, option buyer का theta कटता है।`);
  }
  const ws = (s?: string) => (s === "STRENGTHENING" ? " · मज़बूत हो रही" : s === "WEAKENING" ? " · कमज़ोर हो रही" : "");
  if (I.callWall) market.push(`छत: <b>${f0(I.callWall.strike)}</b> call wall (${I.callWall.oiL.toFixed(1)}L${ws(I.callWall.state)}) — ${f0(I.callWall.strike - I.spot)} pts ऊपर।`);
  if (I.putWall) market.push(`फ़र्श: <b>${f0(I.putWall.strike)}</b> put wall (${I.putWall.oiL.toFixed(1)}L${ws(I.putWall.state)}) — ${f0(I.spot - I.putWall.strike)} pts नीचे।`);
  if (I.dayHigh != null && I.dayLow != null) market.push(`आज का दायरा ${f0(I.dayLow)} – ${f0(I.dayHigh)}${I.prevClose ? ` · कल का close ${f0(I.prevClose)}` : ""}।`);

  // each side's real status from the co-pilot state (never a bare "BUY")
  const tr = I.trade, open = tr && tr.state !== "CLOSED" ? tr : null;
  const stat = (side: "CE" | "PE") => {
    if (tr && tr.side === side) return tr.state === "CLOSED" ? `ट्रेड बंद (${tr.exitWhy || "exit"})` : tr.state === "T1" ? `ट्रेड चालू · T1 मिल गया, SL अब entry पर` : `ट्रेड चालू (${hm(tr.openedAt)} से)`;
    const pd = I.pending; if (pd && (pd.side === "bull") === (side === "CE")) return `15-min close हो गया — ${hm(pd.until)} तक 5-min retest का इंतज़ार`;
    return "इंतज़ार — trigger नहीं हुआ";
  };
  const up = I.bull ? card(I.bull, I, stat("CE")) : null, down = I.bear ? card(I.bear, I, stat("PE")) : null;

  // headline + tone
  let tone: DeskCommentary["tone"] = "wait", headline: string;
  if (istMin >= 912) { tone = "closed"; headline = "15:12 के बाद — सब trade बंद करें, नई entry नहीं।"; }
  else if (open) { tone = open.side === "CE" ? "ce" : "pe"; const pl = I.premLive != null && open.entryPrem != null ? ` · premium ${Math.round(I.premLive)} (${I.premLive >= open.entryPrem ? "+" : "−"}${Math.round(Math.abs(I.premLive - open.entryPrem))})` : "";
    headline = `${I.index} ${open.strike} ${open.side} चालू — SL <b>${f0(open.stop)}</b> (15-min close), T1 <b>${f0(open.t1)}</b>${pl}। नया trade नहीं।`; }
  else if (I.pending) { tone = I.pending.side === "bull" ? "ce" : "pe"; headline = `${I.pending.side === "bull" ? "CE" : "PE"} trigger का 15-min close हो गया — अब 5-min retest का इंतज़ार, पीछा मत करें।`; }
  else if (istMin > 885) headline = "14:45 के बाद नई entry नहीं — late breakout अक्सर fail होते हैं।";
  else if (inZone) headline = `अभी कोई trade नहीं — ${f0(I.spot)} no-trade zone (${f0(nt!.from)}–${f0(nt!.to)}) के बीच है। बीच में खरीदना = theta देकर सिक्का उछालना।`;
  else headline = "भाव plan level के बाहर है — trigger की शर्त पूरी हुई या नहीं, नीचे दोनों तरफ़ देखें।";

  const rules = [
    nt ? `<b>${f0(nt.from)} – ${f0(nt.to)}</b> के बीच trade नहीं।` : "Plan level के बीच trade नहीं।",
    "Entry सिर्फ़ <b>15-min candle close</b> के बाद, फिर 5-min retest पर — level छूने पर नहीं।",
    "Premium दिए गए buy price से <b>10% ज़्यादा</b> हो तो छोड़ दें — move निकल चुका, 1:2 नहीं बचा।",
    "SL index के 15-min close पर है; premium अपने SL price से नीचे जाए तो भी बाहर।",
    "दिन में एक trade — SL लगा तो तुरंत उल्टी तरफ़ मत कूदें। 2 loss = दिन बंद।",
    "14:45 के बाद नई entry नहीं · 15:12 पर सब exit।",
  ];
  // ---------------- live class: structure, OI read, the best opportunity step by step, lessons ----------------
  const atr = I.atr15 && I.atr15 > 0 ? I.atr15 : I.spot * 0.002, st = readStructure(I), vw = vwapOf(I.c5);
  const structure = st ? { label: st.label, text: st.text, bias: st.bias } : null;
  const L = (v: number) => `${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1e5).toFixed(1)}L`;
  const oiRead: string[] = [];
  if (I.atm && I.atm.ceChg != null && I.atm.peChg != null) {
    const c = I.atm.ceChg, p = I.atm.peChg, who = c > p * 1.2 ? "call writers हावी — ऊपर रोक" : p > c * 1.2 ? "put writers हावी — नीचे सहारा" : "दोनों तरफ़ बराबर writing — लड़ाई";
    oiRead.push(`ATM <b>${f0(I.atm.strike)}</b>: call OI ${L(c)}, put OI ${L(p)} आज — ${who}।`);
  }
  if (I.atm?.ceLtpChgPct != null && I.atm.ceLtpChgPct <= -8) oiRead.push(`CE premiums −${Math.abs(Math.round(I.atm.ceLtpChgPct))}% गिरे — call sellers ऊपर नहीं जाने दे रहे।`);
  if (I.atm?.peLtpChgPct != null && I.atm.peLtpChgPct <= -8) oiRead.push(`PE premiums −${Math.abs(Math.round(I.atm.peLtpChgPct))}% गिरे — put sellers नीचे नहीं जाने दे रहे।`);
  for (const m of (I.movers || []).slice(0, 2)) if (m.chg > 0) oiRead.push(`${f0(m.strike)} ${m.side} में ${L(m.chg)} नई writing = ${m.side === "PE" ? "support बन रहा" : "resistance बन रहा"}।`);
  const hunted = (lv: number) => story.some((x) => x.includes(`<b>${f0(lv)}</b>`) && /SL hunt/.test(x));
  if (I.putWall && Math.abs(I.spot - I.putWall.strike) <= atr * 0.6) oiRead.push(`भाव <b>${f0(I.putWall.strike)}</b> put wall पर है${hunted(I.putWall.strike) ? " — यहीं पहले SL hunt हो चुका है" : ""}। यही असली लड़ाई की जगह है।`);
  if (I.callWall && Math.abs(I.spot - I.callWall.strike) <= atr * 0.6) oiRead.push(`भाव <b>${f0(I.callWall.strike)}</b> call wall पर है${hunted(I.callWall.strike) ? " — यहीं पहले SL hunt हो चुका है" : ""}। writers यहाँ लड़ेंगे।`);
  if (vw != null) oiRead.push(`VWAP <b>${f0(vw)}</b> ${I.spot > vw ? `नीचे है (${f0(I.spot - vw)} pts) — गिरावट आई तो magnet वहीं` : `ऊपर है (${f0(vw - I.spot)} pts) — उछाल आया तो magnet वहीं`}।`);

  // the best opportunity: the plan side that agrees with the structure (else the nearer start) — the plan's own numbers
  let best: DeskCommentary["best"] = null;
  if (istMin >= 912) best = { side: null, title: "आज का खेल ख़त्म — 15:12 के बाद सब exit", steps: [], why: "बाज़ार बंद होने से पहले theta और spread सबसे ज़्यादा काटते हैं।" };
  else if (open) {
    const k = open.side === "CE" ? up : down;
    best = { side: open.side, title: `चालू trade संभालें: ${open.strike} ${open.side}`, why: "नया trade नहीं — चालू trade को plan के मुताबिक़ चलाइए।", steps: [
      { k: "🛑 SL", v: `NIFTY की 15-min candle <b>${f0(open.stop)}</b> के ${open.side === "CE" ? "नीचे" : "ऊपर"} बंद हो तो बाहर` },
      { k: "✅ T1", v: `<b>${f0(open.t1)}</b> पर आधा बेचें, फिर SL entry पर` + (k?.t1Prem != null ? ` (≈ ₹${k.t1Prem})` : "") },
      ...(open.t2 != null ? [{ k: "🚀 T2", v: `<b>${f0(open.t2)}</b>` }] : []), { k: "⏰ Exit", v: "15:12 पर हर हाल में" }] };
  } else if (istMin > 885) best = { side: null, title: "आज नया trade नहीं", steps: [], why: "14:45 के बाद entry नहीं — late breakout अक्सर fail होते हैं और theta तेज़ कटता है।" };
  else {
    const cands = [up, down].filter((k): k is DeskCard => !!k).map((k) => { const pl = k.side === "CE" ? I.bull! : I.bear!; return { k, pl, d: Math.abs(I.spot - pl.entry), agree: structure?.bias === (k.side === "CE" ? "UP" : "DOWN") }; });
    cands.sort((a, b) => Number(b.agree) - Number(a.agree) || a.d - b.d);
    const c = cands[0];
    if (!c || c.d > atr * 1.5) best = { side: null, title: "अभी कोई मौका पास नहीं", steps: [], why: `दोनों plan starts दूर हैं${c ? ` (नज़दीकी ${f0(c.d)} pts)` : ""}। कुछ न करना भी एक position है।` };
    else {
      const ce = c.k.side === "CE", dir = ce ? "ऊपर" : "नीचे", next15 = Math.ceil((I.nowSec + 1) / 900) * 900, pd = I.pending && (I.pending.side === "bull") === ce ? I.pending : null;
      const until = Math.min(pd ? pd.until : next15 + 1800, Math.floor(I.nowSec / 86400) * 86400 + (885 * 60 - IST));
      const t2v = c.k.t2Idx != null ? `₹${c.k.t2Prem ?? "—"} (NIFTY ${f0(c.k.t2Idx)})` : "—";
      const vwapNote = vw != null && (ce ? vw > c.pl.entry && (c.k.t2Idx == null || vw < c.k.t2Idx) : vw < c.pl.entry && (c.k.t2Idx == null || vw > c.k.t2Idx)) ? ` · रास्ते में VWAP ${f0(vw)} magnet` : "";
      best = { side: c.k.side, title: `${c.k.strike} ${c.k.side}${c.k.expiry ? ` (${c.k.expiry.slice(5)} expiry)` : ""}`, steps: [
        { k: "1. Confirmation", v: pd ? `✅ 15-min close हो चुका — अब retest` : `${hm(next15)} की 15-min candle <b>${f0(c.pl.trigger)}</b> के ${dir} बंद हो — candle के बीच में मत कूदिए` },
        { k: "2. Entry", v: `5-min candle वापस ${f0(c.pl.entry)} के पास आकर फिर ${dir} बंद हो — retest` },
        { k: "3. Buy", v: `<b>₹${c.k.buyAt ?? "—"}–${c.k.buyMax ?? "—"}</b>${c.k.premNow != null ? ` (अभी ₹${c.k.premNow})` : ""}` },
        { k: "❌ छोड़ें", v: `premium <b>₹${c.k.skipAbove ?? "—"}</b> से ऊपर हो — train निकल चुकी` },
        { k: "🛑 SL", v: `<b>₹${c.k.stopPrem ?? "—"}</b>, या NIFTY की 15-min candle ${f0(c.k.stopIdx)} के ${ce ? "नीचे" : "ऊपर"} बंद` },
        { k: "✅ T1", v: `<b>₹${c.k.t1Prem ?? "—"}</b> (NIFTY ${f0(c.k.t1Idx)}) — आधा बेचें, SL entry पर` },
        { k: "🚀 T2", v: t2v + vwapNote },
        { k: "⏰ Deadline", v: `${hm(until)} तक retest नहीं मिला तो trade नहीं · 15:12 पर exit` },
      ], why: `${structure?.bias === (ce ? "UP" : "DOWN") ? `Structure (${structure!.label}) इसी तरफ़ इशारा कर रहा है। ` : ""}Risk ${c.k.risk} · 1 lot पर risk ₹${c.k.perLotRisk ?? "—"}, reward ₹${c.k.perLotReward ?? "—"}।` };
    }
  }
  const lessons: string[] = [];
  if (st && (st.label.includes("TRIANGLE") || st.label.includes("LOWER") || st.label.includes("HIGHER") || st.label.includes("TREND"))) lessons.push("<b>Highs और lows की सीढ़ी पढ़िए</b> — दबाव किस तरफ़ है, indicator बाद में बोलता है, candle पहले।");
  if (story.some((x) => /SL hunt/.test(x))) lessons.push("<b>जहाँ SL hunt हुआ, वहाँ दोबारा सावधान</b> — वहाँ जाल बिछ चुका है, इसलिए close का इंतज़ार, touch का नहीं।");
  if (inZone && !open) lessons.push("<b>No-trade zone में खरीदना = theta देकर सिक्का उछालना।</b> रुकना भी skill है।");
  if (istMin >= 870 && istMin < 912) lessons.push("<b>2:30 के बाद time आपका दुश्मन है</b> — छोटा target, T1 पर आधा बेचें।");
  const won = (I.closedToday || []).filter((t) => t.won).length, lost = (I.closedToday || []).length - won;
  if (won) lessons.push("<b>आज का अच्छा trade हो चुका</b> — ज़्यादा trade ज़रूरी नहीं, कुछ न करना भी एक position है।");
  if (lost) lessons.push("<b>SL लगना खेल का हिस्सा है</b> — उल्टी तरफ़ revenge trade मत कीजिए।");
  if (lessons.length < 2) lessons.push("<b>Plan पहले, trade बाद में</b> — entry, SL और target लिखकर ही बटन दबाइए।");
  const intro = `नमस्कार दोस्तों! ${hm(I.nowSec)} बजे ${I.index} <b>${f0(I.spot)}</b> पर है${I.prevClose ? ` (${I.spot >= I.prevClose ? "+" : "−"}${f0(Math.abs(I.spot - I.prevClose))} कल से)` : ""}। चलिए chart पढ़ते हैं।`;

  return {
    index: I.index, asOf: hm(I.nowSec), tone, headline, condition, story, market, up, down, rules, intro, structure, oiRead, best, lessons: lessons.slice(0, 4),
    note: "ProTrader का विश्लेषण — levels, SL और target सिस्टम के approved Trade Plan से। Premium Black-Scholes अनुमान है (IV बदले तो ±3–5)। यह forecast नहीं, सलाह मात्र; 2 साल के test में कोई level सिक्के से बेहतर नहीं टिका — level पर reaction देखें।",
  };
}
