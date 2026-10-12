import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";
import { parseConstituents } from "./sectorHeatmap";

// ============================ NIFTY 50 ESTIMATED CONTRIBUTION MODEL ============================
// NSE's official free-float index weights are not available to this app (nseindia.com refuses
// automated requests; the archive constituent list carries no weights). Instead each stock's
// SHORT-TERM SENSITIVITY COEFFICIENT is estimated from NIFTY's own 5-minute moves:
//   NIFTY 5-min return ≈ Σ coefᵢ × stockᵢ 5-min return      (non-negative least squares)
// These coefficients are an ESTIMATE, not official constituent weights, and are labelled so on
// screen. They are only used while the walk-forward validation passes its pre-set rule
// (≥ 20 unseen sessions; median |error| ≤ 12 pts and p90 ≤ 30 pts for both the opening gap and
// the intraday move). First study, 12 Oct 2026, 31 unseen sessions: gap 2.0 / 5.2 pts,
// intraday 2.3 / 7.2 pts (median / p90), coefficients stable (HDFCBANK 10.17 ± 0.29 %).
//
// Like-for-like prices only: last traded values. The index's last 5-minute bar (15:25) carries
// NSE's official closing calculation (last-30-minute average), so bars after 15:20 are excluded.

export const MODEL_VERSION = "contrib-nnls-v1";
export const FIT_WINDOW_DAYS = 10;
export const PASS_RULE = { minSessions: 20, medianPts: 12, p90Pts: 30 };

export type Bar = [number, number, number];   // [time, open, close]
export interface ModelFile {
  version: string; fittedAt: number; trainedOn: string[]; coefs: Record<string, number>;
  validation: { sessions: number; gapMedian: number; gapP90: number; intraMedian: number; intraP90: number; pass: boolean; testedFrom: string; testedTo: string; byType: Record<string, { n: number; intraMedian: number }> } | null;
  constituents: string[];
}

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istHm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const sessionBars = (bars: Bar[], d: string) => bars.filter((x) => istDay(x[0]) === d && istHm(x[0]) <= "15:20");

/** Rows of within-session consecutive 5-min returns where every series has both bars. */
export function returnRows(index: Bar[], stocks: Record<string, Bar[]>, days: string[]): { X: number[][]; y: number[] } {
  const syms = Object.keys(stocks);
  const maps = syms.map((s) => new Map(stocks[s].map((b) => [b[0], b[2]])));
  const X: number[][] = [], y: number[] = [];
  for (const d of days) {
    const nb = sessionBars(index, d);
    for (let i = 1; i < nb.length; i++) {
      const t0 = nb[i - 1][0], t1 = nb[i][0]; const row: number[] = []; let ok = true;
      for (const m of maps) { const a = m.get(t0), b = m.get(t1); if (a == null || b == null || !(a > 0)) { ok = false; break; } row.push(b / a - 1); }
      if (ok) { X.push(row); y.push(nb[i][2] / nb[i - 1][2] - 1); }
    }
  }
  return { X, y };
}

/** Non-negative least squares by projected gradient (n ≈ 50; deterministic). */
export function nnls(X: number[][], y: number[], iters = 8000): number[] {
  const n = X[0]?.length || 0; if (!n) return [];
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (let i = 0; i < X.length; i++) for (let p = 0; p < n; p++) { b[p] += X[i][p] * y[i]; for (let q = p; q < n; q++) A[p][q] += X[i][p] * X[i][q]; }
  for (let p = 0; p < n; p++) for (let q = 0; q < p; q++) A[p][q] = A[q][p];
  const L = A.reduce((m, r) => Math.max(m, r.reduce((s, v) => s + Math.abs(v), 0)), 0) || 1;
  let w = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) { const g = A.map((r) => r.reduce((s, v, q) => s + v * w[q], 0)); w = w.map((v, p) => Math.max(0, v - (g[p] - b[p]) / L)); }
  return w;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const p90 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : NaN; };

/** Walk-forward: fit on the previous FIT_WINDOW_DAYS sessions, test the next one (never seen). */
export function walkForward(index: Bar[], stocks: Record<string, Bar[]>): ModelFile["validation"] {
  const days = [...new Set(index.map((b) => istDay(b[0])))].sort();
  const syms = Object.keys(stocks);
  const errs: { d: string; gap: number; intra: number; type: string[] }[] = [];
  const ranges: number[] = [];
  for (let k = FIT_WINDOW_DAYS; k < days.length; k++) {
    const d = days[k], prev = days[k - 1];
    const { X, y } = returnRows(index, stocks, days.slice(k - FIT_WINDOW_DAYS, k)); if (X.length < 100) continue;
    const w = nnls(X, y);
    const np = sessionBars(index, prev), nd = sessionBars(index, d); if (!np.length || !nd.length) continue;
    const nPrev = np[np.length - 1][2], nOpen = nd[0][1], nLast = nd[nd.length - 1][2];
    let gap = 0, intra = 0, ok = true;
    syms.forEach((s, i) => { const sp = sessionBars(stocks[s], prev), sd = sessionBars(stocks[s], d); if (!sp.length || !sd.length) { ok = false; return; }
      gap += w[i] * (sd[0][1] / sp[sp.length - 1][2] - 1); intra += w[i] * (sd[sd.length - 1][2] / sd[0][1] - 1); });
    if (!ok) continue;
    const closes = nd.map((b) => b[2]); const range = Math.max(...closes) - Math.min(...closes); ranges.push(range);
    const type: string[] = [];
    if (Math.abs(nOpen - nPrev) / nPrev > 0.005) type.push("gap");
    if (new Date(d + "T00:00:00Z").getUTCDay() === 2) type.push("expiry");   // NIFTY weekly expiry: Tuesday
    errs.push({ d, gap: Math.abs(gap * nPrev - (nOpen - nPrev)), intra: Math.abs(intra * nOpen - (nLast - nOpen)), type });
    (errs[errs.length - 1] as any).range = range;
  }
  if (!errs.length) return null;
  const medRange = median(ranges);
  for (const e of errs) if ((e as any).range > 1.5 * medRange) e.type.push("volatile");
  const g = errs.map((e) => e.gap), i = errs.map((e) => e.intra);
  const byType: Record<string, { n: number; intraMedian: number }> = {};
  for (const t of ["gap", "expiry", "volatile"]) { const s = errs.filter((e) => e.type.includes(t)); if (s.length) byType[t] = { n: s.length, intraMedian: Math.round(median(s.map((e) => e.intra)) * 10) / 10 }; }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const v = { sessions: errs.length, gapMedian: r1(median(g)), gapP90: r1(p90(g)), intraMedian: r1(median(i)), intraP90: r1(p90(i)), testedFrom: errs[0].d, testedTo: errs[errs.length - 1].d, byType, pass: false };
  v.pass = v.sessions >= PASS_RULE.minSessions && v.gapMedian <= PASS_RULE.medianPts && v.gapP90 <= PASS_RULE.p90Pts && v.intraMedian <= PASS_RULE.medianPts && v.intraP90 <= PASS_RULE.p90Pts;
  return v;
}

/** Fit on the latest FIT_WINDOW_DAYS sessions and attach the walk-forward validation. */
export function buildModel(index: Bar[], stocks: Record<string, Bar[]>, nowSec: number): ModelFile {
  const days = [...new Set(index.map((b) => istDay(b[0])))].sort();
  const train = days.slice(-FIT_WINDOW_DAYS);
  const { X, y } = returnRows(index, stocks, train);
  const w = nnls(X, y);
  const syms = Object.keys(stocks);
  return { version: MODEL_VERSION, fittedAt: nowSec, trainedOn: train, coefs: Object.fromEntries(syms.map((s, i) => [s, w[i]])), validation: walkForward(index, stocks), constituents: syms };
}

export interface Contribution { symbol: string; pct: number; points: number; coef: number }
/** Per-stock contribution (index points) = coef × stock % move × index reference / 100. */
export function contributions(model: ModelFile, moves: Record<string, number | null>, indexRef: number): { rows: Contribution[]; explained: number } {
  const rows: Contribution[] = [];
  for (const [s, c] of Object.entries(model.coefs)) {
    const pct = moves[s]; if (pct == null || !Number.isFinite(pct)) continue;
    rows.push({ symbol: s, pct, coef: c, points: Math.round(((c * pct) / 100) * indexRef * 10) / 10 });
  }
  rows.sort((a, b) => b.points - a.points);
  return { rows, explained: Math.round(rows.reduce((a, r) => a + r.points, 0) * 10) / 10 };
}

// ---- storage + weekly refit (background only; never at request time) ----
const FILE = path.join(DATA_DIR, "sentiment", "nifty-contribution-model.json");
export function readModel(): ModelFile | null { try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return null; } }
function saveModel(m: ModelFile): void { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(m)); } catch { /* best-effort */ } }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export async function nifty50List(): Promise<string[]> {
  const r = await fetch("https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv", { headers: { "User-Agent": UA } as any, signal: AbortSignal.timeout(10000) });
  const list = r.ok ? parseConstituents(await r.text()) : [];
  if (list.length < 45) throw new Error("NIFTY 50 constituent list unavailable");
  return list;
}

/** Refit when the stored model is older than 7 days (or missing). getCandles = provider candles. */
export async function refreshModelIfDue(getCandles: (sym: string, days: number) => Promise<any[]>, force = false): Promise<ModelFile | null> {
  const cur = readModel();
  if (!force && cur && Date.now() / 1000 - cur.fittedAt < 7 * 86400) return cur;
  const syms = await nifty50List();
  const toBars = (c: any[]): Bar[] => (c || []).map((x) => [x.time, x.open, x.close]);
  const index = toBars(await getCandles("^NSEI", 60));
  const stocks: Record<string, Bar[]> = {};
  for (const s of syms) stocks[s] = toBars(await getCandles(s + ".NS", 60));
  const m = buildModel(index, stocks, Math.floor(Date.now() / 1000));
  saveModel(m);
  return m;
}
