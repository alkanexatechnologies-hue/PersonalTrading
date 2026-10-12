// ============================ OI Analysis → 1-Min OI Monitor ============================
// Strike-wise OI change between real minute snapshots (/api/oi-monitor). Display only.
// Every number comes from stored snapshots; a window whose two snapshots are not the stated
// distance apart is flagged with its real interval. Replay walks the same stored minutes.
const OIM = { win: 1, around: 10, min: null, max: null, heat: "CE", date: "", expiry: "", mode: "live", at: null, showChg: true, showOi: true, d: null, req: 0 };
const OIM_SYMS = [["^NSEI", "NIFTY"], ["^NSEBANK", "BANK NIFTY"], ["^CNXFIN", "FIN NIFTY"]];

function oimEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function oimK(v, sign) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v), s = sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  const t = a >= 1e7 ? (a / 1e7).toFixed(2) + "Cr" : a >= 1e5 ? (a / 1e5).toFixed(2) + "L" : a >= 1e3 ? (a / 1e3).toFixed(1) + "K" : String(Math.round(a));
  return s + t;
}
function oimN(v, d = 0) { return v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function oimP(v) { return v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`; }
function oimC(v) { return v == null ? "" : v > 0 ? "up" : v < 0 ? "dn" : ""; }
function oimT(sec) { return sec ? new Date(sec * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "—"; }
const OIM_CLS = { "POSSIBLE WRITING": "wr", "POSSIBLE LONG BUILDUP": "lb", UNWINDING: "uw", INCONCLUSIVE: "ic" };

function oimShell() {
  const box = document.getElementById("oia-minute"); if (!box || box._built) return;
  box._built = true;
  box.innerHTML = `<div class="oimm">
    <details class="oimm-sidewrap" id="oimm-sidewrap" open><summary>Controls — instrument, expiry, window, strikes</summary><aside class="oimm-side" id="oimm-side"></aside></details>
    <div class="oimm-main">
      <div class="oimm-r1"><section class="oimm-card" id="oimm-chart"><div class="oimm-hd"><h3 id="oimm-ctitle">OI by strike</h3><span class="oimm-spot" id="oimm-spot"></span></div><div class="oimm-leg" id="oimm-leg"></div><canvas id="oimm-canvas"></canvas><div class="oimm-empty" id="oimm-cmsg" hidden></div></section>
        <section class="oimm-card" id="oimm-sum"></section></div>
      <div class="oimm-r2"><section class="oimm-card ce" id="oimm-ce"></section><section class="oimm-card pe" id="oimm-pe"></section></div>
      <div class="oimm-r3"><section class="oimm-card" id="oimm-heat"></section><section class="oimm-card" id="oimm-tl"></section><section class="oimm-card" id="oimm-top5"></section></div>
      <div class="oimm-foot" id="oimm-foot"></div>
    </div></div>`;
  box.addEventListener("click", oimClick); box.addEventListener("change", oimChange);
  if (window.matchMedia && window.matchMedia("(max-width:760px)").matches) document.getElementById("oimm-sidewrap").open = false;
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (OIM.d && !box.hidden) oimDrawChart(OIM.d); }, 150); });
}

async function loadOiMinute() {
  oimShell();
  const tok = ++OIM.req;
  const q = new URLSearchParams({ symbol: OIA.sym, window: OIM.win, around: OIM.around, heat: OIM.heat });
  if (OIM.min != null) q.set("min", OIM.min); if (OIM.max != null) q.set("max", OIM.max);
  if (OIM.date) q.set("date", OIM.date); if (OIM.expiry) q.set("expiry", OIM.expiry);
  if (OIM.mode === "replay" && OIM.at != null) q.set("at", OIM.at);
  let d;
  try { d = await fetchJSON(`/api/oi-monitor?${q}`, 20000); } catch (e) { d = { available: false, reason: (e && e.message) || "unavailable" }; }
  if (tok !== OIM.req) return;
  OIM.d = d; oimRender(d);
}

function oimSide(d) {
  const sym = OIA.sym, days = d.days || [], exps = d.expiries || [];
  const seg = (name, items, cur, attr) => `<div class="oimm-seg" role="group" aria-label="${name}">${items.map(([v, l]) => `<button type="button" ${attr}="${oimEsc(v)}" aria-pressed="${String(v) === String(cur)}">${oimEsc(l)}</button>`).join("")}</div>`;
  const nMin = (d.minutes || []).length;
  return `<h4>Instrument &amp; expiry</h4>${seg("Instrument", OIM_SYMS, sym, "data-om-sym")}
    ${OIM_SYMS.some(([s]) => s === sym) ? "" : `<div class="oimm-note warn">1-min snapshots are collected for NIFTY, BANK NIFTY and FIN NIFTY only.</div>`}
    <label class="oimm-lb">Expiry<select data-om="expiry">${exps.length ? exps.map((e) => `<option ${e === d.expiry ? "selected" : ""}>${oimEsc(e)}</option>`).join("") : "<option>—</option>"}</select></label>
    <div class="oimm-note">Minute history exists only for the expiry the shared chain tracks (nearest).</div>
    <label class="oimm-lb">Day<select data-om="date">${days.length ? days.map((x) => `<option value="${x}" ${x === d.date ? "selected" : ""}>${x}${x === d.today ? " (today)" : ""}</option>`).join("") : `<option>${oimEsc(d.today || "today")}</option>`}</select></label>
    <h4>View mode</h4>${seg("View mode", [["live", "Live"], ["replay", "Replay"]], OIM.mode, "data-om-mode")}
    ${OIM.mode === "replay" && nMin ? `<div class="oimm-replay"><input type="range" min="0" max="${nMin - 1}" value="${d.atIdx ?? nMin - 1}" data-om="at" aria-label="Replay minute"><div class="oimm-note">Minute <b>${oimEsc((d.minutes || [])[d.atIdx] || "—")}</b> of ${oimEsc(d.firstMinute || "")}–${oimEsc((d.minutes || [])[nMin - 1] || "")}</div>
      <div class="oimm-step"><button type="button" data-om-step="-1">◀ 1 min</button><button type="button" data-om-step="1">1 min ▶</button></div></div>` : ""}
    <h4>Compare window</h4>${seg("Window", [[1, "1 min"], [5, "5 min"], [15, "15 min"], [30, "30 min"]], OIM.win, "data-om-win")}
    <h4>Strike range <button type="button" class="oimm-link" data-om-reset>Reset</button></h4>
    <div class="oimm-rng"><label>Min<div class="oimm-stp"><button type="button" data-om-rng="min:-1">−</button><b>${oimN(d.range && d.range.min)}</b><button type="button" data-om-rng="min:1">+</button></div></label>
      <label>Max<div class="oimm-stp"><button type="button" data-om-rng="max:-1">−</button><b>${oimN(d.range && d.range.max)}</b><button type="button" data-om-rng="max:1">+</button></div></label></div>
    <h4>Strikes around ATM</h4>${seg("Strikes around ATM", [[5, "5"], [8, "8"], [10, "10"], [12, "12"]], OIM.min == null && OIM.max == null ? OIM.around : "", "data-om-around")}
    <div class="oimm-note">The shared chain keeps ±12 strikes around ATM.</div>
    <h4>Display</h4><label class="oimm-ck"><input type="checkbox" data-om="showOi" ${OIM.showOi ? "checked" : ""}> Show OI</label><label class="oimm-ck"><input type="checkbox" data-om="showChg" ${OIM.showChg ? "checked" : ""}> Show OI change</label>`;
}

function oimRender(d) {
  const side = document.getElementById("oimm-side"); if (!side) return;
  side.innerHTML = oimSide(d);
  const set = (id, h) => { const e = document.getElementById(id); if (e) e.innerHTML = h; };
  const foot = `Display only — OI addition is never called writing on its own: premium and spot must agree. Not used by signals, the arbiter or paper trading.`;
  if (!d.available) {
    const why = oimEsc(d.reason || "No data");
    document.getElementById("oimm-cmsg").hidden = false; document.getElementById("oimm-cmsg").textContent = d.reason || "No data";
    const c = document.getElementById("oimm-canvas"); if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
    set("oimm-sum", `<div class="oimm-hd"><h3>1-minute summary</h3></div><div class="oimm-empty">${why}</div>${d.collecting === false ? "" : `<div class="oimm-note">Snapshots are captured each minute from 09:15 to 15:30 on trading days. Past minutes are never back-filled.</div>`}`);
    ["oimm-ce", "oimm-pe", "oimm-heat", "oimm-tl", "oimm-top5"].forEach((id) => set(id, ""));
    set("oimm-foot", foot); set("oimm-spot", ""); return;
  }
  document.getElementById("oimm-cmsg").hidden = true;
  const w = d.window, s = d.summary, nm = oimEsc(d.name || "");
  document.getElementById("oimm-ctitle").innerHTML = `${nm} options open interest <span class="mut">(${w.min}-min change)</span>`;
  set("oimm-spot", `Spot <b>${oimN(d.spot, 2)}</b> · ATM <b>${oimN(d.atm)}</b> · expiry ${oimEsc(d.expiry)}`);
  set("oimm-leg", `<span><i class="pe"></i>Put OI</span><span><i class="ce"></i>Call OI</span><span><i class="inc"></i>OI increase</span><span><i class="dec"></i>OI decrease</span><span class="atm">┆ ATM</span>`);
  oimDrawChart(d);
  const warn = !w.aligned ? `<div class="oimm-warn">⚠ ${oimEsc(w.note)}</div>` : "";
  const pcrChg = d.pcr != null && w.prevPcr != null ? d.pcr - w.prevPcr : null;
  set("oimm-sum", `<div class="oimm-hd"><h3>${w.min}-minute summary <span class="mut">(${oimEsc(w.prevMinute || "—")} → ${oimEsc(w.curMinute)})</span></h3></div>${warn}
    <div class="oimm-g2">
      <div class="oimm-bx ce"><span>Call OI added</span><b>${oimK(s.callAdded, true)}</b><em>net ${oimK(s.callNet, true)}${s.callAddedPct != null ? ` (${oimP(s.callAddedPct)})` : ""}</em></div>
      <div class="oimm-bx pe"><span>Put OI added</span><b>${oimK(s.putAdded, true)}</b><em>net ${oimK(s.putNet, true)}${s.putAddedPct != null ? ` (${oimP(s.putAddedPct)})` : ""}</em></div>
      <div class="oimm-bx ce"><span>Max call addition</span><b>${s.maxCall ? oimN(s.maxCall.strike) : "—"}</b><em>${s.maxCall ? oimK(s.maxCall.chg, true) : ""}</em></div>
      <div class="oimm-bx pe"><span>Max put addition</span><b>${s.maxPut ? oimN(s.maxPut.strike) : "—"}</b><em>${s.maxPut ? oimK(s.maxPut.chg, true) : ""}</em></div>
      <div class="oimm-bx"><span>PCR (OI)</span><b>${d.pcr != null ? d.pcr.toFixed(2) : "—"}</b><em class="${oimC(pcrChg)}">${pcrChg != null ? (pcrChg > 0 ? "▲ +" : pcrChg < 0 ? "▼ " : "") + pcrChg.toFixed(2) : ""}</em></div>
      <div class="oimm-bx"><span>Max pain</span><b>${oimN(d.maxPain)}</b><em></em></div>
    </div>
    <div class="oimm-clock"><span>Dhan fetch <b>${oimT(d.clocks.providerT)}</b></span><span>Captured <b>${oimT(d.clocks.captureT)}</b></span><span>${d.isToday && OIM.mode === "live" ? `age <b class="${d.stale ? "dn" : ""}">${d.clocks.ageSec}s</b>${d.stale ? " STALE" : ""}` : "replay"}</span><span>${d.samples} snapshots since ${oimEsc(d.firstMinute)}</span></div>
    <div class="oimm-note">${oimEsc(d.clocks.note)}${Object.keys(d.stats || {}).length ? ` Skipped readings: ${Object.entries(d.stats).map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")} ${v}`).join(", ")}.` : ""}</div>`);
  const legTbl = (side) => {
    const rows = side === "CE" ? d.topCE : d.topPE, nmS = side === "CE" ? "call" : "put";
    const hd = `<div class="oimm-hd"><h3 class="${side === "CE" ? "dn" : "up"}">Top 5 ${nmS} OI additions <span class="mut">(${oimEsc(w.prevMinute || "—")} → ${oimEsc(w.curMinute)})</span></h3>${!w.aligned && w.prevMinute ? '<span class="oimm-tag warn">not a clean ' + w.min + "-min pair</span>" : ""}</div>`;
    if (!w.prevMinute) return hd + `<div class="oimm-empty">${oimEsc(w.note)}</div>`;
    if (!rows.length) return hd + `<div class="oimm-empty">No ${nmS} OI additions in this window.</div>`;
    return hd + `<div class="oimm-tw"><table class="oimm-t"><thead><tr><th>#</th><th class="num">Strike</th><th class="num">OI prev → now</th><th class="num">Δ OI</th><th class="num">Δ %</th><th class="num">LTP prev → now</th><th class="num">Δ LTP</th><th class="num">Δ Vol</th><th>Reading</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td class="num"><b>${oimN(r.strike)}</b></td><td class="num oimm-pn">${oimK(r.prevOi)} → ${oimK(r.curOi)}</td><td class="num add">${oimK(r.oiChg, true)}</td><td class="num add">${oimP(r.oiChgPct)}</td><td class="num">${oimN(r.prevLtp, 2)} → ${oimN(r.curLtp, 2)}</td><td class="num ${oimC(r.ltpChgPct)}">${oimP(r.ltpChgPct)}</td><td class="num">${oimK(r.volChg)}</td><td><span class="oimm-cls ${OIM_CLS[r.cls]}" title="${oimEsc(r.evidence.join(" · "))}">${oimEsc(r.cls)}</span><div class="oimm-ev" title="${oimEsc(r.evidence.join(" · "))}">${oimEsc(r.evidence.slice(-1)[0] || "")}</div></td></tr>`).join("")}
      </tbody></table></div>`;
  };
  set("oimm-ce", legTbl("CE")); set("oimm-pe", legTbl("PE"));
  // heatmap
  const h = d.heat, mx = Math.max(1, ...h.rows.flatMap((r) => r.cells.map((c) => Math.abs(c || 0))));
  const cell = (v) => { if (v == null) return `<td class="na">—</td>`; const a = Math.min(0.85, 0.12 + (Math.abs(v) / mx) * 0.7); const col = v >= 0 ? "22,199,132" : "234,57,67"; return `<td style="background:rgba(${col},${a.toFixed(2)})">${oimK(v, true)}</td>`; };
  set("oimm-heat", `<div class="oimm-hd"><h3>1-minute OI change heatmap</h3><div class="oimm-seg">${[["CE", "Call"], ["PE", "Put"]].map(([k, l]) => `<button type="button" data-om-heat="${k}" aria-pressed="${h.side === k}">${l}</button>`).join("")}</div></div>
    ${h.rows.length ? `<div class="oimm-tw"><table class="oimm-t oimm-hm"><thead><tr><th>Time</th>${h.strikes.map((k) => `<th class="${k === d.atm ? "atm" : ""}">${k}${k === d.atm ? " ATM" : ""}</th>`).join("")}</tr></thead><tbody>${h.rows.map((r) => `<tr><td class="${r.aligned ? "" : "warn"}" title="${r.aligned ? "" : "gap is not one minute"}">${oimEsc(r.minute)}${r.aligned ? "" : "*"}</td>${r.cells.map(cell).join("")}</tr>`).join("")}</tbody></table></div><div class="oimm-note">Green = OI added, red = OI reduced. * = the gap to the previous snapshot was not one minute.</div>` : `<div class="oimm-empty">Needs two consecutive minutes.</div>`}`);
  // timeline
  set("oimm-tl", `<div class="oimm-hd"><h3>1-minute OI change (call vs put)</h3></div>${d.timeline.length ? `<div class="oimm-tw"><table class="oimm-t"><thead><tr><th>Time</th><th class="num">Call Δ</th><th class="num">Put Δ</th><th class="num" title="Put Δ minus Call Δ">Net P−C</th><th class="num">PCR</th><th class="num">Spot</th></tr></thead><tbody>
    ${d.timeline.map((r) => `<tr><td class="${r.aligned ? "" : "warn"}">${oimEsc(r.minute)}${r.aligned ? "" : ` <span class="oimm-tag warn">${Math.round(r.actualSec / 60)}m gap</span>`}</td><td class="num ${oimC(r.callChg)}">${oimK(r.callChg, true)}</td><td class="num ${oimC(r.putChg)}">${oimK(r.putChg, true)}</td><td class="num ${oimC(r.net)}">${oimK(r.net, true)}</td><td class="num">${r.pcr != null ? r.pcr.toFixed(2) : "—"}</td><td class="num">${oimN(r.spot, 2)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="oimm-empty">Needs two consecutive minutes.</div>`}`);
  // top additions over 5 min
  const t5 = d.top5m;
  set("oimm-top5", `<div class="oimm-hd"><h3>Top OI additions <span class="mut">(last 5 min)</span></h3>${t5.rows.length && !t5.aligned ? '<span class="oimm-tag warn">real interval differs</span>' : ""}</div>
    ${t5.rows.length ? `<div class="oimm-tw"><table class="oimm-t"><thead><tr><th>#</th><th class="num">Strike</th><th>Side</th><th class="num">Δ OI</th><th class="num">Δ LTP</th><th>Reading</th></tr></thead><tbody>${t5.rows.map((r, i) => `<tr><td>${i + 1}</td><td class="num"><b>${oimN(r.strike)}</b></td><td class="${r.side === "CE" ? "dn" : "up"}">${r.side === "CE" ? "Call" : "Put"}</td><td class="num add">${oimK(r.oiChg, true)}</td><td class="num ${oimC(r.ltpChgPct)}">${oimP(r.ltpChgPct)}</td><td><span class="oimm-cls ${OIM_CLS[r.cls]}" title="${oimEsc(r.evidence.join(" · "))}">${oimEsc(r.cls)}</span></td></tr>`).join("")}</tbody></table></div><div class="oimm-note">${oimEsc(t5.note)}</div>` : `<div class="oimm-empty">${oimEsc(t5.note)}</div>`}`);
  set("oimm-foot", foot);
}

function oimDrawChart(d) {
  const cv = document.getElementById("oimm-canvas"); if (!cv || !d.chart) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 600, H = cv.clientHeight || 260;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const rows = d.chart, L = 46, R = 8, T = 14, B = 26, pw = W - L - R, ph = H - T - B;
  const prevOf = (oi, chg) => (oi != null && chg != null ? oi - chg : null);
  const vmax = Math.max(1, ...rows.flatMap((r) => [r.ceOi || 0, r.peOi || 0, prevOf(r.ceOi, r.ceChg) || 0, prevOf(r.peOi, r.peChg) || 0]));
  const y = (v) => T + ph - (v / vmax) * ph;
  g.font = "10px system-ui, sans-serif"; g.fillStyle = "#8395b3"; g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = (vmax * i) / 4, yy = y(v); g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke(); g.textAlign = "right"; g.fillText(oimK(v), L - 4, yy + 3); }
  const n = rows.length, slot = pw / Math.max(1, n), bw = Math.max(3, Math.min(16, slot * 0.36));
  const bar = (x, oi, chg, base, light) => {
    if (oi == null) return;
    if (OIM.showOi) { g.fillStyle = base; const top = chg != null && chg > 0 && OIM.showChg ? oi - chg : oi; g.fillRect(x, y(top), bw, y(0) - y(top)); }
    if (!OIM.showChg || chg == null || chg === 0) return;
    if (chg > 0) { g.fillStyle = light; g.fillRect(x, y(oi), bw, y(oi - chg) - y(oi)); g.setLineDash([3, 2]); g.strokeStyle = "#e6ecf5"; g.strokeRect(x + 0.5, y(oi) + 0.5, bw - 1, y(oi - chg) - y(oi)); g.setLineDash([]); }
    else { g.setLineDash([3, 2]); g.strokeStyle = base; g.strokeRect(x + 0.5, y(oi - chg) + 0.5, bw - 1, y(oi) - y(oi - chg)); g.setLineDash([]); }
  };
  rows.forEach((r, i) => {
    const cx = L + slot * i + slot / 2;
    bar(cx - bw - 1, r.peOi, r.peChg, "rgba(22,199,132,.85)", "rgba(120,240,190,.95)");
    bar(cx + 1, r.ceOi, r.ceChg, "rgba(234,57,67,.85)", "rgba(255,150,155,.95)");
    const every = Math.max(1, Math.ceil(44 / slot)), ai0 = rows.findIndex((x) => x.strike === d.atm);
    if (r.strike === d.atm || (i % every === 0 && (ai0 < 0 || Math.abs(i - ai0) >= every))) { g.fillStyle = r.strike === d.atm ? "#fff" : "#8395b3"; g.textAlign = "center"; g.fillText(String(r.strike), cx, H - 8); }
  });
  const ai = rows.findIndex((r) => r.strike === d.atm);
  if (ai >= 0) { const ax = L + slot * ai + slot / 2; g.setLineDash([4, 3]); g.strokeStyle = "#cfd8e6"; g.beginPath(); g.moveTo(ax, T); g.lineTo(ax, H - B); g.stroke(); g.setLineDash([]); g.fillStyle = "#cfd8e6"; g.textAlign = "center"; g.fillText(`ATM ${d.atm}`, ax, T - 3 + 10); }
}

function oimClick(e) {
  const t = e.target.closest("button"); if (!t) return;
  const a = (k) => t.getAttribute(k);
  if (a("data-om-sym")) { OIA.sym = a("data-om-sym"); OIM.min = OIM.max = null; OIM.expiry = ""; OIM.at = null; if (typeof syncOIAFromMC === "function") syncOIAFromMC(true); }
  else if (a("data-om-mode")) { OIM.mode = a("data-om-mode"); OIM.at = OIM.mode === "replay" && OIM.d && OIM.d.minutes ? OIM.d.minutes.length - 1 : null; }
  else if (a("data-om-win")) OIM.win = Number(a("data-om-win"));
  else if (a("data-om-around")) { OIM.around = Number(a("data-om-around")); OIM.min = OIM.max = null; }
  else if (a("data-om-heat")) OIM.heat = a("data-om-heat");
  else if (t.hasAttribute("data-om-reset")) { OIM.min = OIM.max = null; OIM.around = 10; }
  else if (a("data-om-step")) { const n = (OIM.d && OIM.d.minutes || []).length; OIM.at = Math.max(0, Math.min(n - 1, (OIM.at ?? n - 1) + Number(a("data-om-step")))); }
  else if (a("data-om-rng")) { const [k, dir] = a("data-om-rng").split(":"); const d = OIM.d || {}; const st = d.step || 50; const r = d.range || {}; OIM.min = OIM.min ?? r.min ?? null; OIM.max = OIM.max ?? r.max ?? null; if (k === "min" && OIM.min != null) OIM.min += Number(dir) * st; if (k === "max" && OIM.max != null) OIM.max += Number(dir) * st; if (OIM.min != null && OIM.max != null && OIM.min > OIM.max) [OIM.min, OIM.max] = [OIM.max, OIM.min]; }
  else return;
  loadOiMinute();
}
function oimChange(e) {
  const k = e.target.getAttribute("data-om"); if (!k) return;
  if (k === "expiry") OIM.expiry = e.target.value;
  else if (k === "date") { OIM.date = e.target.value; OIM.expiry = ""; OIM.at = null; if (OIM.date !== (OIM.d && OIM.d.today)) OIM.mode = "replay"; }
  else if (k === "at") OIM.at = Number(e.target.value);
  else if (k === "showOi" || k === "showChg") { OIM[k] = e.target.checked; if (OIM.d) oimDrawChart(OIM.d); return; }
  loadOiMinute();
}
