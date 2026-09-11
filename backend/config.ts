import { Interval } from "./types";

// Default watchlist of liquid NSE names + key indices.
// Symbology: NSE equities use the ".NS" suffix; indices use "^" (mapped to the
// Groww underlying via nseSymbol).
export interface SymbolDef {
  symbol: string;
  name: string;
  type: "index" | "equity";
  // F&O (options) metadata. NOTE: NSE revises lot sizes and strike intervals
  // periodically - ALWAYS verify current values against your broker / NSE before
  // trading. Values below are approximate as of the 2024-25 cycle.
  fno?: boolean;
  lotSize?: number; // contract multiplier (units per lot)
  strikeStep?: number; // gap between adjacent option strikes
  nseSymbol?: string; // underlying symbol used by NSE's option-chain API
  isIndex?: boolean; // uses the option-chain-indices endpoint vs equities
  sector?: string; // optional sector tag (e.g. "oil_gas")
}

// Oil & Gas sector F&O names (lot sizes approximate - verify with NSE).
export const OIL_GAS_SYMBOLS: SymbolDef[] = [
  { symbol: "RELIANCE.NS", name: "Reliance Industries", type: "equity", fno: true, lotSize: 500, nseSymbol: "RELIANCE", sector: "oil_gas" },
  { symbol: "ONGC.NS", name: "ONGC", type: "equity", fno: true, lotSize: 3850, nseSymbol: "ONGC", sector: "oil_gas" },
  { symbol: "GAIL.NS", name: "GAIL (India)", type: "equity", fno: true, lotSize: 9150, nseSymbol: "GAIL", sector: "oil_gas" },
  { symbol: "BPCL.NS", name: "BPCL", type: "equity", fno: true, lotSize: 1800, nseSymbol: "BPCL", sector: "oil_gas" },
  { symbol: "IOC.NS", name: "Indian Oil (IOC)", type: "equity", fno: true, lotSize: 9750, nseSymbol: "IOC", sector: "oil_gas" },
  { symbol: "HINDPETRO.NS", name: "HPCL", type: "equity", fno: true, lotSize: 2025, nseSymbol: "HINDPETRO", sector: "oil_gas" },
  { symbol: "PETRONET.NS", name: "Petronet LNG", type: "equity", fno: true, lotSize: 3000, nseSymbol: "PETRONET", sector: "oil_gas" },
  { symbol: "IGL.NS", name: "Indraprastha Gas (IGL)", type: "equity", fno: true, lotSize: 2750, nseSymbol: "IGL", sector: "oil_gas" },
];

export const DEFAULT_SYMBOLS: SymbolDef[] = [
  // Index lot sizes per NSE's Jan-2026 revision (NIFTY 75->65, BANK NIFTY 35->30).
  { symbol: "^NSEI", name: "NIFTY 50", type: "index", fno: true, lotSize: 65, strikeStep: 50, nseSymbol: "NIFTY", isIndex: true },
  { symbol: "^NSEBANK", name: "NIFTY BANK", type: "index", fno: true, lotSize: 30, strikeStep: 100, nseSymbol: "BANKNIFTY", isIndex: true },
  { symbol: "RELIANCE.NS", name: "Reliance Industries", type: "equity", fno: true, lotSize: 500, strikeStep: 20, nseSymbol: "RELIANCE" },
  { symbol: "HDFCBANK.NS", name: "HDFC Bank", type: "equity", fno: true, lotSize: 550, strikeStep: 20, nseSymbol: "HDFCBANK" },
  { symbol: "ICICIBANK.NS", name: "ICICI Bank", type: "equity", fno: true, lotSize: 700, strikeStep: 10, nseSymbol: "ICICIBANK" },
  { symbol: "INFY.NS", name: "Infosys", type: "equity", fno: true, lotSize: 400, strikeStep: 20, nseSymbol: "INFY" },
  { symbol: "TCS.NS", name: "Tata Consultancy Services", type: "equity", fno: true, lotSize: 175, strikeStep: 20, nseSymbol: "TCS" },
  { symbol: "SBIN.NS", name: "State Bank of India", type: "equity", fno: true, lotSize: 750, strikeStep: 10, nseSymbol: "SBIN" },
  { symbol: "TATAMOTORS.NS", name: "Tata Motors", type: "equity", fno: true, lotSize: 550, strikeStep: 10, nseSymbol: "TATAMOTORS" },
  { symbol: "AXISBANK.NS", name: "Axis Bank", type: "equity", fno: true, lotSize: 625, strikeStep: 10, nseSymbol: "AXISBANK" },
  { symbol: "ITC.NS", name: "ITC", type: "equity", fno: true, lotSize: 1600, strikeStep: 5, nseSymbol: "ITC" },
  { symbol: "BHARTIARTL.NS", name: "Bharti Airtel", type: "equity", fno: true, lotSize: 475, strikeStep: 20, nseSymbol: "BHARTIARTL" },
  // More F&O INDICES (lot sizes per NSE Jan-2026 revision).
  { symbol: "^CNXFIN", name: "FIN NIFTY", type: "index", fno: true, lotSize: 60, strikeStep: 50, nseSymbol: "FINNIFTY", isIndex: true },
  { symbol: "^NSEMDCP50", name: "MIDCAP NIFTY", type: "index", fno: true, lotSize: 120, strikeStep: 25, nseSymbol: "MIDCPNIFTY", isIndex: true },
  // More liquid F&O STOCKS. NOTE: lot sizes are APPROXIMATE - NSE revises them
  // periodically; verify against your broker before live trading (fine for paper sim).
  { symbol: "KOTAKBANK.NS", name: "Kotak Mahindra Bank", type: "equity", fno: true, lotSize: 400, strikeStep: 10, nseSymbol: "KOTAKBANK" },
  { symbol: "LT.NS", name: "Larsen & Toubro", type: "equity", fno: true, lotSize: 175, strikeStep: 20, nseSymbol: "LT" },
  { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever", type: "equity", fno: true, lotSize: 300, strikeStep: 20, nseSymbol: "HINDUNILVR" },
  { symbol: "MARUTI.NS", name: "Maruti Suzuki", type: "equity", fno: true, lotSize: 50, strikeStep: 50, nseSymbol: "MARUTI" },
  { symbol: "SUNPHARMA.NS", name: "Sun Pharma", type: "equity", fno: true, lotSize: 350, strikeStep: 10, nseSymbol: "SUNPHARMA" },
  { symbol: "BAJFINANCE.NS", name: "Bajaj Finance", type: "equity", fno: true, lotSize: 750, strikeStep: 10, nseSymbol: "BAJFINANCE" },
  { symbol: "HCLTECH.NS", name: "HCL Technologies", type: "equity", fno: true, lotSize: 350, strikeStep: 20, nseSymbol: "HCLTECH" },
  { symbol: "M&M.NS", name: "Mahindra & Mahindra", type: "equity", fno: true, lotSize: 175, strikeStep: 20, nseSymbol: "M&M" },
  { symbol: "TITAN.NS", name: "Titan Company", type: "equity", fno: true, lotSize: 175, strikeStep: 20, nseSymbol: "TITAN" },
  { symbol: "ADANIENT.NS", name: "Adani Enterprises", type: "equity", fno: true, lotSize: 300, strikeStep: 20, nseSymbol: "ADANIENT" },
  { symbol: "TATASTEEL.NS", name: "Tata Steel", type: "equity", fno: true, lotSize: 5500, strikeStep: 1, nseSymbol: "TATASTEEL" },
  { symbol: "POWERGRID.NS", name: "Power Grid", type: "equity", fno: true, lotSize: 3600, strikeStep: 5, nseSymbol: "POWERGRID" },
];

// Universe for the short-term swing scanner (liquid large/mid/small caps that
// tend to make multi-day moves). Easily extend by adding { symbol, name }.
// nseSymbol is derived automatically from the ".NS" symbol by the Groww provider.
export const SWING_SYMBOLS: SymbolDef[] = [
  // Defence
  { symbol: "PARAS.NS", name: "Paras Defence", type: "equity", sector: "Defence" },
  { symbol: "MAZDOCK.NS", name: "Mazagon Dock", type: "equity", sector: "Defence" },
  { symbol: "COCHINSHIP.NS", name: "Cochin Shipyard", type: "equity", sector: "Defence" },
  { symbol: "GRSE.NS", name: "Garden Reach Shipbuilders", type: "equity", sector: "Defence" },
  { symbol: "BDL.NS", name: "Bharat Dynamics", type: "equity", sector: "Defence" },
  { symbol: "BEL.NS", name: "Bharat Electronics", type: "equity", sector: "Defence" },
  { symbol: "HAL.NS", name: "Hindustan Aeronautics", type: "equity", sector: "Defence" },
  { symbol: "DATAPATTNS.NS", name: "Data Patterns", type: "equity", sector: "Defence" },
  { symbol: "ZENTEC.NS", name: "Zen Technologies", type: "equity", sector: "Defence" },
  { symbol: "SOLARINDS.NS", name: "Solar Industries", type: "equity", sector: "Defence" },
  { symbol: "ASTRAMICRO.NS", name: "Astra Microwave", type: "equity", sector: "Defence" },
  // Railways
  { symbol: "IRFC.NS", name: "IRFC", type: "equity", sector: "Railways" },
  { symbol: "RVNL.NS", name: "RVNL", type: "equity", sector: "Railways" },
  { symbol: "RAILTEL.NS", name: "RailTel", type: "equity", sector: "Railways" },
  { symbol: "IRCON.NS", name: "Ircon International", type: "equity", sector: "Railways" },
  { symbol: "RITES.NS", name: "RITES", type: "equity", sector: "Railways" },
  { symbol: "TITAGARH.NS", name: "Titagarh Rail Systems", type: "equity", sector: "Railways" },
  { symbol: "JWL.NS", name: "Jupiter Wagons", type: "equity", sector: "Railways" },
  { symbol: "IRCTC.NS", name: "IRCTC", type: "equity", sector: "Railways" },
  { symbol: "TEXRAIL.NS", name: "Texmaco Rail", type: "equity", sector: "Railways" },
  // Metals
  { symbol: "TATASTEEL.NS", name: "Tata Steel", type: "equity", sector: "Metals" },
  { symbol: "JSWSTEEL.NS", name: "JSW Steel", type: "equity", sector: "Metals" },
  { symbol: "HINDALCO.NS", name: "Hindalco", type: "equity", sector: "Metals" },
  { symbol: "VEDL.NS", name: "Vedanta", type: "equity", sector: "Metals" },
  { symbol: "SAIL.NS", name: "SAIL", type: "equity", sector: "Metals" },
  { symbol: "NMDC.NS", name: "NMDC", type: "equity", sector: "Metals" },
  { symbol: "NATIONALUM.NS", name: "NALCO", type: "equity", sector: "Metals" },
  { symbol: "JINDALSTEL.NS", name: "Jindal Steel", type: "equity", sector: "Metals" },
  { symbol: "APLAPOLLO.NS", name: "APL Apollo Tubes", type: "equity", sector: "Metals" },
  // Power / Energy
  { symbol: "TATAPOWER.NS", name: "Tata Power", type: "equity", sector: "Power" },
  { symbol: "SUZLON.NS", name: "Suzlon Energy", type: "equity", sector: "Power" },
  { symbol: "NTPC.NS", name: "NTPC", type: "equity", sector: "Power" },
  { symbol: "JSWENERGY.NS", name: "JSW Energy", type: "equity", sector: "Power" },
  { symbol: "INOXWIND.NS", name: "Inox Wind", type: "equity", sector: "Power" },
  { symbol: "NHPC.NS", name: "NHPC", type: "equity", sector: "Power" },
  { symbol: "SJVN.NS", name: "SJVN", type: "equity", sector: "Power" },
  { symbol: "IREDA.NS", name: "IREDA", type: "equity", sector: "Power" },
  // PSU Banks
  { symbol: "PNB.NS", name: "Punjab National Bank", type: "equity", sector: "PSU Bank" },
  { symbol: "CANBK.NS", name: "Canara Bank", type: "equity", sector: "PSU Bank" },
  { symbol: "BANKBARODA.NS", name: "Bank of Baroda", type: "equity", sector: "PSU Bank" },
  { symbol: "UNIONBANK.NS", name: "Union Bank", type: "equity", sector: "PSU Bank" },
  { symbol: "INDIANB.NS", name: "Indian Bank", type: "equity", sector: "PSU Bank" },
  // Fintech / Capital markets
  { symbol: "PAYTM.NS", name: "One97 (Paytm)", type: "equity", sector: "Fintech" },
  { symbol: "POLICYBZR.NS", name: "PB Fintech", type: "equity", sector: "Fintech" },
  { symbol: "CDSL.NS", name: "CDSL", type: "equity", sector: "Fintech" },
  { symbol: "BSE.NS", name: "BSE Ltd", type: "equity", sector: "Fintech" },
  { symbol: "MCX.NS", name: "MCX", type: "equity", sector: "Fintech" },
  { symbol: "ANGELONE.NS", name: "Angel One", type: "equity", sector: "Fintech" },
  { symbol: "KFINTECH.NS", name: "KFin Technologies", type: "equity", sector: "Fintech" },
  // Auto / ancillary
  { symbol: "TATAMOTORS.NS", name: "Tata Motors", type: "equity", sector: "Auto" },
  { symbol: "ASHOKLEY.NS", name: "Ashok Leyland", type: "equity", sector: "Auto" },
  { symbol: "MOTHERSON.NS", name: "Samvardhana Motherson", type: "equity", sector: "Auto" },
  { symbol: "BHARATFORG.NS", name: "Bharat Forge", type: "equity", sector: "Auto" },
  { symbol: "EXIDEIND.NS", name: "Exide Industries", type: "equity", sector: "Auto" },
  // Realty / Infra finance
  { symbol: "DLF.NS", name: "DLF", type: "equity", sector: "Realty" },
  { symbol: "NBCC.NS", name: "NBCC", type: "equity", sector: "Realty" },
  { symbol: "RECLTD.NS", name: "REC Ltd", type: "equity", sector: "Realty" },
  { symbol: "PFC.NS", name: "Power Finance Corp", type: "equity", sector: "Realty" },
  { symbol: "HUDCO.NS", name: "HUDCO", type: "equity", sector: "Realty" },
  // IT / New-age / others
  { symbol: "KPITTECH.NS", name: "KPIT Technologies", type: "equity", sector: "IT" },
  { symbol: "TATAELXSI.NS", name: "Tata Elxsi", type: "equity", sector: "IT" },
  { symbol: "TATATECH.NS", name: "Tata Technologies", type: "equity", sector: "IT" },
  { symbol: "ETERNAL.NS", name: "Eternal (Zomato)", type: "equity", sector: "New-age" },
  { symbol: "NYKAA.NS", name: "Nykaa", type: "equity", sector: "New-age" },
  { symbol: "TRENT.NS", name: "Trent", type: "equity", sector: "Retail" },
  { symbol: "CUPID.NS", name: "Cupid Ltd", type: "equity", sector: "Healthcare" },
  { symbol: "IDEA.NS", name: "Vodafone Idea", type: "equity", sector: "Telecom" },
  { symbol: "ADANIENT.NS", name: "Adani Enterprises", type: "equity", sector: "Diversified" },
  // EMS / Electronics manufacturing (high-beta momentum movers)
  { symbol: "DIXON.NS", name: "Dixon Technologies", type: "equity", sector: "EMS" },
  { symbol: "KAYNES.NS", name: "Kaynes Technology", type: "equity", sector: "EMS" },
  { symbol: "SYRMA.NS", name: "Syrma SGS", type: "equity", sector: "EMS" },
  { symbol: "CGPOWER.NS", name: "CG Power", type: "equity", sector: "EMS" },
  { symbol: "PGEL.NS", name: "PG Electroplast", type: "equity", sector: "EMS" },
  { symbol: "AMBER.NS", name: "Amber Enterprises", type: "equity", sector: "EMS" },
  // Capital goods
  { symbol: "BHEL.NS", name: "BHEL", type: "equity", sector: "Capital Goods" },
  { symbol: "HBLPOWER.NS", name: "HBL Power Systems", type: "equity", sector: "Capital Goods" },
  { symbol: "POLYCAB.NS", name: "Polycab India", type: "equity", sector: "Capital Goods" },
  // Renewables / solar
  { symbol: "WAAREEENER.NS", name: "Waaree Energies", type: "equity", sector: "Renewables" },
  { symbol: "PREMIERENE.NS", name: "Premier Energies", type: "equity", sector: "Renewables" },
  { symbol: "KPIGREEN.NS", name: "KPI Green Energy", type: "equity", sector: "Renewables" },
  // Realty (momentum leg)
  { symbol: "LODHA.NS", name: "Macrotech (Lodha)", type: "equity", sector: "Realty" },
  { symbol: "OBEROIRLTY.NS", name: "Oberoi Realty", type: "equity", sector: "Realty" },
  { symbol: "PRESTIGE.NS", name: "Prestige Estates", type: "equity", sector: "Realty" },
  { symbol: "GODREJPROP.NS", name: "Godrej Properties", type: "equity", sector: "Realty" },
  { symbol: "PHOENIXLTD.NS", name: "Phoenix Mills", type: "equity", sector: "Realty" },
  // Pharma / healthcare
  { symbol: "LAURUSLABS.NS", name: "Laurus Labs", type: "equity", sector: "Pharma" },
  { symbol: "GLENMARK.NS", name: "Glenmark Pharma", type: "equity", sector: "Pharma" },
  { symbol: "MANKIND.NS", name: "Mankind Pharma", type: "equity", sector: "Pharma" },
  { symbol: "ZYDUSLIFE.NS", name: "Zydus Lifesciences", type: "equity", sector: "Pharma" },
  // Chemicals
  { symbol: "DEEPAKNTR.NS", name: "Deepak Nitrite", type: "equity", sector: "Chemicals" },
  { symbol: "SRF.NS", name: "SRF", type: "equity", sector: "Chemicals" },
  { symbol: "AARTIIND.NS", name: "Aarti Industries", type: "equity", sector: "Chemicals" },
  // Sugar / ethanol (event-driven multi-day moves)
  { symbol: "BALRAMCHIN.NS", name: "Balrampur Chini", type: "equity", sector: "Sugar" },
  { symbol: "TRIVENI.NS", name: "Triveni Engineering", type: "equity", sector: "Sugar" },
  // Textiles (small-cap movers like Cupid)
  { symbol: "TRIDENT.NS", name: "Trident", type: "equity", sector: "Textiles" },
  { symbol: "KPRMILL.NS", name: "KPR Mill", type: "equity", sector: "Textiles" },
  { symbol: "WELSPUNLIV.NS", name: "Welspun Living", type: "equity", sector: "Textiles" },
  // New-age / capital markets
  { symbol: "OLAELEC.NS", name: "Ola Electric", type: "equity", sector: "New-age" },
  { symbol: "SWIGGY.NS", name: "Swiggy", type: "equity", sector: "New-age" },
  { symbol: "NUVAMA.NS", name: "Nuvama Wealth", type: "equity", sector: "Fintech" },
  { symbol: "IFCI.NS", name: "IFCI", type: "equity", sector: "PSU Bank" },
];

// All known symbols (watchlist + sector + swing lists), de-duplicated by symbol.
export const ALL_SYMBOLS: SymbolDef[] = (() => {
  const map = new Map<string, SymbolDef>();
  for (const s of [...DEFAULT_SYMBOLS, ...OIL_GAS_SYMBOLS, ...SWING_SYMBOLS]) if (!map.has(s.symbol)) map.set(s.symbol, s);
  return [...map.values()];
})();

export function findSymbolDef(symbol: string): SymbolDef | undefined {
  return ALL_SYMBOLS.find((s) => s.symbol === symbol);
}

export const CONFIG = {
  port: Number(process.env.PORT) || 5173,
  defaultInterval: "5m" as Interval,
  // How many days of history to pull per interval (Groww intraday history limits apply).
  historyDaysByInterval: {
    "1m": 5,
    "5m": 30,
    "15m": 45,
    "30m": 45,
    "60m": 60,
    "1d": 365,
  } as Record<Interval, number>,
  // Market-data provider. GROWW IS THE ONLY SUPPORTED SOURCE (real-time NSE via
  // the Groww Trade API; needs GROWW_ACCESS_TOKEN). Yahoo and TrueData have been
  // removed. BrokerProvider is reserved for future order execution only and is
  // never a market-data source.
  dataProvider: "groww" as const,
};

/**
 * Best-estimate option strike interval for a given underlying price.
 * Indices use their known steps; equities use NSE-style price bands.
 * NOTE: NSE sets intervals per-scrip and revises them - the live option chain
 * (Groww/NSE) is the only exact source. This keeps strikes in the correct range.
 */
export function getStrikeStep(price: number, def?: Partial<SymbolDef>): number {
  if (def?.isIndex) return def.strikeStep && def.strikeStep > 0 ? def.strikeStep : 50;
  if (!price || price <= 0) return def?.strikeStep || 5;
  if (price <= 100) return 2.5;
  if (price <= 250) return 5;
  if (price <= 500) return 5;
  if (price <= 1000) return 10;
  if (price <= 2000) return 20;
  if (price <= 5000) return 50;
  return 100;
}

/** Round a price to the nearest valid strike. */
export function nearestStrike(price: number, def?: Partial<SymbolDef>): number {
  const step = getStrikeStep(price, def);
  return Math.round(price / step) * step;
}

export const DISCLAIMER =
  "Educational analysis only. Not investment advice. Data may be delayed. " +
  "No signal is a guarantee - markets are uncertain and intraday trading can lose money quickly. " +
  "Always use a stop-loss and manage risk.";
