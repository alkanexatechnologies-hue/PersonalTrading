// ============================================================================
//  OI ANALYSIS MODULE — audit log  (ADDITIVE, append-only)
// ----------------------------------------------------------------------------
//  Records each OI Analysis read with its NUMERICAL evidence so any bias/summary
//  shown on screen can be reconstructed and reviewed after the fact. Append-only
//  JSONL-style store, capped. No trading side-effects.
// ============================================================================

import fs from "fs";
import path from "path";

export interface OiAnalysisAuditEntry {
  timestamp: number;      // epoch ms
  asOf: number;           // chain data timestamp
  symbol: string;
  screen: "movement" | "summary";
  underlying: number | null;
  pcr: number | null;
  totalCeOi: number | null;
  totalPeOi: number | null;
  callWall: number | null;      // strike
  putWall: number | null;       // strike
  bias: string;
  confidencePct: number | null;
  samples: number | null;       // intraday store depth (movement)
  evidence: Array<{ label: string; value: string; lean: string }>;
  surges: string[];
}

const FILE = path.join(process.cwd(), "data", "oi-analysis-log.json");
const CAP = 2000;

function loadAll(): OiAnalysisAuditEntry[] {
  try { const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")); return Array.isArray(raw) ? raw : []; } catch { return []; }
}
function saveAll(entries: OiAnalysisAuditEntry[]): void {
  try {
    const dir = path.dirname(FILE);
    fs.mkdirSync(dir, { recursive: true });
    const capped = entries.slice(-CAP);
    const tmp = path.join(dir, `.oi-analysis-log.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(capped, null, 2), { encoding: "utf-8" });
    fs.renameSync(tmp, FILE);
  } catch { /* best-effort — audit must never break a read */ }
}

export function logOiAnalysis(entry: OiAnalysisAuditEntry): void {
  const all = loadAll();
  all.push(entry);
  saveAll(all);
}

export function getOiAnalysisAuditLog(filter?: { symbol?: string; limit?: number }): OiAnalysisAuditEntry[] {
  let entries = loadAll();
  if (filter?.symbol) entries = entries.filter((e) => e.symbol === filter.symbol);
  entries = entries.slice().reverse();
  return filter?.limit ? entries.slice(0, filter.limit) : entries;
}
