# OI level study — can 15 minutes of OI predict where the index reverts, breaks or stays sideways? (2026-10-24)

Script: `oiLevelStudy.ts` (rules pre-registered in its header). Real Dhan 1-min data, ATM ± 3 strikes, 2024-11-04 → 2026-10-23,
487 sessions, 9,740 checkpoints per index (every 15-min close 09:45–14:30), outcome over the next 60 minutes.
Baseline = a level at the same distance from spot at every checkpoint, with no OI condition.

| | NIFTY dev | NIFTY val | SENSEX dev | SENSEX val |
|---|---|---|---|---|
| Call-writing ceiling: revert / break (of touches) | 32.8% / 38.7% | 35.9% / 44.3% | 32.6% / 43.9% | 35.1% / 46.3% |
| Same-distance baseline | 32.4% / 43.7% | 34.1% / 44.8% | 31.5% / 45.9% | 34.6% / 46.4% |
| Put-writing floor: revert / break | 30.6% / 45.0% | 30.4% / 48.9% | 29.6% / 46.1% | 32.4% / 48.5% |
| Same-distance baseline | 32.6% / 44.4% | 32.0% / 46.8% | 31.4% / 46.6% | 30.8% / 49.5% |
| OI range (ceiling + floor ≤ 200 / 600 pts) held 60 min | 64.3% | 56.0% | 53.9% | 48.9% |
| Same-width baseline | 62.3% | 60.9% | 50.7% | 50.3% |

**Verdict: no predictive edge.** 15-min OI-writing levels behave like any strike at the same distance; the range read is
worse than baseline in validation for both indices. OI walls may be shown as positioning context, never as a forecast of
revert / break / sideways. Next candidate (not yet tested): price REACTION (rejection / sweep-reclaim) at a strong OI wall
vs the same reaction at an ordinary level.
