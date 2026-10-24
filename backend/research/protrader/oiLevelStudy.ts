// ProTrader OI LEVEL STUDY — can 15 minutes of option OI tell where the index will REVERT, BREAK or stay SIDEWAYS?
// Pre-registered rules (written before the run; see RESULTS_OI_LEVELS.md):
//   every 15-min close 09:45 … 14:30, using the last 15 minutes of OI on ATM ± 3 strikes (real Dhan 1-min data, ~2 years):
//   CEILING = strike above spot with the most CALL WRITING (call OI ↑ and call premium ↓ over 15 min)
//   FLOOR   = strike below spot with the most PUT WRITING  (put OI ↑ and put premium ↓)
//   writing must be ≥ 2% of that strike's OI 15 min earlier and ≥ MIN_ADD qty, else no level.
//   Outcome over the next 60 minutes (spot, minute data):
//     touch  = price comes within TOUCH pts of the level
//     REVERT = after the first touch, price moves back REV pts before any 15-min close beyond level ± BUF
//     BREAK  = a 15-min close beyond level ± BUF first
//     RANGE HELD (ceiling and floor both present, ≤ MAXW apart) = no 15-min close beyond either ± BUF
//   BASELINE = the same outcome for a level at the SAME distance from spot at every checkpoint, with no OI condition.
// DEVELOPMENT = first ⅔ of sessions, VALIDATION = last ⅓. Usage: npx tsx oiLevelStudy.ts
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const P = {
  NIFTY: { step: 50, TOUCH: 5, REV: 30, BUF: 10, MAXW: 200, MIN_ADD: 50_000 },
  SENSEX: { step: 100, TOUCH: 15, REV: 100, BUF: 30, MAXW: 600, MIN_ADD: 10_000 },
} as const;
const CHECK = Array.from({ length: 20 }, (_, i) => 585 + i * 15);   // 09:45 … 14:30

type Out = "REVERT" | "BREAK" | "NO-TOUCH" | "TIME";
const at = (bars: Min[] | undefined, m: number) => { if (!bars) return null; let v: Min | null = null; for (const b of bars) { const x = mn(b.t); if (x > m) break; if (x >= m - 2) v = b; } return v; };

/** What the index did against one level over the next 60 minutes. dir +1 = level above (ceiling), −1 = below (floor). */
function outcome(path: [number, number][], level: number, dir: 1 | -1, p: typeof P[keyof typeof P]): Out {
  let touched = false;
  for (const [m, px] of path) {
    const closeBucket = (m - 555) % 15 === 14;
    if (!touched && dir * (px - (level - dir * p.TOUCH)) >= 0) touched = true;
    if (closeBucket && dir * (px - (level + dir * p.BUF)) > 0) return "BREAK";
    if (touched && dir * (level - px) >= p.REV) return "REVERT";
  }
  return touched ? "TIME" : "NO-TOUCH";
}
function rangeHeld(path: [number, number][], ceil: number, floor: number, p: typeof P[keyof typeof P]) {
  for (const [m, px] of path) if ((m - 555) % 15 === 14 && (px > ceil + p.BUF || px < floor - p.BUF)) return false;
  return true;
}

function study(name: keyof typeof P, days: DayData[]) {
  const p = P[name], ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3);
  const rows: any[] = [];
  ds.forEach((d, di) => {
    const spot = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).map(([t, px]) => [mn(t), px] as [number, number]);
    const spotAt = (m: number) => { let v: number | null = null; for (const [x, px] of spot) { if (x > m) break; v = px; } return v; };
    for (const m of CHECK) {
      const s = spotAt(m); if (s == null) continue;
      const atm = Math.round(s / p.step) * p.step, path = spot.filter(([x]) => x > m && x <= m + 60 && x <= 925);
      if (path.length < 30) continue;
      let ceil: { k: number; add: number } | null = null, floor: { k: number; add: number } | null = null;
      for (let rel = -3; rel <= 3; rel++) {
        const k = atm + rel * p.step;
        for (const side of ["CE", "PE"] as const) {
          const legs = d.legs.get(`${k}${side}`), a = at(legs, m), b = at(legs, m - 15);
          if (!a || !b || a.oi == null || b.oi == null || !(b.oi > 0)) continue;
          const add = a.oi - b.oi, writing = add > 0 && a.c < b.c && add >= 0.02 * b.oi && add >= p.MIN_ADD;
          if (!writing) continue;
          if (side === "CE" && k > s && (!ceil || add > ceil.add)) ceil = { k, add };
          if (side === "PE" && k < s && (!floor || add > floor.add)) floor = { k, add };
        }
      }
      rows.push({ di, set: di < cut ? "DEV" : "VAL", m, s, path, ceil: ceil?.k ?? null, floor: floor?.k ?? null });
    }
  });
  // outcomes for the OI levels and for SAME-DISTANCE baseline levels (every checkpoint, no OI condition)
  const res: Record<string, Record<string, Record<string, number>>> = {};
  const inc = (set: string, key: string, out: string) => { ((res[set] ||= {})[key] ||= {})[out] = (((res[set] ||= {})[key] ||= {})[out] || 0) + 1; };
  // baseline distributions, cached per (set, distance bucket): a level at the same distance from spot at EVERY checkpoint
  const B = p.step / 5, bk = (d: number) => Math.round(d / B) * B, cache = new Map<string, Record<string, number>>();
  const baseLevel = (set: string, lv: "ceil" | "floor", dist: number) => {
    const key = `${set}|${lv}|${bk(dist)}`; if (cache.has(key)) return cache.get(key)!;
    const o: Record<string, number> = {};
    for (const q of rows) if (q.set === set) { const x = outcome(q.path, lv === "ceil" ? q.s + bk(dist) : q.s - bk(dist), lv === "ceil" ? 1 : -1, p); o[x] = (o[x] || 0) + 1; }
    cache.set(key, o); return o;
  };
  const baseRange = (set: string, up: number, dn: number) => {
    const key = `${set}|R|${bk(up)}|${bk(dn)}`; if (cache.has(key)) return cache.get(key)!;
    const o: Record<string, number> = {};
    for (const q of rows) if (q.set === set) { const x = rangeHeld(q.path, q.s + bk(up), q.s - bk(dn), p) ? "HELD" : "BROKE"; o[x] = (o[x] || 0) + 1; }
    cache.set(key, o); return o;
  };
  // add a baseline distribution as fractions, so each OI case carries weight 1 on both sides of the comparison
  const addFrac = (set: string, key: string, o: Record<string, number>) => { const n = Object.values(o).reduce((a, v) => a + v, 0); if (!n) return; for (const [k, v] of Object.entries(o)) { ((res[set] ||= {})[key] ||= {})[k] = ((res[set][key][k]) || 0) + v / n; } };
  for (const r of rows) {
    if (r.ceil != null) { inc(r.set, "ceil OI", outcome(r.path, r.ceil, 1, p)); addFrac(r.set, "ceil base", baseLevel(r.set, "ceil", r.ceil - r.s)); }
    if (r.floor != null) { inc(r.set, "floor OI", outcome(r.path, r.floor, -1, p)); addFrac(r.set, "floor base", baseLevel(r.set, "floor", r.s - r.floor)); }
    if (r.ceil != null && r.floor != null && r.ceil - r.floor <= p.MAXW) {
      inc(r.set, "range OI", rangeHeld(r.path, r.ceil, r.floor, p) ? "HELD" : "BROKE");
      addFrac(r.set, "range base", baseRange(r.set, r.ceil - r.s, r.s - r.floor));
    }
  }
  return { sessions: ds.length, checkpoints: rows.length, from: ds[0].day, to: ds[ds.length - 1].day, res };
}

if (require.main === module) {
  const to = latestRawDay();
  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
  for (const [name, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) {
    const r = study(name as keyof typeof P, days as DayData[]);
    console.log(`\n${name} ${r.from} → ${r.to} · ${r.sessions} sessions · ${r.checkpoints} checkpoints`);
    for (const set of ["DEV", "VAL"]) {
      const R = r.res[set] || {};
      for (const lv of ["ceil", "floor"]) {
        const o = R[`${lv} OI`] || {}, b = R[`${lv} base`] || {};
        const t = (x: any) => (x.REVERT || 0) + (x.BREAK || 0) + (x.TIME || 0);
        console.log(`  ${set} ${lv.padEnd(5)} OI   n=${String(Object.values(o).reduce((a: number, v: any) => a + v, 0)).padStart(5)} touched ${t(o)} · revert ${pct(o.REVERT || 0, t(o))} · break ${pct(o.BREAK || 0, t(o))}`);
        console.log(`  ${set} ${lv.padEnd(5)} base n=${String(Object.values(b).reduce((a: number, v: any) => a + v, 0)).padStart(5)} touched ${t(b)} · revert ${pct(b.REVERT || 0, t(b))} · break ${pct(b.BREAK || 0, t(b))}`);
      }
      const ro = R["range OI"] || {}, rb = R["range base"] || {};
      console.log(`  ${set} range OI   n=${(ro.HELD || 0) + (ro.BROKE || 0)} held ${pct(ro.HELD || 0, (ro.HELD || 0) + (ro.BROKE || 0))}  |  base held ${pct(rb.HELD || 0, (rb.HELD || 0) + (rb.BROKE || 0))}`);
    }
  }
  process.exit(0);
}
