# Index EMA 21 break + option premium EMA 9 / 21 cross: how often does it win? (2026-10-25)

Script: `emaCrossStudy.ts`. Full output: `RESULTS_EMA_CROSS_raw.txt`. Research only.

**Data:** real Dhan 1-min NIFTY + SENSEX spot and ATM option legs, 2024-10-01 → 2026-10-23.

**Periods (chronological):** DEV 292 / VAL 96 / TEST 97 sessions per index.

**Rule (fixed before any result):**
- **Signal:** a 5-min index close crosses EMA 21 (up or down), and the ATM option's 5-min premium has EMA 9 crossing
  above EMA 21 (the CE for an up break, the PE for a down break). The premium EMAs carry over from the previous session
  for the same strike, but never across an expiry.
- **Variants:**
  - S0: the premium cross is on the same candle
  - S2: the premium cross is within 2 candles before
  - SS: the premium EMA 9 is simply above its EMA 21
- **Trade:** entry at the signal close; stop beyond the signal candle (≥ 0.25 ATR); target 1:1 (2:1 as a second
  read); 60 min.
- **Option P&L:** after ProTrader costs; a premium-only exit at +20% / −10% as a second read.
- **Random:** an entry at any 5-min close with the same stop width.

**Win % at 1:1** [95% CI] (n), both indices:

| | DEV | VAL | TEST | Random, same stop |
|---|---|---|---|---|
| Index EMA 21 break alone | 47.7% (4,173) | 46.6% (1,319) | 46.9% (1,310) | 47.7–48.7% |
| + premium cross, same candle (S0) | **60.4%** [50–70] (91) | **37.5%** [23–55] (32) | 53.3% [30–75] (15) | 46.5–48.3% |
| + premium cross ≤ 2 candles (S2) | 58.6% (116) | 40.0% (45) | 45.8% (24) | 47–50% |
| + premium EMA 9 above EMA 21 (SS) | 53.5% (587) | 47.9% (194) | 51.7% (180) | 47.6–48.6% |

**Option net per trade after costs:**
- **EMA 21 break alone:** −2.0% / −1.9% / −2.2%.
- **S0:** +0.5% / −6.4% / −0.4%.
- **SS:** −0.3% / −2.4% / −1.6%.

**Frequency:**
- **Alone:** about 7 per session per index.
- **S0:** about 0.15 per session per index (once a week).
- **SS:** about 1 per session per index.

**Verdict:** no reliable edge.
- The EMA 21 break alone wins about 47%, the same as a random entry, and loses about 2% per option trade after costs.
- Adding the premium EMA 9 / 21 cross on the same candle looked strong in DEV (60%) but fell to 37.5% in VAL and was
  53% on a tiny TEST sample. Across all periods it is 75 of 138 = **54%**, about 6 points above random, but not
  stable, and the option P&L is about zero or negative after costs.
- "Premium EMA 9 above EMA 21" adds +0 to +6 points and still loses after costs.
- **No change to live logic.**

## Fixed 30-point target (owner: "only 30 points")

**Setup:** index +30 pts NIFTY / +100 pts SENSEX (the same % move), or premium +₹30. Stop beyond the signal candle
(median 13–20 pts NIFTY, so the target is about 1.5–2.3× the stop); 60 min.

| NIFTY, all periods | n | +30 pts first | Random, same stop | Option net | Premium +₹30 first (net per unit) |
|---|---|---|---|---|---|
| EMA 21 break alone | 3,424 | 30.1% | 29.5% | −2.6% | 17.2% (−₹2.8) |
| + premium cross same candle | 78 | **47.4%** [36.7–58.4] | 33.6% | +0.8% [−4.0, 6.1] | 32.1% (+₹1.4) |
| + premium EMA 9 above EMA 21 | 509 | 35.8% | 29.8% | −0.5% | 19.8% (−₹2.2) |

**Same-candle rule by period (NIFTY, +30 first):** DEV 51.1% (47) → VAL 36.4% (22, = random) → TEST 55.6% (9).

**SENSEX:**
- **+100 pts first:** 38.3% (60) vs random 33.1%.
- **Premium +₹30:** reached more often (51.7%) because SENSEX premiums are larger, but the net is −₹23.5 per unit: the
  losers are bigger.

**Verdict:**
- **NIFTY 30 pts:** the same-candle rule wins about 47% vs 34% random. That is better than random, but it fell to
  random in VAL, and the option P&L is about breakeven after costs (Δ ≈ 0.5, so 30 index pts ≈ ₹15 of premium).
- **Not a proven edge.** Information only; no change to live logic.

## The owner's chart reading: the premium PRICE crosses its own EMA 21 together with the index (2026-10-25)

**The two examples from the owner's screenshots (SENSEX, 23 Oct):**
- **13:30 up from the day's lows:** the index crossed above EMA 21 at 13:30. The ATM 72600 CE closed at 760 vs its
  EMA 762 (a hair below) and crossed at 13:35.
  - Entry at the 13:30 close: target hit (+5.8% option).
  - Entry at the 13:35 close (after the 275-point candle): the stop is 290 pts away, so a time exit at −12.2%.
- **14:35 cut down:** the index crossed below EMA 21 and, on the same candle, the CE crossed below and the PE crossed
  above their EMA 21s. After that the index ranged 72,795–72,865 and went back above EMA 21 at 15:10 → a loser.

**Variants:**
- **M0:** the index and the trade-side premium (CE for up, PE for down) cross EMA 21 on the same candle.
- **M1:** both cross within 1 candle; entry at the second cross.
- **"From a level":** the move starts within 0.3 ATR of PDH / PDL, PDC, ORB, the day's earlier high / low or a round
  number.
- **CE-chart view:** the CE crosses in the index's direction.

| Both indices | DEV | VAL | TEST | Random, same stop | Option net |
|---|---|---|---|---|---|
| EMA 21 break alone | 47.7% | 46.6% | 46.9% | 47.7–48.7% | about −2% |
| M0 same candle (2.2 / session / index pair) | 48.1% | 43.9% | 46.2% | 46.7–48.3% | −1.5% to −2.1% |
| M1 within 1 candle | 48.8% | 47.2% | 45.8% | 47.2–48.4% | about −2% |
| M1 + from a level | 46.3% | 46.1% | 45.9% | 47.3–48.4% | −2.1% to −2.7% |
| CE-chart view | 48.4% | 45.4% | 47.3% | 46.8–48.4% | −1.1% to −1.6% |

**Verdict:**
- When the premium price crosses EMA 21 with the index, it **almost always does** (2+ times a day per index): an ATM
  option moves with the index, so this adds no new information.
- The win rate stays at about 46–49%, the same as random, and the option P&L is −1% to −2% per trade after costs.
- Starting from a level does not help.
- **No change to live logic.**

## ATR / volatility filters (2026-10-25)

**Filters (pre-registered):**
- V1: signal candle ≤ 1 ATR (and > 1 ATR as the mirror)
- V2: ATR vs its 100-candle mean, < 0.8 / 0.8–1.2 / ≥ 1.2
- V3: day range so far vs the 20-day average, < 0.6 / ≥ 1
- V4: stop ≤ 1 ATR

These were applied to the EMA 21 break, M0 and M1. India VIX history is not in the research data.

**Gate:** promising = DEV edge ≥ +3 points vs the same-stop random entry with n ≥ 100. Frozen = also VAL edge > 0,
option net > 0 and n ≥ 50.

**Results:**
- **Promising on DEV:**
  - M0 + quiet ATR
  - M0 + wide day
  - M1 + candle ≤ 1 ATR
  - M1 + quiet ATR
  - M1 + wide day
  - M1 + stop ≤ 1 ATR (the same trades as candle ≤ 1 ATR)
- **Only M1 + candle ≤ 1 ATR also held on VAL:** 52.8% → 55.2% vs 48.9% random. Its option net was still negative
  (−1.6% / −1.0%), so **nothing was frozen**.
- **Expanding ATR (≥ 1.2) is the worst:** M1 VAL 32.9%, M0 VAL 30.4%.
- **Quiet ATR and wide-day filters reversed in VAL.**
- **Combinations:** DEV up to 59% (n 106) but not held in VAL.

**Post-gate look, M1 + candle ≤ 1 ATR** (win % vs random, option net):

| | DEV | VAL | TEST |
|---|---|---|---|
| NIFTY | 52.0% vs 49.0% · −1.5% | 56.2% vs 48.9% · 0.0% | **57.1% vs 49.3% · −0.8%** (n 140) |
| SENSEX | 53.6% vs 48.9% · −1.8% | 54.3% vs 48.9% · −1.9% | 45.8% vs 48.9% · −2.2% |

**Verdict:**
- ATR helps the **win rate** in one place only: NIFTY, both crosses within 1 candle, signal candle no bigger than
  1 ATR. That is +3 to +8 points over random in all three periods, about 52–57% at 1:1.
- It still does **not make money on options**: the stop (and so the 1:1 target) is small, about 15–20 NIFTY points,
  and costs plus time decay take the gain.
- SENSEX failed in TEST.
- **No change to live logic.** Information only. A wider target for the same signal (e.g. 2:1) is a separate,
  untested idea.

## The owner's 8-point buffer (2026-10-25)

**Rule:** the candle must close at least 8 pts beyond EMA 21 (NIFTY; 26 pts SENSEX, the same %).
- **B8a:** the crossing candle itself closes beyond the buffer, else no trade.
- **B8b:** the first close beyond the buffer within 3 candles of the cross.

| Win % at 1:1 vs random (DEV / VAL / TEST) | NIFTY | SENSEX |
|---|---|---|
| EMA 21 break, no buffer | 47.4 / 47.3 / 47.7 (random about 48) | 48.0 / 45.9 / 46.1 |
| B8a, cross candle ≥ buffer | **44.2 / 45.5 / 47.2** (edge −2) | 45.3 / 43.2 / 46.0 (edge −1 to −4) |
| B8b, first close ≥ buffer | 45.3 / 47.9 / 46.3 | 44.7 / 44.6 / 46.2 |
| M1 + candle ≤ 1 ATR (earlier best) | 52.0 / 56.2 / 57.1 | 53.6 / 54.3 / 45.8 |
| **M1 + candle ≤ 1 ATR + buffer** | **54.4 / 56.4 / 64.2** (n 228 / 94 / 67) | 52.3 / 54.4 / 44.8 |

**Results:**
- **The buffer on its own makes the EMA 21 break worse** (−1 to −4 points vs random). A candle that closes far past
  EMA 21 is usually a big candle, so the stop is wide and the move is already stretched. Crosses that close within the
  buffer do slightly better (about 49%).
- **On top of "M1 + small candle", NIFTY improves:** 54–64% vs about 49% random. Caveat: this combination was built
  after the TEST result of M1 + small candle had been seen, so its TEST figure is not untouched evidence. Samples are
  small (67 in TEST).
- **SENSEX fails TEST again.**
- **Option net is about breakeven** (−1.1% / +0.6% / −0.3%).

**Verdict:** no change to live logic. NIFTY "M1 + small candle + 8-pt buffer" is a forward-test candidate, not
proven.
