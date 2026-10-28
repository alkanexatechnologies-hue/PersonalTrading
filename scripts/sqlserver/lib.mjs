// Shared helpers for the local SQL Server copy (Docker container "nsa-sqlserver"; connection in the git-ignored
// data/sqlserver.json). Used by load-research.mjs, load-app.mjs and sync.mjs.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sqlserver.json"), "utf8"));
export const CONTAINER = "nsa-sqlserver", DB = CFG.database || "NSA_MARKET";
export const ist = (t) => new Date((t + 19800) * 1000).toISOString().replace("T", " ").slice(0, 19);

/** Run T-SQL in the container (errors throw). */
export const sql = (q, db = DB) => execFileSync("docker", ["exec", CONTAINER, "/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", CFG.user, "-P", CFG.password,
  "-d", db, "-b", "-h", "-1", "-W", "-Q", `SET NOCOUNT ON; ${q}`], { encoding: "utf8", maxBuffer: 64 << 20 });

/** A TSV cell: empty = NULL; tabs / newlines can never break a row. */
export const cell = (v) => (v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v).replace(/[\t\r\n]+/g, " "));

/** Write rows to a UTF-16 TSV, copy it into the container and BULK INSERT it into an existing table. */
export function bulk(table, rows, name = table) {
  if (!rows.length) return 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsa-sql-")), f = path.join(dir, `${name}.tsv`);
  try {
    // UTF-16 ("widechar"): SQL Server on Linux has no CODEPAGE option, and the app's records carry Hindi text
    fs.writeFileSync(f, Buffer.from("\uFEFF" + rows.map((r) => r.map(cell).join("\t")).join("\n") + "\n", "utf16le"));
    execFileSync("docker", ["cp", f, `${CONTAINER}:/tmp/${name}.tsv`]);
    sql(`BULK INSERT ${table} FROM '/tmp/${name}.tsv' WITH (DATAFILETYPE = 'widechar', FIELDTERMINATOR = '\\t', ROWTERMINATOR = '\\n', KEEPNULLS, TABLOCK, BATCHSIZE = 200000);`);
    execFileSync("docker", ["exec", "-u", "0", CONTAINER, "rm", "-f", `/tmp/${name}.tsv`]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return rows.length;
}
