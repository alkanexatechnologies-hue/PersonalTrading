// ============================ Setup Signals — the trader's option-buying logic ============================
// The trader's written logic (morning / extreme rejection at support-resistance,
// VWAP-distance continuation) turned into objective, machine-readable rules,
// refined per the design review (ATR-scaled, confirmation candle, higher-timeframe
// permission, room-to-level, duplicate control). ADVISORY: shown on the MC Summary
// screen and logged; it does NOT change the arbiter's FINAL DECISION or the paper
// engine. Pure functions over CLOSED 5m candles — no look-ahead: a signal on bar i
// uses only bars ≤ i; future bars are used only to grade the outcome.
//
// S3 LEVEL REJECTION (covers "Setup 1 — morning 09:20–09:45" and "Setup 2 — extreme"):
//   level (from the Liquidity Analysis level engine) → price tests the zone → objective
//   rejection candle → next-candle confirmation → filters → BUY PE at resistance /
//   BUY CE at support. Context tag: MORNING (confirmed before 09:45), EXTREME (the
//   move into the level ≥ 0.6 × daily ATR) or INTRADAY (requires a MAJOR level).
// S4 VWAP TREND PULLBACK (covers "Setup 3 — VWAP distance after 09:45"):
//   price held one side of VWAP, stretched ≥ k × ATR from it, 15M trend agrees, room to
//   the next major level ≥ m × ATR → buy the first pullback that holds (EMA 9), not the
//   extreme bar. k and m are ATR multiples (≈ 30 / 40 pts on NIFTY at a ~15-pt 5m ATR).

import type { Candle } from "../types";
import { ema, vwap, atr } from "../indicators";
import { aggregate, type LiqLevel } from "../liquidity/liquidityTake";

export const SETUP_CONFIG = {
  firstEntryMin: 9 * 60 + 20, morningEndMin: 9 * 60 + 45, vwapStartMin: 9 * 60 + 45, lastEntryMin: 14 * 60, dayEndMin: 15 * 60 + 15,
  // rejection (all ATR = 14-bar ATR of 5m candles)
  zoneAtr: 0.1, minWickAtr: 0.3, minWickFrac: 0.4, closeFrac: 0.4, minRangeAtr: 0.6, maxPenetrationAtr: 0.5,
  confirmBars: 2, stopBufferAtr: 0.1, minRoomR: 1.5, absorptionTests: 3, absorptionLookback: 12,
  extremeDailyAtrFrac: 0.6, rearmAtr: 1.0, maxRearm: 1, slCooldownMin: 30, failedBreakBars: 3,
  // VWAP trend pullback
  // VWAP bias (trader's rule): a 5m candle CLOSING above VWAP = bullish, closing below = bearish.
  vwapK: 2.0, roomM: 2.7, vwapHoldBars: 1, pullbackAtr: 0.2, extendedDailyAtr: 1.2, maxS4PerSide: 2,
  // execution / grading
  entrySlipAtr: 0.5, timeExitBars: 12,
  // NIFTY reference points from the trader's original rule (logged for comparison only)
  refVwapPts: 30, refRoomPts: 40,
};
const C = SETUP_CONFIG;
const IST = 19800;
const istMin = (t: number) => { const d = new Date((t + IST) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const hm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const r2 = (n: number) => Math.round(n * 100) / 100;

export type SetupId = "S3_LEVEL_REJECTION" | "S4_VWAP_PULLBACK";
export type SignalStatus = "ENTRY_READY" | "ACTIVE" | "TARGET" | "STOP" | "TIME_EXIT" | "EOD_EXIT" | "EXTENDED" | "BLOCKED";
export type WatchState = "APPROACHING" | "LEVEL_TEST" | "CONFIRMATION_PENDING" | "ACCEPTED";

export interface SetupSignal {
  id: string; setup: SetupId; label: string; context: string; side: "CE" | "PE"; date: string;
  barTime: number; time: string;                        // the candle that completed the setup (closed)
  level: { type: string; price: number; sources: string[]; major: boolean } | null;
  evidence: string[]; blockedBy: string | null;
  plan: { entryRef: number; entry: number | null; stop: number; target: number; risk: number; reward: number; rr: number; targetWhy: string } | null;
  status: SignalStatus; fillTime: number | null; exitTime: number | null; exitPrice: number | null; resultR: number | null;
  metrics: Record<string, number | string | null>;
}
export interface WatchItem { level: string; price: number; side: "RESISTANCE" | "SUPPORT"; state: WatchState; since: string; note: string; }
export interface SessionResult { date: string; signals: SetupSignal[]; watch: WatchItem[]; atr: number | null; vwap: number | null; dir15: string | null;
  vwapBias: { bias: "BULLISH" | "BEARISH" | "NEUTRAL"; close: number; vwap: number | null; time: string } | null; }

const MAJOR_TYPES = new Set(["Previous Day High", "Previous Day Low", "OI Support", "OI Resistance", "Structure Support", "Structure Resistance", "Equal High", "Equal Low"]);
export const isMajor = (l: LiqLevel) => MAJOR_TYPES.has(l.type) || l.sources.length >= 2;

/**
 * Evaluate one session. `hist` = all closed 5m candles BEFORE today (warm-up for ATR /
 * EMA / 15M trend); `today` = today's closed 5m candles up to `nowSec` (< 15:15);
 * `levels` = levels known for today (each used only from its activeFrom);
 * `dailyAtr` = ATR of daily ranges as of yesterday.
 */
export function evaluateSession(hist: Candle[], today: Candle[], levels: LiqLevel[], dailyAtr: number | null, nowSec: number, opts: { regimeAt?: (upto: Candle[]) => string | null } = {}): SessionResult {
  const day = today.length ? istDay(today[0].time) : "";
  const all = [...hist, ...today];
  const off = hist.length;
  const A = atr(all, 14), E9 = ema(all.map((c) => c.close), 9), VW = vwap(all);
  const out: SessionResult = { date: day, signals: [], watch: [], atr: null, vwap: null, dir15: null, vwapBias: null };
  if (today.length < 2) return out;
  // 15M trend from closed 15m candles (prior sessions + today)
  const sessDays = [...new Set(hist.map((c) => istDay(c.time)))].slice(-3);
  const h15 = sessDays.flatMap((d) => aggregate(hist.filter((c) => istDay(c.time) === d), 3));
  const t15 = aggregate(today, 3);
  const dir15At = (tEnd: number): string | null => {
    const xs = [...h15, ...t15.filter((x) => x.time + 900 <= tEnd)].map((x) => x.close);
    const f = ema(xs, 9), s = ema(xs, 21); const a = f[f.length - 1], b = s[s.length - 1];
    return a == null || b == null ? null : a > b ? "UP" : a < b ? "DOWN" : "FLAT";
  };
  const sessOpen = today[0].open;
  // home = which side price was on when the level came into play ("ABOVE" → the level is support).
  // It only flips after ACCEPTANCE (2 closes beyond); a 1-candle break that closes back is a failed break.
  const lvState = new Map<string, { home: "ABOVE" | "BELOW"; tests: { t: number; hi: number; lo: number }[]; closesBeyond: number; lastBeyondK: number; acceptedAt: number | null; pending: { i: number; kind: string } | null; fired: number; spentFarAt: number | null; lastFire: number | null }>();
  const signals: SetupSignal[] = [];
  let openSig: SetupSignal | null = null;
  const lastStopAt: Record<string, number> = {};
  const s4Count = { CE: 0, PE: 0 }; let s4LastBar = -99, s4ExtHi = -Infinity, s4ExtLo = Infinity;

  const roomTo = (side: "CE" | "PE", from: number, act: number, minDist: number) => {
    // next MAJOR level in the trade direction, at least minDist away
    const cands = levels.filter((l) => l.activeFrom <= act && isMajor(l) && (side === "CE" ? l.price > from + minDist : l.price < from - minDist));
    cands.sort((a, b) => (side === "CE" ? a.price - b.price : b.price - a.price));
    return cands[0] || null;
  };
  const planFor = (side: "CE" | "PE", entryRef: number, stop: number, act: number, a: number, minRoomR: number) => {
    const risk = Math.abs(entryRef - stop);
    const next = roomTo(side, entryRef, act, 0.25 * a);
    if (next) {
      const reward = Math.abs(next.price - entryRef);
      if (reward < minRoomR * risk) return { plan: null, block: `NO ROOM — next ${next.type} ${r2(next.price)} is ${r2(reward)} pts away (< ${minRoomR}× risk ${r2(risk)})` };
      return { plan: { entryRef: r2(entryRef), entry: null, stop: r2(stop), target: r2(next.price), risk: r2(risk), reward: r2(reward), rr: r2(reward / risk), targetWhy: `next major level: ${next.type}` }, block: null };
    }
    const tgt = side === "CE" ? entryRef + 2 * risk : entryRef - 2 * risk;
    return { plan: { entryRef: r2(entryRef), entry: null, stop: r2(stop), target: r2(tgt), risk: r2(risk), reward: r2(2 * risk), rr: 2, targetWhy: "no major level in the way — 2R" }, block: null };
  };
  const push = (s: SetupSignal) => { signals.push(s); if (!s.blockedBy) openSig = s; };

  for (let k = 0; k < today.length; k++) {
    const i = off + k, c = today[k], a = A[i] ?? (c.high - c.low), m = istMin(c.time), tEnd = c.time + 300;
    // ---- manage an open (not yet resolved) signal first: one trade at a time ----
    if (openSig) {
      const s = openSig as SetupSignal;
      if (s.status === "ENTRY_READY") {
        // fill at this bar's open unless price already ran away (no chase)
        const p = s.plan!;
        const slip = s.side === "CE" ? c.open - p.entryRef : p.entryRef - c.open;
        if (slip > C.entrySlipAtr * a) { s.status = "EXTENDED"; s.metrics.slipPts = r2(slip); openSig = null; }
        else { s.status = "ACTIVE"; p.entry = c.open; s.fillTime = c.time; p.risk = r2(Math.abs(p.entry - p.stop)); }
      }
      if (openSig && (openSig as SetupSignal).status === "ACTIVE") {
        const p = s.plan!, held = Math.round((c.time - (s.fillTime as number)) / 300);
        const hitS = s.side === "CE" ? c.low <= p.stop : c.high >= p.stop;
        const hitT = s.side === "CE" ? c.high >= p.target : c.low <= p.target;
        const close = (st: SignalStatus, px: number) => { s.status = st; s.exitTime = tEnd; s.exitPrice = r2(px); s.resultR = r2(((s.side === "CE" ? px - p.entry! : p.entry! - px)) / Math.max(0.01, p.risk)); openSig = null; if (st === "STOP") lastStopAt[s.setup] = tEnd; };
        if (hitS) close("STOP", p.stop);
        else if (hitT) close("TARGET", p.target);
        else if (held >= C.timeExitBars) close("TIME_EXIT", c.close);
        else if (m + 5 >= C.dayEndMin) close("EOD_EXIT", c.close);
      }
    }
    const inWindow = m >= C.firstEntryMin - 5 && m + 5 <= C.lastEntryMin;   // signal candle may close 09:20..14:00
    const cooled = (setup: string) => !lastStopAt[setup] || tEnd - lastStopAt[setup] >= C.slCooldownMin * 60;
    const prevClose = k > 0 ? today[k - 1].close : (hist.length ? hist[hist.length - 1].close : c.open);
    const z = Math.max(0.5, C.zoneAtr * a);

    // ---------------- S3: level rejection ----------------
    for (const L of levels) {
      if (L.activeFrom > c.time) continue;
      const key = `${L.type}|${L.price}`;
      let st = lvState.get(key);
      if (!st) { st = { home: prevClose >= L.price ? "ABOVE" : "BELOW", tests: [], closesBeyond: 0, lastBeyondK: -99, acceptedAt: null, pending: null, fired: 0, spentFarAt: null, lastFire: null }; lvState.set(key, st); }
      const res = st.home === "BELOW";                    // price came from below → resistance (PE); from above → support (CE)
      const side: "CE" | "PE" = res ? "PE" : "CE";
      const lvl = L.price;
      const touched = res ? c.high >= lvl - z : c.low <= lvl + z;
      if (touched) st.tests.push({ t: c.time, hi: c.high, lo: c.low });
      // acceptance: 2 closes beyond the level → it flipped; no fade
      const beyond = res ? c.close > lvl + z : c.close < lvl - z;
      st.closesBeyond = beyond ? st.closesBeyond + 1 : 0;
      if (beyond) st.lastBeyondK = k;
      if (st.closesBeyond >= 2 && st.acceptedAt == null) { st.acceptedAt = tEnd; st.pending = null; st.home = st.home === "ABOVE" ? "BELOW" : "ABOVE"; }
      // re-arm after a fired signal once price moved ≥ 1 ATR away
      if (st.lastFire != null && Math.abs(c.close - lvl) >= C.rearmAtr * a) st.spentFarAt = tEnd;
      // 1) confirmation of a pending rejection
      if (st.pending) {
        const r = today[st.pending.i - off];
        const mid = (r.high + r.low) / 2;
        const conf = res ? c.close < mid && c.high <= r.high : c.close > mid && c.low >= r.low;
        const fail = res ? c.close > r.high : c.close < r.low;
        if (fail) st.pending = null;
        else if (conf) {
          const kind = st.pending.kind; st.pending = null;
          if (!inWindow) continue;
          const evidence: string[] = [];
          const sessExt = Math.max(...today.slice(0, k + 1).map((x) => x.high)) - Math.min(...today.slice(0, k + 1).map((x) => x.low));
          const moveIn = res ? r.high - Math.min(...today.slice(0, k + 1).map((x) => x.low)) : Math.max(...today.slice(0, k + 1).map((x) => x.high)) - r.low;
          const extreme = dailyAtr != null && moveIn >= C.extremeDailyAtrFrac * dailyAtr;
          const context = m + 5 <= C.morningEndMin ? "MORNING" : extreme ? "EXTREME" : "INTRADAY";
          const major = isMajor(L);
          const d15 = dir15At(tEnd);
          const reg = opts.regimeAt ? opts.regimeAt(all.slice(0, i + 1)) : null;
          let block: string | null = null;
          if (context === "INTRADAY" && !major) block = "Minor level outside the morning window (needs a major level or an extreme move)";
          // higher-timeframe permission: do not fade the 15M trend unless the move is extreme or the market is ranging
          if (!block && ((res && d15 === "UP") || (!res && d15 === "DOWN")) && context !== "EXTREME" && reg !== "RANGE")
            block = `15M trend ${d15} — this is more likely a pullback than a reversal`;
          // absorption: ≥3 tests with rising lows (resistance) / falling highs (support) → break more likely
          const recent = st.tests.filter((x) => x.t >= c.time - C.absorptionLookback * 300);
          if (!block && recent.length >= C.absorptionTests) {
            const rising = res ? recent.every((x, j) => j === 0 || x.lo >= recent[j - 1].lo) : recent.every((x, j) => j === 0 || x.hi <= recent[j - 1].hi);
            if (rising) block = `Absorption — ${recent.length} tests with ${res ? "rising lows" : "falling highs"} (breakout risk)`;
          }
          if (!block && st.fired > 0 && (st.fired > C.maxRearm || st.spentFarAt == null || (st.lastFire != null && st.spentFarAt <= st.lastFire))) block = "Level already traded (not re-armed)";
          if (!block && !cooled("S3_LEVEL_REJECTION")) block = `Cooldown ${C.slCooldownMin} min after a stop`;
          if (!block && openSig) block = "Another setup signal is still open";
          // Stop beyond the rejection extreme (rejection candle → confirmation candle) + a small ATR buffer.
          const seg = today.slice(today.indexOf(r), k + 1);
          const stopRaw = res ? Math.max(...seg.map((x) => x.high)) : Math.min(...seg.map((x) => x.low));
          const stop = res ? stopRaw + C.stopBufferAtr * a : stopRaw - C.stopBufferAtr * a;
          const pp = planFor(side, c.close, stop, c.time, a, C.minRoomR);
          if (!block && pp.block) block = pp.block;
          evidence.push(`${L.type} ${r2(lvl)} (${L.sources.length} source${L.sources.length > 1 ? "s" : ""}${major ? ", major" : ""}) tested at ${hm(r.time + 300)}`);
          evidence.push(kind === "FAILED_BREAK" ? `Failed ${res ? "breakout" : "breakdown"}: closed ${res ? "above" : "below"} the level, then closed back ${res ? "below" : "above"} within ${C.failedBreakBars} candles` : kind === "SWEEP" ? `Sweep: traded ${r2(res ? r.high - lvl : lvl - r.low)} pts through and closed back ${res ? "below" : "above"}` : `Rejection candle: wick ${r2(res ? r.high - Math.max(r.open, r.close) : Math.min(r.open, r.close) - r.low)} pts, closed back ${res ? "below" : "above"} the level`);
          evidence.push(`Confirmed ${hm(tEnd)}: close ${r2(c.close)} ${res ? "below" : "above"} the rejection candle's midpoint ${r2(mid)}`);
          evidence.push(`15M trend ${d15 ?? "n/a"}${reg ? ` · regime ${reg}` : ""} · context ${context}${extreme ? ` (move ${r2(moveIn)} pts ≥ ${C.extremeDailyAtrFrac}× daily ATR)` : ""}`);
          const sig: SetupSignal = {
            id: `S3|${day}|${key}|${hm(tEnd)}`, setup: "S3_LEVEL_REJECTION",
            label: `S3 Level Rejection — ${context === "MORNING" ? "Morning (Setup 1)" : context === "EXTREME" ? "Extreme (Setup 2)" : "Major level"}`,
            context, side, date: day, barTime: c.time, time: hm(tEnd),
            level: { type: L.type, price: lvl, sources: L.sources, major }, evidence, blockedBy: block, plan: pp.plan,
            status: block ? "BLOCKED" : "ENTRY_READY", fillTime: null, exitTime: null, exitPrice: null, resultR: null,
            metrics: { atr: r2(a), zone: r2(z), wick: r2(res ? r.high - Math.max(r.open, r.close) : Math.min(r.open, r.close) - r.low), penetration: r2(res ? r.high - lvl : lvl - r.low), dir15: d15, regime: reg, moveIn: r2(moveIn), sessRange: r2(sessExt) },
          };
          if (!block) { st.fired++; st.lastFire = tEnd; }
          push(sig);
          continue;
        }
        else if (c.time - today[st.pending.i - off].time >= C.confirmBars * 300) st.pending = null;   // expired
      }
      // 2) a new rejection / sweep candle at this bar (accepted levels are no longer faded)
      if (st.acceptedAt != null || !touched) continue;
      const range = c.high - c.low;
      const pen = res ? c.high - lvl : lvl - c.low;
      const closedBack = res ? c.close < lvl : c.close > lvl;
      const wick = res ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low;
      const clv = range > 0 ? (res ? (c.close - c.low) / range : (c.high - c.close) / range) : 1;
      if (!closedBack || range < C.minRangeAtr * a) continue;
      // failed break: closed beyond the level within the last 3 candles (not accepted) and now closes back strongly
      if (k - st.lastBeyondK >= 1 && k - st.lastBeyondK <= C.failedBreakBars && (res ? c.close < c.open : c.close > c.open)) { st.pending = { i, kind: "FAILED_BREAK" }; continue; }
      if (pen > C.maxPenetrationAtr * a) { st.pending = { i, kind: "SWEEP" }; continue; }          // deep probe + close back = sweep
      if (wick >= C.minWickAtr * a && wick >= C.minWickFrac * range && clv <= C.closeFrac) st.pending = { i, kind: "REJECTION" };
    }

    // ---------------- S4: VWAP trend pullback (after 09:45) ----------------
    const vw = VW[i], e9 = E9[i];
    if (vw != null && e9 != null && m + 5 > C.vwapStartMin && inWindow) {
      const hold = today.slice(Math.max(0, k - C.vwapHoldBars + 1), k + 1);
      const up = hold.length >= C.vwapHoldBars && hold.every((x, j) => x.close > (VW[i - (hold.length - 1 - j)] ?? Infinity));
      const dn = hold.length >= C.vwapHoldBars && hold.every((x, j) => x.close < (VW[i - (hold.length - 1 - j)] ?? -Infinity));
      const recent = today.slice(Math.max(0, k - 6), k + 1);
      if (up) s4ExtHi = Math.max(s4ExtHi, c.high); if (dn) s4ExtLo = Math.min(s4ExtLo, c.low);
      for (const side of (up ? ["CE"] : dn ? ["PE"] : []) as ("CE" | "PE")[]) {
        const maxDist = side === "CE" ? Math.max(...recent.map((x, j) => x.high - (VW[i - (recent.length - 1 - j)] ?? x.high))) : Math.max(...recent.map((x, j) => (VW[i - (recent.length - 1 - j)] ?? x.low) - x.low));
        const stretched = maxDist >= C.vwapK * a;
        const pull = side === "CE" ? c.low <= e9 + C.pullbackAtr * a && c.close > e9 && c.close > c.open && c.close - vw >= 0.5 * a
                                   : c.high >= e9 - C.pullbackAtr * a && c.close < e9 && c.close < c.open && vw - c.close >= 0.5 * a;
        if (!stretched || !pull) continue;
        const d15 = dir15At(tEnd);
        const reg = opts.regimeAt ? opts.regimeAt(all.slice(0, i + 1)) : null;
        let block: string | null = null;
        if ((side === "CE" && d15 !== "UP") || (side === "PE" && d15 !== "DOWN")) block = `15M trend ${d15 ?? "n/a"} does not agree`;
        if (!block && reg === "RANGE") block = "Regime RANGE — VWAP extensions mean-revert";
        const dayMove = side === "CE" ? c.high - sessOpen : sessOpen - c.low;
        if (!block && dailyAtr != null && dayMove > C.extendedDailyAtr * dailyAtr) block = `EXTENDED — day move ${r2(dayMove)} pts > ${C.extendedDailyAtr}× daily ATR`;
        const nearOpp = roomTo(side, c.close, c.time, 0);
        if (!block && nearOpp && Math.abs(nearOpp.price - c.close) < C.roomM * a) block = `${nearOpp.type} ${r2(nearOpp.price)} within ${r2(Math.abs(nearOpp.price - c.close))} pts (< ${C.roomM}× ATR = ${r2(C.roomM * a)})`;
        if (!block && s4Count[side] >= C.maxS4PerSide) block = `Max ${C.maxS4PerSide} VWAP signals per side today`;
        if (!block && k - s4LastBar < 4) block = "Same pullback leg as the previous signal";
        if (!block && !cooled("S4_VWAP_PULLBACK")) block = `Cooldown ${C.slCooldownMin} min after a stop`;
        if (!block && openSig) block = "Another setup signal is still open";
        const swing = side === "CE" ? Math.min(c.low, today[Math.max(0, k - 1)].low) - C.stopBufferAtr * a : Math.max(c.high, today[Math.max(0, k - 1)].high) + C.stopBufferAtr * a;
        const pp = planFor(side, c.close, swing, c.time, a, C.minRoomR);
        if (!block && pp.block) block = pp.block;
        const sig: SetupSignal = {
          id: `S4|${day}|${side}|${hm(tEnd)}`, setup: "S4_VWAP_PULLBACK", label: "S4 VWAP Trend Pullback (Setup 3)", context: "AFTER 09:45", side, date: day,
          barTime: c.time, time: hm(tEnd), level: null, blockedBy: block, plan: pp.plan,
          evidence: [
            `VWAP bias ${side === "CE" ? "BULLISH: 5m candle closed above" : "BEARISH: 5m candle closed below"} VWAP ${r2(vw)}; stretched ${r2(maxDist)} pts (≥ ${C.vwapK}× ATR ${r2(a)} = ${r2(C.vwapK * a)}; your rule: ${C.refVwapPts} pts)`,
            `Pullback to EMA 9 ${r2(e9)} held — close ${r2(c.close)} ${side === "CE" ? "above" : "below"} it`,
            `Room: ${nearOpp ? `${nearOpp.type} ${r2(nearOpp.price)} is ${r2(Math.abs(nearOpp.price - c.close))} pts away` : "no major level in the way"} (need ≥ ${C.roomM}× ATR = ${r2(C.roomM * a)}; your rule: ${C.refRoomPts} pts)`,
            `15M trend ${d15 ?? "n/a"}${reg ? ` · regime ${reg}` : ""}`,
          ],
          status: block ? "BLOCKED" : "ENTRY_READY", fillTime: null, exitTime: null, exitPrice: null, resultR: null,
          metrics: { atr: r2(a), vwap: r2(vw), vwapDist: r2(c.close - vw), maxDist: r2(maxDist), ema9: r2(e9), dir15: d15, regime: reg },
        };
        if (!block) { s4Count[side]++; s4LastBar = k; }
        push(sig);
      }
    }
  }
  // Opposite signals confirmed on the SAME candle → both blocked (conflict = WAIT).
  const byBar = new Map<number, SetupSignal[]>();
  for (const s of signals) if (!s.blockedBy) { const a = byBar.get(s.barTime) || []; a.push(s); byBar.set(s.barTime, a); }
  for (const xs of byBar.values()) if (new Set(xs.map((s) => s.side)).size > 1) xs.forEach((s) => { s.blockedBy = "Opposite signal on the same candle — WAIT"; s.status = "BLOCKED"; });

  // Watch list (live): what each nearby level is doing right now.
  const last = today[today.length - 1], la = A[off + today.length - 1] ?? 0;
  for (const L of levels) {
    if (L.activeFrom > last.time) continue;
    const st = lvState.get(`${L.type}|${L.price}`); const dist = Math.abs(last.close - L.price);
    const side = st ? (st.home === "BELOW" ? "RESISTANCE" : "SUPPORT") : (L.price > last.close ? "RESISTANCE" : "SUPPORT");
    let state: WatchState | null = null, note = "";
    if (st?.acceptedAt != null && last.time + 300 - st.acceptedAt < 30 * 60) { state = "ACCEPTED"; note = `2 closes beyond at ${hm(st.acceptedAt)} — level flipped, not faded`; }
    else if (st?.pending) { state = "CONFIRMATION_PENDING"; note = `${st.pending.kind === "SWEEP" ? "Sweep" : st.pending.kind === "FAILED_BREAK" ? "Failed-break" : "Rejection"} candle at ${hm(st.pending.i >= off ? today[st.pending.i - off].time + 300 : 0)} — needs a confirming close`; }
    else if (dist <= Math.max(0.5, C.zoneAtr * la)) { state = "LEVEL_TEST"; note = "price is in the level zone"; }
    else if (dist <= la) { state = "APPROACHING"; note = `${r2(dist)} pts away (≤ 1 ATR)`; }
    if (state) out.watch.push({ level: L.type, price: L.price, side, state, since: hm(last.time + 300), note });
  }
  out.signals = signals.sort((a, b) => b.barTime - a.barTime);
  out.atr = r2(la); out.vwap = VW[off + today.length - 1] != null ? r2(VW[off + today.length - 1] as number) : null; out.dir15 = dir15At(last.time + 300);
  out.vwapBias = { bias: out.vwap == null ? "NEUTRAL" : last.close > out.vwap ? "BULLISH" : last.close < out.vwap ? "BEARISH" : "NEUTRAL", close: last.close, vwap: out.vwap, time: hm(last.time + 300) };
  return out;
}

/** Daily ATR (14) from session highs/lows/closes of 5m history (no extra data call). */
export function dailyAtrFrom5m(sessions: Candle[][]): number | null {
  const d = sessions.filter((s) => s.length).map((s) => ({ high: Math.max(...s.map((x) => x.high)), low: Math.min(...s.map((x) => x.low)), close: s[s.length - 1].close }));
  if (d.length < 5) return null;
  const tr = d.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - d[i - 1].close), Math.abs(x.low - d[i - 1].close)) : x.high - x.low));
  const last = tr.slice(-14);
  return r2(last.reduce((a, b) => a + b, 0) / last.length);
}

export interface ReplaySummary { sessions: number; bySetup: Record<string, { signals: number; wins: number; losses: number; flat: number; avgR: number | null; totalR: number; byContext: Record<string, { n: number; avgR: number | null }>; blocked: number; topBlocks: [string, number][] }>; note: string; }
export function summarizeReplay(results: SessionResult[]): ReplaySummary {
  const by: ReplaySummary["bySetup"] = {};
  for (const r of results) for (const s of r.signals) {
    const b = (by[s.setup] ||= { signals: 0, wins: 0, losses: 0, flat: 0, avgR: null, totalR: 0, byContext: {}, blocked: 0, topBlocks: [] });
    if (s.blockedBy) { b.blocked++; const key = s.blockedBy.replace(/\b\d{3,}(\.\d+)?\b|\b\d+\.\d+\b/g, "#").split(" — ")[0].replace(/\s+/g, " ").trim().slice(0, 48); const t = b.topBlocks.find((x) => x[0] === key); if (t) t[1]++; else b.topBlocks.push([key, 1]); continue; }
    if (s.resultR == null) continue;
    b.signals++; b.totalR = r2(b.totalR + s.resultR);
    if (s.resultR > 0.05) b.wins++; else if (s.resultR < -0.05) b.losses++; else b.flat++;
    const cx = (b.byContext[s.context] ||= { n: 0, avgR: 0 }); cx.avgR = r2(((cx.avgR ?? 0) * cx.n + s.resultR) / (cx.n + 1)); cx.n++;
  }
  for (const b of Object.values(by)) { b.avgR = b.signals ? r2(b.totalR / b.signals) : null; b.topBlocks.sort((a, c) => c[1] - a[1]); b.topBlocks = b.topBlocks.slice(0, 5); }
  return { sessions: results.length, bySetup: by, note: "Index-points R only (entry next candle open, spot SL/target, 12-bar time exit, 15:15 exit). Option premium, slippage and costs are NOT included — historical option prices are not available." };
}

export { istDay as setupIstDay, istMin as setupIstMin, hm as setupHm };

// ============================ Test log analysis: logic vs what the market did ============================
// Significant moves are found with a zig-zag on the session's closed 5m candles
// (a swing ends when price reverses ≥ revAtr × ATR from its extreme); a move counts
// when it travels ≥ minAtr × ATR. Each move is then compared with the signals:
//   CAUGHT     a valid same-direction signal fired near the start (≤ 1/3 of the move)
//   LATE       a valid same-direction signal fired later in the move
//   BLOCKED    the logic saw a same-direction setup but a filter said WAIT (reasons listed)
//   WRONG_SIDE a valid signal AGAINST the move fired during it
//   MISSED     the logic saw nothing — context (nearest level, VWAP side) is recorded
//   OUTSIDE    the move happened when the rules allow no entry (before 09:20 / after 14:00)
// This is analysis of a finished day (uses the whole day by design); it never feeds a signal.
export interface MarketMove {
  startTime: string; endTime: string; dir: "UP" | "DOWN"; from: number; to: number; pts: number; atrX: number; bars: number;
  verdict: "CAUGHT" | "LATE" | "BLOCKED" | "WRONG_SIDE" | "MISSED" | "OUTSIDE"; detail: string;
  signalId: string | null; resultR: number | null; blockReasons: string[]; context: string;
}
export interface MoveAnalysis { moves: MarketMove[]; summary: Record<string, number>; blockReasons: Record<string, number>; losses: { time: string; setup: string; side: string; context: string; level: string | null; why: string }[]; config: { revAtr: number; minAtr: number }; }
export function analyzeMoves(hist: Candle[], today: Candle[], signals: SetupSignal[], levels: LiqLevel[], opt = { revAtr: 1.5, minAtr: 2.5 }): MoveAnalysis {
  const out: MoveAnalysis = { moves: [], summary: { moves: 0, CAUGHT: 0, LATE: 0, BLOCKED: 0, WRONG_SIDE: 0, MISSED: 0, OUTSIDE: 0 }, blockReasons: {}, losses: [], config: opt };
  if (today.length < 6) return out;
  const all = [...hist, ...today], off = hist.length, A = atr(all, 14), VW = vwap(all);
  const aAt = (k: number) => A[off + k] ?? (today[k].high - today[k].low);
  // zig-zag
  const legs: { s: number; sp: number; e: number; ep: number; dir: 1 | -1 }[] = [];
  let dir: 0 | 1 | -1 = 0, sIdx = 0, sPx = today[0].open, eIdx = 0, ePx = today[0].open, hiI = 0, loI = 0;
  for (let k = 0; k < today.length; k++) {
    const c = today[k], thr = opt.revAtr * aAt(k);
    if (dir === 0) {
      // ">=" / "<=": on a flat base the move starts at the LAST equal extreme, not the first
      if (c.high >= today[hiI].high) hiI = k; if (c.low <= today[loI].low) loI = k;
      if (today[hiI].high - today[loI].low >= thr) {
        if (hiI > loI) { dir = 1; sIdx = loI; sPx = today[loI].low; eIdx = hiI; ePx = today[hiI].high; }
        else { dir = -1; sIdx = hiI; sPx = today[hiI].high; eIdx = loI; ePx = today[loI].low; }
      }
      continue;
    }
    if (dir === 1) {
      if (c.high >= ePx) { ePx = c.high; eIdx = k; }
      else if (ePx - c.low >= thr) { legs.push({ s: sIdx, sp: sPx, e: eIdx, ep: ePx, dir: 1 }); dir = -1; sIdx = eIdx; sPx = ePx; eIdx = k; ePx = c.low; }
    } else {
      if (c.low <= ePx) { ePx = c.low; eIdx = k; }
      else if (c.high - ePx >= thr) { legs.push({ s: sIdx, sp: sPx, e: eIdx, ep: ePx, dir: -1 }); dir = 1; sIdx = eIdx; sPx = ePx; eIdx = k; ePx = c.high; }
    }
  }
  if (dir !== 0) legs.push({ s: sIdx, sp: sPx, e: eIdx, ep: ePx, dir });
  for (const L of legs) {
    const a = aAt(L.s), pts = Math.abs(L.ep - L.sp);
    if (pts < opt.minAtr * a) continue;
    const side = L.dir === 1 ? "CE" : "PE";
    const tS = today[L.s].time, tE = today[L.e].time, barsN = L.e - L.s + 1;
    const early = tS + Math.max(2, Math.ceil(barsN / 3)) * 300;
    const inLeg = (s: SetupSignal) => s.barTime >= tS - 2 * 300 && s.barTime <= tE;
    const valid = signals.filter((s) => !s.blockedBy && s.status !== "EXTENDED");
    const same = valid.filter((s) => s.side === side && inLeg(s)).sort((x, y) => x.barTime - y.barTime);
    const blocked = signals.filter((s) => s.blockedBy && s.side === side && inLeg(s));
    const against = valid.filter((s) => s.side !== side && inLeg(s));
    // context at the move's start: nearest level (≤ 0.5 ATR), VWAP side
    const startPx = L.sp, vw = VW[off + L.s];
    const near = levels.filter((l) => l.activeFrom <= tS && Math.abs(l.price - startPx) <= 0.5 * a).sort((x, y) => Math.abs(x.price - startPx) - Math.abs(y.price - startPx))[0];
    const context = `${near ? `started at ${near.type} ${r2(near.price)}` : "started away from any mapped level"}; price ${vw != null ? (today[L.s].close >= vw ? "above" : "below") + " VWAP" : "vs VWAP n/a"}`;
    let verdict: MarketMove["verdict"], detail: string, sig: SetupSignal | null = null;
    if (same.length && same[0].barTime <= early) { verdict = "CAUGHT"; sig = same[0]; detail = `${sig.setup.slice(0, 2)} ${side} at ${sig.time} (${sig.status}${sig.resultR != null ? ` ${sig.resultR > 0 ? "+" : ""}${sig.resultR}R` : ""})`; }
    else if (same.length) { verdict = "LATE"; sig = same[0]; detail = `${sig.setup.slice(0, 2)} ${side} only at ${sig.time} — ${Math.round((sig.barTime - tS) / 300)} candles into the move (${sig.status}${sig.resultR != null ? ` ${sig.resultR > 0 ? "+" : ""}${sig.resultR}R` : ""})`; }
    else if (blocked.length) { verdict = "BLOCKED"; detail = `setup seen ${blocked.length}× but blocked`; }
    else if (against.length) { verdict = "WRONG_SIDE"; sig = against[0]; detail = `${sig.setup.slice(0, 2)} ${sig.side} at ${sig.time} against the move (${sig.status}${sig.resultR != null ? ` ${sig.resultR}R` : ""})`; }
    else if (istMin(tE) + 5 <= C.firstEntryMin + 5 || istMin(tS) >= C.lastEntryMin) { verdict = "OUTSIDE"; detail = istMin(tS) >= C.lastEntryMin ? "started after 14:00 — no new entries allowed by the rules" : "finished before 09:25 — before the first allowed entry"; }
    else { verdict = "MISSED"; detail = "no setup recognised by the logic"; }
    const reasons = [...new Set(blocked.map((s) => (s.blockedBy as string).replace(/\b\d{3,}(\.\d+)?\b|\b\d+\.\d+\b/g, "#").split(" — ")[0].trim()))];
    if (verdict === "BLOCKED") for (const r of reasons) out.blockReasons[r] = (out.blockReasons[r] || 0) + 1;
    out.moves.push({ startTime: hm(tS), endTime: hm(tE + 300), dir: L.dir === 1 ? "UP" : "DOWN", from: r2(L.sp), to: r2(L.ep), pts: r2(pts), atrX: r2(pts / a), bars: barsN,
      verdict, detail, signalId: sig ? sig.id : null, resultR: sig ? sig.resultR : null, blockReasons: reasons, context });
    out.summary[verdict]++; out.summary.moves++;
  }
  for (const s of signals) if (!s.blockedBy && s.status === "STOP") out.losses.push({ time: s.time, setup: s.setup.slice(0, 2), side: s.side, context: s.context, level: s.level ? `${s.level.type} ${s.level.price}` : null,
    why: `stopped at ${s.exitPrice}; 15M ${s.metrics.dir15 ?? "n/a"}${s.metrics.regime ? `, regime ${s.metrics.regime}` : ""}` });
  return out;
}
