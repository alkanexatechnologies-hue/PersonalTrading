// ============================ LEARNING FEED — the real Dhan data of one past session for the Learning tab ============================
// Index: Dhan /charts/intraday 1-minute OHLC for the day + the previous session (PDC / PDH / PDL).
// Options: Dhan /charts/rollingoption 1-minute ATM−3 … ATM+3, CE and PE, WITH open interest — the same series as
// Market Command's replay (data/replayPremium.rawFor, cached in data/replay-premium or the research cache), so expired
// contracts work. A strike outside that band falls back to the listed contract (only while it is not expired).
// Every Dhan call runs at LOW priority so the live screens are never delayed. A finished day is cached on disk.
import fs from "fs";
import path from "path";
import { dhanFetch, withDhanPriority } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import { lookupDhanSecurity, lookupDhanOption } from "../data/dhanInstruments";
import { rawFor, REPLAY_INDEX, Raw } from "../data/replayPremium";
import { DATA_DIR } from "../config/dataDir";
import type { LearnIndex } from "./parseTrade";
import type { Bar1, BandLeg } from "./learningEngine";

const IST = 19800;
export const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const SYM: Record<LearnIndex, string> = { NIFTY: "^NSEI", SENSEX: "^BSESN" };
export const LEARN_META: Record<LearnIndex, { step: number; lot: number }> = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } };
const CACHE = path.join(DATA_DIR, "learning-cache");

/** Is the session over (so its data is final and may be cached)? */
export function dayComplete(day: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const today = istDay(nowSec); return day < today || (day === today && mn(nowSec) >= 15 * 60 + 31);
}
function readCache<T>(f: string): T | null { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function writeCache(f: string, v: unknown) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch { /* cache is optional */ } }

async function intraday1m(body: Record<string, unknown>): Promise<Bar1[]> {
  const cfg = loadDhanConfig(); if (!cfg.accessToken) throw new Error("Dhan is not connected");
  const r = await withDhanPriority("low", () => dhanFetch("/charts/intraday", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId, body: { interval: "1", ...body } }));
  if (!r.ok) throw new Error(`Dhan intraday ${r.status}`);
  const j: any = await r.json(), ts: number[] = j?.timestamp || [];
  return ts.map((t, i) => ({ t, o: +j.open[i], h: +j.high[i], l: +j.low[i], c: +j.close[i], oi: j.open_interest?.[i] != null ? +j.open_interest[i] : null }))
    .filter((b) => b.c > 0 && mn(b.t) >= 555 && mn(b.t) < 930);
}

/** Index 1-minute bars of the day + the previous session's high / low / close. */
export async function indexDay(index: LearnIndex, day: string): Promise<{ bars: Bar1[]; prev: { day: string; h: number; l: number; c: number } | null }> {
  const f = path.join(CACHE, index, `${day}_index.json`), hit = readCache<{ bars: Bar1[]; prev: any }>(f); if (hit) return hit;
  const sec = await lookupDhanSecurity(index); if (!sec) throw new Error(`${index} not in the Dhan scrip master`);
  const all = await intraday1m({ securityId: sec.securityId, exchangeSegment: sec.exchangeSegment, instrument: "INDEX", fromDate: addDays(day, -7), toDate: addDays(day, 1) });
  const bars = all.filter((b) => istDay(b.t) === day), before = all.filter((b) => istDay(b.t) < day);
  let prev = null;
  if (before.length) { const pd = istDay(before[before.length - 1].t), pb = before.filter((b) => istDay(b.t) === pd);
    prev = { day: pd, h: Math.max(...pb.map((b) => b.h)), l: Math.min(...pb.map((b) => b.l)), c: pb[pb.length - 1].c }; }
  const out = { bars, prev };
  if (bars.length && dayComplete(day)) writeCache(f, out);
  return out;
}

/** Per-strike 1-minute bars (with OI) of the rolling ATM±3 band, CE and PE. */
export async function bandDay(index: LearnIndex, day: string): Promise<BandLeg[]> {
  const sym = SYM[index], legs = new Map<string, Map<number, Bar1>>();
  for (const side of ["CE", "PE"] as const) for (let rel = -3; rel <= 3; rel++) {
    const raw: Raw | null = await withDhanPriority("low", () => rawFor(sym, day, side, rel, dayComplete(day)));
    if (!raw) continue;
    raw.timestamp.forEach((t, i) => {
      if (istDay(t) !== day || mn(t) < 555 || mn(t) >= 930 || !(raw.close[i] > 0) || !(raw.strike[i] > 0)) return;
      const k = `${raw.strike[i]}${side}`, m = legs.get(k) || new Map<number, Bar1>(); if (m.has(t)) return;
      m.set(t, { t, o: raw.open[i], h: raw.high[i], l: raw.low[i], c: raw.close[i], oi: raw.oi?.[i] ?? null }); legs.set(k, m);
    });
  }
  return [...legs.entries()].map(([k, m]) => ({ strike: Number(k.slice(0, -2)), side: k.slice(-2) as "CE" | "PE", bars: [...m.values()].sort((a, b) => a.t - b.t) }));
}

/** The traded strike when it was outside the rolling band: the listed contract (works only until it expires). */
export async function listedLeg(index: LearnIndex, day: string, strike: number, side: "CE" | "PE", expiry: string | null): Promise<Bar1[]> {
  const f = path.join(CACHE, index, `${day}_${strike}${side}.json`), hit = readCache<Bar1[]>(f); if (hit) return hit;
  if (!expiry) return [];
  const o = await lookupDhanOption(index, side, strike, expiry); if (!o) return [];
  const bars = (await intraday1m({ securityId: o.securityId, exchangeSegment: o.exchangeSegment, instrument: "OPTIDX", oi: true, fromDate: day, toDate: addDays(day, 1) })).filter((b) => istDay(b.t) === day);
  if (bars.length && dayComplete(day)) writeCache(f, bars);
  return bars;
}

export const learningSource = (index: LearnIndex) =>
  `Dhan 1-minute data · index /charts/intraday · options /charts/rollingoption (${REPLAY_INDEX[SYM[index]].flag === "WEEK" ? "nearest weekly" : "nearest monthly"} expiry, ATM±3, with OI)`;
