import fs from "fs";
import path from "path";
import { FO_DIR, IDX_DIR } from "./download";

// ============================ Next-day study — load the NSE daily files (research only) ============================

export interface IdxBar { day: string; o: number; h: number; l: number; c: number }
export interface Leg { expiry: string; strike: number; side: "CE" | "PE"; o: number; h: number; l: number; c: number; settle: number; oi: number; chgOi: number; vol: number }
export interface Session { day: string; nifty: IdxBar; vix: IdxBar | null; legs: Map<string, Leg>; expiries: string[] }
export const legKey = (expiry: string, strike: number, side: string) => `${expiry}|${strike}|${side}`;

const num = (s: string) => { const v = Number(String(s ?? "").replace(/"/g, "")); return Number.isFinite(v) ? v : NaN; };

export function parseIdx(csv: string): { nifty: IdxBar | null; vix: IdxBar | null } {
  let nifty: IdxBar | null = null, vix: IdxBar | null = null;
  for (const l of csv.split("\n").slice(1)) {
    const c = l.split(","); const name = (c[0] || "").replace(/"/g, "").trim().toLowerCase();
    const [dd, mm, yy] = (c[1] || "").replace(/"/g, "").split("-");
    const bar = { day: `${yy}-${mm}-${dd}`, o: num(c[2]), h: num(c[3]), l: num(c[4]), c: num(c[5]) };
    if (!(bar.c > 0)) continue;
    if (name === "nifty 50") nifty = bar; else if (name === "india vix") vix = bar;
  }
  return { nifty, vix };
}
export function parseFo(csv: string): { legs: Map<string, Leg>; expiries: string[] } {
  const L = csv.split("\n"), h = L[0].split(","), ix = (k: string) => h.indexOf(k), legs = new Map<string, Leg>(), ex = new Set<string>();
  const I = { tp: ix("FinInstrmTp"), x: ix("XpryDt"), k: ix("StrkPric"), s: ix("OptnTp"), o: ix("OpnPric"), h: ix("HghPric"), l: ix("LwPric"), c: ix("ClsPric"), st: ix("SttlmPric"), oi: ix("OpnIntrst"), d: ix("ChngInOpnIntrst"), v: ix("TtlTradgVol") };
  for (const l of L.slice(1)) {
    const c = l.split(","); if (c[I.tp] !== "IDO") continue;
    const side = c[I.s] as "CE" | "PE", strike = num(c[I.k]), expiry = c[I.x];
    if ((side !== "CE" && side !== "PE") || !(strike > 0)) continue;
    ex.add(expiry);
    legs.set(legKey(expiry, strike, side), { expiry, strike, side, o: num(c[I.o]), h: num(c[I.h]), l: num(c[I.l]), c: num(c[I.c]), settle: num(c[I.st]), oi: num(c[I.oi]), chgOi: num(c[I.d]), vol: num(c[I.v]) });
  }
  return { legs, expiries: [...ex].sort() };
}
/** Every day with both files, oldest first. */
export function loadSessions(): Session[] {
  const out: Session[] = [];
  const days = fs.existsSync(FO_DIR) ? fs.readdirSync(FO_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).map((f) => f.slice(0, 10)).sort() : [];
  for (const day of days) {
    let ic: string; try { ic = fs.readFileSync(path.join(IDX_DIR, `${day}.csv`), "utf8"); } catch { continue; }
    const { nifty, vix } = parseIdx(ic); if (!nifty || nifty.day !== day) continue;
    const { legs, expiries } = parseFo(fs.readFileSync(path.join(FO_DIR, `${day}.csv`), "utf8"));
    out.push({ day, nifty, vix, legs, expiries });
  }
  return out;
}
