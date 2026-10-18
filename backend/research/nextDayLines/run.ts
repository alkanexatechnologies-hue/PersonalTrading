// Next-day test of (A) trendlines drawn from ONE day (15-min and 1-hour) and (B) the next-day plan built at the close.
// Usage: npx tsx backend/research/nextDayLines/run.ts <dir with NIFTY.json / SENSEX.json 5-min candles>
// Rules fixed before running - see RESULTS.md. Pure replay of closed candles; no look-ahead into D+1 when building lines/plans.
import * as fs from "fs";
import * as TV from "../../premium/traderView";
import { atr } from "../../indicators";

type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
const day = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const mn = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const agg = (bs: C[], startMin: number, stepMin: number): C[] => {
  const out: C[] = []; let cur: C | null = null, key = -1;
  for (const b of bs) { const k = Math.floor((mn(b.time) - startMin) / stepMin); if (k !== key || !cur) { if (cur) out.push(cur); cur = { ...b }; key = k; } else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume || 0; } }
  if (cur) out.push(cur); return out;
};
const dir = process.argv[2];
const report: any = {};
for (const name of ["NIFTY", "SENSEX"]) {
  const raw: C[] = JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8"));
  const by = new Map<string, C[]>(); for (const b of raw) { const d = day(b.time); if (mn(b.time) >= 930) continue; if (!by.has(d)) by.set(d, []); by.get(d)!.push(b); }
  const days = [...by.keys()].sort().filter((d) => by.get(d)!.length >= 70);
  const m15 = new Map(days.map((d) => [d, agg(by.get(d)!, 555, 15)])), h1 = new Map(days.map((d) => [d, agg(by.get(d)!, 555, 60)]));
  const all15: C[] = days.flatMap((d) => m15.get(d)!);
  const atrAt = (d: string) => { const upto = all15.filter((c) => day(c.time) <= d); return (atr(upto as any, 14) as any[]).filter((x) => x != null).slice(-1)[0] as number; };
  // ---------------- A. one-day trendlines → next day
  const A: Record<string, Record<string, number>> = {};
  const bump = (k: string, o: string) => { A[k] = A[k] || {}; A[k][o] = (A[k][o] || 0) + 1; };
  const grade = (next: C[], valAt: (j: number) => number, kind: "SELLER" | "BUYER", a: number) => {
    const up = kind === "SELLER", tol = 0.1 * a, v0 = valAt(0);
    if (up ? next[0].open > v0 + tol : next[0].open < v0 - tol) return "GAPPED THROUGH";
    for (let j = 0; j < next.length; j++) {
      const v = valAt(j), touched = up ? next[j].high >= v - tol : next[j].low <= v + tol; if (!touched) continue;
      for (let k = j; k < Math.min(next.length, j + 5); k++) {
        const vk = valAt(k);
        if (up ? next[k].close > vk + tol : next[k].close < vk - tol) return "BROKEN";
        if (up ? vk - next[k].low >= a : next[k].high - vk >= a) return "RESPECTED";
      }
      return "UNCLEAR";
    }
    return "NEVER TOUCHED";
  };
  for (let i = 0; i < days.length - 1; i++) {
    const D = days[i], N = days[i + 1], a = atrAt(D); if (!a) continue;
    const next = m15.get(N)!;
    for (const [tf, bars, k, perHour] of [["15m", m15.get(D)!, 2, 4], ["1h", h1.get(D)!, 1, 1]] as const) {
      const n = bars.length;
      const lines = (tf === "15m" ? TV.significantLines(bars as any, k, a, 0) : TV.allLines(bars as any, k).map((l) => { let brokeAt: number | null = null; for (let x = l.from + 1; x < n; x++) if (l.kind === "SELLER" ? bars[x].close > TV.lineAt(l, x) : bars[x].close < TV.lineAt(l, x)) { brokeAt = x; break; } return { ...l, brokeAt }; }))
        .filter((l: any) => l.brokeAt == null && l.from <= n - 1);
      for (const l of lines as any[]) {
        const idx = (j: number) => (tf === "15m" ? n + j : n + j / perHour * 0 + (n - 1) + (j + 1) / 4);   // 1h index advances 1 per 4 fifteen-minute bars
        const slanted = (j: number) => TV.lineAt(l, idx(j)), flatV = slanted(0), flat = () => flatV;
        bump(`${tf} ${l.kind} line`, grade(next, slanted, l.kind, a));
        bump(`${tf} ${l.kind} FLAT control`, grade(next, flat, l.kind, a));
      }
    }
  }
  // ---------------- B. next-day plan (built at D's close) applied on D+1
  const B = { days: 0, missed: 0, triggered: 0, t1: 0, stop: 0, time: 0, pts: [] as number[], noTrigger: 0, reanchored: 0 };
  for (let i = 5; i < days.length - 1; i++) {
    const D = days[i], N = days[i + 1], a = atrAt(D); if (!a) continue;
    const daily = days.slice(0, i + 1).map((d) => { const bs = by.get(d)!; return { time: bs[0].time, open: bs[0].open, high: Math.max(...bs.map((b) => b.high)), low: Math.min(...bs.map((b) => b.low)), close: bs[bs.length - 1].close, volume: 0 }; });
    const closed15 = all15.filter((c) => day(c.time) <= D), close = closed15[closed15.length - 1].close;
    const l15 = TV.activeLines(closed15 as any, 3), lD = TV.activeLines(daily as any, 2);
    const lineLv = [l15.seller && !l15.seller.broken ? { label: "15m seller trendline", value: l15.seller.next } : null, l15.buyer && !l15.buyer.broken ? { label: "15m buyer trendline", value: l15.buyer.next } : null,
      lD.seller && !lD.seller.broken ? { label: "Daily seller trendline", value: lD.seller.next } : null, lD.buyer && !lD.buyer.broken ? { label: "Daily buyer trendline", value: lD.buyer.next } : null].filter(Boolean) as any[];
    const lad = (ref: number) => TV.ladder({ daily: daily as any, sessionDay: N, today: { high: null, low: null }, lines: lineLv, chain: [], spot: ref, atr: a });
    const next = m15.get(N)!;
    const pb: any = TV.anchoredPlans({ levels: lad(close), spot: close, prevClose: close, todays15: [], atr: a, chain: [], expiry: null, events: [], levelsAt: lad, open: { price: next[0].open, time: next[0].time } });
    B.days++; if (pb.anchor?.rolls?.length) B.reanchored++;
    let done = false;
    for (let j = 0; j < next.length && !done; j++) {
      if (mn(next[j].time) >= 900) break;   // no new entry after 15:00
      for (const [p, s] of [[pb.bull, 1], [pb.bear, -1]] as const) {
        if (!p || done || s * (next[j].close - p.entry) < 0) continue;
        if (s * (next[j].close - p.t1) >= 0) { B.missed++; done = true; continue; }   // live rule: close already past Target 1 = MISSED, no entry
        B.triggered++; const entry = next[j].close; let res = "TIME", exit = next[next.length - 1].close;
        for (let k = j + 1; k < next.length; k++) {
          if (mn(next[k].time) >= 912) { exit = next[k - 1].close; break; }
          if (s * (next[k].high * (s > 0 ? 1 : 0) + next[k].low * (s < 0 ? 1 : 0) - p.t1) >= 0) { res = "T1"; exit = p.t1; break; }
          if (s * (next[k].close - p.stop) < 0) { res = "STOP"; exit = next[k].close; break; }
        }
        if (res === "T1") B.t1++; else if (res === "STOP") B.stop++; else B.time++;
        B.pts.push(Math.round(s * (exit - entry) * 10) / 10); done = true;
      }
    }
    if (!done) B.noTrigger++;
  }
  const s = [...B.pts].sort((x, y) => x - y);
  report[name] = { sessions: days.length, A, B: { ...B, pts: undefined, wins: B.pts.filter((x) => x > 0).length, avgPts: B.pts.length ? Math.round(B.pts.reduce((x, y) => x + y, 0) / B.pts.length * 10) / 10 : null, medianPts: s.length ? s[Math.floor(s.length / 2)] : null, totalPts: Math.round(B.pts.reduce((x, y) => x + y, 0)) } };
}
console.log(JSON.stringify(report, null, 1));
