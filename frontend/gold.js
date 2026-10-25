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
  // TradingView-style chart: TV dark theme, crosshair snapped to candles with price / time labels, volume pane, OHLC legend
  // (top-left, follows the crosshair), opens on the latest bars with the price scale fitted to what is visible.
  const TV = { bg: "#131722", grid: "#1e222d", text: "#d1d4dc", border: "#2a2e39", up: "#26a69a", down: "#ef5350" };
  function chartOf(id, title, compact) {
    const host = $(id); if (!host || typeof LightweightCharts === "undefined") return null;
    if (G.charts[id] && G.charts[id].host === host) { G.charts[id].title = title || G.charts[id].title; return G.charts[id]; }
    const ch = LightweightCharts.createChart(host, { autoSize: true,
      layout: { background: { type: "solid", color: TV.bg }, textColor: TV.text, fontSize: 11, fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif" },
      grid: { vertLines: { color: TV.grid }, horzLines: { color: TV.grid } },
      crosshair: { mode: 1, vertLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: TV.border }, horzLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: TV.border } },
      rightPriceScale: { borderColor: TV.border, scaleMargins: { top: 0.12, bottom: 0.22 } },
      timeScale: { borderColor: TV.border, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7, minBarSpacing: 2 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true } });
    const c = ch.addCandlestickSeries({ upColor: TV.up, downColor: TV.down, borderUpColor: TV.up, borderDownColor: TV.down, wickUpColor: TV.up, wickDownColor: TV.down, priceLineColor: "#787b86", priceLineStyle: 2 });
    const e9 = ch.addLineSeries({ color: "#2962ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const e21 = ch.addLineSeries({ color: "#f7a21b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const vol = ch.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const leg = document.createElement("div"); leg.className = "gc-leg"; host.appendChild(leg);
    const C = { ch, c, e9, e21, vol, host, leg, lines: [], key: null, title: title || "", rows: new Map(), compact: !!compact };
    ch.subscribeCrosshairMove((p) => { const r = p && p.time != null ? C.rows.get(p.time) : null; legend(C, r || C.lastRow); });
    G.charts[id] = C; return C;
  }
  function legend(C, r) {
    if (!r) { C.leg.innerHTML = `<b>${esc(C.title)}</b>`; return; }
    const ch = r.prev ? r.close - r.prev : r.close - r.open, pct = (r.prev || r.open) ? (ch / (r.prev || r.open)) * 100 : 0, cls = ch >= 0 ? "up" : "dn";
    // small premium charts: one line (TradingView's compact legend); full OHLC when expanded
    if (C.compact && !C.host.closest(".gc-full")) { C.leg.innerHTML = `<span class="lk">O</span><span class="${cls}">${f2(r.open)}</span> <span class="lk">H</span><span class="${cls}">${f2(r.high)}</span> <span class="lk">L</span><span class="${cls}">${f2(r.low)}</span> <span class="lk">C</span><span class="${cls}">${f2(r.close)}</span> <span class="${cls}">${sg(pct, 2)}%</span>`; return; }
    C.leg.innerHTML = `<b>${esc(C.title)}</b> <span class="lk">O</span><span class="${cls}">${f2(r.open)}</span> <span class="lk">H</span><span class="${cls}">${f2(r.high)}</span> <span class="lk">L</span><span class="${cls}">${f2(r.low)}</span> <span class="lk">C</span><span class="${cls}">${f2(r.close)} ${sg(ch, 2)} (${sg(pct, 2)}%)</span>`
      + `<br><span class="e9">EMA 9 ${f2(r.e9)}</span> <span class="e21">EMA 21 ${f2(r.e21)}</span>${r.vol ? ` <span class="lk">Vol</span> ${f0(r.vol)}` : ""}${r.oi != null ? ` <span class="lk">OI</span> ${f0(r.oi)}` : ""}`;
  }
  function drawSeries(C, bars, fitKey) {
    const cs = bars.map((b) => ({ time: b.time + IST, open: b.open, high: b.high, low: b.low, close: b.close }));
    C.c.setData(cs); const cl = cs.map((b) => b.close), a = ema(cl, 9), b = ema(cl, 21);
    C.e9.setData(cs.map((x, i) => ({ time: x.time, value: a[i] }))); C.e21.setData(cs.map((x, i) => ({ time: x.time, value: b[i] })));
    C.vol.setData(bars.map((x) => ({ time: x.time + IST, value: x.volume || 0, color: x.close >= x.open ? "rgba(38,166,154,.45)" : "rgba(239,83,80,.45)" })));
    C.rows = new Map(cs.map((x, i) => [x.time, { ...x, prev: i ? cs[i - 1].close : null, e9: a[i], e21: b[i], vol: bars[i].volume, oi: bars[i].oi }]));
    C.lastRow = cs.length ? C.rows.get(cs[cs.length - 1].time) : null; legend(C, C.lastRow);
    // first draw of this series: show the latest ~90 bars (today's session), price scale fitted to them, as TradingView opens
    if (C.key !== fitKey) { C.key = fitKey; showLatest(C); }
  }
  /** TradingView-like default view: the latest bars (more when the chart is expanded), price scale fitted to them. */
  function showLatest(C) {
    const n = C.rows.size, full = !!C.host.closest(".gc-full"), k = full ? 160 : C.compact ? 70 : 110, w = C.host.clientWidth || 600;
    C.ch.timeScale().applyOptions({ barSpacing: Math.max(3, Math.min(14, (w - 70) / (k + 6))) });
    C.ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - k), to: n + 6 }); C.c.priceScale().applyOptions({ autoScale: true });
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
    set($("gc-chart-hd"), `<button type="button" class="gc-exp" data-gc-expand="gc-chartcol" aria-label="Expand chart" title="Expand (Esc to close)">⤢</button><b class="gc-sym">${esc(f.name)}</b><span class="mcx-note">₹ per 10 g · ${tfL} · MCX · lot ${esc(d.spec.grams)} (₹${d.spec.mult} per ₹1)</span>
      <b class="gc-px">₹${f0(f.last)}</b><span class="${(f.chg ?? 0) >= 0 ? "mcx-up" : "mcx-dn"}">${sg(f.chg)} (${sg(f.chgPct, 2)}%)</span>
      <span class="mcx-note">${f.lastTime ? `last bar ${hm(f.lastTime)} IST` : ""}${f.stale ? " · <b class='mcx-dn'>STALE</b>" : ""}</span>`);
    const C = chartOf("gc-chart", `${f.name} · ${tfL} · MCX`); if (!C || !f.bars.length) return;
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
      set(hd, `<button type="button" class="gc-exp" data-gc-expand="gc-${side.toLowerCase()}-box" aria-label="Expand ${side} chart" title="Expand (Esc to close)">⤢</button><b>${G.und} ${f0(G.strike)} ${side}</b> <b class="${side === "CE" ? "mcx-up" : "mcx-dn"}">₹${f2(S.last)}</b> <span>× ${o.mult} = <b>${inr(S.costPerLot)}</b>/lot</span>
        <span class="mcx-note">${up ? "Bullish" : "not bullish"} · E9 ${f2(a[n])} · E21 ${f2(b[n])} · OI ${f0(S.oi)}${oi0 != null && S.oi != null ? ` (${sg(S.oi - oi0)} 1h)` : ""}${S.stale ? " · STALE" : ""}</span>
        <span class="gc-sr mcx-note"></span>`);
      const C = chartOf(`gc-${side.toLowerCase()}`, `${G.und} ${f0(G.strike)} ${side} · ${G.tf}m · MCX`, true); if (C && S.bars.length) {
        drawSeries(C, S.bars, o.key + side);
        // premium support / resistance (same engine as Market Command): R2 · R1 · S1 · S2 and the pullback zone around the
        // latest break in the premium's structure (BIOS ± ¼ of the premium's 14-bar ATR)
        const T = S.st || {}, br = S.bars, tr = br.slice(1).map((x, k) => Math.max(x.high - x.low, Math.abs(x.high - br[k].close), Math.abs(x.low - br[k].close))).slice(-14);
        const atr = tr.length ? tr.reduce((p, q) => p + q, 0) / tr.length : 0, half = Math.max(0.5, Math.round(atr * 0.25 * 10) / 10), bios = T.bios ? T.bios.price : null;
        const specs = [["r2", "#F23645", "R2"], ["r1", "#F23645", "R1"], ["s1", "#089981", "S1"], ["s2", "#089981", "S2"]].filter(([k]) => T[k] != null).map(([k, color, title]) => ({ price: T[k], color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
        if (bios != null) specs.push({ price: bios + half, color: "rgba(239,68,68,.85)", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "PB zone" }, { price: bios - half, color: "rgba(239,68,68,.85)", lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: "" });
        setLines(C, specs);
        const sr = `${T.structure ? `structure ${T.structure}` : "structure —"} · R1 ${f2(T.r1)} · S1 ${f2(T.s1)}${bios != null ? ` · BIOS ${T.bios.direction === "BULLISH" ? "▲" : "▼"} ${f2(bios)} · pullback zone ${f2(bios - half)} – ${f2(bios + half)}` : " · no break in premium structure yet"}`;
        if (hd) { hd.title = sr; const n2 = hd.querySelector(".gc-sr"); if (n2) n2.textContent = `R1 ${f2(T.r1)} · S1 ${f2(T.s1)}`; }
      }
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
  // ⤢ expand a chart to full screen (Esc or ⤢ again to close); re-frame once the chart has its new size
  const reframe = (box) => [60, 250, 600].forEach((ms) => setTimeout(() => Object.values(G.charts).forEach((C) => { if (box.contains(C.host)) { showLatest(C); legend(C, C.lastRow); } }), ms));
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#panel-goldcommand [data-gc-expand]"); if (!b) return;
    const box = b.closest(".gc-otc, .gc-chartcol"); if (!box) return;
    const on = !box.classList.contains("gc-full"); document.querySelectorAll("#panel-goldcommand .gc-full").forEach((x) => x.classList.remove("gc-full")); box.classList.toggle("gc-full", on);
    document.body.classList.toggle("gc-has-full", on);
    reframe(box);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return; const box = document.querySelector("#panel-goldcommand .gc-full"); if (!box) return;
    box.classList.remove("gc-full"); document.body.classList.remove("gc-has-full");
    reframe(box);
  });
  document.addEventListener("input", (e) => { if (e.target && e.target.id === "gc-prem") { G.prem = e.target.value; renderTicket(); } });

  // one 1-s heartbeat: clock + timeline always; data only while the Gold tab is visible
  setInterval(() => { if (!active()) return; renderHead(); renderTimeline(); loadCmd(false).then(() => loadOpt(false)); }, 1000);
})();
