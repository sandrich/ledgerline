// Versioned migrations. Run automatically on startup of the web app
// (lib/queries/server-db.ts) and the worker / scripts (lib/scan/env.ts migrateDb).
// The version lives in PRAGMA user_version. Each step runs inside BEGIN IMMEDIATE and re-checks
// the version, so web and worker starting at the same time cannot apply a step twice.
import fs from 'node:fs';
import path from 'node:path';

/** The subset of better-sqlite3 / node:sqlite used here. */
interface MigrateDb {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}

function schemaSql(): string {
  const candidates = [path.join(process.cwd(), 'lib/db/schema.sql'), path.join(path.dirname(new URL(import.meta.url).pathname), 'schema.sql')];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  throw new Error('lib/db/schema.sql not found (run from the project root)');
}

function tableSql(db: MigrateDb, name: string): string | null {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined;
  return r?.sql ?? null;
}

/**
 * Rebuild a table created without AUTOINCREMENT (older scratch schema) and seed sqlite_sequence
 * past every id still referenced anywhere, so ids of purged rows are never reused.
 */
function ensureAutoincrement(db: MigrateDb, table: 'wallets' | 'addresses', createSql: string, cols: string, refs: [string, string][]): void {
  const cur = tableSql(db, table);
  if (cur && !/AUTOINCREMENT/i.test(cur)) {
    db.exec(`DROP TABLE IF EXISTS ${table}__new`);
    db.exec(createSql.replace(`IF NOT EXISTS ${table} (`, `${table}__new (`));
    db.exec(`INSERT INTO ${table}__new (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
  }
  let max = 0;
  for (const [t, c] of [[table, 'id'] as [string, string], ...refs]) {
    if (!tableSql(db, t)) continue;
    const r = db.prepare(`SELECT MAX(${c}) AS m FROM ${t}`).get() as { m: number | null };
    max = Math.max(max, Number(r?.m ?? 0));
  }
  if (!tableSql(db, 'sqlite_sequence')) return;
  const seq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as { seq: number } | undefined;
  if (!seq) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, max);
  else if (seq.seq < max) db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(max, table);
}

const ADDRESS_REFS: [string, string][] = [
  ['wallet_addresses', 'address_id'],
  ['address_tokens', 'address_id'],
  ['discovery_state', 'address_id'],
  ['balances', 'address_id'],
  ['position_values', 'address_id'],
  ['aave_accounts', 'address_id'],
  ['daily_flags', 'address_id'],
];

const MIGRATIONS: ((db: MigrateDb) => void)[] = [
  // 1: base schema
  (db) => db.exec(schemaSql()),
  // 2: AUTOINCREMENT ids for wallets / addresses on databases created by the scratch schema
  (db) => {
    const sql = schemaSql();
    const create = (t: string) => {
      const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([^;]*\\);`));
      if (!m) throw new Error(`schema.sql has no ${t} table`);
      return m[0];
    };
    db.exec(create('daily_flags'));
    ensureAutoincrement(db, 'wallets', create('wallets'), 'id, name, color, sort, excluded, created_at', [['wallet_addresses', 'wallet_id']]);
    ensureAutoincrement(db, 'addresses', create('addresses'), 'id, address, label, chains, is_contract, excluded, created_at', ADDRESS_REFS);
  },
  // 3: Aave rates / risk parameters per live snapshot, user eMode and on-chain weighted LT / LTV
  (db) => {
    db.exec(AAVE_RISK_SQL);
    const cols = new Set((db.prepare('PRAGMA table_info(aave_accounts)').all() as { name: string }[]).map((c) => c.name));
    const add: [string, string][] = [
      ['emode', 'INTEGER'],
      ['emode_ltv_bps', 'INTEGER'],
      ['emode_lt_bps', 'INTEGER'],
      ['emode_bitmap', 'TEXT'],
      ['user_config', 'TEXT'],
      ['ltv_bps', 'INTEGER'],
      ['lt_bps', 'INTEGER'],
    ];
    for (const [c, t] of add) if (!cols.has(c)) db.exec(`ALTER TABLE aave_accounts ADD COLUMN ${c} ${t}`);
  },
  // 4: transactions ledger (lib/ledger)
  (db) => db.exec(LEDGER_SQL),
  // 5: LEDGER: counterparty code cache, bridge pairs, smart wallet suggestions
  (db) => db.exec(LEDGER_V5_SQL),
  // 6: CRVUSD: Curve crvUSD / LlamaLend market registry and per snapshot position detail
  (db) => db.exec(CURVE_SQL),
  // 7: YIELD: per currency fx (EUR, CHF) migrated from the USD -> CHF table, daily Aave rate history
  (db) => migrateYieldFx(db),
];

/**
 * aave_reserve_state: per (live snapshot, market, reserve) the current supply / variable borrow APY
 * (fractions, from the ray rates with per second compounding) and the reserve's LTV / liquidation
 * threshold in basis points (configuration bits 0-15 / 16-31), reserve id (for the user configuration
 * and eMode bitmaps) and the configuration's eMode category (bits 168-175, v3.0 / v3.1).
 * aave_accounts gains (all nullable, only written by the live snapshot): the user's eMode category
 * and that category's LTV / LT / collateral bitmap, the user configuration bitmap (decimal string,
 * bit 2*id+1 = reserve used as collateral) and getUserAccountData's weighted LTV / LT.
 */
const AAVE_RISK_SQL = `
CREATE TABLE IF NOT EXISTS aave_reserve_state (snapshot_id INTEGER NOT NULL, chain TEXT NOT NULL, market TEXT NOT NULL, asset TEXT NOT NULL,
  reserve_id INTEGER, supply_apy REAL, borrow_apy REAL, ltv_bps INTEGER, lt_bps INTEGER, emode_category INTEGER,
  PRIMARY KEY (snapshot_id, market, asset));
CREATE INDEX IF NOT EXISTS aave_reserve_state_market ON aave_reserve_state(market, snapshot_id);
`;

/**
 * Transactions ledger (lib/ledger, read by lib/queries/transactions.ts and flows.ts).
 * - tx: one row per (chain, hash). from_addr is the transaction sender when known (Alchemy external
 *   transfers or a receipt), fee_wei / fee_usd only for transactions sent by a tracked EOA.
 * - tx_transfers: every ERC20 Transfer / Approval log and native ETH movement that touches a tracked
 *   address. ref = 'log:<logIndex>' for logs, the Alchemy uniqueId tail for native ('external',
 *   'internal:<n>'). kind_hint: 'erc20' | 'native' | 'approval' | 'call' (zero value native call).
 *   amount (float, token units) / usd (value at the day's price) are nullable and filled later when
 *   token metadata or the daily price arrives. Token kind / spam flags are joined from tokens at query
 *   time, so a later spam reclassification needs no re-ingest.
 * - tx_addresses: tracked address participants (any tracked address, not only the one being scanned),
 *   with ts copied for (address, ts) ordered lookups.
 * - ledger_state: per (address, chain) the last block covered by log ingestion (last_block) and by
 *   native ingestion via alchemy_getAssetTransfers (native_block).
 */
const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS tx (chain TEXT NOT NULL, hash TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL,
  from_addr TEXT, receipt INTEGER DEFAULT 0, fee_wei TEXT, fee_usd REAL, PRIMARY KEY (chain, hash));
CREATE INDEX IF NOT EXISTS tx_ts ON tx(ts);
CREATE TABLE IF NOT EXISTS tx_transfers (chain TEXT NOT NULL, hash TEXT NOT NULL, ref TEXT NOT NULL, token TEXT NOT NULL,
  from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, amount_raw TEXT, amount REAL, usd REAL, kind_hint TEXT NOT NULL,
  PRIMARY KEY (chain, hash, ref));
CREATE TABLE IF NOT EXISTS tx_addresses (address_id INTEGER NOT NULL, chain TEXT NOT NULL, hash TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (address_id, chain, hash));
CREATE INDEX IF NOT EXISTS tx_addresses_ts ON tx_addresses(address_id, ts);
CREATE INDEX IF NOT EXISTS tx_addresses_tx ON tx_addresses(chain, hash);
CREATE TABLE IF NOT EXISTS ledger_state (address_id INTEGER NOT NULL, chain TEXT NOT NULL, last_block INTEGER, native_block INTEGER,
  updated_at INTEGER, error TEXT, PRIMARY KEY (address_id, chain));
`;

/**
 * LEDGER v5 (lib/ledger, lib/scan/smart-wallets.ts):
 * - address_code: eth_getCode cache per (chain, counterparty) at the latest block. is_contract = 1 for
 *   contracts, 0 for EOAs (EIP-7702 delegated EOAs count as EOAs). Only EOA counterparties make
 *   deposits / withdrawals.
 * - bridge_pairs: Arbitrum native bridge transfers whose L1 leg and L2 leg both touch tracked
 *   addresses; both legs are then classified as transfers between those addresses (internal).
 *   l1_addr / l2_addr are the tracked addresses on each side.
 * - smart_wallet_suggestions: Safes / DSProxies owned by a tracked EOA, one row per (chain, address).
 *   status 'pending' | 'accepted' | 'dismissed'.
 */
const LEDGER_V5_SQL = `
CREATE TABLE IF NOT EXISTS address_code (chain TEXT NOT NULL, address TEXT NOT NULL, is_contract INTEGER NOT NULL, checked_at INTEGER NOT NULL,
  PRIMARY KEY (chain, address));
CREATE TABLE IF NOT EXISTS bridge_pairs (l1_hash TEXT NOT NULL, l1_ref TEXT NOT NULL, l1_addr TEXT NOT NULL, l2_hash TEXT NOT NULL, l2_ref TEXT NOT NULL,
  l2_addr TEXT NOT NULL, direction TEXT NOT NULL, PRIMARY KEY (l1_hash, l1_ref));
CREATE UNIQUE INDEX IF NOT EXISTS bridge_pairs_l2 ON bridge_pairs(l2_hash, l2_ref);
CREATE TABLE IF NOT EXISTS smart_wallet_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, address TEXT NOT NULL,
  owner_address_id INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, updated_at INTEGER,
  UNIQUE (chain, address));
`;

// ---------- 7: YIELD + FX ----------

/**
 * fx: units of a display currency per USD per calendar day (Frankfurter, forward filled), one row
 * per (day, currency). The old fx(day, usd_chf) rows become currency 'CHF'. A fresh database already
 * has the new shape from schema.sql, so this is a no-op there.
 * aave_rates: daily Aave reserve state read at the daily backfill blocks (lib/history/aave-rates.ts):
 * supply / variable borrow APY (fractions) and the liquidity / variable borrow index (ray / 1e27) at
 * ts (the block's day start), only for reserves a tracked address held around that day.
 */
const FX_V7_SQL = `CREATE TABLE IF NOT EXISTS fx (day TEXT NOT NULL, currency TEXT NOT NULL, rate_from_usd REAL NOT NULL, PRIMARY KEY (day, currency));`;
const AAVE_RATES_SQL = `
CREATE TABLE IF NOT EXISTS aave_rates (chain TEXT NOT NULL, market TEXT NOT NULL, asset TEXT NOT NULL, ts INTEGER NOT NULL,
  block INTEGER, supply_apy REAL, borrow_apy REAL, liquidity_index REAL, borrow_index REAL,
  PRIMARY KEY (market, asset, ts));
CREATE INDEX IF NOT EXISTS aave_rates_chain_ts ON aave_rates(chain, ts);
`;

function migrateYieldFx(db: MigrateDb): void {
  const cols = new Set((db.prepare('PRAGMA table_info(fx)').all() as { name: string }[]).map((c) => c.name));
  if (cols.has('usd_chf')) {
    db.exec('ALTER TABLE fx RENAME TO fx_v6');
    db.exec(FX_V7_SQL);
    db.exec("INSERT OR IGNORE INTO fx (day, currency, rate_from_usd) SELECT day, 'CHF', usd_chf FROM fx_v6 WHERE usd_chf > 0");
    db.exec('DROP TABLE fx_v6');
  } else db.exec(FX_V7_SQL);
  db.exec(AAVE_RATES_SQL);
}

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: MigrateDb): number {
  const version = () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  while (version() < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const v = version();
      if (v < MIGRATIONS.length) {
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
  return version();
}

export default migrate;

/**
 * CRVUSD (lib/protocols/curve-crvusd.ts).
 * - curve_markets: every crvUSD mint market (ControllerFactory) and LlamaLend market (OneWayLendingFactory)
 *   per chain: controller, AMM, vault (lending only), collateral / borrowed token with symbol, decimals and
 *   canonical price key, and the market key used in tokens.market (e.g. eth-crvusd-3-weth).
 * - curve_positions: per (snapshot, address, controller) the raw position (collateral units, borrowed token
 *   in the AMM bands while in soft liquidation, debt units), its USD values, Curve health as a fraction
 *   (0 = liquidation, null without a loan) and the AMM borrow APY (live snapshots only). Written by live
 *   snapshots and the daily backfill. Values / net worth come from balances + position_values as usual;
 *   this table only carries the protocol specific detail.
 */
const CURVE_SQL = `
CREATE TABLE IF NOT EXISTS curve_markets (chain TEXT NOT NULL, controller TEXT NOT NULL, kind TEXT NOT NULL, idx INTEGER NOT NULL,
  amm TEXT NOT NULL, vault TEXT, collateral TEXT NOT NULL, borrowed TEXT NOT NULL, collateral_symbol TEXT, borrowed_symbol TEXT,
  collateral_decimals INTEGER NOT NULL, borrowed_decimals INTEGER NOT NULL, collateral_key TEXT NOT NULL, borrowed_key TEXT NOT NULL,
  market TEXT NOT NULL, PRIMARY KEY (chain, controller));
CREATE UNIQUE INDEX IF NOT EXISTS curve_markets_kind_idx ON curve_markets(chain, kind, idx);
CREATE TABLE IF NOT EXISTS curve_positions (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL,
  market TEXT NOT NULL, controller TEXT NOT NULL, protocol TEXT NOT NULL, collateral REAL, stablecoin REAL, debt REAL,
  collateral_usd REAL, debt_usd REAL, health REAL, borrow_apy REAL, PRIMARY KEY (snapshot_id, address_id, controller));
CREATE INDEX IF NOT EXISTS curve_positions_addr ON curve_positions(address_id);
CREATE INDEX IF NOT EXISTS curve_positions_snap ON curve_positions(snapshot_id);
`;
