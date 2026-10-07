import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildOiMinuteRows, writeOiMinute, listOiMinuteDays, oiMinuteFilePath, SUMMARY_HEADER, STRIKE_HEADER } from "./oiMinuteLog";

const strikes = Array.from({ length: 41 }, (_, i) => ({ strike: 22000 + i * 50, ceOi: 1000 + i, peOi: 2000 - i, ceChg: 10, peChg: -5, ceVol: 1, peVol: 2, ceLtp: 100 - i, peLtp: i + 1, ceIv: 12, peIv: 13, ceDelta: 0.5, peDelta: -0.5 }));
const input = (timeIST: string) => ({ date: "2026-10-08", timeIST, symbol: "^NSEI", index: "NIFTY", spot: 22612, chainAsOf: 1000, nowSec: 1030,
  oi: { expiry: "2026-10-13", pcr: 0.9, totalCeOi: 5, totalPeOi: 6, support: 22000, resistance: 23000, maxPain: 22600, topStrikes: strikes } });

test("summary row: ATM is the strike nearest spot, totals summed, chain age in seconds", () => {
  const r = buildOiMinuteRows(input("09:16"));
  const f = r.summary.split(",");
  const h = SUMMARY_HEADER.split(",");
  const at = (k: string) => f[h.indexOf(k)];
  assert.equal(f.length, h.length);
  assert.equal(at("atmStrike"), "22600");
  assert.equal(at("chainAgeSec"), "30");
  assert.equal(at("ceChgTotal"), "410");
  assert.equal(at("peChgTotal"), "-205");
});

test("strike rows: ATM ± 10 strikes with distance from spot", () => {
  const r = buildOiMinuteRows(input("09:16"));
  assert.equal(r.strikes.length, 21);
  const h = STRIKE_HEADER.split(",");
  const first = r.strikes[0].split(",");
  assert.equal(first[h.indexOf("strike")], "22100");
  assert.equal(first[h.indexOf("distFromSpot")], "-512");
});

test("write: one file set per day, header once, same minute not written twice; safe file lookup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oimin-"));
  assert.equal(writeOiMinute(input("09:16"), dir), true);
  assert.equal(writeOiMinute(input("09:16"), dir), false);
  assert.equal(writeOiMinute(input("09:17"), dir), true);
  const sum = fs.readFileSync(path.join(dir, "2026-10-08", "summary.csv"), "utf8").trim().split("\n");
  assert.equal(sum.length, 3);
  assert.equal(sum[0], SUMMARY_HEADER);
  const days = listOiMinuteDays(dir);
  assert.deepEqual(days[0].files.map((f) => f.name), ["strikes-NIFTY.csv", "summary.csv"]);
  assert.ok(oiMinuteFilePath("2026-10-08", "summary.csv", dir));
  assert.equal(oiMinuteFilePath("2026-10-08", "../users.json", dir), null);
  assert.equal(oiMinuteFilePath("../x", "summary.csv", dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
