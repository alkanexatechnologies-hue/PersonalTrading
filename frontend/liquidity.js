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
    <div class="lqa-title" title="Morning plan &amp; 20-day history. Research only — not a trade signal; the Market Command FINAL DECISION is unchanged.">💧 LIQUIDITY ANALYSIS</div>
    <div class="lqa-seg" id="lqa-idx">${LQA_INDEX.map((x) => `<button type="button" data-sym="${x.sym}" onclick="lqaPick('${x.sym}')">${x.label}</button>`).join("")}</div>
    <div class="lqa-seg" id="lqa-tf"><button type="button" data-tf="5" onclick="lqaTf('5')">5M</button><button type="button" data-tf="15" onclick="lqaTf('15')">15M</button></div>
    <span class="lqa-date" id="lqa-date">Today</span>
    <span class="lqa-status" id="lqa-status">—</span>
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
  const tipOf = (xs) => lqaEsc(xs.filter(Boolean).join("\n"));
  const mini = (title, main, sub, tip) => `<div class="lqa-mini" title="${tip || ""}"><span class="lqa-mt">${title}</span><span class="lqa-mm">${main}</span>${sub ? `<span class="lqa-ms">${sub}</span>` : ""}</div>`;
  const neg0 = c && c.negatives[0] ? c.negatives[0].split(":")[0] : null, pos0 = c && c.positives[0] ? c.positives[0].split(":")[0] : null;
  const ctx = c ? [
    mini("🌍 Global", leanB(c.globalLean), [pos0 && `▲ ${lqaEsc(pos0)}`, neg0 && `▼ ${lqaEsc(neg0)}`, c.negatives.length > 1 ? `+${c.negatives.length - 1} more` : ""].filter(Boolean).join(" · "), tipOf([...c.positives.map((x) => "▲ " + x), ...c.negatives.map((x) => "▼ " + x)])),
    mini("📰 Global news", c.globalNews.items.length ? `<span class="up">+${c.globalNews.positive}</span> <span class="dn">−${c.globalNews.negative}</span> <span>${c.globalNews.neutral}=</span>` : `<span class="lqa-na">DATA UNAVAILABLE</span>`, c.globalNews.items[0] ? lqaEsc(c.globalNews.items[0].title) : "", tipOf(c.globalNews.items.map((n) => `${n.title} (${n.source} · ${n.ago})`))),
    mini("🇮🇳 India", leanB(c.indiaLean), lqaEsc(c.indiaReasons[0] || ""), tipOf(c.indiaReasons)),
    mini("🔔 Opening", lqaEsc(gapTxt), `Open ${lqaN(o.open)} · PDC ${lqaN(o.pdc)}${first15Dir ? ` · since open ${first15Dir}` : ""}`,
      tipOf([`PDH ${lqaN(o.pdh)} / PDL ${lqaN(o.pdl)} / PDC ${lqaN(o.pdc)}`, `15M H/L ${lqaN(o.first15High)} / ${lqaN(o.first15Low)}`, `Opening range H/L ${lqaN(o.orHigh)} / ${lqaN(o.orLow)}`,
        `Prev session ${lqaS(o.prevSession && o.prevSession.changePct)}% · range ${lqaN(o.prevSession && o.prevSession.range)} · closed at ${o.prevSession && o.prevSession.closePos}% of range`, "Opening bias is analysis only, not a trade."])),
    mini("📈 Volatility", o.vix != null ? `±${lqaN(o.expectedMove, 0)} pts` : `<span class="lqa-na">DATA UNAVAILABLE</span>`, o.vix != null ? `India VIX ${lqaN(o.vix)} (1σ day)` : "", ""),
    mini("🗓 Events", (c.keyEvents || []).length ? `${(c.keyEvents || []).filter((n) => (n.tags || []).includes("RBI")).length} RBI · ${(c.keyEvents || []).filter((n) => !(n.tags || []).includes("RBI")).length} Govt` : `<span class="lqa-na">none (48h)</span>`,
      (c.keyEvents || [])[0] ? lqaEsc(c.keyEvents[0].title) : "", tipOf([...(c.keyEvents || []).map((n) => `${(n.tags || []).includes("RBI") ? "[RBI]" : "[GOVT]"} ${n.title} (${n.source} · ${n.ago})`), "Scheduled calendar: " + c.scheduledCalendar])),
  ].join("") : `<div class="lqa-empty">Market context: DATA UNAVAILABLE</div>`;

  const hist = d.history || [];
  const grid = (side) => {
    const rows = d.levels.filter((l) => l.side === side).sort((a, b) => side === "DOWNSIDE" ? b.price - a.price : a.price - b.price);
    if (!rows.length) return `<div class="lqa-empty">No ${side.toLowerCase()} levels yet (levels appear as they become known: previous day at 09:15, opening range at 09:20, 15M at 09:30).</div>`;
    return `<div class="lqa-tscroll"><table class="lqa-t"><thead><tr><th>#</th><th>Level Type</th><th class="r">Level Price</th><th>Time Taken</th><th>Status</th><th class="r">Distance</th><th>Expected Reaction</th><th>Option Strike</th><th>Source</th><th>Active Since</th></tr></thead><tbody>
      ${rows.map((l, i) => `<tr class="st-${LQA_ST_CLS[l.status] || ""}">
        <td>${i + 1}</td><td><b>${lqaEsc(l.type)}</b></td><td class="r"><b>${lqaN(l.price)}</b></td>
        <td>${l.event ? `<b class="lqa-time">${lqaEsc(l.event.time)}</b>` : l.status === "INVALIDATED" ? "gapped" : `<i>pending</i>`}</td>
        <td><span class="lqa-st ${LQA_ST_CLS[l.status] || ""}">${lqaEsc(l.status)}</span></td>
        <td class="r ${l.distance != null && l.distance < 0 ? "dn" : ""}">${l.distance == null ? "—" : lqaN(l.distance)}${o.price ? ` <i>${lqaN(Math.abs(l.distance || 0) / o.price * 100)}%</i>` : ""}</td>
        <td>${lqaEsc(lqaReaction(l.type, hist))}</td>
        <td>${l.strike != null ? lqaN(l.strike, 0) : "—"}${l.oi ? ` <i title="Open interest at this strike (latest OI snapshot)">CE ${lqaN((l.oi.ceOi || 0) / 1e5, 1)}L · PE ${lqaN((l.oi.peOi || 0) / 1e5, 1)}L</i>` : ""}</td>
        <td class="lqa-src" title="${lqaEsc(l.sources.join("\n"))}">${lqaEsc(l.sources.map((x) => x.split(": ")[1] || x).join(" · "))}</td>
        <td>${lqaHm(l.activeFrom)}</td></tr>`).join("")}
      </tbody></table></div>`;
  };
  // Morning-to-now summary: which liquidity the market has already taken, and what is still waiting.
  const takenL = d.levels.filter((l) => l.event).sort((a, b) => a.takenAt - b.takenAt);
  const pendL = d.levels.filter((l) => !l.event && l.status !== "INVALIDATED").sort((a, b) => Math.abs(a.distance ?? 1e9) - Math.abs(b.distance ?? 1e9));
  const gapL = d.levels.filter((l) => l.status === "INVALIDATED");
  const OC_SHORT = { REVERSAL: "REV", CONTINUATION: "CONT", FALSE: "FALSE", "NO EDGE": "NO EDGE", PENDING: "…" };
  const tchip = (l) => `<span class="lqa-chip taken" title="${lqaEsc([`${l.type} ${lqaN(l.price)} taken ${l.event.time}`, ...l.sources, `Time to liquidity ${l.event.timeToLiquidity}`, `After: ${l.event.afterDirection || "…"} ${l.event.pointsCaptured != null ? lqaS(l.event.pointsCaptured) + " pts" : ""}`, `Outcome ${l.event.outcome} · ${l.event.pattern}`].join("\n"))}"><b class="lqa-time">${lqaEsc(l.event.time)}</b> ${l.side === "DOWNSIDE" ? "↓" : "↑"} ${lqaEsc(l.type)} ${lqaN(l.price, 0)} <span class="${lqaCls(l.event.pointsCaptured)}">${l.event.pointsCaptured != null ? lqaS(l.event.pointsCaptured, 0) : ""}</span> <i>${OC_SHORT[l.event.outcome] || lqaEsc(l.event.outcome)}</i></span>`;
  const pchip = (l) => `<span class="lqa-chip pend" title="${lqaEsc([...l.sources, `Status ${l.status}`].join("\n"))}">${l.side === "DOWNSIDE" ? "↓" : "↑"} ${lqaEsc(l.type)} <b>${lqaN(l.price, 0)}</b> <i>${l.distance != null ? lqaN(Math.abs(l.distance), 0) + " away" : ""}</i>${l.status !== "WAITING" ? ` <span class="lqa-st ${LQA_ST_CLS[l.status] || ""}">${lqaEsc(l.status)}</span>` : ""}</span>`;
  const takeSummary = `<div class="lqa-takesum">
      <div><div class="lqa-gh">✅ LIQUIDITY TAKEN TODAY (${takenL.length}) <i>in time order</i></div>${takenL.map(tchip).join("") || `<span class="lqa-na">None taken yet</span>`}</div>
      <div><div class="lqa-gh">⏳ PENDING — NOT YET TAKEN (${pendL.length}) <i>nearest first</i></div>${pendL.map(pchip).join("") || `<span class="lqa-na">No pending levels</span>`}${gapL.length ? `<div class="lqa-small">Gapped through at the open (no sweep): ${gapL.map((l) => `${lqaEsc(l.type)} ${lqaN(l.price)}`).join(", ")}</div>` : ""}</div>
    </div>`;
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
    <div class="lqa-ctx">${ctx}</div>
    ${takeSummary}
    <div class="lqa-two"><div><div class="lqa-gh dn">▼ DOWNSIDE LIQUIDITY / SUPPORT <i>price ${lqaN(o.price)}</i></div>${grid("DOWNSIDE")}</div>
      <div><div class="lqa-gh up">▲ UPSIDE LIQUIDITY / RESISTANCE <i>${lqaEsc(d.index)} · ${lqaEsc(d.tf)}</i></div>${grid("UPSIDE")}</div></div>
    <section class="lqa-sec lqa-histsec"><div class="lqa-sh">LIQUIDITY EVENT HISTORY — LAST ${d.historySessions} TRADING DAYS <i title="${lqaEsc([...(d.notes || []), "Outcome = first side to move 1×ATR within 10 candles (both = FALSE / whipsaw). Expected reaction = most common outcome of that level type over 20 days."].join("\n"))}">newest first · research only ⓘ</i></div>${histTable}</section>`;
  lqaFitHistory();
}

// Let the 20-day table use whatever screen height is left (scrolls inside its box).
function lqaFitHistory() {
  const h = document.querySelector("#lqa-root .lqa-hist"); if (!h) return;
  const top = h.getBoundingClientRect().top + window.scrollY;
  h.style.maxHeight = Math.max(260, window.innerHeight - top - 12) + "px";
}
window.addEventListener("resize", () => { if (document.body.classList.contains("lqa-fullwidth")) lqaFitHistory(); });
