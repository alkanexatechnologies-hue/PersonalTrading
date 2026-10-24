# Design — Market Command screen

## Architecture
- Build the new screen as an ADDITIVE layer: one front-end module (e.g. `mcx.js`) that reads data the screen already
  loads plus a few read-only endpoints. Do not rewrite the main chart; hide removed panels with CSS.
- One backend pure module for the Wall Builder (`wallBuilder.ts`, no I/O, unit-tested) + one GET route.
- One backend helper for daily option candles (`optionChartCandles`).
- Refresh clocks: main payload as today; slow sources every 60 s (plan, desk scores), 2–5 min (positioning,
  sentiment); option charts 60 s; Wall Builder 30 s (server cache 20 s). Start fetching only when the screen is visible.

## Data contracts (shapes the UI needs — map them to this app's APIs)
```
marketCommand: { symbol, name, interval, spot, candles:[{time,open,high,low,close,volume}], overlays:{vwap:number[]},
  vix:{value,dayLow,dayHigh,status}, decision:{finalAction,reason,volatility:{atr,atrRatio,state}},
  levels:{strongResistance:{strike,oi},weakResistance,weakSupport,strongSupport,pdh,pdl},
  fakeMove15m:{level}|null, fakeMove5m:{level}|null, bos:{price,direction,stage}|null, activeOB:{side,low,high,status}|null,
  oi:{pcr,maxPain,expiry,verdict}, optionChain:{atmStrike}, dataAgeSec, dataStale, historical }
plan (15m): { trader:{ atr15, trends:[{tf,verdict:"UP"|"DOWN"|"RANGE"}],
  plans:{ bull:{entry,stop,t1,t2,rr,strike}|null, bear:{…}|null, noTrade:{from,to}|null } }, spot:{high,low} }
desk: rows[{symbol, tf15:{label,score}, tf1h:{label,score}, pcr}]      hourOutlook: outlook[{symbol, confidence}]
positioning: { fii:{net,longShortRatio,tradingDate} }                 sentiment: { india:{lean,indices[{label,changePct}]}, global:{us[{label,changePct}]} }
optionCandles?symbol&type=CE|PE&strike&expiry&interval=5|15|30|60|D → { candles:[…], message? }
optionStructure?symbol&strike&expiry&interval → { ce:{available,r1,r2,s1,s2,structure,bios:{price,direction}}, pe:{…} }
oiWalls?symbol[&date][&at=HH:MM] → WallBuilder (below)
```

## Algorithms
**Real risk** = |plan.entry − plan.stop| + ATR15 (index points).

**Bias** = trends all UP → BULLISH; all DOWN → BEARISH; otherwise MIXED.

**Pullback zone (premium)**: half = max(0.5, round1(indexHalf[symbol] × |Δ|)); zone = BIOS ± half.
indexHalf = { NIFTY 10, FINNIFTY 10, MIDCAP 5, BANKNIFTY 25, SENSEX 35 }.

**Tag space**: on every visible-range change (debounced 200 ms): rightOffset = max(25, ceil(280 / barSpacing)).

**Frame fit** (desktop > 900 px): rowTop = row.getBoundingClientRect().top + screenScrollTop;
row.height = max(460, innerHeight − rowTop − 6); then let the main chart refit its panes. Recompute on resize and
after the decision row re-renders.

**Daily option candles**: fetch 60-min premium candles for now−60d…now; keep 09:15–15:30; group by IST day
(dayStart = floor((t+19800)/86400)*86400 − 19800): open first, high max, low min, close last, volume sum.

**Wall Builder** (pure):
```
buildType(dOI, dPrem): dOI==0|null → "-" ; dOI>0 → dPrem<0 ? "W" : "B" ; dOI<0 → dPrem>0 ? "SC" : "U"
window k ∈ {1,5,15}: from = last logged minute ≤ T−k
cell(strike,k) = { c:ΔcallOI, ct:type(ΔcallOI, ΔcallLTP), p:ΔputOI, pt:type(ΔputOI, ΔputLTP) }
strikes = 13 nearest the spot
dayC/dayP = OI(T) − OI(first minute)
Γ = φ(d1)/(S·σ·√τ), d1 = (ln(S/K) + ½σ²τ)/(σ√τ), σ = mean(ceIV, peIV)/100, τ = years to expiry 15:30 IST
read: bull/bear accumulators — 15-min weight 1, 5-min weight ½:
  call W → bear | call SC → bull | call B → bull·½ | put W → bull | put SC → bear | put B → bear·½
  side = sign(bull − bear); why = first two reasons
callWall = most negative read with strike ≥ spot; putWall = most positive read with strike ≤ spot; lean = sign(Σ net)
totals[k] = Σ positive and Σ negative ΔOI, calls and puts separately
```

## Design tokens
- Background #0b0e14; panels #11151c; inner boxes #0b0e14 / #0d1118; borders #1e2530; dividers #161c26.
- Text #e7ebf0; secondary #c9d0da; muted #9aa3b0 (labels), #7d8693 (sub-text).
- Up / call-write green tint 63,185,120 (text #26c6a6); down / call-write red 255,107,114 (text #ff6b72); buy blue
  78,161,255; cover amber 245,197,66; unwind grey 125,134,147; gamma purple 168,85,247; spot blue #12305a / #2a5ea8;
  wait amber #f5c542 on #2a210a.
- Candles: #089981 / #F23645. EMA9 #4ea1ff, EMA21 #f5c542, EMA50 #a855f7, EMA200 #f472b6, VWAP #22c55e.
- Fonts: Inter (UI), JetBrains Mono (all numbers, tabular). Sizes: labels 10–10.5 px uppercase .6 letter-spacing,
  body 11.5–12.5 px, key numbers 13–14 px, headline badges 14 px / 800.
- Radii 6–8 px; gaps 4–8 px; one segmented-control style everywhere (selected = filled).
- Box (Wall Builder): min-height 34 px, radius 6, background rgba(tone, 0.10 + 0.55·s), border rgba(tone, 0.18 + 0.4·s),
  value mono 12 px bold, label 9 px uppercase; s = |value| / column max.

## Removed panels (hide via CSS so existing renderers keep working)
top VIX / index-direction / news cards · final-decision row · breakout row · OI-movement panel · multi-timeframe panel ·
option-chain panel.
