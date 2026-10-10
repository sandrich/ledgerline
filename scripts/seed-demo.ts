// Seed a wallet "Demo" with one address, then enqueue discovery, live snapshot, hourly backfill
// (last 7 days, before the long daily one) and backfill jobs for the worker (skip with --no-jobs).
// Idempotent: re-running with the same address only re-enqueues the jobs.
//
//   npm run seed-demo -- 0xYourAddress [--no-jobs]
//   DEMO_ADDRESS=0xYourAddress npm run seed-demo
//
// The worker (npm run worker) then fills the database. For a fully synthetic database that needs no
// RPC access at all, use npm run demo:data instead.
import { scanEnqueueJob, scanEnsureAddress, scanEnsureWallet, scanLinkWalletAddress } from '../lib/db/repos-scan';
import { loadEnv, migrateDb, openDb, databasePath } from '../lib/scan/env';
import { createLogger, errMsg } from '../lib/scan/log';

function usage(): never {
  console.error('usage: npm run seed-demo -- <0x address> [--no-jobs]   (or set DEMO_ADDRESS)');
  process.exit(2);
}

async function main(): Promise<void> {
  loadEnv();
  const cli = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const address = (cli ?? process.env.DEMO_ADDRESS ?? '').trim().toLowerCase();
  if (!address) usage();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    console.error(`invalid address: ${address}`);
    usage();
  }
  const log = createLogger('seed', { json: false });
  const db = openDb();
  await migrateDb(db, log);
  const walletId = scanEnsureWallet(db, 'Demo', '#ea5a1f');
  const { id: addressId, created } = scanEnsureAddress(db, address, null, ['ethereum', 'arbitrum']);
  scanLinkWalletAddress(db, walletId, addressId);
  log.info(`wallet "Demo" #${walletId}, address ${address} #${addressId} (${created ? 'created' : 'already present'})`, { db: databasePath() });
  if (!process.argv.includes('--no-jobs')) {
    const jobs = [
      scanEnqueueJob(db, 'discovery', { addressId }),
      scanEnqueueJob(db, 'snapshot', {}),
      scanEnqueueJob(db, 'hourly-backfill', { addressId }),
      scanEnqueueJob(db, 'backfill', { addressId }),
    ];
    log.info(`enqueued jobs ${jobs.join(', ')} (discovery, snapshot, hourly-backfill, backfill) for the worker`);
  }
  db.close();
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exit(1);
});
