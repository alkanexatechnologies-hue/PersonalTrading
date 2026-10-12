import { normalizeEod, type TradeRow } from "./tradeLogStore";

// ============================ Trade Execution audit (read-only) ============================
// Re-checks every logged trade against the rules now in force:
//   1. Single decision source — the arbiter's last CLOSED-candle decision for that index at the trade time must be
//      BUY on the same side and at most 15 minutes old.
//   2. A real stop — SL above the ₹0.05 floor and below entry.
//   3. A reachable target — R:R above 1:6 means the target came from a far chart level the trade never reaches.
//   4. Honest result labels — EOD square-offs read as "EOD Exit", not Target / SL Hit.
// Days without a decision ledger are reported as "not recorded" (never guessed).

export const INDEX_OF_NAME: Record<string, string> = { "NIFTY 50": "NIFTY", "NIFTY BANK": "BANKNIFTY", "NIFTY FIN SERVICE": "FINNIFTY", "FINNIFTY": "FINNIFTY", "MIDCAP NIFTY": "MIDCPNIFTY", "SENSEX": "SENSEX" };

export interface AuditRow {
  id: string; date: string; time: string; index: string; type: string; strike: number | null; entry: number | null; sl: number | null; target: number | null; rr: string | null;
  status: string; points: number | null; source: "AUTO" | "MANUAL";
  arbiter: { action: string; candle: string } | null; arbiterRecorded: boolean;
  checks: { key: string; ok: boolean | null; text: string }[];
  verdict: "ALLOWED" | "BLOCKED" | "NOT RECORDED";
}

const rrNum = (rr: string | null) => { const m = String(rr || "").match(/1:([\d.]+)/); return m ? Number(m[1]) : null; };

export function auditTrade(t0: TradeRow, ledger: any[] | null): AuditRow {
  const t = normalizeEod(t0);
  const want = t.type === "PE" ? "BUY_PE" : "BUY_CE";
  const dec = ledger ? ledger.filter((r) => r && r.type === "decision" && r.candleClosed && Number(r.decidedAt) <= t.execTs).sort((a, b) => a.decidedAt - b.decidedAt).pop() || null : null;
  const checks: AuditRow["checks"] = [];
  if (!ledger) checks.push({ key: "arbiter", ok: null, text: "Arbiter decisions were not recorded on this day" });
  else if (!dec) checks.push({ key: "arbiter", ok: false, text: `No arbiter decision before this trade — not ${want}` });
  else {
    const fresh = t.execTs - Number(dec.candleTime) <= 15 * 60;
    checks.push({ key: "arbiter", ok: dec.finalAction === want && fresh, text: dec.finalAction === want ? (fresh ? `Arbiter ${dec.finalAction} (${String(dec.candleIso).slice(11, 16)})` : `Arbiter ${dec.finalAction} but ${Math.round((t.execTs - dec.candleTime) / 60)} min old`) : `Arbiter said ${dec.finalAction} at ${String(dec.candleIso).slice(11, 16)} — not ${want}` });
  }
  const sl = t.sl, entry = t.entry, rr = rrNum(t.rr);
  checks.push({ key: "stop", ok: sl != null && entry != null ? sl > 0.05 && sl < entry : null, text: sl == null ? "No stop recorded" : sl <= 0.05 ? `SL ₹${sl} — not a real stop` : entry != null && sl >= entry ? "SL not below entry" : `SL ₹${sl} (${entry != null ? Math.round((entry - sl) * 100) / 100 : "—"} below entry)` });
  checks.push({ key: "target", ok: rr == null ? null : rr <= 6, text: rr == null ? "No R:R recorded" : rr > 6 ? `R:R 1:${rr} — target from a far level, out of reach intraday` : `R:R 1:${rr}` });
  if (t0.status !== t.status) checks.push({ key: "label", ok: false, text: `Was labelled "${t0.status}" — actually an EOD exit (target/SL never touched)` });
  const hard = checks.filter((c) => c.key !== "label");
  const verdict: AuditRow["verdict"] = !ledger ? (hard.some((c) => c.ok === false) ? "BLOCKED" : "NOT RECORDED") : hard.some((c) => c.ok === false) ? "BLOCKED" : "ALLOWED";
  return {
    id: t.id, date: t.date, time: t.time, index: t.index, type: t.type, strike: t.strike ?? null, entry, sl, target: t.target ?? null, rr: t.rr ?? null,
    status: t.status, points: t.exitPrice != null && entry != null ? Math.round((t.exitPrice - entry) * 100) / 100 : null,
    source: /Auto signal/.test(t.remarks || "") ? "AUTO" : "MANUAL",
    arbiter: dec ? { action: dec.finalAction, candle: String(dec.candleIso).slice(11, 16) } : null, arbiterRecorded: !!ledger, checks, verdict,
  };
}

export function summarizeAudit(rows: AuditRow[]) {
  const sum = (rs: AuditRow[]) => Math.round(rs.reduce((a, r) => a + (r.points ?? 0), 0) * 100) / 100;
  const by = (v: AuditRow["verdict"]) => rows.filter((r) => r.verdict === v);
  const days = new Map<string, number>(); rows.forEach((r) => days.set(r.date, (days.get(r.date) || 0) + 1));
  return {
    trades: rows.length, auto: rows.filter((r) => r.source === "AUTO").length, manual: rows.filter((r) => r.source === "MANUAL").length,
    blocked: by("BLOCKED").length, blockedPoints: sum(by("BLOCKED")), allowed: by("ALLOWED").length, allowedPoints: sum(by("ALLOWED")),
    notRecorded: by("NOT RECORDED").length, notRecordedPoints: sum(by("NOT RECORDED")), totalPoints: sum(rows),
    relabelled: rows.filter((r) => r.checks.some((c) => c.key === "label")).length,
    busiestDay: [...days.entries()].sort((a, b) => b[1] - a[1])[0] || null,
  };
}
