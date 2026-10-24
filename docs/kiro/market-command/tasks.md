# Tasks — Market Command screen (do in order; each task ends with its check passing)

- [ ] 1. Map data: list this app's endpoints that provide every field in design.md "Data contracts"; mark any
      missing field as "—" (G1). No invented data. _Req: G1, R2, R3_
- [ ] 2. Wall Builder backend: pure module (parse per-minute OI log, buildType, windows 1/5/15, totals, day totals,
      Black-Scholes Γ, positioning read) + GET /oi-walls (latest logged day, optional date / at, 20 s cache).
      Unit tests: buildType table; Γ ≈ 0.00097 for S 22510, K 22500, IV 17 %, τ 0.0115 y; a 5-minute fixture where
      15-min call OI +1000 with premium 200 → 150 is WRITE, windows pick the right minutes, call wall ≥ spot. _Req: R8_
- [ ] 3. Daily option candles: helper grouping 60-min premium candles of 60 days into trading days; option candle and
      structure routes accept interval=D; structure says "fewer than 10 trading days" when short. _Req: R6.5_
- [ ] 4. Screen skeleton: view tabs, tape, decision row, ladder slot, option-terminal slot in the chart row,
      Wall Builder slot after the OI sub-tabs; CSS hides the removed panels. _Req: R1_
- [ ] 5. Front-end module: renderTape, renderDecision, renderLevels (render only on change, keep last good). _Req: R2, R3, R5, G4_
- [ ] 6. Option terminal: two premium charts (TradingView colours, EMA 9/21, R/S lines, pullback zone, ATR, Δ),
      filters (expiry, strike stepper, ATM±2, CE/PE/Both), timeframe synced to the main chart incl. 1D. _Req: R6_
- [ ] 7. Main chart: TradingView candle colours; tag space (rightOffset ≥ 280 px); 1D button and date axis. _Req: R4_
- [ ] 8. Frame fit: chart row = window height under the decision row (desktop), stack on ≤ 900 px. _Req: R7_
- [ ] 9. OI tab: mount the existing OI Analysis screen into the tab; its refresh timers treat "mounted and Market
      Command visible" as visible; move it back when OI Analysis opens on its own page. _Req: R1.3_
- [ ] 10. Wall Builder UI: window tabs, index move per window, writers matrix, "where the walls are" card (with the
      not-a-forecast note), box ladder with spot row and TOTAL footer, legend. _Req: R8_
- [ ] 11. Verify in a real browser at 375 / 390 / 768 / 1440 / 1920: no page sideways scroll, no console errors,
      all three charts visible together at 1440×900, tags not over candles, timeframe switch moves all three charts,
      OI tab mounts and returns. Run the build and the full test suite. _Req: R7, R9_
