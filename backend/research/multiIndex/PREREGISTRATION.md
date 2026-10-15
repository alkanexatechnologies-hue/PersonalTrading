# Multi-index replication — pre-registration

Written before any result on these indices. The three NIFTY studies (early breakout T15/E5/E5P/BNC, root breakout 16
variants, trend-day detector incl. confirmatory C1) are re-run **unchanged** on BANKNIFTY, FINNIFTY, MIDCPNIFTY and
SENSEX (Dhan 1-minute rolling ATM±3 premiums, 2024-10-14 → 2026-10-12, same DEV / VALIDATION / HOLDOUT dates).
Only index facts differ: strike step (100 / 50 / 25 / 100), constant lot (30 / 65 / 120 / 20), "round numbers" =
2 × strike step, nearest expiry = monthly for the three NSE indices, weekly for SENSEX. Same decision rules as each
NIFTY study; per index the DEV-best root variant (≥ 60 trades) is the one carried to VALIDATION. HOLDOUT is opened only
for a signal that is positive in DEV and VALIDATION on that index.
