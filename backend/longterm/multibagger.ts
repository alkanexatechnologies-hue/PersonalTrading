import YahooFinance from "yahoo-finance2";
import { Multibagger } from "../types";

// Groww only serves ~3 years of daily candles, so for the 10-year multibagger
// view we pull long monthly history from Yahoo (prices only). Cached 24h since
// long-term history barely changes intraday.
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });

const cache = new Map<string, { at: number; data: Multibagger | null }>();
const TTL = 24 * 60 * 60 * 1000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const ym = (d: Date) => d.toISOString().slice(0, 7); // YYYY-MM

function tierOf(x: number): string {
  if (x >= 10) return ">10x";
  if (x >= 5) return "5-10x";
  if (x >= 3) return "3-5x";
  if (x >= 2) return "2-3x";
  return "<2x";
}

export async function getMultibagger(symbol: string): Promise<Multibagger | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await fetchMultibagger(symbol);
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

async function fetchMultibagger(symbol: string): Promise<Multibagger | null> {
  let res: any;
  try {
    res = await yf.chart(symbol, {
      period1: new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000),
      interval: "1mo",
    });
  } catch {
    return null;
  }
  const quotes: any[] = (res?.quotes || []).filter((q: any) => q && q.close != null && q.date);
  if (quotes.length < 12) return null;

  const first = quotes[0];
  const lastQ = quotes[quotes.length - 1];
  const firstClose = Number(first.close);
  const lastClose = Number(lastQ.close);
  if (!(firstClose > 0) || !(lastClose > 0)) return null;

  const years = Math.max(0.5, (new Date(lastQ.date).getTime() - new Date(first.date).getTime()) / (365 * 24 * 3600 * 1000));
  const multiple = round2(lastClose / firstClose);
  const cagrPct = round2((Math.pow(lastClose / firstClose, 1 / years) - 1) * 100);
  const totalReturnPct = round2((multiple - 1) * 100);

  // Biggest low -> high run and WHEN it happened (running-min scan).
  let runMin = firstClose;
  let runMinDate = new Date(first.date);
  let bigMoveX = 1;
  let bigMoveFrom = ym(new Date(first.date));
  let bigMoveTo = ym(new Date(first.date));
  for (const q of quotes) {
    const c = Number(q.close);
    if (c < runMin) {
      runMin = c;
      runMinDate = new Date(q.date);
    }
    const ratio = c / runMin;
    if (ratio > bigMoveX) {
      bigMoveX = ratio;
      bigMoveFrom = ym(runMinDate);
      bigMoveTo = ym(new Date(q.date));
    }
  }
  bigMoveX = round2(bigMoveX);

  const isMultibagger = multiple >= 2 || bigMoveX >= 2;
  const yrsInt = Math.round(years);
  const note = isMultibagger
    ? `${tierOf(multiple)} in ~${yrsInt}y (${cagrPct}% CAGR). Biggest run ${bigMoveX}x from ${bigMoveFrom} to ${bigMoveTo}.`
    : `${multiple}x in ~${yrsInt}y (${cagrPct}% CAGR) - not a multibagger yet.`;

  return {
    years: round2(years),
    multiple,
    cagrPct,
    totalReturnPct,
    bigMoveX,
    bigMoveFrom,
    bigMoveTo,
    isMultibagger,
    tier: tierOf(multiple),
    note,
  };
}
