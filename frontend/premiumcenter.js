// ============================================================================
// OPTION PREMIUM PREDICTION CENTER — opened from Market Command (🎯 button).
// One endpoint: /api/premium-center (existing Dhan feed, chain, real premium OHLC candles, breakout engine, arbiter,
// risk state). Nothing here is invented: a missing value shows NOT AVAILABLE; probabilities show
// PROBABILITY NOT VALIDATED until they pass out-of-sample validation. Advisory only — the arbiter and the
// existing risk gates decide trades.
// ============================================================================
const PPC = {
  sym: "^NSEI", tf: "15m", off: 0, money: "ATM", ceK: null, peK: null, horizon: 15,
  layers: { trend: true, levels: true, plan: true, breaks: true, ema: true, vwap: true, bb: false, structure: false },
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
  PROB: "No CE/PE premium probability has passed out-of-sample validation, so no percentage is shown.",
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
      <label>Horizon <select id="ppc-h"><option value="5">5 min</option><option value="15" selected>15 min</option><option value="30">30 min</option></select></label>
    </div>
    <div class="ppc-status" id="ppc-status">loading…</div>
  </div>
  <div id="ppc-quote" class="ppc-quote"></div>
  <div id="ppc-coach" class="ppc-coach"></div>
  <div id="ppc-trend" class="ppc-trendstrip"></div>
  <div class="ppc-main">
    <div class="ppc-tv">
      <div class="ppc-tvbar">
        <span class="ppc-tvsym" id="ppc-tvsym"></span>
        <span class="ppc-tf"><button class="ppc-tvbtn" data-tf="5m">5m</button><button class="ppc-tvbtn" data-tf="15m">15m</button></span>
        <span class="ppc-tvsep"></span>
        ${[["trend", "Trendlines"], ["levels", "Levels"], ["plan", "Plan"], ["breaks", "Past breaks"], ["ema", "EMA 9/21"], ["vwap", "VWAP"], ["bb", "BB"], ["structure", "BOS/CHoCH"]].map(([k, l]) => `<button class="ppc-tvbtn ppc-layer" data-layer="${k}">${l}</button>`).join("")}
        <button class="ppc-tvbtn" data-act="fit" title="Reset zoom">⤢</button>
      </div>
      <div class="ppc-tvwrap"><div id="ppc-ch-spot" class="ppc-ch-tv"></div><div id="ppc-legend" class="ppc-legend"></div></div>
    </div>
    <div class="ppc-side"><div class="ppc-side-h">Level ladder <span class="ppc-sub">★ confluence · risk = for a buyer trading the break</span></div><div class="ppc-rk-key"><i class="ppc-rk ppc-rk-low">LOW RISK</i><i class="ppc-rk ppc-rk-med">MED RISK</i><i class="ppc-rk ppc-rk-high">HIGH RISK</i><i class="ppc-rk ppc-rk-far">FAR</i> <span class="ppc-sub">hover a level for why</span></div><div id="ppc-ladder"></div></div>
  </div>
  <div class="ppc-plans" id="ppc-plans"></div>
  <div class="ppc-row2"><div class="ppc-card" id="ppc-tomorrow"></div><div class="ppc-card" id="ppc-history"></div></div>
  <details class="ppc-card ppc-arb"><summary><b>Arbiter &amp; risk gates</b> <span class="ppc-sub">final authority — the screen never overrides it</span> <span id="ppc-arb-sum"></span></summary><div id="ppc-master" class="ppc-master"></div></details>
  <div class="ppc-cards"><div id="ppc-card-ce" class="ppc-card"></div><div id="ppc-card-pe" class="ppc-card"></div><div id="ppc-card-cmp" class="ppc-card"></div></div>
  <div class="ppc-charts2">
    <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>CE premium</b> <span id="ppc-ce-legend" class="ppc-sub"></span></div><div id="ppc-ch-ce" class="ppc-ch"></div></div>
    <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>PE premium</b> <span id="ppc-pe-legend" class="ppc-sub"></span></div><div id="ppc-ch-pe" class="ppc-ch"></div></div>
  </div>
  <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>CE vs PE — % move since the session's first candle</b> <span class="ppc-sub">(same strikes as the cards)</span></div><div id="ppc-ch-cmp" class="ppc-ch ppc-ch-cmp"></div></div>
  <details class="ppc-card"><summary class="ppc-ch-head"><b>Strike ranking</b> <span class="ppc-sub">ATM ± 3 · ranked by structure alignment, quote quality and modelled move after the spread — never by premium price alone</span></summary><div id="ppc-rank" class="ppc-rankwrap"></div></details>
  <div class="ppc-foot" id="ppc-foot"></div>`;
}

function ppcOnClick(e) {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.act === "back") { ppcStop(); if (typeof switchTab === "function") switchTab("marketcommand"); return; }
  if (b.dataset.sym) { PPC.sym = b.dataset.sym; PPC.ceK = PPC.peK = null; PPC.off = 0; ppcLoad(true); }
  if (b.dataset.tf) { PPC.tf = b.dataset.tf; ppcLoad(true); }
  if (b.dataset.layer) { PPC.layers[b.dataset.layer] = !PPC.layers[b.dataset.layer]; ppcRenderTV(true); return; }
  if (b.dataset.act === "fit") { PPC.charts["ppc-ch-spot"]?.timeScale().fitContent(); return; }
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
  document.querySelectorAll("#ppc-root [data-layer]").forEach((b) => b.classList.toggle("on", !!PPC.layers[b.dataset.layer]));
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
  ppcRenderMaster(); ppcRenderCoach(); ppcRenderTV(); ppcRenderLadder(); ppcRenderPlans(); ppcRenderHistory(); ppcRenderCards(); ppcRenderCharts(); ppcRenderRank();
  ppcEl("ppc-foot").innerHTML = `${ppcEsc(d.note)} · ${ppcEsc(d.version)} · <span title="${ppcEsc(PPC_TIPS.PROB)}">${ppcEsc(d.validation?.status)}: ${ppcEsc(d.validation?.detail)}</span>`;
}

function ppcRenderMaster() {
  const m = PPC.d.master, s = m.state;
  const tone = /^BUY CE/.test(s) ? "bull" : /^BUY PE/.test(s) ? "bear" : /^WAIT/.test(s) ? "wait" : /NO EDGE/.test(s) ? "muted" : "bad";
  const li = (a) => (a && a.length ? a.map((x) => `<li>${ppcEsc(x)}</li>`).join("") : "<li class='ppc-sub'>none</li>");
  ppcEl("ppc-master").className = `ppc-master ppc-m-${tone}`;
  const sum = ppcEl("ppc-arb-sum"); if (sum) sum.innerHTML = ` · <b class="${tone === "bull" ? "ppc-up" : tone === "bear" || tone === "bad" ? "ppc-dn" : "ppc-wait"}">${ppcEsc(s)}</b>`;
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
      <div><span>P(rise)</span><b class="ppc-na" title="${ppcEsc(d.validation?.detail || PPC_TIPS.PROB)}">${ppcEsc(d.validation?.status || "NOT VALIDATED")}</b></div>
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
      <tr><td>P(rise)</td><td class="ppc-na" colspan="2" title="${ppcEsc(d.validation?.detail || PPC_TIPS.PROB)}">${ppcEsc(d.validation?.status || "PROBABILITY NOT VALIDATED")}</td></tr>
      <tr><td>Direction (evidence)</td><td>${ppcEsc(ce.direction || "—")}</td><td>${ppcEsc(pe.direction || "—")}</td></tr>
      <tr><td>Abs. move (model)</td><td>${mce ? "±" + ppcNs(mce.absPts) : "—"}</td><td>${mpe ? "±" + ppcNs(mpe.absPts) : "—"}</td></tr>
      <tr><td>% of premium</td><td>${mce ? ppcNs(mce.absPct) + "%" : "—"}</td><td>${mpe ? ppcNs(mpe.absPct) + "%" : "—"}</td></tr>
      <tr><td>Theta over ${h} min</td><td>${mce ? ppcSg(mce.thetaPts) : "—"}</td><td>${mpe ? ppcSg(mpe.thetaPts) : "—"}</td></tr>
      <tr><td>Premium response</td><td>${ppcEsc(ce.behaviour?.response || "—")}</td><td>${ppcEsc(pe.behaviour?.response || "—")}</td></tr>
      <tr><td>Liquidity</td><td>${ppcEsc(ce.liquidity?.status || "—")}</td><td>${ppcEsc(pe.liquidity?.status || "—")}</td></tr></table>
    <div class="ppc-cmpv">Stronger setup now: <b class="${c.stronger === "CE" ? "ppc-up" : c.stronger === "PE" ? "ppc-dn" : "ppc-wait"}">${c.stronger ? c.stronger + " — structure and its own premium agree" : "NEITHER — no side has structure + premium confirmation"}</b></div>
    <div class="ppc-sub">Index ${ppcStateChip(d.breakout)} ${ppcStateChip(d.breakdown)} · ${ppcEsc(d.structure?.context15 || "")}</div>
    <div class="ppc-sub">Data ${ppcBadge(d.dataStatus)} · model confidence: <b>not validated</b></div>
    <div class="ppc-study">${d.validation?.study ? `<b>Tested ${ppcEsc(d.validation.study.date)} · ${d.validation.study.days} days · ${ppcEsc(d.validation.study.verdict)}:</b> ` : ""}${ppcEsc(d.validation?.detail || "")}</div>`;
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
  const small = window.innerWidth < 700 ? 220 : 260;
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
let _ppcRz = null;
window.addEventListener("resize", () => {
  if (!document.body.classList.contains("ppc-fullwidth")) return;
  clearTimeout(_ppcRz);
  _ppcRz = setTimeout(() => { for (const [id, ch] of Object.entries(PPC.charts)) { const h = ppcEl(id); if (h && ch) { ch.applyOptions({ width: h.clientWidth }); if (id !== "ppc-ch-spot") ch.timeScale().fitContent(); } } }, 120);
});

// ---------------------------------------------------------------- strike ranking
function ppcRenderRank() {
  const d = PPC.d; if (!d) return;
  const rows = (d.ranking || []).map((r, i) => ({ ...r, rank: i + 1 }));
  const k = PPC.sort.key, dir = PPC.sort.dir;
  if (k !== "rank") rows.sort((a, b) => ((a[k] ?? -1e9) - (b[k] ?? -1e9)) * dir); else if (dir === 1) rows.sort((a, b) => a.rank - b.rank); else rows.sort((a, b) => b.rank - a.rank);
  const th = (key, label, tip = "") => `<th><button class="ppc-sort ${k === key ? "on" : ""}" data-sort="${key}" title="${ppcEsc(tip)}">${label}${k === key ? (dir === 1 ? " ▲" : " ▼") : ""}</button></th>`;
  ppcEl("ppc-rank").innerHTML = rows.length ? `<table class="ppc-rank"><thead><tr>${th("rank", "#")}<th>Type</th><th>Strike</th>${th("ltp", "LTP")}${th("changePct", "Chg %")}${th("volume", "Vol")}${th("oi", "OI")}${th("spreadPct", "Spread %")}<th>Δ</th><th>IV</th>${th("expectedMove15", "Move 15m", PPC_TIPS.MOVE)}${th("netOfSpreadPct", "Net %", "modelled move minus the spread, as % of premium")}<th>P(rise)</th><th>Liquidity</th><th>Setup</th><th>Reason</th></tr></thead><tbody>${rows.map((r) => `
    <tr class="${r.side === "CE" ? "ppc-rce" : "ppc-rpe"} ${r.strike === d.atm ? "ppc-ratm" : ""}"><td>${r.rank}</td><td class="${r.side === "CE" ? "ppc-up" : "ppc-dn"}">${r.side}</td><td>${r.strike}${r.strike === d.atm ? " ATM" : ""}</td><td>${ppcNs(r.ltp)}</td><td class="${ppcCls(r.changePct)}">${ppcSg(r.changePct, 1, "%")}</td><td>${ppcL(r.volume)}</td><td>${ppcL(r.oi)}</td><td>${ppcNs(r.spreadPct)}</td><td>${ppcNs(r.delta)}</td><td>${ppcNs(r.iv, 1)}</td><td>${r.expectedMove15 != null ? "±" + ppcNs(r.expectedMove15) : "—"}</td><td>${ppcNs(r.netOfSpreadPct)}</td><td class="ppc-na" title="${ppcEsc(d.validation?.detail || "")}">${ppcEsc(r.validation || "NOT VALIDATED")}</td><td class="${r.liquidity === "GOOD" ? "ppc-up" : r.liquidity === "WIDE" ? "ppc-wait" : "ppc-dn"}">${ppcEsc(r.liquidity)}</td><td>${r.aligned ? '<span class="ppc-up">aligned</span>' : '<span class="ppc-sub">—</span>'}</td><td class="ppc-reason">${ppcEsc(r.reason)}</td></tr>`).join("")}</tbody></table>` : `<div class="ppc-na">NOT AVAILABLE — option chain not loaded</div>`;
}

// ================================================================ experienced-trader view (all drawn on the chart)
const TVC = { bg: "#131722", grid: "#1e222d", text: "#d1d4dc", border: "#2a2e39", up: "#26a69a", down: "#ef5350", seller: "#f23645", buyer: "#089981", ce: "#2962ff", pe: "#ff9800", zone: "#f7c948" };
const PPC_RISK = { LOW: { col: "#26a69a", short: "LOW RISK", cls: "low" }, MEDIUM: { col: "#f7c948", short: "MED RISK", cls: "med" }, HIGH: { col: "#ef5350", short: "HIGH RISK", cls: "high" }, FAR: { col: "#5d606b", short: "FAR", cls: "far" } };
const ppcR = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));

function ppcRenderCoach() {
  const T = PPC.d.trader; const el = ppcEl("ppc-coach"); if (!el) return;
  if (!T || T.error) { el.className = "ppc-coach ppc-k-stop"; el.innerHTML = `<b>Trader view unavailable</b> ${ppcEsc(T?.error || "")}`; return; }
  const c = T.coach;
  el.className = `ppc-coach ppc-k-${c.tone}`;
  el.innerHTML = `<div class="ppc-k-main"><div class="ppc-k-lbl">WHAT I'D DO NOW</div><div class="ppc-k-act">${ppcEsc(c.action)}</div><div class="ppc-k-why">${ppcEsc(c.why)}</div></div>
    <div class="ppc-k-list"><div class="ppc-k-lbl">CHECKLIST ${c.total ? `${c.passed}/${c.total}` : ""}</div>${c.checklist.map((x) => `<div class="${x.ok === true ? "ppc-up" : x.ok === false ? "ppc-dn" : "ppc-sub ppc-k-na"}">${x.ok === true ? "✓" : x.ok === false ? "✗" : "·"} ${ppcEsc(x.item)} <span class="ppc-sub">${ppcEsc(x.detail)}</span></div>`).join("")}</div>`;
  const tr = ppcEl("ppc-trend");
  tr.innerHTML = (T.trends || []).map((t) => `<div class="ppc-tchip ppc-t-${t.verdict === "UP" ? "up" : t.verdict === "DOWN" ? "dn" : "rg"}" title="${ppcEsc(t.reasons.join(" · "))}"><span>${ppcEsc(t.tf)}</span><b>${t.verdict === "UP" ? "▲ UP" : t.verdict === "DOWN" ? "▼ DOWN" : t.verdict === "RANGE" ? "▬ RANGE" : "NO DATA"}</b><em>${ppcEsc(t.reasons.slice(1).join(" · ") || t.reasons[0] || "")}</em></div>`).join("")
    + `<div class="ppc-tchip ppc-t-note"><span>Rule</span><b>Trade with the higher timeframe</b><em>${ppcEsc(ppcHtfLine(T.trends))}</em></div>`;
}
function ppcHtfLine(tr) {
  const d = tr.find((t) => t.tf === "Daily")?.verdict, h = tr.find((t) => t.tf === "1H")?.verdict;
  if (d === "UP" && h !== "DOWN") return "Daily up — prefer CE breakouts; PE only on a clean breakdown";
  if (d === "DOWN" && h !== "UP") return "Daily down — prefer PE breakdowns; CE only on a clean breakout";
  return `Daily ${d || "—"} vs 1H ${h || "—"} disagree — smaller size, take quick targets`;
}

function ppcMkTV(id) {
  const host = ppcEl(id); if (!host || typeof LightweightCharts === "undefined") return null;
  const h = window.innerWidth < 700 ? 380 : Math.max(480, Math.min(640, window.innerHeight - 260));
  return LightweightCharts.createChart(host, {
    width: host.clientWidth || 800, height: h,
    layout: { background: { type: "solid", color: TVC.bg }, textColor: TVC.text, fontSize: 11, fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif" },
    grid: { vertLines: { color: TVC.grid }, horzLines: { color: TVC.grid } },
    crosshair: { mode: 0, vertLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#2a2e39" }, horzLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#2a2e39" } },
    rightPriceScale: { borderColor: TVC.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: TVC.border, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7, minBarSpacing: 2 },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });
}
function ppcRenderTV(layerToggle) {
  const d = PPC.d, T = d?.trader, cs = d?.chart?.candles || []; if (!d) return;
  const id = "ppc-ch-spot", key = `${PPC.sym}|${d.interval}`;
  let keep = null;
  if (PPC.charts[id]) { try { if (PPC._tvKey === key) keep = PPC.charts[id].timeScale().getVisibleLogicalRange(); PPC.charts[id].remove(); } catch { /* gone */ } }
  const ch = ppcMkTV(id); PPC.charts[id] = ch; PPC._tvKey = key; if (!ch || !cs.length) return;
  ppcEl("ppc-tvsym").innerHTML = `<b>${ppcEsc(d.name)}</b> · ${d.interval === "15m" ? "15" : "5"} · Dhan`;
  const L = PPC.layers, last = cs[cs.length - 1]; PPC._planNames = {};
  const s = ch.addCandlestickSeries({ upColor: TVC.up, downColor: TVC.down, borderUpColor: TVC.up, borderDownColor: TVC.down, wickUpColor: TVC.up, wickDownColor: TVC.down, priceLineColor: "#787b86", priceLineStyle: 2 });
  // future whitespace (next session) so projected trendlines have room to the right, as in TradingView
  const fut = (T && !T.error ? T.future || [] : []).filter((t) => t > last.time);
  s.setData([...cs.map((c) => ({ time: ppcT(c.time), open: c.open, high: c.high, low: c.low, close: c.close })), ...fut.map((t) => ({ time: ppcT(t) }))]);
  const line = (vals, color, w = 1, style = 0, title = "") => { const ls = ch.addLineSeries({ color, lineWidth: w, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title }); ls.setData(cs.map((c, i) => (vals[i] != null ? { time: ppcT(c.time), value: vals[i] } : null)).filter(Boolean)); return ls; };
  const ser = {};
  if (L.ema) { ser.ema9 = line(d.chart.ema9, "#f7a21b"); ser.ema21 = line(d.chart.ema21, "#2962ff"); }
  if (L.vwap) ser.vwap = line(d.chart.vwap, "#e040fb", 1, 2);
  if (L.bb) { line(d.chart.bbUpper, "rgba(120,123,134,.6)", 1, 1); line(d.chart.bbLower, "rgba(120,123,134,.6)", 1, 1); }
  // trendlines from confirmed swings: solid to the break (or now), dotted projection into the next session with its value
  if (L.trend && T && !T.error) for (const tl of T.lines || []) {
    if (tl.p1.time < cs[0].time) continue;
    const col = tl.kind === "SELLER" ? TVC.seller : TVC.buyer;
    const a = ch.addLineSeries({ color: tl.broken ? col + "88" : col, lineWidth: tl.broken ? 1 : 2, lineStyle: tl.broken ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    a.setData([{ time: ppcT(tl.p1.time), value: tl.p1.price }, { time: ppcT(tl.end.time), value: tl.end.price }]);
    if (!tl.broken && tl.projection?.length) {
      const pr = ch.addLineSeries({ color: col, lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: `${tl.kind === "SELLER" ? "Seller" : "Buyer"} TL next` });
      pr.setData([{ time: ppcT(tl.end.time), value: tl.end.price }, ...tl.projection.map((p) => ({ time: ppcT(p.time), value: p.value }))]);
    }
  }
  // levels (ladder) — only those inside the visible price neighbourhood
  const lo = Math.min(...cs.slice(-120).map((c) => c.low)), hi = Math.max(...cs.slice(-120).map((c) => c.high)), pad = (T?.atr15 || 0) * 1.5;
  const inView = (p) => p >= lo - pad && p <= hi + pad;
  const kindCol = { "PREV DAY": "#b2b5be", TODAY: "#90caf9", WEEK: "#ce93d8", PIVOT: "#80deea", TRENDLINE: "#ffd54f", OI: "#ffab91" };
  const short = (l) => l.replace("Prev day ", "PD ").replace("Prev week ", "PW ").replace("Prev close", "PDC").replace("Today ", "Day ").replace(" pivot", "").replace(/OI call wall.*/, "Call wall").replace(/OI put wall.*/, "Put wall").replace(/Major call OI.*/, "Major call").replace(/Major put OI.*/, "Major put").replace(" trendline", " TL");
  if (L.levels && T && !T.error) {
    // one label per price: levels within 0.1·ATR merge ("PD high/PDC"); a level that IS a plan line is named on the plan line
    const tol = 0.1 * (T.atr15 || 1), planPx = L.plan && T.plans ? [T.plans.bull, T.plans.bear].filter(Boolean).flatMap((p) => [p.trigger, p.stop, p.t1, p.t2]).filter((x) => x != null) : [];
    const groups = [];
    for (const v of (T.levels || []).filter((v) => inView(v.price) && v.kind !== "TRENDLINE")) { const g = groups.find((g) => Math.abs(g.price - v.price) <= tol); if (g) g.items.push(v); else groups.push({ price: v.price, items: [v] }); }
    for (const g of groups) {
      const lbl = g.items.map((v) => short(v.label)).join("/"), star = g.items.length > 1 || g.items.some((v) => v.confluence);
      if (planPx.some((x) => Math.abs(x - g.price) <= tol)) { PPC._planNames = PPC._planNames || {}; PPC._planNames[g.price.toFixed(2)] = lbl; continue; }
      const rk = g.items.map((v) => v.risk).find(Boolean), rc = rk ? PPC_RISK[rk.risk] : null;
      s.createPriceLine({ price: g.price, color: rc ? rc.col : kindCol[g.items[0].kind] || "#787b86", lineWidth: star ? 2 : 1, lineStyle: 2, axisLabelVisible: true, title: (star ? "★ " : "") + lbl + (rc && rk.risk !== "FAR" ? ` · ${rc.short}` : "") });
    }
  }
  // the plan: triggers, stops, targets, no-trade zone
  if (L.plan && T?.plans) {
    for (const [p, col, nm] of [[T.plans.bull, TVC.ce, "CE"], [T.plans.bear, TVC.pe, "PE"]]) {
      if (!p) continue;
      const nameAt = (px) => { const tol = 0.1 * (T.atr15 || 1), k = Object.keys(PPC._planNames || {}).find((x) => Math.abs(Number(x) - px) <= tol); return k ? ` · ${PPC._planNames[k]}` : ""; };
      s.createPriceLine({ price: p.trigger, color: col, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `${nm} TRIGGER${nameAt(p.trigger)}${p.triggerRisk && PPC_RISK[p.triggerRisk.risk] && p.triggerRisk.risk !== "FAR" ? " · " + PPC_RISK[p.triggerRisk.risk].short : ""}` });
      s.createPriceLine({ price: p.stop, color: "#f23645", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} SL${nameAt(p.stop)}` });
      s.createPriceLine({ price: p.t1, color: "#089981", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} T1${nameAt(p.t1)}` });
      if (p.t2 != null && inView(p.t2)) s.createPriceLine({ price: p.t2, color: "#089981", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} T2${nameAt(p.t2)}` });
    }
    if (T.plans.noTrade) {
      const nt = T.plans.noTrade, zone = ch.addBaselineSeries({ baseValue: { type: "price", price: nt.from }, topFillColor1: "rgba(247,201,72,.07)", topFillColor2: "rgba(247,201,72,.07)", topLineColor: "rgba(0,0,0,0)", bottomFillColor1: "rgba(0,0,0,0)", bottomFillColor2: "rgba(0,0,0,0)", bottomLineColor: "rgba(0,0,0,0)", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      zone.setData([...cs, ...fut.map((t) => ({ time: t }))].map((c) => ({ time: ppcT(c.time), value: nt.to })));
    }
  }
  // markers: past breaks with what happened next; optional BOS/CHoCH
  const mk = [];
  if (L.breaks && T?.events) for (const e of T.events) {
    if (e.time < cs[0].time) continue;
    const ok = e.outcome === "FOLLOWED THROUGH", bad = e.outcome === "FAILED";
    mk.push({ time: ppcT(e.time), position: e.dir === "UP" ? "belowBar" : "aboveBar", shape: e.dir === "UP" ? "arrowUp" : "arrowDown",
      color: ok ? (e.dir === "UP" ? "#26a69a" : "#ef5350") : bad ? "#9e9e9e" : "#f7c948",
      text: `${e.dir === "UP" ? "BO" : "BD"} ${ok ? "✓" : bad ? "✗" : e.outcome === "PENDING" ? "…" : "~"} ${ok ? "+" + Math.round(e.mfe) : bad ? "fail" : ""}`.trim() });
  }
  if (L.structure) for (const b of d.structure?.bos || []) if (b.time && b.time >= cs[0].time) mk.push({ time: ppcT(b.time), position: b.direction === "Bullish" ? "belowBar" : "aboveBar", color: b.kind === "CHoCH" ? "#f7c948" : "#787b86", shape: "circle", text: `${b.kind}` });
  mk.sort((a, b) => a.time - b.time); s.setMarkers(mk);
  // view: keep the trader's zoom across refreshes; first load shows the last ~2 sessions + the projection
  if (keep) ch.timeScale().setVisibleLogicalRange(keep);   // the trader's zoom survives refreshes and layer toggles
  else { const n = cs.length + fut.length; ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - (d.interval === "15m" ? 55 : 150)), to: n + 2 }); }
  // TradingView-style legend: OHLC + change under the cursor (last bar otherwise) + indicator values
  const leg = ppcEl("ppc-legend");
  const show = (c, i) => {
    if (!c) return; const prev = i > 0 ? cs[i - 1].close : c.open, chg = c.close - prev, col = chg >= 0 ? TVC.up : TVC.down;
    const v = (arr) => (arr && arr[i] != null ? ppcNs(arr[i]) : "—");
    leg.innerHTML = `<div><b>${ppcEsc(d.name)} · ${d.interval === "15m" ? "15" : "5"} · NSE</b> <span style="color:${col}">O <b>${ppcNs(c.open)}</b> H <b>${ppcNs(c.high)}</b> L <b>${ppcNs(c.low)}</b> C <b>${ppcNs(c.close)}</b> ${chg >= 0 ? "+" : ""}${ppcNs(chg)} (${ppcSg((chg / prev) * 100, 2, "%")})</span></div>`
      + `<div class="ppc-legsub">${L.ema ? `<span style="color:#f7a21b">EMA 9 ${v(d.chart.ema9)}</span> <span style="color:#2962ff">EMA 21 ${v(d.chart.ema21)}</span> ` : ""}${L.vwap ? `<span style="color:#e040fb">VWAP ${v(d.chart.vwap)}</span> ` : ""}<span style="color:#787b86">ATR ${ppcNs(T?.atr15, 1)}</span></div>`;
  };
  show(last, cs.length - 1);
  const idxOf = new Map(cs.map((c, i) => [ppcT(c.time), i]));
  ch.subscribeCrosshairMove((p) => { const i = p && p.time != null ? idxOf.get(p.time) : undefined; if (i == null) show(last, cs.length - 1); else show(cs[i], i); });
}

function ppcRenderLadder() {
  const T = PPC.d.trader, el = ppcEl("ppc-ladder"); if (!el) return;
  if (!T || T.error || !T.levels?.length) { el.innerHTML = '<div class="ppc-na">NOT AVAILABLE</div>'; return; }
  const spot = PPC.d.spot?.price, rows = []; let placed = false;
  const bull = T.plans?.bull, bear = T.plans?.bear;
  for (const v of T.levels) {
    if (!placed && spot != null && v.price < spot) { rows.push(`<div class="ppc-lad-spot">▶ ${ppcNs(spot)} SPOT</div>`); placed = true; }
    const tag = bull && Math.abs(v.price - bull.trigger) < 0.01 ? '<i class="ppc-lt ce">CE trigger</i>' : bear && Math.abs(v.price - bear.trigger) < 0.01 ? '<i class="ppc-lt pe">PE trigger</i>' : "";
    const rk = v.risk, rc = rk ? PPC_RISK[rk.risk] : null;
    rows.push(`<div class="ppc-lad ppc-lk-${v.kind.replace(/\s/g, "")}" title="${ppcEsc((v.with ? "Confluence with: " + v.with.join(", ") + "\n" : "") + (rk ? `Break ${rk.side === "ABOVE" ? "above" : "below"} = ${rk.risk} RISK (score ${rk.score}):\n• ` + rk.reasons.join("\n• ") : ""))}"><span>${ppcNs(v.price)}</span><span>${v.confluence ? "★ " : ""}${ppcEsc(v.label)} ${tag}${rc ? ` <i class="ppc-rk ppc-rk-${rc.cls}">${rc.short}</i>` : ""}</span><span class="ppc-sub">${spot != null ? (v.price > spot ? "+" : "") + Math.round(v.price - spot) : ""}</span>
      ${rk && rk.risk !== "FAR" ? `<div class="ppc-lad-why">${ppcEsc(rk.reasons.filter((x) => !/room to|with the/.test(x) || rk.risk === "LOW").slice(0, 2).join(" · "))}</div>` : ""}${rk?.bounce ? `<div class="ppc-lad-bounce">↺ ${ppcEsc(rk.bounce)}</div>` : ""}</div>`);
  }
  if (!placed && spot != null) rows.push(`<div class="ppc-lad-spot">▶ ${ppcNs(spot)} SPOT</div>`);
  el.innerHTML = rows.join("");
}

function ppcPlanCard(p, side) {
  const nm = side === "CE" ? "BULL PLAN · BUY CE" : "BEAR PLAN · BUY PE", cls = side === "CE" ? "ppc-pl-ce" : "ppc-pl-pe";
  if (!p) return `<div class="ppc-plan ${cls}"><h4>${nm}</h4><div class="ppc-na">No level ${side === "CE" ? "above" : "below"} the price — NOT AVAILABLE</div></div>`;
  const prem = (v) => (v == null ? "—" : "≈₹" + ppcNs(v));
  const h = p.history;
  return `<div class="ppc-plan ${cls}"><h4>${nm}</h4>
    <div class="ppc-pl-row"><span>Trigger</span><b>15-min CLOSE ${side === "CE" ? "above" : "below"} ${ppcNs(p.trigger)}</b></div>
    <div class="ppc-sub ppc-pl-lbl">${ppcEsc(p.triggerLabel)}</div>
    ${p.triggerRisk ? `<div class="ppc-pl-risk ppc-rkb-${PPC_RISK[p.triggerRisk.risk].cls}"><b>${PPC_RISK[p.triggerRisk.risk].short} trigger</b> — ${ppcEsc(p.triggerRisk.reasons.join(" · "))}</div>` : ""}
    <div class="ppc-pl-row"><span>Confirm</span><b>retest holds + ${side} premium makes a new high</b></div>
    <div class="ppc-pl-row"><span>Buy</span><b>${p.strike ?? "—"} ${side} · now ₹${ppcNs(p.premNow)} · at trigger ${prem(p.premAtTrigger)}${p.delta != null ? ` · Δ ${ppcNs(p.delta)}` : ""}</b></div>
    <div class="ppc-pl-grid">
      <div><span>Stop (index)</span><b class="ppc-dn">${ppcNs(p.stop)}</b><em>${prem(p.premAtStop)}</em></div>
      <div><span>T1</span><b class="ppc-up">${ppcNs(p.t1)}</b><em>${prem(p.premAtT1)} · ${ppcEsc(p.t1Label)}</em></div>
      <div><span>T2</span><b class="ppc-up">${ppcNs(p.t2)}</b><em>${prem(p.premAtT2)}${p.t2Label ? " · " + ppcEsc(p.t2Label) : ""}</em></div>
      <div><span>R : R</span><b class="${p.rr >= 1.5 ? "ppc-up" : "ppc-dn"}">1 : ${ppcNs(p.rr)}</b><em>exit by 15:12</em></div>
    </div>
    <div class="ppc-pl-hist ${h.weak ? "ppc-wait" : ""}">Past ${side === "CE" ? "breakouts" : "breakdowns"} on this chart: <b>${h.n}</b>, followed through <b>${h.followedThrough}</b>${h.pct != null ? ` (${h.pct}%)` : ""}, failed ${h.failed}${h.weak ? " ⚠" : ""}</div>
    ${p.flags.length ? `<ul class="ppc-pl-flags">${p.flags.map((f) => `<li>⚠ ${ppcEsc(f)}</li>`).join("")}</ul>` : ""}
    <div class="ppc-sub">Premiums are model estimates from the live chain (delta/gamma/IV), not quotes.</div></div>`;
}
function ppcRenderPlans() {
  const T = PPC.d.trader, el = ppcEl("ppc-plans"); if (!el) return;
  if (!T || T.error) { el.innerHTML = ""; return; }
  const nt = T.plans?.noTrade;
  el.innerHTML = ppcPlanCard(T.plans?.bull, "CE")
    + `<div class="ppc-plan ppc-pl-nt"><h4>NO-TRADE ZONE</h4>${nt ? `<div class="ppc-nt-big">${ppcNs(nt.from)} – ${ppcNs(nt.to)}</div><div>${Math.round(nt.to - nt.from)} pts wide (${ppcNs((nt.to - nt.from) / (T.atr15 || 1), 1)} × ATR)</div>
      <div class="ppc-sub">Inside this band both premiums lose to theta while price chops. An experienced buyer waits for a 15-min close outside it.</div>` : '<div class="ppc-na">NOT AVAILABLE</div>'}
      ${ppcLowRiskIdeas(T)}
      <div class="ppc-sub" style="margin-top:6px">${ppcEsc(T.eventStats?.rule || "")}</div></div>`
    + ppcPlanCard(T.plans?.bear, "PE");
}
function ppcRenderHistory() {
  const T = PPC.d.trader; if (!T || T.error) return;
  const tm = T.tomorrow || { levels: [], scenarios: [] };
  ppcEl("ppc-tomorrow").innerHTML = `<h4>Next session map <span class="ppc-sub">levels and scenarios — not a direction call</span></h4>
    <div class="ppc-tm-lv">${tm.levels.map((l) => `<div><span>${ppcEsc(l.label)}</span><b>${ppcNs(l.value)}</b></div>`).join("")}</div>
    <ul class="ppc-tm-sc">${tm.scenarios.map((x) => `<li>${ppcEsc(x)}</li>`).join("")}</ul>`;
  const ev = (T.events || []).slice(-10).reverse(), dt = (t) => new Date((t + 19800) * 1000).toISOString().slice(5, 16).replace("T", " ");
  ppcEl("ppc-history").innerHTML = `<h4>Past breaks on this chart <span class="ppc-sub">what really happened next · ${ppcEsc(PPC.d.interval)}</span></h4>
    <table class="ppc-hist"><thead><tr><th>Time</th><th>Break</th><th>Level</th><th>Result</th><th>Max for</th><th>Max against</th></tr></thead><tbody>
    ${ev.map((e) => `<tr><td>${dt(e.time)}</td><td class="${e.dir === "UP" ? "ppc-up" : "ppc-dn"}">${e.dir === "UP" ? "▲ breakout" : "▼ breakdown"}<span class="ppc-sub"> · ${e.source === "TRENDLINE" ? "trendline" : "swing"}</span></td><td>${ppcR(e.level)}</td><td class="${e.outcome === "FOLLOWED THROUGH" ? "ppc-up" : e.outcome === "FAILED" ? "ppc-dn" : "ppc-wait"}">${ppcEsc(e.outcome.toLowerCase())}${e.bars != null ? ` (${e.bars} bars)` : ""}</td><td class="ppc-up">+${ppcR(e.mfe)}</td><td class="ppc-dn">−${ppcR(e.mae)}</td></tr>`).join("") || '<tr><td colspan="6" class="ppc-na">no breaks in the loaded history</td></tr>'}</tbody></table>
    <div class="ppc-sub">All breaks: ▲ ${T.eventStats.up.n} (${T.eventStats.up.pct ?? "—"}% followed through) · ▼ ${T.eventStats.down.n} (${T.eventStats.down.pct ?? "—"}%). Index points; premium P&L not simulated.</div>`;
}

/** Lowest-risk ideas: the nearest strong level on each side where a bounce / rejection trade has the trend behind it, and any LOW-risk break. */
function ppcLowRiskIdeas(T) {
  const spot = PPC.d.spot?.price; if (spot == null) return "";
  const lv = (T.levels || []).filter((v) => v.risk && v.risk.risk !== "FAR");
  const near = (arr) => arr.sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))[0];
  const sup = near(lv.filter((v) => v.price < spot && v.risk.bounce)), res = near(lv.filter((v) => v.price > spot && v.risk.bounce));
  const lowBreak = lv.filter((v) => v.risk.risk === "LOW");
  const items = [];
  if (sup) items.push(`<li class="ppc-up">CE on a bounce from <b>${ppcNs(sup.price)}</b> (${ppcEsc(sup.label)}) — stop just below</li>`);
  if (res) items.push(`<li class="ppc-dn">PE on a rejection from <b>${ppcNs(res.price)}</b> (${ppcEsc(res.label)}) — stop just above</li>`);
  for (const v of lowBreak.slice(0, 2)) items.push(`<li>${v.price > spot ? "CE" : "PE"} on a 15-min close ${v.price > spot ? "above" : "below"} <b>${ppcNs(v.price)}</b> — LOW-RISK break</li>`);
  return `<div class="ppc-lowrisk"><b>Lowest-risk ideas now</b>${items.length ? `<ul>${items.join("")}</ul>` : '<div class="ppc-sub">none — every nearby level is risky; standing aside is a position</div>'}<div class="ppc-sub">Still needs the 15-min candle, premium confirmation and the arbiter.</div></div>`;
}
