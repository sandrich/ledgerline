// One-shot scan: token discovery + live snapshot, then a report read back from the database.
//
//   npx tsx scripts/scan-once.ts                    # all tracked addresses
//   npx tsx scripts/scan-once.ts --address 0xabc... # seed into wallet "Scan" if missing, then scan
//   options: --skip-discovery  --chains arbitrum,ethereum
//
// DATABASE_PATH selects the sqlite file (default ./data/portfolio.db).
import { formatUnits } from 'viem';
import {
  scanEnsureAddress,
  scanEnsureWallet,
  scanFindAddressId,
  scanLinkWalletAddress,
  type ScanChain,
} from '../lib/db/repos-scan';
import type { Db } from '../lib/history/types';
import { runDiscovery } from '../lib/scan/discover';
import { loadEnv, migrateDb, openDb, databasePath } from '../lib/scan/env';
import { runLiveSnapshot } from '../lib/scan/live';
import { createLogger, errMsg } from '../lib/scan/log';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/,/g, "'");

interface BalRow {
  chain: string;
  token: string;
  amount_raw: string;
  amount: number;
  usd: number;
  protocol: string;
  side: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  spam: number | null;
  kind: string | null;
  underlying: string | null;
  market: string | null;
}

function report(db: Db, snapshotId: number, addressId: number, address: string): number {
  const rows = db
    .prepare(
      `SELECT b.chain, b.token, b.amount_raw, b.amount, b.usd, b.protocol, b.side, t.symbol, t.name, t.decimals, t.spam, t.kind, t.underlying, t.market
       FROM balances b LEFT JOIN tokens t ON t.chain = b.chain AND lower(t.address) = lower(b.token)
       WHERE b.snapshot_id = ? AND b.address_id = ? ORDER BY b.chain, b.protocol, abs(b.usd) DESC`,
    )
    .all(snapshotId, addressId) as BalRow[];
  const underSym = (r: BalRow) => {
    if (!r.underlying) return r.symbol ?? r.token;
    const u = db.prepare('SELECT symbol FROM tokens WHERE chain = ? AND lower(address) = lower(?)').get(r.chain, r.underlying) as { symbol: string } | undefined;
    return u?.symbol ?? r.symbol ?? r.token;
  };
  const pv = db.prepare('SELECT chain, protocol, usd FROM position_values WHERE snapshot_id = ? AND address_id = ?').all(snapshotId, addressId) as {
    chain: string;
    protocol: string;
    usd: number;
  }[];
  const aave = db
    .prepare('SELECT market, collateral_usd, debt_usd, health_factor FROM aave_accounts WHERE snapshot_id = ? AND address_id = ?')
    .all(snapshotId, addressId) as { market: string; collateral_usd: number; debt_usd: number; health_factor: number | null }[];

  console.log(`\n=== ${address} (snapshot #${snapshotId})`);
  const chains = [...new Set(pv.map((p) => p.chain))];
  for (const c of chains) {
    const tot = pv.filter((p) => p.chain === c).reduce((s, p) => s + p.usd, 0);
    console.log(`  ${c.padEnd(9)} $${fmt(tot)}  (${pv
      .filter((p) => p.chain === c)
      .map((p) => `${p.protocol} $${fmt(p.usd)}`)
      .join(', ')})`);
  }
  const wallet = rows.filter((r) => r.side === 'wallet');
  const visible = wallet.filter((r) => !r.spam);
  const hidden = wallet.filter((r) => r.spam);
  console.log('  Wallet tokens:');
  for (const r of visible) {
    const px = r.amount ? r.usd / r.amount : 0;
    console.log(`    ${r.chain.padEnd(9)} ${(r.token === '0x0000000000000000000000000000000000000000' ? 'ETH' : r.symbol ?? '?').padEnd(10)} amount ${r.amount.toPrecision(6).padStart(14)}  price $${fmt(px, 2)}  usd $${r.usd < 0.01 && r.usd > 0 ? '<0.01' : fmt(r.usd, 2)}`);
  }
  console.log(`  Hidden tokens (${hidden.length}): ${hidden.map((r) => `${r.symbol ?? '?'} "${(r.name ?? '').slice(0, 30)}" ${r.amount.toPrecision(4)}`).join('; ') || '-'}`);
  console.log('  Aave v3:');
  for (const r of rows.filter((x) => x.protocol === 'aave-v3')) {
    const amount = r.decimals != null ? Number(formatUnits(BigInt(r.amount_raw), r.decimals)) : r.amount;
    console.log(`    ${(r.market ?? '').padEnd(10)} ${r.side.padEnd(7)} ${underSym(r).padEnd(8)} ${amount.toFixed(7).padStart(16)}  usd $${fmt(r.usd, 2)}`);
  }
  for (const a of aave) {
    console.log(`    ${a.market.padEnd(10)} collateral $${fmt(a.collateral_usd, 2)} debt $${fmt(a.debt_usd, 2)} HF ${a.health_factor == null ? 'inf' : a.health_factor.toFixed(4)}`);
  }
  const net = pv.reduce((s, p) => s + p.usd, 0);
  console.log(`  NET $${fmt(net, 2)}`);

  return net;
}

async function main(): Promise<void> {
  loadEnv();
  const log = createLogger('scan-once', { json: false });
  const db = openDb();
  await migrateDb(db, log);
  log.info(`database ${databasePath()}`);

  let address = arg('address')?.toLowerCase();
  let addressIds: number[] | undefined;
  if (address) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`invalid address ${address}`);
    let id = scanFindAddressId(db, address);
    if (id == null) {
      const wallet = scanEnsureWallet(db, 'Scan', '#ea5a1f');
      id = scanEnsureAddress(db, address, null, ['ethereum', 'arbitrum']).id;
      scanLinkWalletAddress(db, wallet, id);
      log.info(`seeded ${address} as address #${id}`);
    }
    addressIds = [id];
  }
  const chainsArg = arg('chains');
  const chains = chainsArg ? (chainsArg.split(',').filter((c) => c === 'ethereum' || c === 'arbitrum') as ScanChain[]) : undefined;

  if (!process.argv.includes('--skip-discovery')) {
    await runDiscovery({ db, log, addressIds, chains });
  }
  const snap = await runLiveSnapshot({ db, log, chains });
  if (snap.snapshotId == null) {
    log.warn('no snapshot written');
    return;
  }
  const targets = addressIds ?? (db.prepare('SELECT id FROM addresses ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  let total = 0;
  for (const id of targets) {
    const a = db.prepare('SELECT address FROM addresses WHERE id = ?').get(id) as { address: string };
    total += report(db, snap.snapshotId, id, a.address);
  }
  if (targets.length > 1) console.log(`\nTOTAL $${fmt(total, 2)} (${targets.length} addresses)`);
  db.close();
}

main().catch((e) => {
  console.error('scan-once failed:', errMsg(e));
  process.exit(1);
});
