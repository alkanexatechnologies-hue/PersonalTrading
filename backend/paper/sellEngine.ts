import fs from "fs";
import path from "path";
import { OiAnalysis } from "../types";
import { SellStrategy, SellLeg } from "../options/sellStrategies";

// ---- Option-SELLING paper simulator (premium / theta strategies) ----
// Opens a chosen structure (short straddle / strangle / iron condor), marks the
// combined position to the live chain, and exits on profit target (~50% of
// credit), tail stop (~2x credit loss), a short-strike breach ("adjust" =
// defensive exit in this paper model), or expiry/EOD. Simulated only.

export interface SellPosition {
  id: string;
  type: SellStrategy["type"];
  symbol: string;
  name: string;
  expiry: string | null;
  lotSize: number;
  legs: SellLeg[]; // entry premiums
  netCredit: number;
  netCreditValue: number;
  maxLoss: number | null;
  breakevenLow: number;
  breakevenHigh: number;
  profitTarget: number;
  stopLoss: number;
  shortCall: number | null; // short call strike (breach level)
  shortPut: number | null; // short put strike (breach level)
  entryUnderlying: number;
  entryEpoch: number;
  lastUnderlying?: number;
  lastCostToClose?: number;
  lastPnl?: number;
}
export interface SellClosed extends SellPosition {
  exitEpoch: number;
  exitReason: "target" | "stop" | "adjust" | "expiry" | "eod" | "manual";
  costToClose: number;
  costs: number;
  pnl: number;
  pnlPct: number;
  remark: string;
}
export interface SellState {
  active: boolean;
  startCapital: number;
  realised: number; // cumulative realised P&L (net of costs)
  startDate: string;
  open: SellPosition[];
  closed: SellClosed[];
}

export interface SellTickDeps {
  marketOpen: boolean;
  minutesIST: number;
  nowEpoch: number;
  getChain: (symbol: string) => Promise<OiAnalysis | null>;
}

const FILE = path.join(process.cwd(), "data", "paper-sell-state.json");
const round2 = (n: number) => Math.round(n * 100) / 100;
const istDateOf = (e: number) => new Date(e * 1000 + 19800000).toISOString().slice(0, 10);

let state: SellState | null = null;

function empty(): SellState {
  return { active: false, startCapital: 0, realised: 0, startDate: "", open: [], closed: [] };
}
function load(): SellState {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { state = empty(); }
  return state!;
}
function save() {
  if (!state) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf-8");
  writeCsv(state);
}

// Current price of one leg from the live chain (intrinsic fallback if the strike
// has moved outside the returned window).
function legPriceFromChain(oi: OiAnalysis, leg: SellLeg): number {
  const row = oi.topStrikes?.find((r) => r.strike === leg.strike);
  const px = leg.optionType === "CE" ? row?.ceLtp : row?.peLtp;
  if (px != null) return px;
  const under = oi.underlying ?? leg.strike;
  return Math.max(0, leg.optionType === "CE" ? under - leg.strike : leg.strike - under); // intrinsic
}

// Cost to close the whole structure now (buy back shorts, sell longs), per share.
function costToClose(oi: OiAnalysis, legs: SellLeg[]): number {
  let cost = 0;
  for (const leg of legs) {
    const px = legPriceFromChain(oi, leg);
    cost += leg.action === "SELL" ? px : -px; // buy back sold legs (pay), sell bought legs (receive)
  }
  return cost;
}

// Round-turn friction for a multi-leg structure.
function sellFriction(legs: SellLeg[], entryTurnover: number, exitTurnover: number, lot: number): number {
  const brokerage = 20 * legs.length * 2; // per leg, entry + exit
  const stt = 0.001 * entryTurnover * lot; // STT on the sold premium (entry side for shorts)
  const exch = 0.00035 * (entryTurnover + exitTurnover) * lot;
  const slippage = 0.004 * (entryTurnover + exitTurnover) * lot;
  const gst = 0.18 * (brokerage + exch);
  return round2(brokerage + stt + exch + slippage + gst);
}

export function startSell(strategy: SellStrategy, capital: number, istDate: string): SellState {
  const s = load();
  s.active = true;
  s.startCapital = capital;
  if (!s.startDate) s.startDate = istDate;
  const shortCall = strategy.legs.find((l) => l.action === "SELL" && l.optionType === "CE")?.strike ?? null;
  const shortPut = strategy.legs.find((l) => l.action === "SELL" && l.optionType === "PE")?.strike ?? null;
  s.open.push({
    id: `x${Math.floor(Date.now() / 1000)}-${strategy.symbol}`,
    type: strategy.type, symbol: strategy.symbol, name: strategy.name, expiry: strategy.expiry, lotSize: strategy.lotSize,
    legs: strategy.legs, netCredit: strategy.netCredit, netCreditValue: strategy.netCreditValue,
    maxLoss: strategy.maxLoss, breakevenLow: strategy.breakevenLow, breakevenHigh: strategy.breakevenHigh,
    profitTarget: strategy.profitTarget, stopLoss: strategy.stopLoss, shortCall, shortPut,
    entryUnderlying: strategy.underlying, entryEpoch: Math.floor(Date.now() / 1000),
  });
  save();
  return s;
}

export function stopSell(): SellState { const s = load(); s.active = false; save(); return s; }
export function resetSell(): SellState { state = empty(); save(); return state; }

function closeSell(s: SellState, pos: SellPosition, oi: OiAnalysis | null, reason: SellClosed["exitReason"], nowEpoch: number) {
  const ctc = oi ? costToClose(oi, pos.legs) : pos.netCredit; // if no chain, assume flat
  const grossPnl = round2((pos.netCredit - ctc) * pos.lotSize);
  const entryTurnover = pos.legs.reduce((a, l) => a + l.premium, 0);
  const exitTurnover = oi ? pos.legs.reduce((a, l) => a + legPriceFromChain(oi, l), 0) : entryTurnover;
  const costs = sellFriction(pos.legs, entryTurnover, exitTurnover, pos.lotSize);
  const pnl = round2(grossPnl - costs);
  const pnlPct = pos.netCreditValue ? round2((pnl / pos.netCreditValue) * 100) : 0;
  s.realised = round2(s.realised + pnl);
  const remark = buildRemark(pos, reason, pnl);
  s.closed.push({ ...pos, exitEpoch: nowEpoch, exitReason: reason, costToClose: round2(ctc), costs, pnl, pnlPct, remark });
  s.open = s.open.filter((p) => p.id !== pos.id);
}

function buildRemark(pos: SellPosition, reason: SellClosed["exitReason"], pnl: number): string {
  switch (reason) {
    case "target": return `WIN: booked ~50% of the credit as the position decayed in your favour (+${pnl}).`;
    case "stop": return `LOSS: tail stop hit - combined premium expanded ~2x the credit against you (${pnl}). Sellers must cut fast.`;
    case "adjust": return `CUT (adjust): a short strike was breached (underlying moved through it). Defensive exit at ${pnl} rather than riding undefined risk.`;
    case "expiry": return `Closed at expiry. Kept ${pnl >= 0 ? "the credit (theta win)" : "a loss"} (${pnl}).`;
    case "eod": return `Closed at day-end (not held overnight). Result ${pnl}.`;
    default: return `Closed manually. Result ${pnl}.`;
  }
}

export async function markSell(deps: SellTickDeps): Promise<any> {
  const s = load();
  if (s.active && deps.marketOpen) {
    for (const pos of [...s.open]) {
      const oi = await deps.getChain(pos.symbol).catch(() => null);
      if (!oi || !oi.available) continue;
      const under = oi.underlying ?? pos.lastUnderlying ?? pos.entryUnderlying;
      const ctc = costToClose(oi, pos.legs);
      const pnl = round2((pos.netCredit - ctc) * pos.lotSize);
      pos.lastUnderlying = under;
      pos.lastCostToClose = round2(ctc);
      pos.lastPnl = pnl;
      const eod = deps.minutesIST >= 920; // ~15:20 IST
      const breached = (pos.shortCall != null && under >= pos.shortCall) || (pos.shortPut != null && under <= pos.shortPut);
      if (pnl >= pos.profitTarget) closeSell(s, pos, oi, "target", deps.nowEpoch);
      else if (pnl <= -pos.stopLoss) closeSell(s, pos, oi, "stop", deps.nowEpoch);
      else if (breached) closeSell(s, pos, oi, "adjust", deps.nowEpoch);
      else if (eod) closeSell(s, pos, oi, "eod", deps.nowEpoch);
    }
  }
  return getSellSummary();
}

export function getSellSummary(): any {
  const s = load();
  const wins = s.closed.filter((t) => t.pnl > 0).length;
  const losses = s.closed.filter((t) => t.pnl <= 0).length;
  const decided = wins + losses;
  const openPnl = round2(s.open.reduce((a, p) => a + (p.lastPnl ?? 0), 0));
  return {
    active: s.active, startCapital: s.startCapital, startDate: s.startDate,
    realised: s.realised, openPnl, equity: round2(s.startCapital + s.realised + openPnl),
    wins, losses, winRate: decided ? Math.round((wins / decided) * 1000) / 10 : 0,
    open: s.open, closed: s.closed,
  };
}

const csvCell = (v: any) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function writeCsv(s: SellState) {
  try {
    const dir = path.dirname(FILE);
    fs.mkdirSync(dir, { recursive: true });
    const h = ["exitDate", "type", "symbol", "expiry", "netCredit", "costToClose", "costs", "pnl", "pnlPct", "reason", "remark"];
    const rows = s.closed.map((t) =>
      [istDateOf(t.exitEpoch), t.type, t.symbol, t.expiry ?? "", t.netCreditValue, t.costToClose, t.costs, t.pnl, t.pnlPct, t.exitReason, t.remark].map(csvCell).join(","),
    );
    fs.writeFileSync(path.join(dir, "paper-sell-trades.csv"), [h.join(","), ...rows].join("\n"), "utf-8");
  } catch { /* best-effort */ }
}
