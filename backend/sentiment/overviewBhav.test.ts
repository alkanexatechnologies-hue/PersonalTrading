import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBhav } from "./overview";

test("parseBhav reads official close / previous close for EQ rows", () => {
  const csv = "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE\n" +
    "HDFCBANK, EQ, 09-Oct-2026, 692.25, 696.60, 710.15, 695.30, 707.25, 707.25, 704.64\n" +
    "HDFCBANK, BL, 09-Oct-2026, 1, 1, 1, 1, 1, 1, 1\n" +
    "SBIN, EQ, 09-Oct-2026, 940.00, 942.00, 959.90, 938.10, 959.10, 959.10, 953.54\n";
  const m = parseBhav(csv);
  assert.deepEqual(m.get("HDFCBANK"), { close: 707.25, prev: 692.25 });
  assert.deepEqual(m.get("SBIN"), { close: 959.1, prev: 940 });
  assert.equal(m.size, 2);
  assert.equal(parseBhav("<html>blocked</html>").size, 0);
});
