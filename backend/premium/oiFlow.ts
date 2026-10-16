// ============================ OI Movement — what the option writers are doing (pure, no I/O) ============================
// From the live Dhan option chain: total call / put OI and PCR, the nearest strong call wall (resistance, above the price)
// and put wall (support, below), where writers are adding / covering near the price TODAY (Dhan's change vs the previous
// close), a 5-minute timeline built from the app's own chain snapshots (where OI moved most in each 5-minute window), and
// the OI TILT — the share of fresh put writing (bull side) vs call writing (bear side) near the price. The tilt is a
// description of who is writing more, NOT a validated win probability. Units: lakh contracts (L).

export interface Strike { strike: number; ceOi: number; peOi: number; ceChg: number; peChg: number }
export interface Snap { ageMin: number; strikes: Strike[] }
const L = (v: number) => Math.round((v / 1e5) * 10) / 10;
const sgnL = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(L(v)).toFixed(1)}L`;
const meaning = (side: "CE" | "PE", chg: number) => side === "PE" ? (chg > 0 ? "put writers adding = support building" : "put writers covering = support weakening")
  : (chg > 0 ? "call writers adding = resistance building" : "call writers covering = resistance weakening");
/** Bull share of fresh writing: put adds + call covering count for bulls; call adds + put covering for bears. */
function tilt(ce: number, pe: number) {
  const bull = Math.max(pe, 0) + Math.max(-ce, 0), bear = Math.max(ce, 0) + Math.max(-pe, 0), t = bull + bear;
  return t > 0 ? Math.round((bull / t) * 100) : null;
}

export function oiFlow(o: { strikes: Strike[]; spot: number; step: number; snaps?: Snap[] | null; prev?: Snap | null; nearSteps?: number }) {
  const S = o.strikes.filter((s) => Number.isFinite(s.strike)); if (!S.length || !(o.spot > 0)) return null;
  const sum = (a: Strike[], f: (s: Strike) => number) => a.reduce((x, s) => x + (Number(f(s)) || 0), 0);
  const ceT = sum(S, (s) => s.ceOi), peT = sum(S, (s) => s.peOi), ceC = sum(S, (s) => s.ceChg), peC = sum(S, (s) => s.peChg);
  const pcr = ceT > 0 ? Math.round((peT / ceT) * 100) / 100 : null;
  const k = (o.nearSteps ?? 6) * o.step, near = S.filter((s) => Math.abs(s.strike - o.spot) <= k);
  // nearest STRONG walls: the biggest OI within ±12 steps on the correct side of the price; the chain's biggest when different
  const band = S.filter((s) => Math.abs(s.strike - o.spot) <= 12 * o.step);
  const maxBy = (a: Strike[], f: (s: Strike) => number) => (a.length ? a.reduce((x, s) => (f(s) > f(x) ? s : x)) : null);
  const cw = maxBy(band.filter((s) => s.strike >= o.spot), (s) => s.ceOi) ?? maxBy(S, (s) => s.ceOi)!;
  const pw = maxBy(band.filter((s) => s.strike <= o.spot), (s) => s.peOi) ?? maxBy(S, (s) => s.peOi)!;
  const cwAll = maxBy(S, (s) => s.ceOi)!, pwAll = maxBy(S, (s) => s.peOi)!;
  const nCe = sum(near, (s) => s.ceChg), nPe = sum(near, (s) => s.peChg), tiltToday = tilt(nCe, nPe);
  const bias = tiltToday == null ? "NEUTRAL" : tiltToday >= 60 ? "BULLISH" : tiltToday <= 40 ? "BEARISH" : "NEUTRAL";
  const biasWhy = bias === "BULLISH" ? "put writers are adding more than call writers near the price (support building)"
    : bias === "BEARISH" ? "call writers are adding more than put writers near the price (resistance building)"
    : "writers on both sides are roughly balanced near the price";
  const movers = near.flatMap((s) => [{ side: "CE" as const, strike: s.strike, chg: s.ceChg }, { side: "PE" as const, strike: s.strike, chg: s.peChg }])
    .filter((x) => x.chg).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 3)
    .map((x) => ({ ...x, chgL: L(x.chg), meaning: meaning(x.side, x.chg) }));
  // 5-minute timeline: snapshots ~15/10/5 min ago + now → three 5-minute windows, each with where OI moved most
  const snaps = [...(o.snaps || (o.prev ? [o.prev] : []))].sort((a, b) => b.ageMin - a.ageMin);
  const pts: Snap[] = [...snaps, { ageMin: 0, strikes: S }];
  const windows: { fromMin: number; toMin: number; ce: number; pe: number; tilt: number | null; top: { side: "CE" | "PE"; strike: number; chg: number; meaning: string } | null }[] = [];
  const diff = (a: Snap, b: Snap) => {
    const pm = new Map(a.strikes.map((s) => [s.strike, s]));
    const d = near.map((s) => { const x = b.strikes.find((y) => y.strike === s.strike), p = pm.get(s.strike); return x && p ? { strike: s.strike, ce: x.ceOi - p.ceOi, pe: x.peOi - p.peOi } : null; }).filter(Boolean) as { strike: number; ce: number; pe: number }[];
    const top = d.flatMap((x) => [{ side: "CE" as const, strike: x.strike, chg: x.ce }, { side: "PE" as const, strike: x.strike, chg: x.pe }]).sort((p, q) => Math.abs(q.chg) - Math.abs(p.chg))[0];
    const ce = d.reduce((s2, x) => s2 + x.ce, 0), pe = d.reduce((s2, x) => s2 + x.pe, 0);
    return { ce, pe, tilt: tilt(ce, pe), top: top && top.chg ? { ...top, meaning: meaning(top.side, top.chg) } : null };
  };
  for (let i = 1; i < pts.length; i++) windows.push({ fromMin: Math.round(pts[i - 1].ageMin), toMin: Math.round(pts[i].ageMin), ...diff(pts[i - 1], pts[i]) });
  const last15 = pts.length > 1 ? { ageMin: Math.round(pts[0].ageMin), ...diff(pts[0], pts[pts.length - 1]) } : null;
  return {
    pcr, chgPcr: ceC > 0 && peC > 0 ? Math.round((peC / ceC) * 100) / 100 : null, totalCeL: L(ceT), totalPeL: L(peT), totalCeChg: ceC, totalPeChg: peC,
    callWall: { strike: cw.strike, oiL: L(cw.ceOi), chg: cw.ceChg, chainMax: cwAll.strike !== cw.strike ? { strike: cwAll.strike, oiL: L(cwAll.ceOi) } : null },
    putWall: { strike: pw.strike, oiL: L(pw.peOi), chg: pw.peChg, chainMax: pwAll.strike !== pw.strike ? { strike: pwAll.strike, oiL: L(pwAll.peOi) } : null },
    near: { ce: nCe, pe: nPe, fromStrike: o.spot - k, toStrike: o.spot + k }, tiltToday, bias, biasWhy, movers, windows, last15,
  };
}
export type OiFlow = NonNullable<ReturnType<typeof oiFlow>>;

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const tiltTxt = (t: number | null) => (t == null ? "—" : `Bulls ${t}% · Bears ${100 - t}%`);
/** Telegram block. compact = totals + tilt + the latest 5-minute window only. */
export function oiHtml(f: OiFlow, o: { compact?: boolean; expiry?: string | null } = {}): string[] {
  const out: string[] = [];
  const w = (x: OiFlow["windows"][number]) => `${x.fromMin}→${x.toMin} min ago: CE ${sgnL(x.ce)} · PE ${sgnL(x.pe)}${x.top ? ` · most at <b>${x.top.side} ${n0(x.top.strike)} ${sgnL(x.top.chg)}</b> (${esc(x.top.meaning)})` : ""}`;
  const lastW = f.windows[f.windows.length - 1];
  if (o.compact) {
    out.push(`📊 OI: total CE ${f.totalCeL}L · PE ${f.totalPeL}L · PCR <b>${f.pcr ?? "—"}</b> · tilt <b>${tiltTxt(f.tiltToday)}</b> (${f.bias})`);
    if (lastW) out.push(`   last 5 min ${w(lastW).replace(/^\d+→\d+ min ago: /, "")}`);
    return out;
  }
  out.push(`📊 <b>OI MOVEMENT</b>${o.expiry ? ` (expiry ${esc(o.expiry)})` : ""}`);
  out.push(`Total OI: CE <b>${f.totalCeL}L</b> (${sgnL(f.totalCeChg)} today) · PE <b>${f.totalPeL}L</b> (${sgnL(f.totalPeChg)} today) · PCR <b>${f.pcr ?? "—"}</b>`);
  out.push(`⚖️ OI tilt near the price today: <b>${tiltTxt(f.tiltToday)}</b> → <b>${f.bias}</b> — ${esc(f.biasWhy)}`);
  out.push(`🧱 Call wall <b>${n0(f.callWall.strike)}</b> · ${f.callWall.oiL}L (${sgnL(f.callWall.chg)} today) = resistance${f.callWall.chainMax ? ` · chain's biggest ${n0(f.callWall.chainMax.strike)} (${f.callWall.chainMax.oiL}L)` : ""}`);
  out.push(`🛡 Put wall <b>${n0(f.putWall.strike)}</b> · ${f.putWall.oiL}L (${sgnL(f.putWall.chg)} today) = support${f.putWall.chainMax ? ` · chain's biggest ${n0(f.putWall.chainMax.strike)} (${f.putWall.chainMax.oiL}L)` : ""}`);
  out.push(`Near the price (${n0(f.near.fromStrike)}–${n0(f.near.toStrike)}) today: CE ${sgnL(f.near.ce)} · PE ${sgnL(f.near.pe)}`);
  for (const m of f.movers) out.push(`• ${m.side} ${n0(m.strike)} ${sgnL(m.chg)} — ${esc(m.meaning)}`);
  if (f.windows.length) {
    out.push(`⏱ <b>Every 5 min — where OI moved most</b>`);
    for (const x of f.windows) out.push(`  ${w(x)} · tilt ${tiltTxt(x.tilt)}`);
  }
  out.push(`<i>"today" = vs the previous close (Dhan chain) · 5-min windows from the app's own chain snapshots · tilt = share of fresh writing, not a tested win probability</i>`);
  return out;
}
