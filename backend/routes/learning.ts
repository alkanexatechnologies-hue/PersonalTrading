// ============================ LEARNING API — /api/learning/* (Market Command → 🎓 Learning tab) ============================
// The trader writes a past trade in their own words; the server reads it, replays it on that day's real Dhan 1-minute data
// and explains it (learning/learningEngine). Saved trades are kept per date (data/learning-trades.json).
// Mounted inside the main API router AFTER its auth and Data Control gates (screen key "learning"). Today's session opens
// only after 15:31 IST (the full day is needed, and the live screens keep the Dhan budget during the market). Advisory only.
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dataFile } from "../config/dataDir";
import { parseTrade, resolveShortStrike, LearnIndex } from "../learning/parseTrade";
import { analyzeTrade, tOf, LearnTrade } from "../learning/learningEngine";
import { indexDay, bandDay, listedLeg, dayComplete, istDay, LEARN_META, learningSource } from "../learning/learningFeed";

const FILE = dataFile("learning-trades.json");
interface Saved { id: string; createdAt: number; text: string; trade: LearnTrade }
function load(): Saved[] { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } }
function save(v: Saved[]) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(v, null, 1)); }
const nowSec = () => Math.floor(Date.now() / 1000);
/** Weekly expiry weekday (NIFTY Tuesday, SENSEX Thursday); a holiday-shifted expiry is shown as not-expiry. */
const isExpiryDay = (index: LearnIndex, day: string, listed: string[]) => listed.includes(day) || new Date(day + "T00:00:00Z").getUTCDay() === (index === "NIFTY" ? 2 : 4);

export function learningRouter(expiriesFor: (index: LearnIndex) => Promise<string[]>): Router {
  const router = Router(), memo = new Map<string, any>();

  /** Read + check a trade. Returns the parsed fields and, when complete, the normalised trade. */
  function readTrade(body: any) {
    const today = istDay(nowSec()), p = parseTrade(String(body?.text || ""), today, { index: body?.index, date: body?.date });
    const err = p.unsupported || (p.missing.length ? `Please add: ${p.missing.join(", ")}.` : null)
      || (p.date! > today ? "That date is in the future." : null)
      || (p.time! < "09:15" || p.time! > "15:29" ? "The time must be between 09:15 and 15:29." : null)
      || (p.sl != null && p.sl >= p.price! ? "The SL must be below the buy price (you are buying the option)." : null)
      || (p.targets.some((t) => t <= p.price!) ? "Targets must be above the buy price." : null);
    return { parsed: p, err };
  }

  router.post("/parse", (req: Request, res: Response) => { const { parsed, err } = readTrade(req.body); res.json({ parsed, error: err }); });

  router.post("/analyze", async (req: Request, res: Response) => {
    const { parsed: p, err } = readTrade(req.body);
    if (err) return res.json({ available: false, parsed: p, error: err });
    const index = p.index as LearnIndex, day = p.date!, meta = LEARN_META[index];
    if (!dayComplete(day)) return res.json({ available: false, locked: true, parsed: p, error: "Today's trades open after 3:30 PM, because the full day's data is needed. Past dates work any time." });
    try {
      const { bars: idx, prev } = await indexDay(index, day);
      if (!idx.length) return res.json({ available: false, parsed: p, error: `No ${index} data on ${day}. It was a holiday or not a trading day.` });
      const t0 = tOf(day, p.time!), spot = (idx.find((b) => b.t >= t0) || idx[idx.length - 1]).c;
      const strike = p.strikeShort ? resolveShortStrike(p.strike!, spot, meta.step) : p.strike!;
      if (strike % meta.step !== 0) return res.json({ available: false, parsed: p, error: `${strike} is not a ${index} strike (steps of ${meta.step}).` });
      const trade: LearnTrade = { index, date: day, strike, side: p.side!, how: p.how || "at", price: p.price!, sl: p.sl, targets: p.targets, time: p.time!, note: String(req.body?.note || "").slice(0, 200) || undefined };
      const key = JSON.stringify(trade); if (memo.has(key)) return res.json(memo.get(key));
      const band = await bandDay(index, day), expiries = await expiriesFor(index).catch(() => [] as string[]);
      let opt = band.find((l) => l.strike === strike && l.side === trade.side)?.bars || [], note = "";
      if (!opt.some((b) => Math.abs(b.t - t0) <= 300)) {   // outside the recorded ATM±3 band → the listed contract, if not expired
        const listed = await listedLeg(index, day, strike, trade.side, expiries.find((e) => e >= day) ?? null).catch(() => []);
        if (listed.length) { opt = listed; note = `${strike} ${trade.side} was outside the recorded ATM±3 band, so the listed contract's own data is used.`; }
      }
      if (!opt.length) return res.json({ available: false, parsed: p, error: `No premium data for ${strike} ${trade.side} on ${day}. Only strikes within ATM±3 are recorded for expired contracts. Try a strike nearer the money.` });
      // the written price must match the option: "above 200" on a premium of 2,073 means a wrong strike / CE-PE / price
      const live = (opt.filter((b) => b.t <= t0).pop() || opt.find((b) => b.t >= t0))!.c, gap = Math.abs(live - trade.price);
      if (gap > 5 && (trade.how === "above" ? live > trade.price * 1.35 : gap > trade.price * 0.35))
        return res.json({ available: false, parsed: p, error: `At ${trade.time} the ${index} ${strike} ${trade.side} premium was ${Math.round(live * 10) / 10}, far from your ${trade.price}. Please check the strike, CE/PE, the price or the time.` });
      const out: any = analyzeTrade({ trade, idx, prev, opt, band, lot: meta.lot, step: meta.step, expiryDay: isExpiryDay(index, day, expiries), source: learningSource(index) });
      if (note) out.dataNotes.unshift(note);
      if (p.strikeShort) out.dataNotes.unshift(`"${p.strike}" was read as ${strike} (nearest to ${index} ${Math.round(spot)} at ${p.time}).`);
      const r = { available: true, parsed: p, ...out }; memo.set(key, r); if (memo.size > 60) memo.delete(memo.keys().next().value!);
      res.json(r);
    } catch (e: any) { res.status(502).json({ available: false, parsed: p, error: e?.message || "Learning analysis failed" }); }
  });

  router.get("/trades", (req: Request, res: Response) => {
    const date = String(req.query.date || ""), all = load();
    const days = [...new Set(all.map((s) => s.trade.date))].sort().reverse();
    res.json({ trades: all.filter((s) => !date || s.trade.date === date).sort((a, b) => a.trade.time.localeCompare(b.trade.time)), days });
  });
  router.post("/trades", (req: Request, res: Response) => {
    const { parsed: p, err } = readTrade(req.body); if (err) return res.status(400).json({ error: err });
    const all = load(), trade: LearnTrade = { index: p.index as LearnIndex, date: p.date!, strike: p.strike!, side: p.side!, how: p.how || "at", price: p.price!, sl: p.sl, targets: p.targets, time: p.time!, note: String(req.body?.note || "").slice(0, 200) || undefined };
    const dup = all.find((s) => JSON.stringify({ ...s.trade, note: undefined }) === JSON.stringify({ ...trade, note: undefined }));
    if (dup) return res.json({ saved: dup, duplicate: true });
    const s: Saved = { id: crypto.randomBytes(6).toString("hex"), createdAt: nowSec(), text: String(req.body?.text || "").slice(0, 400), trade };
    all.push(s); if (all.length > 2000) all.shift(); save(all); res.json({ saved: s });
  });
  router.delete("/trades/:id", (req: Request, res: Response) => {
    const all = load(), n = all.length, left = all.filter((s) => s.id !== req.params.id); if (left.length === n) return res.status(404).json({ error: "not found" });
    save(left); res.json({ ok: true });
  });
  return router;
}
