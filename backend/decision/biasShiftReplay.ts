// TLS: trust system + bundled CAs (same as the other research CLIs).
import tls from "node:tls";
try {
  const t: any = tls;
  if (typeof t.getCACertificates === "function" && typeof t.setDefaultCACertificates === "function") t.setDefaultCACertificates([...(t.getCACertificates("bundled") || []), ...(t.getCACertificates("system") || [])]);
} catch { /* older Node */ }

// Bias-Shift replay (research): does a WEAKENING / SHIFT state actually precede a
// move in the new direction, how often is it a false shift, how much earlier is it
// than S1, and would gating S1 by it have helped? Strictly causal: each day's
// states come from biasShiftAt() run on candles up to that day's close — the walk
// is incremental, so the state at bar i only ever used bars ≤ i (see the test).
//
//   tsx backend/decision/biasShiftReplay.ts 2026-04-01 2026-10-06 [NIFTY,SENSEX,...]

import fs from "node:fs";
import path from "node:path";
import { Candle } from "../types";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { fetchDhanCandles } from "../data/dhanHistorical";
import { atr } from "../indicators";
import { runEngine } from "../testlab/engine";
import { defaultConfig } from "../testlab/config";
import { biasShiftAt, BiasState } from "./biasShift";

const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function firstTouch(cs: Candle[], i: number, dir: 1 | -1, a: number) {
  const fill = cs[i + 1]?.open; if (fill == null || istDate(cs[i + 1].time) !== istDate(cs[i].time)) return null;
  let mfe = 0, mae = 0, first: "WIN" | "LOSS" | "NONE" = "NONE";
  for (let k = i + 1; k <= i + 12 && k < cs.length; k++) {
    const c = cs[k]; if (istDate(c.time) !== istDate(cs[i].time)) break;
    const fav = (dir > 0 ? c.high - fill : fill - c.low) / a, adv = (dir > 0 ? fill - c.low : c.high - fill) / a;
    if (first === "NONE") { if (adv >= 1) first = "LOSS"; else if (fav >= 1.5) first = "WIN"; }
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
  }
  return { first, mfe, mae };
}
const dirOf = (s: BiasState): 1 | -1 | 0 =>
  s === "SHIFT_BEARISH" || s === "BULLISH_WEAKENING" || s === "BEARISH_LEG" ? -1 : s === "SHIFT_BULLISH" || s === "BEARISH_WEAKENING" || s === "BULLISH_LEG" ? 1 : 0;

async function main() {
  const [, , from = "2026-04-01", to = "2026-10-06", idxArg] = process.argv;
  const names = (idxArg || "NIFTY,SENSEX,BANKNIFTY,FINNIFTY,MIDCPNIFTY").split(",");
  const out: any = { from, to, byIndex: {}, all: {} };
  const agg: Record<string, { n: number; win: number; loss: number; mfe: number; mae: number; cancelled6: number }> = {};
  const base = { n: 0, win: 0, loss: 0 };
  const lead: number[] = []; const s1 = { against: [] as number[], with: [] as number[], neutral: [] as number[] };
  for (const name of names) {
    const sec = await lookupDhanSecurity(name); if (!sec) continue;
    const warm = new Date(new Date(from + "T00:00:00Z").getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const next = new Date(new Date(to + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
    const cs = (await fetchDhanCandles(sec, "5", warm, next)).filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
    const a14 = atr(cs, 14);
    const idxOf = new Map(cs.map((c, i) => [c.time, i]));
    const days = [...new Set(cs.map((c) => istDate(c.time)))].filter((d) => d >= from && d <= to);
    const stateAt = new Map<number, BiasState>();   // bar time → state in force after that bar
    for (const d of days) {
      const end = cs.findIndex((c) => istDate(c.time) > d);
      const upto = cs.slice(0, end < 0 ? cs.length : end).slice(-450);
      const r = biasShiftAt(upto);
      const todays = upto.filter((c) => istDate(c.time) === d);
      let cur: BiasState = "MIXED"; let e = 0;
      for (const c of todays) { while (e < r.events.length && r.events[e].time <= c.time) cur = r.events[e++].state; stateAt.set(c.time, cur); }
      // events: measure forward behaviour in the event's new direction
      for (let k = 0; k < r.events.length; k++) {
        const ev = r.events[k]; const dir = dirOf(ev.state); if (!dir) continue;
        if (ev.state === "BEARISH_LEG" || ev.state === "BULLISH_LEG") continue;
        const i = idxOf.get(ev.time); if (i == null) continue;
        const ft = firstTouch(cs, i, dir, a14[i] || 1); if (!ft) continue;
        const key = ev.state;
        const A = (agg[`${name}|${key}`] ||= { n: 0, win: 0, loss: 0, mfe: 0, mae: 0, cancelled6: 0 });
        const T = (agg[`ALL|${key}`] ||= { n: 0, win: 0, loss: 0, mfe: 0, mae: 0, cancelled6: 0 });
        const nxt = r.events[k + 1];
        const cancelled = !!nxt && nxt.time - ev.time <= 6 * 300 && dirOf(nxt.state) !== dir;
        for (const X of [A, T]) { X.n++; if (ft.first === "WIN") X.win++; if (ft.first === "LOSS") X.loss++; X.mfe += ft.mfe; X.mae += ft.mae; if (cancelled) X.cancelled6++; }
      }
    }
    // baseline: every session bar 09:30–14:30, both directions
    for (let i = 0; i < cs.length; i++) {
      const d = istDate(cs[i].time); if (d < from || d > to) continue;
      const m = Math.floor(((cs[i].time + 19800) % 86400) / 60); if (m < 570 || m > 870) continue;
      for (const dir of [1, -1] as const) { const ft = firstTouch(cs, i, dir, a14[i] || 1); if (!ft) continue; base.n++; if (ft.first === "WIN") base.win++; if (ft.first === "LOSS") base.loss++; }
    }
    // S1 (Test Lab scorer, spot) — lead time vs SHIFT events, and trades split by bias state
    const first = cs.findIndex((c) => istDate(c.time) >= from);
    const key = (["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"].includes(name) ? name : "NIFTY") as any;
    const cfg: any = { ...defaultConfig(key, "5m"), dataMode: "SPOT_DIRECTION" };
    const use = cs.slice(Math.max(0, first - 75));
    const eng = runEngine({ config: cfg, candles: use, oi: use.map(() => null), oiStatus: "UNAVAILABLE", vwapSource: "SPOT", symbol: name,
      binding: { underlying: name, futuresSymbol: null, securityId: null, expiry: null, exchangeSegment: null, lotSize: null, status: "UNAVAILABLE_HISTORICAL", bindingReason: "spot" },
      expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), warmupCount: Math.min(75, first) });
    const leanAt = new Map<number, 1 | -1 | 0>();
    for (const row of eng.rows) leanAt.set(row.timestamp, row.buyScore >= 55 && row.buyScore >= row.sellScore + 10 ? 1 : row.sellScore >= 55 && row.sellScore >= row.buyScore + 10 ? -1 : 0);
    const times = [...stateAt.keys()].sort((a, b) => a - b);
    let prev: BiasState = "MIXED";
    for (const t of times) {
      const s = stateAt.get(t)!;
      if ((s === "SHIFT_BEARISH" || s === "SHIFT_BULLISH") && s !== prev) {
        const dir = s === "SHIFT_BEARISH" ? -1 : 1; let k = 0;
        for (const t2 of times) { if (t2 < t || istDate(t2) !== istDate(t)) continue; if (leanAt.get(t2) === dir) { lead.push(k); break; } k++; if (k > 24) break; }
      }
      prev = s;
    }
    for (const tr of eng.trades) {
      const s = stateAt.get(tr.timestamp) ?? "MIXED";
      const d = tr.signal === "BUY" ? 1 : -1;
      const sd = dirOf(s) || (s === "BULLISH_CONTEXT" ? 1 : s === "BEARISH_CONTEXT" ? -1 : 0);
      const blocked = (d === 1 && (s === "BULLISH_WEAKENING" || s === "SHIFT_BEARISH" || s === "BEARISH_LEG")) || (d === -1 && (s === "BEARISH_WEAKENING" || s === "SHIFT_BULLISH" || s === "BULLISH_LEG"));
      (blocked ? s1.against : sd === d ? s1.with : s1.neutral).push(tr.rMultiple ?? 0);
    }
    console.log(`[bias-replay] ${name}: ${days.length} sessions`);
  }
  const fin = (x: any) => ({ n: x.n, winPct: x.n ? r3(x.win / x.n * 100) : null, winOfDecidedPct: x.win + x.loss ? r3(x.win / (x.win + x.loss) * 100) : null,
    avgMfeAtr: x.n ? r3(x.mfe / x.n) : null, avgMaeAtr: x.n ? r3(x.mae / x.n) : null, cancelledWithin6Pct: x.n ? r3(x.cancelled6 / x.n * 100) : null });
  for (const [k, v] of Object.entries(agg)) { const [ix, st] = k.split("|"); ((ix === "ALL" ? out.all : (out.byIndex[ix] ||= {})))[st] = fin(v); }
  out.baseline = { n: base.n, winPct: r3(base.win / base.n * 100), winOfDecidedPct: r3(base.win / (base.win + base.loss) * 100), note: "every 09:30–14:30 bar, both directions, +1.5 ATR before −1 ATR in 12 bars" };
  const med = (xs: number[]) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
  out.leadVsS1 = { shifts: lead.length, medianBarsBeforeS1Leans: med(lead), s1LeansSameBarPct: lead.length ? r3(lead.filter((x) => x === 0).length / lead.length * 100) : null };
  const st = (xs: number[]) => ({ n: xs.length, avgR: xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null, winPct: xs.length ? r3(xs.filter((x) => x > 0).length / xs.length * 100) : null, netR: r3(xs.reduce((a, b) => a + b, 0)) });
  out.s1TradesByBias = { againstBias_wouldBeBlocked: st(s1.against), withBias: st(s1.with), neutralBias: st(s1.neutral) };
  const dir = path.join(process.cwd(), "data", "bias-shift-replay"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${from}_${to}.json`); fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2)); console.log("Export:", file);
}
main().catch((e) => { console.error(e); process.exit(1); });
