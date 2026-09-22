"use strict";

const state = {
  symbols: [],
  active: null,
  interval: "5m",
  chart: { candles: [], overlays: {}, scores: [], timeToIndex: new Map(), markers: [], showMarkers: true, dayView: true, priceLines: [] },
  alerts: { lastTopPick: null, notify: false, audioCtx: null },
  scalp: { prevStates: {}, timer: null },
};

const seriesMap = {};

const el = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  n == null || isNaN(n) ? "-" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const round2 = (n) => Math.round(Number(n) * 100) / 100;

let chart, candleSeries, ema9Series, ema21Series, ema50Series, vwapSeries, stSeries, volumeSeries;
let macdChart, macdLineSeries, macdSignalSeries, macdHistSeries;
let bbUpperSeries, bbLowerSeries, kcUpperSeries, kcLowerSeries;
let lineSeries, areaSeries;
let rsiChart, rsiSeries;
let equityChart, equitySeries;
let rangeSyncing = false;

// Fetches /api/symbols and renders the watchlist. Called from init(), which
// only ever runs after enterByRole() confirms a valid session (see the bottom
// of this file) - so this always has a real Authorization token attached by
// installAuthFetch() by the time it runs.
async function loadSymbolsAndWatchlist() {
  let res;
  try {
    res = await fetch("/api/symbols").then((r) => r.json());
  } catch (_) {
    return; // offline/network error - leave state.symbols as-is, don't crash init()
  }
  if (!res || !Array.isArray(res.symbols)) return; // e.g. a transient server error
  state.symbols = res.symbols;
  if (el("provider-badge")) el("provider-badge").textContent = "provider: " + res.provider;
  if (el("disclaimer")) el("disclaimer").textContent = res.disclaimer;
  if (el("home-tk-provider")) el("home-tk-provider").textContent = res.provider || "—";
  renderWatchlist();
  if (!state.active && state.symbols.length) selectSymbol(state.symbols[0].symbol);
}

// ---------- init ----------
async function init() {
  buildChart();
  buildEquityChart();
  startClock();

  state.symbols = state.symbols || [];

  // Trader Dashboard is the default tab for Monday live testing of the OI model
  // - fire its fetch FIRST, before anything else, so it gets first claim on the
  // Dhan 2-concurrent throttle while someone is watching the loading spinner.
  // initOiCommand fetches its own underlyings (/api/backtest/option/underlyings)
  // and does NOT depend on state.symbols, so loadSymbolsAndWatchlist (below) must
  // not block it - awaiting /api/symbols first used to add seconds to first paint.
  state.tpUniverse = "index";
  initOiCommand();
  startOiCommandLive();
  startSessionKeeper();

  // Symbols + watchlist populate the main chart's picker (not on the Trader
  // Dashboard critical path) - load them after the cockpit fetch is in flight.
  loadSymbolsAndWatchlist().then(startWatchlistAutoRefresh);

  setTimeout(() => loadIndexDesk(), 1500);
  setTimeout(() => startIndexStrip(), 2500);
  // Trader Mind removed from upper cockpit strip; tab version still loads on demand.
  setTimeout(() => loadWatchlistBadges(), 4500);
  setTimeout(() => loadWatchlistScan(), 6500); // heavy per-symbol scan — last, after the cheaper loaders

  // Heavy scans are staggered so Dhan is not hammered on login (no hang).
  setTimeout(() => loadTopPicks(true), 2500);
  setTimeout(() => loadOptionTopPick(), 5000); // scans ~60 stocks - stays clear of the earlier, cheaper staggered loaders
  if (el("otp-refresh")) el("otp-refresh").addEventListener("click", loadOptionTopPick);
  if (el("ls-refresh")) el("ls-refresh").addEventListener("click", loadLiquidityStatusScreen);
  if (el("ls-symbol")) el("ls-symbol").addEventListener("change", loadLiquidityStatusScreen);
  if (el("ls-scan-refresh")) el("ls-scan-refresh").addEventListener("click", loadLiquidityMovers);
  setTimeout(() => { if (isMarketOpen() || isFeedWindow()) loadTopOpportunities(); }, 4000);
  setInterval(() => { if (isMarketOpen() || isFeedWindow()) loadTopOpportunities(); }, 60 * 1000);
  startLiveTicker();

  el("interval").addEventListener("change", (e) => {
    state.interval = e.target.value;
    syncTfChips();
    if (state.active) loadSymbol(state.active);
    loadAlerts();
  });
  el("refresh").addEventListener("click", () => state.active && loadSymbol(state.active));
  el("run-backtest").addEventListener("click", runBacktest);
  el("compare-bt").addEventListener("click", compareBacktest);
  if (el("refresh-alerts")) el("refresh-alerts").addEventListener("click", loadAlerts);
  if (el("al-sort")) el("al-sort").addEventListener("change", renderAlertTable);
  if (el("notify-toggle")) el("notify-toggle").addEventListener("click", toggleNotify);
  if (el("load-nextday")) el("load-nextday").addEventListener("click", loadNextDay);
  if (el("scan-scalp")) el("scan-scalp").addEventListener("click", loadScalpScan);
  el("load-swing").addEventListener("click", loadSwing);
  ["sw-sort", "sw-sector", "sw-cap", "sw-minrev", "sw-minopp"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener("input", applySwingFilters);
  });
  if (el("load-longterm")) el("load-longterm").addEventListener("click", loadLongTerm);
  ["lt-sort", "lt-sector", "lt-stage", "lt-cap", "lt-minrev", "lt-mb"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener("input", applyLongTermFilters);
  });
  el("load-frequent").addEventListener("click", loadFrequent);
  ["fm-threshold", "fm-sort", "fm-sector", "fm-options"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener("input", applyFrequentFilters);
  });
  if (el("load-plan")) el("load-plan").addEventListener("click", loadPlan);
  if (el("hourly-run")) el("hourly-run").addEventListener("click", runHourlySnapshot);
  if (el("hourly-resolve")) el("hourly-resolve").addEventListener("click", resolveHourly);
  el("load-monthly").addEventListener("click", loadMonthly);
  ["mo-sort", "mo-sector", "mo-minprob", "mo-options"].forEach((id) => {
    const n = el(id);
    if (n) n.addEventListener("input", applyMonthlyFilters);
  });
  el("load-bigmove").addEventListener("click", loadBigMove);
  if (el("load-todaymovers")) el("load-todaymovers").addEventListener("click", loadTodayMovers);
  ["tm-dir", "tm-options"].forEach((id) => { const n = el(id); if (n) n.addEventListener("input", applyTodayMoverFilters); });
  if (el("load-cleanmovers")) el("load-cleanmovers").addEventListener("click", loadCleanMovers);
  ["cm-grade", "cm-bias", "cm-options"].forEach((id) => { const n = el(id); if (n) n.addEventListener("input", applyCleanMoverFilters); });
  if (el("load-toppicks")) el("load-toppicks").addEventListener("click", loadTopPicks);
  document.querySelectorAll("#tp-subtabs .sub-tab").forEach((b) => b.addEventListener("click", () => {
    state.topPickSub = b.getAttribute("data-tpsub");
    document.querySelectorAll("#tp-subtabs .sub-tab").forEach((x) => x.classList.toggle("active", x === b));
    if (state.topPicksData) renderTopPicks(state.topPicksData);
  }));
  // Top Pick universe toggle: Stocks | Indices (re-renders the cached scan).
  document.querySelectorAll("#tp-universe .sub-tab").forEach((b) => b.addEventListener("click", () => {
    state.tpUniverse = b.getAttribute("data-tpuni");
    document.querySelectorAll("#tp-universe .sub-tab").forEach((x) => x.classList.toggle("active", x === b));
    if (state.topPicksData) renderTopPicks(state.topPicksData);
  }));
  if (el("mt-apply")) el("mt-apply").addEventListener("click", runMoveTiming);
  if (el("load-optionsell")) el("load-optionsell").addEventListener("click", loadOptionSell);
  ["bm-sort", "bm-stage", "bm-sector", "bm-options"].forEach((id) => {
    const n = el(id);
    if (n) n.addEventListener("input", applyBigMoveFilters);
  });
  if (el("load-movers")) el("load-movers").addEventListener("click", loadMovers);
  ["mv-sort", "mv-stage", "mv-sector", "mv-options", "mv-min"].forEach((id) => {
    const n = el(id);
    if (n) n.addEventListener("input", applyMoversFilters);
  });
  el("pp-auto").addEventListener("click", paperAutoGate);
  el("pp-start").addEventListener("click", paperStart);
  el("pp-tick").addEventListener("click", paperTickNow);
  el("pp-stop").addEventListener("click", paperStop);
  el("pp-reset").addEventListener("click", paperReset);
  el("get-option").addEventListener("click", () => state.active && loadOption(state.active));
  setupTabs();
  setupConnect();
  setupFeedToggles();
  setupChartTools();
  setupCompliance();

  loadAlerts();
  startAlertsAutoRefresh();
  startSwingAutoRefresh();
  updateMarketStatus();
  setInterval(updateMarketStatus, 30 * 1000);
  updateDataStatus();
  setInterval(updateDataStatus, 15 * 1000);
  updateSuccessIndicator();
  setInterval(updateSuccessIndicator, 30 * 1000);
  updateBestTrade();
  setInterval(updateBestTrade, 60 * 1000);
}

function updateMarketStatus() {
  // Updates every market-status pill on the page (the main app topbar's
  // #market-status AND the Home screen's #home-market-status) from one
  // real, shared isMarketOpen() check - no separate/duplicated status logic.
  const nodes = document.querySelectorAll("[data-market-status]");
  if (!nodes.length) return;
  const open = isMarketOpen();
  const nowIST = new Date(Date.now() + (new Date().getTimezoneOffset() + 330) * 60000);
  const day = nowIST.getDay();
  const mins = nowIST.getHours() * 60 + nowIST.getMinutes();
  const preOpen = day >= 1 && day <= 5 && mins >= 540 && mins < 555; // 09:00-09:15
  const t = state.lastRefreshIst ? " · " + state.lastRefreshIst : "";
  let text, cls;
  if (open) { text = "● Market OPEN" + t; cls = "pill market-status open"; }
  else if (preOpen) { text = "● Pre-open" + t; cls = "pill market-status pre"; }
  else { text = "● Market CLOSED" + t; cls = "pill market-status muted"; }
  nodes.forEach((node) => { node.textContent = text; node.className = cls; });
}

// Live-feed freshness indicator: shows source, last tick, and refresh cadence.
// §C.4 cadence panel — inspectable refresh tiers so a trader can tell WHY something
// hasn't updated (vs wondering if it's frozen). Reads only existing cadence metadata.
function cadencePanelHtml(c, d) {
  const rows = [
    ["Quotes / charts", c.quotesSec, d.lastTickAgeSec],
    ["Option OI", c.oiSec, null],
    ["Bulletin", c.bulletinSec, null],
    ["Daily bars", c.dailySec, null],
    ["Hourly model", c.hourlySec, null],
    ["Paper tick", c.paperTickSec, null],
    ["Live alerts", c.alertsSec, null],
  ].filter((r) => r[1]);
  const fmtEvery = (sec) => (sec >= 60 ? Math.round(sec / 60) + "m" : sec + "s");
  const body = rows.map(([lab, sec, age]) => {
    const nextIn = age != null ? Math.max(0, sec - age) : null;
    return `<div class="cadence-row"><span>${lab}</span><b>every ${fmtEvery(sec)}</b>${nextIn != null ? `<em>next ~${nextIn}s</em>` : ""}</div>`;
  }).join("");
  return `<div class="cadence-head">Refresh cadence${d.marketOpen ? "" : " · market closed"}</div>${body || '<div class="wl-sub">cadence unavailable</div>'}`;
}
// §5–7/§18 Dhan connection & data-health detail panel (opens from the status pill).
function dhanHealthPanelHtml(S, gh, d, c) {
  const rows = [
    ["Status", S.txt],
    ["Data Source", "DHAN"],
    ["Market", d.marketOpen ? "OPEN" : "CLOSED"],
    ["Last Update", gh.lastDataTs ? new Date(gh.lastDataTs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—"],
    ["Data Age", gh.dataAgeSec != null ? gh.dataAgeSec + " sec" : "—"],
    ["API Latency", gh.latencyMs != null ? gh.latencyMs + " ms" : "—"],
    ["Updates", gh.updates != null ? Number(gh.updates).toLocaleString() : "—"],
    ["Failures", gh.failures != null ? gh.failures : "—"],
    ["Reconnects", gh.reconnects != null ? gh.reconnects : "—"],
  ];
  return `<div class="cadence-head">${S.dot} Dhan Connection · Data Health</div>` +
    rows.map(([k, v]) => `<div class="cadence-row"><span>${k}</span><b>${v}</b></div>`).join("") +
    `<div class="cadence-row"><span>OI refresh</span><b>every ${(c && c.oiSec) || 90}s</b></div>`;
}
async function updateDataStatus() {
  const node = el("market-status");
  if (!node) return;
  // Wire the cadence panel toggle once (idempotent).
  const gsBtn = el("dhan-status");
  if (gsBtn && !gsBtn.dataset.wired) {
    gsBtn.dataset.wired = "1";
    gsBtn.addEventListener("click", () => { const gp = el("dhan-health-panel"); if (gp) gp.classList.toggle("hidden"); });
  }
  if (!node) return;
  try {
    const d = await fetch("/api/data-status").then((r) => r.json());
    paintFeedToggles(d);
    // Market regime pill (range-bound vs trending).
    const rn = el("regime-ind");
    if (rn) {
      if (d.regime) {
        const arrow = d.regime.dir === "up" ? "▲" : d.regime.dir === "down" ? "▼" : "•";
        rn.textContent = `regime: ${d.regime.state} ${arrow} (ADX ${d.regime.adx})`;
        rn.className = "pill market-status " + (d.regime.state === "Trending" ? "open" : d.regime.state === "Range-bound" ? "closed" : "pre");
        rn.title =
          d.regime.state === "Range-bound"
            ? `NIFTY is RANGE-BOUND (ADX ${d.regime.adx} < 18). Bought options bleed theta with no move - the engine SKIPS new option buys now.`
            : `NIFTY ${d.regime.state} ${d.regime.dir} (ADX ${d.regime.adx}). ${d.regime.state === "Trending" ? "Good for directional option buys." : "Weak trend - trade selectively."}`;
      } else {
        rn.textContent = "regime: -";
        rn.className = "pill";
      }
    }
    // Trade-zone verdict pill (NO-TRADE / SELECTIVE / TRADE-ON / CLOSED).
    const zn = el("zone-ind");
    if (zn) {
      if (d.tradeZone) {
        const tz = d.tradeZone;
        const icon = tz.zone === "TRADE-ON" ? "✅" : tz.zone === "SELECTIVE" ? "⚠️" : tz.zone === "NO-TRADE" ? "⛔" : "🌙";
        zn.textContent = `zone: ${icon} ${tz.zone}`;
        zn.className = "pill market-status " + (tz.zone === "TRADE-ON" ? "open" : tz.zone === "SELECTIVE" ? "pre" : "closed");
        zn.title = tz.reason || "";
      } else {
        zn.textContent = "zone: -";
        zn.className = "pill";
      }
    }
    const c = d.cadence || {};
    // §C.2 single data-health readout: which provider serves OPTIONS (Dhan only,
    // per the strict live-option policy) + whether the feed is degraded/after-hours.
    // §5–7 Dhan connection / data-health readout — Dhan is the ONLY source.
    const gs = el("dhan-status");
    const gh = d.dhanHealth || d.growwHealth || {};
    const status = gh.status || d.dhanStatus || d.growwStatus || (d.hasDhanToken || d.hasGrowwToken ? (d.marketOpen ? "YELLOW" : "CLOSED") : "GREY");
    const STATUS = {
      GREEN:  { dot: "🟢", txt: "DHAN CONNECTED — LIVE", cls: "open" },
      YELLOW: { dot: "🟡", txt: "DHAN CONNECTED — DELAYED", cls: "pre" },
      RED:    { dot: "🔴", txt: "DHAN DISCONNECTED", cls: "closed" },
      GREY:   { dot: "⚪", txt: "DHAN NOT CONFIGURED", cls: "" },
      CLOSED: { dot: "🌙", txt: "MARKET CLOSED", cls: "pre" },
    };
    const S = STATUS[status] || STATUS.GREY;
    if (gs) {
      gs.textContent = `${S.dot} ${S.txt}`;
      gs.className = "pill market-status " + S.cls;
      gs.title = `Data source: DHAN (only). ${d.feedMode || ""}`.trim();
      const gp = el("dhan-health-panel");
      if (gp) gp.innerHTML = dhanHealthPanelHtml(S, gh, d, c);
    }
    // §8 Trading-safety banner: block live signals when Dhan is unhealthy/closed.
    const sb = el("signal-block-banner");
    if (sb) {
      if (d.signalsBlocked) {
        sb.innerHTML = `<span class="cs-dot red"></span><b>SIGNAL BLOCKED</b> — ${d.signalsBlockedReason || "Dhan data unavailable/stale"}`;
        sb.className = "cs-seg cs-status blocked";
        sb.title = d.signalsBlockedReason || "Live signals blocked";
      } else {
        sb.innerHTML = `<span class="cs-dot green"></span><b>LIVE SIGNALS ENABLED</b>`;
        sb.className = "cs-seg cs-status ok";
        sb.title = "Dhan connected, data fresh — live signals allowed";
      }
    }
    // Single consolidated MARKET pill: session + freshness + timestamp. Neutral/muted when
    // closed (routine overnight state — amber is reserved for real caution like weak trend).
    state.lastRefreshIst = d.refreshIst || state.lastRefreshIst;
    if (d.live) {
      const age = d.lastTickAgeSec;
      const ageStr = age == null ? "?" : age < 90 ? age + "s ago" : Math.round(age / 60) + "m ago";
      const fresh = d.marketOpen && age != null && age <= 90;
      node.textContent = `● Market OPEN · tick ${ageStr}${d.refreshIst ? " · " + d.refreshIst : ""}`;
      node.className = "pill market-status " + (fresh ? "open" : "pre");
      node.title =
        `Dhan live feed. ${d.refSymbol} ₹${d.refPrice ?? "-"}, last tick ${ageStr}.\n` +
        `Refresh cadence — quotes ~${c.quotesSec}s · option OI ~${c.oiSec}s · daily ~${Math.round((c.dailySec || 0) / 60)}m · ` +
        `paper tick ~${Math.round((c.paperTickSec || 0) / 60)}m.`;
    } else {
      const t = d.refreshIst ? ` · ${d.refreshIst}` : "";
      node.textContent = `● Market CLOSED${t}`;
      node.className = "pill market-status muted";
      node.title = (d.feedMode || "Market closed — Dhan historical only, no live signals") +
        "\nData source: DHAN (only).\nLast status refresh " + (d.refreshIst || "");
    }
  } catch {
    /* leave the last-known market pill in place on a transient fetch error */
  }
}

// Success indicator: the app's REAL measured track record from the autonomous
// paper-trading run (win rate + P&L). This is measured, not a self-estimate.
async function updateSuccessIndicator() {
  const node = el("success-ind");
  if (!node) return;
  try {
    const s = await fetch("/api/paper/state").then((r) => r.json());
    const decided = (s.wins || 0) + (s.losses || 0);
    const started = s.option?.startCapital || s.swing?.startCapital;
    if (!started) {
      node.textContent = "success: no run yet";
      node.className = "pill";
      node.title = "Start the autonomous Paper Trading run to build a measured track record.";
      return;
    }
    if (decided === 0) {
      node.textContent = `success: ${s.active ? "running" : "pending"} (0 closed)`;
      node.className = "pill market-status muted";
      node.title = "Paper run is live but no trades have closed yet - win rate appears after the first exits.";
      return;
    }
    const wr = s.winRate;
    const pnl = s.totalPnlPct;
    const good = wr >= 55 && pnl >= 0;
    const ok = wr >= 45 && pnl > -2;
    node.textContent = `✓ ${wr}% win · ${pnl >= 0 ? "+" : ""}${fmt(pnl)}%`;
    node.className = "pill market-status " + (good ? "open" : ok ? "pre" : "closed");
    node.title =
      `Measured paper track record: win rate ${wr}% (${s.wins}W/${s.losses}L over ${decided} closed trades), ` +
      `total P&L ${pnl >= 0 ? "+" : ""}${fmt(pnl)}% (₹${fmt(s.totalPnl)}). Day ${s.tradingDaysElapsed}/${s.days}. ` +
      `This is the app's real, self-verified performance - not a confidence estimate.`;
  } catch {
    node.textContent = "success: -";
    node.className = "pill";
  }
}

// Best trade on the 15-min model, shown in the header across every section.
async function updateBestTrade() {
  const node = el("best-trade");
  if (!node) return;
  try {
    const d = await fetch("/api/best-trade").then((r) => r.json());
    if (!d.marketOpen) {
      node.textContent = "best 15m: market closed";
      node.className = "pill best-trade";
      node.title = "Best 15-min trade appears during market hours (9:15 AM - 3:30 PM IST).";
      return;
    }
    let b = d.best;
    if (!b) {
      state.bestPick = null;
      node.textContent = "best 15m: none — wait";
      node.className = "pill best-trade";
      node.title = "No safety-gated 15-min option setup right now. Best trade = no trade.";
      return;
    }
    // STICKINESS: don't hop to a different stock on a marginal ranking change.
    // Switch only when the new #1 beats the held pick's confidence by >=8 (a clear
    // edge) or its direction reversed — so the "best play" is solid, not jumpy.
    const last = state.bestPick;
    if (last && (b.symbol !== last.symbol || b.optionType !== last.optionType)) {
      if ((b.confidence ?? 0) < (last.confidence ?? 0) + 8 && b.direction === last.direction) b = last;
    }
    state.bestPick = b;
    const cls = b.direction === "Bullish" ? "up" : "down";
    node.innerHTML = `best 15m: <b>${b.name} ${b.strike}${b.optionType}</b> <span class="${cls}">${b.direction}</span> ${b.confidence}% +${fmt(b.expectedPremiumMovePct)}%`;
    node.className = "pill best-trade " + cls;
    node.title =
      `Best 15-min option play now: ${b.name} ${b.strike} ${b.optionType} (${b.direction}), ` +
      `win-case ${b.confidence}%, premium ${b.premium} -> ${b.premiumTarget} (+${fmt(b.expectedPremiumMovePct)}%), ` +
      `theta ${b.thetaPctPerDay}%/day, ${b.decayLevel} decay. Click a tab to act on it. Ranked #1 of ${d.count}.`;
  } catch {
    node.textContent = "best 15m: —";
  }
}

// NSE market hours: Mon-Fri, 09:15-15:30 IST.
function isMarketOpen() {
  const nowIST = new Date(Date.now() + (new Date().getTimezoneOffset() + 330) * 60000);
  const day = nowIST.getDay();
  if (day === 0 || day === 6) return false;
  const mins = nowIST.getHours() * 60 + nowIST.getMinutes();
  return mins >= 555 && mins <= 930;
}
function isFeedWindow() {
  const nowIST = new Date(Date.now() + (new Date().getTimezoneOffset() + 330) * 60000);
  const day = nowIST.getDay();
  if (day === 0 || day === 6) return false;
  const mins = nowIST.getHours() * 60 + nowIST.getMinutes();
  return mins >= 540 && mins <= 935;
}

function startSessionKeeper() {
  if (state.sessionKeeper) return;
  state.sessionKeeper = setInterval(() => {
    if (!isMarketOpen() && !isFeedWindow()) return;
    const active = document.querySelector("#tabs .tab.active");
    const name = active ? active.getAttribute("data-tab") : "";
    if (name === "oicommand") loadOiCommand();
    else if (name === "toppicks") loadTopPicks(true);
    else if (name === "paper") loadPaper();
    else if (name === "earlymoves") loadEarlyMoves();
    else if (name === "liquiditystatus") loadLiquidityStatusScreen();
    else if (name === "stock" && state.active) loadSymbol(state.active);
  }, 30 * 1000);
}

// Auto-refresh the movers tab every 5 min while it's open and the market is live.
function startSwingAutoRefresh() {
  setInterval(() => {
    const panel = document.getElementById("panel-swing");
    if (panel && panel.classList.contains("active") && state.swingLoaded && isMarketOpen()) {
      loadSwing();
    }
  }, 5 * 60 * 1000);
  // Today's Big Movers: refresh every 90s while open and the market is live.
  setInterval(() => {
    const panel = document.getElementById("panel-todaymovers");
    if (panel && panel.classList.contains("active") && state.todayMoversLoaded && isMarketOpen()) {
      loadTodayMovers();
    }
  }, 90 * 1000);
}

// ---------- charts ----------
function buildChart() {
  const container = el("chart");
  chart = LightweightCharts.createChart(container, chartOpts(container.clientWidth, 420));
  candleSeries = chart.addCandlestickSeries({
    upColor: "#16c784", downColor: "#ea3943",
    wickUpColor: "#16c784", wickDownColor: "#ea3943", borderVisible: false,
  });
  // Overlays like the reference chart: EMA21 (thin), EMA50 (thick), VWAP (dashed).
  // EMA9 + Supertrend exist but are OFF by default to keep the chart clean.
  ema9Series = chart.addLineSeries({ color: "#f0b90b", lineWidth: 1, visible: false });
  ema21Series = chart.addLineSeries({ color: "#5b9bd5", lineWidth: 1 });
  ema50Series = chart.addLineSeries({ color: "#2962ff", lineWidth: 2 });
  vwapSeries = chart.addLineSeries({ color: "#a855f7", lineWidth: 1, lineStyle: 2 });
  stSeries = chart.addLineSeries({ color: "#16c784", lineWidth: 1, lineStyle: 0, visible: false });
  // Volume histogram pinned to the bottom of the price pane.
  volumeSeries = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  // Bollinger (solid faint) and Keltner (dashed) bands for the squeeze view - off by default.
  bbUpperSeries = chart.addLineSeries({ color: "rgba(59,130,246,0.55)", lineWidth: 1, visible: false });
  bbLowerSeries = chart.addLineSeries({ color: "rgba(59,130,246,0.55)", lineWidth: 1, visible: false });
  kcUpperSeries = chart.addLineSeries({ color: "rgba(240,185,11,0.6)", lineWidth: 1, lineStyle: 2, visible: false });
  kcLowerSeries = chart.addLineSeries({ color: "rgba(240,185,11,0.6)", lineWidth: 1, lineStyle: 2, visible: false });

  seriesMap.ema9 = ema9Series;
  seriesMap.ema21 = ema21Series;
  seriesMap.ema50 = ema50Series;
  seriesMap.vwap = vwapSeries;
  seriesMap.st = stSeries;
  seriesMap.vol = volumeSeries;
  seriesMap.bb = [bbUpperSeries, bbLowerSeries];
  seriesMap.kc = [kcUpperSeries, kcLowerSeries];

  // Alternate chart types (line / area) - hidden until selected.
  lineSeries = chart.addLineSeries({ color: "#e6ebf2", lineWidth: 2, visible: false });
  areaSeries = chart.addAreaSeries({
    lineColor: "#3b82f6", topColor: "rgba(59,130,246,0.4)", bottomColor: "rgba(59,130,246,0.03)",
    lineWidth: 2, visible: false,
  });

  // RSI sub-pane, time-synced with the price chart.
  const rc = el("rsi-chart");
  rsiChart = LightweightCharts.createChart(rc, chartOpts(rc.clientWidth, 130));
  rsiSeries = rsiChart.addLineSeries({ color: "#e879f9", lineWidth: 1 });
  rsiSeries.createPriceLine({ price: 70, color: "rgba(234,57,67,0.6)", lineWidth: 1, lineStyle: 2, title: "70" });
  rsiSeries.createPriceLine({ price: 30, color: "rgba(22,199,132,0.6)", lineWidth: 1, lineStyle: 2, title: "30" });
  rsiSeries.createPriceLine({ price: 50, color: "rgba(138,151,173,0.4)", lineWidth: 1, lineStyle: 3, title: "50" });
  window.addEventListener("resize", () => rsiChart.applyOptions({ width: rc.clientWidth }));

  // MACD sub-pane (12/26/9): histogram + MACD line + signal line, time-synced.
  const mc = el("macd-chart");
  if (mc) {
    macdChart = LightweightCharts.createChart(mc, chartOpts(mc.clientWidth, 130));
    macdHistSeries = macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    macdLineSeries = macdChart.addLineSeries({ color: "#2962ff", lineWidth: 1 });
    macdSignalSeries = macdChart.addLineSeries({ color: "#f0b90b", lineWidth: 1 });
    macdLineSeries.createPriceLine({ price: 0, color: "rgba(138,151,173,0.4)", lineWidth: 1, lineStyle: 3, title: "0" });
    window.addEventListener("resize", () => macdChart.applyOptions({ width: mc.clientWidth }));
  }

  // Keep all panes' time ranges in sync when panning/zooming.
  const syncFrom = (src) => (range) => {
    if (rangeSyncing || !range) return;
    rangeSyncing = true;
    if (src !== "price") chart.timeScale().setVisibleLogicalRange(range);
    if (src !== "rsi") rsiChart.timeScale().setVisibleLogicalRange(range);
    if (src !== "macd" && macdChart) macdChart.timeScale().setVisibleLogicalRange(range);
    rangeSyncing = false;
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange(syncFrom("price"));
  rsiChart.timeScale().subscribeVisibleLogicalRangeChange(syncFrom("rsi"));
  if (macdChart) macdChart.timeScale().subscribeVisibleLogicalRangeChange(syncFrom("macd"));

  // Live hover readout of OHLC + indicator values at the crosshair.
  chart.subscribeCrosshairMove((param) => {
    if (!param || param.time == null) { updateLegend(state.chart.candles.length - 1); return; }
    const idx = state.chart.timeToIndex.get(param.time);
    if (idx != null) updateLegend(idx);
  });

  setupToggles();
  window.addEventListener("resize", () => chart.applyOptions({ width: container.clientWidth }));
}

function buildEquityChart() {
  const container = el("equity");
  equityChart = LightweightCharts.createChart(container, chartOpts(container.clientWidth, 220));
  equitySeries = equityChart.addAreaSeries({
    lineColor: "#3b82f6", topColor: "rgba(59,130,246,0.4)", bottomColor: "rgba(59,130,246,0.02)", lineWidth: 2,
  });
  window.addEventListener("resize", () => equityChart.applyOptions({ width: container.clientWidth }));
}

// Format an epoch-second time in IST (NSE timezone) for the chart axis/crosshair.
function fmtIST(t, withDate) {
  const d = new Date(t * 1000);
  const opts =
    state.interval === "1d"
      ? { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }
      : withDate
      ? { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }
      : { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false };
  return d.toLocaleString("en-IN", opts);
}

function chartOpts(width, height) {
  return {
    width, height,
    layout: { background: { color: "transparent" }, textColor: "#8a97ad" },
    grid: { vertLines: { color: "#1a2130" }, horzLines: { color: "#1a2130" } },
    // Render axis + crosshair times in IST (lightweight-charts defaults to UTC).
    localization: { timeFormatter: (t) => fmtIST(t, true) },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: "#232c3d",
      tickMarkFormatter: (t) => fmtIST(t, false),
    },
    rightPriceScale: { borderColor: "#232c3d" },
    crosshair: { mode: 0 },
  };
}

// ---------- app-level best-2 option opportunities + 1s live ticker ----------
async function loadTopOpportunities() {
  try {
    const d = await fetchJSON("/api/top-opportunities", 15000);
    renderOppBar(d);
  } catch (_) { /* ignore */ }
}

function renderOppBar(d) {
  const box = el("opp-bar-items");
  if (!box) return;
  if (!d || d.marketOpen === false) {
    box.innerHTML = '<span class="wl-sub">Market closed &mdash; best option plays appear during market hours.</span>';
    state.oppData = []; state.oppSymbols = [];
    return;
  }
  const picks = d.picks || [];
  const indices = (d.indices || []).filter((x) => x.available !== false);
  const swing = d.swing || [];
  if (!picks.length && !indices.length && !swing.length) {
    box.innerHTML = '<span class="wl-sub">No qualifying play right now.</span>';
    state.oppData = []; state.oppSymbols = [];
    return;
  }
  // Everything feeds the live ticker too (spot + flash + direction message).
  state.oppData = [...indices, ...picks, ...swing];
  state.oppSymbols = state.oppData.map((p) => p.symbol);
  const levelPill = (x) => {
    if (x.level === "TRADE") return '<span class="risk-pill up">✅ TRADE</span>';
    if (x.level === "WATCH") return '<span class="risk-pill">👀 WATCH</span>';
    return '<span class="risk-pill down">⏳ WAIT</span>';
  };
  // Volume indicator: high vol = move has conviction; low = false-move risk; N/A = index (no volume feed).
  const volPill = (rvol) => {
    if (rvol == null) return '<span class="vol-pill vol-na" title="Index has no volume feed">🔇 vol N/A</span>';
    if (rvol >= 1.5) return `<span class="vol-pill vol-hi" title="High participation (${rvol}x normal) — move has conviction">🔊 vol ${rvol}x</span>`;
    if (rvol >= 0.8) return `<span class="vol-pill vol-mid" title="Normal volume (${rvol}x)">🔉 vol ${rvol}x</span>`;
    return `<span class="vol-pill vol-lo" title="Low volume (${rvol}x) — weak participation, higher false-move risk">🔈 vol ${rvol}x</span>`;
  };
  const shortName = (n) => n.replace("NIFTY 50", "NIFTY").replace("NIFTY BANK", "BANKNIFTY").replace("FIN NIFTY", "FINNIFTY").replace("MIDCAP NIFTY", "MIDCAP");
  // Clean, plain-language index chip: ACTION line + trade line + spot/S/R/side.
  const idxHtml = indices.map((x) => {
    const cls = x.direction === "Bullish" ? "up" : x.direction === "Bearish" ? "down" : "";
    const s = x.sr || {};
    const sideTxt = s.sentiment === "Bullish" ? "तेज़ी · CE साइड" : s.sentiment === "Bearish" ? "मंदी · PE साइड" : "न्यूट्रल";
    const action = (x.level === "TRADE" && x.strike)
      ? `<span class="risk-pill ${cls}">${x.arrow} BUY ${x.strike} ${x.optionType}</span>`
      : x.level === "WATCH" ? `<span class="risk-pill">👀 WATCH</span>` : `<span class="risk-pill">⏳ WAIT</span>`;
    const line2 = (x.level === "TRADE" && x.strike)
      ? `<div class="opp-line">Entry <b>₹${fmt(x.premium)}</b> → Target <b class="up">₹${fmt(x.premiumTarget)}</b> <span class="wl-sub">(conf ${x.confidence}%)</span></div>`
      : `<div class="opp-line wl-sub">${x.level === "WATCH" ? "signal बन रहा है — पुष्टि का इंतज़ार" : "दिशा साफ़ नहीं — अभी रुको"}</div>`;
    return `
    <div class="opp-chip idx-chip ${cls}" data-sym="${x.symbol}">
      <div class="opp-head"><b>${shortName(x.name)}</b> ${action}</div>
      ${line2}
      <div class="opp-line wl-sub">
        <span class="opp-live" id="opplive-${cssId(x.symbol)}">Spot ${s.spot != null ? s.spot : (x.spot != null ? fmt(x.spot) : "-")}</span>
        · S <b class="up">${s.support != null ? s.support : (s.majorSupport ?? "-")}</b>
        · R <b class="down">${s.resistance != null ? s.resistance : (s.majorResistance ?? "-")}</b>
        · ${sideTxt}
      </div>
    </div>`;
  }).join("");
  const timingPill = (p) => {
    const t = p.timing;
    if (t === "EARLY") return '<span class="risk-pill up" title="' + (p.timingHindi || "") + '">🟢 EARLY</span>';
    if (t === "EXTENDED") return '<span class="risk-pill down" title="' + (p.timingHindi || "") + '">🔴 EXTENDED' + (p.todayMovePct != null ? " " + (p.todayMovePct >= 0 ? "+" : "") + fmt(p.todayMovePct) + "%" : "") + "</span>";
    if (t === "UNDERWAY") return '<span class="risk-pill" title="' + (p.timingHindi || "") + '">🟡 UNDERWAY</span>';
    return "";
  };
  const picksHtml = picks.map((p, i) => `
    <div class="opp-chip" data-sym="${p.symbol}">
      <div class="opp-head">${i === 0 ? "★" : "#2"} ${p.name}
        <span class="risk-pill ${p.direction === "Bullish" ? "up" : "down"}">${p.strike} ${p.optionType}</span>
        ${timingPill(p)} ${volPill(p.rvol)}
        <span class="wl-sub">conf ${p.confidence}%</span>
      </div>
      <div class="opp-sub">prem ${fmt(p.premium)}&rarr;${fmt(p.premiumTarget)} (+${fmt(p.expectedPremiumMovePct)}%) ·
        <span class="opp-live" id="opplive-${cssId(p.symbol)}">spot ${fmt(p.spot)}</span>${p.todayMovePct != null ? ' · <span class="wl-sub">today ' + (p.todayMovePct >= 0 ? "+" : "") + fmt(p.todayMovePct) + "%</span>" : ""}</div>
      <div class="opp-stat" id="oppstat-${cssId(p.symbol)}"></div>
      ${p.timingHindi ? `<div class="wl-sub" style="margin-top:2px">🧠 ${p.timingHindi}</div>` : ""}
    </div>`).join("");
  const swingPill = (s) => (s.level === "ENTER"
    ? '<span class="risk-pill up">🚀 ENTER</span>'
    : '<span class="risk-pill">🔧 WATCH</span>');
  const swingHtml = swing.map((s) => `
    <div class="opp-chip sw-chip up" data-sym="${s.symbol}">
      <div class="opp-head">📈 ${s.name}
        ${swingPill(s)} ${volPill(s.rvol)}
        <span class="wl-sub">${s.stage}</span>
      </div>
      <div class="opp-sub">entry ${fmt(s.entry)} &rarr; tgt ${fmt(s.spotTarget)} (+${fmt(s.expectedMovePct)}%) · R:R ${fmt(s.riskReward)} ·
        <span class="opp-live" id="opplive-${cssId(s.symbol)}">spot ${s.spot != null ? fmt(s.spot) : "-"}</span></div>
      <div class="opp-stat up" id="oppstat-${cssId(s.symbol)}">${s.msg || ""}</div>
    </div>`).join("");
  // Three clearly-labelled sections: INDEX · OPTIONS · SWING.
  const section = (label, html, cls) => html ? `<div class="opp-section ${cls}"><span class="opp-sep">${label}</span><div class="opp-section-items">${html}</div></div>` : "";
  box.innerHTML =
    section("INDEX", idxHtml, "sec-index") +
    section("OPTIONS", picksHtml, "sec-options") +
    section("SWING", swingHtml, "sec-swing");
  box.querySelectorAll(".opp-chip").forEach((c) => c.addEventListener("click", () => openStock(c.getAttribute("data-sym"))));
}

let liveTickBusy = false;
function startLiveTicker() {
  if (state.liveTimer) return;
  state.prevPrices = state.prevPrices || {};
  // 3s cadence + no overlap: keeps prices live without bursting the Dhan feed.
  state.liveTimer = setInterval(async () => {
    if (!isMarketOpen() || liveTickBusy) return; // static when closed; skip if a fetch is still running
    const wl = (state.symbols || []).map((s) => s.symbol);
    const syms = [...new Set([...wl, ...(state.oppSymbols || [])])];
    if (!syms.length) return;
    liveTickBusy = true;
    try {
      const d = await fetch("/api/quotes?symbols=" + encodeURIComponent(syms.join(","))).then((r) => r.json());
      const q = d.quotes || {};
      // Live watchlist prices - skip stale last-good prints so they are not shown as live.
      (state.symbols || []).forEach((s) => {
        const row = q[s.symbol];
        const px = row && !row.stale && row.price;
        if (px == null) return;
        const cell = el("wlp-" + cssId(s.symbol));
        if (cell && cell.textContent !== fmt(px)) cell.textContent = fmt(px);
        state.prevPrices[s.symbol] = px;
      });
      // Live spot + real-time "against/reversed" warning on the opportunity chips.
      (state.oppData || []).forEach((p) => {
        const px = q[p.symbol] && !q[p.symbol].stale && q[p.symbol].price;
        const live = el("opplive-" + cssId(p.symbol));
        if (px != null && live) {
          const toT = p.spotTarget ? ((p.direction === "Bullish" ? p.spotTarget - px : px - p.spotTarget) / px) * 100 : null;
          live.textContent = "spot " + fmt(px) + (toT != null ? " · " + fmt(Math.abs(toT)) + "% to tgt" : "");
          const prev = state.prevPrices["opp:" + p.symbol];
          const chip = live.closest(".opp-chip");
          // Flash ONLY on a MEANINGFUL move (>= 0.15%), not on every micro-tick —
          // keeps the best-play indication calm/solid instead of flashing each 3s.
          if (chip && prev != null && Math.abs((px - prev) / prev) * 100 >= 0.15) {
            chip.classList.remove("opp-flash-up", "opp-flash-down"); void chip.offsetWidth;
            chip.classList.add(px > prev ? "opp-flash-up" : "opp-flash-down");
          }
          state.prevPrices["opp:" + p.symbol] = px;
          // Real-time direction check vs the play's reference: catches an opposite
          // move in ~3s. Use WIDER bands so the status reflects a CONFIRMED move,
          // not every tiny wobble (no more flip-flopping every few seconds).
          const stat = el("oppstat-" + cssId(p.symbol));
          if (stat && p.spot && p.spotTarget && !p.stage) {
            const bull = p.direction === "Bullish";
            const favPct = ((bull ? px - p.spot : p.spot - px) / p.spot) * 100;
            const crossedStop = p.spotStop ? (bull ? px <= p.spotStop : px >= p.spotStop) : false;
            if (crossedStop) { stat.textContent = "⛔ REVERSED — निकल जाओ (स्टॉप टूटा)"; stat.className = "opp-stat down"; }
            else if (favPct <= -0.35) { stat.textContent = `⚠ उल्टा जा रहा है (${fmt(favPct)}%) — सावधान/छोटा लॉस लो`; stat.className = "opp-stat down"; }
            else if (favPct >= 0.35) { stat.textContent = `✓ सही दिशा (+${fmt(favPct)}%)`; stat.className = "opp-stat up"; }
            else { stat.textContent = "→ फ्लैट, इंतज़ार करो"; stat.className = "opp-stat"; }
          }
        }
      });
    } catch (_) { /* ignore transient */ } finally { liveTickBusy = false; }
  }, 3000);
}

// ---------- watchlist ----------
// Signal data cache per symbol: { score, label, price }. Populated by
// loadWatchlistBadges() and used to ORDER the list: indices first, then the
// best opportunities (strongest |signal| = most actionable) below them.
state.wlData = state.wlData || {};

// Display order = indices (in config order) then equities sorted by signal
// strength (|score| desc) so the best opportunity sits right under the indices.
function watchlistOrder() {
  const indices = state.symbols.filter((s) => s.type === "index");
  const equities = state.symbols.filter((s) => s.type !== "index");
  equities.sort((a, b) => {
    // Prefer the early-warning Watch Score (0-100) when the scan has run;
    // otherwise fall back to the older |signal| ordering.
    const sa = state.watchScan[a.symbol]?.score ?? Math.abs(state.wlData[a.symbol]?.score ?? 0);
    const sb = state.watchScan[b.symbol]?.score ?? Math.abs(state.wlData[b.symbol]?.score ?? 0);
    return sb - sa; // strongest opportunity first
  });
  return [...indices, ...equities];
}

// Volume-quality badge from relative volume (rvol): is participation strong enough
// for a clean trade? >=1.3 = good (conviction), >=2 = strong; <0.7 = weak (false-move
// risk). Indices have no volume feed (rvol null) → no badge.
function volBadge(rvol) {
  if (rvol == null) return "";
  const cls = rvol >= 2 ? "vol-vhigh" : rvol >= 1.3 ? "vol-high" : rvol >= 0.7 ? "vol-normal" : "vol-low";
  const icon = rvol >= 2 ? "🔥" : rvol >= 1.3 ? "✅" : rvol >= 0.7 ? "◽" : "⚠️";
  const tip = rvol >= 1.3 ? "अच्छा volume — move में दम (conviction, trade ठीक)" : rvol >= 0.7 ? "सामान्य volume" : "कम volume — false-move risk, सावधानी";
  return `<span class="vol-pill ${cls}" title="Relative volume ${rvol}x — ${tip}">${icon} Vol ${rvol}x</span>`;
}
// Compact early-warning strip for a watched stock: Stage · Score · Bias, then
// Action, then Trigger / Invalidation. Purely presents the backend scan row
// (backend/watchlist/scanner.ts) - no BUY is generated here. A stale/missing
// feed renders as DATA UNAVAILABLE / WAIT, never a live read.
const WL_STAGE_CLS = { "QUIET": "q", "BUILDING": "b", "BREAKOUT WATCH": "bw", "EARLY MOVE": "em", "DEVELOPING": "dv", "STRONG MOVE": "sm", "EXTENDED": "ex", "REVERSAL WATCH": "rw" };
const WL_ACTION_CLS = { "TAKE": "take", "BREAKOUT READY": "ready", "WAIT FOR PULLBACK": "pull", "AVOID CHASING": "avoid", "WATCH": "watch" };
function watchScanHtml(w) {
  if (!w) return "";
  if (w.dataState !== "OK") {
    return `<div class="wl-ew wl-ew-na" title="${(w.note || "").replace(/"/g, "&quot;")}">⚠ DATA UNAVAILABLE · WAIT</div>`;
  }
  const biasCls = w.bias === "Bullish" ? "up" : w.bias === "Bearish" ? "down" : "neu";
  const trig = w.trigger != null ? fmt(w.trigger, 0) : "—";
  const inval = w.invalidation != null ? fmt(w.invalidation, 0) : "—";
  return `<div class="wl-ew" title="${(w.note || "").replace(/"/g, "&quot;")}">
    <div class="wl-ew-top">
      <span class="wl-stage wl-stage-${WL_STAGE_CLS[w.stage] || "q"}">${w.stage}</span>
      <span class="wl-score">${Math.round(w.score)}<i>/100</i></span>
      <span class="wl-bias ${biasCls}">${w.bias}</span>
    </div>
    <div class="wl-ew-mid"><span class="wl-act wl-act-${WL_ACTION_CLS[w.action] || "watch"}">${w.action}</span></div>
    <div class="wl-ew-lv"><span>Trigger <b>${trig}</b></span><span>Invalidation <b>${inval}</b></span></div>
  </div>`;
}

function renderWatchlist() {
  const box = el("watchlist-items");
  box.innerHTML = "";
  const oiFocus = document.body.classList.contains("oi-focus");
  const ordered = oiFocus ? state.symbols.filter((s) => s.type === "index") : watchlistOrder();
  let lastWasIndex = null;
  const deskBy = {};
  (state.indexDesk && state.indexDesk.rows || []).forEach((r) => { deskBy[r.symbol] = r; });
  const oiN = (n) => {
    if (n == null || isNaN(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
    if (a >= 1e5) return (n / 1e5).toFixed(2) + "L";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };
  const sideChip = (tf, t) => {
    if (!t || !t.option) return `<span class="wl-tf">${tf} <b class="neu">FLAT</b></span>`;
    const cls = t.option === "CE" ? "up" : "down";
    return `<span class="wl-tf">${tf} <b class="${cls}">${t.option}</b> ${t.label || ""}</span>`;
  };
  ordered.forEach((s) => {
    const d = state.wlData[s.symbol];
    const desk = deskBy[s.symbol];
    const isIndex = s.type === "index";
    if (lastWasIndex === null || isIndex !== lastWasIndex) {
      const hdr = document.createElement("div");
      hdr.className = "wl-group";
      hdr.textContent = isIndex ? "NIFTY desk · 15m + 1h · 1 min" : "Best opportunities";
      box.appendChild(hdr);
      lastWasIndex = isIndex;
    }
    const item = document.createElement("div");
    item.className = "wl-item" + (desk ? " wl-desk" : "") + (s.symbol === state.active ? " active" : "");
    item.id = "wl-" + cssId(s.symbol);
    const priceTxt = (desk && desk.spot != null) ? fmt(desk.spot, 0) : (d && d.price != null ? fmt(d.price) : "-");
    const label = d && d.label ? d.label : "-";
    if (desk) {
      const hot = desk.buildHot === "CE" ? "ce" : desk.buildHot === "PE" ? "pe" : "neu";
      item.innerHTML = `
        <div class="wl-desk-h">
          <div class="wl-name">${s.name}</div>
          <div class="wl-price">${priceTxt}</div>
        </div>
        <div class="wl-tf-row">${sideChip("15m", desk.tf15)}${sideChip("1h", desk.tf1h)}</div>
        <div class="wl-sr">
          <div><span>Imm S</span><b class="up">${desk.immSupport != null ? fmt(desk.immSupport, 0) : "—"}</b>
               <span>Imm R</span><b class="down">${desk.immResistance != null ? fmt(desk.immResistance, 0) : "—"}</b></div>
          <div><span>Maj S</span><b class="up">${desk.majorSupport != null ? fmt(desk.majorSupport, 0) : "—"}</b>
               <span>Maj R</span><b class="down">${desk.majorResistance != null ? fmt(desk.majorResistance, 0) : "—"}</b></div>
        </div>
        <div class="wl-oi ${hot}">
          <div class="wl-oi-row"><span class="down">CE Δ ${desk.ceBuild ? desk.ceBuild.strike + " +" + oiN(desk.ceBuild.oiChg) : "—"}</span>
            <span class="up">PE Δ ${desk.peBuild ? desk.peBuild.strike + " +" + oiN(desk.peBuild.oiChg) : "—"}</span></div>
          <div class="wl-oi-txt">${desk.buildText || ""}</div>
        </div>`;
    } else {
      const rg = d && d.regime;
      const rgShort = { good: "Move ready", lottery: "Lottery", whipsaw: "Whipsaw (SL)", range: "Range" };
      const rgTag = rg ? `<div class="wl-regime wl-rg-${rg.state}" title="${(rg.label + " — " + rg.note).replace(/"/g, "&quot;")}">${rg.emoji} ${rgShort[rg.state] || rg.state}</div>` : "";
      const vTag = (d && d.rvol != null) ? volBadge(d.rvol) : "";
      item.innerHTML = `
        <div><div class="wl-name">${s.name}</div><div class="wl-sub">${s.symbol}</div>${rgTag}${vTag}</div>
        <div class="wl-right"><div class="wl-price" id="wlp-${cssId(s.symbol)}">${priceTxt}</div>
        <div class="wl-badge" id="wlb-${cssId(s.symbol)}" style="background:#1a2130;color:#8a97ad">${label}</div></div>
        ${watchScanHtml(state.watchScan[s.symbol])}`;
    }
    item.addEventListener("click", () => openStock(s.symbol));
    box.appendChild(item);
    if (!desk && d && d.label && el("wlb-" + cssId(s.symbol))) styleBadge(el("wlb-" + cssId(s.symbol)), d.score);
  });
}

async function loadIndexDesk() {
  try {
    const d = await fetchJSON("/api/index-desk", 14000);
    if (d && d.rows) state.indexDesk = d;
    renderWatchlist();
    const st = el("wl-refresh");
    if (st && d && d.generatedAt) {
      const when = new Date(d.generatedAt * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      st.textContent = "desk " + when + " · 1 min";
    }
  } catch (_) { /* keep last desk */ }
}

let wlBadgesBusy = false;
async function loadWatchlistBadges() {
  if (wlBadgesBusy) return; // avoid overlapping refreshes
  wlBadgesBusy = true;
  const st = el("wl-refresh");
  if (st) st.textContent = "updating...";
  try {
    // Fetch signals for every symbol into state.wlData, then re-render once so
    // the list can be ordered by signal strength without flicker. Fired in
    // parallel (was a sequential for-loop awaiting one symbol at a time, which
    // serialized ~26 round-trips and was most of "dashboard is slow after
    // login") — the browser's own per-origin connection cap plus the server's
    // Dhan request throttle (dhanProvider.ts) already bound real concurrency,
    // so this adds no extra load, just removes an unnecessary added wait.
    await Promise.all(state.symbols.map(async (s) => {
      try {
        const sig = await fetch(`/api/signal/${encodeURIComponent(s.symbol)}?interval=${state.interval}`).then((r) => r.json());
        if (sig && sig.label) {
          state.wlData[s.symbol] = { score: sig.score, label: sig.label, price: sig.price, regime: sig.regime, rvol: sig.rvol };
        }
      } catch (_) { /* ignore per-item errors */ }
    }));
    renderWatchlist(); // re-order: indices first, then best opportunities
  } finally {
    wlBadgesBusy = false;
    if (st) st.textContent = "updated " + new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}

// Early-warning scan: per-watched-stock Watch Score / stage / bias / trigger /
// invalidation / action, reusing the backend Liquidity Status engine (no new
// signal logic here). Populates state.watchScan[symbol]; renderWatchlist() reads
// it to enrich each equity row and rank the strongest opportunities on top.
state.watchScan = state.watchScan || {};
let watchScanBusy = false;
async function loadWatchlistScan() {
  if (watchScanBusy) return;
  watchScanBusy = true;
  try {
    const d = await fetchJSON("/api/watchlist/scan", 60000);
    if (d && Array.isArray(d.rows)) {
      const next = {};
      for (const r of d.rows) next[r.symbol] = r;
      state.watchScan = next;
      renderWatchlist();
    }
  } catch (_) { /* keep last scan; rows fall back to the plain badge */ }
  finally { watchScanBusy = false; }
}

// Auto-refresh watchlist prices/signals every 60s while the market is open.
function startWatchlistAutoRefresh() {
  setInterval(() => {
    loadIndexDesk();
    if (isMarketOpen() || isFeedWindow()) { loadWatchlistBadges(); loadWatchlistScan(); }
  }, 60 * 1000);
}

function styleBadge(node, score) {
  const c = colorForScore(score);
  node.style.background = c.bg;
  node.style.color = c.fg;
}

// ---------- connect / data source ----------
// Dhan and Telegram each get their own top-bar button + panel (no
// longer bundled into one "Connect data" panel). All share the same
// fixed-position panel styling, so only one is ever shown at a time.
let _dhanPollTimer = null;
function closeAllConnectPanels() {
  ["connect-panel", "telegram-panel", "dhan-panel"].forEach((id) => {
    const p = el(id);
    if (p) p.classList.add("hidden");
  });
  stopDhanPoll();
}
function setupConnect() {
  const panel = el("connect-panel");
  el("connect-btn").addEventListener("click", () => {
    const wasHidden = panel.classList.contains("hidden");
    closeAllConnectPanels();
    if (wasHidden) { panel.classList.remove("hidden"); loadDhanConfig(); startDhanPoll(); loadAuthEmail(); }
  });
  el("connect-close").addEventListener("click", closeAllConnectPanels);

  const waPanel = el("telegram-panel");
  if (waPanel) {
    el("telegram-btn").addEventListener("click", () => {
      const wasHidden = waPanel.classList.contains("hidden");
      closeAllConnectPanels();
      if (wasHidden) { waPanel.classList.remove("hidden"); loadTelegramStatus(); }
    });
    el("telegram-close").addEventListener("click", closeAllConnectPanels);
  }

  const dhanPanel = el("dhan-panel");
  if (dhanPanel) {
    el("dhan-btn").addEventListener("click", () => {
      const wasHidden = dhanPanel.classList.contains("hidden");
      closeAllConnectPanels();
      if (wasHidden) { dhanPanel.classList.remove("hidden"); loadDhanStatus(); }
    });
    el("dhan-close").addEventListener("click", closeAllConnectPanels);
  }

  // Single SAVE & CONNECT button: routes API key+secret, else pasted token.
  el("conn-saveconnect").addEventListener("click", doSaveConnect);
  el("conn-test").addEventListener("click", doTestConnection);

  // Per-field show/hide toggles (masked by default).
  document.querySelectorAll(".gc-eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const inp = el(btn.getAttribute("data-target"));
      if (!inp) return;
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      btn.classList.toggle("on", show);
      btn.setAttribute("aria-label", show ? "Hide" : "Show");
    });
  });

  // UPDATE TOKEN: reveal + focus the token field so the user can replace it.
  // REMOVE SAVED TOKEN: clears the stored token; a fresh one must be pasted.
  const upd = el("gc-update-token");
  if (upd) upd.addEventListener("click", doForgetToken);

  const saveEmail = el("auth-email-save");
  if (saveEmail) saveEmail.addEventListener("click", doSaveAuthEmail);

  const saveTg = el("tg-save");
  if (saveTg) saveTg.addEventListener("click", doSaveTelegram);
  const testTg = el("tg-test");
  if (testTg) testTg.addEventListener("click", doTestTelegram);
  const inviteTg = el("tg-invite");
  if (inviteTg) inviteTg.addEventListener("click", doTelegramInvite);

  const saveDhan = el("dhan-save");
  if (saveDhan) saveDhan.addEventListener("click", doSaveDhan);
  const testDhan = el("dhan-test");
  if (testDhan) testDhan.addEventListener("click", doTestDhan);

  const rotateBtn = el("rotate-login-btn");
  if (rotateBtn) rotateBtn.addEventListener("click", doRotateLoginNow);

  refreshConnection();
}

// ---------- login-notification email (credential rotation) ----------
async function loadAuthEmail() {
  const inp = el("auth-email");
  const status = el("auth-email-status");
  try {
    const d = await fetch("/api/auth/email").then((r) => r.json());
    if (inp && d.email) inp.placeholder = d.email + " (saved)";
    if (status) {
      status.textContent = d.configured
        ? (d.smtpConfigured ? "" : "Email saved, but the server has no SMTP env vars set (SMTP_HOST/SMTP_USER/SMTP_PASS) - rotations will still show in the server console.")
        : "";
      status.className = "conn-status" + (d.configured && !d.smtpConfigured ? " warn" : "");
    }
  } catch (_) { /* best-effort */ }
}
async function doSaveAuthEmail() {
  const inp = el("auth-email");
  const status = el("auth-email-status");
  const email = (inp?.value || "").trim();
  try {
    const r = await fetch("/api/auth/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).then((res) => res.json());
    if (!r.ok) { if (status) { status.textContent = r.error || "Could not save."; status.className = "conn-status err"; } return; }
    if (inp) inp.value = "";
    if (status) {
      status.textContent = email
        ? (r.smtpConfigured ? `Saved. Future rotations (08:00 IST) will be emailed to ${r.email}.` : `Saved, but the server has no SMTP env vars set - rotations will show in the console instead.`)
        : "Notification email removed.";
      status.className = "conn-status" + (email && !r.smtpConfigured ? " warn" : " ok");
    }
    loadAuthEmail();
  } catch (e) {
    if (status) { status.textContent = "Could not save: " + e.message; status.className = "conn-status err"; }
  }
}

// ---------- Telegram alerts (replaced the former WhatsApp channel) ----------
// Messaging layer only. The bot token is write-only from this form: the backend
// returns a masked value and never the real token.
function renderTelegramStatus(d) {
  const box = el("tg-conn-status");
  if (!box) return;
  const state = d.ready ? "CONNECTED" : d.configured ? "ERROR" : "DISCONNECTED";
  const cls = d.ready ? "ok" : d.configured ? "err" : "";
  const icon = d.ready ? "🟢" : d.configured ? "⚠️" : "🔴";
  const row = (k, v) => `<div class="cb-row"><span>${k}</span><b>${v == null || v === "" ? "—" : v}</b></div>`;
  const when = (ts) => (ts ? new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  box.className = `conn-badge-block ${cls}`;
  box.innerHTML =
    `<div class="cb-head">${icon} TELEGRAM ${state}</div>` +
    row("Bot", d.botUsername ? "@" + d.botUsername : (d.configured ? "configured" : "not configured")) +
    row("Group", d.groupTitle || (d.chatId ? "chat " + d.chatId : "not set")) +
    row("Bot token", d.botTokenMasked || "not set") +
    row("Last successful message", when(d.lastSuccessAt)) +
    row("Last error", d.lastError || "none");
}

async function loadTelegramStatus() {
  const status = el("tg-status");
  try {
    // Live probe (getMe + getChat) so Bot and Group are reported separately.
    const d = await fetch("/api/telegram/status/live").then((r) => r.json());
    renderTelegramStatus(d);
    if (status) {
      status.textContent = d.ready ? "" : (d.probeError || d.reason || "");
      status.className = "conn-status" + (d.ready ? " ok" : d.configured ? " warn" : "");
    }
  } catch (_) { /* best-effort */ }
}

async function doSaveTelegram() {
  const tokenInp = el("tg-token");
  const chatInp = el("tg-chatid");
  const status = el("tg-status");
  const botToken = (tokenInp?.value || "").trim();
  const chatId = (chatInp?.value || "").trim();
  if (!botToken && !chatId) {
    if (status) { status.textContent = "Enter a bot token and/or the group chat ID."; status.className = "conn-status err"; }
    return;
  }
  try {
    const r = await fetch("/api/telegram/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, botToken, chatId }),
    }).then((res) => res.json());
    if (!r.ok) { if (status) { status.textContent = "Could not save."; status.className = "conn-status err"; } return; }
    // SECURITY: never leave the token in the DOM after saving.
    if (tokenInp) tokenInp.value = "";
    if (chatInp) chatInp.value = "";
    if (status) {
      status.textContent = r.ready ? "Saved. Alerts and credential rotations will go to the Telegram group." : (r.reason || "Saved.");
      status.className = "conn-status" + (r.ready ? " ok" : " warn");
    }
    loadTelegramStatus();
  } catch (e) {
    if (status) { status.textContent = "Could not save: " + e.message; status.className = "conn-status err"; }
  }
}

async function doTestTelegram() {
  const status = el("tg-status");
  if (status) { status.textContent = "Sending test message…"; status.className = "conn-status"; }
  try {
    const r = await fetch("/api/telegram/test", { method: "POST" }).then((res) => res.json());
    if (status) {
      status.textContent = r.ok ? "Test message sent to the Telegram group." : (r.error || "Test failed.");
      status.className = "conn-status" + (r.ok ? " ok" : " err");
    }
    loadTelegramStatus();
  } catch (e) {
    if (status) { status.textContent = "Test failed: " + e.message; status.className = "conn-status err"; }
  }
}

// The Bot API cannot add a person to a group, so the correct flow is an invite
// link the person uses themselves.
async function doTelegramInvite() {
  const out = el("tg-invite-out");
  if (out) { out.textContent = "Creating invite link…"; out.className = "conn-status"; }
  try {
    const r = await fetch("/api/telegram/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).then((res) => res.json());
    if (!r.ok) { if (out) { out.textContent = r.error || "Could not create an invite link."; out.className = "conn-status err"; } return; }
    if (out) {
      out.innerHTML = `Send this link to the person — they join themselves:<br><code>${r.inviteLink}</code>`;
      out.className = "conn-status ok";
    }
  } catch (e) {
    if (out) { out.textContent = "Could not create an invite link: " + e.message; out.className = "conn-status err"; }
  }
}

// ---------- Dhan historical-data connection (backtesting only) ----------
async function loadDhanStatus() {
  const status = el("dhan-status");
  try {
    const d = await fetch("/api/dhan/status").then((r) => r.json());
    if (status) {
      status.textContent = d.configured ? "Token saved — press TEST CONNECTION to verify it's still valid (24h expiry)." : "";
      status.className = "conn-status";
    }
  } catch (_) { /* best-effort */ }
}
async function doSaveDhan() {
  const inp = el("dhan-token");
  const status = el("dhan-status");
  const accessToken = (inp?.value || "").trim();
  try {
    const r = await fetch("/api/dhan/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken }),
    }).then((res) => res.json());
    if (!r.ok) { if (status) { status.textContent = "Could not save."; status.className = "conn-status err"; } return; }
    if (inp) inp.value = "";
    if (status) { status.textContent = r.configured ? "Saved. Press TEST CONNECTION to verify." : "Token removed."; status.className = "conn-status" + (r.configured ? " ok" : ""); }
  } catch (e) {
    if (status) { status.textContent = "Could not save: " + e.message; status.className = "conn-status err"; }
  }
}
async function doTestDhan() {
  const status = el("dhan-status");
  if (status) { status.textContent = "Testing Dhan connection..."; status.className = "conn-status"; }
  try {
    const r = await fetch("/api/dhan/test", { method: "POST" }).then((res) => res.json());
    if (status) {
      status.textContent = r.ok ? "Connected — token is valid." : (r.error || "Test failed.");
      status.className = "conn-status" + (r.ok ? " ok" : " err");
    }
  } catch (e) {
    if (status) { status.textContent = "Test failed: " + e.message; status.className = "conn-status err"; }
  }
}

// Immediately rotate the dashboard login password (instead of waiting for the
// daily 08:00 IST schedule) and push it out via email/Telegram, whichever is
// configured (see POST /api/auth/rotate). Current session stays logged in —
// only the password for a FUTURE login changes.
async function doRotateLoginNow() {
  if (!confirm("Login password abhi rotate karein? Naya password turant email/Telegram par bhej diya jayega (jo bhi configured hai) — aap abhi logged-in rahenge.")) return;
  const btn = el("rotate-login-btn");
  if (btn) btn.disabled = true;
  try {
    const r = await fetch("/api/auth/rotate", { method: "POST" }).then((res) => res.json());
    if (!r.ok) { alert(r.error || "Rotation failed."); return; }
    const via = [r.emailed ? "email" : null, r.telegramSent ? "Telegram" : null].filter(Boolean).join(" + ");
    alert(via ? `Naya password bhej diya gaya (${via}).` : "Naya password ban gaya, par koi delivery channel (email/Telegram) configured nahi hai — server console check karein.");
  } catch (e) {
    alert("Rotation failed: " + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Delete the saved Dhan token, then prompt the user to generate a fresh one.
async function doForgetToken() {
  const status = el("conn-status");
  if (!confirm("Remove the saved Dhan access token? You'll need to paste a fresh token to reconnect.")) return;
  try {
    const r = await fetch("/api/groww/forget-token", { method: "POST" }).then((res) => res.json());
    if (status) {
      status.textContent = r.message || "Saved token removed. Paste a fresh access token to reconnect.";
      status.className = "conn-status warn";
    }
    const inp = el("conn-token"); if (inp) { inp.value = ""; inp.focus(); }
    renderConnStatus("gc-conn-status", "DHAN", "DISCONNECTED", { Connection: "Disconnected", Authentication: "None", "Data Status": "Not receiving" });
    loadDhanConfig();
  } catch (e) {
    if (status) { status.textContent = "Could not remove token: " + e.message; status.className = "conn-status err"; }
  }
}

function startDhanPoll() {
  stopDhanPoll();
  _dhanPollTimer = setInterval(loadDhanConfig, 5000);
}
function stopDhanPoll() {
  if (_dhanPollTimer) { clearInterval(_dhanPollTimer); _dhanPollTimer = null; }
}

// ---------- compliance: consent + disclosures + auto-trade acknowledgement ----------
const CMP_ACK_KEY = "nsa_disclosure_ack";
let _cmpMeta = { appVersion: "0.0.0", disclosureVersion: "0", ruleVersion: "" };

function setupCompliance() {
  // Version metadata from the server.
  fetch("/api/compliance/meta").then((r) => r.json()).then((m) => {
    _cmpMeta = m || _cmpMeta;
    maybeShowConsent();
  }).catch(() => { maybeShowConsent(); });

  // First-use consent modal (login screen SEBI disclosure).
  const chk = el("consent-check");
  const cont = el("consent-continue");
  if (chk && cont) chk.addEventListener("change", () => { cont.disabled = !chk.checked; });
  if (cont) cont.addEventListener("click", () => {
    try {
      localStorage.setItem(CMP_ACK_KEY, JSON.stringify({
        acknowledgedAt: new Date().toISOString(),
        appVersion: _cmpMeta.appVersion,
        disclosureVersion: _cmpMeta.disclosureVersion,
      }));
    } catch (_) {}
    el("consent-modal").classList.add("hidden");
  });

  // Auto-trade acknowledgement modal.
  const atChk = el("autotrade-check");
  const atEnable = el("autotrade-enable");
  if (atChk && atEnable) atChk.addEventListener("change", () => { atEnable.disabled = !atChk.checked; });
  if (atEnable) atEnable.addEventListener("click", async () => {
    el("autotrade-modal").classList.add("hidden");
    await doEnableAuto();
  });
  if (el("autotrade-close")) el("autotrade-close").addEventListener("click", () => el("autotrade-modal").classList.add("hidden"));

  // Emergency stop — immediately blocks new automated (simulated) orders.
  if (el("emergency-stop")) el("emergency-stop").addEventListener("click", emergencyStop);
}

function maybeShowConsent() {
  let ack = null;
  try { ack = JSON.parse(localStorage.getItem(CMP_ACK_KEY) || "null"); } catch (_) {}
  const current = _cmpMeta.disclosureVersion;
  // Show if never acknowledged OR the disclosure version changed.
  if (!ack || ack.disclosureVersion !== current) {
    const chk = el("consent-check"); const cont = el("consent-continue");
    if (chk) chk.checked = false;
    if (cont) cont.disabled = true;
    el("consent-modal").classList.remove("hidden");
  }
}

// Gate the auto-trade button: turning ON requires explicit acknowledgement; turning
// OFF is immediate (no gate).
function paperAutoGate() {
  const goingOn = !(state.paperState && state.paperState.active);
  if (goingOn) {
    const chk = el("autotrade-check"); const en = el("autotrade-enable");
    if (chk) chk.checked = false;
    if (en) en.disabled = true;
    el("autotrade-modal").classList.remove("hidden");
  } else {
    paperToggleAuto();
  }
}

async function doEnableAuto() {
  const btn = el("pp-auto");
  if (btn) btn.disabled = true;
  try { await fetch("/api/paper/auto?on=true").then((r) => r.json()); await loadPaper(); }
  finally { if (btn) btn.disabled = false; }
}

async function emergencyStop() {
  const b = el("emergency-stop");
  if (b) { b.disabled = true; b.textContent = "STOPPING…"; }
  try {
    await fetch("/api/paper/auto?on=false").then((r) => r.json());
    await loadPaper();
  } catch (_) {}
  finally { if (b) { b.disabled = false; b.textContent = "■ STOP TRADING"; } }
}

function paintFeedToggles(d) {
  const g = el("feed-dhan");
  if (!d || !g) return;
  const gon = d.dhanOn !== false;
  g.textContent = "Dhan · single source · " + (gon ? "ON" : "OFF");
  g.className = "pill-btn feed-tog " + (gon ? "on" : "off");
  g.title = (d.reason || "") + (d.hasDhanToken === false ? "\nDhan token missing — Connect data." : "\nDhan is the only market-data source.");
}
function setupFeedToggles() {
  const g = el("feed-dhan");
  const send = async (body) => {
    const r = await fetch("/api/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json());
    if (!r.ok) {
      const st = el("conn-status");
      if (st) { st.textContent = r.error || "feed switch failed"; st.className = "conn-status err"; }
      el("connect-panel")?.classList.remove("hidden");
      return;
    }
    paintFeedToggles(r);
    setProviderBadge(r.provider);
    updateDataStatus();
  };
  if (g) g.addEventListener("click", async () => {
    const cur = await fetch("/api/connection").then((r) => r.json());
    send({ dhan: !cur.dhanOn });
  });
}

function setProviderBadge(name) {
  if (el("provider-badge")) el("provider-badge").textContent = "provider: " + name;
  const cur = el("conn-current");
  if (cur) cur.textContent = name;
}

async function refreshConnection() {
  try {
    const c = await fetch("/api/connection").then((r) => r.json());
    setProviderBadge(c.provider);
    paintFeedToggles(c);
  } catch (_) {}
}

// ---------- reusable connection-status component ----------
// One renderer for every provider (Dhan is the single source).
// States: CONNECTED / CHECKING / DISCONNECTED / ERROR.
const CONN_STATE_UI = {
  CONNECTED:    { dot: "🟢", label: "CONNECTED", cls: "ok" },
  CHECKING:     { dot: "🟡", label: "CHECKING",  cls: "warn" },
  DISCONNECTED: { dot: "🔴", label: "DISCONNECTED", cls: "err" },
  ERROR:        { dot: "⚠️", label: "ERROR", cls: "err" },
};
// `info` rows are label/value pairs, e.g. { Authentication: "Valid" }.
function renderConnStatus(targetId, provider, state, info) {
  const box = el(targetId);
  if (!box) return;
  const s = CONN_STATE_UI[state] || CONN_STATE_UI.DISCONNECTED;
  const rows = Object.entries(info || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<div class="cb-row"><span>${k}</span><b>${v}</b></div>`)
    .join("");
  box.className = `conn-badge-block ${s.cls}`;
  box.innerHTML = `<div class="cb-head">${s.dot} ${provider} ${s.label}</div>${rows}`;
}
const fmtCheckTime = (ts) => (ts ? new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");

// SAVE ACCESS TOKEN — the access token is the only Dhan credential. The server
// accepts it only after a real authenticated Dhan request returns data, so a
// non-empty field alone never shows CONNECTED.
async function doSaveConnect() {
  const status = el("conn-status");
  const btn = el("conn-saveconnect");
  const tokenInput = el("conn-token");
  const token = (tokenInput?.value || "").trim();

  if (!token) {
    status.textContent = "Paste your Dhan access token first.";
    status.className = "conn-status err";
    return;
  }

  status.textContent = "Validating token with Dhan (a few seconds)…";
  status.className = "conn-status";
  renderConnStatus("gc-conn-status", "DHAN", "CHECKING", { Connection: "Checking…" });
  btn.disabled = true;
  try {
    const r = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((res) => res.json());
    if (r.ok) {
      status.textContent = r.message || "Connected — market data received.";
      status.className = "conn-status ok";
      renderConnStatus("gc-conn-status", "DHAN", "CONNECTED", {
        Connection: "Connected", Authentication: "Valid", "Data Status": "Receiving",
        "Last Successful Check": fmtCheckTime(Date.now()),
      });
      setProviderBadge(r.provider || "dhan");
      // SECURITY: never leave the credential sitting in the DOM after saving.
      if (tokenInput) tokenInput.value = "";
      loadDhanConfig();
      loadAlerts();
      if (state.active) loadSymbol(state.active);
    } else {
      status.textContent = r.error || "Dhan connection failed.";
      status.className = "conn-status err";
      renderConnStatus("gc-conn-status", "DHAN", r.code === "NETWORK_ERROR" || r.code === "API_UNAVAILABLE" || r.code === "RATE_LIMIT" ? "ERROR" : "DISCONNECTED", {
        Connection: "Failed", Authentication: r.code === "INVALID_TOKEN" || r.code === "AUTH_FAILED" ? "Invalid" : "Unknown",
        Reason: r.error || "—",
      });
      setProviderBadge(r.provider || "dhan");
      loadDhanConfig();
      // Dhan rate-limits requests — cool the button down so repeated clicks
      // don't make it worse.
      if (r.rateLimited) { dhanCooldown(btn, 90); return; }
    }
  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.className = "conn-status err";
    renderConnStatus("gc-conn-status", "DHAN", "ERROR", { Connection: "Failed", Reason: e.message });
  } finally {
    if (!btn.dataset.cooldown) btn.disabled = false;
  }
}

// Disable a button for N seconds with a live countdown (used after a Dhan rate-limit).
function dhanCooldown(btn, secs) {
  if (!btn) return;
  const label = btn.textContent;
  btn.dataset.cooldown = "1";
  btn.disabled = true;
  let left = secs;
  const tick = () => {
    btn.textContent = `Wait ${left}s (Dhan rate-limit)`;
    if (left <= 0) {
      clearInterval(t); delete btn.dataset.cooldown; btn.disabled = false; btn.textContent = label;
    }
    left--;
  };
  tick();
  const t = setInterval(tick, 1000);
}

// Back-compat shim: some callers still invoke doConnect(token) directly.
async function doConnect(token) {
  el("conn-token").value = token || "";
  return doSaveConnect();
}

// TEST DHAN CONNECTION — the server makes a real authenticated Dhan request;
// we only show 🟢 Dhan Connected when actual market data came back.
async function doTestConnection() {
  const box = el("gc-test-result");
  const btn = el("conn-test");
  box.innerHTML = "<div class='gc-tr-line'>Testing…</div>";
  renderConnStatus("gc-conn-status", "DHAN", "CHECKING", { Connection: "Checking…" });
  btn.disabled = true;
  try {
    const r = await fetch("/api/groww/test").then((res) => res.json());
    const c = r.checks || {};
    const m = r.messages || {};
    const line = (ok, label, msg) =>
      `<div class="gc-tr-line ${ok ? "ok" : "err"}">${ok ? "✓" : "✗"} ${label}${msg ? " — " + msg : ""}</div>`;
    const head = r.ok
      ? `<div class="gc-tr-head ok">🟢 Dhan Connected</div>`
      : `<div class="gc-tr-head err">🔴 Dhan Connection Failed</div>`;
    box.innerHTML = head +
      line(c.auth, "Authentication", m.auth) +
      line(c.api, "Dhan API reachable", m.api) +
      line(c.data, "Market data received", m.data) +
      line(c.optionChain, "Option chain / OI reachable", m.optionChain) +
      line(c.freshness, "Data freshness", m.freshness);

    if (r.ok) {
      renderConnStatus("gc-conn-status", "DHAN", "CONNECTED", {
        Connection: "Connected",
        Authentication: "Valid",
        "Data Status": "Receiving",
        "Last Successful Check": fmtCheckTime(r.lastSuccessfulCheck),
      });
    } else {
      const errorish = r.code === "NETWORK_ERROR" || r.code === "API_UNAVAILABLE" || r.code === "RATE_LIMIT";
      renderConnStatus("gc-conn-status", "DHAN", errorish ? "ERROR" : "DISCONNECTED", {
        Connection: "Failed",
        Authentication: r.authentication === "VALID" ? "Valid" : r.authentication === "INVALID" ? "Invalid" : "Unknown",
        "Data Status": "Not receiving",
        Reason: r.error || "—",
        "Last Successful Check": fmtCheckTime(r.lastSuccessfulCheck),
      });
    }
    loadDhanConfig();
  } catch (e) {
    box.innerHTML = `<div class="gc-tr-head err">🔴 Dhan Connection Failed</div><div class="gc-tr-line err">✗ ${e.message}</div>`;
    renderConnStatus("gc-conn-status", "DHAN", "ERROR", { Connection: "Failed", Reason: e.message });
  } finally {
    btn.disabled = false;
  }
}

// Render the connection status + health block from the secure config endpoint.
async function loadDhanConfig() {
  try {
    const d = await fetch("/api/groww/config").then((res) => res.json());
    // Masked saved token + UPDATE TOKEN control.
    const wrap = el("gc-token-current");
    if (d.configured && d.tokenMasked) {
      el("gc-token-mask").textContent = d.tokenMasked;
      wrap.classList.remove("hidden");
    } else {
      wrap.classList.add("hidden");
    }
    // Shared connection-status component, driven by the last real probe.
    renderConnStatus("gc-conn-status", "DHAN",
      d.connection === "CONNECTED" ? "CONNECTED" : d.connection === "ERROR" ? "ERROR" : "DISCONNECTED", {
        Connection: d.connection === "CONNECTED" ? "Connected" : d.connection === "ERROR" ? "Error" : "Disconnected",
        Authentication: d.authentication === "VALID" ? "Valid" : d.authentication === "INVALID" ? "Invalid" : d.authentication === "NONE" ? "No token saved" : "Not tested yet",
        "Data Status": d.dataStatus === "RECEIVING" ? "Receiving" : d.dataStatus === "DELAYED" ? "Delayed" : d.dataStatus === "MARKET CLOSED" ? "Market closed" : "Not receiving",
        "Last Successful Check": fmtCheckTime(d.lastSuccessfulCheck),
      });
    // Status header + health.
    const map = {
      GREEN:  { dot: "🟢", head: "DHAN CONNECTED", data: "LIVE" },
      YELLOW: { dot: "🟡", head: "DHAN CONNECTED", data: "DELAYED" },
      CLOSED: { dot: "🟡", head: "DHAN CONNECTED", data: "MARKET CLOSED" },
      RED:    { dot: "🔴", head: "DHAN DISCONNECTED", data: "—" },
      GREY:   { dot: "⚪", head: "DHAN NOT CONFIGURED", data: "—" },
    };
    const s = map[d.status] || map.GREY;
    const h = d.health || {};
    const rows = [];
    rows.push(`<div class="gc-st-head ${d.status}">${s.dot} ${s.head}</div>`);
    if (d.status !== "GREY") {
      rows.push(`<div class="gc-st-row"><span>Market Data</span><b>${s.data}</b></div>`);
      rows.push(`<div class="gc-st-row"><span>Provider</span><b>DHAN</b></div>`);
      if (h.lastUpdate) rows.push(`<div class="gc-st-row"><span>Last Update</span><b>${h.lastUpdate}</b></div>`);
      if (h.dataAgeSec != null) rows.push(`<div class="gc-st-row"><span>Data Age</span><b>${h.dataAgeSec.toFixed(1)} sec</b></div>`);
      if (h.latencyMs != null) rows.push(`<div class="gc-st-row"><span>API Latency</span><b>${h.latencyMs} ms</b></div>`);
      rows.push(`<div class="gc-st-row"><span>Updates</span><b>${(h.updates || 0).toLocaleString()}</b></div>`);
      rows.push(`<div class="gc-st-row"><span>Failures</span><b>${h.failures || 0}</b></div>`);
      rows.push(`<div class="gc-st-row"><span>Reconnects</span><b>${h.reconnects || 0}</b></div>`);
    } else if (d.reason) {
      rows.push(`<div class="gc-st-row"><span>${d.reason}</span></div>`);
    }
    el("gc-status").innerHTML = rows.join("");
    // Live-signals gate.
    const sig = el("gc-signals");
    if (d.signalsBlocked) { sig.textContent = "🔴 LIVE TRADING SIGNALS BLOCKED"; sig.className = "gc-signals blocked"; }
    else { sig.textContent = "🟢 LIVE SIGNALS ENABLED"; sig.className = "gc-signals ok"; }
  } catch (_) {}
}

// ---------- tabs ----------
function setupTabs() {
  document.querySelectorAll("#tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
  });
  if (el("stock-back")) el("stock-back").addEventListener("click", () => switchTab(state.prevTab || "toppicks"));
  const ft = el("tab-flow-toggle");
  if (ft) {
    ft.addEventListener("click", () => {
      const box = el("tab-flow");
      if (!box) return;
      const show = box.hasAttribute("hidden");
      if (show) box.removeAttribute("hidden"); else box.setAttribute("hidden", "");
      ft.textContent = "🔍 How this tab works — logic flow " + (show ? "▴" : "▾");
    });
  }
  // Prime the flow for the default (active) tab.
  const active = document.querySelector("#tabs .tab.active");
  renderTabFlow(active ? active.getAttribute("data-tab") : "oicommand");

  // Market News: force-refresh button.
  const nr = el("news-refresh");
  if (nr) nr.addEventListener("click", () => loadNews(true));

  // Bull % Rank: refresh + window change.
  if (el("load-bullrank")) el("load-bullrank").addEventListener("click", loadBullRank);
  if (el("br-days")) el("br-days").addEventListener("change", loadBullRank);


  // Early-Move alert: always-on header indicator + flashing toast when a move ignites.
  const eind = el("early-ind");
  if (eind) eind.addEventListener("click", () => { const t = state.early && state.early.top; if (t) openStock(t.symbol); });
  startEarlyMoveAlerts();
  if (el("load-earlymoves")) el("load-earlymoves").addEventListener("click", loadEarlyMoves);
  if (el("em-filter")) el("em-filter").addEventListener("change", () => state.earlyMovesData && renderEarlyMoves());

  // Best-option-plays banner minimize/expand (persisted).
  const oppMin = el("opp-min");
  const oppBar = el("opp-bar");
  if (oppMin && oppBar) {
    if (localStorage.getItem("oppCollapsed") !== "0") { oppBar.classList.add("collapsed"); oppMin.textContent = "+"; } // collapsed by default (expand with +)
    oppMin.addEventListener("click", () => {
      const c = oppBar.classList.toggle("collapsed");
      oppMin.textContent = c ? "+" : "–";
      localStorage.setItem("oppCollapsed", c ? "1" : "0");
    });
  }

  // Paper sub-tabs: Directional | Scalp (re-render the cached state on toggle).
  document.querySelectorAll("#paper-subtabs .sub-tab").forEach((b) => {
    b.addEventListener("click", () => {
      state.paperSubTab = b.getAttribute("data-ptab");
      document.querySelectorAll("#paper-subtabs .sub-tab").forEach((x) => x.classList.toggle("active", x === b));
      if (state.paperState) renderPaper(state.paperState);
    });
  });
}

// ---------- per-tab analysis flowcharts (review the logic of each tab) ----------
// Step types: in=input/data, proc=processing, gate=filter/gate, out=output, note.
const TAB_FLOW = {
  oicommand: { title: "Trader Dashboard — Monday test: OI vs VWAP / GainzAlgo v2 / 4-Layer", steps: [
    { t: "in", text: "Dhan option chain (~90s) + VWAP/ADX from 15m + 4-Layer (no RSI/MACD) + GainzAlgo v2 (high-prob buy filter) + last 5m bar + futures buildup" },
    { t: "proc", text: "Correlate each model vs OI direction: AGREE / AGAINST / FLAT. Consensus AGREE needs ≥2 agrees and 0 against." },
    { t: "proc", text: "Sentiment/Liquidity/Risk pipeline: regime → liquidity → sentiment → premium → wall-reaction → trade-score → dedup → display threshold." },
    { t: "gate", text: "premium DECAY = hard veto (overrides all); setupQuality<30 = traded+logged but hidden; dedup blocks a repeat until exit or an ATR move-and-return." },
    { t: "gate", text: "Monday open: wait for OI baseline, chain not stale, then TAKE only if rec + consensus is not CONFLICT" },
    { t: "out", text: "Every GO/WAIT flip + module state change + trade emit/veto/dedup lands in the unified Decision Log (🧾 drawer / dock)." },
  ]},
  news: { title: "Market News — India-focused headlines (informational)", steps: [
    { t: "in", text: "Public RSS feeds: Economic Times Markets · Moneycontrol · Business Standard · LiveMint (fetched server-side, cached 5 min)" },
    { t: "proc", text: "Parse each item → title · source · publish time · link (CDATA + HTML entities decoded)" },
    { t: "proc", text: "Tag SENTIMENT by keyword (positive/negative/neutral) and IMPACT (RBI · Fed · inflation · results · crude · FII · IPO…)" },
    { t: "gate", text: "Dedupe by title · sort newest-first · keep top 40" },
    { t: "out", text: "→ News bias summary (Bullish/Bearish/Neutral) + headline list. INFORMATIONAL only — NOT wired into the trade engine (headline sentiment is noisy and lags price)." },
  ]},
  oichange: { title: "OI Change — best strike + build-up vs movement, auto 3-min", steps: [
    { t: "in", text: "Live option chain per index / F&O stock + a per-strike BASELINE (OI) captured on the day's first reading" },
    { t: "proc", text: "Picks the BEST strike = where OI action (|ΔCE|+|ΔPE|) is most concentrated near the money; shows Call & Put ΔOI, % and volume at that ONE strike" },
    { t: "proc", text: "Scans ALL strikes for the biggest writing: max CE = resistance, max PE = support (⚡ flagged when VERY HIGH)" },
    { t: "proc", text: "Reads the build-up vs the current SPOT movement: Spot UP + PE support = move supported; Spot DOWN + CE resistance = move capped" },
    { t: "out", text: "One line per symbol: best strike, spot Δ, resistance/support build-up, and a plain read. ⚡ MAJOR highlight; auto-refresh every 3 min." },
    { t: "note", text: "OI change is INTRADAY vs the day's first reading. Volume shows only if the feed provides it. One input — read alongside price." },
  ]},
  bullrank: { title: "Bull % Rank — historical upward bias", steps: [
    { t: "in", text: "Daily candles per stock over the chosen window (60 / 120 / 250 days)" },
    { t: "proc", text: "Count UP days (close > previous close) vs DOWN days → Bull % = up / (up+down)" },
    { t: "proc", text: "Also: recent 20-day bull %, window return, avg up/down day size, current up/down streak" },
    { t: "out", text: "Stocks ranked by Bull % with a bias tag (Strong Bull → Strong Bear). Click a row to open the stock." },
    { t: "note", text: "This is a HISTORICAL TENDENCY, not a prediction — a stock's regime can change. High bull % = better CE candidate; low = better PE candidate." },
  ]},
  paper: { title: "AI Paper Desk — Directional + Scalp, win-win anytime", steps: [
    { t: "in", text: "LIVE market data: Index 5m/15m/1h · Option chain OI · Trader Dashboard bulletin" },
    { t: "proc", text: "DIRECTIONAL: OI TAKE + 1h bulletin same side. No 4-layer opposite-side fallback." },
    { t: "proc", text: "SCALP: 5m+15m bulletin agree, or burst firing with 5m signal. No fade/anticipation-against-signal." },
    { t: "gate", text: "No clock windows (9:20/lunch/3pm removed). No daily trade-count cap. NSE session only (realistic fills). EOD flatten ~15:25." },
    { t: "gate", text: "Win-win: net-of-cost R:R · calibrated win-prob ≥52% dir / ≥54% scalp (capped ~62%, never 90% marketing) · heat ≤6% · daily loss −3%" },
    { t: "proc", text: "Exits: target/stop · trail · decay · bulletin reversal · EOD. Honest P&L after brokerage+slippage." },
    { t: "out", text: "Paper DB: live P&L, measured win rate. Zero-loss is not guaranteed — only positive-expectancy setups are taken." },
  ]},
  openingplay: { title: "Opening Play 9:20 — OPHL Option Buying System", steps: [
    { t: "in", text: "PDH / PDL / PDC, today's open, gap%, VWAP, EMA9/21, OI + overnight OI shift, ATM premium samples" },
    { t: "proc", text: "Direction from open vs PDH/PDL (fallback: live breakout of the level + buffer)" },
    { t: "proc", text: "MARKET score (40%): open vs level · break+buffer · new high/low · price vs VWAP · EMA9/21 · OI structure" },
    { t: "proc", text: "OPTION score (60%): ATM premium breaks its session high · above session avg · OI confirm · premium momentum" },
    { t: "gate", text: "Final = market×0.4 + option×0.6 → band: NO TRADE / WATCH / WEAK / GOOD / STRONG" },
    { t: "gate", text: "Entry only if score ≥ 75 AND index break + option break + VWAP align all true" },
    { t: "out", text: "Best index CE/PE + entry checklist + risk plan (25% stop, T1/T2/T3 = 1R/2R/3R)" },
    { t: "note", text: "Option-breakout arms after a few live premium samples. Option data is delta-limited, not exact." },
  ]},
  toppicks: { title: "Top Pick — leftover opportunity, one screen", steps: [
    { t: "in", text: "F&O stocks + indices · 5m / 15m / 1h / 1d candles · live OI strike" },
    { t: "proc", text: "Rank leftover room (fresh run + remaining ATR), not strength after the move already happened" },
    { t: "gate", text: "EXTENDED / Range / 82%+ of day-range used sink to LATE — do not chase. Against-5m = WAIT" },
    { t: "out", text: "Stocks and Indices same board: GO / WAIT / LATE cards. Giant CE/PE + leftover %. Tap for detail." },
  ]},
  todaymovers: { title: "Today Big Movers — who's in play now", steps: [
    { t: "in", text: "All stocks, live intraday (gap, volume, range, 15m momentum) + F&O (option/OI) availability" },
    { t: "proc", text: "Mover score = opening gap + relative volume + range expansion vs typical + 15m momentum" },
    { t: "proc", text: "Opening-High score = gap-UP + good volume + holding near the day high" },
    { t: "out", text: "🚀 Top 5 Opening-High movers first (F&O/OI names prioritized, cash-only shown & badged), then the full ranked mover table (filter by direction / options)" },
  ]},
  stock: { title: "Selected Stock — full single-symbol analysis + 4-Layer Direction", steps: [
    { t: "in", text: "Chosen symbol candles (selected timeframe) + option chain (if F&O)" },
    { t: "proc", text: "4-Layer Direction Engine → weighted direction + 0–100 confidence:" },
    { t: "proc", text: "  L1 Market Structure 40%: PDH/PDL · opening range · HH-HL / LH-LL · day-range position" },
    { t: "proc", text: "  L2 Trend 25%: EMA 9/21 · Supertrend · VWAP" },
    { t: "gate", text: "  L3 Derivatives 20%: OI bias · OI-change buildup · futures buildup · IV skew" },
    { t: "proc", text: "  L4 Momentum 15%: RSI · MACD · Bollinger · Volume" },
    { t: "proc", text: "Also: legacy signal engine, OI levels (support/resistance/max-pain), option suggestion, Trade Minder" },
    { t: "out", text: "Final = ΣL(layerScore×weight) → direction + confidence, chart, suggested trade with stop/target" },
    { t: "note", text: "Futures basis + option volume aren't on this feed, so Layer 3 uses the available derivatives sub-signals." },
  ]},
  bigmove: { title: "Big Move 20–100% — large multi-week candidates", steps: [
    { t: "in", text: "Daily candles, long history" },
    { t: "proc", text: "Base structure + volatility contraction + volume expansion → big-move setup score" },
    { t: "out", text: "Stocks positioned for a large multi-day/week move (positional, not intraday)" },
  ]},
  movetiming: { title: "Move Timing — when the symbol moves most", steps: [
    { t: "in", text: "~45 days of 15m history, 09:30–15:00 window" },
    { t: "proc", text: "Per time-of-day range% + how the most-active window shifts weekly/monthly" },
    { t: "out", text: "The time-of-day when volatility clusters (descriptive, not a prediction)" },
  ]},
};

function renderTabFlow(name) {
  const box = el("tab-flow");
  if (!box) return;
  const flow = TAB_FLOW[name];
  if (!flow) { box.innerHTML = '<div class="wl-sub" style="padding:8px">No flow chart for this tab yet.</div>'; return; }
  const icon = { in: "📥", proc: "⚙️", gate: "🚦", out: "🎯", note: "ℹ️" };
  const steps = flow.steps.map((s, i) => `
    ${i > 0 ? '<div class="flow-arrow">↓</div>' : ""}
    <div class="flow-step flow-${s.t}"><span class="flow-ic">${icon[s.t] || "•"}</span><span>${s.text}</span></div>`).join("");
  box.innerHTML = `<div class="flow-title">${flow.title}</div>${steps}
    <div class="flow-legend"><span class="flow-lg flow-in">📥 input</span><span class="flow-lg flow-proc">⚙️ process</span><span class="flow-lg flow-gate">🚦 gate</span><span class="flow-lg flow-out">🎯 output</span></div>`;
}

// Preserve scroll position across a live-polled panel's re-render and flash a
// brief "just updated" pulse, instead of the previous plain innerHTML replace
// on every poll - which reset scroll position and any expanded row on every
// tick and read as "nothing is really live" even though data was refreshing
// underneath. Used by the Trader Dashboard / Paper Desk / Top Picks live pollers.
function renderLive(containerId, renderFn) {
  const box = el(containerId);
  const scrollTop = box ? box.scrollTop : 0;
  renderFn();
  const box2 = el(containerId);
  if (!box2) return;
  box2.scrollTop = scrollTop;
  box2.classList.remove("just-updated");
  void box2.offsetWidth; // restart the CSS animation on every call
  box2.classList.add("just-updated");
}

// ---------- persistent index strip (Option Trading mode) ----------
// A slim, always-visible NIFTY/BANKNIFTY glance so index levels are readable
// while browsing Paper Desk / Top Pick without switching to Trader Dashboard.
// Reads from the same cached quote pipeline Trader Dashboard's own spot price
// comes from, so the numbers shown here and there are provably in sync rather
// than two independently-fetched copies that could drift apart.
const INDEX_STRIP_SYMBOLS = [
  { symbol: "^NSEI", label: "NIFTY" },
  { symbol: "^NSEBANK", label: "BANKNIFTY" },
];
let indexStripTimer = null;
async function refreshIndexStrip() {
  const box = el("index-strip");
  if (!box || !document.body.classList.contains("mode-option")) return;
  try {
    const quotes = await Promise.all(
      INDEX_STRIP_SYMBOLS.map((s) => fetch(`/api/quote/${encodeURIComponent(s.symbol)}`).then((r) => r.json()).catch(() => null))
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const items = INDEX_STRIP_SYMBOLS.map((s, i) => {
      const q = quotes[i];
      if (!q || q.price == null || q.error) return `<span class="is-item"><b>${s.label}</b> <span class="wl-sub">—</span></span>`;
      const chg = q.changePercent;
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      return `<span class="is-item"><b>${s.label}</b> ${fmt(q.price)} <span class="is-chg ${cls}">${chg >= 0 ? "+" : ""}${fmt(chg)}%</span></span>`;
    }).join("");
    const tickAges = INDEX_STRIP_SYMBOLS.map((_, i) => {
      const t = quotes[i] && quotes[i].marketTime;
      return t && t > 0 ? nowSec - t : null;
    });
    const stripLive = isMarketOpen() && tickAges.some((a) => a != null && a <= 90);
    box.innerHTML = items + `<span class="is-item wl-sub">${stripLive ? '<span class="live-dot"></span> live' : isMarketOpen() ? "delayed" : "market closed"}</span>`;
  } catch (_) { /* ignore transient */ }
}
function startIndexStrip() {
  if (indexStripTimer) return;
  refreshIndexStrip();
  indexStripTimer = setInterval(refreshIndexStrip, 5000);
}

function switchTab(name) {
  // Remember where we came from so "Selected Stock" has a working Back button.
  const curActive = document.querySelector("#tabs .tab.active");
  const curName = curActive ? curActive.getAttribute("data-tab") : null;
  if (name === "stock" && curName && curName !== "stock") state.prevTab = curName;
  document.querySelectorAll("#tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.getAttribute("data-tab") === name)
  );
  renderTabFlow(name);
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === "panel-" + name)
  );
  if (name === "stock") { resizeCharts(); startStockLive(); }
  if (name === "swing" && !state.swingLoaded) { state.swingLoaded = true; loadSwing(); }

  if (name === "frequent" && !state.frequentLoaded) { state.frequentLoaded = true; loadFrequent(); }



  if (name === "monthly" && !state.monthlyLoaded) { state.monthlyLoaded = true; loadMonthly(); }
  if (name === "bigmove" && !state.bigmoveLoaded) { state.bigmoveLoaded = true; loadBigMove(); }
  if (name === "todaymovers" && !state.todayMoversLoaded) { state.todayMoversLoaded = true; loadTodayMovers(); }

  if (name === "toppicks" && !state.topPicksLoaded) { state.topPicksLoaded = true; loadTopPicks(); }
  if (name === "liquiditystatus") { if (!state.liquidityStatusLoaded) { state.liquidityStatusLoaded = true; loadLiquidityStatusScreen(); } startLiquidityStatusLive(); }
  if (name === "marketcommand") { initMarketCommand(); startMarketCommandLive(); }
  if (name === "bullrank" && !state.bullRankLoaded) { state.bullRankLoaded = true; loadBullRank(); }
  if (name === "stockoptions" && !state.stockOptionsInit) { state.stockOptionsInit = true; initStockOptions(); }

  if (name === "movetiming" && !state.moveTimingInit) { state.moveTimingInit = true; initMoveTiming(); }
  if (name === "dhanbacktest" && !state.dhanBacktestInit) { state.dhanBacktestInit = true; initDhanBacktest(); }
  document.body.classList.toggle("oi-focus", name === "oicommand");
  renderWatchlist();
  if (name === "oicommand") { initOiCommand(); startOiCommandLive(); startAdvisoryTracking(); loadAdvisoryAccuracy(15); }
  if (name === "earlymoves") { loadEarlyMoves(); startEarlyMovesTab(); }
  if (name === "tradermind") { initTraderMindTab(); startTraderMindLive(); }
  if (name === "strategylab") initStrategyLab();
  if (name === "stratreplay") initStrategyReplay();

  if (name === "paper") { loadPaper(); startPaperLive(); }
  if (name === "news") loadNews();
  if (name === "aipdash") loadAiPaperScreen("dashboard", "aipdash-body", "aipdash-note");
  if (name === "aipanalysis") loadAiPaperScreen("analysis", "aipanalysis-body", "aipanalysis-note");
  if (name === "aipsignals") loadAiPaperScreen("signals", "aipsignals-body", "aipsignals-note");
  if (name === "aipreview") loadAiPaperScreen("review", "aipreview-body", "aipreview-note");
  if (name === "aipperf") loadAiPaperScreen("performance", "aipperf-body", "aipperf-note");
  if (name === "aipvalid") loadAiPaperScreen("validation", "aipvalid-body", "aipvalid-note");
  syncMobileNav(name);
}

// ---------- mobile bottom navigation ----------
// Reuses the existing tabs + switchTab; adds a watchlist overlay and a "More" sheet
// (the full tab list) so every tab remains reachable on a phone. Mobile-only via CSS.
// Per-desk mobile bottom-nav layouts (4 quick tabs + Watchlist + More is too many;
// we use 3 mode tabs + Watchlist + More so the watchlist stays reachable on phones).
const MODE_NAV = {
  marketcommand: [
    { nav: "marketcommand", ico: "⚡", lbl: "Command" },
    { nav: "watchlist", ico: "📋", lbl: "List" },
    { nav: "more", ico: "☰", lbl: "More" },
  ],
  option: [
    { nav: "oicommand", ico: "🎯", lbl: "Dashboard" },
    { nav: "paper", ico: "🧪", lbl: "Paper" },
    { nav: "liquiditystatus", ico: "🌊", lbl: "Liquidity" },
    { nav: "watchlist", ico: "📋", lbl: "List" },
    { nav: "more", ico: "☰", lbl: "More" },
  ],
  stockOption: [
    { nav: "toppicks", ico: "📈", lbl: "Top Pick" },
    { nav: "earlymoves", ico: "⚡", lbl: "Early" },
    { nav: "stockoptions", ico: "📊", lbl: "Stk Opt" },
    { nav: "watchlist", ico: "📋", lbl: "List" },
    { nav: "more", ico: "☰", lbl: "More" },
  ],
  swing: [
    { nav: "news", ico: "📰", lbl: "News" },
    { nav: "todaymovers", ico: "🚀", lbl: "Movers" },
    { nav: "stock", ico: "📉", lbl: "Stock" },
    { nav: "watchlist", ico: "📋", lbl: "List" },
    { nav: "more", ico: "☰", lbl: "More" },
  ],
  aipaper: [
    { nav: "aipdash", ico: "🤖", lbl: "Home" },
    { nav: "aipsignals", ico: "📡", lbl: "Signals" },
    { nav: "paper", ico: "🧪", lbl: "Paper" },
    { nav: "aipperf", ico: "📊", lbl: "Perf" },
    { nav: "more", ico: "☰", lbl: "More" },
  ],
};

function renderMobileNav(mode) {
  const nav = el("mobile-nav");
  if (!nav) return;
  // Drop nav items for screens this user isn't permitted to see (AI Paper Desk
  // per-screen gating) - "watchlist"/"more" are not screens so always pass.
  const items = (MODE_NAV[mode] || MODE_NAV.option).filter((i) => screenPermitted(i.nav));
  nav.innerHTML = items
    .map((i) => `<button type="button" data-nav="${i.nav}"><span class="mn-ico">${i.ico}</span>${i.lbl}</button>`)
    .join("");
}

function setupMobileNav() {
  const body = document.body;
  // Event delegation so the nav can be re-rendered per desk without re-wiring.
  const nav = el("mobile-nav");
  if (nav) nav.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nav]");
    if (!btn) return;
    const target = btn.getAttribute("data-nav");
    if (target === "watchlist") {
      body.classList.remove("show-tabsheet");
      body.classList.toggle("show-watchlist-mobile");
      return;
    }
    if (target === "more") {
      body.classList.remove("show-watchlist-mobile");
      body.classList.toggle("show-tabsheet");
      return;
    }
    body.classList.remove("show-watchlist-mobile", "show-tabsheet");
    switchTab(target);
  });
  // Choosing a tab from the "More" sheet closes it.
  document.querySelectorAll("#tabs .tab").forEach((t) =>
    t.addEventListener("click", () => { body.classList.remove("show-tabsheet"); })
  );
  // Tapping a watchlist stock navigates then closes the overlay.
  const wl = el("watchlist");
  if (wl) wl.addEventListener("click", (e) => {
    if (e.target.closest(".wl-item")) body.classList.remove("show-watchlist-mobile");
  });
}

// ---------- desk mode (Option Trading vs Stock Swing Trading) ----------
const MODE_KEY = "nsa_mode";
const VALID_MODES = ["marketcommand", "option", "stockOption", "swing", "dhanbacktest", "aipaper"];
const MODE_FIRST = { marketcommand: "marketcommand", option: "oicommand", stockOption: "toppicks", swing: "news", dhanbacktest: "dhanbacktest", aipaper: "aipdash" };
const MODE_TABS = {
  marketcommand: ["marketcommand"],
  // Index Option Trading: Option Top Pick + Early Moves now live on the Stock
  // Option desk, and AI Paper Trading moved to its own AI Paper Desk, so all
  // three are dropped here.
  option: ["oicommand", "liquiditystatus", "strategylab", "stratreplay"],
  // Stock Option Trading sequence: Option Top Pick -> Early Moves -> Stock Options.
  stockOption: ["toppicks", "earlymoves", "stockoptions"],
  swing: ["news", "bullrank", "todaymovers", "stock", "bigmove", "movetiming"],
  dhanbacktest: ["dhanbacktest"],
  // AI Paper Desk: its own top-level desk. "paper" is the AI Paper Trading
  // screen (reuses #panel-paper). Each tab is additionally permission-gated per
  // screen via SCREEN_PERMISSION_MAP + applyMode (server-enforced too).
  aipaper: ["aipdash", "aipanalysis", "aipsignals", "paper", "aipreview", "aipperf", "aipvalid"],
};

// Per-screen permission gate for AI Paper Desk tabs. A non-admin user only sees
// the tabs whose permission they hold; the backend enforces the same with a 403
// (requirePermission) so hiding the tab is a convenience, not the boundary.
// Tabs not listed here are desk-level gated only (no per-screen permission).
const SCREEN_PERMISSION_MAP = {
  aipdash: "aiPaperDashboard", aipanalysis: "aiPaperAnalysis", aipsignals: "aiPaperSignals",
  paper: "aiPaperTrade", aipreview: "aiPaperReview", aipperf: "aiPaperPerformance", aipvalid: "aiPaperValidation",
};
// True if the current user may see a tab/screen: admin always; otherwise only
// screens with no per-screen gate, or whose permission the user holds. The
// backend enforces the same gate with a 403 - this only controls visibility.
function screenPermitted(tab) {
  const p = SCREEN_PERMISSION_MAP[tab];
  if (!p) return true;
  if (state.role === "admin") return true;
  return (state.permissions || []).includes(p);
}

function setupModeGate() {
  // Desk cards are <article role="button"> (not a real <button>) so the CTA
  // <button class="mg-cta"> inside each one can be a real, separately
  // clickable element without illegal nested <button> markup - a click on the
  // CTA bubbles up to this same delegated listener, so it only ever fires once.
  document.querySelectorAll("#mode-gate [data-mode]").forEach((b) => {
    b.addEventListener("click", () => chooseMode(b.getAttribute("data-mode")));
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseMode(b.getAttribute("data-mode")); }
    });
  });
  const close = el("mg-close");
  if (close) close.addEventListener("click", () => el("mode-gate").classList.add("hidden"));
  const sw = el("mode-switch");
  if (sw) sw.addEventListener("click", () => showModeGate(true));
  setupHomeChrome();
}

function showModeGate(allowClose) {
  const gate = el("mode-gate");
  if (!gate) return;
  const close = el("mg-close");
  if (close) close.classList.toggle("hidden", !allowClose);
  gate.classList.remove("hidden");
  // Refresh the Home screen's live index ticker every time it's (re)shown -
  // both the initial post-login landing and a later manual "switch desk".
  loadHomeTicker();
}

function chooseMode(mode) {
  if (!VALID_MODES.includes(mode)) mode = "option";
  try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
  el("mode-gate")?.classList.add("hidden");
  applyMode(mode);
}

function applyMode(mode) {
  const body = document.body;
  VALID_MODES.forEach((m) => body.classList.toggle("mode-" + m, m === mode));
  renderMobileNav(mode);
  if (mode === "option") refreshIndexStrip();
  // Show only the tabs that belong to this desk. A tab can belong to more than
  // one desk (Paper Desk / Top Pick are shared between Option Trading and Stock
  // Option Trading), so this is driven from MODE_TABS directly rather than the
  // older grp-option/grp-swing CSS classes, which only ever encoded a strict
  // one-tab-one-desk mapping.
  // Tabs allowed in this desk = MODE_TABS membership, further narrowed by any
  // per-screen permission (SCREEN_PERMISSION_MAP) the user does not hold. Admin
  // has implicit full access. The backend enforces the same gate with a 403, so
  // this is a UX convenience, not the security boundary.
  const deskTabs = (MODE_TABS[mode] || []).filter(screenPermitted);
  const allowed = new Set(deskTabs);
  document.querySelectorAll("#tabs .tab").forEach((t) => {
    t.classList.toggle("hidden", !allowed.has(t.getAttribute("data-tab")));
  });
  // If the active tab isn't part of this desk (or is no longer permitted), jump
  // to the desk's first PERMITTED tab. A desk with zero permitted screens (admin
  // gave the desk but no screens) falls back to the desk's nominal first tab.
  const active = document.querySelector("#tabs .tab.active");
  const activeTab = active ? active.getAttribute("data-tab") : null;
  if (!activeTab || !allowed.has(activeTab)) switchTab(deskTabs[0] || MODE_FIRST[mode]);
  else syncMobileNav(activeTab);
}

// Called once login is confirmed: always land on Home ("Choose your desk"),
// for every role. Previously this skipped straight to the last-used desk
// (localStorage MODE_KEY) if one was remembered - now Home is the required
// landing screen every time; picking a card (chooseMode()) still remembers
// the choice for the "switch desk" convenience elsewhere in the app.
function enterApp() {
  showModeGate(false);
}

// Highlight the bottom-nav item matching the active tab; fall back to "More".
function syncMobileNav(tab) {
  const items = document.querySelectorAll("#mobile-nav [data-nav]");
  if (!items.length) return;
  let matched = false;
  items.forEach((b) => {
    const isTab = b.getAttribute("data-nav") === tab;
    b.classList.toggle("active", isTab);
    if (isTab) matched = true;
  });
  if (!matched) {
    const more = document.querySelector('#mobile-nav [data-nav="more"]');
    if (more) more.classList.add("active");
  }
}

// ---------- Market News ----------
async function loadNews(force) {
  const list = el("news-list");
  const sum = el("news-summary");
  if (!list) return;
  if (!state.newsLoadedOnce || force) list.innerHTML = '<div class="wl-sub" style="padding:10px">Loading market news…</div>';
  try {
    const d = await fetch("/api/news" + (force ? "?force=true" : "")).then((r) => r.json());
    state.newsLoadedOnce = true;
    if (d.error) { list.innerHTML = `<div class="wl-sub" style="padding:10px">Could not load news: ${d.error}</div>`; return; }
    const s = d.summary || {};
    const biasCls = s.bias === "Bullish" ? "up" : s.bias === "Bearish" ? "down" : "neutral";
    if (sum) sum.innerHTML =
      `<div class="news-summary-row">
        <span class="verdict ${biasCls}">News bias: ${s.bias || "-"}</span>
        <span class="news-chip pos">▲ ${s.positive || 0} positive</span>
        <span class="news-chip neg">▼ ${s.negative || 0} negative</span>
        <span class="news-chip neu">• ${s.neutral || 0} neutral</span>
        <span class="news-chip imp">⚡ ${s.highImpact || 0} high-impact</span>
        <span class="wl-sub">${(d.items || []).length} headlines · updated ${new Date((d.asOf || 0) * 1000).toLocaleTimeString("en-IN")}</span>
      </div>`;
    const items = d.items || [];
    if (!items.length) { list.innerHTML = '<div class="wl-sub" style="padding:10px">No headlines right now.</div>'; return; }
    list.innerHTML = items.map((n) => {
      const sc = n.sentiment === "positive" ? "pos" : n.sentiment === "negative" ? "neg" : "neu";
      const dot = n.sentiment === "positive" ? "▲" : n.sentiment === "negative" ? "▼" : "•";
      const title = (n.title || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const imp = n.impact === "high" ? '<span class="news-tag imp">⚡ High impact</span>' : "";
      const tags = (n.tags || []).map((t) => `<span class="news-tag">${t}</span>`).join("");
      const link = (n.link || "#").replace(/"/g, "%22");
      return `<div class="news-item ${sc}">
        <span class="news-dot ${sc}">${dot}</span>
        <div class="news-main">
          <a href="${link}" target="_blank" rel="noopener" class="news-title">${title}</a>
          <div class="news-meta"><b>${n.source || ""}</b> · ${n.ago || ""} ${imp} ${tags}</div>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    list.innerHTML = `<div class="wl-sub" style="padding:10px">Could not load news: ${(e && e.message) || e}</div>`;
  }
}

function resizeCharts() {
  const c1 = el("chart");
  if (chart && c1 && c1.clientWidth) {
    chart.applyOptions({ width: c1.clientWidth });
    chart.timeScale().fitContent();
  }
  const rc = el("rsi-chart");
  if (rsiChart && rc && rc.clientWidth) rsiChart.applyOptions({ width: rc.clientWidth });
  const mc = el("macd-chart");
  if (macdChart && mc && mc.clientWidth) macdChart.applyOptions({ width: mc.clientWidth });
  const c2 = el("equity");
  if (equityChart && c2 && c2.clientWidth) equityChart.applyOptions({ width: c2.clientWidth });
}

function setupChartTools() {
  // Chart type: candles / line / area.
  el("chart-type").addEventListener("change", (e) => {
    const t = e.target.value;
    candleSeries.applyOptions({ visible: t === "candles" });
    lineSeries.applyOptions({ visible: t === "line" });
    areaSeries.applyOptions({ visible: t === "area" });
  });
  // Quick timeframe chips.
  document.querySelectorAll("#tf-chips button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tf = btn.getAttribute("data-tf");
      state.interval = tf;
      document.querySelectorAll("#tf-chips button").forEach((b) => b.classList.toggle("active", b === btn));
      const sel = el("interval");
      if (sel) sel.value = tf;
      if (state.active) loadSymbol(state.active);
      loadAlerts();
    });
  });
  // Day / full-range toggle.
  el("day-toggle").addEventListener("click", () => {
    state.chart.dayView = !state.chart.dayView;
    el("day-toggle").classList.toggle("active", state.chart.dayView);
    el("day-toggle").textContent = state.chart.dayView ? "Today" : "All";
    applyChartView();
  });
  // Fit button.
  el("chart-fit").addEventListener("click", () => {
    chart.timeScale().fitContent();
    rsiChart.timeScale().fitContent();
  });
}

// Keep timeframe chips in sync when the dropdown changes.
function syncTfChips() {
  document.querySelectorAll("#tf-chips button").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-tf") === state.interval)
  );
}

// Open a stock in the "Selected Stock" tab (used by watchlist / alert / outlook clicks).
function openStock(symbol, timeframe) {
  // Optionally force a timeframe (e.g. long-term picks open on the daily chart
  // with full history, so you see the multi-month move rather than 5m intraday).
  if (timeframe) {
    state.interval = timeframe;
    const sel = el("interval");
    if (sel) sel.value = timeframe;
    syncTfChips();
    // Show the whole history for daily; keep the "Today" toggle only for intraday.
    state.chart.dayView = timeframe === "1d" ? false : state.chart.dayView;
    const dt = el("day-toggle");
    if (dt) { dt.classList.toggle("active", state.chart.dayView); dt.textContent = state.chart.dayView ? "Today" : "All"; }
  }
  selectSymbol(symbol);
  switchTab("stock");
}

// ---------- symbol selection ----------
function selectSymbol(symbol) {
  state.active = symbol;
  document.querySelectorAll(".wl-item").forEach((n) => n.classList.remove("active"));
  const node = el("wl-" + cssId(symbol));
  if (node) node.classList.add("active");
  loadSymbol(symbol);
}

async function loadSymbol(symbol) {
  const meta = state.symbols.find((s) => s.symbol === symbol);
  el("sym-name").textContent = meta ? `${meta.name} (${symbol})` : symbol;
  el("bt-summary").textContent = "Run a backtest to see historical performance of these signals.";
  equitySeries.setData([]);

  await Promise.all([
    loadCandles(symbol),
    loadSignal(symbol),
    loadQuote(symbol),
    loadOption(symbol),
    loadVolume(symbol),
    loadOi(symbol),
    loadStockOiChain(symbol),
    loadScalp(symbol),
    loadFinal(symbol),
    loadTradeMinder(symbol),
    loadDirection4L(symbol),
  ]);
}

// Broker-style full option chain at the TOP of the Selected Stock OI section
// (reuses the same chain view + verdict as Option Top Pick). "stock" = fixed cid.
async function loadStockOiChain(symbol) {
  const box = document.getElementById("oic-chainbox-stock");
  if (!box) return;
  box.innerHTML = '<div class="wl-sub" style="padding:6px">Loading live option chain…</div>';
  try {
    await loadOiChainDetail(symbol, "stock", 0);
    if (!box.getAttribute("data-loaded")) box.innerHTML = '<div class="wl-sub" style="padding:6px">Option chain not available for this symbol.</div>';
  } catch (e) {
    box.innerHTML = `<div class="wl-sub" style="padding:6px">Chain failed: ${(e && e.message) || e}</div>`;
  }
}

// ---------- 4-Layer Direction Engine ----------
async function loadDirection4L(symbol) {
  const body = el("dir4l-body");
  const badge = el("dir4l-action");
  if (!body || !badge) return;
  badge.textContent = "..."; badge.className = "verdict neutral";
  try {
    const d = await fetch(`/api/direction/${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (d.error) { body.textContent = d.error; badge.textContent = "-"; return; }
    renderDirection4L(d);
  } catch (e) {
    body.textContent = "Direction engine unavailable: " + e.message;
    badge.textContent = "-";
  }
}

function renderDirection4L(d) {
  const body = el("dir4l-body");
  const badge = el("dir4l-action");
  const cls = d.direction === "Bullish" ? "buy" : d.direction === "Bearish" ? "sell" : "neutral";
  badge.textContent = `${d.direction === "Bullish" ? "▲" : d.direction === "Bearish" ? "▼" : "◆"} ${d.direction} · ${d.confidence}%`;
  badge.className = "verdict " + cls;
  // score meter -100..+100
  const pct = ((d.score + 100) / 200) * 100;
  const scoreCls = d.score > 0 ? "up" : d.score < 0 ? "down" : "";
  const sIcon = (dir) => (dir === 1 ? '<span class="up">▲</span>' : dir === -1 ? '<span class="down">▼</span>' : '<span class="wl-sub">•</span>');
  const layers = (d.layers || []).map((L) => {
    const contribCls = L.contribution > 0 ? "up" : L.contribution < 0 ? "down" : "wl-sub";
    const barPct = Math.min(100, Math.abs(L.score) * 100);
    const subs = L.sub.map((s) => `<div class="dir-sub">${sIcon(s.dir)} <span class="dir-sub-n">${s.name}</span> <span class="wl-sub">${s.note}</span></div>`).join("");
    return `
      <div class="dir-layer">
        <div class="dir-layer-head">
          <b>${L.name}</b> <span class="wl-sub">${L.weight}%</span>
          <span class="dir-contrib ${contribCls}">${L.contribution > 0 ? "+" : ""}${L.contribution}</span>
          <span class="dir-bar"><i class="${L.score >= 0 ? "up" : "down"}" style="width:${barPct}%"></i></span>
        </div>
        <div class="dir-subs">${subs}</div>
      </div>`;
  }).join("");
  body.innerHTML = `
    <div class="dir-score-row">
      <div class="dir-score ${scoreCls}">${d.score > 0 ? "+" : ""}${d.score}</div>
      <div class="dir-meter"><span class="dir-mid"></span><i class="${scoreCls}" style="left:${Math.min(100, Math.max(0, pct))}%"></i></div>
      <div class="wl-sub">score −100 … +100 · confidence <b>${d.confidence}%</b></div>
    </div>
    <div class="dir-layers">${layers}</div>
    ${(d.reasons || []).length ? `<ul class="vol-reasons" style="margin-top:6px">${d.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>` : ""}
    <p class="opt-disclaimer">${d.disclaimer || ""}</p>`;
}

async function loadTradeMinder(symbol) {
  const body = el("minder-body");
  const badge = el("minder-state");
  if (!body || !badge) return;
  badge.textContent = "..."; badge.className = "verdict neutral";
  try {
    const m = await fetch(`/api/trade-minder/${encodeURIComponent(symbol)}?interval=${state.interval}&dir=auto`).then((r) => r.json());
    if (m.error) { body.textContent = m.error; badge.textContent = "-"; return; }
    const cls = m.state === "HOLD" ? "up" : m.state === "EXIT" ? "down" : "neutral";
    const icon = m.state === "HOLD" ? "✋ HOLD" : m.state === "EXIT" ? "⛔ EXIT" : "⚠ WATCH";
    badge.textContent = icon;
    badge.className = "verdict " + (cls === "up" ? "buy" : cls === "down" ? "sell" : "neutral");
    body.innerHTML = `
      <div class="vol-metrics">
        <div class="metric"><span>Assumed view</span><b class="${m.direction === "Bullish" ? "up" : "down"}">${m.direction} (${m.direction === "Bullish" ? "CE / long" : "PE / short"})</b></div>
        <div class="metric"><span>Price</span><b>${fmt(m.price)}</b></div>
        <div class="metric"><span>VWAP</span><b>${m.vwap != null ? fmt(m.vwap) : "-"}</b></div>
        <div class="metric"><span>Hold level</span><b>${m.holdLevel != null ? fmt(m.holdLevel) : "-"}</b></div>
        <div class="metric"><span>Structural stop</span><b class="down">${m.structuralStop != null ? fmt(m.structuralStop) : "-"}</b></div>
        <div class="metric"><span>Pullback</span><b>${fmt(m.pullbackAtr)} ATR</b></div>
      </div>
      <p class="vol-reasons" style="margin-top:6px"><b class="${cls}">${icon}:</b> ${m.reason}</p>
      ${m.hindi ? `<p class="mind-hindi" style="margin-top:4px"><b>🧠 </b>${m.hindi}</p>` : ""}
      <p class="opt-disclaimer">${m.disclaimer || ""}</p>`;
  } catch (e) {
    body.textContent = "Trade Minder unavailable: " + e.message;
    badge.textContent = "-";
  }
}

function renderChecklist(f) {
  if (!f.checklist || !f.checklist.length) return "";
  const icon = (s) => (s === "confirm" ? '<span class="ck ck-ok">✓</span>' : s === "against" ? '<span class="ck ck-no">✗</span>' : '<span class="ck ck-neu">–</span>');
  const items = f.checklist.map((c) => `<div class="ck-row">${icon(c.state)} <span>${c.name}</span><small class="ck-w">w${c.weight}</small></div>`).join("");
  return `
    <div class="confirm-box">
      <div class="confirm-head">Confirmation: <b>${f.confirmations}/${f.totalFactors}</b> aligned${f.conflicting ? ` · ${f.conflicting} against` : ""}</div>
      <div class="confirm-grid">${items}</div>
    </div>`;
}

async function loadFinal(symbol) {
  const body = el("final-body");
  const badge = el("final-action");
  badge.textContent = "..."; badge.className = "verdict neutral";
  try {
    const f = await fetch(`/api/final/${encodeURIComponent(symbol)}?interval=${state.interval}`).then((r) => r.json());
    if (f.error) { body.textContent = f.error; return; }
    const bull = f.optionType === "CE";
    const bear = f.optionType === "PE";
    badge.textContent = f.action + (f.atmStrike && (bull || bear) ? " " + f.atmStrike : "") + " · " + f.confidence + "%";
    badge.className = "verdict " + (bull ? "up" : bear ? "down" : "neutral");
    const premiumBlock = f.optionPremium != null
      ? `<div class="metric hi"><span>Buy ${bull ? "CALL" : "PUT"} ${f.atmStrike} at</span><b>₹${fmt(f.optionPremium)}</b><small>option LTP</small></div>
         <div class="metric"><span>Premium target</span><b class="up">₹${fmt(f.premiumTarget)}</b></div>
         <div class="metric"><span>Premium stop</span><b class="down">₹${fmt(f.premiumStop)}</b></div>
         <div class="metric"><span>IV / Theta</span><b>${f.optionIv ?? "-"}% / ${f.optionTheta ?? "-"}</b></div>`
      : "";
    body.innerHTML = `
      ${f.blockReason ? `<div class="block-banner">⛔ No-trade window: ${f.blockReason}</div>` : ""}
      ${f.bluff && f.bluff.length ? `<div class="bluff-banner bluff-${(f.bluffLevel || "").toLowerCase()}"><b>⚠ Bluff/Trap risk: ${f.bluffLevel}</b><ul>${f.bluff.map((b) => `<li>${b}</li>`).join("")}</ul></div>` : ""}
      <div class="vol-metrics">
        <div class="metric"><span>Action</span><b class="${bull ? "up" : bear ? "down" : ""}">${f.action}</b></div>
        ${premiumBlock}
        <div class="metric"><span>Spot entry ${bull ? "(> day high)" : bear ? "(< day low)" : ""}</span><b>${fmt(f.entry)}</b></div>
        <div class="metric"><span>Spot target</span><b class="up">${fmt(f.target)}</b></div>
        <div class="metric"><span>Spot stop</span><b class="down">${fmt(f.stop)}</b></div>
        <div class="metric"><span>PCR</span><b>${f.pcr ?? "-"}</b></div>
        <div class="metric"><span>OI Support</span><b class="up">${f.support ?? "-"}</b></div>
        <div class="metric"><span>OI Resistance</span><b class="down">${f.resistance ?? "-"}</b></div>
        <div class="metric"><span>Max pain</span><b>${f.maxPain ?? "-"}</b></div>
        <div class="metric"><span>Futures OI</span><b class="${
          f.futBuildup === "Long buildup" ? "up" : f.futBuildup === "Short buildup" ? "down" : ""
        }">${f.futBuildup || "-"}</b><small>${
          f.futOiChangePct != null ? (f.futOiChangePct >= 0 ? "+" : "") + f.futOiChangePct + "% OI" : ""
        }</small></div>
      </div>
      ${renderChecklist(f)}
      <ul class="vol-reasons">${(f.reasons || []).map((r) => `<li>${r}</li>`).join("")}</ul>
      <p class="opt-disclaimer">${f.disclaimer}</p>`;
  } catch (e) {
    body.textContent = "Could not load final suggestion: " + e.message;
  }
}

async function loadQuote(symbol) {
  try {
    const q = await fetch(`/api/quote/${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (q.error) return;
    el("sym-price").textContent = fmt(q.price);
    const chEl = el("sym-change");
    const up = q.change >= 0;
    chEl.textContent = `${up ? "+" : ""}${fmt(q.change)} (${up ? "+" : ""}${fmt(q.changePercent)}%)`;
    chEl.className = "change " + (up ? "up" : "down");

    // Day stats summary (Selected Stock tab)
    el("ss-high").textContent = fmt(q.dayHigh);
    el("ss-low").textContent = fmt(q.dayLow);
    el("ss-ltp").textContent = fmt(q.price);
    const ssc = el("ss-change");
    ssc.textContent = `${up ? "+" : ""}${fmt(q.changePercent)}%`;
    ssc.className = up ? "up" : "down";
    el("ss-vol").textContent = q.volume ? fmt(q.volume, 0) : "-";
  } catch (_) {}
}

async function loadCandles(symbol) {
  const data = await fetch(`/api/candles/${encodeURIComponent(symbol)}?interval=${state.interval}`).then((r) => r.json());
  if (data.error) { console.warn(data.error); return; }
  const c = data.candles;

  // Cache for the hover readout + markers.
  state.chart.candles = c;
  state.chart.overlays = data.overlays;
  state.chart.scores = data.scores || [];
  state.chart.timeToIndex = new Map(c.map((x, i) => [x.time, i]));

  candleSeries.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
  volumeSeries.setData(
    c.map((x) => ({
      time: x.time,
      value: x.volume,
      color: x.close >= x.open ? "rgba(22,199,132,0.5)" : "rgba(234,57,67,0.5)",
    }))
  );
  ema9Series.setData(alignSeries(c, data.overlays.ema9));
  ema21Series.setData(alignSeries(c, data.overlays.ema21));
  if (data.overlays.ema50) ema50Series.setData(alignSeries(c, data.overlays.ema50));
  vwapSeries.setData(alignSeries(c, data.overlays.vwap));
  stSeries.setData(alignSeries(c, data.overlays.supertrend));
  bbUpperSeries.setData(alignSeries(c, data.overlays.bbUpper));
  bbLowerSeries.setData(alignSeries(c, data.overlays.bbLower));
  kcUpperSeries.setData(alignSeries(c, data.overlays.kcUpper));
  kcLowerSeries.setData(alignSeries(c, data.overlays.kcLower));
  lineSeries.setData(c.map((x) => ({ time: x.time, value: x.close })));
  areaSeries.setData(c.map((x) => ({ time: x.time, value: x.close })));
  if (data.sub && data.sub.rsi) rsiSeries.setData(alignSeries(c, data.sub.rsi));
  if (data.sub && data.sub.macd && macdChart) {
    const m = data.sub.macd;
    macdLineSeries.setData(alignSeries(c, m.macd));
    macdSignalSeries.setData(alignSeries(c, m.signal));
    macdHistSeries.setData((m.histogram || []).map((v, i) => v == null ? null : ({
      time: c[i].time, value: v,
      color: v >= 0 ? "rgba(22,199,132,0.6)" : "rgba(234,57,67,0.6)",
    })).filter(Boolean));
  }

  buildMarkers();
  updateLegend(c.length - 1);
  applyChartView();
}

function istDate(sec) {
  return new Date((sec + 19800) * 1000).toISOString().slice(0, 10);
}

// Focus the chart on the latest trading day (or show all in "full" mode / on 1d).
function applyChartView() {
  const c = state.chart.candles;
  if (!c.length) return;
  if (!state.chart.dayView || state.interval === "1d") {
    chart.timeScale().fitContent();
    return;
  }
  const lastDay = istDate(c[c.length - 1].time);
  let fromIdx = c.length - 1;
  for (let i = c.length - 1; i >= 0; i--) {
    if (istDate(c[i].time) === lastDay) fromIdx = i;
    else break;
  }
  try {
    chart.timeScale().setVisibleRange({ from: c[fromIdx].time, to: c[c.length - 1].time });
  } catch (_) {
    chart.timeScale().fitContent();
  }
}

// Buy/Sell arrows where the score crosses the +/-30 entry threshold.
function buildMarkers() {
  const c = state.chart.candles;
  const s = state.chart.scores;
  const THR = 30;
  const markers = [];
  let prevSide = 0;
  for (let i = 0; i < c.length; i++) {
    const sc = s[i];
    if (sc == null) continue;
    const side = sc >= THR ? 1 : sc <= -THR ? -1 : 0;
    if (side === 1 && prevSide !== 1) {
      markers.push({ time: c[i].time, position: "belowBar", color: "#16c784", shape: "arrowUp", text: "BUY CALL", size: 2 });
    } else if (side === -1 && prevSide !== -1) {
      markers.push({ time: c[i].time, position: "aboveBar", color: "#ea3943", shape: "arrowDown", text: "SELL PUT", size: 2 });
    }
    if (side !== 0) prevSide = side;
  }
  state.chart.markers = markers;
  candleSeries.setMarkers(state.chart.showMarkers ? markers : []);
}

function updateLegend(index) {
  const c = state.chart.candles;
  if (!c.length) return;
  const i = index != null && index >= 0 && index < c.length ? index : c.length - 1;
  const bar = c[i];
  if (!bar) return;
  const ov = state.chart.overlays;
  const val = (arr) => (arr && arr[i] != null ? fmt(arr[i]) : "-");
  const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
  const upcls = bar.close >= bar.open ? "up" : "down";
  const sc = state.chart.scores[i];
  const scTxt = sc == null ? "-" : (sc > 0 ? "+" : "") + sc;
  const scCls = sc == null ? "" : sc >= 15 ? "up" : sc <= -15 ? "down" : "";
  const optTxt = sc == null ? "-" : sc >= 15 ? "CALL" : sc <= -15 ? "PUT" : "wait";
  const optCls = sc == null ? "" : sc >= 15 ? "up" : sc <= -15 ? "down" : "";
  const t = new Date(bar.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  el("chart-legend").innerHTML = `
    <span class="cl-time">${t}</span>
    <span>O <b>${fmt(bar.open)}</b></span>
    <span>H <b>${fmt(bar.high)}</b></span>
    <span>L <b>${fmt(bar.low)}</b></span>
    <span>C <b class="${upcls}">${fmt(bar.close)}</b></span>
    <span class="${upcls}">${chg >= 0 ? "+" : ""}${fmt(chg)}%</span>
    <span class="sep"></span>
    <span class="cl-ema9">EMA9 <b>${val(ov.ema9)}</b></span>
    <span class="cl-ema21">EMA21 <b>${val(ov.ema21)}</b></span>
    <span class="cl-ema50">EMA50 <b>${val(ov.ema50)}</b></span>
    <span class="cl-vwap">VWAP <b>${val(ov.vwap)}</b></span>
    <span class="cl-st">ST <b>${val(ov.supertrend)}</b></span>
    <span>Vol <b>${fmt(bar.volume, 0)}</b></span>
    <span>Score <b class="${scCls}">${scTxt}</b></span>
    <span>Option <b class="${optCls}">${optTxt}</b></span>`;
}

function setupToggles() {
  document.querySelectorAll("#chart-toggles .toggle").forEach((node) => {
    node.addEventListener("click", () => {
      const key = node.getAttribute("data-series");
      const off = node.classList.toggle("off");
      if (key === "markers") {
        state.chart.showMarkers = !off;
        candleSeries.setMarkers(state.chart.showMarkers ? state.chart.markers : []);
      } else if (Array.isArray(seriesMap[key])) {
        seriesMap[key].forEach((s) => s.applyOptions({ visible: !off }));
      } else if (seriesMap[key]) {
        seriesMap[key].applyOptions({ visible: !off });
      }
    });
  });
}

function alignSeries(candles, series) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    if (series[i] != null) out.push({ time: candles[i].time, value: series[i] });
  }
  return out;
}

async function loadSignal(symbol) {
  const sig = await fetch(`/api/signal/${encodeURIComponent(symbol)}?interval=${state.interval}`).then((r) => r.json());
  if (sig.error) { console.warn(sig.error); return; }

  const labelEl = el("signal-label");
  labelEl.textContent = sig.label;
  labelEl.className = "signal-label " + sig.label.toLowerCase().replace(" ", "-");

  renderLevels(sig);

  // Market direction in the day-stats summary
  const dirEl = el("ss-dir");
  if (dirEl) {
    const bull = sig.score >= 15;
    const bear = sig.score <= -15;
    dirEl.textContent = bull ? "Bullish ▲" : bear ? "Bearish ▼" : "Neutral →";
    dirEl.className = "verdict " + (bull ? "up" : bear ? "down" : "neutral");
  }

  el("signal-score").textContent = sig.score;
  el("signal-conf").textContent = sig.confidence + "%";
  el("signal-sl").textContent = fmt(sig.suggestedStopLoss);
  el("signal-target").textContent = fmt(sig.suggestedTarget);

  // gauge: map -100..100 to 0..100% width from center
  const fill = el("gauge-fill");
  const c = colorForScore(sig.score);
  const half = Math.abs(sig.score) / 2; // percent of full track
  if (sig.score >= 0) { fill.style.left = "50%"; fill.style.width = half + "%"; }
  else { fill.style.left = (50 - half) + "%"; fill.style.width = half + "%"; }
  fill.style.background = c.fg;

  const votes = el("votes");
  votes.innerHTML = "";
  sig.votes.forEach((v) => {
    const li = document.createElement("li");
    li.className = "vote " + v.bias;
    li.innerHTML = `
      <div class="vote-main"><span class="vote-name">${v.name}</span>
      <span class="vote-reason">${v.reason}</span></div>
      <span class="vote-val">${v.value}</span>`;
    votes.appendChild(li);
  });
}

// ---------- options trade setup ----------
// `ids` lets a second consumer (the Stock Options tab) reuse this exact fetch +
// render flow against its own controls/container instead of the "Selected
// Stock" tab's, rather than duplicating the fetch/render logic.
async function loadOption(symbol, ids = {}) {
  const bodyId = ids.body || "option-body";
  const body = el(bodyId);
  if (!body) return;
  const params = new URLSearchParams({
    interval: state.interval,
    capital: el(ids.capital || "opt-capital")?.value || "100000",
    risk: el(ids.risk || "opt-risk")?.value || "2",
  });
  const prem = el(ids.premium || "opt-premium")?.value;
  if (prem) params.set("premium", prem);

  try {
    const data = await fetch(`/api/options/${encodeURIComponent(symbol)}?${params}`).then((r) => r.json());
    if (data.error) { body.textContent = data.error; return; }
    renderOption(data.option, data.risk, bodyId);
  } catch (e) {
    body.textContent = "Could not load option setup: " + e.message;
  }
}

// `extraHtml` (optional) is appended inside the same card, below the
// disclaimer - used by Trader Dashboard to fold its market-situation read
// into this card instead of keeping it as a separate section, since the two
// were reading as duplicated. Other callers (Options / Stock Options tabs)
// don't pass it and are unaffected.
function riskRadarHtml(risk, extraHtml = "") {
  if (!risk) return "";
  const lvlCls = risk.level === "High" ? "danger" : risk.level === "Elevated" ? "caution" : "low";
  const items = (risk.warnings || [])
    .map(
      (w) => `<li class="rr-item rr-${w.severity}">
        <span class="rr-tag rr-${w.severity}">${w.severity.toUpperCase()}</span>
        <span class="rr-text"><b>${w.title}</b> - ${w.detail}</span>
      </li>`
    )
    .join("");
  // <details>/<summary> so the whole card can be collapsed - open by default
  // so nothing changes visually until the trader chooses to fold it away.
  return `
    <details class="risk-radar rr-${lvlCls}" open>
      <summary class="rr-head">
        <span class="rr-title">⚠ Risk Radar</span>
        <span class="rr-level rr-${lvlCls}">Spike risk: ${risk.level} (${risk.spikeRisk}/100)</span>
        <span class="rr-caret">⌄</span>
      </summary>
      <div class="rr-body">
        <div class="rr-meter"><div class="rr-fill rr-${lvlCls}" style="width:${risk.spikeRisk}%"></div></div>
        <div class="rr-sub">ATR ${risk.atrPct ?? "-"}%${risk.atrRatio ? " · " + risk.atrRatio + "x normal" : ""}${risk.adx != null ? " · ADX " + risk.adx : ""}${risk.premiumSwingPct != null ? " · 1 ATR ≈ " + risk.premiumSwingPct + "% of premium" : ""}</div>
        <ul class="rr-list">${items}</ul>
        <p class="opt-disclaimer">${risk.note}</p>
        ${extraHtml}
      </div>
    </details>`;
}

// Market-situation read (situation text, reasons, bull/bear scenario, trader
// guidance) - folded into the Risk Radar card on Trader Dashboard via
// riskRadarHtml's extraHtml param, since the two previously sat as separate
// sections and read as duplicated content.
function renderMarketReadHtml(C) {
  if (!C) return "";
  const reasons = (C.reasons || []).map((r) => `<li>${r}</li>`).join("");
  return `
    <div class="rr-market">
      <div class="rr-market-head">🗺️ Market स्थिति</div>
      <p class="rr-market-p">${C.situation || "—"}</p>
      ${reasons ? `<ul class="rr-market-reasons">${reasons}</ul>` : ""}
      <details class="rr-market-scenario">
        <summary>
          ${C.path && C.path.up ? `<span class="mtc-pathrow"><b class="up">ऊपर:</b> ${C.path.up}</span>` : ""}
          ${C.path && C.path.down ? `<span class="mtc-pathrow"><b class="down">नीचे:</b> ${C.path.down}</span>` : ""}
          <span class="mtc-scenario-caret">⌄ detail</span>
        </summary>
        <div class="rr-market-grid2">
          <div class="rr-market-case up"><h5>Bullish case</h5><p>${C.bullCase || "—"}</p></div>
          <div class="rr-market-case down"><h5>Bearish case</h5><p>${C.bearCase || "—"}</p></div>
        </div>
      </details>
      <div class="rr-market-guidance">🧭 Trader निर्देश: ${C.guidance || "—"}</div>
    </div>`;
}

function renderOption(o, radarData, bodyId = "option-body") {
  const body = el(bodyId);
  if (!body) return;
  const radar = riskRadarHtml(radarData);
  if (!o.fno) {
    body.innerHTML = radar + `<p class="wl-sub">${o.reason}</p>`;
    return;
  }
  if (!o.optionType) {
    body.innerHTML = radar + `<div class="opt-neutral">${o.reason}</div>`;
    return;
  }

  const isCall = o.optionType === "CE";
  const tone = isCall ? "up" : "down";
  const kind = isCall ? "CALL (CE)" : "PUT (PE)";

  const riskClass = (lvl) => (lvl === "High" ? "risk-high" : lvl === "Low" ? "risk-low" : "risk-med");
  const strikeRows = (o.strikes || [])
    .map(
      (s) => `<tr class="${s.moneyness === 'ATM' ? 'atm' : ''}">
        <td><b>${s.strike}</b> <span class="mny">${s.moneyness}</span></td>
        <td class="wl-sub">${s.note}</td>
        <td><span class="risk-pill ${riskClass(s.riskLevel)}">${s.riskLevel} risk</span></td></tr>`
    )
    .join("");

  const timing = o.holdTimeframe
    ? `<div class="opt-info">
         <h4>How long to hold</h4>
         <div class="info-line"><b>~${o.holdTimeframe.candles} candles (~${o.holdTimeframe.approxMinutes} min)</b></div>
         <p class="wl-sub">${o.holdTimeframe.note}</p>
       </div>`
    : "";
  const decay = o.timeDecay
    ? `<div class="opt-info">
         <h4>Time decay (theta) <span class="risk-pill ${riskClass(o.timeDecay.level)}">${o.timeDecay.level}</span></h4>
         <p class="wl-sub">${o.timeDecay.note}</p>
       </div>`
    : "";
  const risk = o.riskNote
    ? `<div class="opt-info">
         <h4>Risk rating <span class="risk-pill ${riskClass(o.riskLevel)}">${o.riskLevel}</span></h4>
         <p class="wl-sub">${o.riskNote}</p>
       </div>`
    : "";

  const premiumBlock =
    o.premium != null
      ? `<div class="metric"><span>Entry (LTP)</span><b>${fmt(o.premium)}</b></div>
         <div class="metric"><span>Option stop-loss</span><b class="down">${fmt(o.premiumStop)}</b></div>
         <div class="metric"><span>Option target</span><b class="up">${fmt(o.premiumTarget)}</b></div>
         <div class="metric"><span>Est. capital needed</span><b>₹${fmt(o.estCapitalRequired)}</b></div>`
      : `<div class="metric"><span>Entry</span><b>near ATM premium</b></div>
         <div class="metric"><span>Option stop rule</span><b class="down">~30% of premium</b></div>
         <div class="metric wide"><span>Tip</span><b>Enter LTP above for exact SL & capital</b></div>`;

  body.innerHTML = radar + `
    <div class="opt-headline ${tone}">
      BUY ${o.name} ${o.atmStrike} ${kind}
    </div>`
    + `
    <p class="wl-sub">${o.reason}</p>
    <div class="opt-metrics">
      <div class="metric"><span>Direction</span><b class="${tone}">${o.direction}</b></div>
      <div class="metric"><span>Spot</span><b>${fmt(o.spot)}</b></div>
      <div class="metric"><span>Underlying stop</span><b class="down">${fmt(o.underlyingStop)}</b></div>
      <div class="metric"><span>Lot size</span><b>${o.lotSize}</b></div>
      <div class="metric"><span>Suggested lots</span><b>${o.suggestedLots}</b></div>
      <div class="metric"><span>Quantity</span><b>${o.quantity}</b></div>
      <div class="metric"><span>Risk budget</span><b>₹${fmt(o.riskBudget)}</b></div>
      <div class="metric"><span>Risk / lot (est)</span><b>₹${fmt(o.perLotRisk)}</b></div>
      ${premiumBlock}
    </div>
    <h4>Strike choices</h4>
    <table class="strike-table">${strikeRows}</table>
    ${timing}
    ${decay}
    ${risk}
    <p class="opt-disclaimer">${o.disclaimer}</p>`;
}

// ---------- Stock Option Trading tab (per-stock F&O trade + risk) ----------
// Reuses loadOption()/renderOption() (the same engine behind the "Selected
// Stock" tab's options card) against a stock-only picker + its own container,
// instead of duplicating the fetch/render logic for a second desk.
const SOPT_IDS = { body: "sopt-body", capital: "sopt-capital", risk: "sopt-risk", premium: "sopt-premium" };
function initStockOptions() {
  const sel = el("sopt-symbol");
  const btn = el("sopt-get");
  if (sel && !sel.options.length) {
    const stocks = (state.symbols || []).filter((s) => s.type !== "index" && s.fno);
    sel.innerHTML = stocks.length
      ? stocks.map((s) => `<option value="${s.symbol}">${s.name}</option>`).join("")
      : `<option value="">No F&O stocks configured</option>`;
  }
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const symbol = sel?.value;
      if (symbol) loadOption(symbol, SOPT_IDS);
    });
  }
}

// ---------- Trader Mind tab (options-interest command view) ----------
// Reuses the same live data Trader Dashboard already fetches (GET /api/oi-command)
// plus GET /api/signal (the same indicator-vote breakdown the "Selected
// Stock" tab's Confirmation panel uses) and GET /api/candles (the same
// candle+overlay endpoint the main chart uses) - laid out as one dense
// command view instead of spread across tabs. No new backend routes.
let tmChart = null, tmCandleSeries = null, tmEma21Series = null, tmEma50Series = null, tmVwapSeries = null;
let tmSymbolsLoaded = false, tmLiveTimer = null, tmBusy = false;
let tmLastPcr = {}; // symbol -> previous poll's PCR, for a ΔPCR readout (not a stored server field)
const tmAlerts = []; // {symbol, level, dir, label}

function initTraderMindTab() {
  const sel = el("tm-symbol");
  if (sel && !tmSymbolsLoaded) {
    tmSymbolsLoaded = true;
    const syms = state.symbols || [];
    const idx = syms.filter((s) => s.type === "index");
    const eq = syms.filter((s) => s.type !== "index" && s.fno);
    const grp = (label, arr) => arr.length ? `<optgroup label="${label}">${arr.map((s) => `<option value="${s.symbol}">${s.name}</option>`).join("")}</optgroup>` : "";
    sel.innerHTML = grp("Indices", idx) + grp("Stocks", eq);
    sel.value = "^NSEI";
    sel.addEventListener("change", loadTraderMindTab);
  }
  if (!tmChart) buildTraderMindChart();
  loadTraderMindTab();
}

function buildTraderMindChart() {
  const container = el("tm-chart");
  if (!container || typeof LightweightCharts === "undefined") return;
  tmChart = LightweightCharts.createChart(container, chartOpts(container.clientWidth, 280));
  tmCandleSeries = tmChart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", wickUpColor: "#16c784", wickDownColor: "#ea3943", borderVisible: false });
  tmEma21Series = tmChart.addLineSeries({ color: "#5b9bd5", lineWidth: 1 });
  tmEma50Series = tmChart.addLineSeries({ color: "#2962ff", lineWidth: 2 });
  tmVwapSeries = tmChart.addLineSeries({ color: "#a855f7", lineWidth: 1, lineStyle: 2 });
  window.addEventListener("resize", () => { if (tmChart) tmChart.applyOptions({ width: container.clientWidth }); });
}

function startTraderMindLive() {
  if (tmLiveTimer) return;
  tmLiveTimer = setInterval(() => {
    const pn = document.getElementById("panel-tradermind");
    if (!pn || !pn.classList.contains("active") || tmBusy) return;
    loadTraderMindTab();
  }, 15000);
}

async function loadTraderMindTab() {
  const sym = el("tm-symbol")?.value || "^NSEI";
  if (tmBusy) return;
  tmBusy = true;
  try {
    const [d, sig, quote, candleData] = await Promise.all([
      fetch(`/api/oi-command?symbol=${encodeURIComponent(sym)}`).then((r) => r.json()),
      fetch(`/api/signal/${encodeURIComponent(sym)}?interval=5m`).then((r) => r.json()).catch(() => null),
      fetch(`/api/quote/${encodeURIComponent(sym)}`).then((r) => r.json()).catch(() => null),
      fetch(`/api/candles/${encodeURIComponent(sym)}?interval=5m`).then((r) => r.json()).catch(() => null),
    ]);
    if (d.error) return;
    renderTmHead(d, sig, quote, sym);
    renderTmChartData(candleData);
    renderTmStructure(d);
    renderTmOiMap(d);
    renderTmHeatmap(d);
    renderTmFlow(d, sym);
    renderTmConfirm(sig);
    renderTmLevels(d);
    renderTmCommentary(d, sig);
    renderTmPlan(d, sym);
    checkTmAlerts(sym, d.spot);
  } catch (e) {
    console.warn("Trader Mind load failed:", e.message);
  } finally {
    tmBusy = false;
  }
}

function renderTmHead(d, sig, quote, sym) {
  const spotEl = el("tm-spot-val"), chgEl = el("tm-spot-chg");
  if (spotEl) spotEl.textContent = d.spot != null ? fmt(d.spot) : "—";
  if (chgEl) {
    if (quote && quote.change != null) {
      const up = quote.change >= 0;
      chgEl.className = "tm-spot-chg " + (up ? "up" : "down");
      chgEl.textContent = `${up ? "▲" : "▼"} ${fmt(Math.abs(quote.change))} (${up ? "+" : ""}${fmt(quote.changePercent)}%)`;
    } else chgEl.textContent = "";
  }
  const atm = el("tm-atm"); if (atm) atm.textContent = (d.oiSummary && d.oiSummary.atmStrike) || d.setup?.strike || "—";
  const exp = el("tm-expiry"); if (exp) exp.textContent = d.expiry || "—";
  const time = el("tm-time"); if (time) time.textContent = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  const regime = el("tm-regime"); if (regime) regime.textContent = (d.ext && d.ext.regime) || "—";
  const bias = el("tm-oibias");
  if (bias) {
    const v = d.oiVerdict || "Neutral";
    bias.textContent = v;
    bias.className = v === "Bullish" ? "up" : v === "Bearish" ? "down" : "";
  }
  const conf = sig ? sig.confidence : (d.recommendation?.directional?.confidence ?? null);
  const confEl = el("tm-conf"); if (confEl) confEl.textContent = conf != null ? Math.round(conf) : "—";
  const ring = el("tm-gauge-ring");
  if (ring && conf != null) {
    const c = 2 * Math.PI * 42;
    ring.style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(100, conf)) / 100));
    ring.style.stroke = conf >= 70 ? "#16c784" : conf >= 40 ? "#f0b90b" : "#ea3943";
  }
  const live = el("tm-live"); if (live) live.style.display = d.refresh?.marketOpen === false ? "none" : "";
}

function renderTmChartData(data) {
  if (!data || data.error || !tmCandleSeries) return;
  const c = data.candles || [];
  tmCandleSeries.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
  if (data.overlays) {
    if (data.overlays.ema21) tmEma21Series.setData(alignSeries(c, data.overlays.ema21));
    if (data.overlays.ema50) tmEma50Series.setData(alignSeries(c, data.overlays.ema50));
    if (data.overlays.vwap) tmVwapSeries.setData(alignSeries(c, data.overlays.vwap));
  }
  if (tmChart) tmChart.timeScale().fitContent();
}

function renderTmStructure(d) {
  const box = el("tm-structure");
  if (!box) return;
  const support = d.oiSummary?.putWall?.strike ?? d.levels?.orbLow ?? null;
  const resistance = d.oiSummary?.callWall?.strike ?? d.levels?.orbHigh ?? null;
  const spot = d.spot;
  let pct = 50;
  if (support != null && resistance != null && resistance > support && spot != null) {
    pct = Math.max(2, Math.min(98, Math.round(((spot - support) / (resistance - support)) * 100)));
  }
  box.innerHTML = `
    <div class="tm-struct-row">
      <div class="tm-struct-box down"><span>SUPPORT</span><b>${support != null ? fmt(support) : "—"}</b><em>PUT WALL${d.oiSummary?.putPct != null ? " · " + d.oiSummary.putPct + "%" : ""}</em></div>
      <div class="tm-struct-track">
        <div class="tm-struct-line"></div>
        <div class="tm-struct-dot" style="left:${pct}%"></div>
        <div class="tm-struct-spot" style="left:${pct}%">${spot != null ? fmt(spot) : "—"}<small>ATM ${d.oiSummary?.atmStrike ?? "—"}</small></div>
      </div>
      <div class="tm-struct-box up"><span>RESISTANCE</span><b>${resistance != null ? fmt(resistance) : "—"}</b><em>CALL WALL${d.oiSummary?.callPct != null ? " · " + d.oiSummary.callPct + "%" : ""}</em></div>
    </div>`;
}

function renderTmOiMap(d) {
  const box = el("tm-oimap");
  if (!box) return;
  // Same chain data as the OI Details drawer - a different, denser skin of it here.
  box.innerHTML = renderOiDetailsHtml(d);
}

function renderTmHeatmap(d) {
  const box = el("tm-heatmap");
  if (!box) return;
  const rows = d.oiChain || [];
  if (!rows.length) { box.innerHTML = `<div class="wl-sub" style="padding:8px">No chain loaded yet.</div>`; return; }
  const maxOi = Math.max(1, ...rows.map((r) => Math.max(r.ce.oi || 0, r.pe.oi || 0)));
  const heat = (v) => {
    const ratio = (v || 0) / maxOi;
    return ratio >= 0.66 ? "hi" : ratio >= 0.33 ? "med" : "lo";
  };
  const oiL = (n) => (n == null ? "—" : n >= 100000 ? (n / 100000).toFixed(2) + "L" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
  const trs = rows.slice().sort((a, b) => b.strike - a.strike).map((r) => `
    <tr class="${r.atm ? "tm-heat-atm" : ""}">
      <td class="tm-heat ${heat(r.ce.oi)} ce">${oiL(r.ce.oi)}</td>
      <td class="tm-heat-strike">${r.strike}</td>
      <td class="tm-heat ${heat(r.pe.oi)} pe">${oiL(r.pe.oi)}</td>
    </tr>`).join("");
  box.innerHTML = `
    <table class="tm-heat-table">
      <thead><tr><th>Call OI</th><th>Strike</th><th>Put OI</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
    <div class="tm-heat-legend">
      <span class="tm-heat-key hi"></span> High OI &nbsp; <span class="tm-heat-key med"></span> Medium OI &nbsp; <span class="tm-heat-key lo"></span> Low OI
    </div>`;
}

function renderTmFlow(d, sym) {
  const box = el("tm-oiflow");
  if (!box) return;
  const rows = d.oiChain || [];
  const n = rows.length || 1;
  const count = (pred) => rows.filter(pred).length;
  const pct = (n2) => Math.round((n2 / n) * 100);
  const callW = pct(count((r) => (r.ce.action || "").startsWith("Call writing")));
  const putW = pct(count((r) => (r.pe.action || "").startsWith("Put writing")));
  const callU = pct(count((r) => (r.ce.action || "").startsWith("Call unwinding")));
  const putU = pct(count((r) => (r.pe.action || "").startsWith("Put unwinding")));
  const tile = (label, p, cls) => `<div class="tm-flow-tile"><span>${label}</span><b class="${cls}">${p >= 40 ? "HIGH" : "LOW"}</b><small>${p}% of strikes</small></div>`;
  const S = d.oiSummary || {};
  const pcr = S.pcr;
  const prevPcr = tmLastPcr[sym];
  const dPcr = pcr != null && prevPcr != null ? Math.round((pcr - prevPcr) * 100) / 100 : null;
  if (pcr != null) tmLastPcr[sym] = pcr;
  const totOi = (S.totCe || 0) + (S.totPe || 0);
  const churn = totOi > 0 ? Math.abs((S.netCeChg || 0) + (S.netPeChg || 0)) / totOi : 0;
  box.innerHTML = `
    <div class="tm-flow-grid">
      ${tile("Call writing", callW, "down")}
      ${tile("Put writing", putW, "up")}
      ${tile("Call unwinding", callU, "up")}
      ${tile("Put unwinding", putU, "down")}
    </div>
    <div class="tm-flow-stats">
      <div><span>PCR</span><b>${pcr != null ? pcr.toFixed(2) : "—"}</b></div>
      <div><span>Δ PCR</span><b class="${dPcr > 0 ? "up" : dPcr < 0 ? "down" : ""}">${dPcr != null ? (dPcr >= 0 ? "+" : "") + dPcr : "—"}</b></div>
      <div><span>Total OI</span><b>${totOi ? (totOi / 10000000).toFixed(1) + " Cr" : "—"}</b></div>
      <div><span>Volume</span><b>${churn >= 0.03 ? "HIGH" : "LOW"}</b></div>
    </div>`;
}

function renderTmConfirm(sig) {
  const box = el("tm-confirm");
  if (!box) return;
  if (!sig || !sig.votes) { box.innerHTML = `<div class="wl-sub" style="padding:8px">Signal not available.</div>`; return; }
  const rows = sig.votes.map((v) => {
    const cls = v.bias === "bullish" ? "up" : v.bias === "bearish" ? "down" : "neu";
    const score = Math.round(v.weight) * (v.bias === "bearish" ? -1 : 1);
    return `<tr>
      <td>${v.name}</td>
      <td><span class="tm-confirm-dot ${cls}"></span>${v.bias === "bullish" ? "Bullish" : v.bias === "bearish" ? "Bearish" : "Neutral"}</td>
      <td class="${cls}">${score >= 0 ? "+" : ""}${score}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `
    <table class="tm-confirm-table">
      <thead><tr><th>Factor</th><th>Signal</th><th>Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="tm-confirm-total"><span>TOTAL SCORE</span><b>${sig.confidence}/100</b></div>`;
}

function renderTmLevels(d) {
  const box = el("tm-levels");
  if (!box) return;
  const L = d.commentary?.levels || {};
  const gN = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
  box.innerHTML = `
    <div class="o2-lv"><span>Current spot</span><b>${gN(d.spot)}</b></div>
    <div class="o2-lv"><span class="up">Immediate support</span><b>${gN(L.immSupport)}</b></div>
    <div class="o2-lv"><span class="up">Major support</span><b>${gN(L.majorSupport)}</b></div>
    <div class="o2-lv"><span class="down">Immediate resistance</span><b>${gN(L.immResistance)}</b></div>
    <div class="o2-lv"><span class="down">Major resistance</span><b>${gN(L.majorResistance)}</b></div>`;
}

function renderTmCommentary(d, sig) {
  const box = el("tm-commentary");
  if (!box) return;
  const C = d.commentary || {};
  const dir = d.recommendation?.directional || {};
  const bullish = d.oiVerdict === "Bullish" || (sig && sig.score > 0);
  const bearish = d.oiVerdict === "Bearish" || (sig && sig.score < 0);
  const biasCls = bullish ? "up" : bearish ? "down" : "";
  const biasWord = bullish ? "BULLISH BIAS" : bearish ? "BEARISH BIAS" : "NEUTRAL";
  const ready = !!dir.take;
  const side = d.setup?.optionType && d.setup.optionType !== "—" ? d.setup.optionType : (d.oiDirection === "UP" ? "CE" : d.oiDirection === "DOWN" ? "PE" : "—");
  box.innerHTML = `
    <div class="tm-commentary-head">
      <span class="${biasCls}" style="font-weight:800;font-size:15px">🐂 ${biasWord}</span>
      <span class="tm-status-pill ${ready ? "go" : "wait"}">${ready ? "READY" : "WAIT FOR CONFIRMATION"}</span>
    </div>
    <p style="margin:10px 0;font-size:13px;line-height:1.6;color:var(--muted)">${C.situation || "Analysis loads once the OI chain and candles are both available."}</p>
    ${side !== "—" ? `<div style="font-size:13px;line-height:1.8">
      <b>Preferred setup:</b> ${side === "CE" ? "CALL" : "PUT"}<br>
      <b>Entry trigger:</b> ${dir.spotTarget ? fmt(dir.spotTarget) + " breakout + OI confirmation" : "waiting for a confirmed trigger"}<br>
      <b>SL:</b> ${dir.stop != null ? fmt(dir.stop) : "—"} &nbsp;|&nbsp; <b>Target:</b> ${dir.target != null ? fmt(dir.target) : "—"}
    </div>` : ""}`;
}

function renderTmPlan(d, sym) {
  const box = el("tm-plan");
  if (!box) return;
  const dir = d.recommendation?.directional || {};
  const side = d.setup?.optionType && d.setup.optionType !== "—" ? d.setup.optionType : (d.oiDirection === "UP" ? "CE" : d.oiDirection === "DOWN" ? "PE" : null);
  const sideWord = side === "CE" ? "CALL (Buy on breakout)" : side === "PE" ? "PUT (Buy on breakdown)" : "—";
  const trigger = dir.spotTarget ?? d.plan?.highSpot ?? null;
  const stop = dir.spotStop ?? d.plan?.lowSpot ?? null;
  const support = d.oiSummary?.putWall?.strike, resistance = d.oiSummary?.callWall?.strike;
  const rr = dir.target != null && dir.stop != null && dir.ltp != null && (dir.ltp - dir.stop) > 0
    ? ((dir.target - dir.ltp) / (dir.ltp - dir.stop)).toFixed(1) : null;
  box.innerHTML = `
    <div class="o2-lv"><span>Trade status</span><b class="${dir.take ? "up" : ""}">${dir.take ? "GO" : "WAIT"}</b></div>
    <div class="o2-lv"><span>Preferred side</span><b>${sideWord}</b></div>
    <div class="o2-lv"><span>Entry trigger</span><b>${trigger != null ? fmt(trigger) + " breakout" : "—"}</b></div>
    <div class="o2-lv"><span>Stop loss</span><b class="down">${stop != null ? fmt(stop) : "—"}</b></div>
    <div class="o2-lv"><span>Target(s)</span><b class="up">${dir.target != null ? fmt(dir.target) : "—"}${resistance ? " / " + fmt(resistance) : ""}</b></div>
    <div class="o2-lv"><span>Invalidation</span><b>${support ? "Below " + fmt(support) : "—"}</b></div>
    <div class="o2-lv"><span>Risk/Reward</span><b>${rr ? "1 : " + rr : "—"}</b></div>
    <button type="button" class="tm-alert-btn" id="tm-alert-btn">🔔 Set alert for ${trigger != null ? fmt(trigger) : "breakout"}</button>`;
  const btn = el("tm-alert-btn");
  if (btn && trigger != null) {
    btn.addEventListener("click", () => addTmAlert(sym, trigger, side === "PE" ? "below" : "above"));
  }
}

// A light client-side price-watch: no server persistence, checked on every
// 15s poll while this tab is open. Reuses the same Notification permission /
// beep pattern as the app's existing watchlist alerts (toggleNotify/beep).
async function addTmAlert(symbol, level, dir) {
  try {
    if ("Notification" in window && Notification.permission !== "granted") await Notification.requestPermission();
  } catch (_) { /* ignore */ }
  tmAlerts.push({ symbol, level, dir, label: `${symbol} ${dir === "above" ? "breaks above" : "breaks below"} ${fmt(level)}` });
  const status = el("tm-plan");
  if (status) {
    const note = document.createElement("div");
    note.className = "wl-sub";
    note.style.marginTop = "6px";
    note.textContent = `Alert armed: notifies when ${dir === "above" ? "≥" : "≤"} ${fmt(level)}.`;
    status.appendChild(note);
  }
}
function checkTmAlerts(symbol, spot) {
  if (!tmAlerts.length || spot == null) return;
  for (let i = tmAlerts.length - 1; i >= 0; i--) {
    const a = tmAlerts[i];
    if (a.symbol !== symbol) continue;
    const hit = a.dir === "above" ? spot >= a.level : spot <= a.level;
    if (!hit) continue;
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("Trader Mind alert", { body: a.label }); } catch (_) {}
    try { beep(); } catch (_) {}
    tmAlerts.splice(i, 1);
  }
}

// ---------- volume & big players ----------
async function loadVolume(symbol) {
  const body = el("volume-body");
  try {
    const v = await fetch(`/api/volume/${encodeURIComponent(symbol)}?interval=${state.interval}`).then((r) => r.json());
    if (v.error) { body.textContent = v.error; return; }
    renderVolume(v);
  } catch (e) {
    body.textContent = "Could not load volume analysis: " + e.message;
  }
}

function biasClass(bias) {
  return bias === "Accumulation" ? "up" : bias === "Distribution" ? "down" : "neutral";
}

function renderVolume(v) {
  const vb = el("vol-verdict");
  vb.textContent = v.verdict.bias + " (" + v.verdict.strength + "%)";
  vb.className = "verdict " + biasClass(v.verdict.bias);

  const barClass = (cls) =>
    cls === "Aggressive buying" ? "up" : cls === "Aggressive selling" ? "down" : cls === "Absorption" ? "absorb" : "neutral";

  const bars = (v.notableBars || []).length
    ? v.notableBars
        .map((b) => {
          const t = new Date(b.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
          return `<tr>
            <td class="wl-sub">${t}</td>
            <td><span class="risk-pill ${barClass(b.classification)}">${b.classification}</span></td>
            <td class="num">${b.rvol}x</td>
            <td class="num">${fmt(b.volume, 0)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="wl-sub">No unusual (>=2x) volume bars in the recent window.</td></tr>`;

  const reasons = v.verdict.reasons.map((r) => `<li>${r}</li>`).join("");

  body.innerHTML = `
    <div class="vol-metrics">
      <div class="metric"><span>Relative volume</span><b class="${v.rvol >= 1.5 ? 'up' : ''}">${fmt(v.rvol)}x</b><small>${v.rvolState}</small></div>
      <div class="metric"><span>Avg volume</span><b>${fmt(v.avgVolume, 0)}</b></div>
      <div class="metric"><span>OBV trend</span><b class="${v.obvTrend === 'rising' ? 'up' : v.obvTrend === 'falling' ? 'down' : ''}">${v.obvTrend}</b></div>
      <div class="metric"><span>MFI (14)</span><b>${v.mfi ?? '-'}</b><small>${v.mfiState}</small></div>
      <div class="metric"><span>CMF (20)</span><b class="${v.cmf > 0 ? 'up' : v.cmf < 0 ? 'down' : ''}">${v.cmf ?? '-'}</b><small>${v.cmfState}</small></div>
    </div>
    <div class="vol-grid">
      <div>
        <h4>Why this read</h4>
        <ul class="vol-reasons">${reasons}</ul>
      </div>
      <div>
        <h4>Recent big-volume bars</h4>
        <table class="vol-table"><thead><tr><th>Time</th><th>Type</th><th>RVOL</th><th>Volume</th></tr></thead><tbody>${bars}</tbody></table>
      </div>
    </div>
    <p class="opt-disclaimer">${v.disclaimer}</p>`;
}

// ---------- CALL/PUT price levels (top of chart + lines) ----------
function clearPriceLines() {
  (state.chart.priceLines || []).forEach((pl) => {
    try { candleSeries.removePriceLine(pl); } catch (_) {}
  });
  state.chart.priceLines = [];
}

function renderLevels(sig) {
  const price = sig.price;
  const atr = sig.atr && sig.atr > 0 ? sig.atr : price * 0.004; // fallback ~0.4%
  const dayHigh = sig.dayHigh;
  const dayLow = sig.dayLow;

  // Entry TRIGGERS are the day's high (for CALL breakout) and day's low (for PUT breakdown).
  // Targets project from the breakout by the day's range (fallback to ATR).
  const range = dayHigh != null && dayLow != null ? dayHigh - dayLow : 2.5 * atr;
  const callEntry = dayHigh != null ? dayHigh : price;
  const callTgt = round2(callEntry + Math.max(range * 0.6, 2 * atr));
  const callStop = dayLow != null ? dayLow : round2(price - 1.5 * atr);
  const putEntry = dayLow != null ? dayLow : price;
  const putTgt = round2(putEntry - Math.max(range * 0.6, 2 * atr));
  const putStop = dayHigh != null ? dayHigh : round2(price + 1.5 * atr);

  el("lv-call-entry").textContent = "> " + fmt(callEntry);
  el("lv-call-tgt").textContent = fmt(callTgt);
  el("lv-call-stop").textContent = fmt(callStop);
  el("lv-put-entry").textContent = "< " + fmt(putEntry);
  el("lv-put-tgt").textContent = fmt(putTgt);
  el("lv-put-stop").textContent = fmt(putStop);

  el("lv-call").classList.toggle("fav", sig.score >= 15);
  el("lv-put").classList.toggle("fav", sig.score <= -15);

  // Draw day high/low (the key intraday levels) + projected targets on the chart.
  clearPriceLines();
  const add = (p, color, title, style = 2) => {
    if (p == null) return;
    try {
      state.chart.priceLines.push(
        candleSeries.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })
      );
    } catch (_) {}
  };
  add(dayHigh, "#ea3943", "Day High (CALL >)", 0);
  add(dayLow, "#16c784", "Day Low (PUT <)", 0);
  add(callTgt, "rgba(22,199,132,0.6)", "CALL target");
  add(putTgt, "rgba(234,57,67,0.6)", "PUT target");
}

// ---------- short-term swing movers ----------
async function loadSwing() {
  const box = el("swing");
  const btn = el("load-swing");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Scanning daily charts for early-stage moves...";
  try {
    const data = await fetch("/api/swing").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderSwing(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

function stageClassSwing(stage) {
  if (stage === "Early breakout") return "up";
  if (stage === "Building base") return "squeeze";
  if (stage === "Extended") return "down";
  return "neutral";
}

function renderSwing(data) {
  state.swingData = data;
  // Populate the sector dropdown from the loaded picks (once).
  const sectors = [...new Set((data.picks || []).map((p) => p.sector).filter(Boolean))].sort();
  const sel = el("sw-sector");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' + sectors.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.value = current;
  applySwingFilters();
}

function applySwingFilters() {
  const data = state.swingData;
  if (!data) return;
  const sector = el("sw-sector").value;
  const cap = el("sw-cap").value;
  const minRev = parseFloat(el("sw-minrev").value);
  const minOpp = parseFloat(el("sw-minopp").value);
  let picks = data.picks || [];
  picks = picks.filter((p) => {
    if (sector && p.sector !== sector) return false;
    const f = p.fundamentals;
    if (cap && (!f || f.capCategory !== cap)) return false;
    if (!isNaN(minRev) && (!f || f.revenueGrowthPct == null || f.revenueGrowthPct < minRev)) return false;
    if (!isNaN(minOpp) && p.opportunityScore < minOpp) return false;
    return true;
  });

  // Sort so the best opportunities come first.
  const sortKey = el("sw-sort").value;
  const val = (p) => {
    switch (sortKey) {
      case "week": return p.weekChangePct ?? -999;
      case "volsurge": return p.volSurge ?? 0;
      case "revgrowth": return p.fundamentals && p.fundamentals.revenueGrowthPct != null ? p.fundamentals.revenueGrowthPct : -999;
      case "early": return p.earlyScore ?? 0;
      case "rsi": return p.rsi ?? 0;
      default: return p.opportunityScore ?? 0;
    }
  };
  picks = picks.slice().sort((a, b) => val(b) - val(a));
  renderSwingRows(data, picks);
}

function swingBucket(score) {
  return score >= 60 ? 5 : score >= 45 ? 4 : score >= 30 ? 3 : score >= 15 ? 2 : 1;
}
function shortStage(st) {
  return st === "Early breakout" ? "Early" : st === "Building base" ? "Base" : st === "Extended" ? "Ext" : "—";
}

// Swing-trading HEAT MAP: tiles coloured by opportunity (bright green = top
// priority), extended/chasing-risk names ringed red, ranked by current sort.
function renderSwingRows(data, picks) {
  const box = el("swing");
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }

  const tiles = picks
    .map((p) => {
      const b = swingBucket(p.opportunityScore);
      const ext = p.stage === "Extended" ? " hm-ext" : "";
      const f = p.fundamentals;
      const cap = f && f.capCategory !== "Unknown" ? f.capCategory[0] : "";
      const rev = f && f.revenueGrowthPct != null ? ` · Rev ${f.revenueGrowthPct >= 0 ? "+" : ""}${f.revenueGrowthPct}%` : "";
      const title = `${p.name} (${p.symbol})${p.sector ? " · " + p.sector : ""} · opp ${p.opportunityScore} · ${p.stage}${rev} · ₹${fmt(p.price)}`;
      return `<div class="hm-tile hm-${b}${ext}" data-sym="${p.symbol}" title="${title}">
        <div class="hm-name">${p.name}</div>
        <div class="hm-score">${p.opportunityScore}</div>
        <div class="hm-sub">${p.weekChangePct >= 0 ? "+" : ""}${fmt(p.weekChangePct)}% · ${shortStage(p.stage)}${cap ? " · " + cap : ""}</div>
      </div>`;
    })
    .join("");

  // Ranked trade-plan table: entry trigger, projected move, stop, R:R, F&O.
  const planRows = picks
    .map((p, i) => {
      const opt =
        p.hasOptions === true
          ? '<span class="risk-pill up">F&amp;O ✓</span>'
          : p.hasOptions === false
          ? '<span class="risk-pill">Cash only</span>'
          : '<span class="risk-pill">?</span>';
      const stg = stageClassSwing(p.stage);
      const trig = p.stage === "Building base" ? "on breakout &gt; " : "≈ ";
      return `<tr data-sym="${p.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol}${p.sector ? " · " + p.sector : ""} · ₹${fmt(p.price)}</div></td>
        <td><span class="risk-pill sc-${stg}">${shortStage(p.stage)}</span></td>
        <td class="num">${trig}<b>${fmt(p.entry)}</b></td>
        <td class="num up"><b>+${fmt(p.expectedMovePct)}%</b><div class="wl-sub">→ ₹${fmt(p.target)}</div></td>
        <td class="num down">${fmt(p.stop)}</td>
        <td class="num">${p.riskReward != null ? p.riskReward + ":1" : "-"}</td>
        <td>${opt}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `
    <div class="hm-legend">
      <span class="hm-key hm-5">Top</span>
      <span class="hm-key hm-4">Strong</span>
      <span class="hm-key hm-3">Watch</span>
      <span class="hm-key hm-2">Weak</span>
      <span class="hm-key hm-1">Avoid</span>
      <span class="hm-legend-note">◻ red ring = Extended (already moved, chasing risk) · click a tile/row for full analysis</span>
    </div>
    <div class="heatmap">${tiles}</div>
    <div class="sw-plan-head">
      <h3 class="sw-plan-title">Entry plan · projected move · options</h3>
      <button id="sw-export" class="btn-sm" title="Download the rows below as a CSV (respects current filters &amp; sort)">⭳ Export CSV</button>
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th></th><th>Share</th><th>Stage</th><th>Entry</th><th>Expected move</th><th>Stop</th><th>R:R</th><th>Options</th>
      </tr></thead>
      <tbody>${planRows}</tbody>
    </table>
    <p class="opt-disclaimer">Entry = prior 20-day high (buy on a close above / retest). Expected move &amp; target are ATR-based projections (~2.5× daily ATR), not promises. Stop = recent swing low. ${data.disclaimer}</p>`;
  box.querySelectorAll(".hm-tile").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
  box.querySelectorAll(".sw-plan tbody tr").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
  // Keep the exact rows currently displayed so Export matches what you see.
  state.swingDisplayed = picks;
  const exp = el("sw-export");
  if (exp) exp.addEventListener("click", exportSwingCsv);
}

// Export the currently displayed movers (post-filter/sort) to a CSV file.
function exportSwingCsv() {
  const picks = (state && state.swingDisplayed) || [];
  if (!picks.length) return;
  const cols = [
    ["rank", (p, i) => i + 1],
    ["name", (p) => p.name],
    ["symbol", (p) => p.symbol],
    ["sector", (p) => p.sector || ""],
    ["price", (p) => p.price],
    ["stage", (p) => p.stage],
    ["entry", (p) => p.entry],
    ["stop", (p) => p.stop],
    ["target", (p) => p.target],
    ["expectedMovePct", (p) => p.expectedMovePct],
    ["atrPct", (p) => (p.atrPct == null ? "" : p.atrPct)],
    ["riskReward", (p) => (p.riskReward == null ? "" : p.riskReward)],
    ["weekChangePct", (p) => p.weekChangePct],
    ["monthChangePct", (p) => p.monthChangePct],
    ["volSurge", (p) => p.volSurge],
    ["rsi", (p) => (p.rsi == null ? "" : p.rsi)],
    ["options", (p) => (p.hasOptions === true ? "F&O" : p.hasOptions === false ? "Cash only" : "unknown")],
    ["earlyScore", (p) => p.earlyScore],
    ["opportunityScore", (p) => p.opportunityScore],
    ["revenueGrowthPct", (p) => (p.fundamentals && p.fundamentals.revenueGrowthPct != null ? p.fundamentals.revenueGrowthPct : "")],
    ["note", (p) => (p.note || "").replace(/\s+/g, " ")],
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map((c) => c[0]).join(",");
  const rows = picks.map((p, i) => cols.map((c) => esc(c[1](p, i))).join(","));
  const csv = [header, ...rows].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `short-term-movers-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- long-term positional movers ----------
async function loadLongTerm() {
  const box = el("longterm");
  const btn = el("load-longterm");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Scanning daily charts for long-term trend leaders...";
  try {
    const data = await fetch("/api/longterm").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderLongTerm(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

function ltStageClass(stage) {
  if (stage === "Strong uptrend") return "up";
  if (stage === "Uptrend") return "up";
  if (stage === "Base") return "squeeze";
  if (stage === "Downtrend") return "down";
  return "neutral";
}
function ltShortStage(st) {
  return st === "Strong uptrend" ? "Strong" : st === "Uptrend" ? "Up" : st === "Base" ? "Base" : st === "Downtrend" ? "Down" : "—";
}

function renderLongTerm(data) {
  state.longtermData = data;
  const sectors = [...new Set((data.picks || []).map((p) => p.sector).filter(Boolean))].sort();
  const sel = el("lt-sector");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' + sectors.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.value = current;
  applyLongTermFilters();
}

function applyLongTermFilters() {
  const data = state.longtermData;
  if (!data) return;
  const sector = el("lt-sector").value;
  const stage = el("lt-stage").value;
  const cap = el("lt-cap").value;
  const minRev = parseFloat(el("lt-minrev").value);
  const sortKey = el("lt-sort").value;
  const mbOnly = el("lt-mb") && el("lt-mb").checked;

  let picks = (data.picks || []).filter((p) => {
    const f = p.fundamentals;
    if (sector && p.sector !== sector) return false;
    if (stage && p.stage !== stage) return false;
    if (cap && (!f || f.capCategory !== cap)) return false;
    if (!isNaN(minRev) && (!f || f.revenueGrowthPct == null || f.revenueGrowthPct < minRev)) return false;
    if (mbOnly && !(p.multibagger && p.multibagger.isMultibagger)) return false;
    return true;
  });

  const val = (p) => {
    switch (sortKey) {
      case "ret12m": return p.ret12mPct ?? -999;
      case "ret6m": return p.ret6mPct ?? -999;
      case "ret3m": return p.ret3mPct ?? -999;
      case "multibagger": return p.multibagger ? p.multibagger.multiple : -999;
      case "trend": return p.trendScore ?? 0;
      case "revgrowth": return p.fundamentals && p.fundamentals.revenueGrowthPct != null ? p.fundamentals.revenueGrowthPct : -999;
      case "near52w": return p.distFrom52wHighPct ?? -999; // closest to 0 (highest) first
      default: return p.opportunityScore ?? 0;
    }
  };
  picks = picks.slice().sort((a, b) => val(b) - val(a));
  renderLongTermRows(data, picks);
}

function renderLongTermRows(data, picks) {
  const box = el("longterm");
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }

  const tiles = picks
    .map((p) => {
      const b = swingBucket(p.opportunityScore);
      const dn = p.stage === "Downtrend" ? " hm-ext" : "";
      const f = p.fundamentals;
      const cap = f && f.capCategory !== "Unknown" ? f.capCategory[0] : "";
      const title = `${p.name} (${p.symbol})${p.sector ? " · " + p.sector : ""} · opp ${p.opportunityScore} · ${p.stage} · 12M ${p.ret12mPct >= 0 ? "+" : ""}${p.ret12mPct}% · ₹${fmt(p.price)}`;
      const mb = p.multibagger;
      const mbBadge = mb && mb.isMultibagger ? `<div class="hm-mb">🚀 ${mb.tier} · ${mb.bigMoveFrom}→${mb.bigMoveTo}</div>` : "";
      const mbRing = mb && mb.isMultibagger ? " hm-mb-ring" : "";
      return `<div class="hm-tile hm-${b}${dn}${mbRing}" data-sym="${p.symbol}" title="${title}">
        <div class="hm-name">${p.name}</div>
        <div class="hm-price">₹${fmt(p.price)}</div>
        <div class="hm-score ${p.ret12mPct >= 0 ? "up" : "down"}">${p.ret12mPct >= 0 ? "+" : ""}${fmt(p.ret12mPct)}%</div>
        <div class="hm-sub">12M return · ${ltShortStage(p.stage)}${cap ? " · " + cap : ""}</div>
        ${mbBadge}
      </div>`;
    })
    .join("");

  const planRows = picks
    .map((p, i) => {
      const opt =
        p.hasOptions === true
          ? '<span class="risk-pill up">F&amp;O ✓</span>'
          : p.hasOptions === false
          ? '<span class="risk-pill">Cash only</span>'
          : '<span class="risk-pill">?</span>';
      const stg = ltStageClass(p.stage);
      const rev = p.fundamentals && p.fundamentals.revenueGrowthPct != null ? `${p.fundamentals.revenueGrowthPct >= 0 ? "+" : ""}${p.fundamentals.revenueGrowthPct}%` : "-";
      const mb = p.multibagger;
      const mbCell = mb
        ? `<td class="num ${mb.isMultibagger ? "up" : ""}"><b>${fmt(mb.multiple)}x</b><div class="wl-sub">${mb.cagrPct}% CAGR·${mb.years}y</div></td>
           <td><div>${mb.isMultibagger ? "🚀 " : ""}${fmt(mb.bigMoveX)}x</div><div class="wl-sub">${mb.bigMoveFrom}→${mb.bigMoveTo}</div></td>`
        : `<td class="num">-</td><td class="wl-sub">n/a</td>`;
      return `<tr data-sym="${p.symbol}" class="${mb && mb.isMultibagger ? "mb-row" : ""}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${mb && mb.isMultibagger ? "🚀 " : ""}${p.name}</div><div class="wl-sub">${p.symbol}${p.sector ? " · " + p.sector : ""} · ₹${fmt(p.price)}</div></td>
        <td><span class="risk-pill sc-${stg}">${ltShortStage(p.stage)}</span></td>
        <td class="num ${p.ret12mPct >= 0 ? "up" : "down"}">${p.ret12mPct >= 0 ? "+" : ""}${fmt(p.ret12mPct)}%</td>
        ${mbCell}
        <td class="num">${fmt(p.distFrom52wHighPct)}%</td>
        <td class="num"><b>${fmt(p.entry)}</b></td>
        <td class="num down">${fmt(p.stop)}</td>
        <td class="num up"><b>${fmt(p.target)}</b><div class="wl-sub">+${fmt(p.upsidePct)}%</div></td>
        <td class="num">${rev}</td>
        <td>${opt}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `
    <div class="hm-legend">
      <span class="hm-key hm-5">Leader</span>
      <span class="hm-key hm-4">Strong</span>
      <span class="hm-key hm-3">Watch</span>
      <span class="hm-key hm-2">Weak</span>
      <span class="hm-key hm-1">Avoid</span>
      <span class="hm-legend-note">◻ red ring = Downtrend (below 200-DMA) · click a tile/row for full analysis</span>
    </div>
    <div class="heatmap">${tiles}</div>
    <div class="sw-plan-head">
      <h3 class="sw-plan-title">Positional plan · trend · returns · options</h3>
      <button id="lt-export" class="btn-sm" title="Download the rows below as a CSV (respects current filters &amp; sort)">⭳ Export CSV</button>
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th></th><th>Share</th><th>Stage</th><th>12M</th><th>10Y (mult·CAGR)</th><th>Big move (when)</th><th>From 52wH</th><th>Buy dip</th><th>Stop</th><th>Target</th><th>Rev growth</th><th>Options</th>
      </tr></thead>
      <tbody>${planRows}</tbody>
    </table>
    <p class="opt-disclaimer">🚀 = multibagger (≥2x over its history). "10Y" = total multiple &amp; annualised CAGR over available history (up to 10y, from Yahoo). "Big move (when)" = the largest low→high run and the months it happened. Buy-dip = near the 50-DMA; stop ~6% below the 200-DMA; target = measured move. ${data.disclaimer}</p>`;
  box.querySelectorAll(".hm-tile").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  box.querySelectorAll(".sw-plan tbody tr").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  state.longtermDisplayed = picks;
  const exp = el("lt-export");
  if (exp) exp.addEventListener("click", exportLongTermCsv);
}

function exportLongTermCsv() {
  const picks = (state && state.longtermDisplayed) || [];
  if (!picks.length) return;
  const cols = [
    ["rank", (p, i) => i + 1],
    ["name", (p) => p.name],
    ["symbol", (p) => p.symbol],
    ["sector", (p) => p.sector || ""],
    ["price", (p) => p.price],
    ["stage", (p) => p.stage],
    ["ret1mPct", (p) => p.ret1mPct],
    ["ret3mPct", (p) => p.ret3mPct],
    ["ret6mPct", (p) => p.ret6mPct],
    ["ret12mPct", (p) => p.ret12mPct],
    ["ema50", (p) => p.ema50],
    ["ema200", (p) => p.ema200],
    ["aboveEma200Pct", (p) => p.aboveEma200Pct],
    ["goldenCross", (p) => (p.goldenCross ? "yes" : "no")],
    ["distFrom52wHighPct", (p) => p.distFrom52wHighPct],
    ["rsi", (p) => (p.rsi == null ? "" : p.rsi)],
    ["entry", (p) => p.entry],
    ["stop", (p) => p.stop],
    ["target", (p) => p.target],
    ["upsidePct", (p) => p.upsidePct],
    ["options", (p) => (p.hasOptions === true ? "F&O" : p.hasOptions === false ? "Cash only" : "unknown")],
    ["multibagger", (p) => (p.multibagger && p.multibagger.isMultibagger ? "YES" : "no")],
    ["multiple10Y", (p) => (p.multibagger ? p.multibagger.multiple : "")],
    ["cagrPct", (p) => (p.multibagger ? p.multibagger.cagrPct : "")],
    ["historyYears", (p) => (p.multibagger ? p.multibagger.years : "")],
    ["bigMoveX", (p) => (p.multibagger ? p.multibagger.bigMoveX : "")],
    ["bigMoveFrom", (p) => (p.multibagger ? p.multibagger.bigMoveFrom : "")],
    ["bigMoveTo", (p) => (p.multibagger ? p.multibagger.bigMoveTo : "")],
    ["trendScore", (p) => p.trendScore],
    ["opportunityScore", (p) => p.opportunityScore],
    ["revenueGrowthPct", (p) => (p.fundamentals && p.fundamentals.revenueGrowthPct != null ? p.fundamentals.revenueGrowthPct : "")],
    ["note", (p) => (p.note || "").replace(/\s+/g, " ")],
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map((c) => c[0]).join(",");
  const rows = picks.map((p, i) => cols.map((c) => esc(c[1](p, i))).join(","));
  const csv = [header, ...rows].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `long-term-movers-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- frequent movers (historical big-move frequency) ----------
async function loadFrequent() {
  const box = el("frequent");
  const btn = el("load-frequent");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Analysing ~1 year of daily history for big-move frequency...";
  try {
    const data = await fetch("/api/frequent-movers").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderFrequent(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

// Movement score (0-100) for the selected threshold: how often + how wide.
function fmScore(m, t) {
  const freq = (m.freqPct && m.freqPct[t]) || 0;
  const range = m.avgDailyRangePct || 0;
  return Math.max(0, Math.min(100, Math.round(freq * 1.5 + range * 8)));
}

function renderFrequent(data) {
  state.frequentData = data;
  const sectors = [...new Set((data.movers || []).map((m) => m.sector).filter(Boolean))].sort();
  const sel = el("fm-sector");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' + sectors.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.value = current;
  applyFrequentFilters();
}

function applyFrequentFilters() {
  const data = state.frequentData;
  if (!data) return;
  const t = el("fm-threshold").value;
  const sortKey = el("fm-sort").value;
  const sector = el("fm-sector").value;
  const opt = el("fm-options").value;

  let movers = (data.movers || []).filter((m) => {
    if (sector && m.sector !== sector) return false;
    if (opt === "yes" && m.hasOptions !== true) return false;
    if (opt === "no" && m.hasOptions !== false) return false;
    return true;
  });

  const val = (m) => {
    switch (sortKey) {
      case "range": return m.avgDailyRangePct ?? 0;
      case "avgchg": return m.avgAbsChangePct ?? 0;
      case "max": return m.maxDayMovePct ?? 0;
      case "atr": return m.atrPct ?? 0;
      default: return (m.freqPct && m.freqPct[t]) || 0; // frequency at chosen threshold
    }
  };
  movers = movers.slice().sort((a, b) => val(b) - val(a));
  renderFrequentRows(data, movers, t);
}

function renderFrequentRows(data, movers, t) {
  const box = el("frequent");
  if (!movers.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }

  const tiles = movers
    .map((m) => {
      const score = fmScore(m, t);
      const b = swingBucket(score);
      const freq = (m.freqPct && m.freqPct[t]) || 0;
      const title = `${m.name} (${m.symbol})${m.sector ? " · " + m.sector : ""} · moves ≥${t}% on ${freq}% of days · avg range ${m.avgDailyRangePct}% · ₹${fmt(m.price)}`;
      return `<div class="hm-tile hm-${b}" data-sym="${m.symbol}" title="${title}">
        <div class="hm-name">${m.name}</div>
        <div class="hm-score">${freq}%</div>
        <div class="hm-sub">≥${t}% days · range ${fmt(m.avgDailyRangePct)}%</div>
      </div>`;
    })
    .join("");

  const rows = movers
    .map((m, i) => {
      const freq = (m.freqPct && m.freqPct[t]) || 0;
      const cnt = (m.bigMoveDays && m.bigMoveDays[t]) || 0;
      const opt =
        m.hasOptions === true
          ? '<span class="risk-pill up">F&amp;O ✓</span>'
          : m.hasOptions === false
          ? '<span class="risk-pill">Cash only</span>'
          : '<span class="risk-pill">?</span>';
      return `<tr data-sym="${m.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${m.name}</div><div class="wl-sub">${m.symbol}${m.sector ? " · " + m.sector : ""} · ₹${fmt(m.price)}</div></td>
        <td class="num up"><b>${fmt(freq)}%</b><div class="wl-sub">${cnt}/${m.totalDays} days</div></td>
        <td class="num">${fmt(m.avgDailyRangePct)}%</td>
        <td class="num">${fmt(m.avgAbsChangePct)}%</td>
        <td class="num">${fmt(m.maxDayMovePct)}%</td>
        <td class="num">${m.atrPct == null ? "-" : fmt(m.atrPct) + "%"}</td>
        <td class="num"><b>${fmScore(m, t)}</b></td>
        <td>${opt}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `
    <div class="hm-legend">
      <span class="hm-key hm-5">Very active</span>
      <span class="hm-key hm-4">Active</span>
      <span class="hm-key hm-3">Moderate</span>
      <span class="hm-key hm-2">Calm</span>
      <span class="hm-key hm-1">Quiet</span>
      <span class="hm-legend-note">Big number = % of days it moved ≥${t}% · click a tile/row for full analysis</span>
    </div>
    <div class="heatmap">${tiles}</div>
    <div class="sw-plan-head">
      <h3 class="sw-plan-title">Big-move frequency &amp; volatility ranking (≥${t}% days)</h3>
      <button id="fm-export" class="btn-sm" title="Download the rows below as a CSV (respects current filters &amp; sort)">⭳ Export CSV</button>
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th></th><th>Share</th><th>Freq ≥${t}%</th><th>Avg range</th><th>Avg chg</th><th>Max 1D</th><th>ATR%</th><th>Score</th><th>Options</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">${data.disclaimer}</p>`;
  box.querySelectorAll(".hm-tile").forEach((el2) => el2.addEventListener("click", () => openStock(el2.getAttribute("data-sym"))));
  box.querySelectorAll(".sw-plan tbody tr").forEach((el2) => el2.addEventListener("click", () => openStock(el2.getAttribute("data-sym"))));
  state.frequentDisplayed = movers;
  state.frequentThreshold = t;
  const exp = el("fm-export");
  if (exp) exp.addEventListener("click", exportFrequentCsv);
}

function exportFrequentCsv() {
  const movers = (state && state.frequentDisplayed) || [];
  if (!movers.length) return;
  const t = state.frequentThreshold || "3";
  const cols = [
    ["rank", (m, i) => i + 1],
    ["name", (m) => m.name],
    ["symbol", (m) => m.symbol],
    ["sector", (m) => m.sector || ""],
    ["price", (m) => m.price],
    ["totalDays", (m) => m.totalDays],
    [`freqPct_ge2`, (m) => m.freqPct["2"]],
    [`freqPct_ge3`, (m) => m.freqPct["3"]],
    [`freqPct_ge5`, (m) => m.freqPct["5"]],
    [`bigMoveDays_ge${t}`, (m) => m.bigMoveDays[t]],
    ["avgDailyRangePct", (m) => m.avgDailyRangePct],
    ["avgAbsChangePct", (m) => m.avgAbsChangePct],
    ["maxDayMovePct", (m) => m.maxDayMovePct],
    ["atrPct", (m) => (m.atrPct == null ? "" : m.atrPct)],
    [`movementScore_ge${t}`, (m) => fmScore(m, t)],
    ["options", (m) => (m.hasOptions === true ? "F&O" : m.hasOptions === false ? "Cash only" : "unknown")],
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map((c) => c[0]).join(",");
  const body = movers.map((m, i) => cols.map((c) => esc(c[1](m, i))).join(","));
  const csv = [header, ...body].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `frequent-movers-ge${t}pct-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- daily plan (money-management brain) ----------
async function loadPlan() {
  const box = el("plan");
  const btn = el("load-plan");
  const capital = parseFloat(el("dp-capital").value) || 100000;
  const risk = parseFloat(el("dp-risk").value) || 3;
  const mode = el("dp-mode").value;
  if (btn) { btn.disabled = true; btn.textContent = "Building..."; }
  box.textContent = "Building your daily plan: risk budget, allocation, sized positions...";
  try {
    const data = await fetch(`/api/daily-plan?capital=${capital}&risk=${risk}&mode=${mode}`).then((r) => r.json());
    renderPlan(data);
  } catch (e) {
    box.textContent = "Plan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate Plan"; }
  }
}

function renderPlan(d) {
  const box = el("plan");
  const rupee = (n) => "₹" + fmt(n);
  const rulesHtml = `<ul class="vol-reasons">${(d.rules || []).map((r) => `<li>${r}</li>`).join("")}</ul>`;

  const budgetCard = `
    <div class="predict-idx-grid">
      <div class="predict-idx">
        <div class="predict-idx-name">Risk budget today</div>
        <div class="predict-range">
          <div class="metric"><span>Capital</span><b>${rupee(d.capital)}</b></div>
          <div class="metric"><span>Max loss today (${d.riskPct}%)</span><b class="down">${rupee(d.riskBudget)}</b></div>
          <div class="metric"><span>Book/trim around</span><b class="up">+${rupee(d.dailyTarget)}</b></div>
          <div class="metric"><span>Style</span><b>${d.mode}</b></div>
        </div>
        <div class="predict-range">
          <div class="metric"><span>Options risk bucket</span><b>${rupee(d.optRisk)}</b></div>
          <div class="metric"><span>Swing risk bucket</span><b>${rupee(d.swRisk)}</b></div>
        </div>
      </div>
    </div>`;

  if (d.marketOpen === false) {
    box.innerHTML = `${budgetCard}
      <div class="hc-empty" style="text-align:center;margin-top:12px">🔕 <b>Market is closed.</b><br>${d.message || ""}</div>
      <h3 class="sw-plan-title">Rules for today</h3>${rulesHtml}
      <p class="opt-disclaimer">${d.disclaimer}</p>`;
    return;
  }

  const optRows = (d.options || []).length
    ? (d.options || []).map((o, i) => `<tr data-sym="${o.symbol}">
        <td class="a-rank">#${i + 1}</td>
        <td><div class="a-name">${o.name}</div><div class="wl-sub">${o.symbol}</div></td>
        <td><b>${o.strike} ${o.optionType}</b> <span class="risk-pill ${o.direction === "Bullish" ? "up" : "down"}">${o.direction}</span></td>
        <td class="num"><b>${o.lots} lot</b><div class="wl-sub">${o.qty} qty</div></td>
        <td class="num">${rupee(o.premium)} → <span class="up">${rupee(o.target)}</span></td>
        <td class="num down">${rupee(o.stop)}</td>
        <td class="num">${rupee(o.outlay)}</td>
        <td class="num down">${rupee(o.maxLoss)}</td>
        <td class="num">${o.decayLevel}</td>
      </tr>`).join("")
    : `<tr><td colspan="9" class="wl-sub">No option play passes the safety gates right now — that's fine, skip options today.</td></tr>`;

  const swRows = (d.swing || []).length
    ? (d.swing || []).map((s, i) => `<tr data-sym="${s.symbol}">
        <td class="a-rank">#${i + 1}</td>
        <td><div class="a-name">${s.name}</div><div class="wl-sub">${s.symbol}</div></td>
        <td><span class="risk-pill">${s.stage}</span></td>
        <td class="num"><b>${s.qty} sh</b></td>
        <td class="num">${rupee(s.entry)} → <span class="up">${rupee(s.target)}</span></td>
        <td class="num down">${rupee(s.stop)}</td>
        <td class="num">${rupee(s.outlay)}</td>
        <td class="num down">${rupee(s.maxLoss)}</td>
        <td class="num up">+${fmt(s.expectedMovePct)}%</td>
      </tr>`).join("")
    : `<tr><td colspan="9" class="wl-sub">No early-stage swing setup right now — wait for a cleaner day.</td></tr>`;

  const sc = d.scenarios || {};
  const su = d.summary || {};
  box.innerHTML = `
    ${budgetCard}
    <h3 class="sw-plan-title">🎯 Option trades (bucket ${rupee(d.optRisk)})</h3>
    <table class="alerts-table sw-plan"><thead><tr><th></th><th>Stock</th><th>Option</th><th>Size</th><th>Premium→Tgt</th><th>Stop</th><th>Outlay</th><th>Max loss</th><th>Decay</th></tr></thead><tbody>${optRows}</tbody></table>
    <h3 class="sw-plan-title">📈 Swing equity (bucket ${rupee(d.swRisk)})</h3>
    <table class="alerts-table sw-plan"><thead><tr><th></th><th>Stock</th><th>Stage</th><th>Size</th><th>Entry→Tgt</th><th>Stop</th><th>Outlay</th><th>Max loss</th><th>Exp move</th></tr></thead><tbody>${swRows}</tbody></table>
    <div class="hourly-summary" style="margin-top:12px">
      <b>Plan totals:</b> deployed ${rupee(su.totalDeployed)} · <span class="down">total risk ${rupee(su.totalRiskUsed)}</span> (within budget ${rupee(d.riskBudget)}) · cash idle ${rupee(su.cashIdle)}
    </div>
    <div class="predict-range" style="margin-top:8px">
      <div class="metric"><span>Bad day (all stops)</span><b class="down">${rupee(sc.badDay)}</b></div>
      <div class="metric"><span>Typical day</span><b>~${rupee(sc.typicalDay)}</b></div>
      <div class="metric"><span>Good day (winners hit)</span><b class="up">+${rupee(sc.goodDay)}</b></div>
    </div>
    <h3 class="sw-plan-title">Rules for today</h3>${rulesHtml}
    <p class="opt-disclaimer">${d.disclaimer}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
}

// ---------- day outlook (AI direction + top option plays) ----------
async function loadPredict() {
  const box = el("predict");
  const btn = el("load-predict");
  if (btn) { btn.disabled = true; btn.textContent = "Predicting..."; }
  box.textContent = "Reading NIFTY & Bank Nifty technicals, OI and futures buildup...";
  try {
    const data = await fetch(`/api/day-outlook?interval=${state.interval === "1d" ? "5m" : state.interval}`).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderPredict(data);
  } catch (e) {
    box.textContent = "Prediction failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Predict"; }
  }
}

function dirClass(d) {
  return d === "Bullish" ? "up" : d === "Bearish" ? "down" : "neutral";
}

// Position sizing so a single stop-out never exceeds the user's risk budget.
function sizingHtmlFor(o) {
  const capital = parseFloat((el("pk-capital") || {}).value) || 0;
  const riskPct = parseFloat((el("pk-risk") || {}).value) || 0;
  if (!(capital > 0 && riskPct > 0 && o.lotSize && o.premium && o.premiumStop != null)) return "";
  const lossPerUnit = Math.max(0.05, o.premium - o.premiumStop);
  const lossPerLot = lossPerUnit * o.lotSize;
  const riskBudget = (capital * riskPct) / 100;
  const lots = Math.floor(riskBudget / lossPerLot);
  if (lots < 1) {
    return `<div class="size-bar size-warn">Position size: <b>1 lot risks ₹${fmt(lossPerLot)}</b>, above your ₹${fmt(riskBudget)} budget (${riskPct}% of ₹${fmt(capital)}). Skip this, or raise capital / risk%.</div>`;
  }
  const qty = lots * o.lotSize;
  const cost = o.premium * qty;
  const maxLoss = lossPerLot * lots;
  const todayProfit = Math.max(0, (o.premiumTarget - o.premium)) * qty;
  return `<div class="size-bar size-ok">
    Position size for ₹${fmt(capital)} @ ${riskPct}% risk:
    <b>${lots} lot${lots > 1 ? "s" : ""} = ${qty} qty</b> ·
    outlay ₹${fmt(cost)} ·
    <span class="down">max loss ₹${fmt(maxLoss)}</span> (within ₹${fmt(riskBudget)}) ·
    <span class="up">today target +₹${fmt(todayProfit)}</span>
  </div>`;
}

function renderPredict(data) {
  state.predictData = data;
  const box = el("predict");
  if (data && data.marketOpen === false) {
    box.innerHTML = `<div class="hc-empty" style="text-align:center;font-size:13px">
      🔕 <b>Market is closed.</b><br>${data.message || "Live predictions run only during market hours."}<br>
      <span class="wl-sub">Predictions are generated only on live market data (Mon-Fri, 9:15 AM - 3:30 PM IST) to avoid stale, misleading signals.</span>
    </div>`;
    return;
  }
  const idx = (data.indices || [])
    .map((o) => {
      const cls = dirClass(o.direction);
      const arrow = o.direction === "Bullish" ? "▲" : o.direction === "Bearish" ? "▼" : "—";
      return `
      <div class="predict-idx">
        <div class="predict-idx-head">
          <div>
            <div class="predict-idx-name">${o.name}</div>
            <div class="wl-sub">Spot ₹${fmt(o.spot)} · ATM ${o.atmStrike}${o.straddleImplied != null ? ` · straddle ${fmt(o.straddleImplied)}` : ""}</div>
          </div>
          <div class="predict-dir ${cls}">${arrow} ${o.direction}<div class="predict-conf">${o.confidence}% conf</div></div>
        </div>
        <div class="predict-range">
          <div class="metric"><span>Expected day low</span><b class="down">${fmt(o.lowerBound)}</b></div>
          <div class="metric"><span>Expected move</span><b>±${fmt(o.expectedMovePts)} (${fmt(o.expectedMovePct)}%)</b></div>
          <div class="metric"><span>Expected day high</span><b class="up">${fmt(o.upperBound)}</b></div>
        </div>
        <div class="predict-range">
          <div class="metric"><span>PCR</span><b>${o.pcr ?? "-"}</b></div>
          <div class="metric"><span>Futures</span><b>${o.futBuildup ?? "-"}</b></div>
        </div>
        <ul class="vol-reasons">${(o.reasons || []).map((r) => `<li>${r}</li>`).join("")}</ul>
      </div>`;
    })
    .join("");

  const oppCard = (o, i, showRank) => {
    const cls = dirClass(o.direction);
    const rank = showRank ? (i === 0 ? "★ " : "#" + (i + 1) + " ") : "";
    return `
      <div class="predict-opp ${cls}" data-sym="${o.symbol}">
        <div class="predict-opp-head">
          <div class="predict-opp-title">${rank}${o.name} — <b>${o.strike} ${o.optionType}</b> <span class="risk-pill ${cls}">${o.direction}</span> <span class="risk-pill">Q${o.qualityScore}</span> <span class="risk-pill">${o.confidence}% win-case</span> <span class="risk-pill">R:R ${o.riskReward ?? "-"}:1</span> <span class="risk-pill">risk ${o.maxLossPct}%</span>${
            o.marketAlignment === "Aligned" ? ' <span class="risk-pill up">Index ✓</span>' :
            o.marketAlignment === "Conflict" ? ' <span class="risk-pill down">Index ✗ headwind</span>' :
            o.marketAlignment === "Neutral" ? ' <span class="risk-pill">Index-independent</span>' : ""
          }${o.highProb ? ' <span class="risk-pill up">High-prob algo</span>' : ' <span class="risk-pill">Skip — not high-prob</span>'}${o.marketRef ? ` <span class="wl-sub">vs ${o.marketRef}${o.corrMarket != null ? " corr " + o.corrMarket : ""}</span>` : ""}</div>
          <div class="predict-opp-move up">+${fmt(o.expectedPremiumMovePct)}%<div class="wl-sub">premium potential</div></div>
        </div>
        <div class="predict-range">
          <div class="metric"><span>Strike</span><b>${o.strike} ${o.optionType}</b></div>
          <div class="metric"><span>Buy premium ≈</span><b>₹${fmt(o.premium)}</b></div>
          <div class="metric"><span>Today target</span><b class="up">₹${fmt(o.premiumTarget)} <small>(+${fmt(o.expectedPremiumMovePct)}%)</small></b></div>
          <div class="metric"><span>Stop (lower)</span><b class="down">₹${fmt(o.premiumStop)}</b></div>
        </div>
        <div class="predict-range">
          <div class="metric"><span>Next-day target</span><b class="up">₹${fmt(o.nextDayTarget)} <small>(+${fmt(o.nextDayTargetPct)}%)</small></b></div>
          <div class="metric"><span>Next-day odds</span><b>${o.nextDayProbability ?? "-"}%</b></div>
          <div class="metric"><span>Spot target</span><b class="${cls}">${fmt(o.spotTarget)}</b></div>
          <div class="metric"><span>Delta</span><b>${o.delta ?? "-"}</b></div>
        </div>
        <div class="decay-bar decay-${(o.decayLevel || "Low").toLowerCase()}">
          <b>Theta decay: ${o.decayLevel}</b> · ${o.thetaPctPerDay != null ? o.thetaPctPerDay + "%/day" : "n/a"} · ${o.dte != null ? o.dte + "d to expiry" : "expiry n/a"} — ${o.decayNote || ""}
        </div>
        ${sizingHtmlFor(o)}
        <ul class="vol-reasons">${(o.reasons || []).map((r) => `<li>${r}</li>`).join("")}</ul>
      </div>`;
  };

  const hc = data.highConviction || [];
  const hcHtml = hc.length
    ? `<div class="predict-opp-grid">${hc.map((o, i) => oppCard(o, i, true)).join("")}</div>`
    : `<div class="hc-empty">No play right now clears BOTH the 70%+ win-case bar AND a 20%+ premium swing.
        This is normal when the market is closed or choppy — high-conviction setups are rare and mostly appear
        in a clean trending move during live hours. Forcing a trade here is exactly what loses money.
        The "Top plays" below are the best available by potential, but at lower conviction.</div>`;

  const opps = (data.opportunities || []).length
    ? `<div class="predict-opp-grid">${(data.opportunities || []).map((o, i) => oppCard(o, i, true)).join("")}</div>`
    : `<div class="wl-sub">No option play currently shows a projected 20%+ premium swing with a clear direction. Wait for a cleaner setup.</div>`;

  const best = data.bestPlays || [];
  const bestHtml = best.length
    ? `<div class="predict-opp-grid">${best.map((o, i) => oppCard(o, i, true)).join("")}</div>`
    : `<div class="hc-empty">No play passes the high-probability algo right now (need trend ADX, VWAP + opening-range agreement, OI with the trade, room to S/R, and conviction ≥68). Empty is a valid answer — wait for a clean setup.</div>`;

  box.innerHTML = `
    <h3 class="sw-plan-title">Index direction &amp; expected range</h3>
    <div class="predict-idx-grid">${idx}</div>
    <h3 class="sw-plan-title">High-prob algo — safest directional buys</h3>
    <div class="wl-sub" style="margin-bottom:8px">Only setups that clear the high-probability filter: conviction ≥68, index aligned, OI not against, ADX trend, VWAP + opening-range break, room to OI walls, not exhausted. This is selectivity toward a higher hit-rate — not an 80% guarantee. Q = quality, HP = algo score in reasons.</div>
    ${bestHtml}
    <h3 class="sw-plan-title">🎯 High-conviction subset — 70%+ win-case AND 20%+ premium${hc.length ? ` (${hc.length})` : ""}</h3>
    ${hcHtml}
    <h3 class="sw-plan-title">Top plays by raw potential (any conviction)</h3>
    ${opps}
    <p class="opt-disclaimer">"Win-case %" is directional confidence, not a guaranteed win rate. The high-prob algo only trades when several independent gates agree. No system can promise 80%. Size small and honour the stop. ${data.disclaimer}</p>`;
  box.querySelectorAll(".predict-opp[data-sym]").forEach((n) => n.addEventListener("click", () => openStock(n.getAttribute("data-sym"))));
}

// ---------- monthly swing 20-50% (high risk) ----------
async function loadMonthly() {
  const box = el("monthly");
  const btn = el("load-monthly");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Scanning high-beta stocks for 20-50% monthly-swing setups...";
  try {
    const data = await fetch("/api/monthly-swing").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderMonthly(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

function renderMonthly(data) {
  state.monthlyData = data;
  const sectors = [...new Set((data.picks || []).map((p) => p.sector).filter(Boolean))].sort();
  const sel = el("mo-sector");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' + sectors.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.value = current;
  applyMonthlyFilters();
}

function applyMonthlyFilters() {
  const data = state.monthlyData;
  if (!data) return;
  const sortKey = el("mo-sort").value;
  const sector = el("mo-sector").value;
  const minProb = parseFloat(el("mo-minprob").value);
  const opt = el("mo-options").value;

  let picks = (data.picks || []).filter((p) => {
    if (sector && p.sector !== sector) return false;
    if (!isNaN(minProb) && p.probability < minProb) return false;
    if (opt === "yes" && p.hasOptions !== true) return false;
    if (opt === "no" && p.hasOptions !== false) return false;
    return true;
  });
  const val = (p) => {
    switch (sortKey) {
      case "baseRate20": return p.baseRate20 ?? 0;
      case "rr": return p.riskReward ?? 0;
      case "expmove": return p.expectedMonthlyMovePct ?? 0;
      case "setup": return p.setupScore ?? 0;
      default: return p.probability ?? 0;
    }
  };
  picks = picks.slice().sort((a, b) => val(b) - val(a));
  renderMonthlyRows(data, picks);
}

function moProbBucket(p) {
  return p >= 60 ? 5 : p >= 45 ? 4 : p >= 30 ? 3 : p >= 18 ? 2 : 1;
}

function renderMonthlyRows(data, picks) {
  const box = el("monthly");
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }

  const tiles = picks
    .map((p) => {
      const b = moProbBucket(p.probability);
      const title = `${p.name} (${p.symbol})${p.sector ? " · " + p.sector : ""} · ${p.probability}% odds · target +${p.targetPct}% · hist ${p.baseRate20}% · ₹${fmt(p.price)}`;
      return `<div class="hm-tile hm-${b}" data-sym="${p.symbol}" title="${title}">
        <div class="hm-name">${p.name}</div>
        <div class="hm-price">₹${fmt(p.price)}</div>
        <div class="hm-score">${p.probability}%</div>
        <div class="hm-sub">odds · +${p.targetPct}% tgt · hist ${p.baseRate20}%</div>
      </div>`;
    })
    .join("");

  const rows = picks
    .map((p, i) => {
      const opt = p.hasOptions === true ? '<span class="risk-pill up">F&amp;O ✓</span>' : p.hasOptions === false ? '<span class="risk-pill">Cash only</span>' : '<span class="risk-pill">?</span>';
      const ext = p.monthChangePct > 30 ? ' <span class="risk-pill down">extended</span>' : "";
      return `<tr data-sym="${p.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol}${p.sector ? " · " + p.sector : ""} · ₹${fmt(p.price)}</div></td>
        <td class="num"><b>${p.probability}%</b></td>
        <td class="num">${fmt(p.baseRate20)}%<div class="wl-sub">30:${fmt(p.baseRate30)}% 50:${fmt(p.baseRate50)}%</div></td>
        <td class="num up"><b>+${p.targetPct}%</b><div class="wl-sub">₹${fmt(p.target)}</div></td>
        <td class="num down">-${p.stopPct}%<div class="wl-sub">₹${fmt(p.stop)}</div></td>
        <td class="num">${p.riskReward}:1</td>
        <td class="num">${p.expectedMonthlyMovePct == null ? "-" : "~" + fmt(p.expectedMonthlyMovePct) + "%"}</td>
        <td class="num">${fmt(p.monthChangePct)}%${ext}</td>
        <td>${opt}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `
    <div class="hm-legend">
      <span class="hm-key hm-5">Best odds</span>
      <span class="hm-key hm-4">Good</span>
      <span class="hm-key hm-3">Fair</span>
      <span class="hm-key hm-2">Low</span>
      <span class="hm-key hm-1">Longshot</span>
      <span class="hm-legend-note">Big number = estimated odds of +20% in a month · ALL high risk · click for full analysis</span>
    </div>
    <div class="heatmap">${tiles}</div>
    <div class="sw-plan-head">
      <h3 class="sw-plan-title">20-50% monthly swing plan (HIGH RISK)</h3>
      <button id="mo-export" class="btn-sm">⭳ Export CSV</button>
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th></th><th>Stock</th><th>Odds</th><th>History ≥20%</th><th>Target</th><th>Stop</th><th>R:R</th><th>Exp move</th><th>1M chg</th><th>Options</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">"Odds" blends the stock's own history (how often it gained ≥20% in a 1-month window) with its current setup — an estimate, NOT a guarantee. "History ≥20%" is the raw base rate (with ≥30%/≥50% shown). Targets of 20-50% carry matching downside; always honor the stop and size small. ${data.disclaimer}</p>`;
  box.querySelectorAll(".hm-tile").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  box.querySelectorAll(".sw-plan tbody tr").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  state.monthlyDisplayed = picks;
  const exp = el("mo-export");
  if (exp) exp.addEventListener("click", exportMonthlyCsv);
}

function exportMonthlyCsv() {
  const picks = (state && state.monthlyDisplayed) || [];
  if (!picks.length) return;
  const cols = [
    ["rank", (p, i) => i + 1],
    ["name", (p) => p.name],
    ["symbol", (p) => p.symbol],
    ["sector", (p) => p.sector || ""],
    ["price", (p) => p.price],
    ["probability", (p) => p.probability],
    ["baseRate20", (p) => p.baseRate20],
    ["baseRate30", (p) => p.baseRate30],
    ["baseRate50", (p) => p.baseRate50],
    ["targetPct", (p) => p.targetPct],
    ["target", (p) => p.target],
    ["stopPct", (p) => p.stopPct],
    ["stop", (p) => p.stop],
    ["riskReward", (p) => p.riskReward],
    ["expectedMonthlyMovePct", (p) => p.expectedMonthlyMovePct],
    ["monthChangePct", (p) => p.monthChangePct],
    ["setupScore", (p) => p.setupScore],
    ["rsi", (p) => (p.rsi == null ? "" : p.rsi)],
    ["aboveEma50", (p) => (p.aboveEma50 ? "yes" : "no")],
    ["options", (p) => (p.hasOptions === true ? "F&O" : p.hasOptions === false ? "Cash only" : "unknown")],
    ["note", (p) => (p.note || "").replace(/\s+/g, " ")],
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map((c) => c[0]).join(",");
  const body = picks.map((p, i) => cols.map((c) => esc(c[1](p, i))).join(","));
  const csv = [header, ...body].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `monthly-swing-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- autonomous paper trading ----------
async function loadPaper() {
  try {
    const [s, daily, hindi] = await Promise.all([
      fetch("/api/paper/state").then((r) => r.json()),
      fetch("/api/paper/daily").then((r) => r.json()).catch(() => null),
      fetch("/api/paper/hindi").then((r) => r.json()).catch(() => null),
    ]);
    state.paperDaily = daily; // cached; re-rendered each live tick without re-fetching
    state.paperHindi = hindi;
    renderLive("paper", () => renderPaper(s));
  } catch (e) {
    el("paper").textContent = "Failed to load: " + e.message;
  }
}

// ---------- AI Paper Desk (read-only scaffold screens) ----------
// Each screen fetches its own permission-gated endpoint. A 403 (admin revoked
// the screen) or 401 (session gone) is shown as a clear access message rather
// than a blank panel - the nav already hides tabs the user can't see, so this
// is the defence-in-depth path for a direct navigation / revoked-mid-session.
function aiPerfCards(perf) {
  const pools = (perf && perf.pools) || [];
  const fmt = (v, money) => (v == null ? "—" : money ? "₹" + Number(v).toLocaleString("en-IN") : Number(v).toLocaleString("en-IN"));
  const label = { indexOption: "Index Options", stockOption: "Stock Options", intraday: "Stock Intraday" };
  if (!pools.length) return '<div class="wl-sub">No paper run yet. Start a run from the AI Paper Trading screen to see figures here.</div>';
  return pools.map((p) => `
    <div class="mtg-card aip-card">
      <h5>${label[p.pool] || p.pool}</h5>
      <div class="aip-stat"><span>Equity</span><b>${fmt(p.equity, true)}</b></div>
      <div class="aip-stat"><span>Start capital</span><b>${fmt(p.startCapital, true)}</b></div>
      <div class="aip-stat"><span>Realised P&L</span><b class="${(p.realizedPnl || 0) >= 0 ? "pos" : "neg"}">${fmt(p.realizedPnl, true)}</b></div>
      <div class="aip-stat"><span>Open positions</span><b>${fmt(p.openPositions)}</b></div>
      <div class="aip-stat"><span>Trades</span><b>${fmt(p.trades)}</b></div>
    </div>`).join("");
}

async function loadAiPaperScreen(screen, bodyId, noteId) {
  const body = el(bodyId);
  const note = el(noteId);
  if (!body) return;
  body.innerHTML = '<div class="wl-sub">Loading…</div>';
  let d;
  try {
    // Own timeout so a saturated browser connection pool (many slow background
    // feed calls in flight) surfaces a retry affordance instead of an endless
    // "Loading…". The route itself is instant server-side.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    let r;
    try { r = await fetch("/api/ai-paper/" + screen, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (r.status === 401) { body.innerHTML = '<div class="wl-sub">Session expired — please log in again.</div>'; return; }
    if (r.status === 403) { body.innerHTML = '<div class="wl-sub">You don’t have access to this screen. Ask your administrator to enable it.</div>'; return; }
    d = await r.json();
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    body.innerHTML = `<div class="mtg-card aip-card aip-placeholder"><div class="wl-sub">${aborted ? "Server busy — data feed is under load." : "Failed to load: " + (e.message || e)}</div><button type="button" class="pill-btn" onclick="loadAiPaperScreen('${screen}','${bodyId}','${noteId}')" style="margin-top:10px">Retry</button></div>`;
    return;
  }
  if (note) note.textContent = d.note || "";
  // Screens with real read-only data now: dashboard / performance / review show
  // the paper pools. Analysis / signals / validation are structured placeholders
  // until their deeper analytics are wired in (see the note under each).
  if (d.perf) {
    body.innerHTML = aiPerfCards(d.perf);
  } else {
    const blurb = {
      analysis: "Market structure, regime and directional bias read from the existing analysis engines will appear here.",
      signals: "AI-surfaced signals and insights (observation only) will appear here.",
      validation: "Validation metrics and what the AI is learning from paper results will appear here.",
    }[screen] || "Content will appear here.";
    body.innerHTML = `<div class="mtg-card aip-card aip-placeholder"><div class="wl-sub">${blurb}</div></div>`;
  }
}

// Live premium refresh: mark-to-market every second while the tab is open & market is live.
let paperLiveBusy = false;
let paperLiveTick = 0;
function startPaperLive() {
  if (state.paperTimer) return; // already running
  state.paperTimer = setInterval(async () => {
    const pn = document.getElementById("panel-paper");
    if (!pn || !pn.classList.contains("active")) return;
    if (paperLiveBusy) return;
    paperLiveBusy = true;
    paperLiveTick++;
    try {
      // Refresh the daily P&L review every ~20s (trades close infrequently).
      if (paperLiveTick % 20 === 0) {
        state.paperDaily = await fetch("/api/paper/daily").then((r) => r.json()).catch(() => state.paperDaily);
      }
      if (isMarketOpen()) {
        const s = await fetch("/api/paper/marks").then((r) => r.json()); // live marks + exits
        renderLive("paper", () => renderPaper(s));
      } else if (paperLiveTick % 30 === 0) {
        const s = await fetch("/api/paper/state").then((r) => r.json()); // slow poll when closed
        renderLive("paper", () => renderPaper(s));
      }
    } catch (_) {
      /* ignore transient */
    } finally {
      paperLiveBusy = false;
    }
  }, 1000);
}
async function paperStart() {
  const idx = parseFloat(el("pp-index").value) || 40000;
  const stkOpt = parseFloat(el("pp-stockopt").value) || 40000;
  const intra = parseFloat(el("pp-intraday").value) || 40000;
  const days = parseInt(el("pp-days").value) || 20;
  await fetch(`/api/paper/start?indexCapital=${idx}&stockOptionCapital=${stkOpt}&intradayCapital=${intra}&days=${days}`).then((r) => r.json());
  await loadPaper();
}
async function paperStop() { await fetch("/api/paper/stop").then((r) => r.json()); await loadPaper(); }
// Auto-Trade ON/OFF: flips active without resetting the run (ON starts a default run if none exists).
async function paperToggleAuto() {
  const on = !(state.paperState && state.paperState.active);
  const btn = el("pp-auto");
  if (btn) btn.disabled = true;
  try { await fetch("/api/paper/auto?on=" + on).then((r) => r.json()); await loadPaper(); }
  finally { if (btn) btn.disabled = false; }
}
// Reflect the current auto-trade state on the toggle button.
function renderAutoBtn(active) {
  const st = el("atc-state");
  if (st) { st.textContent = active ? "ON" : "OFF"; st.className = active ? "atc-on" : "atc-off"; }
  const btn = el("pp-auto");
  if (!btn) return;
  btn.classList.toggle("auto-on", !!active);
  btn.classList.toggle("auto-off", !active);
  btn.textContent = active ? "🤖 Auto-Trade: ON" : "🤖 Auto-Trade: OFF";
}
async function paperReset() { if (!confirm("Reset the paper run and clear all trades?")) return; await fetch("/api/paper/reset").then((r) => r.json()); await loadPaper(); }
async function paperTickNow() {
  const btn = el("pp-tick");
  if (btn) { btn.disabled = true; btn.textContent = "Ticking..."; }
  try { await fetch("/api/paper/tick?force=true").then((r) => r.json()); await loadPaper(); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "Run tick now"; } }
}

function istTs(sec) {
  if (!sec) return "-";
  return new Date(sec * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function renderPaper(s) {
  const box = el("paper");
  state.paperState = s; // keep latest for the auto-toggle
  renderAutoBtn(s && s.active);
  const rupee = (n) => "₹" + fmt(n);
  const pnlCls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
  if (!s || (!s.active && !(s.closed && s.closed.length) && !(s.open && s.open.length) && !(s.indexOption && s.indexOption.startCapital))) {
    box.innerHTML = `<div class="wl-sub">No paper run yet. Set capital, then Start. The desk takes directional/scalp trades whenever a win-win setup appears in the NSE session (no 9:20 / lunch / 3pm clocks). Honest costs. Not a zero-loss guarantee.</div>`;
    return;
  }
  state.paperState = s; // cache so the Current/History sub-tab toggle can re-render
  const sub = state.paperSubTab || "current";

  // ---- shared per-row builders ----
  const openRowHtml = (p) => {
    const mark = (p.lastPrice ?? p.entryPrice);
    const unreal = (mark - p.entryPrice) * p.qty;
    const isOpt = p.kind === "indexOption" || p.kind === "stockOption";
    const typeTag = (p.scalp ? "⚡ SCALP " : "") + (p.kind === "indexOption" ? "🎯 IDX OPT" : p.kind === "stockOption" ? "🎯 STK OPT" : "📈 INTRADAY");
    const label = isOpt ? `${p.strike} ${p.optionType} (${p.direction})` : "Equity intraday";
    return `<tr data-sym="${p.symbol}">
        <td>${typeTag}</td>
        <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ${label}${p.winProb != null ? " · win " + p.winProb + "%" : ""}${p.confidence ? " · conf " + p.confidence + "%" : ""}${p.timeframe ? ` · <b>${p.timeframe}</b> ${p.horizon || ""}` : ""}${p.candlePattern ? " · 🕯️ " + p.candlePattern : ""}</div></td>
        <td class="wl-sub">${istTs(p.entryEpoch)}</td>
        <td class="num">${p.qty}</td>
        <td class="num">${rupee(p.entryPrice)}</td>
        <td class="num">${rupee(mark)}</td>
        <td class="num">${isOpt && p.premiumTarget != null ? "<span class='up'>" + rupee(p.premiumTarget) + "</span>" : "-"}<div class="wl-sub">${isOpt && p.premiumStop != null ? "SL " + rupee(p.premiumStop) : ""}</div></td>
        <td class="num">${rupee(p.spotTarget)} / ${rupee(p.spotStop)}</td>
        <td class="num up">${p.potentialPnl != null ? "+" + rupee(p.potentialPnl) : "-"}${p.potentialPct != null ? `<div class="wl-sub">+${fmt(p.potentialPct)}%</div>` : ""}</td>
        <td class="num ${pnlCls(unreal)}">${unreal >= 0 ? "+" : ""}${rupee(unreal)}</td>
      </tr>
      ${p.strikeReason ? `<tr class="remark-row"><td></td><td colspan="9" class="wl-sub" style="padding-top:0">🎯 ${p.strikeReason}</td></tr>` : ""}`;
  };
  const closedRowHtml = (t) => {
    const tIsOpt = t.kind === "indexOption" || t.kind === "stockOption";
    const label = tIsOpt ? `${t.strike} ${t.optionType}` : "Equity intraday";
    return `<tr>
        <td>${t.scalp ? "⚡" : ""}${t.kind === "indexOption" ? "🎯I" : t.kind === "stockOption" ? "🎯S" : "📈"}</td>
        <td><div class="a-name">${t.name}</div><div class="wl-sub">${t.symbol} · ${label}${t.timeframe ? ` · <b>${t.timeframe}</b> ${t.horizon || ""}` : ""}${t.candlePattern ? " · 🕯️ " + t.candlePattern : ""}</div></td>
        <td class="wl-sub">${istTs(t.entryEpoch)}<div>&darr; ${istTs(t.exitEpoch)}</div></td>
        <td class="num">${rupee(t.entryPrice)} → ${rupee(t.exitPrice)}</td>
        <td><span class="risk-pill ${t.pnl >= 0 ? "up" : "down"}">${t.exitReason}</span></td>
        <td class="num">${t.potentialPnl != null ? "+" + rupee(t.potentialPnl) : "-"}</td>
        <td class="num ${pnlCls(t.pnl)}"><b>${t.pnl >= 0 ? "+" : ""}${rupee(t.pnl)}</b><div class="wl-sub">${t.pnlPct >= 0 ? "+" : ""}${fmt(t.pnlPct)}%${t.capturedPct != null ? " · got " + fmt(t.capturedPct) + "% of potential" : ""}${t.costs != null ? " · cost " + rupee(t.costs) : ""}</div></td>
      </tr>
      ${t.remark ? `<tr class="remark-row"><td></td><td colspan="6" class="wl-sub" style="padding-top:0">📝 ${t.remark}</td></tr>` : ""}`;
  };
  const openHead = `<table class="alerts-table sw-plan"><thead><tr><th>Type</th><th>Stock</th><th>Entry time (IST)</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Prem Tgt/SL</th><th>Tgt/Stop (spot)</th><th>Potential</th><th>Unrealised</th></tr></thead><tbody>`;
  const closedHead = `<table class="alerts-table sw-plan"><thead><tr><th>Type</th><th>Stock</th><th>Entry / Exit (IST)</th><th>Entry→Exit price</th><th>Reason</th><th>Potential</th><th>P&L (got)</th></tr></thead><tbody>`;
  const allOpen = s.open || [];
  const allClosed = (s.closed || []).slice().reverse();

  // ---- shared run-status line ----
  const runStatus = `
    <div class="hourly-summary">
      <b>${s.active ? "🟢 RUNNING" : "⛔ STOPPED"}</b> · Day ${s.tradingDaysElapsed}/${s.days} · trades ${s.tradesToday ?? 0} · ⚡ scalps ${s.scalpsToday ?? 0} · win-win anytime
      Total ${rupee(s.totalEquity)} from ${rupee(s.totalStart)} = <b class="${pnlCls(s.totalPnl)}">${s.totalPnl >= 0 ? "+" : ""}${rupee(s.totalPnl)} (${s.totalPnlPct >= 0 ? "+" : ""}${fmt(s.totalPnlPct)}%)</b> · Win ${s.winRate}% (${s.wins}W/${s.losses}L)
    </div>`;

  // ---- Hindi daily review (how it gained + the SPECIFIC loss trades) ----
  const hd = (state.paperHindi && state.paperHindi.days && state.paperHindi.days[0]) || null;
  const hindiCard = hd ? `
    <div class="hindi-review">
      <div class="hindi-title">📋 आज की समीक्षा (${hd.date}) — नेट <b class="${pnlCls(hd.net)}">${hd.net >= 0 ? "+" : ""}${rupee(hd.net)}</b> · ${hd.wins}W / ${hd.losses}L · दिन की दिशा <b class="${hd.dayBias === "Bullish" ? "up" : hd.dayBias === "Bearish" ? "down" : ""}">${hd.dayBias === "Bullish" ? "तेज़ी ▲" : hd.dayBias === "Bearish" ? "मंदी ▼" : "न्यूट्रल"}</b></div>
      <div class="hindi-line hindi-gain">✅ <b>कैसे कमाया:</b> ${hd.gainHindi}</div>
      ${hd.winTrades && hd.winTrades.length ? `<table class="alerts-table sw-plan" style="margin-top:6px"><thead><tr><th>फ़ायदा ट्रेड</th><th>Entry→Exit</th><th>फ़ायदा</th><th>तकनीकी टिप्पणी</th></tr></thead><tbody>${hd.winTrades.map((w) => `<tr><td>${w.scalp ? "⚡ " : ""}<b>${w.symbol}</b> ${w.side}</td><td class="num">${rupee(w.entry)} → ${rupee(w.exit)}</td><td class="num up"><b>+${rupee(w.pnl)}</b><div class="wl-sub">+${fmt(w.pnlPct)}%</div></td><td class="wl-sub">${w.whyHindi}<div style="margin-top:2px">🔧 ${w.techHindi}</div></td></tr>`).join("")}</tbody></table>` : ""}
      <div class="hindi-line hindi-loss">❌ <b>नुकसान (चाहे कुल फ़ायदा हो):</b> ${hd.lossHindi}</div>
      ${hd.lossTrades.length ? `<table class="alerts-table sw-plan" style="margin-top:6px"><thead><tr><th>नुकसान ट्रेड</th><th>Entry→Exit</th><th>नुकसान</th><th>तकनीकी टिप्पणी</th></tr></thead><tbody>${hd.lossTrades.map((l) => `<tr><td>${l.scalp ? "⚡ " : ""}<b>${l.symbol}</b> ${l.side}</td><td class="num">${rupee(l.entry)} → ${rupee(l.exit)}</td><td class="num down"><b>${rupee(l.pnl)}</b><div class="wl-sub">${fmt(l.pnlPct)}%</div></td><td class="wl-sub">${l.whyHindi}<div style="margin-top:2px">🔧 ${l.techHindi}</div></td></tr>`).join("")}</tbody></table>` : ""}
      <div class="hindi-line hindi-lesson">🧠 ${hd.lessonHindi}</div>
    </div>` : "";

  // ---- pool cards + status header (shared) ----
  const poolCard = (title, p) => `
      <div class="predict-idx">
        <div class="predict-idx-head"><div class="predict-idx-name">${title}</div><div class="predict-dir ${pnlCls(p.pnl)}">${p.pnl >= 0 ? "+" : ""}${fmt(p.pnlPct)}%</div></div>
        <div class="predict-range">
          <div class="metric"><span>Start</span><b>${rupee(p.startCapital)}</b></div>
          <div class="metric"><span>Equity</span><b>${rupee(p.equity)}</b></div>
          <div class="metric"><span>Cash</span><b>${rupee(p.cash)}</b></div>
          <div class="metric"><span>P&L</span><b class="${pnlCls(p.pnl)}">${p.pnl >= 0 ? "+" : ""}${rupee(p.pnl)}</b></div>
        </div>
      </div>`;
  const head = `
    <div class="predict-idx-grid">
      ${poolCard("Index options", s.indexOption)}
      ${poolCard("Stock options", s.stockOption)}
      ${poolCard("Stock intraday", s.stockIntraday)}
    </div>
    <div class="hourly-summary" style="margin-top:10px">
      <b>${s.active ? "🟢 RUNNING" : "⛔ STOPPED"}</b> · Day ${s.tradingDaysElapsed}/${s.days} · trades today ${s.tradesToday ?? 0} (no daily cap) · ⚡ scalps ${s.scalpsToday ?? 0} (${s.scalpOpen ?? 0} open) · started ${s.startDate || "-"} ·
      Total ${rupee(s.totalEquity)} from ${rupee(s.totalStart)} = <b class="${pnlCls(s.totalPnl)}">${s.totalPnl >= 0 ? "+" : ""}${rupee(s.totalPnl)} (${s.totalPnlPct >= 0 ? "+" : ""}${fmt(s.totalPnlPct)}%)</b> ·
      Win rate ${s.winRate}% (${s.wins}W/${s.losses}L)
    </div>
    <div class="hourly-summary" style="margin-top:6px">
      🛡️ Capital guard · today ${s.todayRealisedPnl != null ? `<b class="${pnlCls(s.todayRealisedPnl)}">${s.todayRealisedPnl >= 0 ? "+" : ""}${rupee(s.todayRealisedPnl)}</b>` : "-"} ·
      daily loss cap -${s.dailyLossCapPct ?? 3}% · drawdown kill -${s.maxDrawdownPct ?? 10}% ·
      open risk ${s.openRisk != null ? rupee(s.openRisk) : "-"}/${s.heatCapPct ?? 6}% cap · costs paid ${s.totalCosts != null ? rupee(s.totalCosts) : "-"} ·
      ${s.dailyLossCapHit ? '<b class="down">⛔ NEW ENTRIES HALTED (daily loss cap — protecting capital)</b>' : '<b class="up">entries: any moment a win-win setup prints</b>'}
    </div>
    <div class="hourly-summary" style="margin-top:6px">AI desk · calibrated win-prob floor dir ${s.winProbMinDir ?? 52}% / scalp ${s.winProbMinScalp ?? 54}% (capped ~62%, never a fake 90%). Clock windows off. NSE hours still required for realistic fills.</div>`;

  // ---- daily P&L review block (HISTORY) ----
  const dr = state.paperDaily;
  let dailyBlock = "";
  if (dr && dr.days && dr.days.length) {
    const dRows = dr.days
      .map(
        (d) => `<tr>
          <td>${d.date}</td>
          <td class="num">${d.trades}</td>
          <td class="num">${d.wins}W / ${d.losses}L</td>
          <td class="num up">+${rupee(d.grossProfit)}</td>
          <td class="num down">${rupee(d.grossLoss)}</td>
          <td class="num ${pnlCls(d.netPnl)}"><b>${d.netPnl >= 0 ? "+" : ""}${rupee(d.netPnl)}</b></td>
          <td class="num down">${d.worstTrade < 0 ? rupee(d.worstTrade) + (d.worstTradeSymbol ? ` <span class="wl-sub">${d.worstTradeSymbol}</span>` : "") : "-"}</td>
          <td class="num">${fmt(d.winRate)}%</td>
        </tr>`,
      )
      .join("");
    dailyBlock = `
    <h3 class="sw-plan-title">Daily P&L review (${dr.days.length} day${dr.days.length > 1 ? "s" : ""})</h3>
    <div class="hourly-summary" style="margin-bottom:8px">
      Net over all days <b class="${pnlCls(dr.totalNet)}">${dr.totalNet >= 0 ? "+" : ""}${rupee(dr.totalNet)}</b> ·
      Total profit <b class="up">+${rupee(dr.totalProfit)}</b> · Total loss <b class="down">${rupee(dr.totalLoss)}</b> ·
      Loss days <b>${dr.lossDays}</b>${dr.worstDay ? ` · Worst day <b class="down">${dr.worstDay.date} (${rupee(dr.worstDay.netPnl)})</b>` : ""}
    </div>
    <table class="alerts-table sw-plan"><thead><tr><th>Date (IST)</th><th>Trades</th><th>W/L</th><th>Gross profit</th><th>Gross loss</th><th>Net P&L</th><th>Worst trade</th><th>Win rate</th></tr></thead><tbody>${dRows}</tbody></table>
    <p class="wl-sub" style="margin-top:4px">Saved locally to <code>data/paper-daily.csv</code> (per-day), <code>data/paper-trades.csv</code> (every trade), and <code>data/paper-review.csv</code> (day-by-day feedback + Hindi technical comment). <a href="/api/paper/review.csv" download>⬇ Download review (Excel/CSV)</a></p>`;
  }

  // ---- today's trade-check diagnostic + auto-trade log ----
  const checkBlock = renderTradeCheck(s);
  const entryLogBlock = renderEntryLog(s);

  // ================= MANUAL TRADING sub-tab =================
  if (sub === "manual") {
    // Build the form ONCE (so the 1s live refresh doesn't wipe user input); then
    // only refresh the results container each tick.
    if (!el("mt-form")) {
      box.innerHTML = manualFormHtml() + `<div id="mt-results"></div>`;
      initManualForm();
    }
    renderManualResults(s);
    return;
  }

  // ================= HISTORY sub-tab =================
  if (sub === "history") {
    const closedRows = allClosed.length ? allClosed.map(closedRowHtml).join("") : '<tr><td colspan="7" class="wl-sub">अभी तक कोई बंद (closed) ट्रेड नहीं।</td></tr>';
    box.innerHTML = `
      ${runStatus}
      ${hindiCard}
      <h3 class="sw-plan-title">बंद ट्रेड — Closed trades (${allClosed.length})</h3>
      ${closedHead}${closedRows}</tbody></table>
      ${entryLogBlock}
      ${dailyBlock}
      <p class="opt-disclaimer">History: सभी बंद हो चुके ट्रेड + आख़िरी दिन की हिंदी समीक्षा (सबसे ऊपर) + रोज़ का P&L. यह सिर्फ़ SIMULATION है — असली order नहीं.</p>`;
    box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
    return;
  }

  // ================= CURRENT TRADE sub-tab (default) =================
  const openRows = allOpen.length ? allOpen.map(openRowHtml).join("") : '<tr><td colspan="10" class="wl-sub">अभी कोई खुली position नहीं है।</td></tr>';
  box.innerHTML = `
    ${head}
    ${checkBlock}
    <h3 class="sw-plan-title">खुली positions — Open (${allOpen.length}) ${isMarketOpen() ? '<span class="live-dot"></span><span class="wl-sub">live · premium refreshes every 1s</span>' : '<span class="wl-sub">market closed</span>'}</h3>
    ${openHead}${openRows}</tbody></table>
    ${entryLogBlock}
    <p class="opt-disclaimer">Current: अभी खुली positions + आज का <b>ट्रेड-चेक</b> (system ने कब देखा और क्यों trade लिया / नहीं लिया). बंद ट्रेड, रोज़ का हिसाब और आख़िरी दिन की समीक्षा के लिए ऊपर <b>History</b> sub-tab खोलें. Simulation only.</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
}

// ---------- Manual Trading (user-entered trade, system trailing SL, live P&L) ----------
function manualFormHtml() {
  return `
  <div id="mt-form" class="mt-form">
    <div class="mt-form-title">✍️ नया Manual Trade — index/stock, price व comment डालें; system trailing SL लगाकर live P&L दिखाएगा (महीने भर track)।</div>
    <div class="bt-form">
      <label>Stock / Index <select id="mt-symbol"><option value="">लोड हो रहा…</option></select></label>
      <label>Instrument
        <select id="mt-instrument"><option value="option">Option (CE/PE)</option><option value="equity">Equity (cash)</option></select>
      </label>
      <label class="mt-opt">Type <select id="mt-type"><option value="CE">CE (Call)</option><option value="PE">PE (Put)</option></select></label>
      <label class="mt-opt">Expiry <select id="mt-expiry"><option value="">—</option></select></label>
      <label class="mt-opt">Strike <select id="mt-strike"><option value="">—</option></select></label>
      <label class="mt-eq" style="display:none">View
        <select id="mt-direction"><option value="Bullish">Long (Bullish)</option><option value="Bearish">Short (Bearish)</option></select>
      </label>
      <label>Entry ₹ <input type="number" id="mt-entry" step="0.05" placeholder="भाव" /></label>
      <label>Lots <input type="number" id="mt-lots" step="1" min="1" value="1" style="width:70px" /></label>
      <label style="flex:1 1 240px">Comment (trade लेते वक़्त) <input type="text" id="mt-comment" placeholder="जैसे: breakout, support bounce…" /></label>
      <button id="mt-take" class="primary">Take Trade</button>
    </div>
    <div id="mt-status" class="wl-sub" style="margin:4px 0"></div>
  </div>`;
}
async function initManualForm() {
  const sel = el("mt-symbol");
  if (sel) {
    try {
      const d = await fetchJSON("/api/backtest/option/underlyings", 15000);
      sel.innerHTML = (d.underlyings || []).map((u) => `<option value="${u.symbol}" data-type="${u.type}">${u.name}</option>`).join("") || '<option value="">कोई नहीं</option>';
    } catch { sel.innerHTML = '<option value="">लोड नहीं हुआ</option>'; }
  }
  const toggleInstrument = () => {
    const opt = el("mt-instrument").value === "option";
    document.querySelectorAll("#mt-form .mt-opt").forEach((n) => n.style.display = opt ? "" : "none");
    document.querySelectorAll("#mt-form .mt-eq").forEach((n) => n.style.display = opt ? "none" : "");
  };
  if (el("mt-instrument")) el("mt-instrument").addEventListener("change", () => { toggleInstrument(); if (el("mt-instrument").value === "option") manualLoadExpiries(); });
  if (el("mt-symbol")) el("mt-symbol").addEventListener("change", () => { if (el("mt-instrument").value === "option") manualLoadExpiries(); });
  if (el("mt-expiry")) el("mt-expiry").addEventListener("change", manualLoadStrikes);
  if (el("mt-strike")) el("mt-strike").addEventListener("change", manualAutofillPremium);
  if (el("mt-type")) el("mt-type").addEventListener("change", () => { manualLoadStrikes(); });
  if (el("mt-take")) el("mt-take").addEventListener("click", manualTakeTrade);
  toggleInstrument();
  manualLoadExpiries();
}
async function manualLoadExpiries() {
  const sym = el("mt-symbol") && el("mt-symbol").value;
  const ex = el("mt-expiry");
  if (!sym || !ex) return;
  ex.innerHTML = '<option value="">लोड हो रहा…</option>';
  try {
    const d = await fetchJSON("/api/backtest/option/meta?symbol=" + encodeURIComponent(sym), 20000);
    ex.innerHTML = (d.expiries || []).map((e) => `<option value="${e}">${e}</option>`).join("") || '<option value="">कोई expiry नहीं</option>';
    manualLoadStrikes();
  } catch { ex.innerHTML = '<option value="">लोड नहीं हुआ</option>'; }
}
async function manualLoadStrikes() {
  const sym = el("mt-symbol") && el("mt-symbol").value;
  const exp = el("mt-expiry") && el("mt-expiry").value;
  const side = el("mt-type") && el("mt-type").value;
  const st = el("mt-strike");
  if (!sym || !exp || !st) return;
  st.innerHTML = '<option value="">लोड हो रहा…</option>';
  try {
    const d = await fetchJSON(`/api/backtest/option/strikes?symbol=${encodeURIComponent(sym)}&expiry=${encodeURIComponent(exp)}&side=${side}`, 20000);
    const strikes = d.strikes || [];
    st.innerHTML = strikes.map((k) => `<option value="${k}">${k}</option>`).join("") || '<option value="">कोई strike नहीं</option>';
    // Default to the middle (near ATM) strike, then auto-fill premium.
    if (strikes.length) st.selectedIndex = Math.floor(strikes.length / 2);
    manualAutofillPremium();
  } catch { st.innerHTML = '<option value="">लोड नहीं हुआ</option>'; }
}
async function manualAutofillPremium() {
  const sym = el("mt-symbol") && el("mt-symbol").value;
  const strike = el("mt-strike") && el("mt-strike").value;
  const type = el("mt-type") && el("mt-type").value;
  const entry = el("mt-entry");
  if (!sym || !strike || !entry || el("mt-instrument").value !== "option") return;
  try {
    const d = await fetchJSON(`/api/option-projector?symbol=${encodeURIComponent(sym)}&strike=${strike}`, 20000);
    const px = type === "CE" ? (d.current && d.current.ce) : (d.current && d.current.pe);
    if (px != null) entry.value = px; // user can override
  } catch { /* leave blank */ }
}
async function manualTakeTrade() {
  const status = el("mt-status");
  const instrument = el("mt-instrument").value;
  const sym = el("mt-symbol").value;
  const entry = el("mt-entry").value;
  const lots = el("mt-lots").value || "1";
  const comment = el("mt-comment").value || "";
  if (!sym || !entry) { if (status) status.textContent = "symbol व entry price चाहिए।"; return; }
  const q = new URLSearchParams({ symbol: sym, instrument, entry, lots, comment });
  if (instrument === "option") {
    q.set("type", el("mt-type").value);
    q.set("strike", el("mt-strike").value);
    q.set("expiry", el("mt-expiry").value);
    if (!el("mt-strike").value || !el("mt-expiry").value) { if (status) status.textContent = "strike व expiry चुनें।"; return; }
  } else {
    q.set("direction", el("mt-direction").value);
  }
  if (status) status.textContent = "Trade ले रहे…";
  try {
    const r = await fetchJSON("/api/paper/manual/open?" + q.toString(), 25000);
    if (!r.ok) { if (status) status.textContent = r.error || "नहीं लिया जा सका"; return; }
    if (status) status.innerHTML = '<span class="up">✅ Trade ले लिया — नीचे live track हो रहा है।</span>';
    el("mt-comment").value = "";
    await loadPaper();
  } catch (e) { if (status) status.textContent = e.name === "AbortError" ? "timeout" : "Failed: " + e.message; }
}
function renderManualResults(s) {
  const box = el("mt-results");
  if (!box) return;
  const m = (s && s.manual) || { open: [], closed: [], realisedPnl: 0, unrealisedPnl: 0, totalPnl: 0, winRate: 0, wins: 0, losses: 0 };
  const rupee = (n) => "₹" + fmt(n);
  const pnlCls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
  const label = (p) => p.instrument === "option" ? `${p.strike} ${p.optionType} · ${p.expiry || ""}` : (p.direction === "Bullish" ? "Equity Long" : "Equity Short");
  const openRows = (m.open || []).length ? m.open.map((p) => `
    <tr>
      <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ${label(p)}</div></td>
      <td class="wl-sub">${istTs(p.entryEpoch)}</td>
      <td class="num">${p.qty} <div class="wl-sub">${p.lots} lot</div></td>
      <td class="num">${rupee(p.entryPrice)}</td>
      <td class="num">${rupee(p.lastPrice)}</td>
      <td class="num down">${rupee(p.stopPrice)}<div class="wl-sub">trail ${Math.round(p.trailPct * 100)}%</div></td>
      <td class="num ${pnlCls(p.unrealisedPnl)}"><b>${p.unrealisedPnl >= 0 ? "+" : ""}${rupee(p.unrealisedPnl)}</b></td>
      <td><button class="btn-sm mt-close" data-id="${p.id}">Close</button></td>
    </tr>
    ${p.comment ? `<tr class="remark-row"><td colspan="8" class="wl-sub" style="padding-top:0">📝 ${p.comment}</td></tr>` : ""}`).join("") : '<tr><td colspan="8" class="wl-sub">अभी कोई manual trade खुला नहीं।</td></tr>';
  const closedRows = (m.closed || []).length ? m.closed.map((t) => `
    <tr>
      <td><div class="a-name">${t.name}</div><div class="wl-sub">${t.symbol} · ${label(t)}</div></td>
      <td class="wl-sub">${istTs(t.entryEpoch)}<div>&darr; ${istTs(t.exitEpoch)}</div></td>
      <td class="num">${rupee(t.entryPrice)} → ${rupee(t.exitPrice)}</td>
      <td><span class="risk-pill ${t.pnl >= 0 ? "up" : "down"}">${t.exitReason}</span></td>
      <td class="num ${pnlCls(t.pnl)}"><b>${t.pnl >= 0 ? "+" : ""}${rupee(t.pnl)}</b><div class="wl-sub">${t.pnlPct >= 0 ? "+" : ""}${fmt(t.pnlPct)}%</div></td>
    </tr>
    ${t.comment ? `<tr class="remark-row"><td colspan="5" class="wl-sub" style="padding-top:0">📝 ${t.comment}</td></tr>` : ""}`).join("") : '<tr><td colspan="5" class="wl-sub">अभी तक कोई manual trade बंद नहीं हुआ।</td></tr>';
  box.innerHTML = `
    <div class="hourly-summary" style="margin:8px 0">
      <b>Manual Trading</b> · खुले ${m.openCount || 0} · बंद ${m.closedCount || 0} · Win ${m.winRate || 0}% (${m.wins || 0}W/${m.losses || 0}L) ·
      Realised <b class="${pnlCls(m.realisedPnl)}">${m.realisedPnl >= 0 ? "+" : ""}${rupee(m.realisedPnl)}</b> ·
      Unrealised <b class="${pnlCls(m.unrealisedPnl)}">${m.unrealisedPnl >= 0 ? "+" : ""}${rupee(m.unrealisedPnl)}</b> ·
      Total <b class="${pnlCls(m.totalPnl)}">${m.totalPnl >= 0 ? "+" : ""}${rupee(m.totalPnl)}</b>
      ${isMarketOpen() ? '<span class="live-dot"></span><span class="wl-sub">live</span>' : '<span class="wl-sub">market बंद</span>'}
    </div>
    <h3 class="sw-plan-title">खुले Manual trades — System trailing SL (महीने भर hold)</h3>
    <table class="alerts-table sw-plan"><thead><tr><th>Stock</th><th>Entry (IST)</th><th>Qty</th><th>Entry</th><th>Live</th><th>Trailing SL</th><th>P&L</th><th></th></tr></thead><tbody>${openRows}</tbody></table>
    <h3 class="sw-plan-title" style="margin-top:14px">Manual Trading — History (${(m.closed || []).length})</h3>
    <table class="alerts-table sw-plan"><thead><tr><th>Stock</th><th>Entry/Exit</th><th>Entry→Exit</th><th>Reason</th><th>P&L</th></tr></thead><tbody>${closedRows}</tbody></table>
    <p class="opt-disclaimer">Manual Trading: आपका लिया trade — system हर ~सेकंड live भाव पर mark करता है, peak से <b>trailing SL</b> ऊपर खिसकाता है, SL लगने या महीना ख़त्म होने पर बंद करके ऊपर history में <b>comment समेत</b> रखता है. Simulation only.</p>`;
  box.querySelectorAll(".mt-close").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("यह manual trade अभी बंद करें?")) return;
    await fetchJSON("/api/paper/manual/close?id=" + encodeURIComponent(b.getAttribute("data-id")), 15000);
    await loadPaper();
  }));
}

// Today's trade-check diagnostic: WHEN the system last scanned + WHY it did / did
// not take a trade (source-level gate notes + per-idea block reason), plus a short
// log of recent scans. All commentary in Hindi.
function renderTradeCheck(s) {
  const c = s.lastCheck;
  const timeOf = (e) => new Date(e * 1000 + 19800000).toISOString().slice(11, 16);
  if (!c) {
    return `<div class="tc-box"><div class="tc-head">🔎 आज का ट्रेड-चेक</div><div class="wl-sub">अभी तक कोई scan नहीं हुआ। Market खुलने पर system हर ~5 मिनट में trade check करता है (और आप ऊपर "Run tick now" से भी चला सकते हैं)।</div></div>`;
  }
  const headline = c.opened > 0
    ? `<span class="up">✅ ${c.opened} नया trade खुला</span>`
    : c.blocked
      ? `<span class="down">⛔ ${c.blocked}</span>`
      : `<span class="wl-sub">कोई नया trade नहीं</span>`;
  const notes = (c.notes || []).length ? `<ul class="tc-notes">${c.notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : "";
  const ideaRows = (c.ideas || []).map((i) => {
    const ok = String(i.reason).startsWith("OPENED");
    const tag = i.kind === "indexOption" ? "🎯 IDX" : i.kind === "stockOption" ? "🎯 STK" : "📈 EQ";
    return `<tr><td>${tag} <b>${i.symbol}</b>${i.optionType ? " " + i.optionType : ""}</td><td class="num">${i.winProb != null ? i.winProb + "%" : "-"}${i.confidence != null ? `<div class="wl-sub">conf ${i.confidence}</div>` : ""}</td><td class="${ok ? "up" : "down"}">${i.reason}</td></tr>`;
  }).join("");
  const ideaTable = ideaRows
    ? `<table class="tc-tbl"><thead><tr><th>Idea (symbol)</th><th>Win%</th><th>नतीजा / रुकावट</th></tr></thead><tbody>${ideaRows}</tbody></table>`
    : (c.blocked ? "" : `<div class="wl-sub">किसी भी symbol ने entry-condition तक idea नहीं बनाई (signal/OI ने साफ़ दिशा नहीं दी)।</div>`);
  const log = (s.checkLog || []).length > 1
    ? `<details class="tc-log"><summary>पिछले ${Math.min(s.checkLog.length, 20)} scans — समय + नतीजा</summary><ul>${s.checkLog.map((x) => `<li><b>${timeOf(x.at)}</b> — ${x.blocked ? x.blocked : x.opened > 0 ? ("✅ " + x.opened + " खुला") : (x.notes && x.notes.length ? x.notes[0] : "कोई trade नहीं")}</li>`).join("")}</ul></details>`
    : "";
  return `
  <div class="tc-box">
    <div class="tc-head">🔎 आज का ट्रेड-चेक — आख़िरी scan <b>${timeOf(c.at)}</b> बजे (IST) · ${headline}</div>
    <div class="wl-sub" style="margin:2px 0 6px">Market: <b>${c.marketOpen ? "खुला" : "बंद"}</b> · window: <b>${c.window === "session" ? "session (anytime win-win)" : c.window || "-"}</b> · आज के trades: <b>${c.tradesToday}</b></div>
    ${notes}
    ${ideaTable}
    ${log}
  </div>`;
}

// AUTO-TRADE LOG: what logic triggered each auto-trade entry (Hindi one-liner per
// trade). Newest first. Populated whenever the engine opens a position.
function renderEntryLog(s) {
  const rows = s.entryLog || [];
  const tsOf = (e) => { const d = new Date(e * 1000 + 19800000); return d.toISOString().slice(5, 10).replace("-", "/") + " " + d.toISOString().slice(11, 16); };
  if (!rows.length) {
    return `<div class="tc-box" style="border-left-color:#16c784"><div class="tc-head">🧾 ऑटो-ट्रेड लॉग — कौन-सी logic पर trade खुला</div><div class="wl-sub">अभी तक कोई auto-trade नहीं खुला। जब भी engine कोई trade लेगा, यहाँ पूरी वजह (direction, confidence, R:R, timeframe, strike) दर्ज होगी।</div></div>`;
  }
  const list = rows.map((e) => {
    const tag = e.kind === "indexOption" ? "🎯 IDX OPT" : e.kind === "stockOption" ? "🎯 STK OPT" : "📈 INTRADAY";
    const label = e.optionType ? `${e.strike} ${e.optionType}` : "Equity";
    return `<li><b>${tsOf(e.at)}</b> · ${e.scalp ? "⚡ " : ""}${tag} <b>${e.symbol}</b> ${label} — ${e.why}</li>`;
  }).join("");
  return `
  <div class="tc-box" style="border-left-color:#16c784">
    <div class="tc-head">🧾 ऑटो-ट्रेड लॉग — कौन-सी logic पर trade खुला (${rows.length})</div>
    <ul class="tc-notes" style="color:#cbd5e1">${list}</ul>
  </div>`;
}

// ---------- combined swing movers (short-term + frequent + monthly) ----------
async function loadMovers() {
  const box = el("movers");
  const btn = el("load-movers");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Scanning: short-term setup + frequency + monthly odds (one pass)...";
  try {
    const data = await fetch("/api/movers").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderMovers(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

function renderMovers(data) {
  state.moversData = data;
  const sectors = [...new Set((data.picks || []).map((p) => p.sector).filter(Boolean))].sort();
  const sel = el("mv-sector");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' + sectors.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.value = current;
  applyMoversFilters();
}

function applyMoversFilters() {
  const data = state.moversData;
  if (!data) return;
  const sortKey = el("mv-sort").value;
  const stage = el("mv-stage").value;
  const sector = el("mv-sector").value;
  const opt = el("mv-options").value;
  const min = parseFloat(el("mv-min").value);
  let picks = (data.picks || []).filter((p) => {
    if (stage && p.stage !== stage) return false;
    if (sector && p.sector !== sector) return false;
    if (opt === "yes" && p.hasOptions !== true) return false;
    if (opt === "no" && p.hasOptions !== false) return false;
    if (!isNaN(min) && p.combinedScore < min) return false;
    return true;
  });
  const val = (p) => {
    switch (sortKey) {
      case "early": return p.earlyScore ?? 0;
      case "monthly": return p.monthlyProb ?? 0;
      case "freq": return p.freq3 ?? 0;
      case "range": return p.avgDailyRangePct ?? 0;
      case "opportunity": return p.opportunityScore ?? 0;
      default: return p.combinedScore ?? 0;
    }
  };
  picks = picks.slice().sort((a, b) => val(b) - val(a));
  renderMoversRows(data, picks);
}

function mvBucket(s) { return s >= 60 ? 5 : s >= 45 ? 4 : s >= 32 ? 3 : s >= 20 ? 2 : 1; }

function renderMoversRows(data, picks) {
  const box = el("movers");
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }
  const tiles = picks
    .map((p) => {
      const b = mvBucket(p.combinedScore);
      const ext = p.stage === "Extended" ? " hm-ext" : "";
      const title = `${p.name} (${p.symbol}) · combined ${p.combinedScore} · ${p.stage} · monthly ${p.monthlyProb}% · freq≥3% ${p.freq3}% · ₹${fmt(p.price)}`;
      return `<div class="hm-tile hm-${b}${ext}" data-sym="${p.symbol}" title="${title}">
        <div class="hm-name">${p.name}</div>
        <div class="hm-price">₹${fmt(p.price)}</div>
        <div class="hm-score">${p.combinedScore}</div>
        <div class="hm-sub">${shortStage(p.stage)} · M${p.monthlyProb}% · F${p.freq3}%</div>
      </div>`;
    })
    .join("");
  const rows = picks
    .map((p, i) => {
      const opt = p.hasOptions === true ? '<span class="risk-pill up">F&amp;O ✓</span>' : p.hasOptions === false ? '<span class="risk-pill">Cash only</span>' : '<span class="risk-pill">?</span>';
      const stg = stageClassSwing(p.stage);
      const rev = p.fundamentals && p.fundamentals.revenueGrowthPct != null ? `${p.fundamentals.revenueGrowthPct >= 0 ? "+" : ""}${p.fundamentals.revenueGrowthPct}%` : "-";
      return `<tr data-sym="${p.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol}${p.sector ? " · " + p.sector : ""} · ₹${fmt(p.price)}</div></td>
        <td class="num"><b>${p.combinedScore}</b></td>
        <td><span class="risk-pill sc-${stg}">${shortStage(p.stage)}</span><div class="wl-sub">early ${p.earlyScore}</div></td>
        <td class="num">${p.entry != null ? "<b>" + fmt(p.entry) + "</b>" : "-"}<div class="wl-sub">${p.expectedMovePct != null ? "+" + fmt(p.expectedMovePct) + "%→" + fmt(p.stTarget) : ""}</div></td>
        <td class="num">${p.freq3 != null ? fmt(p.freq3) + "%" : "-"}<div class="wl-sub">range ${p.avgDailyRangePct != null ? fmt(p.avgDailyRangePct) + "%" : "-"}</div></td>
        <td class="num up"><b>${p.monthlyProb}%</b><div class="wl-sub">+${p.monthlyTargetPct ?? "-"}% tgt</div></td>
        <td class="num">${p.baseRate20 != null ? fmt(p.baseRate20) + "%" : "-"}</td>
        <td class="num">${rev}</td>
        <td>${opt}</td>
      </tr>`;
    })
    .join("");
  box.innerHTML = `
    <div class="hm-legend">
      <span class="hm-key hm-5">Top</span>
      <span class="hm-key hm-4">Strong</span>
      <span class="hm-key hm-3">Watch</span>
      <span class="hm-key hm-2">Weak</span>
      <span class="hm-key hm-1">Avoid</span>
      <span class="hm-legend-note">◻ red ring = Extended · big number = Combined score · M = monthly odds, F = freq ≥3% · click for full analysis</span>
    </div>
    <div class="heatmap">${tiles}</div>
    <div class="sw-plan-head">
      <h3 class="sw-plan-title">Combined swing plan · setup · frequency · monthly odds</h3>
      <button id="mv-export" class="btn-sm">⭳ Export CSV</button>
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th></th><th>Stock</th><th>Combined</th><th>Stage</th><th>Entry (ST)</th><th>Freq ≥3%</th><th>Monthly odds</th><th>20% base</th><th>Rev growth</th><th>Options</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">Combined = 40% short-term opportunity (incl. fundamentals) + 35% monthly odds + 25% activity/volatility. "Monthly odds" = chance of +20% in a month (from history + setup). "Freq ≥3%" = share of days it moves ≥3%. Estimates, not guarantees — use stops. ${data.disclaimer}</p>`;
  box.querySelectorAll(".hm-tile").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  box.querySelectorAll(".sw-plan tbody tr").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  state.moversDisplayed = picks;
  const exp = el("mv-export");
  if (exp) exp.addEventListener("click", exportMoversCsv);
}

function exportMoversCsv() {
  const picks = (state && state.moversDisplayed) || [];
  if (!picks.length) return;
  const cols = [
    ["rank", (p, i) => i + 1], ["name", (p) => p.name], ["symbol", (p) => p.symbol], ["sector", (p) => p.sector || ""],
    ["price", (p) => p.price], ["combinedScore", (p) => p.combinedScore], ["stage", (p) => p.stage],
    ["earlyScore", (p) => p.earlyScore], ["opportunityScore", (p) => p.opportunityScore],
    ["entry", (p) => p.entry], ["stTarget", (p) => p.stTarget], ["stStop", (p) => p.stStop], ["expectedMovePct", (p) => p.expectedMovePct],
    ["freq3pct", (p) => p.freq3], ["freq5pct", (p) => p.freq5], ["avgDailyRangePct", (p) => p.avgDailyRangePct], ["maxDayMovePct", (p) => p.maxDayMovePct],
    ["monthlyProb", (p) => p.monthlyProb], ["monthlyTargetPct", (p) => p.monthlyTargetPct], ["baseRate20", (p) => p.baseRate20],
    ["atrPct", (p) => p.atrPct], ["rsi", (p) => p.rsi],
    ["revenueGrowthPct", (p) => (p.fundamentals && p.fundamentals.revenueGrowthPct != null ? p.fundamentals.revenueGrowthPct : "")],
    ["options", (p) => (p.hasOptions === true ? "F&O" : p.hasOptions === false ? "Cash only" : "unknown")],
  ];
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.map((c) => c[0]).join(","), ...picks.map((p, i) => cols.map((c) => esc(c[1](p, i))).join(","))].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `swing-movers-${stamp}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- opening play (9:20, OI shift vs prior day) ----------
async function loadOpeningPlay() {
  const box = el("openingplay");
  const btn = el("load-openingplay");
  if (!box) return;
  if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }
  box.textContent = "Comparing today's early OI to the prior session and reading the opening move...";
  try {
    const d = await fetch("/api/opening-play").then((r) => r.json());
    if (d.error) { box.textContent = d.error; return; }
    renderOpeningPlay(d);
  } catch (e) {
    box.textContent = "Failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}

// OPHL signal-strength band -> css class + label
function ophlBandClass(band) {
  if (band === "STRONG TRADE") return "ophl-strong";
  if (band === "GOOD TRADE") return "ophl-good";
  if (band === "WEAK TRADE") return "ophl-weak";
  if (band === "WATCH") return "ophl-watch";
  return "ophl-none";
}
function ophlBar(label, got, max) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (got / max) * 100)) : 0;
  const cls = pct >= 60 ? "up" : pct >= 30 ? "" : "down";
  return `<div class="ophl-comp"><span class="ophl-comp-l">${label}</span>
    <span class="ophl-comp-bar"><i class="${cls}" style="width:${pct}%"></i></span>
    <span class="ophl-comp-v ${cls}">${got}/${max}</span></div>`;
}
function renderOphlCard(o) {
  if (!o) return "";
  const bull = o.direction === "Bullish";
  const dirCls = bull ? "up" : o.direction === "Bearish" ? "down" : "";
  const opt = o.optionType ? `${o.strike} ${o.optionType}` : "no trade (range)";
  const check = (c) => `<li class="${c.ok ? "chk-ok" : "chk-no"}">${c.ok ? "✓" : "✗"} ${c.label}</li>`;
  const risk = o.premium != null && o.stop != null ? `
    <div class="ophl-risk">
      <div class="metric"><span>Entry</span><b>₹${fmt(o.premium)}</b></div>
      <div class="metric"><span>Stop (−25%)</span><b class="down">₹${fmt(o.stop)}</b></div>
      <div class="metric"><span>T1 (1R)</span><b class="up">₹${fmt(o.t1)}</b></div>
      <div class="metric"><span>T2 (2R)</span><b class="up">₹${fmt(o.t2)}</b></div>
      <div class="metric"><span>T3 (3R)</span><b class="up">₹${fmt(o.t3)}</b></div>
    </div>` : "";
  return `
  <div class="ophl-card ${ophlBandClass(o.band)}">
    <div class="ophl-head">
      <div>
        <div class="ophl-title">🎯 OPHL — ${o.name}</div>
        <div class="predict-dir ${dirCls}">${o.direction} · ${opt}</div>
      </div>
      <div class="ophl-score">
        <div class="ophl-score-num">${o.finalScore}</div>
        <div class="ophl-band-tag">${o.band}</div>
      </div>
    </div>
    <div class="ophl-levels">
      <div class="metric"><span>PDH</span><b>${fmt(o.pdh)}</b></div>
      <div class="metric"><span>PDL</span><b>${fmt(o.pdl)}</b></div>
      <div class="metric"><span>Open</span><b>${fmt(o.open)}</b></div>
      <div class="metric"><span>Spot</span><b>${fmt(o.spot)}</b></div>
      <div class="metric"><span>VWAP</span><b>${o.vwap != null ? fmt(o.vwap) : "-"}</b></div>
      <div class="metric"><span>Gap</span><b class="${(o.gapPct || 0) >= 0 ? "up" : "down"}">${o.gapPct != null ? (o.gapPct >= 0 ? "+" : "") + fmt(o.gapPct) + "%" : "-"}</b></div>
    </div>
    <div class="ophl-grid">
      <div class="ophl-col">
        <div class="ophl-sub">Market score <b>${o.marketScore}</b>/100 <span class="wl-sub">(40% weight)</span></div>
        ${o.marketComponents.map((c) => ophlBar(c.label, c.got, c.max)).join("")}
      </div>
      <div class="ophl-col">
        <div class="ophl-sub">Option score <b>${o.optionScore}</b>/100 <span class="wl-sub">(60% weight)</span></div>
        ${o.optionComponents.map((c) => ophlBar(c.label, c.got, c.max)).join("")}
        ${o.premiumSamples < 3 ? `<div class="wl-sub" style="margin-top:4px">⏳ option-breakout arming (${o.premiumSamples} premium sample${o.premiumSamples === 1 ? "" : "s"})</div>` : ""}
      </div>
    </div>
    <div class="ophl-entry">
      <div class="ophl-entry-verdict ${o.entryOk ? "chk-ok" : "chk-no"}">${o.entryOk ? "✅ ENTER — all conditions met" : "⛔ WAIT — conditions not met"}</div>
      <ul class="ophl-check">${o.entryChecklist.map(check).join("")}</ul>
    </div>
    ${risk}
    <ul class="vol-reasons" style="margin-top:6px">${(o.notes || []).map((n) => `<li>${n}</li>`).join("")}</ul>
  </div>`;
}

function renderOpeningPlay(d) {
  const box = el("openingplay");
  const st = el("op-status");
  if (st) {
    const when = new Date((d.generatedAt || Date.now() / 1000) * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    st.innerHTML = `${d.marketOpen ? '<span class="live-dot"></span> LIVE' : "market closed — indicative"} · window ${d.window} · updated ${when}`;
  }
  const picks = d.picks || [];
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No opening play available (option chain not ready). Refresh after 9:15.</div>`; return; }
  const best = d.best;
  const bestOphl = best && best.ophl ? renderOphlCard(best.ophl) : "";
  const rows = picks.map((p) => {
    const o = p.ophl || {};
    return `
    <tr data-sym="${p.symbol}">
      <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol}</div></td>
      <td>${o.direction === "Bullish" ? '<span class="risk-pill up">▲ ' + (o.strike || "") + " CE</span>" : o.direction === "Bearish" ? '<span class="risk-pill down">▼ ' + (o.strike || "") + " PE</span>" : '<span class="risk-pill">◆ range</span>'}</td>
      <td class="num"><b class="${(o.finalScore || 0) >= 75 ? "up" : (o.finalScore || 0) >= 65 ? "" : "down"}">${o.finalScore != null ? o.finalScore : "-"}</b><div class="wl-sub">${o.band || ""}</div></td>
      <td class="num">${o.marketScore != null ? o.marketScore : "-"}</td>
      <td class="num">${o.optionScore != null ? o.optionScore : "-"}</td>
      <td class="num ${(p.gapPct || 0) >= 0 ? "up" : "down"}">${p.gapPct != null ? (p.gapPct >= 0 ? "+" : "") + fmt(p.gapPct) + "%" : "-"}</td>
      <td class="${p.oiShiftBias === "Bullish" ? "up" : p.oiShiftBias === "Bearish" ? "down" : "wl-sub"}">${p.oiShiftBias}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `
    ${bestOphl}
    <h3 class="sw-plan-title">All index OPHL reads</h3>
    <table class="alerts-table sw-plan"><thead><tr><th>Index</th><th>Play</th><th>OPHL score</th><th>Market</th><th>Option</th><th>Gap</th><th>Overnight OI</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="opt-disclaimer">${d.disclaimer || ""}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
}

// ---------- Trader Dashboard (single-symbol OI-change command screen) ----------
async function initOiCommand() {
  const sel = el("oic-symbol");
  if (sel && !sel.dataset.loaded) {
    try {
      const d = await fetchJSON("/api/backtest/option/underlyings", 15000);
      sel.innerHTML = (d.underlyings || []).map((u) => `<option value="${u.symbol}">${u.name}</option>`).join("");
      sel.dataset.loaded = "1";
      sel.addEventListener("change", loadOiCommand);
      if (el("oic-refresh")) el("oic-refresh").addEventListener("click", loadOiCommand);
    } catch { sel.innerHTML = '<option value="^NSEI">NIFTY 50</option>'; }
  }
  // Attach decision log drawer buttons — done every call to ensure buttons are wired
  if (el("oic-log-btn")) el("oic-log-btn").addEventListener("click", () => toggleDecisionLogDrawer());
  if (el("oic-log-close")) el("oic-log-close").addEventListener("click", () => toggleDecisionLogDrawer(false));
  loadOiCommand();
}
async function enableOiPaperAlgo() {
  const st = el("oic-status");
  try {
    const s = await fetch("/api/paper/state").then((r) => r.json());
    if (!s || !(s.indexOption && s.indexOption.startCapital > 0)) {
      if (st) st.textContent = "Pehle Paper Trading tab par Start run karein";
      return;
    }
    await fetch("/api/paper/auto?on=true").then((r) => r.json());
    await fetch("/api/paper/tick?force=true").then((r) => r.json()).catch(() => {});
    if (st) st.textContent = "Paper algo ON — OI directional + OI scalp (no live orders)";
  } catch (e) {
    if (st) st.textContent = "Algo failed: " + ((e && e.message) || e);
  }
}
// ---------- Mobile Trader Dashboard hero (Part 26: a mobile trader DECISION
// screen, not a shrunk desktop one). Hidden on desktop via CSS; built entirely
// from data already fetched elsewhere on this same tab (/api/oi-command's
// recommendation.directional/scalp + setup, /api/liquidity-status for the
// bias/EMA/VWAP/RSI read, /api/quotes for change%, /api/paper/state for the
// one-open-trade rule) - never a second, independent data source, so it can
// never show a different instrument than the desktop view underneath it. ----------
function mthBadge(confidence) {
  const c = confidence || 0;
  if (c >= 75) return "STRONG";
  if (c >= 60) return "GOOD";
  if (c >= 45) return "MODERATE";
  return "WEAK";
}
function mthAction(leg) {
  // Maps the EXISTING OiTradeLeg gate flags onto the four display states the
  // spec asks for. No new logic: take/algoReady are already decided upstream
  // by recommendOiTrades(); an absent leg is reported honestly, never guessed.
  if (!leg || leg.confidence == null) return "DATA UNAVAILABLE";
  if (!leg.optionType || leg.optionType === "—") return "NO EDGE";
  if (!leg.take) return "NO EDGE";
  return leg.algoReady ? "TAKE" : "WAIT";
}
function mthActionClass(action) {
  return action === "TAKE" ? "mth-act-take" : action === "WAIT" ? "mth-act-wait" : "mth-act-avoid";
}

/** One strategy card. `headlineFor` differs per strategy (Directional shows the
 * option side to buy, Setup/Scalp show the direction), everything else is shared. */
function renderMthCard(cfg, leg, symName) {
  leg = leg || {};
  const conf = leg.confidence;
  const action = mthAction(leg);
  const live = leg.optionType && leg.optionType !== "—" && leg.take;
  const headline = cfg.headlineFor(leg, live);
  const sideCls = !live ? "neutral" : leg.optionType === "PE" ? "bearish" : "bullish";
  const reason = (leg.reasons && leg.reasons[0]) || (leg.skipReasons && leg.skipReasons[0]) || "No sufficiently strong setup right now.";
  return `<article class="mth-card ${cfg.colorCls}">
    <div class="mth-card-head">
      <div class="mth-card-title">${cfg.icon} ${cfg.title}<span class="wl-sub">${cfg.subtitle}</span></div>
      <div class="mth-badges">
        <span class="mth-badge">${conf == null ? "—" : mthBadge(conf)}</span>
        <span class="mth-score">${conf == null ? "—" : Math.round(conf) + "/100"}</span>
      </div>
    </div>
    <div class="mth-headline ${sideCls}">${headline}</div>
    ${leg.strike ? `<div class="mth-instrument">${symName} ${fmt(leg.strike, 0)} ${leg.optionType}</div>` : ""}
    <button type="button" class="mth-action ${mthActionClass(action)}">${action}</button>
    <div class="mth-reason">${reason}</div>
    <button type="button" class="mth-details-link" data-mth-details="${cfg.key}">View Details →</button>
  </article>`;
}

const MTH_CARDS = [
  {
    key: "directional", title: "DIRECTIONAL", subtitle: "Higher conviction trade", icon: "🎯", colorCls: "mth-directional",
    headlineFor: (leg, live) => (live ? `BUY ${leg.optionType}` : "WAIT"),
  },
  {
    key: "setup", title: "SETUP", subtitle: "Regular trade opportunity", icon: "📊", colorCls: "mth-setup",
    headlineFor: (leg, live) => (live ? (leg.optionType === "CE" ? "BULLISH" : "BEARISH") : "NEUTRAL"),
  },
  {
    key: "scalp", title: "SCALP", subtitle: "Short-term opportunity", icon: "⚡", colorCls: "mth-scalp",
    headlineFor: (leg, live) => (live ? (leg.optionType === "CE" ? "BULLISH" : "BEARISH") : "NEUTRAL"),
  },
];

async function renderMobileTraderHero(d, sym) {
  const box = el("mobile-th-hero");
  if (!box) return;
  const symName = (el("oic-symbol") && el("oic-symbol").selectedOptions[0] && el("oic-symbol").selectedOptions[0].textContent) || sym;

  // Only extra call is the live quote for the price-change line; everything
  // else comes from the /api/oi-command payload this tab already fetched.
  let quote = null;
  try {
    const q = await fetchJSON("/api/quotes?symbols=" + encodeURIComponent(sym), 8000);
    quote = (q && q.quotes && q.quotes[sym]) || null;
  } catch (_) { /* falls back to d.spot below */ }

  const spot = quote && quote.price != null ? quote.price : d.spot;
  const chgAbs = quote && quote.change != null ? quote.change : null;
  const chgPct = quote ? quote.changePercent : null;
  const chgCls = chgPct > 0 ? "up" : chgPct < 0 ? "down" : "";
  const age = d.dataAgeSec != null ? Math.round(d.dataAgeSec) : null;
  const live = d.refresh?.marketOpen !== false && age != null && age < 60;
  const rec = d.recommendation || {};
  const legs = { directional: rec.directional, setup: d.setup, scalp: rec.scalp };

  const chgText = chgPct == null ? "" :
    `${chgPct >= 0 ? "▲ +" : "▼ "}${chgAbs != null ? fmt(Math.abs(chgAbs)) + " " : ""}(${chgPct >= 0 ? "+" : "-"}${fmt(Math.abs(chgPct))}%)`;

  box.innerHTML = `
    <div class="mth-brand">MarketPil<span>Option Trading</span></div>
    <div class="mth-symbol-row"><span class="mth-symbol">${symName}</span>
      ${age != null ? `<span class="mth-updated">${live ? '<span class="live-dot"></span> ' : ""}${age}s ago</span>` : ""}</div>
    <div class="mth-spot">${spot != null ? fmt(spot) : "—"}</div>
    ${chgText ? `<div class="mth-chg ${chgCls}">${chgText}</div>` : ""}
    ${MTH_CARDS.map((cfg) => renderMthCard(cfg, legs[cfg.key], symName)).join("")}
  `;

  // "View Details" reveals the existing full desktop analysis already rendered
  // in #oicommand below - no second detail view, nothing new computed.
  box.querySelectorAll("[data-mth-details]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.body.classList.add("mth-details-open");
      const target = el("oicommand");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// ---------- Horizontal NIFTY command terminal (presentation only) ----------
// Reuses existing engines/data only: /api/oi-command (Master Trade Selector
// ext.arbitration, OI walls, expectedMove projection, recommendation/best
// option, spot, freshness) + /api/liquidity-status (score, stage, bias,
// VWAP/EMA/RSI structure, RVOL, confirmations, trigger/invalidation) + a light
// /api/quotes for change%. No trading decision is computed here - every value
// is read straight from those payloads and only laid out.
const NT_STAGE = { QUIET: "q", BUILDING: "b", "BREAKOUT WATCH": "bw", "EARLY MOVE": "em", DEVELOPING: "dv", "STRONG MOVE": "sm", EXTENDED: "ex", "REVERSAL WATCH": "rw" };
function ntStageFromLs(ls) {
  // Same mapping the backend watchlist scanner uses, for display parity.
  const ms = ls.moveStage, act = ls.traderAction, score = ls.liquidityFlowScore?.score ?? 0;
  if (ms === "EXTENDED") return "EXTENDED";
  if (ms === "EXHAUSTION" || ms === "REVERSAL_WATCH") return "REVERSAL WATCH";
  if (ms === "STRONG_MOVE") return "STRONG MOVE";
  if (act === "WAIT FOR BREAKOUT" || act === "WAIT FOR BREAKDOWN") return "BREAKOUT WATCH";
  if (ms === "DEVELOPING") return "DEVELOPING";
  if (ms === "EARLY_MOVE") return "EARLY MOVE";
  if (ms === "PULLBACK") return "BUILDING";
  return score >= 25 ? "BUILDING" : "QUIET";
}
function ntDot(state) { return `<span class="nt-dot nt-dot-${state}"></span>`; }
function ntMeter(score) {
  const s = Math.max(0, Math.min(100, Math.round(score || 0)));
  const cls = s >= 66 ? "hi" : s >= 40 ? "mid" : "lo";
  return `<span class="nt-meter"><span class="nt-meter-fill nt-meter-${cls}" style="width:${s}%"></span></span>`;
}
function ntRow(name, icon, valTxt, stateCls) {
  return `<div class="nt-flow-row"><span class="nt-flow-n">${name}</span><span class="nt-flow-v ${stateCls || ""}">${icon} ${valTxt}</span></div>`;
}
function ntNum(n, dp = 0) { return (n == null || isNaN(n)) ? "—" : fmt(n, dp); }

async function renderNiftyTerminal(d, sym) {
  const box = el("nifty-terminal");
  if (!box) return;
  // Pull the liquidity-status engine + a quote in parallel; both degrade to
  // "DATA UNAVAILABLE" cells rather than blocking the oi-command-derived cells.
  let ls = null, quote = null;
  try { ls = await fetchJSON("/api/liquidity-status/" + encodeURIComponent(sym), 15000); if (ls && ls.error) ls = null; } catch (_) {}
  try { const q = await fetchJSON("/api/quotes?symbols=" + encodeURIComponent(sym), 8000); quote = (q && q.quotes && q.quotes[sym]) || null; } catch (_) {}

  const name = d.name || sym;
  const spot = d.spot != null ? d.spot : (ls && ls.spot);
  const chgPct = quote ? quote.changePercent : null;
  const chgAbs = quote ? quote.change : null;
  const chgCls = chgPct > 0 ? "up" : chgPct < 0 ? "down" : "neu";
  const age = d.dataAgeSec != null ? Math.round(d.dataAgeSec) : null;
  const marketOpen = d.refresh?.marketOpen !== false;
  const stale = !!d.stale && marketOpen || (ls && (ls.freshness?.oiStale || ls.freshness?.liveFeedStale));
  const ageTxt = age == null ? "—" : age < 90 ? age + "s" : age < 3600 ? Math.round(age / 60) + "m" : age < 86400 ? Math.round(age / 3600) + "h" : Math.round(age / 86400) + "d";
  const freshTxt = age == null ? "DATA —" : !marketOpen ? `MARKET CLOSED · ${ageTxt}` : stale ? `⚠ STALE ${ageTxt}` : `● LIVE ${ageTxt}`;
  const freshCls = age == null ? "na" : stale ? "warn" : "ok";

  // --- header facts (from ls; graceful when ls missing) ---
  const score = ls ? (ls.liquidityFlowScore?.score ?? 0) : null;
  const quality = ls ? ls.directionalConfidence?.quality : null;
  const bias = ls ? ls.directionBias : (d.oiDirection === "UP" ? "Bullish" : d.oiDirection === "DOWN" ? "Bearish" : "Neutral");
  const biasArrow = bias === "Bullish" ? "▲ UP" : bias === "Bearish" ? "▼ DOWN" : bias === "Conflict" ? "⚠ CONFLICT" : "• FLAT";
  const biasCls = bias === "Bullish" ? "up" : bias === "Bearish" ? "down" : "neu";
  const stage = ls ? ntStageFromLs(ls) : "—";
  const scoreDot = score == null ? "na" : score >= 66 ? "ok" : score >= 40 ? "warn" : "lo";

  // --- market flow (ls structure + rvol; OI from oi-command) ---
  const st = ls && ls.structure;
  const oiDir = d.oiDirection; // existing OI interpretation - not recomputed
  const oiTxt = oiDir === "UP" ? "↑ Bullish" : oiDir === "DOWN" ? "↓ Bearish" : "• Flat";
  const oiCls = oiDir === "UP" ? "up" : oiDir === "DOWN" ? "down" : "neu";
  const rvol = ls ? ls.rvol : null;
  const volTxt = rvol == null ? "—" : rvol >= 2 ? "↑ Strong" : rvol >= 1.3 ? "↑ Good" : rvol >= 0.7 ? "• Normal" : "↓ Weak";
  const volCls = rvol == null ? "neu" : rvol >= 1.3 ? "up" : rvol < 0.7 ? "down" : "neu";
  const rsi = st ? st.rsi : null;
  const momTxt = rsi == null ? "—" : rsi >= 55 ? "↑ Positive" : rsi <= 45 ? "↓ Negative" : "• Neutral";
  const momCls = rsi == null ? "neu" : rsi >= 55 ? "up" : rsi <= 45 ? "down" : "neu";
  const vwapUp = st && st.vwapStatus && st.vwapStatus.indexOf("Above") === 0;
  const vwapDn = st && st.vwapStatus && st.vwapStatus.indexOf("Below") === 0;
  const vwapTxt = !st ? "—" : vwapUp ? "✓ Above" : vwapDn ? "✕ Below" : "• Choppy";
  const emaTxt = !st ? "—" : st.emaStructure === "Strong Bullish" ? "✓ 9>21>50" : st.emaStructure === "Strong Bearish" ? "✕ 9<21<50" : "• Mixed";
  const emaCls = !st ? "neu" : st.emaStructure === "Strong Bullish" ? "up" : st.emaStructure === "Strong Bearish" ? "down" : "neu";

  // --- structure (ls key levels + distances) ---
  const kl = ls && ls.keyLevels ? ls.keyLevels : [];
  const sup = kl.find((l) => l.label === "KEY SUPPORT");
  const res = kl.find((l) => l.label === "KEY RESISTANCE");
  const dSup = ls ? ls.distanceToSupportPts : null;
  const dRes = ls ? ls.distanceToResistancePts : null;

  // --- liquidity walls (existing OI-wall calc, oi-command) ---
  const W = d.walls;
  const putWall = W && W.bestS ? W.bestS.strike : (sup ? sup.price : null);
  const callWall = W && W.bestR ? W.bestR.strike : (res ? res.price : null);
  const wallRoom = (putWall != null && callWall != null) ? Math.round(callWall - putWall) : null;
  const roomToOpp = bias === "Bearish"
    ? (putWall != null && spot != null ? Math.round(spot - putWall) : null)
    : (callWall != null && spot != null ? Math.round(callWall - spot) : null);
  const wallsAvail = putWall != null || callWall != null;

  // --- point projection (existing expectedMove; NEVER fabricated) ---
  const em = d.expectedMove; // { low, high, dir } in points, or absent
  let projHtml;
  if (em && (em.low != null || em.high != null) && em.dir) {
    const lo = Math.round(Math.abs(em.low)), hi = Math.round(Math.abs(em.high));
    const sign = em.dir < 0 ? "−" : "+";
    const pxLo = spot != null ? ntNum(spot + em.dir * Math.abs(em.low), 0) : "—";
    const pxHi = spot != null ? ntNum(spot + em.dir * Math.abs(em.high), 0) : "—";
    const conf = score != null ? score + "%" : "—";
    projHtml = `<div class="nt-proj-row"><span>Expected move</span><b>${sign}${lo} → ${sign}${hi} pts</b></div>
      <div class="nt-proj-row"><span>Expected price</span><b>${pxLo} → ${pxHi}</b></div>
      <div class="nt-proj-row"><span>Direction</span><b class="${biasCls}">${biasArrow}</b></div>
      <div class="nt-proj-row"><span>Confidence</span><b>${conf}</b></div>`;
  } else {
    projHtml = `<div class="nt-na">NO EDGE · LOW CONFIDENCE<div class="wl-sub">Not enough evidence to project a range.</div></div>`;
  }

  // --- confirmation matrix (ls confirmations) ---
  let confHtml;
  if (ls && ls.confirmations) {
    const items = [...ls.confirmations.confirmed.map((c) => ({ label: c.label, ok: true })),
                   ...ls.confirmations.remaining.map((c) => ({ label: c.label, ok: false }))];
    confHtml = items.slice(0, 7).map((it) => `<div class="nt-cf-row"><span>${it.label}</span><b class="${it.ok ? "ok" : "pend"}">${it.ok ? "✓" : "⏳"}</b></div>`).join("");
  } else {
    confHtml = `<div class="nt-na">DATA UNAVAILABLE</div>`;
  }

  // --- master action (EXISTING Master Trade Selector verdict, unchanged) ---
  const arb = d.ext && d.ext.arbitration;
  const masterWord = arb ? arb.verdict : (ls ? String(ls.traderAction) : "WAIT");
  const masterReason = arb ? (arb.reason || "") : (ls ? ls.traderActionDetail : "");
  const mCls = /GO|TAKE|PREPARE/i.test(masterWord) ? "go" : /CONFLICT|AVOID|INVALID/i.test(masterWord) ? "avoid" : "wait";
  const trigger = ls && ls.trigger ? ls.trigger.level : null;
  const inval = ls && ls.invalidation ? ls.invalidation.level : null;
  const nextLevel = bias === "Bearish" ? (sup ? sup.price : null) : (res ? res.price : null);

  // --- best option play (existing recommendation leg; guardrails preserved) ---
  const leg = (d.recommendation && d.recommendation.directional) || d.setup || null;
  const legLive = leg && leg.optionType && leg.optionType !== "—" && leg.take;
  const premChg = leg && leg.optionType === "PE" ? d.putLtpChgPct : d.callLtpChgPct;
  let optHtml;
  if (leg && leg.optionType && leg.optionType !== "—") {
    optHtml = `<div class="nt-opt-head">${leg.strike ? ntNum(leg.strike, 0) + " " + leg.optionType : leg.optionType}</div>
      <div class="nt-opt-facts">
        <span>Premium <b>${leg.ltp != null ? "₹" + ntNum(leg.ltp, 2) : "—"}</b></span>
        <span>Prem mom <b class="${premChg > 0 ? "up" : premChg < 0 ? "down" : "neu"}">${premChg == null ? "—" : (premChg > 0 ? "↑" : premChg < 0 ? "↓" : "•")}</b></span>
        <span>OI <b class="${oiCls}">${oiTxt}</b></span>
      </div>
      <div class="nt-opt-status ${legLive ? "ok" : "pend"}">${legLive ? "OPTION CONFIRMED" : "PREMIUM CONFIRMATION PENDING"}</div>`;
  } else {
    optHtml = `<div class="nt-na">NO OPTION EDGE</div>`;
  }

  // --- visual projection bar (support | spot | trigger | resistance) ---
  const barLo = sup ? sup.price : putWall;
  const barHi = res ? res.price : callWall;
  let barHtml = "";
  if (barLo != null && barHi != null && spot != null && barHi > barLo) {
    const pct = (v) => Math.max(0, Math.min(100, ((v - barLo) / (barHi - barLo)) * 100));
    const trigMark = trigger != null && trigger >= barLo && trigger <= barHi ? `<span class="nt-bar-mark nt-bar-trig" style="left:${pct(trigger)}%" title="Trigger ${ntNum(trigger)}"></span>` : "";
    barHtml = `<div class="nt-bar">
      <span class="nt-bar-track"></span>
      <span class="nt-bar-mark nt-bar-spot" style="left:${pct(spot)}%" title="Spot ${ntNum(spot)}"></span>
      ${trigMark}
      <span class="nt-bar-lbl nt-bar-l">S ${ntNum(barLo)}</span>
      <span class="nt-bar-lbl nt-bar-r">R ${ntNum(barHi)}</span>
    </div>`;
  }

  const headerStageCls = stage === "—" ? "q" : (NT_STAGE[stage] || "q");
  box.className = "nterm nterm-" + headerStageCls;
  box.innerHTML = `
    <div class="nt-head">
      <span class="nt-sym">${name}</span>
      <span class="nt-spot">${ntNum(spot, spot != null && spot < 1000 ? 2 : 0)}</span>
      ${chgPct != null ? `<span class="nt-chg ${chgCls}">${chgPct >= 0 ? "▲ +" : "▼ "}${chgAbs != null ? ntNum(Math.abs(chgAbs), 0) + " " : ""}(${chgPct >= 0 ? "+" : "-"}${fmt(Math.abs(chgPct))}%)</span>` : ""}
      <span class="nt-hsep"></span>
      <span class="nt-h-item">${ntDot(freshCls)} <b class="nt-fresh nt-fresh-${freshCls}">${freshTxt}</b></span>
      <span class="nt-h-item">LIQUIDITY <b>${score == null ? "—" : score}</b> ${score == null ? "" : ntMeter(score)} ${ntDot(scoreDot)}</span>
      <span class="nt-h-item">TREND <b class="${biasCls}">${biasArrow}</b></span>
      <span class="nt-h-item">STAGE <b class="nt-stage nt-stage-${headerStageCls}">${stage}</b></span>
      ${quality ? `<span class="nt-h-item">SIGNAL <b>${quality}</b></span>` : ""}
    </div>
    <div class="nt-cols">
      <div class="nt-col">
        <div class="nt-col-h">MARKET FLOW</div>
        ${ntRow("OI", "", oiTxt, oiCls)}
        ${ntRow("Volume", "", volTxt, volCls)}
        ${ntRow("Momentum", rsi != null ? "RSI " + Math.round(rsi) : "", momTxt, momCls)}
        ${ntRow("VWAP", "", vwapTxt, vwapUp ? "up" : vwapDn ? "down" : "neu")}
        ${ntRow("EMA 9/21", "", emaTxt, emaCls)}
      </div>
      <div class="nt-col">
        <div class="nt-col-h">STRUCTURE</div>
        <div class="nt-struct">
          <div class="nt-st-row nt-st-r"><span>R</span><b>${res ? ntNum(res.price) : "—"}</b><i>${dRes != null ? "+" + Math.abs(Math.round(dRes)) + " pts" : ""}</i></div>
          <div class="nt-st-row nt-st-spot"><span>SPOT</span><b>${ntNum(spot)}</b><i>●</i></div>
          <div class="nt-st-row nt-st-s"><span>S</span><b>${sup ? ntNum(sup.price) : "—"}</b><i>${dSup != null ? "−" + Math.abs(Math.round(dSup)) + " pts" : ""}</i></div>
        </div>
        ${barHtml}
      </div>
      <div class="nt-col">
        <div class="nt-col-h">LIQUIDITY WALLS</div>
        ${wallsAvail ? `
          ${ntRow("PUT wall", "", putWall != null ? ntNum(putWall) : "—", "up")}
          ${ntRow("CALL wall", "", callWall != null ? ntNum(callWall) : "—", "down")}
          ${ntRow("Between", "", wallRoom != null ? wallRoom + " pts" : "—", "neu")}
          ${ntRow("Room→opp", "", roomToOpp != null ? roomToOpp + " pts" : "—", "neu")}
        ` : `<div class="nt-na">WALL DATA UNAVAILABLE</div>`}
      </div>
      <div class="nt-col">
        <div class="nt-col-h">POINT PROJECTION</div>
        ${projHtml}
      </div>
      <div class="nt-col">
        <div class="nt-col-h">CONFIRMATION</div>
        ${confHtml}
      </div>
      <div class="nt-col nt-col-opt">
        <div class="nt-col-h">BEST OPTION PLAY</div>
        ${optHtml}
      </div>
    </div>
    <div class="nt-foot">
      <span class="nt-foot-item">TRIGGER <b>${trigger != null ? "> " + ntNum(trigger) : "—"}</b></span>
      <span class="nt-foot-item">INVALIDATION <b>${inval != null ? "< " + ntNum(inval) : "—"}</b></span>
      <span class="nt-foot-item">NEXT LEVEL <b>${nextLevel != null ? ntNum(nextLevel) : "—"}</b></span>
      <span class="nt-foot-master nt-master-${mCls}">MASTER ACTION: <b>${masterWord}</b>${masterReason ? ` <i>${masterReason}</i>` : ""}</span>
    </div>`;
}

// ==================== DECISION FLOW DESK ====================
// A guided sequence over the EXISTING engines - no new scoring/trading logic.
// One fetch of /api/oi-command (Master Trade Selector, walls, expectedMove,
// recommendation), /api/liquidity-status (score/stage/bias/structure/
// confirmations/trigger/invalidation), /api/watchlist/scan (ranked scanner),
// /api/paper/state (open/closed positions) and /api/quotes (change%) powers all
// screens. Everything is read-only and degrades to "—"/DATA UNAVAILABLE.
const DF_STEPS = [
  { n: 1, t: "Market Command", s: "Is today worth trading?" },
  { n: 2, t: "Market Map", s: "Where can it move?" },
  { n: 3, t: "Watchlist", s: "Best opportunity?" },
  { n: 4, t: "Trader Mind", s: "Why is it a setup?" },
  { n: 5, t: "Setup Decision", s: "Trade now?" },
  { n: 6, t: "Best Option", s: "Which contract?" },
  { n: 7, t: "Confirmation", s: "All conditions met?" },
  { n: 8, t: "Execution", s: "Place the trade" },
  { n: 9, t: "Live Position", s: "Hold or exit?" },
  { n: 10, t: "Journal", s: "What happened?" },
  { n: 11, t: "Daily Review", s: "How did the day go?" },
  { n: 12, t: "20-Session", s: "Is the edge real?" },
  { n: 13, t: "OI Details", s: "Where is the open interest?" },
];
// All F&O indices selectable via the flow's header filter.
const DF_INDICES = [
  { sym: "^NSEI", label: "NIFTY 50" },
  { sym: "^NSEBANK", label: "NIFTY BANK" },
  { sym: "^CNXFIN", label: "FIN NIFTY" },
  { sym: "^NSEMDCP50", label: "MIDCAP NIFTY" },
];
state.df = state.df || { step: 1, data: null, loading: false, sym: "^NSEI" };

function dfNum(n, dp) { return (n == null || isNaN(n)) ? "—" : fmt(n, dp == null ? (Math.abs(n) < 1000 ? 2 : 0) : dp); }
function dfRow(k, v, cls) { return `<div class="df-row"><span class="df-k">${k}</span><span class="df-v ${cls || ""}">${v}</span></div>`; }
function dfBiasArrow(b) { return b === "Bullish" ? "▲ BULLISH" : b === "Bearish" ? "▼ BEARISH" : b === "Conflict" ? "⚠ CONFLICT" : "• NEUTRAL"; }
function dfBiasCls(b) { return b === "Bullish" ? "up" : b === "Bearish" ? "down" : "neu"; }

// The flow is mounted in two places from ONE codebase: the Decision Flow desk
// ("flow") and the Index Option Trading Trader Dashboard ("oic"). Each instance
// has its own rail/stage elements and its own step/symbol/data state.
const DF_INST = {
  flow: { rail: "df-rail", stage: "df-stage", panel: "panel-decisionflow", state: { step: 1, sym: "^NSEI", data: null, loading: false }, timer: null },
};

function dfInitInstance(id) {
  const I = DF_INST[id];
  const rail = el(I.rail);
  if (rail && !rail.dataset.built) {
    rail.dataset.built = "1";
    const selId = id + "-df-index";
    rail.innerHTML = `<div class="df-rail-h">Decision Flow</div>
      <div class="df-filter"><label for="${selId}">Index</label>
        <select id="${selId}" class="df-index">${DF_INDICES.map((i) => `<option value="${i.sym}"${i.sym === I.state.sym ? " selected" : ""}>${i.label}</option>`).join("")}</select></div>` +
      DF_STEPS.map((s) => `<button type="button" class="df-step${s.n === I.state.step ? " active" : ""}" data-df="${s.n}">
        <span class="df-step-n">${s.n}</span><span class="df-step-t">${s.t}<small>${s.s}</small></span></button>`).join("") +
      `<div class="df-rail-note">Each step reads the existing engine — the flow only sequences what's already there. Advisory only.</div>`;
    rail.querySelectorAll("[data-df]").forEach((b) => b.addEventListener("click", () => dfSelect(id, +b.getAttribute("data-df"))));
    const sel = el(selId);
    if (sel) sel.addEventListener("change", () => {
      I.state.sym = sel.value;
      I.state.data = null;                 // clear stale symbol's data so nothing bleeds across
      dfRender(id);                        // show the loading state immediately for the new index
      dfLoad(id);
    });
  }
  dfLoad(id);
}
function dfSelect(id, n) {
  const I = DF_INST[id];
  I.state.step = n;
  const rail = el(I.rail);
  if (rail) rail.querySelectorAll(".df-step").forEach((e) => e.classList.toggle("active", +e.getAttribute("data-df") === n));
  dfRender(id);
}
function dfStartLive(id) {
  const I = DF_INST[id];
  if (I.timer) return;
  I.timer = setInterval(() => {
    const pn = document.getElementById(I.panel);
    if (pn && pn.classList.contains("active") && isMarketOpen()) dfLoad(id);
  }, 20 * 1000);
}
async function dfLoad(id) {
  const I = DF_INST[id];
  if (I.state.loading) return;
  I.state.loading = true;
  const sym = I.state.sym || "^NSEI";
  try {
    const [oi, ls, scan, paper, q] = await Promise.all([
      fetchJSON("/api/oi-command?symbol=" + encodeURIComponent(sym), 25000).catch(() => null),
      fetchJSON("/api/liquidity-status/" + encodeURIComponent(sym), 15000).catch(() => null),
      fetchJSON("/api/watchlist/scan", 60000).catch(() => null),
      fetchJSON("/api/paper/state", 8000).catch(() => null),
      fetchJSON("/api/quotes?symbols=" + encodeURIComponent(sym), 8000).catch(() => null),
    ]);
    if ((I.state.sym || "^NSEI") !== sym) { I.state.loading = false; return; } // superseded by a newer index pick
    I.state.data = {
      oi: oi && !oi.error ? oi : null,
      ls: ls && !ls.error ? ls : null,
      scan: scan && !scan.error ? scan : null,
      paper: paper && !paper.error ? paper : null,
      quote: q && q.quotes ? q.quotes[sym] : null,
    };
  } catch (_) { /* keep last */ }
  finally { I.state.loading = false; dfRender(id); }
}
function dfRender(id) {
  const I = DF_INST[id];
  const stage = el(I.stage);
  if (!stage) return;
  const D = I.state.data;
  if (!D) { stage.innerHTML = `<div class="wl-sub" style="padding:20px">Loading live data…</div>`; return; }
  const n = I.state.step;
  const fn = DF_SCREENS[n];
  stage.innerHTML = fn ? fn(D) : `<div class="df-planned">Screen ${n} — coming next.</div>`;
  stage.scrollTop = 0;
  stage.querySelectorAll("[data-df-goto]").forEach((b) => b.addEventListener("click", () => dfSelect(id, +b.getAttribute("data-df-goto"))));
  stage.querySelectorAll("[data-df-desk]").forEach((b) => b.addEventListener("click", () => { chooseMode(b.getAttribute("data-df-desk")); setTimeout(() => switchTab(b.getAttribute("data-df-tab")), 60); }));
}

// Backward-compatible wrappers for the Decision Flow desk.
function initDecisionFlow() { dfInitInstance("flow"); }
function startDecisionFlowLive() { dfStartLive("flow"); }

// ===================== MARKET COMMAND =====================
// Live Order Block trading screen with candlestick chart + command panel.
// Reuses: /api/market-command → OI Command + Liquidity Status + Order Block + Master Selector.
const MC = {
  sym: "^NSEI", tf: "15m", chart: null, candleSeries: null,
  ema9Series: null, ema21Series: null, ema50Series: null, vwapSeries: null,
  obMarkers: [], priceLine: null, timer: null, loading: false, lastData: null,
  show: { vwap: true, ema21: true, ema50: true, ema9: false, ob: true, vol: true },
  replayDate: null, // yyyy-mm-dd when replaying a past session; null = live
};

function initMarketCommand() {
  if (MC.chart) return; // already init
  const container = el("mc-chart-container");
  if (!container || typeof LightweightCharts === "undefined") return;

  // Wire index buttons
  el("mc-idx-btns")?.querySelectorAll(".mc-idx").forEach((btn) => {
    btn.addEventListener("click", () => {
      el("mc-idx-btns").querySelectorAll(".mc-idx").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      MC.sym = btn.getAttribute("data-sym");
      MC._fitKey = null;
      loadMarketCommand(!MC.replayDate); // fast chart first (live only)
    });
  });

  // Wire timeframe buttons
  el("mc-tf-btns")?.querySelectorAll(".mc-tf").forEach((btn) => {
    btn.addEventListener("click", () => {
      el("mc-tf-btns").querySelectorAll(".mc-tf").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      MC.tf = btn.getAttribute("data-tf");
      MC._fitKey = null;
      loadMarketCommand(!MC.replayDate);
    });
  });

  // Wire indicator toggles
  ["vwap", "ema21", "ema50", "ema9", "ob", "vol"].forEach((k) => {
    const cb = el("mc-tog-" + k);
    if (cb) cb.addEventListener("change", () => {
      MC.show[k] = cb.checked;
      applyMCOverlays();
    });
  });

  // Wire fullscreen
  const fsBtn = el("mc-fullscreen");
  if (fsBtn) fsBtn.addEventListener("click", () => {
    const wrap = el("panel-marketcommand")?.querySelector(".mc-wrap");
    if (wrap) {
      wrap.classList.toggle("mc-fullscreen-active");
      if (MC.chart) setTimeout(() => MC.chart.applyOptions({ width: container.clientWidth }), 50);
    }
  });

  // Wire replay / backtest controls
  const rToggle = el("mc-replay-toggle");
  const rPop = el("mc-replay-pop");
  const rDate = el("mc-replay-date");
  if (rToggle && rPop) {
    // Default the date input to yesterday.
    if (rDate && !rDate.value) {
      const y = new Date(Date.now() - 86400000);
      rDate.value = y.toISOString().slice(0, 10);
      rDate.max = new Date().toISOString().slice(0, 10);
    }
    rToggle.addEventListener("click", () => { rPop.hidden = !rPop.hidden; });
    el("mc-replay-load")?.addEventListener("click", () => {
      const dt = rDate?.value;
      if (!dt) return;
      MC.replayDate = dt;
      MC._fitKey = null;                 // re-frame chart for the replay session
      rPop.hidden = true;
      rToggle.classList.add("active");
      rToggle.textContent = "↺ " + dt;
      loadMarketCommand();
    });
    el("mc-replay-live")?.addEventListener("click", () => {
      MC.replayDate = null;
      MC._fitKey = null;
      rPop.hidden = true;
      rToggle.classList.remove("active");
      rToggle.textContent = "↺ Replay";
      loadMarketCommand();
    });
  }

  // Wire collapsible sections
  document.querySelectorAll("[data-mc-toggle]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const targetId = trigger.getAttribute("data-mc-toggle");
      const target = document.getElementById(targetId);
      if (!target) return;
      const isCollapsed = target.classList.toggle("collapsed");
      // Update all buttons that point to the same target
      document.querySelectorAll(`[data-mc-toggle="${targetId}"].mc-collapse-btn`).forEach((btn) => {
        btn.classList.toggle("collapsed", isCollapsed);
        btn.textContent = isCollapsed ? "▶" : "▼";
      });
    });
  });

  // Create chart (TradingView dark theme — high-visibility candles)
  const chartH = Math.max(container.clientHeight, 450);
  MC.chart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: chartH,
    layout: { background: { type: "solid", color: "#131722" }, textColor: "#b2b5be", fontSize: 12 },
    grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#2a2e39" }, horzLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#2a2e39" } },
    rightPriceScale: { borderColor: "#2a2e39", scaleMargins: { top: 0.08, bottom: 0.28 } },
    localization: { timeFormatter: (t) => fmtIST(t, true) },
    timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t) => fmtIST(t, false), barSpacing: 12 },
  });

  MC.candleSeries = MC.chart.addCandlestickSeries({
    upColor: "#16c784", downColor: "#ea3943", borderVisible: false,
    wickUpColor: "#16c784", wickDownColor: "#ea3943",
  });

  // Volume histogram pinned to the bottom of the price pane
  MC.volSeries = MC.chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
  MC.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

  // Crosshair OHLC sync
  MC.chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time || !MC._candles) return;
    const c = MC._candles.find((x) => x.time === param.time);
    if (!c) return;
    const oE = el("mc-ohlc-o"), hE = el("mc-ohlc-h"), lE = el("mc-ohlc-l"), cE = el("mc-ohlc-c");
    if (oE) oE.textContent = c.open?.toFixed(2);
    if (hE) hE.textContent = c.high?.toFixed(2);
    if (lE) lE.textContent = c.low?.toFixed(2);
    if (cE) cE.textContent = c.close?.toFixed(2);
    const v = (MC._volumes || []).find((x) => x.time === param.time);
    const vE = el("mc-leg-vol-v");
    if (vE && v) vE.textContent = mcFmtVol(v.value);
  });

  MC.ema9Series = MC.chart.addLineSeries({ color: "#ffa657", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  MC.ema21Series = MC.chart.addLineSeries({ color: "#58a6ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  MC.ema50Series = MC.chart.addLineSeries({ color: "#bc8cff", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  MC.vwapSeries = MC.chart.addLineSeries({ color: "#d29922", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });

  window.addEventListener("resize", () => {
    if (MC.chart) MC.chart.applyOptions({ width: container.clientWidth, height: Math.max(container.clientHeight, 450) });
  });

  loadMarketCommand(true); // fast chart first, then full
}

function startMarketCommandLive() {
  if (MC.timer) return;
  // Live refresh: 5s while the market is open (fast, low-delay), 30s when closed
  // (data isn't changing, so avoid needless load). Backend caches absorb the rate:
  // candles refresh every ~5s, OI/liquidity serve from their 15s caches between hits.
  MC._tick = 0;
  MC.timer = setInterval(() => {
    const pn = document.getElementById("panel-marketcommand");
    if (!pn || !pn.classList.contains("active") || MC.loading) return;
    if (MC.replayDate) return; // frozen on a past session — don't overwrite with live
    const open = (typeof isMarketOpen === "function" && isMarketOpen()) ||
                 (typeof isFeedWindow === "function" && isFeedWindow());
    MC._tick++;
    // Every 5s tick fires when open; only every 6th tick (30s) when closed.
    if (open || MC._tick % 6 === 0) loadMarketCommand();
  }, 5000);
}

async function loadMarketCommand(chartOnly = false) {
  // chartOnly (view=chart) skips the heavy OI pipeline so the chart paints fast;
  // a full load follows to fill the OI-based command panel. Replay never uses it.
  if (MC.loading) return;
  MC.loading = true;
  try {
    let url = `/api/market-command?symbol=${encodeURIComponent(MC.sym)}&interval=${MC.tf}`;
    if (MC.replayDate) url += `&date=${MC.replayDate}`;
    else if (chartOnly) url += `&view=chart`;
    const d = await fetchJSON(url, 25000);
    if (!d || d.error) {
      const cmd = el("mc-cmd-action");
      if (cmd) { cmd.className = "mc-cmd-action stale"; }
      const lbl = el("mc-action-label"); if (lbl) lbl.textContent = "NO DATA";
      const arr = el("mc-action-arrow"); if (arr) arr.textContent = "—";
      const bdg = el("mc-action-badge"); if (bdg) bdg.textContent = "";
      const fr = el("mc-fa-reason"); if (fr) fr.textContent = d?.error || "Failed to load";
      MC.loading = false;
      return;
    }
    MC.lastData = d;
    renderMCChart(d);
    renderMCCommand(d);
    renderMCStatus(d);
    renderMCLiveBar(d);
    renderMCStrikes(d);
    renderMCMarketView(d);
    renderMCPlan(d);
  } catch (e) {
    console.error("[MarketCommand]", e);
  }
  MC.loading = false;
  // After a fast chart-only paint, immediately fetch the full payload (OI/command).
  if (chartOnly && !MC.replayDate) loadMarketCommand(false);
}

function mcFmtK(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (a >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

function renderMCPlan(d) {
  const p = d.tradePlan;
  const el2 = (id) => el(id);
  if (!p) return;
  const fmt = (v) => v != null ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—";
  // Direction
  const dirEl = el2("mc-plan-dir"), dirCell = el2("mc-plan-dir-cell");
  if (dirEl) { dirEl.textContent = p.direction; dirEl.className = "mc-plan-val " + p.direction; }
  if (dirCell) dirCell.className = "mc-plan-cell mc-plan-dir " + p.direction;
  // Entry
  const entryEl = el2("mc-plan-entry"), entryState = el2("mc-plan-entry-state");
  if (entryEl) entryEl.textContent = p.entryZone || "—";
  if (entryState) entryState.textContent = p.entryState || "";
  // Strike
  const strikeEl = el2("mc-plan-strike"), strikeAlt = el2("mc-plan-strike-alt");
  if (strikeEl) strikeEl.textContent = p.preferredStrike || "—";
  if (strikeAlt) strikeAlt.textContent = p.alternativeStrike ? "alt " + p.alternativeStrike : "";
  // SL
  const slEl = el2("mc-plan-sl");
  if (slEl) slEl.textContent = p.stopLoss != null ? fmt(p.stopLoss) : "—";
  // Targets
  const tgtEl = el2("mc-plan-tgt");
  if (tgtEl) tgtEl.textContent = (p.target1 != null ? fmt(p.target1) : "—") + (p.target2 != null ? " / " + fmt(p.target2) : "");
  // Action (Master authority)
  const actEl = el2("mc-plan-action");
  if (actEl) {
    const a = p.dataStale ? "STALE" : (p.action || "—");
    actEl.textContent = a === "NO TRADE" ? "AVOID" : a;
    actEl.className = "mc-plan-action " + a.replace(/ /g, ".");
  }
}

function renderMCMarketView(d) {
  const mv = d.marketView;
  const box = el("mc-marketview");
  if (!box) return;
  if (!mv || d.partial) { box.hidden = true; return; }
  box.hidden = false;
  const strengthEl = el("mc-mv-strength");
  if (strengthEl) { strengthEl.textContent = `${mv.strength} · ${mv.strengthEvidence}`; strengthEl.className = "mc-mv-strength " + mv.strength; }
  const dirEl = el("mc-mv-dir");
  if (dirEl) { dirEl.textContent = mv.direction; dirEl.className = mv.direction; }
  const stEl = el("mc-mv-state");
  if (stEl) { stEl.textContent = mv.state; stEl.className = mv.state; }
  const block = (id, label, items, cls) => {
    const e = el(id); if (!e) return;
    if (!items || !items.length) { e.hidden = true; return; }
    e.hidden = false;
    e.className = "mc-mv-block " + cls;
    e.innerHTML = `<span class="lbl">${label}</span>` + items.map((s) => `<span class="item">${s}</span>`).join("");
  };
  const v = mv.validation || {};
  // Always show the raw bullish/bearish evidence tally (grounded, never a guess).
  block("mc-mv-supporting", `Bullish evidence (${v.bullVotes ?? 0})`, v.bullishEvidence, "support");
  block("mc-mv-contradicting", `Bearish evidence (${v.bearVotes ?? 0})`, v.bearishEvidence, "contradict");
  block("mc-mv-missing", "Confirmation required", mv.missing, "missing");
  const inval = el("mc-mv-inval");
  if (inval) inval.textContent = mv.invalidation ? "⚠ " + mv.invalidation : "";
  const based = el("mc-mv-based");
  if (based) based.textContent = mv.basedOn || "";
}

function renderMCStrikes(d) {
  const sa = d.strikeAnalysis;
  const unavail = el("mc-strike-unavail");
  const main = el("mc-strike-main");
  if (!sa || !sa.available) {
    if (unavail) { unavail.hidden = false; unavail.textContent = (sa && sa.reason) ? "STRIKE ANALYSIS: " + sa.reason : "STRIKE ANALYSIS: DATA UNAVAILABLE"; }
    if (main) main.hidden = true;
    return;
  }
  if (unavail) unavail.hidden = true;
  if (main) main.hidden = false;

  // ATM CE/PE line
  const atmEl = el("mc-strike-atm");
  if (atmEl) {
    const ce = sa.atm?.ce, pe = sa.atm?.pe;
    atmEl.innerHTML =
      `<span>ATM <b>${sa.atmStrike ?? "—"}</b></span>` +
      (ce ? `<span class="ce">${sa.atmStrike} CE <b>${ce.ltp != null ? "₹" + ce.ltp : "—"}</b>${ce.ltpChgPct != null ? ` (${ce.ltpChgPct >= 0 ? "+" : ""}${ce.ltpChgPct}%)` : ""}</span>` : "") +
      (pe ? `<span class="pe">${sa.atmStrike} PE <b>${pe.ltp != null ? "₹" + pe.ltp : "—"}</b>${pe.ltpChgPct != null ? ` (${pe.ltpChgPct >= 0 ? "+" : ""}${pe.ltpChgPct}%)` : ""}</span>` : "");
  }

  // Strike table
  const tbl = el("mc-strike-table");
  if (tbl) {
    const head = `<tr><th>Strike</th><th>Type</th><th>LTP</th><th>Move</th><th>Speed</th><th>Liq</th><th>Assess</th></tr>`;
    const rows = (sa.rows || []).map((r) => {
      const cls = sa.primary && r.strike === sa.primary.strike ? "primary" : r.assessment === "AVOID" ? "avoid" : "";
      const speed = r.responsiveness != null ? r.responsiveness.toFixed(2) : "—";
      const liq = r.liquidityRank != null ? Math.round(r.liquidityRank * 100) + "%" : "—";
      const move = r.ltpChgPct != null ? (r.ltpChgPct >= 0 ? "+" : "") + r.ltpChgPct + "%" : "—";
      return `<tr class="${cls}"><td>${r.strike} <span style="color:#787b86">${r.moneyness}</span></td><td>${r.side}</td><td>${r.ltp != null ? "₹" + r.ltp : "—"}</td><td>${move}</td><td>${speed}</td><td>${liq}</td><td><span class="mc-strike-tag ${r.assessment.replace(/ /g, "")}">${r.assessment}</span></td></tr>`;
    }).join("");
    tbl.innerHTML = head + rows;
  }

  // Picks
  const picks = el("mc-strike-picks");
  if (picks) {
    let html = "";
    if (sa.primary) html += `<div class="mc-strike-pick primary"><span class="lbl">Primary Strike — ${sa.primary.strike} ${sa.primary.side}</span><div class="why">${sa.primary.why}</div></div>`;
    if (sa.alternative) html += `<div class="mc-strike-pick alt"><span class="lbl">Alternative — ${sa.alternative.strike} ${sa.alternative.side}</span><div class="why">${sa.alternative.why}</div></div>`;
    if (sa.avoid) html += `<div class="mc-strike-pick avoid"><span class="lbl">Avoid — ${sa.avoid.strike} ${sa.avoid.side}</span><div class="why">${sa.avoid.why}</div></div>`;
    if (!html && sa.side == null) html = `<div class="mc-strike-note">Master direction is neutral — no option side selected.</div>`;
    picks.innerHTML = html;
  }

  const note = el("mc-strike-note");
  if (note) note.textContent = sa.spreadNote || "";
}

function mcFmtVol(v) {
  if (v == null) return "—";
  if (v >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (v >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

function renderMCChart(d) {
  if (!MC.chart || !MC.candleSeries) return;
  const candles = (d.candles || []).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
  MC.candleSeries.setData(candles);

  // Volume histogram (colored by candle direction)
  const volumes = (d.candles || []).map((c) => ({
    time: c.time, value: c.volume || 0,
    color: c.close >= c.open ? "rgba(22,199,132,.5)" : "rgba(234,57,67,.5)",
  }));
  MC._volumes = volumes;
  if (MC.volSeries) MC.volSeries.setData(MC.show.vol === false ? [] : volumes);

  // Store overlays for toggle
  MC._overlayData = d.overlays || {};
  MC._candles = candles;
  MC._orderBlocks = d.orderBlocks || [];
  MC._bosEvents = d.structure?.bosEvents || [];
  MC._swingPoints = d.structure?.swingPoints || [];

  // Visible window: show the recent ~120 bars (like TradingView / the Selected
  // Stock chart) so candles are large. Compute the price range of those bars so
  // we can drop any level line that sits far outside it — otherwise a distant
  // Order Block or target drags the whole price scale down and squishes the candles.
  const N = candles.length;
  const showBars = Math.min(120, N);
  const recent = candles.slice(-showBars);
  let vlo = Infinity, vhi = -Infinity;
  recent.forEach((c) => { if (c.low < vlo) vlo = c.low; if (c.high > vhi) vhi = c.high; });
  const pad = (vhi - vlo) * 0.6 || vhi * 0.005;
  MC._inView = (p) => p != null && p >= vlo - pad && p <= vhi + pad;
  applyMCOverlays();

  // Current price line
  if (MC.priceLine) { try { MC.candleSeries.removePriceLine(MC.priceLine); } catch {} }
  if (d.spot) {
    MC.priceLine = MC.candleSeries.createPriceLine({
      price: d.spot, color: "#2962ff", lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: "",
    });
  }

  // Order Block zones — only those near the visible price range.
  MC.obMarkers.forEach((pl) => { try { MC.candleSeries.removePriceLine(pl); } catch {} });
  MC.obMarkers = [];
  if (MC.show.ob && d.orderBlocks) {
    d.orderBlocks.forEach((ob) => {
      if (!MC._inView(ob.high) && !MC._inView(ob.low)) return;
      drawMCOrderBlock(ob);
    });
  }

  // Spot-level SL + Target price lines on chart (only when near visible range)
  const cmd = d.command;
  if (cmd) {
    if (cmd.spotSL && MC._inView(cmd.spotSL)) {
      const sl = MC.candleSeries.createPriceLine({ price: cmd.spotSL, color: "#ea3943", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `SL ${cmd.spotSL}` });
      MC.obMarkers.push(sl);
    }
    if (cmd.spotT1 && MC._inView(cmd.spotT1)) {
      const t1 = MC.candleSeries.createPriceLine({ price: cmd.spotT1, color: "#16c784", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `T1 ${cmd.spotT1}` });
      MC.obMarkers.push(t1);
    }
    if (cmd.spotT2 && MC._inView(cmd.spotT2)) {
      const t2 = MC.candleSeries.createPriceLine({ price: cmd.spotT2, color: "#16c784", lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `T2 ${cmd.spotT2}` });
      MC.obMarkers.push(t2);
    }
    // Entry zone
    if (cmd.entryZone && cmd.entryZone !== "—") {
      const parts = cmd.entryZone.split("–").map((s) => parseFloat(s.trim()));
      if (parts.length === 2 && parts[0] && parts[1] && MC._inView(parts[0])) {
        const ezLo = MC.candleSeries.createPriceLine({ price: parts[0], color: "#2962ff", lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: "" });
        const ezHi = MC.candleSeries.createPriceLine({ price: parts[1], color: "#2962ff", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "Entry Zone" });
        MC.obMarkers.push(ezLo, ezHi);
      }
    }
  }

  // BOS markers: Confirmed = solid arrow "BOS"; Pre = faded circle "BOS?"
  if (d.structure?.bosEvents?.length) {
    const markers = d.structure.bosEvents.map((b) => {
      const pre = b.stage === "Pre";
      const bull = b.direction === "Bullish";
      return {
        time: b.time, position: bull ? "belowBar" : "aboveBar",
        color: pre ? (bull ? "rgba(22,199,132,.55)" : "rgba(234,57,67,.55)") : (bull ? "#16c784" : "#ea3943"),
        shape: pre ? "circle" : (bull ? "arrowUp" : "arrowDown"),
        text: pre ? "BOS?" : "BOS",
      };
    });
    MC.candleSeries.setMarkers(markers);
  }

  // Show only the recent ~120 bars (big candles, tight price range like the
  // Selected Stock chart) on first render or a symbol/timeframe switch. Live 5s
  // refreshes leave the user's current zoom/scroll alone.
  const viewKey = MC.sym + ":" + MC.tf;
  if (MC._fitKey !== viewKey) {
    MC.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, N - showBars), to: N + 2 });
    MC._fitKey = viewKey;
  }
}

function applyMCOverlays() {
  if (!MC.chart) return;
  const ov = MC._overlayData || {};
  const candles = MC._candles || [];
  const align = (arr) => candles.map((c, i) => arr && arr[i] != null ? { time: c.time, value: arr[i] } : null).filter(Boolean);

  MC.ema9Series.setData(MC.show.ema9 ? align(ov.ema9) : []);
  MC.ema21Series.setData(MC.show.ema21 ? align(ov.ema21) : []);
  MC.ema50Series.setData(MC.show.ema50 ? align(ov.ema50) : []);
  MC.vwapSeries.setData(MC.show.vwap ? align(ov.vwap) : []);
  if (MC.volSeries) MC.volSeries.setData(MC.show.vol ? (MC._volumes || []) : []);

  // Re-render OB zones
  MC.obMarkers.forEach((pl) => { try { MC.candleSeries.removePriceLine(pl); } catch {} });
  MC.obMarkers = [];
  if (MC.show.ob && MC._orderBlocks) {
    const inView = MC._inView || (() => true);
    MC._orderBlocks.forEach((ob) => {
      if (!inView(ob.high) && !inView(ob.low)) return;
      drawMCOrderBlock(ob);
    });
  }
}

// Draw one Order Block zone. Confirmed = solid bright lines with a label;
// Pre (forming) = dashed, faded lines labelled "pre" so an early setup is
// visually distinct from a confirmed one.
function drawMCOrderBlock(ob) {
  const isBull = ob.side === "Bullish";
  const confirmed = ob.stage === "Confirmed";
  const solid = isBull ? "#16c784" : "#ea3943";
  const faded = isBull ? "rgba(22,199,132,.55)" : "rgba(234,57,67,.55)";
  const color = confirmed ? solid : faded;
  const style = confirmed ? 0 : 2; // solid vs dashed
  const label = `${isBull ? "Bull" : "Bear"} OB${confirmed ? "" : " (pre)"}`;
  const hiLine = MC.candleSeries.createPriceLine({ price: ob.high, color, lineWidth: confirmed ? 2 : 1, lineStyle: style, axisLabelVisible: false, title: label });
  const loLine = MC.candleSeries.createPriceLine({ price: ob.low, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false, title: "" });
  MC.obMarkers.push(hiLine, loLine);
}

function renderMCCommand(d) {
  const cmd = d.command;
  if (!cmd) return;
  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v ?? "—"; };

  // Trade Signal action
  const isReplay = cmd.finalAction === "REPLAY" || d.historical;
  const isPartial = !!d.partial; // chart-only fast payload; OI still loading
  const actionEl = el("mc-cmd-action");
  if (actionEl) {
    const isTake = cmd.finalAction === "TAKE";
    const isBull = cmd.direction === "BULLISH";
    const isBear = cmd.direction === "BEARISH";
    const cls = isPartial ? "wait" : isReplay ? (isBull ? "take" : isBear ? "sell" : "wait")
      : isTake ? (isBull ? "take" : "sell") : cmd.finalAction === "NO TRADE" ? "no-trade" : cmd.finalAction === "DATA STALE" ? "stale" : "wait";
    actionEl.className = "mc-cmd-action " + cls;
    const arrowEl = el("mc-action-arrow");
    const labelEl = el("mc-action-label");
    const badgeEl = el("mc-action-badge");
    if (arrowEl) arrowEl.textContent = isPartial ? "⋯" : isReplay ? (isBull ? "▲" : isBear ? "▼" : "◆") : isTake ? (isBull ? "▲" : "▼") : cmd.finalAction === "NO TRADE" ? "✕" : "◆";
    if (labelEl) labelEl.textContent = isPartial ? "LOADING…" : isReplay ? cmd.direction : isTake ? (isBull ? "BUY (CALL)" : "SELL (PUT)") : cmd.finalAction;
    if (badgeEl) badgeEl.textContent = isPartial ? "OI" : isReplay ? "REPLAY" : isTake ? cmd.direction : cmd.finalAction === "WAIT" ? "PENDING" : "";
  }

  // Pre / Confirmed signal detail (VWAP + candle movement)
  const dirEl = el("mc-sd-dir");
  if (dirEl) {
    const conf = cmd.structureConfirmed || "Ranging";
    const pre = cmd.structurePre || "Ranging";
    // Confirmed structure wins the label; if only a pre lean exists, show it as forming.
    if (conf !== "Ranging") {
      dirEl.textContent = conf.toUpperCase() + " · confirmed";
      dirEl.className = conf === "Bearish" ? "bear" : "confirmed";
    } else if (pre !== "Ranging") {
      dirEl.textContent = pre.toUpperCase() + " · forming";
      dirEl.className = "pre";
    } else {
      dirEl.textContent = "RANGING"; dirEl.className = "muted";
    }
  }
  const vwEl = el("mc-sd-vwap");
  if (vwEl) {
    const v = cmd.vwapStatus || "At";
    vwEl.textContent = v === "Above" ? "Price ABOVE" : v === "Below" ? "Price BELOW" : "At VWAP";
    vwEl.className = v === "Above" ? "confirmed" : v === "Below" ? "bear" : "muted";
  }
  const obEl = el("mc-sd-ob");
  if (obEl) {
    if (cmd.obStage) {
      obEl.textContent = cmd.obStage === "Confirmed" ? "Confirmed" : "Pre (forming)";
      obEl.className = cmd.obStage === "Confirmed" ? "confirmed" : "pre";
    } else { obEl.textContent = "None in range"; obEl.className = "muted"; }
  }
  // Direction-change alert banner
  const alertEl = el("mc-sd-alert");
  if (alertEl) {
    const dc = cmd.directionChange;
    if (dc && dc.stage && dc.stage !== "None") {
      alertEl.hidden = false;
      alertEl.className = "mc-sd-alert " + (dc.stage === "Confirmed" ? "confirmed" : "pre");
      const arrow = dc.to === "Bullish" ? "▲" : dc.to === "Bearish" ? "▼" : "◆";
      alertEl.textContent = `${arrow} DIRECTION CHANGE ${dc.stage.toUpperCase()} → ${String(dc.to).toUpperCase()}`;
    } else {
      alertEl.hidden = true;
    }
  }

  // Entry / SL / Targets
  setText("mc-cmd-entry-zone", cmd.entryZone);
  setText("mc-cmd-sl", cmd.spotSL != null ? cmd.spotSL.toLocaleString("en-IN") : "—");
  setText("mc-cmd-t1", cmd.spotT1 != null ? cmd.spotT1.toLocaleString("en-IN") : "—");
  setText("mc-cmd-t2", cmd.spotT2 != null ? cmd.spotT2.toLocaleString("en-IN") : "—");

  // Option Selection
  const callBtn = el("mc-opt-call");
  const putBtn = el("mc-opt-put");
  if (callBtn && putBtn) {
    callBtn.className = "mc-opt-btn" + (cmd.optionType === "CE" ? " active-call" : "");
    putBtn.className = "mc-opt-btn" + (cmd.optionType === "PE" ? " active-put" : "");
  }
  setText("mc-cmd-strike", cmd.strike);
  setText("mc-cmd-ltp", cmd.optionLtp != null ? "₹" + cmd.optionLtp : "—");

  // Final action bar
  const faEl = el("mc-final-action");
  const faLabel = el("mc-fa-label");
  const faReason = el("mc-fa-reason");
  if (faEl && faLabel) {
    const isTake = cmd.finalAction === "TAKE";
    const isBull = cmd.direction === "BULLISH";
    faEl.className = "mc-final-action " + (isPartial || isReplay ? "wait" : isTake ? (isBull ? "take" : "sell") : cmd.finalAction === "NO TRADE" ? "sell" : "wait");
    faLabel.textContent = isPartial ? "LOADING LIVE DATA…" : isReplay ? "HISTORICAL REPLAY" : isTake ? (isBull ? "EXECUTE BUY" : "EXECUTE SELL") : cmd.finalAction === "WAIT" ? "WAIT FOR SETUP" : cmd.finalAction;
  }
  if (faReason) faReason.textContent = isPartial ? "Chart ready — fetching OI & signals…" : (cmd.finalReason || "");

  // Confirmations checklist
  const checksEl = el("mc-cmd-checks");
  if (checksEl && cmd.confirmations) {
    const confPassed = cmd.confirmations.filter((c) => c.passed).length;
    checksEl.innerHTML =
      `<div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#787b86;margin-bottom:6px">Confirmations ${confPassed}/${cmd.confirmations.length}</div>` +
      cmd.confirmations.map((c) =>
        `<div class="mc-check-item ${c.passed ? "pass" : "fail"}"><span class="mc-check-ico">${c.passed ? "✓" : "✗"}</span><span class="mc-check-name">${c.label}</span></div>`
      ).join("");
  }
}

function renderMCStatus(d) {
  // Direction card
  const dirCard = el("mc-stat-direction");
  if (dirCard) {
    const v = dirCard.querySelector(".mc-stat-value");
    const ico = el("mc-stat-dir-ico");
    const dir = d.oi?.direction === "UP" ? "BULLISH" : d.oi?.direction === "DOWN" ? "BEARISH" : "NEUTRAL";
    if (v) { v.textContent = dir; v.className = "mc-stat-value " + (dir === "BULLISH" ? "bullish" : dir === "BEARISH" ? "bearish" : "neutral"); }
    if (ico) ico.textContent = dir === "BULLISH" ? "▲" : dir === "BEARISH" ? "▼" : "◆";
  }
  // Structure / Trend card
  const stCard = el("mc-stat-structure");
  if (stCard) {
    const v = stCard.querySelector(".mc-stat-value");
    const ico = el("mc-stat-str-ico");
    const st = d.structure?.current || "—";
    const isUp = st === "Bullish";
    if (v) { v.textContent = isUp ? "UPTREND" : st === "Bearish" ? "DOWNTREND" : "RANGING"; v.className = "mc-stat-value " + (isUp ? "bullish" : st === "Bearish" ? "bearish" : "neutral"); }
    if (ico) ico.textContent = isUp ? "↗" : st === "Bearish" ? "↘" : "→";
  }
  // Order Block card
  const obCard = el("mc-stat-ob");
  if (obCard) {
    const v = obCard.querySelector(".mc-stat-value");
    const ico = el("mc-stat-ob-ico");
    if (d.activeOB) {
      const confirmed = d.activeOB.stage === "Confirmed";
      v.textContent = confirmed ? "CONFIRMED ✓" : "PRE (forming)";
      v.className = "mc-stat-value " + (confirmed ? (d.activeOB.side === "Bullish" ? "bullish" : "bearish") : "neutral");
    } else {
      v.textContent = "NONE"; v.className = "mc-stat-value neutral";
    }
    if (ico) ico.textContent = d.activeOB ? (d.activeOB.side === "Bullish" ? "◧" : "◨") : "○";
  }
  // Volatility / Regime card
  const regCard = el("mc-stat-regime");
  if (regCard) {
    const v = regCard.querySelector(".mc-stat-value");
    const ico = el("mc-stat-reg-ico");
    const regime = d.command?.regime || "—";
    if (v) { v.textContent = regime.toUpperCase(); v.className = "mc-stat-value neutral"; }
    if (ico) ico.textContent = regime === "HIGH" ? "⚡" : regime === "LOW" ? "~" : "≈";
  }

  // Header: symbol name, spot price, OHLC last candle, EMA legend
  const spotEl = el("mc-spot");
  if (spotEl && d.spot) spotEl.textContent = d.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const nameEl = el("mc-sym-name");
  if (nameEl) nameEl.textContent = d.name || d.symbol;
  const tfEl = el("mc-sym-tf");
  if (tfEl) tfEl.textContent = "· " + (MC.tf || "15m").replace("m", "") + " · NSE";

  // OHLC + Volume from last candle
  if (d.candles?.length) {
    const last = d.candles[d.candles.length - 1];
    const oE = el("mc-ohlc-o"), hE = el("mc-ohlc-h"), lE = el("mc-ohlc-l"), cE = el("mc-ohlc-c");
    if (oE) oE.textContent = last.open?.toFixed(2);
    if (hE) hE.textContent = last.high?.toFixed(2);
    if (lE) lE.textContent = last.low?.toFixed(2);
    if (cE) cE.textContent = last.close?.toFixed(2);
    const vE = el("mc-leg-vol-v");
    if (vE) vE.textContent = mcFmtVol(last.volume || 0);
  }
  // EMA21 legend value
  if (d.overlays?.ema21?.length) {
    const lastEma = d.overlays.ema21[d.overlays.ema21.length - 1];
    const legEl = el("mc-leg-ema21-v");
    if (legEl && lastEma) legEl.textContent = lastEma.toFixed(2);
  }
}

function renderMCLiveBar(d) {
  const dot = el("mc-live-dot");
  const label = el("mc-live-label");
  const ts = el("mc-timestamp");
  const tag = el("mc-live-tag");

  // Replay / historical mode: never present past data as LIVE.
  if (d.historical) {
    if (dot) dot.className = "mc-live-dot stale";
    if (label) label.textContent = "Replay · " + (d.asOfDate || "past session");
    if (tag) { tag.textContent = "HISTORICAL"; tag.style.color = "#f7931a"; tag.style.borderColor = "#f7931a"; }
    if (ts && d.lastCandleTime) {
      const dt = new Date((d.lastCandleTime + 19800) * 1000);
      ts.textContent = "last bar " + dt.toISOString().slice(11, 16);
    }
    return;
  }

  if (dot) dot.className = "mc-live-dot" + (d.dataStale ? " stale" : !d.dhanLive ? " off" : "");
  if (label) label.textContent = d.dhanLive ? "Dhan Connected" : "Offline";
  if (tag) {
    tag.textContent = d.dataStale ? "STALE" : d.dhanLive ? "LIVE" : "OFF";
    tag.style.color = d.dataStale ? "#f7931a" : d.dhanLive ? "#26a69a" : "#ef5350";
    tag.style.borderColor = tag.style.color;
  }
  if (ts && d.lastCandleTime) {
    const dt = new Date((d.lastCandleTime + 19800) * 1000);
    ts.textContent = dt.toISOString().slice(11, 19) + (d.dataAgeSec != null ? ` (${d.dataAgeSec}s)` : "");
  }
  // Per-component sync-health chips (candle / OI)
  const sync = el("mc-sync");
  if (sync) {
    const sh = d.syncHealth;
    if (!sh || sh.overall === "HISTORICAL") { sync.innerHTML = ""; }
    else {
      const chip = (name, comp) => {
        if (!comp) return "";
        const st = comp.status || "UNAVAILABLE";
        const age = comp.ageSec != null ? ` ${comp.ageSec}s` : "";
        return `<span class="chip ${st}" title="${name} ${st}${age}">${name} ${st}</span>`;
      };
      sync.innerHTML = chip("Candle", sh.candle) + chip("OI", sh.oi);
    }
  }
}

function dfHead(num, title, q) {
  return `<div class="df-scr-head"><span class="df-scr-num">${String(num).padStart(2, "0")}</span><h2>${title}</h2></div><p class="df-scr-q"><em>${q}</em></p>`;
}
function dfMasterStatus(D) {
  const ls = D.ls, arb = D.oi && D.oi.ext && D.oi.ext.arbitration;
  const v = arb ? arb.verdict : (ls ? ls.traderAction : null);
  if (!v) return { word: "DATA UNAVAILABLE", cls: "wait", why: "Live feed not available right now." };
  if (/GO|TAKE|PREPARE/i.test(v)) return { word: "TRADEABLE", cls: "go", why: (arb && arb.reason) || (ls && ls.traderActionDetail) || "" };
  if (/CONFLICT|AVOID/i.test(v)) return { word: "HIGH RISK / AVOID", cls: "avoid", why: (arb && arb.reason) || (ls && ls.conflict && ls.conflict.reason) || "" };
  return { word: "WAIT FOR SETUP", cls: "wait", why: (arb && arb.reason) || (ls && ls.traderActionDetail) || "" };
}

const DF_SCREENS = {
  1: (D) => {
    const ls = D.ls, oi = D.oi, q = D.quote;
    const spot = oi ? oi.spot : (ls && ls.spot);
    const chg = q ? q.changePercent : null;
    const score = ls ? (ls.liquidityFlowScore && ls.liquidityFlowScore.score) : null;
    const bias = ls ? ls.directionBias : (oi && oi.oiDirection === "UP" ? "Bullish" : oi && oi.oiDirection === "DOWN" ? "Bearish" : "Neutral");
    const st = ls && ls.structure;
    const stage = ls ? ntStageFromLs(ls) : "—";
    const regime = (oi && oi.ext && oi.ext.regime) || "—";
    const em = oi && oi.expectedMove;
    const kl = (ls && ls.keyLevels) || [];
    const sup = kl.find((l) => l.label === "KEY SUPPORT"), res = kl.find((l) => l.label === "KEY RESISTANCE");
    const W = oi && oi.walls;
    const ms = dfMasterStatus(D);
    let proj;
    if (em && (em.low != null || em.high != null) && em.dir) {
      const sign = em.dir < 0 ? "−" : "+";
      proj = dfRow("Expected move", `<b>${sign}${Math.round(Math.abs(em.low))} → ${sign}${Math.round(Math.abs(em.high))} pts</b>`, "") +
        dfRow("Expected price", spot != null ? `${dfNum(spot + em.dir * Math.abs(em.low), 0)} → ${dfNum(spot + em.dir * Math.abs(em.high), 0)}` : "—") +
        dfRow("Direction", dfBiasArrow(bias), dfBiasCls(bias)) +
        dfRow("Confidence", score != null ? score + "%" : "—");
    } else {
      proj = `<div class="df-na">NO EDGE · LOW CONFIDENCE<div class="wl-sub">Direction flat — no projected range.</div></div>`;
    }
    return dfHead(1, "Morning Market Command", "Is today's environment worth trading?") + `
      <div class="df-cc-top">
        <div class="df-stat"><div class="df-lab">Market Regime</div><div class="df-big ${dfBiasCls(bias)}">${String(regime).toUpperCase()}</div></div>
        <div class="df-stat"><div class="df-lab">NIFTY Bias</div><div class="df-big ${dfBiasCls(bias)}">${dfBiasArrow(bias)}</div></div>
        <div class="df-stat"><div class="df-lab">Stage</div><div class="df-big" style="font-size:16px">${stage}</div></div>
        <div class="df-stat"><div class="df-lab">Liquidity</div><div class="df-big mono">${score == null ? "—" : score}<span style="font-size:12px;color:var(--muted)">/100</span></div><div class="df-sub">${score == null ? "" : ntMeter(score) + " OI + volume"}</div></div>
      </div>
      <div class="df-cc-cols">
        <div class="df-panel"><div class="df-panel-h">NIFTY</div>
          ${dfRow("Spot", dfNum(spot))}
          ${dfRow("Change", chg == null ? "—" : (chg >= 0 ? "+" : "") + fmt(chg) + "%", chg > 0 ? "up" : chg < 0 ? "down" : "neu")}
          ${dfRow("VWAP", st ? (st.vwapStatus.indexOf("Above") === 0 ? "Above ✓" : st.vwapStatus.indexOf("Below") === 0 ? "Below ✕" : "Choppy") : "—", st && st.vwapStatus.indexOf("Above") === 0 ? "up" : "neu")}
          ${dfRow("EMA 9/21/50", st ? (st.emaStructure === "Strong Bullish" ? "9>21>50 ✓" : st.emaStructure === "Strong Bearish" ? "9<21<50 ✕" : "Mixed") : "—", st ? dfBiasCls(st.emaStructure === "Strong Bullish" ? "Bullish" : st.emaStructure === "Strong Bearish" ? "Bearish" : "Neutral") : "")}
          ${dfRow("Momentum", st && st.rsi != null ? "RSI " + Math.round(st.rsi) : "—", st && st.rsi >= 55 ? "up" : st && st.rsi <= 45 ? "down" : "neu")}
        </div>
        <div class="df-panel"><div class="df-panel-h">Structure</div>
          ${dfRow("Resistance", res ? dfNum(res.price, 0) : "—", "down")}
          ${dfRow("Call wall", W && W.bestR ? dfNum(W.bestR.strike, 0) : "—", "down")}
          ${dfRow("Put wall", W && W.bestS ? dfNum(W.bestS.strike, 0) : "—", "up")}
          ${dfRow("Support", sup ? dfNum(sup.price, 0) : "—", "up")}
          ${dfRow("Room ↑", (res && spot != null) ? Math.round(res.price - spot) + " pts" : "—")}
        </div>
        <div class="df-panel"><div class="df-panel-h">Point Projection</div>${proj}</div>
        <div class="df-panel"><div class="df-panel-h">Freshness</div>
          ${dfRow("Data age", oi && oi.dataAgeSec != null ? Math.round(oi.dataAgeSec) + "s" : "—", (oi && oi.stale) ? "warn" : "up")}
          ${dfRow("Session", (oi && oi.refresh && oi.refresh.marketOpen === false) ? "CLOSED" : "OPEN")}
          ${dfRow("OI baseline", ls && ls.freshness && ls.freshness.oiStale ? "STALE" : "OK", ls && ls.freshness && ls.freshness.oiStale ? "warn" : "up")}
        </div>
      </div>
      <div class="df-master df-master-${ms.cls}"><span class="df-master-word">${ms.word}</span><span class="df-master-why">${ms.why || ""}</span></div>`;
  },

  2: (D) => {
    const ls = D.ls, oi = D.oi;
    const spot = oi ? oi.spot : (ls && ls.spot);
    const kl = (ls && ls.keyLevels) || [];
    const sup = kl.find((l) => l.label === "KEY SUPPORT"), res = kl.find((l) => l.label === "KEY RESISTANCE");
    const sup2 = kl.find((l) => l.label === "SECOND SUPPORT"), res2 = kl.find((l) => l.label === "SECOND RESISTANCE");
    const W = oi && oi.walls;
    const trig = ls && ls.trigger ? ls.trigger.level : null;
    const inval = ls && ls.invalidation ? ls.invalidation.level : null;
    const lvl = (price, tag, cls, room) => price == null ? "" : `<div class="df-lvl ${cls}"><span class="df-price mono">${dfNum(price, 0)}</span><span class="df-tag">${tag}</span><span class="df-room mono">${room}</span></div>`;
    const roomTxt = (p) => (p != null && spot != null) ? (p >= spot ? "+" : "") + Math.round(p - spot) : "";
    return dfHead(2, "Market Map", "Where is price likely to move, and what proves it wrong?") + `
      <div class="df-map">
        ${lvl(res2 ? res2.price : null, "2nd resistance", "res", roomTxt(res2 && res2.price))}
        ${lvl(res ? res.price : null, "Resistance", "res", roomTxt(res && res.price))}
        ${lvl(W && W.bestR ? W.bestR.strike : null, "Call wall / Trigger", "trig", roomTxt(W && W.bestR && W.bestR.strike))}
        <div class="df-lvl df-lvl-spot"><span class="df-price mono">${dfNum(spot, 0)}</span><span class="df-tag" style="color:var(--text)">◉ Spot${ls && ls.structure && ls.structure.vwapValue ? " · VWAP " + dfNum(ls.structure.vwapValue, 0) : ""}</span><span class="df-room">—</span></div>
        ${lvl(W && W.bestS ? W.bestS.strike : null, "Put wall / Support", "sup", roomTxt(W && W.bestS && W.bestS.strike))}
        ${lvl(sup ? sup.price : null, "Support", "sup", roomTxt(sup && sup.price))}
        ${lvl(sup2 ? sup2.price : null, "2nd support", "sup", roomTxt(sup2 && sup2.price))}
        <div class="df-map-foot">
          <div><span class="df-k">Trigger</span><span class="df-v up">${trig != null ? "> " + dfNum(trig, 0) : "—"}</span></div>
          <div><span class="df-k">Invalidation</span><span class="df-v down">${inval != null ? "< " + dfNum(inval, 0) : "—"}</span></div>
          <div><span class="df-k">Upside room</span><span class="df-v up">${res && spot != null ? "+" + Math.round(res.price - spot) + " pts" : "—"}</span></div>
          <div><span class="df-k">Downside room</span><span class="df-v down">${sup && spot != null ? "−" + Math.round(spot - sup.price) + " pts" : "—"}</span></div>
        </div>
      </div>`;
  },

  3: (D) => {
    const rows = (D.scan && D.scan.rows) || [];
    if (!rows.length) return dfHead(3, "Liquidity Watchlist", "Where is the strongest opportunity?") + `<div class="df-na">Scanner has no rows yet — market data unavailable.</div>`;
    const badge = (txt, cls) => `<span class="df-badge ${cls}">${txt}</span>`;
    const stageCls = (s) => /STRONG|DEVELOP/.test(s) ? "b-up" : /EXTEND|REVERSAL/.test(s) ? "b-dn" : /BREAKOUT/.test(s) ? "b-wait" : "b-neu";
    const actCls = (a) => a === "TAKE" ? "b-up" : a === "BREAKOUT READY" ? "b-up" : a === "AVOID CHASING" ? "b-dn" : "b-neu";
    const body = rows.slice(0, 12).map((r, i) => {
      if (r.dataState !== "OK") return `<tr><td class="rank">${i + 1}</td><td class="sym">${r.name}</td><td>—</td><td>—</td><td colspan="6" class="neu">${badge("DATA UNAVAILABLE", "b-neu")}</td><td>${badge("WAIT", "b-neu")}</td></tr>`;
      return `<tr><td class="rank">${i + 1}</td><td class="sym">${r.name}</td><td>${dfNum(r.price)}</td><td>${r.score}</td>
        <td class="${dfBiasCls(r.bias)}">${r.bias}</td><td>${badge(r.stage, stageCls(r.stage))}</td>
        <td>${r.trigger != null ? dfNum(r.trigger) : "—"}</td><td class="down">${r.invalidation != null ? dfNum(r.invalidation) : "—"}</td>
        <td>${badge(r.action, actCls(r.action))}</td></tr>`;
    }).join("");
    return dfHead(3, "Liquidity Watchlist", "Where is the strongest opportunity? — ranked by the existing Liquidity Score.") + `
      <div class="df-twrap"><table>
        <thead><tr><th>#</th><th>Symbol</th><th>Price</th><th>Score</th><th>Bias</th><th>Stage</th><th>Trigger</th><th>Invalid.</th><th>Action</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="df-note">Rows come from the Watchlist early-warning scanner (reuses the Liquidity Status engine). Ranked by score; stale feeds show DATA UNAVAILABLE — never an automatic BUY.</p>`;
  },

  4: (D) => {
    const ls = D.ls;
    if (!ls) return dfHead(4, "Trader Mind · NIFTY", "Why is this a setup?") + `<div class="df-na">DATA UNAVAILABLE</div>`;
    const st = ls.structure, ev = ls.evidence || [];
    const evTxt = ev.length ? ev.map((e) => `${e.side} ${e.strike || ""}: ${e.interpretation}`).join(" · ") : "OI baseline not established yet";
    return dfHead(4, "Trader Mind · NIFTY", "Why does the system see this as an opportunity? — an explanation, not a new strategy.") + `
      <div class="df-two">
        <div class="df-panel"><div class="df-panel-h">Evidence</div>
          ${dfRow("Liquidity", (ls.liquidityFlowScore && ls.liquidityFlowScore.score) + " · " + (ls.directionalConfidence && ls.directionalConfidence.quality), "")}
          ${dfRow("Trend / EMA", st ? st.emaStructure : "—", dfBiasCls(st && st.emaStructure === "Strong Bullish" ? "Bullish" : st && st.emaStructure === "Strong Bearish" ? "Bearish" : "Neutral"))}
          ${dfRow("VWAP", st ? st.vwapStatus : "—")}
          ${dfRow("Momentum", st && st.rsi != null ? "RSI " + Math.round(st.rsi) : "—")}
          ${dfRow("RVOL", ls.rvol != null ? ls.rvol.toFixed(2) + "×" : "—", ls.rvol >= 1.3 ? "up" : "neu")}
          ${dfRow("Move stage", ls.moveStage ? ls.moveStage.replace(/_/g, " ") : "—")}
        </div>
        <div class="df-panel"><div class="df-panel-h">Plain-language read</div>
          <p class="df-say">${ls.systemView || "—"}</p>
          <p class="df-say muted">${ls.traderPreparation || ""}</p>
          <p class="df-say" style="color:var(--amber)">OI evidence: ${evTxt}</p>
        </div>
      </div>`;
  },

  5: (D) => {
    const ls = D.ls, oi = D.oi;
    const arb = oi && oi.ext && oi.ext.arbitration;
    const word = arb ? arb.verdict : (ls ? String(ls.traderAction) : "DATA UNAVAILABLE");
    const wcls = /GO|TAKE|PREPARE/i.test(word) ? "up" : /CONFLICT|AVOID/i.test(word) ? "down" : "warn";
    const conf = ls && ls.confirmations;
    let reasons = "";
    if (conf) {
      reasons = conf.confirmed.map((c) => `<div class="df-chk ok"><span class="df-ico">✓</span><span class="df-clab">${c.label}</span><span class="df-cst">confirmed</span></div>`).join("") +
        conf.remaining.map((c) => `<div class="df-chk pend"><span class="df-ico">⏳</span><span class="df-clab">${c.label}</span><span class="df-cst">pending</span></div>`).join("");
    } else reasons = `<div class="df-na">DATA UNAVAILABLE</div>`;
    const trig = ls && ls.trigger ? ls.trigger.level : null, inval = ls && ls.invalidation ? ls.invalidation.level : null;
    return dfHead(5, "Setup · Master Trade Selector", "Should I trade now? — the existing Master decision, unchanged.") + `
      <div class="df-two">
        <div class="df-panel df-setup-l">
          <div class="df-panel-h">Master Decision</div>
          <div class="df-setup-word ${wcls}">${word}</div>
          <div class="df-lvlrow">
            <div><span class="df-k">Trigger</span><span class="df-v up">${trig != null ? "> " + dfNum(trig, 0) : "—"}</span></div>
            <div><span class="df-k">Invalidation</span><span class="df-v down">${inval != null ? "< " + dfNum(inval, 0) : "—"}</span></div>
          </div>
          ${arb && arb.reason ? `<p class="df-say muted">${arb.reason}</p>` : ""}
        </div>
        <div class="df-panel"><div class="df-panel-h">Reasons</div>${reasons}</div>
      </div>
      <p class="df-note">This is the existing Master Trade Selector verdict + confirmation reasons, shown larger. Its logic is not modified.</p>`;
  },

  6: (D) => {
    const oi = D.oi;
    const leg = (oi && oi.recommendation && oi.recommendation.directional) || (oi && oi.setup) || null;
    if (!leg || !leg.optionType || leg.optionType === "—") return dfHead(6, "Best Option Play", "Which contract fits?") + `<div class="df-na">NO OPTION EDGE — no valid underlying setup right now.</div>`;
    const legLive = leg.take;
    const premChg = leg.optionType === "PE" ? oi.putLtpChgPct : oi.callLtpChgPct;
    return dfHead(6, "Best Option Play", "If confirmed, which contract? — from the existing Option Engine, guardrails intact.") + `
      <div class="df-panel" style="max-width:640px">
        <div class="df-opt-head"><span class="df-opt-strike mono">${leg.strike ? dfNum(leg.strike, 0) + " " + leg.optionType : leg.optionType}</span>
          <span class="df-badge ${dfBiasCls(leg.optionType === "CE" ? "Bullish" : "Bearish")}">${leg.optionType === "CE" ? "▲ BULLISH" : "▼ BEARISH"}</span>
          <span class="df-badge ${legLive ? "b-up" : "b-wait"}">${legLive ? "OPTION CONFIRMED" : "PREMIUM CONFIRMATION PENDING"}</span></div>
        <div class="df-two" style="grid-template-columns:1fr 1fr">
          <div>${dfRow("Premium (LTP)", leg.ltp != null ? "₹" + dfNum(leg.ltp, 2) : "—")}
            ${dfRow("Premium momentum", premChg == null ? "—" : premChg > 0 ? "↑ rising" : premChg < 0 ? "↓ falling" : "• flat", premChg > 0 ? "up" : premChg < 0 ? "down" : "neu")}
            ${dfRow("Confidence", leg.confidence != null ? leg.confidence + "/100" : "—")}</div>
          <div>${dfRow("Target", leg.target != null ? "₹" + dfNum(leg.target, 2) : "—", "up")}
            ${dfRow("Stop", leg.stop != null ? "₹" + dfNum(leg.stop, 2) : "—", "down")}
            ${dfRow("Horizon", leg.horizon || "intraday")}</div>
        </div>
      </div>
      <p class="df-note">The option appears only when a valid underlying setup exists — never just because NIFTY is bullish. Existing option-buying guardrails remain active; fields not in the feed (Delta/IV) are omitted rather than invented.</p>`;
  },

  7: (D) => {
    const ls = D.ls;
    if (!ls || !ls.confirmations) return dfHead(7, "Trade Confirmation", "Are all required conditions satisfied?") + `<div class="df-na">DATA UNAVAILABLE</div>`;
    const items = [...ls.confirmations.confirmed.map((c) => ({ l: c.label, ok: true })), ...ls.confirmations.remaining.map((c) => ({ l: c.label, ok: false }))];
    const allOk = ls.confirmations.remaining.length === 0;
    const checks = items.map((it) => `<div class="df-chk ${it.ok ? "ok" : "pend"}"><span class="df-ico">${it.ok ? "✓" : "⏳"}</span><span class="df-clab">${it.l}</span><span class="df-cst">${it.ok ? "confirmed" : "pending"}</span></div>`).join("");
    return dfHead(7, "Trade Confirmation", "Are all required conditions satisfied before execution?") + `
      <div class="df-panel" style="max-width:760px">
        <div class="df-checks">${checks}</div>
        <div class="df-master df-master-${allOk ? "go" : "wait"}" style="margin-top:14px"><span class="df-master-word">${allOk ? "TAKE" : "WAIT"}</span>
          <span class="df-master-why">${allOk ? "All tracked conditions satisfied." : ls.confirmations.remaining.length + " condition(s) still pending. This gate prevents accidental execution."}</span></div>
      </div>`;
  },

  8: (D) => {
    const oi = D.oi;
    const leg = (oi && oi.recommendation && oi.recommendation.directional) || (oi && oi.setup) || null;
    const legTxt = leg && leg.optionType && leg.optionType !== "—" ? `${dfNum(leg.strike, 0)} ${leg.optionType} @ ₹${dfNum(leg.ltp, 2)}` : "no active option candidate";
    return dfHead(8, "Trade Execution", "Place the trade — quantity and max-loss from the existing capital-risk rule.") + `
      <div class="df-panel" style="max-width:560px">
        <div class="df-opt-head"><span class="df-opt-strike mono" style="font-size:18px">${legTxt}</span></div>
        <p class="df-say muted">Execution runs on the existing <b>AI Paper Desk</b> under its capital-risk sizing and guardrails. <b>LIVE_ORDER_EXECUTION=false</b> stays enforced — this is paper only.</p>
        <div class="df-btns"><button type="button" class="df-btn go" data-df-desk="option" data-df-tab="paper">Open AI Paper Desk →</button><button type="button" class="df-btn ghost" data-df-goto="5">Back to Setup</button></div>
      </div>`;
  },

  9: (D) => {
    const paper = D.paper;
    const open = (paper && paper.open || []).filter((p) => p.kind === "indexOption");
    if (!open.length) return dfHead(9, "Live Position", "Hold or exit?") + `<div class="df-na">No open index-option position. When a paper trade is live it appears here.</div>`;
    const rows = open.map((p) => `<div class="df-pos-strip">
        <div class="df-pos-cell"><div class="df-k">Option</div><div class="df-v">${p.strike || ""} ${p.optionType || ""}</div></div>
        <div class="df-pos-cell"><div class="df-k">Entry</div><div class="df-v">₹${dfNum(p.entry, 2)}</div></div>
        <div class="df-pos-cell"><div class="df-k">Current</div><div class="df-v">₹${dfNum(p.ltp != null ? p.ltp : p.current, 2)}</div></div>
        <div class="df-pos-cell"><div class="df-k">P&L</div><div class="df-v ${(p.pnl || 0) >= 0 ? "up" : "down"}">${p.pnl != null ? (p.pnl >= 0 ? "+" : "") + "₹" + dfNum(p.pnl, 0) : "—"}</div></div>
        <div class="df-pos-cell"><div class="df-k">Target</div><div class="df-v">${p.target != null ? "₹" + dfNum(p.target, 2) : "—"}</div></div>
        <div class="df-pos-cell"><div class="df-k">Stop</div><div class="df-v down">${p.stop != null ? "₹" + dfNum(p.stop, 2) : "—"}</div></div>
      </div>`).join("");
    return dfHead(9, "Live Position", "Hold or exit? — the existing trade-management logic remains the authority.") + rows +
      `<p class="df-note">Read live from the AI Paper Desk. Hold/exit decisions stay with the existing trade-management engine.</p>`;
  },

  10: (D) => {
    const paper = D.paper;
    const closed = (paper && (paper.closed || paper.recent) || []).slice(0, 8);
    if (!closed.length) return dfHead(10, "Trade Result · Journal", "What happened?") + `<div class="df-na">No closed trades yet today.</div>`;
    const body = closed.map((t) => {
      const pnl = t.pnl != null ? t.pnl : (t.pnlAbs != null ? t.pnlAbs : null);
      const win = pnl != null ? (pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BE") : "—";
      return `<tr><td class="sym">${t.symbol || t.strike || "—"} ${t.optionType || ""}</td><td>₹${dfNum(t.entry, 2)}</td><td>₹${dfNum(t.exit != null ? t.exit : t.exitPrice, 2)}</td>
        <td class="${pnl >= 0 ? "up" : "down"}">${pnl != null ? (pnl >= 0 ? "+" : "") + "₹" + dfNum(pnl, 0) : "—"}</td>
        <td><span class="df-badge ${win === "WIN" ? "b-up" : win === "LOSS" ? "b-dn" : "b-neu"}">${win}</span></td></tr>`;
    }).join("");
    return dfHead(10, "Trade Result · Journal", "What happened, and how good was the signal?") + `
      <div class="df-twrap"><table><thead><tr><th>Trade</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Result</th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="df-note">Live from the AI Paper Desk's closed trades. Full excursion / signal-quality tagging feeds the 20-session validation (step 12).</p>`;
  },

  11: (D) => {
    const paper = D.paper;
    const s = paper && paper.summary ? paper.summary : paper || {};
    return dfHead(11, "Daily Trading Review", "How did the session go? — read, don't over-fit to one day.") + `
      <div class="df-cc-top" style="grid-template-columns:repeat(4,1fr)">
        <div class="df-stat"><div class="df-lab">Trades</div><div class="df-big mono">${s.tradesToday != null ? s.tradesToday : (s.totalTrades != null ? s.totalTrades : "—")}</div></div>
        <div class="df-stat"><div class="df-lab">Wins</div><div class="df-big mono up">${s.wins != null ? s.wins : "—"}</div></div>
        <div class="df-stat"><div class="df-lab">Losses</div><div class="df-big mono down">${s.losses != null ? s.losses : "—"}</div></div>
        <div class="df-stat"><div class="df-lab">P&L</div><div class="df-big mono ${(s.pnlToday || s.totalPnl || 0) >= 0 ? "up" : "down"}">${(s.pnlToday != null ? s.pnlToday : s.totalPnl) != null ? "₹" + dfNum(s.pnlToday != null ? s.pnlToday : s.totalPnl, 0) : "—"}</div></div>
      </div>
      <p class="df-note">Summary from the AI Paper Desk. Projection-accuracy and WAIT-discipline breakdowns are compiled in the 20-session validation. Do not tune the strategy from a single day.</p>`;
  },

  12: () => dfHead(12, "20-Session Validation", "Is the edge real across a forward window? — analytics, separate from daily noise.") + `
      <div class="df-planned">
        <b>Forward-test tracker (sessions 1–20).</b><br>
        Aggregates the Journal (step 10) across sessions from the existing audit logs (option-top-pick, liquidity-status, decision-log): cumulative P&L, win-rate & avg-R trend, direction accuracy, and 5M/15M/30M projection-range hit-rate — plus WAIT-discipline and false-signal counts. Purpose is validation, not tuning.<br><br>
        <span class="wl-sub">Charts render here once ≥1 session of forward data is logged. This view reads existing logs only — it never changes the strategy.</span>
      </div>`,

  13: (D) => {
    const oi = D.oi, S = (oi && oi.oiSummary) || null, chain = (oi && oi.oiChain) || [];
    if (!oi || (!S && !chain.length)) return dfHead(13, "OI Details", "Where is the open interest?") + `<div class="df-na">OI DATA UNAVAILABLE — no option-chain read for this index right now.</div>`;
    const dir = oi.oiDirection, conf = oi.oiConfidence;
    const dirTxt = dir === "UP" ? "▲ BULLISH" : dir === "DOWN" ? "▼ BEARISH" : "• FLAT";
    const dirCls = dir === "UP" ? "up" : dir === "DOWN" ? "down" : "neu";
    const pcr = S ? S.pcr : null;
    const pcrCls = pcr == null ? "neu" : pcr >= 1.1 ? "up" : pcr <= 0.9 ? "down" : "neu";
    const feverCls = S && S.feverSide === "PUT" ? "up" : S && S.feverSide === "CALL" ? "down" : "neu";
    // Chain slice around ATM (max ~11 rows), most OI-heavy strikes stay visible.
    const rows = chain.slice(0, 21);
    const oiN = (n) => n == null ? "—" : Math.abs(n) >= 1e7 ? (n / 1e7).toFixed(2) + "Cr" : Math.abs(n) >= 1e5 ? (n / 1e5).toFixed(2) + "L" : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n));
    const pctTxt = (p) => p == null ? "" : (p >= 0 ? "+" : "") + fmt(p, 1) + "%";
    const body = rows.map((r) => `<tr class="${r.atm ? "df-atm" : ""}">
        <td class="${(r.ce.oiChgPct || 0) < 0 ? "up" : ""}">${pctTxt(r.ce.oiChgPct)}</td>
        <td>${oiN(r.ce.oi)}</td>
        <td class="sym">${dfNum(r.strike, 0)}${r.atm ? " ·ATM" : ""}</td>
        <td>${oiN(r.pe.oi)}</td>
        <td class="${(r.pe.oiChgPct || 0) > 0 ? "up" : ""}">${pctTxt(r.pe.oiChgPct)}</td>
      </tr>`).join("");
    return dfHead(13, "OI Details · " + (oi.name || "") , "Where is the open interest sitting, and which side is building? — from the existing OI engine.") + `
      <div class="df-cc-top" style="grid-template-columns:repeat(4,1fr)">
        <div class="df-stat"><div class="df-lab">OI Verdict</div><div class="df-big ${dirCls}" style="font-size:17px">${dirTxt}</div><div class="df-sub">confidence ${conf != null ? conf : "—"}${conf != null ? "/100" : ""}</div></div>
        <div class="df-stat"><div class="df-lab">PCR</div><div class="df-big mono ${pcrCls}">${pcr != null ? fmt(pcr, 2) : "—"}</div><div class="df-sub">${pcr == null ? "" : pcr >= 1.1 ? "put-heavy · bullish" : pcr <= 0.9 ? "call-heavy · bearish" : "balanced"}</div></div>
        <div class="df-stat"><div class="df-lab">Max Pain</div><div class="df-big mono">${S && S.maxPain != null ? dfNum(S.maxPain, 0) : "—"}</div><div class="df-sub">expiry ${S && S.expiry ? S.expiry : "—"}</div></div>
        <div class="df-stat"><div class="df-lab">CE / PE fever</div><div class="df-big mono ${feverCls}">${S && S.callPct != null ? S.callPct + "/" + S.putPct + "%" : "—"}</div><div class="df-sub">${S && S.feverSide ? S.feverSide + " side" : ""}</div></div>
      </div>
      <div class="df-panel" style="margin-bottom:12px"><div class="df-panel-h">Writing walls</div>
        <div class="df-oi-walls">
          ${dfRow("Call wall (resistance)", S && S.callWall ? dfNum(S.callWall.strike, 0) + "  ·  " + oiN(S.callWall.oi) : "—", "down")}
          ${dfRow("Put wall (support)", S && S.putWall ? dfNum(S.putWall.strike, 0) + "  ·  " + oiN(S.putWall.oi) : "—", "up")}
          ${dfRow("Net CE OI Δ", S && S.netCeChg != null ? oiN(S.netCeChg) : "—", (S && S.netCeChg < 0) ? "up" : "down")}
          ${dfRow("Net PE OI Δ", S && S.netPeChg != null ? oiN(S.netPeChg) : "—", (S && S.netPeChg > 0) ? "up" : "down")}
        </div>
        ${S && S.fever ? `<p class="df-say muted" style="margin-top:6px">${S.fever}</p>` : ""}
      </div>
      <div class="df-panel"><div class="df-panel-h">Option chain around ATM · <span class="down">CE ← calls</span> / <span class="up">puts → PE</span></div>
        <div class="df-twrap"><table class="df-oi-chain">
          <thead><tr><th>CE Δ%</th><th>CE OI</th><th class="df-oi-strike">Strike</th><th>PE OI</th><th>PE Δ%</th></tr></thead>
          <tbody>${body || `<tr><td colspan="5" class="neu">chain unavailable</td></tr>`}</tbody>
        </table></div>
      </div>
      <p class="df-note">Read from the existing OI engine (same chain that drives the arbiter): CALL columns on the left, PUT on the right, ATM row highlighted. Rising put OI at a strike builds support; rising call OI builds resistance. Advisory only.</p>`;
  },
};

async function loadOiCommand() {
  const box = el("oicommand");
  const sym = (el("oic-symbol") && el("oic-symbol").value) || "^NSEI";
  const st = el("oic-status");
  if (st) st.textContent = "लोड हो रहा…";
  try {
    const d = await fetchJSON("/api/oi-command?symbol=" + encodeURIComponent(sym), 25000);
    // A stray 401 here (session expired mid-session, or a request that raced
    // login) is a session problem, not a "no data available" one - rendering
    // the server's raw {error:"Unauthorized..."} into the panel as if it were
    // a normal message is exactly what made a transient auth hiccup look like
    // a permanent, stuck "invalid login" screen. Leave the panel as it was
    // and let the next 15s auto-refresh (startOiCommandLive) retry instead.
    if (d && d.error === "Unauthorized. Please log in.") { if (st) st.textContent = ""; return; }
    if (!d.available && !d.bulletin) { if (box) box.innerHTML = `<div class="wl-sub">${d.message || d.error || "उपलब्ध नहीं"}</div>`; if (st) st.textContent = ""; return; }
    // Paint the cockpit IMMEDIATELY from the oi-command payload. The liquidity
    // detection card is an EXTRA feed call the cockpit doesn't need to first-
    // paint, so it no longer blocks this render (it used to add seconds on the
    // slow first load). Fetch it in the background and re-render once it lands;
    // the stepper preserves its selected step across re-renders via cockpitStep.
    renderLive("oicommand", () => renderMasterSelector(d));
    loadLiquidityStatus(sym).then(() => {
      const stillSame = ((el("oic-symbol") && el("oic-symbol").value) || "^NSEI") === sym;
      const pn = document.getElementById("panel-oicommand");
      if (stillSame && pn && pn.classList.contains("active")) renderLive("oicommand", () => renderMasterSelector(d));
    }).catch(() => {});
    // Mobile hero: only on phone widths (it's display:none on desktop, and it
    // makes 3 extra API calls that otherwise contend on the feed for nothing).
    if (window.innerWidth <= 640) renderMobileTraderHero(d, sym);
    // Freshness: the OI/candle data behind this screen is cached server-side
    // (routes/api.ts already computes dataAgeSec/refresh) - surface it so "is
    // this actually live" is visible rather than implicit.
    if (st) {
      const age = d.dataAgeSec != null ? Math.round(d.dataAgeSec) : null;
      const live = d.refresh?.marketOpen !== false && age != null && age < 60;
      st.innerHTML = age == null ? "" : live ? `<span class="live-dot"></span> as of ${age}s ago` : `as of ${age}s ago`;
    }
  } catch (e) {
    if (st) st.textContent = e.name === "AbortError" ? "timeout" : "Failed: " + e.message;
  }
}
function startOiCommandLive() {
  if (state.oicTimer) return;
  state.oicTimer = setInterval(() => {
    const pn = document.getElementById("panel-oicommand");
    if (pn && pn.classList.contains("active") && isMarketOpen()) loadOiCommand();
  }, 15 * 1000); // auto-refresh every 15s (matches the mockup)
}
function startLiquidityStatusLive() {
  if (state.lsTimer) return;
  state.lsTimer = setInterval(() => {
    const pn = document.getElementById("panel-liquiditystatus");
    if (pn && pn.classList.contains("active") && isMarketOpen()) loadLiquidityStatusScreen();
  }, 15 * 1000);
}
function startStockLive() {
  if (state.stockTimer) return;
  state.stockTimer = setInterval(() => {
    const pn = document.getElementById("panel-stock");
    if (pn && pn.classList.contains("active") && isMarketOpen() && state.active) loadSymbol(state.active);
  }, 15 * 1000);
}
function oicPaperGate(d) {
  const rec = d.recommendation || {};
  const dir = rec.directional || {};
  const sc = rec.scalp || {};
  const c = d.correlate || {};
  const chips = [];
  chips.push({ ok: !!d.hasBaseline, t: d.hasBaseline ? "baseline" : "no baseline" });
  chips.push({ ok: !d.stale, t: d.stale ? "stale " + (d.dataAgeSec || "") + "s" : "chain fresh" });
  chips.push({ ok: d.oiDirection !== "FLAT", t: "OI " + (d.oiDirection || "—") });
  const take = !!(dir.take || sc.take);
  chips.push({ ok: take, t: take ? "TAKE" : "no TAKE" });
  const cons = c.consensus || "—";
  const consOk = cons === "AGREE" || (cons === "MIXED" && !!(dir.algoReady || sc.algoReady));
  chips.push({ ok: consOk && cons !== "CONFLICT", t: "models " + cons });
  chips.push({ ok: !!(dir.algoReady || sc.algoReady), t: (dir.algoReady || sc.algoReady) ? "algo ≥68" : "conf <68" });
  if (d.refresh && d.refresh.marketOpen === false) chips.push({ ok: false, t: "session closed" });
  return { go: chips.every((x) => x.ok), chips, dir, sc, c };
}
function oicLevelMap(d) {
  const L = d.levels || {};
  const corr = d.correlate || {};
  const rows = [
    { p: L.pdh, lab: "PDH", k: "r" },
    { p: L.strongResistance && L.strongResistance.strike, lab: "R+", k: "r" },
    { p: L.weakResistance && L.weakResistance.strike, lab: "R", k: "r" },
    { p: L.orbHigh, lab: "ORH", k: "n" },
    { p: corr.vwap, lab: "VWAP", k: "v" },
    { p: d.spot, lab: "SPOT", k: "s" },
    { p: d.management && d.management.invalidation, lab: "INV", k: "x" },
    { p: L.orbLow, lab: "ORL", k: "n" },
    { p: L.weakSupport && L.weakSupport.strike, lab: "S", k: "g" },
    { p: L.strongSupport && L.strongSupport.strike, lab: "S+", k: "g" },
    { p: L.pdl, lab: "PDL", k: "g" },
  ].filter((x) => x.p != null && Number(x.p) > 0);
  const seen = new Set();
  const uniq = [];
  rows.forEach((x) => {
    const key = x.lab + ":" + Math.round(Number(x.p));
    if (seen.has(key)) return;
    seen.add(key);
    uniq.push({ ...x, p: Number(x.p) });
  });
  uniq.sort((a, b) => b.p - a.p);
  return uniq;
}
function oicPremiumBar(entry, stop, ltp, target) {
  const nums = [entry, stop, ltp, target].filter((x) => x != null && Number(x) > 0).map(Number);
  if (nums.length < 2) return "";
  const lo = Math.min(...nums), hi = Math.max(...nums), span = Math.max(0.01, hi - lo);
  const pos = (v) => (v == null ? null : ((Number(v) - lo) / span) * 100);
  const mk = (v, cls, lab) => {
    const p = pos(v);
    if (p == null) return "";
    return `<i class="oic-pmk ${cls}" style="left:${p}%"><em>${lab}</em></i>`;
  };
  return `<div class="oic-pbar">${mk(stop, "dn", "SL")}${mk(entry, "en", "IN")}${mk(ltp, "now", "NOW")}${mk(target, "up", "TG")}</div>`;
}
// Intelligent Market Commentary card (pure Hindi) — renders the backend commentary engine
// output: levels, situation, reasons, bull/bear cases, market path, aggressive writers,
// writer battle, next confirmation, trader guidance and the system conclusion.
// Split from one big renderCommentaryHtml() into three focused cards
// (levels / writer battle / analysis) so the Dashboard Grid layout can place
// them as independent cards a trader scans side by side, instead of one long
// vertical block. Same content as before, none of it dropped - the situation
// text/reasons/scenario/guidance just now live together under one "Analysis"
// card instead of being spread across an always-open column.

function renderLevelsCardHtml(C) {
  if (!C) return "";
  const gN = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
  const L = C.levels || {};
  // Stacked rows, not the old 5-across box grid - this card is now a quarter
  // of the row's width (Dashboard Grid), where 5 side-by-side boxes would be
  // too cramped to read.
  return `
    <div class="mtg-card">
      <h5>Key levels</h5>
      <div class="o2-lv"><span class="down">Major resistance</span><b>${gN(L.majorResistance)}</b></div>
      <div class="o2-lv"><span class="down">Immediate resistance</span><b>${gN(L.immResistance)}</b></div>
      <div class="o2-lv mtc-lv-spot"><span>Spot / price</span><b>${gN(L.price)}</b></div>
      <div class="o2-lv"><span class="up">Immediate support</span><b>${gN(L.immSupport)}</b></div>
      <div class="o2-lv"><span class="up">Major support</span><b>${gN(L.majorSupport)}</b></div>
    </div>`;
}

function renderWriterBattleHtml(C) {
  if (!C) return "";
  const gN = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
  const wb = C.writerBattle || {};
  const callPct = wb.callPct != null ? wb.callPct : 50;
  const putPct = wb.putPct != null ? wb.putPct : 50;
  return `
    <div class="mtg-card">
      <h5>Writer battle</h5>
      <div class="mtc-writers">
        <span class="mtc-agg call">🔥 CALL writer — ${gN(C.aggressiveCallWriter)}</span>
        <span class="mtc-agg put">🔥 PUT writer — ${gN(C.aggressivePutWriter)}</span>
      </div>
      <div class="mtc-battle">
        <div class="mtc-battle-bar"><i class="call" style="width:${callPct}%"></i><i class="put" style="width:${putPct}%"></i></div>
        <div class="mtc-battle-lab"><span class="down">CALL writers ${callPct}%</span><span class="up">PUT writers ${putPct}%</span></div>
        ${wb.note ? `<div class="mtc-battle-note">${wb.note}</div>` : ""}
      </div>
    </div>`;
}

// OI walls quick-reference (from d.oiSummary, the same source the full OI
// Details drawer uses) - a glanceable summary card; the toggleable drawer
// right below the hero row still has the full chain/wall detail.
function renderOiWallsCardHtml(d) {
  const S = d.oiSummary || {};
  const gN = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
  const biasCls = S.bias === "Bullish" ? "up" : S.bias === "Bearish" ? "down" : "";
  return `
    <div class="mtg-card">
      <h5>OI walls</h5>
      <div class="o2-lv"><span class="down">Call writing wall</span><b>${gN(S.callWall && S.callWall.strike)}</b></div>
      <div class="o2-lv"><span class="up">Put writing wall</span><b>${gN(S.putWall && S.putWall.strike)}</b></div>
      <div class="o2-lv"><span>Max pain / ATM</span><b>${gN(S.maxPain)}</b></div>
      <div class="o2-lv"><span>Bias</span><b class="${biasCls}">${S.bias || "—"}</b></div>
    </div>`;
}

// Macro Setup card (NIFTY only) - global markets / morning sector leader /
// Bank Nifty / IT-majors votes, from backend/paper/ext/macroSetup.ts's
// computeNiftyMacroSetup (attached server-side as d.macroSetup, NIFTY only).
// ---------- Liquidity Status card (development display) ----------
// Sits in the same .mtg-grid as Macro Setup, filling the slot next to it (and the
// blank that Macro Setup leaves on non-NIFTY symbols). Same .mtg-card/.o2-lv
// classes as the neighbouring cards — the dashboard layout is not redesigned.
//
// DETECTION DISPLAY ONLY. No value here gates an entry: the backend route is not
// read by tryOpenOption() or the Master Trade Selector.
function renderLiquidityCardHtml() {
  const L = state.liquidity;
  const shell = (inner) => `<div class="mtg-card liq-card liq-wide">
      <div class="liq-head"><h5>Liquidity Status</h5><span class="liq-advisory">DETECTION ONLY · NO TRADING GATE</span></div>
      ${inner}</div>`;
  if (!L) return shell('<div class="wl-sub">लोड हो रहा…</div>');
  if (L.error) return shell(`<div class="wl-sub">${L.error}</div>`);

  const n = (v) => (v == null ? "—" : Math.round(Number(v) * 100) / 100);
  const det = L.detection || {};
  const or = L.openingRange || {};
  const byType = {};
  for (const lv of L.levels || []) byType[lv.type] = lv;

  // A level cell: shows the price, or NOT DEFINED (with the reason on hover) for
  // the items whose definition was never supplied.
  const lvVal = (t) => {
    const lv = byType[t];
    if (!lv) return '<b>—</b>';
    if (lv.price == null) {
      return lv.note ? `<b class="liq-undef" title="${lv.note}">NOT DEFINED</b>` : "<b>—</b>";
    }
    return `<b>${n(lv.price)}</b>`;
  };
  const pair = (label, t) => `<div class="liq-pair"><span>${label}</span>${lvVal(t)}</div>`;
  const tile = (label, t) => `<div class="liq-tile"><span>${label}</span>${lvVal(t)}</div>`;

  const ev = det.eventType || "NONE";
  const evCls = ev === "SWEEP" ? "sweep" : ev === "REAL_BREAK" ? "break" : ev === "TRAP" ? "trap" : "none";
  const evTxt = ev === "REAL_BREAK" ? "REAL BREAK" : ev;
  const dir = det.direction && det.direction !== "NONE" ? det.direction : "NONE";
  const dirTxt = dir === "UP" ? "BULLISH" : dir === "DOWN" ? "BEARISH" : dir === "BOTH" ? "BOTH" : "NONE";
  const dirCls = dir === "UP" ? "up" : dir === "DOWN" ? "down" : "";

  // Detail chips — only rendered when the detector actually produced them.
  const chips = [
    det.sweep ? `<span class="liq-chip">Sweep <b>${n(det.sweep.sweepPrice)}</b> · wick <b>${n(det.sweep.wickPct)}%</b></span>` : "",
    det.sweep ? `<span class="liq-chip">Reclaim <b>${n(det.sweep.reclaimPrice)}</b></span>` : "",
    det.realBreak ? `<span class="liq-chip">Break <b>${n(det.realBreak.closePrice)}</b> · body <b>${n(det.realBreak.bodyPct)}%</b></span>` : "",
    `<span class="liq-chip">ATR(14) <b>${n(det.atr14)}</b></span>`,
    `<span class="liq-chip">Buffer <b>${n(det.bufferUsed)} pts</b></span>`,
    det.sweepCount != null ? `<span class="liq-chip">Sweeps today <b>${det.sweepCount}</b></span>` : "",
    L.entryConcept && L.entryConcept.direction !== "NONE"
      ? `<span class="liq-chip concept" title="${(L.entryConcept.slConcept || "").replace(/"/g, "&quot;")}">Entry concept <b>${L.entryConcept.direction}</b> · not connected</span>`
      : "",
  ].filter(Boolean).join("");

  const C = L.confirmations || {};

  return shell(`
      <div class="liq-top">
        <section class="liq-box">
          <h6>Opening Range <span class="liq-win">${or.window || "—"}</span></h6>
          <div class="liq-pair"><span>High</span><b>${n(or.high)}</b></div>
          <div class="liq-pair"><span>Low</span><b>${n(or.low)}</b></div>
          <div class="liq-pair"><span>Established</span><b class="${or.established ? "up" : ""}">${or.established ? "YES" : "NO"}</b></div>
        </section>

        <section class="liq-box">
          <h6>Liquidity Levels</h6>
          <div class="liq-pairgrid">
            ${pair("PDH", "PDH")}
            ${pair("PDL", "PDL")}
            ${pair("OR High", "OR_HIGH")}
            ${pair("OR Low", "OR_LOW")}
            ${pair("Week High", "PREV_WEEK_HIGH")}
            ${pair("Week Low", "PREV_WEEK_LOW")}
          </div>
        </section>

        <section class="liq-box liq-eventbox">
          <h6>Current Event</h6>
          <div class="liq-event ${evCls}">${evTxt}</div>
          <div class="liq-pair"><span>Direction</span><b class="${dirCls}">${dirTxt}</b></div>
          <div class="liq-pair"><span>Reclaim</span><b>${det.reclaimed ? "YES" : "NO"}</b></div>
          <div class="liq-pair"><span>Trap flag</span><b class="${det.trapFlag ? "down" : ""}">${det.trapFlag ? "TRAP" : "NO"}</b></div>
        </section>
      </div>

      <div class="liq-strip">
        <h6>Key Liquidity</h6>
        <div class="liq-tiles">
          ${tile("Swing High 5m", "SWING_HIGH_5M")}
          ${tile("Swing Low 5m", "SWING_LOW_5M")}
          ${tile("Max OI CALL", "MAX_OI_CALL_STRIKE")}
          ${tile("Max OI PUT", "MAX_OI_PUT_STRIKE")}
          ${tile("Round Number", "ROUND_NUMBER")}
          ${tile("Equal High", "EQUAL_HIGH")}
          ${tile("Equal Low", "EQUAL_LOW")}
          ${tile("Trendline", "TRENDLINE_TOUCH")}
        </div>
      </div>

      ${det.skipReason ? `<div class="wl-sub liq-skip">${det.skipReason}</div>` : ""}
      <div class="liq-chips">${chips}</div>

      <div class="liq-conf-row">
        <span class="liq-conf"><i>OI</i> ${C.oiNote || "—"}</span>
        <span class="liq-conf"><i>VWAP</i> ${C.vwapNote || "—"}</span>
        <span class="liq-conf"><i>EMA</i> ${C.emaNote || "—"}</span>
        <span class="liq-conf"><i>VIX</i> UNAVAILABLE — not present in this application</span>
      </div>`);
}

// Renders "" for any other symbol (BankNifty/FinNifty/etc, where d.macroSetup
// is absent) so the Dashboard Grid layout is unaffected there - same .mtg-card/
// .o2-lv classes as the cards above, no new CSS needed.
function renderMacroSetupCardHtml(d) {
  const M = d.macroSetup;
  if (!M || !M.votes) return "";
  const biasWord = M.bias === 1 ? "Bullish" : M.bias === -1 ? "Bearish" : "Neutral";
  const biasCls = M.bias === 1 ? "up" : M.bias === -1 ? "down" : "";
  const voteRow = (v) => {
    const cls = v.dir === 1 ? "up" : v.dir === -1 ? "down" : "";
    const arrow = v.dir === 1 ? "▲" : v.dir === -1 ? "▼" : "•";
    const note = (v.note || "").replace(/"/g, "&quot;");
    return `<div class="o2-lv" title="${note}"><span>${v.name}</span><b class="${cls}">${arrow}</b></div>`;
  };
  return `
    <div class="mtg-card">
      <h5>Macro Setup (NIFTY)</h5>
      <div class="o2-lv"><span>Overall</span><b class="${biasCls}">${biasWord} (${M.agree}/${M.agree + M.against})</b></div>
      ${M.votes.map(voteRow).join("")}
    </div>`;
}


// Model-agreement bulletin: does the 5m scalp / 15m scalp / 1h directional
// read all point the same way? d.bulletin was already computed server-side
// (buildMoveBulletin, used internally to gate auto-trade ideas) but had no UI
// anywhere - it only ever existed in a dead, never-called render function
// left over from before this screen's last rewrite. Restored here using the
// same .oic-bull-* styling that was already sitting unused in styles.css.
function renderBulletinHtml(d) {
  const B = d.bulletin;
  if (!B) return "";
  const card = (x, title) => {
    if (!x) return `<div class="oic-bull-card"><span>${title}</span><b class="neu">—</b></div>`;
    const cls = x.dir === "UP" ? "up" : x.dir === "DOWN" ? "down" : "neu";
    const src = (x.sources || []).map((s) => `<i class="${s.dir === "UP" ? "up" : s.dir === "DOWN" ? "down" : "neu"}">${s.name} ${s.dir}</i>`).join("");
    return `<div class="oic-bull-card ${cls}">
      <span>${title} · ${x.barTime || ""}</span>
      <b class="${cls}">${x.dir} ${x.option || ""}</b>
      <em>${x.agree}/${x.total} · conf ${x.conf}</em>
      <div class="oic-bull-src">${src}</div>
    </div>`;
  };
  const dirOf = (x) => (x ? x.dir : "—");
  const arrow = (dir) => (dir === "UP" ? '<i class="up">▲</i>' : dir === "DOWN" ? '<i class="down">▼</i>' : '<i class="neu">–</i>');
  const allAgree = B.scalp5 && B.scalp15 && B.dir1h && B.scalp5.dir === B.scalp15.dir && B.scalp15.dir === B.dir1h.dir && B.scalp5.dir !== "FLAT";
  const summary = `5m ${arrow(dirOf(B.scalp5))} 15m ${arrow(dirOf(B.scalp15))} 1h ${arrow(dirOf(B.dir1h))} — ${allAgree ? "all agree" : "mixed"}`;
  return `<div class="oic-bull">
    <details class="oic-bull-collapse">
      <summary><span class="oic-bull-lead">${B.lead || "Move bulletin"}</span><span class="oic-bull-sum">${summary}</span></summary>
      <div class="oic-bull-row">${card(B.scalp5, "5m SCALP")}${card(B.scalp15, "15m SCALP")}${card(B.dir1h, "1h DIRECTIONAL")}</div>
    </details>
  </div>`;
}

// Live OI Details drawer — option chain (ATM ±5) + writing walls + bias + PCR.
// Renders from d.oiChain / d.oiSummary, which refresh with every 15s poll.
function renderOiDetailsHtml(d) {
  const S = d.oiSummary || {};
  const rows = d.oiChain || [];
  if (!rows.length) return `<div class="wl-sub" style="padding:12px">OI chain not available yet — needs the live Dhan chain during market hours.</div>`;
  const oiL = (n) => (n == null ? "—" : n >= 100000 ? (n / 100000).toFixed(2) + "L" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
  const rupee = (n) => (n == null ? "—" : "₹" + (Math.round(n * 100) / 100));
  const pc = (v) => (v == null ? "" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}%</span>`);
  const maxCe = Math.max(1, ...rows.map((r) => r.ce.oi || 0));
  const maxPe = Math.max(1, ...rows.map((r) => r.pe.oi || 0));
  const callWallK = S.callWall && S.callWall.strike;
  const putWallK = S.putWall && S.putWall.strike;
  const bias = S.bias || "Neutral";
  const biasCls = bias === "Bullish" ? "up" : bias === "Bearish" ? "down" : "neu";
  const callDom = (S.callPct != null && S.putPct != null) ? S.callPct >= S.putPct : null;

  const chainRows = rows.slice().sort((a, b) => b.strike - a.strike).map((r) => {
    const ceW = Math.round(((r.ce.oi || 0) / maxCe) * 100);
    const peW = Math.round(((r.pe.oi || 0) / maxPe) * 100);
    const ceWall = r.strike === callWallK;
    const peWall = r.strike === putWallK;
    return `<tr class="${r.atm ? "oid-atm" : ""}">
      <td class="oid-ce">
        <div class="oid-leg"><span class="oid-oi">${oiL(r.ce.oi)}</span><span class="oid-d">${pc(r.ce.oiChgPct)}</span><span class="oid-ltp">${rupee(r.ce.ltp)}</span></div>
        <div class="oid-bar ce"><i style="width:${ceW}%"></i>${ceWall ? '<em>👑 aggressive call writer</em>' : ""}</div>
      </td>
      <td class="oid-strike">${r.strike}${r.atm ? '<span class="oid-atmtag">ATM</span>' : ""}</td>
      <td class="oid-pe">
        <div class="oid-leg"><span class="oid-ltp">${rupee(r.pe.ltp)}</span><span class="oid-d">${pc(r.pe.oiChgPct)}</span><span class="oid-oi">${oiL(r.pe.oi)}</span></div>
        <div class="oid-bar pe"><i style="width:${peW}%"></i>${peWall ? '<em>👑 aggressive put writer</em>' : ""}</div>
      </td>
    </tr>`;
  }).join("");

  return `
    <div class="oid">
      <div class="oid-cards">
        <div class="oid-card"><span>CALL WRITING WALL</span><b class="down">${callWallK || "—"}</b><small>OI ${oiL(S.callWall && S.callWall.oi)}</small></div>
        <div class="oid-card"><span>PUT WRITING WALL</span><b class="up">${putWallK || "—"}</b><small>OI ${oiL(S.putWall && S.putWall.oi)}</small></div>
        <div class="oid-card"><span>MAX PAIN / ATM</span><b>${S.maxPain || "—"}</b><small>ATM ${S.atmStrike || "—"}</small></div>
        <div class="oid-card"><span>MARKET BIAS</span><b class="${biasCls}">${bias}</b><small>PCR ${S.pcr != null ? S.pcr : "—"}</small></div>
        <div class="oid-card"><span>WRITER PRESSURE</span><b class="${callDom ? "down" : "up"}">${callDom == null ? "—" : callDom ? "CALL writers" : "PUT writers"}</b><small>${S.callPct != null ? S.callPct + "% CE / " + S.putPct + "% PE" : ""}</small></div>
      </div>
      <div class="oid-chainhead"><span class="down">🐻 CALL WRITING (Resistance)</span><span>STRIKE</span><span class="up">🐂 PUT WRITING (Support)</span></div>
      <div class="oid-chainwrap"><table class="oid-chain"><tbody>${chainRows}</tbody></table></div>
      <div class="oid-foot">${S.fever || ""}${S.support ? " · Support " + S.support : ""}${S.resistance ? " · Resistance " + S.resistance : ""}</div>
    </div>`;
}

// ===================== Master Trade Selector (Trader Dashboard main screen) =====================
// Replaces the old cockpit view. Shows SETUP / DIRECTIONAL / SCALP as one decision table,
// the CALL + PUT LTP, and the Final Master Decision — all from the arbiter (d.ext.arbitration),
// which is already mirrored to the central log (arbitration/decision channels).
function renderMasterSelector(d) {
  const box = el("oicommand");
  if (!box) return;
  const money = (v) => (v == null || v === "" ? "—" : "₹" + fmt(v));
  const pctTxt = (v) => (v == null ? "" : (v >= 0 ? "+" : "") + Number(v).toFixed(1) + "%");
  const pctCls = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
  const num = (v) => (v == null ? "—" : fmt(v));

  const X = d.ext || {};
  const arb = X.arbitration || {};
  const rec = d.recommendation || {};
  const dir = rec.directional || {};
  const sc = rec.scalp || {};
  const s = d.setup || {};
  const rng = d.optRange || {};
  const marketClosed = d.refresh && d.refresh.marketOpen === false;

  // Verdict + reason (fall back gracefully when ext/arbitration is absent, e.g. after-hours).
  let verdict = arb.verdict || (marketClosed ? "WAIT" : (d.stale ? "WAIT" : "WAIT"));
  let reason = arb.reason || (marketClosed ? "Market closed — no live signals" : (X.arbitration ? "" : "No sufficiently strong setup"));
  const vcls = verdict === "GO" ? "go" : verdict === "CONFLICT" ? "conflict" : "wait";
  const selectedMode = verdict === "GO" ? (arb.primary && arb.primary.mode) : null;
  const vWord = verdict === "GO" ? "ट्रेड" : verdict === "CONFLICT" ? "असहमति" : "प्रतीक्षा";
  const C = d.commentary || null;

  // Direction label for a leg / setup.
  const dirBadge = (optType) => {
    const t = optType || (d.oiDirection === "UP" ? "CE" : d.oiDirection === "DOWN" ? "PE" : "—");
    const cls = t === "CE" ? "up" : t === "PE" ? "down" : "neu";
    const word = t === "CE" ? "Bullish" : t === "PE" ? "Bearish" : "Range";
    return `<span class="mts-dir ${cls}">${t === "—" ? "—" : word + " · " + t}</span>`;
  };
  const rrOf = (entry, stop, target) => {
    if (entry == null || stop == null || target == null) return "—";
    const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
    if (!(risk > 0)) return "—";
    return (reward / risk).toFixed(1);
  };
  // Rejection reason for a mode: prefer the arbiter's suppressed[].why, else the leg's skips.
  const rejReasonFor = (mode, leg) => {
    const sup = (arb.suppressed || []).find((x) => x && x.mode === mode);
    if (sup && sup.why) return sup.why;
    if (leg && leg.skipReasons && leg.skipReasons.length) return leg.skipReasons.join(" · ");
    if (leg && !leg.take) return "trigger not met";
    return "lost arbitration";
  };

  const selRej = (isSel) => isSel
    ? `<span class="mts-badge sel">SELECTED</span>`
    : `<span class="mts-badge rej">REJECTED</span>`;

  const premState = X.premiumState || "—";
  const premCls = premState === "Favorable" ? "ok" : premState === "Decaying" ? "bad" : premState === "Extended" ? "warn" : "neu";
  const finalScore = X.finalScore;
  const tradeReviews = d.tradeReviews || {};

  // Row timestamp (signal time) → IST date + time.
  const asOfMs = d.asOf ? d.asOf * 1000 : Date.now();
  const _iso = new Date(asOfMs + 19800000).toISOString();
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const _ymd = _iso.slice(0, 10).split("-");
  const dateStr = `${_ymd[2]}-${MON[Number(_ymd[1]) - 1]}-${_ymd[0]}`;
  const timeStr = _iso.slice(11, 16);

  const legLtp = (o) => (o === "CE" ? d.callLtp : o === "PE" ? d.putLtp : null);
  const legHigh = (o) => (o === "CE" ? rng.callHi : o === "PE" ? rng.putHi : null);
  const legLow = (o) => (o === "CE" ? rng.callLo : o === "PE" ? rng.putLo : null);

  // Decay cell: Favorable(green) / Extended(amber) / Decaying(red+⛔) / Neutral(muted).
  const decayCell = () => {
    const cls = premState === "Favorable" ? "ok" : premState === "Decaying" ? "bad" : premState === "Extended" ? "warn" : "neu";
    const txt = premState === "Decaying" ? "⛔ Decaying" : premState;
    return `<td class="mts-prem ${cls}">${txt}</td>`;
  };

  // SETUP: raw ATM OI edge; never an arbiter candidate.
  const setupOpt = s.optionType && s.optionType !== "—" ? s.optionType : (d.oiDirection === "UP" ? "CE" : d.oiDirection === "DOWN" ? "PE" : "—");
  const setupReason = d.oiDirection === "FLAT"
    ? `${setupOpt === "—" ? "Setup" : setupOpt + " Setup"} को directional structure चाहिए (अभी RANGE) — wait करें।`
    : (s.action || "—");

  // Market review cell: post-exit HIT/MISS line (if today's closed trade exists for the mode)
  // prepended above the pre-trade reasoning. Pre-trade narrative is always kept.
  const reviewCell = (modeKey, preTrade) => {
    const out = modeKey ? tradeReviews[modeKey] : null;
    const outHtml = out ? `<div class="mts-rev-out ${/Target HIT/.test(out) ? "hit" : "miss"}">${out}</div>` : "";
    return `<td class="mts-reason">${outHtml}<div class="mts-rev-pre">${preTrade || "—"}</div></td>`;
  };

  // ---------- ADVISORY: where did the suggestion come from, and what happened? ----------
  // A layer that is take-able is a CANDIDATE, not a trade. Only the Master
  // Selector promotes a candidate into a suggestion. These helpers mirror
  // backend/advisory/suggestionBuilder.ts so the table and the recorded
  // measurements always describe the same thing.
  const LAYER_STATE_UI = {
    CANDIDATE: { txt: "CANDIDATE", cls: "cand" },
    PASS: { txt: "PASS", cls: "pass" },
    WAIT: { txt: "WAIT", cls: "wait" },
    BLOCK: { txt: "BLOCK", cls: "block" },
    NO_EDGE: { txt: "NO EDGE", cls: "noedge" },
  };
  const layerStateOf = (leg) => {
    if (!leg) return "NO_EDGE";
    if (leg.take) return "CANDIDATE";
    const skips = leg.skipReasons || [];
    if (!skips.length) return "NO_EDGE";
    return skips.some((x) => /wall|room|AVOID|invalidated|stale|baseline/i.test(x)) ? "BLOCK" : "WAIT";
  };
  const layerStates = {
    SETUP: layerStateOf(s),
    DIRECTIONAL: layerStateOf(dir),
    SCALP: layerStateOf(sc),
  };
  const layerCell = (key) => {
    const st = LAYER_STATE_UI[layerStates[key]] || LAYER_STATE_UI.NO_EDGE;
    return `<td><span class="mts-layer ${st.cls}">${st.txt}</span></td>`;
  };

  // The promoted leg, per the engine's own arbitration. Never inferred.
  const primaryMode = (arb.primary && arb.primary.mode) ? String(arb.primary.mode).toUpperCase() : null;
  const chosenLeg = verdict !== "GO" ? null
    : primaryMode === "SCALP" ? sc
    : primaryMode === "DIRECTIONAL" ? dir
    : (dir || sc);

  // Advisory suggestion. The engine's WAIT/CONFLICT can never become a BUY.
  const allSkipText = [...(dir.skipReasons || []), ...(sc.skipReasons || [])].join(" ");
  const suggestionOf = () => {
    if (verdict === "GO" && chosenLeg && chosenLeg.optionType && chosenLeg.optionType !== "—") {
      return chosenLeg.optionType === "CE" ? "BUY CE" : "BUY PE";
    }
    if (/AVOID|invalidated vs OI wall|too close/i.test(allSkipText)) return "AVOID";
    if (/pullback|extended/i.test(allSkipText)) return "WAIT FOR PULLBACK";
    if (verdict === "CONFLICT") return "WAIT";
    return (dir.take || sc.take || s.take) ? "WAIT" : "NO EDGE";
  };
  const suggestion = suggestionOf();
  const sugCls = suggestion.startsWith("BUY") ? (suggestion === "BUY CE" ? "buyce" : "buype")
    : suggestion === "AVOID" ? "avoid" : suggestion === "NO EDGE" ? "noedge" : "wait";

  // Complete source path, e.g. "DIRECTIONAL + SCALP" or "MASTER (held)".
  const sourcePath = (() => {
    const cands = Object.keys(layerStates).filter((k) => layerStates[k] === "CANDIDATE");
    if (verdict !== "GO") return cands.length ? cands.join(" + ") + " → MASTER (held)" : "NONE";
    const head = primaryMode || "MASTER";
    const agree = cands.filter((k) => k !== primaryMode);
    return agree.length ? head + " + " + agree.join(" + ") : head;
  })();

  // Recorded outcome for this symbol, if the resolver has measured one.
  const outcome = (state.advisoryBySymbol || {})[d.symbol] || null;
  const resultChip = (r) => {
    const m = { CORRECT: ["✓ CORRECT", "ok"], WRONG: ["✗ WRONG", "bad"], NEUTRAL: ["~ NEUTRAL", "neu"], UNRESOLVED: ["⏳ UNRESOLVED", "pend"] };
    const [t, c] = m[r] || m.UNRESOLVED;
    return `<span class="mts-res ${c}">${t}</span>`;
  };
  const win = (mins) => {
    if (!outcome) return null;
    return (outcome.windows || []).find((w) => w.minutes === mins) || null;
  };
  // ACTUAL MOVE — spot in points and premium in percent, never merged.
  const actualMoveCell = () => {
    const w = win(15) || win(5);
    if (!w || w.spotMovePts == null) return `<td class="mts-actual"><span class="wl-sub">⏳ awaiting</span></td>`;
    const sp = w.spotMovePts;
    const pm = w.premiumMovePct;
    return `<td class="mts-actual">
      <div class="mts-sp ${sp > 0 ? "up" : sp < 0 ? "down" : ""}">Spot ${sp > 0 ? "+" : ""}${sp} pts</div>
      <div class="mts-pm ${pm == null ? "" : pm > 0 ? "up" : "down"}">${pm == null ? "Option — ABSTAIN (no premium history)" : "Option " + (pm > 0 ? "+" : "") + pm + "%"}</div>
    </td>`;
  };
  // TRADE DIFFERENCE — system expectation vs actual, per window.
  const tradeDiffCell = () => {
    const exp = suggestion === "BUY CE" ? "UP" : suggestion === "BUY PE" ? "DOWN" : null;
    if (!outcome) return `<td class="mts-diff"><span class="wl-sub">not recorded yet</span></td>`;
    if (!exp) {
      const we = outcome.waitEval || "UNRESOLVED";
      const wm = { CORRECT_WAIT: ["✓ CORRECT WAIT", "ok"], MISSED_OPPORTUNITY: ["⚠ MISSED OPPORTUNITY", "bad"], NEUTRAL: ["~ NEUTRAL", "neu"], UNRESOLVED: ["⏳ UNRESOLVED", "pend"] };
      const [t, c] = wm[we] || wm.UNRESOLVED;
      return `<td class="mts-diff"><div class="mts-exp">Expected: no entry</div><span class="mts-res ${c}">${t}</span></td>`;
    }
    const rows = [5, 15, 30].map((m) => {
      const w = win(m);
      const mv = w && w.spotMovePts != null ? `${w.spotMovePts > 0 ? "+" : ""}${w.spotMovePts}` : "—";
      return `<div class="mts-diffrow"><b>${m}M</b> ${mv} pts ${resultChip(w ? w.dirResult : "UNRESOLVED")}</div>`;
    }).join("");
    return `<td class="mts-diff"><div class="mts-exp">Expected: ${exp}</div>${rows}</td>`;
  };
  // RESULT — directional verdict at 15M, plus the premium outcome separately.
  const resultCell = () => {
    if (!outcome) return `<td class="mts-outcome"><span class="wl-sub">⏳ unresolved</span></td>`;
    const w = win(15);
    const to = outcome.tradeOutcome || "UNRESOLVED";
    const tm = { TARGET_HIT: ["🎯 TARGET HIT", "ok"], STOP_HIT: ["🛑 STOP HIT", "bad"], PARTIAL: ["◐ PARTIAL", "neu"], LOSS: ["▼ LOSS", "bad"], FLAT: ["— FLAT", "neu"], UNRESOLVED: ["⏳ —", "pend"] };
    const [tt, tc] = tm[to] || tm.UNRESOLVED;
    return `<td class="mts-outcome">
      <div>Direction ${resultChip(w ? w.dirResult : "UNRESOLVED")}</div>
      <div class="mts-tradeout ${tc}">${tt}</div>
    </td>`;
  };

  const rowFor = (name, cls, leg, mode, modeKey) => {
    const isSel = selectedMode === mode;
    const opt = leg.optionType && leg.optionType !== "—" ? leg.optionType : setupOpt;
    const conf = mode === "Directional" ? (finalScore != null ? finalScore : (leg.confidence ?? "—")) : (leg.confidence ?? "—");
    const preTrade = isSel ? (arb.reason || "selected — primary candidate") : rejReasonFor(mode, leg);
    const ltp = legLtp(opt);
    return `<tr class="mts-row${isSel ? " mts-row-sel" : ""}">
      <td><span class="mts-strat ${cls}">${name}</span></td>
      <td class="mts-dt">${dateStr}</td>
      <td class="mts-dt">${timeStr}</td>
      <td>${dirBadge(opt)}</td>
      <td>${num(leg.strike)}</td>
      <td>${money(leg.ltp)}</td>
      <td class="down">${money(leg.stop)}</td>
      <td class="up">${money(leg.target)}</td>
      <td>${money(ltp)} · ${money(legHigh(opt))}</td>
      <td>${money(ltp)} · ${money(legLow(opt))}</td>
      <td>${num(d.spot)}</td>
      <td>${conf}</td>
      ${layerCell(name)}
      <td class="mts-src">${isSel ? sourcePath : "—"}</td>
      <td>${isSel ? `<span class="mts-sug ${sugCls}">${suggestion}</span>${chosenLeg && chosenLeg.strike ? `<div class="mts-sug-strike">${num(chosenLeg.strike)} ${chosenLeg.optionType || ""}</div>` : ""}` : "—"}</td>
      ${isSel ? actualMoveCell() : '<td class="wl-sub">—</td>'}
      ${isSel ? tradeDiffCell() : '<td class="wl-sub">—</td>'}
      ${isSel ? resultCell() : '<td class="wl-sub">—</td>'}
      ${decayCell()}
      ${reviewCell(modeKey, preTrade)}
    </tr>`;
  };

  const ltpSetup = legLtp(setupOpt);
  const rowSetup = `<tr class="mts-row">
      <td><span class="mts-strat mts-setup">SETUP</span></td>
      <td class="mts-dt">${dateStr}</td>
      <td class="mts-dt">${timeStr}</td>
      <td>${dirBadge(setupOpt)}</td>
      <td>${num(s.strike)}</td>
      <td>${money(s.ltp)}</td>
      <td class="down">—</td>
      <td class="up">—</td>
      <td>${money(ltpSetup)} · ${money(legHigh(setupOpt))}</td>
      <td>${money(ltpSetup)} · ${money(legLow(setupOpt))}</td>
      <td>${num(d.spot)}</td>
      <td>${s.confidence != null ? s.confidence : "—"}</td>
      ${layerCell("SETUP")}
      <td class="mts-src wl-sub">not an arbiter candidate</td>
      <td class="wl-sub">—</td>
      <td class="wl-sub">—</td>
      <td class="wl-sub">—</td>
      <td class="wl-sub">—</td>
      ${decayCell()}
      ${reviewCell(null, setupReason)}
    </tr>`;

  const regime = X.regime || "—";
  const risk = d.riskRadar || null;
  const riskLvlCls = risk ? (risk.level === "High" ? "danger" : risk.level === "Elevated" ? "caution" : "low") : "";

  // Dashboard Grid layout: a compact hero (verdict/CALL/PUT/risk) for a glance,
  // then independent cards (full Risk Radar, Levels, Writer battle, OI walls)
  // scanned side by side instead of one long vertical column, then the
  // Analysis text collapsed by default (still one click away, nothing
  // removed), then the full decision table - every one of its original
  // columns kept exactly as before.
  // Named, numbered section label styled like a Decision Flow step (circled
  // number + name + a short question), so the cockpit reads in the same
  // guided sequence as the Decision Flow desk.
  const secLabel = (n, name, q) => `<div class="mts-sec"><span class="mts-sec-n">${n}</span><span class="mts-sec-t">${name}<small>${q}</small></span></div>`;

  box.innerHTML = `
    <div class="mts">
      <div class="mts-head">
        <div class="mts-title">🎯 Master Trade Selector</div>
        <div class="mts-head-actions">
          <button type="button" class="mts-log-link" id="mts-oi-toggle">📊 OI Details</button>
        </div>
      </div>

      ${secLabel(1, "Market Command", "Is today worth trading? — verdict + risk")}
      <div class="mtg-hero">
        <div class="mts-verdict ${vcls}">
          <div class="mts-verdict-word">${vWord}</div>
          <div class="mts-verdict-sub">${C ? C.headline : (reason || "—")}</div>
        </div>
        ${risk ? `
        <div class="mtg-risk-hero rr-${riskLvlCls}">
          <span>Risk</span>
          <b>${risk.level}</b>
          <small>${risk.spikeRisk}/100</small>
        </div>` : `<div class="mtg-risk-hero"><span>Risk</span><b>—</b></div>`}
      </div>

      <div id="mts-oi" class="mts-oi ${state.mtsOiOpen ? "" : "hidden"}">${renderOiDetailsHtml(d)}</div>

      <div class="mts-controls">
        <span class="mts-chip">regime: <b>${regime}</b></span>
        <span class="mts-chip">CALL/PUT LTP confirm</span>
        <span class="mts-chip">one trade at a time</span>
        <span class="mts-chip mts-prem ${premCls}">Prem: ${premState}</span>
        <span class="mts-chip">RR / Score gate</span>
      </div>

      ${risk ? riskRadarHtml(risk, renderMarketReadHtml(C)) : renderMarketReadHtml(C)}

      ${secLabel(2, "Market Map &amp; OI", "Where can it move? — levels · OI walls · structure")}
      <div class="mtg-grid">
        ${renderLevelsCardHtml(C)}
        ${renderWriterBattleHtml(C)}
        ${renderOiWallsCardHtml(d)}
        ${renderMacroSetupCardHtml(d)}
        ${renderLiquidityCardHtml()}
      </div>

      ${secLabel(3, "Trader Mind", "Why is this a setup? — what each model layer says")}
      ${renderBulletinHtml(d)}

      ${secLabel(4, "Setup Decision", "Trade now? — Setup vs Directional vs Scalp")}
      <div class="mts-tablewrap">
        <table class="mts-table">
          <thead><tr>
            <th>Strategy</th><th>Date</th><th>Time</th><th>Dir</th><th>Strike</th>
            <th>Entry</th><th>SL</th><th>Target</th><th>LTP · day high</th><th>LTP · day low</th>
            <th>Spot</th><th>Conf%</th><th>Layer state</th><th>Signal source</th><th>Trade suggestion</th>
            <th>Actual move</th><th>Trade difference</th><th>Result</th><th>Decay</th><th>Market review</th>
          </tr></thead>
          <tbody>
            ${rowSetup}
            ${rowFor("DIRECTIONAL", "mts-directional", dir, "Directional", "directional")}
            ${rowFor("SCALP", "mts-scalp", sc, "Scalp", "scalp")}
          </tbody>
        </table>
      </div>

      ${secLabel(5, "Confirmation", "All conditions met? — final master decision")}
      <div class="mts-final ${vcls}">
        <span class="mts-final-lab">🎯 Final Master Decision:</span>
        <span class="mts-final-word">${verdict}</span>
        <span class="mts-final-reason">— ${reason || "—"}</span>
        <span class="mts-next">Next check: auto · <b id="mts-next">15s</b></span>
      </div>

      <!-- ADVISORY suggestion panel. Shows WHERE the suggestion came from and,
           once the observation windows elapse, what the market actually did.
           ADVISORY ONLY — nothing here places or routes an order. -->
      ${secLabel(6, "Best Option", "Which contract to consider — advisory only")}
      <div class="mts-advisory ${suggestion.startsWith("BUY") ? "act" : "hold"}">
        <div class="mts-adv-head">
          <span class="mts-adv-lab">Trade suggestion</span>
          <span class="mts-sug ${sugCls} big">${suggestion}</span>
          ${suggestion.startsWith("BUY") && chosenLeg && chosenLeg.strike
            ? `<span class="mts-adv-strike">${num(chosenLeg.strike)} ${chosenLeg.optionType || ""}</span>` : ""}
          <span class="mts-adv-advisory">ADVISORY ONLY · no order is placed</span>
        </div>
        <div class="mts-adv-grid">
          <div class="mts-adv-row"><span>Source</span><b>${sourcePath}</b></div>
          <div class="mts-adv-row"><span>Layer states</span><b>SETUP ${layerStates.SETUP.replace("_", " ")} · DIRECTIONAL ${layerStates.DIRECTIONAL.replace("_", " ")} · SCALP ${layerStates.SCALP.replace("_", " ")}</b></div>
          ${suggestion.startsWith("BUY") ? `
            <div class="mts-adv-row"><span>Entry</span><b>${money(chosenLeg && chosenLeg.ltp)}</b></div>
            <div class="mts-adv-row"><span>SL</span><b class="down">${money(chosenLeg && chosenLeg.stop)}</b></div>
            <div class="mts-adv-row"><span>Target</span><b class="up">${money(chosenLeg && chosenLeg.target)}</b></div>
            <div class="mts-adv-row"><span>Confidence at signal</span><b>${finalScore != null ? finalScore : (chosenLeg && chosenLeg.confidence != null ? chosenLeg.confidence : "—")}<span class="wl-sub"> — a score, not a success rate</span></b></div>
          ` : `
            <div class="mts-adv-row"><span>Trade suggestion</span><b>NONE</b></div>
            <div class="mts-adv-row wide"><span>Reason</span><b>${
              (() => {
                const rs = [];
                if (reason) rs.push(reason);
                for (const leg of [dir, sc]) for (const x of (leg.skipReasons || [])) if (!rs.includes(x)) rs.push(x);
                return rs.length ? rs.slice(0, 6).map((x) => `<div class="mts-adv-reason">• ${x}</div>`).join("") : "—";
              })()
            }</b></div>
            <div class="mts-adv-row"><span>Opportunity</span><b class="mts-opp">${
              /wall|room/i.test(allSkipText) ? "MONITORING · breakout watch" : "MONITORING"
            }</b></div>
          `}
          ${outcome ? `<div class="mts-adv-row"><span>Measured outcome</span><b>${
            (() => {
              const w = (outcome.windows || []).find((x) => x.minutes === 15);
              if (!w || w.spotMovePts == null) return "⏳ observation window still open";
              return `15M spot ${w.spotMovePts > 0 ? "+" : ""}${w.spotMovePts} pts · ${w.dirResult}` +
                (w.premiumMovePct != null ? ` · option ${w.premiumMovePct > 0 ? "+" : ""}${w.premiumMovePct}%` : " · option ABSTAIN");
            })()
          }</b></div>` : `<div class="mts-adv-row"><span>Measured outcome</span><b class="wl-sub">⏳ not yet measured — outcomes appear after the 5/15/30-minute windows elapse</b></div>`}
        </div>
      </div>

      <!-- SIGNAL ACCURACY — measured from recorded outcomes only, never CONF%. -->
      <div class="mtg-card adv-acc-card">
        <div class="adv-acc-head">
          <h5>Signal accuracy &mdash; measured, not predicted</h5>
          <label class="wl-sub">Window
            <select id="adv-acc-window" class="adv-acc-sel">
              <option value="5">5 min</option>
              <option value="15" selected>15 min</option>
              <option value="30">30 min</option>
            </select>
          </label>
        </div>
        <div id="adv-accuracy"><span class="wl-sub">Loading measured outcomes…</span></div>
      </div>

      <!-- Final section: Trader Specific Strategies — the day's best-matched
           strategy for the CURRENT market condition (or WAIT). Read-only lens;
           never overrides the Master Trade Selector above. -->
      ${secLabel(7, "Trader Specific Strategies", "Which strategy fits today? — daily market-condition pick")}
      ${renderStrategiesSection(d.strategies, { verdict, suggestion, chosenLeg, finalScore })}
    </div>`;

  // The accuracy card is re-created on every render, so re-bind and refill it.
  if (typeof wireAdvisoryWindowPicker === "function") wireAdvisoryWindowPicker();
  if (typeof loadAdvisoryAccuracy === "function") {
    const selWin = el("adv-acc-window");
    loadAdvisoryAccuracy(selWin ? Number(selWin.value) : 15);
  }

  // Connect to the decision log (arbiter verdicts are already written there).
  const logBtn = el("mts-log");
  if (logBtn) logBtn.addEventListener("click", () => toggleDecisionLogDrawer(true));

  // OI Details drawer: toggle open/closed; content re-renders on every 15s poll.
  const oiToggle = el("mts-oi-toggle");
  if (oiToggle) {
    oiToggle.classList.toggle("active", !!state.mtsOiOpen);
    oiToggle.addEventListener("click", () => {
      state.mtsOiOpen = !state.mtsOiOpen;
      const panel = el("mts-oi");
      if (panel) panel.classList.toggle("hidden", !state.mtsOiOpen);
      oiToggle.classList.toggle("active", !!state.mtsOiOpen);
      if (state.mtsOiOpen && panel) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  // Lightweight auto-refresh countdown to match the live 15s poll.
  state.mtsNextAt = Date.now() + 15000;
  if (!state.mtsTicker) {
    state.mtsTicker = setInterval(() => {
      const e = el("mts-next");
      if (!e) return;
      const left = Math.max(0, Math.ceil((state.mtsNextAt - Date.now()) / 1000));
      e.textContent = left + "s";
    }, 1000);
  }

  // Keep the rel/clarity toolbar badges in sync with the arbiter read.
  const rel = el("oic-rel");
  if (rel) { rel.textContent = "verdict: " + verdict; rel.className = "rel-badge " + (vcls === "go" ? "rel-high" : vcls === "conflict" ? "rel-est" : "rel-med"); }
  const clr = el("oic-clarity");
  if (clr) clr.textContent = "clarity: " + (X.setupQuality != null ? X.setupQuality : "—");

  // Present the cockpit as a vertical step rail (like the Decision Flow desk):
  // the section labels become a left-hand rail, one screen shown at a time.
  cockpitStepify(box);

  // Mount/refresh the strategy candlestick chart (persistent node — see mountStrategyChart).
  try { mountStrategyChart((el("oic-symbol") && el("oic-symbol").value) || "^NSEI"); } catch (_) { /* chart is best-effort */ }
}

// Trader Specific Strategies — the final cockpit section. Reads the read-only
// daily selection the backend attached to the oi-command payload (d.strategies).
// Trader-facing: shows today's condition → best-matched strategy → quality → why
// → confirmation → trigger → invalidation → expected move → master action, plus a
// compact 3-row ranking. Honest about "no suitable strategy" and cold-start.
function renderStrategiesSection(sel, ctx) {
  if (!sel) {
    return `<div class="mts-strat"><div class="wl-sub">Strategy read unavailable right now — it appears once market data is live.</div></div>`;
  }
  ctx = ctx || {};
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const money = (v) => (v == null ? "—" : "₹" + Number(v).toLocaleString("en-IN"));
  const qCls = (q) => (q === "HIGH" ? "q-high" : q === "MEDIUM" ? "q-med" : "q-low");
  const p = sel.preferred;
  const cond = sel.condition || {};
  const regimeWord = cond.regime === "Trending" ? "Trend" : cond.regime === "Compressed" ? "Compressed" : cond.regime === "Transitioning" ? "Transitioning" : "—";
  const dir = sel.ranking && p ? "" : "";
  // Move potential mirrors the preferred setup's quality (HIGH/MED/LOW) — NOT a
  // probability of profit. When WAITing there is no potential to show.
  const movePot = p ? p.quality : "—";
  const movePotCls = p ? qCls(p.quality) : "q-low";

  // ---- header metric cards (data-driven; honest labels, no fabricated win rate) ----
  const cards = `<div class="strat-cards">
      <div class="strat-card"><span class="strat-card-lab">Today's market condition</span><span class="strat-card-val">${esc(cond.label || "—")}</span><span class="strat-card-sub">${esc(cond.detail || "")}${sel.regimeSource === "gated" ? " · gated-trend path" : ""}</span></div>
      <div class="strat-card"><span class="strat-card-lab">Move potential</span><span class="strat-card-val ${movePotCls}">${esc(movePot)}</span><span class="strat-card-sub">setup strength</span></div>
      <div class="strat-card"><span class="strat-card-lab">Condition match</span><span class="strat-card-val">${p ? p.score : "—"}</span><span class="strat-card-sub">support score, not a win rate</span></div>
      <div class="strat-card strat-card-strat"><span class="strat-card-lab">Best strategy</span><span class="strat-card-val">${p ? esc(p.name) : "WAIT"}</span><span class="strat-card-sub">${p ? esc(p.blurb || "") : "no strong edge today"}</span></div>
      <div class="strat-card"><span class="strat-card-lab">Master action</span><span class="strat-card-val">${esc((ctx.verdict) || (p ? "PREPARE" : "WAIT"))}</span><span class="strat-card-sub">from Master Trade Selector</span></div>
    </div>`;

  // ---- body: preferred setup + why, or WAIT ----
  let body;
  if (!p) {
    body = `<div class="strat-wait">
        <div class="strat-wait-word">NO SUITABLE STRATEGY TODAY</div>
        <div class="strat-wait-sub">→ WAIT / NO TRADE — no strategy has a strong enough edge for today's condition. Not forcing a trade.</div>
      </div>`;
  } else {
    // Trade setup card reads the Master Trade Selector's existing advisory leg
    // (read-only) — the strategy layer defers the actual option/entry to MTS.
    const leg = ctx.chosenLeg;
    const actionable = ctx.suggestion && String(ctx.suggestion).startsWith("BUY") && leg && leg.strike != null;
    const setup = actionable
      ? `<div class="strat-setup">
          <div class="strat-setup-head">Trade setup <span class="wl-sub">— from Master Trade Selector advisory (read-only)</span></div>
          <div class="strat-srow"><span>Direction</span><b>${esc(leg.optionType === "PE" ? "BUY PUT (Bearish)" : "BUY CALL (Bullish)")}</b></div>
          <div class="strat-srow"><span>Strategy</span><b>${esc(p.name)}</b></div>
          <div class="strat-srow"><span>Strike</span><b>${esc(leg.strike)} ${esc(leg.optionType || "")}</b></div>
          <div class="strat-srow"><span>Entry</span><b>${money(leg.ltp)}</b></div>
          <div class="strat-srow"><span>Stop loss</span><b class="down">${money(leg.stop)}</b></div>
          <div class="strat-srow"><span>Target</span><b class="up">${money(leg.target)}</b></div>
          <div class="strat-srow"><span>Expected move</span><b>${esc(sel.expectedMove && sel.expectedMove.label)}</b></div>
          <div class="strat-srow"><span>Confidence at signal</span><b>${ctx.finalScore != null ? ctx.finalScore : (leg.confidence != null ? leg.confidence : "—")} <span class="wl-sub">· a score, not a success rate</span></b></div>
        </div>`
      : `<div class="strat-setup strat-setup-wait">
          <div class="strat-setup-head">Trade setup</div>
          <div class="wl-sub">Strategy matched, but no confirmed option trade yet — waiting for the trigger below. No order is placed.</div>
          <div class="strat-srow"><span>Expected move</span><b>${esc(sel.expectedMove && sel.expectedMove.label)}</b></div>
        </div>`;
    const why = `<div class="strat-why">
        <div class="strat-why-head">Why this strategy today</div>
        <ul class="strat-why-list">${(p.why || []).map((w) => `<li>✓ ${esc(w)}</li>`).join("") || "<li>—</li>"}</ul>
        <div class="strat-srow"><span>Required confirmation</span><div>${esc(p.requiredConfirmation)}</div></div>
        <div class="strat-srow"><span>Trigger</span><div>${esc(p.trigger)}</div></div>
        <div class="strat-srow"><span>Invalidation</span><div class="down">${esc(p.invalidation)}</div></div>
      </div>`;
    body = `<div class="strat-two">${setup}${why}</div>`;
  }

  // ---- ranking (Preferred / Alternative / Not suitable) ----
  const tierLabel = { PREFERRED: "1 · Preferred", ALTERNATIVE: "2 · Alternative", NOT_SUITABLE: "Not suitable" };
  const tierCls = { PREFERRED: "t-pref", ALTERNATIVE: "t-alt", NOT_SUITABLE: "t-no" };
  const ranked = (sel.ranking || []).slice().sort((a, b) => {
    const ord = { PREFERRED: 0, ALTERNATIVE: 1, NOT_SUITABLE: 2 };
    return (ord[a.tier] - ord[b.tier]) || (b.score - a.score);
  });
  const rankHtml = ranked.map((r) => `<div class="strat-rank ${tierCls[r.tier]}">
      <span class="strat-rank-tier">${tierLabel[r.tier]}</span>
      <span class="strat-rank-name">${esc(r.name)}</span>
      <span class="strat-rank-score">${r.eligible ? r.score : "—"}</span>
    </div>`).join("");

  // ---- evidence / historical edge (honest: cold-start shows 'building') ----
  const ev = p && p.evidence ? p.evidence : null;
  const evidence = `<div class="strat-evidence">
      <div class="strat-why-head">Historical edge in similar conditions</div>
      ${ev && ev.sufficientHistory
        ? `<div class="wl-sub">Validated on ${ev.sampleSize} similar session(s): ${ev.hitRate != null ? Math.round(ev.hitRate * 100) + "% matched" : "—"}. ${esc(ev.note)}</div>`
        : `<div class="wl-sub">Insufficient history yet${ev ? " (" + ev.sampleSize + " similar sessions recorded)" : ""} — ranked on current-condition match only. Edge fills in as paper sessions accrue.</div>`}
    </div>`;

  return `<div class="mts-strat">
      ${cards}
      <div id="strat-chart-slot" class="strat-chart-slot"></div>
      ${body}
      <div class="strat-rank-head">Strategy ranking</div>
      <div class="strat-rank-list">${rankHtml}</div>
      ${evidence}
      <div class="strat-advisory">Advisory only · "best" = best-supported for today's condition, <b>not a profit guarantee</b>. No order is placed.</div>
    </div>`;
}

// ---- Strategy candlestick chart (TradingView Lightweight Charts, like Dhan) ----
// A persistent chart node is created once and MOVED into the panel's slot on each
// cockpit re-render, so the 15s innerHTML rebuild never destroys/recreates the chart
// (no flicker). Candles + EMA9/EMA21/VWAP + volume + the opening-range band, with a
// live O/H/L/C crosshair legend for "clear details". Reuses /api/candles + alignSeries.
let stratChart = null, stratChartEl = null, stratS = {}, stratChartSym = null, stratFetchAt = 0, stratRO = null, stratORLines = [], stratLastCandle = null, stratOverlayNow = {};
function updateStratLegend(param) {
  const lg = stratChartEl && stratChartEl.querySelector("#strat-chart-legend");
  if (!lg) return;
  let c = stratLastCandle;
  if (param && param.time && stratS.candle) { const v = param.seriesData && param.seriesData.get(stratS.candle); if (v) c = v; }
  if (!c) { lg.innerHTML = '<span class="wl-sub">Loading chart…</span>'; return; }
  const chg = stratLastCandle ? (c.close - (c.open)) : 0;
  const cls = c.close >= c.open ? "up" : "down";
  const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  lg.innerHTML = `<b>${stratChartSym === "^NSEBANK" ? "BANK NIFTY" : stratChartSym === "^CNXFIN" ? "FIN NIFTY" : stratChartSym === "^NSEI" ? "NIFTY 50" : (stratChartSym || "")}</b> · 5m`
    + ` <span class="slg">O <b>${n(c.open)}</b></span><span class="slg">H <b>${n(c.high)}</b></span><span class="slg">L <b>${n(c.low)}</b></span>`
    + `<span class="slg">C <b class="${cls}">${n(c.close)}</b></span>`
    + `<span class="slg" style="color:#f0b90b">EMA9 ${n(stratOverlayNow.ema9)}</span><span class="slg" style="color:#5b9bd5">EMA21 ${n(stratOverlayNow.ema21)}</span><span class="slg" style="color:#a855f7">VWAP ${n(stratOverlayNow.vwap)}</span>`;
}
function drawStratOR(c) {
  // Opening range = high/low of the first 6 bars (09:15-09:45) of the current IST day.
  stratORLines.forEach((l) => { try { stratS.candle.removePriceLine(l); } catch (_) {} });
  stratORLines = [];
  const istDate = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  if (!c.length) return;
  const today = istDate(c[c.length - 1].time);
  const day = c.filter((x) => istDate(x.time) === today).slice(0, 6);
  if (day.length < 2) return;
  const hi = Math.max(...day.map((x) => x.high)), lo = Math.min(...day.map((x) => x.low));
  stratORLines.push(stratS.candle.createPriceLine({ price: hi, color: "rgba(138,151,173,0.6)", lineWidth: 1, lineStyle: 2, title: "OR High" }));
  stratORLines.push(stratS.candle.createPriceLine({ price: lo, color: "rgba(138,151,173,0.6)", lineWidth: 1, lineStyle: 2, title: "OR Low" }));
}
async function loadStratChartData(sym) {
  try {
    const d = await fetch(`/api/candles/${encodeURIComponent(sym)}?interval=5m`).then((r) => r.json());
    if (!d || !Array.isArray(d.candles) || !d.candles.length) return;
    const c = d.candles;
    stratS.candle.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
    if (d.overlays) {
      stratS.ema9.setData(alignSeries(c, d.overlays.ema9 || []));
      stratS.ema21.setData(alignSeries(c, d.overlays.ema21 || []));
      stratS.vwap.setData(alignSeries(c, d.overlays.vwap || []));
      const li = (a) => (Array.isArray(a) ? [...a].reverse().find((v) => v != null) : null);
      stratOverlayNow = { ema9: li(d.overlays.ema9), ema21: li(d.overlays.ema21), vwap: li(d.overlays.vwap) };
    }
    stratS.vol.setData(c.map((x) => ({ time: x.time, value: x.volume || 0, color: x.close >= x.open ? "rgba(22,199,132,0.35)" : "rgba(234,57,67,0.35)" })));
    drawStratOR(c);
    stratLastCandle = c[c.length - 1];
    stratChart.timeScale().fitContent();
    updateStratLegend(null);
  } catch (_) { /* leave last-good chart */ }
}
// Called when the stepper reveals the strategy step: size the chart to the now-
// visible canvas and re-load so a series set while hidden actually paints.
function revealStratChart() {
  if (!stratChart || !stratChartEl) return;
  const cv = stratChartEl.querySelector(".strat-chart-canvas");
  if (cv && cv.clientWidth > 0) { stratChart.applyOptions({ width: cv.clientWidth }); loadStratChartData(stratChartSym || "^NSEI"); }
}

// ============================ Strategy Replay tab (real engine output) ============================
// Renders /api/strategy-replay: a full session run through the EXISTING engines +
// selector (no look-ahead) with staged event markers on the chart, the real
// decision, and the validated timing verdict. Every value is engine-derived;
// nothing is hard-coded. Missing data shows "DATA UNAVAILABLE".
let srpChart = null, srpInit = false;
const SRP_INDICES = [["^NSEI", "NIFTY 50"], ["^NSEBANK", "NIFTY BANK"], ["^CNXFIN", "FIN NIFTY"], ["^NSEMDCP50", "MIDCAP NIFTY"]];
function initStrategyReplay() {
  if (!srpInit) {
    srpInit = true;
    const sel = el("srp-symbol");
    if (sel) sel.innerHTML = SRP_INDICES.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("");
    const dt = el("srp-date");
    if (dt && !dt.value) dt.value = "2026-09-15"; // last validated session; user can change
    if (el("srp-run")) el("srp-run").addEventListener("click", loadStrategyReplay);
    if (sel) sel.addEventListener("change", loadStrategyReplay);
  }
  if (!state.srpLoaded) { state.srpLoaded = true; loadStrategyReplay(); }
}
async function loadStrategyReplay() {
  const body = el("srp-body"); if (!body) return;
  const sym = (el("srp-symbol") && el("srp-symbol").value) || "^NSEI";
  const date = (el("srp-date") && el("srp-date").value) || "2026-09-15";
  body.innerHTML = '<div class="wl-sub" style="padding:24px">Replaying the session through the engines…</div>';
  let d;
  try { d = await fetch(`/api/strategy-replay?symbol=${encodeURIComponent(sym)}&date=${encodeURIComponent(date)}`).then((r) => r.json()); }
  catch (e) { body.innerHTML = `<div class="wl-sub" style="padding:24px">Failed to load: ${e.message}</div>`; return; }
  if (!d || d.available === false) { body.innerHTML = `<div class="wl-sub" style="padding:24px">${(d && d.message) || "No replay available for this symbol/date."}</div>`; return; }
  renderStrategyReplay(d);
}
function srpHM(t) { return t == null ? "—" : new Date((t + 19800) * 1000).toISOString().slice(11, 16); }
function renderStrategyReplay(d) {
  const body = el("srp-body"); if (!body) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const money = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const dec = d.decision, tm = d.timing;
  const vCls = { TIMELY: "v-timely", EARLY: "v-early", LATE: "v-late", FALSE: "v-false", MISSED: "v-missed", NO_TRADE: "v-none", IN_PROGRESS: "v-none" }[tm.verdict] || "v-none";
  const vLabel = { TIMELY: "TIMELY", EARLY: "EARLY", LATE: "LATE", FALSE: "FALSE SIGNAL", MISSED: "MISSED", NO_TRADE: "NO TRADE (correct WAIT)", IN_PROGRESS: "IN PROGRESS" }[tm.verdict] || tm.verdict;
  const dirWord = dec.direction === "up" ? "BUY CALL (Bullish)" : dec.direction === "down" ? "BUY PUT (Bearish)" : "—";
  const takeCls = dec.masterAction === "TAKE" ? "srp-take" : "srp-wait";

  // metric cards
  const cards = `<div class="srp-cards">
      <div class="srp-card"><span class="srp-lab">Market condition</span><span class="srp-val">${esc(dec.condition)}</span><span class="srp-sub">${esc(dec.regime || "")}${dec.regimeSource === "gated" ? " · gated" : ""}</span></div>
      <div class="srp-card"><span class="srp-lab">Move developing?</span><span class="srp-val ${dec.moveDeveloping ? "up" : ""}">${dec.moveDeveloping ? "YES" : "No"}</span><span class="srp-sub">stage-based</span></div>
      <div class="srp-card"><span class="srp-lab">Model confidence</span><span class="srp-val">${dec.conditionMatchScore != null ? dec.conditionMatchScore : "—"}</span><span class="srp-sub">condition match · not a win rate</span></div>
      <div class="srp-card"><span class="srp-lab">Best strategy</span><span class="srp-val" style="color:#2dd4bf">${esc(dec.strategy || "None — WAIT")}</span><span class="srp-sub">most suitable today</span></div>
      <div class="srp-card ${takeCls}"><span class="srp-lab">Master action</span><span class="srp-val">${dec.masterAction}</span><span class="srp-sub">${dec.direction ? esc(dirWord) : "no confirmed trade"}</span></div>
    </div>`;

  // timing verdict banner + sequence
  const seq = `<div class="srp-seq">
      <div class="srp-seq-step"><span>Market started</span><b>${srpHM(tm.moveStartTime)}</b></div><span class="srp-arrow">→</span>
      <div class="srp-seq-step"><span>System detected</span><b>${srpHM(tm.detectTime)}</b></div><span class="srp-arrow">→</span>
      <div class="srp-seq-step"><span>Trend confirmed</span><b>${srpHM(tm.confirmTime)}</b></div><span class="srp-arrow">→</span>
      <div class="srp-seq-step"><span>Trade trigger</span><b>${srpHM(tm.triggerTime)}</b></div>
    </div>`;
  const detectedFirst = tm.detectTime != null && tm.moveStartTime != null && tm.detectTime <= tm.moveStartTime;
  const banner = `<div class="srp-verdict ${vCls}">
      <div class="srp-verdict-word">${vLabel}</div>
      <div class="srp-verdict-note">${esc(tm.note)}${tm.mfePts != null ? ` · captured MFE ${tm.mfePts} / MAE ${tm.maePts} pts` : ""}${detectedFirst ? " · system anticipated the move" : ""}</div>
    </div>`;

  // trade setup (option data unavailable for historical dates)
  const setup = `<div class="srp-setup">
      <div class="srp-setup-hd">Trade setup <span class="wl-sub">— from the existing system</span></div>
      <div class="srp-srow"><span>Direction</span><b class="${dec.direction === "down" ? "down" : dec.direction === "up" ? "up" : ""}">${esc(dirWord)}</b></div>
      <div class="srp-srow"><span>Strategy</span><b>${esc(dec.strategy || "—")}</b></div>
      <div class="srp-srow"><span>Trigger (spot)</span><b>${money(dec.triggerSpot)}</b></div>
      <div class="srp-srow"><span>Invalidation (spot)</span><b class="amber">${money(dec.invalidationSpot)}</b></div>
      <div class="srp-srow"><span>Expected move</span><b>≈ ${dec.expectedMovePts != null ? dec.expectedMovePts + " pts (1× ATR)" : "—"}</b></div>
      <div class="srp-srow"><span>Option / strike / LTP</span><b class="srp-unavail">DATA UNAVAILABLE</b></div>
      <div class="srp-srow"><span>Entry / SL / Target</span><b class="srp-unavail">DATA UNAVAILABLE</b></div>
      <div class="srp-note">No historical intraday option chain for this date, so strike/LTP/entry/SL/target cannot be shown. In live mode these come from the Option Engine.</div>
    </div>`;
  const why = `<div class="srp-why"><div class="srp-setup-hd">Why the system reached this decision</div>
      <ul>${(dec.why || []).map((w) => `<li>✓ ${esc(w)}</li>`).join("") || "<li>—</li>"}</ul></div>`;

  body.innerHTML = `${banner}${cards}
    <div class="srp-main">
      <div class="srp-chartcard">
        <div class="srp-chart-legend" id="srp-legend"></div>
        <div id="srp-price"></div>
        <div class="subhdr" style="font-size:11px;color:var(--muted);margin-top:4px">RSI (14)</div>
        <div id="srp-rsi"></div>
        <div class="subhdr" style="font-size:11px;color:var(--muted)">Volume</div>
        <div id="srp-vol"></div>
        ${seq}
      </div>
      <div>${setup}${why}</div>
    </div>`;

  srpDrawChart(d);
}
function srpDrawChart(d) {
  const pxEl = el("srp-price"); if (!pxEl || typeof LightweightCharts === "undefined") return;
  if (srpChart) { try { srpChart.forEach && srpChart.forEach((c) => c.remove()); } catch (_) {} }
  const mk = (elm, h) => LightweightCharts.createChart(elm, chartOpts(elm.clientWidth || 800, h));
  const chart = mk(pxEl, 340);
  const cs = chart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", wickUpColor: "#16c784", wickDownColor: "#ea3943", borderVisible: false });
  cs.setData(d.candles);
  chart.addLineSeries({ color: "#3b82f6", lineWidth: 1 }).setData(alignSeries(d.candles, d.ema9));
  chart.addLineSeries({ color: "#f0b90b", lineWidth: 1 }).setData(alignSeries(d.candles, d.ema21));
  chart.addLineSeries({ color: "#a855f7", lineWidth: 1, lineStyle: 2 }).setData(alignSeries(d.candles, d.vwap));
  if (d.orHigh != null) cs.createPriceLine({ price: d.orHigh, color: "rgba(138,151,173,.5)", lineWidth: 1, lineStyle: 2, title: "OR High" });
  if (d.orLow != null) cs.createPriceLine({ price: d.orLow, color: "rgba(138,151,173,.5)", lineWidth: 1, lineStyle: 2, title: "OR Low" });
  if (d.decision.invalidationSpot != null) cs.createPriceLine({ price: d.decision.invalidationSpot, color: "rgba(240,166,58,.7)", lineWidth: 1, lineStyle: 0, title: "Invalidation" });
  // event markers (real times/spots from the engine run)
  const mkColor = { MOVE_START: "#f0b90b", SYSTEM_DETECTED: "#3b82f6", TREND_CONFIRMED: "#2dd4bf", GOOD_MOVE: "#16c784", TRADE_TRIGGER: d.decision.direction === "down" ? "#ea3943" : "#16c784" };
  const mkShape = { MOVE_START: "circle", SYSTEM_DETECTED: "arrowDown", TREND_CONFIRMED: "circle", GOOD_MOVE: "circle", TRADE_TRIGGER: "arrowDown" };
  const markers = (d.events || []).filter((e) => e.time != null && mkColor[e.kind]).map((e) => ({ time: e.time, position: e.kind === "TRADE_TRIGGER" ? "belowBar" : "aboveBar", color: mkColor[e.kind], shape: mkShape[e.kind] || "circle", text: e.label }));
  markers.sort((a, b) => a.time - b.time);
  cs.setMarkers(markers);
  chart.timeScale().fitContent();
  const rsiEl = el("srp-rsi"), volEl = el("srp-vol");
  const rc = mk(rsiEl, 90); const rs = rc.addLineSeries({ color: "#e879f9", lineWidth: 1 }); rs.setData(alignSeries(d.candles, d.rsi));
  rs.createPriceLine({ price: 70, color: "rgba(234,57,67,.5)", lineWidth: 1, lineStyle: 2, title: "70" });
  rs.createPriceLine({ price: 30, color: "rgba(22,199,132,.5)", lineWidth: 1, lineStyle: 2, title: "30" }); rc.timeScale().fitContent();
  const vc = mk(volEl, 80); const vs = vc.addHistogramSeries({ priceFormat: { type: "volume" } });
  const cmap = {}; d.candles.forEach((c) => (cmap[c.time] = c));
  vs.setData((d.volume || []).map((x) => ({ time: x.time, value: x.value, color: (cmap[x.time] && cmap[x.time].close >= cmap[x.time].open) ? "rgba(22,199,132,.4)" : "rgba(234,57,67,.4)" }))); vc.timeScale().fitContent();
  // legend on crosshair
  const lg = el("srp-legend");
  const setLg = (c) => { if (lg) lg.innerHTML = c ? `<b>${d.name} · 5m</b> <span class="lg">O ${c.open} H ${c.high} L ${c.low} C <b class="${c.close >= c.open ? "up" : "down"}">${c.close}</b></span> <span style="color:#3b82f6">EMA9</span> <span style="color:#f0b90b">EMA21</span> <span style="color:#a855f7">VWAP</span>` : ""; };
  chart.subscribeCrosshairMove((p) => { const c = p && p.time && p.seriesData ? p.seriesData.get(cs) : null; setLg(c || d.candles[d.candles.length - 1]); });
  setLg(d.candles[d.candles.length - 1]);
  // sync time scales
  let sy = false; const sync = (src, dsts) => src.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (sy || !r) return; sy = true; dsts.forEach((x) => x.timeScale().setVisibleLogicalRange(r)); sy = false; });
  sync(chart, [rc, vc]); sync(rc, [chart, vc]); sync(vc, [chart, rc]);
  srpChart = [chart, rc, vc];
  if (!window.__srpResize) { window.__srpResize = true; window.addEventListener("resize", () => { if (!srpChart) return; const w = el("srp-price"); if (w) srpChart.forEach((c) => c.applyOptions({ width: w.clientWidth })); }); }
}
function mountStrategyChart(sym) {
  const slot = el("strat-chart-slot");
  if (!slot || typeof LightweightCharts === "undefined") return;
  if (!stratChartEl) {
    stratChartEl = document.createElement("div");
    stratChartEl.className = "strat-chart";
    const legend = document.createElement("div"); legend.className = "strat-chart-legend"; legend.id = "strat-chart-legend"; legend.innerHTML = '<span class="wl-sub">Loading chart…</span>';
    const canvas = document.createElement("div"); canvas.className = "strat-chart-canvas";
    stratChartEl.appendChild(legend); stratChartEl.appendChild(canvas);
    stratChart = LightweightCharts.createChart(canvas, chartOpts(canvas.clientWidth || 640, 320));
    stratS.candle = stratChart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", wickUpColor: "#16c784", wickDownColor: "#ea3943", borderVisible: false });
    stratS.ema9 = stratChart.addLineSeries({ color: "#f0b90b", lineWidth: 1 });
    stratS.ema21 = stratChart.addLineSeries({ color: "#5b9bd5", lineWidth: 1 });
    stratS.vwap = stratChart.addLineSeries({ color: "#a855f7", lineWidth: 1, lineStyle: 2 });
    stratS.vol = stratChart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
    stratChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    stratChart.subscribeCrosshairMove((p) => updateStratLegend(p));
    // Auto-resize to the slot (also handles the stepper showing/hiding the panel).
    // When the stepper reveals the panel the canvas goes 0 -> real width: resize,
    // refit, and load data if it hasn't loaded yet (the chart was built hidden).
    if (typeof ResizeObserver !== "undefined") {
      stratRO = new ResizeObserver(() => {
        const w = canvas.clientWidth;
        if (w > 0) { stratChart.applyOptions({ width: w }); stratChart.timeScale().fitContent(); if (!stratLastCandle) loadStratChartData(stratChartSym || "^NSEI"); }
      });
      stratRO.observe(canvas);
    }
  }
  // Move the persistent chart node into the freshly-rendered slot (survives the rebuild).
  if (stratChartEl.parentNode !== slot) { slot.innerHTML = ""; slot.appendChild(stratChartEl); const cv = stratChartEl.querySelector(".strat-chart-canvas"); if (cv && cv.clientWidth > 0) stratChart.applyOptions({ width: cv.clientWidth }); }
  const now = Date.now();
  if (sym !== stratChartSym || now - stratFetchAt > 30000) { stratChartSym = sym; stratFetchAt = now; loadStratChartData(sym); }
}

// Turn the cockpit's stacked, labelled sections into a vertical stepper: a
// left rail of steps + a stage that shows only the selected step's content.
// Re-runs on every 15s render; the active step is remembered in
// state.cockpitStep.
function cockpitStepify(box) {
  const mts = box && box.querySelector(".mts");
  if (!mts) return;
  const head = mts.querySelector(".mts-head");
  const kids = [...mts.children];
  const secEls = kids.filter((k) => k.classList.contains("mts-sec"));
  if (secEls.length < 2) return;

  // Group each section label with the content nodes that follow it.
  const segments = [];
  let cur = null;
  for (const k of kids) {
    if (k === head) continue;
    if (k.classList.contains("mts-sec")) {
      const numEl = k.querySelector(".mts-sec-n");
      const tEl = k.querySelector(".mts-sec-t");
      cur = {
        n: numEl ? numEl.textContent.trim() : String(segments.length + 1),
        name: tEl && tEl.childNodes[0] ? tEl.childNodes[0].textContent.trim() : "",
        q: (k.querySelector(".mts-sec-t small") || {}).textContent || "",
        sec: k, nodes: [],
      };
      segments.push(cur);
    } else if (cur) {
      cur.nodes.push(k);
    }
  }
  if (!segments.length) return;

  const active = Math.min(Math.max(state.cockpitStep || 0, 0), segments.length - 1);
  state.cockpitStep = active;

  // Move each segment's content into its own body wrapper.
  const bodies = segments.map((seg, i) => {
    const body = document.createElement("div");
    body.className = "mts-step-body";
    body.dataset.step = i;
    seg.nodes.forEach((nd) => body.appendChild(nd));
    return body;
  });
  segments.forEach((seg) => seg.sec.remove());

  // Two-column layout: vertical rail on the left, the active screen on the right.
  const flow = document.createElement("div");
  flow.className = "mts-flow";
  const rail = document.createElement("nav");
  rail.className = "mts-vrail";
  rail.innerHTML = segments.map((seg, i) =>
    `<button type="button" class="mts-stepbtn${i === active ? " active" : ""}" data-step="${i}">
       <span class="mts-step-n">${seg.n}</span>
       <span class="mts-step-t">${seg.name}<small>${seg.q}</small></span>
     </button>`).join("");
  const stage = document.createElement("div");
  stage.className = "mts-flow-stage";
  bodies.forEach((b) => stage.appendChild(b));
  flow.appendChild(rail);
  flow.appendChild(stage);
  if (head) head.after(flow); else mts.prepend(flow);

  const apply = () => {
    bodies.forEach((b, i) => { b.hidden = i !== state.cockpitStep; });
    rail.querySelectorAll("[data-step]").forEach((b) => b.classList.toggle("active", +b.getAttribute("data-step") === state.cockpitStep));
  };
  rail.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    state.cockpitStep = +b.getAttribute("data-step");
    apply();
    stage.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // If the revealed step holds the strategy chart, force a resize + refit +
    // reload once it is actually visible (lightweight-charts won't paint a
    // series that was setData'd while the container was zero-size/hidden).
    requestAnimationFrame(() => { try { if (typeof revealStratChart === "function" && document.getElementById("strat-chart-slot")) revealStratChart(); } catch (_) {} });
  }));
  apply();
}

// ---------- Guidance agent narration feed (read-only, event-driven server-side) ----------
async function loadNarration() {
  const box = el("oic-narration");
  if (!box) return;
  try {
    const d = await fetchJSON("/api/log?channel=agent-narration&limit=40", 12000);
    const rows = d.entries || [];
    box.innerHTML = rows.length
      ? rows.map((e) => {
          const t = new Date(e.ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
          const src = e.payload && e.payload.sourceChannel ? e.payload.sourceChannel : "";
          return `<div class="oic-narr-row"><span class="oic-narr-t">${t}</span><span class="oic-narr-txt">${e.summary}</span>${src ? `<span class="oic-narr-src" title="from ${src}/${(e.payload && e.payload.sourceEvent) || ""}">${src}</span>` : ""}</div>`;
        }).join("")
      : `<div class="wl-sub" style="padding:6px">No guidance yet — the agent narrates as the arbiter/regime/veto state changes during market hours.</div>`;
  } catch (_) { /* convenience layer — keep last render */ }
}

// ---------- Decision Log (drawer + docked) ----------
// Unified log: one timeline across ALL channels (centralized log module).
const OIC_LOG_CHANNELS = [
  ["all", "All"], ["decision", "Decision"], ["trade-score", "Score"], ["dedup", "Dedup"],
  ["regime", "Regime"], ["liquidity", "Liquidity"], ["sentiment", "Sentiment"],
  ["wall-reaction", "Wall"], ["premium-sentiment", "Premium"], ["paper-trade", "Paper"],
  ["oi-command", "OI cmd"], ["opening-bias", "Open bias"],
];
const OIC_SEV_CLS = { veto: "t-veto", warn: "t-dup", info: "t-def" };
function oicLogDefaults() { return state.oicLogFilter || { channel: "all", mode: "all", severity: "all", mins: 0, suppressed: false }; }
// The event types that represent a SUPPRESSED / discarded candidate (view-only).
const OIC_SUPPRESSED_EVENTS = new Set(["BELOW_CLARITY_THRESHOLD", "DEDUP_SUPPRESSED", "VETO_DECAYING", "ARBITER_CONFLICT"]);
function oicLogFilterBar() {
  const f = oicLogDefaults();
  const ch = OIC_LOG_CHANNELS.map(([v, l]) => `<option value="${v}" ${f.channel === v ? "selected" : ""}>${l}</option>`).join("");
  const md = [["all", "All modes"], ["Directional", "Directional"], ["Scalp", "Scalp"], ["Setup", "Setup"]]
    .map(([v, l]) => `<option value="${v}" ${f.mode === v ? "selected" : ""}>${l}</option>`).join("");
  const sv = [["all", "All sev"], ["veto", "Veto"], ["warn", "Warn"], ["info", "Info"]]
    .map(([v, l]) => `<option value="${v}" ${f.severity === v ? "selected" : ""}>${l}</option>`).join("");
  const tm = [[0, "All time"], [30, "30 min"], [120, "2 h"], [390, "Today"]]
    .map(([v, l]) => `<option value="${v}" ${Number(f.mins) === v ? "selected" : ""}>${l}</option>`).join("");
  // "Show suppressed" (default off, view-only): filters to discarded candidates.
  const supp = `<label class="oic-log-supp" title="View-only: candidates the arbiter discarded (below-clarity, deduped, vetoed, conflict). Never a second action surface."><input type="checkbox" data-oiclog="suppressed" ${f.suppressed ? "checked" : ""}/> suppressed</label>`;
  return `<select data-oiclog="channel">${ch}</select><select data-oiclog="mode">${md}</select><select data-oiclog="severity">${sv}</select><select data-oiclog="mins">${tm}</select>${supp}`;
}
function oicLogRows(entries) {
  if (!entries || !entries.length) return `<div class="wl-sub" style="padding:6px">No decisions logged yet in this range.</div>`;
  return entries.map((e) => {
    const t = new Date(e.ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const cls = OIC_SEV_CLS[e.severity] || "t-def";
    const sym = e.symbol ? `<em class="oic-log-sym">${e.symbol}</em> ` : "";
    return `<div class="oic-log-row"><span class="oic-log-t">${t}</span><span class="oic-log-tag ${cls}" title="${e.channel} · ${e.severity}">${e.channel}</span><span class="oic-log-txt">${sym}<b>${e.eventType}</b> · ${e.summary}</span></div>`;
  }).join("");
}
function bindOicLogFilters(container) {
  if (!container) return;
  container.querySelectorAll("[data-oiclog]").forEach((sel) => {
    sel.addEventListener("change", () => {
      state.oicLogFilter = oicLogDefaults();
      const key = sel.getAttribute("data-oiclog");
      state.oicLogFilter[key] = sel.type === "checkbox" ? sel.checked : sel.value;
      loadDecisionLog();
    });
  });
}
async function loadDecisionLog() {
  const f = oicLogDefaults();
  const qs = `channel=${encodeURIComponent(f.channel)}&mode=${encodeURIComponent(f.mode)}&severity=${encodeURIComponent(f.severity)}&mins=${encodeURIComponent(f.mins || 0)}&limit=200`;
  const fDock = el("oic-log-filters-dock"), fDraw = el("oic-log-filters-drawer");
  if (fDock) { fDock.innerHTML = oicLogFilterBar(); bindOicLogFilters(fDock); }
  if (fDraw) { fDraw.innerHTML = oicLogFilterBar(); bindOicLogFilters(fDraw); }
  try {
    const d = await fetchJSON(`/api/log?${qs}`, 12000);
    let entries = d.entries || [];
    // "Show suppressed": view-only filter to the discarded-candidate events.
    if (f.suppressed) entries = entries.filter((e) => OIC_SUPPRESSED_EVENTS.has(e.eventType));
    const rows = oicLogRows(entries);
    if (el("oic-log-dock")) el("oic-log-dock").innerHTML = rows;
    if (el("oic-log-drawer-body")) el("oic-log-drawer-body").innerHTML = rows;
  } catch (_) { /* keep last */ }
}
function toggleDecisionLogDrawer(force) {
  const dr = el("oic-log-drawer");
  if (!dr) return;
  const show = force != null ? force : dr.classList.contains("hidden");
  dr.classList.toggle("hidden", !show);
  if (show) loadDecisionLog();
}
function setOicConf(c) { state.oicReviewConf = c; loadOiReview(); }
async function loadOiReview() {
  const box = el("oic-review");
  if (!box) return;
  const sym = (el("oic-symbol") && el("oic-symbol").value) || "^NSEI";
  const conf = state.oicReviewConf || 80;
  try {
    const d = await fetchJSON(`/api/oi-command/review?symbol=${encodeURIComponent(sym)}&conf=${conf}`, 15000);
    renderOiReview(d, conf);
  } catch (_) { /* keep */ }
}
function renderOiReview(d, conf) {
  const box = el("oic-review");
  if (!box || !d || !d.horizons) return;
  const bar = (hz, lab) => {
    const h = d.horizons[hz] || {};
    const w = h.winPct || 0;
    return `<div class="oic-revg"><span>${lab} ${w}%</span><div class="oic-score"><i class="${w >= 50 ? "ok" : "bad"}" style="width:${Math.min(100, w)}%"></i></div><em>${h.correct || 0}✓ ${h.wrong || 0}✗</em></div>`;
  };
  box.innerHTML = `${bar("5", "5m")} ${bar("15", "15m")} ${bar("60", "1h")}`;
}

// ---------- Trader Dashboard BACK-TEST (today) ----------
// Back-tests the grid's concrete recommendation on REAL option + spot candles:
// the recommended ATM CE/PE trade (grid target/stop) across the session, its
// 5/15/60m direction accuracy, plus a replay of the day's logged signals.
async function loadOiBacktest() {
  const box = el("oic-backtest");
  if (!box) return;
  const sym = (el("oic-symbol") && el("oic-symbol").value) || "^NSEI";
  box.innerHTML = `<div class="oic-bt-wrap"><div class="wl-sub">📊 Back-test चल रहा… (Dhan से आज के option/spot candles)</div></div>`;
  try {
    const d = await fetchJSON("/api/oi-command/backtest?symbol=" + encodeURIComponent(sym), 45000);
    renderOiBacktest(d);
  } catch (e) {
    box.innerHTML = `<div class="oic-bt-wrap"><div class="wl-sub">Back-test विफल: ${(e && e.message) || e}</div></div>`;
  }
}
function renderOiBacktest(d) {
  const box = el("oic-backtest");
  if (!box) return;
  if (!d || !d.available) { box.innerHTML = `<div class="oic-bt-wrap"><div class="wl-sub">${(d && d.message) || "Back-test उपलब्ध नहीं (Dhan feed चाहिए)।"}</div></div>`; return; }
  const money = (v) => (v == null ? "—" : "₹" + fmt(v));
  const pct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + fmt(v, 1) + "%");
  const outcomeCls = (o) => (o === "TARGET" ? "up" : o === "STOP" ? "down" : "neu");
  const dirBadge = (s) => s === "correct" ? '<span class="oic-flag on">✓</span>' : s === "wrong" ? '<span class="oic-flag off">✗</span>' : s === "flat" ? '<span class="wl-sub">flat</span>' : '<span class="wl-sub">—</span>';

  // ---- Live grid setup back-test ----
  let liveHtml = "";
  const L = d.live;
  if (L && L.available && L.simulation && L.simulation.available) {
    const s = L.simulation, su = L.setup;
    const dirRow = (s.dir || []).map((de) => `<td>${de.horizon}m ${dirBadge(de.status)} <span class="wl-sub">${de.favMove == null ? "" : (de.favMove >= 0 ? "+" : "") + de.favMove + "p"}</span></td>`).join("");
    liveHtml = `
      <div class="oic-bt-sec">
        <div class="oic-sec-t">आज का Grid setup — back-test (entry ${d.entry})</div>
        <div class="oic-bt-head ${su.direction === "UP" ? "up" : su.direction === "DOWN" ? "down" : "neu"}">
          ${su.direction} · ${su.action} · <b>${s.strike} ${s.optionType}</b> · Exp ${s.expiry} · conf ${su.confidence}/100
        </div>
        <table class="oic-bt-tbl">
          <tr><td>Entry</td><td><b>${money(s.entryPremium)}</b> @ ${s.entryTime} <span class="wl-sub">(spot ${s.entrySpot ?? "—"})</span></td></tr>
          <tr><td>Target / Stop</td><td class="up">${money(s.target)}</td><td class="down">${money(s.stop)}</td></tr>
          <tr><td>Outcome</td><td><span class="oic-status-pill ${outcomeCls(s.outcome)}">${s.outcome}${s.outcomeTime ? " @ " + s.outcomeTime : ""}</span></td><td class="${(s.pnlPct ?? 0) >= 0 ? "up" : "down"}"><b>${pct(s.pnlPct)}</b></td></tr>
          <tr><td>Best / Worst</td><td class="up">${money(s.bestPremium)} (${pct(s.bestPct)}) @ ${s.bestTime}</td><td class="down">${money(s.worstPremium)} (${pct(s.worstPct)}) @ ${s.worstTime}</td></tr>
          <tr><td>Session close</td><td>${money(s.eodPremium)} <span class="${(s.eodPct ?? 0) >= 0 ? "up" : "down"}">(${pct(s.eodPct)})</span></td></tr>
          <tr><td>Direction hit</td>${dirRow}</tr>
        </table>
      </div>`;
  } else {
    liveHtml = `<div class="oic-bt-sec"><div class="oic-sec-t">आज का Grid setup — back-test</div><div class="wl-sub">${(L && (L.message || (L.simulation && L.simulation.message))) || "grid setup back-test उपलब्ध नहीं।"}</div></div>`;
  }

  // ---- Logged-signal replay ----
  let logHtml = "";
  const g = d.log;
  if (g && g.available && g.count) {
    const dc = (hz) => { const b = g.direction[hz] || {}; return `${hz}m: <b class="${(b.winPct||0)>=50?"up":"down"}">${b.winPct||0}%</b> <span class="wl-sub">(${b.correct||0}✓/${b.wrong||0}✗/${b.flat||0}flat)</span>`; };
    const o = g.option || {};
    const rows = (g.signals || []).map((sg) => {
      const sm = sg.sim;
      const res = sm && sm.available ? `<span class="oic-status-pill ${outcomeCls(sm.outcome)}">${sm.outcome}</span> <span class="${(sm.pnlPct??0)>=0?"up":"down"}">${pct(sm.pnlPct)}</span>` : `<span class="wl-sub">${(sm && sm.message) ? "no data" : "—"}</span>`;
      return `<tr><td>${sg.time}</td><td class="${sg.direction === "UP" ? "up" : "down"}">${sg.direction === "UP" ? "▲" : "▼"}${sg.optionType}</td><td>${sg.strike ?? "—"}</td><td>${sg.confidence}%</td><td>${res}</td></tr>`;
    }).join("");
    logHtml = `
      <div class="oic-bt-sec">
        <div class="oic-sec-t">आज के logged signals (${g.count}) — track record</div>
        <div class="oic-bt-summary">Direction: ${dc("5")} · ${dc("15")} · ${dc("60")}</div>
        <div class="oic-bt-summary">Option trades: <b>${o.trades||0}</b> · 🎯 ${o.targets||0} · 🛑 ${o.stops||0} · open ${o.open||0} · win <b class="${(o.winPct||0)>=50?"up":"down"}">${o.winPct||0}%</b> · avg <span class="${(o.avgPnlPct||0)>=0?"up":"down"}">${pct(o.avgPnlPct)}</span></div>
        <table class="oic-bt-tbl"><tr><th>Time</th><th>Dir</th><th>Strike</th><th>Conf</th><th>Result</th></tr>${rows}</table>
      </div>`;
  } else {
    logHtml = `<div class="oic-bt-sec"><div class="oic-sec-t">आज के logged signals — track record</div><div class="wl-sub">${(g && g.message) || "कोई logged signal नहीं।"}</div></div>`;
  }

  box.innerHTML = `<div class="oic-bt-wrap">
    <div class="oic-bt-title">📊 Trader Dashboard Back-test · <b>${d.name}</b> · ${d.date}
      <button class="oic-cbtn" onclick="loadOiBacktest()">↻ फिर चलाएँ</button>
      <button class="oic-cbtn" onclick="el('oic-backtest').innerHTML=''">✕ बंद करें</button>
    </div>
    ${liveHtml}${logHtml}
    <div class="wl-sub" style="margin-top:6px">Historical intraday OI उपलब्ध नहीं — इसलिए DIRECTION आज के live grid read का है (entry समय से आगे); option का premium path व target/stop असली Dhan candles पर मापा गया. Education/simulation — guarantee नहीं.</div>
  </div>`;
}

// ---------- Next-1-Hour Outlook (chart-style read → direction call) ----------
async function loadHourOutlook() {
  const box = el("hour-outlook");
  if (!box) return;
  try {
    const d = await fetchJSON("/api/hour-outlook", 25000);
    if (d && d.outlook) renderHourOutlook(d);
  } catch (_) { /* keep last render */ }
}
function renderHourOutlook(d) {
  const box = el("hour-outlook");
  if (!box) return;
  const list = d.outlook || [];
  if (!list.length) { box.innerHTML = ""; return; }
  const when = d.generatedAt ? new Date(d.generatedAt * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "-";
  const dirPill = (o) => o.direction === "Bullish"
    ? `<span class="ho-dir up">▲ तेज़ी · ${o.optionType}</span>`
    : o.direction === "Bearish" ? `<span class="ho-dir down">▼ मंदी · ${o.optionType}</span>`
    : `<span class="ho-dir neu">◆ Range</span>`;
  const flag = (label, ok) => `<span class="ho-flag ${ok ? "on" : "off"}">${ok ? "✓" : "✗"} ${label}</span>`;
  const cards = list.map((o) => `
    <div class="ho-card ${o.direction === "Bullish" ? "b-up" : o.direction === "Bearish" ? "b-dn" : "b-neu"}">
      <div class="ho-top">
        <div><b class="ho-name">${o.name}</b> <span class="wl-sub">₹${fmt(o.price)}</span></div>
        ${dirPill(o)}
      </div>
      <div class="ho-conf">अगले 1 घंटे भरोसा: <b>${o.confidence}%</b></div>
      <div class="ho-flags">
        ${flag("VWAP", o.aboveVwap)} ${flag("EMA21", o.aboveEma21)} ${flag("EMA50", o.aboveEma50)}
        <span class="ho-flag ${o.rsi >= 55 ? "on" : o.rsi <= 45 ? "off" : "mid"}">RSI ${o.rsi ?? "-"}</span>
        <span class="ho-flag ${o.adx >= 22 ? "on" : "mid"}">ADX ${o.adx ?? "-"}</span>
      </div>
      <div class="ho-lv"><span class="down">S ${o.support1h ?? "-"}</span> · <span class="up">R ${o.resistance1h ?? "-"}</span> · रेंज ±${o.expectedRange ? o.expectedRange.movePts : "-"}</div>
      <div class="ho-scn">${o.scenario || ""}</div>
    </div>`).join("");
  box.innerHTML = `
    <div class="ho-head">🧭 अगले 1 घंटे का रुख <span class="wl-sub">(EMA21/EMA50 + VWAP + RSI + ADX · 15m) · updated ${when} IST ${d.marketOpen ? "" : "· market बंद"}</span></div>
    <div class="ho-cards">${cards}</div>`;
}

// ---------- Option Top Pick (best stock-option scanner, two separate tracks) ----------
function otpDecisionClass(decision) {
  return "decision-" + String(decision).toLowerCase().replace(/[^a-z]+/g, "-").replace(/(^-|-$)/g, "");
}

function renderOtpCandidate(c) {
  const dcls = otpDecisionClass(c.decision);
  const sideCls = c.direction === "Bearish" ? "bearish" : "bullish";
  const opt = c.selectedOption;
  const facts = [
    ["Movement", c.movementStage],
    ["VWAP", c.structure.vwapStatus],
    ["EMA", c.structure.emaStructure],
    ["Score", c.qualityScore.score + "/100"],
  ];
  if (c.track === "LIQUIDITY_DIRECTIONAL" && c.liquidityFlow) {
    facts.push(["Liquidity", c.liquidityFlow.label], ["RVOL", c.liquidityFlow.rvol != null ? fmt(c.liquidityFlow.rvol, 2) + "x" : "—"]);
  } else {
    facts.push(["OI Structure", c.oi.oiVerdict], ["PCR", c.oi.pcr != null ? fmt(c.oi.pcr, 2) : "—"]);
  }
  const factsHtml = facts.map(([k, v]) => `<div><span>${k}</span><b>${v ?? "—"}</b></div>`).join("");

  const levelsHtml = c.levels ? `
    <div class="otp-cand-levels">
      <div><span class="wl-sub">Entry</span><b>₹${fmt(c.levels.entry)}</b></div>
      <div><span class="wl-sub">Target 1</span><b>₹${fmt(c.levels.target1)}</b></div>
      <div><span class="wl-sub">Target 2</span><b>₹${fmt(c.levels.target2)}</b></div>
      <div><span class="wl-sub">Stop</span><b>₹${fmt(c.levels.stop)}</b></div>
      <div><span class="wl-sub">R:R</span><b>${c.levels.riskReward != null ? "1:" + fmt(c.levels.riskReward, 1) : "—"}</b></div>
    </div>` : "";

  const reasonsHtml = (!c.gates.allPass && c.reasons.length) ? `<div class="otp-cand-reasons">${c.reasons.join(" · ")}</div>` : "";

  return `<article class="otp-cand ${dcls}">
    <div class="otp-cand-head">
      <span class="otp-cand-name">${c.name}</span>
      <span class="otp-cand-decision ${dcls}">${c.decision}</span>
    </div>
    ${opt ? `<div class="otp-cand-side ${sideCls}">${opt.side === "CE" ? "BUY CE" : "BUY PE"} · ${opt.strike} <span class="wl-sub" style="font-size:12px">₹${fmt(opt.ltp)}</span></div>` : ""}
    <div class="otp-cand-grid-facts">${factsHtml}</div>
    ${levelsHtml}
    <div class="otp-cand-commentary">${c.commentary}</div>
    ${reasonsHtml}
  </article>`;
}

function renderOtpList(elId, list) {
  const box = el(elId);
  if (!box) return;
  box.innerHTML = list && list.length ? list.map(renderOtpCandidate).join("") : '<div class="otp-empty">No candidates clear the bar right now — no trade preferred over a low-quality one.</div>';
}

let otpBusy = false;
async function loadOptionTopPick() {
  const meta = el("otp-meta");
  if (otpBusy) return;
  otpBusy = true;
  try {
    const d = await fetchJSON("/api/option-top-pick/scan", 60000);
    if (d && d.error) { if (meta) meta.textContent = d.error; return; }
    renderOtpList("otp-liquidity-list", d.liquidityDirectional);
    renderOtpList("otp-setup-list", d.stockSetup);
    if (meta) meta.textContent = `Scanned ${d.scannedCount}/${d.eligibleCount} F&O stocks · updated ${new Date(d.generatedAt * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} IST · ${d.disclaimer || ""}`;
  } catch (e) {
    if (meta) meta.textContent = "Option Top Pick scan unavailable: " + e.message;
  } finally {
    otpBusy = false;
  }
}

// ---------- Liquidity Status (trader-first liquidity + market-move intelligence) ----------
const LS_SHIFT_CLASS = { "Strong Bullish": "bullish", "Bullish": "bullish", "Strong Bearish": "bearish", "Bearish": "bearish", "Neutral": "neutral", "Conflict": "conflict" };
const LS_SHIFT_ICON = { "Strong Bullish": "🟢", "Bullish": "🟢", "Strong Bearish": "🔴", "Bearish": "🔴", "Neutral": "⚪", "Conflict": "⚠️" };

function lsFact(label, value) {
  return `<div class="ls-fact"><span>${label}</span><b>${value ?? "—"}</b></div>`;
}

function renderLiquidityStatus(d) {
  const box = el("ls-body");
  if (!box || !d) return;
  const shiftCls = LS_SHIFT_CLASS[d.liquidityShift] || "neutral";
  const icon = LS_SHIFT_ICON[d.liquidityShift] || "⚪";

  // Section 22 — one-glance summary.
  const glance = `
    <div class="ls-glance ls-${shiftCls}">
      <div class="ls-glance-head">${icon} ${d.liquidityShift.toUpperCase()}</div>
      <div class="ls-fact-grid">
        ${lsFact("Move", d.moveStage.replace(/_/g, " "))}
        ${lsFact("Liquidity", d.directionalConfidence.quality)}
        ${lsFact("Direction", d.directionBias)}
        ${lsFact("Score", d.moveStrength + "/100")}
        ${lsFact("Support", d.battlefield.support.price)}
        ${lsFact("Resistance", d.battlefield.resistance.price)}
        ${lsFact("Trigger", d.trigger ? d.trigger.level : "—")}
        ${lsFact("Invalidation", d.invalidation ? d.invalidation.level : "—")}
      </div>
      <div class="ls-action">ACTION: <b>${d.traderAction}</b></div>
      <div class="wl-sub">${d.traderActionDetail}</div>
    </div>`;

  const conflictBanner = d.conflict.conflict
    ? `<div class="ls-conflict">⚠ LIQUIDITY CONFLICT — ${d.conflict.reason}</div>` : "";

  // Section 1 — system view + trader preparation.
  const systemView = `<div class="otp-cand-commentary" style="margin-top:10px"><b>System View:</b> ${d.systemView}</div>
    <div class="otp-cand-commentary"><b>Trader Preparation:</b> ${d.traderPreparation}</div>`;

  // Section 3 — exact levels + distances.
  const levelRows = d.keyLevels.map((lv) => `
    <div class="ls-level-row">
      <span class="ls-level-label">${lv.label}</span>
      <b>${lv.price ?? "—"}</b>
      <span class="ls-level-meta">${lv.oi != null ? "OI " + fmt(lv.oi, 0) : ""} ${lv.oiChange != null ? (lv.oiChange >= 0 ? "+" : "") + fmt(lv.oiChange, 0) : ""} · ${lv.strength}${lv.distancePts != null ? " · " + Math.abs(lv.distancePts).toFixed(0) + " pts " + (lv.label.includes("SUPPORT") ? "below" : "above") : ""}</span>
    </div>`).join("");

  // Section 9 — battlefield visual.
  const sup = d.battlefield.support, res = d.battlefield.resistance;
  const total = (sup.price != null && res.price != null) ? Math.max(1, res.price - sup.price) : 1;
  const spotPct = (sup.price != null && res.price != null) ? Math.min(100, Math.max(0, ((d.spot - sup.price) / total) * 100)) : 50;
  const battlefield = (sup.price != null && res.price != null) ? `
    <div class="ls-battlefield">
      <div class="ls-bf-row"><span>CALL RESISTANCE ${res.price}</span><div class="ls-bf-bar ls-bf-res" style="width:${res.strength === "STRONG" ? 90 : res.strength === "MODERATE" ? 60 : 30}%"></div><span class="wl-sub">${res.strength}</span></div>
      <div class="ls-bf-spot" style="left:${spotPct}%"><span>● ${fmt(d.spot)}</span></div>
      <div class="ls-bf-row"><span>PUT SUPPORT ${sup.price}</span><div class="ls-bf-bar ls-bf-sup" style="width:${sup.strength === "STRONG" ? 90 : sup.strength === "MODERATE" ? 60 : 30}%"></div><span class="wl-sub">${sup.strength}</span></div>
    </div>` : "";

  // Sections 2 & 18 — evidence.
  const evidenceRows = d.evidence.length ? d.evidence.map((e) => `
    <div class="ls-evidence-row">
      <b>${e.side} ${e.strike ?? ""}</b>
      <span>OI ${e.oiChange != null ? (e.oiChange >= 0 ? "+" : "") + fmt(e.oiChange, 0) : "—"}</span>
      <span>Premium ${e.premiumChangePct != null ? (e.premiumChangePct >= 0 ? "+" : "") + fmt(e.premiumChangePct, 1) + "%" : "—"}</span>
      <span class="ls-interp">${e.interpretation}</span>
    </div>`).join("") : '<div class="wl-sub">No OI baseline yet today — evidence unavailable.</div>';

  // Section 6 — flow score breakdown.
  const scoreRows = d.liquidityFlowScore.breakdown.map((b) => `<div class="ls-score-row"><span>${b.label} (${b.weightPct})</span><b>${b.contribution}</b></div>`).join("");

  // Section 8 — confirmation checklist.
  const confirmedHtml = d.confirmations.confirmed.map((c) => `<li class="ls-ok">✓ ${c.label}</li>`).join("");
  const remainingHtml = d.confirmations.remaining.map((c) => `<li class="ls-warn">⚠ ${c.label}</li>`).join("");

  // Section 13 — early warnings.
  const warnHtml = d.earlyWarnings.length ? d.earlyWarnings.map((w) => `<div class="ls-warning ${w.severity}">⚡ ${w.text}</div>`).join("") : "";

  // Sections 14-15 — shift history.
  const historyHtml = d.shiftHistory.map((p) => `<span class="ls-hist-point">${p.time} <b>${p.state}</b></span>`).join(" → ");

  // Section 16 — freshness.
  const fr = d.freshness;
  const freshness = `<div class="ls-freshness">Price ${fr.priceAgeSec}s ago · OI ${fr.oiAgeSec != null ? fr.oiAgeSec + "s ago" : "n/a"} ${fr.oiStale ? '<span class="ls-stale">OI DATA STALE</span>' : ""} ${fr.liveFeedStale ? '<span class="ls-stale">LIVE FEED STALE</span>' : ""}</div>`;

  box.innerHTML = `
    ${glance}
    ${conflictBanner}
    ${systemView}
    <div class="ls-grid-2">
      <div class="ls-panel"><h5>Key Levels</h5>${levelRows}</div>
      <div class="ls-panel"><h5>Market Battlefield</h5>${battlefield}</div>
    </div>
    <div class="ls-panel"><h5>Big Money / Liquidity Hint</h5>${evidenceRows}</div>
    <div class="ls-grid-2">
      <div class="ls-panel"><h5>Liquidity Flow Score — ${d.liquidityFlowScore.score}/100</h5>${scoreRows}</div>
      <div class="ls-panel"><h5>Confirmation Status</h5><ul class="ls-checklist">${confirmedHtml}${remainingHtml}</ul></div>
    </div>
    ${warnHtml}
    ${historyHtml ? `<div class="ls-panel"><h5>Time-Based Change</h5><div class="ls-history">${historyHtml}</div></div>` : ""}
    <div class="wl-sub">${d.disclaimer || ""}</div>
    ${freshness}`;
}

let lsBusy = false;
async function loadLiquidityStatusScreen() {
  const sel = el("ls-symbol");
  const box = el("ls-body");
  if (!box || lsBusy) return;
  const symbol = (sel && sel.value) || "^NSEI";
  lsBusy = true;
  try {
    const d = await fetchJSON(`/api/liquidity-status/${encodeURIComponent(symbol)}`, 30000);
    if (d && d.error) { box.innerHTML = `<div class="wl-sub">${d.error}</div>`; return; }
    renderLiquidityStatus(d);
  } catch (e) {
    box.innerHTML = `<div class="wl-sub">Liquidity Status unavailable: ${e.message}</div>`;
  } finally {
    lsBusy = false;
  }
}

function renderLiquidityMover(m) {
  const cls = m.direction === "Bearish" ? "bearish" : m.direction === "Bullish" ? "bullish" : "neutral";
  return `<article class="otp-cand">
    <div class="otp-cand-head"><span class="otp-cand-name">${m.name}</span><span class="wl-sub">${m.liquidityFlow}</span></div>
    <div class="otp-cand-side ${cls}">${m.direction} · ${m.moveStage.replace(/_/g, " ")}</div>
    <div class="otp-cand-grid-facts"><div><span>Score</span><b>${m.score}/100</b></div></div>
  </article>`;
}

let lsScanBusy = false;
async function loadLiquidityMovers() {
  const box = el("ls-movers-list");
  if (!box || lsScanBusy) return;
  lsScanBusy = true;
  box.innerHTML = '<div class="otp-empty">Scanning stocks…</div>';
  try {
    const d = await fetchJSON("/api/liquidity-status/scan/movers", 60000);
    if (d && d.error) { box.innerHTML = `<div class="otp-empty">${d.error}</div>`; return; }
    box.innerHTML = d.topMovers && d.topMovers.length ? d.topMovers.map(renderLiquidityMover).join("") : '<div class="otp-empty">No movers cleared the bar right now.</div>';
  } catch (e) {
    box.innerHTML = `<div class="otp-empty">Scan unavailable: ${e.message}</div>`;
  } finally {
    lsScanBusy = false;
  }
}

// ---------- top picks (multi-timeframe) ----------
async function loadTopPicks() {
  const box = el("toppicks");
  const btn = el("load-toppicks");
  if (!box) return;
  loadHourOutlook(); // next-1-hour direction panel (independent, non-blocking)
  // silent = background auto-refresh (don't wipe the table with a "Scanning..." message)
  const silent = arguments[0] === true;
  if (!silent) {
    if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
    if (!state.topPicksData) box.textContent = "Scanning every F&O stock across 5m / 15m / 1h / 1d...";
  }
  try {
    const data = await fetchJSON("/api/top-picks", 22000);
    if (data.error) { if (!silent) box.textContent = data.error; return; }
    renderLive("toppicks", () => renderTopPicks(data));
  } catch (e) {
    if (!silent && !state.topPicksData) box.textContent = "Scan failed: " + e.message;
  } finally {
    if (!silent && btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
  startTopPicksLive();
}

// Auto-refresh Option Top Pick (incl. the major OI build-up column) while the tab
// is open + market is live. OI itself updates ~every 3 min on the exchange, so a
// ~45s poll keeps the view fresh without hammering the option-chain API.
function startTopPicksLive() {
  if (state.topPicksTimer) return;
  state.topPicksTimer = setInterval(() => {
    const pn = document.getElementById("panel-toppicks");
    if (!pn || !pn.classList.contains("active") || (!isMarketOpen() && !isFeedWindow())) return;
    // Don't wipe a chain the user has expanded — skip the silent re-render while
    // any option chain is open (it would collapse it mid-inspection).
    const chainOpen = pn.querySelector(".oic-chain-row") && Array.from(pn.querySelectorAll(".oic-chain-row")).some((r) => r.style.display !== "none");
    if (chainOpen) return;
    loadTopPicks(true);
  }, 45 * 1000);
}

function renderTopPicks(data) {
  state.topPicksData = data;
  const uni = state.tpUniverse || "stock";
  const box = el("toppicks");
  const st = el("toppicks-status");
  if (!box) return;
  if (st) {
    const when = new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const label = uni === "index" ? `${data.scannedIndex || 0} indices · leftover first` : `${data.scanned || 0} stocks · leftover first`;
    const ageSec = data.generatedAt ? Math.max(0, Math.floor(Date.now() / 1000) - data.generatedAt) : null;
    const showLive = data.marketOpen && ageSec != null && ageSec <= 90;
    st.innerHTML = `${showLive ? '<span class="live-dot"></span> LIVE' : data.marketOpen ? "delayed" : "closed"} · ${label} · ${(data.timeframes || []).join("/")} <span class="upd-badge">⟳ ${when}</span>`;
  }
  const dirPill = (d) => d === "Bullish" ? '<span class="risk-pill up">▲ Bull</span>' : d === "Bearish" ? '<span class="risk-pill down">▼ Bear</span>' : '<span class="risk-pill">◆ Neutral</span>';
  const timingPill = (t) => t === "READY TO MOVE" ? '<span class="risk-pill up">🟢 READY TO MOVE</span>' : t === "UNDERWAY" ? '<span class="risk-pill">🟡 UNDERWAY</span>' : t === "EXTENDED" ? '<span class="risk-pill down">🔴 EXTENDED</span>' : '<span class="wl-sub">-</span>';
  const tfCells = (p) => (p.tfSignals || []).map((t) => `${t.tf}:<b class="${t.score >= 0 ? "up" : "down"}">${t.score >= 0 ? "+" : ""}${t.score}</b>`).join(" ");
  const otPill = (ot) => ot === "CE" ? '<span class="risk-pill up">BUY CE</span>' : '<span class="risk-pill down">BUY PE</span>';
  // Clear, self-explanatory Buy instruction: what to buy + which way + the pullback warning.
  const buyCell = (p) => {
    const bull = p.optionType === "CE";
    const cls = bull ? "up" : "down";
    const main = `<span class="risk-pill ${cls}"><b>BUY ${bull ? "CALL" : "PUT"}</b> (${p.optionType})</span>`;
    const dir = `<div class="wl-sub ${cls}" style="margin-top:2px">${bull ? "तेज़ी ▲ — ऊपर जाने पर कमाई" : "मंदी ▼ — नीचे जाने पर कमाई"}</div>`;
    const vol = p.rvol != null ? `<div style="margin-top:2px">${volBadge(p.rvol)}</div>` : "";
    const warn = p.warn ? `<div class="wl-sub down" style="margin-top:2px" title="${(p.warn || "").replace(/"/g, "&quot;")}">⚠ अभी उल्टी चाल — रुक कर confirm लें</div>` : "";
    return main + dir + vol + warn;
  };
  // Directional Movement (ADX/DMI): trend direction (+DI vs -DI) + strength (ADX),
  // and whether it BACKS this CE/PE call — so you take directional trades only
  // when a real trend supports the side.
  const dmCell = (p) => {
    if (p.adx == null || p.dmDir == null) return '<span class="wl-sub">-</span>';
    const bull = p.dmDir === "Bullish";
    const acls = bull ? "up" : "down";
    const arrow = bull ? "▲" : "▼";
    let note = "";
    // IMPORTANT: ADX is LAGGING — it stays high after a move even when price has
    // gone flat. If the run has stalled / gone Range, warn so a high ADX doesn't
    // mislead into a fresh entry when the move is already over.
    if (p.runState === "Range") note = '<div class="wl-sub down">⚠ move ruk gaya (Range) — ADX पुराने move का</div>';
    else if (p.runState === "Stalling") note = '<div class="wl-sub" style="color:#d8a24a">⚠ momentum घट रहा (stalling)</div>';
    else if (p.adx < 20) note = '<div class="wl-sub" style="color:#8a8aa0">flat / chop · avoid</div>';
    else if (p.dmAgree === false) note = `<div class="wl-sub down">⚠ trend opposes ${p.optionType}</div>`;
    else if (p.dmTradeable) note = '<div class="wl-sub up">✓ trend backs call (Running)</div>';
    else note = '<div class="wl-sub" style="color:#8a8aa0">building…</div>';
    return `<div><b class="${acls}">${arrow} ${p.dmStrength}</b></div>
      <div class="wl-sub">ADX <b>${p.adx}</b> · +DI ${p.plusDI} / -DI ${p.minusDI}</div>${note}`;
  };
  // WHEN the current bull/bear run started (time + price), whether it is still
  // Running / Stalling / gone Range, and how much more it is expected to continue.
  // "Run started" = WHEN the current move began + at what price + how far it has run.
  const runCell = (p) => {
    if (!p.runState) return '<span class="wl-sub">-</span>';
    const t = p.runStartAt ? new Date(p.runStartAt * 1000 + 19800000) : null;
    const isDaily = (p.tf || "") === "1d";
    const when = t ? (isDaily ? t.toISOString().slice(5, 10) : t.toISOString().slice(11, 16) + " बजे") : "-";
    return `<div><b>${when}</b></div>
      <div class="wl-sub">₹${fmt(p.runStartPrice)} से</div>
      <div class="wl-sub">अब तक <b class="${p.runMovePct >= 0 ? "up" : "down"}">${p.runMovePct >= 0 ? "+" : ""}${fmt(p.runMovePct, 1)}%</b> चला</div>`;
  };
  // "स्थिति (Stage)" = the SINGLE source of truth for where the move is now —
  // derived from the run (price action), so it never contradicts "Run started".
  // 🟢 चल रहा (fresh) · 🟡 सुस्त (losing steam) · 🔴 रुका (move over/range).
  const stageCell = (p) => {
    if (!p.runState) return timingPill(p.timing); // fallback to RSI timing if no run data
    const more = p.expContinuePct != null && p.expContinuePct > 0 ? `<div class="wl-sub up">अभी ~${fmt(p.expContinuePct, 1)}% और बाक़ी</div>` : "";
    if (p.runState === "Running") return `<span class="risk-pill up">🟢 चल रहा है</span>${more}`;
    if (p.runState === "Stalling") return `<span class="risk-pill" style="background:#3a2f12;color:#e0b34a">🟡 सुस्त पड़ रहा</span>${more}`;
    return `<span class="risk-pill down">🔴 रुका (हो चुका)</span><div class="wl-sub down">नया move नहीं — इंतज़ार</div>`;
  };
  // Major OI movement: the strike where Call / Put OI is building up the MOST
  // (fresh writing). Max CE = resistance wall, max PE = support wall.
  const oiN = (n) => {
    if (n == null || isNaN(n)) return "-";
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
    if (a >= 1e5) return (n / 1e5).toFixed(2) + "L";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };
  const oiMoveCell = (p) => {
    if (p.oiCeStrike == null && p.oiPeStrike == null) return '<span class="wl-sub">-</span>';
    const build = p.oiIsBuildup; // true = real intraday build-up (Δ + %), false = absolute wall
    const cePct = p.oiCePct == null ? "" : ` <span class="down">+${p.oiCePct}%</span>`;
    const pePct = p.oiPePct == null ? "" : ` <span class="up">+${p.oiPePct}%</span>`;
    const ceVal = p.oiCeVal == null ? "" : (build ? "Δ" : "") + oiN(p.oiCeVal);
    const peVal = p.oiPeVal == null ? "" : (build ? "Δ" : "") + oiN(p.oiPeVal);
    const ce = p.oiCeStrike == null ? "" : `<div class="wl-sub">${p.oiCeVeryHigh ? "🔥 " : ""}<b class="down">CE ${p.oiCeStrike}</b> ${ceVal}${cePct} <span style="color:#8a8aa0">resist</span></div>`;
    const pe = p.oiPeStrike == null ? "" : `<div class="wl-sub">${p.oiPeVeryHigh ? "🔥 " : ""}<b class="up">PE ${p.oiPeStrike}</b> ${peVal}${pePct} <span style="color:#8a8aa0">support</span></div>`;
    const tag = build ? "" : '<div class="wl-sub" style="color:#8a8aa0;font-size:10px">wall (baseline forming)</div>';
    return ce + pe + tag;
  };
  // Best low-decay option to buy now: strike + moneyness + premium.
  const lowDecayCell = (p) => {
    if (p.optPremium == null) return '<span class="wl-sub">-</span>';
    return `<div><b>${p.optStrike} ${p.optType}</b> <span class="mny mny-${(p.optMoneyness || "").toLowerCase()}">${p.optMoneyness || ""}</span></div>
      <div>₹<b>${fmt(p.optPremium)}</b></div>`;
  };
  // Decay as % of premium price (theta per day ÷ premium) + Low/Moderate/High tag.
  const decayCell = (p) => {
    if (p.optPremium == null || p.optThetaPct == null) return '<span class="wl-sub">-</span>';
    const dl = p.decayLevel || "n/a";
    const dcls = dl === "Low" ? "up" : dl === "High" ? "down" : "";
    return `<div class="num"><b class="${dcls}">${p.optThetaPct}%</b>/day</div>
      <div class="wl-sub ${dcls}">${dl} decay</div>`;
  };
  const moveCell = (p) => {
    if (p.movedPct == null) return '<span class="wl-sub">-</span>';
    const prog = p.progressPct == null ? 0 : p.progressPct;
    const barCls = prog >= 80 ? "down" : prog >= 50 ? "mid" : "up";
    const leftTxt = p.remainingPct == null ? "" : ` · बाक़ी ~<b class="${p.remainingPct <= 0.2 ? "down" : "up"}">${fmt(p.remainingPct, 1)}%</b>`;
    return `<div>आज <b>${fmt(p.movedPct, 1)}%</b> चला${leftTxt}</div>
      <div class="prog-bar"><div class="prog-fill ${barCls}" style="width:${Math.max(3, Math.min(100, prog))}%"></div></div>
      <div class="wl-sub">दिन की सामान्य चाल ~${p.targetMovePct == null ? "?" : fmt(p.targetMovePct, 1)}% का <b>${fmt(prog, 0)}%</b> हुआ</div>`;
  };
  const actionOf = (p) => {
    if (p.late || p.runState === "Range" || p.timing === "EXTENDED" || (p.progressPct != null && p.progressPct >= 82)) return "LATE";
    if (p.warn || p.runState === "Stalling") return "WAIT";
    return "GO";
  };
  const tfTable = (title, sub, rows) => {
    if (!rows || !rows.length) return `<div class="tp-empty">${title} — no fresh leftover move right now.</div>`;
    const cards = rows.map((p) => {
      const act = actionOf(p);
      const bull = p.optionType === "CE";
      const left = p.remainingPct != null ? fmt(p.remainingPct, 1) + "%" : "—";
      const moved = p.movedPct != null ? fmt(p.movedPct, 1) + "%" : "—";
      const strike = p.optStrike != null ? `${p.optStrike} ${p.optType || p.optionType}` : (p.optionType || "");
      const prem = p.optPremium != null ? "₹" + fmt(p.optPremium) : "";
      const t = p.runStartAt ? new Date(p.runStartAt * 1000 + 19800000) : null;
      const isDaily = (p.tf || "") === "1d";
      const when = t ? (isDaily ? t.toISOString().slice(5, 10) : t.toISOString().slice(11, 16)) : "—";
      const startPx = p.runStartPrice != null ? "₹" + fmt(p.runStartPrice) : "";
      const runPct = p.runMovePct != null ? `${p.runMovePct >= 0 ? "+" : ""}${fmt(p.runMovePct, 1)}%` : "";
      const sup = p.oiSupport != null ? "₹" + fmt(p.oiSupport) : "—";
      const res = p.oiResistance != null ? "₹" + fmt(p.oiResistance) : "—";
      const sodH = p.sod15High != null ? fmt(p.sod15High) : "—";
      const sodL = p.sod15Low != null ? fmt(p.sod15Low) : "—";
      const dH = p.day15High != null ? fmt(p.day15High) : "—";
      const dL = p.day15Low != null ? fmt(p.day15Low) : "—";
      const cPat = p.candle5m && p.candle5m !== "None" ? p.candle5m : "no pattern";
      const cGood = !!p.candle5mGood;
      const cBias = p.candle5mBias > 0 ? "bull" : p.candle5mBias < 0 ? "bear" : "";
      const cNote = (p.candle5mReason || "").replace(/</g, "").slice(0, 80);
      const hot = p.decayHot === "CE" || p.decayHot === "PE" ? p.decayHot : null;
      const thetaLine = p.ceThetaPct != null || p.peThetaPct != null
        ? `ATM θ CE ${p.ceThetaPct ?? "—"}% · PE ${p.peThetaPct ?? "—"}%`
        : (p.optThetaPct != null ? `Buy-side θ ${p.optThetaPct}%/d` : "");
      const thetaWarn = hot
        ? `${hot} decays faster — ${p.decaySideWarn ? "you are buying the bleed side" : "other side bleeds more"}`
        : (p.decayWarn || "");
      const thetaCls = p.decaySideWarn ? "hot" : (hot ? "note" : "");
      return `<button type="button" class="tp-card ${act.toLowerCase()} ${bull ? "ce" : "pe"}" data-sym="${p.symbol}">
        <div class="tp-card-top">
          <span class="tp-rank">${p.rank === 1 ? "★" : "#" + p.rank}</span>
          <span class="tp-act">${act}</span>
          <span class="tp-side">${bull ? "CE" : "PE"}</span>
        </div>
        <div class="tp-name">${p.name}</div>
        <div class="tp-left">${act === "LATE" ? "spent" : "left"} <b>${left}</b></div>
        <div class="tp-meta">${strike} ${prem} · ran ${moved}</div>
        <div class="tp-facts">
          <div><span>Move start</span> <b>${when}</b> ${startPx} ${runPct}</div>
          <div><span>Support</span> <b class="up">${sup}</b> <span>Resist</span> <b class="down">${res}</b></div>
          <div><span>SOD 15m</span> H <b>${sodH}</b> · L <b>${sodL}</b></div>
          <div><span>Day 15m</span> H <b>${dH}</b> · L <b>${dL}</b></div>
          <div class="${cGood ? "good" : "muted"}"><span>Last 5m</span> ${cGood ? "★ " : ""}${cPat}${cBias ? " · " + cBias : ""}${cNote ? `<div class="tp-cnote">${cNote}</div>` : ""}</div>
          ${thetaLine ? `<div class="tp-theta ${thetaCls}"><span>Theta</span> ${thetaLine}${thetaWarn ? `<div>${thetaWarn}</div>` : ""}</div>` : ""}
        </div>
      </button>`;
    }).join("");
    return `<div class="tp-board-h">${title}<span>${sub}</span></div><div class="tp-board">${cards}</div>`;
  };
  const byTf = uni === "index" ? (data.byTfIndex || {}) : (data.byTf || {});
  const sub = state.topPickSub || "15m";
  const uword = uni === "index" ? "Index" : "Stock";
  const meta = {
    "5m": [`${uword} 5m — best leftover first`, "Scalp clock · GO = still room"],
    "15m": [`${uword} 15m — best leftover first`, "Intraday clock · do not chase LATE"],
    "1d": [`${uword} Day — best leftover first`, "Swing clock · leftover ATR"],
  };
  const m = meta[sub] || meta["15m"];
  box.innerHTML = tfTable(m[0], m[1], byTf[sub]);
  box.querySelectorAll(".tp-card[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
  renderHourBreak(uni === "index" ? (data.indexHourBreak || []) : []);
}

// 1-Hour candle breakout watch: which index is nearest to crossing the last
// completed 1h candle's HIGH (top → CE) or LOW (bottom → PE). Flashes when imminent/crossed.
function renderHourBreak(rows) {
  const box = el("tp-breakout");
  if (!box) return;
  if (!rows.length) { box.innerHTML = ""; return; }
    const live = rows.filter((r) => !r.late && !r.crossed);
    if (!live.length) { box.innerHTML = ""; return; }
    const cards = live.map((r) => {
    const bull = r.direction === "Bullish";
    const cls = bull ? "up" : "down";
    const arrow = bull ? "▲" : "▼";
    let status, flash = "";
    if (r.late || r.crossed) { status = "LATE — already crossed"; flash = "hb-late"; }
    else if (r.imminent) { status = `NEAR ${r.nearest === "top" ? "1H HIGH" : "1H LOW"} — ${r.nearestPts} pts`; flash = "hb-flash"; }
    else { status = `${r.nearest === "top" ? "toward 1H HIGH" : "toward 1H LOW"} — ${r.nearestPts} pts (${r.nearestPct}%)`; }
    return `<div class="hb-card ${cls} ${flash}" data-sym="${r.symbol}">
      <div class="hb-head">${arrow} <b>${r.name}</b> <span class="risk-pill ${cls}">${bull ? "BUY CE" : "BUY PE"}</span></div>
      <div class="hb-status">${status}</div>
      <div class="wl-sub">spot ${r.spot} · 1H H ${r.hourHigh} / L ${r.hourLow}</div>
      <div class="wl-sub">1H <span class="up">Support ${r.support1h ?? "-"}</span> · <span class="down">Resistance ${r.resistance1h ?? "-"}</span></div>
    </div>`;
  }).join("");
  box.innerHTML = `<div class="hb-title">🔔 1-Hour Breakout Watch — nearest to cross the last 1H candle's high/low</div><div class="hb-grid">${cards}</div>`;
  box.querySelectorAll(".hb-card[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
}

// ---------- OI Change (nearest ITM) ----------
async function loadOiChange() {
  const box = el("oichange");
  const btn = el("load-oichange");
  if (!box) return;
  if (!state.oiChangeLoadedOnce) box.textContent = "Reading option chains for OI change (ITM / ATM / OTM)...";
  if (btn) { btn.disabled = true; btn.textContent = "Reading..."; }
  try {
    const data = await fetch("/api/oi-change").then((r) => r.json());
    state.oiChangeData = data;
    state.oiChangeLoadedOnce = true;
    renderOiChange();
  } catch (e) {
    box.textContent = "Failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
  // Auto-refresh every 3 minutes while this tab is open.
  if (!state.oiChangeTimer) {
    state.oiChangeTimer = setInterval(() => {
      const pn = document.getElementById("panel-oichange");
      if (pn && pn.classList.contains("active")) {
        fetch("/api/oi-change").then((r) => r.json()).then((d) => { state.oiChangeData = d; renderOiChange(); }).catch(() => {});
      }
    }, 3 * 60 * 1000);
  }
}

function renderOiChange() {
  const data = state.oiChangeData;
  const box = el("oichange");
  const st = el("oichange-status");
  if (!data || !box) return;
  if (st) {
    const when = new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const majors = (data.rows || []).filter((r) => r.major).length;
    st.innerHTML = `${data.marketOpen ? "" : "market closed · "}${(data.rows || []).length} symbols · ${majors} major move${majors === 1 ? "" : "s"} · auto-refresh 3 min <span class="upd-badge">⟳ updated ${when}</span>`;
  }
  const filter = el("oic-filter") ? el("oic-filter").value : "all";
  let rows = (data.rows || []);
  if (filter === "index") rows = rows.filter((r) => r.type === "index");
  else if (filter === "equity") rows = rows.filter((r) => r.type === "equity");
  else if (filter === "signal") rows = rows.filter((r) => r.bias !== "Neutral");
  else if (filter === "major") rows = rows.filter((r) => r.major);
  if (!rows.length) { box.innerHTML = '<div class="wl-sub" style="padding:10px">No OI-change data yet (baseline builds on the first chain reading of the day, during market hours).</div>'; return; }

  const nf = (n) => n == null ? "-" : (n >= 0 ? "+" : "") + Number(n).toLocaleString("en-IN");
  const biasPill = (b) => b === "Bullish" ? '<span class="risk-pill up">▲ Bullish</span>' : b === "Bearish" ? '<span class="risk-pill down">▼ Bearish</span>' : '<span class="risk-pill">◆ Neutral</span>';
  // Consolidated OI directional verdict (prediction from OI data + confidence).
  const verdictPill = (r) => {
    const v = r.oiVerdict || "Neutral", c = r.oiConfidence || 0;
    const cls = v === "Bullish" ? "up" : v === "Bearish" ? "down" : "";
    const arrow = v === "Bullish" ? "▲" : v === "Bearish" ? "▼" : "◆";
    const title = (r.oiReasons || []).join(" · ").replace(/"/g, "&quot;");
    return `<span class="risk-pill ${cls}" title="${title}">OI → ${arrow} ${v} ${c}%</span>`;
  };
  const mnyPill = (m) => `<span class="mny mny-${(m || "").toLowerCase()}">${m}</span>`;
  const spotTxt = (r) => {
    if (r.spotChg == null) return `<span class="wl-sub">spot ${r.underlying ?? "-"}</span>`;
    const up = r.spotChg > 0;
    return `<b class="${up ? "up" : r.spotChg < 0 ? "down" : ""}">${up ? "+" : ""}${r.spotChg}${r.spotChgPct != null ? ` (${r.spotChgPct >= 0 ? "+" : ""}${r.spotChgPct}%)` : ""}</b><div class="wl-sub">spot ${r.underlying ?? "-"}</div>`;
  };
  // One option leg: moneyness + total OI + ΔOI (%) + volume (coloured by writing/unwinding).
  const nfPlain = (n) => n == null ? "-" : Number(n).toLocaleString("en-IN");
  const volTxt = (v) => v == null ? "" : ` <span class="wl-sub">vol ${Number(v).toLocaleString("en-IN")}</span>`;
  const legLine = (leg) => {
    if (!leg) return "-";
    const oiAbs = `<b>${leg.type}</b> OI ${nfPlain(leg.oi)}`;
    if (leg.oiChg == null) return `${mnyPill(leg.moneyness)} ${oiAbs}<span class="wl-sub"> · baseline forming</span>`;
    const oiCls = leg.bullish === true ? "up" : leg.bullish === false ? "down" : "";
    return `${mnyPill(leg.moneyness)} ${oiAbs} <span class="wl-sub">Δ</span><b class="${oiCls}">${nf(leg.oiChg)}</b>${leg.oiChgPct != null ? `<span class="wl-sub"> (${leg.oiChgPct >= 0 ? "+" : ""}${leg.oiChgPct}%)</span>` : ""}${volTxt(leg.vol)}`;
  };
  // Where is buildup very high? Max CE writing = resistance, max PE writing = support.
  const buildupLine = (r) => {
    const parts = [];
    if (r.maxCeBuildup) parts.push(`<span class="bld bld-ce ${r.maxCeBuildup.veryHigh ? "bld-hi" : ""}">🧱 Res @ <b>${r.maxCeBuildup.strike}</b> ${nf(r.maxCeBuildup.oiChg)}${r.maxCeBuildup.oiChgPct != null ? ` (${r.maxCeBuildup.oiChgPct >= 0 ? "+" : ""}${r.maxCeBuildup.oiChgPct}%)` : ""}${r.maxCeBuildup.veryHigh ? " ⚡" : ""}</span>`);
    if (r.maxPeBuildup) parts.push(`<span class="bld bld-pe ${r.maxPeBuildup.veryHigh ? "bld-hi" : ""}">🛡 Sup @ <b>${r.maxPeBuildup.strike}</b> ${nf(r.maxPeBuildup.oiChg)}${r.maxPeBuildup.oiChgPct != null ? ` (${r.maxPeBuildup.oiChgPct >= 0 ? "+" : ""}${r.maxPeBuildup.oiChgPct}%)` : ""}${r.maxPeBuildup.veryHigh ? " ⚡" : ""}</span>`);
    return parts.length ? `<div class="oic-buildup">${parts.join(" ")}</div>` : '<span class="wl-sub">-</span>';
  };
  // Track which symbols' chains are expanded (survives the 3-min auto-refresh).
  if (!state.oiChainOpen) state.oiChainOpen = {};
  // ONE row per symbol: BEST strike + spot + buildup + read, with an expandable ±5 chain.
  const body = rows.map((r) => {
    const cid = (r.symbol || "").replace(/[^a-z0-9]/gi, "");
    const isOpen = !!state.oiChainOpen[cid];
    const b = r.best;
    const bestCell = b
      ? `<div class="wl-sub">strike <b>${b.strike}</b></div><div>${legLine(b.ce)}</div><div>${legLine(b.pe)}</div>`
      : '<span class="wl-sub">collecting…</span>';
    const majorPill = r.major ? `<span class="risk-pill down oic-major-pill" title="${(r.majorReason || "").replace(/"/g, "&quot;")}">&#9889; MAJOR</span>` : "";
    const main = `<tr class="oic-mainrow ${r.major ? "oic-major" : ""}">
      <td><div><span class="a-name oic-open" data-sym="${r.symbol}" title="open stock">${r.name}</span></div><div class="wl-sub">${r.type === "index" ? "index" : "stock"} · ATM ${r.atmStrike ?? "-"}</div>${verdictPill(r)} ${majorPill} <button class="oic-chain-btn ${isOpen ? "on" : ""}" data-cid="${cid}">&#9741; chain ${isOpen ? "&#9650;" : "&#9660;"}</button></td>
      <td>${bestCell}</td>
      <td>${spotTxt(r)}</td>
      <td>${buildupLine(r)}</td>
      <td class="wl-sub">${(r.oiReasons || []).slice(0, 3).join(" · ")}${r.moveRead ? `<div style="margin-top:2px">${r.moveRead}</div>` : ""}</td>
    </tr>`;
    const chainRow = `<tr class="oic-chain-row" id="oic-chain-${cid}"${isOpen ? "" : ' style="display:none"'}><td colspan="5"><div class="oic-chainbox" id="oic-chainbox-${cid}" data-sym="${r.symbol}"></div></td></tr>`;
    return main + chainRow;
  }).join("");
  box.innerHTML = `
    <table class="alerts-table sw-plan oic-table"><thead><tr>
      <th>Symbol · OI verdict</th><th>Best strike — Call &amp; Put ΔOI</th><th>Spot Δ</th><th>Build-up (Res / Sup)</th><th>Why (OI reasons)</th>
    </tr></thead><tbody>${body}</tbody></table>
    <p class="opt-disclaimer">${data.disclaimer || ""}</p>`;
  // Chain expand/collapse (records open state so a refresh keeps it open).
  box.querySelectorAll(".oic-chain-btn").forEach((btn) => btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const cid = btn.getAttribute("data-cid");
    const row = document.getElementById("oic-chain-" + cid);
    if (!row) return;
    const nowOpen = row.style.display === "none";
    row.style.display = nowOpen ? "" : "none";
    state.oiChainOpen[cid] = nowOpen;
    btn.classList.toggle("on", nowOpen);
    btn.innerHTML = "&#9741; chain " + (nowOpen ? "&#9650;" : "&#9660;");
    const cbox = document.getElementById("oic-chainbox-" + cid);
    if (nowOpen && cbox) loadOiChainDetail(cbox.getAttribute("data-sym"), cid, (state.oiChainExp && state.oiChainExp[cid]) || 0);
  }));
  // Re-load any chains that were open before this refresh (keeps them fresh + open).
  Object.keys(state.oiChainOpen).forEach((cid) => {
    if (!state.oiChainOpen[cid]) return;
    const cbox = document.getElementById("oic-chainbox-" + cid);
    if (cbox) loadOiChainDetail(cbox.getAttribute("data-sym"), cid, (state.oiChainExp && state.oiChainExp[cid]) || 0);
  });
  // Open the stock only when the NAME is clicked (not the whole row).
  box.querySelectorAll(".oic-open[data-sym]").forEach((t) => t.addEventListener("click", (e) => { e.stopPropagation(); openStock(t.getAttribute("data-sym")); }));
}

function fmtExpiry(e) {
  if (!e) return "-";
  const d = new Date(e + "T00:00:00");
  if (isNaN(d)) return e;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// Fetch + render the full broker-style option chain for one symbol at a chosen expiry.
async function loadOiChainDetail(symbol, cid, exp) {
  const box = document.getElementById("oic-chainbox-" + cid);
  if (!box) return;
  if (!state.oiChainExp) state.oiChainExp = {};
  state.oiChainExp[cid] = exp || 0;
  box.setAttribute("data-loaded", "1");
  if (!box.innerHTML) box.innerHTML = '<div class="wl-sub" style="padding:6px">Loading option chain…</div>';
  try {
    let d = await fetch("/api/oi-chain?symbol=" + encodeURIComponent(symbol) + "&exp=" + (exp || 0)).then((r) => r.json());
    // Retry once on a transient rate-limit (429) instead of giving up.
    if (!d.available && /429|rate/i.test(String(d.message || ""))) {
      box.innerHTML = '<div class="wl-sub" style="padding:6px">Rate-limited — retrying…</div>';
      await new Promise((r) => setTimeout(r, 1800));
      d = await fetch("/api/oi-chain?symbol=" + encodeURIComponent(symbol) + "&exp=" + (exp || 0)).then((r) => r.json());
    }
    if (!d.available) { box.innerHTML = `<div class="wl-sub" style="padding:6px">${d.message === "chain 429" ? "Chain rate-limited — thodi der baad phir click karein." : (d.message || "chain unavailable")}</div>`; return; }
    box.innerHTML = renderOiChainBroker(d, cid);
    const sel = document.getElementById("oic-exp-" + cid);
    if (sel) sel.addEventListener("change", () => loadOiChainDetail(symbol, cid, Number(sel.value)));
    // Click a CE/PE price → open that option's premium chart.
    box.querySelectorAll(".ocb-ltp-click").forEach((c) => c.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      openOptionChart(c.getAttribute("data-sym"), c.getAttribute("data-ot"), Number(c.getAttribute("data-strike")), c.getAttribute("data-exp"));
    }));
  } catch (e) {
    box.innerHTML = `<div class="wl-sub" style="padding:6px">Failed: ${(e && e.message) || e}</div>`;
  }
}

function renderOiChainBroker(d, cid) {
  const nf = (n) => n == null ? "-" : Number(n).toLocaleString("en-IN");
  const pctSpan = (p) => p == null ? "" : `<span class="${p >= 0 ? "up" : "down"}">${p >= 0 ? "+" : ""}${p}%</span>`;
  let maxOi = 1;
  (d.rows || []).forEach((r) => { maxOi = Math.max(maxOi, r.ceOi || 0, r.peOi || 0); });
  const barW = (v) => Math.max(v ? 2 : 0, Math.min(100, Math.round(((v || 0) / maxOi) * 100)));
  const expOpts = (d.expiries || []).map((e, i) => `<option value="${i}" ${i === d.expiryIdx ? "selected" : ""}>${fmtExpiry(e)}</option>`).join("");
  const sym = d.symbol || "";
  const exp = d.expiry || "";
  // CE/PE price cells are clickable → open that option's premium chart.
  const rows = (d.rows || []).map((r) => `
    <tr class="${r.atm ? "ocb-atm" : ""}">
      <td class="ocb-coi"><div class="ocb-v">${nf(r.ceOi)} ${pctSpan(r.ceOiPct)}</div><div class="ocb-track ce"><div class="ocb-fill ce" style="width:${barW(r.ceOi)}%"></div></div></td>
      <td class="ocb-lt ocb-ltp-click" data-sym="${sym}" data-ot="CE" data-strike="${r.strike}" data-exp="${exp}" title="Chart देखें: ${r.strike} CE">${r.ceLtp != null ? "₹" + r.ceLtp : "-"} ${pctSpan(r.ceLtpPct)} 📈</td>
      <td class="ocb-k">${r.strike}${r.atm ? " &#9664;" : ""}</td>
      <td class="ocb-lt ocb-ltp-click" data-sym="${sym}" data-ot="PE" data-strike="${r.strike}" data-exp="${exp}" title="Chart देखें: ${r.strike} PE">${r.peLtp != null ? "₹" + r.peLtp : "-"} ${pctSpan(r.peLtpPct)} 📈</td>
      <td class="ocb-poi"><div class="ocb-v">${nf(r.peOi)} ${pctSpan(r.peOiPct)}</div><div class="ocb-track pe"><div class="ocb-fill pe" style="width:${barW(r.peOi)}%"></div></div></td>
    </tr>`).join("");
  const banner = `<div class="ocb-spot"><b>${nf(d.spot)}</b>${d.dayChg != null ? ` <span class="${d.dayChg >= 0 ? "up" : "down"}">${d.dayChg >= 0 ? "+" : ""}${d.dayChg} (${d.dayChgPct}%)</span>` : ""}</div>`;
  // Direction indicator: which side OI is building + probable move.
  const v = d.verdict;
  let indicator = "";
  if (v) {
    const cls = v.direction === "Bullish" ? "up" : v.direction === "Bearish" ? "down" : "";
    const arrow = v.direction === "Bullish" ? "▲" : v.direction === "Bearish" ? "▼" : "◆";
    const sidePill = v.side === "Put" ? '<span class="risk-pill up">PUT OI building → support</span>' : v.side === "Call" ? '<span class="risk-pill down">CALL OI building → resistance</span>' : '<span class="risk-pill">Balanced OI</span>';
    // How much MORE the price can move: room from spot to the OI resistance (upside)
    // and to the OI support (downside) — the "price can move more" suggestion.
    const up = v.resistance && d.spot ? Math.round(((v.resistance - d.spot) / d.spot) * 1000) / 10 : null;
    const dn = v.support && d.spot ? Math.round(((d.spot - v.support) / d.spot) * 1000) / 10 : null;
    const moveLine = (up != null || dn != null)
      ? `<span class="wl-sub">🎯 और move हो सकता: ${up != null && up > 0 ? `<span class="up">ऊपर ~${up}%</span> (₹${v.resistance} तक)` : ""}${up != null && up > 0 && dn != null && dn > 0 ? " · " : ""}${dn != null && dn > 0 ? `<span class="down">नीचे ~${dn}%</span> (₹${v.support} तक)` : ""}</span>`
      : "";
    indicator = `<div class="ocb-verdict ${cls}">
      <span class="ocb-vmain">${arrow} Probable ${v.direction}${v.confidence ? ` · ${v.confidence}%` : ""}</span>
      ${sidePill}
      <span class="wl-sub">PCR ${v.pcr ?? "-"} · Support <b>${v.support ?? "-"}</b> · Resistance <b>${v.resistance ?? "-"}</b></span>
      ${moveLine}
      <span class="wl-sub">${(v.reasons || []).join(" · ")}</span>
    </div>`;
  }
  return `
    <div class="ocb-wrap">
      ${indicator}
      <table class="ocb-tbl"><thead>
        <tr><th>Call OI · %</th><th>Call LTP · %</th>
          <th class="ocb-exp">Expiry <select id="oic-exp-${cid}">${expOpts}</select></th>
          <th>Put LTP · %</th><th>Put OI · %</th></tr>
      </thead><tbody>${rows}</tbody></table>
      ${banner}
      <div class="wl-sub" style="padding:4px 2px">${d.note || ""}</div>
    </div>`;
}

// ---------- Option premium chart (click a strike's price in the chain) ----------
// Dual-pane option chart: one click shows BOTH the CE and PE chart for the strike.
const optPanes = { CE: { inst: null, series: null }, PE: { inst: null, series: null } };
// Intraday IST formatter for option premium charts (lightweight-charts renders UTC).
function fmtOptIST(t, withDate) {
  const d = new Date(t * 1000);
  const opts = withDate
    ? { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }
    : { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false };
  return d.toLocaleString("en-IN", opts);
}
// Fetch JSON with a hard timeout so a slow/queued Dhan call (market hours) never
// freezes the UI — it aborts and surfaces a message instead of hanging forever.
async function fetchJSON(url, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
function openOptionChart(sym, ot, strike, expiry) {
  const modal = el("optchart-modal");
  if (!modal || !sym || !expiry) return;
  state.optChart = { sym, strike, expiry, clicked: ot };
  if (!state.optChartWired) {
    state.optChartWired = true;
    if (el("optchart-close")) el("optchart-close").addEventListener("click", closeOptionChart);
    if (el("optchart-tf")) el("optchart-tf").addEventListener("change", drawOptionChart);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeOptionChart(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOptionChart(); });
  }
  el("optchart-title").textContent = `${strike} · ${expiry}`;
  modal.style.display = "flex";
  drawOptionChart();
}
function closeOptionChart() { const m = el("optchart-modal"); if (m) m.style.display = "none"; }
async function drawOnePane(ot) {
  const p = state.optChart;
  const pane = optPanes[ot];
  const cont = el(ot === "CE" ? "optchart-ce-canvas" : "optchart-pe-canvas");
  const sub = el(ot === "CE" ? "optchart-ce-sub" : "optchart-pe-sub");
  if (!p || !cont) return;
  const tf = el("optchart-tf") ? el("optchart-tf").value : "15";
  if (sub) sub.textContent = "लोड हो रहा…";
  try {
    const d = await fetchJSON(`/api/option-candles?symbol=${encodeURIComponent(p.sym)}&type=${ot}&strike=${p.strike}&expiry=${p.expiry}&interval=${tf}`, 20000);
    if (!d.available || !d.candles || !d.candles.length) { if (sub) sub.textContent = d.message || d.error || "chart उपलब्ध नहीं"; if (pane.series) pane.series.setData([]); return; }
    const last = d.candles[d.candles.length - 1];
    if (sub) sub.textContent = `${p.strike} ${ot} · LTP ₹${fmt(last.close)} · ${d.candles.length} candles · lot ${d.lotSize || "-"}`;
    if (!pane.inst) {
      pane.inst = LightweightCharts.createChart(cont, {
        layout: { background: { color: "#0b1220" }, textColor: "#cbd5e1" },
        grid: { vertLines: { color: "#1b2330" }, horzLines: { color: "#1b2330" } },
        width: cont.clientWidth, height: 300,
        // Axis + crosshair in IST (lightweight-charts defaults to UTC → wrong times).
        localization: { timeFormatter: (t) => fmtOptIST(t, true) },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2b3d5c", tickMarkFormatter: (t) => fmtOptIST(t, false) },
        rightPriceScale: { borderColor: "#2b3d5c" },
      });
      pane.series = pane.inst.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", borderVisible: false, wickUpColor: "#16c784", wickDownColor: "#ea3943" });
    }
    const data = d.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })).sort((a, b) => a.time - b.time);
    pane.series.setData(data);
    pane.inst.applyOptions({ width: cont.clientWidth });
    pane.inst.timeScale().fitContent();
  } catch (e) {
    if (sub) sub.textContent = e.name === "AbortError" ? "timeout — दुबारा try करें" : "Failed: " + e.message;
  }
}
// System's Buy CALL / Buy PUT suggestion for the underlying, based on 15m signal
// + market regime (Good = take, Whipsaw/Range = avoid, Lottery = small OTM).
async function updateOptionVerdict() {
  const p = state.optChart;
  const box = el("optchart-verdict");
  if (!p || !box) return;
  box.className = "optchart-verdict";
  box.textContent = "विश्लेषण हो रहा…";
  try {
    const s = await fetchJSON(`/api/signal/${encodeURIComponent(p.sym)}?interval=15m`, 15000);
    if (!s || s.error) { box.textContent = "सुझाव नहीं मिल सका: " + (s && s.error ? s.error : "no data"); return; }
    const reg = s.regime, score = s.score ?? 0;
    const bull = score >= 15 ? true : score <= -15 ? false : (reg && reg.dir ? reg.dir.includes("▲") : null);
    const st = reg ? reg.state : null;
    const dirTxt = bull === true ? "CALL (CE)" : bull === false ? "PUT (PE)" : "कोई साफ़ दिशा नहीं";
    const sc = `${score > 0 ? "+" : ""}${score}`;
    let cls = "avoid", msg;
    if (st === "good") {
      cls = bull ? "buy-ce" : "buy-pe";
      msg = `✅ सुझाव: ${dirTxt} लें — ${reg.emoji} ${reg.label} · signal ${s.label} (${sc}). ${reg.note}`;
    } else if (st === "lottery") {
      cls = bull ? "buy-ce" : "buy-pe";
      msg = `🎰 Coil/Lottery — सस्ता OTM ${bull ? "CE" : "PE"} छोटी size में (high risk/high reward) · signal ${s.label} (${sc}).`;
    } else if (st === "whipsaw") {
      msg = `⚠️ मत लो — Whipsaw, सिर्फ़ SL लगेगा · signal ${s.label} (${sc}).`;
    } else if (st === "range") {
      msg = `🔴 मत लो — Range-bound, theta खा जाएगा · signal ${s.label} (${sc}).`;
    } else {
      cls = bull === true ? "buy-ce" : bull === false ? "buy-pe" : "avoid";
      msg = `${bull === null ? "◆" : bull ? "▲" : "▼"} signal ${s.label ?? "-"} (${sc})${reg ? ` · ${reg.label}` : ""}${dirTxt !== "कोई साफ़ दिशा नहीं" ? ` → ${dirTxt} की ओर झुकाव` : ""}.`;
    }
    box.className = "optchart-verdict " + cls;
    box.textContent = msg;
  } catch (e) {
    box.className = "optchart-verdict";
    box.textContent = "सुझाव नहीं मिल सका: " + (e.name === "AbortError" ? "timeout" : e.message);
  }
}
async function drawOptionChart() {
  const p = state.optChart;
  if (!p) return;
  updateOptionVerdict(); // async, non-blocking — verdict fills in independently
  await Promise.all([drawOnePane("CE"), drawOnePane("PE")]);
}

// ---------- Price Projector (spot move → CE/PE expected price) ----------
async function initProjector() {
  const sel = el("pj-symbol");
  if (sel) {
    try {
      const d = await fetchJSON("/api/backtest/option/underlyings", 15000);
      const list = d.underlyings || [];
      sel.innerHTML = list.map((u) => `<option value="${u.symbol}">${u.name}</option>`).join("") || '<option value="">कोई नहीं</option>';
    } catch { sel.innerHTML = '<option value="">लोड नहीं हुआ</option>'; }
  }
  if (el("pj-fetch")) el("pj-fetch").addEventListener("click", projectorFetch);
  if (el("pj-calc")) el("pj-calc").addEventListener("click", projectorCalc);
  if (el("pj-strike")) el("pj-strike").addEventListener("change", () => {
    const st = state.pjChain && state.pjChain.byStrike;
    const k = Number(el("pj-strike").value);
    if (st && st[k]) { el("pj-ce").value = st[k].ceLtp ?? ""; el("pj-pe").value = st[k].peLtp ?? ""; }
  });
}
async function projectorFetch() {
  const sym = el("pj-symbol").value;
  const status = el("pj-status");
  if (!sym) { if (status) status.textContent = "पहले stock/index चुनें।"; return; }
  if (status) status.textContent = "Chain लोड हो रहा…";
  try {
    const d = await fetchJSON("/api/option-projector?symbol=" + encodeURIComponent(sym), 25000);
    if (!d.available) { if (status) status.textContent = d.message || "उपलब्ध नहीं"; return; }
    state.pjChain = { byStrike: {} };
    (d.strikes || []).forEach((s) => { state.pjChain.byStrike[s.strike] = s; });
    el("pj-spot").value = d.spot;
    if (!el("pj-target").value) el("pj-target").value = d.spot;
    el("pj-strike").innerHTML = (d.strikes || []).map((s) => `<option value="${s.strike}" ${s.strike === d.strike ? "selected" : ""}>${s.strike}</option>`).join("");
    el("pj-ce").value = d.current.ce ?? "";
    el("pj-pe").value = d.current.pe ?? "";
    if (status) status.innerHTML = `${d.name} · spot <b>${d.spot}</b> · expiry ${d.expiry || "-"} · ATM ${d.strike}. अब target spot डालकर Calculate दबाएँ।`;
  } catch (e) {
    if (status) status.textContent = e.name === "AbortError" ? "timeout — दुबारा try करें" : "Failed: " + e.message;
  }
}
async function projectorCalc() {
  const sym = el("pj-symbol").value;
  const status = el("pj-status");
  const strike = el("pj-strike").value;
  const target = el("pj-target").value;
  if (!sym || !strike || !target) { if (status) status.textContent = "symbol, strike और target spot चाहिए (पहले Fetch दबाएँ)।"; return; }
  const q = new URLSearchParams({ symbol: sym, strike, targetSpot: target });
  if (el("pj-spot").value) q.set("spot", el("pj-spot").value);
  if (el("pj-ce").value) q.set("ceLtp", el("pj-ce").value);
  if (el("pj-pe").value) q.set("peLtp", el("pj-pe").value);
  if (status) status.textContent = "गणना हो रही…";
  try {
    const d = await fetchJSON("/api/option-projector?" + q.toString(), 25000);
    if (!d.available) { if (status) status.textContent = d.message || "उपलब्ध नहीं"; return; }
    renderProjector(d);
    if (status) status.textContent = "";
  } catch (e) {
    if (status) status.textContent = e.name === "AbortError" ? "timeout — दुबारा try करें" : "Failed: " + e.message;
  }
}
function renderProjector(d) {
  const box = el("pj-result");
  if (!box) return;
  const money = (v) => v == null ? "—" : "₹" + fmt(v);
  const t = d.target || {};
  const ce = t.ce, pe = t.pe;
  const move = Math.round((d.targetSpot - d.spot) * 100) / 100;
  const chgTxt = (proj, cur) => {
    if (!proj || cur == null) return "";
    const diff = Math.round((proj.price - cur) * 100) / 100;
    const pct = cur ? Math.round((diff / cur) * 1000) / 10 : 0;
    const cls = diff >= 0 ? "up" : "down";
    return `<span class="${cls}">${diff >= 0 ? "+" : ""}${diff} (${pct >= 0 ? "+" : ""}${pct}%)</span>`;
  };
  const head = `<div class="pj-head">${d.name} · strike <b>${d.strike}</b> · spot <b>${d.spot}</b> → target <b>${d.targetSpot}</b> <span class="wl-sub">(${move >= 0 ? "+" : ""}${move} pts · ${d.dteDays != null ? d.dteDays + " दिन expiry" : ""})</span></div>`;
  const cards = `<div class="pj-cards">
    <div class="pj-card ce">
      <div class="pj-card-t">CALL (CE) ${d.strike}</div>
      <div class="pj-card-now">अभी: ${money(d.current.ce)}</div>
      <div class="pj-card-px">${ce ? money(ce.price) : "—"}</div>
      <div class="pj-card-chg">${chgTxt(ce, d.current.ce)}</div>
      <div class="wl-sub">${ce ? ce.method : "—"}</div>
    </div>
    <div class="pj-card pe">
      <div class="pj-card-t">PUT (PE) ${d.strike}</div>
      <div class="pj-card-now">अभी: ${money(d.current.pe)}</div>
      <div class="pj-card-px">${pe ? money(pe.price) : "—"}</div>
      <div class="pj-card-chg">${chgTxt(pe, d.current.pe)}</div>
      <div class="wl-sub">${pe ? pe.method : "—"}</div>
    </div>
  </div>`;
  const rows = (d.ladder || []).map((L) => `<tr class="${L.spot === d.spot ? "pj-cur" : ""}">
      <td class="num">${L.spot}</td>
      <td class="num up">${L.ce ? money(L.ce.price) : "—"}</td>
      <td class="num down">${L.pe ? money(L.pe.price) : "—"}</td>
    </tr>`).join("");
  const ladder = `<table class="pj-ladder"><thead><tr><th>Spot</th><th>CE भाव</th><th>PE भाव</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.innerHTML = head + cards + `<div class="pj-ladder-title">Ladder — अलग-अलग spot पर अनुमानित भाव</div>` + ladder + `<div class="wl-sub" style="margin-top:8px">${d.disclaimer || ""}</div>`;
}

// ---------- Bull % Rank (historical up-day bias) ----------
async function loadBullRank() {
  const box = el("bullrank");
  const btn = el("load-bullrank");
  if (!box) return;
  const days = el("br-days") ? el("br-days").value : "120";
  if (btn) { btn.disabled = true; btn.textContent = "Ranking..."; }
  box.textContent = "Ranking stocks by historical bull %...";
  try {
    const data = await fetch("/api/bull-rank?days=" + encodeURIComponent(days)).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderBullRank(data);
  } catch (e) {
    box.textContent = "Rank failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}

function renderBullRank(data) {
  const box = el("bullrank");
  const st = el("bullrank-status");
  if (st) {
    const when = new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    st.innerHTML = `ranked ${data.scanned || 0} stocks · ${data.days}-day daily history · updated ${when}`;
  }
  const rows = data.rows || [];
  if (!rows.length) { box.innerHTML = '<div class="wl-sub">No data.</div>'; return; }
  const biasPill = (b) =>
    b === "Strong Bull" ? '<span class="risk-pill up">▲▲ Strong Bull</span>' :
    b === "Bullish" ? '<span class="risk-pill up">▲ Bullish</span>' :
    b === "Strong Bear" ? '<span class="risk-pill down">▼▼ Strong Bear</span>' :
    b === "Bearish" ? '<span class="risk-pill down">▼ Bearish</span>' :
    '<span class="risk-pill">◆ Neutral</span>';
  const bar = (pct) => `<div class="bull-bar"><div class="bull-fill" style="width:${Math.max(2, Math.min(100, pct))}%"></div><span class="bull-bar-txt">${fmt(pct, 1)}%</span></div>`;
  const streakTxt = (s) => s > 0 ? `<span class="up">▲ ${s}d up</span>` : s < 0 ? `<span class="down">▼ ${Math.abs(s)}d down</span>` : "-";
  const body = rows.map((p) => `
    <tr data-sym="${p.symbol}">
      <td class="a-rank">${p.rank === 1 ? "★" : "#" + p.rank}</td>
      <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ₹${fmt(p.price)} ${p.isFno ? '<span class="risk-pill up">F&O</span>' : ""}</div></td>
      <td style="min-width:130px">${bar(p.bullPct)}</td>
      <td>${biasPill(p.bias)}</td>
      <td class="num ${(p.recentBullPct ?? 50) >= 50 ? "up" : "down"}">${p.recentBullPct == null ? "-" : fmt(p.recentBullPct, 1) + "%"}<div class="wl-sub">last 20d</div></td>
      <td class="num ${p.windowReturnPct >= 0 ? "up" : "down"}">${p.windowReturnPct >= 0 ? "+" : ""}${fmt(p.windowReturnPct, 1)}%</td>
      <td class="num"><span class="up">+${p.avgUpPct == null ? "-" : fmt(p.avgUpPct, 2)}</span> / <span class="down">-${p.avgDownPct == null ? "-" : fmt(p.avgDownPct, 2)}</span><div class="wl-sub">avg up / down day</div></td>
      <td class="wl-sub">${streakTxt(p.streak)}<div>${p.upDays}▲ / ${p.downDays}▼</div></td>
    </tr>`).join("");
  // ---- MARKET-OPEN SUGGESTION: low-risk, consistent-direction movers ----
  // Net daily drift (expectancy) + direction consistency (history AND recent
  // agree = low flip risk) + favourable asymmetry (up days bigger than down for
  // bulls) => stocks whose direction is unlikely to flip and give a clean move.
  const expc = (p) => (p.bullPct / 100) * (p.avgUpPct || 0) - (p.bearPct / 100) * (p.avgDownPct || 0);
  const diverges = (p) => p.recentBullPct != null && ((p.bullPct >= 55 && p.recentBullPct < 42) || (p.bullPct <= 45 && p.recentBullPct > 58));
  const lowRiskBull = (p) => (p.avgUpPct || 0) >= (p.avgDownPct || 0) * 1.03;
  const lowRiskBear = (p) => (p.avgDownPct || 0) >= (p.avgUpPct || 0) * 1.03;
  const fno = rows.filter((p) => p.isFno); // option-tradeable names for the suggestion
  const pool = fno.length ? fno : rows;
  const cePick = pool
    .filter((p) => p.bullPct >= 54 && (p.recentBullPct == null || p.recentBullPct >= 50) && expc(p) > 0 && !diverges(p))
    .sort((a, b) => (b.bullPct - 50 + expc(b) * 8 + (b.recentBullPct ?? 50) - 50) - (a.bullPct - 50 + expc(a) * 8 + (a.recentBullPct ?? 50) - 50))
    .slice(0, 5);
  const pePick = pool
    .filter((p) => p.bullPct <= 46 && (p.recentBullPct == null || p.recentBullPct <= 50) && expc(p) < 0 && !diverges(p))
    .sort((a, b) => (50 - b.bullPct - expc(b) * 8 + 50 - (b.recentBullPct ?? 50)) - (50 - a.bullPct - expc(a) * 8 + 50 - (a.recentBullPct ?? 50)))
    .slice(0, 5);
  const sugRow = (p, bull) => `<div class="br-sug ${bull ? "up" : "down"}" data-sym="${p.symbol}">
      <b>${bull ? "▲" : "▼"} ${p.name}</b> ${(bull ? lowRiskBull(p) : lowRiskBear(p)) ? '<span class="risk-pill up">कम risk</span>' : ""}
      <div class="wl-sub">${bull ? "Bull" : "Bear"} ${bull ? fmt(p.bullPct, 0) : fmt(p.bearPct, 0)}% · recent ${p.recentBullPct == null ? "-" : fmt(p.recentBullPct, 0) + "%"} · avg ${bull ? "+" + fmt(p.avgUpPct || 0, 1) : "-" + fmt(p.avgDownPct || 0, 1)}%/दिन · ${p.streak > 0 ? p.streak + "d↑" : p.streak < 0 ? Math.abs(p.streak) + "d↓" : "-"}</div>
    </div>`;
  const sugBlock = `
    <div class="br-suggest">
      <div class="br-sug-title">🎯 Market-Open Suggestion — <span class="wl-sub">consistent direction (trend flip risk कम) + low-risk clean movers · F&amp;O</span></div>
      <div class="br-sug-grid">
        <div class="br-sug-col"><div class="br-sug-h up">🟢 BUY CALL (CE) — लगातार तेज़ी</div>${cePick.length ? cePick.map((p) => sugRow(p, true)).join("") : '<div class="wl-sub">कोई साफ़ consistent bull नहीं</div>'}</div>
        <div class="br-sug-col"><div class="br-sug-h down">🔴 BUY PUT (PE) — लगातार मंदी</div>${pePick.length ? pePick.map((p) => sugRow(p, false)).join("") : '<div class="wl-sub">कोई साफ़ consistent bear नहीं</div>'}</div>
      </div>
      <div class="wl-sub" style="margin-top:4px">चुनाव: इतिहास <b>और</b> हाल-फ़िलहाल दोनों एक ही दिशा (कोई flip नहीं) + up-days का आकार down-days से बड़ा (कम risk). Market-open पर इन्हीं में entry ढूँढें, stop ज़रूर रखें।</div>
    </div>`;
  box.innerHTML = sugBlock + `
    <h3 class="sw-plan-title" style="margin-top:14px">पूरी Bull % Ranking</h3>
    <table class="alerts-table sw-plan"><thead><tr>
      <th>#</th><th>Stock</th><th>Bull %</th><th>Bias</th><th>Recent</th><th>Return</th><th>Avg day</th><th>Streak · days</th>
    </tr></thead><tbody>${body}</tbody></table>
    <p class="opt-disclaimer">${data.disclaimer || ""}</p>`;
  box.querySelectorAll(".br-sug[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
}

// ---------- Move Timing (when the market moves most) ----------
// ---------- Backtest (Dhan historical data) ----------
async function initDhanBacktest() {
  const sel = el("dbt-symbol");
  const from = el("dbt-from");
  const to = el("dbt-to");
  const runBtn = el("dbt-run");
  if (to && !to.value) {
    const d = new Date(Date.now() + 19800000); // IST "today"
    to.value = d.toISOString().slice(0, 10);
    to.max = to.value;
  }
  if (from && !from.value) {
    const d = new Date(Date.now() + 19800000);
    d.setUTCFullYear(d.getUTCFullYear() - 2); // default: 2 years back
    from.value = d.toISOString().slice(0, 10);
  }
  if (sel && !sel.options.length) {
    try {
      const d = await fetch("/api/backtest-dhan/symbols").then((r) => r.json());
      sel.innerHTML = (d.symbols || []).map((s) => `<option value="${s.symbol}">${s.name} (${s.symbol})</option>`).join("");
    } catch (_) { /* leave empty, run will surface the error */ }
  }
  if (runBtn) runBtn.addEventListener("click", runDhanBacktest);
  loadDhanDataMode();
  loadAiDataStatus();
  loadAiTrainingStatus();
}

async function loadDhanDataMode() {
  const box = el("dbt-datamode");
  if (!box) return;
  try {
    const d = await fetch("/api/backtest-dhan/data-mode").then((r) => r.json());
    const oiCls = d.historicalOiBacktest === "AVAILABLE" ? "ok" : "blocked";
    box.innerHTML = `<b>DATA MODE</b>`
      + `<span>Technical Data: <b class="ok">${d.technicalData}</b></span>`
      + `<span>Historical Full Option Chain: <b class="${d.historicalFullOptionChain === "AVAILABLE" ? "ok" : "blocked"}">${d.historicalFullOptionChain}</b></span>`
      + `<span>Historical OI Backtest: <b class="${oiCls}">${d.historicalOiBacktest}</b></span>`;
  } catch (_) {
    box.textContent = "Could not load DATA MODE status.";
  }
}

async function loadAiDataStatus() {
  const box = el("ai-data-status");
  if (!box) return;
  try {
    const d = await fetch("/api/ai/data-status").then((r) => r.json());
    box.innerHTML = `<b>AI DATA COLLECTION</b>`
      + `<span>Status: <b class="${d.status === "ACTIVE" ? "ok" : "blocked"}">${d.status}</b></span>`
      + `<span>Today's snapshots: <b>${fmt(d.todaySnapshots, 0)}</b></span>`
      + `<span>Option-chain records: <b>${fmt(d.optionChainRecords, 0)}</b></span>`
      + `<span>First collection: <b>${d.firstCollection || "-"}</b></span>`
      + `<span>Last collection: <b>${d.lastCollection || "-"}</b></span>`
      + `<span>Data quality: <b class="${d.dataQualityPercent == null || d.dataQualityPercent >= 95 ? "ok" : "blocked"}">${d.dataQualityPercent != null ? fmt(d.dataQualityPercent, 1) + "%" : "-"}</b></span>`
      + `<span>Training dataset: <b class="${d.trainingDatasetReady ? "ok" : "blocked"}">${d.trainingDatasetReady ? "READY" : "NOT READY"}</b></span>`
      + `<span>Observations: <b>${fmt(d.observations, 0)} / ${fmt(d.minObservationsRequired, 0)}</b></span>`;
  } catch (_) {
    box.textContent = "Could not load AI data-collection status.";
  }
}

async function loadAiTrainingStatus() {
  const box = el("ai-training-status");
  if (!box) return;
  try {
    const d = await fetch("/api/ai/training-status").then((r) => r.json());
    const okCls = (v) => (v === "AVAILABLE" || v === "READY" || v === "REACHED" ? "ok" : v === "DISABLED" ? "ok" : "blocked");
    box.innerHTML = `<b>AI TRAINING STATUS</b>`
      + `<span>Historical technical data: <b class="${okCls(d.historicalTechnicalData)}">${d.historicalTechnicalData}</b></span>`
      + `<span>Live OI archive: <b class="${d.liveOiArchive === "COLLECTING" ? "ok" : "blocked"}">${d.liveOiArchive}</b></span>`
      + `<span>Feature pipeline: <b class="${okCls(d.featurePipeline)}">${d.featurePipeline}</b></span>`
      + `<span>Label pipeline: <b class="${okCls(d.labelPipeline)}">${d.labelPipeline}</b></span>`
      + `<span>Minimum observations: <b class="${okCls(d.minimumObservations)}">${d.minimumObservations}</b> (${fmt(d.observations, 0)}/${fmt(d.minObservationsRequired, 0)})</span>`
      + `<span>Model training: <b class="${okCls(d.modelTraining)}">${d.modelTraining}</b></span>`;
  } catch (_) {
    box.textContent = "Could not load AI training status.";
  }
}

async function runDhanBacktest() {
  const btn = el("dbt-run");
  const status = el("dbt-status");
  const summary = el("dbt-summary");
  if (btn) { btn.disabled = true; btn.textContent = "Running..."; }
  if (status) { status.textContent = "Fetching Dhan historical candles — a 2-year intraday range can take a while (paginated in 90-day chunks)..."; status.className = "conn-status"; }
  if (summary) summary.textContent = "";
  el("dbt-informational") && (el("dbt-informational").innerHTML = "");
  el("dbt-trades") && (el("dbt-trades").innerHTML = "");
  try {
    const body = {
      symbol: el("dbt-symbol")?.value,
      interval: el("dbt-interval")?.value || "60",
      fromDate: el("dbt-from")?.value,
      toDate: el("dbt-to")?.value,
      sl: el("dbt-sl")?.value,
      target: el("dbt-target")?.value,
      threshold: el("dbt-threshold")?.value,
      short: !!el("dbt-short")?.checked,
      mode: el("dbt-mode")?.value || "TECHNICAL_ONLY",
    };
    const r = await fetch("/api/backtest-dhan/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json());
    if (r.error) {
      if (status) { status.textContent = r.error; status.className = "conn-status err"; }
      return;
    }
    if (status) { status.textContent = ""; }
    renderDhanBacktest(r);
  } catch (e) {
    if (status) { status.textContent = "Backtest failed: " + e.message; status.className = "conn-status err"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Run backtest"; }
  }
}

function renderDhanBacktest(r) {
  const pf = r.profitFactor === null || r.profitFactor === "Infinity" || !isFinite(r.profitFactor) ? "∞" : fmt(r.profitFactor);
  const net = r.netPnlPercent;
  const summary = el("dbt-summary");
  if (summary) {
    summary.innerHTML = `
      <div class="bt-metrics">
        <div class="metric"><span>Trades</span><b>${r.totalTrades}</b></div>
        <div class="metric"><span>Win rate</span><b>${fmt(r.winRate)}%</b></div>
        <div class="metric"><span>Net P&L (1 unit)</span><b class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : ""}${fmt(net)}%</b></div>
        <div class="metric"><span>Profit factor</span><b>${pf}</b></div>
        <div class="metric"><span>Avg win</span><b class="up">+${fmt(r.avgWinPercent)}%</b></div>
        <div class="metric"><span>Avg loss</span><b class="down">-${fmt(r.avgLossPercent)}%</b></div>
        <div class="metric"><span>Max drawdown</span><b class="down">-${fmt(r.maxDrawdownPercent)}%</b></div>
      </div>
      <p class="wl-sub">${r.symbol} · ${r.dhanInterval === "1d" ? "Daily" : r.dhanInterval + " min"} · ${r.fromDate} → ${r.toDate} · ${r.candles} candles. Past performance does not predict future results.</p>`;
  }
  const info = el("dbt-informational");
  if (info && r.informational) {
    const inf = r.informational;
    info.innerHTML = `<b>End-of-window informational reads (not part of the entry/exit decision above):</b> `
      + `EMA confluence: <b>${inf.emaConfluence || "-"}</b> · `
      + `Momentum Burst: <b>${inf.momentumBurst?.state || "-"}</b> (${inf.momentumBurst?.direction || "-"}) · `
      + `Market Regime: <b>${inf.marketRegime?.label || inf.marketRegime?.state || "-"}</b>`;
  }
  const tradesBox = el("dbt-trades");
  if (tradesBox) {
    const rows = (r.trades || []).slice(-100).map((t) => {
      const dt = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
      return `<tr>
        <td>${t.side}</td>
        <td>${dt(t.entryTime)}</td>
        <td class="num">${fmt(t.entryPrice)}</td>
        <td>${dt(t.exitTime)}</td>
        <td class="num">${fmt(t.exitPrice)}</td>
        <td class="num ${t.pnlPercent >= 0 ? "up" : "down"}">${t.pnlPercent >= 0 ? "+" : ""}${fmt(t.pnlPercent)}%</td>
        <td class="wl-sub">${t.exitReason}</td>
      </tr>`;
    }).join("");
    tradesBox.innerHTML = rows
      ? `<table class="dbt-trade-table"><thead><tr><th>Side</th><th>Entry</th><th>@</th><th>Exit</th><th>@</th><th>P&L%</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
         <p class="wl-sub">${r.trades.length > 100 ? "Showing last 100 of " + r.trades.length + " trades." : ""}</p>`
      : `<p class="wl-sub">No trades in this window at the current threshold/SL/target.</p>`;
  }
}

function initMoveTiming() {
  const sel = el("mt-symbol");
  if (sel && !sel.options.length) {
    const syms = (state.symbols || []);
    sel.innerHTML = syms.map((s) => `<option value="${s.symbol}">${s.name} (${s.symbol})</option>`).join("");
  }
}

async function runMoveTiming() {
  const box = el("movetiming");
  const btn = el("mt-apply");
  if (!box) return;
  const symbol = el("mt-symbol") ? el("mt-symbol").value : "^NSEI";
  const period = el("mt-period") ? el("mt-period").value : "weekly";
  if (btn) { btn.disabled = true; btn.textContent = "Analyzing..."; }
  box.textContent = "Analyzing when " + symbol + " moves most across ~45 days...";
  try {
    const data = await fetch(`/api/move-timing?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}`).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderMoveTiming(data);
  } catch (e) {
    box.textContent = "Analysis failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Analyze"; }
  }
}

function renderMoveTiming(d) {
  const box = el("movetiming");
  const prof = d.intradayProfile || [];
  const maxRange = Math.max(1e-9, ...prof.map((s) => s.avgRangePct));
  const activeSet = new Set((d.mostActive || []).map((s) => s.slot));
  // Intraday bar-by-bar profile with a simple inline bar.
  const profRows = prof.map((s) => {
    const w = Math.round((s.avgRangePct / maxRange) * 100);
    const hot = activeSet.has(s.slot);
    return `<tr>
      <td><b>${s.slot}</b>${hot ? ' <span class="risk-pill up">hot</span>' : ""}</td>
      <td style="width:50%"><div style="background:${hot ? "var(--up)" : "#2b3d5c"};height:12px;width:${w}%;border-radius:3px"></div></td>
      <td class="num">${fmt(s.avgRangePct)}%</td>
      <td class="num wl-sub">${fmt(s.avgAbsRetPct)}%</td>
    </tr>`;
  }).join("");
  // Weekday breakdown (Monday..Friday), highlight the most active day.
  const wd = d.byWeekday || [];
  const maxWd = Math.max(1e-9, ...wd.map((x) => x.avgDailyRangePct));
  const wdRows = wd.map((x) => {
    const hot = x.avgDailyRangePct === maxWd;
    const w = Math.round((x.avgDailyRangePct / maxWd) * 100);
    return `<tr>
      <td><b>${x.day}</b>${hot ? ' <span class="risk-pill up">most active</span>' : ""}</td>
      <td style="width:45%"><div style="background:${hot ? "var(--up)" : "#2b3d5c"};height:12px;width:${w}%;border-radius:3px"></div></td>
      <td class="num"><b>${fmt(x.avgDailyRangePct)}%</b></td>
      <td class="num wl-sub">${x.days} days</td>
    </tr>`;
  }).join("");
  // Weekly labels get a "Mon, DD Mon" day name; monthly stays YYYY-MM.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtLabel = (label) => {
    if (d.period !== "weekly" || !/^\d{4}-\d{2}-\d{2}$/.test(label)) return label;
    const dt = new Date(label + "T00:00:00Z");
    const dn = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
    return `${dn}, ${String(dt.getUTCDate()).padStart(2, "0")} ${MON[dt.getUTCMonth()]}`;
  };
  const perRows = (d.periods || []).slice().reverse().map((p) => `
    <tr><td>${fmtLabel(p.label)}</td><td class="num">${p.days}</td><td class="num"><b>${fmt(p.avgDailyRangePct)}%</b></td><td class="num">${p.peakSlot}</td><td class="num wl-sub">${fmt(p.peakSlotRangePct)}%</td></tr>`).join("");
  box.innerHTML = `
    <div class="hourly-summary" style="margin-bottom:10px"><b>${d.name} (${d.symbol})</b> · ${d.summary}</div>
    <h3 class="sw-plan-title">By day of week (which day moves most)</h3>
    <table class="alerts-table sw-plan" style="margin-bottom:14px"><thead><tr><th>Day</th><th>Activity</th><th>Avg daily range</th><th>Samples</th></tr></thead><tbody>${wdRows}</tbody></table>
    <h3 class="sw-plan-title">Intraday move profile (avg per 15m slot)</h3>
    <table class="alerts-table sw-plan" style="margin-bottom:14px"><thead><tr><th>Time (IST)</th><th>Activity</th><th>Avg range/bar</th><th>Avg body</th></tr></thead><tbody>${profRows}</tbody></table>
    <h3 class="sw-plan-title">${d.period === "weekly" ? "Weekly" : "Monthly"} trend (how it changes)</h3>
    <table class="alerts-table sw-plan"><thead><tr><th>${d.period === "weekly" ? "Week of" : "Month"}</th><th>Days</th><th>Avg daily range</th><th>Peak window</th><th>Peak range</th></tr></thead><tbody>${perRows}</tbody></table>
    <p class="opt-disclaimer">${d.disclaimer || ""}</p>`;
}

// ---------- Day Test (manual single-day replay) ----------
function initDayTest() {
  // Populate the symbol dropdown from the watchlist (indices + stocks) and
  // default the date to the most recent weekday.
  const sel = el("day-symbol");
  if (sel && !sel.options.length) {
    const syms = (state.symbols || []);
    sel.innerHTML = syms.map((s) => `<option value="${s.symbol}">${s.name} (${s.symbol})</option>`).join("");
  }
  const d = el("day-date");
  if (d && !d.value) {
    const now = new Date(Date.now() + 19800000);
    now.setUTCDate(now.getUTCDate() - 1); // yesterday IST as a sensible default
    d.value = now.toISOString().slice(0, 10);
  }
}

async function runDayTest() {
  const box = el("daytest");
  const btn = el("day-apply");
  if (!box) return;
  const date = el("day-date") ? el("day-date").value : "";
  const symbol = el("day-symbol") ? el("day-symbol").value : "";
  const mode = el("day-mode") ? el("day-mode").value : "option";
  if (!date || !symbol) { box.textContent = "Pick a date and a symbol first."; return; }
  if (btn) { btn.disabled = true; btn.textContent = "Applying..."; }
  box.textContent = `Replaying ${symbol} on ${date} and scanning the day's best movers...`;
  try {
    const data = await fetch(`/api/replay?date=${encodeURIComponent(date)}&symbol=${encodeURIComponent(symbol)}&mode=${encodeURIComponent(mode)}`).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderDayTest(data);
  } catch (e) {
    box.textContent = "Day test failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Apply"; }
  }
  loadDaySr(date, symbol);
}

// ---------- Day S/R (hourly break + estimated option move) ----------
async function loadDaySr(date, symbol) {
  const box = el("daytest-sr");
  if (!box) return;
  box.textContent = "Computing hourly support/resistance breaks and estimated option moves...";
  try {
    const d = await fetch(`/api/day-sr?date=${encodeURIComponent(date)}&symbol=${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (d.error) { box.textContent = d.error; return; }
    renderDaySr(d);
  } catch (e) {
    box.textContent = "Day S/R failed: " + e.message;
  }
}

function renderDaySr(d) {
  const box = el("daytest-sr");
  const L = d.levels || {};
  const s = d.summary || {};
  const levelPills = `
    <span class="risk-pill down">S2 ${fmt(L.s2)}</span>
    <span class="risk-pill down">S1 ${fmt(L.s1)}</span>
    <span class="risk-pill">PDL ${fmt(L.pdl)}</span>
    <span class="risk-pill">PP ${fmt(L.pp)}</span>
    <span class="risk-pill">PDH ${fmt(L.pdh)}</span>
    <span class="risk-pill up">R1 ${fmt(L.r1)}</span>
    <span class="risk-pill up">R2 ${fmt(L.r2)}</span>`;
  const rows = (d.hours || []).map((h) => {
    const dirCls = h.netDir === "Up" ? "up" : h.netDir === "Down" ? "down" : "wl-sub";
    const brk = h.netDir === "Flat"
      ? '<span class="wl-sub">held (no break)</span>'
      : `${h.netDir === "Up" ? "▲ " + (h.resLevel || "") : "▼ " + (h.supLevel || "")} ${fmt(h.netDir === "Up" ? h.resValue : h.supValue)}`;
    const optCls = h.estOptType === "CE" ? "up" : h.estOptType === "PE" ? "down" : "wl-sub";
    return `
    <tr>
      <td><b>${h.hour}</b></td>
      <td class="${dirCls}">${brk}</td>
      <td class="num ${dirCls}">${h.brokeAt ? h.brokeAt + " &rarr; " + (h.moveEndAt || "?") : "-"}</td>
      <td class="num ${dirCls}">${h.heldMin > 0 ? h.heldMin + "m" : "-"}</td>
      <td class="num ${dirCls}">${h.breakPts > 0 ? fmt(h.breakPts) + " pts" : "-"}</td>
      <td class="num ${dirCls}">${h.reached != null ? fmt(h.reached) : "-"}</td>
      <td class="${optCls}">${h.estOptType || "-"}</td>
      <td class="num ${optCls}">${h.estPremMovePct > 0 ? "~+" + fmt(h.estPremMovePct) + "%" : "-"}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `
    <div class="hourly-summary" style="margin-bottom:8px">
      <b>${d.name} · ${d.date} (${d.weekday})</b> — broke resistance in <b class="up">${s.hoursBrokeResistance}</b> hour(s), support in <b class="down">${s.hoursBrokeSupport}</b>.
      Biggest break: <b>${s.biggestBreakHour || "-"}</b> ${s.biggestBreakDir ? (s.biggestBreakDir === "Up" ? "▲" : "▼") : ""} ${fmt(s.biggestBreakPts)} pts (${fmt(s.biggestBreakPct)}%).
      Biggest est. option move: <b>~+${fmt(s.biggestEstPremMovePct)}%</b> at ${s.biggestEstPremMoveHour || "-"}. Day range ${fmt(s.dayRangePts)} pts (${fmt(s.dayRangePct)}%).
    </div>
    <div class="ophl-levels" style="margin-bottom:8px">${levelPills}</div>
    <div class="wl-sub" style="margin-bottom:4px">ATR ${fmt(d.atrDaily)} · ATM premium proxy ~₹${fmt(d.atmPremProxy)} (used for the % estimate)</div>
    <table class="alerts-table sw-plan"><thead><tr><th>Hour</th><th>Break of</th><th>Move (start&rarr;end)</th><th>Held</th><th>Move pts</th><th>Moved to</th><th>Opt</th><th>Est. %</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="opt-disclaimer">${d.disclaimer || ""}</p>`;
}

function renderDayTest(d) {
  const box = el("daytest");
  const sc = d.systemCall || {};
  const cm = d.chosenMover || {};
  const resClass = sc.result === "WIN" ? "up" : sc.result === "LOSS" ? "down" : "";
  const callHtml = sc.hasSignal
    ? `<div class="predict-range">
         <div class="metric"><span>Call</span><b class="${sc.direction === "Bullish" ? "up" : "down"}">${sc.direction} (${d.mode})</b></div>
         <div class="metric"><span>Entry</span><b>${fmt(sc.entry)} @ ${sc.entryTime}</b></div>
         <div class="metric"><span>Target / Stop</span><b>${fmt(sc.target)} / ${fmt(sc.stop)}</b></div>
         <div class="metric"><span>Result</span><b class="${resClass}">${sc.result}${sc.exitTime && sc.result !== "FLAT" ? " @ " + sc.exitTime : ""}</b></div>
         <div class="metric"><span>Captured</span><b class="${sc.capturedPct >= 0 ? "up" : "down"}">${sc.capturedPct >= 0 ? "+" : ""}${fmt(sc.capturedPct)}%</b></div>
         <div class="metric"><span>Signal score</span><b>${sc.score}</b></div>
       </div>`
    : `<div class="wl-sub" style="padding:6px 0">⛔ ${sc.note}</div>`;

  const lb = (d.leaderboard || []).map((m, i) => `
    <tr data-sym="${m.symbol}" class="${m.symbol === d.symbol ? "mb-row" : ""}">
      <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
      <td><div class="a-name">${m.name}</div><div class="wl-sub">${m.symbol}${m.isIndex ? " · index" : ""}</div></td>
      <td>${m.bestDir === "Up" ? '<span class="risk-pill up">▲ Up</span>' : '<span class="risk-pill down">▼ Down</span>'}</td>
      <td class="num ${m.bestDir === "Up" ? "up" : "down"}"><b>${fmt(m.bestMovePct)}%</b></td>
      <td class="num wl-sub">${m.bestMoveTime || "-"}</td>
      <td class="num ${m.closePct >= 0 ? "up" : "down"}">${m.closePct >= 0 ? "+" : ""}${fmt(m.closePct)}%</td>
    </tr>`).join("");

  box.innerHTML = `
    <div class="${d.missed ? "block-banner" : "hourly-summary"}" style="margin-bottom:10px">
      ${d.missed ? "⚠ " : "✓ "}<b>${d.verdict}</b>
    </div>
    <div class="predict-idx-grid">
      <div class="predict-idx">
        <div class="predict-idx-head"><div class="predict-idx-name">System's decision — ${d.name} on ${d.date}</div></div>
        ${callHtml}
      </div>
      <div class="predict-idx">
        <div class="predict-idx-head"><div class="predict-idx-name">${d.name} actual that day</div></div>
        <div class="predict-range">
          <div class="metric"><span>Open</span><b>${fmt(cm.open)}</b></div>
          <div class="metric"><span>High / Low</span><b>${fmt(cm.high)} / ${fmt(cm.low)}</b></div>
          <div class="metric"><span>Best move</span><b class="${cm.bestDir === "Up" ? "up" : "down"}">${cm.bestDir} ${fmt(cm.bestMovePct)}%</b></div>
          <div class="metric"><span>Open→Close</span><b class="${cm.closePct >= 0 ? "up" : "down"}">${cm.closePct >= 0 ? "+" : ""}${fmt(cm.closePct)}%</b></div>
          <div class="metric"><span>Mover rank</span><b>${d.chosenRank ? "#" + d.chosenRank : "-"}</b></div>
        </div>
      </div>
    </div>
    <h3 class="sw-plan-title">That day's best ${cm.isIndex ? "index" : "stock"} movers (the answer key)</h3>
    <table class="alerts-table sw-plan"><thead><tr><th>#</th><th>${cm.isIndex ? "Index" : "Stock"}</th><th>Best dir</th><th>Best intraday move</th><th>Move by</th><th>Open→Close</th></tr></thead><tbody>${lb}</tbody></table>
    <p class="opt-disclaimer">${d.disclaimer || ""}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "15m")));
}

// ---------- ORB (opening range breakout) ----------
async function loadOrb() {
  const box = el("orb");
  const btn = el("load-orb");
  if (!box) return;
  const mins = el("orb-min") ? el("orb-min").value : "30";
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Scanning opening-range breakouts...";
  try {
    const data = await fetch("/api/orb?minutes=" + encodeURIComponent(mins)).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    state.orbData = data;
    const st = el("orb-status");
    if (st) {
      const when = new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      st.innerHTML = `${data.marketOpen ? '<span class="live-dot"></span> LIVE' : "market closed — last session"} · ${data.orMinutes}m range${data.session ? " · " + data.session : ""} · updated ${when}`;
    }
    applyOrbFilter();
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}

function applyOrbFilter() {
  const data = state.orbData;
  if (!data) return;
  const only = el("orb-state") && el("orb-state").value === "break";
  let picks = (data.picks || []).filter((p) => (only ? p.state === "Long" || p.state === "Short" : true));
  const box = el("orb");
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No ${only ? "breakouts" : "signals"} right now.</div>`; return; }
  const statePill = (s) => s === "Long" ? '<span class="risk-pill up">▲ Long / CE</span>' : s === "Short" ? '<span class="risk-pill down">▼ Short / PE</span>' : s === "Inside" ? '<span class="risk-pill">◦ Inside</span>' : '<span class="wl-sub">forming</span>';
  const rows = picks.map((p) => {
    const vc = p.volConfirm === null ? '<span class="wl-sub">n/a</span>' : p.volConfirm ? '<span class="up">yes</span>' : '<span class="down">no</span>';
    return `<tr data-sym="${p.symbol}">
      <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol}${p.isIndex ? " · index" : ""} · ₹${fmt(p.price)}</div></td>
      <td>${statePill(p.state)}</td>
      <td class="num">${fmt(p.rangeLow)}–${fmt(p.rangeHigh)}<div class="wl-sub">${fmt(p.rangeWidthPct)}% wide</div></td>
      <td class="num">${p.entry != null ? fmt(p.entry) : "-"}</td>
      <td class="num">${p.stop != null ? fmt(p.stop) : "-"}</td>
      <td class="num">${p.target1 != null ? fmt(p.target1) : "-"}${p.target2 != null ? " / " + fmt(p.target2) : ""}</td>
      <td class="num">${p.rr != null ? p.rr + ":1" : "-"}</td>
      <td class="num">${vc}</td>
      <td class="num"><b>${p.confidence}</b></td>
    </tr>
    <tr class="remark-row"><td></td><td colspan="8" class="wl-sub" style="padding-top:0">${p.note}</td></tr>`;
  }).join("");
  box.innerHTML = `
    <table class="alerts-table sw-plan"><thead><tr>
      <th>Symbol</th><th>State</th><th>Opening range</th><th>Entry</th><th>Stop</th><th>Target 1 / 2</th><th>R:R</th><th>Vol ok</th><th>Conf</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="opt-disclaimer">${data.disclaimer || ""}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
}

// ---------- option selling (premium/theta) ----------
async function loadOptionSell() {
  const box = el("optionsell");
  const btn = el("load-optionsell");
  if (!box) return;
  if (btn) { btn.disabled = true; btn.textContent = "Building..."; }
  box.textContent = "Building selling structures from the live option chain...";
  try {
    const data = await fetch("/api/option-sell").then((r) => r.json());
    if (data.available === false) { box.innerHTML = `<div class="wl-sub">${data.message}</div>`; return; }
    renderOptionSell(data);
  } catch (e) {
    box.textContent = "Failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
  loadOptionSellPaper();
}

function renderOptionSell(data) {
  const box = el("optionsell");
  const list = data.strategies || [];
  if (!list.length) { box.innerHTML = `<div class="wl-sub">No structures could be built (chain may be thin right now).</div>`; return; }
  const cards = list.map((s) => {
    const legs = s.legs.map((l) => `${l.action === "SELL" ? "🔴 Sell" : "🟢 Buy"} ${l.strike} ${l.optionType} @ ${fmt(l.premium)}`).join(" · ");
    const maxLoss = s.maxLoss == null ? '<span class="down">undefined (naked)</span>' : rupee(s.maxLoss);
    const rec = s.recommended ? ' <span class="risk-pill up">Recommended</span>' : "";
    const hp = s.highProb ? ' <span class="risk-pill up">High-prob sell</span>' : ' <span class="risk-pill">Skip</span>';
    return `<div class="predict-idx" style="margin-bottom:8px">
      <div class="predict-idx-head">
        <div class="predict-idx-name">${s.type} · ${s.name}${rec}${hp} <span class="wl-sub">exp ${s.expiry || "-"}</span></div>
        <button class="ghost btn-sm sell-start" data-sym="${s.symbol}" data-type="${s.type}">Paper trade this</button>
      </div>
      <div class="wl-sub" style="margin:4px 0">${legs}</div>
      <div class="predict-range">
        <div class="metric"><span>Net credit</span><b class="up">${rupee(s.netCreditValue)}</b></div>
        <div class="metric"><span>Max profit</span><b class="up">${rupee(s.maxProfit)}</b></div>
        <div class="metric"><span>Max loss</span><b>${maxLoss}</b></div>
        <div class="metric"><span>Breakevens</span><b>${fmt(s.breakevenLow)} – ${fmt(s.breakevenHigh)}</b></div>
        <div class="metric"><span>POP</span><b>${s.pop}%</b></div>
        <div class="metric"><span>Margin ~</span><b>${rupee(s.marginEstimate)}</b></div>
        <div class="metric"><span>Net delta</span><b>${fmt(s.netDelta)}</b></div>
        <div class="metric"><span>Theta/day</span><b class="up">+${rupee(s.netThetaPerDay)}</b></div>
        <div class="metric"><span>Target (50%)</span><b class="up">+${rupee(s.profitTarget)}</b></div>
        <div class="metric"><span>Tail stop</span><b class="down">-${rupee(s.stopLoss)}</b></div>
      </div>
      <div class="wl-sub" style="margin-top:4px">${s.algoNote || ""} ${s.note} <br>${s.adjustNote}</div>
    </div>`;
  }).join("");
  box.innerHTML = cards + `<p class="opt-disclaimer">${data.disclaimer || ""}</p>`;
  box.querySelectorAll(".sell-start").forEach((b) => b.addEventListener("click", () => startOptionSell(b.getAttribute("data-sym"), b.getAttribute("data-type"))));
}

async function startOptionSell(symbol, type) {
  const cap = prompt("Paper capital for this sell trade (Rs):", "200000");
  if (cap == null) return;
  try {
    await fetch(`/api/option-sell/start?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}&capital=${encodeURIComponent(cap)}`).then((r) => r.json());
    loadOptionSellPaper();
  } catch (e) { alert("Failed to start: " + e.message); }
}
async function stopOptionSell() { await fetch("/api/option-sell/stop").then((r) => r.json()); loadOptionSellPaper(); }
async function resetOptionSell() { if (!confirm("Reset the option-selling paper run?")) return; await fetch("/api/option-sell/reset").then((r) => r.json()); loadOptionSellPaper(); }

async function loadOptionSellPaper() {
  try {
    const s = await fetch("/api/option-sell/state").then((r) => r.json());
    renderOptionSellPaper(s);
  } catch (_) { /* ignore */ }
}

function renderOptionSellPaper(s) {
  const box = el("optionsell-paper");
  if (!box) return;
  if (!s || (!s.open?.length && !s.closed?.length && !s.active)) {
    box.innerHTML = `<span class="wl-sub">No option-selling paper run yet. Pick a structure above and "Paper trade this".</span>`;
    return;
  }
  const openRows = (s.open || []).map((p) => {
    const pnl = p.lastPnl ?? 0;
    return `<tr><td>${p.type}</td><td>${p.symbol}</td><td class="wl-sub">${p.legs.map((l) => (l.action === "SELL" ? "-" : "+") + l.strike + l.optionType).join(" ")}</td>
      <td class="num">${rupee(p.netCreditValue)}</td>
      <td class="num">${p.lastUnderlying != null ? fmt(p.lastUnderlying) : "-"}</td>
      <td class="num ${pnlCls(pnl)}"><b>${pnl >= 0 ? "+" : ""}${rupee(pnl)}</b></td>
      <td class="num up">+${rupee(p.profitTarget)}</td><td class="num down">-${rupee(p.stopLoss)}</td></tr>`;
  }).join("");
  const closedRows = (s.closed || []).slice().reverse().slice(0, 20).map((t) =>
    `<tr><td>${t.type}</td><td>${t.symbol}</td><td><span class="risk-pill ${t.pnl >= 0 ? "up" : "down"}">${t.exitReason}</span></td>
      <td class="num ${pnlCls(t.pnl)}"><b>${t.pnl >= 0 ? "+" : ""}${rupee(t.pnl)}</b><div class="wl-sub">${fmt(t.pnlPct)}%</div></td>
      <td class="wl-sub">${t.remark || ""}</td></tr>`).join("");
  box.innerHTML = `
    <div class="hourly-summary">
      <b>${s.active ? "🟢 RUNNING" : "⛔ STOPPED"}</b> · start ${rupee(s.startCapital)} · realised <b class="${pnlCls(s.realised)}">${s.realised >= 0 ? "+" : ""}${rupee(s.realised)}</b> ·
      open P&L <b class="${pnlCls(s.openPnl)}">${s.openPnl >= 0 ? "+" : ""}${rupee(s.openPnl)}</b> · equity <b>${rupee(s.equity)}</b> · win rate ${s.winRate}% (${s.wins}W/${s.losses}L)
      · <button class="ghost btn-sm" onclick="stopOptionSell()">Stop</button> <button class="ghost btn-sm" onclick="resetOptionSell()">Reset</button>
    </div>
    ${(s.open || []).length ? `<table class="alerts-table sw-plan"><thead><tr><th>Structure</th><th>Symbol</th><th>Legs</th><th>Credit</th><th>Underlying</th><th>Live P&L</th><th>Target</th><th>Stop</th></tr></thead><tbody>${openRows}</tbody></table>` : ""}
    ${(s.closed || []).length ? `<h4 class="wl-sub" style="margin:8px 0 4px">Closed</h4><table class="alerts-table sw-plan"><thead><tr><th>Structure</th><th>Symbol</th><th>Exit</th><th>P&L</th><th>Why</th></tr></thead><tbody>${closedRows}</tbody></table>` : ""}`;
}

function startOptionSellLive() {
  if (state.optionSellTimer) return;
  state.optionSellTimer = setInterval(async () => {
    const pn = document.getElementById("panel-optionsell");
    if (!pn || !pn.classList.contains("active")) return;
    try {
      if (isMarketOpen()) { const s = await fetch("/api/option-sell/mark").then((r) => r.json()); renderOptionSellPaper(s); }
    } catch (_) { /* ignore */ }
  }, 3000);
}

// ---------- today's big movers (intraday) ----------
async function loadTodayMovers() {
  const box = el("todaymovers");
  const btn = el("load-todaymovers");
  if (!box) return;
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Scanning the market for today's big movers (gap · relative volume · range expansion · momentum)...";
  try {
    const data = await fetch("/api/today-movers").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderTodayMovers(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}

function renderTodayMovers(data) {
  state.todayMoversData = data;
  const st = el("tm-status");
  if (st) {
    const when = new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    st.innerHTML = `${data.marketOpen ? '<span class="live-dot"></span> LIVE' : "market closed — last session"}` +
      `${data.session ? " · session " + data.session : ""} · ${(data.picks || []).length} movers · updated ${when}`;
  }
  renderOpeningHighTop5(data.top5OpeningHigh);
  applyTodayMoverFilters();
}

// Top 5 stocks that OPENED HIGH (gap up) on good volume; F&O (option/OI) first.
function renderOpeningHighTop5(rows) {
  const box = el("tm-openhigh");
  if (!box) return;
  if (!rows || !rows.length) { box.innerHTML = ""; return; }
  const badge = (p) => p.hasOptions === true
    ? '<span class="risk-pill up">F&O · OI</span>'
    : p.hasOptions === false ? '<span class="risk-pill">cash</span>' : '<span class="wl-sub">-</span>';
  const cards = rows.map((p, i) => `
    <div class="ohi-card" data-sym="${p.symbol}">
      <div class="ohi-rank">${i === 0 ? "★" : "#" + (i + 1)}</div>
      <div class="ohi-main">
        <div class="a-name">${p.name} ${badge(p)}</div>
        <div class="wl-sub">${p.symbol} · ₹${fmt(p.price)}</div>
        <div class="ohi-metrics">
          <span>Gap <b class="${p.gapPct >= 0 ? "up" : "down"}">${p.gapPct >= 0 ? "+" : ""}${fmt(p.gapPct, 1)}%</b></span>
          <span>RVOL <b>${fmt(p.rvolDay, 1)}x</b></span>
          <span>Day <b class="${p.changePct >= 0 ? "up" : "down"}">${p.changePct >= 0 ? "+" : ""}${fmt(p.changePct, 1)}%</b></span>
          <span>Near-high <b>${fmt(p.nearHighPct, 0)}%</b></span>
          <span>Score <b>${p.openHighScore}</b></span>
        </div>
      </div>
    </div>`).join("");
  box.innerHTML = `<h3 class="sw-plan-title">🚀 Top 5 Opening-High Movers <span class="wl-sub">(gap-up + volume · F&amp;O/OI first)</span></h3>
    <div class="wl-sub" style="margin:-2px 0 8px">Stocks that opened high with strong volume. F&O names (which carry option OI) are prioritized; cash-only names are shown too, each badged.</div>
    <div class="ohi-grid">${cards}</div>`;
  box.querySelectorAll(".ohi-card[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
}

function applyTodayMoverFilters() {
  const data = state.todayMoversData;
  if (!data) return;
  const dir = el("tm-dir") ? el("tm-dir").value : "";
  const opt = el("tm-options") ? el("tm-options").value : "";
  let picks = (data.picks || []).filter((p) => {
    if (dir && p.direction !== dir) return false;
    if (opt === "yes" && p.hasOptions !== true) return false;
    if (opt === "no" && p.hasOptions === true) return false;
    return true;
  });
  renderTodayMoverRows(data, picks);
}

function renderTodayMoverRows(data, picks) {
  const box = el("todaymovers");
  if (!box) return;
  if (!picks.length) {
    box.innerHTML = `<div class="wl-sub">No big movers right now${data.marketOpen ? "" : " (market closed)"}. Try Refresh during market hours or loosen the filters.</div>`;
    return;
  }
  const dirPill = (d) => d === "Up" ? '<span class="risk-pill up">▲ Up</span>' : d === "Down" ? '<span class="risk-pill down">▼ Down</span>' : '<span class="risk-pill">◆ Mixed</span>';
  const rows = picks.map((p, i) => {
    const chgCls = p.changePct >= 0 ? "up" : "down";
    const opt = p.hasOptions === true ? '<span class="risk-pill up">F&O</span>' : p.hasOptions === false ? '<span class="wl-sub">cash</span>' : "";
    return `<tr data-sym="${p.symbol}">
      <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
      <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ₹${fmt(p.price)} ${opt}</div></td>
      <td>${dirPill(p.direction)}</td>
      <td class="num"><b>${p.moverScore}</b></td>
      <td class="num ${chgCls}">${p.changePct >= 0 ? "+" : ""}${fmt(p.changePct)}%<div class="wl-sub">gap ${p.gapPct >= 0 ? "+" : ""}${fmt(p.gapPct)}%</div></td>
      <td class="num ${p.rvolDay >= 1.5 ? "up" : ""}">${fmt(p.rvolDay)}x<div class="wl-sub">${p.rvolState}</div></td>
      <td class="num">${p.rangeExpansion != null ? fmt(p.rangeExpansion) + "x" : "-"}<div class="wl-sub">~${fmt(p.expectedDayMovePct)}% day</div></td>
      <td class="num">${p.signalLabel}<div class="wl-sub">${p.signalScore} · conf ${p.confidence}%</div></td>
      <td class="num">${fmt(p.entry)}<div class="wl-sub">SL ${fmt(p.stop)} · T ${fmt(p.target)}</div></td>
    </tr>
    <tr class="remark-row"><td></td><td colspan="8" class="wl-sub" style="padding-top:0">${p.note}</td></tr>`;
  }).join("");
  box.innerHTML = `
    <table class="alerts-table sw-plan"><thead><tr>
      <th>#</th><th>Stock</th><th>Bias</th><th>Mover score</th><th>Change today</th><th>Rel. volume</th><th>Range exp.</th><th>15m signal</th><th>Entry / SL / Target</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="opt-disclaimer">${data.disclaimer || ""}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"))));
  state.todayMoversDisplayed = picks;
  const exp = el("tm-export");
  if (exp) exp.onclick = exportTodayMoversCsv;
}

function exportTodayMoversCsv() {
  const picks = (state && state.todayMoversDisplayed) || [];
  if (!picks.length) return;
  const cols = ["symbol", "name", "direction", "moverScore", "price", "prevClose", "gapPct", "changePct", "rvolDay", "intradayRangePct", "rangeExpansion", "expectedDayMovePct", "signalScore", "signalLabel", "confidence", "entry", "stop", "target", "hasOptions"];
  const lines = [cols.join(",")].concat(
    picks.map((p) => cols.map((c) => {
      const v = p[c];
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")),
  );
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "today-big-movers.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- option clean movers (rating) ----------
async function loadCleanMovers() {
  const box = el("cleanmovers");
  const btn = el("load-cleanmovers");
  if (!box) return;
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Rating stocks by clean directional movement (efficiency · ADX · move size · follow-through)...";
  try {
    const data = await fetch("/api/clean-movers").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderCleanMovers(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

function renderCleanMovers(data) {
  state.cleanMoversData = data;
  const st = el("cm-status");
  if (st) {
    const when = new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const aCount = (data.picks || []).filter((p) => p.grade === "A+" || p.grade === "A").length;
    st.textContent = `${(data.picks || []).length} stocks rated · ${aCount} grade A/A+ (cleanest) · updated ${when}`;
  }
  applyCleanMoverFilters();
}

function applyCleanMoverFilters() {
  const data = state.cleanMoversData;
  if (!data) return;
  const g = el("cm-grade") ? el("cm-grade").value : "";
  const bias = el("cm-bias") ? el("cm-bias").value : "";
  const opt = el("cm-options") ? el("cm-options").value : "";
  const gradeRank = { "A+": 5, A: 4, B: 3, C: 2, D: 1 };
  let picks = (data.picks || []).filter((p) => {
    if (g === "A" && gradeRank[p.grade] < 4) return false;
    if (g === "B" && gradeRank[p.grade] < 3) return false;
    if (bias && p.directionBias !== bias) return false;
    if (opt === "yes" && p.hasOptions !== true) return false;
    if (opt === "no" && p.hasOptions === true) return false;
    return true;
  });
  renderCleanMoverRows(data, picks);
}

function renderCleanMoverRows(data, picks) {
  const box = el("cleanmovers");
  if (!box) return;
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }
  const gradeCls = (g) => (g === "A+" || g === "A") ? "up" : g === "D" ? "down" : "";
  const biasPill = (d) => d === "Up" ? '<span class="risk-pill up">▲ Up</span>' : d === "Down" ? '<span class="risk-pill down">▼ Down</span>' : '<span class="risk-pill">◆ Neutral</span>';
  const rows = picks.map((p, i) => {
    const opt = p.hasOptions === true ? '<span class="risk-pill up">F&O</span>' : p.hasOptions === false ? '<span class="wl-sub">cash</span>' : "";
    return `<tr data-sym="${p.symbol}">
      <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
      <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ₹${fmt(p.price)} ${opt}</div></td>
      <td><span class="risk-pill ${gradeCls(p.grade)}">${p.grade}</span></td>
      <td class="num"><b>${p.rating}</b></td>
      <td class="num ${p.efficiencyRatio >= 0.35 ? "up" : ""}">${fmt(p.efficiencyRatio)}</td>
      <td class="num ${p.adx >= 25 ? "up" : ""}">${fmt(p.adx)}</td>
      <td class="num">${fmt(p.atrPct)}%</td>
      <td class="num">${p.trendPersistence}<div class="wl-sub">chop ${fmt(p.choppinessIndex)}</div></td>
      <td class="num ${p.whipsawPerMonth <= 6 ? "up" : p.whipsawPerMonth >= 10 ? "down" : ""}">${fmt(p.whipsawPerMonth)}/mo</td>
      <td>${biasPill(p.directionBias)}</td>
    </tr>
    <tr class="remark-row"><td></td><td colspan="9" class="wl-sub" style="padding-top:0">${p.note}</td></tr>`;
  }).join("");
  box.innerHTML = `
    <table class="alerts-table sw-plan"><thead><tr>
      <th>#</th><th>Stock</th><th>Grade</th><th>Rating</th><th>Efficiency</th><th>ADX</th><th>ATR%/day</th><th>Follow-through</th><th>Whipsaw</th><th>Bias</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="opt-disclaimer">${data.disclaimer || ""}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  state.cleanMoversDisplayed = picks;
  const exp = el("cm-export");
  if (exp) exp.onclick = exportCleanMoversCsv;
}

function exportCleanMoversCsv() {
  const picks = (state && state.cleanMoversDisplayed) || [];
  if (!picks.length) return;
  const cols = ["symbol", "name", "grade", "rating", "efficiencyRatio", "adx", "atrPct", "avgAbsMovePct", "trendPersistence", "choppinessIndex", "whipsawPerMonth", "directionBias", "price", "hasOptions"];
  const lines = [cols.join(",")].concat(
    picks.map((p) => cols.map((c) => {
      const v = p[c];
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")),
  );
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "option-clean-movers.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- big move radar 20-100% (high risk) ----------
async function loadBigMove() {
  const box = el("bigmove");
  const btn = el("load-bigmove");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  box.textContent = "Radaring stocks for coiled bases / breakouts set up for a big run...";
  try {
    const data = await fetch("/api/big-move").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderBigMove(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
  }
}

function renderBigMove(data) {
  state.bigmoveData = data;
  const sectors = [...new Set((data.picks || []).map((p) => p.sector).filter(Boolean))].sort();
  const sel = el("bm-sector");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' + sectors.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.value = current;
  applyBigMoveFilters();
}

function bmStageClass(st) {
  if (st === "Breaking out") return "up";
  if (st === "Coiled base") return "squeeze";
  if (st === "Extended") return "down";
  if (st === "Weak") return "down";
  return "neutral";
}
function bmShortStage(st) {
  return st === "Breaking out" ? "Breakout" : st === "Coiled base" ? "Coiled" : st === "Extended" ? "Ext" : st === "Weak" ? "Weak" : "—";
}

function applyBigMoveFilters() {
  const data = state.bigmoveData;
  if (!data) return;
  const sortKey = el("bm-sort").value;
  const stage = el("bm-stage").value;
  const sector = el("bm-sector").value;
  const opt = el("bm-options").value;
  let picks = (data.picks || []).filter((p) => {
    if (stage && p.stage !== stage) return false;
    if (sector && p.sector !== sector) return false;
    if (opt === "yes" && p.hasOptions !== true) return false;
    if (opt === "no" && p.hasOptions !== false) return false;
    return true;
  });
  const hzOf = (p, k) => (p.horizons || []).find((h) => h.key === k) || {};
  const val = (p) => {
    switch (sortKey) {
      case "breakout": return -(p.breakoutDistPct ?? 999); // nearest to breakout first (0 or below = best)
      case "pot1w": return hzOf(p, "1w").potentialPct ?? 0;
      case "pot15d": return hzOf(p, "15d").potentialPct ?? 0;
      case "pot30d": return hzOf(p, "30d").potentialPct ?? 0;
      case "readiness": return p.readinessScore ?? 0;
      case "prob50": return p.prob50 ?? 0;
      case "prob100": return p.prob100 ?? 0;
      case "base50": return p.baseRate50 ?? 0;
      case "contraction": return -(p.contractionRatio ?? 9); // tighter (lower) first
      default: return p.moveRank ?? 0; // "rank" = breakout + potential + readiness
    }
  };
  picks = picks.slice().sort((a, b) => val(b) - val(a));
  renderBigMoveRows(data, picks);
}

function bmBucket(score) {
  return score >= 65 ? 5 : score >= 50 ? 4 : score >= 38 ? 3 : score >= 28 ? 2 : 1;
}

function renderBigMoveRows(data, picks) {
  const box = el("bigmove");
  if (!picks.length) { box.innerHTML = `<div class="wl-sub">No stocks match the filters. Loosen them or Scan again.</div>`; return; }
  const hzOf = (p, k) => (p.horizons || []).find((h) => h.key === k) || null;
  const boClass = (s) => (s === "Broke out" ? "up" : s === "Near breakout" ? "up" : s === "Building" ? "" : "");
  const boText = (p) => {
    if (p.breakoutDistPct == null) return "-";
    if (p.breakoutDistPct <= 0) return `above last high ${fmt(p.lastHigh)}`;
    return `${fmt(p.breakoutDistPct)}% to ${fmt(p.lastHigh)}`;
  };
  const hzCell = (p, k) => {
    const h = hzOf(p, k);
    if (!h) return '<td class="num">-</td>';
    return `<td class="num"><b class="up">~${fmt(h.potentialPct)}%</b><div class="wl-sub">${fmt(h.hit20)}/${fmt(h.hit50)}/${fmt(h.hit100)}%</div></td>`;
  };
  const tiles = picks
    .map((p) => {
      const b = bmBucket(p.moveRank ?? p.readinessScore);
      const ext = p.stage === "Extended" ? " hm-ext" : "";
      const boRing = p.breakoutStatus === "Broke out" || p.breakoutStatus === "Near breakout" ? " hm-mb-ring" : "";
      const h30 = hzOf(p, "30d");
      const title = `${p.name} (${p.symbol}) · ${p.stage} · ${p.breakoutStatus} (${boText(p)}) · rank ${p.moveRank} · 30d potential ~${h30 ? h30.potentialPct : "-"}% · ₹${fmt(p.price)}`;
      return `<div class="hm-tile hm-${b}${ext}${boRing}" data-sym="${p.symbol}" title="${title}">
        <div class="hm-name">${p.name}</div>
        <div class="hm-price">₹${fmt(p.price)}</div>
        <div class="hm-score">${p.moveRank ?? p.readinessScore}</div>
        <div class="hm-sub">${p.breakoutStatus === "Broke out" ? "🚀 broke out" : p.breakoutStatus === "Near breakout" ? "⚡ near breakout" : bmShortStage(p.stage)}${h30 ? " · 30d ~" + fmt(h30.potentialPct) + "%" : ""}</div>
      </div>`;
    })
    .join("");
  const rows = picks
    .map((p, i) => {
      const opt = p.hasOptions === true ? '<span class="risk-pill up">F&amp;O ✓</span>' : p.hasOptions === false ? '<span class="risk-pill">Cash only</span>' : '<span class="risk-pill">?</span>';
      const stg = bmStageClass(p.stage);
      return `<tr data-sym="${p.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol}${p.sector ? " · " + p.sector : ""} · ₹${fmt(p.price)}</div></td>
        <td><span class="risk-pill sc-${stg}">${bmShortStage(p.stage)}</span></td>
        <td><span class="risk-pill ${boClass(p.breakoutStatus)}">${p.breakoutStatus || "-"}</span><div class="wl-sub">${boText(p)}</div></td>
        ${hzCell(p, "1w")}
        ${hzCell(p, "15d")}
        ${hzCell(p, "30d")}
        <td class="num"><b>${p.moveRank ?? "-"}</b><div class="wl-sub">ready ${p.readinessScore}</div></td>
        <td class="num down">${fmt(p.stop)}<div class="wl-sub">-${fmt(p.stopPct)}%</div></td>
        <td>${opt}</td>
      </tr>`;
    })
    .join("");
  box.innerHTML = `
    <div class="hm-legend">
      <span class="hm-key hm-5">Top rank</span>
      <span class="hm-key hm-4">Strong</span>
      <span class="hm-key hm-3">Watch</span>
      <span class="hm-key hm-2">Early</span>
      <span class="hm-key hm-1">Weak</span>
      <span class="hm-legend-note">🚀/⚡ ring = broke out / near breakout · big number = move rank · each horizon shows ~potential% and the 20/50/100% hit-rate · click for full analysis</span>
    </div>
    <div class="heatmap">${tiles}</div>
    <div class="sw-plan-head">
      <h3 class="sw-plan-title">Big-move setups &mdash; ordered by rank (breakout + potential + readiness)</h3>
      <button id="bm-export" class="btn-sm">⭳ Export CSV</button>
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th></th><th>Stock</th><th>Stage</th><th>Breakout</th><th>1 Week</th><th>15 Days</th><th>30 Days</th><th>Rank</th><th>Stop</th><th>Options</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">Ordered by <b>Move rank</b> = breakout proximity + short-term potential + readiness. Each horizon (1 week / 15 days / 30 days) shows the <b>~potential move %</b> (volatility-scaled) and, below it, how often this stock historically reached <b>+20 / +50 / +100%</b> within that window. "Breakout" = breaking / nearing its recent (60-day) high. These are HIGH-RISK positional bets — most stocks do NOT hit +100% in weeks; honor the stop, size small. ${data.disclaimer}</p>`;
  box.querySelectorAll(".hm-tile").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  box.querySelectorAll(".sw-plan tbody tr").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "1d")));
  state.bigmoveDisplayed = picks;
  const exp = el("bm-export");
  if (exp) exp.addEventListener("click", exportBigMoveCsv);
}

function exportBigMoveCsv() {
  const picks = (state && state.bigmoveDisplayed) || [];
  if (!picks.length) return;
  const cols = [
    ["rank", (p, i) => i + 1],
    ["moveRank", (p) => p.moveRank ?? ""],
    ["name", (p) => p.name], ["symbol", (p) => p.symbol], ["sector", (p) => p.sector || ""],
    ["price", (p) => p.price], ["stage", (p) => p.stage],
    ["breakoutStatus", (p) => p.breakoutStatus || ""], ["lastHigh", (p) => p.lastHigh ?? ""], ["breakoutDistPct", (p) => p.breakoutDistPct ?? ""],
    ["pot_1w_pct", (p) => (p.horizons || []).find((h) => h.key === "1w")?.potentialPct ?? ""],
    ["hit_1w_20/50/100", (p) => { const h = (p.horizons || []).find((x) => x.key === "1w"); return h ? `${h.hit20}/${h.hit50}/${h.hit100}` : ""; }],
    ["pot_15d_pct", (p) => (p.horizons || []).find((h) => h.key === "15d")?.potentialPct ?? ""],
    ["hit_15d_20/50/100", (p) => { const h = (p.horizons || []).find((x) => x.key === "15d"); return h ? `${h.hit20}/${h.hit50}/${h.hit100}` : ""; }],
    ["pot_30d_pct", (p) => (p.horizons || []).find((h) => h.key === "30d")?.potentialPct ?? ""],
    ["hit_30d_20/50/100", (p) => { const h = (p.horizons || []).find((x) => x.key === "30d"); return h ? `${h.hit20}/${h.hit50}/${h.hit100}` : ""; }],
    ["readinessScore", (p) => p.readinessScore],
    ["prob20", (p) => p.prob20], ["prob50", (p) => p.prob50], ["prob100", (p) => p.prob100],
    ["baseRate20", (p) => p.baseRate20], ["baseRate50", (p) => p.baseRate50], ["baseRate100", (p) => p.baseRate100],
    ["contractionRatio", (p) => p.contractionRatio], ["volDryup", (p) => p.volDryup],
    ["distFrom52wHighPct", (p) => p.distFrom52wHighPct], ["aboveEma200", (p) => (p.aboveEma200 ? "yes" : "no")],
    ["breakoutLevel", (p) => p.breakoutLevel], ["entry", (p) => p.entry], ["stop", (p) => p.stop], ["stopPct", (p) => p.stopPct],
    ["target20", (p) => p.target20], ["target50", (p) => p.target50], ["target100", (p) => p.target100],
    ["rsi", (p) => (p.rsi == null ? "" : p.rsi)],
    ["options", (p) => (p.hasOptions === true ? "F&O" : p.hasOptions === false ? "Cash only" : "unknown")],
    ["note", (p) => (p.note || "").replace(/\s+/g, " ")],
  ];
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.map((c) => c[0]).join(","), ...picks.map((p, i) => cols.map((c) => esc(c[1](p, i))).join(","))].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `big-move-radar-${stamp}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- hourly 15-min model (record + evening backtest) ----------
async function loadHourlyToday() {
  const box = el("hourly");
  box.textContent = "Loading today's recorded picks...";
  try {
    const data = await fetch("/api/hourly/today").then((r) => r.json());
    renderHourly(data.picks || [], null);
  } catch (e) {
    box.textContent = "Failed to load: " + e.message;
  }
}

async function runHourlySnapshot() {
  const btn = el("hourly-run");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  el("hourly").textContent = "Running the 15-min model across F&O stocks (volume + profit% + low decay)...";
  try {
    const r = await fetch("/api/hourly/run").then((r) => r.json());
    if (r && r.marketOpen === false) {
      el("hourly").innerHTML = `<div class="hc-empty" style="text-align:center">🔕 <b>Market is closed.</b><br>${r.message || ""}<br><span class="wl-sub">Snapshots are recorded automatically every hour (9:30 AM - 3:30 PM IST) on trading days.</span></div>`;
      return;
    }
    await loadHourlyToday();
  } catch (e) {
    el("hourly").textContent = "Snapshot failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Run snapshot now"; }
  }
}

async function resolveHourly() {
  const btn = el("hourly-resolve");
  if (btn) { btn.disabled = true; btn.textContent = "Resolving..."; }
  try {
    const data = await fetch("/api/hourly/resolve").then((r) => r.json());
    renderHourly(data.picks || [], data.summary || null);
  } catch (e) {
    el("hourly").textContent = "Resolve failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Resolve & win-rate"; }
  }
}

function resultPill(r) {
  if (r === "WIN") return '<span class="risk-pill up">WIN</span>';
  if (r === "LOSS") return '<span class="risk-pill down">LOSS</span>';
  if (r === "OPEN") return '<span class="risk-pill">OPEN</span>';
  if (r === "NODATA") return '<span class="risk-pill">—</span>';
  return "";
}

function renderHourly(picks, summary) {
  const box = el("hourly");
  const sumBox = el("hourly-summary");
  if (summary) {
    const wr = summary.winRate;
    const cls = wr >= 60 ? "up" : wr >= 45 ? "" : "down";
    sumBox.innerHTML = `<div class="hourly-summary">
      <b>Win rate: <span class="${cls}">${wr}%</span></b> · ${summary.wins}W / ${summary.losses}L · ${summary.open} open · ${summary.total} total picks
      <span class="wl-sub">(resolved on the underlying: did spot reach the target or the stop first, from intraday 5m data)</span>
    </div>`;
  } else {
    sumBox.innerHTML = "";
  }
  if (!picks.length) {
    box.innerHTML = `<div class="wl-sub">No snapshots recorded yet today. The scheduler saves one automatically at 9:30, 10:30 ... 15:30 IST, or hit "Run snapshot now" to record one immediately.</div>`;
    return;
  }
  // Group by slot (latest first).
  const slots = [...new Set(picks.map((p) => p.slot))].sort().reverse();
  const sections = slots
    .map((slot) => {
      const rows = picks
        .filter((p) => p.slot === slot)
        .map((p, i) => {
          const cls = p.direction === "Bullish" ? "up" : "down";
          return `<tr data-sym="${p.symbol}">
            <td class="a-rank">#${i + 1}</td>
            <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ₹${fmt(p.spot)}</div></td>
            <td><b>${p.strike} ${p.optionType}</b> <span class="risk-pill ${cls}">${p.direction}</span></td>
            <td class="num">${fmt(p.relVolume)}x</td>
            <td class="num up">+${fmt(p.expectedPremiumMovePct)}%</td>
            <td class="num">${p.thetaPctPerDay == null ? "-" : fmt(p.thetaPctPerDay) + "%/d"} <span class="wl-sub">${p.decayLevel}</span></td>
            <td class="num">₹${fmt(p.premium)} → ₹${fmt(p.premiumTarget)}</td>
            <td class="num"><b>${p.hourlyScore}</b></td>
            <td>${resultPill(p.result)}${p.hitTime ? ` <span class="wl-sub">${p.hitTime}</span>` : ""}</td>
          </tr>`;
        })
        .join("");
      return `<h3 class="sw-plan-title">Snapshot ${slot} <span class="wl-sub">(${picks.filter((p) => p.slot === slot).length} picks)</span></h3>
        <table class="alerts-table sw-plan">
          <thead><tr><th></th><th>Stock</th><th>Option</th><th>Rel Vol</th><th>Profit%</th><th>Theta</th><th>Premium→Tgt</th><th>Score</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join("");
  box.innerHTML = sections;
  box.querySelectorAll(".sw-plan tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "15m")));
}

// ---------- scalp / momentum burst ----------
function stateClass(state) {
  if (state === "Fired Up" || state === "Expanding Up") return "up";
  if (state === "Fired Down" || state === "Expanding Down") return "down";
  if (state === "Squeeze") return "squeeze";
  if (state === "Quiet") return "quiet";
  return "neutral";
}

async function loadScalp(symbol) {
  const body = el("scalp-body");
  const badge = el("scalp-state");
  try {
    const m = await fetch(`/api/scalp/${encodeURIComponent(symbol)}?interval=${state.interval}`).then((r) => r.json());
    if (m.error) { body.textContent = m.error; return; }
    badge.textContent = m.state + (m.bigMove ? " · BIG MOVE" : "");
    badge.className = "verdict " + (stateClass(m.state) === "up" ? "up" : stateClass(m.state) === "down" ? "down" : "neutral");
    body.innerHTML = `
      <div class="vol-metrics">
        <div class="metric"><span>Burst score</span><b>${m.burstScore}/100</b></div>
        <div class="metric"><span>Direction</span><b class="${m.direction === 'up' ? 'up' : m.direction === 'down' ? 'down' : ''}">${m.direction}</b></div>
        <div class="metric"><span>Squeeze</span><b>${m.squeezeOn ? 'ON (coiling)' : 'off'}</b></div>
        <div class="metric"><span>ATR expansion</span><b class="${m.atrExpansion >= 1.4 ? 'up' : ''}">${m.atrExpansion}x</b></div>
        <div class="metric"><span>Volume surge</span><b class="${m.volumeSurge >= 1.5 ? 'up' : ''}">${m.volumeSurge}x</b></div>
        <div class="metric"><span>Movement/bar</span><b>${m.movementPct}%</b></div>
      </div>
      <div class="scalp-meter"><div class="scalp-fill sc-${stateClass(m.state)}" style="width:${m.burstScore}%"></div></div>
      <p class="scalp-note sc-${stateClass(m.state)}">${m.scalpNote}</p>`;
  } catch (e) {
    body.textContent = "Could not load momentum: " + e.message;
  }
}

async function loadScalpScan() {
  const box = el("scalp-scan");
  const btn = el("scan-scalp");
  btn.disabled = true;
  btn.textContent = "Scanning...";
  box.textContent = "Scanning the market for coiling / firing setups...";
  try {
    const data = await fetch(`/api/scalp-scan?interval=${state.interval}`).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderScalpScan(data);
  } catch (e) {
    box.textContent = "Scan failed: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan market";
  }
}

function renderScalpScan(data) {
  const box = el("scalp-scan");
  const scan = data.scan || [];
  if (!scan.length) { box.textContent = "No data."; return; }
  const rows = scan
    .map((m, i) => {
      const cls = stateClass(m.state);
      const arrow = m.direction === "up" ? "▲" : m.direction === "down" ? "▼" : "→";
      return `<tr data-sym="${m.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${m.name}</div><div class="wl-sub">${m.symbol} · ₹${fmt(m.price)}</div></td>
        <td><span class="risk-pill sc-${cls}">${m.state} ${arrow}</span>${m.bigMove ? ' <span class="risk-pill up">BIG MOVE</span>' : ''}</td>
        <td class="num"><b>${m.burstScore}</b></td>
        <td class="num ${m.atrExpansion >= 1.4 ? 'up' : ''}">${m.atrExpansion}x</td>
        <td class="num ${m.volumeSurge >= 1.5 ? 'up' : ''}">${m.volumeSurge}x</td>
      </tr>`;
    })
    .join("");
  box.innerHTML = `
    <table class="alerts-table">
      <thead><tr><th></th><th>Instrument</th><th>State</th><th>Burst</th><th>ATR exp</th><th>Vol surge</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">${data.disclaimer}</p>`;
  box.querySelectorAll("tr[data-sym]").forEach((tr) => tr.addEventListener("click", () => openStock(tr.getAttribute("data-sym"))));
}

// ---------- open interest (OI) ----------
async function loadOi(symbol) {
  const body = el("oi-body");
  const vb = el("oi-verdict");
  vb.textContent = "...";
  vb.className = "verdict neutral";
  try {
    const oi = await fetch(`/api/oi/${encodeURIComponent(symbol)}?interval=${state.interval}`).then((r) => r.json());
    if (oi.error) { body.textContent = oi.error; return; }
    renderOi(oi);
  } catch (e) {
    body.textContent = "Could not load OI: " + e.message;
  }
}

function renderOi(oi) {
  const body = el("oi-body");
  const vb = el("oi-verdict");
  if (!oi.available) {
    vb.textContent = "N/A";
    vb.className = "verdict neutral";
    body.innerHTML = `<div class="opt-neutral">${oi.message || "OI not available."}</div><p class="opt-disclaimer">${oi.disclaimer}</p>`;
    return;
  }
  vb.textContent = oi.verdict.bias;
  vb.className = "verdict " + (oi.verdict.bias === "Bullish" ? "up" : oi.verdict.bias === "Bearish" ? "down" : "neutral");

  const rows = (oi.topStrikes || [])
    .map((s) => {
      const isSup = s.strike === oi.support;
      const isRes = s.strike === oi.resistance;
      const tag = isSup ? `<span class="risk-pill up">SUPPORT</span>` : isRes ? `<span class="risk-pill down">RESIST</span>` : "";
      return `<tr>
        <td><b>${s.strike}</b> ${tag}</td>
        <td class="num">${fmt(s.ceOi, 0)}<div class="wl-sub ${s.ceChg >= 0 ? 'down' : 'up'}">${s.ceChg >= 0 ? '+' : ''}${fmt(s.ceChg, 0)}</div></td>
        <td class="num">${fmt(s.peOi, 0)}<div class="wl-sub ${s.peChg >= 0 ? 'up' : 'down'}">${s.peChg >= 0 ? '+' : ''}${fmt(s.peChg, 0)}</div></td>
      </tr>`;
    })
    .join("");

  // Compact Indian-style number (K / L / Cr) for large open-interest values.
  const oiFmt = (n) => {
    if (n == null || isNaN(n)) return "-";
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
    if (a >= 1e5) return (n / 1e5).toFixed(2) + " L";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + " K";
    return String(Math.round(n));
  };
  const totalOi = (oi.totalCeOi || 0) + (oi.totalPeOi || 0);
  body.innerHTML = `
    <div class="vol-metrics">
      <div class="metric"><span>Spot</span><b>${fmt(oi.underlying)}</b><small>exp ${oi.expiry || '-'}</small></div>
      <div class="metric"><span>PCR</span><b class="${oi.pcrState === 'bullish' ? 'up' : oi.pcrState === 'bearish' ? 'down' : ''}">${oi.pcr ?? '-'}</b><small>${oi.pcrState}</small></div>
      <div class="metric"><span>Support (max PE OI)</span><b class="up">${oi.support ?? '-'}</b></div>
      <div class="metric"><span>Resistance (max CE OI)</span><b class="down">${oi.resistance ?? '-'}</b></div>
      <div class="metric"><span>Max pain</span><b>${oi.maxPain ?? '-'}</b></div>
    </div>
    <div class="vol-metrics" style="margin-top:6px">
      <div class="metric"><span>Open OI · Call (total)</span><b class="down">${oiFmt(oi.totalCeOi)}</b><small>resistance side</small></div>
      <div class="metric"><span>Open OI · Put (total)</span><b class="up">${oiFmt(oi.totalPeOi)}</b><small>support side</small></div>
      <div class="metric"><span>Open OI · Total</span><b>${oiFmt(totalOi)}</b><small>Call + Put</small></div>
      <div class="metric"><span>OI tilt</span><b class="${(oi.totalPeOi || 0) > (oi.totalCeOi || 0) ? 'up' : (oi.totalPeOi || 0) < (oi.totalCeOi || 0) ? 'down' : ''}">${(oi.totalPeOi || 0) > (oi.totalCeOi || 0) ? 'Put-heavy (bullish)' : (oi.totalPeOi || 0) < (oi.totalCeOi || 0) ? 'Call-heavy (bearish)' : 'balanced'}</b><small>more OI = stronger wall</small></div>
    </div>
    <div class="vol-grid">
      <div>
        <h4>Why this read</h4>
        <ul class="vol-reasons">${oi.verdict.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
      </div>
      <div>
        <h4>OI around ATM (CE / PE)</h4>
        <table class="vol-table"><thead><tr><th>Strike</th><th>Call OI</th><th>Put OI</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
    <p class="opt-disclaimer">${oi.disclaimer}</p>`;
}

// ---------- tomorrow's outlook ----------
async function loadNextDay() {
  const box = el("nextday");
  const btn = el("load-nextday");
  btn.disabled = true;
  btn.textContent = "Loading...";
  box.textContent = "Analysing daily trends across the watchlist...";
  try {
    const data = await fetch("/api/next-day").then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderNextDay(data);
  } catch (e) {
    box.textContent = "Could not load outlook: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Load outlook";
  }
}

function renderNextDay(data) {
  const box = el("nextday");
  const picks = data.picks || [];
  if (!picks.length) {
    box.innerHTML = `<div class="wl-sub">No clear daily-trend bias across the watchlist right now.</div>`;
    return;
  }
  const rows = picks
    .map((p, i) => {
      const bull = p.bias === "Bullish";
      const tag = `<span class="opt-tag ${bull ? "ce" : "pe"}">${bull ? "BULLISH" : "BEARISH"}${p.optionType ? " · " + (bull ? "CALL" : "PUT") : ""}</span>`;
      return `<tr data-sym="${p.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${p.name}</div><div class="wl-sub">${p.symbol} · ₹${fmt(p.close)}</div></td>
        <td>${tag}</td>
        <td class="num ${p.changePercent >= 0 ? "up" : "down"}">${p.changePercent >= 0 ? "+" : ""}${fmt(p.changePercent)}%</td>
        <td class="num">${p.confidence}%</td>
        <td class="num">${p.closingStrength}%</td>
        <td class="wl-sub nd-note">${p.note}</td>
      </tr>`;
    })
    .join("");
  box.innerHTML = `
    <table class="alerts-table nd-table">
      <thead><tr><th></th><th>Stock</th><th>Bias</th><th>Today</th><th>Conf</th><th>Close strength</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">${data.disclaimer}</p>`;
  box.querySelectorAll("tr[data-sym]").forEach((tr) => tr.addEventListener("click", () => openStock(tr.getAttribute("data-sym"))));
}

// ---------- live trade alerts ----------
let alertsTimer = null;
let alertsNextAt = 0;

async function loadAlerts() {
  const box = el("alerts");
  if (!box) return; // Live Trade Alerts tab removed
  const btn = el("refresh-alerts");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing..."; }
  try {
    const data = await fetch(`/api/alerts?interval=${state.interval}`).then((r) => r.json());
    if (data.error) { box.textContent = data.error; return; }
    renderAlerts(data);
    // reset the 30-min countdown target
    alertsNextAt = Date.now() + (data.refreshIntervalSec || 1800) * 1000;
  } catch (e) {
    box.textContent = "Could not load alerts: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh now";
  }
}

function renderAlerts(data) {
  const box = el("alerts");
  const alerts = data.alerts || [];
  el("alerts-updated").textContent =
    "updated: " + new Date((data.generatedAt || Date.now() / 1000) * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

  if (!alerts.length) {
    box.innerHTML = `<div class="wl-sub">No actionable setups right now (all signals are neutral). The list refreshes every 30 min.</div>`;
    return;
  }

  // Fire an alert when the #1 pick changes to a new stock (server order = movement).
  const top = alerts[0];
  if (top) {
    if (state.alerts.lastTopPick && state.alerts.lastTopPick !== top.symbol && state.alerts.notify) {
      fireTopPickAlert(top);
    }
    state.alerts.lastTopPick = top.symbol;
  }

  state.alertsData = data;
  renderAlertTable();
}

function renderAlertTable() {
  const data = state.alertsData;
  if (!data) return;
  const box = el("alerts");
  const sortKey = el("al-sort") ? el("al-sort").value : "movement";
  const val = (a) => {
    switch (sortKey) {
      case "success": return a.successRate ?? 0;
      case "gain": return a.potentialGainPct ?? 0;
      case "confidence": return a.confidence ?? 0;
      case "rank": return a.rankScore ?? 0;
      default: return a.movementPct ?? 0;
    }
  };
  const alerts = (data.alerts || []).slice().sort((x, y) => val(y) - val(x));

  const rows = alerts
    .map((a, i) => {
      const bull = a.direction === "bullish";
      const actionTag = a.optionType
        ? `<span class="opt-tag ${bull ? "ce" : "pe"}">${bull ? "CALL" : "PUT"}${a.atmStrike ? " " + a.atmStrike : ""}</span>`
        : `<span class="opt-tag ${bull ? "ce" : "pe"}">${bull ? "LONG" : "SHORT"}</span>`;
      const srCls = a.successRate >= 55 ? "up" : a.successRate >= 45 ? "" : "down";
      const moveCls = a.movementPct >= 1 ? "up" : a.movementPct >= 0.5 ? "" : "down";
      return `<tr class="${i === 0 ? "top-pick" : ""}" data-sym="${a.symbol}">
        <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
        <td><div class="a-name">${a.name}</div><div class="wl-sub">${a.symbol} · ₹${fmt(a.price)}</div></td>
        <td>${actionTag}</td>
        <td class="num a-move"><b class="${moveCls}">${fmt(a.movementPct)}%</b><div class="wl-sub">ATR</div></td>
        <td class="num a-gain up">+${fmt(a.potentialGainPct)}%</td>
        <td class="num"><b class="${srCls}">${fmt(a.successRate, 1)}%</b><div class="wl-sub">${a.tradesTested} trades</div></td>
        <td class="num">${a.confidence}%</td>
        <td class="num">${fmt(a.targetPrice)}</td>
        <td class="num down">${fmt(a.stopPrice)}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `
    <table class="alerts-table">
      <thead><tr>
        <th></th><th>Stock</th><th>Action</th><th>Movement</th><th>Potential gain</th>
        <th>Success rate</th><th>Confidence</th><th>Target</th><th>Stop</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">${data.disclaimer}</p>`;

  box.querySelectorAll("tr[data-sym]").forEach((tr) => {
    tr.addEventListener("click", () => openStock(tr.getAttribute("data-sym")));
  });
}

async function toggleNotify() {
  const btn = el("notify-toggle");
  if (!state.alerts.notify) {
    // Enabling: get permission + prime the audio context (needs a user gesture).
    try {
      if ("Notification" in window && Notification.permission !== "granted") {
        await Notification.requestPermission();
      }
    } catch (_) {}
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !state.alerts.audioCtx) state.alerts.audioCtx = new Ctx();
      if (state.alerts.audioCtx && state.alerts.audioCtx.state === "suspended") state.alerts.audioCtx.resume();
    } catch (_) {}
    state.alerts.notify = true;
    btn.textContent = "Notify: On";
    btn.classList.add("on");
    beep(); // confirmation chirp
    startScalpWatch(); // watch for squeeze fires
  } else {
    state.alerts.notify = false;
    btn.textContent = "Notify: Off";
    btn.classList.remove("on");
    stopScalpWatch();
  }
}

// ---------- Early Moves TAB (visible ranked list of initial-stage signals) ----------
async function loadEarlyMoves() {
  const box = el("earlymoves");
  const btn = el("load-earlymoves");
  if (!box) return;
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  if (!state.earlyMovesData) box.textContent = "Scanning indices & F&O stocks for moves in their INITIAL stage...";
  try {
    const d = await fetch("/api/early-moves").then((r) => r.json());
    state.earlyMovesData = d;
    renderEarlyMoves();
  } catch (e) {
    box.textContent = "Failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
  }
}

function startEarlyMovesTab() {
  if (state.earlyMovesTimer) return;
  state.earlyMovesTimer = setInterval(() => {
    const pn = document.getElementById("panel-earlymoves");
    if (pn && pn.classList.contains("active") && isMarketOpen()) {
      fetch("/api/early-moves").then((r) => r.json()).then((d) => { state.earlyMovesData = d; renderEarlyMoves(); }).catch(() => {});
    }
  }, 5 * 1000); // refresh every 5s (server cache + 30s candle cache gate the actual Dhan load)
}

function renderEarlyMoves() {
  const d = state.earlyMovesData;
  const box = el("earlymoves");
  const st = el("earlymoves-status");
  if (!d || !box) return;
  if (st) {
    const when = d.generatedAt ? new Date(d.generatedAt * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "-";
    st.innerHTML = `<span class="upd-badge">⟳ updated ${when} IST</span> · ${d.marketOpen ? '<span class="up">market open</span>' : "market closed"} · auto 5s`;
  }
  let moves = (d.moves || []).slice();
  const f = el("em-filter") ? el("em-filter").value : "all";
  if (f === "igniting") moves = moves.filter((m) => m.stage === "Igniting");
  else if (f === "index") moves = moves.filter((m) => m.type === "index");
  else if (f === "equity") moves = moves.filter((m) => m.type === "equity");
  else if (f === "ce") moves = moves.filter((m) => m.optionType === "CE");
  else if (f === "pe") moves = moves.filter((m) => m.optionType === "PE");
  if (!moves.length) {
    box.innerHTML = `<div class="wl-sub">Abhi koi early-stage move nahi mila${d.marketOpen ? "" : " (market band hai)"}. Ye tab move ke shuruaat me hi signal deta hai — filter loosen karein ya thodi der baad dekhein.</div>`;
    return;
  }
  const rows = moves.map((m, i) => {
    const bull = m.direction === "up";
    const arrow = bull ? "▲" : "▼";
    const dcls = bull ? "up" : "down";
    const igniting = m.stage === "Igniting";
    const prog = m.progressPct == null ? 0 : m.progressPct;
    const barCls = prog >= 45 ? "mid" : "up";
    return `<tr data-sym="${m.symbol}" class="${igniting ? "em-ignite" : ""}">
      <td class="a-rank">${i === 0 ? "★" : "#" + (i + 1)}</td>
      <td><div class="a-name">${m.name}</div><div class="wl-sub">${m.symbol} · ${m.type === "index" ? "Index" : "Stock"} · ₹${fmt(m.price)}</div></td>
      <td><span class="risk-pill ${igniting ? "down" : "up"}">${igniting ? "🔥 IGNITING" : "⚡ EARLY"}</span><div class="wl-sub">${m.burstState || ""}</div></td>
      <td><b class="${dcls}">${arrow} ${m.optionType}</b></td>
      <td><span class="risk-pill ${bull ? "up" : "down"}">${bull ? "🔼 High के पास" : "🔽 Low के पास"}</span><div class="wl-sub">${m.distToExtremePct != null ? m.distToExtremePct + "% दूर · रेंज " + (m.posInRange == null ? "-" : m.posInRange + "%") : ""}</div></td>
      <td class="num">${m.movedTodayPct == null ? "-" : (m.movedTodayPct >= 0 ? "+" : "") + fmt(m.movedTodayPct, 1) + "%"}<div class="wl-sub">today</div></td>
      <td class="num"><b class="up">${m.potentialPct == null ? "-" : "~" + fmt(m.potentialPct, 1) + "%"}</b><div class="wl-sub">left of ${m.expectedDayMovePct == null ? "?" : fmt(m.expectedDayMovePct, 1) + "%"}</div></td>
      <td style="min-width:90px"><div class="prog-bar"><div class="prog-fill ${barCls}" style="width:${Math.max(3, Math.min(100, prog))}%"></div></div><div class="wl-sub">${fmt(prog, 0)}% used</div></td>
      <td class="num">${m.rvol == null ? "-" : fmt(m.rvol, 1) + "x"}</td>
      <td class="num"><b>${m.earlyScore}</b></td>
      <td class="wl-sub" style="min-width:220px">${m.message || ""}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `
    <div class="hourly-summary" style="margin-bottom:8px">
      ⚡ <b>${moves.length}</b> early-stage move${moves.length > 1 ? "s" : ""} · सिर्फ़ वही जो <b>day High/Low के पास</b> हैं (breakout side) · 🔥 IGNITING = squeeze abhi fire · ⚡ EARLY = young trend · ranked by <b>early score</b>.
    </div>
    <table class="alerts-table sw-plan">
      <thead><tr>
        <th>#</th><th>Stock / Index</th><th>Signal</th><th>Buy</th><th>Breakout</th><th>Moved</th><th>Potential left</th><th>Progress</th><th>Vol</th><th>Score</th><th>Read</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">${d.disclaimer || ""}</p>`;
  box.querySelectorAll("tbody tr[data-sym]").forEach((t) => t.addEventListener("click", () => openStock(t.getAttribute("data-sym"), "5m")));
}

// ---------- Early-Move alert (a move in its INITIAL stage) ----------
function startEarlyMoveAlerts() {
  if (!state.early) state.early = { seen: {}, top: null, timer: null };
  if (state.early.timer) clearInterval(state.early.timer);
  pollEarlyMoves();
  state.early.timer = setInterval(() => { if (isMarketOpen()) pollEarlyMoves(); }, 60 * 1000);
}

async function pollEarlyMoves() {
  const pill = el("early-ind");
  try {
    const d = await fetch("/api/early-moves").then((r) => r.json());
    const moves = (d && d.moves) || [];
    state.early.top = moves[0] || null;
    // Update the header pill with the strongest current early move.
    if (pill) {
      if (!d.marketOpen) { pill.textContent = "⚡ early: market closed"; pill.className = "pill early-ind"; }
      else if (!moves.length) { pill.textContent = "⚡ early: none"; pill.className = "pill early-ind"; }
      else {
        const t = moves[0];
        pill.textContent = `⚡ ${t.name.split(" ")[0]} ${t.direction === "up" ? "▲" : "▼"} ${t.stage} (${moves.length})`;
        pill.className = "pill early-ind " + (t.direction === "up" ? "up" : "down");
      }
    }
    // Fire an alert for each NEW, strong early move (not re-alert within 20 min).
    const now = Date.now();
    for (const m of moves) {
      if (m.earlyScore < 45) continue;
      const key = `${m.symbol}:${m.direction}:${m.stage}`;
      const last = state.early.seen[key] || 0;
      if (now - last > 20 * 60 * 1000) {
        state.early.seen[key] = now;
        if (Object.keys(state.early.seen).length > 1 || last === 0) fireEarlyAlert(m);
      }
    }
  } catch (_) { /* ignore */ }
}

function fireEarlyAlert(m) {
  // Visual toast (always) + flash the pill.
  showEarlyToast(m);
  const pill = el("early-ind");
  if (pill) { pill.classList.add("flash"); setTimeout(() => pill.classList.remove("flash"), 1600); }
  // Sound + OS notification only when the user has enabled Notify.
  if (state.alerts && state.alerts.notify) {
    try { beep(); } catch (_) {}
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(`Early move: ${m.name} ${m.direction === "up" ? "▲ UP" : "▼ DOWN"}`, { body: m.message });
      }
    } catch (_) {}
  }
}

function showEarlyToast(m) {
  let wrap = el("early-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "early-toast-wrap";
    document.body.appendChild(wrap);
  }
  const t = document.createElement("div");
  t.className = "early-toast " + (m.direction === "up" ? "up" : "down");
  t.innerHTML = `<div class="et-head">⚡ EARLY MOVE — ${m.stage === "Igniting" ? "IGNITING" : "EARLY"}</div>
    <div class="et-msg">${m.message}</div>
    <div class="et-sub">score ${m.earlyScore} · ${m.optionType} side · tap to open</div>`;
  t.addEventListener("click", () => { openStock(m.symbol); t.remove(); });
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add("fade"); setTimeout(() => t.remove(), 600); }, 12000);
}

// Poll the scalp scan while notifications are on, and alert when a squeeze fires.
function startScalpWatch() {
  if (state.scalp.timer) clearInterval(state.scalp.timer);
  scalpWatch(); // run once now (seeds baseline)
  state.scalp.timer = setInterval(scalpWatch, 180 * 1000); // every 3 min
}

function stopScalpWatch() {
  if (state.scalp.timer) clearInterval(state.scalp.timer);
  state.scalp.timer = null;
}

async function scalpWatch() {
  try {
    const data = await fetch(`/api/scalp-scan?interval=${state.interval}`).then((r) => r.json());
    if (data.error || !data.scan) return;
    const firstRun = Object.keys(state.scalp.prevStates).length === 0;
    for (const m of data.scan) {
      const prev = state.scalp.prevStates[m.symbol];
      const nowFired = m.state === "Fired Up" || m.state === "Fired Down";
      const wasFired = prev === "Fired Up" || prev === "Fired Down";
      if (!firstRun && nowFired && !wasFired && state.alerts.notify) {
        fireSqueezeAlert(m);
      }
      state.scalp.prevStates[m.symbol] = m.state;
    }
    // Keep the scan card fresh if it's showing.
    const box = el("scalp-scan");
    if (box && !box.textContent.startsWith("Click")) renderScalpScan(data);
  } catch (_) { /* ignore */ }
}

function fireSqueezeAlert(m) {
  beep();
  const dir = m.direction === "up" ? "UP" : m.direction === "down" ? "DOWN" : "";
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`Squeeze FIRED ${dir}: ${m.name}`, {
        body: `Burst ${m.burstScore}/100 · ATR ${m.atrExpansion}x · vol ${m.volumeSurge}x — big move starting`,
      });
    }
  } catch (_) {}
  const card = document.querySelector(".scalp-scan-card");
  if (card) { card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1500); }
}

function beep() {
  try {
    const ctx = state.alerts.audioCtx;
    if (!ctx) return;
    // Two quick ascending tones.
    [880, 1240].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, ctx.currentTime + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.16);
      osc.stop(ctx.currentTime + i * 0.16 + 0.16);
    });
  } catch (_) {}
}

function fireTopPickAlert(top) {
  beep();
  const bull = top.direction === "bullish";
  const action = top.optionType
    ? `${bull ? "CALL" : "PUT"} ${top.atmStrike ?? ""}`.trim()
    : bull ? "LONG" : "SHORT";
  const title = `New top pick: ${top.name}`;
  const body = `${action} · +${fmt(top.potentialGainPct)}% potential · success ${fmt(top.successRate, 1)}% · conf ${top.confidence}%`;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch (_) {}
  // Also flash the card so it's noticeable even without OS notifications.
  const card = document.querySelector(".alerts-card");
  if (card) {
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1500);
  }
}

function startAlertsAutoRefresh() {
  alertsNextAt = Date.now() + 1800 * 1000;
  // Reload every 30 minutes.
  if (alertsTimer) clearInterval(alertsTimer);
  alertsTimer = setInterval(loadAlerts, 1800 * 1000);
  // Update the countdown label every second.
  setInterval(() => {
    const el2 = el("alerts-countdown");
    if (!el2) return;
    const remaining = Math.max(0, alertsNextAt - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    el2.textContent = `next: ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, 1000);
}

// ---------- backtest ----------
async function runBacktest() {
  if (!state.active) return;
  const btn = el("run-backtest");
  btn.disabled = true;
  btn.textContent = "Running...";
  try {
    const params = new URLSearchParams({
      interval: state.interval,
      sl: el("bt-sl").value,
      target: el("bt-target").value,
      threshold: el("bt-threshold").value,
      short: el("bt-short").checked ? "true" : "false",
    });
    const r = await fetch(`/api/backtest/${encodeURIComponent(state.active)}?${params}`).then((x) => x.json());
    if (r.error) { el("bt-summary").textContent = r.error; return; }
    renderBacktest(r);
  } catch (e) {
    el("bt-summary").textContent = "Backtest failed: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run backtest";
  }
}

async function compareBacktest() {
  if (!state.active) return;
  const btn = el("compare-bt");
  btn.disabled = true;
  btn.textContent = "Comparing...";
  el("bt-summary").textContent = "Running 5m and 15m over the same recent window...";
  equitySeries.setData([]);
  try {
    const params = new URLSearchParams({
      sl: el("bt-sl").value,
      target: el("bt-target").value,
      threshold: el("bt-threshold").value,
      short: el("bt-short").checked ? "true" : "false",
    });
    const r = await fetch(`/api/backtest-compare/${encodeURIComponent(state.active)}?${params}`).then((x) => x.json());
    if (r.error) { el("bt-summary").textContent = r.error; return; }
    renderCompare(r);
  } catch (e) {
    el("bt-summary").textContent = "Compare failed: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Compare 5m vs 15m";
  }
}

function renderCompare(r) {
  const cell = (res, key, suffix = "", plus = false) => {
    if (res.error) return "-";
    const v = res[key];
    return (plus && v >= 0 ? "+" : "") + fmt(v) + suffix;
  };
  const rows = r.results
    .map((res) => {
      const isBest = res.interval === r.best;
      if (res.error) {
        return `<tr><td><b>${res.interval}</b></td><td colspan="6" class="wl-sub">${res.error}</td></tr>`;
      }
      return `<tr class="${isBest ? "top-pick" : ""}">
        <td><b>${res.interval}</b> ${isBest ? '<span class="opt-tag ce">BEST</span>' : ""}</td>
        <td class="num">${res.trades}</td>
        <td class="num">${fmt(res.winRate, 1)}%</td>
        <td class="num ${res.netPnlPercent >= 0 ? "up" : "down"}">${res.netPnlPercent >= 0 ? "+" : ""}${fmt(res.netPnlPercent)}%</td>
        <td class="num">${res.profitFactor >= 99 ? "∞" : fmt(res.profitFactor)}</td>
        <td class="num">${fmt(res.expectancyPercent, 3)}%</td>
        <td class="num down">-${fmt(res.maxDrawdownPercent)}%</td>
      </tr>`;
    })
    .join("");
  const winnerLine = r.best
    ? `<div class="cmp-winner">Better timeframe: <b>${r.best}</b> <span class="wl-sub">(${r.bestBasis})</span></div>`
    : `<div class="wl-sub">Not enough data to compare.</div>`;
  el("bt-summary").innerHTML = `
    ${winnerLine}
    <table class="alerts-table">
      <thead><tr><th>Interval</th><th>Trades</th><th>Win%</th><th>Net P&L</th><th>PF</th><th>Expectancy</th><th>Max DD</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="opt-disclaimer">${r.disclaimer}</p>`;
}

function renderBacktest(r) {
  const pf = r.profitFactor === null || r.profitFactor === "Infinity" || !isFinite(r.profitFactor) ? "∞" : fmt(r.profitFactor);
  const net = r.netPnlPercent;
  el("bt-summary").innerHTML = `
    <div class="bt-metrics">
      <div class="metric"><span>Trades</span><b>${r.totalTrades}</b></div>
      <div class="metric"><span>Win rate</span><b>${fmt(r.winRate)}%</b></div>
      <div class="metric"><span>Net P&L (1 unit)</span><b class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : ""}${fmt(net)}%</b></div>
      <div class="metric"><span>Profit factor</span><b>${pf}</b></div>
      <div class="metric"><span>Avg win</span><b class="up">+${fmt(r.avgWinPercent)}%</b></div>
      <div class="metric"><span>Avg loss</span><b class="down">-${fmt(r.avgLossPercent)}%</b></div>
      <div class="metric"><span>Expectancy/trade</span><b>${fmt(r.expectancyPercent)}%</b></div>
      <div class="metric"><span>Max drawdown</span><b class="down">-${fmt(r.maxDrawdownPercent)}%</b></div>
    </div>
    <p class="wl-sub">Backtest over ${r.candles} candles (${r.interval}). Results assume 1-unit positions, no brokerage/slippage. Past performance does not predict future results.</p>`;

  // equity curve with strictly increasing timestamps
  let lastT = 0;
  const data = r.equityCurve.map((p) => {
    let t = p.time || lastT + 1;
    if (t <= lastT) t = lastT + 1;
    lastT = t;
    return { time: t, value: p.equity };
  });
  equitySeries.setData(data);
  equityChart.timeScale().fitContent();
}

// ---------- helpers ----------
function colorForScore(score) {
  if (score >= 50) return { bg: "#0f2e22", fg: "#16c784" };
  if (score >= 15) return { bg: "#12241c", fg: "#16c784" };
  if (score <= -50) return { bg: "#331416", fg: "#ea3943" };
  if (score <= -15) return { bg: "#2a1416", fg: "#ea3943" };
  return { bg: "#2a2410", fg: "#f0b90b" };
}

// ---------- Trade Back-Test (option review, commentary in Hindi) ----------
async function initBacktest() {
  const dt = el("bt-date");
  if (dt && !dt.value) {
    const d = new Date(Date.now() + 19800000); // IST "today"
    dt.value = d.toISOString().slice(0, 10);
    dt.max = d.toISOString().slice(0, 10);
  }
  const sym = el("bt-symbol"), typ = el("bt-type"), exp = el("bt-expiry");
  if (sym) sym.addEventListener("change", loadBtExpiries);
  if (exp) exp.addEventListener("change", loadBtStrikes);
  if (typ) typ.addEventListener("change", loadBtStrikes);
  if (el("bt-run")) el("bt-run").addEventListener("click", runBacktest);
  try {
    const d = await fetch("/api/backtest/option/underlyings").then((r) => r.json());
    const ind = (d.underlyings || []).filter((u) => u.type === "index");
    const stk = (d.underlyings || []).filter((u) => u.type !== "index");
    const grp = (label, arr) => arr.length ? `<optgroup label="${label}">${arr.map((u) => `<option value="${u.symbol}">${u.name}</option>`).join("")}</optgroup>` : "";
    sym.innerHTML = grp("Indices", ind) + grp("Stocks", stk) || `<option value="">कोई symbol नहीं</option>`;
    await loadBtExpiries();
  } catch (e) {
    el("bt-status").textContent = "Symbols लोड नहीं हुए: " + e.message;
  }
}

async function loadBtExpiries() {
  const sym = el("bt-symbol").value;
  const exp = el("bt-expiry"), stk = el("bt-strike");
  if (!sym) return;
  exp.innerHTML = `<option value="">लोड…</option>`;
  stk.innerHTML = `<option value="">—</option>`;
  try {
    const d = await fetch("/api/backtest/option/meta?symbol=" + encodeURIComponent(sym)).then((r) => r.json());
    const list = d.expiries || [];
    if (!list.length) { exp.innerHTML = `<option value="">कोई expiry नहीं</option>`; el("bt-status").textContent = d.message || "इस symbol के लिए option data नहीं मिला।"; return; }
    exp.innerHTML = list.map((e) => `<option value="${e}">${e}</option>`).join("");
    el("bt-status").textContent = "";
    await loadBtStrikes();
  } catch (e) {
    exp.innerHTML = `<option value="">error</option>`;
    el("bt-status").textContent = "Expiry लोड नहीं हुई: " + e.message;
  }
}

async function loadBtStrikes() {
  const sym = el("bt-symbol").value, expiry = el("bt-expiry").value, type = el("bt-type").value;
  const stk = el("bt-strike");
  if (!sym || !expiry) return;
  stk.innerHTML = `<option value="">लोड…</option>`;
  try {
    const d = await fetch(`/api/backtest/option/strikes?symbol=${encodeURIComponent(sym)}&expiry=${expiry}&type=${type}`).then((r) => r.json());
    const list = d.strikes || [];
    if (!list.length) { stk.innerHTML = `<option value="">कोई strike नहीं</option>`; return; }
    stk.innerHTML = list.map((s) => `<option value="${s}">${s}</option>`).join("");
    stk.selectedIndex = Math.floor(list.length / 2); // start near the middle of the ladder
  } catch (e) {
    stk.innerHTML = `<option value="">error</option>`;
  }
}

async function runBacktest() {
  const sym = el("bt-symbol").value, type = el("bt-type").value, expiry = el("bt-expiry").value;
  const strike = el("bt-strike").value, date = el("bt-date").value;
  const start = el("bt-start").value || "09:20", end = el("bt-end").value || "15:15";
  const entry = el("bt-entry").value, exit = el("bt-exit").value, lots = el("bt-lots").value;
  const box = el("bt-result"), st = el("bt-status");
  if (!sym || !expiry || !strike || !date) { st.textContent = "कृपया symbol, expiry, strike और date चुनें।"; return; }
  const btn = el("bt-run");
  btn.disabled = true; btn.textContent = "जाँच रहा है…";
  st.textContent = "Historical option data मँगा रहा है…";
  box.innerHTML = "";
  try {
    const url = `/api/backtest/option/review?symbol=${encodeURIComponent(sym)}&type=${type}&strike=${strike}&expiry=${expiry}&date=${date}&start=${start}&end=${end}` +
      (entry ? `&entry=${entry}` : "") + (exit ? `&exit=${exit}` : "") + (lots ? `&lots=${lots}` : "");
    const d = await fetch(url).then((r) => r.json());
    if (d.error) { st.textContent = "Error: " + d.error; return; }
    if (!d.available) { st.textContent = ""; box.innerHTML = `<div class="bt-msg">${d.message || "Data नहीं मिला।"}</div>`; return; }
    st.textContent = "";
    box.innerHTML = renderBacktest(d);
  } catch (e) {
    st.textContent = "Failed: " + e.message;
  } finally {
    btn.disabled = false; btn.textContent = "जाँचें (Review)";
  }
}

function renderBacktest(d) {
  const rc = d.rating === "GOOD" ? "good" : d.rating === "BAD" ? "bad" : "avg";
  const sign = (n) => (n > 0 ? "+" : "") + n;
  const altRows = (d.alternatives || []).map((a) => `
    <tr>
      <td>${a.strike} ${a.type} <span class="mny mny-${(a.moneyness || "").toLowerCase()}">${a.moneyness}</span></td>
      <td class="num">₹${fmt(a.entry)}</td>
      <td class="num">₹${fmt(a.exit)}</td>
      <td class="num"><b class="${a.pnlPct >= 0 ? "up" : "down"}">${sign(a.pnlPct)}%</b></td>
    </tr>`).join("");
  return `
  <div class="bt-verdict bt-${rc}">
    <div class="bt-rating">${d.ratingHindi}</div>
    <div class="bt-summary">${d.summary}</div>
  </div>
  <div class="bt-grid">
    <div class="bt-kv"><span>Entry</span><b>₹${fmt(d.entry.premium)}</b><small>${d.entry.time} · spot ${fmt(d.entry.spot)}</small></div>
    <div class="bt-kv"><span>Exit</span><b>₹${fmt(d.exit.premium)}</b><small>${d.exit.time} · spot ${fmt(d.exit.spot)}</small></div>
    <div class="bt-kv"><span>P&amp;L</span><b class="${d.pnlPct >= 0 ? "up" : "down"}">${sign(d.pnlPct)}%</b><small>₹${fmt(d.pnlPerLot)}/lot${d.totalPnl != null ? ` · कुल ₹${fmt(d.totalPnl)}` : ""}</small></div>
    <div class="bt-kv"><span>Best निकास</span><b class="up">${sign(d.best.pnlPct)}%</b><small>₹${fmt(d.best.premium)} @ ${d.best.time}</small></div>
    <div class="bt-kv"><span>Max गिरावट</span><b class="down">${d.worst.drawPct}%</b><small>₹${fmt(d.worst.premium)} @ ${d.worst.time}</small></div>
    <div class="bt-kv"><span>Spot चाल</span><b class="${(d.spotMovePct || 0) >= 0 ? "up" : "down"}">${d.spotMovePct == null ? "?" : sign(d.spotMovePct) + "%"}</b><small>strike ${d.moneyness} · ${d.moneynessPct}% दूर</small></div>
  </div>
  <div class="bt-sec">
    <h4>विश्लेषण (क्या हुआ)</h4>
    <ul class="bt-list">${(d.reasons || []).map((r) => `<li>${r}</li>`).join("")}</ul>
  </div>
  <div class="bt-sec">
    <h4>सुधार / सुझाव</h4>
    <ul class="bt-list bt-improve">${(d.improvements || []).map((r) => `<li>${r}</li>`).join("")}</ul>
  </div>
  ${altRows ? `<div class="bt-sec"><h4>आस-पास के strike (इसी समय window में)</h4>
    <table class="bt-alt"><thead><tr><th>Strike</th><th>Entry</th><th>Exit</th><th>P&amp;L%</th></tr></thead><tbody>${altRows}</tbody></table>
    <div class="wl-sub" style="margin-top:4px">जो strike सबसे ऊपर/हरा है, इसी दिन उसी समय वह बेहतर चलता।</div></div>` : ""}
  <div class="bt-disc">${d.disclaimer || ""}</div>`;
}

function cssId(sym) { return sym.replace(/[^a-zA-Z0-9]/g, "_"); }

function startClock() {
  const tick = () => {
    const now = new Date();
    const text = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
    document.querySelectorAll("[data-clock]").forEach((n) => { n.textContent = text; });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- local access gate ----------
const LG_TOKEN_KEY = "nsa_session";

// The backend now requires a Bearer session token on every /api route except
// /api/login, /api/session and /api/logout (see routes/api.ts). Previously
// only the login-gate's own two calls attached the Authorization header, so
// enforcing auth server-side would otherwise 401 every other call in this
// file. Patching window.fetch once here covers all of them without touching
// each of the ~85 call sites individually.
(function installAuthFetch() {
  const nativeFetch = window.fetch.bind(window);
  const PUBLIC = ["/api/login", "/api/session", "/api/logout"];
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.startsWith("/api/") && !PUBLIC.some((p) => url.startsWith(p))) {
      const token = localStorage.getItem(LG_TOKEN_KEY);
      if (token) {
        init = init || {};
        init.headers = Object.assign({}, init.headers || {}, { Authorization: "Bearer " + token });
      }
    }
    return nativeFetch(input, init);
  };
})();

let lgSelectedMode = "admin";

function enterByRole(role, permissions, username) {
  state.role = role || "user";
  state.permissions = permissions || [];
  state.session = { role: state.role, permissions: state.permissions, username: username || null };
  applyPermissionGating();
  // The dashboard's data loaders (init(), bottom of this file) must not fire
  // any /api/* call until a session token is confirmed valid - every one of
  // them previously ran unconditionally at page load, before login, so each
  // 401'd once and (unlike a periodic auto-refresh) most never got a second
  // chance until a full page reload. enterByRole() is the single place both
  // the "already logged in" and "just logged in" paths funnel through
  // (setupLoginGate() below), so it's the only safe place to start loading
  // dashboard data. Guarded so a stray second call (there shouldn't be one)
  // can't re-run every timer/listener setup in init() twice.
  if (!state.dashboardInited) {
    state.dashboardInited = true;
    init();
  }
  renderHomeIdentity();
  // Home ("Choose your desk") is the required landing screen for every role,
  // admin included - the Admin Control Center used to be admin's forced
  // landing page instead; it's now reached on demand from Home's "⚙ Admin
  // Settings" menu (see renderHomeIdentity()/enterAdminMode()) so an admin
  // sees the same first screen as everyone else and picks a desk explicitly.
  enterApp();
}

// Fills in the Home screen's identity block (avatar initials, username, role)
// and shows/hides the admin-only menu item. Called once per login from
// enterByRole() - the dropdown/menu wiring itself is idempotent (setupHomeChrome()
// runs once at page load, before auth, since it's pure event-listener setup).
function renderHomeIdentity() {
  const username = state.session?.username || "Trader";
  const isAdmin = state.role === "admin";
  const nameEl = el("home-username");
  if (nameEl) nameEl.textContent = username;
  const welcomeEl = el("home-welcome-name");
  if (welcomeEl) welcomeEl.textContent = username;
  const roleEl = el("home-role");
  if (roleEl) roleEl.textContent = isAdmin ? "Admin" : "Trader";
  const initialsEl = el("home-avatar-initials");
  if (initialsEl) initialsEl.textContent = username.slice(0, 2).toUpperCase();
  const adminBtn = el("home-admin-settings");
  if (adminBtn) adminBtn.classList.toggle("hidden", !isAdmin);
}

// Pure UI wiring for the Home screen's top bar (avatar dropdown, notification
// bell shortcut, pro-tip dismiss). No auth-gated data here, so - like
// setupModeGate()/setupMobileNav() - this runs once at page load regardless
// of login state.
function setupHomeChrome() {
  const avatarBtn = el("home-avatar-btn");
  const menu = el("home-identity-menu");
  if (avatarBtn && menu) {
    avatarBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== avatarBtn) menu.classList.add("hidden"); });
  }
  const adminBtn = el("home-admin-settings");
  if (adminBtn) adminBtn.addEventListener("click", () => { menu?.classList.add("hidden"); enterAdminMode(); });
  const logoutBtn = el("home-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", () => { menu?.classList.add("hidden"); doLogout(); });
  const bell = el("home-bell");
  if (bell) bell.addEventListener("click", () => chooseMode("option"));

  const tip = el("home-tip");
  const TIP_KEY = "nsa_home_tip_dismissed";
  if (tip) {
    try { if (localStorage.getItem(TIP_KEY) === "1") tip.classList.add("hidden"); } catch (_) {}
    const closeBtn = el("home-tip-close");
    if (closeBtn) closeBtn.addEventListener("click", () => {
      tip.classList.add("hidden");
      try { localStorage.setItem(TIP_KEY, "1"); } catch (_) {}
    });
  }
}

// Live NIFTY/BANKNIFTY/FINNIFTY strip on the Home screen - the same real
// /api/quotes endpoint the in-app live ticker already uses (startLiveTicker()),
// just for the three headline indices. Fetched once whenever Home is (re)shown
// (see showModeGate()), not on a perpetual timer, so it never adds background
// load beyond what a normal page view already causes.
const HOME_INDEX_SYMBOLS = { "^NSEI": "home-tk-nsei", "^NSEBANK": "home-tk-nsebank", "^CNXFIN": "home-tk-cnxfin" };
async function loadHomeTicker() {
  try {
    const syms = Object.keys(HOME_INDEX_SYMBOLS);
    const d = await fetch("/api/quotes?symbols=" + encodeURIComponent(syms.join(","))).then((r) => r.json());
    const q = (d && d.quotes) || {};
    syms.forEach((sym) => {
      const node = el(HOME_INDEX_SYMBOLS[sym]);
      if (!node) return;
      const v = q[sym];
      if (!v || v.price == null) return;
      const chg = v.changePercent;
      node.textContent = fmt(v.price) + (chg != null ? ` (${chg >= 0 ? "+" : ""}${fmt(chg, 2)}%)` : "");
      node.className = chg == null ? "" : chg >= 0 ? "up" : "down";
    });
  } catch (_) { /* Home ticker is a convenience readout - a failed fetch just leaves it blank */ }
  // Data-feed provider text is set directly by loadSymbolsAndWatchlist() (the
  // single source of truth for res.provider), not scraped from another DOM
  // node here, since that fetch and this one aren't ordered relative to each
  // other and #provider-badge is sometimes still empty at this point.
}

async function setupLoginGate() {
  const gate = el("login-gate");
  if (!gate) return;
  const form = el("login-form");
  const pass = el("lg-pass");
  const show = el("lg-show");
  const errEl = el("lg-error");

  if (show && pass) show.addEventListener("click", () => {
    const reveal = pass.type === "password";
    pass.type = reveal ? "text" : "password";
    show.textContent = reveal ? "HIDE" : "SHOW";
  });

  // Admin/User mode card selector - a UI hint only; the server independently
  // verifies the real role from the matched account and never trusts this.
  // Switching cards clears username/password: they're two different accounts
  // (admin vs a userStore user), so carrying one card's typed-in credentials
  // over to the other card is never correct - only ever leftover text.
  const userInput = el("lg-user");
  document.querySelectorAll(".lg-mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      lgSelectedMode = card.getAttribute("data-mode");
      document.querySelectorAll(".lg-mode-card").forEach((c) => c.classList.toggle("selected", c === card));
      if (userInput) userInput.value = "";
      if (pass) pass.value = "";
      if (errEl) errEl.textContent = "";
      if (userInput) userInput.focus();
    });
  });

  const logoutBtn = el("logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", doLogout);

  // Already have a valid session? Skip the gate.
  const token = localStorage.getItem(LG_TOKEN_KEY);
  if (token) {
    try {
      const r = await fetch("/api/session", { headers: { Authorization: "Bearer " + token } }).then((x) => x.json());
      if (r && r.valid) { gate.remove(); enterByRole(r.role, r.permissions, r.username); return; }
      // Server actually answered and said this token is no longer valid
      // (expired/logged out elsewhere) - safe to forget it.
      localStorage.removeItem(LG_TOKEN_KEY);
    } catch (_) {
      // The /api/session request itself failed (network blip, or - on Render's
      // free tier - the server still cold-starting). That is NOT the same as
      // "the server confirmed this session is invalid", so the token must be
      // kept: wiping it here forced a real, previously-logged-in user back to
      // the login screen on a transient hiccup instead of just retrying. Fall
      // through to showing the login form for now; the token stays in
      // localStorage so a page reload once the server responds recovers the
      // session normally instead of demanding a fresh login.
    }
  }

  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el("lg-submit");
    if (btn) btn.disabled = true;
    if (errEl) errEl.textContent = "";
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: el("lg-user").value, password: pass.value, mode: lgSelectedMode }),
      }).then((x) => x.json());
      if (r && r.ok && r.token) {
        localStorage.setItem(LG_TOKEN_KEY, r.token);
        gate.remove();
        enterByRole(r.role, r.permissions, r.username);
      } else if (errEl) {
        errEl.textContent = r && r.error ? r.error : "Login failed.";
      }
    } catch (err) {
      if (errEl) errEl.textContent = "Login error: " + err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// Hides mode-gate desk cards a "user" role isn't permitted for. Backend
// enforcement (requirePermission) is the REAL gate (routes/api.ts) - this is
// only so a restricted user doesn't see a button that would just 403.
const DESK_PERMISSION_MAP = { option: "oiAnalysis", stockOption: "tradingDashboard", swing: "marketAnalysis", dhanbacktest: "backtesting", aipaper: "aiPaperDesk" };
// Credential-rotation is ADMIN ONLY - hiding it here is a UX convenience
// only, never the real security boundary. The actual enforcement is
// server-side (requireAdmin on every /api/admin/* and provider route,
// routes/api.ts) - a USER cannot retrieve any of this by typing the URL,
// calling the API directly, or editing frontend JS, regardless of what this
// function hides. (Dhan/Telegram buttons are handled separately - they
// stay permanently hidden in index.html and are only ever reachable via the
// Admin Control Center's Connections card - see enterAdminMode().)
const ADMIN_ONLY_BUTTON_IDS = ["rotate-login-btn"];
function applyPermissionGating() {
  const isAdmin = state.role === "admin";
  ADMIN_ONLY_BUTTON_IDS.forEach((id) => {
    const btn = el(id);
    if (btn) btn.classList.toggle("hidden", !isAdmin);
  });
  if (isAdmin) return; // implicit full access - nothing else hidden
  document.querySelectorAll("#mode-gate [data-mode]").forEach((btn) => {
    const mode = btn.getAttribute("data-mode");
    const perm = DESK_PERMISSION_MAP[mode];
    const allowed = !perm || (state.permissions || []).includes(perm);
    btn.classList.toggle("hidden", !allowed);
  });
}

// Ends this browser's session both client-side (forget the token, so future
// /api/* calls stop attaching it) and server-side (POST /api/logout deletes
// the token from the in-memory sessions map - see auth/session.ts's logout())
// so it can't be replayed even if it leaked. login-gate's markup is removed
// from the DOM on a successful login (see setupLoginGate), and this app has a
// lot of running timers/chart state by the time anyone is logged in, so a
// full reload is the simplest reliable way back to a clean login screen
// rather than trying to manually rebuild everything in place.
async function doLogout() {
  if (!confirm("Logout karna hai? Session band ho jayega, dobara login karna padega.")) return;
  const token = localStorage.getItem(LG_TOKEN_KEY);
  try {
    await fetch("/api/logout", { method: "POST", headers: token ? { Authorization: "Bearer " + token } : {} });
  } catch (_) { /* best-effort - still forget the token locally either way */ }
  try { localStorage.removeItem(LG_TOKEN_KEY); } catch (_) { /* ignore */ }
  // Also forget the last-chosen desk (nsa_mode) - otherwise enterApp() finds
  // it still saved on the next login and skips straight past the Option/
  // Stock Option/Stock Swing/Backtest desk-picker screen entirely.
  try { localStorage.removeItem(MODE_KEY); } catch (_) { /* ignore */ }
  location.reload();
}

// ============================ Admin Control Center ============================
const PERMISSION_LABELS = {
  tradingDashboard: "Trading Dashboard", marketAnalysis: "Market Analysis", oiAnalysis: "OI Analysis",
  aiSignals: "AI Signals", backtesting: "Backtesting", tradeJournal: "Trade Journal", adminReports: "Admin Reports",
  // AI Paper Desk — desk gate + one per screen (admin can toggle independently).
  aiPaperDesk: "AI Paper Desk (access)",
  aiPaperDashboard: "AI Paper · Dashboard", aiPaperAnalysis: "AI Paper · Market Analysis",
  aiPaperSignals: "AI Paper · Signals & Insights", aiPaperTrade: "AI Paper · Paper Trading",
  aiPaperReview: "AI Paper · Trade Review", aiPaperPerformance: "AI Paper · Performance",
  aiPaperValidation: "AI Paper · Validation & Learning",
};

// Opened on demand from Home's "⚙ Admin Settings" menu (renderHomeIdentity()) -
// no longer the forced landing screen for admin. See ac-back-home for the way out.
function enterAdminMode() {
  const center = el("admin-center");
  if (!center) return;
  el("mode-gate")?.classList.add("hidden");
  center.classList.remove("hidden");
  const who = el("ac-whoami");
  if (who) who.textContent = `Logged in as: ${state.session?.username || "admin"} · Mode: ADMIN`;
  const logoutBtn = el("ac-logout");
  if (logoutBtn && !logoutBtn.dataset.wired) { logoutBtn.dataset.wired = "1"; logoutBtn.addEventListener("click", doLogout); }
  const backBtn = el("ac-back-home");
  if (backBtn && !backBtn.dataset.wired) {
    backBtn.dataset.wired = "1";
    backBtn.addEventListener("click", () => { center.classList.add("hidden"); enterApp(); });
  }
  const createBtn = el("acf-create");
  if (createBtn && !createBtn.dataset.wired) { createBtn.dataset.wired = "1"; createBtn.addEventListener("click", doCreateUser); }
  const showAllChk = el("ac-history-showall");
  if (showAllChk && !showAllChk.dataset.wired) { showAllChk.dataset.wired = "1"; showAllChk.addEventListener("change", loadLoginHistory); }
  loadAdminPermissionCheckboxes();
  loadAdminStats();
  loadAdminUsers();
  loadLoginHistory();
  loadAdminConnectionsSummary();
}

// Renders the read-only Dhan/Telegram status summary in the Admin
// Control Center's Connections card. Each "Manage" button just clicks the
// corresponding (permanently topbar-hidden) legacy button to reuse the
// existing open/save/test logic in setupConnect() rather than duplicating it.
const CONNECTION_MANAGE_BTN = { dhan: "connect-btn", telegram: "telegram-btn" };
function manageConnection(provider) {
  const btnId = CONNECTION_MANAGE_BTN[provider];
  if (btnId) el(btnId)?.click();
}
async function loadAdminConnectionsSummary() {
  const body = el("ac-connections-body");
  if (!body) return;
  try {
    const d = await fetch("/api/admin/connections").then((r) => r.json());
    const fmt = (ts) => (ts ? new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
    const rows = [
      { key: "dhan", label: "Dhan", info: d.dhan || d.groww },
      { key: "telegram", label: "Telegram", info: d.telegram },
    ];
    body.innerHTML = rows.map(({ key, label, info }) => {
      const connected = info?.status === "CONNECTED";
      const dotCls = connected ? "ok" : info?.status === "ERROR" ? "err" : "blocked";
      return `<tr>
        <td>${label}</td>
        <td class="${dotCls}">● ${info?.status || "UNKNOWN"}</td>
        <td class="wl-sub">${fmt(info?.lastConnectedAt)}</td>
        <td class="wl-sub">${fmt(info?.lastTestedAt)}</td>
        <td><button type="button" class="ghost" onclick="manageConnection('${key}')">Manage</button></td>
      </tr>`;
    }).join("");
  } catch (_) {
    body.innerHTML = '<tr><td colspan="5" class="wl-sub">Could not load connection status.</td></tr>';
  }
}

async function loadAdminPermissionCheckboxes() {
  const box = el("acf-permissions");
  if (!box || box.dataset.loaded) return;
  try {
    const d = await fetch("/api/admin/permissions").then((r) => r.json());
    box.innerHTML = (d.permissions || []).map((p) =>
      `<label><input type="checkbox" value="${p}" class="acf-perm-cb" /> ${PERMISSION_LABELS[p] || p}</label>`
    ).join("");
    box.dataset.loaded = "1";
  } catch (_) { /* best-effort */ }
}

async function loadAdminStats() {
  try {
    const d = await fetch("/api/admin/stats").then((r) => r.json());
    if (el("ac-stat-total")) el("ac-stat-total").textContent = d.total ?? "-";
    if (el("ac-stat-active")) el("ac-stat-active").textContent = d.active ?? "-";
    if (el("ac-stat-expired")) el("ac-stat-expired").textContent = d.expired ?? "-";
    if (el("ac-stat-disabled")) el("ac-stat-disabled").textContent = d.disabled ?? "-";
  } catch (_) { /* best-effort */ }
}

async function doCreateUser() {
  const status = el("acf-status");
  const username = el("acf-username")?.value?.trim();
  const temporaryPassword = el("acf-password")?.value || "";
  const accessStartDate = el("acf-start")?.value || null;
  const accessExpiryDate = el("acf-expiry")?.value || null;
  const permissions = [...document.querySelectorAll(".acf-perm-cb:checked")].map((cb) => cb.value);
  if (!username || !temporaryPassword) {
    if (status) { status.textContent = "Username and temporary password are required."; status.className = "conn-status err"; }
    return;
  }
  try {
    const r = await fetch("/api/admin/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, temporaryPassword, accessStartDate, accessExpiryDate, permissions }),
    }).then((res) => res.json());
    if (!r.ok) { if (status) { status.textContent = r.error || "Could not create user."; status.className = "conn-status err"; } return; }
    if (status) { status.textContent = `User created successfully — User ID: ${r.user.userId}, Username: ${r.user.username}. Share the temporary password with them directly.`; status.className = "conn-status ok"; }
    el("acf-username").value = ""; el("acf-password").value = ""; el("acf-start").value = ""; el("acf-expiry").value = "";
    document.querySelectorAll(".acf-perm-cb").forEach((cb) => (cb.checked = false));
    loadAdminStats();
    loadAdminUsers();
  } catch (e) {
    if (status) { status.textContent = "Could not create user: " + e.message; status.className = "conn-status err"; }
  }
}

async function loadAdminUsers() {
  const body = el("ac-users-body");
  if (!body) return;
  try {
    const d = await fetch("/api/admin/users").then((r) => r.json());
    const users = d.users || [];
    if (!users.length) { body.innerHTML = '<tr><td colspan="6" class="wl-sub">No users yet — create one above.</td></tr>'; return; }
    body.innerHTML = users.map((u) => {
      const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const eff = u.status === "DISABLED" ? "DISABLED" : (u.accessExpiryDate && u.accessExpiryDate < today) ? "EXPIRED" : "ACTIVE";
      const cls = eff === "ACTIVE" ? "ok" : "blocked";
      const lastLogin = u.lastLogin ? new Date(u.lastLogin).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";
      const permsLabel = (u.permissions || []).map((p) => PERMISSION_LABELS[p] || p).join(", ") || "none";
      return `<tr>
        <td>${u.username}</td>
        <td><b class="${cls}">${eff}</b></td>
        <td>${u.accessExpiryDate || "never"}</td>
        <td>${permsLabel}</td>
        <td>${lastLogin}</td>
        <td class="ac-actions">
          ${u.status === "DISABLED"
            ? `<button type="button" class="ghost" onclick="doEnableUser('${u.userId}')">Enable</button>`
            : `<button type="button" class="ghost" onclick="doDisableUser('${u.userId}')">Disable</button>`}
          <button type="button" class="ghost" onclick="doResetUserPassword('${u.userId}')">Reset PW</button>
          <button type="button" class="ghost" onclick="doRevokeUser('${u.userId}')">Revoke</button>
          <button type="button" class="ghost danger" onclick="doDeleteUser('${u.userId}', '${u.username.replace(/'/g, "\\'")}')">Delete</button>
        </td>
      </tr>`;
    }).join("");
  } catch (_) {
    body.innerHTML = '<tr><td colspan="6" class="wl-sub">Could not load users.</td></tr>';
  }
}

async function doDisableUser(userId) {
  if (!confirm("Is user ko disable karna hai?")) return;
  await fetch(`/api/admin/users/${userId}/disable`, { method: "POST" });
  loadAdminStats(); loadAdminUsers();
}
async function doEnableUser(userId) {
  await fetch(`/api/admin/users/${userId}/enable`, { method: "POST" });
  loadAdminStats(); loadAdminUsers();
}
async function doResetUserPassword(userId) {
  const pw = prompt("Naya temporary password (kam se kam 6 characters):");
  if (!pw) return;
  const r = await fetch(`/api/admin/users/${userId}/reset-password`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ temporaryPassword: pw }),
  }).then((res) => res.json());
  if (!r.ok) { alert(r.error || "Could not reset password."); return; }
  alert("Password reset ho gaya. User ko naya password bata dijiye — unka current session bhi revoke ho gaya hai.");
  loadAdminUsers();
}
async function doRevokeUser(userId) {
  if (!confirm("Is user ke saare active sessions revoke karne hain?")) return;
  await fetch(`/api/admin/users/${userId}/revoke`, { method: "POST" });
  alert("Access revoke ho gaya.");
}
// Permanent, unlike Disable — the record is removed entirely and cannot be
// recovered from the Admin Control Center. For accounts genuinely not needed
// anymore (test/mistake accounts) rather than someone whose access should
// just be paused.
async function doDeleteUser(userId, username) {
  if (!confirm(`"${username}" ko HAMESHA ke liye delete karna hai? Yeh wapas nahi ho sakta — agar sirf access rokna hai to "Disable" use karein.`)) return;
  const r = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" }).then((res) => res.json());
  if (!r.ok) { alert(r.error || "Could not delete user."); return; }
  loadAdminStats(); loadAdminUsers();
}

async function loadLoginHistory() {
  const body = el("ac-history-body");
  if (!body) return;
  const showAll = !!el("ac-history-showall")?.checked;
  try {
    const d = await fetch(`/api/admin/login-history?limit=100&scope=${showAll ? "all" : "admin"}`).then((r) => r.json());
    const events = d.events || [];
    if (!events.length) {
      body.innerHTML = `<tr><td colspan="5" class="wl-sub">${showAll ? "No login activity yet." : "No admin actions yet — check \"Show all activity\" to see user logins/attempts too."}</td></tr>`;
      return;
    }
    body.innerHTML = events.map((e) => {
      const t = new Date(e.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const cls = e.type === "login_success" ? "ok" : (e.type === "login_failure" || e.type === "ADMIN_ACCESS_DENIED") ? "err" : "";
      return `<tr><td>${t}</td><td class="${cls}">${e.type}</td><td>${e.username || "-"}</td><td>${e.mode || "-"}</td><td class="wl-sub">${e.detail || ""}</td></tr>`;
    }).join("");
  } catch (_) {
    body.innerHTML = '<tr><td colspan="5" class="wl-sub">Could not load login history.</td></tr>';
  }
}

// ============================ Master Strategy Lab ============================
// VISUALISATION / TESTING / VALIDATION ONLY. Every value rendered here comes from
// GET /api/qa/state and POST /api/qa/run, which run the REAL engine in
// backend/qa/*. Nothing is hard-coded: before any run the screen shows NOT RUN
// rather than a fabricated 0% or a fake PASS. This screen never enables live
// trading - it only displays the blocked state the backend reports.

let _mslState = null;
let _mslCat = "ALL";
let _mslBusy = false;

// The engine stages, in the order the Master Strategy evaluates them. Labels are
// display-only; the engine owns the logic.
const MSL_STAGES = [
  { key: "regime", label: "MARKET REGIME" },
  { key: "structure15", label: "15M MARKET STRUCTURE" },
  { key: "trend15", label: "15M TREND" },
  { key: "structure5", label: "5M STRUCTURE" },
  { key: "oi", label: "OI" },
  { key: "ema", label: "EMA 9/21" },
  { key: "vwap", label: "VWAP" },
  { key: "pcr", label: "PCR" },
  { key: "momentum", label: "MACD / RSI / ATR" },
  { key: "volume", label: "VOLUME + MOMENTUM" },
  { key: "sr", label: "SUPPORT / RESISTANCE" },
  { key: "oiwall", label: "OI WALL" },
  { key: "room", label: "ROOM TO WALL" },
  { key: "rr", label: "RISK / REWARD" },
  { key: "time", label: "TIME VETO" },
  { key: "position", label: "POSITION / COOLDOWN" },
  { key: "selector", label: "MASTER TRADE SELECTOR" },
];

const MSL_RESULT_UI = {
  PASS: { icon: "🟢", cls: "ok", label: "PASS" },
  FAIL: { icon: "🔴", cls: "err", label: "FAIL" },
  UNEXPECTED: { icon: "🟡", cls: "warn", label: "UNEXPECTED" },
  NO_ENGINE_RULE: { icon: "⚠️", cls: "warn", label: "NO ENGINE RULE" },
  NOT_RUN: { icon: "⚪", cls: "", label: "NOT RUN" },
};

const mslEsc = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const mslTime = (ts) => (ts ? new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");

function initStrategyLab() {
  const wire = (id, fn) => {
    const b = el(id);
    if (b && !b.dataset.wired) { b.dataset.wired = "1"; b.addEventListener("click", fn); }
  };
  wire("msl-run-all", () => mslRun({}, "ALL SCENARIOS"));
  wire("msl-run-failed", () => {
    const failed = (_mslState?.lastRun?.scenarios || []).filter((r) => r.result === "FAIL" || r.result === "UNEXPECTED").map((r) => r.id);
    if (!failed.length) { mslLog("No failed scenarios in the last run — nothing to re-run.", true); return; }
    mslRun({ ids: failed }, `${failed.length} FAILED SCENARIO(S)`);
  });
  wire("msl-run-candle", () => mslRun({ kinds: ["CANDLE"] }, "CANDLE TESTS"));
  wire("msl-run-false", () => mslRun({ kinds: ["FALSE_SETUP"] }, "FALSE SETUP TESTS"));
  wire("msl-clear", mslClearResults);
  wire("msl-modal-close", () => el("msl-modal")?.classList.add("hidden"));
  loadStrategyLab();
}

async function loadStrategyLab() {
  try {
    const d = await fetch("/api/qa/state").then((r) => r.json());
    if (d.error) { mslLog(`Could not load Lab state: ${d.error}`, true); return; }
    _mslState = d;
    renderStrategyLab();
  } catch (e) {
    mslLog(`Could not load Lab state: ${e.message}`, true);
  }
}

// Runs the REAL automated runner. Progress is shown per scenario as the response
// arrives - the log reflects actual returned results, never a simulated ticker.
async function mslRun(opts, label) {
  if (_mslBusy) return;
  _mslBusy = true;
  const buttons = ["msl-run-all", "msl-run-failed", "msl-run-candle", "msl-run-false"];
  buttons.forEach((id) => { const b = el(id); if (b) b.disabled = true; });
  const box = el("msl-execlog");
  if (box) {
    box.classList.remove("hidden");
    box.innerHTML = `<div class="msl-log-head">Running ${mslEsc(label)}… <span class="wl-sub">executing the real engine</span></div><div class="msl-log-lines"><div class="wl-sub">⏳ RUNNING</div></div>`;
  }
  try {
    const summary = await fetch("/api/qa/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then((r) => r.json());
    if (summary.error) { mslLog(`Test run failed: ${summary.error}`, true); return; }
    mslRenderExecLog(summary);
    await loadStrategyLab();
  } catch (e) {
    mslLog(`Test run failed: ${e.message}`, true);
  } finally {
    _mslBusy = false;
    buttons.forEach((id) => { const b = el(id); if (b) b.disabled = false; });
  }
}

function mslLog(msg, isError) {
  const box = el("msl-execlog");
  if (!box) return;
  box.classList.remove("hidden");
  box.innerHTML = `<div class="msl-log-head ${isError ? "err" : ""}">${mslEsc(msg)}</div>`;
}

function mslRenderExecLog(s) {
  const box = el("msl-execlog");
  if (!box) return;
  const lines = s.scenarios.map((r) => {
    const ui = MSL_RESULT_UI[r.result] || MSL_RESULT_UI.NOT_RUN;
    return `<div class="msl-log-line ${ui.cls}">${ui.icon} ${mslEsc(r.id)} <span class="wl-sub">${mslEsc(r.title)}</span></div>`;
  }).join("");
  box.classList.remove("hidden");
  box.innerHTML =
    `<div class="msl-log-head">TEST RUN COMPLETE <span class="wl-sub">run ${mslEsc(s.runId)} · ${s.finishedAt - s.startedAt} ms</span></div>` +
    `<div class="msl-log-lines">${lines}</div>` +
    `<div class="msl-log-foot">${s.total} scenarios executed · ${s.passed} passed · ${s.failed} failed · ${s.unexpected} unexpected · ${s.noEngineRule} no engine rule` +
    `<div class="msl-progress"><div class="msl-progress-bar" style="width:${s.total ? Math.round((s.passed / s.total) * 100) : 0}%"></div></div>` +
    `<span class="wl-sub">${s.passed} / ${s.total}</span></div>`;
}

// CLEAR RESULTS clears only this screen's view. It deliberately does NOT delete
// stored run history - that is QA evidence.
function mslClearResults() {
  const box = el("msl-execlog");
  if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  _mslCat = "ALL";
  const body = el("msl-scenario-body");
  if (body && _mslState) {
    body.innerHTML = _mslState.catalogue.map((c) => mslRow({
      id: c.id, category: c.category, title: c.title, result: "NOT_RUN",
      expected: "—", actual: "—", reason: "cleared from view — stored history is untouched",
      score: null, direction: null, tf15: null, tf5: null, rr: null,
    })).join("");
  }
  mslLog("View cleared. Stored run history is preserved — press RUN ALL SCENARIOS to execute again.", false);
}

function renderStrategyLab() {
  const d = _mslState;
  if (!d) return;
  const run = d.lastRun;

  // ---- header status + counts ----
  el("msl-st-engine").textContent = "🟢 ENGINE READY";
  el("msl-st-tester").textContent = "🟢 TEST ENGINE READY";
  const integ = d.integrity;
  el("msl-st-integrity").textContent =
    integ.status === "INTACT" ? "🟢 STRATEGY INTACT"
    : integ.status === "CHANGED" ? "🔴 STRATEGY CHANGED"
    : "⚪ NO BASELINE";
  el("msl-version").textContent = d.strategyVersion || "—";
  el("msl-commit").textContent = d.commit || "—";
  el("msl-lastrun").textContent = run ? mslTime(run.finishedAt) : "NOT RUN";

  // Counts stay "—" until a real run exists - never a fabricated 0.
  el("msl-total").textContent = run ? run.total : "—";
  el("msl-passed").textContent = run ? run.passed : "—";
  el("msl-failed").textContent = run ? run.failed : "—";
  el("msl-unexpected").textContent = run ? run.unexpected : "—";
  el("msl-gaps").textContent = run ? run.noEngineRule : "—";
  el("msl-passpct").textContent = run && run.passPct != null ? `${run.passPct}%` : "NOT RUN";

  const note = el("msl-vocab-note");
  if (note) note.innerHTML = `Engine verdicts: <b>${(d.engineVerdicts || []).map(mslEsc).join(" / ")}</b>. ${mslEsc(d.vocabularyNote || "")}`;

  // ---- 13. live trading protection (display only) ----
  const blocked = el("msl-blocked");
  if (blocked) {
    if (d.liveTradingBlocked) {
      blocked.classList.remove("hidden");
      blocked.innerHTML = `<b>🔴 LIVE TRADING BLOCKED</b><ul>${(d.liveTradingBlockReasons || []).map((r) => `<li>${mslEsc(r)}</li>`).join("")}</ul>` +
        `<span class="wl-sub">This screen does not enable live trading under any condition.</span>`;
    } else {
      blocked.classList.add("hidden");
    }
  }

  mslRenderGrid(run);
  mslRenderCategories();
  mslRenderScenarios();
  mslRenderCandleSection(run);
  mslRenderFalseSection(run);
  mslRenderIntegrity(integ);
  mslRenderHistory(d.history || []);
  mslRenderQaSummary(d);
}

// ---- 2. Master Strategy grid: the decision flow, stage by stage ----
function mslRenderGrid(run) {
  const box = el("msl-grid");
  if (!box) return;
  // Stage state is only shown where the last run actually exercised that stage.
  const byKind = (k) => (run ? run.scenarios.filter((r) => r.kind === k) : []);
  const worst = (rs) => rs.some((r) => r.result === "FAIL" || r.result === "UNEXPECTED") ? "FAIL"
    : rs.some((r) => r.result === "NO_ENGINE_RULE") ? "GAP"
    : rs.length ? "PASS" : "NOT_RUN";
  const stageState = {
    selector: worst(byKind("ARBITER")),
    rr: worst(byKind("SCORE")),
    time: worst(byKind("SCORE")),
    position: worst(byKind("ARBITER")),
    trend15: worst(byKind("CANDLE")),
    structure5: worst(byKind("CANDLE")),
    ema: worst(byKind("CANDLE")),
    oiwall: worst(byKind("FALSE_SETUP")),
    room: worst(byKind("FALSE_SETUP")),
  };
  const ui = { PASS: "🟢 VALIDATED", FAIL: "🔴 FAILING", GAP: "⚠️ NO ENGINE RULE", NOT_RUN: "⚪ NOT RUN" };
  const cls = { PASS: "ok", FAIL: "err", GAP: "warn", NOT_RUN: "" };

  box.innerHTML = MSL_STAGES.map((st) => {
    const state = stageState[st.key] || "NOT_RUN";
    return `<div class="msl-stage ${cls[state]}"><span class="msl-stage-name">${mslEsc(st.label)}</span><b>${ui[state]}</b></div>`;
  }).join('<div class="msl-arrow">↓</div>') +
    `<div class="msl-arrow">↓</div><div class="msl-stage msl-stage-final"><span class="msl-stage-name">ENGINE VERDICT</span><b>${mslEsc((_mslState.engineVerdicts || []).join(" / "))}</b></div>`;
}

// ---- 5. category filters ----
function mslRenderCategories() {
  const box = el("msl-cats");
  if (!box || !_mslState) return;
  const cats = ["ALL", ...(_mslState.categories || [])];
  box.innerHTML = cats.map((c) =>
    `<button type="button" class="sub-tab msl-cat ${c === _mslCat ? "active" : ""}" data-cat="${mslEsc(c)}">${mslEsc(c.replace(/_/g, " "))}</button>`
  ).join("");
  box.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    _mslCat = b.getAttribute("data-cat");
    mslRenderCategories();
    mslRenderScenarios();
  }));
}

function mslRow(r) {
  const ui = MSL_RESULT_UI[r.result] || MSL_RESULT_UI.NOT_RUN;
  return `<tr class="msl-srow" data-id="${mslEsc(r.id)}" tabindex="0">
    <td data-h="ID"><b>${mslEsc(r.id)}</b></td>
    <td data-h="CATEGORY"><span class="msl-chip">${mslEsc(String(r.category).replace(/_/g, " "))}</span></td>
    <td data-h="SCENARIO">${mslEsc(r.title)}</td>
    <td data-h="EXPECTED">${mslEsc(r.expected)}</td>
    <td data-h="ACTUAL">${mslEsc(r.actual)}</td>
    <td data-h="RESULT" class="${ui.cls}"><b>${ui.icon} ${ui.label}</b></td>
    <td data-h="SCORE">${r.score == null ? "—" : mslEsc(r.score)}</td>
    <td data-h="DIRECTION">${mslEsc(r.direction || "—")}</td>
    <td data-h="15M">${mslEsc(r.tf15 || "—")}</td>
    <td data-h="5M">${mslEsc(r.tf5 || "—")}</td>
    <td data-h="R:R">${mslEsc(r.rr || "—")}</td>
    <td data-h="REASON" class="wl-sub">${mslEsc(r.reason)}</td>
  </tr>`;
}

// ---- 4. scenario grid ----
function mslRenderScenarios() {
  const body = el("msl-scenario-body");
  if (!body || !_mslState) return;
  const run = _mslState.lastRun;
  // Unexecuted scenarios render as NOT RUN from the catalogue - never as a pass.
  const rows = run
    ? run.scenarios
    : (_mslState.catalogue || []).map((c) => ({
        ...c, result: "NOT_RUN", expected: "—", actual: "—",
        reason: "not executed yet", score: null, direction: null, tf15: null, tf5: null, rr: null,
      }));
  const filtered = _mslCat === "ALL" ? rows : rows.filter((r) => r.category === _mslCat);
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="12" class="wl-sub">No scenarios in ${mslEsc(_mslCat)}.</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(mslRow).join("");
  body.querySelectorAll(".msl-srow").forEach((tr) => {
    const open = () => mslOpenDetail(tr.getAttribute("data-id"));
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// ---- 6. 15M / 5M candle validation ----
function mslRenderCandleSection(run) {
  const box = el("msl-candle");
  if (!box) return;
  const rows = run ? run.scenarios.filter((r) => r.kind === "CANDLE") : [];
  if (!rows.length) { box.innerHTML = '<span class="wl-sub">⚪ NOT RUN — press RUN CANDLE TESTS.</span>'; return; }
  box.innerHTML = rows.map((r) => {
    const ui = MSL_RESULT_UI[r.result] || MSL_RESULT_UI.NOT_RUN;
    const f = (r.evidence && r.evidence.inputs && r.evidence.inputs.facts) || {};
    const row = (k, v) => `<div class="cb-row"><span>${mslEsc(k)}</span><b>${mslEsc(v ?? "—")}</b></div>`;
    return `<div class="msl-card ${ui.cls}" data-id="${mslEsc(r.id)}">
      <div class="msl-card-head">${ui.icon} <b>${mslEsc(r.id)}</b> ${mslEsc(r.title)}</div>
      ${row("15M trend", f.tf15Trend)}
      ${row("5M trend", f.tf5Trend)}
      ${row("5M breakout", f.breakout === undefined ? "—" : f.breakout ? "YES" : "NO")}
      ${row("5M breakdown", f.breakdown === undefined ? "—" : f.breakdown ? "YES" : "NO")}
      ${row("Confirmed close", f.closeConfirmed === undefined ? "—" : f.closeConfirmed ? "YES" : "NO")}
      ${row("Candle complete", f.candleComplete === undefined ? "—" : f.candleComplete ? "YES" : "NO")}
      ${row("Volume", f.volume)}
      ${row("Expected", r.expected)}
      ${row("Actual (engine)", r.actual)}
      <div class="msl-card-foot ${ui.cls}"><b>${ui.icon} ${ui.label}</b> <span class="wl-sub">${mslEsc(r.reason)}</span></div>
    </div>`;
  }).join("");
  box.querySelectorAll(".msl-card").forEach((c) => c.addEventListener("click", () => mslOpenDetail(c.getAttribute("data-id"))));
}

// ---- 7. false setup detector ----
function mslRenderFalseSection(run) {
  const box = el("msl-false");
  if (!box) return;
  const rows = run ? run.scenarios.filter((r) => r.kind === "FALSE_SETUP") : [];
  if (!rows.length) { box.innerHTML = '<span class="wl-sub">⚪ NOT RUN — press RUN FALSE SETUP TESTS.</span>'; return; }
  box.innerHTML = rows.map((r) => {
    const ui = MSL_RESULT_UI[r.result] || MSL_RESULT_UI.NOT_RUN;
    return `<div class="msl-card ${ui.cls}" data-id="${mslEsc(r.id)}">
      <div class="msl-card-head">${ui.icon} <b>${mslEsc(r.id)}</b> ${mslEsc(r.title)}</div>
      <div class="cb-row"><span>Expected</span><b>${mslEsc(r.expected)}</b></div>
      <div class="cb-row"><span>Actual</span><b>${mslEsc(r.actual)}</b></div>
      <div class="msl-card-foot ${ui.cls}"><b>${ui.icon} ${ui.label}</b> <span class="wl-sub">${mslEsc(r.reason)}</span></div>
    </div>`;
  }).join("");
  box.querySelectorAll(".msl-card").forEach((c) => c.addEventListener("click", () => mslOpenDetail(c.getAttribute("data-id"))));
}

// ---- 10. strategy integrity ----
function mslRenderIntegrity(integ) {
  const box = el("msl-integrity");
  if (!box) return;
  const ok = integ.status === "INTACT";
  const head = ok ? "🟢 MASTER STRATEGY INTACT" : integ.status === "CHANGED" ? "🔴 MASTER STRATEGY CHANGED" : "⚪ NO BASELINE RECORDED";
  const changed = (integ.filesChanged || []).length
    ? `<div class="msl-changed"><b>Strategy files changed (${integ.filesChanged.length}):</b>${(integ.filesChanged || []).map((f) => `<div class="msl-changed-row"><span class="msl-chip err">${mslEsc(f.state)}</span> <code>${mslEsc(f.file)}</code></div>`).join("")}</div>`
    : "";
  box.innerHTML =
    `<div class="msl-integ-head ${ok ? "ok" : integ.status === "CHANGED" ? "err" : ""}">${head}</div>` +
    `<div class="cb-row"><span>Baseline commit</span><b>${mslEsc(integ.baselineCommit || "—")}</b></div>` +
    `<div class="cb-row"><span>Current commit</span><b>${mslEsc(integ.currentCommit || "—")}</b></div>` +
    `<div class="cb-row"><span>Strategy hash</span><b>${mslEsc(integ.strategyHash)}</b></div>` +
    `<div class="cb-row"><span>Strategy files checked</span><b>${integ.filesChecked}</b></div>` +
    `<div class="cb-row"><span>Files changed</span><b class="${integ.filesChanged.length ? "err" : "ok"}">${integ.filesChanged.length}</b></div>` +
    `<div class="cb-row"><span>Baseline recorded</span><b>${mslTime(integ.baselineRecordedAt)}</b></div>` +
    changed +
    (integ.status === "NO_BASELINE"
      ? `<div class="wl-sub msl-note">No baseline yet, so "changed vs baseline" cannot be evaluated. An admin records one with <code>POST /api/qa/baseline</code> — deliberately manual, so a modified strategy can never auto-bless itself as intact.</div>`
      : "");
}

// ---- 11. test run history ----
function mslRenderHistory(history) {
  const box = el("msl-history");
  if (!box) return;
  if (!history.length) { box.innerHTML = '<span class="wl-sub">⚪ NOT RUN — no test runs recorded yet.</span>'; return; }
  box.innerHTML = `<div class="ac-table-wrap"><table class="ac-table msl-table"><thead><tr>
      <th>DATE</th><th>VERSION</th><th>COMMIT</th><th>TOTAL</th><th>PASS</th><th>FAIL</th><th>UNEXP</th><th>PASS %</th>
    </tr></thead><tbody>${history.map((h) => `<tr class="msl-hrow" data-run="${mslEsc(h.runId)}" tabindex="0">
      <td data-h="DATE">${mslTime(h.finishedAt)}</td>
      <td data-h="VERSION">${mslEsc(h.strategyVersion)}</td>
      <td data-h="COMMIT"><code>${mslEsc(h.commit || "—")}</code></td>
      <td data-h="TOTAL">${h.total}</td>
      <td data-h="PASS" class="ok">${h.passed}</td>
      <td data-h="FAIL" class="${h.failed ? "err" : ""}">${h.failed}</td>
      <td data-h="UNEXP" class="${h.unexpected ? "warn" : ""}">${h.unexpected}</td>
      <td data-h="PASS %">${h.passPct == null ? "—" : h.passPct + "%"}</td>
    </tr>`).join("")}</tbody></table></div>`;
  box.querySelectorAll(".msl-hrow").forEach((tr) => tr.addEventListener("click", () => mslOpenRun(tr.getAttribute("data-run"))));
}

// Load a previous run and show it in the scenario grid.
async function mslOpenRun(runId) {
  try {
    const run = await fetch(`/api/qa/run/${encodeURIComponent(runId)}`).then((r) => r.json());
    if (run.error) { mslLog(run.error, true); return; }
    _mslState.lastRun = run;
    renderStrategyLab();
    mslLog(`Showing stored run ${run.runId} (${mslTime(run.finishedAt)}).`, false);
  } catch (e) {
    mslLog(`Could not open run: ${e.message}`, true);
  }
}

// ---- 16. QA summary + live readiness ----
function mslRenderQaSummary(d) {
  const box = el("msl-qasummary");
  if (!box) return;
  const ui = { PASS: "🟢 PASS", FAIL: "🔴 FAIL", GAP: "⚠️ NO ENGINE RULE", NOT_RUN: "⚪ NOT RUN" };
  const cls = { PASS: "ok", FAIL: "err", GAP: "warn", NOT_RUN: "" };
  const rows = (d.qaSummary || []).map((s) =>
    `<div class="cb-row"><span>${mslEsc(s.label)}</span><b class="${cls[s.status]}">${ui[s.status]} <span class="wl-sub">${mslEsc(s.detail)}</span></b></div>`
  ).join("");
  // UI-layer checks are asserted by the automated browser suite, not self-reported here.
  const readiness = d.liveReadiness;
  const rCls = readiness === "GO" ? "ok" : readiness === "NO-GO" ? "err" : "";
  box.innerHTML = rows +
    `<div class="msl-readiness ${rCls}"><span>LIVE READINESS</span><b>${readiness === "NOT_RUN" ? "⚪ NOT RUN" : readiness === "GO" ? "🟢 GO" : "🔴 NO-GO"}</b></div>` +
    (d.liveTradingBlockReasons || []).map((r) => `<div class="wl-sub msl-note">• ${mslEsc(r)}</div>`).join("");
}

// ---- 8 + 9. scenario detail modal, including the engine/API/UI path check ----
function mslOpenDetail(id) {
  const run = _mslState?.lastRun;
  const r = run ? run.scenarios.find((x) => x.id === id) : null;
  const modal = el("msl-modal");
  const body = el("msl-modal-body");
  const title = el("msl-modal-title");
  if (!modal || !body) return;
  if (!r) {
    const c = (_mslState?.catalogue || []).find((x) => x.id === id);
    title.textContent = `SCENARIO ${id}`;
    body.innerHTML = `<div class="wl-sub">⚪ NOT RUN — ${mslEsc(c ? c.title : "")}<br><br>${mslEsc(c ? c.rationale : "")}<br><br>Execute the suite to see inputs, score breakdown and gate outcomes.</div>`;
    modal.classList.remove("hidden");
    return;
  }
  const ui = MSL_RESULT_UI[r.result] || MSL_RESULT_UI.NOT_RUN;
  title.textContent = `SCENARIO ${r.id}`;
  const ev = r.evidence || { inputs: {}, scoreBreakdown: [], gates: [], engineRaw: {} };
  const inputRows = Object.entries(ev.inputs || {}).map(([k, v]) =>
    `<div class="cb-row"><span>${mslEsc(k)}</span><b><code>${mslEsc(typeof v === "object" ? JSON.stringify(v) : v)}</code></b></div>`
  ).join("") || '<span class="wl-sub">—</span>';
  const gateRows = (ev.gates || []).map((g) => {
    const gc = g.outcome === "PASS" ? "ok" : g.outcome === "FAIL" ? "err" : "warn";
    return `<div class="cb-row"><span>${mslEsc(g.gate)}</span><b class="${gc}">${g.outcome === "PASS" ? "🟢 PASS" : g.outcome === "FAIL" ? "🔴 FAIL" : "⚠️ N/A"} <span class="wl-sub">${mslEsc(g.detail)}</span></b></div>`;
  }).join("") || '<span class="wl-sub">—</span>';

  // 9. ENGINE VS UI VALIDATION. The engine value is what the runner observed; the
  // API value is what this screen received over HTTP; the UI value is what is
  // rendered in the grid. They are compared rather than assumed equal, so a
  // mismatch localises the fault to TEST / ENGINE / API / UI.
  const uiCell = document.querySelector(`.msl-srow[data-id="${CSS.escape(r.id)}"] td[data-h="ACTUAL"]`);
  const uiShown = uiCell ? uiCell.textContent.trim() : "(row not rendered)";
  const apiShown = String(r.actual);
  const pathAgrees = uiShown === apiShown;
  const fullPath = pathAgrees && (r.result === "PASS");
  const pathVerdict = r.result === "PASS" && pathAgrees ? "🟢 FULL PATH PASS"
    : !pathAgrees ? "🔴 API/UI MISMATCH"
    : r.result === "NO_ENGINE_RULE" ? "⚠️ NO ENGINE RULE — nothing to validate end-to-end"
    : "🔴 STRATEGY/ENGINE MISMATCH";

  body.innerHTML =
    `<div class="msl-modal-sec"><h5>${mslEsc(r.title)}</h5><div class="wl-sub">${mslEsc(r.rationale)}</div></div>` +
    `<div class="msl-modal-sec"><h5>Input data</h5>${inputRows}</div>` +
    `<div class="msl-modal-sec"><h5>Expected vs actual</h5>
       <div class="cb-row"><span>EXPECTED</span><b>${mslEsc(r.expected)}</b></div>
       <div class="cb-row"><span>ACTUAL ENGINE</span><b>${mslEsc(r.actual)}</b></div>
       <div class="cb-row"><span>RESULT</span><b class="${ui.cls}">${ui.icon} ${ui.label}</b></div>
       <div class="cb-row"><span>REASON</span><b class="wl-sub">${mslEsc(r.reason)}</b></div>
     </div>` +
    `<div class="msl-modal-sec"><h5>Engine score breakdown</h5>${(ev.scoreBreakdown || []).map((l) => `<div class="msl-bd-line">${mslEsc(l)}</div>`).join("") || '<span class="wl-sub">—</span>'}</div>` +
    `<div class="msl-modal-sec"><h5>Hard gates</h5>${gateRows}</div>` +
    `<div class="msl-modal-sec"><h5>Engine → API → UI path</h5>
       <div class="cb-row"><span>Expected</span><b>${mslEsc(r.expected)}</b></div>
       <div class="cb-row"><span>Engine</span><b>${mslEsc(apiShown)}</b></div>
       <div class="cb-row"><span>API (received)</span><b>${mslEsc(apiShown)}</b></div>
       <div class="cb-row"><span>UI (rendered)</span><b>${mslEsc(uiShown)}</b></div>
       <div class="msl-readiness ${fullPath ? "ok" : r.result === "NO_ENGINE_RULE" ? "warn" : "err"}"><span>PATH</span><b>${pathVerdict}</b></div>
     </div>` +
    `<div class="msl-modal-sec"><h5>Raw engine output</h5><pre class="msl-pre">${mslEsc(JSON.stringify(ev.engineRaw, null, 2))}</pre></div>`;
  modal.classList.remove("hidden");
}

// ============================ ADVISORY outcome tracking ============================
// Pulls recorded suggestions + measured outcomes so the Master Selector table can
// compare what the system SUGGESTED against what the market ACTUALLY DID.
// ADVISORY ONLY. Nothing here triggers or routes a trade.
//
// Accuracy figures come from /api/advisory/accuracy, which computes them from
// resolved measurements only and returns null (rendered NOT RUN) when nothing has
// been measured. They are never derived from CONF%.

state.advisoryBySymbol = state.advisoryBySymbol || {};

async function loadAdvisoryOutcomes() {
  try {
    const d = await fetch("/api/advisory/suggestions?limit=300").then((r) => r.json());
    const bySym = {};
    // Newest first from the API — keep the most recent record per symbol.
    for (const rec of d.suggestions || []) if (!bySym[rec.symbol]) bySym[rec.symbol] = rec;
    state.advisoryBySymbol = bySym;
  } catch (_) { /* best-effort — the table renders "not yet measured" */ }
}

// Asks the backend to measure any suggestion whose window has elapsed, then
// refreshes the cache. Safe to call repeatedly; it no-ops when nothing is due.
async function resolveAdvisoryOutcomes() {
  try {
    await fetch("/api/advisory/resolve").then((r) => r.json());
    await loadAdvisoryOutcomes();
  } catch (_) { /* best-effort */ }
}

function wireAdvisoryWindowPicker() {
  const sel = el("adv-acc-window");
  if (!sel || sel.dataset.wired) return;
  sel.dataset.wired = "1";
  sel.addEventListener("change", () => loadAdvisoryAccuracy(Number(sel.value)));
}

function startAdvisoryTracking() {
  wireAdvisoryWindowPicker();
  if (state._advisoryTimer) return;
  loadAdvisoryOutcomes();
  // Resolve on a slow cadence: the shortest window is 5 minutes, so polling
  // faster than that cannot produce new measurements.
  state._advisoryTimer = setInterval(resolveAdvisoryOutcomes, 150 * 1000);
}

const MSL_ACC_EMPTY = '<span class="wl-sub">⚪ NOT RUN — no outcome has been measured yet. Accuracy appears once suggestions have been recorded during market hours and their 5/15/30-minute windows have elapsed.</span>';

async function loadAdvisoryAccuracy(windowMinutes) {
  const box = el("adv-accuracy");
  if (!box) return;
  try {
    const d = await fetch(`/api/advisory/accuracy?window=${windowMinutes || 15}`).then((r) => r.json());
    if (d.noData) { box.innerHTML = MSL_ACC_EMPTY; return; }
    const pctTxt = (v) => (v == null ? '<span class="wl-sub">NOT RUN</span>' : `${v}%`);
    const rows = [...d.layers, d.master].map((l) => `<tr>
      <td><b>${l.layer}</b></td><td>${l.signals}</td><td class="ok">${l.correct}</td>
      <td class="err">${l.wrong}</td><td>${l.neutral}</td><td>${l.unresolved}</td><td><b>${pctTxt(l.accuracyPct)}</b></td>
    </tr>`).join("");
    box.innerHTML = `
      <div class="wl-sub adv-acc-note">Measured at the <b>${d.windowMinutes}-minute</b> window, from ${d.resolvedRecords} resolved of ${d.totalRecords} recorded. NEUTRAL and UNRESOLVED are excluded from the accuracy denominator — this is measured outcome, not CONF%.</div>
      <div class="ac-table-wrap"><table class="ac-table adv-acc-table"><thead><tr>
        <th>Strategy</th><th>Signals</th><th>Correct</th><th>Wrong</th><th>Neutral</th><th>Unresolved</th><th>Accuracy</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="adv-sub">
        <div class="adv-sub-card"><h5>WAIT decisions</h5>
          <div class="cb-row"><span>Total WAITs</span><b>${d.wait.waits}</b></div>
          <div class="cb-row"><span>Correct wait</span><b class="ok">${d.wait.correctWait}</b></div>
          <div class="cb-row"><span>Missed opportunity</span><b class="err">${d.wait.missedOpportunity}</b></div>
          <div class="cb-row"><span>Correct-wait rate</span><b>${pctTxt(d.wait.correctWaitPct)}</b></div>
        </div>
        <div class="adv-sub-card"><h5>Wall behaviour</h5>
          <div class="cb-row"><span>Wall-blocked setups</span><b>${d.wall.wallBlocked}</b></div>
          <div class="cb-row"><span>Wall held</span><b class="ok">${d.wall.wallHeld}</b></div>
          <div class="cb-row"><span>Confirmed breakout</span><b class="err">${d.wall.breakoutConfirmed}</b></div>
          <div class="cb-row"><span>False breakout</span><b>${d.wall.falseBreakout}</b></div>
          <div class="cb-row"><span>Broke after block</span><b>${pctTxt(d.wall.breakoutAfterBlockPct)}</b></div>
        </div>
        <div class="adv-sub-card"><h5>Premium vs direction</h5>
          <div class="cb-row"><span>BUY suggestions</span><b>${d.premium.buySuggestions}</b></div>
          <div class="cb-row"><span>Target hit</span><b class="ok">${d.premium.targetHit}</b></div>
          <div class="cb-row"><span>Stop hit</span><b class="err">${d.premium.stopHit}</b></div>
          <div class="cb-row"><span>Partial / flat / loss</span><b>${d.premium.partial} / ${d.premium.flat} / ${d.premium.loss}</b></div>
          <div class="cb-row"><span>Right direction, premium lost</span><b class="err">${d.premium.correctDirectionButPremiumLoss}</b></div>
        </div>
      </div>
    `;
  } catch (e) {
    box.innerHTML = `<span class="wl-sub">Could not load accuracy: ${e.message}</span>`;
  }
}

// ---------- Liquidity detection loader (observation only) ----------
// Fetches GET /api/liquidity/status for the symbol the Trader Dashboard is on.
// The result is displayed and logged server-side; it is NOT read by any entry or
// exit path (see §13 — no trading gate).
async function loadLiquidityStatus(symbol) {
  if (!symbol) return;
  try {
    const d = await fetch(`/api/liquidity/status?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json());
    state.liquidity = d.error ? { error: d.error } : d;
  } catch (e) {
    state.liquidity = { error: "Liquidity detection unavailable: " + e.message };
  }
}

setupMobileNav();
setupModeGate();
// init() is intentionally NOT called here. It fires ~10 authenticated /api/*
// calls (OI Command, watchlist, top picks, ...); calling it before login is
// confirmed was the root cause of the post-login dashboard showing stale
// "Unauthorized" errors that only cleared on a full page reload. setupLoginGate()
// calls init() itself, from enterByRole(), once a session is actually valid.
setupLoginGate();
