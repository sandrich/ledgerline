import { z } from 'zod';
import { getHistory } from '../../../lib/queries/history';
import { parseScope } from '../../../lib/queries/scope';
import { getDb } from '../../../lib/queries/server-db';
import { error, groupBySchema, handle, json, notFound, parseQuery, rangeSchema } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  scope: z.string().optional(),
  range: rangeSchema.default('30d'),
  groupBy: groupBySchema.default('none'),
});

export const GET = handle((req: Request) => {
  const q = parseQuery(req, querySchema);
  if (!q.ok) return q.res;
  const scope = parseScope(q.data.scope);
  if (!scope) return error(400, 'invalid scope, expected all | wallet:<id> | address:<0x...>');
  const h = getHistory(getDb(), scope, q.data.range, q.data.groupBy);
  return h ? json(h) : notFound(scope.kind);
});
