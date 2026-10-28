# ProTrader gate — "three trades" strategy (plan + sweep-reclaim + day-range breakout), 1:2, one at a time · 2026-10-28

Real Dhan 1-min data 2024-11-19 → 2026-10-26 (472 sessions with trades). DEV before 2025-11-10, VAL from 2025-11-10. Net of costs, ₹ per lot; the 3-lot column = × 3 (NIFTY 3 × 75, SENSEX 3 × 20).

| Rule set (one at a time, NIFTY + SENSEX) | Trades | Win % | ₹ / trade (1 lot) | ₹ total (1 lot) | ₹ total (3 lots) | PF | Worst drawdown (3 lots) |
|---|---|---|---|---|---|---|---|
| ONE_TRADE_1to2 · all | 404 | 44.6% | ₹-67 | ₹-26,962 | ₹-80,886 | 0.92 | ₹-2,06,808 |
| ONE_TRADE_1to2 · DEV | 217 | 39.6% | ₹-239 | ₹-51,927 | ₹-1,55,781 | 0.73 | ₹-1,55,781 |
| ONE_TRADE_1to2 · VAL | 187 | 50.3% | ₹134 | ₹24,965 | ₹74,895 | 1.19 | ₹-58,509 |
| PLAN+SWEEP · all | 1064 | 41.4% | ₹-148 | ₹-1,57,440 | ₹-4,72,320 | 0.82 | ₹-5,39,757 |
| PLAN+SWEEP · DEV | 562 | 41.6% | ₹-175 | ₹-98,198 | ₹-2,94,594 | 0.79 | ₹-3,71,574 |
| PLAN+SWEEP · VAL | 502 | 41% | ₹-118 | ₹-59,242 | ₹-1,77,726 | 0.85 | ₹-2,13,261 |
| PLAN+BREAK · all | 725 | 41.2% | ₹-106 | ₹-77,100 | ₹-2,31,300 | 0.86 | ₹-2,88,711 |
| PLAN+BREAK · DEV | 382 | 39.5% | ₹-182 | ₹-69,350 | ₹-2,08,050 | 0.77 | ₹-2,20,503 |
| PLAN+BREAK · VAL | 343 | 43.1% | ₹-23 | ₹-7,750 | ₹-23,250 | 0.97 | ₹-1,00,659 |
| THREE_TRADES · all | 1228 | 40.2% | ₹-168 | ₹-2,06,545 | ₹-6,19,635 | 0.79 | ₹-6,69,273 |
| THREE_TRADES · DEV | 639 | 40.2% | ₹-205 | ₹-1,30,953 | ₹-3,92,859 | 0.75 | ₹-4,47,717 |
| THREE_TRADES · VAL | 589 | 40.2% | ₹-128 | ₹-75,592 | ₹-2,26,776 | 0.83 | ₹-2,53,281 |
| THREE_TRADES_no_range_skip · all | 1387 | 40.6% | ₹-146 | ₹-2,03,169 | ₹-6,09,507 | 0.81 | ₹-6,51,909 |
| THREE_TRADES_no_range_skip · DEV | 699 | 39.3% | ₹-212 | ₹-1,48,001 | ₹-4,44,003 | 0.75 | ₹-4,80,048 |
| THREE_TRADES_no_range_skip · VAL | 688 | 41.9% | ₹-80 | ₹-55,168 | ₹-1,65,504 | 0.89 | ₹-1,96,854 |

## THREE_TRADES by entry type (one at a time)

| Entry | Trades | Win % | ₹ / trade | ₹ total | ₹ total (3 lots) | PF | Worst DD (3 lots) |
|---|---|---|---|---|---|---|---|
| plan · DEV | 122 | 41.8% | ₹-216 | ₹-26,326 | ₹-78,978 | 0.74 | ₹-87,510 |
| plan · VAL | 94 | 39.4% | ₹-216 | ₹-20,285 | ₹-60,855 | 0.74 | ₹-1,01,535 |
| sweep · DEV | 399 | 41.6% | ₹-167 | ₹-66,628 | ₹-1,99,884 | 0.8 | ₹-3,07,845 |
| sweep · VAL | 371 | 41.8% | ₹-92 | ₹-34,205 | ₹-1,02,615 | 0.88 | ₹-1,38,780 |
| break · DEV | 118 | 33.9% | ₹-322 | ₹-37,999 | ₹-1,13,997 | 0.6 | ₹-1,13,997 |
| break · VAL | 124 | 36.3% | ₹-170 | ₹-21,102 | ₹-63,306 | 0.74 | ₹-68,928 |

## Last 10 sessions (THREE_TRADES, one at a time, 3 lots)

| Day | Trades |
|---|---|
| 2026-10-12 | S sweep CE 09:30 SL ₹-5,709; N sweep PE 09:40 TARGET ₹8,352; N plan PE 10:50 TARGET ₹5,112; S plan PE 11:20 TARGET ₹462 |
| 2026-10-13 | S break CE 14:15 TARGET ₹2,772 |
| 2026-10-14 | S sweep PE 09:40 SL ₹-4,110; N sweep CE 09:45 SL ₹-7,275 |
| 2026-10-15 | N sweep CE 09:35 TARGET ₹3,480; N break CE 10:45 SL ₹-4,698 |
| 2026-10-16 | N sweep CE 10:00 TARGET ₹12,447; S sweep CE 10:30 SL ₹-5,241 |
| 2026-10-19 | S sweep CE 09:35 SL ₹-12,321 |
| 2026-10-21 | N sweep CE 09:35 SL ₹-7,287; S sweep PE 09:50 TARGET ₹8,202 |
| 2026-10-22 | N sweep PE 09:35 SL ₹-6,195; N plan CE 10:10 TARGET ₹5,451; N break CE 10:35 SL ₹-5,667 |
| 2026-10-23 | S sweep PE 09:30 TARGET ₹5,109; S sweep PE 10:10 TARGET ₹7,695; N sweep CE 13:45 SL ₹-8,199 |
| 2026-10-26 | N sweep CE 09:55 TARGET ₹16,425 |
