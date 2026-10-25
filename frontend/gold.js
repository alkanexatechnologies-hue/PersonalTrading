// ============================ GOLD COMMAND (Gold Desk) — MCX GOLDM / GOLD futures + options ============================
// Same layout as Market Command: header · decision row · futures chart | option premium (CE over PE) | ticket + levels.
// Data from /api/gold/* only (backend/routes/gold.ts), polled ONLY while this tab is open and the page is visible, so it
// never adds load while the Indian market screens are in use. Advisory only: no tested gold rule exists → WAIT.
(function () {
  "use strict";
  const IST = 19800, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const f0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
  const f2 = (v) => (v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const inr = (v) => (v == null || !isFinite(v) ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));
  const sg = (v, d = 0) => (v == null || !isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d })}`);
  const hm = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
  const hmMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const dmy = (d) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }) : "—");
  const ema = (xs, n) => { const k = 2 / (n + 1); let v = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
  const set = (el, html) => { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } };

  const G = { und: "GOLDM", tf: 5, expiry: null, strike: null, side: "both", plan: "bull", lots: 1, prem: "", d: null, o: null, err: null, oErr: null, at: { cmd: 0, opt: 0 }, busy: {}, charts: {}, lines: { main: [] }, sig: {} };
  window.__gold = G;   // read-only handle for diagnosis
  const active = () => $("panel-goldcommand")?.classList.contains("active") && !document.hidden;

  // ------------------------------------------------------------ data (only while the tab is visible)
  async function loadCmd(force) {
    if (G.busy.cmd || (!force && Date.now() - G.at.cmd < 15000)) return; G.busy.cmd = true;
    try {
      const d = await fetchJSON(`/api/gold/command?und=${G.und}&tf=${G.tf}${G.expiry ? `&expiry=${G.expiry}` : ""}`, 30000);
      if (d && d.available) {
        const expChanged = G.expiry !== d.options.expiry; G.d = d; G.err = null; G.expiry = d.options.expiry;
        if (G.strike == null || expChanged || !d.options.strikes.includes(G.strike)) { G.strike = d.options.atm; G.at.opt = 0; }
      } else G.err = (d && (d.error || (d.disabled && "Gold data paused (Data Control)"))) || "Gold data unavailable";
    } catch (e) { G.err = "Gold data unavailable (" + (e && e.message || e) + ")"; }
    G.at.cmd = Date.now(); G.busy.cmd = false; render();
    if (G.at.opt === 0) loadOpt(true);   // first load / new strike: premiums straight away, not on the next tick
  }
  async function loadOpt(force) {
    if (!G.expiry || G.strike == null || G.busy.opt || (!force && Date.now() - G.at.opt < 30000)) return; G.busy.opt = true;
    const key = `${G.und}|${G.expiry}|${G.strike}|${G.tf}`;
    try {
      const o = await fetchJSON(`/api/gold/option?und=${G.und}&expiry=${G.expiry}&strike=${G.strike}&tf=${G.tf}`, 30000);
      if (o && o.available !== false && `${G.und}|${G.expiry}|${G.strike}|${G.tf}` === key) { G.o = { ...o, key }; G.oErr = null; } else if (o && o.error) G.oErr = o.error;
    } catch (e) { G.oErr = "option data unavailable"; }
    G.at.opt = Date.now(); G.busy.opt = false; renderOt(); renderTicket();
  }

  // ------------------------------------------------------------ header + clock
  function renderHead() {
    const d = G.d, s = d?.session, now = new Date(Date.now() + IST * 1000), nowMin = now.getUTCHours() * 60 + now.getUTCMinutes(), wd = now.getUTCDay();
    const close = s?.close ?? 1410, open = wd >= 1 && wd <= 5 && nowMin >= 540 && nowMin < close, left = close - nowMin;
    const state = open ? `MCX OPEN · closes ${hmMin(close)} (in ${Math.floor(left / 60)}h ${left % 60}m)` : wd === 0 || wd === 6 ? "MCX CLOSED · weekend · opens Mon 09:00" : nowMin < 540 ? "MCX opens 09:00" : "MCX CLOSED · opens 09:00";
    const seg = (items, cur, attr) => `<div class="mcx-seg" role="tablist">${items.map(([k, l]) => `<button type="button" role="tab" ${attr}="${k}" class="${String(cur) === String(k) ? "on" : ""}" aria-selected="${String(cur) === String(k)}">${l}</button>`).join("")}</div>`;
    set($("gc-head"), `<div class="gc-title"><span class="gc-ico" aria-hidden="true">🪙</span><div><b>Gold Command</b><small>MCX Gold · advisory only</small></div></div>
      ${seg([["GOLDM", "GOLDM (100 g)"], ["GOLD", "GOLD (1 kg)"]], G.und, "data-gc-und")}
      ${seg([[5, "5m"], [15, "15m"], [60, "1h"]], G.tf, "data-gc-tf")}
      <button type="button" class="gc-btn" data-gc-act="refresh">⟳ Refresh</button>
      <div class="gc-clock ${open ? "on" : ""}" aria-live="polite"><b>${now.toISOString().slice(11, 19)} IST</b><span>${state}</span></div>`);
  }

  // ------------------------------------------------------------ decision row
  function renderDec() {
    const d = G.d; if (!d) { set($("gc-dec"), G.err ? `<p class="mcx-note gc-err">${esc(G.err)}</p>` : `<p class="mcx-note">Loading MCX gold…</p>`); return; }
    const bars = d.fut.bars, cl = bars.map((b) => b.close), e9 = ema(cl, 9), e21 = ema(cl, 21), n = cl.length - 1, px = d.fut.last;
    const emaUp = n >= 0 && e9[n] > e21[n], vw = d.vwap, cx = d.comex;
    const votes = [emaUp ? 1 : -1, vw != null && px != null ? (px > vw ? 1 : -1) : 0, cx && cx.changePct != null ? Math.sign(cx.changePct) : 0], sc = votes.reduce((a, b) => a + b, 0);
    const bias = sc >= 2 ? ["UP", "ce"] : sc <= -2 ? ["DOWN", "pe"] : ["MIXED", "wait"];
    const P = d.plan || {}, p = G.plan === "bull" ? P.bull : P.bear, side = G.plan === "bull" ? "CE" : "PE", mult = d.spec.mult;
    const optPx = G.o && G.o.key === `${G.und}|${G.expiry}|${G.strike}|${G.tf}` ? G.o[side]?.last : null;
    const planTxt = p ? `Buy <b>${G.und} ${G.strike ?? "ATM"} ${side}</b> when ${esc(d.fut.name)} closes 15m ${G.plan === "bull" ? "above" : "below"} <b>₹${f0(p.start)}</b> (${esc(p.startAt)}) · SL ₹${f0(p.stop)} · T1 ₹${f0(p.t1)}${p.t2 ? ` · T2 ₹${f0(p.t2)}` : ""} · <b class="${p.rr >= 1.5 ? "mcx-up" : "mcx-dn"}">R:R 1:${p.rr}</b>${optPx ? ` · premium ₹${f2(optPx)} × ${mult} = <b>${inr(optPx * mult)}</b>/lot` : ""}` : "Not enough levels for a plan yet.";
    set($("gc-dec"), `<section class="mcx-card gc-c1" aria-label="Live signal"><div class="mcx-row"><h2 class="mcx-h">Live Signal</h2><span class="mcx-badge wait">❚❚ WAIT</span></div>
        <p class="gc-p">${esc(d.signal.reason)}</p></section>
      <section class="mcx-card gc-c2" aria-label="Bias"><div class="mcx-row"><h2 class="mcx-h">Bias</h2><span class="mcx-badge ${bias[1]}">${bias[0]}</span>
        <span class="gc-chip">EMA 9/21 ${emaUp ? "▲" : "▼"}</span><span class="gc-chip">VWAP ${vw == null ? "—" : px > vw ? "above" : "below"}</span><span class="gc-chip">COMEX ${cx?.changePct == null ? "—" : sg(cx.changePct, 2) + "%"}</span></div>
        <p class="gc-p">${esc(d.fut.name)} ₹${f0(px)} · ${sg(d.fut.chg)} (${sg(d.fut.chgPct, 2)}%) vs PDC · OI ${f0(d.fut.oi)}${d.fut.prevOi ? ` (${sg(d.fut.oi - d.fut.prevOi)})` : ""}</p></section>
      <section class="mcx-card gc-c3" aria-label="Trade plan"><div class="mcx-row"><h2 class="mcx-h">Trade Plan</h2>
        <div class="mcx-seg"><button type="button" data-gc-plan="bull" class="${G.plan === "bull" ? "on g" : ""}">Bull ▲</button><button type="button" data-gc-plan="bear" class="${G.plan === "bear" ? "on r" : ""}">Bear ▼</button></div></div>
        <p class="gc-p">${planTxt}</p>
        <p class="mcx-note">Levels-only plan, not a tested rule. Skip when R:R is below 1:1.5, in the US-data window, or in the last 30 min. Option expiry ${dmy(G.expiry)} · settles into ${esc(d.options.settlesInto || "—")} · exit before expiry.</p></section>`);
  }

  // ------------------------------------------------------------ main futures chart
  function chartOf(id, h) {
    const host = $(id); if (!host || typeof LightweightCharts === "undefined") return null;
    if (G.charts[id] && G.charts[id].host === host) return G.charts[id];
    const ch = LightweightCharts.createChart(host, { autoSize: true, layout: { background: { color: "#0b0e14" }, textColor: "#9aa3b0", fontSize: 11 }, grid: { vertLines: { color: "#141a23" }, horzLines: { color: "#141a23" } },
      rightPriceScale: { borderColor: "#1e2530" }, timeScale: { borderColor: "#1e2530", timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 } });
    const c = ch.addCandlestickSeries({ upColor: "#089981", downColor: "#F23645", wickUpColor: "#089981", wickDownColor: "#F23645", borderVisible: false });
    const e9 = ch.addLineSeries({ color: "#4ea1ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const e21 = ch.addLineSeries({ color: "#f5c542", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    G.charts[id] = { ch, c, e9, e21, host, lines: [], key: null }; return G.charts[id];
  }
  function drawSeries(C, bars, fitKey) {
    const cs = bars.map((b) => ({ time: b.time + IST, open: b.open, high: b.high, low: b.low, close: b.close }));
    C.c.setData(cs); const cl = cs.map((b) => b.close), a = ema(cl, 9), b = ema(cl, 21);
    C.e9.setData(cs.map((x, i) => ({ time: x.time, value: a[i] }))); C.e21.setData(cs.map((x, i) => ({ time: x.time, value: b[i] })));
    if (C.key !== fitKey) { C.key = fitKey; const n = cs.length; if (n > 120) C.ch.timeScale().setVisibleLogicalRange({ from: n - 120, to: n + 3 }); else C.ch.timeScale().fitContent(); }
  }
  function setLines(C, specs) {
    const sig = JSON.stringify(specs.map((s) => [s.price.toFixed(2), s.title]));
    if (C.lineSig === sig) return; C.lineSig = sig;
    for (const l of C.lines) { try { C.c.removePriceLine(l); } catch (e) { /* gone */ } }
    C.lines = specs.map((s) => C.c.createPriceLine(s));
  }
  function renderChart() {
    const d = G.d; if (!d) return;
    const tfL = { 5: "5m", 15: "15m", 60: "1h" }[G.tf], f = d.fut;
    set($("gc-chart-hd"), `<b class="gc-sym">${esc(f.name)}</b><span class="mcx-note">₹ per 10 g · ${tfL} · MCX · lot ${esc(d.spec.grams)} (₹${d.spec.mult} per ₹1)</span>
      <b class="gc-px">₹${f0(f.last)}</b><span class="${(f.chg ?? 0) >= 0 ? "mcx-up" : "mcx-dn"}">${sg(f.chg)} (${sg(f.chgPct, 2)}%)</span>
      <span class="mcx-note">${f.lastTime ? `last bar ${hm(f.lastTime)} IST` : ""}${f.stale ? " · <b class='mcx-dn'>STALE</b>" : ""}</span>`);
    const C = chartOf("gc-chart"); if (!C || !f.bars.length) return;
    drawSeries(C, f.bars, `${G.und}|${G.tf}`);
    const lo = Math.min(...f.bars.slice(-150).map((b) => b.low)), hi = Math.max(...f.bars.slice(-150).map((b) => b.high)), pad = (hi - lo) * 0.25, inView = (p) => p >= lo - pad && p <= hi + pad;
    const specs = d.levels.filter((l) => inView(l.price)).map((l) => ({ price: l.price, color: l.kind === "R" ? "#ef5350" : "#26a69a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.label }));
    const P = d.plan?.[G.plan];
    if (P) { const nm = G.plan === "bull" ? "BULL" : "BEAR", col = G.plan === "bull" ? "#2962ff" : "#ff9800";
      specs.push({ price: P.start, color: col, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `${nm} STARTS · ${P.startAt}` }, { price: P.stop, color: "#f23645", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} STOP` }, { price: P.t1, color: "#089981", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `${nm} T1` }); }
    setLines(C, specs);
    renderTimeline();
  }
  function renderTimeline() {
    const s = G.d?.session; if (!s) return;
    const span = s.close - 540, pct = (x) => ((x - 540) / span) * 100;
    const Z = [[540, 600, "Open", "gz-good", "Opening hour — mark the first-hour high / low"], [600, s.london, "Quiet", "gz-mute", "Asia midday — thin and choppy, avoid chasing"],
      [s.london, s.london + 120, "London", "gz-blue", "London open — volume returns"], [s.london + 120, s.usData - 30, "", "gz-mute", "Europe afternoon"],
      [s.usData - 30, s.usData + 30, "Data", "gz-bad", "US data window — no new trade 30 min either side"], [s.usData + 30, s.close - 30, "US session", "gz-good", "COMEX + US hours — the main gold move"],
      [s.close - 30, s.close, "Close", "gz-bad", "Last 30 min — no new trade, square off"]];
    const now = new Date(Date.now() + IST * 1000), m = now.getUTCHours() * 60 + now.getUTCMinutes(), wd = now.getUTCDay(), on = wd >= 1 && wd <= 5 && m >= 540 && m < s.close;
    set($("gc-timeline"), `<div class="gc-tl" role="img" aria-label="MCX gold trading day in IST">${Z.map(([a, b, l, c, t]) => `<div class="${c}" style="width:${(pct(b) - pct(a)).toFixed(2)}%" title="${hmMin(a)}–${hmMin(b)} IST · ${esc(t)}">${esc(l)}</div>`).join("")}${on ? `<i style="left:${pct(m).toFixed(2)}%"></i>` : ""}</div>
      <div class="gc-tlx">${[540, 720, 900, s.usData, 1260, s.close].map((x) => `<span style="left:${pct(x).toFixed(2)}%">${hmMin(x)}</span>`).join("")}</div>`);
  }

  // ------------------------------------------------------------ option premium column (CE over PE)
  function renderOt() {
    const d = G.d; if (!d) return;
    const O = d.options, st = O.strikes || [], i = st.indexOf(G.strike), atmI = st.indexOf(O.atm);
    const exp = O.expiries.map((e) => `<button type="button" data-gc-exp="${e}" class="${e === G.expiry ? "on" : ""}">${dmy(e)}</button>`).join("");
    const chips = [-2, -1, 0, 1, 2].map((k) => { const s = st[atmI + k]; return s == null ? "" : `<button type="button" data-gc-strike="${s}" class="${s === G.strike ? "on" : ""}">${k === 0 ? "ATM" : k > 0 ? "+" + k : k}</button>`; }).join("");
    const ei = O.expiryInfo, warn = ei && ei.nearExpiry ? `<p class="gc-warn">⚠ ${ei.daysLeft <= 0 ? "Expiry today" : `${ei.daysLeft} day${ei.daysLeft === 1 ? "" : "s"} to expiry`} — an in-the-money option turns into ${esc(O.settlesInto || "futures")} (needs futures margin). Exit before expiry.</p>` : "";
    set($("gc-ot-hd"), `<div class="mcx-row"><h2 class="mcx-h">${G.und} Options</h2><div class="mcx-seg">${exp}</div></div>
      <div class="mcx-row gc-otbar"><div class="mcx-seg">${[["both", "Both"], ["CE", "CE"], ["PE", "PE"]].map(([k, l]) => `<button type="button" data-gc-side="${k}" class="${G.side === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="gc-step"><button type="button" aria-label="Lower strike" data-gc-step="-1" ${i <= 0 ? "disabled" : ""}>−</button><b>${f0(G.strike)}</b><button type="button" aria-label="Higher strike" data-gc-step="1" ${i < 0 || i >= st.length - 1 ? "disabled" : ""}>+</button></div>
        <div class="mcx-seg">${chips}</div></div>${warn}`);
    const o = G.o && G.o.key === `${G.und}|${G.expiry}|${G.strike}|${G.tf}` ? G.o : null;
    for (const side of ["CE", "PE"]) {
      const box = $(`gc-${side.toLowerCase()}-box`); if (box) box.hidden = G.side !== "both" && G.side !== side;
      const S = o?.[side], hd = $(`gc-${side.toLowerCase()}-hd`);
      if (!S || !S.available) { set(hd, `<b>${G.und} ${f0(G.strike)} ${side}</b> <span class="mcx-note">${esc(S?.error || G.oErr || "loading…")}</span>`); continue; }
      const cl = S.bars.map((b) => b.close), a = ema(cl, 9), b = ema(cl, 21), n = cl.length - 1, up = n >= 0 && cl[n] > a[n] && a[n] > b[n];
      const oi0 = S.bars.length > 12 ? S.bars[S.bars.length - 13].oi : null;
      set(hd, `<b>${G.und} ${f0(G.strike)} ${side}</b> <b class="${side === "CE" ? "mcx-up" : "mcx-dn"}">₹${f2(S.last)}</b> <span>× ${o.mult} = <b>${inr(S.costPerLot)}</b>/lot</span>
        <span class="mcx-note">${up ? "Bullish" : "not bullish"} · E9 ${f2(a[n])} · E21 ${f2(b[n])} · OI ${f0(S.oi)}${oi0 != null && S.oi != null ? ` (${sg(S.oi - oi0)} 1h)` : ""}${S.stale ? " · STALE" : ""}</span>`);
      const C = chartOf(`gc-${side.toLowerCase()}`); if (C && S.bars.length) drawSeries(C, S.bars, o.key + side);
    }
  }

  // ------------------------------------------------------------ right column: ticket · levels · timings · COMEX
  function renderTicket() {
    const d = G.d; if (!d) return;
    const mult = d.spec.mult, side = G.plan === "bull" ? "CE" : "PE", o = G.o && G.o.key === `${G.und}|${G.expiry}|${G.strike}|${G.tf}` ? G.o : null;
    const live = o?.[side]?.last ?? null, pv = parseFloat(G.prem) > 0 ? parseFloat(G.prem) : live, lots = G.lots, cost = pv ? pv * mult * lots : null;
    const ei = d.options.expiryInfo, fm = G.und === "GOLD" ? "~₹6–13 lakh" : "~₹60,000–1.3 lakh";
    const el = $("gc-ticket"); if (!el) return;
    if (!el._built || el._und !== G.und) {
      el._built = true; el._und = G.und;
      el.innerHTML = `<div class="mcx-row"><h2 class="mcx-h gc-gold">${G.und} option · buy</h2><span class="gc-expb" id="gc-expb"></span></div>
        <div class="gc-tk-in"><label for="gc-prem">Premium ₹/10 g</label><input id="gc-prem" type="number" inputmode="decimal" min="0" step="0.5" autocomplete="off"></div>
        <div class="gc-lots" role="group" aria-label="Lots">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-gc-lots="${n}">${n}</button>`).join("")}</div>
        <div class="gc-tk-g" id="gc-tk-g"></div><p class="mcx-note" id="gc-tk-n"></p>`;
    }
    const inp = $("gc-prem"); if (inp && document.activeElement !== inp) { inp.value = G.prem; inp.placeholder = live ? `live ${side} ${f2(live)}` : "e.g. 1500"; }
    el.querySelectorAll("[data-gc-lots]").forEach((b) => b.classList.toggle("on", Number(b.dataset.gcLots) === lots));
    set($("gc-expb"), ei ? `expiry ${dmy(ei.expiry)} · ${ei.daysLeft <= 0 ? "today" : ei.daysLeft + " d left"}` : "");
    $("gc-expb")?.classList.toggle("near", !!ei?.nearExpiry);
    set($("gc-tk-g"), `<div><span>Cost</span><b>${inr(cost)}</b></div><div><span>Max loss</span><b class="mcx-dn">${inr(cost)}</b></div><div><span>Per ₹1 move</span><b>${inr(mult * lots)}</b></div><div><span>Capital (2×)</span><b class="gc-gold">${inr(cost ? cost * 2 : null)}</b></div>`);
    set($("gc-tk-n"), `${pv === live && live ? `Using the live ${G.und} ${f0(G.strike)} ${side} premium. ` : ""}Cost = premium × ${mult} × lots; max loss = premium paid + charges. Held to expiry in the money: needs futures margin ${fm} per lot.`);
  }
  function renderLevels() {
    const d = G.d; if (!d) return; const px = d.fut.last;
    const rows = [...d.levels, { price: px, label: "Spot", why: d.fut.name, kind: "N" }].filter((l) => l.price != null).sort((a, b) => b.price - a.price);
    set($("gc-levels"), `<h2 class="mcx-h">Key Levels</h2>${rows.map((l) => { const dd = l.kind === "N" ? null : l.price - px;
      return `<div class="mcx-lv${l.kind === "N" ? " spot" : ""}" title="${esc(l.why)}"><span class="bar" style="background:${l.kind === "R" ? "#F23645" : l.kind === "S" ? "#089981" : "#4ea1ff"}"></span><span class="nm"><span class="nmt">${esc(l.label)}</span></span><b class="px">${f0(l.price)}</b><span class="ds ${dd == null ? "" : dd > 0 ? "mcx-dn" : "mcx-up"}">${dd == null ? "SPOT" : sg(dd)}</span></div>`; }).join("")}`);
  }
  function renderTimes() {
    const s = G.d?.session; if (!s) return;
    const W = [[`09:00–${hmMin(s.close)}`, "MCX gold session (Mon–Fri)", "SESSION", "mu"], ["09:00–10:00", "Opening range — mark first-hour H/L", "GOOD", "ok"], [`10:00–${hmMin(s.london)}`, "Asia midday — thin, choppy", "AVOID", "warn"],
      [`${hmMin(s.london)}–${hmMin(s.london + 120)}`, "London open — volume returns", "GOOD", "ok"], [`${hmMin(s.usData - 30)}–${hmMin(s.usData + 30)}`, `US data ${hmMin(s.usData)} · COMEX opens ${hmMin(s.comexOpen)}`, "NO NEW", "bad"],
      [`${hmMin(s.usData + 30)}–${hmMin(s.close - 30)}`, "US session — main gold move", "BEST", "ok"], [`${hmMin(s.close - 30)}–${hmMin(s.close)}`, "Close — no new trade, square off", "EXIT", "bad"]];
    set($("gc-times"), `<h2 class="mcx-h">Trade Timings (IST)</h2>${W.map(([t, w, tag, c]) => `<div class="gc-tw"><b>${t}</b><span>${esc(w)}</span><em class="${c}">${tag}</em></div>`).join("")}
      <p class="mcx-note">${s.usSummer ? "US on summer time: data 18:00, close 23:30; from the first Sunday of November data 19:00, close 23:55." : "US on winter time: data 19:00, close 23:55; from the second Sunday of March data 18:00, close 23:30."} Window labels are general market-hours guidance, not a backtest.</p>`);
  }
  function renderComex() {
    const c = G.d?.comex, px = G.d?.fut.last; if (!c) { set($("gc-comex"), ""); return; }
    const prem = c.parity10g && px ? px - c.parity10g : null;
    set($("gc-comex"), `<span class="gc-cx-t">COMEX GOLD</span><span class="gc-cx-u">per ounce · USD${c.stale ? " · stale" : ""}</span><b class="gc-cx-p">$${f2(c.price)}</b>
      <span class="${(c.changePct ?? 0) >= 0 ? "mcx-up" : "mcx-dn"}">${sg(c.changePct, 2)}%</span>
      <div class="gc-cx-g"><div><span>USD/INR</span><b>₹${f2(c.usdinr)}</b></div><div><span>COMEX in ₹/10 g</span><b>₹${f0(c.parity10g)}</b></div><div><span>MCX over COMEX</span><b>${sg(prem)}</b></div></div>
      <p class="mcx-note">MCX is higher than COMEX × USD/INR mainly because of import duty and GST.</p>`);
  }

  function render() { try { renderHead(); renderDec(); renderChart(); renderOt(); renderTicket(); renderLevels(); renderTimes(); renderComex(); } catch (e) { console.warn("[gold] render", e); } }

  // ------------------------------------------------------------ events
  document.addEventListener("click", (e) => {
    const t = e.target.closest("#panel-goldcommand [data-gc-und], #panel-goldcommand [data-gc-tf], #panel-goldcommand [data-gc-act], #panel-goldcommand [data-gc-plan], #panel-goldcommand [data-gc-exp], #panel-goldcommand [data-gc-strike], #panel-goldcommand [data-gc-step], #panel-goldcommand [data-gc-side], #panel-goldcommand [data-gc-lots]");
    if (!t) return; const ds = t.dataset;
    if (ds.gcUnd && ds.gcUnd !== G.und) { G.und = ds.gcUnd; G.expiry = null; G.strike = null; G.d = null; G.o = null; G.prem = ""; loadCmd(true); }
    else if (ds.gcTf && Number(ds.gcTf) !== G.tf) { G.tf = Number(ds.gcTf); loadCmd(true).then(() => loadOpt(true)); }
    else if (ds.gcAct === "refresh") loadCmd(true).then(() => loadOpt(true));
    else if (ds.gcPlan) { G.plan = ds.gcPlan; renderDec(); renderChart(); renderTicket(); }
    else if (ds.gcExp && ds.gcExp !== G.expiry) { G.expiry = ds.gcExp; G.strike = null; loadCmd(true).then(() => loadOpt(true)); }
    else if (ds.gcStrike) { G.strike = Number(ds.gcStrike); renderOt(); loadOpt(true); }
    else if (ds.gcStep) { const st = G.d?.options.strikes || [], i = st.indexOf(G.strike) + Number(ds.gcStep); if (st[i] != null) { G.strike = st[i]; renderOt(); loadOpt(true); } }
    else if (ds.gcSide) { G.side = ds.gcSide; renderOt(); }
    else if (ds.gcLots) { G.lots = Number(ds.gcLots); renderTicket(); }
  });
  document.addEventListener("input", (e) => { if (e.target && e.target.id === "gc-prem") { G.prem = e.target.value; renderTicket(); } });

  // one 1-s heartbeat: clock + timeline always; data only while the Gold tab is visible
  setInterval(() => { if (!active()) return; renderHead(); renderTimeline(); loadCmd(false).then(() => loadOpt(false)); }, 1000);
})();
