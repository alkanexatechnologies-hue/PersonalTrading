// Uses a clearly-fake, far-future test date partition; writes its own raw
// JSONL directly (not through the recorder) so each quality problem can be
// deliberately constructed and checked in isolation. Cleans up after itself.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { validateDay } from "./dataQualityValidator";

const TEST_DATE = "2099-06-15";
const DIR = path.join(process.cwd(), "data", "trading_data", TEST_DATE);

after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeJsonl(name: string, rows: unknown[]) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const T = 2_000_000_000;

test("dataQualityValidator flags missing CE/PE, invalid prices, invalid OI, expiry mismatch, and malformed lines", () => {
  writeJsonl("market_snapshots.jsonl", [
    { timestamp: T, symbol: "^NSEI", expiry: "2099-07-01", spot: 24500 },
  ]);
  fs.appendFileSync(path.join(DIR, "market_snapshots.jsonl"), "{not valid json\n", "utf8"); // malformed line

  writeJsonl("option_chain.jsonl", [
    { timestamp: T, symbol: "^NSEI", expiry: "2099-07-01", strike: 24500, optionType: "CE", ltp: 100, openInterest: 5000, oiChange: 10 },
    // PE row for the same strike deliberately OMITTED -> missing CE/PE pair
    { timestamp: T, symbol: "^NSEI", expiry: "2099-07-01", strike: 24600, optionType: "CE", ltp: -5, openInterest: -100, oiChange: 0 }, // invalid price + invalid OI
    { timestamp: T, symbol: "^NSEI", expiry: "2099-07-01", strike: 24600, optionType: "PE", ltp: 50, openInterest: 4000, oiChange: 0 },
    { timestamp: T, symbol: "^NSEI", expiry: "WRONG-EXPIRY", strike: 24700, optionType: "CE", ltp: 30, openInterest: 3000, oiChange: 0 }, // expiry mismatch
    { timestamp: T, symbol: "^NSEI", expiry: "WRONG-EXPIRY", strike: 24700, optionType: "PE", ltp: 30, openInterest: 3000, oiChange: 0 },
  ]);

  writeJsonl("strategy_snapshots.jsonl", [{ timestamp: T, symbol: "^NSEI" }]);

  const report = validateDay(TEST_DATE);
  assert.equal(report.marketSnapshots.malformed, 1);
  assert.equal(report.optionChain.missingCeOrPe, 1); // the 24500 strike, missing its PE
  assert.equal(report.optionChain.invalidPrices, 1); // the -5 ltp
  assert.equal(report.optionChain.invalidOi, 1); // the -100 OI
  assert.equal(report.optionChain.expiryMismatches, 2); // the two WRONG-EXPIRY rows
  assert.ok(report.qualityScorePercent < 100);
});

test("dataQualityValidator flags duplicate timestamps and timestamp gaps", () => {
  const gapDate = "2099-06-16";
  const gapDir = path.join(process.cwd(), "data", "trading_data", gapDate);
  fs.mkdirSync(gapDir, { recursive: true });
  fs.writeFileSync(
    path.join(gapDir, "market_snapshots.jsonl"),
    [
      { timestamp: T, symbol: "^NSEI", expiry: null, spot: 100 },
      { timestamp: T, symbol: "^NSEI", expiry: null, spot: 100 }, // exact duplicate timestamp+symbol
      { timestamp: T + 3600, symbol: "^NSEI", expiry: null, spot: 101 }, // 1-hour gap — well beyond ordinary polling
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8"
  );
  const report = validateDay(gapDate);
  assert.equal(report.marketSnapshots.duplicateTimestamps, 1);
  assert.ok(report.timestampGaps.count >= 1);
  fs.rmSync(gapDir, { recursive: true, force: true });
});

test("dataQualityValidator reports 100% quality on a clean day with no records (no false positives)", () => {
  const emptyDate = "2099-06-17";
  const report = validateDay(emptyDate);
  assert.equal(report.marketSnapshots.total, 0);
  assert.equal(report.qualityScorePercent, 100);
});
