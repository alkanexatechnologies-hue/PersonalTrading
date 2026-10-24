# C2 — losing-trade audit and flexible 3-plan exit engine (last 15 sessions · EXPLORATORY · not validated)

## A0. Verification of the reported C2 figures (recomputed from the trade records)

- Trades 121 · target 48 · stop 60 · time 13 · ambiguous 0 · target-hit rate 39.7%
- Net per trade ₹362 · conservative ₹236 (reported: 121 / 48 / 60 / 13, 39.7 %, +₹362, +₹236)

## A1. Trade-by-trade audit (baseline exit X0; premium in ₹ per unit, P&L in ₹ per lot after costs)

Columns: thresholds +5/+10/+15/+20 = premium rose that much (1-min high) BEFORE the exit. Breakout = index behaviour over the 30 min after entry (FAILED = a 5-min close back through the level; HELD = no re-entry and ≥ 0.5 ATR beyond; CHOPPY = neither). Expiry = the next expiry inferred from the data (straddle collapse), not from a contract master.

| # | Date | Entry | Index | Side | Strike | Expiry | Entry ₹ | Level | Level price | Accepted at | OI at entry | Prem ATR | SL / target | MFE | MAE | +5 | +10 | +15 | +20 | Exit | Exit ₹ | Result | Net ₹ | Breakout | Regime |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 10-01 | 10:05 | SENSEX | CE | 72500 | 2026-10-01 (expiry day) | 213.00 | PDL | 72,378 | 10:00–10:05 close | WRITE | 48.0 | 165.0 / 308.9 | 18.4 | 41.9 | ✓ | ✓ | ✓ | – | 10:11 | 165.04 | STOP | -1,020 | HELD | CHOPPY |
| 2 | 10-01 | 10:10 | NIFTY | CE | 22600 | 2026-10-06 | 130.15 | ORB high | 22,582 | 10:05–10:10 close | WRITE | 16.4 | 113.7 / 163.0 | 14.4 | 15.6 | ✓ | ✓ | – | – | 11:09 | 113.71 | STOP | -1,348 | FAILED 10:15 | CHOPPY |
| 3 | 10-01 | 10:10 | SENSEX | CE | 72500 | 2026-10-01 (expiry day) | 171.10 | PDC | 72,480 | 10:05–10:10 close | WRITE | 49.2 | 121.9 / 269.5 | 39.6 | 45.1 | ✓ | ✓ | ✓ | ✓ | 11:09 | 121.90 | STOP | -1,044 | FAILED 10:15 | CHOPPY |
| 4 | 10-01 | 10:20 | NIFTY | PE | 22550 | 2026-10-06 | 110.15 | ORB high | 22,582 | 10:15–10:20 close | WRITE | 15.9 | 94.2 / 142.0 | 9.3 | 14.4 | ✓ | – | – | – | 10:37 | 94.23 | STOP | -1,309 | HELD | CHOPPY |
| 5 | 10-01 | 10:20 | SENSEX | PE | 72400 | 2026-10-01 (expiry day) | 180.20 | PDC | 72,480 | 10:15–10:20 close | WRITE | 51.0 | 129.2 / 282.2 | 41.2 | 48.4 | ✓ | ✓ | ✓ | ✓ | 11:20 | 185.05 | TIME | 37 | HELD | CHOPPY |
| 6 | 10-01 | 11:10 | SENSEX | PE | 72300 | 2026-10-01 (expiry day) | 164.45 | ORB high | 72,410 | 11:05–11:10 close | WRITE | 28.6 | 135.9 / 221.6 | 3.0 | 28.3 | – | – | – | – | 11:18 | 135.89 | STOP | -631 | HELD | TRANSITION |
| 7 | 10-01 | 11:15 | SENSEX | PE | 72400 | 2026-10-01 (expiry day) | 197.75 | PDL | 72,378 | 11:10–11:15 close | WRITE | 34.6 | 163.2 / 266.9 | 38.4 | 31.6 | ✓ | ✓ | ✓ | ✓ | 11:38 | 163.15 | STOP | -752 | FAILED 11:20 | TRANSITION |
| 8 | 10-01 | 12:20 | SENSEX | PE | 72200 | 2026-10-01 (expiry day) | 179.75 | owner S/R | 72,270 | 12:15–12:20 close | WRITE | 30.8 | 149.0 / 241.3 | 51.2 | 24.1 | ✓ | ✓ | ✓ | ✓ | 12:29 | 241.29 | TARGET | 1,169 | HELD | TRANSITION |
| 9 | 10-01 | 12:25 | NIFTY | PE | 22500 | 2026-10-06 | 127.20 | ORB low | 22,513 | 12:20–12:25 close | WRITE | 11.2 | 116.0 / 149.5 | 18.2 | 2.5 | ✓ | ✓ | ✓ | – | 12:45 | 149.52 | TARGET | 1,559 | HELD | CHOPPY |
| 10 | 10-05 | 09:40 | SENSEX | CE | 72500 | 2026-10-08 | 528.00 | ORB high | 72,428 | 09:35–09:40 close | WRITE | 46.7 | 481.3 / 621.5 | 55.0 | 44.1 | ✓ | ✓ | ✓ | ✓ | 10:01 | 481.27 | STOP | -1,025 | FAILED 10:05 | UNKNOWN_DATA |
| 11 | 10-05 | 09:55 | SENSEX | CE | 72600 | 2026-10-08 | 500.65 | PDH | 72,559 | 09:50–09:55 close | WRITE | 41.7 | 459.0 / 584.0 | 17.4 | 32.6 | ✓ | ✓ | ✓ | – | 10:00 | 458.99 | STOP | -921 | FAILED 10:00 | TRENDING_UP |
| 12 | 10-05 | 10:05 | NIFTY | PE | 22550 | 2026-10-06 | 89.85 | owner S/R | 22,573 | 10:00–10:05 close | WRITE | 13.7 | 76.2 / 117.2 | 17.8 | 10.6 | ✓ | ✓ | ✓ | – | 10:26 | 117.15 | TARGET | 1,933 | HELD | TRENDING_UP |
| 13 | 10-05 | 10:05 | SENSEX | PE | 72400 | 2026-10-08 | 446.05 | PDH | 72,559 | 10:00–10:05 close | WRITE | 49.4 | 396.6 / 544.9 | 62.8 | 34.4 | ✓ | ✓ | ✓ | ✓ | 10:26 | 544.94 | TARGET | 1,888 | HELD | TRENDING_UP |
| 14 | 10-05 | 10:10 | SENSEX | PE | 72400 | 2026-10-08 | 421.65 | ORB high | 72,428 | 10:05–10:10 close | WRITE | 49.7 | 371.9 / 521.1 | 87.3 | 9.9 | ✓ | ✓ | ✓ | ✓ | 10:26 | 521.12 | TARGET | 1,902 | HELD | TRENDING_UP |
| 15 | 10-05 | 10:30 | NIFTY | PE | 22500 | 2026-10-06 | 81.75 | ORB low | 22,517 | 10:25–10:30 close | WRITE | 13.1 | 68.6 / 108.0 | 22.2 | 12.0 | ✓ | ✓ | ✓ | ✓ | 10:56 | 108.04 | TARGET | 1,856 | FAILED 10:35 | TRANSITION |
| 16 | 10-05 | 10:30 | SENSEX | PE | 72300 | 2026-10-08 | 453.15 | ORB low | 72,260 | 10:25–10:30 close | WRITE | 49.6 | 403.6 / 552.3 | 88.9 | 39.9 | ✓ | ✓ | ✓ | ✓ | 10:56 | 552.30 | TARGET | 1,893 | FAILED 10:35 | TRENDING_UP |
| 17 | 10-05 | 11:35 | SENSEX | CE | 72200 | 2026-10-08 | 542.40 | owner S/R | 72,087 | 11:30–11:35 close | WRITE | 43.9 | 498.5 / 630.1 | 0.3 | 37.4 | – | – | – | – | 11:40 | 498.54 | STOP | -969 | FAILED 11:45 | TRANSITION |
| 18 | 10-05 | 12:15 | SENSEX | PE | 71900 | 2026-10-08 | 448.15 | PDC | 71,910 | 12:10–12:15 close | WRITE | 45.6 | 402.6 / 539.3 | 6.9 | 41.6 | ✓ | – | – | – | 12:24 | 402.60 | STOP | -994 | FAILED 12:20 | TRANSITION |
| 19 | 10-05 | 12:25 | NIFTY | CE | 22450 | 2026-10-06 | 106.60 | PDC | 22,422 | 12:20–12:25 close | WRITE | 16.6 | 90.0 / 139.7 | 22.2 | 4.0 | ✓ | ✓ | ✓ | ✓ | 13:25 | 115.75 | TIME | 571 | HELD | TRANSITION |
| 20 | 10-05 | 12:25 | SENSEX | CE | 72000 | 2026-10-08 | 547.95 | PDC | 71,910 | 12:20–12:25 close | WRITE | 51.8 | 496.1 / 651.6 | 63.8 | 15.0 | ✓ | ✓ | ✓ | ✓ | 13:25 | 575.30 | TIME | 451 | HELD | TRANSITION |
| 21 | 10-05 | 13:30 | SENSEX | PE | 72100 | 2026-10-08 | 462.95 | owner S/R | 72,087 | 13:25–13:30 close | WRITE | 42.6 | 420.3 / 548.2 | 9.9 | 26.8 | ✓ | – | – | – | 13:37 | 420.31 | STOP | -937 | FAILED 13:40 | TRANSITION |
| 22 | 10-05 | 13:50 | NIFTY | CE | 22550 | 2026-10-06 | 99.30 | ORB low | 22,517 | 13:45–13:50 close | WRITE | 11.8 | 87.5 / 123.0 | 12.5 | 7.0 | ✓ | ✓ | – | – | 14:05 | 87.46 | STOP | -1,003 | HELD | TRANSITION |
| 23 | 10-05 | 13:50 | SENSEX | CE | 72300 | 2026-10-08 | 528.30 | ORB low | 72,260 | 13:45–13:50 close | WRITE | 40.2 | 488.1 / 608.6 | 40.0 | 18.0 | ✓ | ✓ | ✓ | ✓ | 14:05 | 488.12 | STOP | -894 | FAILED 14:05 | TRANSITION |
| 24 | 10-06 | 09:40 | NIFTY | CE | 22600 | 2026-10-06 (expiry day) | 71.85 | ORB high | 22,600 | 09:35–09:40 close | WRITE | 11.5 | 60.3 / 94.9 | 21.2 | 6.3 | ✓ | ✓ | ✓ | ✓ | 09:57 | 94.92 | TARGET | 1,616 | HELD | UNKNOWN_DATA |
| 25 | 10-06 | 09:40 | SENSEX | CE | 72600 | 2026-10-08 | 408.20 | ORB high | 72,517 | 09:35–09:40 close | WRITE | 34.9 | 373.3 / 478.0 | 66.2 | 17.1 | ✓ | ✓ | ✓ | ✓ | 09:57 | 478.02 | TARGET | 1,312 | HELD | UNKNOWN_DATA |
| 26 | 10-06 | 09:55 | NIFTY | CE | 22650 | 2026-10-06 (expiry day) | 57.40 | PDH | 22,617 | 09:50–09:55 close | WRITE | 9.1 | 48.3 / 75.5 | 14.1 | 7.9 | ✓ | ✓ | – | – | 10:10 | 48.33 | STOP | -795 | HELD | TRANSITION |
| 27 | 10-06 | 09:55 | SENSEX | CE | 72700 | 2026-10-08 | 398.30 | PDH | 72,626 | 09:50–09:55 close | WRITE | 33.8 | 364.5 / 465.9 | 40.0 | 29.4 | ✓ | ✓ | ✓ | ✓ | 10:10 | 364.50 | STOP | -754 | FAILED 10:10 | TRANSITION |
| 28 | 10-06 | 10:45 | NIFTY | CE | 22700 | 2026-10-06 (expiry day) | 42.45 | owner S/R | 22,663 | 10:40–10:45 close | WRITE | 8.0 | 34.4 / 58.5 | 1.0 | 8.0 | – | – | – | – | 10:53 | 34.42 | STOP | -717 | FAILED 11:00 | TRENDING_UP |
| 29 | 10-06 | 12:45 | SENSEX | CE | 73000 | 2026-10-08 | 375.20 | owner S/R | 72,877 | 12:40–12:45 close | WRITE | 26.9 | 348.3 / 429.0 | 11.6 | 26.5 | ✓ | ✓ | – | – | 12:52 | 348.29 | STOP | -614 | HELD | TRENDING_UP |
| 30 | 10-06 | 14:35 | SENSEX | PE | 72900 | 2026-10-08 | 368.50 | owner S/R | 72,877 | 14:30–14:35 close | WRITE | 25.2 | 343.3 / 418.9 | 14.1 | 22.0 | ✓ | ✓ | – | – | 14:41 | 343.28 | STOP | -580 | FAILED 14:40 | COMPRESSION |
| 31 | 10-07 | 09:50 | SENSEX | CE | 72600 | 2026-10-08 | 322.25 | ORB low | 72,599 | 09:45–09:50 close | WRITE | 41.1 | 281.2 / 404.4 | 23.6 | 33.4 | ✓ | ✓ | ✓ | ✓ | 10:03 | 281.18 | STOP | -892 | HELD | TRANSITION |
| 32 | 10-07 | 10:25 | NIFTY | CE | 22650 | 2026-10-13 | 157.20 | ORB high | 22,627 | 10:20–10:25 close | WRITE | 14.7 | 142.5 / 186.5 | 23.6 | 8.1 | ✓ | ✓ | ✓ | ✓ | 10:37 | 142.53 | STOP | -1,215 | HELD | CHOPPY |
| 33 | 10-07 | 10:25 | SENSEX | CE | 72800 | 2026-10-08 | 288.25 | ORB high | 72,667 | 10:20–10:25 close | WRITE | 44.0 | 244.2 / 376.3 | 48.8 | 0.0 | ✓ | ✓ | ✓ | ✓ | 10:30 | 376.26 | TARGET | 1,687 | HELD | CHOPPY |
| 34 | 10-07 | 10:30 | NIFTY | CE | 22700 | 2026-10-13 | 151.15 | owner S/R | 22,665 | 10:25–10:30 close | WRITE | 13.6 | 137.5 / 178.4 | 1.4 | 11.7 | – | – | – | – | 10:35 | 137.51 | STOP | -1,138 | FAILED 10:35 | CHOPPY |
| 35 | 10-07 | 10:40 | NIFTY | PE | 22650 | 2026-10-13 | 153.95 | owner S/R | 22,665 | 10:35–10:40 close | WRITE | 18.3 | 135.6 / 190.6 | 1.6 | 15.3 | – | – | – | – | 10:55 | 135.64 | STOP | -1,488 | FAILED 10:55 | CHOPPY |
| 36 | 10-07 | 13:05 | NIFTY | PE | 22600 | 2026-10-13 | 142.90 | ORB high | 22,627 | 13:00–13:05 close | WRITE | 10.9 | 132.0 / 164.8 | 19.3 | 0.8 | ✓ | ✓ | ✓ | – | 13:10 | 164.79 | TARGET | 1,527 | HELD | TRANSITION |
| 37 | 10-07 | 13:15 | NIFTY | PE | 22600 | 2026-10-13 | 162.40 | ORB low | 22,610 | 13:10–13:15 close | WRITE | 13.5 | 148.9 / 189.3 | 7.6 | 13.0 | ✓ | – | – | – | 13:30 | 148.95 | STOP | -1,124 | HELD | TRANSITION |
| 38 | 10-07 | 13:15 | SENSEX | PE | 72600 | 2026-10-08 | 330.55 | ORB high | 72,667 | 13:10–13:15 close | WRITE | 37.4 | 293.2 / 405.3 | 22.5 | 36.0 | ✓ | ✓ | ✓ | ✓ | 13:30 | 293.20 | STOP | -818 | HELD | TRANSITION |
| 39 | 10-07 | 14:15 | NIFTY | PE | 22550 | 2026-10-13 | 137.60 | PDL | 22,569 | 14:10–14:15 close | WRITE | 13.8 | 123.8 / 165.3 | 0.5 | 11.9 | – | – | – | – | 14:19 | 123.76 | STOP | -1,153 | FAILED 14:20 | TRANSITION |
| 40 | 10-08 | 09:50 | NIFTY | PE | 22450 | 2026-10-13 | 126.00 | ORB low | 22,481 | 09:45–09:50 close | WRITE | 15.5 | 110.5 / 156.9 | 23.8 | 14.8 | ✓ | ✓ | ✓ | ✓ | 10:50 | 125.20 | TIME | -175 | FAILED 10:05 | TRENDING_DOWN |
| 41 | 10-08 | 09:50 | SENSEX | PE | 72300 | 2026-10-08 (expiry day) | 213.30 | ORB low | 72,278 | 09:45–09:50 close | WRITE | 44.2 | 169.1 / 301.7 | 13.4 | 31.5 | ✓ | ✓ | – | – | 10:13 | 169.10 | STOP | -945 | FAILED 10:00 | TRENDING_DOWN |
| 42 | 10-08 | 10:40 | SENSEX | PE | 72100 | 2026-10-08 (expiry day) | 157.95 | owner S/R | 72,238 | 10:35–10:40 close | WRITE | 28.9 | 129.0 / 215.8 | 10.3 | 25.3 | ✓ | ✓ | – | – | 10:44 | 129.02 | STOP | -639 | HELD | TRANSITION |
| 43 | 10-09 | 09:40 | NIFTY | CE | 22400 | 2026-10-13 | 153.30 | ORB high | 22,375 | 09:35–09:40 close | WRITE | 21.3 | 132.0 / 196.0 | 42.3 | 4.1 | ✓ | ✓ | ✓ | ✓ | 10:13 | 195.98 | TARGET | 3,086 | HELD | UNKNOWN_DATA |
| 44 | 10-09 | 09:40 | SENSEX | CE | 72100 | 2026-10-15 | 642.30 | ORB high | 72,021 | 09:35–09:40 close | WRITE | 62.1 | 580.2 / 766.5 | 116.5 | 9.0 | ✓ | ✓ | ✓ | ✓ | 09:57 | 766.47 | TARGET | 2,373 | HELD | UNKNOWN_DATA |
| 45 | 10-09 | 09:55 | SENSEX | CE | 72300 | 2026-10-15 | 612.20 | owner S/R | 72,237 | 09:50–09:55 close | WRITE | 51.0 | 561.2 / 714.3 | 62.8 | 37.9 | ✓ | ✓ | ✓ | ✓ | 10:55 | 632.15 | TIME | 297 | HELD | TRANSITION |
| 46 | 10-09 | 11:25 | NIFTY | CE | 22500 | 2026-10-13 | 144.10 | owner S/R | 22,517 | 11:20–11:25 close | WRITE | 13.5 | 130.6 / 171.2 | 3.6 | 10.4 | – | – | – | – | 11:35 | 130.56 | STOP | -1,130 | FAILED 11:30 | TRENDING_UP |
| 47 | 10-09 | 11:30 | SENSEX | PE | 72400 | 2026-10-15 | 467.00 | owner S/R | 72,485 | 11:25–11:30 close | FLAT | 32.0 | 435.0 / 531.1 | 62.3 | 8.9 | ✓ | ✓ | ✓ | ✓ | 11:44 | 531.08 | TARGET | 1,192 | HELD | TRENDING_UP |
| 48 | 10-09 | 11:35 | NIFTY | PE | 22500 | 2026-10-13 | 115.95 | owner S/R | 22,517 | 11:30–11:35 close | WRITE | 11.7 | 104.3 / 139.3 | 22.5 | 2.0 | ✓ | ✓ | ✓ | ✓ | 12:00 | 139.26 | TARGET | 1,633 | HELD | TRENDING_UP |
| 49 | 10-09 | 13:50 | SENSEX | CE | 72500 | 2026-10-15 | 576.40 | owner S/R | 72,485 | 13:45–13:50 close | WRITE | 29.3 | 547.1 / 635.0 | 7.5 | 26.9 | ✓ | – | – | – | 13:55 | 547.09 | STOP | -682 | FAILED 13:55 | TRANSITION |
| 50 | 10-09 | 14:05 | SENSEX | CE | 72500 | 2026-10-15 | 570.80 | PDH | 72,502 | 14:00–14:05 close | WRITE | 33.4 | 537.4 / 637.7 | 43.1 | 2.8 | ✓ | ✓ | ✓ | ✓ | 14:19 | 637.68 | TARGET | 1,237 | HELD | TRANSITION |
| 51 | 10-09 | 14:15 | SENSEX | CE | 72600 | 2026-10-15 | 522.85 | owner S/R | 72,553 | 14:10–14:15 close | WRITE | 31.6 | 491.3 / 586.1 | 30.5 | 0.9 | ✓ | ✓ | ✓ | ✓ | 14:19 | 586.05 | TARGET | 1,169 | HELD | TRANSITION |
| 52 | 10-09 | 14:25 | NIFTY | CE | 22550 | 2026-10-13 | 130.05 | owner S/R | 22,552 | 14:20–14:25 close | WRITE | 12.0 | 118.0 / 154.1 | 4.8 | 11.9 | – | – | – | – | 14:41 | 118.03 | STOP | -1,017 | FAILED 14:30 | TRENDING_UP |
| 53 | 10-12 | 09:40 | NIFTY | PE | 22500 | 2026-10-13 | 84.85 | PDH | 22,579 | 09:35–09:40 close | WRITE | 26.4 | 58.4 / 137.7 | 36.2 | 9.8 | ✓ | ✓ | ✓ | ✓ | 10:40 | 102.25 | TIME | 1,190 | HELD | UNKNOWN_DATA |
| 54 | 10-12 | 09:40 | SENSEX | PE | 72400 | 2026-10-15 | 463.00 | PDC | 72,472 | 09:35–09:40 close | WRITE | 99.1 | 363.9 / 661.2 | 124.5 | 31.5 | ✓ | ✓ | ✓ | ✓ | 10:40 | 539.65 | TIME | 1,443 | HELD | UNKNOWN_DATA |
| 55 | 10-12 | 09:45 | SENSEX | PE | 72400 | 2026-10-15 | 480.15 | ORB low | 72,418 | 09:40–09:45 close | WRITE | 89.3 | 390.9 / 658.7 | 107.4 | 48.6 | ✓ | ✓ | ✓ | ✓ | 10:45 | 567.40 | TIME | 1,653 | HELD | TRANSITION |
| 56 | 10-12 | 10:00 | NIFTY | PE | 22500 | 2026-10-13 | 87.90 | ORB low | 22,523 | 09:55–10:00 close | WRITE | 23.2 | 64.7 / 134.3 | 44.7 | 11.6 | ✓ | ✓ | ✓ | ✓ | 11:00 | 132.55 | TIME | 3,234 | HELD | TRANSITION |
| 57 | 10-12 | 10:35 | SENSEX | PE | 72200 | 2026-10-15 | 462.70 | owner S/R | 72,238 | 10:30–10:35 close | WRITE | 45.9 | 416.8 / 554.5 | 84.3 | 34.7 | ✓ | ✓ | ✓ | ✓ | 11:05 | 554.54 | TARGET | 1,746 | HELD | TRANSITION |
| 58 | 10-12 | 14:20 | SENSEX | PE | 71800 | 2026-10-15 | 416.95 | PDL | 71,820 | 14:15–14:20 close | WRITE | 30.9 | 386.0 / 478.8 | 60.1 | 2.9 | ✓ | ✓ | ✓ | ✓ | 14:44 | 478.81 | TARGET | 1,152 | HELD | TRANSITION |
| 59 | 10-13 | 09:40 | NIFTY | CE | 22500 | 2026-10-13 (expiry day) | 76.65 | ORB high | 22,477 | 09:35–09:40 close | WRITE | 16.1 | 60.5 / 108.9 | 29.9 | 5.7 | ✓ | ✓ | ✓ | ✓ | 09:55 | 108.90 | TARGET | 2,304 | HELD | UNKNOWN_DATA |
| 60 | 10-13 | 09:40 | SENSEX | CE | 72400 | 2026-10-15 | 460.85 | ORB high | 72,304 | 09:35–09:40 close | WRITE | 55.8 | 405.0 / 572.5 | 104.1 | 11.8 | ✓ | ✓ | ✓ | ✓ | 09:55 | 572.55 | TARGET | 2,142 | HELD | UNKNOWN_DATA |
| 61 | 10-13 | 09:55 | NIFTY | CE | 22550 | 2026-10-13 (expiry day) | 73.70 | owner S/R | 22,552 | 09:50–09:55 close | WRITE | 12.9 | 60.8 / 99.6 | 5.9 | 11.8 | ✓ | – | – | – | 10:19 | 60.75 | STOP | -1,086 | FAILED 10:20 | TRENDING_UP |
| 62 | 10-13 | 09:55 | SENSEX | CE | 72600 | 2026-10-15 | 442.20 | owner S/R | 72,489 | 09:50–09:55 close | WRITE | 48.9 | 393.3 / 539.9 | 16.5 | 38.9 | ✓ | ✓ | ✓ | – | 10:20 | 393.33 | STOP | -1,059 | FAILED 10:25 | TRENDING_UP |
| 63 | 10-13 | 10:25 | NIFTY | PE | 22550 | 2026-10-13 (expiry day) | 55.10 | owner S/R | 22,552 | 10:20–10:25 close | WRITE | 15.0 | 40.1 / 85.0 | 29.4 | 2.6 | ✓ | ✓ | ✓ | ✓ | 10:40 | 85.05 | TARGET | 2,131 | HELD | TRENDING_UP |
| 64 | 10-13 | 13:05 | SENSEX | PE | 72500 | 2026-10-15 | 322.05 | owner S/R | 72,489 | 13:00–13:05 close | WRITE | 26.2 | 295.9 / 374.4 | 3.4 | 20.1 | – | – | – | – | 13:11 | 295.86 | STOP | -595 | FAILED 13:10 | TRANSITION |
| 65 | 10-14 | 09:50 | NIFTY | CE | 22750 | after data | 147.00 | PDH | 22,722 | 09:45–09:50 close | WRITE | 25.4 | 121.6 / 197.7 | 10.2 | 23.8 | ✓ | ✓ | – | – | 10:08 | 121.64 | STOP | -2,017 | FAILED 09:55 | TRENDING_UP |
| 66 | 10-14 | 09:50 | SENSEX | CE | 73200 | 2026-10-15 | 277.80 | PDH | 73,036 | 09:45–09:50 close | WRITE | 67.9 | 209.9 / 413.7 | 25.8 | 62.9 | ✓ | ✓ | ✓ | ✓ | 10:08 | 209.85 | STOP | -1,423 | FAILED 09:55 | TRENDING_UP |
| 67 | 10-14 | 10:00 | NIFTY | PE | 22700 | after data | 143.80 | PDH | 22,722 | 09:55–10:00 close | WRITE | 19.6 | 124.2 / 183.0 | 17.8 | 17.0 | ✓ | ✓ | ✓ | – | 11:00 | 124.18 | STOP | -1,586 | HELD | TRENDING_UP |
| 68 | 10-14 | 13:00 | SENSEX | PE | 72900 | 2026-10-15 | 308.10 | PDH | 73,036 | 12:55–13:00 close | WRITE | 32.5 | 275.6 / 373.0 | 56.9 | 0.0 | ✓ | ✓ | ✓ | ✓ | 13:02 | 373.03 | TARGET | 1,225 | HELD | TRANSITION |
| 69 | 10-14 | 13:05 | NIFTY | PE | 22600 | after data | 148.95 | ORB low | 22,674 | 13:00–13:05 close | WRITE | 10.7 | 138.3 / 170.3 | 19.5 | 6.4 | ✓ | ✓ | ✓ | – | 13:09 | 170.26 | TARGET | 1,483 | HELD | TRANSITION |
| 70 | 10-14 | 13:10 | NIFTY | PE | 22600 | after data | 167.00 | owner S/R | 22,643 | 13:05–13:10 close | WRITE | 12.4 | 154.6 / 191.8 | 16.4 | 10.3 | ✓ | ✓ | ✓ | – | 13:30 | 154.60 | STOP | -1,045 | HELD | TRANSITION |
| 71 | 10-14 | 13:10 | SENSEX | PE | 72700 | 2026-10-15 | 386.95 | ORB low | 72,907 | 13:05–13:10 close | WRITE | 43.8 | 343.2 / 474.4 | 57.6 | 32.1 | ✓ | ✓ | ✓ | ✓ | 13:29 | 343.20 | STOP | -952 | HELD | TRANSITION |
| 72 | 10-14 | 13:30 | NIFTY | CE | 22600 | after data | 136.95 | owner S/R | 22,577 | 13:25–13:30 close | WRITE | 16.7 | 120.3 / 170.3 | 27.5 | 10.2 | ✓ | ✓ | ✓ | ✓ | 13:48 | 170.31 | TARGET | 2,387 | HELD | TRENDING_DOWN |
| 73 | 10-14 | 14:00 | NIFTY | CE | 22650 | after data | 143.70 | owner S/R | 22,643 | 13:55–14:00 close | WRITE | 15.4 | 128.3 / 174.5 | 3.6 | 14.6 | – | – | – | – | 14:08 | 128.30 | STOP | -1,270 | FAILED 14:05 | TRANSITION |
| 74 | 10-14 | 14:00 | SENSEX | CE | 72900 | 2026-10-15 | 257.35 | owner S/R | 72,836 | 13:55–14:00 close | WRITE | 46.7 | 210.7 / 350.7 | 11.0 | 42.0 | ✓ | ✓ | – | – | 14:06 | 210.68 | STOP | -997 | FAILED 14:05 | TRANSITION |
| 75 | 10-15 | 09:40 | NIFTY | CE | 22750 | after data | 136.25 | ORB high | 22,751 | 09:35–09:40 close | WRITE | 18.2 | 118.1 / 172.6 | 33.8 | 11.7 | ✓ | ✓ | ✓ | ✓ | 09:54 | 172.63 | TARGET | 2,613 | FAILED 09:45 | UNKNOWN_DATA |
| 76 | 10-15 | 09:40 | SENSEX | CE | 73300 | 2026-10-15 (expiry day) | 214.50 | ORB high | 73,263 | 09:35–09:40 close | WRITE | 51.1 | 163.4 / 316.7 | 82.8 | 32.9 | ✓ | ✓ | ✓ | ✓ | 09:54 | 316.73 | TARGET | 1,978 | HELD | UNKNOWN_DATA |
| 77 | 10-15 | 09:55 | NIFTY | CE | 22850 | after data | 123.30 | PDH | 22,756 | 09:50–09:55 close | WRITE | 18.0 | 105.3 / 159.3 | 35.8 | 6.8 | ✓ | ✓ | ✓ | ✓ | 10:15 | 159.30 | TARGET | 2,585 | HELD | TRENDING_UP |
| 78 | 10-16 | 09:40 | NIFTY | PE | 22950 | after data | 143.50 | ORB low | 22,948 | 09:35–09:40 close | WRITE | 21.6 | 121.9 / 186.7 | 0.0 | 0.0 | – | – | – | – | 09:41 | 121.92 | STOP | -1,733 | FAILED 09:45 | UNKNOWN_DATA |
| 79 | 10-16 | 09:40 | SENSEX | PE | 74100 | 2026-10-22 | 581.90 | ORB low | 74,109 | 09:35–09:40 close | WRITE | 64.2 | 517.7 / 710.3 | 0.2 | 60.9 | – | – | – | – | 09:43 | 517.73 | STOP | -1,378 | FAILED 09:45 | UNKNOWN_DATA |
| 80 | 10-16 | 09:50 | NIFTY | CE | 22950 | after data | 104.30 | ORB low | 22,948 | 09:45–09:50 close | WRITE | 21.0 | 83.3 / 146.3 | 35.3 | 4.5 | ✓ | ✓ | ✓ | ✓ | 10:01 | 146.33 | TARGET | 3,038 | HELD | TRANSITION |
| 81 | 10-16 | 09:50 | SENSEX | CE | 74200 | 2026-10-22 | 482.45 | ORB low | 74,109 | 09:45–09:50 close | WRITE | 68.4 | 414.0 / 619.3 | 131.7 | 16.1 | ✓ | ✓ | ✓ | ✓ | 10:02 | 619.28 | TARGET | 2,642 | HELD | TRANSITION |
| 82 | 10-16 | 10:05 | SENSEX | CE | 74500 | 2026-10-22 | 499.15 | PDH | 74,323 | 10:00–10:05 close | WRITE | 53.0 | 446.2 / 605.1 | 73.6 | 29.0 | ✓ | ✓ | ✓ | ✓ | 10:18 | 605.12 | TARGET | 2,024 | HELD | TRANSITION |
| 83 | 10-16 | 10:10 | SENSEX | CE | 74500 | 2026-10-22 | 486.55 | ORB high | 74,410 | 10:05–10:10 close | WRITE | 52.3 | 434.3 / 591.1 | 86.2 | 5.5 | ✓ | ✓ | ✓ | ✓ | 10:18 | 591.08 | TARGET | 1,997 | HELD | TRANSITION |
| 84 | 10-16 | 10:15 | NIFTY | CE | 23100 | after data | 98.70 | PDH | 23,053 | 10:10–10:15 close | WRITE | 13.0 | 85.7 / 124.8 | 25.5 | 4.8 | ✓ | ✓ | ✓ | ✓ | 10:20 | 124.76 | TARGET | 1,840 | HELD | TRANSITION |
| 85 | 10-19 | 09:40 | NIFTY | CE | 23150 | after data | 67.35 | owner S/R | 23,053 | 09:35–09:40 close | WRITE | 31.1 | 36.2 / 129.6 | 7.7 | 27.1 | ✓ | – | – | – | 09:57 | 36.22 | STOP | -2,449 | FAILED 10:00 | UNKNOWN_DATA |
| 86 | 10-19 | 09:55 | NIFTY | PE | 23100 | after data | 64.35 | owner S/R | 23,139 | 09:50–09:55 close | WRITE | 46.1 | 18.2 / 156.6 | 59.0 | 12.7 | ✓ | ✓ | ✓ | ✓ | 10:55 | 95.30 | TIME | 2,206 | HELD | TRANSITION |
| 87 | 10-19 | 09:55 | SENSEX | PE | 74600 | 2026-10-22 | 436.70 | PDC | 74,729 | 09:50–09:55 close | WRITE | 126.6 | 310.1 / 690.0 | 188.3 | 25.0 | ✓ | ✓ | ✓ | ✓ | 10:55 | 557.05 | TIME | 2,317 | HELD | TRANSITION |
| 88 | 10-19 | 10:05 | SENSEX | PE | 74500 | 2026-10-22 | 468.40 | owner S/R | 74,512 | 10:00–10:05 close | WRITE | 126.5 | 341.9 / 721.5 | 93.6 | 103.8 | ✓ | ✓ | ✓ | ✓ | 11:05 | 466.70 | TIME | -121 | FAILED 10:25 | TRANSITION |
| 89 | 10-19 | 11:40 | NIFTY | PE | 23000 | after data | 71.45 | owner S/R | 23,053 | 11:35–11:40 close | WRITE | 13.2 | 58.3 / 97.8 | 7.1 | 12.7 | ✓ | – | – | – | 11:45 | 58.26 | STOP | -1,104 | HELD | TRANSITION |
| 90 | 10-19 | 12:05 | SENSEX | PE | 74100 | 2026-10-22 | 465.30 | ORB low | 74,198 | 12:00–12:05 close | WRITE | 43.5 | 421.8 / 552.2 | 29.5 | 25.3 | ✓ | ✓ | ✓ | ✓ | 12:08 | 421.83 | STOP | -954 | HELD | TRANSITION |
| 91 | 10-19 | 12:10 | NIFTY | PE | 22950 | after data | 58.70 | ORB low | 22,978 | 12:05–12:10 close | WRITE | 12.2 | 46.5 / 83.1 | 24.1 | 10.9 | ✓ | ✓ | ✓ | ✓ | 13:10 | 66.40 | TIME | 463 | HELD | TRANSITION |
| 92 | 10-19 | 12:25 | SENSEX | PE | 74000 | 2026-10-22 | 431.50 | PDL | 74,024 | 12:20–12:25 close | WRITE | 46.2 | 385.3 / 524.0 | 32.6 | 35.3 | ✓ | ✓ | ✓ | ✓ | 13:04 | 385.25 | STOP | -1,006 | FAILED 12:35 | TRENDING_DOWN |
| 93 | 10-19 | 12:40 | SENSEX | CE | 74000 | 2026-10-22 | 401.45 | PDL | 74,024 | 12:35–12:40 close | WRITE | 43.0 | 358.5 / 487.4 | 5.8 | 30.6 | ✓ | – | – | – | 12:55 | 358.47 | STOP | -938 | FAILED 12:45 | TRENDING_DOWN |
| 94 | 10-19 | 13:25 | NIFTY | PE | 22850 | after data | 44.70 | PDL | 22,918 | 13:20–13:25 close | WRITE | 7.9 | 36.8 / 60.4 | 1.0 | 7.5 | – | – | – | – | 13:27 | 36.84 | STOP | -705 | HELD | TRENDING_DOWN |
| 95 | 10-21 | 09:40 | NIFTY | CE | 23100 | after data | 184.40 | ORB high | 23,085 | 09:35–09:40 close | WRITE | 20.1 | 164.3 / 224.5 | 1.4 | 17.0 | – | – | – | – | 09:47 | 164.34 | STOP | -1,620 | FAILED 09:50 | UNKNOWN_DATA |
| 96 | 10-21 | 09:40 | SENSEX | CE | 74700 | 2026-10-22 | 330.00 | ORB high | 74,527 | 09:35–09:40 close | WRITE | 54.9 | 275.1 / 439.8 | 7.4 | 51.2 | ✓ | – | – | – | 09:47 | 275.13 | STOP | -1,168 | FAILED 09:50 | UNKNOWN_DATA |
| 97 | 10-21 | 09:50 | NIFTY | PE | 23050 | after data | 159.15 | owner S/R | 23,103 | 09:45–09:50 close | WRITE | 16.9 | 142.2 / 193.0 | 33.5 | 1.1 | ✓ | ✓ | ✓ | ✓ | 10:06 | 193.05 | TARGET | 2,427 | HELD | TRENDING_UP |
| 98 | 10-21 | 09:55 | NIFTY | PE | 23050 | after data | 169.75 | ORB high | 23,085 | 09:50–09:55 close | WRITE | 17.0 | 152.8 / 203.7 | 22.9 | 10.1 | ✓ | ✓ | ✓ | ✓ | 10:06 | 203.71 | TARGET | 2,431 | HELD | TRENDING_UP |
| 99 | 10-21 | 09:55 | SENSEX | PE | 74400 | 2026-10-22 | 326.10 | ORB high | 74,527 | 09:50–09:55 close | WRITE | 53.6 | 272.5 / 433.4 | 71.8 | 28.4 | ✓ | ✓ | ✓ | ✓ | 10:06 | 433.39 | TARGET | 2,068 | HELD | TRENDING_UP |
| 100 | 10-21 | 10:00 | NIFTY | PE | 23000 | after data | 148.75 | owner S/R | 23,053 | 09:55–10:00 close | WRITE | 15.7 | 133.1 / 180.1 | 30.3 | 8.6 | ✓ | ✓ | ✓ | ✓ | 10:08 | 180.05 | TARGET | 2,233 | HELD | TRENDING_UP |
| 101 | 10-21 | 10:10 | SENSEX | PE | 74200 | 2026-10-22 | 334.10 | ORB low | 74,331 | 10:05–10:10 close | WRITE | 47.2 | 286.9 / 428.5 | 94.3 | 35.2 | ✓ | ✓ | ✓ | ✓ | 10:35 | 286.90 | STOP | -1,015 | HELD | TRENDING_UP |
| 102 | 10-21 | 10:15 | NIFTY | PE | 22950 | after data | 166.35 | owner S/R | 22,978 | 10:10–10:15 close | WRITE | 17.3 | 149.1 / 200.9 | 10.1 | 15.4 | ✓ | ✓ | – | – | 10:34 | 149.08 | STOP | -1,410 | FAILED 10:35 | TRANSITION |
| 103 | 10-21 | 11:30 | NIFTY | PE | 22900 | after data | 173.85 | PDC | 22,889 | 11:25–11:30 close | WRITE | 18.1 | 155.7 / 210.1 | 25.2 | 3.2 | ✓ | ✓ | ✓ | ✓ | 11:41 | 210.14 | TARGET | 2,605 | HELD | TRANSITION |
| 104 | 10-21 | 11:40 | SENSEX | PE | 73800 | 2026-10-22 | 351.60 | owner S/R | 73,900 | 11:35–11:40 close | WRITE | 44.6 | 307.0 / 440.8 | 78.3 | 3.2 | ✓ | ✓ | ✓ | ✓ | 12:10 | 440.75 | TARGET | 1,703 | HELD | TRANSITION |
| 105 | 10-21 | 11:45 | NIFTY | PE | 22850 | after data | 183.55 | PDL | 22,848 | 11:40–11:45 close | WRITE | 16.9 | 166.7 / 217.3 | 30.3 | 9.6 | ✓ | ✓ | ✓ | ✓ | 12:14 | 217.26 | TARGET | 2,410 | HELD | TRANSITION |
| 106 | 10-21 | 11:45 | SENSEX | PE | 73800 | 2026-10-22 | 386.00 | PDC | 73,853 | 11:40–11:45 close | WRITE | 47.7 | 338.3 / 481.4 | 83.3 | 36.6 | ✓ | ✓ | ✓ | ✓ | 12:13 | 481.38 | TARGET | 1,824 | HELD | TRANSITION |
| 107 | 10-22 | 09:45 | SENSEX | CE | 73300 | 2026-10-22 (expiry day) | 285.15 | ORB low | 73,060 | 09:40–09:45 close | WRITE | 90.0 | 195.2 / 465.1 | 47.4 | 73.2 | ✓ | ✓ | ✓ | ✓ | 10:03 | 195.16 | STOP | -1,864 | HELD | CHOPPY |
| 108 | 10-22 | 09:50 | NIFTY | CE | 22650 | after data | 172.10 | ORB high | 22,627 | 09:45–09:50 close | WRITE | 27.2 | 144.9 / 226.6 | 18.4 | 20.9 | ✓ | ✓ | ✓ | – | 10:04 | 144.86 | STOP | -2,158 | FAILED 10:05 | CHOPPY |
| 109 | 10-22 | 10:10 | NIFTY | PE | 22600 | after data | 148.95 | ORB high | 22,627 | 10:05–10:10 close | WRITE | 27.9 | 121.1 / 204.7 | 0.5 | 15.3 | – | – | – | – | 10:13 | 121.08 | STOP | -2,205 | FAILED 10:15 | CHOPPY |
| 110 | 10-22 | 10:10 | SENSEX | PE | 73200 | 2026-10-22 (expiry day) | 265.65 | PDL | 73,251 | 10:05–10:10 close | WRITE | 83.4 | 182.2 / 432.5 | 2.1 | 82.6 | – | – | – | – | 10:16 | 182.24 | STOP | -1,731 | FAILED 10:15 | CHOPPY |
| 111 | 10-22 | 10:20 | NIFTY | CE | 22650 | after data | 173.85 | PDL | 22,659 | 10:15–10:20 close | WRITE | 26.6 | 147.2 / 227.1 | 44.0 | 0.0 | ✓ | ✓ | ✓ | ✓ | 10:24 | 227.07 | TARGET | 3,871 | HELD | CHOPPY |
| 112 | 10-22 | 10:20 | SENSEX | CE | 73300 | 2026-10-22 (expiry day) | 238.75 | PDL | 73,251 | 10:15–10:20 close | WRITE | 85.2 | 153.6 / 409.1 | 128.2 | 2.4 | ✓ | ✓ | ✓ | ✓ | 10:24 | 409.13 | TARGET | 3,335 | HELD | CHOPPY |
| 113 | 10-22 | 10:40 | NIFTY | CE | 22750 | after data | 172.25 | owner S/R | 22,741 | 10:35–10:40 close | WRITE | 22.4 | 149.8 / 217.1 | 3.4 | 20.2 | – | – | – | – | 10:46 | 149.83 | STOP | -1,796 | FAILED 10:45 | TRANSITION |
| 114 | 10-22 | 11:55 | NIFTY | PE | 22650 | after data | 163.05 | PDL | 22,659 | 11:50–11:55 close | WRITE | 17.0 | 146.0 / 197.1 | 19.5 | 12.6 | ✓ | ✓ | ✓ | – | 12:28 | 146.01 | STOP | -1,393 | HELD | TRANSITION |
| 115 | 10-22 | 12:25 | SENSEX | PE | 73100 | 2026-10-22 (expiry day) | 181.80 | owner S/R | 73,151 | 12:20–12:25 close | WRITE | 46.9 | 134.9 / 275.6 | 3.5 | 28.1 | – | – | – | – | 12:27 | 134.93 | STOP | -997 | FAILED 12:30 | TRANSITION |
| 116 | 10-23 | 09:40 | NIFTY | PE | 22700 | after data | 136.05 | PDC | 22,688 | 09:35–09:40 close | WRITE | 20.9 | 115.2 / 177.8 | 39.3 | 19.1 | ✓ | ✓ | ✓ | ✓ | 10:00 | 177.83 | TARGET | 3,018 | FAILED 09:45 | UNKNOWN_DATA |
| 117 | 10-23 | 09:40 | SENSEX | PE | 73400 | after data | 537.50 | ORB low | 73,519 | 09:35–09:40 close | WRITE | 59.6 | 477.9 / 656.7 | 117.0 | 58.9 | ✓ | ✓ | ✓ | ✓ | 10:00 | 656.73 | TARGET | 2,285 | HELD | UNKNOWN_DATA |
| 118 | 10-23 | 10:05 | SENSEX | PE | 73100 | after data | 581.65 | PDC | 73,249 | 10:00–10:05 close | WRITE | 54.5 | 527.2 / 690.6 | 97.9 | 33.2 | ✓ | ✓ | ✓ | ✓ | 10:15 | 690.61 | TARGET | 2,076 | HELD | CHOPPY |
| 119 | 10-23 | 10:15 | NIFTY | PE | 22500 | after data | 128.95 | PDL | 22,560 | 10:10–10:15 close | WRITE | 16.7 | 112.2 / 162.4 | 30.3 | 5.0 | ✓ | ✓ | ✓ | ✓ | 10:59 | 162.38 | TARGET | 2,393 | HELD | TRANSITION |
| 120 | 10-23 | 10:15 | SENSEX | PE | 72900 | after data | 580.70 | PDL | 73,027 | 10:10–10:15 close | WRITE | 70.6 | 510.1 / 721.9 | 105.0 | 17.0 | ✓ | ✓ | ✓ | ✓ | 10:59 | 721.87 | TARGET | 2,718 | HELD | TRANSITION |
| 121 | 10-23 | 13:50 | SENSEX | CE | 73000 | after data | 836.00 | PDL | 73,027 | 13:45–13:50 close | WRITE | 60.6 | 775.4 / 957.2 | 2.9 | 44.8 | – | – | – | – | 13:53 | 775.42 | STOP | -1,332 | FAILED 13:55 | TRANSITION |

## A2. Every losing trade (net ≤ 0 under X0) — exact date / time, evidence-based classification, and whether an earlier exit was possible in real time

| # | Date | Entry | Index · side | Level | Exit (X0) | Net ₹ | Peak before exit | Classification (evidence) | Earlier exit possible in real time? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 10-01 | 10:05 | SENSEX CE | PDL 72,378 | 10:11 STOP | -1,020 | +₹18.4 | Gave back profit — premium was +₹18.4 before reversing | No — no completed-candle signal before the stop |
| 2 | 10-01 | 10:10 | NIFTY CE | ORB high 22,582 | 11:09 STOP | -1,348 | +₹14.4 | Failed breakout — index 5-min close back through ORB high 22,582 at 10:15 | Thesis exit at 10:15 (index 5-min close back through the level — knowable then): ₹-377 vs ₹-1,348 → smaller loss |
| 3 | 10-01 | 10:10 | SENSEX CE | PDC 72,480 | 11:09 STOP | -1,044 | +₹39.6 | Failed breakout — index 5-min close back through PDC 72,480 at 10:15 | Thesis exit at 10:15 (index 5-min close back through the level — knowable then): ₹-190 vs ₹-1,044 → smaller loss |
| 4 | 10-01 | 10:20 | NIFTY PE | ORB high 22,582 | 10:37 STOP | -1,309 | +₹9.3 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 6 | 10-01 | 11:10 | SENSEX PE | ORB high 72,410 | 11:18 STOP | -631 | +₹3.0 | Premium stop inside noise — stopped at 11:18 while the index was still beyond the level (stop ₹28.6) | No — no completed-candle signal before the stop |
| 7 | 10-01 | 11:15 | SENSEX PE | PDL 72,378 | 11:38 STOP | -752 | +₹38.4 | Failed breakout — index 5-min close back through PDL 72,378 at 11:20 | Thesis exit at 11:20 (index 5-min close back through the level — knowable then): ₹-314 vs ₹-752 → smaller loss · Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 10 | 10-05 | 09:40 | SENSEX CE | ORB high 72,428 | 10:01 STOP | -1,025 | +₹55.0 | Gave back profit — premium was +₹55.0 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-73 → better |
| 11 | 10-05 | 09:55 | SENSEX CE | PDH 72,559 | 10:00 STOP | -921 | +₹17.4 | Failed breakout — index 5-min close back through PDH 72,559 at 10:00 | No — no completed-candle signal before the stop |
| 17 | 10-05 | 11:35 | SENSEX CE | owner S/R 72,087 | 11:40 STOP | -969 | +₹0.3 | Premium stop inside noise — stopped at 11:40 while the index was still beyond the level (stop ₹43.9) | No — no completed-candle signal before the stop |
| 18 | 10-05 | 12:15 | SENSEX PE | PDC 71,910 | 12:24 STOP | -994 | +₹6.9 | Failed breakout — index 5-min close back through PDC 71,910 at 12:20 | Thesis exit at 12:20 (index 5-min close back through the level — knowable then): ₹-290 vs ₹-994 → smaller loss |
| 21 | 10-05 | 13:30 | SENSEX PE | owner S/R 72,087 | 13:37 STOP | -937 | +₹9.9 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 22 | 10-05 | 13:50 | NIFTY CE | ORB low 22,517 | 14:05 STOP | -1,003 | +₹12.5 | Gave back profit — premium was +₹12.5 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 23 | 10-05 | 13:50 | SENSEX CE | ORB low 72,260 | 14:05 STOP | -894 | +₹40.0 | Failed breakout — index 5-min close back through ORB low 72,260 at 14:05 | No — no completed-candle signal before the stop |
| 26 | 10-06 | 09:55 | NIFTY CE | PDH 22,617 | 10:10 STOP | -795 | +₹14.1 | Gave back profit — premium was +₹14.1 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 27 | 10-06 | 09:55 | SENSEX CE | PDH 72,626 | 10:10 STOP | -754 | +₹40.0 | Failed breakout — index 5-min close back through PDH 72,626 at 10:10 | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-60 → better |
| 28 | 10-06 | 10:45 | NIFTY CE | owner S/R 22,663 | 10:53 STOP | -717 | +₹1.0 | Premium stop inside noise — stopped at 10:53 while the index was still beyond the level (stop ₹8.0) | No — no completed-candle signal before the stop |
| 29 | 10-06 | 12:45 | SENSEX CE | owner S/R 72,877 | 12:52 STOP | -614 | +₹11.6 | Gave back profit — premium was +₹11.6 before reversing | No — no completed-candle signal before the stop |
| 30 | 10-06 | 14:35 | SENSEX PE | owner S/R 72,877 | 14:41 STOP | -580 | +₹14.1 | Failed breakout — index 5-min close back through owner S/R 72,877 at 14:40 | Thesis exit at 14:40 (index 5-min close back through the level — knowable then): ₹-464 vs ₹-580 → smaller loss |
| 31 | 10-07 | 09:50 | SENSEX CE | ORB low 72,599 | 10:03 STOP | -892 | +₹23.6 | Gave back profit — premium was +₹23.6 before reversing | No — no completed-candle signal before the stop |
| 32 | 10-07 | 10:25 | NIFTY CE | ORB high 22,627 | 10:37 STOP | -1,215 | +₹23.6 | Gave back profit — premium was +₹23.6 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 34 | 10-07 | 10:30 | NIFTY CE | owner S/R 22,665 | 10:35 STOP | -1,138 | +₹1.4 | Failed breakout — index 5-min close back through owner S/R 22,665 at 10:35 | No — no completed-candle signal before the stop |
| 35 | 10-07 | 10:40 | NIFTY PE | owner S/R 22,665 | 10:55 STOP | -1,488 | +₹1.6 | Failed breakout — index 5-min close back through owner S/R 22,665 at 10:55 | No — no completed-candle signal before the stop |
| 37 | 10-07 | 13:15 | NIFTY PE | ORB low 22,610 | 13:30 STOP | -1,124 | +₹7.6 | Premium stop inside noise — stopped at 13:30 while the index was still beyond the level (stop ₹13.5) | No — no completed-candle signal before the stop |
| 38 | 10-07 | 13:15 | SENSEX PE | ORB high 72,667 | 13:30 STOP | -818 | +₹22.5 | Gave back profit — premium was +₹22.5 before reversing | No — no completed-candle signal before the stop |
| 39 | 10-07 | 14:15 | NIFTY PE | PDL 22,569 | 14:19 STOP | -1,153 | +₹0.5 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 40 | 10-08 | 09:50 | NIFTY PE | ORB low 22,481 | 10:50 TIME | -175 | +₹23.8 | Failed breakout — index 5-min close back through ORB low 22,481 at 10:05 | Thesis exit at 10:05 (index 5-min close back through the level — knowable then): ₹-569 vs ₹-175 → LARGER loss · Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 41 | 10-08 | 09:50 | SENSEX PE | ORB low 72,278 | 10:13 STOP | -945 | +₹13.4 | Failed breakout — index 5-min close back through ORB low 72,278 at 10:00 | Thesis exit at 10:00 (index 5-min close back through the level — knowable then): ₹-230 vs ₹-945 → smaller loss |
| 42 | 10-08 | 10:40 | SENSEX PE | owner S/R 72,238 | 10:44 STOP | -639 | +₹10.3 | Gave back profit — premium was +₹10.3 before reversing | No — no completed-candle signal before the stop |
| 46 | 10-09 | 11:25 | NIFTY CE | owner S/R 22,517 | 11:35 STOP | -1,130 | +₹3.6 | Failed breakout — index 5-min close back through owner S/R 22,517 at 11:30 | Thesis exit at 11:30 (index 5-min close back through the level — knowable then): ₹-576 vs ₹-1,130 → smaller loss |
| 49 | 10-09 | 13:50 | SENSEX CE | owner S/R 72,485 | 13:55 STOP | -682 | +₹7.5 | Failed breakout — index 5-min close back through owner S/R 72,485 at 13:55 | No — no completed-candle signal before the stop |
| 52 | 10-09 | 14:25 | NIFTY CE | owner S/R 22,552 | 14:41 STOP | -1,017 | +₹4.8 | Failed breakout — index 5-min close back through owner S/R 22,552 at 14:30 | Thesis exit at 14:30 (index 5-min close back through the level — knowable then): ₹-505 vs ₹-1,017 → smaller loss |
| 61 | 10-13 | 09:55 | NIFTY CE | owner S/R 22,552 | 10:19 STOP | -1,086 | +₹5.9 | Premium stop inside noise — stopped at 10:19 while the index was still beyond the level (stop ₹12.9) | No — no completed-candle signal before the stop |
| 62 | 10-13 | 09:55 | SENSEX CE | owner S/R 72,489 | 10:20 STOP | -1,059 | +₹16.5 | Gave back profit — premium was +₹16.5 before reversing | No — no completed-candle signal before the stop |
| 64 | 10-13 | 13:05 | SENSEX PE | owner S/R 72,489 | 13:11 STOP | -595 | +₹3.4 | Failed breakout — index 5-min close back through owner S/R 72,489 at 13:10 | Thesis exit at 13:10 (index 5-min close back through the level — knowable then): ₹-472 vs ₹-595 → smaller loss |
| 65 | 10-14 | 09:50 | NIFTY CE | PDH 22,722 | 10:08 STOP | -2,017 | +₹10.2 | Failed breakout — index 5-min close back through PDH 22,722 at 09:55 | Thesis exit at 09:55 (index 5-min close back through the level — knowable then): ₹-1,386 vs ₹-2,017 → smaller loss |
| 66 | 10-14 | 09:50 | SENSEX CE | PDH 73,036 | 10:08 STOP | -1,423 | +₹25.8 | Failed breakout — index 5-min close back through PDH 73,036 at 09:55 | Thesis exit at 09:55 (index 5-min close back through the level — knowable then): ₹-958 vs ₹-1,423 → smaller loss |
| 67 | 10-14 | 10:00 | NIFTY PE | PDH 22,722 | 11:00 STOP | -1,586 | +₹17.8 | Gave back profit — premium was +₹17.8 before reversing | Thesis exit at 10:45 (index 5-min close back through the level — knowable then): ₹-1,041 vs ₹-1,586 → smaller loss |
| 70 | 10-14 | 13:10 | NIFTY PE | owner S/R 22,643 | 13:30 STOP | -1,045 | +₹16.4 | Gave back profit — premium was +₹16.4 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 71 | 10-14 | 13:10 | SENSEX PE | ORB low 72,907 | 13:29 STOP | -952 | +₹57.6 | Gave back profit — premium was +₹57.6 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-59 → better |
| 73 | 10-14 | 14:00 | NIFTY CE | owner S/R 22,643 | 14:08 STOP | -1,270 | +₹3.6 | Failed breakout — index 5-min close back through owner S/R 22,643 at 14:05 | Thesis exit at 14:05 (index 5-min close back through the level — knowable then): ₹-880 vs ₹-1,270 → smaller loss |
| 74 | 10-14 | 14:00 | SENSEX CE | owner S/R 72,836 | 14:06 STOP | -997 | +₹11.0 | Failed breakout — index 5-min close back through owner S/R 72,836 at 14:05 | Thesis exit at 14:05 (index 5-min close back through the level — knowable then): ₹-803 vs ₹-997 → smaller loss |
| 78 | 10-16 | 09:40 | NIFTY PE | ORB low 22,948 | 09:41 STOP | -1,733 | +₹0.0 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 79 | 10-16 | 09:40 | SENSEX PE | ORB low 74,109 | 09:43 STOP | -1,378 | +₹0.2 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 85 | 10-19 | 09:40 | NIFTY CE | owner S/R 23,053 | 09:57 STOP | -2,449 | +₹7.7 | Premium stop inside noise — stopped at 09:57 while the index was still beyond the level (stop ₹31.1) | No — no completed-candle signal before the stop |
| 88 | 10-19 | 10:05 | SENSEX PE | owner S/R 74,512 | 11:05 TIME | -121 | +₹93.6 | Failed breakout — index 5-min close back through owner S/R 74,512 at 10:25 | Thesis exit at 10:25 (index 5-min close back through the level — knowable then): ₹-1,010 vs ₹-121 → LARGER loss |
| 89 | 10-19 | 11:40 | NIFTY PE | owner S/R 23,053 | 11:45 STOP | -1,104 | +₹7.1 | Premium stop inside noise — stopped at 11:45 while the index was still beyond the level (stop ₹13.2) | No — no completed-candle signal before the stop |
| 90 | 10-19 | 12:05 | SENSEX PE | ORB low 74,198 | 12:08 STOP | -954 | +₹29.5 | Gave back profit — premium was +₹29.5 before reversing | No — no completed-candle signal before the stop |
| 92 | 10-19 | 12:25 | SENSEX PE | PDL 74,024 | 13:04 STOP | -1,006 | +₹32.6 | Failed breakout — index 5-min close back through PDL 74,024 at 12:35 | Thesis exit at 12:35 (index 5-min close back through the level — knowable then): ₹-512 vs ₹-1,006 → smaller loss |
| 93 | 10-19 | 12:40 | SENSEX CE | PDL 74,024 | 12:55 STOP | -938 | +₹5.8 | Failed breakout — index 5-min close back through PDL 74,024 at 12:45 | Thesis exit at 12:45 (index 5-min close back through the level — knowable then): ₹-477 vs ₹-938 → smaller loss |
| 94 | 10-19 | 13:25 | NIFTY PE | PDL 22,918 | 13:27 STOP | -705 | +₹1.0 | Premium stop inside noise — stopped at 13:27 while the index was still beyond the level (stop ₹7.9) | No — no completed-candle signal before the stop |
| 95 | 10-21 | 09:40 | NIFTY CE | ORB high 23,085 | 09:47 STOP | -1,620 | +₹1.4 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 96 | 10-21 | 09:40 | SENSEX CE | ORB high 74,527 | 09:47 STOP | -1,168 | +₹7.4 | Premium stop inside noise — stopped at 09:47 while the index was still beyond the level (stop ₹54.9) | No — no completed-candle signal before the stop |
| 101 | 10-21 | 10:10 | SENSEX PE | ORB low 74,331 | 10:35 STOP | -1,015 | +₹94.3 | Gave back profit — premium was +₹94.3 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-53 → better |
| 102 | 10-21 | 10:15 | NIFTY PE | owner S/R 22,978 | 10:34 STOP | -1,410 | +₹10.1 | Gave back profit — premium was +₹10.1 before reversing | No — no completed-candle signal before the stop |
| 107 | 10-22 | 09:45 | SENSEX CE | ORB low 73,060 | 10:03 STOP | -1,864 | +₹47.4 | Gave back profit — premium was +₹47.4 before reversing | No — no completed-candle signal before the stop |
| 108 | 10-22 | 09:50 | NIFTY CE | ORB high 22,627 | 10:04 STOP | -2,158 | +₹18.4 | Gave back profit — premium was +₹18.4 before reversing | No — no completed-candle signal before the stop |
| 109 | 10-22 | 10:10 | NIFTY PE | ORB high 22,627 | 10:13 STOP | -2,205 | +₹0.5 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 110 | 10-22 | 10:10 | SENSEX PE | PDL 73,251 | 10:16 STOP | -1,731 | +₹2.1 | Failed breakout — index 5-min close back through PDL 73,251 at 10:15 | Thesis exit at 10:15 (index 5-min close back through the level — knowable then): ₹-1,470 vs ₹-1,731 → smaller loss |
| 113 | 10-22 | 10:40 | NIFTY CE | owner S/R 22,741 | 10:46 STOP | -1,796 | +₹3.4 | Failed breakout — index 5-min close back through owner S/R 22,741 at 10:45 | Thesis exit at 10:45 (index 5-min close back through the level — knowable then): ₹-1,465 vs ₹-1,796 → smaller loss |
| 114 | 10-22 | 11:55 | NIFTY PE | PDL 22,659 | 12:28 STOP | -1,393 | +₹19.5 | Gave back profit — premium was +₹19.5 before reversing | Breakeven lock (after +1×SL0, decided at a 5-min close): ₹-40 → better |
| 115 | 10-22 | 12:25 | SENSEX PE | owner S/R 73,151 | 12:27 STOP | -997 | +₹3.5 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |
| 121 | 10-23 | 13:50 | SENSEX CE | PDL 73,027 | 13:53 STOP | -1,332 | +₹2.9 | Reversal — index moved back towards / through the level and the stop was hit | No — no completed-candle signal before the stop |

Loss classification counts: Gave back profit: 19 · Failed breakout: 25 · Reversal: 9 · Premium stop inside noise: 9

## B. Exit-model comparison on the SAME 121 entries (win = net > 0 after costs; ₹ per lot)

| Exit model | Trades | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Conservative / trade ₹ | PF | Max DD ₹ | Reached +5 / +10 / +15 / +20 % | Profit (≥ +₹10) turned into loss % | Profit surrendered / trade ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| X0 baseline (SL0 / 2×SL0 / 60 min) | 121 | 48.8 | 1,925 | -1,126 | 55,509 | 43,743 | 362 | 236 | 1.63 | 10,680 | 84 / 76 / 68 / 59 | 27.3 | 901 |
| X4 baseline + thesis exit | 121 | 46.3 | 1,861 | -995 | 51,298 | 39,533 | 327 | 207 | 1.61 | 10,972 | 79 / 69 / 62 / 53 | 24.0 | 821 |
| Baseline + breakeven lock after +1×SL0 | 121 | 40.5 | 1,991 | -844 | 48,572 | 36,816 | 304 | 176 | 1.61 | 10,207 | 84 / 76 / 66 / 58 | 35.5 | 919 |
| Fixed take-profit +₹5 | 121 | 82.6 | 126 | -1,124 | 636 | -11,044 | -91 | -188 | 0.53 | 12,124 | 0 / 0 / 0 / 0 | 0.0 | 196 |
| Fixed take-profit +₹10 | 121 | 76.0 | 338 | -1,221 | 7,381 | -4,299 | -36 | -136 | 0.88 | 8,016 | 40 / 0 / 0 / 0 | 0.0 | 315 |
| Fixed take-profit +₹15 | 121 | 67.8 | 546 | -1,173 | 10,744 | -939 | -8 | -118 | 0.98 | 6,513 | 61 / 39 / 0 / 0 | 8.3 | 441 |
| Fixed take-profit +₹20 | 121 | 62.0 | 745 | -1,194 | 12,601 | 915 | 8 | -108 | 1.02 | 8,561 | 69 / 55 / 36 / 0 | 14.0 | 564 |
| Simple trailing stop (SL0 from the high) | 121 | 43.8 | 1,376 | -780 | 31,597 | 19,873 | 164 | 5 | 1.37 | 8,857 | 82 / 71 / 60 / 54 | 27.3 | 1,130 |
| Adaptive 3-plan, minimum ₹5 | 121 | 52.1 | 746 | -653 | 20,838 | 9,135 | 75 | -34 | 1.24 | 6,607 | 55 / 47 / 37 / 31 | 15.7 | 573 |
| Adaptive 3-plan, minimum ₹10 | 121 | 48.8 | 863 | -661 | 21,686 | 9,981 | 82 | -34 | 1.24 | 7,827 | 64 / 47 / 37 / 31 | 16.5 | 605 |
| Adaptive 3-plan, minimum ₹15 | 121 | 46.3 | 971 | -677 | 22,071 | 10,366 | 86 | -39 | 1.24 | 8,420 | 72 / 55 / 37 / 31 | 19.0 | 638 |
| Adaptive 3-plan, minimum ₹20 | 121 | 44.6 | 1,074 | -663 | 25,234 | 13,528 | 112 | -16 | 1.30 | 7,428 | 74 / 60 / 49 / 31 | 20.7 | 650 |

## C. Where the adaptive exit (minimum ₹10) helps and hurts vs the baseline (same entries)

- Better on 54 trades (total +₹47,271), worse on 47 (total −₹81,033), equal on 20.
- Adaptive exit reasons: stop 37 · P? objective 35 · P? protect profit 15 · trailing/locked stop 14 · P? book minimum profit 10 · P? thesis invalid: index back through level 9 · P? deteriorating (weak twice) 1
- Plan paths (entry plan → switches): P2→P3 43 · P2 37 · P3 31 · P2→P1→P3 3 · P2→P1→P2 3 · P2→P1 3 · P2→P1→P2→P3 1
- helps most: NIFTY 10-22 09:50 CE (P3 objective, +₹2,793) · NIFTY 10-14 09:50 CE (P3 objective, +₹2,652) · NIFTY 10-14 10:00 PE (P3 book minimum profit, +₹2,596) · NIFTY 10-07 10:25 CE (trailing/locked stop, +₹1,925) · SENSEX 10-21 10:10 PE (trailing/locked stop, +₹1,648) · SENSEX 10-14 09:50 CE (P3 objective, +₹1,555)
- hurts most: NIFTY 10-23 09:40 PE (stop, ₹-3,916) · NIFTY 10-15 09:40 CE (P2 thesis invalid: index back through level, ₹-3,512) · NIFTY 10-22 10:20 CE (P3 objective, ₹-3,236) · NIFTY 10-21 09:55 PE (stop, ₹-3,183) · SENSEX 10-23 10:05 PE (stop, ₹-2,717) · SENSEX 10-15 09:40 CE (P3 protect profit, ₹-2,619)

## D. By index

| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |
|---|---|---|---|---|---|---|---|
| NIFTY | 56 | 50.0 | 419 | 50.0 | 171 | 35 | 276 |
| SENSEX | 65 | 47.7 | 312 | 47.7 | 6 | -94 | 68 |

## D. By index and side

| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |
|---|---|---|---|---|---|---|---|
| NIFTY CE | 25 | 40.0 | 126 | 48.0 | 241 | 91 | 339 |
| NIFTY PE | 31 | 58.1 | 655 | 51.6 | 115 | -9 | 226 |
| SENSEX CE | 30 | 43.3 | 168 | 50.0 | 137 | 26 | 209 |
| SENSEX PE | 35 | 51.4 | 436 | 45.7 | -106 | -198 | -53 |

## D. By level type

| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |
|---|---|---|---|---|---|---|---|
| ORB high | 24 | 58.3 | 647 | 54.2 | 236 | 73 | 221 |
| ORB low | 22 | 45.5 | 326 | 59.1 | 87 | -22 | 324 |
| PDC | 11 | 81.8 | 1,119 | 45.5 | -12 | -99 | 872 |
| PDH | 13 | 53.8 | 346 | 84.6 | 639 | 551 | 286 |
| PDL | 15 | 40.0 | 390 | 40.0 | 158 | 46 | 268 |
| owner S/R | 36 | 36.1 | -45 | 30.6 | -226 | -339 | -275 |

## D. By time of day (breakout candle)

| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |
|---|---|---|---|---|---|---|---|
| 09:30–10:30 | 70 | 57.1 | 678 | 55.7 | 244 | 126 | 312 |
| 10:30–12:30 | 26 | 46.2 | 106 | 30.8 | -116 | -225 | 37 |
| 12:30–14:30 | 25 | 28.0 | -259 | 48.0 | -162 | -286 | -117 |

## D. By regime at entry (research detector, unvalidated)

| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |
|---|---|---|---|---|---|---|---|
| CHOPPY | 17 | 35.3 | -233 | 47.1 | 2 | -149 | -44 |
| COMPRESSION | 1 | 0.0 | -580 | 0.0 | -464 | -536 | -299 |
| TRANSITION | 56 | 50.0 | 392 | 53.6 | 90 | -23 | 336 |
| TRENDING_DOWN | 6 | 16.7 | -230 | 33.3 | -254 | -326 | -244 |
| TRENDING_UP | 23 | 52.2 | 510 | 52.2 | 265 | 170 | -1 |
| UNKNOWN_DATA | 18 | 66.7 | 888 | 38.9 | 45 | -100 | 199 |

## D. Expiry day vs other days

| Group | Trades | X0 win % | X0 net / trade ₹ | ADP10 win % | ADP10 net / trade ₹ | ADP10 conservative ₹ | TRL net / trade ₹ |
|---|---|---|---|---|---|---|---|
| expiry day | 19 | 36.8 | 18 | 42.1 | 175 | 110 | 21 |
| other day | 102 | 51.0 | 425 | 50.0 | 65 | -61 | 191 |

## E. Win rate vs expectancy trade-off (same entries)

| Exit model | Win % | Avg win ₹ | Avg loss ₹ | Win/loss size ratio | Net / trade ₹ | Max DD ₹ |
|---|---|---|---|---|---|---|
| X0 baseline (SL0 / 2×SL0 / 60 min) | 48.8 | 1,925 | -1,126 | 1.71 | 362 | 10,680 |
| X4 baseline + thesis exit | 46.3 | 1,861 | -995 | 1.87 | 327 | 10,972 |
| Baseline + breakeven lock after +1×SL0 | 40.5 | 1,991 | -844 | 2.36 | 304 | 10,207 |
| Fixed take-profit +₹5 | 82.6 | 126 | -1,124 | 0.11 | -91 | 12,124 |
| Fixed take-profit +₹10 | 76.0 | 338 | -1,221 | 0.28 | -36 | 8,016 |
| Fixed take-profit +₹15 | 67.8 | 546 | -1,173 | 0.47 | -8 | 6,513 |
| Fixed take-profit +₹20 | 62.0 | 745 | -1,194 | 0.62 | 8 | 8,561 |
| Simple trailing stop (SL0 from the high) | 43.8 | 1,376 | -780 | 1.76 | 164 | 8,857 |
| Adaptive 3-plan, minimum ₹5 | 52.1 | 746 | -653 | 1.14 | 75 | 6,607 |
| Adaptive 3-plan, minimum ₹10 | 48.8 | 863 | -661 | 1.31 | 82 | 7,827 |
| Adaptive 3-plan, minimum ₹15 | 46.3 | 971 | -677 | 1.43 | 86 | 8,420 |
| Adaptive 3-plan, minimum ₹20 | 44.6 | 1,074 | -663 | 1.62 | 112 | 7,428 |
