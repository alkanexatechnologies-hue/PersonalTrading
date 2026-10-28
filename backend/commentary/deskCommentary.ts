// ============================ PROTRADER DESK COMMENTARY — Market Command, in Hindi (owner, 2026-10-28) ============================
// The owner asked for the screen to talk like the live chat guidance: what just happened on the 5-min candles (range,
// rejection, SL hunt), the market condition (pin strike, walls), then the UP and DOWN trade with the strike and the EXACT
// premium to buy at, the stop and the target, and the rules (no-trade zone, one trade, skip a premium that already ran,
// time cut-offs). Formatting / messages only: every level, stop, target and premium comes from the existing ProTrader-
// approved Trade Plan (premium/traderView.plans) and the co-pilot's own trade state — this module adds NO trading rule.
// Candle reads (rejection, SL hunt, range) are descriptions, never triggers. Advisory only.

export interface DeskBar { time: number; open: number; high: number; low: number; close: number }
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
  atm: { strike: number; ceOi: number; peOi: number } | null;
  trade: { side: "CE" | "PE"; strike: number; entrySpot: number; entryPrem: number | null; stop: number; t1: number; t2: number | null; state: string; openedAt: number; exitWhy?: string } | null;
  pending: { side: "bull" | "bear"; trigger: number; from: number; until: number } | null;
  premLive?: number | null;                       // the open trade's live premium
}
export interface DeskCard {
  side: "CE" | "PE"; strike: number | null; expiry: string | null; trigger: string; risk: string; history: string | null;
  buyAt: number | null; buyMax: number | null; skipAbove: number | null; stopIdx: number; stopPrem: number | null; t1Idx: number; t1Prem: number | null; t2Idx: number | null; t2Prem: number | null;
  rr: number; perLotRisk: number | null; perLotReward: number | null; premNow: number | null; status: string;
}
export interface DeskCommentary {
  index: string; asOf: string; tone: "wait" | "ce" | "pe" | "closed"; headline: string; condition: { label: string; text: string };
  story: string[]; market: string[]; up: DeskCard | null; down: DeskCard | null; rules: string[]; note: string;
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
  return {
    index: I.index, asOf: hm(I.nowSec), tone, headline, condition, story, market, up, down, rules,
    note: "ProTrader का विश्लेषण — levels, SL और target सिस्टम के approved Trade Plan से। Premium Black-Scholes अनुमान है (IV बदले तो ±3–5)। यह forecast नहीं, सलाह मात्र; 2 साल के test में कोई level सिक्के से बेहतर नहीं टिका — level पर reaction देखें।",
  };
}
