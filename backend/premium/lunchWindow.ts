// ============================ 12:00–14:00 lunch-window CAUTION (warning only — never changes plans, reviews or trades) ============================
// From recent 5-min history: how the 12:00→14:00 window behaved (closed lower how often, median, dip vs rally inside the
// window), split by today's morning direction, and how often a deep lunch dip recovered. Sent once at 12:00 as a caution.
// Research found no validated edge (backend/research/lunchWindow/RESULTS.md) — so this is context, not a rule.

export interface Bar { time: number; open: number; high: number; low: number; close: number }
const day = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const mn = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const n0 = (v: number) => Math.round(v).toLocaleString("en-IN");
const sg = (v: number) => `${v >= 0 ? "+" : "−"}${n0(Math.abs(v))}`;

export function lunchStats(bars: Bar[], today: string) {
  const by = new Map<string, Bar[]>();
  for (const b of bars) { const d = day(b.time); if (!by.has(d)) by.set(d, []); by.get(d)!.push(b); }
  const at = (bs: Bar[], m: number) => { const x = bs.filter((b) => mn(b.time) < m); return x.length ? x[x.length - 1].close : null; };
  const rows = [...by.keys()].sort().filter((d) => d < today && by.get(d)!.length >= 70).map((d) => {
    const bs = by.get(d)!, p12 = at(bs, 720)!, p14 = at(bs, 840)!, inn = bs.filter((b) => mn(b.time) >= 720 && mn(b.time) < 840);
    const low = Math.min(...inn.map((b) => b.low)), dip = p12 - low;
    return { ret: p14 - p12, dip, rally: Math.max(...inn.map((b) => b.high)) - p12, morning: p12 - bs[0].open, deep: dip / p12 >= 0.0025, recovered: dip > 0 && (p14 - low) / dip >= 0.5 };
  });
  const sum = (rs: typeof rows) => {
    const n = rs.length, s = rs.map((r) => r.ret).sort((a, b) => a - b);
    return { n, down: rs.filter((r) => r.ret < 0).length, median: n ? s[Math.floor(n / 2)] : 0, dip: n ? rs.reduce((a, r) => a + r.dip, 0) / n : 0, rally: n ? rs.reduce((a, r) => a + r.rally, 0) / n : 0 };
  };
  const tb = by.get(today) || [], p12 = at(tb, 720), morning = tb.length && p12 != null ? p12 - tb[0].open : null;
  const deep = rows.filter((r) => r.deep);
  return {
    sessions: rows.length, last15: sum(rows.slice(-15)), all: sum(rows),
    upMorning: sum(rows.filter((r) => r.morning > 0)), downMorning: sum(rows.filter((r) => r.morning <= 0)),
    deep: { n: deep.length, recovered: deep.filter((r) => r.recovered).length },
    today: tb.length ? { open: tb[0].open, p12, morning } : null,
  };
}

export function lunchCautionMsg(name: string, st: ReturnType<typeof lunchStats>): string {
  const nm = String(name || "").replace(" 50", ""), t = st.today, up = (t?.morning ?? 0) > 0, side = up ? st.upMorning : st.downMorning;
  const L = [`⚠️ <b>${nm} · 12:00–14:00 CAUTION</b> <i>(warning only — plans and rules unchanged)</i>`];
  if (t?.p12 != null && t.morning != null) L.push(`Morning: open ${n0(t.open)} → 12:00 <b>${n0(t.p12)}</b> (${sg(t.morning)} pts, <b>${up ? "UP" : "DOWN"} morning</b>)`);
  const l = st.last15;
  L.push(`Last ${l.n} sessions, 12→2: closed lower <b>${l.down}/${l.n}</b> · median ${sg(l.median)} pts · dips avg ${n0(l.dip)} vs rallies ${n0(l.rally)} pts`);
  if (side.n) L.push(`After ${up ? "an UP" : "a DOWN"} morning (${st.sessions} sessions): lower <b>${side.down}/${side.n} (${Math.round((side.down / side.n) * 100)}%)</b>`);
  if (st.deep.n) L.push(`<b>Deep lunch dips (≥ 0.25%) recovered half by 14:00 only ${st.deep.recovered}/${st.deep.n} times</b> — don't bottom-fish at lunch; respect the stop.`);
  L.push(`<i>History of this window, not a forecast: 12→2 closes are close to a coin flip; dips tend to run deeper than rallies.</i>`);
  return L.join("\n");
}
