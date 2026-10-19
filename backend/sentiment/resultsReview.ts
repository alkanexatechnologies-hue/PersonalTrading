// ============================ Company RESULTS REVIEW — last 2 days (Market Sentiment screen) ============================
// Universe: every NSE F&O stock (from the Dhan instrument file). Source of numbers: Yahoo Finance quarterly earnings
// (reported date, EPS actual vs analyst estimate, quarterly revenue and profit) — refreshed in the background every 2 hours.
// Verdict (facts only):
//   GOOD  = EPS beat the estimate by ≥ 2%, or in line (±2%) with profit ≥ +5% AND revenue ≥ 0% vs the previous quarter
//   BAD   = EPS missed by ≥ 2%, or profit ≤ −10% vs the previous quarter
//   MIXED = everything else (including no estimate available)
// Companies outside the universe that reported (from "Results" news headlines, previews and date stories removed) are listed
// separately as NEWS ONLY — headline tone, numbers not checked. Informational, never used for trades.
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config/dataDir";

export type Verdict = "GOOD" | "BAD" | "MIXED";
export interface ResultRow { sym: string; name: string; reportedAt: number; quarter: string; epsActual: number | null; epsEst: number | null; surprisePct: number | null; profit: number | null; profitPrev: number | null; revenue: number | null; revenuePrev: number | null; dayChgPct: number | null }
export function verdict(r: ResultRow): { verdict: Verdict; profitQoQ: number | null; revenueQoQ: number | null; why: string } {
  const pq = r.profit != null && r.profitPrev != null && r.profitPrev !== 0 ? Math.round(((r.profit - r.profitPrev) / Math.abs(r.profitPrev)) * 1000) / 10 : null;
  const rq = r.revenue != null && r.revenuePrev != null && r.revenuePrev !== 0 ? Math.round(((r.revenue - r.revenuePrev) / Math.abs(r.revenuePrev)) * 1000) / 10 : null;
  const s = r.surprisePct, beat = s != null && s >= 2, miss = s != null && s <= -2, inline = s != null && !beat && !miss;
  const why: string[] = [];
  if (s != null) why.push(`EPS ${r.epsActual} vs est ${r.epsEst} (${s >= 0 ? "+" : ""}${s}% ${beat ? "beat" : miss ? "miss" : "in line"})`);
  if (pq != null) why.push(`profit ${pq >= 0 ? "+" : ""}${pq}% QoQ`); if (rq != null) why.push(`revenue ${rq >= 0 ? "+" : ""}${rq}% QoQ`);
  const v: Verdict = beat || (inline && pq != null && pq >= 5 && rq != null && rq >= 0) ? "GOOD" : miss || (pq != null && pq <= -10) ? "BAD" : "MIXED";
  return { verdict: v, profitQoQ: pq, revenueQoQ: rq, why: why.join(" · ") || "no numbers" };
}
/** Start of the "last 2 days" window: the start (IST) of the previous TRADING day — so on Mon/Sun/Sat it reaches Friday. */
export function windowStart(nowMs: number): number {
  const d = new Date(nowMs + 19800000); d.setUTCHours(0, 0, 0, 0);
  let t = d.getTime() - 86400000; while ([0, 6].includes(new Date(t).getUTCDay())) t -= 86400000;
  return Math.floor((t - 19800000) / 1000);
}
const PREVIEW = /preview|expectation|\bdate\b|schedule|this week|next week|monitorable|what to expect|ahead of|to announce|will announce|q[1-4] results today/i;
const REPORTED = /(profit|loss|revenue|nii|ebitda|income|earnings|pat)\b[^.]{0,40}\b(rise|rises|rose|jump|jumps|jumped|surge|surges|soar|up|grow|grows|grew|fall|falls|fell|drop|drops|dropped|slump|slumps|decline|declines|down|plunge|spurts|widens|narrows)/i;
/** Headlines that REPORT results (not previews or date stories). */
export function reportedHeadline(title: string): boolean { return REPORTED.test(title) && !PREVIEW.test(title); }

// ---------------------------------------------------------------- I/O: the 2-hour background refresh
const FILE = path.join(DATA_DIR, "sentiment", "results-review.json");
export function readCache(): { at: number; rows: Record<string, ResultRow> } { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { at: 0, rows: {} }; } }
export function universe(): string[] {
  try {
    const csv = fs.readFileSync(path.join(process.cwd(), "data", "dhan_instruments.csv"), "utf8").split("\n");
    const set = new Set<string>(); for (const l of csv) { const c = l.split(","); if (c[0] === "NSE" && c[4] === "OPTSTK" && c[6]) set.add(c[6]); }
    return [...set].sort();
  } catch { return []; }
}
let busy = false;
export async function refreshResults(): Promise<{ ok: number; failed: number }> {
  if (busy) return { ok: 0, failed: 0 }; busy = true;
  try {
    const YahooFinance = (await import("yahoo-finance2")).default as any, yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
    const syms = universe(), cache = readCache(); let ok = 0, failed = 0, i = 0;
    const one = async (sym: string) => {
      try {
        const r: any = await yf.quoteSummary(`${sym}.NS`, { modules: ["earnings", "price"] }, { validateResult: false });
        const ec = r.earnings?.earningsChart?.quarterly || [], fc = r.earnings?.financialsChart?.quarterly || [], last = ec[ec.length - 1];
        const num = (v: any) => (v == null ? null : typeof v === "object" ? (v.raw ?? null) : Number(v));
        if (!last?.reportedDate) { failed++; return; }
        const f1 = fc[fc.length - 1], f0 = fc[fc.length - 2];
        cache.rows[sym] = { sym, name: r.price?.shortName || sym, reportedAt: Math.floor(new Date(last.reportedDate).getTime() / 1000), quarter: last.fiscalQuarter || last.date || "",
          epsActual: num(last.actual), epsEst: num(last.estimate), surprisePct: last.surprisePct != null ? Number(last.surprisePct) : null,
          profit: num(f1?.earnings), profitPrev: num(f0?.earnings), revenue: num(f1?.revenue), revenuePrev: num(f0?.revenue),
          dayChgPct: r.price?.regularMarketChangePercent != null ? Math.round(r.price.regularMarketChangePercent * 10000) / 100 : null };
        ok++;
      } catch { failed++; }
    };
    await Promise.all(Array.from({ length: 4 }, async () => { while (i < syms.length) { const s = syms[i++]; await one(s); await new Promise((r) => setTimeout(r, 250)); } }));
    cache.at = Math.floor(Date.now() / 1000);
    fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cache));
    return { ok, failed };
  } finally { busy = false; }
}
/** The review for the screen: reported in the last 2 days (universe, with numbers) + news-only companies. */
export function buildReview(nowMs: number, news: { title: string; source: string; ago: string; sentiment: string; tags: string[]; publishedEpoch: number; link: string }[]) {
  const c = readCache(), from = windowStart(nowMs);
  const rows = Object.values(c.rows).filter((r) => r.reportedAt >= from && r.reportedAt <= nowMs / 1000 + 3600)
    .map((r) => ({ ...r, ...verdict(r) })).sort((a, b) => b.reportedAt - a.reportedAt);
  const names = rows.map((r) => r.name.toLowerCase().split(/\s+/)[0]).filter((w) => w.length >= 3);
  const newsOnly = news.filter((n) => n.tags.includes("Results") && n.publishedEpoch >= from && reportedHeadline(n.title) && !names.some((w) => n.title.toLowerCase().includes(w)))
    .slice(0, 12).map((n) => ({ title: n.title, source: n.source, ago: n.ago, tone: n.sentiment, link: n.link }));
  return { refreshedAt: c.at, since: from, rows, newsOnly };
}
