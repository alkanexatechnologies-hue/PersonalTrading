// ============================ API request safety net ============================
// Two guarantees for every /api request, so a slow or failing handler can never
// leave a browser request open forever:
//
// 1. installAsyncSafety(router): Express 4 does NOT catch a rejected promise from
//    an async handler — the request simply never gets a reply. Every route handler
//    registered after this call is wrapped: a rejection is answered with a JSON
//    500 (or ignored if a reply was already sent).
// 2. apiDeadline(ms): a GET poll that has not replied within `ms` is answered with
//    a JSON 504 so the browser frees the connection. The handler keeps running
//    (its result still fills the server caches); its late reply is dropped.
//
// Why it matters: browsers allow only 6 concurrent connections per host. A poll
// that never replies (e.g. /early-moves timing out every minute) occupied one more
// connection each minute; after ~5 minutes every screen's refresh was queued
// behind them and the whole app looked frozen with old data.

import type { Router, Request, Response, NextFunction } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => any;

function wrap(h: any): any {
  if (typeof h !== "function" || h.length === 4) return h;          // error middleware / non-function
  return function safe(req: Request, res: Response, next: NextFunction) {
    try {
      const r = (h as Handler)(req, res, next);
      if (r && typeof r.then === "function") {
        r.then(undefined, (e: any) => {
          console.error(`[api] ${req.method} ${req.originalUrl.split("?")[0]} failed:`, e?.message || e);
          if (!res.headersSent) res.status(500).json({ error: e?.message || "request failed" });
        });
      }
      return r;
    } catch (e) { next(e); }
  };
}

export function installAsyncSafety(router: Router): void {
  for (const m of ["get", "post", "put", "patch", "delete", "all"] as const) {
    const orig = (router as any)[m].bind(router);
    (router as any)[m] = (path: any, ...handlers: any[]) => orig(path, ...handlers.flat().map(wrap));
  }
}

/** Reply 504 to a GET that has not answered within `ms` (long-running research
 *  routes matching `exempt` are left alone). */
export function apiDeadline(ms: number, exempt: RegExp) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || exempt.test(req.path)) return next();
    const t = setTimeout(() => {
      if (res.headersSent) return;
      console.warn(`[api] deadline ${ms}ms hit: ${req.originalUrl.split("?")[0]}`);
      res.status(504).json({ error: `timed out after ${Math.round(ms / 1000)}s — server busy, showing last data`, timedOut: true });
      // Drop the handler's late reply instead of throwing "headers already sent".
      const noop = () => res;
      (res as any).json = noop; (res as any).send = noop; (res as any).end = noop; (res as any).status = () => res;
    }, ms);
    if (typeof (t as any).unref === "function") (t as any).unref();
    const clear = () => clearTimeout(t);
    res.on("finish", clear); res.on("close", clear);
    next();
  };
}
