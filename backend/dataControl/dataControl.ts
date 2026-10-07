// ============================ Data Control — central on/off for data requests ============================
// One place to switch data loading on/off per SCREEN (browser polls) and per
// BACKGROUND JOB (server timers). A screen that is off sends no requests from the
// browser and the server refuses its requests (503 {disabled:true}); a job that is
// off does not run. Saves bandwidth and the Dhan rate-limit budget for the screens
// the trader is actually using. Settings persist in data/data-control.json.

import fs from "fs";
import path from "path";

export interface DcItem { key: string; label: string; group: string; note?: string; important?: boolean; }

// Screens = browser tabs + always-on widgets (sidebar / header pills).
export const DC_SCREENS: DcItem[] = [
  { key: "marketcommand", label: "⚡ Market Command", group: "Trading" },
  { key: "optionterminal", label: "📈 Option Terminal", group: "Trading" },
  { key: "tradeexec", label: "🧾 Trade Execution", group: "Trading" },
  { key: "mcsummary", label: "🧭 MC Summary", group: "Trading" },
  { key: "marketanalysis", label: "📊 Market Analysis", group: "Trading" },
  { key: "oianalysis", label: "🔬 OI Analysis", group: "Trading" },
  { key: "oicommand", label: "🎯 Trader Dashboard", group: "Trading" },
  { key: "premarket", label: "📊 Market Sentiment (09:10)", group: "Market" },
  { key: "news", label: "📰 Market News (tab, ticker, MC index news)", group: "Market" },
  { key: "earlymoves", label: "⚡ Early Moves (tab + header alert)", group: "Market", note: "Scans every F&O stock — heavy" },
  { key: "toppicks", label: "Option Top Pick", group: "Market" },
  { key: "liquiditystatus", label: "🌊 Liquidity Status", group: "Market" },
  { key: "todaymovers", label: "Today Big Movers", group: "Market" },
  { key: "bullrank", label: "Bull % Rank", group: "Market" },
  { key: "bigmove", label: "Big Move 20-100%", group: "Market" },
  { key: "stockoptions", label: "📊 Stock Options", group: "Market" },
  { key: "stock", label: "Selected Stock", group: "Market" },
  { key: "paper", label: "🧪 AI Paper Trading screen", group: "Research" },
  { key: "aip", label: "🤖 AI screens (Dashboard / Signals / Review …)", group: "Research" },
  { key: "strategylab", label: "🔬 Master Strategy Lab", group: "Research" },
  { key: "stratreplay", label: "📽 Strategy Replay", group: "Research" },
  { key: "movetiming", label: "Move Timing", group: "Research" },
  { key: "dhanbacktest", label: "🧪 Backtest (Dhan)", group: "Research" },
  { key: "testlab", label: "🧪 Universal Indicator Lab", group: "Research" },
  { key: "w-watchlist", label: "Watchlist sidebar + price ticker", group: "Widgets", note: "~26 stock signals every minute — heavy" },
  { key: "w-besttrade", label: "Header: best 15m trade", group: "Widgets", note: "Runs a multi-stock scan" },
  { key: "w-status", label: "Header: data status / regime / success", group: "Widgets" },
  { key: "w-alerts", label: "Alerts + swing auto-refresh", group: "Widgets" },
];

export const DC_JOBS: DcItem[] = [
  { key: "warmFeeds", label: "Pre-load index candles + option chains (every 45s)", group: "Background", note: "Makes Market Command / Option Terminal open fast" },
  { key: "paperEngine", label: "Paper trading engine (every 5 min)", group: "Background", important: true, note: "Opens and manages paper trades" },
  { key: "paperScalps", label: "Paper OI scalps (every 90s)", group: "Background" },
  { key: "tradeMonitor", label: "Logged-trade monitor: SL / target / 15:15 exit (every 60s)", group: "Background", important: true, note: "Keep ON while you have open trades" },
  { key: "orbAuto", label: "ORB auto-log (every 60s, only when ORB is active)", group: "Background" },
  { key: "hourlyScan", label: "Hourly picks snapshot (09:30 … 15:30)", group: "Background" },
  { key: "oiSignals", label: "OI signal logger (every 5 min)", group: "Background" },
  { key: "premiumSampler", label: "ATM premium recorder (every 60s)", group: "Background" },
  { key: "oiChangeSnapshot", label: "OI change snapshot (every 3 min)", group: "Background" },
  { key: "arbiterObserver", label: "Decision ledger observer (every 30s, no extra Dhan calls)", group: "Background" },
];

const FILE = path.join(process.cwd(), "data", "data-control.json");
interface DcState { screens: Record<string, boolean>; jobs: Record<string, boolean>; updatedAt: number | null; }
let state: DcState = load();

function load(): DcState {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { screens: j.screens || {}, jobs: j.jobs || {}, updatedAt: j.updatedAt ?? null };
  } catch { return { screens: {}, jobs: {}, updatedAt: null }; }
}
function save(): void {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }
  catch (e: any) { console.warn("[data-control] save failed:", e?.message || e); }
}
export function _resetDataControlForTests(s?: Partial<DcState>): void { state = { screens: {}, jobs: {}, updatedAt: null, ...(s || {}) }; counts.length = 0; jobRuns.clear(); }

/** Unknown keys default to ON (a new screen is never silently dark). */
export function screenOn(key: string | null | undefined): boolean { return !key || state.screens[key] !== false; }
export function jobOn(key: string): boolean { if (state.jobs[key] !== false) { jobRuns.set(key, Date.now()); return true; } return false; }

export function setDataControl(kind: "screen" | "job", key: string, on: boolean, persist = true): boolean {
  const list = kind === "screen" ? DC_SCREENS : DC_JOBS;
  if (!list.some((x) => x.key === key)) return false;
  (kind === "screen" ? state.screens : state.jobs)[key] = on;
  state.updatedAt = Math.floor(Date.now() / 1000);
  if (persist) save();
  return true;
}

// ---- request counters: per screen, 1-minute buckets, last 5 minutes ----
const counts: { min: number; by: Record<string, number>; blocked: Record<string, number> }[] = [];
const jobRuns = new Map<string, number>();
export function countRequest(screen: string, blocked: boolean): void {
  const min = Math.floor(Date.now() / 60_000);
  let b = counts[counts.length - 1];
  if (!b || b.min !== min) { b = { min, by: {}, blocked: {} }; counts.push(b); while (counts.length > 6) counts.shift(); }
  const k = screen || "other";
  if (blocked) b.blocked[k] = (b.blocked[k] || 0) + 1; else b.by[k] = (b.by[k] || 0) + 1;
}

export function dataControlStatus() {
  const nowMin = Math.floor(Date.now() / 60_000);
  const recent = counts.filter((b) => b.min >= nowMin - 5 && b.min < nowMin);   // last 5 COMPLETE minutes
  const span = Math.max(1, recent.length);
  const perMin = (k: string, f: "by" | "blocked") => Math.round(recent.reduce((a, b) => a + (b[f][k] || 0), 0) / span * 10) / 10;
  const other = new Set<string>();
  for (const b of recent) for (const k of Object.keys(b.by)) if (!DC_SCREENS.some((s) => s.key === k)) other.add(k);
  return {
    updatedAt: state.updatedAt,
    screens: DC_SCREENS.map((s) => ({ ...s, enabled: screenOn(s.key), reqPerMin: perMin(s.key, "by"), blockedPerMin: perMin(s.key, "blocked") })),
    jobs: DC_JOBS.map((j) => ({ ...j, enabled: state.jobs[j.key] !== false, lastRunAt: jobRuns.has(j.key) ? Math.floor(jobRuns.get(j.key)! / 1000) : null })),
    otherReqPerMin: [...other].map((k) => ({ key: k, reqPerMin: perMin(k, "by") })).sort((a, b) => b.reqPerMin - a.reqPerMin).slice(0, 8),
  };
}
