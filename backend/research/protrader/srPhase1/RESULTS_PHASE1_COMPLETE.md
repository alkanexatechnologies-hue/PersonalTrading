# Phase 1 — complete comparison on the last 15 sessions (EXPLORATORY · not validated)

Sessions: 2026-10-01, 2026-10-05, 2026-10-06, 2026-10-07, 2026-10-08, 2026-10-09, 2026-10-12, 2026-10-13, 2026-10-14, 2026-10-15, 2026-10-16, 2026-10-19, 2026-10-21, 2026-10-22, 2026-10-23 (NIFTY and SENSEX). All variants use the same sessions, data and costs; Phase 2 has NOT been run.

Default exit E1: ATM option, SL = max(₹5, 1 × premium ATR), target 2 × SL, 60 min. Costs max(₹0.5, 0.25 %) per side + ₹40 / lot. ₹ figures per 1 lot (NIFTY 75, SENSEX 20). Ambiguous = target and SL in the same minute, booked as a stop. Conservative = stop filled at the minute's close + 0.5 % extra slippage per side. Win % = target hits / trades.

## 1. All variants (both indices)

| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| REF · RANDOM entry (every 5-min close, both directions) | 3600 | 3600 | 916 | 2238 | 444 | 2 | 25.4 | 1,705 | -1,064 | -1,98,817 | -5,44,982 | -151 | -274 | 0.79 | 5,67,459 |
| C · B0 EMA baseline: premium EMA9×EMA21, index past EMA21 | 76 | 76 | 24 | 46 | 6 | 0 | 31.6 | 1,303 | -946 | 535 | -6,703 | -88 | -182 | 0.85 | 15,444 |
| C · B0 + index signal candle agrees | 64 | 64 | 21 | 38 | 5 | 0 | 32.8 | 1,334 | -927 | 3,338 | -2,806 | -44 | -135 | 0.92 | 10,284 |
| C · B0 + 60-min opposite-signal cooldown | 67 | 67 | 21 | 40 | 6 | 0 | 31.3 | 1,296 | -935 | 1,796 | -4,671 | -70 | -166 | 0.88 | 13,079 |
| C · B0 + before 12:30 | 44 | 44 | 15 | 24 | 5 | 0 | 34.1 | 1,410 | -979 | 6,286 | 2,322 | 53 | -41 | 1.09 | 7,127 |
| C · C3 = B0 + before 12:30 + cooldown | 40 | 40 | 15 | 20 | 5 | 0 | 37.5 | 1,410 | -971 | 10,055 | 6,399 | 160 | 63 | 1.31 | 5,966 |
| C · B0 + index candle agrees + cooldown | 56 | 56 | 18 | 33 | 5 | 0 | 32.1 | 1,330 | -908 | 3,818 | -1,622 | -29 | -122 | 0.95 | 9,127 |
| A · H2 breakout accepted, all levels | 328 | 328 | 98 | 204 | 26 | 0 | 29.9 | 1,606 | -1,015 | 13,487 | -18,352 | -56 | -179 | 0.91 | 31,424 |
| A · H2 accepted, major level, no OI filter | 132 | 132 | 51 | 67 | 14 | 0 | 38.6 | 1,894 | -1,159 | 52,243 | 39,399 | 298 | 173 | 1.49 | 11,084 |
| A · C2 = H2 major + OI exclusion (no unwind/cover/buy) | 121 | 121 | 48 | 60 | 13 | 0 | 39.7 | 1,925 | -1,126 | 55,509 | 43,743 | 362 | 236 | 1.63 | 10,680 |
| A · H2a breakout without acceptance, major level | 158 | 158 | 49 | 89 | 19 | 1 | 31.0 | 1,965 | -1,215 | 20,612 | 5,172 | 33 | -91 | 1.04 | 19,322 |
| B · H1 rejection, all levels | 142 | 142 | 39 | 77 | 26 | 0 | 27.5 | 1,625 | -992 | 19,437 | 5,700 | 40 | -74 | 1.07 | 17,934 |
| B · H1 rejection, major level | 58 | 58 | 14 | 29 | 15 | 0 | 24.1 | 1,854 | -1,036 | 14,861 | 9,294 | 160 | 63 | 1.26 | 13,252 |
| B · H1 major + wick ≥60% | 38 | 38 | 11 | 15 | 12 | 0 | 28.9 | 1,681 | -1,036 | 18,672 | 14,960 | 394 | 299 | 1.80 | 6,040 |
| B · H1 major + before 12:30 | 49 | 49 | 12 | 24 | 13 | 0 | 24.5 | 1,939 | -1,027 | 16,654 | 11,974 | 244 | 145 | 1.42 | 11,650 |
| B · C1 = H1 major + wick ≥60% + before 12:30 | 32 | 32 | 9 | 13 | 10 | 0 | 28.1 | 1,755 | -1,039 | 17,308 | 14,249 | 445 | 351 | 1.91 | 4,437 |
| D · Fake-up at owner S/R (no OI) | 39 | 39 | 20 | 17 | 2 | 0 | 51.3 | 1,843 | -1,283 | 22,499 | 18,731 | 480 | 372 | 1.86 | 6,419 |
| D · Fake-up + call writing (OI addition) | 25 | 25 | 12 | 11 | 2 | 0 | 48.0 | 1,789 | -1,269 | 13,449 | 11,084 | 443 | 328 | 1.79 | 6,419 |
| D · Fake-up + CE unwinding | 7 | 7 | 3 | 4 | 0 | 0 | 42.9 | 2,042 | -1,181 | 2,066 | 1,404 | 201 | 112 | 1.30 | 3,229 |
| D · Fake-up + strong bearish close (price reaction) | 34 | 34 | 17 | 15 | 2 | 0 | 50.0 | 1,846 | -1,326 | 18,511 | 15,178 | 446 | 336 | 1.76 | 6,419 |
| D · C4 = fake-up + call writing + earlier touch | 13 | 13 | 8 | 5 | 0 | 0 | 61.5 | 1,705 | -831 | 10,630 | 9,485 | 730 | 642 | 3.28 | 1,459 |
| D · Fake-down at owner S/R (no OI) | 39 | 39 | 8 | 26 | 5 | 0 | 20.5 | 1,544 | -1,153 | -11,409 | -15,288 | -392 | -539 | 0.53 | 17,956 |
| D · Fake-down + put writing (OI addition) | 31 | 31 | 7 | 20 | 4 | 0 | 22.6 | 1,456 | -1,058 | -4,586 | -7,662 | -247 | -402 | 0.66 | 10,330 |
| D · Fake-down + PE unwinding | 6 | 6 | 2 | 4 | 0 | 0 | 33.3 | 3,149 | -1,605 | 483 | -121 | -20 | -138 | 0.98 | 5,631 |
| D · Fake-down + strong bullish close | 35 | 35 | 8 | 24 | 3 | 0 | 22.9 | 1,544 | -1,153 | -7,163 | -10,676 | -305 | -459 | 0.61 | 13,344 |
| D · Fake-down + put writing + earlier touch (C4 mirror) | 5 | 5 | 1 | 3 | 1 | 0 | 20.0 | 1,406 | -845 | -1,523 | -1,974 | -395 | -469 | 0.42 | 3,175 |
| E · B0 except CHOPPY regime | 71 | 71 | 23 | 42 | 6 | 0 | 32.4 | 1,264 | -937 | 1,873 | -4,933 | -69 | -165 | 0.88 | 15,334 |
| E · B0 only when regime trend agrees | 13 | 13 | 4 | 9 | 0 | 0 | 30.8 | 1,415 | -901 | -1,223 | -2,449 | -188 | -287 | 0.70 | 5,374 |
| E · C2 except CHOPPY regime | 104 | 104 | 43 | 49 | 12 | 0 | 41.3 | 1,906 | -1,045 | 57,868 | 47,699 | 459 | 336 | 1.89 | 8,526 |
| E · C1 except CHOPPY regime | 30 | 30 | 8 | 12 | 10 | 0 | 26.7 | 1,766 | -1,020 | 16,851 | 13,981 | 466 | 370 | 1.98 | 4,213 |
| F · C2 with confirmation entry (next candle extends) (rejected by confirmation: 57) | 121 | 64 | 20 | 34 | 9 | 1 | 31.3 | 1,972 | -1,086 | 13,282 | 6,947 | 109 | -21 | 1.16 | 10,929 |
| F · C1 with confirmation entry (rejected by confirmation: 13) | 32 | 19 | 5 | 10 | 4 | 0 | 26.3 | 1,688 | -1,025 | 1,254 | -482 | -25 | -112 | 0.96 | 3,398 |
| F · B0 with confirmation entry (rejected by confirmation: 36) | 76 | 40 | 15 | 23 | 2 | 0 | 37.5 | 1,563 | -823 | 11,446 | 7,631 | 191 | 102 | 1.40 | 3,974 |
| F · C2 exit E2 (target 3 × SL) | 121 | 121 | 30 | 63 | 28 | 0 | 24.8 | 2,348 | -1,113 | 67,455 | 55,655 | 460 | 331 | 1.76 | 10,205 |
| F · C2 exit E3 (owner SL ₹5 / T ₹40) | 121 | 121 | 20 | 101 | 0 | 0 | 16.5 | 1,692 | -324 | 12,775 | 1,081 | 9 | -161 | 1.03 | 7,697 |
| F · C1 exit E2 (target 3 × SL) | 32 | 32 | 5 | 14 | 13 | 0 | 15.6 | 2,132 | -1,051 | 20,355 | 17,289 | 540 | 445 | 2.03 | 4,213 |
| F · B0 exit E3 (owner SL ₹5 / T ₹40) | 76 | 76 | 19 | 57 | 0 | 0 | 25.0 | 1,519 | -341 | 16,650 | 9,407 | 124 | -52 | 1.48 | 6,678 |

## 2. What each change does vs the EMA baseline (B0)

| Variant | Trades vs B0 | Win % change | Net / trade change ₹ | Conservative net / trade change ₹ | Reading |
|---|---|---|---|---|---|
| C · B0 + index signal candle agrees | 64 vs 76 | +1.2 | +44 | +47 | improves expectancy only |
| C · B0 + 60-min opposite-signal cooldown | 67 vs 76 | -0.2 | +18 | +16 | improves expectancy only |
| C · B0 + before 12:30 | 44 vs 76 | +2.5 | +141 | +141 | improves win rate AND expectancy |
| C · C3 = B0 + before 12:30 + cooldown | 40 vs 76 | +5.9 | +248 | +245 | improves win rate AND expectancy |
| C · B0 + index candle agrees + cooldown | 56 vs 76 | +0.6 | +59 | +60 | improves expectancy only |
| A · H2 breakout accepted, all levels | 328 vs 76 | -1.7 | +32 | +3 | improves expectancy only |
| A · H2 accepted, major level, no OI filter | 132 vs 76 | +7.1 | +387 | +355 | improves win rate AND expectancy |
| A · C2 = H2 major + OI exclusion (no unwind/cover/buy) | 121 vs 76 | +8.1 | +450 | +417 | improves win rate AND expectancy |
| A · H2a breakout without acceptance, major level | 158 vs 76 | -0.6 | +121 | +91 | improves expectancy only |
| B · H1 rejection, all levels | 142 vs 76 | -4.1 | +128 | +108 | improves expectancy only |
| B · H1 rejection, major level | 58 vs 76 | -7.4 | +248 | +244 | improves expectancy only |
| B · H1 major + wick ≥60% | 38 vs 76 | -2.6 | +482 | +481 | improves expectancy only |
| B · H1 major + before 12:30 | 49 vs 76 | -7.1 | +333 | +326 | improves expectancy only |
| B · C1 = H1 major + wick ≥60% + before 12:30 | 32 vs 76 | -3.5 | +533 | +532 | improves expectancy only |
| D · Fake-up at owner S/R (no OI) | 39 vs 76 | +19.7 | +568 | +553 | improves win rate AND expectancy |
| D · Fake-up + call writing (OI addition) | 25 vs 76 | +16.4 | +532 | +510 | improves win rate AND expectancy |
| D · Fake-up + CE unwinding | 7 vs 76 | +11.3 | +289 | +293 | too few trades to read |
| D · Fake-up + strong bearish close (price reaction) | 34 vs 76 | +18.4 | +535 | +518 | improves win rate AND expectancy |
| D · C4 = fake-up + call writing + earlier touch | 13 vs 76 | +30.0 | +818 | +824 | too few trades to read |
| D · Fake-down at owner S/R (no OI) | 39 vs 76 | -11.1 | -304 | -358 | worse |
| D · Fake-down + put writing (OI addition) | 31 vs 76 | -9.0 | -159 | -221 | worse |
| D · Fake-down + PE unwinding | 6 vs 76 | +1.8 | +68 | +44 | too few trades to read |
| D · Fake-down + strong bullish close | 35 vs 76 | -8.7 | -217 | -278 | worse |
| D · Fake-down + put writing + earlier touch (C4 mirror) | 5 vs 76 | -11.6 | -307 | -287 | too few trades to read |
| E · B0 except CHOPPY regime | 71 vs 76 | +0.8 | +19 | +16 | improves expectancy only |
| E · B0 only when regime trend agrees | 13 vs 76 | -0.8 | -100 | -105 | too few trades to read |
| E · C2 except CHOPPY regime | 104 vs 76 | +9.8 | +547 | +518 | improves win rate AND expectancy |
| E · C1 except CHOPPY regime | 30 vs 76 | -4.9 | +554 | +551 | improves expectancy only |
| F · C2 with confirmation entry (next candle extends) | 64 vs 76 | -0.3 | +197 | +161 | improves expectancy only |
| F · C1 with confirmation entry | 19 vs 76 | -5.3 | +63 | +70 | improves expectancy only |
| F · B0 with confirmation entry | 40 vs 76 | +5.9 | +279 | +283 | improves win rate AND expectancy |
| F · C2 exit E2 (target 3 × SL) | 121 vs 76 | -6.8 | +548 | +513 | improves expectancy only |
| F · C2 exit E3 (owner SL ₹5 / T ₹40) | 121 vs 76 | -15.1 | +97 | +21 | improves expectancy only |
| F · C1 exit E2 (target 3 × SL) | 32 vs 76 | -16.0 | +628 | +627 | improves expectancy only |
| F · B0 exit E3 (owner SL ₹5 / T ₹40) | 76 vs 76 | -6.6 | +212 | +130 | improves expectancy only |

## 3. By index and option side

| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 EMA baseline · NIFTY CE | 22 | 22 | 8 | 13 | 1 | 0 | 36.4 | 1,239 | -890 | 2,121 | -409 | -19 | -118 | 0.96 | 4,313 |
| B0 EMA baseline · NIFTY PE | 15 | 15 | 3 | 11 | 1 | 0 | 20.0 | 1,364 | -1,148 | -5,445 | -7,170 | -478 | -594 | 0.43 | 11,163 |
| B0 EMA baseline · SENSEX CE | 14 | 14 | 5 | 9 | 0 | 0 | 35.7 | 1,310 | -945 | -857 | -1,956 | -140 | -219 | 0.77 | 4,417 |
| B0 EMA baseline · SENSEX PE | 25 | 25 | 8 | 13 | 4 | 0 | 32.0 | 1,329 | -842 | 4,716 | 2,832 | 113 | 31 | 1.24 | 4,483 |
| C1 rejection · NIFTY CE | 7 | 7 | 2 | 4 | 1 | 0 | 28.6 | 1,775 | -1,333 | 799 | -6 | -1 | -109 | 1.00 | 2,295 |
| C1 rejection · NIFTY PE | 9 | 9 | 4 | 1 | 4 | 0 | 44.4 | 2,059 | -740 | 13,967 | 12,932 | 1,437 | 1,349 | 9.74 | 1,309 |
| C1 rejection · SENSEX CE | 9 | 9 | 2 | 6 | 1 | 0 | 22.2 | 1,174 | -1,121 | -2,493 | -3,204 | -356 | -471 | 0.52 | 3,204 |
| C1 rejection · SENSEX PE | 7 | 7 | 1 | 2 | 4 | 0 | 14.3 | 1,643 | -682 | 5,036 | 4,527 | 647 | 582 | 3.21 | 959 |
| C2 acceptance · NIFTY CE | 25 | 25 | 9 | 15 | 1 | 0 | 36.0 | 2,391 | -1,384 | 6,030 | 3,149 | 126 | -44 | 1.15 | 6,227 |
| C2 acceptance · NIFTY PE | 31 | 31 | 14 | 12 | 5 | 0 | 45.2 | 2,041 | -1,264 | 23,872 | 20,301 | 655 | 543 | 2.24 | 3,598 |
| C2 acceptance · SENSEX CE | 30 | 30 | 11 | 17 | 2 | 0 | 36.7 | 1,742 | -1,035 | 7,569 | 5,046 | 168 | 17 | 1.29 | 6,370 |
| C2 acceptance · SENSEX PE | 35 | 35 | 14 | 16 | 5 | 0 | 40.0 | 1,683 | -885 | 18,039 | 15,246 | 436 | 351 | 2.01 | 4,912 |
| C3 EMA filtered · NIFTY CE | 9 | 9 | 4 | 4 | 1 | 0 | 44.4 | 1,344 | -746 | 4,769 | 3,734 | 415 | 286 | 2.25 | 1,219 |
| C3 EMA filtered · NIFTY PE | 8 | 8 | 2 | 6 | 0 | 0 | 25.0 | 1,996 | -1,267 | -2,691 | -3,611 | -451 | -560 | 0.53 | 7,604 |
| C3 EMA filtered · SENSEX CE | 8 | 8 | 4 | 4 | 0 | 0 | 50.0 | 1,315 | -1,008 | 1,820 | 1,228 | 153 | 81 | 1.30 | 2,418 |
| C3 EMA filtered · SENSEX PE | 15 | 15 | 5 | 6 | 4 | 0 | 33.3 | 1,352 | -824 | 6,157 | 5,049 | 337 | 252 | 1.87 | 1,965 |
| C4 fake-up + OI · NIFTY PE | 5 | 5 | 3 | 2 | 0 | 0 | 60.0 | 2,038 | -1,065 | 4,558 | 3,982 | 796 | 666 | 2.87 | 1,235 |
| C4 fake-up + OI · SENSEX PE | 8 | 8 | 5 | 3 | 0 | 0 | 62.5 | 1,506 | -676 | 6,072 | 5,502 | 688 | 627 | 3.71 | 1,217 |

## 4. By index

| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 EMA baseline · NIFTY | 37 | 37 | 11 | 24 | 2 | 0 | 29.7 | 1,278 | -1,008 | -3,324 | -7,579 | -205 | -311 | 0.69 | 13,037 |
| B0 EMA baseline · SENSEX | 39 | 39 | 13 | 22 | 4 | 0 | 33.3 | 1,323 | -882 | 3,858 | 876 | 22 | -59 | 1.04 | 7,057 |
| C1 rejection · NIFTY | 16 | 16 | 6 | 5 | 5 | 0 | 37.5 | 1,974 | -1,135 | 14,766 | 12,926 | 808 | 712 | 2.90 | 2,565 |
| C1 rejection · SENSEX | 16 | 16 | 3 | 8 | 5 | 0 | 18.8 | 1,442 | -975 | 2,542 | 1,323 | 83 | -11 | 1.15 | 3,631 |
| C2 acceptance · NIFTY | 56 | 56 | 23 | 27 | 6 | 0 | 41.1 | 2,166 | -1,328 | 29,901 | 23,450 | 419 | 281 | 1.63 | 6,278 |
| C2 acceptance · SENSEX | 65 | 65 | 25 | 33 | 7 | 0 | 38.5 | 1,708 | -960 | 25,608 | 20,292 | 312 | 197 | 1.62 | 5,586 |
| C3 EMA filtered · NIFTY | 17 | 17 | 6 | 10 | 1 | 0 | 35.3 | 1,530 | -1,059 | 2,078 | 123 | 7 | -112 | 1.01 | 5,141 |
| C3 EMA filtered · SENSEX | 23 | 23 | 9 | 10 | 4 | 0 | 39.1 | 1,340 | -891 | 7,977 | 6,276 | 273 | 193 | 1.64 | 3,229 |
| C4 fake-up + OI · NIFTY | 5 | 5 | 3 | 2 | 0 | 0 | 60.0 | 2,038 | -1,065 | 4,558 | 3,982 | 796 | 666 | 2.87 | 1,235 |
| C4 fake-up + OI · SENSEX | 8 | 8 | 5 | 3 | 0 | 0 | 62.5 | 1,506 | -676 | 6,072 | 5,502 | 688 | 627 | 3.71 | 1,217 |

## 5. By time of day (signal candle)

| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 EMA baseline · 09:15–09:30 | 5 | 5 | 3 | 2 | 0 | 0 | 60.0 | 295 | -330 | 675 | 226 | 45 | -72 | 1.34 | 547 |
| B0 EMA baseline · 09:30–10:30 | 19 | 19 | 7 | 9 | 3 | 0 | 36.8 | 1,573 | -946 | 6,457 | 4,696 | 247 | 148 | 1.50 | 3,369 |
| B0 EMA baseline · 10:30–12:30 | 19 | 19 | 5 | 12 | 2 | 0 | 26.3 | 1,678 | -1,124 | -66 | -1,741 | -92 | -174 | 0.87 | 6,215 |
| B0 EMA baseline · 12:30–14:30 | 33 | 33 | 9 | 23 | 1 | 0 | 27.3 | 1,099 | -908 | -6,531 | -9,883 | -299 | -392 | 0.53 | 12,850 |
| C1 rejection · 09:30–10:30 | 20 | 20 | 4 | 8 | 8 | 0 | 20.0 | 1,871 | -982 | 10,896 | 8,896 | 445 | 351 | 1.91 | 6,205 |
| C1 rejection · 10:30–12:30 | 11 | 11 | 5 | 4 | 2 | 0 | 45.5 | 1,588 | -1,202 | 7,292 | 6,312 | 574 | 475 | 2.31 | 3,776 |
| C1 rejection · 12:30–14:30 | 1 | 1 | 0 | 1 | 0 | 0 | 0.0 | 0 | -959 | -880 | -959 | -959 | -1,038 | 0.00 | 959 |
| C2 acceptance · 09:30–10:30 | 67 | 67 | 30 | 27 | 10 | 0 | 44.8 | 2,166 | -1,292 | 51,422 | 44,852 | 669 | 546 | 2.20 | 10,384 |
| C2 acceptance · 10:30–12:30 | 29 | 29 | 11 | 15 | 3 | 0 | 37.9 | 1,505 | -1,047 | 8,154 | 5,367 | 185 | 68 | 1.34 | 6,052 |
| C2 acceptance · 12:30–14:30 | 25 | 25 | 7 | 18 | 0 | 0 | 28.0 | 1,454 | -925 | -4,067 | -6,475 | -259 | -402 | 0.61 | 6,475 |
| C3 EMA filtered · 09:15–09:30 | 5 | 5 | 3 | 2 | 0 | 0 | 60.0 | 295 | -330 | 675 | 226 | 45 | -72 | 1.34 | 547 |
| C3 EMA filtered · 09:30–10:30 | 19 | 19 | 7 | 9 | 3 | 0 | 36.8 | 1,573 | -946 | 6,457 | 4,696 | 247 | 148 | 1.50 | 3,369 |
| C3 EMA filtered · 10:30–12:30 | 15 | 15 | 5 | 8 | 2 | 0 | 33.3 | 1,678 | -1,176 | 3,703 | 2,336 | 156 | 68 | 1.25 | 4,702 |
| C3 EMA filtered · 12:30–14:30 | 1 | 1 | 0 | 1 | 0 | 0 | 0.0 | 0 | -859 | -780 | -859 | -859 | -937 | 0.00 | 859 |
| C4 fake-up + OI · 09:30–10:30 | 6 | 6 | 6 | 0 | 0 | 0 | 100.0 | 1,844 | 0 | 11,597 | 11,063 | 1,844 | 1,765 | ∞ | 0 |
| C4 fake-up + OI · 10:30–12:30 | 4 | 4 | 1 | 3 | 0 | 0 | 25.0 | 1,104 | -980 | -1,486 | -1,837 | -459 | -564 | 0.38 | 2,131 |
| C4 fake-up + OI · 12:30–14:30 | 3 | 3 | 1 | 2 | 0 | 0 | 33.3 | 1,476 | -609 | 519 | 258 | 86 | 5 | 1.21 | 655 |

## 6. By major level type (first major level of the entry)

| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 EMA baseline · — | 76 | 76 | 24 | 46 | 6 | 0 | 31.6 | 1,303 | -946 | 535 | -6,703 | -88 | -182 | 0.85 | 15,444 |
| C1 rejection · ORB high | 8 | 8 | 1 | 5 | 2 | 0 | 12.5 | 1,648 | -840 | -3,500 | -4,232 | -529 | -619 | 0.28 | 5,442 |
| C1 rejection · ORB low | 7 | 7 | 3 | 1 | 3 | 0 | 42.9 | 1,434 | -1,039 | 8,329 | 7,564 | 1,081 | 993 | 8.28 | 1,039 |
| C1 rejection · PDC | 2 | 2 | 0 | 1 | 1 | 0 | 0.0 | 537 | -1,219 | -555 | -681 | -341 | -409 | 0.44 | 1,219 |
| C1 rejection · PDH | 5 | 5 | 0 | 3 | 2 | 0 | 0.0 | 3,286 | -1,104 | 3,731 | 3,260 | 652 | 531 | 1.98 | 3,312 |
| C1 rejection · PDL | 1 | 1 | 0 | 1 | 0 | 0 | 0.0 | 0 | -959 | -880 | -959 | -959 | -1,038 | 0.00 | 959 |
| C1 rejection · owner S/R | 9 | 9 | 5 | 2 | 2 | 0 | 55.6 | 1,782 | -1,588 | 10,183 | 9,296 | 1,033 | 935 | 3.93 | 1,620 |
| C2 acceptance · ORB high | 24 | 24 | 14 | 10 | 0 | 0 | 58.3 | 2,074 | -1,350 | 17,895 | 15,537 | 647 | 546 | 2.15 | 4,363 |
| C2 acceptance · ORB low | 22 | 22 | 7 | 11 | 4 | 0 | 31.8 | 2,010 | -1,077 | 9,316 | 7,176 | 326 | 180 | 1.56 | 5,032 |
| C2 acceptance · PDC | 11 | 11 | 4 | 2 | 5 | 0 | 36.4 | 1,594 | -1,019 | 13,316 | 12,304 | 1,119 | 1,023 | 7.04 | 2,001 |
| C2 acceptance · PDH | 13 | 13 | 6 | 6 | 1 | 0 | 46.2 | 1,713 | -1,250 | 5,771 | 4,492 | 346 | 194 | 1.60 | 5,027 |
| C2 acceptance · PDL | 15 | 15 | 6 | 9 | 0 | 0 | 40.0 | 2,647 | -1,114 | 7,275 | 5,851 | 390 | 277 | 1.58 | 4,420 |
| C2 acceptance · owner S/R | 36 | 36 | 11 | 22 | 3 | 0 | 30.6 | 1,710 | -1,037 | 1,935 | -1,617 | -45 | -179 | 0.93 | 7,915 |
| C3 EMA filtered · — | 40 | 40 | 15 | 20 | 5 | 0 | 37.5 | 1,410 | -971 | 10,055 | 6,399 | 160 | 63 | 1.31 | 5,966 |
| C4 fake-up + OI · owner S/R | 13 | 13 | 8 | 5 | 0 | 0 | 61.5 | 1,705 | -831 | 10,630 | 9,485 | 730 | 642 | 3.28 | 1,459 |

## 7. By market regime at entry (research regime detector, unvalidated thresholds)

| Variant | Signals | Trades | Target | Stop | Time | Ambig | Win % | Avg win ₹ | Avg loss ₹ | Gross ₹ | Net ₹ | Net / trade ₹ | Net / trade ₹ (conservative) | PF | Max DD ₹ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 EMA baseline · CHOPPY | 5 | 5 | 1 | 4 | 0 | 0 | 20.0 | 2,402 | -1,043 | -1,338 | -1,770 | -354 | -414 | 0.58 | 4,173 |
| B0 EMA baseline · COMPRESSION | 4 | 4 | 1 | 3 | 0 | 0 | 25.0 | 959 | -712 | -750 | -1,178 | -295 | -354 | 0.45 | 2,137 |
| B0 EMA baseline · TRANSITION | 41 | 41 | 11 | 26 | 4 | 0 | 26.8 | 1,441 | -1,053 | -4,308 | -8,247 | -201 | -301 | 0.71 | 15,066 |
| B0 EMA baseline · TRENDING_DOWN | 7 | 7 | 1 | 6 | 0 | 0 | 14.3 | 1,881 | -811 | -2,353 | -2,983 | -426 | -515 | 0.39 | 4,864 |
| B0 EMA baseline · TRENDING_UP | 6 | 6 | 3 | 3 | 0 | 0 | 50.0 | 1,259 | -1,081 | 1,130 | 534 | 89 | -21 | 1.16 | 1,980 |
| B0 EMA baseline · UNKNOWN_DATA | 13 | 13 | 7 | 4 | 2 | 0 | 53.8 | 954 | -410 | 8,154 | 6,942 | 534 | 441 | 5.23 | 660 |
| C1 rejection · CHOPPY | 2 | 2 | 1 | 1 | 0 | 0 | 50.0 | 1,577 | -1,309 | 457 | 268 | 134 | 61 | 1.20 | 1,309 |
| C1 rejection · TRANSITION | 12 | 12 | 4 | 6 | 2 | 0 | 33.3 | 1,809 | -1,093 | 5,457 | 4,298 | 358 | 255 | 1.66 | 2,776 |
| C1 rejection · TRENDING_DOWN | 3 | 3 | 1 | 0 | 2 | 0 | 33.3 | 1,019 | 0 | 3,295 | 3,056 | 1,019 | 958 | ∞ | 0 |
| C1 rejection · TRENDING_UP | 6 | 6 | 2 | 2 | 2 | 0 | 33.3 | 1,889 | -749 | 1,363 | 784 | 131 | 24 | 1.26 | 2,995 |
| C1 rejection · UNKNOWN_DATA | 9 | 9 | 1 | 4 | 4 | 0 | 11.1 | 2,113 | -1,181 | 6,737 | 5,843 | 649 | 557 | 2.24 | 3,103 |
| C2 acceptance · CHOPPY | 17 | 17 | 5 | 11 | 1 | 0 | 29.4 | 2,094 | -1,502 | -2,359 | -3,956 | -233 | -378 | 0.76 | 13,238 |
| C2 acceptance · COMPRESSION | 1 | 1 | 0 | 1 | 0 | 0 | 0.0 | 0 | -580 | -504 | -580 | -580 | -651 | 0.00 | 580 |
| C2 acceptance · TRANSITION | 56 | 56 | 20 | 27 | 9 | 0 | 35.7 | 1,748 | -964 | 27,328 | 21,945 | 392 | 265 | 1.81 | 8,808 |
| C2 acceptance · TRENDING_DOWN | 6 | 6 | 1 | 4 | 1 | 0 | 16.7 | 2,387 | -754 | -816 | -1,381 | -230 | -303 | 0.63 | 2,648 |
| C2 acceptance · TRENDING_UP | 23 | 23 | 12 | 11 | 0 | 0 | 52.2 | 2,026 | -1,144 | 14,041 | 11,729 | 510 | 365 | 1.93 | 6,058 |
| C2 acceptance · UNKNOWN_DATA | 18 | 18 | 10 | 6 | 2 | 0 | 55.6 | 2,113 | -1,562 | 17,820 | 15,986 | 888 | 788 | 2.71 | 8,348 |
| C3 EMA filtered · CHOPPY | 4 | 4 | 1 | 3 | 0 | 0 | 25.0 | 2,402 | -1,125 | -655 | -972 | -243 | -311 | 0.71 | 3,374 |
| C3 EMA filtered · TRANSITION | 19 | 19 | 5 | 11 | 3 | 0 | 26.3 | 1,724 | -1,074 | 972 | -826 | -43 | -135 | 0.94 | 5,615 |
| C3 EMA filtered · TRENDING_DOWN | 1 | 1 | 1 | 0 | 0 | 0 | 100.0 | 1,881 | 0 | 1,960 | 1,881 | 1,881 | 1,803 | ∞ | 0 |
| C3 EMA filtered · TRENDING_UP | 3 | 3 | 1 | 2 | 0 | 0 | 33.3 | 1,856 | -1,241 | -376 | -627 | -209 | -399 | 0.75 | 1,264 |
| C3 EMA filtered · UNKNOWN_DATA | 13 | 13 | 7 | 4 | 2 | 0 | 53.8 | 954 | -410 | 8,154 | 6,942 | 534 | 441 | 5.23 | 660 |
| C4 fake-up + OI · COMPRESSION | 1 | 1 | 0 | 1 | 0 | 0 | 0.0 | 0 | -562 | -485 | -562 | -562 | -637 | 0.00 | 562 |
| C4 fake-up + OI · TRANSITION | 6 | 6 | 3 | 3 | 0 | 0 | 50.0 | 1,312 | -900 | 1,716 | 1,236 | 206 | 137 | 1.46 | 1,235 |
| C4 fake-up + OI · TRENDING_UP | 6 | 6 | 5 | 1 | 0 | 0 | 83.3 | 1,941 | -896 | 9,399 | 8,811 | 1,468 | 1,360 | 10.83 | 896 |

## 8. Is the EMA entry late relative to S/R and price structure?

- 32 of 76 EMA (B0) entries were preceded by a same-direction MAJOR S/R entry (rejection or accepted breakout) earlier the same day within 60 minutes; median 15 minutes earlier, the index 66 points further in the trade direction by the EMA entry.
- Phase-1 lag check (phase1.ts): 74 of 76 EMA signals came after the index had moved ≥ 2 ATR from the last hour's extreme.
- EMA entries WITH a prior S/R entry: 32 trades · win 34.4% · net/trade ₹36 · WITHOUT: 44 trades · win 29.5% · net/trade ₹-179.

## 9. Trade-level records of C1, C2, C3, C4 and B0 (E1 exit, base costs; ₹ per lot)

### B0 EMA baseline

| Index | Date | Entry | Option side | Level(s) | Regime | Premium in ₹ | Result | Exit | Minutes | Net ₹ | Net ₹ conservative |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SENSEX | 10-01 | 09:55 | PE | — | CHOPPY | 190.95 | STOP | 10:00 | 5 | -1,021 | -1,060 |
| SENSEX | 10-01 | 12:10 | PE | — | TRANSITION | 180.50 | TARGET | 12:20 | 10 | 1,276 | 1,233 |
| SENSEX | 10-01 | 12:15 | PE | — | TRANSITION | 148.15 | TARGET | 12:24 | 9 | 1,104 | 1,068 |
| NIFTY | 10-05 | 09:30 | CE | — | UNKNOWN_DATA | 124.70 | TARGET | 09:33 | 3 | 635 | 538 |
| NIFTY | 10-05 | 09:50 | CE | — | TRENDING_UP | 108.00 | STOP | 10:00 | 10 | -1,219 | -1,677 |
| NIFTY | 10-05 | 11:50 | PE | — | TRANSITION | 81.10 | TARGET | 12:01 | 11 | 1,591 | 1,521 |
| NIFTY | 10-05 | 13:40 | CE | — | TRANSITION | 110.40 | TARGET | 13:41 | 1 | 1,555 | 1,464 |
| SENSEX | 10-05 | 13:40 | CE | — | TRANSITION | 528.90 | TARGET | 13:41 | 1 | 1,293 | 1,180 |
| SENSEX | 10-05 | 13:45 | CE | — | TRANSITION | 559.65 | STOP | 13:50 | 5 | -840 | -948 |
| NIFTY | 10-06 | 09:35 | CE | — | UNKNOWN_DATA | 68.70 | TARGET | 09:56 | 21 | 1,705 | 1,644 |
| SENSEX | 10-06 | 09:40 | CE | — | UNKNOWN_DATA | 408.20 | TARGET | 09:57 | 17 | 1,312 | 1,224 |
| NIFTY | 10-06 | 09:50 | CE | — | TRANSITION | 53.90 | STOP | 10:11 | 21 | -786 | -823 |
| SENSEX | 10-06 | 09:55 | CE | — | TRANSITION | 398.30 | STOP | 10:10 | 15 | -754 | -869 |
| NIFTY | 10-06 | 12:40 | CE | — | COMPRESSION | 48.60 | TARGET | 12:45 | 5 | 959 | 917 |
| NIFTY | 10-06 | 13:40 | CE | — | COMPRESSION | 43.60 | STOP | 13:45 | 5 | -776 | -853 |
| NIFTY | 10-06 | 14:05 | CE | — | COMPRESSION | 45.55 | STOP | 14:21 | 16 | -706 | -738 |
| SENSEX | 10-08 | 09:25 | PE | — | UNKNOWN_DATA | 216.75 | TARGET | 09:26 | 1 | 138 | 93 |
| SENSEX | 10-08 | 09:35 | PE | — | UNKNOWN_DATA | 188.95 | TIME | 10:35 | 60 | 624 | 583 |
| NIFTY | 10-09 | 09:25 | CE | — | UNKNOWN_DATA | 154.30 | TARGET | 09:27 | 2 | 635 | 516 |
| NIFTY | 10-09 | 09:30 | CE | — | UNKNOWN_DATA | 129.10 | STOP | 09:32 | 2 | -490 | -585 |
| NIFTY | 10-09 | 12:55 | CE | — | TRANSITION | 133.50 | STOP | 13:05 | 10 | -926 | -1,073 |
| SENSEX | 10-09 | 12:55 | CE | — | TRANSITION | 598.80 | STOP | 13:05 | 10 | -790 | -906 |
| SENSEX | 10-12 | 09:40 | PE | — | UNKNOWN_DATA | 463.00 | TIME | 10:40 | 60 | 1,443 | 1,343 |
| NIFTY | 10-12 | 09:55 | PE | — | TRANSITION | 106.90 | STOP | 09:57 | 2 | -1,821 | -1,990 |
| NIFTY | 10-12 | 13:35 | PE | — | TRANSITION | 76.60 | STOP | 13:55 | 20 | -873 | -927 |
| SENSEX | 10-12 | 13:35 | PE | — | TRENDING_DOWN | 449.95 | STOP | 13:55 | 20 | -754 | -840 |
| NIFTY | 10-12 | 14:15 | PE | — | TRANSITION | 84.50 | TIME | 15:15 | 60 | 13 | -52 |
| SENSEX | 10-12 | 14:20 | PE | — | TRANSITION | 416.95 | TARGET | 14:44 | 24 | 1,152 | 1,063 |
| NIFTY | 10-13 | 09:25 | CE | — | UNKNOWN_DATA | 78.10 | STOP | 09:28 | 3 | -490 | -547 |
| SENSEX | 10-13 | 09:25 | CE | — | UNKNOWN_DATA | 468.40 | TARGET | 09:26 | 1 | 113 | 18 |
| SENSEX | 10-13 | 12:30 | CE | — | CHOPPY | 410.20 | STOP | 13:24 | 54 | -859 | -937 |
| NIFTY | 10-13 | 12:35 | CE | — | CHOPPY | 42.85 | STOP | 12:46 | 11 | -798 | -827 |
| NIFTY | 10-13 | 13:45 | CE | — | TRENDING_UP | 41.40 | STOP | 14:00 | 15 | -762 | -789 |
| NIFTY | 10-13 | 14:05 | CE | — | TRENDING_UP | 43.50 | TARGET | 14:20 | 15 | 1,240 | 1,201 |
| NIFTY | 10-13 | 14:10 | CE | — | TRENDING_UP | 21.95 | TARGET | 14:20 | 10 | 682 | 662 |
| NIFTY | 10-14 | 11:35 | PE | — | TRANSITION | 156.90 | STOP | 11:46 | 11 | -1,163 | -1,307 |
| SENSEX | 10-14 | 11:35 | PE | — | TRANSITION | 350.10 | STOP | 11:45 | 10 | -999 | -1,088 |
| NIFTY | 10-14 | 12:05 | CE | — | TRANSITION | 136.05 | STOP | 12:15 | 10 | -1,033 | -1,130 |
| SENSEX | 10-14 | 12:10 | CE | — | TRANSITION | 285.35 | STOP | 12:31 | 21 | -848 | -901 |
| NIFTY | 10-14 | 13:00 | PE | — | TRANSITION | 140.85 | TARGET | 13:02 | 2 | 1,449 | 1,336 |
| SENSEX | 10-14 | 13:00 | PE | — | TRANSITION | 308.10 | TARGET | 13:02 | 2 | 1,225 | 1,156 |
| SENSEX | 10-14 | 13:05 | PE | — | TRANSITION | 311.20 | TARGET | 13:09 | 4 | 1,425 | 1,355 |
| SENSEX | 10-14 | 13:15 | PE | — | TRANSITION | 378.55 | STOP | 13:16 | 1 | -1,171 | -1,241 |
| SENSEX | 10-15 | 09:40 | CE | — | UNKNOWN_DATA | 214.50 | TARGET | 09:54 | 14 | 1,978 | 1,925 |
| SENSEX | 10-15 | 09:50 | CE | — | TRENDING_UP | 193.50 | TARGET | 09:55 | 5 | 1,856 | 1,807 |
| NIFTY | 10-16 | 10:10 | CE | — | TRANSITION | 104.05 | TARGET | 10:18 | 8 | 2,201 | 2,111 |
| NIFTY | 10-16 | 13:35 | CE | — | TRANSITION | 85.00 | STOP | 13:46 | 11 | -747 | -880 |
| SENSEX | 10-16 | 13:35 | CE | — | TRANSITION | 478.30 | STOP | 13:44 | 9 | -723 | -815 |
| SENSEX | 10-16 | 14:30 | PE | — | COMPRESSION | 450.85 | STOP | 14:45 | 15 | -655 | -742 |
| NIFTY | 10-19 | 09:30 | PE | — | UNKNOWN_DATA | 101.45 | STOP | 09:31 | 1 | -490 | -572 |
| SENSEX | 10-19 | 10:05 | PE | — | TRANSITION | 468.40 | TIME | 11:05 | 60 | -121 | -214 |
| SENSEX | 10-19 | 10:40 | PE | — | TRANSITION | 440.45 | TIME | 11:40 | 60 | 2,530 | 2,429 |
| NIFTY | 10-19 | 10:50 | PE | — | TRANSITION | 75.00 | STOP | 11:00 | 10 | -1,633 | -1,694 |
| NIFTY | 10-19 | 11:40 | PE | — | TRANSITION | 71.45 | STOP | 11:45 | 5 | -1,104 | -1,153 |
| SENSEX | 10-19 | 11:40 | PE | — | TRANSITION | 453.35 | STOP | 11:49 | 9 | -1,011 | -1,097 |
| SENSEX | 10-19 | 12:05 | PE | — | TRANSITION | 465.30 | STOP | 12:08 | 3 | -954 | -1,067 |
| SENSEX | 10-19 | 12:40 | PE | — | TRENDING_DOWN | 418.20 | STOP | 13:05 | 25 | -982 | -1,061 |
| SENSEX | 10-19 | 13:20 | PE | — | TRENDING_DOWN | 427.10 | STOP | 14:04 | 44 | -767 | -849 |
| NIFTY | 10-19 | 13:30 | PE | — | TRENDING_DOWN | 47.25 | STOP | 13:32 | 2 | -717 | -750 |
| SENSEX | 10-19 | 13:35 | PE | — | TRENDING_DOWN | 391.55 | STOP | 13:42 | 7 | -769 | -887 |
| NIFTY | 10-19 | 14:30 | PE | — | TRENDING_DOWN | 34.95 | STOP | 14:44 | 14 | -875 | -1,022 |
| SENSEX | 10-21 | 09:45 | CE | — | TRENDING_UP | 344.80 | STOP | 09:50 | 5 | -1,264 | -1,327 |
| SENSEX | 10-21 | 11:50 | PE | — | TRANSITION | 381.85 | TARGET | 12:13 | 23 | 1,824 | 1,738 |
| SENSEX | 10-21 | 12:00 | PE | — | TRENDING_DOWN | 340.95 | TARGET | 12:14 | 14 | 1,881 | 1,803 |
| SENSEX | 10-22 | 09:25 | PE | — | UNKNOWN_DATA | 302.25 | STOP | 09:26 | 1 | -170 | -441 |
| SENSEX | 10-22 | 10:05 | PE | — | CHOPPY | 258.35 | STOP | 10:09 | 4 | -1,494 | -1,539 |
| NIFTY | 10-22 | 10:30 | CE | — | TRANSITION | 179.60 | TIME | 11:30 | 60 | 1,542 | 1,399 |
| SENSEX | 10-22 | 10:35 | CE | — | TRANSITION | 283.15 | STOP | 10:43 | 8 | -1,276 | -1,327 |
| SENSEX | 10-22 | 11:15 | CE | — | TRANSITION | 221.45 | STOP | 11:22 | 7 | -1,154 | -1,193 |
| NIFTY | 10-22 | 11:55 | PE | — | TRANSITION | 163.05 | STOP | 12:28 | 33 | -1,393 | -1,577 |
| SENSEX | 10-22 | 12:05 | PE | — | TRANSITION | 224.55 | STOP | 12:27 | 22 | -920 | -961 |
| NIFTY | 10-22 | 13:00 | CE | — | TRANSITION | 174.55 | STOP | 13:14 | 14 | -1,446 | -1,589 |
| NIFTY | 10-22 | 13:40 | PE | — | TRANSITION | 132.90 | STOP | 13:50 | 10 | -1,399 | -1,492 |
| NIFTY | 10-22 | 14:25 | PE | — | TRANSITION | 121.05 | STOP | 14:34 | 9 | -1,156 | -1,527 |
| NIFTY | 10-23 | 10:00 | PE | — | CHOPPY | 128.70 | TARGET | 10:09 | 9 | 2,402 | 2,293 |
| NIFTY | 10-23 | 13:45 | CE | — | TRANSITION | 185.90 | STOP | 13:46 | 1 | -1,385 | -1,534 |

### C1 rejection

| Index | Date | Entry | Option side | Level(s) | Regime | Premium in ₹ | Result | Exit | Minutes | Net ₹ | Net ₹ conservative |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NIFTY | 10-01 | 10:20 | PE | ORB high | CHOPPY | 110.15 | STOP | 10:37 | 17 | -1,309 | -1,386 |
| SENSEX | 10-01 | 10:40 | PE | PDC | TRENDING_DOWN | 200.80 | TIME | 11:40 | 60 | 537 | 494 |
| SENSEX | 10-01 | 11:00 | CE | ORB high | TRANSITION | 196.45 | STOP | 11:23 | 23 | -1,030 | -1,155 |
| NIFTY | 10-05 | 09:40 | CE | ORB high, owner S/R | UNKNOWN_DATA | 101.75 | STOP | 10:01 | 21 | -1,256 | -1,327 |
| SENSEX | 10-05 | 09:40 | CE | ORB high | UNKNOWN_DATA | 528.00 | STOP | 10:01 | 21 | -1,025 | -1,126 |
| NIFTY | 10-05 | 11:35 | PE | ORB low | TRANSITION | 82.80 | TARGET | 11:51 | 16 | 2,260 | 2,186 |
| SENSEX | 10-06 | 09:55 | CE | PDH | TRANSITION | 398.30 | STOP | 10:10 | 15 | -754 | -869 |
| SENSEX | 10-07 | 09:35 | PE | ORB high | UNKNOWN_DATA | 336.55 | STOP | 10:07 | 32 | -822 | -885 |
| NIFTY | 10-07 | 10:00 | CE | ORB low | TRANSITION | 159.00 | STOP | 10:03 | 3 | -1,039 | -1,154 |
| SENSEX | 10-07 | 10:05 | CE | ORB low, owner S/R | CHOPPY | 301.75 | TARGET | 10:18 | 13 | 1,577 | 1,508 |
| NIFTY | 10-07 | 11:35 | CE | owner S/R | TRANSITION | 161.80 | TARGET | 12:05 | 30 | 2,129 | 1,997 |
| NIFTY | 10-08 | 09:40 | PE | owner S/R | UNKNOWN_DATA | 137.60 | TARGET | 10:40 | 60 | 2,311 | 2,196 |
| SENSEX | 10-08 | 09:40 | PE | owner S/R | UNKNOWN_DATA | 192.20 | TIME | 10:40 | 60 | 1,523 | 1,477 |
| NIFTY | 10-08 | 10:00 | PE | ORB low | TRENDING_DOWN | 123.10 | TIME | 11:00 | 60 | 1,108 | 1,009 |
| SENSEX | 10-08 | 11:10 | PE | owner S/R | TRENDING_DOWN | 168.70 | TARGET | 11:26 | 16 | 1,411 | 1,370 |
| SENSEX | 10-09 | 09:55 | CE | owner S/R | TRANSITION | 612.20 | TIME | 10:55 | 60 | 297 | 172 |
| SENSEX | 10-12 | 10:20 | CE | owner S/R | TRANSITION | 477.20 | STOP | 10:51 | 31 | -1,557 | -1,665 |
| NIFTY | 10-13 | 10:25 | PE | owner S/R | TRENDING_UP | 55.10 | TARGET | 10:40 | 15 | 2,131 | 2,078 |
| SENSEX | 10-13 | 11:30 | CE | ORB high | TRENDING_UP | 430.35 | TARGET | 11:42 | 12 | 1,648 | 1,553 |
| NIFTY | 10-14 | 09:35 | CE | ORB low | UNKNOWN_DATA | 151.00 | TIME | 10:35 | 60 | 159 | 44 |
| NIFTY | 10-14 | 09:50 | PE | ORB high | TRENDING_UP | 155.35 | TIME | 10:50 | 60 | -171 | -287 |
| SENSEX | 10-14 | 09:50 | PE | ORB high | TRENDING_UP | 373.45 | TIME | 10:50 | 60 | -266 | -340 |
| SENSEX | 10-14 | 10:35 | CE | PDC | TRANSITION | 275.95 | STOP | 11:30 | 55 | -1,219 | -1,312 |
| NIFTY | 10-14 | 10:50 | CE | PDH | TRENDING_UP | 136.80 | STOP | 11:08 | 18 | -1,417 | -1,513 |
| SENSEX | 10-14 | 11:10 | CE | PDH | TRENDING_UP | 322.60 | STOP | 11:30 | 20 | -1,140 | -1,350 |
| NIFTY | 10-16 | 09:50 | CE | ORB low | TRANSITION | 104.30 | TARGET | 10:01 | 11 | 3,038 | 2,944 |
| NIFTY | 10-19 | 09:40 | PE | PDH, PDC, owner S/R | UNKNOWN_DATA | 81.50 | TIME | 10:40 | 60 | 3,470 | 3,391 |
| SENSEX | 10-19 | 09:40 | PE | PDH, PDC | UNKNOWN_DATA | 450.75 | TIME | 10:40 | 60 | 3,102 | 2,996 |
| NIFTY | 10-19 | 12:10 | PE | ORB low | TRANSITION | 58.70 | TIME | 13:10 | 60 | 463 | 416 |
| SENSEX | 10-19 | 12:30 | PE | PDL | TRANSITION | 416.75 | STOP | 13:05 | 35 | -959 | -1,038 |
| NIFTY | 10-21 | 09:40 | CE | owner S/R | UNKNOWN_DATA | 184.40 | STOP | 09:47 | 7 | -1,620 | -1,750 |
| NIFTY | 10-21 | 10:45 | PE | owner S/R | TRANSITION | 152.00 | TARGET | 11:21 | 36 | 2,670 | 2,542 |

### C2 acceptance

| Index | Date | Entry | Option side | Level(s) | Regime | Premium in ₹ | Result | Exit | Minutes | Net ₹ | Net ₹ conservative |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SENSEX | 10-01 | 10:05 | CE | PDL, ORB high, owner S/R | CHOPPY | 213.00 | STOP | 10:11 | 6 | -1,020 | -1,058 |
| NIFTY | 10-01 | 10:10 | CE | ORB high | CHOPPY | 130.15 | STOP | 11:09 | 59 | -1,348 | -1,440 |
| SENSEX | 10-01 | 10:10 | CE | PDC | CHOPPY | 171.10 | STOP | 11:09 | 59 | -1,044 | -1,107 |
| NIFTY | 10-01 | 10:20 | PE | ORB high | CHOPPY | 110.15 | STOP | 10:37 | 17 | -1,309 | -1,386 |
| SENSEX | 10-01 | 10:20 | PE | PDC | CHOPPY | 180.20 | TIME | 11:20 | 60 | 37 | 0 |
| SENSEX | 10-01 | 11:10 | PE | ORB high, owner S/R | TRANSITION | 164.45 | STOP | 11:18 | 8 | -631 | -715 |
| SENSEX | 10-01 | 11:15 | PE | PDL | TRANSITION | 197.75 | STOP | 11:38 | 23 | -752 | -801 |
| SENSEX | 10-01 | 12:20 | PE | owner S/R | TRANSITION | 179.75 | TARGET | 12:29 | 9 | 1,169 | 1,127 |
| NIFTY | 10-01 | 12:25 | PE | ORB low | CHOPPY | 127.20 | TARGET | 12:45 | 20 | 1,559 | 1,455 |
| SENSEX | 10-05 | 09:40 | CE | ORB high | UNKNOWN_DATA | 528.00 | STOP | 10:01 | 21 | -1,025 | -1,126 |
| SENSEX | 10-05 | 09:55 | CE | PDH | TRENDING_UP | 500.65 | STOP | 10:00 | 5 | -921 | -1,543 |
| NIFTY | 10-05 | 10:05 | PE | owner S/R | TRENDING_UP | 89.85 | TARGET | 10:26 | 21 | 1,933 | 1,855 |
| SENSEX | 10-05 | 10:05 | PE | PDH | TRENDING_UP | 446.05 | TARGET | 10:26 | 21 | 1,888 | 1,789 |
| SENSEX | 10-05 | 10:10 | PE | ORB high | TRENDING_UP | 421.65 | TARGET | 10:26 | 16 | 1,902 | 1,808 |
| NIFTY | 10-05 | 10:30 | PE | ORB low | TRANSITION | 81.75 | TARGET | 10:56 | 26 | 1,856 | 1,785 |
| SENSEX | 10-05 | 10:30 | PE | ORB low | TRENDING_UP | 453.15 | TARGET | 10:56 | 26 | 1,893 | 1,792 |
| SENSEX | 10-05 | 11:35 | CE | owner S/R | TRANSITION | 542.40 | STOP | 11:40 | 5 | -969 | -1,073 |
| SENSEX | 10-05 | 12:15 | PE | PDC | TRANSITION | 448.15 | STOP | 12:24 | 9 | -994 | -1,079 |
| NIFTY | 10-05 | 12:25 | CE | PDC | TRANSITION | 106.60 | TIME | 13:25 | 60 | 571 | 488 |
| SENSEX | 10-05 | 12:25 | CE | PDC | TRANSITION | 547.95 | TIME | 13:25 | 60 | 451 | 339 |
| SENSEX | 10-05 | 13:30 | PE | owner S/R | TRANSITION | 462.95 | STOP | 13:37 | 7 | -937 | -1,093 |
| NIFTY | 10-05 | 13:50 | CE | ORB low | TRANSITION | 99.30 | STOP | 14:05 | 15 | -1,003 | -1,589 |
| SENSEX | 10-05 | 13:50 | CE | ORB low | TRANSITION | 528.30 | STOP | 14:05 | 15 | -894 | -1,145 |
| NIFTY | 10-06 | 09:40 | CE | ORB high | UNKNOWN_DATA | 71.85 | TARGET | 09:57 | 17 | 1,616 | 1,553 |
| SENSEX | 10-06 | 09:40 | CE | ORB high | UNKNOWN_DATA | 408.20 | TARGET | 09:57 | 17 | 1,312 | 1,224 |
| NIFTY | 10-06 | 09:55 | CE | PDH | TRANSITION | 57.40 | STOP | 10:10 | 15 | -795 | -901 |
| SENSEX | 10-06 | 09:55 | CE | PDH, owner S/R | TRANSITION | 398.30 | STOP | 10:10 | 15 | -754 | -869 |
| NIFTY | 10-06 | 10:45 | CE | owner S/R | TRENDING_UP | 42.45 | STOP | 10:53 | 8 | -717 | -746 |
| SENSEX | 10-06 | 12:45 | CE | owner S/R | TRENDING_UP | 375.20 | STOP | 12:52 | 7 | -614 | -715 |
| SENSEX | 10-06 | 14:35 | PE | owner S/R | COMPRESSION | 368.50 | STOP | 14:41 | 6 | -580 | -651 |
| SENSEX | 10-07 | 09:50 | CE | ORB low | TRANSITION | 322.25 | STOP | 10:03 | 13 | -892 | -1,309 |
| NIFTY | 10-07 | 10:25 | CE | ORB high, owner S/R | CHOPPY | 157.20 | STOP | 10:37 | 12 | -1,215 | -1,397 |
| SENSEX | 10-07 | 10:25 | CE | ORB high | CHOPPY | 288.25 | TARGET | 10:30 | 5 | 1,687 | 1,620 |
| NIFTY | 10-07 | 10:30 | CE | owner S/R | CHOPPY | 151.15 | STOP | 10:35 | 5 | -1,138 | -1,825 |
| NIFTY | 10-07 | 10:40 | PE | owner S/R | CHOPPY | 153.95 | STOP | 10:55 | 15 | -1,488 | -1,678 |
| NIFTY | 10-07 | 13:05 | PE | ORB high, owner S/R | TRANSITION | 142.90 | TARGET | 13:10 | 5 | 1,527 | 1,412 |
| NIFTY | 10-07 | 13:15 | PE | ORB low | TRANSITION | 162.40 | STOP | 13:30 | 15 | -1,124 | -1,241 |
| SENSEX | 10-07 | 13:15 | PE | ORB high, ORB low | TRANSITION | 330.55 | STOP | 13:30 | 15 | -818 | -881 |
| NIFTY | 10-07 | 14:15 | PE | PDL | TRANSITION | 137.60 | STOP | 14:19 | 4 | -1,153 | -1,251 |
| NIFTY | 10-08 | 09:50 | PE | ORB low | TRENDING_DOWN | 126.00 | TIME | 10:50 | 60 | -175 | -269 |
| SENSEX | 10-08 | 09:50 | PE | ORB low | TRENDING_DOWN | 213.30 | STOP | 10:13 | 23 | -945 | -985 |
| SENSEX | 10-08 | 10:40 | PE | owner S/R | TRANSITION | 157.95 | STOP | 10:44 | 4 | -639 | -706 |
| NIFTY | 10-09 | 09:40 | CE | ORB high | UNKNOWN_DATA | 153.30 | TARGET | 10:13 | 33 | 3,086 | 2,955 |
| SENSEX | 10-09 | 09:40 | CE | ORB high | UNKNOWN_DATA | 642.30 | TARGET | 09:57 | 17 | 2,373 | 2,232 |
| SENSEX | 10-09 | 09:55 | CE | owner S/R | TRANSITION | 612.20 | TIME | 10:55 | 60 | 297 | 172 |
| NIFTY | 10-09 | 11:25 | CE | owner S/R | TRENDING_UP | 144.10 | STOP | 11:35 | 10 | -1,130 | -1,233 |
| SENSEX | 10-09 | 11:30 | PE | owner S/R | TRENDING_UP | 467.00 | TARGET | 11:44 | 14 | 1,192 | 1,092 |
| NIFTY | 10-09 | 11:35 | PE | owner S/R | TRENDING_UP | 115.95 | TARGET | 12:00 | 25 | 1,633 | 1,537 |
| SENSEX | 10-09 | 13:50 | CE | owner S/R | TRANSITION | 576.40 | STOP | 13:55 | 5 | -682 | -844 |
| SENSEX | 10-09 | 14:05 | CE | PDH | TRANSITION | 570.80 | TARGET | 14:19 | 14 | 1,237 | 1,116 |
| SENSEX | 10-09 | 14:15 | CE | owner S/R | TRANSITION | 522.85 | TARGET | 14:19 | 4 | 1,169 | 1,058 |
| NIFTY | 10-09 | 14:25 | CE | owner S/R | TRENDING_UP | 130.05 | STOP | 14:41 | 16 | -1,017 | -1,328 |
| NIFTY | 10-12 | 09:40 | PE | PDH, owner S/R | UNKNOWN_DATA | 84.85 | TIME | 10:40 | 60 | 1,190 | 1,120 |
| SENSEX | 10-12 | 09:40 | PE | PDC, owner S/R | UNKNOWN_DATA | 463.00 | TIME | 10:40 | 60 | 1,443 | 1,343 |
| SENSEX | 10-12 | 09:45 | PE | ORB low | TRANSITION | 480.15 | TIME | 10:45 | 60 | 1,653 | 1,548 |
| NIFTY | 10-12 | 10:00 | PE | ORB low | TRANSITION | 87.90 | TIME | 11:00 | 60 | 3,234 | 3,151 |
| SENSEX | 10-12 | 10:35 | PE | owner S/R | TRANSITION | 462.70 | TARGET | 11:05 | 30 | 1,746 | 1,644 |
| SENSEX | 10-12 | 14:20 | PE | PDL | TRANSITION | 416.95 | TARGET | 14:44 | 24 | 1,152 | 1,063 |
| NIFTY | 10-13 | 09:40 | CE | ORB high | UNKNOWN_DATA | 76.65 | TARGET | 09:55 | 15 | 2,304 | 2,234 |
| SENSEX | 10-13 | 09:40 | CE | ORB high | UNKNOWN_DATA | 460.85 | TARGET | 09:55 | 15 | 2,142 | 2,039 |
| NIFTY | 10-13 | 09:55 | CE | owner S/R | TRENDING_UP | 73.70 | STOP | 10:19 | 24 | -1,086 | -1,349 |
| SENSEX | 10-13 | 09:55 | CE | owner S/R | TRENDING_UP | 442.20 | STOP | 10:20 | 25 | -1,059 | -1,231 |
| NIFTY | 10-13 | 10:25 | PE | owner S/R | TRENDING_UP | 55.10 | TARGET | 10:40 | 15 | 2,131 | 2,078 |
| SENSEX | 10-13 | 13:05 | PE | owner S/R | TRANSITION | 322.05 | STOP | 13:11 | 6 | -595 | -657 |
| NIFTY | 10-14 | 09:50 | CE | PDH | TRENDING_UP | 147.00 | STOP | 10:08 | 18 | -2,017 | -2,255 |
| SENSEX | 10-14 | 09:50 | CE | PDH, PDC | TRENDING_UP | 277.80 | STOP | 10:08 | 18 | -1,423 | -1,559 |
| NIFTY | 10-14 | 10:00 | PE | PDH | TRENDING_UP | 143.80 | STOP | 11:00 | 60 | -1,586 | -1,687 |
| SENSEX | 10-14 | 13:00 | PE | PDH, PDC | TRANSITION | 308.10 | TARGET | 13:02 | 2 | 1,225 | 1,156 |
| NIFTY | 10-14 | 13:05 | PE | ORB low | TRANSITION | 148.95 | TARGET | 13:09 | 4 | 1,483 | 1,363 |
| NIFTY | 10-14 | 13:10 | PE | owner S/R | TRANSITION | 167.00 | STOP | 13:30 | 20 | -1,045 | -1,166 |
| SENSEX | 10-14 | 13:10 | PE | ORB low, owner S/R | TRANSITION | 386.95 | STOP | 13:29 | 19 | -952 | -1,025 |
| NIFTY | 10-14 | 13:30 | CE | owner S/R | TRENDING_DOWN | 136.95 | TARGET | 13:48 | 18 | 2,387 | 2,272 |
| NIFTY | 10-14 | 14:00 | CE | owner S/R | TRANSITION | 143.70 | STOP | 14:08 | 8 | -1,270 | -1,372 |
| SENSEX | 10-14 | 14:00 | CE | owner S/R | TRANSITION | 257.35 | STOP | 14:06 | 6 | -997 | -1,072 |
| NIFTY | 10-15 | 09:40 | CE | ORB high | UNKNOWN_DATA | 136.25 | TARGET | 09:54 | 14 | 2,613 | 2,497 |
| SENSEX | 10-15 | 09:40 | CE | ORB high | UNKNOWN_DATA | 214.50 | TARGET | 09:54 | 14 | 1,978 | 1,925 |
| NIFTY | 10-15 | 09:55 | CE | PDH | TRENDING_UP | 123.30 | TARGET | 10:15 | 20 | 2,585 | 2,479 |
| NIFTY | 10-16 | 09:40 | PE | ORB low | UNKNOWN_DATA | 143.50 | STOP | 09:41 | 1 | -1,733 | -1,833 |
| SENSEX | 10-16 | 09:40 | PE | ORB low | UNKNOWN_DATA | 581.90 | STOP | 09:43 | 3 | -1,378 | -1,488 |
| NIFTY | 10-16 | 09:50 | CE | ORB low | TRANSITION | 104.30 | TARGET | 10:01 | 11 | 3,038 | 2,944 |
| SENSEX | 10-16 | 09:50 | CE | ORB low | TRANSITION | 482.45 | TARGET | 10:02 | 12 | 2,642 | 2,531 |
| SENSEX | 10-16 | 10:05 | CE | PDH, PDC | TRANSITION | 499.15 | TARGET | 10:18 | 13 | 2,024 | 1,914 |
| SENSEX | 10-16 | 10:10 | CE | ORB high | TRANSITION | 486.55 | TARGET | 10:18 | 8 | 1,997 | 1,889 |
| NIFTY | 10-16 | 10:15 | CE | PDH | TRANSITION | 98.70 | TARGET | 10:20 | 5 | 1,840 | 1,756 |
| NIFTY | 10-19 | 09:40 | CE | owner S/R | UNKNOWN_DATA | 67.35 | STOP | 09:57 | 17 | -2,449 | -2,516 |
| NIFTY | 10-19 | 09:55 | PE | owner S/R | TRANSITION | 64.35 | TIME | 10:55 | 60 | 2,206 | 2,146 |
| SENSEX | 10-19 | 09:55 | PE | PDC | TRANSITION | 436.70 | TIME | 10:55 | 60 | 2,317 | 2,218 |
| SENSEX | 10-19 | 10:05 | PE | owner S/R | TRANSITION | 468.40 | TIME | 11:05 | 60 | -121 | -214 |
| NIFTY | 10-19 | 11:40 | PE | owner S/R | TRANSITION | 71.45 | STOP | 11:45 | 5 | -1,104 | -1,153 |
| SENSEX | 10-19 | 12:05 | PE | ORB low | TRANSITION | 465.30 | STOP | 12:08 | 3 | -954 | -1,067 |
| NIFTY | 10-19 | 12:10 | PE | ORB low | TRANSITION | 58.70 | TIME | 13:10 | 60 | 463 | 416 |
| SENSEX | 10-19 | 12:25 | PE | PDL | TRENDING_DOWN | 431.50 | STOP | 13:04 | 39 | -1,006 | -1,087 |
| SENSEX | 10-19 | 12:40 | CE | PDL | TRENDING_DOWN | 401.45 | STOP | 12:55 | 15 | -938 | -1,014 |
| NIFTY | 10-19 | 13:25 | PE | PDL | TRENDING_DOWN | 44.70 | STOP | 13:27 | 2 | -705 | -735 |
| NIFTY | 10-21 | 09:40 | CE | ORB high, owner S/R | UNKNOWN_DATA | 184.40 | STOP | 09:47 | 7 | -1,620 | -1,750 |
| SENSEX | 10-21 | 09:40 | CE | ORB high | UNKNOWN_DATA | 330.00 | STOP | 09:47 | 7 | -1,168 | -1,286 |
| NIFTY | 10-21 | 09:50 | PE | owner S/R | TRENDING_UP | 159.15 | TARGET | 10:06 | 16 | 2,427 | 2,295 |
| NIFTY | 10-21 | 09:55 | PE | ORB high | TRENDING_UP | 169.75 | TARGET | 10:06 | 11 | 2,431 | 2,291 |
| SENSEX | 10-21 | 09:55 | PE | ORB high, owner S/R | TRENDING_UP | 326.10 | TARGET | 10:06 | 11 | 2,068 | 1,992 |
| NIFTY | 10-21 | 10:00 | PE | owner S/R | TRENDING_UP | 148.75 | TARGET | 10:08 | 8 | 2,233 | 2,109 |
| SENSEX | 10-21 | 10:10 | PE | ORB low, owner S/R | TRENDING_UP | 334.10 | STOP | 10:35 | 25 | -1,015 | -1,077 |
| NIFTY | 10-21 | 10:15 | PE | owner S/R | TRANSITION | 166.35 | STOP | 10:34 | 19 | -1,410 | -1,807 |
| NIFTY | 10-21 | 11:30 | PE | PDC, owner S/R | TRANSITION | 173.85 | TARGET | 11:41 | 11 | 2,605 | 2,461 |
| SENSEX | 10-21 | 11:40 | PE | owner S/R | TRANSITION | 351.60 | TARGET | 12:10 | 30 | 1,703 | 1,624 |
| NIFTY | 10-21 | 11:45 | PE | PDL | TRANSITION | 183.55 | TARGET | 12:14 | 29 | 2,410 | 2,260 |
| SENSEX | 10-21 | 11:45 | PE | PDC | TRANSITION | 386.00 | TARGET | 12:13 | 28 | 1,824 | 1,737 |
| SENSEX | 10-22 | 09:45 | CE | ORB low, owner S/R | CHOPPY | 285.15 | STOP | 10:03 | 18 | -1,864 | -2,158 |
| NIFTY | 10-22 | 09:50 | CE | ORB high | CHOPPY | 172.10 | STOP | 10:04 | 14 | -2,158 | -2,277 |
| NIFTY | 10-22 | 10:10 | PE | ORB high | CHOPPY | 148.95 | STOP | 10:13 | 3 | -2,205 | -2,307 |
| SENSEX | 10-22 | 10:10 | PE | PDL, ORB high | CHOPPY | 265.65 | STOP | 10:16 | 6 | -1,731 | -1,809 |
| NIFTY | 10-22 | 10:20 | CE | PDL, owner S/R | CHOPPY | 173.85 | TARGET | 10:24 | 4 | 3,871 | 3,721 |
| SENSEX | 10-22 | 10:20 | CE | PDL, ORB high | CHOPPY | 238.75 | TARGET | 10:24 | 4 | 3,335 | 3,270 |
| NIFTY | 10-22 | 10:40 | CE | owner S/R | TRANSITION | 172.25 | STOP | 10:46 | 6 | -1,796 | -2,009 |
| NIFTY | 10-22 | 11:55 | PE | PDL, owner S/R | TRANSITION | 163.05 | STOP | 12:28 | 33 | -1,393 | -1,577 |
| SENSEX | 10-22 | 12:25 | PE | owner S/R | TRANSITION | 181.80 | STOP | 12:27 | 2 | -997 | -1,029 |
| NIFTY | 10-23 | 09:40 | PE | PDC, ORB low, owner S/R | UNKNOWN_DATA | 136.05 | TARGET | 10:00 | 20 | 3,018 | 2,900 |
| SENSEX | 10-23 | 09:40 | PE | ORB low | UNKNOWN_DATA | 537.50 | TARGET | 10:00 | 20 | 2,285 | 2,165 |
| SENSEX | 10-23 | 10:05 | PE | PDC | CHOPPY | 581.65 | TARGET | 10:15 | 10 | 2,076 | 1,948 |
| NIFTY | 10-23 | 10:15 | PE | PDL | TRANSITION | 128.95 | TARGET | 10:59 | 44 | 2,393 | 2,283 |
| SENSEX | 10-23 | 10:15 | PE | PDL | TRANSITION | 580.70 | TARGET | 10:59 | 44 | 2,718 | 2,588 |
| SENSEX | 10-23 | 13:50 | CE | PDL | TRANSITION | 836.00 | STOP | 13:53 | 3 | -1,332 | -1,700 |

### C3 EMA filtered

| Index | Date | Entry | Option side | Level(s) | Regime | Premium in ₹ | Result | Exit | Minutes | Net ₹ | Net ₹ conservative |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SENSEX | 10-01 | 09:55 | PE | — | CHOPPY | 190.95 | STOP | 10:00 | 5 | -1,021 | -1,060 |
| SENSEX | 10-01 | 12:10 | PE | — | TRANSITION | 180.50 | TARGET | 12:20 | 10 | 1,276 | 1,233 |
| SENSEX | 10-01 | 12:15 | PE | — | TRANSITION | 148.15 | TARGET | 12:24 | 9 | 1,104 | 1,068 |
| NIFTY | 10-05 | 09:30 | CE | — | UNKNOWN_DATA | 124.70 | TARGET | 09:33 | 3 | 635 | 538 |
| NIFTY | 10-05 | 09:50 | CE | — | TRENDING_UP | 108.00 | STOP | 10:00 | 10 | -1,219 | -1,677 |
| NIFTY | 10-05 | 11:50 | PE | — | TRANSITION | 81.10 | TARGET | 12:01 | 11 | 1,591 | 1,521 |
| NIFTY | 10-06 | 09:35 | CE | — | UNKNOWN_DATA | 68.70 | TARGET | 09:56 | 21 | 1,705 | 1,644 |
| SENSEX | 10-06 | 09:40 | CE | — | UNKNOWN_DATA | 408.20 | TARGET | 09:57 | 17 | 1,312 | 1,224 |
| NIFTY | 10-06 | 09:50 | CE | — | TRANSITION | 53.90 | STOP | 10:11 | 21 | -786 | -823 |
| SENSEX | 10-06 | 09:55 | CE | — | TRANSITION | 398.30 | STOP | 10:10 | 15 | -754 | -869 |
| SENSEX | 10-08 | 09:25 | PE | — | UNKNOWN_DATA | 216.75 | TARGET | 09:26 | 1 | 138 | 93 |
| SENSEX | 10-08 | 09:35 | PE | — | UNKNOWN_DATA | 188.95 | TIME | 10:35 | 60 | 624 | 583 |
| NIFTY | 10-09 | 09:25 | CE | — | UNKNOWN_DATA | 154.30 | TARGET | 09:27 | 2 | 635 | 516 |
| NIFTY | 10-09 | 09:30 | CE | — | UNKNOWN_DATA | 129.10 | STOP | 09:32 | 2 | -490 | -585 |
| SENSEX | 10-12 | 09:40 | PE | — | UNKNOWN_DATA | 463.00 | TIME | 10:40 | 60 | 1,443 | 1,343 |
| NIFTY | 10-12 | 09:55 | PE | — | TRANSITION | 106.90 | STOP | 09:57 | 2 | -1,821 | -1,990 |
| NIFTY | 10-13 | 09:25 | CE | — | UNKNOWN_DATA | 78.10 | STOP | 09:28 | 3 | -490 | -547 |
| SENSEX | 10-13 | 09:25 | CE | — | UNKNOWN_DATA | 468.40 | TARGET | 09:26 | 1 | 113 | 18 |
| SENSEX | 10-13 | 12:30 | CE | — | CHOPPY | 410.20 | STOP | 13:24 | 54 | -859 | -937 |
| NIFTY | 10-14 | 11:35 | PE | — | TRANSITION | 156.90 | STOP | 11:46 | 11 | -1,163 | -1,307 |
| SENSEX | 10-14 | 11:35 | PE | — | TRANSITION | 350.10 | STOP | 11:45 | 10 | -999 | -1,088 |
| SENSEX | 10-15 | 09:40 | CE | — | UNKNOWN_DATA | 214.50 | TARGET | 09:54 | 14 | 1,978 | 1,925 |
| SENSEX | 10-15 | 09:50 | CE | — | TRENDING_UP | 193.50 | TARGET | 09:55 | 5 | 1,856 | 1,807 |
| NIFTY | 10-16 | 10:10 | CE | — | TRANSITION | 104.05 | TARGET | 10:18 | 8 | 2,201 | 2,111 |
| NIFTY | 10-19 | 09:30 | PE | — | UNKNOWN_DATA | 101.45 | STOP | 09:31 | 1 | -490 | -572 |
| SENSEX | 10-19 | 10:05 | PE | — | TRANSITION | 468.40 | TIME | 11:05 | 60 | -121 | -214 |
| SENSEX | 10-19 | 10:40 | PE | — | TRANSITION | 440.45 | TIME | 11:40 | 60 | 2,530 | 2,429 |
| NIFTY | 10-19 | 10:50 | PE | — | TRANSITION | 75.00 | STOP | 11:00 | 10 | -1,633 | -1,694 |
| NIFTY | 10-19 | 11:40 | PE | — | TRANSITION | 71.45 | STOP | 11:45 | 5 | -1,104 | -1,153 |
| SENSEX | 10-19 | 11:40 | PE | — | TRANSITION | 453.35 | STOP | 11:49 | 9 | -1,011 | -1,097 |
| SENSEX | 10-19 | 12:05 | PE | — | TRANSITION | 465.30 | STOP | 12:08 | 3 | -954 | -1,067 |
| SENSEX | 10-21 | 09:45 | CE | — | TRENDING_UP | 344.80 | STOP | 09:50 | 5 | -1,264 | -1,327 |
| SENSEX | 10-21 | 11:50 | PE | — | TRANSITION | 381.85 | TARGET | 12:13 | 23 | 1,824 | 1,738 |
| SENSEX | 10-21 | 12:00 | PE | — | TRENDING_DOWN | 340.95 | TARGET | 12:14 | 14 | 1,881 | 1,803 |
| SENSEX | 10-22 | 09:25 | PE | — | UNKNOWN_DATA | 302.25 | STOP | 09:26 | 1 | -170 | -441 |
| SENSEX | 10-22 | 10:05 | PE | — | CHOPPY | 258.35 | STOP | 10:09 | 4 | -1,494 | -1,539 |
| NIFTY | 10-22 | 10:30 | CE | — | TRANSITION | 179.60 | TIME | 11:30 | 60 | 1,542 | 1,399 |
| SENSEX | 10-22 | 11:15 | CE | — | TRANSITION | 221.45 | STOP | 11:22 | 7 | -1,154 | -1,193 |
| NIFTY | 10-22 | 11:55 | PE | — | TRANSITION | 163.05 | STOP | 12:28 | 33 | -1,393 | -1,577 |
| NIFTY | 10-23 | 10:00 | PE | — | CHOPPY | 128.70 | TARGET | 10:09 | 9 | 2,402 | 2,293 |

### C4 fake-up + OI

| Index | Date | Entry | Option side | Level(s) | Regime | Premium in ₹ | Result | Exit | Minutes | Net ₹ | Net ₹ conservative |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SENSEX | 10-01 | 11:05 | PE | owner S/R | TRANSITION | 195.00 | STOP | 11:38 | 33 | -809 | -845 |
| SENSEX | 10-01 | 12:15 | PE | owner S/R | TRANSITION | 148.15 | TARGET | 12:24 | 9 | 1,104 | 1,068 |
| SENSEX | 10-05 | 10:25 | PE | owner S/R | TRENDING_UP | 413.30 | TARGET | 10:56 | 31 | 1,565 | 1,474 |
| NIFTY | 10-06 | 11:00 | PE | owner S/R | TRENDING_UP | 49.70 | STOP | 11:06 | 6 | -896 | -1,107 |
| SENSEX | 10-06 | 14:30 | PE | owner S/R | COMPRESSION | 384.15 | STOP | 14:33 | 3 | -562 | -637 |
| NIFTY | 10-07 | 13:00 | PE | owner S/R | TRANSITION | 137.40 | TARGET | 13:09 | 9 | 1,476 | 1,365 |
| SENSEX | 10-07 | 13:10 | PE | owner S/R | TRANSITION | 297.65 | STOP | 13:14 | 4 | -655 | -711 |
| SENSEX | 10-08 | 10:25 | PE | owner S/R | TRANSITION | 157.45 | TARGET | 11:23 | 58 | 1,356 | 1,317 |
| NIFTY | 10-13 | 10:20 | PE | owner S/R | TRENDING_UP | 53.95 | TARGET | 10:40 | 20 | 2,206 | 2,154 |
| SENSEX | 10-13 | 10:25 | PE | owner S/R | TRENDING_UP | 331.80 | TARGET | 10:40 | 15 | 1,617 | 1,542 |
| NIFTY | 10-21 | 09:55 | PE | owner S/R | TRENDING_UP | 169.75 | TARGET | 10:06 | 11 | 2,431 | 2,291 |
| SENSEX | 10-21 | 10:05 | PE | owner S/R | TRENDING_UP | 345.80 | TARGET | 10:13 | 8 | 1,888 | 1,809 |
| NIFTY | 10-22 | 11:50 | PE | owner S/R | TRANSITION | 144.80 | STOP | 11:56 | 6 | -1,235 | -1,373 |

## 10. Data quality and limits

- Index: 1-min CLOSE only → 5-min candle highs / lows (and wick %) come from minute closes and understate true wicks.
- Options: ATM±3 1-min legs (O/H/L/C, volume, OI, IV); a strike exists only while inside the rolling ±3 band; OI positioning is read at the level strike only when that strike is inside the band (else n/a, which C2's OI exclusion does not accept).
- The app's ±10-strike OI log is complete on only 6 of the 15 sessions and is not used.
- Exits use the premium's 1-min high / low; the order of SL and target inside one minute is unknown (ambiguous → stop).
- 15 sessions, overlapping trades on the same days, and variants compared on the same dates: every number here is exploratory.
