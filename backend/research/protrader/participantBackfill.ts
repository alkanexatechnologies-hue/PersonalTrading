// Backfill the NSE participant-wise OI history (raw CSV + parsed rows) for the positioning engine and its backtest.
// NSE public archive, one file at a time with a pause; already-stored dates are skipped. Usage: npx tsx participantBackfill.ts [from] [to]
import { ingestDates, loadHistory } from "../../sentiment/participantHistory";

const from = process.argv[2] || "2024-10-01", to = process.argv[3] || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const dates: string[] = [];
for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86400_000) { const d = new Date(t); if (d.getUTCDay() % 6 !== 0) dates.push(d.toISOString().slice(0, 10)); }
(async () => {
  let n = 0;
  const r = await ingestDates(dates, { pauseMs: 400, onDay: (d, x) => { if (++n % 50 === 0) console.log(n, d, x); } });
  const s = loadHistory(), counts: Record<string, number> = {};
  for (const v of Object.values(r)) counts[v] = (counts[v] || 0) + 1;
  const ks = Object.keys(s.days).sort();
  console.log(JSON.stringify({ tried: Object.keys(r).length, results: counts, stored: ks.length, first: ks[0], last: ks[ks.length - 1], rejected: s.rejected, corrections: s.corrections.length }));
  process.exit(0);
})();
