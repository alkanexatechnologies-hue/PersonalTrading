// ============================ 📘 SCREEN RULES — Market Command tab after OI Analysis (owner, 2026-10-29) ============================
// Which screen gives trades and with what logic, in plain Hindi, for an owner who is not a trading expert. Static text taken
// from the engines' own rules (premium/oneTrade.ts, copilot.ts, traderView.ts, tradeReview.ts, expiryMode.ts, zeroHero.ts,
// c4Live.ts, decision/arbiter.ts, signals/breakoutEngine.ts, oi/oiMovement.ts, paper/entryRules.ts, optionTopPick/scanner.ts)
// and the test results in research/SUPERVISOR_LOG.md. Keep it in step when a rule changes. No data load.
(function () {
  "use strict";
  // [title, where, status class, status text, rows [label, text], record]
  const LIVE = [
    ["🎯 One Trade", "Market Command → 🎯 One Trade tab", "ok", "✅ ProTrader APPROVE — पर पक्का edge नहीं",
      [["Entry", "System के plan level के पार <b>15-min candle बंद</b> हो → 30 मिनट के अंदर <b>5-min retest</b> (भाव वापस level तक आए और उसी तरफ़ बंद हो) → Trade Review <b>A या B</b> → premium trigger के बाद 10% से ज़्यादा न भागा हो → बाज़ार बहुत तेज़ न हो (पिछले घंटे की candles 1.5× से बड़ी नहीं) → <b>14:45 से पहले</b>"],
       ["Stop loss", "Plan का stop level — फ़ैसला <b>15-min candle के close</b> पर, touch पर नहीं"],
       ["Target", "<b>1:2</b> — entry ± 2 × (entry से stop की दूरी), index पर; पहुँचते ही पूरा बेचें"],
       ["समय", "15:12 पर बाहर (time exit)"],
       ["कब नहीं", "एक trade चालू हो तो दूसरा नहीं (NIFTY + SENSEX मिलाकर एक) · Range day · Plan conflict · Review C"],
       ["Expiry day", "⚠️ 29 Oct से trade मिलता है (मालिक का फ़ैसला) — <b>HIGH RISK label, सिर्फ़ 1 lot</b>"]],
      "2 साल: पिछला साल +₹134/trade (PF 1.19), उससे पहले का साल −₹226/trade। तीनों-trades वाला तरीका REJECT (−₹6.2 लाख, 3 lot)।"],
    ["📱 Telegram co-pilot", "आपका Telegram", "ok", "✅ वही engine जो One Trade देता है",
      [["समय-सारणी", "09:12 key levels · 09:13 दिन का plan · 09:14 opening heat · trigger → retest → trade के संदेश · 15:30 दिन का हिसाब + ProTrader review · 15:31 अगले दिन का plan"],
       ["Target", "⚠️ Telegram अभी भी <b>T1 / T2</b> देता है: T1 छूते ही stop entry पर (breakeven), T2 पूरा। One Trade screen पर 1:2 वाला नियम मानें।"],
       ["Size", "Review B = आधा size"]],
      "पुराना T1/T2 तरीका 2 साल में घाटे में था (NIFTY −₹1.50 L, 1 lot); expiry skip + retest से घटकर −₹0.32 L हुआ।"],
    ["🎲 Expiry Mode", "Premium Prediction + Telegram (सिर्फ़ expiry के दिन)", "warn", "⚠️ Paper / 1 lot — फ़ायदा साबित नहीं",
      [["Entry", "10:30–13:30 · भाव दिन के open के ऊपर और 5-min EMA20 ऊपर झुका → 5-min candle EMA20 तक आए और ऊपर बंद हो = CE (उल्टा = PE) · दिन में ज़्यादा से ज़्यादा 2, एक समय पर एक"],
       ["Strike", "एक strike In-The-Money"],
       ["Exit (premium पर)", "−40% stop · 1.5× पर आधा बेचें, फिर stop entry पर · बाकी 2.5× पर · 40 मिनट में 1.5× न हो तो बाहर · 15:15 तक बाहर"]],
      "2 साल: कोई expiry तरीका फ़ायदे में साबित नहीं; अब तक forward 2 trades, दोनों जीते (+152)। 6–8 expiry अच्छी रहें तो ही size बढ़े।"],
  ];
  const HIDDEN = [
    ["⚡ Market Command — Live signal (Arbiter)", "मुख्य chart के पास (One Trade mode में छिपा)", "info", "ℹ️ अलग engine",
      [["Logic", "सिर्फ़ <b>बंद 5-min candles</b> → बाज़ार का regime → दो setups: S1 (Test Lab scorer, भाव की दिशा) और S2 (Breakout engine) → timing → evidence / EV gate → option की quality → एक फ़ैसला (BUY CE / BUY PE / WAIT)"],
       ["Entry", "S1 में अगली candle के open पर"]],
      "28 Oct: इसका CE trade SL पर (−₹23)।"],
    ["⚡ Market Command — Breakout तीर (chart पर)", "मुख्य chart (One Trade mode में छिपे)", "info", "ℹ️ अलग engine",
      [["Logic", "EMA / VWAP / UT Bot / LinReg / momentum / structure से <b>दिशा</b> → उस दिशा का पास वाला support/resistance → <b>बंद candle</b> level के पार (buffer + मज़बूत close) = CONFIRMED → बहुत आगे न भागा हो, SL structure पर, target अगली रुकावट के पार, R:R काफ़ी = BUY / SELL"]],
      ""],
    ["⚡ Market Command — C4", "मुख्य chart (One Trade mode में छिपा)", "warn", "⚠️ Paper test चल रहा है",
      [["Entry", "5-min का <b>fake-up</b> (ऊपर का झूठा उछाल) आपके S/R level पर पक्का हो + call writing (ATM CE का OI बढ़ा और CE premium घटा) + वही level 30+ मिनट पहले छुआ हो → <b>ATM PE</b> खरीदें"],
       ["Stop / Target", "Stop = पिछली 4 candles का high (कम से कम 0.25 ATR) · Target 1:1 · 60 मिनट"]],
      "2 साल (खर्च के बाद): +₹265/trade, PF 1.47 — पर यह नियम 22,304 combinations में से चुना गया था (selection bias); 28 Oct: NIFTY PE −₹15, SENSEX PE SL −₹98।"],
    ["🎯 Premium Prediction — ProTrader plan", "Premium Prediction screen (plans / coach / radar One Trade mode में छिपे)", "ok", "✅ One Trade इसी plan से आता है",
      [["Levels", "कल का H/L/C, हफ़्ते के levels, pivots, trendlines, OI walls — पास-पास वाले levels (0.75 ATR) एक zone"],
       ["Start", "Zone के पार <b>15-min close</b> + 0.1 ATR buffer"],
       ["Target", "T1 = अगला level (कम से कम ½ ATR दूर); बीच में OI wall हो तो T1 = wall · T2 = उसके बाद वाला"],
       ["Stop", "Start से ½ ATR वापस अंदर"],
       ["Trade Review", "बड़े timeframe का trend, 15-min close, पीछा नहीं, अगली wall तक जगह, VWAP की तरफ़, premium + OI flow, liquidity, बचा समय, पुराना record, दिन के 2 घाटे = बंद → <b>A = लें, B = आधा, C = छोड़ें</b>"]],
      ""],
    ["🎯 Premium Prediction — Zero-Hero", "Premium Prediction (सिर्फ़ expiry के दिन)", "warn", "⚠️ सिर्फ़ जानकारी",
      [["Logic", "Expiry के दिन 13:30–14:45 · 5-min candle दिन की range के पार बंद · 2 strike OTM · premium दोगुना होने के लिए index को कितना चलना है vs बाज़ार कितना मान रहा है (ATM straddle) · fixed risk budget"]],
      "खुद trade नहीं देता।"],
    ["🎯 Premium Prediction — 3× Potential / Premium Bounce", "Premium Prediction", "info", "ℹ️ सिर्फ़ odds, signal नहीं",
      [["3×", "2 साल में किस strike का premium उसी दिन / expiry तक 3× हुआ — ज़्यादातर strikes कभी 3× नहीं होते"],
       ["Bounce", "Premium support से उछले तो 2 घंटे में resistance पार करने का 2 साल का %"]],
      ""],
    ["🔬 OI Analysis — OI signal", "OI Analysis (trade signal One Trade mode में छिपा)", "info", "ℹ️ सिर्फ़ positioning",
      [["Logic", "5-min window = trade read, 15-min = दिशा · PE OI ↑ = put writing = support (तेज़ी) · CE OI ↑ = call writing = resistance (मंदी) · Net = ΔPE − ΔCE"]],
      "2 साल का test: OI walls / OI levels से पलटना या टूटना पहले से बताने में <b>कोई edge नहीं</b>।"],
    ["📈 Option Terminal", "Option Terminal (setup label One Trade mode में छिपा)", "info", "ℹ️",
      [["Logic", "CE / PE के chart; ऊपर \"Setup\" = Market Command के trade plan / early move की स्थिति"]], ""],
    ["🧪 AI Paper Trading", "Menu से छिपा (One Trade mode)", "warn", "⚠️ Paper — असली पैसा नहीं",
      [["Logic", "Index options, stock options और stock intraday — तीनों अलग capital · दिशा कल का H/L, कल का close, दिन का open, VWAP, opening range, OI walls, swing से (RSI/MACD नहीं) · profit +15% premium पर cap, trailing stop"]], ""],
    ["⭐ Option Top Pick", "Menu से छिपा (One Trade mode)", "info", "ℹ️ Stocks के लिए",
      [["Logic", "F&O stocks scan → दो अलग सूचियाँ: Liquidity Directional और Stock Setup (indicators + OI + S/R)"]], "सलाह मात्र।"],
    ["🧾 Trade Execution · AI Dashboard / Signals / Review / Performance / Validation", "Menu से छिपे (One Trade mode)", "info", "ℹ️",
      [["Logic", "ऊपर के engines के फ़ैसले और paper नतीजे दिखाने वाली screens; One Trade mode में इनका trade हिस्सा बंद"]], ""],
  ];
  const INFO = [
    ["🗺️ Scenario Map", "One Trade tab", "09:11 के opening से gap up / down / flat का scenario, levels, sweep zones और 2 साल की probability। Trade signal नहीं — तैयारी।"],
    ["🎓 Learning · 📸 Chart School", "Market Command → 🎓 Learning", "किसी भी दिन की असली candles पर नंबर वाली ज़रूरी candles और levels की हिंदी पढ़ाई; आपके trade calls का हिसाब।"],
    ["📊 Market Sentiment · 🧭 MC Summary · 📊 Market Analysis", "Market Command group", "बाज़ार का माहौल: GIFT Nifty, VIX, sectors, FII, खबरें।"],
  ];
  const COMMON = [
    "System कभी order नहीं लगाता — सब सलाह है (ADVISORY ONLY)।",
    "फ़ैसला बंद candle पर — चलती candle पर नहीं।",
    "14:45 के बाद नया trade नहीं, 15:12 पर सब बाहर।",
    "दिन में 2 घाटे हो गए तो उस दिन और trade नहीं (Trade Review)।",
    "Range day (बाज़ार सुस्त) पर नया trade नहीं।",
    "Trading logic का हर बदलाव ProTrader के 2 साल के test से — मालिक चाहे तो override कर सकता है, जो SUPERVISOR_LOG में दर्ज होता है।",
  ];

  const card = ([title, where, cls, status, rows, rec], i, all) => `<details class="one-card rl-card rl-${cls}"${all === LIVE && i === 0 ? " open" : ""}>
      <summary><span class="rl-t"><b>${title}</b><span class="rl-where">${where}</span></span><span class="rl-st">${status}</span></summary>
      <table class="rl-tbl"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>
      ${rec ? `<p class="rl-rec">📊 ${rec}</p>` : ""}</details>`;

  window.rulesMount = (host) => {
    if (!host) return;
    const on = typeof window.oneMode === "function" ? window.oneMode() : true;
    host.innerHTML = `<div class="rl">
      <section class="one-card rl-top">
        <h2 class="one-title">📘 कौन सी screen trade देती है, किस नियम से</h2>
        <p>${on ? "🎯 <b>One Trade mode चालू है</b>: trade सिर्फ़ <b>🎯 One Trade tab</b> और <b>Telegram</b> पर आते हैं। बाकी screens पर अब सिर्फ़ chart और बाज़ार की जानकारी है।" : "⚠️ <b>One Trade mode बंद है</b>: हर screen अपने-अपने trade दिखा रही है — ये आपस में टकरा सकते हैं (28 Oct जैसा)।"}</p>
        <p class="one-mu">सलाह: सिर्फ़ 🎯 One Trade के trade लें — यही अकेला रास्ता है जो ProTrader के 2 साल के test से गुज़रा है, और इसका हिसाब database में अपने आप जुड़ता है।</p>
      </section>
      <h3 class="rl-h">✅ जहाँ trade अभी मिलते हैं</h3>${LIVE.map(card).join("")}
      <h3 class="rl-h">🙈 One Trade mode में छिपे engines — उनका logic</h3>${HIDDEN.map(card).join("")}
      <h3 class="rl-h">📚 सिर्फ़ जानकारी / पढ़ाई</h3>
      <div class="rl-infos">${INFO.map(([t, w, x]) => `<div class="one-card"><b>${t}</b><span class="rl-where">${w}</span><p>${x}</p></div>`).join("")}</div>
      <h3 class="rl-h">🧭 हर जगह लागू नियम</h3><ol class="one-card rl-common">${COMMON.map((x) => `<li>${x}</li>`).join("")}</ol>
      <p class="one-mu rl-foot">स्रोत: हर engine के अपने नियम (code) और <code>backend/research/SUPERVISOR_LOG.md</code> के test नतीजे · अपडेट 29 Oct 2026। Trader Dashboard, Early Moves, Strategy Lab, Stock / Swing, Gold, Crude की screens इसमें शामिल नहीं।</p>
    </div>`;
  };
})();
