// ============================ Shared IST time helpers ============================
// Single source of truth for India-Standard-Time (UTC+5:30) date/time math. Every
// module that needs "what IST calendar day / minute-of-day is this timestamp"
// should use these instead of re-deriving the +19800000ms / +19800s offset locally
// (multiple independent copies of this arithmetic used to exist across the
// codebase and could silently drift from one another).

const IST_OFFSET_MS = 19_800_000; // +5:30
const IST_OFFSET_SEC = 19_800;

function toMs(d: Date | number): number {
  return d instanceof Date ? d.getTime() : d;
}

/** IST calendar date ("YYYY-MM-DD") for a Date or epoch-ms timestamp (defaults to now). */
export function istDateStr(d: Date | number = new Date()): string {
  return new Date(toMs(d) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST clock time ("HH:MM") for a Date or epoch-ms timestamp (defaults to now). */
export function istTimeStr(d: Date | number = new Date()): string {
  return new Date(toMs(d) + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** IST calendar date ("YYYY-MM-DD") for an epoch-SECONDS timestamp (candle bar time). */
export function istDateOfSec(epochSec: number): string {
  return istDateStr(epochSec * 1000);
}

/** IST clock time ("HH:MM") for an epoch-SECONDS timestamp (candle bar time). */
export function istTimeOfSec(epochSec: number): string {
  return istTimeStr(epochSec * 1000);
}

/** Minutes since IST midnight (0-1439) for an epoch-SECONDS timestamp. */
export function istMinuteOfDay(epochSec: number): number {
  const istSec = ((epochSec + IST_OFFSET_SEC) % 86_400 + 86_400) % 86_400;
  return Math.floor(istSec / 60);
}
