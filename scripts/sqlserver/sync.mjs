#!/usr/bin/env node
// Daily refresh of the local SQL Server copy: the 2-year market data, then the app's own records.
//   node scripts/sqlserver/sync.mjs
// The app runs this after the 15:50 research refresh when data/sqlserver.json exists (the owner's Mac; never on Render).
import path from "path";
import { execFileSync } from "child_process";
import { ROOT } from "./lib.mjs";

const run = (f) => execFileSync(process.execPath, [path.join(ROOT, "scripts", "sqlserver", f)], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
const t0 = Date.now();
const research = run("load-research.mjs").trim().split("\n").filter((l) => /rows|NIFTY|SENSEX|done/.test(l)).slice(-3).join(" | ");
const app = run("load-app.mjs").trim().split("\n").join(" | ");
console.log(`[sql-sync] ${Math.round((Date.now() - t0) / 1000)}s · ${research} · ${app}`);
