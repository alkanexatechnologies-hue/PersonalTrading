// ============================ Trade Review Desk — every trade checked against the Dhan data before it is sent ============================
// The checks an experienced index-option trader runs before pressing BUY: trend on the higher timeframes, a CLOSED 15-min
// candle beyond the start, not chasing, room to the next wall, VWAP side, the option premium and its OI flow confirming,
// liquidity, the arbiter and risk gates, time left in the day, the measured follow-through record, Market Eye and the day's
// discipline (2 losses = stop), and whether the LOGIC lines up (trend · location · fuel · road), followed by the trader's
// reasoning in plain words. Grade A = take, B = take small, C = skip (still shown with the reasons — never hidden).
// Learning: each graded trade stores which checks passed; the closing statement reports which checks separated winners
// from losers once the sample is large enough. Rules are never changed automatically.

export interface Check { key: string; label: string; ok: boolean | null; weight: number; critical?: boolean; detail: string }
const r = (v: number) => Math.round(v);
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function reviewTrade(d: any, side: "bull" | "bear", x: { istMin: number; eye?: { lead: string; upPct: number; downPct: number } | null; lossesToday?: number }) {
  const T = d?.trader, p = T?.plans?.[side]; if (!T || !p) return null;
  const ce = side === "bull", dir = ce ? 1 : -1, want = ce ? "UP" : "DOWN", opp = ce ? "DOWN" : "UP";
  const spot: number = d.spot?.price, atr: number = T.atr15 || 1, C: Check[] = [];
  const add = (c: Check) => C.push(c);
  // 1. higher timeframes
  const tr = (T.trends || []) as { tf: string; verdict: string }[], agree = tr.filter((t) => t.verdict === want).length, against = tr.filter((t) => t.verdict === opp).length;
  add({ key: "trend", label: "trend", weight: 2, ok: agree >= 2 && against === 0 ? true : against >= 2 ? false : null, detail: tr.map((t) => `${t.tf} ${t.verdict}`).join(" · ") || "—" });
  // 2. a CLOSED 15-min candle beyond the start
  const st = T.radar?.[side]?.state;
  add({ key: "close", label: "15-min close", weight: 2, critical: true, ok: st === "TRIGGERED" ? true : st === "ARMED" ? null : false, detail: st ? `radar ${st}` : "—" });
  // 3. not chasing
  const run = dir * (spot - p.entry), toT1 = dir * (p.t1 - p.entry);
  add({ key: "chase", label: "not chasing", weight: 1.5, critical: true, ok: run <= 0.5 * atr ? true : toT1 > 0 && run >= 0.6 * toT1 ? false : null, detail: run <= 0 ? `start not reached yet (${r(-run)} pts away)` : `${r(run)} pts past the start (limit ½ ATR = ${r(0.5 * atr)}; T1 is ${r(toT1)} beyond the start)` });
  // 4. reward : risk
  add({ key: "rr", label: `R:R 1:${p.rr ?? "—"}`, weight: 1, critical: p.rr != null && p.rr < 1, ok: p.rr == null ? null : p.rr >= 1.5 ? true : p.rr < 1 ? false : null, detail: `R:R 1:${p.rr ?? "—"}` });
  // 5. room to the next wall
  const risk = Math.abs(p.entry - p.stop), room = p.triggerRisk?.roomPts;
  add({ key: "room", label: "room", weight: 1, ok: room == null ? true : room >= 1.5 * risk ? true : room < risk ? false : null, detail: room == null ? "open space beyond" : `${r(room)} pts of room vs ${r(risk)} pts risk` });
  // 6. VWAP side
  const vw = (d.chart?.vwap || []).filter((v: any) => Number.isFinite(v)).slice(-1)[0];
  add({ key: "vwap", label: "VWAP side", weight: 1, ok: vw == null ? null : dir * (spot - vw) > 0, detail: vw == null ? "—" : `price ${r(spot)} is ${spot >= vw ? "above" : "below"} VWAP ${r(vw)}` });
  // 7. the option premium confirming
  const leg = ce ? d.ce : d.pe, resp = leg?.behaviour?.response;
  add({ key: "premium", label: "premium confirming", weight: 1.5, ok: resp === "RISING" ? true : resp === "FALLING" ? false : null, detail: `${ce ? "CE" : "PE"} premium ${resp ? resp.toLowerCase() : "—"}` });
  // 8. OI flow on the plan strike
  const row = (d.ranking || []).find((z: any) => z.side === (ce ? "CE" : "PE") && z.strike === p.strike) || leg;
  const chg = row?.change, oic = row?.oiChg;
  const flow = chg == null || oic == null ? null : chg > 0 && oic > 0 ? "long build-up" : chg > 0 && oic < 0 ? "short covering" : chg < 0 && oic > 0 ? "writers adding (selling into it)" : "long unwinding";
  add({ key: "oi", label: "OI flow", weight: 1, ok: flow == null ? null : chg > 0 ? true : oic > 0 ? false : null, detail: flow ?? "—" });
  // 9. liquidity
  const liq = row?.liquidity?.status ?? row?.liquidity ?? leg?.liquidity?.status;
  add({ key: "liquidity", label: "liquidity", weight: 1, critical: liq === "POOR" || liq === "BAD", ok: liq == null ? null : liq === "GOOD" || liq === "OK" ? true : liq === "POOR" || liq === "BAD" ? false : null, detail: `spread ${liq ?? "—"}` });
  // 10. arbiter + risk gates (the existing final authority)
  const arb = String(d.master?.arbiterSays || "");
  add({ key: "arbiter", label: "arbiter", weight: 1.5, ok: /^GO/i.test(arb) ? true : /CONFLICT|VETO|AVOID/i.test(arb) ? false : null, detail: arb.split(" — ")[0] || "—" });
  const gates = d.master?.riskGate;
  add({ key: "gates", label: "risk gates", weight: 1, ok: gates ? !!gates.ok : null, detail: gates ? (gates.gates || []).filter((g: any) => !g.ok).map((g: any) => g.detail).join("; ") || "all pass" : "—" });
  // 11. time left
  add({ key: "time", label: "time", weight: 1, critical: x.istMin > 885, ok: x.istMin <= 870 ? true : x.istMin > 885 ? false : null, detail: x.istMin > 885 ? "after 14:45 — no new buys" : x.istMin > 870 ? "late — little time for the move" : "enough time" });
  // 12. measured follow-through of breaks in this direction
  const es = T.eventStats?.[ce ? "up" : "down"];
  add({ key: "history", label: "break record", weight: 0.5, ok: !es?.n ? null : es.pct >= 55 ? true : es.pct <= 45 ? false : null, detail: es?.n ? `${es.pct}% of ${es.n} breaks followed through` : "—" });
  // 13. Market Eye (next 30 min in similar moments)
  if (x.eye) add({ key: "eye", label: "Market Eye", weight: 1, ok: x.eye.lead === want ? true : x.eye.lead === opp ? false : null, detail: `next 30m ↑${x.eye.upPct}% ↓${x.eye.downPct}% → ${x.eye.lead}` });
  // 14. discipline
  const lt = x.lossesToday ?? 0;
  add({ key: "discipline", label: "discipline", weight: 1, critical: lt >= 2, ok: lt >= 2 ? false : true, detail: lt >= 2 ? `${lt} losses today — stop for the day` : `${lt} loss(es) today` });

  // 15. LOGIC LINES UP — the four pillars a veteran needs before any trade: trend, location, fuel, road
  const get = (k: string) => C.find((c) => c.key === k)?.ok;
  const pillars = [
    { name: "trend", ok: get("trend") },
    { name: "location", ok: get("close") === true && get("chase") !== false },
    { name: "fuel", ok: get("premium") === true || get("oi") === true ? (get("premium") === false || get("oi") === false ? null : true) : get("premium") === false && get("oi") === false ? false : null },
    { name: "road", ok: get("room") === true && get("rr") !== false },
  ];
  const strong = pillars.filter((x) => x.ok === true).length, broken = pillars.filter((x) => x.ok === false).map((x) => x.name);
  add({ key: "logic", label: "logic lines up", weight: 2, ok: strong >= 3 && !broken.length ? true : broken.length >= 2 ? false : null, detail: `${strong}/4 pillars solid${broken.length ? ` · broken: ${broken.join(", ")}` : ""}` });

  const tot = C.reduce((a, c) => a + c.weight, 0), got = C.reduce((a, c) => a + c.weight * (c.ok === true ? 1 : c.ok === null ? 0.5 : 0), 0);
  const score = r((got / tot) * 100), crit = C.filter((c) => c.critical && c.ok === false);
  const grade: "A" | "B" | "C" = crit.length ? "C" : score >= 75 ? "A" : score >= 60 ? "B" : "C";
  const verdict = grade === "A" ? "TAKE — normal size" : grade === "B" ? "TAKE SMALL — half size" : "SKIP — watch only";
  // THE TRADER'S REASONING — decisive, built only from the numbers above (nothing invented)
  const n = (v: number) => Math.round(v).toLocaleString("en-IN"), why: string[] = [];
  const tc = C.find((c) => c.key === "trend")!, pc = C.find((c) => c.key === "premium")!, oc = C.find((c) => c.key === "oi")!;
  why.push(tc.ok === true ? `Trend: ${tc.detail} — we trade WITH the higher timeframes.` : tc.ok === false ? `Trend: ${tc.detail} — this is AGAINST the higher timeframes; counter-trend trades get paid less and stopped more.` : `Trend: ${tc.detail} — mixed; no tailwind, the level has to do the work.`);
  why.push(st === "TRIGGERED" ? `Location: a 15-min candle CLOSED ${ce ? "above" : "below"} ${n(p.entry)}${p.triggerLabel ? ` (${p.triggerLabel})` : ""} — the level gave way, that is the trigger.` : st === "ARMED" ? `Location: price is through ${n(p.entry)} but the candle is not closed — no close, no trade.` : `Location: ${n(p.entry)}${p.triggerLabel ? ` (${p.triggerLabel})` : ""} is not broken on a close — nothing to do yet.`);
  why.push(pc.ok === true || oc.ok === true ? `Fuel: ${pc.detail}, ${oc.detail} — money is moving our way.` : pc.ok === false || oc.ok === false ? `Fuel: ${pc.detail}, ${oc.detail} — the option is not confirming; a breakout without premium follow-through is a trap.` : `Fuel: ${pc.detail} — no confirmation either way yet.`);
  why.push(`Road: ${C.find((c) => c.key === "room")!.detail}; target ${n(p.t1)}${p.t2 ? ` then ${n(p.t2)}` : ""}, R:R 1:${p.rr ?? "—"}.`);
  why.push(`Wrong if: a 15-min candle closes ${ce ? "below" : "above"} ${n(p.stop)} — then the idea is dead: exit, no averaging, no hoping.`);
  const worst = C.filter((c) => c.ok === false && c.key !== "logic").sort((a, b) => b.weight - a.weight)[0];
  if (worst && !(worst.critical && crit[0] === worst)) why.push(`Respect: ${worst.label} — ${worst.detail}.`);
  why.push(grade === "A" ? `Decision: TAKE IT. Normal size. The logic lines up — execute, don't second-guess.`
    : grade === "B" ? `Decision: TAKE SMALL — half size. ${worst ? `${worst.label} is the weak spot` : "One pillar is soft"}; if it confirms, the trade will show it quickly.`
    : `Decision: PASS. ${crit.length ? `${crit[0].label} — ${crit[0].detail}` : `only ${strong}/4 pillars solid`}. No trade is also a position — capital waits for the clean one.`);
  return { side, grade, score, verdict, reasoning: why, checks: C, critical: crit.map((c) => `${c.label}: ${c.detail}`), passed: C.filter((c) => c.ok === true).map((c) => c.key), failed: C.filter((c) => c.ok === false).map((c) => c.key) };
}
export type Review = NonNullable<ReturnType<typeof reviewTrade>>;

/** Compact HTML block for Telegram. */
export function reviewHtml(rv: Review, full = true): string {
  const L = [`🧪 <b>Trade review: ${rv.grade}</b> (${rv.score}%) → <b>${esc(rv.verdict)}</b>`];
  L.push(`  ${rv.checks.map((c) => `${c.ok === true ? "✓" : c.ok === false ? "✗" : "~"} ${esc(c.label)}`).join(" · ")}`);
  const bad = rv.checks.filter((c) => c.ok === false);
  if (bad.length) L.push(`  ⚠️ ${bad.map((c) => `${esc(c.label)}: ${esc(c.detail)}`).join(" | ")}`);
  if (full && rv.reasoning?.length) L.push(`🧠 <b>Trader's reasoning</b>`, ...rv.reasoning.map((x, i) => (i === rv.reasoning.length - 1 ? `  <b>${esc(x)}</b>` : `  • ${esc(x)}`)));
  return L.join("\n");
}

// ---------------------------------------------------------------- learning: which checks separated winners from losers
export interface ReviewStats { checks: Record<string, { passN: number; passWin: number; failN: number; failWin: number }>; trades: number }
export function learn(stats: ReviewStats, trades: { passed: string[]; failed: string[]; win: boolean }[]): ReviewStats {
  const s: ReviewStats = { checks: { ...stats.checks }, trades: stats.trades };
  for (const t of trades) {
    s.trades++;
    for (const k of t.passed) { const c = (s.checks[k] = { ...(s.checks[k] || { passN: 0, passWin: 0, failN: 0, failWin: 0 }) }); c.passN++; if (t.win) c.passWin++; }
    for (const k of t.failed) { const c = (s.checks[k] = { ...(s.checks[k] || { passN: 0, passWin: 0, failN: 0, failWin: 0 }) }); c.failN++; if (t.win) c.failWin++; }
  }
  return s;
}
/** Lines for checks with enough trades on both sides (≥ minN each), biggest win-rate gap first. */
export function learnedLines(s: ReviewStats, minN = 10): string[] {
  return Object.entries(s.checks).filter(([, c]) => c.passN >= minN && c.failN >= minN)
    .map(([k, c]) => ({ k, p: (c.passWin / c.passN) * 100, f: (c.failWin / c.failN) * 100, c }))
    .sort((a, b) => Math.abs(b.p - b.f) - Math.abs(a.p - a.f)).slice(0, 4)
    .map((x) => `${x.k}: passed → ${r(x.p)}% wins (n=${x.c.passN}) · failed → ${r(x.f)}% (n=${x.c.failN})`);
}
