import fs from "fs";
import path from "path";
import { OiLesson, OiRecommendations } from "./oiTrade";

export const OI_HOUR_SLOTS = [
  { id: "h0915", label: "09:15", from: 555, to: 600 },
  { id: "h10", label: "10:00", from: 600, to: 660 },
  { id: "h11", label: "11:00", from: 660, to: 720 },
  { id: "h12", label: "12:00", from: 720, to: 780 },
  { id: "h13", label: "13:00", from: 780, to: 840 },
  { id: "h14", label: "14:00", from: 840, to: 900 },
  { id: "h15", label: "15:00", from: 900, to: 931 },
] as const;

const FILE = path.join(process.cwd(), "data", "oi-hourly-ready.json");

type Log = Record<string, Record<string, Record<string, { ready: boolean; why: string; at: number; score: number }>>>;

function loadLog(): Log {
  try { return JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { return {}; }
}
function saveLog(l: Log) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(l));
  } catch { /* ignore */ }
}

export function istMins(d = new Date()): number {
  const ist = new Date(d.getTime() + 19800000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
export function istDate(d = new Date()): string {
  return new Date(d.getTime() + 19800000).toISOString().slice(0, 10);
}

export function decideHourReady(p: {
  marketOpen: boolean;
  hasBaseline: boolean;
  stale: boolean;
  oiDir: string;
  rec: OiRecommendations | null;
  lesson: OiLesson | null;
  consensus?: string;
  adx?: number | null;
}): { ready: boolean; score: number; why: string } {
  if (!p.marketOpen) return { ready: false, score: 0, why: "Market closed — first hourly check 09:15 IST Mon–Fri" };
  const bits: string[] = [];
  let score = 0;
  if (p.hasBaseline) { score += 20; bits.push("baseline"); } else bits.push("no baseline yet");
  if (!p.stale) { score += 10; bits.push("fresh chain"); } else bits.push("stale chain");
  if (p.oiDir && p.oiDir !== "FLAT") { score += 25; bits.push("OI " + p.oiDir); } else bits.push("OI FLAT");
  const take = !!(p.rec?.directional?.take || p.rec?.scalp?.take);
  if (take) { score += 25; bits.push("TAKE armed"); } else bits.push("no TAKE");
  if (p.consensus === "AGREE") { score += 15; bits.push("models AGREE"); }
  else if (p.consensus === "CONFLICT") bits.push("models CONFLICT");
  else if (p.consensus) bits.push("models " + p.consensus);
  if (p.adx != null && p.adx >= 18) { score += 10; bits.push("ADX " + p.adx); }
  else if (p.adx != null) bits.push("ADX " + p.adx + " chop");
  if (p.lesson?.mode === "PAY_CHANCE") score += 10;
  if (p.lesson?.mode === "REVERSE_RISK") score -= 15;
  const ready = score >= 70 && take && p.oiDir !== "FLAT" && p.lesson?.mode !== "REVERSE_RISK";
  const why = ready
    ? `This hour can offer a paper trade (${bits.join(" · ")}). Education: hourly READY ≠ guaranteed profit.`
    : `This hour WAIT — ${bits.join(" · ")}. System will re-check next hour.`;
  return { ready, score: Math.max(0, Math.min(100, score)), why };
}

export function recordHourReady(symbol: string, slotId: string, row: { ready: boolean; why: string; score: number }) {
  const date = istDate();
  const log = loadLog();
  if (!log[date]) log[date] = {};
  if (!log[date][symbol]) log[date][symbol] = {};
  log[date][symbol][slotId] = { ...row, at: Math.floor(Date.now() / 1000) };
  saveLog(log);
}

export function buildHourlyBoard(p: {
  symbol: string;
  marketOpen: boolean;
  hasBaseline: boolean;
  stale: boolean;
  oiDir: string;
  rec: OiRecommendations | null;
  lesson: OiLesson | null;
  consensus?: string;
  adx?: number | null;
}): any {
  const mins = istMins();
  const date = istDate();
  const log = loadLog();
  const mine = (log[date] && log[date][p.symbol]) || {};
  const live = decideHourReady(p);
  const hours = OI_HOUR_SLOTS.map((s) => {
    const now = p.marketOpen && mins >= s.from && mins < s.to;
    const past = mins >= s.to;
    const ahead = mins < s.from;
    if (now) {
      recordHourReady(p.symbol, s.id, live);
      return { id: s.id, label: s.label, status: live.ready ? "READY" : "WAIT", current: true, score: live.score, why: live.why };
    }
    if (past && mine[s.id]) {
      return { id: s.id, label: s.label, status: mine[s.id].ready ? "READY" : "WAIT", current: false, score: mine[s.id].score, why: mine[s.id].why };
    }
    if (past) return { id: s.id, label: s.label, status: "MISSED", current: false, score: 0, why: "App was not running this hour — no hourly log" };
    return { id: s.id, label: s.label, status: "AHEAD", current: false, score: 0, why: ahead ? "Decided when this hour starts" : live.why };
  });
  const cur = hours.find((h) => h.current) || null;
  const next = hours.find((h) => h.status === "AHEAD") || null;
  return {
    date,
    marketOpen: p.marketOpen,
    current: cur,
    next: next ? { label: next.label, note: "Hourly READY is computed at the open of that clock hour." } : null,
    live,
    hours,
    note: "Hourly READY = this clock hour the system would allow a paper TAKE. It does not mean the market owes you money. Re-checked every hour 09:15–15:30 IST.",
  };
}
