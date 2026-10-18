const fs = require("fs"), SP = process.argv[2];
const day = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10), mn = (t) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
for (const name of ["NIFTY", "SENSEX"]) {
  const cs = JSON.parse(fs.readFileSync(`${SP}/bt1214/${name}.json`)); const by = new Map();
  for (const c of cs) { const d = day(c.time); if (!by.has(d)) by.set(d, []); by.get(d).push(c); }
  const days = [...by.keys()].sort().filter((d) => by.get(d).length >= 70);
  const res = days.map((d) => {
    const b = by.get(d), pre = b.filter((x) => mn(x.time) < 720), p12 = pre[pre.length - 1].close, inn = b.filter((x) => mn(x.time) >= 720 && mn(x.time) < 840);
    const lowBar = inn.reduce((a, x) => (x.low < a.low ? x : a)), p14 = inn[inn.length - 1].close, morningLow = Math.min(...pre.map((x) => x.low));
    const dip = p12 - lowBar.low, rally = Math.max(...inn.map((x) => x.high)) - p12;
    return { d, dipPct: dip / p12 * 100, recov: dip > 0 ? (p14 - lowBar.low) / dip : null, sweptMorningLow: lowBar.low < morningLow, closedBackAboveMorningLow: p14 > morningLow, lowAt: mn(lowBar.time), dip, rally, ret: p14 - p12 };
  });
  for (const [lab, rs] of [["last15", res.slice(-15)], ["all63", res]]) {
    const big = rs.filter((r) => r.dipPct >= 0.25), rec = big.filter((r) => r.recov >= 0.5);
    const sw = rs.filter((r) => r.sweptMorningLow), swBack = sw.filter((r) => r.closedBackAboveMorningLow);
    const hist = {}; for (const r of rs) { const h = Math.floor(r.lowAt / 60) + ":" + (r.lowAt % 60 < 30 ? "00" : "30"); hist[h] = (hist[h] || 0) + 1; }
    console.log(`${name} ${lab}: dip ≥0.25% on ${big.length}/${rs.length} days; of those, ${rec.length} (${big.length ? Math.round(rec.length / big.length * 100) : 0}%) recovered ≥ half of the dip by 14:00 · 12-14 low took the MORNING LOW on ${sw.length} days, closed back above it by 14:00 on ${swBack.length} · when the 12-14 low happened: ${JSON.stringify(hist)}`);
  }
}
