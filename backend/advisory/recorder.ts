import { SuggestionRecord, appendSuggestion, dedupeKey } from "./suggestionLog";

// ============================ Dedupe-aware recorder ============================
// The dashboard re-polls every ~15 seconds, so a standing suggestion would
// otherwise be written dozens of times per 5-minute bar and inflate every
// accuracy denominator. One row per symbol / suggestion / strike / 5-min bucket.
//
// The seen-set is in-memory and therefore resets on restart. That is acceptable:
// a duplicate row across a restart is a small, visible artefact, whereas a
// persistent index would be one more thing to keep correct.

const seen = new Set<string>();
const MAX_SEEN = 5000;

/** Records the suggestion unless an equivalent one was already logged. */
export function recordAdvisorySuggestion(rec: SuggestionRecord): boolean {
  const key = dedupeKey(rec);
  if (seen.has(key)) return false;
  if (seen.size >= MAX_SEEN) seen.clear(); // bounded; keys are time-bucketed anyway
  seen.add(key);
  appendSuggestion(rec);
  return true;
}

/** Test helper - lets a test start from a clean dedupe state. */
export function _resetAdvisoryDedupe(): void {
  seen.clear();
}
