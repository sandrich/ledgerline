// Repository functions for lib/scan (discovery, live snapshot) and the worker job queue.
// Written against the lib/db/schema.sql column names and the conventions of lib/db/repos-history.ts:
// unix SECONDS, lowercase addresses, native coin = zero address, balances.usd negative for borrows,
// position_values.protocol 'wallet' | 'aave-v3' with a 'wallet' row always written per slice.
// Inserts use WHERE NOT EXISTS so they do not depend on particular UNIQUE constraints.
import type { Db, HistoryChain } from '../history/types';

export type ScanChain = HistoryChain;
export const SCAN_CHAINS: ScanChain[] = ['ethereum', 'arbitrum'];
export const NATIVE = '0x0000000000000000000000000000000000000000';

const now = () => Math.floor(Date.now() / 1000);

// ---------- addresses ----------

export interface ScanAddress {
  id: number;
  address: string;
  label: string | null;
  chains: ScanChain[];
  isContract: Partial<Record<ScanChain, boolean>>;
  excluded: boolean;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseChains(raw: unknown): ScanChain[] {
  const v = parseJson<unknown>(raw, null);
  if (Array.isArray(v)) {
    const f = v.filter((c): c is ScanChain => c === 'ethereum' || c === 'arbitrum');
    if (f.length) return f;
  }
  return [...SCAN_CHAINS];
}

function parseIsContract(raw: unknown): Partial<Record<ScanChain, boolean>> {
  const v = parseJson<unknown>(raw, null);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const out: Partial<Record<ScanChain, boolean>> = {};
    for (const c of SCAN_CHAINS) if (typeof o[c] === 'boolean') out[c] = o[c] as boolean;
    return out;
  }
  return {};
}

type AddressRow = { id: number; address: string; label: string | null; chains: string | null; is_contract: string | null; excluded: number | null };

function mapAddress(r: AddressRow): ScanAddress {
  return {
    id: r.id,
    address: r.address.toLowerCase(),
    label: r.label,
    chains: parseChains(r.chains),
    isContract: parseIsContract(r.is_contract),
    excluded: !!r.excluded,
  };
}

/** All tracked addresses (excluded ones are still scanned: exclusion only affects totals). */
export function scanListAddresses(db: Db, ids?: number[]): ScanAddress[] {
  const rows = db.prepare('SELECT id, address, label, chains, is_contract, excluded FROM addresses ORDER BY id').all() as AddressRow[];
  const set = ids ? new Set(ids) : null;
  return rows.filter((r) => !set || set.has(r.id)).map(mapAddress);
}

export function scanFindAddressId(db: Db, address: string): number | undefined {
  const r = db.prepare('SELECT id FROM addresses WHERE lower(address) = ?').get(address.toLowerCase()) as { id: number } | undefined;
  return r?.id;
}

export function scanWalletAddressIds(db: Db, walletId: number): number[] {
  return (db.prepare('SELECT address_id FROM wallet_addresses WHERE wallet_id = ?').all(walletId) as { address_id: number }[]).map((r) => r.address_id);
}

export function scanSetIsContract(db: Db, addressId: number, chain: ScanChain, isContract: boolean): void {
  const r = db.prepare('SELECT is_contract FROM addresses WHERE id = ?').get(addressId) as { is_contract: string | null } | undefined;
  if (!r) return;
  const cur = parseIsContract(r.is_contract);
  if (cur[chain] === isContract) return;
  cur[chain] = isContract;
  db.prepare('UPDATE addresses SET is_contract = ? WHERE id = ?').run(JSON.stringify(cur), addressId);
}

// ---------- wallets (seed) ----------

export function scanEnsureWallet(db: Db, name: string, color: string): number {
  const r = db.prepare('SELECT id FROM wallets WHERE name = ? ORDER BY id LIMIT 1').get(name) as { id: number } | undefined;
  if (r) return r.id;
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM wallets').get() as { s: number }).s;
  return Number(db.prepare('INSERT INTO wallets (name, color, sort, excluded, created_at) VALUES (?, ?, ?, 0, ?)').run(name, color, sort, now()).lastInsertRowid);
}

export function scanEnsureAddress(db: Db, address: string, label: string | null, chains: ScanChain[]): { id: number; created: boolean } {
  const a = address.toLowerCase();
  const id = scanFindAddressId(db, a);
  if (id != null) return { id, created: false };
  const newId = Number(
    db
      .prepare('INSERT INTO addresses (address, label, chains, is_contract, excluded, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(a, label, JSON.stringify(chains), JSON.stringify({}), now()).lastInsertRowid,
  );
  return { id: newId, created: true };
}

export function scanLinkWalletAddress(db: Db, walletId: number, addressId: number): void {
  db.prepare(
    'INSERT INTO wallet_addresses (wallet_id, address_id) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM wallet_addresses WHERE wallet_id = ? AND address_id = ?)',
  ).run(walletId, addressId, walletId, addressId);
}

// ---------- discovery_state (shared with lib/history: only last_block is ours) ----------

export function scanGetLastBlock(db: Db, addressId: number, chain: ScanChain): number | null {
  const r = db.prepare('SELECT last_block FROM discovery_state WHERE address_id = ? AND chain = ?').get(addressId, chain) as
    | { last_block: number | null }
    | undefined;
  return r?.last_block ?? null;
}

/** False once the address was purged (a worker job may still be running for it). */
export function scanAddressExists(db: Db, addressId: number): boolean {
  return !!db.prepare('SELECT 1 FROM addresses WHERE id = ?').get(addressId);
}

export function scanSetLastBlock(db: Db, addressId: number, chain: ScanChain, block: number): void {
  if (!scanAddressExists(db, addressId)) return;
  db.prepare(
    `INSERT INTO discovery_state (address_id, chain, backfill_done_days, backfill_total_days)
     SELECT ?, ?, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM discovery_state WHERE address_id = ? AND chain = ?)`,
  ).run(addressId, chain, addressId, chain);
  db.prepare('UPDATE discovery_state SET last_block = ? WHERE address_id = ? AND chain = ?').run(block, addressId, chain);
}

// ---------- tokens ----------

export type TokenKind = 'native' | 'erc20' | 'atoken' | 'vdebt' | 'sdebt';

export interface ScanToken {
  chain: ScanChain;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  kind: TokenKind | null;
  underlying: string | null;
  market: string | null;
  price_key: string | null;
  logo: string | null;
  spam: number;
}

export function scanGetTokens(db: Db, chain: ScanChain, addresses: string[]): Map<string, ScanToken> {
  const out = new Map<string, ScanToken>();
  if (!addresses.length) return out;
  const stmt = db.prepare(
    'SELECT chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam FROM tokens WHERE chain = ? AND lower(address) = ?',
  );
  for (const a of new Set(addresses.map((x) => x.toLowerCase()))) {
    const r = stmt.get(chain, a) as ScanToken | undefined;
    if (r) out.set(a, { ...r, address: a, spam: r.spam ? 1 : 0 });
  }
  return out;
}

export function scanInsertToken(db: Db, t: ScanToken): void {
  const a = t.address.toLowerCase();
  db.prepare(
    `INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE chain = ? AND lower(address) = ?)`,
  ).run(t.chain, a, t.symbol, t.name, t.decimals, t.kind, t.underlying, t.market, t.price_key, t.logo, t.spam, t.chain, a);
}

export function scanSetTokenSpam(db: Db, chain: ScanChain, address: string, spam: boolean): void {
  db.prepare('UPDATE tokens SET spam = ? WHERE chain = ? AND lower(address) = ?').run(spam ? 1 : 0, chain, address.toLowerCase());
}

export function scanSetTokenLogo(db: Db, chain: ScanChain, address: string, logo: string): void {
  db.prepare('UPDATE tokens SET logo = ? WHERE chain = ? AND lower(address) = ? AND (logo IS NULL OR logo = \'\')').run(logo, chain, address.toLowerCase());
}

export function scanEnsureNativeToken(db: Db, chain: ScanChain): void {
  scanInsertToken(db, {
    chain,
    address: NATIVE,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    kind: 'native',
    underlying: null,
    market: null,
    price_key: 'coingecko:ethereum',
    logo: null,
    spam: 0,
  });
}

// ---------- address_tokens ----------

export interface ScanAddressToken extends ScanToken {
  first_block: number | null;
}

export function scanListAddressTokens(db: Db, addressId: number, chain: ScanChain): ScanAddressToken[] {
  return (
    db
      .prepare(
        `SELECT lower(at.token) AS address, at.first_block, t.symbol, t.name, t.decimals, t.kind, t.underlying, t.market, t.price_key, t.logo,
                COALESCE(t.spam, 0) AS spam
         FROM address_tokens at LEFT JOIN tokens t ON t.chain = at.chain AND lower(t.address) = lower(at.token)
         WHERE at.address_id = ? AND at.chain = ?`,
      )
      .all(addressId, chain) as Omit<ScanAddressToken, 'chain'>[]
  ).map((r) => ({ ...r, chain }));
}

export function scanKnownAddressTokens(db: Db, addressId: number, chain: ScanChain): Set<string> {
  return new Set(
    (db.prepare('SELECT lower(token) AS t FROM address_tokens WHERE address_id = ? AND chain = ?').all(addressId, chain) as { t: string }[]).map((r) => r.t),
  );
}

/** Insert if missing; lower an existing first_block when we learned of an earlier transfer. */
export function scanAddAddressToken(db: Db, addressId: number, chain: ScanChain, token: string, firstBlock: number | null): boolean {
  if (!scanAddressExists(db, addressId)) return false;
  const t = token.toLowerCase();
  const ins = db
    .prepare(
      `INSERT INTO address_tokens (address_id, chain, token, first_block)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM address_tokens WHERE address_id = ? AND chain = ? AND lower(token) = ?)`,
    )
    .run(addressId, chain, t, firstBlock, addressId, chain, t);
  if (ins.changes) return true;
  if (firstBlock != null) {
    db.prepare(
      'UPDATE address_tokens SET first_block = ? WHERE address_id = ? AND chain = ? AND lower(token) = ? AND first_block IS NOT NULL AND first_block > ?',
    ).run(firstBlock, addressId, chain, t, firstBlock);
  }
  return false;
}

// ---------- snapshots (live) ----------

export interface ScanBalanceRow {
  token: string;
  amountRaw: string;
  amount: number;
  usd: number;
  protocol: 'wallet' | 'aave-v3';
  side: 'wallet' | 'supply' | 'borrow';
}

export interface ScanAaveAccountRow {
  market: string;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number | null;
  /** risk extras (migration 3); null / undefined when the Pool reads failed */
  emode?: number | null;
  emodeLtvBps?: number | null;
  emodeLtBps?: number | null;
  emodeBitmap?: string | null;
  userConfig?: string | null;
  ltvBps?: number | null;
  ltBps?: number | null;
}

export interface ScanReserveState {
  market: string;
  asset: string;
  reserveId: number;
  supplyApy: number;
  borrowApy: number;
  ltvBps: number;
  ltBps: number;
  emodeCategory: number;
}

const AAVE_ACCOUNT_COLS = 'collateral_usd, debt_usd, health_factor, emode, emode_ltv_bps, emode_lt_bps, emode_bitmap, user_config, ltv_bps, lt_bps';

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function hasRiskColumns(db: Db): boolean {
  return (db.prepare('PRAGMA table_info(aave_accounts)').all() as { name: string }[]).some((c) => c.name === 'user_config');
}

/** Replace the reserve rates / risk parameters of `chain` stored with a live snapshot. */
export function scanWriteReserveStates(db: Db, snapshotId: number, chain: ScanChain, rows: ScanReserveState[]): void {
  if (!rows.length || !hasTable(db, 'aave_reserve_state')) return;
  const ins = db.prepare(
    `INSERT OR REPLACE INTO aave_reserve_state (snapshot_id, chain, market, asset, reserve_id, supply_apy, borrow_apy, ltv_bps, lt_bps, emode_category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM aave_reserve_state WHERE snapshot_id = ? AND chain = ?').run(snapshotId, chain);
    for (const r of rows) ins.run(snapshotId, chain, r.market, r.asset.toLowerCase(), r.reserveId, r.supplyApy, r.borrowApy, r.ltvBps, r.ltBps, r.emodeCategory);
  })();
}

export interface ScanSlice {
  addressId: number;
  chain: ScanChain;
  balances: ScanBalanceRow[];
  positions: { protocol: string; usd: number }[];
  aave: ScanAaveAccountRow[];
}

export function scanGetOrCreateSnapshot(db: Db, kind: 'live' | 'hourly' | 'daily', ts: number): number {
  const r = db.prepare('SELECT id FROM snapshots WHERE kind = ? AND ts = ? ORDER BY id LIMIT 1').get(kind, ts) as { id: number } | undefined;
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO snapshots (ts, kind) VALUES (?, ?)').run(ts, kind).lastInsertRowid);
}

/**
 * Write (address, chain) slices into the live snapshot at `ts` (minute-rounded), replacing rows
 * previously written for the same slice (a re-run within the same minute is idempotent).
 */
export function scanWriteLiveSlices(db: Db, ts: number, slices: ScanSlice[], marketsByChain: Record<ScanChain, string[]>): number {
  let snapId = 0;
  db.transaction(() => {
    snapId = scanGetOrCreateSnapshot(db, 'live', ts);
    const delBal = db.prepare('DELETE FROM balances WHERE snapshot_id = ? AND address_id = ? AND chain = ?');
    const delPv = db.prepare('DELETE FROM position_values WHERE snapshot_id = ? AND address_id = ? AND chain = ?');
    const insBal = db.prepare(
      'INSERT INTO balances (snapshot_id, address_id, chain, token, amount_raw, amount, usd, protocol, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insPv = db.prepare('INSERT INTO position_values (snapshot_id, address_id, chain, protocol, usd) VALUES (?, ?, ?, ?, ?)');
    const risk = hasRiskColumns(db);
    const insAave = risk
      ? db.prepare(`INSERT INTO aave_accounts (snapshot_id, address_id, market, ${AAVE_ACCOUNT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      : db.prepare('INSERT INTO aave_accounts (snapshot_id, address_id, market, collateral_usd, debt_usd, health_factor) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of slices) {
      if (!scanAddressExists(db, s.addressId)) continue; // purged while the snapshot was being read
      delBal.run(snapId, s.addressId, s.chain);
      delPv.run(snapId, s.addressId, s.chain);
      const markets = marketsByChain[s.chain] ?? [];
      if (markets.length) {
        db.prepare(`DELETE FROM aave_accounts WHERE snapshot_id = ? AND address_id = ? AND market IN (${markets.map(() => '?').join(',')})`).run(
          snapId,
          s.addressId,
          ...markets,
        );
      }
      for (const b of s.balances) insBal.run(snapId, s.addressId, s.chain, b.token.toLowerCase(), b.amountRaw, b.amount, b.usd, b.protocol, b.side);
      for (const p of s.positions) insPv.run(snapId, s.addressId, s.chain, p.protocol, p.usd);
      for (const a of s.aave) {
        if (risk) {
          insAave.run(
            snapId,
            s.addressId,
            a.market,
            a.collateralUsd,
            a.debtUsd,
            a.healthFactor,
            a.emode ?? null,
            a.emodeLtvBps ?? null,
            a.emodeLtBps ?? null,
            a.emodeBitmap ?? null,
            a.userConfig ?? null,
            a.ltvBps ?? null,
            a.ltBps ?? null,
          );
        } else insAave.run(snapId, s.addressId, a.market, a.collateralUsd, a.debtUsd, a.healthFactor);
      }
    }
  })();
  return snapId;
}

/**
 * Copy (address, chain) slices from the most recent earlier live snapshot that has them into
 * `snapshotId`. Used when a chain could not be read this round. Returns slices copied.
 */
export function scanCarryForward(db: Db, snapshotId: number, ts: number, chain: ScanChain, addressIds: number[], markets: string[]): number {
  let n = 0;
  const prevStmt = db.prepare(
    `SELECT s.id FROM snapshots s JOIN position_values pv ON pv.snapshot_id = s.id
     WHERE s.kind = 'live' AND s.ts < ? AND pv.address_id = ? AND pv.chain = ? ORDER BY s.ts DESC LIMIT 1`,
  );
  const has = db.prepare('SELECT 1 FROM position_values WHERE snapshot_id = ? AND address_id = ? AND chain = ? LIMIT 1');
  const cols = hasRiskColumns(db) ? AAVE_ACCOUNT_COLS : 'collateral_usd, debt_usd, health_factor';
  const reserves = hasTable(db, 'aave_reserve_state');
  db.transaction(() => {
    for (const id of addressIds) {
      if (!scanAddressExists(db, id)) continue;
      if (has.get(snapshotId, id, chain)) continue;
      const prev = prevStmt.get(ts, id, chain) as { id: number } | undefined;
      if (!prev) continue;
      db.prepare(
        `INSERT INTO balances (snapshot_id, address_id, chain, token, amount_raw, amount, usd, protocol, side)
         SELECT ?, address_id, chain, token, amount_raw, amount, usd, protocol, side FROM balances WHERE snapshot_id = ? AND address_id = ? AND chain = ?`,
      ).run(snapshotId, prev.id, id, chain);
      db.prepare(
        `INSERT INTO position_values (snapshot_id, address_id, chain, protocol, usd)
         SELECT ?, address_id, chain, protocol, usd FROM position_values WHERE snapshot_id = ? AND address_id = ? AND chain = ?`,
      ).run(snapshotId, prev.id, id, chain);
      if (markets.length) {
        db.prepare(
          `INSERT INTO aave_accounts (snapshot_id, address_id, market, ${cols})
           SELECT ?, address_id, market, ${cols} FROM aave_accounts
           WHERE snapshot_id = ? AND address_id = ? AND market IN (${markets.map(() => '?').join(',')})`,
        ).run(snapshotId, prev.id, id, ...markets);
        // the chain could not be read: keep the previous snapshot's rates for it
        if (reserves) {
          db.prepare(
            `INSERT OR IGNORE INTO aave_reserve_state (snapshot_id, chain, market, asset, reserve_id, supply_apy, borrow_apy, ltv_bps, lt_bps, emode_category)
             SELECT ?, chain, market, asset, reserve_id, supply_apy, borrow_apy, ltv_bps, lt_bps, emode_category FROM aave_reserve_state
             WHERE snapshot_id = ? AND chain = ?`,
          ).run(snapshotId, prev.id, chain);
        }
      }
      n++;
    }
  })();
  return n;
}

/** Store current prices at live granularity (replaces the same (key, ts) if re-run). */
export function scanInsertLivePrices(db: Db, ts: number, prices: { key: string; usd: number }[]): void {
  const del = db.prepare("DELETE FROM prices WHERE price_key = ? AND ts = ? AND granularity = 'live'");
  const ins = db.prepare("INSERT INTO prices (price_key, ts, usd, granularity) VALUES (?, ?, ?, 'live')");
  db.transaction(() => {
    for (const p of prices) {
      del.run(p.key, ts);
      ins.run(p.key, ts, p.usd);
    }
  })();
}

// ---------- meta ----------

export function scanGetMeta(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function scanSetMeta(db: Db, key: string, value: string): void {
  const u = db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
  if (!u.changes) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// ---------- jobs ----------

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: number;
  type: string;
  payload: unknown;
  status: JobStatus;
  progress: number | null;
  total: number | null;
  error: string | null;
  created_at: number | null;
  updated_at: number | null;
}

function mapJob(r: Omit<JobRow, 'payload'> & { payload: string | null }): JobRow {
  return { ...r, payload: parseJson<unknown>(r.payload, null) };
}

function canonicalPayload(payload: unknown): string {
  if (payload == null) return '{}';
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(payload));
}

/**
 * Enqueue a job. With coalesce (default) an identical pending job (same type + payload) is reused,
 * so periodic schedulers and repeated "Sync now" clicks do not pile up.
 */
export function scanEnqueueJob(db: Db, type: string, payload: unknown = {}, opts: { coalesce?: boolean } = {}): number {
  const p = canonicalPayload(payload);
  if (opts.coalesce !== false) {
    const existing = db
      .prepare("SELECT id, payload FROM jobs WHERE type = ? AND status = 'pending' ORDER BY id")
      .all(type) as { id: number; payload: string | null }[];
    const hit = existing.find((e) => canonicalPayload(parseJson<unknown>(e.payload, null)) === p);
    if (hit) return hit.id;
  }
  const t = now();
  return Number(
    db.prepare("INSERT INTO jobs (type, payload, status, progress, total, error, created_at, updated_at) VALUES (?, ?, 'pending', 0, NULL, NULL, ?, ?)").run(
      type,
      p,
      t,
      t,
    ).lastInsertRowid,
  );
}

/**
 * Atomically claim the oldest pending job whose type is in `types`. Hourly backfills (short, they
 * fill the 24h / 7d charts) go before everything else pending on their lane, e.g. a daily backfill.
 */
export function scanClaimJob(db: Db, types: string[]): JobRow | null {
  if (!types.length) return null;
  const ph = types.map(() => '?').join(',');
  for (let i = 0; i < 5; i++) {
    const r = db
      .prepare(`SELECT id FROM jobs WHERE status = 'pending' AND type IN (${ph}) ORDER BY (type IN ('hourly-backfill', 'hourly_backfill')) DESC, id LIMIT 1`)
      .get(...types) as { id: number } | undefined;
    if (!r) return null;
    const u = db.prepare("UPDATE jobs SET status = 'running', updated_at = ?, error = NULL WHERE id = ? AND status = 'pending'").run(now(), r.id);
    if (u.changes === 1) {
      const row = db.prepare('SELECT id, type, payload, status, progress, total, error, created_at, updated_at FROM jobs WHERE id = ?').get(r.id) as
        | (Omit<JobRow, 'payload'> & { payload: string | null })
        | undefined;
      return row ? mapJob(row) : null;
    }
  }
  return null;
}

export function scanJobProgress(db: Db, id: number, progress: number, total: number | null): void {
  db.prepare('UPDATE jobs SET progress = ?, total = ?, updated_at = ? WHERE id = ?').run(progress, total, now(), id);
}

export function scanFinishJob(db: Db, id: number, status: 'done' | 'failed' | 'pending', error?: string | null): void {
  db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error ?? null, now(), id);
}

/** Jobs left 'running' by a crashed / killed worker go back to 'pending'. */
export function scanRequeueRunning(db: Db): number {
  return db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(now()).changes;
}

/** Keep the jobs table small: drop finished jobs older than `days`. */
export function scanPruneJobs(db: Db, days = 7): number {
  return db.prepare("DELETE FROM jobs WHERE status IN ('done', 'failed') AND COALESCE(updated_at, created_at, 0) < ?").run(now() - days * 86_400).changes;
}
