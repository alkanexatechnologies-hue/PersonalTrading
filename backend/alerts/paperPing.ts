import fs from "fs";
import path from "path";
import { notify, notificationsReady, notificationStatus } from "../integrations/notificationService";

// Monday / any session: when the market is live, ping the notification channel
// (Telegram since the migration) with a detailed
// paper-trade brief. Two message types:
//   open  — once per IST day shortly after 09:15 (market is online)
//   take  — when OI Command + correlated models say it is a good paper entry

const SENT = path.join(process.cwd(), "data", "alerts-sent.json");
const LOG = path.join(process.cwd(), "data", "alerts-log.json");
const TAKE_COOLDOWN_SEC = 20 * 60;

interface SentState {
  lastOpenDate: string;
  lastTake: Record<string, number>; // key → epoch
}

function loadSent(): SentState {
  try { return JSON.parse(fs.readFileSync(SENT, "utf-8")); } catch {
    return { lastOpenDate: "", lastTake: {} };
  }
}
function saveSent(s: SentState) {
  try {
    fs.mkdirSync(path.dirname(SENT), { recursive: true });
    fs.writeFileSync(SENT, JSON.stringify(s, null, 2));
  } catch { /* ignore */ }
}
function appendLog(row: any) {
  try {
    const arr = JSON.parse(fs.readFileSync(LOG, "utf-8"));
    const next = [row, ...(Array.isArray(arr) ? arr : [])].slice(0, 40);
    fs.writeFileSync(LOG, JSON.stringify(next, null, 2));
  } catch {
    try { fs.writeFileSync(LOG, JSON.stringify([row], null, 2)); } catch { /* ignore */ }
  }
}

function istNow() {
  const d = new Date(Date.now() + 19800000);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const date = d.toISOString().slice(0, 10);
  const hhmm = d.toISOString().slice(11, 16);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day];
  return { day, mins, date, hhmm, weekday, isMonday: day === 1 };
}

function money(v: any) {
  if (v == null || !(Number(v) > 0)) return "—";
  return "₹" + Number(v);
}

export function isGoodPaperTime(grid: any): { ok: boolean; why: string[] } {
  const why: string[] = [];
  if (!grid || !grid.available) return { ok: false, why: ["OI chain unavailable"] };
  if (!grid.hasBaseline) return { ok: false, why: ["OI baseline not formed yet (first reading of the day)"] };
  if (grid.stale) return { ok: false, why: [`chain stale ${grid.dataAgeSec}s`] };
  if (grid.oiDirection === "FLAT") return { ok: false, why: ["OI FLAT — no edge"] };
  const rec = grid.recommendation || {};
  const dir = rec.directional || {};
  const sc = rec.scalp || {};
  if (!dir.take && !sc.take) {
    why.push("no TAKE on directional or OI-scalp");
    if (dir.skipReasons) why.push(...dir.skipReasons.slice(0, 3));
    return { ok: false, why };
  }
  const c = grid.correlate || {};
  if (c.consensus === "CONFLICT") return { ok: false, why: ["models CONFLICT with OI — stand aside"] };
  const algo = !!(dir.algoReady || sc.algoReady);
  if (c.consensus === "MIXED" && !algo) return { ok: false, why: ["consensus MIXED and paper conf < 68"] };
  if (dir.take) why.push(`directional ${dir.action}`);
  if (sc.take) why.push(`scalp ${sc.action}`);
  why.push(`consensus ${c.consensus || "—"} (${c.agree || 0} agree / ${c.against || 0} against)`);
  return { ok: true, why };
}

function formatTakeMessage(grid: any, ctx: { weekday: string; hhmm: string; date: string; isMonday: boolean; why: string[] }): string {
  const rec = grid.recommendation || {};
  const dir = rec.directional || {};
  const sc = rec.scalp || {};
  const c = grid.correlate || {};
  const s = grid.setup || {};
  const m = grid.management || {};
  const L = grid.levels || {};
  const lines: string[] = [];
  lines.push(`NSA PAPER TRADE · ${ctx.isMonday ? "MONDAY OPEN SESSION" : ctx.weekday.toUpperCase()}`);
  lines.push(`${ctx.date} ${ctx.hhmm} IST · Groww live`);
  lines.push(`GOOD TIME to take a PAPER trade (not live broker).`);
  lines.push("");
  lines.push(`${grid.name}  spot ${grid.spot}`);
  lines.push(`Expiry ${grid.expiry || "—"} · chain ${grid.dataAgeSec != null ? grid.dataAgeSec + "s" : "live"}`);
  lines.push(`OI ${grid.oiDirection}  score ${grid.oiMoveScore}/100  PCR ${grid.pcr ?? "—"}`);
  lines.push(`Futures: ${grid.futBuildup || "—"}`);
  if (c.vwap != null) lines.push(`VWAP ${c.vwap} (${c.vwapPts >= 0 ? "+" : ""}${c.vwapPts} pts) · ADX ${c.adx ?? "—"}`);
  lines.push(`Consensus: ${c.consensus} · ${c.agree} agree / ${c.against} against / ${c.flat} flat`);
  lines.push("");
  lines.push("MODEL BOARD");
  for (const md of (c.models || [])) {
    lines.push(`• ${md.name}: ${md.dir} [${String(md.vsOi || "").toUpperCase()}] ${md.detail || ""}`);
  }
  lines.push("");
  if (dir.take) {
    lines.push("DIRECTIONAL (session)");
    lines.push(`${dir.action}`);
    lines.push(`Strike ${dir.strike} ${dir.optionType}  LTP ${money(dir.ltp)}`);
    lines.push(`Target ${money(dir.target)}  Stop ${money(dir.stop)}`);
    lines.push(`Spot tgt ${dir.spotTarget ?? "—"}  invalidation ${m.invalidation ?? "—"}`);
    lines.push(`Conf ${dir.confidence}/100  ${dir.algoReady ? "algo-ready (≥68)" : "below paper floor 68"}`);
    lines.push(`Horizon ${dir.horizon}`);
  }
  if (sc.take) {
    lines.push("");
    lines.push("OI SCALP (5–15m)");
    lines.push(`${sc.action}`);
    lines.push(`Strike ${sc.strike} ${sc.optionType}  LTP ${money(sc.ltp)}`);
    lines.push(`Target ${money(sc.target)}  Stop ${money(sc.stop)}`);
    lines.push(`Conf ${sc.confidence}/100  ${sc.algoReady ? "algo-ready" : "watch only"}`);
  }
  lines.push("");
  lines.push("LEVELS");
  lines.push(`R ${L.strongResistance?.strike ?? "—"} / ${L.weakResistance?.strike ?? "—"}`);
  lines.push(`S ${L.strongSupport?.strike ?? "—"} / ${L.weakSupport?.strike ?? "—"}`);
  lines.push(`OR 15m ${L.orbHigh ?? "—"} / ${L.orbLow ?? "—"}  PDH/PDL ${L.pdh ?? "—"} / ${L.pdl ?? "—"}`);
  const V = grid.volume || {};
  if (V.available) {
    const brk = V.breakout ? ` · ${V.breakout} breakout ${V.breakoutConfirmed ? "✓ volume active" : "(weak vol)"}` : "";
    lines.push(`VOLUME ${V.state} · rvol ${V.rvol}x · ${V.flow}${brk}`);
  } else {
    lines.push(`VOLUME N/A (index — no volume feed)`);
  }
  lines.push("");
  lines.push("WHY NOW");
  for (const w of ctx.why) lines.push(`• ${w}`);
  const reasons = (grid.oiReasons || []).slice(0, 4);
  for (const r of reasons) lines.push(`• ${r}`);
  lines.push("");
  lines.push("ACTION");
  lines.push("1) NSA → OI Command (this symbol)");
  lines.push("2) Paper Trading → Start run (if not running)");
  lines.push("3) OI Command → Paper algo ON");
  lines.push("Paper / education only. Stop is mandatory. Not a live order.");
  return lines.join("\n");
}

function formatOpenMessage(grids: any[], ctx: { weekday: string; hhmm: string; date: string; isMonday: boolean }): string {
  const lines: string[] = [];
  lines.push(`NSA · MARKET ONLINE · ${ctx.isMonday ? "MONDAY" : ctx.weekday.toUpperCase()}`);
  lines.push(`${ctx.date} ${ctx.hhmm} IST · session 09:15–15:30`);
  lines.push("App is watching OI Command for a paper-trade window.");
  lines.push("");
  for (const g of grids) {
    if (!g || !g.available) continue;
    const c = g.correlate || {};
    const rec = g.recommendation || {};
    const take = rec.directional?.take || rec.scalp?.take;
    lines.push(`${g.name}  ${g.spot}  OI ${g.oiDirection} (${g.oiMoveScore})  VWAP ${c.vwap ?? "—"}  ${c.consensus || "—"}  ${take ? "TAKE" : "WAIT"}`);
  }
  lines.push("");
  lines.push("You will get another Telegram message when consensus is AGREE (or MIXED + algo-ready) with a concrete CE/PE, target and stop.");
  lines.push("Keep the NSA server running on this Mac through the session.");
  lines.push("Paper only — no live broker order.");
  return lines.join("\n");
}

export interface PingDeps {
  marketOpen: boolean;
  provider: string;
  scan: () => Promise<any[]>;
}

// Renamed from tickPaperWhatsApp during the Telegram migration. The scan, the
// timing windows, the cooldown and the message bodies are unchanged - only the
// delivery channel moved.
export async function tickPaperAlerts(deps: PingDeps): Promise<{ sent: string[]; skipped: string }> {
  const ready = notificationsReady();
  if (!ready.ok) return { sent: [], skipped: ready.reason };
  if (deps.provider !== "groww") return { sent: [], skipped: "Groww feed required" };
  if (!deps.marketOpen) return { sent: [], skipped: "market closed" };

  const t = istNow();
  const sent: string[] = [];
  const state = loadSent();
  let grids: any[] = [];
  try { grids = await deps.scan(); } catch (e: any) {
    return { sent: [], skipped: e?.message || "scan failed" };
  }

  // Once per day after 09:16: market-online briefing (Monday called out).
  if (t.mins >= 556 && t.mins <= 600 && state.lastOpenDate !== t.date) {
    const msg = formatOpenMessage(grids, t);
    const r = await notify("MARKET_OPEN", msg);
    appendLog({ at: Date.now(), type: "open", ok: r.ok, via: r.channel, error: r.error, preview: msg.slice(0, 180) });
    if (r.ok) { state.lastOpenDate = t.date; sent.push("open"); }
  }

  for (const grid of grids) {
    const g = isGoodPaperTime(grid);
    if (!g.ok) continue;
    const kind = grid.recommendation?.scalp?.take ? "scalp" : "dir";
    const key = `${grid.symbol}:${grid.oiDirection}:${kind}:${grid.setup?.strike || ""}`;
    const last = state.lastTake[key] || 0;
    const now = Math.floor(Date.now() / 1000);
    if (now - last < TAKE_COOLDOWN_SEC) continue;
    const msg = formatTakeMessage(grid, { ...t, why: g.why });
    const r = await notify("TRADE_TAKE", msg);
    appendLog({ at: Date.now(), type: "take", symbol: grid.symbol, ok: r.ok, via: r.channel, error: r.error, preview: msg.slice(0, 180) });
    if (r.ok) { state.lastTake[key] = now; sent.push(key); }
  }

  saveSent(state);
  return { sent, skipped: sent.length ? "" : "no TAKE window yet (waiting for OI + model AGREE)" };
}

export async function sendAlertsTest(): Promise<any> {
  const t = istNow();
  const msg = [
    `NSA TEST · Telegram linked`,
    `${t.date} ${t.hhmm} IST ${t.weekday}`,
    `When the market is online (Mon–Fri 09:15–15:30 IST) you will get:`,
    `1) Market-online briefing after 09:16`,
    `2) A detailed PAPER TRADE ping when OI Command + VWAP + 4-Layer + GainzAlgo v2 agree.`,
    `Keep the NSA app running. Paper / education only.`,
  ].join("\n");
  const r = await notify("TEST", msg);
  appendLog({ at: Date.now(), type: "test", ok: r.ok, via: r.channel, error: r.error });
  return { ...r, message: msg };
}

// Renamed from whatsappStatus(). Channel details now come from the notification
// service; the ping-state fields (lastOpenDate / lastTakeKeys) are unchanged.
export function alertsStatus(): any {
  const ch = notificationStatus();
  let log: any[] = [];
  try { log = JSON.parse(fs.readFileSync(LOG, "utf-8")); } catch { log = []; }
  const sent = loadSent();
  return {
    channel: ch.channel,
    enabled: ch.enabled,
    configured: ch.configured,
    ready: ch.ready,
    reason: ch.reason,
    botTokenMasked: ch.botTokenMasked,
    chatId: ch.chatId,
    lastSuccessAt: ch.lastSuccessAt,
    lastError: ch.lastError,
    lastOpenDate: sent.lastOpenDate,
    lastTakeKeys: Object.keys(sent.lastTake || {}),
    log: log.slice(0, 8),
  };
}
