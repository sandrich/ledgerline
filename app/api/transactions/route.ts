// GET /api/transactions?scope=all|wallet:<id>|address:<0x...>&kind=send,receive&chain=arbitrum
//   &hideInternal=1&includeSpam=1&includeApprovals=1&cursor=<opaque>&limit=50
// -> TransactionsResponse (lib/queries/api-types.ts), newest first.
// Spam, approvals and zero value contract calls are hidden unless includeSpam / includeApprovals is
// set or their kind is requested explicitly with kind=.
import { z } from 'zod';
import type { TxKind } from '../../../lib/queries/api-types';
import { parseScope, resolveScope } from '../../../lib/queries/scope';
import { getDb } from '../../../lib/queries/server-db';
import { getTransactions } from '../../../lib/queries/transactions';
import { chainSchema, error, handle, json, notFound, parseQuery } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: TxKind[] = ['receive', 'send', 'internal', 'swap', 'aave-supply', 'aave-withdraw', 'aave-borrow', 'aave-repay', 'curve-borrow', 'curve-repay', 'curve-deposit', 'curve-withdraw', 'approval', 'spam', 'other'];
const flag = z
  .enum(['1', '0', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true');

const querySchema = z.object({
  scope: z.string().optional(),
  kind: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const list = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = list.filter((k) => !KINDS.includes(k as TxKind));
      if (bad.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown kind ${bad.join(', ')}, expected ${KINDS.join(' | ')}` });
        return z.NEVER;
      }
      return list as TxKind[];
    }),
  chain: chainSchema.optional(),
  hideInternal: flag,
  includeSpam: flag,
  includeApprovals: flag,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = handle((req: Request) => {
  const q = parseQuery(req, querySchema);
  if (!q.ok) return q.res;
  const scope = parseScope(q.data.scope);
  if (!scope) return error(400, 'invalid scope, expected all | wallet:<id> | address:<0x...>');
  const db = getDb();
  const ids = resolveScope(db, scope);
  if (!ids) return notFound(scope.kind);
  return json(
    getTransactions(db, {
      addressIds: ids,
      kinds: q.data.kind,
      chain: q.data.chain,
      hideInternal: q.data.hideInternal,
      hideSpam: !q.data.includeSpam,
      includeApprovals: q.data.includeApprovals,
      cursor: q.data.cursor ?? null,
      limit: q.data.limit,
      // flows describe the whole scope: computed for the first page only
      withFlows: !q.data.cursor,
    }),
  );
});
