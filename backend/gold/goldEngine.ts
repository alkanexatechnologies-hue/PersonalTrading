// ============================ GOLD DESK — pure calculations (no network) ============================
// MCX gold (GOLDM 100 g / GOLD 1 kg) futures and options on futures. Everything here is deterministic and unit-tested.
// Information only: no tested gold trading rule exists yet, so the screen's signal is always WAIT.
import fs from "fs";
import path from "path";

export type GoldUnd = "GOLDM" | "GOLD";
export const GOLD_SPEC: Record<GoldUnd, { mult: number; label: string; grams: string; step: number }> = {
  GOLDM: { mult: 10, label: "Gold Mini", grams: "100 g", step: 500 },     // premium / price per 10 g × 10 = ₹ per lot
  GOLD: { mult: 100, label: "Gold", grams: "1 kg", step: 500 },
};

export interface GoldContract { securityId: string; und: GoldUnd; kind: "FUT" | "CE" | "PE"; expiry: string; strike: number | null; name: string }
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; oi?: number | null }

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istMin = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// ---- instruments (Dhan scrip master, MCX rows only) -------------------------------------------------------------------
let _inst: { mtime: number; rows: GoldContract[] } | null = null;
/** GOLD / GOLDM futures (FUTCOM) and options on futures (OPTFUT) from data/dhan_instruments.csv; re-read when the file changes. */
export function goldContracts(file = path.resolve(process.cwd(), "data", "dhan_instruments.csv")): GoldContract[] {
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  if (_inst && _inst.mtime === mtime) return _inst.rows;
  const lines = fs.readFileSync(file, "utf8").split("\n"), h = lines[0].split(","), ix = (n: string) => h.indexOf(n);
  const iEx = ix("EXCH_ID"), iId = ix("SECURITY_ID"), iIn = ix("INSTRUMENT"), iU = ix("UNDERLYING_SYMBOL"), iE = ix("SM_EXPIRY_DATE"), iS = ix("STRIKE_PRICE"), iO = ix("OPTION_TYPE"), iN = ix("DISPLAY_NAME");
  const rows: GoldContract[] = [];
  for (const l of lines) {
    if (!l.startsWith("MCX,")) continue; const c = l.split(",");
    const und = c[iU] as GoldUnd; if (und !== "GOLDM" && und !== "GOLD") continue;
    if (c[iIn] === "FUTCOM") rows.push({ securityId: c[iId], und, kind: "FUT", expiry: c[iE], strike: null, name: c[iN] });
    else if (c[iIn] === "OPTFUT" && (c[iO] === "CE" || c[iO] === "PE")) rows.push({ securityId: c[iId], und, kind: c[iO] as "CE" | "PE", expiry: c[iE], strike: Number(c[iS]), name: c[iN] });
  }
  rows.sort((a, b) => a.expiry.localeCompare(b.expiry) || (a.strike ?? 0) - (b.strike ?? 0));
  _inst = { mtime, rows }; return rows;
}
/** Option expiries on/after `today`, nearest first. */
export function optionExpiries(rows: GoldContract[], und: GoldUnd, today: string): string[] {
  return [...new Set(rows.filter((r) => r.und === und && r.kind !== "FUT" && r.expiry >= today).map((r) => r.expiry))].sort();
}
/** The futures contract an option expiry settles into: the first future expiring AFTER the option (options expire first). */
export function underlyingFuture(rows: GoldContract[], und: GoldUnd, optExpiry: string): GoldContract | null {
  return rows.find((r) => r.und === und && r.kind === "FUT" && r.expiry > optExpiry) || null;
}
/** The front futures contract to chart: the nearest future still trading on `today`. */
export function frontFuture(rows: GoldContract[], und: GoldUnd, today: string): GoldContract | null {
  return rows.find((r) => r.und === und && r.kind === "FUT" && r.expiry >= today) || null;
}
export function optionAt(rows: GoldContract[], und: GoldUnd, expiry: string, strike: number, side: "CE" | "PE"): GoldContract | null {
  return rows.find((r) => r.und === und && r.kind === side && r.expiry === expiry && r.strike === strike) || null;
}
/** Listed strikes for an expiry (sorted) and the ATM strike for a futures price. */
export function strikesFor(rows: GoldContract[], und: GoldUnd, expiry: string): number[] {
  return [...new Set(rows.filter((r) => r.und === und && r.kind === "CE" && r.expiry === expiry).map((r) => r.strike as number))].sort((a, b) => a - b);
}
export function atmStrike(strikes: number[], px: number): number | null {
  if (!strikes.length) return null; let best = strikes[0]; for (const s of strikes) if (Math.abs(s - px) < Math.abs(best - px)) best = s; return best;
}

// ---- IST session (MCX) ---------------------------------------------------------------------------------------------
/** MCX gold trades 09:00 IST to 23:30 while the US is on summer time, 23:55 otherwise. UK / US clock changes move the
 *  London open and the US data release in IST. */
export function goldSession(nowMs: number) {
  const ist = new Date(nowMs + 19800000), y = ist.getUTCFullYear(), day = Date.UTC(y, ist.getUTCMonth(), ist.getUTCDate());
  const nthSun = (m: number, n: number) => { const d = new Date(Date.UTC(y, m, 1)); return Date.UTC(y, m, 1 + ((7 - d.getUTCDay()) % 7) + (n - 1) * 7); };
  const lastSun = (m: number) => { const d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay()); };
  const ukSummer = day >= lastSun(2) && day < lastSun(9), usSummer = day >= nthSun(2, 2) && day < nthSun(10, 1);
  const close = usSummer ? 23 * 60 + 30 : 23 * 60 + 55, london = ukSummer ? 12 * 60 + 30 : 13 * 60 + 30, usData = usSummer ? 18 * 60 : 19 * 60, comexOpen = usSummer ? 17 * 60 + 50 : 18 * 60 + 50;
  const wd = ist.getUTCDay(), m = ist.getUTCHours() * 60 + ist.getUTCMinutes(), open = wd >= 1 && wd <= 5 && m >= 540 && m < close;
  return { open, nowMin: m, weekday: wd, close, london, usData, comexOpen, usSummer, ukSummer };
}

// ---- levels ------------------------------------------------------------------------------------------------------------
export interface GoldLevel { price: number; label: string; why: string; kind: "R" | "S" | "P" | "N" }
const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
export function emaSeries(bars: Bar[], n: number): number[] { return ema(bars.map((b) => b.close), n); }
/** Session-anchored VWAP for today's bars (volume-weighted typical price); null without volume. */
export function vwapOf(today: Bar[]): number | null {
  let pv = 0, v = 0; for (const b of today) { const vol = b.volume || 0; pv += ((b.high + b.low + b.close) / 3) * vol; v += vol; } return v > 0 ? pv / v : null;
}
/** Levels known for the current session from 5-min futures bars (oldest first): previous session H/L/C, classic pivots,
 *  first-hour (09:00–10:00) H/L once that hour has closed, VWAP and the ₹1,000 round numbers near price. */
export function goldLevels(bars: Bar[], nowSec: number) {
  const days = [...new Set(bars.map((b) => istDay(b.time)))].sort(), lastDay = days[days.length - 1] ?? null;
  const today = bars.filter((b) => istDay(b.time) === lastDay), prevDay = days.length > 1 ? days[days.length - 2] : null, prev = bars.filter((b) => istDay(b.time) === prevDay);
  const out: GoldLevel[] = [], px = bars.length ? bars[bars.length - 1].close : null;
  let pdh: number | null = null, pdl: number | null = null, pdc: number | null = null;
  if (prev.length) {
    pdh = Math.max(...prev.map((b) => b.high)); pdl = Math.min(...prev.map((b) => b.low)); pdc = prev[prev.length - 1].close;
    const pp = (pdh + pdl + pdc) / 3;
    out.push({ price: pdh, label: "PDH", why: "previous session high", kind: "R" }, { price: pdl, label: "PDL", why: "previous session low", kind: "S" }, { price: pdc, label: "PDC", why: "previous session close", kind: "P" },
      { price: 2 * pp - pdl, label: "R1", why: "pivot", kind: "R" }, { price: 2 * pp - pdh, label: "S1", why: "pivot", kind: "S" }, { price: pp, label: "PP", why: "pivot", kind: "P" });
  }
  const fh = today.filter((b) => istMin(b.time) >= 540 && istMin(b.time) < 600 && b.time + 300 <= nowSec);
  const fhDone = today.some((b) => istMin(b.time) >= 600) || (lastDay != null && nowSec >= Date.parse(`${lastDay}T10:00:00+05:30`) / 1000);
  if (fh.length && fhDone) out.push({ price: Math.max(...fh.map((b) => b.high)), label: "First-hour H", why: "09:00–10:00 high", kind: "R" }, { price: Math.min(...fh.map((b) => b.low)), label: "First-hour L", why: "09:00–10:00 low", kind: "S" });
  const vw = vwapOf(today); if (vw != null) out.push({ price: vw, label: "VWAP", why: "session VWAP", kind: "P" });
  if (px != null) for (const r of [Math.floor(px / 1000) * 1000, Math.ceil(px / 1000) * 1000]) if (r !== px) out.push({ price: r, label: `₹${r.toLocaleString("en-IN")}`, why: "round number", kind: "P" });
  const lv = out.map((l) => ({ ...l, price: Math.round(l.price * 100) / 100, kind: l.kind === "P" && px != null ? (l.price > px ? "R" : "S") as "R" | "S" : l.kind }));
  // one row per price (within ₹20): merge labels
  const merged: GoldLevel[] = [];
  for (const l of lv.sort((a, b) => b.price - a.price)) { const m = merged.find((x) => Math.abs(x.price - l.price) <= 20); if (m) { m.label += ` · ${l.label}`; m.why += ` · ${l.why}`; } else merged.push({ ...l }); }
  return { levels: merged, pdh, pdl, pdc, sessionDay: lastDay, prevDay, last: px, vwap: vw };
}

/** A levels-only plan (NOT a tested rule): bull starts at the nearest level above price, stop at the nearest level below,
 *  T1 / T2 at the next levels above; bear is the mirror. rr = reward to T1 ÷ risk to the stop. Null without enough levels. */
export function levelPlan(levels: GoldLevel[], px: number | null) {
  if (px == null) return null;
  const up = levels.filter((l) => l.price > px).sort((a, b) => a.price - b.price), dn = levels.filter((l) => l.price < px).sort((a, b) => b.price - a.price);
  const rr = (start: number, stop: number, t1: number) => Math.round((Math.abs(t1 - start) / Math.max(1e-9, Math.abs(start - stop))) * 100) / 100;
  const bull = up.length >= 2 && dn.length >= 1 ? { start: up[0].price, startAt: up[0].label, stop: dn[0].price, t1: up[1].price, t2: up[2]?.price ?? null, rr: rr(up[0].price, dn[0].price, up[1].price) } : null;
  const bear = dn.length >= 2 && up.length >= 1 ? { start: dn[0].price, startAt: dn[0].label, stop: up[0].price, t1: dn[1].price, t2: dn[2]?.price ?? null, rr: rr(dn[0].price, up[0].price, dn[1].price) } : null;
  return { bull, bear };
}

/** Days and hours until an option expiry (expiry day close per the session rule). */
export function expiryInfo(expiry: string, nowMs: number) {
  const s = goldSession(Date.parse(`${expiry}T12:00:00+05:30`)), closeIst = `${String(Math.floor(s.close / 60)).padStart(2, "0")}:${String(s.close % 60).padStart(2, "0")}`;
  const endMs = Date.parse(`${expiry}T${closeIst}:00+05:30`), daysLeft = Math.ceil((endMs - nowMs) / 86400000);
  return { expiry, daysLeft, nearExpiry: daysLeft <= 2 };
}
