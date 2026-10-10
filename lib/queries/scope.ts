// Address / wallet rows and scope resolution.
// Inclusion rules:
// - scope all: addresses with excluded = 0 that belong to at least one wallet with excluded = 0.
//   An address in both an excluded and a non excluded wallet counts (once). Orphans never count.
// - scope wallet:<id>: the wallet's addresses with excluded = 0 (the wallet's own excluded flag only
//   affects the overall totals, not its own view).
// - scope address:<addr>: that address, regardless of exclusion.
import type { Chain, Scope } from './api-types';
import { all, get, type QDb } from './db';
import { isChain } from './meta';

export interface AddressRow {
  id: number;
  address: string;
  label: string | null;
  chains: Chain[];
  isContract: Partial<Record<Chain, boolean>>;
  excluded: boolean;
  createdAt: number | null;
}

export interface WalletRow {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  excluded: boolean;
  createdAt: number | null;
}

interface RawAddress {
  id: number;
  address: string;
  label: string | null;
  chains: string | null;
  is_contract: string | null;
  excluded: number | null;
  created_at: number | null;
}

export function parseChains(raw: string | null): Chain[] {
  const allChains: Chain[] = ['ethereum', 'arbitrum'];
  if (!raw) return allChains;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) {
      const f = v.filter(isChain);
      return f.length ? f : allChains;
    }
  } catch {
    /* fall through */
  }
  return allChains;
}

function parseIsContract(raw: string | null): Partial<Record<Chain, boolean>> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Partial<Record<Chain, boolean>> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (isChain(k)) out[k] = !!val;
      return out;
    }
    if (typeof v === 'boolean') return { ethereum: v, arbitrum: v };
  } catch {
    /* ignore */
  }
  return {};
}

function mapAddress(r: RawAddress): AddressRow {
  return {
    id: r.id,
    address: r.address.toLowerCase(),
    label: r.label ?? null,
    chains: parseChains(r.chains),
    isContract: parseIsContract(r.is_contract),
    excluded: !!r.excluded,
    createdAt: r.created_at ?? null,
  };
}

const ADDRESS_COLS = 'a.id, a.address, a.label, a.chains, a.is_contract, a.excluded, a.created_at';

export function listAddresses(db: QDb): AddressRow[] {
  return all<RawAddress>(db, `SELECT ${ADDRESS_COLS} FROM addresses a ORDER BY a.id`).map(mapAddress);
}

export function getAddressById(db: QDb, id: number): AddressRow | undefined {
  const r = get<RawAddress>(db, `SELECT ${ADDRESS_COLS} FROM addresses a WHERE a.id = ?`, id);
  return r ? mapAddress(r) : undefined;
}

export function getAddressByHex(db: QDb, address: string): AddressRow | undefined {
  const r = get<RawAddress>(db, `SELECT ${ADDRESS_COLS} FROM addresses a WHERE lower(a.address) = ?`, address.toLowerCase());
  return r ? mapAddress(r) : undefined;
}

export function listWalletAddresses(db: QDb, walletId: number): AddressRow[] {
  return all<RawAddress>(
    db,
    `SELECT ${ADDRESS_COLS} FROM addresses a JOIN wallet_addresses wa ON wa.address_id = a.id WHERE wa.wallet_id = ? ORDER BY a.id`,
    walletId,
  ).map(mapAddress);
}

interface RawWallet {
  id: number;
  name: string;
  color: string | null;
  sort: number | null;
  excluded: number | null;
  created_at: number | null;
}

function mapWallet(r: RawWallet): WalletRow {
  return { id: r.id, name: r.name, color: r.color ?? null, sort: r.sort ?? 0, excluded: !!r.excluded, createdAt: r.created_at ?? null };
}

export function listWallets(db: QDb): WalletRow[] {
  return all<RawWallet>(db, 'SELECT id, name, color, sort, excluded, created_at FROM wallets ORDER BY sort, id').map(mapWallet);
}

export function getWallet(db: QDb, id: number): WalletRow | undefined {
  const r = get<RawWallet>(db, 'SELECT id, name, color, sort, excluded, created_at FROM wallets WHERE id = ?', id);
  return r ? mapWallet(r) : undefined;
}

/** wallet_id -> address ids, and address_id -> wallets (ordered by wallet sort, id). */
export function walletLinks(db: QDb): { byWallet: Map<number, number[]>; byAddress: Map<number, WalletRow[]> } {
  const wallets = new Map(listWallets(db).map((w) => [w.id, w]));
  const links = all<{ wallet_id: number; address_id: number }>(db, 'SELECT wallet_id, address_id FROM wallet_addresses');
  const byWallet = new Map<number, number[]>();
  const byAddress = new Map<number, WalletRow[]>();
  for (const l of links) {
    const w = wallets.get(l.wallet_id);
    if (!w) continue;
    if (!byWallet.has(l.wallet_id)) byWallet.set(l.wallet_id, []);
    byWallet.get(l.wallet_id)!.push(l.address_id);
    if (!byAddress.has(l.address_id)) byAddress.set(l.address_id, []);
    byAddress.get(l.address_id)!.push(w);
  }
  for (const list of byAddress.values()) list.sort((a, b) => a.sort - b.sort || a.id - b.id);
  return { byWallet, byAddress };
}

/** Distinct address ids counted in the overall totals. */
export function overallAddressIds(db: QDb): number[] {
  return all<{ id: number }>(
    db,
    `SELECT DISTINCT a.id FROM addresses a
     JOIN wallet_addresses wa ON wa.address_id = a.id
     JOIN wallets w ON w.id = wa.wallet_id
     WHERE COALESCE(a.excluded, 0) = 0 AND COALESCE(w.excluded, 0) = 0
     ORDER BY a.id`,
  ).map((r) => r.id);
}

/** Distinct, non excluded address ids of a wallet. */
export function walletAddressIds(db: QDb, walletId: number): number[] {
  return all<{ id: number }>(
    db,
    `SELECT DISTINCT a.id FROM addresses a JOIN wallet_addresses wa ON wa.address_id = a.id
     WHERE wa.wallet_id = ? AND COALESCE(a.excluded, 0) = 0 ORDER BY a.id`,
    walletId,
  ).map((r) => r.id);
}

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseScope(raw: string | null | undefined): Scope | null {
  const s = (raw ?? 'all').trim();
  if (s === '' || s === 'all') return { kind: 'all' };
  const m = /^(wallet|address):(.+)$/.exec(s);
  if (!m) return null;
  if (m[1] === 'wallet') {
    const id = Number(m[2]);
    return Number.isInteger(id) && id > 0 ? { kind: 'wallet', walletId: id } : null;
  }
  return ADDRESS_RE.test(m[2]) ? { kind: 'address', address: m[2].toLowerCase() } : null;
}

export function scopeToString(s: Scope): string {
  return s.kind === 'all' ? 'all' : s.kind === 'wallet' ? `wallet:${s.walletId}` : `address:${s.address}`;
}

/** Address ids for a scope; null when the wallet / address does not exist. */
export function resolveScope(db: QDb, s: Scope): number[] | null {
  if (s.kind === 'all') return overallAddressIds(db);
  if (s.kind === 'wallet') return getWallet(db, s.walletId) ? walletAddressIds(db, s.walletId) : null;
  const a = getAddressByHex(db, s.address);
  return a ? [a.id] : null;
}
