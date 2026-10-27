// ============================ 🎓 LEARNING — Market Command tab (owner-approved design 2026-10-27) ============================
// The trader writes a past trade in plain words; /api/learning/analyze replays it on that day's real Dhan 1-minute data.
// This file only draws what the server returns: two TradingView-style charts (index + the option's premium) on 3 / 5 / 15
// minutes, the major candles, lessons by angle (each with an example picture), market behaviour, what-if, OI, checklist.
// Mounted into #mcx-learn-host by mcx.js setView("learn"). Works after 15:30 (today) or any time for past dates.
(function () {
  "use strict";
  const IST = 19800;
  const L = { mounted: false, n: 3, hl: null, r: null, charts: {}, busy: false };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hm = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
  const fx = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IN") : String(Math.round(v * 10) / 10));
  const rs = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
  const lakh = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1e5).toFixed(1)}L`);
  const TONE = { fear: "#ef5350", strength: "#26a69a", fomo: "#ff8a65", warning: "#f0b429", signal: "#4f8cff", patience: "#b388ff", panic: "#ef5350", done: "#8a94a3", lesson: "#f0b429", decay: "#8a94a3" };
  const MOOD_BG = { fear: "#7a2a2a", strength: "#1f5a4f", fomo: "#8a5a12", warning: "#7a6212", signal: "#2b4a8f", patience: "#3b3f8f", panic: "#8f2f2f", done: "#3a4250", lesson: "#7a6212", decay: "#3a4250" };

  function lastSession() {   // the latest session whose data is complete (today only after 15:31 IST)
    const now = new Date(Date.now() + IST * 1000); let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (now.getUTCHours() * 60 + now.getUTCMinutes() < 15 * 60 + 31) d = new Date(d.getTime() - 86400e3);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 86400e3);
    return d.toISOString().slice(0, 10);
  }
  async function api(path, opts) {
    const r = await fetch(`/api/learning/${path}`, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
    const j = await r.json().catch(() => ({}));
    if (r.status === 503 && j.disabled) throw new Error("The Learning screen is switched off in Data Control.");
    return j;
  }

  // ------------------------------------------------------------------ shell
  function shell(host) {
    host.innerHTML = `
<div class="lrn">
  <div class="lrn-top">
    <div class="lrn-card">
      <div class="lrn-h"><b>✍️ Write your trade in your own words</b><span>premium, time, SL, targets</span></div>
      <textarea id="lrn-text" class="lrn-in" rows="3" placeholder="e.g. BUY Nifty 22750 PE above 50, SL 37, target 78 95 105, time 10:07"></textarea>
      <div class="lrn-row">
        <label class="lrn-hint" for="lrn-date">Trade date</label><input type="date" class="lrn-in" id="lrn-date">
        <label class="lrn-hint" for="lrn-index">Index</label><select class="lrn-in" id="lrn-index"><option>NIFTY</option><option>SENSEX</option></select>
        <button type="button" class="lrn-btn" id="lrn-go">Teach me this trade</button>
      </div>
      <p class="lrn-hint" style="margin:6px 0 0">Write it however you like, e.g. "Sensex 81500 CE at 120 sl 95 tgt 150 at 11:20". If the text has no date or index, the boxes above are used. Every trade you study is <b>saved automatically</b>. 🔒 Today's trades open after 3:30 PM.</p>
      <div class="lrn-got" id="lrn-got"></div>
    </div>
    <div class="lrn-card">
      <div class="lrn-h"><b>📒 Previous trades</b><span id="lrn-pcount">click one to open it again</span></div>
      <select class="lrn-in" id="lrn-days" aria-label="Filter by date" style="width:100%"><option value="">All dates</option></select>
      <div id="lrn-saved" class="lrn-plist" role="list"></div>
    </div>
  </div>
  <div id="lrn-msg"></div>
  <div id="lrn-body" hidden>
    <div class="lrn-sum" id="lrn-sum"></div>
    <div class="lrn-tfbar">
      <div class="lrn-tf" id="lrn-tf" role="tablist"><button type="button" data-n="3" class="on">3 min</button><button type="button" data-n="5">5 min</button><button type="button" data-n="15">15 min</button></div>
      <span class="lrn-hint">Change the timeframe. The charts, the markings and the explanations below all change with it.</span>
    </div>
    <div class="lrn-g2">
      <div class="lrn-card lrn-tvcard" id="lrn-wI"><div class="lrn-tvbar"><b id="lrn-t1">Index</b><span class="lrn-tvtf" role="group" aria-label="Interval"><button type="button" data-n="3" class="on">3m</button><button type="button" data-n="5">5m</button><button type="button" data-n="15">15m</button></span><span class="lrn-tvsub">what the index was doing</span><button type="button" class="lrn-tvfs" data-lrn-fs="lrn-wI" title="Full screen" aria-label="Full screen">⤢</button></div><div class="lrn-chart" id="lrn-cI"></div><div class="lrn-legend" id="lrn-lgI"></div></div>
      <div class="lrn-card lrn-tvcard" id="lrn-wP"><div class="lrn-tvbar"><b id="lrn-t2">Premium</b><span class="lrn-tvtf" role="group" aria-label="Interval"><button type="button" data-n="3" class="on">3m</button><button type="button" data-n="5">5m</button><button type="button" data-n="15">15m</button></span><span class="lrn-tvsub">where your entry came from</span><button type="button" class="lrn-tvfs" data-lrn-fs="lrn-wP" title="Full screen" aria-label="Full screen">⤢</button></div><div class="lrn-chart" id="lrn-cP"></div><div class="lrn-legend" id="lrn-lgP"></div></div>
    </div>
    <div class="lrn-note" id="lrn-note"></div>
    <h3 class="lrn-sec">🕯 Major important candles <span id="lrn-kch"></span></h3>
    <div class="lrn-kc" id="lrn-kc"></div>
    <h3 class="lrn-sec">🧭 Market behaviour: what the crowd was feeling <span>and what YOU should do in each phase</span></h3>
    <div class="lrn-mood" id="lrn-mood"></div>
    <div class="lrn-g3" id="lrn-phase"></div>
    <div class="lrn-g3" style="margin-top:8px">
      <div class="lrn-card"><div class="lrn-h"><b>✅ Do</b></div><ul class="lrn-ul" id="lrn-do"></ul></div>
      <div class="lrn-card"><div class="lrn-h"><b>❌ Don't</b></div><ul class="lrn-ul" id="lrn-dont"></ul></div>
      <div class="lrn-card"><div class="lrn-h"><b>🐋 What the big players did</b></div><ul class="lrn-ul" id="lrn-big"></ul></div>
    </div>
    <h3 class="lrn-sec">📚 Learn from every angle <span>simple words, each with an example picture</span></h3>
    <div class="lrn-g3" id="lrn-angles"></div>
    <div class="lrn-g3" style="margin-top:8px">
      <div class="lrn-card"><div class="lrn-h"><b>⏱ What happened, minute by minute</b></div><ul class="lrn-tl" id="lrn-tl"></ul></div>
      <div class="lrn-card"><div class="lrn-h"><b>🎯 What if…</b><span id="lrn-lot"></span></div><table class="lrn-t" id="lrn-scen"></table></div>
      <div class="lrn-card"><div class="lrn-h"><b>✔️ Pattern checklist</b><span id="lrn-ckn"></span></div><ul class="lrn-ck" id="lrn-ck"></ul></div>
    </div>
    <div class="lrn-g3" style="margin-top:8px">
      <div class="lrn-card"><div class="lrn-h"><b>🔬 OI shift</b><span id="lrn-oit"></span></div><table class="lrn-t" id="lrn-oi"></table><p class="lrn-hint" id="lrn-oir"></p></div>
      <div class="lrn-card lrn-span2"><div class="lrn-h"><b>📖 Words used on this screen</b></div><dl class="lrn-words">
        <div><dt>Call wall / put wall</dt><dd>The strike with the most call sellers (a ceiling) or put sellers (a floor). Price often stops there.</dd></div>
        <div><dt>Base / bottom</dt><dd>The premium stops falling and moves sideways. Sellers are getting tired.</dd></div>
        <div><dt>Double top / bottom</dt><dd>Price hits the same high (or low) twice and fails. The move often turns.</dd></div>
        <div><dt>Engulfing candle</dt><dd>A big candle that covers the whole of the last candle. It shows a change of mood.</dd></div>
        <div><dt>Body and wick</dt><dd>The body is the thick part (open to close). A wick is the thin line: price went there and was pushed back.</dd></div>
        <div><dt>Higher low</dt><dd>Price dips but does not go below the last low. Buyers are getting stronger.</dd></div>
        <div><dt>FOMO / trapped traders</dt><dd>Jumping in after a big move (fear of missing out). When price turns, those traders exit in panic and the move gets bigger.</dd></div>
      </dl></div>
    </div>
    <div class="lrn-lesson" id="lrn-lesson"></div>
    <p class="lrn-hint" id="lrn-src"></p>
  </div>
</div>`;
  }

  // ------------------------------------------------------------------ example pictures (textbook sketches per angle)
  function ex(type) {
    const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 220 90");
    const el = (t, a, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; s.appendChild(e); return e; };
    const G = "#26a69a", R = "#ef5350", W = "#d7dde8", M = "#8a94a3";
    const cand = (x, o, h, l, c) => { const col = c <= o ? G : R; el("line", { x1: x, x2: x, y1: h, y2: l, stroke: col, "stroke-width": 1.5 }); el("rect", { x: x - 5, width: 10, y: Math.min(o, c), height: Math.max(2, Math.abs(o - c)), fill: col }); };
    const line = (y, c, t) => { el("line", { x1: 4, x2: 216, y1: y, y2: y, stroke: c, "stroke-dasharray": "4 3" }); if (t) el("text", { x: 214, y: y - 3, fill: c, "font-size": 9, "text-anchor": "end" }, t); };
    const poly = (p) => el("polyline", { points: p, fill: "none", stroke: W, "stroke-width": 2 });
    if (type === "trend") { el("polyline", { points: "10,78 40,64 60,70 95,48 115,55 150,32 170,38 205,14", fill: "none", stroke: G, "stroke-width": 2 }); el("text", { x: 12, y: 16, fill: M, "font-size": 10 }, "higher highs + higher lows = UP"); }
    if (type === "level") { line(22, R, "wall"); poly("10,80 50,45 75,24 95,50 125,40 145,23 170,55 205,80"); }
    if (type === "pattern") { poly("10,80 55,20 80,50 115,22 150,60 205,84"); line(20, R, "same top twice"); el("text", { x: 150, y: 50, fill: R, "font-size": 10 }, "↓ fall"); }
    if (type === "premium") { poly("10,10 50,40 80,70 100,78 120,72 140,78 160,66 205,20"); line(80, "#f0b429", "bottom"); line(68, "#4f8cff", "buy above"); }
    if (type === "candle") { cand(40, 30, 25, 62, 55); cand(70, 50, 45, 70, 62); cand(100, 60, 55, 78, 72); cand(135, 74, 20, 80, 24); el("text", { x: 150, y: 30, fill: G, "font-size": 10 }, "← engulfing"); }
    if (type === "wick") { cand(60, 44, 8, 48, 40); el("text", { x: 72, y: 18, fill: R, "font-size": 9 }, "long top wick: sellers"); cand(150, 48, 46, 86, 44); el("text", { x: 162, y: 76, fill: G, "font-size": 9 }, "long bottom"); el("text", { x: 162, y: 87, fill: G, "font-size": 9 }, "wick: buyers"); }
    if (type === "oi") { el("rect", { x: 30, y: 20, width: 22, height: 60, fill: R, opacity: 0.85 }); el("rect", { x: 60, y: 60, width: 22, height: 20, fill: G, opacity: 0.85 });
      el("text", { x: 41, y: 89, fill: M, "font-size": 9, "text-anchor": "middle" }, "CE"); el("text", { x: 71, y: 89, fill: M, "font-size": 9, "text-anchor": "middle" }, "PE");
      el("text", { x: 30, y: 12, fill: M, "font-size": 9 }, "big CE bar = ceiling"); el("text", { x: 105, y: 40, fill: W, "font-size": 10 }, "CE OI falling →"); el("text", { x: 105, y: 54, fill: W, "font-size": 10 }, "PE OI rising"); el("text", { x: 105, y: 68, fill: M, "font-size": 9 }, "= who is winning"); }
    if (type === "risk") { line(20, G, "target"); line(55, "#4f8cff", "entry"); line(72, R, "SL"); el("rect", { x: 20, y: 20, width: 30, height: 35, fill: G, opacity: 0.25 }); el("rect", { x: 20, y: 55, width: 30, height: 17, fill: R, opacity: 0.3 }); el("text", { x: 58, y: 42, fill: W, "font-size": 10 }, "reward ≥ 2 × risk"); }
    if (type === "time") { poly("10,70 40,62 60,20 75,28 110,50 150,60 205,76"); el("text", { x: 58, y: 14, fill: G, "font-size": 9 }, "book here"); el("text", { x: 140, y: 52, fill: R, "font-size": 9 }, "decay eats it"); }
    return s;
  }
  const ANGLES = [
    ["trend", "Trend: which way is the market going?", "Look at 15 min. Higher highs and higher lows mean up. For a PE you want the up-move to look tired, and for a CE the down-move."],
    ["level", "Key level: where can price stop?", "Mark the call wall, put wall, yesterday's close and the first 15 min high/low. Trades work best at these lines."],
    ["pattern", "Chart pattern on the index", "A double top (M shape) or double bottom (W shape) at a wall means one side is tired."],
    ["premium", "Pattern on the premium", "When the premium stops making new lows and goes sideways, that is a bottom. Buy just above it."],
    ["candle", "Candle signal", "A big green candle that covers the last red one (engulfing) shows buyers took control of the option."],
    ["wick", "Wicks: who got pushed back", "A long top wick means sellers pushed price down. A long bottom wick means buyers pushed it up."],
    ["oi", "Option data (OI)", "Check whether the writers at the wall stay (the wall holds) or run away (the wall breaks)."],
    ["risk", "Entry, SL & target", "SL just under the bottom. Target at least 2× the risk. Know your rupee risk before you buy."],
    ["time", "Time: when to get out", "Option premium loses value every minute, fastest on expiry day. Book profit when targets come quickly."],
  ];

  // ------------------------------------------------------------------ parse preview, saved trades
  let parseT = null;
  function showGot(p, err) {
    const g = $("lrn-got"); if (!p) { g.innerHTML = ""; return; }
    const F = [["Date", p.date], ["Index", p.index], ["Strike", p.strike != null ? (p.strikeShort ? `${p.strike} (short)` : p.strike) : null], ["Type", p.side],
      ["Buy", p.price != null ? `${p.how || "at"} ${p.price}` : null], ["SL", p.sl], ["Targets", p.targets?.length ? p.targets.join(" · ") : null], ["Time", p.time]];
    g.innerHTML = `<span class="lrn-gl">I understood:</span>` + F.map(([k, v]) => (v != null && v !== "" ? `<span>${k}: <b>${esc(v)}</b></span>` : k === "SL" || k === "Targets" ? `<span class="opt">${k}: not given</span>` : `<span class="miss">${k}: please add</span>`)).join("")
      + (err ? `<div class="lrn-err">${esc(err)}</div>` : "");
  }
  function body() { return { text: $("lrn-text").value, date: $("lrn-date").value, index: $("lrn-index").value }; }
  function schedParse() { clearTimeout(parseT); parseT = setTimeout(async () => { if (!$("lrn-text").value.trim()) return showGot(null); try { const j = await api("parse", { method: "POST", body: JSON.stringify(body()) }); showGot(j.parsed, j.error); } catch { /* preview only */ } }, 350); }
  const canon = (t) => `${t.date} ${t.index} ${t.strike} ${t.side} buy ${t.how} ${t.price}${t.sl != null ? ` SL ${t.sl}` : ""}${t.targets?.length ? ` target ${t.targets.join(" ")}` : ""} time ${t.time}`;
  const dmy = (d) => { const [y, m, dd] = d.split("-"); return `${Number(dd)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1]} ${y.slice(2)}`; };
  async function loadSaved() {
    const box = $("lrn-saved"), sel = $("lrn-days"), keep = sel.value;
    try {
      const j = await api(`trades?date=${encodeURIComponent(keep)}`), days = j.days || [], total = Object.values(j.counts || {}).reduce((a, b) => a + b, 0);
      sel.innerHTML = `<option value="">All dates (${total})</option>` + days.map((d) => `<option value="${d}">${dmy(d)} (${(j.counts || {})[d] || 0})</option>`).join("");
      sel.value = days.includes(keep) ? keep : "";
      const list = j.trades || [], cur = L.r && L.r.savedId;
      $("lrn-pcount").textContent = `${list.length} trade${list.length === 1 ? "" : "s"} · click one to open it again`;
      box.innerHTML = list.length ? list.map((s) => { const t = s.trade, r = s.result, st = r ? r.status : "not studied yet", cls = !r ? "mid" : /SL/.test(st) ? "bad" : /TARGET|T\d HIT/.test(st) ? "ok" : "mid";
        return `<div class="lrn-prow${s.id === cur ? " on" : ""}" role="listitem"><button type="button" class="lrn-pgo" data-lrn-open="${s.id}" title="${esc(s.text)}">
          <span class="lrn-pd">${dmy(t.date)}<br><b>${t.time}</b></span>
          <span class="lrn-pm"><b>${t.index === "NIFTY" ? "NIFTY" : "SENSEX"} ${t.strike} ${t.side}</b><br><span class="lrn-hint">${t.how} ${t.price}${t.sl != null ? ` · SL ${t.sl}` : ""}${t.targets.length ? ` · T ${t.targets.join("/")}` : ""}</span></span>
          <span class="lrn-badge ${cls}">${esc(st)}</span></button><button type="button" class="lrn-px" data-lrn-del="${s.id}" aria-label="Delete this trade" title="Delete">×</button></div>`; }).join("")
        : `<p class="lrn-hint">No trades yet. Write one on the left and press <b>Teach me this trade</b>: it is saved here automatically.</p>`;
      L.saved = list;
    } catch (e) { box.innerHTML = `<span class="lrn-hint">${esc(e.message)}</span>`; }
  }

  // ------------------------------------------------------------------ analyse
  async function analyze() {
    if (L.busy) return; const b = body(); if (!b.text.trim()) { msg("Write your trade first, for example: BUY Nifty 22750 PE above 50, SL 37, target 78 95 105, time 10:07", "warn"); return; }
    L.busy = true; $("lrn-go").disabled = true; msg("⏳ Reading the trade and loading that day's Dhan data… (first time for a date takes up to ~20 s)", "info");
    try {
      const j = await api("analyze", { method: "POST", body: JSON.stringify(b) });
      showGot(j.parsed, j.available ? null : j.error);
      if (!j.available) { msg(j.locked ? `🔒 ${esc(j.error)}` : `⚠️ ${esc(j.error || "Could not analyse this trade.")}`, j.locked ? "info" : "warn"); $("lrn-body").hidden = true; return; }
      if (j.trade.date !== $("lrn-date").value) $("lrn-date").value = j.trade.date;
      L.r = j; L.hl = null; msg(""); $("lrn-body").hidden = false; render(); loadSaved();   // saved automatically on the server
    } catch (e) { msg(`⚠️ ${esc(e.message || "Learning failed")}`, "warn"); }
    finally { L.busy = false; $("lrn-go").disabled = false; }
  }
  function msg(html, kind) { $("lrn-msg").innerHTML = html ? `<div class="lrn-msg ${kind || ""}">${html}</div>` : ""; }

  // ------------------------------------------------------------------ render
  function render() {
    const r = L.r, T = r.trade, name = `${T.strike} ${T.side}`;
    const st = r.status, good = st === "ALL TARGETS" || /^T\d HIT$/.test(st), bad = /SL/.test(st);
    $("lrn-sum").innerHTML = `<div class="lrn-sumrow"><span class="lrn-badge ${good ? "ok" : bad ? "bad" : "mid"}">${esc(st)}</span>
      <b>${T.index} ${name}</b> · ${T.date} · buy ${T.how} ${fx(T.price)} at ${T.time}${T.sl != null ? ` · SL ${fx(T.sl)}` : ""}${T.targets.length ? ` · T ${T.targets.map(fx).join(" / ")}` : ""}
      ${r.fill ? `<span>· filled <b>${fx(r.fill.px)}</b> at ${hm(r.fill.t)}</span>` : ""}
      ${r.fill ? `<span>· best after entry <b class="pos">${fx(r.sim.mfe.px)}</b> (${hm(r.sim.mfe.t)}) · lowest <b class="neg">${fx(r.sim.mae.px)}</b></span>` : ""}</div>`
      + (r.dataNotes || []).map((n) => `<div class="lrn-hint">ℹ️ ${esc(n)}</div>`).join("");
    $("lrn-lot").textContent = `₹ for 1 lot (${r.lot}), before charges`;
    $("lrn-src").textContent = `Data: ${r.source}. Learning / advisory only. Past results do not promise future results.`;
    $("lrn-t2").textContent = `${name} premium`;
    drawTf();
    // behaviour
    $("lrn-mood").innerHTML = r.phases.map((p) => `<div style="background:${MOOD_BG[p.tone] || "#3a4250"}"><span class="tm">${hm(p.from)}–${hm(p.to)}</span><b>${esc(p.title)}</b><span class="mw">${esc(p.mood)}</span></div>`).join("");
    $("lrn-phase").innerHTML = r.phases.map((p, i) => `<div class="lrn-card"><div class="lrn-h"><b>${i + 1}. ${esc(p.title)}</b><span class="lrn-tag" style="background:${MOOD_BG[p.tone] || "#3a4250"};color:#fff">${esc(p.mood)}</span></div>
      <div class="lrn-who">${hm(p.from)}–${hm(p.to)} · in control: <b>${esc(p.who)}</b></div><p>${p.text}</p><div class="lrn-you">👉 You: ${p.you}</div></div>`).join("");
    $("lrn-do").innerHTML = r.dos.map((x) => `<li>${x}</li>`).join(""); $("lrn-dont").innerHTML = r.donts.map((x) => `<li>${x}</li>`).join("");
    $("lrn-big").innerHTML = r.big.length ? r.big.map((x) => `<li>${x}</li>`).join("") : "<li>No OI data recorded for these strikes.</li>";
    // angles
    const A = $("lrn-angles"); A.innerHTML = "";
    ANGLES.forEach(([k, h, p], i) => { const c = document.createElement("div"); c.className = "lrn-card lrn-ang";
      c.innerHTML = `<div class="lrn-h"><b><span class="lrn-num">${i + 1}</span>${h}</b></div><p>${p}</p><div class="lrn-ex"></div><div class="lrn-today">📍 ${r.angles[k] || "—"}</div>`;
      const e = c.querySelector(".lrn-ex"); e.appendChild(ex(k)); e.insertAdjacentHTML("beforeend", "<small>Example picture</small>"); A.appendChild(c); });
    // timeline, scenarios, checklist, OI, lesson
    $("lrn-tl").innerHTML = r.timeline.map((x) => `<li><span class="t">${hm(x.t)}</span><span style="${x.tone ? `color:${TONE[x.tone]}` : ""}">${esc(x.text)}</span></li>`).join("");
    $("lrn-scen").innerHTML = `<tr><th>If you had…</th><th class="n">Result</th></tr>` + r.scenarios.map((s) => `<tr><td>${esc(s.label)}${s.text ? `<div class="lrn-hint">${esc(s.text)}</div>` : ""}</td><td class="n ${s.pnl == null ? "" : s.pnl >= 0 ? "pos" : "neg"}">${s.pnl == null ? "—" : rs(s.pnl)}</td></tr>`).join("");
    const okN = r.checklist.filter((c) => c.ok).length; $("lrn-ckn").textContent = `${okN} / ${r.checklist.length}`;
    $("lrn-ck").innerHTML = r.checklist.map((c) => `<li><b class="${c.ok ? "pos" : "neg"}">${c.ok ? "✓" : "✗"}</b><span>${esc(c.text)}</span></li>`).join("");
    $("lrn-oit").textContent = `${hm(r.oi.from)} → ${hm(r.oi.to)}`;
    $("lrn-oi").innerHTML = r.oi.rows.length ? `<tr><th>Strike</th><th class="n">CE OI</th><th class="n">PE OI</th></tr>` + r.oi.rows.map((x) => `<tr${x.strike === T.strike ? ' class="me"' : ""}><td>${x.strike}${r.oi.wall && x.strike === r.oi.wall.strike ? " 🧱" : ""}</td><td class="n ${x.ce > 0 ? "pos" : x.ce < 0 ? "neg" : ""}">${lakh(x.ce)}</td><td class="n ${x.pe > 0 ? "pos" : x.pe < 0 ? "neg" : ""}">${lakh(x.pe)}</td></tr>`).join("") : "<tr><td>No OI recorded for these strikes.</td></tr>";
    $("lrn-oir").textContent = r.oi.read;
    $("lrn-lesson").innerHTML = `<b>🧠 Main lesson:</b> ${r.lesson}`;
  }

  // ------------------------------------------------------------------ charts: TradingView's own library + its original dark theme
  // (Groww's NIFTY chart is TradingView too): O H L C legend top-left that follows the crosshair, dashed crosshair with
  // price / time labels, symbol watermark, volume pane under the premium, interval buttons and full screen in the header.
  const TV = { bg: "#131722", grid: "rgba(42,46,57,0.6)", text: "#d1d4dc", mute: "#787b86", border: "#2a2e39", up: "#089981", down: "#f23645", cross: "#9598a1", label: "#363a45" };
  const px2 = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const vol = (v) => (v >= 1e7 ? (v / 1e7).toFixed(2) + " Cr" : v >= 1e5 ? (v / 1e5).toFixed(2) + " L" : v >= 1e3 ? (v / 1e3).toFixed(1) + " K" : String(Math.round(v)));
  function mkChart(el, withVol) {
    if (!window.LightweightCharts) { el.innerHTML = '<p class="lrn-hint">Chart library not loaded.</p>'; return null; }
    const LC = window.LightweightCharts, dash = { color: TV.cross, width: 1, style: 3, labelBackgroundColor: TV.label };
    const ch = LC.createChart(el, { autoSize: true,
      layout: { background: { type: "solid", color: TV.bg }, textColor: TV.text, fontSize: 12, fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif" },
      grid: { vertLines: { color: TV.grid }, horzLines: { color: TV.grid } },
      crosshair: { mode: LC.CrosshairMode ? LC.CrosshairMode.Normal : 0, vertLine: dash, horzLine: dash },
      rightPriceScale: { borderColor: TV.border, scaleMargins: { top: 0.12, bottom: withVol ? 0.12 : 0.08 } },
      timeScale: { borderColor: TV.border, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 2 },
      watermark: { visible: true, fontSize: 40, horzAlign: "center", vertAlign: "center", color: "rgba(120,123,134,0.13)", text: "" },
      localization: { priceFormatter: (p) => px2(p) } });
    const s = ch.addCandlestickSeries({ upColor: TV.up, downColor: TV.down, borderVisible: false, wickUpColor: TV.up, wickDownColor: TV.down, priceLineVisible: true, lastValueVisible: true });
    let v = null;
    if (withVol) { v = ch.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false }); ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } }); }
    const leg = document.createElement("div"); leg.className = "lrn-tvleg"; el.appendChild(leg);
    const C = { ch, s, v, leg, lines: [], bars: [], idx: new Map(), title: "", sub: "" };
    ch.subscribeCrosshairMove((p) => { const on = !!(p && p.time != null && p.seriesData && p.seriesData.get(s)); C.hover = on; legend(C, on ? C.idx.get(p.time) : null); });
    ch.timeScale().subscribeVisibleLogicalRangeChange(() => { if (!C.hover) legend(C, null); });   // idle: the last candle in view, like TradingView
    return C;
  }
  function legend(C, i) {
    if (!C || !C.bars.length) return; let k = i;
    if (k == null) { const r = C.ch.timeScale().getVisibleLogicalRange(); k = r ? Math.max(0, Math.min(C.bars.length - 1, Math.floor(r.to))) : C.bars.length - 1; }
    const b = C.bars[k], pv = k > 0 ? C.bars[k - 1].c : b.o, d = b.c - pv, col = b.c >= b.o ? TV.up : TV.down;
    C.leg.innerHTML = `<div class="lrn-tvsym"><b>${esc(C.title)}</b> · ${esc(C.sub)} <span class="lrn-tvdot"></span></div>
      <div class="lrn-tvohlc" style="--c:${col}">O<i>${px2(b.o)}</i> H<i>${px2(b.h)}</i> L<i>${px2(b.l)}</i> C<i>${px2(b.c)}</i> <i>${d >= 0 ? "+" : "−"}${px2(Math.abs(d))} (${d >= 0 ? "+" : "−"}${Math.abs((d / (pv || 1)) * 100).toFixed(2)}%)</i></div>`
      + (C.v && b.v ? `<div class="lrn-tvohlc">Vol <i style="color:${col}">${vol(b.v)}</i></div>` : "");
  }
  function setSeries(C, bars, marks, levels, hl, title, sub) {
    if (!C) return;
    C.bars = bars; C.idx = new Map(bars.map((b, i) => [b.t + IST, i])); C.title = title; C.sub = sub;
    C.ch.applyOptions({ watermark: { text: `${title}, ${sub.split(" ")[0]}` } });
    C.s.setData(bars.map((b) => { const x = { time: b.t + IST, open: b.o, high: b.h, low: b.l, close: b.c };
      if (hl != null && b.t === hl) Object.assign(x, { color: "#f0b429", wickColor: "#f0b429", borderColor: "#f0b429" }); return x; }));
    if (C.v) { const has = bars.some((b) => b.v > 0); C.v.setData(has ? bars.map((b) => ({ time: b.t + IST, value: b.v || 0, color: b.c >= b.o ? "rgba(8,153,129,0.35)" : "rgba(242,54,69,0.35)" })) : []); }
    C.lines.forEach((l) => C.s.removePriceLine(l)); C.lines = levels.map((l) => C.s.createPriceLine({ price: l.v, color: l.c, lineWidth: l.w || 1, lineStyle: l.solid ? 0 : 2, axisLabelVisible: true, title: l.t }));
    const ms = marks.map((m) => ({ time: m.t + IST, position: m.pos === "above" ? "aboveBar" : "belowBar", color: TONE[m.tone] || "#d7dde8", shape: m.pos === "above" ? "arrowDown" : "arrowUp", text: m.text }))
      .concat(hl != null ? [{ time: hl + IST, position: "aboveBar", color: "#f0b429", shape: "circle", text: "◀ this candle" }] : []).sort((a, b) => a.time - b.time);
    C.s.setMarkers(ms); legend(C, null);
  }
  function frame(C, bars, from, to) { if (!C || !bars.length) return; try { C.ch.timeScale().setVisibleRange({ from: from + IST, to: to + IST }); } catch { C.ch.timeScale().fitContent(); } }
  function drawTf() {
    const r = L.r, n = L.n, d = r.tf[n], T = r.trade;
    document.querySelectorAll("#lrn-tf button, .lrn-tvtf button").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === n));
    const ixName = T.index === "NIFTY" ? "NIFTY 50" : "SENSEX", exch = T.index === "NIFTY" ? "NSE" : "BSE", oexch = T.index === "NIFTY" ? "NFO" : "BFO";
    $("lrn-t1").textContent = `${ixName} · ${T.date}`; $("lrn-t2").textContent = `${T.index} ${T.strike} ${T.side}`;
    if (!L.charts.I) L.charts.I = mkChart($("lrn-cI"), false); if (!L.charts.P) L.charts.P = mkChart($("lrn-cP"), true);
    const LV = { pdc: "#f0b429", pdh: "#f0b429", pdl: "#f0b429", f15h: "#26c6da", f15l: "#26c6da", open: "#5d6776", callwall: "#ef5350", putwall: "#26a69a" };
    const SHORT = { pdc: "PDC", pdh: "PDH", pdl: "PDL", f15h: "F15 H", f15l: "F15 L", open: "Open", callwall: "Call wall", putwall: "Put wall" };
    const iLv = [];   // one line per price: "PDC · PDH" when yesterday closed at its high
    for (const l of r.levels) { const same = iLv.find((x) => Math.abs(x.v - l.v) < 0.5), t = SHORT[l.key] || "";
      if (same) { same.t = `${same.t} · ${t}`; continue; }
      iLv.push({ v: l.v, c: LV[l.key] || "#8a94a3", t, solid: l.key === "callwall" || l.key === "putwall", w: l.key === "callwall" || l.key === "putwall" ? 2 : 1 }); }
    const pLv = [{ v: r.fill ? r.fill.px : T.price, c: "#4f8cff", t: r.fill ? "Entry" : "Plan", solid: true, w: 2 }]
      .concat(T.sl != null ? [{ v: T.sl, c: "#ef5350", t: "SL", solid: true, w: 2 }] : [], T.targets.map((x, i) => ({ v: x, c: "#26a69a", t: `T${i + 1}` })), r.base ? [{ v: r.base.v, c: "#f0b429", t: "Bottom" }] : []);
    setSeries(L.charts.I, d.idx, d.marksIdx, iLv, L.hl, ixName, `${n} · ${exch}`); setSeries(L.charts.P, d.opt, d.marksOpt, pLv, L.hl, `${T.index} ${T.strike} ${T.side}`, `${n} · ${oexch}`);
    const a = (r.base ? Math.min(r.base.t, r.ref.t) : r.ref.t) - 50 * 60, b = Math.max(r.sim.exitT, r.ref.t) + 40 * 60, w = n === 15 ? 3 : 1;
    const from = L.hl != null ? L.hl - 40 * 60 * w : a - (w - 1) * 60 * 60, to = L.hl != null ? L.hl + 40 * 60 * w : b + (w - 1) * 60 * 60;
    frame(L.charts.I, d.idx, from, to); frame(L.charts.P, d.opt, from, to);
    $("lrn-lgI").innerHTML = `<span><i style="background:#ef5350"></i>Call wall</span><span><i style="background:#26a69a"></i>Put wall</span><span><i style="background:#f0b429"></i>Yesterday's close / high / low</span><span><i style="background:#26c6da"></i>First 15 min high / low</span>`;
    $("lrn-lgP").innerHTML = `<span><i style="background:#4f8cff"></i>Your entry</span><span><i style="background:#ef5350"></i>Your SL</span><span><i style="background:#26a69a"></i>Targets</span><span><i style="background:#f0b429"></i>Premium bottom</span>`;
    $("lrn-note").innerHTML = d.note;
    // key candles
    $("lrn-kch").textContent = `${n} min chart · click a card to highlight that candle on both charts`;
    const ib = new Map(d.idx.map((b) => [b.t, b])), ob = new Map(d.opt.map((b) => [b.t, b]));
    const mini = (b) => { if (!b) return ""; const lo = b.l, hi = b.h, y = (v) => 4 + ((hi - v) / ((hi - lo) || 1)) * 56, col = b.c >= b.o ? "#26a69a" : "#ef5350";
      return `<svg viewBox="0 0 44 64" aria-hidden="true"><line x1="22" x2="22" y1="${y(b.h)}" y2="${y(b.l)}" stroke="${col}" stroke-width="2"/><rect x="12" width="20" y="${y(Math.max(b.o, b.c))}" height="${Math.max(2, Math.abs(y(b.o) - y(b.c)))}" fill="${col}"/></svg>`; };
    const kd = (nm, b, avg) => { if (!b) return ""; const body = b.c - b.o, up = b.h - Math.max(b.o, b.c), dn = Math.min(b.o, b.c) - b.l;
      return `<div class="lrn-kpair">${mini(b)}<div class="lrn-kd"><b>${nm}</b> O ${fx(b.o)} · H ${fx(b.h)} · L ${fx(b.l)} · C ${fx(b.c)}<br>Body <b class="${body >= 0 ? "pos" : "neg"}">${body >= 0 ? "+" : "−"}${fx(Math.abs(body))}</b> · top wick ${fx(up)} · bottom wick ${fx(dn)}<br>Size <b>${((b.h - b.l) / (avg || 1)).toFixed(1)}×</b> a normal candle</div></div>`; };
    $("lrn-kc").innerHTML = d.keyCandles.map((k) => `<div class="lrn-card lrn-kcard${L.hl === k.t ? " on" : ""}" data-lrn-hl="${k.t}" role="button" tabindex="0">
      <div class="lrn-kt"><b>${hm(k.t)} · ${esc(k.title)}</b><span class="lrn-tag" style="background:${TONE[k.tone] || "#8a94a3"};color:#0b0e14">${esc(k.tag)}</span></div>
      ${kd(T.index, ib.get(k.t), d.avgIdx)}${kd(`${T.strike} ${T.side}`, ob.get(k.t), d.avgOpt)}<div class="lrn-kmean">${k.meaning}</div><div class="lrn-kdo">👉 ${k.todo}</div></div>`).join("") || '<p class="lrn-hint">No major candles on this timeframe.</p>';
  }

  // ------------------------------------------------------------------ events
  function wire() {
    $("lrn-date").value = lastSession();
    $("lrn-go").onclick = analyze;
    $("lrn-text").addEventListener("input", schedParse);
    $("lrn-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) analyze(); });
    $("lrn-date").addEventListener("change", schedParse);
    $("lrn-index").addEventListener("change", schedParse);
    $("lrn-days").addEventListener("change", loadSaved);
    document.querySelector(".lrn").addEventListener("click", async (e) => {
      const o = e.target.closest("[data-lrn-open]"), del = e.target.closest("[data-lrn-del]"), tf = e.target.closest("#lrn-tf button, .lrn-tvtf button"), kc = e.target.closest("[data-lrn-hl]"), fs = e.target.closest("[data-lrn-fs]");
      if (o) { const s = (L.saved || []).find((x) => x.id === o.dataset.lrnOpen); if (s) { $("lrn-text").value = s.text || canon(s.trade); $("lrn-index").value = s.trade.index; $("lrn-date").value = s.trade.date; await analyze(); $("lrn-sum").scrollIntoView({ behavior: "smooth", block: "start" }); } }
      else if (del) { if (!confirm("Delete this saved trade?")) return; await api(`trades/${del.dataset.lrnDel}`, { method: "DELETE" }).catch(() => null); loadSaved(); }
      else if (tf && L.r) { L.n = Number(tf.dataset.n); L.hl = null; drawTf(); }
      else if (fs) { const w = $(fs.dataset.lrnFs), on = !w.classList.contains("lrn-full"); document.querySelectorAll(".lrn-full").forEach((x) => x.classList.remove("lrn-full")); if (on) w.classList.add("lrn-full"); fs.textContent = on ? "✕" : "⤢"; document.body.classList.toggle("lrn-fullbody", on); }
      else if (kc && L.r) { const t = Number(kc.dataset.lrnHl); L.hl = L.hl === t ? null : t; drawTf(); $("lrn-cI").scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.querySelector(".lrn-full")) { document.querySelectorAll(".lrn-full").forEach((x) => x.classList.remove("lrn-full")); document.querySelectorAll("[data-lrn-fs]").forEach((b) => (b.textContent = "⤢")); document.body.classList.remove("lrn-fullbody"); } });
    document.querySelector(".lrn").addEventListener("keydown", (e) => { const kc = e.target.closest("[data-lrn-hl]"); if (kc && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); kc.click(); } });
  }

  /** Called by mcx.js when the 🎓 Learning view opens. */
  window.lrnMount = function (host) {
    if (!host) return;
    if (!L.mounted) { shell(host); wire(); L.mounted = true; loadSaved(); if (!$("lrn-text").value) $("lrn-text").placeholder = `e.g. BUY Nifty 22750 PE above 50, SL 37, target 78 95 105, time 10:07`; }
    else if (L.r) setTimeout(drawTf, 30);   // the charts were hidden: redraw at the visible size
  };
})();
