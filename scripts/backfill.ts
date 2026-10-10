// CLI: daily history backfill (+ price/FX history), optional seeding of an address and validation print.
//
//   npx tsx scripts/backfill.ts                      # all addresses
//   npx tsx scripts/backfill.ts --address 0x...      # seed address if missing, backfill only it
//   options: --chains arbitrum,ethereum  --concurrency 4  --redo  --rollup  --validate-only
//
// DATABASE_PATH selects the sqlite file (default ./data/portfolio.db).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runBackfill } from '../lib/history/backfill';
import { runRollup } from '../lib/history/rollup';
import { isoDay, parseIsoDay, type Db, type HistoryChain, type HistoryLogger } from '../lib/history/types';

// Always run from the repo root (works for both CJS and ESM builds).
const ROOT = process.cwd();

function loadEnv(): void {
  const f = path.join(ROOT, '.env');
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* ignore malformed env */
    }
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

const log: HistoryLogger = {
  debug: (m, d) => process.env.LOG_LEVEL === 'debug' && console.log(ts(), 'DEBUG', m, d ? JSON.stringify(d) : ''),
  info: (m, d) => console.log(ts(), 'INFO ', m, d ? JSON.stringify(d) : ''),
  warn: (m, d) => console.warn(ts(), 'WARN ', m, d ? JSON.stringify(d) : ''),
  error: (m, d) => console.error(ts(), 'ERROR', m, d ? JSON.stringify(d) : ''),
};
function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

async function migrate(db: Db): Promise<void> {
  // Prefer the real migrations when they exist; otherwise fall back to the scratch schema.
  const candidates = [path.join(ROOT, 'lib/db/migrate.ts'), path.join(ROOT, 'lib/db/migrate.js')];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const mod = (await import(c)) as Record<string, unknown>;
    const fn = (mod.migrate ?? mod.runMigrations ?? mod.default) as ((db: Db) => unknown) | undefined;
    if (typeof fn === 'function') {
      await fn(db);
      return;
    }
  }
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshots'").get();
  if (!hasTables) {
    log.warn('lib/db/migrate not found: applying lib/history/dev-schema.sql (scratch schema)');
    db.exec(fs.readFileSync(path.join(ROOT, 'lib/history/dev-schema.sql'), 'utf8'));
  }
}

function seedAddress(db: Db, address: string): number {
  const a = address.toLowerCase();
  const row = db.prepare('SELECT id FROM addresses WHERE address = ?').get(a) as { id: number } | undefined;
  if (row) return row.id;
  const now = Math.floor(Date.now() / 1000);
  const id = Number(
    db
      .prepare('INSERT INTO addresses (address, label, chains, is_contract, excluded, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(a, null, JSON.stringify(['ethereum', 'arbitrum']), null, now).lastInsertRowid,
  );
  const w = db.prepare('SELECT id FROM wallets ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  const walletId = w?.id ?? Number(db.prepare('INSERT INTO wallets (name, color, sort, excluded, created_at) VALUES (?, ?, 0, 0, ?)').run('Backfill', '#ea5a1f', now).lastInsertRowid);
  db.prepare('INSERT INTO wallet_addresses (wallet_id, address_id) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM wallet_addresses WHERE wallet_id = ? AND address_id = ?)').run(
    walletId,
    id,
    walletId,
    id,
  );
  log.info(`seeded address ${a} as id ${id}`);
  return id;
}

function validate(db: Db, addressId: number): void {
  const fx = (d: string) => (db.prepare('SELECT usd_chf FROM fx WHERE day = ?').get(d) as { usd_chf: number } | undefined)?.usd_chf;
  const first = db
    .prepare(
      `SELECT MIN(s.ts) AS t FROM snapshots s JOIN position_values pv ON pv.snapshot_id = s.id
       WHERE s.kind = 'daily' AND pv.address_id = ?`,
    )
    .get(addressId) as { t: number | null };
  const firstNonZero = db
    .prepare(
      `SELECT MIN(s.ts) AS t FROM snapshots s JOIN position_values pv ON pv.snapshot_id = s.id
       WHERE s.kind = 'daily' AND pv.address_id = ? AND abs(pv.usd) > 1`,
    )
    .get(addressId) as { t: number | null };
  console.log(`\nfirst daily point: ${first.t ? isoDay(first.t) : '-'}, first non-zero: ${firstNonZero.t ? isoDay(firstNonZero.t) : '-'}`);
  // up to 10 evenly spaced daily points between the first non-zero day and the latest daily snapshot
  const last = db
    .prepare(
      `SELECT MAX(s.ts) AS t FROM snapshots s JOIN position_values pv ON pv.snapshot_id = s.id
       WHERE s.kind = 'daily' AND pv.address_id = ?`,
    )
    .get(addressId) as { t: number | null };
  const from = firstNonZero.t ?? first.t;
  const dates: string[] = [];
  if (from != null && last.t != null) {
    const steps = Math.min(9, Math.round((last.t - from) / 86_400));
    for (let i = 0; i <= steps; i++) dates.push(isoDay(steps ? from + Math.round(((last.t - from) * i) / steps / 86_400) * 86_400 : from));
  }
  console.log('day        | supplied $ | borrowed $ | net $     | aave coll $ | aave debt $ | HF    | wallet $ | USDCHF');
  for (const d of dates) {
    const t = parseIsoDay(d);
    const snap = db.prepare("SELECT id FROM snapshots WHERE kind = 'daily' AND ts = ?").get(t) as { id: number } | undefined;
    if (!snap) {
      console.log(`${d} | (no snapshot)`);
      continue;
    }
    const b = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN side='supply' THEN usd END),0) AS sup, COALESCE(SUM(CASE WHEN side='borrow' THEN usd END),0) AS bor,
                COALESCE(SUM(CASE WHEN side='wallet' THEN usd END),0) AS wal FROM balances WHERE snapshot_id = ? AND address_id = ?`,
      )
      .get(snap.id, addressId) as { sup: number; bor: number; wal: number };
    const a = db
      .prepare('SELECT SUM(collateral_usd) AS c, SUM(debt_usd) AS d, MIN(health_factor) AS hf FROM aave_accounts WHERE snapshot_id = ? AND address_id = ?')
      .get(snap.id, addressId) as { c: number | null; d: number | null; hf: number | null };
    const f = (n: number | null | undefined, w = 10) => (n == null ? '-' : Math.round(n).toLocaleString('en-US')).padStart(w);
    console.log(
      `${d} | ${f(b.sup)} | ${f(-b.bor)} | ${f(b.sup + b.bor + b.wal, 9)} | ${f(a.c, 11)} | ${f(a.d, 11)} | ${(a.hf?.toFixed(3) ?? '-').padStart(5)} | ${f(b.wal, 8)} | ${fx(d)?.toFixed(4) ?? '-'}`,
    );
  }
}

async function main(): Promise<void> {
  loadEnv();
  const dbPath = path.resolve(ROOT, process.env.DATABASE_PATH ?? './data/portfolio.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  await migrate(db);

  const addrArg = arg('address');
  const target = addrArg || undefined;
  const addressId = target ? seedAddress(db, target) : undefined;
  const chains = arg('chains')
    ?.split(',')
    .filter((c): c is HistoryChain => c === 'ethereum' || c === 'arbitrum');

  const ctrl = new AbortController();
  process.on('SIGINT', () => {
    log.warn('SIGINT: stopping after in-flight days (progress is saved)');
    ctrl.abort();
  });

  const t0 = Date.now();
  if (arg('validate-only') === undefined) {
    const res = await runBackfill({
      db,
      log,
      signal: ctrl.signal,
      addressId,
      chains: chains?.length ? chains : undefined,
      concurrency: Number(arg('concurrency')) || undefined,
      redo: arg('redo') !== undefined,
    });
    if (arg('rollup') !== undefined) await runRollup({ db, log });
    console.log(`\nruntime ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(res.chains));
  }
  if (addressId != null) {
    validate(db, addressId);
    const st = db.prepare('SELECT chain, start_ts, backfill_done_days, backfill_total_days FROM discovery_state WHERE address_id = ?').all(addressId) as {
      chain: string;
      start_ts: number | null;
      backfill_done_days: number;
      backfill_total_days: number;
    }[];
    for (const s of st) console.log(`${s.chain}: start ${s.start_ts ? isoDay(s.start_ts) : '-'} progress ${s.backfill_done_days}/${s.backfill_total_days}`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
