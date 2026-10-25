// ============================ C4 LIVE FEED — data for premium/c4Live.c4Scan (NIFTY + SENSEX) ============================
// Previous sessions: the research 1-minute cache (data/research-nifty20, data/research-multi — refreshed daily at 15:50),
// i.e. the SAME data the C4 rule was tested on, so the owner levels and ATR match the research exactly.
// The scanned session: Dhan /charts/intraday 1-minute — the index (closes) and, only for a strike that has a confirmed
// fake-up at an owner level, that strike's ATM CE (with open interest) and PE. Information only.
import fs from "fs";
import path from "path";
import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import { lookupDhanSecurity, lookupDhanOption } from "../data/dhanInstruments";
import { assemble } from "../research/nifty20/data";
import { assembleIndex } from "../research/multiIndex/data";
import { latestRawDay } from "../research/protrader/dataRange";
import { c4Scan, C4Day, C4Leg, C4Signal, C4Watch } from "./c4Live";

export const C4_INDEX: Record<string, { name: "NIFTY" | "SENSEX"; step: number; lot: number }> = {
  "^NSEI": { name: "NIFTY", step: 50, lot: 75 }, "^BSESN": { name: "SENSEX", step: 100, lot: 20 },
};
/** The tested record (research/protrader/RESULTS_C4_AUDIT.md, corrected cost model B, 2024-10-14 → 2026-10-23, 1 lot). */
export const C4_RECORD = {
  period: "2024-10-14 → 2026-10-23", source: "RESULTS_C4_AUDIT.md (corrected costs)",
  all: { trades: 298, winPct: 56.0, net: 246, netCons: 136, pf: 1.43, pfCons: 1.22 },
  NIFTY: { trades: 141, winPct: 55.3, net: 275, netCons: 219 }, SENSEX: { trades: 157, winPct: 56.7, net: 220, netCons: 62 },
  caveat: "First year negative; the later period was also used to choose the rule — a positive result, not a proven edge.",
};

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

/** Previous sessions (< `day`) from the research cache, oldest first. */
export function priorSessions(name: "NIFTY" | "SENSEX", day: string): C4Day[] {
  const from = new Date(Date.parse(day + "T00:00:00Z") - 62 * 86400_000), m0 = `${from.toISOString().slice(0, 7)}-01`;   // month chunks start on the 1st
  // the month files are named <from>_<to of the latest download>, so ask up to the latest downloaded day, then keep < day
  const to = latestRawDay(), raw = name === "NIFTY" ? assemble(m0, to).days : assembleIndex("SENSEX", m0, to);
  return raw.filter((d) => d.day < day).map((d) => ({ day: d.day, mins: [...d.spot.entries()] }));
}

async function intraday1m(securityId: string, exchangeSegment: string, instrument: string, day: string, oi: boolean) {
  const cfg = loadDhanConfig(); if (!cfg.accessToken) throw new Error("Dhan not connected");
  const r = await dhanFetch("/charts/intraday", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
    body: { securityId, exchangeSegment, instrument, interval: "1", ...(oi ? { oi: true } : {}), fromDate: day, toDate: addDays(day, 1) } });
  if (!r.ok) throw new Error(`Dhan intraday ${r.status}`);
  const j: any = await r.json(), ts: number[] = j?.timestamp || [];
  return ts.map((t, i) => ({ t, c: Number(j.close?.[i]), oi: j.open_interest?.[i] != null ? Number(j.open_interest[i]) : null })).filter((x) => x.c > 0 && istDay(x.t) === day);
}

export interface C4Result {
  available: boolean; reason?: string; symbol: string; index: string; day: string; live: boolean; expiry?: string | null;
  signals: (C4Signal & { pe: string | null })[]; watch: C4Watch[]; ownerLevels: number[]; lastClose: number | null;
  priorTo: string | null; record: typeof C4_RECORD; paper: any; checkedAt: number;
}

/** C4 for one index and one session (today by default). `expiryFor(day)` = the nearest weekly expiry on/after the day. */
export async function c4For(symbol: string, day: string | null, expiryFor: (day: string) => Promise<string | null>): Promise<C4Result> {
  const meta = C4_INDEX[symbol], now = Math.floor(Date.now() / 1000), today = istDay(now), d = day || today, live = d === today;
  const base: C4Result = { available: false, symbol, index: meta?.name || symbol, day: d, live, signals: [], watch: [], ownerLevels: [], lastClose: null, priorTo: null, record: C4_RECORD, paper: paperSummary(), checkedAt: now };
  if (!meta) return { ...base, reason: "C4 is tested on NIFTY and SENSEX only" };
  const prior = priorSessions(meta.name, d); base.priorTo = prior.length ? prior[prior.length - 1].day : null;
  if (prior.length < 6) return { ...base, reason: "previous sessions missing in the research cache" };
  const sec = await lookupDhanSecurity(meta.name === "NIFTY" ? "NIFTY" : "SENSEX"); if (!sec) return { ...base, reason: "index not in the Dhan scrip master" };
  const spot = await intraday1m(sec.securityId, sec.exchangeSegment, "INDEX", d, false);
  if (!spot.length) return { ...base, available: true, reason: live ? "no session data yet today" : "no session data for this day" };
  const todayDay: C4Day = { day: d, mins: spot.map((x) => [x.t, x.c]) };
  // pass 1 without option data → the strikes that need it; pass 2 with those strikes' 1-min CE (OI) and PE
  const first = c4Scan(prior, todayDay, meta.step, () => null, now);
  const need = [...new Set(first.watch.filter((w) => w.reason === "no ATM call OI data").map((w) => w.atm))];
  const expiry = need.length ? await expiryFor(d) : null, legs = new Map<string, Map<number, C4Leg>>();
  for (const strike of need) for (const side of ["CE", "PE"] as const) {
    const o = expiry ? await lookupDhanOption(meta.name, side, strike, expiry) : null; if (!o) continue;
    const rows = await intraday1m(o.securityId, o.exchangeSegment, "OPTIDX", d, side === "CE").catch(() => []);
    legs.set(`${strike}${side}`, new Map(rows.map((x) => [x.t, { c: x.c, oi: x.oi }])));
  }
  const r = need.length ? c4Scan(prior, todayDay, meta.step, (s, side, t) => legs.get(`${s}${side}`)?.get(t) ?? null, now) : first;
  return { ...base, available: true, expiry, ownerLevels: r.owner, lastClose: r.lastClose, watch: r.watch,
    signals: r.signals.map((s) => ({ ...s, pe: expiry ? `${meta.name} ${s.atm} PE ${expiry}` : null })) };
}

/** The live paper record (fakeUpPaper.ts writes data/paper-fakeup.json after each session, from 26 Oct 2026). */
export function paperSummary(): any {
  try { const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "paper-fakeup.json"), "utf8")); return { from: j.from, dataTo: j.dataTo, board: j.board, signals: (j.signals || []).length }; }
  catch { return null; }
}
