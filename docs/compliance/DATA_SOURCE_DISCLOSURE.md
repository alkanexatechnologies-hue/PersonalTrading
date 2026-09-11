# Market-Data Source Disclosure

## Single source

This application has exactly **one** market-data source:

> MARKET DATA SOURCE
> 🟢 GROWW

There is no Yahoo, no TrueData, and no fallback provider. All quotes, candles, historical
data, option chain and OI come from Groww. `BrokerProvider` is reserved for future order
execution and is never used as a market-data source.

## Data-health states

The Groww Connection panel and the trading screen display one of:

| State | Meaning |
|-------|---------|
| 🟢 GREEN — CONNECTED, DATA: LIVE | Connected, market open, data fresh (age ≤ 30s). |
| 🟡 YELLOW — CONNECTED, DATA: DELAYED | Connected but data stale/delayed. |
| 🟡 CLOSED — CONNECTED, MARKET CLOSED | Market closed; historical only, no live signals. |
| 🔴 RED — DISCONNECTED | Token present but feed off / no valid data. |
| ⚪ GREY — NOT CONFIGURED | No Groww token configured. |

Health telemetry shown (real values, not demo): last update, data age, API latency,
updates, failures, reconnects. Source: `getGrowwHealth()` in `backend/routes/api.ts`;
status via `computeGrowwStatus()`.

## Stale / disconnected data blocks live signals

When Groww data is disconnected, stale, invalid or unavailable, the trading screen shows:

> 🔴 TRADING SIGNAL BLOCKED
> Reason: Groww market data is unavailable or stale.

Live trading signals are gated by `growwSignalsAllowed()` / `computeGrowwStatus()`: live
signals are permitted **only** when Groww is connected, the market is open, and data is
fresh (GREEN). This prevents live signals from being generated on stale data.

When the connection is restored and valid fresh market data is received:

> 🟢 GROWW CONNECTED — LIVE SIGNALS ENABLED

Authentication success alone does **not** enable signals; valid fresh market data must
also be received.

## After market hours

- Charts/analysis use Groww historical candles.
- The live feed shows MARKET CLOSED / NO LIVE DATA.
- No live trading signals are generated while the market is closed.

## Requires confirmation

- Data licensing/redistribution terms for your Groww API usage — **REQUIRES BROKER CONFIRMATION**.
