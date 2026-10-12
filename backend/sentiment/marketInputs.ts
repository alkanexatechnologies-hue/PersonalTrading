import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

// ============================ Market Input Selection (Market Sentiment) ============================
// Fourteen market inputs, each evaluated from timestamped data the app already has. Every input
// carries its value, status (ACTIVE / STALE / MISSING / UNAVAILABLE), impact and the reason.
// AUTO: captured once at 09:25 IST on a trading session and stored IMMUTABLY; later evaluations
// are recorded as revisions (what changed, and why) — the 09:25 record is never rewritten.
// MANUAL: a what-if scenario applies the user's overrides to a COPY; results are marked SIMULATED
// and are never saved over the automatic record.
// This is evidence for the trader, not a trade signal: the arbiter remains the only decision.

export type Impact = "Positive" | "Negative" | "Mixed" | "Neutral" | "Caution";
export type InputStatus = "ACTIVE" | "STALE" | "MISSING" | "UNAVAILABLE";
export interface MarketInput { id: number; key: string; label: string; value: string; status: InputStatus; impact: Impact; reason: string; ts: number | null; source: string; simulated?: boolean }
export interface Bar { time: number; open: number; high: number; low: number; close: number }

export interface InputData {
  nowSec: number;
  crude: { value: number; ts: number | null; contract: string } | null;   // Dhan MCX CRUDEOIL front month, ₹/bbl
  itMoves: { s: string; pct: number | null; coef: number }[] | null;      // top-5 IT by contribution coefficient
  bankMoves: { s: string; pct: number | null; coef: number }[] | null;    // top-5 banks
  movesTs: number | null;
  oi: { asOf: number | null; spot: number; strikes: { strike: number; ceOi: number; peOi: number; ceChg: number; peChg: number; ceLtp?: number | null; peLtp?: number | null; cePrevClose?: number | null; pePrevClose?: number | null; ceDelta?: number | null; peDelta?: number | null }[] } | null;
  spotPrevClose: number | null;
  c5: Bar[]; c15: Bar[]; c60: Bar[];
  fii: { asOf: string | null; netChange: number | null; longPct: number | null; diiNet: number | null } | null;
  gift: { nightPct: number; ts: number | null } | null;   // Dhan GIFT NIFTY overnight move (global cue)
  news: { positive: number; negative: number; ts: number | null } | null;
}

// Crude rule in rupees on Dhan MCX CRUDEOIL (tracks WTI). ₹9,600 ≈ $101 at USD/INR ~95; Dhan has
// no live USD/INR, so the rule is set in ₹ and shown on screen (change here to move it).
export const CRUDE_THRESHOLD_INR = 9600;
const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istHm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const ema = (v: number[], n: number) => { const k = 2 / (n + 1); let e = v[0]; return v.map((x, i) => (i === 0 ? e : (e = x * k + e * (1 - k)))); };
const fmt = (v: number, d = 2) => v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const sgn = (v: number, d = 2) => (v > 0 ? "+" : "") + fmt(v, d);
const age = (ts: number | null, now: number, max: number): InputStatus => (ts == null ? "MISSING" : now - ts <= max ? "ACTIVE" : "STALE");

/** EMA9/EMA21 structure on closed bars: BULLISH (close > EMA21 and EMA9 > EMA21), BEARISH (both below), else RANGE. */
export function tfDirection(bars: Bar[], nowSec: number, barSec: number): "BULLISH" | "BEARISH" | "RANGE" | null {
  const closed = bars.filter((b) => b.time + barSec <= nowSec);
  if (closed.length < 22) return null;
  const c = closed.map((b) => b.close), e9 = ema(c, 9), e21 = ema(c, 21), i = c.length - 1;
  if (c[i] > e21[i] && e9[i] > e21[i]) return "BULLISH";
  if (c[i] < e21[i] && e9[i] < e21[i]) return "BEARISH";
  return "RANGE";
}

function breadth(rows: { s: string; pct: number | null; coef: number }[] | null) {
  const v = (rows || []).filter((r) => r.pct != null) as { s: string; pct: number; coef: number }[];
  if (!v.length) return null;
  const up = v.filter((r) => r.pct > 0.05).length, dn = v.filter((r) => r.pct < -0.05).length;
  const wsum = v.reduce((a, r) => a + r.coef, 0) || 1;
  const wpct = v.reduce((a, r) => a + r.coef * r.pct, 0) / wsum;
  return { up, dn, n: v.length, wpct };
}

/** Evaluate the 14 inputs. Pure: no I/O. */
export function evaluateInputs(d: InputData): MarketInput[] {
  const out: MarketInput[] = [];
  const now = d.nowSec, today = istDay(now);
  const add = (i: Omit<MarketInput, "id">) => out.push({ id: out.length + 1, ...i });
  const missing = (key: string, label: string, source: string, why: string) => add({ key, label, value: "—", status: "UNAVAILABLE", impact: "Neutral", reason: why, ts: null, source });

  // 1 crude
  const cl = `Crude oil (MCX) vs ₹${CRUDE_THRESHOLD_INR.toLocaleString("en-IN")}`;
  if (d.crude) add({ key: "crude", label: cl, value: `₹${fmt(d.crude.value, 0)} (${d.crude.value < CRUDE_THRESHOLD_INR ? "<" : "≥"} ${CRUDE_THRESHOLD_INR.toLocaleString("en-IN")})`, status: age(d.crude.ts, now, 6 * 3600), impact: d.crude.value < CRUDE_THRESHOLD_INR ? "Positive" : "Negative", reason: `${d.crude.contract}: ${d.crude.value < CRUDE_THRESHOLD_INR ? "below" : "at/above"} the ₹${CRUDE_THRESHOLD_INR.toLocaleString("en-IN")} rule (≈ $101) — ${d.crude.value < CRUDE_THRESHOLD_INR ? "eases" : "raises"} India's import bill and inflation`, ts: d.crude.ts, source: "Dhan MCX" });
  else missing("crude", cl, "Dhan MCX", "MCX crude quote unavailable");
  // 2–3 heavyweights
  for (const [key, label, rows] of [["it", "Top 5 IT stocks (weighted)", d.itMoves], ["bank", "Top 5 bank stocks (weighted)", d.bankMoves]] as const) {
    const b = breadth(rows as any);
    if (!b) { missing(key, label, "Dhan quotes", "Stock prices unavailable"); continue; }
    const imp: Impact = b.up >= 4 || (b.up > b.dn && b.wpct > 0.15) ? "Positive" : b.dn >= 4 || (b.dn > b.up && b.wpct < -0.15) ? "Negative" : "Mixed";
    add({ key, label, value: `${b.up} up / ${b.dn} down · ${sgn(b.wpct)}% weighted`, status: age(d.movesTs, now, 300), impact: imp, reason: `${b.n} heavyweights, weighted by the estimated contribution model`, ts: d.movesTs, source: "Dhan quotes" });
  }
  // 4–5 OI buildup near spot (within 1 %)
  if (d.oi && d.oi.strikes.length) {
    const s = d.oi.spot, band = s * 0.01;
    const below = d.oi.strikes.filter((x) => x.strike < s && s - x.strike <= band), above = d.oi.strikes.filter((x) => x.strike > s && x.strike - s <= band);
    const pe = below.sort((a, b) => b.peChg - a.peChg)[0], ce = above.sort((a, b) => b.ceChg - a.ceChg)[0];
    const st = age(d.oi.asOf, now, 300);
    const L = (n: number) => `${(n / 1e5).toFixed(0)}L`;
    add(pe && pe.peChg > 0 ? { key: "support", label: "Major support build-up (put OI)", value: `${pe.strike} (+${L(pe.peChg)})`, status: st, impact: "Positive", reason: `Largest fresh put writing within 1 % below spot`, ts: d.oi.asOf, source: "Dhan option chain" }
      : { key: "support", label: "Major support build-up (put OI)", value: "none", status: st, impact: "Neutral", reason: "No fresh put writing within 1 % below spot", ts: d.oi.asOf, source: "Dhan option chain" });
    add(ce && ce.ceChg > 0 ? { key: "resistance", label: "Major resistance build-up (call OI)", value: `${ce.strike} (+${L(ce.ceChg)})`, status: st, impact: "Negative", reason: `Largest fresh call writing within 1 % above spot`, ts: d.oi.asOf, source: "Dhan option chain" }
      : { key: "resistance", label: "Major resistance build-up (call OI)", value: "none", status: st, impact: "Neutral", reason: "No fresh call writing within 1 % above spot", ts: d.oi.asOf, source: "Dhan option chain" });
  } else { missing("support", "Major support build-up (put OI)", "Dhan option chain", "Option chain unavailable"); missing("resistance", "Major resistance build-up (call OI)", "Dhan option chain", "Option chain unavailable"); }
  // 6 first two 5-min candles
  const todays = d.c5.filter((b) => istDay(b.time) === today && b.time + 300 <= now);
  const f1 = todays.find((b) => istHm(b.time) === "09:15"), f2 = todays.find((b) => istHm(b.time) === "09:20");
  if (f1 && f2) {
    const col = (b: Bar) => (b.close >= b.open ? "Bullish" : "Bearish");
    const same = col(f1) === col(f2);
    add({ key: "first2", label: "First two 5-min candles", value: `${col(f1)} → ${col(f2)}`, status: "ACTIVE", impact: same ? (col(f1) === "Bullish" ? "Positive" : "Negative") : "Mixed", reason: same ? "Both opening candles agree" : "Opening candles disagree — direction not settled", ts: f2.time + 300, source: "Dhan 5-min candles" });
  } else missing("first2", "First two 5-min candles", "Dhan 5-min candles", now < Math.floor(Date.parse(today + "T03:55:00Z") / 1000) ? "Available after 09:25" : "09:15/09:20 candles missing");
  // 7–8 ATM option premiums
  const atm = d.oi && d.oi.strikes.length ? d.oi.strikes.reduce((b, x) => (Math.abs(x.strike - d.oi!.spot) < Math.abs(b.strike - d.oi!.spot) ? x : b)) : null;
  if (atm && atm.ceLtp && atm.peLtp && atm.cePrevClose && atm.pePrevClose && d.spotPrevClose) {
    const ds = d.oi!.spot - d.spotPrevClose;
    const ceChg = atm.ceLtp - atm.cePrevClose, peChg = atm.peLtp - atm.pePrevClose;
    const ceExp = (atm.ceDelta ?? 0.5) * ds, peExp = (atm.peDelta ?? -0.5) * ds;            // delta-explained change
    const ceExc = (ceChg - ceExp) / atm.cePrevClose, peExc = (peChg - peExp) / atm.pePrevClose;
    const spike = ceExc > 0.15 && peExc > 0.15 ? "Both sides (IV)" : ceExc > 0.15 ? "CE spike (IV)" : peExc > 0.15 ? "PE spike (IV)" : "No spike";
    add({ key: "spike", label: "Option premium spike", value: spike, status: age(d.oi!.asOf, now, 300), impact: spike === "No spike" ? "Neutral" : "Caution", reason: `ATM ${atm.strike}: CE ${sgn((ceChg / atm.cePrevClose) * 100, 1)}%, PE ${sgn((peChg / atm.pePrevClose) * 100, 1)}% vs previous close; spike = rise beyond what delta × spot move explains by > 15 %`, ts: d.oi!.asOf, source: "Dhan option chain" });
    const rel = (atm.ceLtp - atm.peLtp) / ((atm.ceLtp + atm.peLtp) / 2);
    add({ key: "atm", label: "ATM CE vs PE premium", value: `CE ₹${fmt(atm.ceLtp)} vs PE ₹${fmt(atm.peLtp)}`, status: age(d.oi!.asOf, now, 300), impact: rel > 0.1 ? "Positive" : rel < -0.1 ? "Negative" : "Neutral", reason: `${atm.strike}: CE ${rel >= 0 ? "richer" : "cheaper"} than PE by ${fmt(Math.abs(rel) * 100, 0)} % (±10 % = neutral)`, ts: d.oi!.asOf, source: "Dhan option chain" });
  } else { missing("spike", "Option premium spike", "Dhan option chain", "ATM prices or previous closes unavailable"); missing("atm", "ATM CE vs PE premium", "Dhan option chain", "ATM prices unavailable"); }
  // 9–10 trend
  const t5 = tfDirection(d.c5, now, 300), t15 = tfDirection(d.c15, now, 900), t60 = tfDirection(d.c60, now, 3600);
  const tfs = [t5, t15, t60];
  if (tfs.some((x) => x)) {
    const bull = tfs.filter((x) => x === "BULLISH").length, bear = tfs.filter((x) => x === "BEARISH").length;
    add({ key: "trend", label: "Overall trend", value: bull >= 2 ? "Up" : bear >= 2 ? "Down" : "Range", status: "ACTIVE", impact: bull >= 2 ? "Positive" : bear >= 2 ? "Negative" : "Mixed", reason: "Majority of 5-min / 15-min / 1-hour EMA9–EMA21 structure", ts: now, source: "Dhan candles" });
    const w = (x: string | null) => (x === "BULLISH" ? "Up" : x === "BEARISH" ? "Down" : x === "RANGE" ? "Range" : "—");
    add({ key: "mtf", label: "Trend 5m / 15m / 1h", value: `${w(t5)} / ${w(t15)} / ${w(t60)}`, status: tfs.every((x) => x) ? "ACTIVE" : "STALE", impact: bull === 3 ? "Positive" : bear === 3 ? "Negative" : "Mixed", reason: "EMA9 vs EMA21 and close vs EMA21 on closed bars of each timeframe", ts: now, source: "Dhan candles" });
  } else { missing("trend", "Overall trend", "Dhan candles", "Not enough closed candles"); missing("mtf", "Trend 5m / 15m / 1h", "Dhan candles", "Not enough closed candles"); }
  // 11 last 5-min candle
  const closed5 = d.c5.filter((b) => b.time + 300 <= now);
  const lb = closed5[closed5.length - 1];
  if (lb && closed5.length > 15) {
    const range = lb.high - lb.low || 1e-9, body = Math.abs(lb.close - lb.open) / range;
    const tr = closed5.slice(-15, -1).map((b) => b.high - b.low), avg = tr.reduce((a, b) => a + b, 0) / tr.length;
    const strong = body >= 0.6, wide = range >= 1.2 * avg, bull = lb.close >= lb.open;
    add({ key: "last5", label: "Last 5-min candle", value: `${strong ? "Strong" : "Weak"} ${bull ? "bullish" : "bearish"}${wide ? " · wide range" : ""}`, status: age(lb.time + 300, now, 600), impact: strong ? (bull ? "Positive" : "Negative") : "Neutral", reason: `${istHm(lb.time)} bar: body ${fmt(body * 100, 0)} % of range, range ${fmt(range / avg, 1)}× the 14-bar average`, ts: lb.time + 300, source: "Dhan 5-min candles" });
  } else missing("last5", "Last 5-min candle", "Dhan 5-min candles", "No closed candle yet");
  // 12 FII / DII
  if (d.fii && d.fii.netChange != null) {
    const imp: Impact = d.fii.netChange > 5000 ? "Positive" : d.fii.netChange < -5000 ? "Negative" : "Mixed";
    add({ key: "fii", label: "FII / DII positioning", value: `FII net ${sgn(d.fii.netChange, 0)}${d.fii.longPct != null ? ` (${fmt(d.fii.longPct, 1)} % long)` : ""}${d.fii.diiNet != null ? ` · DII ${sgn(d.fii.diiNet, 0)}` : ""}`, status: "ACTIVE", impact: imp, reason: `Index-futures positions, end of day ${d.fii.asOf} (NSE participant OI)`, ts: null, source: "NSE participant OI" });
  } else missing("fii", "FII / DII positioning", "NSE participant OI", "Participant file unavailable");
  // 13 global cue: GIFT NIFTY's overnight move (it trades through US hours)
  if (d.gift) {
    const g = d.gift.nightPct;
    add({ key: "global", label: "Global markets (GIFT NIFTY overnight)", value: `${sgn(g)}%`, status: age(d.gift.ts, now, 8 * 3600), impact: g > 0.2 ? "Positive" : g < -0.2 ? "Negative" : "Mixed", reason: "GIFT NIFTY from yesterday 15:25 to the end of its night session — reflects US/global hours", ts: d.gift.ts, source: "Dhan GIFT NIFTY" });
  } else missing("global", "Global markets (GIFT NIFTY overnight)", "Dhan GIFT NIFTY", "GIFT NIFTY bars unavailable");
  // 14 news
  if (d.news) {
    const { positive: p, negative: n } = d.news;
    add({ key: "news", label: "Major news (last 3 h)", value: `${p} positive / ${n} negative`, status: age(d.news.ts, now, 900), impact: p > n ? "Positive" : n > p ? "Negative" : p + n ? "Mixed" : "Neutral", reason: "Fresh headlines with a rule-based market direction (news intelligence)", ts: d.news.ts, source: "News intelligence" });
  } else missing("news", "Major news (last 3 h)", "News intelligence", "News unavailable");
  return out;
}

/** Simple count of ACTIVE inputs by impact. A tally, NOT a probability. */
export function tally(inputs: MarketInput[]) {
  const act = inputs.filter((i) => i.status === "ACTIVE" || i.simulated);
  const pos = act.filter((i) => i.impact === "Positive").length, neg = act.filter((i) => i.impact === "Negative").length;
  return { positive: pos, negative: neg, mixed: act.filter((i) => i.impact === "Mixed").length, caution: act.filter((i) => i.impact === "Caution").length, counted: act.length, of: inputs.length,
    lean: pos - neg >= 3 ? "BULLISH" : neg - pos >= 3 ? "BEARISH" : "MIXED", note: "Count of active inputs by impact — evidence, not a probability or a trade signal" };
}

/** What-if: overrides { key: Impact } on a COPY, every overridden input marked SIMULATED. */
export function simulate(inputs: MarketInput[], overrides: Record<string, Impact>) {
  const sim = inputs.map((i) => (overrides[i.key] && overrides[i.key] !== i.impact ? { ...i, impact: overrides[i.key], simulated: true, status: i.status, reason: `SIMULATED by user (actual: ${i.impact})` } : { ...i }));
  return { simulated: true, inputs: sim, tally: tally(sim), changed: sim.filter((i) => i.simulated).map((i) => i.key) };
}

// ---- 09:25 snapshot (immutable) + revisions ----
const DIR = path.join(DATA_DIR, "sentiment", "inputs");
export interface DayRecord { date: string; snapshot: { at: number; inputs: MarketInput[]; tally: ReturnType<typeof tally> } | null; revisions: { at: number; trigger: string; changes: { key: string; from: string; to: string }[]; tally: ReturnType<typeof tally> }[] }
const file = (d: string) => path.join(DIR, `${d}.json`);
export function readDay(d: string): DayRecord { try { return JSON.parse(fs.readFileSync(file(d), "utf-8")); } catch { return { date: d, snapshot: null, revisions: [] }; } }
function writeDay(r: DayRecord) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file(r.date), JSON.stringify(r)); } catch { /* best-effort */ } }
/** Stores the 09:25 snapshot once; returns false if one already exists (never overwritten). */
export function saveSnapshot(date: string, at: number, inputs: MarketInput[]): boolean {
  const r = readDay(date); if (r.snapshot) return false;
  r.snapshot = { at, inputs, tally: tally(inputs) }; writeDay(r); return true;
}
/** Records a revision when any input's impact or status changed versus the latest known state. */
export function recordRevision(date: string, at: number, inputs: MarketInput[], trigger: string): boolean {
  const r = readDay(date); if (!r.snapshot) return false;
  const last = r.revisions.length ? (r.revisions[r.revisions.length - 1] as any).inputs || r.snapshot.inputs : r.snapshot.inputs;
  const changes = inputs.map((i) => { const p = last.find((x: MarketInput) => x.key === i.key); return p && (p.impact !== i.impact || p.status !== i.status) ? { key: i.key, from: `${p.impact}/${p.status}`, to: `${i.impact}/${i.status}` } : null; }).filter(Boolean) as { key: string; from: string; to: string }[];
  if (!changes.length && trigger === "5-min re-evaluation") return false;
  r.revisions.push({ at, trigger, changes, tally: tally(inputs), inputs } as any); writeDay(r); return true;
}
