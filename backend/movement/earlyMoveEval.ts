// TLS: trust system + bundled CAs (same as server.ts / Test Lab CLI). Must run before any fetch.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    anyTls.setDefaultCACertificates([...(anyTls.getCACertificates("bundled") || []), ...(anyTls.getCACertificates("system") || [])]);
  }
} catch { /* older Node */ }

// ============================================================================
// EARLY-MOVE EVALUATION (research, read-only). Do the app's existing intraday
// early-move detectors fire BEFORE moves, and are they better than chance?
//
//   A  computeEarlyMove  (movement/earlyMove.ts — the "EARLY MOVE" pop-ups)
//   B  classifyEarlyMove (analyst/earlyMove.ts — Market Command "Early Move")
//
// Strict no-look-ahead: at each CLOSED 5m bar i the detector sees candles[0..i],
// only the 15m bars that had closed by then, and a daily series whose last bar
// is TODAY built from 5m bars 0..i. (Live, detector A also sees the forming 5m
// bar — the replay is slightly stricter.) Outcomes are measured afterwards and
// never fed back.
//
// For every signal (first bar of a run, 6-bar cooldown) and, as the BASELINE,
// for every eligible bar in each direction:
//   • first touch within 6 bars: +1 ATR before −1 ATR = WIN, the reverse = LOSS
//   • MFE / MAE over 6 bars and close-to-close return after 3 / 6 bars, in ATR(5m)
// Move events (for "how early"): a bar from which price runs ≥ 2 ATR within 6 bars
// with < 1 ATR against it first. Caught early = the detector was ON in that
// direction during the 3 bars up to the event bar.
//
//   tsx backend/movement/earlyMoveEval.ts [fromDate] [toDate] [SYMBOLS]
//   tsx backend/movement/earlyMoveEval.ts 2026-10-06 2026-10-06 NIFTY,SENSEX
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { Candle } from "../types";
import { DEFAULT_SYMBOLS, SymbolDef } from "../config";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { fetchDhanCandles } from "../data/dhanHistorical";
import { atr, ema } from "../indicators";
import { computeEarlyMove } from "./earlyMove";
import { classifyEarlyMove } from "../analyst/earlyMove";
import { detectMarketStructure } from "../liquidity/orderBlock";

const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const FWD = 6, COOLDOWN = 6;
const START_MIN = 9 * 60 + 30, END_MIN = 14 * 60 + 30;   // evaluate 09:30–14:30 bars (a 30-min forward window fits the session)

type Dir = "up" | "down";
interface Outcome { first: "WIN" | "LOSS" | "NONE"; mfe: number; mae: number; ret3: number | null; ret6: number | null }

function outcome(c5: Candle[], i: number, dir: Dir, a: number): Outcome | null {
  const day = istDate(c5[i].time), p0 = c5[i].close, s = dir === "up" ? 1 : -1;
  let first: Outcome["first"] = "NONE", mfe = 0, mae = 0, ret3: number | null = null, ret6: number | null = null;
  for (let k = 1; k <= FWD; k++) {
    const c = c5[i + k];
    if (!c || istDate(c.time) !== day) return k === 1 ? null : { first, mfe: r3(mfe), mae: r3(mae), ret3, ret6 };
    const fav = (dir === "up" ? c.high - p0 : p0 - c.low) / a;
    const adv = (dir === "up" ? p0 - c.low : c.high - p0) / a;
    if (first === "NONE") { if (adv >= 1) first = "LOSS"; else if (fav >= 1) first = "WIN"; }   // same bar → LOSS (conservative)
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
    const ret = s * (c.close - p0) / a;
    if (k === 3) ret3 = r3(ret);
    if (k === 6) ret6 = r3(ret);
  }
  return { first, mfe: r3(mfe), mae: r3(mae), ret3, ret6 };
}
function isMoveEvent(c5: Candle[], i: number, dir: Dir, a: number): boolean {
  const day = istDate(c5[i].time), p0 = c5[i].close;
  for (let k = 1; k <= FWD; k++) {
    const c = c5[i + k];
    if (!c || istDate(c.time) !== day) return false;
    const adv = (dir === "up" ? p0 - c.low : c.high - p0) / a;
    const fav = (dir === "up" ? c.high - p0 : p0 - c.low) / a;
    if (adv >= 1) return false;
    if (fav >= 2) return true;
  }
  return false;
}

interface Bucket { n: number; win: number; loss: number; none: number; mfe: number; mae: number; r3: number; r6: number; r3n: number; r6n: number }
const nb = (): Bucket => ({ n: 0, win: 0, loss: 0, none: 0, mfe: 0, mae: 0, r3: 0, r6: 0, r3n: 0, r6n: 0 });
function add(b: Bucket, o: Outcome) {
  b.n++; o.first === "WIN" ? b.win++ : o.first === "LOSS" ? b.loss++ : b.none++;
  b.mfe += o.mfe; b.mae += o.mae;
  if (o.ret3 != null) { b.r3 += o.ret3; b.r3n++; }
  if (o.ret6 != null) { b.r6 += o.ret6; b.r6n++; }
}
const fin = (b: Bucket) => ({
  signals: b.n,
  winPct: b.n ? +(b.win / b.n * 100).toFixed(1) : null,       // +1 ATR reached before −1 ATR
  lossPct: b.n ? +(b.loss / b.n * 100).toFixed(1) : null,
  decided: b.win + b.loss,
  winOfDecidedPct: b.win + b.loss ? +(b.win / (b.win + b.loss) * 100).toFixed(1) : null,
  avgMfeAtr: b.n ? r3(b.mfe / b.n) : null, avgMaeAtr: b.n ? r3(b.mae / b.n) : null,
  avgRet3Atr: b.r3n ? r3(b.r3 / b.r3n) : null, avgRet6Atr: b.r6n ? r3(b.r6 / b.r6n) : null,
});

async function load(def: SymbolDef, from: string, to: string) {
  const sec = await lookupDhanSecurity(def.nseSymbol || def.symbol);
  if (!sec) throw new Error("no Dhan security");
  const day = 86400000;
  const warm = new Date(new Date(from + "T00:00:00Z").getTime() - 12 * day).toISOString().slice(0, 10);
  const next = new Date(new Date(to + "T00:00:00Z").getTime() + day).toISOString().slice(0, 10);
  const dWarm = new Date(new Date(from + "T00:00:00Z").getTime() - 120 * day).toISOString().slice(0, 10);
  const c5 = (await fetchDhanCandles(sec, "5", warm, next)).filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
  const c15 = (await fetchDhanCandles(sec, "15", warm, next)).filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
  const daily = (await fetchDhanCandles(sec, "1d", dWarm, next)).filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
  return { c5, c15, daily };
}

async function main() {
  const [, , fromArg, toArg, symArg] = process.argv;
  const to = toArg || istDate(Math.floor(Date.now() / 1000));
  const from = fromArg || new Date(new Date(to + "T00:00:00Z").getTime() - 60 * 86400000).toISOString().slice(0, 10);
  // Optional filter by NSE symbol (NIFTY, SENSEX, RELIANCE…) or app symbol (^NSEI).
  const want = symArg ? symArg.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : null;
  const universe = DEFAULT_SYMBOLS.filter((d) => d.fno && (!want || want.includes(String(d.nseSymbol || "").toUpperCase()) || want.includes(d.symbol.toUpperCase())));
  if (!universe.length) throw new Error(`No F&O symbol matches ${symArg}`);
  const outDir = path.join(process.cwd(), "data", "early-move-eval", `run-${new Date(Date.now() + 19800000).toISOString().slice(0, 19).replace(/[-:T]/g, "")}`);
  fs.mkdirSync(outDir, { recursive: true });
  const sigLog = fs.createWriteStream(path.join(outDir, "signals.jsonl"));

  // buckets[detector][group]
  const B: Record<string, Record<string, Bucket>> = {};
  const bk = (det: string, grp: string) => ((B[det] ||= {})[grp] ||= nb());
  const events: Record<string, { n: number; caught: Record<string, number>; leads: Record<string, number[]> }> = {};
  const skipped: string[] = [];
  const onCount: Record<string, number> = {}, eligible: Record<string, number> = {};   // how often each detector is ON (chance level for "caught")
  let sessions = 0;

  for (const def of universe) {
    const type = def.type === "index" ? "index" : "stock";
    let data;
    try { data = await load(def, from, to); } catch (e: any) { skipped.push(`${def.name}: ${e?.message || e}`); continue; }
    const { c5, c15, daily } = data;
    if (c5.length < 100 || daily.length < 30) { skipped.push(`${def.name}: not enough data (${c5.length} 5m / ${daily.length} daily)`); continue; }
    const a5 = atr(c5, 14);
    const e21 = ema(c5.map((c) => c.close), 21), e9 = ema(c5.map((c) => c.close), 9);
    const days = new Set(c5.map((c) => istDate(c.time)).filter((d) => d >= from && d <= to));
    sessions = Math.max(sessions, days.size);
    const lastFire: Record<string, number> = {};
    const onA: Record<number, Dir | null> = {}, onB: Record<number, Dir | null> = {};
    let dayStart = 0;
    for (let i = 1; i < c5.length; i++) {
      const t = c5[i].time, d = istDate(t), m = istMin(t);
      if (istDate(c5[i - 1].time) !== d) dayStart = i;
      if (!days.has(d) || m < START_MIN || m > END_MIN) continue;
      const a = a5[i];
      if (!a || !(a > 0)) continue;

      // ---- baseline: every eligible bar, both directions ----
      for (const dir of ["up", "down"] as Dir[]) {
        const o = outcome(c5, i, dir, a);
        if (o) { add(bk("BASELINE (every bar)", `${type}:${dir}`), o); add(bk("BASELINE (every bar)", `all:${dir}`), o); }
        if (isMoveEvent(c5, i, dir, a) && !isMoveEvent(c5, i - 1, dir, a)) {
          const ev = (events[`${type}:${dir}`] ||= { n: 0, caught: {}, leads: {} }); ev.n++;
          (ev as any).pending = ((ev as any).pending || []).concat([{ i, dir }]);
        }
      }

      // ---- causal inputs ----
      const c5i = c5.slice(Math.max(0, i - 400), i + 1);
      const barEnd = t + 300;
      const c15i = c15.filter((x) => x.time + 900 <= barEnd).slice(-200);
      const today = c5.slice(dayStart, i + 1);
      const dPrev = daily.filter((x) => istDate(x.time) < d).slice(-80);
      const todayBar: Candle = { time: today[0].time, open: today[0].open, high: Math.max(...today.map((x) => x.high)), low: Math.min(...today.map((x) => x.low)), close: c5[i].close, volume: today.reduce((s, x) => s + (x.volume || 0), 0) };
      const dailyI = [...dPrev, todayBar];

      // ---- A: computeEarlyMove ----
      let dirA: Dir | null = null, stageA = "";
      try { const em = computeEarlyMove(def.symbol, def.name, type === "index" ? "index" : "equity", c5i, c15i, dailyI); if (em) { dirA = em.direction; stageA = em.stage; } } catch { dirA = null; }
      onA[i] = dirA;
      eligible[type] = (eligible[type] || 0) + 1;
      if (dirA) onCount[`A:${type}:${dirA}`] = (onCount[`A:${type}:${dirA}`] || 0) + 1;

      // ---- B: classifyEarlyMove (Market Command inputs, indices only — that is where it is used) ----
      let dirB: Dir | null = null, labelB = "";
      if (type === "index") {
        try {
          const win = c5.slice(Math.max(0, i - 299), i + 1);
          const off = i - (win.length - 1);
          const ms = detectMarketStructure(win, 3);
          const ms15 = c15i.length >= 20 ? detectMarketStructure(c15i, 3) : null;
          const recentCut = win.length - 3;
          const swHi = ms.swingPoints.filter((p: any) => (p.type === "HH" || p.type === "LH") && p.index < recentCut).slice(-1)[0]?.price ?? null;
          const swLo = ms.swingPoints.filter((p: any) => (p.type === "HL" || p.type === "LL") && p.index < recentCut).slice(-1)[0]?.price ?? null;
          const lb = ms.bosEvents.length ? ms.bosEvents[ms.bosEvents.length - 1] : null;
          const em = classifyEarlyMove({
            candles: win.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, time: c.time })),
            ema21: e21.slice(off, i + 1), ema9: e9.slice(off, i + 1), context5m: ms.currentStructure, structure15m: ms15 ? ms15.currentStructure : null,
            lastBos: lb ? { direction: lb.direction, breakIndex: lb.breakIndex, stage: lb.stage, time: lb.breakTime } : null,
            swingHigh: swHi, swingLow: swLo, tfLabel: "5M", otherTfLabel: "15M",
          } as any);
          if (em.direction === "BULLISH") dirB = "up"; else if (em.direction === "BEARISH") dirB = "down";
          labelB = em.label;
        } catch { dirB = null; }
      }
      onB[i] = dirB;
      if (dirB) onCount[`B:${type}:${dirB}`] = (onCount[`B:${type}:${dirB}`] || 0) + 1;

      // ---- signals (first bar of a run, cooldown) ----
      for (const [det, dir, sub] of [["A: Early Move pop-ups", dirA, stageA], ["B: MC Early Move", dirB, labelB]] as [string, Dir | null, string][]) {
        if (!dir) continue;
        const prev = det.startsWith("A") ? onA[i - 1] : onB[i - 1];
        const key = `${det}|${dir}`;
        if (prev === dir || (lastFire[key] != null && i - lastFire[key] < COOLDOWN)) continue;
        lastFire[key] = i;
        const o = outcome(c5, i, dir, a);
        if (!o) continue;
        add(bk(det, `${type}:${dir}`), o); add(bk(det, `all:${dir}`), o); add(bk(det, `all`), o);
        add(bk(det + " by stage/label", `${sub}:${dir}`), o);
        sigLog.write(JSON.stringify({ det, symbol: def.symbol, type, time: new Date((t + 19800) * 1000).toISOString().slice(0, 16).replace("T", " "), dir, sub, ...o }) + "\n");
      }
    }
    // "how early": was the detector ON in the event direction during bars [t-3, t]?
    for (const k of Object.keys(events)) {
      const ev: any = events[k];
      for (const { i, dir } of ev.pending || []) {
        for (const [det, on] of [["A", onA], ["B", onB]] as [string, Record<number, Dir | null>][]) {
          if (det === "B" && type !== "index") continue;
          let lead: number | null = null;
          for (let j = 3; j >= 0; j--) if (on[i - j] === dir) { lead = j; break; }
          if (lead != null) { ev.caught[det] = (ev.caught[det] || 0) + 1; (ev.leads[det] ||= []).push(lead); }
        }
      }
      ev.pending = [];
    }
    console.log(`[eval] ${def.name}: ${c5.length} bars`);
  }
  sigLog.end();

  const report: any = { from, to, sessions, symbolsSkipped: skipped, method: "first touch ±1 ATR(5m) within 6 bars; returns in ATR; baseline = every 09:30–14:30 bar", detectors: {}, moveEvents: {} };
  const base = B["BASELINE (every bar)"];
  for (const [det, groups] of Object.entries(B)) {
    report.detectors[det] = {};
    for (const [g, b] of Object.entries(groups)) {
      const f: any = fin(b);
      // Lift vs the baseline for the same instrument type + direction, with a z-score
      // (how many standard errors the win rate is above chance).
      const dir = g.split(":").pop();
      const bg = base && (base[g] || base[`all:${dir}`]);
      if (bg && det !== "BASELINE (every bar)" && (dir === "up" || dir === "down")) {
        const p0 = bg.win / Math.max(1, bg.win + bg.loss), n = b.win + b.loss, p = n ? b.win / n : 0;
        f.baselineWinOfDecidedPct = +(p0 * 100).toFixed(1);
        f.liftPts = +((p - p0) * 100).toFixed(1);
        f.z = n ? +((p - p0) / Math.sqrt(p0 * (1 - p0) / n)).toFixed(2) : null;
        f.ret6VsBaselineAtr = f.avgRet6Atr != null && bg.r6n ? r3(f.avgRet6Atr - bg.r6 / bg.r6n) : null;
      }
      report.detectors[det][g] = f;
    }
  }
  report.onRatePct = Object.fromEntries(Object.entries(onCount).map(([k, v]) => [k, +(v / Math.max(1, eligible[k.split(":")[1]]) * 100).toFixed(1)]));
  for (const [k, ev] of Object.entries(events)) {
    const med = (xs: number[]) => xs.length ? xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null;
    report.moveEvents[k] = { events: ev.n, caughtA: ev.caught.A || 0, caughtApct: ev.n ? +((ev.caught.A || 0) / ev.n * 100).toFixed(1) : 0, medianLeadBarsA: med(ev.leads.A || []),
      caughtB: k.startsWith("index") ? (ev.caught.B || 0) : null, caughtBpct: k.startsWith("index") && ev.n ? +((ev.caught.B || 0) / ev.n * 100).toFixed(1) : null, medianLeadBarsB: med(ev.leads.B || []) };
  }
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nExport: ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
