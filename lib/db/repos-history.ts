// Repository functions used by lib/history (backfill, price history, rollup).
// Written against the lib/db/schema.sql column names. Inserts use WHERE NOT EXISTS / explicit
// select-then-write so they do not depend on particular UNIQUE constraints.
// Timestamps are unix SECONDS. fx.day is 'YYYY-MM-DD'. Daily snapshots use ts = UTC day start and
// hold the state at the END of that day (block at the next UTC midnight).
import type { Db, HistoryChain } from '../history/types';

export interface HistAddress {
  id: number;
  address: string;
  chains: HistoryChain[];
  excluded: boolean;
}

function parseChains(raw: unknown): HistoryChain[] {
  const all: HistoryChain[] = ['ethereum', 'arbitrum'];
  if (typeof raw !== 'string' || !raw) return all;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      const f = v.filter((c): c is HistoryChain => c === 'ethereum' || c === 'arbitrum');
      return f.length ? f : all;
    }
  } catch {
    /* fall through */
  }
  return all;
}

export function histListAddresses(db: Db, addressId?: number): HistAddress[] {
  const rows = (
    addressId != null
      ? db.prepare('SELECT id, address, chains, excluded FROM addresses WHERE id = ?').all(addressId)
      : db.prepare('SELECT id, address, chains, excluded FROM addresses ORDER BY id').all()
  ) as { id: number; address: string; chains: string | null; excluded: number | null }[];
  return rows.map((r) => ({ id: r.id, address: r.address.toLowerCase(), chains: parseChains(r.chains), excluded: !!r.excluded }));
}

// ---------- discovery_state ----------

export interface HistDiscoveryState {
  start_block: number | null;
  start_ts: number | null;
  backfill_done_days: number | null;
  backfill_total_days: number | null;
}

export function histGetDiscoveryState(db: Db, addressId: number, chain: HistoryChain): HistDiscoveryState | undefined {
  return db
    .prepare('SELECT start_block, start_ts, backfill_done_days, backfill_total_days FROM discovery_state WHERE address_id = ? AND chain = ?')
    .get(addressId, chain) as HistDiscoveryState | undefined;
}

/** True while the address row exists. Workers re-check this inside write transactions so a purge
 *  that happens mid-job never leaves orphan rows behind (which a re-used id would inherit). */
export function histAddressExists(db: Db, addressId: number): boolean {
  return !!db.prepare('SELECT 1 FROM addresses WHERE id = ?').get(addressId);
}

/** Creates the discovery_state row if missing; returns false (and writes nothing) for a purged address. */
function ensureDiscoveryRow(db: Db, addressId: number, chain: HistoryChain): boolean {
  if (!histAddressExists(db, addressId)) return false;
  db.prepare(
    `INSERT INTO discovery_state (address_id, chain, backfill_done_days, backfill_total_days)
     SELECT ?, ?, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM discovery_state WHERE address_id = ? AND chain = ?)`,
  ).run(addressId, chain, addressId, chain);
  return true;
}

export function histSetStart(db: Db, addressId: number, chain: HistoryChain, startBlock: number | null, startTs: number | null): void {
  db.transaction(() => {
    if (!ensureDiscoveryRow(db, addressId, chain)) return;
    db.prepare('UPDATE discovery_state SET start_block = ?, start_ts = ? WHERE address_id = ? AND chain = ?').run(startBlock, startTs, addressId, chain);
  })();
}

export function histSetProgress(db: Db, addressId: number, chain: HistoryChain, done: number, total: number): void {
  db.transaction(() => {
    if (!ensureDiscoveryRow(db, addressId, chain)) return;
    db.prepare('UPDATE discovery_state SET backfill_done_days = ?, backfill_total_days = ? WHERE address_id = ? AND chain = ?').run(done, total, addressId, chain);
  })();
}

/**
 * Durable "redo from" marker per (address, chain): days >= this UTC day must be rewritten (set by
 * discovery when a new token appears). Lowered-only on set; cleared by backfill once every day
 * from the marker on was rewritten without failures.
 */
const redoKey = (addressId: number, chain: HistoryChain) => `history:redo_from:${addressId}:${chain}`;

export function histGetRedoFrom(db: Db, addressId: number, chain: HistoryChain): number | null {
  const v = Number(histGetMeta(db, redoKey(addressId, chain)) ?? NaN);
  return Number.isFinite(v) ? v : null;
}

export function histRequestRedo(db: Db, addressId: number, chain: HistoryChain, fromDay: number): void {
  db.transaction(() => {
    if (!histAddressExists(db, addressId)) return;
    const cur = histGetRedoFrom(db, addressId, chain);
    if (cur == null || fromDay < cur) histSetMeta(db, redoKey(addressId, chain), String(fromDay));
  })();
}

/** Clears the marker only if it still equals `expected` (discovery may have lowered it meanwhile). */
export function histClearRedo(db: Db, addressId: number, chain: HistoryChain, expected: number): void {
  db.prepare('DELETE FROM meta WHERE key = ? AND value = ?').run(redoKey(addressId, chain), String(expected));
}

// ---------- tokens ----------

export interface HistTokenRow {
  chain: HistoryChain;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  kind: string | null;
  underlying: string | null;
  market: string | null;
  price_key: string | null;
  spam: number | null;
}

export interface HistAddressToken extends HistTokenRow {
  first_block: number | null;
}

export function histListAddressTokens(db: Db, addressId: number, chain: HistoryChain): HistAddressToken[] {
  return db
    .prepare(
      `SELECT at.token AS address, at.first_block, t.chain AS chain, t.symbol, t.name, t.decimals, t.kind, t.underlying, t.market, t.price_key, t.spam
       FROM address_tokens at LEFT JOIN tokens t ON t.chain = at.chain AND lower(t.address) = lower(at.token)
       WHERE at.address_id = ? AND at.chain = ?`,
    )
    .all(addressId, chain)
    .map((r) => ({ ...(r as HistAddressToken), chain, address: (r as HistAddressToken).address.toLowerCase() }));
}

export function histGetToken(db: Db, chain: HistoryChain, address: string): HistTokenRow | undefined {
  return db
    .prepare('SELECT chain, address, symbol, name, decimals, kind, underlying, market, price_key, spam FROM tokens WHERE chain = ? AND lower(address) = ?')
    .get(chain, address.toLowerCase()) as HistTokenRow | undefined;
}

/**
 * Insert or correct an Aave position token row. A token first registered as a plain 'erc20' (by
 * Transfer-log discovery, before its reserve was known) is upgraded so it is never valued twice.
 */
export function histUpsertAaveToken(db: Db, t: HistTokenRow): void {
  db.transaction(() => {
    histInsertTokenIfMissing(db, t);
    db.prepare(
      `UPDATE tokens SET kind = ?, underlying = ?, market = ?, price_key = ?, decimals = COALESCE(decimals, ?), spam = 0
       WHERE chain = ? AND lower(address) = ? AND (kind IS NULL OR kind NOT IN ('atoken','vdebt','sdebt') OR market IS NULL)`,
    ).run(t.kind, t.underlying, t.market, t.price_key, t.decimals, t.chain, t.address.toLowerCase());
  })();
}

export function histInsertTokenIfMissing(db: Db, t: HistTokenRow): void {
  db.prepare(
    `INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, spam)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE chain = ? AND lower(address) = ?)`,
  ).run(t.chain, t.address.toLowerCase(), t.symbol, t.name, t.decimals, t.kind, t.underlying, t.market, t.price_key, t.spam ?? 0, t.chain, t.address.toLowerCase());
}

export function histAddAddressToken(db: Db, addressId: number, chain: HistoryChain, token: string, firstBlock: number | null): void {
  if (!histAddressExists(db, addressId)) return;
  db.prepare(
    `INSERT INTO address_tokens (address_id, chain, token, first_block)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM address_tokens WHERE address_id = ? AND chain = ? AND lower(token) = ?)`,
  ).run(addressId, chain, token.toLowerCase(), firstBlock, addressId, chain, token.toLowerCase());
}

/** All Aave position tokens (aToken / variable debt / stable debt) registered for a chain. */
export function histListAaveTokens(db: Db, chain: HistoryChain): HistTokenRow[] {
  return db
    .prepare(
      `SELECT chain, address, symbol, name, decimals, kind, underlying, market, price_key, spam FROM tokens
       WHERE chain = ? AND kind IN ('atoken','vdebt','sdebt') AND market IS NOT NULL`,
    )
    .all(chain) as HistTokenRow[];
}

/** Distinct price keys of all tokens any address holds / held, plus all Aave tokens. */
export function histListNeededPriceKeys(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.price_key AS k FROM tokens t
       WHERE t.price_key IS NOT NULL AND (t.kind IN ('atoken','vdebt','sdebt','native')
         OR EXISTS (SELECT 1 FROM address_tokens at WHERE at.chain = t.chain AND lower(at.token) = lower(t.address)))`,
    )
    .all() as { k: string }[];
  return rows.map((r) => r.k);
}

export function histEarliestStartTs(db: Db): number | null {
  const r = db.prepare('SELECT MIN(start_ts) AS m FROM discovery_state WHERE start_ts IS NOT NULL').get() as { m: number | null };
  return r?.m ?? null;
}

// ---------- blocks ----------

export function histGetBlock(db: Db, chain: HistoryChain, ts: number): number | undefined {
  const r = db.prepare('SELECT number FROM blocks WHERE chain = ? AND ts = ?').get(chain, ts) as { number: number } | undefined;
  return r?.number;
}

export function histPutBlock(db: Db, chain: HistoryChain, ts: number, number: number): void {
  db.prepare('INSERT INTO blocks (chain, ts, number) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE chain = ? AND ts = ?)').run(
    chain,
    ts,
    number,
    chain,
    ts,
  );
}

// ---------- prices / fx / meta ----------

export function histDailyPriceRange(db: Db, key: string): { min: number | null; max: number | null } {
  return db.prepare("SELECT MIN(ts) AS min, MAX(ts) AS max FROM prices WHERE price_key = ? AND granularity = 'daily'").get(key) as {
    min: number | null;
    max: number | null;
  };
}

/** Immutable insert: an existing (key, day) daily price is never overwritten. Returns rows inserted. */
export function histInsertDailyPrices(db: Db, rows: { key: string; ts: number; usd: number }[]): number {
  const stmt = db.prepare(
    `INSERT INTO prices (price_key, ts, usd, granularity) SELECT ?, ?, ?, 'daily'
     WHERE NOT EXISTS (SELECT 1 FROM prices WHERE price_key = ? AND ts = ? AND granularity = 'daily')`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) n += stmt.run(r.key, r.ts, r.usd, r.key, r.ts).changes;
  })();
  return n;
}

export function histLoadDailyPrices(db: Db, keys: string[], fromTs: number): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const stmt = db.prepare("SELECT ts, usd FROM prices WHERE price_key = ? AND granularity = 'daily' AND ts >= ?");
  for (const k of keys) {
    const m = new Map<number, number>();
    for (const r of stmt.all(k, fromTs) as { ts: number; usd: number }[]) m.set(r.ts, r.usd);
    out.set(k, m);
  }
  return out;
}

/** Immutable insert of hourly prices (ts = UTC hour start). Returns rows inserted. */
export function histInsertHourlyPrices(db: Db, rows: { key: string; ts: number; usd: number }[]): number {
  const stmt = db.prepare(
    `INSERT INTO prices (price_key, ts, usd, granularity) SELECT ?, ?, ?, 'hourly'
     WHERE NOT EXISTS (SELECT 1 FROM prices WHERE price_key = ? AND ts = ? AND granularity = 'hourly')`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) n += stmt.run(r.key, r.ts, r.usd, r.key, r.ts).changes;
  })();
  return n;
}

/** Prices of one granularity ('hourly' / 'live' / 'daily') in [fromTs, toTs], per key: ts -> usd. */
export function histLoadPrices(db: Db, keys: string[], granularity: string, fromTs: number, toTs: number): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const stmt = db.prepare('SELECT ts, usd FROM prices WHERE price_key = ? AND granularity = ? AND ts >= ? AND ts <= ? ORDER BY ts');
  for (const k of keys) {
    const m = new Map<number, number>();
    for (const r of stmt.all(k, granularity, fromTs, toTs) as { ts: number; usd: number }[]) m.set(r.ts, r.usd);
    out.set(k, m);
  }
  return out;
}

export function histDeleteHourlyPricesBefore(db: Db, beforeTs: number): number {
  return db.prepare("DELETE FROM prices WHERE granularity = 'hourly' AND ts < ?").run(beforeTs).changes;
}

export function histGetMeta(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function histSetMeta(db: Db, key: string, value: string): void {
  db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key);
    if (exists) db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
    else db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
  })();
}

// fx: per (day, currency) units of the currency per USD since migration 7; these helpers are the CHF
// row (lib/history/prices.ts syncs every display currency).
export function histFxMaxDay(db: Db): string | null {
  const r = db.prepare("SELECT MAX(day) AS d FROM fx WHERE currency = 'CHF'").get() as { d: string | null };
  return r?.d ?? null;
}

export function histFxMinDay(db: Db): string | null {
  const r = db.prepare("SELECT MIN(day) AS d FROM fx WHERE currency = 'CHF'").get() as { d: string | null };
  return r?.d ?? null;
}

export function histInsertFx(db: Db, rows: { day: string; usdChf: number }[]): number {
  const stmt = db.prepare("INSERT OR IGNORE INTO fx (day, currency, rate_from_usd) VALUES (?, 'CHF', ?)");
  let n = 0;
  db.transaction(() => {
    for (const r of rows) n += Number(stmt.run(r.day, r.usdChf).changes);
  })();
  return n;
}

// ---------- snapshots ----------

export type SnapshotKind = 'live' | 'hourly' | 'daily';

export function histGetOrCreateSnapshot(db: Db, kind: SnapshotKind, ts: number): number {
  const r = db.prepare('SELECT id FROM snapshots WHERE kind = ? AND ts = ? ORDER BY id LIMIT 1').get(kind, ts) as { id: number } | undefined;
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO snapshots (ts, kind) VALUES (?, ?)').run(ts, kind).lastInsertRowid);
}

/** Days (UTC day start ts) for which a daily snapshot already has this address/chain written. */
export function histDoneDays(db: Db, addressId: number, chain: HistoryChain): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.ts AS ts FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id
       WHERE s.kind = 'daily' AND pv.address_id = ? AND pv.chain = ? AND pv.protocol = 'wallet'`,
    )
    .all(addressId, chain) as { ts: number }[];
  return new Set(rows.map((r) => r.ts));
}

export interface HistBalanceRow {
  token: string;
  amountRaw: string;
  amount: number;
  usd: number;
  protocol: string;
  side: 'wallet' | 'supply' | 'borrow';
}

export interface HistAaveAccountRow {
  market: string;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number | null;
}

export interface HistAddressDay {
  addressId: number;
  balances: HistBalanceRow[];
  positions: { protocol: string; usd: number }[];
  aave: HistAaveAccountRow[];
  /** Price keys with no historical price that day for a held, non-spam token (valued at $0). */
  missingPriceKeys?: string[];
}

/**
 * Write one (chain, day) for several addresses into the shared daily snapshot.
 * Replaces any rows previously written for the same (snapshot, address, chain).
 */
export function histWriteDailyChainDay(db: Db, chain: HistoryChain, dayTs: number, chainMarkets: string[], entries: HistAddressDay[]): void {
  writeChainSlices(db, 'daily', chain, dayTs, chainMarkets, entries, false);
}

const HOUR = 3600;

/**
 * Hours (UTC hour start ts in [fromTs, toTs]) that already have data for an (address, chain): an
 * hourly slice at that hour (backfilled, or rolled up from live data) or any live slice inside it.
 */
export function histCoveredHours(db: Db, addressId: number, chain: HistoryChain, fromTs: number, toTs: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT (s.ts / ${HOUR}) * ${HOUR} AS h FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id
       WHERE pv.address_id = ? AND pv.chain = ? AND s.kind IN ('hourly', 'live') AND s.ts >= ? AND s.ts < ?`,
    )
    .all(addressId, chain, fromTs, toTs + HOUR) as { h: number }[];
  return new Set(rows.map((r) => r.h));
}

/**
 * Write one (chain, hour) for several addresses into the shared hourly snapshot at `hourTs`, but
 * only for addresses whose slice is not covered yet (no hourly slice at that hour, no live slice
 * inside it): hourly rows derived from real live data are never overwritten. Returns slices written.
 */
export function histWriteHourlyChainHour(db: Db, chain: HistoryChain, hourTs: number, chainMarkets: string[], entries: HistAddressDay[]): number {
  return writeChainSlices(db, 'hourly', chain, hourTs, chainMarkets, entries, true);
}

function writeChainSlices(
  db: Db,
  kind: 'daily' | 'hourly',
  chain: HistoryChain,
  ts: number,
  chainMarkets: string[],
  entries: HistAddressDay[],
  onlyIfUncovered: boolean,
): number {
  let written = 0;
  db.transaction(() => {
    const covered = db.prepare(
      `SELECT 1 FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id
       WHERE pv.address_id = ? AND pv.chain = ? AND ((s.kind = 'hourly' AND s.ts = ?) OR (s.kind = 'live' AND s.ts >= ? AND s.ts < ?)) LIMIT 1`,
    );
    const todo = entries.filter((e) => histAddressExists(db, e.addressId) && !(onlyIfUncovered && covered.get(e.addressId, chain, ts, ts, ts + HOUR)));
    if (!todo.length) return;
    const snap = histGetOrCreateSnapshot(db, kind, ts);
    const delBal = db.prepare('DELETE FROM balances WHERE snapshot_id = ? AND address_id = ? AND chain = ?');
    const delPv = db.prepare('DELETE FROM position_values WHERE snapshot_id = ? AND address_id = ? AND chain = ?');
    const marketPh = chainMarkets.map(() => '?').join(',');
    const delAave = chainMarkets.length
      ? db.prepare(`DELETE FROM aave_accounts WHERE snapshot_id = ? AND address_id = ? AND market IN (${marketPh})`)
      : null;
    const insBal = db.prepare(
      'INSERT INTO balances (snapshot_id, address_id, chain, token, amount_raw, amount, usd, protocol, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insPv = db.prepare('INSERT INTO position_values (snapshot_id, address_id, chain, protocol, usd) VALUES (?, ?, ?, ?, ?)');
    const insAave = db.prepare(
      'INSERT INTO aave_accounts (snapshot_id, address_id, market, collateral_usd, debt_usd, health_factor) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const hasFlags = kind === 'daily' && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_flags'").get();
    const delFlag = hasFlags ? db.prepare('DELETE FROM daily_flags WHERE snapshot_id = ? AND address_id = ? AND chain = ?') : null;
    const insFlag = hasFlags ? db.prepare('INSERT INTO daily_flags (snapshot_id, address_id, chain, missing_price_keys) VALUES (?, ?, ?, ?)') : null;
    for (const e of todo) {
      // (addresses purged while the job was running were filtered out above)
      written++;
      delFlag?.run(snap, e.addressId, chain);
      if (e.missingPriceKeys?.length) insFlag?.run(snap, e.addressId, chain, JSON.stringify(e.missingPriceKeys));
      delBal.run(snap, e.addressId, chain);
      delPv.run(snap, e.addressId, chain);
      delAave?.run(snap, e.addressId, ...chainMarkets);
      for (const b of e.balances) insBal.run(snap, e.addressId, chain, b.token, b.amountRaw, b.amount, b.usd, b.protocol, b.side);
      for (const p of e.positions) insPv.run(snap, e.addressId, chain, p.protocol, p.usd);
      for (const a of e.aave) insAave.run(snap, e.addressId, a.market, a.collateralUsd, a.debtUsd, a.healthFactor);
    }
  })();
  return written;
}

// ---------- rollup ----------

export function histSnapshotsBefore(db: Db, kind: SnapshotKind, beforeTs: number): { id: number; ts: number }[] {
  return db.prepare('SELECT id, ts FROM snapshots WHERE kind = ? AND ts < ? ORDER BY ts').all(kind, beforeTs) as { id: number; ts: number }[];
}

export function histSnapshotsBetween(db: Db, kind: SnapshotKind, fromTs: number, toTs: number): { id: number; ts: number }[] {
  return db.prepare('SELECT id, ts FROM snapshots WHERE kind = ? AND ts >= ? AND ts < ? ORDER BY ts').all(kind, fromTs, toTs) as {
    id: number;
    ts: number;
  }[];
}

export function histFindSnapshot(db: Db, kind: SnapshotKind, ts: number): number | undefined {
  const r = db.prepare('SELECT id FROM snapshots WHERE kind = ? AND ts = ? ORDER BY id LIMIT 1').get(kind, ts) as { id: number } | undefined;
  return r?.id;
}

/** (address_id, chain) pairs present in a snapshot (from position_values, falling back to balances). */
export function histSnapshotPairs(db: Db, snapshotId: number): { address_id: number; chain: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT address_id, chain FROM position_values WHERE snapshot_id = ?
       UNION SELECT DISTINCT address_id, chain FROM balances WHERE snapshot_id = ?`,
    )
    .all(snapshotId, snapshotId) as { address_id: number; chain: string }[];
}

/**
 * Copy one (address, chain) slice of a snapshot into another snapshot (no-op if the target already
 * has that slice). Aave accounts are copied per address for markets on that chain.
 */
export function histCopySlice(db: Db, fromId: number, toId: number, addressId: number, chain: string, chainMarkets: string[]): boolean {
  const exists = db
    .prepare('SELECT 1 FROM position_values WHERE snapshot_id = ? AND address_id = ? AND chain = ? UNION SELECT 1 FROM balances WHERE snapshot_id = ? AND address_id = ? AND chain = ?')
    .get(toId, addressId, chain, toId, addressId, chain);
  if (exists) return false;
  db.prepare(
    `INSERT INTO balances (snapshot_id, address_id, chain, token, amount_raw, amount, usd, protocol, side)
     SELECT ?, address_id, chain, token, amount_raw, amount, usd, protocol, side FROM balances WHERE snapshot_id = ? AND address_id = ? AND chain = ?`,
  ).run(toId, fromId, addressId, chain);
  db.prepare(
    `INSERT INTO position_values (snapshot_id, address_id, chain, protocol, usd)
     SELECT ?, address_id, chain, protocol, usd FROM position_values WHERE snapshot_id = ? AND address_id = ? AND chain = ?`,
  ).run(toId, fromId, addressId, chain);
  if (chainMarkets.length) {
    const ph = chainMarkets.map(() => '?').join(',');
    db.prepare(
      `INSERT INTO aave_accounts (snapshot_id, address_id, market, collateral_usd, debt_usd, health_factor)
       SELECT ?, address_id, market, collateral_usd, debt_usd, health_factor FROM aave_accounts
       WHERE snapshot_id = ? AND address_id = ? AND market IN (${ph})
         AND NOT EXISTS (SELECT 1 FROM aave_accounts x WHERE x.snapshot_id = ? AND x.address_id = ? AND x.market = aave_accounts.market)`,
    ).run(toId, fromId, addressId, ...chainMarkets, toId, addressId);
  }
  return true;
}

export function histDeleteSnapshots(db: Db, ids: number[]): void {
  if (!ids.length) return;
  const hasFlags = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_flags'").get();
  const hasReserveState = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aave_reserve_state'").get();
  db.transaction(() => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      db.prepare(`DELETE FROM balances WHERE snapshot_id IN (${ph})`).run(...chunk);
      db.prepare(`DELETE FROM position_values WHERE snapshot_id IN (${ph})`).run(...chunk);
      db.prepare(`DELETE FROM aave_accounts WHERE snapshot_id IN (${ph})`).run(...chunk);
      if (hasReserveState) db.prepare(`DELETE FROM aave_reserve_state WHERE snapshot_id IN (${ph})`).run(...chunk);
      if (hasFlags) db.prepare(`DELETE FROM daily_flags WHERE snapshot_id IN (${ph})`).run(...chunk);
      db.prepare(`DELETE FROM snapshots WHERE id IN (${ph})`).run(...chunk);
    }
  })();
}

export function histDeleteLivePricesBefore(db: Db, beforeTs: number): number {
  return db.prepare("DELETE FROM prices WHERE granularity = 'live' AND ts < ?").run(beforeTs).changes;
}
