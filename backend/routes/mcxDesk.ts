// ============================ MCX DESK API — /api/gold/* and /api/crude/* (MCX futures + options on futures) ============================
// One router per desk family (Gold: GOLDM / GOLD · Crude Oil: CRUDEOILM / CRUDEOIL), mounted inside the main API router
// AFTER its auth and Data Control gates (screen keys "goldcommand" / "crudecommand"), so each desk is logged-in only and can
// be switched off on its own in Data Control. Read-only, advisory: no tested MCX rule exists, the signal is WAIT.
// Isolation from the Indian market screens is enforced in mcx/mcxFeed.ts (low priority, one shared throttle, breaker, cache).
import { Router, Request, Response } from "express";
import { mcxContracts, optionExpiries, underlyingFuture, frontFuture, strikesFor, atmStrike, optionAt, mcxSession, mcxLevels, levelPlan, expiryInfo, MCX_SPEC, FAMILY_UNDS, McxFamily, McxUnd } from "../mcx/mcxEngine";
import { mcxBars, refQuote, deskEnabled, mcxBreaker } from "../mcx/mcxFeed";
import { premiumStructure } from "../premium/premiumStructure";

const istToday = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const tfOf = (q: unknown): 5 | 15 | 60 => (q === "15" ? 15 : q === "60" ? 60 : 5);
const DESK_NAME: Record<McxFamily, string> = { GOLD: "Gold", CRUDE: "Crude Oil" };

export function mcxDeskRouter(family: McxFamily): Router {
  const router = Router(), unds = FAMILY_UNDS[family], name = DESK_NAME[family];
  const undOf = (q: unknown): McxUnd => (unds.includes(q as McxUnd) ? (q as McxUnd) : unds[0]);   // the mini contract by default

  router.use((_req: Request, res: Response, next) => {
    if (!deskEnabled(family)) return res.status(503).json({ available: false, disabled: true, error: `${name} desk is switched off (${family === "GOLD" ? "GOLD_DESK" : "CRUDE_DESK"}=off)` });
    next();
  });

  /** Futures chart + levels + plan + option-chain metadata + the global reference, for one underlying. */
  router.get("/command", async (req: Request, res: Response) => {
    const und = undOf(req.query.und), spec = MCX_SPEC[und], tf = tfOf(req.query.tf), today = istToday(), rows = mcxContracts();
    try {
      const exps = optionExpiries(rows, und, today), expiry = exps.includes(String(req.query.expiry)) ? String(req.query.expiry) : exps[0] ?? null;
      const fut = frontFuture(rows, und, today); if (!fut) return res.json({ available: false, und, error: `No ${und} futures in the Dhan scrip master` });
      const [fb, lb, rq] = await Promise.all([
        mcxBars(fut.securityId, "FUTCOM", tf, 7),
        tf === 5 ? Promise.resolve(null) : mcxBars(fut.securityId, "FUTCOM", 5, 7),     // levels always from 5-min bars
        refQuote(family).catch(() => null),
      ]);
      const bars = fb.v, b5 = lb ? lb.v : bars, nowSec = Math.floor(Date.now() / 1000), L = mcxLevels(b5, nowSec, spec), last = bars.length ? bars[bars.length - 1] : null;
      const strikes = expiry ? strikesFor(rows, und, expiry) : [], atm = last ? atmStrike(strikes, last.close) : null;
      const step = strikes.length > 1 ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0)) : 0;
      const near = atm != null ? strikes.filter((s) => Math.abs(s - atm) <= 10 * step) : [];
      const days = [...new Set(b5.map((b) => istDay(b.time)))].sort(), prev = b5.filter((b) => istDay(b.time) === days[days.length - 2]), prevOi = prev.length ? prev[prev.length - 1].oi ?? null : null;
      res.json({
        available: true, family, und, unds, spec, tf, session: mcxSession(Date.now(), family), breaker: mcxBreaker(),
        fut: { securityId: fut.securityId, name: fut.name, expiry: fut.expiry, bars, last: last?.close ?? null, lastTime: last?.time ?? null, oi: last?.oi ?? null, prevOi,
          prevClose: L.pdc, chg: last && L.pdc ? Math.round((last.close - L.pdc) * 100) / 100 : null, chgPct: last && L.pdc ? Math.round(((last.close - L.pdc) / L.pdc) * 10000) / 100 : null,
          stale: fb.stale, fetchedAt: fb.at },
        levels: L.levels, sessionDay: L.sessionDay, prevDay: L.prevDay, vwap: L.vwap, plan: levelPlan(L.levels, last?.close ?? null),
        options: { expiries: exps, expiry, settlesInto: expiry ? underlyingFuture(rows, und, expiry)?.name ?? null : null, strikes: near, atm, step, expiryInfo: expiry ? expiryInfo(expiry, Date.now()) : null },
        ref: rq ? { ...rq.v, stale: rq.stale } : null,
        signal: { action: "WAIT", reason: `No tested ${name.toLowerCase()} rule yet — levels and plan are information only.` },
      });
    } catch (e: any) { res.json({ available: false, und, error: e?.message || `${name} data unavailable`, breaker: mcxBreaker() }); }
  });

  /** CE + PE premium bars (with OI) and premium support / resistance for one strike / expiry. */
  router.get("/option", async (req: Request, res: Response) => {
    const und = undOf(req.query.und), tf = tfOf(req.query.tf), expiry = String(req.query.expiry || ""), strike = Number(req.query.strike), rows = mcxContracts();
    if (!expiry || !Number.isFinite(strike)) return res.status(400).json({ error: "expiry and strike required" });
    try {
      const out: any = { available: true, und, expiry, strike, tf, mult: MCX_SPEC[und].mult };
      for (const side of ["CE", "PE"] as const) {
        const o = optionAt(rows, und, expiry, strike, side);
        if (!o) { out[side] = { available: false, error: `${und} ${strike} ${side} ${expiry} not listed` }; continue; }
        const b0 = await mcxBars(o.securityId, "OPTFUT", tf, 5, 30_000);
        // the last 2 sessions only: older bars of a strike that was deep in / out of the money then are thin and distort the chart
        const ds = [...new Set(b0.v.map((x) => istDay(x.time)))].sort().slice(-2), v = b0.v.filter((x) => ds.includes(istDay(x.time)));
        const last = v.length ? v[v.length - 1] : null;
        // premium support / resistance: the same structure engine as Market Command's option terminal, on this premium
        const st = v.length >= 10 ? premiumStructure(v as any) : { available: false, reason: "not enough premium candles" };
        out[side] = { available: v.length > 0, name: o.name, securityId: o.securityId, bars: v, last: last?.close ?? null, oi: last?.oi ?? null, costPerLot: last ? Math.round(last.close * MCX_SPEC[und].mult) : null, stale: b0.stale, st };
      }
      res.json(out);
    } catch (e: any) { res.json({ available: false, error: e?.message || `${name} option data unavailable`, breaker: mcxBreaker() }); }
  });

  return router;
}
