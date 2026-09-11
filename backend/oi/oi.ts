import { SymbolDef } from "../config";
import { OiAnalysis, OiStrike } from "../types";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};

const OI_DISCLAIMER =
  "Open Interest is fetched from NSE's public option-chain (nearest expiry), may be delayed ~3 min, " +
  "and can be rate-limited/blocked from some networks. OI reads are context, not signals - always confirm with price.";

function cookieHeader(res: Response): string {
  const anyHeaders = res.headers as any;
  const list: string[] = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

// Fetch the raw option chain JSON from NSE with the required cookie handshake.
async function fetchChain(def: SymbolDef): Promise<any> {
  const home = await fetch("https://www.nseindia.com/", { headers: HEADERS });
  let cookie = cookieHeader(home);
  const oc = await fetch("https://www.nseindia.com/option-chain", { headers: { ...HEADERS, Cookie: cookie } });
  const more = cookieHeader(oc);
  if (more) cookie = cookie ? cookie + "; " + more : more;

  const path = def.isIndex ? "option-chain-indices" : "option-chain-equities";
  const url = `https://www.nseindia.com/api/${path}?symbol=${encodeURIComponent(def.nseSymbol || "")}`;
  const res = await fetch(url, { headers: { ...HEADERS, Cookie: cookie } });
  if (!res.ok) throw new Error(`NSE responded ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

function unavailable(def: SymbolDef, msg: string): OiAnalysis {
  return {
    symbol: def.symbol,
    nseSymbol: def.nseSymbol || def.symbol,
    available: false,
    message: msg,
    underlying: null,
    expiry: null,
    pcr: null,
    pcrState: "neutral",
    totalCeOi: 0,
    totalPeOi: 0,
    support: null,
    resistance: null,
    maxPain: null,
    ceBuildup: "mixed",
    peBuildup: "mixed",
    verdict: { bias: "Neutral", reasons: [msg] },
    topStrikes: [],
    asOf: Math.floor(Date.now() / 1000),
    disclaimer: OI_DISCLAIMER,
  };
}

export async function getOiAnalysis(def: SymbolDef): Promise<OiAnalysis> {
  if (!def.fno || !def.nseSymbol) {
    return unavailable(def, "No F&O / NSE symbol configured for this instrument.");
  }

  let json: any;
  try {
    json = await fetchChain(def);
  } catch (e: any) {
    return unavailable(
      def,
      "Live OI unavailable from this host (NSE blocked the request). This usually works from a " +
        "normal residential connection - or connect a broker feed (Upstox/Zerodha) for reliable OI."
    );
  }

  const records = json?.records;
  const underlying: number | null = records?.underlyingValue ?? null;
  const expiry: string | null = records?.expiryDates?.[0] ?? null;
  if (!records?.data || !expiry) return unavailable(def, "NSE returned no option-chain data.");

  // Nearest-expiry rows only.
  const rows = records.data.filter((d: any) => d.expiryDate === expiry);
  const strikeMap = new Map<number, OiStrike>();
  for (const r of rows) {
    const k = r.strikePrice;
    const entry: OiStrike = strikeMap.get(k) || { strike: k, ceOi: 0, peOi: 0, ceChg: 0, peChg: 0 };
    if (r.CE) { entry.ceOi = r.CE.openInterest || 0; entry.ceChg = r.CE.changeinOpenInterest || 0; }
    if (r.PE) { entry.peOi = r.PE.openInterest || 0; entry.peChg = r.PE.changeinOpenInterest || 0; }
    strikeMap.set(k, entry);
  }
  const all = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);
  if (!all.length) return unavailable(def, "NSE returned an empty chain.");

  const totalCeOi = all.reduce((s, x) => s + x.ceOi, 0);
  const totalPeOi = all.reduce((s, x) => s + x.peOi, 0);
  const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;

  // Support = strike with max PUT OI; Resistance = strike with max CALL OI.
  let support = all[0];
  let resistance = all[0];
  for (const x of all) {
    if (x.peOi > support.peOi) support = x;
    if (x.ceOi > resistance.ceOi) resistance = x;
  }

  // Max pain: strike minimising total intrinsic payout to option buyers.
  let maxPain: number | null = null;
  let minPain = Infinity;
  for (const k of all) {
    let pain = 0;
    for (const x of all) {
      if (x.strike < k.strike) pain += x.ceOi * (k.strike - x.strike); // ITM calls
      if (x.strike > k.strike) pain += x.peOi * (x.strike - k.strike); // ITM puts
    }
    if (pain < minPain) { minPain = pain; maxPain = k.strike; }
  }

  const ceChgTotal = all.reduce((s, x) => s + x.ceChg, 0);
  const peChgTotal = all.reduce((s, x) => s + x.peChg, 0);
  const ceBuildup: OiAnalysis["ceBuildup"] = ceChgTotal > 0 ? "short buildup" : ceChgTotal < 0 ? "short covering" : "mixed";
  const peBuildup: OiAnalysis["peBuildup"] = peChgTotal > 0 ? "short buildup" : peChgTotal < 0 ? "short covering" : "mixed";

  // Strikes around ATM for display.
  const atm = underlying != null ? all.reduce((p, c) => (Math.abs(c.strike - underlying) < Math.abs(p.strike - underlying) ? c : p), all[0]) : all[Math.floor(all.length / 2)];
  const atmIdx = all.indexOf(atm);
  const topStrikes = all.slice(Math.max(0, atmIdx - 5), atmIdx + 6);

  // Verdict.
  const reasons: string[] = [];
  let score = 0;
  if (pcr != null) {
    if (pcr >= 1.2) { score += 1; reasons.push(`PCR ${pcr.toFixed(2)} - heavy put writing (support building, bullish lean)`); }
    else if (pcr <= 0.7) { score -= 1; reasons.push(`PCR ${pcr.toFixed(2)} - heavy call writing (resistance building, bearish lean)`); }
    else reasons.push(`PCR ${pcr.toFixed(2)} - balanced`);
  }
  if (peBuildup === "short buildup") { score += 1; reasons.push("Put writers adding OI - defending support"); }
  if (ceBuildup === "short buildup") { score -= 1; reasons.push("Call writers adding OI - capping upside"); }
  if (support) reasons.push(`Max PUT OI at ${support.strike} (support)`);
  if (resistance) reasons.push(`Max CALL OI at ${resistance.strike} (resistance)`);
  if (maxPain != null) reasons.push(`Max pain ${maxPain} - price often gravitates here near expiry`);

  const bias: OiAnalysis["verdict"]["bias"] = score >= 1 ? "Bullish" : score <= -1 ? "Bearish" : "Neutral";
  const pcrState: OiAnalysis["pcrState"] = pcr == null ? "neutral" : pcr >= 1.2 ? "bullish" : pcr <= 0.7 ? "bearish" : "neutral";

  return {
    symbol: def.symbol,
    nseSymbol: def.nseSymbol,
    available: true,
    underlying,
    expiry,
    pcr: pcr != null ? Math.round(pcr * 100) / 100 : null,
    pcrState,
    totalCeOi,
    totalPeOi,
    support: support.strike,
    resistance: resistance.strike,
    maxPain,
    ceBuildup,
    peBuildup,
    verdict: { bias, reasons },
    topStrikes,
    asOf: Math.floor(Date.now() / 1000),
    disclaimer: OI_DISCLAIMER,
  };
}
