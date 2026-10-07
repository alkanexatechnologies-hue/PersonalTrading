// ==================== LIQUIDITY ANALYSIS (Market Command → MC Summary → Liquidity Analysis) ====================
// Research screen: morning liquidity plan, today's liquidity takes and the 20-day
// liquidity event history. READ-ONLY analysis from /api/liquidity-analysis — it
// never produces BUY CE / BUY PE and never touches the Market Command decision.
const LQA = { sym: null, tf: "5", data: null, timer: null, busy: false, inited: false };
const LQA_INDEX = [
  { sym: "^NSEI", label: "NIFTY" }, { sym: "^NSEBANK", label: "BANKNIFTY" }, { sym: "^CNXFIN", label: "FINNIFTY" },
  { sym: "^BSESN", label: "SENSEX" }, { sym: "^NSEMDCP50", label: "MIDCPNIFTY" },
];
const lqaEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lqaN = (v, d = 2) => (v == null || !isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }));
const lqaS = (v, d = 2) => (v == null || !isFinite(Number(v)) ? "—" : `${v > 0 ? "+" : ""}${Number(v).toLocaleString("en-IN", { maximumFractionDigits: d })}`);
const lqaCls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "dn" : "");
const lqaLean = (l) => ({ BULLISH: ["Bullish", "up"], BEARISH: ["Bearish", "dn"], MIXED: ["Mixed", "mx"], NEUTRAL: ["Neutral", ""] }[l] || ["DATA UNAVAILABLE", "na"]);
const lqaHm = (t) => (t ? new Date((t + 19800) * 1000).toISOString().slice(11, 16) : "—");

function initLiquidityAnalysis() {
  const root = document.getElementById("lqa-root");
  if (!root) return;
  const mcSym = (typeof MC !== "undefined" && MC.sym) || "^NSEI";
  if (!LQA.inited || (LQA.sym !== mcSym && LQA_INDEX.some((x) => x.sym === mcSym) && !LQA.userPicked)) LQA.sym = LQA_INDEX.some((x) => x.sym === mcSym) ? mcSym : "^NSEI";
  if (!LQA.inited) { LQA.inited = true; root.innerHTML = lqaShell(); }
  lqaSyncControls();
  loadLiquidityAnalysis();
  if (!LQA.timer) LQA.timer = setInterval(() => {
    const p = document.getElementById("panel-liquidityanalysis");
    if (!p || !p.classList.contains("active")) return;
    // Server recomputes per closed 5m candle (30s cache); closed market → slow refresh.
    const open = typeof isMarketOpen === "function" && isMarketOpen();
    LQA._tick = (LQA._tick || 0) + 1;
    if (open || LQA._tick % 10 === 0) loadLiquidityAnalysis();
  }, 30000);
}

function lqaShell() {
  return `
  <div class="lqa-head">
    <button type="button" class="mcs-back" onclick="switchTab('mcsummary')" title="Back to Market Command Summary">← MC Summary</button>
    <div class="lqa-title">💧 LIQUIDITY ANALYSIS <span>— MORNING PLAN &amp; 20 DAY HISTORY</span></div>
    <span class="lqa-status" id="lqa-status">—</span>
  </div>
  <div class="lqa-controls">
    <div class="lqa-seg" id="lqa-idx">${LQA_INDEX.map((x) => `<button type="button" data-sym="${x.sym}" onclick="lqaPick('${x.sym}')">${x.label}</button>`).join("")}</div>
    <div class="lqa-seg" id="lqa-tf"><button type="button" data-tf="5" onclick="lqaTf('5')">5M</button><button type="button" data-tf="15" onclick="lqaTf('15')">15M</button></div>
    <span class="lqa-date" id="lqa-date">Date: Today</span>
    <span class="lqa-note">Research only — not a trade signal. The Market Command FINAL DECISION is unchanged.</span>
  </div>
  <div id="lqa-body" class="lqa-body"><div class="lqa-empty">Loading liquidity analysis…</div></div>`;
}
function lqaSyncControls() {
  document.querySelectorAll("#lqa-idx button").forEach((b) => b.classList.toggle("on", b.dataset.sym === LQA.sym));
  document.querySelectorAll("#lqa-tf button").forEach((b) => b.classList.toggle("on", b.dataset.tf === LQA.tf));
}
function lqaPick(sym) { LQA.sym = sym; LQA.userPicked = true; LQA.data = null; lqaSyncControls(); loadLiquidityAnalysis(); }
function lqaTf(tf) { LQA.tf = tf; LQA.data = null; lqaSyncControls(); loadLiquidityAnalysis(); }

async function loadLiquidityAnalysis() {
  if (LQA.busy) return;
  LQA.busy = true;
  const want = `${LQA.sym}|${LQA.tf}`;
  try {
    const d = await fetch(`/api/liquidity-analysis?symbol=${encodeURIComponent(LQA.sym)}&tf=${LQA.tf}`).then((r) => r.json());
    if (want !== `${LQA.sym}|${LQA.tf}`) return;          // user switched while loading
    if (d && d.disabled) { document.getElementById("lqa-body").innerHTML = `<div class="lqa-empty">Data paused for this screen (Data Control).</div>`; return; }
    if (!d || d.error) { lqaStatus("ERROR", d && d.error); if (!LQA.data) document.getElementById("lqa-body").innerHTML = `<div class="lqa-empty">DATA UNAVAILABLE — ${lqaEsc((d && d.error) || "no response")}</div>`; return; }
    LQA.data = d;
    renderLiquidityAnalysis(d);
  } catch (e) {
    lqaStatus("STALE", e.message);
  } finally { LQA.busy = false; }
}
function lqaStatus(st, why) {
  const s = document.getElementById("lqa-status"); if (!s) return;
  s.className = "lqa-status " + String(st).toLowerCase();
  s.textContent = st + (LQA.data && LQA.data.lastCandle ? ` · last candle ${lqaHm(LQA.data.lastCandle + 300)}` : "");
  if (why) s.title = why;
}

// Historical reaction of this level type over the 20 sessions (objective, from real events).
function lqaReaction(type, hist) {
  const ev = hist.filter((e) => e.levelType === type && e.outcome !== "PENDING");
  if (!ev.length) return "No history";
  const c = (o) => ev.filter((e) => e.outcome === o).length;
  const best = ["REVERSAL", "CONTINUATION", "FALSE", "NO EDGE"].map((o) => [o, c(o)]).sort((a, b) => b[1] - a[1])[0];
  return `${best[0] === "REVERSAL" ? "Reversal" : best[0] === "CONTINUATION" ? "Continuation" : best[0] === "FALSE" ? "Whipsaw" : "No edge"} ${best[1]}/${ev.length} (20d)`;
}
const LQA_ST_CLS = { "WAITING": "wait", "APPROACHING": "appr", "TOUCHED": "touch", "LIQUIDITY TAKEN": "taken", "REJECTED": "rej", "ACCEPTED": "acc", "BROKEN": "brk", "INVALIDATED": "inv" };

function renderLiquidityAnalysis(d) {
  lqaStatus(d.dataStatus);
  const dt = document.getElementById("lqa-date");
  if (dt) dt.textContent = `Date: ${d.isToday ? "Today " : ""}${d.date}`;
  const o = d.opening || {}, c = d.context;
  const card = (title, body) => `<div class="lqa-card"><div class="lqa-ch">${title}</div>${body}</div>`;
  const leanB = (l) => { const [t, k] = lqaLean(l); return `<b class="lqa-lean ${k}">${t}</b>`; };
  const list = (xs, cls) => xs.length ? `<ul class="lqa-ul ${cls || ""}">${xs.map((x) => `<li>${lqaEsc(x)}</li>`).join("")}</ul>` : "";
  const first15Dir = o.first15High != null && o.open != null && o.price != null ? (o.price > o.open ? "up" : o.price < o.open ? "down" : "flat") : null;
  const gapTxt = o.gapPct == null ? "—" : o.gapPct > 0.2 ? `Gap-up ${lqaS(o.gapPct)}%` : o.gapPct < -0.2 ? `Gap-down ${lqaS(o.gapPct)}%` : `Flat open ${lqaS(o.gapPct)}%`;
  const ctx = c ? `
    ${card("🌍 Global Market", `${leanB(c.globalLean)}${list(c.positives.slice(0, 3), "pos")}${list(c.negatives.slice(0, 4), "neg")}`)}
    ${card("📰 Global News", c.globalNews.items.length ? `<div class="lqa-cnt"><span class="up">+${c.globalNews.positive}</span> <span class="dn">−${c.globalNews.negative}</span> <span>${c.globalNews.neutral} neutral</span></div>${c.globalNews.items.slice(0, 3).map((n) => `<div class="lqa-news ${n.sentiment === "positive" ? "up" : n.sentiment === "negative" ? "dn" : ""}">${lqaEsc(n.title)} <i>${lqaEsc(n.source)} · ${lqaEsc(n.ago)}</i></div>`).join("")}` : `<div class="lqa-na">DATA UNAVAILABLE</div>`)}
    ${card("🇮🇳 Local Sentiment", `${leanB(c.indiaLean)}${list(c.indiaReasons.slice(0, 4))}`)}
    ${card("🔔 Opening Context", `<div class="lqa-kv"><span>Opening bias</span><b>${lqaEsc(gapTxt)} · global ${lqaLean(c.globalLean)[0].toLowerCase()}${first15Dir ? ` · since open ${first15Dir}` : ""}</b>
        <span>Open / Now</span><b>${lqaN(o.open)} / ${lqaN(o.price)}</b>
        <span>PDH / PDL / PDC</span><b>${lqaN(o.pdh)} / ${lqaN(o.pdl)} / ${lqaN(o.pdc)}</b>
        <span>15M High / Low</span><b>${lqaN(o.first15High)} / ${lqaN(o.first15Low)}</b>
        <span>Opening Range H / L</span><b>${lqaN(o.orHigh)} / ${lqaN(o.orLow)}</b>
        <span>Prev session</span><b>${lqaS(o.prevSession && o.prevSession.changePct)}% · range ${lqaN(o.prevSession && o.prevSession.range)} · closed at ${o.prevSession && o.prevSession.closePos != null ? o.prevSession.closePos + "% of range" : "—"}</b></div><div class="lqa-small">Opening bias is analysis only, not a trade.</div>`)}
    ${card("📈 Expected Volatility", o.vix != null ? `<div class="lqa-big">±${lqaN(o.expectedMove, 0)} pts</div><div class="lqa-small">1σ day range implied by India VIX ${lqaN(o.vix)}</div>` : `<div class="lqa-na">DATA UNAVAILABLE</div>`)}
    ${card("🗓 Key Events", `${(c.keyEvents || []).slice(0, 4).map((n) => `<div class="lqa-news"><em class="lqa-tag">${(n.tags || []).includes("RBI") ? "RBI" : "GOVT"}</em> ${lqaEsc(n.title)} <i>${lqaEsc(n.source)} · ${lqaEsc(n.ago)}</i></div>`).join("") || `<div class="lqa-na">No RBI / government headlines (48h)</div>`}<div class="lqa-small">Scheduled calendar: ${lqaEsc(c.scheduledCalendar)}</div>`)}` :
    `<div class="lqa-empty">Market context: DATA UNAVAILABLE</div>`;

  const hist = d.history || [];
  const grid = (side) => {
    const rows = d.levels.filter((l) => l.side === side).sort((a, b) => side === "DOWNSIDE" ? b.price - a.price : a.price - b.price);
    if (!rows.length) return `<div class="lqa-empty">No ${side.toLowerCase()} levels yet (levels appear as they become known: previous day at 09:15, opening range at 09:20, 15M at 09:30).</div>`;
    return `<div class="lqa-tscroll"><table class="lqa-t"><thead><tr><th>#</th><th>Level Type</th><th>Source</th><th class="r">Level Price</th><th class="r">Distance</th><th>Expected Reaction</th><th>Option Strike</th><th>Status</th></tr></thead><tbody>
      ${rows.map((l, i) => `<tr class="st-${LQA_ST_CLS[l.status] || ""}">
        <td>${i + 1}</td><td><b>${lqaEsc(l.type)}</b></td><td class="lqa-src" title="${lqaEsc(l.sources.join("\n"))}">${lqaEsc(l.sources.map((s) => s.split(": ")[1] || s).join(" · "))}</td>
        <td class="r"><b>${lqaN(l.price)}</b></td><td class="r ${l.distance != null && l.distance < 0 ? "dn" : ""}">${l.distance == null ? "—" : lqaN(l.distance)}${o.price ? ` <i>${lqaN(Math.abs(l.distance || 0) / o.price * 100)}%</i>` : ""}</td>
        <td>${lqaEsc(lqaReaction(l.type, hist))}</td>
        <td>${l.strike != null ? lqaN(l.strike, 0) : "—"}${l.oi ? ` <i title="Open interest at this strike (latest OI snapshot)">CE ${lqaN((l.oi.ceOi || 0) / 1e5, 1)}L · PE ${lqaN((l.oi.peOi || 0) / 1e5, 1)}L</i>` : ""}</td>
        <td><span class="lqa-st ${LQA_ST_CLS[l.status] || ""}">${lqaEsc(l.status)}</span></td></tr>`).join("")}
      </tbody></table></div>`;
  };
  const statusRows = d.levels.slice().sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0) || a.price - b.price);
  const status = `<div class="lqa-tscroll"><table class="lqa-t"><thead><tr><th>Level</th><th class="r">Price</th><th>Current Status</th><th>Time Taken</th><th>Time to Liquidity</th><th>Direction After Take</th><th class="r">Points Moved</th><th>Outcome</th><th>Pattern</th></tr></thead><tbody>
    ${statusRows.map((l) => { const e = l.event; return `<tr class="st-${LQA_ST_CLS[l.status] || ""}"><td><b>${lqaEsc(l.type)}</b> <i>${l.side === "DOWNSIDE" ? "↓" : "↑"}</i></td><td class="r">${lqaN(l.price)}</td>
      <td><span class="lqa-st ${LQA_ST_CLS[l.status] || ""}">${lqaEsc(l.status)}</span></td><td>${e ? lqaEsc(e.time) : "—"}</td><td>${e ? lqaEsc(e.timeToLiquidity) : "—"}</td>
      <td class="${e && e.afterDirection === "UP" ? "up" : e && e.afterDirection === "DOWN" ? "dn" : ""}">${e ? lqaEsc(e.afterDirection || "—") : "—"}</td>
      <td class="r ${lqaCls(e && e.pointsCaptured)}">${e && e.pointsCaptured != null ? lqaS(e.pointsCaptured) + " pts" : "—"}</td><td>${e ? lqaEsc(e.outcome) : "—"}</td><td>${e ? lqaEsc(e.pattern) : "—"}</td></tr>`; }).join("")}
    </tbody></table></div>`;

  const oc = (k) => hist.filter((e) => e.outcome === k).length;
  const histTable = hist.length ? `<div class="lqa-hsum">${hist.length} events · ${d.historySessions} sessions · Reversal ${oc("REVERSAL")} · Continuation ${oc("CONTINUATION")} · Whipsaw (FALSE) ${oc("FALSE")} · No edge ${oc("NO EDGE")}</div>
    <div class="lqa-tscroll lqa-hist"><table class="lqa-t lqa-wide"><thead><tr>
      <th>#</th><th>Date</th><th>Day</th><th>Time</th><th>Level Type</th><th>Level Source</th><th>Side</th><th class="r">Level Price</th><th>Option Strike</th><th class="r">Market Price</th>
      <th>Previous Direction</th><th>15M Direction</th><th>Time to Liquidity</th><th class="r">Liquidity Taken</th><th class="r">Candle Range</th><th>After Direction</th>
      <th class="r">1C Move</th><th class="r">2C Move</th><th class="r">3C Move</th><th class="r">5C Move</th><th class="r">10C Move</th><th class="r">Points Captured</th><th class="r">% Move</th><th class="r">ATR Move</th><th>Pattern</th><th>Outcome</th></tr></thead><tbody>
      ${hist.map((e, i) => `<tr><td>${i + 1}</td><td>${lqaEsc(e.date)}</td><td>${lqaEsc(e.day)}</td><td>${lqaEsc(e.time)}</td><td><b>${lqaEsc(e.levelType)}</b></td>
        <td class="lqa-src" title="${lqaEsc(e.sources.join("\n"))}">${lqaEsc(e.sources.map((s) => s.split(": ")[1] || s).join(" · "))}</td><td class="${e.side === "DOWNSIDE" ? "dn" : "up"}">${e.side === "DOWNSIDE" ? "↓ Down" : "↑ Up"}</td>
        <td class="r">${lqaN(e.level)}</td><td>${e.strike != null ? lqaN(e.strike, 0) : "—"}</td><td class="r">${lqaN(e.marketPrice)}</td>
        <td>${lqaEsc(e.prevDirection)}</td><td>${lqaEsc(e.dir15 || "—")}</td><td>${lqaEsc(e.timeToLiquidity)}</td><td class="r" title="How far price traded beyond the level">${lqaN(e.sweepSize)} pts</td><td class="r">${lqaN(e.candleRange)}</td>
        <td class="${e.afterDirection === "UP" ? "up" : e.afterDirection === "DOWN" ? "dn" : ""}">${lqaEsc(e.afterDirection || "—")}</td>
        ${["1C", "2C", "3C", "5C", "10C"].map((k) => `<td class="r ${lqaCls(e.moves[k])}">${lqaS(e.moves[k])}</td>`).join("")}
        <td class="r ${lqaCls(e.pointsCaptured)}"><b>${lqaS(e.pointsCaptured)}</b></td><td class="r ${lqaCls(e.pctMove)}">${lqaS(e.pctMove)}%</td><td class="r ${lqaCls(e.atrMove)}">${lqaS(e.atrMove)}×</td>
        <td>${lqaEsc(e.pattern)}</td><td><span class="lqa-oc ${String(e.outcome).toLowerCase().replace(/\s/g, "")}">${lqaEsc(e.outcome)}</span></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="lqa-empty">No liquidity events in the last 20 sessions (or history unavailable).</div>`;

  document.getElementById("lqa-body").innerHTML = `
    <section class="lqa-sec"><div class="lqa-sh">MORNING MARKET CONTEXT <i>${lqaEsc(c ? c.headline : "")}</i></div><div class="lqa-cards">${ctx}</div></section>
    <section class="lqa-sec"><div class="lqa-sh">TODAY'S LIQUIDITY LEVELS · ${lqaEsc(d.index)} · ${lqaEsc(d.tf)} <i>price ${lqaN(o.price)}</i></div>
      <div class="lqa-two"><div><div class="lqa-gh dn">▼ POTENTIAL DOWNSIDE LIQUIDITY / SUPPORT</div>${grid("DOWNSIDE")}</div>
      <div><div class="lqa-gh up">▲ POTENTIAL UPSIDE LIQUIDITY / RESISTANCE</div>${grid("UPSIDE")}</div></div></section>
    <section class="lqa-sec"><div class="lqa-sh">TODAY'S LIQUIDITY STATUS</div>${status}</section>
    <section class="lqa-sec"><div class="lqa-sh">LIQUIDITY EVENT HISTORY — LAST ${d.historySessions} TRADING DAYS <i>newest first</i></div>${histTable}</section>
    <div class="lqa-foot">${(d.notes || []).map(lqaEsc).join(" · ")} · Expected reaction = the most common outcome of that level type over the 20-day history. Outcome: first side to move 1×ATR within 10 candles (both = FALSE / whipsaw).</div>`;
}
