# Development Rules — MarketPil / NSA Intraday Assistant

These rules apply to the **whole application**, not just the screen currently
being worked on.

## 1. Git is mandatory for every change

- Before starting a major change, check the current Git status and branch.
- After a feature or fix is complete **and tested**:
  1. Run the application / build / tests.
  2. Verify there are no unintended changes (review `git status` and the diff).
  3. Create a Git commit whose message describes the actual change.
  4. Push, so the latest code is pullable on the MacBook.
- Keep the history clean and traceable. Review what is staged rather than
  blindly `git add .` on an unreviewed tree.

```bash
git status
git add <specific files>
git commit -m "Improve mobile responsive trading dashboard"
git push
```

### Never commit secrets

No API keys, access tokens, passwords, `.env` files, or personal credentials.
In this project that means these stay ignored (see `.gitignore`):

| Path | What it holds |
| --- | --- |
| `.groww_token` | Minted Groww access token |
| `.groww_creds.ps1` | Groww API key/secret |
| `.truedata_creds` | TrueData credentials |
| `/data/` | `dhan-config.json`, `whatsapp-config.json`, `users.json` (password hashes), `login_audit.jsonl` |
| `.env` | Any environment secrets (SMTP, provider keys) |

Secrets are read from environment variables or these ignored files at runtime —
never hardcoded into committed source.

## 2. Latest copy always available on the MacBook

The MacBook is the primary development machine. The Git repository must always
represent the latest stable development version, so that `git pull` alone is
enough to get the newest code. Push after every completed milestone.

## 3. One responsive app — mobile, tablet, desktop

Do **not** build a separate mobile application. This is a single responsive web
app / PWA on the existing frontend architecture, and it must work on:

- Mobile — Android and iPhone
- Tablet — iPad and Android tablets
- Laptop — MacBook / Windows
- Desktop monitors

## 4. Breakpoints every screen is checked at

| Device | Size |
| --- | --- |
| Mobile | 375 × 667 |
| Mobile | 390 × 844 |
| Tablet | 768 × 1024 |
| Laptop | 1440 × 900 |
| Desktop | 1920 × 1080 |

These must all adapt automatically: navigation, login screen, admin panel, user
dashboard, trading dashboard, Master Trade Selector, option chain, OI data,
charts, trade cards, tables, alerts, commentary, buttons, forms, modals, and
logs/audit screens.

## 5. Mobile trading UI

- No horizontal scrolling for the main application.
- Important trading information stays visible.
- BUY / SELL / WAIT status must be highly visible.
- CALL / PUT information must be easy to read.
- Trade Entry, Target and Stop Loss must be clearly displayed.
- Avoid very wide tables — use cards, horizontal sections or responsive columns.
- Touch targets large enough for a finger (min ~44px), no tiny fonts (min 12px,
  prefer 16px on inputs so iOS does not zoom).

## 6. Tablet UI

Use the extra width: two-column layouts where appropriate, readable trading
cards, option chain and charts optimised for tablet width, and admin screens
usable without desktop-only controls.

## 7. Desktop UI

Use space efficiently — side-by-side dashboard panels, larger chart and
option-chain layouts — without making the UI needlessly oversized.

## 8. Definition of done

No feature is complete until:

1. Code is implemented.
2. The application runs successfully.
3. The build passes (`npx tsc --noEmit`).
4. Relevant tests pass (`npx tsx --test "backend/**/*.test.ts"`).
5. Mobile layout checked.
6. Tablet layout checked.
7. Desktop layout checked.
8. No console errors introduced.
9. `git status` reviewed.
10. Changes committed.

## 9. Core principle

**Do not solve a mobile problem by shrinking the desktop UI.** Design each
component so the *information hierarchy itself* changes appropriately between
mobile, tablet and desktop.

## 10. Workflow for every major change

```
CODE CHANGE → RUN/TEST → CHECK MOBILE → CHECK TABLET → CHECK DESKTOP
→ FIX UI/BUGS → FINAL TEST → git status → git add → git commit → git push
```

## Checking responsiveness

`scripts/responsive-audit.js` drives headless Chrome over all five breakpoints
and reports horizontal overflow, tiny fonts, and small touch targets:

```bash
node scripts/responsive-audit.js          # all breakpoints, all screens
```

## Out of scope unless explicitly asked

Do not modify trading logic while doing UI/responsive work: Master Trade
Selector, OI, EMA/MACD/VWAP indicators, backtesting, or the AI layer.
`AI_MODE=ADVISORY_ONLY`, `MODEL_TRAINING_ENABLED=false` and
`LIVE_ORDER_EXECUTION=false` stay enforced.
