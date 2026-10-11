import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { readXlsFirstSheet } from "./xlsBiff";
import { parseFiiStats, indexFlows, type FiiStatsDay } from "./nseFiiStats";

// Real NSE file: fii_stats_09-Oct-2026.xls
const grid = readXlsFirstSheet(fs.readFileSync(path.join(__dirname, "__fixtures__", "fii_stats_09-Oct-2026.xls")));

test("xls reader returns the NSE sheet cells", () => {
  assert.equal(grid[0][0], "FII DERIVATIVES STATISTICS FOR 09-Oct-2026");
  assert.deepEqual(grid[7], ["NIFTY FUTURES", "19372", "2840.06", "8612", "1261.90", "280405", "41238.31"]);
  assert.throws(() => readXlsFirstSheet(Buffer.from("<html>blocked</html>")));
});

test("parses index-wise rows and checks they add up to the totals", () => {
  const { day } = parseFiiStats(grid, "2026-10-09");
  assert.ok(day);
  assert.deepEqual(day!.fut.NIFTY, { buyC: 19372, buyCr: 2840.06, sellC: 8612, sellCr: 1261.9, oiC: 280405, oiCr: 41238.31 });
  assert.equal(day!.fut.TOTAL.oiC, 363874);
  assert.equal(day!.opt.BANKNIFTY.oiC, 505599);
});

test("rejects wrong date and rows that do not add up", () => {
  assert.match(parseFiiStats(grid, "2026-10-08").reason || "", /title date/);
  const bad = grid.map((r) => [...r]); bad[7][5] = "280406";
  assert.match(parseFiiStats(bad, "2026-10-09").reason || "", /≠ total/);
  const missing = grid.filter((r) => r[0] !== "BANKNIFTY FUTURES");
  assert.equal(parseFiiStats(missing, "2026-10-09").day, null);
});

test("index flows: ΔLong/ΔShort from bought − sold and ΔOI", () => {
  const d9 = parseFiiStats(grid, "2026-10-09").day!;
  // previous day with OI chosen so NIFTY ΔOI = −9,470 (as on 08 Oct)
  const d8: FiiStatsDay = JSON.parse(JSON.stringify(d9)); d8.date = "2026-10-08";
  d8.fut.NIFTY.oiC = 280405 + 9470; d8.fut.TOTAL.oiC = 363874 + 6401;
  const f = indexFlows([d8, d9]);
  const nifty = f.find((r) => r.index === "NIFTY")!, tot = f[0];
  assert.equal(nifty.netC, 10760);
  assert.equal(nifty.dLong, 645); assert.equal(nifty.dShort, -10115);
  assert.equal(nifty.type, "SHORT COVERING");
  assert.equal(nifty.share, 77.1);
  assert.equal(tot.dLong, 3360); assert.equal(tot.dShort, -9761);   // = participant file 08→09 Oct
  assert.equal(nifty.net5C, null);                                   // fewer than 5 days → not shown
});
