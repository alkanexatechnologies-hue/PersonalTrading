# Requirements — Market Command screen (trading cockpit for an index: NIFTY / SENSEX / BANKNIFTY …)

Source: the owner-approved Market Command redesign of the NSA app (Oct 2026). Rebuild the same behaviour in this
application. Wording follows EARS: WHEN / WHILE / IF … THE SYSTEM SHALL …

## Ground rules (apply to every requirement)
- G1 THE SYSTEM SHALL show only real market data from the configured provider. IF a value is unavailable THEN it
  SHALL show "—" with a reason, never an invented number.
- G2 THE SYSTEM SHALL be advisory only (no order placement).
- G3 THE SYSTEM SHALL keep the existing main price chart's data, overlays and signal logic unchanged; only its
  candle colours and the empty space right of the last candle may change (R4).
- G4 WHEN any panel refreshes THE SYSTEM SHALL update it in place, re-render only if its content changed, and on a
  failed refresh keep the last good value marked with its age (no flicker, never blank to "Loading…").
- G5 Every level / forecast-like read that has not been backtested SHALL be labelled "positioning, not a forecast".

## R1 Layout and view tabs
1. THE SYSTEM SHALL show, top to bottom: header (index tabs, price, O/H/L/C, VIX tile, timeframe buttons, screen
   links) → view tabs → market tape → decision row → chart row (main chart | CE over PE | key levels).
2. THE SYSTEM SHALL offer two view tabs: "⚡ Market Command" and "🔬 OI Analysis". The header, screen links and the
   market tape SHALL stay visible on both.
3. WHEN "OI Analysis" is selected THE SYSTEM SHALL show the existing OI Analysis screen (same code, data, refresh)
   inside Market Command, and WHEN the OI Analysis screen is opened on its own page THE SYSTEM SHALL move it back.
4. THE SYSTEM SHALL NOT show on this screen: an option-chain table, a separate "final decision" row, a breakout
   evidence row, OI-movement or multi-timeframe side panels, or index-news cards (their useful content moves to the
   tape and decision row).

## R2 Market tape (one line per stat, ~26 px tall)
THE SYSTEM SHALL show: India VIX (value, day range, status) · ATR(14) (5-min value, the chart timeframe's value,
ratio to its average, NORMAL / EXPANDING / COMPRESSED) · PCR of the whole chain (+ max pain) · FII index-futures net
(long/short ratio, report date) · day volume · sector lean (2 sector indices %) · global cues (US indices %).
Full detail SHALL be in a hover title; long text SHALL ellipsize.

## R3 Decision row (three compact cards, ≤ 2 lines each)
1. Live signal: final action badge (WAIT / BUY CE / BUY PE), 15-min and 1-hour score, confidence %, one-line reason,
   "CE only above X · PE only below Y".
2. Bias: MIXED / BULLISH / BEARISH from the Daily / 1H / 15m / 5m trend verdicts (all up → BULLISH, all down →
   BEARISH, else MIXED) with one arrow chip per timeframe and a one-line day summary.
3. Trade plan: Bull / Bear switch; Buy strike, Start, SL, T1, T2, R:R, entry type inline; one line with the
   no-trade zone and REAL RISK = |start − stop| + ATR15 (a 15-min-close stop can run one ATR past the stop).

## R4 Main chart
1. Candles and volume SHALL use TradingView colours: up #089981, down #F23645, wicks the same colour, no border.
2. THE SYSTEM SHALL keep the empty space right of the last candle (rightOffset bars) ≥ 280 px at any bar spacing
   (rightOffset = max(25, ceil(280 / barSpacing))) so level tags never cover candles; phones ≥ 120 px.
3. Timeframes: 5m (default) · 15m · 30m · 1h · 1D. WHEN 1D is selected every time axis SHALL show dates.

## R5 Key-level ladder (right column, 260 px)
THE SYSTEM SHALL list, sorted by price high → low with the SPOT row highlighted and the distance from spot:
OI call walls (strong / weak), OI put walls, PDH, PDL, pullback zone (fake-move level ± zone half-width), last BOS,
active order block (range), VWAP, bull plan start, bear plan start. Colour bar: resistance red, support green, plan
amber, spot blue. Tabs: Levels / Plan / Notes. Names short; the reason in a hover title.

## R6 Option terminal (CE over PE, next to the main chart)
1. Two premium charts (CE top, PE bottom), TradingView colours, EMA 9 and EMA 21, price lines R2 / R1 / S1 / S2
   from the premium's swing structure, LTP, and a PULLBACK ZONE.
2. Pullback zone SHALL = the premium's last break-of-structure level (BIOS) ± (index zone half-width × |Δ|)
   (index half-width: NIFTY 10, FINNIFTY 10, MIDCAP 5, BANKNIFTY 25, SENSEX 35; Δ from the option log, else 0.5).
3. Header (one line): strike + side, LTP, structure, EMA9, EMA21, ATR(14) of the premium, Δ; full detail on hover.
4. Filters: expiry (next 4), strike stepper (± index step), ATM −2 … +2 chips (hover: CE/PE moneyness),
   CE / PE / Both. The premium charts SHALL use the MAIN CHART'S timeframe (shown as "5m · synced").
5. 1D premium candles SHALL be built from 60-min premium candles of the last 60 days grouped by trading day.
6. Candles outside 09:15–15:30 SHALL be dropped (intraday).

## R7 One frame
WHILE the window is wider than 900 px THE SYSTEM SHALL size the chart row to the window height left under the
decision row (min 460 px) so the main chart, CE, PE and the ladder are visible together without scrolling; the main
chart fits its own panes inside that height. ≤ 900 px: everything stacks; the page never scrolls sideways.

## R8 Wall Builder (inside OI Analysis → 1-Min OI Monitor)
1. From a per-minute OI log (per strike: call/put OI, LTP, IV, Δ), for the latest minute T, THE SYSTEM SHALL compute
   for 1, 5 and 15-minute windows (previous logged minute ≤ T−k; show the actual gap if it differs) per strike:
   call ΔOI and put ΔOI typed WRITE (OI↑ prem↓), BUY (OI↑ prem↑), COVER (OI↓ prem↑), UNWIND (OI↓ prem↓), FLAT.
2. Writers matrix per window: call added / removed / net, put added / removed / net, C+P net.
3. Per strike: OI added since the first minute of the day (call, put), Δ CE / PE, Γ (Black-Scholes from IV).
4. Per-strike positioning read: score = 15-min change + ½ × 5-min change; calls WRITE / puts COVER / puts BUY(½)
   push DOWN; puts WRITE / calls COVER / calls BUY(½) push UP. Call wall = strongest DOWN strike ≥ spot; put wall =
   strongest UP strike ≤ spot; lean = sign of the sum. Label: "positioning, not a forecast" (a 2-year test found
   15-min OI walls revert / break no more often than any strike at the same distance).
5. Box ladder: calls (15 / 5 / 1) | strike + C·P OI | puts (1 / 5 / 15) | positioning | written today C, P | Δ | Γ,
   a spot marker row, and a TOTAL footer; tint strength = size within its column.

## R9 Responsive and accessible
375, 390, 768, 1440, 1920 px: no page-level sideways scroll; touch targets ≥ 26 px desktop / 44 px phone; text
contrast ≥ 4.5:1; colour never the only signal (arrows / words alongside).
