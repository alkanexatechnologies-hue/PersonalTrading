# Compliance Checklist (internal)

**Status legend:** `IMPLEMENTED` · `PENDING REVIEW` · `REQUIRES BROKER CONFIRMATION` ·
`REQUIRES EXCHANGE CONFIRMATION` · `REQUIRES LEGAL/COMPLIANCE REVIEW`

> An item is marked `IMPLEMENTED` **only** for the software control it describes.
> `IMPLEMENTED` does **not** mean "compliant". No item is marked compliant merely because
> a disclaimer is displayed. Regulatory sufficiency requires independent professional review.

## Software controls (in-app)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Standard SEBI market-risk warning shown where applicable | IMPLEMENTED | Footer + Risk Disclosure + consent. Verbatim, not reworded. |
| 2 | Trading-risk disclosure exists | IMPLEMENTED | Full Risk Disclosure page/modal. |
| 3 | Algo/automated-trading risk disclosure exists | IMPLEMENTED | Shown before enabling auto-trade (simulated). |
| 4 | No guaranteed-profit / prohibited claims | IMPLEMENTED | Copy audited; confidence shown as calibrated, capped, not guaranteed. |
| 5 | No misleading SEBI approval claims | IMPLEMENTED | Regulatory disclosure states no SEBI approval/registration is claimed. |
| 6 | Backtest / simulation disclaimer | IMPLEMENTED | Shown on backtest + paper (simulated) screens. |
| 7 | Per-signal risk warning (persistent, not one-time) | IMPLEMENTED | ⚠️ TRADING RISK note kept on trading screen. |
| 8 | Groww data-health displayed (real values) | IMPLEMENTED | Status + latency/age/updates/failures/reconnects. |
| 9 | Stale/disconnected data blocks live signals | IMPLEMENTED | `growwSignalsAllowed()` / `computeGrowwStatus()`. |
| 10 | First-use consent + acknowledgement recorded | IMPLEMENTED | Stores timestamp + app version + disclosure version (no PII). |
| 11 | Disclosure version + acknowledgement recorded | IMPLEMENTED | `localStorage` `nsa_disclosure_ack`; re-prompt on version bump. |
| 12 | Signal audit trail (data + signal fields) | IMPLEMENTED | `signal-audit` channel; JSON/CSV export. |
| 13 | Compliance checklist exists | IMPLEMENTED | This document. |
| 14 | Regulatory claims separated from software functionality | IMPLEMENTED | See `docs/compliance/README.md` §Separation of concerns. |
| 15 | Automated trading requires explicit acknowledgement | IMPLEMENTED | Checkbox gate before enabling (simulated engine). |
| 16 | Emergency stop / kill-switch | IMPLEMENTED (simulated) | Immediately blocks new simulated auto-trades. For live orders → PENDING REVIEW. |

## Automation / execution

| # | Item | Status | Notes |
|---|------|--------|-------|
| 17 | Live automated order execution | NOT IMPLEMENTED | No broker order path; `BrokerProvider` throws. Simulated paper only. |
| 18 | Kill-switch verified against live order path | PENDING REVIEW | N/A until live execution exists. |
| 19 | Order tagging (algo id) | REQUIRES EXCHANGE CONFIRMATION | Only relevant with live algo orders. |
| 20 | API monitoring / rate limits | REQUIRES BROKER CONFIRMATION | Broker API terms. |
| 21 | Rate limiting on data calls | PENDING REVIEW | Data calls timeboxed/cached; formal limits to review. |
| 22 | Error handling on data/exec failures | IMPLEMENTED (data) | Timeouts + fail counters; exec path N/A. |
| 23 | Data integrity (freshness gating) | IMPLEMENTED | Stale-data signal block. |

## Regulatory / external (NOT satisfied by software alone)

| # | Item | Status |
|---|------|--------|
| 24 | Applicable SEBI requirements for your deployment | REQUIRES LEGAL/COMPLIANCE REVIEW |
| 25 | Relevant exchange requirements (algo approval/registration) | REQUIRES EXCHANGE CONFIRMATION |
| 26 | Broker / API requirements & authorization | REQUIRES BROKER CONFIRMATION |
| 27 | Algo-trading provider arrangements | REQUIRES LEGAL/COMPLIANCE REVIEW |
| 28 | Advertisement/communication rules for any performance figures | REQUIRES LEGAL/COMPLIANCE REVIEW |
| 29 | Record-keeping/retention duration requirements | REQUIRES LEGAL/COMPLIANCE REVIEW |

## Reviewer sign-off (to be completed by a qualified professional)

- Compliance/legal reviewer: __________________________  Date: __________
- Broker confirmation (API/order tagging/limits): __________________________
- Exchange confirmation (algo approval/tagging): __________________________

**No production/live-trading use should proceed until the REQUIRES-* items above are
independently confirmed.**
