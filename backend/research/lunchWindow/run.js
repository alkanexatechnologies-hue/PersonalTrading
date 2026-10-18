const fs = require("fs"), SP = process.argv[2];
const day = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10), mn = (t) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
// one-sided binomial P(X >= k | n, 0.5)
const binom = (k, n) => { let p = 0; for (let i = k; i <= n; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); p += c; } return p / 2 ** n; };
const W = { "09:15-10:00": [555, 600], "10:00-12:00": [600, 720], "12:00-14:00": [720, 840], "14:00-15:15": [840, 915] };
const out = {};
for (const name of ["NIFTY", "SENSEX", "BANKNIFTY"]) {
  const cs = JSON.parse(fs.readFileSync(`${SP}/bt1214/${name}.json`)); const by = new Map();
  for (const c of cs) { const d = day(c.time); if (!by.has(d)) by.set(d, []); by.get(d).push(c); }
  const days = [...by.keys()].sort().filter((d) => by.get(d).length >= 70);
  const priceAt = (bars, m) => { if (m === 555) return bars[0].open; const b = bars.filter((x) => mn(x.time) < m); return b.length ? b[b.length - 1].close : null; };
  const rows = days.map((d) => {
    const b = by.get(d), r = { day: d, open: b[0].open };
    for (const [k, [a, z]] of Object.entries(W)) {
      const pa = priceAt(b, a), pz = priceAt(b, z), inn = b.filter((x) => mn(x.time) >= a && mn(x.time) < z);
      r[k] = { ret: pz - pa, pct: (pz / pa - 1) * 100, dip: pa - Math.min(...inn.map((x) => x.low)), rally: Math.max(...inn.map((x) => x.high)) - pa };
    }
    r.morning = priceAt(b, 720) - b[0].open;
    return r;
  });
  const stat = (rs, k) => {
    const v = rs.map((r) => r[k]), n = v.length, dn = v.filter((x) => x.ret < 0).length, s = v.map((x) => x.ret).sort((a, b) => a - b);
    const avg = (f) => Math.round(v.reduce((a, x) => a + f(x), 0) / n * 10) / 10;
    return { n, down: dn, downPct: Math.round(dn / n * 100), meanPts: avg((x) => x.ret), medianPts: Math.round(s[Math.floor(n / 2)] * 10) / 10, meanPct: Math.round(v.reduce((a, x) => a + x.pct, 0) / n * 1000) / 1000, avgDip: avg((x) => x.dip), avgRally: avg((x) => x.rally), pDown: Math.round(binom(dn, n) * 1000) / 1000 };
  };
  const last15 = rows.slice(-15), all = rows;
  out[name] = { sessions: rows.length, from: rows[0].day, to: rows[rows.length - 1].day, last15: {}, all: {}, cond: {}, last15days: last15.map((r) => `${r.day.slice(5)} ${r["12:00-14:00"].ret >= 0 ? "+" : ""}${Math.round(r["12:00-14:00"].ret)}`) };
  for (const k of Object.keys(W)) { out[name].last15[k] = stat(last15, k); out[name].all[k] = stat(all, k); }
  out[name].cond.upMorning_all = stat(all.filter((r) => r.morning > 0), "12:00-14:00");
  out[name].cond.downMorning_all = stat(all.filter((r) => r.morning <= 0), "12:00-14:00");
  out[name].cond.upMorning_last15 = stat(last15.filter((r) => r.morning > 0), "12:00-14:00");
  out[name].cond.downMorning_last15 = stat(last15.filter((r) => r.morning <= 0), "12:00-14:00");
}
fs.writeFileSync(`${SP}/bt1214/result.json`, JSON.stringify(out, null, 1));
for (const [name, o] of Object.entries(out)) {
  console.log(`\n=== ${name}  ${o.sessions} sessions ${o.from} → ${o.to}`);
  for (const per of ["last15", "all"]) for (const [k, s] of Object.entries(o[per])) console.log(`${per.padEnd(6)} ${k}: down ${s.down}/${s.n} (${s.downPct}%) p=${s.pDown} · mean ${s.meanPts} pts (median ${s.medianPts}) · avg dip ${s.avgDip} vs rally ${s.avgRally}`);
  for (const [k, s] of Object.entries(o.cond)) console.log(`  12-14 | ${k}: down ${s.down}/${s.n} (${s.downPct}%) mean ${s.meanPts}`);
  console.log("  last 15 days 12-14:", o.last15days.join(" | "));
}
