// Point-in-time state of a set of addresses.
// Snapshots are shared rows written per (address, chain) "slice". The state of an address at time T
// is, for every chain, the most recent slice at or before T:
//   - live / hourly snapshots are effective at their ts
//   - a daily snapshot (ts = UTC day start) holds the end-of-day state, so it is effective at ts + 1 day
// For the current state this means: latest live snapshot, falling back to the latest completed daily.
// Ties prefer live over hourly over daily.
import type { Change, ChangeWindow, Changes, Chain } from './api-types';
import { all, jsonIds, type QDb } from './db';
import { CHANGE_WINDOWS, DAY, ETH_KEY, NATIVE_TOKEN, isChain } from './meta';

export type SnapshotKind = 'live' | 'hourly' | 'daily';

/**
 * SQL condition (addresses aliased `ad`, position_values `pv`): the row's chain is one of the
 * address's current chains. A chain removed from an address stops counting everywhere; its rows are
 * kept so re-adding the chain restores the history. NULL / invalid / empty chains mean "all chains".
 */
export const CHAIN_ENABLED_SQL = `(ad.chains IS NULL OR NOT json_valid(ad.chains) OR json_array_length(ad.chains) = 0
  OR pv.chain IN (SELECT value FROM json_each(ad.chains)))`;

export interface SliceRef {
  addressId: number;
  chain: Chain;
  snapshotId: number;
  ts: number;
  kind: SnapshotKind;
}

export const KIND_RANK: Record<SnapshotKind, number> = { live: 3, hourly: 2, daily: 1 };

export function sliceKey(addressId: number, chain: string): string {
  return `${addressId}|${chain}`;
}

/**
 * Latest slice per (address, chain) at or before `at`.
 * mode 'effective' (default): daily snapshots count from ts + 1 day (end-of-day state).
 * mode 'display': daily snapshots count from their ts (how the history chart plots them).
 */
export function slicesAt(db: QDb, addressIds: number[], at: number, mode: 'effective' | 'display' = 'effective'): SliceRef[] {
  if (!addressIds.length) return [];
  const shift = mode === 'effective' ? DAY : 0;
  const rows = all<{ a: number; c: string; id: number; ts: number; kind: SnapshotKind; score: number }>(
    db,
    `SELECT pv.address_id AS a, pv.chain AS c, s.id AS id, s.ts AS ts, s.kind AS kind,
            MAX((CASE WHEN s.kind = 'daily' THEN s.ts + ${shift} ELSE s.ts END) * 4
                + (CASE s.kind WHEN 'live' THEN 3 WHEN 'hourly' THEN 2 ELSE 1 END)) AS score
     FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id JOIN addresses ad ON ad.id = pv.address_id
     WHERE pv.address_id IN (SELECT value FROM json_each(?))
       AND ${CHAIN_ENABLED_SQL}
       AND ((s.kind = 'daily' AND s.ts + ${shift} <= ?) OR (s.kind <> 'daily' AND s.ts <= ?))
     GROUP BY pv.address_id, pv.chain`,
    jsonIds(addressIds),
    at,
    at,
  );
  return rows
    .filter((r) => isChain(r.c))
    .map((r) => ({ addressId: r.a, chain: r.c as Chain, snapshotId: r.id, ts: r.ts, kind: r.kind }));
}

export interface PositionValueRow {
  snapshotId: number;
  addressId: number;
  chain: Chain;
  protocol: string;
  usd: number;
}

/** position_values rows of the given slices. */
export function sliceValues(db: QDb, slices: SliceRef[]): PositionValueRow[] {
  if (!slices.length) return [];
  const want = new Set(slices.map((s) => `${s.snapshotId}|${s.addressId}|${s.chain}`));
  const snapIds = [...new Set(slices.map((s) => s.snapshotId))];
  const addrIds = [...new Set(slices.map((s) => s.addressId))];
  const rows = all<{ snapshot_id: number; address_id: number; chain: string; protocol: string; usd: number | null }>(
    db,
    `SELECT snapshot_id, address_id, chain, protocol, usd FROM position_values
     WHERE snapshot_id IN (SELECT value FROM json_each(?)) AND address_id IN (SELECT value FROM json_each(?))`,
    jsonIds(snapIds),
    jsonIds(addrIds),
  );
  return rows
    .filter((r) => want.has(`${r.snapshot_id}|${r.address_id}|${r.chain}`))
    .map((r) => ({ snapshotId: r.snapshot_id, addressId: r.address_id, chain: r.chain as Chain, protocol: r.protocol, usd: r.usd ?? 0 }));
}

/** Net USD of a set of addresses at time `at`; null when no slice exists at or before `at`. */
export function valueAt(db: QDb, addressIds: number[], at: number): number | null {
  const slices = slicesAt(db, addressIds, at);
  if (!slices.length) return null;
  return sliceValues(db, slices).reduce((s, r) => s + r.usd, 0);
}

export function makeChange(nowUsd: number, thenUsd: number | null, fromTs: number): Change {
  if (thenUsd == null) return { abs: null, pct: null, fromUsd: null, fromTs };
  const abs = nowUsd - thenUsd;
  // a dust starting value (e.g. $0.0008 before a deposit) would give a meaningless percentage
  const pct = Math.abs(thenUsd) >= 1 ? abs / Math.abs(thenUsd) : null;
  return { abs, pct, fromUsd: thenUsd, fromTs };
}

export function changesFor(db: QDb, addressIds: number[], nowUsd: number, now: number): Changes {
  const out = {} as Changes;
  for (const [w, secs] of Object.entries(CHANGE_WINDOWS) as [ChangeWindow, number][]) {
    const at = now - secs;
    out[w] = makeChange(nowUsd, valueAt(db, addressIds, at), at);
  }
  return out;
}

export function change24h(db: QDb, addressIds: number[], nowUsd: number, now: number): Change {
  const at = now - CHANGE_WINDOWS['24h'];
  return makeChange(nowUsd, addressIds.length ? valueAt(db, addressIds, at) : null, at);
}

// ---------- tokens / balances / prices ----------

export interface TokenMeta {
  chain: Chain;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  kind: string | null;
  underlying: string | null;
  market: string | null;
  priceKey: string | null;
  logo: string | null;
  spam: boolean;
}

export type TokenMap = Map<string, TokenMeta>;

export function tokenKey(chain: string, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

export function loadTokens(db: QDb): TokenMap {
  const rows = all<{
    chain: string;
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    kind: string | null;
    underlying: string | null;
    market: string | null;
    price_key: string | null;
    logo: string | null;
    spam: number | null;
  }>(db, 'SELECT chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam FROM tokens');
  const m: TokenMap = new Map();
  for (const r of rows) {
    if (!isChain(r.chain)) continue;
    m.set(tokenKey(r.chain, r.address), {
      chain: r.chain,
      address: r.address.toLowerCase(),
      symbol: r.symbol,
      name: r.name,
      decimals: r.decimals,
      kind: r.kind,
      underlying: r.underlying ? r.underlying.toLowerCase() : null,
      market: r.market,
      priceKey: r.price_key,
      logo: r.logo,
      spam: !!r.spam,
    });
  }
  return m;
}

/** Token metadata with a synthetic native ETH entry when the tokens table has none. */
export function tokenMeta(tokens: TokenMap, chain: Chain, address: string): TokenMeta | undefined {
  const t = tokens.get(tokenKey(chain, address));
  if (t) return t;
  if (address.toLowerCase() === NATIVE_TOKEN) {
    return {
      chain,
      address: NATIVE_TOKEN,
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      kind: 'native',
      underlying: null,
      market: null,
      priceKey: ETH_KEY,
      logo: null,
      spam: false,
    };
  }
  return undefined;
}

/** Canonical asset key: the token's price key, else its underlying's, else chain:address. */
export function canonicalKey(tokens: TokenMap, chain: Chain, address: string): string {
  const t = tokenMeta(tokens, chain, address);
  if (t?.priceKey) return t.priceKey;
  if (t?.underlying) {
    const u = tokenMeta(tokens, chain, t.underlying);
    if (u?.priceKey) return u.priceKey;
    return `${chain}:${t.underlying}`;
  }
  return `${chain}:${address.toLowerCase()}`;
}

export interface BalanceRow {
  snapshotId: number;
  addressId: number;
  chain: Chain;
  token: string;
  amountRaw: string | null;
  amount: number;
  usd: number;
  protocol: string;
  side: 'wallet' | 'supply' | 'borrow';
}

export function sliceBalances(db: QDb, slices: SliceRef[]): BalanceRow[] {
  if (!slices.length) return [];
  const want = new Set(slices.map((s) => `${s.snapshotId}|${s.addressId}|${s.chain}`));
  const rows = all<{
    snapshot_id: number;
    address_id: number;
    chain: string;
    token: string;
    amount_raw: string | null;
    amount: number | null;
    usd: number | null;
    protocol: string | null;
    side: string | null;
  }>(
    db,
    `SELECT snapshot_id, address_id, chain, token, amount_raw, amount, usd, protocol, side FROM balances
     WHERE snapshot_id IN (SELECT value FROM json_each(?)) AND address_id IN (SELECT value FROM json_each(?))`,
    jsonIds([...new Set(slices.map((s) => s.snapshotId))]),
    jsonIds([...new Set(slices.map((s) => s.addressId))]),
  );
  return rows
    .filter((r) => want.has(`${r.snapshot_id}|${r.address_id}|${r.chain}`))
    .map((r) => {
      const side = r.side === 'supply' || r.side === 'borrow' ? r.side : 'wallet';
      let usd = r.usd ?? 0;
      // borrow rows are stored negative; guard against a writer that stored them positive
      if (side === 'borrow' && usd > 0) usd = -usd;
      return {
        snapshotId: r.snapshot_id,
        addressId: r.address_id,
        chain: r.chain as Chain,
        token: r.token.toLowerCase(),
        amountRaw: r.amount_raw,
        amount: Math.abs(r.amount ?? 0),
        usd,
        protocol: r.protocol ?? (side === 'wallet' ? 'wallet' : 'aave-v3'),
        side,
      };
    });
}

export interface AaveAccountRow {
  snapshotId: number;
  addressId: number;
  market: string;
  collateralUsd: number | null;
  debtUsd: number | null;
  healthFactor: number | null;
  /** risk fields (live snapshots since migration 3), null when not captured */
  emode: number | null;
  emodeLtvBps: number | null;
  emodeLtBps: number | null;
  emodeBitmap: string | null;
  userConfig: string | null;
}

/** True when aave_accounts has the migration 3 risk columns (older test schemas do not). */
function hasRiskColumns(db: QDb): boolean {
  return all<{ name: string }>(db, 'PRAGMA table_info(aave_accounts)').some((c) => c.name === 'user_config');
}

export function sliceAaveAccounts(db: QDb, slices: SliceRef[], marketChain: (m: string) => Chain): AaveAccountRow[] {
  if (!slices.length) return [];
  const want = new Set(slices.map((s) => `${s.snapshotId}|${s.addressId}|${s.chain}`));
  const rows = all<{
    snapshot_id: number;
    address_id: number;
    market: string;
    collateral_usd: number | null;
    debt_usd: number | null;
    health_factor: number | null;
    emode?: number | null;
    emode_ltv_bps?: number | null;
    emode_lt_bps?: number | null;
    emode_bitmap?: string | null;
    user_config?: string | null;
  }>(
    db,
    `SELECT snapshot_id, address_id, market, collateral_usd, debt_usd, health_factor${
      hasRiskColumns(db) ? ', emode, emode_ltv_bps, emode_lt_bps, emode_bitmap, user_config' : ''
    } FROM aave_accounts
     WHERE snapshot_id IN (SELECT value FROM json_each(?)) AND address_id IN (SELECT value FROM json_each(?))`,
    jsonIds([...new Set(slices.map((s) => s.snapshotId))]),
    jsonIds([...new Set(slices.map((s) => s.addressId))]),
  );
  return rows
    .filter((r) => want.has(`${r.snapshot_id}|${r.address_id}|${marketChain(r.market)}`))
    .map((r) => ({
      snapshotId: r.snapshot_id,
      addressId: r.address_id,
      market: r.market,
      collateralUsd: r.collateral_usd,
      debtUsd: r.debt_usd,
      healthFactor: r.health_factor,
      emode: r.emode ?? null,
      emodeLtvBps: r.emode_ltv_bps ?? null,
      emodeLtBps: r.emode_lt_bps ?? null,
      emodeBitmap: r.emode_bitmap ?? null,
      userConfig: r.user_config ?? null,
    }));
}

/** Latest known price per key (newest of live / daily). */
export function latestPrices(db: QDb, keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const rows = all<{ k: string; usd: number; ts: number }>(
    db,
    `SELECT price_key AS k, usd, MAX(ts) AS ts FROM prices
     WHERE price_key IN (SELECT value FROM json_each(?)) AND usd > 0 GROUP BY price_key`,
    jsonIds(keys),
  );
  for (const r of rows) out.set(r.k, r.usd);
  return out;
}

export function lastSnapshotAt(slices: SliceRef[]): number | null {
  let best: number | null = null;
  for (const s of slices) {
    const eff = s.kind === 'daily' ? s.ts + DAY : s.ts;
    if (best == null || eff > best) best = eff;
  }
  return best;
}
