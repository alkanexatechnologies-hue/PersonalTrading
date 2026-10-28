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
      [["Directional", "OI का TAKE signal + 1 घंटे का bulletin उसी तरफ़"], ["Scalp", "5-min और 15-min bulletin एक तरफ़, या 5-min signal के साथ तेज़ उछाल"],
       ["शर्तें", "खर्च के बाद R:R ठीक · जीत की संभावना ≥ 52% (directional) / ≥ 54% (scalp) · दिन का घाटा −3% पर बंद · 15:25 तक सब बंद"],
       ["Entry levels", "कल का H/L/close, दिन का open, VWAP, opening range, OI walls, swing (RSI/MACD नहीं) · profit +15% premium पर cap, trailing stop"]], "Paper DB में असली नापा हुआ win rate — zero-loss का वादा नहीं।"],
    ["⭐ Option Top Pick", "Menu से छिपा (One Trade mode)", "info", "ℹ️ Stocks के लिए",
      [["Logic", "F&O stocks scan → दो अलग सूचियाँ: Liquidity Directional और Stock Setup (indicators + OI + S/R)"]], "सलाह मात्र।"],
    ["🧾 Trade Execution · AI Dashboard / Signals / Review / Performance / Validation", "Menu से छिपे (One Trade mode)", "info", "ℹ️",
      [["Logic", "ऊपर के engines के फ़ैसले और paper नतीजे दिखाने वाली screens; One Trade mode में इनका trade हिस्सा बंद"]], ""],
  ];
  // 🔍 C4 step by step (premium/c4Live.ts, research/protrader/fakeUpPaperCore.ts, SUPERVISOR_LOG 2026-10-24)
  const C4 = [
    ["1. Level", "आपके तरीके वाले S/R: पिछले 5 दिनों में जहाँ भाव <b>कई बार पलटा</b> (15-min swing highs/lows का झुंड); जो कभी high और कभी low रहा वह <b>flip zone</b>। दिन शुरू होने से पहले तय।"],
    ["2. Fake-up", "5-min candles पर भाव level के <b>ऊपर गया पर वापस नीचे बंद</b> हुआ (झूठा breakout) — यह पक्का होने पर ही आगे।"],
    ["3. Call writing", "उसी समय (4 candles में) <b>ATM CE का OI बढ़ा और CE premium घटा</b> = ऊपर बेचने वाले बैठ गए।"],
    ["4. पुराना touch", "वही level आज <b>30+ मिनट पहले</b> भी छुआ गया था (एक level पर दिन में एक बार)।"],
    ["5. Entry", "पुष्टि वाली 5-min candle के close पर <b>ATM PE</b> खरीदें।"],
    ["6. Stop / Target", "Stop = पिछली 4 candles का high (entry से कम से कम 0.25 ATR ऊपर) · Target = उतनी ही दूरी नीचे (<b>1:1</b>) · ज़्यादा से ज़्यादा <b>60 मिनट</b>।"],
    ["सिर्फ़ PE", "C4 केवल गिरावट (PE) पकड़ता है — ऊपर की तरफ़ का इसका कोई version नहीं।"],
    ["2 साल का test", "299 signals, खर्च के बाद <b>+₹265/trade</b> (सावधान अनुमान +₹193), PF 1.47 · पुराना हिस्सा +₹210, नया +₹371 · पर 2024 के दूसरे हिस्से में −₹150 और 2025 के पहले हिस्से में −₹13।"],
    ["सावधानी", "यह नियम <b>22,304 combinations में से चुना</b> गया — इसलिए असली नतीजा test से कमज़ोर हो सकता है (selection bias)। ProTrader verdict: <b>CONTINUE PAPER TESTING</b> — ~30 paper signals के बाद फ़ैसला।"],
    ["Live", "26 Oct से paper test; 28 Oct को Market Command पर दिखे दोनों C4 trades घाटे में (NIFTY PE −₹15, SENSEX PE SL −₹98)।"],
  ];
  const DESKS = [
    ["🎯 Trader Dashboard", "Option group → Trader Dashboard", "info", "ℹ️ अलग engine",
      [["Logic", "Option chain + VWAP/ADX (15-min) + 4-Layer (RSI/MACD नहीं) + GainzAlgo v2 + futures buildup · हर model की OI दिशा से तुलना: <b>कम से कम 2 सहमत और 0 विरोध</b> = consensus"],
       ["रोक", "Premium decay = पूरी रोक · कमज़ोर setup (quality < 30) छिपा · वही trade दोबारा नहीं जब तक exit या ATR जितनी चाल न हो"]], ""],
    ["⚡ Early Moves", "Option group → Early Moves", "info", "ℹ️ चाल की शुरुआत पकड़ता है",
      [["Logic", "5-min पर <b>नई साफ़ दिशा</b> + momentum बस शुरू (squeeze खुला / नया trend) + volume साथ + दिन की आम range का <b>छोटा हिस्सा ही इस्तेमाल</b> हुआ"],
       ["रोक", "पहले से फैली चाल (ज़्यादा RSI / दिन की range ज़्यादातर खर्च) = late — नहीं दिखाता"]], ""],
    ["🔬 Master Strategy Lab", "Option group → Master Strategy Lab", "info", "ℹ️ आज कौन सा तरीका",
      [["Strategies", "Trend Continuation · Squeeze Breakout · Opening Range Breakout · Wall Rejection · Wall Breakout · Pullback Continuation"],
       ["Logic", "आज की हालत से हर strategy का मेल × उसका पुराना record → दिन की पसंदीदा strategy (दिन भर lock) · कोई साफ़ न हो तो <b>\"आज कोई सही strategy नहीं → WAIT\"</b> · Arbiter के फ़ैसले को कभी नहीं बदलता"]], "Score = हालत का मेल, जीत की संभावना नहीं।"],
    ["🕘 Opening Play 9:20 (OPHL)", "Option group", "info", "ℹ️ सुबह का तरीका",
      [["दिशा", "Open बनाम कल का High/Low (या level का buffer के साथ टूटना)"],
       ["Score", "Market 40% (level, नया high/low, VWAP, EMA9/21, OI) + Option 60% (ATM premium अपना session high तोड़े, OI, momentum)"],
       ["Entry", "Score ≥ 75 <b>और</b> index break + option break + VWAP तीनों एक साथ"],
       ["Stop / Target", "Premium पर 25% stop · T1 / T2 / T3 = 1R / 2R / 3R"]], ""],
    ["📽 Strategy Replay", "Option group → Strategy Replay", "info", "ℹ️ पुराना दिन दोबारा",
      [["Logic", "चुने हुए दिन की असली candles पर engine को candle-दर-candle चलाकर दिखाता है कि कब क्या संकेत बनता — trade नहीं देता"]], ""],
    ["🌊 Liquidity Status", "Option group → Liquidity Status", "info", "ℹ️ sweep / trap की पहचान",
      [["Logic", "Opening range + मुख्य levels → sweep (stop-loss लेकर वापसी), असली break या trap की पहचान + OI + VWAP / EMA structure → checklist और trader action"]], "सलाह मात्र।"],
    ["📊 Stock Options", "Stock Option desk", "info", "ℹ️ F&O stocks",
      [["Logic", "F&O stocks के CE / PE: Option Top Pick (Liquidity Directional + Stock Setup) और Liquidity Status वाले scanners"]], ""],
    ["📈 Swing screens", "Selected Stock · Bull % Rank · Today Big Movers · Big Move 20–100% · Move Timing", "info", "ℹ️ stocks की research",
      [["Bull % Rank", "कितने % दिन stock ऊपर बंद हुआ (पूरा + पिछले 20 दिन), streak"],
       ["Today Big Movers", "Opening gap + आज का volume (आम से ज़्यादा) + range का फैलाव + 15-min momentum"],
       ["Big Move 20–100%", "सिकुड़ा हुआ base, volume सूखा, breakout के पास, लंबा trend मज़बूत, पहले से न भागा + stock का अपना 6 महीने में 20/50/100% का इतिहास"],
       ["Move Timing", "दिन के किस समय stock सबसे ज़्यादा चलता है"]], "Intraday trade signal नहीं — stocks चुनने की research।"],
    ["🪙 Gold · 🛢️ Crude Command", "Gold / Crude desks (MCX)", "info", "ℹ️ हमेशा WAIT",
      [["Logic", "MCX futures / options के levels, round numbers, OI — <b>अभी कोई tested trading नियम नहीं</b>, इसलिए signal हमेशा WAIT"]], "सिर्फ़ जानकारी; Indian screens की speed पर असर नहीं डालते।"],
    ["🧪 Backtest (Dhan) · Universal Indicator Lab", "Backtest group", "info", "ℹ️ test के औज़ार",
      [["Logic", "किसी indicator / नियम को पुराने Dhan data पर चलाकर उसका नतीजा देखने के औज़ार — live trade नहीं देते"]], ""],
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
      <h3 class="rl-h">🔍 C4 — कदम-दर-कदम</h3>
      <details class="one-card rl-card rl-warn" open><summary><span class="rl-t"><b>C4 = झूठे उछाल (fake-up) पर PE</b><span class="rl-where">Market Command chart पर दिखता था (One Trade mode में छिपा) · आपका नियम</span></span><span class="rl-st">⚠️ Paper test — edge पक्का नहीं</span></summary>
        <table class="rl-tbl"><tbody>${C4.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>
        <p class="rl-rec">🧠 आसान भाषा में: भाव आपके level के ऊपर झाँका, पर टिक नहीं पाया, और उसी समय call बेचने वाले बढ़ गए — यानी ऊपर दीवार है। तब PE, छोटा target (1:1), एक घंटे में बाहर।</p></details>
      <h3 class="rl-h">🗂 बाकी screens (अलग desks) — उनका logic</h3>${DESKS.map(card).join("")}
      <h3 class="rl-h">📚 सिर्फ़ जानकारी / पढ़ाई</h3>
      <div class="rl-infos">${INFO.map(([t, w, x]) => `<div class="one-card"><b>${t}</b><span class="rl-where">${w}</span><p>${x}</p></div>`).join("")}</div>
      <h3 class="rl-h">🧭 हर जगह लागू नियम</h3><ol class="one-card rl-common">${COMMON.map((x) => `<li>${x}</li>`).join("")}</ol>
      <p class="one-mu rl-foot">स्रोत: हर engine के अपने नियम (code) और <code>backend/research/SUPERVISOR_LOG.md</code> के test नतीजे · अपडेट 29 Oct 2026। ProTrader के 2 साल के test से सिर्फ़ One Trade (approved) और C4 (paper) गुज़रे हैं; बाकी desks का ऐसा test नहीं हुआ।</p>
    </div>`;
  };
})();
