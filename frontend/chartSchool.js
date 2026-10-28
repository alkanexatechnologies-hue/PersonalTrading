// ============================ 📸 CHART SCHOOL — Learning screen (owner, 2026-10-28) ============================
// Upload (or paste) a NIFTY / SENSEX chart screenshot for a day → the system builds that day's training chart from the real
// 5-min candles: levels + numbered candles, each explained in Hindi (what the candle is, where it stood, why it mattered,
// what an experienced trader does). Data: /api/chart-school (backend learning/chartSchool.ts). Education only.
(function () {
  "use strict";
  const IST = 19800, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const f0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
  const hm = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
  const S = { host: null, sym: "^NSEI", file: null, img: null, data: null, C: null, focus: null, busy: false };
  const KIND = { PD: ["कल", "#f5c542"], OR: ["Opening range", "#4ea1ff"], ROUND: ["Round", "#9aa3b0"], SWING: ["Flip zone", "#ab47bc"], DAY: ["आज H/L", "#ef9a9a"] };
  const TONE = { bull: "#26a69a", bear: "#ef5350", neutral: "#f5c542" };
  const lastSession = () => { const n = new Date(Date.now() + IST * 1000); let d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); if (n.getUTCHours() * 60 + n.getUTCMinutes() < 555) d = new Date(d - 864e5); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d - 864e5); return d.toISOString().slice(0, 10); };

  function shell() {
    S.host.innerHTML = `<div class="cs">
      <form class="cs-form" id="cs-form">
        <div class="cs-idx" role="tablist" aria-label="Index">${[["^NSEI", "NIFTY"], ["^BSESN", "SENSEX"]].map(([s, n]) => `<button type="button" role="tab" data-cs-sym="${s}">${n}</button>`).join("")}</div>
        <label class="cs-f"><span>दिन</span><input type="date" id="cs-date" class="lrn-in" value="${lastSession()}"></label>
        <label class="cs-file one-btn" for="cs-file">📷 Screenshot चुनें<input type="file" id="cs-file" accept="image/png,image/jpeg,image/webp" hidden></label>
        <button type="submit" class="one-btn on" id="cs-go">🎓 Lesson बनाएँ</button>
        <span class="lrn-hint" id="cs-fname">Screenshot चुनें या यहाँ paste (Ctrl / ⌘ + V) करें — बिना screenshot भी lesson बनता है।</span>
      </form>
      <div class="cs-panes" id="cs-panes">
        <figure class="cs-shot" id="cs-shot" hidden><figcaption>📷 आपका chart</figcaption><img id="cs-img" alt="आपका chart screenshot"></figure>
        <div class="cs-cw"><div class="cs-legend" id="cs-legend"></div><div class="cs-chart" id="cs-chart"></div></div>
      </div>
      <div id="cs-body"><p class="lrn-hint">दिन और index चुनकर "Lesson बनाएँ" दबाएँ।</p></div>
      <details class="cs-up"><summary><b>📂 मेरे पुराने charts</b></summary><div id="cs-list" class="cs-list"></div></details>
    </div>`;
    paintSym();
  }
  const paintSym = () => S.host && S.host.querySelectorAll("[data-cs-sym]").forEach((b) => { const on = b.dataset.csSym === S.sym; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });

  // ------------------------------------------------------------ chart
  function chart() {
    if (S.C || typeof LightweightCharts === "undefined") return S.C;
    const el = $("cs-chart"); if (!el) return null;
    const ch = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: "#131722" }, textColor: "#b2b5be", fontSize: 12 },
      grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } }, rightPriceScale: { borderColor: "#2a2e39" },
      timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 },
      localization: { priceFormatter: (p) => Math.round(p).toLocaleString("en-IN"), timeFormatter: (t) => new Date(t * 1000).toISOString().slice(11, 16) } });
    const c = ch.addCandlestickSeries({ upColor: "#26a69a", downColor: "#ef5350", wickUpColor: "#26a69a", wickDownColor: "#ef5350", borderVisible: false, priceLineVisible: false });
    const e9 = ch.addLineSeries({ color: "#5fa8ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const e21 = ch.addLineSeries({ color: "#2f5bea", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
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
    C.c.setMarkers(d.events.map((e) => ({ time: T(d.bars[e.idx]), position: e.tone === "bear" ? "aboveBar" : e.tone === "bull" ? "belowBar" : "aboveBar", color: e.n === S.focus ? "#ffffff" : TONE[e.tone], shape: e.tone === "bear" ? "arrowDown" : e.tone === "bull" ? "arrowUp" : "circle", text: String(e.n), size: e.n === S.focus ? 2 : 1 })));
    if (S.focus) { const e = d.events.find((x) => x.n === S.focus); if (e) C.ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, e.idx - 18), to: e.idx + 18 }); }
    else C.ch.timeScale().fitContent();
    const lg = $("cs-legend"); if (lg) lg.innerHTML = `<b>${esc(d.index)}</b> · 5m · ${esc(d.day)} <span><i style="background:#5fa8ff"></i>EMA 9</span><span><i style="background:#2f5bea"></i>EMA 21</span>`;
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
  async function showImage(id) {
    const fig = $("cs-shot"), img = $("cs-img"); if (!fig || !img) return;
    if (!id) { fig.hidden = true; return; }
    try { const r = await fetch("/api/chart-school/image/" + encodeURIComponent(id)); if (!r.ok) throw 0; if (S.img) URL.revokeObjectURL(S.img); S.img = URL.createObjectURL(await r.blob()); img.src = S.img; fig.hidden = false; } catch { fig.hidden = true; }
  }
  async function loadLesson(sym, date) {
    S.busy = true; S.focus = null; render();
    try { S.data = await fetchJSON(`/api/chart-school?symbol=${encodeURIComponent(sym)}&date=${date}`, 45000); }
    catch (e) { S.data = { available: false, error: String((e && e.message) || e) }; }
    S.busy = false; render(); draw();
  }
  async function submit() {
    const date = $("cs-date").value || lastSession();
    if (S.file) {
      const nm = $("cs-fname"); nm.textContent = "⏳ Screenshot save हो रहा है…";
      try {
        const r = await fetch(`/api/chart-school/upload?symbol=${encodeURIComponent(S.sym)}&date=${date}`, { method: "POST", headers: { "Content-Type": S.file.type || "image/png" }, body: S.file }).then((x) => x.json());
        if (!r.ok) throw new Error(r.error || "upload failed");
        nm.textContent = `✅ Saved: ${r.upload.id}`; S.file = null; $("cs-file").value = ""; await showImage(r.upload.id); loadList();
      } catch (e) { nm.textContent = "⚠️ " + ((e && e.message) || e); }
    }
    await loadLesson(S.sym, date);
  }
  async function loadList() {
    const box = $("cs-list"); if (!box) return;
    try {
      const { uploads } = await fetchJSON("/api/chart-school/uploads", 15000);
      box.innerHTML = (uploads || []).length ? uploads.map((u) => `<div class="cs-li"><button type="button" class="one-btn" data-cs-open="${esc(u.id)}" data-sym="${esc(u.symbol)}" data-date="${esc(u.date)}">📷 ${esc(u.date)} · ${u.symbol === "^NSEI" ? "NIFTY" : "SENSEX"}</button><button type="button" class="one-btn" data-cs-del="${esc(u.id)}" aria-label="हटाएँ">✕</button></div>`).join("") : `<p class="lrn-hint">अभी कोई screenshot नहीं।</p>`;
    } catch { box.innerHTML = `<p class="lrn-hint">list नहीं मिली</p>`; }
  }
  function setFile(f) { if (!f || !/^image\/(png|jpeg|webp)$/.test(f.type)) return; S.file = f; const nm = $("cs-fname"); if (nm) nm.textContent = `📎 ${f.name || "pasted image"} (${Math.round(f.size / 1024)} KB) — "Lesson बनाएँ" दबाएँ`;
    const img = $("cs-img"), fig = $("cs-shot"); if (img && fig) { if (S.img) URL.revokeObjectURL(S.img); S.img = URL.createObjectURL(f); img.src = S.img; fig.hidden = false; } }

  window.csMount = (host) => {
    if (!host) return;
    if (S.host !== host) { if (S.C) { try { S.C.ch.remove(); } catch {} S.C = null; } S.host = host; shell(); loadList(); }
  };
  document.addEventListener("change", (e) => { if (S.host && e.target && e.target.id === "cs-file") setFile(e.target.files && e.target.files[0]); });
  document.addEventListener("submit", (e) => { if (S.host && e.target && e.target.id === "cs-form") { e.preventDefault(); submit(); } });
  document.addEventListener("paste", (e) => {
    if (!S.host || !S.host.offsetParent) return;
    const it = [...((e.clipboardData && e.clipboardData.items) || [])].find((x) => /^image\//.test(x.type)); if (!it) return;
    e.preventDefault(); setFile(it.getAsFile());
  });
  document.addEventListener("click", (e) => {
    if (!S.host) return;
    const b = e.target.closest("[data-cs-sym],[data-cs-ev],[data-cs-open],[data-cs-del],[data-cs-say]"); if (!b || !S.host.contains(b)) return;
    if (b.dataset.csSym) { S.sym = b.dataset.csSym; paintSym(); }
    else if (b.dataset.csEv != null) { const n = Number(b.dataset.csEv); S.focus = n && n !== S.focus ? n : null; render(); draw(); if (S.focus) $("cs-chart")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    else if (b.dataset.csOpen) { S.sym = b.dataset.sym; paintSym(); $("cs-date").value = b.dataset.date; showImage(b.dataset.csOpen); loadLesson(b.dataset.sym, b.dataset.date); }
    else if (b.dataset.csDel) { if (confirm("यह screenshot हटाएँ?")) fetch("/api/chart-school/upload/" + encodeURIComponent(b.dataset.csDel), { method: "DELETE" }).then(loadList); }
    else if (b.dataset.csSay && S.data && S.data.available && typeof window.oneSay === "function") window.oneSay([...S.data.summary, ...S.data.events.map((x) => `${x.n}. ${x.title}. ${x.lesson}`)].join(" "));
  });
  let rz = 0; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.data) draw(); }, 250); });
})();
