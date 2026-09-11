# Risk Disclosure

## Trading application disclaimer (verbatim)

> This application is a trading and market-analysis software tool. It does not guarantee
> profits or returns. Trading in securities, derivatives and options involves substantial
> risk of loss. Past performance, backtests, simulations or historical results do not
> guarantee future performance. Users are solely responsible for their trading decisions
> and should independently assess the risks before placing any order.

## Prohibited language

The application must never use language such as:

- Guaranteed profit
- Guaranteed return
- 90% accuracy
- Risk-free trading
- Assured income
- Guaranteed multibagger
- Guaranteed option signal

Confidence/probability figures shown in the UI are **calibrated estimates**, are capped,
and are explicitly described as *not* a guaranteed win rate.

## First-use user acknowledgement (verbatim)

Shown once on first use (and again whenever the disclosure version changes):

> TRADING RISK DISCLOSURE
>
> Before using this application, please understand that:
>
> - Trading involves financial risk.
> - Options and derivatives can result in substantial losses.
> - Market data can be delayed, interrupted or incorrect.
> - Technical failures can affect signals and orders.
> - Backtested results do not guarantee future results.
> - No trading strategy can guarantee profits.
> - You are responsible for your trading decisions.
>
> [ ] I have read and understood the above.  [ CONTINUE ]

### What is stored on acknowledgement

Stored locally in the browser (`localStorage`, key `nsa_disclosure_ack`), **no personal
information**:

- `acknowledgedAt` — ISO timestamp of acknowledgement
- `appVersion` — application version at time of acknowledgement
- `disclosureVersion` — disclosure version acknowledged

If `disclosureVersion` changes, the user is re-prompted.

## Per-signal risk warning

Every generated trade signal shows a persistent risk note:

> ⚠️ TRADING RISK — This signal is generated from market-data and predefined rules. It is
> NOT a guarantee of profit or future performance. Market conditions can change rapidly.
> User is responsible for the final trading decision.

This warning is kept accessible on the trading screen; it is not a one-time install prompt.

## Backtest / simulation disclaimer

Any backtest or historical/simulated performance screen shows:

> BACKTEST / SIMULATION — Past performance is not indicative of future results. Backtest
> results may differ materially from actual trading because of slippage, liquidity,
> brokerage, taxes, latency, execution quality, market impact and other factors.

Simulated returns are never presented as actual investor returns, and are never used to
promise future returns.
