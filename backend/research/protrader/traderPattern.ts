// Trader pattern study (owner, 2026-10-28): can the experienced trader's 27 Oct calls become a rule?
// The rule below was WRITTEN BEFORE THE RUN from the 27 Oct trades (22750 PE above 50 at 10:07, 22750 CE above 52 at 12:12)
// and the Learning tab's checklist. Nothing is tuned here. Research only — no live logic changes.
// Usage: npx tsx backend/research/protrader/traderPattern.ts > backend/research/protrader/RESULTS_TRADER_PATTERN.md
//
// TP27 ("premium W at a key level"), per index, both sides, 3-minute candles of the ATM option (ATM at the candle close):
//   1. Fall:     the premium's lowest low of the last 30 min (the BASE) is ≤ 80 % of its session high before that base.
//   2. Base:     the base bar is an earlier bar (the current bar made no new low).
//   3. Turn:     the current 3-min bar is green and engulfs the previous red bar, or is strong (body ≥ 50 % of its range);
//                its close is ≤ base × 1.30 (entry near the bottom).
//   4. Level:    the index's high (PE) / low (CE) of the last 15 min is within max(0.08 %, 0.3 step) of a key level:
//                yesterday's high / low / close, first-15-min high / low, the call wall (PE) / put wall (CE) = the strike
//                with the most OI on that side among the recorded strikes, on the right side of the index.
//   Entry  the option's close at the 3-min close (conservative: the next minute's close). Window 09:45–14:30.
//   Stop   base × 0.98 (premium). Skip if the risk is > 35 % of the entry. Target 1 = entry + 2 × risk, full exit.
//   Time   15:15. One trade per index per side per day; no new trade on an index while one is open.
// Pre-registered sub-groups (reported, not selected): + index double top/bottom; + wall OI held (≥ −3 % in 12 min);
// with / against the day's trend. Control C0 = rules 1–3 without the level (does the level add anything?).
import fs from "fs";
import path from "path";
import { assemble, DayData, Min, istHm } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { optionPnl } from "./final1560/strategy";
import { DATA_DIR } from "../../config/dataDir";

type IX = "NIFTY" | "SENSEX";
const LOT = { NIFTY: 75, SENSEX: 20 }, STEP = { NIFTY: 50, SENSEX: 100 };
const FROM = "2024-10-14", TO = "2026-10-26";
const tOf = (day: string, hm: string) => Math.floor(Date.parse(`${day}T${hm}:00+05:30`) / 1000);

/** The days after the research cache (refreshData has not run yet): Market Command's own replay cache, same series. */
function ownDays(ix: IX, after: string): DayData[] {
  const dir = path.join(DATA_DIR, "replay-premium", ix), by = new Map<string, DayData>();
  let files: string[] = []; try { files = fs.readdirSync(dir); } catch { return []; }
  for (const f of files) { const m = /^(\d{4}-\d{2}-\d{2})_(CE|PE)_(-?\d)\.json$/.exec(f); if (!m || m[1] <= after) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), day = m[1], dd = by.get(day) || { day, spot: new Map(), legs: new Map(), expiryGuess: null };
    (d.timestamp || []).forEach((t: number, i: number) => {
      const mn = Math.floor(((t + 19800) % 86400) / 60); if (mn < 555 || mn >= 930 || !(d.close[i] > 0)) return;
      if (d.spot?.[i] > 0 && !dd.spot.has(t)) dd.spot.set(t, d.spot[i]);
      const k = `${d.strike[i]}${m[2]}`, a: Min[] = dd.legs.get(k) || []; if (!a.some((x) => x.t === t)) a.push({ t, o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i], v: d.volume?.[i] ?? null, oi: d.oi?.[i] ?? null, iv: null });
      dd.legs.set(k, a);
    });
    by.set(day, dd);
  }
  for (const d of by.values()) for (const a of d.legs.values()) a.sort((x, y) => x.t - y.t);
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}
function load(ix: IX): DayData[] {
  const base = (ix === "NIFTY" ? assemble(FROM, TO).days : assembleIndex(ix, FROM, TO)).filter((d) => d.spot.size >= 300);
  return [...base, ...ownDays(ix, base[base.length - 1].day).filter((d) => d.spot.size >= 300)];
}

interface Bar3 { t: number; o: number; h: number; l: number; c: number }
function agg3(a: Min[]): Bar3[] {
  const out: Bar3[] = [];
  for (const m of a) { const k = m.t - ((m.t - tOf(new Date((m.t + 19800) * 1000).toISOString().slice(0, 10), "09:15")) % 180);
    const b = out[out.length - 1]; if (b && b.t === k) { b.h = Math.max(b.h, m.h); b.l = Math.min(b.l, m.l); b.c = m.c; } else out.push({ t: k, o: m.o, h: m.h, l: m.l, c: m.c }); }
  return out;
}
interface Trade { ix: IX; day: string; side: "CE" | "PE"; t: number; strike: number; entry: number; entryC: number | null; stop: number; tgt: number;
  res: "TARGET" | "STOP" | "TIME"; exitT: number; exitPx: number; exitPxC: number; level: string; dbl: boolean; wallHeld: boolean | null; trend: "with" | "against" | "flat"; net: number; netC: number | null; ctrl: boolean }

function scanDay(ix: IX, d: DayData, prev: DayData | null, useLevel: boolean): Trade[] {
  const step = STEP[ix], spot = [...d.spot.entries()].sort((a, b) => a[0] - b[0]), out: Trade[] = [];
  const spotAt = (t: number) => { let v = spot[0][1]; for (const [s, p] of spot) { if (s > t) break; v = p; } return v; };
  const pv = prev ? [...prev.spot.values()] : null, pvs = prev ? [...prev.spot.entries()].sort((a, b) => a[0] - b[0]) : null;
  const f15 = spot.filter(([t]) => t < tOf(d.day, "09:30")).map(([, p]) => p), open = spot[0][1];
  const lv0: [string, number][] = [];
  if (pv && pvs) lv0.push(["PDH", Math.max(...pv)], ["PDL", Math.min(...pv)], ["PDC", pvs[pvs.length - 1][1]]);
  if (f15.length) lv0.push(["F15H", Math.max(...f15)], ["F15L", Math.min(...f15)]);
  const oiAt = (k: string, t: number) => { let v: number | null = null; for (const m of d.legs.get(k) || []) { if (m.t > t) break; if (m.oi != null && m.oi > 0) v = m.oi; } return v; };
  const strikes = [...new Set([...d.legs.keys()].map((k) => Number(k.slice(0, -2))))];
  const b3 = new Map<string, Bar3[]>(); const bars3 = (k: string) => { if (!b3.has(k)) b3.set(k, agg3(d.legs.get(k) || [])); return b3.get(k)!; };
  const done = new Set<string>(); let busyUntil = 0;
  const end = tOf(d.day, "15:15");
  for (let T = tOf(d.day, "09:45"); T <= tOf(d.day, "14:30"); T += 180) {
    if (T < busyUntil) continue;
    const S = spotAt(T - 60), atm = Math.round(S / step) * step;
    for (const side of ["PE", "CE"] as const) {
      if (done.has(side) || T < busyUntil) continue;
      const key = `${atm}${side}`, B = bars3(key), j = B.findIndex((b) => b.t + 180 === T); if (j < 11) continue;
      const win = B.slice(j - 10, j), bi = win.reduce((m, b, i) => (b.l < win[m].l ? i : m), 0), base = win[bi], bIdx = j - 10 + bi;
      const cur = B[j], pre = B[j - 1];
      if (cur.l < base.l) continue;
      const hiBefore = Math.max(...B.slice(0, bIdx + 1).map((b) => b.h)); if (!(base.l <= 0.8 * hiBefore)) continue;
      const green = cur.c > cur.o, eng = green && pre.c < pre.o && cur.c >= pre.o, strong = green && cur.c - cur.o >= 0.5 * (cur.h - cur.l);
      if (!(eng || strong) || cur.c > base.l * 1.3) continue;
      // index at a key level (only information known at T)
      const isPE = side === "PE", last15 = spot.filter(([t]) => t >= T - 900 && t < T).map(([, p]) => p); if (!last15.length) continue;
      const ext = isPE ? Math.max(...last15) : Math.min(...last15), tol = Math.max(S * 0.0008, step * 0.3);
      const walls = strikes.map((k) => ({ k, oi: oiAt(`${k}${isPE ? "CE" : "PE"}`, T) })).filter((x) => x.oi != null && (isPE ? x.k >= S - step : x.k <= S + step)).sort((a, b) => b.oi! - a.oi!);
      const lv = [...lv0.filter(([n]) => T >= tOf(d.day, "09:30") || !n.startsWith("F15"))]; if (walls[0]) lv.push([isPE ? "CALL WALL" : "PUT WALL", walls[0].k]);
      const near = lv.map(([n, v]) => ({ n, dd: Math.abs(ext - v) })).sort((a, b) => a.dd - b.dd)[0];
      const atLevel = !!near && near.dd <= tol;
      if (useLevel && !atLevel) continue;
      // entry / exit on the option's 1-minute closes
      const M = d.legs.get(key)!, ei = M.findIndex((m) => m.t + 60 === T); if (ei < 0) continue;
      const entry = M[ei].c, entryC = M[ei + 1]?.c ?? null, stop = base.l * 0.98, risk = entry - stop; if (!(risk > 0) || risk > 0.35 * entry) continue;
      const tgt = entry + 2 * risk; let res: Trade["res"] = "TIME", exitT = end, exitPx = entry;
      for (let i = ei + 1; i < M.length; i++) { const m = M[i]; if (m.t >= end) { break; } exitPx = m.c; exitT = m.t + 60;
        if (m.l <= stop) { res = "STOP"; exitPx = stop; break; } if (m.h >= tgt) { res = "TARGET"; exitPx = tgt; break; } }
      const after = M.find((m) => m.t >= exitT), exitPxC = res === "TIME" ? exitPx : after ? (res === "STOP" ? Math.min(after.c, stop) : after.c) : exitPx;
      // sub-group facts (known at T)
      const piv: [number, number][] = [], w = spot.filter(([t]) => t >= T - 3600 && t < T);
      for (let i = 3; i < w.length - 3; i++) { const s = w.slice(i - 3, i + 4).map(([, p]) => p); if (w[i][1] === (isPE ? Math.max(...s) : Math.min(...s))) piv.push(w[i]); }
      const dbl = piv.some((a, i) => piv.slice(i + 1).some((b) => b[0] - a[0] >= 240 && Math.abs(b[1] - a[1]) <= tol * 1.5 && Math.abs((isPE ? Math.max : Math.min)(a[1], b[1]) - ext) <= tol));
      const wk = walls[0] ? `${walls[0].k}${isPE ? "CE" : "PE"}` : null, wa = wk ? oiAt(wk, T - 720) : null, wb = wk ? oiAt(wk, T) : null;
      const pct = ((S - open) / open) * 100, tr = pct > 0.15 ? "UP" : pct < -0.15 ? "DOWN" : "FLAT";
      const net = optionPnl(entry, exitPx, LOT[ix]).net, netC = entryC != null ? optionPnl(entryC, exitPxC, LOT[ix], true).net : null;
      out.push({ ix, day: d.day, side, t: T, strike: atm, entry, entryC, stop, tgt, res, exitT, exitPx, exitPxC, level: atLevel ? near.n : "-", dbl, wallHeld: wa && wb ? wb >= wa * 0.97 : null,
        trend: tr === "FLAT" ? "flat" : (tr === "DOWN") === isPE ? "with" : "against", net, netC, ctrl: !useLevel });
      done.add(side); busyUntil = exitT;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- report
const R0 = (v: number) => Math.round(v).toLocaleString("en-IN");
function row(name: string, xs: Trade[]) {
  if (!xs.length) return `| ${name} | 0 | — | — | — | — | — | — | — |`;
  const n = xs.length, net = xs.map((x) => x.net), nc = xs.map((x) => x.netC ?? x.net), P = net.filter((v) => v > 0).reduce((a, b) => a + b, 0), N = -net.filter((v) => v <= 0).reduce((a, b) => a + b, 0);
  let c = 0, pk = 0, dd = 0; for (const v of nc) { c += v; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
  const k = (r: string) => xs.filter((x) => x.res === r).length;
  return `| ${name} | ${n} | ${k("TARGET")} / ${k("STOP")} / ${k("TIME")} | ${((100 * net.filter((v) => v > 0).length) / n).toFixed(1)} | ${R0(net.reduce((a, b) => a + b, 0) / n)} | ${R0(nc.reduce((a, b) => a + b, 0) / n)} | ${N ? (P / N).toFixed(2) : "∞"} | ${R0(net.reduce((a, b) => a + b, 0))} | ${R0(dd)} |`;
}
const HEAD = "| Group | Trades | Target / Stop / Time | Win % | Net / trade ₹ | Conservative / trade ₹ | PF | Total net ₹ | Max DD cons ₹ |\n|---|---|---|---|---|---|---|---|---|";

const all: Trade[] = [], ctrl: Trade[] = [], cut: Record<IX, string> = {} as any, span: Record<IX, string> = {} as any;
for (const ix of ["NIFTY", "SENSEX"] as IX[]) {
  const ds = load(ix); cut[ix] = ds[Math.floor((ds.length * 2) / 3)].day; span[ix] = `${ds[0].day} → ${ds[ds.length - 1].day} (${ds.length} sessions)`;
  for (let i = 1; i < ds.length; i++) { all.push(...scanDay(ix, ds[i], ds[i - 1], true)); ctrl.push(...scanDay(ix, ds[i], ds[i - 1], false)); }
}
all.sort((a, b) => a.t - b.t); ctrl.sort((a, b) => a.t - b.t);
const dev = (x: Trade) => x.day < cut[x.ix];
const L: string[] = [];
L.push("# Trader pattern TP27 — \"premium W at a key level\" (generated by traderPattern.ts)", "",
  "Rule written before the run from the experienced trader's 27 Oct calls; see the header of traderPattern.ts. ATM option, 3-min candles, stop = base × 0.98, target = 2 × risk, time exit 15:15. ₹ per lot (NIFTY 75, SENSEX 20) after costs (final1560 optionPnl: slippage, ₹40 brokerage, statutory). Conservative = +0.5 %/side and a 1-minute delay.", "",
  `Data: Dhan rolling-option 1-minute (ATM±3, nearest weekly, with OI). NIFTY ${span.NIFTY}; SENSEX ${span.SENSEX}. DEVELOPMENT = first ⅔ (NIFTY before ${cut.NIFTY}, SENSEX before ${cut.SENSEX}), VALIDATION = last ⅓.`, "",
  "## 1. TP27 by index and period", "", HEAD,
  row("ALL", all), row("NIFTY", all.filter((x) => x.ix === "NIFTY")), row("SENSEX", all.filter((x) => x.ix === "SENSEX")),
  row("DEVELOPMENT", all.filter(dev)), row("VALIDATION", all.filter((x) => !dev(x))),
  row("NIFTY DEV", all.filter((x) => x.ix === "NIFTY" && dev(x))), row("NIFTY VAL", all.filter((x) => x.ix === "NIFTY" && !dev(x))),
  row("SENSEX DEV", all.filter((x) => x.ix === "SENSEX" && dev(x))), row("SENSEX VAL", all.filter((x) => x.ix === "SENSEX" && !dev(x))), "",
  "## 2. Does the key level add anything? (control C0 = same rule without the level)", "", HEAD,
  row("C0 no level — ALL", ctrl), row("C0 DEV", ctrl.filter(dev)), row("C0 VAL", ctrl.filter((x) => !dev(x))), row("TP27 (with level) — ALL", all), "",
  "## 3. Pre-registered sub-groups (TP27 trades)", "", HEAD,
  row("PE", all.filter((x) => x.side === "PE")), row("CE", all.filter((x) => x.side === "CE")),
  row("+ index double top / bottom", all.filter((x) => x.dbl)), row("no double", all.filter((x) => !x.dbl)),
  row("+ wall OI held", all.filter((x) => x.wallHeld === true)), row("wall OI fell", all.filter((x) => x.wallHeld === false)),
  row("with the day's trend", all.filter((x) => x.trend === "with")), row("against the trend", all.filter((x) => x.trend === "against")), row("flat day so far", all.filter((x) => x.trend === "flat")),
  ...["PDH", "PDL", "PDC", "F15H", "F15L", "CALL WALL", "PUT WALL"].map((n) => row(`level ${n}`, all.filter((x) => x.level === n))),
  // post-hoc look only (chosen AFTER seeing section 3, so it cannot approve anything): does the best sub-group survive the split?
  row("post-hoc: PUT WALL DEV", all.filter((x) => x.level === "PUT WALL" && dev(x))), row("post-hoc: PUT WALL VAL", all.filter((x) => x.level === "PUT WALL" && !dev(x))),
  row("post-hoc: PDH DEV", all.filter((x) => x.level === "PDH" && dev(x))), row("post-hoc: PDH VAL", all.filter((x) => x.level === "PDH" && !dev(x))), "",
  "## 4. Half-years", "", HEAD, ...[...new Set(all.map((x) => x.day.slice(0, 4) + (x.day.slice(5, 7) <= "06" ? "-H1" : "-H2")))].map((h) => row(h, all.filter((x) => x.day.slice(0, 4) + (x.day.slice(5, 7) <= "06" ? "-H1" : "-H2") === h))), "",
  "## 5. Last 10 sessions, every TP27 trade", "", "| Index | Date | Time | Strike | Level | Entry | Stop | Target | Result | Exit | Net ₹ |", "|---|---|---|---|---|---|---|---|---|---|---|",
  ...all.filter((x) => x.day >= [...new Set(all.map((y) => y.day))].sort().slice(-10)[0]).map((x) => `| ${x.ix} | ${x.day} | ${istHm(x.t)} | ${x.strike} ${x.side} | ${x.level}${x.dbl ? " + double" : ""} | ${x.entry} | ${x.stop.toFixed(1)} | ${x.tgt.toFixed(1)} | ${x.res} | ${x.exitPx.toFixed(1)} at ${istHm(x.exitT)} | ${R0(x.net)} |`), "");
console.log(L.join("\n"));
