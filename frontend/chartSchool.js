// ============================ 📸 CHART SCHOOL — Learning screen (owner, 2026-10-28) ============================
// Pick NIFTY / SENSEX and a day (date filter) → the system builds that day's training chart from the real 5-min candles: levels + numbered candles, each explained in Hindi (what the candle is, where it stood, why it mattered,
// what an experienced trader does). Data: /api/chart-school (backend learning/chartSchool.ts). Education only.
(function () {
  "use strict";
  const IST = 19800, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const f0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
  const hm = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
  const S = { host: null, sym: "^NSEI", date: null, data: null, C: null, focus: null, busy: false };
  // Dhan-style chart (owner, 2026-10-28): white background, Dhan's green / orange-red candles, light grid, EMA light + dark blue
  const KIND = { PD: ["कल", "#e09b00"], OR: ["Opening range", "#1e88e5"], ROUND: ["Round", "#9598a1"], SWING: ["Flip zone", "#9c27b0"], DAY: ["आज H/L", "#e57373"] };
  const TONE = { bull: "#089981", bear: "#F23645", neutral: "#f9a825" };
  const DHAN = { up: "#089981", down: "#F23645", e9: "#4da3ff", e21: "#2f55e8" };   // candles: TradingView's default teal / red (owner, 2026-10-28)
  // the last 30 weekdays up to the last session, newest first (holidays show "data नहीं मिला")
  const sessions = () => { const out = []; let d = new Date(lastSession() + "T00:00:00Z"); while (out.length < 30) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10)); d = new Date(d - 864e5); } return out; };
  const DAYS = ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayLbl = (d) => { const x = new Date(d + "T00:00:00Z"); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
  const lastSession = () => { const n = new Date(Date.now() + IST * 1000); let d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); if (n.getUTCHours() * 60 + n.getUTCMinutes() < 555) d = new Date(d - 864e5); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d - 864e5); return d.toISOString().slice(0, 10); };

  function shell() {
    S.host.innerHTML = `<div class="cs">
      <div class="cs-form" role="group" aria-label="Index और दिन">
        <div class="cs-idx" role="tablist" aria-label="Index">${[["^NSEI", "NIFTY"], ["^BSESN", "SENSEX"]].map(([s, n]) => `<button type="button" role="tab" data-cs-sym="${s}">${n}</button>`).join("")}</div>
        <div class="cs-days"><button type="button" class="one-btn" data-cs-step="1" aria-label="पिछला दिन">◀</button>
          <select class="lrn-in" id="cs-day" aria-label="दिन चुनें">${sessions().map((d) => `<option value="${d}">${dayLbl(d)} · ${d}</option>`).join("")}</select>
          <button type="button" class="one-btn" data-cs-step="-1" aria-label="अगला दिन">▶</button></div>
        <label class="cs-f"><span>या तारीख़</span><input type="date" id="cs-date" class="lrn-in" max="${lastSession()}"></label>
      </div>
      <div class="cs-cw"><div class="cs-legend" id="cs-legend"></div><div class="cs-chart" id="cs-chart"></div></div>
      <div id="cs-body"><p class="lrn-hint">दिन और index चुनकर "Lesson बनाएँ" दबाएँ।</p></div>
    </div>`;
    paintSym();
  }
  const paintSym = () => S.host && S.host.querySelectorAll("[data-cs-sym]").forEach((b) => { const on = b.dataset.csSym === S.sym; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });

  // ------------------------------------------------------------ chart
  function chart() {
    if (S.C || typeof LightweightCharts === "undefined") return S.C;
    const el = $("cs-chart"); if (!el) return null;
    const ch = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: "#ffffff" }, textColor: "#4a4f5c", fontSize: 12 },
      grid: { vertLines: { color: "#f0f2f6" }, horzLines: { color: "#f0f2f6" } }, rightPriceScale: { borderColor: "#e0e3eb" },
      timeScale: { borderColor: "#e0e3eb", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, vertLine: { color: "#9598a1", style: 2, labelBackgroundColor: "#4a4f5c" }, horzLine: { color: "#9598a1", style: 2, labelBackgroundColor: "#4a4f5c" } },
      localization: { priceFormatter: (p) => Math.round(p).toLocaleString("en-IN"), timeFormatter: (t) => new Date(t * 1000).toISOString().slice(11, 16) } });
    const c = ch.addCandlestickSeries({ upColor: DHAN.up, downColor: DHAN.down, borderVisible: true, borderUpColor: DHAN.up, borderDownColor: DHAN.down, wickUpColor: DHAN.up, wickDownColor: DHAN.down, priceLineVisible: true, priceLineStyle: 3 });
    const e9 = ch.addLineSeries({ color: DHAN.e9, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const e21 = ch.addLineSeries({ color: DHAN.e21, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    // Dhan-style O H L C read-out of the candle under the cursor (the last candle otherwise)
    ch.subscribeCrosshairMove((p) => { const b = p && p.time && p.seriesData ? p.seriesData.get(c) : null; ohlc(b || null); });
    S.C = { ch, c, e9, e21, pls: [] };
    return S.C;
  }
  function draw() {
    const d = S.data, C = chart(); if (!d || !d.available || !C) return;
    const narrow = ($("cs-chart")?.clientWidth || 999) < 560;
    const T = (b) => b.time + IST;
    C.c.setData(d.bars.map((b) => ({ time: T(b), open: b.open, high: b.high, low: b.low, close: b.close })));
    C.e9.setData(d.bars.map((b, i) => (d.ema9[i] != null ? { time: T(b), value: d.ema9[i] } : { time: T(b) })));
    C.e21.setData(d.bars.map((b, i) => (d.ema21[i] != null ? { time: T(b), value: d.ema21[i] } : { time: T(b) })));
    for (const p of C.pls) C.c.removePriceLine(p); C.pls = [];
    for (const l of d.levels) { const [nm, col] = KIND[l.kind] || ["", "#9aa3b0"]; C.pls.push(C.c.createPriceLine({ price: l.price, color: col, lineWidth: l.kind === "PD" || l.kind === "SWING" ? 2 : 1, lineStyle: l.kind === "DAY" ? 3 : 2, axisLabelVisible: true, title: narrow ? "" : l.label })); }
    C.c.setMarkers(d.events.map((e) => ({ time: T(d.bars[e.idx]), position: e.tone === "bear" ? "aboveBar" : e.tone === "bull" ? "belowBar" : "aboveBar", color: e.n === S.focus ? "#131722" : TONE[e.tone], shape: e.tone === "bear" ? "arrowDown" : e.tone === "bull" ? "arrowUp" : "circle", text: String(e.n), size: e.n === S.focus ? 2 : 1 })));
    if (S.focus) { const e = d.events.find((x) => x.n === S.focus); if (e) C.ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, e.idx - 18), to: e.idx + 18 }); }
    else C.ch.timeScale().fitContent();
    ohlc(null);
  }

  function ohlc(b) {
    const lg = $("cs-legend"), d = S.data; if (!lg || !d || !d.available) return;
    const x = b || d.bars[d.bars.length - 1], ch = x.close - x.open, col = ch >= 0 ? DHAN.up : DHAN.down;
    lg.innerHTML = `<b>${esc(d.index)}</b> · 5 · ${esc(d.day)} <span class="cs-o">O <b style="color:${col}">${f0(x.open)}</b> H <b style="color:${col}">${f0(x.high)}</b> L <b style="color:${col}">${f0(x.low)}</b> C <b style="color:${col}">${f0(x.close)}</b> <b style="color:${col}">${ch >= 0 ? "+" : "−"}${f0(Math.abs(ch))}</b></span><br><span><i style="background:${DHAN.e9}"></i>EMA 9</span><span><i style="background:${DHAN.e21}"></i>EMA 21</span>`;
  }

  // ------------------------------------------------------------ lesson body
  function render() {
    const box = $("cs-body"), d = S.data; if (!box) return;
    if (S.busy) { box.innerHTML = `<p class="lrn-hint">⏳ उस दिन की असली candles पढ़ी जा रही हैं…</p>`; return; }
    if (!d) return;
    if (!d.available) { box.innerHTML = `<p class="lrn-hint">${esc(d.error || "data नहीं मिला")}</p>`; return; }
    const ev = d.events.map((e) => `<li class="cs-ev t-${e.tone}${e.n === S.focus ? " on" : ""}"><button type="button" data-cs-ev="${e.n}" aria-pressed="${e.n === S.focus}">
        <span class="cs-n" style="background:${TONE[e.tone]}">${e.n}</span>
        <span class="cs-evb"><span class="cs-evh"><b>${esc(e.title)}</b><time>${hm(e.time)}</time></span>
          <span class="cs-chips"><span class="one-chip">🕯️ ${esc(e.candle)}</span>${e.level ? `<span class="one-chip">📏 ${esc(e.level.label)} ${f0(e.level.price)}</span>` : ""}</span>
          <span class="cs-p">${esc(e.what)}</span><span class="cs-p"><b>🧠 सीख:</b> ${esc(e.lesson)}</span><span class="cs-p"><b>🎯 अनुभवी trader:</b> ${esc(e.action)}</span></span></button></li>`).join("");
    const lv = d.levels.map((l) => { const [nm, col] = KIND[l.kind] || ["", "#9aa3b0"]; return `<li><span class="cs-sw" style="background:${col}"></span><b>${f0(l.price)}</b><span>${esc(l.label)}</span><span class="lrn-hint">${esc(l.note)}</span></li>`; }).join("");
    const gl = d.glossary.map((g) => `<li><b>${esc(g.name)}</b> <span class="one-chip">आज ${g.count} बार</span><span class="lrn-hint">${esc(g.hi)}</span></li>`).join("");
    box.innerHTML = `<div class="cs-sum"><ul>${d.summary.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><button type="button" class="one-btn" data-cs-say="1">📢 Lesson सुनाएँ</button>${S.focus ? `<button type="button" class="one-btn" data-cs-ev="0">↔ पूरा दिन</button>` : ""}</div>
      <h4 class="cs-h">🔢 ज़रूरी candles (chart पर नंबर — card दबाएँ तो chart वहीं ज़ूम होगा)</h4><ol class="cs-evs">${ev}</ol>
      <div class="cs-grid"><div><h4 class="cs-h">📏 Levels — value की जगहें</h4><ul class="cs-lv">${lv}</ul></div>
        <div><h4 class="cs-h">🕯️ आज दिखी candles</h4><ul class="cs-gl">${gl || "<li class='lrn-hint'>—</li>"}</ul></div></div>
      <h4 class="cs-h">📐 Candle की importance कैसे पहचानें</h4><ol class="cs-rules">${d.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
  }

  // ------------------------------------------------------------ actions
  async function loadLesson(sym, date) {
    S.busy = true; S.focus = null; render();
    try { S.data = await fetchJSON(`/api/chart-school?symbol=${encodeURIComponent(sym)}&date=${date}`, 45000); }
    catch (e) { S.data = { available: false, error: String((e && e.message) || e) }; }
    S.busy = false; render(); draw();
  }
  // the date filter: the select (last 30 weekdays), ◀ / ▶ and any date from the calendar; the lesson loads on every change
  function go(date) {
    if (!date) return; S.date = date;
    const sel = $("cs-day"), cal = $("cs-date");
    if (sel) { if (![...sel.options].some((o) => o.value === date)) sel.insertAdjacentHTML("afterbegin", `<option value="${date}">${dayLbl(date)} · ${date}</option>`); sel.value = date; }
    if (cal) cal.value = date;
    loadLesson(S.sym, date);
  }
  window.csMount = (host) => {
    if (!host) return;
    if (S.host !== host) { if (S.C) { try { S.C.ch.remove(); } catch {} S.C = null; } S.host = host; shell(); go(S.date || lastSession()); }
  };
  document.addEventListener("change", (e) => { if (!S.host || !e.target) return; if (e.target.id === "cs-day" || e.target.id === "cs-date") go(e.target.value); });
  document.addEventListener("click", (e) => {
    if (!S.host) return;
    const b = e.target.closest("[data-cs-sym],[data-cs-ev],[data-cs-step],[data-cs-say]"); if (!b || !S.host.contains(b)) return;
    if (b.dataset.csSym) { S.sym = b.dataset.csSym; paintSym(); go(S.date || lastSession()); }
    else if (b.dataset.csStep) { const sel = $("cs-day"), i = sel ? sel.selectedIndex + Number(b.dataset.csStep) : -1; if (sel && i >= 0 && i < sel.options.length) go(sel.options[i].value); }
    else if (b.dataset.csEv != null) { const n = Number(b.dataset.csEv); S.focus = n && n !== S.focus ? n : null; render(); draw(); if (S.focus) $("cs-chart")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    else if (b.dataset.csSay && S.data && S.data.available && typeof window.oneSay === "function") window.oneSay([...S.data.summary, ...S.data.events.map((x) => `${x.n}. ${x.title}. ${x.lesson}`)].join(" "));
  });
  let rz = 0; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.data) draw(); }, 250); });
})();
