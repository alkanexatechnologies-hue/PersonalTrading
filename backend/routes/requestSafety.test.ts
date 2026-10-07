import { test } from "node:test";
import assert from "node:assert/strict";
import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import { installAsyncSafety, apiDeadline } from "./requestSafety";

async function withServer(router: Router, fn: (base: string) => Promise<void>) {
  const app = express(); app.use("/api", router);
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`); }
  finally { srv.close(); }
}

test("a rejected async handler still answers (500 JSON) instead of hanging", async () => {
  const r = Router(); installAsyncSafety(r);
  r.get("/boom", async () => { throw new Error("scan timed out (18000ms)"); });
  await withServer(r, async (base) => {
    const res = await fetch(`${base}/boom`, { signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /timed out/);
  });
});

test("normal handlers and middleware chains are unaffected", async () => {
  const r = Router(); installAsyncSafety(r);
  const mw = (_q: any, res: any, next: any) => { res.setHeader("x-mw", "1"); next(); };
  r.get("/ok", mw, async (_q, res) => { res.json({ ok: true }); });
  await withServer(r, async (base) => {
    const res = await fetch(`${base}/ok`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mw"), "1");
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("a GET slower than the deadline gets a 504; its late reply is dropped safely", async () => {
  const r = Router(); installAsyncSafety(r);
  r.use(apiDeadline(150, /^\/backtest/));
  let lateReplyThrew = false;
  r.get("/slow", async (_q, res) => { await new Promise((x) => setTimeout(x, 400)); try { res.json({ late: true }); } catch { lateReplyThrew = true; } });
  r.get("/backtest", async (_q, res) => { await new Promise((x) => setTimeout(x, 300)); res.json({ done: true }); });
  await withServer(r, async (base) => {
    const res = await fetch(`${base}/slow`);
    assert.equal(res.status, 504);
    assert.equal((await res.json()).timedOut, true);
    const bt = await fetch(`${base}/backtest`);
    assert.equal(bt.status, 200, "long-running research routes are exempt");
    await new Promise((x) => setTimeout(x, 350));
    assert.equal(lateReplyThrew, false);
  });
});
