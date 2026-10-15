import { test } from "node:test";
import assert from "node:assert/strict";
import { produceNarration } from "./narrationAgent";

const entry: any = { id: "t1", ts: Date.now(), channel: "arbitration", eventType: "ARBITER_WAIT", severity: "info", symbol: "^NSEI", mode: "live", summary: "Arbiter says WAIT", payload: {} };

test("narration works with no Claude key (template) and when Claude is unreachable (falls back to template)", async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const offline = await produceNarration(entry);
    assert.ok(offline && offline.length > 5, "template narration produced");
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 });
    assert.equal(await produceNarration(entry), offline);
    (globalThis as any).fetch = async () => { throw new Error("network down"); };
    assert.equal(await produceNarration(entry), offline);
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    (globalThis as any).fetch = saved.fetch;
  }
});
