#!/usr/bin/env node
// Copy the research market data (real Dhan 1-min option + index data, ~2 years, 5 indices) into the local SQL Server
// database NSA_MARKET (Docker container "nsa-sqlserver"; connection in data/sqlserver.json, which git ignores).
//
//   node scripts/sqlserver/load-research.mjs            # full reload of every table
//
// Tables: option_minute (every 1-min bar of ATM ±3 CE / PE, with spot, OI, IV, volume), index_minute (index spot per minute)
// and index_daily (daily OHLC from the minutes). Times are IST. The source files are the research raw1m chunks that the
// 15:50 research refresh keeps adding to, so re-running this picks up the newest sessions.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sqlserver.json"), "utf8"));
const CONTAINER = "nsa-sqlserver", DB = CFG.database || "NSA_MARKET";
const SOURCES = {
  NIFTY: path.join(ROOT, "data", "research-nifty20", "raw1m"),
  SENSEX: path.join(ROOT, "data", "research-multi", "SENSEX", "raw1m"),
  BANKNIFTY: path.join(ROOT, "data", "research-multi", "BANKNIFTY", "raw1m"),
  FINNIFTY: path.join(ROOT, "data", "research-multi", "FINNIFTY", "raw1m"),
  MIDCPNIFTY: path.join(ROOT, "data", "research-multi", "MIDCPNIFTY", "raw1m"),
};
const ist = (t) => new Date((t + 19800) * 1000).toISOString().replace("T", " ").slice(0, 19);
const sql = (q, db = DB) => execFileSync("docker", ["exec", CONTAINER, "/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", CFG.user, "-P", CFG.password, "-d", db, "-b", "-h", "-1", "-W", "-Q", `SET NOCOUNT ON; ${q}`], { encoding: "utf8", maxBuffer: 64 << 20 });
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : String(v));

sql(`IF DB_ID('${DB}') IS NULL CREATE DATABASE ${DB};`, "master");
sql(`
IF OBJECT_ID('dbo.option_minute') IS NOT NULL DROP TABLE dbo.option_minute;
CREATE TABLE dbo.option_minute (
  index_name VARCHAR(12) NOT NULL, bar_time DATETIME2(0) NOT NULL, trade_date DATE NOT NULL,
  option_type CHAR(2) NOT NULL, atm_offset SMALLINT NOT NULL, strike DECIMAL(10,2) NULL,
  [open] DECIMAL(12,2) NULL, [high] DECIMAL(12,2) NULL, [low] DECIMAL(12,2) NULL, [close] DECIMAL(12,2) NULL,
  spot DECIMAL(12,2) NULL, oi BIGINT NULL, iv DECIMAL(9,4) NULL, volume BIGINT NULL);`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nsa-sql-"));
let total = 0;
try {
  for (const [name, dir] of Object.entries(SOURCES)) {
    let files = []; try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_(CE|PE)_-?\d+\.json$/.test(f)); } catch { continue; }
    const out = path.join(tmp, `${name}.tsv`), w = fs.openSync(out, "w"); let rows = 0;
    for (const f of files.sort()) {
      const [, , side, rel] = f.replace(".json", "").split("_");
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      const ts = d.timestamp || []; let buf = "";
      for (let i = 0; i < ts.length; i++) {
        const bt = ist(ts[i]);
        buf += [name, bt, bt.slice(0, 10), side, rel, num(d.strike?.[i]), num(d.open?.[i]), num(d.high?.[i]), num(d.low?.[i]), num(d.close?.[i]), num(d.spot?.[i]), num(d.oi?.[i]), num(d.iv?.[i]), num(d.volume?.[i])].join("\t") + "\n";
        rows++;
      }
      fs.writeSync(w, buf);
    }
    fs.closeSync(w);
    execFileSync("docker", ["cp", out, `${CONTAINER}:/tmp/${name}.tsv`]);
    sql(`BULK INSERT dbo.option_minute FROM '/tmp/${name}.tsv' WITH (FIELDTERMINATOR = '\\t', ROWTERMINATOR = '0x0a', KEEPNULLS, TABLOCK, BATCHSIZE = 200000);`);
    execFileSync("docker", ["exec", "-u", "0", CONTAINER, "rm", "-f", `/tmp/${name}.tsv`]);
    fs.rmSync(out); total += rows;
    console.log(`${name}: ${files.length} files, ${rows.toLocaleString("en-IN")} option rows`);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// the same minute can sit in two overlapping chunks: keep one row per index / minute / side / offset
sql(`
;WITH d AS (SELECT ROW_NUMBER() OVER (PARTITION BY index_name, bar_time, option_type, atm_offset ORDER BY (SELECT NULL)) AS rn FROM dbo.option_minute)
DELETE FROM d WHERE rn > 1;
CREATE CLUSTERED INDEX cx_option_minute ON dbo.option_minute (index_name, bar_time, option_type, atm_offset);
CREATE INDEX ix_option_minute_day ON dbo.option_minute (index_name, trade_date) INCLUDE (strike, option_type, [close], oi);

IF OBJECT_ID('dbo.index_minute') IS NOT NULL DROP TABLE dbo.index_minute;
SELECT index_name, bar_time, trade_date, CAST(AVG(spot) AS DECIMAL(12,2)) AS spot
INTO dbo.index_minute FROM dbo.option_minute WHERE spot > 0
  AND CAST(bar_time AS TIME) >= '09:15' AND CAST(bar_time AS TIME) < '15:30'
GROUP BY index_name, bar_time, trade_date;
CREATE UNIQUE CLUSTERED INDEX cx_index_minute ON dbo.index_minute (index_name, bar_time);

IF OBJECT_ID('dbo.index_daily') IS NOT NULL DROP TABLE dbo.index_daily;
;WITH m AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY index_name, trade_date ORDER BY bar_time) AS f,
                      ROW_NUMBER() OVER (PARTITION BY index_name, trade_date ORDER BY bar_time DESC) AS l FROM dbo.index_minute)
SELECT index_name, trade_date, MAX(CASE WHEN f = 1 THEN spot END) AS [open], MAX(spot) AS [high], MIN(spot) AS [low],
       MAX(CASE WHEN l = 1 THEN spot END) AS [close], COUNT(*) AS minutes
INTO dbo.index_daily FROM m GROUP BY index_name, trade_date;
CREATE UNIQUE CLUSTERED INDEX cx_index_daily ON dbo.index_daily (index_name, trade_date);`);

console.log(sql(`SELECT 'option_minute', COUNT_BIG(*) FROM dbo.option_minute UNION ALL SELECT 'index_minute', COUNT_BIG(*) FROM dbo.index_minute UNION ALL SELECT 'index_daily', COUNT_BIG(*) FROM dbo.index_daily;`));
console.log(sql(`SELECT index_name, MIN(trade_date), MAX(trade_date), COUNT(*) FROM dbo.index_daily GROUP BY index_name ORDER BY index_name;`));
console.log(`done: ${total.toLocaleString("en-IN")} rows read`);
