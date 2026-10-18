# Lunch window (12:00–14:00 IST): does the market pull down? (run 2026-10-18)

**Question (from the user):** "In the last 15 days, from 12 PM to 2 PM the market mostly tried to pull down."

**Data:** Dhan 5-min spot for NIFTY, SENSEX and BANKNIFTY. 63 sessions, 20 Jul → 16 Oct 2026.

**Test, fixed before looking at the data:**
- Return from 12:00 to 14:00, with 12:00 = close of the 11:55 bar and 14:00 = close of the 13:55 bar.
- Two periods: the last 15 sessions and all 63.
- Three other windows as a control: 09:15–10:00, 10:00–12:00, 14:00–15:15.
- The dip below the 12:00 price and the rally above it inside the window.
- Split by morning direction (open → 12:00).
- One-sided binomial test against 50%.

Scripts: `run.js`, `dip.js`. Run them with the scratch-folder path that holds `NIFTY.json` / `SENSEX.json` (5-min candles from `getProvider().getCandles(sym, "5m", 90)`).

## Results: 12:00 → 14:00

| | NIFTY last 15 | NIFTY 63 | SENSEX last 15 | SENSEX 63 | BANKNIFTY 63 |
|---|---|---|---|---|---|
| Closed lower | 8/15 (53%), p=0.50 | 34/63 (54%), p=0.31 | 9/15 (60%), p=0.30 | 36/63 (57%), p=0.16 | 32/63 (51%) |
| Mean / median | −23 / **−1.8 pts** | −10.6 / −5.2 | −69 / **−0.8** | −33 / −16 | −0.7 / −0.6 |
| Avg dip vs rally inside window | **75 vs 44** | 47 vs 34 | **238 vs 147** | 154 vs 113 | 127 vs 126 |

- **The mean is carried by one day.** On 1 Oct NIFTY fell −319 in this window. Without that day, NIFTY's last-15 mean is about −2 pts.
- **Control windows look the same.** 09:15–10:00 and 10:00–12:00 also had dips larger than rallies over these 63 days (NIFTY 61 vs 42, 49 vs 39), so this reflects the period's weak drift, not something special about 12–2. 14:00–15:15 is balanced.
- **Morning direction:**
  - After a DOWN morning, 12–2 fell on 21/35 days (60%, NIFTY 63) and 4/6 recently.
  - After an UP morning: 13/28 (46%).
  - Weak evidence (p ≈ 0.16), not proven.
- **Lunch dips that go deep, go further.** The lunch dip reached ≥ 0.25% on 15/63 NIFTY days, and only 1 of those recovered half the dip by 14:00 (SENSEX 3/17). This is partly selection, because a big dip is harder to recover from.
- **Taking the morning low during lunch was usually a real break, not a sweep.** In 12–2 the morning low was taken on 25/63 days; price closed back above it by 14:00 on only 10.

## Verdict

**No validated "12–2 pull-down" edge.** It closes lower about as often as a coin flip, the 15-day mean comes from one big day, and the dip-larger-than-rally pattern also shows up in the morning windows.

What *is* consistent, as a description rather than a tested rule:
1. Dips inside 12–2 run deeper than rallies.
2. A weak morning tends to stay weak through lunch.
3. Once a lunch dip passes ~0.25%, or takes the morning low, it rarely gets bought back before 14:00. Don't bottom-fish at lunch.

Nothing here was added as a trading rule.
