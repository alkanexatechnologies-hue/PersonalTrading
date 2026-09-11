# How the System Understands Market Movement - Full Process

This document explains, end to end, how the assistant reads the market and turns
raw price data into a directional call and an option trade. It covers the five
inputs you asked about - **price movement, technical indicators, candles, market
sentiment (OI/futures), and time period (timeframe + expiry/theta)** - and how
they are combined.

Source of truth (code): `src/signals/engine.ts`, `src/signals/score.ts`,
`src/predict/dayOutlook.ts`, `src/data/growwProvider.ts`, `src/routes/api.ts`.

> Everything here is a **model-based, probabilistic** read - not a guaranteed
> forecast. Markets are uncertain; the system quantifies odds, it does not
> promise outcomes.

---

## 1. The pipeline at a glance

```
Live candles (Groww)                 Option chain (Groww)
        |                                    |
        v                                    v
  6 technical indicators            OI / PCR / max-pain / futures buildup
  -> weighted -100..+100 score      -> sentiment bias (Bullish/Bearish)
        |                                    |
        +---------------+--------------------+
                        v
             directionFrom(): weighted vote
             = signal x2 + OI x1.5 + futures x1.5
                        |
                        v
        Direction (Bull/Bear/Neutral) + Confidence
                        |
             + Market alignment (NIFTY/BANKNIFTY correlation)
             + Regime gate (ADX trend vs range)
             + Timeframe & expiry/theta adjustment
                        v
        Best-strike option play + realistic target + safety gates
```

---

## 2. Input 1 - Price movement & candles

All analysis is built on **OHLCV candles** (open, high, low, close, volume) from
the live Groww feed. The chosen **timeframe** decides the candle size:

- Intraday models use **15-minute** candles (the core "15-min model").
- Some views use 5m/30m/60m; swing and long-term use **daily** candles.

From the candle series the engine also derives the **current session high/low**
(intraday support/resistance) which anchor CALL/PUT level decisions.

Candle patterns are read *indirectly* through indicators computed on those
candles (e.g. Supertrend and Bollinger react to candle range/close position),
rather than as named single-candle patterns. This keeps the read objective and
backtestable.

---

## 3. Input 2 - Technical indicators (the signal score)

Six indicators each cast a **signed vote**. Votes are summed and normalised to a
**-100..+100 score**. The weights (shared with the backtester so live and
historical scores match) are:

| Indicator | Weight | What it measures | Bullish when... |
|---|---|---|---|
| EMA 9/21 cross | 22 | Short-term trend | Fast EMA above slow EMA (scaled by spread) |
| Supertrend (10,3) | 22 | Trend-following | Price above the Supertrend line |
| VWAP | 18 | Intraday fair value | Price above VWAP (buyers in control) |
| MACD histogram | 18 | Momentum | Histogram > 0 (MACD above signal) |
| RSI (14) | 12 | Over-bought/sold | <30 oversold (bounce) / >55 momentum up |
| Bollinger (20,2) | 8 | Stretch/mean-revert | At/below lower band (stretched down) |

**Scaling:** trend/momentum votes scale with strength (e.g. a wider EMA spread or
larger VWAP distance = a bigger vote, capped), so a strong trend counts more than
a marginal one.

**Score to label:**

| Score | Label |
|---|---|
| >= +50 | STRONG BUY |
| +15 to +49 | BUY |
| -14 to +14 | HOLD |
| -15 to -49 | SELL |
| <= -50 | STRONG SELL |

**Technical confidence** blends how big the score is with how much the
indicators agree:
`confidence = |score| x 0.6 + agreement x 100 x 0.4`, where agreement =
`|bullVotes - bearVotes| / totalDirectionalVotes`. So six indicators all pointing
one way scores far more confidently than a 4-2 split.

**Stops/targets** are volatility-aware from **ATR(14)**: in the signal's
direction, stop ~1.5x ATR and target ~2.5x ATR from price.

---

## 4. Input 3 - Market sentiment (option chain + futures)

Real sentiment comes from the **live Groww option chain** (never synthetic):

- **PCR (Put/Call OI ratio):** >= 1.2 = put writing = support building (bullish
  lean); <= 0.7 = call writing = resistance building (bearish lean).
- **Support / Resistance:** strikes with the max PUT OI (support) and max CALL OI
  (resistance).
- **Max pain:** the strike where option buyers lose most - price often gravitates
  there near expiry.
- **Futures buildup** (from futures OI + price day-change):
  - Price up + OI up = **Long buildup** (bullish)
  - Price down + OI up = **Short buildup** (bearish)
  - Price up + OI down = **Short covering** (bullish)
  - Price down + OI down = **Long unwinding** (bearish)

These produce an **OI verdict** (Bullish / Bearish / Neutral) plus a futures
direction, used as the sentiment inputs below.

---

## 5. Combining everything - the directional call

`directionFrom()` fuses technicals + sentiment into one call with a **weighted
vote**:

```
net = signalDir x 2  +  oiDir x 1.5  +  futuresDir x 1.5
dir = Bullish if net >= +1.5,  Bearish if net <= -1.5,  else Neutral
```

- `signalDir` = +1 if score >= 12, -1 if score <= -12, else 0.
- `oiDir` / `futuresDir` from Section 4.

**Blended confidence** starts from the technical confidence and is boosted when
factors agree, cut when they conflict:
`confidence = techConfidence x 0.6 + (agreeing factors x 12) - (conflicting factors x 14)`,
clamped 10-94 (and capped at 35 when direction is Neutral).

---

## 6. Market alignment (index correlation)

A stock rarely moves against its index. The system computes each stock's **beta
and correlation** vs NIFTY and BANK NIFTY (from daily returns) and picks the
benchmark it tracks most:

- **Aligned** (stock direction agrees with its index): confidence **+8**.
- **Conflict** (index pushing the other way): confidence **-18** and a headwind
  warning - fighting the index is the single biggest loss driver.
- **Low correlation** (|corr| < 0.3): treated as independent, no adjustment.

This is how "if NIFTY moves the opposite way, the stock may reverse" is handled
directly in the conviction.

---

## 7. Input 4 - Time period (timeframe, regime, expiry & theta)

Time enters the model in three ways:

**a) Timeframe** - 15m candles for intraday decisions, daily for swing/long-term.
The same scoring logic runs on whichever timeframe the view uses.

**b) Regime gate (trend vs range)** - ADX(14) on NIFTY 15m classifies the market:
Trending (ADX >= 25), Weak trend, or Range-bound (ADX < 18). In a **range-bound**
market the engine avoids buying options (they only bleed theta with no move) -
this feeds the header **trade-zone verdict** (NO-TRADE / SELECTIVE / TRADE-ON).

**c) Expiry & theta (time decay)** - options lose value as expiry approaches:
- **Theta %/day** is read from the chain; decay is labelled Low / Moderate / High.
- Near expiry (DTE <= 1) decay is "brutal" - flagged intraday-only, and the
  confirmation bar is raised (only >= 80% conviction trades are allowed there).
- Targets are made **expiry-aware**: a realistic fraction of the daily range
  (~50% intraday, ~35% near expiry) rather than a full ATR move, so trades are
  actually reachable before decay eats them.

---

## 8. From call to option trade - best-strike selection

Once a direction exists, the system does **not** blindly take ATM. Among
near-money strikes (delta 0.35-0.75 with a live premium) it scores each on:

```
strikeScore = liquidity x 0.5  +  deltaFit x 0.3  -  decayPenalty x 0.2
```

- **liquidity** = strike OI / max OI (higher OI = tighter fills).
- **deltaFit** = best near delta ~0.55 (strong directional capture without paying
  full ATM theta).
- **decayPenalty** = higher theta %/day is worse.

It records a plain-English `strikeReason` (e.g. "Chose 290 PE (ATM): PUT OI 438,
delta 0.45, theta 1.7%/day - balances liquidity + capture against decay").

**Premium projection** is delta-approximated: `dPremium ~= delta x dSpot`. From
the chosen strike it computes today's premium target/stop and a **next-day
continuation** target *net of one day's theta*, with its own probability.

---

## 9. Quality score and safety gates

Each option play gets a **quality score (0-100)** combining conviction, market
alignment, decay level, reward:risk, and delta. Then hard **safety gates** remove
loss-makers from the curated list:

- **Index headwind** (Conflict alignment) - filtered.
- **Decay trap** (theta > 60%/day - near-worthless option) - filtered.
- **Premium too thin** (< 1) - filtered.
- **Reward:risk below 1:1** - filtered.

Only plays passing every gate are shown as tradeable / eligible for paper trades.

---

## 10. What is model-driven vs where human judgement helps

- **Model-driven (objective, repeatable):** indicator scoring, OI/futures
  sentiment, index alignment, regime gate, strike selection, theta-aware targets,
  safety gates, position sizing.
- **Human judgement still adds value for:** unscheduled news/events, unusual
  volatility spikes, gap-open days, and confirming that live price action agrees
  with the model before acting. The system flags these conditions but cannot
  fully predict event-driven moves.

---

## 11. One-line summary of the logic

> Read live candles -> score six weighted indicators into a -100..+100 signal ->
> confirm with real option-chain OI + futures buildup -> fuse into a direction &
> confidence -> adjust for index correlation, trend regime, and time
> decay/expiry -> pick the best-liquidity, best-delta, low-theta strike with a
> realistic target -> and only surface it if it clears the safety gates.

---

*Disclaimer: This is decision-support software using statistical/technical models
on delayed-to-live data. It is not investment advice and does not guarantee
profit. Always confirm with your own judgement and manage risk.*
