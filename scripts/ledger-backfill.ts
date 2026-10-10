// CLI: one-shot transactions ledger run (the worker's 'ledger' job) for all addresses or a subset.
//
//   npx tsx scripts/ledger-backfill.ts                       # all addresses, both chains
//   npx tsx scripts/ledger-backfill.ts --address 0x...          # one tracked address
//   options: --chains arbitrum,ethereum  --receipts 2000 (max fee receipts per chain, 0 = none)
//
// DATABASE_PATH selects the sqlite file (default ./data/portfolio.db). Incremental: re-running
// continues from ledger_state.
import { runLedger } from '../lib/ledger/ingest';
import { loadEnv, migrateDb, openDb, databasePath } from '../lib/scan/env';
import { createLogger } from '../lib/scan/log';
import type { HistoryChain } from '../lib/history/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

async function main(): Promise<void> {
  loadEnv();
  const log = createLogger('ledger', { json: false });
  const file = databasePath();
  const db = openDb(file);
  await migrateDb(db, log);
  log.info(`database ${file}`);

  let addressIds: number[] | undefined;
  const a = arg('address');
  if (a) {
    const row = db.prepare('SELECT id FROM addresses WHERE lower(address) = ?').get(a.toLowerCase()) as { id: number } | undefined;
    if (!row) throw new Error(`address ${a} is not tracked`);
    addressIds = [row.id];
  }
  const chains = arg('chains')
    ?.split(',')
    .filter((c): c is HistoryChain => c === 'ethereum' || c === 'arbitrum');
  const receipts = arg('receipts');

  const ctrl = new AbortController();
  process.on('SIGINT', () => {
    log.warn('SIGINT: stopping (progress is saved per address and chain)');
    ctrl.abort();
  });

  const t0 = Date.now();
  const r = await runLedger({
    db,
    log,
    signal: ctrl.signal,
    addressIds,
    chains: chains?.length ? chains : undefined,
    receiptBudget: receipts != null && receipts !== '' ? Number(receipts) : undefined,
  });
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  console.log(
    JSON.stringify(
      {
        runtimeSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
        calls: { ...r.stats },
        amountsFilled: r.amountsFilled,
        pricesFilled: r.pricesFilled,
        feesFetched: r.feesFetched,
        codesChecked: r.codesChecked,
        bridgePairs: r.bridgePairs,
        rows: { tx: count('tx'), tx_transfers: count('tx_transfers'), tx_addresses: count('tx_addresses'), ledger_state: count('ledger_state') },
        pairs: r.pairs,
      },
      null,
      2,
    ),
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
