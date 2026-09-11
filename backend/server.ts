// Trust the OS (Windows) certificate store so Node's fetch accepts corporate-proxy /
// antivirus self-signed root CAs (fixes "fetch failed" to api.groww.in). Node 22.15+/24.
import tls from "node:tls";
try {
  const anyTls = tls as any;
  if (typeof anyTls.getCACertificates === "function" && typeof anyTls.setDefaultCACertificates === "function") {
    const system = anyTls.getCACertificates("system") || [];
    const bundled = anyTls.getCACertificates("bundled") || [];
    anyTls.setDefaultCACertificates([...bundled, ...system]);
    // eslint-disable-next-line no-console
    console.log(`  TLS: trusting ${system.length} system + ${bundled.length} bundled CAs`);
  }
} catch {
  /* older Node - rely on NODE_OPTIONS=--use-system-ca instead */
}

import express from "express";
import cors from "cors";
import path from "path";
import apiRouter, { startHourlyScheduler } from "./routes/api";
import { CONFIG } from "./config";
import { getProvider } from "./data";
import { getExitCheckHealth } from "./paper/engine";

const app = express();

// This is a personal, local dashboard (see auth/session.ts) - no other origin
// should be able to call the API at all, cross-origin or otherwise.
app.use(cors({ origin: false }));
app.use(express.json());

// API
app.use("/api", apiRouter);

// Static dashboard - disable caching so UI updates always load (no stale JS/HTML).
const publicDir = path.join(__dirname, "..", "frontend");
app.use(
  express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store, max-age=0"),
  })
);
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.sendFile(path.join(publicDir, "index.html"));
});

// Health
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    provider: getProvider().name,
    time: new Date().toISOString(),
    unhandledRejections: unhandledRejectionCount,
    exitCheckFailures: getExitCheckHealth(),
  })
);

// Process-wide unhandled-rejection safety net. Previously log-only, so a
// rejection escaping a poller vanished into the console with no operational
// signal. Now also counted and surfaced on /health so a persistent failure is
// visible from the outside instead of indistinguishable from silence.
let unhandledRejectionCount = 0;
process.on("unhandledRejection", (err) => {
  unhandledRejectionCount++;
  console.error(`[unhandledRejection] (#${unhandledRejectionCount})`, err instanceof Error ? err.message : err);
});

app.listen(CONFIG.port, () => {
  console.log(`\n  NSE Intraday Assistant`);
  console.log(`  ----------------------`);
  console.log(`  Data provider : ${getProvider().name}`);
  console.log(`  Dashboard     : http://localhost:${CONFIG.port}`);
  console.log(`  API base      : http://localhost:${CONFIG.port}/api\n`);
  // Auto-record the hourly 15-min-model shortlist (9:30-15:30 IST) for evening backtest.
  startHourlyScheduler();
});
