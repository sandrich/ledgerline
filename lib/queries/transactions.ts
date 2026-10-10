// Transactions list for a scope (GET /api/transactions). Classification depends on the scope (see
// lib/ledger/classify.ts): a Safe -> owner EOA transfer is internal in a scope containing both and a
// send in a scope with only the Safe. Newest first, cursor pagination; kind filters are applied after
// classification, so pages are filled from raw batches and the cursor points at the last raw
// transaction examined (never skips rows).
import type { Chain, TransactionsResponse, TxKind, TxRow } from './api-types';
import { all, get, jsonIds, type QDb } from './db';
import { getFlowSummary } from './flows';
import { buildRows, ledgerTablesExist, loadScope, scopeTxPage } from '../ledger/read';

export interface TransactionsQuery {
  addressIds: number[];
  kinds?: TxKind[];
  chain?: Chain;
  hideInternal?: boolean;
  /** default true */
  hideSpam?: boolean;
  cursor?: string | null;
  /** default 50, max 200 */
  limit?: number;
  /** include the scope's FlowSummary (default true) */
  withFlows?: boolean;
}

export function encodeCursor(t: { ts: number; hash: string; chain: string }): string {
  return Buffer.from(`${t.ts}:${t.hash}:${t.chain}`).toString('base64url');
}

export function decodeCursor(c: string | null | undefined): { ts: number; hash: string; chain: string } | null {
  if (!c) return null;
  try {
    const [ts, hash, chain] = Buffer.from(c, 'base64url').toString('utf8').split(':');
    const n = Number(ts);
    if (!Number.isFinite(n) || !/^0x[0-9a-f]{64}$/.test(hash ?? '') || !chain) return null;
    return { ts: n, hash, chain };
  } catch {
    return null;
  }
}

/** True while some (address, chain) of the scope has no ledger run yet or a ledger job is queued / running. */
export function ledgerSyncing(db: QDb, addressIds: number[]): boolean {
  if (!addressIds.length) return false;
  if (!ledgerTablesExist(db)) return true;
  const rows = all<{ id: number; chains: string | null }>(db, 'SELECT id, chains FROM addresses WHERE id IN (SELECT value FROM json_each(?))', jsonIds(addressIds));
  const done = new Set(
    all<{ k: string }>(
      db,
      "SELECT address_id || ':' || chain AS k FROM ledger_state WHERE last_block IS NOT NULL AND address_id IN (SELECT value FROM json_each(?))",
      jsonIds(addressIds),
    ).map((r) => r.k),
  );
  for (const r of rows) {
    let chains: string[] = ['ethereum', 'arbitrum'];
    try {
      const v: unknown = r.chains ? JSON.parse(r.chains) : null;
      if (Array.isArray(v) && v.length) chains = v.filter((c): c is string => typeof c === 'string');
    } catch {
      /* default */
    }
    for (const c of chains) if (!done.has(`${r.id}:${c}`)) return true;
  }
  const job = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE type = 'ledger' AND COALESCE(status, 'pending') IN ('pending', 'running')");
  return (job?.n ?? 0) > 0;
}

export function getTransactions(db: QDb, q: TransactionsQuery): TransactionsResponse {
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
  const hideSpam = q.hideSpam !== false;
  const flows = q.withFlows === false ? null : getFlowSummary(db, q.addressIds);
  const syncing = ledgerSyncing(db, q.addressIds);
  if (!q.addressIds.length || !ledgerTablesExist(db)) return { items: [], nextCursor: null, flows, syncing };

  const kinds = q.kinds?.length ? new Set(q.kinds) : null;
  const keep = (r: TxRow): boolean => {
    if (kinds) return kinds.has(r.kind) && !(r.kind === 'internal' && q.hideInternal);
    if (r.kind === 'spam' && hideSpam) return false;
    if (r.kind === 'internal' && q.hideInternal) return false;
    return true;
  };

  const s = loadScope(db, q.addressIds);
  const items: TxRow[] = [];
  let before = decodeCursor(q.cursor);
  let nextCursor: string | null = null;
  const batch = Math.min(500, limit * 4);
  for (let round = 0; round < 1000; round++) {
    const raw = scopeTxPage(db, q.addressIds, { chain: q.chain, before, limit: batch });
    if (!raw.length) break;
    const rows = buildRows(db, s, raw);
    let full = false;
    for (let i = 0; i < rows.length; i++) {
      if (keep(rows[i])) items.push(rows[i]);
      if (items.length >= limit) {
        // more may follow: either later rows of this batch or another batch
        const more = i < rows.length - 1 || raw.length === batch;
        nextCursor = more ? encodeCursor(raw[i]) : null;
        full = true;
        break;
      }
    }
    if (full || raw.length < batch) break;
    before = raw[raw.length - 1];
  }
  return { items, nextCursor, flows, syncing };
}
