// ============================ Liquidity Sweep messages (pure formatting over the Liquidity Analysis engine) ============================
// BULL SIDE = liquidity BELOW the price (sell-stops under lows). A SWEEP = a candle trades through the level and CLOSES back
// above it (engine status REJECTED) → CE idea on the reclaim, stop under the sweep low.
// PUT SIDE  = liquidity ABOVE the price (buy-stops over highs). A sweep that closes back below → PE idea, stop over the high.
// A close BEYOND the level (ACCEPTED / BROKEN) is a real break, not a sweep. Research engine — advisory, the arbiter decides.

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
const short = (n: string) => String(n || "").replace(" 50", "").replace("NIFTY BANK", "BANKNIFTY");
const OUTCOME: Record<string, string> = { REVERSAL: "sweep worked", CONTINUATION: "sweep failed (break continued)", FALSE: "whipsaw", "NO EDGE": "no follow-through", PENDING: "still developing" };
const REVERSED = /Liquidity Grab \+ Rejection|Sweep \+ Reversal/, CONTINUED = /Sweep \+ Continuation/;

/** 20-session record of sweeps per side: how many reversed (the sweep worked) vs continued (it failed). */
export function sweepRecord(history: any[]) {
  const side = (s: "DOWNSIDE" | "UPSIDE") => {
    const ev = (history || []).filter((e) => e.side === s), rev = ev.filter((e) => REVERSED.test(e.pattern)).length, cont = ev.filter((e) => CONTINUED.test(e.pattern)).length;
    return { reversed: rev, continued: cont, n: rev + cont, pct: rev + cont ? Math.round((rev / (rev + cont)) * 100) : null };
  };
  return { bull: side("DOWNSIDE"), put: side("UPSIDE") };
}

export function sweepMapMsg(liq: any, hhmm: string): string {
  const px = liq?.opening?.price, nm = esc(short(liq?.name));
  const L = [`💧 <b>${nm} · LIQUIDITY SWEEP MAP</b> · ${hhmm}`, `Price <b>${n0(px)}</b>${liq?.dataStatus && liq.dataStatus !== "LIVE" ? ` <i>(${esc(liq.dataStatus)})</i>` : ""}`];
  const lv = (liq?.levels || []).filter((l: any) => l.status !== "INVALIDATED");
  const rec = sweepRecord(liq?.history || []);
  const side = (s: "DOWNSIDE" | "UPSIDE") => {
    const bull = s === "DOWNSIDE", mine = lv.filter((l: any) => l.side === s), out: string[] = [];
    out.push(bull ? `🟢 <b>BULL SIDE</b> — sell-stops below · sweep + close back ABOVE = CE idea` : `🔴 <b>PUT SIDE</b> — buy-stops above · sweep + close back BELOW = PE idea`);
    for (const l of mine.filter((x: any) => x.status === "REJECTED").slice(0, 2))
      out.push(`  ✅ <b>SWEPT ${esc(l.event?.time ?? "")}</b> ${n0(l.price)} ${esc(l.type)} → closed back ${bull ? "above" : "below"}${l.event?.pointsCaptured != null ? ` · then index ${l.event.pointsCaptured >= 0 ? "+" : "−"}${n0(Math.abs(l.event.pointsCaptured))} pts → <b>${esc(OUTCOME[l.event.outcome] ?? l.event.outcome)}</b>` : ""}`);
    for (const l of mine.filter((x: any) => x.status === "ACCEPTED" || x.status === "BROKEN").slice(0, 1))
      out.push(`  ⚠️ ${n0(l.price)} ${esc(l.type)} — <b>${esc(l.status)}</b> (real break${l.event?.time ? ` ${esc(l.event.time)}` : ""}, not a sweep)`);
    const wait = mine.filter((x: any) => ["WAITING", "APPROACHING", "TOUCHED"].includes(x.status)).sort((a: any, b: any) => Math.abs(a.distance ?? 1e9) - Math.abs(b.distance ?? 1e9)).slice(0, 2);
    for (const l of wait) out.push(`  ⏳ next pool <b>${n0(l.price)}</b> ${esc(l.type)} · ${n0(Math.abs(l.distance ?? 0))} pts ${bull ? "below" : "above"}${l.status === "APPROACHING" || l.status === "TOUCHED" ? ` · <b>${esc(l.status)}</b> — sweep zone` : ""}`);
    if (!wait.length && !mine.length) out.push("  no pool on this side");
    const r = bull ? rec.bull : rec.put;
    out.push(`  📊 last 20 sessions: ${r.n ? `${r.reversed}/${r.n} sweeps reversed (${r.pct}%)` : "no sweeps recorded"}`);
    return out;
  };
  L.push(...side("DOWNSIDE"), ...side("UPSIDE"));
  L.push(`<i>Sweep = trades through the level and CLOSES back inside (5-min). A close beyond = real break → no sweep trade. Advisory only.</i>`);
  return L.join("\n");
}

/** Instant alert when a level is swept (closed back inside) for the first time today. */
export function sweepAlertMsg(liq: any, l: any): string {
  const bull = l.side === "DOWNSIDE", nm = esc(short(liq?.name)), rec = sweepRecord(liq?.history || [])[bull ? "bull" : "put"];
  return [`💧 <b>${nm} · ${bull ? "BULL-SIDE" : "PUT-SIDE"} LIQUIDITY SWEEP</b> · ${esc(l.event?.time ?? "")}`,
    `${n0(l.price)} ${esc(l.type)} was taken and the candle <b>closed back ${bull ? "above" : "below"}</b> it — the ${bull ? "sell-stops below" : "buy-stops above"} were collected.`,
    `${bull ? "🟢 CE idea" : "🔴 PE idea"}: only while price holds ${bull ? "above" : "below"} ${n0(l.price)} · <b>Stop Loss: a 5-min close back ${bull ? "below" : "above"} ${n0(l.price)}</b>`,
    `Price now <b>${n0(liq?.opening?.price)}</b> · last 20 sessions: ${rec.n ? `${rec.reversed}/${rec.n} ${bull ? "bull" : "put"}-side sweeps reversed (${rec.pct}%)` : "no record yet"}`,
    `<i>Check the plan, the review and the 15-min close before acting · advisory only</i>`].join("\n");
}
