// ============================ News impact (Market Sentiment) ============================
// Rows built from the news-intelligence result (fresh items only). Each row: time / age, headline,
// source, affected sectors / index, impact, strength, freshness, and whether it is a CONFIRMED FACT
// (official source: RBI, Fed, EIA, White House, USTR, Federal Register) or a REPORT (media). The
// impact text is the app's rule-based INTERPRETATION and is labelled as such. Headlines repeated
// across categories are merged. New high-strength headlines are returned by `newMajor` so the
// server can record a prediction reassessment.

export type NewsTab = "Positive" | "Negative" | "Neutral" | "Mixed";
export interface NewsRow { id: string; ts: number; ageH: number; headline: string; source: string; category: string; affected: string[]; impact: NewsTab; strength: "High" | "Medium" | "Low"; kind: "CONFIRMED FACT" | "REPORT"; interpretation: string | null; link: string }

const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3));
function similar(a: string, b: string) { const A = words(a), B = words(b); let i = 0; for (const w of A) if (B.has(w)) i++; const u = A.size + B.size - i; return u > 0 && i / u >= 0.5; }

export function newsRows(intel: any, maxAgeH = 3): NewsRow[] {
  const rows: NewsRow[] = [];
  for (const c of intel?.categories || []) for (const it of c.items || []) {
    if (it.ageH == null || it.ageH > maxAgeH) continue;
    const impact: NewsTab = it.dir > 0 ? "Positive" : it.dir < 0 ? "Negative" : it.note ? "Mixed" : "Neutral";
    const official = it.tier === "OFFICIAL";
    const strength: NewsRow["strength"] = it.dir !== 0 && (official || ["RBI", "Oil", "Rupee", "Fed"].includes(c.label)) ? "High" : it.dir !== 0 ? "Medium" : "Low";
    const row: NewsRow = { id: `${it.source}|${it.title}`.slice(0, 160), ts: it.epoch, ageH: it.ageH, headline: it.title, source: it.source, category: c.label,
      affected: [...new Set([c.label, ...(it.pos || []), ...(it.neg || [])])].slice(0, 4), impact, strength,
      kind: official ? "CONFIRMED FACT" : "REPORT", interpretation: it.note ? `Interpretation: ${it.note}` : null, link: it.link || "" };
    const dup = rows.find((r) => similar(r.headline, row.headline));
    if (dup) { if (row.kind === "CONFIRMED FACT" && dup.kind !== "CONFIRMED FACT") Object.assign(dup, row); continue; }
    rows.push(row);
  }
  return rows.sort((a, b) => b.ts - a.ts);
}
export function newsTabs(rows: NewsRow[]) {
  const n = (k: NewsTab) => rows.filter((r) => r.impact === k).length;
  return { All: rows.length, Positive: n("Positive"), Negative: n("Negative"), Neutral: n("Neutral"), Mixed: n("Mixed") };
}
/** High-strength rows not seen before (ids in `seen`). */
export function newMajor(rows: NewsRow[], seen: Set<string>): NewsRow[] { return rows.filter((r) => r.strength === "High" && !seen.has(r.id)); }
