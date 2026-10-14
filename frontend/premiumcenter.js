// ============================================================================
// OPTION PREMIUM PREDICTION CENTER — opened from Market Command (🎯 button).
// One endpoint: /api/premium-center (existing Dhan feed, chain, real premium OHLC candles, breakout engine, arbiter,
// risk state). Nothing here is invented: a missing value shows NOT AVAILABLE; probabilities show
// PROBABILITY NOT VALIDATED until they pass out-of-sample validation. Advisory only — the arbiter and the
// existing risk gates decide trades.
// ============================================================================
const PPC = {
  sym: "^NSEI", tf: "5m", off: 0, money: "ATM", ceK: null, peK: null, horizon: 15,
  init: false, timer: null, busy: false, d: null, charts: {}, sort: { key: "rank", dir: 1 },
};
const PPC_SYMS = [["^NSEI", "NIFTY"], ["^NSEBANK", "BANKNIFTY"], ["^CNXFIN", "FINNIFTY"], ["^BSESN", "SENSEX"], ["^NSEMDCP50", "MIDCPNIFTY"]];
const ppcEl = (id) => document.getElementById(id);
const ppcEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ppcN = (v, d = 2) => (v == null || !isFinite(Number(v)) ? '<span class="ppc-na">NOT AVAILABLE</span>' : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ppcNs = (v, d = 2) => (v == null || !isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ppcL = (v) => { if (v == null || !isFinite(v)) return "—"; const a = Math.abs(v), s = v < 0 ? "-" : ""; return a >= 1e7 ? s + (a / 1e7).toFixed(2) + "Cr" : a >= 1e5 ? s + (a / 1e5).toFixed(1) + "L" : a >= 1e3 ? s + (a / 1e3).toFixed(1) + "K" : s + Math.round(a); };
const ppcSg = (v, d = 2, suf = "") => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(d) + suf);
const ppcCls = (v) => (v == null ? "" : v > 0 ? "ppc-up" : v < 0 ? "ppc-dn" : "");
const ppcHm = (t) => (t ? new Date((t + 19800) * 1000).toISOString().slice(11, 16) : "—");
const ppcT = (t) => t + 19800;   // IST wall clock on the chart axis
const PPC_TIPS = {
  BOS: "Break of Structure: a candle CLOSES beyond the last confirmed swing in the same direction as the trend.",
  CHoCH: "Change of Character: the first confirmed break AGAINST the previous break's direction — a possible trend change.",
  MOVE: "Model, not a forecast: delta × typical index move for the horizon (median of today's own moves) + ½·gamma·move² − theta for the horizon. Uses the feed's greeks only.",
  PROB: "No CE/PE premium probability has passed out-of-sample validation yet, so no percentage is shown.",
  STATE: "PRE = within ½ ATR of the level · ATTEMPT = forming candle beyond it (not closed) · CONFIRMED = a candle CLOSED beyond level + buffer · RETEST = came back and held · FAILED = closed back inside.",
};

function initPremiumCenter() {
  const root = ppcEl("ppc-root"); if (!root) return;
  if (!PPC.init) {
    PPC.init = true;
    try { const mcSym = (typeof MC !== "undefined" && MC.sym) || null; if (mcSym && PPC_SYMS.some((s) => s[0] === mcSym)) PPC.sym = mcSym; } catch { /* default NIFTY */ }
    root.innerHTML = ppcShell();
    root.addEventListener("click", ppcOnClick);
    root.addEventListener("change", ppcOnChange);
  } else {
    try { const mcSym = (typeof MC !== "undefined" && MC.sym) || null; if (mcSym && mcSym !== PPC.sym && PPC_SYMS.some((s) => s[0] === mcSym)) { PPC.sym = mcSym; PPC.ceK = PPC.peK = null; } } catch { /* keep */ }
  }
  ppcLoad(); ppcStart();
}
function ppcStart() { ppcStop(); PPC.timer = setInterval(() => { if (document.hidden || !document.body.classList.contains("ppc-fullwidth")) return; ppcLoad(); }, 15000); }
function ppcStop() { if (PPC.timer) clearInterval(PPC.timer); PPC.timer = null; }

function ppcShell() {
  return `
  <div class="ppc-head">
    <button class="ppc-back" data-act="back" title="Back to Market Command">← Market Command</button>
    <div class="ppc-title">🎯 Option Premium Prediction Center<span class="ppc-sub"> · CE vs PE · breakout / breakdown · advisory only</span></div>
    <div class="ppc-syms">${PPC_SYMS.map(([s, n]) => `<button class="ppc-pill" data-sym="${s}">${n}</button>`).join("")}</div>
    <div class="ppc-ctl">
      <label>Expiry <select id="ppc-exp"></select></label>
      <label>Strike <select id="ppc-money"><option>ATM</option><option>ITM</option><option>OTM</option></select></label>
      <label>CE <select id="ppc-ce"></select></label>
      <label>PE <select id="ppc-pe"></select></label>
      <span class="ppc-tf"><button class="ppc-pill" data-tf="5m">5M</button><button class="ppc-pill" data-tf="15m">15M</button></span>
      <label>Horizon <select id="ppc-h"><option value="5">5 min</option><option value="15" selected>15 min</option><option value="30">30 min</option></select></label>
    </div>
    <div class="ppc-status" id="ppc-status">loading…</div>
  </div>
  <div id="ppc-quote" class="ppc-quote"></div>
  <div id="ppc-master" class="ppc-master"></div>
  <div class="ppc-cards"><div id="ppc-card-ce" class="ppc-card"></div><div id="ppc-card-pe" class="ppc-card"></div><div id="ppc-card-cmp" class="ppc-card"></div></div>
  <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>Index</b> <span id="ppc-spot-legend" class="ppc-sub"></span></div><div id="ppc-ch-spot" class="ppc-ch ppc-ch-big"></div></div>
  <div class="ppc-charts2">
    <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>CE premium</b> <span id="ppc-ce-legend" class="ppc-sub"></span></div><div id="ppc-ch-ce" class="ppc-ch"></div></div>
    <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>PE premium</b> <span id="ppc-pe-legend" class="ppc-sub"></span></div><div id="ppc-ch-pe" class="ppc-ch"></div></div>
  </div>
  <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>CE vs PE — % move since the session's first candle</b> <span class="ppc-sub">(same strikes as the cards)</span></div><div id="ppc-ch-cmp" class="ppc-ch ppc-ch-cmp"></div></div>
  <div class="ppc-card"><div class="ppc-ch-head"><b>Strike ranking</b> <span class="ppc-sub">ATM ± 3 · ranked by structure alignment, quote quality and modelled move after the spread — never by premium price alone</span></div><div id="ppc-rank" class="ppc-rankwrap"></div></div>
  <div class="ppc-foot" id="ppc-foot"></div>`;
}

function ppcOnClick(e) {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.act === "back") { ppcStop(); if (typeof switchTab === "function") switchTab("marketcommand"); return; }
  if (b.dataset.sym) { PPC.sym = b.dataset.sym; PPC.ceK = PPC.peK = null; PPC.off = 0; ppcLoad(true); }
  if (b.dataset.tf) { PPC.tf = b.dataset.tf; ppcLoad(true); }
  if (b.dataset.sort) { const k = b.dataset.sort; PPC.sort = { key: k, dir: PPC.sort.key === k ? -PPC.sort.dir : -1 }; ppcRenderRank(); }
}
function ppcOnChange(e) {
  const t = e.target;
  if (t.id === "ppc-exp") { PPC.off = Number(t.value) || 0; PPC.ceK = PPC.peK = null; ppcLoad(true); }
  if (t.id === "ppc-money") { PPC.money = t.value; PPC.ceK = PPC.peK = null; ppcLoad(true); }
  if (t.id === "ppc-ce") { PPC.ceK = Number(t.value) || null; ppcLoad(true); }
  if (t.id === "ppc-pe") { PPC.peK = Number(t.value) || null; ppcLoad(true); }
  if (t.id === "ppc-h") { PPC.horizon = Number(t.value) || 15; ppcRender(); }
}

async function ppcLoad(force) {
  if (PPC.busy && !force) return; PPC.busy = true;
  const q = new URLSearchParams({ symbol: PPC.sym, interval: PPC.tf, expiryOffset: String(PPC.off), moneyness: PPC.money });
  if (PPC.ceK) q.set("ceStrike", String(PPC.ceK)); if (PPC.peK) q.set("peStrike", String(PPC.peK));
  const st = ppcEl("ppc-status"); if (force && st) st.textContent = "loading…";
  try {
    const r = await fetch("/api/premium-center?" + q.toString());
    const d = await r.json();
    if (d.disabled) { if (st) st.innerHTML = '<span class="ppc-bad">Data paused for this screen (Data Control)</span>'; return; }
    if (!d.available) { if (st) st.innerHTML = `<span class="ppc-bad">UNAVAILABLE — ${ppcEsc(d.error || "no data")}</span>`; return; }
    PPC.d = d; ppcRender();
  } catch (e) { if (st) st.innerHTML = `<span class="ppc-bad">UNAVAILABLE — ${ppcEsc(e.message || "request failed")}</span>`; }
  finally { PPC.busy = false; }
}

function ppcBadge(s) { const c = s === "LIVE" ? "ok" : s === "DELAYED" ? "warn" : s === "CLOSED" ? "muted" : "bad"; return `<span class="ppc-badge ppc-${c}">${ppcEsc(s)}</span>`; }
function ppcRender() {
  const d = PPC.d; if (!d) return;
  document.querySelectorAll("#ppc-root [data-sym]").forEach((b) => b.classList.toggle("on", b.dataset.sym === PPC.sym));
  document.querySelectorAll("#ppc-root [data-tf]").forEach((b) => b.classList.toggle("on", b.dataset.tf === PPC.tf));
  const exp = ppcEl("ppc-exp"); if (exp) exp.innerHTML = (d.expiries || []).slice(0, 4).map((x, i) => `<option value="${i}" ${i === d.expiryOffset ? "selected" : ""}>${ppcEsc(x)}</option>`).join("") || "<option>—</option>";
  const mo = ppcEl("ppc-money"); if (mo) mo.value = d.moneyness;
  const ks = [...new Set((d.ranking || []).map((r) => r.strike))].sort((a, b) => a - b);
  const opt = (sel) => ks.map((k) => `<option value="${k}" ${k === sel ? "selected" : ""}>${k}${k === d.atm ? " (ATM)" : ""}</option>`).join("");
  const ce = ppcEl("ppc-ce"), pe = ppcEl("ppc-pe"); if (ce) ce.innerHTML = opt(d.ce?.strike); if (pe) pe.innerHTML = opt(d.pe?.strike);
  ppcEl("ppc-status").innerHTML = `${ppcBadge(d.dataStatus)} <span>Session <b>${ppcEsc(d.session)}</b></span> <span>Last candle <b>${ppcHm(d.exchangeTs)}</b>${d.ageSec != null && d.session === "OPEN" ? ` (${d.ageSec}s ago)` : ""}</span> <span>Updated <b>${ppcHm(d.generatedAt)}</b> IST</span> <span class="ppc-conn ${/not/.test(d.provider) ? "ppc-bad" : "ppc-ok"}">● ${ppcEsc(d.provider)}</span>`;
  const sp = d.spot || {};
  ppcEl("ppc-quote").innerHTML = `<span class="ppc-qname">${ppcEsc(d.name)}</span><span class="ppc-qpx ${ppcCls(sp.change)}">${ppcNs(sp.price)}</span><span class="${ppcCls(sp.change)}">${ppcSg(sp.change)} (${ppcSg(sp.changePct, 2, "%")})</span>
    <span>O <b>${ppcNs(sp.open)}</b></span><span>H <b>${ppcNs(sp.high)}</b></span><span>L <b>${ppcNs(sp.low)}</b></span><span>Prev close <b>${ppcNs(sp.prevClose)}</b></span>
    <span>ATM <b>${d.atm ?? "—"}</b></span><span>Expiry <b>${ppcEsc(d.expiry || "—")}</b></span>${d.session !== "OPEN" ? `<span class="ppc-warnt">Session ${ppcEsc(sp.sessionDay || "")} — market ${ppcEsc(d.session)}</span>` : ""}`;
  ppcRenderMaster(); ppcRenderCards(); ppcRenderCharts(); ppcRenderRank();
  ppcEl("ppc-foot").innerHTML = `${ppcEsc(d.note)} · ${ppcEsc(d.version)} · <span title="${ppcEsc(PPC_TIPS.PROB)}">${ppcEsc(d.validation?.status)}: ${ppcEsc(d.validation?.detail)}</span>`;
}

function ppcRenderMaster() {
  const m = PPC.d.master, s = m.state;
  const tone = /^BUY CE/.test(s) ? "bull" : /^BUY PE/.test(s) ? "bear" : /^WAIT/.test(s) ? "wait" : /NO EDGE/.test(s) ? "muted" : "bad";
  const li = (a) => (a && a.length ? a.map((x) => `<li>${ppcEsc(x)}</li>`).join("") : "<li class='ppc-sub'>none</li>");
  ppcEl("ppc-master").className = `ppc-master ppc-m-${tone}`;
  ppcEl("ppc-master").innerHTML = `
    <div class="ppc-m-state"><div class="ppc-m-lbl">MASTER DECISION</div><div class="ppc-m-big">${ppcEsc(s)}</div><div class="ppc-m-why">${ppcEsc(m.reason)}</div></div>
    <div class="ppc-m-grid">
      <div><span>Confirmation required</span><b>${ppcEsc(m.confirmationRequired || "—")}</b></div>
      <div><span>Entry trigger</span><b>${typeof m.entryTrigger === "number" ? ppcNs(m.entryTrigger) : ppcEsc(m.entryTrigger || "—")}</b></div>
      <div><span>Stop / invalidation</span><b>${ppcNs(m.stop)}</b></div>
      <div><span>Target</span><b>${ppcNs(m.target)}</b></div>
      <div><span>Reward : risk</span><b>${m.rr != null ? "1 : " + ppcNs(m.rr) : "—"}</b>${m.planSource ? `<em>${ppcEsc(m.planSource)}</em>` : ""}</div>
      <div><span>Arbiter</span><b>${ppcEsc(m.arbiterSays)}</b></div>
    </div>
    <div class="ppc-m-ev"><div><span class="ppc-up">Supporting</span><ul>${li(m.supporting)}</ul></div><div><span class="ppc-dn">Contradicting</span><ul>${li(m.contradictory)}</ul></div>
      <div><span>Risk gates ${m.riskGate.ok ? '<b class="ppc-up">PASS</b>' : '<b class="ppc-dn">BLOCKED</b>'}</span><ul>${m.riskGate.gates.map((g) => `<li class="${g.ok ? "ppc-up" : "ppc-dn"}">${g.ok ? "✓" : "✗"} ${ppcEsc(g.name)} — ${ppcEsc(g.detail)}</li>`).join("")}</ul></div></div>`;
}

function ppcStateChip(st) {
  const s = st?.state || "NONE", bull = /BREAKOUT|RETEST_HOLD/.test(s) && !/FAILED/.test(s), bear = /BREAKDOWN|RETEST_FAILURE/.test(s) && !/FAILED/.test(s);
  const c = /FAILED/.test(s) ? "bad" : /CONFIRMED|RETEST/.test(s) ? (bull ? "bull" : bear ? "bear" : "muted") : /PRE|ATTEMPT/.test(s) ? "wait" : "muted";
  return `<span class="ppc-chip ppc-c-${c}" title="${ppcEsc(PPC_TIPS.STATE)}">${ppcEsc(s.replace(/_/g, " "))}${st?.intrabar ? " · intrabar" : ""}</span>`;
}
function ppcCard(o, side) {
  if (!o || !o.available) return `<h4>${side === "CE" ? "CALL" : "PUT"} PREMIUM PREDICTION</h4><div class="ppc-na">NOT AVAILABLE — ${ppcEsc(o?.reason || "no chain")}</div>`;
  const d = PPC.d, h = PPC.horizon, mv = o.expectedMove?.[h], L = o.liquidity || {};
  const dirC = o.direction === "UP" ? "ppc-up" : o.direction === "DOWN" ? "ppc-dn" : "ppc-wait";
  const st = side === "CE" ? d.breakout : d.breakdown;
  const ev = (a, cls) => (a && a.length ? a.map((x) => `<li class="${cls}">${ppcEsc(x)}</li>`).join("") : `<li class="ppc-sub">none</li>`);
  return `<h4 class="${side === "CE" ? "ppc-up" : "ppc-dn"}">${side === "CE" ? "CALL (CE)" : "PUT (PE)"} PREMIUM <span class="ppc-sub">${o.strike} ${ppcEsc(o.moneyness || "")} · ${ppcEsc(o.expiry)}</span></h4>
    <div class="ppc-ltp"><span class="ppc-ltpv">${ppcN(o.ltp)}</span> <span class="${ppcCls(o.change)}">${ppcSg(o.change)} (${ppcSg(o.changePct, 2, "%")})</span></div>
    <div class="ppc-kv">
      <div><span>Direction (evidence)</span><b class="${dirC}">${ppcEsc(o.direction)}</b></div>
      <div><span>P(rise)</span><b class="ppc-na" title="${ppcEsc(PPC_TIPS.PROB)}">NOT VALIDATED</b></div>
      <div title="${ppcEsc(PPC_TIPS.MOVE)}"><span>Expected move · ${h} min (model)</span><b>${mv ? `±${ppcNs(mv.absPts)} (${ppcNs(mv.absPct)}%)` : '<span class="ppc-na">NOT AVAILABLE</span>'}</b></div>
      <div title="${ppcEsc(PPC_TIPS.MOVE)}"><span>If index ±${mv ? ppcNs(mv.indexMove, 0) : "—"} pts</span><b>${mv ? `<span class="ppc-up">${ppcSg(mv.ifIndexUp)}</span> / <span class="ppc-dn">${ppcSg(mv.ifIndexDown)}</span>` : "—"}</b></div>
      <div><span>Index ${side === "CE" ? "breakout" : "breakdown"}</span><b>${ppcStateChip(st)}</b></div>
      <div><span>${side === "CE" ? "Breakout" : "Breakdown"} level</span><b>${ppcNs(st?.level)}</b></div>
      <div><span>Premium swing H / L</span><b>${ppcNs(o.behaviour?.swingHigh)} / ${ppcNs(o.behaviour?.swingLow)}</b></div>
      <div><span>Premium 1 / 3 / 6 bars</span><b>${ppcSg(o.behaviour?.ret1, 1, "%")} / ${ppcSg(o.behaviour?.ret3, 1, "%")} / ${ppcSg(o.behaviour?.ret6, 1, "%")}</b></div>
      <div><span>IV · Δ · Γ · Θ</span><b>${ppcNs(o.iv, 1)} · ${ppcNs(o.delta, 2)} · ${ppcNs(o.gamma, 4)} · ${ppcNs(o.theta, 1)}</b></div>
      <div><span>Vol · OI · OI chg</span><b>${ppcL(o.volume)} · ${ppcL(o.oi)} · <span class="${ppcCls(o.oiChg)}">${ppcL(o.oiChg)}</span></b></div>
      <div><span>Bid / Ask</span><b>${ppcNs(L.bid)} / ${ppcNs(L.ask)}</b></div>
      <div><span>Spread · liquidity</span><b class="${L.status === "GOOD" ? "ppc-up" : L.status === "WIDE" ? "ppc-wait" : "ppc-dn"}" title="${ppcEsc(L.detail)}">${ppcNs(L.spreadPct)}% · ${ppcEsc(L.status)}</b></div>
    </div>
    <div class="ppc-ev"><ul>${ev(o.bullishEvidence, "ppc-up")}</ul><ul>${ev(o.bearishEvidence, "ppc-dn")}</ul></div>`;
}
function ppcRenderCards() {
  const d = PPC.d, c = d.comparison || {}, h = PPC.horizon, ce = d.ce || {}, pe = d.pe || {};
  ppcEl("ppc-card-ce").innerHTML = ppcCard(ce, "CE");
  ppcEl("ppc-card-pe").innerHTML = ppcCard(pe, "PE");
  const mce = ce.expectedMove?.[h], mpe = pe.expectedMove?.[h];
  ppcEl("ppc-card-cmp").innerHTML = `<h4>CE vs PE <span class="ppc-sub">same time · ${h}-min horizon</span></h4>
    <table class="ppc-cmp"><tr><th></th><th class="ppc-up">CE ${ce.strike ?? ""}</th><th class="ppc-dn">PE ${pe.strike ?? ""}</th></tr>
      <tr><td>P(rise)</td><td class="ppc-na" colspan="2" title="${ppcEsc(PPC_TIPS.PROB)}">PROBABILITY NOT VALIDATED</td></tr>
      <tr><td>Direction (evidence)</td><td>${ppcEsc(ce.direction || "—")}</td><td>${ppcEsc(pe.direction || "—")}</td></tr>
      <tr><td>Abs. move (model)</td><td>${mce ? "±" + ppcNs(mce.absPts) : "—"}</td><td>${mpe ? "±" + ppcNs(mpe.absPts) : "—"}</td></tr>
      <tr><td>% of premium</td><td>${mce ? ppcNs(mce.absPct) + "%" : "—"}</td><td>${mpe ? ppcNs(mpe.absPct) + "%" : "—"}</td></tr>
      <tr><td>Theta over ${h} min</td><td>${mce ? ppcSg(mce.thetaPts) : "—"}</td><td>${mpe ? ppcSg(mpe.thetaPts) : "—"}</td></tr>
      <tr><td>Premium response</td><td>${ppcEsc(ce.behaviour?.response || "—")}</td><td>${ppcEsc(pe.behaviour?.response || "—")}</td></tr>
      <tr><td>Liquidity</td><td>${ppcEsc(ce.liquidity?.status || "—")}</td><td>${ppcEsc(pe.liquidity?.status || "—")}</td></tr></table>
    <div class="ppc-cmpv">Stronger setup now: <b class="${c.stronger === "CE" ? "ppc-up" : c.stronger === "PE" ? "ppc-dn" : "ppc-wait"}">${c.stronger ? c.stronger + " — structure and its own premium agree" : "NEITHER — no side has structure + premium confirmation"}</b></div>
    <div class="ppc-sub">Index ${ppcStateChip(d.breakout)} ${ppcStateChip(d.breakdown)} · ${ppcEsc(d.structure?.context15 || "")}</div>
    <div class="ppc-sub">Data ${ppcBadge(d.dataStatus)} · model confidence: <b>not validated</b></div>`;
}

// ---------------------------------------------------------------- charts (lightweight-charts, already loaded)
function ppcMkChart(id, h) {
  const host = ppcEl(id); if (!host || typeof LightweightCharts === "undefined") return null;
  if (PPC.charts[id]) { try { PPC.charts[id].remove(); } catch { /* gone */ } }
  const ch = LightweightCharts.createChart(host, { width: host.clientWidth || 600, height: h, layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#8a97ad", fontSize: 10 }, grid: { vertLines: { color: "#121a2b" }, horzLines: { color: "#121a2b" } }, rightPriceScale: { borderColor: "#2a2e39" }, timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false } });
  PPC.charts[id] = ch; return ch;
}
const ppcCandleOpts = { upColor: "#16c784", downColor: "#ea3943", borderUpColor: "#16c784", borderDownColor: "#ea3943", wickUpColor: "#16c784", wickDownColor: "#ea3943" };
function ppcLine(ch, cs, vals, color, w = 1, style = 0) {
  const s = ch.addLineSeries({ color, lineWidth: w, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  s.setData(cs.map((c, i) => (vals[i] != null ? { time: ppcT(c.time), value: vals[i] } : null)).filter(Boolean)); return s;
}
function ppcRenderCharts() {
  const d = PPC.d, cs = d.chart?.candles || [];
  const big = window.innerWidth < 700 ? 300 : 420, small = window.innerWidth < 700 ? 220 : 260;
  const ch = ppcMkChart("ppc-ch-spot", big);
  if (ch && cs.length) {
    const s = ch.addCandlestickSeries(ppcCandleOpts);
    s.setData(cs.map((c) => ({ time: ppcT(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    ppcLine(ch, cs, d.chart.ema9, "#f59e0b"); ppcLine(ch, cs, d.chart.ema21, "#3b82f6"); ppcLine(ch, cs, d.chart.vwap, "#a855f7", 1, 2);
    ppcLine(ch, cs, d.chart.bbUpper, "rgba(148,163,184,.45)", 1, 1); ppcLine(ch, cs, d.chart.bbLower, "rgba(148,163,184,.45)", 1, 1);
    const st = d.structure || {}, t0 = cs[0].time, tN = cs[cs.length - 1].time, iv = d.interval === "15m" ? 900 : 300;
    if (st.resistance != null) s.createPriceLine({ price: st.resistance, color: "#ea3943", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Resistance" });
    if (st.support != null) s.createPriceLine({ price: st.support, color: "#16c784", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Support" });
    if (d.breakout?.level != null && d.breakout.state !== "NONE") s.createPriceLine({ price: d.breakout.level, color: "#22d3ee", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "Breakout" });
    if (d.breakdown?.level != null && d.breakdown.state !== "NONE") s.createPriceLine({ price: d.breakdown.level, color: "#f472b6", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "Breakdown" });
    // trendlines: from the first confirmed swing to the latest bar (non-repainting: swings confirmed by closed bars only)
    for (const [tl, col] of [[st.trendlines?.seller, "#ef4444"], [st.trendlines?.buyer, "#22c55e"]]) {
      if (!tl || tl.p1.time < t0) continue;
      const bars = Math.round((tN - tl.p1.time) / iv), y2 = tl.p1.price + tl.slope * (cs.findIndex((c) => c.time === tN) - cs.findIndex((c) => c.time === tl.p1.time));
      if (!isFinite(y2) || bars <= 0) continue;
      const ls = ch.addLineSeries({ color: col, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ls.setData([{ time: ppcT(tl.p1.time), value: tl.p1.price }, { time: ppcT(tN), value: Math.round(y2 * 100) / 100 }]);
    }
    const mk = [];
    for (const w of st.swings || []) if (w.time >= t0) mk.push({ time: ppcT(w.time), position: w.kind === "HIGH" ? "aboveBar" : "belowBar", color: w.kind === "HIGH" ? "#fca5a5" : "#86efac", shape: "circle", size: 0.5, text: "" });
    for (const b of st.bos || []) if (b.time && b.time >= t0) mk.push({ time: ppcT(b.time), position: b.direction === "Bullish" ? "belowBar" : "aboveBar", color: b.kind === "CHoCH" ? "#facc15" : b.direction === "Bullish" ? "#16c784" : "#ea3943", shape: b.direction === "Bullish" ? "arrowUp" : "arrowDown", text: `${b.kind} ${Math.round(b.level)}` });
    for (const x of [d.breakout, d.breakdown]) if (x?.barTime && x.barTime >= t0 && /CONFIRMED|RETEST|FAILED/.test(x.state)) mk.push({ time: ppcT(x.barTime), position: "aboveBar", color: "#22d3ee", shape: "square", text: x.state.split("_")[0] + " " + x.state.split("_").slice(1).join(" ").toLowerCase() });
    mk.sort((a, b) => a.time - b.time); s.setMarkers(mk);
    ch.timeScale().fitContent();
    ppcEl("ppc-spot-legend").innerHTML = `<span style="color:#f59e0b">EMA9</span> · <span style="color:#3b82f6">EMA21</span> · <span style="color:#a855f7">VWAP</span> · <span style="color:#94a3b8">BB(20,2)</span> · <span style="color:#ef4444">seller trendline</span> · <span style="color:#22c55e">buyer trendline</span> · <span title="${ppcEsc(PPC_TIPS.BOS)}">BOS</span> / <span style="color:#facc15" title="${ppcEsc(PPC_TIPS.CHoCH)}">CHoCH</span> · ATR ${ppcNs(st.atr, 1)} · break buffer ${ppcNs(st.breakBuffer, 2)}${d.chart.formingTime ? " · last candle forming" : ""}`;
  }
  for (const side of ["CE", "PE"]) {
    const o = d[side.toLowerCase()], id = side === "CE" ? "ppc-ch-ce" : "ppc-ch-pe", lg = ppcEl(side === "CE" ? "ppc-ce-legend" : "ppc-pe-legend");
    const c2 = ppcMkChart(id, small);
    if (!c2 || !o?.candles?.length) { if (lg) lg.innerHTML = `<span class="ppc-na">${ppcEsc(o?.candlesReason || "NOT AVAILABLE")}</span>`; continue; }
    const s = c2.addCandlestickSeries(ppcCandleOpts);
    s.setData(o.candles.map((c) => ({ time: ppcT(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    if (o.behaviour?.swingHigh != null) s.createPriceLine({ price: o.behaviour.swingHigh, color: "#ea3943", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "swing H" });
    if (o.behaviour?.swingLow != null) s.createPriceLine({ price: o.behaviour.swingLow, color: "#16c784", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "swing L" });
    c2.timeScale().fitContent();
    if (lg) lg.innerHTML = `${o.strike} ${o.side} · ${ppcEsc(o.expiry)} · ${ppcEsc(o.candlesSource)} (real OHLC) · last ${ppcNs(o.candles[o.candles.length - 1].close)}`;
  }
  const c3 = ppcMkChart("ppc-ch-cmp", window.innerWidth < 700 ? 180 : 200);
  if (c3) {
    const day = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
    for (const [o, col] of [[d.ce, "#16c784"], [d.pe, "#ea3943"]]) {
      const cs2 = o?.candles || []; if (!cs2.length) continue;
      const lastDay = day(cs2[cs2.length - 1].time), sess = cs2.filter((c) => day(c.time) === lastDay), base = sess[0]?.open;
      if (!(base > 0)) continue;
      const ls = c3.addLineSeries({ color: col, lineWidth: 2, priceLineVisible: false, title: o.side });
      ls.setData(sess.map((c) => ({ time: ppcT(c.time), value: Math.round(((c.close / base) - 1) * 10000) / 100 })));
    }
    c3.timeScale().fitContent();
  }
}
window.addEventListener("resize", () => { if (!document.body.classList.contains("ppc-fullwidth")) return; for (const [id, ch] of Object.entries(PPC.charts)) { const h = ppcEl(id); if (h && ch) ch.applyOptions({ width: h.clientWidth }); } });

// ---------------------------------------------------------------- strike ranking
function ppcRenderRank() {
  const d = PPC.d; if (!d) return;
  const rows = (d.ranking || []).map((r, i) => ({ ...r, rank: i + 1 }));
  const k = PPC.sort.key, dir = PPC.sort.dir;
  if (k !== "rank") rows.sort((a, b) => ((a[k] ?? -1e9) - (b[k] ?? -1e9)) * dir); else if (dir === 1) rows.sort((a, b) => a.rank - b.rank); else rows.sort((a, b) => b.rank - a.rank);
  const th = (key, label, tip = "") => `<th><button class="ppc-sort ${k === key ? "on" : ""}" data-sort="${key}" title="${ppcEsc(tip)}">${label}${k === key ? (dir === 1 ? " ▲" : " ▼") : ""}</button></th>`;
  ppcEl("ppc-rank").innerHTML = rows.length ? `<table class="ppc-rank"><thead><tr>${th("rank", "#")}<th>Type</th><th>Strike</th>${th("ltp", "LTP")}${th("changePct", "Chg %")}${th("volume", "Vol")}${th("oi", "OI")}${th("spreadPct", "Spread %")}<th>Δ</th><th>IV</th>${th("expectedMove15", "Move 15m", PPC_TIPS.MOVE)}${th("netOfSpreadPct", "Net %", "modelled move minus the spread, as % of premium")}<th>P(rise)</th><th>Liquidity</th><th>Setup</th><th>Reason</th></tr></thead><tbody>${rows.map((r) => `
    <tr class="${r.side === "CE" ? "ppc-rce" : "ppc-rpe"} ${r.strike === d.atm ? "ppc-ratm" : ""}"><td>${r.rank}</td><td class="${r.side === "CE" ? "ppc-up" : "ppc-dn"}">${r.side}</td><td>${r.strike}${r.strike === d.atm ? " ATM" : ""}</td><td>${ppcNs(r.ltp)}</td><td class="${ppcCls(r.changePct)}">${ppcSg(r.changePct, 1, "%")}</td><td>${ppcL(r.volume)}</td><td>${ppcL(r.oi)}</td><td>${ppcNs(r.spreadPct)}</td><td>${ppcNs(r.delta)}</td><td>${ppcNs(r.iv, 1)}</td><td>${r.expectedMove15 != null ? "±" + ppcNs(r.expectedMove15) : "—"}</td><td>${ppcNs(r.netOfSpreadPct)}</td><td class="ppc-na">NOT VALIDATED</td><td class="${r.liquidity === "GOOD" ? "ppc-up" : r.liquidity === "WIDE" ? "ppc-wait" : "ppc-dn"}">${ppcEsc(r.liquidity)}</td><td>${r.aligned ? '<span class="ppc-up">aligned</span>' : '<span class="ppc-sub">—</span>'}</td><td class="ppc-reason">${ppcEsc(r.reason)}</td></tr>`).join("")}</tbody></table>` : `<div class="ppc-na">NOT AVAILABLE — option chain not loaded</div>`;
}
