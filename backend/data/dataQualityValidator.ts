import fs from "fs";
import path from "path";
import { MarketSnapshotRecord, OptionChainRecord, StrategySnapshotRecord } from "./tradingDataTypes";

// ============================ Daily data-quality validator ============================
// Read-only: inspects one day's recorded JSONL files and reports problems. It
// never edits or deletes a recorded row — bad data is reported, not silently
// dropped or "fixed" (fixing it would mean guessing, which is exactly what
// this whole recorder is built to avoid).

const ROOT = path.join(process.cwd(), "data", "trading_data");

// Recorder polls opportunistically (driven by /oi-command traffic, not a
// fixed timer) - during market hours that's typically every 15-60s while a
// tab is open. A gap is only flagged once it's clearly beyond ordinary
// polling jitter, not a fixed strategy threshold.
const EXPECTED_MAX_GAP_SEC = 5 * 60;

export interface DailyQualityReport {
  date: string;
  generatedAt: number;
  marketSnapshots: { total: number; malformed: number; duplicateTimestamps: number };
  optionChain: { total: number; malformed: number; missingCeOrPe: number; invalidPrices: number; invalidOi: number; expiryMismatches: number };
  strategySnapshots: { total: number; malformed: number };
  timestampGaps: { count: number; maxGapSec: number };
  missingStrikesForSnapshots: number; // market_snapshots with zero matching option_chain rows
  qualityScorePercent: number; // simple: 100 - (problems / total records) * 100, floored at 0
}

function readJsonl<T>(filePath: string): { records: T[]; malformed: number } {
  let raw = "";
  try { raw = fs.readFileSync(filePath, "utf8"); } catch { return { records: [], malformed: 0 }; }
  const records: T[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { records, malformed };
}

export function validateDay(date: string): DailyQualityReport {
  const dir = path.join(ROOT, date);
  const { records: marketRows, malformed: marketMalformed } = readJsonl<MarketSnapshotRecord>(path.join(dir, "market_snapshots.jsonl"));
  const { records: chainRows, malformed: chainMalformed } = readJsonl<OptionChainRecord>(path.join(dir, "option_chain.jsonl"));
  const { records: stratRows, malformed: stratMalformed } = readJsonl<StrategySnapshotRecord>(path.join(dir, "strategy_snapshots.jsonl"));

  // duplicate timestamps in market_snapshots (dedup at write-time already
  // prevents this — this is a second, independent check on the file itself).
  const seenTs = new Map<string, number>();
  for (const r of marketRows) {
    const k = `${r.timestamp}|${r.symbol}`;
    seenTs.set(k, (seenTs.get(k) || 0) + 1);
  }
  const duplicateTimestamps = [...seenTs.values()].filter((n) => n > 1).length;

  // gaps between consecutive market_snapshots, per symbol.
  const bySymbol = new Map<string, number[]>();
  for (const r of marketRows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push(r.timestamp);
  }
  let gapCount = 0;
  let maxGap = 0;
  for (const times of bySymbol.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap > maxGap) maxGap = gap;
      if (gap > EXPECTED_MAX_GAP_SEC) gapCount++;
    }
  }

  // option_chain: missing CE/PE pairs, invalid prices/OI.
  const chainByStrike = new Map<string, Set<string>>(); // "ts|symbol|expiry|strike" -> set of optionTypes seen
  let invalidPrices = 0;
  let invalidOi = 0;
  for (const r of chainRows) {
    const k = `${r.timestamp}|${r.symbol}|${r.expiry}|${r.strike}`;
    if (!chainByStrike.has(k)) chainByStrike.set(k, new Set());
    chainByStrike.get(k)!.add(r.optionType);
    if (r.ltp != null && (r.ltp < 0 || !Number.isFinite(r.ltp))) invalidPrices++;
    if (r.openInterest != null && (r.openInterest < 0 || !Number.isFinite(r.openInterest))) invalidOi++;
  }
  const missingCeOrPe = [...chainByStrike.values()].filter((set) => set.size < 2).length;

  // expiry mismatch: a chain row's expiry differs from its market_snapshot's expiry.
  const expiryBySnapshot = new Map<string, string | null>();
  for (const r of marketRows) expiryBySnapshot.set(`${r.timestamp}|${r.symbol}`, r.expiry);
  let expiryMismatches = 0;
  for (const r of chainRows) {
    const expected = expiryBySnapshot.get(`${r.timestamp}|${r.symbol}`);
    if (expected !== undefined && expected !== null && r.expiry !== expected) expiryMismatches++;
  }

  // market_snapshots with zero option_chain rows at the same timestamp+symbol.
  const chainKeysBySnapshot = new Set<string>();
  for (const r of chainRows) chainKeysBySnapshot.add(`${r.timestamp}|${r.symbol}`);
  const missingStrikesForSnapshots = marketRows.filter((r) => !chainKeysBySnapshot.has(`${r.timestamp}|${r.symbol}`)).length;

  const totalRecords = marketRows.length + chainRows.length + stratRows.length || 1;
  const problems =
    marketMalformed + chainMalformed + stratMalformed +
    duplicateTimestamps + invalidPrices + invalidOi + expiryMismatches +
    missingCeOrPe + gapCount + missingStrikesForSnapshots;
  const qualityScorePercent = Math.max(0, Math.round((1 - problems / totalRecords) * 1000) / 10);

  return {
    date,
    generatedAt: Date.now(),
    marketSnapshots: { total: marketRows.length, malformed: marketMalformed, duplicateTimestamps },
    optionChain: { total: chainRows.length, malformed: chainMalformed, missingCeOrPe, invalidPrices, invalidOi, expiryMismatches },
    strategySnapshots: { total: stratRows.length, malformed: stratMalformed },
    timestampGaps: { count: gapCount, maxGapSec: maxGap },
    missingStrikesForSnapshots,
    qualityScorePercent,
  };
}

export function writeQualityReport(date: string): DailyQualityReport {
  const report = validateDay(date);
  const dir = path.join(ROOT, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "quality_report.json"), JSON.stringify(report, null, 2), "utf8");
  return report;
}
