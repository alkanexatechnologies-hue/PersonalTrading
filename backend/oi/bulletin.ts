import { last, ema, vwap, adx } from "../indicators";
import { detectCandlePattern } from "../signals/candles";
import { CONFIG } from "../config/arbitration";

export type BullDir = "UP" | "DOWN" | "FLAT";

export interface BullSource {
  name: string;
  dir: BullDir;
  detail: string;
}

export interface TfBulletin {
  tf: "5m" | "15m" | "1h";
  use: "SCALP" | "DIRECTIONAL";
  dir: BullDir;
  option: "CE" | "PE" | "—";
  agree: number;
  total: number;
  conf: number;
  barTime: string;
  headline: string;
  sources: BullSource[];
}

function dirOf(n: number): BullDir {
  if (n > 0) return "UP";
  if (n < 0) return "DOWN";
  return "FLAT";
}

function istHm(epochSec: number): string {
  const d = new Date(epochSec * 1000 + 19800000);
  return d.toISOString().slice(11, 16);
}

function readTf(
  tf: TfBulletin["tf"],
  use: TfBulletin["use"],
  candles: any[],
  ctx: {
    oiDir: BullDir;
    fut: string | null;
    pcr: number | null;
    feverSide?: string | null;
    d4Dir?: "Bullish" | "Bearish" | "Neutral" | null;
    hourDir?: "Bullish" | "Bearish" | "Range" | null;
  }
): TfBulletin | null {
  if (!candles || candles.length < 20) return null;
  const c = candles[candles.length - 1];
  const closes = candles.map((x: any) => x.close);
  const price = c.close;
  const sources: BullSource[] = [];
  const votes: number[] = [];

  const bar = c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
  sources.push({ name: "Bar", dir: dirOf(bar), detail: `${c.close >= c.open ? "green" : "red"} ${Math.round(c.close)}` });
  votes.push(bar);

  const vw = last(vwap(candles as any));
  if (vw != null) {
    const v = price > vw ? 1 : price < vw ? -1 : 0;
    sources.push({ name: "VWAP", dir: dirOf(v), detail: `spot ${v >= 0 ? "+" : ""}${Math.round((price - vw) * 10) / 10}` });
    votes.push(v);
  }
  const e9 = last(ema(closes, 9));
  const e21 = last(ema(closes, 21));
  if (e9 != null && e21 != null) {
    const v = e9 > e21 && price > e9 ? 1 : e9 < e21 && price < e9 ? -1 : 0;
    sources.push({ name: "EMA", dir: dirOf(v), detail: v > 0 ? "9>21 stack" : v < 0 ? "9<21 stack" : "mixed" });
    votes.push(v);
  }
  const ax = last(adx(candles as any, 14).adx);
  sources.push({ name: "ADX", dir: "FLAT", detail: ax != null ? String(Math.round(ax * 10) / 10) : "—" });

  const pat = detectCandlePattern(candles as any);
  const pv = (pat.strength || 0) >= 0.5 ? pat.bias : 0;
  sources.push({ name: "Candle", dir: dirOf(pv || pat.bias), detail: pat.pattern });
  if (pv) votes.push(pv);

  const oiV = ctx.oiDir === "UP" ? 1 : ctx.oiDir === "DOWN" ? -1 : 0;
  sources.push({ name: "OI", dir: ctx.oiDir, detail: "session OI-change" });
  votes.push(oiV);

  const fb = (ctx.fut || "").toLowerCase();
  const futV = /long buildup|short covering/.test(fb) ? 1 : /short buildup|long unwinding/.test(fb) ? -1 : 0;
  sources.push({ name: "Fut", dir: dirOf(futV), detail: ctx.fut || "—" });
  votes.push(futV);

  if (ctx.pcr != null) {
    const v = ctx.pcr >= CONFIG.pcr.bullish ? 1 : ctx.pcr <= CONFIG.pcr.bearish ? -1 : 0;
    sources.push({ name: "PCR", dir: dirOf(v), detail: String(ctx.pcr) });
    votes.push(v);
  }

  if (tf === "15m" && ctx.d4Dir) {
    const v = ctx.d4Dir === "Bullish" ? 1 : ctx.d4Dir === "Bearish" ? -1 : 0;
    sources.push({ name: "4L", dir: dirOf(v), detail: ctx.d4Dir });
    votes.push(v);
  }
  if (tf === "1h" && ctx.hourDir) {
    const v = ctx.hourDir === "Bullish" ? 1 : ctx.hourDir === "Bearish" ? -1 : 0;
    sources.push({ name: "1h model", dir: dirOf(v), detail: ctx.hourDir });
    votes.push(v);
  }

  const up = votes.filter((x) => x > 0).length;
  const dn = votes.filter((x) => x < 0).length;
  const total = votes.length;
  let dir: BullDir = "FLAT";
  if (up >= dn + 2 && up >= 3) dir = "UP";
  else if (dn >= up + 2 && dn >= 3) dir = "DOWN";
  const agree = dir === "UP" ? up : dir === "DOWN" ? dn : Math.max(up, dn);
  const conf = Math.min(100, Math.round((agree / Math.max(1, total)) * 100) + (dir !== "FLAT" ? 10 : 0));
  const option = dir === "UP" ? "CE" : dir === "DOWN" ? "PE" : "—";
  const names = sources.filter((s) => s.dir === dir).map((s) => s.name);
  const headline = dir === "FLAT"
    ? `${tf} ${use}: WAIT — sources split (${up} up / ${dn} down). No insured scalp/dir this bar.`
    : `${tf} ${use}: ${dir} ${option} · ${agree}/${total} sources (${names.join(", ")}). Last bar ${istHm(c.time)} IST. Education, not a guarantee.`;
  return {
    tf, use, dir, option, agree, total, conf,
    barTime: istHm(c.time),
    headline,
    sources,
  };
}

export function buildMoveBulletin(p: {
  c5: any[];
  c15: any[];
  c60: any[];
  oiDir: BullDir;
  fut: string | null;
  pcr: number | null;
  feverSide?: string | null;
  d4Dir?: "Bullish" | "Bearish" | "Neutral" | null;
  hourDir?: "Bullish" | "Bearish" | "Range" | null;
}): { scalp5: TfBulletin | null; scalp15: TfBulletin | null; dir1h: TfBulletin | null; lead: string } {
  const ctx = {
    oiDir: p.oiDir, fut: p.fut, pcr: p.pcr, feverSide: p.feverSide,
    d4Dir: p.d4Dir, hourDir: p.hourDir === "Range" ? null : p.hourDir,
  };
  const scalp5 = readTf("5m", "SCALP", p.c5, ctx);
  const scalp15 = readTf("15m", "SCALP", p.c15, ctx);
  const dir1h = readTf("1h", "DIRECTIONAL", p.c60, ctx);
  let lead = "Bulletin: waiting for 5m / 15m / 1h bars.";
  const s5 = scalp5?.dir || "FLAT";
  const s15 = scalp15?.dir || "FLAT";
  const d1 = dir1h?.dir || "FLAT";
  if (s5 === s15 && s5 !== "FLAT") {
    lead = `Scalp bulletin (5m+15m): ${s5} ${scalp5?.option}. Directional 1h: ${d1 === "FLAT" ? "WAIT" : d1 + " " + (dir1h?.option || "")}.`;
  } else if (s5 !== "FLAT" && s15 === "FLAT") {
    lead = `Only 5m scalp ${s5} — 15m not confirmed. Prefer skip or tiny scalp. 1h ${d1}.`;
  } else if (s15 !== "FLAT" && s5 === "FLAT") {
    lead = `15m scalp ${s15} but 5m quiet. Wait for 5m to agree. 1h ${d1}.`;
  } else if (s5 !== "FLAT" && s15 !== "FLAT" && s5 !== s15) {
    lead = `Scalp conflict: 5m ${s5} vs 15m ${s15} — no scalp. Use 1h directional only if ${d1 !== "FLAT" ? d1 : "also flat / wait"}.`;
  } else {
    lead = `No scalp this print. 1h directional: ${d1 === "FLAT" ? "WAIT (range)" : d1}.`;
  }
  return { scalp5, scalp15, dir1h, lead };
}
