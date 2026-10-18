# Break candles at support / resistance: 5-min and 15-min (run 2026-10-18)

**Detector and candle grade:** the same code the live alerts use (`backend/premium/levelBreak.ts`).

**Data:** Dhan 5-min spot, NIFTY and SENSEX pooled, 63 sessions (20 Jul → 16 Oct 2026).

**Levels:** the plan ladder known before each session: previous day high / low / close, pivots, previous week high / low. There are no OI walls (no historical chain) and no trendlines.

**Definitions:**
- **Break:** a closed candle closes beyond the level by more than 0.05·ATR, after the previous candle closed on the other side. Each level counts once per direction per day.
- **FOLLOW-THROUGH:** price went 1·ATR beyond the break close before any close back across the level.
  - 5-min: checked over 12 bars.
  - 15-min: checked over 8 bars.

Full table: `../published/levelBreaks.json` (also split by index and by level type). Re-run: `npx tsx run.ts <dir> ../published/levelBreaks.json`.

| | n | follow-through | failed | STRONG candle only |
|---|---|---|---|---|
| 15-min breakout (UP) | 184 | **28%** | 102 | 25/92 = 27% |
| 15-min breakdown (DOWN) | 209 | **41%** | 99 | 54/119 = 45% |
| 5-min breakout (UP) | 236 | **33%** | 144 | 49/127 = 39% |
| 5-min breakdown (DOWN) | 257 | **51%** | 122 | 79/156 = 51% |

**Reading:**
- **Upside breaks failed more often than they followed through**, on both timeframes and in both indices. NIFTY strong 15-min breakouts followed through 32%; SENSEX 23%.
- **Breakdowns did better.** Part of that is this period's down drift, so don't assume it holds in a rally.
- **A STRONG candle did not reliably improve breakouts.** It helped breakdowns only a little (15-min: 45% vs 36% for normal).
- **WEAK break candles were the worst:** 22–35% follow-through.

**Use:** these are the records quoted in each live break alert. They are information only. The plan's trigger and stops were not changed (the user confirms any logic change).
