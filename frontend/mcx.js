// ============================ Market Command redesign (owner-approved preview, 2026-10-24) ============================
// Additive layer over the existing Market Command screen: it never touches the main chart's data or logic.
//   ⚡ / 🔬 view tabs · market tape · decision row (live signal, bias, trade plan) · key-level ladder · option terminal
//   (CE / PE premium charts, TradingView style, pullback zone, ATR, filters) · 🧱 Wall Builder in OI Analysis.
// Every number comes from an existing API: /api/market-command (MC.lastData), /api/premium-center, /api/index-desk,
// /api/hour-outlook, /api/positioning, /api/market-sentiment-brief, /api/option-candles, /api/option-structure, /api/oi-walls.
// No flicker: a panel is rewritten only when its HTML changed, and a failed refresh keeps the last good values.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const IST = 19800;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const f0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
  const f2 = (v) => (v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const sg = (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + f0(Math.abs(v)));
  const amt = (v) => { if (v == null || !isFinite(v)) return "—"; const a = Math.abs(v), s = v > 0 ? "+" : v < 0 ? "−" : ""; return a >= 1e7 ? s + (a / 1e7).toFixed(2) + "Cr" : a >= 1e5 ? s + (a / 1e5).toFixed(1) + "L" : a >= 1e3 ? s + (a / 1e3).toFixed(0) + "K" : s + a; };
  const hm = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
  const STEP = { "^NSEI": 50, "^NSEBANK": 100, "^CNXFIN": 50, "^NSEMDCP50": 25, "^BSESN": 100 };
  const set = (node, html) => { if (node && node.__mcx !== html) { node.innerHTML = html; node.__mcx = html; } };   // no flicker: write only on change
  const mcOn = () => $("panel-marketcommand")?.classList.contains("active") && !document.hidden;

  const X = { c5: {}, view: "mc", plan: "bull", tab: "levels", seen: null, pc: {}, desk: null, hour: null, pos: {}, sent: null, walls: {}, ot: { strike: null, side: "both", tf: 5, expiry: null, expiries: [], sym: null, data: {}, charts: {} }, wb: { win: "15", data: null, sym: null }, err: {} };
  window.__mcx = X;   // read-only handle for diagnosis in the browser console
  const get = async (url, ms) => { try { const d = await fetchJSON(url, ms || 25000); if (d && (d.error || d.disabled)) X.err[url.split("?")[0]] = d.error || "disabled"; return d; } catch (e) { X.err[url.split("?")[0]] = String((e && e.message) || e); return null; } };

  // ------------------------------------------------------------ data refresh (each source keeps its last good value)
  async function refreshSlow(force) {
    const sym = (typeof MC !== "undefined" && MC.sym) || "^NSEI", enc = encodeURIComponent(sym);
    const now = Date.now(), due = (k, ms) => force || !X[k + "At"] || now - X[k + "At"] > ms;
    const jobs = [];
    if (due("pc" + sym, 60_000)) jobs.push(get(`/api/premium-center?symbol=${enc}&interval=15m`, 40000).then((d) => { if (d && d.available) { X.pc[sym] = d; X["pc" + sym + "At"] = now; } }));
    if (due("desk", 60_000)) jobs.push(get("/api/index-desk").then((d) => { if (d && d.rows) { X.desk = d; X.deskAt = now; } }));
    if (due("hour", 120_000)) jobs.push(get("/api/hour-outlook").then((d) => { if (d && d.outlook) { X.hour = d; X.hourAt = now; } }));
    if (due("pos" + sym, 300_000)) jobs.push(get(`/api/positioning?symbol=${enc}`).then((d) => { if (d && d.ok) { X.pos[sym] = d; X["pos" + sym + "At"] = now; } }));
    if (due("sent", 300_000)) jobs.push(get("/api/market-sentiment-brief").then((d) => { if (d && d.india) { X.sent = d; X.sentAt = now; } }));
    if (MC.tf !== "5m" && due("c5" + sym, 60_000)) jobs.push(get(`/api/candles/${enc}?interval=5m`).then((d) => { if (d && Array.isArray(d.candles) && d.candles.length) { X.c5[sym] = d.candles; X["c5" + sym + "At"] = now; } }));   // 5m reaction on the ladder
    if (due("walls" + sym, 60_000)) jobs.push(get(`/api/oi-walls?symbol=${enc}`).then((d) => { if (d && d.available) { X.walls[sym] = d; X["walls" + sym + "At"] = now; } }));
    await Promise.all(jobs);
    renderAll();
  }

  // ------------------------------------------------------------ market tape
  function renderTape(d) {
    const sym = MC.sym, desk = X.desk?.rows?.find((r) => r.symbol === sym), pos = X.pos[sym], sent = X.sent;
    const vix = d.vix || {}, vol = d.decision?.volatility || {}, cs = d.candles || [];
    const atrTf = typeof mcAtr14 === "function" ? mcAtr14(cs.slice(-15)) : null;
    const day = cs.length ? new Date((cs[cs.length - 1].time + IST) * 1000).toISOString().slice(0, 10) : null;
    const dv = cs.filter((c) => new Date((c.time + IST) * 1000).toISOString().slice(0, 10) === day).reduce((a, c) => a + (c.volume || 0), 0);
    const fii = pos?.fii, idx = sent?.india?.indices || [], us = sent?.global?.us || [];
    const cell = (k, v, sub, cls) => `<div title="${esc(sub)}"><span class="mcx-k">${esc(k)}</span><span class="mcx-v ${cls || ""}">${esc(v)}</span><span class="mcx-s">${esc(sub)}</span></div>`;
    const chg = (x) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`);
    set($("mcx-tape"), [
      cell("India VIX", vix.value != null ? f2(vix.value) : "—", `day ${f2(vix.dayLow)} – ${f2(vix.dayHigh)} · ${vix.status || ""}`),
      cell("ATR (14)", `${vol.atr != null ? vol.atr.toFixed(1) : "—"}${atrTf != null ? " · " + atrTf.toFixed(1) : ""}`, `5m${atrTf != null ? " · " + MC.tf : ""} · ratio ${vol.atrRatio ?? "—"} ${vol.state || ""}`),
      cell("PCR (whole chain)", d.oi?.pcr != null ? d.oi.pcr.toFixed(2) : desk?.pcr ?? "—", `max pain ${f0(d.oi?.maxPain)} · ${d.oi?.verdict || ""}`, (d.oi?.pcr ?? 1) < 0.9 ? "mcx-dn" : (d.oi?.pcr ?? 1) > 1.1 ? "mcx-up" : ""),
      cell("FII index futures", fii ? sg(fii.net) : "—", fii ? `net ${fii.net < 0 ? "short" : "long"} · long/short ${fii.longShortRatio} · ${fii.tradingDate}` : "loading", fii ? (fii.net < 0 ? "mcx-dn" : "mcx-up") : ""),
      cell("Volume", dv ? amt(dv).replace("+", "") : "—", `${day || ""} · ${String(MC.tf)} candles`),
      cell("Sector lean", sent?.india?.lean || "—", idx.filter((x) => x.label !== "NIFTY").slice(0, 2).map((x) => `${x.label} ${chg(x.changePct)}`).join(" · "), /BEAR/.test(sent?.india?.lean || "") ? "mcx-dn" : /BULL/.test(sent?.india?.lean || "") ? "mcx-up" : ""),
      cell("Global cues", us.length ? (us.reduce((a, x) => a + (x.changePct || 0), 0) >= 0 ? "POSITIVE" : "NEGATIVE") : "—", us.slice(0, 2).map((x) => `${x.label} ${chg(x.changePct)}`).join(" · "), us.length ? (us.reduce((a, x) => a + (x.changePct || 0), 0) >= 0 ? "mcx-up" : "mcx-dn") : ""),
    ].join(""));
  }

  // ------------------------------------------------------------ decision row: live signal · bias · trade plan
  function renderDecision(d) {
    const sym = MC.sym, pc = X.pc[sym], T = pc?.trader, desk = X.desk?.rows?.find((r) => r.symbol === sym), ho = X.hour?.outlook?.find((r) => r.symbol === sym);
    const fa = d.decision?.finalAction || "WAIT", cls = /CE|BUY_CE/.test(fa) ? "ce" : /PE|BUY_PE/.test(fa) ? "pe" : "wait";
    const sc = (t) => (t ? `<b class="${t.score >= 0 ? "mcx-up" : "mcx-dn"}">${esc(t.label)} ${t.score}</b>` : "—");
    const P = T?.plans || {}, b = P.bull, r = P.bear, nt = P.noTrade;
    const live = `<section class="mcx-card" style="flex:1 1 290px" aria-label="Live signal"><div class="mcx-row"><h2 class="mcx-h">Live Signal</h2>
      <span class="mcx-badge ${cls}">${cls === "wait" ? "❚❚ " : ""}${esc(fa.replace("BUY_", "BUY "))}</span>
      <span class="mcx-kv" style="font-family:'JetBrains Mono',monospace"><i>15m</i>${sc(desk?.tf15)} · <i>1H</i>${sc(desk?.tf1h)} · <i>conf</i><b>${ho?.confidence != null ? ho.confidence + "%" : "—"}</b></span></div>
      <p class="mcx-line" title="${esc(d.decision?.reason || "")}">${esc(d.decision?.reason || "—")}${b && r ? ` · CE only above <b>${f0(b.entry)}</b> · PE only below <b>${f0(r.entry)}</b>` : ""}</p></section>`;
    const trends = (T?.trends || []).map((t) => ({ tf: t.tf, v: t.verdict })), ups = trends.filter((t) => t.v === "UP").length, dns = trends.filter((t) => t.v === "DOWN").length;
    const lean = !trends.length ? "—" : ups && !dns ? "BULLISH" : dns && !ups ? "BEARISH" : "MIXED", lc = lean === "BULLISH" ? "mcx-up" : lean === "BEARISH" ? "mcx-dn" : "mcx-am";
    const s = d.spot != null ? d.spot : null, sp = pc?.spot || {}, vw = d.overlays?.vwap?.length ? d.overlays.vwap[d.overlays.vwap.length - 1] : null;
    const bias = `<section class="mcx-card" style="flex:1 1 290px" aria-label="Market bias"><div class="mcx-row"><h2 class="mcx-h">Bias</h2><span class="mcx-badge ${lean === "BULLISH" ? "ce" : lean === "BEARISH" ? "pe" : "wait"}" style="font-size:13px">${lean}</span>
      ${trends.map((t) => `<span class="mcx-chip ${t.v === "UP" ? "mcx-up" : t.v === "DOWN" ? "mcx-dn" : "mcx-am"}"><span class="mcx-mu">${esc(t.tf)}</span> <b>${t.v === "UP" ? "▲" : t.v === "DOWN" ? "▼" : "▬"}</b></span>`).join("")}</div>
      <p class="mcx-line">${sp.high != null ? `H ${f0(sp.high)} · L ${f0(sp.low)} · ` : ""}${vw != null && s != null ? `${s >= vw ? "above" : "below"} VWAP ${f0(vw)}` : ""}${X.sent?.india?.lean ? ` · sectors ${esc(X.sent.india.lean.toLowerCase())}` : ""}</p></section>`;
    const p = X.plan === "bull" ? b : r, ce = X.plan === "bull";
    const realRisk = p && T?.atr15 ? Math.round(Math.abs(p.entry - p.stop) + T.atr15) : null;
    const kv = (k, v, c) => `<span class="mcx-kv"><i>${k}</i><b class="${c || ""}">${v}</b></span>`;
    const plan = `<section class="mcx-card" style="flex:2 1 560px" aria-label="Trade plan"><div class="mcx-row"><h2 class="mcx-h">Trade Plan</h2>
      <div class="mcx-seg" role="tablist" aria-label="Plan side"><button type="button" role="tab" data-mcx-plan="bull" class="${ce ? "on g" : ""}" aria-selected="${ce}">Bull ▲</button><button type="button" role="tab" data-mcx-plan="bear" class="${!ce ? "on r" : ""}" aria-selected="${!ce}">Bear ▼</button></div>
      ${p ? [kv("Buy", `${p.strike ?? "—"} ${ce ? "CE" : "PE"}`, ce ? "mcx-up" : "mcx-dn"), kv("Start", `${f0(p.entry)} ${ce ? "▲" : "▼"}`), kv("SL", f0(p.stop), "mcx-dn"), kv("T1", f0(p.t1), "mcx-up"), kv("T2", p.t2 != null ? f0(p.t2) : "—", "mcx-up"), kv("R:R", `1:${p.rr ?? "—"}`), kv("Entry", "retest")].join("") : `<span class="mcx-kv mcx-mu">${pc ? "no " + (ce ? "bull" : "bear") + " plan" : "loading plan…"}</span>`}</div>
      <p class="mcx-risk">${nt ? `No-trade zone <b>${f0(nt.from)} – ${f0(nt.to)}</b> · ` : ""}${realRisk ? `real risk up to ~${realRisk} pts (15-min-close stop) · ` : ""}not given if the premium is 10%+ above its trigger price, or in a fast market</p></section>`;
    set($("mcx-dec"), live + bias + plan);
  }

  // ------------------------------------------------------------ key-level ladder (the chart's levels + OI walls + plan starts)
  function renderLevels(d) {
    const sym = MC.sym, s = d.spot, lv = d.levels || {}, P = X.pc[sym]?.trader?.plans || {}, rows = [];
    const add = (p, label, why, kind) => { if (p != null && isFinite(p)) rows.push({ p: Number(p), label, why, kind }); };
    add(lv.strongResistance?.strike, "Strong R", `OI call wall ${amt(lv.strongResistance?.oi).replace("+", "")}`, "R");
    add(lv.weakResistance?.strike, "R", `OI call wall ${amt(lv.weakResistance?.oi).replace("+", "")}`, "R");
    add(lv.weakSupport?.strike, "S", `OI put wall ${amt(lv.weakSupport?.oi).replace("+", "")}`, "S");
    add(lv.strongSupport?.strike, "Strong S", `OI put wall ${amt(lv.strongSupport?.oi).replace("+", "")}`, "S");
    add(lv.pdh, "PDH", "previous day high", "R"); add(lv.pdl, "PDL", "previous day low", "S");
    if (s != null) add(lv.pdc, "PDC", "previous day close", lv.pdc > s ? "R" : "S");
    if (s != null) { add(lv.orbHigh, "First-15 H", "09:15–09:30 high", lv.orbHigh > s ? "R" : "S"); add(lv.orbLow, "First-15 L", "09:15–09:30 low", lv.orbLow > s ? "R" : "S"); }
    // owner S/R: turn clusters / flip zones of the previous 5 sessions — the 3 nearest above and below spot
    if (s != null && Array.isArray(lv.ownerLevels)) {
      const ow = lv.ownerLevels.filter((x) => x && isFinite(x.price)), srName = (k) => (k === "PA FLIP" ? "S/R flip" : k === "PA 3+ touches" ? "S/R 3+" : "S/R");
      const why = (x) => `${String(x.label || "").replace(/^PA /, "")} · price turned here in the last 5 sessions`;
      for (const x of ow.filter((x) => x.price > s).sort((a, b) => a.price - b.price).slice(0, 3)) add(x.price, srName(x.kind), why(x), "R");
      for (const x of ow.filter((x) => x.price <= s).sort((a, b) => b.price - a.price).slice(0, 3)) add(x.price, srName(x.kind), why(x), "S");
    }
    const fm = d.fakeMove15m?.level ?? d.fakeMove5m?.level, zh = typeof mcZoneHalf === "function" ? mcZoneHalf(sym) : 10;
    if (fm != null) rows.push({ p: fm, label: "Pullback", why: `${f0(fm - zh)} – ${f0(fm + zh)} (±${zh}) · chart`, kind: "R" });
    if (d.bos?.price != null) add(d.bos.price, `BOS ${d.bos.direction === "BULLISH" ? "▲" : "▼"}`, `${d.bos.stage || ""} · chart`, d.bos.direction === "BULLISH" ? "S" : "R");
    const ob = d.activeOB; if (ob?.low != null) rows.push({ p: (ob.low + ob.high) / 2, label: `${ob.side === "Bullish" ? "Bull" : "Bear"} OB`, why: `${f0(ob.low)} – ${f0(ob.high)} · ${ob.status || ""}`, kind: ob.side === "Bullish" ? "S" : "R", range: `${f0(ob.low)}–${f0(ob.high)}` });
    const vw = d.overlays?.vwap?.length ? d.overlays.vwap[d.overlays.vwap.length - 1] : null; add(vw, "VWAP", "chart", "S");
    if (P.bull) add(P.bull.entry, "Bull start", `15-min close above → ${P.bull.strike ?? ""} CE`, "P");
    if (P.bear) add(P.bear.entry, "Bear start", `15-min close below → ${P.bear.strike ?? ""} PE`, "P");
    if (s != null) rows.push({ p: s, label: "Spot", why: d.historical ? "replay" : "", kind: "N" });
    rows.sort((a, b) => b.p - a.p);
    // 5-minute candle reaction at each level — information only (levelReaction.js)
    const LR = window.LevelReaction, c5 = MC.tf === "5m" ? d.candles : X.c5[sym], lc = LR && c5 ? LR.lastClosed(c5, Date.now() / 1000, !!d.historical) : null;
    const a5 = lc ? LR.atr14(c5.slice(0, lc.index + 1).slice(-15)) : null, rx = [];
    if (lc) for (const x of rows) if (x.kind !== "N" && !x.range) { const r = LR.react(lc.candle, x.p, LR.tolOf(x.p, a5)); if (r.code !== "NONE") { x.rx = r; rx.push(x); } }
    const ct = lc ? lc.candle : null, ctxt = ct ? `${hm(ct.time)} candle O ${f0(ct.open)} H ${f0(ct.high)} L ${f0(ct.low)} C ${f0(ct.close)}` : "";
    const rxTip = (x) => `Last closed 5-min ${ctxt}. ${f0(x.p)} acted as ${x.rx.role}: ${LR.LABEL[x.rx.code].text}${x.rx.wickPct != null ? ` · wick ${Math.round(x.rx.wickPct * 100)}% of the candle` : ""}. Information only — in a 2-year test a rejection candle at a level was right about as often as a random entry (no edge).`;
    const col = { R: "#F23645", S: "#089981", P: "#f5c542", N: "#4ea1ff" };
    const tabs = [["levels", "Levels"], ["plan", "Plan"], ["notes", "Notes"]].map(([k, l]) => `<button type="button" role="tab" data-mcx-tab="${k}" class="${X.tab === k ? "on" : ""}" aria-selected="${X.tab === k}">${l}</button>`).join("");
    let body = "";
    if (X.tab === "levels") body = rows.map((x) => { const dd = x.kind === "N" ? null : x.p - s; return `<div class="mcx-lv${x.kind === "N" ? " spot" : ""}" title="${esc(x.why)}"><span class="bar" style="background:${col[x.kind]}"></span><span class="nm"><span class="nmt">${esc(x.label)} <small>${x.why ? "· " + esc(x.why) : ""}</small></span>${x.rx ? `<span class="rj ${LR.LABEL[x.rx.code].cls}" title="${esc(rxTip(x))}">${LR.LABEL[x.rx.code].short.replace("5m ", "")}</span>` : ""}</span><span class="px${x.range ? " rg" : ""}">${x.range || f0(x.p)}</span><span class="ds" style="color:${dd == null ? "#8ab8ff" : dd > 0 ? "#ff6b72" : "#26c6a6"}">${dd == null ? "SPOT" : sg(dd)}</span></div>`; }).join("") + (ct ? `<p class="mcx-rjnote" title="Rejection = wick into the level ≥ 40% of the candle and a close back on the level's side; break = a close beyond it. Information, not a signal.">5m ${esc(hm(ct.time))}: ${rx.length ? rx.map((x) => `${esc(LR.LABEL[x.rx.code].short.replace("5m ", ""))} ${esc(x.label)} ${f0(x.p)}`).join(" · ") : "no level reached"} · <i>info, not a signal</i></p>` : "");
    else if (X.tab === "plan") body = `<p class="mcx-note" style="font-size:12px;color:#c9d0da">A trade exists only after a 15-min candle CLOSES beyond a start, then a 5-min retest — no chasing, no new trade in a fast market.</p>${P.bull ? `<p class="mcx-note" style="padding:6px 8px;margin-top:6px;background:#0c2420;border:1px solid #136e5c;border-radius:6px;color:#e7ebf0">Bull: 15-min close above <b>${f0(P.bull.entry)}</b> → buy ${P.bull.strike} CE · SL ${f0(P.bull.stop)} · T1 ${f0(P.bull.t1)}</p>` : ""}${P.bear ? `<p class="mcx-note" style="padding:6px 8px;margin-top:4px;background:#2a1215;border:1px solid #7a2a31;border-radius:6px;color:#e7ebf0">Bear: 15-min close below <b>${f0(P.bear.entry)}</b> → buy ${P.bear.strike} PE · SL ${f0(P.bear.stop)} · T1 ${f0(P.bear.t1)}</p>` : ""}`;
    else body = `<ul class="mcx-note" style="padding-left:16px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:#c9d0da"><li>Data age ${d.dataAgeSec != null ? Math.round(d.dataAgeSec) + " s" : "—"}${d.dataStale ? " · STALE" : ""}${d.historical ? " · REPLAY" : ""}.</li><li>PCR shown is the whole chain (${d.oi?.pcr ?? "—"}); the OI screen's near-the-money PCR is a different basis.</li><li>OI walls are positioning, not a forecast (2-year study).</li></ul>`;
    set($("mcx-levels"), `<div class="mcx-row" style="margin-bottom:6px"><h2 class="mcx-h">Key Levels &amp; Trade Plan</h2><div class="mcx-seg" role="tablist" style="margin-left:auto">${tabs}</div></div>${body}`);
  }

  // ------------------------------------------------------------ option terminal (CE / PE premium charts)
  function otChart(host) {
    const ch = LightweightCharts.createChart(host, { autoSize: true, layout: { background: { color: "#0b0e14" }, textColor: "#9aa3b0", fontSize: 11 }, grid: { vertLines: { color: "#141a23" }, horzLines: { color: "#141a23" } },
      rightPriceScale: { borderColor: "#1e2530" }, timeScale: { borderColor: "#1e2530", timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 } });
    const c = ch.addCandlestickSeries({ upColor: "#089981", downColor: "#F23645", wickUpColor: "#089981", wickDownColor: "#F23645", borderVisible: false });
    const e9 = ch.addLineSeries({ color: "#4ea1ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const e21 = ch.addLineSeries({ color: "#f5c542", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    return { ch, c, e9, e21, lines: [] };
  }
  const emaArr = (xs, n) => { const k = 2 / (n + 1); let v = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };
  function otShell() {
    const ot = X.ot, sym = MC.sym, step = STEP[sym] || 50, atm = ot.replay ? ot.rinfo?.atm ?? null : MC.lastData?.optionChain?.atmStrike;
    const chips = [-2, -1, 0, 1, 2].map((o) => { const k = atm != null ? atm + o * step : null; return `<button type="button" role="tab" data-mcx-strike="${k}" class="${k === ot.strike ? "on" : ""}" aria-selected="${k === ot.strike}" title="${k ?? ""} · ${o === 0 ? "at the money" : o > 0 ? "CE OTM · PE ITM" : "CE ITM · PE OTM"}" ${k == null ? "disabled" : ""}>${o === 0 ? "ATM" : (o > 0 ? "+" : "−") + Math.abs(o)}</button>`; }).join("");
    const exps = ot.replay ? `<span class="mcx-chip mcx-rp" title="${esc(ot.rinfo?.available ? `${ot.rinfo.source}${ot.rinfo.prevJoined ? ` · EMAs warmed with ${ot.rinfo.prevJoined}` : ""}${ot.rinfo.prevSkipped ? ` · previous session ${ot.rinfo.prevSkipped} not joined` : ""} · strikes recorded that day: ${(ot.rinfo.strikes || []).join(", ")}` : ot.rinfo?.message || "loading the session's premiums…")}">↺ Replay ${esc(new Date(ot.replay + "T00:00:00Z").toUTCString().slice(5, 11))} · ${ot.rinfo?.available ? esc(ot.rinfo.index) + " nearest expiry" : ot.rinfo ? "no data" : "loading…"}</span>` : (ot.expiries.length ? ot.expiries : [ot.expiry].filter(Boolean)).slice(0, 4).map((e) => `<button type="button" role="tab" data-mcx-exp="${e}" class="${e === ot.expiry ? "on" : ""}" aria-selected="${e === ot.expiry}">${new Date(e + "T00:00:00Z").toUTCString().slice(5, 11)}</button>`).join("");
    const sides = [["ce", "CE", "g"], ["pe", "PE", "r"], ["both", "Both", ""]].map(([k, l, c]) => `<button type="button" data-mcx-side="${k}" class="${ot.side === k ? "on " + c : ""}" aria-pressed="${ot.side === k}">${l}</button>`).join("");
    const tfs = `<span class="mcx-chip" title="CE / PE follow the main chart's timeframe">${ot.tf === "D" ? "1D" : ot.tf === 60 ? "1h" : ot.tf + "m"} · synced</span>`;
    const o = ot.strike != null && atm != null ? (ot.strike - atm) / step : 0;
    const money = ot.replay ? `${o === 0 ? "At the money" : o > 0 ? `CE ${o} OTM · PE ${o} ITM` : `CE ${-o} ITM · PE ${-o} OTM`} at the ${esc(ot.replay)} close` : o === 0 ? `At the money · spot ${f0(MC.lastData?.spot)}` : `${o > 0 ? `CE ${o} OTM · PE ${o} ITM` : `CE ${-o} ITM · PE ${-o} OTM`} · ${Math.abs(ot.strike - (MC.lastData?.spot || 0)).toFixed(0)} pts from spot`;
    const card = (side) => `<div class="mcx-opt" data-side="${side}" ${ot.side !== "both" && ot.side !== side.toLowerCase() ? "hidden" : ""}><div class="mcx-opt-hd" id="mcx-ot-hd-${side}">—</div><div class="mcx-opt-chart" id="mcx-ot-ch-${side}"></div><p class="mcx-note" id="mcx-ot-nt-${side}" hidden></p></div>`;
    const html = `<div class="mcx-row"><h2 class="mcx-h" title="Pullback zone = the premium's break level (BIOS) ± the main chart's zone (±${typeof mcZoneHalf === "function" ? mcZoneHalf(sym) : 10} pts) × Δ · candles after 15:30 are dropped">Options</h2><div class="mcx-seg" role="tablist" aria-label="Expiry">${exps}</div><div class="mcx-seg" role="group" aria-label="Calls, puts or both" style="margin-left:auto">${sides}</div></div>
      <div class="mcx-otf" role="group" aria-label="Option filters"><div class="mcx-step" title="${esc(money)}"><button type="button" data-mcx-step="-1" aria-label="Lower strike">−</button><span>${ot.strike ?? "—"}</span><button type="button" data-mcx-step="1" aria-label="Higher strike">+</button></div>
      <div class="mcx-seg" role="tablist" aria-label="Strike from ATM">${chips}</div><span style="margin-left:auto">${tfs}</span></div>
      <div class="mcx-otc">${card("CE")}${card("PE")}</div>`;
    const host = $("mcx-ot"); if (!host) return;
    if (host.__mcx !== html) {   // filters changed → rebuild the shell and re-attach the charts (data is kept)
      host.innerHTML = html; host.__mcx = html;
      for (const side of ["CE", "PE"]) { const n = $(`mcx-ot-ch-${side}`); if (n && typeof LightweightCharts !== "undefined") { X.ot.charts[side]?.ch?.remove?.(); X.ot.charts[side] = otChart(n); X.ot.charts[side].ch.applyOptions({ timeScale: { timeVisible: MC.tf !== "1d" } }); } }
      drawOt();
    }
  }
  async function loadOt() {
    const ot = X.ot, sym = MC.sym, d = MC.lastData; if (!d) return;
    ot.tf = ({ "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": "D" })[MC.tf] || 5;   // one timing for all three charts
    const rd = MC.replayDate || null;
    if (ot.sym !== sym || ot.replay !== rd) { ot.sym = sym; ot.replay = rd; ot.rinfo = null; ot.strike = null; ot.expiry = null; ot.expiries = []; ot.data = {}; }
    if (rd) {   // ↺ Replay date → that session's real premiums (Dhan rolling option, ATM±3), never live candles
      ot.expiry = `R:${rd}`;
      const key = `${sym}|${ot.strike}|${ot.expiry}|${ot.tf}`; if (ot.strike != null && ot.data[key]) { otShell(); drawOt(); return; }
      otShell();
      const r = await get(`/api/replay-premium?symbol=${encodeURIComponent(sym)}&date=${rd}&interval=${ot.tf}${ot.strike != null ? `&strike=${ot.strike}` : ""}`, 120000);
      if (MC.replayDate !== rd || MC.sym !== sym) return;   // the date / index changed while loading
      ot.rinfo = r || { available: false, message: "replay premiums not loaded" };
      if (r?.available) { if (ot.strike == null) ot.strike = r.strike; ot.data[`${sym}|${ot.strike}|${ot.expiry}|${ot.tf}`] = { ce: r.ce, pe: r.pe, st: r.st, at: Date.now() }; }
      otShell(); drawOt(); return;
    }
    if (ot.strike == null) ot.strike = d.optionChain?.atmStrike ?? null;
    if (!ot.expiry) ot.expiry = d.oi?.expiry || null;
    if (!ot.expiries.length) { const c = await get(`/api/oi-chain?symbol=${encodeURIComponent(sym)}`); if (c?.expiries) ot.expiries = c.expiries; }
    otShell();
    if (ot.strike == null || !ot.expiry) return;
    const key = `${sym}|${ot.strike}|${ot.expiry}|${ot.tf}`, enc = encodeURIComponent(sym);
    const [ce, pe, st] = await Promise.all([
      get(`/api/option-candles?symbol=${enc}&type=CE&strike=${ot.strike}&expiry=${ot.expiry}&interval=${ot.tf}`, 30000),
      get(`/api/option-candles?symbol=${enc}&type=PE&strike=${ot.strike}&expiry=${ot.expiry}&interval=${ot.tf}`, 30000),
      get(`/api/option-structure?symbol=${enc}&strike=${ot.strike}&expiry=${ot.expiry}&interval=${ot.tf}`, 30000)]);
    const prev = ot.data[key] || {};
    ot.data[key] = { ce: ce?.candles?.length ? ce : prev.ce, pe: pe?.candles?.length ? pe : prev.pe, st: st?.ce || st?.pe ? st : prev.st, at: Date.now() };   // keep the last good on a failed refresh
    drawOt();
  }
  function drawOt() {
    const ot = X.ot, key = `${MC.sym}|${ot.strike}|${ot.expiry}|${ot.tf}`, D = ot.data[key];
    if (!D) { if (ot.replay && ot.rinfo && !ot.rinfo.available) for (const side of ["CE", "PE"]) { const hd = $(`mcx-ot-hd-${side}`); if (hd) hd.innerHTML = `<b>↺ ${esc(ot.replay)} ${side}</b> <span class="mcx-mu">— ${esc(ot.rinfo.message || "no premium data")}</span>`; } return; }
    const wrow = X.walls[MC.sym]?.rows?.find((r) => r.strike === ot.strike), zh = typeof mcZoneHalf === "function" ? mcZoneHalf(MC.sym) : 10;
    for (const side of ["CE", "PE"]) {
      const C = ot.charts[side], src = side === "CE" ? D.ce : D.pe, S = D.st?.[side.toLowerCase()];
      const hd = $(`mcx-ot-hd-${side}`), nt = $(`mcx-ot-nt-${side}`);
      if (!C || !src?.candles?.length) { if (hd) hd.innerHTML = `<b>${esc(MC.lastData?.name || "")} ${ot.strike} ${side}</b> <span class="mcx-mu">— no premium candles (${esc(src?.message || "loading")})</span>`; continue; }
      const cs = src.candles.filter((c) => { if (ot.tf === "D") return true; const m = Math.floor(((c.time + IST) % 86400) / 60); return m >= 555 && m < 930; }).map((c) => ({ time: c.time + IST, open: c.open, high: c.high, low: c.low, close: c.close }));
      if (!cs.length) continue;
      C.c.setData(cs);
      const cl = cs.map((c) => c.close), e9 = emaArr(cl, 9), e21 = emaArr(cl, 21);
      C.e9.setData(cs.map((c, i) => ({ time: c.time, value: e9[i] }))); C.e21.setData(cs.map((c, i) => ({ time: c.time, value: e21[i] })));
      const tr = cs.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - cs[i].close), Math.abs(c.low - cs[i].close))).slice(-14), atr = tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
      const delta = Math.abs((side === "CE" ? wrow?.ceDelta : wrow?.peDelta) ?? 0.5), half = Math.max(0.5, Math.round(zh * delta * 10) / 10);
      for (const l of C.lines) C.c.removePriceLine(l); C.lines = [];
      const pl = (price, color, title, style) => { if (price != null && isFinite(price)) C.lines.push(C.c.createPriceLine({ price, color, lineWidth: 1, lineStyle: style ?? 2, axisLabelVisible: true, title })); };
      if (S?.available !== false && S) { pl(S.r2, "#F23645", "R2"); pl(S.r1, "#F23645", "R1"); pl(S.s1, "#089981", "S1"); pl(S.s2, "#089981", "S2"); }
      const bios = S?.bios?.price;
      if (bios != null) { pl(bios + half, "rgba(239,68,68,.85)", "PB zone", 0); pl(bios - half, "rgba(239,68,68,.85)", "", 0); }
      const ltp = cl[cl.length - 1];
      // one compact line per chart (the full detail is on hover) so CE and PE fit beside the main chart
      const tip = `structure ${S?.structure || "—"}${bios != null ? ` · BIOS ${S.bios.direction === "BULLISH" ? "▲" : "▼"} ${f2(bios)} · pullback zone ${f2(bios - half)} – ${f2(bios + half)} (±${half})` : " · no break in option structure yet"} · EMA9 ${f2(e9[e9.length - 1])} · EMA21 ${f2(e21[e21.length - 1])} · ATR(14) ₹${atr != null ? atr.toFixed(1) : "—"} · Δ≈${delta.toFixed(2)} → ${zh} index pts ≈ ₹${(zh * delta).toFixed(1)}`;
      if (hd) { hd.title = tip; hd.innerHTML = `<b>${ot.strike} ${side}</b> <b style="font-family:'JetBrains Mono',monospace;font-size:13px;color:${side === "CE" ? "#26c6a6" : "#ff6b72"}">₹${f2(ltp)}</b> <span class="mcx-mu" style="font-family:'JetBrains Mono',monospace;font-size:10.5px">${S?.structure ? esc(S.structure) + " · " : ""}<span style="color:#4ea1ff">E9 ${f2(e9[e9.length - 1])}</span> · <span style="color:#f5c542">E21 ${f2(e21[e21.length - 1])}</span> · ATR ${atr != null ? atr.toFixed(1) : "—"} · Δ ${delta.toFixed(2)}</span>`; }
      if (nt) nt.textContent = "";
    }
  }

  // ------------------------------------------------------------ 🧱 Wall Builder (OI Analysis · 1-Min OI Monitor)
  const TONE = { CW: "255,107,114", PW: "63,185,120", B: "78,161,255", SC: "245,197,66", U: "125,134,147", N: "138,184,255", G: "168,85,247" };
  const LBL = { W: "WRITE", B: "BUY", SC: "COVER", U: "UNWIND", "-": "FLAT" };
  const box = (v, t, tone, s, extra) => { const a = 0.1 + 0.55 * Math.max(0, Math.min(1, s || 0)); return `<div class="wb-box" style="--t:${TONE[tone] || TONE.U};--a:${a.toFixed(2)};--b:${(0.18 + 0.4 * (s || 0)).toFixed(2)};${extra || ""}"><b>${esc(v)}</b>${t ? `<i>${esc(t)}</i>` : ""}</div>`; };
  const dark = (v, t, extra) => `<div class="wb-box wb-dark" style="${extra || ""}"><b style="font-size:13px">${esc(v)}</b>${t ? `<i>${esc(t)}</i>` : ""}</div>`;
  async function wallLoad() {
    const sym = (typeof OIA !== "undefined" && OIA.sym) || MC?.sym || "^NSEI", host = $("oia-wallbuilder"); if (!host || host.hidden) return;
    const d = await get(`/api/oi-walls?symbol=${encodeURIComponent(sym)}`);
    if (d && (d.available || !X.wb.data || X.wb.sym !== sym)) { X.wb.data = d; X.wb.sym = sym; }
    wallRender();
  }
  function wallRender() {
    const host = $("oia-wallbuilder"), d = X.wb.data; if (!host) return;
    if (!d || !d.available) { set(host, `<div class="mcx-row"><h3 class="mcx-h" style="font-size:12px;color:#e7ebf0">🧱 Wall Builder</h3><span class="mcx-mu">${esc(d?.message || d?.error || "loading…")}</span></div>`); return; }
    const W = X.wb.win, wi = ["1", "5", "15"].indexOf(W), rows = d.rows.slice().reverse();
    const mx = (f) => Math.max(1, ...d.rows.map((r) => Math.abs(f(r) || 0)));
    const cMax = { 1: mx((r) => r.w["1"].c), 5: mx((r) => r.w["5"].c), 15: mx((r) => r.w["15"].c) }, pMax = { 1: mx((r) => r.w["1"].p), 5: mx((r) => r.w["5"].p), 15: mx((r) => r.w["15"].p) };
    const dMaxC = mx((r) => r.dayC), dMaxP = mx((r) => r.dayP), rMax = mx((r) => r.read.net);
    const chg = (v, t, max, put) => (v == null ? box("—", "", "U", 0) : box(amt(v), LBL[t] || "", t === "W" ? (put ? "PW" : "CW") : t === "-" ? "U" : t, Math.abs(v) / max));
    const GAP = "margin-left:6px";
    const head = `<div class="wb-grid wb-cols" style="font-size:10.5px;font-weight:700;letter-spacing:.6px"><span class="wb-hg" style="grid-column:span 3;color:#ff8a8f;border-color:#ff8a8f55">CALL OI CHANGE · resistance</span><span class="wb-hg" style="color:#9aa3b0;border-color:#9aa3b055;${GAP};margin-right:6px">STRIKE</span><span class="wb-hg" style="grid-column:span 3;color:#3fb978;border-color:#3fb97855">PUT OI CHANGE · support</span><span class="wb-hg" style="color:#f5c542;border-color:#f5c54255">OI READ · 5 + 15 min</span><span class="wb-hg" style="grid-column:span 4;color:#8ab8ff;border-color:#8ab8ff55;${GAP}">WRITTEN TODAY · GREEKS</span></div>
      <div class="wb-grid wb-cols" style="font-size:10.5px;color:#9aa3b0;text-align:center">${["15 min", "5 min", "1 min"].map((l, i) => `<span style="${2 - i === wi ? "color:#fff;font-weight:700" : ""}">${l}</span>`).join("")}<span style="${GAP};margin-right:6px">C · P OI</span>${["1 min", "5 min", "15 min"].map((l, i) => `<span style="${i === wi ? "color:#fff;font-weight:700" : ""}">${l}</span>`).join("")}<span>positioning</span><span style="${GAP}">Call</span><span>Put</span><span>Δ</span><span>Γ</span></div>`;
    let lines = "";
    rows.forEach((r, i) => {
      const cells = [["15", 2], ["5", 1], ["1", 0]].map(([k]) => chg(r.w[k].c, r.w[k].ct, cMax[k], false)).join("") + dark(f0(r.strike), `C ${amt(r.ceOi).replace("+", "")} · P ${amt(r.peOi).replace("+", "")}`, `${GAP};margin-right:6px`)
        + ["1", "5", "15"].map((k) => chg(r.w[k].p, r.w[k].pt, pMax[k], true)).join("")
        + box(r.read.side === "UP" ? "▲ PUSH UP" : r.read.side === "DN" ? "▼ PUSH DOWN" : "• NEUTRAL", r.read.why, r.read.side === "UP" ? "PW" : r.read.side === "DN" ? "CW" : "U", Math.abs(r.read.net) / rMax, "align-items:flex-start;padding-left:8px")
        + (r.dayC == null ? box("—", "NOT LISTED", "U", 0, GAP) : box(amt(r.dayC), r.dayC >= 0 ? "CALL ADDED" : "CALL CUT", r.dayC >= 0 ? "CW" : "U", Math.abs(r.dayC) / dMaxC, GAP))
        + (r.dayP == null ? box("—", "NOT LISTED", "U", 0) : box(amt(r.dayP), r.dayP >= 0 ? "PUT ADDED" : "PUT CUT", r.dayP >= 0 ? "PW" : "U", Math.abs(r.dayP) / dMaxP))
        + box(`${r.ceDelta != null ? r.ceDelta.toFixed(2) : "—"} / ${r.peDelta != null ? r.peDelta.toFixed(2) : "—"}`, "Δ CE / PE", "N", 0.05)
        + box(r.gamma != null ? r.gamma.toFixed(4) : "—", r.gamma != null && r.gamma === d.maxGamma ? "MAX Γ" : "Γ", "G", r.gamma && d.maxGamma ? (r.gamma / d.maxGamma) * 0.7 : 0);
      lines += `<div class="wb-grid wb-cols">${cells}</div>`;
      const nx = rows[i + 1];
      if (nx && r.strike > d.spot && nx.strike <= d.spot) lines += `<div class="wb-spot"><span>${esc(d.index)} ${f2(d.spot)}</span></div>`;
    });
    const T = d.totals[W];
    const tot = (k, side) => d.rows.reduce((a, r) => a + (r.w[k][side] || 0), 0);
    const foot = ["15", "5", "1"].map((k) => { const v = tot(k, "c"); return box(amt(v), "CALL NET", v >= 0 ? "CW" : "U", 0.45); }).join("")
      + dark("TOTAL", `Σ ${amt(d.rows.reduce((a, r) => a + (r.ceOi || 0) + (r.peOi || 0), 0)).replace("+", "")}`, `${GAP};margin-right:6px;border-color:#3b78d6`)
      + ["1", "5", "15"].map((k) => { const v = tot(k, "p"); return box(amt(v), "PUT NET", v >= 0 ? "PW" : "U", 0.45); }).join("")
      + box(d.positioning.lean === "BULLISH" ? "▲ BULLISH" : d.positioning.lean === "BEARISH" ? "▼ BEARISH" : "• NEUTRAL", "WRITERS LEAN", d.positioning.lean === "BULLISH" ? "PW" : d.positioning.lean === "BEARISH" ? "CW" : "U", 0.45, "align-items:flex-start;padding-left:8px")
      + box(amt(d.dayTotals.calls), "CALLS TODAY", "CW", 0.45, GAP) + box(amt(d.dayTotals.puts), "PUTS TODAY", "PW", 0.45) + box("", "", "N", 0) + box("", "", "G", 0);
    const mrow = (label, sel, cells) => `<div class="wb-mrow"><span class="wb-mlab${sel ? " on" : ""}">${label}</span>${cells}</div>`;
    const matrix = `<div class="wb-mrow wb-mhead"><span></span><span>Call added</span><span>Call removed</span><span>Call net</span><span></span><span>Put added</span><span>Put removed</span><span>Put net</span><span></span><span>C + P net</span></div>`
      + ["1", "5", "15"].map((k) => { const t = d.totals[k], all = Math.max(1, t.callAdded, -t.callRemoved, t.putAdded, -t.putRemoved), cn = t.callAdded + t.callRemoved, pn = t.putAdded + t.putRemoved;
        return mrow(`${k} min`, k === W, box(amt(t.callAdded), "ADDED", "CW", t.callAdded / all) + box(amt(t.callRemoved), "REMOVED", "U", -t.callRemoved / all) + box(amt(cn), cn >= 0 ? "NET ADD" : "NET CUT", cn >= 0 ? "CW" : "U", Math.abs(cn) / all) + "<span></span>"
          + box(amt(t.putAdded), "ADDED", "PW", t.putAdded / all) + box(amt(t.putRemoved), "REMOVED", "U", -t.putRemoved / all) + box(amt(pn), pn >= 0 ? "NET ADD" : "NET CUT", pn >= 0 ? "PW" : "U", Math.abs(pn) / all) + "<span></span>" + box(amt(cn + pn), "C + P", "N", Math.abs(cn + pn) / all)); }).join("");
    const P = d.positioning, sc = d.standing;
    const moves = ["1", "5", "15"].map((k) => { const w = d.windows[k]; return w.spotFrom != null ? `<span style="${k === W ? "color:#fff;font-weight:700" : "color:#9aa3b0"}">${esc(d.index)} ${k} min: ${f0(w.spotFrom)} → ${f0(d.spot)} (${sg(d.spot - w.spotFrom)})${w.minutes != null && String(w.minutes) !== k ? ` · ${w.minutes} min actual` : ""}</span>` : `<span class="mcx-mu">${k} min: not enough minutes yet</span>`; }).join("");
    const tabs = ["1", "5", "15"].map((k) => `<button type="button" role="tab" data-wb-win="${k}" class="${k === W ? "on" : ""}" aria-selected="${k === W}">${k} min</button>`).join("");
    set(host, `<div class="mcx-row"><h3 class="mcx-h" style="font-size:12px;color:#e7ebf0">🧱 Wall Builder <span class="mcx-mu" style="text-transform:none;letter-spacing:0;font-weight:500">— who is writing, where · ${esc(d.day)} ${esc(d.minute)}</span></h3><div class="mcx-seg" role="tablist" aria-label="Window" style="margin-left:auto">${tabs}</div></div>
      <div class="mcx-row" style="font-family:'JetBrains Mono',monospace;font-size:11.5px;gap:4px 14px">${moves}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:stretch">
        <section class="wb-panel" style="flex:3 1 560px;overflow-x:auto" aria-label="Writers by window"><h4 class="mcx-h" style="margin-bottom:6px">Writers · added / removed</h4><div style="min-width:540px;display:flex;flex-direction:column;gap:4px">${matrix}</div></section>
        <section class="wb-panel" style="flex:2 1 320px;display:flex;flex-direction:column;gap:5px" aria-label="Where the walls are"><h4 class="mcx-h">Where the walls are · 5 + 15 min positioning</h4>
          <span style="font-size:15px;font-weight:700;color:${P.lean === "BEARISH" ? "#ff8a8f" : P.lean === "BULLISH" ? "#3fb978" : "#f5c542"}">Writers lean ${esc(P.lean.toLowerCase())} — ${P.callWall != null ? "call wall " + f0(P.callWall) : "no call wall"} · ${P.putWall != null ? "put wall " + f0(P.putWall) : "no put wall being written"}</span>
          <span class="mcx-line" style="white-space:normal"><b style="color:#ff8a8f">Standing</b> call ${sc.call.map((x) => `${f0(x.strike)} (${amt(x.oi).replace("+", "")})`).join(", ")} · <b style="color:#3fb978">put</b> ${sc.put.map((x) => `${f0(x.strike)} (${amt(x.oi).replace("+", "")})`).join(", ")}</span>
          <span class="mcx-line" style="white-space:normal"><b style="color:#f5c542">Watch</b> ${esc(P.watch)}</span>
          <span class="mcx-note" style="margin-top:auto">${esc(P.note)}</span></section>
      </div>
      <div style="overflow-x:auto"><div style="min-width:1120px;display:flex;flex-direction:column;gap:4px">${head}${lines}<div class="wb-grid wb-cols" style="margin-top:4px;padding-top:6px;border-top:1px solid #2a3443">${foot}</div></div></div>
      <div class="mcx-row wb-legend"><span><i style="background:rgba(255,107,114,.6)"></i>Call WRITE · OI ↑ prem ↓</span><span><i style="background:rgba(63,185,120,.6)"></i>Put WRITE</span><span><i style="background:rgba(78,161,255,.5)"></i>BUY · OI ↑ prem ↑</span><span><i style="background:rgba(245,197,66,.5)"></i>COVER · OI ↓ prem ↑</span><span><i style="background:rgba(125,134,147,.45)"></i>UNWIND · OI ↓ prem ↓</span><span class="mcx-mu">Stronger tint = bigger change · Γ from the logged IV</span></div>`);
  }

  // ------------------------------------------------------------ OI Analysis inside Market Command (the same screen, moved)
  function mountOia() {
    const host = $("mcx-oi-host"), wrap = document.querySelector(".oia-wrap"); if (!host || !wrap) return;
    if (!host.contains(wrap)) host.appendChild(wrap);
    if (typeof initOiAnalysis === "function") { initOiAnalysis(); if (typeof OIA !== "undefined" && MC?.sym) OIA.sym = MC.sym; if (typeof syncOIAFromMC === "function") syncOIAFromMC(true); if (typeof startOiAnalysisLive === "function") startOiAnalysisLive(); }
  }
  function restoreOia() {
    const panel = $("panel-oianalysis"), wrap = document.querySelector(".oia-wrap");
    if (panel && wrap && !panel.contains(wrap)) panel.appendChild(wrap);
  }
  function setView(v) {
    X.view = v;
    document.body.classList.toggle("mcx-oi", v === "oi");
    document.querySelectorAll("[data-mcx-view]").forEach((b) => { const on = b.getAttribute("data-mcx-view") === v; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    const host = $("mcx-oi-host"); if (host) host.hidden = v !== "oi";
    if (v === "oi") mountOia(); else { restoreOia(); setTimeout(fitFrame, 50); }
  }

  // ------------------------------------------------------------ one frame: main chart · CE / PE · key levels in the window height
  function fitFrame() {
    const main = document.querySelector("#panel-marketcommand .mc2-main"), wrap = document.querySelector("#panel-marketcommand .mc-wrap");
    if (!main || !wrap || !mcOn() || X.view !== "mc") return;
    if (window.innerWidth <= 900) { if (main.style.height) { main.style.height = ""; try { mcFitPanes(); } catch {} } return; }
    const top = main.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop + wrap.getBoundingClientRect().top;
    const h = Math.max(460, Math.floor(window.innerHeight - top - 6)) + "px";
    if (main.style.height !== h) { main.style.height = h; try { mcFitPanes(); } catch {} }
  }
  window.addEventListener("resize", () => { clearTimeout(X._fit); X._fit = setTimeout(fitFrame, 120); });
  // the chart's level tags live in the empty space right of the latest candle (rightOffset bars). With thinner
  // candles 25 bars became narrower than the tags (~270 px), so the tags covered the candles: keep that space at
  // least TAG_PX wide whatever the bar spacing. Display only — the chart's data, overlays and logic are untouched.
  const TAG_PX = 280;
  function fitTagSpace() {
    if (typeof MC === "undefined" || !MC.chart) return;
    const ts = MC.chart.timeScale(), bs = ts.options().barSpacing || 12;
    const ro = Math.max(window.innerWidth <= 600 ? 10 : 25, Math.ceil((window.innerWidth <= 600 ? 120 : TAG_PX) / bs));
    if (X._ro !== ro) { X._ro = ro; ts.applyOptions({ rightOffset: ro }); }
  }
  // 1D: every time axis shows dates instead of "00:00" (display only)
  const dayLabel = (t) => new Date((typeof t === "number" ? t : 0) * 1000).toUTCString().slice(5, 11);
  function syncAxisLabels() {
    if (typeof MC === "undefined" || !MC.chart || X._axisTf === MC.tf) return;
    X._axisTf = MC.tf; const daily = MC.tf === "1d";
    try { MC.chart.applyOptions({ timeScale: { timeVisible: !daily, tickMarkFormatter: daily ? (t) => dayLabel(t + IST) : (t) => fmtIST(t, false) } }); } catch { /* the main chart keeps its own formatter */ }
    for (const C of Object.values(X.ot.charts)) try { C.ch.applyOptions({ timeScale: { timeVisible: !daily } }); } catch { /* ignore */ }
  }
  setInterval(syncAxisLabels, 1000);
  setInterval(() => {
    if (typeof MC === "undefined" || !MC.chart || X._roHooked) return;
    X._roHooked = true;
    MC.chart.timeScale().subscribeVisibleLogicalRangeChange(() => { clearTimeout(X._roT); X._roT = setTimeout(fitTagSpace, 200); });
    fitTagSpace();
  }, 1000);

  // ------------------------------------------------------------ wiring
  function renderAll() {
    const d = typeof MC !== "undefined" ? MC.lastData : null; if (!d) return;
    try { renderTape(d); } catch (e) { console.warn("[mcx] tape", e); }
    try { renderDecision(d); } catch (e) { console.warn("[mcx] decision", e); }
    try { renderLevels(d); } catch (e) { console.warn("[mcx] levels", e); }
    try { otShell(); } catch (e) { console.warn("[mcx] option terminal", e); }
    try { fitFrame(); } catch (e) { console.warn("[mcx] frame", e); }
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.mcxView) setView(t.dataset.mcxView);
    else if (t.dataset.mcxPlan) { X.plan = t.dataset.mcxPlan; renderAll(); }
    else if (t.dataset.mcxTab) { X.tab = t.dataset.mcxTab; renderAll(); }
    else if (t.dataset.mcxSide) { X.ot.side = t.dataset.mcxSide; otShell(); }
    else if (t.dataset.mcxExp) { X.ot.expiry = t.dataset.mcxExp; otShell(); loadOt(); }
    else if (t.dataset.mcxStrike && t.dataset.mcxStrike !== "null") { X.ot.strike = Number(t.dataset.mcxStrike); otShell(); loadOt(); }
    else if (t.dataset.mcxStep) { const st = STEP[MC.sym] || 50; if (X.ot.strike != null) { X.ot.strike += Number(t.dataset.mcxStep) * st; otShell(); loadOt(); } }
    else if (t.dataset.wbWin) { X.wb.win = t.dataset.wbWin; wallRender(); }
  });
  // MC.lastData changes on every Market Command refresh → re-render from it (cheap); the slower sources refresh on their own clocks
  setInterval(() => {
    if (typeof MC === "undefined" || !MC.lastData) return;
    if (MC.lastData !== X.seen) { const first = !X.seen, symChanged = X.seen && X.seen.symbol !== MC.lastData.symbol; X.seen = MC.lastData; renderAll(); if ((first || symChanged) && mcOn()) refreshSlow(true); if (X.view === "mc" && mcOn()) loadOt(); }
  }, 1500);
  setInterval(() => { if (mcOn()) refreshSlow(false); if ($("oia-wallbuilder") && !$("oia-wallbuilder").hidden && (mcOn() || $("panel-oianalysis")?.classList.contains("active"))) wallLoad(); }, 30000);
  setInterval(() => { if (mcOn() && X.view === "mc") loadOt(); }, 60000);
  window.mcxRestoreOia = () => { if (X.view === "oi") setView("mc"); restoreOia(); };
  window.mcxWallLoad = wallLoad;
})();
