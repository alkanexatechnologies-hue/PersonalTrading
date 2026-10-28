# ProTrader gate — "One Trade" (1:2 target, one at a time) · generated 2026-10-28

Data: real Dhan 1-minute index + ATM option premiums, 2024-11-19 → 2026-10-26 (298 sessions with trades). DEV = before 2025-10-28, VAL = from 2025-10-28. Net of costs (0.25 % per side + ₹40 per trade), per lot (NIFTY 75, SENSEX 20).

| Rule set | Trades | Win % | ₹ / trade | ₹ total | PF | Exits |
|---|---|---|---|---|---|---|
| LIVE · NIFTY · all | 223 | 35.4% | ₹-159 | ₹-35,430 | 0.83 | T1+BE 25, T2 31, SL 112, TIME 27, T1+TIME 28 |
| LIVE · NIFTY · DEV | 109 | 33% | ₹-192 | ₹-20,944 | 0.78 | T1+BE 14, T2 14, SL 55, TIME 14, T1+TIME 12 |
| LIVE · NIFTY · VAL | 114 | 37.7% | ₹-127 | ₹-14,486 | 0.88 | TIME 13, T2 17, SL 57, T1+TIME 16, T1+BE 11 |
| LIVE · SENSEX · all | 259 | 36.3% | ₹-185 | ₹-47,976 | 0.74 | SL 120, T1+BE 39, T1+TIME 29, T2 35, TIME 36 |
| LIVE · SENSEX · DEV | 131 | 32.8% | ₹-341 | ₹-44,659 | 0.56 | SL 67, T1+BE 16, T1+TIME 10, T2 19, TIME 19 |
| LIVE · SENSEX · VAL | 128 | 39.8% | ₹-26 | ₹-3,317 | 0.96 | T1+BE 23, TIME 17, SL 53, T2 16, T1+TIME 19 |
| LIVE · ONE AT A TIME (both) · all | 397 | 36.8% | ₹-129 | ₹-51,138 | 0.84 | T1+BE 59, T2 57, SL 187, TIME 51, T1+TIME 43 |
| LIVE · ONE AT A TIME · DEV | 203 | 33% | ₹-274 | ₹-55,692 | 0.67 | T1+BE 29, T2 27, SL 102, TIME 26, T1+TIME 19 |
| LIVE · ONE AT A TIME · VAL | 194 | 40.7% | ₹23 | ₹4,554 | 1.03 | TIME 25, T2 30, SL 85, T1+BE 30, T1+TIME 24 |
| FIXED_1to2 · NIFTY · all | 223 | 43.5% | ₹-76 | ₹-16,840 | 0.92 | SL 108, TARGET 93, TIME 22 |
| FIXED_1to2 · NIFTY · DEV | 110 | 39.1% | ₹-146 | ₹-16,024 | 0.85 | SL 56, TARGET 42, TIME 12 |
| FIXED_1to2 · NIFTY · VAL | 113 | 47.8% | ₹-7 | ₹-816 | 0.99 | TIME 10, TARGET 51, SL 52 |
| FIXED_1to2 · SENSEX · all | 265 | 42.3% | ₹-162 | ₹-42,839 | 0.78 | SL 129, TARGET 108, TIME 28 |
| FIXED_1to2 · SENSEX · DEV | 137 | 38% | ₹-309 | ₹-42,346 | 0.61 | SL 71, TARGET 51, TIME 15 |
| FIXED_1to2 · SENSEX · VAL | 128 | 46.9% | ₹-4 | ₹-493 | 0.99 | TARGET 57, SL 58, TIME 13 |
| FIXED_1to2 · ONE AT A TIME (both) · all | 404 | 44.6% | ₹-67 | ₹-26,962 | 0.92 | SL 191, TARGET 174, TIME 39 |
| FIXED_1to2 · ONE AT A TIME · DEV | 210 | 40% | ₹-226 | ₹-47,556 | 0.74 | SL 107, TARGET 83, TIME 20 |
| FIXED_1to2 · ONE AT A TIME · VAL | 194 | 49.5% | ₹106 | ₹20,594 | 1.15 | TIME 19, TARGET 91, SL 84 |

## Last 10 sessions, one at a time

| Day | LIVE | FIXED 1:2 |
|---|---|---|
| 2026-09-30 | S CE 09:45 T1+BE ₹-295; S PE 11:10 T1+BE ₹569; N CE 12:15 T2 ₹2442; N PE 14:00 T2 ₹2246 | S CE 09:45 TARGET ₹1975; N PE 14:00 TARGET ₹2248 |
| 2026-10-05 | N PE 11:00 T1+BE ₹284; N CE 14:05 TIME ₹-115 | N PE 11:00 TARGET ₹1456; N CE 14:05 TIME ₹-115 |
| 2026-10-06 | S CE 10:15 TIME ₹1001 | S CE 10:15 TARGET ₹957 |
| 2026-10-07 | S CE 10:55 SL ₹-1633; S PE 13:20 SL ₹-2843 | S CE 10:55 SL ₹-1633; S PE 13:20 SL ₹-2843 |
| 2026-10-08 | N PE 10:50 T1+TIME ₹7275 | N PE 10:50 TARGET ₹1239 |
| 2026-10-09 | N CE 10:20 SL ₹-1139; S CE 14:05 TIME ₹-977 | N CE 10:20 TARGET ₹1310; S CE 14:05 TIME ₹-977 |
| 2026-10-12 | N PE 10:50 T1+TIME ₹4014 | N PE 10:50 TARGET ₹1704; S PE 11:20 TARGET ₹154 |
| 2026-10-22 | N CE 10:10 T1+BE ₹538 | N CE 10:10 TARGET ₹1817 |
| 2026-10-23 | S PE 11:05 SL ₹-880; N CE 11:30 SL ₹-1345; S CE 13:50 SL ₹-1528 | S PE 11:05 SL ₹-880; N CE 11:30 SL ₹-1345; S CE 13:50 SL ₹-1528 |
| 2026-10-26 | N PE 11:20 SL ₹-2298 | N PE 11:20 TARGET ₹1621 |
