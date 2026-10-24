# Day process replay — 2026-10-23 — NIFTY and SENSEX

> Simulated historical replay of the owner's day process, not live trading. Rules are in the header of dayProcess.ts.

## NIFTY

### Step 1 — 09:15 levels (known before the open)

Open 22758.4 · PDH 22779.0 · PDL 22560.4 · PDC 22687.7 · gap +70.8 pts

| Level | Type | Distance from open |
|---|---|---|
| 22894.1 | S/R FLIP | +135.7 |
| 22779.0 | PDH | +20.6 |
| 22707.3 | S/R FLIP | -51.1 |
| 22687.7 | PDC | -70.8 |

(7 owner S/R levels from the previous 5 sessions; listed: those within 3 × 15-min ATR ≈ 150 pts of the open.)

### Step 2 — 09:30 first 15 minutes + OI

First-15 HIGH 22784.9 · LOW 22711.2 · range 73.7 pts · price at 09:30 22726.5

OI snapshots used: 09:15 → 09:30

| Strike | Call OI added 09:15→09:30 | Put OI added 09:15→09:30 |
|---|---|---|
| 22850 | 13,81,510 | 9,11,170 |
| 22800 | 43,46,355 | 45,60,595 |
| 22750 | 21,48,575 | 41,13,720 |
| 22700 | 11,83,780 | 56,81,650 |
| 22650 | -2,11,640 | 19,78,080 |
| 22600 | -92,235 | 16,42,680 |

Call OI added 1,69,40,105 · Put OI added 2,95,85,140 → PUT writers stronger (bullish). Biggest CALL wall above: 23000 (1,75,62,350) · biggest PUT wall below: 22700 (1,30,48,425)

### Step 3 — 09:30 trend

vs previous close: above (+) · vs 5-min EMA 21 (22673.0): above (+) · OI: + → **UP**

### Steps 4–5 — every 5-min close: breakout / breakdown + premium cross-check

| Time | Event | Level | Index close | Trend agrees? | ATM premium (close · E9 · E21) | Decision | Outcome with the same exit (conservative ₹) |
|---|---|---|---|---|---|---|---|
| 09:40 | BREAKDOWN ↓ (candle 09:35 + hold) | S/R FLIP 22707.3 | 22686.9 | no | PE 22700: 135.8 · 143.3 · 164.6 | SKIP — against the 09:30 trend | HARD STOP 09:43: -32.3 pts (best 0.0), ₹37 |
| 09:40 | BREAKDOWN ↓ (candle 09:35 + hold) | PDC 22687.7 | 22686.9 | no | PE 22700: 135.8 · 143.3 · 164.6 | SKIP — against the 09:30 trend | HARD STOP 09:43: -32.3 pts (best 0.0), ₹37 |
| 09:40 | BREAKDOWN ↓ (candle 09:35 + hold) | First-15 LOW 22711.2 | 22686.9 | no | PE 22700: 135.8 · 143.3 · 164.6 | SKIP — against the 09:30 trend | HARD STOP 09:43: -32.3 pts (best 0.0), ₹37 |
| 09:40 | BREAKDOWN ↓ (candle 09:35 + hold) | OI PUT wall 22700.0 | 22686.9 | no | PE 22700: 135.8 · 143.3 · 164.6 | SKIP — against the 09:30 trend | HARD STOP 09:43: -32.3 pts (best 0.0), ₹37 |
| 10:15 | BREAKDOWN ↓ (candle 10:10 + hold) | PDL 22560.4 | 22504.6 | no | PE 22500: 135.0 · 101.4 · 94.8 (fresh cross) | SKIP — against the 09:30 trend | TARGET +30 10:16: +32.3 pts (best 32.3), ₹403 |
| 13:50 | BREAKOUT ↑ (candle 13:45 + hold) | PDL 22560.4 | 22561.3 | yes | CE 22550: 198.2 · 153.0 · 138.5 (fresh cross) | TRADE | HARD STOP 13:54: -45.4 pts (best 0.0), ₹-1,727 |

### Trades

| Entry | Side | Level | Index entry → hard stop | Exit | Reason | Index pts (best) | Option | Premium in → out | Net ₹ (conservative) |
|---|---|---|---|---|---|---|---|---|---|
| 13:50 | CE | PDL 22560.4 | 22561.3 → 22523.3 | 13:54 | HARD STOP | -45.4 (0.0) | 22550CE | 187.65 → 168.25 | -1,727 |

Day net: ₹-1,727

## SENSEX

### Step 1 — 09:15 levels (known before the open)

Open 73684.1 · PDH 73698.8 · PDL 73026.8 · PDC 73249.4 · gap +434.8 pts

| Level | Type | Distance from open |
|---|---|---|
| 73900.2 | S/R FLIP | +216.1 |
| 73719.7 | S/R FLIP | +35.5 |
| 73698.8 | PDH | +14.7 |
| 73249.4 | PDC | -434.8 |

(5 owner S/R levels from the previous 5 sessions; listed: those within 3 × 15-min ATR ≈ 466 pts of the open.)

### Step 2 — 09:30 first 15 minutes + OI

First-15 HIGH 73748.4 · LOW 73519.4 · range 229.0 pts · price at 09:30 73556.9

OI snapshots used: 09:15 → 09:29

| Strike | Call OI added 09:15→09:30 | Put OI added 09:15→09:30 |
|---|---|---|
| 73800 | 1,01,920 | 1,18,280 |
| 73700 | 2,41,520 | 1,50,720 |
| 73600 | 1,13,500 | 2,58,240 |
| 73500 | 95,680 | 2,79,760 |
| 73400 | 2,780 | 98,020 |
| 73300 | -26,280 | 38,100 |

Call OI added 9,40,640 · Put OI added 15,59,360 → PUT writers stronger (bullish). Biggest CALL wall above: 74000 (4,30,220) · biggest PUT wall below: 73500 (7,12,820)

### Step 3 — 09:30 trend

vs previous close: above (+) · vs 5-min EMA 21 (73338.1): above (+) · OI: + → **UP**

### Steps 4–5 — every 5-min close: breakout / breakdown + premium cross-check

| Time | Event | Level | Index close | Trend agrees? | ATM premium (close · E9 · E21) | Decision | Outcome with the same exit (conservative ₹) |
|---|---|---|---|---|---|---|---|
| 09:40 | BREAKDOWN ↓ (candle 09:35 + hold) | First-15 LOW 73519.4 | 73439.5 | no | PE 73400: n/a (no premium history) | SKIP — against the 09:30 trend | HARD STOP 09:41: -88.2 pts (best 0.0), ₹-60 |
| 09:40 | BREAKDOWN ↓ (candle 09:35 + hold) | OI PUT wall 73500.0 | 73439.5 | no | PE 73400: n/a (no premium history) | SKIP — against the 09:30 trend | HARD STOP 09:41: -88.2 pts (best 0.0), ₹-60 |
| 10:05 | BREAKDOWN ↓ (candle 10:00 + hold) | PDC 73249.4 | 73061.7 | no | PE 73100: n/a (no premium history) | SKIP — against the 09:30 trend | TARGET +100 10:10: +117.3 pts (best 117.3), ₹1,476 |
| 10:15 | BREAKDOWN ↓ (candle 10:10 + hold) | PDL 73026.8 | 72886.4 | no | PE 72900: n/a (no premium history) | SKIP — against the 09:30 trend | TARGET +100 10:18: +121.5 pts (best 121.5), ₹-683 |
| 13:50 | BREAKOUT ↑ (candle 13:45 + hold) | PDL 73026.8 | 73043.8 | yes | CE 73000: 824.5 · 676.3 · 630.6 (fresh cross) | TRADE | HARD STOP 13:55: -163.9 pts (best 0.0), ₹-1,056 |

### Trades

| Entry | Side | Level | Index entry → hard stop | Exit | Reason | Index pts (best) | Option | Premium in → out | Net ₹ (conservative) |
|---|---|---|---|---|---|---|---|---|---|
| 13:50 | CE | PDL 73026.8 | 73043.8 → 72907.0 | 13:55 | HARD STOP | -163.9 (0.0) | 73000CE | 805.45 → 767.85 | -1,056 |

Day net: ₹-1,056

