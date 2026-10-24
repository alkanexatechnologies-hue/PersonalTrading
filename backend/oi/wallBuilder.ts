// ============================ Wall Builder — who is writing, where, over 1 / 5 / 15 minutes (pure, no I/O) ============================
// Reads the 1-minute OI log rows (oiMinuteLog.ts STRIKE_HEADER) and, for the latest minute, works out per strike:
//   · the OI change of calls and puts over 1, 5 and 15 minutes and what it was: WRITE (OI ↑ premium ↓), BUY (OI ↑ premium ↑),
//     COVER (OI ↓ premium ↑), UNWIND (OI ↓ premium ↓)
//   · OI added since the first minute of the day, Δ (from the log) and Γ (Black-Scholes from the logged IV)
//   · totals per window (added / removed / net, calls and puts separately) and a positioning read.
// POSITIONING, NOT A FORECAST: a 2-year study (research/protrader/RESULTS_OI_LEVELS.md) found 15-min OI walls revert / break
// no more often than any strike at the same distance. The read says where writers are, never where the index will go.

export type BuildType = "W" | "B" | "SC" | "U" | "-";
export interface LogRow { minute: string; spot: number; strike: number; ceOi: number | null; ceLtp: number | null; ceIv: number | null; ceDelta: number | null; peOi: number | null; peLtp: number | null; peIv: number | null; peDelta: number | null }
export interface WinCell { c: number | null; ct: BuildType; p: number | null; pt: BuildType }
export interface WallRow { strike: number; ceOi: number | null; peOi: number | null; w: Record<"1" | "5" | "15", WinCell>; dayC: number | null; dayP: number | null; ceDelta: number | null; peDelta: number | null; gamma: number | null; read: { side: "UP" | "DN" | "N"; net: number; why: string } }
export interface WallBuilder {
  index: string; day: string; minute: string; spot: number; windows: Record<"1" | "5" | "15", { from: string | null; spotFrom: number | null; minutes: number | null }>;
  rows: WallRow[]; totals: Record<"1" | "5" | "15", { callAdded: number; callRemoved: number; putAdded: number; putRemoved: number }>;
  dayTotals: { calls: number; puts: number }; standing: { call: { strike: number; oi: number }[]; put: { strike: number; oi: number }[] };
  maxGamma: number | null; positioning: { lean: "BULLISH" | "BEARISH" | "NEUTRAL"; callWall: number | null; putWall: number | null; watch: string; note: string };
}

const num = (v: string | undefined) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
/** Parse the strike CSV (header = oiMinuteLog STRIKE_HEADER) into rows. Unknown / short lines are skipped. */
export function parseStrikeCsv(text: string): LogRow[] {
  const lines = text.trim().split("\n"); if (lines.length < 2) return [];
  const h = lines[0].split(","), ix = (k: string) => h.indexOf(k);
  const I = { t: ix("timeIST"), s: ix("spot"), k: ix("strike"), co: ix("ceOi"), cl: ix("ceLtp"), ci: ix("ceIv"), cd: ix("ceDelta"), po: ix("peOi"), pl: ix("peLtp"), pi: ix("peIv"), pd: ix("peDelta") };
  const out: LogRow[] = [];
  for (const l of lines.slice(1)) {
    const c = l.split(","); const s = num(c[I.s]), k = num(c[I.k]); if (!c[I.t] || s == null || k == null) continue;
    out.push({ minute: c[I.t], spot: s, strike: k, ceOi: num(c[I.co]), ceLtp: num(c[I.cl]), ceIv: num(c[I.ci]), ceDelta: num(c[I.cd]), peOi: num(c[I.po]), peLtp: num(c[I.pl]), peIv: num(c[I.pi]), peDelta: num(c[I.pd]) });
  }
  return out;
}

/** OI change + premium change → what the traders did. */
export function buildType(dOi: number | null, dPrem: number | null): BuildType {
  if (dOi == null || dPrem == null || dOi === 0) return "-";
  return dOi > 0 ? (dPrem < 0 ? "W" : "B") : (dPrem > 0 ? "SC" : "U");
}
const mins = (m: string) => +m.slice(0, 2) * 60 + +m.slice(3, 5);
const phi = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
/** Black-Scholes gamma (same for CE and PE). iv in % (as logged), years to expiry. */
export function bsGamma(spot: number, strike: number, ivPct: number | null, years: number): number | null {
  if (!ivPct || ivPct <= 0 || years <= 0 || spot <= 0) return null;
  const iv = ivPct / 100, d1 = (Math.log(spot / strike) + 0.5 * iv * iv * years) / (iv * Math.sqrt(years));
  return phi(d1) / (spot * iv * Math.sqrt(years));
}

/** Per-strike positioning read from the 15-min change (weight 1) and the 5-min change (weight ½). */
export function readStrike(w15: WinCell, w5: WinCell): WallRow["read"] {
  let bull = 0, bear = 0; const why: string[] = [];
  const add = (side: "c" | "p", v: number | null, t: BuildType, wt: number) => {
    if (v == null) return; const a = Math.abs(v) * wt;
    if (side === "c" && t === "W") { bear += a; why.push("calls written"); } else if (side === "c" && t === "SC") { bull += a; why.push("calls covering"); } else if (side === "c" && t === "B") bull += a * 0.5;
    else if (side === "p" && t === "W") { bull += a; why.push("puts written"); } else if (side === "p" && t === "SC") { bear += a; why.push("puts covering"); } else if (side === "p" && t === "B") { bear += a * 0.5; why.push("puts bought"); }
  };
  add("c", w15.c, w15.ct, 1); add("p", w15.p, w15.pt, 1); add("c", w5.c, w5.ct, 0.5); add("p", w5.p, w5.pt, 0.5);
  const net = bull - bear, u = why.filter((x, i) => why.indexOf(x) === i).slice(0, 2);
  return { side: Math.abs(net) < 1e-9 ? "N" : net > 0 ? "UP" : "DN", net, why: u.join(" · ") || "little change" };
}

/** Build the Wall Builder for the latest minute (or `at`) of one day's log. `nStrikes` strikes nearest the spot. */
export function buildWalls(rows: LogRow[], o: { index: string; day: string; expiry?: string | null; at?: string; nStrikes?: number; minNet?: number }): WallBuilder | null {
  if (!rows.length) return null;
  const byMin = new Map<string, Map<number, LogRow>>();
  for (const r of rows) { if (o.at && r.minute > o.at) continue; (byMin.get(r.minute) || byMin.set(r.minute, new Map()).get(r.minute)!).set(r.strike, r); }
  const times = [...byMin.keys()].sort(); if (!times.length) return null;
  const T = times[times.length - 1], cur = byMin.get(T)!, first = byMin.get(times[0])!, spot = [...cur.values()][0].spot;
  const back = (k: number) => { const m = mins(T) - k; let best: string | null = null; for (const t of times) { if (mins(t) <= m) best = t; else break; } return best; };
  const W = { "1": back(1), "5": back(5), "15": back(15) } as Record<"1" | "5" | "15", string | null>;
  const strikes = [...cur.keys()].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, o.nStrikes ?? 13).sort((a, b) => a - b);
  const years = o.expiry ? Math.max(1 / (365 * 24 * 60), (Date.parse(o.expiry + "T10:00:00Z") - Date.parse(o.day + "T00:00:00Z") - (mins(T) - 330) * 60000) / (365 * 24 * 3600 * 1000)) : null;
  const cell = (k: number, from: string | null): WinCell => {
    const a = cur.get(k), b = from ? byMin.get(from)?.get(k) : null;
    if (!a || !b) return { c: null, ct: "-", p: null, pt: "-" };
    const dc = a.ceOi != null && b.ceOi != null ? a.ceOi - b.ceOi : null, dp = a.peOi != null && b.peOi != null ? a.peOi - b.peOi : null;
    return { c: dc, ct: buildType(dc, a.ceLtp != null && b.ceLtp != null ? a.ceLtp - b.ceLtp : null), p: dp, pt: buildType(dp, a.peLtp != null && b.peLtp != null ? a.peLtp - b.peLtp : null) };
  };
  const out: WallRow[] = strikes.map((k) => {
    const a = cur.get(k)!, f = first.get(k), w = { "1": cell(k, W["1"]), "5": cell(k, W["5"]), "15": cell(k, W["15"]) };
    const iv = a.ceIv && a.peIv ? (a.ceIv + a.peIv) / 2 : a.ceIv || a.peIv;
    return { strike: k, ceOi: a.ceOi, peOi: a.peOi, w, dayC: f && f.ceOi != null && a.ceOi != null ? a.ceOi - f.ceOi : null, dayP: f && f.peOi != null && a.peOi != null ? a.peOi - f.peOi : null,
      ceDelta: a.ceDelta, peDelta: a.peDelta, gamma: years != null ? bsGamma(spot, k, iv, years) : null, read: readStrike(w["15"], w["5"]) };
  });
  const sum = (key: "1" | "5" | "15", side: "c" | "p", sign: 1 | -1) => out.reduce((s, r) => { const v = r.w[key][side]; return s + (v == null ? 0 : sign > 0 ? Math.max(0, v) : Math.min(0, v)); }, 0);
  const totals = Object.fromEntries((["1", "5", "15"] as const).map((k) => [k, { callAdded: sum(k, "c", 1), callRemoved: sum(k, "c", -1), putAdded: sum(k, "p", 1), putRemoved: sum(k, "p", -1) }])) as WallBuilder["totals"];
  const top = (side: "ceOi" | "peOi") => out.filter((r) => r[side] != null).sort((a, b) => (b[side] as number) - (a[side] as number)).slice(0, 2).map((r) => ({ strike: r.strike, oi: r[side] as number }));
  const gs = out.map((r) => r.gamma).filter((g): g is number => g != null), maxGamma = gs.length ? Math.max(...gs) : null;
  const minNet = o.minNet ?? 0;
  const callWall = out.filter((r) => r.read.side === "DN" && r.strike >= spot && -r.read.net > minNet).sort((a, b) => a.read.net - b.read.net)[0]?.strike ?? null;
  const putWall = out.filter((r) => r.read.side === "UP" && r.strike <= spot && r.read.net > minNet).sort((a, b) => b.read.net - a.read.net)[0]?.strike ?? null;
  const netAll = out.reduce((s, r) => s + r.read.net, 0);
  const lean = Math.abs(netAll) < 1e-9 ? "NEUTRAL" : netAll > 0 ? "BULLISH" : "BEARISH";
  return {
    index: o.index, day: o.day, minute: T, spot,
    windows: Object.fromEntries((["1", "5", "15"] as const).map((k) => [k, { from: W[k], spotFrom: W[k] ? [...byMin.get(W[k]!)!.values()][0].spot : null, minutes: W[k] ? mins(T) - mins(W[k]!) : null }])) as WallBuilder["windows"],
    rows: out, totals, dayTotals: { calls: out.reduce((s, r) => s + (r.dayC || 0), 0), puts: out.reduce((s, r) => s + (r.dayP || 0), 0) },
    standing: { call: top("ceOi"), put: top("peOi") }, maxGamma,
    positioning: { lean, callWall, putWall,
      watch: callWall != null ? `call covering at ${callWall} or a rejection candle there` : putWall != null ? `put covering at ${putWall} or a rejection candle there` : "no fresh wall in the last 15 minutes",
      note: "Positioning, not a forecast — over 2 years 15-min OI walls reverted / broke no more often than any strike at the same distance." },
  };
}
