// Historical option data for the Trade Decision layer (read-only research).
// Source: Dhan v2 POST /charts/rollingoption — per-bar OHLC + IV + OI + volume
// for the near expiry at ATM±N strike offsets, INCLUDING expired contracts. It
// goes through the shared dhanClient (auth, rate-limit gate, allowlist). The API
// does not return the expiry date, so expiry (for time-to-expiry) is DERIVED
// from the exchange rule in OPTION_EXPIRY_RULE and labelled as such.
// Never fabricates: a bar with no premium is skipped; IV <= 0 is "missing".

import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { INDEX_MASTER, OPTION_EXPIRY_RULE } from "./config";
import { IndexKey } from "./types";

export interface OptBar {
  time: number; strike: number; offset: number; side: "CE" | "PE";
  open: number; high: number; low: number; close: number;
  iv: number | null;      // percent, as published
  oi: number | null; volume: number | null; spot: number | null;
  expiry: string;         // derived (see header)
}

export interface OptionSeries {
  status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  note: string;
  byTime: Map<number, { CE: OptBar[]; PE: OptBar[] }>;
  byContract: Map<string, Map<number, OptBar>>;   // `${expiry}|${side}|${strike}` -> time -> bar
  expiryByDate: Map<string, string>;
  expirySource: string;
}

const DAY = 86_400_000;
const CHUNK_DAYS = 28;
const istDate = (sec: number) => new Date(sec * 1000 + 19800000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();

export const contractKey = (expiry: string, side: "CE" | "PE", strike: number) => `${expiry}|${side}|${strike}`;

/**
 * Expiry for a session date from the exchange rule. A computed expiry that falls
 * on a known non-trading day (inside the fetched window) is shifted back to the
 * previous trading day, as the exchange does for holidays.
 */
export function deriveExpiry(date: string, rule: { flag: "WEEK" | "MONTH"; weekday: number }, tradingDates: Set<string>, lastKnown: string): string {
  let exp: string;
  if (rule.flag === "WEEK") {
    exp = date;
    while (weekday(exp) !== rule.weekday) exp = addDays(exp, 1);
  } else {
    const lastOfMonth = (d: string) => {
      const [y, m] = d.split("-").map(Number);
      let x = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      while (weekday(x) !== rule.weekday) x = addDays(x, -1);
      return x;
    };
    exp = lastOfMonth(date);
    if (exp < date) exp = lastOfMonth(addDays(date.slice(0, 8) + "01", 32));
  }
  if (exp <= lastKnown) {
    let guard = 0;
    while (!tradingDates.has(exp) && exp > date && guard++ < 6) exp = addDays(exp, -1);
  }
  return exp;
}

async function fetchRolling(body: Record<string, unknown>): Promise<any> {
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) throw new Error("Dhan not connected (no access token).");
  const res = await dhanFetch("/charts/rollingoption", { method: "POST", body, accessToken: cfg.accessToken, clientId: cfg.clientId });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Dhan /charts/rollingoption ${res.status}: ${txt.slice(0, 160)}`);
  }
  return res.json();
}

const num = (x: any): number | null => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));

/**
 * Fetch the rolling option slice (ATM-N..ATM+N, CE and PE) for the given session
 * dates. intervalMin must be Dhan-native (1/5/15/25/60).
 */
export async function fetchOptionSeries(index: IndexKey, intervalMin: number, dates: string[], offsets: number): Promise<OptionSeries> {
  const empty = (status: OptionSeries["status"], note: string): OptionSeries => ({ status, note, byTime: new Map(), byContract: new Map(), expiryByDate: new Map(), expirySource: "none" });
  if (!dates.length) return empty("UNAVAILABLE", "no session dates");
  if (![1, 5, 15, 25, 60].includes(intervalMin)) return empty("UNAVAILABLE", `rolling options not available at ${intervalMin}m`);
  const m = INDEX_MASTER[index];
  const sec = await lookupDhanSecurity(m.nseSymbol);
  if (!sec) return empty("UNAVAILABLE", `no Dhan index security for ${m.nseSymbol}`);
  const rule = OPTION_EXPIRY_RULE[index];
  const tradingDates = new Set(dates);
  const sorted = [...dates].sort();
  const lastKnown = sorted[sorted.length - 1];
  const expiryByDate = new Map(sorted.map((d) => [d, deriveExpiry(d, rule, tradingDates, lastKnown)]));

  const out: OptionSeries = {
    status: "UNAVAILABLE", note: "", byTime: new Map(), byContract: new Map(), expiryByDate,
    expirySource: `derived: ${rule.flag === "WEEK" ? "weekly" : "monthly"} weekday ${rule.weekday} rule, holiday-shifted`,
  };
  const failures: string[] = [];
  let calls = 0, ok = 0;
  for (let from = sorted[0]; from <= lastKnown; from = addDays(from, CHUNK_DAYS)) {
    const toExclusive = addDays(from, CHUNK_DAYS) <= addDays(lastKnown, 1) ? addDays(from, CHUNK_DAYS) : addDays(lastKnown, 1);
    for (const side of ["CE", "PE"] as const) {
      for (let k = -offsets; k <= offsets; k++) {
        const strikeLabel = k === 0 ? "ATM" : k > 0 ? `ATM+${k}` : `ATM${k}`;
        calls++;
        try {
          const j = await fetchRolling({
            exchangeSegment: m.futSegment, interval: String(intervalMin), securityId: Number(sec.securityId),
            instrument: "OPTIDX", expiryFlag: rule.flag, expiryCode: 1, strike: strikeLabel,
            drvOptionType: side === "CE" ? "CALL" : "PUT",
            requiredData: ["open", "high", "low", "close", "iv", "volume", "strike", "oi", "spot"],
            fromDate: from, toDate: toExclusive,
          });
          const d = side === "CE" ? j?.data?.ce : j?.data?.pe;
          const ts: any[] = d?.timestamp || [];
          if (!ts.length) { failures.push(`${side} ${strikeLabel} ${from}: empty`); continue; }
          ok++;
          for (let i = 0; i < ts.length; i++) {
            const t = Number(ts[i]); const time = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
            const date = istDate(time);
            if (!tradingDates.has(date)) continue;
            const close = num(d.close?.[i]); const strike = num(d.strike?.[i]);
            if (close == null || close <= 0 || strike == null || strike <= 0) continue;
            const iv = num(d.iv?.[i]);
            const bar: OptBar = {
              time, strike, offset: k, side,
              open: num(d.open?.[i]) ?? close, high: num(d.high?.[i]) ?? close, low: num(d.low?.[i]) ?? close, close,
              iv: iv != null && iv > 0 ? iv : null, oi: num(d.oi?.[i]), volume: num(d.volume?.[i]), spot: num(d.spot?.[i]),
              expiry: expiryByDate.get(date) as string,
            };
            const slot = out.byTime.get(time) || { CE: [], PE: [] };
            slot[side].push(bar); out.byTime.set(time, slot);
            const ck = contractKey(bar.expiry, side, strike);
            const cm = out.byContract.get(ck) || new Map<number, OptBar>();
            cm.set(time, bar); out.byContract.set(ck, cm);
          }
        } catch (e: any) { failures.push(`${side} ${strikeLabel} ${from}: ${String(e?.message || e).slice(0, 80)}`); }
      }
    }
  }
  for (const slot of out.byTime.values()) { slot.CE.sort((a, b) => a.strike - b.strike); slot.PE.sort((a, b) => a.strike - b.strike); }
  out.status = ok === 0 ? "UNAVAILABLE" : ok < calls ? "PARTIAL" : "AVAILABLE";
  out.note = `${ok}/${calls} rolling-option requests returned data` + (failures.length ? `; failures: ${failures.slice(0, 4).join(" | ")}` : "");
  return out;
}
