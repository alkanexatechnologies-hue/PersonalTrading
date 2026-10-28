// ============================ 🔄 REVERSAL vs ❌ FAKE REVERSAL candles (One Trade chart, owner 2026-10-29) ============================
// A reversal CANDIDATE is a 15-min candle that, after a move of ≥ 1.2 × the typical candle range over the previous 3 candles,
// makes (or re-tests within 0.1 × typical range) the extreme of that move and closes against it with a reversal shape (hammer / shooting star / engulfing / strong
// opposite close). What happened next decides its label (no look-ahead for the live candle: it stays PENDING):
//   ❌ FAKE  = within the next 4 candles one CLOSES beyond the reversal candle's extreme (the old move resumed — a trap)
//   🔄 REAL  = within the next 4 candles the price travels ≥ 1 × typical range in the new direction, with no such close
//   ↔ WEAK   = neither (sideways) · ⏳ PENDING = fewer than 4 candles after it so far
// The 2-year base rates of exactly this rule are measured in research/protrader/scenarioStudy.ts (scenario-stats.json →
// reversal). Education / reading aid only — not a trade signal.
import { classify, Bar } from "../learning/chartSchool";

export type RevStatus = "REAL" | "FAKE" | "WEAK" | "PENDING";
export interface Reversal { time: number; idx: number; dir: "UP" | "DOWN"; pattern: string; status: RevStatus; extreme: number; close: number;
  priorMove: number; after: number | null; level: { label: string; price: number } | null; text: string; lesson: string }

const IST = 19800;
const hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const f0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const WIN = 4, PRIOR = 3;

/** Is bar i a reversal candidate? dir = the NEW direction (UP = bullish reversal after a fall). */
export function candidate(B: Bar[], i: number, medR: number): { dir: "UP" | "DOWN"; pattern: string; priorMove: number } | null {
  if (i < PRIOR) return null;
  const b = B[i], p = B[i - 1], r = b.high - b.low || 1e-9, start = B[i - PRIOR].open;
  const fell = start - Math.min(...B.slice(i - PRIOR, i).map((x) => x.low)), rose = Math.max(...B.slice(i - PRIOR, i).map((x) => x.high)) - start;
  // the move's extreme — or a re-test of it within 0.1 × typical range (a double bottom / top counts)
  const near = 0.1 * medR, lowest = B.slice(i - PRIOR, i).every((x) => b.low <= x.low + near), highest = B.slice(i - PRIOR, i).every((x) => b.high >= x.high - near);
  const c = classify(b, p, medR);
  if (fell >= 1.2 * medR && lowest && b.close > b.open) {
    const strong = (b.close - b.low) / r >= 0.6;
    if (c.name === "Hammer" || c.name === "Bullish engulfing" || strong) return { dir: "UP", pattern: c.name === "Hammer" || c.name === "Bullish engulfing" ? c.name : "Strong green close", priorMove: Math.round(fell) };
  }
  if (rose >= 1.2 * medR && highest && b.close < b.open) {
    const strong = (b.high - b.close) / r >= 0.6;
    if (c.name === "Shooting star" || c.name === "Bearish engulfing" || strong) return { dir: "DOWN", pattern: c.name === "Shooting star" || c.name === "Bearish engulfing" ? c.name : "Strong red close", priorMove: Math.round(rose) };
  }
  return null;
}

/** Label a candidate from the candles after it (complete = all WIN candles are known). */
export function judge(B: Bar[], i: number, dir: "UP" | "DOWN", medR: number): { status: RevStatus; after: number | null } {
  const b = B[i], next = B.slice(i + 1, i + 1 + WIN), s = dir === "UP" ? 1 : -1, ext = dir === "UP" ? b.low : b.high;
  let best = 0;
  for (const x of next) {
    if (s * (x.close - ext) < 0) return { status: "FAKE", after: Math.round(s * (x.close - b.close)) };
    best = Math.max(best, s * ((dir === "UP" ? x.high : x.low) - b.close));
    if (best >= medR) return { status: "REAL", after: Math.round(best) };
  }
  return next.length < WIN ? { status: "PENDING", after: next.length ? Math.round(best) : null } : { status: "WEAK", after: Math.round(best) };
}

/** Every reversal candle of one session (bars of that day only; medR from that day + the day before). */
export function readReversals(B: Bar[], medR: number, levels: { label: string; price: number }[] = []): Reversal[] {
  const out: Reversal[] = []; let last = -10;
  const tol = (B[0]?.close || 0) * 0.0008;
  for (let i = PRIOR; i < B.length; i++) {
    const c = candidate(B, i, medR); if (!c || i - last < 3) continue;
    last = i;
    const b = B[i], j = judge(B, i, c.dir, medR), ext = c.dir === "UP" ? b.low : b.high;
    const lv = levels.filter((l) => Math.abs(l.price - ext) <= Math.max(tol, 0.35 * medR)).sort((a, z) => Math.abs(a.price - ext) - Math.abs(z.price - ext))[0] || null;
    const up = c.dir === "UP", where = lv ? ` — ${lv.label} ${f0(lv.price)} पर` : "";
    const text = `${hm(b.time)}: ${c.priorMove} points ${up ? "गिरावट" : "तेज़ी"} के बाद ${c.pattern}${where}; ${up ? "low" : "high"} ${f0(ext)}, close ${f0(b.close)}। ` + (
      j.status === "REAL" ? `अगले घंटे में ${j.after} points ${up ? "ऊपर" : "नीचे"} — असली पलटाव।`
      : j.status === "FAKE" ? `अगले घंटे में ही candle ${f0(ext)} के ${up ? "नीचे" : "ऊपर"} बंद — पलटाव झूठा, पुरानी चाल लौटी।`
      : j.status === "WEAK" ? `अगले घंटे में न टूटा, न ${f0(medR)} points चला — sideways।`
      : `पुष्टि बाकी: अगली ${WIN} candles (1 घंटा) देखें — ${f0(ext)} के ${up ? "नीचे" : "ऊपर"} 15-min close = झूठा।`);
    const lesson = j.status === "FAKE" ? `सिर्फ़ एक candle पर पलटाव मत मानिए — अगली candle ${up ? "उसका high" : "उसका low"} पार करे तब। SL हमेशा ${up ? "low के नीचे" : "high के ऊपर"}।`
      : j.status === "REAL" ? `${lv ? "Level पर" : "चाल के आख़िर में"} ${up ? "नीचे की पूँछ / हरी पकड़" : "ऊपर की पूँछ / लाल पकड़"} + अगली candle की पुष्टि = पलटाव। Entry पुष्टि के बाद, SL ${f0(ext)}।`
      : `पलटाव की candle बनी पर ज़ोर नहीं आया — ऐसे में trade नहीं, range की तरह देखें।`;
    out.push({ time: b.time, idx: i, dir: c.dir, pattern: c.pattern, status: j.status, extreme: ext, close: b.close, priorMove: c.priorMove, after: j.after, level: lv, text, lesson });
  }
  return out;
}

/** Group 15-min bars by IST day and read each day; medR = median range of that day + the previous one. */
export function reversalsByDay(bars: Bar[], days: string[], levels: { label: string; price: number }[] = []): Reversal[] {
  const day = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10), by = new Map<string, Bar[]>();
  for (const b of bars) { const d = day(b.time); if (!by.has(d)) by.set(d, []); by.get(d)!.push(b); }
  const all = [...by.keys()].sort(), out: Reversal[] = [];
  for (const d of days) {
    const B = by.get(d); if (!B || B.length < PRIOR + 1) continue;
    const prev = by.get(all[all.indexOf(d) - 1] ?? "") || [], medR = med([...prev, ...B].map((x) => x.high - x.low)) || 1;
    out.push(...readReversals(B, medR, levels));
  }
  return out;
}
