#!/usr/bin/env node
// Responsive audit: drives headless Chrome over every breakpoint in CLAUDE.md
// and reports the things that rule-set forbids - horizontal overflow of the
// main app, fonts that are too small to read, and touch targets too small for
// a finger. Run it before committing any UI change.
//
//   node scripts/responsive-audit.js                 # all screens
//   node scripts/responsive-audit.js --screen admin  # one screen
//   node scripts/responsive-audit.js --url http://localhost:5173
//
// Needs puppeteer-core + a local Chrome; skips with a clear message if absent.

const path = require("path");

const BREAKPOINTS = [
  { name: "Mobile 375x667", width: 375, height: 667, kind: "mobile" },
  { name: "Mobile 390x844", width: 390, height: 844, kind: "mobile" },
  { name: "Tablet 768x1024", width: 768, height: 1024, kind: "tablet" },
  { name: "Laptop 1440x900", width: 1440, height: 900, kind: "desktop" },
  { name: "Desktop 1920x1080", width: 1920, height: 1080, kind: "desktop" },
];

// Each screen says how to get the app into that state from a fresh load.
const SCREENS = {
  login: { label: "Login screen", setup: null },
  admin: { label: "Admin Control Center", setup: { role: "admin" } },
  dashboard: { label: "Trading dashboard", setup: { role: "user", mode: "option" } },
  stockOption: { label: "Stock Option desk", setup: { role: "user", mode: "stockOption" } },
  swing: { label: "Stock Swing desk", setup: { role: "user", mode: "swing" } },
  backtest: { label: "Dhan Backtest desk", setup: { role: "user", mode: "dhanbacktest" } },
};

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function findChrome() {
  const fs = require("fs");
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return CHROME_PATHS.find((p) => fs.existsSync(p));
}

function loadPuppeteer() {
  // Allow the dependency to live either here or in a scratch install.
  for (const mod of ["puppeteer-core", "puppeteer"]) {
    try { return require(mod); } catch (_) { /* try next */ }
  }
  return null;
}

// Runs inside the page: finds everything that violates the responsive rules.
function auditInPage(kind) {
  const MIN_FONT_PX = 11; // below this is "tiny" and unreadable on a phone
  const MIN_TOUCH_PX = 32; // finger target floor on touch devices
  const describe = (n) => {
    const id = n.id ? `#${n.id}` : "";
    const cls = typeof n.className === "string" && n.className ? `.${n.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${n.tagName.toLowerCase()}${id}${cls}`;
  };
  const visible = (n) => {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const out = { pageOverflow: null, overflowing: [], tinyFonts: [], smallTargets: [] };

  const docW = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > docW + 1) {
    out.pageOverflow = { scrollWidth: document.documentElement.scrollWidth, clientWidth: docW };
  }

  // Elements sticking out past the viewport. Intentionally-scrollable
  // containers (overflow-x auto/scroll) and their contents are allowed.
  const inScrollable = (n) => {
    for (let p = n.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };
  document.querySelectorAll("body *").forEach((n) => {
    if (!visible(n) || inScrollable(n)) return;
    const cs = getComputedStyle(n);
    if (cs.position === "fixed" || cs.position === "absolute") return; // off-canvas panels/overlays
    const r = n.getBoundingClientRect();
    if (r.right > docW + 2 || r.left < -2) {
      out.overflowing.push({ el: describe(n), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }
  });

  // Tiny fonts on text-bearing leaf nodes.
  document.querySelectorAll("body *").forEach((n) => {
    if (!visible(n)) return;
    const text = Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join("");
    if (!text) return;
    const size = parseFloat(getComputedStyle(n).fontSize);
    if (size && size < MIN_FONT_PX) out.tinyFonts.push({ el: describe(n), fontSize: size, sample: text.slice(0, 30) });
  });

  // Touch targets - only judged on phone/tablet widths.
  if (kind === "mobile" || kind === "tablet") {
    document.querySelectorAll("button, a, input, select, [role=button], .pill-btn, .tab, .sub-tab").forEach((n) => {
      if (!visible(n)) return;
      const r = n.getBoundingClientRect();
      if (r.height < MIN_TOUCH_PX || r.width < 20) {
        out.smallTargets.push({ el: describe(n), w: Math.round(r.width), h: Math.round(r.height) });
      }
    });
  }

  const dedupe = (arr, key) => {
    const seen = new Set();
    return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  out.overflowing = dedupe(out.overflowing, (x) => x.el).slice(0, 12);
  out.tinyFonts = dedupe(out.tinyFonts, (x) => x.el + x.fontSize).slice(0, 12);
  out.smallTargets = dedupe(out.smallTargets, (x) => x.el).slice(0, 12);
  return out;
}

(async () => {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    console.error("responsive-audit: puppeteer-core is not installed.\n  npm i -D puppeteer-core");
    process.exit(2);
  }
  const executablePath = findChrome();
  if (!executablePath) {
    console.error("responsive-audit: no Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.");
    process.exit(2);
  }

  const baseUrl = arg("--url", "http://localhost:5173");
  const only = arg("--screen", null);
  const screens = only ? { [only]: SCREENS[only] } : SCREENS;
  if (only && !SCREENS[only]) {
    console.error(`responsive-audit: unknown screen "${only}". Known: ${Object.keys(SCREENS).join(", ")}`);
    process.exit(2);
  }

  const browser = await puppeteer.launch({ executablePath, headless: "new", args: ["--no-sandbox"] });
  let problems = 0;
  const consoleErrors = [];

  for (const [key, screen] of Object.entries(screens)) {
    console.log(`\n━━━ ${screen.label} (${key}) ━━━`);
    for (const bp of BREAKPOINTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: bp.width, height: bp.height, isMobile: bp.kind === "mobile", hasTouch: bp.kind !== "desktop" });
      page.on("pageerror", (e) => consoleErrors.push(`[${key} @ ${bp.name}] ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(`[${key} @ ${bp.name}] ${m.text()}`); });

      try {
        await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 30000 });
        if (screen.setup) {
          const { role, mode } = screen.setup;
          await page.evaluate(async (role, mode) => {
            const r = await fetch("/api/login", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username: "admin", password: "x" }),
            }).then((res) => res.json());
            if (r.token) localStorage.setItem("nsa_session", r.token); // must match LG_TOKEN_KEY in app.js
            if (mode) localStorage.setItem("nsa_mode", mode);
            // enterByRole is a global in app.js (classic script).
            if (typeof enterByRole === "function") enterByRole(role, [], "admin");
          }, role, mode);
          await new Promise((r) => setTimeout(r, 2500));
        } else {
          await new Promise((r) => setTimeout(r, 1200));
        }

        const res = await page.evaluate(auditInPage, bp.kind);
        const issues = [];
        if (res.pageOverflow) issues.push(`PAGE SCROLLS HORIZONTALLY (${res.pageOverflow.scrollWidth}px content in ${res.pageOverflow.clientWidth}px viewport)`);
        res.overflowing.forEach((o) => issues.push(`overflows viewport: ${o.el} (right edge ${o.right}px, width ${o.width}px)`));
        res.tinyFonts.forEach((t) => issues.push(`tiny font ${t.fontSize}px: ${t.el} "${t.sample}"`));
        res.smallTargets.forEach((t) => issues.push(`small touch target ${t.w}x${t.h}: ${t.el}`));

        if (!issues.length) {
          console.log(`  ✓ ${bp.name}`);
        } else {
          problems += issues.length;
          console.log(`  ✗ ${bp.name}`);
          issues.forEach((i) => console.log(`      - ${i}`));
        }
      } catch (e) {
        problems++;
        console.log(`  ! ${bp.name} - audit failed: ${e.message}`);
      }
      await page.close();
    }
  }

  if (consoleErrors.length) {
    console.log("\n━━━ Console / page errors ━━━");
    [...new Set(consoleErrors)].forEach((e) => console.log(`  - ${e}`));
  }

  console.log(`\n${problems ? `✗ ${problems} responsive issue(s) found.` : "✓ All breakpoints clean."}`);
  await browser.close();
  process.exit(problems ? 1 : 0);
})();
