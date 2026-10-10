// Smart wallet suggestions (table smart_wallet_suggestions, filled by lib/scan/smart-wallets.ts):
// Safes and DeFi Saver DSProxies owned by a tracked EOA. GET /api/suggestions lists the pending ones
// that are not tracked yet (on that chain); accepting adds the address to every wallet of its owner
// with the suggested chain(s), dismissing hides it for good (a later discovery run does not revive
// it: one row per (chain, address)).
import { addAddressToWallet, updateAddress } from '../db/repos-api';
import type { Chain, SuggestionActionResponse, SuggestionSource, WalletSuggestion } from './api-types';
import { all, get, nowSec, type QDb } from './db';

function tableExists(db: QDb): boolean {
  return !!get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'smart_wallet_suggestions'");
}

function parseChains(raw: string | null): Chain[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) {
      const c = v.filter((x): x is Chain => x === 'ethereum' || x === 'arbitrum');
      if (c.length) return c;
    }
  } catch {
    /* default */
  }
  return ['ethereum', 'arbitrum'];
}

/**
 * Insert a suggestion unless one exists for (chain, address) in any status (dedupe across owners and
 * runs; a dismissed suggestion stays dismissed). Returns true when a new row was written.
 */
export function upsertSuggestion(db: QDb, s: { chain: Chain; address: string; ownerAddressId: number; source: SuggestionSource }, now = nowSec()): boolean {
  const r = db
    .prepare(
      `INSERT INTO smart_wallet_suggestions (chain, address, owner_address_id, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(chain, address) DO NOTHING`,
    )
    .run(s.chain, s.address.toLowerCase(), s.ownerAddressId, s.source, now, now);
  return Number(r.changes) > 0;
}

interface Row {
  id: number;
  chain: Chain;
  address: string;
  source: SuggestionSource;
  status: string;
  owner_address_id: number;
  created_at: number | null;
  owner_address: string | null;
  owner_label: string | null;
  tracked_chains: string | null;
  tracked: number | null;
}

function rows(db: QDb, where: string, ...params: unknown[]): Row[] {
  return all<Row>(
    db,
    `SELECT s.id, s.chain, s.address, s.source, s.status, s.owner_address_id, s.created_at,
            o.address AS owner_address, o.label AS owner_label, a.chains AS tracked_chains, a.id AS tracked
     FROM smart_wallet_suggestions s
     LEFT JOIN addresses o ON o.id = s.owner_address_id
     LEFT JOIN addresses a ON lower(a.address) = s.address
     WHERE ${where} ORDER BY s.created_at, s.id`,
    ...params,
  );
}

function ownerWallets(db: QDb, addressId: number): { id: number; name: string }[] {
  return all<{ id: number; name: string }>(
    db,
    'SELECT w.id, w.name FROM wallet_addresses wa JOIN wallets w ON w.id = wa.wallet_id WHERE wa.address_id = ? ORDER BY w.sort, w.id',
    addressId,
  );
}

/** Already tracked on the suggested chain. */
const isTracked = (r: Row): boolean => r.tracked != null && parseChains(r.tracked_chains).includes(r.chain);

/** Pending suggestions whose owner is still tracked and whose address is not tracked on that chain. */
export function getSuggestions(db: QDb): WalletSuggestion[] {
  if (!tableExists(db)) return [];
  return rows(db, "s.status = 'pending' AND o.id IS NOT NULL")
    .filter((r) => !isTracked(r))
    .map((r) => ({
      id: r.id,
      address: r.address,
      chain: r.chain,
      source: r.source,
      owner: { addressId: r.owner_address_id, address: r.owner_address!, label: r.owner_label },
      wallets: ownerWallets(db, r.owner_address_id),
      createdAt: r.created_at,
    }));
}

/**
 * Accept or dismiss a suggestion. Accepting also accepts the other pending suggestions for the same
 * address (a Safe found on both chains is added once with both chains). null when the id is unknown.
 */
export function actOnSuggestion(db: QDb, id: number, action: 'accept' | 'dismiss', opts: { label?: string | null } = {}, now = nowSec()): SuggestionActionResponse | null {
  if (!tableExists(db)) return null;
  const [s] = rows(db, 's.id = ?', id);
  if (!s) return null;
  const setStatus = db.prepare('UPDATE smart_wallet_suggestions SET status = ?, updated_at = ? WHERE id = ?');
  if (action === 'dismiss') {
    setStatus.run('dismissed', now, id);
    return { id, status: 'dismissed', addressId: null, jobIds: [] };
  }
  const group = rows(db, "s.address = ? AND (s.id = ? OR s.status = 'pending')", s.address, id);
  const chains = [...new Set(group.map((g) => g.chain))];
  const wallets = ownerWallets(db, s.owner_address_id);
  if (!wallets.length) throw new Error('the owner of this suggestion is not in any wallet any more');
  const jobIds: number[] = [];
  let addressId: number | null = null;
  for (const w of wallets) {
    const existing = get<{ id: number; chains: string | null }>(db, 'SELECT id, chains FROM addresses WHERE lower(address) = ?', s.address);
    if (existing) {
      const cur = parseChains(existing.chains);
      const next = [...new Set([...cur, ...chains])];
      if (next.length !== cur.length) jobIds.push(...(updateAddress(db, existing.id, { chains: next }, now)?.jobIds ?? []));
    }
    const r = addAddressToWallet(db, w.id, { address: s.address, label: opts.label ?? undefined, chains: existing ? undefined : chains }, now);
    if (r) {
      addressId = r.addressId;
      jobIds.push(...r.jobIds);
    }
  }
  for (const g of group) setStatus.run('accepted', now, g.id);
  return { id, status: 'accepted', addressId, jobIds: [...new Set(jobIds)] };
}
