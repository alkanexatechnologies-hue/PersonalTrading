// ============================ GOLD DESK API — /api/gold/* (MCX GOLDM / GOLD futures + options) ============================
// Mounted inside the main API router AFTER its auth and Data Control gates (screen key "goldcommand"), so it is logged-in
// only and can be switched off in Data Control. Read-only, advisory: no tested gold rule exists, the signal is WAIT.
// Isolation from the Indian market screens is enforced in gold/goldFeed.ts (low priority, own throttle, breaker, cache).
import { Router, Request, Response } from "express";
import { goldContracts, optionExpiries, underlyingFuture, frontFuture, strikesFor, atmStrike, optionAt, goldSession, goldLevels, levelPlan, expiryInfo, GOLD_SPEC, GoldUnd } from "../gold/goldEngine";
import { goldBars, comexGold, goldEnabled, goldBreaker } from "../gold/goldFeed";

const router = Router();
const istToday = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const tfOf = (q: unknown): 5 | 15 | 60 => (q === "15" ? 15 : q === "60" ? 60 : 5);
const undOf = (q: unknown): GoldUnd => (q === "GOLD" ? "GOLD" : "GOLDM");

router.use((_req: Request, res: Response, next) => {
  if (!goldEnabled()) return res.status(503).json({ available: false, disabled: true, error: "Gold desk is switched off (GOLD_DESK=off)" });
  next();
});

/** Futures chart + levels + plan + option-chain metadata + COMEX, for one underlying. */
router.get("/command", async (req: Request, res: Response) => {
  const und = undOf(req.query.und), tf = tfOf(req.query.tf), today = istToday(), rows = goldContracts();
  try {
    const exps = optionExpiries(rows, und, today), expiry = exps.includes(String(req.query.expiry)) ? String(req.query.expiry) : exps[0] ?? null;
    const fut = frontFuture(rows, und, today); if (!fut) return res.json({ available: false, und, error: `No ${und} futures in the Dhan scrip master` });
    const [fb, lb, cx] = await Promise.all([
      goldBars(fut.securityId, "FUTCOM", tf, 7),
      tf === 5 ? Promise.resolve(null) : goldBars(fut.securityId, "FUTCOM", 5, 7),     // levels always from 5-min bars
      comexGold().catch(() => null),
    ]);
    const bars = fb.v, b5 = lb ? lb.v : bars, nowSec = Math.floor(Date.now() / 1000), L = goldLevels(b5, nowSec), last = bars.length ? bars[bars.length - 1] : null;
    const strikes = expiry ? strikesFor(rows, und, expiry) : [], atm = last ? atmStrike(strikes, last.close) : null;
    const near = atm != null ? strikes.filter((s) => Math.abs(s - atm) <= 10 * GOLD_SPEC[und].step) : [];
    const prevOi = (() => { const d = [...new Set(b5.map((b) => new Date((b.time + 19800) * 1000).toISOString().slice(0, 10)))].sort(); const pd = d[d.length - 2]; const p = b5.filter((b) => new Date((b.time + 19800) * 1000).toISOString().slice(0, 10) === pd); return p.length ? p[p.length - 1].oi ?? null : null; })();
    res.json({
      available: true, und, spec: GOLD_SPEC[und], tf, session: goldSession(Date.now()), breaker: goldBreaker(),
      fut: { securityId: fut.securityId, name: fut.name, expiry: fut.expiry, bars, last: last?.close ?? null, lastTime: last?.time ?? null, oi: last?.oi ?? null, prevOi,
        prevClose: L.pdc, chg: last && L.pdc ? Math.round((last.close - L.pdc) * 100) / 100 : null, chgPct: last && L.pdc ? Math.round(((last.close - L.pdc) / L.pdc) * 10000) / 100 : null,
        stale: fb.stale, fetchedAt: fb.at },
      levels: L.levels, sessionDay: L.sessionDay, prevDay: L.prevDay, vwap: L.vwap, plan: levelPlan(L.levels, last?.close ?? null),
      options: { expiries: exps, expiry, settlesInto: expiry ? underlyingFuture(rows, und, expiry)?.name ?? null : null, strikes: near, atm, step: GOLD_SPEC[und].step, expiryInfo: expiry ? expiryInfo(expiry, Date.now()) : null },
      comex: cx ? { ...cx.v, stale: cx.stale } : null,
      signal: { action: "WAIT", reason: "No tested gold rule yet — levels and plan are information only." },
    });
  } catch (e: any) { res.json({ available: false, und, error: e?.message || "gold data unavailable", breaker: goldBreaker() }); }
});

/** CE + PE premium bars (with OI) for one strike / expiry. */
router.get("/option", async (req: Request, res: Response) => {
  const und = undOf(req.query.und), tf = tfOf(req.query.tf), expiry = String(req.query.expiry || ""), strike = Number(req.query.strike), rows = goldContracts();
  if (!expiry || !Number.isFinite(strike)) return res.status(400).json({ error: "expiry and strike required" });
  try {
    const out: any = { available: true, und, expiry, strike, tf, mult: GOLD_SPEC[und].mult };
    for (const side of ["CE", "PE"] as const) {
      const o = optionAt(rows, und, expiry, strike, side);
      if (!o) { out[side] = { available: false, error: `${und} ${strike} ${side} ${expiry} not listed` }; continue; }
      const b = await goldBars(o.securityId, "OPTFUT", tf, 5, 30_000);
      const last = b.v.length ? b.v[b.v.length - 1] : null;
      out[side] = { available: b.v.length > 0, name: o.name, securityId: o.securityId, bars: b.v, last: last?.close ?? null, oi: last?.oi ?? null, costPerLot: last ? Math.round(last.close * GOLD_SPEC[und].mult) : null, stale: b.stale };
    }
    res.json(out);
  } catch (e: any) { res.json({ available: false, error: e?.message || "gold option data unavailable", breaker: goldBreaker() }); }
});

export default router;
