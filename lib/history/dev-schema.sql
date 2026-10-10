-- Scratch schema used ONLY by scripts/backfill.ts when the real migrations (lib/db/migrate.ts)
-- are not available. Mirrors lib/db/schema.sql; every statement is IF NOT EXISTS so it never
-- touches a database created by the real migrations.
CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, sort INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, label TEXT, chains TEXT, is_contract TEXT, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS wallet_addresses (wallet_id INTEGER NOT NULL, address_id INTEGER NOT NULL, PRIMARY KEY (wallet_id, address_id));
CREATE TABLE IF NOT EXISTS tokens (chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT, name TEXT, decimals INTEGER, kind TEXT, underlying TEXT, market TEXT, price_key TEXT, logo TEXT, spam INTEGER DEFAULT 0, PRIMARY KEY (chain, address));
CREATE TABLE IF NOT EXISTS address_tokens (address_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, first_block INTEGER, PRIMARY KEY (address_id, chain, token));
CREATE TABLE IF NOT EXISTS discovery_state (address_id INTEGER NOT NULL, chain TEXT NOT NULL, last_block INTEGER, start_block INTEGER, start_ts INTEGER, backfill_done_days INTEGER DEFAULT 0, backfill_total_days INTEGER DEFAULT 0, PRIMARY KEY (address_id, chain));
CREATE TABLE IF NOT EXISTS blocks (chain TEXT NOT NULL, ts INTEGER NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (chain, ts));
CREATE TABLE IF NOT EXISTS prices (price_key TEXT NOT NULL, ts INTEGER NOT NULL, usd REAL NOT NULL, granularity TEXT NOT NULL, PRIMARY KEY (price_key, granularity, ts));
CREATE TABLE IF NOT EXISTS fx (day TEXT NOT NULL, currency TEXT NOT NULL, rate_from_usd REAL NOT NULL, PRIMARY KEY (day, currency));
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS snapshots_kind_ts ON snapshots(kind, ts);
CREATE TABLE IF NOT EXISTS balances (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, amount_raw TEXT, amount REAL, usd REAL, protocol TEXT, side TEXT);
CREATE INDEX IF NOT EXISTS balances_snap ON balances(snapshot_id, address_id);
CREATE TABLE IF NOT EXISTS position_values (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, protocol TEXT NOT NULL, usd REAL NOT NULL);
CREATE INDEX IF NOT EXISTS pv_snap ON position_values(snapshot_id, address_id);
CREATE INDEX IF NOT EXISTS pv_addr ON position_values(address_id, chain, protocol);
CREATE TABLE IF NOT EXISTS aave_accounts (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, market TEXT NOT NULL, collateral_usd REAL, debt_usd REAL, health_factor REAL);
CREATE INDEX IF NOT EXISTS aave_snap ON aave_accounts(snapshot_id, address_id);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, status TEXT, progress INTEGER, total INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS daily_flags (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, missing_price_keys TEXT NOT NULL, PRIMARY KEY (snapshot_id, address_id, chain));
