# ProTrader backtest #3 — Phase-2 proposals from the 19–23 Oct audit (pre-registered 2026-10-24)

Rules are written here BEFORE the run. Data, engine, costs and the dev/validation split are the same as backtest #2
(`premiumBacktest2.ts`): real Dhan 1-min premiums, NIFTY + SENSEX, from 2024-10-01 to the latest refreshed day, live plan
engine (`traderView.planStep`), DEVELOPMENT = first ⅔ of sessions, VALIDATION = last ⅓. Premium P&L per lot after costs
(spread 0.25% min ₹0.5 each side + ₹40 charges).

**LIVE (baseline)** = the approved live co-pilot: plan trigger on a 15-min close → trade only on a RETEST within 30 min ·
no plan trades on the index's own expiry day · range-day skip · last entry 14:45 · stop = 15-min close beyond the plan stop ·
half at T1 (index), stop → entry, rest at T2 or 15:12.

Each proposal changes ONE thing vs LIVE:

| ID | Proposal (audit item) | Exact rule |
|---|---|---|
| P1 | 2.1 wider stop | stop = 0.75 × ATR15 beyond the trigger level, still a 15-min close (T3b re-tested on the retest base; T3b was REJECTED on the plan-entry base on 18 Oct) |
| P1b | 2.1 hard stop | in addition to the 15-min-close stop, exit at once if the index TOUCHES entry − 1.0 × ATR15 (caps the "15-min close runs far past the stop" loss) |
| P2 | 2.2 no chasing | skip if the premium at entry is more than 10% above the premium at the trigger close |
| P3 | 2.3 premium targets | book half at +50% premium or index T1, whichever first; then stop = entry premium; rest at index T2, +100% premium or 15:12 |
| P4 | 2.4 time filter | no entries 10:00–10:29 and none after 12:30 |
| P5 | 2.5 fast-market skip | skip if the last 4 closed 15-min candles average ≥ 1.5 × ATR15 |

Not backtestable here (no rule change to score): 2.6 one engine one answer (design), 2.7 show only BUY verdicts (display).

APPROVE only if, for BOTH indices, premium P&L improves (or win % improves without worse P&L) in BOTH development and
validation, stop losses and max drawdown do not rise, no look-ahead, ≥ 30 trades. Otherwise REJECT / NEED MORE DATA.

## Results (run 2026-10-24; data 2024-10-01 → 2026-10-23; ₹ = 1 lot, net of costs)

| Version | NIFTY development | NIFTY validation | SENSEX development | SENSEX validation |
|---|---|---|---|---|
| LIVE | 145 tr · 34% · SL 72 · −28,313 · DD −42,637 | 77 · 39% · SL 39 · −4,819 · DD −41,367 | 172 · 33% · SL 85 · −61,713 · DD −67,271 | 86 · 44% · SL 34 · +15,140 · DD −7,585 |
| P1 wide stop | −22,036 | −5,803 ✗ (DD −48,189) | −53,730 | +10,296 ✗ (DD −11,998) |
| P1b hard stop | −37,183 ✗ (SL 87) | −339 (SL 40 ✗) | −54,551 (SL 97 ✗) | −339 ✗ |
| P2 no chase | **−13,267** (SL 66) | **+595** (SL 37) | **−54,136** (SL 81) | **+16,309** (SL 34) |
| P3 premium targets | −38,849 ✗ | −12,830 ✗ | −51,998 (SL 86 ✗) | +12,772 ✗ |
| P4 time filter | −15,216 | +3,460 | −36,358 | +4,627 ✗ |
| P5 fast-market skip | −28,120 | −224 | −60,447 | +16,716 |
| **P2 + P5** | **117 · −14,096 · SL 60 · DD −34,754** | **68 · +5,190 · SL 32 · DD −28,634** | **130 · −53,666 · SL 72 · DD −56,979** | **76 · +17,885 · SL 30 · DD −5,909** |

Last week (19–23 Oct) in the backtest: LIVE gave 3 trades (NIFTY 22 Oct +538, NIFTY 23 Oct −1,345, SENSEX 23 Oct −2,408);
P2 + P5 gives the same three. The other 12 Telegram calls of that week were never given under the live rules (no retest /
range day / expiry) — the message showed "TAKE" anyway; fixed separately (commit f7c15bc, messages only).

## Verdicts (ProTrader, 2026-10-24)

| Test | Verdict |
|---|---|
| **P2 no chasing + P5 fast-market skip (together)** | **APPROVE.** Better than LIVE in development AND validation for both indices; fewer stop losses and lower drawdown in every cell; 68–130 trades per cell; no look-ahead (trigger-close premium and closed 15-min candles only). P5 alone adds ~nothing in NIFTY development (+193) — approved only as part of P2 + P5. Implemented. |
| P1 wider stop (0.75 ATR) | **REJECT.** Validation worse for both indices with a deeper drawdown — same verdict as T3b on 18 Oct. The 7–23 Oct "stops too tight" finding (60 setups, 9 days) does not hold over 2 years. |
| P1b hard stop on a touch (1 ATR) | **REJECT.** More stop losses in every cell. |
| P3 premium targets (half at +50%) | **REJECT.** NIFTY worse in both periods; SENSEX validation worse. Index T1/T2 stay. |
| P4 no entries 10:00–10:29 / after 12:30 | **REJECT.** SENSEX validation −10,513 with a deeper drawdown. |

**Still not proven profitable.** P2 + P5 loses less (NIFTY −0.5% per trade in development, +0.5% in validation; SENSEX
−6% / +2.8%). Keep paper or minimum size until forward results confirm.
