# Contributing to ledgerline

Thanks for taking the time to contribute. Bug reports, docs fixes, new chains and protocols are all
welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

Coding agents and anyone touching the code should also read [AGENTS.md](AGENTS.md): it lists the
rules that keep the numbers correct (migrations, price keys, PnL definitions, stealth mode).

## Getting set up

You do not need an RPC key to work on the UI or the read models.

```bash
git clone https://github.com/<your-user>/ledgerline.git
cd ledgerline
npm ci
npm run demo:data                         # synthetic database in ./data/demo.db
DATABASE_PATH=./data/demo.db npm run dev  # http://127.0.0.1:8790
```

To work on scanning, history or the activity ledger you need real chain data:

```bash
cp .env.example .env    # add your free Alchemy URLs, see the README
npm run dev
npm run worker          # second terminal
```

Use a throwaway database (`DATABASE_PATH=./data/dev.db`) and public addresses you are happy to see in
logs. Never test against a database you care about.

## Workflow

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
2. Fork the repository and create a branch from `main`:
   `feat/base-chain`, `fix/hf-rounding`, `docs/tailscale`.
3. Make your change, with tests where it makes sense.
4. Run the checks below.
5. Open a pull request against `main` and fill in the template. Keep PRs focused: one topic per PR.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(ledger): label Uniswap v3 swaps
fix(history): retry DefiLlama 429 with backoff
docs: explain Alchemy network setup
refactor(queries): split risk metrics
test(pnl): cover debt repayment between own addresses
chore: bump next to 15.x
```

Write the subject in the imperative mood and keep it under about 72 characters.

### Checks

```bash
npm run typecheck
npm test
npm run build      # for UI or route handler changes
```

CI runs the same three on every pull request.

Before you push, also check:

- Amounts in the UI go through `components/format.ts` (toggle stealth mode with `h` and make sure
  nothing leaks).
- No em or en dashes in code, comments, docs or UI copy.
- No secrets, no real wallet addresses, no databases or screenshots of a real portfolio.

## Adding a chain or a protocol

These are the most valuable contributions and also the most involved. Open an issue first and expect
a few review rounds. At a high level:

### A new EVM chain

1. Add the chain to the `Chain` type and `CHAINS` in `lib/queries/api-types.ts`, and to the history
   chain types in `lib/history/types.ts`.
2. Add endpoints to the RPC pools (`lib/history/rpc.ts`, `lib/scan/rpc-latest.ts`), with an env
   variable for a keyed URL and a few keyless public fallbacks.
3. Teach token discovery (`lib/scan/discover.ts`) where to find candidate tokens on that chain.
4. Map well-known tokens to canonical price keys in `lib/history/price-keys.ts`.
5. Check block-by-timestamp, Multicall3 availability and `alchemy_getAssetTransfers` support for the
   ledger (`lib/ledger/sources.ts`).
6. Add a migration if anything in the schema assumes the current chain list.
7. Update the README (features, limitations, Alchemy networks to enable).

### A new protocol

1. Write a reader that returns supplied and borrowed balances for an address at a given block
   (`lib/history/aave.ts` is the reference implementation, using Multicall3).
2. Use it from both the live snapshot (`lib/scan/live.ts`) and the daily backfill
   (`lib/history/backfill.ts`), so live and historical values agree.
3. Store positions with the existing balance rows (`protocol`, `side = 'supply' | 'borrow'`) and
   keep the debt sign convention: the read models turn borrowed values negative (see AGENTS.md).
4. Price receipt tokens as their underlying so PnL stays holdings-based.
5. Extend the `ProtocolPosition` type in `api-types.ts` and the address view.
6. Teach the ledger classifier (`lib/ledger/classify.ts`) the protocol's actions and add tests.

## Reporting bugs and requesting features

Use the issue forms on GitHub. Please do **not** paste wallet addresses, RPC URLs or the contents of
your `.env` into issues. Redact them, or reproduce with a public address.

Security issues: see [SECURITY.md](SECURITY.md) and report them privately.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
