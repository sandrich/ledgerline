// Write-side repository functions used by app/api route handlers (wallet / address management,
// job enqueueing). Uses the minimal QDb interface so it also runs against node:sqlite in tests.
// Job rows: type in JOB_TYPES, payload JSON, status 'pending' -> 'running' -> 'done' | 'failed',
// created_at / updated_at unix seconds. The worker polls for status = 'pending'.
import { get, nowSec, tx, type QDb } from '../queries/db';
import type { Chain } from '../queries/api-types';
import { WALLET_COLORS } from '../queries/meta';

export const JOB_TYPES = { discovery: 'discovery', backfill: 'backfill', live: 'snapshot', sync: 'sync' } as const;
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export interface JobPayload {
  addressIds?: number[];
  reason?: string;
}

/** Enqueue a job unless an identical (type + payload) job is already pending. Returns its id. */
export function enqueueJob(db: QDb, type: JobType, payload: JobPayload, now = nowSec()): number {
  const json = JSON.stringify(payload);
  const existing = get<{ id: number }>(db, "SELECT id FROM jobs WHERE type = ? AND payload = ? AND COALESCE(status, 'pending') = 'pending' ORDER BY id LIMIT 1", type, json);
  if (existing) return existing.id;
  const r = db
    .prepare("INSERT INTO jobs (type, payload, status, progress, total, error, created_at, updated_at) VALUES (?, ?, 'pending', 0, 0, NULL, ?, ?)")
    .run(type, json, now, now);
  return Number(r.lastInsertRowid);
}

// ---------- wallets ----------

export function createWallet(db: QDb, input: { name: string; color?: string | null }, now = nowSec()): number {
  return tx(db, () => {
    const next = get<{ s: number | null; n: number }>(db, 'SELECT MAX(sort) AS s, COUNT(*) AS n FROM wallets');
    const sort = (next?.s ?? -1) + 1;
    const color = input.color ?? WALLET_COLORS[(next?.n ?? 0) % WALLET_COLORS.length];
    const r = db.prepare('INSERT INTO wallets (name, color, sort, excluded, created_at) VALUES (?, ?, ?, 0, ?)').run(input.name, color, sort, now);
    return Number(r.lastInsertRowid);
  });
}

export function updateWallet(
  db: QDb,
  id: number,
  patch: { name?: string; color?: string | null; sort?: number; excluded?: boolean },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    vals.push(patch.color);
  }
  if (patch.sort !== undefined) {
    sets.push('sort = ?');
    vals.push(patch.sort);
  }
  if (patch.excluded !== undefined) {
    sets.push('excluded = ?');
    vals.push(patch.excluded ? 1 : 0);
  }
  if (!get(db, 'SELECT 1 AS x FROM wallets WHERE id = ?', id)) return false;
  if (sets.length) db.prepare(`UPDATE wallets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return true;
}

/** Delete an address and everything stored for it (used when it no longer belongs to any wallet). */
function purgeAddress(db: QDb, addressId: number): void {
  for (const t of ['balances', 'position_values', 'aave_accounts', 'curve_positions', 'address_tokens', 'discovery_state', 'daily_flags']) {
    if (!get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t)) continue;
    db.prepare(`DELETE FROM ${t} WHERE address_id = ?`).run(addressId);
  }
  // per-address worker markers (redo ranges, inactive re-check times)
  db.prepare("DELETE FROM meta WHERE key LIKE 'history:%:' || ? || ':%'").run(addressId);
  db.prepare('DELETE FROM wallet_addresses WHERE address_id = ?').run(addressId);
  db.prepare('DELETE FROM addresses WHERE id = ?').run(addressId);
}

function purgeIfOrphan(db: QDb, addressId: number): boolean {
  if (get(db, 'SELECT 1 AS x FROM wallet_addresses WHERE address_id = ? LIMIT 1', addressId)) return false;
  purgeAddress(db, addressId);
  return true;
}

/** Deletes the wallet; addresses left without any wallet are purged. Returns purged address ids. */
export function deleteWallet(db: QDb, id: number): number[] | null {
  if (!get(db, 'SELECT 1 AS x FROM wallets WHERE id = ?', id)) return null;
  return tx(db, () => {
    const ids = (db.prepare('SELECT address_id FROM wallet_addresses WHERE wallet_id = ?').all(id) as { address_id: number }[]).map((r) => r.address_id);
    db.prepare('DELETE FROM wallet_addresses WHERE wallet_id = ?').run(id);
    db.prepare('DELETE FROM wallets WHERE id = ?').run(id);
    return ids.filter((a) => purgeIfOrphan(db, a));
  });
}

// ---------- addresses ----------

export interface AddAddressResult {
  addressId: number;
  created: boolean;
  linked: boolean;
  jobIds: number[];
}

/**
 * Upsert an address (stored lowercase), link it to a wallet and enqueue discovery + live (discovery
 * enqueues the history backfill when its first run for each chain finishes).
 * An existing address keeps its data and chains; a non-empty label updates it. Returns null when the
 * wallet does not exist.
 */
export function addAddressToWallet(
  db: QDb,
  walletId: number,
  input: { address: string; label?: string | null; chains?: Chain[] },
  now = nowSec(),
): AddAddressResult | null {
  const address = input.address.toLowerCase();
  return tx(db, () => {
    if (!get(db, 'SELECT 1 AS x FROM wallets WHERE id = ?', walletId)) return null;
    let row = get<{ id: number }>(db, 'SELECT id FROM addresses WHERE lower(address) = ?', address);
    let created = false;
    if (!row) {
      const chains = JSON.stringify(input.chains?.length ? input.chains : ['ethereum', 'arbitrum']);
      const r = db
        .prepare('INSERT INTO addresses (address, label, chains, is_contract, excluded, created_at) VALUES (?, ?, ?, NULL, 0, ?)')
        .run(address, input.label ?? null, chains, now);
      row = { id: Number(r.lastInsertRowid) };
      created = true;
    } else if (input.label?.trim()) {
      // Linking an existing address to another wallet must not wipe its label or chain choice;
      // chains are only changed through PATCH /api/addresses/:id.
      db.prepare('UPDATE addresses SET label = ? WHERE id = ?').run(input.label.trim(), row.id);
    }
    let linked = false;
    if (!get(db, 'SELECT 1 AS x FROM wallet_addresses WHERE wallet_id = ? AND address_id = ?', walletId, row.id)) {
      db.prepare('INSERT INTO wallet_addresses (wallet_id, address_id) VALUES (?, ?)').run(walletId, row.id);
      linked = true;
    }
    const payload: JobPayload = { addressIds: [row.id], reason: 'address-added' };
    const jobIds =
      created || input.chains?.length
        ? // backfill is enqueued by discovery once its first run for (address, chain) has registered the
          // full token set (running both at once would plan the history without discovery's tokens)
          [enqueueJob(db, JOB_TYPES.discovery, payload, now), enqueueJob(db, JOB_TYPES.live, payload, now)]
        : [];
    return { addressId: row.id, created, linked, jobIds };
  });
}

/** Unlink; purges the address if no wallet references it any more. null when the link does not exist. */
export function removeAddressFromWallet(db: QDb, walletId: number, addressId: number): { purged: boolean } | null {
  return tx(db, () => {
    const r = db.prepare('DELETE FROM wallet_addresses WHERE wallet_id = ? AND address_id = ?').run(walletId, addressId);
    if (Number(r.changes) === 0) return null;
    return { purged: purgeIfOrphan(db, addressId) };
  });
}

export function updateAddress(
  db: QDb,
  id: number,
  patch: { label?: string | null; chains?: Chain[]; excluded?: boolean },
  now = nowSec(),
): { jobIds: number[] } | null {
  return tx(db, () => {
    const cur = get<{ chains: string | null }>(db, 'SELECT chains FROM addresses WHERE id = ?', id);
    if (!cur) return null;
    if (patch.label !== undefined) db.prepare('UPDATE addresses SET label = ? WHERE id = ?').run(patch.label, id);
    if (patch.excluded !== undefined) db.prepare('UPDATE addresses SET excluded = ? WHERE id = ?').run(patch.excluded ? 1 : 0, id);
    const jobIds: number[] = [];
    if (patch.chains?.length) {
      const next = JSON.stringify(patch.chains);
      db.prepare('UPDATE addresses SET chains = ? WHERE id = ?').run(next, id);
      if (next !== cur.chains) {
        const payload: JobPayload = { addressIds: [id], reason: 'chains-changed' };
        // discovery enqueues the backfill for chains it runs on for the first time
        jobIds.push(enqueueJob(db, JOB_TYPES.discovery, payload, now), enqueueJob(db, JOB_TYPES.live, payload, now));
      }
    }
    return { jobIds };
  });
}

/**
 * POST /api/sync: one 'sync' job = discovery for the given addresses (all when null), then a live
 * snapshot (the worker always snapshots all addresses so totals never show a partial drop).
 */
export function enqueueSync(db: QDb, addressIds: number[] | null, now = nowSec()): number[] {
  const payload: JobPayload = addressIds ? { addressIds, reason: 'manual-sync' } : { reason: 'manual-sync' };
  return [enqueueJob(db, JOB_TYPES.sync, payload, now)];
}
