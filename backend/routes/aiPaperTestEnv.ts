import fs from "fs";
import os from "os";
import path from "path";

// Side-effect module: point DATA_DIR at a fresh per-process temp directory so
// this test file operates on its OWN users.json / credentials, never the shared
// data/*.json that session.test.ts and authMiddleware.test.ts back up and
// restore. The node test runner runs each file in its own process, so setting
// the env here (and importing THIS module before any auth module) means the
// data-dir constant is computed against the isolated path. This removes the
// cross-file race that otherwise made create→edit→re-login flaky under the
// default parallel `npx tsx --test "backend/**/*.test.ts"` run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aip-test-"));
process.env.DATA_DIR = dir;
