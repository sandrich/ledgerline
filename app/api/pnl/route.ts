// GET /api/pnl?scope=all|wallet:<id>|address:<0x...> -> { scope, pnl: PnlSummary }
// The same holdings-based PnL as the overview, for one scope only (wallet / address list rows).
import { z } from 'zod';
import type { ScopePnlResponse } from '../../../lib/queries/api-types';
import { parseScope, resolveScope } from '../../../lib/queries/scope';
import { getScopePnl } from '../../../lib/queries/scope-pnl';
import { getDb } from '../../../lib/queries/server-db';
import { error, handle, json, notFound, parseQuery } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({ scope: z.string().optional() });

export const GET = handle((req: Request) => {
  const q = parseQuery(req, querySchema);
  if (!q.ok) return q.res;
  const scope = parseScope(q.data.scope);
  if (!scope) return error(400, 'invalid scope, expected all | wallet:<id> | address:<0x...>');
  const db = getDb();
  const ids = resolveScope(db, scope);
  if (!ids) return notFound(scope.kind);
  const body: ScopePnlResponse = { scope: q.data.scope ?? 'all', pnl: getScopePnl(db, ids) };
  return json(body);
});
