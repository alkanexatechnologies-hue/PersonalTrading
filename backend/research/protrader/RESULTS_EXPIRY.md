# ProTrader expiry-day study (run 2026-10-18)

**Question:** can an option BUYER trade the index's own expiry day profitably, instead of skipping it?

**Data:** real Dhan 1-minute premiums (rolling-option ATM±3), ~2 years.
- Expiry days are read from the data: 98 per index.
- Earlier ⅔ of expiry days = development; later ⅓ = validation.
- Costs as in backtest #1.
- Script: `expiryDay.ts`.

**Expiry management:** on the PREMIUM, not the index.
- Premium stop.
- Book half at a premium multiple, then move the stop to the entry premium.
- Rest out at 2.5×.
- 40-minute time stop if the first booking is not reached.
- Out by 15:15.

## Round 1: the strategy families

Average per trade, NIFTY / SENSEX:

| Version | Development | Validation |
|---|---|---|
| **X0: current plan logic on expiry day** | **−23.6% / −9.5%** (wins 23% / 36%) | **−11.0% / −15.4%** |
| X1: plan + retest, normal exits | −11.4% / −16.6% | −19.4% / −6.3% |
| X2: plan + retest, expiry management | −16.4% / −12.6% | −7.6% / −3.6% |
| X3: opening-range break | +3.0% / −13.3% | −3.8% / −1.6% |
| X4: EMA20 trend pullback | −5.7% / −5.5% | −4.8% / −1.0% |
| X5: afternoon day high/low break | 0.0% / −12.4% | −0.4% / −7.0% |

## Round 2: tuning grid (24 versions)

**The grid:**
- entries: X2, X4, X5
- strike: at the money / one strike in the money
- premium stop: −30% / −40%
- first booking: 1.5× / 1.3×

**Rule fixed before looking at validation:** pick the best development average per trade, both indices weighted equally,
with ≥ 20 trades per index.

**Picked: afternoon break, in the money, stop −30%, half at 1.3×.**

| | NIFTY | SENSEX |
|---|---|---|
| Development | 62% win, +6.5% | 45% win, −4.3% |
| **Validation** | **30% win, −7.2%** | **44% win, −6.2%** |

**FAILED validation:** overfit on 26 trades.

**Most consistent family (a second look, not the pre-chosen pick): EMA20 pullback, in the money.** Development wins
43–51%, averages −1.4% to −3.1%. Validation −4.2% to −8.5%.

## Verdict

**NO expiry-day buyer strategy is validated as profitable after costs.**

- **What expiry management does achieve:** it cuts the loss and raises the win rate compared with today's logic on expiry
  day.
  - Win rate: NIFTY development 23% → 43–48%.
  - Loss per trade: −10% to −24% → about −1% to −8%.
- **What it does not achieve:** it does not beat skipping the expiry day (0).
- **Every variant was worse in validation than in development:** recent expiry days have been harder for buyers.

**ProTrader position:** keep the expiry-day skip for live trades. If the owner wants expiry trading, run the most
consistent method (EMA20 pullback, one strike in the money, premium stop, half at 1.3×–1.5×, 40-min time stop) as a
labelled paper / minimum-size forward test. Promote it only if 6–8 forward expiries are positive.
