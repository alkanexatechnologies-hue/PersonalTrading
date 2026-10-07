#!/usr/bin/env node
// Pull the 1-minute OI log CSVs to this computer (default: ~/Desktop/NSA-OI-Logs/<date>/).
//
//   node scripts/pull-oi-logs.mjs           download + merge every day the server has
//   node scripts/pull-oi-logs.mjs --wake    only wake the server (free Render sleeps when idle)
//
// Settings come from ~/.nsa-pull.env (never committed):
//   NSA_URL=https://<your-app>.onrender.com
//   NSA_USER=admin            NSA_PASS=<password>        NSA_MODE=admin   (or user)
//   OUT_DIR=~/Desktop/NSA-OI-Logs                         (optional)
//   LOCAL_DATA=<repo>/data/oi-minute                     (optional: also merge the local server's log)
// Rows are MERGED with what is already on disk (never overwritten), so a partial pull or a
// restarted server never loses minutes that were already saved.
import fs from "fs";
import os from "os";
import path from "path";

const home = os.homedir();
const envFile = path.join(home, ".nsa-pull.env");
const env = {};
try {
  for (const ln of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(ln);
    if (m && !ln.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no settings file */ }
const cfg = (k, d) => process.env[k] || env[k] || d;
const expand = (p) => (p && p.startsWith("~") ? path.join(home, p.slice(1)) : p);
const URL_ = (cfg("NSA_URL", "") || "").replace(/\/$/, "");
const OUT = expand(cfg("OUT_DIR", "~/Desktop/NSA-OI-Logs"));
const LOCAL = expand(cfg("LOCAL_DATA", ""));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

async function wake() {
  if (!URL_) return log("NSA_URL not set in", envFile);
  for (let i = 1; i <= 6; i++) {
    try { const r = await fetch(`${URL_}/health`, { signal: AbortSignal.timeout(90_000) }); if (r.ok) return log("server awake"); } catch { /* retry */ }
    log(`wake attempt ${i} failed, retrying…`); await new Promise((r) => setTimeout(r, 20_000));
  }
}

// merge CSV text into an existing file: keep header, add rows not already present, sort by time column
function merge(file, text) {
  const inc = text.replace(/^﻿/, "").split("\n").filter(Boolean);
  if (!inc.length) return 0;
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const header = cur[0] || inc[0];
  const have = new Set(cur.slice(1));
  const add = inc.slice(1).filter((l) => !have.has(l));
  if (!add.length && cur.length) return 0;
  const rows = [...cur.slice(1), ...add];
  const t = (l) => l.split(",")[1] || "";
  rows.sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : 0));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  return add.length;
}

async function pullRemote() {
  if (!URL_) { log("NSA_URL not set in", envFile, "— skipping server pull"); return; }
  await wake();
  const lr = await fetch(`${URL_}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg("NSA_USER", "admin"), password: cfg("NSA_PASS", ""), mode: cfg("NSA_MODE", "admin") }) });
  const lj = await lr.json().catch(() => ({}));
  if (!lj.token) throw new Error(`login failed: ${lj.error || lr.status} (check NSA_USER / NSA_PASS / NSA_MODE in ${envFile})`);
  const H = { Authorization: `Bearer ${lj.token}` };
  const dj = await (await fetch(`${URL_}/api/oi-minute/days`, { headers: H })).json();
  let n = 0;
  for (const d of dj.days || []) for (const f of d.files) {
    const r = await fetch(`${URL_}/api/oi-minute/file?date=${d.date}&name=${encodeURIComponent(f.name)}`, { headers: H });
    if (!r.ok) { log("skip", d.date, f.name, r.status); continue; }
    const added = merge(path.join(OUT, d.date, f.name), await r.text());
    if (added) { n += added; log(`${d.date}/${f.name}: +${added} rows`); }
  }
  log(`server pull done (${(dj.days || []).length} day(s), ${n} new rows)`);
}

function pullLocal() {
  if (!LOCAL || !fs.existsSync(LOCAL)) return;
  let n = 0;
  for (const d of fs.readdirSync(LOCAL).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))
    for (const f of fs.readdirSync(path.join(LOCAL, d)).filter((x) => x.endsWith(".csv")))
      n += merge(path.join(OUT, d, f), fs.readFileSync(path.join(LOCAL, d, f), "utf8"));
  log(`local merge done (${n} new rows)`);
}

(async () => {
  if (process.argv.includes("--wake")) return wake();
  log("saving to", OUT);
  try { await pullRemote(); } catch (e) { log("server pull failed:", e.message); process.exitCode = 1; }
  pullLocal();
})();
