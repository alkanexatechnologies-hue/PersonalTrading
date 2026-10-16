import { test } from "node:test";
import assert from "node:assert/strict";
import { stampMessage } from "./notificationService";

test("every Telegram message carries the IST date + time at the top and the bottom", () => {
  const at = Date.UTC(2026, 9, 16, 4, 0);   // 09:30 IST, Fri 16 Oct 2026
  const m = stampMessage("<b>NIFTY</b> plan\nline 2\n", at);
  const lines = m.split("\n");
  assert.equal(lines[0], "🕒 Fri 16 Oct 2026 · 09:30 IST");
  assert.equal(lines[lines.length - 1], "🕒 Fri 16 Oct 2026 · 09:30 IST");
  assert.equal(lines[1], "<b>NIFTY</b> plan"); assert.equal(lines.length, 4);
});
