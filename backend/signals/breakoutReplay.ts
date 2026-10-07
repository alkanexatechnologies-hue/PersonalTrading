// TLS: trust system + bundled CAs (same as server.ts / Test Lab CLI) so Dhan HTTPS
// works standalone behind antivirus/proxy roots. Must run before any fetch.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    anyTls.setDefaultCACertificates([...(anyTls.getCACertificates("bundled") || []), ...(anyTls.getCACertificates("system") || [])]);
  }
} catch { /* older Node */ }

// Breakout Engine historical replay (research). Strict no-look-ahead: each
// session is evaluated with only the candles that had closed by each bar; fills
// are at the next bar's open; outcomes are a forward walk (never an input).
//
//   tsx backend/signals/breakoutReplay.ts [fromDate] [toDate] [INDEX,INDEX,...]
//   tsx backend/signals/breakoutReplay.ts 2026-08-01 2026-10-06 NIFTY,BANKNIFTY,FINNIFTY,SENSEX
//   BREAKOUT_CFG='{"extVwapAtr":99}' tsx ...   (research override — never changes the live default)
//
// "Before" = the existing Universal Indicator engine (Test Lab, unchanged) run on
// the SAME spot candles in SPOT_DIRECTION mode. Option P&L is not replayed: there
// is no historical option chain, so results are in UNDERLYING R-multiples.

import fs from "node:fs";
import path from "node:path";
import { Candle } from "../types";
import { lookupDhanSecurity } from "../data/dhanInstruments";
import { fetchDhanCandles } from "../data/dhanHistorical";
import { runSession, walkOutcome, istDate, BarEval, Signal, BREAKOUT_CONFIG } from "./breakoutEngine";
import { runEngine } from "../testlab/engine";
import { defaultConfig } from "../testlab/config";
import { INDEX_MASTER } from "../testlab/config";
import { IndexKey } from "../testlab/types";

const INDEXES: Record<string, { key: IndexKey | null; nse: string; symbol: string }> = {
  NIFTY: { key: "NIFTY", nse: "NIFTY", symbol: "^NSEI" },
  BANKNIFTY: { key: "BANKNIFTY", nse: "BANKNIFTY", symbol: "^NSEBANK" },
  FINNIFTY: { key: "FINNIFTY", nse: "FINNIFTY", symbol: "^CNXFIN" },
  SENSEX: { key: "SENSEX", nse: "SENSEX", symbol: "^BSESN" },
};

interface Agg { trades: number[]; }
function stats(rs: number[]) {
  const wins = rs.filter((r) => r > 0).length;
  let cum = 0, peak = 0, dd = 0; rs.forEach((r) => { cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); });
  const sum = rs.reduce((a, b) => a + b, 0);
  return {
    trades: rs.length, wins, losses: rs.filter((r) => r < 0).length,
    winRate: rs.length ? +(wins / rs.length * 100).toFixed(1) : 0,
    avgR: rs.length ? +(sum / rs.length).toFixed(3) : 0,
    expectancy: rs.length ? +(sum / rs.length).toFixed(3) : 0,
    netR: +sum.toFixed(2), maxDrawdownR: +dd.toFixed(2),
  };
}

async function main() {
  const [, , fromArg, toArg, idxArg] = process.argv;
  const override = process.env.BREAKOUT_CFG ? JSON.parse(process.env.BREAKOUT_CFG) : {};
  const cfg = { ...BREAKOUT_CONFIG, ...override };
  const toDate = toArg || istDate(Math.floor(Date.now() / 1000));
  const fromDate = fromArg || new Date(new Date(toDate + "T00:00:00Z").getTime() - 60 * 86400000).toISOString().slice(0, 10);
  const names = (idxArg || "NIFTY,BANKNIFTY,FINNIFTY,SENSEX").split(",").map((s) => s.trim().toUpperCase()).filter((s) => INDEXES[s]);
  const outDir = path.join(process.cwd(), "data", "breakout-replay", `run-${new Date(Date.now() + 19800000).toISOString().slice(0, 19).replace(/[-:T]/g, "")}`);
  fs.mkdirSync(outDir, { recursive: true });
  const auditStream = fs.createWriteStream(path.join(outDir, "audit.jsonl"));
  const sigRows: string[] = ["index,iso,dir,trigger,triggerType,entry,stopLoss,target1,target2,risk,reward,rr,fill,result,rMultiple,mfeR,maeR,reachedT2,slReason,targetReason"];

  const report: any = { fromDate, toDate, config: cfg, override, indexes: {}, note: "Underlying R-multiples (no historical option chain). Fill = next bar open; SL-first on ambiguous bars; flatten 15:20 IST." };
  const allAfter: number[] = [], allBefore: number[] = [];
  const totals: any = { states: {}, rrReasons: {}, falseBreakRows: 0, falseAfterEntry: 0, missedWinners: 0, missedUnknown: 0, rrRejections: 0 };

  for (const name of names) {
    const meta = INDEXES[name];
    const sec = await lookupDhanSecurity(meta.nse);
    if (!sec) { console.log(`[replay] ${name}: no Dhan security`); continue; }
    const warmStart = new Date(new Date(fromDate + "T00:00:00Z").getTime() - 10 * 86400000).toISOString().slice(0, 10);
    const nextDay = new Date(new Date(toDate + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
    let candles: Candle[] = [];
    try { candles = await fetchDhanCandles(sec, "5", warmStart, nextDay); } catch (e: any) { console.log(`[replay] ${name}: fetch failed ${e?.message}`); continue; }
    candles = candles.filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
    const days = Array.from(new Set(candles.map((c) => istDate(c.time)))).filter((d) => d >= fromDate && d <= toDate);
    console.log(`[replay] ${name}: ${candles.length} candles, ${days.length} sessions`);

    const after: number[] = [];
    const st: any = { states: {}, rrReasons: {}, signals: 0, buy: 0, sell: 0, falseBreakRows: 0, falseAfterEntry: 0, missedWinners: 0, missedUnknown: 0, rrRejections: 0 };
    for (const d of days) {
      const endIdx = candles.findIndex((c) => istDate(c.time) > d);
      const upto = candles.slice(0, endIdx < 0 ? candles.length : endIdx);
      const slice = upto.slice(Math.max(0, upto.length - 450));    // ~6 sessions of history (EMA50/structure warm-up)
      const res = runSession(slice, { sessionDate: d, intervalSec: 300, withOutcomes: true }, cfg);
      for (const r of res.rows) {
        st.states[r.state] = (st.states[r.state] || 0) + 1;
        if (r.breakoutStatus === "FALSE BREAK") st.falseBreakRows++;
        if (r.rrBlockReason) {
          st.rrRejections++;
          const key = r.rrBlockReason.replace(/R:R 1:[\d.]+ below 1:[\d.]+ — /, "").split(" — ")[0];
          st.rrReasons[key] = (st.rrReasons[key] || 0) + 1;
          // Missed-trade audit (post-hoc only): would the blocked plan have hit T1 first?
          if (r.plan) {
            const o = walkOutcome(slice, { barTime: r.time, iso: r.iso, dir: r.plan.dir, plan: r.plan, buyScore: r.bias.buyScore, sellScore: r.bias.sellScore, bias: r.bias.direction }, cfg);
            if (o && o.result === "T1") st.missedWinners++;
          } else st.missedUnknown++;
        }
        auditStream.write(JSON.stringify(auditRow(name, r)) + "\n");
      }
      for (const s of res.signals) {
        st.signals++; s.dir === "BUY" ? st.buy++ : st.sell++;
        if (s.outcome) {
          after.push(s.outcome.rMultiple);
          // false breakout after entry: closed back through the trigger within 3 bars of the fill
          const fi = slice.findIndex((c) => c.time === s.barTime) + 1;
          const back = slice.slice(fi, fi + 3).some((c) => s.dir === "BUY" ? c.close < s.plan.trigger : c.close > s.plan.trigger);
          if (back) st.falseAfterEntry++;
        }
        sigRows.push(sigCsv(name, s));
      }
    }

    // ---- BEFORE: existing Universal Indicator engine on the same spot candles ----
    let before: any = null;
    if (meta.key && INDEX_MASTER[meta.key]) {
      const cfg: any = { ...defaultConfig(meta.key, "5m"), dataMode: "SPOT_DIRECTION", scope: { mode: "custom", fromDate, toDate } };
      const firstIdx = candles.findIndex((c) => istDate(c.time) >= fromDate);
      const lastIdx = candles.findIndex((c) => istDate(c.time) > toDate);
      const use = candles.slice(Math.max(0, firstIdx - cfg.warmupCandles), lastIdx < 0 ? candles.length : lastIdx);
      const warm = Math.min(cfg.warmupCandles, firstIdx < 0 ? 0 : firstIdx);
      const out = runEngine({
        config: cfg, candles: use, oi: use.map(() => null), oiStatus: "UNAVAILABLE", vwapSource: "SPOT", symbol: meta.symbol,
        binding: { underlying: name, futuresSymbol: null, securityId: null, expiry: null, exchangeSegment: null, lotSize: null, status: "UNAVAILABLE_HISTORICAL", bindingReason: "spot replay" },
        expiryForDate: () => ({ expiryDate: null, daysToExpiry: null, isExpiryDay: false }), warmupCount: warm,
      });
      const rs = out.trades.map((t) => t.rMultiple ?? 0);
      allBefore.push(...rs);
      before = { buy: out.metrics.buy, sell: out.metrics.sell, wait: out.metrics.wait, ...stats(rs), gateBlocks: out.gateBlocks };
    }

    allAfter.push(...after);
    report.indexes[name] = { sessions: days.length, after: { ...stats(after), signals: st.signals, buy: st.buy, sell: st.sell, states: st.states, falseBreakRows: st.falseBreakRows, falseAfterEntry: st.falseAfterEntry, rrRejections: st.rrRejections, rrReasons: st.rrReasons, missedWinners: st.missedWinners, missedUnknown: st.missedUnknown }, before };
    for (const [k, v] of Object.entries(st.states)) totals.states[k] = (totals.states[k] || 0) + (v as number);
    for (const [k, v] of Object.entries(st.rrReasons)) totals.rrReasons[k] = (totals.rrReasons[k] || 0) + (v as number);
    totals.falseBreakRows += st.falseBreakRows; totals.falseAfterEntry += st.falseAfterEntry; totals.missedWinners += st.missedWinners; totals.missedUnknown += st.missedUnknown; totals.rrRejections += st.rrRejections;
  }
  report.total = { after: { ...stats(allAfter), ...totals }, before: stats(allBefore) };
  auditStream.end();
  fs.writeFileSync(path.join(outDir, "signals.csv"), sigRows.join("\n"));
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nExport: ${outDir}`);
}

function auditRow(index: string, r: BarEval) {
  const p = r.plan;
  return {
    timestamp: r.time, iso: r.iso, index, timeframe: "5m", spot: r.spot, direction: r.bias.direction,
    buyScore: r.bias.buyScore, sellScore: r.bias.sellScore,
    emaState: r.bias.states.ema, vwapState: r.bias.states.vwap, utState: r.bias.states.ut, lrcState: r.bias.states.lrc,
    momentumState: r.bias.states.momentum, structureState: r.bias.states.structure,
    support: r.support?.price ?? null, resistance: r.resistance?.price ?? null,
    triggerLevel: r.triggerLevel, triggerLabel: r.triggerLabel, breakoutStatus: r.breakoutStatus,
    confirmation: r.confirmation, confirmationDetail: r.confirmationDetail, marketPhase: r.marketPhase,
    extension: r.extension, extensionDetail: r.extensionDetail, fakeMove: r.fakeMove, volumeState: r.volumeState,
    optionType: p ? (p.dir === "BUY" ? "CE" : "PE") : null, strike: null, expiry: null, securityId: null, optionLtp: null, // no historical chain
    entry: p?.entry ?? null, stopLoss: p?.stopLoss ?? null, target1: p?.target1 ?? null, target2: p?.target2 ?? null,
    risk: p?.risk ?? null, reward: p?.reward ?? null, rr: p?.rr ?? null, slReason: p?.slReason ?? null, targetReason: p?.targetReason ?? null,
    rrBlockReason: r.rrBlockReason, state: r.state, finalCommand: r.command, rejectionReason: r.rejectionReason, reason: r.reason,
  };
}
function sigCsv(index: string, s: Signal) {
  const p = s.plan, o = s.outcome;
  const q = (v: any) => `"${String(v ?? "").replace(/"/g, "'")}"`;
  return [index, s.iso, s.dir, p.trigger, p.triggerType, p.entry, p.stopLoss, p.target1, p.target2 ?? "", p.risk, p.reward, p.rr, o?.fillPrice ?? "", o?.result ?? "", o?.rMultiple ?? "", o?.mfeR ?? "", o?.maeR ?? "", o?.reachedT2 ?? "", q(p.slReason), q(p.targetReason)].join(",");
}

main().catch((e) => { console.error(e); process.exit(1); });
