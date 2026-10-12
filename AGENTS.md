# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, ...) and humans working on ledgerline.
Read this before changing code. User-facing docs live in [README.md](README.md), contribution flow in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Overview

ledgerline is a self-hosted portfolio tracker for Ethereum and Arbitrum: wallet tokens, Aave v3
positions (all markets), live snapshots, daily history backfilled from first activity, holdings-based
PnL, risk metrics and an activity ledger.

- **Stack:** Next.js 15 (App Router), React 19, TypeScript (strict), SQLite via `better-sqlite3`,
  `viem` for ABI work, `zod` for input validation.
- **Two processes, one database:** the web app (UI + `/api/*` route handlers) and a long-running
  worker (`worker/index.ts`, run with `tsx`) share one SQLite file in WAL mode.
- **External data:** JSON-RPC (Alchemy when configured, public endpoints as fallback), DefiLlama
  (prices, block by timestamp), Frankfurter (USD/EUR, USD/CHF), Blockscout (Ethereum token discovery), Safe
  transaction service (Safe balances), Tenderly gateway (keyless full-range logs).

## Commands

```bash
npm ci                    # install (Node 22+)
npm run dev               # web on http://127.0.0.1:8790
npm run worker            # scheduler + job queue (second terminal)
npm run typecheck         # tsc --noEmit
npm test                  # node:test suites (temp databases, no network)
npm run build             # production build
npm run demo:data         # synthetic demo database in ./data/demo.db
DATABASE_PATH=./data/demo.db npm run dev   # browse the demo data
```

Other helpers in `scripts/` (run with `tsx`): one-off scan, backfill, hourly backfill and ledger
backfill against the configured database. They hit real RPC endpoints.

## Code map

| Path | What lives there |
|---|---|
| `app/` | Pages (`/`, `/wallets`, `/wallets/[id]`, `/address/[address]`, `/transactions`) and `app/api/**/route.ts` handlers. `app/api/_lib/http.ts` has the shared JSON/error helpers, `app/api/_lib/bot-auth.ts` the bearer token check for `/api/bot/*` |
| `components/views/` | Page-level views (portfolio, address, manage, transactions) and shared parts |
| `components/charts/` | Hand-rolled SVG charts (area with the unleveraged line, multi-line for rates / FX, yield bars, sparkline, history card). No chart library |
| `components/format.ts` | **All** display formatting and the stealth mask |
| `components/layout/` | `Providers` (currency, FX, stealth, toasts) and the top bar |
| `styles/` | `tokens.css` (design tokens, light and dark) and `app.css`. Plain CSS, no Tailwind |
| `lib/scan/` | Live side: token discovery, live snapshots, latest-state RPC pools, job dispatch, env/db bootstrap, logger, spam filter, valuation |
| `lib/history/` | History side: archive RPC pool, Multicall3, daily backfill, hourly backfill, Aave reader, DefiLlama prices, canonical price keys, rollup and retention |
| `lib/ledger/` | Activity ledger: raw sources (Transfer/Approval logs, `alchemy_getAssetTransfers`), ingest, classification, read model |
| `lib/protocols/` | Protocol adapters beyond Aave: `curve-crvusd.ts` (Curve crvUSD mint markets and LlamaLend loans: market registry, per-address loan discovery from UserState logs, point reads used by live, daily and hourly) |
| `lib/queries/` | Read models used by the API: scope parsing, aggregation and dedup across wallets, history series, PnL (`scope-pnl.ts` backs `GET /api/pnl?scope=` for list rows), risk, flows, yield / rates, suggestions, `report.ts` (the bot "what changed" report) |
| `lib/queries/api-types.ts` | **THE API contract** between route handlers and UI. Every response shape lives here |
| `lib/db/` | `schema.sql`, versioned migrations (`migrate.ts`) and repositories (`repos-*.ts`) |
| `worker/index.ts` | Scheduler (intervals from env, last run persisted in `meta`), two lanes (scan, history), heartbeat, graceful shutdown |
| `scripts/` | Maintenance and demo scripts |
| `public/brand/`, `app/icon.svg` | Logo and favicon |

## Rules

### Database

- **Migrations are versioned and append-only.** Add a new step at the end of `MIGRATIONS` in
  `lib/db/migrate.ts`. Never edit or reorder an existing step: deployed databases have already run it.
  The version lives in `PRAGMA user_version`; each step runs inside `BEGIN IMMEDIATE` and re-checks
  the version so web and worker can start at the same time.
- `lib/db/schema.sql` is the base schema run by migration 1 (fx already in its current shape). Tables
  added later (Aave reserve state, ledger, bridge pairs, smart wallet suggestions, Curve markets and
  positions, Aave rates) live in their own migration step with `CREATE TABLE IF NOT EXISTS`; read
  `migrate.ts` for the full schema. The test suites build their own inline schema
  (`lib/queries/__tests__/queries.test.ts`), so a schema change may need it updated too.
- Money is stored in **USD**, timestamps in **unix seconds**.

### RPC

- Use the pools, never raw `fetch` to an RPC: `archiveRpc(chain)` (`lib/history/rpc.ts`) for
  historical state, `latestRpc(chain)` / `logsLatestRpc(chain)` (`lib/scan/rpc-latest.ts`) for live
  state and incremental logs.
- Pool behaviour: endpoints are tried in order of their next free slot and throttled individually
  (about 10 rps for the env endpoint, 2.5 rps for public ones). 429, 5xx, timeouts, auth and archive
  errors rotate to the next endpoint. Three consecutive failures disable an endpoint with exponential
  backoff (up to 5 minutes). An `eth_getLogs` range-limit rejection rotates **without** counting as a
  failure; if every endpoint refuses, the caller must chunk the range.
- The env (Alchemy) URL goes **first** in the archive and latest pools and **last** in the logs pool,
  because the free tier only accepts tiny `eth_getLogs` ranges.
- Execution reverts (`RpcExecutionError`) are not retried.
- Long jobs must honour the `AbortSignal` passed in, so shutdown and job cancellation work.

### Prices and amounts

- Price keys are canonical: `coingecko:<id>` for well-known assets (ETH and WETH both map to
  `coingecko:ethereum`), otherwise `<chain>:<lowercase address>`. Use `canonicalPriceKey()` in
  `lib/history/price-keys.ts`. The symbol fallback applies **only** to trusted tokens (Aave reserve
  underlyings), never to arbitrary ERC-20s, or spam tokens could borrow a real price.
- Debt sign: stored balance rows carry `side = 'borrow'` and the read models apply the sign
  (`lib/queries/state.ts` turns borrowed USD negative). In the API, `TokenRow.usd` and net values are
  **negative** for debt, while summary fields such as `debtUsd`, `borrowedUsd` and `withdrawalsUsd`
  are **positive** numbers. Read the doc comment on each field in `api-types.ts` before using it.
- Aave aTokens are valued as their underlying; variable debt tokens as negative underlying.
- Ledger kinds: only value exchanged with externally owned accounts (and unpaired Arbitrum bridge legs)
  is a deposit / withdrawal. Legs with Aave reserves and Curve crvUSD / LlamaLend controllers, AMMs and
  vaults (`curve_markets`) become `aave-*` / `curve-*` kinds; other contracts are `other` or `swap`.
- `balances.protocol` / `position_values.protocol` is `wallet`, `aave-v3`, `curve-crvusd` or `llamalend`. Curve loans use the AMM
  (collateral) and Controller (debt, soft liquidation part) addresses as pseudo tokens with `tokens.market` set to the market key.

### PnL and ROI

These definitions are deliberate. Do not "simplify" them into net-worth change.

- `pnlUsd`: for every pair of consecutive history points, the amount held at the earlier point times
  the price change, per (address, chain, token), debt negative. Transfers between tracked addresses
  and deposits never show up as profit or loss.
- `returnPct`: `pnlUsd / (startUsd + peak cumulative net deposits in the window)`; `null` when that
  capital is below $1.
- `interestUsd` (Aave interest earned - paid, `lib/queries/yield.ts`) and `gasUsd` (positive cost) are
  reported separately; `otherUsd = changeUsd - pnlUsd - interestUsd + gasUsd` (deposits and
  withdrawals). Without yield data the two fields are absent and `otherUsd = changeUsd - pnlUsd`.
- Interest is measured as balance change minus principal from the ledger; Aave aToken / debt token
  mint and burn `Transfer` amounts include accrued interest and are never principal. The daily reserve
  indices (`aave_rates`) cross-check it and are the fallback.
- `unleveredUsd` on history points: the same deposits / withdrawals, but the gross assets' price
  return instead of the leveraged one (equals `total` without debt).
- Currency split (`PnlPeriod.currencies`): market = sum of pnl_t x rate_t, currency effect = sum of
  netWorth_{t-1} x (rate_t - rate_{t-1}), other = the rest; the parts sum exactly to the change.

### UI and formatting

- **Every money or token amount must go through the helpers in `components/format.ts`** (`fmtMoney`,
  `moneyParts`, `fmtAmount`, `fmtUnits`, ...). They honour stealth mode (`MASK`, toggled with `h`).
  Rendering a raw number, or building a string with `toFixed`/`toLocaleString`, leaks amounts in
  stealth mode. Percentages, prices, rates and ratios stay visible by design.
- Swiss number conventions: apostrophe thousands separator (`1'234'567.89`), dates as `dd.mm.yyyy`,
  subscript zeros for tiny amounts (`0.0₅12`), `-` for empty values. Prices in CHF are written like
  `CHF 100.-` in prose.
- Display currency is USD, EUR or CHF, converted with the selected currency's daily rate of the point's day
  (`rateAt` in `Providers`). EUR renders as `€36'428`, CHF as `CHF 36'428.-`. Values from
  `PnlPeriod.currencies` are already in the display currency: format them with rate 1
  (`components/views/pnl-display.ts`).
- Use design tokens from `styles/tokens.css`; both light and dark themes must keep working.

### API contract

- `lib/queries/api-types.ts` is the single source of truth for response shapes. When you add or
  change a field, update the type, the query that fills it and every consumer in the same change.
  Document units and sign in a doc comment on the field.
- Route handlers validate input with `zod` and return `ApiError` (`{ error, details? }`) on failure.

### Writing style

- **Never use em dashes or en dashes** anywhere: code, comments, docs, commit messages, UI copy.
  Use a hyphen, comma, colon or a new sentence. Number ranges use a hyphen (`6-8`).
- Comments explain *why*, not what. Keep them short.

## Testing

- Tests use `node:test` via `tsx` with `--experimental-sqlite` and the built-in `node:sqlite`
  (`DatabaseSync`) on a **temporary database** created per suite. They make no network calls.
- New query or ledger logic needs a test next to the existing ones (`lib/*/__tests__/`), and new test
  files must be added to the `test` script in `package.json`.
- For manual checks use the demo database (`npm run demo:data`). It exercises every feature (leveraged Aave
  position with rate history, Curve loan, EUR / CHF, bridge pair, gas, a pending suggestion); README
  screenshots in `docs/images/` are taken from it, never from a real database.
- **Never point tests, scripts or experiments at a production database.** Copy it first if you must.

## Safety

- Never commit secrets: `.env`, RPC URLs with keys, API keys. `.env.example` holds empty placeholders
  only.
- Never commit real wallet addresses, labels or balances. Fixtures use synthetic addresses such as
  `0x1111111111111111111111111111111111111111`; well-known contract addresses (tokens, Aave pools,
  Multicall3) are fine.
- Never commit databases (`data/`), logs, screenshots of a real portfolio or local planning notes.
- The app has no authentication. Do not change the default bind address away from `127.0.0.1`.
  The only exception is `/api/bot/*`: read-only and gated by `BOT_API_TOKEN` (`requireBotToken`).
  Never add write endpoints there.

## PR checklist

- [ ] `npm run typecheck` and `npm test` pass (and `npm run build` for UI or route changes)
- [ ] New migrations appended, none edited; `schema.sql` and test schemas updated
- [ ] `api-types.ts` and all consumers updated together
- [ ] Every new amount rendered through `components/format.ts` (check with stealth mode on)
- [ ] No em or en dashes, no secrets, no real addresses
- [ ] README / this file updated if behaviour, config or commands changed
