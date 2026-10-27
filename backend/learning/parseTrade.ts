// ============================ LEARNING — read a trade written in the trader's own words ============================
// "BUY Nifty 22750 PE ABOVE 50 SL-37 TARGET 78,95,105 Time 10:07 AM", "Nifty 750 CE Buy At 20 at 2.42 PM",
// "27 Oct sensex 81500 ce at 120 sl 95 tgt 150 at 11:20" → index, date, strike, CE/PE, above/at, price, SL, targets, time.
// Pure text parsing; anything not found is listed in `missing` so the screen can ask for it. Advisory / learning only.

export type LearnIndex = "NIFTY" | "SENSEX";
export interface ParsedTrade {
  index: LearnIndex | null; date: string | null; strike: number | null; strikeShort: boolean; side: "CE" | "PE" | null;
  how: "above" | "at" | null; price: number | null; sl: number | null; targets: number[]; time: string | null;
  missing: string[]; unsupported?: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const NUM = String.raw`\d+(?:\.\d+)?`;

/** `today` (YYYY-MM-DD, IST) resolves "today" / "yesterday" and a date written without a year. */
export function parseTrade(text: string, today: string, defaults: { index?: string | null; date?: string | null } = {}): ParsedTrade {
  let s = ` ${String(text || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ")} `;
  const cut = (m: RegExpExecArray | null) => { if (m) s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); };
  const out: ParsedTrade = { index: null, date: null, strike: null, strikeShort: false, side: null, how: null, price: null, sl: null, targets: [], time: null, missing: [] };

  // index
  const ix = /\b(bank ?nifty|fin ?nifty|midcp ?nifty|nifty ?50|nifty|sensex|bse)\b/.exec(s);
  if (ix) { const w = ix[1].replace(/\s/g, ""); if (w === "nifty" || w === "nifty50") out.index = "NIFTY"; else if (w === "sensex" || w === "bse") out.index = "SENSEX"; else out.unsupported = `${w.toUpperCase()} is not covered yet. Learning works for NIFTY and SENSEX.`; cut(ix); }
  if (!out.index && !out.unsupported && (defaults.index === "NIFTY" || defaults.index === "SENSEX")) out.index = defaults.index;

  // time: with am/pm first ("2.42 pm", "12:12 pm"), then after a time word, then any hh:mm with a colon
  const yr = Number(today.slice(0, 4));
  let tm = /(?:\b(?:time|timing|at|@)\s*[:\-]?\s*)?\b(\d{1,2})[:.](\d{2})\s*(am|pm)\b/.exec(s)
    || /\b(?:time|timing|entry time)\s*[:\-=]?\s*(\d{1,2})[:.](\d{2})\b()/.exec(s)
    || /\b(\d{1,2}):(\d{2})\b()/.exec(s);
  if (tm) {
    let h = Number(tm[1]); const m = Number(tm[2]), ap = tm[3];
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 3) h += 12;   // "2:42" in a trading context is 14:42
    if (h <= 23 && m <= 59) out.time = `${pad(h)}:${pad(m)}`; cut(tm);
  }

  // date
  let dm: RegExpExecArray | null;
  if ((dm = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) { out.date = `${dm[1]}-${dm[2]}-${dm[3]}`; cut(dm); }
  else if ((dm = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/]*(${MONTHS.join("|")})[a-z]*\.?(?:[\s\-/,]*(\d{4}))?\b`).exec(s))) {
    out.date = `${dm[3] || yr}-${pad(MONTHS.indexOf(dm[2]) + 1)}-${pad(Number(dm[1]))}`; cut(dm);
  } else if ((dm = new RegExp(String.raw`\b(${MONTHS.join("|")})[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]*(\d{4}))?\b`).exec(s))) {
    out.date = `${dm[3] || yr}-${pad(MONTHS.indexOf(dm[1]) + 1)}-${pad(Number(dm[2]))}`; cut(dm);
  } else if ((dm = /\btoday\b/.exec(s))) { out.date = today; cut(dm); }
  else if ((dm = /\byesterday\b/.exec(s))) { out.date = new Date(Date.parse(today + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10); cut(dm); }

  // option: "22750 pe", "750 ce", "22750 put"
  const op = /\b(\d{2,6})\s*(ce|pe|call|put)s?\b/.exec(s);
  if (op) { out.strike = Number(op[1]); out.strikeShort = out.strike < 10000; out.side = op[2] === "ce" || op[2] === "call" ? "CE" : "PE"; cut(op); }

  // stop loss
  const sl = new RegExp(String.raw`\b(?:sl|stop ?loss|stoploss|stop)\s*[:\-=]?\s*(${NUM})`).exec(s);
  if (sl) { out.sl = Number(sl[1]); cut(sl); }

  // targets: "t1 78 t2 95", or "target 78,95,105" / "tgt 78/95/105" / "targets 78 95 and 105"
  const tn = [...s.matchAll(new RegExp(String.raw`\bt([1-3])\s*[:\-=]?\s*(${NUM})`, "g"))];
  if (tn.length) { out.targets = tn.map((m) => Number(m[2])); for (const m of tn.reverse()) s = s.slice(0, m.index!) + " " + s.slice(m.index! + m[0].length); }
  else {
    const tg = new RegExp(String.raw`\b(?:targets?|tgts?|tgt|tp)\s*[:\-=]?\s*(${NUM}(?:\s*(?:,|/|-|&|and|\s)\s*${NUM}){0,4})`).exec(s);
    if (tg) { out.targets = tg[1].split(/[^\d.]+/).filter(Boolean).map(Number); cut(tg); }
  }

  // numeric date "27/10" or "27-10-2026" — after SL / targets so "78/95" is never read as a date
  if (!out.date && (dm = /\b(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?\b/.exec(s)) && Number(dm[1]) <= 31 && Number(dm[2]) <= 12) {
    const y = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : yr; out.date = `${y}-${pad(Number(dm[2]))}-${pad(Number(dm[1]))}`; cut(dm);
  }
  if (!out.date && defaults.date && /^\d{4}-\d{2}-\d{2}$/.test(defaults.date)) out.date = defaults.date;

  // entry: "above 50", "abv 50", "at 20", "@ 20", "near 20", "buy 52"
  const en = new RegExp(String.raw`(?<![a-z])(above|abv|over|cross(?:es|ing)?|breaks?|at|near|around|below|@)\s*[:\-=]?\s*(${NUM})`).exec(s)
    || new RegExp(String.raw`\b(buy|bought|entry|price)\s*[:\-=]?\s*(${NUM})`).exec(s);
  if (en) { out.price = Number(en[2]); out.how = /^(above|abv|over|cross|break)/.test(en[1]) ? "above" : "at"; }

  out.targets = out.targets.filter((t) => t > 0).slice(0, 3);
  if (!out.index && !out.unsupported) out.missing.push("index");
  if (!out.date) out.missing.push("date");
  if (out.strike == null || !out.side) out.missing.push("strike + CE/PE");
  if (out.price == null) out.missing.push("buy price");
  if (!out.time) out.missing.push("time");
  return out;
}

/** "750" written for 22750: the strike nearest to the spot whose last digits match. */
export function resolveShortStrike(short: number, spot: number, step: number): number {
  const digits = String(short).length, unit = 10 ** digits;
  let best = short, bestD = Infinity;
  for (let k = Math.floor(spot / unit) - 1; k <= Math.floor(spot / unit) + 1; k++) { const s = k * unit + short, d = Math.abs(s - spot); if (d < bestD && s % step === 0) { best = s; bestD = d; } }
  return best;
}
