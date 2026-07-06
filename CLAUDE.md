# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file, no-build static PWA: a personal Korean stock portfolio tracker ("내 주식 현황"). All HTML, CSS, and JS live in `index.html` (~2700 lines). There is no package.json, bundler, linter, or test suite — this is intentional, not incomplete.

## Rules

- **Keep the single-`index.html` structure.** Do not split this into separate CSS/JS/component files or introduce a build step.
- **Every change must bump the `app-ver` string** in the header (`<span class="app-ver">v1.12</span>`). This app has no service worker/cache-busting mechanism, so this version bump is the only user-visible signal that the deployed file changed.
- **Commit messages in Korean.**
- **Conversation with the user in Korean.**
- **After finishing a code change, commit and push to `origin/main` directly without asking for confirmation first.** This repo has no CI/build/staging step — the working tree *is* the deployed site, so committing is low-risk and expected at the end of each change.

## Development workflow

There is no build/install/lint/test command. To work on this app:
- Edit `index.html` directly.
- Open it in a browser (or serve statically, e.g. `python -m http.server`) to test changes.
- Data persists in `localStorage` under key `portfolio_v2` (portfolio data) and `app_pin_hash_v1` (PIN hash) — clear these in devtools to reset state while testing.

## Architecture

### Two top-level views, one page
`switchMainView('indicators' | 'stocks')` toggles between:
- **주요 지표 (Indicators)** — `#view-indicators`, rendered by `renderIndicators()`. Macro/technical dashboard: FX, US/KR indices, yield spreads, VIX, RSI, Bollinger %B, disparity, realized volatility, plus per-stock mini trend cards (`indicatorStocks` in data). No PIN required; this is the default landing view.
- **내 주식 (My Stocks)** — `#view-stocks`, rendered by `render()`. Personal holdings across 4 accounts (`mirae1`, `mirae2`, `mirae3`, `samsung`) plus a watchlist. **Gated by a 4-digit PIN lock screen** (`initLock`/`handleKey`/`unlock` in the "잠금화면" section) — first entry sets the PIN (hashed client-side via `simpleHash`, a non-cryptographic hash good enough to deter casual snooping, not real security), subsequent entries require it.

### Data model (`localStorage['portfolio_v2']`)
Loaded/migrated in `load()` (handles schema upgrades for older saved data — e.g. `pensionAsset`/`otherAsset` → `customAssets`). Shape:
- `accounts.{mirae1,mirae2,mirae3,samsung}` — each `{ name, stocks: [], cash }`. A stock has `code` (ticker), `qty`, `avgPrice`, `currentPrice`, `prevClose`, `currency`, `boughtToday`.
- `watchlist` — tracked-but-not-owned tickers.
- `customAssets` — free-form named asset rows (e.g. pension, other holdings) added to net worth.
- `history` — one snapshot per day (`recordHistorySnapshot`), capped at 90 entries, used to draw the trend/allocation charts.
- `indicatorStocks` — tickers shown in the Indicators view's per-stock cards.
- `fxRate`/`fxDate` — last-fetched USD/KRW rate, applied to US-denominated holdings via `fxOf(s)`/`isUSStock(s)`.

Note: only `mirae1` and `mirae2` are combined in the "종합" (combined) tab via `aggregateAllStocks()` — `mirae3` and `samsung` are intentionally excluded from that aggregate.

### Price/data fetching — proxy chain, no backend of your own to run
There's no server in this repo. Live data comes from a Cloudflare Worker (`MY_WORKER_URL` in `index.html`, currently pointed at `stock-proxy.ssangku2.workers.dev`) that proxies Naver (KR realtime) and Yahoo Finance (US) quotes, historical closes, FRED macro series, and KR index data. If `MY_WORKER_URL` fails or is unset, `fetchPrice()` falls through to a chain of public CORS proxies (`PROXIES` array) hitting Yahoo directly (15–20 min delayed). The Worker's source is not in this repo — treat its endpoints (`?symbol=`, `?hist=`, `?trend=`, `?fred=`, `?index=`) as an external API contract when changing fetch call sites.

### Rendering pattern
No framework — plain template-literal `innerHTML` rendering triggered explicitly after state mutation (`save()` then `render()` / `renderIndicators()`). `renderStockCard()` is the shared card renderer for both per-account and aggregated ("종합") stock lists, handling both cumulative P&L and today's P&L (`showDaily`/`dailyDetailMode`) display modes, and USD vs KRW formatting via `fxOf`/`isUSStock`.

### PWA shell
`manifest.json` + `icon-192.png`/`icon-512.png` provide installability (standalone display, dark theme color). No service worker is registered — there is no offline cache.
