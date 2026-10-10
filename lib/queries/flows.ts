// External deposits / withdrawals of a scope from the transactions ledger.
// Sums TxRow.netUsd (value at the time) over the scope's transactions of kind receive / send:
// - only value exchanged with externally owned counterparties (exchanges, other people), netted per
//   transaction, and unpaired Arbitrum bridge legs count (lib/ledger/classify.ts)
// - value moving to / from a contract (protocol, router, DSProxy, Safe, bridge) is a protocol
//   interaction ('other') and never counts
// - transfers between addresses of the scope (including paired bridge transfers) are internal
// - transfers with a tracked address OUTSIDE the scope count (for a wallet scope, money arriving from
//   another own wallet is a deposit into this wallet; in the overview such transfers are internal)
// - Aave supply / withdraw / borrow / repay, swaps, approvals and spam count 0
// Returns null when the ledger has not been ingested yet for any address of the scope.
import type { FlowSummary } from './api-types';
import { get, jsonIds, type QDb } from './db';
import { NON_FLOW_KINDS, buildRows, ledgerTablesExist, loadScope, scopeTxPage } from '../ledger/read';

export function getFlowSummary(db: QDb, addressIds: number[]): FlowSummary | null {
  if (!addressIds.length || !ledgerTablesExist(db)) return null;
  const any = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM ledger_state WHERE last_block IS NOT NULL AND address_id IN (SELECT value FROM json_each(?))',
    jsonIds(addressIds),
  );
  if (!any?.n) return null;
  const s = loadScope(db, addressIds);
  const raw = scopeTxPage(db, addressIds, { limit: 1_000_000 });
  const rows = buildRows(db, s, raw);
  let deposits = 0;
  let withdrawals = 0;
  let since: number | null = null;
  for (const r of rows) {
    since = since == null ? r.ts : Math.min(since, r.ts);
    if (NON_FLOW_KINDS.has(r.kind) || r.netUsd == null) continue;
    if (r.netUsd > 0) deposits += r.netUsd;
    else withdrawals += -r.netUsd;
  }
  return { depositsUsd: deposits, withdrawalsUsd: withdrawals, netDepositsUsd: deposits - withdrawals, sinceTs: since };
}
