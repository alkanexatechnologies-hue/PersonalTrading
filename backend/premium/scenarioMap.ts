// ============================ 🗺️ Scenario Map — next session's what-ifs (One Trade tab, owner 2026-10-28) ============================
// From the last completed session's levels (PDH / PDL / PDC, the 5-session high / low, round strikes, OI walls, max pain) and
// the historical odds in scenario-stats.json (scenarioStats.ts, real Dhan 1-min data), build six scenarios for the chart:
// gap down 50–100, gap up 50–100, flat open → falls, flat open → rises, plus the liquidity-sweep pools. Each scenario
// carries its branches (path waypoints in session minutes, with the historical probability), the levels where the market
// may hold / break / recover, and the 1:2 trades (target 40, stop 20 NIFTY pts; SENSEX × 3.25) with their past win % and
// a DEV / VAL consistency verdict. Paths are illustrative timing; the odds are measured. Advisory only, no new co-pilot rule.
import { gapKey } from "./scenarioStats";
import type { IndexStats, LevelStat, TradeStat, GapStat, GapKey } from "./scenarioStats";

export interface SessionHLC { day: string; open: number; high: number; low: number; close: number }
export interface MapInput {
  index: "NIFTY" | "SENSEX"; step: number; base: SessionHLC; prior: SessionHLC[]; spot: number | null;
  callWall: number | null; putWall: number | null; maxPain: number | null; targetDay: string; targetIsToday: boolean;
  /** the session's opening number, picked at 09:11 from the pre-open (or the first candle's open) — re-anchors the map */
  opening?: { price: number; at: number; source: string } | null;
  stats: { all: IndexStats; dev: IndexStats; val: IndexStats };
}
export interface MapLevel { key: string; label: string; price: number; kind: "PD" | "WEEK" | "ROUND" | "OI" | "MP"; note: string }
export interface Waypoint { m: number; p: number; note?: string }
export interface Branch { id: string; name: string; prob: number | null; probNote: string; color: string; path: Waypoint[] }
export interface MapTrade { id: string; label: string; side: "CE" | "PE"; strike: number; entry: number; stop: number; target: number; when: string;
  win: number; avgPts: number; n: number; verdict: "GOOD" | "MIXED" | "AVOID"; verdictText: string; approx: boolean }
export interface LevelRead { key: string; label: string; price: number; role: "S" | "R"; holdPct: number; breakPct: number; sweepPct: number; recoverPct: number; n: number; read: string }
export interface Scenario { id: string; icon: string; title: string; open: number; chance: number | null; chanceNote: string; story: string[];
  branches: Branch[]; levels: LevelRead[]; trades: MapTrade[]; sweep: { price: number; pct: number; label: string }[] }
export interface OpeningRead { price: number; at: number; source: string; gapPts: number; bucket: string; label: string; scenario: string; review: string[] }
export interface ScenarioMap { index: string; base: SessionHLC; targetDay: string; targetIsToday: boolean; k: number; tgt: number; sl: number; opening: OpeningRead | null;
  levels: MapLevel[]; scenarios: Scenario[]; source: string; honesty: string[] }

const f0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const hmI = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const bucketLbl = (g: string, k: number) => { const a = Math.round(50 * k), b = Math.round(100 * k); return ({ BIG_DOWN: `बड़ा Gap Down (${b}+)`, DOWN: `Gap Down ${a}–${b}`, FLAT: `Flat open (±${a})`, UP: `Gap Up ${a}–${b}`, BIG_UP: `बड़ा Gap Up (${b}+)` } as Record<string, string>)[g] || g; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const LBL: Record<string, string> = { PDH: "कल का High (PDH)", PDL: "कल का Low (PDL)", PDC: "कल का Close (PDC)", WH: "5-दिन High", WL: "5-दिन Low", RND_UP: "Round strike ऊपर", RND_DN: "Round strike नीचे" };

/** DEV / VAL consistency of one trade type: GOOD only when both halves made money with a usable sample. */
export function verdict(dev: TradeStat | undefined, val: TradeStat | undefined): { v: MapTrade["verdict"]; text: string } {
  if (!dev || !val || dev.n < 8 || val.n < 8) return { v: "MIXED", text: "⚠️ कम data — सिर्फ़ देखिए" };
  if (dev.avgPts > 2 && val.avgPts > 2) return { v: "GOOD", text: "✅ दोनों हिस्सों (पुराना + नया data) में फ़ायदा" };
  if (dev.avgPts <= 0 && val.avgPts <= 0) return { v: "AVOID", text: "❌ दोनों हिस्सों में घाटा — मत लीजिए" };
  return { v: "MIXED", text: "⚠️ एक हिस्से में फ़ायदा, एक में नहीं — छोटा size या skip" };
}

export function buildScenarioMap(I: MapInput): ScenarioMap {
  const k = I.stats.all.scale, T = 40 * k, SL = 20 * k, B = I.base, step = I.step, P = Math.round(T);
  const wk = [B, ...I.prior].slice(0, 5), WH = Math.max(...wk.map((s) => s.high)), WL = Math.min(...wk.map((s) => s.low));
  const R = k > 1 ? 500 : 100, ref = I.targetIsToday && I.spot ? I.spot : B.close;
  const levels: MapLevel[] = [
    { key: "PDH", label: LBL.PDH, price: B.high, kind: "PD", note: "कल का सबसे ऊँचा भाव — ऊपर की liquidity (stop-loss) यहाँ के ऊपर" },
    { key: "PDL", label: LBL.PDL, price: B.low, kind: "PD", note: "कल का सबसे नीचा भाव — नीचे की liquidity यहाँ के नीचे" },
    { key: "PDC", label: LBL.PDC, price: B.close, kind: "PD", note: "Gap इसी से नापा जाता है; gap fill = यहाँ वापसी" },
  ];
  if (WH > B.high + 5 * k) levels.push({ key: "WH", label: LBL.WH, price: WH, kind: "WEEK", note: "हफ़्ते की बड़ी resistance" });
  if (WL < B.low - 5 * k) levels.push({ key: "WL", label: LBL.WL, price: WL, kind: "WEEK", note: "हफ़्ते का बड़ा support" });
  for (const p of [Math.ceil((ref + 30 * k) / R) * R, Math.floor((ref - 30 * k) / R) * R]) if (!levels.some((l) => Math.abs(l.price - p) < 10 * k))
    levels.push({ key: p > ref ? "RND_UP" : "RND_DN", label: `${f0(p)} round strike`, price: p, kind: "ROUND", note: "बड़ा round strike — option writers यहाँ बैठते हैं" });
  if (I.callWall) levels.push({ key: "CALL_WALL", label: `Call wall ${f0(I.callWall)}`, price: I.callWall, kind: "OI", note: "सबसे बड़ा Call OI — positioning, forecast नहीं (OI study: no edge)" });
  if (I.putWall) levels.push({ key: "PUT_WALL", label: `Put wall ${f0(I.putWall)}`, price: I.putWall, kind: "OI", note: "सबसे बड़ा Put OI — positioning, forecast नहीं (OI study: no edge)" });
  if (I.maxPain) levels.push({ key: "MAX_PAIN", label: `Max pain ${f0(I.maxPain)}`, price: I.maxPain, kind: "MP", note: "Expiry के पास भाव यहाँ खिंच सकता है" });
  levels.sort((a, b) => b.price - a.price);

  const statKey = (key: string) => (key === "CALL_WALL" || key === "PUT_WALL" || key === "MAX_PAIN" ? null : key.startsWith("RND") ? key.split(":")[0] : key);
  const lvlStat = (key: string, role: "S" | "R", s: IndexStats = I.stats.all): LevelStat | undefined => {
    const sk = statKey(key); if (!sk) return undefined;
    return s.levels[`${sk}:${role}`] || (sk.startsWith("RND") ? s.levels[`${role === "S" ? "RND_DN" : "RND_UP"}:${role}`] : undefined);
  };
  const read = (l: MapLevel, open: number): LevelRead | null => {
    const role: "S" | "R" = open > l.price ? "S" : "R", st = lvlStat(l.key, role); if (!st) return null;
    const hold = role === "S" ? "टिकता" : "रोकता", txt = st.holdPct >= st.breakPct ? `${st.holdPct}% बार ${hold} है` : `${st.breakPct}% बार टूटता है — भरोसा कम`;
    return { key: l.key, label: l.label, price: l.price, role, holdPct: st.holdPct, breakPct: st.breakPct, sweepPct: st.sweepPct, recoverPct: st.recoverPct, n: st.n,
      read: `${role === "S" ? "Support" : "Resistance"}: ${txt}; sweep होकर पलटना ${st.sweepPct}%; टूटने के बाद वापसी ${st.recoverPct}%` };
  };
  const trade = (id: string, label: string, dir: 1 | -1, entry: number, when: string, tAll?: TradeStat, tDev?: TradeStat, tVal?: TradeStat, approx = false): MapTrade => {
    const v = verdict(tDev, tVal);
    return { id, label, side: dir > 0 ? "CE" : "PE", strike: Math.round(entry / step) * step, entry: r2(entry), stop: r2(entry - dir * SL), target: r2(entry + dir * T), when,
      win: tAll?.winPct ?? 0, avgPts: tAll?.avgPts ?? 0, n: tAll?.n ?? 0, verdict: v.v, verdictText: v.text, approx };
  };
  const below = (p: number) => levels.filter((l) => l.price < p - 8 * k), above = (p: number) => levels.filter((l) => l.price > p + 8 * k).reverse();
  const firstStat = (ls: MapLevel[], role: "S" | "R") => ls.find((l) => lvlStat(l.key, role)) || ls[0];

  // ---------- gap scenarios ----------
  // the real opening (09:11): its gap bucket picks the scenario and replaces the assumed open
  const O = I.opening && Number.isFinite(I.opening.price) && I.opening.price > 0 ? I.opening : null;   // the route passes it only for the target session (or a what-if)
  const wi = !!O && /what-if/.test(O.source), tagT = wi ? "🔮 अगर: " : "🔔 आज: ";
  const oGap = O ? (O.price - B.close) / k : 0, oKey = O ? gapKey(oGap) : null, oDir: 1 | -1 = oGap < 0 ? -1 : 1;
  const gapScenario = (dir: 1 | -1): Scenario => {
    const real = !!O && oKey !== "FLAT" && oDir === dir;
    const gk: GapKey = real ? oKey! : dir < 0 ? "DOWN" : "UP", g: GapStat = I.stats.all.gaps[gk], gd = I.stats.dev.gaps[gk], gv = I.stats.val.gaps[gk];
    const open = real ? O!.price : B.close + dir * 75 * k, half = (g.medOr15 * k) / 2, orH = open + half, orL = open - half;
    const next = dir < 0 ? firstStat(below(orL), "S") : firstStat(above(orH), "R");
    const nextP = next ? next.price : open + dir * 2 * T;
    const fill: Branch = { id: "fill", name: `Gap fill — ${f0(B.close)} (PDC) तक वापसी`, prob: g.fillPct, probNote: `${g.fillPct}% gap-${dir < 0 ? "down" : "up"} दिनों में gap भरा (10:15 तक ${g.fillBy1015Pct}%)`, color: "#26a69a",
      path: [{ m: 555, p: open, note: "Open" }, { m: 570, p: dir < 0 ? orL : orH, note: dir < 0 ? "पहला dip" : "पहला उछाल" }, { m: 600, p: dir < 0 ? orH + 5 * k : orL - 5 * k, note: dir < 0 ? "OR high पार" : "OR low टूटा" }, { m: 690, p: B.close, note: "Gap fill" }] };
    const go: Branch = { id: "go", name: `Gap की दिशा में और ${P}+ points`, prob: g.contPct, probNote: `${g.contPct}% दिनों में gap की दिशा में पहले ${P} points और चला`, color: "#ef5350",
      path: [{ m: 555, p: open, note: "Open" }, { m: 570, p: dir < 0 ? orH : orL, note: "छोटा pullback" }, { m: 600, p: (dir < 0 ? orL : orH) - dir * 5 * k, note: dir < 0 ? "OR low टूटा" : "OR high टूटा" }, { m: 660, p: open + dir * T + dir * half, note: `+${P}` }, { m: 750, p: dir < 0 ? Math.min(nextP, open - T - half) : Math.max(nextP, open + T + half), note: next?.label || "अगला level" }] };
    const sweep: Branch = { id: "sweep", name: `💧 ${dir < 0 ? "OR low" : "OR high"} sweep फिर पलटना`, prob: dir < 0 ? g.orLowSweepPct : g.orHighSweepPct, probNote: `${dir < 0 ? g.orLowSweepPct : g.orHighSweepPct}% दिनों में पहले 15-min का ${dir < 0 ? "low" : "high"} तोड़कर 30 मिनट में वापस अंदर`, color: "#ffb300",
      path: [{ m: 555, p: open, note: "Open" }, { m: 570, p: dir < 0 ? orL : orH }, { m: 585, p: (dir < 0 ? orL : orH) - dir * 12 * k, note: "💧 Sweep" }, { m: 600, p: dir < 0 ? orL + 3 * k : orH - 3 * k, note: "Reclaim = entry" }, { m: 660, p: (dir < 0 ? orL : orH) - dir * T, note: `+${P}` }] };
    const trades = dir < 0 ? [
      trade("brk", "Gap-down: पहले 15-min का low टूटे (15-min close) → PE", -1, orL - 5 * k, "09:30–11:00, 15-min close OR low के नीचे", g.orBreakDownShort, gd.orBreakDownShort, gv.orBreakDownShort, true),
      trade("swp", "💧 OR low sweep + 5-min close वापस ऊपर → CE", 1, orL + 1 * k, "sweep के 30 मिनट के अंदर", g.orLowSweepLong, gd.orLowSweepLong, gv.orLowSweepLong, true),
      trade("rec", "Recovery: पहले 15-min का high पार (15-min close) → CE", 1, orH + 5 * k, "09:30–11:00", g.orBreakUpLong, gd.orBreakUpLong, gv.orBreakUpLong, true),
    ] : [
      trade("brk", "Gap-up: पहले 15-min का high टूटे (15-min close) → CE", 1, orH + 5 * k, "09:30–11:00, 15-min close OR high के ऊपर", g.orBreakUpLong, gd.orBreakUpLong, gv.orBreakUpLong, true),
      trade("swp", "💧 OR high sweep + 5-min close वापस नीचे → PE", -1, orH - 1 * k, "sweep के 30 मिनट के अंदर", g.orHighSweepShort, gd.orHighSweepShort, gv.orHighSweepShort, true),
      trade("rec", "Gap fade: पहले 15-min का low टूटे (15-min close) → PE", -1, orL - 5 * k, "09:30–11:00", g.orBreakDownShort, gd.orBreakDownShort, gv.orBreakDownShort, true),
    ];
    const lr = levels.map((l) => read(l, open)).filter((x): x is LevelRead => !!x).filter((x) => Math.abs(x.price - open) <= 4 * T);
    const best = trades.filter((t) => t.verdict === "GOOD").sort((a, b) => b.avgPts - a.avgPts)[0];
    return { id: dir < 0 ? "GAP_DOWN" : "GAP_UP", icon: dir < 0 ? "🔻" : "🔺", title: real ? `${tagT}Gap ${dir < 0 ? "Down" : "Up"} ${Math.round(Math.abs(open - B.close))} points` : `Gap ${dir < 0 ? "Down" : "Up"} ${Math.round(50 * k)}–${Math.round(100 * k)} points`, open,
      chance: g.sharePct, chanceNote: `${real ? `${bucketLbl(gk, k)} gap · ` : ""}${g.sharePct}% दिन ऐसे खुले (${g.n} दिन, 2 साल)`, branches: [fill, go, sweep], levels: lr, trades,
      sweep: [{ price: dir < 0 ? orL : orH, pct: dir < 0 ? g.orLowSweepPct : g.orHighSweepPct, label: `पहले 15-min का ${dir < 0 ? "low" : "high"} (≈)` }],
      story: [
        real ? `${wi ? `🔮 अगर ${I.index} ${f0(open)} पर खुले` : `🔔 ${hmI(O!.at)} पर ${I.index} का opening ${f0(open)}`} — कल के close ${f0(B.close)} से ${dir < 0 ? "−" : "+"}${Math.round(Math.abs(open - B.close))} (${bucketLbl(gk, k)})।` : `मान लीजिए ${I.index} ${f0(open)} के आसपास खुलता है (${f0(B.close)} से ${dir < 0 ? "−" : "+"}${Math.round(75 * k)})।`,
        `पहली 15-min candle आमतौर पर ~${f0(g.medOr15 * k)} points की होती है: ≈ ${f0(orL)} – ${f0(orH)}। इसी का high / low आज का पहला फ़ैसला है।`,
        `Gap भरना (${f0(B.close)} तक): ${g.fillPct}%। Gap की दिशा में पहले ${P} points: ${g.contPct}%। यानी ${g.contPct > g.fillPct ? "gap अक्सर अपनी दिशा में चलता है" : "gap अक्सर भर जाता है"}।`,
        best ? `सबसे भरोसेमंद trade (पुराने + नए data दोनों में फ़ायदा): ${best.label} — ${best.win}% जीत, औसत ${best.avgPts > 0 ? "+" : ""}${best.avgPts} points।` : "इस gap में कोई trade दोनों हिस्सों में लगातार फ़ायदे में नहीं — पहले 30 मिनट सिर्फ़ देखिए, One Trade signal का इंतज़ार।",
      ] };
  };

  // ---------- flat open → falls / rises ----------
  const flatScenario = (dir: 1 | -1): Scenario => {
    const open = O && oKey === "FLAT" ? O.price : B.close, role: "S" | "R" = dir < 0 ? "S" : "R";
    const side = dir < 0 ? below(open) : above(open), L1 = firstStat(side, role), L2 = side.filter((l) => l !== L1 && lvlStat(l.key, role))[0] || side.find((l) => l !== L1);
    const p1 = L1 ? L1.price : open + dir * T, p2 = L2 ? L2.price : p1 + dir * T;
    const st = L1 ? lvlStat(L1.key, role) : undefined, sd = L1 ? lvlStat(L1.key, role, I.stats.dev) : undefined, sv = L1 ? lvlStat(L1.key, role, I.stats.val) : undefined;
    const g = I.stats.all.gaps.FLAT;
    const hold: Branch = { id: "hold", name: `${L1?.label || "पहला level"} पर ${dir < 0 ? "टिकना" : "रुकना"} → ${dir < 0 ? "recovery" : "गिरावट"}`, prob: st?.holdPct ?? null, probNote: st ? `${st.n} बार छुआ: ${st.holdPct}% बार ${P} points पलटा` : "इस level का इतिहास नहीं", color: "#26a69a",
      path: [{ m: 555, p: open, note: "Open" }, { m: 615, p: p1 - dir * 0, note: L1?.label }, { m: 630, p: p1 + dir * 9 * k, note: "💧 Sweep" }, { m: 645, p: p1 - dir * 2 * k, note: "Reclaim" }, { m: 735, p: p1 - dir * T, note: `+${P}` }] };
    const brk: Branch = { id: "break", name: `${L1?.label || "level"} टूटा → ${L2?.label || "अगला level"}`, prob: st?.breakPct ?? null, probNote: st ? `${st.breakPct}% बार 15-min close से टूटकर ${P} points और` : "—", color: "#ef5350",
      path: [{ m: 555, p: open, note: "Open" }, { m: 615, p: p1 }, { m: 660, p: p1 + dir * 8 * k, note: "15-min close पार" }, { m: 720, p: p1 + dir * T, note: `−${P}` }, { m: 780, p: dir < 0 ? Math.min(p2, p1 - T) : Math.max(p2, p1 + T), note: L2?.label || "अगला level" }] };
    const rec: Branch = { id: "recover", name: `टूटने के बाद ${f0(p1)} पर वापसी (trap)`, prob: st?.recoverPct ?? null, probNote: st ? `टूटने के बाद ${st.recoverPct}% बार 15-min close वापस` : "—", color: "#ab47bc",
      path: [{ m: 615, p: p1 }, { m: 660, p: p1 + dir * 8 * k }, { m: 690, p: p1 + dir * 25 * k, note: "SL hunt" }, { m: 750, p: p1 - dir * 6 * k, note: "वापस" }, { m: 840, p: p1 - dir * 30 * k }] };
    const trades = [
      trade("def", `${L1?.label || "Level"} पर ${dir < 0 ? "sweep के बाद 5-min close वापस ऊपर → CE" : "sweep के बाद 5-min close वापस नीचे → PE"}`, (-dir) as 1 | -1, p1 - dir * 1 * k, "level छूने के बाद, 14:45 से पहले", st?.defend, sd?.defend, sv?.defend),
      trade("brk", `${L1?.label || "Level"} का 15-min close ${dir < 0 ? "नीचे → PE" : "ऊपर → CE"}`, dir, p1 + dir * 5 * k, "15-min candle close पर, 14:45 से पहले", st?.breakTrade, sd?.breakTrade, sv?.breakTrade),
    ];
    const lr = levels.map((l) => read(l, open)).filter((x): x is LevelRead => !!x).filter((x) => dir * (x.price - open) > 0).sort((a, b) => Math.abs(a.price - open) - Math.abs(b.price - open)).slice(0, 4);
    const sustain = lr.filter((x) => x.holdPct >= x.breakPct).sort((a, b) => b.holdPct - a.holdPct)[0];
    const best = trades.filter((t) => t.verdict === "GOOD").sort((a, b) => b.avgPts - a.avgPts)[0];
    return { id: dir < 0 ? "FALL" : "RISE", icon: dir < 0 ? "↘" : "↗", title: (O && oKey === "FLAT" ? tagT : "") + (dir < 0 ? "Flat open → बाज़ार गिरे" : "Flat open → बाज़ार चढ़े"), open,
      chance: g.sharePct, chanceNote: `Flat open (±${Math.round(50 * k)}) ${g.sharePct}% दिन`, branches: [hold, brk, rec], levels: lr, trades,
      sweep: L1 && st ? [{ price: p1 + dir * 9 * k, pct: st.sweepPct, label: `${L1.label} के ${dir < 0 ? "नीचे" : "ऊपर"} stop-loss pool` }] : [],
      story: [
        `${dir < 0 ? "गिरावट" : "तेज़ी"} में पहला बड़ा level: ${L1 ? `${L1.label} ${f0(p1)}` : "—"}; उसके बाद ${L2 ? `${L2.label} ${f0(p2)}` : "—"}।`,
        st ? `${L1!.label}: ${st.holdPct}% बार ${dir < 0 ? "टिका" : "रुका"}, ${st.breakPct}% बार टूटा, ${st.sweepPct}% बार पहले sweep (stop hunt) फिर पलटा। टूटने के बाद ${st.recoverPct}% बार वापस आया — इसलिए touch पर नहीं, 15-min close पर फ़ैसला।` : "इस level का पुराना data कम है।",
        sustain ? `सबसे ज़्यादा ${dir < 0 ? "टिकने" : "रुकने"} वाला level: ${sustain.label} ${f0(sustain.price)} (${sustain.holdPct}%)।` : `कोई level 50% से ज़्यादा नहीं ${dir < 0 ? "टिकता" : "रुकता"} — level अकेले पर भरोसा मत कीजिए, candle की reaction देखिए।`,
        best ? `सबसे भरोसेमंद trade: ${best.label} — entry ≈ ${f0(best.entry)}, SL ${f0(best.stop)}, target ${f0(best.target)} (${best.win}% जीत, औसत ${best.avgPts > 0 ? "+" : ""}${best.avgPts} pts)।` : "यहाँ कोई trade दोनों data हिस्सों में लगातार फ़ायदे में नहीं — One Trade signal का इंतज़ार करें।",
      ] };
  };

  const scenarios = [gapScenario(-1), gapScenario(1), flatScenario(-1), flatScenario(1)];
  // 💧 liquidity pools: just beyond the day / week extremes, with the measured sweep-then-hold chance
  const pools = levels.filter((l) => l.kind === "PD" || l.kind === "WEEK").filter((l) => l.key !== "PDC").map((l) => {
    const role: "S" | "R" = l.key === "PDL" || l.key === "WL" ? "S" : "R", st = lvlStat(l.key, role);
    return { price: l.price + (role === "S" ? -9 : 9) * k, pct: st?.sweepPct ?? 0, label: `${l.label} के ${role === "S" ? "नीचे" : "ऊपर"}`, role, l, st };
  });
  scenarios.push({ id: "SWEEP", icon: "💧", title: "Liquidity Sweep zones", open: ref, chance: null, chanceNote: "Stop-loss जहाँ जमा हैं",
    branches: pools.slice(0, 4).map((p, i) => ({ id: `pool${i}`, name: `💧 ${p.label} sweep → वापसी`, prob: p.pct, probNote: p.st ? `${p.st.n} touches में ${p.pct}% sweep होकर पलटा` : "—", color: p.role === "S" ? "#26a69a" : "#ef5350",
      path: [{ m: 600, p: p.l.price + (p.role === "S" ? 1 : -1) * 20 * k }, { m: 630, p: p.l.price }, { m: 645, p: p.price, note: "💧" }, { m: 660, p: p.l.price + (p.role === "S" ? 2 : -2) * k, note: "Reclaim" }, { m: 720, p: p.l.price + (p.role === "S" ? 1 : -1) * T }] })),
    levels: levels.map((l) => read(l, ref)).filter((x): x is LevelRead => !!x), trades: [],
    sweep: pools.map((p) => ({ price: p.price, pct: p.pct, label: p.label })),
    story: ["Liquidity = दूसरों के stop-loss। कल के High के ऊपर buyers के SL, कल के Low के नीचे sellers… और option buyers के SL।",
      "बड़े players पहले उन SL को लेते हैं (sweep), फिर असली दिशा में चलते हैं। पहचान: level के पार wick, पर 5-min candle वापस अंदर बंद।",
      ...pools.slice(0, 4).map((p) => `${p.label} (≈ ${f0(p.price)}): sweep होकर पलटने का चांस ${p.pct}%${p.st ? `, टूटकर चलने का ${p.st.breakPct}%` : ""}।`),
      "Sweep entry अकेले 2 साल के test में REJECT हुई थी (three-trades study) — sweep देखकर One Trade signal की पुष्टि का इंतज़ार कीजिए।"] });

  // 🔔 the opening review: which scenario today is, its odds, the first-candle plan
  let opening: OpeningRead | null = null;
  if (O && oKey) {
    const id = oKey === "FLAT" ? (oGap < 0 ? "FALL" : "RISE") : oDir < 0 ? "GAP_DOWN" : "GAP_UP", sc = scenarios.find((x) => x.id === id)!, g = I.stats.all.gaps[oKey];
    const pts = Math.round(O.price - B.close), best = sc.trades.filter((t) => t.verdict === "GOOD").sort((a, b) => b.avgPts - a.avgPts)[0];
    const half = (g.medOr15 * k) / 2, sup = below(O.price)[0], res = above(O.price)[0];
    opening = { price: O.price, at: O.at, source: O.source, gapPts: pts, bucket: oKey, label: `${bucketLbl(oKey, k)} (${pts >= 0 ? "+" : "−"}${Math.abs(pts)})`, scenario: id, review: [
      `${wi ? `🔮 अगर ${I.index} ${f0(O.price)} पर खुले` : `🔔 ${hmI(O.at)} — ${I.index} का opening ${f0(O.price)}`}: कल के close ${f0(B.close)} से ${pts >= 0 ? "+" : "−"}${Math.abs(pts)} points → ${bucketLbl(oKey, k)}।`,
      `2 साल में ऐसे ${g.n} दिन: gap भरा ${g.fillPct}% (10:15 तक ${g.fillBy1015Pct}%) · gap की दिशा में पहले ${P} points ${g.contPct}% · पहले 15-min का high/low sweep होकर पलटा ${oDir < 0 ? g.orLowSweepPct : g.orHighSweepPct}%।`,
      `पहली 15-min candle आमतौर पर ~${f0(g.medOr15 * k)} points: ≈ ${f0(O.price - half)} – ${f0(O.price + half)}। 09:30 के बाद 15-min close जिस तरफ़ टूटे, वही दिशा।`,
      `पास के levels: नीचे ${sup ? `${sup.label} ${f0(sup.price)}` : "—"} · ऊपर ${res ? `${res.label} ${f0(res.price)}` : "—"}।`,
      best ? `सबसे भरोसेमंद trade: ${best.label} — entry ≈ ${f0(best.entry)}, SL ${f0(best.stop)}, target ${f0(best.target)} (${best.win}% जीत)।` : "इस opening में कोई trade दोनों data हिस्सों में लगातार फ़ायदे में नहीं — पहले 30 मिनट देखिए, One Trade signal का इंतज़ार।",
    ] };
    scenarios.sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : 0));
  }

  return { index: I.index, base: B, targetDay: I.targetDay, targetIsToday: I.targetIsToday, k, tgt: T, sl: SL, opening, levels, scenarios,
    source: `${I.stats.all.from} → ${I.stats.all.to}, ${I.stats.all.sessions} sessions (real Dhan 1-min data)`,
    honesty: ["Probability = पिछले 2 साल में ऐसा कितनी बार हुआ — भविष्य की गारंटी नहीं।", "रास्ते (lines) का समय सांकेतिक है; levels और % असली data से हैं।",
      "Avg points premium cost से पहले के हैं; 1:2 में ~34% से कम जीत = घाटा।", "Trade सिर्फ़ One Trade signal पर — यह map तैयारी के लिए है।"] };
}

/** Max pain from a chain: the strike where option writers pay the least at expiry. */
export function maxPainOf(rows: { strike: number; ceOi?: number | null; peOi?: number | null }[]): number | null {
  const rs = rows.filter((r) => Number.isFinite(r.strike) && ((r.ceOi ?? 0) > 0 || (r.peOi ?? 0) > 0)); if (rs.length < 5) return null;
  let best: number | null = null, low = Infinity;
  for (const x of rs) { let pay = 0; for (const r of rs) pay += (r.ceOi ?? 0) * Math.max(0, x.strike - r.strike) + (r.peOi ?? 0) * Math.max(0, r.strike - x.strike); if (pay < low) { low = pay; best = x.strike; } }
  return best;
}

/** Group 15-min bars into sessions (IST day) and pick the base session + the session the map is for. */
export function scnSessions(bars: { time: number; open: number; high: number; low: number; close: number }[], nowSec: number) {
  const day = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10), by = new Map<string, SessionHLC>();
  for (const b of bars) { const d = day(b.time), s = by.get(d); if (!s) by.set(d, { day: d, open: b.open, high: b.high, low: b.low, close: b.close }); else { s.high = Math.max(s.high, b.high); s.low = Math.min(s.low, b.low); s.close = b.close; } }
  const ss = [...by.values()].sort((a, b) => a.day.localeCompare(b.day)), today = day(nowSec), istMin = Math.floor(((nowSec + 19800) % 86400) / 60);
  const live = ss.length > 0 && ss[ss.length - 1].day === today && istMin < 930;
  const done = live ? ss.slice(0, -1) : ss, base = done[done.length - 1];
  if (!base) return null;
  const next = new Date(base.day + "T00:00:00Z"); do next.setUTCDate(next.getUTCDate() + 1); while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  const targetDay = live ? today : next.toISOString().slice(0, 10);
  return { base, prior: done.slice(-5, -1).reverse(), targetDay, targetIsToday: targetDay === today, live };
}
