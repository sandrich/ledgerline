import { z } from 'zod';
import { parseScope } from '../../../lib/queries/scope';
import { getDb } from '../../../lib/queries/server-db';
import { getYield } from '../../../lib/queries/yield';
import { error, handle, json, notFound, parseQuery, rangeSchema } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  scope: z.string().optional(),
  range: rangeSchema.default('30d'),
});

/** GET /api/yield?scope=&range= : Aave interest earned / paid, gas and daily or weekly buckets. */
export const GET = handle((req: Request) => {
  const q = parseQuery(req, querySchema);
  if (!q.ok) return q.res;
  const scope = parseScope(q.data.scope);
  if (!scope) return error(400, 'invalid scope, expected all | wallet:<id> | address:<0x...>');
  const r = getYield(getDb(), scope, q.data.range);
  return r ? json(r) : notFound(scope.kind);
});
