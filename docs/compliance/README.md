# Compliance & Risk Disclosure Documentation

This folder documents the risk-disclosure and investor-protection controls implemented
in this software, and — importantly — the regulatory items that are **NOT** satisfied
merely by this software and that require independent professional review.

## IMPORTANT — read this first

This application is a **trading and market-analysis software tool**. It:

- does **not** guarantee profits or returns;
- does **not** place live orders (there is no live automated order execution today —
  see `ALGO_TRADING_DISCLOSURE.md` and `DATA_SOURCE_DISCLOSURE.md`);
- does **not** represent itself as SEBI-approved, SEBI-certified or SEBI-registered.

**Displaying the disclaimers in this software does NOT make the application "SEBI
compliant".** SEBI's framework includes requirements that go well beyond in-app
disclosures — including matters concerning brokers, algo-order tagging, exchange
approval, API monitoring and algo-provider arrangements. Final legal/regulatory
compliance must be independently verified with a qualified compliance/legal
professional and with the relevant broker and exchange.

## Document index

| File | Purpose |
|------|---------|
| `SEBI_DISCLOSURE.md` | The standard SEBI market-risk warning + how/where it is shown, and what it does and does **not** mean. |
| `RISK_DISCLOSURE.md` | General trading / derivatives risk disclosure and the first-use user acknowledgement. |
| `ALGO_TRADING_DISCLOSURE.md` | Algorithmic / automated-trading risk disclosure; current automation status (simulation only). |
| `DATA_SOURCE_DISCLOSURE.md` | Market-data source (Groww only), data-health states, and the stale-data signal block. |
| `AUDIT_TRAIL.md` | What is recorded for each signal, where it is stored, and how to export it. |
| `COMPLIANCE_CHECKLIST.md` | Internal checklist with honest per-item status (IMPLEMENTED / PENDING REVIEW / REQUIRES BROKER / REQUIRES EXCHANGE / REQUIRES LEGAL). |

## Separation of concerns (per requirement §12)

1. **Software functionality** — analysis, signals, simulated paper trading, backtests.
2. **Risk disclosure** — the in-app warnings and consent (this folder).
3. **Regulatory requirements** — SEBI/exchange rules; mostly OUTSIDE software scope.
4. **Broker requirements** — API terms, order tagging, rate limits (broker-confirmed).
5. **Exchange requirements** — algo approval/registration, order tagging (exchange-confirmed).
6. **Items requiring legal/compliance confirmation** — see `COMPLIANCE_CHECKLIST.md`.

## Versioning

- Application version: see `package.json` (`version`).
- Disclosure version: defined in `backend/compliance/disclosures.ts` as
  `DISCLOSURE_VERSION`. When the disclosure text changes materially, bump this value;
  users are then re-prompted to acknowledge the updated disclosure.
