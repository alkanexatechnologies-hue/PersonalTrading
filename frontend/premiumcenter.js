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
    root.addEventListener("toggle", (e) => { if (e.target && e.target.id === "ppc-more" && e.target.open && PPC.d) { ppcRenderCards(); ppcRenderCharts(); ppcRenderRank(); } }, true);
  } else {
    try { const mcSym = (typeof MC !== "undefined" && MC.sym) || null; if (mcSym && mcSym !== PPC.sym && PPC_SYMS.some((s) => s[0] === mcSym)) { PPC.sym = mcSym; PPC.ceK = PPC.peK = null; } } catch { /* keep */ }
  }
  ppcLoad(); ppcStart();
}
function ppcStart() {
  ppcStop();
  const tick = () => {
    const hot = ["APPROACHING", "ARMED", "TRIGGERED"].some((x) => [PPC.d?.trader?.radar?.bull?.state, PPC.d?.trader?.radar?.bear?.state].includes(x));
    PPC.timer = setTimeout(() => { if (!document.hidden && document.body.classList.contains("ppc-fullwidth")) ppcLoad(); tick(); }, hot ? 5000 : 15000);
  };
  tick();
  if (!PPC.clock) PPC.clock = setInterval(ppcClock, 1000);
}
function ppcStop() { if (PPC.timer) clearTimeout(PPC.timer); PPC.timer = null; if (PPC.clock) clearInterval(PPC.clock); PPC.clock = null; }

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
  <div id="ppc-3x" class="ppc-3x"></div>
  <div class="ppc-sec">① Decision now</div>
  <div id="ppc-pt" class="ppc-pt"></div>
  <div id="ppc-coach" class="ppc-coach"></div>
  <div id="ppc-radar" class="ppc-radar"></div>
  <div class="ppc-sec" id="ppc-sec2">② Trade plan <span id="ppc-planfor" class="ppc-sub"></span></div>
  <div class="ppc-plans" id="ppc-plans"></div>
  <details class="ppc-calc" id="ppc-calc"><summary>🧮 <b>Premium calculator</b> <span class="ppc-sub">— the premium at any index price</span></summary><div id="ppc-calc-body"></div></details>
  <div class="ppc-sec" id="ppc-sec3" hidden>③ Expiry zero-hero</div>
  <div id="ppc-btsd" class="ppc-btsd" hidden></div>
  <div id="ppc-zh-today" class="ppc-zht" hidden></div>
  <div class="ppc-sec">④ Chart &amp; levels</div>
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
  <div class="ppc-sec">🎓 Chart School <span class="ppc-sub">— replay any day; the teacher explains every move (voice)</span></div>
  <div class="ppc-school" id="ppc-school"></div>
  <div class="ppc-sec">⑤ Context</div>
  <div class="ppc-ctx"><div id="ppc-eye" class="ppc-eye"></div><div id="ppc-trend" class="ppc-trendstrip"></div></div>
  <div id="ppc-lm" class="ppc-lm"></div>
  <details class="ppc-more" id="ppc-more"><summary>More details — next-session map · past breaks · arbiter &amp; risk gates · CE/PE cards · premium charts · strike ranking · zero-hero detail</summary>
  <div class="ppc-row2"><div class="ppc-card" id="ppc-tomorrow"></div><div class="ppc-card" id="ppc-history"></div></div>
  <details class="ppc-card ppc-arb"><summary><b>Arbiter &amp; risk gates</b> <span class="ppc-sub">final authority — the screen never overrides it</span> <span id="ppc-arb-sum"></span></summary><div id="ppc-master" class="ppc-master"></div></details>
  <details class="ppc-card ppc-zh" id="ppc-zh-box"><summary><b>🎲 Zero-Hero detail ({SYM})</b> <span id="ppc-zh-sum"></span></summary><div id="ppc-zh"></div></details>
  <div class="ppc-cards"><div id="ppc-card-ce" class="ppc-card"></div><div id="ppc-card-pe" class="ppc-card"></div><div id="ppc-card-cmp" class="ppc-card"></div></div>
  <div class="ppc-charts2">
    <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>CE premium</b> <span id="ppc-ce-legend" class="ppc-sub"></span></div><div id="ppc-ch-ce" class="ppc-ch"></div></div>
    <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>PE premium</b> <span id="ppc-pe-legend" class="ppc-sub"></span></div><div id="ppc-ch-pe" class="ppc-ch"></div></div>
  </div>
  <div class="ppc-card ppc-chartcard"><div class="ppc-ch-head"><b>CE vs PE — % move since the session's first candle</b> <span class="ppc-sub">(same strikes as the cards)</span></div><div id="ppc-ch-cmp" class="ppc-ch ppc-ch-cmp"></div></div>
  <details class="ppc-card"><summary class="ppc-ch-head"><b>Strike ranking</b> <span class="ppc-sub">ATM ± 3 · ranked by structure alignment, quote quality and modelled move after the spread — never by premium price alone</span></summary><div id="ppc-rank" class="ppc-rankwrap"></div></details>
  </details>
  <div class="ppc-foot" id="ppc-foot"></div>`;
}

function ppcOnClick(e) {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.act === "back") { ppcStop(); if (typeof switchTab === "function") switchTab("marketcommand"); return; }
  if (b.dataset.sym) { PPC.sym = b.dataset.sym; PPC.ceK = PPC.peK = null; PPC.off = 0; ppcLoad(true); }
  if (b.dataset.tf) { PPC.tf = b.dataset.tf; ppcLoad(true); }
  if (b.dataset.act === "alerts") { ppcEnableAlerts(); return; }
  if (b.dataset.btsd) { ppcBTSDForm(b.dataset.btsd); return; }
  if (b.dataset.act === "btsd-cancel") { PPC._btsdSide = null; ppcRenderBTSD(true); return; }
  if (b.dataset.act === "btsd-save") { ppcBTSDSave(); return; }
  if (b.dataset.btsdClose) { ppcBTSDClose(b.dataset.btsdClose); return; }
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
  if (t.id === "ppc-zh-budget") { try { localStorage.setItem("ppc-zh-budget", t.value); } catch { /* private */ } ppcLoadZH(true); }
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
  ppcEl("ppc-status").innerHTML = `${ppcBadge(d.dataStatus)} <span>Session <b>${ppcEsc(d.session)}</b></span> <span>Last candle <b>${ppcHm(d.exchangeTs)}</b>${d.ageSec != null && d.session === "OPEN" ? ` (${d.ageSec}s ago)` : ""}</span> <span>Updated <b>${ppcHm(d.generatedAt)}</b> IST</span> <span class="ppc-conn ${/not/.test(d.provider) ? "ppc-bad" : "ppc-ok"}">● ${ppcEsc(d.provider)}</span>${d.chainStale ? ` <span class="ppc-badge ppc-warn" title="Dhan refused the last option-chain refresh (rate limit); showing the last good chain">CHAIN ${d.chainAgeSec}s OLD</span>` : ""}`;
  const sp = d.spot || {};
  ppcEl("ppc-quote").innerHTML = `<span class="ppc-qname">${ppcEsc(d.name)}</span><span class="ppc-qpx ${ppcCls(sp.change)}">${ppcNs(sp.price)}</span><span class="${ppcCls(sp.change)}">${ppcSg(sp.change)} (${ppcSg(sp.changePct, 2, "%")})</span>
    <span>O <b>${ppcNs(sp.open)}</b></span><span>H <b>${ppcNs(sp.high)}</b></span><span>L <b>${ppcNs(sp.low)}</b></span><span>Prev close <b>${ppcNs(sp.prevClose)}</b></span>
    <span>ATM <b>${d.atm ?? "—"}</b></span><span>Expiry <b>${ppcEsc(d.expiry || "—")}</b></span>${d.session !== "OPEN" ? `<span class="ppc-warnt">Session ${ppcEsc(sp.sessionDay || "")} — market ${ppcEsc(d.session)}</span>` : ""}`;
  ppcLoad3x(); ppcSchoolInit(); ppcCalcInit(); if (ppcEl("ppc-calc")?.open && PPC._calcKey !== `${PPC.sym}:${PPC.off || 0}`) ppcCalcOpen(); ppcRenderMaster(); ppcRenderProTrader(); ppcRenderLevelMemory(); ppcRenderRadar(); ppcLoadZH(); ppcLoadZHToday(); ppcLoadEye(); ppcRenderBTSD(); ppcRenderCoach(); ppcRenderTV(); ppcRenderLadder(); ppcRenderPlans(); ppcRenderHistory(); if (ppcEl("ppc-more")?.open) { ppcRenderCards(); ppcRenderCharts(); ppcRenderRank(); }
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
    <details class="ppc-k-list"><summary class="ppc-k-lbl">CHECKLIST ${c.total ? `${c.passed}/${c.total}` : ""} ▾</summary>${c.checklist.map((x) => `<div class="${x.ok === true ? "ppc-up" : x.ok === false ? "ppc-dn" : "ppc-sub ppc-k-na"}">${x.ok === true ? "✓" : x.ok === false ? "✗" : "·"} ${ppcEsc(x.item)} <span class="ppc-sub">${ppcEsc(x.detail)}</span></div>`).join("")}</details>`;
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
  const h = window.innerWidth < 700 ? 340 : Math.max(400, Math.min(540, window.innerHeight - 300));
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
/** The trader view's level + plan price lines (ladder levels with buyer risk, BULL/BEAR starts, stops, targets).
 *  Shared by this chart and Market Command (mcx.js) so both mark levels identically. Returns createPriceLine specs. */
function ppcLevelLines(T, opt) {
  const out = [], inView = opt.inView || (() => true); if (!T || T.error) return out;
  const kindCol = { "PREV DAY": "#b2b5be", TODAY: "#90caf9", WEEK: "#ce93d8", PIVOT: "#80deea", TRENDLINE: "#ffd54f", OI: "#ffab91" };
  const short = (l) => l.replace("Prev day ", "PD ").replace("Prev week ", "PW ").replace("Prev close", "PDC").replace("Today ", "Day ").replace(" pivot", "").replace(/OI call wall.*/, "Call wall").replace(/OI put wall.*/, "Put wall").replace(/Major call OI.*/, "Major call").replace(/Major put OI.*/, "Major put").replace(" trendline", " TL");
  const tol = 0.1 * (T.atr15 || 1), names = {};
  if (opt.levels) {
    // one label per price: levels within 0.1·ATR merge ("PD high/PDC"); a level that IS a plan line is named on the plan line
    const planPx = opt.plan && T.plans ? [T.plans.bull, T.plans.bear].filter(Boolean).flatMap((p) => [p.trigger, p.entry, p.stop, p.t1, p.t2]).filter((x) => x != null) : [];
    const groups = [];
    for (const v of (T.levels || []).filter((v) => inView(v.price) && v.kind !== "TRENDLINE")) { const g = groups.find((g) => Math.abs(g.price - v.price) <= tol); if (g) g.items.push(v); else groups.push({ price: v.price, items: [v] }); }
    for (const g of groups) {
      const lbl = g.items.map((v) => short(v.label)).join("/"), star = g.items.length > 1 || g.items.some((v) => v.confluence);
      if (planPx.some((x) => Math.abs(x - g.price) <= tol)) { names[g.price.toFixed(2)] = lbl; continue; }
      const rk = g.items.map((v) => v.risk).find(Boolean), rc = rk ? PPC_RISK[rk.risk] : null;
      out.push({ price: g.price, color: rc ? rc.col : kindCol[g.items[0].kind] || "#787b86", lineWidth: star ? 2 : 1, lineStyle: 2, axisLabelVisible: true, title: (star ? "★ " : "") + lbl + (rc && rk.risk !== "FAR" ? ` · ${rc.short}` : "") });
    }
  }
  if (opt.plan && T.plans) {
    const nameAt = (px) => { const k = Object.keys(names).find((x) => Math.abs(Number(x) - px) <= tol); return k ? ` · ${names[k]}` : ""; };
    for (const [p, col, nm] of [[T.plans.bull, TVC.ce, "BULL"], [T.plans.bear, TVC.pe, "BEAR"]]) {
      if (!p) continue;
      out.push({ price: p.entry, color: col, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `${nm} STARTS${p.triggerRisk && p.triggerRisk.risk !== "FAR" ? " · " + PPC_RISK[p.triggerRisk.risk].short : ""}` });
      out.push({ price: p.trigger, color: col + "99", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: `level${nameAt(p.trigger)}` });
      out.push({ price: p.stop, color: "#f23645", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} STOP` });
      out.push({ price: p.t1, color: "#089981", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} T1${nameAt(p.t1)}` });
      if (p.t2 != null && inView(p.t2)) out.push({ price: p.t2, color: "#089981", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} T2${nameAt(p.t2)}` });
    }
  }
  return out;
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
      const pr = ch.addLineSeries({ color: col, lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: `${tl.kind === "SELLER" ? "Seller" : "Buyer"} TL${tl.minor ? " (minor)" : ""}${tl.touches ? ` · ${tl.touches + 2} touches` : ""}` });
      pr.setData([{ time: ppcT(tl.end.time), value: tl.end.price }, ...tl.projection.map((p) => ({ time: ppcT(p.time), value: p.value }))]);
    }
  }
  // levels (ladder) — only those inside the visible price neighbourhood
  const lo = Math.min(...cs.slice(-120).map((c) => c.low)), hi = Math.max(...cs.slice(-120).map((c) => c.high)), pad = (T?.atr15 || 0) * 1.5;
  const inView = (p) => p >= lo - pad && p <= hi + pad;
  for (const spec of ppcLevelLines(T, { levels: L.levels, plan: L.plan, inView })) s.createPriceLine(spec);
  // the no-trade zone
  if (L.plan && T?.plans) {
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
    const tag = bull && Math.abs(v.price - bull.trigger) < 0.01 ? `<i class="ppc-lt ce">Bull starts ${bull.entry}</i>` : bear && Math.abs(v.price - bear.trigger) < 0.01 ? `<i class="ppc-lt pe">Bear starts ${bear.entry}</i>` : "";
    const rk = v.risk, rc = rk ? PPC_RISK[rk.risk] : null;
    rows.push(`<div class="ppc-lad ppc-lk-${v.kind.replace(/\s/g, "")}" title="${ppcEsc((v.with ? "Confluence with: " + v.with.join(", ") + "\n" : "") + (rk ? `Break ${rk.side === "ABOVE" ? "above" : "below"} = ${rk.risk} RISK (score ${rk.score}):\n• ` + rk.reasons.join("\n• ") : ""))}"><span>${ppcNs(v.price)}</span><span>${v.confluence ? "★ " : ""}${ppcEsc(v.label)} ${tag}${rc ? ` <i class="ppc-rk ppc-rk-${rc.cls}">${rc.short}</i>` : ""}</span><span class="ppc-sub">${spot != null ? (v.price > spot ? "+" : "") + Math.round(v.price - spot) : ""}</span>
      ${rk && rk.risk !== "FAR" ? `<div class="ppc-lad-why">${ppcEsc(rk.reasons.filter((x) => !/room to|with the/.test(x) || rk.risk === "LOW").slice(0, 2).join(" · "))}</div>` : ""}${rk?.bounce ? `<div class="ppc-lad-bounce">↺ ${ppcEsc(rk.bounce)}</div>` : ""}</div>`);
  }
  if (!placed && spot != null) rows.push(`<div class="ppc-lad-spot">▶ ${ppcNs(spot)} SPOT</div>`);
  el.innerHTML = rows.join("");
}

/** Trade Review Desk grade (A take · B take small · C skip) with every check; hover a check for its detail. */
function ppcReviewLine(rv) {
  if (!rv) return "";
  const c = rv.grade === "A" ? "ppc-up" : rv.grade === "B" ? "ppc-wait" : "ppc-dn";
  return `<div class="ppc-rv"><b class="${c}">🧪 Review ${ppcEsc(rv.grade)}</b> <span class="ppc-sub">${rv.score}%</span> → <b class="${c}">${ppcEsc(rv.verdict)}</b>
    <div class="ppc-rv-ck">${rv.checks.map((k) => `<span class="${k.ok === true ? "ok" : k.ok === false ? "bad" : "mid"}" title="${ppcEsc(k.detail)}">${k.ok === true ? "✓" : k.ok === false ? "✗" : "~"} ${ppcEsc(k.label)}</span>`).join("")}</div>
    ${rv.reasoning?.length ? `<details class="ppc-rv-why"><summary>🧠 Trader's reasoning</summary><ul>${rv.reasoning.map((x, i) => `<li${i === rv.reasoning.length - 1 ? ' class="dec"' : ""}>${ppcEsc(x)}</li>`).join("")}</ul></details>` : ""}</div>`;
}
function ppcPlanCard(p, side) {
  const bull = side === "CE", nm = bull ? "BULL PLAN" : "BEAR PLAN", cls = bull ? "ppc-pl-ce" : "ppc-pl-pe";
  if (!p) return `<div class="ppc-plan ${cls}"><h4>${nm}</h4><div class="ppc-na">No level ${bull ? "above" : "below"} the price — NOT AVAILABLE</div></div>`;
  const r0 = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN")), pr = (v) => (v == null ? "—" : "₹" + Math.round(v));
  const rk = p.triggerRisk ? PPC_RISK[p.triggerRisk.risk] : null, h = p.history;
  const row = (lbl, idx, prem, cls2, note = "") => `<tr><td>${lbl}</td><td class="${cls2}"><b>${idx}</b></td><td>${prem}</td><td class="ppc-sub">${note}</td></tr>`;
  return `<div class="ppc-plan ${cls}">
    <div class="ppc-pl-head"><h4>${nm}</h4>${rk ? `<i class="ppc-rk ppc-rk-${rk.cls}">${rk.short}</i>` : ""}</div>
    <div class="ppc-pl-start">Trigger: 15-min close ${bull ? "above" : "below"} <b>${r0(p.entry)}</b></div>
    <div class="ppc-pl-retest">⏳ <b>Then wait for the retest</b> — trade only when a 5-min candle comes back near <b>${r0(p.trigger)}</b> and closes ${bull ? "above" : "below"} it (within 30 min). <span class="ppc-sub">Never buy the breakout candle itself.</span></div>
    <div class="ppc-pl-buy">Buy <b>${p.strike ?? "—"} ${side}</b>${p.premNow != null ? ` <span class="ppc-sub">(now ₹${Math.round(p.premNow)})</span>` : ""}</div>
    ${p.premPos ? `<div class="ppc-pp ${p.premPos.danger ? "danger" : ""}">${ppcEsc(p.premPos.danger ? p.premPos.text : "Premium " + p.premPos.text)}</div>` : ""}
    ${ppcReviewLine(PPC.d?.trader?.review?.[bull ? "bull" : "bear"])}
    <table class="ppc-pl-tbl"><thead><tr><th></th><th>NIFTY</th><th>${side} premium</th><th></th></tr></thead><tbody>
      ${row("Start", r0(p.entry), pr(p.premAtEntry), bull ? "ppc-ce-t" : "ppc-pe-t")}
      ${row("Stop", r0(p.stop), pr(p.premAtStop), "ppc-dn", `−${Math.abs(Math.round(p.entry - p.stop))} pts`)}
      ${row("Target 1", r0(p.t1), pr(p.premAtT1), "ppc-up", `+${Math.abs(Math.round(p.t1 - p.entry))} pts`)}
      ${p.t2 != null ? row("Target 2", r0(p.t2), pr(p.premAtT2), "ppc-up", `+${Math.abs(Math.round(p.t2 - p.entry))} pts`) : ""}
    </tbody></table>
    <div class="ppc-pl-rr">Reward : risk <b class="${p.rr >= 1.5 ? "ppc-up" : "ppc-dn"}">1 : ${ppcNs(p.rr, 1)}</b> · exit by 15:12</div>
    <details class="ppc-pl-why"><summary>Why ${r0(p.entry)}?</summary>
      <div>Level ${ppcNs(p.trigger)} — ${ppcEsc(p.triggerLabel)}; the plan starts ${p.buffer} pts beyond it (0.1 ATR) so a one-tick poke does not count.</div>
      <div>Stop = ½ ATR back inside: a close there means the break failed. Targets = the next levels at least ½ ATR apart.</div>
      ${p.triggerRisk ? `<div>Risk: ${ppcEsc(p.triggerRisk.reasons.join(" · "))}</div>` : ""}
      <div>Past ${bull ? "breakouts" : "breakdowns"} on this chart: ${h.n}, followed through ${h.followedThrough}${h.pct != null ? ` (${h.pct}%)` : ""}.</div>
      ${p.flags.length ? `<ul class="ppc-pl-flags">${p.flags.map((f) => `<li>⚠ ${ppcEsc(f)}</li>`).join("")}</ul>` : ""}
      <div class="ppc-sub">Premiums are model estimates from the live chain (delta/gamma/IV), not quotes.</div>
    </details></div>`;
}
function ppcRenderPlans() {
  const T = PPC.d.trader, el = ppcEl("ppc-plans"); if (!el) return;
  const pf = ppcEl("ppc-planfor"); if (pf && T?.planFor) { const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10); pf.innerHTML = T.planFor === today ? "for today" : `<b class="ppc-wait">for the next session · ${ppcEsc(T.planFor)}</b>`; }
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
  ppcLoadNDM();
  ppcEl("ppc-tomorrow").innerHTML = `<div id="ppc-ndm">${PPC._ndmSym === PPC.sym ? PPC._ndmHtml || "" : ""}</div>
    <h4>Next session map <span class="ppc-sub">levels and scenarios — not a direction call</span></h4>
    <div class="ppc-tm-lv">${tm.levels.map((l) => `<div><span>${ppcEsc(l.label)}</span><b>${ppcNs(l.value)}</b></div>`).join("")}</div>
    <ul class="ppc-tm-sc">${tm.scenarios.map((x) => `<li>${ppcEsc(x)}</li>`).join("")}</ul>`;
  const ev = (T.events || []).slice(-10).reverse(), dt = (t) => new Date((t + 19800) * 1000).toISOString().slice(5, 16).replace("T", " ");
  ppcEl("ppc-history").innerHTML = `<h4>Past breaks on this chart <span class="ppc-sub">what really happened next · ${ppcEsc(PPC.d.interval)}</span></h4>
    <table class="ppc-hist"><thead><tr><th>Time</th><th>Break</th><th>Level</th><th>Result</th><th>Max for</th><th>Max against</th></tr></thead><tbody>
    ${ev.map((e) => `<tr><td>${dt(e.time)}</td><td class="${e.dir === "UP" ? "ppc-up" : "ppc-dn"}">${e.dir === "UP" ? "▲ breakout" : "▼ breakdown"}<span class="ppc-sub"> · ${e.source === "TRENDLINE" ? "trendline" : "swing"}</span></td><td>${ppcR(e.level)}</td><td class="${e.outcome === "FOLLOWED THROUGH" ? "ppc-up" : e.outcome === "FAILED" ? "ppc-dn" : "ppc-wait"}">${ppcEsc(e.outcome.toLowerCase())}${e.bars != null ? ` (${e.bars} bars)` : ""}</td><td class="ppc-up">+${ppcR(e.mfe)}</td><td class="ppc-dn">−${ppcR(e.mae)}</td></tr>`).join("") || '<tr><td colspan="6" class="ppc-na">no breaks in the loaded history</td></tr>'}</tbody></table>
    <div class="ppc-sub">All breaks: ▲ ${T.eventStats.up.n} (${T.eventStats.up.pct ?? "—"}% followed through) · ▼ ${T.eventStats.down.n} (${T.eventStats.down.pct ?? "—"}%). Index points; premium P&L not simulated.</div>`;
}

/** 🎖 ProTrader Next-Day Map (NIFTY / SENSEX): opening odds, first 5 min, 09:30 stand, direction, rejection / bounce — every
 *  probability from the 2-year Dhan opening study; points marked LIVE once the session has shown them. Refreshed each minute. */
async function ppcLoadNDM() {
  if (!["^NSEI", "^BSESN"].includes(PPC.sym)) { PPC._ndmHtml = ""; PPC._ndmSym = PPC.sym; return; }
  if (PPC._ndmSym === PPC.sym && Date.now() - (PPC._ndmAt || 0) < 60000) return;
  PPC._ndmAt = Date.now();
  let r = null; try { r = await fetch(`/api/next-day-map?symbol=${encodeURIComponent(PPC.sym)}`).then((x) => x.json()); } catch { return; }
  const b = (s) => ppcEsc(s).replace(/&lt;(\/?)b&gt;/g, "<$1b>");   // the server marks key numbers in bold — nothing else is let through
  const dd = (s) => (s ? new Date(s + "T00:00:00Z").toUTCString().slice(0, 11) : "");
  PPC._ndmSym = PPC.sym;
  PPC._ndmHtml = !r || !r.ok ? `<div class="ppc-ndm"><h4>🎖 ProTrader next-day map</h4><div class="ppc-sub">${ppcEsc(r?.error || "not available")}</div></div>`
    : `<div class="ppc-ndm"><h4>🎖 ProTrader next-day map <span class="ppc-sub">${ppcEsc(r.index)} · for ${ppcEsc(/^\d{4}-/.test(r.planLabel || "") ? dd(r.planLabel) : r.planLabel || dd(r.planFor))}</span></h4>
      <ol class="ppc-ndm-pts">${r.points.map((p) => `<li${p.live ? ' class="live"' : ""}><div class="ppc-ndm-t">${ppcEsc(p.title)}${p.live ? ' <span class="ppc-badge ppc-ok">LIVE</span>' : ""}</div>${p.lines.map((l) => `<div class="ppc-ndm-l">${b(l)}</div>`).join("")}</li>`).join("")}</ol>
      <div class="ppc-sub">${ppcEsc(r.basis)}. Information only — trades still come from the plan and its checks.</div></div>`;
  const el = ppcEl("ppc-ndm"); if (el) el.innerHTML = PPC._ndmHtml;
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


// ================================================================ opportunity radar + alerts (catch the move at the right time)
const PPC_OPP = {
  IDLE: { cls: "idle", icon: "○", word: "IDLE" }, APPROACHING: { cls: "appr", icon: "◔", word: "APPROACHING — GET READY" },
  ARMED: { cls: "armed", icon: "◉", word: "ARMED — WAIT FOR THE CLOSE" }, TRIGGERED: { cls: "trig", icon: "●", word: "TRIGGERED" },
  FAILED: { cls: "fail", icon: "✕", word: "FAILED — STAND ASIDE" }, MISSED: { cls: "miss", icon: "↷", word: "MISSED — DON'T CHASE" },
};
function ppcRadarTile(o, nm) {
  if (!o) return "";
  const m = PPC_OPP[o.state] || PPC_OPP.IDLE, a = o.distAtr;
  // progress toward the start: 100 % at the start, 0 % at ≥ 1.5 ATR away
  const pct = a == null ? 0 : Math.max(0, Math.min(100, Math.round((1 - Math.max(0, a) / 1.5) * 100)));
  return `<div class="ppc-rt ppc-rt-${m.cls} ${o.side === "CE" ? "ppc-rt-ce" : "ppc-rt-pe"}">
    <div class="ppc-rt-top"><b>${nm}</b> <span class="ppc-rt-side">${o.side}</span><span class="ppc-rt-state">${m.icon} ${m.word}</span></div>
    <div class="ppc-rt-mid"><span>Start <b>${o.entry ?? "—"}</b></span><span>${o.distPts == null ? "" : o.distPts > 0 ? `<b>${Math.round(o.distPts)}</b> pts to go` : `<b>${Math.abs(Math.round(o.distPts))}</b> pts beyond`}</span>
      ${o.state === "ARMED" ? `<span class="ppc-rt-cd" data-closes="${o.closesAt}">closes in —</span>` : o.triggeredAt ? `<span>at ${ppcHm(o.triggeredAt + 900)}</span>` : ""}</div>
    <div class="ppc-rt-bar"><i style="width:${pct}%"></i></div>
    <div class="ppc-rt-txt">${ppcEsc(o.text)}</div><div class="ppc-rt-next">→ ${ppcEsc(o.next)}</div></div>`;
}
function ppcRenderRadar() {
  const el = ppcEl("ppc-radar"), R = PPC.d?.trader?.radar; if (!el) return;
  if (!R) { el.innerHTML = ""; return; }
  const f = R.forming15;
  el.innerHTML = `<div class="ppc-rd-head"><b>OPPORTUNITY RADAR</b> <span class="ppc-sub">15-min candle ${f ? `${ppcHm(f.time)}–${ppcHm(f.time + 900)} · O ${ppcR(f.open)} H ${ppcR(f.high)} L ${ppcR(f.low)} C ${ppcR(f.close)}` : R.preOpen ? '<b class="ppc-wait">PRE-OPEN — indicative price only; the plan settles on real trading after 09:15</b>' : "— market not open"}</span>
      <span class="ppc-rd-clock" id="ppc-rd-clock" data-closes="${R.closesAt || ""}"></span>
      <button class="ppc-tvbtn" data-act="alerts" id="ppc-alert-btn">${PPC.alertsOn ? "🔔 Alerts on" : "🔕 Enable alerts"}</button></div>
    <div class="ppc-rd-tiles">${ppcRadarTile(R.bull, "BULL PLAN")}${ppcRadarTile(R.bear, "BEAR PLAN")}</div>`;
  PPC.clockSkew = R.serverTime ? R.serverTime - Math.floor(Date.now() / 1000) : 0;
  ppcClock(); ppcAlertOnChange(R);
}
function ppcClock() {
  const now = Math.floor(Date.now() / 1000) + (PPC.clockSkew || 0);
  document.querySelectorAll("#ppc-root [data-closes]").forEach((e) => {
    const c = Number(e.dataset.closes); if (!c) { e.textContent = ""; return; }
    const s = Math.max(0, c - now), txt = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    e.textContent = e.id === "ppc-rd-clock" ? `candle closes in ${txt}` : `closes in ${txt}`;
    e.classList.toggle("ppc-urgent", s <= 60);
  });
}
// alerts: only on a CHANGE of state, per index and side; sound + browser notification + tab title
function ppcEnableAlerts() {
  PPC.alertsOn = !PPC.alertsOn;
  try { localStorage.setItem("ppc-alerts", PPC.alertsOn ? "1" : "0"); } catch { /* private mode */ }
  if (PPC.alertsOn && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  if (PPC.alertsOn) ppcBeep("TRIGGERED");
  const b = ppcEl("ppc-alert-btn"); if (b) b.textContent = PPC.alertsOn ? "🔔 Alerts on" : "🔕 Enable alerts";
}
try { PPC.alertsOn = localStorage.getItem("ppc-alerts") === "1"; } catch { PPC.alertsOn = false; }
function ppcBeep(state) {
  try {
    const ctx = PPC.audio || (PPC.audio = new (window.AudioContext || window.webkitAudioContext)());
    const tones = state === "TRIGGERED" ? [880, 1175, 1568] : state === "ARMED" ? [660, 880] : state === "FAILED" ? [440, 330] : [520];
    tones.forEach((f, i) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f; o.connect(g); g.connect(ctx.destination); const t = ctx.currentTime + i * 0.18; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16); o.start(t); o.stop(t + 0.17); });
  } catch { /* no audio */ }
}
function ppcAlertOnChange(R) {
  PPC.lastOpp = PPC.lastOpp || {};
  for (const o of [R.bull, R.bear]) {
    if (!o) continue;
    const key = `${PPC.sym}|${o.side}`, prev = PPC.lastOpp[key];
    PPC.lastOpp[key] = o.state;
    if (prev === undefined || prev === o.state || !["APPROACHING", "ARMED", "TRIGGERED", "FAILED"].includes(o.state)) continue;
    const msg = `${PPC.d.name} ${o.side === "CE" ? "BULL" : "BEAR"}: ${PPC_OPP[o.state].word} — ${o.text}`;
    if (!PPC.alertsOn) continue;
    ppcBeep(o.state);
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("🎯 " + PPC_OPP[o.state].word, { body: msg + "\n→ " + o.next, tag: key }); } catch { /* blocked */ }
    const t0 = document.title; document.title = `● ${o.side} ${o.state}`; setTimeout(() => { document.title = t0; }, 8000);
  }
}


// ================================================================ Zero-Hero panel (expiry day)
async function ppcLoadZH(force) {
  const box = ppcEl("ppc-zh-box"), el = ppcEl("ppc-zh"); if (!box || !el) return;
  if (!force && PPC._zhAt && Date.now() - PPC._zhAt < 14000 && PPC._zhSym === PPC.sym) return;
  PPC._zhAt = Date.now(); PPC._zhSym = PPC.sym;
  let budget = ""; try { budget = localStorage.getItem("ppc-zh-budget") || ""; } catch { /* private */ }
  try {
    const d = await fetch(`/api/zero-hero-live?symbol=${encodeURIComponent(PPC.sym)}${budget ? "&budget=" + encodeURIComponent(budget) : ""}`).then((r) => r.json());
    if (!d.available) { el.innerHTML = `<div class="ppc-na">NOT AVAILABLE — ${ppcEsc(d.error || "")}</div>`; return; }
    const trig = d.sides.some((x) => x.trigger.state === "TRIGGERED");
    ppcEl("ppc-zh-sum").innerHTML = ` · <b class="${!d.isExpiry ? "ppc-sub" : trig ? "ppc-up" : "ppc-wait"}">${ppcEsc(d.window)}${trig ? " · TRIGGERED" : ""}</b>`;
    if (trig && d.isExpiry && !box.open) box.open = true;
    const card = (x) => {
      const t = x.trigger, col = x.side === "CE" ? "ppc-up" : "ppc-dn";
      return `<div class="ppc-zh-card ${t.state === "TRIGGERED" ? "ppc-zh-trig" : ""}">
        <div class="ppc-zh-h"><b class="${col}">${x.side} ${x.strike ?? "—"}</b> <span class="ppc-sub">2 steps OTM</span> <span class="ppc-chip ppc-c-${t.state === "TRIGGERED" ? "bull" : "wait"}">${ppcEsc(t.state)}</span></div>
        <div class="ppc-zh-g">
          <div><span>Premium</span><b>₹${ppcNs(x.premium)}</b><em>bid ${ppcNs(x.bid)} / ask ${ppcNs(x.ask)}${x.spreadPct != null ? ` · ${ppcNs(x.spreadPct, 1)}%` : ""}</em></div>
          <div><span>2× needs index at</span><b>${ppcNs(x.doubleAt)}</b><em>${x.moveToDouble != null ? x.moveToDouble.toFixed(0) + " pts away" : "—"}</em></div>
          <div title="Chance the index TOUCHES the 2× level before 15:30, from this option's own price. Waiting makes it smaller every minute."><span>Touch chance (model)</span><b>${x.pTouchDouble != null ? x.pTouchDouble.toFixed(0) + "%" : "—"}</b><em>not a win rate</em></div>
          <div><span>Writers at this strike (15 min)</span><b class="${x.writersCovering ? "ppc-up" : x.writersCovering === false ? "ppc-dn" : ""}">${x.writersCovering == null ? "—" : x.writersCovering ? "covering" : "adding"}</b><em>${x.oiChange15 != null ? (x.oiChange15 > 0 ? "+" : "") + ppcL(x.oiChange15) : ""}</em></div>
          <div><span>Cost / lot</span><b>${x.costPerLot != null ? "₹" + ppcNs(x.costPerLot, 0) : "—"}</b><em>${x.lots != null ? `budget allows ${x.lots} lot${x.lots === 1 ? "" : "s"}` : "set a budget"}</em></div>
        </div>
        <div class="ppc-zh-tr">${ppcEsc(t.detail || "")}</div>
        <div class="ppc-zh-v">${ppcEsc(x.verdict)}</div></div>`;
    };
    el.innerHTML = `<div class="ppc-zh-top"><span>Window <b>${ppcEsc(d.window)}</b></span><span>Expiry <b>${ppcEsc(d.expiry)}</b></span><span>Spot <b>${ppcNs(d.spot)}</b></span>
        <span title="ATM call + put = the move the market is pricing until the close">Market prices ±<b>${ppcNs(d.straddle, 0)}</b> pts to the close</span><span><b>${d.minutesToClose}</b> min left</span>
        <label>Max loss budget ₹ <input id="ppc-zh-budget" type="number" min="0" step="500" value="${ppcEsc(d.budget ?? "")}" placeholder="e.g. 2000"></label>${d.chainStale ? '<span class="ppc-badge ppc-warn">CHAIN STALE</span>' : ""}</div>
      ${d.history ? `<div class="ppc-zh-hist">📉 <b>2-year record:</b> ${ppcEsc(d.history.text)}</div>` : `<div class="ppc-zh-hist">2-year record for this index: being tested.</div>`}
      <div class="ppc-zh-cards">${d.sides.map(card).join("")}</div>
      <ul class="ppc-zh-rules">${d.rules.map((r) => `<li>${ppcEsc(r)}</li>`).join("")}</ul>`;
  } catch (e) { el.innerHTML = `<div class="ppc-na">NOT AVAILABLE — ${ppcEsc(e.message || "")}</div>`; }
}


// ================================================================ Zero-Hero TODAY: NIFTY + SENSEX (+ selected) — shows whichever expires today
async function ppcLoadZHToday(force) {
  const el = ppcEl("ppc-zh-today"); if (!el) return;
  if (PPC._zhtSym !== PPC.sym) { PPC._zhtSym = PPC.sym; force = true; ppcRenderZHToday(); }   // index switched: hide/show at once
  if (!force && PPC._zhtAt && Date.now() - PPC._zhtAt < 14000) return; PPC._zhtAt = Date.now();
  const syms = [PPC.sym];   // only the selected index — its expiry strip shows only on its own expiry day
  let budget = ""; try { budget = localStorage.getItem("ppc-zh-budget") || ""; } catch { /* private */ }
  // each index renders as soon as its own data arrives (a slow chain never blocks the others)
  PPC._zht = PPC._zht || {};
  await Promise.all(syms.map((s) => fetch(`/api/zero-hero-live?symbol=${encodeURIComponent(s)}&zht=1${budget ? "&budget=" + budget : ""}`).then((r) => r.json()).then((d) => { if (d) { PPC._zht[s] = d; ppcRenderZHToday(); } }).catch(() => {})));
}
function ppcRenderZHToday() {
  const el = ppcEl("ppc-zh-today"); if (!el) return;
  const cur = (PPC._zht || {})[PPC.sym];
  const exp = cur && cur.available && cur.isExpiry ? [cur] : [];
  el.hidden = !exp.length; ppcSec3();
  if (!exp.length) { el.innerHTML = ""; return; }
  const side = (d, x) => {
    const t = x.trigger.state, c = t === "TRIGGERED" ? "on" : "";
    return `<div class="ppc-zht-s ${c}"><b class="${x.side === "CE" ? "ppc-up" : "ppc-dn"}">${x.side} ${x.strike ?? "—"}</b> ₹${ppcNs(x.premium)} <span class="ppc-chip ppc-c-${t === "TRIGGERED" ? "bull" : "wait"}">${ppcEsc(t)}</span>
      <span class="ppc-sub">2× at ${ppcNs(x.doubleAt, 0)} (${x.moveToDouble != null ? Math.round(x.moveToDouble) : "—"} pts) · touch ${x.pTouchDouble != null ? Math.round(x.pTouchDouble) + "%" : "—"} · writers ${x.writersCovering == null ? "—" : x.writersCovering ? "covering" : "adding"}${x.costPerLot ? ` · ₹${Math.round(x.costPerLot)}/lot` : ""}</span></div>`;
  };
  const hm2 = (t) => new Date((t + 19800) * 1000).toISOString().slice(11, 16), rp = (v) => (v == null ? "—" : "₹" + (Math.round(v * 10) / 10));
  const tradeCard = (t) => {
    const st = t.state === "CLOSED" ? `CLOSED — ${ppcEsc(t.exitWhy || "")} @ ${rp(t.exitPrem)} (${t.exitPrem != null ? Math.round(((t.exitPrem / t.entryPrem) - 1) * 100) + "%" : "—"})` : t.state === "T1" ? "T1 HIT — half booked, stop at entry" : "OPEN";
    return `<div class="ppc-zht-trade ${t.state === "CLOSED" ? "closed" : "open"}">
      <div class="ppc-zht-th"><b>TRADE #${t.n}</b> · ${hm2(t.openedAt)} · <b class="${t.side === "CE" ? "ppc-up" : "ppc-dn"}">${t.strike} ${t.side}</b> · <span class="ppc-chip ppc-c-${t.state === "CLOSED" ? "muted" : "bull"}">${st}</span>${t.state !== "CLOSED" && t.livePrem != null ? ` · now <b>${rp(t.livePrem)}</b> <span class="${t.livePnlPct >= 0 ? "ppc-up" : "ppc-dn"}">(${t.livePnlPct >= 0 ? "+" : ""}${t.livePnlPct}%)</span>` : ""}</div>
      <div class="ppc-zht-tg"><span>Entry <b>${rp(t.entryPrem)}</b><em>index ${Math.round(t.entryIndex)}</em></span><span>T1 (2×) <b class="ppc-up">${rp(t.t1Prem)}</b><em>book half</em></span><span>T2 (3×) <b class="ppc-up">${rp(t.t2Prem)}</b><em>exit rest</em></span>${t.state === "CLOSED"
        ? `<span>Exit <b class="${(t.exitPrem ?? 0) >= t.entryPrem ? "ppc-up" : "ppc-dn"}">${rp(t.exitPrem)}</b><em>${t.closedAt ? hm2(t.closedAt) : ""} · ${t.exitPrem != null ? Math.round(((t.exitPrem / t.entryPrem) - 1) * 100) + "%" : ""}</em></span><span>Reason <b>${ppcEsc((t.exitWhy || "").split(" (")[0])}</b><em>${ppcEsc((t.exitWhy || "").includes("(") ? "(" + (t.exitWhy || "").split(" (").slice(1).join(" (") : "")}</em></span>`
        : `<span>Stop <b class="ppc-dn">${t.state === "T1" ? rp(t.entryPrem) : t.rechecked ? rp(t.floorPrem) + " floor" : "recheck " + rp(Math.round(0.49 * t.entryPrem * 10) / 10)}</b><em>${ppcEsc(t.slIndexRule)}${t.recheckNote ? " · recheck: " + ppcEsc(t.recheckNote) : " · at −51% recheck: hold or RESET"}</em></span><span>Time exit <b>15:20</b></span>`}</div>
      ${t.events.length > 1 ? `<div class="ppc-sub">${t.events.slice(1).map((e) => `${hm2(e.t)} ${ppcEsc(e.what)} @ ${rp(e.prem)}`).join(" · ")}</div>` : ""}</div>`;
  };
  el.innerHTML = exp.map((d) => { const trades = d.zhTrades || [], open = trades.find((t) => t.state !== "CLOSED"); return `<div class="ppc-zht-row ${open || d.sides.some((x) => x.trigger.state === "TRIGGERED") ? "trig" : ""}">
      <div class="ppc-zht-h">🎲 <b>${ppcEsc(d.name.replace(" 50", ""))} EXPIRY TODAY</b> · ${ppcEsc(d.window)} · ${d.minutesToClose} min left · market prices ±${ppcNs(d.straddle, 0)} pts</div>
      ${trades.map(tradeCard).join("")}
      ${!open && trades.length ? `<div class="ppc-zht-lock">↻ Trade #${trades[trades.length - 1].n} is closed — a new zero-hero on ${ppcEsc(d.name.replace(" 50", ""))} needs a FRESH trigger (below). Window ${ppcEsc(d.window)}.</div>` : ""}
      ${open ? `<div class="ppc-zht-lock">🔒 Trade #${open.n} is open — its levels are fixed and no new zero-hero is given on ${ppcEsc(d.name.replace(" 50", ""))} until it hits its stop, target or 15:20.</div>` : `<div class="ppc-zht-sides">${d.sides.map((x) => side(d, x)).join("")}</div>`}
      ${d.history ? `<div class="ppc-zht-hist">2-yr: ${ppcEsc(d.history.text)}</div>` : ""}</div>`; }).join("");
}


// ================================================================ Market Eye (next 30 min in the most similar past moments)
async function ppcLoadEye() {
  const el = ppcEl("ppc-eye"); if (!el) return;
  if (!["^NSEI", "^BSESN"].includes(PPC.sym)) { el.innerHTML = ""; return; }
  if (PPC._eyeAt && Date.now() - PPC._eyeAt < 55000 && PPC._eyeSym === PPC.sym) return; PPC._eyeAt = Date.now(); PPC._eyeSym = PPC.sym;
  try {
    const d = await fetch(`/api/market-eye?symbol=${encodeURIComponent(PPC.sym)}`).then((r) => r.json());
    if (!d.available) { el.innerHTML = `<span class="ppc-sub">👁 Market Eye: ${d.ready ? "available 09:30–15:15" : "learning from 2 years of history…"}</span>`; return; }
    const c = d.lead === "UP" ? "ppc-up" : d.lead === "DOWN" ? "ppc-dn" : "ppc-wait";
    el.innerHTML = `👁 <b>Market Eye</b> — next 30 min in the ${d.n} most similar past moments: <span class="ppc-up">UP ${d.upPct}%</span> · <span class="ppc-wait">SIDEWAYS ${d.sidePct}%</span> · <span class="ppc-dn">DOWN ${d.downPct}%</span> · median ${d.medianPct >= 0 ? "+" : ""}${d.medianPct}% → <b class="${c}">${ppcEsc(d.lead)}</b> <span class="ppc-sub">history, not a forecast</span>`;
  } catch { el.innerHTML = ""; }
}


// ================================================================ 🧮 Premium calculator (same model as the plan cards)
function ppcCalcInit() {
  const box = ppcEl("ppc-calc"), body = ppcEl("ppc-calc-body"); if (!box || !body || box._init) return; box._init = true;
  box.addEventListener("toggle", () => { if (box.open) ppcCalcOpen(); });
  body.addEventListener("click", (e) => {
    if (e.target.closest("[data-act='calc-live']")) { PPC._calcEdited = false; ppcEl("ppc-calc-level").value = Math.round(PPC.d?.spot?.price || 0); ppcCalcRun(); return; }
    const hr = e.target.closest("[data-hot]"); if (hr) { PPC._hotOpen = PPC._hotOpen === hr.dataset.hot ? "" : hr.dataset.hot; if (PPC._hotLast) ppcHotRender(PPC._hotLast); return; }
    const b = e.target.closest("[data-lv]"); if (b) { PPC._calcEdited = true; ppcEl("ppc-calc-level").value = b.dataset.lv; ppcCalcRun(); }
  });
  body.addEventListener("input", (e) => { if (e.target.id === "ppc-calc-level") PPC._calcEdited = true; if (e.target.matches("input,select")) { clearTimeout(PPC._calcT); PPC._calcT = setTimeout(ppcCalcRun, 350); } });
  ppcCalcSchedule();
}
function ppcCalcOpen() {
  const body = ppcEl("ppc-calc-body"), d = PPC.d; if (!body || !d) return;
  const P = d.trader?.plans || {}, r0 = (v) => Math.round(v);
  const quick = [["Spot", d.spot?.price], ["Bull start", P.bull?.entry], ["Bull T1", P.bull?.t1], ["Bull SL", P.bull?.stop], ["Bear start", P.bear?.entry], ["Bear T1", P.bear?.t1], ["Bear SL", P.bear?.stop]].filter(([, v]) => v != null);
  PPC._calcEdited = false; PPC._calcKey = `${PPC.sym}:${PPC.off || 0}`; PPC._hotOpen = "";
  body.innerHTML = `<div id="ppc-hot" class="ppc-hot"><div class="ppc-sub">finding the hot premiums…</div></div>
    <div class="ppc-calc-in">
      <label>Index price <button type="button" class="ppc-tvbtn ppc-calc-live" data-act="calc-live" title="follow the live index price again">↺ live</button><input id="ppc-calc-level" type="number" inputmode="decimal" step="1" value="${r0(d.spot?.price || 0)}"></label>
      <label>When<select id="ppc-calc-mins"><option value="0">now</option><option value="15">in 15 min</option><option value="30">in 30 min</option><option value="60">in 1 hour</option><option value="120">in 2 hours</option><option value="eod">at 15:15</option></select></label>
      <label>Strike <span class="ppc-sub">(optional)</span><input id="ppc-calc-strike" type="number" inputmode="numeric" step="${d.step || 50}" placeholder="all near"></label>
    </div>
    <div class="ppc-calc-q">${quick.map(([l, v]) => `<button type="button" class="ppc-tvbtn" data-lv="${r0(v)}">${ppcEsc(l)} ${r0(v).toLocaleString("en-IN")}</button>`).join("")}</div>
    <div id="ppc-calc-out" class="ppc-calc-out"></div>`;
  ppcCalcRun();
}
async function ppcCalcRun() {
  const out = ppcEl("ppc-calc-out"); if (!out) return;
  const level = ppcEl("ppc-calc-level").value, strike = ppcEl("ppc-calc-strike").value; let mins = ppcEl("ppc-calc-mins").value;
  if (mins === "eod") { const m = Math.floor(((Date.now() / 1000 + 19800) % 86400) / 60); mins = String(Math.max(0, 915 - m)); }
  out.innerHTML = `<div class="ppc-sub">calculating…</div>`;
  const key = `${PPC.sym}:${PPC.off || 0}`;
  try {
    const Pl = PPC.d?.trader?.plans || {}, sp = PPC.d?.spot?.price, lad = (PPC.d?.trader?.levels || []).filter((v) => v.kind !== "TODAY" && sp != null);
    const iS = lad.filter((v) => v.price < sp).sort((a, b) => b.price - a.price)[0], iR = lad.filter((v) => v.price > sp).sort((a, b) => a.price - b.price)[0];
    PPC._hotIdx = { s: iS || null, r: iR || null };
    const tq = `&hot=1${Pl.bull?.t1 ? `&ceT=${Pl.bull.t1}` : ""}${Pl.bear?.t1 ? `&peT=${Pl.bear.t1}` : ""}${iS ? `&iS=${iS.price}` : ""}${iR ? `&iR=${iR.price}` : ""}`;
    const r = await fetch(`/api/premium-calc?symbol=${encodeURIComponent(PPC.sym)}&expiryOffset=${PPC.off || 0}&level=${encodeURIComponent(level)}&mins=${mins}${strike ? `&strike=${encodeURIComponent(strike)}` : ""}${tq}`).then((x) => x.json());
    if (key !== `${PPC.sym}:${PPC.off || 0}`) return;   // the index / expiry changed while this was loading — a newer run follows
    if (!r.ok) { out.innerHTML = `<div class="ppc-na">${ppcEsc(r.error || "not available")}</div>`; const h = ppcEl("ppc-hot"); if (h) h.innerHTML = ""; return; }
    ppcHotRender(r);
    const by = {}; for (const x of r.rows) (by[x.strike] = by[x.strike] || {})[x.side] = x;
    const P = PPC.d?.trader?.plans || {}, planK = new Set([P.bull?.strike, P.bear?.strike].filter((v) => v != null));
    const cell = (x) => !x ? "<td>—</td>" : `<td>₹${x.ltp ?? "—"}${x.stale ? ' <span class="ppc-dn" title="quoted premium is below its intrinsic value — stale quote; the model price is used">⚠ stale</span>' : ""} → <b>₹${x.est ?? "—"}</b> <span class="${(x.chg ?? 0) >= 0 ? "ppc-up" : "ppc-dn"}">${x.chgPct != null ? (x.chgPct >= 0 ? "+" : "") + x.chgPct + "%" : ""}</span></td>`;
    out.innerHTML = `<div class="ppc-calc-head">Index <b>${Math.round(r.spot).toLocaleString("en-IN")}</b> → <b>${Math.round(r.level).toLocaleString("en-IN")}</b> (<span class="${r.move >= 0 ? "ppc-up" : "ppc-dn"}">${r.move >= 0 ? "+" : ""}${Math.round(r.move)} pts</span>)${Number(r.mins) ? ` · after ${r.mins} min` : " · now"} · expiry ${ppcEsc(r.expiry || "—")} (${r.daysToExpiry ?? "—"} days) · IV ${r.iv ?? "—"}%</div>
      <table class="ppc-calc-tbl"><thead><tr><th>Strike</th><th>CE now → then</th><th>PE now → then</th></tr></thead><tbody>
      ${Object.keys(by).map(Number).sort((a, b) => a - b).map((k) => `<tr class="${planK.has(k) ? "plan" : ""}${by[k].CE?.money === "ATM" ? " atm" : ""}"><td><b>${k}</b>${by[k].CE?.money === "ATM" ? " <span class='ppc-sub'>ATM</span>" : ""}${planK.has(k) ? " <span class='ppc-sub'>plan</span>" : ""}</td>${cell(by[k].CE)}${cell(by[k].PE)}</tr>`).join("")}
      </tbody></table>
      <div class="ppc-sub">Estimate: live premium + Black-Scholes change at one IV for the expiry (average of the ATM call and put IV); "after N min" includes time decay; ⚠ stale = the quote was below intrinsic value, the model price is used. Real premiums also move with IV and demand.</div>`;
  } catch (e) { out.innerHTML = `<div class="ppc-na">calculator unavailable — ${ppcEsc(e.message || "")}</div>`; }
}

// ================================================================ 🎓 CHART SCHOOL — replay any day, a teacher explains it aloud
// Lessons come from /api/learn/day (rule-based, only what was known at each candle — no look-ahead). Voice = the browser's own
// speech (Indian English voice when available); playback waits for the teacher to finish before the next candle.
const SCH = { sym: "^NSEI", day: null, iv: 5, data: null, idx: 0, playing: false, speed: 1, voice: true, lang: "hi", chart: null, series: null, lines: [], run: 0 };
const schT = (s) => (SCH.lang === "hi" ? s.hi || s.text : s.text);   // the lesson in the chosen language
function schVoice() {
  const vs = ("speechSynthesis" in window) ? speechSynthesis.getVoices() : [];
  return SCH.lang === "hi" ? vs.find((v) => /hi[-_]IN/i.test(v.lang)) || vs.find((v) => /^hi/i.test(v.lang)) || null : vs.find((v) => /en-IN/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
function ppcSchoolInit() {
  const el = ppcEl("ppc-school"); if (!el || el._init) return; el._init = true;
  el.innerHTML = `<div class="sch-bar">
      <select id="sch-sym"><option value="^NSEI">NIFTY</option><option value="^BSESN">SENSEX</option></select>
      <select id="sch-day"><option>loading…</option></select>
      <select id="sch-iv"><option value="5">5 min</option><option value="15">15 min</option></select>
      <span class="sch-ctl"><button type="button" data-sch="first" title="start of the day">⏮</button><button type="button" data-sch="prev" title="one candle back">◀</button>
      <button type="button" data-sch="play" class="sch-play" title="play / pause">▶ Play</button><button type="button" data-sch="next" title="one candle forward">▶|</button><button type="button" data-sch="last" title="end of the day">⏭</button></span>
      <select id="sch-speed" title="speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select>
      <select id="sch-lang" title="language"><option value="hi">हिंदी</option><option value="en">English</option></select>
      <label class="sch-voice"><input type="checkbox" id="sch-voice" checked> 🔊 Teacher's voice</label>
      <span id="sch-pos" class="ppc-sub"></span></div>
    <div class="sch-main"><div id="sch-chart" class="sch-chart"></div>
      <div class="sch-side"><div id="sch-now" class="sch-now"><div class="ppc-sub">दिन चुनिए और ▶ Play दबाइए — टीचर हर कैंडल को आते ही समझाएगा। / Choose a day and press ▶ Play.</div></div><div id="sch-vnote" class="ppc-sub sch-vnote"></div><div id="sch-list" class="sch-list"></div></div></div>`;
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sch]"), li = e.target.closest("[data-sch-i]");
    if (li) { schStop(); SCH.idx = Number(li.dataset.schI); schRender(); schSpeakAt(SCH.idx); return; }
    if (!b || !SCH.data) return; const n = SCH.data.candles.length, a = b.dataset.sch;
    if (a === "play") { SCH.playing ? schStop() : schPlay(); return; }
    schStop(); SCH.idx = a === "first" ? 0 : a === "last" ? n - 1 : a === "prev" ? Math.max(0, SCH.idx - 1) : Math.min(n - 1, SCH.idx + 1); schRender(); if (a === "next" || a === "prev") schSpeakAt(SCH.idx);
  });
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "sch-sym") { SCH.sym = t.value; schLoadDays(); }
    if (t.id === "sch-day") { SCH.day = t.value; schLoad(); }
    if (t.id === "sch-iv") { SCH.iv = Number(t.value); schLoad(); }
    if (t.id === "sch-speed") SCH.speed = Number(t.value);
    if (t.id === "sch-lang") { SCH.lang = t.value; schStop(); schVoiceNote(); }
    if (t.id === "sch-voice") { SCH.voice = t.checked; if (!t.checked) try { speechSynthesis.cancel(); } catch { /* none */ } }
  });
  schLoadDays(); schVoiceNote();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = schVoiceNote;   // voices load late in some browsers
}
function schVoiceNote() {
  const el = ppcEl("sch-vnote"); if (!el) return;
  const v = schVoice();
  el.textContent = !("speechSynthesis" in window) ? "This browser has no voice — the lessons are shown as text." : v ? `🔊 ${v.name} (${v.lang})` : SCH.lang === "hi" ? "⚠️ इस डिवाइस पर हिंदी आवाज़ इंस्टॉल नहीं है — सेटिंग्स में Hindi voice जोड़िए (Mac: System Settings → Accessibility → Spoken Content; Android: Google Text-to-Speech → Hindi). पाठ नीचे लिखा दिखेगा।" : "⚠️ No English voice found on this device.";
}
async function schLoadDays() {
  schStop(); const sel = ppcEl("sch-day"); if (!sel) return;
  let r = null; try { r = await fetch(`/api/learn/days?symbol=${encodeURIComponent(SCH.sym)}`).then((x) => x.json()); } catch { /* keep */ }
  if (!r?.ok || !r.days?.length) { sel.innerHTML = "<option>no data</option>"; return; }
  const wd = (d) => new Date(d + "T00:00:00Z").toUTCString().slice(0, 3);
  sel.innerHTML = r.days.map((d) => `<option value="${d}">${wd(d)} ${d}</option>`).join(""); SCH.day = r.days[0]; schLoad();
}
async function schLoad() {
  schStop(); const now = ppcEl("sch-now");
  if (now) now.innerHTML = `<div class="ppc-sub">loading the lesson…</div>`;
  let r = null; try { r = await fetch(`/api/learn/day?symbol=${encodeURIComponent(SCH.sym)}&day=${SCH.day}&interval=${SCH.iv}`).then((x) => x.json()); } catch { /* keep */ }
  if (!r?.ok) { if (now) now.innerHTML = `<div class="ppc-na">${ppcEsc(r?.error || "lesson not available")}</div>`; return; }
  SCH.data = r; SCH.idx = 0;
  const host = ppcEl("sch-chart"); if (!host) return;
  if (!SCH.chart) {
    SCH.chart = LightweightCharts.createChart(host, { width: host.clientWidth || 600, height: host.clientHeight || 360, layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#8a97ad", fontSize: 10 },
      grid: { vertLines: { color: "#121a2b" }, horzLines: { color: "#121a2b" } }, rightPriceScale: { borderColor: "#2a2e39" }, timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false } });
    SCH.series = SCH.chart.addCandlestickSeries({ upColor: "#26a69a", downColor: "#ef5350", borderUpColor: "#26a69a", borderDownColor: "#ef5350", wickUpColor: "#26a69a", wickDownColor: "#ef5350" });
    window.addEventListener("resize", () => { if (SCH.chart && host.clientWidth) SCH.chart.applyOptions({ width: host.clientWidth }); });
  }
  for (const l of SCH.lines) try { SCH.series.removePriceLine(l); } catch { /* gone */ }
  const col = { "PREV DAY": "#2962ff", PIVOT: "#ff9800", WEEK: "#ab47bc", ROUND: "#5d606b" };
  SCH.lines = r.levels.map((L) => SCH.series.createPriceLine({ price: L.price, color: col[L.kind] || "#787b86", lineWidth: L.kind === "ROUND" ? 1 : 2, lineStyle: 2, axisLabelVisible: true, title: L.label.replace("previous ", "prev ").replace("round number", "") }));
  schRender();
}
function schStepsAt(i) { return (SCH.data?.steps || []).filter((s) => s.i === i); }
function schRender() {
  const d = SCH.data; if (!d || !SCH.series) return;
  const shift = (t) => t + 19800;   // show IST on the time axis
  SCH.series.setData(d.candles.slice(0, SCH.idx + 1).map((c) => ({ ...c, time: shift(c.time) })));
  SCH.series.setMarkers(d.steps.filter((s) => s.i <= SCH.idx && s.marker).map((s) => ({ time: shift(s.time), ...s.marker })));
  SCH.chart.timeScale().setVisibleLogicalRange({ from: -1, to: d.candles.length + 1 });   // the whole day's width — candles fill in from the left
  const hm = (t) => new Date((t + 19800) * 1000).toISOString().slice(11, 16), c = d.candles[SCH.idx];
  const pos = ppcEl("sch-pos"); if (pos) pos.textContent = `${d.index} · ${d.day} · candle ${SCH.idx + 1}/${d.candles.length} · ${hm(c.time)} · close ${Math.round(c.close).toLocaleString("en-IN")}`;
  const cur = schStepsAt(SCH.idx), last = cur.length ? cur : d.steps.filter((s) => s.i <= SCH.idx).slice(-1);
  const now = ppcEl("sch-now"); if (now) now.innerHTML = last.length ? last.map((s) => `<div class="sch-lesson ${s.kind}"><b>${hm(s.time)}</b> ${ppcEsc(schT(s))}</div>`).join("") : `<div class="ppc-sub">${hm(c.time)} — ${SCH.lang === "hi" ? "एक शांत कैंडल; यहाँ कुछ नया नहीं।" : "a quiet candle; nothing new to learn here."}</div>`;
  const list = ppcEl("sch-list"); if (list) { list.innerHTML = d.steps.map((s) => `<div class="sch-li ${s.i <= SCH.idx ? "done" : ""} ${s.i === SCH.idx ? "cur" : ""}" data-sch-i="${s.i}"><b>${hm(s.time)}</b> <i>${ppcEsc(s.kind)}</i> ${ppcEsc(schT(s).slice(0, 90))}…</div>`).join(""); const curEl = list.querySelector(".cur"); if (curEl) curEl.scrollIntoView({ block: "nearest" }); }
  const pb = document.querySelector("#ppc-school .sch-play"); if (pb) pb.textContent = SCH.playing ? "⏸ Pause" : "▶ Play";
}
function schSpeak(text, run) {
  return new Promise((res) => {
    if (!SCH.voice || !("speechSynthesis" in window)) return res();
    try {
      const u = new SpeechSynthesisUtterance(text), v = schVoice();
      if (SCH.lang === "hi" && !v) return res();   // no Hindi voice: never read Devanagari with an English voice
      u.voice = v; u.lang = SCH.lang === "hi" ? "hi-IN" : "en-IN"; u.rate = SCH.speed >= 4 ? 1.2 : SCH.speed >= 2 ? 1.05 : 0.92;
      u.onend = u.onerror = () => res(); if (run !== SCH.run) return res(); speechSynthesis.speak(u);
    } catch { res(); }
  });
}
async function schSpeakAt(i) { try { speechSynthesis.cancel(); } catch { /* none */ } const run = SCH.run; for (const s of schStepsAt(i)) { if (run !== SCH.run) return; await schSpeak(schT(s), run); } }
function schStop() { SCH.playing = false; SCH.run++; try { speechSynthesis.cancel(); } catch { /* none */ } schRender(); }
async function schPlay() {
  const d = SCH.data; if (!d) return; if (SCH.idx >= d.candles.length - 1) SCH.idx = 0;
  SCH.playing = true; const run = ++SCH.run; schRender();
  await schSpeakAt(SCH.idx);
  while (SCH.playing && run === SCH.run && SCH.idx < d.candles.length - 1) {
    await new Promise((r) => setTimeout(r, 700 / SCH.speed)); if (!SCH.playing || run !== SCH.run) break;
    SCH.idx++; schRender();
    const st = schStepsAt(SCH.idx);
    if (st.length) { if (SCH.voice && schVoice()) for (const s of st) { if (run !== SCH.run) break; await schSpeak(schT(s), run); } else await new Promise((r) => setTimeout(r, 6000 / SCH.speed)); }   // no voice → time to read
  }
  if (run === SCH.run) { SCH.playing = false; schRender(); }
}

/** 🎯 3× potential (top of the screen): NIFTY + SENSEX, two strikes each with the best TESTED chance of tripling (2 years of
 *  Dhan option premiums) — on expiry day the same-day chance, otherwise the chance by expiry. Refreshed each minute. */
async function ppcLoad3x(force) {
  if (!force && PPC._3xAt && Date.now() - PPC._3xAt < 60000) return; PPC._3xAt = Date.now();
  // your expected open per index (kept for today in this browser); empty = automatic (pre-open price, then the real open)
  const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  if (!PPC._3xOpen) { try { const o = JSON.parse(localStorage.getItem("ppc-3x-open") || "{}"); PPC._3xOpen = o.day === day ? o.v || {} : {}; } catch { PPC._3xOpen = {}; } }
  const qs = `?nOpen=${PPC._3xOpen["^NSEI"] || ""}&sOpen=${PPC._3xOpen["^BSESN"] || ""}`;
  let r = null; try { r = await fetch("/api/triple-potential" + qs).then((x) => x.json()); } catch { return; }
  const el = ppcEl("ppc-3x"); if (!el || !r?.ok) return;
  if (!el._wired) { el._wired = true; el.addEventListener("change", (e) => { const i = e.target.closest("[data-3x-open]"); if (!i) return;
    const v = Number(i.value); if (v > 0) PPC._3xOpen[i.dataset["3xOpen"]] = v; else delete PPC._3xOpen[i.dataset["3xOpen"]];
    try { localStorage.setItem("ppc-3x-open", JSON.stringify({ day, v: PPC._3xOpen })); } catch { /* private mode */ } ppcLoad3x(true); }); }
  const n = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN")), rs = (v) => (v == null ? "—" : "₹" + (Math.round(v * 10) / 10).toLocaleString("en-IN"));
  const st = { "NEAR SUPPORT": "on support", "NEAR RESISTANCE": "near resistance", "BELOW SUPPORT": "below support", "MID-RANGE": "mid-range" };
  const pick = (x) => `<div class="p3x-r ${x.side === "CE" ? "ce" : "pe"}">
      <div class="p3x-k"><b>${x.strike} ${x.side}</b> <i>${x.otm > 0 ? x.otm + " OTM" : x.otm < 0 ? -x.otm + " ITM" : "ATM"}</i></div>
      <div class="p3x-p"><span class="mut">LTP</span> <b>${rs(x.ltp)}</b> → <span class="mut">3×</span> <b class="ppc-up">${rs(x.target3)}</b></div>
      <div class="p3x-c"><b>${x.p3}%</b> <span class="mut">chance of 3× ${x.horizon === "today" ? "today" : "by expiry"}</span> · <span class="mut">2×</span> ${x.p2 ?? "—"}% <span class="mut">(${x.n} cases)</span></div>
      <div class="p3x-sr"><span class="p3x-s">Support ${(x.supports || []).length ? x.supports.map((z, i) => `S${i + 1} <b>${rs(z.price)}</b> <i>${z.touches}×</i>`).join(" · ") : "—"}</span>
        <span class="p3x-rr">Resistance ${(x.resistances || []).length ? x.resistances.map((z, i) => `R${i + 1} <b>${rs(z.price)}</b> <i>${z.touches}×</i>`).join(" · ") : "—"}</span>${x.state ? ` <span class="mut">· now ${st[x.state] || x.state.toLowerCase()}</span>` : ""}</div>
      ${x.plan ? `<div class="p3x-plan">📍 <b>Plan:</b> ${ppcEsc(x.plan.how)} · premium there ≈ <b>${rs(x.plan.entryPrem)}</b> → <b class="ppc-up">${rs(x.plan.exitPrem)}</b></div>` : ""}
      <div class="p3x-m mut">${x.needIndex != null ? `needs ${n(x.needIndex)} (${x.needMove >= 0 ? "+" : ""}${n(x.needMove)} pts) within 1 hour · ` : ""}${x.liq === "GOOD" ? "liquid" : x.liq === "NO QUOTE" ? "no live quote" : "wide spread"}${x.delta != null ? " · Δ " + x.delta : ""}</div></div>`;
  // 📍 the opening scenario: the gap and what the day did after this kind of gap (2 years, Dhan 5-min + official daily)
  const scen = (it) => {
    if (it.gapOpen == null || !it.gapGroup) return `<div class="p3x-scn mut">📍 Opening scenario: type an expected open, or it fills in from the pre-open price (09:00) and the real open (09:15).</div>`;
    const S = it.scenario, dn = /DOWN/.test(it.gapGroup), up = /UP/.test(it.gapGroup), w = dn ? "fell" : "rose", g = (v) => `<b>${v}%</b>`;
    const head = `📍 Open <b>${n(it.gapOpen)}</b> <span class="mut">(${ppcEsc(it.openSrc)})</span> → <b class="${dn ? "ppc-dn" : up ? "ppc-up" : ""}">${ppcEsc(it.gapGroup)}</b> ${it.gapPts != null ? `${it.gapPts >= 0 ? "+" : "−"}${n(Math.abs(it.gapPts))} pts (${it.gapAtr >= 0 ? "+" : ""}${it.gapAtr} day-range) vs prev close ${n(it.pdc)}` : ""}`;
    if (!S || (!dn && !up)) return `<div class="p3x-scn">${head}${!dn && !up ? ' <span class="mut">· flat open — no gap read; trade the levels</span>' : ""}</div>`;
    return `<div class="p3x-scn">${head} <span class="mut">· ${S.n} past days like this:</span><br>
      gap filled by 10:15 ${g(S.fill1015)} · by the close ${g(S.fillClose)} · ${w} another half-range ${g(S.cont50)} · closed ${dn ? "below" : "above"} the open ${g(S.closeWithGap)}<br>
      👉 09:30 still ${dn ? "below" : "above"} the open → ${w} another half-range ${g(S.holds930.cont50)} <span class="mut">(${S.holds930.n} days)</span> · 09:30 back ${dn ? "above" : "below"} the open → gap filled ${g(S.against930.fillPct)} <span class="mut">(${S.against930.n} days)</span>
      <span class="mut">· 3× odds below are from ${ppcEsc(it.oddsBasis)}${it.openSrc && it.openSrc !== "today's open" ? `, premiums priced at this open` : ""}</span></div>`;
  };
  const turnRow = (it) => { const R = it.rejection, B = it.bounce, nm = (z) => (z ? `<b>${n(z.price)}</b> <i>${ppcEsc(z.label)}${z.hold != null && z.tests ? ` · held ${z.hold}% of ${z.tests}` : ""}</i>` : "—");
    return `<div class="p3x-turn"><span class="p3x-rr">🔴 Rejection likely at ${nm(R?.level)}${R?.firstWeak ? ` <span class="mut">(first ${n(R.firstWeak.price)} is weak — held ${R.firstWeak.hold}%)</span>` : ""}</span>
      <span class="p3x-s">🟢 Bounce likely at ${nm(B?.level)}${B?.firstWeak ? ` <span class="mut">(first ${n(B.firstWeak.price)} is weak — held ${B.firstWeak.hold}%)</span>` : ""}</span>
      <span class="mut">within a normal day's reach (±${n(R?.reach)} pts) · held % = how often price turned there in the last 60 sessions</span></div>`; };
  const lv = (L) => !L ? "" : `<div class="p3x-lv"><span class="p3x-s">▼ Index support ${L.supports.length ? L.supports.map((z) => `<b>${n(z.price)}</b> <i>${ppcEsc(z.label)}${z.hold != null && z.tests ? ` · held ${z.hold}%` : ""}</i>`).join(" · ") : "—"}</span>
      <span class="p3x-rr">▲ Index resistance ${L.resistances.length ? L.resistances.map((z) => `<b>${n(z.price)}</b> <i>${ppcEsc(z.label)}${z.hold != null && z.tests ? ` · held ${z.hold}%` : ""}</i>`).join(" · ") : "—"}</span></div>`;
  el.innerHTML = `<div class="p3x-h"><b>🎯 3× potential</b> <span class="mut">two strikes per index with the best TESTED chance of tripling — real Dhan option data, ~2 years</span></div>
    <div class="p3x-g">${r.items.map((it) => !it.ok ? `<div class="p3x-i"><div class="p3x-ih">${ppcEsc(it.symbol)}</div><div class="ppc-na">${ppcEsc(it.error || "not available")}</div></div>` : `<div class="p3x-i">
      <div class="p3x-ih"><b>${ppcEsc(it.name)}</b> ${n(it.spot)} <span class="mut">· expiry ${ppcEsc(it.expiry)}${it.expiryDay ? " · <b class='ppc-wait'>EXPIRY DAY</b>" : ` · ${it.dte} day(s) left`} · odds at ${ppcEsc(it.slot)}</span>
        <label class="p3x-open">Open at <input type="number" inputmode="decimal" data-3x-open="${ppcEsc(it.symbol)}" placeholder="auto" value="${PPC._3xOpen[it.symbol] || ""}"></label></div>
      ${scen(it)}
      ${turnRow(it)}${lv(it.indexLevels)}
      ${it.picks.length ? it.picks.map(pick).join("") : '<div class="ppc-na">no liquid strike with tested odds now</div>'}
      <div class="mut p3x-n">${ppcEsc(it.note)}</div></div>`).join("")}</div>
    <div class="mut p3x-n">Most strikes almost never triple: on a normal day 1–3 OTM reach 3× the same day only ~1–3% of the time; on expiry day ~17–22%. These are history, not a promise — a lottery-size position only; the plan and its checks decide the trade.</div>`;
}

/** 🔥 Hot premiums: top 5 calls and top 5 puts by reward ÷ risk after the spread, liquid quotes only (server: hotPremiums).
 *  Compact table in STRIKE order (rank shown); tap a row for its premium support / resistance detail. */
function ppcHotRender(r) {
  const el = ppcEl("ppc-hot"), H = r.hot; if (!el) return;
  if (!H) { el.innerHTML = ""; return; }
  const hm = (t) => new Date((t + 19800) * 1000).toISOString().slice(11, 16), n = (v) => Math.round(v).toLocaleString("en-IN");
  const lak = (v) => (v == null ? "—" : v >= 1e7 ? (v / 1e7).toFixed(2) + "Cr" : v >= 1e5 ? (v / 1e5).toFixed(1) + "L" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(v));
  const open = PPC.d?.session === "OPEN", openK = PPC._hotOpen || "";
  const zone = (q) => (q ? `₹${q.price} <i>${q.touches}×</i>` : "—");
  const stCls = (st) => (st === "NEAR SUPPORT" ? "sup" : st === "NEAR RESISTANCE" || st === "BELOW SUPPORT" ? "bad" : "mid");
  const stTxt = { "NEAR SUPPORT": "Near S", "NEAR RESISTANCE": "Near R", "BELOW SUPPORT": "Below S", "MID-RANGE": "Mid", "NO LEVELS": "—" };
  const row = (x) => {
    const k = x.side + x.strike, L = x.levels;
    return `<tr class="ppc-ht-r${x.hot ? " hot" : ""}${openK === k ? " open" : ""}" data-hot="${k}" title="${ppcEsc(x.why)} — tap for support / resistance detail">
      <td data-l="#" class="ppc-ht-rk">${x.hot ? "🔥" : x.rank}</td>
      <td data-l="Strike" class="ppc-ht-k"><b>${x.strike}</b> <i>${x.money}</i></td>
      <td data-l="Rating" class="ppc-ht-rt">${ppcStars(x.rating)}</td>
      <td data-l="LTP" class="ppc-ht-n"><b>₹${x.ltp}</b></td>
      <td data-l="Support 1" class="ppc-ht-n ppc-up">${L ? zone(L.support[0]) : "—"}</td>
      <td data-l="Support 2" class="ppc-ht-n ppc-up">${L ? zone(L.support[1]) : "—"}</td>
      <td data-l="Resist. 1" class="ppc-ht-n ppc-dn">${L ? zone(L.resistance[0]) : "—"}</td>
      <td data-l="Resist. 2" class="ppc-ht-n ppc-dn">${L ? zone(L.resistance[1]) : "—"}</td>
      <td data-l="At target" class="ppc-ht-n">₹${x.atTarget} <b class="ppc-up">+${x.upPct}%</b></td>
      <td data-l="Volume" class="ppc-ht-n">${lak(x.volume)}</td>
      <td data-l="Risk" class="ppc-ht-n ppc-dn">−${x.riskPct}%</td>
      <td data-l="Position">${L ? `<span class="ppc-hz-st ${stCls(L.state)}">${stTxt[L.state] || ppcEsc(L.state)}</span>` : "—"}</td>
      <td data-l="Δ Delta" class="ppc-ht-n">${x.delta ?? "—"}</td>
      <td data-l="Γ Gamma" class="ppc-ht-n">${x.gamma != null ? Number(x.gamma.toPrecision(2)) : "—"}${x.greeksModel ? "<sup title='Black-Scholes — not in the Dhan feed'>m</sup>" : ""}</td>
      <td data-l="OI" class="ppc-ht-n">${lak(x.oi)}</td>
      <td data-l="Half way" class="ppc-ht-n ${x.halfPct >= 0 ? "ppc-up" : "ppc-dn"}">${x.halfPct >= 0 ? "+" : ""}${x.halfPct}%</td>
      <td data-l="R:R" class="ppc-ht-n"><b>${x.rr}</b></td>
      <td data-l="Liquidity"><span class="ppc-ht-lq ${x.liq === "GOOD" ? "good" : "wide"}">${x.liq === "GOOD" ? "OK" : x.liq === "NO QUOTE" ? "no quote" : "wide"}${x.spreadPct != null ? " " + x.spreadPct + "%" : ""}</span></td></tr>
      ${openK === k ? `<tr class="ppc-ht-d"><td colspan="18">${ppcRatingDetail(x)}${ppcHotLevels(x, H)}</td></tr>` : ""}`;
  };
  const table = (side, rows, t, from) => `<div class="ppc-ht ${side === "CE" ? "ce" : "pe"}">
      <div class="ppc-hot-ch">${side === "CE" ? "📈 CALLS" : "📉 PUTS"} <span class="ppc-sub">if ${ppcEsc(PPC.d?.name || "index")} reaches <b>${n(t)}</b> (${ppcEsc(from)}) within 1 hour · strike order</span></div>
      ${rows.length ? `<table class="ppc-ht-t"><thead><tr><th>#</th><th>Strike</th><th title="opportunity rating: is the premium moving up from support, and how often (2-year Dhan data) such a bounce closed through the resistance above">Rating</th><th>LTP</th><th title="premium's nearest support (times it turned there)">S1</th><th title="next support below">S2</th><th title="premium's nearest resistance">R1</th><th title="next resistance above">R2</th><th>At target</th><th>Vol</th><th title="if the index moves the same distance against">Risk</th><th>Pos</th><th title="premium change per 1 index point">Δ</th><th title="how fast delta grows per 1 index point">Γ</th><th>OI</th><th title="if the move stops half way">Half</th><th>R:R</th><th>Liq</th></tr></thead>
        <tbody>${rows.map(row).join("")}</tbody></table>` : '<div class="ppc-na">no liquid strike with upside right now</div>'}
      ${rows.length && !rows.some((x) => x.hot) ? '<div class="ppc-sub ppc-hot-none">No 🔥 on this side now — the best one fails a check (liquid quote, Δ 0.30–0.60, R:R ≥ 1.3, upside ≥ 20%, not losing if the move stops half way).</div>' : ""}</div>`;
  el.innerHTML = `<div class="ppc-hot-h"><b>🔥 Hot premiums</b> <span class="ppc-sub">best 5 each side for a buyer · ${ppcEsc(H.chainAt)} · tap a row for its levels</span>
      <span class="ppc-hot-upd">updated ${hm(r.generatedAt)}${open ? ` · next ${ppcCalcNextAt()}` : " · market closed"}</span></div>
    ${table("CE", H.ce, H.ceTarget, H.ceFrom)}${table("PE", H.pe, H.peTarget, H.peFrom)}
    <div class="ppc-sub">At target = premium if the index reaches the target within 1 hour (time decay and the spread included). Half = if the move stops half way. Risk = if the index moves the same ${n(Math.abs(H.ceTarget - r.spot))} / ${n(Math.abs(r.spot - H.peTarget))} pts against. # = rank by reward ÷ risk (Δ 0.30–0.60 preferred). S / R = the premium's own support / resistance from its Dhan 15-min candles (× = times it turned there). Rating ★ = moving up from support (a green 15-min close off it) and the tested % of such bounces that closed through the resistance above within 2 hours — overall ~29%, the best set-ups ~40%+; ★★★★★ needs a live bounce with ≥ 40%. Γ<sup>m</sup> = Black-Scholes when Dhan does not send it. A model to pick the strike — the plan decides the trade.</div>`;
  PPC._hotLast = r;
}
/** ★ rating cell: stars + the tested chance that a bounce from support closes through the resistance above. */
function ppcStars(R) {
  if (!R) return '<span class="ppc-sub">—</span>';
  return `<span class="ppc-star s${R.stars}" title="${ppcEsc(R.label)}">${"★".repeat(R.stars)}<i>${"★".repeat(5 - R.stars)}</i></span>${R.passPct != null ? ` <b class="ppc-star-p">${R.passPct}%</b>` : ""}`;
}
function ppcRatingDetail(x) {
  const R = x.rating; if (!R) return "";
  const st = { BOUNCING: "🟢 moving up from support now", "AT SUPPORT": "🟡 sitting on support", "MID-RANGE": "⚪ mid-range", "AT RESISTANCE": "🟠 at resistance", "BELOW SUPPORT": "🔴 below support" }[R.state] || R.state;
  return `<div class="ppc-star-d"><div><span class="ppc-star s${R.stars}">${"★".repeat(R.stars)}<i>${"★".repeat(5 - R.stars)}</i></span> <b>${ppcEsc(R.label)}</b> · ${st}</div>
    ${R.passPct != null ? `<div>Tested (${R.n.toLocaleString("en-IN")} bounces like this, 2 years of Dhan premiums): a bounce from <b>₹${R.support}</b> closed through resistance <b>₹${R.resistance}</b> within 2 hours in <b class="ppc-up">${R.passPct}%</b> · support broke first in <b class="ppc-dn">${R.failPct}%</b> · touched resistance ${R.touchRPct}% · typical best gain +${R.medGainPct}%${R.devPass != null && R.valPass != null ? ` <span class="ppc-sub">(earlier ${R.devPass}% / recent ${R.valPass}%)</span>` : ""}</div>` : '<div class="ppc-sub">no tested odds for this set-up (no support or resistance zone)</div>'}</div>`;
}
/** A hot row's premium support / resistance (its own 15-min candles) and its value at the index's nearest support / resistance. */
function ppcHotLevels(x, H) {
  const L = x.levels, n = (v) => Math.round(v).toLocaleString("en-IN"), I0 = PPC._hotIdx || {}, nm = (v) => (v ? { ...v, label: v.label.replace(/\s*\(.*\)$/, "") } : null), I = { s: nm(I0.s), r: nm(I0.r) };
  const z = (q, cls) => `<span class="ppc-hz ${cls}" title="${ppcEsc(q.from.join(" · "))} · last ${ppcEsc(q.lastDay)} · zone ₹${q.lo}–₹${q.hi}">₹${q.price} <i>${q.strength === "STRONG" ? "strong" : q.strength === "MEDIUM" ? "med" : "weak"} ${q.touches}×</i></span>`;
  const chip = !L ? "" : `<span class="ppc-hz-st ${L.state === "NEAR SUPPORT" ? "sup" : L.state === "MID-RANGE" || L.state === "NO LEVELS" ? "mid" : "bad"}">${ppcEsc(L.state)}</span>`;
  const idx = [x.atIndexSupport != null && H.indexSupport ? `${ppcEsc(PPC.d?.name || "index")} at support ${n(H.indexSupport)}${I.s ? ` <i>(${ppcEsc(I.s.label)})</i>` : ""} → <b>₹${x.atIndexSupport}</b>` : "",
    x.atIndexResistance != null && H.indexResistance ? `at resistance ${n(H.indexResistance)}${I.r ? ` <i>(${ppcEsc(I.r.label)})</i>` : ""} → <b>₹${x.atIndexResistance}</b>` : ""].filter(Boolean).join(" · ");
  return `<span class="ppc-hot-lv">${!L ? '<span class="ppc-sub">premium levels not available (no Dhan premium candles)</span>'
    : `<span class="ppc-hz-row"><b class="ppc-up">S</b> ${L.support.length ? L.support.map((q) => z(q, "s")).join(" ") : "—"} <b class="ppc-dn">R</b> ${L.resistance.length ? L.resistance.map((q) => z(q, "r")).join(" ") : "—"} ${chip}</span>
       <span class="ppc-hz-read">${ppcEsc(L.read)}</span>`}${idx ? `<span class="ppc-hz-idx">${idx}</span>` : ""}</span>`;
}
/** The next refresh: 15 s after the next 15-min candle close (09:30, 09:45 … 15:30), IST "HH:MM". */
function ppcCalcNextAt() { const m = Math.floor(((Date.now() / 1000 + 19800) % 86400) / 60), nx = (Math.floor(m / 15) + 1) * 15; return `${String(Math.floor(nx / 60)).padStart(2, "0")}:${String(nx % 60).padStart(2, "0")}`; }
function ppcCalcSchedule() {
  clearTimeout(PPC._calcSch);
  const s = (Date.now() / 1000 + 19800) % 86400, wait = ((Math.floor(s / 900) + 1) * 900 + 15 - s) * 1000;
  PPC._calcSch = setTimeout(() => {
    try {
      const box = ppcEl("ppc-calc"), m = Math.floor(((Date.now() / 1000 + 19800) % 86400) / 60);
      if (box?.open && !document.hidden && m >= 555 && m <= 931) {
        if (!PPC._calcEdited && PPC.d?.spot?.price) ppcEl("ppc-calc-level").value = Math.round(PPC.d.spot.price);   // follow the live price unless the user typed one
        ppcCalcRun();
      }
    } catch { /* screen not open */ }
    ppcCalcSchedule();
  }, wait);
}

// ================================================================ 🧠 Level memory (support held / resistance rejected — history + today)
async function ppcRenderLevelMemory(force) {
  const el = ppcEl("ppc-lm"); if (!el) return;
  if (!["^NSEI", "^BSESN"].includes(PPC.sym)) { el.innerHTML = ""; return; }
  if (force || !PPC._lmAt || Date.now() - PPC._lmAt > 55000 || PPC._lmSym !== PPC.sym) {
    PPC._lmAt = Date.now(); PPC._lmSym = PPC.sym;
    try { PPC._lm = await fetch(`/api/level-memory?symbol=${encodeURIComponent(PPC.sym)}`).then((r) => r.json()); } catch { /* keep */ }
  }
  const m = PPC._lm; if (!m?.ok) { el.innerHTML = ""; return; }
  const n0 = (v) => Math.round(v).toLocaleString("en-IN"), hm = (t) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
  const zone = (z, side) => `<tr><td><b>${n0(z.price)}</b></td><td>${side === "above" ? `res held <b>${z.resistance.held}/${z.resistance.n}</b>` : `sup held <b>${z.support.held}/${z.support.n}</b>`}</td><td class="${(z.holdPct ?? 0) >= 60 ? "ppc-up" : (z.holdPct ?? 100) <= 40 ? "ppc-dn" : ""}">${z.holdPct ?? "—"}% held</td><td class="ppc-sub">${ppcEsc(z.labels.slice(0, 2).join(", "))}</td></tr>`;
  const word = (e) => e.outcome === "RESPECTED" ? (e.role === "SUPPORT" ? "✅ support held" : "✅ resistance rejected") : e.outcome === "FAKE BREAK" ? "↩️ fake break (held)" : e.outcome === "BROKEN" ? `💥 ${e.role === "SUPPORT" ? "support" : "resistance"} broken` : "… deciding";
  const today = (m.today || []).slice(-8).reverse();
  el.innerHTML = `<details class="ppc-lm-box" ${PPC._lmOpen ? "open" : ""}><summary>🧠 <b>Level memory · ${ppcEsc(m.index)}</b> <span class="ppc-sub">— where support held and resistance rejected · ${m.sessions} sessions of history${today.length ? ` · ${today.length} test(s) today` : ""}</span></summary>
    <div class="ppc-lm-grid"><div><b>Zones above (resistance)</b><table class="ppc-lm-t">${m.above.map((z) => zone(z, "above")).join("") || "<tr><td>—</td></tr>"}</table></div>
    <div><b>Zones below (support)</b><table class="ppc-lm-t">${m.below.map((z) => zone(z, "below")).join("") || "<tr><td>—</td></tr>"}</table></div></div>
    <div class="ppc-lm-today"><b>Today's tests</b>${today.length ? `<ul>${today.map((e) => `<li>${hm(e.time)} <b>${n0(e.price)}</b> ${ppcEsc(e.label)} — ${word(e)}${e.zone ? ` <span class="ppc-sub">· zone held ${e.zone.holdPct ?? "—"}% of ${e.zone.tests}</span>` : ""}</li>`).join("")}</ul>` : ` <span class="ppc-sub">none yet</span>`}</div>
    <div class="ppc-sub">Last 60 sessions, 5-min candles: held = turned away 1 ATR (or a fake break); broken = closed beyond and ran 1 ATR. 2-year record by level type: ${(m.kinds || []).slice(0, 4).map((k) => `${ppcEsc(k.kind.toLowerCase())} ${k.role === "SUPPORT" ? "sup" : "res"} ${k.holdPct}%`).join(" · ")} — about a coin flip, so the ZONE record matters more than the level type.</div></details>`;
  const box = el.querySelector("details"); box.addEventListener("toggle", () => { PPC._lmOpen = box.open; });
}

// ================================================================ 🎖 ProTrader desk — the same state that drives the Telegram co-pilot
async function ppcRenderProTrader(force) {
  const el = ppcEl("ppc-pt"); if (!el || !PPC.d) return;
  if (force || !PPC._ptAt || Date.now() - PPC._ptAt > 14000) {
    PPC._ptAt = Date.now();
    try { PPC._pt = await fetch("/api/copilot/state").then((r) => r.json()); } catch { /* keep the last one */ }
  }
  const cp = PPC._pt || {}, sym = PPC.sym, d = PPC.d, T = d.trader || {}, P = T.plans || {};
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10), isToday = cp.day === today;
  const n0 = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN")), hm = (t) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
  const ltp = (side, k) => (d.ranking || []).find((x) => x.side === side && x.strike === k)?.ltp ?? null;
  const pct = (a, b) => (a != null && b ? `${a >= b ? "+" : "−"}${Math.abs(Math.round((a / b - 1) * 100))}%` : "");
  const chips = [];
  if (P.anchor?.locked) chips.push(`<span class="ppc-pt-chip ok">🔒 Plan locked${P.anchor.rolls?.length ? ` · ${P.anchor.rolls.length} roll(s)` : ""}</span>`);
  if (T.rangeDay) chips.push(`<span class="ppc-pt-chip bad" title="${ppcEsc(T.rangeDay.why)}">⚠️ Range day — no new trades after ${ppcEsc(T.rangeDay.at)}</span>`);
  if (P.bull && P.bear && P.bear.entry >= P.bull.entry) chips.push(`<span class="ppc-pt-chip bad">⛔ Plan conflict — stand aside</span>`);
  if (d.expiry && d.expiry === today) chips.push(`<span class="ppc-pt-chip bad" title="Owner's decision 29 Oct: expiry-day plan trades are given. 2-year test: they lost ~8.5% per trade on average.">⚠️ Expiry day — plan trades GIVEN · HIGH RISK, 1 lot · EXPIRY MODE also running (paper)</span>`);
  const rows = [];
  const pd = isToday ? cp.pending?.[sym] : null;
  if (pd) rows.push(`<div class="ppc-pt-row wait">⏳ <b>Waiting for the retest</b> · ${pd.side === "bull" ? "CE" : "PE"} · level <b>${n0(pd.trigger)}</b> · until ${hm(pd.until)} · review ${ppcEsc(pd.review?.grade || "—")} — given only if a 5-min candle comes back within ${n0(0.25 * pd.atr)} pts and closes ${pd.side === "bull" ? "above" : "below"} it</div>`);
  const tr = isToday ? cp.trades?.[sym] : null;
  if (tr && tr.state !== "CLOSED") { const now = ltp(tr.side, tr.strike);
    rows.push(`<div class="ppc-pt-row open">📌 <b>Open trade ${tr.strike} ${tr.side}</b>${tr.entryKind === "RETEST" ? " (on the retest)" : ""} · entry ₹${n0(tr.entryPrem)} → now <b>₹${n0(now)}</b> <span class="${now >= tr.entryPrem ? "ppc-up" : "ppc-dn"}">${pct(now, tr.entryPrem)}</span> · <b class="ppc-dn">SL ${tr.state === "T1" ? `${n0(tr.entrySpot)} (breakeven)` : n0(tr.stop)}</b> · <b class="ppc-up">T1 ${n0(tr.t1)}</b>${tr.t2 ? ` · <b class="ppc-up">T2 ${n0(tr.t2)}</b>` : ""} · ${tr.state === "T1" ? "T1 done, half booked" : "open"}</div>`); }
  const ex = isToday ? cp.exp?.[sym]?.trades || [] : [];
  for (const t of ex) { const now = t.state === "CLOSED" ? t.exitPrem : ltp(t.side, t.strike);
    rows.push(`<div class="ppc-pt-row exp">🎲 <b>Expiry ${t.strike} ${t.side}</b> · ₹${t.entryPrem} → ${t.state === "CLOSED" ? `${ppcEsc(t.exitWhy)} ₹${n0(now)}` : `now <b>₹${n0(now)}</b>`} <span class="${(now ?? 0) >= t.entryPrem ? "ppc-up" : "ppc-dn"}">${pct(now, t.entryPrem)}</span>${t.state !== "CLOSED" ? ` · <b class="ppc-dn">SL ₹${t.state === "HALF" ? `${Math.round(t.entryPrem)} (breakeven)` : Math.round(t.entryPrem * 0.6)}</b> · <b class="ppc-up">T1 ₹${Math.round(t.entryPrem * 1.5)}</b> · <b class="ppc-up">T2 ₹${Math.round(t.entryPrem * 2.5)}</b>${t.state === "HALF" ? " · half booked" : ""}` : ""}</div>`); }
  const done = isToday ? (cp.closed || []).filter((t) => t.index === sym) : [];
  if (done.length) rows.push(`<div class="ppc-pt-row">Today: ${done.map((t) => { const p = t.exitPrem != null && t.entryPrem ? Math.round((t.exitPrem / t.entryPrem - 1) * 100) : null; return `${p != null && p > 0 ? "✅" : "❌"} ${t.strike} ${t.side} ${ppcEsc(t.exitWhy || "")} ${p != null ? (p >= 0 ? "+" : "") + p + "%" : ""}`; }).join(" · ")}</div>`);
  if (!rows.length) rows.push(`<div class="ppc-pt-row quiet">${d.session === "OPEN" ? "Watching — no trade pending or open on this index." : "Market closed — the desk fills during market hours."}</div>`);
  el.innerHTML = `<div class="ppc-pt-head"><b>🎖 ProTrader desk</b> <span class="ppc-sub">· ${ppcEsc((d.name || "").replace(" 50", ""))} · same state as Telegram</span></div>${chips.length ? `<div class="ppc-pt-chips">${chips.join("")}</div>` : ""}${rows.join("")}`;
}

// ================================================================ BTSD Trade — the user's own trades, followed with Telegram follow-ups
setInterval(() => { try { if (PPC.d && !PPC._btsdSide && !!ppcEl("ppc-btsd")?.hidden === ppcBTSDWindow()) ppcBTSDPaint(); } catch { /* screen not open */ } }, 30000);
async function ppcRenderBTSD(force) {
  const el = ppcEl("ppc-btsd"); if (!el || !PPC.d) return;
  if (PPC._btsdSide) return;   // keep the open form while the user types
  ppcBTSDPaint();   // draw the buttons at once; the list refreshes when it arrives
  if (!force && PPC._btsdAt && Date.now() - PPC._btsdAt < 14000) return;
  PPC._btsdAt = Date.now();
  try { const r = await fetch("/api/btsd/trades").then((x) => x.json()); PPC._btsd = r.trades || []; } catch { /* keep the last list */ }
  ppcBTSDPaint();
}
// The BTSD section is shown only 15:00–15:14 IST on weekdays (like the zero-hero strip on expiry days); hidden otherwise.
function ppcBTSDWindow() {
  const ist = new Date(Date.now() + 19800000), m = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  return wd !== 0 && wd !== 6 && m >= 900 && m <= 914;
}
/** Section ③ title follows what is visible: BTSD (15:00–15:14) and/or the selected index's expiry strip; hidden when neither. */
function ppcSec3() {
  const sec = ppcEl("ppc-sec3"); if (!sec) return;
  const bt = !ppcEl("ppc-btsd")?.hidden, zh = !ppcEl("ppc-zh-today")?.hidden;
  sec.hidden = !bt && !zh;
  sec.textContent = bt && zh ? "③ My trades & expiry zero-hero" : bt ? "③ My trades" : "③ Expiry zero-hero";
}
function ppcBTSDPaint() {
  const el = ppcEl("ppc-btsd"); if (!el || PPC._btsdSide) return;
  const on = ppcBTSDWindow(), sec = ppcEl("ppc-sec3");
  el.hidden = !on; ppcSec3(); void sec;
  if (!on) { el.innerHTML = ""; return; }
  const live = (t) => (PPC.d.ranking || []).find((x) => x.side === t.side && x.strike === t.strike)?.ltp ?? null;
  const rows = (PPC._btsd || []).filter((t) => t.index === PPC.sym).map((t) => {
    const now = t.state === "CLOSED" ? t.exitPrem : live(t), pnl = now != null && t.entryPrem ? Math.round(((now / t.entryPrem) - 1) * 100) : null;
    const st = t.state === "CLOSED" ? `CLOSED — ${ppcEsc(t.exitWhy || "")}` : t.state === "T1" ? "T1 hit · half booked · SL at breakeven" : "OPEN";
    return `<div class="ppc-bt-row ${t.state === "CLOSED" ? "closed" : ""}"><b>#${t.n}</b> <b class="${t.side === "CE" ? "ppc-up" : "ppc-dn"}">${t.strike} ${t.side}</b> · entry ₹${ppcNs(t.entryPrem)} · ${t.state === "CLOSED" ? "exit" : "now"} ₹${ppcNs(now)} <span class="${pnl >= 0 ? "ppc-up" : "ppc-dn"}">${pnl != null ? (pnl >= 0 ? "+" : "") + pnl + "%" : ""}</span>
      · 🎯 ${ppcR(t.t1)}${t.t2 ? "/" + ppcR(t.t2) : ""} · 🛑 ${t.state === "T1" ? ppcR(t.entrySpot) + " (BE)" : ppcR(t.stop)} · <span class="ppc-chip ppc-c-${t.state === "CLOSED" ? "muted" : "bull"}">${st}</span>
      ${t.state !== "CLOSED" ? `<button class="ppc-tvbtn" data-btsd-close="${ppcEsc(t.id)}">Close</button>` : ""}</div>`;
  }).join("");
  el.innerHTML = `<div class="ppc-bt-head"><b>🧑 BTSD Trade</b> <span class="ppc-sub">record the side you took — I follow it and message you at T1 / T2 / SL / 15:12</span>
      <button class="ppc-bt-btn ce" data-btsd="CE">🟢 I BOUGHT CE</button><button class="ppc-bt-btn pe" data-btsd="PE">🔴 I BOUGHT PE</button></div>${rows}`;
}
function ppcBTSDForm(side) {
  const el = ppcEl("ppc-btsd"), d = PPC.d, p = d?.trader?.plans?.[side === "CE" ? "bull" : "bear"] || {};
  const strike = p.strike ?? d.atm, prem = (d.ranking || []).find((x) => x.side === side && x.strike === strike)?.ltp ?? p.premNow ?? "";
  PPC._btsdSide = side;
  const f = (id, label, v, step) => `<label>${label}<input id="ppc-bt-${id}" type="number" step="${step}" value="${v == null ? "" : Math.round(v * 100) / 100}"></label>`;
  el.innerHTML = `<div class="ppc-bt-form"><b class="${side === "CE" ? "ppc-up" : "ppc-dn"}">I bought ${ppcEsc(d.name)} ${side}</b> <span class="ppc-sub">pre-filled from the current ${side === "CE" ? "Bull" : "Bear"} plan — change anything</span>
    <div class="ppc-bt-f">${f("strike", "Strike", strike, d.step || 50)}${f("price", "My price ₹", prem, 0.05)}${f("lots", "Lots", 1, 1)}${f("stop", "SL (index, 15-min close)", p.stop, 1)}${f("t1", "T1 (index)", p.t1, 1)}${f("t2", "T2 (index)", p.t2, 1)}</div>
    <div class="ppc-bt-actions"><button class="ppc-bt-btn ${side === "CE" ? "ce" : "pe"}" data-act="btsd-save">✔ Record my trade</button><button class="ppc-tvbtn" data-act="btsd-cancel">Cancel</button> <span id="ppc-bt-msg" class="ppc-sub"></span></div></div>`;
}
async function ppcBTSDSave() {
  const v = (id) => (ppcEl("ppc-bt-" + id) || {}).value, msg = ppcEl("ppc-bt-msg");
  const body = { symbol: PPC.sym, side: PPC._btsdSide, strike: v("strike"), entryPrem: v("price"), lots: v("lots"), stop: v("stop"), t1: v("t1"), t2: v("t2") };
  try {
    const r = await fetch("/api/btsd/trade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (!r.ok) { if (msg) msg.innerHTML = `<span class="ppc-dn">${ppcEsc(r.error || "failed")}</span>`; return; }
    PPC._btsdSide = null; ppcRenderBTSD(true);
  } catch (e) { if (msg) msg.textContent = e.message || "failed"; }
}
async function ppcBTSDClose(id) {
  if (!confirm("Close this BTSD trade at the current premium?")) return;
  await fetch(`/api/btsd/trade/${encodeURIComponent(id)}/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  ppcRenderBTSD(true);
}
