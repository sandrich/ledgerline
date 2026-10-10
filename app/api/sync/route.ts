import { z } from 'zod';
import { enqueueSync } from '../../../lib/db/repos-api';
import type { SyncResponse } from '../../../lib/queries/api-types';
import { parseScope, resolveScope } from '../../../lib/queries/scope';
import { getDb } from '../../../lib/queries/server-db';
import { error, handle, json, notFound, parseBody } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ scope: z.string().optional() });

export const POST = handle(async (req: Request) => {
  const p = await parseBody(req, bodySchema);
  if (!p.ok) return p.res;
  const scope = parseScope(p.data.scope);
  if (!scope) return error(400, 'invalid scope, expected all | wallet:<id> | address:<0x...>');
  const db = getDb();
  let ids: number[] | null = null;
  if (scope.kind !== 'all') {
    ids = resolveScope(db, scope);
    if (!ids) return notFound(scope.kind);
  }
  const body: SyncResponse = { jobIds: enqueueSync(db, ids) };
  return json(body, 202);
});
