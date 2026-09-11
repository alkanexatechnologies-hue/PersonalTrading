# F&O Strategy Modes - ORB Breakout & Option Selling

Two algo-strategy features built on top of the live Groww feed. Both are
decision-support + paper simulation only - no real orders are ever placed.

Source: `src/orb/orb.ts`, `src/options/sellStrategies.ts`,
`src/paper/sellEngine.ts`, wired in `src/routes/api.ts`.

---

## 1. Opening Range Breakout (ORB)

### What it does
Marks the **high/low of the opening range** (the first N minutes from 09:15 IST,
default 30 = the first two 15-minute candles), then signals a break of that
range and suggests the option to buy:

- Price breaks **above** the range high -> **Long** -> buy **CE**.
- Price breaks **below** the range low -> **Short** -> buy **PE**.
- Inside the range -> no trade yet.
- Range still forming (not enough bars) -> wait.

### How each signal is built (`computeORB`)
- **Opening range:** high/low of the first `orMinutes/15` bars of today's session.
- **Breakout:** current price beyond the range edge by a small buffer (2% of the
  range width) so a mere touch doesn't fire.
- **Volume confirmation:** breakout-bar volume vs the day's average bar volume.
  Indices have no volume on the feed, so this is shown as *n/a* (neutral).
- **Plan:** entry at current price; **stop at the other end of the range**;
  target 1 = one range-width beyond the break; target 2 = two range-widths;
  reward:risk computed to target 1.
- **Confidence (0-100):** breakout strength (how far beyond the range) + volume
  confirmation + a sane range width (0.3-2.5%) + a decent R:R.

### Endpoint & tab
- `GET /api/orb?minutes=30` - scans NIFTY, BANK NIFTY (+ up to 12 liquid F&O
  stocks); cached 60s; breakouts ranked first by confidence.
- **ORB Breakout** tab: range selector (15/30/45m), breakouts-only filter, live
  status; auto-refreshes on view.

### Honest notes
ORB breakouts **fail often** (false breaks, especially in choppy/range days).
The stop at the opposite end of the range is essential. Late in the session the
range is far away, so R:R degrades - the table shows this honestly.

---

## 2. Option Selling (premium / theta)

### What it does
From the **live Groww option chain**, builds the three common Indian index
premium-selling structures on NIFTY / BANK NIFTY / FIN NIFTY / MIDCAP NIFTY, and
can paper-trade them:

- **Short Straddle** - sell ATM CE + ATM PE. Max credit, narrowest safety.
- **Short Strangle** - sell ~0.2-delta OTM CE + PE. Wider safety, less credit.
- **Iron Condor** - short strangle + protective wings (defined risk).

### Metrics per structure (`buildSellStrategies`)
- **Net credit** (per share and per lot), **max profit** (= credit), **max loss**
  (condor: defined = wing width - credit; naked: undefined -> rely on the stop).
- **Breakevens** (short strike +/- credit).
- **Probability of profit (POP)** estimate = `1 - (|short-call delta| +
  |short-put delta|)` (delta ~ prob ITM).
- **Rough margin** (naked ~12% of notional; condor ~ max loss).
- **Net delta / net theta-per-day** (theta = the decay you collect, in your
  favour).
- **Management levels:** profit target ~50% of credit, tail stop ~2x credit loss,
  and an adjust/exit note (short-strike breach).

Strikes are chosen by **value** (shorts ~1.2% OTM, wings 3 steps beyond), with
the strike step inferred from the chain - robust to non-uniform spacing. The
chain window was widened to +/-12 strikes so strangles and condor wings fit.

### Paper simulator (`src/paper/sellEngine.ts`)
- **Open** a chosen structure (`/api/option-sell/start?symbol=&type=&capital=`).
- **Mark** live (`/api/option-sell/mark`, polled ~3s on the tab): recomputes the
  cost-to-close from the current chain; P&L = (credit received - cost to close) x
  lot. Missing far strikes fall back to intrinsic value.
- **Exits:** profit target (>= 50% of credit), **tail stop** (loss >= 2x credit),
  **adjust** (a short strike is breached -> defensive exit in this paper model,
  not full rolling), or **EOD** (not held overnight).
- Costs: brokerage per leg + STT + exchange + GST + slippage (`sellFriction`).
- Persists to `data/paper-sell-state.json` and `data/paper-sell-trades.csv`.

### Endpoints & tab
- `GET /api/option-sell` - recommended structures for the indices.
- `GET /api/option-sell/start | mark | state | stop | reset`.
- **Option Selling** tab: structure cards (legs, credit, breakevens, max P/L,
  POP, margin, delta/theta, target/stop) with a "Paper trade this" button, plus a
  live paper panel (running P&L, closed trades, stop/reset).

### Honest notes
- Selling options is **HIGH RISK**: naked straddle/strangle have **undefined
  loss** - a gap can far exceed the credit. Always use the tail stop.
- POP, margin and credit are **estimates** from the chain, not broker-exact.
- The iron condor is **defined-risk** and the safest of the three.
- "Adjustment" here is a **defensive exit**, not the full rolling/hedging a live
  trader might do - kept honest rather than pretending to model complex rolls.
- Requires the **live Groww** feed (option greeks/OI). Groww is the only market-data source.

---

## 3. Where these fit
- **ORB** and the buy-side paper engine suit **trending** conditions (the
  trade-zone pill / ADX regime tells you when).
- **Option selling** suits **range-bound / high-IV** conditions where the buy
  side bleeds theta - the two are complementary. Running the sell paper alongside
  the buy paper lets you compare which side is working in the current regime.
