// ============================ 🗺️ SCENARIO MAP — One Trade tab (owner, 2026-10-28) ============================
// The next session's what-ifs on a TradingView-style chart: gap down / up 50–100, a flat open that falls / rises, and the
// liquidity-sweep pools. Each scenario draws its branches (dashed paths into the next session, labelled with the measured
// probability), the levels where the market may hold / break / recover, the sweep zones and the 1:2 trade (target 40 /
// SL 20 NIFTY points) lines. Data: /api/one-trade/scenarios (backend premium/scenarioMap.ts, odds from 2 years of real
// Dhan 1-min data). Refreshes every 5 min while the tab is open. Advisory only.
(function () {
  "use strict";
  const IST = 19800;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const f0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
  const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const S = { rv: store.get("scn-rv", "1") === "1", rvFocus: null, wi: {}, auto: {}, spoke: {}, last: {}, host: null, sym: store.get("scn-sym", "^NSEI"), sel: store.get("scn-sel", "GAP_DOWN"), br: null, tr: null, data: {}, err: null, C: null, timer: null, sig: "" };
  const DAYS = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayLbl = (d) => { const x = new Date(d + "T00:00:00Z"); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
  const at = (day, m) => Date.parse(day + "T00:00:00Z") / 1000 + m * 60;   // IST wall-clock as chart time
  const cur = () => S.data[S.sym];
  const scen = () => { const d = cur(); return d && d.scenarios ? d.scenarios.find((s) => s.id === S.sel) || d.scenarios[0] : null; };

  // ------------------------------------------------------------ shell (built once per mount; the chart node is never replaced)
  function shell() {
    S.host.innerHTML = `<section class="one-card scn" aria-label="Scenario map">
      <div class="scn-head"><div class="scn-ttl"><h3 class="one-h">🗺️ Scenario Map</h3><span class="scn-for" id="scn-for"></span></div>
        <form class="scn-wi" id="scn-wi"><label for="scn-wi-in">🔮 Opening अनुमान</label><input id="scn-wi-in" type="number" inputmode="decimal" step="any" min="1" placeholder="जैसे GIFT Nifty से"><button type="submit" class="one-btn">देखें</button><button type="button" class="one-btn" data-scn-wi="clear" aria-label="अनुमान हटाएँ">✕</button></form>
        <div class="scn-idx" role="tablist" aria-label="Index">${[["^NSEI", "NIFTY"], ["^BSESN", "SENSEX"]].map(([s, n]) => `<button type="button" role="tab" data-scn-sym="${s}">${n}</button>`).join("")}</div></div>
      <div id="scn-open"></div>
      <div class="scn-chips" role="tablist" aria-label="Scenario" id="scn-chips"></div>
      <div class="scn-rvbar"><button type="button" class="one-btn" data-scn-rv="toggle" id="scn-rv-btn"></button><span class="one-mu">chart पर: <b class="rv-real">▲▼ 🔄 असली पलटाव</b> · <b class="rv-fake">❌ झूठा पलटाव</b> · <b class="rv-weak">↔ sideways</b> · <b class="rv-pend">⏳ पुष्टि बाकी</b></span></div>
      <div class="scn-body"><div class="scn-cw"><div class="scn-legend" id="scn-legend"></div><div class="scn-chart" id="scn-chart"></div></div><div class="scn-panel" id="scn-panel"><p class="one-mu">लोड हो रहा है…</p></div></div>
      <div id="scn-rev"></div>
      <p class="scn-foot one-mu" id="scn-foot"></p></section>`;
  }

  function chart() {
    if (S.C || typeof LightweightCharts === "undefined") return S.C;
    const el = document.getElementById("scn-chart"); if (!el) return null;
    const ch = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: "#131722" }, textColor: "#b2b5be", fontSize: 12 },
      grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } }, rightPriceScale: { borderColor: "#2a2e39", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, rightOffset: 2 }, crosshair: { mode: 0 },
      localization: { priceFormatter: (p) => Math.round(p).toLocaleString("en-IN"), timeFormatter: (t) => new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ") } });
    const c = ch.addCandlestickSeries({ upColor: "#089981", downColor: "#F23645", wickUpColor: "#089981", wickDownColor: "#F23645", borderVisible: false, priceLineVisible: false });
    S.C = { ch, c, lines: [], pls: [] };
    return S.C;
  }

  // ------------------------------------------------------------ chart drawing for the selected scenario
  function draw() {
    const d = cur(), s = scen(), C = chart(); if (!d || !d.available || !s || !C) return;
    const narrow = (document.getElementById("scn-chart")?.clientWidth || 999) < 560;   // phone: numbers only on the axis, no marker text
    const sig = `${S.sym}|${s.id}|${S.br}|${S.tr}|${d.nowSec}|${narrow}|${S.rv}|${S.rvFocus}`; if (sig === S.sig) return; S.sig = sig;
    for (const l of C.lines) C.ch.removeSeries(l); C.lines = [];
    for (const p of C.pls) C.c.removePriceLine(p); C.pls = [];
    const bars = d.candles.map((b) => ({ time: b.time + IST, open: b.open, high: b.high, low: b.low, close: b.close })), last = bars.length ? bars[bars.length - 1].time : 0;
    const fut = []; for (let m = 555; m <= 915; m += 15) { const t = at(d.targetDay, m); if (t > last) fut.push({ time: t }); }
    C.c.setData([...bars, ...fut]);
    // 🔄 reversal / ❌ fake-reversal candles (backend premium/reversalRead.ts)
    C.c.setMarkers(S.rv ? (d.reversals || []).slice().sort((a, b) => a.time - b.time).map((r) => {
      const up = r.dir === "UP", on = r.time === S.rvFocus, st = RV[r.status] || RV.PENDING;
      return { time: r.time + IST, position: up ? "belowBar" : "aboveBar", color: on ? "#ffffff" : st.color, size: on ? 2 : 1,
        shape: r.status === "REAL" ? (up ? "arrowUp" : "arrowDown") : "circle", text: narrow ? st.icon : `${st.icon} ${st.short}` };
    }) : []);
    // branches: the focused one solid + labelled, the rest dashed
    const focus = S.br && s.branches.some((b) => b.id === S.br) ? S.br : s.branches[0] && s.branches[0].id;
    const startPt = !d.targetIsToday && bars.length ? [{ time: last, value: d.base.close }] : [];
    for (const b of s.branches) {
      const on = b.id === focus, pts = b.path.map((w) => ({ time: at(d.targetDay, w.m), value: w.p })).filter((x) => x.time > (startPt[0]?.time ?? 0));
      const ser = C.ch.addLineSeries({ color: b.color, lineWidth: on ? 3 : 2, lineStyle: on ? 0 : 2, priceLineVisible: false, lastValueVisible: true,
        title: b.prob != null ? `${Math.round(b.prob)}%` : "", crosshairMarkerVisible: false });
      ser.setData(s.id === "SWEEP" ? pts : [...startPt, ...pts]);
      if (on) ser.setMarkers(b.path.filter((w) => w.note && w.note !== "Open").map((w) => ({ time: at(d.targetDay, w.m), position: w.p >= (b.path[0]?.p ?? 0) ? "aboveBar" : "belowBar", color: b.color, shape: "circle", text: narrow ? "" : w.note })));
      C.lines.push(ser);
    }
    const pl = (price, color, title, style = 2, width = 1, keep) => { if (price != null && isFinite(price)) C.pls.push(C.c.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title: narrow && !keep ? "" : title })); };
    const isOpen = d.opening && d.opening.scenario === s.id;
    if (isOpen) pl(s.open, "#f5c542", `${/what-if/.test(d.opening.source) ? "🔮" : "🔔"} Opening ${f0(s.open)}`, 0, 2, true);
    else if (s.id !== "FALL" && s.id !== "RISE" && s.id !== "SWEEP") pl(s.open, "#787b86", `Open ≈ ${f0(s.open)}`, 1);
    const shown = new Set();
    for (const l of s.levels) { shown.add(l.key); pl(l.price, l.role === "S" ? "#26a69a" : "#ef5350", `${short(l)} · ${l.holdPct >= l.breakPct ? (l.role === "S" ? "टिके " : "रुके ") + l.holdPct : "टूटे " + l.breakPct}%`, 2); }
    if (!narrow) for (const l of d.levels) if (!shown.has(l.key) && (l.kind === "OI" || l.kind === "MP" || l.key === "PDC")) pl(l.price, l.kind === "OI" ? "#7e57c2" : l.kind === "MP" ? "#ba68c8" : "#787b86", short(l), 3);
    for (const z of s.sweep || []) pl(z.price, "#ffb300", `💧 sweep ${Math.round(z.pct)}%`, 3);
    const t = s.trades.find((x) => x.id === S.tr) || bestTrade(s);
    if (t) { pl(t.entry, "#2962ff", narrow ? t.side : `${t.side} entry ${f0(t.entry)}`, 0, 2, true); pl(t.stop, "#f23645", "SL", 0, 1, true); pl(t.target, "#089981", "🎯", 0, 2, true); }
    const n = bars.length + fut.length, base = d.candles.filter((b) => new Date((b.time + IST) * 1000).toISOString().slice(0, 10) === d.base.day).length;
    const fi = S.rvFocus != null ? bars.findIndex((b) => b.time === S.rvFocus + IST) : -1;
    C.ch.timeScale().setVisibleLogicalRange(fi >= 0 ? { from: Math.max(0, fi - 14), to: fi + 14 } : { from: Math.max(0, n - fut.length - base - 6), to: n + 1 });
    legend(d, s, focus);
  }
  const RV = { REAL: { icon: "🔄", short: "पलटाव", color: "#26a69a", hi: "असली पलटाव" }, FAKE: { icon: "❌", short: "झूठा", color: "#ff9800", hi: "झूठा पलटाव (trap)" },
    WEAK: { icon: "↔", short: "sideways", color: "#9598a1", hi: "ज़ोर नहीं (sideways)" }, PENDING: { icon: "⏳", short: "पुष्टि बाकी", color: "#f5c542", hi: "पुष्टि बाकी (अगला 1 घंटा)" } };
  function renderRev(d) {
    const el = document.getElementById("scn-rev"), btn = document.getElementById("scn-rv-btn"); if (!el) return;
    if (btn) { btn.textContent = S.rv ? "🔄 Reversal candles: चालू" : "🔄 Reversal candles: बंद"; btn.classList.toggle("on", S.rv); btn.setAttribute("aria-pressed", S.rv); }
    if (!S.rv) { el.innerHTML = ""; return; }
    const rs = (d.reversals || []).slice().sort((a, b) => b.time - a.time), st = d.reversalStats, k = { REAL: 0, FAKE: 0, WEAK: 0, PENDING: 0 };
    for (const r of rs) k[r.status]++;
    const day = (t) => dayLbl(new Date((t + IST) * 1000).toISOString().slice(0, 10)), hmT = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
    const base = st ? `<p class="scn-rv-base">📊 <b>2 साल में ऐसी ${st.all.n} candles:</b> 🔄 असली <b>${st.all.realPct}%</b> · ❌ झूठी <b>${st.all.fakePct}%</b> · ↔ sideways ${st.all.weakPct}% — कल के H/L/C पर बनी तो असली सिर्फ़ ${st.atLevel.realPct}% (level अपने आप में भरोसा नहीं)। <b>इसलिए पलटाव की candle पर नहीं, अगली candle की पुष्टि पर entry।</b></p>` : "";
    el.innerHTML = `<details class="scn-rv" open><summary><h4 class="scn-h">🔄 Reversal और ❌ Fake reversal candles <span class="one-mu">(15-min · ${rs.length} · 🔄 ${k.REAL} · ❌ ${k.FAKE} · ↔ ${k.WEAK} · ⏳ ${k.PENDING})</span></h4></summary>${base}
      ${rs.length ? `<ol class="scn-rv-list">${rs.map((r) => { const x = RV[r.status] || RV.PENDING; return `<li><button type="button" data-scn-rvf="${r.time}" class="${r.time === S.rvFocus ? "on" : ""} rv-${r.status}" aria-pressed="${r.time === S.rvFocus}">
        <span class="scn-rv-h"><span class="scn-rv-st" style="border-color:${x.color};color:${x.color}">${x.icon} ${x.hi}</span><b>${r.dir === "UP" ? "▲ ऊपर की ओर" : "▼ नीचे की ओर"}</b><time>${day(r.time)} ${hmT(r.time)}</time></span>
        <span class="cs-chips"><span class="one-chip">🕯️ ${esc(r.pattern)}</span>${r.level ? `<span class="one-chip">📏 ${esc(r.level.label)} ${f0(r.level.price)}</span>` : ""}<span class="one-chip">पहले ${r.priorMove} pts ${r.dir === "UP" ? "गिरा" : "चढ़ा"}</span></span>
        <span>${esc(r.text)}</span><span class="one-mu">🧠 ${esc(r.lesson)}</span></button></li>`; }).join("")}</ol>` : `<p class="one-mu">इन दिनों में कोई पलटाव candle नहीं बनी।</p>`}
      <p class="one-mu">पहचान: 3 candles की चाल (आम candle से 1.2 गुना) के बाद नया high/low बनाकर उल्टा बंद होना (hammer / shooting star / engulfing / मज़बूत close)। फ़ैसला अगले 1 घंटे (4 candles) से: पुरानी तरफ़ 15-min close = ❌ झूठा, नई तरफ़ एक आम candle जितनी चाल = 🔄 असली। Trade signal नहीं — पढ़ने में मदद।</p></details>`;
  }
  const short = (l) => ({ PDH: "PDH", PDL: "PDL", PDC: "PDC", WH: "5D High", WL: "5D Low", CALL_WALL: "Call wall", PUT_WALL: "Put wall", MAX_PAIN: "Max pain" })[l.key] || "Round " + f0(l.price);
  const bestTrade = (s) => s.trades.filter((x) => x.verdict === "GOOD").sort((a, b) => b.avgPts - a.avgPts)[0] || s.trades[0] || null;

  function legend(d, s, focus) {
    const el = document.getElementById("scn-legend"); if (!el) return;
    el.innerHTML = `<b>${esc(d.index)}</b> · 15m · ${esc(s.icon)} ${esc(s.title)}<br>${s.branches.map((b) => `<span class="${b.id === focus ? "on" : ""}"><i style="background:${b.color}"></i>${b.prob != null ? Math.round(b.prob) + "%" : "—"}</span>`).join("")}`;
  }

  // ------------------------------------------------------------ chips + side panel
  function render() {
    if (!S.host) return;
    const d = cur();
    S.host.querySelectorAll("[data-scn-sym]").forEach((b) => { const on = b.dataset.scnSym === S.sym; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    const panel = document.getElementById("scn-panel"), chips = document.getElementById("scn-chips"), forEl = document.getElementById("scn-for"), foot = document.getElementById("scn-foot");
    if (!d) { panel.innerHTML = `<p class="one-mu">${esc(S.err || "लोड हो रहा है…")}</p>`; return; }
    if (!d.available) { panel.innerHTML = `<p class="one-mu">${esc(d.error || "डेटा उपलब्ध नहीं")}</p>`; return; }
    const ob = document.getElementById("scn-open"), istMin = Math.floor(((Date.now() / 1000 + IST) % 86400) / 60);
    if (ob) ob.innerHTML = d.opening ? `<div class="scn-ob"><div class="one-row"><span class="one-badge ${d.opening.gapPts < 0 ? "pe" : d.opening.bucket === "FLAT" ? "wait" : "ce"}">${/what-if/.test(d.opening.source) ? "🔮 अगर opening" : "🔔 Opening"} ${f0(d.opening.price)} · ${esc(d.opening.label)}</span><span class="one-mu">${esc(d.opening.source)}</span><button type="button" class="one-btn" data-scn-say="open">📢 सुनाएँ</button></div><ol>${d.opening.review.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>`
      : d.targetIsToday && istMin < 556 ? `<div class="scn-ob wait"><span class="one-badge wait">⏳ 09:11 पर आज का opening number आएगा</span> <span class="one-mu">Gap up / down देखकर यह map अपने आप बदल जाएगा।</span></div>` : "";
    forEl.textContent = `${d.targetIsToday ? "आज" : "अगला session"} · ${dayLbl(d.targetDay)} · base ${dayLbl(d.base.day)} (H ${f0(d.base.high)} · L ${f0(d.base.low)} · C ${f0(d.base.close)})`;
    chips.innerHTML = d.scenarios.map((s) => `<button type="button" role="tab" data-scn-sel="${s.id}" class="${s.id === S.sel ? "on" : ""}" aria-selected="${s.id === S.sel}"><span>${esc(s.icon)} ${esc(chipName(s, d))}</span><small>${s.chance != null ? Math.round(s.chance) + "% दिन" : "stop pools"}</small></button>`).join("");
    const s = scen(); if (!s) return;
    const focus = S.br && s.branches.some((b) => b.id === S.br) ? S.br : s.branches[0] && s.branches[0].id, bt = s.trades.find((x) => x.id === S.tr) || bestTrade(s);
    const br = s.branches.map((b) => `<li><button type="button" data-scn-br="${b.id}" class="${b.id === focus ? "on" : ""}" aria-pressed="${b.id === focus}"><i class="sw" style="background:${b.color}"></i><span class="nm">${esc(b.name)}</span><b>${b.prob != null ? Math.round(b.prob) + "%" : "—"}</b>
      <span class="bar"><i style="width:${Math.max(2, Math.min(100, b.prob || 0))}%;background:${b.color}"></i></span><small>${esc(b.probNote)}</small></button></li>`).join("");
    const tr = s.trades.map((t) => `<button type="button" class="scn-tr ${t.side === "CE" ? "ce" : "pe"} ${t === bt ? "on" : ""} v-${t.verdict}" data-scn-tr="${t.id}" aria-pressed="${t === bt}">
      <span class="scn-trh"><span class="one-badge ${t.side === "CE" ? "ce" : "pe"}">${t.side} ${t.strike}</span><span class="scn-v">${esc(t.verdictText)}</span></span>
      <span class="scn-trl">${esc(t.label)}</span>
      <span class="scn-g"><span><i>Entry${t.approx ? " ≈" : ""}</i><b>${f0(t.entry)}</b></span><span><i>🛑 SL</i><b class="one-dn">${f0(t.stop)}</b></span><span><i>🎯 Target</i><b class="one-up">${f0(t.target)}</b></span></span>
      <span class="one-mu">${esc(t.when)} · पिछले ${t.n} बार: जीत <b>${t.win}%</b> · औसत <b class="${t.avgPts > 0 ? "one-up" : "one-dn"}">${t.avgPts > 0 ? "+" : ""}${t.avgPts}</b> pts</span></button>`).join("");
    const lv = s.levels.slice().sort((a, b) => b.price - a.price).map((l) => `<li class="${l.role}"><span class="scn-lp"><b>${f0(l.price)}</b><span class="one-chip ${l.role === "S" ? "one-up" : "one-dn"}">${l.role === "S" ? "Support" : "Resistance"}</span></span><span class="scn-ln">${esc(l.label)}</span>
      <span class="scn-st"><span title="टिके / रुके">✋ ${l.holdPct}%</span><span title="टूटे">💥 ${l.breakPct}%</span><span title="sweep फिर पलटा">💧 ${l.sweepPct}%</span><span title="टूटने के बाद वापसी">↩ ${l.recoverPct}%</span></span></li>`).join("");
    panel.innerHTML = `<div class="scn-pt"><h4>${esc(s.icon)} ${esc(s.title)}</h4><span class="one-mu">${esc(s.chanceNote)}</span></div>
      <h5 class="scn-h">📊 क्या हो सकता है <span class="one-mu">(chart पर line चुनें)</span></h5><ul class="scn-br">${br}</ul>
      ${s.trades.length ? `<h5 class="scn-h">💰 Trade — 1:2 (target +${Math.round(d.tgt)} · SL ${Math.round(d.sl)} points)</h5><div class="scn-trs">${tr}</div>` : ""}
      ${lv ? `<h5 class="scn-h">📍 Levels <span class="one-mu">✋ टिके · 💥 टूटे · 💧 sweep · ↩ वापसी</span></h5><ul class="scn-lv">${lv}</ul>` : ""}
      <h5 class="scn-h">🎙 ProTrader की बात</h5><ol class="scn-story">${s.story.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
      <button type="button" class="one-btn" data-scn-say="1">📢 यह scenario सुनाएँ</button>`;
    renderRev(d);
    foot.innerHTML = `${(d.honesty || []).map(esc).join(" · ")}<br>Data: ${esc(d.source)} · research/protrader/RESULTS_SCENARIO.md`;
    draw();
  }
  const chipName = (s, d) => ({ GAP_DOWN: `Gap Down ${Math.round(50 * d.k)}–${Math.round(100 * d.k)}`, GAP_UP: `Gap Up ${Math.round(50 * d.k)}–${Math.round(100 * d.k)}`, FALL: "बाज़ार गिरे", RISE: "बाज़ार चढ़े", SWEEP: "Liquidity Sweep" })[s.id] || s.title;

  async function load() {
    const sym = S.sym;
    S.last[sym] = Date.now();
    try {
      const d = await fetchJSON("/api/one-trade/scenarios?symbol=" + encodeURIComponent(sym) + (S.wi[sym] ? "&open=" + S.wi[sym] : ""), 30000);
      if (d) {
        S.data[sym] = d; S.err = null; S.sig = "";
        const isWi = d.opening && /what-if/.test(d.opening.source), ok = d.opening ? `${sym}|${d.targetDay}|${isWi ? "wi" + d.opening.price : d.opening.at}` : null;
        if (ok && sym === S.sym && !S.auto[ok]) { S.auto[ok] = 1; S.sel = d.opening.scenario; S.br = S.tr = null; }   // today's opening picks the scenario once; the owner can still switch
        if (ok && !isWi && !S.spoke[ok]) { S.spoke[ok] = 1; let v = false; try { v = localStorage.getItem("one-voice") === "1"; } catch {} if (v && typeof window.oneSay === "function" && sym === S.sym) window.oneSay(d.opening.review.join(" ")); }
        if (sym === S.sym) render();
      }
    }
    catch (e) { S.err = String((e && e.message) || e); if (sym === S.sym) render(); }
  }

  let rz = 0; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.host) draw(); }, 250); });
  window.scnMount = (host) => {
    clearInterval(S.timer); S.timer = null;
    if (!host) { if (S.C) { try { S.C.ch.remove(); } catch {} S.C = null; } S.host = null; return; }
    if (S.host !== host || !host.querySelector("#scn-chart")) { if (S.C) { try { S.C.ch.remove(); } catch {} S.C = null; } S.host = host; shell(); }
    S.sig = ""; render(); load();
    S.timer = setInterval(() => {
      if (document.hidden || !S.host || !S.host.offsetParent) return;
      const m = Math.floor(((Date.now() / 1000 + IST) % 86400) / 60), morning = m >= 540 && m <= 575;
      if (morning || Date.now() - (S.last[S.sym] || 0) >= 300000) load();
    }, 30000);
  };
  document.addEventListener("submit", (e) => {
    if (!S.host || e.target.id !== "scn-wi") return; e.preventDefault();
    const v = Number(document.getElementById("scn-wi-in").value); S.wi[S.sym] = v > 0 ? v : null; load();
  });
  document.addEventListener("click", (e) => {
    if (!S.host) return;
    if (e.target.closest("[data-scn-wi]") && S.host.contains(e.target)) { S.wi[S.sym] = null; const i = document.getElementById("scn-wi-in"); if (i) i.value = ""; load(); return; }
    const b = e.target.closest("[data-scn-sym],[data-scn-sel],[data-scn-br],[data-scn-tr],[data-scn-say],[data-scn-rv],[data-scn-rvf]"); if (!b || !S.host.contains(b)) return;
    if (b.dataset.scnRv) { S.rv = !S.rv; S.rvFocus = null; store.set("scn-rv", S.rv ? "1" : "0"); render(); return; }
    if (b.dataset.scnRvf) { const t = Number(b.dataset.scnRvf); S.rvFocus = S.rvFocus === t ? null : t; render(); if (S.rvFocus) document.getElementById("scn-chart")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
    if (b.dataset.scnSym) { S.rvFocus = null; }
    if (b.dataset.scnSym) { S.sym = b.dataset.scnSym; store.set("scn-sym", S.sym); S.br = S.tr = null; S.sig = ""; const i = document.getElementById("scn-wi-in"); if (i) i.value = S.wi[S.sym] || ""; render(); load(); }
    else if (b.dataset.scnSel) { S.sel = b.dataset.scnSel; store.set("scn-sel", S.sel); S.br = S.tr = null; render(); }
    else if (b.dataset.scnBr) { S.br = b.dataset.scnBr; render(); }
    else if (b.dataset.scnTr) { S.tr = b.dataset.scnTr; render(); }
    else if (b.dataset.scnSay === "open") { const d = cur(); if (d && d.opening && typeof window.oneSay === "function") window.oneSay(d.opening.review.join(" ")); }
    else if (b.dataset.scnSay) { const s = scen(); if (s && typeof window.oneSay === "function") window.oneSay(`${s.title}. ${s.story.join(" ")}`); }
  });
})();
