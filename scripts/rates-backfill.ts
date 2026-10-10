// CLI: one-shot daily Aave rate / index backfill (lib/history/aave-rates.ts) plus the EUR / CHF fx
// history, against DATABASE_PATH (default ./data/portfolio.db). Resumable: stored days are skipped.
//
//   npx tsx scripts/rates-backfill.ts [--chains arbitrum,ethereum] [--no-fx]
import { syncAaveRateHistory } from '../lib/history/aave-rates';
import { syncFx } from '../lib/history/prices';
import { DAY, dayStart, nowSec, type HistoryChain } from '../lib/history/types';
import { histEarliestStartTs } from '../lib/db/repos-history';
import { databasePath, loadEnv, migrateDb, openDb } from '../lib/scan/env';
import { createLogger } from '../lib/scan/log';

async function main(): Promise<void> {
  loadEnv();
  const log = createLogger('rates', { json: false });
  const db = openDb(databasePath());
  await migrateDb(db, log);
  const i = process.argv.indexOf('--chains');
  const chains = i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter((c): c is HistoryChain => c === 'ethereum' || c === 'arbitrum') : undefined;
  const ctrl = new AbortController();
  process.on('SIGINT', () => ctrl.abort());
  if (!process.argv.includes('--no-fx')) {
    const from = dayStart(histEarliestStartTs(db) ?? nowSec() - 365 * DAY);
    const n = await syncFx({ db, log, signal: ctrl.signal }, from);
    log.info(`fx: ${n} new (day, currency) rows`);
  }
  const r = await syncAaveRateHistory({ db, log, signal: ctrl.signal, chains: chains?.length ? chains : undefined });
  console.log(JSON.stringify(r));
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
