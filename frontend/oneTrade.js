// ============================ 🎯 ONE TRADE — Market Command tab (owner, 2026-10-28) ============================
// One trade at a time across NIFTY + SENSEX, fixed 1:2 target, Hindi commentary on every event with voice (the browser's
// speech engine, hi-IN). Data: /api/one-trade (backend premium/oneTrade.ts, followed by the co-pilot job every tick).
// Polls every 15 s only while the tab is open. Advisory only — no order is placed.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const IST = 19800;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const f0 = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
  const rs = (v) => (v == null || !isFinite(v) ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));
  const sgn = (v, unit) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + (unit || "") + Math.abs(Math.round(v)).toLocaleString("en-IN"));
  const hm = (t) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
  const O = { host: null, timer: null, data: null, spoken: new Set(), primed: false };
  const VKEY = "one-voice", LKEY = "one-lots";
  const lots = () => { try { const n = Number(localStorage.getItem(LKEY)); return n >= 1 && n <= 50 ? Math.round(n) : 1; } catch { return 1; } };
  // 🎯 One Trade mode (default on): every other screen hides its trade calls (styles.css body.ot-mode, plus the chart code)
  const MKEY = "one-mode";
  window.oneMode = () => { try { return localStorage.getItem(MKEY) !== "0"; } catch { return true; } };
  function applyMode() {
    document.body.classList.toggle("one-mode", window.oneMode());
    // a hidden trade-only screen that is open (e.g. restored from last time) → back to Market Command
    const HIDDEN = ["tradeexec", "paper", "toppicks", "aipdash", "aipsignals", "aipreview", "aipperf", "aipvalid"], cur = document.querySelector(".tab.active")?.dataset.tab;
    if (window.oneMode() && cur && HIDDEN.includes(cur) && typeof switchTab === "function") { try { switchTab("marketcommand"); } catch {} }
    try { if (typeof MC !== "undefined") { MC._boSig = null; MC._overlaySig = null; if (MC.lastData && typeof renderMCChart === "function") renderMCChart(MC.lastData); } } catch {}
    try { if (typeof window.mcxDrawPlanLevels === "function") window.mcxDrawPlanLevels(); } catch {}
  }
  if (document.body) applyMode(); else document.addEventListener("DOMContentLoaded", applyMode);
  const voiceOn = () => { try { return localStorage.getItem(VKEY) === "1"; } catch { return false; } };

  // ------------------------------------------------------------ voice (Hindi): emojis and tags stripped; ₹ read as रुपये
  function say(text) {
    if (!("speechSynthesis" in window) || !text) return;
    const clean = String(text).replace(/<[^>]+>/g, "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/₹\s?(\d[\d,]*)/g, "$1 रुपये").replace(/−/g, "माइनस ").replace(/\s+/g, " ").trim();
    const u = new SpeechSynthesisUtterance(clean); u.lang = "hi-IN"; u.rate = 0.95;
    const v = speechSynthesis.getVoices().find((x) => /^hi(-|_)?IN/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^hi/i.test(x.lang)); if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  function summaryText(d) {
    const t = d.trade, L = d.live || {};
    if (t) return `${t.name} ${t.strike} ${t.side} चालू है। Entry ${rs(t.entryPrem)}, अभी ${rs(L.prem)}, ${lots()} lot पर ${sgn(L.pnlLot != null ? L.pnlLot * lots() : null, "₹")}। Stop loss ${f0(t.stop)}, target ${f0(t.target)}।`;
    const w = (d.waiting || [])[0];
    return `अभी कोई trade नहीं है। ${(d.waiting || []).map((x) => `${x.index}: ${String(x.headline || "").replace(/<[^>]+>/g, "")}`).join(" ")}`.trim() || (w ? "" : "अभी कोई trade नहीं है।");
  }

  // ------------------------------------------------------------ render
  function render() {
    const host = O.host, d = O.data; if (!host) return;
    if (!d) { host.innerHTML = `<section class="one-card"><p class="one-mu">लोड हो रहा है…</p></section>`; return; }
    if (!d.available) { host.innerHTML = `<section class="one-card"><p class="one-mu">${esc(d.error || "डेटा उपलब्ध नहीं")}</p></section>`; return; }
    const t = d.trade, L = d.live || {}, von = voiceOn();
    const bar = `<div class="one-bar" role="toolbar" aria-label="Voice"><button type="button" class="one-btn${von ? " on" : ""}" data-one="voice" aria-pressed="${von}">${von ? "🔊 आवाज़ चालू" : "🔇 आवाज़ बंद"}</button><button type="button" class="one-btn" data-one="say">📢 अभी की स्थिति सुनाएँ</button><button type="button" class="one-btn${window.oneMode() ? " on" : ""}" data-one="mode" aria-pressed="${window.oneMode()}" title="On: trade calls appear only on this tab; other screens show market information only, and trade-only screens (Trade Execution, AI Paper, Top Pick) leave the menu">${window.oneMode() ? "🎯 Trade सिर्फ़ इस tab पर" : "👁 सभी screens पर trades"}</button><label class="one-mu" for="one-lots">Lots</label><select id="one-lots" class="one-lots">${[1, 2, 3, 4, 5, 10].map((n) => `<option value="${n}"${n === lots() ? " selected" : ""}>${n}</option>`).join("")}</select><span class="one-mu">${esc(d.day)} · हर 15 सेकंड में update</span></div>`;
    let hero;
    if (t) {
      const ce = t.side === "CE", pos = L.r != null ? Math.max(0, Math.min(100, ((L.r + 1) / 3) * 100)) : null;   // −1R (stop) … +2R (target)
      hero = `<section class="one-card one-hero ${ce ? "ce" : "pe"}" aria-label="Open trade">
        <div class="one-row"><span class="one-badge ${ce ? "ce" : "pe"}">🎯 TRADE चालू</span><h2 class="one-title">${esc(t.name)} ${t.strike} ${t.side}</h2><span class="one-mu">${hm(t.openedAt)} से${t.review ? ` · review ${esc(t.review)}` : ""}</span></div>
        <div class="one-grid">
          <span><i>Entry</i><b>${rs(t.entryPrem)}</b><small>index ${f0(t.entrySpot)}</small></span>
          <span><i>अभी</i><b>${rs(L.prem)}</b><small>index ${f0(L.spot)}</small></span>
          <span><i>P&amp;L (${lots()} lot × ${L.lot || "—"})</i><b class="${(L.pnlLot || 0) >= 0 ? "one-up" : "one-dn"}">${sgn(L.pnlLot != null ? L.pnlLot * lots() : null, "₹")}</b><small>${sgn(L.pnl)} प्रति unit · ${L.r != null ? L.r.toFixed(2) + "R" : "—"}</small></span>
          <span><i>🛑 Stop loss</i><b class="one-dn">${f0(t.stop)}</b><small>15-min close · ≈ ${rs(t.stopPrem)}</small></span>
          <span><i>🎯 Target 1:2</i><b class="one-up">${f0(t.target)}</b><small>index touch · ≈ ${rs(t.targetPrem)}</small></span>
        </div>
        ${pos != null ? `<div class="one-track" aria-label="Stop to target"><span class="one-tk-sl">SL</span><span class="one-tk-en" style="left:33.3%">Entry</span><span class="one-tk-tg">Target</span><span class="one-tk-now" style="left:${pos}%" title="अभी"></span></div>` : ""}
        <p class="one-note">जब तक यह trade बंद नहीं होता (target, stop loss या 15:12), कोई नया trade नहीं।</p></section>`;
    } else {
      const wait = (d.waiting || []).map((w) => {
        const b = w.best, steps = b && b.steps && b.steps.length ? `<table class="one-steps"><tbody>${b.steps.map((x) => `<tr><th scope="row">${esc(x.k)}</th><td>${x.v}</td></tr>`).join("")}</tbody></table>` : "";
        return `<div class="one-wait"><div class="one-row"><b>${esc(w.index)}</b>${w.structure ? `<span class="one-chip">${esc(w.structure.label)}</span>` : ""}<span class="one-mu">${esc(w.asOf || "")}</span></div>
          <p>${w.headline || ""}</p>${b ? `<p class="one-btitle"><b>अगला मौका: ${esc(b.title)}</b></p>${steps}<p class="one-mu">${b.why || ""}</p>` : ""}</div>`;
      }).join("");
      hero = `<section class="one-card" aria-label="Waiting"><div class="one-row"><span class="one-badge wait">⏳ इंतज़ार</span><h2 class="one-title">अभी कोई trade नहीं</h2></div>
        <p class="one-note">System NIFTY और SENSEX दोनों देख रहा है। 15-min close + 5-min retest + review पास होते ही <b>एक</b> trade यहाँ आएगा।</p>${wait ? `<div class="one-waits">${wait}</div>` : ""}</section>`;
    }
    const ev = (d.events || []).slice().reverse();
    const feed = `<section class="one-card" aria-label="Commentary"><h3 class="one-h">🎙 Hindi commentary</h3>${ev.length ? `<ol class="one-feed">${ev.map((e, i) => `<li class="k-${esc(e.kind)}"><time>${hm(e.t)}</time><p>${esc(e.text)}</p><button type="button" class="one-play" data-one-say="${ev.length - 1 - i}" aria-label="सुनें">▶</button></li>`).join("")}</ol>` : `<p class="one-mu">आज अभी कोई trade event नहीं।</p>`}</section>`;
    const cl = d.closed || [];
    const done = `<section class="one-card" aria-label="Today's trades"><h3 class="one-h">📒 आज के trades</h3>${cl.length ? `<div class="one-tbl"><table><thead><tr><th>समय</th><th>Trade</th><th>Entry</th><th>Exit</th><th>नतीजा</th><th>${lots()} lot</th></tr></thead><tbody>${cl.map((x) => { const lot = (x.symbol === "^BSESN" ? 20 : 75) * lots(), pl = x.exitPrem != null && x.entryPrem != null ? (x.exitPrem - x.entryPrem) * lot : null; return `<tr><td>${hm(x.openedAt)}–${x.closedAt ? hm(x.closedAt) : ""}</td><td>${esc(x.name)} ${x.strike} ${x.side}</td><td>${rs(x.entryPrem)}</td><td>${rs(x.exitPrem)}</td><td>${x.state === "TARGET" ? "🎯 Target" : x.state === "SL" ? "🛑 SL" : "⏰ Time"}</td><td class="${(pl || 0) >= 0 ? "one-up" : "one-dn"}">${sgn(pl, "₹")}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="one-mu">आज अभी कोई trade बंद नहीं हुआ।</p>`}</section>`;
    const r = d.record || {};
    const how = `<details class="one-card one-how"><summary><h3 class="one-h">ℹ️ यह screen कैसे काम करता है</h3></summary>
      <ol>
        <li><b>एक समय पर एक trade:</b> NIFTY और SENSEX दोनों में से जो पहले सारी शर्तें पास करे, वही trade। जब तक वह बंद नहीं होता, दूसरा trade नहीं।</li>
        <li><b>Entry की शर्तें</b> (system के approved plan से): 15-min candle plan level के पार बंद हो → 30 मिनट में 5-min retest → Trade Review (A/B) → premium 10% से ज़्यादा न भागा हो → बाज़ार बहुत तेज़ न हो → 14:45 से पहले। Expiry day और range day पर trade नहीं।</li>
        <li><b>Stop loss:</b> plan का stop level — फ़ैसला 15-min candle के close पर, touch पर नहीं।</li>
        <li><b>Target 1:2:</b> entry ± 2 × (entry से stop की दूरी), index पर; पहुँचते ही पूरा बेचें। Premium वाले भाव delta से अनुमान हैं (≈)।</li>
        <li><b>Time exit 15:12।</b> Trade बंद होते ही अगला trade खुला।</li>
        <li><b>Commentary और आवाज़:</b> हर event (नया trade, आधा रास्ता, stop के पास, target / SL / time) हिंदी में लिखा और 🔊 चालू हो तो बोला जाता है। आवाज़ के लिए एक बार बटन दबाना ज़रूरी है (browser का नियम)।</li>
        <li><b>ईमानदार रिकॉर्ड</b> (2 साल, असली Dhan data, खर्च के बाद, प्रति lot): पिछला साल ${r.oneAtATimeVal ? `+₹${r.oneAtATimeVal.perTrade}/trade, PF ${r.oneAtATimeVal.pf}, जीत ${r.oneAtATimeVal.win}%` : "—"}; उससे पहले का साल ${r.oneAtATimeDev ? `−₹${Math.abs(r.oneAtATimeDev.perTrade)}/trade, PF ${r.oneAtATimeDev.pf}` : "—"}। पुराने T1/T2 तरीके से बेहतर, पर पक्का edge नहीं — सलाह मात्र, कोई order नहीं लगता।</li>
        <li>यह trade Telegram co-pilot का ही पहला trade है; Telegram के T1/T2 संदेश अलग नियम पर चलते हैं — इस screen पर 1:2 वाला नियम मानें।</li>
      </ol></details>`;
    const li = (a) => (a || []).map((x) => `<li>${x}</li>`).join("");   // server-built HTML (numbers + <b> only)
    const mk = (d.market || []).map((m) => `<div class="one-mk"><div class="one-row"><b>${esc(m.index)}</b>${m.structure ? `<span class="one-chip ${m.structure.bias === "UP" ? "one-up" : m.structure.bias === "DOWN" ? "one-dn" : ""}">${esc(m.structure.label)}</span>` : ""}<span class="one-mu">${esc(m.asOf || "")}</span></div>
        ${m.intro ? `<p>${m.intro}</p>` : ""}${m.structure ? `<p>${m.structure.text}</p>` : m.condition ? `<p><b>${esc(m.condition.label)}</b> — ${esc(m.condition.text)}</p>` : ""}
        <h4 class="one-h4">📺 क्या हुआ</h4><ul>${li(m.story)}</ul><h4 class="one-h4">🔗 Option chain</h4><ul>${li([...(m.oiRead || []), ...(m.market || [])])}</ul>
        ${m.lessons && m.lessons.length ? `<h4 class="one-h4">🧠 Junior के लिए सबक</h4><ol>${li(m.lessons)}</ol>` : ""}</div>`).join("");
    const market = mk ? `<details class="one-card one-market" open><summary><h3 class="one-h">📺 बाज़ार की live commentary (NIFTY · SENSEX)</h3></summary><div class="one-mks">${mk}</div></details>` : "";
    const html = bar + hero + feed + market + done + how;
    if (host.__one !== html) { host.innerHTML = html; host.__one = html; }
    // speak new events (only those that arrive after the first load, so the backlog is not read out)
    for (const e of d.events || []) { const k = e.t + "|" + e.kind; if (!O.primed) { O.spoken.add(k); continue; } if (!O.spoken.has(k)) { O.spoken.add(k); if (voiceOn()) say(e.text); } }
    O.primed = true;
  }

  async function load() {
    try { const d = await fetchJSON("/api/one-trade", 30000); if (d) { O.data = d; render(); } }
    catch (e) { if (!O.data) { O.data = { available: false, error: String((e && e.message) || e) }; render(); } }
  }
  window.oneMount = (host) => {
    clearInterval(O.timer); O.timer = null;
    if (!host) { O.host = null; return; }
    O.host = host; render(); load();
    O.timer = setInterval(() => { if (!document.hidden && O.host && !O.host.hidden) load(); }, 15000);
  };
  document.addEventListener("change", (e) => { if (e.target && e.target.id === "one-lots") { try { localStorage.setItem(LKEY, e.target.value); } catch {} if (O.host) { O.host.__one = null; render(); } } });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-one],[data-one-say]"); if (!b || !O.host || !O.host.contains(b)) return;
    if (b.dataset.one === "voice") { const on = !voiceOn(); try { localStorage.setItem(VKEY, on ? "1" : "0"); } catch {} if (on) say("आवाज़ चालू। हर trade की जानकारी अब बोली जाएगी।"); else if ("speechSynthesis" in window) speechSynthesis.cancel(); O.host.__one = null; render(); }
    else if (b.dataset.one === "mode") { try { localStorage.setItem(MKEY, window.oneMode() ? "0" : "1"); } catch {} applyMode(); O.host.__one = null; render(); }
    else if (b.dataset.one === "say") { if (O.data) say(summaryText(O.data)); }
    else if (b.dataset.oneSay != null) { const ev = (O.data && O.data.events) || [], x = ev[Number(b.dataset.oneSay)]; if (x) say(x.text); }
  });
})();
