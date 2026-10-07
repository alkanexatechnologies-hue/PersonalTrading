// ============================================================================
// MARKET COMMAND SUMMARY — one-screen summary opened from Market Command.
// Uses ONLY the app's existing endpoints / Dhan connection (no second integration):
//   /api/market-command   chart candles, EMA/VWAP overlays, structure, levels,
//                         option chain + matrix (LTP/OI/IV/Greeks), market view,
//                         trade plan, confirmation flow, VIX
//   /api/market-analysis  expected move 5m/15m (model), per-strike premium moves,
//                         top movers, gamma / spike states, direction
//   /api/option-candles   CE / PE premium candles (same path as Option Terminal)
//   /api/quotes           index tickers
// Nothing is invented: a value the existing engines do not produce is shown as
// DATA UNAVAILABLE / NOT CALCULATED. Advisory only — no orders.
// ============================================================================
const MCS = {
  sym: "^NSEI", tf: "5m", init: false, timer: null, busy: false,
  d: null, ma: null, q: null, opt: { CE: null, PE: null }, optKey: null,
  chart: null, series: {}, ce: null, pe: null, show: { ema9: true, ema21: true, ema50: true, ema200: false, vwap: true, levels: true, bos: true, ob: true, vol: true, zones: false, ntz: true },
  maAt: 0, optAt: 0, hmMode: "oiChg", hmSide: "CE", selStrike: null,   // null = follow the current ATM strike
  // LIVE = today, auto-refresh. TEST = re-run the logic on a past date (as of a time); live refresh stops.
  mode: "LIVE", gen: 0, test: { date: null, upto: "15:15" },
  play: { on: false, speedMs: 2000, token: 0 }, _hist: new Map(),   // full-session replay; day chart cache (sym|tf|date)
};
const MCS_SYMS = [["^NSEI", "NIFTY 50"], ["^NSEBANK", "BANKNIFTY"], ["^CNXFIN", "FINNIFTY"], ["^BSESN", "SENSEX"], ["^NSEMDCP50", "MIDCPNIFTY"]];
const mcsEl = (id) => document.getElementById(id);
const mcsEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mcsN = (v, d = 2) => (v == null || !isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const mcsL = (v) => { if (v == null || !isFinite(v)) return "—"; const a = Math.abs(v), s = v < 0 ? "-" : ""; return a >= 1e7 ? s + (a / 1e7).toFixed(2) + "Cr" : a >= 1e5 ? s + (a / 1e5).toFixed(1) + "L" : a >= 1e3 ? s + (a / 1e3).toFixed(1) + "K" : s + Math.round(a); };
const mcsPct = (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%");
const mcsCls = (v) => (v == null ? "" : v > 0 ? "mcs-up" : v < 0 ? "mcs-dn" : "");
const mcsIstDay = (t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const mcsHm = (t) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const mcsT = (t) => t + 19800;   // IST wall clock on the chart axis
const UNAV = '<span class="mcs-na">DATA UNAVAILABLE</span>';

function mcsEma(vals, p) { const out = new Array(vals.length).fill(null); if (vals.length < p) return out; const k = 2 / (p + 1); let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p; out[p - 1] = e; for (let i = p; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; } return out; }
function mcsVwap(c) { const out = []; let pv = 0, vv = 0, day = ""; for (const x of c) { const d = mcsIstDay(x.time); if (d !== day) { day = d; pv = 0; vv = 0; } const tp = (x.high + x.low + x.close) / 3; pv += tp * (x.volume || 0); vv += x.volume || 0; out.push(vv > 0 ? pv / vv : null); } return out; }
// Finished candles only: drop the last candle while it is still forming (LIVE). Testing data is already cut at "as of".
function mcsClosed(cs) {
  if (!cs || !cs.length) return [];
  const tfSec = { "5m": 300, "15m": 900, "30m": 1800, "60m": 3600 }[MCS.tf] || 300;
  return cs[cs.length - 1].time + tfSec > Date.now() / 1000 ? cs.slice(0, -1) : cs;
}
function mcsAtr(c, p = 14) { if (c.length <= p) return null; const tr = c.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : x.high - x.low)); let a = tr.slice(1, p + 1).reduce((s, v) => s + v, 0) / p; for (let i = p + 1; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p; return a; }

function mcsShell() {
  const root = mcsEl("mcs-root"); if (!root) return;
  root.innerHTML = `
  <div class="mcs-head">
    <button class="mcs-back" id="mcs-back" title="Back to Market Command">← Market Command</button>
    <div class="mcs-title">MARKET COMMAND SUMMARY <span class="mcs-mode">Intraday</span></div>
    <button class="mcs-back mc2-summary-btn" type="button" onclick="if (typeof switchTab === 'function') switchTab('liquidityanalysis')" title="Liquidity Analysis — morning liquidity plan and 20-day history (research only)">💧 LIQUIDITY ANALYSIS</button>
    <div class="mcs-quote" id="mcs-quote"></div>
    <div class="mcs-tickers" id="mcs-tickers"></div>
  </div>
  <div class="mcs-bar">
    <div class="mcs-chips" id="mcs-syms">${MCS_SYMS.map(([s, n]) => `<button class="mcs-chip${s === MCS.sym ? " on" : ""}" data-sym="${s}">${n}</button>`).join("")}</div>
    <div class="mcs-modes" id="mcs-modes"><button type="button" data-mode="LIVE" class="on">🟢 LIVE</button><button type="button" data-mode="TEST">🧪 TESTING</button></div>
    <div class="mcs-meta" id="mcs-meta"></div>
  </div>
  <div class="mcs-testbar" id="mcs-testbar" hidden>
    <b>🧪 TESTING MODE</b> <span class="mcs-sub">re-run the logic on a past day — live updates are paused</span>
    <label>Date <input type="date" id="mcs-tdate"></label>
    <label>As of <select id="mcs-tupto"></select></label>
    <button type="button" class="mcs-tstep" data-step="-1" title="5 minutes earlier">◀ 5m</button>
    <button type="button" class="mcs-tstep" data-step="1" title="5 minutes later">5m ▶</button>
    <button type="button" class="mcs-trun" id="mcs-trun">▶ Run</button>
    <span class="mcs-tsep"></span>
    <button type="button" class="mcs-tplay" id="mcs-tplay" title="Replay the whole session 09:15 → 15:15, one 5-minute candle at a time">⏵ Play full session</button>
    <button type="button" id="mcs-tstop" title="Stop the replay">⏹ Stop</button>
    <label>Speed <select id="mcs-tspeed"><option value="1000">Fast (1s / candle)</option><option value="2000" selected>Normal (2s / candle)</option><option value="4000">Slow (4s / candle)</option></select></label>
    <div class="mcs-tprog" id="mcs-tprog" title="Session progress 09:15 → 15:15"><i id="mcs-tprogbar"></i><span id="mcs-tprogtxt">09:15</span></div>
    <span class="mcs-tstat" id="mcs-tstat"></span>
  </div>
  <div class="mcs-top">
    <section class="mcs-card mcs-chartcard">
      <div class="mcs-chhead">
        <b id="mcs-chname">NIFTY 50 (Spot)</b><span class="mcs-sub" id="mcs-ohlc"></span>
        <div class="mcs-tfs" id="mcs-tfs">${["5m", "15m", "30m", "60m"].map((t) => `<button class="mcs-tf${t === MCS.tf ? " on" : ""}" data-tf="${t}">${t === "60m" ? "1h" : t}</button>`).join("")}</div>
      </div>
      <div class="mcs-toggles" id="mcs-toggles">${[["ema9", "EMA 9"], ["ema21", "EMA 21"], ["ema50", "EMA 50"], ["ema200", "EMA 200"], ["vwap", "VWAP"], ["bos", "BOS/CHoCH"], ["ob", "OB"], ["levels", "S/R + ORB + Liquidity"], ["zones", "S/R zones"], ["ntz", "No-Trade Zone"], ["vol", "Volume"]].map(([k, n]) => `<label class="mcs-tg"><input type="checkbox" data-k="${k}" ${MCS.show[k] ? "checked" : ""}> ${n}</label>`).join("")}</div>
      <div class="mcs-chart" id="mcs-chart"></div>
    </section>
    <section class="mcs-card mcs-lvtable" id="mcs-lvtable"></section>
    <section class="mcs-card mcs-optlv" id="mcs-optlv"></section>
  </div>
  <div class="mcs-keyrow" id="mcs-keyrow"></div>
  <section class="mcs-card mcs-setups" id="mcs-setups"></section>
  <section class="mcs-card mcs-testlog" id="mcs-testlog" hidden></section>
  <section class="mcs-card mcs-analysis" id="mcs-analysis"></section>
  <section class="mcs-card mcs-fast" id="mcs-fast"></section>
  <div class="mcs-grid2">
    <section class="mcs-card mcs-strikes" id="mcs-strikes"></section>
    <section class="mcs-card mcs-optcard" id="mcs-optCE"></section>
    <section class="mcs-card mcs-optcard" id="mcs-optPE"></section>
  </div>
  <div class="mcs-grid3">
    <section class="mcs-card" id="mcs-next5"></section>
    <section class="mcs-card" id="mcs-next15"></section>
    <section class="mcs-card mcs-movers" id="mcs-movers"></section>
  </div>
  <div class="mcs-grid4">
    <section class="mcs-card mcs-chain" id="mcs-chain"></section>
    <section class="mcs-card" id="mcs-topmove"></section>
    <section class="mcs-card mcs-cmd" id="mcs-cmd"></section>
  </div>
  <div class="mcs-foot">Data: existing Dhan connection (Market Command, Market Analysis, Option Terminal endpoints). Expected moves, delta/gamma projections and spike triggers are model estimates, not guarantees. Advisory only — no orders are placed.</div>`;
  mcsEl("mcs-back").onclick = () => { if (typeof switchTab === "function") switchTab("marketcommand"); };
  // ---- LIVE / TESTING mode ----
  root.querySelectorAll("#mcs-modes button").forEach((b) => (b.onclick = () => mcsSetMode(b.dataset.mode)));
  const sel = mcsEl("mcs-tupto");
  if (sel) { const opts = []; for (let m = 9 * 60 + 20; m <= 15 * 60 + 15; m += 5) opts.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); sel.innerHTML = opts.map((t) => `<option value="${t}"${t === "15:15" ? " selected" : ""}>${t === "15:15" ? "15:15 (full day)" : t}</option>`).join(""); sel.onchange = () => { mcsPlayStop(); MCS.test.upto = sel.value; mcsRefresh(true); }; }
  const dt = mcsEl("mcs-tdate");
  if (dt) { dt.max = new Date(Date.now() + 19800000).toISOString().slice(0, 10); dt.onchange = () => { if (dt.value) { mcsPlayStop(); MCS.test.date = dt.value; MCS._fit = null; mcsRefresh(true); } }; }
  root.querySelectorAll(".mcs-tstep").forEach((b) => (b.onclick = () => { mcsPlayStop(); const o = [...sel.options].map((x) => x.value); const i = Math.max(0, Math.min(o.length - 1, o.indexOf(MCS.test.upto) + Number(b.dataset.step))); MCS.test.upto = o[i]; sel.value = o[i]; mcsRefresh(true); }));
  const run = mcsEl("mcs-trun"); if (run) run.onclick = () => { mcsPlayStop(); mcsRefresh(true); };
  const pl = mcsEl("mcs-tplay"); if (pl) pl.onclick = () => (MCS.play.on ? mcsPlayStop("Paused") : mcsPlayStart());
  const stp = mcsEl("mcs-tstop"); if (stp) stp.onclick = () => mcsPlayStop("Stopped");
  const spd = mcsEl("mcs-tspeed"); if (spd) spd.onchange = () => { MCS.play.speedMs = Number(spd.value) || 2000; };
  root.querySelectorAll("#mcs-syms .mcs-chip").forEach((b) => (b.onclick = () => { mcsPlayStop(); MCS.gen++; MCS.sym = b.dataset.sym; root.querySelectorAll("#mcs-syms .mcs-chip").forEach((x) => x.classList.toggle("on", x === b)); MCS.d = null; MCS.ss = null; MCS.ma = null; MCS.maAt = 0; MCS.optKey = null; MCS._fit = null; MCS.selStrike = null; mcsUnlockHeights(); mcsLoading(); mcsRefresh(true); }));
  root.querySelectorAll("#mcs-tfs .mcs-tf").forEach((b) => (b.onclick = () => { mcsPlayStop(); MCS.gen++; MCS.tf = b.dataset.tf; root.querySelectorAll("#mcs-tfs .mcs-tf").forEach((x) => x.classList.toggle("on", x === b)); MCS._fit = null; mcsUnlockHeights(); mcsRefresh(true); }));
  root.querySelectorAll("#mcs-toggles input").forEach((c) => (c.onchange = () => { MCS.show[c.dataset.k] = c.checked; mcsRenderChart(); }));
}

function mcsLoading() { const n = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym; const m = mcsEl("mcs-meta"); if (m) m.innerHTML = `<span class="mcs-warn">⏳ Loading ${mcsEsc(n)}…</span>`; }

// Shaded S/R zones drawn as an HTML layer over a lightweight-chart (the library has
// no rectangles). Support = green band, resistance = red band, No-Trade Zone = amber.
// Re-positioned on scroll / zoom / resize / crosshair so bands stay glued to price.
function mcsZoneLayer(host, ch, series) {
  host.style.position = "relative";
  const layer = document.createElement("div"); layer.className = "mcs-zones"; host.appendChild(layer);
  const z = { layer, ch, series, zones: [], raf: 0 };
  const draw = () => { z.raf = 0; if (!z.disposed) mcsDrawZones(z); };
  z.redraw = () => { if (!z.raf && !z.disposed) z.raf = requestAnimationFrame(draw); };
  ch.timeScale().subscribeVisibleLogicalRangeChange(z.redraw);
  ch.subscribeCrosshairMove(z.redraw);
  try { z.ro = new ResizeObserver(z.redraw); z.ro.observe(host); } catch (_) {}
  return z;
}
function mcsDrawZones(z) {
  if (!z || !z.layer || z.disposed) return;
  let w = 0; try { w = z.ch.timeScale().width(); } catch (_) {}
  z.layer.style.width = (w || z.layer.parentElement.clientWidth) + "px";
  z.layer.innerHTML = z.zones.map((b) => {
    const y1 = z.series.priceToCoordinate(b.hi), y2 = z.series.priceToCoordinate(b.lo);
    if (y1 == null || y2 == null) return "";
    const top = Math.min(y1, y2), h = Math.max(3, Math.abs(y2 - y1));
    return `<div class="mcs-zone ${b.kind}" style="top:${top.toFixed(1)}px;height:${h.toFixed(1)}px">${b.label ? `<span>${mcsEsc(b.label)}</span>` : ""}</div>`;
  }).join("");
}
function mcsSetZones(z, zones) { if (!z) return; z.zones = zones; mcsDrawZones(z); }

// Keep the screen still on refresh: remember every scroll position (page + inner
// lists) and never let a card shrink while data updates (no jump up / down).
function mcsStable(fn) {
  const root = mcsEl("mcs-root"); if (!root) return fn();
  const scrollers = []; for (let n = root.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 1) scrollers.push([n, n.scrollTop]);
  const se = document.scrollingElement; const pageY = se ? se.scrollTop : 0;
  const inner = [...root.querySelectorAll(".mcs-tblwrap:not(.mcs-strikelist), .mcs-ladder")].map((e) => [e.closest("[id]")?.id + "|" + [...(e.closest("[id]")?.querySelectorAll(".mcs-tblwrap:not(.mcs-strikelist), .mcs-ladder") || [])].indexOf(e), e.scrollTop, e.scrollLeft]);
  root.querySelectorAll(".mcs-card").forEach((c) => { const h = c.offsetHeight; if (h > (parseFloat(c.style.minHeight) || 0)) c.style.minHeight = h + "px"; });
  try { fn(); } finally {
    inner.forEach(([k, t, l]) => { const [id, i] = k.split("|"); const host = document.getElementById(id); const e = host?.querySelectorAll(".mcs-tblwrap:not(.mcs-strikelist), .mcs-ladder")[+i]; if (e) { e.scrollTop = t; e.scrollLeft = l; } });
    scrollers.forEach(([n, t]) => { if (n.scrollTop !== t) n.scrollTop = t; });
    if (se && se.scrollTop !== pageY) se.scrollTop = pageY;
  }
}
function mcsUnlockHeights() { document.querySelectorAll("#mcs-root .mcs-card").forEach((c) => (c.style.minHeight = "")); }

function mcsBuildChart() {
  const c = mcsEl("mcs-chart"); if (!c || typeof LightweightCharts === "undefined") return;
  if (MCS.chart) { try { MCS.chart.remove(); } catch (_) {} }
  // Same chart as Market Command (TradingView dark theme, crosshair, scales, series colours).
  const ch = LightweightCharts.createChart(c, {
    width: c.clientWidth, height: c.clientHeight || 500,
    layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#b2b5be", fontSize: 12 },
    grid: { vertLines: { color: "#141c2e" }, horzLines: { color: "#141c2e" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#2a2e39" }, horzLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#2a2e39" } },
    rightPriceScale: { borderColor: "#2a2e39", scaleMargins: { top: 0.08, bottom: 0.28 } },
    timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, barSpacing: 12 },
  });
  MCS.chart = ch;
  MCS.series.c = ch.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", borderVisible: false, wickUpColor: "#16c784", wickDownColor: "#ea3943", priceLineVisible: false });
  const ln = (col, w, title) => ch.addLineSeries({ color: col, lineWidth: w, lineStyle: 0, priceLineVisible: false, lastValueVisible: !!title, title: title || "" });
  MCS.series.ema9 = ln("#3b82f6", 1, "EMA 9"); MCS.series.ema21 = ln("#f0b90b", 1, "EMA 21"); MCS.series.ema50 = ln("#a855f7", 2, "EMA 50"); MCS.series.ema200 = ln("#e056a0", 2, ""); MCS.series.vwap = ln("#22c55e", 2, "VWAP");
  MCS.series.vol = ch.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
  ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
  // Crosshair OHLC legend (as on Market Command): hovering a candle shows its O/H/L/C and time.
  ch.subscribeCrosshairMove((param) => {
    const cs = MCS.d?.candles; const o = mcsEl("mcs-ohlc"); if (!cs || !o) return;
    if (!param || !param.time) { if (MCS._ohlcHtml) o.innerHTML = MCS._ohlcHtml; return; }
    const x = cs.find((k) => mcsT(k.time) === param.time); if (!x) return;
    o.innerHTML = `<span class="mcs-sub">${mcsIstDay(x.time).slice(5)} ${mcsHm(x.time)}</span> O <b>${mcsN(x.open)}</b> H <b>${mcsN(x.high)}</b> L <b>${mcsN(x.low)}</b> C <b class="${mcsCls(x.close - x.open)}">${mcsN(x.close)}</b> Vol <b>${mcsL(x.volume)}</b>`;
  });
  MCS.series.lines = [];
  MCS.zones = mcsZoneLayer(c, ch, MCS.series.c);
  try { new ResizeObserver(() => ch.applyOptions({ width: c.clientWidth, height: c.clientHeight || 380 })).observe(c); } catch (_) {}
}

function mcsRenderChart() {
  const d = MCS.d; if (!d || !d.candles) return;
  if (!MCS.chart) mcsBuildChart();
  if (!MCS.chart) return;
  const cs = d.candles, ov = d.overlays || {};
  MCS.series.c.setData(cs.map((x) => ({ time: mcsT(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));
  const al = (arr) => cs.map((x, i) => (arr && arr[i] != null ? { time: mcsT(x.time), value: arr[i] } : null)).filter(Boolean);
  for (const k of ["ema9", "ema21", "ema50", "ema200", "vwap"]) MCS.series[k].setData(MCS.show[k] ? al(ov[k]) : []);
  MCS.series.vol.setData(MCS.show.vol ? cs.map((x) => ({ time: mcsT(x.time), value: x.volume || 0, color: x.close >= x.open ? "rgba(22,199,132,.35)" : "rgba(234,57,67,.35)" })) : []);
  MCS.series.lines.forEach((l) => { try { MCS.series.c.removePriceLine(l); } catch (_) {} }); MCS.series.lines = [];
  // same curated levels as Market Command (single source: buildMCLevels)
  const recent = cs.slice(-120); const lo = Math.min(...recent.map((x) => x.low)), hi = Math.max(...recent.map((x) => x.high)); const pad = (hi - lo) * 0.6;
  const inView = (p) => p != null && p >= lo - pad && p <= hi + pad;
  const lad = mcsSpotLadder(d);
  const want = (l) => (l.kind === "bos" || l.kind === "choch" ? MCS.show.bos : l.kind === "ind" ? false : MCS.show.levels);
  // Same list as the Levels table; indicator lines (VWAP/EMA) are drawn as series, not price lines.
  const drawn = mcsLevelList(d).filter((l) => want(l) && inView(l.price));
  const nearest = drawn.reduce((b, l) => (b == null || Math.abs(l.price - d.spot) < Math.abs(b.price - d.spot) ? l : b), null);
  drawn.forEach((l) => {
    // Market Command style: walls solid; ORB / PDH-PDL / swing / pivots / day levels dashed; nearest level thicker with ◀.
    const near = l === nearest;
    const k = l.kind === "ladder" ? l.sub : l.kind;
    const col = l.kind === "ladder" && typeof mcLevelColor === "function" ? mcLevelColor({ kind: l.sub, side: l.side }) : l.color;
    const style = k === "orb" || k === "pdhl" || k === "swing" || k === "pivot" || k === "day" || k === "pdc" ? 2 : 0;
    const short = l.kind === "ladder" ? l.chip.split(" ").slice(1).join(" ") : l.chip;
    MCS.series.lines.push(MCS.series.c.createPriceLine({ price: l.price, color: col, lineWidth: near ? 2 : 1, lineStyle: style, axisLabelVisible: true, title: `${short} ${mcsN(l.price, 2)}${near ? " ◀" : ""}` }));
  });
  // Current price: blue dashed line like Market Command.
  if (d.spot != null) MCS.series.lines.push(MCS.series.c.createPriceLine({ price: d.spot, color: "#2962ff", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" }));
  if (MCS.show.levels && lad.sl && inView(lad.sl.price)) MCS.series.lines.push(MCS.series.c.createPriceLine({ price: lad.sl.price, color: "#f97316", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "SL" }));
  if (MCS.show.ob) (d.orderBlocks || []).filter((o) => inView(o.high) || inView(o.low)).slice(-3).forEach((o) => {
    const col = o.side === "Bullish" ? "rgba(22,199,132,.6)" : "rgba(234,57,67,.6)";
    MCS.series.lines.push(MCS.series.c.createPriceLine({ price: o.high, color: col, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: `OB ${o.stage === "Confirmed" ? "" : "?"}` }));
    MCS.series.lines.push(MCS.series.c.createPriceLine({ price: o.low, color: col, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: "" }));
  });
  // shaded zones around each visible level + the engine's No-Trade Zone
  const atrZ = mcsAtr(mcsClosed(cs)) || d.spot * 0.001; const halfZ = Math.max(atrZ * 0.12, d.spot * 0.00025);
  const zones = MCS.show.zones ? [...lad.res, ...lad.sup].filter((l) => want(l) && inView(l.price)).map((l) => ({ lo: l.price - halfZ, hi: l.price + halfZ, kind: l.side === "resistance" ? "res" : "sup" })) : [];
  const ntz = MCS.ma?.noTradeZone;
  if (MCS.show.ntz && ntz?.active && ntz.low != null && ntz.high != null) zones.push({ lo: ntz.low, hi: ntz.high, kind: "ntz", label: `NO TRADE ZONE ${mcsN(ntz.low)} – ${mcsN(ntz.high)}` });
  mcsSetZones(MCS.zones, zones);
  const mk = MCS.show.bos ? (d.structure?.bosEvents || []).map((b) => ({ time: mcsT(b.time), position: b.direction === "Bullish" ? "belowBar" : "aboveBar", color: b.direction === "Bullish" ? "#16c784" : "#ea3943", shape: b.stage === "Pre" ? "circle" : b.direction === "Bullish" ? "arrowUp" : "arrowDown", text: b.stage === "Pre" ? "BOS?" : "BOS" })) : [];
  const ssig = MCS.ss && MCS.ss.symbol === MCS.sym && MCS.ss.today ? MCS.ss.today.signals.filter((x) => !x.blockedBy) : [];
  if (MCS.tf === "5m") for (const x of ssig) if (cs.some((k) => k.time === x.barTime)) mk.push({ time: mcsT(x.barTime), position: x.side === "CE" ? "belowBar" : "aboveBar", color: x.side === "CE" ? "#22c55e" : "#ef4444", shape: x.side === "CE" ? "arrowUp" : "arrowDown", text: `${{ S3_LEVEL_REJECTION: "S3", S4_VWAP_PULLBACK: "S4", S5_EMA_TREND: "S5" }[x.setup] || ""} ${x.side}` });
  if (MCS.show.levels) {
    const t0 = cs.length ? mcsIstDay(cs[cs.length - 1].time) : null;
    (d.structure?.swingPoints || []).filter((p) => mcsIstDay(p.time) === t0 && cs.some((x) => x.time === p.time)).slice(-6).forEach((p) => {
      const hi = p.type === "HH" || p.type === "LH";
      mk.push({ time: mcsT(p.time), position: hi ? "aboveBar" : "belowBar", color: "#c084fc", shape: hi ? "arrowDown" : "arrowUp", text: `${hi ? "SW H" : "SW L"} ${mcsN(p.price, 0)}` });
    });
  }
  try { MCS.series.c.setMarkers(mk.sort((a, b) => a.time - b.time)); } catch (_) {}
  const key = MCS.sym + MCS.tf + MCS.mode + (MCS.mode === "TEST" ? MCS.test.date : "");
  if (MCS._fit !== key) {
    // Open on TODAY's session (as in the design); fall back to the last ~110 bars early in the day.
    const tday = mcsIstDay(cs[cs.length - 1].time), first = cs.findIndex((x) => mcsIstDay(x.time) === tday);
    const from = first >= 0 && cs.length - first >= 6 ? Math.max(0, first - 1) : Math.max(0, cs.length - 110);
    MCS.chart.timeScale().setVisibleLogicalRange({ from, to: cs.length + 3 }); MCS._fit = key;
  }
  const last = cs[cs.length - 1];
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  mcsEl("mcs-chname").textContent = `${nm} ${MCS.tf === "60m" ? "1 Hour" : parseInt(MCS.tf, 10) + " Min"}`;
  // Day OHLC + change vs previous close (as in the design); last candle time for freshness.
  const ss = mcsSessionStats(); const dchg = ss && ss.prevClose != null ? ss.close - ss.prevClose : null;
  mcsEl("mcs-ohlc").innerHTML = MCS._ohlcHtml = ss ? `O <b>${mcsN(ss.open)}</b> H <b>${mcsN(ss.high)}</b> L <b>${mcsN(ss.low)}</b> C <b class="${mcsCls(dchg)}">${mcsN(ss.close)}</b> <b class="${mcsCls(dchg)}">${dchg != null ? (dchg >= 0 ? "+" : "") + mcsN(dchg) + " (" + mcsPct((dchg / ss.prevClose) * 100) + ")" : ""}</b> <span class="mcs-sub">· last candle ${mcsHm(last.time)}</span>` : "";
}

function mcsSessionStats() {
  const cs = MCS.d?.candles || []; if (!cs.length) return null;
  const today = mcsIstDay(cs[cs.length - 1].time);
  const td = cs.filter((x) => mcsIstDay(x.time) === today); const prev = cs.filter((x) => mcsIstDay(x.time) < today);
  const prevDay = prev.length ? mcsIstDay(prev[prev.length - 1].time) : null; const pd = prev.filter((x) => mcsIstDay(x.time) === prevDay);
  return {
    date: today, open: td[0]?.open, high: Math.max(...td.map((x) => x.high)), low: Math.min(...td.map((x) => x.low)), close: td[td.length - 1]?.close,
    prevClose: pd.length ? pd[pd.length - 1].close : null, prevHigh: pd.length ? Math.max(...pd.map((x) => x.high)) : null, prevLow: pd.length ? Math.min(...pd.map((x) => x.low)) : null,
  };
}

// ONE support/resistance ladder for the spot chart, the Market Levels panel and the
// Next 5/15 cards. Sources: the same Market Command levels (buildMCLevels: OI walls,
// ORB, PDH/PDL, swings, BOS/CHoCH, sweep) + classic floor pivots from the previous
// session. Side is decided ONLY by price vs current spot: above = resistance,
// below = support (a level's original label never puts it on the wrong side).
function mcsSpotLadder(d) {
  const spot = d?.spot; if (!d || spot == null) return { spot: null, res: [], sup: [], sl: null };
  const base = typeof buildMCLevels === "function" ? buildMCLevels(d) : [];
  const sl = base.find((l) => l.kind === "invalidation") || null;
  const L = base.filter((l) => l.kind !== "invalidation").map((l) => ({ ...l }));
  const s = mcsSessionStats();
  if (s && s.prevHigh != null && s.prevLow != null && s.prevClose != null) {
    const P = (s.prevHigh + s.prevLow + s.prevClose) / 3, rg = s.prevHigh - s.prevLow;
    [["Floor pivot P", "Pivot", P], ["Floor pivot R1", "Piv R1", 2 * P - s.prevLow], ["Floor pivot S1", "Piv S1", 2 * P - s.prevHigh], ["Floor pivot R2", "Piv R2", P + rg], ["Floor pivot S2", "Piv S2", P - rg]]
      .forEach(([type, short, price]) => { if (!L.some((x) => Math.abs(x.price - price) <= spot * 0.0005)) L.push({ kind: "pivot", type, short, price: Math.round(price * 100) / 100 }); });
  }
  const res = L.filter((l) => l.price > spot).sort((a, b) => a.price - b.price).map((l, i) => ({ ...l, side: "resistance", tag: "R" + (i + 1) }));
  const sup = L.filter((l) => l.price < spot).sort((a, b) => b.price - a.price).map((l, i) => ({ ...l, side: "support", tag: "S" + (i + 1) }));
  return { spot, res, sup, sl };
}

// Option premium support/resistance from the option's OWN real candles (no model):
// previous-session high/low/close, today's high/low, opening range (09:15–09:30),
// today's VWAP and recent swing highs/lows. Side vs the option's current LTP.
function mcsOptLevels(cands) {
  if (!cands || !cands.length) return { ltp: null, res: [], sup: [] };
  const last = cands[cands.length - 1], ltp = last.close, day = mcsIstDay(last.time);
  const days = [...new Set(cands.map((x) => mcsIstDay(x.time)))].filter((x) => x < day); const pdDay = days[days.length - 1];
  const td = cands.filter((x) => mcsIstDay(x.time) === day), pd = pdDay ? cands.filter((x) => mcsIstDay(x.time) === pdDay) : [];
  const hi = (a) => Math.max(...a.map((x) => x.high)), lo = (a) => Math.min(...a.map((x) => x.low));
  const L = []; const add = (type, short, p) => { if (p != null && isFinite(p) && p > 0) L.push({ type, short, price: Math.round(p * 100) / 100 }); };
  if (pd.length) { add("Prev Day High", "PDH", hi(pd)); add("Prev Day Low", "PDL", lo(pd)); add("Prev Day Close", "PDC", pd[pd.length - 1].close); }
  if (td.length) { add("Today High", "DH", hi(td)); add("Today Low", "DL", lo(td)); }
  const orb = td.filter((x) => { const hm = mcsHm(x.time); return hm >= "09:15" && hm < "09:30"; });
  if (orb.length && td.length > orb.length) { add("Opening Range High", "ORH", hi(orb)); add("Opening Range Low", "ORL", lo(orb)); }
  const vw = mcsVwap(cands); if (td.length) add("VWAP (today)", "VWAP", vw[vw.length - 1]);
  const rec = cands.filter((x) => mcsIstDay(x.time) >= (pdDay || day)); const sh = [], sl = [];
  for (let i = 2; i < rec.length - 2; i++) {
    const w = rec.slice(i - 2, i + 3);
    if (rec[i].high === hi(w)) sh.push(rec[i].high);
    if (rec[i].low === lo(w)) sl.push(rec[i].low);
  }
  sh.filter((p) => p > ltp).sort((a, b) => a - b).slice(0, 3).forEach((p) => add("Swing High", "SwH", p));
  sl.filter((p) => p < ltp).sort((a, b) => b - a).slice(0, 3).forEach((p) => add("Swing Low", "SwL", p));
  const out = []; L.forEach((l) => { if (!out.some((x) => Math.abs(x.price - l.price) <= Math.max(0.5, ltp * 0.004))) out.push(l); });   // merge near-duplicates, keep the first (session levels before swings)
  return {
    ltp,
    res: out.filter((l) => l.price > ltp).sort((a, b) => a.price - b.price).map((l, i) => ({ ...l, tag: "R" + (i + 1) })),
    sup: out.filter((l) => l.price < ltp).sort((a, b) => b.price - a.price).map((l, i) => ({ ...l, tag: "S" + (i + 1) })),
  };
}

// ATM = the chain strike nearest the CURRENT spot (the chain's own atmStrike can lag
// when the chain snapshot is older than the price).
function mcsAtm() {
  const m = MCS.d?.optionMatrix, spot = MCS.d?.spot; if (!m || !m.rows?.length) return null;
  if (spot == null) return m.atmStrike ?? null;
  return m.rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), m.rows[0].strike);
}
function mcsStrike() {
  const m = MCS.d?.optionMatrix; if (!m || !m.rows) return null;
  if (MCS.selStrike != null && m.rows.some((r) => r.strike === MCS.selStrike)) return MCS.selStrike;
  return mcsAtm();
}
function mcsPickStrike(k) {
  const atm = mcsAtm();
  MCS.selStrike = k === atm ? null : k; MCS._listScroll = null;
  mcsRenderStrikes(); mcsRenderOpt("CE"); mcsRenderOpt("PE"); mcsRenderChain();
  mcsLoadOptions(true).then(() => mcsStable(() => { mcsRenderOpt("CE"); mcsRenderOpt("PE"); mcsRenderOptLv(); mcsRenderAnalysis(); }));
}
function mcsRenderStrikes() {
  const box = mcsEl("mcs-strikes"); const m = MCS.d?.optionMatrix; if (!box) return;
  if (!m || !m.available || !m.rows?.length) { box.innerHTML = `<h4>OPTION LIST</h4>${UNAV}`; return; }
  const cur = mcsStrike(); const ts = MCS.d?.syncHealth?.oi?.dataTs; const fm = mcsFastMarks();
  const fmCls = (k) => { const v = fm[k]; if (!v) return ""; const [t] = v.split("|"); return t === "READY" ? " mcs-blink fast-ready" : " fast-watch"; };
  const fmTag = (k) => { const v = fm[k]; if (!v) return ""; const [t, sd] = v.split("|"); return ` <span class="mcs-badge ${t === "READY" ? "fast" : "watch"}">⚡ ${sd}</span>`; };
  const prevTop = box.querySelector(".mcs-strikelist")?.scrollTop;
  box.innerHTML = `<h4>OPTION LIST ${MCS.selStrike != null ? `<button class="mcs-atmbtn" id="mcs-toatm">⟲ Back to ATM ${mcsAtm()}</button>` : `<span class="mcs-sub">showing ATM</span>`}</h4>
    <div class="mcs-sub">Tap a strike — its CALL and PUT charts open.</div>
    <div class="mcs-tblwrap mcs-strikelist"><table class="mcs-tbl"><thead><tr><th>Strike</th><th>CE LTP</th><th>PE LTP</th></tr></thead><tbody>
    ${m.rows.map((r) => `<tr class="mcs-srow${r.strike === cur ? " sel" : ""}${fmCls(r.strike)}" data-k="${r.strike}"><td><b>${r.strike}</b>${r.strike === mcsAtm() ? ' <span class="mcs-badge hot">ATM</span>' : ""}${fmTag(r.strike)}</td><td>${mcsN(r.ce?.ltp)}</td><td>${mcsN(r.pe?.ltp)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="mcs-sub">LTP from option chain${ts ? " as of " + mcsHm(ts) : ""}${MCS.d?.syncHealth?.oi?.status === "STALE" ? ' <span class="mcs-warn">STALE</span>' : ""}</div>`;
  box.querySelectorAll(".mcs-srow").forEach((tr) => (tr.onclick = () => mcsPickStrike(Number(tr.dataset.k))));
  const atmBtn = mcsEl("mcs-toatm"); if (atmBtn) atmBtn.onclick = () => mcsPickStrike(mcsAtm());
  const list = box.querySelector(".mcs-strikelist"), sel = box.querySelector(".mcs-srow.sel");
  const key = MCS.sym + "|" + cur;
  if (list && sel && MCS._listScroll !== key) { list.scrollTop = Math.max(0, sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2); MCS._listScroll = key; }   // centre the selected strike once
  else if (list && prevTop != null) list.scrollTop = prevTop;   // keep the user's scroll on refresh
}

// ---------------------------------------------------------------------------
// FAST-MOVE READINESS — which strike is set up to move fast BEFORE it moves.
// Scored only from the existing Market Analysis engine's per-strike signals
// (spike trigger, gamma state, OI flow, direction alignment, top mover) + the
// index's distance to its trigger level. Every point is listed; no probability.
// READY (>= 7) blinks; WATCH (4–6) is highlighted; below that nothing is flagged.
// ---------------------------------------------------------------------------
const MCS_FAST_READY = 7, MCS_FAST_WATCH = 4;
function mcsFastMove() {
  const ma = MCS.ma, d = MCS.d; if (!ma || !d || d.spot == null) return null;
  const spot = d.spot, lad = mcsSpotLadder(d), atr = mcsAtr(mcsClosed(d.candles || [])) || spot * 0.001;
  const strikes = (ma.callOptions || []).map((r) => r.strike).sort((a, b) => a - b);
  const step = strikes.length > 1 ? Math.min(...strikes.slice(1).map((k, i) => k - strikes[i]).filter((x) => x > 0)) : 50;
  const score = (r, side) => {
    const pts = [];
    const add = (n, why) => pts.push([n, why]);
    if (!(r.oi > 0) || !(r.volume > 0)) return null;   // illiquid strikes are never flagged
    const sp = r.spikeTrigger?.state;
    if (sp === "SPIKE STARTING") add(4, "spike starting"); else if (sp === "PRE-SPIKE") add(3, "pre-spike");
    const g = r.gammaState;
    if (g === "BLAST") add(3, "gamma BLAST"); else if (g === "PRE-BLAST") add(2, "gamma PRE-BLAST"); else if (g === "BUILDING") add(1, "gamma building");
    const f = String(r.oiFlow || "");
    if (f === "STRONG BUILD" || f === "CONFIRMED FLOW") add(2, "OI " + f.toLowerCase()); else if (f === "BUILDING" || f === "OI SHOCK") add(1, "OI " + f.toLowerCase());
    // alignment vs the SAME direction the rest of this screen shows (Market Command), not a second engine's
    const mcDir = d.marketView?.direction;
    const al = mcDir === "BULLISH" ? (side === "CE" ? 1 : -1) : mcDir === "BEARISH" ? (side === "PE" ? 1 : -1) : 0;
    if (al > 0) add(2, `with Market Command direction (${mcDir})`); else if (al < 0) add(-2, `against Market Command direction (${mcDir})`);
    if (r.topMover) add(1, "top premium responder");
    if (Math.abs(r.strike - spot) <= step) add(1, "at the money (highest gamma)");
    const trig = side === "CE" ? lad.res[0] : lad.sup[0];
    if (trig && Math.abs(trig.price - spot) <= 0.5 * atr) add(1, `index ${mcsN(Math.abs(trig.price - spot), 1)} pts from ${trig.tag} ${trig.short}`);
    const total = pts.reduce((a, [n]) => a + n, 0);
    return { strike: r.strike, side, row: r, total, pts, trig, tier: total >= MCS_FAST_READY ? "READY" : total >= MCS_FAST_WATCH ? "WATCH" : null };
  };
  const rank = (rows, side) => (rows || []).map((r) => score(r, side)).filter(Boolean).sort((a, b) => b.total - a.total || (b.row.respMid ?? 0) - (a.row.respMid ?? 0));
  const maDir = ma.marketDirection?.bias, mcDir = d.marketView?.direction;
  const conflict = maDir && mcDir && maDir !== "SIDEWAYS" && mcDir !== "NEUTRAL" && maDir !== mcDir ? `Market Analysis engine reads ${maDir} (${ma.marketDirection.basis || "OI flow"}) while Market Command reads ${mcDir}` : null;
  return { conflict, ce: rank(ma.callOptions, "CE"), pe: rank(ma.putOptions, "PE"), live: !(d.dataStale || (d.syncHealth?.overall && d.syncHealth.overall !== "LIVE")) };
}
// strike -> tier for the blinking marks in the option list / chain ("READY" only while data is live)
function mcsFastMarks() {
  const f = mcsFastMove(); const out = {}; if (!f) return out;
  for (const side of ["ce", "pe"]) { const b = f[side][0]; if (b && b.tier) out[b.strike] = (out[b.strike] === "READY" ? "READY" : b.tier === "READY" && f.live ? "READY" : "WATCH") + "|" + (out[b.strike] ? "CE+PE" : b.side); }
  return out;
}
function mcsRenderFast() {
  const box = mcsEl("mcs-fast"); if (!box) return;
  const f = mcsFastMove();
  if (!f) { box.innerHTML = `<h4>⚡ FAST-MOVE READINESS</h4>${MCS.ma ? UNAV : '<span class="mcs-sub">Waiting for Market Analysis data…</span>'}`; return; }
  const card = (b, side) => {
    if (!b) return `<div class="mcs-fcard"><b>${side}</b> ${UNAV}</div>`;
    const r = b.row, st = r.spikeTrigger || {};
    const blink = b.tier === "READY" && f.live;
    const trigTxt = b.trig ? `Index trigger: 15M close ${side === "CE" ? "above" : "below"} <b>${mcsN(b.trig.price)}</b> (${b.trig.tag} ${mcsEsc(b.trig.short)})` : "Index trigger: no level mapped";
    return `<div class="mcs-fcard ${b.tier ? b.tier.toLowerCase() : "none"}${blink ? " mcs-blink" : ""}" data-k="${b.strike}">
      <div class="mcs-fhead"><span class="mcs-badge ${side === "CE" ? "ce" : "pe"}">${side === "CE" ? "BUY CE" : "BUY PE"}</span> <b class="mcs-fstrike">${b.strike} ${side}</b>
        <span class="mcs-ftier">${b.tier === "READY" ? (f.live ? "⚡ READY TO MOVE" : "READY (last session)") : b.tier === "WATCH" ? "👀 WATCH" : "NOT READY"}</span><span class="mcs-fscore">${b.total}/14</span></div>
      <div class="mcs-fwhy">${b.pts.length ? b.pts.map(([n, w]) => `<span class="${n < 0 ? "neg" : ""}">${n > 0 ? "+" : ""}${n} ${mcsEsc(w)}</span>`).join("") : '<span>no pre-move signal</span>'}</div>
      <div class="mcs-fpre">LTP <b>${mcsN(r.ltp)}</b> · pre-spike <b>${mcsN(st.preSpike)}</b> · premium trigger <b>${mcsN(st.trigger)}</b> · expected 15m response ${mcsEsc(r.move15m || "—")} (model)</div>
      <div class="mcs-fpre">${trigTxt}</div>
      <button class="mcs-fopen" data-k="${b.strike}">Open ${b.strike} charts</button>
    </div>`;
  };
  const any = [f.ce[0], f.pe[0]].some((b) => b && b.tier);
  box.innerHTML = `<h4>⚡ FAST-MOVE READINESS — best strike before the move <span class="mcs-sub">score from engine signals · READY ≥ ${MCS_FAST_READY} blinks · WATCH ≥ ${MCS_FAST_WATCH}</span></h4>
    ${f.live ? "" : '<div class="mcs-warn" style="margin-bottom:4px">Data not live — showing the last session\'s state; nothing blinks until live data returns.</div>'}
    ${f.conflict ? `<div class="mcs-warn" style="margin-bottom:4px">⚠ Engines disagree on direction: ${mcsEsc(f.conflict)}. Treat any READY strike with extra caution.</div>` : ""}
    ${any ? "" : '<div class="mcs-sub" style="margin-bottom:4px">No strike is showing pre-move signs right now (spike / gamma / OI flow all normal). Highest scores shown for reference.</div>'}
    <div class="mcs-fgrid">${card(f.ce[0], "CE")}${card(f.pe[0], "PE")}</div>
    <div class="mcs-sub">Scoring: spike starting +4 / pre-spike +3 · gamma blast +3 / pre-blast +2 / building +1 · OI strong build +2 / building +1 · with direction +2 (against −2) · top responder +1 · ATM +1 · index within ½ ATR of trigger +1. Illiquid strikes excluded. Readiness, not a guarantee or probability.</div>`;
  box.querySelectorAll(".mcs-fopen").forEach((bt) => (bt.onclick = () => { mcsPickStrike(Number(bt.dataset.k)); mcsEl("mcs-strikes")?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
}

function mcsRenderHeader() {
  const d = MCS.d, s = mcsSessionStats(); const q = mcsEl("mcs-quote");
  if (MCS.mode === "TEST") {
    const nm0 = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
    if (q) q.innerHTML = `<b>${mcsEsc(nm0)}</b> <span class="mcs-testtag">🧪 TESTING ${mcsEsc(MCS.test.date || "")} · as of ${mcsEsc(MCS.ss?.upto || MCS.test.upto)}</span> ${d && s ? `<span class="mcs-px">${mcsN(d.spot)}</span> <span class="mcs-kv">Open <b>${mcsN(s.open)}</b></span><span class="mcs-kv">High <b>${mcsN(s.high)}</b></span><span class="mcs-kv">Low <b>${mcsN(s.low)}</b></span><span class="mcs-kv">Prev Close <b>${mcsN(s.prevClose)}</b></span>` : ""}`;
    const tk = mcsEl("mcs-tickers"); if (tk) tk.innerHTML = "";
    const m = mcsEl("mcs-meta"); if (m) m.innerHTML = `<span class="mcs-warn">Live refresh paused</span>`;
    return;
  }
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  if (q) {
    if (!d || !s) q.innerHTML = `<b>${mcsEsc(nm)}</b> ${UNAV}`;
    else {
      const chg = s.prevClose != null ? s.close - s.prevClose : null, pct = chg != null && s.prevClose ? (chg / s.prevClose) * 100 : null;
      const live = d.syncHealth?.overall || (d.dhanLive ? "LIVE" : "DISCONNECTED");
      q.innerHTML = `<b>${mcsEsc(nm)}</b> <span class="mcs-px">${mcsN(d.spot)}</span> <span class="${mcsCls(chg)}">${chg != null ? (chg >= 0 ? "+" : "") + mcsN(chg) + " (" + mcsPct(pct) + ")" : ""}</span>
        <span class="mcs-kv">Open <b>${mcsN(s.open)}</b></span><span class="mcs-kv">High <b>${mcsN(s.high)}</b></span><span class="mcs-kv">Low <b>${mcsN(s.low)}</b></span><span class="mcs-kv">Prev Close <b>${mcsN(s.prevClose)}</b></span>
        <span class="mcs-live ${String(live).toLowerCase()}">● ${mcsEsc(live)}</span>`;
    }
  }
  const tk = mcsEl("mcs-tickers"); const qs = MCS.q?.quotes || {};
  if (tk) tk.innerHTML = MCS_SYMS.filter(([sy]) => sy !== MCS.sym && sy !== "^NSEMDCP50").map(([sy, n]) => { const x = qs[sy]; return `<span class="mcs-tk"><span>${n}</span> <b>${x ? mcsN(x.price) : "—"}</b> <span class="${mcsCls(x?.changePercent)}">${x ? mcsPct(x.changePercent) : ""}</span></span>`; }).join("");
  const m = mcsEl("mcs-meta");
  if (m && d) { const exp = d.optionMatrix?.expiry; m.innerHTML = `${s ? "📅 " + new Date(s.date + "T00:00:00Z").toUTCString().slice(0, 16) : ""} ${exp ? " · Expiry <b>" + mcsEsc(exp) + "</b>" : ""} · Updated <b>${new Date().toLocaleTimeString("en-IN", { hour12: false })}</b> ${d.dataStale ? '<span class="mcs-warn">· DATA STALE</span>' : ""}`; }
}

function mcsRenderLevels() {
  const box = mcsEl("mcs-levels"); const d = MCS.d; if (!box) return;
  if (!d) { box.innerHTML = `<h4>Market Levels</h4>${UNAV}`; return; }
  const lad = mcsSpotLadder(d), spot = lad.spot;
  const row = (l, cls) => `<div class="mcs-lv ${cls}"><span>${l.tag}</span><b>${mcsN(l.price)}</b><em>${mcsEsc(l.type)} · ${l.price > spot ? "+" : ""}${mcsN(l.price - spot, 1)} pts</em></div>`;
  const ov = d.overlays || {}; const lastv = (a) => (a && a.length ? a[a.length - 1] : null);
  const atr = mcsAtr(mcsClosed(d.candles || []));
  const cf = d.confirmationFlow || {}, mv = d.marketView || {}, an = MCS.ma?.movement;
  box.innerHTML = `<h4>Market Levels (${mcsEsc(MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || "")})</h4>
    <div class="mcs-ladder">
    ${lad.res.length ? lad.res.slice().reverse().map((l) => row(l, "r")).join("") : '<div class="mcs-sub">No resistance above price</div>'}
    <div class="mcs-lv spot"><span>SPOT</span><b>${mcsN(spot)}</b><em>current price</em></div>
    ${lad.sup.length ? lad.sup.map((l) => row(l, "s")).join("") : '<div class="mcs-sub">No support below price</div>'}
    </div>
    ${MCS.ma?.noTradeZone?.active ? `<div class="mcs-lv ntz"><span>NTZ</span><b>${mcsN(MCS.ma.noTradeZone.low)} – ${mcsN(MCS.ma.noTradeZone.high)}</b><em>No-Trade Zone · ${mcsEsc((MCS.ma.noTradeZone.reasons || []).join("; "))}</em></div>` : ""}
    ${lad.sl ? `<div class="mcs-lv sl"><span>SL</span><b>${mcsN(lad.sl.price)}</b><em>Market Command invalidation</em></div>` : ""}
    <h4 style="margin-top:10px">Market Status</h4>
    <div class="mcs-kvs">
      <div><span>Regime</span><b>${mcsEsc(cf.marketState || "—")}</b></div>
      <div><span>Trend strength</span><b>${mcsEsc(mv.strength || "—")}</b> <em>${mcsEsc(mv.strengthEvidence || "")}</em></div>
      <div><span>Direction</span><b class="${mv.direction === "BULLISH" ? "mcs-up" : mv.direction === "BEARISH" ? "mcs-dn" : ""}">${mcsEsc(mv.direction || "—")}</b></div>
      <div><span>VWAP</span><b>${mcsN(lastv(ov.vwap))}</b></div>
      <div><span>EMA 9 / 21</span><b>${mcsN(lastv(ov.ema9))} / ${mcsN(lastv(ov.ema21))}</b></div>
      <div><span>EMA 50 / 200</span><b>${mcsN(lastv(ov.ema50))} / ${mcsN(lastv(ov.ema200))}</b></div>
      <div><span>ATR (14)</span><b>${mcsN(atr, 1)}</b></div>
      <div><span>India VIX</span><b>${d.vix?.available ? mcsN(d.vix.value) : "—"}</b> <em>${mcsEsc(d.vixEnvironment?.environment || "")}</em></div>
      <div><span>Expected move 15m</span><b>${an?.expectedMovePts != null ? "±" + mcsN(an.expectedMovePts, 1) + " pts" : "—"}</b> <em>${an ? "model" : ""}</em></div>
    </div>`;
}

async function mcsLoadOptions(force) {
  const m = MCS.d?.optionMatrix; if (!m || !m.available || !m.atmStrike || !m.expiry) { MCS.opt = { CE: null, PE: null }; return; }
  const strike = mcsStrike(); if (strike == null) return;
  const key = `${MCS.sym}|${strike}|${m.expiry}|${MCS.tf}`;
  if (!force && MCS.optKey === key && Date.now() - MCS.optAt < 60_000) return;
  MCS.optKey = key; MCS.optAt = Date.now();
  const iv = MCS.tf === "60m" ? 60 : parseInt(MCS.tf, 10) || 5;
  const get = async (type) => { try { const r = await fetchJSON(`/api/option-candles?symbol=${encodeURIComponent(MCS.sym)}&type=${type}&strike=${strike}&expiry=${encodeURIComponent(m.expiry)}&interval=${iv}`, 30000); return r && !r.error ? r : { error: r?.error || "no data" }; } catch (e) { return { error: "request failed" }; } };
  const [ce, pe] = await Promise.all([get("CE"), get("PE")]);
  if (MCS.optKey === key) MCS.opt = { CE: ce, PE: pe, key };
}

function mcsRenderOpt(side) {
  const box = mcsEl("mcs-opt" + side); const d = MCS.d; if (!box) return;
  const m = d?.optionMatrix; const strike = mcsStrike();
  const idx = m?.rows ? m.rows.findIndex((r) => r.strike === strike) - m.rows.findIndex((r) => r.strike === mcsAtm()) : 0;
  const spotNow = d?.spot; const itm = spotNow != null && strike != null ? (side === "CE" ? strike < spotNow : strike > spotNow) : null;   // moneyness vs current spot
  const posTag = idx === 0 ? "ATM" : `ATM${idx > 0 ? "+" : ""}${idx} · ${itm == null ? "" : itm ? "ITM" : "OTM"}`;
  const optKeyNow = `${MCS.sym}|${strike}|${m?.expiry}|${MCS.tf}`;
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  const row = m?.rows?.find((r) => r.strike === strike); const g = row ? row[side.toLowerCase()] : null;
  const o = MCS.opt.key === optKeyNow ? MCS.opt[side] : null; const cands = (o && (o.candles || o.data)) || [];
  const olv = mcsOptLevels(cands);
  const closes = cands.map((x) => x.close); const e9 = mcsEma(closes, 9), e21 = mcsEma(closes, 21), vw = mcsVwap(cands);
  const lastI = cands.length - 1; const ltp = lastI >= 0 ? cands[lastI].close : g?.ltp ?? null;   // latest candle close; chain snapshot only as fallback
  const ltpAt = lastI >= 0 ? mcsHm(cands[lastI].time) : null; const chainTs = d?.syncHealth?.oi?.dataTs; const chainAt = chainTs ? mcsHm(chainTs) : null;
  const sessOpen = (() => { if (!cands.length) return null; const day = mcsIstDay(cands[lastI].time); const f = cands.find((x) => mcsIstDay(x.time) === day); const prev = cands.filter((x) => mcsIstDay(x.time) < day); return prev.length ? prev[prev.length - 1].close : f?.open; })();
  const chg = ltp != null && sessOpen ? ltp - sessOpen : null, pct = chg != null && sessOpen ? (chg / sessOpen) * 100 : null;
  // card skeleton is built once; refreshes only update its parts (chart stays, no jump)
  if (!box.querySelector(".mcs-optchart")) {
    box.innerHTML = `<div class="mcs-ophead"></div><div class="mcs-opq"></div><div class="mcs-optchart" id="mcs-och${side}"><div class="mcs-empty"></div></div><div class="mcs-oplv"></div><div class="mcs-sub mcs-chainat" style="margin-top:4px"></div><div class="mcs-greeks"></div>`;
  }
  const q = (c) => box.querySelector(c);
  q(".mcs-ophead").innerHTML = `<b>${mcsEsc(nm)} ${strike ?? "—"} ${side}</b> <span class="mcs-badge ${side === "CE" ? "ce" : "pe"}">${side === "CE" ? "CALL" : "PUT"} · ${posTag}</span> <span class="mcs-sub">${mcsEsc(m?.expiry || "")}</span>`;
  q(".mcs-opq").innerHTML = `LTP <b>${mcsN(ltp)}</b> <span class="${mcsCls(chg)}">${chg != null ? (chg >= 0 ? "+" : "") + mcsN(chg) + " (" + mcsPct(pct) + ")" : ""}</span> <span class="mcs-sub">${ltpAt ? "candle " + ltpAt : g?.ltp != null ? "chain LTP" : ""}</span>
      <span class="mcs-kv">EMA 9 <b>${mcsN(e9[lastI])}</b></span><span class="mcs-kv">EMA 21 <b>${mcsN(e21[lastI])}</b></span><span class="mcs-kv">VWAP <b>${mcsN(vw[lastI])}</b></span>`;
  q(".mcs-oplv").innerHTML = `<div><span class="mcs-dn">Resistance</span> ${olv.res.length ? olv.res.map((l) => `<em>${l.tag}</em> <b>${mcsN(l.price)}</b> <i>${mcsEsc(l.short)}</i>`).join(" · ") : '<i>none above LTP</i>'}</div>
      <div><span class="mcs-up">Support</span> ${olv.sup.length ? olv.sup.map((l) => `<em>${l.tag}</em> <b>${mcsN(l.price)}</b> <i>${mcsEsc(l.short)}</i>`).join(" · ") : '<i>none below LTP</i>'}</div>`;
  q(".mcs-chainat").innerHTML = `OI / IV / Greeks from option chain${chainAt ? " as of " + chainAt : ""}${d?.syncHealth?.oi?.status === "STALE" ? ' <span class="mcs-warn">STALE</span>' : ""}`;
  q(".mcs-greeks").innerHTML = [["OI", mcsL(g?.oi)], ["OI Change", g?.oiChg != null ? (g.oiChg >= 0 ? "+" : "") + mcsL(g.oiChg) : "—"], ["Volume", mcsL(g?.vol)], ["IV", g?.iv != null ? mcsN(g.iv, 1) : "—"], ["Delta", g?.delta != null ? mcsN(g.delta, 2) : "—"], ["Gamma", g?.gamma != null ? mcsN(g.gamma, 4) : "—"], ["Theta", g?.theta != null ? mcsN(g.theta, 2) : "—"], ["Vega", g?.vega != null ? mcsN(g.vega, 2) : "—"]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  const host = mcsEl("mcs-och" + side); const empty = host.querySelector(".mcs-empty");
  MCS.oc = MCS.oc || {}; let oc = MCS.oc[side];
  if (!cands.length || typeof LightweightCharts === "undefined") {
    // new strike still loading: keep the old chart's space, just show the message on top
    if (empty) { empty.style.display = "flex"; empty.textContent = o && o.error ? "Option candles: " + o.error : `Loading ${strike ?? ""} ${side} candles…`; }
    return;
  }
  if (empty) empty.style.display = "none";
  if (!oc || oc.host !== host) {
    const ch = LightweightCharts.createChart(host, { width: host.clientWidth, height: host.clientHeight || 250, layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#8a97ad", fontSize: 10 }, grid: { vertLines: { color: "#121a2b" }, horzLines: { color: "#121a2b" } }, rightPriceScale: { borderColor: "#2a2e39" }, timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false } });
    const cs = ch.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", borderVisible: false, wickUpColor: "#16c784", wickDownColor: "#ea3943" });
    const ln = (col, st) => ch.addLineSeries({ color: col, lineWidth: 1, lineStyle: st || 0, priceLineVisible: false, lastValueVisible: false });
    oc = MCS.oc[side] = { host, ch, cs, e9: ln("#f59e0b"), e21: ln("#22d3ee"), vw: ln("#22c55e", 2), lines: [], key: null };
    oc.zones = mcsZoneLayer(host, ch, cs);
    try { oc.ro = new ResizeObserver(() => { if (!oc.disposed) ch.applyOptions({ width: host.clientWidth, height: host.clientHeight || 250 }); }); oc.ro.observe(host); } catch (_) {}
  }
  oc.cs.setData(cands.map((x) => ({ time: mcsT(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));
  const ser = (arr) => cands.map((x, i) => (arr[i] != null ? { time: mcsT(x.time), value: arr[i] } : null)).filter(Boolean);
  oc.e9.setData(ser(e9)); oc.e21.setData(ser(e21)); oc.vw.setData(ser(vw));
  oc.lines.forEach((l) => { try { oc.cs.removePriceLine(l); } catch (_) {} }); oc.lines = [];
  // nearest 3 premium S/R each, only inside the visible candles' range (keeps the price scale tight)
  const vis = cands.slice(-80); const vlo = Math.min(...vis.map((x) => x.low)), vhi = Math.max(...vis.map((x) => x.high)), vpad = (vhi - vlo) * 0.25;
  const drawn = [...olv.res.filter((l) => l.short !== "VWAP").slice(0, 3).map((l) => [l, "res"]), ...olv.sup.filter((l) => l.short !== "VWAP").slice(0, 3).map((l) => [l, "sup"])].filter(([l]) => l.price >= vlo - vpad && l.price <= vhi + vpad);
  drawn.forEach(([l, k]) => oc.lines.push(oc.cs.createPriceLine({ price: l.price, color: k === "res" ? "#ea3943" : "#16c784", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `${l.tag} ${l.short}` })));
  const halfO = Math.max(0.3, (ltp || 0) * 0.008);
  mcsSetZones(oc.zones, MCS.show.zones ? drawn.map(([l, k]) => ({ lo: l.price - halfO, hi: l.price + halfO, kind: k })) : []);
  if (oc.key !== optKeyNow) { oc.ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, cands.length - 80), to: cands.length + 1 }); oc.key = optKeyNow; }   // fit only when the strike / tf changes
}

function mcsRenderNext(win) {
  const box = mcsEl(win === 5 ? "mcs-next5" : "mcs-next15"); const d = MCS.d, ma = MCS.ma; if (!box) return;
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  const em = win === 5 ? ma?.movement?.expectedMove5m : ma?.movement?.expectedMove15m;
  const dir = (win === 5 ? d?.mtfDirection?.m5?.direction : d?.mtfDirection?.m15?.direction) || "—";
  const up = dir === "BULLISH", dn = dir === "BEARISH";
  const spot = d?.spot; const lad = mcsSpotLadder(d);
  const key = up ? lad.res[0] : dn ? lad.sup[0] : null;
  const inval = up ? lad.sup[0] : dn ? lad.res[0] : null;
  const target = em && spot != null ? (up ? `${mcsN(spot)} – ${mcsN(spot + em.pts)}` : dn ? `${mcsN(spot - em.pts)} – ${mcsN(spot)}` : `${mcsN(spot - em.pts)} – ${mcsN(spot + em.pts)}`) : null;
  box.innerHTML = `<h4>NEXT ${win} MINUTES — ${mcsEsc(nm)}</h4>
    <div class="mcs-bias ${up ? "up" : dn ? "dn" : ""}">${up ? "UP" : dn ? "DOWN" : "NO"} BIAS <em>(${win}M structure: ${mcsEsc(dir)})</em></div>
    <div class="mcs-kvs">
      <div><span>Expected move</span><b>${em ? "±" + mcsN(em.pts, 1) + " pts" : "—"}</b> <em>${em ? "model (VIX + ATR + range)" : "market analysis unavailable"}</em></div>
      <div><span>Key level</span><b>${key ? mcsN(key.price) + " (" + key.tag + " " + mcsEsc(key.short) + ")" : "—"}</b></div>
      <div><span>Target zone</span><b>${target || "—"}</b></div>
      <div><span>Invalidation</span><b>${inval ? (up ? "< " : "> ") + mcsN(inval.price) + " (" + inval.tag + " " + mcsEsc(inval.short) + ")" : "—"}</b></div>
      <div><span>Confirmations</span><b>${mcsEsc(d?.marketView?.strengthEvidence || "—")}</b> <em>evidence count — not a probability</em></div>
      <div><span>Volatility</span><b>${mcsEsc(ma?.movement?.regime || "—")}</b> <em>${ma?.movement?.capacity ? "capacity " + mcsEsc(ma.movement.capacity) : ""}</em></div>
    </div>`;
}

function mcsMoverRows(list) {
  return (list || []).slice().sort((a, b) => (b.topMover === true) - (a.topMover === true) || (b.respMid ?? -1) - (a.respMid ?? -1)).slice(0, 5);
}
function mcsRenderMovers() {
  const box = mcsEl("mcs-movers"); const ma = MCS.ma; if (!box) return;
  const side = MCS.hmSide; const list = mcsMoverRows(side === "CE" ? ma?.callOptions : ma?.putOptions);
  box.innerHTML = `<h4>HIGH MOVEMENT STRIKES (NEXT 15 MIN) <span class="mcs-seg"><button class="${side === "CE" ? "on" : ""}" data-s="CE">Top CE</button><button class="${side === "PE" ? "on" : ""}" data-s="PE">Top PE</button></span></h4>
    <div class="mcs-sub">Ranked by the existing Market Analysis engine: top-mover flag, then expected premium response. Projections are model estimates.</div>
    ${list.length ? `<div class="mcs-tblwrap"><table class="mcs-tbl"><thead><tr><th>Strike</th><th>LTP</th><th>Chg %</th><th>OI Chg %</th><th>Volume</th><th>Move 15m (₹)</th><th>Gamma</th><th>Spike</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><b>${r.strike} ${side}</b>${r.topMover ? ' <span class="mcs-badge hot">TOP</span>' : ""}</td><td>${mcsN(r.ltp)}</td><td class="${mcsCls(r.chgPct)}">${mcsPct(r.chgPct)}</td><td class="${mcsCls(r.oiChgPct)}">${mcsPct(r.oiChgPct)}</td><td>${mcsL(r.volume)}</td><td>${mcsEsc(r.move15m || "—")}</td><td>${mcsEsc(r.gammaState || "—")}</td><td>${mcsEsc(r.spikeTrigger?.state || "—")}</td></tr>`).join("")}
    </tbody></table></div>` : UNAV}`;
  box.querySelectorAll(".mcs-seg button").forEach((b) => (b.onclick = () => { MCS.hmSide = b.dataset.s; mcsRenderMovers(); }));
}

function mcsRenderChain() {
  const box = mcsEl("mcs-chain"); const m = MCS.d?.optionMatrix; const ma = MCS.ma; if (!box) return;
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  if (!m || !m.available || !m.rows?.length) { box.innerHTML = `<h4>OPTION CHAIN — ${mcsEsc(nm)}</h4>${UNAV}`; return; }
  const chgOf = (side, k) => (side === "CE" ? ma?.callOptions : ma?.putOptions)?.find((r) => r.strike === k)?.chgPct ?? null;
  const mode = MCS.hmMode;
  const val = (leg, side, k) => (mode === "vol" ? leg?.vol : mode === "ltp" ? chgOf(side, k) : leg?.oiChg);
  const all = m.rows.flatMap((r) => [Math.abs(val(r.ce, "CE", r.strike) || 0), Math.abs(val(r.pe, "PE", r.strike) || 0)]); const max = Math.max(1, ...all);
  const heat = (v, side) => { if (v == null) return ""; const a = Math.min(0.55, (Math.abs(v) / max) * 0.55); const col = mode === "ltp" ? (v >= 0 ? "22,199,132" : "234,57,67") : side === "CE" ? "234,57,67" : "22,199,132"; return `style="background:rgba(${col},${a.toFixed(2)})"`; };
  box.innerHTML = `<h4>OPTION CHAIN — ${mcsEsc(nm)} (${mcsEsc(m.expiry || "")}) <span class="mcs-seg">${[["oiChg", "OI Change"], ["vol", "Volume"], ["ltp", "LTP Change"]].map(([k, n]) => `<button class="${mode === k ? "on" : ""}" data-m="${k}">${n}</button>`).join("")}</span></h4>
    <div class="mcs-tblwrap"><table class="mcs-tbl mcs-chaintbl"><thead><tr><th colspan="5" class="ce">CALLS</th><th></th><th colspan="5" class="pe">PUTS</th></tr>
      <tr><th>LTP</th><th>Chg %</th><th>OI</th><th>OI Chg</th><th>Vol</th><th>Strike</th><th>LTP</th><th>Chg %</th><th>OI</th><th>OI Chg</th><th>Vol</th></tr></thead><tbody>
      ${m.rows.map((r) => { const atm = r.strike === mcsAtm(); const cc = chgOf("CE", r.strike), pc = chgOf("PE", r.strike);
        return `<tr class="mcs-crow${atm ? " atm" : ""}${r.strike === mcsStrike() ? " sel" : ""}" data-k="${r.strike}" title="Open ${r.strike} CE / PE charts"><td ${heat(val(r.ce, "CE", r.strike), "CE")}>${mcsN(r.ce?.ltp)}</td><td class="${mcsCls(cc)}">${mcsPct(cc)}</td><td>${mcsL(r.ce?.oi)}</td><td class="${mcsCls(r.ce?.oiChg)}">${mcsL(r.ce?.oiChg)}</td><td>${mcsL(r.ce?.vol)}</td>
        <td class="mcs-strike${(() => { const v = mcsFastMarks()[r.strike]; return v ? (v.startsWith("READY") ? " mcs-blink fast-ready" : " fast-watch") : ""; })()}">${r.strike}${atm ? " ATM" : ""}${mcsFastMarks()[r.strike] ? " ⚡" : ""}</td>
        <td ${heat(val(r.pe, "PE", r.strike), "PE")}>${mcsN(r.pe?.ltp)}</td><td class="${mcsCls(pc)}">${mcsPct(pc)}</td><td>${mcsL(r.pe?.oi)}</td><td class="${mcsCls(r.pe?.oiChg)}">${mcsL(r.pe?.oiChg)}</td><td>${mcsL(r.pe?.vol)}</td></tr>`; }).join("")}
    </tbody></table></div>`;
  box.querySelectorAll(".mcs-seg button").forEach((b) => (b.onclick = () => { MCS.hmMode = b.dataset.m; mcsRenderChain(); }));
  box.querySelectorAll(".mcs-crow").forEach((tr) => (tr.onclick = () => { mcsPickStrike(Number(tr.dataset.k)); mcsEl("mcs-strikes")?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
}

function mcsRenderTopMove() {
  const box = mcsEl("mcs-topmove"); const ma = MCS.ma; if (!box) return;
  const top = (list) => (list || []).filter((r) => r.chgPct != null).slice().sort((a, b) => b.chgPct - a.chgPct).slice(0, 5);
  const tbl = (list, side) => list.length ? `<table class="mcs-tbl"><thead><tr><th>Strike</th><th>LTP</th><th>Chg %</th><th>OI Chg %</th><th>Vol</th></tr></thead><tbody>${list.map((r) => `<tr><td><b>${r.strike} ${side}</b></td><td>${mcsN(r.ltp)}</td><td class="${mcsCls(r.chgPct)}">${mcsPct(r.chgPct)}</td><td class="${mcsCls(r.oiChgPct)}">${mcsPct(r.oiChgPct)}</td><td>${mcsL(r.volume)}</td></tr>`).join("")}</tbody></table>` : UNAV;
  box.innerHTML = `<h4>TOP CE MOVEMENT</h4><div class="mcs-tblwrap">${tbl(top(ma?.callOptions), "CE")}</div><h4 style="margin-top:8px">TOP PE MOVEMENT</h4><div class="mcs-tblwrap">${tbl(top(ma?.putOptions), "PE")}</div>`;
}

function mcsRenderCmd() {
  const box = mcsEl("mcs-cmd"); const d = MCS.d; if (!box) return;
  if (!d) { box.innerHTML = `<h4>MARKET COMMAND</h4>${UNAV}`; return; }
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  const tp = d.tradePlan || {}, cf = d.confirmationFlow || {}, mtf = d.mtfDirection || {};
  const b5 = mtf.m5?.direction, b15 = mtf.m15?.direction;
  const bias = (x) => `<b class="${x === "BULLISH" ? "mcs-up" : x === "BEARISH" ? "mcs-dn" : ""}">${x === "BULLISH" ? "UP BIAS" : x === "BEARISH" ? "DOWN BIAS" : mcsEsc(x || "—")}</b>`;
  const action = tp.action || cf.action || "—";
  const best = tp.bestSetup;
  box.innerHTML = `<h4>MARKET COMMAND <span class="mcs-live ${String(d.syncHealth?.overall || "").toLowerCase()}">● ${mcsEsc(d.syncHealth?.overall || (d.dhanLive ? "LIVE" : "—"))}</span></h4>
    <div class="mcs-sub">${mcsEsc(nm)} — same result as the Market Command screen</div>
    <div class="mcs-cmdgrid"><div><span>5 MIN</span>${bias(b5)}</div><div><span>15 MIN</span>${bias(b15)}</div><div><span>ACTION</span><b class="mcs-act">${mcsEsc(action)}</b></div></div>
    <div class="mcs-kvs">
      <div><span>Best ${mcsEsc(tp.optionType && tp.optionType !== "—" ? tp.optionType : "strike")}</span><b>${mcsEsc(tp.preferredStrike || "—")}</b> <em>${tp.alternativeStrike ? "alt " + mcsEsc(tp.alternativeStrike) : ""}</em></div>
      ${best ? `<div><span>Setup</span><b>${mcsEsc(best.strike || "")} ${mcsEsc(best.side || "")}</b> <em>entry ₹${mcsN(best.entryPremium)} · SL ₹${mcsN(best.stopPremium)} · T ₹${mcsN(best.targetPremium)}</em></div>` : ""}
      <div><span>Regime</span><b>${mcsEsc(cf.marketState || "—")}</b></div>
      <div><span>Volatility</span><b>${mcsEsc(d.vixEnvironment?.environment || "—")}</b> <em>VIX ${d.vix?.available ? mcsN(d.vix.value) : "—"}</em></div>
      <div><span>Reason</span><em>${mcsEsc(tp.waitReason || d.command?.finalReason || "—")}</em></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// MARKET ANALYSIS — a structured written read built ONLY from this screen's real
// engine outputs (Market Command payload, Market Analysis payload, option candles).
// Rule-based: every sentence is a fact or an if/then on a real level. No forecast,
// no probability, no invented number. Advisory only.
// ---------------------------------------------------------------------------
function mcsRenderAnalysis() {
  const box = mcsEl("mcs-analysis"); const d = MCS.d, ma = MCS.ma; if (!box) return;
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  if (!d || d.spot == null) { box.innerHTML = `<h4>🧠 MARKET ANALYSIS — ${mcsEsc(nm)}</h4>${UNAV}`; return; }
  const spot = d.spot, lad = mcsSpotLadder(d), cs = d.candles || [], atr = mcsAtr(mcsClosed(cs));
  const ov = d.overlays || {}; const lastv = (a) => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
  const e9 = lastv(ov.ema9), e21 = lastv(ov.ema21), e50 = lastv(ov.ema50), e200 = lastv(ov.ema200), vwap = lastv(ov.vwap);
  const mtf = d.mtfDirection || {}, mv = d.marketView || {}, tp = d.tradePlan || {}, cf = d.confirmationFlow || {};
  const dir = mv.direction || "—"; const up = dir === "BULLISH", dn = dir === "BEARISH";
  const P = (v) => mcsN(v), pts = (v) => (v >= 0 ? "+" : "") + mcsN(v, 1);
  const atrX = (v) => (atr ? ` (${(Math.abs(v) / atr).toFixed(1)}× ATR)` : "");
  const stale = d.dataStale || (d.syncHealth?.overall && d.syncHealth.overall !== "LIVE");
  const R1 = lad.res[0], R2 = lad.res[1], R3 = lad.res[2], S1 = lad.sup[0], S2 = lad.sup[1], S3 = lad.sup[2];
  const lvTxt = (l) => (l ? `<b>${P(l.price)}</b> (${l.tag} ${mcsEsc(l.short)})` : "—");
  const ntz = ma?.noTradeZone; const inNtz = ntz?.active && ntz.low != null && spot >= ntz.low && spot <= ntz.high;
    const todayIst = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const expiry = d.optionMatrix?.expiry; const expDay = expiry && expiry === todayIst;

  // 1. verdict
  const tfs = [["5M", mtf.m5?.direction], ["15M", mtf.m15?.direction], ["1H", mtf.h1?.direction]].filter(([, v]) => v);
  const agree = tfs.filter(([, v]) => v === dir).map(([k]) => k), against = tfs.filter(([, v]) => v && v !== dir && v !== "NEUTRAL" && v !== "SIDEWAYS").map(([k]) => k);
  let verdict, vcls;
  if (stale) { verdict = `${dir} bias at the last close, but data is ${mcsEsc(d.syncHealth?.overall || "STALE")} — no new entry until live candles arrive.`; vcls = "wait"; }
  else if (inNtz) { verdict = `Price is inside the No-Trade Zone (${P(ntz.low)} – ${P(ntz.high)}) — WAIT for a clean break out of it.`; vcls = "wait"; }
  else if ((up || dn) && against.length === 0) { verdict = `${dir} — ${agree.join(" + ")} aligned. Market Command action: ${mcsEsc(tp.action || cf.action || "—")}.`; vcls = up ? "up" : "dn"; }
  else if (up || dn) { verdict = `${dir} lean, but ${against.join(" + ")} disagree${against.length === 1 ? "s" : ""} — counter-trend risk; trade only on confirmation. Action: ${mcsEsc(tp.action || cf.action || "—")}.`; vcls = "mixed"; }
  else { verdict = `No clear direction — range conditions. Action: ${mcsEsc(tp.action || cf.action || "WAIT")}.`; vcls = "wait"; }

  // 2. trend & structure
  const stack = e9 != null && e21 != null && e50 != null ? (e9 > e21 && e21 > e50 ? "bullish stack (EMA 9 > 21 > 50)" : e9 < e21 && e21 < e50 ? "bearish stack (EMA 9 < 21 < 50)" : "mixed EMAs (no clean stack)") : "EMAs unavailable";
  const trend = [
    `Timeframes: ${tfs.map(([k, v]) => `${k} <b class="${v === "BULLISH" ? "mcs-up" : v === "BEARISH" ? "mcs-dn" : ""}">${mcsEsc(v)}</b>`).join(" · ") || "—"}.`,
    `EMAs: ${stack}${e200 != null ? `; price ${spot >= e200 ? "above" : "below"} EMA 200 (${P(e200)})` : ""}.`,
    vwap != null ? `VWAP ${P(vwap)}: price is <b>${spot >= vwap ? "above" : "below"}</b> by ${mcsN(Math.abs(spot - vwap), 1)} pts — ${spot >= vwap ? "buyers in control of the session average" : "sellers in control of the session average"}.` : null,
    (mv.validation?.bullishEvidence?.length || mv.validation?.bearishEvidence?.length) ? `Evidence: ${[...(mv.validation.bullishEvidence || []).map((x) => "▲ " + mcsEsc(x)), ...(mv.validation.bearishEvidence || []).map((x) => "▼ " + mcsEsc(x))].join(" · ")}.` : null,
    mv.strengthEvidence ? `Strength: ${mcsEsc(mv.strength || "")} — ${mcsEsc(mv.strengthEvidence)}.` : null,
  ].filter(Boolean);

  // 3. location
  const loc = [
    S1 && R1 ? `Spot <b>${P(spot)}</b> sits between support ${lvTxt(S1)} ${pts(S1.price - spot)} pts and resistance ${lvTxt(R1)} ${pts(R1.price - spot)} pts — range ${mcsN(R1.price - S1.price, 1)} pts${atrX(R1.price - S1.price)}.` : `Spot <b>${P(spot)}</b>; ${R1 ? "nearest resistance " + lvTxt(R1) : "no resistance above"}; ${S1 ? "nearest support " + lvTxt(S1) : "no support below"}.`,
    S1 && R1 ? ((R1.price - spot) < (spot - S1.price) ? `Closer to resistance — little room for fresh longs here; a long has better reward near ${lvTxt(S1)}.` : `Closer to support — little room for fresh shorts here; a short has better reward near ${lvTxt(R1)}.`) : null,
  ].filter(Boolean);

  // 4. scenarios (if / then on real levels)
  const bull = R1 ? `If a <b>15M candle closes above ${P(R1.price)}</b> (${R1.tag} ${mcsEsc(R1.short)}) → next ${R2 ? lvTxt(R2) + " " + pts(R2.price - spot) : "no mapped level"}${R3 ? ", then " + lvTxt(R3) : ""}. Option side: <b>BUY CE</b>.` : "No resistance mapped above — no defined upside target.";
  const bear = S1 ? `If a <b>15M candle closes below ${P(S1.price)}</b> (${S1.tag} ${mcsEsc(S1.short)}) → next ${S2 ? lvTxt(S2) + " " + pts(S2.price - spot) : "no mapped level"}${S3 ? ", then " + lvTxt(S3) : ""}. Option side: <b>BUY PE</b>.` : "No support mapped below — no defined downside target.";
  const base = S1 && R1 ? `Until either break: range ${P(S1.price)} – ${P(R1.price)}. Mid-range entries have poor room — wait at the edges.` : null;
  const scen = [
    `<span class="mcs-sc up">BULL${up ? " · primary" : ""}</span> ${bull}`,
    `<span class="mcs-sc dn">BEAR${dn ? " · primary" : ""}</span> ${bear}`,
    base ? `<span class="mcs-sc mid">RANGE</span> ${base}` : null,
  ].filter(Boolean);

  // 5. no-trade zone
  const ntzTxt = !ma ? "Market Analysis data unavailable — No-Trade Zone not calculated."
    : ntz?.active ? `<b class="mcs-warn">ACTIVE ${P(ntz.low)} – ${P(ntz.high)}</b> (amber band on the chart). Why: ${(ntz.reasons || []).map((x) => mcsEsc(String(x).replace(/\.+$/, ""))).join("; ")}. ${inNtz ? "Price is <b>inside</b> it now." : `Price is ${spot > ntz.high ? "above" : "below"} it.`}`
    : `Not active — ${(ntz?.reasons || ["conditions tradeable"]).map((x) => mcsEsc(String(x).replace(/\.+$/, ""))).join("; ")}.`;

  // 6. options
  const ce = mcsOptLevels(MCS.opt.CE?.candles || []), pe = mcsOptLevels(MCS.opt.PE?.candles || []), k = mcsStrike();
  const optLine = (side, o) => o.ltp == null ? `${k} ${side}: premium candles not loaded.` : `${k} ${side} at <b>${P(o.ltp)}</b> → premium resistance ${o.res[0] ? `<b>${P(o.res[0].price)}</b> (${mcsEsc(o.res[0].short)})` : "none"}, support ${o.sup[0] ? `<b>${P(o.sup[0].price)}</b> (${mcsEsc(o.sup[0].short)})` : "none"}.`;
  const opts = [
    tp.preferredStrike ? `Market Command preferred strike: <b>${mcsEsc(tp.preferredStrike)}</b>${tp.alternativeStrike ? " (alt " + mcsEsc(tp.alternativeStrike) + ")" : ""}${d.syncHealth?.oi?.status === "STALE" ? ` — picked from the ${d.syncHealth.oi.dataTs ? mcsHm(d.syncHealth.oi.dataTs) : "stale"} option chain, so it may not match current ATM ${mcsAtm()}` : ""}.` : null,
    optLine("CE", ce), optLine("PE", pe),
    (() => { const f = mcsFastMove(); if (!f) return null; const b = [f.ce[0], f.pe[0]].filter(Boolean).sort((x, y) => y.total - x.total)[0]; if (!b) return null;
      return b.tier ? `Fast-move readiness: <b>${b.strike} ${b.side}</b> ${b.tier}${f.live ? "" : " (last session)"} ${b.total}/14 — ${b.pts.filter(([n]) => n > 0).map(([, w]) => mcsEsc(w)).join(", ")}.` : `Fast-move readiness: no strike shows pre-move signs (best ${b.strike} ${b.side} ${b.total}/14).`; })(),
    expDay ? `<b class="mcs-warn">Expiry today (${mcsEsc(expiry)})</b> — fast theta decay and high gamma: premiums can swing sharply both ways; keep size small and exits quick.` : expiry ? `Expiry ${mcsEsc(expiry)}.` : null,
  ].filter(Boolean);

  // 7. risk & data quality
  const em15 = ma?.movement?.expectedMove15m;
  const risk = [
    stale ? `Data: <b class="mcs-warn">${mcsEsc(d.syncHealth?.overall || "STALE")}</b> — last candle ${cs.length ? mcsHm(cs[cs.length - 1].time) : "—"}${d.syncHealth?.oi?.dataTs ? ", option chain " + mcsHm(d.syncHealth.oi.dataTs) : ""}.` : `Data: LIVE.`,
    d.vix?.available ? `India VIX ${P(d.vix.value)} (${mcsEsc(d.vixEnvironment?.environment || "—")}).` : null,
    atr ? `ATR(14, ${MCS.tf}) ${mcsN(atr, 1)} pts${em15 ? ` · model expected move next 15 min ±${mcsN(em15.pts, 1)} pts` : ""}.` : null,
    mcsFastMove()?.conflict ? `Direction conflict: ${mcsEsc(mcsFastMove().conflict)}.` : null,
    against.length && (up || dn) ? `${against.join(" + ")} against the bias — moves can reverse quickly at ${up ? "resistance" : "support"}.` : null,
  ].filter(Boolean);

  // 8. invalidation
  const inv = up ? (S1 ? `Bullish view is wrong on a 15M close below ${lvTxt(S1)}${lad.sl ? `; Market Command SL ${P(lad.sl.price)}` : ""}.` : null)
    : dn ? (R1 ? `Bearish view is wrong on a 15M close above ${lvTxt(R1)}${lad.sl ? `; Market Command SL ${P(lad.sl.price)}` : ""}.` : null)
    : `A 15M close outside ${S1 ? P(S1.price) : "—"} – ${R1 ? P(R1.price) : "—"} sets the next direction.`;

  const sec = (t, items) => `<div class="mcs-an-sec"><h5>${t}</h5><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
  box.innerHTML = `<h4>🧠 MARKET ANALYSIS — ${mcsEsc(nm)} <span class="mcs-sub">updated ${new Date().toLocaleTimeString("en-IN", { hour12: false })}</span></h4>
    <div class="mcs-verdict ${vcls}">${verdict}</div>
    <div class="mcs-an-grid">
      ${sec("1 · Trend & structure", trend)}
      ${sec("2 · Where price is", loc)}
      ${sec("3 · Scenarios — what to do if…", scen)}
      ${sec("4 · No-Trade Zone", [ntzTxt])}
      ${sec("5 · Options", opts)}
      ${sec("6 · Risk & data", risk.concat(inv ? [`<b>Invalidation:</b> ${inv}`] : []))}
    </div>
    <div class="mcs-sub">Built only from this screen's live engine outputs (Market Command, Market Analysis, option candles). Rule-based read — not a prediction or probability. Advisory only; no orders.</div>`;
}

function mcsLiveOnly(id) {
  const b = mcsEl(id); if (!b) return;
  if (id === "mcs-optCE" || id === "mcs-optPE") {
    // Dispose the option chart cleanly: stop its resize watcher and zone overlay first.
    const side = id.slice(-2); const oc = MCS.oc && MCS.oc[side];
    if (oc) { oc.disposed = true; try { oc.ro && oc.ro.disconnect(); } catch (_) {} if (oc.zones) { oc.zones.disposed = true; try { oc.zones.ro && oc.zones.ro.disconnect(); } catch (_) {} } try { oc.ch.remove(); } catch (_) {} MCS.oc[side] = null; }
  }
  b.innerHTML = `<div class="mcs-liveonly">🧪 Testing mode — this section needs live data (option chain, premiums, Greeks, Market Analysis) that does not exist for past dates. Switch to 🟢 LIVE to see it.</div>`;
}
function mcsRenderAll() {
  if (MCS.mode === "TEST") {
    mcsStable(() => { mcsRenderHeader(); mcsRenderChart(); mcsRenderLvTable(); mcsRenderKeyRow(); mcsRenderSetups();
      ["mcs-optlv", "mcs-analysis", "mcs-fast", "mcs-strikes", "mcs-optCE", "mcs-optPE", "mcs-next5", "mcs-next15", "mcs-movers", "mcs-chain", "mcs-topmove", "mcs-cmd"].forEach(mcsLiveOnly); });
    return;
  }
  mcsStable(() => { mcsRenderHeader(); mcsRenderChart(); mcsRenderLvTable(); mcsRenderOptLv(); mcsRenderKeyRow(); mcsRenderSetups(); mcsRenderAnalysis(); mcsRenderLevels(); mcsRenderFast(); mcsRenderStrikes(); mcsRenderOpt("CE"); mcsRenderOpt("PE");
  mcsRenderNext(5); mcsRenderNext(15); mcsRenderMovers(); mcsRenderChain(); mcsRenderTopMove(); mcsRenderCmd(); });
}

async function mcsRefresh(force) {
  if (MCS.busy) { MCS._pending = true; return; }
  MCS.busy = true; MCS._pending = false;
  const sym = MCS.sym, tf = MCS.tf, gen = MCS.gen;
  if (MCS.mode === "TEST") { try { await mcsRefreshTest(gen); } catch (e) { console.error("[MCS test]", e); } finally { MCS.busy = false; if (MCS._pending) { MCS._pending = false; mcsRefresh(true); } } return; }
  try {
    const [d, q] = await Promise.all([
      fetchJSON(`/api/market-command?symbol=${encodeURIComponent(sym)}&interval=${tf}`, 45000).catch(() => null),
      fetchJSON(`/api/quotes?symbols=${encodeURIComponent(MCS_SYMS.map((x) => x[0]).join(","))}`, 20000).catch(() => null),
    ]);
    // Setup signals (your rejection / VWAP logic) — loaded alongside, never blocks the chart.
    fetchJSON(`/api/setup-signals?symbol=${encodeURIComponent(sym)}`, 45000).catch(() => null).then((ss) => {
      if (sym !== MCS.sym || gen !== MCS.gen || MCS.mode !== "LIVE") return;
      if (ss && !ss.error) MCS.ss = ss; else if (!MCS.ss || MCS.ss.symbol !== sym) MCS.ss = { error: ss?.error || (ss?.disabled ? "Data paused (Data Control)" : "unavailable"), symbol: sym };
      mcsStable(() => { mcsRenderSetups(); mcsRenderChart(); });
    });
    if (sym !== MCS.sym || tf !== MCS.tf || gen !== MCS.gen || MCS.mode !== "LIVE") return;   // user switched (symbol / tf / mode) — never paint stale results
    if (d && !d.error) MCS.d = d; else if (!MCS.d) { const m = mcsEl("mcs-meta"); if (m) m.innerHTML = `<span class="mcs-warn">${mcsEsc(d?.error || "Market Command data unavailable")}</span>`; }
    if (q && q.quotes) MCS.q = q;
    mcsRenderAll();   // paint chart / levels / command as soon as Market Command data is in
    const maP = (force || Date.now() - MCS.maAt > 30_000)
      ? fetchJSON(`/api/market-analysis?symbol=${encodeURIComponent(sym)}`, 45000).catch(() => null).then((ma) => {
          if (sym === MCS.sym && gen === MCS.gen && MCS.mode === "LIVE" && ma && !ma.error) { MCS.ma = ma; MCS.maAt = Date.now(); mcsStable(() => { mcsRenderChart(); mcsRenderAnalysis(); mcsRenderLevels(); mcsRenderFast(); mcsRenderStrikes(); mcsRenderNext(5); mcsRenderNext(15); mcsRenderMovers(); mcsRenderChain(); mcsRenderTopMove(); }); }
        })
      : Promise.resolve();
    const optP = mcsLoadOptions(force).then(() => { if (sym === MCS.sym && gen === MCS.gen && MCS.mode === "LIVE") mcsStable(() => { mcsRenderOpt("CE"); mcsRenderOpt("PE"); mcsRenderOptLv(); mcsRenderAnalysis(); }); });
    await Promise.all([maP, optP]);
  } catch (e) { console.error("[MCS]", e); }
  finally { MCS.busy = false; if (MCS._pending) { MCS._pending = false; mcsRefresh(true); } }
}

function initMcSummary() {
  const mcSym = typeof MC !== "undefined" && MC.sym && MCS_SYMS.some((x) => x[0] === MC.sym) ? MC.sym : null;   // follow Market Command's index
  if (!MCS.init) { MCS.init = true; if (mcSym) MCS.sym = mcSym; mcsShell(); }
  else if (mcSym && mcSym !== MCS.sym) {
    MCS.sym = mcSym; MCS.d = null; MCS.ma = null; MCS.maAt = 0; MCS.optKey = null; MCS._fit = null; MCS.selStrike = null;
    document.querySelectorAll("#mcs-syms .mcs-chip").forEach((x) => x.classList.toggle("on", x.dataset.sym === mcSym));
  }
  // Paint immediately from the payload Market Command already holds (same symbol, live,
  // same /api/market-command result — no extra fetch); the refresh below then updates it.
  const seed = MCS.mode === "LIVE" && typeof MC !== "undefined" && !MC.replayDate ? MC.lastData : null;
  if (seed && !seed.error && seed.symbol === MCS.sym && seed.candles?.length) {
    if (!MCS.d) { MCS.tf = MC.tf; document.querySelectorAll("#mcs-tfs .mcs-tf").forEach((x) => x.classList.toggle("on", x.dataset.tf === MCS.tf)); }
    if (MCS.tf === MC.tf && (!MCS.d || MCS.d.symbol !== MCS.sym)) { MCS.d = seed; mcsRenderAll(); }
  }
  if (!MCS.d) mcsLoading();
  mcsRefresh(true);
  if (MCS.timer) clearInterval(MCS.timer);
  MCS.timer = setInterval(() => {
    const p = mcsEl("panel-mcsummary");
    if (!p || !p.classList.contains("active") || document.hidden) return;   // only while the Summary is on screen
    if (MCS.mode !== "LIVE") return;                                       // TESTING mode: live refresh stopped
    mcsRefresh(false);
  }, 15000);
}


// ===========================================================================
// TOP SECTION (design: chart · Levels in price order · Options) + key-level row.
// One level list feeds the chart lines AND the table, so both always agree.
// R#/S# numbering = the same ladder the analysis / next-5 / next-15 cards use;
// indicator and session levels (VWAP, EMA, PDC, day high/low, system targets)
// are listed unnumbered. Every value comes from the Market Command payload.
// ===========================================================================
const MCS_LV_COL = { resistance: "#ea3943", support: "#16c784", pdhl: "#64748b", orb: "#0ea5e9", swing: "#a855f7", bos: "#dc2626", choch: "#a855f7", sweep: "#f0b90b", pivot: "#94a3b8", vwap: "#22c55e", ema21: "#facc15", ema50: "#6366f1", day: "#0891b2", target: "#ea3943" };
function mcsLevelList(d) {
  if (!d || d.spot == null) return [];
  const spot = d.spot, s = mcsSessionStats(), lad = mcsSpotLadder(d), ov = d.overlays || {};
  const lastv = (a) => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
  const out = [];
  const colOf = (l) => (l.kind === "orb" || l.kind === "pdhl" || l.kind === "swing" || l.kind === "bos" || l.kind === "choch" || l.kind === "sweep" || l.kind === "pivot") ? MCS_LV_COL[l.kind] : MCS_LV_COL[l.side];
  const pretty = (sh) => String(sh).replace(/^Piv /, "Pivot ").replace(/^Strong R$/, "Strong Resistance").replace(/^Strong S$/, "Strong Support").replace(/^R$/, "Resistance").replace(/^S$/, "Support");
  for (const l of [...lad.res, ...lad.sup]) out.push({ kind: "ladder", sub: l.kind, side: l.side, price: l.price, chip: `${l.tag} ${l.short}`, name: `${l.tag} · ${pretty(l.short)}`, source: l.type, color: colOf(l) });
  const near = (p) => out.some((x) => Math.abs(x.price - p) <= spot * 0.0002);
  const add = (kind, name, chip, price, source, color) => { if (price == null || !isFinite(price) || near(price)) return; out.push({ kind, side: price > spot ? "resistance" : "support", price: Math.round(price * 100) / 100, chip, name, source, color }); };
  if (s) { add("day", "Today High", "TH", s.high, "Today's high", MCS_LV_COL.day); add("day", "Today Low", "TL", s.low, "Today's low", MCS_LV_COL.day); add("pdc", "PDC", "PDC", s.prevClose, "Previous day close", MCS_LV_COL.pdhl); }
  add("ind", "VWAP", "VWAP", lastv(ov.vwap), "VWAP (session)", MCS_LV_COL.vwap);
  add("ind", "EMA 21", "EMA 21", lastv(ov.ema21), `EMA 21 (${MCS.tf})`, MCS_LV_COL.ema21);
  add("ind", "EMA 50", "EMA 50", lastv(ov.ema50), `EMA 50 (${MCS.tf})`, MCS_LV_COL.ema50);
  // System targets only while the arbiter has a live trade plan (never invented).
  const x = d.decision, live = x && (x.finalAction === "BUY_CE" || x.finalAction === "BUY_PE" || x.finalAction === "HOLD") && x.plan;
  if (live) { add("target", "Target 1", "T1", x.plan.target1, "System target (FINAL DECISION)", MCS_LV_COL.target); add("target", "Target 2", "T2", x.plan.target2, "System target (FINAL DECISION)", MCS_LV_COL.target); }
  return out.sort((a, b) => b.price - a.price);
}
// ACTIVE / TESTED (touched today) / BROKEN (crossed since the open) — from today's real candles.
function mcsLevelStatus(l, d) {
  const cs = d.candles || []; if (!cs.length) return "—";
  const t0 = mcsIstDay(cs[cs.length - 1].time), td = cs.filter((c) => mcsIstDay(c.time) === t0);
  if (l.kind === "ind") return "LIVE";
  if (l.kind === "day") return l.name === "Today High" ? "DAY HIGH" : "DAY LOW";
  if (!td.length) return "ACTIVE";
  const tol = d.spot * 0.0002, open = td[0].open;
  if ((open - l.price) * (d.spot - l.price) < 0) return "BROKEN";
  return td.some((c) => c.low <= l.price + tol && c.high >= l.price - tol) ? "TESTED" : "ACTIVE";
}
function mcsRenderLvTable() {
  const box = mcsEl("mcs-lvtable"); const d = MCS.d; if (!box) return;
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  if (!d || d.spot == null) { box.innerHTML = `<h4>${mcsEsc(nm)} LEVELS (Price Order)</h4>${UNAV}`; return; }
  const live = d.syncHealth?.overall || (d.dhanLive ? "LIVE" : "—");
  const L = mcsLevelList(d), above = L.filter((l) => l.price > d.spot), below = L.filter((l) => l.price <= d.spot);
  const row = (l, i) => { const st = mcsLevelStatus(l, d), dl = l.price - d.spot;
    return `<tr><td>${i}</td><td><span class="mcs-chipl" style="background:${l.color}">${mcsEsc(l.name)}</span></td><td class="r"><b>${mcsN(l.price)}</b></td>
      <td class="r ${dl > 0 ? "mcs-up" : "mcs-dn"}">${dl > 0 ? "+" : ""}${mcsN(dl)}</td><td class="mcs-src">${mcsEsc(l.source)}</td><td><span class="mcs-st ${st.toLowerCase().replace(/\s/g, "")}">${st}</span></td></tr>`; };
  let n = 0;
  box.innerHTML = `<h4>${mcsEsc(nm)} LEVELS <span class="mcs-sub">(Price Order)</span> <span class="mcs-live ${String(live).toLowerCase()}">● ${mcsEsc(live)}</span></h4>
    <div class="mcs-tblwrap mcs-lvwrap"><table class="mcs-tbl mcs-lvt"><thead><tr><th>#</th><th>Level Type</th><th class="r">Price</th><th class="r">Δ from LTP</th><th>Source</th><th>Status</th></tr></thead><tbody>
    ${above.map((l) => row(l, ++n)).join("")}
    <tr class="mcs-cur"><td>${++n}</td><td><span class="mcs-chipl cur">CURRENT PRICE</span></td><td class="r"><b>${mcsN(d.spot)}</b></td><td class="r">—</td><td>—</td><td><span class="mcs-st cur">CURRENT</span></td></tr>
    ${below.map((l) => row(l, ++n)).join("")}
    </tbody></table></div>
    <div class="mcs-sub">BROKEN = crossed since today's open · TESTED = touched today · R/S numbering = the same ladder the analysis below uses.</div>`;
  const w = box.querySelector(".mcs-lvwrap"), cur = box.querySelector(".mcs-cur");
  if (w && cur && MCS._lvCentered !== MCS.sym) { w.scrollTop = Math.max(0, cur.offsetTop - w.clientHeight / 2); MCS._lvCentered = MCS.sym; }
}
// Options panel: premium R/S of the selected (default ATM) strike's CE and PE from their own candles.
function mcsRenderOptLv() {
  const box = mcsEl("mcs-optlv"); const d = MCS.d; if (!box) return;
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  const m = d?.optionMatrix, k = mcsStrike(), atm = mcsAtm();
  if (!m || !m.available || k == null) { box.innerHTML = `<h4>${mcsEsc(nm)} OPTIONS</h4>${UNAV}`; return; }
  const key = `${MCS.sym}|${k}|${m.expiry}|${MCS.tf}`, ok = MCS.opt.key === key;
  const lv = { CE: mcsOptLevels(ok ? MCS.opt.CE?.candles || [] : []), PE: mcsOptLevels(ok ? MCS.opt.PE?.candles || [] : []) };
  const ladder = (side) => {
    const o = lv[side]; if (o.ltp == null) return `<div class="mcs-sub">${ok && MCS.opt[side]?.error ? mcsEsc(MCS.opt[side].error) : "Loading premium candles…"}</div>`;
    const res = o.res.slice(0, 3).reverse(), sup = o.sup.slice(0, 2);
    return `<table class="mcs-tbl mcs-oplad"><thead><tr><th>Level</th><th class="r">Price</th></tr></thead><tbody>
      ${res.map((l) => `<tr title="${mcsEsc(l.type)}"><td class="mcs-dn"><b>${l.tag}</b></td><td class="r">${mcsN(l.price)}</td></tr>`).join("")}
      <tr class="mcs-cur"><td><b>Current</b></td><td class="r"><b>${mcsN(o.ltp)}</b></td></tr>
      ${sup.map((l) => `<tr title="${mcsEsc(l.type)}"><td class="mcs-up"><b>${l.tag}</b></td><td class="r">${mcsN(l.price)}</td></tr>`).join("")}</tbody></table>`;
  };
  const detail = (side) => {
    const o = lv[side]; if (o.ltp == null) return "";
    const rows = [...o.res.slice(0, 2).reverse().map((l) => [l.tag, l.price, l.type, "mcs-dn"]), ["Current", o.ltp, "LTP (latest candle)", "cur"], ...o.sup.slice(0, 2).map((l) => [l.tag, l.price, l.type, "mcs-up"])];
    return `<div class="mcs-opdet"><h5>${side} LEVELS <span class="mcs-sub">(${k === atm ? "ATM " : ""}${k})</span></h5><table class="mcs-tbl"><thead><tr><th>Type</th><th class="r">Price</th><th>Source</th></tr></thead><tbody>
      ${rows.map(([t, p, src, c]) => `<tr class="${c === "cur" ? "mcs-cur" : ""}"><td class="${c === "cur" ? "" : c}"><b>${t}</b></td><td class="r">${mcsN(p)}</td><td class="mcs-src">${mcsEsc(src)}</td></tr>`).join("")}</tbody></table></div>`;
  };
  box.innerHTML = `<h4>${mcsEsc(nm)} OPTIONS <span class="mcs-sub">${k === atm ? "ATM" : "Strike"}: <b>${k}</b> · Expiry: <b>${mcsEsc(m.expiry || "—")}</b></span></h4>
    <div class="mcs-op2"><div class="mcs-opcol ce"><div class="mcs-ophd ce">CALL (CE)</div>${ladder("CE")}</div><div class="mcs-opcol pe"><div class="mcs-ophd pe">PUT (PE)</div>${ladder("PE")}</div></div>
    ${detail("CE")}${detail("PE")}
    <div class="mcs-sub">Premium levels from each option's own candles (previous day, today, opening range, VWAP, swings). Pick another strike in the Option List below.</div>`;
}
// Bottom row: Today's key levels · Previous day · Structure · OI · Quick stats.
function mcsRenderKeyRow() {
  const box = mcsEl("mcs-keyrow"); const d = MCS.d; if (!box) return;
  if (!d || d.spot == null) { box.innerHTML = ""; return; }
  const s = mcsSessionStats() || {}, lv = d.levels || {}, oi = d.oi || {};
  const px = (v) => (v == null ? null : typeof v === "number" ? v : v.strike ?? null);
  const kv = (k, v, cls = "", extra = "") => `<div><span>${k}</span><b class="${cls}">${v == null ? "—" : typeof v === "number" ? mcsN(v) : v}</b>${extra}</div>`;
  // Structure: latest swing high / low (today and before), equal highs/lows (two swings within 0.03%), last BOS.
  const sw = d.structure?.swingPoints || [];
  const swH = [...sw].reverse().find((p) => p.type === "HH" || p.type === "LH"), swL = [...sw].reverse().find((p) => p.type === "HL" || p.type === "LL");
  const tol = d.spot * 0.0003;
  // Equal high/low = two swing points within 0.03% that price has NOT traded through since (still resting liquidity).
  const csAll = d.candles || [];
  const eq = (hi) => { const pts = sw.filter((p) => (hi ? p.type === "HH" || p.type === "LH" : p.type === "HL" || p.type === "LL")).slice(-8);
    for (let i = pts.length - 1; i > 0; i--) for (let j = i - 1; j >= 0; j--) {
      if (Math.abs(pts[i].price - pts[j].price) > tol) continue;
      const lvl = hi ? Math.max(pts[i].price, pts[j].price) : Math.min(pts[i].price, pts[j].price);
      const later = csAll.filter((c) => c.time > pts[i].time);
      if (later.every((c) => (hi ? c.high <= lvl : c.low >= lvl))) return lvl;
    }
    return null; };
  const eqh = eq(true), eql = eq(false);
  const atr = mcsAtr(mcsClosed(d.candles || []));
  const chg = s.prevClose != null ? d.spot - s.prevClose : null;
  const card = (t, body) => `<section class="mcs-card mcs-kcard"><h4>${t}</h4><div class="mcs-kvs">${body}</div></section>`;
  const sR = px(lv.strongResistance), sS = px(lv.strongSupport);
  box.innerHTML =
    card("TODAY'S KEY LEVELS", kv("Today High (TH)", s.high, "mcs-dn") + kv("Today Low (TL)", s.low, "mcs-up") + kv("Opening Range High", px(lv.orbHigh)) + kv("Opening Range Low", px(lv.orbLow))) +
    card("PREVIOUS DAY LEVELS", kv("Previous Day High (PDH)", px(lv.pdh) ?? s.prevHigh, "mcs-dn") + kv("Previous Day Low (PDL)", px(lv.pdl) ?? s.prevLow, "mcs-up") + kv("Previous Close (PDC)", s.prevClose)) +
    card("STRUCTURE LEVELS", kv("Swing High (SWH)", swH ? swH.price : null, "mcs-dn") + kv("Swing Low (SWL)", swL ? swL.price : null, "mcs-up") + kv("Equal High (EQH)", eqh ?? "none") + kv("Equal Low (EQL)", eql ?? "none") + kv("BOS Level", d.bos?.price ?? null, d.bos?.direction === "BULLISH" ? "mcs-up" : "mcs-dn", d.bos ? ` <em>${mcsEsc(d.bos.direction || "")} ${mcsEsc(d.bos.stage || "")}</em>` : "")) +
    card("OI LEVELS", kv("OI Resistance", oi.resistance ?? null, "mcs-dn") + kv("OI Support", oi.support ?? null, "mcs-up") + kv("Max Call OI Strike", sR, "", lv.strongResistance?.oi ? ` <em>${mcsL(lv.strongResistance.oi)}</em>` : "") + kv("Max Put OI Strike", sS, "", lv.strongSupport?.oi ? ` <em>${mcsL(lv.strongSupport.oi)}</em>` : "") + kv("PCR", oi.pcr != null ? mcsN(oi.pcr) : null) + (oi.maxPain != null ? kv("Max Pain", oi.maxPain) : "")) +
    card("QUICK STATS", kv("LTP", d.spot) + kv("Change", chg != null ? `${chg >= 0 ? "+" : ""}${mcsN(chg)} (${mcsPct((chg / s.prevClose) * 100)})` : null, mcsCls(chg)) + kv("Day Range", s.low != null ? `${mcsN(s.low)} – ${mcsN(s.high)}` : null) + kv("ATR (14) · closed candles", atr != null ? mcsN(atr) : null) + kv("Volatility", d.vix?.available ? `${mcsEsc(d.vixEnvironment?.environment || "—")} · VIX ${mcsN(d.vix.value)}` : null));
}


// ===========================================================================
// SETUP SIGNALS — the trader's rejection / VWAP logic (advisory). Shows the live
// signal with its option plan, the level watch list, today's signals (and why the
// others were blocked) and a 20-session replay. The FINAL DECISION is unchanged.
// ===========================================================================
function mcsRenderSetups() {
  const box = mcsEl("mcs-setups"); if (!box) return;
  const ss = MCS.ss, nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  const head = `<h4>🎯 SETUP SIGNALS — ${mcsEsc(nm)} <span class="mcs-sub">your rejection &amp; VWAP logic · S3 Level Rejection (Setup 1 morning / Setup 2 extreme) · S4 VWAP Trend Pullback (Setup 3) · S5 EMA Trend</span>
    <span class="mcs-ssadv">Advisory — the FINAL DECISION and paper engine are unchanged</span></h4>`;
  if (!ss || ss.symbol !== MCS.sym) { box.innerHTML = head + `<div class="mcs-sub">Loading setup signals…</div>`; return; }
  if (ss.error) { box.innerHTML = head + `<div class="mcs-na">${mcsEsc(ss.error)}</div>`; return; }
  const t = ss.today || { signals: [], watch: [] };
  const vb = t.vwapBias;
  const dr = t.direction, evs = t.directionEvents || [];
  const dCls = (st) => (st === "UP" ? "up" : st === "DOWN" ? "dn" : "");
  const fltTxt = { off: "S5 trend filter: none", notAgainst: "S5 trend filter: 15M must not be against", agree: "S5 trend filter: 15M must agree", slow5m: "S5 trend filter: 5m EMA 21 vs 50 must not be against" }[ss.s5Filter || "off"];
  const dirHtml = dr ? `<div class="mcs-ssdir ${dCls(dr.state)}">Direction (EMA): <b>${dr.state}</b>${dr.since ? ` since ${mcsEsc(dr.since)}` : ""} <span class="mcs-sub">${mcsEsc(dr.why)} · <b>${mcsEsc(fltTxt)}</b></span>
      ${evs.length ? `<div class="mcs-dirline">${evs.map((e) => `<span class="mcs-dirchip ${dCls(e.to)}" title="${mcsEsc(e.why)}">${mcsEsc(e.time)} → ${mcsEsc(e.to)}</span>`).join("")}</div>` : ""}</div>` : "";
  if (ss.mode !== "TEST") mcsDirAlert(ss.symbol, nm, evs);
  const ef = t.efficiency;
  const efHtml = ef ? `<div class="mcs-sseff ${ef.choppy ? "chop" : "ok"}">Day efficiency <b>${mcsN(ef.value, 2)}</b> <span class="mcs-sub">(${mcsEsc(ef.time)} · net move ÷ distance travelled since the open · checked every 5 min)</span>
      <b class="mcs-effstate">${ef.choppy ? `⛔ CHOPPY — below ${(ss.config && ss.config.chopEfficiencyMin) || 0.2}: no new entries` : "✅ moving — entries allowed"}</b>
      <span class="mcs-effbar" title="${mcsEsc(ef.series.map((p) => `${p.time} ${p.value}`).join("\n"))}">${ef.series.map((p) => `<i class="${p.choppy ? "c" : "o"}" style="height:${Math.max(2, Math.round(Math.min(1, p.value) * 18))}px"></i>`).join("")}</span></div>` : "";
  const vbHtml = dirHtml + efHtml + (vb ? `<div class="mcs-ssvb ${vb.bias === "BULLISH" ? "up" : vb.bias === "BEARISH" ? "dn" : ""}">VWAP bias: <b>${vb.bias}</b> <span class="mcs-sub">5m candle ${vb.time} closed ${mcsN(vb.close)} ${vb.bias === "BULLISH" ? "above" : vb.bias === "BEARISH" ? "below" : "at"} VWAP ${mcsN(vb.vwap)} · 15M trend ${mcsEsc(t.dir15 || "—")}</span></div>` : "");
  const valid = t.signals.filter((x) => !x.blockedBy), blocked = t.signals.filter((x) => x.blockedBy);
  const live = valid.find((x) => x.status === "ENTRY_READY" || x.status === "ACTIVE");
  const setupName = (x) => ({ S3_LEVEL_REJECTION: "S3", S4_VWAP_PULLBACK: "S4", S5_EMA_TREND: "S5" }[x.setup] || x.setup);
  const stCls = (st) => ({ TARGET: "win", STOP: "loss", TIME_EXIT: "flat", EOD_EXIT: "flat", ACTIVE: "act", ENTRY_READY: "act", EXTENDED: "flat", NO_TRIGGER: "flat", BLOCKED: "blk" }[st] || "");
  // --- live box ---
  let liveHtml;
  if (live) {
    const p = live.plan || {}, o = live.option;
    const opt = !o ? `<div class="mcs-sub">Option plan loading…</div>`
      : o.available ? `<div class="mcs-ssopt ${o.valid ? "" : "bad"}"><b>${mcsEsc(nm)} ${o.strike} ${o.side}</b> <span class="mcs-sub">${mcsEsc(o.expiry || "")}${o.verified ? " · verified" : ""}</span>
          · Entry <b>₹${mcsN(o.entry)}</b> · SL <b class="mcs-dn">₹${mcsN(o.stopLoss)}</b> · Target <b class="mcs-up">₹${mcsN(o.target)}</b> · R:R after costs <b>1:${mcsN(o.netRR)}</b> · Δ ${o.delta != null ? mcsN(Math.abs(o.delta), 2) : "—"} · IV ${o.iv != null ? mcsN(o.iv, 1) : "—"}
          ${o.reason ? `<div class="mcs-warn">⚠ ${mcsEsc(o.reason)} — option not valid, treat as WAIT</div>` : ""}${o.note ? `<div class="mcs-sub">${mcsEsc(o.note)}</div>` : ""}</div>`
      : `<div class="mcs-warn">Option: ${mcsEsc(o.reason || "unavailable")}</div>`;
    liveHtml = `<div class="mcs-sslive ${live.side === "CE" ? "ce" : "pe"}">
      <div class="mcs-ssbig">${ss.mode === "TEST" ? `<span class="mcs-testtag">TEST ${mcsEsc(ss.upto)}</span> ` : ""}${live.status === "ACTIVE" ? "IN TRADE · " : ""}BUY ${live.side}</div>
      <div><b>${mcsEsc(live.label)}</b> <span class="mcs-sub">${live.time} ${live.level ? `· ${mcsEsc(live.level.type)} ${mcsN(live.level.price)}` : ""}</span></div>
      <div class="mcs-ssplan">Spot: entry ${p.entry != null ? mcsN(p.entry) : (live.metrics && live.metrics.sigHigh != null ? `on a break ${live.side === "CE" ? "above " + mcsN(live.metrics.sigHigh) : "below " + mcsN(live.metrics.sigLow)} (within 2 candles, else cancelled)` : `next candle open (≈ ${mcsN(p.entryRef)})`)} · SL <b class="mcs-dn">${mcsN(p.stop)}</b> · Target <b class="mcs-up">${mcsN(p.target)}</b> <span class="mcs-sub">(${mcsEsc(p.targetWhy || "")}, 1:${mcsN(p.rr)})</span></div>
      ${p.book != null ? `<div class="mcs-ssplan">Book <b>50% at ${mcsN(p.book)}</b> (1.5R) · rest trails <b>EMA 9</b> after +1R${p.finalTarget != null ? ` · final target ${mcsN(p.finalTarget)}` : ""}${live.metrics && live.metrics.booked ? ` · <b class="mcs-up">✅ 50% booked ${mcsEsc(live.metrics.bookTime || "")}</b>` : ""}</div>` : ""}
      ${opt}
      <ul class="mcs-ssev">${live.evidence.map((e) => `<li>${mcsEsc(e)}</li>`).join("")}</ul></div>`;
  } else {
    liveHtml = `<div class="mcs-sslive none"><div class="mcs-ssbig">WAIT</div><div class="mcs-sub">${ss.mode === "TEST" ? `No signal open at ${mcsEsc(ss.upto)} on ${mcsEsc(ss.date)} (testing).` : ss.isToday ? "No setup signal is live right now." : `Market closed — showing ${mcsEsc(ss.date)}.`}</div>
      ${t.watch.length ? `<div class="mcs-sswatch">${t.watch.map((w) => `<span class="mcs-sswc ${w.state.toLowerCase()}" title="${mcsEsc(w.note)}">${mcsEsc(w.state.replace(/_/g, " "))} · ${mcsEsc(w.level)} ${mcsN(w.price)} <i>${w.side === "RESISTANCE" ? "res → PE" : "sup → CE"}</i></span>`).join("")}</div>` : `<div class="mcs-sub">No level being approached.</div>`}</div>`;
  }
  // --- today's list ---
  const resCls = (x) => (x.resultR != null ? (x.resultR > 0.05 ? "win" : x.resultR < -0.05 ? "loss" : "flat") : stCls(x.status));
  const row = (x) => `<tr class="${resCls(x)}"><td>${x.time}</td><td>${setupName(x)} <i>${mcsEsc(x.context)}</i></td><td class="${x.side === "CE" ? "mcs-up" : "mcs-dn"}"><b>${x.side}</b></td>
    <td>${x.level ? `${mcsEsc(x.level.type)} ${mcsN(x.level.price)}` : x.setup === "S5_EMA_TREND" ? "EMA 9 trend pullback" : "VWAP pullback"}</td><td class="r">${x.plan ? mcsN(x.plan.entry ?? x.plan.entryRef) : "—"}</td><td class="r">${x.plan ? mcsN(x.plan.stop) : "—"}</td><td class="r">${x.plan ? mcsN(x.plan.target) : "—"}</td>
    <td><span class="mcs-ssst ${resCls(x)}">${mcsEsc(x.status.replace("_", " "))}</span>${x.metrics && x.metrics.booked ? ' <i class="mcs-sub">50% booked</i>' : ""}</td><td class="r ${mcsCls(x.resultR)}">${x.resultR != null ? (x.resultR > 0 ? "+" : "") + mcsN(x.resultR, 2) + "R" : "—"}</td></tr>`;
  const todayTbl = valid.length ? `<table class="mcs-tbl mcs-sstbl"><thead><tr><th>Time</th><th>Setup</th><th>Side</th><th>Level</th><th class="r">Entry</th><th class="r">SL</th><th class="r">Target</th><th>Status</th><th class="r">Result</th></tr></thead><tbody>${valid.map(row).join("")}</tbody></table>` : `<div class="mcs-sub">No valid signal today.</div>`;
  const blk = blocked.length ? `<details class="mcs-ssblk"><summary>Blocked today (${blocked.length}) — why the logic said WAIT</summary><table class="mcs-tbl"><tbody>${blocked.slice(0, 40).map((x) => `<tr><td>${x.time}</td><td>${setupName(x)}</td><td>${x.side}</td><td>${x.level ? mcsEsc(x.level.type) + " " + mcsN(x.level.price) : "VWAP"}</td><td class="mcs-src" style="max-width:none">${mcsEsc(x.blockedBy)}</td></tr>`).join("")}</tbody></table></details>` : "";
  // --- replay ---
  const rp = ss.replay || {}, by = rp.bySetup || {};
  const rpRow = (k, n) => { const v = by[k]; if (!v) return `<tr><td><b>${n}</b></td><td colspan="6" class="mcs-sub">no signals</td></tr>`;
    const wr = v.signals ? Math.round((v.wins / v.signals) * 100) : null;
    return `<tr><td><b>${n}</b></td><td class="r">${v.signals}</td><td class="r">${v.wins}/${v.losses}</td><td class="r">${wr != null ? wr + "%" : "—"}</td><td class="r ${mcsCls(v.avgR)}">${v.avgR != null ? (v.avgR > 0 ? "+" : "") + mcsN(v.avgR, 2) + "R" : "—"}</td><td class="r ${mcsCls(v.totalR)}">${(v.totalR > 0 ? "+" : "") + mcsN(v.totalR, 2)}R</td>
      <td class="mcs-src" style="max-width:none">${Object.entries(v.byContext).map(([c, x]) => `${mcsEsc(c)} ${x.n} (${x.avgR > 0 ? "+" : ""}${mcsN(x.avgR, 2)}R)`).join(" · ")}</td></tr>`; };
  const replayHtml = `<div class="mcs-ssrp"><h5>Last ${rp.sessions || 0} sessions — how this logic would have done <span class="mcs-sub">${mcsEsc(rp.note || "")}</span></h5>
    <table class="mcs-tbl"><thead><tr><th>Setup</th><th class="r">Signals</th><th class="r">Win/Loss</th><th class="r">Win %</th><th class="r">Avg</th><th class="r">Total</th><th>By context</th></tr></thead><tbody>
    ${rpRow("S3_LEVEL_REJECTION", "S3 Level Rejection")}${rpRow("S4_VWAP_PULLBACK", "S4 VWAP Pullback")}${rpRow("S5_EMA_TREND", "S5 EMA Trend")}</tbody></table>
    <div class="mcs-sub">Most common blocks: ${["S3_LEVEL_REJECTION", "S4_VWAP_PULLBACK", "S5_EMA_TREND"].map((k) => by[k] ? `${k.slice(0, 2)}: ${by[k].topBlocks.slice(0, 3).map(([r, n]) => `${mcsEsc(r)} (${n})`).join(", ")}` : "").filter(Boolean).join(" · ")}</div></div>`;
  const an = ss.mode === "TEST" ? ss.analysis : null;
  const anHtml = an ? mcsMovesHtml(an, `Logic vs market — ${mcsEsc(ss.date)} (full day)`) : ss.mode === "TEST" ? `<div class="mcs-sub">Logic-vs-market analysis appears when the run reaches 15:15 (full day).</div>` : "";
  box.innerHTML = head + vbHtml + `<div class="mcs-ssgrid">${liveHtml}<div class="mcs-sstoday"><h5>${ss.mode === "TEST" ? `Signals on ${mcsEsc(ss.date)} up to ${mcsEsc(ss.upto)}` : `Today's signals ${ss.isToday ? "" : `(${mcsEsc(ss.date)})`}`}</h5>${todayTbl}${blk}</div></div>${ss.mode === "TEST" ? anHtml : replayHtml}
    <div class="mcs-sub">${(ss.notes || []).map(mcsEsc).join(" · ")}</div>`;
}


// ===========================================================================
// LIVE / TESTING modes. Switching bumps MCS.gen so any response still in flight
// from the other mode is discarded; all cached data of the old mode is cleared.
// ===========================================================================
function mcsPrevWeekday() { const d = new Date(Date.now() + 19800000); do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); return d.toISOString().slice(0, 10); }
function mcsSetMode(mode) {
  if (mode !== "LIVE" && mode !== "TEST") return;
  if (MCS.mode === mode) return;
  mcsPlayStop();
  MCS.mode = mode; MCS.gen++;
  MCS.d = null; MCS.ma = null; MCS.maAt = 0; MCS.opt = { CE: null, PE: null }; MCS.optKey = null; MCS.ss = null; MCS._fit = null; MCS.selStrike = null; MCS.q = null;
  const root = mcsEl("mcs-root");
  root.classList.toggle("mcs-testing", mode === "TEST");
  root.querySelectorAll("#mcs-modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const bar = mcsEl("mcs-testbar"); if (bar) bar.hidden = mode !== "TEST";
  const lg = mcsEl("mcs-testlog"); if (lg) { lg.hidden = mode !== "TEST"; if (mode === "TEST") mcsLoadTestLog(); }
  if (mode === "TEST") {
    if (!MCS.test.date) MCS.test.date = mcsPrevWeekday();
    const dt = mcsEl("mcs-tdate"); if (dt) dt.value = MCS.test.date;
    const sel = mcsEl("mcs-tupto"); if (sel) sel.value = MCS.test.upto;
  }
  mcsUnlockHeights(); mcsLoading(); mcsRefresh(true);
}
async function mcsRefreshTest(gen) {
  const sym = MCS.sym, tf = MCS.tf, date = MCS.test.date, upto = MCS.test.upto;
  const st = mcsEl("mcs-tstat"); if (st && !MCS.play.on) st.innerHTML = `⏳ Running ${mcsEsc(date)} as of ${mcsEsc(upto)}…`;
  mcsPlayProgress(upto);
  const full = false;   // always send the time; 15:15 = full day (also lets a finished "today" be tested and logged)
  const hk = `${sym}|${tf}|${date}`;
  const cachedH = MCS._hist.get(hk);
  const [h, ss] = await Promise.all([
    cachedH ? Promise.resolve(cachedH) : fetchJSON(`/api/market-command?symbol=${encodeURIComponent(sym)}&interval=${tf}&date=${date}`, 60000).then((x) => { if (x && !x.error && x.candles) { MCS._hist.set(hk, x); if (MCS._hist.size > 6) MCS._hist.delete(MCS._hist.keys().next().value); } return x; }).catch(() => null),
    fetchJSON(`/api/setup-signals?symbol=${encodeURIComponent(sym)}&date=${date}${full ? "" : "&upto=" + upto}`, 120000).catch(() => null),
  ]);
  if (gen !== MCS.gen || MCS.mode !== "TEST" || sym !== MCS.sym || tf !== MCS.tf || date !== MCS.test.date || upto !== MCS.test.upto) return;   // superseded
  const err = (h && h.error) || (ss && ss.error) || (!h ? "Chart data unavailable" : null);
  if (err && (!h || h.error)) { if (st) st.innerHTML = `<span class="mcs-warn">${mcsEsc(err)}</span>`; MCS.d = null; MCS.ss = ss && !ss.error ? ss : { error: err, symbol: sym }; mcsRenderAll(); return; }
  // Cut everything at "as of" so nothing after that time is visible (no look-ahead on screen).
  const asOf = ss && ss.asOf ? ss.asOf : null;
  const tfSec = tf === "15m" ? 900 : tf === "30m" ? 1800 : tf === "60m" ? 3600 : 300;
  const keep = h.candles.map((c) => asOf == null || c.time + tfSec <= asOf);
  const candles = h.candles.filter((_, i) => keep[i]);
  const ov = {}; for (const [k, arr] of Object.entries(h.overlays || {})) ov[k] = (arr || []).filter((_, i) => keep[i]);
  const lastT = candles.length ? candles[candles.length - 1].time : 0;
  const lfc = (ss && ss.levelsForChart) || {};
  const sw = (h.structure?.swingPoints || []).filter((p) => p.time + tfSec <= (asOf ?? Infinity));
  MCS.d = {
    ...h, candles, overlays: ov, spot: candles.length ? candles[candles.length - 1].close : null,
    structure: { ...(h.structure || {}), swingPoints: sw, bosEvents: (h.structure?.bosEvents || []).filter((b) => b.time <= lastT) },
    bos: h.bos && h.bos.time <= lastT ? h.bos : null, sweep: null,
    levels: { pdh: lfc.pdh, pdl: lfc.pdl, orbHigh: lfc.orbHigh, orbLow: lfc.orbLow },
    oi: {}, optionMatrix: null, decision: null, command: {}, tradePlan: {}, marketView: {}, mtfDirection: {}, confirmationFlow: {}, orderBlocks: [],
    syncHealth: { overall: "HISTORICAL" }, vix: null, vixEnvironment: null, dataStale: false,
  };
  MCS.ss = ss && !ss.error ? ss : { error: (ss && ss.error) || "Setup signals unavailable", symbol: sym };
  const nSig = ss && ss.today ? ss.today.signals.filter((x) => !x.blockedBy).length : 0;
  if (upto === "15:15" && ss && ss.analysis) mcsLoadTestLog();   // a full-day run was just logged
  const totR = ss && ss.today ? ss.today.signals.filter((x) => !x.blockedBy && x.resultR != null).reduce((a, x) => a + x.resultR, 0) : 0;
  if (st) st.innerHTML = ss && !ss.error ? `${MCS.play.on ? "⏵ Replaying" : "✅"} ${mcsEsc(date)} as of ${mcsEsc(ss.upto)} · ${nSig} signal${nSig === 1 ? "" : "s"}${nSig ? ` · ${totR >= 0 ? "+" : ""}${totR.toFixed(2)}R so far` : ""}` : `<span class="mcs-warn">${mcsEsc((ss && ss.error) || "Setup signals unavailable")}</span>`;
  mcsRenderAll();
}


// ---- Full-session replay (TESTING): 09:15 → 15:15, one closed 5m candle per step ----
const MCS_SESSION_FIRST = "09:20", MCS_SESSION_LAST = "15:15";
function mcsPlayProgress(upto) {
  const toM = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const pct = Math.max(0, Math.min(100, ((toM(upto) - toM("09:15")) / (toM(MCS_SESSION_LAST) - toM("09:15"))) * 100));
  const bar = mcsEl("mcs-tprogbar"), txt = mcsEl("mcs-tprogtxt");
  if (bar) bar.style.width = pct.toFixed(1) + "%"; if (txt) txt.textContent = upto;
}
function mcsPlayUi() {
  const b = mcsEl("mcs-tplay"); if (b) { b.textContent = MCS.play.on ? "⏸ Pause" : "⏵ Play full session"; b.classList.toggle("on", MCS.play.on); }
  mcsEl("mcs-root")?.classList.toggle("mcs-playing", MCS.play.on);
}
function mcsPlayStop(why) {
  if (!MCS.play.on) return;
  MCS.play.on = false; MCS.play.token++; mcsPlayUi();
  const st = mcsEl("mcs-tstat"); if (st && why) st.innerHTML = `${why === "Paused" ? "⏸" : "⏹"} ${why} at ${mcsEsc(MCS.test.upto)} — press ⏵ to ${why === "Paused" ? "resume" : "replay again"}`;
}
async function mcsPlayStart() {
  if (MCS.mode !== "TEST" || MCS.play.on) return;
  const sel = mcsEl("mcs-tupto"); if (!sel) return;
  const opts = [...sel.options].map((x) => x.value);
  if (MCS.test.upto === MCS_SESSION_LAST || opts.indexOf(MCS.test.upto) < 0) MCS.test.upto = MCS_SESSION_FIRST;   // start from the open
  MCS.play.on = true; const token = ++MCS.play.token; mcsPlayUi();
  while (MCS.play.on && MCS.play.token === token && MCS.mode === "TEST") {
    sel.value = MCS.test.upto;
    const t0 = Date.now();
    await mcsRefreshAwait();
    if (!MCS.play.on || MCS.play.token !== token || MCS.mode !== "TEST") return;
    const i = opts.indexOf(MCS.test.upto);
    if (i >= opts.length - 1) {   // reached 15:15 — session complete
      MCS.play.on = false; mcsPlayUi();
      const sigs = MCS.ss && MCS.ss.today ? MCS.ss.today.signals.filter((x) => !x.blockedBy) : [];
      const tot = sigs.filter((x) => x.resultR != null).reduce((a, x) => a + x.resultR, 0);
      const st = mcsEl("mcs-tstat"); if (st) st.innerHTML = `🏁 Session complete ${mcsEsc(MCS.test.date)} 09:15 → 15:15 · ${sigs.length} signal${sigs.length === 1 ? "" : "s"} · ${tot >= 0 ? "+" : ""}${tot.toFixed(2)}R (index points)`;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, MCS.play.speedMs - (Date.now() - t0))));
    if (!MCS.play.on || MCS.play.token !== token) return;
    MCS.test.upto = opts[i + 1];
  }
}
// Await one refresh (waits for an in-flight one first so steps never overlap).
async function mcsRefreshAwait() {
  for (let n = 0; MCS.busy && n < 600; n++) await new Promise((r) => setTimeout(r, 50));
  await mcsRefresh(true);
  for (let n = 0; MCS.busy && n < 600; n++) await new Promise((r) => setTimeout(r, 50));
}


// ===========================================================================
// TEST LOG — every full-day test run is recorded on the server (one entry per
// index + date). Shows where the logic did not fit the market: moves it caught,
// was late on, blocked (and why), traded against, or missed entirely.
// ===========================================================================
const MCS_VERDICT = { CAUGHT: ["✅ Caught", "win"], LATE: ["⏱ Late", "flat"], BLOCKED: ["⛔ Blocked", "blk"], WRONG_SIDE: ["↔ Wrong side", "loss"], MISSED: ["❌ Missed", "loss"], OUTSIDE: ["🕘 Outside entry window", "flat"] };
function mcsMovesHtml(an, title) {
  const sm = an.summary || {}, n = sm.moves || 0;
  const pct = (k) => (n ? Math.round(((sm[k] || 0) / n) * 100) : 0);
  const chips = ["CAUGHT", "LATE", "BLOCKED", "WRONG_SIDE", "MISSED", "OUTSIDE"].map((k) => `<span class="mcs-vchip ${MCS_VERDICT[k][1]}">${MCS_VERDICT[k][0]} <b>${sm[k] || 0}</b> <i>${pct(k)}%</i></span>`).join("");
  const rows = (an.moves || []).map((m) => `<tr class="v-${m.verdict.toLowerCase()}"><td>${m.startTime}–${m.endTime}</td><td class="${m.dir === "UP" ? "mcs-up" : "mcs-dn"}"><b>${m.dir === "UP" ? "▲ UP" : "▼ DOWN"}</b></td>
    <td class="r">${mcsN(m.pts, 1)} <i>(${mcsN(m.atrX, 1)}× ATR)</i></td><td><span class="mcs-vchip ${MCS_VERDICT[m.verdict][1]}">${MCS_VERDICT[m.verdict][0]}</span></td>
    <td>${mcsEsc(m.detail)}${m.blockReasons && m.blockReasons.length ? `<div class="mcs-sub">why: ${m.blockReasons.map(mcsEsc).join(" · ")}</div>` : ""}</td><td class="mcs-sub">${mcsEsc(m.context)}</td></tr>`).join("");
  const losses = (an.losses || []).map((l) => `<li>${l.time} ${l.setup} ${l.side} (${mcsEsc(l.context)}) ${l.level ? "at " + mcsEsc(l.level) : ""} — ${mcsEsc(l.why)}</li>`).join("");
  return `<div class="mcs-moves"><h5>${title} <span class="mcs-sub">${n} significant move${n === 1 ? "" : "s"} (≥ ${an.config?.minAtr ?? 2.5}× ATR)</span></h5>
    <div class="mcs-vchips">${chips}</div>
    ${n ? `<div class="mcs-tblwrap"><table class="mcs-tbl mcs-movetbl"><thead><tr><th>Move</th><th>Dir</th><th class="r">Size</th><th>Verdict</th><th>What the logic did</th><th>Where it started</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="mcs-sub">No significant move on this day.</div>`}
    ${losses ? `<div class="mcs-sub" style="margin-top:4px"><b>Losing signals:</b></div><ul class="mcs-ssev">${losses}</ul>` : ""}</div>`;
}
async function mcsLoadTestLog() {
  const box = mcsEl("mcs-testlog"); if (!box || MCS.mode !== "TEST") return;
  const scope = MCS.logScope || "index";
  const gen = MCS.gen;
  let d = null;
  try { d = await fetchJSON(`/api/setup-test-log${scope === "index" ? `?symbol=${encodeURIComponent(MCS.sym)}` : ""}`, 20000); } catch (_) { d = null; }
  if (gen !== MCS.gen || MCS.mode !== "TEST") return;
  MCS.testLog = d; mcsRenderTestLog();
}
function mcsRenderTestLog() {
  const box = mcsEl("mcs-testlog"); if (!box) return;
  const d = MCS.testLog, scope = MCS.logScope || "index";
  const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
  const head = `<h4>📒 TEST LOG — where the logic did not fit the market
    <span class="mcs-seg"><button type="button" class="${scope === "index" ? "on" : ""}" data-scope="index">${mcsEsc(nm)}</button><button type="button" class="${scope === "all" ? "on" : ""}" data-scope="all">All indices</button></span>
    <a class="mcs-back" href="/api/setup-test-log?format=csv${scope === "index" ? `&symbol=${encodeURIComponent(MCS.sym)}` : ""}" download onclick="return mcsCsv(this)">⬇ CSV</a>
    <button type="button" class="mcs-back" id="mcs-logclear">🗑 Clear</button></h4>`;
  if (!d || d.error) { box.innerHTML = head + `<div class="mcs-na">${mcsEsc(d?.error || "Test log unavailable")}</div>`; mcsWireLog(); return; }
  const a = d.aggregate || {}, n = a.moves || 0, pct = (k) => (n ? Math.round(((a[k] || 0) / n) * 100) : 0);
  const reasons = Object.entries(a.blockReasons || {}).sort((x, y) => y[1] - x[1]).slice(0, 6);
  const missed = Object.entries(a.missedContexts || {}).sort((x, y) => y[1] - x[1]).slice(0, 5);
  const summary = d.entries.length ? `<div class="mcs-logagg">
      <div><span>Days tested</span><b>${a.days}</b></div>
      <div><span>Signals</span><b>${a.signals}</b> <i>W ${a.wins} / L ${a.losses}</i></div>
      <div><span>Total</span><b class="${mcsCls(a.totalR)}">${a.totalR > 0 ? "+" : ""}${mcsN(a.totalR, 2)}R</b></div>
      <div><span>Market moves</span><b>${n}</b></div>
      ${["CAUGHT", "LATE", "BLOCKED", "WRONG_SIDE", "MISSED", "OUTSIDE"].map((k) => `<div><span>${MCS_VERDICT[k][0]}</span><b>${a[k] || 0}</b> <i>${pct(k)}%</i></div>`).join("")}
    </div>
    <div class="mcs-logwhy"><div><b>Most common reasons a move was BLOCKED</b>${reasons.length ? `<ol>${reasons.map(([r, c]) => `<li>${mcsEsc(r)} — <b>${c}</b></li>`).join("")}</ol>` : `<div class="mcs-sub">none</div>`}</div>
      <div><b>Where MISSED moves started</b>${missed.length ? `<ol>${missed.map(([r, c]) => `<li>${mcsEsc(r)} — <b>${c}</b></li>`).join("")}</ol>` : `<div class="mcs-sub">none</div>`}</div></div>` : `<div class="mcs-sub">No test runs logged yet — run a date to 15:15 (Run at 15:15, or Play full session) and it is logged here automatically.</div>`;
  const rows = d.entries.map((e, i) => { const sm = e.analysis?.summary || {}; return `<tr class="mcs-logrow" data-i="${i}"><td><b>${mcsEsc(e.date)}</b></td><td>${mcsEsc(e.index)}</td><td class="r">${e.totals.signals}</td><td class="r">${e.totals.wins}/${e.totals.losses}</td>
      <td class="r ${mcsCls(e.totals.totalR)}">${e.totals.totalR > 0 ? "+" : ""}${mcsN(e.totals.totalR, 2)}R</td><td class="r">${sm.moves ?? 0}</td>
      <td>${["CAUGHT", "LATE", "BLOCKED", "WRONG_SIDE", "MISSED", "OUTSIDE"].map((k) => `<span class="mcs-vmini ${MCS_VERDICT[k][1]}" title="${MCS_VERDICT[k][0]}">${sm[k] || 0}</span>`).join("")}</td>
      <td class="mcs-sub">${new Date((e.ranAt + 19800) * 1000).toISOString().slice(0, 16).replace("T", " ")}</td><td>▸</td></tr>
      <tr class="mcs-logdet" data-for="${i}" hidden><td colspan="9">${e.analysis ? mcsMovesHtml(e.analysis, `${mcsEsc(e.index)} ${mcsEsc(e.date)}`) : ""}
        ${e.signals.length ? `<div class="mcs-sub"><b>Signals:</b> ${e.signals.map((x) => `${x.time} ${x.setup} ${x.side} ${mcsEsc(x.level)} → ${x.status}${x.resultR != null ? ` ${x.resultR > 0 ? "+" : ""}${x.resultR}R` : ""}`).join(" · ")}</div>` : ""}</td></tr>`; }).join("");
  box.innerHTML = head + summary + (d.entries.length ? `<div class="mcs-tblwrap mcs-logtbl"><table class="mcs-tbl"><thead><tr><th>Date</th><th>Index</th><th class="r">Signals</th><th class="r">W/L</th><th class="r">Result</th><th class="r">Moves</th><th>✅ ⏱ ⛔ ↔ ❌ 🕘</th><th>Tested at</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : "");
  mcsWireLog();
}
function mcsWireLog() {
  const box = mcsEl("mcs-testlog"); if (!box) return;
  box.querySelectorAll("[data-scope]").forEach((b) => (b.onclick = () => { MCS.logScope = b.dataset.scope; mcsLoadTestLog(); }));
  box.querySelectorAll(".mcs-logrow").forEach((tr) => (tr.onclick = () => { const det = box.querySelector(`.mcs-logdet[data-for="${tr.dataset.i}"]`); if (det) { det.hidden = !det.hidden; tr.lastElementChild.textContent = det.hidden ? "▸" : "▾"; } }));
  const clr = mcsEl("mcs-logclear");
  if (clr) clr.onclick = async () => {
    const scope = MCS.logScope || "index"; const nm = MCS_SYMS.find((x) => x[0] === MCS.sym)?.[1] || MCS.sym;
    if (!confirm(`Clear the test log for ${scope === "index" ? nm : "ALL indices"}?`)) return;
    try { const r = await fetch(`/api/setup-test-log${scope === "index" ? `?symbol=${encodeURIComponent(MCS.sym)}` : ""}`, { method: "DELETE" }); if (!r.ok) alert(r.status === 403 ? "Only admin can clear the log." : "Clear failed"); } catch (_) {}
    mcsLoadTestLog();
  };
}
// CSV download with the session token (a plain link would not carry the Authorization header).
function mcsCsv(a) {
  fetch(a.getAttribute("href")).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); const x = document.createElement("a"); x.href = u; x.download = "setup-test-log.csv"; document.body.appendChild(x); x.click(); x.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }).catch(() => alert("Download failed"));
  return false;
}


// LIVE: pop an alert when the EMA direction changes (once per change; not on first load).
function mcsDirAlert(sym, nm, evs) {
  MCS._dirSeen = MCS._dirSeen || {};
  const last = evs.length ? evs[evs.length - 1] : null, key = last ? `${last.time}|${last.to}` : "none";
  const seen = MCS._dirSeen[sym];
  MCS._dirSeen[sym] = key;
  if (seen === undefined || !last || seen === key) return;          // first load / no change
  let t = document.getElementById("mcs-dirtoast");
  if (!t) { t = document.createElement("div"); t.id = "mcs-dirtoast"; t.className = "mcs-dirtoast"; t.setAttribute("role", "alert"); document.body.appendChild(t); }
  t.className = "mcs-dirtoast " + (last.to === "UP" ? "up" : last.to === "DOWN" ? "dn" : "");
  t.innerHTML = `<b>${mcsEsc(nm)} direction changed: ${mcsEsc(last.from)} → ${mcsEsc(last.to)}</b><div>${mcsEsc(last.time)} · ${mcsEsc(last.why)}</div><button type="button" onclick="this.parentElement.remove()" aria-label="Close">✕</button>`;
  clearTimeout(MCS._dirToastT); MCS._dirToastT = setTimeout(() => t && t.remove(), 20000);
}
