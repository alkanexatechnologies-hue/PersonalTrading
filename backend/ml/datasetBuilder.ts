import "./aiConfig";
import fs from "fs";
import path from "path";
import { MarketSnapshotRecord, OptionChainRecord, StrategySnapshotRecord } from "../data/tradingDataTypes";
import { buildFeatureRow, FeatureRow } from "./featureSchema";
import { buildLabels, Labels } from "./labelBuilder";

// ============================ ML dataset builder ============================
// Converts one day's raw recorded files (backend/data/liveSnapshotRecorder.ts's
// output) into ML-ready rows: FeatureRow (built from ONLY that row's own
// timestamp) + Labels (built from strictly-later snapshots — see
// labelBuilder.ts). Does NOT train anything — MODEL_TRAINING_ENABLED stays
// false regardless of what this file does (see aiConfig.ts).

const ROOT = path.join(process.cwd(), "data", "trading_data");

function readJsonl<T>(filePath: string): T[] {
  let raw = "";
  try { raw = fs.readFileSync(filePath, "utf8"); } catch { return []; }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* malformed lines are reported by data/dataQualityValidator.ts, not silently fixed here */ }
  }
  return out;
}

export interface DatasetRow extends FeatureRow {
  labels: Labels;
}

// Builds ML-ready rows for ONE calendar day (date = the IST partition folder
// name, "YYYY-MM-DD"). Labels only draw on snapshots from this SAME day's
// file that are strictly after each row's own timestamp - a row near the end
// of the day will correctly have null labels for horizons that would need
// data from the next trading day (cross-day label joining is not implemented
// yet - flagged rather than silently guessed).
export function buildDailyDataset(date: string): DatasetRow[] {
  const dir = path.join(ROOT, date);
  const marketRows = readJsonl<MarketSnapshotRecord>(path.join(dir, "market_snapshots.jsonl"));
  const chainRows = readJsonl<OptionChainRecord>(path.join(dir, "option_chain.jsonl"));
  const stratRows = readJsonl<StrategySnapshotRecord>(path.join(dir, "strategy_snapshots.jsonl"));

  const chainByKey = new Map<string, OptionChainRecord[]>();
  for (const r of chainRows) {
    const k = `${r.timestamp}|${r.symbol}`;
    if (!chainByKey.has(k)) chainByKey.set(k, []);
    chainByKey.get(k)!.push(r);
  }
  const stratByKey = new Map<string, StrategySnapshotRecord>();
  for (const r of stratRows) stratByKey.set(`${r.timestamp}|${r.symbol}`, r);

  const bySymbol = new Map<string, MarketSnapshotRecord[]>();
  for (const r of marketRows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push(r);
  }
  for (const arr of bySymbol.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

  const out: DatasetRow[] = [];
  for (const market of marketRows) {
    const key = `${market.timestamp}|${market.symbol}`;
    const feature = buildFeatureRow(market, chainByKey.get(key) || [], stratByKey.get(key) || null);
    const labels = buildLabels(market.timestamp, market.spot, bySymbol.get(market.symbol) || []);
    out.push({ ...feature, labels });
  }
  return out;
}

export function writeDailyDataset(date: string): { rows: number; filePath: string } {
  const rows = buildDailyDataset(date);
  const dir = path.join(ROOT, date);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "ml_dataset.jsonl");
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  return { rows: rows.length, filePath };
}
