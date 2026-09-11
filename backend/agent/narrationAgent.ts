// ==================== Market-Hours Guidance Agent (v1) ====================
// A NARRATION LAYER on top of the existing pipeline — never a decision-maker.
// It subscribes to centralLog, and on qualifying STATE-CHANGE events emits one
// short plain-language sentence explaining what just happened and why, logged to
// the 'agent-narration' channel and linked to the source entry's id.
//
// Hard guarantees (match the spec's guardrails):
//   • Reads centralLog only — no new signal source, never proposes a trade.
//   • Never contradicts / suggests overriding a WAIT / CONFLICT / veto.
//   • Fires on state changes only (the events centralLog already records), never
//     on a fixed poll. Silence = nothing changed = current view still accurate.
//   • Text generation is pluggable: a DETERMINISTIC TEMPLATE by default (cannot
//     invent numbers), or Claude when ANTHROPIC_API_KEY is set. LLM failure/timeout
//     degrades silently — it never blocks or delays the pipeline.
//   • Never narrates its own channel (no feedback loop).

import * as centralLog from "../log/centralLog";
import { LogEntry } from "../log/centralLog";

// ---- which events are worth narrating (all already in centralLog) ----
const NARRATABLE: Record<string, Record<string, string>> = {
  arbitration: { ARBITER_GO: "go", ARBITER_WAIT: "wait", ARBITER_CONFLICT: "conflict" },
  decision: {
    GO_WAIT_FLIP: "flip", REGIME_CHANGE: "regime", VETO_DECAYING: "veto",
    DEDUP_SUPPRESSED: "dedup", SENTIMENT_CHANGE: "sentiment", LIQUIDITY_FLIP: "liquidity",
    WALL_REACTION: "wall",
  },
  verification: { WATCHDOG_SCORE_OUT_OF_BAND: "watchdog", WATCHDOG_CONFLICT_PERSIST: "watchdog" },
  "oi-command": { DATA_HEALTH_DEGRADE: "health", DATA_HEALTH_RESTORED: "health" },
};

function isNarratable(e: LogEntry): boolean {
  return !!(NARRATABLE[e.channel] && NARRATABLE[e.channel][e.eventType]);
}

// ---- market-hours gate (IST 09:15–15:30, Mon–Fri) ----
function marketHoursIST(now = Date.now()): boolean {
  if (process.env.NARRATION_ALWAYS === "1") return true; // test override
  const ist = new Date(now + 19800000);
  const day = ist.getUTCDay(); // 0=Sun..6=Sat (in IST-shifted date)
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930;
}

// ---- context from centralLog only (no new signal source) ----
function latestSummary(channel: centralLog.LogChannel, eventType: string, symbol: string | null): string | null {
  const rows = centralLog.query({ channel, eventType, symbol: symbol || undefined, limit: 1 });
  return rows.length ? rows[0].summary : null;
}
function buildContext(e: LogEntry): Record<string, any> {
  return {
    symbol: e.symbol,
    regime: latestSummary("decision", "REGIME_CHANGE", e.symbol),
    sentiment: latestSummary("decision", "SENTIMENT_CHANGE", e.symbol),
    liquidity: latestSummary("decision", "LIQUIDITY_FLIP", e.symbol),
    lastEmitted: latestSummary("decision", "TRADE_EMITTED", e.symbol),
  };
}

// ---- deterministic template narrator (default; cannot invent numbers) ----
// Only echoes fields already present in the entry/context.
function templateNarration(e: LogEntry): string | null {
  const sym = e.symbol || "the index";
  const kind = NARRATABLE[e.channel]?.[e.eventType];
  switch (kind) {
    case "go":
      return `${sym}: system flipped to GO — one primary trade is now on the board. Check the Take card; the arbiter picked a single side on purpose.`;
    case "wait":
      return `${sym}: back to WAIT — nothing clears the bar right now, so sitting out is the read (not a missed trade).`;
    case "conflict":
      return `${sym}: CONFLICT — two setups point opposite ways and neither is clearly cleaner, so the system deliberately won't pick one. No trade until it resolves.`;
    case "flip":
      return `${sym}: ${e.summary}.`;
    case "regime":
      return `${sym}: ${e.summary} — the kind of move to expect just changed, so read setups in that light.`;
    case "veto":
      return `${sym}: a bought option looked tempting but its premium is actually bleeding, not just lagging — the system skipped it on purpose (hard veto, not a glitch).`;
    case "dedup":
      return `${sym}: same setup as one already live/just-exited — held back so it doesn't re-enter the identical trade. Not a new signal.`;
    case "sentiment":
      return `${sym}: ${e.summary} — sentiment shifted; it nudges conviction, it doesn't force a trade.`;
    case "liquidity":
      return `${sym}: ${e.summary} — thin books only dampen size/confidence, they never block on their own.`;
    case "wall":
      return `${sym}: ${e.summary} — how price is reacting at a key OI wall.`;
    case "watchdog":
      return `⚠ Heads up — ${e.summary}. This is a self-check flag, worth a glance at the Decision Log.`;
    case "health":
      return e.eventType === "DATA_HEALTH_DEGRADE"
        ? `${sym}: data note — the OI feed is degraded (rate-limited / last-good chain). Reads may lag; treat the board as slightly behind until it clears.`
        : `${sym}: OI feed back to normal — reads are live again.`;
    default:
      return null;
  }
}

// ---- optional Claude narrator (only when ANTHROPIC_API_KEY is set) ----
const SYSTEM_PROMPT = [
  "You narrate a trading cockpit's state changes for one user, in plain English.",
  "Rules you must never break:",
  "- Output ONE or at most TWO short sentences. No paragraphs, no lists.",
  "- Explain what happened and why, in plain language. Do NOT repeat jargon the cockpit already shows.",
  "- Use ONLY facts present in the provided event/context. NEVER invent numbers, strikes, prices, or scores.",
  "- You are informational, not authoritative. NEVER tell the user to act, override, or ignore a WAIT / CONFLICT / veto.",
  "- No hedging disclaimers (no 'not financial advice' boilerplate) — just the explanation.",
].join("\n");

async function claudeNarration(e: LogEntry, ctx: Record<string, any>): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const userPrompt = `Event: ${e.channel}/${e.eventType} (severity ${e.severity})\n` +
      `Summary: ${e.summary}\n` +
      `Payload: ${JSON.stringify(e.payload)}\n` +
      `Context (most recent related states): ${JSON.stringify(ctx)}\n` +
      `Write the narration now.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 120, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt }] }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const text = j?.content?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null; // timeout / network / parse — fail silently
  } finally {
    clearTimeout(timer);
  }
}

// mode: 'llm' when a key is configured (per spec: LLM per event, silent on fail),
// else 'template' (works offline; the layer stays demonstrable without a key).
function narratorMode(): "llm" | "template" {
  if (process.env.NARRATION_MODE === "template") return "template";
  return process.env.ANTHROPIC_API_KEY ? "llm" : "template";
}

/** Produce narration text for one entry (exported for testing). */
export async function produceNarration(e: LogEntry): Promise<string | null> {
  if (narratorMode() === "llm") {
    // LLM path: one call; on failure the spec says stay silent (no narration).
    return await claudeNarration(e, buildContext(e));
  }
  return templateNarration(e);
}

// ---- the subscriber: the only wiring into the live pipeline ----
let started = false;
export function initNarrationAgent(): void {
  if (started) return;
  started = true;
  centralLog.onWrite((entry) => {
    // Never narrate our own output (no loop); only qualifying events; market hours only.
    if (entry.channel === "agent-narration") return;
    if (!isNarratable(entry)) return;
    if (!marketHoursIST(entry.ts)) return;
    // Fire-and-forget: narration must never block or delay the write/pipeline.
    void (async () => {
      try {
        const text = await produceNarration(entry);
        if (!text) return; // silent on empty / LLM failure
        centralLog.write({
          channel: "agent-narration", symbol: entry.symbol, mode: entry.mode,
          eventType: "NARRATION", severity: "info", summary: text,
          payload: { sourceId: entry.id, sourceChannel: entry.channel, sourceEvent: entry.eventType, mode: narratorMode() },
        });
      } catch { /* convenience layer — never throw into the pipeline */ }
    })();
  });
}
